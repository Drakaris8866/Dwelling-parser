/**
 * Temporary debug script to diagnose routingStatusTests failure.
 * Delete after fix.
 */
import { createServer } from "node:http";
import { once } from "node:events";
import pino from "pino";
import { RoutingService } from "../src/services/routingService.js";
import { DEFAULT_SETTINGS } from "../src/contracts/catalog.js";
import { COMMUTE_MODES, RAIL_MODES, SURFACE_MODES } from "../src/domain/commutePolicy.js";

const points = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const requestLog: string[] = [];

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  const params = new URL(request.url ?? "/", "http://localhost").searchParams;
  const mode = params.get("mode");
  const date = params.get("date");
  const time = params.get("time");
  const arriveBy = params.get("arriveBy");
  const requested = Date.parse(`${date}T${time}:00+03:00`);
  const walking = mode === "WALK";
  const legs = [{ mode: walking ? "WALK" : mode === RAIL_MODES ? "TRAM" : "BUS", duration: walking ? 480 : 1680, legGeometry: { points, length: 3 } }];
  const endTime = requested - 180_000;
  const startTime = endTime - (walking ? 480_000 : mode === RAIL_MODES ? 1_980_000 : 1_800_000);
  const itinerary = { duration: walking ? 480 : 1800, waitingTime: walking ? 0 : 120, startTime, endTime, legs };
  requestLog.push(`mode=${mode} arriveBy=${arriveBy} date=${date} time=${time} end=${endTime} requested=${requested} end<req=${endTime < requested}`);
  response.end(JSON.stringify({ plan: { itineraries: [itinerary] } }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address() as { port: number };
const endpoint = `http://127.0.0.1:${address.port}/plan`;
const logger = pino({ level: "debug" });

console.log("endpoint:", endpoint);
console.log("DEFAULT_SETTINGS.arrivalTime:", DEFAULT_SETTINGS.arrivalTime);
console.log("DEFAULT_SETTINGS.targetLatitude:", DEFAULT_SETTINGS.targetLatitude);

const result = await new RoutingService(logger, undefined, endpoint).getRoutingData(53.9, 27.5, DEFAULT_SETTINGS);

console.log("\n=== RESULT ===");
console.log("targetStatus:", result.targetStatus);
console.log("target:", result.target ? `durationMinutes=${result.target.durationMinutes}` : null);
console.log("metroStatus:", result.metroStatus);
console.log("alternativesIncomplete:", result.alternativesIncomplete);

console.log("\n=== REQUESTS LOG ===");
for (const log of requestLog) console.log(log);

await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

