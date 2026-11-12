import type { Coordinates } from "../domain/geo.js";
import type { MarketStatsRepository, MedianMarketPrice } from "../infrastructure/repositories/marketStatsRepository.js";
import type { Logger } from "../infrastructure/logger.js";

export class MarketStatsService {
  constructor(
    private readonly repository: MarketStatsRepository,
    private readonly logger: Logger
  ) {}

  async medianPricePerSqmNear(
    rooms: number,
    coordinates: Coordinates | undefined,
    excludeListingId?: string | undefined
  ): Promise<MedianMarketPrice | undefined> {
    const median = await this.repository.medianPricePerSqmNear(rooms, coordinates, new Date(), excludeListingId);

    if (median === undefined) {
      this.logger.warn({ rooms, coordinates }, "No active comparable listings for dynamic median");
    }

    return median;
  }

  async medianPricePerSqm(rooms: number): Promise<number | undefined> {
    const median = await this.repository.medianPricePerSqm(rooms, new Date());

    if (median === undefined) {
      this.logger.warn({ rooms }, "No active comparable listings for dynamic median");
    }

    return median;
  }
}
