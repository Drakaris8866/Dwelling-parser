import assert from "node:assert/strict";
import { canonicalRankingHash, resolvePublicationPrices } from "../src/domain/rankingSnapshot.js";
import { personalRankingSettingsSchema, rankingPriceEvidenceSchema } from "../src/contracts/personalRanking.js";
import { personalRankingPilotIdsSchema } from "../src/services/shadowRankingService.js";
import { originalUsdCurrency } from "../src/infrastructure/sources/sourcePriceCurrency.js";

export function assertRankingSnapshots(): void {
  assert.equal(canonicalRankingHash({ b: 2, a: 1 }), canonicalRankingHash({ a: 1, b: 2 }));
  assert.notEqual(canonicalRankingHash({ price: 1 }), canonicalRankingHash({ price: 2 }));
  const rows = [
    { propertyId: "a", externalId: "2", platform: "KUFAR", priceUsd: 70000, lastSeenAt: new Date("2026-11-10") },
    { propertyId: "a", externalId: "1", platform: "ONLINER", priceUsd: 71000, lastSeenAt: new Date("2026-11-10") },
    { propertyId: "b", externalId: "3", platform: "KUFAR", priceUsd: 80000, lastSeenAt: new Date("2026-11-10") }
  ];
  const resolved = resolvePublicationPrices(rows);
  assert.equal(resolved.rows.find((row) => row.propertyId === "a")?.priceIsDisputed, true);
  assert.equal(resolved.rows.find((row) => row.propertyId === "b")?.priceIsDisputed, false);
  assert.equal(resolved.evidence[0]?.publications.length, 2);
  assert.equal(canonicalRankingHash(resolvePublicationPrices(rows)), canonicalRankingHash(resolvePublicationPrices([...rows].reverse())));
  const currencyRows = [
    { ...rows[0]!, priceUsd: 161926, priceByn: 484500, lastSeenAt: new Date("2026-11-09") },
    { ...rows[1]!, priceUsd: 161958.88, priceByn: 484500, lastSeenAt: new Date("2026-11-06") }
  ];
  const converted = resolvePublicationPrices(currencyRows);
  assert.equal(converted.rows.length, 1, "Merged publications count as one apartment");
  assert.equal(converted.rows[0]?.priceIsDisputed, false, "Same BYN and small conversion spread should agree");
  assert.equal(converted.rows[0]?.priceUsd, 161926, "Use latest publication, not cheapest or average");
  assert.equal(converted.evidence[0]?.resolution, "same-byn-conversion");
  assert.equal(converted.evidence[0]?.publications[0]?.priceByn, 484500);
  const boundary = [{ ...currencyRows[0]!, priceUsd: 100000 }, { ...currencyRows[1]!, priceUsd: 100100 }];
  assert.equal(resolvePublicationPrices(boundary).rows[0]?.priceIsDisputed, false, "0.1% boundary is inclusive");
  assert.equal(resolvePublicationPrices([boundary[0]!, { ...boundary[1]!, priceUsd: 100100.01 }]).rows[0]?.priceIsDisputed, true);
  assert.equal(resolvePublicationPrices([boundary[0]!, { ...boundary[1]!, priceUsd: 100090 }, { ...boundary[1]!, externalId: "third", priceUsd: 100180 }]).rows[0]?.priceIsDisputed, true, "Compare full group range rather than adjacent prices");
  assert.equal(resolvePublicationPrices([{ ...currencyRows[0]!, priceUsd: 212435, priceByn: 635500 }, { ...currencyRows[1]!, priceUsd: 212435.23, priceByn: 635500 }]).rows[0]?.priceIsDisputed, false);
  assert.equal(canonicalRankingHash(converted), canonicalRankingHash(resolvePublicationPrices([...currencyRows].reverse())));
  for (const priceByn of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 484500.01]) {
    const { priceByn: _original, ...other } = currencyRows[1]!;
    assert.equal(resolvePublicationPrices([currencyRows[0]!, { ...other, ...(priceByn === undefined ? {} : { priceByn }) }]).rows[0]?.priceIsDisputed, true);
  }
  assert.equal(resolvePublicationPrices([currencyRows[0]!, { ...currencyRows[1]!, priceUsd: 170000 }]).rows[0]?.priceIsDisputed, true, "Same BYN cannot hide a large USD conflict");
  assert.equal(resolvePublicationPrices([currencyRows[0]!, { ...currencyRows[1]!, priceUsd: 161926, priceByn: 484501 }]).rows[0]?.priceIsDisputed, true, "Conflicting known BYN remains disputed even for equal USD");
  const originalUsd = [{ ...currencyRows[0]!, priceUsd: 150000, priceByn: 448815, priceCurrency: "USD" as const },
    { ...currencyRows[1]!, priceUsd: 150000, priceByn: 448725, priceCurrency: "USD" as const }];
  assert.equal(resolvePublicationPrices(originalUsd).rows[0]?.priceIsDisputed, false, "Matching explicitly original USD is not disputed by converted BYN");
  assert.equal(resolvePublicationPrices([{ ...originalUsd[0]!, priceUsd: 150001, priceByn: 448725 }, originalUsd[1]!]).rows[0]?.priceIsDisputed, true, "Even a small difference in declared original USD is a genuine conflict");
  assert.equal(resolvePublicationPrices([{ ...originalUsd[0]!, priceUsd: 150001, priceByn: 448725 }, originalUsd[1]!, { ...currencyRows[0]!, externalId: "unknown-currency", priceUsd: 150000, priceByn: 448725 }]).rows[0]?.priceIsDisputed, true, "Unknown-currency sibling cannot hide a conflict between known original USD prices");
  assert.equal(resolvePublicationPrices([{ ...originalUsd[0]!, priceUsd: 150001 }, originalUsd[1]!]).rows[0]?.priceIsDisputed, true, "Different original USD stays disputed");
  assert.equal(resolvePublicationPrices([{ ...originalUsd[0]!, priceCurrency: "BYN" as const }, originalUsd[1]!]).rows[0]?.priceIsDisputed, true, "Mixed original currencies cannot override BYN conflict");
  assert.equal(originalUsdCurrency("KUFAR", { currency: "USD", price_usd: 15000000 }, 150000), "USD");
  assert.equal(originalUsdCurrency("KUFAR", { currency: "USD", price_usd: 150000 }, 150000), "USD");
  assert.equal(originalUsdCurrency("ONLINER", { price: { currency: "USD", amount: 150000 } }, 150000), "USD");
  for (const payload of [null, {}, { currency: "BYN", price_usd: 15000000 }, { currency: "USD", price_usd: 15000100 }, { currency: "USD", price_usd: "15000000" }]) {
    assert.equal(originalUsdCurrency("KUFAR", payload, 150000), undefined, "Malformed or mismatched source payload cannot establish original USD");
  }
  assert.equal(originalUsdCurrency("ONLINER", { price: { currency: "USD", amount: 150001 } }, 150000), undefined);
  assert.equal(originalUsdCurrency("REALT", { currency: "USD", price_usd: 150000 }, 150000), undefined);
  for (const priceUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolvePublicationPrices([currencyRows[0]!, { ...currencyRows[1]!, priceUsd }]).rows[0]?.priceIsDisputed, true);
  }
  for (const priceByn of [0, -1]) {
    const invalidByn = resolvePublicationPrices([currencyRows[0]!, { ...currencyRows[1]!, priceByn }]);
    assert.equal(rankingPriceEvidenceSchema.parse(invalidByn.evidence[0]).disputed, true, "Invalid finite BYN stays inspectable without preventing snapshot persistence");
  }
  assert.equal(personalRankingSettingsSchema.parse({}).previewEnabled, false);
  assert.equal(personalRankingSettingsSchema.safeParse({ reservePct: -1 }).success, false);
  assert.equal(personalRankingSettingsSchema.safeParse({ unexpected: true }).success, false);
  assert.equal(personalRankingPilotIdsSchema.safeParse([]).success, false);
  assert.equal(personalRankingPilotIdsSchema.safeParse(["invalid"]).success, false);
  assert.equal(personalRankingPilotIdsSchema.safeParse(Array(101).fill("11111111-1111-4111-8111-111111111111")).success, false);
}
