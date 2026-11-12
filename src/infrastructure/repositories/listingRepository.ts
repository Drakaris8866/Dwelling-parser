import type { Listing as PrismaListing, PrismaClient } from "../../generated/prisma/client.js";
import type { ListingCandidate, ListingUpsertResult, PersistedListing } from "../../domain/listing.js";
import type { Logger } from "../logger.js";

export type ListingUpsertOptions = {
  readonly reprocessUnchanged?: boolean | undefined;
};

export class ListingRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger
  ) {}

  async upsertChanged(candidate: ListingCandidate, options: ListingUpsertOptions = {}): Promise<ListingUpsertResult> {
    const existing = await this.prisma.listing.findUnique({
      where: {
        platform_externalId: {
          platform: candidate.platform,
          externalId: candidate.externalId
        }
      }
    });

    if (existing !== null && Number(existing.priceUsd) === candidate.priceUsd && options.reprocessUnchanged !== true) {
      return { status: "skipped-unchanged", listingId: existing.id };
    }

    if (existing !== null && Number(existing.priceUsd) === candidate.priceUsd) {
      const updated = await this.prisma.listing.update({
        where: {
          id: existing.id
        },
        data: {
          url: candidate.url,
          title: candidate.title,
          description: candidate.description,
          rooms: candidate.rooms,
          areaSqm: candidate.areaSqm,
          priceByn: candidate.priceByn ?? null,
          pricePerSqm: candidate.pricePerSqm,
          latitude: candidate.latitude ?? null,
          longitude: candidate.longitude ?? null,
          timeToTargetTransit: candidate.timeToTargetTransit ?? null,
          targetTransitSummary: candidate.targetTransitSummary ?? null,
          photos: [...candidate.photos],
          details: [...candidate.details],
          houseType: candidate.houseType ?? null,
          buildingSeries: candidate.buildingSeries ?? null,
          repairState: candidate.repairState ?? null,
          metroName: candidate.metroName ?? null,
          metroDistanceText: candidate.metroDistanceText ?? null,
          metroDistanceType: candidate.metroDistanceType ?? null,
          sourcePayload: candidate.sourcePayload
        }
      });

      return { status: "reprocessed-unchanged", listing: this.toPersistedListing(updated) };
    }

    if (existing === null) {
      const created = await this.prisma.listing.create({
        data: {
          platform: candidate.platform,
          externalId: candidate.externalId,
          url: candidate.url,
          title: candidate.title,
          description: candidate.description,
          rooms: candidate.rooms,
          areaSqm: candidate.areaSqm,
          priceUsd: candidate.priceUsd,
          priceByn: candidate.priceByn ?? null,
          pricePerSqm: candidate.pricePerSqm,
          latitude: candidate.latitude ?? null,
          longitude: candidate.longitude ?? null,
          timeToTargetTransit: candidate.timeToTargetTransit ?? null,
          targetTransitSummary: candidate.targetTransitSummary ?? null,
          photos: [...candidate.photos],
          details: [...candidate.details],
          houseType: candidate.houseType ?? null,
          buildingSeries: candidate.buildingSeries ?? null,
          repairState: candidate.repairState ?? null,
          metroName: candidate.metroName ?? null,
          metroDistanceText: candidate.metroDistanceText ?? null,
          metroDistanceType: candidate.metroDistanceType ?? null,
          sourcePayload: candidate.sourcePayload,
          priceHistory: {
            create: {
              priceUsd: candidate.priceUsd,
              pricePerSqm: candidate.pricePerSqm
            }
          }
        }
      });

      return { status: "created", listing: this.toPersistedListing(created) };
    }

    const updated = await this.prisma.listing.update({
      where: {
        id: existing.id
      },
      data: {
        url: candidate.url,
        title: candidate.title,
        description: candidate.description,
        rooms: candidate.rooms,
        areaSqm: candidate.areaSqm,
        priceUsd: candidate.priceUsd,
        priceByn: candidate.priceByn ?? null,
        pricePerSqm: candidate.pricePerSqm,
        latitude: candidate.latitude ?? null,
        longitude: candidate.longitude ?? null,
        timeToTargetTransit: candidate.timeToTargetTransit ?? null,
        targetTransitSummary: candidate.targetTransitSummary ?? null,
        photos: [...candidate.photos],
        details: [...candidate.details],
        houseType: candidate.houseType ?? null,
        buildingSeries: candidate.buildingSeries ?? null,
        repairState: candidate.repairState ?? null,
        metroName: candidate.metroName ?? null,
        metroDistanceText: candidate.metroDistanceText ?? null,
        metroDistanceType: candidate.metroDistanceType ?? null,
        sourcePayload: candidate.sourcePayload,
        priceChangedAt: new Date(),
        priceHistory: {
          create: {
            priceUsd: candidate.priceUsd,
            pricePerSqm: candidate.pricePerSqm
          }
        }
      }
    });

    this.logger.info(
      {
        listingId: updated.id,
        platform: updated.platform,
        externalId: updated.externalId,
        oldPriceUsd: Number(existing.priceUsd),
        newPriceUsd: Number(updated.priceUsd)
      },
      "Listing price changed"
    );

    return { status: "updated-price", listing: this.toPersistedListing(updated) };
  }

  private toPersistedListing(listing: PrismaListing): PersistedListing {
    return {
      id: listing.id,
      platform: listing.platform,
      externalId: listing.externalId,
      url: listing.url,
      title: listing.title,
      description: listing.description,
      rooms: listing.rooms,
      areaSqm: Number(listing.areaSqm),
      priceUsd: Number(listing.priceUsd),
      priceByn: listing.priceByn === null ? undefined : Number(listing.priceByn),
      pricePerSqm: Number(listing.pricePerSqm),
      latitude: listing.latitude === null ? undefined : Number(listing.latitude),
      longitude: listing.longitude === null ? undefined : Number(listing.longitude),
      timeToTargetTransit: listing.timeToTargetTransit === null ? undefined : listing.timeToTargetTransit,
      targetTransitSummary: listing.targetTransitSummary === null ? undefined : listing.targetTransitSummary,
      photos: listing.photos,
      details: listing.details,
      houseType: listing.houseType === null ? undefined : listing.houseType,
      buildingSeries: listing.buildingSeries === null ? undefined : listing.buildingSeries,
      repairState: listing.repairState === null ? undefined : listing.repairState,
      metroName: listing.metroName === null ? undefined : listing.metroName,
      metroDistanceText: listing.metroDistanceText === null ? undefined : listing.metroDistanceText,
      metroDistanceType:
        listing.metroDistanceType === "walking" || listing.metroDistanceType === "transport" ? listing.metroDistanceType : undefined
    };
  }
}
