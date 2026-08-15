import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

/**
 * This module is deliberately a value-only seam. It does not load state, write state, call a
 * provider, invoke a model, infer consent, or return an operation that can mutate anything.
 * Production assemblers are expected to resolve the evidence and then call `preflight`.
 */

export const COMMAND_ENVELOPE_SCHEMA = "authority-purpose-command/v1" as const;
export const ACTOR_EVIDENCE_SCHEMA = "authority-actor-evidence/v1" as const;
export const PURPOSE_EVIDENCE_SCHEMA = "authority-purpose-evidence/v1" as const;
export const RETENTION_EVIDENCE_SCHEMA = "authority-retention-evidence/v1" as const;
export const AUTHORITY_EVIDENCE_SCHEMA = "authority-version-evidence/v1" as const;
export const COMMAND_IDENTITY_SCHEMA = "authority-command-identity/v1" as const;
export const PREFLIGHT_RESULT_SCHEMA = "authority-purpose-preflight/v1" as const;
export const BLOCKER_RECEIPT_SCHEMA = "authority-purpose-blocker/v1" as const;
export const FINGERPRINT_ALGORITHM = "sha256-canonical-json-v1" as const;

export const MAX_STRING_BYTES = 512;
export const MAX_IDENTIFIER_BYTES = 128;
export const MAX_REASON_BYTES = 256;
export const MAX_ARRAY_ITEMS = 128;
export const MAX_BYTES = 4_096;
export const MAX_NODES = 2_048;
export const MAX_CANONICAL_BYTES = 65_536;
export const MAX_DEPTH = 64;

export type Fingerprint = string;
export type Timestamp = string;
export type PreflightState = "READY" | "BLOCKED" | "UNAVAILABLE";

export interface SubjectReference {
  readonly kind: string;
  readonly id: string;
}

export interface EvidenceReference {
  readonly id: string;
  readonly version: number;
  readonly fingerprint: Fingerprint;
}

export interface AuthorityVersionFingerprint {
  readonly family: string;
  readonly version: number;
  readonly fingerprint: Fingerprint;
}

export interface AuthorityPurposeCommandEnvelope {
  readonly schema: typeof COMMAND_ENVELOPE_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly subject: SubjectReference;
  readonly actionFamily: string;
  readonly factFamilies: readonly string[];
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly actorEvidenceRef: EvidenceReference;
  readonly purposeAuthorizationRef: EvidenceReference;
  readonly retentionAuthorizationRef: EvidenceReference;
  readonly expectedAuthorityVector: readonly AuthorityVersionFingerprint[];
  readonly issuedAt: Timestamp;
  readonly payloadFingerprint: Fingerprint;
}

export type CommandEnvelopeInput = Omit<AuthorityPurposeCommandEnvelope, "schema">;

export interface ActorEvidence {
  readonly schema: typeof ACTOR_EVIDENCE_SCHEMA;
  readonly evidenceId: string;
  readonly version: number;
  readonly fingerprint: Fingerprint;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly subject: SubjectReference;
  readonly actorId: string;
}

export type ActorEvidenceInput = Omit<ActorEvidence, "schema">;

export interface PurposeAuthorizationEvidence {
  readonly schema: typeof PURPOSE_EVIDENCE_SCHEMA;
  readonly purposeId: string;
  readonly version: number;
  readonly fingerprint: Fingerprint;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly subject: SubjectReference;
  readonly allowedActionFamilies: readonly string[];
  readonly allowedFactFamilies: readonly string[];
  readonly validFrom: Timestamp;
  readonly expiresAt: Timestamp | null;
  readonly revoked: boolean;
}

export type PurposeAuthorizationEvidenceInput = Omit<PurposeAuthorizationEvidence, "schema">;

export interface RetentionEvidence {
  readonly schema: typeof RETENTION_EVIDENCE_SCHEMA;
  readonly policyId: string;
  readonly version: number;
  readonly fingerprint: Fingerprint;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly subject: SubjectReference;
  readonly allowedFactFamilies: readonly string[];
  readonly retainUntil: Timestamp;
  readonly deleted: boolean;
  readonly withdrawn: boolean;
}

export type RetentionEvidenceInput = Omit<RetentionEvidence, "schema">;

export interface AuthorityEvidence {
  readonly schema: typeof AUTHORITY_EVIDENCE_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly vector: readonly AuthorityVersionFingerprint[];
}

export type AuthorityEvidenceInput = Omit<AuthorityEvidence, "schema">;

export type CommandIdentityState = "UNSEEN" | "MATCHED" | "MISMATCHED";

export interface CommandIdentityEvidence {
  readonly schema: typeof COMMAND_IDENTITY_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly state: CommandIdentityState;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly subject: SubjectReference;
  readonly actionFamily: string;
  readonly actorEvidenceRef: EvidenceReference;
  readonly purposeAuthorizationRef: EvidenceReference;
  readonly retentionAuthorizationRef: EvidenceReference;
  readonly expectedAuthorityVector: readonly AuthorityVersionFingerprint[];
  readonly payloadFingerprint: Fingerprint;
  readonly commandFingerprint: Fingerprint;
}

export type CommandIdentityEvidenceInput = Omit<CommandIdentityEvidence, "schema">;

export interface EvidenceUnavailable {
  readonly available: false;
  readonly reason: string;
}

export type EvidenceOrUnavailable<T> = T | EvidenceUnavailable;

export interface PreflightInput {
  readonly command: unknown;
  readonly now: Timestamp;
  readonly actorEvidence?: EvidenceOrUnavailable<ActorEvidence>;
  readonly purposeEvidence?: EvidenceOrUnavailable<PurposeAuthorizationEvidence>;
  readonly retentionEvidence?: EvidenceOrUnavailable<RetentionEvidence>;
  readonly authorityEvidence?: EvidenceOrUnavailable<AuthorityEvidence>;
  readonly idempotencyEvidence?: EvidenceOrUnavailable<CommandIdentityEvidence>;
}

