import * as cheerio from "cheerio";
import { z } from "zod";
import { Platform, type ListingCandidate, type MetroDistanceType } from "../../domain/listing.js";
import { toPrismaJson } from "../../utils/json.js";
import type { AppConfig } from "../../config/env.js";
import type { Logger } from "../logger.js";
import type { PlaywrightBrowserFactory } from "../browser/playwrightBrowserFactory.js";
import type { ListingSource } from "./listingSource.js";
import type { CatalogSource, SourcePage, SourceCheckpoint } from "./catalogSource.js";
import { HttpRequestError, type RetryHttpClient } from "../http/retryHttpClient.js";
import { featuresSchema } from "../../contracts/catalog.js";
import { inferFeatures, inMinskCollectionArea } from "../../utils/listingFeatures.js";
import { enrichParameterHtml, extractListingDescription } from "./htmlDetails.js";
import { realtHouseTypeLabel, realtRepairStateLabel } from "./realtLabels.js";

const realtObjectSchema = z.object({
  uuid: z.string().optional(),
  code: z.union([z.string(), z.number()]),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  headline: z.string().nullable().optional(),
  rooms: z.coerce.number().int().nonnegative(),
  areaTotal: z.coerce.number().positive(),
  areaLiving: z.coerce.number().nullable().optional(),
  areaKitchen: z.coerce.number().nullable().optional(),
  price: z.coerce.number().positive().nullable().optional(),
  priceCurrency: z.coerce.number().nullable().optional(),
  priceRates: z.record(z.string(), z.coerce.number()).nullable().optional(),
  priceRatesPerM2: z.record(z.string(), z.coerce.number()).nullable().optional(),
  storey: z.coerce.number().nullable().optional(),
  storeys: z.coerce.number().nullable().optional(),
  images: z.array(z.string().url()).default([]),
  location: z.tuple([z.coerce.number(), z.coerce.number()]).nullable().optional(),
  address: z.string().nullable().optional(),
  stateRegionName: z.string().nullable().optional(),
  stateDistrictName: z.string().nullable().optional(),
  townName: z.string().nullable().optional(),
  streetName: z.string().nullable().optional(),
  houseNumber: z.union([z.string(), z.number()]).nullable().optional(),
  metroStationName: z.string().nullable().optional(),
  metroTime: z.coerce.number().nullable().optional(),
  metroTimeType: z.coerce.number().nullable().optional(),
  houseType: z.union([z.string(), z.number()]).nullable().optional(),
  repairState: z.union([z.string(), z.number()]).nullable().optional(),
  buildingYear: z.union([z.string(), z.number()]).nullable().optional()
}).passthrough();

const realtNextDataSchema = z.object({
  props: z.object({
    pageProps: z.object({
      objects: z.array(realtObjectSchema).default([])
    }).passthrough()
  }).passthrough()
}).passthrough();

type RealtObject = z.infer<typeof realtObjectSchema>;

const USD_CURRENCY_CODE = "840";
const BYN_CURRENCY_CODE = "933";

export class RealtScraper implements ListingSource, CatalogSource {
  readonly platform = "REALT" as const;
  private pageGate: Promise<void> = Promise.resolve();
  private lastPageStarted = 0;
  readonly name = "realt";

  constructor(
    private readonly config: Pick<AppConfig, "realtSearchUrl">,
    private readonly browserFactory: PlaywrightBrowserFactory,
    private readonly logger: Logger,
    private readonly httpClient?: RetryHttpClient
  ) {}
  normalizeStored(payload: unknown): ListingCandidate | undefined {
    const parsed = realtObjectSchema.safeParse(payload);
    return parsed.success ? this.toListingCandidate(parsed.data) : undefined;
  }

  async fetchCatalogPage(checkpoint: SourceCheckpoint): Promise<SourcePage> {
    const url = new URL("https://realt.by/sale/flats/");
    url.searchParams.set("page", String(checkpoint.page));
    url.searchParams.set("addressV2", JSON.stringify([{ stateDistrictUuid: "495ebec0-7b00-11eb-8943-0cc47adabd66" }]));
    const html = await this.loadHtml(url.toString());
    const $ = cheerio.load(html);
    const raw = $("#__NEXT_DATA__").text();
    if (!raw) throw new Error(`Realt did not return listing data: ${$("title").text()}`);
    const envelope = z.object({ props: z.object({ pageProps: z.object({
      objects: z.array(z.unknown()), pagination: z.object({ page: z.number(), pageSize: z.number(), totalCount: z.number() })
    }) }) }).parse(JSON.parse(raw) as unknown).props.pageProps;
    if (envelope.pagination.page !== checkpoint.page) throw new Error("Realt ignored the requested page number");
    if (!envelope.objects.length && envelope.pagination.totalCount > 0) throw new Error("Realt returned empty objects for a nonempty search");
    const candidates: ListingCandidate[] = [];
    let invalid = 0;
    for (const item of envelope.objects) {
      const parsed = realtObjectSchema.safeParse(item);
      if (!parsed.success) { invalid++; this.logger.warn({ issues: parsed.error.issues }, "Invalid Realt object"); continue; }
      const candidate = this.toListingCandidate(parsed.data);
      if (candidate) candidates.push(candidate); else invalid++;
    }
    const p = envelope.pagination;
    return { candidates, received: envelope.objects.length, invalid, next: p.page * p.pageSize < p.totalCount && envelope.objects.length > 0 ? { page: checkpoint.page + 1 } : null };
  }

