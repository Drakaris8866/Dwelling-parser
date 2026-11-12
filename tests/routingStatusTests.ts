import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import pino from "pino";
import { RoutingService } from "../src/services/routingService.js";
import { DEFAULT_SETTINGS } from "../src/contracts/catalog.js";
import { chooseCommute, COMMUTE_MODES, RAIL_MODES, SURFACE_MODES } from "../src/domain/commutePolicy.js";
import type { RoutePlan } from "../src/contracts/catalog.js";

export const assertRoutingStatuses = async (): Promise<void> => {
  let outcome: "ready" | "empty" | "failed" | "late" = "ready";
  const requestedModes = new Set<string | null>();
  const points = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (outcome === "failed") { response.statusCode = 503; response.end("{}"); return; }
    const params = new URL(request.url ?? "/", "http://localhost").searchParams;
    const mode = params.get("mode"); requestedModes.add(mode);
    const walking = mode === "WALK";
    if (!walking) assert.equal(params.get("arriveBy"), "true");
    const requested = Date.parse(`${params.get("date")}T${params.get("time")}:00+03:00`);
    const legs = [{ mode: walking ? "WALK" : mode === RAIL_MODES ? "TRAM" : "BUS", duration: walking ? 480 : 1680, legGeometry: { points, length: 3 } }];
    const endTime = requested + (outcome === "late" ? 1000 : -180_000);
    const startTime = endTime - (walking ? 480_000 : mode === RAIL_MODES ? 1_980_000 : 1_800_000);
    response.end(JSON.stringify({ plan: { itineraries: outcome === "empty" ? [] : [{ duration: walking ? 480 : 1800, waitingTime: walking ? 0 : 120, startTime, endTime, legs }] } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/plan`, logger = pino({ enabled: false });
  try {
    const ready = await new RoutingService(logger, undefined, endpoint).getRoutingData(53.9, 27.5, DEFAULT_SETTINGS);
    assert.equal(ready.targetStatus, "READY"); assert.equal(ready.target?.durationMinutes, 30); assert.equal(ready.metroStatus, "READY");
    assert.equal(ready.target?.arrivalBufferMinutes, 3); assert.equal(ready.target?.waitingMinutes, 2);
    assert.ok(requestedModes.has(COMMUTE_MODES)); assert.ok(requestedModes.has(SURFACE_MODES)); assert.ok(requestedModes.has(RAIL_MODES));
    assert.equal(ready.alternatives?.find((entry) => entry.kind === "tram")?.route.legs[0]?.mode, "TRAM");
    assert.equal(ready.target?.legs[0]?.encodedPath, points);
    assert.deepEqual(ready.target?.destination, { latitude: DEFAULT_SETTINGS.targetLatitude, longitude: DEFAULT_SETTINGS.targetLongitude });
    const origin = ready.target!;
    const at = Date.parse(origin.arrivalAt!);
    const variant = (mode: string, leave: number, arrive: number, walk: number, transfers = 0): RoutePlan => ({ ...origin,
      departureAt: new Date(at - leave * 60000).toISOString(), arrivalAt: new Date(at + arrive * 60000).toISOString(), transfers,
      legs: [{ ...origin.legs[0]!, mode: "WALK", durationMinutes: walk }, { ...origin.legs[0]!, mode }] });
    const bus = variant("BUS", 25, 0, 8), trolley = variant("TROLLEYBUS", 25, 0, 7, 1), tram = variant("TRAM", 26, 0, 3), late = variant("SUBWAY", 15, 1, 1);
    assert.equal(chooseCommute([late, bus, trolley, tram], at).target, trolley);
    assert.equal(chooseCommute([late, bus, tram], at).alternatives?.[0]?.route, tram);
    assert.equal(chooseCommute([variant("BUS", 25, 0, 7), trolley], at).target?.transfers, 0);
    assert.equal(chooseCommute([late], at).target, null);
    outcome = "late";
    assert.equal((await new RoutingService(logger, undefined, endpoint).getRoutingData(53.9, 27.5, DEFAULT_SETTINGS)).targetStatus, "NO_ROUTE");
    outcome = "empty";
    const empty = await new RoutingService(logger, undefined, endpoint).getRoutingData(53.9, 27.5, DEFAULT_SETTINGS);
    assert.equal(empty.targetStatus, "NO_ROUTE"); assert.equal(empty.targetError, null);
    outcome = "failed";
    const failed = await new RoutingService(logger, undefined, endpoint).getRoutingData(53.9, 27.5, DEFAULT_SETTINGS);
    assert.equal(failed.targetStatus, "FAILED"); assert.ok(failed.targetError); assert.equal(failed.metroStatus, "FAILED");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
};
