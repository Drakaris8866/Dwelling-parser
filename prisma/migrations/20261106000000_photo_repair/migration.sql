ALTER TABLE "Listing" ADD COLUMN "photoSetHash" TEXT;
ALTER TABLE "Property" ADD COLUMN "renovationBudgetUsd" DECIMAL(12,2), ADD COLUMN "assessmentRevision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "PhotoRepairAnalysis" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "listingId" TEXT NOT NULL UNIQUE REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "galleryHash" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "modelDigest" TEXT,
  "promptVersion" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "decision" TEXT NOT NULL DEFAULT 'PENDING',
  "suggestion" TEXT,
  "evidence" JSONB,
  "message" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
