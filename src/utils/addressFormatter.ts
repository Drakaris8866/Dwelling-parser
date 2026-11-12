export interface AddressFormatInput {
  address?: string | null | undefined;
  locality?: string | null | undefined;
  title?: string | null | undefined;
}

const STREET_TYPE_MAP: Array<{ regex: RegExp; canonical: string; isSuffix?: boolean }> = [
  { regex: /(?<![\p{L}])(?:улица|ул\.?|вуліца|вул\.?)(?![\p{L}])/iu, canonical: "ул." },
  { regex: /(?<![\p{L}])(?:проспект|просп\.?|пр-т\.?|пр\.?|праспект)(?![\p{L}])/iu, canonical: "просп." },
  { regex: /(?<![\p{L}])(?:переулок|пер\.?|завулак|зав\.?)(?![\p{L}])/iu, canonical: "пер." },
  { regex: /(?<![\p{L}])(?:бульвар|бул\.?|б-р\.?)(?![\p{L}])/iu, canonical: "бул." },
  { regex: /(?<![\p{L}])(?:площадь|пл\.?|плошча)(?![\p{L}])/iu, canonical: "пл." },
  { regex: /(?<![\p{L}])(?:проезд|пр-д\.?)(?![\p{L}])/iu, canonical: "проезд" },
  { regex: /(?<![\p{L}])(?:тракт)(?![\p{L}])/iu, canonical: "тракт", isSuffix: true },
  { regex: /(?<![\p{L}])(?:набережная|наб\.?)(?![\p{L}])/iu, canonical: "наб." },
  { regex: /(?<![\p{L}])(?:шоссе)(?![\p{L}])/iu, canonical: "шоссе", isSuffix: true },
  { regex: /(?<![\p{L}])(?:тупик)(?![\p{L}])/iu, canonical: "тупик" }
];

const COUNCIL_OR_ADMIN_REGEX =
  /(?<![\p{L}])(?:республика беларусь|беларусь|беларус|belarus|минская область|область|обл\.?|вобласць|вобл\.?|район|раён|р-н|сельский совет|сельсовет|сельскі савет|савет|совет|rural council|council)(?![\p{L}])/iu;

