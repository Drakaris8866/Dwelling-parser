import assert from "node:assert/strict";
import pino from "pino";
import { z } from "zod";
import { RetryHttpClient, type JsonRequest } from "../src/infrastructure/http/retryHttpClient.js";
import { KufarClient } from "../src/infrastructure/sources/kufarClient.js";
import { OnlinerClient } from "../src/infrastructure/sources/onlinerClient.js";
import { RealtScraper } from "../src/infrastructure/sources/realtScraper.js";
import { PlaywrightBrowserFactory } from "../src/infrastructure/browser/playwrightBrowserFactory.js";
import { readFile } from "node:fs/promises";

const logger = pino({ enabled: false });
class FixtureHttp extends RetryHttpClient {
  requests: JsonRequest[] = [];
  constructor(private readonly response: unknown, private readonly html = "") { super(logger); }
  override async json<T>(request: JsonRequest, schema: z.ZodType<T>): Promise<T> { this.requests.push(request); return schema.parse(this.response); }
  override async text(request: JsonRequest): Promise<string> { this.requests.push(request); return this.html; }
}
export const assertSources = async (): Promise<void> => {
  const ad = { type: "sell", ad_id: 1071973376, ad_link: "https://re.kufar.by/vi/1071973376", subject: "Квартира", body: null, price_usd: "55000", price_byn: "15950000", images: [{ path: "adim1/photo.jpg" }], ad_parameters: [
    { p: "rooms", v: "0", vl: "Студия" }, { p: "size", v: 28.8, vl: "" }, { p: "size_kitchen", v: 6.2, vl: "" }, { p: "region", vl: "Минск", v: 7 },
    { p: "address", v: "Минск, Тестовая, 1", vl: "" }, { p: "coordinates", v: [27.56, 53.9] }, { p: "house_type", v: "1", vl: "Панельный" }, { p: "flat_repair", vl: "Косметический" }
  ] };
  const http = new FixtureHttp({ ads: [ad, { ...ad, ad_id: 2, type: "rent" }, { ad_id: 3 }], pagination: { pages: [{ label: "next", token: "abc" }] } });
  const kufar = new KufarClient({ kufarApiUrl: "https://api.kufar.by/search-api/v2/search/rendered-paginated?prc=r:0,90000&rms=v.or:2,3&st=r:35,1000" }, http, logger);
  const page = await kufar.fetchCatalogPage({ page: 1 });
  assert.equal(page.candidates.length, 1); assert.equal(page.invalid, 2); assert.equal(page.next?.cursor, "abc");
  assert.equal(page.candidates[0]?.rooms, 0); assert.equal(page.candidates[0]?.features?.isStudio, true);
  assert.equal(page.candidates[0]?.features?.address, "Минск, Тестовая, 1"); assert.equal(page.candidates[0]?.features?.kitchenSqm, 6.2);
  assert.equal(page.candidates[0]?.priceUsd, 55000); assert.equal(page.candidates[0]?.priceByn, 159500);
  assert.equal(page.candidates[0]?.photos[0], "https://rms.kufar.by/v1/list_thumbs_2x/adim1/photo.jpg");
  const url = new URL(http.requests[0]!.url);
  for (const key of ["prc", "rms", "st"]) assert.equal(url.searchParams.has(key), false);
  assert.equal(url.searchParams.get("size"), "100");
  assert.equal(kufar.normalizeStored({ ...ad, price_usd: "5500000" })?.priceUsd, 55000);
  assert.equal(kufar.normalizeStored({ ...ad, ad_parameters: ad.ad_parameters.filter((p) => p.p !== "address"), account_parameters: [{ p: "address", v: "Стариновская ул, 7, Минск", vl: "" }] })?.features?.address, "Стариновская ул, 7, Минск");
  const onlinerHttp = new FixtureHttp({ apartments: [{ id: 1, url: "https://r.onliner.by/pk/apartments/1", price: { amount: "55000.00", currency: "USD" }, area: { total: "35", kitchen: 0, living: null }, number_of_rooms: "1", location: { address: "Минск, Тестовая, 1", latitude: 53.9, longitude: 27.56 } }, { id: 2 }], page: { current: 1, last: 73 } });
  const onliner = new OnlinerClient({ onlinerApiUrl: "https://r.onliner.by/sdapi/pk.api/search/apartments" }, onlinerHttp, logger);
  const onlinerPage = await onliner.fetchCatalogPage({ page: 1 });
  assert.equal(onlinerPage.candidates.length, 1); assert.equal(onlinerPage.invalid, 1); assert.equal(onlinerPage.next?.page, 2);
  assert.equal(onlinerPage.candidates[0]?.priceUsd, 55000);
  const objects = [{ code: 1, rooms: "1", areaTotal: "30", priceCurrency: 840, price: "60000", images: [], townName: "Минск", stateDistrictName: "Минский", location: [27.56, 53.9], houseType: 11, repairState: 2, buildingYear: 2012 }, { code: 2 }];
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { objects, pagination: { page: 1, pageSize: 30, totalCount: 1000 } } } })}</script>`;
  const realtHttp = new FixtureHttp(null, html);
  const realt = new RealtScraper({ realtSearchUrl: "https://realt.by/sale/flats/" }, new PlaywrightBrowserFactory({ scraperUserAgent: "test" }, logger), logger, realtHttp);
  const realtPage = await realt.fetchCatalogPage({ page: 1 });
  assert.equal(realtPage.candidates.length, 1); assert.equal(realtPage.invalid, 1); assert.equal(realtPage.next?.page, 2);
  assert.equal(realtPage.candidates[0]?.features?.buildingMaterial, "monolith", "Verified frame label uses the existing material parser");
  assert.equal(realtPage.candidates[0]?.features?.buildingYear, 2012);
  const labels = z.object({ houseType: z.record(z.string(), z.string()), repairState: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile("tests/fixtures/realtCategoryLabels.json", "utf8")) as unknown);
  for (const field of ["houseType", "repairState"] as const) {
    for (const [code, label] of Object.entries(labels[field])) {
      for (const value of [Number(code), code, label]) {
        const candidate = realt.normalizeStored({ ...objects[0], [field]: value });
        assert.equal(candidate?.[field], label, `Realt ${field} ${value}`);
        assert.ok(candidate?.details.includes(`${field === "houseType" ? "House type" : "Repair"}: ${label}`));
        assert.equal((candidate?.sourcePayload as Record<string, unknown>)[field], value, "Raw enum must remain available");
      }
    }
    for (const value of [999, "999", -1, 1.5, "1.5", "1x", "+1", "", null, undefined]) {
      const candidate = realt.normalizeStored({ ...objects[0], [field]: value });
      assert.equal(candidate?.[field], undefined, `Unknown or missing Realt ${field}`);
      assert.equal(candidate?.details.some((detail) => detail.startsWith(field === "houseType" ? "House type:" : "Repair:")), false);
    }
    for (const value of [{ value: 1 }, [1], true]) assert.equal(realt.normalizeStored({ ...objects[0], [field]: value }), undefined);
  }
  assert.equal(realt.normalizeStored({ ...objects[0], houseType: "Не указан" })?.houseType, "Не указан", "Readable labels remain intact");
  assert.equal(realt.normalizeStored({ ...objects[0], houseType: 0 })?.features?.buildingMaterial, "brick", "Zero is a documented material code");
  for (const [code, repair, readiness] of [[2, "good", "ready"], [3, undefined, undefined], [5, undefined, undefined], [7, "none", "unfinished"], [8, "none", "unfinished"]] as const) {
    const candidate = realt.normalizeStored({ ...objects[0], repairState: code });
    assert.equal(candidate?.features?.repair, repair, `Realt repair code ${code}`);
    assert.equal(candidate?.features?.readiness, readiness, `Realt readiness code ${code}`);
  }
  const wrappedHtml = await readFile("tests/fixtures/realt-wrapped-parameters.html", "utf8");
  const detailSource = new RealtScraper({ realtSearchUrl: "https://realt.by/sale/flats/" }, new PlaywrightBrowserFactory({ scraperUserAgent: "test" }, logger), logger, new FixtureHttp(null, wrappedHtml));
  const legacyEnriched = await detailSource.enrich({ ...realtPage.candidates[0]!, descriptionComplete: true,
    houseType: "1", repairState: "2", details: ["House type: 1", "Repair: 2"], features: { provenance: {} } });
  assert.equal(legacyEnriched.features?.buildingMaterial, "panel", "Detail enrichment must decode stored numeric source fields too");
  assert.equal(legacyEnriched.features?.repair, "good");
  for (const adapter of [kufar, onliner, realt]) {
    const fixture = z.object({ platform: z.string(), items: z.array(z.unknown()).min(1) }).parse(JSON.parse(await readFile(`tests/fixtures/${adapter.platform.toLowerCase()}.json`, "utf8")) as unknown);
    for (const raw of fixture.items) {
      const parsed = adapter.normalizeStored(raw);
      assert.ok(parsed, `Captured ${adapter.platform} schema must normalize`);
      assert.ok(parsed.priceUsd > 0 && parsed.areaSqm > 0);
    }
  }
};
