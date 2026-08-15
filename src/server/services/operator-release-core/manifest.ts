import {
  MAX_DECISIONS_PER_MANIFEST,
  MAX_RELEASE_MANIFEST_BYTES,
  MAX_RELEASE_TWIN_BYTES,
  OPERATOR_FIELD_ALLOWLIST,
  RELEASE_MANIFEST_SCHEMA,
  SOURCE_VECTOR_SCHEMA,
  TRUSTED_LOADER_AUTHORITY,
  type FieldDecision,
  type FieldDecisionInput,
  type IncludedField,
  type RedactedField,
  type ReleaseAudience,
  type ReleaseManifest,
  type ReleaseManifestExpectation,
  type ReleaseManifestInput,
  type ReleaseSourceVector,
  type SourceVectorExpectation,
  type SupersessionLink,
} from "./contracts";
import { byteLength, canonicalJson, cloneAndFreeze, fingerprintOf, snapshotPlainData, sortCodePoints } from "./canonical";
import { fail } from "./errors";
import {
  assertExpectedVersion,
  assertFieldDecisionShape,
  assertSameAudience,
  assertSameScope,
  assertVectorExpectation,
  isFingerprint,
  isOperatorFieldAllowlisted,
  normalizeReleaseFieldValue,
  releaseAudience,
  releaseFamily,
  releaseFieldName,
  releaseIdentifier,
  releaseVersion,
  sourceRecordsByField,
  verifySourceVector,
} from "./loader";

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

function exactKeys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) {
    fail("NON_CANONICAL_INPUT", "The release manifest has an unsupported object field.");
  }
  for (const key of required) {
    if (!hasOwn(value, key)) fail("NON_CANONICAL_INPUT", "The release manifest is missing a required object field.");
  }
}

function rejectCallerAuthority(value: RecordValue): void {
  if (hasOwn(value, "sourceAuthority") || hasOwn(value, "authority")) {
    fail("CALLER_AUTHORITY_FORBIDDEN", "Authority is fixed by the trusted persistence loader.");
  }
  if (hasOwn(value, "action") || hasOwn(value, "provider")) {
    fail("FORBIDDEN_FIELD", "Action and provider fields are outside this pure release core.");
  }
}

function fingerprint(value: unknown, label: string): string {
  if (!isFingerprint(value)) fail("INVALID_INPUT", `${label} is invalid.`);
  return value;
}

function supersession(value: unknown, releaseId: string): SupersessionLink | null {
  if (value === null) return null;
  if (!isRecord(value)) fail("SUPERSESSION_INVALID", "A supersession link must be an object or null.");
  rejectCallerAuthority(value);
  exactKeys(value, ["releaseId", "fingerprint"]);
  const targetId = releaseIdentifier(value.releaseId, "superseded releaseId");
  if (targetId === releaseId) fail("SUPERSESSION_INVALID", "A release cannot supersede itself.");
  return { releaseId: targetId, fingerprint: fingerprint(value.fingerprint, "superseded release fingerprint") };
}

function ensureManifestProjectionIsConsistent(
  decisions: readonly FieldDecision[],
  includedFields: readonly IncludedField[],
  redactedFields: readonly RedactedField[],
): void {
  if (decisions.length === 0 || includedFields.length === 0) {
    fail("INCOMPLETE_PROJECTION", "A release projection must contain an explicit visible field.");
  }
  const decisionByField = new Map<string, FieldDecision>();
  for (const decision of decisions) {
    if (decisionByField.has(decision.field)) fail("DUPLICATE_FIELD", "A release manifest has duplicate field decisions.");
    decisionByField.set(decision.field, decision);
  }
  const seenOutput = new Set<string>();
  for (const field of includedFields) {
    if (seenOutput.has(field.field)) fail("DUPLICATE_FIELD", "A release manifest has duplicate included fields.");
    seenOutput.add(field.field);
    const decision = decisionByField.get(field.field);
    if (!decision || decision.decision !== "INCLUDE" || decision.sourceId !== field.sourceId || decision.family !== field.family) {
      fail("INCOMPLETE_PROJECTION", "Included fields do not match their explicit decisions.");
    }
  }
  for (const field of redactedFields) {
    if (seenOutput.has(field.field)) fail("DUPLICATE_FIELD", "A field appears in both included and redacted output.");
    seenOutput.add(field.field);
    const decision = decisionByField.get(field.field);
    if (!decision || decision.decision !== field.decision || decision.sourceId !== field.sourceId || decision.family !== field.family || decision.reason !== field.reason) {
      fail("INCOMPLETE_PROJECTION", "Redacted fields do not match their explicit decisions.");
    }
  }
  if (seenOutput.size !== decisions.length) fail("INCOMPLETE_PROJECTION", "Every field must have an explicit projection decision.");
}

