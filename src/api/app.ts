import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import axios from "axios";
import { z } from "zod";
import type { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import { buildListingWhere } from "../infrastructure/repositories/catalogRepository.js";
import type { CatalogWorker } from "../services/catalogWorker.js";
import { filtersSchema, sortSchema, settingsSchema, saveSearchInputSchema, savedSearchSchema, platformSchema, featuresSchema, type CatalogHealth, type CatalogItem, type RouteQueueStatus } from "../contracts/catalog.js";
import { routeQueueStatus } from "../infrastructure/queue/routeQueueStatus.js";
import { backgroundTasks } from "../infrastructure/queue/backgroundTasks.js";
import { clusterMapPoints } from "../utils/mapClusters.js";
import { toPrismaJson } from "../utils/json.js";
import { Prisma } from "../generated/prisma/client.js";
import { registerRepairRoutes } from "./repairRoutes.js";
import { registerDuplicateRoutes } from "./duplicateRoutes.js";
import { registerPersonalRankingRoutes } from "./personalRankingRoutes.js";
import type { PhotoRepairService } from "../services/photoRepairService.js";

const querySchema = z.object({ filters: z.string().max(12000).default("{}"), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(24), sort: sortSchema.default("newest"), zoom: z.coerce.number().min(3).max(20).default(11) });
const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { readonly repository: CatalogRepository; readonly worker: CatalogWorker; readonly photoRepair?: PhotoRepairService };
export const createApi = async ({ repository, worker, photoRepair }: Context): Promise<FastifyInstance> => {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info", redact: ["req.headers.authorization", "req.headers.cookie"] }, bodyLimit: 64 * 1024 });
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      let local = false;
      try { const parsed = new URL(origin); local = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname); } catch { local = false; }
      if (!local) return reply.code(403).send({ message: "Запросы разрешены только из локального каталога" });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return reply.code(400).send({ message: "Некорректные параметры запроса", details: error.message });
    request.log.error({ err: error }, "Catalog API request failed");
    return reply.code(500).send({ message: "Не удалось выполнить запрос. Проверьте состояние базы данных." });
  });
  const query = (raw: unknown): { parsed: z.infer<typeof querySchema>; filters: z.infer<typeof filtersSchema> } => {
    const parsed = querySchema.parse(raw);
    return { parsed, filters: filtersSchema.parse(JSON.parse(parsed.filters) as unknown) };
  };
  const queueInfo = async (items: readonly CatalogItem[]): Promise<Map<string, RouteQueueStatus>> => {
    try { return await routeQueueStatus(repository.prisma, items); }
    catch (err: unknown) { app.log.warn({ err }, "Route queue estimate unavailable"); return new Map(); }
  };
  app.get("/api/listings", async (request) => {
    const { parsed, filters } = query(request.query), page = await repository.page(filters, parsed.page, parsed.pageSize, parsed.sort);
    const queue = await queueInfo(page.items);
    return { ...page, items: page.items.map((item) => ({ ...item, routeQueue: queue.get(item.listingId) })) };
  });
  app.get("/api/listings/:id", async (request, reply) => {
    const detail = await repository.detail(paramsSchema.parse(request.params).id);
    if (!detail) return reply.code(404).send({ message: "Квартира не найдена" });
    const queue = await queueInfo([detail.item]);
    return { ...detail, item: { ...detail.item, routeQueue: queue.get(detail.item.listingId) }, photoRepairAvailable: photoRepair?.enabled ?? false };
  });
  registerRepairRoutes(app, repository, worker, photoRepair);
  registerDuplicateRoutes(app, worker);
  registerPersonalRankingRoutes(app, repository);
  app.post("/api/listings/:id/route", async (request, reply) => {
    const item = await repository.item(paramsSchema.parse(request.params).id);
    if (!item || item.disposition === "EXCLUDED") return reply.code(404).send({ message: "Квартира не найдена" });
    if (item.latitude === null || item.longitude === null) return reply.code(422).send({ message: "У квартиры нет координат" });
    await worker.prioritizeRoute(item.listingId);
    return reply.code(202).send({ ok: true });
  });
  app.get("/api/map", async (request) => {
    const { parsed, filters } = query(request.query);
    const where = buildListingWhere(filters, repository.prisma.listing.fields);
    const [total, rows] = await repository.prisma.$transaction([
      repository.prisma.listing.count({ where }), repository.prisma.listing.findMany({ where: { AND: [where, { latitude: { not: null }, longitude: { not: null } }] }, select: { propertyId: true, latitude: true, longitude: true, priceUsd: true } })
    ]);
    return { total, located: rows.length, points: clusterMapPoints(rows.map((row) => ({ propertyId: row.propertyId!, latitude: Number(row.latitude), longitude: Number(row.longitude), price: Number(row.priceUsd) })), parsed.zoom) };
  });
  app.patch("/api/listings/:id/state", async (request) => {
    const id = paramsSchema.parse(request.params).id;
    const state = z.object({ favorite: z.boolean().optional(), hidden: z.boolean().optional() }).strict().parse(request.body);
    const data = { ...(state.favorite === undefined ? {} : { favorite: state.favorite }), ...(state.hidden === undefined ? {} : { hidden: state.hidden }) };
    await repository.prisma.property.update({ where: { id }, data: { ...data, userStateRevision: { increment: 1 } } });
    return { ok: true };
  });
  app.get("/api/facets", async () => {
    const rows = await repository.prisma.listing.findMany({ where: { isActive: true, duplicateCheckPending: false, disposition: { in: ["ACCEPTED", "REVIEW"] } }, select: { locality: true, district: true }, distinct: ["locality", "district"] });
    return { localities: [...new Set(rows.flatMap((r) => r.locality ? [r.locality] : []))].sort(), districts: [...new Set(rows.flatMap((r) => r.district ? [r.district] : []))].sort() };
  });
  app.get("/api/searches", async () => (await repository.prisma.savedSearch.findMany({ orderBy: { createdAt: "desc" } })).map((row) => savedSearchSchema.parse({ ...row, initializedAt: row.initializedAt?.toISOString() ?? null })));
  app.post("/api/searches", async (request, reply) => {
    const input = saveSearchInputSchema.parse(request.body);
    const row = await repository.prisma.savedSearch.create({ data: { name: input.name, filters: toPrismaJson(input.filters), notifications: input.notifications } });
    return reply.code(201).send(savedSearchSchema.parse({ ...row, initializedAt: null }));
  });
  app.patch("/api/searches/:id", async (request) => {
    const id = paramsSchema.parse(request.params).id;
    const input = saveSearchInputSchema.partial().parse(request.body);
    await repository.prisma.$transaction(async (tx) => {
      await tx.savedSearch.update({ where: { id }, data: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.notifications === undefined ? {} : { notifications: input.notifications }),
        ...(input.filters === undefined ? {} : { filters: toPrismaJson(input.filters) }), ...(input.filters !== undefined || input.notifications === true ? { initializedAt: null } : {}) } });
      if (input.filters) await tx.searchMatch.deleteMany({ where: { searchId: id } });
      if (input.filters || input.notifications === false) await tx.notification.updateMany({ where: { searchId: id, status: "PENDING" }, data: { status: "SUPERSEDED" } });
    });
    return { ok: true };
  });
  app.delete("/api/searches/:id", async (request) => { await repository.prisma.savedSearch.delete({ where: { id: paramsSchema.parse(request.params).id } }); return { ok: true }; });
  app.get("/api/settings", async () => repository.settings());
  app.put("/api/settings", async (request) => {
    const settings = settingsSchema.parse(request.body), previous = await repository.settings();
    await repository.saveSettings(settings);
    if (settings.targetLatitude !== previous.targetLatitude || settings.targetLongitude !== previous.targetLongitude || settings.arrivalTime !== previous.arrivalTime) {
      await repository.prisma.listing.updateMany({ where: { isActive: true }, data: { routeData: Prisma.DbNull, routeStatus: "PENDING", routeError: null, routeAttemptedAt: null, timeToTargetTransit: null, targetTransitSummary: null } });
      await repository.prisma.assessment.updateMany({ data: { comfortScore: null, coverage: 0 } });
      await worker.refreshRoutes();
    }
    await worker.requestAssessment();
    return settings;
  });
  app.post("/api/sync", async (_request, reply) => { await worker.syncNow(); return reply.code(202).send({ ok: true }); });
  app.get("/api/health", async (): Promise<CatalogHealth> => {
    const sources: CatalogHealth["sources"] = [];
    for (const platform of platformSchema.options) {
      const row = await repository.prisma.sourceSyncRun.findFirst({ where: { platform }, orderBy: { startedAt: "desc" } });
      const lastSuccess = await repository.prisma.sourceSyncRun.findFirst({ where: { platform, status: "COMPLETE" }, orderBy: { finishedAt: "desc" }, select: { finishedAt: true } });
      const counts = await repository.prisma.listing.groupBy({ by: ["disposition"], where: { platform, isActive: true }, _count: { _all: true } });
      sources.push({ platform, status: row?.status ?? "NOT_STARTED", pages: row?.pages ?? 0, received: row?.received ?? 0, accepted: row?.accepted ?? 0,
        review: row?.review ?? 0, excluded: row?.excluded ?? 0, invalid: row?.invalid ?? 0, detailErrors: row?.detailErrors ?? 0,
        reasons: z.record(z.string(), z.number()).parse(row?.reasons ?? {}), error: row?.error ?? null, startedAt: row?.startedAt.toISOString() ?? null, finishedAt: row?.finishedAt?.toISOString() ?? null,
        lastSuccessfulAt: lastSuccess?.finishedAt?.toISOString() ?? null,
        catalogAccepted: counts.find((c) => c.disposition === "ACCEPTED")?._count._all ?? 0,
        catalogReview: counts.find((c) => c.disposition === "REVIEW")?._count._all ?? 0,
        catalogExcluded: counts.find((c) => c.disposition === "EXCLUDED")?._count._all ?? 0 });
    }
    const otp = await axios.get<unknown>((process.env["OTP_PLAN_URL"] ?? "http://localhost:8080/otp/routers/default/plan").replace("/routers/default/plan", "/routers"), { timeout: 2000 })
      .then(() => ({ available: true, message: "OTP доступен" })).catch(() => ({ available: false, message: "OTP недоступен; сохранённые квартиры остаются доступны" }));
    const tasks = await backgroundTasks(repository.prisma);
    return { sources, otp, tasks, pendingJobs: tasks.reduce((sum, task) => sum + task.queued + task.active, 0) };
  });
  const webRoot = resolve("web/dist");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: true });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ message: "Метод не найден" }) : reply.sendFile("index.html"));
  }
  return app;
};
