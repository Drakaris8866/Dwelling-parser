import type { ParsedSignals } from "../contracts/userFeedback.js";

export type { ParsedSignals };

export const FEEDBACK_SIGNALS = {
  BRICK: "brick",
  PANEL: "panel",
  QUIET: "quiet",
  NOISY: "noisy",
  CLOSE: "close",
  FAR: "far",
  REPAIR_DONE: "repair_done",
  REPAIR_NEEDED: "repair_needed",
  GOOD_LAYOUT: "good_layout",
  BAD_LAYOUT: "bad_layout"
} as const;

export const AMBIGUOUS_TOPICS = {
  NOISE: "noise",
  COMMUTE: "commute",
  HOUSE_MATERIAL: "house_material",
  REPAIR: "repair",
  LAYOUT: "layout",
  GENERAL: "general"
} as const;

const UNCERTAINTY_PATTERN = /(?:^|[\s,.;:()!?-])(?:непонятно|не\s+ясно|не\s+уверен|сомнева|сложно\s+сказать|50\/50|на\s+любителя|спорн|сомнительн|под\s+вопросом|возможн|врод|кажется|как\s+повезет|так\s+себе|средн)/iu;

const NEGATION_PREFIX_PATTERN = /(?:^|[\s,.;:()!?-])(?:не|нет|совсем\s+не|далеко\s+не|не\s+очень|без)$/iu;

const hasNegation = (prefix: string): boolean =>
  NEGATION_PREFIX_PATTERN.test(prefix.trim());