function assertAudienceFieldPolicy(
  audienceValue: ReleaseAudience,
  field: { readonly field: string; readonly sourceScope?: string; readonly family: string },
  decision: FieldDecisionInput,
): void {
  if (audienceValue === "PUBLIC" && (
    field.sourceScope === "OPERATOR" || field.family === "OPERATOR_CUE" || field.family === "CONTACT" || field.family === "PRIVATE_ARTIFACT"
  )) {
    fail("CROSS_AUDIENCE_LEAKAGE", "Operator-only, contact, and private facts cannot enter a public manifest.");
  }
  if (decision.decision === "INCLUDE" && audienceValue === "OPERATOR" && (field.sourceScope === "OPERATOR" || field.family === "OPERATOR_CUE")) {
    if (field.family !== "OPERATOR_CUE" || !OPERATOR_FIELD_ALLOWLIST.includes(decision.field as (typeof OPERATOR_FIELD_ALLOWLIST)[number]) || !isOperatorFieldAllowlisted(decision.field)) {
      fail("FIELD_NOT_ALLOWLISTED", "Only allowlisted operator cues may enter an operator manifest.");
    }
  }
  if (decision.decision === "INCLUDE" && (field.family === "CONTACT" || field.family === "PRIVATE_ARTIFACT")) {
    fail("FIELD_NOT_ALLOWLISTED", "Contact and private-artifact fields are not includable in this release core.");
  }
}

function manifestBasis(manifest: Omit<ReleaseManifest, "fingerprint">): Omit<ReleaseManifest, "fingerprint"> {
  return {
    schema: manifest.schema,
    authority: manifest.authority,
    releaseId: manifest.releaseId,
    workspaceId: manifest.workspaceId,
    eventId: manifest.eventId,
    audience: manifest.audience,
    version: manifest.version,
    sourceVectorFingerprint: manifest.sourceVectorFingerprint,
    commonFingerprint: manifest.commonFingerprint,
    decisions: manifest.decisions,
    includedFields: manifest.includedFields,
    redactedFields: manifest.redactedFields,
    supersedes: manifest.supersedes,
  };
}

