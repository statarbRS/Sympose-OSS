import {
  ABSOLUTE_SURGICAL_RECONFIRMATION_LIMITS,
  DEFAULT_SURGICAL_RECONFIRMATION_LIMITS,
  EVIDENCE_STATUSES,
  GRAPH_RELATIONS,
  MATERIALITY_POLICIES,
  MATERIAL_TERM_KINDS,
  RECONFIRMATION_FAMILIES,
  STAKEHOLDER_KINDS,
  SURGICAL_RECONFIRMATION_COMMAND,
  SURGICAL_RECONFIRMATION_SCHEMA,
  SurgicalReconfirmationError,
  type AuthorityEvidenceInput,
  type AuthorityEvidenceSnapshot,
  type EvidenceRecordReference,
  type EvidenceSnapshotBase,
  type EvidenceStatus,
  type EvidenceSubject,
  type ExactRevisionSnapshot,
  type GraphRelation,
  type JsonValue,
  type MaterialTermImpact,
  type MaterialTermKind,
  type MaterialTermPolicyInput,
  type MaterialTermRule,
  type MaterialityPolicy,
  type PurposeEvidenceInput,
  type PurposeEvidenceSnapshot,
  type ReconfirmationFamily,
  type ReconfirmationGraph,
  type ReconfirmationGraphEdge,
  type ReconfirmationGraphNode,
  type ReconfirmationRecordReference,
  type ReconfirmationReceipt,
  type ReconfirmationScope,
  type ReconfirmationStatus,
  type RetentionEvidenceInput,
  type RetentionEvidenceSnapshot,
  type StakeholderActor,
  type StakeholderBindingInput,
  type StakeholderKind,
  type StakeholderRevisionSnapshot,
  type SurgicalReconfirmationCommand,
  type SurgicalReconfirmationPlan,
} from "./types";
import {
  canonicalJson,
  canonicalJsonWithLimits,
  compareStableStrings,
  deepFreeze,
  fingerprintWithLimits,
  hasOwn,
  isPlainRecord,
  resolveCanonicalLimits,
  snapshotPlainData,
  stableSort,
  type ResolvedSurgicalReconfirmationLimits,
} from "./canonical";

type SnapshotRecord = Record<string, JsonValue>;

interface ResolvedLimits extends ResolvedSurgicalReconfirmationLimits {
  readonly maxStakeholders: number;
  readonly maxEvidenceRecords: number;
  readonly maxMaterialTermsPerReceipt: number;
  readonly maxGraphNodes: number;
  readonly maxGraphEdges: number;
  readonly maxGraphDepth: number;
  readonly maxReceipts: number;
}

interface NormalizedRevision extends ExactRevisionSnapshot {}

interface NormalizedStakeholderRevision extends StakeholderRevisionSnapshot {}

interface NormalizedAuthorityEvidence extends AuthorityEvidenceSnapshot {}
interface NormalizedPurposeEvidence extends PurposeEvidenceSnapshot {}
interface NormalizedRetentionEvidence extends RetentionEvidenceSnapshot {}

interface NormalizedStakeholder {
  readonly id: string;
  readonly actor: StakeholderActor;
  readonly kind: StakeholderKind;
  readonly source: ReconfirmationRecordReference;
  readonly before: NormalizedStakeholderRevision;
  readonly after: NormalizedStakeholderRevision;
  readonly authority: NormalizedAuthorityEvidence | null;
  readonly purpose: NormalizedPurposeEvidence | null;
  readonly retention: NormalizedRetentionEvidence | null;
  readonly receiptId: string;
}

interface NormalizedPolicy {
  readonly family: ReconfirmationFamily;
  readonly version: number;
  readonly rules: readonly NormalizedRule[];
  readonly fingerprint: string;
}

interface NormalizedRule extends MaterialTermRule {
  readonly segments: readonly string[];
}

interface NormalizedEdge {
  readonly from: ReconfirmationRecordReference;
  readonly to: ReconfirmationRecordReference;
  readonly relation: GraphRelation;
}

interface NormalizedCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly scope: ReconfirmationScope;
  readonly asOf: string;
  readonly purpose: string;
  readonly beforeArtifact: NormalizedRevision;
  readonly afterArtifact: NormalizedRevision;
  readonly policy: NormalizedPolicy;
  readonly stakeholders: readonly NormalizedStakeholder[];
  readonly dependencyGraph: readonly NormalizedEdge[] | undefined;
  readonly limits: ResolvedLimits;
}

interface Presence {
  readonly present: boolean;
  readonly value?: JsonValue;
}

interface ChangedPath {
  readonly path: string;
  readonly segments: readonly string[];
}

interface TermComparison {
  readonly changed: boolean;
  readonly changedPath: ChangedPath;
  readonly before: Presence;
  readonly after: Presence;
  readonly rule: NormalizedRule;
}

interface BoundTermComparison extends TermComparison {
  readonly sourceBindingFingerprint: string;
}

interface EvidenceAssessment {
  readonly status: "CURRENT" | "BLOCKED" | "UNAVAILABLE";
  readonly reasonCode: string;
}

const COMMAND_KEYS = [
  "schema",
  "commandType",
  "commandId",
  "idempotencyKey",
  "scope",
  "asOf",
  "purpose",
  "beforeArtifact",
  "beforeSource",
  "beforeRevision",
  "before",
  "afterArtifact",
  "afterSource",
  "afterRevision",
  "after",
  "materialPolicy",
  "stakeholders",
  "dependencyGraph",
  "graph",
  "limits",
] as const;

const REVISION_KEYS = [
  "family",
  "id",
  "artifactId",
  "sourceId",
  "scope",
  "revision",
  "sourceRevision",
  "content",
  "payload",
  "data",
  "fingerprint",
  "sourceFingerprint",
] as const;

const RECORD_REFERENCE_KEYS = ["family", "id", "scope"] as const;
const EVIDENCE_RECORD_KEYS = ["family", "id", "scope", "revision", "fingerprint"] as const;
const ACTOR_KEYS = ["id", "role"] as const;
const STAKEHOLDER_KEYS = [
  "id",
  "actor",
  "kind",
  "source",
  "before",
  "after",
  "authority",
  "authorityEvidence",
  "purpose",
  "purposeEvidence",
  "retention",
  "retentionEvidence",
] as const;
const STAKEHOLDER_REVISION_KEYS = ["id", "scope", "revision", "terms", "fingerprint"] as const;
const SUBJECT_KEYS = ["id", "role"] as const;
const AUTHORITY_KEYS = [
  "evidenceId",
  "version",
  "scope",
  "status",
  "subject",
  "record",
  "issuedAt",
  "expiresAt",
  "fingerprint",
] as const;
const PURPOSE_KEYS = [
  "evidenceId",
  "version",
  "scope",
  "status",
  "subject",
  "purpose",
  "effectiveAt",
  "expiresAt",
  "fingerprint",
] as const;
const RETENTION_KEYS = [
  "evidenceId",
  "version",
  "scope",
  "status",
  "subject",
  "retentionUntil",
  "policy",
  "fingerprint",
] as const;
const POLICY_KEYS = ["family", "version", "rules", "terms", "materialTerms"] as const;
const RULE_KEYS = ["path", "kind", "materiality", "classification"] as const;
const EDGE_KEYS = ["from", "to", "relation"] as const;
const LIMIT_KEYS = [
  "maxInputDepth",
  "maxInputNodes",
  "maxStringBytes",
  "maxCanonicalBytes",
  "maxStakeholders",
  "maxEvidenceRecords",
  "maxMaterialTermsPerReceipt",
  "maxGraphNodes",
  "maxGraphEdges",
  "maxGraphDepth",
  "maxReceipts",
] as const;

const FIXED_REASON = Object.freeze({
  required: "A material term changed for an exact prior commitment or approval.",
  unaffected: "No material term changed.",
  nonMaterial: "Only non-material terms changed.",
  blocked: "Reconfirmation is blocked by non-current or misbound evidence.",
  unavailable: "Reconfirmation evidence is unavailable.",
});

function fail(
  code: ConstructorParameters<typeof SurgicalReconfirmationError>[0],
  path: string,
  message: string,
): never {
  throw new SurgicalReconfirmationError(code, message, path);
}

function asRecord(value: JsonValue | undefined, path: string, code: "INVALID_COMMAND" | "INVALID_SCOPE" | "INVALID_REFERENCE" | "INVALID_STAKEHOLDER" | "INVALID_EVIDENCE" | "INVALID_POLICY" | "INVALID_LIMIT" = "INVALID_COMMAND"): SnapshotRecord {
  if (!isPlainRecord(value)) fail(code, path, "A plain object is required.");
  return value as SnapshotRecord;
}

