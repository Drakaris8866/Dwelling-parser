export type TransportType = "bus" | "trolleybus" | "tram";

export type RouteDirection = "A" | "B";

export type MinsktransPoint = {
  readonly latitude: number;
  readonly longitude: number;
};

export type MinsktransStop = {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
};

export type MinsktransRoute = {
  readonly routeNumber: string;
  readonly transportType: TransportType;
  readonly pointsA: readonly MinsktransPoint[];
  readonly pointsB: readonly MinsktransPoint[];
  readonly stopsA: readonly MinsktransStop[];
  readonly stopsB: readonly MinsktransStop[];
};

export type MinsktransHourLine = {
  readonly hour: string;
  readonly minutes: string;
};

export type MinsktransScheduleVariant = {
  readonly daysOfWeekMask: number;
  readonly hourLines: readonly MinsktransHourLine[];
};

export type MinsktransSchedule = {
  readonly variants: readonly MinsktransScheduleVariant[];
};

export type GtfsStopRow = {
  readonly stop_id: string;
  readonly stop_name: string;
  readonly stop_lat: string;
  readonly stop_lon: string;
};

export type GtfsRouteRow = {
  readonly route_id: string;
  readonly agency_id: string;
  readonly route_short_name: string;
  readonly route_long_name: string;
  readonly route_type: string;
};

export type GtfsAgencyRow = {
  readonly agency_id: string;
  readonly agency_name: string;
  readonly agency_url: string;
  readonly agency_timezone: string;
  readonly agency_lang: string;
};

export type GtfsTripRow = {
  readonly route_id: string;
  readonly service_id: string;
  readonly trip_id: string;
  readonly trip_headsign: string;
  readonly direction_id: string;
  readonly shape_id: string;
};

export type GtfsStopTimeRow = {
  readonly trip_id: string;
  readonly arrival_time: string;
  readonly departure_time: string;
  readonly stop_id: string;
  readonly stop_sequence: string;
};

export type GtfsCalendarRow = {
  readonly service_id: string;
  readonly monday: string;
  readonly tuesday: string;
  readonly wednesday: string;
  readonly thursday: string;
  readonly friday: string;
  readonly saturday: string;
  readonly sunday: string;
  readonly start_date: string;
  readonly end_date: string;
};

export type GtfsShapeRow = {
  readonly shape_id: string;
  readonly shape_pt_lat: string;
  readonly shape_pt_lon: string;
  readonly shape_pt_sequence: string;
};

export type GtfsFeed = {
  readonly agencies: readonly GtfsAgencyRow[];
  readonly stops: readonly GtfsStopRow[];
  readonly routes: readonly GtfsRouteRow[];
  readonly trips: readonly GtfsTripRow[];
  readonly stopTimes: readonly GtfsStopTimeRow[];
  readonly calendars: readonly GtfsCalendarRow[];
  readonly shapes: readonly GtfsShapeRow[];
};
