import type { WalkingRoute } from "./geo.js";
import type { PersistedListing } from "./listing.js";
import type { MedianMarketSource } from "./market.js";
import { parseTextSignals } from "../utils/textParser.js";

export type ScoreInput = {
  readonly listing: PersistedListing;
  readonly medianPricePerSqm: number;
  readonly medianSource?: MedianMarketSource | undefined;
  readonly medianComparableCount?: number | undefined;
  readonly walkingRoute?: WalkingRoute | undefined;
};

export type ScoreAlertKind = "hot" | "watch" | "none";

export type ScoreComponentCode = "market" | "transport" | "object" | "confidence";

export type ScoreComponent = {
  readonly code: ScoreComponentCode;
  readonly label: string;
  readonly points: number;
  readonly maxPoints: number;
  readonly notes: readonly string[];
};

export type ScoreResult = {
  readonly fairPricePerSqm: number;
  readonly actualPricePerSqm: number;
  readonly medianPricePerSqm: number;
  readonly medianSource: MedianMarketSource;
  readonly medianComparableCount?: number | undefined;
  readonly discountPct: number;
  readonly ratingScore: number;
  readonly shouldAlert: boolean;
  readonly alertKind: ScoreAlertKind;
  readonly components: readonly ScoreComponent[];
  readonly multipliers: readonly AppliedMultiplier[];
};

type ScorePolicyInput = {
  readonly ratingScore: number;
  readonly discountPct: number;
  readonly marketPoints: number;
  readonly transportPoints: number;
  readonly objectPoints: number;
  readonly isBelowMedian: boolean;
  readonly isTransitAcceptable: boolean;
};

export type AppliedMultiplier = {
  readonly code:
    | "metro-near"
    | "metro-far"
    | "walk-through"
    | "brick"
    | "old-panel"
    | "fresh-repair"
    | "needs-repair"
    | "first-floor"
    | "last-floor"
    | "no-balcony"
    | "separate-bathroom"
    | "high-ceiling"
    | "small-kitchen"
    | "spacious-kitchen"
    | "target-transit-near"
    | "target-transit-far";
  readonly factor: number;
};

type TextSignalSet = ReturnType<typeof parseTextSignals>;

const roundMoney = (value: number): number => Math.round(value * 100) / 100;
const roundPct = (value: number): number => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const HOT_RATING_SCORE = 80;
const WATCH_RATING_SCORE = 65;
const HOT_DISCOUNT_PCT = 12;
const WATCH_DISCOUNT_PCT = 8;
const WATCH_MAX_TRANSIT_MINUTES = 45;

const DETAIL_LABEL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Floor: ["Floor", "Этаж"],
  Floors: ["Floors", "Этажей"],
  Balcony: ["Balcony", "Балкон"],
  Bathroom: ["Bathroom", "Санузел"],
  Ceiling: ["Ceiling", "Потолки"],
  "Kitchen area": ["Kitchen area", "Kitchen", "Кухня"],
  Kitchen: ["Kitchen", "Kitchen area", "Кухня"]
};

export class ScoringService {
  score(input: ScoreInput): ScoreResult {
    const medianSource = input.medianSource ?? "global";
    const discountPct = roundPct(((input.medianPricePerSqm - input.listing.pricePerSqm) / input.medianPricePerSqm) * 100);
    const textSignals = this.textSignals(input.listing);
    const components = [
      this.marketComponent(input, discountPct),
      this.transportComponent(input),
      this.objectComponent(input.listing, textSignals),
      this.confidenceComponent(input, textSignals, medianSource)
    ];
    const ratingScore = Math.round(components.reduce((sum, component) => sum + component.points, 0));
    const alertKind = this.alertKind(input, components, discountPct, ratingScore);

    return {
      fairPricePerSqm: roundMoney(input.medianPricePerSqm),
      actualPricePerSqm: input.listing.pricePerSqm,
      medianPricePerSqm: input.medianPricePerSqm,
      medianSource,
      medianComparableCount: input.medianComparableCount,
      discountPct,
      ratingScore,
      shouldAlert: alertKind !== "none",
      alertKind,
      components,
      multipliers: this.buildMultipliers(input, textSignals)
    };
  }

