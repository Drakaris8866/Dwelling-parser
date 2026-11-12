import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { loadConfig } from "../config/env.js";
import { createLogger } from "../infrastructure/logger.js";
import { createPrismaConnection } from "../infrastructure/db/prisma.js";
import { platformSchema } from "../contracts/catalog.js";

const keys = {
  KUFAR: ["ad_id", "ad_link", "type", "price_usd", "price_byn", "size", "rooms", "coordinates", "images", "ad_parameters"],
  ONLINER: ["id", "url", "price", "area", "number_of_rooms", "location", "floor", "number_of_floors", "photo", "photos", "resale", "house_type", "repair"],
  REALT: ["code", "rooms", "areaTotal", "areaLiving", "areaKitchen", "price", "priceCurrency", "priceRates", "storey", "storeys", "buildingYear", "houseType", "repairState", "images", "location", "townName", "stateDistrictName", "address"]
} as const;
const config = loadConfig(), logger = createLogger(config);
const main = async (): Promise<void> => {
  const connection = createPrismaConnection(config);
  try {
    await mkdir("tests/fixtures", { recursive: true });
    for (const platform of platformSchema.options) {
      const rows = await connection.prisma.listing.findMany({ where: { platform }, take: 2, orderBy: { firstSeenAt: "asc" }, select: { sourcePayload: true } });
      if (!rows.length) throw new Error(`No captured ${platform} responses in the database`);
      const items = rows.map((row) => {
        const raw = z.record(z.string(), z.unknown()).parse(row.sourcePayload);
        return Object.fromEntries(keys[platform].filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));
      });
      await writeFile(`tests/fixtures/${platform.toLowerCase()}.json`, `${JSON.stringify({ platform, capturedAt: new Date().toISOString(), items }, null, 2)}\n`, "utf8");
      logger.info({ platform, count: items.length }, "Captured source schema fixtures without account data or descriptions");
    }
  } finally { await connection.close(); }
};
void main().catch((error: unknown) => { logger.error({ err: error }, "Fixture capture failed"); process.exitCode = 1; });
