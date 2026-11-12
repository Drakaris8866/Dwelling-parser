import { z } from "zod";
import type { Coordinates } from "../../domain/geo.js";
import type { AppConfig } from "../../config/env.js";
import type { RetryHttpClient } from "../http/retryHttpClient.js";
import type { Logger } from "../logger.js";

export type OsrmRoute = {
  readonly distanceMeters: number;
  readonly durationMinutes: number;
};

const osrmResponseSchema = z.object({
  code: z.string(),
  routes: z.array(
    z.object({
      distance: z.number().nonnegative(),
      duration: z.number().nonnegative()
    })
  )
});

export class OsrmRouteClient {
  constructor(
    private readonly config: Pick<AppConfig, "osrmRouteUrl">,
    private readonly httpClient: RetryHttpClient,
    private readonly logger: Logger
  ) {}

  async walkingRoute(origin: Coordinates, destination: Coordinates): Promise<OsrmRoute | undefined> {
    try {
      const url = this.buildUrl(origin, destination);
      const response = await this.httpClient.json({ method: "GET", url, timeoutMs: 15_000, retries: 2 }, osrmResponseSchema);
      const route = response.routes[0];

      if (response.code !== "Ok" || route === undefined) {
        this.logger.warn({ responseCode: response.code, origin, destination }, "OSRM returned no walking route");
        return undefined;
      }

      return {
        distanceMeters: Math.round(route.distance),
        durationMinutes: Math.ceil(route.duration / 60)
      };
    } catch (error: unknown) {
      this.logger.warn({ err: error, origin, destination }, "OSRM walking route request failed");
      return undefined;
    }
  }

  private buildUrl(origin: Coordinates, destination: Coordinates): string {
    const base = this.config.osrmRouteUrl.replace(/\/$/, "");
    const coordinates = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const url = new URL(`${base}/${coordinates}`);
    url.searchParams.set("overview", "false");
    url.searchParams.set("steps", "false");
    url.searchParams.set("alternatives", "false");
    return url.toString();
  }
}
