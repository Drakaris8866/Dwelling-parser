import type { Coordinates } from "../domain/geo.js";

const EARTH_RADIUS_METERS = 6_371_000;
const WALKING_SPEED_KMH = 4.8;
const WALKING_CIRCUITY_FACTOR = 1.25;

const degreesToRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export const haversineMeters = (from: Coordinates, to: Coordinates): number => {
  const deltaLat = degreesToRadians(to.latitude - from.latitude);
  const deltaLon = degreesToRadians(to.longitude - from.longitude);
  const fromLat = degreesToRadians(from.latitude);
  const toLat = degreesToRadians(to.latitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
};

export const estimateTransitMinutes = (straightLineMeters: number): number => {
  const distanceKm = straightLineMeters / 1000;
  return Math.ceil((distanceKm / 18) * 60 + 4 - 1e-9);
};

export const estimateWalkingMinutes = (straightLineMeters: number): number => {
  const adjustedDistanceKm = (straightLineMeters / 1000) * WALKING_CIRCUITY_FACTOR;
  return Math.ceil((adjustedDistanceKm / WALKING_SPEED_KMH) * 60 - 1e-9);
};
