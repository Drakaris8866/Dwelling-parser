import assert from "node:assert/strict";
import { buildCsv, escapeCsvValue } from "../src/gtfs-scraper/csvWriter.js";
import { calendarRowForMask, parseHourLines, routeIdFor, serviceIdFor, tripIdFor } from "../src/gtfs-scraper/generator.js";
import { Platform } from "../src/domain/listing.js";
import { ScoringService } from "../src/domain/scoring.js";
import { assertCatalog } from "./catalogTests.js";
import { testDuplicateIdentity } from "./duplicateIdentityTests.js";
import { assertPersonalComparables } from "./personalComparablesTests.js";
import { assertPersonalRanking } from "./personalRankingTests.js";
import { assertShadowRanking } from "./shadowRankingTests.js";
import { assertUserFeedback } from "./userFeedbackTests.js";
import { assertSources } from "./sourceTests.js";
import { assertHttpCooldown, assertPhotoRedirects } from "./httpTests.js";
import { assertRoutingStatuses } from "./routingStatusTests.js";
import { assertCandidateQueue } from "./candidateQueueTests.js";
import { assertSpecRegressions } from "./specRegressionTests.js";
import { assertAddressFormatter } from "./addressFormatterTests.js";
import { kufarAdSchema } from "../src/infrastructure/sources/kufarClient.js";
import { onlinerApartmentSchema } from "../src/infrastructure/sources/onlinerClient.js";
import { estimateTransitMinutes, haversineMeters } from "../src/utils/geoMath.js";
import { parseTextSignals } from "../src/utils/textParser.js";

const assertTextParser = (): void => {
  const freshBrick = parseTextSignals(["Кирпичный дом", "Смежные комнаты, свежий ремонт"]);
  assert.equal(freshBrick.isBrickHouse, true);
  assert.equal(freshBrick.hasPrivateHouse, false);
  assert.equal(freshBrick.hasWalkThroughLayout, true);
  assert.equal(freshBrick.hasFreshRepair, true);
  assert.equal(freshBrick.needsRepair, false);

  const oldPanel = parseTextSignals(["Панель 1965, серия 1-464", "Квартира под ремонт"]);
  assert.equal(oldPanel.isOldPanel, true);
  assert.equal(oldPanel.needsRepair, true);

  const privateHouse = parseTextSignals(["Продается коттедж", "Дом с участком 8 соток"]);
  assert.equal(privateHouse.hasPrivateHouse, true);

  const gardenAssociation = parseTextSignals(["Address: Ждановичский сельский Совет, 2 линия, 9", "User address: Ждановичский сельсовет, СТ Электрон"]);
  assert.equal(gardenAssociation.hasPrivateHouse, true);
  assert.equal(gardenAssociation.isAllowedLocality, false);

  const partialOwnership = parseTextSignals(["Продается доля 19/50", "2 комнаты в 4х комн квартире"]);
  assert.equal(partialOwnership.hasPartialOwnership, true);

  const halfHouse = parseTextSignals(["Продам половину дома", "Блокированная квартира с отдельным входом"]);
  assert.equal(halfHouse.hasPartialOwnership, true);

  const rental = parseTextSignals(["Сдаётся на длительный срок 2-квартира"]);
  assert.equal(rental.hasRentalIntent, true);

  const minskLocality = parseTextSignals(["Address: Минск, улица Сурганова, 10"]);
  assert.equal(minskLocality.isAllowedLocality, true);

  const borovlyanyLocality = parseTextSignals(["Town: Боровляны", "Address: Минский район, Боровляны"]);
  assert.equal(borovlyanyLocality.isAllowedLocality, true);

  const unsupportedMinskDistrict = parseTextSignals(["Address: Минский район, Ждановичи"]);
  assert.equal(unsupportedMinskDistrict.isAllowedLocality, false);

  const minskWorldByName = parseTextSignals(["Минск Мир, Белградская ул."]);
  assert.equal(minskWorldByName.isMinskWorld, true);

  const minskWorldByStreet = parseTextSignals(["Леонида Щемелёва, 26"]);
  assert.equal(minskWorldByStreet.isMinskWorld, true);

  const minskWorldByComplex = parseTextSignals(["Complex: ЖК Minsk World", "District: Минск-Мир"]);
  assert.equal(minskWorldByComplex.isMinskWorld, true);

  const unfinished = parseTextSignals(["Repair: Без отделки"]);
  assert.equal(unfinished.needsRepair, true);
};

