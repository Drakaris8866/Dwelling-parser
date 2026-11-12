ALTER TABLE "Listing" ADD COLUMN "routeStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "routeError" TEXT,
  ADD COLUMN "routeAttemptedAt" TIMESTAMP(3);
ALTER TABLE "Property" ADD COLUMN "assessmentError" TEXT,
  ADD COLUMN "assessmentAttemptedAt" TIMESTAMP(3);
UPDATE "Listing" SET "routeStatus" = 'READY'
WHERE jsonb_typeof("routeData"->'target') = 'object';