  private alertKind(
    input: ScoreInput,
    components: readonly ScoreComponent[],
    discountPct: number,
    ratingScore: number
  ): ScoreAlertKind {
    const policy = this.scorePolicyInput(input, components, discountPct, ratingScore);

    if (policy.objectPoints <= 2) {
      return "none";
    }

    if (policy.transportPoints <= 5 && policy.objectPoints <= 8) {
      return "none";
    }

    if (
      policy.objectPoints >= 10 &&
      policy.transportPoints >= 10 &&
      (ratingScore >= HOT_RATING_SCORE || (discountPct >= HOT_DISCOUNT_PCT && ratingScore >= 60))
    ) {
      return "hot";
    }

    if (
      (policy.objectPoints >= 7 && policy.transportPoints >= 8 && ratingScore >= WATCH_RATING_SCORE) ||
      (policy.objectPoints >= 7 && policy.transportPoints >= 8 && discountPct >= WATCH_DISCOUNT_PCT && ratingScore >= 55) ||
      (policy.objectPoints >= 10 && policy.transportPoints >= 6 && discountPct >= HOT_DISCOUNT_PCT && ratingScore >= 50) ||
      (policy.objectPoints >= 15 && policy.transportPoints >= 6 && discountPct >= WATCH_DISCOUNT_PCT && ratingScore >= 55) ||
      (policy.objectPoints >= 7 && policy.isBelowMedian && policy.isTransitAcceptable && ratingScore >= 50)
    ) {
      return "watch";
    }

    return "none";
  }

  private scorePolicyInput(
    input: ScoreInput,
    components: readonly ScoreComponent[],
    discountPct: number,
    ratingScore: number
  ): ScorePolicyInput {
    const componentPoints = (code: ScoreComponentCode): number => components.find((component) => component.code === code)?.points ?? 0;
    const transitMinutes = input.listing.timeToTargetTransit;

    return {
      ratingScore,
      discountPct,
      marketPoints: componentPoints("market"),
      transportPoints: componentPoints("transport"),
      objectPoints: componentPoints("object"),
      isBelowMedian: input.listing.pricePerSqm <= input.medianPricePerSqm,
      isTransitAcceptable: transitMinutes !== undefined && transitMinutes <= WATCH_MAX_TRANSIT_MINUTES
    };
  }

  private marketComponent(input: ScoreInput, discountPct: number): ScoreComponent {
    const gapPerSqm = input.medianPricePerSqm - input.listing.pricePerSqm;
    const absoluteGapBonus = gapPerSqm >= 250 ? 5 : gapPerSqm >= 150 ? 3 : gapPerSqm >= 75 ? 1 : 0;
    const rawPoints = discountPct < 0 ? Math.max(0, 8 + discountPct) : 10 + discountPct * 2 + absoluteGapBonus;
    const points = Math.round(clamp(rawPoints, 0, 45));
    const notes = [
      `${discountPct}% vs median`,
      ...(gapPerSqm > 0 ? [`$${Math.round(gapPerSqm)}/m2 below median`] : [`$${Math.abs(Math.round(gapPerSqm))}/m2 above median`])
    ];

    return {
      code: "market",
      label: "Market",
      points,
      maxPoints: 45,
      notes
    };
  }

