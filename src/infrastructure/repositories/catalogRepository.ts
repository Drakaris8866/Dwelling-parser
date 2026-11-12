import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type Listing } from "../../generated/prisma/client.js";
import type { ListingCandidate } from "../../domain/listing.js";
import { classifyListing, PARTIAL_SALE_REASON } from "../../domain/exclusions.js";
import { assessmentSchema, featuresSchema, routingDataSchema, settingsSchema, repairSchema, DEFAULT_SETTINGS, type CatalogItem, type CatalogFilters, type CatalogSort, type CatalogPage, type CatalogDetail, type CatalogSettings, type ListingFeatures, type CatalogAssessment, type Comparable } from "../../contracts/catalog.js";
import { inferFeatures } from "../../utils/listingFeatures.js";
import { toPrismaJson, canonicalJson } from "../../utils/json.js";
import { normalizeSourceImageUrl } from "../../utils/sourceImages.js";
import { sourceDescriptionSnapshot } from "../../utils/sourceDescription.js";
import { catalogProcessing } from "../../domain/catalogStatus.js";
import { approvedBuilding, approvedRepair, buildingSuggestionFromEvidence, repairSuggestionFromEvidence } from "../../domain/repairEvidence.js";
import { galleryFingerprint } from "../../utils/galleryFingerprint.js";
import { photoEvidenceSchema, photoRepairSchema } from "../../contracts/photoRepair.js";
import { hasStreetAddress } from "../../utils/duplicateEvidence.js";

const include = { photoRepair: true, property: { include: { assessment: true, listings: {
  where: { isActive: true, duplicateCheckPending: false, NOT: { exclusionReasons: { has: PARTIAL_SALE_REASON } } },
  orderBy: [{ priceUsd: "asc" }, { id: "asc" }], select: { platform: true, externalId: true, url: true, priceUsd: true, lastSeenAt: true, address: true, disposition: true }
} } } } satisfies Prisma.ListingInclude;
type CatalogRow = Prisma.ListingGetPayload<{ include: typeof include }>;
export const refreshRepresentative = async (database: Pick<PrismaClient, "listing">, propertyId: string): Promise<void> => {
  const cheapest = await database.listing.findFirst({ where: { propertyId, isActive: true, disposition: "ACCEPTED", duplicateCheckPending: false }, orderBy: [{ priceUsd: "asc" }, { id: "asc" }] });
  const ready = cheapest && cheapest.routeStatus !== "READY" ? await database.listing.findFirst({ where: { propertyId, isActive: true, disposition: "ACCEPTED",
    duplicateCheckPending: false, routeStatus: "READY", timeToTargetTransit: { not: null }, priceUsd: { lte: cheapest.priceUsd.plus(1) } }, orderBy: [{ priceUsd: "asc" }, { id: "asc" }] }) : null;
  const preferred = ready ?? cheapest
    ?? await database.listing.findFirst({ where: { propertyId, isActive: true, duplicateCheckPending: false, disposition: "REVIEW" }, orderBy: { priceUsd: "asc" } })
    ?? await database.listing.findFirst({ where: { propertyId, isActive: true }, orderBy: { priceUsd: "asc" } });
  await database.listing.updateMany({ where: { propertyId, isRepresentative: true, ...(preferred ? { id: { not: preferred.id } } : {}) }, data: { isRepresentative: false } });
  if (preferred && !preferred.isRepresentative) await database.listing.update({ where: { id: preferred.id }, data: { isRepresentative: true } });
};
const optionalRange = (gte: number | undefined, lte: number | undefined): Prisma.FloatNullableFilter | undefined =>
  gte === undefined && lte === undefined ? undefined : { ...(gte === undefined ? {} : { gte }), ...(lte === undefined ? {} : { lte }) };
const decimalRange = (gte: number | undefined, lte: number | undefined): Prisma.DecimalFilter => ({ ...(gte === undefined ? {} : { gte }), ...(lte === undefined ? {} : { lte }) });

