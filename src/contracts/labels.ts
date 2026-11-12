export const platformLabels = { KUFAR: "Куфар", ONLINER: "Онлайнер", REALT: "Реалт" } as const;
export const materialLabels = { brick: "Кирпичный", panel: "Панельный", monolith: "Монолитный", block: "Блочный", wood: "Деревянный", other: "Другой" } as const;
export const repairLabels = { none: "Без отделки", "needs-repair": "Под ремонт", cosmetic: "Косметический", good: "Хороший ремонт", designer: "Дизайнерский" } as const;
export const layoutLabels = { isolated: "Изолированные комнаты", "walk-through": "Проходные комнаты", open: "Открытая планировка" } as const;
export const readinessLabels = { ready: "Готова к проживанию", unfinished: "Нужна отделка", construction: "Строится" } as const;
export const sellerLabels = { owner: "Собственник", agent: "Агентство", developer: "Застройщик" } as const;
export const confidenceLabels = { none: "Нет оценки", low: "Низкая надёжность", medium: "Средняя надёжность", high: "Высокая надёжность" } as const;
export const routeModeLabels: Readonly<Record<string, string>> = { WALK: "Пешком", BUS: "Автобус", TRAM: "Трамвай", TROLLEYBUS: "Троллейбус", SUBWAY: "Метро", RAIL: "Поезд", FERRY: "Паром" };
export const buildingConditionLabels = { maintained: "Ухоженный фасад", worn: "Видимый износ фасада", "visible-damage": "Видимые повреждения фасада" } as const;
export const routeLegLabel = (mode: string, route: string | null): string => {
  const prefix = `${mode.toLowerCase()} `;
  const name = route?.trim();
  const number = name?.toLowerCase().startsWith(prefix) ? name.slice(prefix.length) : name;
  return `${routeModeLabels[mode] ?? mode}${number ? ` ${number}` : ""}`;
};
