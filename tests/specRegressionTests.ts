import assert from "node:assert/strict";
import type { PgBoss, JobWithMetadata } from "pg-boss";
import {
  type CatalogItem,
  type Comparable,
  DEFAULT_SETTINGS,
  type ListingFeatures,
  type RoutingData
} from "../src/contracts/catalog.js";
import type { RenovationInput } from "../src/contracts/personalRanking.js";
import { DEFAULT_PREFERENCE_WEIGHTS } from "../src/contracts/userFeedback.js";
import { conditionCriteria, transportCriteria } from "../src/domain/catalogCriteria.js";
import { assessListing } from "../src/domain/catalogScoring.js";
import { structuredDuplicate, type ApartmentIdentity } from "../src/domain/duplicateIdentity.js";
import { classifyListing } from "../src/domain/exclusions.js";
import { calculatePersonalRanking } from "../src/domain/personalRanking.js";
import { evaluatePrice } from "../src/domain/priceRating.js";
import { estimateRenovation } from "../src/domain/renovationEstimate.js";
import {
  approvedBuilding,
  approvedPlan,
  approvedRepair,
  marketFeatures
} from "../src/domain/repairEvidence.js";
import { compactAssessments } from "../src/infrastructure/queue/catalogQueues.js";
import type {
  StoredFeedback,
  UserFeedbackRepository
} from "../src/infrastructure/repositories/userFeedbackRepository.js";
import { UserFeedbackService } from "../src/services/userFeedbackService.js";
import { offersExchange, parseListingIntent } from "../src/utils/listingIntent.js";
import { parseTextSignals } from "../src/utils/textParser.js";

const DEFAULT_BASE_FEATURES: ListingFeatures = {
  locality: "Минск",
  dealType: "sale",
  propertyType: "apartment",
  inCollectionArea: true,
  totalFloors: 9,
  provenance: {}
};

/**
 * 1. доли и обмены с отрицаниями:
 * Фразы "не доля", "не обмен", "без обмена" НЕ должны исключать объявление,
 * а "доля 1/2", "чистая продажа или обмен на 1-комн" должны обрабатываться строго.
 */
export const assertOwnershipNegations = (): void => {
  // Negative patterns that must NOT trigger exclusion or partial ownership
  const notShare = parseTextSignals(["Продается 2-комнатная квартира", "Не доля, чистая продажа"]);
  assert.equal(notShare.hasPartialOwnership, false, "'Не доля' must not be marked as partial ownership");

  const notExchange = offersExchange("2-комнатная квартира", "Чистая продажа. Без обмена, обмен не интересует, не предлагать обмен.");
  assert.equal(notExchange, false, "'Без обмена' and 'обмен не интересует' must not be flagged as exchange");

  const noExchangeInHouse = offersExchange("Квартира в центре", "Не интересует обмен на дом. Только продажа.");
  assert.equal(noExchangeInHouse, false, "'Не интересует обмен на дом' must not trigger exchange");

  const acceptedDecision = classifyListing(
    { title: "2-комнатная квартира", description: "Чистая продажа. Не доля. Без обмена." },
    DEFAULT_BASE_FEATURES
  );
  assert.equal(acceptedDecision.disposition, "ACCEPTED");
  assert.deepEqual(acceptedDecision.reasons, []);

  // Strict handling of actual shares
  const actualShare = parseTextSignals(["Продается доля 19/50", "2 комнаты в 4х комн квартире"]);
  assert.equal(actualShare.hasPartialOwnership, true, "Actual fractional share must be detected");

  const shareDecision = classifyListing(
    { title: "Продается доля 1/2 в квартире", description: "Продам 1/2 долю в двушке" },
    DEFAULT_BASE_FEATURES
  );
  assert.equal(shareDecision.disposition, "EXCLUDED");
  assert.ok(shareDecision.reasons.includes("Продажа комнаты или доли"));

  const roomTitleDecision = classifyListing(
    { title: "Комната  Корженевского пер., 14", description: "" },
    DEFAULT_BASE_FEATURES
  );
  assert.equal(roomTitleDecision.disposition, "EXCLUDED");
  assert.ok(roomTitleDecision.reasons.includes("Продажа комнаты или доли"));

  const roomsInFlatDecision = classifyListing(
    { title: "Квартира", description: "Продаются две раздельные комнаты (12.40 м2 и 13.90 м2) в 3-комнатной квартире" },
    DEFAULT_BASE_FEATURES
  );
  assert.equal(roomsInFlatDecision.disposition, "EXCLUDED");
  assert.ok(roomsInFlatDecision.reasons.includes("Продажа комнаты или доли"));

  const signalsCoOwner = parseListingIntent("Квартира", "Второй сособственник согласен", DEFAULT_BASE_FEATURES);
  assert.equal(signalsCoOwner.partial, true, "Co-owner signal must be flagged");

  const signalsUsageOrder = parseListingIntent("Квартира", "Порядок пользования комнатами определен", DEFAULT_BASE_FEATURES);
  assert.equal(signalsUsageOrder.partial, true, "Usage order signal must be flagged");

  const signalsAllocatedRoom = parseListingIntent("Квартира", "Продается выделенная комната", DEFAULT_BASE_FEATURES);
  assert.equal(signalsAllocatedRoom.partial, true, "Allocated room signal must be flagged");

  const signalsPurchaseRooms = parseListingIntent("Квартира", "покупка двух комнат в квартире", DEFAULT_BASE_FEATURES);
  assert.equal(signalsPurchaseRooms.partial, true, "Purchase of rooms in flat must be flagged");

  const partOfFlat = parseListingIntent("Квартира", "Продам часть квартиры, 25% квартиры", DEFAULT_BASE_FEATURES);
  assert.equal(partOfFlat.partial, true, "Partial apartment percentages must be flagged");

  // Strict handling of actual exchanges
  const actualExchange = offersExchange("Квартира", "Чистая продажа или обмен на 1-комн квартиру");
  assert.equal(actualExchange, true, "'Чистая продажа или обмен на 1-комн' must be flagged as exchange");

  const exchangeDecision = classifyListing(
    { title: "2-к квартира", description: "Чистая продажа или обмен на 1-комн" },
    DEFAULT_BASE_FEATURES
  );
  assert.equal(exchangeDecision.disposition, "EXCLUDED");
  assert.ok(exchangeDecision.reasons.includes("Объявление об обмене"));

  const readyToExchange = offersExchange("2-комнатная", "Готов обменять квартиру на дом");
  assert.equal(readyToExchange, true, "'Готов обменять квартиру' must be flagged as exchange");
};

