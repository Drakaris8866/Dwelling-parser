import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { Coordinates } from "../../domain/geo.js";
import type { MedianMarketSource } from "../../domain/market.js";
import { haversineMeters } from "../../utils/geoMath.js";

export type MedianMarketPrice = {
  readonly pricePerSqm: number;
  readonly source: MedianMarketSource;
  readonly comparableCount: number;
};

const MIN_LOCAL_COMPARABLES = 3;
const LOCAL_RADIUS_STEPS: readonly { readonly radiusMeters: number; readonly source: MedianMarketPrice["source"] }[] = [
  { radiusMeters: 2_000, source: "local-2km" },
  { radiusMeters: 4_000, source: "local-4km" },
  { radiusMeters: 6_000, source: "local-6km" }
];

export class MarketStatsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async medianPricePerSqmNear(
    rooms: number,
    coordinates: Coordinates | undefined,
    now: Date,
    excludeListingId?: string | undefined
  ): Promise<MedianMarketPrice | undefined> {
    if (coordinates !== undefined) {
      for (const step of LOCAL_RADIUS_STEPS) {
        const localPrices = await this.localComparablePrices(rooms, coordinates, step.radiusMeters, now, excludeListingId);
        if (localPrices.length >= MIN_LOCAL_COMPARABLES) {
          return {
            pricePerSqm: median(localPrices),
            source: step.source,
            comparableCount: localPrices.length
          };
        }
      }

      return undefined;
    }

    const globalPrices = await this.comparablePrices(rooms, now, excludeListingId);
    if (globalPrices.length === 0) {
      return undefined;
    }

    return {
      pricePerSqm: median(globalPrices),
      source: "global",
      comparableCount: globalPrices.length
    };
  }

  async medianPricePerSqm(rooms: number, now: Date): Promise<number | undefined> {
    const prices = await this.comparablePrices(rooms, now);
    return prices.length === 0 ? undefined : median(prices);
  }

  private async localComparablePrices(
    rooms: number,
    coordinates: Coordinates,
    radiusMeters: number,
    now: Date,
    excludeListingId: string | undefined
  ): Promise<readonly number[]> {
    const latitudeDelta = radiusMeters / 111_320;
    const longitudeDelta = radiusMeters / (111_320 * Math.cos((coordinates.latitude * Math.PI) / 180));
    const where: Prisma.ListingWhereInput = {
      rooms,
      ...(excludeListingId === undefined ? {} : { id: { not: excludeListingId } }),
      isActive: true,
      lastSeenAt: {
        gte: sinceDate(now)
      },
      latitude: {
        gte: coordinates.latitude - latitudeDelta,
        lte: coordinates.latitude + latitudeDelta
      },
      longitude: {
        gte: coordinates.longitude - longitudeDelta,
        lte: coordinates.longitude + longitudeDelta
      },
    };
    const rows = await this.prisma.listing.findMany({
      where,
      select: {
        pricePerSqm: true,
        latitude: true,
        longitude: true
      }
    });

    return rows
      .filter((row) => {
        if (row.latitude === null || row.longitude === null) {
          return false;
        }

        return haversineMeters(coordinates, {
          latitude: Number(row.latitude),
          longitude: Number(row.longitude)
        }) <= radiusMeters;
      })
      .map((row) => Number(row.pricePerSqm))
      .sort((left, right) => left - right);
  }

  private async comparablePrices(
    rooms: number,
    now: Date,
    excludeListingId: string | undefined = undefined
  ): Promise<readonly number[]> {
    const where: Prisma.ListingWhereInput = {
      rooms,
      ...(excludeListingId === undefined ? {} : { id: { not: excludeListingId } }),
      isActive: true,
      lastSeenAt: {
        gte: sinceDate(now)
      },
    };
    const rows = await this.prisma.listing.findMany({
      where,
      select: {
        pricePerSqm: true
      },
      orderBy: {
        pricePerSqm: "asc"
      }
    });

    return rows.map((row) => Number(row.pricePerSqm));
  }
}

const sinceDate = (now: Date): Date => new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

const median = (values: readonly number[]): number => {
  const rows = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(rows.length / 2);
  const right = rows[midpoint];

  if (right === undefined) {
    throw new Error("Cannot calculate median of an empty array");
  }

  if (rows.length % 2 === 1) {
    return right;
  }

  const left = rows[midpoint - 1];
  return left === undefined ? right : (left + right) / 2;
};