function assertKeys(record: SnapshotRecord, allowed: readonly string[], path: string, code: ConstructorParameters<typeof SurgicalReconfirmationError>[0]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) fail(code, `${path}.${key}`, "Unknown field.");
  }
}

function requiredValue(record: SnapshotRecord, key: string, path: string, code: ConstructorParameters<typeof SurgicalReconfirmationError>[0]): JsonValue {
  if (!hasOwn(record, key)) fail(code, `${path}.${key}`, "Required field is missing.");
  return record[key]!;
}

function optionalValue(record: SnapshotRecord, key: string): JsonValue | undefined {
  return hasOwn(record, key) ? record[key] : undefined;
}

function stringValue(value: JsonValue | undefined, path: string, code: ConstructorParameters<typeof SurgicalReconfirmationError>[0], allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(code, path, "A bounded string is required.");
  if (value.length > 512 || value.includes("\u0000")) fail(code, path, "String bound or content rule exceeded.");
  return value;
}

function identifier(value: JsonValue | undefined, path: string, code: ConstructorParameters<typeof SurgicalReconfirmationError>[0]): string {
  const result = stringValue(value, path, code);
  if (/^[\u0000-\u001f\u007f]/.test(result)) fail(code, path, "Identifier contains a control character.");
  return result;
}

function integer(value: JsonValue | undefined, path: string, code: ConstructorParameters<typeof SurgicalReconfirmationError>[0], minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(code, path, "A safe integer is required.");
  return value;
}

function enumValue<T extends readonly string[]>(value: JsonValue | undefined, allowed: T, path: string, code: ConstructorParameters<typeof SurgicalReconfirmationError>[0]): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(code, path, "Unknown enum value.");
  return value as T[number];
}

function sameString(left: string, right: string): boolean {
  return left === right;
}

function sameScope(left: ReconfirmationScope, right: ReconfirmationScope): boolean {
  return sameString(left.workspaceId, right.workspaceId) && sameString(left.eventId, right.eventId);
}

function referenceKey(reference: Pick<ReconfirmationRecordReference, "family" | "id">): string {
  return `${reference.family}\u0000${reference.id}`;
}

function normalizeScope(value: JsonValue | undefined, path: string): ReconfirmationScope {
  const record = asRecord(value, path, "INVALID_SCOPE");
  assertKeys(record, ["workspaceId", "eventId"], path, "INVALID_SCOPE");
  return Object.freeze({
    workspaceId: identifier(requiredValue(record, "workspaceId", path, "INVALID_SCOPE"), `${path}.workspaceId`, "INVALID_SCOPE"),
    eventId: identifier(requiredValue(record, "eventId", path, "INVALID_SCOPE"), `${path}.eventId`, "INVALID_SCOPE"),
  });
}

function assertScope(actual: ReconfirmationScope, expected: ReconfirmationScope, path: string): void {
  if (!sameScope(actual, expected)) fail("SCOPE_MISMATCH", path, "Scope does not match the command boundary.");
}

function knownFamily(value: JsonValue | undefined, path: string): ReconfirmationFamily {
  return enumValue(value, RECONFIRMATION_FAMILIES, path, "UNKNOWN_FAMILY");
}

function hexFingerprint(value: JsonValue | undefined, path: string, code: ConstructorParameters<typeof SurgicalReconfirmationError>[0] = "FINGERPRINT_MISMATCH"): string {
  const result = stringValue(value, path, code);
  if (!/^[0-9a-f]{64}$/.test(result)) fail(code, path, "Fingerprint must be a lowercase SHA-256 value.");
  return result;
}

function canonicalEqual(left: unknown, right: unknown, limits: ResolvedSurgicalReconfirmationLimits): boolean {
  return canonicalJsonWithLimits(left, limits) === canonicalJsonWithLimits(right, limits);
}

function aliases(
  record: SnapshotRecord,
  names: readonly string[],
  path: string,
  code: ConstructorParameters<typeof SurgicalReconfirmationError>[0],
): JsonValue | undefined {
  const present = names.filter((name) => hasOwn(record, name));
  if (present.length === 0) return undefined;
  const first = record[present[0]!]!;
  for (const name of present.slice(1)) {
    if (!canonicalEqual(first, record[name], resolveCanonicalLimits(undefined))) {
      fail("CONFLICTING_ALIAS", `${path}.${name}`, "Equivalent aliases carry different values.");
    }
  }
  if (present.length > 1 && code === "INVALID_POLICY") {
    return first;
  }
  return first;
}

function aliasRequired(
  record: SnapshotRecord,
  names: readonly string[],
  path: string,
  code: ConstructorParameters<typeof SurgicalReconfirmationError>[0],
): JsonValue {
  const value = aliases(record, names, path, code);
  if (value === undefined) fail(code, path, "Required aliased field is missing.");
  return value;
}

function parseInstant(value: JsonValue | undefined, path: string): string {
  const input = stringValue(value, path, "INVALID_DATE");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) fail("INVALID_DATE", path, "An unambiguous ISO instant with an explicit offset is required.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const offset = match[8]!;
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    month < 1 || month > 12 || day < 1 || day > (daysInMonth ?? 0) ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) {
    fail("INVALID_DATE", path, "Instant components are invalid.");
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) fail("INVALID_DATE", path, "Instant cannot be parsed.");
  const iso = new Date(parsed).toISOString();
  const expectedFraction = fraction.padEnd(3, "0");
  if (expectedFraction.length > 0 && iso.slice(20, 23) !== expectedFraction) {
    fail("INVALID_DATE", path, "Instant precision or calendar normalization is invalid.");
  }
  return iso;
}

function validateOptionalInstant(record: SnapshotRecord, key: string, path: string): string | undefined {
  const value = optionalValue(record, key);
  return value === undefined ? undefined : parseInstant(value, `${path}.${key}`);
}

function normalizeReference(value: JsonValue | undefined, path: string, expected: ReconfirmationScope, allowUnknownFamily = false): ReconfirmationRecordReference {
  const record = asRecord(value, path, "INVALID_REFERENCE");
  assertKeys(record, RECORD_REFERENCE_KEYS, path, "INVALID_REFERENCE");
  const family = allowUnknownFamily
    ? identifier(requiredValue(record, "family", path, "INVALID_REFERENCE"), `${path}.family`, "INVALID_REFERENCE")
    : knownFamily(requiredValue(record, "family", path, "INVALID_REFERENCE"), `${path}.family`);
  const id = identifier(requiredValue(record, "id", path, "INVALID_REFERENCE"), `${path}.id`, "INVALID_REFERENCE");
  const scope = normalizeScope(requiredValue(record, "scope", path, "INVALID_REFERENCE"), `${path}.scope`);
  assertScope(scope, expected, `${path}.scope`);
  return Object.freeze({ family, id, scope });
}

function normalizeEvidenceRecord(value: JsonValue | undefined, path: string, expected: ReconfirmationScope): EvidenceRecordReference {
  const record = asRecord(value, path, "INVALID_EVIDENCE");
  assertKeys(record, EVIDENCE_RECORD_KEYS, path, "INVALID_EVIDENCE");
  const family = knownFamily(requiredValue(record, "family", path, "INVALID_EVIDENCE"), `${path}.family`);
  const id = identifier(requiredValue(record, "id", path, "INVALID_EVIDENCE"), `${path}.id`, "INVALID_EVIDENCE");
  const scope = normalizeScope(requiredValue(record, "scope", path, "INVALID_EVIDENCE"), `${path}.scope`);
  assertScope(scope, expected, `${path}.scope`);
  const revision = integer(requiredValue(record, "revision", path, "INVALID_EVIDENCE"), `${path}.revision`, "INVALID_EVIDENCE");
  const fingerprint = hexFingerprint(requiredValue(record, "fingerprint", path, "INVALID_EVIDENCE"), `${path}.fingerprint`, "INVALID_EVIDENCE");
  return Object.freeze({ family, id, scope, revision, fingerprint });
}

function normalizeSubject(value: JsonValue | undefined, path: string): EvidenceSubject {
  const record = asRecord(value, path, "INVALID_EVIDENCE");
  assertKeys(record, SUBJECT_KEYS, path, "INVALID_EVIDENCE");
  return Object.freeze({
    id: identifier(requiredValue(record, "id", path, "INVALID_EVIDENCE"), `${path}.id`, "INVALID_EVIDENCE"),
    role: stringValue(requiredValue(record, "role", path, "INVALID_EVIDENCE"), `${path}.role`, "INVALID_EVIDENCE"),
  });
}

