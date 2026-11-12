import type { GtfsCsvWriter } from "./csvWriter.js";
import type {
  GtfsAgencyRow,
  GtfsCalendarRow,
  GtfsRouteRow,
  GtfsShapeRow,
  GtfsStopRow,
  GtfsStopTimeRow,
  GtfsTripRow
} from "./types.js";

type MetroStation = {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
};

type MetroLine = {
  readonly routeId: string;
  readonly shortName: string;
  readonly longName: string;
  readonly stations: readonly MetroStation[];
};

type MetroRows = {
  readonly agencies: readonly GtfsAgencyRow[];
  readonly calendars: readonly GtfsCalendarRow[];
  readonly routes: readonly GtfsRouteRow[];
  readonly stops: readonly GtfsStopRow[];
  readonly trips: readonly GtfsTripRow[];
  readonly stopTimes: readonly GtfsStopTimeRow[];
  readonly shapes: readonly GtfsShapeRow[];
};

const METRO_AGENCY_ID = "minsk_metro";
const METRO_SERVICE_ID = "metro_daily";
const FIRST_DEPARTURE_MINUTES = 5 * 60 + 30;
const LAST_DEPARTURE_MINUTES = 25 * 60;
const HEADWAY_MINUTES = 5;
const STATION_TRAVEL_MINUTES = 2;

export const generateMetroGtfs = async (writer: GtfsCsvWriter): Promise<void> => {
  const existingAgencyIds = await writer.readColumnValues("agency.txt", "agency_id");
  const existingServiceIds = await writer.readColumnValues("calendar.txt", "service_id");
  const existingRouteIds = await writer.readColumnValues("routes.txt", "route_id");
  const existingStopIds = await writer.readColumnValues("stops.txt", "stop_id");
  const existingTripIds = await writer.readColumnValues("trips.txt", "trip_id");
  const existingShapeIds = await writer.readColumnValues("shapes.txt", "shape_id");

  const rows = buildMetroRows(new Date());

  await writer.appendGtfsRows(
    "agency.txt",
    rows.agencies.filter((agency) => !existingAgencyIds.has(agency.agency_id))
  );
  await writer.appendGtfsRows(
    "calendar.txt",
    rows.calendars.filter((calendar) => !existingServiceIds.has(calendar.service_id))
  );
  await writer.appendGtfsRows(
    "routes.txt",
    rows.routes.filter((route) => !existingRouteIds.has(route.route_id))
  );
  await writer.appendGtfsRows(
    "stops.txt",
    rows.stops.filter((stop) => !existingStopIds.has(stop.stop_id))
  );
  await writer.appendGtfsRows(
    "trips.txt",
    rows.trips.filter((trip) => !existingTripIds.has(trip.trip_id))
  );
  await writer.appendGtfsRows(
    "stop_times.txt",
    rows.stopTimes.filter((stopTime) => !existingTripIds.has(stopTime.trip_id))
  );
  await writer.appendGtfsRows(
    "shapes.txt",
    rows.shapes.filter((shape) => !existingShapeIds.has(shape.shape_id))
  );
};

export const buildMetroRows = (startDate: Date): MetroRows => {
  const stops = new Map<string, GtfsStopRow>();
  const routes: GtfsRouteRow[] = [];
  const trips: GtfsTripRow[] = [];
  const stopTimes: GtfsStopTimeRow[] = [];
  const shapes: GtfsShapeRow[] = [];

  for (const line of metroLines) {
    routes.push({
      route_id: line.routeId,
      agency_id: METRO_AGENCY_ID,
      route_short_name: line.shortName,
      route_long_name: line.longName,
      route_type: "1"
    });

    for (const station of line.stations) {
      stops.set(station.id, {
        stop_id: station.id,
        stop_name: station.name,
        stop_lat: coordinate(station.latitude),
        stop_lon: coordinate(station.longitude)
      });
    }

    addShapeRows(shapes, `${line.routeId}_A`, line.stations);
    addShapeRows(shapes, `${line.routeId}_B`, [...line.stations].reverse());
    addTripsForDirection({ line, directionId: "0", directionSuffix: "A", stations: line.stations, trips, stopTimes });
    addTripsForDirection({
      line,
      directionId: "1",
      directionSuffix: "B",
      stations: [...line.stations].reverse(),
      trips,
      stopTimes
    });
  }

  return {
    agencies: [
      {
        agency_id: METRO_AGENCY_ID,
        agency_name: "Minsk Metro",
        agency_url: "https://minsktrans.by",
        agency_timezone: "Europe/Minsk",
        agency_lang: "ru"
      }
    ],
    calendars: [dailyCalendar(startDate)],
    routes,
    stops: [...stops.values()].sort((left, right) => left.stop_id.localeCompare(right.stop_id)),
    trips,
    stopTimes,
    shapes
  };
};

