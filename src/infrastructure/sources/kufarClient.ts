import { z } from "zod";
import { Platform, type ListingCandidate, type MetroDistanceType } from "../../domain/listing.js";
import { toPrismaJson } from "../../utils/json.js";
import type { AppConfig } from "../../config/env.js";
import type { RetryHttpClient } from "../http/retryHttpClient.js";
import type { Logger } from "../logger.js";
import type { ListingSource } from "./listingSource.js";
import type { CatalogSource, SourcePage, SourceCheckpoint } from "./catalogSource.js";
import { featuresSchema } from "../../contracts/catalog.js";
import { inferFeatures, inMinskCollectionArea } from "../../utils/listingFeatures.js";
import { normalizeSourceImageUrl } from "../../utils/sourceImages.js";
import { extractListingDescription } from "./htmlDetails.js";

const kufarImageSchema = z.union([z.string().url(), z.record(z.string(), z.unknown())]);

export const kufarAdSchema = z.object({
  ad_id: z.union([z.string(), z.number()]),
  type: z.string().nullable().optional(),
  subject: z.string().default(""),
  body: z.string().nullable().optional(),
  body_short: z.string().nullable().optional(),
  list_time: z.string().datetime().nullable().optional(),
  price_usd: z.coerce.number().nullable().optional(),
  price_byn: z.coerce.number().nullable().optional(),
  size: z.coerce.number().nullable().optional(),
  rooms: z.coerce.number().int().nonnegative().nullable().optional(),
  account_parameters: z.unknown().optional(),
  ad_parameters: z.unknown().optional(),
  coordinates: z
    .object({
      lat: z.coerce.number(),
      lon: z.coerce.number()
    })
    .optional(),
  images: z.array(kufarImageSchema).default([]),
  ad_link: z.string().url()
}).passthrough();

const kufarResponseSchema = z.object({
  ads: z.array(kufarAdSchema),
  pagination: z
    .object({
      pages: z.array(
        z.object({
          label: z.string().optional(),
          num: z.coerce.number().optional(),
          token: z.string().nullable().optional()
        }).passthrough()
      )
    })
    .optional()
}).passthrough();

type KufarAd = z.infer<typeof kufarAdSchema>;

const KUFAR_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Referer: "https://kufar.by/",
  Origin: "https://kufar.by/",
  Accept: "application/json"
};

const KUFAR_REAL_ESTATE_PARAMS: Readonly<Record<string, string>> = {
  cat: "1010",
  cur: "USD",
  gtsy: "country-belarus~province-minsk",
  lang: "ru",
  size: "100",
  typ: "sell"
};

const KUFAR_DEFAULT_SEARCH_URL = "https://api.kufar.by/search-api/v2/search/rendered-paginated";
const KUFAR_MAX_PAGES = 10;

const KUFAR_DETAIL_PARAMETERS: readonly { readonly key: string; readonly label: string }[] = [
  { key: "address", label: "Адрес" },
  { key: "re_district", label: "Район" },
  { key: "area", label: "Местность" },
  { key: "new_buildings_apartment_complex", label: "ЖК" },
  { key: "flat_repair", label: "Ремонт" },
  { key: "condition", label: "Состояние" },
  { key: "bathroom", label: "Санузел" },
  { key: "balcony", label: "Балкон" },
  { key: "flat_ceiling_height", label: "Потолки" },
  { key: "floor", label: "Этаж" },
  { key: "re_number_floors", label: "Этажей" },
  { key: "house_type", label: "Тип дома" },
  { key: "year_built", label: "Год постройки" },
  { key: "size_living_space", label: "Жилая площадь" },
  { key: "size_kitchen", label: "Кухня" },
  { key: "kitchen_area", label: "Кухня" },
  { key: "rooms_layout", label: "Планировка" },
  { key: "room_layout", label: "Планировка" },
  { key: "re_rooms_layout", label: "Планировка" },
  { key: "rooms_type", label: "Тип комнат" },
  { key: "flat_open_room", label: "Проходные комнаты" },
  { key: "walk_through_rooms", label: "Проходные комнаты" }
];

