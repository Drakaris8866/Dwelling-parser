import { z } from "zod";
import { platformSchema } from "./catalog.js";

const publication = z.object({ listingId: z.string().uuid(), propertyId: z.string().uuid(), contentHash: z.string().nullable(),
  platform: platformSchema, externalId: z.string(), priceUsd: z.number(), photo: z.string().nullable() });
export const duplicatePairSchema = z.object({ left: publication, right: publication, address: z.string(), floor: z.number(), rooms: z.number(),
  areaSqm: z.number(), exactPhotos: z.number().int().nonnegative(), sameDescription: z.boolean(), structured: z.boolean() });
export type DuplicatePair = z.infer<typeof duplicatePairSchema>;
export const duplicateSnapshot = (pair: DuplicatePair): string =>
  JSON.stringify([pair.left.propertyId, pair.left.contentHash, pair.right.propertyId, pair.right.contentHash]);
export const duplicateAuditSchema = z.object({ scannedAt: z.string().datetime().nullable(), publications: z.number(), pairs: z.array(duplicatePairSchema) });
export const duplicateAuditPageSchema = duplicateAuditSchema.extend({ total: z.number(), page: z.number(), pages: z.number() });
