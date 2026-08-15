import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export const NEAR_MISS_PROOF_SCHEMA = "near-miss-proof/v1" as const;
export const NEAR_MISS_PROOF_STATUS = "OBSERVED_NOT_RESERVED" as const;
export const NEAR_MISS_PROOF_FINGERPRINT_ALGORITHM = "sha256-canonical-json-v1" as const;

export const NEAR_MISS_DISPOSITIONS = ["CAPACITY_DISPLACED", "NEAR_MISS"] as const;
export type NearMissDisposition = (typeof NEAR_MISS_DISPOSITIONS)[number];

export type NearMissPurposeStatus = "AUTHORIZED" | "UNKNOWN" | "EXPIRED" | "WITHDRAWN";
export type NearMissRetentionStatus = "CURRENT" | "UNKNOWN" | "EXPIRED" | "WITHDRAWN";
export type NearMissCapacityStatus = "CURRENT" | "STALE" | "UNKNOWN";
export type NearMissEligibilityStatus = "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";
export type NearMissConflictStatus = "CLEAR" | "CONFLICTED" | "UNKNOWN";

export interface NearMissProposalLineage {
  readonly proposalId: string;
  readonly revisionId: string;
  readonly lineageId: string;
  readonly fingerprint: string;
}

export interface NearMissTargetCall {
  readonly callId: string;
  readonly versionId: string;
  readonly fingerprint: string;
}

export interface NearMissEvidenceScope {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly candidateId: string;
  readonly targetCallId: string;
  readonly targetCallVersionId: string;
  readonly purpose: string;
}

export interface NearMissPurposeAuthorization {
  readonly status: NearMissPurposeStatus;
  readonly purpose: string;
  readonly scope: NearMissEvidenceScope;
  readonly evaluatedAt: string;
  readonly expiresAt: string | null;
  readonly withdrawnAt: string | null;
  readonly fingerprint: string;
}

export interface NearMissRetentionEvidence {
  readonly status: NearMissRetentionStatus;
  readonly purpose: string;
  readonly scope: NearMissEvidenceScope;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly withdrawnAt: string | null;
  readonly fingerprint: string;
}

export interface NearMissCapacityReference {
  readonly status: NearMissCapacityStatus;
  readonly unitKind: string;
  readonly poolId: string;
  readonly versionId: string;
  readonly ledgerFingerprint: string;
}

export interface NearMissEligibilityEvidence {
  readonly status: NearMissEligibilityStatus;
  readonly current: boolean;
  readonly scope: NearMissEvidenceScope;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
}

export interface NearMissConflictEvidence {
  readonly status: NearMissConflictStatus;
  readonly current: boolean;
  readonly scope: NearMissEvidenceScope;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly conflictIds: readonly string[];
  readonly fingerprint: string;
}

export type NearMissPurposeAuthorizationInput = Omit<NearMissPurposeAuthorization, "fingerprint">;
export type NearMissRetentionEvidenceInput = Omit<NearMissRetentionEvidence, "fingerprint">;
export type NearMissEligibilityEvidenceInput = Omit<NearMissEligibilityEvidence, "fingerprint">;
export type NearMissConflictEvidenceInput = Omit<NearMissConflictEvidence, "fingerprint">;

export interface PriorSelectionReceiptEntry {
  readonly type: "SELECTION_RECEIPT";
  readonly receiptId: string;
  readonly candidateId: string;
  readonly disposition: NearMissDisposition;
  readonly proposalLineage: NearMissProposalLineage;
  readonly targetCall: NearMissTargetCall;
  readonly purpose: string;
  readonly scope: NearMissEvidenceScope;
  readonly purposeAuthorizationFingerprint: string;
  readonly retentionFingerprint: string;
  readonly capacity: NearMissCapacityReference;
  readonly eligibility: NearMissEligibilityEvidence;
  readonly conflicts: NearMissConflictEvidence;
}

export interface NearMissProofRequest {
  readonly candidateId: string;
  readonly purpose: string;
  readonly scope: NearMissEvidenceScope;
  readonly proposalLineage: NearMissProposalLineage;
  readonly targetCall: NearMissTargetCall;
  readonly purposeAuthorization: NearMissPurposeAuthorization;
  readonly retention: NearMissRetentionEvidence;
  readonly capacity: NearMissCapacityReference;
  readonly eligibility: NearMissEligibilityEvidence;
  readonly conflicts: NearMissConflictEvidence;
  readonly priorSelectionReceipts: readonly PriorSelectionReceiptEntry[];
  readonly evaluatedAt: string;
}

export interface NearMissProofEvidence {
  readonly receiptId: string | null;
  readonly purpose: string | null;
  readonly evaluatedAt: string | null;
  readonly scope: NearMissEvidenceScope | null;
  readonly proposalLineage: NearMissProposalLineage | null;
  readonly targetCall: NearMissTargetCall | null;
  readonly purposeAuthorizationFingerprint: string | null;
  readonly retentionFingerprint: string | null;
  readonly capacity: NearMissCapacityReference | null;
  readonly eligibilityFingerprint: string | null;
  readonly conflictFingerprint: string | null;
}

export interface NearMissProofResult {
  readonly schema: typeof NEAR_MISS_PROOF_SCHEMA;
  readonly status: typeof NEAR_MISS_PROOF_STATUS;
  readonly candidateId: string | null;
  readonly qualified: boolean;
  readonly blockers: readonly string[];
  readonly evidence: NearMissProofEvidence;
  readonly proofFingerprint: string;
}

export type NearMissReceipt = PriorSelectionReceiptEntry;
export type NearMissProof = NearMissProofResult;