export function createReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  const value = snapshotRecord(input, MAX_RELEASE_TWIN_BYTES, "A release manifest input");
  if (byteLength(value) > MAX_RELEASE_TWIN_BYTES) fail("MANIFEST_TOO_LARGE", "The release manifest input exceeds its bounded size.");
  rejectCallerAuthority(value);
  exactKeys(value, ["workspaceId", "eventId", "audience", "releaseId", "sourceVector", "decisions"], ["supersedes", "expected"]);
  const workspaceId = releaseIdentifier(value.workspaceId, "workspaceId");
  const eventId = releaseIdentifier(value.eventId, "eventId");
  const audienceValue = releaseAudience(value.audience);
  const releaseId = releaseIdentifier(value.releaseId, "releaseId");
  const sourceVector = verifySourceVector(value.sourceVector);
  assertSameScope({ workspaceId, eventId }, sourceVector);
  assertSameAudience({ audience: audienceValue }, sourceVector);
  if (sourceVector.availability !== "AVAILABLE") fail("SOURCE_UNAVAILABLE", "Unavailable source vectors cannot produce release manifests.");
  if (!Array.isArray(value.decisions) || value.decisions.length === 0 || value.decisions.length > MAX_DECISIONS_PER_MANIFEST) {
    fail("LIMIT_EXCEEDED", "A release manifest requires a bounded non-empty decision set.");
  }
  if (value.expected !== undefined) assertVectorExpectation(sourceVector, value.expected as unknown as SourceVectorExpectation);
  const decisions = value.decisions.map(assertFieldDecisionShape);
  const fieldsByName = sourceRecordsByField(sourceVector);
  if (fieldsByName.size === 0 || decisions.length !== fieldsByName.size) {
    fail("INCOMPLETE_PROJECTION", "Every non-empty source field requires exactly one explicit decision.");
  }
  const seenDecisions = new Set<string>();
  const includedFields: IncludedField[] = [];
  const redactedFields: RedactedField[] = [];
  const enrichedDecisions: FieldDecision[] = [];
  for (const decision of decisions) {
    const key = `${decision.sourceId}\u0000${decision.field}`;
    if (seenDecisions.has(key)) fail("DUPLICATE_FIELD", "A release manifest has duplicate or conflicting field decisions.");
    seenDecisions.add(key);
    const sourceField = fieldsByName.get(decision.field);
    if (!sourceField || sourceField.source.sourceId !== decision.sourceId) fail("FIELD_NOT_FOUND", "A field decision does not bind to an exact source field.");
    assertAudienceFieldPolicy(audienceValue, {
      field: decision.field,
      sourceScope: sourceField.source.scope,
      family: sourceField.family,
    }, decision);
    const enriched = { ...decision, family: sourceField.family } satisfies FieldDecision;
    enrichedDecisions.push(enriched);
    if (decision.decision === "INCLUDE") {
      includedFields.push({
        field: decision.field,
        value: sourceField.field,
        sourceId: decision.sourceId,
        family: sourceField.family,
      });
    } else {
      redactedFields.push({
        field: decision.field,
        sourceId: decision.sourceId,
        family: sourceField.family,
        decision: decision.decision,
        reason: decision.reason,
      });
    }
  }
  if (seenDecisions.size !== fieldsByName.size) fail("INCOMPLETE_PROJECTION", "The release manifest has missing source-field decisions.");
  const sortedDecisions = sortCodePoints(enrichedDecisions, (decision) => `${decision.field}\u0000${decision.sourceId}`);
  const sortedIncluded = sortCodePoints(includedFields, (field) => field.field);
  const sortedRedacted = sortCodePoints(redactedFields, (field) => field.field);
  const supersedes = hasOwn(value, "supersedes") ? supersession(value.supersedes, releaseId) : null;
  const basis = manifestBasis({
    schema: RELEASE_MANIFEST_SCHEMA,
    authority: TRUSTED_LOADER_AUTHORITY,
    releaseId,
    workspaceId,
    eventId,
    audience: audienceValue,
    version: sourceVector.version,
    sourceVectorFingerprint: sourceVector.fingerprint,
    commonFingerprint: sourceVector.commonFingerprint,
    decisions: sortedDecisions,
    includedFields: sortedIncluded,
    redactedFields: sortedRedacted,
    supersedes,
  });
  ensureManifestProjectionIsConsistent(basis.decisions, basis.includedFields, basis.redactedFields);
  if (byteLength(basis) > MAX_RELEASE_MANIFEST_BYTES) fail("MANIFEST_TOO_LARGE", "The release manifest exceeds its bounded size.");
  return cloneAndFreeze({ ...basis, fingerprint: fingerprintOf(basis) });
}

function persistedDecision(value: unknown): FieldDecision {
  if (!isRecord(value)) fail("NON_CANONICAL_INPUT", "A persisted field decision must be an object.");
  exactKeys(value, ["sourceId", "field", "decision", "reason", "family"]);
  const decision = assertFieldDecisionShape({
    sourceId: value.sourceId,
    field: value.field,
    decision: value.decision,
    reason: value.reason,
  });
  return { ...decision, family: releaseFamily(value.family) };
}

