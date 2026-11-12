import axios from "axios";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "../infrastructure/logger.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { DEFAULT_SETTINGS, routingDataSchema, type CatalogSettings, type RoutingData, type RoutePlan } from "../contracts/catalog.js";
import { MINSK_METRO_STATIONS } from "../infrastructure/geo/minskMetroStations.js";
import { haversineMeters } from "../utils/geoMath.js";
import { routeSummary } from "../utils/listingFeatures.js";
import { toPrismaJson } from "../utils/json.js";
import { chooseCommute, COMMUTE_MODES, SURFACE_MODES, RAIL_MODES, hasTram, COMMUTE_VERSION, type CommuteMode } from "../domain/commutePolicy.js";

const legSchema = z.object({ mode: z.string(), route: z.string().nullable().optional(), duration: z.coerce.number().nonnegative(),
  distance: z.coerce.number().nonnegative().optional(), from: z.object({ name: z.string().optional() }).optional(), to: z.object({ name: z.string().optional() }).optional(),
  legGeometry: z.object({ points: z.string().min(1).max(200_000) }).nullish().catch(undefined) });
const itinerarySchema = z.object({ duration: z.coerce.number().nonnegative(), walkTime: z.number().nonnegative().optional(), waitingTime: z.number().nonnegative().optional(),
  startTime: z.number().optional(), endTime: z.number().optional(), transfers: z.number().int().nonnegative().optional(), legs: z.array(legSchema).min(1) });
const responseSchema = z.object({ plan: z.object({ itineraries: z.array(z.unknown()).default([]) }).nullish(), error: z.unknown().optional() });
type Itinerary = z.infer<typeof itinerarySchema>;
const TRANSIT = new Set(["BUS", "TRAM", "SUBWAY", "RAIL", "TROLLEYBUS", "FERRY", "TRANSIT", "CABLE_CAR", "GONDOLA", "FUNICULAR"]);
export const commuteDate = (now = new Date()): string => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Minsk", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const date = new Date(`${day}T12:00:00Z`);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};
export const selectItinerary = (items: readonly Itinerary[], transit: boolean): Itinerary | undefined => {
  const candidates = transit ? items.filter((i) => i.legs.some((l) => TRANSIT.has(l.mode.toUpperCase()))) : items.filter((i) => i.legs.every((l) => l.mode.toUpperCase() === "WALK"));
  return [...(candidates.length ? candidates : items.filter((i) => i.legs.every((l) => l.mode.toUpperCase() === "WALK")))].sort((a, b) => a.duration - b.duration)[0];
};
export type TransitRouteResult = RoutePlan & { readonly summary: string };
type PlanResult = { readonly routes: RoutePlan[]; readonly status: "READY" | "NO_ROUTE" | "FAILED"; readonly error: string | null };

export class RoutingService {
  private gate: Promise<void> = Promise.resolve();
  private unavailableUntil = 0;
  constructor(private readonly logger: Logger, private readonly prisma?: PrismaClient, private readonly endpoint = process.env["OTP_PLAN_URL"] ?? "http://localhost:8080/otp/routers/default/plan") {}

