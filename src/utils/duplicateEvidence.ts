import { cleanText, comparableAddress } from "./listingFeatures.js";

const STREET_PERSON_NAMES = /(?<![\p{L}])(?:академика|маршала|генерала|лейтенанта|полковника|майора|капитана|космонавта|летчика|братьев|яна|ян|янки|янка|якуба|якуб|максима|максим|петра|петр|веры|вера|кузьмы|кузьма|франциска|франциск|николы|никола|михаила|михаил|михася|михась|алеся|алесь|жореса|жорес|игоря|игорь|павла|павел|петруся|петрусь|змитрока|змитрок|кастуся|кастусь|пимена|пимен|владимира|владимир|владислава|владислав|винцента|винцент|феликса|феликс|сергея|сергей|иосифа|иосиф|семена|семен|дмитрия|дмитрий|василия|василий|василя|василь|льва|лев|константина|константин|ивана|иван|николая|николай|анатолия|анатолий|станислава|станислав|бориса|борис|александра|александр|иеронима|иероним|валерия|валерий|федора|федор|карла|карл|степана|степан|кирилла|кирилл|ростислава|ростислав|геннадия|геннадий|виталия|виталий|виктора|виктор|григория|григорий|тимофея|тимофей|олега|олег|аркадия|аркадий|романа|роман|юрия|юрий|ярослава|ярослав|антона|антон|софьи|софья|софии|софия|евфросинии|ефросиньи|ефросинья|марата|марат|игната|игнат|ильи|илья|тараса|тарас|кондрата|кондрат)(?![\p{L}])/giu;
const INITIALS = /(?<![\p{L}])[а-яё]\.(?:\s*[а-яё]\.)?(?![\p{L}])/giu;
const STREET_TYPES = new Set(["просп", "пер", "проезд", "тракт", "бульвар", "площадь", "тупик", "набережная", "шоссе", "м-н", "квартал", "городок"]);

export const duplicateAddressKey = (address: string, locality: string | null): string => {
  const normLocality = locality ? cleanText(locality).replace(/ё/giu, "е") : null;
  const tokens = comparableAddress(cleanText(address)
    .replace(/ё/giu, "е")
    .replace(/(?<![\p{L}])(?:[\p{L}-]+[сц]к(?:ий|ая|ое|ой|ого|ому|ом)\s+)?(?:сельский\s+совет|сельского\s+совета|сельсовет[ае]?|с\/совет[ае]?|с\/с)(?:\s+[\p{L}-]+[сц]к(?:ий|ая|ое|ой|ого|ому|ом))?(?![\p{L}])/giu, " ")
    .replace(/(?<![\p{L}])(?:городской\s+пос[её]лок|г\.?\s*п\.?)(?![\p{L}])/giu, " ")
    .replace(/(?<![\p{L}])(?:агрогородок|аг\.?)(?![\p{L}])/giu, " ")
    .replace(/(?<![\p{L}])(?:деревня|дер\.?|д\.(?!\d)|д(?=\s+[\p{L}]))(?![\p{L}])/giu, " ")
    .replace(/(?<![\p{L}])(?:пос[её]лок|пос\.?|п\.(?!\d)|п(?=\s+[\p{L}]))(?![\p{L}])/giu, " ")
    .replace(/(?<![\p{L}])(?:минская область|минский район|минский р-н)(?![\p{L}])/giu, " ")
    .replace(/(?<![\p{L}])(?:дом|д\.?)(?=\s*\d)(?![\p{L}])/giu, " ")
    .replace(/(?<![\p{L}])(?:ул\.?|улица|вул\.?|вуліца)(?![\p{L}])/giu, " ")
    .replace(/(?<![\p{L}])(?:микрорайон|мкр-н|м-н|мкрн|микрор-н)(?![\p{L}])/giu, " м-н ")
    .replace(/(?<![\p{L}])(?:квартал|кв-л)(?![\p{L}])/giu, " квартал ")
    .replace(/(?<![\p{L}])(?:городок)(?![\p{L}])/giu, " городок ")
    .replace(/(?<![\p{L}])(?:пер\.?|переулок|завулак)(?![\p{L}])/giu, " пер ")
    .replace(/(?<![\p{L}])(?:проспект|просп\.?|пр-т\.?|пр[.,]|праспект)(?![\p{L}])/giu, " просп ")
    .replace(/(?<![\p{L}])(?:проезд|пр-д\.?)(?![\p{L}])/giu, " проезд ")
    .replace(/(?<![\p{L}])(?:тракт)(?![\p{L}])/giu, " тракт ")
    .replace(/(?<![\p{L}])(?:бульвар|б-р\.?)(?![\p{L}])/giu, " бульвар ")
    .replace(/(?<![\p{L}])(?:площадь|пл\.?|плошча)(?![\p{L}])/giu, " площадь ")
    .replace(/(?<![\p{L}])(?:тупик)(?![\p{L}])/giu, " тупик ")
    .replace(/(?<![\p{L}])(?:набережная|наб\.?)(?![\p{L}])/giu, " набережная ")
    .replace(/(?<![\p{L}])(?:шоссе)(?![\p{L}])/giu, " шоссе ")
    .replace(/(\d+)\s*к(?:орп(?:ус)?)?\.?\s*(\d+)(?=$|[\s,])/giu, "$1 $2")
    .replace(/(\d+)\s*[-/]\s*(\d+)(?=$|[\s,])/giu, "$1 $2")
    .replace(/(\d+)\s*[,/ -]+\s*([а-яё])(?=$|[\s,])/giu, "$1$2")
    .replace(STREET_PERSON_NAMES, " ")
    .replace(INITIALS, " "), normLocality).split(" ").filter(Boolean);
  return [...tokens.filter((token) => !STREET_TYPES.has(token)), ...tokens.filter((token) => STREET_TYPES.has(token))].join(" ");
};

