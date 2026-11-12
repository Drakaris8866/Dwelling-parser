import type { ListingCandidate } from "../domain/listing.js";
import { featuresSchema, type ListingFeatures } from "../contracts/catalog.js";

export const cleanText = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/[‐‑–—−]/g, "-").replace(/\s+/g, " ").trim();
export const firstNumber = (value: string | undefined): number | undefined => {
  const match = value?.replace(/\s/g, "").match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return undefined;
  const number = Number(match[0].replace(",", "."));
  return Number.isFinite(number) ? number : undefined;
};
export const detailValue = (details: readonly string[], labels: readonly string[]): string | undefined => {
  for (const detail of details) {
    const separator = detail.indexOf(":");
    if (separator >= 0 && labels.some((label) => cleanText(label) === cleanText(detail.slice(0, separator)))) return detail.slice(separator + 1).trim();
  }
  return undefined;
};
export const normalizeAddress = (value: string): string => cleanText(value).replace(/ё/giu, "е").replace(/(?:улица|ул\.|проспект|пр-т|город|г\.)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const comparableAddress = (address: string, locality: string | null): string => {
  const place = normalizeAddress(locality ?? "");
  return normalizeAddress(address).split(" ").filter((word) => word !== "беларусь" && (!place || !place.split(" ").includes(word))).join(" ");
};

export const parseMaterial = (value: string | undefined): ListingFeatures["buildingMaterial"] => {
  const text = cleanText(value ?? "");
  if (/кирпич/.test(text)) return "brick";
  if (/панел/.test(text)) return "panel";
  if (/монолит|каркас/.test(text)) return "monolith";
  if (/блок|блоч/.test(text)) return "block";
  if (/дерев/.test(text)) return "wood";
  return undefined;
};

export const explicitElevator = (description: string): boolean | undefined => {
  const text = cleanText(description);
  if (/лифт[^.!?;]{0,30}(?:не работает|неисправ|сломан|отключ)/u.test(text)) return undefined;
  let present = false, absent = false;
  for (const clause of text.split(/[.!?;]/u)) {
    if (/планиру|проект|будет|предстоит/u.test(clause)) continue;
    const negative = /(?:дом|подъезд)[^.!?;]{0,80}(?:нет лифта|без лифта|не (?:оборудован|оснащ[её]н)[^.!?;]{0,30}лифт)/u.test(clause)
      || /^(?:\s*)(?:лифта нет|лифт отсутствует)/u.test(clause);
    if (negative) { absent = true; continue; }
    if (/(?:дом|подъезд)[^.!?;]{0,100}(?:оснащ[её]н|оборудован)[^.!?;]{0,50}лифт/u.test(clause)
      || /в (?:доме|подъезде)[^.!?;]{0,40}(?:есть|установлен|два|2)[^.!?;]{0,20}лифт/u.test(clause)) present = true;
  }
  return present === absent ? undefined : present;
};
export const parseRepair = (value: string | undefined): ListingFeatures["repair"] => {
  const text = cleanText(value ?? "");
  if (/без отделки|чернов|строительн.*отделк/.test(text)) return "none";
  if (/под ремонт|требует.*ремонт|нужен.*ремонт|без ремонта/.test(text)) return "needs-repair";
  if (/дизайнер/.test(text)) return "designer";
  if (/^евро$|евроремонт|евро.?ремонт|хорош|отличн|свеж.*ремонт/.test(text)) return "good";
  if (/космет|удовлетвор/.test(text)) return "cosmetic";
  return undefined;
};
export const parseBoolean = (value: string | undefined): boolean | undefined => {
  const text = cleanText(value ?? "");
  if (/^(нет|no|false|отсутствует|без балкона)$/.test(text)) return false;
  if (/^(есть|да|yes|true|балкон|лоджия|2 балкона|балкон и лоджия)$/.test(text)) return true;
  return undefined;
};
export const normalizeLocality = (value: string): string => value.replace(/^(?:г\.|д\.|аг\.|п\.|город|деревня|агрогородок|пос[её]лок)\s*/i, "").trim();
export const localityFromPropertyAddress = (address: string | undefined): string | undefined => {
  if (!address) return undefined;
  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
  const candidate = parts.find((part) => !/беларус|белорус|област|воблас|район|раён|р-н|сельс|сельск|сельскі|савет|совет|council|rural|улиц|вуліц|улица|проспект|пр-т|переул|пер\.|линия|лінія|\d/iu.test(part));
  return candidate ? normalizeLocality(candidate) : undefined;
};
export const usableLocality = (value: string | undefined, address: string | undefined): string | undefined => {
  if (value && !/беларус|белорус|област|воблас|район|раён|савет|совет|сельс|сельск|сельскі|council|rural/iu.test(value)) return normalizeLocality(value);
  return localityFromPropertyAddress(address);
};

export const inferFeatures = (candidate: Pick<ListingCandidate, "title" | "description" | "details" | "houseType" | "repairState" | "features" | "rooms">): ListingFeatures => {
  const existing = candidate.features ?? featuresSchema.parse({});
  const detail = (...labels: string[]): string | undefined => detailValue(candidate.details, labels);
  const floorText = detail("Этаж", "Floor");
  const floorParts = floorText?.split(/\/|\s+из\s+/iu);
  const locality = existing.locality ?? detail("Населенный пункт", "Населённый пункт", "Locality", "Town", "Город");
  const district = existing.district ?? detail("Район", "District", "Микрорайон");
  const repair = existing.repair ?? parseRepair(candidate.repairState ?? detail("Ремонт", "Repair"));
  const layoutText = detail("Планировка", "Layout", "Проходные комнаты");
  const studio = /(?:^|[^\p{L}])студи(?:я|ю|и)(?:$|[^\p{L}])|\bstudio\b/iu.test(candidate.title);
  const zone = /шабан/iu.test(`${district ?? ""} ${existing.address ?? ""}`) ? "minsk:shabany"
    : /(?:^|[^\p{L}])сокол(?:$|[^\p{L}])/iu.test(`${district ?? ""} ${existing.address ?? ""}`) ? "minsk:sokol"
      : locality === undefined ? undefined : cleanText(normalizeLocality(locality));
  const inferred = {
    address: detail("Адрес", "Address"), locality: locality === undefined ? undefined : normalizeLocality(locality), district,
    marketZone: zone, complex: detail("ЖК", "Complex"),
    isStudio: studio ? true : candidate.rooms > 1 ? false : undefined,
    kitchenSqm: firstNumber(detail("Кухня", "Kitchen", "Kitchen area")),
    livingSqm: firstNumber(detail("Жилая площадь", "Living", "Living area")),
    floor: firstNumber(floorParts?.[0]), totalFloors: firstNumber(detail("Этажей", "Этажность", "Этажей в доме", "Floors") ?? floorParts?.[1]),
    buildingYear: firstNumber(detail("Год постройки", "Built", "Year")),
    buildingMaterial: parseMaterial(candidate.houseType ?? detail("Тип дома", "House type")), repair,
    layout: layoutText === undefined ? undefined : /изолир/i.test(layoutText) ? "isolated" : /проход|смежн|^да$/i.test(layoutText) ? "walk-through" : undefined,
    balcony: parseBoolean(detail("Балкон", "Balcony")), elevator: parseBoolean(detail("Лифт", "Elevator")) ?? explicitElevator(candidate.description),
    bathroom: /раздельн/i.test(detail("Санузел", "Bathroom") ?? "") ? "separate" : /совмещ/i.test(detail("Санузел", "Bathroom") ?? "") ? "combined" : undefined,
    ceilingMeters: firstNumber(detail("Потолки", "Ceiling")),
    readiness: repair === "none" || repair === "needs-repair" ? "unfinished" : repair === "cosmetic" || repair === "good" || repair === "designer" ? "ready" : undefined,
    ...existing
  };
  const provenance = { ...existing.provenance };
  if (existing.elevator === undefined && parseBoolean(detail("Лифт", "Elevator")) === undefined && inferred.elevator !== undefined) provenance["elevator"] = "description";
  if (existing.readiness === undefined && inferred.readiness !== undefined) provenance["readiness"] = "inferred";
  for (const [key, value] of Object.entries(inferred)) if (value !== undefined && key !== "provenance" && provenance[key] === undefined) provenance[key] = "legacy";
  return featuresSchema.parse({ ...inferred, provenance });
};

export const inMinskCollectionArea = (locality: string | undefined, district: string | undefined): boolean | undefined => {
  if (locality !== undefined && /^минск$/iu.test(normalizeLocality(locality))) return true;
  if (district !== undefined && /^минск(?:ий|ого|ому)?(?:\s+(?:район|р-н))?$/iu.test(district.trim())) return true;
  if (locality !== undefined && /^(боровляны|копище)$/iu.test(normalizeLocality(locality))) return true;
  return undefined;
};

export const routeSummary = (legs: readonly { readonly mode: string; readonly route: string | null; readonly durationMinutes: number }[]): string =>
  legs.map((leg) => `${leg.mode}${leg.route ? ` line ${leg.route},` : ""} ${Math.round(leg.durationMinutes)}m`).join(" -> ");
