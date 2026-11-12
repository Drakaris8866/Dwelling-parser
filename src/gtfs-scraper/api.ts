import axios, { type AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import * as cheerio from "cheerio";
import { CookieJar } from "tough-cookie";
import type { Logger } from "../infrastructure/logger.js";
import type {
  MinsktransHourLine,
  MinsktransPoint,
  MinsktransRoute,
  MinsktransSchedule,
  MinsktransScheduleVariant,
  MinsktransStop,
  TransportType
} from "./types.js";

const BASE_URL = "https://minsktrans.by";
const SESSION_PATH = "/lookout_yard/Home/Index/minsk";
const ROUTE_LIST_PATH = "/lookout_yard/Data/RouteList";
const ROUTE_PATH = "/lookout_yard/Data/Route";
const SCHEDULE_PATH = "/lookout_yard/Data/Schedule";
const MIN_REQUEST_DELAY_MS = 500;

type UnknownRecord = Readonly<Record<string, unknown>>;

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class MinsktransApiClient {
  private readonly client: AxiosInstance;
  private verificationToken: string | undefined;
  private lastRequestAt = 0;

  constructor(private readonly logger: Logger) {
    const jar = new CookieJar();
    this.client = wrapper(
      axios.create({
        baseURL: BASE_URL,
        jar,
        withCredentials: true,
        timeout: 20_000,
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          Origin: BASE_URL,
          Referer: `${BASE_URL}${SESSION_PATH}`,
          "X-Requested-With": "XMLHttpRequest"
        }
      })
    );
  }

  async initSession(): Promise<void> {
    await this.waitForRateLimit();
    const response = await this.client.get<string>(SESSION_PATH, {
      responseType: "text"
    });
    const $ = cheerio.load(response.data);
    const token = $('input[name="__RequestVerificationToken"]').attr("value")?.trim();

    if (token === undefined || token.length === 0) {
      throw new Error("Minsktrans CSRF token was not found on session page");
    }

    this.verificationToken = token;
    this.logger.info("Minsktrans session initialized");
  }

  async fetchRoute(routeNumber: string, transportType: TransportType): Promise<MinsktransRoute> {
    const payload = this.routePayload(routeNumber, transportType);
    await this.waitForRateLimit();

    const response = await this.client.post<unknown>(ROUTE_PATH, payload, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
      }
    });

    return normalizeRouteResponse(response.data, routeNumber, transportType);
  }

  async fetchAllRoutes(transportType: TransportType): Promise<readonly string[]> {
    const payload = this.basePayload(transportType);
    await this.waitForRateLimit();

    const response = await this.client.post<unknown>(ROUTE_LIST_PATH, payload, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
      }
    });

    return normalizeRouteListResponse(response.data);
  }

  async fetchSchedule(
    routeNumber: string,
    transportType: TransportType,
    stopId: string,
    direction: string
  ): Promise<MinsktransSchedule> {
    const payload = this.routePayload(routeNumber, transportType);
    payload.set("s", stopId);
    payload.set("d", direction);

    await this.waitForRateLimit();
    const response = await this.client.post<unknown>(SCHEDULE_PATH, payload, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
      }
    });

    return normalizeScheduleResponse(response.data);
  }

  private basePayload(transportType: TransportType): URLSearchParams {
    if (this.verificationToken === undefined) {
      throw new Error("Minsktrans session is not initialized");
    }

    return new URLSearchParams({
      p: "minsk",
      tt: transportType,
      __RequestVerificationToken: this.verificationToken
    });
  }

  private routePayload(routeNumber: string, transportType: TransportType): URLSearchParams {
    const payload = this.basePayload(transportType);
    payload.set("r", routeNumber);
    return payload;
  }

  private async waitForRateLimit(): Promise<void> {
    const elapsedMs = Date.now() - this.lastRequestAt;
    if (elapsedMs < MIN_REQUEST_DELAY_MS) {
      await delay(MIN_REQUEST_DELAY_MS - elapsedMs);
    }

    this.lastRequestAt = Date.now();
  }
}

export const normalizeRouteResponse = (
  value: unknown,
  routeNumber: string,
  transportType: TransportType
): MinsktransRoute => {
  const routeRecord = findRecordWithAnyKey(value, ["PointsA", "pointsA", "StopsA", "stopsA"]);
  if (routeRecord === undefined) {
    throw new Error(`Minsktrans route response for ${transportType} ${routeNumber} does not contain route data`);
  }

  return {
    routeNumber,
    transportType,
    pointsA: pointsOrStopFallback(
      normalizePoints(readArray(routeRecord, ["PointsA", "pointsA"])),
      normalizeStops(readArray(routeRecord, ["StopsA", "stopsA"]), readStringArray(routeRecord, ["StopNamesA", "stopNamesA"]))
    ),
    pointsB: pointsOrStopFallback(
      normalizePoints(readArray(routeRecord, ["PointsB", "pointsB"])),
      normalizeStops(readArray(routeRecord, ["StopsB", "stopsB"]), readStringArray(routeRecord, ["StopNamesB", "stopNamesB"]))
    ),
    stopsA: normalizeStops(readArray(routeRecord, ["StopsA", "stopsA"]), readStringArray(routeRecord, ["StopNamesA", "stopNamesA"])),
    stopsB: normalizeStops(readArray(routeRecord, ["StopsB", "stopsB"]), readStringArray(routeRecord, ["StopNamesB", "stopNamesB"]))
  };
};