  private transportComponent(input: ScoreInput): ScoreComponent {
    let points = 5;
    const notes: string[] = [];

    if (input.listing.timeToTargetTransit !== undefined) {
      const minutes = input.listing.timeToTargetTransit;
      notes.push(`${minutes} min to target`);
      if (minutes <= 20) {
        points += 10;
      } else if (minutes <= 35) {
        points += 6;
      } else if (minutes <= 45) {
        points += 3;
      } else if (minutes <= 60) {
        points += 1;
      } else {
        points -= 3;
      }
    } else {
      notes.push("target route unknown");
      points -= 2;
    }

    const routeStats = this.routeStats(input.listing.targetTransitSummary);
    if (routeStats !== undefined) {
      if (routeStats.hasTransit) {
        points += 1;
      }

      if (routeStats.hasSubway) {
        points += 2;
        notes.push("subway leg");
      }

      if (routeStats.transfers > 0) {
        points -= Math.min(6, routeStats.transfers * 3);
        notes.push(`${routeStats.transfers} transfer${routeStats.transfers === 1 ? "" : "s"}`);
      }

      if (routeStats.hasTransit && !routeStats.hasSubway) {
        points -= 3;
        notes.push("surface-only route");
      }

      if (routeStats.walkMinutes <= 12) {
        points += 2;
      } else if (routeStats.walkMinutes <= 20) {
        points += 1;
      } else if (routeStats.walkMinutes > 30) {
        points -= 3;
      }

      notes.push(`${routeStats.walkMinutes} min walking in route`);
    }

    if (input.walkingRoute !== undefined) {
      const metroMinutes = input.walkingRoute.walkingMinutes;
      if (metroMinutes <= 10) {
        points += 3;
      } else if (metroMinutes <= 15) {
        points += 1;
      } else if (metroMinutes > 25) {
        points -= 3;
      }

      notes.push(`${metroMinutes} min walk to metro`);
    } else if (input.listing.metroName === undefined) {
      points -= 2;
      notes.push("metro access unknown");
    }

    return {
      code: "transport",
      label: "Transport",
      points: Math.round(clamp(points, 0, 25)),
      maxPoints: 25,
      notes
    };
  }

  private objectComponent(listing: PersistedListing, textSignals: TextSignalSet): ScoreComponent {
    let points = 14;
    const notes: string[] = [];
    const risk = this.objectRisk(listing, textSignals);

    if (textSignals.isBrickHouse) {
      points += 2;
      notes.push("brick");
    }

    if (textSignals.isOldPanel) {
      points -= 4;
      notes.push("old panel");
    }

    if (textSignals.hasFreshRepair) {
      points += 2;
      notes.push("fresh repair");
    }

    if (textSignals.needsRepair) {
      points -= 5;
      notes.push("repair risk");
    }

    if (textSignals.hasWalkThroughLayout) {
      points -= 3;
      notes.push("walk-through rooms");
    }

    const floor = risk.floor;
    const floors = risk.floors;
    if (floor === 1) {
      points -= 2;
      notes.push("first floor");
    } else if (floor !== undefined && floors !== undefined && floor === floors) {
      points -= floors <= 5 ? 4 : 2;
      notes.push("last floor");
    }

    const balcony = this.textDetail(listing, "Balcony");
    if (balcony !== undefined && /\u043d\u0435\u0442/i.test(balcony)) {
      points -= 1;
      notes.push("no balcony");
    }

    const bathroom = this.textDetail(listing, "Bathroom");
    if (bathroom !== undefined && /\u0440\u0430\u0437\u0434\u0435\u043b\u044c\u043d/i.test(bathroom)) {
      points += 1;
      notes.push("separate bathroom");
    }

    const ceiling = this.numberDetail(listing, "Ceiling");
    if (ceiling !== undefined && ceiling >= 2.7) {
      points += ceiling >= 3 ? 2 : 1;
      notes.push(`${ceiling}m ceiling`);
    }

    const kitchen = this.numberDetail(listing, "Kitchen area") ?? this.numberDetail(listing, "Kitchen");
    if (kitchen !== undefined && kitchen < 6) {
      points -= 3;
      notes.push("tiny kitchen");
    } else if (kitchen !== undefined && kitchen < 7) {
      points -= 2;
      notes.push("small kitchen");
    } else if (kitchen !== undefined && kitchen >= 9) {
      points += 1;
      notes.push("spacious kitchen");
    }

    if (risk.isSevereRenovationRisk) {
      points -= 4;
      notes.push("severe renovation risk");
    }

    return {
      code: "object",
      label: "Object",
      points: Math.round(clamp(points, 0, 20)),
      maxPoints: 20,
      notes
    };
  }

