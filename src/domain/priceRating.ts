import type { Comparable, ListingFeatures } from "../contracts/catalog.js";
import { PRICE_POLICY } from "./catalogPricePolicy.js";

export const roundRating = (value: number): number => Math.round(value * 10) / 10;
export const medianOf = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? NaN : sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]!) / 2;
};
export const knownPriceFeatures = (features: ListingFeatures): number =>
  [features.repair, features.buildingMaterial, features.buildingYear, features.layout].filter((value) => value !== undefined).length;

interface PriceRating {
  median: number | null; discount: number | null; low: number | null; high: number | null;
  score: number | null; evidenceWeight: number | null; spread: number | null;
}

export const comparablePrices = (comparables: readonly Comparable[]): number[] =>
  [...new Map(comparables.map((c) => [c.propertyId, c.priceSqm])).values()].filter((price) => Number.isFinite(price) && price > 0).sort((a, b) => a - b);

export const evaluatePrice = (priceSqm: number, comparables: readonly Comparable[], accepted: boolean, known: number, minimumComparables: number = PRICE_POLICY.minimumComparables): PriceRating => {
  const prices = comparablePrices(comparables);
  if (!accepted || prices.length < minimumComparables) return { median: null, discount: null, low: null, high: null, score: null, evidenceWeight: null, spread: null };
  const median = medianOf(prices), discount = (median - priceSqm) / median * 100;
  const low = prices[Math.floor((prices.length - 1) * 0.25)]!, high = prices[Math.ceil((prices.length - 1) * 0.75)]!;
  const spread = (high - low) / median;
  const evidenceWeight = prices.length / (prices.length + PRICE_POLICY.samplePrior) * (0.6 + 0.1 * known) / (1 + spread);
  const score = PRICE_POLICY.base + PRICE_POLICY.base * discount / (PRICE_POLICY.curveScale + Math.abs(discount)) * evidenceWeight;
  return { median, discount: roundRating(discount), low, high, spread, score: roundRating(score), evidenceWeight };
};
