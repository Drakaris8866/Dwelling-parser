import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { catalogItemSchema, DEFAULT_SETTINGS } from "../src/contracts/catalog.js";
import { personalRankingSettingsSchema, personalRankingSnapshotResponseSchema } from "../src/contracts/personalRanking.js";
import { calculatePersonalRanking } from "../src/domain/personalRanking.js";
import { estimateRenovation } from "../src/domain/renovationEstimate.js";

const main = async (): Promise<void> => {
  const root = resolve("web/dist");
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const path = resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
    if (path !== root && !path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    void readFile(path).then((body) => {
      response.setHeader("content-type", ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html" } as Record<string, string>)[extname(path)] ?? "application/octet-stream");
      response.end(body);
    }).catch(() => { response.writeHead(404).end(); });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    const item = catalogItemSchema.parse({ id, listingId: "22222222-2222-4222-8222-222222222222", title: "Тестовая квартира", description: "Проверка сохранённого бюджета", rooms: 2, areaSqm: 50, priceUsd: 68000, priceByn: 204000, priceSqm: 1360, latitude: null, longitude: null, photos: [], features: { address: "Минск, Тестовая, 1", provenance: {} }, disposition: "ACCEPTED", reasons: [], favorite: false, hidden: false, firstSeenAt: "2026-11-10T00:00:00Z", lastSeenAt: "2026-11-10T00:00:00Z", sources: [], assessment: null, routes: null, enrichmentStatus: "PENDING" });
    const comparables = Array.from({ length: 5 }, (_, index) => ({ propertyId: `comparable-${index}`, externalId: `ad-${index}`, platform: "KUFAR" as const, address: `Минск, Тестовая, ${index + 2}`, priceUsd: 78000, priceSqm: 1560, areaSqm: 50, distanceMeters: 100 }));
    const usdRate = { usdPerSqm: 300, scope: "full" as const, observedOn: "2026-11-10", source: "Пользовательская оценка" };
    const renovation = estimateRenovation({ areaSqm: 50, condition: "full", reservePct: 0, asOf: "2026-11-10", usdRate });
    const inputs = { purchaseUsd: 68000, areaSqm: 50, eligible: true, renovation, asIsComparables: comparables, readyComparables: comparables, knownComparableFeatures: 4, minimumComparables: 3, components: { house: 70, commute: 70, location: 70, layout: 70 } };
    let settings = personalRankingSettingsSchema.parse({ previewEnabled: true, reservePct: 0, usdRate, minimumComparables: 3 });
    const current = personalRankingSnapshotResponseSchema.parse({ status: "current", snapshot: { id: "snapshot-1", propertyId: id, inputHash: "fixture", calculatedAt: "2026-11-10T07:00:00Z", asOf: "2026-11-10", settingsVersion: "fixture", purchaseUsd: 68000, result: calculatePersonalRanking(inputs), renovation, asIsComparables: comparables, readyComparables: comparables, rejections: { asIs: {}, ready: {} }, priceEvidence: [], inputs, settings, versions: { ranking: 1, comparables: 1 }, sourceHashes: [] } });
    const unknownRenovation = estimateRenovation({ areaSqm: 50, condition: "unknown", reservePct: 10, asOf: "2026-11-10" });
    const unknownInputs = { ...inputs, renovation: unknownRenovation, components: {} };
    const unknown = personalRankingSnapshotResponseSchema.parse({ ...current, snapshot: { ...current.snapshot, renovation: unknownRenovation, inputs: unknownInputs, result: calculatePersonalRanking(unknownInputs) } });
    const insufficientInputs = { ...inputs, readyComparables: comparables.slice(0, 2) };
    const insufficient = personalRankingSnapshotResponseSchema.parse({ ...current, snapshot: { ...current.snapshot, inputs: insufficientInputs, readyComparables: insufficientInputs.readyComparables, result: calculatePersonalRanking(insufficientInputs) } });
    const acceptedRenovation = estimateRenovation({ areaSqm: 50, condition: "user-finished", reservePct: 10, asOf: "2026-11-10" });
    const acceptedInputs = { ...inputs, renovation: acceptedRenovation };
    const accepted = personalRankingSnapshotResponseSchema.parse({ ...current, snapshot: { ...current.snapshot, settings: { ...settings, zeroBudgetForFinishedRepair: true }, renovation: acceptedRenovation, inputs: acceptedInputs, result: calculatePersonalRanking(acceptedInputs) } });
    let releaseLoading: (() => void) | undefined;
    let state: "current" | "stale" | "disabled" | "absent" | "error" | "loading" | "unknown" | "insufficient" | "user-rule" = "current";
    let settingsWrites = 0;
    let failSettingsSave = false;
    let rankingReads = 0;
    const errors: string[] = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let payload: unknown;
      if (path === `/api/listings/${id}/personal-ranking`) {
        rankingReads++;
        if (state === "loading") { await new Promise<void>((release) => { releaseLoading = release; }); payload = { status: "absent", snapshot: null }; }
        else if (state === "error") { await route.fulfill({ status: 503, json: { message: "Тестовая недоступность" } }); return; }
        else if (state === "unknown") payload = unknown;
        else if (state === "insufficient") payload = insufficient;
        else if (state === "user-rule") payload = accepted;
        else payload = state === "current" || state === "stale" ? { ...current, status: state } : { status: state, snapshot: null };
      } else if (path === "/api/personal-ranking/settings") {
        if (request.method() === "PUT") {
          settingsWrites++;
          if (failSettingsSave) { await route.fulfill({ status: 503, json: { message: "Не удалось сохранить тестовые настройки" } }); return; }
          settings = personalRankingSettingsSchema.parse(request.postDataJSON() as unknown);
        }
        payload = settings;
      } else if (request.method() !== "GET") throw new Error(`Unexpected mutation ${request.method()} ${path}`);
      else if (path === `/api/listings/${id}`) payload = { item, priceHistory: [], photoRepairAvailable: false };
      else if (path === "/api/listings") payload = { items: [item], total: 1, page: 1, pageSize: 24, pages: 1 };
      else if (path === "/api/settings") payload = DEFAULT_SETTINGS;
      else if (path === "/api/facets") payload = { localities: [], districts: [] };
      else if (path === "/api/health") payload = { sources: [], otp: { available: false, message: "fixture" }, pendingJobs: 0, tasks: [] };
      else if (path === "/api/searches") payload = [];
      else throw new Error(`Unexpected API request ${path}`);
      await route.fulfill({ json: payload });
    });
    const openDetail = async (): Promise<void> => { await page.goto(`${base}/?item=${id}`, { waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "Персональный рейтинг", exact: true }).waitFor(); };
    const panel = page.locator(".personal-ranking-panel");
    await mkdir("work/personal-ranking-browser", { recursive: true });
    await openDetail();
    await panel.getByText("Покупка и ремонт", { exact: true }).waitFor();
    await panel.getByText("83 000–83 000 USD", { exact: true }).waitFor();
    await panel.getByText("300 USD/м²", { exact: false }).waitFor();
    await panel.getByText("Курс валют не применяется", { exact: false }).waitFor();
    await panel.getByText("Минимум аналогов в этом расчёте: 3.", { exact: true }).waitFor();
    await panel.locator(".ranking-budget").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/desktop-current.png" });
    await panel.locator("summary").click();
    await panel.getByText("Готовые: 5", { exact: true }).waitFor();
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/desktop-evidence.png" });
    for (const next of ["stale", "disabled", "absent", "loading", "error"] as const) {
      state = next;
      await openDetail();
      const text = next === "stale" ? "Расчёт устарел" : next === "disabled" ? "Предпросмотр выключен" : next === "absent" ? "Сохранённого расчёта пока нет" : next === "loading" ? "Загружаем сохранённый расчёт" : "Не удалось загрузить расчёт";
      await panel.getByText(text, { exact: false }).waitFor({ timeout: 15000 });
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `work/personal-ranking-browser/desktop-${next}.png` });
      if (next === "loading") {
        assert.equal(await panel.getAttribute("aria-busy"), "true");
        assert.ok(releaseLoading, "Loading request must be held until its state is asserted");
        releaseLoading();
        await panel.getByText("Сохранённого расчёта пока нет", { exact: false }).waitFor();
      }
      if (next === "error") {
        state = "current";
        await panel.getByRole("button", { name: "Повторить загрузку" }).click();
        await panel.getByText("Покупка и ремонт", { exact: true }).waitFor();
      }
    }
    state = "unknown";
    await openDetail();
    await panel.getByText("Полный бюджет неизвестен", { exact: true }).waitFor();
    await panel.getByText("Состояние квартиры не подтверждено", { exact: true }).waitFor();
    assert.equal(await panel.getByText("Неизвестно", { exact: true }).count(), 5, "Unknown component scores must be labelled rather than shown as zero");
    await panel.locator(".ranking-budget").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/desktop-unknown.png" });
    state = "insufficient";
    await openDetail();
    await panel.getByText("Для оценки нужно не менее 3 подходящих местных аналогов.", { exact: true }).waitFor();
    await panel.getByText("Минимум аналогов в этом расчёте: 3.", { exact: true }).waitFor();
    state = "user-rule";
    await openDetail();
    await panel.getByText("Бюджет ремонта принят равным 0 USD по вашему правилу для готовой квартиры с отделкой.", { exact: true }).waitFor();
    await panel.getByText("68 000–68 000 USD", { exact: true }).waitFor();
    await panel.locator(".ranking-budget").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/desktop-zero-budget-rule.png" });
    state = "current";
    await page.setViewportSize({ width: 390, height: 844 });
    await openDetail();
    await panel.getByText("Покупка и ремонт", { exact: true }).waitFor();
    await panel.locator(".ranking-budget").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Mobile document must not overflow horizontally");
    await page.screenshot({ path: "work/personal-ranking-browser/mobile-current.png" });
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    const form = page.locator("form.personal-ranking-settings");
    await form.getByRole("button", { name: "Сохранить настройки рейтинга" }).waitFor();
    assert.equal(await form.getByLabel("Минимум аналогов", { exact: true }).inputValue(), "3");
    for (const invalid of ["2", "3.5", "21", ""]) {
      await form.getByLabel("Минимум аналогов", { exact: true }).fill(invalid);
      await form.getByRole("button", { name: "Сохранить настройки рейтинга" }).click();
      await form.getByRole("alert").waitFor();
      assert.equal(settingsWrites, 0, "Invalid analogue thresholds must not save");
      assert.equal(await form.getByLabel("Минимум аналогов", { exact: true }).getAttribute("aria-invalid"), "true");
      assert.equal(await form.getByLabel("Минимум аналогов", { exact: true }).evaluate(input => input === document.activeElement), true);
    }
    await form.getByLabel("Минимум аналогов", { exact: true }).fill("3");
    await form.getByLabel("Минимум аналогов", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/mobile-minimum-analogs.png" });
    assert.equal(await form.getByLabel("Стоимость ремонта, USD/м²", { exact: true }).inputValue(), "300");
    await form.getByLabel("Стоимость ремонта, USD/м²", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/mobile-usd-settings.png" });
    await form.getByLabel("Стоимость ремонта, USD/м²", { exact: true }).fill("350");
    await form.getByLabel("Резерв на ремонт, %").fill("15");
    await form.getByLabel("Бюджет ремонта готовой квартиры с отделкой — 0 USD", { exact: true }).check();
    assert.equal(settingsWrites, 0, "Editing must not autosave");
    failSettingsSave = true;
    await form.getByRole("button", { name: "Сохранить настройки рейтинга" }).click();
    await form.getByRole("alert").waitFor();
    assert.equal(await form.getByLabel("Резерв на ремонт, %").inputValue(), "15");
    failSettingsSave = false;
    await form.getByRole("button", { name: "Сохранить настройки рейтинга" }).click();
    await form.getByText("Настройки персонального рейтинга сохранены.", { exact: true }).waitFor();
    assert.equal(settings.reservePct, 15, "Explicit save must submit the edited value");
    assert.equal(settings.minimumComparables, 3, "Explicit save must retain the selected analogue threshold");
    assert.equal(settings.zeroBudgetForFinishedRepair, true, "The user's finished-repair rule must save explicitly");
    assert.equal(settings.usdRate?.usdPerSqm, 350, "USD rate must be adjustable and saved without FX or labor/material fabrication");
    assert.equal(settings.fx, undefined);
    assert.equal(settings.rates, undefined);
    await form.getByLabel("Показывать сохранённые расчёты").focus();
    await page.keyboard.press("Space");
    assert.equal(await form.getByLabel("Показывать сохранённые расчёты").isChecked(), false, "Checkbox must work from keyboard");
    await form.getByLabel("Задать ставки ремонта", { exact: true }).check();
    await form.getByRole("button", { name: "Сохранить настройки рейтинга" }).click();
    await form.getByRole("alert").waitFor();
    assert.equal(settingsWrites, 2, "Invalid empty rates must stay local and never save");
    assert.equal(await form.locator('[name="rates.labor.low"]').getAttribute("aria-invalid"), "true");
    assert.equal(await form.locator('[name="rates.labor.low"]').evaluate((input) => input === document.activeElement), true, "Validation must focus the first invalid field");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Mobile settings must not overflow horizontally");
    await form.locator(".ranking-feedback").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/mobile-settings-validation.png" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await form.getByLabel("Минимум аналогов", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/desktop-minimum-analogs.png" });
    await form.getByLabel("Стоимость ремонта, USD/м²", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/desktop-usd-settings.png" });
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/personal-ranking-browser/desktop-settings.png" });
    await form.getByLabel("Задать ставки ремонта", { exact: true }).uncheck();
    await form.getByLabel("Резерв на ремонт, %").fill("101");
    await form.getByRole("button", { name: "Сохранить настройки рейтинга" }).click();
    await form.getByRole("alert").waitFor();
    assert.equal(settingsWrites, 2, "Out-of-range reserve must never save");
    assert.equal(await form.getByLabel("Резерв на ремонт, %").evaluate((input) => input === document.activeElement), true);
    await form.getByLabel("Резерв на ремонт, %").fill("15");
    await form.getByLabel("Задать подтверждённый курс BYN/USD", { exact: true }).check();
    await form.getByLabel("BYN за 1 USD", { exact: true }).fill("0");
    await form.getByLabel("Источник курса", { exact: true }).fill("Тестовый источник");
    await form.getByLabel("Дата курса, ГГГГ-ММ-ДД", { exact: true }).fill("2026-02-30");
    await form.getByRole("button", { name: "Сохранить настройки рейтинга" }).click();
    await form.getByRole("alert").waitFor();
    assert.equal(settingsWrites, 2, "Invalid FX and calendar date must never save");
    assert.equal(await form.getByLabel("BYN за 1 USD", { exact: true }).getAttribute("aria-invalid"), "true");
    assert.equal(await form.getByLabel("Дата курса, ГГГГ-ММ-ДД", { exact: true }).getAttribute("aria-invalid"), "true");
    await form.getByLabel("Задать подтверждённый курс BYN/USD", { exact: true }).uncheck();
    await form.getByLabel("Стоимость ремонта, USD/м²", { exact: true }).fill("0");
    await form.getByLabel("Дата ставки USD, ГГГГ-ММ-ДД", { exact: true }).fill("2026-02-30");
    await form.getByRole("button", { name: "Сохранить настройки рейтинга" }).click();
    await form.getByRole("alert").waitFor();
    assert.equal(settingsWrites, 2, "Invalid USD rate/date must never save");
    assert.equal(await form.getByLabel("Стоимость ремонта, USD/м²", { exact: true }).getAttribute("aria-invalid"), "true");
    assert.equal(await form.getByLabel("Стоимость ремонта, USD/м²", { exact: true }).evaluate((input) => input === document.activeElement), true);
    assert.equal(await form.getByLabel("Дата ставки USD, ГГГГ-ММ-ДД", { exact: true }).getAttribute("aria-invalid"), "true");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: "passed", rankingReads, settingsWrites, viewports: [1440, 390], states: ["current", "stale", "disabled", "absent", "loading", "unknown", "insufficient/minimum3", "error/retry", "settings failure/retry", "keyboard", "validation/focus", "minimum-analogues-validation"], liveMutations: 0 }));
  } finally { await browser.close(); await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); }
};
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
