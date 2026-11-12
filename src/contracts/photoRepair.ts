import { z } from "zod";

export const PHOTO_PROMPT_VERSION = 3;
export const floorPlanSchema = z.object({
  layout: z.enum(["isolated", "walk-through", "open"]).nullable(),
  bathroom: z.enum(["separate", "combined"]).nullable()
});
export type FloorPlan = z.infer<typeof floorPlanSchema>;
export const photoRepairCategory = z.enum(["none", "needs-repair", "cosmetic", "good"]);
export type PhotoRepairCategory = z.infer<typeof photoRepairCategory>;
export const photoBuildingCategory = z.enum(["maintained", "worn", "visible-damage"]);
export type PhotoBuildingCategory = z.infer<typeof photoBuildingCategory>;
export const photoObservationSchema = z.object({
  scene: z.enum(["interior", "exterior", "common-area", "floor-plan", "render", "unclear"]),
  condition: photoRepairCategory.nullable(),
  buildingCondition: photoBuildingCategory.nullable().optional(),
  floorPlan: floorPlanSchema.nullable().optional(),
  observations: z.array(z.string().trim().min(1).max(220)).max(4)
});
export type PhotoObservation = z.infer<typeof photoObservationSchema>;
export const photoEvidenceSchema = z.array(photoObservationSchema.extend({ photoUrl: z.string().url() })).max(6);
export type PhotoEvidence = z.infer<typeof photoEvidenceSchema>;
export const photoRepairSchema = z.object({
  id: z.string(), status: z.enum(["QUEUED", "RUNNING", "READY", "INSUFFICIENT", "FAILED", "STALE"]),
  decision: z.enum(["PENDING", "APPROVED", "REJECTED"]), suggestion: photoRepairCategory.nullable(),
  repairNeedsConfirmation: z.boolean().optional(),
  planSuggestion: floorPlanSchema.nullable().optional(),
  model: z.string(), buildingSuggestion: photoBuildingCategory.nullable().optional(),
  promptVersion: z.number().int().optional(), evidence: photoEvidenceSchema, message: z.string().nullable(), updatedAt: z.string()
});
export const photoDecisionSchema = z.object({ analysisId: z.string().uuid(), decision: z.enum(["APPROVED", "REJECTED", "PENDING"]), confirmRepair: z.literal(true).optional() }).strict();
export type PhotoDecision = z.infer<typeof photoDecisionSchema>;
export const renovationBudgetSchema = z.object({ budgetUsd: z.number().min(0).max(999_999_999.99).multipleOf(0.01).nullable() }).strict();
