import type { RoutePlan, RoutingData } from "../contracts/catalog.js";

export const COMMUTE_VERSION = 4;
export const COMMUTE_MODES = "WALK,BUS,TRAM,TROLLEYBUS,SUBWAY";
export const SURFACE_MODES = "WALK,BUS,TRAM,TROLLEYBUS";
export const RAIL_MODES = "WALK,TRAM,SUBWAY";
export type CommuteMode = typeof COMMUTE_MODES | typeof SURFACE_MODES | typeof RAIL_MODES | "WALK";
const signature = (route: RoutePlan): string => JSON.stringify([route.departureAt, route.arrivalAt, route.legs.map((leg) => [leg.mode, leg.route, leg.from, leg.to, leg.encodedPath])]);
const departure = (route: RoutePlan): number => Date.parse(route.departureAt ?? "");
const arrival = (route: RoutePlan): number => Date.parse(route.arrivalAt ?? "");
const walk = (route: RoutePlan): number => route.legs.filter((leg) => leg.mode === "WALK").reduce((minutes, leg) => minutes + leg.durationMinutes, 0);
export const hasTram = (route: RoutePlan): boolean => route.legs.some((leg) => leg.mode === "TRAM");

export const chooseCommute = (routes: readonly RoutePlan[], deadline: number): Pick<RoutingData, "target" | "alternatives"> => {
  const ordered = routes.filter((route) => departure(route) <= arrival(route) && arrival(route) <= deadline)
    .sort((a, b) => departure(b) - departure(a) || walk(a) - walk(b) || a.transfers - b.transfers || arrival(a) - arrival(b));
  const target = ordered[0];
  if (!target) return { target: null, alternatives: [] };
  const tram = ordered.find(hasTram);
  const ground = ordered.find((route) => route.hasTransit && !route.legs.some((leg) => leg.mode === "SUBWAY"));
  const fastest = [...ordered].sort((a, b) => (arrival(a) - departure(a)) - (arrival(b) - departure(b)))[0];
  const alternatives: NonNullable<RoutingData["alternatives"]> = [];
  const seen = new Set([signature(target)]);
  for (const [kind, route] of [["tram", tram], ["surface", ground], ["fastest", fastest]] as const) {
    if (!route || seen.has(signature(route))) continue;
    seen.add(signature(route));
    alternatives.push({ kind, route });
  }
  return { target, alternatives };
};
