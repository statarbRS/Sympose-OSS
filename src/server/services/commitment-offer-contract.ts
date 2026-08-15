import { fingerprintOf } from "../canonical";

export const COMMITMENT_OFFER_TERMS_SCHEMA = "commitment-offer-terms/v1" as const;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const TERMS_JSON_MAX_BYTES = 16 * 1024;

export interface CommitmentOfferTerms {
  readonly schema: typeof COMMITMENT_OFFER_TERMS_SCHEMA;
  readonly planVersionId: string;
  readonly planFingerprint: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly timezone: string;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly role: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export type CommitmentOfferTermsAuthority = Omit<CommitmentOfferTerms, "schema">;

export interface CommitmentOfferTermsEvidence {
  readonly termsJson: unknown;
  readonly termsFingerprint: unknown;
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, maximumCodePoints: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    Array.from(value).length <= maximumCodePoints &&
    Buffer.byteLength(value, "utf8") <= maximumCodePoints * 4 &&
    value.trim() === value &&
    !CONTROL_CHARACTER.test(value);
}

function supportedTimezone(value: unknown): value is string {
  if (!boundedText(value, 128)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions();
    return true;
  } catch {
    return false;
  }
}

function validAuthority(authority: CommitmentOfferTermsAuthority): boolean {
  return typeof authority.planVersionId === "string" && SAFE_IDENTIFIER.test(authority.planVersionId) &&
    typeof authority.planFingerprint === "string" && FINGERPRINT.test(authority.planFingerprint) &&
    typeof authority.eventId === "string" && SAFE_IDENTIFIER.test(authority.eventId) &&
    boundedText(authority.eventName, 240) &&
    supportedTimezone(authority.timezone) &&
    typeof authority.programUnitId === "string" && SAFE_IDENTIFIER.test(authority.programUnitId) &&
    boundedText(authority.programUnitName, 240) &&
    boundedText(authority.role, 80) &&
    canonicalInstant(authority.startsAt) &&
    canonicalInstant(authority.endsAt) &&
    authority.startsAt < authority.endsAt;
}

/**
 * The sole encoder for immutable commitment offer terms. Property order is part of the stored
 * v1 representation, while the fingerprint remains the canonical-json SHA-256 contract.
 */
export function commitmentOfferTerms(
  authority: CommitmentOfferTermsAuthority,
): CommitmentOfferTerms {
  if (!validAuthority(authority)) {
    throw new Error("COMMITMENT_OFFER_AUTHORITY_INVALID");
  }
  return Object.freeze({
    schema: COMMITMENT_OFFER_TERMS_SCHEMA,
    planVersionId: authority.planVersionId,
    planFingerprint: authority.planFingerprint,
    eventId: authority.eventId,
    eventName: authority.eventName,
    timezone: authority.timezone,
    programUnitId: authority.programUnitId,
    programUnitName: authority.programUnitName,
    role: authority.role,
    startsAt: authority.startsAt,
    endsAt: authority.endsAt,
  });
}

export function commitmentOfferTermsJson(terms: CommitmentOfferTerms): string {
  return JSON.stringify(terms);
}

/**
 * Parses only the exact v1 wire representation produced above. Missing, extra, reordered,
 * duplicate-key, non-canonical, malformed, or self-hashed partial documents are rejected.
 */
export function readExactCommitmentOfferTerms(
  evidence: CommitmentOfferTermsEvidence,
): CommitmentOfferTerms | null {
  if (
    typeof evidence.termsJson !== "string" ||
    Buffer.byteLength(evidence.termsJson, "utf8") > TERMS_JSON_MAX_BYTES ||
    typeof evidence.termsFingerprint !== "string" ||
    !FINGERPRINT.test(evidence.termsFingerprint)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(evidence.termsJson) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    if (parsed.schema !== COMMITMENT_OFFER_TERMS_SCHEMA) return null;
    const terms = commitmentOfferTerms({
      planVersionId: parsed.planVersionId as string,
      planFingerprint: parsed.planFingerprint as string,
      eventId: parsed.eventId as string,
      eventName: parsed.eventName as string,
      timezone: parsed.timezone as string,
      programUnitId: parsed.programUnitId as string,
      programUnitName: parsed.programUnitName as string,
      role: parsed.role as string,
      startsAt: parsed.startsAt as string,
      endsAt: parsed.endsAt as string,
    });
    const exactJson = commitmentOfferTermsJson(terms);
    return exactJson === evidence.termsJson &&
      fingerprintOf(terms) === evidence.termsFingerprint
      ? terms
      : null;
  } catch {
    return null;
  }
}

/** Bind exact stored evidence to every authority field supplied by current server state. */
export function commitmentOfferTermsMatchAuthority(
  evidence: CommitmentOfferTermsEvidence,
  authority: CommitmentOfferTermsAuthority,
): boolean {
  try {
    const expected = commitmentOfferTerms(authority);
    return evidence.termsJson === commitmentOfferTermsJson(expected) &&
      evidence.termsFingerprint === fingerprintOf(expected);
  } catch {
    return false;
  }
}