export type BlockerCode =
  | "INPUT_REJECTED"
  | "COMMAND_ISSUED_IN_FUTURE"
  | "ACTOR_EVIDENCE_MISSING"
  | "ACTOR_EVIDENCE_UNAVAILABLE"
  | "ACTOR_REFERENCE_MISMATCH"
  | "ACTOR_VERSION_STALE"
  | "ACTOR_FINGERPRINT_STALE"
  | "ACTOR_SCOPE_MISMATCH"
  | "PURPOSE_EVIDENCE_MISSING"
  | "PURPOSE_EVIDENCE_UNAVAILABLE"
  | "PURPOSE_REFERENCE_MISMATCH"
  | "PURPOSE_VERSION_STALE"
  | "PURPOSE_FINGERPRINT_STALE"
  | "PURPOSE_SCOPE_MISMATCH"
  | "PURPOSE_NOT_YET_VALID"
  | "PURPOSE_EXPIRED"
  | "PURPOSE_REVOKED"
  | "ACTION_FAMILY_DISALLOWED"
  | "FACT_FAMILY_DISALLOWED"
  | "RETENTION_EVIDENCE_MISSING"
  | "RETENTION_EVIDENCE_UNAVAILABLE"
  | "RETENTION_REFERENCE_MISMATCH"
  | "RETENTION_VERSION_STALE"
  | "RETENTION_FINGERPRINT_STALE"
  | "RETENTION_SCOPE_MISMATCH"
  | "RETENTION_EXPIRED"
  | "RETENTION_DELETED"
  | "RETENTION_WITHDRAWN"
  | "RETENTION_FACT_FAMILY_DISALLOWED"
  | "AUTHORITY_EVIDENCE_MISSING"
  | "AUTHORITY_EVIDENCE_UNAVAILABLE"
  | "AUTHORITY_SCOPE_MISMATCH"
  | "AUTHORITY_FAMILY_MISSING"
  | "AUTHORITY_VERSION_STALE"
  | "AUTHORITY_FINGERPRINT_STALE"
  | "IDEMPOTENCY_EVIDENCE_MISSING"
  | "IDEMPOTENCY_EVIDENCE_UNAVAILABLE"
  | "IDEMPOTENCY_SCOPE_MISMATCH"
  | "IDEMPOTENCY_IDENTITY_MISMATCH"
  | "COMMAND_IDENTITY_MISMATCH";

export interface BlockerReceipt {
  readonly schema: typeof BLOCKER_RECEIPT_SCHEMA;
  readonly code: BlockerCode;
  readonly path: string;
  readonly expected: string | null;
  readonly observed: string | null;
  readonly reason: string | null;
  readonly checkedAt: Timestamp | null;
  readonly fingerprint: Fingerprint;
}

export interface PreflightResult {
  readonly schema: typeof PREFLIGHT_RESULT_SCHEMA;
  readonly state: PreflightState;
  readonly checkedAt: Timestamp | null;
  readonly commandFingerprint: Fingerprint | null;
  readonly receipts: readonly BlockerReceipt[];
  readonly receiptFingerprint: Fingerprint;
}

export type KernelInputErrorCode =
  | "INPUT_NOT_OBJECT"
  | "ACCESSOR_INPUT"
  | "PROXY_INPUT"
  | "CYCLE_INPUT"
  | "BOUND_EXCEEDED"
  | "UNKNOWN_FIELD"
  | "MISSING_FIELD"
  | "INVALID_VALUE"
  | "SCHEMA_MISMATCH"
  | "DUPLICATE_NORMALIZED_IDENTITY";

const ERROR_MESSAGES: Record<KernelInputErrorCode, string> = {
  INPUT_NOT_OBJECT: "The authority-purpose input is not an object.",
  ACCESSOR_INPUT: "The authority-purpose input contains an accessor.",
  PROXY_INPUT: "The authority-purpose input cannot be snapshotted.",
  CYCLE_INPUT: "The authority-purpose input contains a cycle.",
  BOUND_EXCEEDED: "The authority-purpose input exceeds a deterministic bound.",
  UNKNOWN_FIELD: "The authority-purpose input contains an unknown field.",
  MISSING_FIELD: "The authority-purpose input is missing a required field.",
  INVALID_VALUE: "The authority-purpose input contains an invalid value.",
  SCHEMA_MISMATCH: "The authority-purpose input has an unsupported schema.",
  DUPLICATE_NORMALIZED_IDENTITY: "The authority-purpose input contains duplicate normalized identity.",
};

export class AuthorityPurposeKernelInputError extends Error {
  readonly code: KernelInputErrorCode;

  constructor(code: KernelInputErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AuthorityPurposeKernelInputError";
    this.code = code;
  }
}

function fail(code: KernelInputErrorCode): never {
  throw new AuthorityPurposeKernelInputError(code);
}

function safe<T>(operation: () => T, fallback: KernelInputErrorCode = "PROXY_INPUT"): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AuthorityPurposeKernelInputError) throw error;
    fail(fallback);
  }
}

type ByteSnapshot = Readonly<{ $bytes: string }>;
type SnapshotValue = null | boolean | number | string | ByteSnapshot | SnapshotValue[] | { [key: string]: SnapshotValue };

class SnapshotBudget {
  nodes = 0;
  bytes = 0;

  node(depth: number): void {
    this.nodes += 1;
    if (this.nodes > MAX_NODES || depth > MAX_DEPTH) fail("BOUND_EXCEEDED");
  }

  string(value: string): void {
    this.bytes += Buffer.byteLength(value, "utf8");
    if (this.bytes > MAX_CANONICAL_BYTES) fail("BOUND_EXCEEDED");
  }
}

function isDangerousKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype" || key === "$bytes";
}

function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+~-]*$/u;
const FAMILY = /^[A-Z0-9][A-Z0-9_:-]*$/u;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validPlainString(value: string): boolean {
  return !CONTROL_CHARACTERS.test(value) && !hasUnpairedSurrogate(value);
}

function snapshotString(value: string, budget: SnapshotBudget): string {
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) fail("BOUND_EXCEEDED");
  if (!validPlainString(value)) fail("INVALID_VALUE");
  budget.string(value);
  return value;
}

function snapshotBytes(value: unknown, budget: SnapshotBudget, ancestors: WeakSet<object>): ByteSnapshot | null {
  const isView = safe(() => ArrayBuffer.isView(value));
  if (!isView) return null;
  const isByteArray = safe(() => value instanceof Uint8Array);
  if (!isByteArray || safe(() => Object.getPrototypeOf(value)) !== Uint8Array.prototype) fail("PROXY_INPUT");
  const object = value as Uint8Array;
  if (ancestors.has(object)) fail("CYCLE_INPUT");
  const byteLength = safe(() => object.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_BYTES) fail("BOUND_EXCEEDED");
  const keys = ownKeys(object);
  const expected = new Set(Array.from({ length: byteLength }, (_, index) => String(index)));
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) fail("UNKNOWN_FIELD");
  const backingBuffer = safe(() => object.buffer);
  if (typeof SharedArrayBuffer !== "undefined" && backingBuffer instanceof SharedArrayBuffer) fail("INVALID_VALUE");
  ancestors.add(object);
  try {
    const copy = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) {
      const item = dataDescriptor(object, String(index), true).value;
      if (!Number.isInteger(item) || item < 0 || item > 255) fail("INVALID_VALUE");
      copy[index] = item;
    }
    const encoded = Buffer.from(copy).toString("base64");
    budget.string("$bytes");
    budget.string(encoded);
    return { $bytes: encoded };
  } finally {
    ancestors.delete(object);
  }
}

function ownKeys(value: object): string[] {
  if (utilTypes.isProxy(value)) fail("PROXY_INPUT");
  const keys = safe(() => Reflect.ownKeys(value));
  const strings: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string" || seen.has(key)) fail("PROXY_INPUT");
    if (isDangerousKey(key)) fail("UNKNOWN_FIELD");
    seen.add(key);
    strings.push(key);
  }
  return strings;
}