const addTripsForDirection = (params: {
  readonly line: MetroLine;
  readonly directionId: string;
  readonly directionSuffix: "A" | "B";
  readonly stations: readonly MetroStation[];
  readonly trips: GtfsTripRow[];
  readonly stopTimes: GtfsStopTimeRow[];
}): void => {
  const headsign = params.stations.at(-1)?.name ?? "";
  let tripIndex = 1;

  for (
    let departureMinutes = FIRST_DEPARTURE_MINUTES;
    departureMinutes <= LAST_DEPARTURE_MINUTES;
    departureMinutes += HEADWAY_MINUTES
  ) {
    const tripId = `${params.line.routeId}_${params.directionSuffix}_${tripIndex.toString().padStart(3, "0")}`;
    params.trips.push({
      route_id: params.line.routeId,
      service_id: METRO_SERVICE_ID,
      trip_id: tripId,
      trip_headsign: headsign,
      direction_id: params.directionId,
      shape_id: `${params.line.routeId}_${params.directionSuffix}`
    });

    for (const [stationIndex, station] of params.stations.entries()) {
      const time = formatGtfsTime(departureMinutes + stationIndex * STATION_TRAVEL_MINUTES);
      params.stopTimes.push({
        trip_id: tripId,
        arrival_time: time,
        departure_time: time,
        stop_id: station.id,
        stop_sequence: String(stationIndex + 1)
      });
    }

    tripIndex += 1;
  }
};

const addShapeRows = (target: GtfsShapeRow[], shapeId: string, stations: readonly MetroStation[]): void => {
  for (const [index, station] of stations.entries()) {
    target.push({
      shape_id: shapeId,
      shape_pt_lat: coordinate(station.latitude),
      shape_pt_lon: coordinate(station.longitude),
      shape_pt_sequence: String(index + 1)
    });
  }
};

const dailyCalendar = (startDate: Date): GtfsCalendarRow => {
  const endDate = new Date(startDate.getTime());
  endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);

  return {
    service_id: METRO_SERVICE_ID,
    monday: "1",
    tuesday: "1",
    wednesday: "1",
    thursday: "1",
    friday: "1",
    saturday: "1",
    sunday: "1",
    start_date: formatGtfsDate(startDate),
    end_date: formatGtfsDate(endDate)
  };
};

