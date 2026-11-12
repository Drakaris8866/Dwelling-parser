import type { ListingFeatures } from "../contracts/catalog.js";
import { cleanText } from "./listingFeatures.js";

export type IntentSignals = { rental: boolean; house: boolean; partial: boolean; ambiguousDeal: boolean; minskWorld: boolean; incompletePrice: boolean };
const dealText = (value: string): string => cleanText(value).replace(/ё/g, "е");
export const offersExchange = (title: string, description: string): boolean => {
  return [title, description].some((text) => text
    .replace(/(?:^|[^\p{L}])обмен(?:\s+на\s+[^,;.!?\r\n]{1,90}?)?\s*,\s*не\s+(?:интересу\p{L}*|предлага\p{L}*|рассматрива\p{L}*|возмож\p{L}*)/giu, " ")
    .split(/[,;.!?\r\n]+|\s+(?:но|однако)\s+/iu).some((part) => {
    const clause = dealText(part).replace(/(?:без\s+обмена|обмен(?:\s+на\s+.{1,90}?)?\s+не\s+(?:интересу\p{L}*|предлага\p{L}*|рассматрива\p{L}*|возмож\p{L}*)|не\s+(?:интересу\p{L}*|рассматрива\p{L}*|предлага\p{L}*|возможен)\s+обмен(?:\s+на\s+.*)?)/giu, " ").trim();
    return /^(?:обмен(?:\s*:|$)|(?:обменяю|обменяем|обмениваю|обмениваем)(?=$|[^\p{L}]))|(?:^|[^\p{L}])(?:продаж[аи]\s*(?:или|\/)\s*обмен|продам\s+или\s+обменяю|(?:только|возможен|предлагаем|предлагаю|рассмотрим|рассмотрю)\s+обмен|обмен\s+(?:возможен|на|с доплатой|квартир\p{L}*)|обмен\s*\+\s*доплата|готов[аы]?\s+обменять\s+квартир\p{L}*|квартир\p{L}*\s+(?:меняю|меняем)\s+на|(?:меняю|меняем)\s+квартир\p{L}*\s+на)(?=$|[^\p{L}])/iu.test(clause);
  }));
};

export const isRoomTitle = (title: string): boolean => {
  const t = dealText(title);
  if (/^(?:прода(?:ется|ются|м|ю|ем|жа)\s+)?комнат[аы](?=$|[^\p{L}])/iu.test(t)) return true;
  if (/(?:^|[^\p{L}])(?:выделенн\p{L}*|изолированн\p{L}*|раздельн\p{L}*)\s+комнат[ау](?=$|[^\p{L}])/iu.test(t)) return true;
  if (/(?:^|[^\p{L}])комнат[ауые]\s+в\s+(?:[^,;.!?\r\n]{0,60}?\s+)?(?:квартир\p{L}*|общежити\p{L}*|коммунал\p{L}*)/iu.test(t)) return true;
  if (/(?:^|[^\p{L}])(?:\d+|две|три|четыре)\s+(?:раздельн\p{L}*|изолированн\p{L}*|выделенн\p{L}*|жил\p{L}*|смежн\p{L}*)?\s*комнат[ыа]\s+в\s+(?:[^,;.!?\r\n]{0,60}?\s+)?(?:квартир\p{L}*|общежити\p{L}*|коммунал\p{L}*)/iu.test(t)) return true;
  if (/(?:^|[,\s(])комнат[аы][)\s,.]*$/iu.test(t)) return true;
  if (/(?:^|[^\p{L}])комнат[ау](?=$|[^\p{L}])/iu.test(t) && !/(?:своя|каждая|большая|просторная|светлая|уютная)\s+комната/iu.test(t) && !/квартир\p{L}*/iu.test(t)) return true;
  return false;
};

const shareAmount = String.raw`(?:\d+\s*/\s*\d+|\d{1,2}(?:[.,]\d+)?\s*%|половин[ауы]|треть|четверть)`;
const shareObject = String.raw`(?:дол(?:я|ю|и|ей)|част[ьи]\s+квартир\p{L}*)`;
const quantifiedShare = String.raw`${shareAmount}\s*(?:${shareObject}|(?:в\s+)?(?:квартир[ые]|праве\s+собственности))`;
const shareSalePatterns = [
  new RegExp(String.raw`(?:^|[^\p{L}])(?:прода(?:ется|ются|м|ю|ем|жа|жи)|купить|предлагается)\s+(?:идеальн\p{L}*\s+)?${shareObject}(?!\p{L})`, "iu"),
  new RegExp(String.raw`(?:^|[^\p{L}\p{N}/])${quantifiedShare}(?!\p{L})`, "iu"),
  new RegExp(String.raw`(?:^|[.!?])\s*(?:идеальн\p{L}*\s+)?дол[яию](?:\s+(?:в\s+(?:праве|(?:[^,;.!?]{0,60}?\s+)?квартир\p{L}*)|${shareAmount})|\s*(?=$|[.!,:;]))`, "iu")
];
const negatedShareSale = new RegExp(String.raw`(?:^|[^\p{L}])не\s+(?:прода(?:ется|ются|м|ю|ем)\s+)?(?:${quantifiedShare}|${shareObject})(?!\p{L})|без\s+продажи\s+долей(?!\p{L})|(?:${quantifiedShare}|${shareObject})\s+не\s+прода\p{L}*`, "giu");