function dataDescriptor(value: object, key: string, enumerable: boolean): PropertyDescriptor {
  if (utilTypes.isProxy(value)) fail("PROXY_INPUT");
  const descriptor = safe(() => Object.getOwnPropertyDescriptor(value, key));
  if (!descriptor || !("value" in descriptor)) fail("ACCESSOR_INPUT");
  if (descriptor.enumerable !== enumerable) fail("INVALID_VALUE");
  return descriptor;
}

function snapshotArray(
  value: unknown[],
  budget: SnapshotBudget,
  ancestors: WeakSet<object>,
  depth: number,
): SnapshotValue[] {
  if (safe(() => Object.getPrototypeOf(value)) !== Array.prototype) fail("PROXY_INPUT");
  if (ancestors.has(value)) fail("CYCLE_INPUT");
  const keys = ownKeys(value);
  const lengthDescriptor = dataDescriptor(value, "length", false);
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_ITEMS) fail("BOUND_EXCEEDED");
  const expected = new Set<string>(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) fail("UNKNOWN_FIELD");
  ancestors.add(value);
  try {
    const output: SnapshotValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = dataDescriptor(value, String(index), true);
      output.push(snapshotValue(descriptor.value, budget, ancestors, depth + 1));
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotRecord(
  value: object,
  budget: SnapshotBudget,
  ancestors: WeakSet<object>,
  depth: number,
): { [key: string]: SnapshotValue } {
  const prototype = safe(() => Object.getPrototypeOf(value));
  if (prototype !== Object.prototype && prototype !== null) fail("PROXY_INPUT");
  if (ancestors.has(value)) fail("CYCLE_INPUT");
  const output = Object.create(null) as { [key: string]: SnapshotValue };
  const keys = ownKeys(value);
  ancestors.add(value);
  try {
    for (const key of keys) {
      if (Buffer.byteLength(key, "utf8") > MAX_STRING_BYTES) fail("BOUND_EXCEEDED");
      if (!validPlainString(key)) fail("INVALID_VALUE");
      budget.string(key);
      const descriptor = dataDescriptor(value, key, true);
      output[key] = snapshotValue(descriptor.value, budget, ancestors, depth + 1);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotValue(
  value: unknown,
  budget = new SnapshotBudget(),
  ancestors = new WeakSet<object>(),
  depth = 0,
): SnapshotValue {
  budget.node(depth);
  if (value === null) return null;
  if (typeof value === "string") return snapshotString(value, budget);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail("INVALID_VALUE");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail("INVALID_VALUE");
  if (utilTypes.isProxy(value)) fail("PROXY_INPUT");
  const bytes = snapshotBytes(value, budget, ancestors);
  if (bytes !== null) {
    return bytes;
  }
  if (safe(() => Array.isArray(value))) return snapshotArray(value as unknown[], budget, ancestors, depth);
  return snapshotRecord(value, budget, ancestors, depth);
}

function isRecord(value: SnapshotValue): value is { [key: string]: SnapshotValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !isByteSnapshot(value);
}

function isByteSnapshot(value: SnapshotValue): value is ByteSnapshot {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, "$bytes")
  );
}

function canonicalJsonSnapshot(value: SnapshotValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (isByteSnapshot(value)) return `{"$bytes":${JSON.stringify(value.$bytes)}}`;
  if (Array.isArray(value)) return `[${value.map(canonicalJsonSnapshot).join(",")}]`;
  const keys = Object.keys(value).sort(compareCodeUnits);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonSnapshot(value[key])}`).join(",")}}`;
}

function canonicalFingerprintOfSnapshot(value: SnapshotValue): Fingerprint {
  const canonical = canonicalJsonSnapshot(value);
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES) fail("BOUND_EXCEEDED");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Canonical JSON for bounded JSON-like values, with detached descriptor snapshots. */
export function canonicalJson(value: unknown): string {
  const snapshot = snapshotValue(value);
  const canonical = canonicalJsonSnapshot(snapshot);
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES) fail("BOUND_EXCEEDED");
  return canonical;
}

/** SHA-256 over `canonicalJson`; this function never retains the caller's value. */
export function fingerprintOf(value: unknown): Fingerprint {
  return canonicalFingerprintOfSnapshot(snapshotValue(value));
}

export function normalizeIdentity(value: unknown): string {
  const text = rawText(value, MAX_STRING_BYTES);
  const normalized = text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > MAX_STRING_BYTES) fail("INVALID_VALUE");
  return normalized;
}

function rawText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_VALUE");
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail("BOUND_EXCEEDED");
  if (!validPlainString(value)) fail("INVALID_VALUE");
  return value;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) fail("INVALID_VALUE");
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail("BOUND_EXCEEDED");
  if (!validPlainString(value)) fail("INVALID_VALUE");
  return value;
}

function identifier(value: unknown): string {
  const text = boundedText(value, MAX_IDENTIFIER_BYTES);
  if (!IDENTIFIER.test(text)) fail("INVALID_VALUE");
  return text;
}

function family(value: unknown): string {
  const text = rawText(value, MAX_IDENTIFIER_BYTES);
  const normalized = text.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > MAX_IDENTIFIER_BYTES) fail("INVALID_VALUE");
  if (!FAMILY.test(normalized)) fail("INVALID_VALUE");
  return normalized;
}

function reason(value: unknown): string {
  return boundedText(value, MAX_REASON_BYTES);
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 || value > 1_000_000_000) fail("INVALID_VALUE");
  return value;
}

const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function timestamp(value: unknown): Timestamp {
  const text = boundedText(value, 32);
  if (!EXACT_TIMESTAMP.test(text)) fail("INVALID_VALUE");
  try {
    if (new Date(text).toISOString() !== text) fail("INVALID_VALUE");
  } catch {
    fail("INVALID_VALUE");
  }
  return text;
}

function nullableTimestamp(value: unknown): Timestamp | null {
  if (value === null) return null;
  return timestamp(value);
}

function fingerprint(value: unknown): Fingerprint {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("INVALID_VALUE");
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") fail("INVALID_VALUE");
  return value;
}

function exactKeys(record: { [key: string]: SnapshotValue }, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.has(key))) fail("UNKNOWN_FIELD");
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) fail("MISSING_FIELD");
}

function recordInput(value: unknown, required: readonly string[], optional: readonly string[] = []): { [key: string]: SnapshotValue } {
  if (value === null || typeof value !== "object") fail("INPUT_NOT_OBJECT");
  if (utilTypes.isProxy(value)) fail("PROXY_INPUT");
  if (Array.isArray(value)) fail("INPUT_NOT_OBJECT");
  const allowed = new Set([...required, ...optional]);
  const shallowKeys = ownKeys(value);
  if (shallowKeys.some((key) => !allowed.has(key))) fail("UNKNOWN_FIELD");
  if (required.some((key) => !shallowKeys.includes(key))) fail("MISSING_FIELD");
  const snapshot = snapshotValue(value);
  if (!isRecord(snapshot)) fail("INPUT_NOT_OBJECT");
  exactKeys(snapshot, required, optional);
  return snapshot;
}

function schemaValue(record: { [key: string]: SnapshotValue }, expected: string): void {
  if (record.schema !== undefined && record.schema !== expected) fail("SCHEMA_MISMATCH");
}