const formatGtfsTime = (minutesSinceMidnight: number): string => {
  const hours = Math.floor(minutesSinceMidnight / 60);
  const minutes = minutesSinceMidnight % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:00`;
};

const formatGtfsDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
};

const coordinate = (value: number): string => value.toFixed(6);

const metroLines: readonly MetroLine[] = [
  {
    routeId: "metro_blue",
    shortName: "M1",
    longName: "Moskovskaya line",
    stations: [
      { id: "metro_stop_malinovka", name: "Malinovka", latitude: 53.8492, longitude: 27.4742 },
      { id: "metro_stop_piatroushchyna", name: "Piatroushchyna", latitude: 53.8644, longitude: 27.4851 },
      { id: "metro_stop_mikhalova", name: "Mikhalova", latitude: 53.8764, longitude: 27.4971 },
      { id: "metro_stop_hrushauka", name: "Hrushauka", latitude: 53.8869, longitude: 27.5147 },
      { id: "metro_stop_instytut_kultury", name: "Instytut Kultury", latitude: 53.8854, longitude: 27.5393 },
      { id: "metro_stop_ploshcha_lenina", name: "Ploshcha Lenina", latitude: 53.8926, longitude: 27.5507 },
      { id: "metro_stop_kastrychnitskaya", name: "Kastrychnitskaya", latitude: 53.9022, longitude: 27.5619 },
      { id: "metro_stop_ploshcha_pieramohi", name: "Ploshcha Pieramohi", latitude: 53.9087, longitude: 27.5756 },
      { id: "metro_stop_ploshcha_yakuba_kolasa", name: "Ploshcha Yakuba Kolasa", latitude: 53.9156, longitude: 27.5846 },
      { id: "metro_stop_akademiya_navuk", name: "Akademiya Navuk", latitude: 53.9218, longitude: 27.5993 },
      { id: "metro_stop_park_chaliuskincau", name: "Park Chaliuskincau", latitude: 53.9241, longitude: 27.6138 },
      { id: "metro_stop_maskouskaya", name: "Maskouskaya", latitude: 53.9277, longitude: 27.6273 },
      { id: "metro_stop_uschod", name: "Uschod", latitude: 53.9344, longitude: 27.6517 },
      { id: "metro_stop_barysaucki_trakt", name: "Barysaucki Trakt", latitude: 53.9384, longitude: 27.6651 },
      { id: "metro_stop_uruchcha", name: "Uruchcha", latitude: 53.9456, longitude: 27.6879 }
    ]
  },
  {
    routeId: "metro_red",
    shortName: "M2",
    longName: "Avtozavodskaya line",
    stations: [
      { id: "metro_stop_kamiennaja_horka", name: "Kamiennaja Horka", latitude: 53.9067, longitude: 27.4371 },
      { id: "metro_stop_kuncauscyna", name: "Kuncauscyna", latitude: 53.906, longitude: 27.4536 },
      { id: "metro_stop_spartyunaja", name: "Spartyunaja", latitude: 53.9087, longitude: 27.4822 },
      { id: "metro_stop_pushkinskaya", name: "Pushkinskaya", latitude: 53.9097, longitude: 27.4966 },
      { id: "metro_stop_maladzyozhnaya", name: "Maladzyozhnaya", latitude: 53.9066, longitude: 27.5235 },
      { id: "metro_stop_frunzyenskaya", name: "Frunzyenskaya", latitude: 53.9051, longitude: 27.5391 },
      { id: "metro_stop_niamiha", name: "Niamiha", latitude: 53.9041, longitude: 27.5549 },
      { id: "metro_stop_kupalawskaya", name: "Kupalawskaya", latitude: 53.9022, longitude: 27.5619 },
      { id: "metro_stop_piershamayskaya", name: "Piershamayskaya", latitude: 53.8939, longitude: 27.5709 },
      { id: "metro_stop_pralietarskaya", name: "Pralietarskaya", latitude: 53.8895, longitude: 27.5853 },
      { id: "metro_stop_traktarny_zavod", name: "Traktarny Zavod", latitude: 53.8905, longitude: 27.6146 },
      { id: "metro_stop_partyzanskaya", name: "Partyzanskaya", latitude: 53.8757, longitude: 27.6292 },
      { id: "metro_stop_autazavodskaya", name: "Autazavodskaya", latitude: 53.8692, longitude: 27.6483 },
      { id: "metro_stop_mahilyowskaya", name: "Mahilyowskaya", latitude: 53.849, longitude: 27.6735 }
    ]
  },
  {
    routeId: "metro_green",
    shortName: "M3",
    longName: "Zelenoluzhskaya line",
    stations: [
      { id: "metro_stop_jubiliejnaja_ploshcha", name: "Jubiliejnaja Ploshcha", latitude: 53.9046, longitude: 27.5399 },
      {
        id: "metro_stop_ploshcha_francishka_bahushevicha",
        name: "Ploshcha Francishka Bahushevicha",
        latitude: 53.8992,
        longitude: 27.5422
      },
      { id: "metro_stop_vakzalnaja", name: "Vakzalnaja", latitude: 53.8915, longitude: 27.551 },
      { id: "metro_stop_kavalskaja_slabada", name: "Kavalskaja Slabada", latitude: 53.8796, longitude: 27.5529 },
      { id: "metro_stop_aeradromnaja", name: "Aeradromnaja", latitude: 53.8679, longitude: 27.5438 },
      { id: "metro_stop_niemarsanski_sad", name: "Niemarsanski Sad", latitude: 53.8562, longitude: 27.5367 },
      { id: "metro_stop_slucki_hasciniec", name: "Slucki Hasciniec", latitude: 53.8461, longitude: 27.5284 }
    ]
  }
];
