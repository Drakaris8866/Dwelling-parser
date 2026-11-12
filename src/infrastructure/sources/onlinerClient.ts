import { z } from "zod";
import { Platform, type ListingCandidate } from "../../domain/listing.js";
import { toPrismaJson } from "../../utils/json.js";
import type { AppConfig } from "../../config/env.js";
import type { RetryHttpClient } from "../http/retryHttpClient.js";
import type { Logger } from "../logger.js";
import type { ListingSource } from "./listingSource.js";
import { sanitizeHttpUrl } from "../../utils/url.js";
import type { CatalogSource, SourcePage, SourceCheckpoint } from "./catalogSource.js";
import { featuresSchema } from "../../contracts/catalog.js";
import { inferFeatures, inMinskCollectionArea } from "../../utils/listingFeatures.js";
import { enrichOnlinerHtml, localityFromAddress } from "./htmlDetails.js";

const nullableStringSchema = z.string().nullable().optional();
const optionalNumberSchema = z.coerce.number().nullable().optional();
const convertedPriceSchema = z.object({
  amount: optionalNumberSchema,
  currency: nullableStringSchema
}).passthrough();

export const onlinerApartmentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().nullable().optional().default(""),
  description: z.string().nullable().optional().default(""),
  url: z.string().url(),
  price: z.object({
    amount: z.coerce.number().positive(),
    currency: z.string(),
    amount_byn: optionalNumberSchema,
    byn: optionalNumberSchema,
    converted: z.record(z.string(), convertedPriceSchema).optional()
  }).passthrough(),
  area: z.object({
    total: optionalNumberSchema,
    living: optionalNumberSchema,
    kitchen: optionalNumberSchema
  }),
  rent: z
    .object({
      amount: optionalNumberSchema,
      currency: nullableStringSchema
    })
    .nullable()
    .optional(),
  number_of_rooms: z.coerce.number().int().nonnegative().nullable().optional(),
  location: z
    .object({
      address: nullableStringSchema,
      user_address: nullableStringSchema,
      latitude: z.coerce.number(),
      longitude: z.coerce.number()
    })
    .passthrough()
    .nullable()
    .optional(),
  floor: optionalNumberSchema,
  number_of_floors: optionalNumberSchema,
  photo: z.string().url().optional(),
  photos: z.array(z.string().url()).optional(),
  house_type: z.string().optional(),
  repair: z.string().optional(),
  seller: z
    .object({
      type: nullableStringSchema
    })
    .passthrough()
    .nullable()
    .optional(),
  resale: z.boolean().nullable().optional()
}).passthrough();

const onlinerResponseSchema = z.object({
  apartments: z.array(onlinerApartmentSchema),
  page: z
    .object({
      current: z.coerce.number().int().positive().optional(),
      last: z.coerce.number().int().positive().optional()
    })
    .optional()
}).passthrough();

type OnlinerApartment = z.infer<typeof onlinerApartmentSchema>;

const ONLINER_MAX_PAGES = 10;

export class OnlinerClient implements ListingSource, CatalogSource {
  readonly platform = "ONLINER" as const;
  readonly name = "onliner";

  constructor(
    private readonly config: Pick<AppConfig, "onlinerApiUrl">,
    private readonly httpClient: RetryHttpClient,
    private readonly logger: Logger
  ) {}
  normalizeStored(payload: unknown): ListingCandidate | undefined {
    const parsed = onlinerApartmentSchema.safeParse(payload);
    return parsed.success ? this.toListingCandidate(parsed.data) : undefined;
  }