function evidenceBase(
  record: SnapshotRecord,
  path: string,
  expected: ReconfirmationScope,
): { readonly evidenceId: string; readonly version: number; readonly scope: ReconfirmationScope; readonly status: EvidenceStatus } {
  const evidenceId = identifier(requiredValue(record, "evidenceId", path, "INVALID_EVIDENCE"), `${path}.evidenceId`, "INVALID_EVIDENCE");
  const version = integer(requiredValue(record, "version", path, "INVALID_EVIDENCE"), `${path}.version`, "INVALID_EVIDENCE", 1);
  const scope = normalizeScope(requiredValue(record, "scope", path, "INVALID_EVIDENCE"), `${path}.scope`);
  assertScope(scope, expected, `${path}.scope`);
  const status = enumValue(requiredValue(record, "status", path, "INVALID_EVIDENCE"), EVIDENCE_STATUSES, `${path}.status`, "INVALID_EVIDENCE");
  return { evidenceId, version, scope, status };
}

function verifyEvidenceClaim(record: SnapshotRecord, path: string, payload: Record<string, unknown>, limits: ResolvedSurgicalReconfirmationLimits): string {
  const computed = fingerprintWithLimits(payload, limits);
  const claimed = optionalValue(record, "fingerprint");
  if (claimed !== undefined) {
    const value = hexFingerprint(claimed, `${path}.fingerprint`, "FORGED_EVIDENCE");
    if (value !== computed) fail("FORGED_EVIDENCE", `${path}.fingerprint`, "Evidence fingerprint does not bind to its exact content.");
  }
  return computed;
}

function normalizeAuthority(
  value: JsonValue | undefined,
  path: string,
  expected: ReconfirmationScope,
  limits: ResolvedSurgicalReconfirmationLimits,
): NormalizedAuthorityEvidence | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value, path, "INVALID_EVIDENCE");
  assertKeys(record, AUTHORITY_KEYS, path, "INVALID_EVIDENCE");
  const base = evidenceBase(record, path, expected);
  const subject = normalizeSubject(requiredValue(record, "subject", path, "INVALID_EVIDENCE"), `${path}.subject`);
  const authorityRecord = normalizeEvidenceRecord(requiredValue(record, "record", path, "INVALID_EVIDENCE"), `${path}.record`, expected);
  const issuedAt = validateOptionalInstant(record, "issuedAt", path);
  const expiresAt = validateOptionalInstant(record, "expiresAt", path);
  const payload: Record<string, unknown> = {
    schema: "authority-evidence/v1",
    evidenceId: base.evidenceId,
    version: base.version,
    scope: base.scope,
    status: base.status,
    subject,
    record: authorityRecord,
  };
  if (issuedAt !== undefined) payload.issuedAt = issuedAt;
  if (expiresAt !== undefined) payload.expiresAt = expiresAt;
  const fingerprint = verifyEvidenceClaim(record, path, payload, limits);
  const result: NormalizedAuthorityEvidence = {
    ...base,
    subject,
    record: authorityRecord,
    ...(issuedAt === undefined ? {} : { issuedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    fingerprint,
  };
  return Object.freeze(result);
}

function normalizePurpose(
  value: JsonValue | undefined,
  path: string,
  expected: ReconfirmationScope,
  limits: ResolvedSurgicalReconfirmationLimits,
): NormalizedPurposeEvidence | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value, path, "INVALID_EVIDENCE");
  assertKeys(record, PURPOSE_KEYS, path, "INVALID_EVIDENCE");
  const base = evidenceBase(record, path, expected);
  const subject = normalizeSubject(requiredValue(record, "subject", path, "INVALID_EVIDENCE"), `${path}.subject`);
  const purpose = stringValue(requiredValue(record, "purpose", path, "INVALID_EVIDENCE"), `${path}.purpose`, "INVALID_EVIDENCE");
  const effectiveAt = validateOptionalInstant(record, "effectiveAt", path);
  const expiresAt = validateOptionalInstant(record, "expiresAt", path);
  const payload: Record<string, unknown> = {
    schema: "purpose-evidence/v1",
    evidenceId: base.evidenceId,
    version: base.version,
    scope: base.scope,
    status: base.status,
    subject,
    purpose,
  };
  if (effectiveAt !== undefined) payload.effectiveAt = effectiveAt;
  if (expiresAt !== undefined) payload.expiresAt = expiresAt;
  const fingerprint = verifyEvidenceClaim(record, path, payload, limits);
  const result: NormalizedPurposeEvidence = {
    ...base,
    subject,
    purpose,
    ...(effectiveAt === undefined ? {} : { effectiveAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    fingerprint,
  };
  return Object.freeze(result);
}

function normalizeRetention(
  value: JsonValue | undefined,
  path: string,
  expected: ReconfirmationScope,
  limits: ResolvedSurgicalReconfirmationLimits,
): NormalizedRetentionEvidence | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value, path, "INVALID_EVIDENCE");
  assertKeys(record, RETENTION_KEYS, path, "INVALID_EVIDENCE");
  const base = evidenceBase(record, path, expected);
  const subject = normalizeSubject(requiredValue(record, "subject", path, "INVALID_EVIDENCE"), `${path}.subject`);
  const retentionUntil = parseInstant(requiredValue(record, "retentionUntil", path, "INVALID_EVIDENCE"), `${path}.retentionUntil`);
  const policy = stringValue(requiredValue(record, "policy", path, "INVALID_EVIDENCE"), `${path}.policy`, "INVALID_EVIDENCE");
  const payload = {
    schema: "retention-evidence/v1",
    evidenceId: base.evidenceId,
    version: base.version,
    scope: base.scope,
    status: base.status,
    subject,
    retentionUntil,
    policy,
  };
  const fingerprint = verifyEvidenceClaim(record, path, payload, limits);
  const result: NormalizedRetentionEvidence = { ...base, subject, retentionUntil, policy, fingerprint };
  return Object.freeze(result);
}

function revisionPayload(
  schema: string,
  family: string,
  id: string,
  scope: ReconfirmationScope,
  revision: number,
  content: JsonValue,
): Record<string, unknown> {
  return { schema, family, id, scope, revision, content };
}

function normalizeRevision(
  value: JsonValue | undefined,
  path: string,
  expected: ReconfirmationScope,
  limits: ResolvedSurgicalReconfirmationLimits,
): NormalizedRevision {
  const record = asRecord(value, path, "INVALID_REFERENCE");
  assertKeys(record, REVISION_KEYS, path, "INVALID_REFERENCE");
  const family = knownFamily(requiredValue(record, "family", path, "INVALID_REFERENCE"), `${path}.family`);
  const id = identifier(aliasRequired(record, ["id", "artifactId", "sourceId"], path, "INVALID_REFERENCE"), `${path}.id`, "INVALID_REFERENCE");
  const scope = normalizeScope(requiredValue(record, "scope", path, "INVALID_REFERENCE"), `${path}.scope`);
  assertScope(scope, expected, `${path}.scope`);
  const revision = integer(aliasRequired(record, ["revision", "sourceRevision"], path, "INVALID_REFERENCE"), `${path}.revision`, "INVALID_REFERENCE");
  const content = aliasRequired(record, ["content", "payload", "data"], path, "INVALID_REFERENCE");
  const payload = revisionPayload("exact-revision/v1", family, id, scope, revision, content);
  const computed = fingerprintWithLimits(payload, limits);
  const claimed = aliases(record, ["fingerprint", "sourceFingerprint"], path, "INVALID_REFERENCE");
  if (claimed !== undefined) {
    const claim = hexFingerprint(claimed, `${path}.fingerprint`);
    if (claim !== computed) fail("FINGERPRINT_MISMATCH", `${path}.fingerprint`, "Revision fingerprint does not bind to exact content.");
  }
  return Object.freeze({ family, id, scope, revision, content, fingerprint: computed });
}

function stakeholderRevisionPayload(
  kind: StakeholderKind,
  actor: StakeholderActor,
  id: string,
  scope: ReconfirmationScope,
  revision: number,
  terms: JsonValue,
): Record<string, unknown> {
  return { schema: "stakeholder-revision/v1", kind, actor, id, scope, revision, terms };
}

