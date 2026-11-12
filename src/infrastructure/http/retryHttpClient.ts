import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../logger.js";
import { redactSensitiveUrl, sanitizeHttpUrl } from "../../utils/url.js";

export type HttpMethod = "GET" | "POST";

export type JsonRequest = {
  readonly responseType?: "json" | "text" | "bytes";
  readonly minIntervalMs?: number;
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly redirect?: RequestRedirect;
  readonly allowRedirect?: (target: URL) => boolean;
  readonly signal?: AbortSignal;
};

export class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly retryable = false,
    readonly responseBody?: unknown,
    readonly retryAfterMs?: number
  ) {
    super(message);
  }
}

export class RetryHttpClient {
  private readonly hostQueues = new Map<string, Promise<void>>();
  private readonly hostLastStarted = new Map<string, number>();
  private readonly hostBlockedUntil = new Map<string, number>();
  private readonly shutdown = new AbortController();
  constructor(private readonly logger: Logger) {}
  close(): void { this.shutdown.abort(); }

  async json<T>(request: JsonRequest, schema: z.ZodType<T>): Promise<T> {
    const maxRetries = request.retries ?? 3;
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= maxRetries) {
      try {
        const payload = await this.executeJson(request);
        return schema.parse(payload);
      } catch (error: unknown) {
        lastError = error;
        const retryable = this.isRetryable(error);
        const safeUrl = this.safeUrl(request.url);
        this.logger.warn(
          {
            err: this.serializeError(error),
            url: safeUrl,
            method: request.method,
            attempt,
            maxRetries,
            retryable
          },
          "HTTP request failed"
        );

        if (!retryable || attempt >= maxRetries) {
          break;
        }

        await this.sleep(error instanceof HttpRequestError && error.retryAfterMs !== undefined ? error.retryAfterMs : this.backoffMs(attempt));
        attempt += 1;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("HTTP request failed with non-error value");
  }

  private async executeJson(request: JsonRequest): Promise<unknown> {
    const origin = new URL(request.url).origin;
    const previous = this.hostQueues.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.hostQueues.set(origin, previous.then(() => current));
    await previous;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const wait = Math.max((request.minIntervalMs ?? 0) - (Date.now() - (this.hostLastStarted.get(origin) ?? 0)), (this.hostBlockedUntil.get(origin) ?? 0) - Date.now());
      if (wait > 0) await this.sleep(wait);
      this.shutdown.signal.throwIfAborted();
      this.hostLastStarted.set(origin, Date.now());
      timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 15_000);
      const headers: Record<string, string> = {
        accept: "application/json",
        ...request.headers
      };

      const init: RequestInit = {
        method: request.method,
        headers: request.body === undefined ? headers : { "content-type": "application/json", ...headers },
        signal: AbortSignal.any([controller.signal, this.shutdown.signal, ...(request.signal ? [request.signal] : [])]),
        ...(request.allowRedirect ? { redirect: "manual" } : request.redirect ? { redirect: request.redirect } : {})
      };

      if (request.body !== undefined) {
        init.body = JSON.stringify(request.body);
      }

      const url = sanitizeHttpUrl(request.url);
      const response = await this.fetchResponse(url, init, request.allowRedirect);

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        if (response.status === 403 || response.status === 429) {
          const cooldownMs = Math.max(retryAfter ?? 0, response.status === 403 ? 300_000 : 60_000);
          this.hostBlockedUntil.set(origin, Date.now() + cooldownMs);
          this.logger.warn({ origin, statusCode: response.status, cooldownMs }, "HTTP origin paused after access restriction");
        }
        const responseBody = await this.readErrorBody(response);
        throw new HttpRequestError(
          `HTTP ${response.status} from ${this.safeUrl(url)}`,
          response.status,
          retryable,
          responseBody,
          retryAfter
        );
      }

      if (request.responseType === "bytes") {
        const limit = 10_000_000;
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty image response");
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          if (Number(response.headers.get("content-length")) > limit) throw new Error("Image exceeds 10 MB limit");
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return Buffer.concat(chunks, length);
            length += value.length;
            if (length > limit) throw new Error("Image exceeds 10 MB limit");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
      }
      return request.responseType === "text" ? await response.text() : await response.json();
    } catch (error: unknown) {
      if (request.signal?.aborted) throw new HttpRequestError("Request cancelled", undefined, false);
      if (this.shutdown.signal.aborted) throw new HttpRequestError("HTTP client stopped", undefined, false);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new HttpRequestError(`Request timed out: ${this.safeUrl(request.url)}`, undefined, true);
      }

      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      release();
    }
  }

  async text(request: JsonRequest): Promise<string> {
    return this.json({ ...request, responseType: "text" }, z.string());
  }
  async bytes(request: JsonRequest): Promise<Buffer> {
    return this.json({ ...request, responseType: "bytes" }, z.instanceof(Buffer));
  }

  private async fetchResponse(url: string, init: RequestInit, allowRedirect?: (target: URL) => boolean): Promise<Response> {
    let current = url;
    for (let followed = 0; ; followed++) {
      const response = await fetch(current, init);
      if (!allowRedirect || ![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (followed === 3 || !location || init.method !== "GET") throw new HttpRequestError("Invalid HTTP redirect");
      let target: URL;
      try { target = new URL(location, current); }
      catch { throw new HttpRequestError("Invalid HTTP redirect URL"); }
      if (!allowRedirect(target)) throw new HttpRequestError("HTTP redirect destination not allowed");
      current = target.href;
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof HttpRequestError) {
      return error.retryable;
    }

    return error instanceof TypeError;
  }

  private backoffMs(attempt: number): number {
    const baseMs = 750 * 2 ** attempt;
    const jitterMs = Math.floor(Math.random() * 250);
    return Math.min(baseMs + jitterMs, 10_000);
  }

  private async sleep(ms: number): Promise<void> {
    await delay(ms, undefined, { signal: this.shutdown.signal });
  }

  private serializeError(error: unknown): Readonly<Record<string, unknown>> {
    if (error instanceof Error) {
      const serialized: Record<string, unknown> = {
        name: error.name,
        message: redactSensitiveUrl(error.message),
        stack: error.stack === undefined ? undefined : redactSensitiveUrl(error.stack)
      };
      if (error.cause instanceof Error) serialized["cause"] = { name: error.cause.name, message: redactSensitiveUrl(error.cause.message) };

      if (error instanceof HttpRequestError) {
        serialized["statusCode"] = error.statusCode;
        serialized["retryable"] = error.retryable;
        serialized["responseBody"] = error.responseBody;
      }

      return serialized;
    }

    return { value: String(error) };
  }

  private async readErrorBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    const reader = response.body?.getReader();
    if (!reader) return { contentType, preview: "" };
    let preview = "";
    const decoder = new TextDecoder();
    try {
      while (preview.length < 2048) {
        const chunk = await reader.read();
        if (chunk.done) break;
        preview += decoder.decode(chunk.value, { stream: true }).slice(0, 2048 - preview.length);
      }
      return { contentType, preview: redactSensitiveUrl(preview), truncated: preview.length >= 2048 };
    } catch {
      return undefined;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private safeUrl(url: string): string {
    return redactSensitiveUrl(url);
  }
}

export const parseRetryAfter = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(2_147_483_647, Math.max(0, seconds * 1000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(2_147_483_647, Math.max(0, timestamp - Date.now())) : undefined;
};
