import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { CatalogRepository } from "../src/infrastructure/repositories/catalogRepository.js";
import type { CatalogAssessmentService } from "../src/services/catalogAssessmentService.js";
import { PhotoRepairService } from "../src/services/photoRepairService.js";
import type { ListingCandidate } from "../src/domain/listing.js";
import type { PhotoInspector } from "../src/infrastructure/vision/ollamaVision.js";
import type { ListingPhotoReader } from "../src/infrastructure/vision/listingPhotos.js";
import type { PhotoObservation } from "../src/contracts/photoRepair.js";
import { featuresSchema } from "../src/contracts/catalog.js";
import { photoConsensus } from "../src/domain/repairEvidence.js";
import { createLogger } from "../src/infrastructure/logger.js";

export const fixturePhotos: ListingPhotoReader = { read: async (_platform, url): Promise<Buffer> => Buffer.from(url) };
export const fixtureInspector: PhotoInspector = {
  model: "fixture-vision", digest: async (): Promise<string> => "fixture-digest",
  inspect: async (image): Promise<PhotoObservation> => image.toString().includes("/facade-")
    ? { scene: "exterior", condition: null, buildingCondition: "worn", observations: ["Видимый износ отделки фасада"] }
    : { scene: "interior", condition: "needs-repair", observations: ["Повреждена отделка стены"] }
};