function normalizeStakeholderRevision(
  value: JsonValue | undefined,
  path: string,
  expected: ReconfirmationScope,
  kind: StakeholderKind,
  actor: StakeholderActor,
  limits: ResolvedSurgicalReconfirmationLimits,
): NormalizedStakeholderRevision {
  const record = asRecord(value, path, "INVALID_STAKEHOLDER");
  assertKeys(record, STAKEHOLDER_REVISION_KEYS, path, "INVALID_STAKEHOLDER");
  const id = identifier(requiredValue(record, "id", path, "INVALID_STAKEHOLDER"), `${path}.id`, "INVALID_STAKEHOLDER");
  const scope = normalizeScope(requiredValue(record, "scope", path, "INVALID_STAKEHOLDER"), `${path}.scope`);
  assertScope(scope, expected, `${path}.scope`);
  const revision = integer(requiredValue(record, "revision", path, "INVALID_STAKEHOLDER"), `${path}.revision`, "INVALID_STAKEHOLDER");
  const terms = requiredValue(record, "terms", path, "INVALID_STAKEHOLDER");
  const computed = fingerprintWithLimits(stakeholderRevisionPayload(kind, actor, id, scope, revision, terms), limits);
  const claimed = optionalValue(record, "fingerprint");
  if (claimed !== undefined) {
    const claim = hexFingerprint(claimed, `${path}.fingerprint`);
    if (claim !== computed) fail("FINGERPRINT_MISMATCH", `${path}.fingerprint`, "Stakeholder fingerprint does not bind to exact terms.");
  }
  return Object.freeze({ id, scope, revision, terms, fingerprint: computed });
}

function normalizeActor(value: JsonValue | undefined, path: string): StakeholderActor {
  const record = asRecord(value, path, "INVALID_STAKEHOLDER");
  assertKeys(record, ACTOR_KEYS, path, "INVALID_STAKEHOLDER");
  return Object.freeze({
    id: identifier(requiredValue(record, "id", path, "INVALID_STAKEHOLDER"), `${path}.id`, "INVALID_STAKEHOLDER"),
    role: stringValue(requiredValue(record, "role", path, "INVALID_STAKEHOLDER"), `${path}.role`, "INVALID_STAKEHOLDER"),
  });
}

function normalizeRule(value: JsonValue | undefined, path: string): NormalizedRule {
  const record = asRecord(value, path, "INVALID_POLICY");
  assertKeys(record, RULE_KEYS, path, "INVALID_POLICY");
  const rawPath = stringValue(requiredValue(record, "path", path, "INVALID_POLICY"), `${path}.path`, "INVALID_POLICY");
  const segments = rawPath.split(".");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    fail("INVALID_POLICY", `${path}.path`, "Material paths must be non-empty safe dot paths.");
  }
  const canonicalPath = segments.join(".");
  const kind = enumValue(requiredValue(record, "kind", path, "INVALID_POLICY"), MATERIAL_TERM_KINDS, `${path}.kind`, "INVALID_POLICY");
  const materiality = enumValue(
    aliases(record, ["materiality", "classification"], path, "INVALID_POLICY"),
    MATERIALITY_POLICIES,
    `${path}.materiality`,
    "INVALID_POLICY",
  );
  return Object.freeze({ path: canonicalPath, segments, kind, materiality });
}

function normalizePolicy(value: JsonValue | undefined, expectedFamily: ReconfirmationFamily, limits: ResolvedSurgicalReconfirmationLimits): NormalizedPolicy {
  const record = asRecord(value, "materialPolicy", "INVALID_POLICY");
  assertKeys(record, POLICY_KEYS, "materialPolicy", "INVALID_POLICY");
  const family = knownFamily(requiredValue(record, "family", "materialPolicy", "INVALID_POLICY"), "materialPolicy.family");
  if (family !== expectedFamily) fail("SOURCE_BINDING_MISMATCH", "materialPolicy.family", "Policy family does not match the changed source.");
  const version = integer(requiredValue(record, "version", "materialPolicy", "INVALID_POLICY"), "materialPolicy.version", "INVALID_POLICY", 1);
  const rulesValue = aliasRequired(record, ["rules", "terms", "materialTerms"], "materialPolicy", "INVALID_POLICY");
  if (!Array.isArray(rulesValue)) fail("INVALID_POLICY", "materialPolicy.rules", "Material rules must be a dense array.");
  if (rulesValue.length > 512) fail("BOUNDS_EXCEEDED", "materialPolicy.rules", "Material rule bound exceeded.");
  const rules = rulesValue.map((rule, index) => normalizeRule(rule, `materialPolicy.rules[${index}]`));
  const byPath = new Map<string, NormalizedRule>();
  for (const rule of rules) {
    const existing = byPath.get(rule.path);
    if (existing !== undefined) {
      if (existing.kind !== rule.kind || existing.materiality !== rule.materiality) {
        fail("CONFLICTING_POLICY", `materialPolicy.rules.${rule.path}`, "Material policy entries conflict.");
      }
      fail("CONFLICTING_POLICY", `materialPolicy.rules.${rule.path}`, "Material policy path is repeated.");
    }
    byPath.set(rule.path, rule);
  }
  const orderedRules = stableSort([...rules], (left, right) => {
    const lengthOrder = right.segments.length - left.segments.length;
    return lengthOrder !== 0 ? lengthOrder : compareStableStrings(left.path, right.path);
  });
  const fingerprint = fingerprintWithLimits({ schema: "material-policy/v1", family, version, rules: stableSort([...rules], (left, right) => compareStableStrings(left.path, right.path)).map(({ path, kind, materiality }) => ({ path, kind, materiality })) }, limits);
  return Object.freeze({ family, version, rules: Object.freeze(orderedRules), fingerprint });
}

function normalizeStakeholder(
  value: JsonValue | undefined,
  path: string,
  command: Pick<NormalizedCommand, "scope" | "beforeArtifact" | "limits">,
  limits: ResolvedSurgicalReconfirmationLimits,
): NormalizedStakeholder {
  const record = asRecord(value, path, "INVALID_STAKEHOLDER");
  assertKeys(record, STAKEHOLDER_KEYS, path, "INVALID_STAKEHOLDER");
  const id = identifier(requiredValue(record, "id", path, "INVALID_STAKEHOLDER"), `${path}.id`, "INVALID_STAKEHOLDER");
  const actor = normalizeActor(requiredValue(record, "actor", path, "INVALID_STAKEHOLDER"), `${path}.actor`);
  const kind = enumValue(requiredValue(record, "kind", path, "INVALID_STAKEHOLDER"), STAKEHOLDER_KINDS, `${path}.kind`, "INVALID_STAKEHOLDER");
  const source = normalizeReference(requiredValue(record, "source", path, "INVALID_STAKEHOLDER"), `${path}.source`, command.scope);
  if (source.family !== command.beforeArtifact.family || source.id !== command.beforeArtifact.id) {
    fail("SOURCE_BINDING_MISMATCH", `${path}.source`, "Stakeholder is not bound to the exact changed source.");
  }
  const before = normalizeStakeholderRevision(requiredValue(record, "before", path, "INVALID_STAKEHOLDER"), `${path}.before`, command.scope, kind, actor, limits);
  const after = normalizeStakeholderRevision(requiredValue(record, "after", path, "INVALID_STAKEHOLDER"), `${path}.after`, command.scope, kind, actor, limits);
  if (before.id !== after.id || before.id !== id) fail("SOURCE_BINDING_MISMATCH", `${path}.before.id`, "Prior and proposed identities must match the stakeholder binding.");
  if (after.revision <= before.revision) fail("REVISION_NOT_ADVANCED", `${path}.after.revision`, "Proposed stakeholder revision must advance the prior revision.");
  const authority = normalizeAuthority(aliases(record, ["authority", "authorityEvidence"], path, "INVALID_STAKEHOLDER"), `${path}.authority`, command.scope, limits);
  const purpose = normalizePurpose(aliases(record, ["purpose", "purposeEvidence"], path, "INVALID_STAKEHOLDER"), `${path}.purpose`, command.scope, limits);
  const retention = normalizeRetention(aliases(record, ["retention", "retentionEvidence"], path, "INVALID_STAKEHOLDER"), `${path}.retention`, command.scope, limits);
  const receiptId = fingerprintWithLimits({ schema: "reconfirmation-receipt-id/v1", scope: command.scope, stakeholderId: id, kind, actor, source }, limits);
  return Object.freeze({ id, actor, kind, source, before, after, authority, purpose, retention, receiptId });
}

function normalizeEdge(value: JsonValue | undefined, path: string, expected: ReconfirmationScope): NormalizedEdge {
  const record = asRecord(value, path, "INVALID_REFERENCE");
  assertKeys(record, EDGE_KEYS, path, "INVALID_REFERENCE");
  const from = normalizeReference(requiredValue(record, "from", path, "INVALID_REFERENCE"), `${path}.from`, expected);
  const to = normalizeReference(requiredValue(record, "to", path, "INVALID_REFERENCE"), `${path}.to`, expected);
  const relation = enumValue(requiredValue(record, "relation", path, "INVALID_REFERENCE"), GRAPH_RELATIONS, `${path}.relation`, "INVALID_REFERENCE");
  return Object.freeze({ from, to, relation });
}