function persistedIncludedField(value: unknown): IncludedField {
  if (!isRecord(value)) fail("NON_CANONICAL_INPUT", "A persisted included field must be an object.");
  exactKeys(value, ["field", "value", "sourceId", "family"]);
  const family = releaseFamily(value.family);
  const fieldValue = normalizeReleaseFieldValue(value.value, family);
  return {
    field: releaseFieldName(value.field),
    value: fieldValue,
    sourceId: releaseIdentifier(value.sourceId, "included sourceId"),
    family,
  };
}

function persistedRedactedField(value: unknown): RedactedField {
  if (!isRecord(value)) fail("NON_CANONICAL_INPUT", "A persisted redacted field must be an object.");
  exactKeys(value, ["field", "sourceId", "family", "decision", "reason"]);
  const decision = assertFieldDecisionShape({
    sourceId: value.sourceId,
    field: value.field,
    decision: value.decision,
    reason: value.reason,
  });
  if (decision.decision === "INCLUDE") fail("INCOMPLETE_PROJECTION", "A redacted field cannot carry an include decision.");
  return { ...decision, family: releaseFamily(value.family), decision: decision.decision };
}

function normalizePersistedManifestSnapshot(value: RecordValue): ReleaseManifest {
  exactKeys(value, [
    "schema", "authority", "releaseId", "workspaceId", "eventId", "audience", "version",
    "sourceVectorFingerprint", "commonFingerprint", "decisions", "includedFields", "redactedFields",
    "supersedes", "fingerprint",
  ]);
  if (value.schema !== RELEASE_MANIFEST_SCHEMA) fail("INVALID_SCHEMA", "The persisted release-manifest schema is unsupported.");
  if (value.authority !== TRUSTED_LOADER_AUTHORITY) fail("CALLER_AUTHORITY_FORBIDDEN", "The persisted release-manifest authority is invalid.");
  const releaseId = releaseIdentifier(value.releaseId, "releaseId");
  const workspaceId = releaseIdentifier(value.workspaceId, "workspaceId");
  const eventId = releaseIdentifier(value.eventId, "eventId");
  const audienceValue = releaseAudience(value.audience);
  const version = releaseVersion(value.version, "manifest version");
  if (!Array.isArray(value.decisions) || value.decisions.length === 0 || value.decisions.length > MAX_DECISIONS_PER_MANIFEST) {
    fail("LIMIT_EXCEEDED", "A persisted manifest requires a bounded non-empty decision set.");
  }
  if (!Array.isArray(value.includedFields) || value.includedFields.length === 0 || value.includedFields.length > MAX_DECISIONS_PER_MANIFEST) {
    fail("INCOMPLETE_PROJECTION", "A persisted manifest requires a bounded non-empty visible projection.");
  }
  if (!Array.isArray(value.redactedFields) || value.redactedFields.length > MAX_DECISIONS_PER_MANIFEST) {
    fail("LIMIT_EXCEEDED", "A persisted manifest has too many redacted fields.");
  }
  const decisions = sortCodePoints(value.decisions.map(persistedDecision), (decision) => `${decision.field}\u0000${decision.sourceId}`);
  const includedFields = sortCodePoints(value.includedFields.map(persistedIncludedField), (field) => field.field);
  const redactedFields = sortCodePoints(value.redactedFields.map(persistedRedactedField), (field) => field.field);
  for (const decision of decisions) {
    assertAudienceFieldPolicy(audienceValue, { field: decision.field, family: decision.family }, decision);
  }
  const basis = manifestBasis({
    schema: RELEASE_MANIFEST_SCHEMA,
    authority: TRUSTED_LOADER_AUTHORITY,
    releaseId,
    workspaceId,
    eventId,
    audience: audienceValue,
    version,
    sourceVectorFingerprint: fingerprint(value.sourceVectorFingerprint, "source-vector fingerprint"),
    commonFingerprint: fingerprint(value.commonFingerprint, "common fingerprint"),
    decisions,
    includedFields,
    redactedFields,
    supersedes: supersession(value.supersedes, releaseId),
  });
  ensureManifestProjectionIsConsistent(basis.decisions, basis.includedFields, basis.redactedFields);
  if (byteLength(basis) > MAX_RELEASE_MANIFEST_BYTES) fail("MANIFEST_TOO_LARGE", "The persisted release manifest exceeds its bounded size.");
  const computedFingerprint = fingerprintOf(basis);
  if (fingerprint(value.fingerprint, "manifest fingerprint") !== computedFingerprint) {
    fail("FINGERPRINT_MISMATCH", "The persisted release-manifest fingerprint does not match its exact canonical content.");
  }
  return cloneAndFreeze({ ...basis, fingerprint: computedFingerprint });
}

