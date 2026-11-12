import { PgBoss } from "pg-boss";
import { z } from "zod";
import { featuresSchema, platformSchema, routingDataSchema } from "../contracts/catalog.js";
import type { Listing } from "../generated/prisma/client.js";
import type { ListingCandidate } from "../domain/listing.js";
import type { CatalogSource, SourceCheckpoint } from "../infrastructure/sources/catalogSource.js";
import { HttpRequestError } from "../infrastructure/http/retryHttpClient.js";
import type { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import { rowToCandidate } from "../infrastructure/repositories/catalogRepository.js";
import type { CollectionArea } from "../infrastructure/geo/collectionArea.js";
import type { CatalogAssessmentService } from "./catalogAssessmentService.js";
import type { RoutingService } from "./routingService.js";
import { commuteDate } from "./routingService.js";
import { canCheckDuplicate, type DuplicateService } from "./duplicateService.js";
import type { SavedSearchService } from "./savedSearchService.js";
import type { Logger } from "../infrastructure/logger.js";
import { routeSummary } from "../utils/listingFeatures.js";
import { toPrismaJson } from "../utils/json.js";
import { normalizeCandidate } from "./listingNormalization.js";
import { ListingLifecycleService } from "./listingLifecycleService.js";
import { configureCatalogQueues, compactAssessments } from "../infrastructure/queue/catalogQueues.js";
import { COMMUTE_VERSION } from "../domain/commutePolicy.js";
import type { PhotoRepairService } from "./photoRepairService.js";
import { scanDuplicateAudit } from "./duplicateAuditService.js";
import type { DuplicatePair } from "../contracts/duplicateAudit.js";
import type { DuplicateMergeSummary, DuplicateUndoResult } from "../contracts/duplicateMerge.js";

const collectJob = z.object({ platform: platformSchema, kind: z.enum(["FULL", "INCREMENTAL"]).default("FULL") });
const listingJob = z.object({ listingId: z.string() });
const checkpointSchema = z.object({ page: z.number().int().positive(), cursor: z.string().optional(), seen: z.array(z.string()).default([]) });
const mayEnrich = (row: Listing): boolean => {
  if (row.disposition !== "EXCLUDED") return true;
  const parsed = featuresSchema.safeParse(row.features);
  return parsed.success && parsed.data.inCollectionArea === true && parsed.data.propertyType === "apartment"
    && parsed.data.ownership !== "partial" && parsed.data.dealType !== "rent" && !row.exclusionReasons.includes("ЖК Минск-Мир");
};

export class CatalogWorker {
  readonly boss: PgBoss;
  private legacyRecoveryPending = false;
  constructor(databaseUrl: string, private readonly sources: readonly CatalogSource[], private readonly repository: CatalogRepository,
    private readonly area: CollectionArea, private readonly routing: RoutingService, private readonly assessment: CatalogAssessmentService,
    private readonly duplicates: DuplicateService, private readonly searches: SavedSearchService, private readonly logger: Logger, private readonly photoRepair?: PhotoRepairService) {
    this.boss = new PgBoss({ connectionString: databaseUrl, application_name: "dwelling-catalog", maintenanceIntervalSeconds: 30, superviseIntervalSeconds: 30 });
    this.boss.on("error", (error) => this.logger.error({ err: error }, "Background queue error"));
  }
  async start(): Promise<void> {
    await this.repository.invalidateLegacyCommutes(COMMUTE_VERSION);
    await this.boss.start();
    this.legacyRecoveryPending = await configureCatalogQueues(this.boss, this.logger);
    await this.migrateLegacyEnrichmentQueue();
    for (const source of this.sources) {
      const queue = `collect-${source.platform.toLowerCase()}`;
      await this.boss.work<unknown, void>(queue, { localConcurrency: 1 }, async (jobs) => {
        for (const job of jobs) { const payload = collectJob.parse(job.data); await this.collect(source, payload.kind); }
      });
      await this.boss.schedule(queue, source.platform === "REALT" ? "*/30 * * * *" : "*/10 * * * *", { platform: source.platform, kind: "INCREMENTAL" }, { key: "incremental", singletonKey: source.platform, tz: "Europe/Minsk" });
      await this.boss.schedule(queue, "0 3 * * *", { platform: source.platform, kind: "FULL" }, { key: "full", singletonKey: source.platform, tz: "Europe/Minsk" });
      await this.boss.send(queue, { platform: source.platform, kind: "FULL" }, { singletonKey: source.platform });
    }
    for (const source of this.sources) await this.boss.work<unknown, void>(`enrich-${source.platform.toLowerCase()}`, { localConcurrency: 1 }, async (jobs) => { for (const job of jobs) await this.enrich(listingJob.parse(job.data).listingId); });
    await this.boss.work<unknown, void>("duplicate", { localConcurrency: 10 }, async (jobs) => {
      for (const job of jobs) {
        const row = await this.repository.prisma.listing.findUnique({ where: { id: listingJob.parse(job.data).listingId } });
        if (row && await this.duplicates.checkAndPublish(row, job.signal)) await this.requestAssessment();
      }
    });
    await this.boss.work<unknown, void>("duplicate-audit", { localConcurrency: 1 }, async (jobs) => {
      const result = await scanDuplicateAudit(this.repository.prisma, jobs[0]?.signal);
      this.logger.info(result, "Catalog duplicate audit completed");
    });
    await this.boss.schedule("duplicate-audit", "15 */6 * * *", {}, { singletonKey: "all", tz: "Europe/Minsk" });
    await this.requestDuplicateAudit();
    await this.boss.work<unknown, void>("route", { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async (jobs) => { for (const job of jobs) await this.route(listingJob.parse(job.data).listingId, job.signal); });
    await this.boss.work<unknown, void>("route-refresh", { localConcurrency: 1 }, async () => {
      await Promise.all([this.enqueueMissingRoutes(), this.enqueuePendingDuplicateChecks()]);
    });
    if (this.photoRepair) await this.boss.work<unknown, void>("photo-repair", { localConcurrency: 1 }, async (jobs) => {
      for (const job of jobs) await this.photoRepair!.run(z.object({ id: z.string().uuid() }).parse(job.data).id, job.signal);
    });
    await this.boss.work<unknown, void>("assess", { localConcurrency: 1 }, async (jobs) => {
      await compactAssessments(this.boss);
      const ready = await this.assessment.reassessAll(jobs[0]?.signal);
      if (ready) await this.searches.evaluate();
    });
    await this.boss.work<unknown, void>("notify", { localConcurrency: 1 }, async () => {
      if (this.legacyRecoveryPending) this.legacyRecoveryPending = await configureCatalogQueues(this.boss, this.logger);
      await this.migrateLegacyEnrichmentQueue(); await this.searches.deliver();
    });
    await this.boss.schedule("assess", "*/5 * * * *", {}, { singletonKey: "all" });
    await this.boss.schedule("notify", "* * * * *", {}, { singletonKey: "all" });
    await this.boss.schedule("route-refresh", "*/5 * * * *", {}, { singletonKey: "all" });
    await this.bootstrapLegacy();
    await this.enqueuePendingDuplicateChecks();
    await this.refreshRoutes();
    this.logger.info("Catalog scheduler started");
  }
  async stop(): Promise<void> { await this.boss.stop({ graceful: true, timeout: 10_000 }); }
  async requestAssessment(): Promise<void> { await this.boss.upsert("assess", {}, { singletonKey: "all", heartbeatSeconds: 60 }); }
  async requestPhotoRepair(id: string): Promise<void> { await this.boss.upsert("photo-repair", { id }, { singletonKey: id, heartbeatSeconds: 60 }); }
  async requestDuplicateAudit(): Promise<void> { await this.boss.upsert("duplicate-audit", {}, { singletonKey: "all", heartbeatSeconds: 60 }); }
  async listDuplicateMerges(propertyId: string): Promise<DuplicateMergeSummary[]> { return this.duplicates.listMerges(propertyId); }
  async undoDuplicateMerge(id: string): Promise<DuplicateUndoResult> { return this.duplicates.undoMerge(id); }
  async confirmDuplicate(pair: DuplicatePair): Promise<boolean> {
    const rows = await this.repository.prisma.listing.findMany({ where: { id: { in: [pair.left.listingId, pair.right.listingId] }, isActive: true, disposition: "ACCEPTED" } });
    const left = rows.find((row) => row.id === pair.left.listingId && row.propertyId === pair.left.propertyId && row.contentHash === pair.left.contentHash);
    const right = rows.find((row) => row.id === pair.right.listingId && row.propertyId === pair.right.propertyId && row.contentHash === pair.right.contentHash);
    if (!left || !right || left.propertyId === right.propertyId) return false;
    const merged = await this.duplicates.reconcile(left, AbortSignal.timeout(25_000), { candidateSnapshot: right });
    if (merged) { await this.requestAssessment(); await this.requestDuplicateAudit(); }
    return merged;
  }
  private async queueDuplicate(row: Listing): Promise<void> {
    if (!canCheckDuplicate(row)) return;
    await this.boss.upsert("duplicate", { listingId: row.id }, {
      singletonKey: row.id, heartbeatSeconds: 60, ...(row.duplicateCheckPending ? { priority: 10 } : {})
    });
  }
  private async enqueuePendingDuplicateChecks(): Promise<void> {
    const rows = await this.repository.prisma.listing.findMany({ where: {
      duplicateCheckPending: true, isActive: true, disposition: "ACCEPTED", locality: { not: null }, floor: { not: null }
    } });
    for (const row of rows) await this.queueDuplicate(row);
  }
  async refreshRoutes(): Promise<void> {
    await this.boss.upsert("route-refresh", {}, { singletonKey: "all", heartbeatSeconds: 60 });
  }
  async prioritizeRoute(listingId: string): Promise<void> {
    await this.repository.prisma.listing.updateMany({ where: { id: listingId, routeStatus: { not: "RUNNING" } }, data: { routeStatus: "PENDING", routeError: null } });
    await this.boss.upsert("route", { listingId }, { singletonKey: listingId, priority: 10, startAfter: new Date(), heartbeatSeconds: 60 });
  }
  private async enqueueMissingRoutes(): Promise<void> {
    let after: string | undefined;
    do {
      const rows: Listing[] = await this.repository.prisma.listing.findMany({ where: { isActive: true, disposition: { not: "EXCLUDED" }, latitude: { not: null }, longitude: { not: null } },
        orderBy: { id: "asc" }, take: 200, ...(after ? { cursor: { id: after }, skip: 1 } : {}) });
      for (const row of rows) await this.queueRouteIfNeeded(row);
      after = rows.length === 200 ? rows.at(-1)!.id : undefined;
    } while (after);
  }
  private async queueRouteIfNeeded(row: Listing): Promise<void> {
    if (row.disposition === "EXCLUDED" || row.latitude === null || row.longitude === null) return;
    const parsed = routingDataSchema.safeParse(row.routeData);
    if (row.routeStatus === "READY" && parsed.success && parsed.data.policyVersion === COMMUTE_VERSION && parsed.data.target?.date === commuteDate() && parsed.data.metroStatus !== "FAILED" && !parsed.data.alternativesIncomplete) return;
    if (["FAILED", "NO_ROUTE", "READY"].includes(row.routeStatus) && row.routeAttemptedAt && row.routeAttemptedAt.getTime() > Date.now() - 15 * 60_000) return;
    await this.boss.upsert("route", { listingId: row.id }, { singletonKey: row.id, heartbeatSeconds: 60 });
  }
  async syncNow(): Promise<void> {
    for (const source of this.sources) await this.boss.send(`collect-${source.platform.toLowerCase()}`, { platform: source.platform, kind: "FULL" }, { singletonKey: source.platform });
  }
  private async migrateLegacyEnrichmentQueue(): Promise<void> {
    if (!(await this.boss.getQueue("enrich"))) return;
    const jobs = (await this.boss.findJobs<unknown>("enrich", { queued: true })).slice(0, 200);
    for (const job of jobs) {
      const data = listingJob.safeParse(job.data);
      if (!data.success) continue;
      const row = await this.repository.prisma.listing.findUnique({ where: { id: data.data.listingId }, select: { platform: true } });
      if (row) await this.boss.send(`enrich-${row.platform.toLowerCase()}`, data.data, { singletonKey: data.data.listingId });
      await this.boss.cancel("enrich", job.id);
    }
  }
  private prepare(candidate: ListingCandidate): ListingCandidate {
    return normalizeCandidate(candidate, this.area);
  }
  private async collect(source: CatalogSource, kind: "FULL" | "INCREMENTAL"): Promise<void> {
    const prior = await this.repository.prisma.sourceSyncRun.findFirst({ where: { platform: source.platform, kind, status: { in: ["RUNNING", "PARTIAL"] } }, orderBy: { startedAt: "desc" } });
    const run = prior ?? await this.repository.prisma.sourceSyncRun.create({ data: { platform: source.platform, kind } });
    const parsed = checkpointSchema.safeParse(run.checkpoint);
    let checkpoint: SourceCheckpoint = parsed.success ? parsed.data : { page: 1 };
    const seen = new Set(parsed.success ? parsed.data.seen : []);
    const reasonCounts: Record<string, number> = {};
    await this.repository.prisma.sourceSyncRun.update({ where: { id: run.id }, data: { status: "RUNNING", error: null, finishedAt: null } });
    try {
      for (let guard = 0; guard < 2000; guard++) {
        const signature = checkpoint.cursor ?? `page:${checkpoint.page}`;
        if (seen.has(signature)) throw new Error("Source repeated pagination cursor");
        const page = await source.fetchCatalogPage(checkpoint);
        if (page.received === 0 && checkpoint.page === 1 && await this.repository.prisma.listing.count({ where: { platform: source.platform, isActive: true } }) > 0) throw new Error("Unexpected empty source inventory; existing records retained");
        const counts = { accepted: 0, review: 0, excluded: 0 };
        let persistenceErrors = 0;
        for (const raw of page.candidates) {
          try {
            const observed = await this.repository.observe(this.prepare(raw), run.id);
            const row = observed.listing;
            if (observed.changed || row.duplicateCheckPending) await this.queueDuplicate(row);
            await this.queueRouteIfNeeded(row);
            if (row.disposition === "ACCEPTED") counts.accepted++;
            else if (row.disposition === "REVIEW") counts.review++;
            else counts.excluded++;
            for (const reason of row.exclusionReasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
            const descriptionVerified = featuresSchema.safeParse(row.features);
            if (mayEnrich(row) && (observed.changed || !descriptionVerified.success || descriptionVerified.data.descriptionComplete !== true || !row.enrichedAt || row.enrichedAt.getTime() < Date.now() - 7 * 86400_000)) await this.boss.send(`enrich-${source.platform.toLowerCase()}`, { listingId: row.id }, { singletonKey: row.id });
          } catch (error: unknown) { persistenceErrors++; this.logger.error({ err: error, platform: source.platform, externalId: raw.externalId }, "Failed to observe listing"); }
        }
        seen.add(signature);
        await this.repository.prisma.sourceSyncRun.update({ where: { id: run.id }, data: {
          pages: { increment: 1 }, received: { increment: page.received }, invalid: { increment: page.invalid + persistenceErrors },
          accepted: { increment: counts.accepted }, review: { increment: counts.review }, excluded: { increment: counts.excluded }, reasons: toPrismaJson(reasonCounts),
          checkpoint: toPrismaJson(page.next ? { ...page.next, seen: [...seen] } : { page: checkpoint.page, seen: [...seen] }),
          ...(!page.next ? { status: "COMPLETE", finishedAt: new Date() } : {})
        } });
        if (!page.next) {
          const result = await this.repository.prisma.sourceSyncRun.update({ where: { id: run.id }, data: { status: "COMPLETE", finishedAt: new Date() } });
          if (kind === "FULL" && result.invalid === 0) await this.markMissing(source.platform, run.id);
          this.logger.info({ platform: source.platform, received: result.received, accepted: result.accepted }, "Source polling completed");
          await this.requestAssessment();
          return;
        }
        checkpoint = page.next;
      }
      throw new Error("Pagination exceeded safety bound; checkpoint retained");
    } catch (error: unknown) {
      const blocked = error instanceof HttpRequestError && [401, 403, 429].includes(error.statusCode ?? 0);
      const message = error instanceof Error ? error.message : String(error);
      const resetExpiredCursor = checkpoint.cursor !== undefined && error instanceof HttpRequestError && [400, 410].includes(error.statusCode ?? 0);
      await this.repository.prisma.sourceSyncRun.update({ where: { id: run.id }, data: { status: blocked ? "BLOCKED" : "PARTIAL", error: message, finishedAt: new Date(),
        ...(resetExpiredCursor ? { checkpoint: toPrismaJson({ page: 1, seen: [] }) } : {}) } });
      this.logger.error({ err: error, platform: source.platform, runId: run.id }, "Source collection incomplete");
      await this.requestAssessment();
      if (!blocked) throw error;
    }
  }
  private async markMissing(platform: z.infer<typeof platformSchema>, runId: string): Promise<void> {
    await new ListingLifecycleService(this.repository.prisma).completeFullRun(platform, runId);
  }
  private async enrich(id: string): Promise<void> {
    const row = await this.repository.prisma.listing.findUnique({ where: { id } });
    if (!row || !mayEnrich(row)) return;
    const features = featuresSchema.safeParse(row.features);
    if (row.enrichmentStatus === "COMPLETE" && features.success && features.data.descriptionComplete === true && row.enrichedAt && row.enrichedAt.getTime() > Date.now() - 7 * 86400_000) return;
    const source = this.sources.find((s) => s.platform === row.platform);
    if (!source) return;
    try {
      const enriched = this.prepare(await source.enrich(rowToCandidate(row)));
      const result = await this.repository.observe(enriched, undefined, { recordObservation: false, expectedHash: row.contentHash });
      if (result.listing.contentHash !== row.contentHash && !result.changed) return;
      await this.repository.prisma.listing.update({ where: { id }, data: { enrichmentStatus: "COMPLETE", enrichedAt: new Date() } });
      if (result.changed || result.listing.duplicateCheckPending) await this.queueDuplicate(result.listing);
      await this.queueRouteIfNeeded(result.listing);
    } catch (error: unknown) {
      await this.repository.prisma.listing.update({ where: { id }, data: { enrichmentStatus: "FAILED" } });
      this.logger.warn({ err: error, listingId: id }, "Listing detail enrichment failed");
      const run = await this.repository.prisma.sourceSyncRun.findFirst({ where: { platform: row.platform }, orderBy: { startedAt: "desc" } });
      if (run) await this.repository.prisma.sourceSyncRun.update({ where: { id: run.id }, data: { detailErrors: { increment: 1 } } });
      await this.queueRouteIfNeeded(row);
      throw error;
    }
  }
  private async route(id: string, signal?: AbortSignal): Promise<void> {
    const row = await this.repository.prisma.listing.findUnique({ where: { id } });
    if (!row || row.latitude === null || row.longitude === null || row.disposition === "EXCLUDED") return;
    const attemptedAt = new Date();
    await this.repository.prisma.listing.update({ where: { id }, data: { routeStatus: "RUNNING", routeError: null, routeAttemptedAt: attemptedAt } });
    try {
      const settings = await this.repository.settings();
      const routes = await this.routing.getRoutingData(Number(row.latitude), Number(row.longitude), settings);
      signal?.throwIfAborted();
      const current = await this.repository.settings();
      if (settings.targetLatitude !== current.targetLatitude || settings.targetLongitude !== current.targetLongitude || settings.arrivalTime !== current.arrivalTime) {
        await this.repository.prisma.listing.updateMany({ where: { id, routeAttemptedAt: attemptedAt }, data: { routeStatus: "PENDING" } }); return;
      }
      const routeStatus = routes.target ? "READY" : routes.targetStatus ?? "FAILED";
      await this.repository.prisma.listing.updateMany({ where: { id, latitude: row.latitude, longitude: row.longitude, routeAttemptedAt: attemptedAt }, data: { routeData: toPrismaJson(routes),
        routeStatus, routeError: routes.targetError ?? null, timeToTargetTransit: routes.target?.durationMinutes ?? null, targetTransitSummary: routes.target ? routeSummary(routes.target.legs) : null } });
      if (routeStatus === "FAILED") throw new Error(routes.targetError ?? "OTP routing failed");
      await this.requestAssessment();
    } catch (error: unknown) {
      if (!signal?.aborted) await this.repository.prisma.listing.updateMany({ where: { id, routeAttemptedAt: attemptedAt }, data: { routeStatus: "FAILED", routeError: "Ошибка расчёта OTP; будет повторная попытка" } });
      this.logger.warn({ err: error, listingId: id }, "Listing routing failed");
      throw error;
    }
  }
  private async bootstrapLegacy(): Promise<void> {
    const rows = await this.repository.prisma.listing.findMany({ where: { propertyId: null } });
    for (const row of rows) {
      try {
        const source = this.sources.find((s) => s.platform === row.platform);
        const normalized = source?.normalizeStored(row.sourcePayload) ?? rowToCandidate(row);
        const result = await this.repository.observe(this.prepare(normalized), undefined, { recordObservation: false });
        await this.boss.send(`enrich-${row.platform.toLowerCase()}`, { listingId: result.listing.id }, { singletonKey: row.id });
      }
      catch (error: unknown) { this.logger.error({ err: error, listingId: row.id }, "Legacy listing normalization failed"); }
    }
    await this.requestAssessment();
  }
}
