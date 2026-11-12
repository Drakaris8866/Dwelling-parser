import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import pino from "pino";
import { createPrismaConnection } from "../src/infrastructure/db/prisma.js";
import { CatalogRepository, refreshRepresentative } from "../src/infrastructure/repositories/catalogRepository.js";
import { CatalogAssessmentService } from "../src/services/catalogAssessmentService.js";
import { CatalogTelegramService } from "../src/services/catalogTelegramService.js";
import { SavedSearchService } from "../src/services/savedSearchService.js";
import { CatalogWorker } from "../src/services/catalogWorker.js";
import { DuplicateService } from "../src/services/duplicateService.js";
import { RetryHttpClient } from "../src/infrastructure/http/retryHttpClient.js";
import { CollectionArea } from "../src/infrastructure/geo/collectionArea.js";
import { RoutingService } from "../src/services/routingService.js";
import { createApi } from "../src/api/app.js";
import { catalogPageSchema, mapResultSchema, featuresSchema, healthSchema, type CatalogItem } from "../src/contracts/catalog.js";
import { DEFAULT_SETTINGS } from "../src/contracts/catalog.js";
import type { ListingCandidate } from "../src/domain/listing.js";
import { ListingLifecycleService } from "../src/services/listingLifecycleService.js";
import sharp from "sharp";
import { Prisma } from "../src/generated/prisma/client.js";
import { configureCatalogQueues } from "../src/infrastructure/queue/catalogQueues.js";
import { PhotoRepairService } from "../src/services/photoRepairService.js";
import { assertRepairWorkflow, fixtureInspector, fixturePhotos } from "./repairWorkflow.js";
import { assertPersonalRankingApi } from "./personalRankingApiIntegration.js";

const logger = pino({ level: "warn" });
class TestTelegram extends CatalogTelegramService {
  sent = 0;
  failNext = false;
  override async send(_item: CatalogItem, _search: string, _kind: string): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error("Simulated network failure"); }
    this.sent++;
  }
}
class ImageHttp extends RetryHttpClient {
  constructor(private readonly images: readonly Buffer[]) { super(logger); }
  override async bytes(request: { readonly url: string }): Promise<Buffer> { return this.images[request.url.endsWith("/one.png") ? 0 : 1]!; }
}