  private objectRisk(
    listing: PersistedListing,
    textSignals: TextSignalSet
  ): {
    readonly floor?: number | undefined;
    readonly floors?: number | undefined;
    readonly isSevereRenovationRisk: boolean;
  } {
    const floor = this.numberDetail(listing, "Floor");
    const floors = this.numberDetail(listing, "Floors");
    const kitchen = this.numberDetail(listing, "Kitchen area") ?? this.numberDetail(listing, "Kitchen");
    const isLowRiseLastFloor = floor !== undefined && floors !== undefined && floor === floors && floors <= 5;
    const hasTinyKitchen = kitchen !== undefined && kitchen < 6;
    const isSevereRenovationRisk = textSignals.needsRepair && (textSignals.isOldPanel || isLowRiseLastFloor || hasTinyKitchen);
    const riskCount = [textSignals.needsRepair, textSignals.isOldPanel, isLowRiseLastFloor, hasTinyKitchen].filter(Boolean).length;

    return {
      floor,
      floors,
      isSevereRenovationRisk
    };
  }

  private confidenceComponent(
    input: ScoreInput,
    textSignals: TextSignalSet,
    medianSource: ScoreResult["medianSource"]
  ): ScoreComponent {
    let points = 8;
    const notes: string[] = [];

    if (medianSource.startsWith("local-")) {
      points += 1;
      notes.push("local median");
    } else {
      points -= 1;
      notes.push("global median fallback");
    }

    const comparableCount = input.medianComparableCount ?? 0;
    if (comparableCount >= 10) {
      points += 1;
    } else if (comparableCount > 0 && comparableCount < 5) {
      points -= 1;
      notes.push(`low comparable count: ${comparableCount}`);
    }

    if (input.listing.latitude === undefined || input.listing.longitude === undefined) {
      points -= 2;
      notes.push("coordinates missing");
    }

    if (input.listing.timeToTargetTransit === undefined) {
      points -= 1;
      notes.push("OTP missing");
    }

    if (textSignals.hasPartialOwnership || textSignals.hasPrivateHouse || textSignals.hasRentalIntent) {
      points = 0;
      notes.push("hard-filter risk signal");
    }

    return {
      code: "confidence",
      label: "Confidence",
      points: Math.round(clamp(points, 0, 10)),
      maxPoints: 10,
      notes
    };
  }

  private routeStats(summary: string | undefined):
    | {
        readonly hasTransit: boolean;
        readonly hasSubway: boolean;
        readonly transfers: number;
        readonly walkMinutes: number;
      }
    | undefined {
    if (summary === undefined || summary.trim().length === 0) {
      return undefined;
    }

    const legs = summary.split("->").map((leg) => leg.trim()).filter((leg) => leg.length > 0);
    const transitLegs = legs.filter((leg) => !leg.toUpperCase().startsWith("WALK"));
    const walkMinutes = legs.reduce((sum, leg) => {
      const match = /(\d+)\s*m\b/i.exec(leg);
      const minutes = match === null ? 0 : Number(match[1]);
      return leg.toUpperCase().startsWith("WALK") && Number.isFinite(minutes) ? sum + minutes : sum;
    }, 0);

    return {
      hasTransit: transitLegs.length > 0,
      hasSubway: transitLegs.some((leg) => leg.toUpperCase().includes("SUBWAY")),
      transfers: Math.max(0, transitLegs.length - 1),
      walkMinutes
    };
  }

