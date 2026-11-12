import { z } from "zod";
import { photoBuildingCategory, photoRepairCategory, photoRepairSchema } from "./photoRepair.js";
import { moneyRangeSchema } from "./personalRanking.js";

export const platformSchema = z.enum(["KUFAR", "ONLINER", "REALT"]);
export const materialSchema = z.enum(["brick", "panel", "monolith", "block", "wood", "other"]);
export const repairSchema = z.enum(["none", "needs-repair", "cosmetic", "good", "designer"]);
export const layoutSchema = z.enum(["isolated", "walk-through", "open"]);
export const readinessSchema = z.enum(["ready", "unfinished", "construction"]);
export const confidenceSchema = z.enum(["none", "low", "medium", "high"]);
export const dispositionSchema = z.enum(["ACCEPTED", "REVIEW", "EXCLUDED"]);

export const featuresSchema = z.object({
  address: z.string().optional(), locality: z.string().optional(), district: z.string().optional(),
  marketZone: z.string().optional(), complex: z.string().optional(), complexId: z.string().optional(),
  propertyType: z.enum(["apartment", "house", "room", "share", "unknown"]).optional(),
  dealType: z.enum(["sale", "rent", "unknown"]).optional(),
  ownership: z.enum(["whole", "partial", "unknown"]).optional(),
  inCollectionArea: z.boolean().optional(), isStudio: z.boolean().optional(),
  kitchenSqm: z.number().nonnegative().optional(), livingSqm: z.number().nonnegative().optional(),
  floor: z.number().int().optional(), totalFloors: z.number().int().nonnegative().optional(),
  buildingYear: z.number().int().optional(), buildingMaterial: materialSchema.optional(),
  repair: repairSchema.optional(), layout: layoutSchema.optional(), balcony: z.boolean().optional(),
  elevator: z.boolean().optional(), bathroom: z.enum(["separate", "combined"]).optional(),
  ceilingMeters: z.number().positive().optional(), seller: z.enum(["owner", "agent", "developer"]).optional(),
  readiness: readinessSchema.optional(), priceIsTotal: z.boolean().optional(),
  descriptionComplete: z.boolean().optional(),
  provenance: z.record(z.string(), z.enum(["structured", "description", "legacy", "inferred"])).default({})
});
export type ListingFeatures = z.infer<typeof featuresSchema>;
export type PlatformName = z.infer<typeof platformSchema>;

export const routeLegSchema = z.object({
  mode: z.string(), route: z.string().nullable(), durationMinutes: z.number().nonnegative(),
  from: z.string().nullable(), to: z.string().nullable(),
  distanceMeters: z.number().nonnegative().nullable(),
  encodedPath: z.string().min(1).max(200_000).optional()
});
export const routePlanSchema = z.object({
  durationMinutes: z.number().nonnegative(), walkingMinutes: z.number().nonnegative(),
  waitingMinutes: z.number().nonnegative(), transfers: z.number().int().nonnegative(),
  hasTransit: z.boolean(), legs: z.array(routeLegSchema), date: z.string(), time: z.string(),
  provider: z.literal("otp"), calculatedAt: z.string(),
  departureAt: z.string().datetime().optional(), arrivalAt: z.string().datetime().optional(),
  initialWaitMinutes: z.number().nonnegative().optional(),
  arriveBy: z.boolean().optional(), arrivalBufferMinutes: z.number().nonnegative().optional(),
  destination: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional()
});
export const routingDataSchema = z.object({
  target: routePlanSchema.nullable(), metro: routePlanSchema.nullable(), metroName: z.string().nullable(),
  targetStatus: z.enum(["READY", "NO_ROUTE", "FAILED"]).optional(),
  metroStatus: z.enum(["READY", "NO_ROUTE", "FAILED"]).optional(),
  targetError: z.string().nullable().optional(), metroError: z.string().nullable().optional(),
  policyVersion: z.number().int().optional(), alternativesIncomplete: z.boolean().optional(),
  alternatives: z.array(z.object({ kind: z.enum(["fastest", "surface", "tram"]), route: routePlanSchema })).optional(),
  settingsKey: z.string()
});
export type RoutePlan = z.infer<typeof routePlanSchema>;
export type RoutingData = z.infer<typeof routingDataSchema>;

export const settingsSchema = z.object({
  targetLatitude: z.number().min(-90).max(90).default(53.906936),
  targetLongitude: z.number().min(-180).max(180).default(27.588628),
  arrivalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("08:30"),
  transportWeight: z.number().min(0).max(100).default(35),
  conditionWeight: z.number().min(0).max(100).default(35),
  layoutWeight: z.number().min(0).max(100).default(30)
}).refine((s) => s.transportWeight + s.conditionWeight + s.layoutWeight === 100, "Сумма весов должна быть 100%");
export type CatalogSettings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: CatalogSettings = settingsSchema.parse({});