export const describesShareSale = (value: string): boolean => {
  const text = dealText(value).replace(/[⁄∕]/gu, "/").replace(negatedShareSale, " ");
  return shareSalePatterns.some((pattern) => pattern.test(text));
};

const partialDeal = (title: string, description: string): Pick<IntentSignals, "partial" | "ambiguousDeal"> => {
  const text = dealText(`${title}. ${description}`).replace(/(?:не\s+доля|не\s+прода(?:ем|ю|ется|ются)\s+(?:дол|комнат)\p{L}*|дол\p{L}*\s+не\s+прода\p{L}*)/giu, " ");
  const titleRoom = isRoomTitle(title);
  const sellingRooms = /(?:^|[^\p{L}])(?:прода(?:ется|ются|м|ю|ем|жа|жи)|покупк\p{L}*|купить)\s+(?:(?:одн\p{L}*|дв\p{L}*|тр\p{L}*|четыр\p{L}*|пят\p{L}*|\d+)\s+)?(?:(?:раздельн\p{L}*|изолированн\p{L}*|смежн\p{L}*|жил\p{L}*|уютн\p{L}*|светл\p{L}*|отдельн\p{L}*|просторн\p{L}*|больш\p{L}*|выделенн\p{L}*)\s+)*комнат(?:а|у|ы|е|ам)?(?=$|[^\p{L}])/iu.test(text);
  const roomsInFlat = /(?:^|[^\p{L}])(?:(?:\d+|одн\p{L}*|дв\p{L}*|тр\p{L}*|четыр\p{L}*)\s+)?(?:раздельн\p{L}*|изолированн\p{L}*|выделенн\p{L}*|жил\p{L}*|смежн\p{L}*)?\s*комнат(?:а|у|ы|е)\s+(?:[^.!?;\r\n]{0,80}?\s+)?в\s+(?:(?:\d+|[а-яё]+)[-\s]*комнатн\p{L}*\s+квартир\p{L}*|коммунал\p{L}*|общежити\p{L}*)/iu.test(text);
  const purchaseRoomsInFlat = /(?:^|[^\p{L}])покупк\p{L}*\s+(?:(?:\d+|одн\p{L}*|дв\p{L}*|тр\p{L}*|четыр\p{L}*)\s+)?комнат\p{L}*\s+(?:[^.!?;\r\n]{0,80}?\s+)?в\s+квартир\p{L}*/iu.test(text);
  const coOwner = /(?:^|[^\p{L}])(?:сособственник\p{L}*|(?:со|с)\s+(?:вторым|другим)\s+собственником)/iu.test(text);
  const usageOrder = /(?:^|[^\p{L}])поряд(?:ок|ка|ком|ку)\s+пользования(?!\s+земельн\p{L}*)/iu.test(text);
  const allocatedRoom = /(?:^|[^\p{L}])выделенн\p{L}*\s+комнат[ауые](?!\s*-кладов)/iu.test(text);
  const noWholeSale = /продаж[аи]\s+(?:всей\s+квартиры|квартиры\s+целиком)[, ]+нет(?=$|[^\p{L}])/iu.test(text);
  const partial = titleRoom || sellingRooms || roomsInFlat || purchaseRoomsInFlat || coOwner || usageOrder || allocatedRoom
    || noWholeSale || describesShareSale(title) || describesShareSale(description);
  if (partial) return { partial: true, ambiguousDeal: false };
  const whole = /прода(?:ется|м|ем|жа)\s+(?:вся\s+квартира|всю\s+квартиру|квартир\p{L}*\s+целиком)/iu.test(text);
  const ambiguousDeal = !partial && !whole && /(?:услови\p{L}*|вариант\p{L}*|вопрос\p{L}*)\s+(?:с\s+)?(?:обмен\p{L}*|дол[яеию])|(?:возможна|обсуждается)\s+продажа\s+части/iu.test(text);
  return { partial, ambiguousDeal };
};