function resolveLimits(value: JsonValue | undefined): ResolvedLimits {
  const record = value === undefined ? undefined : asRecord(value, "limits", "INVALID_LIMIT");
  if (record !== undefined) assertKeys(record, LIMIT_KEYS, "limits", "INVALID_LIMIT");
  const get = (key: keyof typeof DEFAULT_SURGICAL_RECONFIRMATION_LIMITS): number => {
    const candidate = record === undefined ? undefined : optionalValue(record, key);
    const fallback = DEFAULT_SURGICAL_RECONFIRMATION_LIMITS[key];
    const result = candidate === undefined ? fallback : integer(candidate, `limits.${key}`, "INVALID_LIMIT", 1);
    const absolute = ABSOLUTE_SURGICAL_RECONFIRMATION_LIMITS[key];
    if (result > absolute) fail("INVALID_LIMIT", `limits.${key}`, "Requested limit exceeds the absolute bound.");
    return result;
  };
  const canonical = resolveCanonicalLimits(value === undefined ? undefined : {
    maxInputDepth: get("maxInputDepth"),
    maxInputNodes: get("maxInputNodes"),
    maxStringBytes: get("maxStringBytes"),
    maxCanonicalBytes: get("maxCanonicalBytes"),
  });
  return Object.freeze({
    ...canonical,
    maxStakeholders: get("maxStakeholders"),
    maxEvidenceRecords: get("maxEvidenceRecords"),
    maxMaterialTermsPerReceipt: get("maxMaterialTermsPerReceipt"),
    maxGraphNodes: get("maxGraphNodes"),
    maxGraphEdges: get("maxGraphEdges"),
    maxGraphDepth: get("maxGraphDepth"),
    maxReceipts: get("maxReceipts"),
  });
}

function normalizeCommand(raw: SurgicalReconfirmationCommand): NormalizedCommand {
  const absoluteCanonical = resolveCanonicalLimits(ABSOLUTE_SURGICAL_RECONFIRMATION_LIMITS);
  const snap = snapshotPlainData(raw, absoluteCanonical, "command");
  const command = asRecord(snap, "command", "INVALID_COMMAND");
  assertKeys(command, COMMAND_KEYS, "command", "INVALID_COMMAND");
  const schema = optionalValue(command, "schema");
  if (schema !== undefined && schema !== SURGICAL_RECONFIRMATION_SCHEMA) fail("INVALID_COMMAND", "command.schema", "Unsupported schema.");
  const commandType = optionalValue(command, "commandType");
  if (commandType !== undefined && commandType !== SURGICAL_RECONFIRMATION_COMMAND) fail("INVALID_COMMAND", "command.commandType", "Unsupported command type.");
  const commandId = identifier(requiredValue(command, "commandId", "command", "INVALID_COMMAND"), "command.commandId", "INVALID_COMMAND");
  const idempotencyKey = identifier(optionalValue(command, "idempotencyKey") ?? commandId, "command.idempotencyKey", "INVALID_COMMAND");
  const scope = normalizeScope(requiredValue(command, "scope", "command", "INVALID_COMMAND"), "command.scope");
  const asOf = parseInstant(requiredValue(command, "asOf", "command", "INVALID_COMMAND"), "command.asOf");
  const purpose = stringValue(requiredValue(command, "purpose", "command", "INVALID_COMMAND"), "command.purpose", "INVALID_COMMAND");
  const limits = resolveLimits(optionalValue(command, "limits"));
  const beforeArtifact = normalizeRevision(aliasRequired(command, ["beforeArtifact", "beforeSource", "beforeRevision", "before"], "command", "INVALID_COMMAND"), "command.beforeArtifact", scope, limits);
  const afterArtifact = normalizeRevision(aliasRequired(command, ["afterArtifact", "afterSource", "afterRevision", "after"], "command", "INVALID_COMMAND"), "command.afterArtifact", scope, limits);
  if (beforeArtifact.family !== afterArtifact.family || beforeArtifact.id !== afterArtifact.id) fail("SOURCE_BINDING_MISMATCH", "command.afterArtifact", "Before and after sources must identify one exact record.");
  if (afterArtifact.revision <= beforeArtifact.revision) fail("REVISION_NOT_ADVANCED", "command.afterArtifact.revision", "Changed source revision must advance the prior revision.");
  const policy = normalizePolicy(requiredValue(command, "materialPolicy", "command", "INVALID_POLICY"), beforeArtifact.family, limits);
  const stakeholderValue = requiredValue(command, "stakeholders", "command", "INVALID_COMMAND");
  if (!Array.isArray(stakeholderValue)) fail("INVALID_COMMAND", "command.stakeholders", "Stakeholders must be a dense array.");
  if (stakeholderValue.length > limits.maxStakeholders) fail("BOUNDS_EXCEEDED", "command.stakeholders", "Stakeholder bound exceeded.");
  const commandShell: Pick<NormalizedCommand, "scope" | "beforeArtifact" | "limits"> = { scope, beforeArtifact, limits };
  const stakeholders = stakeholderValue.map((value, index) => normalizeStakeholder(value, `command.stakeholders[${index}]`, commandShell, limits));
  const seenStakeholders = new Set<string>();
  for (const stakeholder of stakeholders) {
    if (seenStakeholders.has(stakeholder.id)) fail("CONFLICTING_EVIDENCE", `command.stakeholders.${stakeholder.id}`, "Stakeholder identity is repeated.");
    seenStakeholders.add(stakeholder.id);
  }
  const graphValue = aliases(command, ["dependencyGraph", "graph"], "command", "INVALID_COMMAND");
  let dependencyGraph: readonly NormalizedEdge[] | undefined;
  if (graphValue !== undefined) {
    if (!Array.isArray(graphValue)) fail("INVALID_COMMAND", "command.dependencyGraph", "Dependency graph must be a dense array.");
    if (graphValue.length > limits.maxGraphEdges) fail("BOUNDS_EXCEEDED", "command.dependencyGraph", "Graph edge bound exceeded.");
    dependencyGraph = Object.freeze(graphValue.map((edge, index) => normalizeEdge(edge, `command.dependencyGraph[${index}]`, scope)));
  }
  return Object.freeze({ commandId, idempotencyKey, scope, asOf, purpose, beforeArtifact, afterArtifact, policy, stakeholders: Object.freeze(stakeholders), dependencyGraph, limits });
}

function collectChangedPaths(
  before: JsonValue,
  after: JsonValue,
  segments: readonly string[] = [],
  output: ChangedPath[] = [],
  beforePresent = true,
  afterPresent = true,
): ChangedPath[] {
  if (beforePresent !== afterPresent) {
    if (segments.length === 0) fail("UNKNOWN_MATERIAL_POLICY", "materialPolicy", "The root term presence changed without a bounded material path.");
    output.push(Object.freeze({ path: segments.join("."), segments: [...segments] }));
    return output;
  }
  if (canonicalJson(before) === canonicalJson(after)) return output;
  const path = segments.join(".");
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort(compareStableStrings)) collectChangedPaths(
      hasOwn(before, key) ? before[key]! : null,
      hasOwn(after, key) ? after[key]! : null,
      [...segments, key],
      output,
      hasOwn(before, key),
      hasOwn(after, key),
    );
    return output;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let index = 0; index < before.length; index += 1) collectChangedPaths(before[index]!, after[index]!, [...segments, String(index)], output);
    return output;
  }
  if (path.length === 0) fail("UNKNOWN_MATERIAL_POLICY", "materialPolicy", "The root term changed without a bounded material path.");
  output.push(Object.freeze({ path, segments: [...segments] }));
  return output;
}

function pathMatches(rule: NormalizedRule, changed: ChangedPath): boolean {
  if (changed.segments.length < rule.segments.length) return false;
  return rule.segments.every((segment, index) => changed.segments[index] === segment);
}

function matchingRule(rules: readonly NormalizedRule[], changed: ChangedPath): NormalizedRule | undefined {
  return rules.find((rule) => pathMatches(rule, changed));
}

function presenceAt(value: JsonValue, segments: readonly string[]): Presence {
  let current: JsonValue = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { present: false };
      const index = Number(segment);
      if (index >= current.length) return { present: false };
      current = current[index]!;
      continue;
    }
    if (!isPlainRecord(current) || !hasOwn(current, segment)) return { present: false };
    current = current[segment]!;
  }
  return { present: true, value: current };
}

function canonicalTemporal(value: JsonValue, path: string, kind: MaterialTermKind): JsonValue {
  if (typeof value === "string") return parseInstant(value, path);
  if (kind !== "DATE" && kind !== "TIME") fail("INVALID_POLICY", path, "Temporal policy must compare a string or temporal object.");
  if (Array.isArray(value)) return value.map((child, index) => canonicalTemporal(child, `${path}[${index}]`, kind));
  if (!isPlainRecord(value)) fail("INVALID_DATE", path, "Temporal term is not plain data.");
  const temporalKeys = new Set(["date", "time", "start", "end", "startAt", "endAt", "startsAt", "endsAt", "at"]);
  const object: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    const child = value[key]!;
    object[key] = temporalKeys.has(key) ? canonicalTemporal(child, `${path}.${key}`, kind) : child;
  }
  return object;
}