const range = z.number().finite().nonnegative().optional();
export const filtersSchema = z.object({
  text: z.string().max(200).optional(), platforms: z.array(platformSchema).optional(),
  rooms: z.array(z.number().int().min(0).max(20)).optional(), studio: z.boolean().optional(),
  minPrice: range, maxPrice: range, minPriceSqm: range, maxPriceSqm: range,
  minArea: range, maxArea: range, minKitchen: range, maxKitchen: range, minLiving: range, maxLiving: range,
  localities: z.array(z.string()).optional(), districts: z.array(z.string()).optional(),
  repair: z.array(repairSchema).optional(), materials: z.array(materialSchema).optional(),
  minYear: range, maxYear: range, minFloor: range, maxFloor: range,
  notFirstFloor: z.boolean().optional(), notLastFloor: z.boolean().optional(),
  elevator: z.boolean().optional(), balcony: z.boolean().optional(),
  layout: z.array(layoutSchema).optional(), readiness: z.array(readinessSchema).optional(),
  sellers: z.array(z.enum(["owner", "agent", "developer"])).optional(),
  maxTransit: range, maxMetroWalk: range, minValueScore: range, minComfortScore: range,
  confidence: z.array(confidenceSchema).optional(), favoritesOnly: z.boolean().optional(),
  showHidden: z.boolean().optional(), showReview: z.boolean().optional(),
  bounds: z.object({ south: z.number(), north: z.number(), west: z.number(), east: z.number() })
    .refine((b) => b.south <= b.north && b.west <= b.east, "Неверные границы карты").optional()
}).superRefine((f, ctx) => {
  for (const [a, b] of [[f.minPrice, f.maxPrice], [f.minArea, f.maxArea], [f.minPriceSqm, f.maxPriceSqm], [f.minFloor, f.maxFloor], [f.minYear, f.maxYear]]) {
    if (a !== undefined && b !== undefined && a > b) ctx.addIssue({ code: "custom", message: "Минимум больше максимума" });
  }
});
export type CatalogFilters = z.infer<typeof filtersSchema>;
export const sortSchema = z.enum(["newest", "price-asc", "price-desc", "price-sqm", "value", "comfort", "transit"]);
export type CatalogSort = z.infer<typeof sortSchema>;

export const comparableSchema = z.object({
  propertyId: z.string(), externalId: z.string(), platform: platformSchema, address: z.string().nullable(),
  priceUsd: z.number(), priceSqm: z.number(), areaSqm: z.number(), distanceMeters: z.number(),
  photo: z.string().nullable().optional(),
  photos: z.array(z.string()).optional(),
  rooms: z.number().int().optional(),
  floor: z.number().int().optional(),
  totalFloors: z.number().int().optional(),
  buildingYear: z.number().int().optional(),
  repair: repairSchema.optional(),
  title: z.string().optional()
});
export const scoringCriterionSchema = z.object({
  code: z.string(), label: z.string(), observed: z.string().nullable(), rule: z.string(),
  score: z.number().min(0).max(100).nullable(), weight: z.number().min(0).max(100)
});
export const renovationScenarioSchema = z.object({
  budgetUsd: z.number(), purchaseUsd: z.number(), totalUsd: z.number(), priceSqm: z.number(),
  valueScore: z.number().nullable(), medianPriceSqm: z.number().nullable(), discountPct: z.number().nullable(),
  radiusMeters: z.number().nullable(), comparables: z.array(comparableSchema)
});
export type RenovationScenario = z.infer<typeof renovationScenarioSchema>;
export type ScoringCriterion = z.infer<typeof scoringCriterionSchema>;
export const assessmentSchema = z.object({
  version: z.string(), valueScore: z.number().nullable(), comfortScore: z.number().nullable(),
  coverage: z.number(), confidence: confidenceSchema, comparableCount: z.number(), radiusMeters: z.number().nullable(),
  discountPct: z.number().nullable(), medianPriceSqm: z.number().nullable(),
  priceRangeLow: z.number().nullable(), priceRangeHigh: z.number().nullable(),
  reasons: z.array(z.string()), components: z.array(z.object({ code: z.string(), label: z.string(), score: z.number().nullable(), coverage: z.number(), weight: z.number(),
    points: z.number().optional(), criteria: z.array(scoringCriterionSchema).optional() })),
  priceEvidence: z.object({ priceSqm: z.number(), rules: z.array(z.string()), base: z.number(), pointsPerPercent: z.number().optional(), rawScore: z.number().nullable(), confidenceEvidence: z.string().nullable(),
    curveScale: z.number().positive().optional(), evidenceWeight: z.number().min(0).max(1).nullable().optional(),
    repair: repairSchema.optional(), repairSource: z.enum(["listing", "photo"]).optional() }).optional(),
  renovationScenario: renovationScenarioSchema.optional(),
  comparables: z.array(comparableSchema), calculatedAt: z.string()
});
export type CatalogAssessment = z.infer<typeof assessmentSchema>;
export type Comparable = z.infer<typeof comparableSchema>;

