import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import pino from "pino";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { registerDuplicateRoutes } from "../src/api/duplicateRoutes.js";
import { createApi } from "../src/api/app.js";
import type { CatalogWorker } from "../src/services/catalogWorker.js";
import { createPrismaConnection } from "../src/infrastructure/db/prisma.js";
import { CatalogRepository } from "../src/infrastructure/repositories/catalogRepository.js";
import { DuplicateService } from "../src/services/duplicateService.js";
import { RetryHttpClient } from "../src/infrastructure/http/retryHttpClient.js";

const logger = pino({ level: "silent" });

const main = async (): Promise<void> => {
  const databaseUrl = process.env["DATABASE_URL"];
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const name = `duplicate_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  let connection: ReturnType<typeof createPrismaConnection> | undefined;
  let app: FastifyInstance | undefined;
  let userApi: FastifyInstance | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const migration = new Pool({ connectionString: url.toString() });
    try {
      const folders = (await readdir(resolve("prisma/migrations"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      for (const folder of folders.filter((entry) => entry.name < "20261110")) await migration.query(await readFile(resolve("prisma/migrations", folder.name, "migration.sql"), "utf8"));
      const legacyPropertyId = randomUUID(), legacyListingId = randomUUID();
      await migration.query('INSERT INTO "Property" (id, favorite, hidden, "renovationBudgetUsd", "assessmentRevision") VALUES ($1, true, true, 12345.67, 9)', [legacyPropertyId]);
      await migration.query('INSERT INTO "Listing" (id, platform, "externalId", url, title, description, rooms, "areaSqm", "priceUsd", "pricePerSqm", "sourcePayload", "propertyId", "updatedAt") VALUES ($1, \'KUFAR\', \'migration-fixture\', \'https://fixture.invalid/legacy\', \'Legacy\', \'Preserve\', 2, 50, 70000, 1400, \'{}\', $2, CURRENT_TIMESTAMP)', [legacyListingId, legacyPropertyId]);
      await migration.query('INSERT INTO "PriceHistory" (id, "listingId", "priceUsd", "pricePerSqm") VALUES ($1, $2, 69000, 1380)', [randomUUID(), legacyListingId]);
      await migration.query('INSERT INTO "ShadowRanking" ("propertyId", "rankingVersion", score, coverage, provisional, breakdown, "settingsKey", "updatedAt") VALUES ($1, 1, 77, 0.8, true, \'{"legacy":true}\', \'legacy-settings\', CURRENT_TIMESTAMP)', [legacyPropertyId]);
      const preservedQueries = [
        'SELECT to_jsonb(p) - \'userStateRevision\' AS row FROM "Property" p',
        'SELECT to_jsonb(l) - \'duplicateCheckPending\' AS row FROM "Listing" l',
        'SELECT to_jsonb(h) AS row FROM "PriceHistory" h',
        'SELECT to_jsonb(s) AS row FROM "ShadowRanking" s'
      ];
      const legacyRows = await Promise.all(preservedQueries.map(async (query) => (await migration.query(query)).rows));
      for (const folder of folders.filter((entry) => entry.name >= "20261110")) await migration.query(await readFile(resolve("prisma/migrations", folder.name, "migration.sql"), "utf8"));
      assert.deepEqual(await Promise.all(preservedQueries.map(async (query) => (await migration.query(query)).rows)), legacyRows, "Additive migrations preserve populated legacy ranking, user state, listings and price history");
      assert.equal((await migration.query<{ userStateRevision: number }>('SELECT "userStateRevision" FROM "Property" WHERE id = $1', [legacyPropertyId])).rows[0]!.userStateRevision, 0);
      assert.equal((await migration.query<{ duplicateCheckPending: boolean }>('SELECT "duplicateCheckPending" FROM "Listing" WHERE id = $1', [legacyListingId])).rows[0]!.duplicateCheckPending, false);
    } finally { await migration.end(); }
    connection = createPrismaConnection({ databaseUrl: url.toString() });
    const repository = new CatalogRepository(connection.prisma);
    const service = new DuplicateService(repository, new RetryHttpClient(logger), logger);
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : 500).send({ message: error instanceof Error ? error.message : "Unknown test error" }));
    registerDuplicateRoutes(app, {
      requestDuplicateAudit: async () => {}, confirmDuplicate: async () => false,
      listDuplicateMerges: (propertyId) => service.listMerges(propertyId), undoDuplicateMerge: (id) => service.undoMerge(id)
    });
    const createPair = async (suffix: string) => {
      const primary = await repository.prisma.property.create({ data: { favorite: false } });
      const secondary = await repository.prisma.property.create({ data: { favorite: true, renovationBudgetUsd: 8000 } });
      const base = { title: "Квартира", description: "Продажа", url: "https://fixture.invalid", rooms: 2, areaSqm: 50, priceUsd: 70000,
        pricePerSqm: 1400, latitude: 53.9, longitude: 27.56, photos: [], sourcePayload: {}, address: `Минск, ул. Общая, ${suffix}`,
        locality: "Минск", floor: 4, totalFloors: 9, kitchenSqm: 9, livingSqm: 30, buildingYear: 1985, disposition: "ACCEPTED", contentHash: "unchanged" };
      const left = await repository.prisma.listing.create({ data: { ...base, platform: "KUFAR", externalId: `left-${suffix}`, propertyId: primary.id } });
      const right = await repository.prisma.listing.create({ data: { ...base, platform: "ONLINER", externalId: `right-${suffix}`, propertyId: secondary.id } });
      await repository.prisma.priceHistory.create({ data: { listingId: right.id, priceUsd: 70000, pricePerSqm: 1400 } });
      return { primary, secondary, left, right, base };
    };
    const repost = await createPair("99");
    const originalDescription = "Продаётся уютная квартира с большой застеклённой лоджией. Окна выходят в тихий зелёный двор. В прихожей установлен вместительный шкаф, на кухне остаётся мебель и вся встроенная техника. Во дворе есть детская площадка, рядом находятся школа и магазины.";
    await repository.prisma.listing.update({ where: { id: repost.left.id }, data: { description: originalDescription } });
    const missingAddress = await repository.prisma.listing.update({ where: { id: repost.right.id }, data: {
      address: "", description: `• ${originalDescription} Приглашаем на просмотр.`, priceUsd: 69999
    } });
    const otherProperty = await repository.prisma.property.create({ data: {} });
    const otherListing = await repository.prisma.listing.create({ data: {
      ...repost.base, description: originalDescription, platform: "KUFAR", externalId: "other-repost", propertyId: otherProperty.id
    } });
    assert.equal(await service.reconcile(missingAddress, undefined, { metadataOnly: true, candidateIds: [repost.left.id] }), false,
      "Matching text across multiple property groups is ambiguous, including a targeted run");
    await repository.prisma.listing.update({ where: { id: otherListing.id }, data: { description: "Продажа" } });
    assert.equal(await service.reconcile(missingAddress, undefined, { metadataOnly: true }), true, "Matching text and location can link a repost without a street address");
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: repost.right.id } })).propertyId, repost.primary.id);
    const mergedRepost = await repository.item(repost.primary.id);
    assert.equal(mergedRepost?.listingId, repost.right.id);
    assert.equal(mergedRepost?.features.address, repost.base.address);
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: otherListing.id } })).propertyId, otherProperty.id, "An equally sized apartment in the building stays separate");
    const pair = await createPair("10");
    const unrelated = await repository.prisma.property.create({ data: {} });
    const external = await repository.prisma.listing.create({ data: { platform: "REALT", externalId: "external", url: "https://fixture.invalid/external", title: "Другая", description: "", rooms: 1, areaSqm: 30, priceUsd: 40000, pricePerSqm: 1333, photos: [], sourcePayload: {}, propertyId: unrelated.id, possibleDuplicateIds: [pair.secondary.id, unrelated.id] } });
    const search = await repository.prisma.savedSearch.create({ data: { name: "Поиск", filters: {}, notifications: true } });
    await repository.prisma.searchMatch.create({ data: { searchId: search.id, propertyId: pair.secondary.id, priceUsd: 70000 } });
    const notification = await repository.prisma.notification.create({ data: { eventKey: "test-undo", searchId: search.id, propertyId: pair.secondary.id, kind: "NEW" } });
    await repository.prisma.assessment.create({ data: { propertyId: pair.secondary.id, version: "test", valueScore: 80, comfortScore: 70, coverage: 90, confidence: "high", comparableCount: 6, data: { preserved: true } } });
    assert.equal(await service.reconcile(pair.right, undefined, { candidateIds: [pair.left.id], structuredOnly: true }), true);
    const merges = await service.listMerges(pair.primary.id);
    assert.equal(merges.length, 1, "A committed merge must have an atomic undo journal");
    assert.equal((await repository.prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).status, "SUPERSEDED");
    assert.equal((await service.undoMerge(merges[0]!.id)).ok, true);
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: pair.right.id } })).propertyId, pair.secondary.id);
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: pair.left.id } })).isRepresentative, true);
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: pair.right.id } })).isRepresentative, true);
    assert.deepEqual((await repository.prisma.listing.findUniqueOrThrow({ where: { id: external.id } })).possibleDuplicateIds, [pair.secondary.id, unrelated.id]);
    assert.equal((await repository.prisma.property.findUniqueOrThrow({ where: { id: pair.primary.id } })).favorite, false);
    assert.equal((await repository.prisma.property.findUniqueOrThrow({ where: { id: pair.secondary.id } })).favorite, true);
    assert.ok((await repository.prisma.property.findUniqueOrThrow({ where: { id: pair.primary.id } })).assessmentRevision > pair.primary.assessmentRevision + 1, "Undo must not reuse a pre-merge assessment revision");
    assert.ok((await repository.prisma.property.findUniqueOrThrow({ where: { id: pair.secondary.id } })).assessmentRevision > pair.secondary.assessmentRevision, "Detached property must reject pre-merge assessment jobs");
    assert.equal((await repository.prisma.property.findUniqueOrThrow({ where: { id: pair.primary.id } })).userStateRevision, pair.primary.userStateRevision + 2, "Merge and undo must both advance the revision");
    assert.equal((await repository.prisma.property.findUniqueOrThrow({ where: { id: pair.secondary.id } })).userStateRevision, pair.secondary.userStateRevision + 1, "Undo must advance the detached property's revision");
    assert.equal((await repository.prisma.assessment.findUniqueOrThrow({ where: { propertyId: pair.secondary.id } })).valueScore, 80);
    assert.equal((await repository.prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).status, "PENDING");
    assert.equal(await repository.prisma.searchMatch.count({ where: { propertyId: pair.primary.id } }), 0);
    assert.equal(await repository.prisma.searchMatch.count({ where: { propertyId: pair.secondary.id } }), 1);
    assert.equal(await repository.prisma.priceHistory.count({ where: { listingId: pair.right.id } }), 1);
    assert.deepEqual(await service.undoMerge(merges[0]!.id), { ok: false, reason: "already-undone" });
    assert.deepEqual(await service.undoMerge(randomUUID()), { ok: false, reason: "not-found" });
    const history = await app.inject({ url: `/api/duplicates/merges?propertyId=${pair.primary.id}` });
    assert.equal(history.statusCode, 200);
    assert.equal((history.json() as { merges: unknown[] }).merges.length, 1);
    assert.equal(history.body.includes("before"), false, "History endpoint does not expose private journal snapshots");
    assert.equal((await app.inject({ url: "/api/duplicates/merges?propertyId=broken" })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/duplicates/merges/${randomUUID()}/undo` })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/duplicates/merges/${merges[0]!.id}/undo` })).statusCode, 409);

    const changed = await createPair("20");
    assert.equal(await service.reconcile(changed.right, undefined, { candidateIds: [changed.left.id], structuredOnly: true }), true);
    const changedMerge = (await service.listMerges(changed.primary.id))[0]!;
    await repository.prisma.property.update({ where: { id: changed.primary.id }, data: { renovationBudgetUsd: 9000 } });
    assert.deepEqual(await service.undoMerge(changedMerge.id), { ok: false, reason: "state-changed" });
    assert.equal(Number((await repository.prisma.property.findUniqueOrThrow({ where: { id: changed.primary.id } })).renovationBudgetUsd), 9000);
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: changed.right.id } })).propertyId, changed.primary.id);

    const noticePair = await createPair("21");
    const changedNotice = await repository.prisma.notification.create({ data: { eventKey: "notice-conflict", searchId: search.id, propertyId: noticePair.secondary.id, kind: "NEW" } });
    assert.equal(await service.reconcile(noticePair.right, undefined, { candidateIds: [noticePair.left.id], structuredOnly: true }), true);
    const noticeMerge = (await service.listMerges(noticePair.primary.id))[0]!;
    await repository.prisma.notification.update({ where: { id: changedNotice.id }, data: { attempts: 1 } });
    const noticeConflict = await app.inject({ method: "POST", url: `/api/duplicates/merges/${noticeMerge.id}/undo` });
    assert.equal(noticeConflict.statusCode, 409);
    assert.equal((await repository.prisma.notification.findUniqueOrThrow({ where: { id: changedNotice.id } })).attempts, 1);
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: noticePair.right.id } })).propertyId, noticePair.primary.id);

    const linkedPair = await createPair("22");
    await repository.prisma.listing.update({ where: { id: external.id }, data: { possibleDuplicateIds: [linkedPair.secondary.id] } });
    assert.equal(await service.reconcile(linkedPair.right, undefined, { candidateIds: [linkedPair.left.id], structuredOnly: true }), true);
    const linkedMerge = (await service.listMerges(linkedPair.primary.id))[0]!;
    await repository.prisma.listing.update({ where: { id: external.id }, data: { possibleDuplicateIds: [linkedPair.primary.id, unrelated.id] } });
    assert.deepEqual(await service.undoMerge(linkedMerge.id), { ok: false, reason: "state-changed" });
    assert.deepEqual((await repository.prisma.listing.findUniqueOrThrow({ where: { id: external.id } })).possibleDuplicateIds, [linkedPair.primary.id, unrelated.id]);

    const extended = await createPair("23");
    assert.equal(await service.reconcile(extended.right, undefined, { candidateIds: [extended.left.id], structuredOnly: true }), true);
    const originalMerge = (await service.listMerges(extended.primary.id))[0]!;
    const thirdProperty = await repository.prisma.property.create({ data: {} });
    const third = await repository.prisma.listing.create({ data: { ...extended.base, platform: "REALT", externalId: "third-23", propertyId: thirdProperty.id } });
    assert.equal(await service.reconcile(third, undefined, { candidateIds: [extended.left.id], structuredOnly: true }), true);
    assert.deepEqual(await service.undoMerge(originalMerge.id), { ok: false, reason: "state-changed" }, "Later merges cannot be split by replaying an obsolete journal");

    const raced = await createPair("30");
    const outcomes = await Promise.all([service.reconcile(raced.right, undefined, { candidateIds: [raced.left.id], structuredOnly: true }), service.reconcile(raced.right, undefined, { candidateIds: [raced.left.id], structuredOnly: true })]);
    assert.equal(outcomes.filter(Boolean).length, 1, "Concurrent attempts commit one journal and one coherent merge");
    assert.equal((await service.listMerges(raced.primary.id)).length, 1);
    const racedMerge = (await service.listMerges(raced.primary.id))[0]!;
    const undos = await Promise.all([service.undoMerge(racedMerge.id), service.undoMerge(racedMerge.id)]);
    assert.equal(undos.filter((result) => result.ok).length, 1);
    const pendingPair = await createPair("34");
    const pending = await repository.prisma.listing.update({ where: { id: pendingPair.right.id }, data: { duplicateCheckPending: true } });
    assert.equal(await repository.item(pendingPair.secondary.id), null);
    const publicationResults = await Promise.allSettled([service.checkAndPublish(pendingPair.left), service.checkAndPublish(pending)]);
    assert.equal(publicationResults.filter((result) => result.status === "fulfilled" && result.value).length, 1);
    assert.equal(await repository.item(pendingPair.secondary.id), null);
    assert.equal((await repository.item(pendingPair.primary.id))?.sources.length, 2, "Concurrent checks keep the existing published property ID");
    assert.equal((await service.listMerges(pendingPair.primary.id)).length, 1);
    const apiPair = await createPair("31");
    assert.equal(await service.reconcile(apiPair.right, undefined, { candidateIds: [apiPair.left.id], structuredOnly: true }), true);
    const apiMerge = (await service.listMerges(apiPair.primary.id))[0]!;
    assert.equal((await app.inject({ method: "POST", url: `/api/duplicates/merges/${apiMerge.id}/undo` })).statusCode, 200);
    const corruptPair = await createPair("32");
    assert.equal(await service.reconcile(corruptPair.right, undefined, { candidateIds: [corruptPair.left.id], structuredOnly: true }), true);
    const corruptMerge = (await service.listMerges(corruptPair.primary.id))[0]!;
    await repository.prisma.$executeRaw`UPDATE "DuplicateMerge" SET after = '{}'::jsonb WHERE id = ${corruptMerge.id}`;
    assert.deepEqual(await service.undoMerge(corruptMerge.id), { ok: false, reason: "state-changed" }, "An unsupported or corrupted journal cannot be applied");
    userApi = await createApi({ repository, worker: {
      requestDuplicateAudit: async () => {}, requestAssessment: async () => {}, confirmDuplicate: async () => false,
      listDuplicateMerges: (propertyId: string) => service.listMerges(propertyId), undoDuplicateMerge: (id: string) => service.undoMerge(id)
    } as unknown as CatalogWorker });
    for (const field of ["favorite", "hidden"] as const) {
      const aba = await createPair(field === "favorite" ? "40" : "41");
      assert.equal(await service.reconcile(aba.right, undefined, { candidateIds: [aba.left.id], structuredOnly: true }), true);
      const abaMerge = (await service.listMerges(aba.primary.id))[0]!;
      const original = field === "favorite";
      const mergedRevision = (await repository.prisma.property.findUniqueOrThrow({ where: { id: aba.primary.id } })).userStateRevision;
      for (const value of [!original, original]) assert.equal((await userApi.inject({ method: "PATCH", url: `/api/listings/${aba.primary.id}/state`, payload: { [field]: value } })).statusCode, 200);
      const refused: { statusCode: number } = await userApi.inject({ method: "POST", url: `/api/duplicates/merges/${abaMerge.id}/undo` });
      assert.equal(refused.statusCode, 409, `${field} changes must remain detectable after the value returns to its post-merge value`);
      assert.equal((await repository.prisma.property.findUniqueOrThrow({ where: { id: aba.primary.id } }))[field], original);
      assert.equal((await repository.prisma.property.findUniqueOrThrow({ where: { id: aba.primary.id } })).userStateRevision, mergedRevision + 2);
      assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: aba.right.id } })).propertyId, aba.primary.id);
    }
    const budgetAba = await createPair("42");
    assert.equal(await service.reconcile(budgetAba.right, undefined, { candidateIds: [budgetAba.left.id], structuredOnly: true }), true);
    const budgetMerge = (await service.listMerges(budgetAba.primary.id))[0]!;
    for (const budgetUsd of [9000, 8000]) assert.equal((await userApi.inject({ method: "PATCH", url: `/api/listings/${budgetAba.primary.id}/renovation-budget`, payload: { budgetUsd } })).statusCode, 200);
    assert.equal((await userApi.inject({ method: "POST", url: `/api/duplicates/merges/${budgetMerge.id}/undo` })).statusCode, 409);
    assert.equal(Number((await repository.prisma.property.findUniqueOrThrow({ where: { id: budgetAba.primary.id } })).renovationBudgetUsd), 8000);
    assert.equal((await repository.prisma.property.findUniqueOrThrow({ where: { id: budgetAba.primary.id } })).userStateRevision, budgetAba.primary.userStateRevision + 3);

    const userRace = await createPair("43");
    assert.equal(await service.reconcile(userRace.right, undefined, { candidateIds: [userRace.left.id], structuredOnly: true }), true);
    const userRaceMerge = (await service.listMerges(userRace.primary.id))[0]!;
    const [userWrite, userUndo] = await Promise.all([
      userApi.inject({ method: "PATCH", url: `/api/listings/${userRace.primary.id}/state`, payload: { favorite: true } }),
      userApi.inject({ method: "POST", url: `/api/duplicates/merges/${userRaceMerge.id}/undo` })
    ]);
    assert.equal(userWrite.statusCode, 200);
    assert.ok([200, 409].includes(userUndo.statusCode));
    assert.equal((await repository.prisma.property.findUniqueOrThrow({ where: { id: userRace.primary.id } })).favorite, true, "Concurrent undo must not overwrite a user write");
    const legacyJournal = await createPair("44");
    assert.equal(await service.reconcile(legacyJournal.right, undefined, { candidateIds: [legacyJournal.left.id], structuredOnly: true }), true);
    const legacyMerge = (await service.listMerges(legacyJournal.primary.id))[0]!;
    await repository.prisma.$executeRaw`UPDATE "DuplicateMerge" SET after = jsonb_set(after, '{properties}', (SELECT jsonb_agg(value - 'userStateRevision') FROM jsonb_array_elements(after->'properties'))) WHERE id = ${legacyMerge.id}`;
    assert.deepEqual(await service.undoMerge(legacyMerge.id), { ok: false, reason: "state-changed" }, "Journals without mutation provenance must fail closed");
    assert.equal((await repository.prisma.listing.findUniqueOrThrow({ where: { id: legacyJournal.right.id } })).propertyId, legacyJournal.primary.id);
    console.log("Duplicate merge journal, reversal, conflicts and races passed");
  } finally {
    await userApi?.close();
    await app?.close();
    await connection?.close();
    assert.match(name, /^duplicate_test_[a-f0-9]{32}$/);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
};

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
