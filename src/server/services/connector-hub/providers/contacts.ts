import {
  isNonEmptyText,
  makeProviderFailure,
  type ContactPage,
  type ContactPageRequest,
  type ExternalContact,
  type ExternalContactFieldEvidence,
  type ProviderFailure,
  type ProviderId,
} from "./types";

export const CONTACT_READ_DEFAULT_LIMIT = 50 as const;
export const CONTACT_READ_MAX_LIMIT = 100 as const;
export const CONTACT_CURSOR_MAX_LENGTH = 2_048 as const;

export interface NormalizedContactPageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ExternalContactInput {
  readonly externalId: unknown;
  readonly email: unknown;
  readonly fullName: unknown;
  readonly organization: unknown;
  readonly title: unknown;
  readonly sourceVersion: unknown;
  readonly fieldEvidence: ExternalContactFieldEvidence;
}

type NormalizedRequestResult =
  | { readonly ok: true; readonly request: NormalizedContactPageRequest }
  | { readonly ok: false; readonly failure: ProviderFailure };

type CursorResult =
  | { readonly ok: true; readonly token: string | null }
  | { readonly ok: false; readonly failure: ProviderFailure };

type ExternalContactResult =
  | { readonly ok: true; readonly contact: ExternalContact }
  | { readonly ok: false; readonly failure: ProviderFailure };

function safeOptionalText(value: unknown, maximumLength: number): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizedEmail(value: unknown): string | null | undefined {
  const normalized = safeOptionalText(value, 320);
  if (normalized === undefined || normalized === null) return normalized;
  const email = normalized.toLowerCase();
  return /^[^\s@]+@[^\s@]+$/u.test(email) ? email : undefined;
}

function normalizedIsoTimestamp(value: unknown): string | null {
  if (!isNonEmptyText(value, 64)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function observedAt(clock: () => number): string | null {
  try {
    const timestamp = clock();
    if (!Number.isFinite(timestamp)) return null;
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

export function normalizeContactPageRequest(request: ContactPageRequest | undefined): NormalizedRequestResult {
  const input = request ?? {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "cursor" && key !== "limit")) {
    return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
  }
  const cursor = input.cursor ?? null;
  if (
    cursor !== null
    && (typeof cursor !== "string"
      || cursor.length === 0
      || cursor.length > CONTACT_CURSOR_MAX_LENGTH
      || /[\u0000-\u001f\u007f]/u.test(cursor))
  ) {
    return { ok: false, failure: makeProviderFailure("CURSOR_INVALID") };
  }
  const limit = input.limit ?? CONTACT_READ_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTACT_READ_MAX_LIMIT) {
    return { ok: false, failure: makeProviderFailure("INVALID_INPUT") };
  }
  return { ok: true, request: { cursor, limit } };
}

function cursorPrefix(provider: ProviderId): string {
  return `sympose.v1.${provider}.`;
}

export function encodeProviderContactCursor(provider: ProviderId, token: string): string {
  return `${cursorPrefix(provider)}${encodeURIComponent(token)}`;
}

export function decodeProviderContactCursor(
  provider: ProviderId,
  cursor: string | null,
  validToken: (token: string) => boolean,
): CursorResult {
  if (cursor === null) return { ok: true, token: null };
  const prefix = cursorPrefix(provider);
  if (!cursor.startsWith(prefix)) {
    return { ok: false, failure: makeProviderFailure("CURSOR_INVALID") };
  }
  const encoded = cursor.slice(prefix.length);
  if (encoded.length === 0) {
    return { ok: false, failure: makeProviderFailure("CURSOR_INVALID") };
  }
  let token: string;
  try {
    token = decodeURIComponent(encoded);
  } catch {
    return { ok: false, failure: makeProviderFailure("CURSOR_INVALID") };
  }
  if (!validToken(token) || encodeProviderContactCursor(provider, token) !== cursor) {
    return { ok: false, failure: makeProviderFailure("CURSOR_INVALID") };
  }
  return { ok: true, token };
}

export function normalizeExternalContact(
  provider: ProviderId,
  input: ExternalContactInput,
  clock: () => number,
): ExternalContactResult {
  if (!isNonEmptyText(input.externalId, 256)) {
    return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
  }
  const externalId = input.externalId.trim();
  if (externalId.length === 0) {
    return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
  }
  const email = normalizedEmail(input.email);
  const fullName = safeOptionalText(input.fullName, 512);
  const organization = safeOptionalText(input.organization, 512);
  const title = safeOptionalText(input.title, 512);
  const sourceVersion = normalizedIsoTimestamp(input.sourceVersion);
  const observation = observedAt(clock);
  if (
    email === undefined
    || fullName === undefined
    || organization === undefined
    || title === undefined
    || sourceVersion === null
    || observation === null
  ) {
    return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
  }
  return {
    ok: true,
    contact: {
      provider,
      externalId,
      externalIdentity: `${provider}:${externalId}`,
      email,
      fullName,
      organization,
      title,
      sourceVersion,
      sourceEvidence: {
        observedAt: observation,
        fields: input.fieldEvidence,
      },
    },
  };
}

export function makeContactPage(
  contacts: readonly ExternalContact[],
  nextCursor: string | null,
  limit: number,
): { readonly ok: true; readonly page: ContactPage } | { readonly ok: false; readonly failure: ProviderFailure } {
  if (contacts.length > limit || (nextCursor !== null && contacts.length === 0)) {
    return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
  }
  const identities = new Set<string>();
  for (const contact of contacts) {
    if (identities.has(contact.externalIdentity)) {
      return { ok: false, failure: makeProviderFailure("DUPLICATE_EXTERNAL_IDENTITY") };
    }
    identities.add(contact.externalIdentity);
  }
  return {
    ok: true,
    page: {
      contacts,
      nextCursor,
      hasMore: nextCursor !== null,
      limit,
    },
  };
}
