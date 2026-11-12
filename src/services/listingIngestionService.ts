import { AlertStatus } from "../generated/prisma/client.js";
import type { Coordinates, WalkingRoute } from "../domain/geo.js";
import type { ListingCandidate, PersistedListing } from "../domain/listing.js";
import type { ScoreResult, ScoringService } from "../domain/scoring.js";
import type { AlertRepository } from "../infrastructure/repositories/alertRepository.js";
import type { ListingRepository } from "../infrastructure/repositories/listingRepository.js";
import type { ListingSource } from "../infrastructure/sources/listingSource.js";
import type { Logger } from "../infrastructure/logger.js";
import type { AppConfig } from "../config/env.js";
import { parseTextSignals } from "../utils/textParser.js";
import type { GeoService } from "./geoService.js";
import type { MarketStatsService } from "./marketStatsService.js";
import type { RoutingService } from "./routingService.js";
import type { TelegramAlertService } from "./telegramAlertService.js";

export class ListingIngestionService {
  private readonly replayedSources = new Set<string>();

  constructor(
    private readonly config: Pick<AppConfig, "telegramReplayAlertsOnDev" | "telegramSendAllScoredOnDev">,
    private readonly listingRepository: ListingRepository,
    private readonly marketStatsService: MarketStatsService,
    private readonly geoService: GeoService,
    private readonly routingService: RoutingService,
    private readonly scoringService: ScoringService,
    private readonly telegramAlertService: TelegramAlertService,
    private readonly alertRepository: AlertRepository,
    private readonly logger: Logger
  ) {}

  async ingestSource(source: ListingSource): Promise<void> {
    try {
      const candidates = await source.poll();
      this.logger.info({ source: source.name, count: candidates.length }, "Source polling completed");
      const replayAlerts = this.shouldReplayAlertsForSource(source.name);
      if (this.config.telegramSendAllScoredOnDev) {
        this.logger.warn({ source: source.name }, "Telegram test mode enabled: all scored listings will be sent");
      }
      const listingsToScore: PersistedListing[] = [];

      for (const candidate of candidates) {
        if (!this.isSupportedRoomProfile(candidate)) {
          continue;
        }

        const listing = await this.persistCandidate(candidate, { replayAlerts });
        if (listing !== undefined) {
          listingsToScore.push(listing);
        }
      }

      this.logger.info({ source: source.name, count: listingsToScore.length }, "Listings persisted for scoring");

      for (const listing of listingsToScore) {
        await this.scoreListing(listing, { replayAlerts, sendAllScoredListings: this.config.telegramSendAllScoredOnDev });
      }
    } catch (error: unknown) {
      this.logger.error({ err: error, source: source.name }, "Source ingestion failed");
    }
  }

  private shouldReplayAlertsForSource(sourceName: string): boolean {
    if (!this.config.telegramReplayAlertsOnDev || this.replayedSources.has(sourceName)) {
      return false;
    }

    this.replayedSources.add(sourceName);
    this.logger.warn({ source: sourceName }, "Telegram alert replay enabled for this source startup poll");
    return true;
  }

  private async persistCandidate(
    candidate: ListingCandidate,
    options: { readonly replayAlerts: boolean }
  ): Promise<PersistedListing | undefined> {
    try {
      const enrichedCandidate = await this.enrichWithTransitTime(candidate);
      const result = await this.listingRepository.upsertChanged(enrichedCandidate, { reprocessUnchanged: options.replayAlerts });

      if (result.status === "skipped-unchanged") {
        return undefined;
      }

      return result.listing;
    } catch (error: unknown) {
      this.logger.error(
        {
          err: error,
          platform: candidate.platform,
          externalId: candidate.externalId
        },
        "Failed to persist listing candidate"
      );
      return undefined;
    }
  }

  private async enrichWithTransitTime(candidate: ListingCandidate): Promise<ListingCandidate> {
    if (candidate.latitude === undefined || candidate.longitude === undefined) {
      return candidate;
    }

    const targetRoute = await this.routingService.getTransitRouteToTarget(candidate.latitude, candidate.longitude);
    return {
      ...candidate,
      timeToTargetTransit: targetRoute?.durationMinutes,
      targetTransitSummary: targetRoute?.summary
    };
  }

