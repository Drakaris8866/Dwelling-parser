import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import type { CatalogItem } from "../contracts/catalog.js";
import { formatDisplayAddress } from "../utils/addressFormatter.js";
import type { RetryHttpClient } from "../infrastructure/http/retryHttpClient.js";
import type { Logger } from "../infrastructure/logger.js";

const telegramSchema = z.object({ ok: z.boolean(), description: z.string().optional() });
const money = (value: number): string => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
const modeNames: Readonly<Record<string, string>> = { WALK: "Пешком", BUS: "Автобус", SUBWAY: "Метро", TRAM: "Трамвай", TROLLEYBUS: "Троллейбус", RAIL: "Поезд" };
export const formatCatalogAlert = (item: CatalogItem, search: string, kind: string): string => {
  const a = item.assessment;
  return [
    `${kind === "PRICE_DROP" ? "Снижение цены" : "Новое предложение"} · ${search}`,
    formatDisplayAddress(item.features.address, item.features.locality, item.title),
    `${item.features.isStudio ? "Студия" : `${item.rooms} комн.`} · ${item.areaSqm} м²`,
    `Цена: $${money(item.priceUsd)} ($${money(item.priceSqm)}/м²)${item.priceByn === null ? "" : ` ≈ ${money(item.priceByn)} BYN`}`,
    `Выгодность: ${a?.valueScore === null || !a ? "недостаточно данных" : `${a.valueScore}/100`}`,
    `Удобство: ${a?.comfortScore === null || !a ? "недостаточно данных" : `${a.comfortScore}/100 · заполненность ${a.coverage}%`}`,
    ...(a?.medianPriceSqm ? [`Ориентир предложений: $${money(a.medianPriceSqm)}/м² · ${a.comparableCount} аналогов`, `Отклонение от ориентира: ${a.discountPct}%`] : []),
    ...(item.routes?.target ? [`До текущей точки: ${item.routes.target.durationMinutes} мин`, item.routes.target.legs.map((l) => `${modeNames[l.mode] ?? l.mode}${l.route ? ` ${l.route}` : ""} ${Math.round(l.durationMinutes)} мин`).join(" → ")] : []),
    ...(a?.reasons ?? []),
    ...item.sources.map((source) => `${source.platform} #${source.externalId}: ${source.url}`)
  ].join("\n");
};
export class CatalogTelegramService {
  constructor(private readonly config: Pick<AppConfig, "telegramBotToken" | "telegramChatId">, private readonly http: RetryHttpClient, private readonly logger: Logger) {}
  async send(item: CatalogItem, search: string, kind: string): Promise<void> {
    const text = formatCatalogAlert(item, search, kind);
    const photo = item.photos[0];
    if (photo && text.length <= 1024) {
      try { await this.call("sendPhoto", { chat_id: this.config.telegramChatId, photo, caption: text }); return; }
      catch (error: unknown) { this.logger.warn({ err: error, propertyId: item.id }, "Telegram photo failed, using text fallback"); }
    }
    await this.call("sendMessage", { chat_id: this.config.telegramChatId, text: `${text}${photo ? `\nФото: ${photo}` : ""}`.slice(0, 4096), disable_web_page_preview: true });
  }
  private async call(method: "sendPhoto" | "sendMessage", body: { chat_id: string; text?: string; photo?: string; caption?: string; disable_web_page_preview?: boolean }): Promise<void> {
    const result = await this.http.json({ method: "POST", url: `https://api.telegram.org/bot${this.config.telegramBotToken}/${method}`, body, timeoutMs: 15_000 }, telegramSchema);
    if (!result.ok) throw new Error(result.description ?? "Telegram API rejected message");
  }
}
