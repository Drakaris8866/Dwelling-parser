import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CatalogItem, ListingFeatures } from "../contracts/catalog.js";
import { featuresSchema } from "../contracts/catalog.js";
import { PRICE_POLICY } from "../domain/catalogPricePolicy.js";
import { clampScore, conditionCriteria } from "../domain/catalogCriteria.js";
import { knownPriceFeatures } from "../domain/priceRating.js";
import { selectComparableGroup, PERSONAL_COMPARABLES_VERSION, type ComparableCandidate } from "../domain/personalComparables.js";
import { calculatePersonalRanking, PERSONAL_RANKING_VERSION } from "../domain/personalRanking.js";
import { canonicalRankingHash, resolvePublicationPrices, PUBLICATION_PRICE_POLICY_VERSION } from "../domain/rankingSnapshot.js";
import { estimateRenovation } from "../domain/renovationEstimate.js";
import type { PersonalRankingInput, PersonalRankingResult, PersonalRankingSettings, PersonalRankingSnapshotResponse } from "../contracts/personalRanking.js";
import { approvedRepair, marketFeatures } from "../domain/repairEvidence.js";
import { haversineMeters } from "../utils/geoMath.js";
import type { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import type { ShadowRankingRepository } from "../infrastructure/repositories/shadowRankingRepository.js";
import type { Logger } from "../infrastructure/logger.js";
import { realtHouseTypeLabel, realtRepairStateLabel } from "../infrastructure/sources/realtLabels.js";
import { inferFeatures, explicitElevator } from "../utils/listingFeatures.js";
import { originalUsdCurrency } from "../infrastructure/sources/sourcePriceCurrency.js";

export const personalRankingPilotIdsSchema = z.array(z.uuid()).min(1).max(100).transform((ids) => [...new Set(ids)].sort());

const recoverRealtFeatures = (features: ListingFeatures, row: { platform: string; houseType: string | null; repairState: string | null } | undefined): ListingFeatures => {
  if (row?.platform !== "REALT") return features;
  const inferred = inferFeatures({ title: "", description: "", details: [], rooms: 1,
    houseType: realtHouseTypeLabel(row.houseType), repairState: realtRepairStateLabel(row.repairState),
    features: { ...(features.repair === undefined ? {} : { repair: features.repair }), provenance: {} } });
  const recovered = { ...features, provenance: { ...features.provenance } };
  for (const key of ["buildingMaterial", "repair", "readiness"] as const) {
    if (features[key] === undefined && inferred[key] !== undefined) {
      Object.assign(recovered, { [key]: inferred[key] });
      recovered.provenance[key] ??= inferred.provenance[key]!;
    }
  }
  return recovered;
};

export class ShadowRankingService {
  constructor(private readonly catalogRepository: CatalogRepository, private readonly shadowRankingRepository: ShadowRankingRepository, private readonly logger: Pick<Logger, "info">) {}

  async getCurrentSnapshot(item: CatalogItem, now = new Date()): Promise<PersonalRankingSnapshotResponse> {
    const settings = await this.shadowRankingRepository.getSettings();
    if (!settings.previewEnabled) return { status: "disabled", snapshot: null };
    const prepared = await this.prepare(item, settings, item.renovationBudgetUsd ?? null, now);
    const current = await this.shadowRankingRepository.findSnapshot(item.id, prepared.inputHash);
    if (current) return { status: "current", snapshot: current };
    const snapshot = await this.shadowRankingRepository.findSnapshot(item.id);
    return { status: snapshot ? "stale" : "absent", snapshot };
  }

  async assessItem(item: CatalogItem, renovationBudgetUsd: number | null, now = new Date()): Promise<PersonalRankingResult> {
    const settings = await this.shadowRankingRepository.getSettings();
    const prepared = await this.prepare(item, settings, renovationBudgetUsd, now);
    const result = calculatePersonalRanking(prepared.input);
    await this.shadowRankingRepository.saveSnapshot({
      id: randomUUID(), propertyId: item.id, inputHash: prepared.inputHash, calculatedAt: now.toISOString(),
      asOf: prepared.asOf, settingsVersion: prepared.settingsVersion, purchaseUsd: prepared.input.purchaseUsd, result,
      inputs: prepared.input, settings, versions: { ranking: PERSONAL_RANKING_VERSION, comparables: PERSONAL_COMPARABLES_VERSION }, sourceHashes: prepared.sourceHashes,
      renovation: prepared.input.renovation, asIsComparables: [...prepared.input.asIsComparables], readyComparables: [...prepared.input.readyComparables],
      rejections: prepared.rejections, priceEvidence: prepared.priceEvidence
    });
    return result;
  }

  async runForIds(rawIds: readonly string[], signal?: AbortSignal): Promise<number> {
    const ids = personalRankingPilotIdsSchema.parse(rawIds);
    let assessed = 0;
    for (const id of ids) {
      signal?.throwIfAborted();
      const detail = await this.catalogRepository.detail(id);
      if (!detail || detail.item.hidden || detail.item.disposition !== "ACCEPTED") {
        this.logger.info({ propertyId: id }, "Shadow pilot skipped unavailable or ineligible property");
        continue;
      }
      await this.assessItem(detail.item, detail.item.renovationBudgetUsd ?? null);
      assessed++;
    }
    return assessed;
  }

  private async prepare(item: CatalogItem, settings: PersonalRankingSettings, manualBudget: number | null, now: Date) {
    const asOf = now.toISOString().slice(0, 10);
    const { candidates, priceEvidence, sourceIdentity, subjectPublication } = await this.fetchCandidates(item, now);
    const trustedRepair = subjectPublication?.photoSetHash
      ? approvedRepair(subjectPublication.photoRepair, subjectPublication.photoSetHash) : undefined;
    const market = marketFeatures(recoverRealtFeatures(item.features, subjectPublication), trustedRepair);
    const elevator = market.elevator ?? explicitElevator(item.description);
    const features = market.elevator === undefined && elevator !== undefined
      ? { ...market, elevator, provenance: { ...market.provenance, elevator: "description" as const } } : market;
    const subject = { propertyId: item.id, rooms: item.rooms, areaSqm: item.areaSqm, features };
    const minimumComparables = settings.minimumComparables ?? PRICE_POLICY.minimumComparables;
    const asIs = selectComparableGroup(subject, candidates, "as-is", now, minimumComparables);
    const readyCandidates = settings.targetLevel === "designer" ? candidates.filter((row) => row.features.repair === "designer") : candidates;
    const ready = selectComparableGroup(subject, readyCandidates, "ready", now, minimumComparables);
    const meetsTarget = features.readiness === "ready" && settings.targetLevel === "good" && trustedRepair === "good";
    const userAcceptsFinished = settings.zeroBudgetForFinishedRepair === true && features.readiness === "ready"
      && (features.repair === "cosmetic" || features.repair === "good" || features.repair === "designer");
    const condition = meetsTarget ? "meets-target" : userAcceptsFinished ? "user-finished"
      : features.repair === "none" || features.repair === "needs-repair" ? "full" : features.repair === "cosmetic" ? "cosmetic" : "unknown";
    const renovation = estimateRenovation({ areaSqm: item.areaSqm, condition, reservePct: settings.reservePct, asOf,
      manualBudgetUsd: manualBudget ?? item.renovationBudgetUsd, rates: settings.rates, fx: settings.fx, usdRate: settings.usdRate });
    // Repair/readiness already affect the budget, so only building facts contribute here.
    const houseCriteria = conditionCriteria(features, now.getUTCFullYear(), item.confirmedBuilding)
      .filter((criterion) => ["age", "material", "facade", "floor", "elevator"].includes(criterion.code));
    const house = houseCriteria.every((criterion) => criterion.score !== null)
      ? houseCriteria.reduce((sum, criterion) => sum + criterion.score! * criterion.weight, 0) / houseCriteria.reduce((sum, criterion) => sum + criterion.weight, 0) : undefined;
    const components = item.assessment?.components ?? [];
    const layout = components.find((component) => component.code === "layout")?.score ?? undefined;
    const location = components.find((component) => component.code === "location")?.score ?? undefined;
    const duration = item.routes?.target?.durationMinutes;
    const commute = duration == null ? undefined : clampScore(100 * (90 - duration) / 75);
    const input: PersonalRankingInput = {
      minimumComparables,
      purchaseUsd: subjectPublication?.priceUsd ?? item.priceUsd, areaSqm: item.areaSqm,
      // Refuse stale representative data instead of silently mixing its facts with a sibling price.
      eligible: item.disposition === "ACCEPTED" && !item.hidden && subjectPublication !== undefined
        && !subjectPublication.priceIsDisputed && subjectPublication.priceUsd === item.priceUsd,
      renovation, asIsComparables: asIs.comparables, readyComparables: ready.comparables, knownComparableFeatures: knownPriceFeatures(features),
      components: { ...(house === undefined ? {} : { house }), ...(commute === undefined ? {} : { commute }),
        ...(location === undefined ? {} : { location }), ...(layout === undefined ? {} : { layout }) }
    };
    const settingsVersion = canonicalRankingHash(settings);
    const inputHash = canonicalRankingHash({ version: PERSONAL_RANKING_VERSION, comparableVersion: PERSONAL_COMPARABLES_VERSION, publicationPriceVersion: PUBLICATION_PRICE_POLICY_VERSION, settingsVersion, asOf, item, sourceIdentity, input });
    const sourceHashes = sourceIdentity.map((row) => ({ propertyId: row.propertyId, externalId: row.externalId,
      platform: row.platform, contentHash: row.contentHash, galleryHash: row.photoSetHash,
      repairHash: canonicalRankingHash(row.photoRepair), routeHash: canonicalRankingHash(row.routeData) }));
    return { input, inputHash, settingsVersion, asOf, sourceHashes, priceEvidence, rejections: { asIs: asIs.rejected, ready: ready.rejected } };
  }

  private async fetchCandidates(item: CatalogItem, now: Date) {
    const rows = await this.catalogRepository.prisma.listing.findMany({
      where: { isActive: true, disposition: "ACCEPTED", propertyId: { not: null }, property: { hidden: false },
        lastSeenAt: { gte: new Date(now.getTime() - PRICE_POLICY.freshnessDays * 86_400_000), lte: now },
        OR: [{ property: { listings: { some: { marketZone: item.features.marketZone ?? "" } } } }, { propertyId: item.id }] },
      select: { id: true, propertyId: true, rooms: true, areaSqm: true, features: true, externalId: true, platform: true,
        address: true, priceUsd: true, priceByn: true, latitude: true, longitude: true, photoSetHash: true, contentHash: true,
        isActive: true, disposition: true, lastSeenAt: true, routeData: true, houseType: true, repairState: true,
        photoRepair: { select: { galleryHash: true, status: true, decision: true, suggestion: true, evidence: true } } }
    });
    const pricePayloads = await this.catalogRepository.publicationPricePayloads(rows.map((row) => row.id));
    const sourcePrices = new Map(pricePayloads.map((row) => [`${row.platform}:${row.externalId}`, row.payload]));
    const publications = rows.filter((row) => row.propertyId !== null).map((row) => {
      const priceUsd = Number(row.priceUsd), priceCurrency = originalUsdCurrency(row.platform, sourcePrices.get(`${row.platform}:${row.externalId}`), priceUsd);
      return { ...row, propertyId: row.propertyId!, priceUsd, priceByn: row.priceByn == null ? null : Number(row.priceByn), ...(priceCurrency ? { priceCurrency } : {}) };
    });
    const resolved = resolvePublicationPrices(publications);
    const candidates: ComparableCandidate[] = [];
    for (const row of resolved.rows) {
      if (row.propertyId === item.id || row.latitude === null || row.longitude === null || item.latitude === null || item.longitude === null) continue;
      const parsed = featuresSchema.safeParse(row.features);
      if (!parsed.success) continue;
      candidates.push({ propertyId: row.propertyId, externalId: row.externalId, platform: row.platform, rooms: row.rooms,
        features: marketFeatures(recoverRealtFeatures(parsed.data, row), approvedRepair(row.photoRepair, row.photoSetHash)), address: row.address,
        priceUsd: row.priceUsd, priceSqm: row.priceUsd / Number(row.areaSqm), areaSqm: Number(row.areaSqm),
        distanceMeters: haversineMeters({ latitude: item.latitude, longitude: item.longitude }, { latitude: Number(row.latitude), longitude: Number(row.longitude) }),
        isActive: row.isActive, disposition: "ACCEPTED", lastSeenAt: row.lastSeenAt, priceIsDisputed: row.priceIsDisputed });
    }
    return { candidates, priceEvidence: resolved.evidence,
      sourceIdentity: [...publications].sort((a, b) => a.propertyId.localeCompare(b.propertyId) || a.platform.localeCompare(b.platform) || a.externalId.localeCompare(b.externalId)),
      subjectPublication: resolved.rows.find((row) => row.propertyId === item.id) };
  }
}