function normalizedUnique(values: readonly string[]): void {
  const identities = new Set<string>();
  for (const value of values) {
    const identity = normalizeIdentity(value);
    if (identities.has(identity)) fail("DUPLICATE_NORMALIZED_IDENTITY");
    identities.add(identity);
  }
}

function familyList(value: unknown): readonly string[] {
  const snapshot = snapshotValue(value);
  if (!Array.isArray(snapshot)) fail("INVALID_VALUE");
  if (snapshot.length > MAX_ARRAY_ITEMS) fail("BOUND_EXCEEDED");
  const normalized = snapshot.map((item) => family(item));
  normalizedUnique(normalized);
  return normalized.sort((left, right) => compareCodeUnits(normalizeIdentity(left), normalizeIdentity(right)));
}

function subject(value: unknown): SubjectReference {
  const record = recordInput(value, ["kind", "id"]);
  return { kind: family(record.kind), id: identifier(record.id) };
}

function reference(value: unknown): EvidenceReference {
  const record = recordInput(value, ["id", "version", "fingerprint"]);
  return { id: identifier(record.id), version: positiveVersion(record.version), fingerprint: fingerprint(record.fingerprint) };
}

function authorityEntry(value: unknown): AuthorityVersionFingerprint {
  const record = recordInput(value, ["family", "version", "fingerprint"]);
  return { family: family(record.family), version: positiveVersion(record.version), fingerprint: fingerprint(record.fingerprint) };
}

function authorityVector(value: unknown): readonly AuthorityVersionFingerprint[] {
  const snapshot = snapshotValue(value);
  if (!Array.isArray(snapshot) || snapshot.length === 0 || snapshot.length > MAX_ARRAY_ITEMS) fail("INVALID_VALUE");
  const entries = snapshot.map((item) => authorityEntry(item));
  normalizedUnique(entries.map((entry) => entry.family));
  return entries.sort((left, right) => compareCodeUnits(normalizeIdentity(left.family), normalizeIdentity(right.family)));
}

function withOptionalSchema(
  value: unknown,
  fields: readonly string[],
  expectedSchema: string,
): { [key: string]: SnapshotValue } {
  const record = recordInput(value, fields, ["schema"]);
  schemaValue(record, expectedSchema);
  if (record.schema === undefined) return record;
  return record;
}

function normalizeCommandEnvelope(value: unknown): AuthorityPurposeCommandEnvelope {
  const record = withOptionalSchema(
    value,
    [
      "workspaceId",
      "eventId",
      "subject",
      "actionFamily",
      "factFamilies",
      "commandId",
      "idempotencyKey",
      "actorEvidenceRef",
      "purposeAuthorizationRef",
      "retentionAuthorizationRef",
      "expectedAuthorityVector",
      "issuedAt",
      "payloadFingerprint",
    ],
    COMMAND_ENVELOPE_SCHEMA,
  );
  const commandId = identifier(record.commandId);
  const idempotencyKey = identifier(record.idempotencyKey);
  normalizedUnique([commandId, idempotencyKey]);
  return {
    schema: COMMAND_ENVELOPE_SCHEMA,
    workspaceId: identifier(record.workspaceId),
    eventId: identifier(record.eventId),
    subject: subject(record.subject),
    actionFamily: family(record.actionFamily),
    factFamilies: familyList(record.factFamilies),
    commandId,
    idempotencyKey,
    actorEvidenceRef: reference(record.actorEvidenceRef),
    purposeAuthorizationRef: reference(record.purposeAuthorizationRef),
    retentionAuthorizationRef: reference(record.retentionAuthorizationRef),
    expectedAuthorityVector: authorityVector(record.expectedAuthorityVector),
    issuedAt: timestamp(record.issuedAt),
    payloadFingerprint: fingerprint(record.payloadFingerprint),
  };
}

function normalizeActorEvidence(value: unknown, requireFingerprint = true): ActorEvidence {
  const fieldsWithFingerprint = ["evidenceId", "version", "fingerprint", "workspaceId", "eventId", "subject", "actorId"] as const;
  const fieldsWithoutFingerprint = fieldsWithFingerprint.filter((field) => field !== "fingerprint");
  const record = requireFingerprint
    ? withOptionalSchema(value, fieldsWithFingerprint, ACTOR_EVIDENCE_SCHEMA)
    : recordInput(value, fieldsWithoutFingerprint, ["fingerprint", "schema"]);
  schemaValue(record, ACTOR_EVIDENCE_SCHEMA);
  if (requireFingerprint && !Object.prototype.hasOwnProperty.call(record, "fingerprint")) fail("MISSING_FIELD");
  return {
    schema: ACTOR_EVIDENCE_SCHEMA,
    evidenceId: identifier(record.evidenceId),
    version: positiveVersion(record.version),
    fingerprint: Object.prototype.hasOwnProperty.call(record, "fingerprint") ? fingerprint(record.fingerprint) : "",
    workspaceId: identifier(record.workspaceId),
    eventId: identifier(record.eventId),
    subject: subject(record.subject),
    actorId: identifier(record.actorId),
  };
}

function normalizePurposeEvidence(value: unknown, requireFingerprint = true): PurposeAuthorizationEvidence {
  const fieldsWithFingerprint = [
    "purposeId",
    "version",
    "fingerprint",
    "workspaceId",
    "eventId",
    "subject",
    "allowedActionFamilies",
    "allowedFactFamilies",
    "validFrom",
    "expiresAt",
    "revoked",
  ] as const;
  const fieldsWithoutFingerprint = fieldsWithFingerprint.filter((field) => field !== "fingerprint");
  const record = requireFingerprint
    ? withOptionalSchema(value, fieldsWithFingerprint, PURPOSE_EVIDENCE_SCHEMA)
    : recordInput(value, fieldsWithoutFingerprint, ["fingerprint", "schema"]);
  schemaValue(record, PURPOSE_EVIDENCE_SCHEMA);
  if (requireFingerprint && !Object.prototype.hasOwnProperty.call(record, "fingerprint")) fail("MISSING_FIELD");
  const validFrom = timestamp(record.validFrom);
  const expiresAt = nullableTimestamp(record.expiresAt);
  if (expiresAt !== null && expiresAt <= validFrom) fail("INVALID_VALUE");
  return {
    schema: PURPOSE_EVIDENCE_SCHEMA,
    purposeId: identifier(record.purposeId),
    version: positiveVersion(record.version),
    fingerprint: Object.prototype.hasOwnProperty.call(record, "fingerprint") ? fingerprint(record.fingerprint) : "",
    workspaceId: identifier(record.workspaceId),
    eventId: identifier(record.eventId),
    subject: subject(record.subject),
    allowedActionFamilies: familyList(record.allowedActionFamilies),
    allowedFactFamilies: familyList(record.allowedFactFamilies),
    validFrom,
    expiresAt,
    revoked: booleanValue(record.revoked),
  };
}

