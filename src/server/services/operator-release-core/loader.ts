import {
  MAX_FIELD_LENGTH,
  MAX_FIELDS_PER_SOURCE,
  MAX_FIELDS_PER_VECTOR,
  MAX_FIELD_VALUE_BYTES,
  MAX_ID_LENGTH,
  MAX_REASON_LENGTH,
  MAX_RELEASE_TWIN_BYTES,
  MAX_SOURCE_RECORDS,
  MAX_VECTOR_BYTES,
  OPERATOR_FIELD_ALLOWLIST,
  SOURCE_VECTOR_SCHEMA,
  TRUSTED_LOADER_AUTHORITY,
  type DriftFamily,
  type FieldDecisionInput,
  type JsonValue,
  type ReleaseAudience,
  type ReleaseSourceRecord,
  type ReleaseSourceVector,
  type SourceRecordInput,
  type SourceScope,
  type SourceVectorDraft,
  type SourceVectorExpectation,
} from "./contracts";
import {
  byteLength,
  cloneAndFreeze,
  compareStrings,
  fingerprintOf,
  snapshotPlainData,
  sortCodePoints,
} from "./canonical";
import { fail, OperatorReleaseCoreError } from "./errors";

const IDENTIFIER = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_ID_LENGTH - 1}}$`, "u");
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;
const DRIFT_FAMILIES: readonly DriftFamily[] = [
  "TIME",
  "CONTENT",
  "LOCATION",
  "COMMITMENT",
  "POLICY",
  "IDENTITY",
  "OPERATOR_CUE",
  "CONTACT",
  "PRIVATE_ARTIFACT",
  "UNKNOWN",
];
const SOURCE_SCOPES: readonly SourceScope[] = ["COMMON", "PUBLIC", "OPERATOR"];
const FORBIDDEN_NAMING_WORDS = new Set([
  "action", "actions", "provider", "providers", "token", "tokens", "secret", "secrets",
  "credential", "credentials", "webhook", "webhooks", "password", "passwords", "cookie", "cookies",
  "authorization", "adapter", "adapters", "endpoint", "endpoints", "authority",
]);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotRecord(value: unknown, maxBytes: number, label: string): RecordValue {
  const snapshot = snapshotPlainData(value, { maxBytes });
  if (!isRecord(snapshot)) fail("NON_CANONICAL_INPUT", `${label} must be a plain object.`);
  return snapshot;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectControlPlaneFields(value: RecordValue): void {
  if (hasOwn(value, "authority") || hasOwn(value, "sourceAuthority")) {
    fail("CALLER_AUTHORITY_FORBIDDEN", "Authority is fixed by the trusted persistence loader.");
  }
  if (hasOwn(value, "action") || hasOwn(value, "provider")) {
    fail("FORBIDDEN_FIELD", "Action and provider fields are outside this pure release core.");
  }
}

function exactKeys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) {
    fail("NON_CANONICAL_INPUT", "The release input has an unsupported object field.");
  }
  for (const key of required) {
    if (!hasOwn(value, key)) fail("NON_CANONICAL_INPUT", "The release input is missing a required object field.");
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    fail("INVALID_INPUT", `${label} is invalid.`);
  }
  return value;
}

export function releaseIdentifier(value: unknown, label: string): string {
  const result = text(value, label, MAX_ID_LENGTH);
  if (!IDENTIFIER.test(result)) fail("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function fingerprint(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!FINGERPRINT.test(result)) fail("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

export function releaseVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("INVALID_INPUT", `${label} is invalid.`);
  return value as number;
}

export function releaseFamily(value: unknown): DriftFamily {
  if (!DRIFT_FAMILIES.includes(value as DriftFamily)) fail("INVALID_INPUT", "The source family is invalid.");
  return value as DriftFamily;
}

function sourceScope(value: unknown): SourceScope {
  if (!SOURCE_SCOPES.includes(value as SourceScope)) fail("INVALID_INPUT", "The source scope is invalid.");
  return value as SourceScope;
}

export function releaseAudience(value: unknown): ReleaseAudience {
  if (value !== "PUBLIC" && value !== "OPERATOR") fail("INVALID_INPUT", "The release audience is invalid.");
  return value;
}

function namingWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

function hasForbiddenNamingForm(value: string): boolean {
  const words = namingWords(value);
  if (words.some((word) => FORBIDDEN_NAMING_WORDS.has(word))) return true;
  if (words.some((word) => /^(?:token|secret|credential|password|cookie|webhook|authorization)|(?:token|secret|credential|password|cookie|webhook|authorization)$/u.test(word))) return true;
  if (words.some((word) => /^(?:api|access|private)key$/u.test(word))) return true;
  for (let index = 0; index + 1 < words.length; index += 1) {
    const pair = `${words[index]}:${words[index + 1]}`;
    if (pair === "api:key" || pair === "access:key" || pair === "private:key") return true;
  }
  return false;
}

export function releaseFieldName(value: unknown): string {
  const result = text(value, "field", MAX_FIELD_LENGTH);
  if (hasForbiddenNamingForm(result)) {
    fail("FORBIDDEN_FIELD", "Action, provider, credential, secret, and access fields are not release fields.");
  }
  return result;
}

export function assertReleasePayloadKeys(value: JsonValue): void {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    } else if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype" || key === "toJSON" || hasForbiddenNamingForm(key)) {
          fail("FORBIDDEN_FIELD", "Credential, secret, provider, action, and authority payload fields are not allowed.");
        }
        pending.push(child);
      }
    }
  }
}

const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

function canonicalInstant(value: string): string {
  const match = RFC3339_INSTANT.exec(value);
  if (!match) fail("NON_CANONICAL_INPUT", "Temporal fields must be RFC 3339 instants with an explicit timezone.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    fail("INVALID_INPUT", "The temporal field is invalid.");
  }
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day ||
    local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second
  ) {
    fail("INVALID_INPUT", "The temporal field contains an invalid calendar date.");
  }
  const timezone = match[8]!;
  let offsetMinutes = 0;
  if (timezone !== "Z") {
    const offsetHour = Number(timezone.slice(1, 3));
    const offsetMinute = Number(timezone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) fail("INVALID_INPUT", "The temporal timezone offset is invalid.");
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (timezone[0] === "+" ? 1 : -1);
  }
  const instant = new Date(local.getTime() - offsetMinutes * 60_000);
  if (!Number.isFinite(instant.getTime()) || instant.getUTCFullYear() < 0 || instant.getUTCFullYear() > 9999) {
    fail("INVALID_INPUT", "The temporal field is outside the supported instant range.");
  }
  return instant.toISOString();
}

function looksLikeTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[Tt]/u.test(value);
}

function normalizeTemporalValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return looksLikeTimestamp(value) ? canonicalInstant(value) : value;
  if (Array.isArray(value)) return value.map(normalizeTemporalValue);
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const child = value[key]!;
      if (typeof child === "string" && /(?:^|_)(?:at|time|date|start|end)(?:$|_)|(?:at|time|date|start|end)$/iu.test(key) && looksLikeTimestamp(child)) {
        normalized[key] = canonicalInstant(child);
      } else {
        normalized[key] = normalizeTemporalValue(child);
      }
    }
    return normalized;
  }
  return value;
}

function normalizeFieldSnapshot(value: unknown, sourceFamily: DriftFamily): {
  readonly field: string;
  readonly family: DriftFamily;
  readonly value: JsonValue;
} {
  if (!isRecord(value)) fail("NON_CANONICAL_INPUT", "A source field must be an object.");
  rejectControlPlaneFields(value);
  exactKeys(value, ["field", "family", "value"]);
  const field = releaseFieldName(value.field);
  const fieldFamily = releaseFamily(value.family);
  if (fieldFamily !== sourceFamily) fail("CONFLICTING_FIELD", "A source field family conflicts with its source family.");
  const fieldValue = normalizeReleaseFieldValue(value.value, fieldFamily);
  return { field, family: fieldFamily, value: fieldValue };
}

export function normalizeReleaseFieldValue(value: unknown, _fieldFamily: DriftFamily): JsonValue {
  let fieldValue = snapshotPlainData(value, { maxBytes: MAX_FIELD_VALUE_BYTES * 2 });
  assertReleasePayloadKeys(fieldValue);
  fieldValue = normalizeTemporalValue(fieldValue);
  if (byteLength(fieldValue) > MAX_FIELD_VALUE_BYTES) fail("LIMIT_EXCEEDED", "A source field value exceeds the bounded input size.");
  return fieldValue;
}

function sourceBasis(source: Omit<ReleaseSourceRecord, "fingerprint">): unknown {
  return {
    sourceId: source.sourceId,
    scope: source.scope,
    family: source.family,
    version: source.version,
    status: source.status,
    fields: source.fields,
    unavailableReason: source.unavailableReason ?? null,
  };
}

function normalizeSourceRecordSnapshot(value: unknown, fingerprintRequired: boolean): ReleaseSourceRecord {
  if (!isRecord(value)) fail("NON_CANONICAL_INPUT", "A source record must be an object.");
  rejectControlPlaneFields(value);
  exactKeys(
    value,
    fingerprintRequired
      ? ["sourceId", "scope", "family", "version", "status", "fields", "fingerprint"]
      : ["sourceId", "scope", "family", "version", "status", "fields"],
    fingerprintRequired ? ["unavailableReason"] : ["unavailableReason", "fingerprint"],
  );
  const sourceId = releaseIdentifier(value.sourceId, "sourceId");
  const scope = sourceScope(value.scope);
  const sourceFamily = releaseFamily(value.family);
  const version = releaseVersion(value.version, "source version");
  if (value.status !== "AVAILABLE" && value.status !== "UNAVAILABLE") fail("INVALID_INPUT", "The source availability is invalid.");
  const status = value.status;
  if (!Array.isArray(value.fields) || value.fields.length > MAX_FIELDS_PER_SOURCE) {
    fail("LIMIT_EXCEEDED", "A source has too many fields.");
  }
  if (status === "AVAILABLE" && value.fields.length === 0) {
    fail("SOURCE_UNAVAILABLE", "An available release source must contain at least one field.");
  }
  if (sourceFamily === "UNKNOWN" && (status !== "UNAVAILABLE" || value.fields.length !== 0)) {
    fail("SOURCE_UNAVAILABLE", "Unknown sources remain unavailable and carry no fields.");
  }
  if (status === "UNAVAILABLE") {
    if (value.fields.length !== 0) fail("SOURCE_UNAVAILABLE", "Unavailable sources cannot carry release fields.");
    if (!hasOwn(value, "unavailableReason")) fail("SOURCE_UNAVAILABLE", "Unavailable sources require an explicit bounded reason.");
    text(value.unavailableReason, "unavailableReason", MAX_REASON_LENGTH);
  } else if (hasOwn(value, "unavailableReason")) {
    fail("NON_CANONICAL_INPUT", "Available sources cannot carry an unavailable reason.");
  }
  if (scope !== "OPERATOR" && (sourceFamily === "OPERATOR_CUE" || sourceFamily === "CONTACT" || sourceFamily === "PRIVATE_ARTIFACT")) {
    fail("CROSS_AUDIENCE_LEAKAGE", "Operator-only or private facts cannot be common or public release sources.");
  }
  const fields = sortCodePoints(value.fields.map((field) => normalizeFieldSnapshot(field, sourceFamily)), (field) => field.field);
  for (const field of fields) {
    if (OPERATOR_FIELD_ALLOWLIST.includes(field.field as (typeof OPERATOR_FIELD_ALLOWLIST)[number]) && (scope !== "OPERATOR" || sourceFamily !== "OPERATOR_CUE")) {
      fail("CROSS_AUDIENCE_LEAKAGE", "Allowlisted operator cues must remain operator-scoped operator-cue fields.");
    }
  }
  const fieldNames = new Set<string>();
  for (const field of fields) {
    if (fieldNames.has(field.field)) fail("DUPLICATE_FIELD", "A source contains a duplicate field.");
    fieldNames.add(field.field);
  }
  const unavailableReason = status === "UNAVAILABLE" ? value.unavailableReason as string : undefined;
  const basis = {
    sourceId,
    scope,
    family: sourceFamily,
    version,
    status,
    fields,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  } satisfies Omit<ReleaseSourceRecord, "fingerprint">;
  const computedFingerprint = fingerprintOf(sourceBasis(basis));
  if (hasOwn(value, "fingerprint") && fingerprint(value.fingerprint, "source fingerprint") !== computedFingerprint) {
    fail("FINGERPRINT_MISMATCH", "The source fingerprint does not match canonical source content.");
  }
  return { ...basis, fingerprint: computedFingerprint };
}

export function normalizeSourceRecord(value: unknown): ReleaseSourceRecord {
  const snapshot = snapshotRecord(value, MAX_VECTOR_BYTES, "A source record");
  return cloneAndFreeze(normalizeSourceRecordSnapshot(snapshot, false));
}

function allowedScopes(audience: ReleaseAudience): readonly SourceScope[] {
  return audience === "PUBLIC" ? ["COMMON", "PUBLIC"] : ["COMMON", "OPERATOR"];
}

export function isDriftFamily(value: unknown): value is DriftFamily {
  return DRIFT_FAMILIES.includes(value as DriftFamily);
}

function vectorBasis(vector: Omit<ReleaseSourceVector, "fingerprint" | "authority">): unknown {
  return {
    schema: vector.schema,
    workspaceId: vector.workspaceId,
    eventId: vector.eventId,
    audience: vector.audience,
    version: vector.version,
    availability: vector.availability,
    sources: vector.sources,
    commonFingerprint: vector.commonFingerprint,
    audienceFingerprint: vector.audienceFingerprint,
  };
}

function sourceCollectionFingerprint(sources: readonly ReleaseSourceRecord[]): string {
  return fingerprintOf(sortCodePoints(sources, (source) => source.sourceId).map((source) => sourceBasis(source)));
}

function assertUniqueVectorFields(sources: readonly ReleaseSourceRecord[]): void {
  const fields = new Map<string, { readonly family: DriftFamily; readonly value: JsonValue }>();
  for (const source of sources) {
    for (const field of source.fields) {
      const prior = fields.get(field.field);
      if (prior) {
        const sameValue = prior.family === field.family && fingerprintOf(prior.value) === fingerprintOf(field.value);
        fail(sameValue ? "DUPLICATE_FIELD" : "CONFLICTING_FIELD", "A source vector contains duplicate or conflicting field content.");
      }
      fields.set(field.field, { family: field.family, value: field.value });
    }
  }
}

function buildVector(
  workspaceId: string,
  eventId: string,
  audience: ReleaseAudience,
  version: number,
  sourcesInput: readonly ReleaseSourceRecord[],
  suppliedFingerprint?: unknown,
  suppliedCommonFingerprint?: unknown,
  suppliedAudienceFingerprint?: unknown,
  suppliedAvailability?: unknown,
): ReleaseSourceVector {
  if (sourcesInput.length === 0 || sourcesInput.length > MAX_SOURCE_RECORDS) {
    fail("LIMIT_EXCEEDED", "A source vector must contain a bounded non-empty source set.");
  }
  const sources = sortCodePoints(sourcesInput, (source) => source.sourceId);
  const totalFields = sources.reduce((count, source) => count + source.fields.length, 0);
  if (totalFields > MAX_FIELDS_PER_VECTOR) fail("LIMIT_EXCEEDED", "A source vector contains too many fields.");
  assertUniqueVectorFields(sources);
  const commonSources = sources.filter((source) => source.scope === "COMMON");
  const audienceSources = sources.filter((source) => source.scope === audience);
  const commonFingerprint = sourceCollectionFingerprint(commonSources);
  const audienceFingerprint = sourceCollectionFingerprint(audienceSources);
  if (suppliedCommonFingerprint !== undefined && fingerprint(suppliedCommonFingerprint, "common fingerprint") !== commonFingerprint) {
    fail("COMMON_FINGERPRINT_MISMATCH", "The common source fingerprint does not match canonical source content.");
  }
  if (suppliedAudienceFingerprint !== undefined && fingerprint(suppliedAudienceFingerprint, "audience fingerprint") !== audienceFingerprint) {
    fail("FINGERPRINT_MISMATCH", "The audience source fingerprint does not match canonical source content.");
  }
  const availability: "AVAILABLE" | "UNAVAILABLE" = sources.every((source) => source.status === "AVAILABLE") && totalFields > 0
    ? "AVAILABLE"
    : "UNAVAILABLE";
  if (suppliedAvailability !== undefined && suppliedAvailability !== availability) {
    fail("FINGERPRINT_MISMATCH", "The persisted source availability does not match canonical source content.");
  }
  const basis = {
    schema: SOURCE_VECTOR_SCHEMA,
    workspaceId,
    eventId,
    audience,
    version,
    availability,
    sources,
    commonFingerprint,
    audienceFingerprint,
  } satisfies Omit<ReleaseSourceVector, "fingerprint" | "authority">;
  const computedFingerprint = fingerprintOf(vectorBasis(basis));
  if (suppliedFingerprint !== undefined && fingerprint(suppliedFingerprint, "vector fingerprint") !== computedFingerprint) {
    fail("FINGERPRINT_MISMATCH", "The source-vector fingerprint does not match canonical vector content.");
  }
  if (byteLength(basis) > MAX_VECTOR_BYTES) fail("VECTOR_TOO_LARGE", "The source vector exceeds the bounded manifest size.");
  return cloneAndFreeze({
    ...basis,
    authority: TRUSTED_LOADER_AUTHORITY,
    fingerprint: computedFingerprint,
  });
}

function normalizeVectorDraftSnapshot(value: RecordValue): ReleaseSourceVector {
  rejectControlPlaneFields(value);
  exactKeys(value, ["workspaceId", "eventId", "audience", "version", "sources"], ["schema", "fingerprint", "commonFingerprint"]);
  if (hasOwn(value, "schema") && value.schema !== SOURCE_VECTOR_SCHEMA) fail("INVALID_SCHEMA", "The source-vector schema is unsupported.");
  const workspaceId = releaseIdentifier(value.workspaceId, "workspaceId");
  const eventId = releaseIdentifier(value.eventId, "eventId");
  const audience = releaseAudience(value.audience);
  const version = releaseVersion(value.version, "vector version");
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > MAX_SOURCE_RECORDS) {
    fail("LIMIT_EXCEEDED", "A source vector must contain a bounded non-empty source set.");
  }
  const sources = value.sources.map((source) => normalizeSourceRecordSnapshot(source, false));
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) fail("DUPLICATE_SOURCE", "A source vector contains a duplicate source.");
    sourceIds.add(source.sourceId);
    if (!allowedScopes(audience).includes(source.scope)) {
      fail("CROSS_AUDIENCE_LEAKAGE", "A source vector contains a fact owned by another audience.");
    }
  }
  return buildVector(workspaceId, eventId, audience, version, sources, value.fingerprint, value.commonFingerprint);
}

function normalizePersistedVectorSnapshot(value: RecordValue): ReleaseSourceVector {
  exactKeys(value, [
    "schema", "authority", "workspaceId", "eventId", "audience", "version", "availability", "sources",
    "commonFingerprint", "audienceFingerprint", "fingerprint",
  ]);
  if (value.schema !== SOURCE_VECTOR_SCHEMA) fail("INVALID_SCHEMA", "The persisted source-vector schema is unsupported.");
  if (value.authority !== TRUSTED_LOADER_AUTHORITY) fail("CALLER_AUTHORITY_FORBIDDEN", "The persisted source-vector authority is invalid.");
  const workspaceId = releaseIdentifier(value.workspaceId, "workspaceId");
  const eventId = releaseIdentifier(value.eventId, "eventId");
  const audience = releaseAudience(value.audience);
  const version = releaseVersion(value.version, "vector version");
  if (value.availability !== "AVAILABLE" && value.availability !== "UNAVAILABLE") fail("INVALID_INPUT", "The persisted source availability is invalid.");
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > MAX_SOURCE_RECORDS) {
    fail("LIMIT_EXCEEDED", "A persisted source vector must contain a bounded non-empty source set.");
  }
  const sources = value.sources.map((source) => normalizeSourceRecordSnapshot(source, true));
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.sourceId)) fail("DUPLICATE_SOURCE", "A persisted source vector contains a duplicate source.");
    ids.add(source.sourceId);
    if (!allowedScopes(audience).includes(source.scope)) fail("CROSS_AUDIENCE_LEAKAGE", "A persisted vector crosses its exact audience.");
  }
  return buildVector(
    workspaceId,
    eventId,
    audience,
    version,
    sources,
    value.fingerprint,
    value.commonFingerprint,
    value.audienceFingerprint,
    value.availability,
  );
}

function snapshotVectorInput(value: unknown): RecordValue {
  const persistedOverhead = 4096;
  const snapshot = snapshotRecord(value, MAX_VECTOR_BYTES + persistedOverhead, "A source vector");
  if (byteLength(snapshot) > MAX_VECTOR_BYTES + persistedOverhead) fail("VECTOR_TOO_LARGE", "The source-vector input exceeds its bounded size.");
  return snapshot;
}

export function createSourceVector(input: SourceVectorDraft): ReleaseSourceVector {
  return normalizeVectorDraftSnapshot(snapshotVectorInput(input));
}

/** Rehydrate persisted JSON or load a draft while fixing authority at this trusted boundary. */
export function loadTrustedSourceVector(
  input: SourceVectorDraft | ReleaseSourceVector,
  expected?: SourceVectorExpectation,
): ReleaseSourceVector {
  const snapshot = snapshotVectorInput(input);
  const vector = hasOwn(snapshot, "authority")
    ? normalizePersistedVectorSnapshot(snapshot)
    : normalizeVectorDraftSnapshot(snapshot);
  if (expected) assertVectorExpectation(vector, expected);
  return vector;
}

export function loadPersistedSourceVector(input: unknown, expected?: SourceVectorExpectation): ReleaseSourceVector {
  const vector = normalizePersistedVectorSnapshot(snapshotVectorInput(input));
  if (expected) assertVectorExpectation(vector, expected);
  return vector;
}

export const loadTrustedReleaseSourceVector = loadTrustedSourceVector;
export const rehydrateReleaseSourceVector = loadPersistedSourceVector;
export const loadPersistedReleaseSourceVector = loadPersistedSourceVector;

/** Select a safe audience projection; OPERATOR records are never selected for PUBLIC. */
export function selectAudienceSourceVector(input: {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly audience: ReleaseAudience;
  readonly version: number;
  readonly sources: readonly SourceRecordInput[];
}): ReleaseSourceVector {
  const value = snapshotRecord(input, MAX_RELEASE_TWIN_BYTES * 2, "An audience source-vector request");
  rejectControlPlaneFields(value);
  exactKeys(value, ["workspaceId", "eventId", "audience", "version", "sources"]);
  const workspaceId = releaseIdentifier(value.workspaceId, "workspaceId");
  const eventId = releaseIdentifier(value.eventId, "eventId");
  const audience = releaseAudience(value.audience);
  const version = releaseVersion(value.version, "vector version");
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > MAX_SOURCE_RECORDS) {
    fail("LIMIT_EXCEEDED", "A source corpus must contain a bounded non-empty source set.");
  }
  const normalized = value.sources.map((source) => normalizeSourceRecordSnapshot(source, false));
  const ids = new Set<string>();
  for (const source of normalized) {
    if (ids.has(source.sourceId)) fail("DUPLICATE_SOURCE", "A source corpus contains a duplicate source.");
    ids.add(source.sourceId);
  }
  const selected = normalized.filter((source) => source.scope === "COMMON" || source.scope === audience);
  if (selected.length === 0) fail("SOURCE_UNAVAILABLE", "The requested audience has no known source vector.");
  return buildVector(workspaceId, eventId, audience, version, selected);
}

export const buildAudienceSourceVector = selectAudienceSourceVector;

export function assertVectorExpectation(vectorInput: ReleaseSourceVector, expectedInput: SourceVectorExpectation): void {
  const vector = verifySourceVector(vectorInput);
  const expected = snapshotRecord(expectedInput, 4096, "A source-vector expectation");
  rejectControlPlaneFields(expected);
  exactKeys(expected, ["workspaceId", "eventId", "audience", "version", "fingerprint"], ["commonFingerprint"]);
  if (vector.workspaceId !== releaseIdentifier(expected.workspaceId, "expected workspaceId") || vector.eventId !== releaseIdentifier(expected.eventId, "expected eventId")) {
    fail("SCOPE_MISMATCH", "The source vector does not match the exact workspace/event scope.");
  }
  if (vector.audience !== releaseAudience(expected.audience)) fail("AUDIENCE_MISMATCH", "The source vector does not match the exact audience.");
  if (vector.version !== releaseVersion(expected.version, "expected version")) fail("VERSION_MISMATCH", "The source vector does not match the exact version.");
  if (vector.fingerprint !== fingerprint(expected.fingerprint, "expected fingerprint")) fail("FINGERPRINT_MISMATCH", "The source vector does not match the exact fingerprint.");
  if (expected.commonFingerprint !== undefined && vector.commonFingerprint !== fingerprint(expected.commonFingerprint, "expected common fingerprint")) {
    fail("COMMON_FINGERPRINT_MISMATCH", "The source vector does not match the exact common fingerprint.");
  }
}

/** Deterministic integrity verification with no process-local identity provenance. */
export function verifySourceVector(value: unknown): ReleaseSourceVector {
  return normalizePersistedVectorSnapshot(snapshotVectorInput(value));
}

export function sourceVectorFingerprint(vector: ReleaseSourceVector): string {
  return verifySourceVector(vector).fingerprint;
}

export function isOperatorFieldAllowlisted(field: string): boolean {
  return OPERATOR_FIELD_ALLOWLIST.includes(field as (typeof OPERATOR_FIELD_ALLOWLIST)[number]);
}

export function assertFieldDecisionShape(valueInput: unknown): FieldDecisionInput {
  const value = snapshotRecord(valueInput, 2048, "A field decision");
  rejectControlPlaneFields(value);
  exactKeys(value, ["sourceId", "field", "decision", "reason"]);
  const sourceId = releaseIdentifier(value.sourceId, "decision sourceId");
  const field = releaseFieldName(value.field);
  if (value.decision !== "INCLUDE" && value.decision !== "REDACT" && value.decision !== "OMIT") {
    fail("INVALID_INPUT", "The field decision is invalid.");
  }
  if (typeof value.reason !== "string" || value.reason.length > MAX_REASON_LENGTH || CONTROL_CHARACTERS.test(value.reason)) {
    fail("INVALID_INPUT", "The field-decision reason is invalid.");
  }
  const reason = value.reason;
  if (reason.trim().length === 0) {
    fail(value.decision === "INCLUDE" ? "INCLUDE_REASON_REQUIRED" : "REDACTION_REASON_REQUIRED", "Every field decision requires a reason.");
  }
  return { sourceId, field, decision: value.decision, reason };
}

export function sourceRecordsByField(vectorInput: ReleaseSourceVector): Map<string, { readonly source: ReleaseSourceRecord; readonly field: JsonValue; readonly family: DriftFamily }> {
  const vector = verifySourceVector(vectorInput);
  const result = new Map<string, { readonly source: ReleaseSourceRecord; readonly field: JsonValue; readonly family: DriftFamily }>();
  for (const source of vector.sources) {
    for (const field of source.fields) {
      if (result.has(field.field)) fail("DUPLICATE_FIELD", "The audience source vector contains duplicate field names.");
      result.set(field.field, { source, field: field.value, family: field.family });
    }
  }
  return result;
}

export function assertSameScope(left: { readonly workspaceId: string; readonly eventId: string }, right: { readonly workspaceId: string; readonly eventId: string }): void {
  if (left.workspaceId !== right.workspaceId || left.eventId !== right.eventId) fail("SCOPE_MISMATCH", "Release inputs must share the exact workspace/event scope.");
}

export function assertSameAudience(left: { readonly audience: ReleaseAudience }, right: { readonly audience: ReleaseAudience }): void {
  if (left.audience !== right.audience) fail("AUDIENCE_MISMATCH", "Release inputs must share the exact audience.");
}

export function assertExpectedVersion(actual: number, expected: number): void {
  if (actual !== expected) fail("VERSION_MISMATCH", "Release inputs must share the exact version.");
}

export function assertCanonicalManifestSize(value: unknown): void {
  if (byteLength(snapshotPlainData(value, { maxBytes: MAX_VECTOR_BYTES * 2 })) > MAX_VECTOR_BYTES) {
    fail("VECTOR_TOO_LARGE", "The release input exceeds the bounded canonical size.");
  }
}

export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT.test(value);
}

export function sourceRecordBasisForComparison(source: ReleaseSourceRecord): unknown {
  return sourceBasis(source);
}

export function sourceVectorBasisForComparison(vector: ReleaseSourceVector): unknown {
  const trusted = verifySourceVector(vector);
  return vectorBasis({
    schema: trusted.schema,
    workspaceId: trusted.workspaceId,
    eventId: trusted.eventId,
    audience: trusted.audience,
    version: trusted.version,
    availability: trusted.availability,
    sources: trusted.sources,
    commonFingerprint: trusted.commonFingerprint,
    audienceFingerprint: trusted.audienceFingerprint,
  });
}

export function errorCode(error: unknown): string | null {
  if (error instanceof OperatorReleaseCoreError) return error.code;
  if (error !== null && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return null;
}
