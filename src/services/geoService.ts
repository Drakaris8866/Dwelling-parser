import type { Coordinates, WalkingRoute } from "../domain/geo.js";
import type { AppConfig } from "../config/env.js";
import type { MetroStation } from "../domain/geo.js";
import { MINSK_METRO_STATIONS } from "../infrastructure/geo/minskMetroStations.js";
import type { OsrmRouteClient } from "../infrastructure/geo/osrmRouteClient.js";
import type { GeoCacheRepository, RoundedCoordinates } from "../infrastructure/repositories/geoCacheRepository.js";
import type { Logger } from "../infrastructure/logger.js";
import { estimateWalkingMinutes, haversineMeters } from "../utils/geoMath.js";

type StationDistance = {
  readonly station: MetroStation;
  readonly straightLineMeters: number;
};

type CandidateRoute = WalkingRoute & {
  readonly stationStraightLineMeters: number;
};

export class GeoService {
  constructor(
    private readonly config: Pick<AppConfig, "geoCacheTtlDays">,
    private readonly geoCacheRepository: GeoCacheRepository,
    private readonly osrmRouteClient: OsrmRouteClient,
    private readonly logger: Logger
  ) {}

  async walkingRouteToNearestMetro(coordinates: Coordinates): Promise<WalkingRoute | undefined> {
    const rounded = this.roundCoordinates(coordinates);
    const now = new Date();
    const cached = await this.geoCacheRepository.findFresh(rounded, now);

    if (cached !== undefined) {
      return cached;
    }

    const route = await this.calculateNearestMetroRoute(coordinates);

    if (route === undefined) {
      this.logger.warn({ coordinates }, "No route available for coordinates");
      return undefined;
    }

    const expiresAt = new Date(now.getTime() + this.config.geoCacheTtlDays * 24 * 60 * 60 * 1000);
    await this.geoCacheRepository.save(rounded, route, expiresAt);
    return route;
  }

  private roundCoordinates(coordinates: Coordinates): RoundedCoordinates {
    return {
      roundedLat: coordinates.latitude.toFixed(4),
      roundedLon: coordinates.longitude.toFixed(4)
    };
  }

  private async calculateNearestMetroRoute(coordinates: Coordinates): Promise<WalkingRoute | undefined> {
    const nearestStations = this.nearestStations(coordinates, 6);
    const candidates: CandidateRoute[] = [];

    for (const stationDistance of nearestStations) {
      const osrmRoute = await this.osrmRouteClient.walkingRoute(coordinates, stationDistance.station);

      if (osrmRoute === undefined) {
        continue;
      }

      const walkingMinutes = Math.max(osrmRoute.durationMinutes, estimateWalkingMinutes(stationDistance.straightLineMeters));
      candidates.push({
        nearestMetro: stationDistance.station.name,
        accessMode: "walking",
        accessMinutes: walkingMinutes,
        walkingMinutes,
        walkingMeters: osrmRoute.distanceMeters,
        straightLineMeters: Math.round(stationDistance.straightLineMeters),
        provider: "osrm",
        stationStraightLineMeters: stationDistance.straightLineMeters
      });
    }

    const bestByAccess = candidates.toSorted((left, right) => left.walkingMinutes - right.walkingMinutes)[0];

    if (bestByAccess !== undefined) {
      return bestByAccess;
    }

    const nearest = nearestStations[0];
    if (nearest === undefined) {
      return undefined;
    }

    const walkingMinutes = estimateWalkingMinutes(nearest.straightLineMeters);
    this.logger.warn({ coordinates }, "Using walking estimate because OSRM returned no routes");

    return {
      nearestMetro: nearest.station.name,
      accessMode: "walking",
      accessMinutes: walkingMinutes,
      walkingMinutes,
      walkingMeters: Math.round(nearest.straightLineMeters),
      straightLineMeters: Math.round(nearest.straightLineMeters),
      provider: "osrm"
    };
  }

  private nearestStations(coordinates: Coordinates, limit: number): readonly StationDistance[] {
    return MINSK_METRO_STATIONS.map((station) => ({
      station,
      straightLineMeters: haversineMeters(coordinates, station)
    }))
      .toSorted((left, right) => left.straightLineMeters - right.straightLineMeters)
      .slice(0, limit);
  }
}
