import type { Logger } from "../infrastructure/logger.js";
import type {
  GtfsAgencyRow,
  GtfsCalendarRow,
  GtfsFeed,
  GtfsRouteRow,
  GtfsShapeRow,
  GtfsStopRow,
  GtfsStopTimeRow,
  GtfsTripRow,
  MinsktransPoint,
  MinsktransRoute,
  MinsktransSchedule,
  MinsktransStop,
  RouteDirection,
  TransportType
} from "./types.js";

export type StopSchedule = {
  readonly stop: MinsktransStop;
  readonly schedule: MinsktransSchedule;
};

export type RouteSchedules = {
  readonly directionA: readonly StopSchedule[];
  readonly directionB: readonly StopSchedule[];
};

export type FeedBuildInput = {
  readonly routes: readonly MinsktransRoute[];
  readonly schedulesByRouteId: ReadonlyMap<string, RouteSchedules>;
  readonly serviceStartDate: Date;
  readonly logger: Logger;
};

type DepartureGroup = {
  readonly mask: number;
  readonly times: readonly string[];
};

const AGENCY_ID = "minsktrans";

export const routeIdFor = (transportType: TransportType, routeNumber: string): string =>
  `${transportType}_${sanitizeIdPart(routeNumber)}`;

export const shapeIdFor = (routeId: string, direction: RouteDirection): string => `${routeId}_${direction}`;

export const serviceIdFor = (daysOfWeekMask: number): string => `mask_${daysOfWeekMask}`;

export const tripIdFor = (
  routeId: string,
  direction: RouteDirection,
  daysOfWeekMask: number,
  tripIndex: number
): string => `${routeId}_${direction}_${serviceIdFor(daysOfWeekMask)}_${tripIndex + 1}`;

export const calendarRowForMask = (daysOfWeekMask: number, startDate: Date): GtfsCalendarRow => {
  const endDate = new Date(startDate.getTime());
  endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);

  return {
    service_id: serviceIdFor(daysOfWeekMask),
    monday: bit(daysOfWeekMask, 1),
    tuesday: bit(daysOfWeekMask, 2),
    wednesday: bit(daysOfWeekMask, 4),
    thursday: bit(daysOfWeekMask, 8),
    friday: bit(daysOfWeekMask, 16),
    saturday: bit(daysOfWeekMask, 32),
    sunday: bit(daysOfWeekMask, 64),
    start_date: formatGtfsDate(startDate),
    end_date: formatGtfsDate(endDate)
  };
};

export const parseHourLines = (
  hourLines: readonly { readonly hour: string; readonly minutes: string }[]
): readonly string[] => {
  const times: string[] = [];
  let previousRawHour: number | undefined;
  let dayOffset = 0;

  for (const line of hourLines) {
    const rawHour = Number.parseInt(line.hour.trim(), 10);
    if (!Number.isInteger(rawHour) || rawHour < 0 || rawHour > 23) {
      continue;
    }

    if (previousRawHour !== undefined && rawHour < previousRawHour) {
      dayOffset += 24;
    }

    const hour = rawHour + dayOffset;
    previousRawHour = rawHour;

    for (const token of line.minutes.split(/[\s,;]+/u)) {
      const trimmed = token.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const minute = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        continue;
      }

      times.push(`${pad2(hour)}:${pad2(minute)}:00`);
    }
  }

  return times;
};

export const buildGtfsFeed = (input: FeedBuildInput): GtfsFeed => {
  const stops = new Map<string, GtfsStopRow>();
  const routes: GtfsRouteRow[] = [];
  const trips: GtfsTripRow[] = [];
  const stopTimes: GtfsStopTimeRow[] = [];
  const calendars = new Map<string, GtfsCalendarRow>();
  const shapes: GtfsShapeRow[] = [];

  for (const route of input.routes) {
    const routeId = routeIdFor(route.transportType, route.routeNumber);
    routes.push(routeRow(route, routeId));
    addShapeRows(shapes, routeId, "A", route.pointsA);
    addShapeRows(shapes, routeId, "B", route.pointsB);
    addStopRows(stops, route.stopsA);
    addStopRows(stops, route.stopsB);

    const routeSchedules = input.schedulesByRouteId.get(routeId);
    if (routeSchedules === undefined) {
      input.logger.warn({ routeId }, "No schedules found for GTFS route");
      continue;
    }

    addTripsForDirection({
      route,
      routeId,
      direction: "A",
      stopSchedules: routeSchedules.directionA,
      trips,
      stopTimes,
      calendars,
      serviceStartDate: input.serviceStartDate,
      logger: input.logger
    });
    addTripsForDirection({
      route,
      routeId,
      direction: "B",
      stopSchedules: routeSchedules.directionB,
      trips,
      stopTimes,
      calendars,
      serviceStartDate: input.serviceStartDate,
      logger: input.logger
    });
  }

  return {
    agencies: [agencyRow()],
    stops: [...stops.values()].sort((left, right) => left.stop_id.localeCompare(right.stop_id)),
    routes: routes.sort((left, right) => left.route_id.localeCompare(right.route_id)),
    trips,
    stopTimes,
    calendars: [...calendars.values()].sort((left, right) => left.service_id.localeCompare(right.service_id)),
    shapes
  };
};

