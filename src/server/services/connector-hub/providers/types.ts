/**
 * Provider-neutral contracts for the live connector adapters.
 *
 * These types intentionally live beside the adapters rather than in the existing Connector Hub
 * UI contracts. The UI contract describes the local, unconfigured surface; this contract describes
 * the network boundary that a later orchestration layer may call.
 */

export type ProviderId = "airtable" | "hubspot" | "salesforce";

export type ProviderOperation = "validate-connection" | "list-contacts" | "upsert-people";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type Clock = () => number;
export type Sleeper = (delayMs: number) => Promise<void>;

export interface ProviderRuntimeOptions {
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly sleeper?: Sleeper;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Number of retries after the first request. */
  readonly maxRetries?: number;
}

export interface ProviderRuntime {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRetries: number;
}

export const PROVIDER_RUNTIME_DEFAULTS = Object.freeze({
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024,
  maxRetries: 2,
  maxRetryAfterMs: 60_000,
});

export const PROVIDER_RUNTIME_HARD_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxResponseBytes: 1024 * 1024,
  maxRetries: 5,
});

export interface CanonicalPerson {
  readonly personId: string;
  readonly fullName: string;
  readonly email: string;
  readonly organization?: string | null;
  readonly title?: string | null;
}

export interface NormalizedCanonicalPerson {
  readonly personId: string;
  readonly fullName: string;
  readonly email: string;
  readonly organization: string | null;
  readonly title: string | null;
}

export type ProviderFailureCode =
  | "CONFIGURATION_INVALID"
  | "INVALID_INPUT"
  | "CURSOR_INVALID"
  | "BATCH_LIMIT_EXCEEDED"
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "PROVIDER_REJECTED"
  | "DUPLICATE_EXTERNAL_IDENTITY"
  | "AMBIGUOUS_MATCH";

export interface ProviderFailure {
  readonly code: ProviderFailureCode;
  /** Always a fixed, redacted message; provider response bodies are never returned. */
  readonly message: string;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  /** False for a non-idempotent write whose outcome may be unknown. */
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly redacted: true;
}

export interface ProviderSuccess<T> {
  readonly ok: true;
  readonly success: true;
  readonly provider: ProviderId;
  readonly operation: ProviderOperation;
  readonly attempts: number;
  readonly value: T;
}

