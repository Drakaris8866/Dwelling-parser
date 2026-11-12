-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('KUFAR', 'ONLINER', 'REALT');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('SENT', 'FAILED');

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rooms" INTEGER NOT NULL,
    "areaSqm" DECIMAL(8,2) NOT NULL,
    "priceUsd" DECIMAL(12,2) NOT NULL,
    "pricePerSqm" DECIMAL(10,2) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "photos" TEXT[],
    "houseType" TEXT,
    "buildingSeries" TEXT,
    "repairState" TEXT,
    "sourcePayload" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "priceChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "priceUsd" DECIMAL(12,2) NOT NULL,
    "pricePerSqm" DECIMAL(10,2) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoCache" (
    "id" TEXT NOT NULL,
    "roundedLat" DECIMAL(7,4) NOT NULL,
    "roundedLon" DECIMAL(7,4) NOT NULL,
    "nearestMetro" TEXT NOT NULL,
    "accessMode" TEXT NOT NULL,
    "accessMinutes" INTEGER NOT NULL,
    "walkingMinutes" INTEGER NOT NULL,
    "walkingMeters" INTEGER NOT NULL,
    "straightLineMeters" INTEGER NOT NULL,
    "transitMinutes" INTEGER,
    "provider" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "fairPriceSqm" DECIMAL(10,2) NOT NULL,
    "actualPriceSqm" DECIMAL(10,2) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL,
    "status" "AlertStatus" NOT NULL,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Listing_platform_externalId_idx" ON "Listing"("platform", "externalId");

-- CreateIndex
CREATE INDEX "Listing_rooms_isActive_lastSeenAt_idx" ON "Listing"("rooms", "isActive", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Listing_pricePerSqm_idx" ON "Listing"("pricePerSqm");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_platform_externalId_key" ON "Listing"("platform", "externalId");

-- CreateIndex
CREATE INDEX "PriceHistory_listingId_observedAt_idx" ON "PriceHistory"("listingId", "observedAt");

-- CreateIndex
CREATE INDEX "GeoCache_expiresAt_idx" ON "GeoCache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GeoCache_roundedLat_roundedLon_key" ON "GeoCache"("roundedLat", "roundedLon");

-- CreateIndex
CREATE INDEX "Alert_listingId_createdAt_idx" ON "Alert"("listingId", "createdAt");

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