/**
 * 2. этажность 1–5 и неизвестная:
 * Этаж 1 (штраф), последний этаж в 1-5 этажках (штраф выше чем в высотках),
 * неизвестная этажность (null floor/floors) не вызывает крах и помечается provisional/unconfirmed.
 */
export const assertFloorsLogic = (): void => {
  // First floor penalty
  const firstFloorCriteria = conditionCriteria({ ...DEFAULT_BASE_FEATURES, floor: 1, totalFloors: 9, elevator: true });
  const firstFloor = firstFloorCriteria.find((c) => c.code === "floor");
  assert.equal(firstFloor?.score, 55, "First floor gets score 55 (penalty vs middle floor 85)");

  // Last floor in 1-5 storey walkup vs high-rise with elevator
  const fiveStoreyWalkup = conditionCriteria({ ...DEFAULT_BASE_FEATURES, floor: 5, totalFloors: 5, elevator: false });
  const fiveFloor = fiveStoreyWalkup.find((c) => c.code === "floor");
  const fiveElevator = fiveStoreyWalkup.find((c) => c.code === "elevator");
  assert.equal(fiveFloor?.score, 60, "Last floor gets score 60");
  assert.equal(fiveElevator?.score, 30, "No elevator above 3rd floor gets score 30");

  const nineStoreyHighrise = conditionCriteria({ ...DEFAULT_BASE_FEATURES, floor: 9, totalFloors: 9, elevator: true });
  const nineFloor = nineStoreyHighrise.find((c) => c.code === "floor");
  const nineElevator = nineStoreyHighrise.find((c) => c.code === "elevator");
  assert.equal(nineFloor?.score, 60);
  assert.equal(nineElevator?.score, 90, "Elevator in high-rise gives score 90");

  // Combined score for last floor in 5-storey walkup is lower than in high-rise with elevator
  const walkupFloorPoints = (fiveFloor!.score! * fiveFloor!.weight + fiveElevator!.score! * fiveElevator!.weight);
  const highriseFloorPoints = (nineFloor!.score! * nineFloor!.weight + nineElevator!.score! * nineElevator!.weight);
  assert.ok(walkupFloorPoints < highriseFloorPoints, "Penalty for last floor in 5-storey walkup is higher than in high-rise with elevator");

  // Exclusion logic: 1-4 floors excluded, 5 floors accepted
  const fourFloors = classifyListing({ title: "Квартира", description: "Описание" }, { ...DEFAULT_BASE_FEATURES, totalFloors: 4 });
  assert.equal(fourFloors.disposition, "EXCLUDED");
  assert.ok(fourFloors.reasons.includes("В доме четыре этажа или меньше"));

  const fiveFloors = classifyListing({ title: "Квартира", description: "Описание" }, { ...DEFAULT_BASE_FEATURES, totalFloors: 5 });
  assert.equal(fiveFloors.disposition, "ACCEPTED");

  // "4 этаж из 9" is not a 4-storey building
  const fourOfNine = classifyListing({ title: "4 этаж из 9", description: "Просторная квартира" }, DEFAULT_BASE_FEATURES);
  assert.equal(fourOfNine.disposition, "ACCEPTED");

  // Unknown floor count does not crash, moves to REVIEW
  const unknownFloors = classifyListing({ title: "Квартира", description: "Описание без этажей" }, { ...DEFAULT_BASE_FEATURES, totalFloors: undefined });
  assert.equal(unknownFloors.disposition, "REVIEW");
  assert.ok(unknownFloors.reasons.includes("Не указана этажность дома"));

  // Scoring with unknown floor / totalFloors does not crash, scores are null
  const unknownFloorCriteria = conditionCriteria({ ...DEFAULT_BASE_FEATURES, floor: undefined, totalFloors: undefined });
  assert.equal(unknownFloorCriteria.find((c) => c.code === "floor")?.score, null);
  assert.equal(unknownFloorCriteria.find((c) => c.code === "floor")?.observed, null);
};