  async enrich(candidate: ListingCandidate): Promise<ListingCandidate> {
    const html = await this.loadHtml(candidate.url);
    const description = extractListingDescription(html, candidate.externalId, this.logger);
    if (description === null && candidate.descriptionComplete !== true) throw new Error("Realt did not contain a verifiable full description");
    return enrichParameterHtml({ ...candidate, houseType: realtHouseTypeLabel(candidate.houseType),
      repairState: realtRepairStateLabel(candidate.repairState), description: description ?? candidate.description, descriptionComplete: true,
      features: featuresSchema.parse({ ...candidate.features, descriptionComplete: true, provenance: { ...candidate.features?.provenance, description: "structured" } }) }, html);
  }

  private async loadHtml(url: string): Promise<string> {
    let release!: () => void;
    const previous = this.pageGate;
    this.pageGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const delay = 1000 - (Date.now() - this.lastPageStarted);
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    this.lastPageStarted = Date.now();
    try { return await this.loadHtmlUnlocked(url); } finally { release(); }
  }

  private async loadHtmlUnlocked(url: string): Promise<string> {
    if (this.httpClient) {
      try { return await this.httpClient.text({ method: "GET", url, minIntervalMs: 1000, timeoutMs: 30_000 }); }
      catch (error: unknown) {
        if (error instanceof HttpRequestError && (!error.retryable || error.statusCode === 429)) throw error;
        this.logger.warn({ err: error, url }, "Realt HTTP failed, trying browser session");
      }
    }
    const session = await this.browserFactory.create();
    try {
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return await session.page.content();
    } finally { await session.close(); }
  }

