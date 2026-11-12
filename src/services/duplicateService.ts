import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Prisma, type Listing } from "../generated/prisma/client.js";
import type { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import { refreshRepresentative } from "../infrastructure/repositories/catalogRepository.js";
import type { RetryHttpClient } from "../infrastructure/http/retryHttpClient.js";
import type { Logger } from "../infrastructure/logger.js";
import { areAddressesCompatible, duplicateAddressKey, duplicatePhotoSample, hasStreetAddress, sharedRealtPhotos } from "../utils/duplicateEvidence.js";
import { normalizeSourceImageUrl } from "../utils/sourceImages.js";
import { haversineMeters } from "../utils/geoMath.js";
import { ListingPhotos, type ListingPhotoReader } from "../infrastructure/vision/listingPhotos.js";
import { descriptionDuplicate, structuredDuplicate } from "../domain/duplicateIdentity.js";
import { captureDuplicateState, isDuplicateWriteConflict, listDuplicateMerges, lockDuplicateState, recordDuplicateMerge, undoDuplicateMerge } from "./duplicateMergeJournal.js";
import type { DuplicateMergeSummary, DuplicateUndoResult } from "../contracts/duplicateMerge.js";

export const imageHash = async (buffer: Buffer): Promise<string> => {
  const pixels = await sharp(buffer, { limitInputPixels: 30_000_000 }).rotate().resize(9, 8, { fit: "fill" }).greyscale().raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | (pixels[y * 9 + x]! > pixels[y * 9 + x + 1]! ? 1n : 0n);
  return hash.toString(16).padStart(16, "0");
};
export const hashDistance = (a: string, b: string): number => {
  let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), count = 0;
  while (bits) { bits &= bits - 1n; count++; }
  return count;
};
type PhotoFingerprint = readonly [string, string];
type ReconcileOptions = { structuredOnly?: boolean; metadataOnly?: boolean; retryOnConflict?: boolean; candidateIds?: readonly string[]; candidateSnapshot?: Pick<Listing, "id" | "propertyId" | "contentHash"> };
export const canCheckDuplicate = (listing: Listing): boolean =>
  listing.isActive && listing.disposition === "ACCEPTED" && !!listing.propertyId && !!listing.locality && listing.floor !== null
  && (hasStreetAddress(listing.address ?? "") || (listing.latitude !== null && listing.longitude !== null));