export const baseAddressKey = (address: string, locality: string | null): string => {
  const full = duplicateAddressKey(address, locality);
  const houseTokens = full.split(" ").filter((t) => /^\d+[а-яё]?$/u.test(t));
  if (houseTokens.length === 0) return full;
  const baseHouse = houseTokens[0]!.replace(/[а-яё]/giu, "");
  const words = full.split(" ").filter((w) => !/^\d+[а-яё]?$/u.test(w));
  return `${words.join(" ")} ${baseHouse}`.trim();
};

export const areAddressesCompatible = (addrA: string, addrB: string, locality: string | null, options?: { allowBaseHouseMatch?: boolean }): boolean => {
  const keyA = duplicateAddressKey(addrA, locality);
  const keyB = duplicateAddressKey(addrB, locality);
  if (keyA && keyB && keyA === keyB) return true;
  if (!keyA || !keyB) return false;

  const houseTokensA = keyA.split(" ").filter((t) => /^\d+[а-яё]?$/u.test(t));
  const houseTokensB = keyB.split(" ").filter((t) => /^\d+[а-яё]?$/u.test(t));
  if (houseTokensA.length === 0 || houseTokensB.length === 0) return false;

  const houseExact = houseTokensA.join(" ") === houseTokensB.join(" ");
  const baseHouseA = houseTokensA[0]!.replace(/[а-яё]/giu, "");
  const baseHouseB = houseTokensB[0]!.replace(/[а-яё]/giu, "");
  const baseHouseMatch = baseHouseA.length > 0 && baseHouseA === baseHouseB;

  if (!houseExact && !(options?.allowBaseHouseMatch && baseHouseMatch)) return false;

  const typesA = keyA.split(" ").filter((t) => STREET_TYPES.has(t));
  const typesB = keyB.split(" ").filter((t) => STREET_TYPES.has(t));
  if (typesA.join(" ") !== typesB.join(" ")) return false;

  const wordsA = keyA.split(" ").filter((w) => !/^\d+[а-яё]?$/u.test(w) && !STREET_TYPES.has(w));
  const wordsB = keyB.split(" ").filter((w) => !/^\d+[а-яё]?$/u.test(w) && !STREET_TYPES.has(w));

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const common = wordsA.filter((w) => setB.has(w) && w.length >= 3);
  if (common.length === 0) return false;

  return wordsA.every((w) => setB.has(w)) || wordsB.every((w) => setA.has(w));
};

export const hasStreetAddress = (address: string): boolean => /\d/u.test(address)
  && /(?:^|[^\p{L}])(?:ул\.?|улица|вул\.?|вуліца|проспект|просп\.?|пр-т\.?|пр[.,]|праспект|переулок|пер\.|площадь|пл\.|бульвар|б-р\.?|шоссе|тракт|проезд|тупик|набережная|микрорайон|мкр-н|м-н|мкрн|микрор-н|квартал|кв-л|городок)(?=$|[^\p{L}])/iu.test(address);

// Onliner signs a resized proxy URL but embeds the underlying Realt image URL.
export const realtPhotoIdentity = (value: string): string | undefined => {
  try {
    let url = new URL(value);
    if (url.hostname === "imgproxy.onliner.by") {
      const segments = url.pathname.split("/");
      const start = segments.findIndex((part) => part.startsWith("aHR0c"));
      if (start < 0) return undefined;
      url = new URL(Buffer.from(segments.slice(start).join(""), "base64url").toString("utf8"));
    }
    if (url.protocol !== "https:" || !["files.realt.by", "cdn.realt.by"].includes(url.hostname)) return undefined;
    return /^\/img\/\d+\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?:\.(?:jpe?g|png|webp))?$/i.exec(url.pathname)?.[1]?.toLowerCase();
  } catch { return undefined; }
};

export const sharedRealtPhotos = (a: readonly string[], b: readonly string[]): number => {
  const keys = new Set(a.map(realtPhotoIdentity).filter((key): key is string => key !== undefined));
  return new Set(b.map(realtPhotoIdentity).filter((key): key is string => key !== undefined && keys.has(key))).size;
};

export const duplicatePhotoSample = (photos: readonly string[], limit = 7): string[] => {
  const unique = [...new Set(photos)];
  if (unique.length <= limit) return unique;
  return [...unique.slice(0, 3), ...Array.from({ length: limit - 3 }, (_, i) => unique[3 + Math.round(i * (unique.length - 4) / (limit - 4))]!)];
};