export const describedBuildingFloorCounts = (title: string, description: string): readonly number[] => {
  const text = [title, description].map(dealText).join(". ");
  const words: Readonly<Record<string, number>> = { "одно": 1, "двух": 2, "трех": 3, "четырех": 4, "пяти": 5, "шести": 6, "семи": 7, "восьми": 8, "девяти": 9, "десяти": 10 };
  const counts = Array.from(text.matchAll(/(?:^|[^\p{L}\d-])(\d{1,2}|одно|двух|трех|четырех|пяти|шести|семи|восьми|девяти|десяти)\s*-?\s*этажн\p{L}*\s+(?:жил\p{L}*\s+)?дом\p{L}*|(?:^|[^\p{L}])(?:в доме|этажность дома)\s*:?\s*(\d{1,2})\s*этаж(?:а|ей)?(?=$|[^\p{L}])|(?:^|[^\p{L}\d])\d{1,2}(?:-й)?\s+этаж\s+из\s+(\d{1,2})(?!\d)/giu),
    (match) => match[1] ? words[match[1]] ?? Number(match[1]) : Number(match[2] ?? match[3]));
  return [...new Set(counts.filter((count) => count > 0))];
};
export const propertyTypeFromDescription = (title: string, description: string, address: string | undefined): ListingFeatures["propertyType"] => {
  const text = cleanText(`${title}. ${description}`);
  if (/(?:прода[её]тся|продам|продаю|продажа)\s+(?:(?:новый|жилой|современный|уютный|дачный|деревянный|кирпичный|двухэтажный)\s+)*(?:дом|коттедж|дача|таунхаус)(?:\s|[,.!]|$)/iu.test(text)
    || /(?:дом|коттедж).{0,100}(?:участок\s+\d|\d+(?:[.,]\d+)?\s+соток)|(?:участок\s+\d|\d+(?:[.,]\d+)?\s+соток).{0,100}(?:дом|коттедж)/iu.test(text)) return "house";
  if (/садовое товарищество|(?:^|[\s,])с\.?т\.?\s/iu.test(address ?? "")) return "unknown";
  if (describesShareSale(title) || describesShareSale(description)) return "share";
  if (isRoomTitle(title) || /(?:прода[её]тся|продаются|продам|продажа|покупка|купить)\s+(?:(?:\d+|две|три|четыре)\s+)?(?:раздельн\p{L}*\s+)?комнат[ауы]/iu.test(text)) return "room";
  // A category-generated H1 alone is insufficient: owners also advertise houses in this feed.
  if (/(?:^|[^\p{L}])квартир(?:а|у|ы|е)(?:$|[^\p{L}])/iu.test(description)) return "apartment";
  return "unknown";
};
export const parseListingIntent = (titleValue: string, description: string, f: ListingFeatures): IntentSignals => {
  const title = cleanText(titleValue), text = cleanText(`${titleValue}. ${description}`);
  const rental = /^(?:сдам|сда[её]тся|аренда квартиры|снять квартиру)(?:\s|[.!,:]|$)/iu.test(title);
  const house = /^(?:прода[её]тся\s+|продам\s+|продажа\s+)?(?:частный дом|дом с участком|коттедж|дача|таунхаус|дуплекс)(?:\s|[.!,:]|$)/iu.test(title)
    || /(?:прода[её]тся|продам)\s+(?:жилой\s+)?дом[\s,.].{0,100}(?:участ|соток)/iu.test(text)
    || propertyTypeFromDescription(titleValue, description, f.address) === "house";
  const deal = partialDeal(titleValue, description);
  const name = /(?:минск[\s-]*мир|minsk[\s-]*world)/iu;
  const onlyNearby = /(?:рядом\s+с|напротив|вид\s+на|не)\s+(?:жк\s*)?[«"']?(?:минск[\s-]*мир|minsk[\s-]*world)/iu.test(title);
  const minskWorld = name.test(cleanText(f.complex ?? "")) || (!onlyNearby && name.test(title))
    || /(?:в\s+жк|жилом\s+комплексе|жк)\s*[«"']?минск[\s-]*мир/iu.test(text)
    || /(?:николы теслы|братьев райт|игоря лученка|леонида щемел[её]ва|михаила савицкого)/iu.test(cleanText(f.address ?? ""));
  const incompletePrice = /цен[аы]\s+(?:указана\s+)?(?:за\s+(?:дол[юи]|м[²2])|(?:первого|первоначального)\s+взноса)|в\s+объявлении\s+указан\p{L}*\s+.{0,40}взнос/iu.test(text);
  return { rental, house, ...deal, minskWorld, incompletePrice };
};
