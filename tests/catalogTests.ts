import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyListing } from "../src/domain/exclusions.js";
import { assessmentSchema, featuresSchema, catalogItemSchema, DEFAULT_SETTINGS } from "../src/contracts/catalog.js";
import { assessListing, comparableMatches } from "../src/domain/catalogScoring.js";
import { CollectionArea } from "../src/infrastructure/geo/collectionArea.js";
import { commuteDate, selectItinerary } from "../src/services/routingService.js";
import { clusterMapPoints } from "../src/utils/mapClusters.js";
import { parseRetryAfter } from "../src/infrastructure/http/retryHttpClient.js";
import { enrichOnlinerHtml, enrichParameterHtml, extractListingDescription } from "../src/infrastructure/sources/htmlDetails.js";
import pino from "pino";
import { hashDistance } from "../src/services/duplicateService.js";
import type { ListingCandidate } from "../src/domain/listing.js";
import { propertyTypeFromDescription } from "../src/utils/listingIntent.js";
import { localityFromPropertyAddress, parseMaterial, usableLocality, explicitElevator } from "../src/utils/listingFeatures.js";
import { canonicalJson } from "../src/utils/json.js";
import { catalogProcessing } from "../src/domain/catalogStatus.js";
import { areAddressesCompatible, duplicateAddressKey, hasStreetAddress, sharedRealtPhotos } from "../src/utils/duplicateEvidence.js";
import { structuredDuplicate } from "../src/domain/duplicateIdentity.js";

