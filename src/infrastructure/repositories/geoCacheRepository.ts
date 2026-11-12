import type { PrismaClient } from "../../generated/prisma/client.js";
import type { WalkingRoute } from "../../domain/geo.js";

export type RoundedCoordinates = {
  readonly roundedLat: string;
  readonly roundedLon: string;
};

const GEO_CACHE_PROVIDER = "osrm-walking-v2";

export class GeoCacheRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findFresh(coordinates: RoundedCoordinates, now: Date): Promise<WalkingRoute | undefined> {
    const cached = await this.prisma.geoCache.findUnique({
      where: {
        roundedLat_roundedLon: {
          roundedLat: coordinates.roundedLat,
          roundedLon: coordinates.roundedLon
        }
      }
    });

    if (cached === null || cached.expiresAt <= now || cached.provider !== GEO_CACHE_PROVIDER) {
      return undefined;
    }

    return {
      nearestMetro: cached.nearestMetro,
      accessMode: cached.accessMode === "public-transit-estimate" ? "public-transit-estimate" : "walking",
      accessMinutes: cached.accessMinutes,
      walkingMinutes: cached.walkingMinutes,
      walkingMeters: cached.walkingMeters,
      straightLineMeters: cached.straightLineMeters,
      transitMinutes: cached.transitMinutes ?? undefined,
      provider: "osrm"
    };
  }

  async save(coordinates: RoundedCoordinates, route: WalkingRoute, expiresAt: Date): Promise<void> {
    await this.prisma.geoCache.upsert({
      where: {
        roundedLat_roundedLon: {
          roundedLat: coordinates.roundedLat,
          roundedLon: coordinates.roundedLon
        }
      },
      create: {
        roundedLat: coordinates.roundedLat,
        roundedLon: coordinates.roundedLon,
        nearestMetro: route.nearestMetro,
        accessMode: route.accessMode,
        accessMinutes: route.accessMinutes,
        walkingMinutes: route.walkingMinutes,
        walkingMeters: route.walkingMeters,
        straightLineMeters: route.straightLineMeters,
        transitMinutes: route.transitMinutes ?? null,
        provider: GEO_CACHE_PROVIDER,
        expiresAt
      },
      update: {
        nearestMetro: route.nearestMetro,
        accessMode: route.accessMode,
        accessMinutes: route.accessMinutes,
        walkingMinutes: route.walkingMinutes,
        walkingMeters: route.walkingMeters,
        straightLineMeters: route.straightLineMeters,
        transitMinutes: route.transitMinutes ?? null,
        provider: GEO_CACHE_PROVIDER,
        expiresAt
      }
    });
  }
}
