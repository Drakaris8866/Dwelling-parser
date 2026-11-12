import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { RetryHttpClient, HttpRequestError, parseRetryAfter } from "../src/infrastructure/http/retryHttpClient.js";
import { isListingPhotoUrl } from "../src/infrastructure/vision/listingPhotos.js";

export const assertHttpCooldown = async (): Promise<void> => {
  const original = globalThis.fetch;
  const client = new RetryHttpClient(pino({ enabled: false }));
  let requests = 0;
  globalThis.fetch = async (): Promise<Response> => {
    requests++;
    return new Response("Rate limited", { status: 429, headers: { "Retry-After": "900" } });
  };
  try {
    await assert.rejects(client.text({ method: "GET", url: "https://fixture.invalid/first", retries: 0 }), (error: unknown) => error instanceof HttpRequestError && error.statusCode === 429);
    const pending = assert.rejects(client.text({ method: "GET", url: "https://fixture.invalid/second", retries: 0 }), /HTTP client stopped/);
    await delay(20);
    assert.equal(requests, 1, "A blocked host must not receive requests during its cooldown");
    client.close();
    await pending;
    assert.equal(parseRetryAfter("900"), 900_000, "Long Retry-After must not be shortened to five minutes");
  } finally {
    client.close();
    globalThis.fetch = original;
  }
};

export const assertPhotoRedirects = async (): Promise<void> => {
  const original = globalThis.fetch, client = new RetryHttpClient(pino({ enabled: false }));
  const origin = "https://rms.kufar.by/photo.jpg", shard = "https://rms7.kufar.by/photo.jpg";
  const calls: string[] = [];
  let destination = shard;
  globalThis.fetch = async (input, init): Promise<Response> => {
    assert.equal(init?.redirect, "manual");
    const url = String(input);
    calls.push(url);
    return url === origin ? new Response(null, { status: 302, headers: { location: destination } }) : new Response("photo");
  };
  try {
    const request = { method: "GET" as const, url: origin, retries: 0, allowRedirect: (url: URL) => isListingPhotoUrl("KUFAR", url) };
    assert.equal((await client.bytes(request)).toString(), "photo");
    for (const unsafe of ["http://rms7.kufar.by/", "https://rms7.kufar.by.example.org/", "https://127.0.0.1/"]) {
      destination = unsafe;
      await assert.rejects(client.bytes(request), /redirect destination not allowed/);
    }
    assert.deepEqual(calls, [origin, shard, origin, origin, origin]);
    assert.equal(isListingPhotoUrl("REALT", new URL("https://realt.by/thumb/sample.jpeg")), true);
    assert.equal(isListingPhotoUrl("REALT", new URL("https://realt.by/sale/flats/")), false);
  } finally { client.close(); globalThis.fetch = original; }
};
