import "dotenv/config";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./infrastructure/logger.js";
import { createPrismaConnection } from "./infrastructure/db/prisma.js";
import { RetryHttpClient } from "./infrastructure/http/retryHttpClient.js";
import { PlaywrightBrowserFactory } from "./infrastructure/browser/playwrightBrowserFactory.js";
import { CollectionArea } from "./infrastructure/geo/collectionArea.js";
import { CatalogRepository } from "./infrastructure/repositories/catalogRepository.js";
import { KufarClient } from "./infrastructure/sources/kufarClient.js";
import { OnlinerClient } from "./infrastructure/sources/onlinerClient.js";
import { RealtScraper } from "./infrastructure/sources/realtScraper.js";
import { CatalogAssessmentService } from "./services/catalogAssessmentService.js";
import { CatalogTelegramService } from "./services/catalogTelegramService.js";
import { DuplicateService } from "./services/duplicateService.js";
import { SavedSearchService } from "./services/savedSearchService.js";
import { CatalogWorker } from "./services/catalogWorker.js";
import { RoutingService } from "./services/routingService.js";
import { createApi } from "./api/app.js";
import { PhotoRepairService } from "./services/photoRepairService.js";
import { ListingPhotos } from "./infrastructure/vision/listingPhotos.js";
import { OllamaVision } from "./infrastructure/vision/ollamaVision.js";

const config = loadConfig();
const logger = createLogger(config);
const main = async (): Promise<void> => {
  const connection = createPrismaConnection(config);
  const http = new RetryHttpClient(logger);
  const repository = new CatalogRepository(connection.prisma);
  const sources = [new KufarClient(config, http, logger), new OnlinerClient(config, http, logger),
    new RealtScraper(config, new PlaywrightBrowserFactory(config, logger), logger, http)];
  const routing = new RoutingService(logger, connection.prisma);
  const photoRepair = new PhotoRepairService(connection.prisma, new ListingPhotos(http), logger,
    process.env["PHOTO_REPAIR_ENABLED"] === "true" ? new OllamaVision(http) : undefined);
  const worker = new CatalogWorker(config.databaseUrl, sources, repository, await CollectionArea.load(), routing,
    new CatalogAssessmentService(repository, logger), new DuplicateService(repository, http, logger),
    new SavedSearchService(repository, new CatalogTelegramService(config, http, logger), logger), logger, photoRepair);
  const app = await createApi({ repository, worker, photoRepair });
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Catalog shutdown requested");
    await app.close();
    http.close();
    await worker.stop();
    await connection.close();
  };
  process.once("SIGINT", () => { void shutdown("SIGINT").catch((err: unknown) => logger.error({ err }, "Shutdown failed")); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM").catch((err: unknown) => logger.error({ err }, "Shutdown failed")); });
  try {
    await worker.start();
    const port = Number(process.env["CATALOG_PORT"] ?? 3000);
    await app.listen({ host: "127.0.0.1", port });
    logger.info({ url: `http://127.0.0.1:${port}` }, "Local apartment catalog ready");
  } catch (error: unknown) { await shutdown("startup-failure"); throw error; }
};
void main().catch((error: unknown) => { logger.fatal({ err: error }, "Catalog startup failed"); process.exitCode = 1; });
