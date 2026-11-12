import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Logger } from "../logger.js";
import {
  DEFAULT_PREFERENCE_WEIGHTS,
  type CreateFeedbackInput,
  type ParsedSignals,
  type PreferenceWeights,
  type UpdateFeedbackInput,
  type UserPreferences
} from "../../contracts/userFeedback.js";

export type StoredFeedback = {
  readonly id: string;
  readonly propertyId: string;
  readonly rating: number | null;
  readonly commentRaw: string | null;
  readonly parsedSignals: ParsedSignals | null;
  readonly confirmed: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export class UserFeedbackRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger?: Logger
  ) {}

  async createFeedback(
    input: CreateFeedbackInput & { readonly parsedSignals?: ParsedSignals | null }
  ): Promise<StoredFeedback> {
    const created = await this.prisma.userFeedback.create({
      data: {
        propertyId: input.propertyId,
        rating: input.rating ?? null,
        commentRaw: input.commentRaw ?? null,
        parsedSignals: input.parsedSignals ? JSON.parse(JSON.stringify(input.parsedSignals)) : undefined,
        confirmed: false
      }
    });

    // PRIVACY INVARIANT: Never log commentRaw
    this.logger?.info({ propertyId: input.propertyId, feedbackId: created.id }, "feedback created");

    return {
      id: created.id,
      propertyId: created.propertyId,
      rating: created.rating,
      commentRaw: created.commentRaw,
      parsedSignals: created.parsedSignals as ParsedSignals | null,
      confirmed: created.confirmed,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt
    };
  }

  async updateFeedback(
    id: string,
    patch: UpdateFeedbackInput & { readonly parsedSignals?: ParsedSignals | null }
  ): Promise<StoredFeedback> {
    const updated = await this.prisma.userFeedback.update({
      where: { id },
      data: {
        ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
        ...(patch.commentRaw !== undefined ? { commentRaw: patch.commentRaw } : {}),
        ...(patch.parsedSignals !== undefined
          ? { parsedSignals: patch.parsedSignals ? JSON.parse(JSON.stringify(patch.parsedSignals)) : null }
          : {}),
        ...(patch.confirmed !== undefined ? { confirmed: patch.confirmed } : {})
      }
    });

    // PRIVACY INVARIANT: Never log commentRaw
    this.logger?.info({ id: updated.id, propertyId: updated.propertyId, confirmed: updated.confirmed }, "feedback updated");

    return {
      id: updated.id,
      propertyId: updated.propertyId,
      rating: updated.rating,
      commentRaw: updated.commentRaw,
      parsedSignals: updated.parsedSignals as ParsedSignals | null,
      confirmed: updated.confirmed,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  }

  async deleteFeedback(id: string): Promise<void> {
    await this.prisma.userFeedback.delete({ where: { id } });
    this.logger?.info({ id }, "feedback deleted");
  }

  async getFeedback(propertyId: string): Promise<StoredFeedback | null> {
    const found = await this.prisma.userFeedback.findFirst({
      where: { propertyId },
      orderBy: { createdAt: "desc" }
    });
    if (!found) return null;

    return {
      id: found.id,
      propertyId: found.propertyId,
      rating: found.rating,
      commentRaw: found.commentRaw,
      parsedSignals: found.parsedSignals as ParsedSignals | null,
      confirmed: found.confirmed,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt
    };
  }

  async getFeedbackById(id: string): Promise<StoredFeedback | null> {
    const found = await this.prisma.userFeedback.findUnique({
      where: { id }
    });
    if (!found) return null;

    return {
      id: found.id,
      propertyId: found.propertyId,
      rating: found.rating,
      commentRaw: found.commentRaw,
      parsedSignals: found.parsedSignals as ParsedSignals | null,
      confirmed: found.confirmed,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt
    };
  }

  async listConfirmedFeedbacks(): Promise<readonly StoredFeedback[]> {
    const list = await this.prisma.userFeedback.findMany({
      where: { confirmed: true },
      orderBy: { createdAt: "asc" }
    });

    return list.map((item) => ({
      id: item.id,
      propertyId: item.propertyId,
      rating: item.rating,
      commentRaw: item.commentRaw,
      parsedSignals: item.parsedSignals as ParsedSignals | null,
      confirmed: item.confirmed,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
  }

  async resetAllFeedback(): Promise<void> {
    await this.prisma.userFeedback.deleteMany();
    this.logger?.info("all feedback reset");
  }

  async getPreferences(): Promise<UserPreferences> {
    const found = await this.prisma.userPreferences.findUnique({
      where: { id: 1 }
    });
    if (!found) {
      return {
        weightVersion: 0,
        weights: DEFAULT_PREFERENCE_WEIGHTS,
        updatedAt: new Date()
      };
    }

    return {
      weightVersion: found.weightVersion,
      weights: found.weights as PreferenceWeights,
      updatedAt: found.updatedAt
    };
  }

  async updatePreferences(weights: PreferenceWeights): Promise<UserPreferences> {
    const existing = await this.prisma.userPreferences.findUnique({ where: { id: 1 } });
    const nextVersion = (existing?.weightVersion ?? 0) + 1;

    const upserted = await this.prisma.userPreferences.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        weightVersion: nextVersion,
        weights: JSON.parse(JSON.stringify(weights))
      },
      update: {
        weightVersion: nextVersion,
        weights: JSON.parse(JSON.stringify(weights))
      }
    });

    this.logger?.info({ weightVersion: upserted.weightVersion }, "preferences updated");

    return {
      weightVersion: upserted.weightVersion,
      weights: upserted.weights as PreferenceWeights,
      updatedAt: upserted.updatedAt
    };
  }
}
