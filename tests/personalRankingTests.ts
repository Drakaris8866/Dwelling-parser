import assert from "node:assert/strict";
import type { CatalogItem, Comparable } from "../src/contracts/catalog.js";
import { estimateRenovation } from "../src/domain/renovationEstimate.js";
import { calculatePersonalRanking, compareBudgetRanges, comparePersonalRankingPreview } from "../src/domain/personalRanking.js";
import { assessRenovation } from "../src/domain/catalogScoring.js";
import type { RenovationInput } from "../src/contracts/personalRanking.js";
import { personalRankingSettingsSchema, renovationEstimateSchema } from "../src/contracts/personalRanking.js";

const input: RenovationInput = {
  areaSqm: 50, condition: "full", reservePct: 10, asOf: "2026-11-09",
  rates: { scope: "full", labor: { low: 200, base: 250, high: 300 }, materials: { low: 200, base: 250, high: 300 },
    observedOn: "2026-11-01", source: "fixture" },
  fx: { bynPerUsd: 3, observedOn: "2026-11-02", source: "fixture" }
};
const comps: Comparable[] = Array.from({ length: 5 }, (_, index) => ({
  propertyId: `property-${index}`, externalId: String(index), platform: "KUFAR", address: null,
  areaSqm: 50, priceUsd: 78_000, priceSqm: 1560, distanceMeters: 100
}));
const budget = (manualBudgetUsd: number) => estimateRenovation({ ...input, manualBudgetUsd });

