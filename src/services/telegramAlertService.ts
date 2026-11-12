import { z } from "zod";
import type { PersistedListing } from "../domain/listing.js";
import type { ScoreResult } from "../domain/scoring.js";
import type { WalkingRoute } from "../domain/geo.js";
import type { AppConfig } from "../config/env.js";
import { HttpRequestError, type RetryHttpClient } from "../infrastructure/http/retryHttpClient.js";
import type { Logger } from "../infrastructure/logger.js";

const telegramResponseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional()
});

const AUTH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const TELEGRAM_SEND_INTERVAL_MS = 1_500;
const TELEGRAM_MAX_RATE_LIMIT_RETRIES = 3;
const TELEGRAM_DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;

const DETAIL_LABEL_TRANSLATIONS: Readonly<Record<string, string>> = {
  Address: "Адрес",
  "User address": "Адрес пользователя",
  "Seller address": "Адрес продавца",
  Locality: "Локация",
  District: "Район",
  Region: "Область",
  Town: "Населенный пункт",
  Street: "Улица",
  Area: "Местность",
  Complex: "ЖК",
  Repair: "Ремонт",
  Condition: "Состояние",
  Bathroom: "Санузел",
  Balcony: "Балкон",
  Ceiling: "Потолки",
  Floor: "Этаж",
  Floors: "Этажей",
  Kitchen: "Кухня",
  "Kitchen area": "Кухня",
  Living: "Жилая площадь",
  "Living area": "Жилая площадь",
  "House type": "Тип дома",
  Built: "Год постройки",
  Layout: "Планировка",
  "Rooms type": "Тип комнат",
  "Walk-through rooms": "Проходные комнаты",
  Metro: "Метро",
  "Source metro": "Метро из источника",
  Seller: "Продавец",
  Resale: "Вторичка"
};

const SCORE_COMPONENT_LABEL_TRANSLATIONS: Readonly<Record<string, string>> = {
  Market: "Рынок",
  Transport: "Транспорт",
  Object: "Квартира",
  Confidence: "Уверенность"
};

export type AlertPayload = {
  readonly listing: PersistedListing;
  readonly score: ScoreResult;
  readonly route?: WalkingRoute | undefined;
};

export class TelegramAlertService {
  private disabledUntilMs = 0;
  private nextSendAtMs = 0;

  constructor(
    private readonly config: Pick<AppConfig, "telegramBotToken" | "telegramChatId">,
    private readonly httpClient: RetryHttpClient,
    private readonly logger: Logger
  ) {}