const addTripsForDirection = (params: {
  readonly route: MinsktransRoute;
  readonly routeId: string;
  readonly direction: RouteDirection;
  readonly stopSchedules: readonly StopSchedule[];
  readonly trips: GtfsTripRow[];
  readonly stopTimes: GtfsStopTimeRow[];
  readonly calendars: Map<string, GtfsCalendarRow>;
  readonly serviceStartDate: Date;
  readonly logger: Logger;
}): void => {
  const firstStopSchedule = params.stopSchedules[0];
  if (firstStopSchedule === undefined) {
    params.logger.warn({ routeId: params.routeId, direction: params.direction }, "Route direction has no stop schedules");
    return;
  }

  const firstStopGroups = departureGroups(firstStopSchedule.schedule);
  const groupsByStop = params.stopSchedules.map((stopSchedule) => ({
    stop: stopSchedule.stop,
    groups: new Map(departureGroups(stopSchedule.schedule).map((group) => [group.mask, group]))
  }));

  for (const firstStopGroup of firstStopGroups) {
    const serviceId = serviceIdFor(firstStopGroup.mask);
    if (!params.calendars.has(serviceId)) {
      params.calendars.set(serviceId, calendarRowForMask(firstStopGroup.mask, params.serviceStartDate));
    }

    for (const [tripIndex] of firstStopGroup.times.entries()) {
      const tripId = tripIdFor(params.routeId, params.direction, firstStopGroup.mask, tripIndex);
      params.trips.push({
        route_id: params.routeId,
        service_id: serviceId,
        trip_id: tripId,
        trip_headsign: headsignFor(params.stopSchedules),
        direction_id: params.direction === "A" ? "0" : "1",
        shape_id: shapeIdFor(params.routeId, params.direction)
      });

      for (const [stopIndex, stopGroup] of groupsByStop.entries()) {
        const group = stopGroup.groups.get(firstStopGroup.mask);
        const departureTime = group?.times[tripIndex];
        if (departureTime === undefined) {
          params.logger.warn(
            {
              routeId: params.routeId,
              direction: params.direction,
              stopId: stopGroup.stop.id,
              mask: firstStopGroup.mask,
              tripIndex
            },
            "Schedule departure is missing for stop; omitting stop_time row"
          );
          continue;
        }

        params.stopTimes.push({
          trip_id: tripId,
          arrival_time: departureTime,
          departure_time: departureTime,
          stop_id: stopGroup.stop.id,
          stop_sequence: String(stopIndex + 1)
        });
      }
    }
  }
};

const departureGroups = (schedule: MinsktransSchedule): readonly DepartureGroup[] =>
  schedule.variants
    .map((variant) => ({
      mask: variant.daysOfWeekMask,
      times: parseHourLines(variant.hourLines)
    }))
    .filter((group) => group.times.length > 0);

const routeRow = (route: MinsktransRoute, routeId: string): GtfsRouteRow => ({
  route_id: routeId,
  agency_id: AGENCY_ID,
  route_short_name: route.routeNumber,
  route_long_name: `${route.transportType} ${route.routeNumber}`,
  route_type: gtfsRouteType(route.transportType)
});

const agencyRow = (): GtfsAgencyRow => ({
  agency_id: AGENCY_ID,
  agency_name: "Minsktrans",
  agency_url: "https://minsktrans.by",
  agency_timezone: "Europe/Minsk",
  agency_lang: "ru"
});

const addStopRows = (target: Map<string, GtfsStopRow>, stops: readonly MinsktransStop[]): void => {
  for (const stop of stops) {
    if (!target.has(stop.id)) {
      target.set(stop.id, {
        stop_id: stop.id,
        stop_name: stop.name,
        stop_lat: formatCoordinate(stop.latitude),
        stop_lon: formatCoordinate(stop.longitude)
      });
    }
  }
};

const addShapeRows = (
  target: GtfsShapeRow[],
  routeId: string,
  direction: RouteDirection,
  points: readonly MinsktransPoint[]
): void => {
  const shapeId = shapeIdFor(routeId, direction);
  for (const [index, point] of points.entries()) {
    target.push({
      shape_id: shapeId,
      shape_pt_lat: formatCoordinate(point.latitude),
      shape_pt_lon: formatCoordinate(point.longitude),
      shape_pt_sequence: String(index + 1)
    });
  }
};

const headsignFor = (stopSchedules: readonly StopSchedule[]): string => {
  const lastStop = stopSchedules.at(-1)?.stop.name;
  return lastStop ?? "";
};

const gtfsRouteType = (transportType: TransportType): string => {
  switch (transportType) {
    case "bus":
      return "3";
    case "trolleybus":
      return "11";
    case "tram":
      return "0";
  }
};

const sanitizeIdPart = (value: string): string => value.trim().replaceAll(/\s+/gu, "_").replaceAll(/[^\p{L}\p{N}_-]/gu, "_");

const bit = (mask: number, flag: number): string => ((mask & flag) === flag ? "1" : "0");

const pad2 = (value: number): string => value.toString().padStart(2, "0");

const formatCoordinate = (value: number): string => value.toFixed(6);

const formatGtfsDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  return `${year}${month}${day}`;
};
