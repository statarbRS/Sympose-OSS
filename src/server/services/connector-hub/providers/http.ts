import {
  makeProviderFailure,
  PROVIDER_RUNTIME_DEFAULTS,
  type ProviderFailure,
  type ProviderRuntimeOptions,
  resolveProviderRuntime,
} from "./types";

export interface ProviderHttpRequest {
  readonly url: string;
  /** Exact origin selected by the provider adapter, never by imported/provider data. */
  readonly allowedOrigin: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** True only when replaying the request cannot create a duplicate provider record. */
  readonly retryable: boolean;
  /** Marks a non-idempotent write so a 429/5xx does not invite a replay. */
  readonly ambiguousWrite?: boolean;
  readonly allowEmptyBody?: boolean;
}

export interface ProviderHttpSuccess {
  readonly ok: true;
  readonly status: number;
  readonly body: unknown;
  readonly emptyBody: boolean;
  readonly attempts: number;
}

export interface ProviderHttpFailure {
  readonly ok: false;
  readonly failure: ProviderFailure;
  readonly attempts: number;
}

export type ProviderHttpOutcome = ProviderHttpSuccess | ProviderHttpFailure;

const TIMEOUT_SENTINEL = Symbol("provider-request-timeout");

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function failureCodeForStatus(status: number): ProviderFailure["code"] {
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403) return "AUTHORIZATION_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500 && status <= 599) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_REJECTED";
}

function retryAfterMs(value: string | null, clock: () => number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isSafeInteger(seconds)) {
      return Math.min(seconds * 1_000, PROVIDER_RUNTIME_DEFAULTS.maxRetryAfterMs);
    }
    return PROVIDER_RUNTIME_DEFAULTS.maxRetryAfterMs;
  }
  const dateMs = Date.parse(trimmed);
  const nowMs = clock();
  if (!Number.isFinite(dateMs) || !Number.isFinite(nowMs)) return null;
  return Math.min(
    Math.max(0, dateMs - nowMs),
    PROVIDER_RUNTIME_DEFAULTS.maxRetryAfterMs,
  );
}

function exponentialBackoffMs(attempt: number): number {
  return Math.min(250 * (2 ** Math.max(0, attempt - 1)), PROVIDER_RUNTIME_DEFAULTS.maxRetryAfterMs);
}