const assertScoring = (): void => {
  const service = new ScoringService();
  const score = service.score({
    medianPricePerSqm: 2000,
    walkingRoute: {
      nearestMetro: "Немига",
      accessMode: "walking",
      accessMinutes: 8,
      walkingMinutes: 8,
      walkingMeters: 650,
      straightLineMeters: 520,
      provider: "osrm"
    },
    listing: {
      id: "listing-1",
      platform: Platform.KUFAR,
      externalId: "1",
      url: "https://example.com/1",
      title: "Кирпичный дом",
      description: "Евроремонт",
      rooms: 2,
      areaSqm: 50,
      priceUsd: 90000,
      pricePerSqm: 1800,
      photos: [],
      details: [],
      houseType: "кирпич"
    }
  });

  assert.equal(score.fairPricePerSqm, 2000);
  assert.equal(score.ratingScore >= 55, true);
  assert.equal(score.shouldAlert, true);
  assert.equal(score.components.length, 4);

  const floorScore = service.score({
    medianPricePerSqm: 2000,
    listing: {
      id: "listing-2",
      platform: Platform.KUFAR,
      externalId: "2",
      url: "https://example.com/2",
      title: "Квартира",
      description: "",
      rooms: 2,
      areaSqm: 50,
      priceUsd: 90000,
      pricePerSqm: 1800,
      photos: [],
      details: ["Floor: 1", "Floors: 9", "Balcony: Нет", "Bathroom: Раздельный", "Ceiling: от 2.7 м", "Kitchen area: 10"]
    }
  });
  assert.equal(floorScore.multipliers.some((multiplier) => multiplier.code === "first-floor"), true);
  assert.equal(floorScore.multipliers.some((multiplier) => multiplier.code === "no-balcony"), true);
  assert.equal(floorScore.multipliers.some((multiplier) => multiplier.code === "separate-bathroom"), true);

  const transitFallbackScore = service.score({
    medianPricePerSqm: 1700,
    walkingRoute: {
      nearestMetro: "Партизанская",
      accessMode: "public-transit-estimate",
      accessMinutes: 10,
      walkingMinutes: 26,
      walkingMeters: 1816,
      straightLineMeters: 1800,
      transitMinutes: 10,
      provider: "osrm"
    },
    listing: {
      id: "listing-3",
      platform: Platform.KUFAR,
      externalId: "3",
      url: "https://example.com/3",
      title: "Квартира",
      description: "",
      rooms: 3,
      areaSqm: 50,
      priceUsd: 85000,
      pricePerSqm: 1700,
      photos: [],
      details: []
    }
  });
  assert.equal(transitFallbackScore.multipliers.some((multiplier) => multiplier.code === "metro-far"), true);

  const watchScore = service.score({
    medianPricePerSqm: 1900,
    medianSource: "local-2km",
    medianComparableCount: 10,
    listing: {
      id: "listing-4",
      platform: Platform.KUFAR,
      externalId: "4",
      url: "https://example.com/4",
      title: "Квартира",
      description: "",
      rooms: 2,
      areaSqm: 43,
      priceUsd: 80500,
      pricePerSqm: 1872,
      latitude: 53.9,
      longitude: 27.56,
      timeToTargetTransit: 35,
      targetTransitSummary: "WALK 4m -> SUBWAY line Avtozavodskaya line, 25m -> WALK 3m",
      photos: [],
      details: []
    }
  });
  assert.equal(watchScore.shouldAlert, true);
  assert.equal(watchScore.alertKind, "watch");
  assert.equal(watchScore.ratingScore >= 50, true);

  const hotScore = service.score({
    medianPricePerSqm: 2100,
    medianSource: "local-2km",
    medianComparableCount: 12,
    walkingRoute: {
      nearestMetro: "РќРµРјРёРіР°",
      accessMode: "walking",
      accessMinutes: 7,
      walkingMinutes: 7,
      walkingMeters: 550,
      straightLineMeters: 470,
      provider: "osrm"
    },
    listing: {
      id: "listing-5",
      platform: Platform.KUFAR,
      externalId: "5",
      url: "https://example.com/5",
      title: "РљРІР°СЂС‚РёСЂР°",
      description: "",
      rooms: 2,
      areaSqm: 48,
      priceUsd: 78000,
      pricePerSqm: 1625,
      latitude: 53.9,
      longitude: 27.56,
      timeToTargetTransit: 28,
      targetTransitSummary: "WALK 5m -> SUBWAY line Avtozavodskaya line, 20m -> WALK 3m",
      photos: [],
      details: ["Kitchen area: 9", "Bathroom: Р Р°Р·РґРµР»СЊРЅС‹Р№"]
    }
  });
  assert.equal(hotScore.alertKind, "hot");
  assert.equal(hotScore.ratingScore >= 80 || hotScore.discountPct >= 12, true);

  const distressedLowQualityScore = service.score({
    medianPricePerSqm: 2200,
    medianSource: "local-2km",
    medianComparableCount: 8,
    walkingRoute: {
      nearestMetro: "Площадь Якуба Коласа",
      accessMode: "walking",
      accessMinutes: 31,
      walkingMinutes: 31,
      walkingMeters: 2500,
      straightLineMeters: 2100,
      provider: "osrm"
    },
    listing: {
      id: "listing-6",
      platform: Platform.KUFAR,
      externalId: "distressed-low-quality",
      url: "https://example.com/6",
      title: "2-комнатная квартира",
      description: "Квартира под ремонт",
      rooms: 2,
      areaSqm: 45.94,
      priceUsd: 78380.83,
      pricePerSqm: 1706.16,
      latitude: 53.9284,
      longitude: 27.5586,
      timeToTargetTransit: 32,
      targetTransitSummary: "WALK 8m -> TROLLEYBUS line trolleybus 53, 6m -> WALK 1m -> TRAM line tram 3, 10m -> WALK 3m",
      photos: [],
      details: [
        "Ремонт: Без отделки",
        "Тип дома: Панельный",
        "Год постройки: 1962",
        "Этаж: 5",
        "Этажей: 5",
        "Кухня: 5.8"
      ],
      houseType: "Панельный",
      buildingSeries: "1962",
      repairState: "Без отделки"
    }
  });
  assert.equal(distressedLowQualityScore.discountPct > 15, true);
  assert.equal(distressedLowQualityScore.components.find((component) => component.code === "object")?.points, 0);
  assert.equal(distressedLowQualityScore.alertKind, "none");
  assert.equal(distressedLowQualityScore.shouldAlert, false);
};

