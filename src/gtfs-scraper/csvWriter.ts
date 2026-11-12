import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GtfsCalendarRow,
  GtfsAgencyRow,
  GtfsFeed,
  GtfsRouteRow,
  GtfsShapeRow,
  GtfsStopRow,
  GtfsStopTimeRow,
  GtfsTripRow
} from "./types.js";

type CsvPrimitive = string | number | boolean | null | undefined;
type CsvRow = Readonly<Record<string, CsvPrimitive>>;
type GtfsFilename =
  | "agency.txt"
  | "stops.txt"
  | "routes.txt"
  | "trips.txt"
  | "stop_times.txt"
  | "calendar.txt"
  | "shapes.txt";

type GtfsRowByFilename = {
  readonly "agency.txt": GtfsAgencyRow;
  readonly "stops.txt": GtfsStopRow;
  readonly "routes.txt": GtfsRouteRow;
  readonly "trips.txt": GtfsTripRow;
  readonly "stop_times.txt": GtfsStopTimeRow;
  readonly "calendar.txt": GtfsCalendarRow;
  readonly "shapes.txt": GtfsShapeRow;
};

export const escapeCsvValue = (value: CsvPrimitive): string => {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);
  if (!/[",\r\n]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replaceAll('"', '""')}"`;
};

export const buildCsv = <T extends CsvRow>(headers: readonly (keyof T & string)[], rows: readonly T[]): string => {
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(","))
  ];

  return `${lines.join("\n")}\n`;
};

export class GtfsCsvWriter {
  constructor(private readonly outputDir = path.resolve("gtfs-out")) {}

  async write(feed: GtfsFeed): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });

    await writeFile(path.join(this.outputDir, "agency.txt"), buildCsv<GtfsAgencyRow>(agencyHeaders, feed.agencies), "utf8");
    await writeFile(path.join(this.outputDir, "stops.txt"), buildCsv<GtfsStopRow>(stopHeaders, feed.stops), "utf8");
    await writeFile(path.join(this.outputDir, "routes.txt"), buildCsv<GtfsRouteRow>(routeHeaders, feed.routes), "utf8");
    await writeFile(path.join(this.outputDir, "trips.txt"), buildCsv<GtfsTripRow>(tripHeaders, feed.trips), "utf8");
    await writeFile(
      path.join(this.outputDir, "stop_times.txt"),
      buildCsv<GtfsStopTimeRow>(stopTimeHeaders, feed.stopTimes),
      "utf8"
    );
    await writeFile(
      path.join(this.outputDir, "calendar.txt"),
      buildCsv<GtfsCalendarRow>(calendarHeaders, feed.calendars),
      "utf8"
    );
    await writeFile(path.join(this.outputDir, "shapes.txt"), buildCsv<GtfsShapeRow>(shapeHeaders, feed.shapes), "utf8");
  }

  async resetGtfsFiles(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });

    for (const filename of gtfsFilenames) {
      await rm(path.join(this.outputDir, filename), { force: true });
    }
  }

  async appendGtfsRows<TFilename extends GtfsFilename>(
    filename: TFilename,
    rows: readonly GtfsRowByFilename[TFilename][]
  ): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });

    const headers = headersFor(filename);
    const filePath = path.join(this.outputDir, filename);
    const needsHeader = await this.needsHeader(filePath);
    const content = buildCsvRows(headers, rows, needsHeader);

    if (content.length > 0) {
      await appendFile(filePath, content, "utf8");
    }
  }

  async readColumnValues(filename: GtfsFilename, columnName: string): Promise<ReadonlySet<string>> {
    const filePath = path.join(this.outputDir, filename);
    try {
      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/u).filter((line) => line.length > 0);
      const [headerLine, ...dataLines] = lines;
      if (headerLine === undefined) {
        return new Set();
      }

      const headers = parseCsvLine(headerLine);
      const columnIndex = headers.indexOf(columnName);
      if (columnIndex < 0) {
        return new Set();
      }

      return new Set(
        dataLines
          .map((line) => parseCsvLine(line)[columnIndex])
          .filter((value): value is string => value !== undefined && value.length > 0)
      );
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return new Set();
      }

      throw error;
    }
  }

  private async needsHeader(filePath: string): Promise<boolean> {
    try {
      const fileStat = await stat(filePath);
      return fileStat.size === 0;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return true;
      }

      throw error;
    }
  }
}

const buildCsvRows = (
  headers: readonly string[],
  rows: readonly CsvRow[],
  includeHeader: boolean
): string => {
  if (rows.length === 0 && !includeHeader) {
    return "";
  }

  const lines = [
    ...(includeHeader ? [headers.join(",")] : []),
    ...rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(","))
  ];

  return `${lines.join("\n")}\n`;
};

const stopHeaders = ["stop_id", "stop_name", "stop_lat", "stop_lon"] as const;
const agencyHeaders = ["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang"] as const;
const routeHeaders = ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"] as const;
const tripHeaders = ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"] as const;
const stopTimeHeaders = ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"] as const;
const calendarHeaders = [
  "service_id",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "start_date",
  "end_date"
] as const;
const shapeHeaders = ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"] as const;

const gtfsFilenames: readonly GtfsFilename[] = [
  "agency.txt",
  "stops.txt",
  "routes.txt",
  "trips.txt",
  "stop_times.txt",
  "calendar.txt",
  "shapes.txt"
];

const headersFor = (filename: GtfsFilename): readonly string[] => {
  switch (filename) {
    case "agency.txt":
      return agencyHeaders;
    case "stops.txt":
      return stopHeaders;
    case "routes.txt":
      return routeHeaders;
    case "trips.txt":
      return tripHeaders;
    case "stop_times.txt":
      return stopTimeHeaders;
    case "calendar.txt":
      return calendarHeaders;
    case "shapes.txt":
      return shapeHeaders;
  }
};

const parseCsvLine = (line: string): readonly string[] => {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && "code" in error;