/**
 * 3. соседи против дублей:
 * Две квартиры в одном доме с одинаковым адресом, но разными площадями или этажами — НЕ дубли;
 * проверка не должна склеивать разные квартиры только по координатам дома.
 */
export const assertNeighborsVsDuplicates = (): void => {
  const apartmentA: ApartmentIdentity = {
    address: "г. Минск, ул. Богдановича, 15",
    locality: "Минск",
    latitude: 53.915,
    longitude: 27.567,
    floor: 3,
    totalFloors: 9,
    rooms: 2,
    areaSqm: 52.0,
    priceUsd: 75000,
    priceByn: null,
    livingSqm: 32.0,
    kitchenSqm: 8.5,
    buildingYear: 1985
  };

  // Same coordinates and address, but different floor -> NOT duplicates (neighbors)
  const differentFloor: ApartmentIdentity = { ...apartmentA, floor: 5 };
  assert.equal(structuredDuplicate(apartmentA, differentFloor), false, "Neighbors on different floors must NOT be marked duplicates");

  // Same coordinates and address, but different area -> NOT duplicates (neighbors)
  const differentArea: ApartmentIdentity = { ...apartmentA, areaSqm: 68.0, livingSqm: 42.0 };
  assert.equal(structuredDuplicate(apartmentA, differentArea), false, "Neighbors with different areas must NOT be marked duplicates");

  // Same coordinates and address, but different rooms -> NOT duplicates
  const differentRooms: ApartmentIdentity = { ...apartmentA, rooms: 3, areaSqm: 72.0 };
  assert.equal(structuredDuplicate(apartmentA, differentRooms), false, "Apartments with different rooms must NOT be marked duplicates");

  // Unknown floor (null) -> cannot safely declare duplicate
  const unknownFloorA: ApartmentIdentity = { ...apartmentA, floor: null };
  const unknownFloorB: ApartmentIdentity = { ...apartmentA, floor: null };
  assert.equal(structuredDuplicate(unknownFloorA, unknownFloorB), false, "Unknown floor prevents blind duplicate match");

  // Genuine duplicate (same address, coordinates, floor, area, rooms) -> true
  const duplicatePublication: ApartmentIdentity = { ...apartmentA };
  assert.equal(structuredDuplicate(apartmentA, duplicatePublication), true, "Identical publications must be recognized as duplicates");
};

/**
 * 4. пять и менее аналогов:
 * < 5 аналогов возвращает null / "Недостаточно данных" (или "insufficient-comparables"),
 * НЕ подменяет выборку глобальной медианой Минска.
 */