export class KufarClient implements ListingSource, CatalogSource {
  readonly platform = "KUFAR" as const;
  readonly name = "kufar";

  constructor(
    private readonly config: Pick<AppConfig, "kufarApiUrl">,
    private readonly httpClient: RetryHttpClient,
    private readonly logger: Logger
  ) {}
  normalizeStored(payload: unknown): ListingCandidate | undefined {
    const parsed = kufarAdSchema.safeParse(payload);
    return parsed.success ? this.toListingCandidate(parsed.data) : undefined;
  }

  async fetchCatalogPage(checkpoint: SourceCheckpoint): Promise<SourcePage> {
    const envelope = await this.httpClient.json({ method: "GET", url: this.buildSearchUrl(checkpoint.cursor), headers: KUFAR_REQUEST_HEADERS, timeoutMs: 20_000, minIntervalMs: 1000 }, kufarResponseSchema.extend({ ads: z.array(z.unknown()) }));
    const candidates: ListingCandidate[] = [];
    let invalid = 0;
    for (const raw of envelope.ads) {
      const parsed = kufarAdSchema.safeParse(raw);
      if (!parsed.success) { invalid++; this.logger.warn({ issues: parsed.error.issues }, "Invalid Kufar listing"); continue; }
      const candidate = this.toListingCandidate(parsed.data);
      if (candidate) candidates.push(candidate); else invalid++;
    }
    const token = envelope.pagination?.pages.find((page) => page.label === "next")?.token;
    if (!envelope.ads.length && token) throw new Error("Kufar returned an empty intermediate page");
    return { candidates, received: envelope.ads.length, invalid, next: token ? { page: checkpoint.page + 1, cursor: token } : null };
  }

  async enrich(candidate: ListingCandidate): Promise<ListingCandidate> {
    const raw = z.object({ body: z.string().nullable().optional() }).safeParse(candidate.sourcePayload);
    if (raw.success && raw.data.body?.trim()) return { ...candidate, descriptionComplete: true, features: featuresSchema.parse({ ...candidate.features, descriptionComplete: true }) };
    const html = await this.httpClient.text({ method: "GET", url: candidate.url, headers: KUFAR_REQUEST_HEADERS, minIntervalMs: 1000 });
    const description = extractListingDescription(html, candidate.externalId, this.logger);
    if (description === null) throw new Error("Kufar did not contain a verifiable full description");
    return { ...candidate, description, descriptionComplete: true, features: featuresSchema.parse({ ...candidate.features, descriptionComplete: true, provenance: { ...candidate.features?.provenance, description: "structured" } }) };
  }

  async poll(): Promise<readonly ListingCandidate[]> {
    try {
      const candidates: ListingCandidate[] = [];
      let cursorToken: string | undefined;

      for (let page = 1; page <= KUFAR_MAX_PAGES; page += 1) {
        const response = await this.fetchPage(cursorToken);

        for (const ad of response.ads) {
          const candidate = this.toListingCandidate(ad);
          if (candidate !== undefined) {
            candidates.push(candidate);
          }
        }

        cursorToken = this.nextPageToken(response);
        if (cursorToken === undefined) {
          break;
        }
      }

      return candidates;
    } catch (error: unknown) {
      this.logger.error({ err: error }, "Failed to poll Kufar");
      return [];
    }
  }

  private async fetchPage(cursorToken: string | undefined): Promise<z.infer<typeof kufarResponseSchema>> {
    const url = this.buildSearchUrl(cursorToken);
    return await this.httpClient.json(
      { method: "GET", url, headers: KUFAR_REQUEST_HEADERS, timeoutMs: 15_000 },
      kufarResponseSchema
    );
  }

