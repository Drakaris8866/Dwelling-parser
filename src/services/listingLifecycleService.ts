import type { PrismaClient, Platform } from "../generated/prisma/client.js";
import { refreshRepresentative } from "../infrastructure/repositories/catalogRepository.js";
export class ListingLifecycleService {
  constructor(private readonly prisma: PrismaClient) {}
  async completeFullRun(platform: Platform, runId: string, now = new Date()): Promise<void> {
    const run = await this.prisma.sourceSyncRun.findUnique({ where: { id: runId } });
    if (!run || run.platform !== platform || run.kind !== "FULL" || run.status !== "COMPLETE" || run.invalid > 0 || run.scopeVersion !== "minsk-district-v1") return;
    const missing = await this.prisma.listing.findMany({ where: { platform, isActive: true, AND: [
      { OR: [{ observedRunId: null }, { observedRunId: { not: runId } }] },
      { OR: [{ lastCompleteMissRunId: null }, { lastCompleteMissRunId: { not: runId } }] },
      { OR: [{ lastCompleteMissAt: null }, { lastCompleteMissAt: { lte: new Date(now.getTime() - 86400_000) } }] }
    ] }, select: { id: true, propertyId: true, missedCompleteRuns: true } });
    for (const row of missing) {
      await this.prisma.listing.update({ where: { id: row.id }, data: { missedCompleteRuns: { increment: 1 }, lastCompleteMissAt: now, lastCompleteMissRunId: runId, ...(row.missedCompleteRuns >= 1 ? { isActive: false } : {}) } });
      if (row.missedCompleteRuns >= 1 && row.propertyId) await refreshRepresentative(this.prisma, row.propertyId);
    }
  }
}
