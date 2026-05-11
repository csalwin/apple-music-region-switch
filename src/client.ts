import { appendDebugLog } from "./storage.ts";
import type { ApiList, Tokens } from "./types.ts";

const BASE_URL = "https://api.music.apple.com";
const ORIGIN = "https://music.apple.com";
const TIMEOUT_MS = 30_000;
const INTER_REQUEST_MS = 100;
const MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const NON_RETRYABLE_PARSE = -1;

let tokens: Tokens | null = null;

export function setTokens(t: Tokens): void {
  tokens = t;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  // If true, parse and return JSON; if false, return null.
  expectBody?: boolean;
}

export interface RequestError extends Error {
  status?: number;
  responseBody?: string;
}

export async function request<T = unknown>(
  pathOrUrl: string,
  opts: RequestOptions = {},
): Promise<T> {
  if (!tokens) throw new Error("Tokens not set. Call setTokens() first.");

  const method = opts.method ?? "GET";
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.devToken}`,
    "Media-User-Token": tokens.userToken,
    Origin: ORIGIN,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let lastErr: RequestError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let status = 0;
    let bodyText = "";

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      status = response.status;
      bodyText = await response.text();
      await logRequest(method, url, status, Date.now() - start, bodyText);

      if (response.ok) {
        await sleep(INTER_REQUEST_MS);
        if (opts.expectBody === false || bodyText.length === 0) {
          return null as T;
        }
        try {
          return JSON.parse(bodyText) as T;
        } catch (parseErr) {
          // Same body would fail same way — don't retry.
          throw makeError(
            `Server returned 2xx with non-JSON body: ${(parseErr as Error).message}`,
            NON_RETRYABLE_PARSE,
            bodyText,
          );
        }
      }

      if (status === 401) {
        const err = makeError(
          "Token expired or invalid (HTTP 401). Re-paste fresh tokens and retry.",
          status,
          bodyText,
        );
        throw err;
      }

      if (status === 429 || status >= 500) {
        lastErr = makeError(`HTTP ${status}`, status, bodyText);
        if (attempt < MAX_RETRIES) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterMs = retryAfterHeader
            ? Math.max(0, Number(retryAfterHeader)) * 1000
            : null;
          const wait = Number.isFinite(retryAfterMs) && retryAfterMs !== null
            ? retryAfterMs
            : status === 429
              ? DEFAULT_RETRY_AFTER_MS
              : backoffMs(attempt);
          await sleep(wait);
          continue;
        }
        throw lastErr;
      }

      // Other 4xx — fail fast.
      throw makeError(
        `HTTP ${status}: ${bodyText.slice(0, 200)}`,
        status,
        bodyText,
      );
    } catch (e) {
      const err = e as RequestError;
      if (err.status === 401) throw err;
      if (err.status === NON_RETRYABLE_PARSE) throw err;
      if (err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
      // Network error, timeout, or retryable status with retries remaining.
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await logRequest(method, url, status, Date.now() - start, `<retry: ${err.message}>`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error("Exhausted retries without resolution");
}

export async function* paginate<T>(initialPath: string): AsyncGenerator<T, void, void> {
  let path: string | null = initialPath;
  while (path) {
    const result = (await request(path)) as ApiList<T>;
    for (const item of result.data) yield item;
    path = result.next ?? null;
  }
}

function backoffMs(attempt: number): number {
  return (1000 << attempt) + Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeError(message: string, status: number, body: string): RequestError {
  const e = new Error(message) as RequestError;
  e.status = status;
  e.responseBody = body;
  return e;
}

async function logRequest(
  method: string,
  url: string,
  status: number,
  latencyMs: number,
  body: string,
): Promise<void> {
  const line =
    JSON.stringify({
      t: new Date().toISOString(),
      method,
      url,
      status,
      latency_ms: latencyMs,
      headers: { Authorization: "***", "Media-User-Token": "***" },
      body: body.slice(0, 4096),
    }) + "\n";
  try {
    await appendDebugLog(line);
  } catch {
    // best-effort logging
  }
}
