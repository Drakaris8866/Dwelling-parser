import { manualBudgetSchema, moneyRangeSchema, personalRankingInputSchema, type MoneyRange, type PersonalRankingInput, type PersonalRankingResult } from "../contracts/personalRanking.js";
import { evaluatePrice, roundRating, comparablePrices } from "./priceRating.js";
import { PRICE_POLICY } from "./catalogPricePolicy.js";

export const PERSONAL_RANKING_VERSION = 1;
const weights = { money: 45, house: 20, commute: 15, location: 10, layout: 10 } as const;
const keys = ["money", "house", "commute", "location", "layout"] as const;

export interface PersonalRankingPreviewEntry {
  propertyId: string;
  result: PersonalRankingResult;
  // Key identifies shared comparable characteristics and target level, never an individual property.
  comparableGroupKey: string | null;
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export const comparePersonalRankingPreview = (left: PersonalRankingPreviewEntry, right: PersonalRankingPreviewEntry): number => {
  const a = left.result, b = right.result;
  if (a.score === null || b.score === null) {
    if (a.score !== b.score) return a.score === null ? 1 : -1;
    return compareText(left.propertyId, right.propertyId);
  }
  const priority = b.score - a.score || Number(a.provisional) - Number(b.provisional) || b.coverage - a.coverage;
  if (priority) return priority;
  // Keep groups contiguous: pairwise budget comparisons across interleaved groups would be non-transitive.
  if ((left.comparableGroupKey === null) !== (right.comparableGroupKey === null)) return left.comparableGroupKey === null ? 1 : -1;
  const group = compareText(left.comparableGroupKey ?? "", right.comparableGroupKey ?? "");
  if (group) return group;
  if (left.comparableGroupKey !== null) {
    if ((a.totalUsd === null) !== (b.totalUsd === null)) return a.totalUsd === null ? 1 : -1;
  }
  if (left.comparableGroupKey !== null && a.totalUsd !== null && b.totalUsd !== null) {
    const budget = a.totalUsd.base - b.totalUsd.base;
    if (budget) return budget;
  }
  return compareText(left.propertyId, right.propertyId);
};

export const compareBudgetRanges = (left: MoneyRange | null, right: MoneyRange | null): "lower" | "higher" | "overlap" | "unknown" => {
  if (!moneyRangeSchema.safeParse(left).success || !moneyRangeSchema.safeParse(right).success || !left || !right) return "unknown";
  if (left.high < right.low) return "lower";
  if (left.low > right.high) return "higher";
  return "overlap";
};

const empty = (reason: NonNullable<PersonalRankingResult["reason"]>): PersonalRankingResult => ({
  version: PERSONAL_RANKING_VERSION, totalUsd: null, score: null, asIsScore: null, asIsDiscountPct: null,
  readyMedianUsdSqm: null, budgetDiscountPct: null, coverage: 0, provisional: true, breakdown: [], reason
});

const addBudget = (purchaseUsd: number, budget: MoneyRange | null): MoneyRange | null => {
  if (!budget) return null;
  const amount = (repairUsd: number): number => Math.round((purchaseUsd + repairUsd) * 100) / 100;
  const total = moneyRangeSchema.safeParse({ low: amount(budget.low), base: amount(budget.base), high: amount(budget.high) });
  return total.success ? total.data : null;
};

export const calculatePersonalRanking = (input: PersonalRankingInput): PersonalRankingResult => {
  const parsed = personalRankingInputSchema.safeParse(input);
  if (!parsed.success) return empty("invalid-input");
  const { purchaseUsd, areaSqm, eligible, renovation, knownComparableFeatures, asIsComparables, readyComparables, components } = parsed.data;
  const minimumComparables = parsed.data.minimumComparables ?? PRICE_POLICY.minimumComparables;
  if (!eligible) return empty("ineligible");
  const purchasePerSqm = purchaseUsd / areaSqm;
  if (!manualBudgetSchema.positive().safeParse(purchasePerSqm).success) return empty("invalid-input");
  const asIs = evaluatePrice(purchasePerSqm, asIsComparables, true, knownComparableFeatures, minimumComparables);
  const totalUsd = addBudget(purchaseUsd, renovation.status === "known" ? renovation.usd : null);
  const totalPerSqm = totalUsd ? totalUsd.base / areaSqm : null;
  const ready = totalPerSqm !== null && manualBudgetSchema.positive().safeParse(totalPerSqm).success
    ? evaluatePrice(totalPerSqm, readyComparables, true, knownComparableFeatures, minimumComparables) : null;
  const money = ready?.score ?? null;
  const breakdown = keys.map((key): PersonalRankingResult["breakdown"][number] => {
    const observed = key === "money" ? money : components[key] ?? null;
    return { key, weight: weights[key], observed, contribution: (observed ?? 50) * weights[key] / 100 };
  });
  const coverage = breakdown.reduce((sum, part) => sum + (part.observed === null ? 0 : part.weight), 0);
  return {
    version: PERSONAL_RANKING_VERSION, totalUsd, score: money === null ? null : roundRating(breakdown.reduce((sum, part) => sum + part.contribution, 0)),
    asIsScore: asIs.score, asIsDiscountPct: asIs.discount, readyMedianUsdSqm: ready?.median ?? null, budgetDiscountPct: ready?.discount ?? null,
    coverage, provisional: money === null || comparablePrices(readyComparables).length < PRICE_POLICY.minimumComparables || coverage < 100 || (totalUsd !== null && totalUsd.low !== totalUsd.high), breakdown,
    reason: money !== null ? null : totalPerSqm === null ? "missing-budget" : ready === null ? "invalid-input" : "insufficient-comparables"
  };
};