  private buildSearchUrl(cursorToken: string | undefined): string {
    const url = new URL(this.config.kufarApiUrl.includes("cre-api-v2.kufar.by") ? KUFAR_DEFAULT_SEARCH_URL : this.config.kufarApiUrl);

    for (const [key, value] of Object.entries(KUFAR_REAL_ESTATE_PARAMS)) {
      url.searchParams.set(key, value);
    }
    for (const key of ["rms", "prc", "st", "szsb", "rgn", "ot", "aid", "cursor"]) url.searchParams.delete(key);

    if (cursorToken !== undefined) {
      url.searchParams.set("cursor", cursorToken);
    }

    return url.toString();
  }

  private toListingCandidate(ad: KufarAd): ListingCandidate | undefined {
    if (ad.type !== "sell") {
      return undefined;
    }

    const priceByn = this.normalizeKopeckPrice(ad.price_byn);
    const priceUsd = this.normalizeKufarUsdPrice(ad.price_usd, priceByn);
    const size = ad.size ?? this.numberParameter(ad.ad_parameters, "size");
    const rooms = ad.rooms ?? this.numberParameter(ad.ad_parameters, "rooms");
    const coordinates = this.coordinates(ad);
    const metro = this.metroDetails(ad.ad_parameters);

    if (priceUsd === undefined) {
      this.logger.warn({ externalId: String(ad.ad_id), priceUsd: ad.price_usd }, "Skipping Kufar ad without positive USD price");
      return undefined;
    }

    if (size === undefined || size === null || size <= 0 || rooms === undefined || rooms === null) {
      this.logger.warn({ externalId: String(ad.ad_id), size, rooms }, "Skipping Kufar ad without size or rooms");
      return undefined;
    }

    const candidate: ListingCandidate = {
      platform: Platform.KUFAR,
      externalId: String(ad.ad_id),
      url: ad.ad_link,
      title: ad.subject,
      description: ad.body ?? ad.body_short ?? "",
      rooms,
      areaSqm: size,
      priceUsd,
      priceByn,
      pricePerSqm: Math.round((priceUsd / size) * 100) / 100,
      latitude: coordinates?.latitude,
      longitude: coordinates?.longitude,
      photos: ad.images.map((image) => this.imageUrl(image)).filter((url): url is string => url !== undefined),
      details: this.details(ad),
      houseType: this.displayParameter(ad.ad_parameters, "house_type") ?? this.displayParameter(ad.account_parameters, "house_type"),
      buildingSeries: this.displayParameter(ad.ad_parameters, "building_series") ?? this.displayParameter(ad.account_parameters, "building_series"),
      repairState: this.displayParameter(ad.ad_parameters, "flat_repair") ?? this.displayParameter(ad.account_parameters, "repair"),
      metroName: metro?.name,
      metroDistanceText: metro?.distanceText,
      metroDistanceType: metro?.distanceType,
      sourcePayload: toPrismaJson(ad),
      descriptionComplete: Boolean(ad.body?.trim())
    };
    const locality = this.displayParameter(ad.ad_parameters, "region") ?? this.displayParameter(ad.ad_parameters, "locality") ?? this.displayParameter(ad.ad_parameters, "town");
    const district = this.displayParameter(ad.ad_parameters, "area");
    const base = inferFeatures(candidate);
    const studioText = this.displayParameter(ad.ad_parameters, "rooms") ?? "";
    const address = this.displayParameter(ad.ad_parameters, "address") ?? this.displayParameter(ad.account_parameters, "address");
    return { ...candidate, features: featuresSchema.parse({ ...base, address, descriptionComplete: candidate.descriptionComplete,
      locality: locality ?? base.locality, district: this.displayParameter(ad.ad_parameters, "re_district") ?? district,
      inCollectionArea: inMinskCollectionArea(locality, district),
      propertyType: "apartment", dealType: "sale", isStudio: rooms === 0 || /студи/i.test(studioText) ? true : base.isStudio ?? false,
      priceIsTotal: priceByn !== undefined && this.isPlausibleUsdBynRate(priceByn / priceUsd),
      provenance: { ...base.provenance, locality: "structured", propertyType: "structured", dealType: "structured" }
    }) };
  }

