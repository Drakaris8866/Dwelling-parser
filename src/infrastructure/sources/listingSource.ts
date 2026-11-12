import type { ListingCandidate } from "../../domain/listing.js";

export interface ListingSource {
  readonly name: string;
  poll(): Promise<readonly ListingCandidate[]>;
}
