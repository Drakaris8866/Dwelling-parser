import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { personalRankingSettingsSchema, personalRankingSnapshotResponseSchema } from "../contracts/personalRanking.js";
import type { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import { ShadowRankingRepository } from "../infrastructure/repositories/shadowRankingRepository.js";
import { ShadowRankingService } from "../services/shadowRankingService.js";

const paramsSchema = z.object({ id: z.string().uuid() });

export const registerPersonalRankingRoutes = (app: FastifyInstance, repository: CatalogRepository): void => {
  const rankings = new ShadowRankingRepository(repository.prisma);
  const service = new ShadowRankingService(repository, rankings, app.log);
  app.get("/api/personal-ranking/settings", async () => personalRankingSettingsSchema.parse(await rankings.getSettings()));
  app.put("/api/personal-ranking/settings", async (request) => {
    const input = personalRankingSettingsSchema.parse(request.body);
    return personalRankingSettingsSchema.parse(await rankings.saveSettings(input));
  });
  app.get("/api/listings/:id/personal-ranking", async (request, reply) => {
    const item = await repository.item(paramsSchema.parse(request.params).id);
    if (!item) return reply.code(404).send({ message: "Квартира не найдена" });
    return personalRankingSnapshotResponseSchema.parse(await service.getCurrentSnapshot(item));
  });
};
