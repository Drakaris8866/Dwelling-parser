import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { createLogger } from "../infrastructure/logger.js";
import { createPrismaConnection } from "../infrastructure/db/prisma.js";
import { RetryHttpClient } from "../infrastructure/http/retryHttpClient.js";
import { PlaywrightBrowserFactory } from "../infrastructure/browser/playwrightBrowserFactory.js";
import { CollectionArea } from "../infrastructure/geo/collectionArea.js";
import { CatalogRepository, rowToCandidate } from "../infrastructure/repositories/catalogRepository.js";
import { KufarClient } from "../infrastructure/sources/kufarClient.js";
import { OnlinerClient } from "../infrastructure/sources/onlinerClient.js";
import { RealtScraper } from "../infrastructure/sources/realtScraper.js";
import { normalizeCandidate } from "../services/listingNormalization.js";
import { propertyTypeFromDescription } from "../utils/listingIntent.js";
import { featuresSchema, platformSchema } from "../contracts/catalog.js";

const config = loadConfig(), logger = createLogger(config);
const main = async (): Promise<void> => {
  const connection = createPrismaConnection(config), repository = new CatalogRepository(connection.prisma), area = await CollectionArea.load();
  const http = new RetryHttpClient(logger), sources = [new KufarClient(config, http, logger), new OnlinerClient(config, http, logger), new RealtScraper(config, new PlaywrightBrowserFactory(config, logger), logger, http)];
  let processed = 0, failed = 0;
  try {
    const platform = process.argv.find((value) => value.startsWith("--platform="))?.split("=")[1];
    const bounds = area.minskWorldBounds();
    const rows = await connection.prisma.listing.findMany({ where: {
      ...(platform ? { platform: platformSchema.parse(platform) } : {}),
      ...(process.argv.includes("--complex-only") ? { disposition: { not: "EXCLUDED" }, latitude: { gte: bounds.south, lte: bounds.north }, longitude: { gte: bounds.west, lte: bounds.east } } : {}),
      ...(process.argv.includes("--geography-only") ? { OR: [{ locality: null }, ...["Беларус", "област", "Савет", "совет", "council"].map((contains) => ({ locality: { contains, mode: "insensitive" as const } }))] } : {})
    },
      include: { priceHistory: { orderBy: { observedAt: "desc" }, take: 1 } }
    });
    for (const row of rows) {
      try {
        const source = sources.find((s) => s.platform === row.platform);
        let candidate = source?.normalizeStored(row.sourcePayload) ?? rowToCandidate(row);
        if (row.platform === "ONLINER") {
          const description = candidate.description || row.description;
          candidate = { ...candidate, description, features: featuresSchema.parse({ ...candidate.features,
            propertyType: propertyTypeFromDescription(candidate.title, description, candidate.features?.address),
            provenance: { ...candidate.features?.provenance, propertyType: "description" }
          }) };
        }
        await repository.observe(normalizeCandidate(candidate, area), undefined, { recordObservation: false });
        // Recovery is opt-in and uses only actual recorded observations, never publication timestamps.
        if (process.argv.includes("--restore-confirmed-observations") && row.observedRunId === null && row.priceHistory[0] && row.lastSeenAt > row.priceHistory[0].observedAt) {
          await connection.prisma.listing.update({ where: { id: row.id }, data: { lastSeenAt: row.priceHistory[0].observedAt } });
        }
        processed++;
        if (processed % 250 === 0) logger.info({ processed, total: rows.length, failed }, "Stored catalog normalization progress");
      } catch (error: unknown) { failed++; logger.error({ err: error, listingId: row.id }, "Stored listing normalization failed"); }
    }
    logger.info({ processed, failed }, "Stored catalog normalized without network requests");
  } finally { await connection.close(); }
};
void main().catch((error: unknown) => { logger.error({ err: error }, "Catalog normalization failed"); process.exitCode = 1; });