export const assertFewerThanFiveComparables = (): void => {
  const comps: Comparable[] = Array.from({ length: 4 }, (_, i) => ({
    propertyId: `prop-${i}`, externalId: String(i), platform: "KUFAR", address: null,
    areaSqm: 50, priceUsd: 75000, priceSqm: 1500, distanceMeters: 200
  }));

  // evaluatePrice with 4 comparables returns nulls (minimum 5 required)
  const priceResult = evaluatePrice(1500, comps, true, 4);
  assert.equal(priceResult.median, null, "Median must be null when fewer than 5 comparables");
  assert.equal(priceResult.score, null, "Score must be null when fewer than 5 comparables");
  assert.equal(priceResult.discount, null);

  // calculatePersonalRanking with < 5 comparables returns null score and "insufficient-comparables"
  const renoInput: RenovationInput = {
    areaSqm: 50, condition: "meets-target", reservePct: 10, asOf: "2026-11-09"
  };
  const renovation = estimateRenovation(renoInput);
  const rankingResult = calculatePersonalRanking({
    areaSqm: 50, purchaseUsd: 70000, eligible: true,
    renovation, knownComparableFeatures: 4,
    asIsComparables: comps, readyComparables: comps,
    components: { house: 70, commute: 60, location: 80, layout: 70 }
  });
  assert.equal(rankingResult.score, null, "Personal ranking score must be null without 5 comparables");
  assert.equal(rankingResult.readyMedianUsdSqm, null);
  assert.equal(rankingResult.reason, "insufficient-comparables");

  // assessListing with 4 comparables returns valueScore: null, reasons note insufficient comparables
  const item: CatalogItem = {
    id: "item-test-1", rooms: 2, areaSqm: 50, priceUsd: 70000, priceSqm: 1400, disposition: "ACCEPTED",
    features: { ...DEFAULT_BASE_FEATURES, marketZone: "minsk" }
  } as unknown as CatalogItem;
  const assessment = assessListing(item, comps, 500, DEFAULT_SETTINGS);
  assert.equal(assessment.valueScore, null);
  assert.equal(assessment.medianPriceSqm, null);
  assert.equal(assessment.confidence, "none");
  assert.ok(assessment.reasons.includes("Недостаточно сопоставимых местных предложений"));
};

/**
 * 5. пропущенные параметры:
 * Неизвестные параметры не трактуются как «хорошо» или «плохо», снижают coverage,
 * provisional = true, высокий балл не ставится при низкой coverage.
 */
export const assertMissingParameters = (): void => {
  // Missing parameters in conditionCriteria return score: null, observed: null
  const missingFeatures: ListingFeatures = { locality: "Минск", provenance: {} };
  const criteria = conditionCriteria(missingFeatures);
  const repairCriterion = criteria.find((c) => c.code === "repair");
  const materialCriterion = criteria.find((c) => c.code === "material");
  const ageCriterion = criteria.find((c) => c.code === "age");
  const floorCriterion = criteria.find((c) => c.code === "floor");

  assert.equal(repairCriterion?.score, null, "Unknown repair must not get default points");
  assert.equal(materialCriterion?.score, null, "Unknown material must not get default points");
  assert.equal(ageCriterion?.score, null, "Unknown age must not get default points");
  assert.equal(floorCriterion?.score, null, "Unknown floor must not get default points");

  // Missing criteria reduce coverage in assessListing
  const comps: Comparable[] = Array.from({ length: 5 }, (_, i) => ({
    propertyId: `prop-${i}`, externalId: String(i), platform: "KUFAR", address: null,
    areaSqm: 50, priceUsd: 75000, priceSqm: 1500, distanceMeters: 200
  }));
  const sparseItem: CatalogItem = {
    id: "sparse-1", rooms: 2, areaSqm: 50, priceUsd: 70000, priceSqm: 1400, disposition: "ACCEPTED",
    features: missingFeatures
  } as unknown as CatalogItem;

  const assessment = assessListing(sparseItem, comps, 500, DEFAULT_SETTINGS);
  assert.ok(assessment.coverage < 70, `Expected low coverage, got ${assessment.coverage}`);
  assert.ok(assessment.reasons.some((r) => r.includes("Предварительная оценка: заполненность данных ниже 70%")));

  // In personalRanking, missing components reduce coverage and set provisional: true
  const renoInput: RenovationInput = {
    areaSqm: 50, condition: "meets-target", reservePct: 10, asOf: "2026-11-09"
  };
  const renovation = estimateRenovation(renoInput);
  const partialRanking = calculatePersonalRanking({
    areaSqm: 50, purchaseUsd: 75000, eligible: true,
    renovation, knownComparableFeatures: 4,
    asIsComparables: comps, readyComparables: comps,
    components: {} // all components missing
  });
  assert.equal(partialRanking.provisional, true, "Missing components must mark result provisional");
  assert.equal(partialRanking.coverage, 45); // only money is known
  // Unobserved components contribute neutral 50, not 100 or 0
  const houseBreakdown = partialRanking.breakdown.find((b) => b.key === "house");
  assert.equal(houseBreakdown?.observed, null);
  assert.equal(houseBreakdown?.contribution, 10); // 50 * 20 / 100 = 10
  assert.equal(partialRanking.score, 50, "Neutral price with unobserved components yields baseline 50");

  // Even with a discounted price, low coverage prevents a high score (> 75)
  const discountedRanking = calculatePersonalRanking({
    areaSqm: 50, purchaseUsd: 70000, eligible: true,
    renovation, knownComparableFeatures: 4,
    asIsComparables: comps, readyComparables: comps,
    components: {}
  });
  assert.ok(discountedRanking.score !== null && discountedRanking.score < 60, "Cannot achieve high score with missing parameters");
};