export const assertCatalog = async (): Promise<void> => {
  assert.equal(explicitElevator("Каркасно-блочный дом 2015 года постройки оснащен современным лифтом Otis."), true);
  assert.equal(explicitElevator("В доме нет лифта."), false);
  assert.equal(explicitElevator("Дом не оборудован лифтом."), false);
  assert.equal(explicitElevator("Дом оснащен лифтом. Лифт не работает."), undefined);
  assert.equal(explicitElevator("В доме нет лифта. Дом оснащен лифтом."), undefined);
  assert.equal(explicitElevator("Установка лифта планируется."), undefined);
  assert.equal(explicitElevator("В лифте установлена камера."), undefined);
  for (const material of ["Блочный", "блочная", "блочные", "блоки"]) {
    assert.equal(parseMaterial(material), "block", `Block material: ${material}`);
  }
  for (const [material, expected] of [
    ["Кирпичный", "brick"], ["Панельный", "panel"], ["Монолитный", "monolith"],
    ["Каркасный", "monolith"], ["Деревянный", "wood"], ["Неизвестный", undefined], ["", undefined], [undefined, undefined]
  ] as const) {
    assert.equal(parseMaterial(material), expected, `Material: ${material}`);
  }
  assert.equal(canonicalJson({ a: 1, b: { d: 4, c: 3 } }), canonicalJson({ b: { c: 3, d: 4 }, a: 1 }));
  const features = featuresSchema.parse({ locality: "Минск", marketZone: "минск", isStudio: false, propertyType: "apartment", dealType: "sale", inCollectionArea: true, totalFloors: 9 });
  const decide = (title: string, description = "") => classifyListing({ title, description }, features);
  for (const [title, body] of [
    ["Продажа квартиры", "Квартира в жилом доме. Можно сдавать в аренду. Парковочное место можно арендовать."],
    ["Квартира в деревне Копище", "Продажа всей квартиры, не доля. Есть отдельный вход в подъезд."],
    ["Квартира возле метро Аэродромная", "Обычная квартира"],
    ["Квартира напротив Минск-Мир", "ЖК Левада"],
    ["Квартира с рассрочкой", "Первоначальный взнос 30%, полная цена квартиры указана в объявлении."]
  ]) assert.equal(decide(title!, body).disposition, "ACCEPTED", title!);
  for (const title of ["Продается доля в квартире", "Продаётся 1/2 доли", "Продам комнату в 3-комнатной квартире", "Коттедж с участком", "Минск–Мир, квартира", "МИНСК МИР, 2 комнаты", "Сдам квартиру"]) assert.equal(decide(title).disposition, "EXCLUDED", title);
  assert.equal(decide("Доля", "Квартира полностью отремонтирована").disposition, "EXCLUDED");
  const byDescription = (title: string, description = "") => classifyListing({ title, description }, { ...features, totalFloors: undefined });
  assert.equal(byDescription("Квартира в 3-этажном доме").disposition, "EXCLUDED");
  assert.equal(byDescription("Квартира", "В трёхэтажном жилом доме").disposition, "EXCLUDED");
  assert.equal(byDescription("Квартира", "В четырёхэтажном доме").disposition, "EXCLUDED");
  assert.equal(byDescription("Квартира", "4 этаж из 9").disposition, "ACCEPTED");
  assert.equal(byDescription("Квартира", "4 этаж").disposition, "REVIEW");
  assert.equal(decide("Квартира", "В доме 4 этажа").disposition, "REVIEW");
  assert.equal(decide("Обмен квартиры на дом").disposition, "EXCLUDED");
  assert.equal(decide("Квартира", "Продам или обменяю на двухкомнатную.").disposition, "EXCLUDED");
  assert.equal(decide("Квартира", "Обмен, мою 3-х комнатную на вашу однокомнатную с доплатой! Возможно продажа доли. Только продажа доли или обмен + доплата! Продажи квартиры целиком, нет!").disposition, "EXCLUDED");
  assert.equal(decide("Квартира", "обмен на одно/двухкомнатную квартиру в минске с доплатой\nосмотр квартир после 19-00").disposition, "EXCLUDED");
  assert.equal(decide("Квартира", "Продаются три комнаты в 4-ёх комнатной квартире.").disposition, "EXCLUDED");
  const roomTitleDecision = decide("Комната  Корженевского пер., 14", "");
  assert.equal(roomTitleDecision.disposition, "EXCLUDED");
  assert.ok(roomTitleDecision.reasons.includes("Продажа комнаты или доли"));
  const roomsInFlatDecision = decide("Квартира", "Продаются две раздельные комнаты (12.40 м2 и 13.90 м2) в 3-комнатной квартире");
  assert.equal(roomsInFlatDecision.disposition, "EXCLUDED");
  assert.ok(roomsInFlatDecision.reasons.includes("Продажа комнаты или доли"));
  assert.equal(decide("Квартира", "Продаётся трёхкомнатная квартира целиком. Не доля, без обмена.").disposition, "ACCEPTED");
  for (const description of ["Продается ½ доля", "Продаётся ⅓ доли", "Продам 1 ⁄ 2 долю", "Продаётся половина квартиры", "Продажа 1∕4 квартиры", "Продается 12,5% доли"]) {
    assert.equal(decide("Квартира", description).disposition, "EXCLUDED", description);
  }
  for (const description of ["Продаётся квартира целиком. Не продаётся ½ доля.", "Не продаётся ½ квартиры. Продаётся квартира целиком.",
    "Этаж 1/2. Доля кухни в общей площади — 25%.", "Продаётся квартира целиком, без продажи долей.",
    "3-комнатная квартира на ул. Лынькова 109/2Квартира общей площадью 62,3 м²."]) {
    assert.equal(decide("Квартира", description).disposition, "ACCEPTED", description);
  }
  assert.equal(decide("Квартира", "Обмен на однокомнатную не рассматриваю. Продаётся целая квартира.").disposition, "ACCEPTED");
  assert.equal(decide("Квартира", "Варианты обмена обсуждаются.").disposition, "REVIEW");
  assert.equal(decide("Продам квартиру", "Обмен не рассматриваю, только продажа.").disposition, "ACCEPTED");
  for (const totalFloors of [1, 2, 3, 4, 5]) assert.equal(classifyListing({ title: "Квартира", description: "" }, { ...features, totalFloors }).disposition, totalFloors <= 4 ? "EXCLUDED" : "ACCEPTED");
  for (const body of ["Продам часть квартиры", "Продам 25% квартиры", "Готов обменять квартиру", "Обменяем квартиру на однокомнатную",
    "Квартиру меняю на дом", "Не рассматриваю обмен на дом, возможен обмен на квартиру", "Не рассматриваю обмен на дом но возможен обмен на квартиру"]) {
    assert.equal(decide("Квартира", body).disposition, "EXCLUDED", body);
  }
  for (const body of ["Не интересует обмен на дом", "Обмен на дом, не интересует", "Продам квартиру, первый взнос 25%",
    "Квартира на 4 этаже 9-этажного дома, 4/9", "Дом обслуживает служба обмена показаниями"]) {
    assert.equal(decide("Квартира", body).disposition, "ACCEPTED", body);
  }
  assert.equal(propertyTypeFromDescription("3-комнатная квартира", "Продается дом с участком 6 соток", "Копище"), "house");
  assert.equal(propertyTypeFromDescription("3-комнатная квартира", "", "Минск"), "unknown");
  assert.equal(propertyTypeFromDescription("3-комнатная квартира", "Продается квартира в жилом доме. Можно арендовать парковку.", "Минск"), "apartment");
  assert.equal(propertyTypeFromDescription("Комната  Корженевского пер., 14", "Продаются две раздельные комнаты в 3-комнатной квартире", "Минск"), "room");
  assert.equal(localityFromPropertyAddress("Беларусь, Колодищи, Лесное Озеро, 13"), "Колодищи");
  assert.equal(localityFromPropertyAddress("Лошанский сельский Савет, Кальзберг"), "Кальзберг");
  assert.equal(usableLocality("Минская область", "Боровляны, ул. Лесная, 3"), "Боровляны");
  assert.equal(decide("Квартира", "Цена указана за долю").disposition, "REVIEW");
  assert.equal(classifyListing({ title: "Квартира", description: "" }, featuresSchema.parse({})).disposition, "REVIEW");
  assert.equal(classifyListing({ title: "Квартира", description: "Сокращённое описание" }, { ...features, descriptionComplete: false }).disposition, "REVIEW");
  const cardHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { initialState: { adView: { data: { adId: 123, priceUsd: 100000, body: "<p>Квартира</p><p>Продажа целиком.</p>" } }, recommendations: [{ adId: 456, priceUsd: 100, body: "Чужое объявление с длинным описанием" }] } } })}</script>`;
  assert.equal(extractListingDescription(cardHtml, "123", pino({ enabled: false })), "Квартира\nПродажа целиком.");
  assert.equal(extractListingDescription(cardHtml, "789", pino({ enabled: false })), null);
  const item = catalogItemSchema.parse({ id: "subject", listingId: "listing", title: "Квартира", description: "", rooms: 2, areaSqm: 50, priceUsd: 90_000, priceByn: null, priceSqm: 1800,
    latitude: 53.9, longitude: 27.5, photos: [], features, disposition: "ACCEPTED", reasons: [], favorite: false, hidden: false, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), sources: [], assessment: null, routes: null, enrichmentStatus: "PENDING" });
  const comps = Array.from({ length: 5 }, (_, i) => ({ propertyId: `p${i}`, externalId: String(i), platform: "KUFAR" as const, address: null, priceUsd: 100000, priceSqm: 2000, areaSqm: 50, distanceMeters: 100 }));
  const assessment = assessListing(item, comps, 500, DEFAULT_SETTINGS);
  const statusInput = { assessment: null, routes: null, routeStatus: "PENDING", routeError: null, assessmentError: null, hasCoordinates: true, disposition: "ACCEPTED" };
  assert.equal(catalogProcessing(statusInput).route.state, "pending");
  assert.equal(catalogProcessing(statusInput).value.state, "pending");
  assert.equal(catalogProcessing({ ...statusInput, hasCoordinates: false }).route.state, "missing-coordinates");
  assert.equal(catalogProcessing({ ...statusInput, routeStatus: "NO_ROUTE" }).route.state, "no-route");
  assert.equal(catalogProcessing({ ...statusInput, routeStatus: "FAILED" }).route.state, "failed");
  assert.equal(catalogProcessing({ ...statusInput, disposition: "REVIEW" }).value.state, "review");
  assert.equal(catalogProcessing({ ...statusInput, assessment: assessListing(item, comps.slice(0, 4), 500, DEFAULT_SETTINGS) }).value.state, "insufficient");
  assert.equal(catalogProcessing({ ...statusInput, assessment, assessmentError: "Ошибка расчёта" }).value.state, "failed");
  assert.equal(assessment.valueScore, 56); assert.equal(assessment.discountPct, 10);
  assert.equal(assessment.priceEvidence?.priceSqm, 1800);
  assert.equal(assessment.priceEvidence?.rawScore, 56);
  assert.equal(assessListing(item, Array.from({ length: 5 }, () => comps[0]!), 500, DEFAULT_SETTINGS).valueScore, null);
  const scoreAt = (priceSqm: number): number => assessListing({ ...item, priceSqm }, comps, 500, DEFAULT_SETTINGS).valueScore!;
  assert.ok(scoreAt(1400) > scoreAt(1600) && scoreAt(1400) < 100);
  assert.equal(scoreAt(2000), 50);
  const imageId = "fb389b4a-d842-11f1-9baa-3a5ec57fc6ad";
  const addresses = ["Волгоградская ул, 57, Минск", "Минск, Волгоградская улица, 57", "Минск Волгоградская ул. 57"];
  assert.equal(new Set(addresses.map((address) => duplicateAddressKey(address, "Минск"))).size, 1);
  assert.notEqual(duplicateAddressKey("Волгоградская ул, 57к2, Минск", "Минск"), duplicateAddressKey(addresses[0]!, "Минск"));
  const prospects = ["Минск, Рокоссовского просп. 149", "Рокоссовского пр, 149, Минск", "Минск, проспект Рокоссовского, 149", "Минск, Рокоссовского пр-т 149"];
  assert.ok(prospects.every(hasStreetAddress));
  assert.equal(new Set(prospects.map((address) => duplicateAddressKey(address, "Минск"))).size, 1);
  assert.notEqual(duplicateAddressKey("Рокоссовского ул. 149, Минск", "Минск"), duplicateAddressKey(prospects[0]!, "Минск"));
  const namedStreets = ["Яна Чечота ул, 28, Минск", "Минск Чечота ул. 28", "Беларусь, Минск, Яна Чечота ул., 28"];
  assert.equal(new Set(namedStreets.map((address) => duplicateAddressKey(address, "Минск"))).size, 1);
  assert.equal(areAddressesCompatible("Яна Чечота ул, 28, Минск", "Минск Чечота ул. 28", "Минск"), true);
  assert.equal(areAddressesCompatible("Волгоградская ул., 57, Минск", "Волгоградская ул., 57а, Минск", "Минск"), false);
  assert.equal(areAddressesCompatible("Голодеда ул., 5, Минск", "проезд Голодеда, 5, Минск", "Минск"), false);
  assert.equal(areAddressesCompatible("б-р Шевченко, 5, Минск", "бульвар Шевченко, 5, Минск", "Минск"), true);
  assert.equal(areAddressesCompatible("пл. Победы, 1, Минск", "площадь Победы, 1, Минск", "Минск"), true);
  const suburbA = "Самохваловичский сельский Совет, Самохваловичи, улица Ковалёва, 8";
  const suburbB = "Самохваловичи Ковалева ул. 8";
  assert.equal(duplicateAddressKey(suburbA, "Самохваловичи"), "ковалева 8");
  assert.equal(duplicateAddressKey(suburbB, "Самохваловичи"), "ковалева 8");
  assert.equal(areAddressesCompatible(suburbA, suburbB, "Самохваловичи"), true);
  assert.equal(areAddressesCompatible("аг. Самохваловичи, ул. Ковалева д. 8", suburbB, "Самохваловичи"), true);
  assert.equal(areAddressesCompatible("деревня Слобода, Центральная, 5", "д. Слобода, Центральная ул., 5", "Слобода"), true);
  assert.equal(areAddressesCompatible("поселок Юбилейный, Парковая 3", "п. Юбилейный, Парковая 3", "Юбилейный"), true);
  assert.equal(areAddressesCompatible("городской поселок Мачулищи, Молодежная 1", "г.п. Мачулищи, Молодежная 1", "Мачулищи"), true);
  assert.equal(areAddressesCompatible("Боровлянский сельсовет, Лесной, 10", "Боровлянский с/с, пос. Лесной, 10", "Лесной"), true);
  const chechotaA = { address: "Яна Чечота ул, 28, Минск", locality: "Минск", latitude: 53.84553, longitude: 27.482896, floor: 9, totalFloors: 9, rooms: 3, areaSqm: 90.5, priceUsd: 160454, priceByn: 480000, livingSqm: 55.4, kitchenSqm: 12.8, buildingYear: 2009 };
  const chechotaB = { address: "Минск Чечота ул. 28", locality: "Минск", latitude: 53.8455, longitude: 27.4829, floor: 9, totalFloors: 9, rooms: 3, areaSqm: 90.5, priceUsd: 160422, priceByn: 480000, livingSqm: 55.4, kitchenSqm: 12.8, buildingYear: 2009 };
  assert.equal(structuredDuplicate(chechotaA, chechotaB), true);
  const samokhvalovichiA = {
    address: suburbA, locality: "Самохваловичи", latitude: 53.737257, longitude: 27.506748,
    floor: 2, totalFloors: 5, rooms: 2, areaSqm: 40.5, priceUsd: 64958.86, priceByn: 195000,
    livingSqm: 26.8, kitchenSqm: 5.6, buildingYear: 1969
  };
  const samokhvalovichiB = {
    address: suburbB, locality: "Самохваловичи", latitude: 53.7372, longitude: 27.5067,
    floor: 2, totalFloors: 5, rooms: 2, areaSqm: 40.55, priceUsd: 64959, priceByn: 195000,
    livingSqm: 26.8, kitchenSqm: 5.6, buildingYear: 1969
  };
  assert.equal(structuredDuplicate(samokhvalovichiA, samokhvalovichiB), true);
  const ural = { address: "Минск Уральский пер. 5", locality: "Минск", latitude: 53.9001, longitude: 27.6048, floor: 4, totalFloors: 5, rooms: 2,
    areaSqm: 44.1, priceUsd: 77797, priceByn: 232730, livingSqm: 32.8, kitchenSqm: 5.7, buildingYear: 1964 };
  const mirror = { ...ural, address: "Уральский переулок, 5, Минск", priceUsd: 77797.09, buildingYear: null };
  assert.equal(structuredDuplicate(ural, mirror), true);
  assert.equal(structuredDuplicate(ural, { ...mirror, kitchenSqm: null }), false);
  assert.equal(structuredDuplicate(ural, { ...mirror, livingSqm: 32.4 }), false);
  assert.equal(structuredDuplicate(ural, { ...mirror, floor: 3 }), false);
  assert.equal(structuredDuplicate(ural, { ...mirror, latitude: 53.9011 }), false);
  assert.equal(structuredDuplicate(ural, { ...mirror, address: "Уральская улица, 5, Минск" }), false);
  const proxy = `https://imgproxy.onliner.by/sign/w:90/${Buffer.from(`https://files.realt.by/img/62/${imageId}.jpg`).toString("base64url").match(/.{1,16}/g)!.join("/")}`;
  assert.equal(sharedRealtPhotos([`https://cdn.realt.by/img/55/${imageId}`], [proxy, proxy]), 1);
  assert.ok(assessment.priceEvidence?.rules.some((rule) => rule.includes("500 / 1000 / 2000")));
  assert.equal(assessment.comfortScore, null); assert.equal(assessment.coverage, 0);
  assert.equal(assessListing(item, comps.slice(0, 4), 500, DEFAULT_SETTINGS).valueScore, null);
  assert.equal(comparableMatches(item, { ...item, id: "other", features: { ...features, marketZone: "minsk:shabany" } }), false);
  assert.equal(comparableMatches(item, { ...item, id: "other", features: { ...features, isStudio: true } }), false);
  assert.equal(comparableMatches(item, { ...item, id: "other", features: { ...features, marketZone: "minsk:sokol" } }), false);
  assert.equal(comparableMatches(item, item), false);
  assert.equal(comparableMatches(item, { ...item, id: "other", features }), true);
  const worn = { ...item, confirmedBuilding: "worn" as const };
  assert.equal(comparableMatches(worn, { ...item, id: "other" }), false);
  assert.equal(comparableMatches(worn, { ...worn, id: "other", confirmedBuilding: "maintained" }), false);
  assert.equal(comparableMatches(worn, { ...worn, id: "other" }), true);
  const good = { ...item, features: featuresSchema.parse({ ...features, repair: "good", buildingYear: 2015, buildingMaterial: "brick", floor: 3, totalFloors: 10, elevator: true, readiness: "ready", layout: "isolated", kitchenSqm: 10, livingSqm: 30, balcony: true, bathroom: "separate" }) };
  assert.equal(assessListing(good, comps, 500, DEFAULT_SETTINGS).discountPct, assessment.discountPct, "Comfort does not change the price discount");
  assert.ok(assessListing(good, comps, 500, DEFAULT_SETTINGS).valueScore! > assessment.valueScore!, "Known comparability features support a higher score");
  const detailed = assessmentSchema.parse(assessListing(good, comps, 500, DEFAULT_SETTINGS));
  assert.ok(detailed.comfortScore! > 40);
  assert.equal(Math.round(detailed.components.reduce((sum, group) => sum + (group.points ?? 0), 0) * 10) / 10, detailed.comfortScore);
  assert.equal(detailed.components.flatMap((group) => group.criteria ?? []).length, 15);
  assert.deepEqual(detailed.components.find((group) => group.code === "condition")?.criteria?.find((criterion) => criterion.code === "repair")?.score, 85);
  assert.equal(detailed.components.find((group) => group.code === "transport")?.criteria?.[0]?.score, null);
  const area = await CollectionArea.load();
  assert.equal(area.locate(53.9, 27.56), "minsk"); assert.equal(area.locate(54.002, 27.68), "district"); assert.equal(area.locate(53.1, 29.2), "outside");
  assert.equal(area.isMinskWorld(53.8607, 27.5397), true);
  assert.equal(area.isMinskWorld(53.89, 27.54), false);
  assert.equal(commuteDate(new Date("2026-11-07T18:00:00Z")), "2026-11-09");
  const itinerary = (duration: number, mode: string) => ({ duration, legs: [{ mode, duration }] });
  assert.equal(selectItinerary([itinerary(7200, "WALK"), itinerary(1800, "BUS")], true)?.duration, 1800);
  assert.equal(selectItinerary([itinerary(2000, "WALK"), itinerary(1000, "WALK")], true)?.duration, 1000);
  assert.equal(selectItinerary([itinerary(500, "CAR"), itinerary(1000, "WALK")], true)?.duration, 1000);
  const map = clusterMapPoints([{ propertyId: "1", latitude: 53.9, longitude: 27.5, price: 90000 }, { propertyId: "2", latitude: 53.90001, longitude: 27.50001, price: 85000 }], 10);
  assert.equal(map.reduce((n, p) => n + p.count, 0), 2); assert.equal(map[0]?.minPrice, 85000);
  assert.equal(parseRetryAfter("2"), 2000); assert.equal(parseRetryAfter(null), undefined);
  assert.equal(hashDistance("0000000000000000", "000000000000000f"), 4);
  const candidate: ListingCandidate = { platform: "ONLINER", externalId: "1", url: "https://r.onliner.by/pk/apartments/1", title: "", description: "", rooms: 1, areaSqm: 40, priceUsd: 80000, pricePerSqm: 2000, photos: [], details: [], sourcePayload: {}, features };
  const enriched = enrichParameterHtml(candidate, "<dl><dt>Ремонт</dt><dd>Евро</dd><dt>Тип дома</dt><dd>Кирпичный</dd></dl>");
  assert.equal(enriched.features?.repair, "good"); assert.equal(enriched.features?.buildingMaterial, "brick");
  const unknownCandidate = { ...candidate, features: featuresSchema.parse({}) };
  const wrapped = enrichParameterHtml(unknownCandidate, await readFile("tests/fixtures/realt-wrapped-parameters.html", "utf8"));
  assert.equal(wrapped.features?.buildingMaterial, "panel", "Decorative separators must not hide the wrapped REALT value");
  assert.equal(wrapped.features?.repair, "good");
  assert.equal(wrapped.features?.buildingYear, 2007);
  const absent = enrichParameterHtml(unknownCandidate, '<section><div><span>Тип дома</span><div></div></div><div><div><span>Ремонт</span><div></div></div><div><span>Отличный</span></div></div></section>');
  assert.equal(absent.features?.buildingMaterial, undefined, "A missing value must not consume the following parameter row");
  const empty = enrichParameterHtml(unknownCandidate, '<div><div><span>Тип дома</span><div></div></div><div></div></div>');
  assert.equal(empty.features?.buildingMaterial, undefined);
  const onliner = enrichOnlinerHtml(candidate, '<h1>Квартира</h1><div class="apartment-info__sub-line_large">Квартира в жилом доме. Можно арендовать парковку.</div><div class="apartment-options-table__row"><div class="apartment-options-table__cell">Этаж</div><div class="apartment-options-table__cell">3/9</div></div>');
  assert.equal(onliner.features?.floor, 3); assert.equal(onliner.features?.totalFloors, 9);
  const houseOptions = enrichOnlinerHtml({ ...unknownCandidate, descriptionComplete: true }, '<ul class="apartment-options"><li class="apartment-options__item">Панельный дом 1988 года</li><li class="apartment-options__item">Вторичка с ремонтом</li></ul>');
  assert.equal(houseOptions.features?.buildingMaterial, "panel");
  assert.equal(houseOptions.features?.buildingYear, 1988);
  assert.equal(houseOptions.features?.repair, undefined, "The presence of repair does not establish its quality");
};