export const NEAR_MISS_MAX_RECEIPTS = 128 as const;
export const NEAR_MISS_MAX_CONFLICTS = 64 as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PURPOSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,127}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const MAX_NEAR_MISS_SNAPSHOT_NODES = 16_384;
const FORBIDDEN_AUTHORITY_KEY = /^(?:authority|score|rank|ranking|selection|invitation|invite|contact|reservation|reserve|apply|promot)/iu;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class NearMissProofValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NearMissProofValidationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new NearMissProofValidationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (isProxy(value) || !isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface SnapshotState {
  readonly seen: Set<object>;
  nodes: number;
}

function snapshotJsonValue(
  value: unknown,
  path: string,
  depth = 0,
  state: SnapshotState = { seen: new Set<object>(), nodes: 0 },
): JsonValue {
  if (depth > 16) fail("NEAR_MISS_INPUT_DEPTH_EXCEEDED", `${path} exceeds the proof input depth bound.`);
  if (isProxy(value)) fail("NEAR_MISS_INPUT_PROXY_FORBIDDEN", `${path} must not contain Proxy values.`);
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object" || value === null) {
    fail("NEAR_MISS_INPUT_NOT_JSON", `${path} must contain JSON values only.`);
  }
  if (state.seen.has(value)) fail("NEAR_MISS_INPUT_CYCLE", `${path} contains a cycle.`);
  state.nodes += 1;
  if (state.nodes > MAX_NEAR_MISS_SNAPSHOT_NODES) {
    fail("NEAR_MISS_INPUT_NODE_LIMIT_EXCEEDED", `${path} exceeds the proof snapshot node bound.`);
  }
  state.seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) fail("NEAR_MISS_INPUT_NOT_JSON", `${path} must contain plain JSON arrays only.`);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_NEAR_MISS_SNAPSHOT_NODES) {
      fail("NEAR_MISS_INPUT_NOT_JSON", `${path} must contain a bounded plain JSON array.`);
    }
    const length = lengthDescriptor.value as number;
    const snapshot: JsonValue[] = new Array(length);
    for (const key of descriptorKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !ARRAY_INDEX_PATTERN.test(key) || Number(key) >= length) {
        fail("NEAR_MISS_INPUT_NOT_JSON", `${path} must contain plain JSON arrays only.`);
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("NEAR_MISS_INPUT_NOT_JSON", `${path} must not contain accessor properties.`);
      }
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("NEAR_MISS_INPUT_NOT_JSON", `${path} must not contain sparse arrays or accessor properties.`);
      }
      Object.defineProperty(snapshot, String(index), {
        value: snapshotJsonValue(descriptor.value, `${path}[${index}]`, depth + 1, state),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    state.seen.delete(value);
    return snapshot;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("NEAR_MISS_INPUT_NOT_JSON", `${path} must contain plain JSON objects only.`);
  }
  if (descriptorKeys.length > MAX_NEAR_MISS_SNAPSHOT_NODES) {
    fail("NEAR_MISS_INPUT_NODE_LIMIT_EXCEEDED", `${path} exceeds the proof snapshot key bound.`);
  }
  const snapshot = Object.create(null) as Record<string, JsonValue>;
  for (const key of descriptorKeys) {
    if (typeof key !== "string") fail("NEAR_MISS_KEY_INVALID", `${path} contains a non-JSON object key.`);
    if (key.length > 128 || /[\u0000-\u001f\u007f]/u.test(key)) {
      fail("NEAR_MISS_KEY_INVALID", `${path} contains an invalid key.`);
    }
    if (key === "toJSON") fail("NEAR_MISS_TO_JSON_FORBIDDEN", `${path}.toJSON is forbidden in proof data.`);
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail("NEAR_MISS_INPUT_NOT_JSON", `${path} must not contain accessor properties.`);
    }
    Object.defineProperty(snapshot, key, {
      value: snapshotJsonValue(descriptor.value, `${path}.${key}`, depth + 1, state),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  state.seen.delete(value);
  return snapshot;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const objectValue = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(objectValue[key]!)}`).join(",")}}`;
}

export function nearMissCanonicalJson(value: JsonValue): string {
  return canonicalize(snapshotJsonValue(value, "$canonical"));
}

export function nearMissFingerprintOf(value: JsonValue): string {
  return createHash("sha256").update(nearMissCanonicalJson(value), "utf8").digest("hex");
}

export const proofFingerprintOf = nearMissFingerprintOf;

function cloneJson<T extends JsonValue>(value: T): T {
  return snapshotJsonValue(value, "$clone") as T;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    if (Array.isArray(value)) {
      for (const child of value) freezeDeep(child);
    } else {
      for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    }
  }
  return value;
}

function token(value: unknown): string | null {
  return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : null;
}

function hash(value: unknown): string | null {
  return typeof value === "string" && HASH_PATTERN.test(value) ? value : null;
}

function purposeText(value: unknown): string | null {
  return typeof value === "string" && PURPOSE_PATTERN.test(value) ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  const suppliedCanonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  return canonical === suppliedCanonical ? canonical : null;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  const normalized = timestamp(value);
  return normalized ?? undefined;
}

function firstValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function normalizeScope(value: unknown): NearMissEvidenceScope | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    "workspaceId", "eventId", "candidateId", "targetCallId", "targetCallVersionId", "purpose",
  ])) return null;
  const workspaceId = token(value.workspaceId);
  const eventId = token(value.eventId);
  const candidateId = token(value.candidateId);
  const targetCallId = token(value.targetCallId);
  const targetCallVersionId = token(value.targetCallVersionId);
  const purpose = purposeText(value.purpose);
  if (!workspaceId || !eventId || !candidateId || !targetCallId || !targetCallVersionId || !purpose) return null;
  return { workspaceId, eventId, candidateId, targetCallId, targetCallVersionId, purpose };
}

function normalizeLineage(value: unknown): NearMissProposalLineage | null {
  if (!isPlainRecord(value)) return null;
  const proposalId = token(firstValue(value, ["proposalId", "proposalReference"]));
  const revisionId = token(firstValue(value, ["revisionId", "proposalRevisionId", "versionId", "proposalVersionId", "version"]));
  const lineageId = token(firstValue(value, ["lineageId", "proposalLineageId", "id"]));
  const fingerprint = hash(firstValue(value, ["fingerprint", "proposalFingerprint", "proposalVersionFingerprint", "lineageFingerprint"]));
  if (!proposalId || !revisionId || !lineageId || !fingerprint) return null;
  return { proposalId, revisionId, lineageId, fingerprint };
}

