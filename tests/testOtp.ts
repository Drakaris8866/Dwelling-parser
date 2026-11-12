import axios, { AxiosError } from "axios";
import { z } from "zod";

const OTP_PLAN_URL = "http://localhost:8080/otp/routers/default/plan";
const PEAK_COMMUTE_TIME = "08:30";

const otpLegSchema = z
  .object({
    mode: z.string(),
    route: z.string().nullable().optional(),
    duration: z.coerce.number().nonnegative()
  })
  .passthrough();

const otpItinerarySchema = z
  .object({
    duration: z.coerce.number().nonnegative(),
    legs: z.array(otpLegSchema)
  })
  .passthrough();

const otpResponseSchema = z
  .object({
    plan: z
      .object({
        itineraries: z.array(otpItinerarySchema)
      })
      .passthrough()
      .optional(),
    error: z.unknown().optional()
  })
  .passthrough();

const main = async (): Promise<void> => {
  try {
    const response = await axios.get<unknown>(OTP_PLAN_URL, {
      params: {
        fromPlace: "53.906900,27.437600",
        toPlace: "53.906936,27.588628",
        mode: "TRANSIT,WALK",
        time: PEAK_COMMUTE_TIME,
        date: currentDate()
      },
      timeout: 30_000
    });

    const parsed = otpResponseSchema.parse(response.data);
    const itinerary = chooseItinerary(parsed.plan?.itineraries ?? []);
    if (itinerary === undefined) {
      console.error("OTP returned no itineraries.");
      if (parsed.error !== undefined) {
        console.error(JSON.stringify(parsed.error, null, 2));
      }
      process.exitCode = 1;
      return;
    }

    const totalMinutes = minutes(itinerary.duration);
    const routeSummary = itinerary.legs.map(formatLeg).join(" -> ");

    console.log(`Total duration: ${totalMinutes} min`);
    console.log(routeSummary);
  } catch (error: unknown) {
    console.error("OTP visual route test failed.");
    console.error(JSON.stringify(serializeError(error), null, 2));
    process.exitCode = 1;
  }
};

const formatLeg = (leg: z.infer<typeof otpLegSchema>): string => {
  const route = leg.route === null || leg.route === undefined || leg.route.length === 0 ? "" : ` line ${leg.route},`;
  return `${leg.mode}${route} ${minutes(leg.duration)}m`;
};

const chooseItinerary = (
  itineraries: readonly z.infer<typeof otpItinerarySchema>[]
): z.infer<typeof otpItinerarySchema> | undefined => {
  const transitItinerary = itineraries.find((itinerary) => itinerary.legs.some((leg) => leg.mode.toUpperCase() !== "WALK"));
  return transitItinerary ?? itineraries[0];
};

const minutes = (durationSeconds: number): number => Math.round(durationSeconds / 60);

const currentDate = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const serializeError = (error: unknown): Readonly<Record<string, unknown>> => {
  if (error instanceof AxiosError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      status: error.response?.status,
      responseBody: error.response?.data
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return { value: String(error) };
};

void main();
