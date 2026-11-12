-- Retain merge provenance independently from property lifetime. No existing rows change.
CREATE TABLE "DuplicateMerge" (
  "id" TEXT NOT NULL,
  "primaryId" TEXT NOT NULL,
  "secondaryId" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "before" JSONB NOT NULL,
  "after" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMP(3),
  CONSTRAINT "DuplicateMerge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DuplicateMerge_primaryId_createdAt_idx" ON "DuplicateMerge"("primaryId", "createdAt");
CREATE INDEX "DuplicateMerge_secondaryId_createdAt_idx" ON "DuplicateMerge"("secondaryId", "createdAt");