function normalizeRetentionEvidence(value: unknown, requireFingerprint = true): RetentionEvidence {
  const fieldsWithFingerprint = [
    "policyId",
    "version",
    "fingerprint",
    "workspaceId",
    "eventId",
    "subject",
    "allowedFactFamilies",
    "retainUntil",
    "deleted",
    "withdrawn",
  ] as const;
  const fieldsWithoutFingerprint = fieldsWithFingerprint.filter((field) => field !== "fingerprint");
  const record = requireFingerprint
    ? withOptionalSchema(value, fieldsWithFingerprint, RETENTION_EVIDENCE_SCHEMA)
    : recordInput(value, fieldsWithoutFingerprint, ["fingerprint", "schema"]);
  schemaValue(record, RETENTION_EVIDENCE_SCHEMA);
  if (requireFingerprint && !Object.prototype.hasOwnProperty.call(record, "fingerprint")) fail("MISSING_FIELD");
  return {
    schema: RETENTION_EVIDENCE_SCHEMA,
    policyId: identifier(record.policyId),
    version: positiveVersion(record.version),
    fingerprint: Object.prototype.hasOwnProperty.call(record, "fingerprint") ? fingerprint(record.fingerprint) : "",
    workspaceId: identifier(record.workspaceId),
    eventId: identifier(record.eventId),
    subject: subject(record.subject),
    allowedFactFamilies: familyList(record.allowedFactFamilies),
    retainUntil: timestamp(record.retainUntil),
    deleted: booleanValue(record.deleted),
    withdrawn: booleanValue(record.withdrawn),
  };
}

function normalizeAuthorityEvidence(value: unknown): AuthorityEvidence {
  const record = withOptionalSchema(value, ["workspaceId", "eventId", "vector"], AUTHORITY_EVIDENCE_SCHEMA);
  return {
    schema: AUTHORITY_EVIDENCE_SCHEMA,
    workspaceId: identifier(record.workspaceId),
    eventId: identifier(record.eventId),
    vector: authorityVector(record.vector),
  };
}

function normalizeCommandIdentity(value: unknown): CommandIdentityEvidence {
  const record = withOptionalSchema(
    value,
    [
      "workspaceId",
      "eventId",
      "state",
      "commandId",
      "idempotencyKey",
      "actorId",
      "subject",
      "actionFamily",
      "actorEvidenceRef",
      "purposeAuthorizationRef",
      "retentionAuthorizationRef",
      "expectedAuthorityVector",
      "payloadFingerprint",
      "commandFingerprint",
    ],
    COMMAND_IDENTITY_SCHEMA,
  );
  if (record.state !== "UNSEEN" && record.state !== "MATCHED" && record.state !== "MISMATCHED") fail("INVALID_VALUE");
  return {
    schema: COMMAND_IDENTITY_SCHEMA,
    workspaceId: identifier(record.workspaceId),
    eventId: identifier(record.eventId),
    state: record.state,
    commandId: identifier(record.commandId),
    idempotencyKey: identifier(record.idempotencyKey),
    actorId: identifier(record.actorId),
    subject: subject(record.subject),
    actionFamily: family(record.actionFamily),
    actorEvidenceRef: reference(record.actorEvidenceRef),
    purposeAuthorizationRef: reference(record.purposeAuthorizationRef),
    retentionAuthorizationRef: reference(record.retentionAuthorizationRef),
    expectedAuthorityVector: authorityVector(record.expectedAuthorityVector),
    payloadFingerprint: fingerprint(record.payloadFingerprint),
    commandFingerprint: fingerprint(record.commandFingerprint),
  };
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function purposeFingerprintBody(value: PurposeAuthorizationEvidence): Record<string, unknown> {
  return {
    schema: PURPOSE_EVIDENCE_SCHEMA,
    purposeId: value.purposeId,
    version: value.version,
    workspaceId: value.workspaceId,
    eventId: value.eventId,
    subject: value.subject,
    allowedActionFamilies: value.allowedActionFamilies,
    allowedFactFamilies: value.allowedFactFamilies,
    validFrom: value.validFrom,
    expiresAt: value.expiresAt,
    revoked: value.revoked,
  };
}

function retentionFingerprintBody(value: RetentionEvidence): Record<string, unknown> {
  return {
    schema: RETENTION_EVIDENCE_SCHEMA,
    policyId: value.policyId,
    version: value.version,
    workspaceId: value.workspaceId,
    eventId: value.eventId,
    subject: value.subject,
    allowedFactFamilies: value.allowedFactFamilies,
    retainUntil: value.retainUntil,
    deleted: value.deleted,
    withdrawn: value.withdrawn,
  };
}

function actorFingerprintBody(value: ActorEvidence): Record<string, unknown> {
  return {
    schema: ACTOR_EVIDENCE_SCHEMA,
    evidenceId: value.evidenceId,
    version: value.version,
    workspaceId: value.workspaceId,
    eventId: value.eventId,
    subject: value.subject,
    actorId: value.actorId,
  };
}

function purposeEvidenceFingerprint(value: PurposeAuthorizationEvidence): Fingerprint {
  return fingerprintOf(purposeFingerprintBody(value));
}

function retentionEvidenceFingerprint(value: RetentionEvidence): Fingerprint {
  return fingerprintOf(retentionFingerprintBody(value));
}

function actorEvidenceFingerprint(value: ActorEvidence): Fingerprint {
  return fingerprintOf(actorFingerprintBody(value));
}

export function fingerprintPurposeAuthorizationEvidence(value: unknown): Fingerprint {
  return purposeEvidenceFingerprint(normalizePurposeEvidence(value, false));
}

export function fingerprintRetentionEvidence(value: unknown): Fingerprint {
  return retentionEvidenceFingerprint(normalizeRetentionEvidence(value, false));
}

export function fingerprintActorEvidence(value: unknown): Fingerprint {
  return actorEvidenceFingerprint(normalizeActorEvidence(value, false));
}

export function createCommandEnvelope(value: unknown): Readonly<AuthorityPurposeCommandEnvelope> {
  return freezeDeep(normalizeCommandEnvelope(value));
}

export const buildCommandEnvelope = createCommandEnvelope;
export const normalizeCommand = createCommandEnvelope;

export function createActorEvidence(value: unknown): Readonly<ActorEvidence> {
  const evidence = normalizeActorEvidence(value);
  if (evidence.fingerprint !== actorEvidenceFingerprint(evidence)) fail("INVALID_VALUE");
  return freezeDeep(evidence);
}

export function createPurposeAuthorizationEvidence(value: unknown): Readonly<PurposeAuthorizationEvidence> {
  const evidence = normalizePurposeEvidence(value);
  if (evidence.fingerprint !== purposeEvidenceFingerprint(evidence)) fail("INVALID_VALUE");
  return freezeDeep(evidence);
}

export const createPurposeEvidence = createPurposeAuthorizationEvidence;

export function createRetentionEvidence(value: unknown): Readonly<RetentionEvidence> {
  const evidence = normalizeRetentionEvidence(value);
  if (evidence.fingerprint !== retentionEvidenceFingerprint(evidence)) fail("INVALID_VALUE");
  return freezeDeep(evidence);
}

export function createAuthorityEvidence(value: unknown): Readonly<AuthorityEvidence> {
  return freezeDeep(normalizeAuthorityEvidence(value));
}

export function createCommandIdentityEvidence(value: unknown): Readonly<CommandIdentityEvidence> {
  return freezeDeep(normalizeCommandIdentity(value));
}

export function unavailableEvidence(value: unknown): Readonly<EvidenceUnavailable> {
  const record = recordInput(value, ["reason"]);
  return freezeDeep({ available: false as const, reason: reason(record.reason) });
}

function availabilitySnapshot(value: SnapshotValue | undefined): { kind: "available"; value: SnapshotValue } | { kind: "unavailable"; reason: string; missing: boolean } {
  if (value === undefined) return { kind: "unavailable", reason: "evidence-not-provided", missing: true };
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "available")) {
    const record = value as { [key: string]: SnapshotValue };
    exactKeys(record, ["available", "reason"]);
    if (record.available !== false) fail("INVALID_VALUE");
    return { kind: "unavailable", reason: reason(record.reason), missing: false };
  }
  return { kind: "available", value };
}