function normalizeTargetCall(value: unknown): NearMissTargetCall | null {
  if (!isPlainRecord(value)) return null;
  const callId = token(firstValue(value, ["callId", "targetCallId", "id"]));
  const versionId = token(firstValue(value, ["versionId", "callVersionId", "targetCallVersionId", "version"]));
  const fingerprint = hash(firstValue(value, ["fingerprint", "callFingerprint", "targetCallFingerprint"]));
  if (!callId || !versionId || !fingerprint) return null;
  return { callId, versionId, fingerprint };
}

function compareJson(first: unknown, second: unknown): boolean {
  if (first === null || second === null || typeof first !== "object" || typeof second !== "object") return first === second;
  return nearMissCanonicalJson(first as JsonValue) === nearMissCanonicalJson(second as JsonValue);
}

function purposeAuthorizationBasis(value: NearMissPurposeAuthorizationInput): JsonValue {
  return { evidenceType: "PURPOSE_AUTHORIZATION", ...value } as unknown as JsonValue;
}

function retentionBasis(value: NearMissRetentionEvidenceInput): JsonValue {
  return { evidenceType: "RETENTION", ...value } as unknown as JsonValue;
}

function eligibilityBasis(value: NearMissEligibilityEvidenceInput): JsonValue {
  return { evidenceType: "ELIGIBILITY", ...value } as unknown as JsonValue;
}

function conflictBasis(value: NearMissConflictEvidenceInput): JsonValue {
  return { evidenceType: "CONFLICTS", ...value } as unknown as JsonValue;
}

function normalizePurposeAuthorizationFields(value: unknown): NearMissPurposeAuthorizationInput | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    "status", "purpose", "scope", "evaluatedAt", "expiresAt", "withdrawnAt", "fingerprint",
  ])) return null;
  if (value.status !== "AUTHORIZED" && value.status !== "UNKNOWN" && value.status !== "EXPIRED" && value.status !== "WITHDRAWN") return null;
  const purpose = purposeText(value.purpose);
  const scope = normalizeScope(value.scope);
  const evaluatedAt = timestamp(value.evaluatedAt);
  const expiresAt = nullableTimestamp(value.expiresAt);
  const withdrawnAt = nullableTimestamp(value.withdrawnAt);
  if (!purpose || !scope || !evaluatedAt || expiresAt === undefined || withdrawnAt === undefined) return null;
  return { status: value.status, purpose, scope, evaluatedAt, expiresAt, withdrawnAt };
}

function normalizeRetentionFields(value: unknown): NearMissRetentionEvidenceInput | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    "status", "purpose", "scope", "evaluatedAt", "expiresAt", "withdrawnAt", "fingerprint",
  ])) return null;
  if (value.status !== "CURRENT" && value.status !== "UNKNOWN" && value.status !== "EXPIRED" && value.status !== "WITHDRAWN") return null;
  const purpose = purposeText(value.purpose);
  const scope = normalizeScope(value.scope);
  const evaluatedAt = timestamp(value.evaluatedAt);
  const expiresAt = timestamp(value.expiresAt);
  const withdrawnAt = nullableTimestamp(value.withdrawnAt);
  if (!purpose || !scope || !evaluatedAt || !expiresAt || withdrawnAt === undefined) return null;
  return { status: value.status, purpose, scope, evaluatedAt, expiresAt, withdrawnAt };
}

function normalizeEligibilityFields(value: unknown): NearMissEligibilityEvidenceInput | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    "status", "current", "scope", "evaluatedAt", "expiresAt", "fingerprint",
  ])) return null;
  if (value.status !== "ELIGIBLE" && value.status !== "INELIGIBLE" && value.status !== "UNKNOWN") return null;
  if (typeof value.current !== "boolean") return null;
  const scope = normalizeScope(value.scope);
  const evaluatedAt = timestamp(value.evaluatedAt);
  const expiresAt = timestamp(value.expiresAt);
  if (!scope || !evaluatedAt || !expiresAt) return null;
  return { status: value.status, current: value.current, scope, evaluatedAt, expiresAt };
}

function normalizeConflictIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > NEAR_MISS_MAX_CONFLICTS) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const id = token(item);
      if (!id) return null;
      ids.push(id);
      continue;
    }
    if (isPlainRecord(item)) {
      const id = token(firstValue(item, ["id", "conflictId", "key"]));
      if (!id) return null;
      ids.push(id);
      continue;
    }
    return null;
  }
  return Object.freeze([...new Set(ids)].sort());
}

function normalizeConflictFields(value: unknown): NearMissConflictEvidenceInput | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    "status", "current", "scope", "evaluatedAt", "expiresAt", "conflictIds", "fingerprint",
  ])) return null;
  if (value.status !== "CLEAR" && value.status !== "CONFLICTED" && value.status !== "UNKNOWN") return null;
  if (typeof value.current !== "boolean") return null;
  const scope = normalizeScope(value.scope);
  const evaluatedAt = timestamp(value.evaluatedAt);
  const expiresAt = timestamp(value.expiresAt);
  const conflictIds = normalizeConflictIds(value.conflictIds);
  if (!scope || !evaluatedAt || !expiresAt || !conflictIds) return null;
  if (value.status === "CLEAR" && conflictIds.length > 0) return null;
  if (value.status === "CONFLICTED" && conflictIds.length === 0) return null;
  return { status: value.status, current: value.current, scope, evaluatedAt, expiresAt, conflictIds };
}

export function nearMissPurposeAuthorizationFingerprintOf(value: NearMissPurposeAuthorizationInput | unknown): string {
  const snapshot = snapshotJsonValue(value, "$purposeAuthorization");
  const fields = normalizePurposeAuthorizationFields(snapshot);
  if (!fields) fail("NEAR_MISS_PURPOSE_AUTHORIZATION_INVALID", "Purpose authorization evidence is invalid.");
  return nearMissFingerprintOf(purposeAuthorizationBasis(fields));
}

