import { describesShareSale } from "./listingIntent.js";

export type ParsedTextSignals = {
  readonly hasWalkThroughLayout: boolean;
  readonly hasStudioLayout: boolean;
  readonly hasPrivateHouse: boolean;
  readonly hasPartialOwnership: boolean;
  readonly hasRentalIntent: boolean;
  readonly isMinskWorld: boolean;
  readonly isAllowedLocality: boolean;
  readonly isBrickHouse: boolean;
  readonly isOldPanel: boolean;
  readonly hasFreshRepair: boolean;
  readonly needsRepair: boolean;
};

const WALK_THROUGH_PATTERNS: readonly RegExp[] = [
  /\bwalk-through\b/i,
  /\u043f\u0440\u043e\u0445\u043e\u0434\u043d/i,
  /\u0441\u043c\u0435\u0436\u043d/i
];
const STUDIO_PATTERNS: readonly RegExp[] = [
  /\b(?:studio|smart\s*studio)\b/i,
  /(?:^|[\s,.;:()/-])\u0441\u0442\u0443\u0434\u0438(?:\u044f|\u0438|\u044e|\u0435|\u0438-)(?:$|[\s,.;:()/-])/i
];
const PRIVATE_HOUSE_PATTERNS: readonly RegExp[] = [
  /\u0447\u0430\u0441\u0442\u043d(?:\u044b\u0439|\u043e\u043c|\u043e\u0433\u043e|\u044b\u0435)\s+\u0434\u043e\u043c/i,
  /\u0436\u0438\u043b(?:\u043e\u0439|\u043e\u0433\u043e)\s+\u0434\u043e\u043c/i,
  /\u0441\u0430\u0434\u043e\u0432(?:\u044b\u0439|\u043e\u0433\u043e|\u043e\u043c)\s+\u0434\u043e\u043c/i,
  /\u0434\u0430\u0447(?:\u0430|\u043d\u044b\u0439|\u043d\u043e\u0433\u043e|\u043d\u043e\u043c)/i,
  /\u0434\u043e\u043c\s+\u0441\s+\u0443\u0447\u0430\u0441\u0442\u043a/i,
  /\u043a\u043e\u0442\u0442\u0435\u0434\u0436/i,
  /\u0442\u0430\u0443\u043d\s*\u0445\u0430\u0443\u0441|\u0442\u0430\u0443\u043d\u0445\u0430\u0443\u0441/i,
  /\u0434\u0443\u043f\u043b\u0435\u043a\u0441/i,
  /\u0443\u0447\u0430\u0441\u0442\u043e\u043a/i,
  /\b\d+(?:[.,]\d+)?\s*\u0441\u043e\u0442(?:\.|\u043e\u043a|\u043a\u0438)?\b/i,
  /\u0441\u0430\u0434\u043e\u0432(?:\u043e\u0435|\u043e\u043c|\u043e\u0433\u043e|\u044b\u0445)?\s+\u0442\u043e\u0432\u0430\u0440\u0438\u0449\u0435\u0441\u0442\u0432/i,
  /(?:^|[\s,;])\u0441\.?\s*\u0442\.?\s+(?!\u043c(?:\.|\s|$|\u0435\u0442\u0440\u043e))[\u0430-\u044f\u04510-9]/i,
  /\u0441\u0435\u043b\u044c\u0441\u043a(?:\u0438\u0439|\u043e\u0433\u043e|\u043e\u043c)\s+\u0441\u043e\u0432\u0435\u0442/i,
  /\u0441\u0435\u043b\u044c\u0441\u043e\u0432\u0435\u0442/i,
  /(?:^|[\s,;])\u0441\/\u0441(?:$|[\s,;])/i,
  /\u0434\u0435\u0440\u0435\u0432\u043d(?:\u044f|\u0435|\u0438|\u044e)/i,
  /(?:^|[\s,;])\u0434\.\s*[\u0430-\u044f\u0451]/i,
  /\u0430\u0433\u0440\u043e\u0433\u043e\u0440\u043e\u0434\u043e\u043a/i,
  /\u043f\u043e\u0441(?:\u0451|\u0435)\u043b\u043e\u043a/i
];
const PARTIAL_OWNERSHIP_PATTERNS: readonly RegExp[] = [
  /\u043a\u043e\u043c\u043d\u0430\u0442(?:\u044b|\u0443)\s+\u0432\s+\d+\s*(?:\u0445|x)?\s*\u043a\u043e\u043c\u043d/iu,
  /(?:^|[^\p{L}])\d+\s*\u043a\u043e\u043c\u043d\u0430\u0442(?:\u044b|\u0443)\s+\u0432\s+\d/iu,
  /\u043f\u043e\u043b\u043e\u0432\u0438\u043d(?:\u0430|\u0443|\u044b)\s+\u0434\u043e\u043c/iu,
  /\u0447\u0430\u0441\u0442(?:\u044c|\u0438)\s+\u0434\u043e\u043c/iu,
  /\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u043d(?:\u044b\u0439|\u0430\u044f|\u043e\u043c)\s+(?:\u0436\u0438\u043b(?:\u043e\u0439|\u043e\u043c)\s+)?\u0434\u043e\u043c/iu,
  /\u043e\u0442\u0434\u0435\u043b\u044c\u043d(?:\u044b\u0439|\u044b\u043c)\s+\u0432\u0445\u043e\u0434/iu,
  /(?:^|[^\p{L}])сособственник\p{L}*/iu,
  /(?:^|[^\p{L}])поряд(?:ок|ка|ком|ку)\s+пользования(?!\s+земельн\p{L}*)/iu,
  /(?:^|[^\p{L}])выделенн\p{L}*\s+комнат[ауые](?!\s*-кладов)/iu,
  /(?:^|[^\p{L}])(?:прода(?:ется|ются|м|ю|ем|жа|жи)|покупк\p{L}*|купить)\s+(?:(?:одн\p{L}*|дв\p{L}*|тр\p{L}*|четыр\p{L}*|пят\p{L}*|\d+)\s+)?(?:(?:раздельн\p{L}*|изолированн\p{L}*|смежн\p{L}*|жил\p{L}*|уютн\p{L}*|светл\p{L}*|отдельн\p{L}*|просторн\p{L}*|больш\p{L}*|выделенн\p{L}*)\s+)*комнат(?:а|у|ы|е|ам)?(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])(?:(?:\d+|одн\p{L}*|дв\p{L}*|тр\p{L}*|четыр\p{L}*)\s+)?(?:раздельн\p{L}*|изолированн\p{L}*|выделенн\p{L}*|жил\p{L}*|смежн\p{L}*)?\s*комнат(?:а|у|ы|е)\s+(?:[^.!?;\r\n]{0,80}?\s+)?в\s+(?:(?:\d+|[а-яё]+)[-\s]*комнатн\p{L}*\s+квартир\p{L}*|коммунал\p{L}*|общежити\p{L}*)/iu,
  /(?:^|[^\p{L}])покупк\p{L}*\s+(?:(?:\d+|одн\p{L}*|дв\p{L}*|тр\p{L}*|четыр\p{L}*)\s+)?комнат\p{L}*\s+(?:[^.!?;\r\n]{0,80}?\s+)?в\s+квартир\p{L}*/iu,
  /^(?:прода(?:ется|ются|м|ю|ем|жа)\s+)?комнат[аы](?=$|[^\p{L}])/iu
];
const RENTAL_PATTERNS: readonly RegExp[] = [
  /\u0441\u0434\u0430(?:\u0451|\u0435)\u0442\u0441\u044f/i,
  /\u0441\u0434\u0430\u043c/i,
  /\u0430\u0440\u0435\u043d\u0434/i,
  /\u043d\u0430\s+\u0434\u043b\u0438\u0442\u0435\u043b\u044c\u043d(?:\u044b\u0439|\u044b\u0435|\u043e\u0435)\s+\u0441\u0440\u043e\u043a/i,
  /\u043f\u043e\u0441\u0443\u0442\u043e\u0447\u043d/i
];
const MINSK_WORLD_PATTERNS: readonly RegExp[] = [
  /\u043c\u0438\u043d\u0441\u043a[\s-]*\u043c\u0438\u0440/i,
  /\bminsk[\s-]*world\b/i,
  /\u0430\u044d\u0440\u043e\u0434\u0440\u043e\u043c\u043d/i,
  /\u0431\u0435\u043b\u0433\u0440\u0430\u0434\u0441\u043a/i,
  /\u0431\u0440\u0438\u043b\u0435\u0432\u0441\u043a/i,
  /\u0430\u0432\u0438\u0430\u0446\u0438\u043e\u043d\u043d/i,
  /\u0438\u0433\u043e\u0440\u044f\s+\u043b\u0443\u0447\u0435\u043d\u043a/i,
  /\u043b\u0435\u043e\u043d\u0438\u0434\u0430\s+\u0449\u0435\u043c\u0435\u043b[\u0435\u0451]?\u0432/i,
  /\u043d\u0438\u043a\u043e\u043b\u044b\s+\u0442\u0435\u0441\u043b\u044b/i,
  /\u0431\u0440\u0430\u0442\u044c\u0435\u0432\s+\u0440\u0430\u0439\u0442/i,
  /\u043c\u0438\u0445\u0430\u0438\u043b\u0430\s+\u0441\u0430\u0432\u0438\u0446\u043a\u043e\u0433\u043e/i
];
const ALLOWED_LOCALITY_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s:,;])(?:\u0433\.?\s*)?\u043c\u0438\u043d\u0441\u043a(?:$|[\s,.;])/i,
  /\u0433\u043e\u0440\u043e\u0434\s+\u043c\u0438\u043d\u0441\u043a/i,
  /\u0431\u043e\u0440\u043e\u0432\u043b\u044f\u043d/i,
  /\u043a\u043e\u043f\u0438\u0449/i
];
const BRICK_PATTERNS: readonly RegExp[] = [
  /\u043a\u0438\u0440\u043f\u0438\u0447/i,
  /\u043a\u0438\u0440\u043f\./i
];
const OLD_PANEL_PATTERNS: readonly RegExp[] = [
  /1-464/i,
  /\u043f\u0430\u043d\u0435\u043b\u044c.*196\d/i,
  /196\d.*\u043f\u0430\u043d\u0435\u043b\u044c/i
];
const FRESH_REPAIR_PATTERNS: readonly RegExp[] = [
  /\u0435\u0432\u0440\u043e\s*\u0440\u0435\u043c\u043e\u043d\u0442/i,
  /\u0435\u0432\u0440\u043e\u0440\u0435\u043c\u043e\u043d\u0442/i,
  /\u0441\u0432\u0435\u0436(?:\u0438\u0439|\u0430\u044f)\s+\u0440\u0435\u043c\u043e\u043d\u0442/i,
  /\u043e\u0442\u043b\u0438\u0447\u043d(?:\u044b\u0439|\u043e\u0435)\s+\u0441\u043e\u0441\u0442\u043e\u044f/i
];
const NEEDS_REPAIR_PATTERNS: readonly RegExp[] = [
  /\u0431\u0435\u0437\s+\u0440\u0435\u043c\u043e\u043d\u0442\u0430/i,
  /\u0431\u0435\u0437\s+\u043e\u0442\u0434\u0435\u043b\u043a\u0438/i,
  /\u0447\u0435\u0440\u043d\u043e\u0432(?:\u0430\u044f|\u043e\u0439)\s+\u043e\u0442\u0434\u0435\u043b\u043a/i,
  /\u0441\u0442\u0440\u043e\u0438\u0442\u0435\u043b\u044c\u043d(?:\u0430\u044f|\u043e\u0439)\s+\u043e\u0442\u0434\u0435\u043b\u043a/i,
  /\u0442\u0440\u0435\u0431\u0443\u0435\u0442\s+\u0440\u0435\u043c\u043e\u043d\u0442\u0430/i,
  /\u043f\u043e\u0434\s+\u0440\u0435\u043c\u043e\u043d\u0442/i,
  /\u043d\u0443\u0436\u0435\u043d\s+\u0440\u0435\u043c\u043e\u043d\u0442/i
];

