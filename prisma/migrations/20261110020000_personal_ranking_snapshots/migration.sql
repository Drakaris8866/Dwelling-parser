CREATE TABLE "PersonalRankingSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "PersonalRankingSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "propertyId" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PersonalRankingSnapshot_propertyId_inputHash_key" ON "PersonalRankingSnapshot"("propertyId", "inputHash");
CREATE INDEX "PersonalRankingSnapshot_propertyId_calculatedAt_idx" ON "PersonalRankingSnapshot"("propertyId", "calculatedAt");
