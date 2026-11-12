import type { ListingCandidate } from "../../domain/listing.js";
import type { PlatformName } from "../../contracts/catalog.js";

export type SourceCheckpoint = { readonly page: number; readonly cursor?: string | undefined };
export type SourcePage = {
  readonly candidates: readonly ListingCandidate[];
  readonly received: number;
  readonly invalid: number;
  readonly next: SourceCheckpoint | null;
};
export interface CatalogSource {
  readonly platform: PlatformName;
  fetchCatalogPage(checkpoint: SourceCheckpoint): Promise<SourcePage>;
  enrich(candidate: ListingCandidate): Promise<ListingCandidate>;
  normalizeStored(payload: unknown): ListingCandidate | undefined;
}
