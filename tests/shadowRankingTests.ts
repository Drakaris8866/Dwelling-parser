import assert from "node:assert/strict";
import { shadowRankingSchema, type CatalogItem } from "../src/contracts/catalog.js";
import { ShadowRankingRepository } from "../src/infrastructure/repositories/shadowRankingRepository.js";
import { ShadowRankingService } from "../src/services/shadowRankingService.js";
import { personalRankingSnapshotSchema, type PersonalRankingResult } from "../src/contracts/personalRanking.js";
import pino from "pino";
import type { ComparableCandidate } from "../src/domain/personalComparables.js";

const logger = pino({ level: "silent" });

const sampleRankingResult: PersonalRankingResult = {
  version: 1,
  totalUsd: { low: 70000, base: 75000, high: 80000 },
  score: 82.5,
  asIsScore: 78,
  asIsDiscountPct: 12.5,
  readyMedianUsdSqm: 1600,
  budgetDiscountPct: 8.2,
  coverage: 100,
  provisional: false,
  breakdown: [
    { key: "money", weight: 45, observed: 85, contribution: 38.25 },
    { key: "house", weight: 20, observed: 80, contribution: 16 },
    { key: "commute", weight: 15, observed: 75, contribution: 11.25 },
    { key: "location", weight: 10, observed: 90, contribution: 9 },
    { key: "layout", weight: 10, observed: 80, contribution: 8 }
  ],
  reason: null
};

const sampleItem: CatalogItem = {
  id: "property-123",
  listingId: "listing-456",
  title: "Уютная 2-комнатная квартира",
  description: "Хороший ремонт, встроенная кухня",
  rooms: 2,
  areaSqm: 50,
  priceUsd: 70000,
  priceByn: 210000,
  priceSqm: 1400,
  latitude: 53.9,
  longitude: 27.56,
  photos: [],
  features: {
    locality: "Минск",
    marketZone: "minsk",
    isStudio: false,
    repair: "good",
    readiness: "ready",
    buildingMaterial: "brick",
    buildingYear: 1985,
    layout: "isolated",
    totalFloors: 9,
    floor: 5,
    provenance: {}
  },
  disposition: "ACCEPTED",
  reasons: [],
  favorite: false,
  hidden: false,
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  sources: [],
  assessment: {
    version: "catalog-1.5",
    valueScore: 80,
    comfortScore: 75,
    coverage: 90,
    confidence: "high",
    comparableCount: 10,
    radiusMeters: 1000,
    discountPct: 10,
    medianPriceSqm: 1550,
    priceRangeLow: 1300,
    priceRangeHigh: 1700,
    reasons: [],
    components: [
      {
        code: "condition",
        label: "Состояние",
        score: 85,
        coverage: 100,
        weight: 35
      },
      {
        code: "layout",
        label: "Планировка",
        score: 80,
        coverage: 100,
        weight: 30
      },
      {
        code: "transport",
        label: "Транспорт",
        score: 75,
        coverage: 100,
        weight: 35,
        criteria: [
          { code: "commute", label: "Время", score: 70, weight: 55, observed: "30 мин", rule: "" },
          { code: "metro", label: "Метро", score: 85, weight: 20, observed: "10 мин", rule: "" }
        ]
      }
    ],
    comparables: [
      {
        propertyId: "comp-1",
        externalId: "c1",
        platform: "KUFAR",
        address: "ул. Ленина",
        priceUsd: 75000,
        priceSqm: 1500,
        areaSqm: 50,
        distanceMeters: 500
      },
      {
        propertyId: "comp-2",
        externalId: "c2",
        platform: "ONLINER",
        address: "ул. Маркса",
        priceUsd: 76000,
        priceSqm: 1520,
        areaSqm: 50,
        distanceMeters: 600
      },
      {
        propertyId: "comp-3",
        externalId: "c3",
        platform: "REALT",
        address: "ул. Кирова",
        priceUsd: 77000,
        priceSqm: 1540,
        areaSqm: 50,
        distanceMeters: 700
      },
      {
        propertyId: "comp-4",
        externalId: "c4",
        platform: "KUFAR",
        address: "пр. Независимости",
        priceUsd: 78000,
        priceSqm: 1560,
        areaSqm: 50,
        distanceMeters: 800
      },
      {
        propertyId: "comp-5",
        externalId: "c5",
        platform: "ONLINER",
        address: "ул. Энгельса",
        priceUsd: 79000,
        priceSqm: 1580,
        areaSqm: 50,
        distanceMeters: 900
      }
    ],
    calculatedAt: new Date().toISOString()
  },
  routes: {
    target: {
      durationMinutes: 30,
      walkingMinutes: 10,
      waitingMinutes: 5,
      transfers: 1,
      hasTransit: true,
      legs: [],
      date: "2026-11-09",
      time: "08:30",
      provider: "otp",
      calculatedAt: new Date().toISOString()
    },
    metro: null,
    metroName: "Площадь Ленина",
    settingsKey: "k"
  },
  enrichmentStatus: "DONE",
  possibleDuplicateIds: []
};

