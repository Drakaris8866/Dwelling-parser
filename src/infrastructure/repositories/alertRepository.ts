import { AlertStatus, type PrismaClient } from "../../generated/prisma/client.js";

export type AlertRecordInput = {
  readonly listingId: string;
  readonly fairPriceSqm: number;
  readonly actualPriceSqm: number;
  readonly discountPct: number;
  readonly status: AlertStatus;
  readonly errorMessage?: string;
  readonly sentAt?: Date;
};

export class AlertRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async hasRecentAlert(listingId: string, now: Date): Promise<boolean> {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.alert.count({
      where: {
        listingId,
        status: AlertStatus.SENT,
        createdAt: {
          gte: since
        }
      }
    });
    return count > 0;
  }

  async record(input: AlertRecordInput): Promise<void> {
    await this.prisma.alert.create({
      data: {
        listingId: input.listingId,
        fairPriceSqm: input.fairPriceSqm,
        actualPriceSqm: input.actualPriceSqm,
        discountPct: input.discountPct,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
        sentAt: input.sentAt ?? null
      }
    });
  }
}