  async send(payload: AlertPayload): Promise<void> {
    if (Date.now() < this.disabledUntilMs) {
      throw new Error("Telegram delivery is temporarily disabled after an authorization failure");
    }

    const firstPhoto = payload.listing.photos[0];
    if (firstPhoto === undefined) {
      await this.sendMessage(payload);
      return;
    }

    try {
      await this.sendPhoto(payload, firstPhoto);
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error,
          listingId: payload.listing.id,
          photoUrl: firstPhoto
        },
        "Telegram sendPhoto failed, falling back to sendMessage"
      );
      await this.sendMessage(payload, firstPhoto);
    }
  }

  async sendText(text: string): Promise<void> {
    if (Date.now() < this.disabledUntilMs) {
      throw new Error("Telegram delivery is temporarily disabled after an authorization failure");
    }

    const response = await this.sendTelegramRequest(
      this.telegramUrl("sendMessage"),
      {
        chat_id: this.config.telegramChatId,
        text,
        disable_web_page_preview: "true"
      },
      "startup-ping"
    );

    this.assertTelegramOk(response, "startup-ping");
  }

  private async sendMessage(payload: AlertPayload, failedPhotoUrl?: string | undefined): Promise<void> {
    const response = await this.sendTelegramRequest(
      this.telegramUrl("sendMessage"),
      this.messageBody(payload, failedPhotoUrl),
      payload.listing.id
    );

    this.assertTelegramOk(response, payload.listing.id);
  }

  private async sendPhoto(payload: AlertPayload, photo: string): Promise<void> {
    const response = await this.sendTelegramRequest(this.telegramUrl("sendPhoto"), this.photoBody(payload, photo), payload.listing.id);
    this.assertTelegramOk(response, payload.listing.id);
  }

  private assertTelegramOk(response: z.infer<typeof telegramResponseSchema>, listingId: string): void {
    if (!response.ok) {
      this.logger.error({ response, listingId }, "Telegram API returned not ok");
      throw new Error(response.description ?? "Telegram API returned not ok");
    }
  }

  private telegramUrl(endpoint: "sendMessage" | "sendPhoto"): string {
    return `https://api.telegram.org/bot${this.config.telegramBotToken}/${endpoint}`;
  }

  private async sendTelegramRequest(
    url: string,
    body: Readonly<Record<string, string>>,
    listingId: string
  ): Promise<z.infer<typeof telegramResponseSchema>> {
    for (let attempt = 0; attempt <= TELEGRAM_MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      try {
        await this.waitForTelegramSlot();
        return await this.httpClient.json({ method: "POST", url, body, timeoutMs: 15_000, retries: 0 }, telegramResponseSchema);
      } catch (error: unknown) {
        if (error instanceof HttpRequestError && (error.statusCode === 401 || error.statusCode === 403)) {
          this.disabledUntilMs = Date.now() + AUTH_FAILURE_COOLDOWN_MS;
          this.logger.error(
            {
              listingId,
              statusCode: error.statusCode,
              telegramDescription: this.telegramDescription(error.responseBody),
              disabledUntil: new Date(this.disabledUntilMs).toISOString()
            },
            "Telegram delivery disabled after authorization failure"
          );
        }

        if (error instanceof HttpRequestError && error.statusCode === 429 && attempt < TELEGRAM_MAX_RATE_LIMIT_RETRIES) {
          const waitMs = this.telegramRetryAfterMs(error.responseBody) ?? TELEGRAM_DEFAULT_RATE_LIMIT_WAIT_MS;
          this.logger.warn({ listingId, waitMs, attempt }, "Telegram rate limit hit, retrying after delay");
          await this.sleep(waitMs);
          continue;
        }

        throw error;
      }
    }

    throw new Error("Telegram request failed after rate limit retries");
  }

  private async waitForTelegramSlot(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextSendAtMs - now);
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }

    this.nextSendAtMs = Date.now() + TELEGRAM_SEND_INTERVAL_MS;
  }

  private telegramRetryAfterMs(responseBody: unknown): number | undefined {
    if (typeof responseBody !== "object" || responseBody === null || Array.isArray(responseBody)) {
      return undefined;
    }

    const parameters = (responseBody as Readonly<Record<string, unknown>>)["parameters"];
    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
      return undefined;
    }

    const retryAfter = (parameters as Readonly<Record<string, unknown>>)["retry_after"];
    return typeof retryAfter === "number" && Number.isFinite(retryAfter) ? (retryAfter + 1) * 1_000 : undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private messageBody(payload: AlertPayload, failedPhotoUrl?: string | undefined): Readonly<Record<string, string>> {
    return {
      chat_id: this.config.telegramChatId,
      text: this.renderMessage(payload, failedPhotoUrl),
      parse_mode: "HTML",
      disable_web_page_preview: "false"
    };
  }

  private photoBody(payload: AlertPayload, photo: string): Readonly<Record<string, string>> {
    return {
      chat_id: this.config.telegramChatId,
      photo,
      caption: this.renderMessage(payload),
      parse_mode: "HTML"
    };
  }

  private renderMessage(payload: AlertPayload, failedPhotoUrl?: string | undefined): string {
    const listing = payload.listing;
    const lines = [
      `<b>[${this.escape(listing.platform)}]</b>`,
      `Объявление: ${this.escape(listing.platform)} #${this.escape(listing.externalId)}`,
      `<b>${this.escape(listing.title)}</b>`,
      `${listing.rooms} комн., ${listing.areaSqm} м²`,
      this.scoreLine(payload.score),
      this.priceLine(listing),
      this.fairPriceLine(payload.score),
      this.discountLine(payload.score),
      ...this.componentLines(payload.score),
      this.metroLine(payload),
      ...this.targetTransitLines(listing),
      ...this.detailLines(listing),
      `<a href="${this.escape(listing.url)}">Открыть объявление</a>`
    ];

    if (failedPhotoUrl !== undefined) {
      lines.push(`Photo: ${this.escape(failedPhotoUrl)}`);
    }

    return lines.join("\n");
  }

  private scoreLine(score: ScoreResult): string {
    return `⭐ Рейтинг: ${score.ratingScore}/100 (${this.ratingLabel(score)})`;
  }

  private priceLine(listing: PersistedListing): string {
    const price = Math.round(listing.priceUsd).toLocaleString("en-US");
    const pricePerMeter = Math.round(listing.pricePerSqm).toLocaleString("en-US");
    const bynPrice = listing.priceByn === undefined ? "" : ` (~${Math.round(listing.priceByn).toLocaleString("ru-RU")} BYN)`;
    return `💰 Цена: $${price}${bynPrice} ($${pricePerMeter}/м²)`;
  }

  private fairPriceLine(score: ScoreResult): string {
    const fair = Math.round(score.fairPricePerSqm).toLocaleString("en-US");
    return `⚖️ Рыночная опора: $${fair}/м² (${this.medianSourceLabel(score)})`;
  }

  private discountLine(score: ScoreResult): string {
    return `🔥 Дисконт: ${score.discountPct}% (${this.ratingLabel(score)})`;
  }

  private componentLines(score: ScoreResult): readonly string[] {
    const lines = score.components.map((component) => {
      const notes =
        component.notes.length === 0
          ? ""
          : `: ${this.escape(component.notes.slice(0, 2).map((note) => this.translateScoreNote(note)).join(", "))}`;
      return `- ${this.escape(SCORE_COMPONENT_LABEL_TRANSLATIONS[component.label] ?? component.label)}: ${component.points}/${component.maxPoints}${notes}`;
    });

    return ["Оценка:", ...lines];
  }

  private translateScoreNote(note: string): string {
    const discountMatch = /^(-?\d+(?:\.\d+)?)% vs median$/.exec(note);
    if (discountMatch !== null) {
      return `${discountMatch[1]}% к медиане`;
    }

    const belowMedianMatch = /^\$(\d+)\/m2 below median$/.exec(note);
    if (belowMedianMatch !== null) {
      return `$${belowMedianMatch[1]}/м² ниже медианы`;
    }

    const aboveMedianMatch = /^\$(\d+)\/m2 above median$/.exec(note);
    if (aboveMedianMatch !== null) {
      return `$${aboveMedianMatch[1]}/м² выше медианы`;
    }

    const targetMinutesMatch = /^(\d+) min to target$/.exec(note);
    if (targetMinutesMatch !== null) {
      return `${targetMinutesMatch[1]} мин до текущей точки`;
    }

    const transferMatch = /^(\d+) transfers?$/.exec(note);
    if (transferMatch !== null) {
      return `${transferMatch[1]} пересадк.`;
    }

    const walkingRouteMatch = /^(\d+) min walking in route$/.exec(note);
    if (walkingRouteMatch !== null) {
      return `${walkingRouteMatch[1]} мин пешком в маршруте`;
    }

    const metroWalkMatch = /^(\d+) min walk to metro$/.exec(note);
    if (metroWalkMatch !== null) {
      return `${metroWalkMatch[1]} мин пешком до метро`;
    }

    const lowComparableMatch = /^low comparable count: (\d+)$/.exec(note);
    if (lowComparableMatch !== null) {
      return `мало аналогов: ${lowComparableMatch[1]}`;
    }

    const ceilingMatch = /^(\d+(?:\.\d+)?)m ceiling$/.exec(note);
    if (ceilingMatch !== null) {
      return `потолки ${ceilingMatch[1]} м`;
    }

    const dictionary: Readonly<Record<string, string>> = {
      "target route unknown": "маршрут до точки неизвестен",
      "subway leg": "есть метро в маршруте",
      "surface-only route": "маршрут только наземным транспортом",
      "metro access unknown": "доступ к метро неизвестен",
      brick: "кирпичный дом",
      "old panel": "старая панель",
      "fresh repair": "свежий ремонт",
      "repair risk": "риск ремонта",
      "severe renovation risk": "высокий риск ремонта",
      "walk-through rooms": "проходные комнаты",
      "first floor": "первый этаж",
      "last floor": "последний этаж",
      "no balcony": "нет балкона",
      "separate bathroom": "раздельный санузел",
      "small kitchen": "маленькая кухня",
      "tiny kitchen": "очень маленькая кухня",
      "spacious kitchen": "просторная кухня",
      "local median": "локальная медиана",
      "global median fallback": "fallback на глобальную медиану",
      "coordinates missing": "нет координат",
      "OTP missing": "нет маршрута OTP",
      "hard-filter risk signal": "риск мусорного объявления"
    };

    return dictionary[note] ?? this.translateDetailValue(note);
  }

  private medianSourceLabel(score: ScoreResult): string {
    const count = score.medianComparableCount === undefined ? "" : `, ${score.medianComparableCount} объявл.`;
    if (score.medianSource === "local-2km") {
      return `локальная медиана 2 км${count}`;
    }

    if (score.medianSource === "local-4km") {
      return `локальная медиана 4 км${count}`;
    }

    if (score.medianSource === "local-6km") {
      return `локальная медиана 6 км${count}`;
    }

    return `глобальная медиана${count}`;
  }

  private metroLine(payload: AlertPayload): string {
    if (payload.route !== undefined) {
      return `Метро: ${this.escape(payload.route.nearestMetro)}, ${payload.route.walkingMinutes} мин (пешком)`;
    }

    if (
      payload.listing.metroName !== undefined &&
      payload.listing.metroDistanceText !== undefined &&
      payload.listing.metroDistanceType !== undefined
    ) {
      return `Метро: ${this.escape(payload.listing.metroName)}, ${this.escape(payload.listing.metroDistanceText)} (${this.metroDistanceTypeLabel(payload.listing.metroDistanceType)})`;
    }

    return "Метро: неизвестно";
  }

  private metroDistanceTypeLabel(type: "walking" | "transport"): string {
    return type === "walking" ? "пешком" : "на транспорте";
  }

  private targetTransitLines(listing: PersistedListing): readonly string[] {
    if (listing.timeToTargetTransit === undefined) {
      return [];
    }

    return [
      `🚌 До Текущей точки: ${listing.timeToTargetTransit} мин`,
      ...(listing.targetTransitSummary === undefined ? [] : [this.escape(listing.targetTransitSummary)])
    ];
  }

  private detailLines(listing: PersistedListing): readonly string[] {
    const details = listing.details.slice(0, 8);
    if (details.length === 0) {
      return [];
    }

    return ["Параметры:", ...details.map((detail) => `- ${this.renderDetail(detail)}`)];
  }

  private renderDetail(detail: string): string {
    const separatorIndex = detail.indexOf(":");
    if (separatorIndex === -1) {
      return this.escape(this.translateDetailValue(detail));
    }

    const label = detail.slice(0, separatorIndex).trim();
    const value = detail.slice(separatorIndex + 1).trim();
    const translatedLabel = DETAIL_LABEL_TRANSLATIONS[label] ?? label;
    return `${this.escape(translatedLabel)}: ${this.escape(this.translateDetailValue(value))}`;
  }

  private translateDetailValue(value: string): string {
    return value
      .replace(/\bwalking\b/gi, "пешком")
      .replace(/\btransport\b/gi, "на транспорте")
      .replace(/\btrue\b/gi, "да")
      .replace(/\bfalse\b/gi, "нет")
      .replace(/\bm2\b/gi, "м²");
  }

  private ratingLabel(score: ScoreResult): string {
    return score.alertKind === "hot" ? "HOT" : score.alertKind === "watch" ? "WATCH" : "INFO";
  }

  private escape(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private telegramDescription(responseBody: unknown): string | undefined {
    if (typeof responseBody !== "object" || responseBody === null || Array.isArray(responseBody)) {
      return undefined;
    }

    const description = (responseBody as Readonly<Record<string, unknown>>)["description"];
    return typeof description === "string" ? description : undefined;
  }
}