export function nearMissRetentionFingerprintOf(value: NearMissRetentionEvidenceInput | unknown): string {
  const snapshot = snapshotJsonValue(value, "$retention");
  const fields = normalizeRetentionFields(snapshot);
  if (!fields) fail("NEAR_MISS_RETENTION_INVALID", "Retention evidence is invalid.");
  return nearMissFingerprintOf(retentionBasis(fields));
}

export function nearMissEligibilityFingerprintOf(value: NearMissEligibilityEvidenceInput | unknown): string {
  const snapshot = snapshotJsonValue(value, "$eligibility");
  const fields = normalizeEligibilityFields(snapshot);
  if (!fields) fail("NEAR_MISS_ELIGIBILITY_INVALID", "Eligibility evidence is invalid.");
  return nearMissFingerprintOf(eligibilityBasis(fields));
}

export function nearMissConflictFingerprintOf(value: NearMissConflictEvidenceInput | unknown): string {
  const snapshot = snapshotJsonValue(value, "$conflicts");
  const fields = normalizeConflictFields(snapshot);
  if (!fields) fail("NEAR_MISS_CONFLICTS_INVALID", "Conflict evidence is invalid.");
  return nearMissFingerprintOf(conflictBasis(fields));
}

export function createNearMissPurposeAuthorization(value: NearMissPurposeAuthorizationInput | unknown): NearMissPurposeAuthorization {
  const snapshot = snapshotJsonValue(value, "$purposeAuthorization");
  const fields = normalizePurposeAuthorizationFields(snapshot);
  if (!fields) fail("NEAR_MISS_PURPOSE_AUTHORIZATION_INVALID", "Purpose authorization evidence is invalid.");
  return freezeDeep({ ...fields, fingerprint: nearMissFingerprintOf(purposeAuthorizationBasis(fields)) });
}

export function createNearMissRetentionEvidence(value: NearMissRetentionEvidenceInput | unknown): NearMissRetentionEvidence {
  const snapshot = snapshotJsonValue(value, "$retention");
  const fields = normalizeRetentionFields(snapshot);
  if (!fields) fail("NEAR_MISS_RETENTION_INVALID", "Retention evidence is invalid.");
  return freezeDeep({ ...fields, fingerprint: nearMissFingerprintOf(retentionBasis(fields)) });
}

export function createNearMissEligibilityEvidence(value: NearMissEligibilityEvidenceInput | unknown): NearMissEligibilityEvidence {
  const snapshot = snapshotJsonValue(value, "$eligibility");
  const fields = normalizeEligibilityFields(snapshot);
  if (!fields) fail("NEAR_MISS_ELIGIBILITY_INVALID", "Eligibility evidence is invalid.");
  return freezeDeep({ ...fields, fingerprint: nearMissFingerprintOf(eligibilityBasis(fields)) });
}

export function createNearMissConflictEvidence(value: NearMissConflictEvidenceInput | unknown): NearMissConflictEvidence {
  const snapshot = snapshotJsonValue(value, "$conflicts");
  const fields = normalizeConflictFields(snapshot);
  if (!fields) fail("NEAR_MISS_CONFLICTS_INVALID", "Conflict evidence is invalid.");
  return freezeDeep({ ...fields, fingerprint: nearMissFingerprintOf(conflictBasis(fields)) });
}

function normalizePurposeAuthorization(value: unknown): NearMissPurposeAuthorization | null {
  if (!isPlainRecord(value)) return null;
  const fields = normalizePurposeAuthorizationFields(value);
  const fingerprint = hash(value.fingerprint);
  if (!fields || !fingerprint || fingerprint !== nearMissFingerprintOf(purposeAuthorizationBasis(fields))) return null;
  return { ...fields, fingerprint };
}

function normalizeRetention(value: unknown): NearMissRetentionEvidence | null {
  if (!isPlainRecord(value)) return null;
  const fields = normalizeRetentionFields(value);
  const fingerprint = hash(value.fingerprint);
  if (!fields || !fingerprint || fingerprint !== nearMissFingerprintOf(retentionBasis(fields))) return null;
  return { ...fields, fingerprint };
}

function normalizeEligibility(value: unknown): NearMissEligibilityEvidence | null {
  if (!isPlainRecord(value)) return null;
  const fields = normalizeEligibilityFields(value);
  const fingerprint = hash(value.fingerprint);
  if (!fields || !fingerprint || fingerprint !== nearMissFingerprintOf(eligibilityBasis(fields))) return null;
  return { ...fields, fingerprint };
}

function normalizeConflicts(value: unknown): NearMissConflictEvidence | null {
  if (!isPlainRecord(value)) return null;
  const fields = normalizeConflictFields(value);
  const fingerprint = hash(value.fingerprint);
  if (!fields || !fingerprint || fingerprint !== nearMissFingerprintOf(conflictBasis(fields))) return null;
  return { ...fields, fingerprint };
}

function normalizeCapacity(value: unknown): NearMissCapacityReference | null {
  if (!isPlainRecord(value)) return null;
  const status = value.status === "CURRENT" || value.status === "STALE" || value.status === "UNKNOWN"
    ? value.status
    : null;
  const unitKind = token(firstValue(value, ["unitKind", "unit", "capacityUnit"]));
  const poolId = token(firstValue(value, ["poolId", "capacityPoolId", "pool"]));
  const versionId = token(firstValue(value, ["versionId", "capacityVersionId", "poolVersionId", "version"]));
  const ledgerFingerprint = hash(firstValue(value, ["ledgerFingerprint", "capacityLedgerFingerprint", "ledger"]));
  if (!status || !unitKind || !poolId || !versionId || !ledgerFingerprint) return null;
  return { status, unitKind, poolId, versionId, ledgerFingerprint };
}