const nearPhoto = (a: PhotoFingerprint, b: PhotoFingerprint): boolean => a.some((x) => b.some((y) => hashDistance(x, y) <= 4));
const fingerprint = async (image: Buffer): Promise<PhotoFingerprint> => {
  const frame = await sharp(image, { limitInputPixels: 30_000_000 }).rotate().resize(90, 80, { fit: "fill" }).png().toBuffer();
  const cropped = await sharp(frame).extract({ left: 5, top: 4, width: 80, height: 72 }).png().toBuffer();
  return [await imageHash(image), await imageHash(cropped)];
};
export class DuplicateService {
  constructor(private readonly repository: CatalogRepository, http: RetryHttpClient, private readonly logger: Logger, private readonly photos: ListingPhotoReader = new ListingPhotos(http)) {}
  async listMerges(propertyId: string): Promise<DuplicateMergeSummary[]> { return listDuplicateMerges(this.repository.prisma, propertyId); }
  async undoMerge(id: string): Promise<DuplicateUndoResult> { return undoDuplicateMerge(this.repository.prisma, id); }
  async checkAndPublish(listing: Listing, signal?: AbortSignal): Promise<boolean> {
    if (!canCheckDuplicate(listing)) return false;
    if (await this.reconcile(listing, signal, { retryOnConflict: true })) return true;
    signal?.throwIfAborted();
    return listing.duplicateCheckPending && this.repository.completeDuplicateCheck(listing);
  }
  async reconcile(listing: Listing, signal?: AbortSignal, { structuredOnly = false, metadataOnly = false, retryOnConflict = false, candidateIds, candidateSnapshot }: ReconcileOptions = {}): Promise<boolean> {
    if (!listing.isActive || !listing.propertyId || !listing.locality || listing.floor === null || listing.disposition !== "ACCEPTED") return false;
    const allowPhotos = !structuredOnly && !metadataOnly;
    const ids = candidateSnapshot ? [candidateSnapshot.id] : candidateIds;
    const candidates = await this.repository.prisma.listing.findMany({ where: { id: { not: listing.id },
      isActive: true, disposition: "ACCEPTED", locality: listing.locality, rooms: listing.rooms, floor: listing.floor,
      areaSqm: { gte: Number(listing.areaSqm) - 1.0, lte: Number(listing.areaSqm) + 1.0 }, propertyId: { not: listing.propertyId },
      ...(listing.latitude !== null && listing.longitude !== null ? { OR: [
        { latitude: { gte: Number(listing.latitude) - 0.002, lte: Number(listing.latitude) + 0.002 }, longitude: { gte: Number(listing.longitude) - 0.004, lte: Number(listing.longitude) + 0.004 } },
        { latitude: null }, { longitude: null }
      ] } : {})
    }, orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }] });
    const addressKey = listing.address && duplicateAddressKey(listing.address, listing.locality);
    const matchingGroups = new Map<Listing["platform"], Set<string>>();
    for (const candidate of candidates) {
      if (!candidate.propertyId || !structuredDuplicate(listing, candidate)) continue;
      const groups = matchingGroups.get(candidate.platform) ?? new Set<string>();
      groups.add(candidate.propertyId);
      matchingGroups.set(candidate.platform, groups);
    }
    const described = structuredOnly ? [] : candidates.filter((candidate) => candidate.propertyId && descriptionDuplicate(listing, candidate));
    const multipleDescriptionGroups = new Set(described.map((row) => row.propertyId)).size > 1;
    const ranked = candidates.filter((candidate) => !ids || ids.includes(candidate.id)).map((candidate) => {
      const ambiguousDescription = multipleDescriptionGroups || (described.includes(candidate) && candidates.some((other) =>
        other.propertyId !== candidate.propertyId && descriptionDuplicate(candidate, other)));
      return {
        candidate,
        description: !ambiguousDescription && described.includes(candidate),
        structured: !ambiguousDescription && listing.platform !== candidate.platform && !matchingGroups.has(listing.platform)
          && matchingGroups.get(candidate.platform)?.size === 1 && structuredDuplicate(listing, candidate),
        shared: allowPhotos ? sharedRealtPhotos(listing.photos, candidate.photos) : 0
      };
    }).sort((a, b) => Number(b.description) - Number(a.description) || b.shared - a.shared || Number(b.structured) - Number(a.structured));
    for (const { candidate, description, structured, shared } of ranked) {
      signal?.throwIfAborted();
      if (!candidate.propertyId) continue;
      if ((!allowPhotos && !structured && !description) || (candidateSnapshot && (candidate.contentHash !== candidateSnapshot.contentHash || candidate.propertyId !== candidateSnapshot.propertyId))) continue;
      const sameAddress = !!addressKey && !!listing.address && !!candidate.address
        && (areAddressesCompatible(candidate.address, listing.address, listing.locality) || areAddressesCompatible(candidate.address, listing.address, listing.locality, { allowBaseHouseMatch: true }));
      const listingStreet = !!listing.address && hasStreetAddress(listing.address), candidateStreet = !!candidate.address && hasStreetAddress(candidate.address);
      const preciseAddress = sameAddress && (listingStreet || candidateStreet);
      if (!description && !preciseAddress) {
        if (listingStreet && candidateStreet) continue;
        if (listing.latitude === null || listing.longitude === null || candidate.latitude === null || candidate.longitude === null) continue;
        const distance = haversineMeters({ latitude: Number(listing.latitude), longitude: Number(listing.longitude) }, { latitude: Number(candidate.latitude), longitude: Number(candidate.longitude) });
        if (distance > 75 || Math.abs(Number(candidate.priceUsd) / Number(listing.priceUsd) - 1) > 0.05) continue;
      }
      if (listing.totalFloors && candidate.totalFloors && listing.totalFloors !== candidate.totalFloors) continue;
      if (!candidateSnapshot) await this.repository.prisma.listing.updateMany({ where: { id: listing.id, propertyId: listing.propertyId, contentHash: listing.contentHash,
        NOT: { possibleDuplicateIds: { has: candidate.propertyId } } }, data: { possibleDuplicateIds: { push: candidate.propertyId } } });
      if (!structured && !description) {
        if (listing.photos.length < 2 || candidate.photos.length < 2) continue;
        const minimum = preciseAddress ? 2 : 3;
        if (shared < minimum && await this.matchPhotos(listing, candidate, 7, signal) < minimum
          && (!preciseAddress || Math.min(listing.photos.length, candidate.photos.length) < 8 || await this.matchPhotos(listing, candidate, 14, signal) < minimum)) continue;
      }
      signal?.throwIfAborted();
      const merged = await this.repository.prisma.$transaction(async (tx): Promise<boolean> => {
        const keepPublishedListing = candidate.duplicateCheckPending && !listing.duplicateCheckPending;
        const primaryListing = keepPublishedListing ? listing : candidate;
        const secondaryListing = keepPublishedListing ? candidate : listing;
        const primaryId = primaryListing.propertyId!, secondaryId = secondaryListing.propertyId!;
        await lockDuplicateState(tx, primaryId, secondaryId);
        signal?.throwIfAborted();
        const current = await tx.listing.findMany({ where: { id: { in: [listing.id, candidate.id] }, disposition: "ACCEPTED", isActive: true }, select: { id: true, propertyId: true, contentHash: true } });
        if (!current.some((row) => row.id === secondaryListing.id && row.propertyId === secondaryId && row.contentHash === secondaryListing.contentHash)
          || !current.some((row) => row.id === primaryListing.id && row.propertyId === primaryId && row.contentHash === primaryListing.contentHash)) {
          if (retryOnConflict) throw new Error("Duplicate evidence changed during reconciliation");
          return false;
        }
        const members = await tx.listing.findMany({ where: { propertyId: { in: [primaryId, secondaryId] }, isActive: true, disposition: "ACCEPTED" } });
        for (const a of members.filter((row) => row.propertyId === secondaryId)) for (const b of members.filter((row) => row.propertyId === primaryId)) {
          if (a.id === secondaryListing.id && b.id === primaryListing.id) continue;
          if (descriptionDuplicate(a, b)) continue;
          const sameBuilding = a.address && b.address && a.locality === b.locality && (areAddressesCompatible(a.address, b.address, a.locality) || areAddressesCompatible(a.address, b.address, a.locality, { allowBaseHouseMatch: true }));
          if (!sameBuilding || a.floor === null || a.floor !== b.floor || a.rooms !== b.rooms || Math.abs(Number(a.areaSqm) - Number(b.areaSqm)) > 1.0
            || (!structuredDuplicate(a, b) && sharedRealtPhotos(a.photos, b.photos) < 3)) return false;
        }
        const before = await captureDuplicateState(tx, primaryId, secondaryId);
        const secondary = await tx.property.findUnique({ where: { id: secondaryId } });
        const primary = await tx.property.findUniqueOrThrow({ where: { id: primaryId } });
        await tx.listing.updateMany({ where: { propertyId: secondaryId }, data: { propertyId: primaryId, isRepresentative: false } });
        await tx.listing.updateMany({ where: { id: { in: [listing.id, candidate.id] }, duplicateCheckPending: true }, data: { duplicateCheckPending: false } });
        await tx.property.update({ where: { id: primaryId }, data: { favorite: primary.favorite || secondary?.favorite === true, hidden: primary.hidden || secondary?.hidden === true,
          renovationBudgetUsd: primary.renovationBudgetUsd ?? secondary?.renovationBudgetUsd ?? null, assessmentRevision: { increment: 1 }, userStateRevision: { increment: 1 } } });
        await tx.assessment.updateMany({ where: { propertyId: { in: [primaryId, secondaryId] } }, data: { valueScore: null, comfortScore: null, coverage: 0, data: {} } });
        await tx.$executeRaw`
          UPDATE "Listing"
          SET "possibleDuplicateIds" = CASE
            WHEN "propertyId" = ${primaryId} THEN array_remove(array_remove("possibleDuplicateIds", ${secondaryId}), ${primaryId})
            WHEN ${primaryId} = ANY("possibleDuplicateIds") THEN array_remove("possibleDuplicateIds", ${secondaryId})
            ELSE array_replace("possibleDuplicateIds", ${secondaryId}, ${primaryId})
          END
          WHERE "propertyId" = ${primaryId} OR ${secondaryId} = ANY("possibleDuplicateIds")
        `;
        await refreshRepresentative(tx, primaryId);
        const oldMatches = await tx.searchMatch.findMany({ where: { propertyId: secondaryId } });
        for (const match of oldMatches) await tx.searchMatch.upsert({ where: { searchId_propertyId: { searchId: match.searchId, propertyId: primaryId } }, create: { searchId: match.searchId, propertyId: primaryId, priceUsd: match.priceUsd }, update: {} });
        await tx.searchMatch.deleteMany({ where: { propertyId: secondaryId } });
        await tx.notification.updateMany({ where: { propertyId: secondaryId, status: "PENDING" }, data: { status: "SUPERSEDED" } });
        await recordDuplicateMerge(tx, primaryId, secondaryId, structured || description ? "structured" : "photos", before);
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 }).catch((error: unknown): boolean => {
        if (!retryOnConflict && isDuplicateWriteConflict(error)) return false;
        throw error;
      });
      if (merged) { this.logger.info({ listingId: listing.id, otherId: candidate.id, evidence: description ? "description" : structured ? "structured" : "photos" }, "Confirmed listing duplicate"); return true; }
    }
    return false;
  }
  private async matchPhotos(listing: Listing, candidate: Listing, limit: number, signal?: AbortSignal): Promise<number> {
    const a = await this.hashes(listing, limit, signal), b = await this.hashes(candidate, limit, signal), used = new Set<number>();
    for (const hash of a) {
      const i = b.findIndex((other, index) => !used.has(index) && nearPhoto(hash, other));
      if (i >= 0) used.add(i);
    }
    return used.size;
  }
  private async hashes(listing: Listing, limit: number, signal?: AbortSignal): Promise<PhotoFingerprint[]> {
    const values: PhotoFingerprint[] = [];
    for (const original of duplicatePhotoSample(listing.photos, limit)) {
      signal?.throwIfAborted();
      try {
        const url = normalizeSourceImageUrl(original);
        const file = resolve(".cache/photo-hashes-v3", `${createHash("sha256").update(url).digest("hex")}.txt`);
        const cached = /^([a-f0-9]{16}):([a-f0-9]{16})$/.exec(await readFile(file, "utf8").catch(() => ""));
        const hash: PhotoFingerprint = cached ? [cached[1]!, cached[2]!] : await fingerprint(await this.photos.read(listing.platform, url, signal));
        if (!cached) {
          await mkdir(resolve(".cache/photo-hashes-v3"), { recursive: true });
          await writeFile(file, hash.join(":"), "utf8");
        }
        if (hash.every((value) => value !== "0000000000000000" && value !== "ffffffffffffffff") && !values.some((other) => nearPhoto(hash, other))) values.push(hash);
      } catch (error: unknown) { signal?.throwIfAborted(); this.logger.warn({ err: error, listingId: listing.id }, "Photo fingerprint unavailable"); }
    }
    return [...new Set(values)];
  }
}
