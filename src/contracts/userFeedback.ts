import { z } from "zod";

export const userFeedbackRatingSchema = z.union([
  z.literal(-1),
  z.literal(0),
  z.literal(1)
]);
export type UserFeedbackRating = z.infer<typeof userFeedbackRatingSchema>;

export const parsedSignalsSchema = z.object({
  positive: z.array(z.string()),
  negative: z.array(z.string()),
  ambiguous: z.array(z.string())
});
export type ParsedSignals = z.infer<typeof parsedSignalsSchema>;

export const createFeedbackInputSchema = z.object({
  propertyId: z.string().min(1),
  rating: userFeedbackRatingSchema.nullish(),
  commentRaw: z.string().trim().nullish()
});
export type CreateFeedbackInput = z.infer<typeof createFeedbackInputSchema>;

export const updateFeedbackInputSchema = z.object({
  rating: userFeedbackRatingSchema.nullish(),
  commentRaw: z.string().trim().nullish(),
  confirmed: z.boolean().optional()
});
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackInputSchema>;

export const userFeedbackSchema = z.object({
  id: z.string(),
  propertyId: z.string(),
  rating: userFeedbackRatingSchema.nullable(),
  parsedSignals: parsedSignalsSchema.nullable(),
  confirmed: z.boolean(),
  createdAt: z.union([z.date(), z.string()]),
  updatedAt: z.union([z.date(), z.string()])
});
export type UserFeedback = z.infer<typeof userFeedbackSchema>;

export const preferenceWeightsSchema = z.object({
  house: z.number().min(5).max(95),
  commute: z.number().min(5).max(95),
  location: z.number().min(5).max(95),
  layout: z.number().min(5).max(95)
});
export type PreferenceWeights = z.infer<typeof preferenceWeightsSchema>;

export const DEFAULT_PREFERENCE_WEIGHTS: PreferenceWeights = {
  house: 20,
  commute: 15,
  location: 10,
  layout: 10
} as const;

export const userPreferencesSchema = z.object({
  weightVersion: z.number().int().nonnegative(),
  weights: preferenceWeightsSchema,
  updatedAt: z.union([z.date(), z.string()]).optional()
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;