export const sourceLinkSchema = z.object({ platform: platformSchema, externalId: z.string(), url: z.string(), priceUsd: z.number(), lastSeenAt: z.string() });
const processingStateSchema = z.object({
  state: z.enum(["pending", "running", "ready", "insufficient", "review", "failed", "missing-coordinates", "no-route"]),
  message: z.string()
});
export const processingSchema = z.object({ route: processingStateSchema, value: processingStateSchema, comfort: processingStateSchema });
export type CatalogProcessing = z.infer<typeof processingSchema>;
export const routeQueueStatusSchema = z.object({ position: z.number().int().positive(), estimatedSeconds: z.number().int().nonnegative().nullable() });
export type RouteQueueStatus = z.infer<typeof routeQueueStatusSchema>;
export const catalogItemSchema = z.object({
  id: z.string(), listingId: z.string(), title: z.string(), description: z.string(),
  rooms: z.number(), areaSqm: z.number(), priceUsd: z.number(), priceByn: z.number().nullable(), priceSqm: z.number(),
  latitude: z.number().nullable(), longitude: z.number().nullable(), photos: z.array(z.string()),
  features: featuresSchema, disposition: dispositionSchema, reasons: z.array(z.string()),
  favorite: z.boolean(), hidden: z.boolean(), firstSeenAt: z.string(), lastSeenAt: z.string(),
  sources: z.array(sourceLinkSchema), assessment: assessmentSchema.nullable(), routes: routingDataSchema.nullable(),
  enrichmentStatus: z.string(), possibleDuplicateIds: z.array(z.string()).default([]),
  confirmedRepair: photoRepairCategory.optional(), confirmedBuilding: photoBuildingCategory.optional(), renovationBudgetUsd: z.number().nullable().optional(), assessmentRevision: z.number().int().optional(),
  processing: processingSchema.optional(), routeQueue: routeQueueStatusSchema.optional()
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export const catalogPageSchema = z.object({ items: z.array(catalogItemSchema), total: z.number(), page: z.number(), pageSize: z.number(), pages: z.number() });
export type CatalogPage = z.infer<typeof catalogPageSchema>;
export const catalogDetailSchema = z.object({
  item: catalogItemSchema,
  photoRepair: photoRepairSchema.nullable().optional(), photoRepairAvailable: z.boolean().optional(),
  priceHistory: z.array(z.object({ date: z.string(), priceUsd: z.number(), platform: platformSchema }))
});
export type CatalogDetail = z.infer<typeof catalogDetailSchema>;
export const savedSearchSchema = z.object({ id: z.string(), name: z.string(), filters: filtersSchema, notifications: z.boolean(), initializedAt: z.string().nullable() });
export type SavedSearchDto = z.infer<typeof savedSearchSchema>;
export const saveSearchInputSchema = z.object({ name: z.string().trim().min(1).max(100), filters: filtersSchema, notifications: z.boolean().default(false) });
export const sourceStatusSchema = z.object({
  platform: platformSchema, status: z.string(), pages: z.number(), received: z.number(), accepted: z.number(),
  review: z.number(), excluded: z.number(), invalid: z.number(), detailErrors: z.number(),
  reasons: z.record(z.string(), z.number()), error: z.string().nullable(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
  lastSuccessfulAt: z.string().nullable(), catalogAccepted: z.number(), catalogReview: z.number(), catalogExcluded: z.number()
});
const backgroundTaskSchema = z.object({ name: z.string(), active: z.number().int().nonnegative(), queued: z.number().int().nonnegative() });
export const healthSchema = z.object({
  sources: z.array(sourceStatusSchema), otp: z.object({ available: z.boolean(), message: z.string() }),
  pendingJobs: z.number(), tasks: z.array(backgroundTaskSchema)
});
export type CatalogHealth = z.infer<typeof healthSchema>;
export const facetsSchema = z.object({ localities: z.array(z.string()), districts: z.array(z.string()) });
export const mapResultSchema = z.object({ total: z.number(), located: z.number(), points: z.array(z.object({
  id: z.string(), propertyId: z.string().nullable(), latitude: z.number(), longitude: z.number(), count: z.number(), minPrice: z.number(),
  bounds: z.object({ south: z.number(), north: z.number(), west: z.number(), east: z.number() })
})) });
export type MapResult = z.infer<typeof mapResultSchema>;

export const shadowRankingBreakdownItemSchema = z.object({
  key: z.enum(["money", "house", "commute", "location", "layout"]),
  weight: z.number(),
  observed: z.number().nullable(),
  contribution: z.number()
});
export type ShadowRankingBreakdownItem = z.infer<typeof shadowRankingBreakdownItemSchema>;

export const shadowRankingSchema = z.object({
  score: z.number().nullable(),
  asIsScore: z.number().nullable(),
  totalUsd: z.lazy(() => moneyRangeSchema).nullable(),
  coverage: z.number(),
  provisional: z.boolean(),
  reason: z.string().nullable(),
  breakdown: z.array(shadowRankingBreakdownItemSchema),
  calculatedAt: z.string()
});
export type ShadowRankingDto = z.infer<typeof shadowRankingSchema>;
