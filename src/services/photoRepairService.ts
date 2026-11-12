import { randomUUID } from "node:crypto";
import { PHOTO_PROMPT_VERSION, type PhotoDecision } from "../contracts/photoRepair.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { Logger } from "../infrastructure/logger.js";
import type { ListingPhotoReader } from "../infrastructure/vision/listingPhotos.js";
import type { PhotoInspector } from "../infrastructure/vision/ollamaVision.js";
import { buildingSuggestionFromEvidence, planSuggestionFromEvidence, repairSuggestionFromEvidence } from "../domain/repairEvidence.js";
import { galleryFingerprint } from "../utils/galleryFingerprint.js";
import { toPrismaJson } from "../utils/json.js";
import { analyzeListingPhotos } from "./analyzeListingPhotos.js";

export class PhotoRepairError extends Error {
  constructor(readonly statusCode: 409 | 422 | 503, message: string) { super(message); }
}
export class PhotoRepairService {
  constructor(private readonly db: PrismaClient, private readonly photos: ListingPhotoReader, private readonly logger: Logger, private readonly inspector?: PhotoInspector) {}
  get enabled(): boolean { return this.inspector !== undefined; }

  async request(listingId: string, enqueue: (id: string) => Promise<void>): Promise<"cached" | "queued"> {
    const inspector = this.inspector;
    if (!inspector) throw new PhotoRepairError(503, "Локальный анализ фото не включён");
    const result = await this.db.$transaction(async (tx) => {
      const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId }, select: { photos: true } });
      if (!listing.photos.length) throw new PhotoRepairError(422, "В объявлении нет фотографий");
      const galleryHash = galleryFingerprint(listing.photos);
      const locked = await tx.listing.updateMany({ where: { id: listingId, photos: { equals: listing.photos } }, data: { photoSetHash: galleryHash } });
      if (!locked.count) throw new PhotoRepairError(409, "Галерея изменилась. Повторите запрос.");
      const existing = await tx.photoRepairAnalysis.findUnique({ where: { listingId } });
      if (existing?.galleryHash === galleryHash && existing.status !== "FAILED" && (existing.promptVersion >= PHOTO_PROMPT_VERSION || existing.decision === "APPROVED")) return existing;
      const data = { id: randomUUID(), galleryHash, model: inspector.model, promptVersion: PHOTO_PROMPT_VERSION, status: "QUEUED",
        decision: "PENDING", suggestion: null, modelDigest: null, evidence: toPrismaJson([]), message: null };
      return tx.photoRepairAnalysis.upsert({ where: { listingId }, create: { listingId, ...data }, update: data });
    });
    if (result.status === "READY" || result.status === "INSUFFICIENT") return "cached";
    if (result.status !== "RUNNING") await enqueue(result.id);
    return "queued";
  }

  async decide(listingId: string, propertyId: string, input: PhotoDecision): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const analysis = await tx.photoRepairAnalysis.findUnique({ where: { id: input.analysisId } });
      if (!analysis || analysis.listingId !== listingId || !["READY", "INSUFFICIENT"].includes(analysis.status)) throw new PhotoRepairError(409, "Нет актуального результата для подтверждения");
      const locked = await tx.listing.updateMany({ where: { id: listingId, propertyId, isRepresentative: true, photoSetHash: analysis.galleryHash }, data: { photoSetHash: analysis.galleryHash } });
      if (!locked.count) throw new PhotoRepairError(409, "Галерея изменилась. Оцените новые фотографии.");
      const current = await tx.photoRepairAnalysis.findUnique({ where: { id: analysis.id } });
      if (!current || !["READY", "INSUFFICIENT"].includes(current.status)) throw new PhotoRepairError(409, "Результат анализа изменился");
      const suggestion = current.suggestion ?? repairSuggestionFromEvidence(current.evidence);
      if (!suggestion && !buildingSuggestionFromEvidence(current.evidence) && !planSuggestionFromEvidence(current.evidence)) throw new PhotoRepairError(409, "Нет актуального результата для подтверждения");
      const approvingRepair = input.decision === "APPROVED" && current.suggestion === null && suggestion !== null && (current.decision !== "APPROVED" || input.confirmRepair === true);
      const updated = await tx.photoRepairAnalysis.updateMany({ where: { id: analysis.id, status: current.status }, data: {
        decision: input.decision, ...(approvingRepair ? { suggestion, status: "READY" } : {})
      } });
      if (!updated.count) throw new PhotoRepairError(409, "Результат анализа изменился");
      if (approvingRepair || (current.decision !== input.decision && (current.decision === "APPROVED" || input.decision === "APPROVED"))) {
        await tx.property.update({ where: { id: propertyId }, data: { assessmentRevision: { increment: 1 } } });
        await tx.assessment.updateMany({ where: { propertyId }, data: { valueScore: null, comfortScore: null, coverage: 0, data: {} } });
      }
    });
  }

  async run(id: string, signal?: AbortSignal): Promise<void> {
    const row = await this.db.photoRepairAnalysis.findUnique({ where: { id }, include: { listing: true } });
    if (!row || row.galleryHash !== row.listing.photoSetHash || ["READY", "INSUFFICIENT"].includes(row.status)) return;
    const where = { id, listing: { photoSetHash: row.galleryHash } };
    await this.db.photoRepairAnalysis.updateMany({ where, data: { status: "RUNNING", message: null } });
    try {
      if (!this.inspector) throw new Error("Photo analysis is disabled");
      const { digest, evidence, suggestion, buildingSuggestion, unavailable } = await analyzeListingPhotos(row.listing, this.photos, this.inspector, this.logger, signal);
      await this.db.photoRepairAnalysis.updateMany({ where, data: { modelDigest: digest, suggestion, evidence: toPrismaJson(evidence), promptVersion: PHOTO_PROMPT_VERSION,
        status: suggestion || buildingSuggestion || planSuggestionFromEvidence(evidence) ? "READY" : "INSUFFICIENT", message: unavailable ? "Часть фото недоступна" : null } });
    } catch (error: unknown) {
      this.logger.warn({ analysisId: id, listingId: row.listingId, error: error instanceof Error ? error.name : "Unknown", reason: error instanceof Error ? error.message.slice(0, 400) : undefined }, "Local photo analysis failed");
      if (!signal?.aborted) await this.db.photoRepairAnalysis.updateMany({ where, data: { status: "FAILED", message: "Не удалось завершить анализ. Проверьте, что Ollama запущен и модель загружена." } });
      throw new Error("Local photo analysis failed");
    }
  }
}
