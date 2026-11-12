export type Coordinates = {
  readonly latitude: number;
  readonly longitude: number;
};

export type AccessMode = "walking" | "public-transit-estimate";

export type WalkingRoute = {
  readonly nearestMetro: string;
  readonly accessMode: AccessMode;
  readonly accessMinutes: number;
  readonly walkingMinutes: number;
  readonly walkingMeters: number;
  readonly straightLineMeters: number;
  readonly transitMinutes?: number | undefined;
  readonly provider: "osrm";
};

export type MetroStation = Coordinates & {
  readonly name: string;
};
