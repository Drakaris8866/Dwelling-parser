import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { createPrismaConnection } from "../infrastructure/db/prisma.js";
import { createLogger } from "../infrastructure/logger.js";
import { scanDuplicateAudit } from "../services/duplicateAuditService.js";

const config = loadConfig(), logger = createLogger(config);
const main = async (): Promise<void> => {
  const db = createPrismaConnection(config);
  try { logger.info(await scanDuplicateAudit(db.prisma), "Catalog duplicate audit completed without changing listings"); }
  finally { await db.close(); }
};
void main().catch((err: unknown) => { logger.error({ err }, "Duplicate audit failed"); process.exitCode = 1; });