export const buildListingWhere = (filters: CatalogFilters, fields: PrismaClient["listing"]["fields"]): Prisma.ListingWhereInput => {
  const f = filters;
  const and: Prisma.ListingWhereInput[] = [{ isActive: true, isRepresentative: true, duplicateCheckPending: false, propertyId: { not: null }, disposition: { in: f.showReview ? ["ACCEPTED", "REVIEW"] : ["ACCEPTED"] } }];
  if (!f.showHidden) and.push({ property: { hidden: false } });
  if (f.favoritesOnly) and.push({ property: { favorite: true } });
  if (f.platforms?.length) and.push({ property: { listings: { some: { platform: { in: f.platforms }, isActive: true } } } });
  if (f.rooms?.length) and.push({ rooms: { in: f.rooms } });
  if (f.studio !== undefined) and.push({ isStudio: f.studio });
  if (f.text) and.push({ OR: ["title", "description", "address"].map((field) => ({ [field]: { contains: f.text, mode: "insensitive" } })) });
  if (f.minPrice !== undefined || f.maxPrice !== undefined) and.push({ priceUsd: decimalRange(f.minPrice, f.maxPrice) });
  if (f.minPriceSqm !== undefined || f.maxPriceSqm !== undefined) and.push({ pricePerSqm: decimalRange(f.minPriceSqm, f.maxPriceSqm) });
  if (f.minArea !== undefined || f.maxArea !== undefined) and.push({ areaSqm: decimalRange(f.minArea, f.maxArea) });
  const numeric: readonly ["kitchenSqm" | "livingSqm" | "floor" | "buildingYear", number | undefined, number | undefined][] = [
    ["kitchenSqm", f.minKitchen, f.maxKitchen], ["livingSqm", f.minLiving, f.maxLiving], ["floor", f.minFloor, f.maxFloor], ["buildingYear", f.minYear, f.maxYear]
  ];
  for (const [field, min, max] of numeric) if (min !== undefined || max !== undefined) and.push({ [field]: optionalRange(min, max) });
  for (const [field, values] of [["locality", f.localities], ["district", f.districts], ["repairCategory", f.repair], ["buildingMaterial", f.materials], ["layoutType", f.layout], ["sellerType", f.sellers], ["readiness", f.readiness]] as const) {
    if (values?.length) and.push({ [field]: { in: values } });
  }
  if (f.balcony !== undefined) and.push({ balcony: f.balcony });
  if (f.elevator !== undefined) and.push({ elevator: f.elevator });
  if (f.notFirstFloor) and.push({ floor: { not: null, gt: 1 } });
  if (f.notLastFloor) and.push({ floor: { not: null, lt: fields.totalFloors } });
  if (f.maxTransit !== undefined) and.push({ timeToTargetTransit: { lte: f.maxTransit } });
  if (f.minValueScore !== undefined) and.push({ property: { assessment: { valueScore: { gte: f.minValueScore } } } });
  if (f.minComfortScore !== undefined) and.push({ property: { assessment: { comfortScore: { gte: f.minComfortScore }, coverage: { gte: 70 } } } });
  if (f.confidence?.length) and.push({ property: { assessment: { confidence: { in: f.confidence } } } });
  if (f.maxMetroWalk !== undefined) and.push({ routeData: { path: ["metro", "durationMinutes"], lte: f.maxMetroWalk } });
  if (f.bounds) and.push({ latitude: { gte: f.bounds.south, lte: f.bounds.north }, longitude: { gte: f.bounds.west, lte: f.bounds.east } });
  return { AND: and };
};