  async getTransitTimeToTarget(lat: number, lon: number): Promise<number | null> {
    return (await this.getTransitRouteToTarget(lat, lon))?.durationMinutes ?? null;
  }
  async getTransitRouteToTarget(lat: number, lon: number, settings: CatalogSettings = DEFAULT_SETTINGS): Promise<TransitRouteResult | null> {
    const { target } = await this.commute(lat, lon, settings, commuteDate());
    return target ? { ...target, summary: routeSummary(target.legs) } : null;
  }
  async getRoutingData(lat: number, lon: number, settings: CatalogSettings): Promise<RoutingData> {
    const graph = await stat("otp-data/graph.obj").then((s) => s.mtimeMs).catch(() => 0);
    const date = commuteDate();
    const settingsKey = createHash("sha256").update(JSON.stringify({ version: COMMUTE_VERSION, lat: lat.toFixed(4), lon: lon.toFixed(4), target: [settings.targetLatitude, settings.targetLongitude], arriveBy: settings.arrivalTime, date, graph })).digest("hex");
    const cached = await this.prisma?.routeCache.findUnique({ where: { key: settingsKey } });
    if (cached && cached.expiresAt > new Date()) {
      const parsed = routingDataSchema.safeParse(cached.data);
      if (parsed.success && (parsed.data.target !== null || parsed.data.targetStatus !== undefined)) return parsed.data;
    }
    const commute = await this.commute(lat, lon, settings, date);
    const nearest = MINSK_METRO_STATIONS.map((station) => ({ station, distance: haversineMeters({ latitude: lat, longitude: lon }, station) })).sort((a, b) => a.distance - b.distance).slice(0, 3);
    let metro: RoutePlan | null = null, metroName: string | null = null;
    let metroFailed = false;
    for (const { station } of nearest) {
      const result = await this.plan(lat, lon, station.latitude, station.longitude, "WALK", settings, date);
      const route = result.routes.sort((a, b) => a.durationMinutes - b.durationMinutes)[0];
      if (result.status === "FAILED") metroFailed = true;
      if (route && (!metro || route.durationMinutes < metro.durationMinutes)) { metro = route; metroName = station.name; }
    }
    const data: RoutingData = { ...commute, metro, metroName, settingsKey, policyVersion: COMMUTE_VERSION,
      metroStatus: metro ? "READY" : metroFailed ? "FAILED" : "NO_ROUTE", metroError: metroFailed && !metro ? "Ошибка OTP при расчёте пути до метро" : null };
    const expiresAt = new Date(Date.now() + (commute.alternativesIncomplete || commute.targetStatus === "FAILED" || metroFailed ? 60_000 : commute.target && metro ? 7 * 86400_000 : 15 * 60_000));
    await this.prisma?.routeCache.upsert({ where: { key: settingsKey }, create: { key: settingsKey, data: toPrismaJson(data), expiresAt }, update: { data: toPrismaJson(data), expiresAt } });
    return data;
  }

  private async commute(lat: number, lon: number, settings: CatalogSettings, date: string): Promise<Pick<RoutingData, "target" | "alternatives" | "alternativesIncomplete" | "targetStatus" | "targetError">> {
    const query = (mode: CommuteMode): Promise<PlanResult> => this.plan(lat, lon, settings.targetLatitude, settings.targetLongitude, mode, settings, date, true);
    const all = await query(COMMUTE_MODES), surface = await query(SURFACE_MODES);
    const routes = [...all.routes, ...surface.routes];
    const rail = routes.some(hasTram) || (all.status === "FAILED" && surface.status === "FAILED") ? null : await query(RAIL_MODES);
    const candidates = [...routes, ...(rail?.routes ?? [])];
    const selected = chooseCommute(candidates, Date.parse(`${date}T${settings.arrivalTime}:00+03:00`));
    const incomplete = all.status === "FAILED" || surface.status === "FAILED" || rail?.status === "FAILED";
    if (!incomplete && !selected.target) {
      const walk = await query("WALK");
      return { target: walk.routes[0] ?? null, alternatives: [], alternativesIncomplete: false, targetStatus: walk.status, targetError: walk.error };
    }
    const target = incomplete && !candidates.some((route) => route.hasTransit) ? null : selected.target;
    return { ...selected, target, alternativesIncomplete: incomplete, targetStatus: target ? "READY" : "FAILED", targetError: target ? null : all.error ?? surface.error ?? rail?.error ?? null };
  }