function normalizeDisposition(value: unknown): NearMissDisposition | null {
  if (value === "CAPACITY_DISPLACED" || value === "capacity-displaced" || value === "CAPACITY-DISPLACED") return "CAPACITY_DISPLACED";
  if (value === "NEAR_MISS" || value === "near-miss" || value === "NEAR-MISS") return "NEAR_MISS";
  return null;
}

function isExplicitSelectionReceipt(value: Record<string, unknown>): boolean {
  const marker = value.type ?? value.kind ?? value.entryType ?? value.receiptType;
  return marker === "SELECTION_RECEIPT" || marker === "PRIOR_SELECTION_RECEIPT" ||
    marker === "SELECTION_RECEIPT_ENTRY" || marker === "PRIOR_SELECTION" || marker === "prior-selection-receipt";
}

function normalizeReceipt(value: unknown): PriorSelectionReceiptEntry | null {
  if (!isPlainRecord(value) || !isExplicitSelectionReceipt(value)) return null;
  const receiptId = token(firstValue(value, ["receiptId", "id"]));
  const candidateId = token(firstValue(value, ["candidateId", "personId", "subjectId"]));
  const disposition = normalizeDisposition(value.disposition);
  const proposalLineage = normalizeLineage(value.proposalLineage ?? value.lineage ?? value.proposal);
  const targetCall = normalizeTargetCall(value.targetCall ?? value.call ?? value.target);
  const purpose = purposeText(value.purpose);
  const scope = normalizeScope(value.scope);
  const purposeAuthorizationFingerprint = hash(
    firstValue(value, ["purposeAuthorizationFingerprint", "purposeFingerprint", "authorizationFingerprint"])
      ?? (isPlainRecord(value.purposeAuthorization) ? firstValue(value.purposeAuthorization, ["fingerprint", "purposeAuthorizationFingerprint"]) : undefined),
  );
  const retentionFingerprint = hash(
    firstValue(value, ["retentionFingerprint", "retentionEvidenceFingerprint"])
      ?? (isPlainRecord(value.retention) ? value.retention.fingerprint : undefined),
  );
  const capacity = normalizeCapacity(value.capacity ?? value.capacityReference ?? value.capacityUnit);
  const eligibility = normalizeEligibility(value.eligibility ?? value.eligibilityEvidence ?? value.eligible);
  const conflicts = normalizeConflicts(value.conflicts ?? value.conflictEvidence);
  if (!receiptId || !candidateId || !disposition || !proposalLineage || !targetCall || !purpose || !scope ||
      !purposeAuthorizationFingerprint || !retentionFingerprint || !capacity || !eligibility || !conflicts) return null;
  return {
    type: "SELECTION_RECEIPT",
    receiptId,
    candidateId,
    disposition,
    proposalLineage,
    targetCall,
    purpose,
    scope,
    purposeAuthorizationFingerprint,
    retentionFingerprint,
    capacity,
    eligibility,
    conflicts,
  };
}

interface NormalizedNearMissRequest {
  readonly candidateId: string | null;
  readonly purpose: string | null;
  readonly scope: NearMissEvidenceScope | null;
  readonly proposalLineage: NearMissProposalLineage | null;
  readonly targetCall: NearMissTargetCall | null;
  readonly purposeAuthorization: NearMissPurposeAuthorization | null;
  readonly retention: NearMissRetentionEvidence | null;
  readonly capacity: NearMissCapacityReference | null;
  readonly eligibility: NearMissEligibilityEvidence | null;
  readonly conflicts: NearMissConflictEvidence | null;
  readonly evaluatedAt: string | null;
  readonly receipts: readonly unknown[];
}

const EMPTY_REQUEST: NormalizedNearMissRequest = Object.freeze({
  candidateId: null,
  purpose: null,
  scope: null,
  proposalLineage: null,
  targetCall: null,
  purposeAuthorization: null,
  retention: null,
  capacity: null,
  eligibility: null,
  conflicts: null,
  evaluatedAt: null,
  receipts: Object.freeze([]),
});

function normalizeRequest(value: unknown): NormalizedNearMissRequest {
  if (!isPlainRecord(value)) return EMPTY_REQUEST;
  const receipts = value.priorSelectionReceipts ?? value.selectionReceipts ?? value.receipts;
  return {
    candidateId: token(firstValue(value, ["candidateId", "personId", "subjectId"])),
    purpose: purposeText(value.purpose),
    scope: normalizeScope(value.scope),
    proposalLineage: normalizeLineage(value.proposalLineage ?? value.lineage ?? value.proposal),
    targetCall: normalizeTargetCall(value.targetCall ?? value.call ?? value.target),
    purposeAuthorization: normalizePurposeAuthorization(value.purposeAuthorization ?? value.currentPurposeAuthorization),
    retention: normalizeRetention(value.retention ?? value.currentRetention ?? value.retentionEvidence),
    capacity: normalizeCapacity(value.capacity ?? value.currentCapacity ?? value.capacityReference),
    eligibility: normalizeEligibility(value.eligibility ?? value.currentEligibility ?? value.eligibilityEvidence),
    conflicts: normalizeConflicts(value.conflicts ?? value.currentConflicts ?? value.conflictEvidence),
    evaluatedAt: timestamp(value.evaluatedAt),
    receipts: Array.isArray(receipts) ? receipts : [],
  };
}

function proofScopeBlockers(request: NormalizedNearMissRequest): string[] {
  if (!request.scope) return ["PROOF_SCOPE_UNKNOWN"];
  const blockers: string[] = [];
  if (!request.candidateId || request.scope.candidateId !== request.candidateId) blockers.push("PROOF_SCOPE_CANDIDATE_MISMATCH");
  if (!request.purpose || request.scope.purpose !== request.purpose) blockers.push("PROOF_SCOPE_PURPOSE_MISMATCH");
  if (!request.targetCall || request.scope.targetCallId !== request.targetCall.callId ||
      request.scope.targetCallVersionId !== request.targetCall.versionId) blockers.push("PROOF_SCOPE_TARGET_MISMATCH");
  return blockers;
}

