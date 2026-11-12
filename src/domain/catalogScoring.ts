import type { CatalogAssessment, CatalogItem, CatalogSettings, Comparable, RenovationScenario, ScoringCriterion } from "../contracts/catalog.js";
import { conditionCriteria, layoutCriteria, transportCriteria } from "./catalogCriteria.js";
import { comparisonRules, PRICE_POLICY } from "./catalogPricePolicy.js";
import { marketFeatures } from "./repairEvidence.js";
import { evaluatePrice, knownPriceFeatures, roundRating as round } from "./priceRating.js";

export const SCORING_VERSION = "catalog-1.5";
export { medianOf } from "./priceRating.js";
const aggregate = (metrics: readonly ScoringCriterion[]): { score: number | null; coverage: number } => {
  const known = metrics.filter((m) => m.score !== null);
  const totalWeight = metrics.reduce((sum, m) => sum + m.weight, 0);
  const knownWeight = known.reduce((sum, m) => sum + m.weight, 0);
  return { score: knownWeight === 0 ? null : round(known.reduce((sum, m) => sum + m.score! * m.weight, 0) / knownWeight), coverage: round(knownWeight / totalWeight * 100) };
};
const component = (code: string, label: string, weight: number, criteria: ScoringCriterion[]): CatalogAssessment["components"][number] => {
  const { score, coverage } = aggregate(criteria);
  return { code, label, weight, criteria, score, coverage, points: (score ?? 0) * coverage / 100 * weight / 100 };
};
type ComparableSubject = Pick<CatalogItem, "id" | "rooms" | "areaSqm" | "features" | "confirmedBuilding">;
export const comparableMatches = (subject: ComparableSubject, candidate: ComparableSubject & Pick<CatalogItem, "disposition">): boolean => {
  if (subject.id === candidate.id || candidate.disposition !== "ACCEPTED" || subject.rooms !== candidate.rooms) return false;
  if (subject.confirmedBuilding && candidate.confirmedBuilding !== subject.confirmedBuilding) return false;
  const a = subject.features;
  const b = candidate.features;
  if (a.marketZone === undefined || b.marketZone !== a.marketZone) return false;
  // Unknown studio status cannot safely be mixed with either known layout class.
  if (a.isStudio === undefined || b.isStudio !== a.isStudio) return false;
  if (Math.abs(candidate.areaSqm - subject.areaSqm) / subject.areaSqm > PRICE_POLICY.areaTolerance) return false;
  for (const key of PRICE_POLICY.matchedFeatures) {
    if (a[key] !== undefined && b[key] !== a[key]) return false;
  }
  if (a.buildingYear !== undefined && (b.buildingYear === undefined || Math.abs(a.buildingYear - b.buildingYear) > PRICE_POLICY.yearTolerance)) return false;
  return true;
};

export const assessRenovation = (item: CatalogItem, budgetUsd: number, comparables: readonly Comparable[], radius: number | null): RenovationScenario => {
  const totalUsd = Math.round((item.priceUsd + budgetUsd) * 100) / 100, priceSqm = totalUsd / item.areaSqm;
  const price = evaluatePrice(priceSqm, comparables, item.disposition === "ACCEPTED", knownPriceFeatures({ ...item.features, repair: "good" }));
  return { budgetUsd, purchaseUsd: item.priceUsd, totalUsd, priceSqm, medianPriceSqm: price.median, discountPct: price.discount,
    valueScore: price.score, radiusMeters: radius, comparables: [...comparables] };
};

export const assessListing = (item: CatalogItem, comparables: readonly Comparable[], radius: number | null, settings: CatalogSettings): CatalogAssessment => {
  const features = marketFeatures(item.features, item.confirmedRepair);
  const known = knownPriceFeatures(features);
  const { median, discount, low, high, score: valueScore, spread: priceSpread, evidenceWeight } = evaluatePrice(item.priceSqm, comparables, item.disposition === "ACCEPTED", known);
  const usable = median !== null, spread = priceSpread ?? 1;
  const confidence = !usable ? "none" : comparables.length >= 10 && known >= 3 && features.repair !== undefined && features.buildingMaterial !== undefined && spread <= 0.25 ? "high" : known >= 2 && features.repair !== undefined && spread <= 0.4 ? "medium" : "low";
  const condition = conditionCriteria({ ...item.features, repair: features.repair }, undefined, item.confirmedBuilding).map((criterion) => item.confirmedRepair && criterion.code === "repair" ? { ...criterion, observed: `${criterion.observed} · подтверждено по фото` } : criterion);
  const components = [
    component("transport", "Транспорт", settings.transportWeight, transportCriteria(item.routes)),
    component("condition", "Состояние квартиры и дома", settings.conditionWeight, condition),
    component("layout", "Планировка", settings.layoutWeight, layoutCriteria(item.features, item.areaSqm))
  ];
  const coverage = round(components.reduce((sum, part) => sum + part.coverage * part.weight / 100, 0));
  const comfort = components.reduce((sum, part) => sum + (part.points ?? 0), 0);
  const reasons = [
    median === null ? "Недостаточно сопоставимых местных предложений" : `${comparables.length} аналогов в радиусе ${radius} м; цены предложений, не сделок`,
    ...(coverage < 70 ? ["Предварительная оценка: заполненность данных ниже 70%"] : []),
    ...(features.repair === "none" || features.repair === "needs-repair" ? ["Потребуется бюджет на ремонт"] : []),
    ...(!item.routes?.target ? ["Маршрут до текущей точки неизвестен"] : [])
  ];
  return {
    version: SCORING_VERSION, valueScore,
    comfortScore: coverage === 0 ? null : round(comfort), coverage, confidence,
    comparableCount: comparables.length, radiusMeters: radius, discountPct: discount, medianPriceSqm: median,
    priceEvidence: { priceSqm: item.priceSqm, rules: comparisonRules({ ...item, features }), base: PRICE_POLICY.base, rawScore: valueScore, curveScale: PRICE_POLICY.curveScale, evidenceWeight,
      repair: features.repair, repairSource: item.confirmedRepair ? "photo" : "listing",
      confidenceEvidence: usable ? `Аналогов: ${comparables.length}; известно ${known} из 4 признаков сходства (ремонт, материал, год, планировка); межквартильный разброс: ${round(spread * 100)}% от медианы.` : null },
    priceRangeLow: low, priceRangeHigh: high, reasons, components, comparables: [...comparables], calculatedAt: new Date().toISOString()
  };
};
