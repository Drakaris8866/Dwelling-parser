import { createHash } from "node:crypto";

const canonical = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])
  );
  return value;
};
export const canonicalRankingHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export const PUBLICATION_PRICE_POLICY_VERSION = 3;
// Same explicit BYN total may have slightly different source USD conversions.
const MAX_CONVERSION_SPREAD = 0.001;
type Publication = { propertyId: string; externalId: string; platform: string; priceUsd: number; priceByn?: number | null; priceCurrency?: "USD" | "BYN"; lastSeenAt: Date };
export function resolvePublicationPrices<T extends Publication>(publications: readonly T[]): {
  rows: (T & { priceIsDisputed: boolean })[];
  evidence: { propertyId: string; disputed: boolean; resolution: "exact-usd" | "original-usd" | "same-byn-conversion" | "disputed"; publications: { externalId: string; platform: string; priceUsd: number; priceByn?: number | null; priceCurrency?: "USD" | "BYN"; lastSeenAt: string }[] }[];
} {
  const groups = new Map<string, T[]>();
  for (const publication of publications) groups.set(publication.propertyId, [...(groups.get(publication.propertyId) ?? []), publication]);
  const rows: (T & { priceIsDisputed: boolean })[] = [];
  const evidence = [];
  for (const [propertyId, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    group.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.platform.localeCompare(b.platform) || a.externalId.localeCompare(b.externalId));
    const usd = group.map((row) => row.priceUsd);
    const validUsd = usd.every((value) => Number.isFinite(value) && value > 0);
    const knownByn = group.flatMap((row) => row.priceByn == null ? [] : [row.priceByn]);
    const validByn = knownByn.every((value) => Number.isFinite(value) && value > 0);
    const conflictingByn = !validByn || new Set(knownByn).size > 1;
    const exactUsd = new Set(usd).size === 1;
    const allOriginalUsd = group.every((row) => row.priceCurrency === "USD");
    const originalUsdConflict = new Set(group.filter((row) => row.priceCurrency === "USD").map((row) => row.priceUsd)).size > 1;
    const originalUsd = validUsd && validByn && exactUsd && allOriginalUsd;
    const sameBynConversion = knownByn.length === group.length && !conflictingByn && validUsd
      && (Math.max(...usd) - Math.min(...usd)) / Math.min(...usd) <= MAX_CONVERSION_SPREAD;
    const disputed = originalUsdConflict || (!originalUsd && (!validUsd || conflictingByn || (!exactUsd && !sameBynConversion)));
    rows.push({ ...group[0]!, priceIsDisputed: disputed });
    const resolution = disputed ? "disputed" as const : originalUsd ? "original-usd" as const : exactUsd ? "exact-usd" as const : "same-byn-conversion" as const;
    evidence.push({ propertyId, disputed, resolution, publications: group.map(({ externalId, platform, priceUsd, priceByn, priceCurrency, lastSeenAt }) => ({ externalId, platform, priceUsd, ...(priceByn === undefined ? {} : { priceByn }), ...(priceCurrency === undefined ? {} : { priceCurrency }), lastSeenAt: lastSeenAt.toISOString() })) });
  }
  return { rows, evidence };
}