  async fetchCatalogPage(checkpoint: SourceCheckpoint): Promise<SourcePage> {
    const configured = new URL(sanitizeHttpUrl(this.config.onlinerApiUrl));
    if (this.isRentEndpoint(configured.toString())) throw new Error("Onliner catalog requires a sale endpoint");
    const url = configured.hostname === "r.api.onliner.by" || configured.hostname === "pk.api.onliner.by"
      ? new URL("https://r.onliner.by/sdapi/pk.api/search/apartments") : new URL(`${configured.origin}${configured.pathname}`);
    url.searchParams.set("currency", "USD");
    url.searchParams.set("page", String(checkpoint.page));
    // This rectangle is deliberately broader than the district; structured locality checks remain authoritative.
    for (const [key, value] of Object.entries({ "bounds[lb][lat]": "53.55", "bounds[lb][long]": "26.65", "bounds[rt][lat]": "54.35", "bounds[rt][long]": "28.35" })) url.searchParams.set(key, value);
    const response = await this.httpClient.json({ method: "GET", url: url.toString(), timeoutMs: 20_000, minIntervalMs: 1000 }, onlinerResponseSchema.extend({ apartments: z.array(z.unknown()) }));
    if (response.page?.current !== undefined && response.page.current !== checkpoint.page) throw new Error("Onliner returned a different page than requested");
    if (!response.apartments.length && (response.page?.last ?? 0) > checkpoint.page) throw new Error("Onliner returned an empty intermediate page");
    const candidates: ListingCandidate[] = [];
    let invalid = 0;
    for (const raw of response.apartments) {
      const parsed = onlinerApartmentSchema.safeParse(raw);
      if (!parsed.success) { invalid++; this.logger.warn({ issues: parsed.error.issues }, "Invalid Onliner listing"); continue; }
      if (parsed.data.rent?.amount !== undefined && parsed.data.rent?.amount !== null) continue;
      const candidate = this.toListingCandidate(parsed.data);
      if (candidate) candidates.push(candidate); else invalid++;
    }
    return { candidates, received: response.apartments.length, invalid, next: checkpoint.page < (response.page?.last ?? checkpoint.page) ? { page: checkpoint.page + 1 } : null };
  }

  async enrich(candidate: ListingCandidate): Promise<ListingCandidate> {
    return enrichOnlinerHtml(candidate, await this.httpClient.text({ method: "GET", url: candidate.url, minIntervalMs: 1000 }));
  }

  async poll(): Promise<readonly ListingCandidate[]> {
    try {
      const baseUrl = sanitizeHttpUrl(this.config.onlinerApiUrl);
      if (this.isRentEndpoint(baseUrl)) {
        this.logger.warn({ url: baseUrl }, "Skipping Onliner rent endpoint");
        return [];
      }

      const candidates: ListingCandidate[] = [];
      let lastPage = 1;

      for (let page = 1; page <= Math.min(lastPage, ONLINER_MAX_PAGES); page += 1) {
        const url = this.pageUrl(baseUrl, page);
        const response = await this.httpClient.json({ method: "GET", url, timeoutMs: 15_000 }, onlinerResponseSchema);
        lastPage = response.page?.last ?? page;

        candidates.push(
          ...response.apartments
            .filter((apartment) => apartment.rent?.amount === null || apartment.rent?.amount === undefined)
            .map((apartment) => this.toListingCandidate(apartment))
            .filter((candidate): candidate is ListingCandidate => candidate !== undefined)
        );
      }

      return candidates;
    } catch (error: unknown) {
      this.logger.error({ err: error }, "Failed to poll Onliner");
      return [];
    }
  }

  private isRentEndpoint(url: string): boolean {
    const parsed = new URL(url);
    return parsed.hostname.startsWith("ak.api.") || parsed.pathname.toLowerCase().includes("rent");
  }

  private pageUrl(baseUrl: string, page: number): string {
    const url = new URL(baseUrl);
    url.searchParams.set("page", String(page));
    return url.toString();
  }

