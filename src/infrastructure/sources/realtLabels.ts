// REALT flat-sale category 5 shortcuts, captured 2026-11-10 from https://realt.by/sale/flats/.
// The minimal source dictionary and provenance are pinned in tests/fixtures/realtCategoryLabels.json.
const houseTypes: Readonly<Record<string, string>> = {
  "1": "Панельный", "0": "Кирпичный", "3": "Монолитный", "5": "Силикатные блоки",
  "11": "Каркасно-блочный", "2": "Блок-комнаты", "6": "Бревенчатый"
};
const repairStates: Readonly<Record<string, string>> = {
  "2": "хороший", "3": "нормальный", "5": "плохое состояние", "7": "без отделки", "8": "строительная отделка"
};

const sourceLabel = (value: string | number | null | undefined, labels: Readonly<Record<string, string>>): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && !/^\s*[+\-]?(?:\d|\.\d)/.test(value)) return value.trim() ? value : undefined;
  const code = String(value).trim();
  return /^\d+$/.test(code) ? labels[code] : undefined;
};

export const realtHouseTypeLabel = (value: string | number | null | undefined): string | undefined => sourceLabel(value, houseTypes);
export const realtRepairStateLabel = (value: string | number | null | undefined): string | undefined => sourceLabel(value, repairStates);
