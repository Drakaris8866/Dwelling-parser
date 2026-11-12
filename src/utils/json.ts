import type { Prisma } from "../generated/prisma/client.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(value) || typeof value !== "number";
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }

  return false;
};

export const toPrismaJson = (value: unknown): Prisma.InputJsonValue => {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;

  if (!isJsonValue(normalized)) {
    throw new Error("Value is not JSON serializable");
  }

  return normalized as Prisma.InputJsonValue;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key: string, nested: unknown): unknown => {
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  return nested;
});