export async function assertShadowRanking(): Promise<void> {
  // 1. Validate Zod contract
  const parsed = shadowRankingSchema.parse({
    score: 82.5,
    asIsScore: 78,
    totalUsd: { low: 70000, base: 75000, high: 80000 },
    coverage: 100,
    provisional: false,
    reason: null,
    breakdown: sampleRankingResult.breakdown,
    calculatedAt: new Date().toISOString()
  });
  assert.equal(parsed.score, 82.5);
  assert.equal(parsed.coverage, 100);
  assert.equal(parsed.breakdown.length, 5);

  const provisionalParsed = shadowRankingSchema.parse({
    score: null,
    asIsScore: null,
    totalUsd: null,
    coverage: 40,
    provisional: true,
    reason: "missing-budget",
    breakdown: [],
    calculatedAt: new Date().toISOString()
  });
  assert.equal(provisionalParsed.score, null);
  assert.equal(provisionalParsed.reason, "missing-budget");
  assert.equal(provisionalParsed.provisional, true);

  // 2. Validate ShadowRankingRepository
  const store = new Map<string, any>();
  const mockPrisma = {
    shadowRanking: {
      upsert: async ({ where, create, update }: any) => {
        const existing = store.get(where.propertyId);
        const record = existing ? { ...existing, ...update, updatedAt: new Date() } : { ...create, createdAt: new Date(), updatedAt: new Date() };
        store.set(where.propertyId, record);
        return record;
      },
      findUnique: async ({ where }: any) => {
        return store.get(where.propertyId) ?? null;
      },
      deleteMany: async ({ where }: any) => {
        const existed = store.has(where.propertyId);
        store.delete(where.propertyId);
        return { count: existed ? 1 : 0 };
      }
    }
  } as any;

  const repo = new ShadowRankingRepository(mockPrisma);
  const settingsKey = JSON.stringify({ version: 1, weights: { money: 45, house: 20, commute: 15, location: 10, layout: 10 } });

  await repo.saveShadowRanking("prop-1", sampleRankingResult, settingsKey);
  const fetched = await repo.getShadowRanking("prop-1");
  assert.ok(fetched);
  assert.equal(fetched.score, 82.5);
  assert.equal(fetched.rankingVersion, 1);
  assert.equal(fetched.settingsKey, settingsKey);
  assert.equal(fetched.totalUsdBase, 75000);

  await repo.clearShadowRanking("prop-1");
  const cleared = await repo.getShadowRanking("prop-1");
  assert.equal(cleared, null);

  // 3. Validate ShadowRankingService
  const mockCatalogRepo = {
    publicationPricePayloads: async () => [],
    prisma: {
      listing: {
        findMany: async () => []
      }
    },
    page: async () => ({
      items: [sampleItem],
      total: 1,
      page: 1,
      pageSize: 10,
      pages: 1
    })
  } as any;

  const snapshots = new Map<string, any>();
  const snapshotRepo = {
    getSettings: async () => ({ previewEnabled: true, targetLevel: "good", reservePct: 10 }),
    saveSnapshot: async (snapshot: any) => { personalRankingSnapshotSchema.parse(snapshot); if (!snapshots.has(snapshot.inputHash)) snapshots.set(snapshot.inputHash, snapshot); return snapshots.get(snapshot.inputHash); },
    findSnapshot: async (_id: string, hash?: string) => hash ? snapshots.get(hash) ?? null : [...snapshots.values()].at(-1) ?? null
  } as any;
  const service = new ShadowRankingService(mockCatalogRepo, snapshotRepo, logger);
  const result = await service.assessItem(sampleItem, null);
  assert.ok(result);
  assert.equal(result.version, 1);
  assert.equal(result.score, null, "legacy assessment comparables cannot bypass strict selection");
  assert.equal(result.reason, "ineligible", "no eligible current subject publication must fail closed");

  // Check saved ranking in repo
  const savedRanking = [...snapshots.values()][0];
  assert.ok(savedRanking);
  assert.equal(savedRanking.result.score, result.score);
  assert.equal(savedRanking.result.version, 1);
  assert.equal((await service.getCurrentSnapshot(sampleItem)).status, "current");
  await service.assessItem(sampleItem, null);
  assert.equal(snapshots.size, 1, "same inputs are idempotent");
  assert.equal((await service.getCurrentSnapshot({ ...sampleItem, priceUsd: 71000 })).status, "stale");
  assert.equal((await service.getCurrentSnapshot(sampleItem, new Date(Date.now() + 86_400_000))).status, "stale", "dated rates/FX and candidate expiry cannot stay current across days");
  snapshotRepo.getSettings = async () => ({ previewEnabled: true, targetLevel: "designer", reservePct: 10 });
  assert.equal((await service.getCurrentSnapshot(sampleItem)).status, "stale", "settings are part of input identity");
  snapshotRepo.getSettings = async () => ({ previewEnabled: false, targetLevel: "good", reservePct: 10 });
  assert.equal((await service.getCurrentSnapshot(sampleItem)).status, "disabled");
  snapshotRepo.getSettings = async () => ({ previewEnabled: true, targetLevel: "good", reservePct: 10 });
  assert.deepEqual(savedRanking.result.breakdown, [], "ineligible inputs cannot receive convenience scores");

  // Test runForTopCandidates
  mockCatalogRepo.detail = async () => ({ item: sampleItem });
  const processedCount = await service.runForIds(["11111111-1111-4111-8111-111111111111"]);
  assert.equal(processedCount, 1);

  const observedAt = new Date("2026-11-10T12:00:00.000Z");
  const publications: any[] = Array.from({ length: 5 }, (_, index) => ({
    propertyId: `candidate-${index}`, externalId: `publication-${index}`, platform: "KUFAR",
    rooms: sampleItem.rooms, areaSqm: sampleItem.areaSqm, features: sampleItem.features,
    address: "Test address", priceUsd: 80000, latitude: sampleItem.latitude, longitude: sampleItem.longitude,
    photoSetHash: "gallery-1", contentHash: "content-1", isActive: true, disposition: "ACCEPTED",
    lastSeenAt: observedAt, routeData: null, photoRepair: null
  }));
  mockCatalogRepo.publicationPricePayloads = async () => publications.map(row => ({ platform: row.platform, externalId: row.externalId, payload: row.sourcePayload }));
  mockCatalogRepo.prisma.listing.findMany = async ({ where }: any) => publications.filter((row) => row.isActive === where.isActive
    && row.disposition === where.disposition && row.lastSeenAt >= where.lastSeenAt.gte && row.lastSeenAt <= where.lastSeenAt.lte);
  const subjectPublication = { ...publications[0], propertyId: sampleItem.id, externalId: "subject-fresh", priceUsd: sampleItem.priceUsd };
  publications.push(subjectPublication);
  const withLift = await service.assessItem({ ...sampleItem, description: "Дом оснащен современным лифтом Otis." }, 0, observedAt);
  const withKnownNoLift = await service.assessItem({ ...sampleItem, description: "Дом оснащен современным лифтом Otis.", features: { ...sampleItem.features, elevator: false } }, 0, observedAt);
  assert.ok(withLift.breakdown.find(row => row.key === "house")!.observed! > withKnownNoLift.breakdown.find(row => row.key === "house")!.observed!, "Explicit description fills a missing lift fact but never overrides a known value");
  const unconfirmed = await service.assessItem(sampleItem, null, observedAt);
  assert.equal(unconfirmed.reason, "missing-budget", "seller good+ready is not trusted zero-cost target compliance");
  snapshotRepo.getSettings = async () => ({ previewEnabled: true, targetLevel: "good", reservePct: 10, zeroBudgetForFinishedRepair: true });
  assert.equal((await service.getCurrentSnapshot(sampleItem, observedAt)).status, "stale", "Changing the user's finished-repair policy invalidates previous calculations");
  for (const repair of ["cosmetic", "good", "designer"] as const) {
    await service.assessItem({ ...sampleItem, features: { ...sampleItem.features, repair, readiness: "ready" } }, null, observedAt);
    const estimate = [...snapshots.values()].at(-1).renovation;
    assert.equal(estimate.source, "user-rule", "The user may accept existing finished repair without a new budget");
    assert.equal(estimate.usd.base, 0);
  }
  await service.assessItem(sampleItem, 2500, observedAt);
  assert.equal([...snapshots.values()].at(-1).renovation.usd.base, 2500, "An explicit manual budget wins over the user's zero-budget rule");
  const unknownRepair = { ...sampleItem.features }; delete unknownRepair.repair;
  assert.equal((await service.assessItem({ ...sampleItem, features: unknownRepair }, null, observedAt)).reason, "missing-budget", "Unknown repair must not become free");
  assert.equal((await service.assessItem({ ...sampleItem, features: { ...sampleItem.features, readiness: "construction" } }, null, observedAt)).reason, "missing-budget", "Unfinished construction cannot receive the finished-repair rule");
  snapshotRepo.getSettings = async () => ({ previewEnabled: true, targetLevel: "good", reservePct: 10 });
  const staleConfirmation = await service.assessItem({ ...sampleItem, confirmedRepair: "good" }, null, observedAt);
  assert.equal(staleConfirmation.reason, "missing-budget", "legacy item confirmation without current gallery evidence cannot zero the budget");
  subjectPublication.photoRepair = { status: "READY", decision: "APPROVED", galleryHash: "old-gallery", suggestion: "good" };
  assert.equal((await service.assessItem(sampleItem, null, observedAt)).reason, "missing-budget", "stale-gallery approval must not apply");
  subjectPublication.photoRepair.galleryHash = subjectPublication.photoSetHash;
  assert.notEqual((await service.assessItem(sampleItem, null, observedAt)).score, null, "current approved target compliance permits a zero estimate");
  assert.equal([...snapshots.values()].at(-1).renovation.source, "not-needed");
  snapshotRepo.getSettings = async () => ({ previewEnabled: true, targetLevel: "designer", reservePct: 10 });
  assert.equal((await service.assessItem(sampleItem, null, observedAt)).reason, "missing-budget", "approved good repair cannot prove designer target compliance");
  snapshotRepo.getSettings = async () => ({ previewEnabled: true, targetLevel: "good", reservePct: 10 });
  subjectPublication.photoRepair = null;
  for (const unavailable of [
    { isActive: false }, { disposition: "REVIEW" },
    { lastSeenAt: new Date("2026-09-01T12:00:00.000Z") }, { lastSeenAt: new Date("2026-11-11T12:00:00.000Z") }
  ]) {
    const original = { ...subjectPublication };
    Object.assign(subjectPublication, unavailable);
    assert.equal((await service.assessItem(sampleItem, 0, observedAt)).reason, "ineligible", "subject publication must be active, accepted and fresh");
    Object.assign(subjectPublication, original);
  }
  publications.push({ ...subjectPublication, externalId: "subject-stale-cheap", lastSeenAt: new Date("2026-09-01T12:00:00.000Z") });
  subjectPublication.priceUsd = 90000;
  const staleRepresentative = await service.assessItem(sampleItem, 0, observedAt);
  assert.equal(staleRepresentative.reason, "ineligible", "stale cheap representative cannot rank against a fresh expensive sibling");
  assert.equal(staleRepresentative.totalUsd, null);
  const mismatchedSnapshot = [...snapshots.values()].at(-1);
  assert.equal(mismatchedSnapshot.purchaseUsd, 90000, "record the eligible publication price even when mismatch prevents ranking");
  assert.equal(mismatchedSnapshot.inputs.purchaseUsd, 90000);
  assert.deepEqual(mismatchedSnapshot.priceEvidence.find((row: any) => row.propertyId === sampleItem.id).publications.map((row: any) => row.priceUsd), [90000], "stale cheap source must not enter current price evidence");
  assert.equal(mismatchedSnapshot.sourceHashes.some((row: any) => row.externalId === "subject-stale-cheap"), false);
  subjectPublication.priceUsd = sampleItem.priceUsd;
  const strictResult = await service.assessItem({ ...sampleItem, renovationBudgetUsd: 15000 }, 0, observedAt);
  assert.notEqual(strictResult.score, null, "five strict properties supply a monetary score");
  assert.equal(strictResult.totalUsd?.base, sampleItem.priceUsd, "explicit manual zero overrides the stored budget and missing confirmation");
  assert.equal([...snapshots.values()].at(-1).renovation.source, "manual");
  assert.equal((await service.getCurrentSnapshot({ ...sampleItem, renovationBudgetUsd: 0 }, observedAt)).status, "stale");
  publications[0].priceByn = 240000;
  publications.push({ ...publications[0], externalId: "converted-price", priceUsd: 80010 });
  snapshotRepo.getSettings = async () => ({ previewEnabled: true, targetLevel: "good", reservePct: 10, zeroBudgetForFinishedRepair: true });
  const convertedResult = await service.assessItem(sampleItem, null, observedAt);
  assert.notEqual(convertedResult.score, null, "Equal BYN with bounded conversion spread preserves the fifth unique analogue");
  const convertedSnapshot = [...snapshots.values()].at(-1);
  assert.equal(convertedSnapshot.readyComparables.length, 5, "Sibling publications cannot inflate the sample");
  assert.equal(convertedSnapshot.priceEvidence.find((row: any) => row.propertyId === "candidate-0").publications[0].priceByn, 240000);
  assert.equal((await service.getCurrentSnapshot(sampleItem, observedAt)).status, "current");
  publications[0].priceByn = 240001;
  assert.equal((await service.getCurrentSnapshot(sampleItem, observedAt)).status, "stale", "BYN-only changes invalidate the snapshot");
  assert.equal((await service.assessItem(sampleItem, null, observedAt)).score, null, "Real BYN conflict cannot supply a fifth analogue");
  for (const invalidByn of [0, -1]) {
    publications[0].priceByn = invalidByn;
    assert.equal((await service.assessItem(sampleItem, null, observedAt)).score, null, "Invalid BYN excludes the candidate without aborting snapshot persistence");
    assert.equal([...snapshots.values()].at(-1).priceEvidence.find((row: any) => row.propertyId === "candidate-0").disputed, true);
  }
  publications[0].priceByn = 240000;
  publications[0].sourcePayload = { currency: "USD", price_usd: 8000000 };
  Object.assign(publications.at(-1), { platform: "ONLINER", priceUsd: 80000, priceByn: 240010, sourcePayload: { price: { currency: "USD", amount: 80000 } } });
  assert.notEqual((await service.assessItem(sampleItem, null, observedAt)).score, null, "Matching raw original USD preserves the analogue despite converted BYN differences");
  const originalUsdEvidence = [...snapshots.values()].at(-1).priceEvidence.find((row: any) => row.propertyId === "candidate-0");
  assert.equal(originalUsdEvidence.resolution, "original-usd");
  assert.equal(originalUsdEvidence.publications.every((row: any) => row.priceCurrency === "USD"), true);
  assert.equal((await service.getCurrentSnapshot(sampleItem, observedAt)).status, "current");
  publications[0].sourcePayload.currency = "BYN";
  assert.equal((await service.getCurrentSnapshot(sampleItem, observedAt)).status, "stale", "Original currency evidence is part of snapshot identity");
  assert.equal((await service.assessItem(sampleItem, null, observedAt)).score, null, "Missing original USD evidence restores conservative currency conflict handling");
  delete publications[0].sourcePayload;
  publications.pop();
  delete publications[0].priceByn;
  snapshotRepo.getSettings = async () => ({ previewEnabled: true, targetLevel: "good", reservePct: 10 });
  publications[0].photoSetHash = "gallery-2";
  assert.equal((await service.getCurrentSnapshot(sampleItem, observedAt)).status, "stale", "gallery changes invalidate the stored input identity");
  publications[0].photoSetHash = "gallery-1";
  publications.push({ ...publications[0], externalId: "conflicting-price", priceUsd: 70000 });
  const disputed = await service.assessItem(sampleItem, null, observedAt);
  assert.equal(disputed.score, null, "a conflicting sibling publication cannot create a false bargain or fifth analogue");
  assert.equal((await service.getCurrentSnapshot(sampleItem, new Date("2026-12-11T12:00:00.000Z"))).status, "stale");

  publications.pop();
  const sourceFeatures = { ...sampleItem.features, provenance: { address: "structured" as const } };
  delete sourceFeatures.buildingMaterial; delete sourceFeatures.repair; delete sourceFeatures.readiness;
  for (const row of publications.slice(0, 5)) Object.assign(row, { platform: "REALT", houseType: "0", repairState: "2", features: sourceFeatures });
  let selectedFields: Record<string, unknown> = {};
  mockCatalogRepo.prisma.listing.findMany = async ({ select }: any) => { selectedFields = select; return publications; };
  const fetchCandidates = (): Promise<{ candidates: ComparableCandidate[] }> =>
    (service as unknown as { fetchCandidates(item: CatalogItem, now: Date): Promise<{ candidates: ComparableCandidate[] }> }).fetchCandidates(sampleItem, observedAt);
  const recovered = (await fetchCandidates()).candidates;
  assert.equal(selectedFields["houseType"], true);
  assert.equal(selectedFields["repairState"], true);
  assert.equal(selectedFields["sourcePayload"], undefined, "Recovery must not load full source payloads");
  assert.equal(recovered[0]?.features.buildingMaterial, "brick");
  assert.equal(recovered[0]?.features.repair, "good");
  assert.equal(recovered[0]?.features.readiness, "ready");
  assert.deepEqual(recovered[0]?.features.provenance, { address: "structured", buildingMaterial: "legacy", repair: "legacy", readiness: "inferred" });
  assert.equal(sourceFeatures.repair, undefined, "Preparation cannot mutate stored canonical facts");
  assert.notEqual((await service.assessItem(sampleItem, 0, observedAt)).score, null, "Five recovered REALT properties pass unchanged strict selection");
  const recoveredSnapshot = [...snapshots.values()].at(-1);
  const recoveredHash = recoveredSnapshot.inputHash;
  publications[0].houseType = "Кирпичный";
  await service.assessItem(sampleItem, 0, observedAt);
  assert.notEqual([...snapshots.values()].at(-1).inputHash, recoveredHash, "Raw source fields belong to snapshot identity even if canonical facts agree");
  const retainedFeatures = { ...sampleItem.features, repair: "none" as const, readiness: "construction" as const,
    buildingMaterial: "panel" as const, provenance: { repair: "structured" as const, readiness: "structured" as const, buildingMaterial: "structured" as const } };
  publications[0].features = retainedFeatures;
  assert.deepEqual((await fetchCandidates()).candidates[0]?.features, retainedFeatures, "Known canonical values and provenance take precedence over source recovery");
  publications[0].features = { ...sourceFeatures, repair: "none", provenance: { repair: "structured" } };
  assert.equal((await fetchCandidates()).candidates[0]?.features.readiness, "unfinished", "Missing readiness follows retained repair, not conflicting source repair");
  publications[0].features = sourceFeatures;
  for (const code of ["3", "5", "999", null]) {
    publications[0].repairState = code;
    const features = (await fetchCandidates()).candidates[0]?.features;
    assert.equal(features?.repair, undefined, `Unsupported canonical repair: ${code}`);
    assert.equal(features?.readiness, undefined, `Unsupported readiness: ${code}`);
  }
  publications[0].platform = "KUFAR";
  publications[0].repairState = "2";
  assert.deepEqual((await fetchCandidates()).candidates[0]?.features, sourceFeatures, "REALT codes cannot recover another provider's facts");

  // Test abort signal
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    async () => {
      await service.runForIds(["11111111-1111-4111-8111-111111111111"], controller.signal);
    },
    { name: "AbortError" }
  );
}
