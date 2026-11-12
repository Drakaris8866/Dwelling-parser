import "dotenv/config";
import pino from "pino";
import { loadConfig } from "../config/env.js";
import { createPrismaConnection } from "../infrastructure/db/prisma.js";
import { RoutingService } from "../services/routingService.js";

type BackfillStats = {
  processed: number;
  updated: number;
  failed: number;
};

const REQUEST_DELAY_MS = 100;

const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: {
    service: "transit-backfill"
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

const main = async (): Promise<void> => {
  const config = loadConfig();
  const connection = createPrismaConnection(config);
  const routingService = new RoutingService(logger);

  try {
    const listings = await connection.prisma.listing.findMany({
      where: {
        OR: [{ timeToTargetTransit: null }, { targetTransitSummary: null }],
        latitude: {
          not: null
        },
        longitude: {
          not: null
        }
      },
      select: {
        id: true,
        platform: true,
        externalId: true,
        latitude: true,
        longitude: true
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    console.log(`Found ${listings.length} listings to process.`);

    const stats: BackfillStats = {
      processed: 0,
      updated: 0,
      failed: 0
    };

    for (const [index, listing] of listings.entries()) {
      const progress = `${index + 1}/${listings.length}`;

      try {
        if (listing.latitude === null || listing.longitude === null) {
          stats.failed += 1;
          console.log(`Processing [${progress}] ID: ${listing.id}... Failed: missing coordinates`);
          await delay(REQUEST_DELAY_MS);
          continue;
        }

        const lat = Number(listing.latitude);
        const lon = Number(listing.longitude);
        const transitRoute = await routingService.getTransitRouteToTarget(lat, lon);
        stats.processed += 1;

        if (transitRoute === null) {
          stats.failed += 1;
          console.log(`Processing [${progress}] ID: ${listing.id}... Failed: no OTP route`);
          await delay(REQUEST_DELAY_MS);
          continue;
        }

        await connection.prisma.listing.update({
          where: {
            id: listing.id
          },
          data: {
            timeToTargetTransit: transitRoute.durationMinutes,
            targetTransitSummary: transitRoute.summary
          }
        });

        stats.updated += 1;
        console.log(`Processing [${progress}] ID: ${listing.id}... Success: ${transitRoute.durationMinutes} min`);
      } catch (error: unknown) {
        stats.processed += 1;
        stats.failed += 1;
        logger.error(
          {
            err: serializeError(error),
            listingId: listing.id,
            platform: listing.platform,
            externalId: listing.externalId
          },
          "Failed to backfill listing transit time"
        );
        console.log(`Processing [${progress}] ID: ${listing.id}... Failed: ${errorMessage(error)}`);
      }

      await delay(REQUEST_DELAY_MS);
    }

    console.log(
      `Backfill complete. Total processed: ${stats.processed}, successful updates: ${stats.updated}, failures: ${stats.failed}.`
    );
  } finally {
    await connection.close();
  }
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const serializeError = (error: unknown): Readonly<Record<string, unknown>> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return { value: String(error) };
};

main().catch((error: unknown) => {
  logger.error({ err: serializeError(error) }, "Transit backfill failed");
  process.exitCode = 1;
});
