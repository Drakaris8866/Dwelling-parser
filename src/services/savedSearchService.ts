import { filtersSchema } from "../contracts/catalog.js";
import type { CatalogRepository } from "../infrastructure/repositories/catalogRepository.js";
import { buildListingWhere } from "../infrastructure/repositories/catalogRepository.js";
import type { CatalogTelegramService } from "./catalogTelegramService.js";
import type { Logger } from "../infrastructure/logger.js";

export class SavedSearchService {
  constructor(private readonly repository: CatalogRepository, private readonly telegram: CatalogTelegramService, private readonly logger: Logger) {}
  async evaluate(): Promise<void> {
    const searches = await this.repository.prisma.savedSearch.findMany({ where: { notifications: true } });
    for (const search of searches) {
      const filters = filtersSchema.parse(search.filters);
      let page = 1;
      while (true) {
        const matches = await this.repository.page({ ...filters, showReview: false, showHidden: false }, page, 200, "newest");
        for (const item of matches.items) {
          await this.repository.prisma.$transaction(async (tx) => {
            const previous = await tx.searchMatch.findUnique({ where: { searchId_propertyId: { searchId: search.id, propertyId: item.id } } });
            if (search.initializedAt && (!previous || item.priceUsd < Number(previous.priceUsd))) {
              const kind = previous ? "PRICE_DROP" : "NEW";
              const eventKey = `${search.id}:${item.id}:${kind}:${item.priceUsd.toFixed(2)}`;
              await tx.notification.upsert({ where: { eventKey }, create: { eventKey, searchId: search.id, propertyId: item.id, kind }, update: {} });
              await tx.notification.updateMany({ where: { searchId: search.id, propertyId: item.id, status: "PENDING", eventKey: { not: eventKey } }, data: { status: "SUPERSEDED" } });
            }
            await tx.searchMatch.upsert({ where: { searchId_propertyId: { searchId: search.id, propertyId: item.id } }, create: { searchId: search.id, propertyId: item.id, priceUsd: item.priceUsd }, update: { priceUsd: item.priceUsd } });
          });
        }
        if (page >= matches.pages) break;
        page++;
      }
      if (!search.initializedAt) await this.repository.prisma.savedSearch.update({ where: { id: search.id }, data: { initializedAt: new Date() } });
    }
  }
  async deliver(): Promise<void> {
    const pending = await this.repository.prisma.notification.findMany({ where: { status: "PENDING", attempts: { lt: 8 } }, include: { search: true }, orderBy: { createdAt: "asc" }, take: 50 });
    for (const event of pending) {
      if (!event.search.notifications) continue;
      try {
        const item = await this.repository.item(event.propertyId);
        const stillMatches = await this.repository.prisma.listing.count({ where: { AND: [buildListingWhere(filtersSchema.parse(event.search.filters), this.repository.prisma.listing.fields), { propertyId: event.propertyId }] } });
        if (!item || item.disposition !== "ACCEPTED" || item.hidden || stillMatches === 0) {
          await this.repository.prisma.notification.update({ where: { id: event.id }, data: { status: "SUPERSEDED" } });
          continue;
        }
        await this.telegram.send(item, event.search.name, event.kind);
        await this.repository.prisma.notification.update({ where: { id: event.id }, data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, error: null } });
      } catch (error: unknown) {
        this.logger.warn({ err: error, notificationId: event.id }, "Saved-search Telegram delivery failed");
        await this.repository.prisma.notification.update({ where: { id: event.id }, data: { attempts: { increment: 1 }, status: event.attempts >= 7 ? "FAILED" : "PENDING", error: error instanceof Error ? error.message : String(error) } });
      }
    }
  }
}