export function cleanLocality(value: string): string {
  return value
    .replace(/^(?:г\.|д\.|аг\.|п\.|город|деревня|агрогородок|пос[её]лок)\s*/iu, "")
    .replace(/[‐‑–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeStreetAndHouse(raw: string): string {
  let s = raw
    .replace(/[‐‑–—−]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\s*,\s*|\s*,\s*$/g, "")
    .trim();

  if (!s) return "";

  let house: string | undefined = undefined;

  // Check for house number at the end (e.g., ", 28", " 135 А", " 20 б", " д. 26", " дом 10к2", " 99 2")
  const houseRegex = /(?:\s*,\s*|\s+)(?:(?:д\.|дом)\s*)?(\d+(?:[\s\/-]*[а-яёА-ЯЁ])?(?:\s*(?:к|корп|к\.|корп\.)\s*\d+[а-яёА-ЯЁ]?|\s*[\/-]\s*\d+[а-яёА-ЯЁ]?|\s+\d+[а-яёА-ЯЁ]?)?)\s*$/iu;
  const houseMatch = s.match(houseRegex);

  if (houseMatch && houseMatch.index !== undefined) {
    const candidateHouse = houseMatch[1]!.trim();
    const before = s.slice(0, houseMatch.index).trim();
    if (before.length > 0 && !/[-–]$/.test(before)) {
      house = candidateHouse
        .replace(/(\d+)\s*,\s*([а-яёА-ЯЁ])/iu, "$1$2")
        .replace(/(\d+)\s+([а-яёА-ЯЁ])(?![а-яёА-ЯЁ])/iu, "$1$2")
        .replace(/(\d+)\s*к(?:\.|орп)?\.?\s*(\d+)/iu, "$1к$2")
        .replace(/(\d+)\s+(\d+)$/u, "$1к$2");
      s = before;
    }
  }

  // Remove trailing comma from street if any
  s = s.replace(/,\s*$/, "").trim();

  // Find street type
  let matchedType: { canonical: string; isSuffix?: boolean } | undefined;
  let streetNameWithoutType = s;

  for (const item of STREET_TYPE_MAP) {
    if (item.regex.test(s)) {
      matchedType = item;
      streetNameWithoutType = s.replace(item.regex, " ").replace(/\s+/g, " ").trim();
      break;
    }
  }

  streetNameWithoutType = streetNameWithoutType
    .replace(/^,\s*|,\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  let formattedStreet: string;
  if (matchedType) {
    if (matchedType.isSuffix) {
      formattedStreet = `${streetNameWithoutType} ${matchedType.canonical}`.trim();
    } else {
      formattedStreet = `${matchedType.canonical} ${streetNameWithoutType}`.trim();
    }
  } else {
    formattedStreet = streetNameWithoutType;
  }

  if (house) {
    return `${formattedStreet}, ${house}`;
  }
  return formattedStreet;
}

export function formatDisplayAddress(
  addressOrItem: AddressFormatInput | string | null | undefined,
  maybeLocality?: string | null | undefined,
  fallbackTitle?: string | null | undefined
): string {
  let rawAddress: string | null | undefined;
  let rawLocality: string | null | undefined;
  let rawTitle: string | null | undefined;

  if (typeof addressOrItem === "object" && addressOrItem !== null) {
    rawAddress = addressOrItem.address;
    rawLocality = addressOrItem.locality;
    rawTitle = addressOrItem.title;
  } else {
    rawAddress = addressOrItem;
    rawLocality = maybeLocality;
    rawTitle = fallbackTitle;
  }

  const address = rawAddress?.trim() || "";
  let locality = rawLocality?.trim() || "";

  if (!address && !locality) {
    return rawTitle?.trim() || "";
  }

  const isCouncilOrAdmin = (str: string): boolean => COUNCIL_OR_ADMIN_REGEX.test(str);

  if (!locality || isCouncilOrAdmin(locality)) {
    const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
    const candidate = parts.find((p) => !isCouncilOrAdmin(p) && !/(?:улиц|вуліц|улица|проспект|пр-т|переул|пер\.|линия|лінія|\d)/iu.test(p));
    if (candidate) {
      locality = cleanLocality(candidate);
    } else if (isCouncilOrAdmin(locality) && !/сельс|савет|совет|council/iu.test(locality)) {
      // If locality is just "Минская область" or "Минский район" and no settlement found, don't repeat it
      locality = "";
    }
  } else {
    locality = cleanLocality(locality);
  }

  const isMinsk =
    /^минск$/iu.test(locality) ||
    (/^minsk$/iu.test(locality)) ||
    (!locality && /(?:^|[,\s])(?:г\.\s*)?минск(?:$|[,\s])/iu.test(address) && !/минск(?:ий|ого|ому|ом)?\s+(?:район|р-н|обл)/iu.test(address));

  if (isMinsk) {
    locality = "Минск";
  }

  let cleanAddr = address
    .replace(/(?<![\p{L}])(?:республика беларусь|беларусь|belarus)(?![\p{L}])/giu, "")
    .replace(/(?<![\p{L}])(?:минская область|минская обл\.?|минская вобласць)(?![\p{L}])/giu, "")
    .replace(/(?<![\p{L}])(?:минский район|минский р-н)(?![\p{L}])/giu, "")
    .replace(/[^,]+(?:сельский совет|сельсовет|с\/с|сельскі савет|rural council)[^,]*/giu, "")
    .replace(/[‐‑–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  cleanAddr = cleanAddr.replace(/^,\s*|\s*,\s*$/g, "").trim();

  if (isMinsk) {
    // Strip standalone Minsk, but not "Минск-Мир"
    cleanAddr = cleanAddr
      .replace(/(?<![\p{L}-])(?:г\.\s*минск|город\s*минск|г\s*минск|минск|minsk)(?![\p{L}-])/giu, "")
      .replace(/^,\s*|\s*,\s*$/g, "")
      .trim();
  } else if (locality) {
    const escapedLoc = locality.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const locRegex = new RegExp(`(?<![\\p{L}-])(?:г\\.|д\\.|аг\\.|п\\.|город|деревня|агрогородок|пос[её]лок)?\\s*${escapedLoc}(?![\\p{L}-])`, "giu");
    cleanAddr = cleanAddr.replace(locRegex, "").replace(/^,\s*|\s*,\s*$/g, "").trim();
  }

  cleanAddr = cleanAddr.replace(/\s*,\s*,+/g, ",").replace(/^,\s*|\s*,\s*$/g, "").trim();

  const streetHouse = normalizeStreetAndHouse(cleanAddr);

  if (isMinsk) {
    if (streetHouse) {
      return `Минск, ${streetHouse}`;
    }
    return "Минск";
  }

  const oblast = "Минская область";
  if (locality && streetHouse) {
    return `${oblast}, ${locality}, ${streetHouse}`;
  } else if (locality) {
    return `${oblast}, ${locality}`;
  } else if (streetHouse) {
    return `${oblast}, ${streetHouse}`;
  }

  return address || rawTitle || "";
}
