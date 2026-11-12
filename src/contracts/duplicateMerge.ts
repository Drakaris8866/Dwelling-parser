import { z } from "zod";

const date = z.string().datetime();
const propertyState = z.object({
  id: z.string(), favorite: z.boolean(), hidden: z.boolean(), renovationBudgetUsd: z.string().nullable(), assessmentRevision: z.number().int(), userStateRevision: z.number().int().nonnegative()
}).strict();
const listingState = z.object({
  id: z.string(), propertyId: z.string().nullable(), isRepresentative: z.boolean(), possibleDuplicateIds: z.array(z.string()), contentHash: z.string().nullable(), updatedAt: date
}).strict();
const assessmentState = z.object({
  propertyId: z.string(), version: z.string(), valueScore: z.number().nullable(), comfortScore: z.number().nullable(), coverage: z.number(),
  discountPct: z.number().nullable(), medianPriceSqm: z.number().nullable(), confidence: z.string(), comparableCount: z.number().int(), data: z.json(), calculatedAt: date
}).strict();
const matchState = z.object({ searchId: z.string(), propertyId: z.string(), priceUsd: z.string(), updatedAt: date }).strict();
const notificationState = z.object({
  id: z.string(), eventKey: z.string(), searchId: z.string(), propertyId: z.string(), kind: z.string(), status: z.string(), attempts: z.number().int(),
  error: z.string().nullable(), createdAt: date, sentAt: date.nullable()
}).strict();

export const duplicateMergeStateSchema = z.object({
  version: z.literal(1), properties: z.array(propertyState), listings: z.array(listingState), assessments: z.array(assessmentState), matches: z.array(matchState), notifications: z.array(notificationState)
}).strict();
export type DuplicateMergeState = z.infer<typeof duplicateMergeStateSchema>;
export const duplicateMergeSummarySchema = z.object({
  id: z.string().uuid(), primaryId: z.string().uuid(), secondaryId: z.string().uuid(), evidence: z.enum(["structured", "photos"]), createdAt: date, undoneAt: date.nullable()
}).strict();
export type DuplicateMergeSummary = z.infer<typeof duplicateMergeSummarySchema>;
export type DuplicateUndoResult = { readonly ok: true } | { readonly ok: false; readonly reason: "not-found" | "already-undone" | "state-changed" };
