import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import type { CatalogHealth } from "../../contracts/catalog.js";
import { CATALOG_QUEUE_NAMES } from "./catalogQueues.js";

export async function backgroundTasks(db: PrismaClient): Promise<CatalogHealth["tasks"]> {
  return db.$queryRaw<CatalogHealth["tasks"]>`
    SELECT name, count(*) FILTER (WHERE state = 'active')::int AS active,
      count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS queued
    FROM pgboss.job
    WHERE name IN (${Prisma.join([...CATALOG_QUEUE_NAMES, "enrich"])})
      AND state IN ('created', 'retry', 'active')
    GROUP BY name
    ORDER BY active DESC, queued DESC, name
  `;
}