const matchesAny = (value: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(value));

export const normalizeText = (parts: readonly (string | undefined)[]): string =>
  parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU");

export const parseTextSignals = (parts: readonly (string | undefined)[]): ParsedTextSignals => {
  const text = normalizeText(parts);
  const ownershipText = text.replace(/(?:не\s+доля|не\s+прода(?:ем|ю|ется|ются)\s+(?:дол|комнат)\p{L}*|дол\p{L}*\s+не\s+прода\p{L}*)/giu, " ");

  return {
    hasWalkThroughLayout: matchesAny(text, WALK_THROUGH_PATTERNS),
    hasStudioLayout: matchesAny(text, STUDIO_PATTERNS),
    hasPrivateHouse: matchesAny(text, PRIVATE_HOUSE_PATTERNS),
    hasPartialOwnership: parts.some((part) => part !== undefined && describesShareSale(part))
      || matchesAny(ownershipText, PARTIAL_OWNERSHIP_PATTERNS),
    hasRentalIntent: matchesAny(text, RENTAL_PATTERNS),
    isMinskWorld: matchesAny(text, MINSK_WORLD_PATTERNS),
    isAllowedLocality: matchesAny(text, ALLOWED_LOCALITY_PATTERNS),
    isBrickHouse: matchesAny(text, BRICK_PATTERNS),
    isOldPanel: matchesAny(text, OLD_PANEL_PATTERNS),
    hasFreshRepair: matchesAny(text, FRESH_REPAIR_PATTERNS),
    needsRepair: matchesAny(text, NEEDS_REPAIR_PATTERNS)
  };
};