function parseAvailability<T>(
  value: SnapshotValue | undefined,
  normalize: (value: unknown) => T,
): { kind: "available"; value: T } | { kind: "unavailable"; reason: string; missing: boolean } | { kind: "invalid"; code: KernelInputErrorCode } {
  try {
    const availability = availabilitySnapshot(value);
    if (availability.kind === "unavailable") return availability;
    return { kind: "available", value: normalize(availability.value) };
  } catch (error) {
    if (error instanceof AuthorityPurposeKernelInputError) return { kind: "invalid", code: error.code };
    return { kind: "invalid", code: "INVALID_VALUE" };
  }
}

function receipt(
  code: BlockerCode,
  path: string,
  expected: string | null,
  observed: string | null,
  checkedAt: Timestamp | null,
  unavailableReason: string | null = null,
): BlockerReceipt {
  const body = {
    schema: BLOCKER_RECEIPT_SCHEMA,
    code,
    path,
    expected,
    observed,
    reason: unavailableReason,
    checkedAt,
  };
  return freezeDeep({ ...body, fingerprint: fingerprintOf(body) });
}

function receiptSort(left: BlockerReceipt, right: BlockerReceipt): number {
  for (const [a, b] of [
    [left.code, right.code],
    [left.path, right.path],
    [left.expected ?? "", right.expected ?? ""],
    [left.observed ?? "", right.observed ?? ""],
    [left.reason ?? "", right.reason ?? ""],
  ] as const) {
    const difference = compareCodeUnits(a, b);
    if (difference !== 0) return difference;
  }
  return 0;
}

function result(
  state: PreflightState,
  checkedAt: Timestamp | null,
  commandFingerprint: Fingerprint | null,
  receipts: readonly BlockerReceipt[],
): PreflightResult {
  let ordered = [...receipts].sort(receiptSort);
  let boundedState = state;
  if (ordered.length > MAX_ARRAY_ITEMS) {
    boundedState = "BLOCKED";
    const overflow = receipt(
      "INPUT_REJECTED",
      "receipts",
      `<=${MAX_ARRAY_ITEMS}`,
      String(ordered.length),
      checkedAt,
      "receipt-bound-exceeded",
    );
    ordered = [...ordered.slice(0, MAX_ARRAY_ITEMS - 1), overflow].sort(receiptSort);
  }
  const body = {
    schema: PREFLIGHT_RESULT_SCHEMA,
    state: boundedState,
    checkedAt,
    commandFingerprint,
    receipts: ordered,
  };
  return freezeDeep({ ...body, receiptFingerprint: fingerprintOf(body) });
}

function scopeMismatch(
  code: BlockerCode,
  path: string,
  command: AuthorityPurposeCommandEnvelope,
  workspaceId: string,
  eventId: string,
  subjectValue: SubjectReference,
  checkedAt: Timestamp,
  receipts: BlockerReceipt[],
): void {
  if (command.workspaceId !== workspaceId) receipts.push(receipt(code, `${path}.workspaceId`, command.workspaceId, workspaceId, checkedAt));
  if (command.eventId !== eventId) receipts.push(receipt(code, `${path}.eventId`, command.eventId, eventId, checkedAt));
  if (command.subject.kind !== subjectValue.kind || command.subject.id !== subjectValue.id) {
    receipts.push(receipt(code, `${path}.subject`, `${command.subject.kind}:${command.subject.id}`, `${subjectValue.kind}:${subjectValue.id}`, checkedAt));
  }
}

function scopeMismatchWithoutSubject(
  code: BlockerCode,
  path: string,
  command: AuthorityPurposeCommandEnvelope,
  workspaceId: string,
  eventId: string,
  checkedAt: Timestamp,
  receipts: BlockerReceipt[],
): void {
  if (command.workspaceId !== workspaceId) receipts.push(receipt(code, `${path}.workspaceId`, command.workspaceId, workspaceId, checkedAt));
  if (command.eventId !== eventId) receipts.push(receipt(code, `${path}.eventId`, command.eventId, eventId, checkedAt));
}

function referenceChecks(
  path: string,
  expected: EvidenceReference,
  observedId: string,
  observedVersion: number,
  observedFingerprint: Fingerprint,
  checkedAt: Timestamp,
  receipts: BlockerReceipt[],
  referenceMismatchCode: BlockerCode,
  versionCode: BlockerCode,
  fingerprintCode: BlockerCode,
): void {
  if (expected.id !== observedId) receipts.push(receipt(referenceMismatchCode, `${path}.id`, expected.id, observedId, checkedAt));
  if (expected.version !== observedVersion) receipts.push(receipt(versionCode, `${path}.version`, String(expected.version), String(observedVersion), checkedAt));
  if (expected.fingerprint !== observedFingerprint) receipts.push(receipt(fingerprintCode, `${path}.fingerprint`, expected.fingerprint, observedFingerprint, checkedAt));
}

function declaredFingerprintCheck(
  path: string,
  declared: Fingerprint,
  computed: Fingerprint,
  code: BlockerCode,
  checkedAt: Timestamp,
  receipts: BlockerReceipt[],
): void {
  if (declared !== computed) {
    receipts.push(receipt(code, `${path}.fingerprint`, computed, declared, checkedAt));
  }
}

function compareFamilies(
  requested: readonly string[],
  allowed: readonly string[],
  code: BlockerCode,
  path: string,
  checkedAt: Timestamp,
  receipts: BlockerReceipt[],
): void {
  const allowedIdentities = new Set(allowed.map(normalizeIdentity));
  for (const requestedFamily of requested) {
    if (!allowedIdentities.has(normalizeIdentity(requestedFamily))) {
      receipts.push(receipt(code, path, "allowed", requestedFamily, checkedAt));
    }
  }
}

function subjectIdentity(value: SubjectReference | null): string | null {
  return value === null ? null : `${value.kind}:${value.id}`;
}

function referenceIdentity(value: EvidenceReference | null): string | null {
  return value === null ? null : fingerprintOf(value);
}

function authorityVectorIdentity(value: readonly AuthorityVersionFingerprint[] | null): string | null {
  return value === null ? null : fingerprintOf(value);
}