export const normalizeRouteListResponse = (value: unknown): readonly string[] => {
  const routeListRecord = findRecordWithAnyKey(value, ["Routes", "routes"]);
  if (routeListRecord === undefined) {
    throw new Error("Minsktrans route list response does not contain Routes array");
  }

  const routes = readArray(routeListRecord, ["Routes", "routes"]);
  return routes
    .flatMap((route) => {
      if (!isRecord(route)) {
        return [];
      }

      const routeNumber = readString(route, ["Number", "number"]);
      return routeNumber === undefined ? [] : [routeNumber];
    })
    .filter((routeNumber, index, values) => values.indexOf(routeNumber) === index);
};

export const normalizeScheduleResponse = (value: unknown): MinsktransSchedule => {
  const variants = collectScheduleVariants(value, 0);
  return { variants };
};

const normalizePoints = (values: readonly unknown[]): readonly MinsktransPoint[] =>
  values.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }

    const latitude = readNumber(value, ["Latitude", "Lat", "lat", "latitude", "Y", "y"]);
    const longitude = readNumber(value, ["Longitude", "Lng", "Lon", "long", "lon", "longitude", "X", "x"]);

    if (latitude === undefined || longitude === undefined) {
      return [];
    }

    return [{ latitude, longitude }];
  });

const normalizeStops = (values: readonly unknown[], names: readonly string[] = []): readonly MinsktransStop[] =>
  values.flatMap((value, index) => {
    if (!isRecord(value)) {
      return [];
    }

    const id = readString(value, ["Id", "ID", "StopId", "stopId", "id"]);
    const latitude = readNumber(value, ["Latitude", "Lat", "lat", "latitude", "Y", "y"]);
    const longitude = readNumber(value, ["Longitude", "Lng", "Lon", "long", "lon", "longitude", "X", "x"]);
    const name = readStopName(value) ?? names[index];

    if (id === undefined || latitude === undefined || longitude === undefined || name === undefined) {
      return [];
    }

    return [{ id, name, latitude, longitude }];
  });

const pointsOrStopFallback = (
  points: readonly MinsktransPoint[],
  stops: readonly MinsktransStop[]
): readonly MinsktransPoint[] => {
  if (points.length > 0) {
    return points;
  }

  return stops.map((stop) => ({
    latitude: stop.latitude,
    longitude: stop.longitude
  }));
};

const collectScheduleVariants = (value: unknown, depth: number): readonly MinsktransScheduleVariant[] => {
  if (depth > 8) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectScheduleVariants(item, depth + 1));
  }

  if (!isRecord(value)) {
    return [];
  }

  const hourLines = readArray(value, ["HourLines", "hourLines"]);
  const daysOfWeekMask = readNumber(value, ["DaysOfWeek", "daysOfWeek", "DayOfWeek", "Mask", "mask"]);
  const current =
    hourLines.length > 0 && daysOfWeekMask !== undefined
      ? [
          {
            daysOfWeekMask,
            hourLines: normalizeHourLines(hourLines)
          }
        ]
      : [];

  const nested = Object.values(value).flatMap((nestedValue) => collectScheduleVariants(nestedValue, depth + 1));
  return [...current, ...nested].filter((variant) => variant.hourLines.length > 0);
};

const normalizeHourLines = (values: readonly unknown[]): readonly MinsktransHourLine[] =>
  values.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }

    const hour = readString(value, ["Hour", "hour", "H", "h"]);
    const minutes = readMinutes(value);
    if (hour === undefined || minutes === undefined) {
      return [];
    }

    return [{ hour, minutes }];
  });

const readStopName = (record: UnknownRecord): string | undefined => {
  const stopNames = readValue(record, ["StopNames", "stopNames", "Names", "names"]);
  if (Array.isArray(stopNames)) {
    const names = stopNames
      .map((value) => (typeof value === "string" ? value.trim() : undefined))
      .filter((value): value is string => value !== undefined && value.length > 0);
    return names.length > 0 ? names.join(" / ") : undefined;
  }

  return readString(record, ["StopName", "stopName", "Name", "name"]);
};

const readMinutes = (record: UnknownRecord): string | undefined => {
  const value = readValue(record, ["Minutes", "minutes", "M", "m"]);
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" || typeof item === "number" ? String(item).trim() : undefined))
      .filter((item): item is string => item !== undefined && item.length > 0)
      .join(" ");
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }

  return undefined;
};

const findRecordWithAnyKey = (value: unknown, keys: readonly string[], depth = 0): UnknownRecord | undefined => {
  if (depth > 6) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecordWithAnyKey(item, keys, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (keys.some((key) => Object.hasOwn(value, key))) {
    return value;
  }

  for (const child of Object.values(value)) {
    const found = findRecordWithAnyKey(child, keys, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};

const readArray = (record: UnknownRecord, keys: readonly string[]): readonly unknown[] => {
  const value = readValue(record, keys);
  return Array.isArray(value) ? value : [];
};

const readStringArray = (record: UnknownRecord, keys: readonly string[]): readonly string[] => {
  const value = readValue(record, keys);
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" || typeof item === "number" ? String(item).trim() : undefined))
    .filter((item): item is string => item !== undefined && item.length > 0);
};

const readNumber = (record: UnknownRecord, keys: readonly string[]): number | undefined => {
  const value = readValue(record, keys);
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string") {
    const normalized = Number.parseFloat(value.replace(",", "."));
    return Number.isFinite(normalized) ? normalized : undefined;
  }

  return undefined;
};

const readString = (record: UnknownRecord, keys: readonly string[]): string | undefined => {
  const value = readValue(record, keys);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
};

const readValue = (record: UnknownRecord, keys: readonly string[]): unknown => {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }

  return undefined;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
