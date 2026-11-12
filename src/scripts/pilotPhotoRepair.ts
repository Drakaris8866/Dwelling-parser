import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { createLogger } from "../infrastructure/logger.js";
import { createPrismaConnection } from "../infrastructure/db/prisma.js";
import { RetryHttpClient } from "../infrastructure/http/retryHttpClient.js";
import { ListingPhotos } from "../infrastructure/vision/listingPhotos.js";
import { OllamaVision } from "../infrastructure/vision/ollamaVision.js";
import { analyzeListingPhotos } from "../services/analyzeListingPhotos.js";
import type { Platform, Prisma, PrismaClient } from "../generated/prisma/client.js";

const config = loadConfig(), logger = createLogger(config);
const selection = { id: true, platform: true, externalId: true, photos: true, repairCategory: true, priceUsd: true } as const;
type Sample = Prisma.ListingGetPayload<{ select: typeof selection }>;
const hasGallery = (row: Pick<Sample, "photos">): boolean => new Set(row.photos).size >= 3;
async function samples(db: PrismaClient, platform: Platform): Promise<Sample[]> {
  const where = { platform, isActive: true, isRepresentative: true, disposition: "ACCEPTED" as const, photos: { isEmpty: false } };
  const rows = await db.listing.findMany({ where, select: selection, orderBy: { lastSeenAt: "desc" }, take: 500 });
  const eligible = rows.filter(hasGallery);
  const known = ["none", "needs-repair", "cosmetic", "good"].flatMap((category) => eligible.find((row) => row.repairCategory === category) ?? []);
  const remainder = eligible.filter((row) => !known.includes(row)).sort((a, b) => a.priceUsd.cmp(b.priceUsd));
  const count = Math.min(4 - known.length, remainder.length);
  return [...known, ...Array.from({ length: count }, (_, index) => remainder[Math.floor((index + 0.5) * remainder.length / count)]!)];
}
const main = async (): Promise<void> => {
  const db = createPrismaConnection(config), http = new RetryHttpClient(logger);
  const reader = new ListingPhotos(http), inspector = new OllamaVision(http);
  let tested = 0, proposed = 0, insufficient = 0, failures = 0;
  try {
    await inspector.digest();
    for (const platform of ["KUFAR", "ONLINER", "REALT"] as const) {
      const sample: Sample[] = await samples(db.prisma, platform);
      for (const row of sample) {
        tested++;
        const started = Date.now();
        try {
          const result = await analyzeListingPhotos(row, reader, inspector, logger, AbortSignal.timeout(180_000), 3);
          if (result.suggestion) proposed++; else insufficient++;
          logger.info({ platform, externalId: row.externalId, repairCategory: row.repairCategory, suggestion: result.suggestion, scenes: result.evidence.map((photo) => photo.scene), unavailable: result.unavailable, elapsedMs: Date.now() - started }, "Photo repair pilot result");
        } catch (err: unknown) { failures++; logger.warn({ err, platform, externalId: row.externalId }, "Photo repair pilot failed for listing"); }
      }
    }
    logger.info({ tested, proposed, insufficient, failures }, "Photo repair pilot completed without database changes");
    if (tested < 10 || failures) process.exitCode = 1;
  } finally { http.close(); await db.close(); }
};
void main().catch((err: unknown) => { logger.error({ err }, "Photo repair pilot unavailable"); process.exitCode = 1; });
