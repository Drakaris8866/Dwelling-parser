import { createHash } from "node:crypto";

export const galleryFingerprint = (photos: readonly string[]): string => createHash("sha256").update(JSON.stringify([...new Set(photos)].sort())).digest("hex");