  async poll(): Promise<readonly ListingCandidate[]> {
    const session = await this.safeCreateSession();
    if (session === undefined) {
      return [];
    }

    try {
      await session.page.goto(this.config.realtSearchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000
      });
      await session.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch((error: unknown) => {
        this.logger.warn({ err: error }, "Realt page did not reach networkidle before timeout");
      });

      const html = await session.page.content();
      return this.parseHtml(html);
    } catch (error: unknown) {
      this.logger.error({ err: error, url: this.config.realtSearchUrl }, "Failed to scrape Realt");
      return [];
    } finally {
      await session.close().catch((error: unknown) => {
        this.logger.warn({ err: error }, "Failed to close Playwright session");
      });
    }
  }

  private async safeCreateSession(): Promise<Awaited<ReturnType<PlaywrightBrowserFactory["create"]>> | undefined> {
    try {
      return await this.browserFactory.create();
    } catch (error: unknown) {
      this.logger.error({ err: error }, "Unable to start Realt browser session");
      return undefined;
    }
  }

  private parseHtml(html: string): readonly ListingCandidate[] {
    const objects = this.extractObjects(html);
    const candidates = objects
      .map((object) => this.toListingCandidate(object))
      .filter((candidate): candidate is ListingCandidate => candidate !== undefined);

    this.logger.info({ objectCount: objects.length, parsedCount: candidates.length }, "Parsed Realt embedded listing data");
    return candidates;
  }

  private extractObjects(html: string): readonly RealtObject[] {
    const $ = cheerio.load(html);
    const rawNextData = $("#__NEXT_DATA__").text();

    if (rawNextData.length === 0) {
      this.logger.warn({ htmlSample: html.slice(0, 500) }, "Realt page did not contain __NEXT_DATA__");
      return [];
    }

    try {
      const parsed = realtNextDataSchema.parse(JSON.parse(rawNextData));
      return parsed.props.pageProps.objects;
    } catch (error: unknown) {
      this.logger.warn({ err: error }, "Failed to parse Realt __NEXT_DATA__");
      return [];
    }
  }

  private toListingCandidate(object: RealtObject): ListingCandidate | undefined {
    const priceUsd = this.priceUsd(object);
    if (priceUsd === undefined) {
      this.logger.warn({ code: object.code, price: object.price, priceCurrency: object.priceCurrency }, "Skipping Realt object without USD price");
      return undefined;
    }

    const coordinates = this.coordinates(object);
    const metro = this.metroDetails(object);

    const candidate: ListingCandidate = {
      descriptionComplete: Boolean(object.description?.trim()),
      platform: Platform.REALT,
      externalId: String(object.code),
      url: this.objectUrl(object.code),
      title: object.title ?? "Realt listing",
      description: this.description(object),
      rooms: object.rooms,
      areaSqm: object.areaTotal,
      priceUsd,
      priceByn: this.priceByn(object),
      pricePerSqm: Math.round((priceUsd / object.areaTotal) * 100) / 100,
      latitude: coordinates?.latitude,
      longitude: coordinates?.longitude,
      photos: object.images,
      details: this.details(object),
      houseType: realtHouseTypeLabel(object.houseType),
      buildingSeries: this.optionalString(object.buildingYear),
      repairState: realtRepairStateLabel(object.repairState),
      metroName: metro?.name,
      metroDistanceText: metro?.distanceText,
      metroDistanceType: metro?.distanceType,
      sourcePayload: toPrismaJson(object)
    };
    const features = inferFeatures(candidate);
    const areaAllowed = inMinskCollectionArea(object.townName ?? undefined, object.stateDistrictName ?? undefined);
    return { ...candidate, features: featuresSchema.parse({ ...features, descriptionComplete: candidate.descriptionComplete,
      address: object.address ?? undefined, locality: object.townName ?? undefined,
      district: object.stateDistrictName ?? undefined, inCollectionArea: areaAllowed ?? (object.stateDistrictName ? false : undefined),
      propertyType: "apartment", dealType: "sale", priceIsTotal: true,
      isStudio: object.rooms === 0 ? true : features.isStudio,
      floor: object.storey ?? undefined, totalFloors: object.storeys ?? undefined,
      buildingYear: Number(object.buildingYear) > 1800 ? Number(object.buildingYear) : undefined,
      provenance: { ...features.provenance, address: "structured", locality: "structured", district: "structured", propertyType: "structured", dealType: "structured" }
    }) };
  }

  private priceUsd(object: RealtObject): number | undefined {
    const ratePrice = object.priceRates?.[USD_CURRENCY_CODE];
    if (ratePrice !== undefined && ratePrice > 0) {
      return ratePrice;
    }

    return object.priceCurrency === Number(USD_CURRENCY_CODE) && object.price !== null && object.price !== undefined
      ? object.price
      : undefined;
  }

  private priceByn(object: RealtObject): number | undefined {
    const ratePrice = object.priceRates?.[BYN_CURRENCY_CODE];
    if (ratePrice !== undefined && ratePrice > 0) {
      return ratePrice;
    }

    return object.priceCurrency === Number(BYN_CURRENCY_CODE) && object.price !== null && object.price !== undefined
      ? object.price
      : undefined;
  }

  private coordinates(object: RealtObject): { readonly latitude: number; readonly longitude: number } | undefined {
    if (object.location === null || object.location === undefined) {
      return undefined;
    }

    const [longitude, latitude] = object.location;
    return { latitude, longitude };
  }

  private metroDetails(
    object: RealtObject
  ): { readonly name: string; readonly distanceText: string; readonly distanceType: MetroDistanceType } | undefined {
    if (object.metroStationName === null || object.metroStationName === undefined || object.metroTime === null || object.metroTime === undefined) {
      return undefined;
    }

    return {
      name: object.metroStationName,
      distanceText: `${object.metroTime} min`,
      distanceType: object.metroTimeType === 2 ? "transport" : "walking"
    };
  }

  private description(object: RealtObject): string {
    return [object.headline, object.description, object.address].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
  }

  private details(object: RealtObject): readonly string[] {
    return [
      this.detail("Address", object.address),
      this.detail("Region", object.stateRegionName),
      this.detail("District", object.stateDistrictName),
      this.detail("Town", object.townName),
      this.detail("Street", object.streetName),
      this.detail("Metro", object.metroStationName),
      this.detail("Floor", object.storey === undefined || object.storeys === undefined ? undefined : `${object.storey}/${object.storeys}`),
      this.detail("Kitchen", object.areaKitchen === null || object.areaKitchen === undefined ? undefined : `${object.areaKitchen} m2`),
      this.detail("Living", object.areaLiving === null || object.areaLiving === undefined ? undefined : `${object.areaLiving} m2`),
      this.detail("Built", object.buildingYear),
      this.detail("House type", realtHouseTypeLabel(object.houseType)),
      this.detail("Repair", realtRepairStateLabel(object.repairState))
    ].filter((detail): detail is string => detail !== undefined);
  }

  private detail(label: string, value: string | number | null | undefined): string | undefined {
    return value === null || value === undefined || String(value).length === 0 ? undefined : `${label}: ${value}`;
  }

  private objectUrl(code: string | number): string {
    return new URL(`/sale-flats/object/${code}/`, this.config.realtSearchUrl).toString();
  }

  private optionalString(value: string | number | null | undefined): string | undefined {
    return value === null || value === undefined ? undefined : String(value);
  }
}
