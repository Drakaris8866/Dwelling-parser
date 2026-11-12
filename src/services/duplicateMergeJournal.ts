import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { z } from "zod";
import { duplicateMergeStateSchema, duplicateMergeSummarySchema, type DuplicateMergeState, type DuplicateMergeSummary, type DuplicateUndoResult } from "../contracts/duplicateMerge.js";
import { canonicalJson, toPrismaJson } from "../utils/json.js";

type Database = Prisma.TransactionClient;
type MergeRow = { id: string; primaryId: string; secondaryId: string; evidence: string; before: Prisma.JsonValue; after: Prisma.JsonValue; createdAt: Date; undoneAt: Date | null };

export const isDuplicateWriteConflict = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  // Prisma's pg adapter exposes SQL conflicts from raw locking queries as P2010.
  return error.code === "P2010" && z.object({ driverAdapterError: z.object({ cause: z.object({ originalCode: z.enum(["40001", "40P01"]) }) }) }).safeParse(error.meta).success;
};

// Keep the same lock order for merge and undo, including links outside the two groups.
export const lockDuplicateState = async (tx: Database, primaryId: string, secondaryId: string, listingIds: readonly string[] = []): Promise<void> => {
  await tx.$queryRaw`SELECT id FROM "Listing" WHERE "propertyId" IN (${Prisma.join([primaryId, secondaryId])}) OR ${secondaryId} = ANY("possibleDuplicateIds") OR id = ANY(${[...listingIds]}::text[]) ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Property" WHERE id IN (${Prisma.join([primaryId, secondaryId])}) ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT "propertyId" FROM "Assessment" WHERE "propertyId" IN (${Prisma.join([primaryId, secondaryId])}) ORDER BY "propertyId" FOR UPDATE`;
  await tx.$queryRaw`SELECT "searchId" FROM "SearchMatch" WHERE "propertyId" IN (${Prisma.join([primaryId, secondaryId])}) ORDER BY "searchId", "propertyId" FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Notification" WHERE "propertyId" IN (${Prisma.join([primaryId, secondaryId])}) ORDER BY id FOR UPDATE`;
};

export const captureDuplicateState = async (tx: Database, primaryId: string, secondaryId: string, listingIds: readonly string[] = []): Promise<DuplicateMergeState> => {
  const properties = await tx.property.findMany({ where: { id: { in: [primaryId, secondaryId] } }, orderBy: { id: "asc" }, select: { id: true, favorite: true, hidden: true, renovationBudgetUsd: true, assessmentRevision: true, userStateRevision: true } });
  const listings = await tx.listing.findMany({ where: { OR: [{ propertyId: { in: [primaryId, secondaryId] } }, { possibleDuplicateIds: { has: secondaryId } }, { id: { in: [...listingIds] } }] }, orderBy: { id: "asc" }, select: { id: true, propertyId: true, isRepresentative: true, possibleDuplicateIds: true, contentHash: true, updatedAt: true } });
  const assessments = await tx.assessment.findMany({ where: { propertyId: { in: [primaryId, secondaryId] } }, orderBy: { propertyId: "asc" } });
  const matches = await tx.searchMatch.findMany({ where: { propertyId: { in: [primaryId, secondaryId] } }, orderBy: [{ searchId: "asc" }, { propertyId: "asc" }] });
  const notifications = await tx.notification.findMany({ where: { propertyId: { in: [primaryId, secondaryId] } }, orderBy: { id: "asc" } });
  return duplicateMergeStateSchema.parse(JSON.parse(JSON.stringify({ version: 1, properties, listings, assessments, matches, notifications })) as unknown);
};

export const recordDuplicateMerge = async (tx: Database, primaryId: string, secondaryId: string, evidence: "structured" | "photos", before: DuplicateMergeState): Promise<void> => {
  const after = await captureDuplicateState(tx, primaryId, secondaryId, before.listings.map((row) => row.id));
  await tx.$executeRaw`INSERT INTO "DuplicateMerge" (id, "primaryId", "secondaryId", evidence, before, after) VALUES (${randomUUID()}, ${primaryId}, ${secondaryId}, ${evidence}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)`;
};

export const listDuplicateMerges = async (prisma: PrismaClient, propertyId: string): Promise<DuplicateMergeSummary[]> => {
  const rows = await prisma.$queryRaw<MergeRow[]>`SELECT id, "primaryId", "secondaryId", evidence, "createdAt", "undoneAt" FROM "DuplicateMerge" WHERE "primaryId" = ${propertyId} OR "secondaryId" = ${propertyId} ORDER BY "createdAt" DESC, id DESC LIMIT 50`;
  return rows.map((row) => duplicateMergeSummarySchema.parse({ ...row, createdAt: row.createdAt.toISOString(), undoneAt: row.undoneAt?.toISOString() ?? null }));
};

export const undoDuplicateMerge = async (prisma: PrismaClient, id: string): Promise<DuplicateUndoResult> => {
  try {
    return await prisma.$transaction(async (tx): Promise<DuplicateUndoResult> => {
      const [merge] = await tx.$queryRaw<MergeRow[]>`SELECT * FROM "DuplicateMerge" WHERE id = ${id} FOR UPDATE`;
      if (!merge) return { ok: false, reason: "not-found" };
      if (merge.undoneAt) return { ok: false, reason: "already-undone" };
      const parsedBefore = duplicateMergeStateSchema.safeParse(merge.before);
      const parsedAfter = duplicateMergeStateSchema.safeParse(merge.after);
      if (!parsedBefore.success || !parsedAfter.success) return { ok: false, reason: "state-changed" };
      const before = parsedBefore.data;
      const after = parsedAfter.data;
      await lockDuplicateState(tx, merge.primaryId, merge.secondaryId, before.listings.map((row) => row.id));
      const current = await captureDuplicateState(tx, merge.primaryId, merge.secondaryId, before.listings.map((row) => row.id));
      if (canonicalJson(current) !== canonicalJson(after)) return { ok: false, reason: "state-changed" };
      for (const row of before.properties) await tx.property.update({ where: { id: row.id }, data: {
        favorite: row.favorite, hidden: row.hidden, renovationBudgetUsd: row.renovationBudgetUsd, assessmentRevision: { increment: 1 }, userStateRevision: { increment: 1 }
      } });
      for (const row of before.listings) await tx.listing.update({ where: { id: row.id }, data: {
        propertyId: row.propertyId, isRepresentative: row.isRepresentative, possibleDuplicateIds: row.possibleDuplicateIds, updatedAt: new Date(row.updatedAt)
      } });
      for (const row of before.assessments) {
        const { propertyId, calculatedAt, data, ...fields } = row;
        await tx.assessment.update({ where: { propertyId }, data: { ...fields, data: data === null ? Prisma.JsonNull : toPrismaJson(data), calculatedAt: new Date(calculatedAt) } });
      }
      await tx.searchMatch.deleteMany({ where: { propertyId: { in: [merge.primaryId, merge.secondaryId] } } });
      if (before.matches.length > 0) await tx.searchMatch.createMany({ data: before.matches.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt) })) });
      for (const row of before.notifications) await tx.notification.update({ where: { id: row.id }, data: { status: row.status } });
      await tx.$executeRaw`UPDATE "DuplicateMerge" SET "undoneAt" = CURRENT_TIMESTAMP WHERE id = ${id}`;
      return { ok: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
  } catch (error: unknown) {
    if (isDuplicateWriteConflict(error)) return { ok: false, reason: "state-changed" };
    throw error;
  }
};