function termEqual(left: Presence, right: Presence, rule: NormalizedRule, path: string, limits: ResolvedSurgicalReconfirmationLimits): boolean {
  const leftTemporal = (rule.kind === "DATE" || rule.kind === "TIME") && left.present
    ? canonicalTemporal(left.value!, path, rule.kind)
    : undefined;
  const rightTemporal = (rule.kind === "DATE" || rule.kind === "TIME") && right.present
    ? canonicalTemporal(right.value!, path, rule.kind)
    : undefined;
  if (left.present !== right.present) return false;
  if (!left.present || !right.present) return true;
  if (rule.kind === "DATE" || rule.kind === "TIME") {
    return canonicalJsonWithLimits(leftTemporal!, limits) === canonicalJsonWithLimits(rightTemporal!, limits);
  }
  return canonicalJsonWithLimits(left.value!, limits) === canonicalJsonWithLimits(right.value!, limits);
}

function compareTerms(
  before: JsonValue,
  after: JsonValue,
  policy: NormalizedPolicy,
  limits: ResolvedSurgicalReconfirmationLimits,
  pathPrefix: string,
): { readonly comparisons: readonly TermComparison[]; readonly changedPaths: readonly ChangedPath[] } {
  const changedPaths = collectChangedPaths(before, after);
  const comparisons: TermComparison[] = [];
  for (const changed of changedPaths) {
    const rule = matchingRule(policy.rules, changed);
    if (rule === undefined) fail("UNKNOWN_MATERIAL_POLICY", `${pathPrefix}.${changed.path}`, "Changed term has no explicit material policy.");
    const beforePresence = presenceAt(before, changed.segments);
    const afterPresence = presenceAt(after, changed.segments);
    if (!termEqual(beforePresence, afterPresence, rule, `${pathPrefix}.${changed.path}`, limits)) {
      comparisons.push(Object.freeze({ changed: true, changedPath: changed, before: beforePresence, after: afterPresence, rule }));
    }
  }
  return { comparisons: Object.freeze(comparisons), changedPaths: Object.freeze(changedPaths) };
}

function termTransitionFingerprint(
  comparison: TermComparison,
  limits: ResolvedSurgicalReconfirmationLimits,
  path: string,
): string {
  const canonicalPresence = (presence: Presence, phase: "before" | "after"): Record<string, unknown> => {
    if (!presence.present) return { present: false };
    const value = comparison.rule.kind === "DATE" || comparison.rule.kind === "TIME"
      ? canonicalTemporal(presence.value!, `${path}.${phase}`, comparison.rule.kind)
      : presence.value!;
    return { present: true, value };
  };
  return fingerprintWithLimits({
    schema: "material-term-transition/v1",
    path: comparison.changedPath.path,
    kind: comparison.rule.kind,
    materiality: comparison.rule.materiality,
    before: canonicalPresence(comparison.before, "before"),
    after: canonicalPresence(comparison.after, "after"),
  }, limits);
}

function bindStakeholderTermsToSource(
  sourceComparison: ReturnType<typeof compareTerms>,
  stakeholderComparison: ReturnType<typeof compareTerms>,
  stakeholder: NormalizedStakeholder,
  command: NormalizedCommand,
): readonly BoundTermComparison[] {
  return Object.freeze(stakeholderComparison.comparisons.map((stakeholderTerm) => {
    const path = stakeholderTerm.changedPath.path;
    const sourceTerm = sourceComparison.comparisons.find((candidate) => candidate.changedPath.path === path);
    if (
      sourceTerm === undefined ||
      sourceTerm.rule.kind !== stakeholderTerm.rule.kind ||
      sourceTerm.rule.materiality !== stakeholderTerm.rule.materiality ||
      !termEqual(sourceTerm.before, stakeholderTerm.before, stakeholderTerm.rule, `sourceBinding.${path}.before`, command.limits) ||
      !termEqual(sourceTerm.after, stakeholderTerm.after, stakeholderTerm.rule, `sourceBinding.${path}.after`, command.limits)
    ) {
      fail(
        "SOURCE_BINDING_MISMATCH",
        `command.stakeholders.${stakeholder.id}.after.terms.${path}`,
        "Stakeholder term transition does not exactly match the canonical source transition.",
      );
    }

    const sourceTransitionFingerprint = termTransitionFingerprint(sourceTerm, command.limits, `source.${path}`);
    const stakeholderTransitionFingerprint = termTransitionFingerprint(stakeholderTerm, command.limits, `stakeholder.${stakeholder.id}.${path}`);
    if (sourceTransitionFingerprint !== stakeholderTransitionFingerprint) {
      fail(
        "SOURCE_BINDING_MISMATCH",
        `command.stakeholders.${stakeholder.id}.after.terms.${path}`,
        "Stakeholder term fingerprint does not match the canonical source term fingerprint.",
      );
    }

    const sourceBindingFingerprint = fingerprintWithLimits({
      schema: "exact-source-stakeholder-term-binding/v1",
      path,
      source: {
        family: command.beforeArtifact.family,
        id: command.beforeArtifact.id,
        beforeRevision: command.beforeArtifact.revision,
        afterRevision: command.afterArtifact.revision,
        beforeFingerprint: command.beforeArtifact.fingerprint,
        afterFingerprint: command.afterArtifact.fingerprint,
        transitionFingerprint: sourceTransitionFingerprint,
      },
      stakeholder: {
        id: stakeholder.id,
        kind: stakeholder.kind,
        actor: stakeholder.actor,
        beforeRevision: stakeholder.before.revision,
        afterRevision: stakeholder.after.revision,
        beforeFingerprint: stakeholder.before.fingerprint,
        afterFingerprint: stakeholder.after.fingerprint,
        transitionFingerprint: stakeholderTransitionFingerprint,
      },
    }, command.limits);
    return Object.freeze({ ...stakeholderTerm, sourceBindingFingerprint });
  }));
}

function outputTermImpact(comparison: BoundTermComparison): MaterialTermImpact {
  const rule = comparison.rule;
  const result: MaterialTermImpact = {
    path: comparison.changedPath.path,
    kind: rule.kind,
    materiality: rule.materiality,
    sourceBindingFingerprint: comparison.sourceBindingFingerprint,
    beforePresent: comparison.before.present,
    afterPresent: comparison.after.present,
    ...(comparison.before.present ? { before: comparison.before.value } : {}),
    ...(comparison.after.present ? { after: comparison.after.value } : {}),
    reason: rule.materiality === "MATERIAL" ? "MATERIAL_TERM_CHANGED" : "NON_MATERIAL_TERM_CHANGED",
  };
  return Object.freeze(result);
}

function evidenceStatus(
  evidence: EvidenceSnapshotBase | null,
  check: () => boolean,
): EvidenceAssessment {
  if (evidence === null) return { status: "UNAVAILABLE", reasonCode: "EVIDENCE_UNAVAILABLE" };
  if (!check()) return { status: "BLOCKED", reasonCode: "EVIDENCE_BLOCKED" };
  if (evidence.status === "UNAVAILABLE") return { status: "UNAVAILABLE", reasonCode: "EVIDENCE_UNAVAILABLE" };
  if (evidence.status !== "CURRENT") return { status: "BLOCKED", reasonCode: "EVIDENCE_BLOCKED" };
  return { status: "CURRENT", reasonCode: "EVIDENCE_CURRENT" };
}

function authorityAssessment(stakeholder: NormalizedStakeholder, command: NormalizedCommand): EvidenceAssessment {
  const evidence = stakeholder.authority;
  return evidenceStatus(evidence, () => {
    if (evidence === null) return false;
    if (!sameScope(evidence.scope, command.scope) || !sameScope(evidence.record.scope, command.scope)) return false;
    if (evidence.subject.id !== stakeholder.actor.id || evidence.subject.role !== stakeholder.actor.role) return false;
    if (evidence.record.family !== stakeholder.kind || evidence.record.id !== stakeholder.before.id) return false;
    if (evidence.record.revision !== stakeholder.before.revision || evidence.record.fingerprint !== stakeholder.before.fingerprint) return false;
    if (evidence.issuedAt !== undefined && Date.parse(evidence.issuedAt) > Date.parse(command.asOf)) return false;
    if (evidence.expiresAt !== undefined && Date.parse(evidence.expiresAt) <= Date.parse(command.asOf)) return false;
    return true;
  });
}

