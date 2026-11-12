import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import { COMMUTE_VERSION } from "../domain/commutePolicy.js";
import { PHOTO_PROMPT_VERSION } from "../contracts/photoRepair.js";
import type { Logger } from "../infrastructure/logger.js";

/**
 * Default calibration:
 * Limit: 20 best preliminary candidates placed in background queue.
 * Explore ratio: 0.20 (1 exploration slot for every 5 top candidates -> 4 exploration slots for top-20).
 *
 * Exploration slots ensure that preliminary heuristic / model errors do not permanently hide viable
 * apartments that might rank high once full routing or photo evidence is computed.
 */
export const DEFAULT_CANDIDATE_LIMIT = 20;
export const DEFAULT_EXPLORE_RATIO = 0.20;
export const ROUTE_RETRY_COOLDOWN_MS = 15 * 60_000; // 15 minutes cooldown after failure

export interface CandidateRecord {
  id: string;
  propertyId?: string | null | undefined;
  score?: number | null | undefined;
  pricePerSqm?: number | null | undefined;
  priceUsd?: number | null | undefined;
  rooms?: number | null | undefined;
  areaSqm?: number | null | undefined;
  disposition?: string | undefined;
  isActive?: boolean | undefined;
  isRepresentative?: boolean | undefined;
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
  photos?: string[] | undefined;
  photoSetHash?: string | null | undefined;
  photoRepairStatus?: string | null | undefined;
  routeStatus?: string | null | undefined;
  routeData?: unknown | undefined;
  routeAttemptedAt?: Date | null | undefined;
  routeVersion?: number | undefined;
  settingsVersion?: number | undefined;
  featuresVersion?: number | undefined;
  assessmentRevision?: number | undefined;
}

export interface TaskSignatureContext {
  photoHash?: string | null | undefined;
  routeVersion?: number | undefined;
  settingsVersion?: number | undefined;
  featuresVersion?: number | undefined;
  assessmentRevision?: number | undefined;
}

export interface CandidateQueueOptions {
  prisma?: PrismaClient | undefined;
  logger?: Logger | undefined;
  hasOllama?: boolean | undefined;
  limit?: number | undefined;
  exploreRatio?: number | undefined;
  maxConcurrency?: number | undefined;
  enqueueRoute?: ((listingId: string) => Promise<void>) | undefined;
  enqueuePhoto?: ((listingId: string) => Promise<void>) | undefined;
  onRecalculate?: (() => Promise<void>) | undefined;
  initialCandidates?: CandidateRecord[] | undefined;
}

export interface BatchEnqueueResult {
  enqueuedRoutes: number;
  enqueuedPhotos: number;
  skippedSignatures: number;
}

export interface CandidateQueueStatus {
  isProcessing: boolean;
  activeCount: number;
  enqueuedRoutesCount: number;
  enqueuedPhotosCount: number;
  processedSignaturesCount: number;
  lastBatchAt: Date | null;
  concurrencyLimit: number;
}

export type CandidateTaskState = "IDLE" | "PENDING_ROUTE" | "PENDING_PHOTO" | "QUEUED" | "READY" | "SKIPPED" | "FAILED";

/**
 * Builds a deterministic task fingerprint for deduplication.
 * Binds listingId, photo set hash, route version, settings version, features version, and assessment revision.
 * This prevents repetitive identical tasks (loop prevention / anti-thrashing).
 */