function snapshotPersistedManifest(value: unknown): RecordValue {
  const persistedOverhead = 4096;
  const snapshot = snapshotRecord(value, MAX_RELEASE_MANIFEST_BYTES + persistedOverhead, "A persisted release manifest");
  if (byteLength(snapshot) > MAX_RELEASE_MANIFEST_BYTES + persistedOverhead) fail("MANIFEST_TOO_LARGE", "The persisted release-manifest input exceeds its bounded size.");
  return snapshot;
}

export function assertManifestExpectation(manifestInput: ReleaseManifest, expectedInput: ReleaseManifestExpectation): void {
  const manifest = verifyReleaseManifest(manifestInput);
  const expected = snapshotRecord(expectedInput, 4096, "A release-manifest expectation");
  rejectCallerAuthority(expected);
  exactKeys(expected, ["workspaceId", "eventId", "audience", "version", "releaseId", "fingerprint"], ["sourceVectorFingerprint", "commonFingerprint"]);
  if (manifest.workspaceId !== releaseIdentifier(expected.workspaceId, "expected workspaceId") ||
      manifest.eventId !== releaseIdentifier(expected.eventId, "expected eventId")) {
    fail("SCOPE_MISMATCH", "The release manifest does not match the exact workspace/event scope.");
  }
  if (manifest.audience !== releaseAudience(expected.audience)) fail("AUDIENCE_MISMATCH", "The release manifest does not match the exact audience.");
  if (manifest.version !== releaseVersion(expected.version, "expected manifest version")) fail("VERSION_MISMATCH", "The release manifest does not match the exact version.");
  if (manifest.releaseId !== releaseIdentifier(expected.releaseId, "expected releaseId")) fail("FINGERPRINT_MISMATCH", "The release manifest does not match the exact release identity.");
  if (manifest.fingerprint !== fingerprint(expected.fingerprint, "expected manifest fingerprint")) fail("FINGERPRINT_MISMATCH", "The release manifest does not match the externally expected fingerprint.");
  if (expected.sourceVectorFingerprint !== undefined && manifest.sourceVectorFingerprint !== fingerprint(expected.sourceVectorFingerprint, "expected source-vector fingerprint")) {
    fail("FINGERPRINT_MISMATCH", "The release manifest does not match the expected source-vector fingerprint.");
  }
  if (expected.commonFingerprint !== undefined && manifest.commonFingerprint !== fingerprint(expected.commonFingerprint, "expected common fingerprint")) {
    fail("COMMON_FINGERPRINT_MISMATCH", "The release manifest does not match the expected common fingerprint.");
  }
}

