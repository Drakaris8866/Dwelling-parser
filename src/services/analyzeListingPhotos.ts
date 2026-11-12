import { createHash } from "node:crypto";
import type { PhotoBuildingCategory, PhotoEvidence, PhotoRepairCategory } from "../contracts/photoRepair.js";
import type { Platform } from "../generated/prisma/client.js";
import { photoBuildingConsensus, photoConsensus } from "../domain/repairEvidence.js";
import type { Logger } from "../infrastructure/logger.js";
import type { ListingPhotoReader } from "../infrastructure/vision/listingPhotos.js";
import type { PhotoInspector } from "../infrastructure/vision/ollamaVision.js";
import { normalizeSourceImageUrl } from "../utils/sourceImages.js";

type Gallery = { id: string; platform: Platform; photos: readonly string[] };
type Result = { digest: string; evidence: PhotoEvidence; suggestion: PhotoRepairCategory | null; buildingSuggestion: PhotoBuildingCategory | null; unavailable: number };

export const analyzeListingPhotos = async (gallery: Gallery, reader: ListingPhotoReader, inspector: PhotoInspector, logger: Logger, signal?: AbortSignal, limit = 6): Promise<Result> => {
  const digest = await inspector.digest(signal);
  const urls = [...new Set(gallery.photos)], count = Math.min(6, limit, urls.length);
  const evidence: PhotoEvidence = [], seen = new Set<string>();
  let unavailable = 0;
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted();
    const photo = urls[count === 1 ? 0 : Math.round(index * (urls.length - 1) / (count - 1))]!;
    let image: Buffer;
    try { image = await reader.read(gallery.platform, photo, signal); }
    catch (err: unknown) { unavailable++; logger.warn({ err, listingId: gallery.id, index }, "Could not read listing photo"); continue; }
    const hash = createHash("sha256").update(image).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    evidence.push({ ...await inspector.inspect(image, signal), photoUrl: normalizeSourceImageUrl(photo) });
  }
  signal?.throwIfAborted();
  if (await inspector.digest(signal) !== digest) throw new Error("Ollama model changed during analysis");
  return { digest, evidence, unavailable, suggestion: photoConsensus(evidence), buildingSuggestion: photoBuildingConsensus(evidence) };
};
