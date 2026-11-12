import { chromium } from "playwright";
import assert from "node:assert/strict";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  try {
    console.log("1. Navigating to catalog...");
    await page.goto("http://127.0.0.1:3000", { waitUntil: "domcontentloaded" });
    await page.locator(".listing-card").first().waitFor({ timeout: 20000 });

    console.log("2. Testing deduplication: Search for street 'Чечота'...");
    const searchInput = page.getByLabel("Поиск по адресу и описанию");
    await searchInput.fill("Чечота");
    await page.waitForResponse((r) => r.url().includes("/api/listings?") && r.status() === 200);
    await page.waitForTimeout(1000);

    const cards = page.locator(".listing-card");
    const totalCards = await cards.count();
    console.log(`Found ${totalCards} listings on street Чечота.`);

    const addressLines: string[] = [];
    for (let i = 0; i < totalCards; i++) {
      const addr = await cards.nth(i).locator(".address-line").innerText();
      addressLines.push(addr);
    }

    // Find cards whose ADDRESS specifically has "28"
    const h28Addresses = addressLines.filter((a) => /\b28\b/.test(a));
    console.log("Addresses matching house 28:", h28Addresses);
    assert.equal(h28Addresses.length, 1, "There must be exactly 1 listing card with address on house 28!");

    const chechotaCard = cards.filter({ has: page.locator(".address-line", { hasText: /\b28\b/ }) }).first();
    const badges = await chechotaCard.locator(".source-badge").allTextContents();
    console.log(`Source badges on Чечота 28 card: ${badges.join(", ")}`);
    assert.ok(badges.length >= 2, "Merged card must show multiple source badges (e.g. Реалт, Куфар, Онлайнер)");

    console.log("3. Testing map view for Чечота 28...");
    const mapPromise = page.waitForResponse((r) => r.url().includes("/api/map?") && r.status() === 200);
    await page.getByRole("button", { name: "Карта", exact: true }).click();
    const mapRes = await mapPromise;
    const mapJson = await mapRes.json();
    console.log(`Map returned ${mapJson.located} located points on street Чечота.`);
    await page.locator(".leaflet-container").waitFor();
    await page.waitForTimeout(1000);

    // Chechota 28 coordinates: ~53.8455, 27.4829
    const chechota28Points = (mapJson.points as any[]).filter((p) =>
      Math.abs(p.latitude - 53.8455) < 0.001 && Math.abs(p.longitude - 27.4829) < 0.001
    );
    console.log(`Chechota 28 points on map:`, chechota28Points);
    assert.equal(chechota28Points.length, 1, "There must be exactly 1 point on the map for Chechota 28, not 3 duplicates!");

    await page.screenshot({ path: "artifacts/verify-map-dedup.png" });

    console.log("4. Opening detail drawer for an apartment with comparables...");
    // Direct navigation using ?item=9b617889-845c-43ad-b408-90b24eba2f64 which has 12 comparables
    await page.goto("http://127.0.0.1:3000/?item=9b617889-845c-43ad-b408-90b24eba2f64", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Характеристики", exact: true }).waitFor({ timeout: 15000 });

    console.log("5. Verifying Route to work...");
    const routeHeading = page.getByRole("heading", { name: /^До работы/ });
    await routeHeading.waitFor();
    console.log("Route to work section found:", await routeHeading.innerText());

    console.log("6. Verifying Analogs / Comparables as cards with photos and parameters...");
    const compSection = page.locator(".detail-section").filter({ hasText: /Сопоставимые предложения/ });
    await compSection.waitFor({ timeout: 5000 });
    console.log("Section heading:", await compSection.locator("h3").innerText());

    // Verify there is NO <table> in comparables anymore
    assert.equal(await compSection.locator("table").count(), 0, "Table should be replaced by cards!");

    // Verify .comparables-scroll and .comparable-card elements exist
    const compScroll = compSection.locator(".comparables-scroll");
    await compScroll.waitFor({ timeout: 5000 });
    const compCards = compScroll.locator(".comparable-card");
    const compCardCount = await compCards.count();
    console.log(`Rendered ${compCardCount} comparable cards in scroll container!`);
    assert.ok(compCardCount > 0, "Comparable cards should be rendered!");

    const firstCard = compCards.first();
    const priceText = await firstCard.locator(".comparable-card-price").innerText();
    const paramsText = await firstCard.locator(".comparable-card-params").innerText();
    const distanceText = await firstCard.locator(".comparable-distance-tag").innerText();
    const badgeText = await firstCard.locator(".comparable-badge").innerText();

    console.log("First comparable card details:");
    console.log("  Price:", priceText.replace(/\n/g, " "));
    console.log("  Params:", paramsText);
    console.log("  Distance:", distanceText);
    console.log("  Badge:", badgeText);

    assert.ok(priceText.includes("$"), "Card must have price in USD");
    assert.ok(paramsText.includes("м²"), "Card must have area in m²");
    assert.ok(distanceText.includes("м"), "Card must have distance");

    // Take screenshot of detail drawer with comparable cards
    await page.screenshot({ path: "artifacts/verify-comparables-cards.png" });

    // Test clicking on a comparable card
    console.log("7. Testing click on comparable card...");
    await firstCard.click();
    await page.waitForTimeout(1000);
    await page.getByRole("heading", { name: "Характеристики", exact: true }).waitFor();
    console.log("Successfully navigated to comparable apartment!");

    assert.deepEqual(errors, []);
    console.log("\n>>> ALL VERIFICATIONS PASSED SUCCESSFULLY! <<<");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