function commandIdentityCheck(
  path: string,
  expected: string | null,
  observed: string | null,
  checkedAt: Timestamp,
  receipts: BlockerReceipt[],
): void {
  if (expected !== observed) {
    receipts.push(receipt("COMMAND_IDENTITY_MISMATCH", path, expected, observed, checkedAt));
  }
}

const AVAILABILITY_CODES = new Set<BlockerCode>([
  "ACTOR_EVIDENCE_MISSING",
  "ACTOR_EVIDENCE_UNAVAILABLE",
  "PURPOSE_EVIDENCE_MISSING",
  "PURPOSE_EVIDENCE_UNAVAILABLE",
  "RETENTION_EVIDENCE_MISSING",
  "RETENTION_EVIDENCE_UNAVAILABLE",
  "AUTHORITY_EVIDENCE_MISSING",
  "AUTHORITY_EVIDENCE_UNAVAILABLE",
  "IDEMPOTENCY_EVIDENCE_MISSING",
  "IDEMPOTENCY_EVIDENCE_UNAVAILABLE",
]);

function inputReceipt(errorCode: KernelInputErrorCode, checkedAt: Timestamp | null): BlockerReceipt {
  return receipt("INPUT_REJECTED", "input", "valid-bounded-contract", errorCode, checkedAt);
}

function checkedAtFrom(value: SnapshotValue): Timestamp {
  return timestamp(value);
}

/**
 * Pure fail-closed preflight. `READY` means every supplied current-evidence check passed; it does
 * not grant mutation authority. No branch returns a callback, command, payload, provider result,
 * or executable action.
 */
