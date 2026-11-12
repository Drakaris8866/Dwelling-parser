import { z } from "zod";
import { comparableSchema } from "./catalog.js";

export const manualBudgetSchema = z.number().min(0).max(Number.MAX_SAFE_INTEGER / 100);
export const moneyRangeSchema = z.object({ low: manualBudgetSchema, base: manualBudgetSchema, high: manualBudgetSchema })
  .refine(({ low, base, high }) => low <= base && base <= high, "Expected an ordered monetary range");
export type MoneyRange = z.infer<typeof moneyRangeSchema>;

const repairScope = z.enum(["full", "cosmetic"]);
const provenance = { observedOn: z.iso.date(), source: z.string().trim().min(1).max(300) };
export const renovationRatesSchema = z.object({
  scope: repairScope, labor: moneyRangeSchema, materials: moneyRangeSchema, ...provenance
});
export const renovationFxSchema = z.object({ bynPerUsd: z.number().positive(), ...provenance });
export const renovationUsdRateSchema = z.object({
  usdPerSqm: manualBudgetSchema.positive(), scope: repairScope, ...provenance
}).strict();
export const renovationBaseInputSchema = z.object({
  areaSqm: z.number().positive(), condition: z.enum(["full", "cosmetic", "meets-target", "user-finished", "unknown"]),
  reservePct: z.number().min(0).max(100), asOf: z.iso.date()
});
export const renovationInputSchema = renovationBaseInputSchema.extend({
  manualBudgetUsd: manualBudgetSchema.nullish(), rates: renovationRatesSchema.optional(), fx: renovationFxSchema.optional(),
  usdRate: renovationUsdRateSchema.optional()
});
export type RenovationInput = z.infer<typeof renovationInputSchema>;

export const renovationEstimateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknown"), reason: z.enum(["invalid-input", "unknown-condition", "missing-rates", "future-rates"]) }),
  z.object({
    status: z.literal("known"), source: z.enum(["manual", "not-needed", "user-rule", "rates", "usd-rate"]),
    byn: moneyRangeSchema.nullable(), usd: moneyRangeSchema.nullable(),
    rates: renovationRatesSchema.nullable(), fx: renovationFxSchema.nullable(),
    usdUnavailable: z.enum(["missing-fx", "stale-fx", "invalid-fx"]).nullable(),
    usdRate: renovationUsdRateSchema.optional()
  }).refine((estimate) => estimate.source !== "usd-rate" || (estimate.usdRate !== undefined && estimate.usd !== null
    && estimate.byn === null && estimate.rates === null && estimate.fx === null && estimate.usdUnavailable === null),
  "USD rate estimates require their source rate and a direct USD budget")
]);
export type RenovationEstimate = z.infer<typeof renovationEstimateSchema>;

const score = z.number().min(0).max(100);
const rankingComponent = z.enum(["money", "house", "commute", "location", "layout"]);
export const minimumComparablesSchema = z.number().int().min(3).max(20);
export const personalRankingInputSchema = z.object({
  minimumComparables: minimumComparablesSchema.optional(),
  purchaseUsd: manualBudgetSchema.positive(), areaSqm: z.number().positive(), eligible: z.boolean(),
  renovation: renovationEstimateSchema, asIsComparables: z.array(z.lazy(() => comparableSchema)).readonly(),
  readyComparables: z.array(z.lazy(() => comparableSchema)).readonly(), knownComparableFeatures: z.number().int().min(0).max(4),
  components: z.object({ house: score.optional(), commute: score.optional(), location: score.optional(), layout: score.optional() })
});
export type PersonalRankingInput = z.infer<typeof personalRankingInputSchema>;
export const personalRankingResultSchema = z.object({
  version: z.number().int().positive(), totalUsd: moneyRangeSchema.nullable(),
  score: score.nullable(), asIsScore: score.nullable(), asIsDiscountPct: z.number().nullable(),
  readyMedianUsdSqm: z.number().positive().nullable(), budgetDiscountPct: z.number().nullable(),
  coverage: score, provisional: z.boolean(),
  breakdown: z.array(z.object({ key: rankingComponent, weight: score, observed: score.nullable(), contribution: score })),
  reason: z.enum(["invalid-input", "ineligible", "missing-budget", "insufficient-comparables"]).nullable()
});
export type PersonalRankingResult = z.infer<typeof personalRankingResultSchema>;

export const personalRankingSettingsSchema = z.object({
  minimumComparables: minimumComparablesSchema.optional(),
  previewEnabled: z.boolean().default(false), targetLevel: z.enum(["good", "designer"]).default("good"),
  reservePct: z.number().min(0).max(100).default(10),
  zeroBudgetForFinishedRepair: z.boolean().optional(),
  rates: renovationRatesSchema.optional(), fx: renovationFxSchema.optional(), usdRate: renovationUsdRateSchema.optional()
}).strict();
export type PersonalRankingSettings = z.infer<typeof personalRankingSettingsSchema>;
export const rankingPriceEvidenceSchema = z.object({
  propertyId: z.string(), disputed: z.boolean(),
  resolution: z.enum(["exact-usd", "original-usd", "same-byn-conversion", "disputed"]).optional(),
  publications: z.array(z.object({ externalId: z.string(), platform: z.string(), priceUsd: z.number(), priceByn: z.number().nullable().optional(), priceCurrency: z.enum(["USD", "BYN"]).optional(), lastSeenAt: z.iso.datetime() }))
});
export const personalRankingSnapshotSchema = z.object({
  id: z.string(), propertyId: z.string(), inputHash: z.string(), calculatedAt: z.iso.datetime(), asOf: z.iso.date(),
  settingsVersion: z.string(), purchaseUsd: z.number(), result: personalRankingResultSchema,
  inputs: personalRankingInputSchema, settings: personalRankingSettingsSchema,
  versions: z.object({ ranking: z.number().int(), comparables: z.number().int() }),
  sourceHashes: z.array(z.object({ propertyId: z.string(), externalId: z.string(), platform: z.string(), contentHash: z.string().nullable(), galleryHash: z.string().nullable(), repairHash: z.string(), routeHash: z.string() })),
  renovation: renovationEstimateSchema, asIsComparables: z.array(z.lazy(() => comparableSchema)), readyComparables: z.array(z.lazy(() => comparableSchema)),
  rejections: z.object({ asIs: z.record(z.string(), z.number()), ready: z.record(z.string(), z.number()) }),
  priceEvidence: z.array(rankingPriceEvidenceSchema)
});
export type PersonalRankingSnapshot = z.infer<typeof personalRankingSnapshotSchema>;
export const personalRankingSnapshotResponseSchema = z.object({
  status: z.enum(["disabled", "absent", "stale", "current"]), snapshot: personalRankingSnapshotSchema.nullable()
});
export type PersonalRankingSnapshotResponse = z.infer<typeof personalRankingSnapshotResponseSchema>;