  private async plan(lat: number, lon: number, toLat: number, toLon: number, mode: CommuteMode, settings: CatalogSettings, date: string, arriveBy = false): Promise<PlanResult> {
    if (Date.now() < this.unavailableUntil) return { routes: [], status: "FAILED", error: "OTP временно недоступен; расчёт будет повторён" };
    let release!: () => void;
    const previous = this.gate;
    this.gate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await axios.get<unknown>(this.endpoint, { params: {
            fromPlace: `${lat},${lon}`, toPlace: `${toLat},${toLon}`, mode, time: settings.arrivalTime,
            date, ...(arriveBy ? { arriveBy: true } : {}), numItineraries: mode === "WALK" ? 1 : 12, maxWalkDistance: 3000
          }, timeout: 12_000 });
          const data = responseSchema.parse(response.data);
          const raw = data.plan?.itineraries ?? [];
          const allowed = new Set(mode.split(","));
          const requested = Date.parse(`${date}T${settings.arrivalTime}:00+03:00`);
          const routes: RoutePlan[] = [];
          let parsedCount = 0;
          for (const entry of raw) {
          const parsed = itinerarySchema.safeParse(entry);
          if (!parsed.success) continue;
          const itinerary = parsed.data;
          if (itinerary.legs.some((leg) => !allowed.has(leg.mode.toUpperCase()))) continue;
          const start = itinerary.startTime, end = itinerary.endTime;
          if (arriveBy && (start === undefined || end === undefined || end < start)) continue;
          parsedCount++;
          if (arriveBy && end! > requested) continue;
          const legs = itinerary.legs.map((leg) => ({ mode: leg.mode.toUpperCase(), route: leg.route ?? null, durationMinutes: leg.duration / 60,
            from: leg.from?.name ?? null, to: leg.to?.name ?? null, distanceMeters: leg.distance ?? null,
            ...(leg.legGeometry ? { encodedPath: leg.legGeometry.points } : {}) }));
          const transitCount = legs.filter((l) => TRANSIT.has(l.mode)).length;
          routes.push({ durationMinutes: Math.round(arriveBy ? (end! - start!) / 60000 : itinerary.duration / 60),
            walkingMinutes: Math.round((itinerary.walkTime ?? itinerary.legs.filter((l) => l.mode.toUpperCase() === "WALK").reduce((n, l) => n + l.duration, 0)) / 60),
            waitingMinutes: Math.round((itinerary.waitingTime ?? 0) / 60),
            ...(arriveBy ? { arriveBy: true, arrivalBufferMinutes: Math.floor((requested - end!) / 60000) } : {}),
            transfers: itinerary.transfers ?? Math.max(0, transitCount - 1), hasTransit: transitCount > 0,
            ...(start !== undefined && end !== undefined ? { departureAt: new Date(start).toISOString(), arrivalAt: new Date(end).toISOString() } : {}),
            legs, date, time: settings.arrivalTime, provider: "otp", calculatedAt: new Date().toISOString(), destination: { latitude: toLat, longitude: toLon } });
          }
          if (routes.length) return { routes, status: "READY", error: null };
          this.logger.warn({ lat, lon, mode, returned: raw.length, error: data.error }, "OTP returned no usable itinerary");
          const malformed = raw.length > 0 && parsedCount === 0;
          return { routes: [], status: malformed ? "FAILED" : "NO_ROUTE", error: malformed ? "OTP вернул неполные данные маршрута" : null };
        } catch (error: unknown) {
          const retryable = axios.isAxiosError(error) && (!error.response || error.response.status >= 500 || error.response.status === 429);
          this.logger.warn({ err: error, lat, lon, mode, attempt }, "OTP routing request failed");
          if (!retryable || attempt === 2) {
            if (retryable) this.unavailableUntil = Date.now() + 60_000;
            return { routes: [], status: "FAILED", error: error instanceof z.ZodError ? "Некорректный ответ OTP" : "Ошибка соединения с OTP; расчёт будет повторён" };
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
      return { routes: [], status: "FAILED", error: "Не удалось рассчитать маршрут OTP" };
    } finally { release(); }
  }
}