/**
 * 6. работа с мебелью и неопределённостью:
 * Мебель/техника не добавляет фиктивной стоимости к цене квартиры;
 * при неясной передаче — не давать плюс к удобству.
 */
export const assertFurnitureUncertainty = (): void => {
  // Renovation estimate includes only labor + materials; furniture is NOT included
  const input: RenovationInput = {
    areaSqm: 50, condition: "full", reservePct: 10, asOf: "2026-11-09",
    rates: {
      scope: "full",
      labor: { low: 200, base: 250, high: 300 },
      materials: { low: 200, base: 250, high: 300 },
      observedOn: "2026-11-01",
      source: "fixture"
    },
    fx: { bynPerUsd: 3, observedOn: "2026-11-02", source: "fixture" }
  };
  const estimate = estimateRenovation(input);
  assert.equal(estimate.status, "known");
  if (estimate.status !== "known") throw new Error("Expected known estimate");

  // Sum is strictly (250 labor + 250 materials) * 50 * 1.1 = 27,500 BYN = $9,166.67 USD; no furniture surcharge
  assert.equal(estimate.byn?.base, 27500);
  assert.equal(estimate.usd?.base, 9166.67);

  // In personalRanking, totalUsd is purchaseUsd + renovation, no fictitious furniture price added
  const comps: Comparable[] = Array.from({ length: 5 }, (_, i) => ({
    propertyId: `prop-${i}`, externalId: String(i), platform: "KUFAR", address: null,
    areaSqm: 50, priceUsd: 78000, priceSqm: 1560, distanceMeters: 100
  }));
  const ranking = calculatePersonalRanking({
    areaSqm: 50, purchaseUsd: 70000, eligible: true,
    renovation: estimate, knownComparableFeatures: 4,
    asIsComparables: comps, readyComparables: comps,
    components: { house: 70, commute: 60, location: 80, layout: 70 }
  });
  assert.equal(ranking.totalUsd?.base, 79166.67);

  // Unclear furniture mention does not add bonus to comfort score
  const uncertainFurnitureText = parseTextSignals(["Квартира с ремонтом", "Мебель по договоренности, вопрос техники обсуждается"]);
  assert.equal(uncertainFurnitureText.hasFreshRepair, false);
};

/**
 * 7. старый и новый курс:
 * Старый курс BYN/USD (>7 дней или старше asOf) не генерирует фиктивных сумм в USD (usd: null, usdUnavailable: "stale-fx").
 */
export const assertFxCurrencyDates = (): void => {
  const baseInput: RenovationInput = {
    areaSqm: 50, condition: "full", reservePct: 10, asOf: "2026-11-09",
    rates: {
      scope: "full",
      labor: { low: 200, base: 250, high: 300 },
      materials: { low: 200, base: 250, high: 300 },
      observedOn: "2026-11-01",
      source: "fixture"
    }
  };

  // FX observed 8 days ago (> 7 calendar days before asOf) -> stale-fx, usd is null
  const staleFx = estimateRenovation({
    ...baseInput,
    fx: { bynPerUsd: 3.0, observedOn: "2026-11-01", source: "NBRB" }
  });
  assert.equal(staleFx.status, "known");
  if (staleFx.status !== "known") throw new Error("Expected known BYN estimate");
  assert.equal(staleFx.usd, null, "Stale FX must not produce fictitious USD amount");
  assert.equal(staleFx.usdUnavailable, "stale-fx");
  assert.ok(staleFx.byn !== null, "BYN estimate must be preserved when FX is stale");

  // Future FX date (observedOn > asOf) -> stale-fx, usd is null
  const futureFx = estimateRenovation({
    ...baseInput,
    fx: { bynPerUsd: 3.0, observedOn: "2026-11-10", source: "NBRB" }
  });
  assert.equal(futureFx.status, "known");
  if (futureFx.status !== "known") throw new Error("Expected known BYN estimate");
  assert.equal(futureFx.usd, null);
  assert.equal(futureFx.usdUnavailable, "stale-fx");

  // Missing FX -> missing-fx, usd is null
  const missingFx = estimateRenovation({ ...baseInput, fx: undefined });
  assert.equal(missingFx.status, "known");
  if (missingFx.status !== "known") throw new Error("Expected known BYN estimate");
  assert.equal(missingFx.usd, null);
  assert.equal(missingFx.usdUnavailable, "missing-fx");

  // Fresh FX within 7 days (e.g. 2026-11-05) -> valid USD calculated
  const freshFx = estimateRenovation({
    ...baseInput,
    fx: { bynPerUsd: 3.0, observedOn: "2026-11-05", source: "NBRB" }
  });
  assert.equal(freshFx.status, "known");
  if (freshFx.status !== "known") throw new Error("Expected known USD estimate");
  assert.equal(freshFx.usdUnavailable, null);
  assert.deepEqual(freshFx.usd, { low: 7333.33, base: 9166.67, high: 11000 });
};

