import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { ZipArchive } from "archiver";
import pino from "pino";

type GtfsFilename =
  | "agency.txt"
  | "calendar.txt"
  | "routes.txt"
  | "shapes.txt"
  | "stops.txt"
  | "stop_times.txt"
  | "trips.txt";

type DeduplicationResult = {
  readonly filename: string;
  readonly keptRows: number;
  readonly duplicateRows: number;
};

const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: {
    service: "gtfs-zipper"
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

const gtfsOutDir = path.resolve("gtfs-out");
const otpDataDir = path.resolve("otp-data");
const zipPath = path.join(otpDataDir, "gtfs.zip");

const main = async (): Promise<void> => {
  await mkdir(otpDataDir, { recursive: true });

  const filenames = (await readdir(gtfsOutDir))
    .filter((filename): filename is GtfsFilename => isGtfsFilename(filename))
    .sort((left, right) => left.localeCompare(right));

  if (filenames.length === 0) {
    throw new Error(`No GTFS .txt files found in ${gtfsOutDir}`);
  }

  const results: DeduplicationResult[] = [];
  for (const filename of filenames) {
    results.push(await deduplicateGtfsFile(filename));
  }

  logger.info({ results }, "GTFS files deduplicated");

  await archiveGtfsFiles(filenames);
  const zipStat = await stat(zipPath);
  logger.info({ zipPath, files: filenames.length, bytes: zipStat.size }, "GTFS zip written");
};

const deduplicateGtfsFile = async (filename: GtfsFilename): Promise<DeduplicationResult> => {
  const filePath = path.join(gtfsOutDir, filename);
  const tempPath = path.join(gtfsOutDir, `${filename}.dedupe.tmp`);
  const keyColumns = keyColumnsFor(filename);
  const seenKeys = new Set<string>();
  let keptRows = 0;
  let duplicateRows = 0;
  let header: readonly string[] | undefined;
  let keyColumnIndexes: readonly number[] | undefined;

  const input = createReadStream(filePath, { encoding: "utf8" });
  const output = createWriteStream(tempPath, { encoding: "utf8" });
  const lines = readline.createInterface({
    input,
    crlfDelay: Infinity
  });

  try {
    for await (const line of lines) {
      if (header === undefined) {
        header = parseCsvLine(line);
        keyColumnIndexes = keyColumns.map((column) => {
          const index = header?.indexOf(column) ?? -1;
          if (index < 0) {
            throw new Error(`${filename} is missing required key column: ${column}`);
          }

          return index;
        });
        output.write(`${line}\n`);
        continue;
      }

      if (line.length === 0) {
        continue;
      }

      if (keyColumnIndexes === undefined) {
        throw new Error(`Key columns were not initialized for ${filename}`);
      }

      const row = parseCsvLine(line);
      const key = buildKey(row, keyColumnIndexes);
      if (seenKeys.has(key)) {
        duplicateRows += 1;
        continue;
      }

      seenKeys.add(key);
      keptRows += 1;
      output.write(`${line}\n`);
    }
  } finally {
    lines.close();
  }

  await closeWritable(output);
  await rename(tempPath, filePath);

  return {
    filename,
    keptRows,
    duplicateRows
  };
};

const archiveGtfsFiles = async (filenames: readonly GtfsFilename[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = new ZipArchive({
      zlib: { level: 9 }
    });

    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);

    for (const filename of filenames) {
      archive.file(path.join(gtfsOutDir, filename), { name: filename });
    }

    void archive.finalize();
  });

const closeWritable = async (stream: NodeJS.WritableStream): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
    stream.end();
  });

const keyColumnsFor = (filename: GtfsFilename): readonly string[] => {
  switch (filename) {
    case "agency.txt":
      return ["agency_id"];
    case "calendar.txt":
      return ["service_id"];
    case "routes.txt":
      return ["route_id"];
    case "shapes.txt":
      return ["shape_id", "shape_pt_sequence"];
    case "stops.txt":
      return ["stop_id"];
    case "stop_times.txt":
      return ["trip_id", "stop_sequence"];
    case "trips.txt":
      return ["trip_id"];
  }
};

const buildKey = (row: readonly string[], indexes: readonly number[]): string =>
  indexes.map((index) => row[index] ?? "").join("\u001f");

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

const isGtfsFilename = (filename: string): filename is GtfsFilename =>
  filename === "agency.txt" ||
  filename === "calendar.txt" ||
  filename === "routes.txt" ||
  filename === "shapes.txt" ||
  filename === "stops.txt" ||
  filename === "stop_times.txt" ||
  filename === "trips.txt";

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

main().catch((error: unknown) => {
  void cleanupTempFiles().finally(() => {
    logger.error({ err: serializeError(error) }, "Failed to clean and zip GTFS files");
    process.exitCode = 1;
  });
});

const cleanupTempFiles = async (): Promise<void> => {
  const filenames = await readdir(gtfsOutDir);
  await Promise.all(
    filenames
      .filter((filename) => filename.endsWith(".dedupe.tmp"))
      .map((filename) => rm(path.join(gtfsOutDir, filename), { force: true }))
  );
};
