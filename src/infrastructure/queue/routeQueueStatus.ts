import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import type { CatalogItem, RouteQueueStatus } from "../../contracts/catalog.js";

type QueueRow = { listingId: string; position: number; active: number; secondsPerJob: number | null };

export async function routeQueueStatus(db: PrismaClient, items: readonly CatalogItem[]): Promise<Map<string, RouteQueueStatus>> {
  const ids = items.filter((item) => item.processing?.route.state === "pending").map((item) => item.listingId);
  if (!ids.length) return new Map();
  const rows = await db.$queryRaw<QueueRow[]>`
    WITH active AS (
      SELECT singleton_key FROM pgboss.job WHERE name = 'route' AND state = 'active'
    ), eligible AS (
      SELECT DISTINCT ON (singleton_key) singleton_key, priority, created_on, id
      FROM pgboss.job j WHERE j.name = 'route' AND j.state IN ('created','retry')
        AND j.start_after <= now() AND j.singleton_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM active a WHERE a.singleton_key = j.singleton_key)
      ORDER BY singleton_key, priority DESC, created_on, id
    ), ranked AS (
      SELECT singleton_key, row_number() OVER (ORDER BY priority DESC, created_on, id)::int AS position FROM eligible
    ), recent AS (
      SELECT completed_on FROM pgboss.job WHERE name = 'route' AND state = 'completed'
        AND completed_on > now() - interval '15 minutes' ORDER BY completed_on DESC LIMIT 60
    ), rate AS (
      SELECT CASE WHEN count(*) >= 8 AND max(completed_on) > now() - interval '2 minutes'
        THEN greatest(1, extract(epoch FROM max(completed_on) - min(completed_on)) / (count(*) - 1))::float8 END AS seconds
      FROM recent
    )
    SELECT ranked.singleton_key AS "listingId", ranked.position, (SELECT count(*)::int FROM active) AS active,
      rate.seconds AS "secondsPerJob" FROM ranked CROSS JOIN rate WHERE ranked.singleton_key IN (${Prisma.join(ids)})`;
  return new Map(rows.map(({ listingId, position, active, secondsPerJob }) => [listingId, {
    position, estimatedSeconds: secondsPerJob === null ? null : Math.ceil((position + active) * secondsPerJob)
  }]));
}
