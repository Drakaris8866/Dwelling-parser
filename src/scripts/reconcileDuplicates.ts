import "dotenv/config";
import { z } from "zod";
import { loadConfig } from "../config/env.js";
import { descriptionDuplicate, structuredDuplicate } from "../domain/duplicateIdentity.js";
import { createPrismaConnection } from "../infrastructure/db/prisma.js";
import { RetryHttpClient } from "../infrastructure/http/retryHttpClient.js";
import { createLogger } from "../infrastructure/logger.js";
import { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import { DuplicateService } from "../services/duplicateService.js";

const config = loadConfig(), logger = createLogger(config);
const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply");
  const rawIds = process.argv.find((arg) => arg.startsWith("--ids="))?.slice(6);
  const ids = rawIds ? z.array(z.string().uuid()).min(2).max(20).parse(rawIds.split(",")) : undefined;
  const db = createPrismaConnection(config), http = new RetryHttpClient(logger);
  const service = new DuplicateService(new CatalogRepository(db.prisma), http, logger);
  try {
    const inventory = await db.prisma.listing.findMany({ where: { isActive: true, disposition: "ACCEPTED", locality: { not: null }, propertyId: { not: null },
      ...(ids ? { id: { in: ids } } : {}),
      floor: { not: null } }, orderBy: [{ areaSqm: "asc" }, { id: "asc" }],
      select: { id: true, propertyId: true, platform: true, address: true, locality: true, latitude: true, longitude: true, floor: true,
        totalFloors: true, rooms: true, areaSqm: true, priceUsd: true, priceByn: true, livingSqm: true, kitchenSqm: true, buildingYear: true, readiness: true, description: true } });
    const buckets = new Map<string, typeof inventory>();
    for (const row of inventory) {
      const key = JSON.stringify([row.locality, row.floor, row.rooms]);
      const group = buckets.get(key);
      if (group) group.push(row); else buckets.set(key, [row]);
    }
    const describedMatches = new Set<string>(), structuredMatches = new Set<string>();
    for (const group of buckets.values()) for (const [index, row] of group.entries()) {
      for (let next = index + 1; next < group.length; next++) {
        const other = group[next]!;
        if (Number(other.areaSqm) - Number(row.areaSqm) > 1) break;
        if (row.propertyId === other.propertyId) continue;
        const evidence = descriptionDuplicate(row, other) ? describedMatches
          : row.platform !== other.platform && structuredDuplicate(row, other) ? structuredMatches : null;
        if (evidence) { evidence.add(row.id); evidence.add(other.id); }
      }
    }
    const matches = new Set([...describedMatches, ...structuredMatches]);
    let merged = 0;
    if (apply) for (const id of matches) {
      const row = await db.prisma.listing.findUnique({ where: { id } });
      if (row && await service.reconcile(row, undefined, { metadataOnly: true, ...(ids ? { candidateIds: ids } : {}) })) merged++;
    }
    logger.info({ apply, scanned: inventory.length, matchedPublications: matches.size, descriptionMatches: describedMatches.size, merges: merged }, "Duplicate reconciliation scan completed");
  } finally { http.close(); await db.close(); }
};
void main().catch((err: unknown) => { logger.error({ err }, "Duplicate reconciliation scan failed"); process.exitCode = 1; });