async function readCappedText(
  response: Response,
  maximumBytes: number,
): Promise<{ readonly tooLarge: boolean; readonly malformed: boolean; readonly text: string }> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > maximumBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // The response is already being rejected; a failed cancellation is not actionable.
      }
      return { tooLarge: true, malformed: false, text: "" };
    }
  }

  if (!response.body) {
    return { tooLarge: false, malformed: false, text: "" };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      byteCount += chunk.byteLength;
      if (byteCount > maximumBytes) {
        await reader.cancel();
        return { tooLarge: true, malformed: false, text: "" };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { tooLarge: false, malformed: false, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { tooLarge: false, malformed: true, text: "" };
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  runtime: ReturnType<typeof resolveProviderRuntime>["runtime"],
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(TIMEOUT_SENTINEL);
    }, runtime.timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function jsonBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  return JSON.stringify(body);
}

export async function requestJson(
  request: ProviderHttpRequest,
  options: ProviderRuntimeOptions,
): Promise<ProviderHttpOutcome> {
  const runtime = resolveProviderRuntime(options).runtime;
  let requestUrl: URL;
  let allowedOrigin: URL;
  try {
    requestUrl = new URL(request.url);
    allowedOrigin = new URL(request.allowedOrigin);
  } catch {
    return { ok: false, failure: makeProviderFailure("CONFIGURATION_INVALID"), attempts: 0 };
  }
  if (
    requestUrl.protocol !== "https:" || requestUrl.username !== "" || requestUrl.password !== "" ||
    requestUrl.hash !== "" || (requestUrl.port !== "" && requestUrl.port !== "443") ||
    allowedOrigin.protocol !== "https:" || allowedOrigin.username !== "" || allowedOrigin.password !== "" ||
    allowedOrigin.pathname !== "/" || allowedOrigin.search !== "" || allowedOrigin.hash !== "" ||
    requestUrl.origin !== allowedOrigin.origin
  ) {
    return { ok: false, failure: makeProviderFailure("CONFIGURATION_INVALID"), attempts: 0 };
  }
  const totalAttempts = runtime.maxRetries + 1;
  let serializedBody: string | undefined;
  try {
    serializedBody = jsonBody(request.body);
  } catch {
    return {
      ok: false,
      failure: makeProviderFailure("INVALID_INPUT", {
        ambiguous: Boolean(request.ambiguousWrite),
      }),
      attempts: 0,
    };
  }

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const controller = new AbortController();
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      redirect: "error",
      signal: controller.signal,
    };
    if (serializedBody !== undefined) init.body = serializedBody;

    let response: Response;
    let read: { readonly tooLarge: boolean; readonly malformed: boolean; readonly text: string };
    try {
      const result = await withTimeout(
        (async () => {
          const fetched = await runtime.fetch(request.url, init);
          if (fetched.redirected) throw new Error("provider redirect denied");
          if (fetched.url.length > 0) {
            let responseUrl: URL;
            try {
              responseUrl = new URL(fetched.url);
            } catch {
              throw new Error("provider response origin invalid");
            }
            if (responseUrl.origin !== requestUrl.origin) throw new Error("provider response origin changed");
          }
          const body = await readCappedText(fetched, runtime.maxResponseBytes);
          return { response: fetched, body };
        })(),
        runtime,
        controller,
      );
      response = result.response;
      read = result.body;
    } catch (error) {
      if (error === TIMEOUT_SENTINEL) {
        return {
          ok: false,
          failure: makeProviderFailure("TIMEOUT", {
            retryable: false,
            ambiguous: Boolean(request.ambiguousWrite),
          }),
          attempts: attempt,
        };
      }
      return {
        ok: false,
        failure: makeProviderFailure("NETWORK_ERROR", {
          retryable: false,
          ambiguous: Boolean(request.ambiguousWrite),
        }),
        attempts: attempt,
      };
    }

    if (read.tooLarge) {
      return {
        ok: false,
        failure: makeProviderFailure("RESPONSE_TOO_LARGE", {
          status: response.status,
          retryable: false,
          ambiguous: Boolean(request.ambiguousWrite),
        }),
        attempts: attempt,
      };
    }

    if (read.malformed || (response.status >= 300 && response.status <= 399)) {
      return {
        ok: false,
        failure: makeProviderFailure("MALFORMED_RESPONSE", {
          status: response.status,
          ambiguous: Boolean(request.ambiguousWrite),
        }),
        attempts: attempt,
      };
    }

    if (!response.ok) {
      const retryAfter = retryAfterMs(response.headers.get("retry-after"), runtime.clock);
      const shouldRetry = request.retryable
        && isRetryableStatus(response.status)
        && attempt < totalAttempts;
      if (shouldRetry) {
        try {
          await runtime.sleeper(retryAfter ?? exponentialBackoffMs(attempt));
        } catch {
          return {
            ok: false,
            failure: makeProviderFailure("NETWORK_ERROR", {
              retryable: false,
              ambiguous: Boolean(request.ambiguousWrite),
            }),
            attempts: attempt,
          };
        }
        continue;
      }

      return {
        ok: false,
        failure: makeProviderFailure(failureCodeForStatus(response.status), {
          status: response.status,
          retryAfterMs: retryAfter,
          retryable: request.retryable && isRetryableStatus(response.status),
          ambiguous: Boolean(request.ambiguousWrite && isRetryableStatus(response.status)),
        }),
        attempts: attempt,
      };
    }

    const trimmed = read.text.trim();
    if (trimmed.length === 0) {
      if (request.allowEmptyBody) {
        return { ok: true, status: response.status, body: null, emptyBody: true, attempts: attempt };
      }
      return {
        ok: false,
        failure: makeProviderFailure("MALFORMED_RESPONSE", {
          status: response.status,
          ambiguous: Boolean(request.ambiguousWrite),
        }),
        attempts: attempt,
      };
    }

    try {
      return {
        ok: true,
        status: response.status,
        body: JSON.parse(read.text) as unknown,
        emptyBody: false,
        attempts: attempt,
      };
    } catch {
      return {
        ok: false,
        failure: makeProviderFailure("MALFORMED_RESPONSE", {
          status: response.status,
          ambiguous: Boolean(request.ambiguousWrite),
        }),
        attempts: attempt,
      };
    }
  }

  // The loop always returns; keeping a typed fallback protects future policy changes.
  return {
    ok: false,
    failure: makeProviderFailure("PROVIDER_UNAVAILABLE", { retryable: request.retryable }),
    attempts: totalAttempts,
  };
}