  private nextPageToken(response: z.infer<typeof kufarResponseSchema>): string | undefined {
    return response.pagination?.pages.find((page) => page.label === "next")?.token ?? undefined;
  }

  private normalizeKufarUsdPrice(rawPrice: number | null | undefined, priceByn: number | undefined): number | undefined {
    if (rawPrice === null || rawPrice === undefined || rawPrice <= 0) {
      return undefined;
    }

    if (priceByn !== undefined) {
      const rawRatio = priceByn / rawPrice;
      if (this.isPlausibleUsdBynRate(rawRatio)) {
        return rawPrice;
      }

      const centsCandidate = rawPrice / 100;
      const centsRatio = priceByn / centsCandidate;
      if (this.isPlausibleUsdBynRate(centsRatio)) {
        return centsCandidate;
      }

      return rawPrice;
    }

    return rawPrice;
  }

  private isPlausibleUsdBynRate(rate: number): boolean {
    return Number.isFinite(rate) && rate >= 2 && rate <= 5;
  }

  private normalizeKopeckPrice(rawPrice: number | null | undefined): number | undefined {
    if (rawPrice === null || rawPrice === undefined || rawPrice <= 0) {
      return undefined;
    }

    return Math.round(rawPrice) / 100;
  }

  private numberParameter(parameters: unknown, key: string): number | undefined {
    const value = this.parameterValue(parameters, key);
    const scalar = Array.isArray(value) ? value[0] : value;
    const number = typeof scalar === "number" ? scalar : typeof scalar === "string" ? Number(scalar.replace(",", ".")) : NaN;

    return Number.isFinite(number) && (number > 0 || (key === "rooms" && number === 0)) ? number : undefined;
  }

  private coordinates(ad: KufarAd): { readonly latitude: number; readonly longitude: number } | undefined {
    if (ad.coordinates !== undefined) {
      return {
        latitude: ad.coordinates.lat,
        longitude: ad.coordinates.lon
      };
    }

    const value = this.parameterValue(ad.ad_parameters, "coordinates");
    if (!Array.isArray(value) || value.length < 2) {
      return undefined;
    }

    const longitude = Number(value[0]);
    const latitude = Number(value[1]);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return undefined;
    }