  private buildMultipliers(input: ScoreInput, textSignals: TextSignalSet): readonly AppliedMultiplier[] {
    const listing = input.listing;
    const multipliers: AppliedMultiplier[] = [];

    if (input.walkingRoute !== undefined) {
      const accessMinutes = input.walkingRoute.walkingMinutes;

      if (accessMinutes < 10) {
        multipliers.push({ code: "metro-near", factor: 1.08 });
      } else if (accessMinutes > 15) {
        const extraMinutes = accessMinutes - 15;
        multipliers.push({ code: "metro-far", factor: Math.max(0.65, 1 - extraMinutes * 0.015) });
      }
    }

    if (listing.timeToTargetTransit !== undefined) {
      if (listing.timeToTargetTransit <= 20) {
        multipliers.push({ code: "target-transit-near", factor: 1.05 });
      } else if (listing.timeToTargetTransit > 40) {
        const extraMinutes = listing.timeToTargetTransit - 40;
        multipliers.push({ code: "target-transit-far", factor: Math.max(0.85, 1 - extraMinutes * 0.01) });
      }
    }

    if (textSignals.hasWalkThroughLayout) {
      multipliers.push({ code: "walk-through", factor: 0.88 });
    }

    if (textSignals.isBrickHouse) {
      multipliers.push({ code: "brick", factor: 1.08 });
    }

    if (textSignals.isOldPanel) {
      multipliers.push({ code: "old-panel", factor: 0.9 });
    }

    if (textSignals.hasFreshRepair) {
      multipliers.push({ code: "fresh-repair", factor: 1.15 });
    }

    if (textSignals.needsRepair) {
      multipliers.push({ code: "needs-repair", factor: 0.8 });
    }

    const floor = this.numberDetail(listing, "Floor");
    const floors = this.numberDetail(listing, "Floors");
    if (floor === 1) {
      multipliers.push({ code: "first-floor", factor: 0.93 });
    } else if (floor !== undefined && floors !== undefined && floor === floors) {
      multipliers.push({ code: "last-floor", factor: 0.95 });
    }

    const balcony = this.textDetail(listing, "Balcony");
    if (balcony !== undefined && /\u043d\u0435\u0442/i.test(balcony)) {
      multipliers.push({ code: "no-balcony", factor: 0.95 });
    }

    const bathroom = this.textDetail(listing, "Bathroom");
    if (bathroom !== undefined && /\u0440\u0430\u0437\u0434\u0435\u043b\u044c\u043d/i.test(bathroom)) {
      multipliers.push({ code: "separate-bathroom", factor: 1.03 });
    }

    const ceiling = this.numberDetail(listing, "Ceiling");
    if (ceiling !== undefined && ceiling >= 3) {
      multipliers.push({ code: "high-ceiling", factor: 1.05 });
    } else if (ceiling !== undefined && ceiling >= 2.7) {
      multipliers.push({ code: "high-ceiling", factor: 1.03 });
    }

    const kitchen = this.numberDetail(listing, "Kitchen area") ?? this.numberDetail(listing, "Kitchen");
    if (kitchen !== undefined && kitchen < 7) {
      multipliers.push({ code: "small-kitchen", factor: 0.97 });
    } else if (kitchen !== undefined && kitchen >= 9) {
      multipliers.push({ code: "spacious-kitchen", factor: 1.03 });
    }

    return multipliers;
  }

  private textSignals(listing: PersistedListing): TextSignalSet {
    return parseTextSignals([
      listing.title,
      listing.description,
      listing.houseType,
      listing.buildingSeries,
      listing.repairState,
      ...listing.details
    ]);
  }

  private textDetail(listing: PersistedListing, label: string): string | undefined {
    const labels = DETAIL_LABEL_ALIASES[label] ?? [label];
    for (const candidateLabel of labels) {
      const prefix = `${candidateLabel}:`;
      const detail = listing.details.find((item) => item.startsWith(prefix));
      if (detail !== undefined) {
        return detail.slice(prefix.length).trim();
      }
    }

    return undefined;
  }

  private numberDetail(listing: PersistedListing, label: string): number | undefined {
    const value = this.textDetail(listing, label);
    if (value === undefined) {
      return undefined;
    }

    const match = /-?\d+(?:[.,]\d+)?/.exec(value);
    if (match === null) {
      return undefined;
    }

    const parsed = Number(match[0].replace(",", "."));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
