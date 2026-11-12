import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const coordinate = z.tuple([z.number(), z.number()]);
const polygon = z.array(z.array(coordinate));
const boundarySchema = z.array(z.object({ display_name: z.string(), osm_id: z.number(), geojson: z.discriminatedUnion("type", [
  z.object({ type: z.literal("Polygon"), coordinates: polygon }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(polygon) })
]) })).min(1);
type Ring = z.infer<typeof polygon>[number];
const insideRing = (lat: number, lon: number, ring: Ring): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > lat) !== (b[1] > lat) && lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};
const insidePolygon = (lat: number, lon: number, rings: Ring[]): boolean =>
  rings.length > 0 && insideRing(lat, lon, rings[0]!) && !rings.slice(1).some((ring) => insideRing(lat, lon, ring));
export class CollectionArea {
  private constructor(private readonly city: z.infer<typeof boundarySchema>, private readonly district: z.infer<typeof boundarySchema>, private readonly minskWorld: z.infer<typeof boundarySchema>) {}
  static async load(): Promise<CollectionArea> {
    const city = boundarySchema.parse(JSON.parse(await readFile(resolve("data/minsk-city-boundary.json"), "utf8")) as unknown);
    const district = boundarySchema.parse(JSON.parse(await readFile(resolve("data/minsk-district-boundary.json"), "utf8")) as unknown);
    const minskWorld = boundarySchema.parse(JSON.parse(await readFile(resolve("data/minsk-world-boundary.json"), "utf8")) as unknown);
    if (district[0]!.osm_id !== 59190) throw new Error("Unexpected Minsk district boundary identity");
    if (minskWorld[0]!.osm_id !== 20426320) throw new Error("Unexpected Minsk World boundary identity");
    return new CollectionArea(city, district, minskWorld);
  }
  private contains(boundaries: z.infer<typeof boundarySchema>, lat: number, lon: number): boolean {
    return boundaries.some(({ geojson }) => geojson.type === "Polygon" ? insidePolygon(lat, lon, geojson.coordinates) : geojson.coordinates.some((p) => insidePolygon(lat, lon, p)));
  }
  locate(lat: number, lon: number): "minsk" | "district" | "outside" {
    if (this.contains(this.city, lat, lon)) return "minsk";
    return this.contains(this.district, lat, lon) ? "district" : "outside";
  }
  isMinskWorld(lat: number, lon: number): boolean { return this.contains(this.minskWorld, lat, lon); }
  minskWorldBounds(): { south: number; north: number; west: number; east: number } {
    const points = this.minskWorld.flatMap(({ geojson }) => geojson.type === "Polygon" ? geojson.coordinates.flat() : geojson.coordinates.flat(2));
    return { south: Math.min(...points.map((p) => p[1])), north: Math.max(...points.map((p) => p[1])), west: Math.min(...points.map((p) => p[0])), east: Math.max(...points.map((p) => p[0])) };
  }
}
