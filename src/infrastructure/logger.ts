import pino from "pino";
import type { AppConfig } from "../config/env.js";

export type Logger = pino.Logger;

export const createLogger = (config: Pick<AppConfig, "logLevel">): Logger =>
  pino({
    level: config.logLevel,
    base: {
      service: "dwelling-parser"
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["apiKey", "token", "authorization", "headers.authorization"],
      censor: "[redacted]"
    }
  });
