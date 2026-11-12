-- CreateTable
CREATE TABLE "ShadowRanking" (
    "propertyId" TEXT NOT NULL,
    "rankingVersion" INTEGER NOT NULL,
    "score" DOUBLE PRECISION,
    "asIsScore" DOUBLE PRECISION,
    "asIsDiscountPct" DOUBLE PRECISION,
    "totalUsdLow" DOUBLE PRECISION,
    "totalUsdBase" DOUBLE PRECISION,
    "totalUsdHigh" DOUBLE PRECISION,
    "coverage" DOUBLE PRECISION NOT NULL,
    "provisional" BOOLEAN NOT NULL,
    "reason" TEXT,
    "breakdown" JSONB NOT NULL,
    "settingsKey" TEXT NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShadowRanking_pkey" PRIMARY KEY ("propertyId")
);

-- CreateIndex
CREATE INDEX "ShadowRanking_score_idx" ON "ShadowRanking"("score");

-- CreateIndex
CREATE INDEX "ShadowRanking_provisional_score_idx" ON "ShadowRanking"("provisional", "score");

-- AddForeignKey
ALTER TABLE "ShadowRanking" ADD CONSTRAINT "ShadowRanking_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
