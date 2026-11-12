import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CatalogRepository } from "../src/infrastructure/repositories/catalogRepository.js";
import { ShadowRankingRepository } from "../src/infrastructure/repositories/shadowRankingRepository.js";
import { ShadowRankingService } from "../src/services/shadowRankingService.js";
import { personalRankingSettingsSchema, personalRankingSnapshotResponseSchema } from "../src/contracts/personalRanking.js";

export const assertPersonalRankingApi = async (app: FastifyInstance, repository: CatalogRepository, propertyId: string): Promise<void> => {
  const prisma = repository.prisma;
  const protectedState = async (): Promise<string> => JSON.stringify({
    listings: await prisma.listing.findMany({ orderBy: { id: "asc" } }),
    properties: await prisma.property.findMany({ orderBy: { id: "asc" } }),
    assessments: await prisma.assessment.findMany({ orderBy: { propertyId: "asc" } }),
    searches: await prisma.savedSearch.findMany({ orderBy: { id: "asc" } }),
    matches: await prisma.searchMatch.findMany({ orderBy: [{ searchId: "asc" }, { propertyId: "asc" }] }),
    notifications: await prisma.notification.findMany({ orderBy: { id: "asc" } }),
    settings: await prisma.appSettings.findMany(),
    legacyRankings: await prisma.shadowRanking.findMany({ orderBy: { propertyId: "asc" } }),
    jobs: await prisma.$queryRaw`SELECT * FROM pgboss.job ORDER BY id`
  });
  const read = async () => {
    const response = await app.inject({ url: `/api/listings/${propertyId}/personal-ranking` });
    assert.equal(response.statusCode, 200, response.body);
    return personalRankingSnapshotResponseSchema.parse(response.json() as unknown);
  };
  const before = await protectedState();
  const pageBefore = (await repository.page({}, 1, 100, "value")).items.map((item) => item.id);
  const settings = personalRankingSettingsSchema.parse({ previewEnabled: true, reservePct: 0,
    usdRate: { usdPerSqm: 300, scope: "full", observedOn: "2026-11-10", source: "Integration fixture" } });
  const saved = await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: settings });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(personalRankingSettingsSchema.parse(saved.json() as unknown), settings);
  assert.equal((await read()).status, "absent");
  assert.equal(await prisma.personalRankingSnapshot.count(), 0, "GET must not create a snapshot");
  assert.equal(await protectedState(), before, "Settings save and GET must preserve catalog, jobs and notifications");
  assert.equal((await app.inject({ url: "/api/listings/not-a-uuid/personal-ranking" })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/listings/${randomUUID()}/personal-ranking` })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: { ...settings, transportWeight: 100 } })).statusCode, 400, "Unknown settings must not leak into existing weights");
  const rankings = new ShadowRankingRepository(prisma);
  const service = new ShadowRankingService(repository, rankings, app.log);
  assert.equal(await service.runForIds([propertyId, propertyId]), 1);
  const current = await read();
  assert.equal(current.status, "current");
  assert.ok(current.snapshot);
  assert.deepEqual(current.snapshot.settings.usdRate, settings.usdRate, "USD rate provenance must persist in snapshots");
  const snapshotsBefore = JSON.stringify(await prisma.personalRankingSnapshot.findMany());
  await read(); await read();
  assert.equal(JSON.stringify(await prisma.personalRankingSnapshot.findMany()), snapshotsBefore, "GET must not update snapshots");
  await service.runForIds([propertyId]);
  assert.equal(await prisma.personalRankingSnapshot.count(), 1, "Identical explicit pilot is idempotent");
  assert.equal(await protectedState(), before, "Pilot must write only new snapshot storage");
  assert.deepEqual((await repository.page({}, 1, 100, "value")).items.map((item) => item.id), pageBefore, "Pilot must preserve catalog order");
  const rateOnlyChange = await app.inject({ method: "PUT", url: "/api/personal-ranking/settings",
    payload: { ...settings, usdRate: { ...settings.usdRate!, usdPerSqm: 350 } } });
  assert.equal(rateOnlyChange.statusCode, 200, rateOnlyChange.body);
  assert.equal((await read()).status, "stale", "Changing only USD/m² must invalidate the saved snapshot");
  const restored = await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: settings });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal((await read()).status, "current", "Restoring identical assumptions reuses the immutable snapshot");
  const acceptedFinished = await app.inject({ method: "PUT", url: "/api/personal-ranking/settings",
    payload: { ...settings, zeroBudgetForFinishedRepair: true } });
  assert.equal(acceptedFinished.statusCode, 200, acceptedFinished.body);
  assert.equal(personalRankingSettingsSchema.parse(acceptedFinished.json()).zeroBudgetForFinishedRepair, true);
  assert.equal((await read()).status, "stale", "The user's zero-budget policy belongs to snapshot identity");
  assert.equal((await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: { ...settings, zeroBudgetForFinishedRepair: "true" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: settings })).statusCode, 200);
  assert.equal((await read()).status, "current");
  const minimumChanged = await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: { ...settings, minimumComparables: 3 } });
  assert.equal(minimumChanged.statusCode, 200, minimumChanged.body);
  assert.equal(personalRankingSettingsSchema.parse(minimumChanged.json()).minimumComparables, 3);
  assert.equal((await read()).status, "stale", "Minimum analogue setting is part of snapshot identity");
  for (const minimumComparables of [2, 3.5, 21, "3"]) {
    assert.equal((await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: { ...settings, minimumComparables } })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: settings })).statusCode, 200);
  assert.equal((await read()).status, "current");
  const changed = await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: { ...settings, reservePct: 15,
    usdRate: { ...settings.usdRate!, usdPerSqm: 350 } } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await read()).status, "stale", "Settings changes must invalidate saved input identity");
  assert.equal((await read()).snapshot?.id, current.snapshot.id, "Stale evidence stays available without replacing the original");
  const preparedOld = Promise.withResolvers<void>();
  const releaseOld = Promise.withResolvers<void>();
  class DelayedRankingRepository extends ShadowRankingRepository {
    override async saveSnapshot(snapshot: Parameters<ShadowRankingRepository["saveSnapshot"]>[0]) {
      preparedOld.resolve();
      await releaseOld.promise;
      return super.saveSnapshot(snapshot);
    }
  }
  const delayedService = new ShadowRankingService(repository, new DelayedRankingRepository(prisma), app.log);
  const oldWork = delayedService.runForIds([propertyId]);
  await preparedOld.promise;
  let latest: Awaited<ReturnType<typeof read>>;
  try {
    const newerSettings = await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: { ...settings, reservePct: 20 } });
    assert.equal(newerSettings.statusCode, 200, newerSettings.body);
    await service.runForIds([propertyId]);
    latest = await read();
    assert.equal(latest.status, "current");
    assert.ok(latest.snapshot);
    assert.notEqual(latest.snapshot.inputHash, current.snapshot.inputHash);
    assert.equal(latest.snapshot.settings.reservePct, 20);
  } finally {
    releaseOld.resolve();
    await oldWork;
  }
  const afterDelayedSave = await read();
  assert.equal(afterDelayedSave.status, "current", "delayed old worker must never become current after a settings change");
  assert.deepEqual(afterDelayedSave.snapshot, latest.snapshot, "delayed old save cannot replace the new fingerprint or result");
  assert.equal(await prisma.personalRankingSnapshot.count(), 3, "immutable history retains both old calculations and the current snapshot");
  const oldSettingsSnapshot = (await prisma.personalRankingSnapshot.findMany()).find((row) => {
    const payload = row.payload as { settings?: { reservePct?: number } };
    return payload.settings?.reservePct === 15;
  });
  assert.ok(oldSettingsSnapshot, "delayed old work was actually persisted after the current result");
  const disabled = await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: { ...settings, previewEnabled: false } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.deepEqual(await read(), { status: "disabled", snapshot: null });
  assert.equal(await prisma.personalRankingSnapshot.count(), 3, "Disabling preview must retain evidence");
  assert.equal(await protectedState(), before);
};
