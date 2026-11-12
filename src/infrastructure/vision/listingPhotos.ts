import sharp from "sharp";
import type { Platform } from "../../generated/prisma/client.js";
import type { RetryHttpClient } from "../http/retryHttpClient.js";
import { normalizeSourceImageUrl } from "../../utils/sourceImages.js";

const hosts: Readonly<Record<Platform, readonly string[]>> = {
  KUFAR: ["rms.kufar.by"], ONLINER: ["imgproxy.onliner.by", "content.onliner.by"], REALT: ["cdn.realt.by", "static.realt.by"]
};
export const isListingPhotoUrl = (platform: Platform, url: URL): boolean => url.protocol === "https:" && !url.port && !url.username && !url.password
  && (hosts[platform].includes(url.hostname) || (platform === "KUFAR" && /^rms[1-9][0-9]?\.kufar\.by$/.test(url.hostname))
    || (platform === "REALT" && url.hostname === "realt.by" && url.pathname.startsWith("/thumb/")));
export interface ListingPhotoReader { read(platform: Platform, photo: string, signal?: AbortSignal): Promise<Buffer>; }

export class ListingPhotos implements ListingPhotoReader {
  constructor(private readonly http: RetryHttpClient) {}
  async read(platform: Platform, photo: string, signal?: AbortSignal): Promise<Buffer> {
    const url = new URL(normalizeSourceImageUrl(photo));
    if (!isListingPhotoUrl(platform, url)) throw new Error("Unsupported listing image host");
    const data = await this.http.bytes({ method: "GET", url: url.href, allowRedirect: (target) => isListingPhotoUrl(platform, target), minIntervalMs: 1000, timeoutMs: 15_000, retries: 1, ...(signal ? { signal } : {}) });
    return sharp(data, { limitInputPixels: 24_000_000 }).rotate().resize({ width: 896, height: 896, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  }
}
