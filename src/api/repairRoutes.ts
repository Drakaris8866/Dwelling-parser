import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { photoDecisionSchema, renovationBudgetSchema } from "../contracts/photoRepair.js";
import type { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import type { CatalogWorker } from "../services/catalogWorker.js";
import { PhotoRepairError, type PhotoRepairService } from "../services/photoRepairService.js";

const params = z.object({ id: z.string().uuid() });
export const registerRepairRoutes = (app: FastifyInstance, repository: CatalogRepository, worker: CatalogWorker, photos?: PhotoRepairService): void => {
  app.post("/api/listings/:id/photo-repair", async (request, reply) => {
    const item = await repository.item(params.parse(request.params).id);
    if (!item || item.disposition === "EXCLUDED") return reply.code(404).send({ message: "Квартира не найдена" });
    if (!photos) return reply.code(503).send({ message: "Локальный анализ фото не включён" });
    try {
      const result = await photos.request(item.listingId, (id) => worker.requestPhotoRepair(id));
      return reply.code(result === "cached" ? 200 : 202).send({ ok: true });
    } catch (error: unknown) {
      if (error instanceof PhotoRepairError) return reply.code(error.statusCode).send({ message: error.message });
      throw error;
    }
  });
  app.patch("/api/listings/:id/photo-repair", async (request, reply) => {
    const item = await repository.item(params.parse(request.params).id);
    const input = photoDecisionSchema.parse(request.body);
    if (!item || item.disposition === "EXCLUDED") return reply.code(404).send({ message: "Квартира не найдена" });
    if (!photos) return reply.code(503).send({ message: "Анализ фото не подключён" });
    try { await photos.decide(item.listingId, item.id, input); }
    catch (error: unknown) {
      if (error instanceof PhotoRepairError) return reply.code(error.statusCode).send({ message: error.message });
      throw error;
    }
    await worker.requestAssessment();
    return { ok: true };
  });
  app.patch("/api/listings/:id/renovation-budget", async (request, reply) => {
    const id = params.parse(request.params).id, { budgetUsd } = renovationBudgetSchema.parse(request.body);
    const item = await repository.item(id);
    if (!item || item.disposition === "EXCLUDED") return reply.code(404).send({ message: "Квартира не найдена" });
    await repository.prisma.property.update({ where: { id }, data: { renovationBudgetUsd: budgetUsd, assessmentRevision: { increment: 1 }, userStateRevision: { increment: 1 } } });
    await worker.requestAssessment();
    return { ok: true };
  });
};
