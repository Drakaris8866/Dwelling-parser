import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import pino from "pino";
import { catalogDetailSchema, catalogPageSchema, settingsSchema, type CatalogItem } from "../src/contracts/catalog.js";
import { COMMUTE_VERSION } from "../src/domain/commutePolicy.js";

const logger = pino();
const base = "http://127.0.0.1:3000";

const main = async (): Promise<void> => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const filters = { bounds: { south: 53.875, north: 53.945, west: 27.46, east: 27.65 } };
    const query = new URLSearchParams({ filters: JSON.stringify(filters), pageSize: "100" });
    let item: CatalogItem | undefined;
    for (let attempt = 0; attempt < 60 && !item; attempt++) {
      const response = await page.request.get(`${base}/api/listings?${query}`);
      const data = catalogPageSchema.parse(await response.json() as unknown);
      item = data.items.find((row) => row.assessment?.priceEvidence && row.routes?.policyVersion === COMMUTE_VERSION && row.routes.target?.arriveBy)
        ?? data.items.find((row) => row.assessment?.priceEvidence && row.latitude !== null && row.longitude !== null);
      if (!item) await delay(1500);
    }
    assert.ok(item, "Expected an assessed apartment with coordinates");
    const propertyId = item.id;
    await page.goto(`${base}/?item=${item.id}`, { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog", { name: "Подробности квартиры" });
    const map = dialog.getByRole("region", { name: "Карта квартиры" });
    await map.locator(".home-pin").waitFor();
    await map.locator(".leaflet-tile-loaded").first().waitFor({ timeout: 15_000 });
    const buildRoute = dialog.getByRole("button", { name: "Построить маршрут до работы" });
    const fullRoute = dialog.getByRole("button", { name: "Весь маршрут" });
    if (await buildRoute.isVisible() && await buildRoute.isEnabled()) {
      const accepted = page.waitForResponse((r) => r.url().endsWith(`/api/listings/${item.id}/route`) && r.status() === 202);
      await buildRoute.click(); await accepted;
    }
    await fullRoute.waitFor({ timeout: 60_000 });
    const saved = catalogDetailSchema.parse(await (await page.request.get(`${base}/api/listings/${item.id}`)).json() as unknown);
    const settings = settingsSchema.parse(await (await page.request.get(`${base}/api/settings`)).json() as unknown);
    assert.deepEqual(saved.item.routes?.target?.destination, { latitude: settings.targetLatitude, longitude: settings.targetLongitude });
    assert.equal(saved.item.routes?.target?.time, settings.arrivalTime);
    assert.equal(saved.item.routes?.target?.arriveBy, true);
    await fullRoute.click();
    await map.locator(".work-pin").waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".listing-detail-map path.commute-line")].some((path) => path instanceof SVGPathElement && path.getTotalLength() > 1));
    const alternative = saved.item.routes?.alternatives?.[0];
    if (alternative) {
      const label = { surface: "Без метро", tram: "С трамваем", fastest: "Самый быстрый" }[alternative.kind];
      const button = dialog.getByRole("button", { name: label, exact: true });
      await button.click();
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      await dialog.getByRole("heading", { name: `До работы · ${label.toLocaleLowerCase("ru-RU")}` }).waitFor();
    }
    await dialog.locator(".listing-map-section").getByText(/Выход .*Прибытие .*Запас .*Пешком/).waitFor();
    await mkdir("artifacts", { recursive: true });
    await dialog.locator(".listing-map-section").screenshot({ path: "artifacts/listing-commute-map.png" });
    await dialog.getByText("Как отобраны аналоги", { exact: true }).click();
    await dialog.locator(".assessment-disclosure summary").filter({ hasText: "Транспорт" }).click();
    await dialog.getByText("Время до точки назначения", { exact: true }).waitFor();
    await dialog.getByText("Цена в расчёте", { exact: true }).waitFor();
    await dialog.getByRole("heading", { name: "Квартира и дом по фото" }).waitFor();
    await dialog.getByRole("heading", { name: "Рыночная выгодность" }).waitFor();
    await dialog.getByRole("heading", { name: "Выгодность с учётом ремонта" }).waitFor();
    let budgetRequest: unknown;
    await page.route(`**/api/listings/${propertyId}/renovation-budget`, async (route) => {
      assert.equal(route.request().method(), "PATCH");
      budgetRequest = route.request().postDataJSON() as unknown;
      await route.fulfill({ json: { ok: true } });
    });
    await dialog.getByRole("spinbutton", { name: "Ваш бюджет ремонта, $" }).fill("12500");
    const budgetSaved = page.waitForResponse((r) => r.url().endsWith(`/api/listings/${propertyId}/renovation-budget`) && r.ok());
    await dialog.getByRole("button", { name: "Сохранить бюджет" }).click();
    await budgetSaved;
    assert.deepEqual(budgetRequest, { budgetUsd: 12500 });
    await dialog.locator(".assessment-panel").screenshot({ path: "artifacts/listing-assessment.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const area = document.querySelector(".listing-detail-map")?.getBoundingClientRect();
      const markers = [...document.querySelectorAll(".listing-detail-map .detail-map-pin")];
      return area && markers.length === 2 && markers.every((marker) => {
        const rect = marker.getBoundingClientRect();
        return rect.left >= area.left && rect.right <= area.right && rect.top >= area.top && rect.bottom <= area.bottom;
      });
    });
    assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, "Apartment detail must not overflow on mobile");
    await dialog.locator(".listing-map-section").screenshot({ path: "artifacts/listing-commute-mobile.png" });
    assert.deepEqual(errors, []);
    logger.info({ propertyId: item.id }, "Listing assessment and real OTP map checks passed");
  } finally { await browser.close(); }
};
void main().catch((err: unknown) => { logger.error({ err }, "Listing detail browser check failed"); process.exitCode = 1; });
