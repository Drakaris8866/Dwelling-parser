import type { ListingFeatures, RoutingData, ScoringCriterion } from "../contracts/catalog.js";
import { buildingConditionLabels, layoutLabels, materialLabels, readinessLabels, repairLabels } from "../contracts/labels.js";
import type { PhotoBuildingCategory } from "../contracts/photoRepair.js";

export const clampScore = (value: number): number => Math.min(100, Math.max(0, value));
const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
type CriterionKey = Pick<ScoringCriterion, "code" | "label" | "weight">;

const choice = <K extends string>(key: CriterionKey, value: K | undefined, labels: Readonly<Record<K, string>>, points: Readonly<Record<K, number>>): ScoringCriterion => ({
  ...key, observed: value === undefined ? null : labels[value], score: value === undefined ? null : points[value],
  rule: (Object.keys(points) as K[]).map((entry) => `${labels[entry]}: ${points[entry]}`).join("; ")
});
const linear = (key: CriterionKey, value: number | undefined, good: number, bad: number, unit = ""): ScoringCriterion => ({
  ...key, observed: value === undefined ? null : `${value}${unit}`,
  score: value === undefined ? null : clampScore(100 * (bad - value) / (bad - good)),
  rule: `До ${good}${unit}: 100; от ${bad}${unit}: 0. Между порогами балл снижается линейно.`
});

export const transportCriteria = (routes: RoutingData | null): ScoringCriterion[] => [
  linear({ code: "commute", label: "Время до точки назначения", weight: 55 }, routes?.target?.durationMinutes, 15, 90, " мин"),
  linear({ code: "walk", label: "Ходьба по маршруту", weight: 15 }, routes?.target?.walkingMinutes, 5, 40, " мин"),
  linear({ code: "transfers", label: "Число пересадок", weight: 10 }, routes?.target?.transfers, 0, 4),
  linear({ code: "metro", label: "Пешком до метро", weight: 20 }, routes?.metro?.durationMinutes, 5, 35, " мин")
];

export const conditionCriteria = (f: ListingFeatures, year = new Date().getFullYear(), building?: PhotoBuildingCategory): ScoringCriterion[] => [
  choice({ code: "repair", label: "Ремонт", weight: building ? 35 : 40 }, f.repair, repairLabels, { none: 15, "needs-repair": 20, cosmetic: 60, good: 85, designer: 95 }),
  { code: "age", label: "Возраст дома", weight: building ? 15 : 20, observed: f.buildingYear === undefined ? null : `${f.buildingYear} г. постройки`,
    score: f.buildingYear === undefined ? null : clampScore(100 - Math.max(0, year - f.buildingYear - 15) * 0.9),
    rule: `На ${year} г.: первые 15 лет — 100 баллов, далее минус 0,9 балла за каждый год сверх 15.` },
  choice({ code: "material", label: "Материал дома", weight: building ? 10 : 15 }, f.buildingMaterial, materialLabels, { brick: 85, panel: 60, monolith: 85, block: 65, wood: 35, other: 50 }),
  ...(building ? [choice({ code: "facade", label: "Фасад · подтверждено по фото", weight: 15 }, building, buildingConditionLabels, { maintained: 85, worn: 50, "visible-damage": 20 })] : []),
  { code: "floor", label: "Этаж", weight: 10, observed: f.floor === undefined || f.totalFloors === undefined ? null : `${f.floor} из ${f.totalFloors}`,
    score: f.floor === undefined || f.totalFloors === undefined ? null : f.floor === 1 ? 55 : f.floor === f.totalFloors ? 60 : 85,
    rule: "Первый: 55; последний, кроме первого: 60; остальные: 85." },
  { code: "elevator", label: "Лифт", weight: 5,
    observed: f.elevator === true ? "Есть" : f.elevator === false ? `Нет${f.floor === undefined ? ", этаж не указан" : `, этаж ${f.floor}`}` : f.totalFloors !== undefined && f.totalFloors <= 3 ? `Не указан, в доме ${f.totalFloors} эт.` : null,
    score: f.elevator === undefined ? (f.totalFloors !== undefined && f.totalFloors <= 3 ? 85 : null) : f.elevator ? 90 : f.floor !== undefined && f.floor <= 3 ? 80 : 30,
    rule: "Есть: 90; нет, этаж до третьего: 80; нет, этаж выше или неизвестен: 30; лифт не указан в доме до трёх этажей: 85." },
  choice({ code: "readiness", label: "Готовность", weight: 10 }, f.readiness, readinessLabels, { ready: 100, unfinished: 40, construction: 10 })
];

export const layoutCriteria = (f: ListingFeatures, area: number): ScoringCriterion[] => [
  choice({ code: "layout", label: "Планировка", weight: 35 }, f.layout, layoutLabels, { isolated: 95, "walk-through": 35, open: 60 }),
  { code: "kitchen", label: "Доля кухни в площади", weight: 30,
    observed: f.kitchenSqm === undefined ? null : `${number.format(f.kitchenSqm)} м² · ${number.format(f.kitchenSqm / area * 100)}%`,
    score: f.kitchenSqm === undefined ? null : clampScore(f.kitchenSqm / area * 500), rule: "Процент площади кухни × 5, максимум 100." },
  { code: "living", label: "Доля жилой площади", weight: 15,
    observed: f.livingSqm === undefined ? null : `${number.format(f.livingSqm)} м² · ${number.format(f.livingSqm / area * 100)}%`,
    score: f.livingSqm === undefined ? null : clampScore(100 - Math.abs(f.livingSqm / area - 0.6) * 250), rule: "Доля 60%: 100 баллов; минус 2,5 за каждый процентный пункт отклонения." },
  choice({ code: "balcony", label: "Балкон или лоджия", weight: 10 }, f.balcony === undefined ? undefined : f.balcony ? "yes" : "no", { yes: "Есть", no: "Нет" }, { yes: 90, no: 40 }),
  choice({ code: "bathroom", label: "Санузел", weight: 10 }, f.bathroom, { separate: "Раздельный", combined: "Совмещённый" }, { separate: 90, combined: 65 })
];
