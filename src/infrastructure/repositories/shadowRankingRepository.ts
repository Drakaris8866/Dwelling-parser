import type { PrismaClient, ShadowRanking } from "../../generated/prisma/client.js";
import type { PersonalRankingResult } from "../../contracts/personalRanking.js";
import { toPrismaJson } from "../../utils/json.js";
import { personalRankingSettingsSchema, personalRankingSnapshotSchema, type PersonalRankingSettings, type PersonalRankingSnapshot } from "../../contracts/personalRanking.js";

export class ShadowRankingRepository {
  constructor(readonly prisma: PrismaClient) {}

  async getSettings(): Promise<PersonalRankingSettings> {
    const row = await this.prisma.personalRankingSettings.findUnique({ where: { id: "personal-ranking" } });
    return personalRankingSettingsSchema.parse(row?.value ?? {});
  }

  async saveSettings(input: unknown): Promise<PersonalRankingSettings> {
    const settings = personalRankingSettingsSchema.parse(input);
    await this.prisma.personalRankingSettings.upsert({ where: { id: "personal-ranking" },
      create: { id: "personal-ranking", value: toPrismaJson(settings) }, update: { value: toPrismaJson(settings) } });
    return settings;
  }

  async saveSnapshot(snapshot: PersonalRankingSnapshot): Promise<PersonalRankingSnapshot> {
    const payload = personalRankingSnapshotSchema.parse(snapshot);
    const row = await this.prisma.personalRankingSnapshot.upsert({
      where: { propertyId_inputHash: { propertyId: snapshot.propertyId, inputHash: snapshot.inputHash } },
      create: { id: snapshot.id, propertyId: snapshot.propertyId, inputHash: snapshot.inputHash, payload: toPrismaJson(payload) },
      update: {}
    });
    return personalRankingSnapshotSchema.parse(row.payload);
  }

  async findSnapshot(propertyId: string, inputHash?: string): Promise<PersonalRankingSnapshot | null> {
    const row = await this.prisma.personalRankingSnapshot.findFirst({
      where: { propertyId, ...(inputHash ? { inputHash } : {}) }, orderBy: [{ calculatedAt: "desc" }, { id: "asc" }]
    });
    return row ? personalRankingSnapshotSchema.parse(row.payload) : null;
  }

  async saveShadowRanking(propertyId: string, result: PersonalRankingResult, settingsKey: string): Promise<void> {
    const data = {
      rankingVersion: result.version,
      score: result.score,
      asIsScore: result.asIsScore,
      asIsDiscountPct: result.asIsDiscountPct,
      totalUsdLow: result.totalUsd?.low ?? null,
      totalUsdBase: result.totalUsd?.base ?? null,
      totalUsdHigh: result.totalUsd?.high ?? null,
      coverage: result.coverage,
      provisional: result.provisional,
      reason: result.reason,
      breakdown: toPrismaJson(result.breakdown),
      settingsKey
    };
    await this.prisma.shadowRanking.upsert({
      where: { propertyId },
      create: { propertyId, ...data },
      update: data
    });
  }

  async getShadowRanking(propertyId: string): Promise<ShadowRanking | null> {
    return this.prisma.shadowRanking.findUnique({
      where: { propertyId }
    });
  }

  async clearShadowRanking(propertyId: string): Promise<void> {
    await this.prisma.shadowRanking.deleteMany({
      where: { propertyId }
    });
  }
}