export function preflight(value: unknown): Readonly<PreflightResult> {
  let input: { [key: string]: SnapshotValue };
  try {
    const snapshot = snapshotValue(value);
    if (!isRecord(snapshot)) fail("INPUT_NOT_OBJECT");
    exactKeys(snapshot, ["command", "now"], ["actorEvidence", "purposeEvidence", "retentionEvidence", "authorityEvidence", "idempotencyEvidence"]);
    input = snapshot;
  } catch (error) {
    const code = error instanceof AuthorityPurposeKernelInputError ? error.code : "INVALID_VALUE";
    return result("BLOCKED", null, null, [inputReceipt(code, null)]);
  }

  let checkedAt: Timestamp;
  try {
    checkedAt = checkedAtFrom(input.now);
  } catch (error) {
    const code = error instanceof AuthorityPurposeKernelInputError ? error.code : "INVALID_VALUE";
    return result("BLOCKED", null, null, [inputReceipt(code, null)]);
  }

  let command: AuthorityPurposeCommandEnvelope;
  try {
    command = createCommandEnvelope(input.command);
  } catch (error) {
    const code = error instanceof AuthorityPurposeKernelInputError ? error.code : "INVALID_VALUE";
    return result("BLOCKED", checkedAt, null, [inputReceipt(code, checkedAt)]);
  }

  const receipts: BlockerReceipt[] = [];
  const commandFingerprint = fingerprintOf(command);
  if (command.issuedAt > checkedAt) {
    receipts.push(receipt("COMMAND_ISSUED_IN_FUTURE", "command.issuedAt", "<= checkedAt", command.issuedAt, checkedAt));
  }

  let currentActorId: string | null = null;
  const actor = parseAvailability(input.actorEvidence, normalizeActorEvidence);
  if (actor.kind === "invalid") receipts.push(inputReceipt(actor.code, checkedAt));
  else if (actor.kind === "unavailable") {
    receipts.push(receipt(actor.missing ? "ACTOR_EVIDENCE_MISSING" : "ACTOR_EVIDENCE_UNAVAILABLE", "actorEvidence", "available", null, checkedAt, actor.reason));
  } else {
    const evidence = actor.value;
    const computedFingerprint = actorEvidenceFingerprint(evidence);
    currentActorId = evidence.actorId;
    declaredFingerprintCheck(
      "actorEvidence",
      evidence.fingerprint,
      computedFingerprint,
      "ACTOR_FINGERPRINT_STALE",
      checkedAt,
      receipts,
    );
    referenceChecks(
      "command.actorEvidenceRef",
      command.actorEvidenceRef,
      evidence.evidenceId,
      evidence.version,
      computedFingerprint,
      checkedAt,
      receipts,
      "ACTOR_REFERENCE_MISMATCH",
      "ACTOR_VERSION_STALE",
      "ACTOR_FINGERPRINT_STALE",
    );
    scopeMismatch("ACTOR_SCOPE_MISMATCH", "actorEvidence", command, evidence.workspaceId, evidence.eventId, evidence.subject, checkedAt, receipts);
  }

  const purpose = parseAvailability(input.purposeEvidence, normalizePurposeEvidence);
  if (purpose.kind === "invalid") receipts.push(inputReceipt(purpose.code, checkedAt));
  else if (purpose.kind === "unavailable") {
    receipts.push(receipt(purpose.missing ? "PURPOSE_EVIDENCE_MISSING" : "PURPOSE_EVIDENCE_UNAVAILABLE", "purposeEvidence", "available", null, checkedAt, purpose.reason));
  } else {
    const evidence = purpose.value;
    const computedFingerprint = purposeEvidenceFingerprint(evidence);
    declaredFingerprintCheck(
      "purposeEvidence",
      evidence.fingerprint,
      computedFingerprint,
      "PURPOSE_FINGERPRINT_STALE",
      checkedAt,
      receipts,
    );
    referenceChecks(
      "command.purposeAuthorizationRef",
      command.purposeAuthorizationRef,
      evidence.purposeId,
      evidence.version,
      computedFingerprint,
      checkedAt,
      receipts,
      "PURPOSE_REFERENCE_MISMATCH",
      "PURPOSE_VERSION_STALE",
      "PURPOSE_FINGERPRINT_STALE",
    );
    scopeMismatch("PURPOSE_SCOPE_MISMATCH", "purposeEvidence", command, evidence.workspaceId, evidence.eventId, evidence.subject, checkedAt, receipts);
    if (evidence.revoked) receipts.push(receipt("PURPOSE_REVOKED", "purposeEvidence.revoked", "false", "true", checkedAt));
    if (checkedAt < evidence.validFrom) receipts.push(receipt("PURPOSE_NOT_YET_VALID", "purposeEvidence.validFrom", "<= checkedAt", evidence.validFrom, checkedAt));
    if (evidence.expiresAt !== null && checkedAt >= evidence.expiresAt) receipts.push(receipt("PURPOSE_EXPIRED", "purposeEvidence.expiresAt", "> checkedAt", evidence.expiresAt, checkedAt));
    compareFamilies(command.actionFamily ? [command.actionFamily] : [], evidence.allowedActionFamilies, "ACTION_FAMILY_DISALLOWED", "command.actionFamily", checkedAt, receipts);
    compareFamilies(command.factFamilies, evidence.allowedFactFamilies, "FACT_FAMILY_DISALLOWED", "command.factFamilies", checkedAt, receipts);
  }

  const retention = parseAvailability(input.retentionEvidence, normalizeRetentionEvidence);
  if (retention.kind === "invalid") receipts.push(inputReceipt(retention.code, checkedAt));
  else if (retention.kind === "unavailable") {
    receipts.push(receipt(retention.missing ? "RETENTION_EVIDENCE_MISSING" : "RETENTION_EVIDENCE_UNAVAILABLE", "retentionEvidence", "available", null, checkedAt, retention.reason));
  } else {
    const evidence = retention.value;
    const computedFingerprint = retentionEvidenceFingerprint(evidence);
    declaredFingerprintCheck(
      "retentionEvidence",
      evidence.fingerprint,
      computedFingerprint,
      "RETENTION_FINGERPRINT_STALE",
      checkedAt,
      receipts,
    );
    referenceChecks(
      "command.retentionAuthorizationRef",
      command.retentionAuthorizationRef,
      evidence.policyId,
      evidence.version,
      computedFingerprint,
      checkedAt,
      receipts,
      "RETENTION_REFERENCE_MISMATCH",
      "RETENTION_VERSION_STALE",
      "RETENTION_FINGERPRINT_STALE",
    );
    scopeMismatch("RETENTION_SCOPE_MISMATCH", "retentionEvidence", command, evidence.workspaceId, evidence.eventId, evidence.subject, checkedAt, receipts);
    if (checkedAt >= evidence.retainUntil) receipts.push(receipt("RETENTION_EXPIRED", "retentionEvidence.retainUntil", "> checkedAt", evidence.retainUntil, checkedAt));
    if (evidence.deleted) receipts.push(receipt("RETENTION_DELETED", "retentionEvidence.deleted", "false", "true", checkedAt));
    if (evidence.withdrawn) receipts.push(receipt("RETENTION_WITHDRAWN", "retentionEvidence.withdrawn", "false", "true", checkedAt));
    compareFamilies(command.factFamilies, evidence.allowedFactFamilies, "RETENTION_FACT_FAMILY_DISALLOWED", "command.factFamilies", checkedAt, receipts);
  }

  const authority = parseAvailability(input.authorityEvidence, createAuthorityEvidence);
  if (authority.kind === "invalid") receipts.push(inputReceipt(authority.code, checkedAt));
  else if (authority.kind === "unavailable") {
    receipts.push(receipt(authority.missing ? "AUTHORITY_EVIDENCE_MISSING" : "AUTHORITY_EVIDENCE_UNAVAILABLE", "authorityEvidence", "available", null, checkedAt, authority.reason));
  } else {
    const evidence = authority.value;
    scopeMismatchWithoutSubject("AUTHORITY_SCOPE_MISMATCH", "authorityEvidence", command, evidence.workspaceId, evidence.eventId, checkedAt, receipts);
    const current = new Map(evidence.vector.map((entry) => [normalizeIdentity(entry.family), entry]));
    for (const expected of command.expectedAuthorityVector) {
      const observed = current.get(normalizeIdentity(expected.family));
      if (!observed) {
        receipts.push(receipt("AUTHORITY_FAMILY_MISSING", "command.expectedAuthorityVector", expected.family, null, checkedAt));
        continue;
      }
      if (observed.version !== expected.version) receipts.push(receipt("AUTHORITY_VERSION_STALE", `authorityEvidence.${expected.family}.version`, String(expected.version), String(observed.version), checkedAt));
      if (observed.fingerprint !== expected.fingerprint) receipts.push(receipt("AUTHORITY_FINGERPRINT_STALE", `authorityEvidence.${expected.family}.fingerprint`, expected.fingerprint, observed.fingerprint, checkedAt));
    }
  }

  const idempotency = parseAvailability(input.idempotencyEvidence, createCommandIdentityEvidence);
  if (idempotency.kind === "invalid") receipts.push(inputReceipt(idempotency.code, checkedAt));
  else if (idempotency.kind === "unavailable") {
    receipts.push(receipt(idempotency.missing ? "IDEMPOTENCY_EVIDENCE_MISSING" : "IDEMPOTENCY_EVIDENCE_UNAVAILABLE", "idempotencyEvidence", "available", null, checkedAt, idempotency.reason));
  } else {
    const evidence = idempotency.value;
    scopeMismatchWithoutSubject("IDEMPOTENCY_SCOPE_MISMATCH", "idempotencyEvidence", command, evidence.workspaceId, evidence.eventId, checkedAt, receipts);
    if (evidence.state === "MISMATCHED") {
      receipts.push(receipt("IDEMPOTENCY_IDENTITY_MISMATCH", "idempotencyEvidence.state", "UNSEEN or MATCHED", evidence.state, checkedAt));
    }
    commandIdentityCheck("idempotencyEvidence.commandId", command.commandId, evidence.commandId, checkedAt, receipts);
    commandIdentityCheck("idempotencyEvidence.idempotencyKey", command.idempotencyKey, evidence.idempotencyKey, checkedAt, receipts);
    if (currentActorId !== null) {
      commandIdentityCheck("idempotencyEvidence.actorId", currentActorId, evidence.actorId, checkedAt, receipts);
    }
    commandIdentityCheck(
      "idempotencyEvidence.subject",
      subjectIdentity(command.subject),
      subjectIdentity(evidence.subject),
      checkedAt,
      receipts,
    );
    commandIdentityCheck("idempotencyEvidence.actionFamily", command.actionFamily, evidence.actionFamily, checkedAt, receipts);
    commandIdentityCheck(
      "idempotencyEvidence.actorEvidenceRef",
      referenceIdentity(command.actorEvidenceRef),
      referenceIdentity(evidence.actorEvidenceRef),
      checkedAt,
      receipts,
    );
    commandIdentityCheck(
      "idempotencyEvidence.purposeAuthorizationRef",
      referenceIdentity(command.purposeAuthorizationRef),
      referenceIdentity(evidence.purposeAuthorizationRef),
      checkedAt,
      receipts,
    );
    commandIdentityCheck(
      "idempotencyEvidence.retentionAuthorizationRef",
      referenceIdentity(command.retentionAuthorizationRef),
      referenceIdentity(evidence.retentionAuthorizationRef),
      checkedAt,
      receipts,
    );
    commandIdentityCheck(
      "idempotencyEvidence.expectedAuthorityVector",
      authorityVectorIdentity(command.expectedAuthorityVector),
      authorityVectorIdentity(evidence.expectedAuthorityVector),
      checkedAt,
      receipts,
    );
    commandIdentityCheck(
      "idempotencyEvidence.payloadFingerprint",
      command.payloadFingerprint,
      evidence.payloadFingerprint,
      checkedAt,
      receipts,
    );
    commandIdentityCheck(
      "idempotencyEvidence.commandFingerprint",
      commandFingerprint,
      evidence.commandFingerprint,
      checkedAt,
      receipts,
    );
  }

  const hasBlockedReceipt = receipts.some((item) => !AVAILABILITY_CODES.has(item.code));
  const state: PreflightState = hasBlockedReceipt ? "BLOCKED" : receipts.length > 0 ? "UNAVAILABLE" : "READY";
  return result(state, checkedAt, commandFingerprint, receipts);
}

export const preflightAuthorityPurpose = preflight;
export const preflightCommand = preflight;