    return { latitude, longitude };
  }

  private stringParameter(parameters: unknown, key: string): string | undefined {
    const value = this.parameterValue(parameters, key);
    const scalar = Array.isArray(value) ? value[0] : value;

    if (typeof scalar === "string" && scalar.length > 0) {
      return scalar;
    }

    if (typeof scalar === "number" || typeof scalar === "boolean") {
      return String(scalar);
    }

    return undefined;
  }

  private displayParameter(parameters: unknown, key: string): string | undefined {
    return this.parameterText(this.findParameter(parameters, { p: key }));
  }

  private details(ad: KufarAd): readonly string[] {
    const details = KUFAR_DETAIL_PARAMETERS.map(({ key, label }) => this.detail(label, this.displayParameter(ad.ad_parameters, key)))
      .filter((detail): detail is string => detail !== undefined);

    const searchLocality = undefined;
    const accountAddress = this.detail("Адрес объявления", this.displayParameter(ad.account_parameters, "address"));
    const metro = this.metroDetails(ad.ad_parameters);
    const metroDetail =
      metro === undefined ? undefined : this.detail("Метро из источника", `${metro.name}, ${metro.distanceText} (${this.metroTypeLabel(metro.distanceType)})`);

    return [searchLocality, ...details, accountAddress, metroDetail].filter((detail): detail is string => detail !== undefined);
  }

  private detail(label: string, value: string | undefined): string | undefined {
    return value === undefined || value.length === 0 ? undefined : `${label}: ${value}`;
  }

  private metroTypeLabel(type: MetroDistanceType): string {
    return type === "walking" ? "пешком" : "на транспорте";
  }

  private metroDetails(
    parameters: unknown
  ): { readonly name: string; readonly distanceText: string; readonly distanceType: MetroDistanceType } | undefined {
    const name = this.parameterText(this.findParameter(parameters, { pu: "mee" }));
    if (name === undefined) {
      return undefined;
    }

    const walkingText = this.parameterText(this.findParameter(parameters, { p: "re_metro_afoot", pu: "mefo" }));
    if (walkingText !== undefined) {
      return {
        name,
        distanceText: walkingText,
        distanceType: "walking"
      };
    }

    const transportText = this.parameterText(this.findParameter(parameters, { p: "re_metro_transport", pu: "metr" }));
    if (transportText === undefined) {
      return undefined;
    }

    return {
      name,
      distanceText: transportText,
      distanceType: "transport"
    };
  }

  private findParameter(
    parameters: unknown,
    expected: { readonly p?: string | undefined; readonly pu?: string | undefined }
  ): Readonly<Record<string, unknown>> | undefined {
    if (!Array.isArray(parameters)) {
      return undefined;
    }

    return parameters.find((item): item is Readonly<Record<string, unknown>> => {
      if (!this.isRecord(item)) {
        return false;
      }

      const p = this.firstString(item, ["p"]);
      const pu = this.firstString(item, ["pu"]);
      return (expected.p === undefined || p === expected.p) && (expected.pu === undefined || pu === expected.pu);
    });
  }

  private parameterText(parameter: Readonly<Record<string, unknown>> | undefined): string | undefined {
    if (parameter === undefined) {
      return undefined;
    }

    for (const key of ["vl", "v", "value", "label", "text"]) {
      const text = this.textValue(parameter[key]);
      if (text !== undefined && text.length > 0) return text;
    }
    return undefined;
  }

  private textValue(value: unknown): string | undefined {
    if (typeof value === "string") {
      return value.trim();
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      const parts = value.map((item) => this.textValue(item)).filter((item): item is string => item !== undefined && item.length > 0);
      return parts.length === 0 ? undefined : parts.join(", ");
    }

    return undefined;
  }

  private parameterValue(parameters: unknown, key: string): unknown {
    if (this.isRecord(parameters)) {
      const value = parameters[key];
      return this.isRecord(value) ? value["v"] ?? value["value"] ?? value["name"] ?? value["label"] : value;
    }

    if (Array.isArray(parameters)) {
      for (const item of parameters) {
        if (!this.isRecord(item)) {
          continue;
        }

        const candidateKey = this.firstString(item, ["id", "key", "name", "code"]);
        const parameterKey = this.firstString(item, ["p"]);
        if (candidateKey !== key && parameterKey !== key) {
          continue;
        }

        return item["v"] ?? item["value"] ?? item["vl"] ?? item["label"] ?? item["text"];
      }
    }

    return undefined;
  }

  private imageUrl(image: string | Readonly<Record<string, unknown>>): string | undefined {
    if (typeof image === "string") {
      return this.absoluteImageUrl(image);
    }

    const directValue = this.firstString(image, ["url", "src", "path", "original", "large"]);
    if (typeof directValue === "string") {
      return this.absoluteImageUrl(directValue);
    }

    const nested = image["media"] ?? image["image"] ?? image["file"];
    if (this.isRecord(nested)) {
      return this.imageUrl(nested);
    }

    return undefined;
  }

  private absoluteImageUrl(value: string): string | undefined {
    try {
      return normalizeSourceImageUrl(value);
    } catch {
      return undefined;
    }
  }

  private isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private firstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }

    return undefined;
  }
}
