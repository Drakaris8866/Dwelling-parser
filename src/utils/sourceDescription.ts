import { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { canonicalJson } from "./json.js";

const snapshotSchema = z.object({
  body: z.string().nullish(), body_short: z.string().nullish(),
  description: z.string().nullish(), headline: z.string().nullish()
});

export const sourceDescriptionSnapshot = (payload: Prisma.InputJsonValue): string | null => {
  const parsed = snapshotSchema.safeParse(payload);
  return parsed.success ? canonicalJson(parsed.data) : null;
};