function currentPurposeBlockers(request: NormalizedNearMissRequest): string[] {
  const evidence = request.purposeAuthorization;
  if (!evidence) return ["PURPOSE_AUTHORIZATION_UNKNOWN"];
  const blockers: string[] = [];
  if (evidence.status === "UNKNOWN") blockers.push("PURPOSE_AUTHORIZATION_UNKNOWN");
  if (evidence.status === "WITHDRAWN" || evidence.withdrawnAt !== null) blockers.push("PURPOSE_AUTHORIZATION_WITHDRAWN");
  if (evidence.status === "EXPIRED") blockers.push("PURPOSE_AUTHORIZATION_EXPIRED");
  if (!request.purpose || evidence.purpose !== request.purpose) blockers.push("PURPOSE_AUTHORIZATION_PURPOSE_MISMATCH");
  if (!request.scope || !compareJson(evidence.scope, request.scope)) blockers.push("PURPOSE_AUTHORIZATION_SCOPE_MISMATCH");
  if (!request.evaluatedAt) blockers.push("PURPOSE_EVALUATION_TIME_INVALID");
  else {
    if (evidence.evaluatedAt !== request.evaluatedAt) blockers.push("PURPOSE_EVALUATION_TIME_MISMATCH");
    if (evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= Date.parse(request.evaluatedAt)) {
      blockers.push("PURPOSE_AUTHORIZATION_EXPIRED");
    }
  }
  return blockers;
}

function retentionBlockers(request: NormalizedNearMissRequest): string[] {
  const evidence = request.retention;
  if (!evidence) return ["RETENTION_EVIDENCE_REQUIRED"];
  const blockers: string[] = [];
  if (evidence.status === "UNKNOWN") blockers.push("RETENTION_EVIDENCE_UNKNOWN");
  if (evidence.status === "WITHDRAWN" || evidence.withdrawnAt !== null) blockers.push("RETENTION_WITHDRAWN");
  if (evidence.status === "EXPIRED") blockers.push("RETENTION_EXPIRED");
  if (evidence.status !== "CURRENT") blockers.push("RETENTION_NOT_CURRENT");
  if (!request.purpose || evidence.purpose !== request.purpose) blockers.push("RETENTION_PURPOSE_MISMATCH");
  if (!request.scope || !compareJson(evidence.scope, request.scope)) blockers.push("RETENTION_SCOPE_MISMATCH");
  if (!request.evaluatedAt) blockers.push("RETENTION_EVALUATION_TIME_INVALID");
  else {
    if (evidence.evaluatedAt !== request.evaluatedAt) blockers.push("RETENTION_EVALUATION_TIME_MISMATCH");
    if (Date.parse(evidence.expiresAt) <= Date.parse(request.evaluatedAt)) blockers.push("RETENTION_EXPIRED");
  }
  return blockers;
}

function capacityBlockers(capacity: NearMissCapacityReference | null): string[] {
  if (!capacity) return ["CAPACITY_REFERENCE_UNKNOWN"];
  if (capacity.status === "STALE") return ["CAPACITY_LEDGER_STALE"];
  if (capacity.status === "UNKNOWN") return ["CAPACITY_REFERENCE_UNKNOWN"];
  return [];
}

function eligibilityBlockers(request: NormalizedNearMissRequest): string[] {
  const evidence = request.eligibility;
  if (!evidence) return ["ELIGIBILITY_UNVERIFIED"];
  const blockers: string[] = [];
  if (!evidence.current) blockers.push("ELIGIBILITY_NOT_CURRENT");
  if (evidence.status === "UNKNOWN") blockers.push("ELIGIBILITY_UNVERIFIED");
  else if (evidence.status !== "ELIGIBLE") blockers.push("CANDIDATE_NOT_ELIGIBLE");
  if (!request.scope || !compareJson(evidence.scope, request.scope)) blockers.push("ELIGIBILITY_SCOPE_MISMATCH");
  if (!request.evaluatedAt) blockers.push("ELIGIBILITY_EVALUATION_TIME_INVALID");
  else {
    if (evidence.evaluatedAt !== request.evaluatedAt) blockers.push("ELIGIBILITY_EVALUATION_TIME_MISMATCH");
    if (Date.parse(evidence.expiresAt) <= Date.parse(request.evaluatedAt)) blockers.push("ELIGIBILITY_EVIDENCE_EXPIRED");
  }
  return blockers;
}

function conflictBlockers(request: NormalizedNearMissRequest): string[] {
  const evidence = request.conflicts;
  if (!evidence) return ["CONFLICTS_UNVERIFIED"];
  const blockers: string[] = [];
  if (!evidence.current) blockers.push("CONFLICTS_NOT_CURRENT");
  if (evidence.status === "UNKNOWN") blockers.push("CONFLICTS_UNVERIFIED");
  else if (evidence.status !== "CLEAR" || evidence.conflictIds.length > 0) blockers.push("CURRENT_CONFLICTS_PRESENT");
  if (!request.scope || !compareJson(evidence.scope, request.scope)) blockers.push("CONFLICT_SCOPE_MISMATCH");
  if (!request.evaluatedAt) blockers.push("CONFLICT_EVALUATION_TIME_INVALID");
  else {
    if (evidence.evaluatedAt !== request.evaluatedAt) blockers.push("CONFLICT_EVALUATION_TIME_MISMATCH");
    if (Date.parse(evidence.expiresAt) <= Date.parse(request.evaluatedAt)) blockers.push("CONFLICT_EVIDENCE_EXPIRED");
  }
  return blockers;
}

function proofEvidence(request: NormalizedNearMissRequest, receipt: PriorSelectionReceiptEntry | null): NearMissProofEvidence {
  return {
    receiptId: receipt?.receiptId ?? null,
    purpose: request.purpose,
    evaluatedAt: request.evaluatedAt,
    scope: request.scope,
    proposalLineage: request.proposalLineage,
    targetCall: request.targetCall,
    purposeAuthorizationFingerprint: request.purposeAuthorization?.fingerprint ?? null,
    retentionFingerprint: request.retention?.fingerprint ?? null,
    capacity: request.capacity,
    eligibilityFingerprint: request.eligibility?.fingerprint ?? null,
    conflictFingerprint: request.conflicts?.fingerprint ?? null,
  };
}