export function assertPersonalRanking(): void {
  const usdRate = { usdPerSqm: 300, scope: "full" as const, observedOn: "2026-11-01", source: "User estimate" };
  const directInput = { ...input, rates: undefined, fx: undefined, reservePct: 0, usdRate };
  const direct = estimateRenovation(directInput);
  assert.equal(direct.status === "known" && direct.source, "usd-rate");
  assert.deepEqual(direct.status === "known" && direct.usd, { low: 15000, base: 15000, high: 15000 });
  assert.equal(direct.status === "known" && direct.byn, null, "USD assumptions must not fabricate BYN or FX");
  assert.deepEqual(direct.status === "known" && direct.usdRate, usdRate);
  assert.deepEqual(renovationEstimateSchema.parse(direct), direct);
  assert.equal(renovationEstimateSchema.safeParse({ ...direct, usdRate: undefined }).success, false, "USD source must include rate provenance");
  assert.equal(renovationEstimateSchema.safeParse({ ...direct, byn: { low: 1, base: 1, high: 1 } }).success, false, "Direct USD source cannot imply BYN conversion");
  const reserved = estimateRenovation({ ...directInput, reservePct: 10 });
  assert.equal(reserved.status === "known" && reserved.usd?.base, 16500);
  const preferred = estimateRenovation({ ...input, usdRate, reservePct: 0 });
  assert.equal(preferred.status === "known" && preferred.usd?.base, 15000, "Matching USD rate takes precedence over BYN rates");
  assert.deepEqual(estimateRenovation({ ...directInput, fx: { ...input.fx!, bynPerUsd: -1 } }), direct, "Direct USD calculations are independent of FX validity");
  const cosmeticByn = estimateRenovation({ ...input, usdRate, condition: "cosmetic", rates: { ...input.rates!, scope: "cosmetic" } });
  assert.equal(cosmeticByn.status === "known" && cosmeticByn.source, "rates", "A full USD rate must not replace matching cosmetic BYN rates");
  const override = estimateRenovation({ ...directInput, manualBudgetUsd: 8000 });
  assert.equal(override.status === "known" && override.source, "manual");
  assert.equal(override.status === "known" && override.usd?.base, 8000);
  assert.deepEqual(estimateRenovation({ ...directInput, condition: "unknown" }), { status: "unknown", reason: "unknown-condition" });
  assert.deepEqual(estimateRenovation({ ...directInput, condition: "cosmetic" }), { status: "unknown", reason: "missing-rates" });
  const cosmetic = estimateRenovation({ ...directInput, condition: "cosmetic", usdRate: { ...usdRate, scope: "cosmetic" } });
  assert.equal(cosmetic.status === "known" && cosmetic.usd?.base, 15000);
  const noRepair = estimateRenovation({ ...directInput, condition: "meets-target" });
  assert.equal(noRepair.status === "known" && noRepair.usd?.base, 0);
  assert.deepEqual(estimateRenovation({ ...directInput, usdRate: { ...usdRate, observedOn: "2026-11-10" } }), { status: "unknown", reason: "future-rates" });
  assert.equal(estimateRenovation({ ...directInput, usdRate: { ...usdRate, usdPerSqm: -1 } }).status, "unknown");
  assert.equal(estimateRenovation({ ...directInput, areaSqm: 1e14 }).status, "unknown");
  assert.deepEqual(personalRankingSettingsSchema.parse({ usdRate }).usdRate, usdRate);
  for (const invalidRate of [{ ...usdRate, source: "" }, { ...usdRate, observedOn: "2026-02-30" }, { ...usdRate, usdPerSqm: 0 }, { ...usdRate, currency: "BYN" }]) {
    assert.equal(personalRankingSettingsSchema.safeParse({ usdRate: invalidRate }).success, false);
  }
  const estimated = estimateRenovation(input);
  assert.equal(estimated.status, "known");
  if (estimated.status !== "known") throw new Error("Expected renovation range");
  assert.deepEqual(estimated.byn, { low: 22_000, base: 27_500, high: 33_000 });
  assert.deepEqual(estimated.usd, { low: 7333.33, base: 9166.67, high: 11_000 });
  const stale = estimateRenovation({ ...input, fx: { ...input.fx!, observedOn: "2026-11-01" } });
  assert.equal(stale.status, "known");
  if (stale.status !== "known") throw new Error("Expected BYN estimate");
  assert.equal(stale.usd, null);
  assert.equal(stale.usdUnavailable, "stale-fx");
  assert.deepEqual(stale.byn, estimated.byn);
  const future = estimateRenovation({ ...input, fx: { ...input.fx!, observedOn: "2026-11-10" } });
  assert.equal(future.status === "known" && future.usdUnavailable, "stale-fx");
  const missingFx = estimateRenovation({ ...input, fx: undefined });
  assert.equal(missingFx.status === "known" && missingFx.usdUnavailable, "missing-fx");
  assert.equal(estimateRenovation({ ...input, areaSqm: 1e14 }).status, "unknown");
  const manualRange = budget(8_000);
  assert.deepEqual(manualRange.status === "known" && manualRange.usd, { low: 8_000, base: 8_000, high: 8_000 });
  const manual = estimateRenovation({ ...input, condition: "unknown", fx: { ...input.fx!, bynPerUsd: -1 }, manualBudgetUsd: 8_000 });
  assert.equal(manual.status === "known" && manual.source, "manual");
  const zero = budget(0);
  assert.equal(zero.status === "known" && zero.usd?.base, 0);
  assert.equal(estimateRenovation({ ...input, manualBudgetUsd: -1 }).status, "unknown");
  assert.equal(estimateRenovation({ ...input, condition: "unknown" }).status, "unknown");
  assert.equal(estimateRenovation({ ...input, condition: "cosmetic" }).status, "unknown");
  assert.equal(estimateRenovation({ ...input, rates: { ...input.rates!, labor: { low: 400, base: 100, high: 600 } } }).status, "unknown");
  const readyBudget = estimateRenovation({ ...input, condition: "meets-target", fx: undefined });
  assert.equal(readyBudget.status === "known" && readyBudget.usd?.base, 0);
  const common = { areaSqm: 50, eligible: true, readyComparables: comps, asIsComparables: comps,
    knownComparableFeatures: 4, components: { house: 70, commute: 60, location: 80, layout: 70 } };
  const expensiveRepair = calculatePersonalRanking({ ...common, purchaseUsd: 68_000, renovation: budget(13_000) });
  const affordableRepair = calculatePersonalRanking({ ...common, purchaseUsd: 68_000, renovation: budget(8_000) });
  const ready = calculatePersonalRanking({ ...common, purchaseUsd: 78_000, renovation: readyBudget });
  assert.equal(expensiveRepair.totalUsd?.base, 81_000);
  assert.equal(affordableRepair.totalUsd?.base, 76_000);
  assert.equal(ready.totalUsd?.base, 78_000);
  assert.ok(expensiveRepair.score! < ready.score! && ready.score! < affordableRepair.score!);
  assert.ok(expensiveRepair.asIsScore! > ready.asIsScore!, "An apparent discount must not defeat a lower all-in cost");
  assert.equal(calculatePersonalRanking({ ...common, purchaseUsd: 68_000, renovation: stale }).score, null);
  assert.equal(calculatePersonalRanking({ ...common, purchaseUsd: 68_000, renovation: estimated, readyComparables: comps.slice(0, 4) }).score, null);
  const smallSample = { ...common, purchaseUsd: 68000, renovation: estimated, minimumComparables: 3, readyComparables: comps.slice(0, 3), asIsComparables: comps.slice(0, 3) };
  assert.notEqual(calculatePersonalRanking(smallSample).score, null, "Configured minimum of three enables a personal score");
  assert.equal(calculatePersonalRanking(smallSample).provisional, true, "Small samples remain preliminary even with complete convenience data");
  const invalidPriceSample = calculatePersonalRanking({ ...smallSample, renovation: budget(0), components: { house: 100, commute: 100, location: 100, layout: 100 }, readyComparables: [...comps.slice(0, 3), ...comps.slice(3).map(row => ({ ...row, priceSqm: 0 }))] });
  assert.equal(invalidPriceSample.coverage, 100);
  assert.equal(invalidPriceSample.provisional, true, "Reliability counts only the valid unique prices actually used, even with a point budget and full coverage");
  assert.equal(calculatePersonalRanking({ ...smallSample, readyComparables: comps.slice(0, 2) }).score, null);
  assert.equal(calculatePersonalRanking({ ...smallSample, minimumComparables: 5 }).score, null);
  for (const minimumComparables of [2, 3.5, 21, Number.NaN]) {
    assert.equal(calculatePersonalRanking({ ...smallSample, minimumComparables }).reason, "invalid-input");
  }
  assert.equal(calculatePersonalRanking({ ...common, purchaseUsd: 68_000, renovation: estimated, eligible: false }).reason, "ineligible");
  const partial = calculatePersonalRanking({ ...common, purchaseUsd: 78_000, renovation: readyBudget, components: {} });
  assert.equal(partial.score, 50);
  assert.equal(partial.coverage, 45);
  assert.equal(partial.provisional, true);
  const preview = (propertyId: string, base: number, comparableGroupKey: string | null = "group-a") => ({
    propertyId, comparableGroupKey, result: { ...ready, score: 70, totalUsd: { low: base, base, high: base } }
  });
  const cheap = preview("z-cheap", 70000), costly = preview("a-costly", 80000);
  assert.ok(comparePersonalRankingPreview(cheap, costly) < 0, "equal reliable scores compare total budget inside the same group");
  assert.ok(comparePersonalRankingPreview({ ...cheap, result: { ...cheap.result, score: null } }, costly) > 0, "unknown scores sort last");
  assert.ok(comparePersonalRankingPreview({ ...cheap, result: { ...cheap.result, provisional: true } }, costly) > 0, "reliability precedes price");
  assert.ok(comparePersonalRankingPreview({ ...cheap, result: { ...cheap.result, coverage: 60 } }, costly) > 0, "coverage precedes price");
  assert.ok(comparePersonalRankingPreview(preview("z-unknown", 1, null), preview("a-unknown", 90000, null)) > 0, "unestablished comparability uses stable identity, not cheapness");
  assert.ok(comparePersonalRankingPreview(preview("z-other", 1, "group-b"), costly) > 0, "a cheaper unlike property cannot win on total budget");
  assert.ok(comparePersonalRankingPreview(preview("a-tie", 80000), costly) > 0, "equal totals use stable property identity");
  const previewRows = [preview("middle", 1, "group-b"), costly, cheap];
  assert.deepEqual([...previewRows].sort(comparePersonalRankingPreview).map((row) => row.propertyId), ["z-cheap", "a-costly", "middle"]);
  assert.deepEqual([...previewRows].reverse().sort(comparePersonalRankingPreview), [...previewRows].sort(comparePersonalRankingPreview), "grouped price tie-breaking is independent of source order");
  const orderingCases = [...previewRows, preview("unknown-group", 2, null),
    { ...cheap, propertyId: "missing-total", result: { ...cheap.result, totalUsd: null } },
    { ...cheap, propertyId: "unknown-score", result: { ...cheap.result, score: null } }];
  for (const a of orderingCases) for (const b of orderingCases) for (const c of orderingCases) {
    if (comparePersonalRankingPreview(a, b) <= 0 && comparePersonalRankingPreview(b, c) <= 0) {
      assert.ok(comparePersonalRankingPreview(a, c) <= 0, "preview ordering must remain transitive across groups and missing evidence");
    }
  }
  assert.equal(compareBudgetRanges({ low: 74_000, base: 76_000, high: 78_000 }, { low: 77_000, base: 79_000, high: 80_000 }), "overlap");
  assert.equal(compareBudgetRanges({ low: 74_000, base: 75_000, high: 76_000 }, { low: 77_000, base: 79_000, high: 80_000 }), "lower");
  const futureRates = estimateRenovation({ ...input, rates: { ...input.rates!, observedOn: "2026-11-10" } });
  assert.deepEqual(futureRates, { status: "unknown", reason: "future-rates" });
  const manualMeetsTarget = estimateRenovation({ ...input, condition: "meets-target", manualBudgetUsd: 5_000 });
  assert.equal(manualMeetsTarget.status, "known");
  if (manualMeetsTarget.status !== "known") throw new Error("Expected manual budget");
  assert.equal(manualMeetsTarget.source, "manual");
  assert.deepEqual(manualMeetsTarget.usd, { low: 5_000, base: 5_000, high: 5_000 });
  const catalogItem = {
    id: "item-1", priceUsd: 70_000, areaSqm: 50, priceSqm: 1400, disposition: "ACCEPTED",
    features: { locality: "Минск", marketZone: "минск", isStudio: false, propertyType: "apartment", dealType: "sale", inCollectionArea: true, totalFloors: 9 }
  } as unknown as CatalogItem;
  const scenario = assessRenovation(catalogItem, 10_000, comps, 500);
  assert.equal(scenario.totalUsd, 80_000);
  assert.equal(scenario.priceSqm, 1600);
  assert.equal(scenario.purchaseUsd, 70_000);
  assert.equal(scenario.budgetUsd, 10_000);
}
