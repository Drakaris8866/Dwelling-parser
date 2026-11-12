import "dotenv/config";
import { createPrismaConnection } from "../infrastructure/db/prisma.js";
import { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import { ShadowRankingRepository } from "../infrastructure/repositories/shadowRankingRepository.js";
import { ShadowRankingService, personalRankingPilotIdsSchema } from "../services/shadowRankingService.js";
import pino from "pino";

// Explicit IDs are required. This command never walks the catalog or starts workers.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--ids") throw new Error("Usage: pnpm ranking:pilot --ids <property-uuid,...> (1–100 IDs)");
const ids = personalRankingPilotIdsSchema.parse(args[1]!.split(","));
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const connection = createPrismaConnection({ databaseUrl });
try {
  const service = new ShadowRankingService(new CatalogRepository(connection.prisma), new ShadowRankingRepository(connection.prisma), pino());
  const processed = await service.runForIds(ids);
  process.stdout.write(`${JSON.stringify({ requested: ids.length, processed })}\n`);
} finally {
  await connection.close();
}
