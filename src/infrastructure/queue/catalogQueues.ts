import type { PgBoss, JobWithMetadata, Queue } from "pg-boss";
import type { Logger } from "../logger.js";

const HEARTBEAT_SECONDS = 60;
export const CATALOG_QUEUE_NAMES = ["collect-kufar", "collect-onliner", "collect-realt", "enrich-kufar", "enrich-onliner", "enrich-realt", "duplicate", "duplicate-audit", "route", "route-refresh", "assess", "notify", "photo-repair"] as const;
const optionsFor = (name: string): Omit<Queue, "name"> => ({
  policy: name.startsWith("enrich-") || name === "photo-repair" || name === "duplicate" ? "stately" : "singleton", retryLimit: name === "photo-repair" ? 1 : name.startsWith("collect-") ? 2 : 3,
  retryDelay: 30, retryBackoff: true, expireInSeconds: 7200, heartbeatSeconds: HEARTBEAT_SECONDS
});

export const compactAssessments = async (boss: PgBoss): Promise<void> => {
  const pending = await boss.findJobs<unknown>("assess", { queued: true, limit: 10000 });
  if (pending.length > 1) await boss.cancel("assess", pending.slice(1).map((job) => job.id));
};

export const configureCatalogQueues = async (boss: PgBoss, logger: Logger): Promise<boolean> => {
  const instances = await boss.getInstances();
  let repaired = 0, recovered = 0;
  let deferred = false;
  const names = [...CATALOG_QUEUE_NAMES, ...(await boss.getQueue("enrich") ? ["enrich"] : [])];
  for (const name of names) {
    const options = optionsFor(name);
    await boss.createQueue(name, options);
    const { policy: _policy, ...mutable } = options;
    await boss.updateQueue(name, mutable);
    let after: string | undefined;
    do {
      const jobs: JobWithMetadata<unknown>[] = await boss.findJobs<unknown>(name, { limit: 500, ...(after ? { after } : {}) });
      for (const job of jobs) {
        if ((job.state === "created" || job.state === "retry") && job.heartbeatSeconds !== HEARTBEAT_SECONDS) {
          await boss.update(name, undefined, { id: job.id, heartbeatSeconds: HEARTBEAT_SECONDS }); repaired++;
        }
        // Old jobs without a heartbeat cannot be reclaimed by heartbeat supervision. Never
        // reclaim one while another live instance has a worker for this queue.
        const ownerCouldBeAlive = instances.some((instance) => instance.live && instance.workers.some((worker) => worker.queue === name && worker.active > 0));
        if (job.state === "active" && job.heartbeatSeconds === null) {
          if (ownerCouldBeAlive || job.startedOn.getTime() >= Date.now() - 120_000) { deferred = true; continue; }
          await boss.fail(name, job, { message: "Recovered abandoned legacy job without heartbeat" });
          await boss.retry(name, job.id);
          await boss.update(name, undefined, { id: job.id, heartbeatSeconds: HEARTBEAT_SECONDS, startAfter: new Date() });
          recovered++;
        }
      }
      after = jobs.length === 500 ? jobs.at(-1)!.id : undefined;
    } while (after);
  }
  await compactAssessments(boss);
  // Run expiry supervision now, not after the default daily maintenance interval.
  for (const name of CATALOG_QUEUE_NAMES) await boss.supervise(name);
  logger.info({ repaired, recovered }, "Catalog queue configuration and recovery completed");
  return deferred;
};