  private async scoreListing(
    listing: PersistedListing,
    options: { readonly replayAlerts: boolean; readonly sendAllScoredListings: boolean }
  ): Promise<void> {
    try {
      const coordinates = this.coordinates(listing);
      const median = await this.marketStatsService.medianPricePerSqmNear(listing.rooms, coordinates, listing.id);
      if (median === undefined) {
        return;
      }

      const route = await this.resolveRoute(listing);
      const score = this.scoringService.score({
        listing,
        medianPricePerSqm: median.pricePerSqm,
        medianSource: median.source,
        medianComparableCount: median.comparableCount,
        walkingRoute: route
      });

      await this.maybeAlert(listing, score, route, options);
    } catch (error: unknown) {
      this.logger.error(
        {
          err: error,
          platform: listing.platform,
          externalId: listing.externalId,
          listingId: listing.id
        },
        "Failed to score listing"
      );
    }
  }

  private isSupportedRoomProfile(candidate: ListingCandidate): boolean {
    const textSignals = parseTextSignals([
      candidate.title,
      candidate.description,
      candidate.houseType,
      candidate.buildingSeries,
      candidate.repairState,
      ...candidate.details
    ]);
    const isUnsupported =
      textSignals.hasStudioLayout ||
      textSignals.hasPrivateHouse ||
      textSignals.hasPartialOwnership ||
      textSignals.hasRentalIntent ||
      textSignals.isMinskWorld ||
      !textSignals.isAllowedLocality;

    if (isUnsupported) {
      this.logger.info(
        {
          platform: candidate.platform,
          externalId: candidate.externalId,
          rooms: candidate.rooms,
          areaSqm: candidate.areaSqm,
          priceUsd: candidate.priceUsd,
          hasStudioLayout: textSignals.hasStudioLayout,
          hasPrivateHouse: textSignals.hasPrivateHouse,
          hasPartialOwnership: textSignals.hasPartialOwnership,
          hasRentalIntent: textSignals.hasRentalIntent,
          isMinskWorld: textSignals.isMinskWorld,
          isAllowedLocality: textSignals.isAllowedLocality
        },
        "Skipping listing outside supported room profile"
      );
    }

    return !isUnsupported;
  }

  private async resolveRoute(listing: PersistedListing): Promise<WalkingRoute | undefined> {
    const coordinates = this.coordinates(listing);
    return coordinates === undefined ? undefined : await this.geoService.walkingRouteToNearestMetro(coordinates);
  }

  private coordinates(listing: PersistedListing): Coordinates | undefined {
    if (listing.latitude === undefined || listing.longitude === undefined) {
      return undefined;
    }

    return {
      latitude: listing.latitude,
      longitude: listing.longitude
    };
  }

  private async maybeAlert(
    listing: PersistedListing,
    score: ScoreResult,
    route: WalkingRoute | undefined,
    options: { readonly replayAlerts: boolean; readonly sendAllScoredListings: boolean }
  ): Promise<void> {
    if (!score.shouldAlert && !options.sendAllScoredListings) {
      return;
    }

    if (!options.replayAlerts) {
      const hasRecentAlert = await this.alertRepository.hasRecentAlert(listing.id, new Date());
      if (hasRecentAlert) {
        return;
      }
    }

    try {
      await this.telegramAlertService.send({ listing, score, route });
      await this.alertRepository.record({
        listingId: listing.id,
        fairPriceSqm: score.fairPricePerSqm,
        actualPriceSqm: score.actualPricePerSqm,
        discountPct: score.discountPct,
        status: AlertStatus.SENT,
        sentAt: new Date()
      });
    } catch (error: unknown) {
      await this.alertRepository.record({
        listingId: listing.id,
        fairPriceSqm: score.fairPricePerSqm,
        actualPriceSqm: score.actualPricePerSqm,
        discountPct: score.discountPct,
        status: AlertStatus.FAILED,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      this.logger.error({ err: error, listingId: listing.id }, "Failed to send Telegram alert");
    }
  }
}