function result(
  request: NormalizedNearMissRequest,
  qualified: boolean,
  blockers: readonly string[],
  receipt: PriorSelectionReceiptEntry | null,
): NearMissProofResult {
  const sortedBlockers = [...new Set(blockers)].sort();
  const evidence = proofEvidence(request, receipt);
  const basis = {
    schema: NEAR_MISS_PROOF_SCHEMA,
    status: NEAR_MISS_PROOF_STATUS,
    candidateId: request.candidateId,
    qualified,
    blockers: sortedBlockers,
    evidence,
  } as const;
  const proof: NearMissProofResult = {
    schema: NEAR_MISS_PROOF_SCHEMA,
    status: NEAR_MISS_PROOF_STATUS,
    candidateId: request.candidateId,
    qualified,
    blockers: Object.freeze(sortedBlockers),
    evidence: freezeDeep(cloneJson(basis.evidence as unknown as JsonValue)) as unknown as NearMissProofEvidence,
    proofFingerprint: nearMissFingerprintOf(basis as unknown as JsonValue),
  };
  return freezeDeep(proof);
}

function receiptBlockers(request: NormalizedNearMissRequest, receipt: PriorSelectionReceiptEntry): string[] {
  const blockers: string[] = [];
  if (!request.candidateId || receipt.candidateId !== request.candidateId) blockers.push("CANDIDATE_MISMATCH");
  if (!request.proposalLineage) blockers.push("PROPOSAL_LINEAGE_UNAVAILABLE");
  else if (!compareJson(receipt.proposalLineage, request.proposalLineage)) blockers.push("PROPOSAL_LINEAGE_MISMATCH");
  if (!request.targetCall) blockers.push("TARGET_CALL_UNAVAILABLE");
  else if (!compareJson(receipt.targetCall, request.targetCall)) blockers.push("TARGET_CALL_MISMATCH");
  if (!request.purpose || receipt.purpose !== request.purpose) blockers.push("RECEIPT_PURPOSE_MISMATCH");
  if (!request.scope || !compareJson(receipt.scope, request.scope)) blockers.push("RECEIPT_SCOPE_MISMATCH");
  if (!request.purposeAuthorization) blockers.push("PURPOSE_AUTHORIZATION_UNKNOWN");
  else if (receipt.purposeAuthorizationFingerprint !== request.purposeAuthorization.fingerprint) {
    blockers.push("PURPOSE_AUTHORIZATION_FINGERPRINT_MISMATCH");
  }
  if (!request.retention) blockers.push("RETENTION_EVIDENCE_REQUIRED");
  else if (receipt.retentionFingerprint !== request.retention.fingerprint) blockers.push("RETENTION_FINGERPRINT_MISMATCH");
  if (!request.capacity) blockers.push("CAPACITY_REFERENCE_UNKNOWN");
  else if (!compareJson(receipt.capacity, request.capacity)) blockers.push("CAPACITY_REFERENCE_MISMATCH");
  if (!request.eligibility) blockers.push("ELIGIBILITY_UNVERIFIED");
  else if (!compareJson(receipt.eligibility, request.eligibility)) blockers.push("ELIGIBILITY_FINGERPRINT_MISMATCH");
  if (!request.conflicts) blockers.push("CONFLICTS_UNVERIFIED");
  else if (!compareJson(receipt.conflicts, request.conflicts)) blockers.push("CONFLICT_EVIDENCE_MISMATCH");
  if (receipt.capacity.status !== "CURRENT") blockers.push("RECEIPT_CAPACITY_NOT_CURRENT");
  if (!receipt.eligibility.current || receipt.eligibility.status !== "ELIGIBLE") blockers.push("RECEIPT_ELIGIBILITY_NOT_PROVEN");
  if (!receipt.conflicts.current || receipt.conflicts.status !== "CLEAR" || receipt.conflicts.conflictIds.length > 0) {
    blockers.push("RECEIPT_CONFLICTS_PRESENT");
  }
  return [...new Set(blockers)];
}

export function proveNearMiss(requestInput: NearMissProofRequest | unknown): NearMissProofResult {
  let request: NormalizedNearMissRequest;
  try {
    request = normalizeRequest(snapshotJsonValue(requestInput, "$request"));
  } catch (error) {
    if (error instanceof NearMissProofValidationError) {
      return result(EMPTY_REQUEST, false, [error.code], null);
    }
    throw error;
  }
  const baseBlockers: string[] = [];
  if (!request.candidateId) baseBlockers.push("CANDIDATE_REFERENCE_UNKNOWN");
  if (!request.purpose) baseBlockers.push("PURPOSE_UNKNOWN");
  if (!request.proposalLineage) baseBlockers.push("PROPOSAL_LINEAGE_UNAVAILABLE");
  if (!request.targetCall) baseBlockers.push("TARGET_CALL_UNAVAILABLE");
  if (!request.evaluatedAt) baseBlockers.push("PROOF_EVALUATION_TIME_INVALID");
  baseBlockers.push(...proofScopeBlockers(request));
  baseBlockers.push(...currentPurposeBlockers(request));
  baseBlockers.push(...retentionBlockers(request));
  baseBlockers.push(...capacityBlockers(request.capacity));
  baseBlockers.push(...eligibilityBlockers(request));
  baseBlockers.push(...conflictBlockers(request));
  if (request.receipts.length > NEAR_MISS_MAX_RECEIPTS) {
    return result(request, false, [...baseBlockers, "SELECTION_RECEIPT_LIMIT_EXCEEDED"], null);
  }
  const entries = request.receipts
    .map((value) => ({ raw: value, entry: normalizeReceipt(value) }))
    .sort((first, second) => (first.entry?.receiptId ?? "~").localeCompare(second.entry?.receiptId ?? "~"));
  if (entries.length === 0) return result(request, false, [...baseBlockers, "SELECTION_RECEIPT_NOT_FOUND"], null);
  const validCandidates: PriorSelectionReceiptEntry[] = [];
  const candidateBlockers = new Set<string>();
  for (const { raw, entry } of entries) {
    if (!isPlainRecord(raw) || !isExplicitSelectionReceipt(raw)) {
      candidateBlockers.add("EXPLICIT_SELECTION_RECEIPT_REQUIRED");
      if (isPlainRecord(raw) && normalizeDisposition(raw.disposition) === null) {
        candidateBlockers.add("DISPOSITION_NOT_CAPACITY_NEAR_MISS");
      }
      continue;
    }
    if (!entry) {
      candidateBlockers.add("SELECTION_RECEIPT_INVALID");
      if (normalizeDisposition(raw.disposition) === null) candidateBlockers.add("DISPOSITION_NOT_CAPACITY_NEAR_MISS");
      continue;
    }
    const blockers = receiptBlockers(request, entry);
    if (blockers.length === 0) validCandidates.push(entry);
    else for (const blocker of blockers) candidateBlockers.add(blocker);
  }
  if (validCandidates.length > 0 && baseBlockers.length === 0) {
    return result(request, true, [], validCandidates[0]!);
  }
  if (validCandidates.length > 0) {
    return result(request, false, [...baseBlockers, "CURRENT_PROOF_CONTEXT_BLOCKED"], validCandidates[0]!);
  }
  return result(request, false, [...baseBlockers, ...candidateBlockers], null);
}