const assertGeoMath = (): void => {
  const meters = haversineMeters(
    { latitude: 53.9022, longitude: 27.5619 },
    { latitude: 53.9041, longitude: 27.5549 }
  );

  assert.equal(meters > 400 && meters < 600, true);
  assert.equal(estimateTransitMinutes(5400), 22);
};

const assertOnlinerParsing = (): void => {
  const apartment = onlinerApartmentSchema.parse({
    id: "123",
    title: null,
    description: null,
    url: "https://r.onliner.by/pk/apartments/123",
    price: {
      amount: "55000.00",
      currency: "USD"
    },
    area: {
      total: "44.5",
      living: null,
      kitchen: "8.2"
    },
    rent: null,
    number_of_rooms: "2",
    location: {
      latitude: "53.9",
      longitude: "27.56"
    }
  });

  assert.equal(apartment.price.amount, 55000);
  assert.equal(apartment.area.total, 44.5);
  assert.equal(apartment.area.living, null);
  assert.equal(apartment.area.kitchen, 8.2);
  assert.equal(apartment.number_of_rooms, 2);
  assert.equal(apartment.location?.latitude, 53.9);
};

const assertKufarParsing = (): void => {
  const ad = kufarAdSchema.parse({
    ad_id: 1074503120,
    ad_link: "https://re.kufar.by/vi/1074503120",
    subject: "2 кв. по ул. Л.Беды,45",
    body: null,
    body_short: "Продается просторная квартира",
    price_usd: "23000000",
    images: [{ path: "adim1/photo.jpg" }],
    ad_parameters: [
      { p: "rooms", v: "2" },
      { p: "size", v: 77.9 },
      { p: "coordinates", v: [27.598078, 53.943474] },
      { p: "flat_repair", vl: "Евро", v: "5" },
      { p: "house_type", vl: "Каркасно-блочный", v: "10" }
    ]
  });

  assert.equal(ad.price_usd, 23000000);
  assert.equal(Array.isArray(ad.ad_parameters), true);
};

const assertGtfsHelpers = (): void => {
  const startDate = new Date(Date.UTC(2026, 0, 1));
  const weekdays = calendarRowForMask(31, startDate);
  assert.equal(weekdays.monday, "1");
  assert.equal(weekdays.friday, "1");
  assert.equal(weekdays.saturday, "0");
  assert.equal(weekdays.sunday, "0");
  assert.equal(weekdays.start_date, "20260101");
  assert.equal(weekdays.end_date, "20270101");

  const weekends = calendarRowForMask(96, startDate);
  assert.equal(weekends.monday, "0");
  assert.equal(weekends.friday, "0");
  assert.equal(weekends.saturday, "1");
  assert.equal(weekends.sunday, "1");

  assert.deepEqual(
    parseHourLines([
      { hour: "23", minutes: "45 59" },
      { hour: "00", minutes: "07" },
      { hour: "01", minutes: "05" }
    ]),
    ["23:45:00", "23:59:00", "24:07:00", "25:05:00"]
  );

  assert.equal(escapeCsvValue('Stop "Central", line 1'), '"Stop ""Central"", line 1"');
  assert.equal(buildCsv(["name"], [{ name: "Line 1\nLine 2" }]), 'name\n"Line 1\nLine 2"\n');
  assert.equal(routeIdFor("bus", "100"), "bus_100");
  assert.equal(serviceIdFor(31), "mask_31");
  assert.equal(tripIdFor("bus_100", "A", 31, 0), "bus_100_A_mask_31_1");
};

assertTextParser();
assertScoring();
assertGeoMath();
assertOnlinerParsing();
assertKufarParsing();
assertGtfsHelpers();
await assertCatalog();
testDuplicateIdentity();
assertPersonalComparables();
assertPersonalRanking();
const { assertRankingSnapshots } = await import("./rankingSnapshotTests.js");
assertRankingSnapshots();
await assertShadowRanking();
assertUserFeedback();
await assertHttpCooldown();
  await assertPhotoRedirects();
await assertRoutingStatuses();
await assertSources();
await assertCandidateQueue();
await assertSpecRegressions();
assertAddressFormatter();
