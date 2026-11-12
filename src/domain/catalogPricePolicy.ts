import type { CatalogItem } from "../contracts/catalog.js";
import { buildingConditionLabels, layoutLabels, materialLabels, readinessLabels, repairLabels } from "../contracts/labels.js";

export const PRICE_POLICY = {
  minimumComparables: 5, radiusMeters: [500, 1000, 2000], areaTolerance: 0.2, yearTolerance: 20,
  freshnessDays: 30, base: 50, curveScale: 15, samplePrior: 5,
  matchedFeatures: ["repair", "buildingMaterial", "readiness", "layout"]
} as const;

export const comparisonRules = ({ features: f, rooms, confirmedBuilding }: Pick<CatalogItem, "features" | "rooms" | "confirmedBuilding">): string[] => {
  const zone = f.marketZone === "minsk:shabany" ? "Шабаны" : f.marketZone === "minsk:sokol" ? "Сокол" : f.locality ?? f.marketZone;
  const known = [f.repair && `ремонт: ${repairLabels[f.repair]}`, f.buildingMaterial && `материал: ${materialLabels[f.buildingMaterial]}`,
    f.readiness && `готовность: ${readinessLabels[f.readiness]}`, f.layout && `планировка: ${layoutLabels[f.layout]}`].filter(Boolean);
  return [
    `Только активные предложения, замеченные за последние ${PRICE_POLICY.freshnessDays} дней. Одна запись на квартиру; сам объект исключён.`,
    `Столько же комнат (${rooms}) и тот же тип: ${f.isStudio === undefined ? "не определён" : f.isStudio ? "студия" : "не студия"}. Зона сравнения: ${zone ?? "не определена"}.`,
    `Площадь в пределах ±${PRICE_POLICY.areaTolerance * 100}%. Поиск по радиусам ${PRICE_POLICY.radiusMeters.join(" / ")} м; используется первый с минимум ${PRICE_POLICY.minimumComparables} аналогами.`,
    ...(known.length ? [`Должны совпасть известные параметры: ${known.join("; ")}.`] : []),
    ...(f.buildingYear === undefined ? [] : [`Год постройки: ${f.buildingYear} ± ${PRICE_POLICY.yearTolerance} лет.`]),
    ...(confirmedBuilding ? [`Состояние дома по подтверждённым фото: ${buildingConditionLabels[confirmedBuilding]}. В выборке только дома с той же подтверждённой категорией.`] : []),
    "Неизвестные характеристики квартиры не ограничивают поиск. Медиана отражает цены предложений, а не сделок."
  ];
};