function purposeAssessment(stakeholder: NormalizedStakeholder, command: NormalizedCommand): EvidenceAssessment {
  const evidence = stakeholder.purpose;
  return evidenceStatus(evidence, () => {
    if (evidence === null) return false;
    if (!sameScope(evidence.scope, command.scope)) return false;
    if (evidence.subject.id !== stakeholder.actor.id || evidence.subject.role !== stakeholder.actor.role) return false;
    if (evidence.purpose !== command.purpose) return false;
    if (evidence.effectiveAt !== undefined && Date.parse(evidence.effectiveAt) > Date.parse(command.asOf)) return false;
    if (evidence.expiresAt !== undefined && Date.parse(evidence.expiresAt) <= Date.parse(command.asOf)) return false;
    return true;
  });
}

function retentionAssessment(stakeholder: NormalizedStakeholder, command: NormalizedCommand): EvidenceAssessment {
  const evidence = stakeholder.retention;
  return evidenceStatus(evidence, () => {
    if (evidence === null) return false;
    if (!sameScope(evidence.scope, command.scope)) return false;
    if (evidence.subject.id !== stakeholder.actor.id || evidence.subject.role !== stakeholder.actor.role) return false;
    return Date.parse(evidence.retentionUntil) > Date.parse(command.asOf);
  });
}

function receiptStatus(
  stakeholder: NormalizedStakeholder,
  command: NormalizedCommand,
  materialComparisons: readonly TermComparison[],
): { readonly status: ReconfirmationStatus; readonly reason: string; readonly reasonCode: string } {
  const material = materialComparisons.filter((comparison) => comparison.rule.materiality === "MATERIAL");
  if (material.length === 0) {
    return {
      status: materialComparisons.length === 0 ? "UNAFFECTED" : "UNAFFECTED",
      reason: materialComparisons.length === 0 ? FIXED_REASON.unaffected : FIXED_REASON.nonMaterial,
      reasonCode: materialComparisons.length === 0 ? "NO_MATERIAL_TERM_CHANGE" : "NON_MATERIAL_CHANGE",
    };
  }
  const assessments = [authorityAssessment(stakeholder, command), purposeAssessment(stakeholder, command), retentionAssessment(stakeholder, command)];
  if (assessments.some((assessment) => assessment.status === "BLOCKED")) return { status: "BLOCKED", reason: FIXED_REASON.blocked, reasonCode: "EVIDENCE_BLOCKED" };
  if (assessments.some((assessment) => assessment.status === "UNAVAILABLE")) return { status: "UNAVAILABLE", reason: FIXED_REASON.unavailable, reasonCode: "EVIDENCE_UNAVAILABLE" };
  return { status: "REQUIRED", reason: FIXED_REASON.required, reasonCode: "MATERIAL_TERM_CHANGED" };
}

function normalizeEvidenceCount(stakeholders: readonly NormalizedStakeholder[], limits: ResolvedLimits): void {
  const count = stakeholders.reduce((total, stakeholder) => total + (stakeholder.authority ? 1 : 0) + (stakeholder.purpose ? 1 : 0) + (stakeholder.retention ? 1 : 0), 0);
  if (count > limits.maxEvidenceRecords) fail("BOUNDS_EXCEEDED", "command.stakeholders", "Evidence record bound exceeded.");
  const seen = new Map<string, string>();
  for (const stakeholder of stakeholders) {
    for (const evidence of [stakeholder.authority, stakeholder.purpose, stakeholder.retention]) {
      if (evidence === null) continue;
      const previous = seen.get(evidence.evidenceId);
      if (previous !== undefined && previous !== evidence.fingerprint) fail("CONFLICTING_EVIDENCE", `evidence.${evidence.evidenceId}`, "Evidence identity has conflicting content.");
      seen.set(evidence.evidenceId, evidence.fingerprint);
    }
  }
}

function buildGraph(command: NormalizedCommand): ReconfirmationGraph {
  const root: ReconfirmationRecordReference = Object.freeze({ family: command.beforeArtifact.family, id: command.beforeArtifact.id, scope: command.scope });
  const edges: NormalizedEdge[] = command.dependencyGraph === undefined
    ? command.stakeholders.map((stakeholder) => Object.freeze({
        from: root,
        to: Object.freeze({ family: stakeholder.kind, id: stakeholder.before.id, scope: command.scope }),
        relation: "INVALIDATES" as const,
      }))
    : [...command.dependencyGraph];
  const edgeKeys = new Set<string>();
  const adjacency = new Map<string, NormalizedEdge[]>();
  const allNodes = new Map<string, ReconfirmationRecordReference>();
  allNodes.set(referenceKey(root), root);
  for (const edge of edges) {
    const key = `${referenceKey(edge.from)}\u0000${referenceKey(edge.to)}\u0000${edge.relation}`;
    if (edgeKeys.has(key)) fail("INVALID_REFERENCE", "command.dependencyGraph", "Duplicate graph edge.");
    edgeKeys.add(key);
    allNodes.set(referenceKey(edge.from), edge.from);
    allNodes.set(referenceKey(edge.to), edge.to);
    const outgoing = adjacency.get(referenceKey(edge.from)) ?? [];
    outgoing.push(edge);
    adjacency.set(referenceKey(edge.from), outgoing);
  }
  if (allNodes.size > command.limits.maxGraphNodes) fail("BOUNDS_EXCEEDED", "command.dependencyGraph", "Graph node bound exceeded.");
  if (edges.length > command.limits.maxGraphEdges) fail("BOUNDS_EXCEEDED", "command.dependencyGraph", "Graph edge bound exceeded.");

  const state = new Map<string, "VISITING" | "VISITED">();
  const visit = (key: string): void => {
    const current = state.get(key);
    if (current === "VISITING") fail("GRAPH_CYCLE", "command.dependencyGraph", "Dependency graph contains a cycle.");
    if (current === "VISITED") return;
    state.set(key, "VISITING");
    for (const edge of adjacency.get(key) ?? []) visit(referenceKey(edge.to));
    state.set(key, "VISITED");
  };
  for (const key of [...allNodes.keys()].sort(compareStableStrings)) visit(key);

  const reachableDepth = new Map<string, number>([[referenceKey(root), 0]]);
  const queue: string[] = [referenceKey(root)];
  while (queue.length > 0) {
    const currentKey = queue.shift()!;
    const depth = reachableDepth.get(currentKey)!;
    for (const edge of adjacency.get(currentKey) ?? []) {
      const nextKey = referenceKey(edge.to);
      const nextDepth = depth + 1;
      if (nextDepth > command.limits.maxGraphDepth) fail("GRAPH_DEPTH_EXCEEDED", "command.dependencyGraph", "Reachable graph depth exceeded.");
      const prior = reachableDepth.get(nextKey);
      if (prior === undefined || nextDepth < prior) {
        reachableDepth.set(nextKey, nextDepth);
        queue.push(nextKey);
      }
    }
  }
  if (command.dependencyGraph !== undefined) {
    for (const stakeholder of command.stakeholders) {
      const key = referenceKey({ family: stakeholder.kind, id: stakeholder.before.id });
      if (!reachableDepth.has(key)) fail("SOURCE_BINDING_MISMATCH", `command.stakeholders.${stakeholder.id}`, "Stakeholder is not reachable from the changed source.");
    }
  }
  const reachableEdges: ReconfirmationGraphEdge[] = [];
  for (const edge of edges) {
    const fromDepth = reachableDepth.get(referenceKey(edge.from));
    const toDepth = reachableDepth.get(referenceKey(edge.to));
    if (fromDepth !== undefined && toDepth !== undefined && toDepth === fromDepth + 1) {
      reachableEdges.push(Object.freeze({ ...edge, depth: toDepth }));
    }
  }
  const nodes: ReconfirmationGraphNode[] = [...reachableDepth.entries()].map(([key, depth]) => {
    const reference = allNodes.get(key)!;
    return Object.freeze({ ...reference, depth });
  });
  const orderedNodes = stableSort(nodes, (left, right) => left.depth - right.depth || compareStableStrings(referenceKey(left), referenceKey(right)));
  const orderedEdges = stableSort(reachableEdges, (left, right) => compareStableStrings(referenceKey(left.from), referenceKey(right.from)) || compareStableStrings(referenceKey(left.to), referenceKey(right.to)) || compareStableStrings(left.relation, right.relation));
  const maxDepth = orderedNodes.reduce((maximum, node) => Math.max(maximum, node.depth), 0);
  const graphWithoutFingerprint = { root, nodes: orderedNodes, edges: orderedEdges, maxDepth };
  const fingerprint = fingerprintWithLimits({ schema: "reconfirmation-graph/v1", ...graphWithoutFingerprint }, command.limits);
  return deepFreeze({ ...graphWithoutFingerprint, fingerprint });
}