export const assertRepairWorkflow = async (app: FastifyInstance, repo: CatalogRepository, assessment: CatalogAssessmentService, photos: PhotoRepairService, fixture: ListingCandidate): Promise<void> => {
  const make = (externalId: string, repair: "cosmetic" | "good" | "needs-repair", priceUsd: number): ListingCandidate => ({ ...fixture, externalId, priceUsd, pricePerSqm: priceUsd / 50, areaSqm: 50,
    photos: ["https://example.org/room.jpg", "https://example.org/kitchen.jpg"],
    features: featuresSchema.parse({ ...fixture.features, marketZone: "repair-test", repair, readiness: repair === "needs-repair" ? "unfinished" : "ready", provenance: { readiness: "inferred" } }) });
  const create = async (candidate: ListingCandidate) => {
    const { listing } = await repo.observe(candidate);
    await repo.completeDuplicateCheck(listing);
    return listing;
  };
  const original = make("repair-subject", "cosmetic", 90_000);
  const subject = await create(original), id = subject.propertyId!;
  const neighbor = await create(make("repair-neighbor", "good", 75_000));
  for (let i = 0; i < 5; i++) {
    await create(make(`repair-cosmetic-${i}`, "cosmetic", 100_000));
    await create(make(`repair-good-${i}`, "good", 110_000));
    if (i < 4) await create(make(`repair-bad-${i}`, "needs-repair", 75_000));
  }
  const analyze = async (propertyId: string): Promise<string> => {
    const endpoint = `/api/listings/${propertyId}/photo-repair`;
    assert.equal((await app.inject({ method: "POST", url: endpoint })).statusCode, 202);
    const row = (await repo.detail(propertyId))?.photoRepair;
    assert.equal(row?.status, "QUEUED");
    await photos.run(row!.id);
    assert.equal((await repo.detail(propertyId))?.photoRepair?.suggestion, "needs-repair");
    assert.equal((await app.inject({ method: "POST", url: endpoint })).statusCode, 200);
    assert.equal((await repo.detail(propertyId))?.photoRepair?.id, row!.id);
    return row!.id;
  };
  const decide = async (propertyId: string, analysisId: string, decision: "APPROVED" | "PENDING") => app.inject({ method: "PATCH", url: `/api/listings/${propertyId}/photo-repair`, payload: { analysisId, decision } });
  const analysisId = await analyze(id), neighborId = await analyze(neighbor.propertyId!);
  await assessment.reassessAll();
  const before = (await repo.item(id))!.assessment!;
  assert.equal(before.valueScore, 60); assert.equal(before.priceEvidence?.repairSource, "listing");
  assert.equal((await decide(id, analysisId, "APPROVED")).statusCode, 200);
  await assessment.reassessAll();
  assert.equal((await repo.item(id))?.assessment?.valueScore, null, "Four comparables must not yield a score");
  assert.equal((await decide(neighbor.propertyId!, neighborId, "APPROVED")).statusCode, 200);
  await assessment.reassessAll();
  const confirmed = (await repo.item(id))!;
  assert.equal(confirmed.assessment?.medianPriceSqm, 1500);
  assert.equal(confirmed.assessment?.valueScore, 35.7);
  assert.ok(confirmed.assessment!.comfortScore! < before.comfortScore!);
  assert.equal(confirmed.features.repair, "cosmetic");
  assert.equal(confirmed.assessment?.priceEvidence?.repairSource, "photo");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/listings/${id}/renovation-budget`, payload: { budgetUsd: 10_000 } })).statusCode, 200);
  await assessment.reassessAll();
  const budget = (await repo.item(id))!.assessment!;
  assert.equal(budget.valueScore, confirmed.assessment?.valueScore);
  assert.equal(budget.renovationScenario?.totalUsd, 100_000);
  assert.equal(budget.renovationScenario?.medianPriceSqm, 2200);
  assert.equal(budget.renovationScenario?.comparables.length, 5);
  assert.equal((await decide(id, analysisId, "PENDING")).statusCode, 200);
  await assessment.reassessAll();
  assert.equal((await repo.item(id))?.assessment?.valueScore, 60);
  assert.equal((await decide(id, analysisId, "APPROVED")).statusCode, 200);
  await repo.observe({ ...original, photos: ["https://example.org/new.jpg"] });
  assert.equal((await repo.detail(id))?.photoRepair?.status, "STALE");
  assert.equal((await repo.item(id))?.confirmedRepair, undefined);
  assert.equal((await decide(id, analysisId, "APPROVED")).statusCode, 409);
  const unavailable = new PhotoRepairService(repo.prisma, fixturePhotos, createLogger({ logLevel: "error" }), {
    ...fixtureInspector, digest: async (): Promise<string> => { throw new Error("Connection refused"); }
  });
  let failedId: string | undefined;
  assert.equal(await unavailable.request(subject.id, async (id) => { failedId = id; }), "queued");
  assert.ok(failedId);
  await assert.rejects(unavailable.run(failedId), /Local photo analysis failed/);
  assert.equal((await repo.detail(id))?.photoRepair?.status, "FAILED");
  assert.equal((await repo.item(id))?.confirmedRepair, undefined);
  assert.equal(await unavailable.request(subject.id, async (id) => { assert.notEqual(id, failedId); }), "queued");
  await repo.observe({ ...original, photos: ["https://example.org/facade-1.jpg", "https://example.org/facade-2.jpg"] });
  let facadeId: string | undefined;
  await photos.request(subject.id, async (id) => { facadeId = id; });
  assert.ok(facadeId);
  await photos.run(facadeId);
  assert.equal((await repo.detail(id))?.photoRepair?.buildingSuggestion, "worn");
  assert.equal((await repo.detail(id))?.photoRepair?.suggestion, null);
  assert.equal((await repo.item(id))?.confirmedBuilding, undefined);
  assert.equal((await decide(id, facadeId, "APPROVED")).statusCode, 200);
  await assessment.reassessAll();
  const facade = (await repo.item(id))!;
  assert.equal(facade.confirmedBuilding, "worn");
  assert.equal(facade.assessment?.valueScore, null);
  assert.ok(facade.assessment?.priceEvidence?.rules.some((rule) => rule.includes("подтверждённым фото")));
  assert.equal((await decide(id, facadeId, "PENDING")).statusCode, 200);
  await assessment.reassessAll();
  assert.equal((await repo.item(id))?.assessment?.valueScore, 60);
  const interior = { scene: "interior", condition: "good", observations: ["Целая отделка"], photoUrl: "https://example.org/1.jpg" } as const;
  assert.equal(photoConsensus([{ ...interior, observations: [...interior.observations] }, { ...interior, observations: [], scene: "floor-plan" }]), null);
  const worn = { ...interior, condition: "needs-repair" as const, observations: ["Износ отделки"] };
  const otherRoom = { ...worn, photoUrl: "https://example.org/2.jpg" };
  const bare = { ...worn, photoUrl: "https://example.org/3.jpg", condition: "none" as const };
  assert.equal(photoConsensus([worn, otherRoom, bare]), "needs-repair");
  assert.equal(photoConsensus([worn, bare]), null);
  assert.equal(photoConsensus([worn, otherRoom, { ...interior, photoUrl: bare.photoUrl, observations: [...interior.observations] }]), null);

  assert.equal((await decide(id, facadeId, "APPROVED")).statusCode, 200);
  const exterior = (await repo.detail(id))!.photoRepair!.evidence;
  await repo.prisma.photoRepairAnalysis.update({ where: { id: facadeId }, data: { evidence: [...exterior, worn, otherRoom, bare] } });
  assert.equal((await repo.detail(id))?.photoRepair?.suggestion, "needs-repair");
  assert.equal((await repo.detail(id))?.photoRepair?.repairNeedsConfirmation, true);
  assert.equal((await decide(id, facadeId, "APPROVED")).statusCode, 200);
  assert.equal((await repo.item(id))?.confirmedRepair, undefined, "An old facade approval must not confirm new repair evidence");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/listings/${id}/photo-repair`, payload: { analysisId: facadeId, decision: "APPROVED", confirmRepair: true } })).statusCode, 200);
  assert.equal((await repo.item(id))?.confirmedRepair, "needs-repair");
  assert.equal((await repo.item(id))?.confirmedBuilding, "worn");
};
