import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { classifyListing, PARTIAL_SALE_REASON } from "../domain/exclusions.js";
import { featuresSchema } from "../contracts/catalog.js";
import { createPrismaConnection } from "../infrastructure/db/prisma.js";
import { createLogger } from "../infrastructure/logger.js";
import { refreshRepresentative } from "../infrastructure/repositories/catalogRepository.js";
import type { Platform } from "../generated/prisma/client.js";

type AuditSample = { externalId: string; from: string; to: string; reasons: readonly string[] };

const config = loadConfig(), logger = createLogger(config);
const main = async (): Promise<void> => {
  const { prisma, close } = createPrismaConnection(config);
  const apply = process.argv.includes("--apply");
  const partialOnly = process.argv.includes("--partial-only");
  let after: string | undefined, scanned = 0, matched = 0, changed = 0, excluded = 0, review = 0;
  const reasons = new Map<string, number>();
  const transitions = new Map<string, number>();
  const samples = new Map<Platform, AuditSample[]>();
  try {
    for (;;) {
      const rows = await prisma.listing.findMany({ where: { ...(after ? { id: { gt: after } } : {}), isActive: true, disposition: { not: "EXCLUDED" } },
        select: { id: true, platform: true, externalId: true, propertyId: true, totalFloors: true, title: true, description: true, contentHash: true, isRepresentative: true, features: true, disposition: true, exclusionReasons: true }, orderBy: { id: "asc" }, take: 200 });
      if (!rows.length) break;
      after = rows.at(-1)!.id;
      scanned += rows.length;
      for (const row of rows) {
        const features = featuresSchema.safeParse(row.features);
        if (!features.success) { logger.warn({ listingId: row.id }, "Stored listing features cannot be audited"); continue; }
        const decision = classifyListing(row, { ...features.data, totalFloors: row.totalFloors ?? features.data.totalFloors });
        const { disposition } = decision;
        if (disposition === "ACCEPTED") continue;
        if (partialOnly && !decision.reasons.includes(PARTIAL_SALE_REASON)) continue;
        const exclusionReasons = [...new Set(disposition === "REVIEW" ? [...row.exclusionReasons, ...decision.reasons] : decision.reasons)];
        if (row.disposition === disposition && exclusionReasons.length === row.exclusionReasons.length && exclusionReasons.every((reason) => row.exclusionReasons.includes(reason))) continue;
        matched++;
        const transition = `${row.platform}:${row.disposition}->${disposition}`;
        transitions.set(transition, (transitions.get(transition) ?? 0) + 1);
        const examples = samples.get(row.platform) ?? [];
        if (examples.length < 5) {
          examples.push({ externalId: row.externalId, from: row.disposition, to: disposition, reasons: exclusionReasons });
          samples.set(row.platform, examples);
        }
        if (disposition === "EXCLUDED") excluded++; else review++;
        for (const reason of exclusionReasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        if (!apply) continue;
        changed += await prisma.$transaction(async (tx): Promise<number> => {
          const result = await tx.listing.updateMany({ where: { id: row.id, contentHash: row.contentHash, disposition: row.disposition }, data: { disposition, exclusionReasons } });
          if (result.count && row.propertyId) {
            await refreshRepresentative(tx, row.propertyId);
            if (row.isRepresentative) {
              await tx.property.update({ where: { id: row.propertyId }, data: { assessmentRevision: { increment: 1 } } });
              await tx.assessment.updateMany({ where: { propertyId: row.propertyId }, data: { valueScore: null, comfortScore: null, coverage: 0, data: {} } });
            }
          }
          return result.count;
        });
      }
    }
    logger.info({ apply, partialOnly, scanned, matched, changed, excluded, review, reasons: Object.fromEntries(reasons),
      transitions: Object.fromEntries(transitions), samples: Object.fromEntries(samples) }, "Listing eligibility audit completed");
  } finally { await close(); }
};
void main().catch((err: unknown) => { logger.error({ err }, "Listing audit failed"); process.exitCode = 1; });