export const rowToCandidate = (row: Listing): ListingCandidate => ({
  platform: row.platform, externalId: row.externalId, url: row.url, title: row.title, description: row.description,
  rooms: row.rooms, areaSqm: Number(row.areaSqm), priceUsd: Number(row.priceUsd),
  priceByn: row.priceByn === null ? undefined : Number(row.priceByn), pricePerSqm: Number(row.pricePerSqm),
  latitude: row.latitude === null ? undefined : Number(row.latitude), longitude: row.longitude === null ? undefined : Number(row.longitude),
  photos: row.photos, details: row.details, houseType: row.houseType ?? undefined, repairState: row.repairState ?? undefined,
  buildingSeries: row.buildingSeries ?? undefined, sourcePayload: toPrismaJson(row.sourcePayload),
  descriptionComplete: featuresSchema.safeParse(row.features).success ? featuresSchema.parse(row.features).descriptionComplete : undefined,
  features: featuresSchema.safeParse(row.features).success ? featuresSchema.parse(row.features) : undefined
});

export class CatalogRepository {
  async publicationPricePayloads(ids: readonly string[]): Promise<{ platform: string; externalId: string; payload: unknown }[]> {
    if (ids.length === 0) return [];
    return this.prisma.$queryRaw`
      SELECT platform::text AS platform, "externalId",
        CASE platform
          WHEN 'KUFAR' THEN jsonb_build_object('currency', "sourcePayload"->'currency', 'price_usd', "sourcePayload"->'price_usd')
          WHEN 'ONLINER' THEN jsonb_build_object('price', jsonb_build_object('currency', "sourcePayload"->'price'->'currency', 'amount', "sourcePayload"->'price'->'amount'))
          ELSE NULL
        END AS payload
      FROM "Listing" WHERE id = ANY(${[...ids]}::text[])`;
  }
  constructor(readonly prisma: PrismaClient) {}

  async settings(): Promise<CatalogSettings> {
    const row = await this.prisma.appSettings.findUnique({ where: { id: 1 } });
    return row ? settingsSchema.parse(row.data) : DEFAULT_SETTINGS;
  }
  async saveSettings(value: CatalogSettings): Promise<void> {
    await this.prisma.appSettings.upsert({ where: { id: 1 }, create: { id: 1, data: toPrismaJson(value) }, update: { data: toPrismaJson(value) } });
  }

  async invalidateLegacyCommutes(version: number): Promise<void> {
    const stale = Prisma.sql`l."isActive" AND (l."routeData" IS NOT NULL OR l."timeToTargetTransit" IS NOT NULL)
      AND (l."routeData"->>'policyVersion') IS DISTINCT FROM ${String(version)}`;
    await this.prisma.$transaction([
      this.prisma.$executeRaw`UPDATE "Assessment" a SET "comfortScore" = NULL, "coverage" = 0 FROM "Listing" l
        WHERE a."propertyId" = l."propertyId" AND l."isRepresentative" AND ${stale}`,
      this.prisma.$executeRaw`UPDATE "Listing" l SET "routeData" = NULL, "routeStatus" = 'PENDING', "routeError" = NULL,
        "routeAttemptedAt" = NULL, "timeToTargetTransit" = NULL, "targetTransitSummary" = NULL WHERE ${stale}`
    ]);
  }

