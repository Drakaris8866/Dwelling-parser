import type { Prisma } from "../generated/prisma/client.js";
import { Platform } from "../generated/prisma/client.js";
import type { ListingFeatures } from "../contracts/catalog.js";

export { Platform };

export type MetroDistanceType = "walking" | "transport";

export type ListingCandidate = {
  readonly photosComplete?: boolean | undefined;
  readonly descriptionComplete?: boolean | undefined;
  readonly features?: ListingFeatures | undefined;
  readonly platform: Platform;
  readonly externalId: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly rooms: number;
  readonly areaSqm: number;
  readonly priceUsd: number;
  readonly priceByn?: number | undefined;
  readonly pricePerSqm: number;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
  readonly timeToTargetTransit?: number | undefined;
  readonly targetTransitSummary?: string | undefined;
  readonly photos: readonly string[];
  readonly details: readonly string[];
  readonly houseType?: string | undefined;
  readonly buildingSeries?: string | undefined;
  readonly repairState?: string | undefined;
  readonly metroName?: string | undefined;
  readonly metroDistanceText?: string | undefined;
  readonly metroDistanceType?: MetroDistanceType | undefined;
  readonly sourcePayload: Prisma.InputJsonValue;
};

export type PersistedListing = {
  readonly id: string;
  readonly platform: Platform;
  readonly externalId: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly rooms: number;
  readonly areaSqm: number;
  readonly priceUsd: number;
  readonly priceByn?: number | undefined;
  readonly pricePerSqm: number;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
  readonly timeToTargetTransit?: number | undefined;
  readonly targetTransitSummary?: string | undefined;
  readonly photos: readonly string[];
  readonly details: readonly string[];
  readonly houseType?: string | undefined;
  readonly buildingSeries?: string | undefined;
  readonly repairState?: string | undefined;
  readonly metroName?: string | undefined;
  readonly metroDistanceText?: string | undefined;
  readonly metroDistanceType?: MetroDistanceType | undefined;
};

export type ListingUpsertResult =
  | { readonly status: "skipped-unchanged"; readonly listingId: string }
  | { readonly status: "created" | "updated-price" | "reprocessed-unchanged"; readonly listing: PersistedListing };