export const parseComment = (rawText: string | null | undefined): ParsedSignals => {
  if (!rawText || typeof rawText !== "string" || rawText.trim().length === 0) {
    return { positive: [], negative: [], ambiguous: [] };
  }

  const normalized = rawText.normalize("NFKC").trim();
  const positive = new Set<string>();
  const negative = new Set<string>();
  const ambiguous = new Set<string>();

  // Split into clauses by sentence terminators (retaining punctuation), line breaks, or coordinators/commas
  const clauses = normalized
    .split(/(?<=[.!?;]|\n)|,\s*(?:но|а|однако)\s*|,/iu)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  for (const clause of clauses) {
    const isQuestion = clause.includes("?");
    const isUncertain = UNCERTAINTY_PATTERN.test(clause);
    const clauseLower = clause.toLowerCase();

    // Helper to evaluate a signal with negation awareness
    const evaluate = (
      regex: RegExp,
      onPositive: () => void,
      onNegative: () => void,
      onNegatedPositive?: () => void,
      onNegatedNegative?: () => void,
      topic?: string
    ): void => {
      const match = regex.exec(clauseLower);
      if (!match) return;

      const prefix = clauseLower.slice(0, match.index).trim();
      const negated = hasNegation(prefix);

      if (isQuestion || isUncertain) {
        if (topic) ambiguous.add(topic);
        return;
      }

      if (negated) {
        if (onNegatedPositive) onNegatedPositive();
        else if (onNegatedNegative) onNegatedNegative();
      } else {
        onPositive();
        onNegative();
      }
    };

    // 1. House material: brick vs panel
    evaluate(
      /(?:^|[\s,.;:()!?-])(?:кирпич|из\s+кирпича)/iu,
      () => positive.add(FEEDBACK_SIGNALS.BRICK),
      () => {},
      () => {}, // negated brick -> do not add positive brick
      undefined,
      AMBIGUOUS_TOPICS.HOUSE_MATERIAL
    );

    evaluate(
      /(?:^|[\s,.;:()!?-])(?:панель|панельн|хрущевк|хрущ)/iu,
      () => {},
      () => negative.add(FEEDBACK_SIGNALS.PANEL),
      undefined,
      () => {}, // negated panel -> do not add negative panel
      AMBIGUOUS_TOPICS.HOUSE_MATERIAL
    );

    // 2. Noise & Location: quiet vs noisy
    evaluate(
      /(?:^|[\s,.;:()!?-])(?:тихо|тихий|тишина|зелен(?:ый|о|ая|ом|ых)|парк\s+рядом|спокойн(?:о|ый|ом))/iu,
      () => positive.add(FEEDBACK_SIGNALS.QUIET),
      () => {},
      () => negative.add(FEEDBACK_SIGNALS.NOISY), // "не тихо" -> noisy
      undefined,
      AMBIGUOUS_TOPICS.NOISE
    );

    evaluate(
      /(?:^|[\s,.;:()!?-])(?:шум(?:но|ный|ная|ное|ные|а)?|трасс|проспект|оживленн|загазованн|промзон)/iu,
      () => {},
      () => negative.add(FEEDBACK_SIGNALS.NOISY),
      undefined,
      () => positive.add(FEEDBACK_SIGNALS.QUIET), // "не шумно" -> quiet! negative.noise = false
      AMBIGUOUS_TOPICS.NOISE
    );

    // 3. Commute: close vs far
    if (/(?:^|[\s,.;:()!?-])недалеко/iu.test(clauseLower)) {
      if (isQuestion || isUncertain) {
        ambiguous.add(AMBIGUOUS_TOPICS.COMMUTE);
      } else {
        positive.add(FEEDBACK_SIGNALS.CLOSE);
      }
    } else {
      evaluate(
        /(?:^|[\s,.;:()!?-])(?:близко|метро\s+рядом|пешком\s+до\s+метро|удобно\s+добираться|хорошая\s+развязка)/iu,
        () => positive.add(FEEDBACK_SIGNALS.CLOSE),
        () => {},
        () => negative.add(FEEDBACK_SIGNALS.FAR), // "не близко" -> far
        undefined,
        AMBIGUOUS_TOPICS.COMMUTE
      );

      evaluate(
        /(?:^|[\s,.;:()!?-])(?:далеко|глушь|на\s+отшибе|неудобно\s+добираться|долго\s+ехать)/iu,
        () => {},
        () => negative.add(FEEDBACK_SIGNALS.FAR),
        undefined,
        () => positive.add(FEEDBACK_SIGNALS.CLOSE), // "не далеко" -> close!
        AMBIGUOUS_TOPICS.COMMUTE
      );
    }

    // 4. Repair: fresh repair vs repair needed
    if (/(?:^|[\s,.;:()!?-])(?:не\s+требует\s+ремонта|ремонт\s+не\s+нужен|без\s+ремонта\s+не)/iu.test(clauseLower)) {
      if (isQuestion || isUncertain) {
        ambiguous.add(AMBIGUOUS_TOPICS.REPAIR);
      } else {
        positive.add(FEEDBACK_SIGNALS.REPAIR_DONE);
      }
    } else if (/(?:^|[\s,.;:()!?-])(?:ремонт\s+не\s+сделан|не\s+сделан\s+ремонт)/iu.test(clauseLower)) {
      if (isQuestion || isUncertain) {
        ambiguous.add(AMBIGUOUS_TOPICS.REPAIR);
      } else {
        negative.add(FEEDBACK_SIGNALS.REPAIR_NEEDED);
      }
    } else {
      evaluate(
        /(?:^|[\s,.;:()!?-])(?:свежий\s+ремонт|хороший\s+ремонт|евроремонт|отличный\s+ремонт|с\s+ремонтом|ремонт\s+сделан)/iu,
        () => positive.add(FEEDBACK_SIGNALS.REPAIR_DONE),
        () => {},
        () => negative.add(FEEDBACK_SIGNALS.REPAIR_NEEDED),
        undefined,
        AMBIGUOUS_TOPICS.REPAIR
      );

      evaluate(
        /(?:^|[\s,.;:()!?-])(?:ремонт\s+нужен|нужен\s+ремонт|требует\s+ремонта|под\s+ремонт|без\s+ремонта|убитая|старый\s+ремонт|бабушкин\s+ремонт)/iu,
        () => {},
        () => negative.add(FEEDBACK_SIGNALS.REPAIR_NEEDED),
        undefined,
        () => positive.add(FEEDBACK_SIGNALS.REPAIR_DONE),
        AMBIGUOUS_TOPICS.REPAIR
      );
    }

    // 5. Layout: good layout vs bad layout
    evaluate(
      /(?:^|[\s,.;:()!?-])(?:хорошая\s+планировка|раздельные\s+комнаты|изолированные\s+комнаты|большая\s+кухня|просторная)/iu,
      () => positive.add(FEEDBACK_SIGNALS.GOOD_LAYOUT),
      () => {},
      () => negative.add(FEEDBACK_SIGNALS.BAD_LAYOUT),
      undefined,
      AMBIGUOUS_TOPICS.LAYOUT
    );

    evaluate(
      /(?:^|[\s,.;:()!?-])(?:плохая\s+планировка|смежные\s+комнаты|проходные\s+комнаты|маленькая\s+кухня|тесная)/iu,
      () => {},
      () => negative.add(FEEDBACK_SIGNALS.BAD_LAYOUT),
      undefined,
      () => positive.add(FEEDBACK_SIGNALS.GOOD_LAYOUT),
      AMBIGUOUS_TOPICS.LAYOUT
    );

    // If uncertain clause had no specific topic, note general ambiguity
    if ((isQuestion || isUncertain) && positive.size === 0 && negative.size === 0 && ambiguous.size === 0) {
      ambiguous.add(AMBIGUOUS_TOPICS.GENERAL);
    }
  }

  // Resolve conflicts: if a dimension has both positive and negative, move to ambiguous
  if (positive.has(FEEDBACK_SIGNALS.QUIET) && negative.has(FEEDBACK_SIGNALS.NOISY)) {
    positive.delete(FEEDBACK_SIGNALS.QUIET);
    negative.delete(FEEDBACK_SIGNALS.NOISY);
    ambiguous.add(AMBIGUOUS_TOPICS.NOISE);
  }

  if (positive.has(FEEDBACK_SIGNALS.CLOSE) && negative.has(FEEDBACK_SIGNALS.FAR)) {
    positive.delete(FEEDBACK_SIGNALS.CLOSE);
    negative.delete(FEEDBACK_SIGNALS.FAR);
    ambiguous.add(AMBIGUOUS_TOPICS.COMMUTE);
  }

  if (positive.has(FEEDBACK_SIGNALS.BRICK) && negative.has(FEEDBACK_SIGNALS.PANEL)) {
    positive.delete(FEEDBACK_SIGNALS.BRICK);
    negative.delete(FEEDBACK_SIGNALS.PANEL);
    ambiguous.add(AMBIGUOUS_TOPICS.HOUSE_MATERIAL);
  }

  if (positive.has(FEEDBACK_SIGNALS.REPAIR_DONE) && negative.has(FEEDBACK_SIGNALS.REPAIR_NEEDED)) {
    positive.delete(FEEDBACK_SIGNALS.REPAIR_DONE);
    negative.delete(FEEDBACK_SIGNALS.REPAIR_NEEDED);
    ambiguous.add(AMBIGUOUS_TOPICS.REPAIR);
  }

  if (positive.has(FEEDBACK_SIGNALS.GOOD_LAYOUT) && negative.has(FEEDBACK_SIGNALS.BAD_LAYOUT)) {
    positive.delete(FEEDBACK_SIGNALS.GOOD_LAYOUT);
    negative.delete(FEEDBACK_SIGNALS.BAD_LAYOUT);
    ambiguous.add(AMBIGUOUS_TOPICS.LAYOUT);
  }

  return {
    positive: Array.from(positive),
    negative: Array.from(negative),
    ambiguous: Array.from(ambiguous)
  };
};