export const evaluateNearMissProof = proveNearMiss;
export const buildNearMissProof = proveNearMiss;
export const qualifyNearMiss = proveNearMiss;
export const createNearMissProof = proveNearMiss;
export const checkNearMiss = proveNearMiss;

function normalizeQualifiedProofEvidence(value: unknown): NearMissProofEvidence | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    "receiptId", "purpose", "evaluatedAt", "scope", "proposalLineage", "targetCall",
    "purposeAuthorizationFingerprint", "retentionFingerprint", "capacity",
    "eligibilityFingerprint", "conflictFingerprint",
  ])) return null;
  if (!isPlainRecord(value.proposalLineage) || !hasOnlyKeys(value.proposalLineage, [
    "proposalId", "revisionId", "lineageId", "fingerprint",
  ])) return null;
  if (!isPlainRecord(value.targetCall) || !hasOnlyKeys(value.targetCall, [
    "callId", "versionId", "fingerprint",
  ])) return null;
  if (!isPlainRecord(value.capacity) || !hasOnlyKeys(value.capacity, [
    "status", "unitKind", "poolId", "versionId", "ledgerFingerprint",
  ])) return null;
  const receiptId = token(value.receiptId);
  const purpose = purposeText(value.purpose);
  const evaluatedAt = timestamp(value.evaluatedAt);
  const scope = normalizeScope(value.scope);
  const proposalLineage = normalizeLineage(value.proposalLineage);
  const targetCall = normalizeTargetCall(value.targetCall);
  const purposeAuthorizationFingerprint = hash(value.purposeAuthorizationFingerprint);
  const retentionFingerprint = hash(value.retentionFingerprint);
  const capacity = normalizeCapacity(value.capacity);
  const eligibilityFingerprint = hash(value.eligibilityFingerprint);
  const conflictFingerprint = hash(value.conflictFingerprint);
  if (!receiptId || !purpose || !evaluatedAt || !scope || !proposalLineage || !targetCall ||
      !purposeAuthorizationFingerprint || !retentionFingerprint || !capacity ||
      !eligibilityFingerprint || !conflictFingerprint) return null;
  if (scope.candidateId.length === 0 || scope.purpose !== purpose || scope.targetCallId !== targetCall.callId ||
      scope.targetCallVersionId !== targetCall.versionId) return null;
  return {
    receiptId,
    purpose,
    evaluatedAt,
    scope,
    proposalLineage,
    targetCall,
    purposeAuthorizationFingerprint,
    retentionFingerprint,
    capacity,
    eligibilityFingerprint,
    conflictFingerprint,
  };
}

export function isNearMissProofQualified(value: NearMissProofResult | unknown): boolean {
  try {
    const snapshot = snapshotJsonValue(value, "$proof");
    if (!isPlainRecord(snapshot) || !hasOnlyKeys(snapshot, [
      "schema", "status", "candidateId", "qualified", "blockers", "evidence", "proofFingerprint",
    ])) return false;
    if (snapshot.schema !== NEAR_MISS_PROOF_SCHEMA || snapshot.status !== NEAR_MISS_PROOF_STATUS ||
        snapshot.qualified !== true || !Array.isArray(snapshot.blockers) || snapshot.blockers.length !== 0) return false;
    const candidateId = token(snapshot.candidateId);
    const evidence = normalizeQualifiedProofEvidence(snapshot.evidence);
    const proofFingerprint = hash(snapshot.proofFingerprint);
    if (!candidateId || !evidence || !proofFingerprint || evidence.scope?.candidateId !== candidateId) return false;
    const basis = {
      schema: NEAR_MISS_PROOF_SCHEMA,
      status: NEAR_MISS_PROOF_STATUS,
      candidateId,
      qualified: true,
      blockers: [],
      evidence,
    } as const;
    return proofFingerprint === nearMissFingerprintOf(basis as unknown as JsonValue);
  } catch (error) {
    if (error instanceof NearMissProofValidationError) return false;
    throw error;
  }
}

function snapshotHasAuthorityCarryForward(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(snapshotHasAuthorityCarryForward);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    FORBIDDEN_AUTHORITY_KEY.test(key) || snapshotHasAuthorityCarryForward(child as JsonValue));
}

export function hasNearMissAuthorityCarryForward(value: unknown): boolean {
  try {
    return snapshotHasAuthorityCarryForward(snapshotJsonValue(value, "$authorityInspection"));
  } catch (error) {
    if (error instanceof NearMissProofValidationError) return true;
    throw error;
  }
}
