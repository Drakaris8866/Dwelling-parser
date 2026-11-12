import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "../../config/env.js";
import type { Logger } from "../logger.js";

export type BrowserSession = {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  close(): Promise<void>;
};

export class PlaywrightBrowserFactory {
  constructor(
    private readonly config: Pick<AppConfig, "scraperProxyUrl" | "scraperUserAgent">,
    private readonly logger: Logger
  ) {}

  async create(): Promise<BrowserSession> {
    const browser = await chromium.launch({
      headless: true,
      ...(this.config.scraperProxyUrl === undefined ? {} : { proxy: { server: this.config.scraperProxyUrl } })
    });

    try {
      const context = await browser.newContext({
        userAgent: this.config.scraperUserAgent,
        locale: "ru-RU",
        timezoneId: "Europe/Minsk",
        viewport: { width: 1366, height: 768 }
      });
      const page = await context.newPage();

      return {
        browser,
        context,
        page,
        close: async (): Promise<void> => {
          await context.close();
          await browser.close();
        }
      };
    } catch (error: unknown) {
      this.logger.error({ err: error }, "Failed to create Playwright browser context");
      await browser.close();
      throw error;
    }
  }
}