  private toListingCandidate(apartment: OnlinerApartment): ListingCandidate | undefined {
    if (apartment.area.total === null || apartment.area.total === undefined || apartment.area.total <= 0 || apartment.number_of_rooms === null || apartment.number_of_rooms === undefined) {
      this.logger.warn({ externalId: String(apartment.id), area: apartment.area, rooms: apartment.number_of_rooms }, "Skipping Onliner apartment without area or rooms");
      return undefined;
    }

    const priceUsd = this.priceUsd(apartment);
    if (priceUsd === undefined) {
      this.logger.warn({ externalId: String(apartment.id), price: apartment.price }, "Skipping Onliner apartment without USD price");
      return undefined;
    }

    const photos = apartment.photos ?? (apartment.photo === undefined ? [] : [apartment.photo]);

    const candidate: ListingCandidate = {
      photosComplete: apartment.photos !== undefined,
      descriptionComplete: Boolean(apartment.description?.trim()),
      platform: Platform.ONLINER,
      externalId: String(apartment.id),
      url: apartment.url,
      title: apartment.title ?? "",
      description: apartment.description ?? "",
      rooms: apartment.number_of_rooms,
      areaSqm: apartment.area.total,
      priceUsd,
      priceByn: this.priceByn(apartment),
      pricePerSqm: Math.round((priceUsd / apartment.area.total) * 100) / 100,
      latitude: apartment.location?.latitude,
      longitude: apartment.location?.longitude,
      photos,
      details: this.details(apartment),
      houseType: apartment.house_type,
      repairState: apartment.repair,
      sourcePayload: toPrismaJson(apartment)
    };
    const address = apartment.location?.address ?? apartment.location?.user_address ?? undefined;
    const locality = localityFromAddress(address);
    const district = apartment.location?.user_address?.match(/Минский\s+(?:район|р-н)/i)?.[0];
    const f = inferFeatures(candidate);
    return { ...candidate, features: featuresSchema.parse({ ...f, address, locality, district, descriptionComplete: candidate.descriptionComplete,
      inCollectionArea: inMinskCollectionArea(locality, district), propertyType: "unknown", dealType: "sale",
      isStudio: apartment.number_of_rooms === 0 ? true : f.isStudio,
      seller: apartment.seller?.type === "owner" ? "owner" : apartment.seller?.type === "agent" ? "agent" : undefined,
      readiness: f.readiness, priceIsTotal: true,
      provenance: { ...f.provenance, address: "structured", locality: "structured", propertyType: "structured", dealType: "structured" }
    }) };
  }

  private details(apartment: OnlinerApartment): readonly string[] {
    return [
      this.detail("Адрес", apartment.location?.address),
      this.detail("Адрес пользователя", apartment.location?.user_address),
      this.detail("Этаж", this.floorText(apartment)),
      this.detail("Кухня", this.areaText(apartment.area.kitchen)),
      this.detail("Жилая площадь", this.areaText(apartment.area.living)),
      this.detail("Тип дома", apartment.house_type),
      this.detail("Ремонт", apartment.repair),
      this.detail("Продавец", apartment.seller?.type),
      this.detail("Вторичка", apartment.resale === null || apartment.resale === undefined ? undefined : this.booleanText(apartment.resale))
    ].filter((detail): detail is string => detail !== undefined);
  }

  private floorText(apartment: OnlinerApartment): string | undefined {
    if (apartment.floor === null || apartment.floor === undefined) {
      return undefined;
    }

    if (apartment.number_of_floors === null || apartment.number_of_floors === undefined) {
      return String(apartment.floor);
    }

    return `${apartment.floor}/${apartment.number_of_floors}`;
  }

  private areaText(area: number | null | undefined): string | undefined {
    return area === null || area === undefined ? undefined : `${area} м²`;
  }

  private booleanText(value: boolean): string {
    return value ? "да" : "нет";
  }

  private detail(label: string, value: string | number | null | undefined): string | undefined {
    if (value === null || value === undefined || String(value).length === 0) {
      return undefined;
    }

    return `${label}: ${value}`;
  }

  private priceUsd(apartment: OnlinerApartment): number | undefined {
    if (apartment.price.currency.toUpperCase() === "USD" && apartment.price.amount > 0) {
      return apartment.price.amount;
    }

    const convertedUsd = apartment.price.converted?.["USD"] ?? apartment.price.converted?.["usd"];
    const convertedAmount = convertedUsd?.amount;
    return convertedAmount !== null && convertedAmount !== undefined && convertedAmount > 0 ? convertedAmount : undefined;
  }

  private priceByn(apartment: OnlinerApartment): number | undefined {
    if (apartment.price.currency.toUpperCase() === "BYN" && apartment.price.amount > 0) {
      return apartment.price.amount;
    }

    const directPrice = apartment.price.amount_byn ?? apartment.price.byn;
    if (directPrice !== null && directPrice !== undefined && directPrice > 0) {
      return directPrice;
    }

    const convertedByn = apartment.price.converted?.["BYN"] ?? apartment.price.converted?.["byn"];
    const convertedAmount = convertedByn?.amount;
    return convertedAmount !== null && convertedAmount !== undefined && convertedAmount > 0 ? convertedAmount : undefined;
  }
}
