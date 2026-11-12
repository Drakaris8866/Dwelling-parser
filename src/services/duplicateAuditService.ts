import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { duplicateAuditSchema, type DuplicatePair } from "../contracts/duplicateAudit.js";
import { structuredDuplicate } from "../domain/duplicateIdentity.js";
import { baseAddressKey, duplicateAddressKey, hasStreetAddress, realtPhotoIdentity } from "../utils/duplicateEvidence.js";
import { cleanText } from "../utils/listingFeatures.js";
import { normalizeSourceImageUrl } from "../utils/sourceImages.js";

const file = resolve(".cache/duplicate-audit.json");
const select = { id: true, propertyId: true, contentHash: true, platform: true, externalId: true, address: true, locality: true, floor: true,
  rooms: true, latitude: true, longitude: true, totalFloors: true, areaSqm: true, priceUsd: true, priceByn: true, kitchenSqm: true,
  livingSqm: true, buildingYear: true, readiness: true, description: true, photos: true } satisfies Prisma.ListingSelect;
type Row = Prisma.ListingGetPayload<{ select: typeof select }>;
type Entry = { row: Row; text: string; media: Set<string> };
const preview = (value: string | undefined): string | null => {
  try { return value ? normalizeSourceImageUrl(value) : null; } catch { return null; }
};
const publication = (r: Row): DuplicatePair["left"] => ({ listingId: r.id, propertyId: r.propertyId!, contentHash: r.contentHash,
  platform: r.platform, externalId: r.externalId, priceUsd: Number(r.priceUsd), photo: preview(r.photos[0]) });
export const readDuplicateAudit = async (): Promise<ReturnType<typeof duplicateAuditSchema.parse>> => {
  try { return duplicateAuditSchema.parse(JSON.parse(await readFile(file, "utf8")) as unknown); }
  catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return { scannedAt: null, publications: 0, pairs: [] };
    throw err;
  }
};

export const scanDuplicateAudit = async (db: PrismaClient, signal?: AbortSignal): Promise<{ publications: number; pairs: number }> => {
  const rows = await db.listing.findMany({ where: { isActive: true, disposition: "ACCEPTED", propertyId: { not: null }, address: { not: null }, floor: { not: null } }, select, orderBy: { id: "asc" } });
  const buckets = new Map<string, Entry[]>(), matches = new Map<string, DuplicatePair>();
  const strength = (p: DuplicatePair): number => Math.min(p.exactPhotos, 5) * 100 + Number(p.structured) * 20 + Number(p.sameDescription) * 10;
  for (const row of rows) {
    signal?.throwIfAborted();
    if (!row.address || !row.locality || !hasStreetAddress(row.address)) continue;
    const key = JSON.stringify([row.locality, baseAddressKey(row.address, row.locality), row.floor, row.rooms]);
    const entry = { row, text: cleanText(row.description), media: new Set(row.photos.map(realtPhotoIdentity).filter((id): id is string => id !== undefined)) };
    const peers = buckets.get(key) ?? [];
    for (const other of peers) {
      const b = other.row;
      if (b.propertyId === row.propertyId || Math.abs(Number(row.areaSqm) - Number(b.areaSqm)) > 0.6
        || (b.totalFloors !== null && row.totalFloors !== null && b.totalFloors !== row.totalFloors)) continue;
      const exactPhotos = [...entry.media].filter((id) => other.media.has(id)).length;
      const sameDescription = entry.text.length >= 120 && entry.text === other.text;
      const structured = row.platform !== b.platform && structuredDuplicate(row, b);
      if (!structured && !sameDescription && exactPhotos < 2 && Math.abs(Number(row.priceUsd) - Number(b.priceUsd)) > 1) continue;
      const pair = { left: publication(b), right: publication(row), address: row.address, floor: row.floor!, rooms: row.rooms,
        areaSqm: Number(row.areaSqm), exactPhotos, sameDescription, structured } satisfies DuplicatePair;
      const pairKey = [pair.left.propertyId, pair.right.propertyId].sort().join(":");
      const existing = matches.get(pairKey);
      if (!existing || strength(pair) > strength(existing)) matches.set(pairKey, pair);
    }
    peers.push(entry);
    buckets.set(key, peers);
  }
  const pairs = [...matches.values()].sort((a, b) => strength(b) - strength(a));
  signal?.throwIfAborted();
  await mkdir(resolve(".cache"), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ scannedAt: new Date().toISOString(), publications: rows.length, pairs }), "utf8");
  await rename(temporary, file);
  return { publications: rows.length, pairs: pairs.length };
};