export function buildTaskSignature(listingId: string, context: TaskSignatureContext = {}): string {
  const payload = [
    `listing:${listingId}`,
    `photo:${context.photoHash ?? "none"}`,
    `route:${context.routeVersion ?? COMMUTE_VERSION}`,
    `settings:${context.settingsVersion ?? 1}`,
    `features:${context.featuresVersion ?? 1}`,
    `assessment:${context.assessmentRevision ?? 0}`
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

export class CandidateQueueService {
  private readonly prisma: PrismaClient | undefined;
  private readonly logger: Logger | undefined;
  private hasOllama: boolean;
  private readonly defaultLimit: number;
  private readonly defaultExploreRatio: number;
  private readonly maxConcurrency: number;
  private readonly enqueueRouteCallback: ((listingId: string) => Promise<void>) | undefined;
  private readonly enqueuePhotoCallback: ((listingId: string) => Promise<void>) | undefined;
  private readonly onRecalculate: (() => Promise<void>) | undefined;

  private readonly candidatesMap = new Map<string, CandidateRecord>();
  private readonly processedSignatures = new Set<string>();
  private isProcessing = false;
  private activeCount = 0;
  private totalRoutesEnqueued = 0;
  private totalPhotosEnqueued = 0;
  private lastBatchAt: Date | null = null;
  private batchGate: Promise<void> = Promise.resolve();

  constructor(options: CandidateQueueOptions = {}) {
    this.prisma = options.prisma;
    this.logger = options.logger;
    this.hasOllama = options.hasOllama ?? true;
    this.defaultLimit = options.limit ?? DEFAULT_CANDIDATE_LIMIT;
    this.defaultExploreRatio = options.exploreRatio ?? DEFAULT_EXPLORE_RATIO;
    this.maxConcurrency = options.maxConcurrency ?? 2;
    this.enqueueRouteCallback = options.enqueueRoute;
    this.enqueuePhotoCallback = options.enqueuePhoto;
    this.onRecalculate = options.onRecalculate;

    if (options.initialCandidates) {
      for (const item of options.initialCandidates) {
        this.candidatesMap.set(item.id, { ...item });
      }
    }
  }

  /**
   * Sets or updates in-memory candidate records. Useful for testing or cache refresh.
   */
  setCandidates(candidates: CandidateRecord[]): void {
    this.candidatesMap.clear();
    for (const item of candidates) {
      this.candidatesMap.set(item.id, { ...item });
    }
  }

  /**
   * Registers or updates a single candidate in memory.
   */
  registerCandidate(candidate: CandidateRecord): void {
    this.candidatesMap.set(candidate.id, { ...candidate });
  }

  /**
   * Retrieves candidate from in-memory cache.
   */
  getCandidate(listingId: string): CandidateRecord | undefined {
    return this.candidatesMap.get(listingId);
  }

  /**
   * Configures Ollama availability flag.
   */
  setOllamaAvailable(available: boolean): void {
    this.hasOllama = available;
  }

  /**
   * Checks whether a task signature has been recorded.
   */
  hasSignature(signature: string): boolean {
    return this.processedSignatures.has(signature);
  }

  /**
   * Clears recorded signatures.
   */
  clearSignatures(): void {
    this.processedSignatures.clear();
  }

  /**
   * Returns read-only set of processed task signatures.
   */
  getProcessedSignatures(): ReadonlySet<string> {
    return this.processedSignatures;
  }

  /**
   * Returns visible queue state and metrics.
   */
  getQueueStatus(): CandidateQueueStatus {
    return {
      isProcessing: this.isProcessing,
      activeCount: this.activeCount,
      enqueuedRoutesCount: this.totalRoutesEnqueued,
      enqueuedPhotosCount: this.totalPhotosEnqueued,
      processedSignaturesCount: this.processedSignatures.size,
      lastBatchAt: this.lastBatchAt,
      concurrencyLimit: this.maxConcurrency
    };
  }

  /**
   * Returns current task state for a specific listing.
   */
  getListingQueueState(listingId: string): CandidateTaskState {
    const candidate = this.candidatesMap.get(listingId);
    if (!candidate) return "IDLE";
    if (candidate.routeStatus === "FAILED" || candidate.photoRepairStatus === "FAILED") return "FAILED";
    if (candidate.routeStatus === "RUNNING" || candidate.photoRepairStatus === "RUNNING" ||
        candidate.routeStatus === "QUEUED" || candidate.photoRepairStatus === "QUEUED") return "QUEUED";
    const needsRoute = this.shouldEnqueueRoute(listingId);
    const needsPhoto = this.shouldEnqueuePhoto(listingId, this.hasOllama);
    if (needsRoute) return "PENDING_ROUTE";
    if (needsPhoto) return "PENDING_PHOTO";
    return "READY";
  }

  /**
   * Builds deterministic task signature for deduplication.
   */
  buildTaskSignature(listingId: string, context: TaskSignatureContext = {}): string {
    const candidate = this.candidatesMap.get(listingId);
    const effectiveContext: TaskSignatureContext = {
      photoHash: context.photoHash !== undefined ? context.photoHash : (candidate?.photoSetHash ?? null),
      routeVersion: context.routeVersion !== undefined ? context.routeVersion : (candidate?.routeVersion ?? COMMUTE_VERSION),
      settingsVersion: context.settingsVersion !== undefined ? context.settingsVersion : (candidate?.settingsVersion ?? 1),
      featuresVersion: context.featuresVersion !== undefined ? context.featuresVersion : (candidate?.featuresVersion ?? 1),
      assessmentRevision: context.assessmentRevision !== undefined ? context.assessmentRevision : (candidate?.assessmentRevision ?? 0)
    };
    return buildTaskSignature(listingId, effectiveContext);
  }

  /**
   * Determines whether photo analysis task should be enqueued for the listing.
   * If Ollama is unavailable, returns false (never creates infinite or failing jobs).
   */
  shouldEnqueuePhoto(listingId: string, hasOllama: boolean): boolean {
    if (!hasOllama) return false;

    const candidate = this.candidatesMap.get(listingId);
    if (!candidate) {
      // Default to true when Ollama is available and listing is unknown
      return true;
    }

    // Must have photos
    if (candidate.photos && candidate.photos.length === 0) {
      return false;
    }

    // Do not re-enqueue if currently in progress
    if (candidate.photoRepairStatus === "RUNNING" || candidate.photoRepairStatus === "QUEUED") {
      return false;
    }

    // Already successfully analyzed
    if (["READY", "APPROVED", "INSUFFICIENT"].includes(candidate.photoRepairStatus ?? "")) {
      return false;
    }

    return true;
  }

  /**
   * Determines whether route calculation task should be enqueued for the listing.
   */
  shouldEnqueueRoute(listingId: string): boolean {
    const candidate = this.candidatesMap.get(listingId);
    if (!candidate) {
      return true;
    }

    // Excluded listings do not need routing
    if (candidate.disposition === "EXCLUDED") {
      return false;
    }

    // Missing coordinates cannot be routed
    if (candidate.latitude == null || candidate.longitude == null) {
      return false;
    }

    // Do not re-enqueue if currently running or queued
    if (candidate.routeStatus === "RUNNING" || candidate.routeStatus === "QUEUED") {
      return false;
    }

    // Already completed
    if (candidate.routeStatus === "READY") {
      return false;
    }

    // Cooldown check for recently failed attempts to avoid infinite tight retry loops
    if (["FAILED", "NO_ROUTE"].includes(candidate.routeStatus ?? "") && candidate.routeAttemptedAt) {
      const elapsed = Date.now() - candidate.routeAttemptedAt.getTime();
      if (elapsed < ROUTE_RETRY_COOLDOWN_MS) {
        return false;
      }
    }

    return true;
  }

  /**
   * Selects top preliminary candidates and exploration slot candidates.
   *
   * 1. Evaluates admissible listings based on available preliminary data (shadow ranking, value score, or price heuristic).
   * 2. Takes the top N (default 20) candidates.
   * 3. Selects exploration candidates outside the top N using calibrated exploreRatio (default 0.20 / 1 per 5).
   * 4. Ensures top and explore sets are disjoint.
   */
  async selectTopCandidates(options: { limit?: number | undefined; exploreRatio?: number | undefined } = {}): Promise<{ top: string[]; explore: string[] }> {
    const limit = options.limit ?? this.defaultLimit;
    const exploreRatio = options.exploreRatio ?? this.defaultExploreRatio;

    // Load from Prisma if database is available
    if (this.prisma) {
      await this.loadFromPrisma();
    }

    // Filter admissible listings
    const admissible = [...this.candidatesMap.values()].filter((item) => {
      if (item.isActive === false) return false;
      if (item.disposition === "EXCLUDED") return false;
      if (item.latitude == null || item.longitude == null) return false;
      return true;
    });

    // Score and rank candidates
    const sorted = admissible.sort((a, b) => {
      const scoreA = a.score ?? (a.pricePerSqm && a.pricePerSqm > 0 ? 10000 / a.pricePerSqm : 0);
      const scoreB = b.score ?? (b.pricePerSqm && b.pricePerSqm > 0 ? 10000 / b.pricePerSqm : 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.id.localeCompare(b.id);
    });

    const topItems = sorted.slice(0, limit);
    const top = topItems.map((item) => item.id);
    const remaining = sorted.slice(limit);

    if (remaining.length === 0 || top.length === 0 || exploreRatio <= 0) {
      return { top, explore: [] };
    }

    // Calibrated exploration count (e.g. 20 * 0.20 = 4)
    const desiredExploreCount = Math.min(remaining.length, Math.max(1, Math.round(top.length * exploreRatio)));

    // Stratified exploration sampling:
    // Prioritize candidates with missing routes or unanalyzed photos (highest information gain),
    // followed by candidates across the rest of the distribution to avoid clustering.
    const missingData = remaining.filter((item) => item.routeStatus !== "READY" || !item.photoRepairStatus);
    const completeData = remaining.filter((item) => item.routeStatus === "READY" && !!item.photoRepairStatus);
    const pool = [...missingData, ...completeData];

    const selectedExploreIds = new Set<string>();
    const explore: string[] = [];

    if (pool.length <= desiredExploreCount) {
      for (const item of pool) {
        explore.push(item.id);
      }
    } else {
      const step = pool.length / desiredExploreCount;
      for (let i = 0; i < desiredExploreCount; i++) {
        const index = Math.min(Math.floor(i * step), pool.length - 1);
        const item = pool[index];
        if (item && !selectedExploreIds.has(item.id)) {
          selectedExploreIds.add(item.id);
          explore.push(item.id);
        }
      }
      // Fill any gaps from collisions
      for (const item of pool) {
        if (explore.length >= desiredExploreCount) break;
        if (!selectedExploreIds.has(item.id)) {
          selectedExploreIds.add(item.id);
          explore.push(item.id);
        }
      }
    }

    return { top, explore };
  }

  /**
   * Enqueues routes and photos for the top candidate batch and exploration slots.
   * Deduplicates tasks using deterministic task signatures.
   * Non-blocking for catalog operations.
   */
  async enqueueTopCandidatesBatch(options: { limit?: number | undefined; exploreRatio?: number | undefined } = {}): Promise<BatchEnqueueResult> {
    // Non-blocking gate to coordinate concurrent batch requests without blocking catalog reads
    let release!: () => void;
    const prevGate = this.batchGate;
    this.batchGate = new Promise<void>((resolve) => { release = resolve; });
    await prevGate;

    this.isProcessing = true;
    this.lastBatchAt = new Date();

    try {
      const { top, explore } = await this.selectTopCandidates(options);
      const allCandidateIds = [...top, ...explore];

      let enqueuedRoutes = 0;
      let enqueuedPhotos = 0;
      let skippedSignatures = 0;

      // Process with bounded concurrency
      const chunks: string[][] = [];
      for (let i = 0; i < allCandidateIds.length; i += this.maxConcurrency) {
        chunks.push(allCandidateIds.slice(i, i + this.maxConcurrency));
      }

      for (const chunk of chunks) {
        await Promise.all(chunk.map(async (listingId) => {
          const candidate = this.candidatesMap.get(listingId);
          const signature = this.buildTaskSignature(listingId, {
            photoHash: candidate?.photoSetHash,
            routeVersion: candidate?.routeVersion,
            settingsVersion: candidate?.settingsVersion,
            featuresVersion: candidate?.featuresVersion,
            assessmentRevision: candidate?.assessmentRevision
          });

          // Deduplication: skip if identical signature was already processed
          if (this.processedSignatures.has(signature)) {
            skippedSignatures++;
            return;
          }

          const needRoute = this.shouldEnqueueRoute(listingId);
          const needPhoto = this.shouldEnqueuePhoto(listingId, this.hasOllama);

          this.activeCount++;
          try {
            if (needRoute) {
              if (this.enqueueRouteCallback) {
                await this.enqueueRouteCallback(listingId);
              } else if (this.prisma) {
                await this.prisma.listing.updateMany({
                  where: { id: listingId, routeStatus: { not: "RUNNING" } },
                  data: { routeStatus: "PENDING", routeError: null }
                });
              }
              enqueuedRoutes++;
              this.totalRoutesEnqueued++;
              if (candidate) candidate.routeStatus = "QUEUED";
            }

            if (needPhoto) {
              if (this.enqueuePhotoCallback) {
                await this.enqueuePhotoCallback(listingId);
              }
              enqueuedPhotos++;
              this.totalPhotosEnqueued++;
              if (candidate) candidate.photoRepairStatus = "QUEUED";
            }

            // Record signature so identical task is never enqueued twice
            this.processedSignatures.add(signature);
          } finally {
            this.activeCount--;
          }
        }));
      }

      // If new jobs were successfully enqueued, trigger recalculation in background
      if ((enqueuedRoutes > 0 || enqueuedPhotos > 0) && this.onRecalculate) {
        void this.onRecalculate().catch((err: unknown) => {
          this.logger?.error({ err }, "CandidateQueue background recalculation failed");
        });
      }

      return { enqueuedRoutes, enqueuedPhotos, skippedSignatures };
    } finally {
      this.isProcessing = false;
      release();
    }
  }

  /**
   * Synchronizes candidate data from Prisma if available.
   */
  private async loadFromPrisma(): Promise<void> {
    if (!this.prisma) return;
    const rows = await this.prisma.listing.findMany({
      where: {
        isActive: true,
        isRepresentative: true,
        disposition: { in: ["ACCEPTED", "REVIEW"] },
        latitude: { not: null },
        longitude: { not: null }
      },
      include: {
        property: {
          include: {
            assessment: true,
            shadowRanking: true
          }
        },
        photoRepair: true
      }
    });

    for (const row of rows) {
      const preliminaryScore = row.property?.shadowRanking?.score
        ?? row.property?.assessment?.valueScore
        ?? (row.pricePerSqm ? Math.max(0, 10000 / Number(row.pricePerSqm)) : 0);

      this.registerCandidate({
        id: row.id,
        propertyId: row.propertyId,
        score: preliminaryScore,
        pricePerSqm: row.pricePerSqm ? Number(row.pricePerSqm) : null,
        priceUsd: row.priceUsd ? Number(row.priceUsd) : null,
        rooms: row.rooms,
        areaSqm: Number(row.areaSqm),
        disposition: row.disposition,
        isActive: row.isActive,
        isRepresentative: row.isRepresentative,
        latitude: row.latitude ? Number(row.latitude) : null,
        longitude: row.longitude ? Number(row.longitude) : null,
        photos: row.photos,
        photoSetHash: row.photoSetHash,
        photoRepairStatus: row.photoRepair?.status ?? null,
        routeStatus: row.routeStatus,
        routeData: row.routeData,
        routeAttemptedAt: row.routeAttemptedAt,
        assessmentRevision: row.property?.assessmentRevision
      });
    }
  }
}
