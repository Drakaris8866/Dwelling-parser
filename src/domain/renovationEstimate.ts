import {
  manualBudgetSchema,
  renovationBaseInputSchema,
  renovationFxSchema,
  renovationRatesSchema,
  renovationUsdRateSchema,
  type MoneyRange,
  type RenovationEstimate,
  type RenovationInput
} from "../contracts/personalRanking.js";

const maxFxAgeMs = 7 * 24 * 60 * 60 * 1000;

function fixedRange(amount: number): MoneyRange {
  return { low: amount, base: amount, high: amount };
}

function roundRange({ low, base, high }: MoneyRange): MoneyRange | null {
  const lowCents = Math.round(low * 100);
  const baseCents = Math.round(base * 100);
  const highCents = Math.round(high * 100);
  if (![lowCents, baseCents, highCents].every(Number.isSafeInteger)) return null;
  return { low: lowCents / 100, base: baseCents / 100, high: highCents / 100 };
}

export function estimateRenovation(input: RenovationInput): RenovationEstimate {
  const { manualBudgetUsd, rates: rawRates, fx: rawFx, usdRate: rawUsdRate, areaSqm, condition, reservePct, asOf } = input;
  if (manualBudgetUsd != null) {
    const manual = manualBudgetSchema.safeParse(manualBudgetUsd);
    if (!manual.success) return { status: "unknown", reason: "invalid-input" };
    const usd = roundRange(fixedRange(manual.data));
    if (usd === null) return { status: "unknown", reason: "invalid-input" };
    return {
      status: "known", source: "manual", byn: null, usd,
      rates: null, fx: null, usdUnavailable: null
    };
  }

  const base = renovationBaseInputSchema.safeParse({ areaSqm, condition, reservePct, asOf });
  if (!base.success) return { status: "unknown", reason: "invalid-input" };
  if (base.data.condition === "unknown") return { status: "unknown", reason: "unknown-condition" };
  if (base.data.condition === "meets-target" || base.data.condition === "user-finished") {
    return {
      status: "known", source: base.data.condition === "user-finished" ? "user-rule" : "not-needed",
      byn: base.data.condition === "user-finished" ? null : fixedRange(0), usd: fixedRange(0),
      rates: null, fx: null, usdUnavailable: null
    };
  }

  const asOfMs = Date.parse(base.data.asOf);
  const reserveFactor = 1 + base.data.reservePct / 100;
  if (rawUsdRate !== undefined) {
    const parsedUsdRate = renovationUsdRateSchema.safeParse(rawUsdRate);
    if (!parsedUsdRate.success) return { status: "unknown", reason: "invalid-input" };
    const usdRate = parsedUsdRate.data;
    if (usdRate.scope === base.data.condition) {
      if (Date.parse(usdRate.observedOn) > asOfMs) return { status: "unknown", reason: "future-rates" };
      const usd = roundRange(fixedRange(usdRate.usdPerSqm * base.data.areaSqm * reserveFactor));
      if (usd === null) return { status: "unknown", reason: "invalid-input" };
      return { status: "known", source: "usd-rate", usd, usdRate, byn: null, rates: null, fx: null, usdUnavailable: null };
    }
  }

  const parsedRates = renovationRatesSchema.safeParse(rawRates);
  if (!parsedRates.success || parsedRates.data.scope !== base.data.condition) {
    return { status: "unknown", reason: "missing-rates" };
  }
  const rates = parsedRates.data;
  if (Date.parse(rates.observedOn) > asOfMs) return { status: "unknown", reason: "future-rates" };

  const cost = (key: keyof MoneyRange): number =>
    (rates.labor[key] + rates.materials[key]) * base.data.areaSqm * reserveFactor;
  const unrounded = { low: cost("low"), base: cost("base"), high: cost("high") };
  const byn = roundRange(unrounded);
  if (byn === null) return { status: "unknown", reason: "invalid-input" };

  const estimate = { status: "known", source: "rates", byn, rates, usd: null, fx: null } as const;
  if (rawFx === undefined) return { ...estimate, usdUnavailable: "missing-fx" };
  const parsedFx = renovationFxSchema.safeParse(rawFx);
  if (!parsedFx.success) return { ...estimate, usdUnavailable: "invalid-fx" };
  const fx = parsedFx.data;
  const fxAgeMs = asOfMs - Date.parse(fx.observedOn);
  if (fxAgeMs < 0 || fxAgeMs > maxFxAgeMs) return { ...estimate, usdUnavailable: "stale-fx" };

  const usd = roundRange({
    low: unrounded.low / fx.bynPerUsd,
    base: unrounded.base / fx.bynPerUsd,
    high: unrounded.high / fx.bynPerUsd
  });
  if (usd === null) return { ...estimate, usdUnavailable: "invalid-fx" };
  return { ...estimate, usd, fx, usdUnavailable: null };
}
