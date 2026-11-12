import { assessListing, assessRenovation, comparableMatches } from "../domain/catalogScoring.js";
import { PRICE_POLICY } from "../domain/catalogPricePolicy.js";
import { featuresSchema, type CatalogItem, type Comparable, type ListingFeatures } from "../contracts/catalog.js";
import { approvedBuilding, approvedRepair, marketFeatures } from "../domain/repairEvidence.js";
import type { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import { haversineMeters } from "../utils/geoMath.js";
import type { Logger } from "../infrastructure/logger.js";
type Neighbor = Comparable & Pick<CatalogItem, "features" | "rooms" | "confirmedBuilding">;
type ComparableGroup = { comparables: Comparable[]; radius: number | null };

export class CatalogAssessmentService {
  constructor(private readonly repository: CatalogRepository, private readonly logger: Logger) {}
  async reassessAll(signal?: AbortSignal): Promise<boolean> {
    // Persisted inventory is the reference population; never grow a median inside an ingestion loop.
    const running = await this.repository.prisma.sourceSyncRun.count({ where: { status: "RUNNING" } });
    const initialized = await this.repository.prisma.sourceSyncRun.groupBy({ by: ["platform"], where: { status: { in: ["COMPLETE", "PARTIAL", "BLOCKED", "FAILED"] } } });
    if (running > 0 && initialized.length < 3) { this.logger.info({ running }, "Market assessment awaits initial source collection"); return false; }
    const settings = await this.repository.settings();
    let page = 1, assessed = 0;
    while (true) {
      const batch = await this.repository.page({ showHidden: true, showReview: true }, page, 100, "newest");
      for (const item of batch.items) {
        signal?.throwIfAborted();
        try {
          const neighbors = await this.neighbors(item);
          const features = marketFeatures(item.features, item.confirmedRepair);
          const { comparables, radius } = this.comparables(item, features, neighbors);
          const assessment = assessListing(item, comparables, radius, settings);
          if (item.renovationBudgetUsd != null) {
            const ready = this.comparables(item, { ...features, repair: "good", readiness: "ready" }, neighbors);
            assessment.renovationScenario = assessRenovation(item, item.renovationBudgetUsd, ready.comparables, ready.radius);
          }
          await this.repository.saveAssessment(item.id, assessment, item.assessmentRevision);
          assessed++;
        } catch (error: unknown) {
          this.logger.error({ err: error, propertyId: item.id }, "Assessment failed");
          await this.repository.prisma.property.update({ where: { id: item.id }, data: { assessmentError: "Ошибка расчёта оценки; будет повторная попытка", assessmentAttemptedAt: new Date() } });
        }
      }
      if (page >= batch.pages) break;
      if (page % 10 === 0) this.logger.info({ assessed, page, pages: batch.pages }, "Catalog assessment progress");
      page++;
    }
    this.logger.info({ assessed }, "Catalog assessment completed");
    return true;
  }
  private async neighbors(subject: CatalogItem): Promise<Neighbor[]> {
    if (subject.latitude === null || subject.longitude === null || !subject.features.marketZone || subject.features.isStudio === undefined) return [];
    const maxRadius = PRICE_POLICY.radiusMeters[2];
    const latDelta = maxRadius / 111320, lonDelta = latDelta / Math.cos(subject.latitude * Math.PI / 180);
    const rows = await this.repository.prisma.listing.findMany({ where: {
      isActive: true, isRepresentative: true, duplicateCheckPending: false, disposition: "ACCEPTED", propertyId: { not: subject.id },
      rooms: subject.rooms, isStudio: subject.features.isStudio, marketZone: subject.features.marketZone,
      areaSqm: { gte: subject.areaSqm * (1 - PRICE_POLICY.areaTolerance), lte: subject.areaSqm * (1 + PRICE_POLICY.areaTolerance) },
      lastSeenAt: { gte: new Date(Date.now() - PRICE_POLICY.freshnessDays * 86400_000) },
      latitude: { gte: subject.latitude - latDelta, lte: subject.latitude + latDelta }, longitude: { gte: subject.longitude - lonDelta, lte: subject.longitude + lonDelta }
    }, select: { propertyId: true, rooms: true, areaSqm: true, features: true, externalId: true, platform: true, address: true, priceUsd: true, pricePerSqm: true, latitude: true, longitude: true, photoSetHash: true, photos: true, title: true,
      photoRepair: { select: { galleryHash: true, status: true, decision: true, suggestion: true, evidence: true } } } });
    return rows.filter((c) => c.propertyId !== null)
      .map((c): Neighbor => {
        const feats = marketFeatures(featuresSchema.parse(c.features), approvedRepair(c.photoRepair, c.photoSetHash));
        return {
          propertyId: c.propertyId!, externalId: c.externalId, platform: c.platform, rooms: c.rooms,
          features: feats,
          confirmedBuilding: approvedBuilding(c.photoRepair, c.photoSetHash),
          address: c.address, priceUsd: Number(c.priceUsd), priceSqm: Number(c.pricePerSqm), areaSqm: Number(c.areaSqm),
          distanceMeters: Math.round(haversineMeters({ latitude: subject.latitude!, longitude: subject.longitude! }, { latitude: Number(c.latitude), longitude: Number(c.longitude) })),
          photo: c.photos[0] ?? null,
          photos: c.photos,
          floor: feats.floor,
          totalFloors: feats.totalFloors,
          buildingYear: feats.buildingYear,
          repair: feats.repair,
          title: c.title
        };
      })
      .filter((c) => c.distanceMeters <= maxRadius).sort((a, b) => a.distanceMeters - b.distanceMeters);
  }
  private comparables(subject: CatalogItem, features: ListingFeatures, neighbors: readonly Neighbor[]): ComparableGroup {
    const candidates = neighbors.filter((neighbor) => comparableMatches({ ...subject, features }, { ...neighbor, id: neighbor.propertyId, disposition: "ACCEPTED" }))
      .map(({ features: _features, confirmedBuilding: _building, ...comparable }): Comparable => comparable);
    for (const radius of PRICE_POLICY.radiusMeters) {
      const near = candidates.filter((c) => c.distanceMeters <= radius);
      if (near.length >= PRICE_POLICY.minimumComparables) return { comparables: near, radius };
    }
    return { comparables: candidates, radius: candidates.length ? PRICE_POLICY.radiusMeters[2] : null };
  }
}
