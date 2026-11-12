import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import type { AppConfig } from "../../config/env.js";

export type PrismaConnection = {
  readonly prisma: PrismaClient;
  readonly close: () => Promise<void>;
};

export const createPrismaConnection = (config: Pick<AppConfig, "databaseUrl">): PrismaConnection => {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  return {
    prisma,
    close: async (): Promise<void> => {
      await prisma.$disconnect();
      await pool.end();
    }
  };
};