  async observe(candidate: ListingCandidate, runId?: string, options: { recordObservation?: boolean; expectedHash?: string | null } = {}): Promise<{ listing: Listing; changed: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.listing.findUnique({ where: { platform_externalId: { platform: candidate.platform, externalId: candidate.externalId } } });
      if (existing && options.expectedHash !== undefined && existing.contentHash !== options.expectedHash) return { listing: existing, changed: false };
      const old = featuresSchema.safeParse(existing?.features);
      const incoming = inferFeatures(candidate);
      const defined = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined));
      const retainVerifiedType = incoming.propertyType === "unknown" && old.success && old.data.provenance["propertyType"] === "description";
      const descriptionSnapshot = sourceDescriptionSnapshot(candidate.sourcePayload);
      const previewOnly = candidate.descriptionComplete === false;
      const retainDescription = previewOnly && old.success && old.data.provenance["description"] === "structured" && Boolean(existing?.description);
      const retainCompleteness = retainDescription && old.data.descriptionComplete === true
        && sourceDescriptionSnapshot(toPrismaJson(existing!.sourcePayload)) === descriptionSnapshot;
      const f = featuresSchema.parse({ ...(old.success ? old.data : {}), ...defined,
        ...(retainVerifiedType ? { propertyType: old.data.propertyType } : {}),
        ...(candidate.descriptionComplete !== undefined ? { descriptionComplete: candidate.descriptionComplete } : {}),
        ...(retainCompleteness ? { descriptionComplete: true } : {}),
        provenance: { ...(old.success ? old.data.provenance : {}), ...incoming.provenance,
          ...(retainDescription || candidate.descriptionComplete === true ? { description: "structured" } : {}), ...(retainVerifiedType ? { propertyType: "description" } : {}) } });
      const detailMap = new Map<string, string>();
      for (const detail of [...existing?.details ?? [], ...candidate.details]) detailMap.set(detail.split(":")[0]!, detail);
      const normalized = { ...candidate, title: candidate.title || existing?.title || "Квартира", description: retainDescription ? existing!.description : candidate.description || existing?.description || "",
        photos: candidate.photosComplete === false ? [...new Set([...(existing?.photos ?? []), ...candidate.photos])] : candidate.photos.length ? candidate.photos : existing?.photos ?? [],
        details: [...detailMap.values()].sort(), features: f };
      const freshDecision = classifyListing(candidate, f);
      const decision = freshDecision.disposition === "EXCLUDED" ? freshDecision : classifyListing(normalized, f);
      const requiresDuplicateCheck = decision.disposition === "ACCEPTED"
        && (!existing?.propertyId || existing.disposition !== "ACCEPTED" || !existing.isActive);
      const latitude = candidate.latitude === undefined ? existing?.latitude ?? null : new Prisma.Decimal(candidate.latitude).toDecimalPlaces(6);
      const longitude = candidate.longitude === undefined ? existing?.longitude ?? null : new Prisma.Decimal(candidate.longitude).toDecimalPlaces(6);
      const hash = createHash("sha256").update(canonicalJson({ url: normalized.url, title: normalized.title, description: normalized.description, rooms: normalized.rooms,
        descriptionSnapshot,
        areaSqm: normalized.areaSqm, priceUsd: normalized.priceUsd, priceByn: normalized.priceByn ?? (existing?.priceByn === null || existing?.priceByn === undefined ? null : Number(existing.priceByn)),
        latitude: latitude?.toNumber() ?? null, longitude: longitude?.toNumber() ?? null,
        photos: normalized.photos, details: normalized.details, features: f })).digest("hex");
      const priceChanged = existing !== null && Number(existing.priceUsd) !== candidate.priceUsd;
      const coordinatesChanged = existing !== null && ((existing.latitude?.toNumber() ?? null) !== (latitude?.toNumber() ?? null)
        || (existing.longitude?.toNumber() ?? null) !== (longitude?.toNumber() ?? null));
      const propertyId = existing?.propertyId ?? (await tx.property.create({ data: {} })).id;
      const photoSetHash = galleryFingerprint(normalized.photos);
      const data = {
        title: normalized.title, description: normalized.description, url: candidate.url,
        rooms: candidate.rooms, areaSqm: candidate.areaSqm, priceUsd: candidate.priceUsd, priceByn: candidate.priceByn ?? existing?.priceByn ?? null,
        pricePerSqm: candidate.pricePerSqm, latitude, longitude,
        photos: [...normalized.photos], photoSetHash, details: normalized.details,
        houseType: candidate.houseType ?? existing?.houseType ?? null, repairState: candidate.repairState ?? existing?.repairState ?? null,
        buildingSeries: candidate.buildingSeries ?? existing?.buildingSeries ?? null,
        metroName: candidate.metroName ?? existing?.metroName ?? null, metroDistanceText: candidate.metroDistanceText ?? existing?.metroDistanceText ?? null,
        metroDistanceType: candidate.metroDistanceType ?? existing?.metroDistanceType ?? null,
        sourcePayload: candidate.sourcePayload, contentHash: hash, features: toPrismaJson(f),
        address: f.address ?? null, locality: f.locality ?? null, district: f.district ?? null, marketZone: f.marketZone ?? null,
        isStudio: f.isStudio ?? null, kitchenSqm: f.kitchenSqm ?? null, livingSqm: f.livingSqm ?? null, floor: f.floor ?? null,
        totalFloors: f.totalFloors ?? null, buildingYear: f.buildingYear ?? null, buildingMaterial: f.buildingMaterial ?? null,
        repairCategory: f.repair ?? null, layoutType: f.layout ?? null, balcony: f.balcony ?? null, elevator: f.elevator ?? null,
        bathroom: f.bathroom ?? null, sellerType: f.seller ?? null, readiness: f.readiness ?? null,
        disposition: decision.disposition, exclusionReasons: [...decision.reasons],
        ...(requiresDuplicateCheck ? { duplicateCheckPending: true } : {}),
        ...(options.recordObservation === false ? {} : { lastSeenAt: new Date(), isActive: true, missedCompleteRuns: 0, lastCompleteMissAt: null, lastCompleteMissRunId: null }),
        ...(runId ? { observedRunId: runId } : {}),
        ...(priceChanged ? { priceChangedAt: new Date() } : {}),
        ...(coordinatesChanged ? { routeStatus: "PENDING", routeError: null, routeAttemptedAt: null, routeData: Prisma.DbNull, timeToTargetTransit: null, targetTransitSummary: null } : {}),
        ...(options.recordObservation !== false && existing?.contentHash !== hash ? { enrichmentStatus: "PENDING" } : {})
      };
      const listing = existing ? await tx.listing.update({ where: { id: existing.id }, data: { ...data, ...(!existing.propertyId ? { propertyId } : {}), ...(priceChanged ? { priceHistory: { create: { priceUsd: candidate.priceUsd, pricePerSqm: candidate.pricePerSqm } } } : {}) } })
        : await tx.listing.create({ data: { ...data, propertyId, platform: candidate.platform, externalId: candidate.externalId, priceHistory: { create: { priceUsd: candidate.priceUsd, pricePerSqm: candidate.pricePerSqm } } } });
      const currentPropertyId = listing.propertyId ?? propertyId;
      if (existing?.photoSetHash && existing.photoSetHash !== photoSetHash) {
        const analysis = await tx.photoRepairAnalysis.findUnique({ where: { listingId: existing.id } });
        if (approvedRepair(analysis, existing.photoSetHash) || approvedBuilding(analysis, existing.photoSetHash)) {
          await tx.property.update({ where: { id: currentPropertyId }, data: { assessmentRevision: { increment: 1 } } });
          await tx.assessment.updateMany({ where: { propertyId: currentPropertyId }, data: { valueScore: null, comfortScore: null, coverage: 0, data: {} } });
        }
      }
      if (existing?.propertyId && (priceChanged || existing.disposition !== decision.disposition || !existing.isActive)) await refreshRepresentative(tx, currentPropertyId);
      return { listing, changed: existing?.contentHash !== hash };
    });
  }

  async completeDuplicateCheck(snapshot: Pick<Listing, "id" | "propertyId" | "contentHash">): Promise<boolean> {
    if (!snapshot.propertyId) return false;
    const propertyId = snapshot.propertyId;
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.listing.updateMany({ where: {
        id: snapshot.id, propertyId, contentHash: snapshot.contentHash, duplicateCheckPending: true, isActive: true, disposition: "ACCEPTED"
      }, data: { duplicateCheckPending: false } });
      if (result.count) await refreshRepresentative(tx, propertyId);
      return result.count > 0;
    });
  }

  async item(id: string): Promise<CatalogItem | null> {
    const row = await this.prisma.listing.findFirst({ where: { propertyId: id, isRepresentative: true, duplicateCheckPending: false }, include });
    return row ? this.toItem(row) : null;
  }
  async detail(id: string): Promise<CatalogDetail | null> {
    const row = await this.prisma.listing.findFirst({ where: { propertyId: id, isRepresentative: true, duplicateCheckPending: false }, include });
    if (!row) return null;
    const item = this.toItem(row), analysis = row.photoRepair;
    const compIds = [
      ...(item.assessment?.comparables?.map((c) => c.propertyId) ?? []),
      ...(item.assessment?.renovationScenario?.comparables?.map((c) => c.propertyId) ?? [])
    ];
    if (compIds.length > 0) {
      const compRows = await this.prisma.listing.findMany({
        where: { propertyId: { in: compIds }, isRepresentative: true },
        select: { propertyId: true, photos: true, rooms: true, floor: true, totalFloors: true, buildingYear: true, repairCategory: true, address: true, title: true }
      });
      const compMap = new Map(compRows.map((r) => [r.propertyId!, r]));
      const enrichComp = (c: Comparable): Comparable => {
        const found = compMap.get(c.propertyId);
        if (!found) return c;
        return {
          ...c,
          photo: c.photo ?? found.photos?.[0] ?? null,
          photos: (c.photos && c.photos.length > 0) ? c.photos : (found.photos ?? []),
          rooms: c.rooms ?? found.rooms,
          floor: c.floor ?? (found.floor ?? undefined),
          totalFloors: c.totalFloors ?? (found.totalFloors ?? undefined),
          buildingYear: c.buildingYear ?? (found.buildingYear ?? undefined),
          repair: c.repair ?? repairSchema.safeParse(found.repairCategory).data,
          title: c.title ?? found.title,
          address: c.address ?? found.address
        };
      };
      if (item.assessment) {
        item.assessment = {
          ...item.assessment,
          comparables: item.assessment.comparables.map(enrichComp),
          ...(item.assessment.renovationScenario ? {
            renovationScenario: {
              ...item.assessment.renovationScenario,
              comparables: item.assessment.renovationScenario.comparables.map(enrichComp)
            }
          } : {})
        };
      }
    }
    const history = await this.prisma.priceHistory.findMany({ where: { listing: { propertyId: id } }, include: { listing: { select: { platform: true } } }, orderBy: { observedAt: "asc" }, take: 1000 });
    const completed = analysis?.status === "READY" || analysis?.status === "INSUFFICIENT";
    const suggestion = analysis?.suggestion ?? (completed ? repairSuggestionFromEvidence(analysis.evidence) : null);
    return { item, photoRepair: analysis ? photoRepairSchema.parse({ ...analysis, suggestion,
      status: analysis.galleryHash !== row.photoSetHash ? "STALE" : completed && suggestion ? "READY" : analysis.status,
      repairNeedsConfirmation: completed && analysis.decision === "APPROVED" && analysis.suggestion === null && suggestion !== null,
      evidence: photoEvidenceSchema.parse(analysis.evidence ?? []), buildingSuggestion: buildingSuggestionFromEvidence(analysis.evidence), updatedAt: analysis.updatedAt.toISOString() }) : null,
      priceHistory: history.map((p) => ({ date: p.observedAt.toISOString(), priceUsd: Number(p.priceUsd), platform: p.listing.platform })) };
  }
  async page(filters: CatalogFilters, page: number, pageSize: number, sort: CatalogSort): Promise<CatalogPage> {
    const where = buildListingWhere(filters, this.prisma.listing.fields);
    const order: Prisma.ListingOrderByWithRelationInput = sort === "price-asc" ? { priceUsd: "asc" } : sort === "price-desc" ? { priceUsd: "desc" }
      : sort === "price-sqm" ? { pricePerSqm: "asc" } : sort === "value" ? { property: { assessment: { valueScore: { sort: "desc", nulls: "last" } } } }
        : sort === "comfort" ? { property: { assessment: { comfortScore: { sort: "desc", nulls: "last" } } } }
          : sort === "transit" ? { timeToTargetTransit: { sort: "asc", nulls: "last" } } : { firstSeenAt: "desc" };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.listing.count({ where }), this.prisma.listing.findMany({ where, include, orderBy: [order, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize })
    ]);
    return { items: rows.map((row) => this.toItem(row)), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }
  async saveAssessment(id: string, data: CatalogAssessment, revision = 0): Promise<void> {
    const columns = { version: data.version, valueScore: data.valueScore, comfortScore: data.comfortScore, coverage: data.coverage,
      discountPct: data.discountPct, medianPriceSqm: data.medianPriceSqm, confidence: data.confidence, comparableCount: data.comparableCount, data: toPrismaJson(data), calculatedAt: new Date(data.calculatedAt) };
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.property.updateMany({ where: { id, assessmentRevision: revision }, data: { assessmentError: null, assessmentAttemptedAt: new Date() } });
      if (current.count) await tx.assessment.upsert({ where: { propertyId: id }, create: { propertyId: id, ...columns }, update: columns });
    });
  }
  toItem(row: CatalogRow): CatalogItem {
    const assessment = assessmentSchema.safeParse(row.property?.assessment?.data);
    const routes = routingDataSchema.safeParse(row.routeData);
    const invalidated = assessment.success && assessment.data.valueScore !== null && row.property?.assessment?.valueScore === null;
    const resolvedAssessment = assessment.success && !invalidated ? { ...assessment.data, comfortScore: row.property?.assessment?.comfortScore ?? null, coverage: row.property?.assessment?.coverage ?? 0 } : null;
    const features = featuresSchema.parse(row.features ?? {});
    const linkedAddress = !hasStreetAddress(features.address ?? "") ? row.property?.listings.find((source) =>
      source.disposition === "ACCEPTED" && source.address && hasStreetAddress(source.address))?.address : undefined;
    return {
      id: row.propertyId!, listingId: row.id, title: row.title, description: row.description, rooms: row.rooms, areaSqm: Number(row.areaSqm),
      priceUsd: Number(row.priceUsd), priceByn: row.priceByn === null ? null : Number(row.priceByn), priceSqm: Number(row.pricePerSqm),
      latitude: row.latitude === null ? null : Number(row.latitude), longitude: row.longitude === null ? null : Number(row.longitude),
      photos: row.photos.map(normalizeSourceImageUrl), features: linkedAddress ? { ...features, address: linkedAddress } : features, disposition: row.disposition === "ACCEPTED" ? "ACCEPTED" : row.disposition === "EXCLUDED" ? "EXCLUDED" : "REVIEW",
      reasons: row.exclusionReasons, favorite: row.property?.favorite ?? false, hidden: row.property?.hidden ?? false,
      firstSeenAt: row.firstSeenAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(),
      sources: (row.property?.listings ?? [row]).map((source) => ({ platform: source.platform, externalId: source.externalId, url: source.url, priceUsd: Number(source.priceUsd), lastSeenAt: source.lastSeenAt.toISOString() })),
      assessment: resolvedAssessment, confirmedRepair: approvedRepair(row.photoRepair, row.photoSetHash), confirmedBuilding: approvedBuilding(row.photoRepair, row.photoSetHash),
      renovationBudgetUsd: row.property?.renovationBudgetUsd == null ? null : Number(row.property.renovationBudgetUsd), assessmentRevision: row.property?.assessmentRevision ?? 0,
      routes: routes.success ? routes.data : null, enrichmentStatus: row.enrichmentStatus,
      possibleDuplicateIds: row.possibleDuplicateIds,
      processing: catalogProcessing({ assessment: resolvedAssessment, routes: routes.success ? routes.data : null,
        routeStatus: row.routeStatus, routeError: row.routeError, assessmentError: row.property?.assessmentError ?? null,
        hasCoordinates: row.latitude !== null && row.longitude !== null, disposition: row.disposition })
    };
  }
}