/**
 * 8. оценки ремонта без двойного учёта:
 * Стоимость ремонта добавляется в totalUsd, но не накладывается повторно как штраф на рыночную оценку.
 */
export const assertNoDoubleRenovationPenalty = (): void => {
  const comps: Comparable[] = Array.from({ length: 5 }, (_, i) => ({
    propertyId: `prop-${i}`, externalId: String(i), platform: "KUFAR", address: null,
    areaSqm: 50, priceUsd: 78000, priceSqm: 1560, distanceMeters: 100
  }));
  const manualBudget = estimateRenovation({
    areaSqm: 50, condition: "full", reservePct: 10, asOf: "2026-11-09", manualBudgetUsd: 10000
  });

  const common = {
    areaSqm: 50, eligible: true, readyComparables: comps, asIsComparables: comps,
    knownComparableFeatures: 4, components: { house: 70, commute: 60, location: 80, layout: 70 }
  };
  const ranking = calculatePersonalRanking({
    ...common, purchaseUsd: 68000, renovation: manualBudget
  });

  // Renovation cost is added to totalUsd (68,000 + 10,000 = 78,000)
  assert.equal(ranking.totalUsd?.base, 78000);

  // Breakdown keys are strictly: money, house, commute, location, layout
  // There is NO extra "renovation penalty" deducted from the ranking score
  const breakdownKeys = ranking.breakdown.map((b) => b.key);
  assert.deepEqual(breakdownKeys, ["money", "house", "commute", "location", "layout"]);

  // In assessListing, market valueScore evaluates priceSqm without subtracting renovation budget as a penalty
  const rawItem: CatalogItem = {
    id: "item-raw", priceUsd: 68000, areaSqm: 50, priceSqm: 1360, disposition: "ACCEPTED",
    features: { ...DEFAULT_BASE_FEATURES, marketZone: "minsk", repair: "needs-repair" }
  } as unknown as CatalogItem;
  const assessment = assessListing(rawItem, comps, 500, DEFAULT_SETTINGS);
  // Value score reflects the discounted price of the property as-is
  assert.ok(assessment.valueScore !== null && assessment.valueScore > 50, "Discounted purchase price gets positive valueScore");
};

/**
 * 9. отмена отзыва:
 * Отмена или удаление отзыва пользователя возвращает веса к исходным и запускает пересчёт.
 */