export interface ProviderFailureResult {
  readonly ok: false;
  readonly success: false;
  readonly provider: ProviderId;
  readonly operation: ProviderOperation;
  readonly attempts: number;
  readonly failure: ProviderFailure;
  /** Alias kept explicit for callers that model failures as errors. */
  readonly error: ProviderFailure;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderFailureResult;

export interface ConnectionValidation {
  readonly connected: true;
  readonly boundedRead: true;
  readonly recordsRead: number;
}

export interface ContactPageRequest {
  /** Opaque cursor returned by the same provider adapter and configuration. */
  readonly cursor?: string | null;
  /** Number of contacts to return; adapters enforce a provider-neutral hard cap. */
  readonly limit?: number;
}

export interface ExternalContactFieldEvidence {
  readonly externalId: string;
  readonly email: string;
  readonly fullName: readonly string[];
  readonly organization: string;
  readonly title: string;
  readonly sourceVersion: string;
}

export interface ExternalContactSourceEvidence {
  readonly observedAt: string;
  readonly fields: ExternalContactFieldEvidence;
}

/**
 * A provider record normalized at the network boundary. It is deliberately not a canonical
 * Person: incomplete provider contacts stay nullable until a later import policy evaluates them.
 */
export interface ExternalContact {
  readonly provider: ProviderId;
  readonly externalId: string;
  readonly externalIdentity: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly sourceVersion: string;
  readonly sourceEvidence: ExternalContactSourceEvidence;
}

export interface ContactPage {
  readonly contacts: readonly ExternalContact[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
}

export type ProviderRecordOperation = "CREATED" | "UPDATED";

export interface ProviderRecordResult {
  readonly personId: string;
  readonly providerRecordId: string;
  readonly operation: ProviderRecordOperation;
}

export interface BatchUpsertSummary {
  readonly requested: number;
  readonly created: number;
  readonly updated: number;
  readonly records: readonly ProviderRecordResult[];
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  validateConnection(): Promise<ProviderResult<ConnectionValidation>>;
  listContacts(request?: ContactPageRequest): Promise<ProviderResult<ContactPage>>;
  /** Explicit read alias for orchestration code that names inbound operations as reads. */
  readContacts(request?: ContactPageRequest): Promise<ProviderResult<ContactPage>>;
  upsertPeople(people: readonly CanonicalPerson[]): Promise<ProviderResult<BatchUpsertSummary>>;
  upsertContacts(people: readonly CanonicalPerson[]): Promise<ProviderResult<BatchUpsertSummary>>;
}

export interface RuntimeResolution {
  readonly runtime: ProviderRuntime;
  readonly configurationError: boolean;
}

function deniedFetch(_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
  return Promise.reject(new Error("provider transport is not injected"));
}

function defaultSleeper(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function validBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

/**
 * Resolve injectable runtime dependencies while rejecting unsafe policy widening. Provider
 * factories keep the returned boolean and turn it into a typed CONFIGURATION_INVALID result.
 */
export function resolveProviderRuntime(
  options: ProviderRuntimeOptions | null | undefined,
): RuntimeResolution {
  const source = options ?? {};
  let configurationError = typeof source !== "object";
  const fetchImpl = (source as ProviderRuntimeOptions).fetch ?? deniedFetch;
  const clock = (source as ProviderRuntimeOptions).clock ?? Date.now;
  const sleeper = (source as ProviderRuntimeOptions).sleeper ?? defaultSleeper;
  const timeoutMs = (source as ProviderRuntimeOptions).timeoutMs ?? PROVIDER_RUNTIME_DEFAULTS.timeoutMs;
  const maxResponseBytes =
    (source as ProviderRuntimeOptions).maxResponseBytes ?? PROVIDER_RUNTIME_DEFAULTS.maxResponseBytes;
  const maxRetries = (source as ProviderRuntimeOptions).maxRetries ?? PROVIDER_RUNTIME_DEFAULTS.maxRetries;

  if (
    typeof (source as ProviderRuntimeOptions).fetch !== "function" ||
    typeof fetchImpl !== "function" || typeof clock !== "function" || typeof sleeper !== "function"
  ) {
    configurationError = true;
  }
  if (!validBoundedInteger(timeoutMs, 1, PROVIDER_RUNTIME_HARD_LIMITS.timeoutMs)) {
    configurationError = true;
  }
  if (!validBoundedInteger(maxResponseBytes, 1, PROVIDER_RUNTIME_HARD_LIMITS.maxResponseBytes)) {
    configurationError = true;
  }
  if (!validBoundedInteger(maxRetries, 0, PROVIDER_RUNTIME_HARD_LIMITS.maxRetries)) {
    configurationError = true;
  }

  return {
    configurationError,
    runtime: {
      fetch: fetchImpl as FetchLike,
      clock: clock as Clock,
      sleeper: sleeper as Sleeper,
      timeoutMs: validBoundedInteger(timeoutMs, 1, PROVIDER_RUNTIME_HARD_LIMITS.timeoutMs)
        ? timeoutMs
        : PROVIDER_RUNTIME_DEFAULTS.timeoutMs,
      maxResponseBytes: validBoundedInteger(maxResponseBytes, 1, PROVIDER_RUNTIME_HARD_LIMITS.maxResponseBytes)
        ? maxResponseBytes
        : PROVIDER_RUNTIME_DEFAULTS.maxResponseBytes,
      maxRetries: validBoundedInteger(maxRetries, 0, PROVIDER_RUNTIME_HARD_LIMITS.maxRetries)
        ? maxRetries
        : PROVIDER_RUNTIME_DEFAULTS.maxRetries,
    },
  };
}

const FAILURE_MESSAGES: Readonly<Record<ProviderFailureCode, string>> = Object.freeze({
  CONFIGURATION_INVALID: "Provider configuration is invalid.",
  INVALID_INPUT: "The connector batch contains invalid canonical Person data.",
  CURSOR_INVALID: "The provider contact cursor is invalid.",
  BATCH_LIMIT_EXCEEDED: "The connector batch exceeds the provider adapter limit.",
  AUTHENTICATION_FAILED: "Provider authentication failed.",
  AUTHORIZATION_FAILED: "Provider authorization was denied.",
  NOT_FOUND: "The provider resource was not found.",
  RATE_LIMITED: "The provider rate-limited the request.",
  PROVIDER_UNAVAILABLE: "The provider is temporarily unavailable.",
  NETWORK_ERROR: "The provider request could not be completed.",
  TIMEOUT: "The provider request timed out.",
  MALFORMED_RESPONSE: "The provider returned a malformed response.",
  RESPONSE_TOO_LARGE: "The provider response exceeded the safety limit.",
  PROVIDER_REJECTED: "The provider rejected the request.",
  DUPLICATE_EXTERNAL_IDENTITY: "The provider returned duplicate external contact identities.",
  AMBIGUOUS_MATCH: "The provider returned an ambiguous contact match.",
});

export function makeProviderFailure(
  code: ProviderFailureCode,
  options: Partial<Pick<ProviderFailure, "status" | "retryAfterMs" | "retryable" | "ambiguous">> = {},
): ProviderFailure {
  return {
    code,
    message: FAILURE_MESSAGES[code],
    status: options.status ?? null,
    retryAfterMs: options.retryAfterMs ?? null,
    retryable: options.retryable ?? false,
    ambiguous: options.ambiguous ?? false,
    redacted: true,
  };
}

export function providerSuccess<T>(
  provider: ProviderId,
  operation: ProviderOperation,
  value: T,
  attempts: number,
): ProviderSuccess<T> {
  return { ok: true, success: true, provider, operation, attempts, value };
}

export function providerFailure(
  provider: ProviderId,
  operation: ProviderOperation,
  failure: ProviderFailure,
  attempts = 0,
): ProviderFailureResult {
  return {
    ok: false,
    success: false,
    provider,
    operation,
    attempts,
    failure,
    error: failure,
  };
}

function boundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function normalizeCanonicalPeople(
  people: readonly CanonicalPerson[],
  maximumBatchSize: number,
): { readonly ok: true; readonly people: readonly NormalizedCanonicalPerson[] } | {
  readonly ok: false;
  readonly failure: ProviderFailure;
} {
  if (!Array.isArray(people)) {
    return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
  }
  if (people.length > maximumBatchSize) {
    return { ok: false, failure: makeProviderFailure("BATCH_LIMIT_EXCEEDED") };
  }

  const normalized: NormalizedCanonicalPerson[] = [];
  const personIds = new Set<string>();
  const emails = new Set<string>();
  for (const person of people) {
    if (person === null || typeof person !== "object") {
      return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
    }
    if (!boundedText(person.personId, 256) || !boundedText(person.fullName, 512)) {
      return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
    }
    const personId = person.personId.trim();
    const fullName = person.fullName.trim();
    if (personId.length === 0 || fullName.length === 0) {
      return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
    }
    const email = typeof person.email === "string" ? person.email.trim().toLowerCase() : "";
    if (!boundedText(email, 320) || !/^[^\s@]+@[^\s@]+$/u.test(email)) {
      return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
    }
    const organization = person.organization ?? null;
    const title = person.title ?? null;
    if (organization !== null && !boundedText(organization, 512)) {
      return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
    }
    if (title !== null && !boundedText(title, 512)) {
      return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
    }
    if (personIds.has(personId) || emails.has(email)) {
      return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
    }
    personIds.add(personId);
    emails.add(email);
    normalized.push({
      personId,
      fullName,
      email,
      organization,
      title,
    });
  }
  return { ok: true, people: normalized };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNonEmptyText(value: unknown, maximumLength = 512): value is string {
  return boundedText(value, maximumLength);
}
