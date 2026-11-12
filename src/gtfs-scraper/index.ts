import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { MinsktransApiClient } from "./api.js";
import { GtfsCsvWriter } from "./csvWriter.js";
import { buildGtfsFeed, routeIdFor, type RouteSchedules, type StopSchedule } from "./generator.js";
import { generateMetroGtfs } from "./metroGenerator.js";
import type {
  GtfsCalendarRow,
  GtfsRouteRow,
  GtfsStopRow,
  MinsktransRoute,
  RouteDirection,
  TransportType
} from "./types.js";

type ProgressState = {
  readonly completedRouteIds: Set<string>;
  readonly isResume: boolean;
};

const outputDir = path.resolve("gtfs-out");
const progressPath = path.join(outputDir, "progress.json");
const transportTypes: readonly TransportType[] = ["bus", "trolleybus", "tram"];

const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: {
    service: "gtfs-scraper"
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

const main = async (): Promise<void> => {
  const api = new MinsktransApiClient(logger);
  const writer = new GtfsCsvWriter(outputDir);
  const progress = await loadProgress();

  if (!progress.isResume) {
    await writer.resetGtfsFiles();
  }

  const writtenStopIds = new Set(await writer.readColumnValues("stops.txt", "stop_id"));
  const writtenCalendarIds = new Set(await writer.readColumnValues("calendar.txt", "service_id"));
  const writtenRouteIds = new Set(await writer.readColumnValues("routes.txt", "route_id"));
  const writtenAgencyIds = new Set(await writer.readColumnValues("agency.txt", "agency_id"));

  await api.initSession();
  if (!writtenAgencyIds.has("minsktrans")) {
    await writer.appendGtfsRows("agency.txt", [
      {
        agency_id: "minsktrans",
        agency_name: "Minsktrans",
        agency_url: "https://minsktrans.by",
        agency_timezone: "Europe/Minsk",
        agency_lang: "ru"
      }
    ]);
    writtenAgencyIds.add("minsktrans");
  }

  for (const transportType of transportTypes) {
    const routeNumbers = await discoverRoutes(api, transportType);
    logger.info({ transportType, routeCount: routeNumbers.length }, "Minsktrans routes discovered");

    for (const routeNumber of routeNumbers) {
      const routeId = routeIdFor(transportType, routeNumber);
      if (progress.completedRouteIds.has(routeId)) {
        logger.info({ routeId }, "Skipping completed route from progress checkpoint");
        continue;
      }

      try {
        await processRoute({
          api,
          writer,
          transportType,
          routeNumber,
          completedRouteIds: progress.completedRouteIds,
          writtenStopIds,
          writtenCalendarIds,
          writtenRouteIds
        });
      } catch (error: unknown) {
        logger.error(
          {
            err: serializeError(error),
            routeId,
            routeNumber,
            transportType
          },
          "Failed to process Minsktrans route; continuing"
        );
      }
    }
  }

  await generateMetroGtfs(writer);
  logger.info({ completedRoutes: progress.completedRouteIds.size }, "GTFS generation complete!");
};

const discoverRoutes = async (
  api: MinsktransApiClient,
  transportType: TransportType
): Promise<readonly string[]> => {
  try {
    return await api.fetchAllRoutes(transportType);
  } catch (error: unknown) {
    logger.error({ err: serializeError(error), transportType }, "Failed to discover Minsktrans routes");
    return [];
  }
};

const processRoute = async (params: {
  readonly api: MinsktransApiClient;
  readonly writer: GtfsCsvWriter;
  readonly transportType: TransportType;
  readonly routeNumber: string;
  readonly completedRouteIds: Set<string>;
  readonly writtenStopIds: Set<string>;
  readonly writtenCalendarIds: Set<string>;
  readonly writtenRouteIds: Set<string>;
}): Promise<void> => {
  const routeId = routeIdFor(params.transportType, params.routeNumber);
  logger.info({ routeId, routeNumber: params.routeNumber, transportType: params.transportType }, "Fetching Minsktrans route");

  const route = await params.api.fetchRoute(params.routeNumber, params.transportType);
  const schedulesByRouteId = new Map<string, RouteSchedules>([
    [
      routeId,
      {
        directionA: await fetchDirectionSchedules(params.api, route, "A"),
        directionB: await fetchDirectionSchedules(params.api, route, "B")
      }
    ]
  ]);

  const feed = buildGtfsFeed({
    routes: [route],
    schedulesByRouteId,
    serviceStartDate: new Date(),
    logger
  });

  const newRoutes = filterNewRoutes(feed.routes, params.writtenRouteIds);
  const newStops = filterNewStops(feed.stops, params.writtenStopIds);
  const newCalendars = filterNewCalendars(feed.calendars, params.writtenCalendarIds);
  const trips = [...feed.trips];
  const stopTimes = [...feed.stopTimes];
  const shapes = [...feed.shapes];

  await params.writer.appendGtfsRows("routes.txt", newRoutes);
  await params.writer.appendGtfsRows("stops.txt", newStops);
  await params.writer.appendGtfsRows("calendar.txt", newCalendars);
  await params.writer.appendGtfsRows("trips.txt", trips);
  await params.writer.appendGtfsRows("stop_times.txt", stopTimes);
  await params.writer.appendGtfsRows("shapes.txt", shapes);

  params.completedRouteIds.add(routeId);
  await saveProgress(params.completedRouteIds);

  logger.info(
    {
      routeId,
      stops: newStops.length,
      trips: trips.length,
      stopTimes: stopTimes.length,
      calendars: newCalendars.length,
      shapes: shapes.length
    },
    "GTFS route appended and checkpointed"
  );

  newRoutes.length = 0;
  newStops.length = 0;
  newCalendars.length = 0;
  trips.length = 0;
  stopTimes.length = 0;
  shapes.length = 0;
  schedulesByRouteId.clear();
};

const fetchDirectionSchedules = async (
  api: MinsktransApiClient,
  route: MinsktransRoute,
  direction: RouteDirection
): Promise<readonly StopSchedule[]> => {
  const stops = direction === "A" ? route.stopsA : route.stopsB;
  const stopSchedules: StopSchedule[] = [];

  for (const stop of stops) {
    try {
      const schedule = await api.fetchSchedule(route.routeNumber, route.transportType, stop.id, scheduleDirectionParam(direction));
      stopSchedules.push({ stop, schedule });
    } catch (error: unknown) {
      logger.warn(
        {
          err: serializeError(error),
          routeNumber: route.routeNumber,
          transportType: route.transportType,
          stopId: stop.id,
          direction
        },
        "Failed to fetch stop schedule; continuing"
      );
    }
  }

  return stopSchedules;
};

const filterNewRoutes = (routes: readonly GtfsRouteRow[], writtenRouteIds: Set<string>): GtfsRouteRow[] =>
  routes.filter((route) => {
    if (writtenRouteIds.has(route.route_id)) {
      return false;
    }

    writtenRouteIds.add(route.route_id);
    return true;
  });

const filterNewStops = (stops: readonly GtfsStopRow[], writtenStopIds: Set<string>): GtfsStopRow[] =>
  stops.filter((stop) => {
    if (writtenStopIds.has(stop.stop_id)) {
      return false;
    }

    writtenStopIds.add(stop.stop_id);
    return true;
  });

const filterNewCalendars = (
  calendars: readonly GtfsCalendarRow[],
  writtenCalendarIds: Set<string>
): GtfsCalendarRow[] =>
  calendars.filter((calendar) => {
    if (writtenCalendarIds.has(calendar.service_id)) {
      return false;
    }

    writtenCalendarIds.add(calendar.service_id);
    return true;
  });

const loadProgress = async (): Promise<ProgressState> => {
  try {
    const content = await readFile(progressPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error("progress.json must contain a JSON string array");
    }

    return {
      completedRouteIds: new Set(parsed),
      isResume: true
    };
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        completedRouteIds: new Set(),
        isResume: false
      };
    }

    throw error;
  }
};

const saveProgress = async (completedRouteIds: ReadonlySet<string>): Promise<void> => {
  await mkdir(outputDir, { recursive: true });
  await writeFile(progressPath, `${JSON.stringify([...completedRouteIds].sort(), null, 2)}\n`, "utf8");
};

const scheduleDirectionParam = (direction: RouteDirection): string => (direction === "A" ? "0" : "1");

const serializeError = (error: unknown): Readonly<Record<string, unknown>> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return { value: String(error) };
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && "code" in error;

main().catch((error: unknown) => {
  logger.error({ err: serializeError(error) }, "GTFS scraper failed");
  process.exitCode = 1;
});