const main = async (): Promise<void> => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const name = `catalog_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const url = new URL(databaseUrl); url.pathname = `/${name}`;
  let connection: ReturnType<typeof createPrismaConnection> | undefined;
  let worker: CatalogWorker | undefined;
  let app: Awaited<ReturnType<typeof createApi>> | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const migrationConnection = new Pool({ connectionString: url.toString() });
    try {
      for (const folder of (await readdir(resolve("prisma/migrations"), { withFileTypes: true })).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        await migrationConnection.query(await readFile(resolve("prisma/migrations", folder.name, "migration.sql"), "utf8"));
      }
    } finally { await migrationConnection.end(); }
    connection = createPrismaConnection({ databaseUrl: url.toString() });
    const repository = new CatalogRepository(connection.prisma), http = new RetryHttpClient(logger);
    const telegram = new TestTelegram({ telegramBotToken: "test", telegramChatId: "test" }, http, logger);
    const searches = new SavedSearchService(repository, telegram, logger);
    const assessment = new CatalogAssessmentService(repository, logger);
    const publicationChecks = new DuplicateService(repository, http, logger);
    worker = new CatalogWorker(url.toString(), [], repository, await CollectionArea.load(), new RoutingService(logger), assessment, publicationChecks, searches, logger);
    await worker.boss.start();
    for (const queue of ["assess", "route", "notify"]) await worker.boss.createQueue(queue);
    const abandonedId = await worker.boss.send("assess", {}, { singletonKey: "all" });
    assert.ok(abandonedId);
    await worker.boss.fetch("assess");
    await connection.prisma.$executeRaw(Prisma.sql`UPDATE pgboss.job SET started_on = NOW() - INTERVAL '10 minutes', heartbeat_on = NOW() - INTERVAL '10 minutes' WHERE id = ${abandonedId}::uuid AND name = 'assess'`);
    await worker.boss.send("assess", {}, { singletonKey: "all" });
    await worker.boss.send("assess", {}, { singletonKey: "all" });
    await worker.boss.send("route", { listingId: "healthy" }, { heartbeatSeconds: 60 });
    const healthy = await worker.boss.fetch("route");
    await configureCatalogQueues(worker.boss, logger);
    assert.equal((await worker.boss.getQueue("assess"))?.heartbeatSeconds, 60, "Existing queue settings must be updated");
    const resumed = await worker.boss.fetch("assess");
    assert.equal(resumed.length, 1, "Abandoned active job must be runnable again");
    assert.equal(resumed[0]?.heartbeatSeconds, 60);
    assert.equal((await worker.boss.findJobs("route", { id: healthy[0]!.id }))[0]?.state, "active", "Healthy attempts must not be reclaimed");
    await worker.boss.complete("route", healthy);
    await worker.boss.complete("assess", resumed);
    for (let i = 0; i < 20; i++) await worker.requestAssessment();
    assert.equal((await worker.boss.findJobs("assess", { queued: true })).length, 1, "Repeated assessment requests must coalesce");
    const retained = await worker.boss.findJobs("assess", { queued: true });
    await worker.boss.cancel("assess", retained.map((job) => job.id));
    const photoRepair = new PhotoRepairService(connection.prisma, fixturePhotos, logger, fixtureInspector);
    app = await createApi({ repository, worker, photoRepair });
    await worker.boss.send("duplicate", { listingId: "queued" });
    await worker.boss.send("route", { listingId: "active" });
    const activeRoute = await worker.boss.fetch("route");
    const health = await app.inject({ url: "/api/health" });
    assert.equal(health.statusCode, 200);
    const activity = healthSchema.parse(health.json());
    assert.deepEqual(activity.tasks.find((task) => task.name === "duplicate"), { name: "duplicate", active: 0, queued: 1 });
    assert.deepEqual(activity.tasks.find((task) => task.name === "route"), { name: "route", active: 1, queued: 0 });
    await worker.boss.complete("route", activeRoute);
    const candidate = (i: number): ListingCandidate => ({ platform: i % 3 === 0 ? "KUFAR" : i % 3 === 1 ? "ONLINER" : "REALT", externalId: `test-${i}`, url: `https://example.org/${i}`,
      title: "Квартира", description: "Квартира в жилом доме. Можно арендовать парковку.", rooms: 2, areaSqm: 50, priceUsd: i === 0 ? 90000 : 100000, pricePerSqm: i === 0 ? 1800 : 2000,
      latitude: 53.903 + i * 0.0001, longitude: 27.56, photos: [], details: [], sourcePayload: { fixture: i },
      features: featuresSchema.parse({ address: `Минск, Тестовая, ${i}`, locality: "Минск", marketZone: "минск", inCollectionArea: true, propertyType: "apartment", dealType: "sale", isStudio: false,
        buildingYear: 2000, buildingMaterial: "brick", repair: "cosmetic", layout: "isolated", floor: 3, totalFloors: 9, kitchenSqm: 10 }) });
    let firstId = "", listingId = "";
    for (let i = 0; i < 7; i++) {
      const result = await repository.observe(candidate(i));
      if (i === 0) {
        firstId = result.listing.propertyId!;
        listingId = result.listing.id;
        assert.equal(await repository.item(firstId), null, "A new accepted listing must wait for duplicate checking");
        assert.equal((await app.inject({ url: `/api/listings/${firstId}` })).statusCode, 404);
        assert.equal(mapResultSchema.parse((await app.inject({ url: "/api/map" })).json()).total, 0);
        assert.equal((await repository.page({}, 1, 20, "newest")).total, 0);
        assert.equal(await repository.completeDuplicateCheck({ ...result.listing, contentHash: "stale" }), false);
      }
      assert.equal(await publicationChecks.checkAndPublish(result.listing), true);
    }
    await assessment.reassessAll();
    const first = await repository.item(firstId);
    assert.equal(first?.assessment?.valueScore, 60.9);
    assert.equal(first?.assessment?.comparableCount, 6);
    assert.equal(first?.processing?.route.state, "pending");
    assert.equal(first?.processing?.value.state, "ready");
    assert.equal(first?.assessment?.priceEvidence?.rawScore, 60.9);
    const priceOriginRows = await repository.prisma.listing.findMany({ where: { platform: { in: ["KUFAR", "ONLINER"] } }, distinct: ["platform"] });
    for (const row of priceOriginRows) {
      const payload = row.platform === "KUFAR" ? { currency: "USD", price_usd: 15000000 } : { price: { currency: "USD", amount: 150000 } };
      await repository.prisma.listing.update({ where: { id: row.id }, data: { sourcePayload: { ...payload, description: "must not leave the DB projection", contact: "private fixture" } } });
      assert.deepEqual(await repository.publicationPricePayloads([row.id]), [{ platform: row.platform, externalId: row.externalId, payload }], "Price projection returns only declared currency and amount");
      await repository.prisma.listing.update({ where: { id: row.id }, data: { sourcePayload: row.sourcePayload ?? Prisma.JsonNull } });
    }
    assert.deepEqual(await repository.publicationPricePayloads([]), []);
    const rankingSettings = await app.inject({ url: "/api/personal-ranking/settings" });
    assert.equal(rankingSettings.statusCode, 200, rankingSettings.body);
    assert.equal((rankingSettings.json() as { previewEnabled: boolean }).previewEnabled, false);
    const rankingRead = await app.inject({ url: `/api/listings/${firstId}/personal-ranking` });
    assert.equal(rankingRead.statusCode, 200, rankingRead.body);
    assert.equal((rankingRead.json() as { status: string }).status, "disabled");
    const invalidRankingSettings = await app.inject({ method: "PUT", url: "/api/personal-ranking/settings", payload: { previewEnabled: true, targetLevel: "good", reservePct: -1 } });
    assert.equal(invalidRankingSettings.statusCode, 400);
    const coordinateProbe = await repository.observe({ ...candidate(0), latitude: 53.9030002 });
    await repository.prisma.listing.update({ where: { id: coordinateProbe.listing.id }, data: { routeStatus: "READY", timeToTargetTransit: 28, routeData: { policyVersion: 4 } } });
    const samePoint = await repository.observe({ ...candidate(0), latitude: 53.9030003 });
    assert.equal(samePoint.listing.routeStatus, "READY");
    assert.equal(samePoint.listing.timeToTargetTransit, 28);
    assert.equal(samePoint.changed, false);
    const moved = await repository.observe({ ...candidate(0), latitude: 53.903002 });
    assert.equal(moved.listing.routeStatus, "PENDING");
    assert.equal(moved.listing.timeToTargetTransit, null);
    await repository.observe(candidate(0));
    assert.equal((await app.inject({ method: "POST", url: `/api/listings/${firstId}/route` })).statusCode, 202);
    const interactiveRoute = await worker.boss.findJobs("route", { key: listingId, queued: true });
    assert.equal(interactiveRoute[0]?.priority, 10);
    await worker.boss.upsert("route", { listingId }, { singletonKey: listingId, heartbeatSeconds: 60 });
    assert.equal((await worker.boss.findJobs("route", { key: listingId, queued: true }))[0]?.priority, 10);
    const getPage = async (filters: unknown) => {
      const response = await app!.inject({ url: `/api/listings?${new URLSearchParams({ filters: JSON.stringify(filters) })}` });
      assert.equal(response.statusCode, 200, response.body);
      return catalogPageSchema.parse(response.json() as unknown);
    };
    const initialPage = await getPage({});
    assert.equal(initialPage.total, 7);
    assert.deepEqual(initialPage.items.find((item) => item.id === firstId)?.routeQueue, { position: 1, estimatedSeconds: null });
    assert.equal((await getPage({ maxPrice: 95000 })).total, 1);
    assert.equal((await getPage({ rooms: [1] })).total, 0);
    assert.equal((await getPage({ notLastFloor: true })).total, 7);
    const map = await app.inject({ url: `/api/map?${new URLSearchParams({ filters: JSON.stringify({ maxPrice: 95000 }) })}` });
    const points = mapResultSchema.parse(map.json() as unknown);
    assert.equal(points.total, 1); assert.equal(points.points.reduce((n, p) => n + p.count, 0), 1);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/listings/${firstId}/state`, payload: { favorite: true } })).statusCode, 200);
    assert.equal((await getPage({ favoritesOnly: true })).total, 1);
    await app.inject({ method: "PATCH", url: `/api/listings/${firstId}/state`, payload: { hidden: true } });
    assert.equal((await getPage({})).total, 6); assert.equal((await getPage({ showHidden: true })).total, 7);
    await app.inject({ method: "PATCH", url: `/api/listings/${firstId}/state`, payload: { hidden: false } });
    const initial = await repository.prisma.priceHistory.count({ where: { listingId } });
    await repository.prisma.listing.update({ where: { id: listingId }, data: { lastSeenAt: new Date("2020-01-01") } });
    await repository.observe({ ...candidate(0), title: "Обновлённое описание" });
    assert.equal(await repository.prisma.priceHistory.count({ where: { listingId } }), initial);
    assert.ok((await repository.prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).lastSeenAt > new Date("2026-01-01"));
    const before = await repository.prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    await repository.observe({ ...candidate(0), description: "Обогащено" }, undefined, { recordObservation: false, expectedHash: before.contentHash });
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).lastSeenAt.getTime(), before.lastSeenAt.getTime());
    await repository.observe({ ...candidate(0), priceUsd: 1, pricePerSqm: 0.02 }, undefined, { recordObservation: false, expectedHash: "stale" });
    assert.equal(Number((await repository.prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).priceUsd), 90000);
    await app.inject({ method: "POST", url: "/api/searches", payload: { name: "До 95 тысяч", filters: { maxPrice: 95000 }, notifications: true } });
    await searches.evaluate(); assert.equal(await repository.prisma.notification.count(), 0, "Initial matching inventory must not be sent");
    await repository.observe({ ...candidate(0), priceUsd: 85000, pricePerSqm: 1700 });
    await searches.evaluate(); await searches.evaluate(); assert.equal(await repository.prisma.notification.count(), 1);
    telegram.failNext = true; await searches.deliver(); assert.equal(await repository.prisma.notification.count({ where: { status: "PENDING" } }), 1);
    await searches.deliver(); assert.equal(telegram.sent, 1); await searches.deliver(); assert.equal(telegram.sent, 1);
    assert.equal((await app.inject({ url: "/api/listings?filters=broken" })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/listings/${firstId}/state`, headers: { origin: "https://other.example" }, payload: { hidden: true } })).statusCode, 403);
    const lifecycle = new ListingLifecycleService(repository.prisma);
    const partial = await repository.prisma.sourceSyncRun.create({ data: { platform: "KUFAR", kind: "FULL", status: "PARTIAL" } });
    await lifecycle.completeFullRun("KUFAR", partial.id);
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).missedCompleteRuns, 0);
    const complete = await repository.prisma.sourceSyncRun.create({ data: { platform: "KUFAR", kind: "FULL", status: "COMPLETE" } });
    const today = new Date("2026-11-05T12:00:00Z");
    await lifecycle.completeFullRun("KUFAR", complete.id, today);
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).isActive, true);
    await lifecycle.completeFullRun("KUFAR", complete.id, new Date(today.getTime() + 12 * 3600000));
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).missedCompleteRuns, 1);
    await lifecycle.completeFullRun("KUFAR", complete.id, new Date(today.getTime() + 25 * 3600000));
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).isActive, true, "Repeating one full run cannot count as a second observation");
    const secondFull = await repository.prisma.sourceSyncRun.create({ data: { platform: "KUFAR", kind: "FULL", status: "COMPLETE" } });
    await lifecycle.completeFullRun("KUFAR", secondFull.id, new Date(today.getTime() + 25 * 3600000));
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).isActive, false);
    const a = await repository.observe(candidate(20)), b = await repository.observe({ ...candidate(21), priceUsd: 70000, pricePerSqm: 1400 });
    await publicationChecks.checkAndPublish(a.listing);
    await publicationChecks.checkAndPublish(b.listing);
    await repository.prisma.listing.update({ where: { id: b.listing.id }, data: { propertyId: a.listing.propertyId } });
    await refreshRepresentative(repository.prisma, a.listing.propertyId!);
    assert.equal((await repository.item(a.listing.propertyId!))?.priceUsd, 70000);
    await repository.observe({ ...candidate(20), priceUsd: 60000, pricePerSqm: 1200 });
    assert.equal((await repository.item(a.listing.propertyId!))?.priceUsd, 60000);
    const buffers: Buffer[] = [];
    for (const seed of [1, 19]) {
      const pixels = Uint8Array.from({ length: 72 }, (_, i) => (i * 37 + (i % 7) * seed * 11) % 255);
      buffers.push(await sharp(Buffer.from(pixels), { raw: { width: 9, height: 8, channels: 1 } }).png().toBuffer());
    }
    const sameAddress = featuresSchema.parse({ ...candidate(24).features, address: "Минск, ул. Общая, 10 2" });
    const photo1 = (side: string) => [`https://fixture.invalid/${name}/${side}/one.png`, `https://fixture.invalid/${name}/${side}/two.png`];
    const d1 = await repository.observe({ ...candidate(24), features: sameAddress, photos: photo1("a") });
    assert.equal(await publicationChecks.checkAndPublish(d1.listing), true);
    const d2 = await repository.observe({ ...candidate(25), platform: d1.listing.platform, features: { ...sameAddress, address: "Минск, ул. Общая, 10к2" }, photos: photo1("b") });
    assert.equal(await repository.item(d2.listing.propertyId!), null);
    assert.equal((await repository.item(d1.listing.propertyId!))?.sources.length, 1);
    const unrelated = await repository.observe(candidate(29));
    await repository.prisma.listing.update({ where: { id: unrelated.listing.id }, data: { possibleDuplicateIds: [d2.listing.propertyId!, a.listing.propertyId!] } });
    await repository.prisma.listing.update({ where: { id: d1.listing.id }, data: { lastSeenAt: new Date(0), possibleDuplicateIds: [d2.listing.propertyId!, a.listing.propertyId!] } });
    for (let i = 100; i < 131; i++) {
      await repository.observe({ ...candidate(i), latitude: candidate(24).latitude, longitude: candidate(24).longitude, features: { ...sameAddress, address: `Минск, ул. Другая, ${i}` } });
    }
    const imageHttp = new ImageHttp(buffers);
    const duplicates = new DuplicateService(repository, imageHttp, logger, { read: (_platform, url) => imageHttp.bytes({ url }) });
    assert.equal(await duplicates.reconcile(d2.listing, undefined, { candidateIds: [d1.listing.id], candidateSnapshot: { id: d1.listing.id, propertyId: d1.listing.propertyId!, contentHash: "stale" } }), false);
    assert.deepEqual((await repository.prisma.listing.findUniqueOrThrow({ where: { id: d2.listing.id } })).possibleDuplicateIds, []);
    assert.equal(await duplicates.reconcile(d2.listing, undefined, { candidateIds: [d1.listing.id] }), true);
    const merged = await repository.prisma.listing.findUniqueOrThrow({ where: { id: d2.listing.id } });
    assert.equal(merged.propertyId, d1.listing.propertyId, "Two independent photo matches and normalized building numbers should confirm a same-source duplicate");
    assert.equal((await repository.item(merged.propertyId!))?.sources.length, 2);
    assert.deepEqual((await repository.prisma.listing.findUniqueOrThrow({ where: { id: d1.listing.id } })).possibleDuplicateIds, [a.listing.propertyId]);
    assert.deepEqual((await repository.prisma.listing.findUniqueOrThrow({ where: { id: unrelated.listing.id } })).possibleDuplicateIds, [d1.listing.propertyId, a.listing.propertyId]);
    await repository.prisma.listing.updateMany({ where: { address: { startsWith: "Минск, ул. Другая, " } }, data: { isActive: false } });
    const withPhotos = { ...candidate(28), photos: ["https://example.org/one.jpg", "https://example.org/two.jpg"], photosComplete: true };
    await repository.observe(withPhotos);
    const preview = await repository.observe({ ...withPhotos, description: "", photos: [withPhotos.photos[0]!], photosComplete: false });
    assert.equal(preview.listing.photos.length, 2, "Search preview must not erase enriched gallery");
    assert.equal(preview.changed, false, "Unchanged search preview must not repeatedly schedule enrichment");
    const teaser = { ...candidate(90), description: "Продается квартира", descriptionComplete: false, sourcePayload: { body_short: "Продается квартира" } };
    const initialTeaser = await repository.observe(teaser);
    assert.equal(initialTeaser.listing.disposition, "REVIEW");
    const fullText = "Продается квартира целиком. Полное описание с характеристиками и условиями продажи.";
    const full = await repository.observe({ ...teaser, description: fullText, descriptionComplete: true,
      features: { ...teaser.features!, descriptionComplete: true } }, undefined, { recordObservation: false });
    assert.equal(full.listing.disposition, "ACCEPTED");
    const preserved = await repository.observe(teaser);
    assert.equal(preserved.listing.description, fullText);
    assert.equal(preserved.listing.disposition, "ACCEPTED");
    assert.equal(preserved.changed, false, "Stable short text must not invalidate full-card enrichment");
    const editedTeaser = { ...teaser, description: "Новые условия продажи", sourcePayload: { body_short: "Новые условия продажи" } };
    const edited = await repository.observe(editedTeaser);
    assert.equal(edited.listing.description, fullText, "Preserve known full text pending verification");
    assert.equal(edited.listing.disposition, "REVIEW");
    assert.equal(edited.changed, true);
    assert.equal((await repository.observe(editedTeaser)).listing.disposition, "REVIEW");
    assert.equal((await repository.observe({ ...editedTeaser, description: "Продается ½ доля" })).listing.disposition, "EXCLUDED", "New partial-sale evidence must override old whole-apartment description");
    const settingsUpdate = await app.inject({ method: "PUT", url: "/api/settings", payload: { ...DEFAULT_SETTINGS, targetLatitude: 53.91 } });
    assert.equal(settingsUpdate.statusCode, 200, settingsUpdate.body);
    assert.equal((await repository.settings()).targetLatitude, 53.91);
    assert.equal((await worker.boss.findJobs("route-refresh", { queued: true })).length, 1, "Settings refresh must enqueue work without blocking the API");
    const invalidSettings = await app.inject({ method: "PUT", url: "/api/settings", payload: { ...DEFAULT_SETTINGS, layoutWeight: 29 } });
    assert.equal(invalidSettings.statusCode, 400);
    await assertRepairWorkflow(app, repository, assessment, photoRepair, candidate(0));
    const rankingSubject = (await repository.page({}, 1, 100, "value")).items.find((item) => item.disposition === "ACCEPTED" && !item.hidden);
    assert.ok(rankingSubject);
    await assertPersonalRankingApi(app, repository, rankingSubject.id);
    logger.warn({ assertions: "passed", database: name }, "Catalog database and API integration checks passed");
  } finally {
    await app?.close(); await worker?.stop(); await connection?.close();
    // The only removable database is the random one created by this test invocation.
    assert.match(name, /^catalog_test_[a-f0-9]{32}$/);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
  }
};
void main().catch((error: unknown) => { logger.error({ err: error }, "Catalog integration tests failed"); process.exitCode = 1; });
