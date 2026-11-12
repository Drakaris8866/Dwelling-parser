import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CatalogWorker } from "../services/catalogWorker.js";
import { readDuplicateAudit } from "../services/duplicateAuditService.js";
import { duplicateSnapshot } from "../contracts/duplicateAudit.js";

const paging = z.object({ page: z.coerce.number().int().positive().default(1), address: z.string().trim().max(120).default("") });
const selection = z.object({ leftId: z.string().uuid(), rightId: z.string().uuid(), snapshot: z.string().max(512) }).strict();
const mergeQuery = z.object({ propertyId: z.string().uuid() }).strict();
const mergeParams = z.object({ id: z.string().uuid() }).strict();
export const registerDuplicateRoutes = (app: FastifyInstance, worker: Pick<CatalogWorker, "requestDuplicateAudit" | "confirmDuplicate" | "listDuplicateMerges" | "undoDuplicateMerge">): void => {
  app.get("/api/duplicates/merges", async (request) => {
    const { propertyId } = mergeQuery.parse(request.query);
    return { merges: await worker.listDuplicateMerges(propertyId) };
  });
  app.post("/api/duplicates/merges/:id/undo", async (request, reply) => {
    const { id } = mergeParams.parse(request.params);
    const result = await worker.undoDuplicateMerge(id);
    if (result.ok) return result;
    const messages = {
      "not-found": "Журнал объединения не найден. Старые объединения без журнала отменить нельзя.",
      "already-undone": "Это объединение уже отменено.",
      "state-changed": "После объединения данные изменились. Отмена отклонена, чтобы сохранить изменения."
    };
    return reply.code(result.reason === "not-found" ? 404 : 409).send({ ...result, message: messages[result.reason] });
  });
  app.get("/api/duplicates", async (request) => {
    const { page, address } = paging.parse(request.query);
    const audit = await readDuplicateAudit();
    const pairs = audit.pairs.filter((pair) => pair.address.toLocaleLowerCase("ru-RU").includes(address.toLocaleLowerCase("ru-RU")));
    return { ...audit, pairs: pairs.slice((page - 1) * 24, page * 24), total: pairs.length, page, pages: Math.max(1, Math.ceil(pairs.length / 24)) };
  });
  app.post("/api/duplicates/scan", async (_request, reply) => {
    await worker.requestDuplicateAudit();
    return reply.code(202).send({ ok: true });
  });
  app.post("/api/duplicates/confirm", async (request, reply) => {
    const { leftId, rightId, snapshot } = selection.parse(request.body);
    const { pairs } = await readDuplicateAudit();
    const pair = pairs.find((p) => p.left.listingId === leftId && p.right.listingId === rightId);
    if (!pair || duplicateSnapshot(pair) !== snapshot || (pair.exactPhotos < 3 && !pair.structured) || !await worker.confirmDuplicate(pair)) {
      return reply.code(409).send({ message: "Совпадение не подтверждено или данные изменились. Обновите проверку." });
    }
    return { ok: true };
  });
};