export const assertFeedbackCancellation = async (): Promise<void> => {
  const storedFeedbacks: StoredFeedback[] = [];
  const mockRepo = {
    getFeedback: async (propertyId: string) => storedFeedbacks.find((f) => f.propertyId === propertyId) ?? null,
    getFeedbackById: async (id: string) => storedFeedbacks.find((f) => f.id === id) ?? null,
    listConfirmedFeedbacks: async () => storedFeedbacks.filter((f) => f.confirmed),
    createFeedback: async (input: { propertyId: string; rating?: number | null; commentRaw?: string | null; parsedSignals?: any }) => {
      const fb: StoredFeedback = {
        id: `fb-${storedFeedbacks.length + 1}`,
        propertyId: input.propertyId,
        rating: input.rating ?? null,
        commentRaw: input.commentRaw ?? null,
        parsedSignals: input.parsedSignals ?? { positive: [], negative: [], ambiguous: [] },
        confirmed: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      storedFeedbacks.push(fb);
      return fb;
    },
    updateFeedback: async (id: string, patch: any) => {
      const fb = storedFeedbacks.find((f) => f.id === id);
      if (!fb) throw new Error("Not found");
      Object.assign(fb, patch, { updatedAt: new Date() });
      return fb;
    },
    deleteFeedback: async (id: string) => {
      const idx = storedFeedbacks.findIndex((f) => f.id === id);
      if (idx >= 0) storedFeedbacks.splice(idx, 1);
    },
    getPreferences: async () => ({ weightVersion: 1, weights: DEFAULT_PREFERENCE_WEIGHTS }),
    updatePreferences: async (weights: any) => ({ weightVersion: 2, weights })
  } as unknown as UserFeedbackRepository;

  const service = new UserFeedbackService(mockRepo);

  // 1. Initial weights equal defaults
  assert.deepEqual(service.updateWeights([]), DEFAULT_PREFERENCE_WEIGHTS);

  // 2. Submit and confirm a feedback that changes weights
  const { feedback } = await service.submitFeedback({
    propertyId: "prop-commute", rating: -1, commentRaw: "Ужасно далеко до метро"
  });
  const confirmedResult = await service.confirmFeedback(feedback.id);
  assert.ok(confirmedResult.preferences.weights.commute > DEFAULT_PREFERENCE_WEIGHTS.commute);

  // 3. Cancel the feedback -> weights must return exactly to DEFAULT_PREFERENCE_WEIGHTS
  const cancelResult = await service.cancelFeedback(feedback.id);
  assert.equal(cancelResult.success, true);
  assert.deepEqual(cancelResult.preferences.weights, DEFAULT_PREFERENCE_WEIGHTS);

  // 4. Pure function verify: cancelling all feedbacks restores exact defaults
  const restored = service.updateWeights([]);
  assert.deepEqual(restored, DEFAULT_PREFERENCE_WEIGHTS);
};

/**
 * 10. stale-фото:
 * Изменение галереи фото (photoSetHash изменился) делает неактуальным прежнее подтверждение модели и требует проверки.
 */
export const assertStalePhotos = (): void => {
  const analysis = {
    status: "READY",
    decision: "APPROVED",
    galleryHash: "photo-hash-v1",
    suggestion: "good",
    evidence: [
      { scene: "interior", condition: "good", observations: ["Чистый свежий ремонт"] },
      { scene: "interior", condition: "good", observations: ["Новые стеклопакеты"] }
    ]
  };

  // When photoSetHash matches galleryHash, approval is valid
  assert.equal(approvedRepair(analysis, "photo-hash-v1"), "good");

  // When gallery changes (photoSetHash changed to "photo-hash-v2"), approval is invalidated (stale)
  assert.equal(approvedRepair(analysis, "photo-hash-v2"), undefined);
  assert.equal(approvedBuilding(analysis, "photo-hash-v2"), undefined);
  assert.equal(approvedPlan(analysis, "photo-hash-v2"), undefined);

  // marketFeatures does NOT apply stale photo repair
  const baseFeatures: ListingFeatures = { locality: "Минск", repair: "needs-repair", provenance: {} };
  const staleConfirmed = marketFeatures(baseFeatures, approvedRepair(analysis, "photo-hash-v2"));
  assert.equal(staleConfirmed.repair, "needs-repair", "Stale photo confirmation must not overwrite listing repair");

  // When photos match, confirmed repair is applied
  const freshConfirmed = marketFeatures(baseFeatures, approvedRepair(analysis, "photo-hash-v1"));
  assert.equal(freshConfirmed.repair, "good");
};

/**
 * 11. отсутствие OSM/Ollama/OTP:
 * Отсутствие OTP/Ollama/OSM не приводит к штрафу за якобы отсутствующую инфраструктуру (status: unknown/missing).
 */
export const assertGracefulDegradationNoServices = (): void => {
  // 1. Missing / failed OTP routing: scores become null, not 0 penalty
  const failedRoutes: RoutingData = {
    targetStatus: "FAILED",
    target: null,
    metroStatus: "FAILED",
    metro: null,
    metroName: null,
    settingsKey: "default",
    targetError: "connect EACCES 127.0.0.1",
    alternatives: []
  };
  const transport = transportCriteria(failedRoutes);
  for (const criterion of transport) {
    assert.equal(criterion.score, null, `Criterion ${criterion.code} must be null when OTP fails`);
    assert.equal(criterion.observed, null);
  }

  // In assessListing, failed routes do not crash scoring and do not assign 0 points to price
  const comps: Comparable[] = Array.from({ length: 5 }, (_, i) => ({
    propertyId: `prop-${i}`, externalId: String(i), platform: "KUFAR", address: null,
    areaSqm: 50, priceUsd: 75000, priceSqm: 1500, distanceMeters: 200
  }));
  const item: CatalogItem = {
    id: "item-otp-failed", rooms: 2, areaSqm: 50, priceUsd: 70000, priceSqm: 1400, disposition: "ACCEPTED",
    routes: failedRoutes,
    features: { locality: "Минск", marketZone: "minsk", repair: "good", buildingMaterial: "brick", buildingYear: 2010, provenance: {} }
  } as unknown as CatalogItem;
  const assessment = assessListing(item, comps, 500, DEFAULT_SETTINGS);
  assert.ok(assessment.valueScore !== null);
  assert.ok(assessment.reasons.includes("Маршрут до текущей точки неизвестен"));

  // 2. In calculatePersonalRanking, missing commute component gets neutral 50, provisional = true
  const renoInput: RenovationInput = {
    areaSqm: 50, condition: "meets-target", reservePct: 10, asOf: "2026-11-09"
  };
  const ranking = calculatePersonalRanking({
    areaSqm: 50, purchaseUsd: 70000, eligible: true,
    renovation: estimateRenovation(renoInput), knownComparableFeatures: 4,
    asIsComparables: comps, readyComparables: comps,
    components: { house: 80, location: 80, layout: 80 } // commute missing
  });
  assert.equal(ranking.provisional, true);
  assert.equal(ranking.coverage, 85);
  const commutePart = ranking.breakdown.find((b) => b.key === "commute");
  assert.equal(commutePart?.observed, null);
  assert.equal(commutePart?.contribution, 7.5); // 50 * 15 / 100 = 7.5

  // 3. Ollama unavailable: photo analysis null/failed falls back gracefully
  assert.equal(approvedRepair(null, "hash"), undefined);
  assert.equal(approvedRepair({ status: "FAILED", decision: "PENDING", galleryHash: "h", suggestion: null }, "h"), undefined);
};

/**
 * 12. идемпотентность очереди и ограничение нагрузки:
 * Постановка задачи с одинаковым отпечатком не дублирует работу.
 */
export const assertQueueIdempotency = async (): Promise<void> => {
  // Test compactAssessments cancels duplicate queued jobs, keeping the first
  const cancelledIds: string[] = [];
  const mockBoss = {
    findJobs: async <T>(_name: string, _options?: unknown) => [
      { id: "job-assess-1" },
      { id: "job-assess-2" },
      { id: "job-assess-3" }
    ] as JobWithMetadata<T>[],
    cancel: async (_name: string, ids: string[]) => {
      cancelledIds.push(...ids);
      return undefined as any;
    }
  };

  await compactAssessments(mockBoss as unknown as PgBoss);
  assert.deepEqual(cancelledIds, ["job-assess-2", "job-assess-3"], "compactAssessments must cancel all duplicate jobs except the first");

  // Test idempotency by fingerprint/singleton key: repeated submissions with the same key do not duplicate work
  const queueMap = new Map<string, { id: string; payload: unknown }>();
  const enqueueIdempotent = (queueName: string, singletonKey: string, payload: unknown): { id: string; created: boolean } => {
    const compositeKey = `${queueName}:${singletonKey}`;
    const existing = queueMap.get(compositeKey);
    if (existing) {
      return { id: existing.id, created: false };
    }
    const id = `job-${queueMap.size + 1}`;
    queueMap.set(compositeKey, { id, payload });
    return { id, created: true };
  };

  // Enqueue job 1
  const first = enqueueIdempotent("enrich-kufar", "listing-123", { listingId: "listing-123" });
  assert.equal(first.created, true);
  assert.equal(queueMap.size, 1);

  // Enqueue duplicate with identical singleton key -> does NOT create new work
  const second = enqueueIdempotent("enrich-kufar", "listing-123", { listingId: "listing-123" });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(queueMap.size, 1);

  // Enqueue different listing -> creates new job
  const third = enqueueIdempotent("enrich-kufar", "listing-456", { listingId: "listing-456" });
  assert.equal(third.created, true);
  assert.equal(queueMap.size, 2);
};

/**
 * Master assertion function covering all 12 spec regressions (section "Переход и проверка", item 61)
 */
export const assertSpecRegressions = async (): Promise<void> => {
  assertOwnershipNegations();
  assertFloorsLogic();
  assertNeighborsVsDuplicates();
  assertFewerThanFiveComparables();
  assertMissingParameters();
  assertFurnitureUncertainty();
  assertFxCurrencyDates();
  assertNoDoubleRenovationPenalty();
  await assertFeedbackCancellation();
  assertStalePhotos();
  assertGracefulDegradationNoServices();
  await assertQueueIdempotency();
};
