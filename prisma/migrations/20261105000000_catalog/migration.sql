-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "address" TEXT,
ADD COLUMN     "balcony" BOOLEAN,
ADD COLUMN     "bathroom" TEXT,
ADD COLUMN     "buildingMaterial" TEXT,
ADD COLUMN     "buildingYear" INTEGER,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "disposition" TEXT NOT NULL DEFAULT 'REVIEW',
ADD COLUMN     "district" TEXT,
ADD COLUMN     "elevator" BOOLEAN,
ADD COLUMN     "enrichedAt" TIMESTAMP(3),
ADD COLUMN     "enrichmentStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "exclusionReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "features" JSONB,
ADD COLUMN     "floor" INTEGER,
ADD COLUMN     "isRepresentative" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isStudio" BOOLEAN,
ADD COLUMN     "kitchenSqm" DOUBLE PRECISION,
ADD COLUMN     "lastCompleteMissAt" TIMESTAMP(3),
ADD COLUMN     "layoutType" TEXT,
ADD COLUMN     "livingSqm" DOUBLE PRECISION,
ADD COLUMN     "locality" TEXT,
ADD COLUMN     "marketZone" TEXT,
ADD COLUMN     "missedCompleteRuns" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "observedRunId" TEXT,
ADD COLUMN     "propertyId" TEXT,
ADD COLUMN     "readiness" TEXT,
ADD COLUMN     "repairCategory" TEXT,
ADD COLUMN     "routeData" JSONB,
ADD COLUMN     "sellerType" TEXT,
ADD COLUMN     "totalFloors" INTEGER,
ALTER COLUMN "lastSeenAt" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "priceByn" SET DATA TYPE DECIMAL(12,2);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assessment" (
    "propertyId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "valueScore" DOUBLE PRECISION,
    "comfortScore" DOUBLE PRECISION,
    "coverage" DOUBLE PRECISION NOT NULL,
    "discountPct" DOUBLE PRECISION,
    "medianPriceSqm" DOUBLE PRECISION,
    "confidence" TEXT NOT NULL,
    "comparableCount" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("propertyId")
);

-- CreateTable
CREATE TABLE "SourceSyncRun" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "scopeVersion" TEXT NOT NULL DEFAULT 'minsk-district-v1',
    "checkpoint" JSONB,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "received" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "review" INTEGER NOT NULL DEFAULT 0,
    "excluded" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "detailErrors" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SourceSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedSearch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "notifications" BOOLEAN NOT NULL DEFAULT false,
    "initializedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchMatch" (
    "searchId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "priceUsd" DECIMAL(12,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchMatch_pkey" PRIMARY KEY ("searchId","propertyId")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteCache" (
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteCache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Assessment_valueScore_idx" ON "Assessment"("valueScore");

-- CreateIndex
CREATE INDEX "Assessment_comfortScore_idx" ON "Assessment"("comfortScore");

-- CreateIndex
CREATE INDEX "SourceSyncRun_platform_startedAt_idx" ON "SourceSyncRun"("platform", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_eventKey_key" ON "Notification"("eventKey");

-- CreateIndex
CREATE INDEX "Notification_status_createdAt_idx" ON "Notification"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Listing_propertyId_isRepresentative_idx" ON "Listing"("propertyId", "isRepresentative");

-- CreateIndex
CREATE INDEX "Listing_disposition_isActive_priceUsd_idx" ON "Listing"("disposition", "isActive", "priceUsd");

-- CreateIndex
CREATE INDEX "Listing_marketZone_rooms_isStudio_latitude_longitude_idx" ON "Listing"("marketZone", "rooms", "isStudio", "latitude", "longitude");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchMatch" ADD CONSTRAINT "SearchMatch_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "SavedSearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "SavedSearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