function aggregateStatus(receipts: readonly ReconfirmationReceipt[]): ReconfirmationStatus {
  if (receipts.some((receipt) => receipt.status === "BLOCKED")) return "BLOCKED";
  if (receipts.some((receipt) => receipt.status === "UNAVAILABLE")) return "UNAVAILABLE";
  if (receipts.some((receipt) => receipt.status === "REQUIRED")) return "REQUIRED";
  return "UNAFFECTED";
}

function buildReceipt(
  stakeholder: NormalizedStakeholder,
  command: NormalizedCommand,
  comparisons: readonly BoundTermComparison[],
): ReconfirmationReceipt {
  const materialComparisons = comparisons.filter((entry) => entry.rule.materiality === "MATERIAL");
  if (materialComparisons.length > command.limits.maxMaterialTermsPerReceipt) fail("BOUNDS_EXCEEDED", `command.stakeholders.${stakeholder.id}`, "Material-term receipt bound exceeded.");
  const state = receiptStatus(stakeholder, command, comparisons);
  const materialTerms = materialComparisons.map(outputTermImpact);
  const source = Object.freeze({
    family: command.beforeArtifact.family,
    id: command.beforeArtifact.id,
    beforeRevision: command.beforeArtifact.revision,
    afterRevision: command.afterArtifact.revision,
    beforeFingerprint: command.beforeArtifact.fingerprint,
    afterFingerprint: command.afterArtifact.fingerprint,
  });
  const receiptWithoutFingerprint = {
    receiptId: stakeholder.receiptId,
    stakeholderId: stakeholder.id,
    targetActorId: stakeholder.actor.id,
    targetRole: stakeholder.actor.role,
    kind: stakeholder.kind,
    source,
    prior: stakeholder.before,
    proposed: stakeholder.after,
    materialTerms,
    authority: stakeholder.authority,
    purpose: stakeholder.purpose,
    retention: stakeholder.retention,
    status: state.status,
    reason: state.reason,
    reasonCode: state.reasonCode,
  } satisfies Omit<ReconfirmationReceipt, "fingerprint">;
  const fingerprint = fingerprintWithLimits({ schema: "reconfirmation-receipt/v1", ...receiptWithoutFingerprint }, command.limits);
  return deepFreeze({ ...receiptWithoutFingerprint, fingerprint });
}

/**
 * Pure surgical reconfirmation preflight. It computes a bounded proposal and
 * immutable receipts only; it never changes an approval or commitment, sends,
 * persists, invokes a callback, or carries authority into a new revision.
 */
export function deriveSurgicalReconfirmation(command: SurgicalReconfirmationCommand): SurgicalReconfirmationPlan {
  const normalized = normalizeCommand(command);
  normalizeEvidenceCount(normalized.stakeholders, normalized.limits);
  const sourceComparison = compareTerms(
    normalized.beforeArtifact.content,
    normalized.afterArtifact.content,
    normalized.policy,
    normalized.limits,
    "source",
  );
  const graph = buildGraph(normalized);
  const reachableStakeholders = normalized.stakeholders.filter((stakeholder) => graph.nodes.some((node) => node.family === stakeholder.kind && node.id === stakeholder.before.id));
  const receipts = stableSort(reachableStakeholders.map((stakeholder) => {
    const comparison = compareTerms(stakeholder.before.terms, stakeholder.after.terms, normalized.policy, normalized.limits, `stakeholder.${stakeholder.id}.terms`);
    const boundComparisons = bindStakeholderTermsToSource(sourceComparison, comparison, stakeholder, normalized);
    return buildReceipt(stakeholder, normalized, boundComparisons);
  }), (left, right) => compareStableStrings(left.stakeholderId, right.stakeholderId));
  if (receipts.length > normalized.limits.maxReceipts) fail("BOUNDS_EXCEEDED", "receipts", "Receipt bound exceeded.");
  const contentChanged = !canonicalEqual(normalized.beforeArtifact.content, normalized.afterArtifact.content, normalized.limits);
  const planWithoutFingerprint = {
    schema: SURGICAL_RECONFIRMATION_SCHEMA,
    commandType: SURGICAL_RECONFIRMATION_COMMAND,
    commandId: normalized.commandId,
    idempotencyKey: normalized.idempotencyKey,
    scope: normalized.scope,
    asOf: normalized.asOf,
    purpose: normalized.purpose,
    source: {
      family: normalized.beforeArtifact.family,
      id: normalized.beforeArtifact.id,
      beforeRevision: normalized.beforeArtifact.revision,
      afterRevision: normalized.afterArtifact.revision,
      beforeFingerprint: normalized.beforeArtifact.fingerprint,
      afterFingerprint: normalized.afterArtifact.fingerprint,
      contentChanged,
    },
    materialPolicy: {
      family: normalized.policy.family,
      version: normalized.policy.version,
      fingerprint: normalized.policy.fingerprint,
    },
    graph,
    receipts,
    status: aggregateStatus(receipts),
  } satisfies Omit<SurgicalReconfirmationPlan, "fingerprint">;
  const fingerprint = fingerprintWithLimits({ ...planWithoutFingerprint }, normalized.limits);
  return deepFreeze({ ...planWithoutFingerprint, fingerprint });
}

export const planSurgicalReconfirmation = deriveSurgicalReconfirmation;
export const preflightSurgicalReconfirmation = deriveSurgicalReconfirmation;
export const evaluateSurgicalReconfirmation = deriveSurgicalReconfirmation;
export const deriveReconfirmationPlan = deriveSurgicalReconfirmation;

export function fingerprintRevision(revision: {
  readonly family: string;
  readonly id: string;
  readonly scope: ReconfirmationScope;
  readonly revision: number;
  readonly content: JsonValue;
}): string {
  return fingerprintWithLimits(revisionPayload("exact-revision/v1", revision.family, revision.id, revision.scope, revision.revision, revision.content), resolveCanonicalLimits(undefined));
}

export function fingerprintStakeholderRevision(revision: {
  readonly kind: StakeholderKind;
  readonly actor: StakeholderActor;
  readonly id: string;
  readonly scope: ReconfirmationScope;
  readonly revision: number;
  readonly terms: JsonValue;
}): string {
  return fingerprintWithLimits(stakeholderRevisionPayload(revision.kind, revision.actor, revision.id, revision.scope, revision.revision, revision.terms), resolveCanonicalLimits(undefined));
}

export function fingerprintAuthorityEvidence(evidence: Omit<AuthorityEvidenceInput, "fingerprint">): string {
  return fingerprintWithLimits({
    schema: "authority-evidence/v1",
    evidenceId: evidence.evidenceId,
    version: evidence.version,
    scope: evidence.scope,
    status: evidence.status,
    subject: evidence.subject,
    record: evidence.record,
    ...(evidence.issuedAt === undefined ? {} : { issuedAt: parseInstant(evidence.issuedAt, "authority.issuedAt") }),
    ...(evidence.expiresAt === undefined ? {} : { expiresAt: parseInstant(evidence.expiresAt, "authority.expiresAt") }),
  }, resolveCanonicalLimits(undefined));
}

export function fingerprintPurposeEvidence(evidence: Omit<PurposeEvidenceInput, "fingerprint">): string {
  return fingerprintWithLimits({
    schema: "purpose-evidence/v1",
    evidenceId: evidence.evidenceId,
    version: evidence.version,
    scope: evidence.scope,
    status: evidence.status,
    subject: evidence.subject,
    purpose: evidence.purpose,
    ...(evidence.effectiveAt === undefined ? {} : { effectiveAt: parseInstant(evidence.effectiveAt, "purpose.effectiveAt") }),
    ...(evidence.expiresAt === undefined ? {} : { expiresAt: parseInstant(evidence.expiresAt, "purpose.expiresAt") }),
  }, resolveCanonicalLimits(undefined));
}

export function fingerprintRetentionEvidence(evidence: Omit<RetentionEvidenceInput, "fingerprint">): string {
  return fingerprintWithLimits({
    schema: "retention-evidence/v1",
    evidenceId: evidence.evidenceId,
    version: evidence.version,
    scope: evidence.scope,
    status: evidence.status,
    subject: evidence.subject,
    retentionUntil: parseInstant(evidence.retentionUntil, "retention.retentionUntil"),
    policy: evidence.policy,
  }, resolveCanonicalLimits(undefined));
}

export function fingerprintPlan(plan: Omit<SurgicalReconfirmationPlan, "fingerprint">): string {
  return fingerprintWithLimits({ ...plan }, resolveCanonicalLimits(undefined));
}
