import { z } from "zod";

const onlinerPrice = z.object({ price: z.object({ currency: z.literal("USD"), amount: z.number().positive() }) });
const kufarPrice = z.object({ currency: z.literal("USD"), price_usd: z.number().positive() });

// Trust declared USD only when the raw source amount also matches the stored total.
export const originalUsdCurrency = (platform: string, payload: unknown, priceUsd: number): "USD" | undefined => {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return undefined;
  if (platform === "ONLINER") {
    const parsed = onlinerPrice.safeParse(payload);
    if (parsed.success && parsed.data.price.amount === priceUsd) return "USD";
  }
  if (platform === "KUFAR") {
    const parsed = kufarPrice.safeParse(payload);
    if (parsed.success && (parsed.data.price_usd === priceUsd || parsed.data.price_usd / 100 === priceUsd)) return "USD";
  }
  return undefined;
};
