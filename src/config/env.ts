import { z } from "zod";

const booleanStringSchema = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  KUFAR_API_URL: z.string().url(),
  ONLINER_API_URL: z.string().url(),
  REALT_SEARCH_URL: z.string().url(),
  OSRM_ROUTE_URL: z.string().url().default("https://router.project-osrm.org/route/v1/foot"),
  GEO_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(90),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  TELEGRAM_REPLAY_ALERTS_ON_DEV: booleanStringSchema,
  TELEGRAM_SEND_ALL_SCORED_ON_DEV: booleanStringSchema,
  SCRAPER_PROXY_URL: z.string().url().optional().or(z.literal("")),
  SCRAPER_USER_AGENT: z.string().min(1)
});

export type AppConfig = {
  readonly databaseUrl: string;
  readonly logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly kufarApiUrl: string;
  readonly onlinerApiUrl: string;
  readonly realtSearchUrl: string;
  readonly osrmRouteUrl: string;
  readonly geoCacheTtlDays: number;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly telegramReplayAlertsOnDev: boolean;
  readonly telegramSendAllScoredOnDev: boolean;
  readonly scraperProxyUrl?: string | undefined;
  readonly scraperUserAgent: string;
};

export const loadConfig = (): AppConfig => {
  const parsed = envSchema.parse(process.env);

  return {
    databaseUrl: parsed.DATABASE_URL,
    logLevel: parsed.LOG_LEVEL,
    kufarApiUrl: parsed.KUFAR_API_URL,
    onlinerApiUrl: parsed.ONLINER_API_URL,
    realtSearchUrl: parsed.REALT_SEARCH_URL,
    osrmRouteUrl: parsed.OSRM_ROUTE_URL,
    geoCacheTtlDays: parsed.GEO_CACHE_TTL_DAYS,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramChatId: parsed.TELEGRAM_CHAT_ID,
    telegramReplayAlertsOnDev: parsed.TELEGRAM_REPLAY_ALERTS_ON_DEV,
    telegramSendAllScoredOnDev: parsed.TELEGRAM_SEND_ALL_SCORED_ON_DEV,
    scraperProxyUrl: parsed.SCRAPER_PROXY_URL === "" ? undefined : parsed.SCRAPER_PROXY_URL,
    scraperUserAgent: parsed.SCRAPER_USER_AGENT
  };
};