/** Rehydrate exact persisted JSON and optionally bind it to a vector and/or external expectation. */
export function loadTrustedReleaseManifest(
  input: unknown,
  binding?: ReleaseSourceVector | ReleaseManifestExpectation,
  expected?: ReleaseManifestExpectation,
): ReleaseManifest {
  const manifest = normalizePersistedManifestSnapshot(snapshotPersistedManifest(input));
  if (binding) {
    const bindingSnapshot = snapshotPlainData(binding, { maxBytes: MAX_RELEASE_TWIN_BYTES });
    if (isRecord(bindingSnapshot) && bindingSnapshot.schema === SOURCE_VECTOR_SCHEMA) {
      assertManifestMatchesVector(manifest, bindingSnapshot as unknown as ReleaseSourceVector, {
        workspaceId: manifest.workspaceId,
        eventId: manifest.eventId,
        audience: manifest.audience,
        version: manifest.version,
      });
    } else {
      assertManifestExpectation(manifest, bindingSnapshot as unknown as ReleaseManifestExpectation);
    }
  }
  if (expected) assertManifestExpectation(manifest, expected);
  return manifest;
}

export const loadPersistedReleaseManifest = loadTrustedReleaseManifest;
export const rehydrateReleaseManifest = loadTrustedReleaseManifest;
export const loadTrustedManifest = loadTrustedReleaseManifest;
export const loadPersistedManifest = loadTrustedReleaseManifest;

/** Deterministic integrity verification; no process-local identity brand is used. */
export function verifyReleaseManifest(value: unknown): ReleaseManifest {
  return normalizePersistedManifestSnapshot(snapshotPersistedManifest(value));
}

export const buildReleaseManifest = createReleaseManifest;

export function assertManifestMatchesVector(
  manifestInput: ReleaseManifest,
  vectorInput: ReleaseSourceVector,
  expected: { readonly workspaceId: string; readonly eventId: string; readonly audience: ReleaseAudience; readonly version: number },
): void {
  const trustedManifest = verifyReleaseManifest(manifestInput);
  const trustedVector = verifySourceVector(vectorInput);
  assertSameScope(trustedManifest, expected);
  assertSameAudience(trustedManifest, expected);
  assertExpectedVersion(trustedManifest.version, expected.version);
  assertSameScope(trustedVector, expected);
  assertSameAudience(trustedVector, expected);
  assertExpectedVersion(trustedVector.version, expected.version);
  if (trustedManifest.sourceVectorFingerprint !== trustedVector.fingerprint) fail("FINGERPRINT_MISMATCH", "The release manifest is not bound to the exact source vector.");
  if (trustedManifest.commonFingerprint !== trustedVector.commonFingerprint) fail("COMMON_FINGERPRINT_MISMATCH", "The release manifest is not bound to the exact common source vector.");
  const fieldsByName = sourceRecordsByField(trustedVector);
  if (fieldsByName.size === 0 || trustedManifest.decisions.length !== fieldsByName.size || trustedManifest.includedFields.length === 0) {
    fail("INCOMPLETE_PROJECTION", "The release manifest is incomplete for its non-empty source vector.");
  }
  const includedByField = new Map(trustedManifest.includedFields.map((field) => [field.field, field]));
  const redactedByField = new Map(trustedManifest.redactedFields.map((field) => [field.field, field]));
  for (const decision of trustedManifest.decisions) {
    const sourceField = fieldsByName.get(decision.field);
    if (!sourceField || sourceField.source.sourceId !== decision.sourceId || sourceField.family !== decision.family) {
      fail("INCOMPLETE_PROJECTION", "The release manifest does not cover the exact source vector.");
    }
    assertAudienceFieldPolicy(trustedManifest.audience, {
      field: decision.field,
      sourceScope: sourceField.source.scope,
      family: sourceField.family,
    }, decision);
    if (decision.decision === "INCLUDE") {
      const included = includedByField.get(decision.field);
      if (!included || canonicalJson(included.value) !== canonicalJson(sourceField.field)) {
        fail("FINGERPRINT_MISMATCH", "The included field value is not the exact trusted source value.");
      }
    } else {
      const redacted = redactedByField.get(decision.field);
      if (!redacted || redacted.decision !== decision.decision || redacted.reason !== decision.reason) {
        fail("INCOMPLETE_PROJECTION", "The redaction decision is not the exact trusted source decision.");
      }
    }
  }
}

export function releaseManifestFingerprint(manifest: ReleaseManifest): string {
  return verifyReleaseManifest(manifest).fingerprint;
}
