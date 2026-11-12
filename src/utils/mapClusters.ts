import type { MapResult } from "../contracts/catalog.js";
export type MapInput = { readonly propertyId: string; readonly latitude: number; readonly longitude: number; readonly price: number };
export const clusterMapPoints = (rows: readonly MapInput[], zoom: number): MapResult["points"] => {
  const size = 360 / 2 ** zoom * 50 / 256;
  const groups = new Map<string, MapInput[]>();
  for (const row of rows) {
    const key = `${Math.floor(row.latitude / (size * 0.6))}:${Math.floor(row.longitude / size)}`;
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({ id: key, propertyId: group.length === 1 ? group[0]!.propertyId : null,
    latitude: group.reduce((n, p) => n + p.latitude, 0) / group.length, longitude: group.reduce((n, p) => n + p.longitude, 0) / group.length,
    count: group.length, minPrice: Math.min(...group.map((p) => p.price)),
    bounds: { south: Math.min(...group.map((p) => p.latitude)), north: Math.max(...group.map((p) => p.latitude)), west: Math.min(...group.map((p) => p.longitude)), east: Math.max(...group.map((p) => p.longitude)) }
  }));
};
