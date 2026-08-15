import { isProxy } from "node:util/types";

import {
  canonicalJson,
  compareStableStrings,
  deepFreeze,
  fingerprint,
  isKnownFamily,
  isRecordObject,
  outputFamily,
  recordKey,
  sameScope,
  scopeKey,
  stableSort,
  utf8ByteLength,
} from "./canonical";
import {
  CHANGE_RADIUS_COMMAND_TYPE,
  CHANGE_RADIUS_FAMILIES,
  CHANGE_RADIUS_LIMITS,
  CHANGE_RADIUS_SCHEMA_VERSION,
  ChangeRadiusError,
  MATERIALITIES,
  type AffectedRecord,
  type ChangeRadiusErrorCode,
  type ChangeRadiusFamily,
  type ChangeRadiusImpactAssertion,
  type ChangeRadiusPreflightResult,
  type ChangeRadiusPolicy,
  type ChangeRadiusRecordReference,
  type ChangeRadiusScope,
  type ChangeRadiusSourceRecord,
  type ExactBeforeSourceVector,
  type ImpactEdge,
  type ImpactGraph,
  type ImpactReason,
  type MaterialTermChange,
  type MaterialTermComparison,
  type Materiality,
  type ProposedChange,
  type ProposedChangeCommandEnvelope,
  type ProposedImpactEdge,
  type SourceVectorExpectation,
} from "./types";
import {
  canonicalMaterialTermChange,
  canonicalMaterialTerms,
  compareMaterialTerms,
  maxMateriality,
  materialityRank,
} from "./material-terms";

interface NormalizedSourceRecord {
  readonly raw: ChangeRadiusSourceRecord;
  readonly family: string;
  readonly recordId: string;
  readonly scope: ChangeRadiusScope;
  readonly revision: number;
  readonly sourceFingerprint: string;
  readonly kind?: string;
  readonly terms?: unknown;
  readonly payload?: unknown;
  readonly baselineAvailable: boolean;
  readonly dependents: readonly NormalizedReference[];
}

interface NormalizedReference {
  readonly family: string;
  readonly recordId: string;
  readonly scope: ChangeRadiusScope;
  readonly relation: string;
}

interface NormalizedEdge {
  readonly from: NormalizedReference;
  readonly to: NormalizedReference;
  readonly relation: string;
  readonly affected?: boolean;
  readonly materiality?: Materiality;
  readonly reasonCode?: string;
}

interface NormalizedVector {
  readonly raw: InputRecord;
  readonly vectorId: string;
  readonly scope: ChangeRadiusScope;
  readonly revision: number;
  readonly records: readonly NormalizedSourceRecord[];
  readonly byKey: ReadonlyMap<string, NormalizedSourceRecord>;
  readonly fingerprint: string;
  readonly claimedFingerprints: readonly string[];
}

interface RootChange {
  readonly key: string;
  readonly family: string;
  readonly recordId: string;
  readonly kind?: string;
  readonly source?: NormalizedSourceRecord;
  readonly comparison?: MaterialTermComparison;
  readonly beforeKnown: boolean;
  readonly beforeValue?: unknown;
  readonly afterValue?: unknown;
  readonly reasonCode: string;
  readonly depth: number;
  readonly sourceFingerprint: string;
  readonly expectedAffected?: boolean;
}

interface NodeAccumulator {
  readonly key: string;
  readonly family: string;
  readonly recordId: string;
  readonly source?: NormalizedSourceRecord;
  readonly kind?: string;
  depth: number;
  materiality: Materiality;
  reasonCodes: Set<string>;
  sourceFingerprints: Set<string>;
  changedTerms: Map<string, MaterialTermChange>;
  upstreamRecordIds: Set<string>;
  beforeFingerprint?: string;
  afterFingerprint?: string;
  primaryReasonCode: string;
  sourceFamily?: string;
}

interface TraversalContext {
  readonly rootKey: string;
  readonly rootMateriality: Materiality;
  readonly rootTermKinds: ReadonlySet<string>;
  readonly rootChangedTerms: readonly MaterialTermChange[];
}

const AUTHORITY_KEYS = new Set([
  "authority",
  "authoritative",
  "isAuthoritative",
  "nonAuthoritative",
  "authorized",
  "authorization",
  "auth",
  "capability",
  "capabilities",
  "caller",
  "actor",
  "principal",
  "permission",
  "permissions",
  "approved",
  "approval",
  "override",
  "bypass",
  "force",
  "apply",
  "applyNow",
  "mutate",
  "mutation",
  "execute",
  "executeNow",
  "send",
  "sendNow",
  "canApply",
  "canSend",
  "canMutate",
  "mutatesState",
  "applied",
  "sent",
  "publish",
  "dispatch",
  "approvedBy",
  "decision",
  "outcome",
]);

const DEFAULT_RELATION = "depends-on";
const ACCEPTED_COMMAND_TYPES = new Set([
  CHANGE_RADIUS_COMMAND_TYPE,
  "CHANGE_RADIUS",
  "CHANGE_RADIUS_PROPOSAL",
  "PROPOSED_CHANGE",
  "PROPOSED_CHANGE_RADIUS",
]);

type InputRecord = Record<string, unknown>;

const SOURCE_VECTOR_KEYS = new Set([
  "vectorId",
  "sourceVectorId",
  "id",
  "scope",
  "workspaceId",
  "eventId",
  "revision",
  "sourceRevision",
  "asOfRevision",
  "records",
  "sourceRecords",
  "fingerprint",
  "sourceFingerprint",
  "currentFingerprint",
  "stale",
  "isStale",
  "currentRevision",
  "status",
]);

const EXPECTATION_KEYS = new Set(["vectorId", "revision", "fingerprint", "sourceFingerprint"]);

const STANDARD_OBJECT_PROTOTYPE_KEYS = new Set([
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "hasOwnProperty",
  "__lookupGetter__",
  "__lookupSetter__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "__proto__",
  "toLocaleString",
]);

function assertKnownKeys(value: InputRecord, allowed: ReadonlySet<string>, path: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("INVALID_COMMAND", "Symbol keys are not accepted.", path);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("INVALID_COMMAND", `Unknown key '${key}' is not accepted.`, `${path}.${key}`);
  }
}

function own(value: InputRecord, key: string): { readonly present: boolean; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return { present: false, value: undefined };
  return { present: true, value: dataDescriptorValue(descriptor, key, false) };
}

function assertClaimString(value: unknown, path: string): string {
  return assertString(value, path);
}

function assertClaimRevision(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("INVALID_COMMAND", `${path} must be a non-negative safe integer.`, path);
  }
  return value;
}

function assertClaimBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("INVALID_COMMAND", `${path} must be a boolean.`, path);
  return value;
}

function sameClaimValue(left: unknown, right: unknown, path: string): boolean {
  try {
    return canonicalOptional(left) === canonicalOptional(right);
  } catch {
    fail("INVALID_COMMAND", "Equivalent aliases must contain canonical JSON values.", path);
  }
}

function equivalentStringClaim(
  value: InputRecord,
  aliases: readonly string[],
  path: string,
  conflictCode: ChangeRadiusErrorCode = "INVALID_COMMAND",
): string | undefined {
  let resolved: string | undefined;
  let resolvedKey: string | undefined;
  for (const key of aliases) {
    const claim = own(value, key);
    if (!claim.present) continue;
    const candidate = assertClaimString(claim.value, `${path}.${key}`);
    if (resolved !== undefined && candidate !== resolved) {
      fail(conflictCode, `Aliases '${resolvedKey}' and '${key}' disagree.`, `${path}.${key}`);
    }
    resolved = candidate;
    resolvedKey = key;
  }
  return resolved;
}

function equivalentRevisionClaim(
  value: InputRecord,
  aliases: readonly string[],
  path: string,
  conflictCode: ChangeRadiusErrorCode = "INVALID_COMMAND",
): number | undefined {
  let resolved: number | undefined;
  let resolvedKey: string | undefined;
  for (const key of aliases) {
    const claim = own(value, key);
    if (!claim.present) continue;
    const candidate = assertClaimRevision(claim.value, `${path}.${key}`);
    if (resolved !== undefined && candidate !== resolved) {
      fail(conflictCode, `Aliases '${resolvedKey}' and '${key}' disagree.`, `${path}.${key}`);
    }
    resolved = candidate;
    resolvedKey = key;
  }
  return resolved;
}

function equivalentValueClaim(
  value: InputRecord,
  aliases: readonly string[],
  path: string,
  conflictCode: ChangeRadiusErrorCode = "INVALID_COMMAND",
): { readonly present: boolean; readonly value: unknown } {
  let resolved: { readonly present: boolean; readonly value: unknown } = { present: false, value: undefined };
  let resolvedKey: string | undefined;
  for (const key of aliases) {
    const claim = own(value, key);
    if (!claim.present) continue;
    if (claim.value === undefined) fail("INVALID_COMMAND", `${path}.${key} must not be undefined.`, `${path}.${key}`);
    if (resolved.present && !sameClaimValue(resolved.value, claim.value, `${path}.${key}`)) {
      fail(conflictCode, `Aliases '${resolvedKey}' and '${key}' disagree.`, `${path}.${key}`);
    }
    resolved = claim;
    resolvedKey = key;
  }
  return resolved;
}

function assertExpectationObject(value: unknown, path: string): InputRecord {
  if (!isRecordObject(value)) fail("INVALID_COMMAND", `${path} must be an object.`, path);
  assertKnownKeys(value, EXPECTATION_KEYS, path);
  return value;
}

function fail(code: ChangeRadiusErrorCode, message: string, path?: string): never {
  throw new ChangeRadiusError(code, message, path);
}

function canonicalOptional(value: unknown): string {
  return value === undefined ? "__undefined__" : canonicalJson(value);
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > CHANGE_RADIUS_LIMITS.maxStringBytes) {
    fail("INVALID_COMMAND", `${name} must be a bounded non-empty string.`, name);
  }
  return value;
}

function assertScope(value: unknown, name: string): ChangeRadiusScope {
  if (!isRecordObject(value)) fail("INVALID_SCOPE", `${name} must be an object.`, name);
  assertKnownKeys(value, new Set(["workspaceId", "eventId"]), name);
  const workspaceId = assertClaimString(own(value, "workspaceId").value, `${name}.workspaceId`);
  const eventId = assertClaimString(own(value, "eventId").value, `${name}.eventId`);
  return { workspaceId, eventId };
}

function commandScope(command: ProposedChangeCommandEnvelope): ChangeRadiusScope {
  const value = command as InputRecord;
  const nestedScope = own(value, "scope");
  const topWorkspace = own(value, "workspaceId");
  const topEvent = own(value, "eventId");
  const hasTopLevelScope = topWorkspace.present || topEvent.present;
  const declaredTopLevel = hasTopLevelScope
    ? assertScope({ workspaceId: topWorkspace.value, eventId: topEvent.value }, "scope")
    : undefined;
  const declaredNested = nestedScope.present ? assertScope(nestedScope.value, "scope") : undefined;
  if (declaredNested && declaredTopLevel && !sameScope(declaredNested, declaredTopLevel)) {
    fail("SCOPE_MISMATCH", "Top-level and nested command scopes disagree.", "scope");
  }
  if (declaredNested) return declaredNested;
  if (declaredTopLevel) return declaredTopLevel;
  fail("INVALID_SCOPE", "A command scope is required.", "scope");
}

function sourceVectorScope(value: InputRecord, path: string): ChangeRadiusScope {
  const nestedScopeClaim = own(value, "scope");
  const topWorkspaceClaim = own(value, "workspaceId");
  const topEventClaim = own(value, "eventId");
  const hasTopLevelScope = topWorkspaceClaim.present || topEventClaim.present;
  const topScope = hasTopLevelScope
    ? assertScope({ workspaceId: topWorkspaceClaim.value, eventId: topEventClaim.value }, `${path}.scope`)
    : undefined;
  const nestedScope = nestedScopeClaim.present ? assertScope(nestedScopeClaim.value, `${path}.scope`) : undefined;
  if (nestedScope && topScope && !sameScope(nestedScope, topScope)) {
    fail("SCOPE_MISMATCH", "Top-level and nested source-vector scopes disagree.", `${path}.scope`);
  }
  const resolved = nestedScope ?? topScope;
  if (!resolved) fail("INVALID_SCOPE", "Source vector requires a scope.", `${path}.scope`);
  return resolved;
}

function assertSameScope(expected: ChangeRadiusScope, actual: ChangeRadiusScope, path: string): void {
  if (!sameScope(expected, actual)) fail("SCOPE_MISMATCH", "Every source and impact record must share the command scope.", path);
}

function dataDescriptorValue(descriptor: PropertyDescriptor | undefined, path: string, requireEnumerable: boolean): unknown {
  if (descriptor === undefined) {
    fail("INVALID_COMMAND", "Accessor properties are not accepted.", path);
  }
  const valueDescriptor = Object.getOwnPropertyDescriptor(descriptor, "value");
  if (valueDescriptor === undefined) {
    fail("INVALID_COMMAND", "Accessor properties are not accepted.", path);
  }
  if (requireEnumerable && descriptor.enumerable !== true) {
    fail("INVALID_COMMAND", "Non-enumerable data properties are not accepted.", path);
  }
  return valueDescriptor.value;
}

function assertUnpollutedObjectPrototype(path: string): void {
  const inheritedKeys = Reflect.ownKeys(Object.prototype);
  if (
    inheritedKeys.length !== STANDARD_OBJECT_PROTOTYPE_KEYS.size
    || inheritedKeys.some((key) => typeof key !== "string" || !STANDARD_OBJECT_PROTOTYPE_KEYS.has(key))
  ) {
    fail("INVALID_COMMAND", "Inherited command fields are not accepted.", path);
  }
}

function snapshotPlainDataValue(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number },
  ancestors: WeakSet<object>,
): unknown {
  if (depth > CHANGE_RADIUS_LIMITS.maxInputDepth) fail("UNBOUNDED_GRAPH", "Input nesting bound exceeded.", path);
  state.nodes += 1;
  if (state.nodes > CHANGE_RADIUS_LIMITS.maxInputNodes) fail("UNBOUNDED_GRAPH", "Input node bound exceeded.", path);
  if (typeof value === "string" && utf8ByteLength(value) > CHANGE_RADIUS_LIMITS.maxStringBytes) {
    fail("UNBOUNDED_GRAPH", "Input string bound exceeded.", path);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    fail("INVALID_COMMAND", "Non-finite numbers are not accepted.", path);
  }
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") {
    fail("INVALID_COMMAND", "Functions, symbols, and bigints are not accepted.", path);
  }
  if (isProxy(value)) fail("INVALID_COMMAND", "Proxy objects are not accepted.", path);
  if (ancestors.has(value)) fail("UNBOUNDED_GRAPH", "Input contains a cyclic object graph.", path);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail("INVALID_COMMAND", "Only plain arrays are accepted.", path);
    }
    const descriptors = Object.getOwnPropertyDescriptors<object>(value);
    const lengthValue = dataDescriptorValue(descriptors.length, `${path}.length`, false);
    if (
      typeof lengthValue !== "number"
      || !Number.isSafeInteger(lengthValue)
      || lengthValue < 0
      || lengthValue > CHANGE_RADIUS_LIMITS.maxInputNodes
    ) {
      fail("UNBOUNDED_GRAPH", "Input array bound exceeded.", path);
    }
    const length = lengthValue;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") fail("INVALID_COMMAND", "Symbol keys are not accepted.", path);
      if (key === "length") continue;
      if (AUTHORITY_KEYS.has(key)) {
        fail("CALLER_INJECTED_AUTHORITY", `Caller-injected authority key '${key}' is not accepted.`, `${path}.${key}`);
      }
      if (key === "toJSON") fail("INVALID_COMMAND", "toJSON hooks are not accepted.", `${path}.toJSON`);
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= length) {
        fail("INVALID_COMMAND", "Arrays may contain indexed elements only.", `${path}.${key}`);
      }
      dataDescriptorValue(descriptors[key], `${path}[${key}]`, true);
    }

    ancestors.add(value);
    const snapshot = new Array<unknown>(length);
    try {
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) fail("INVALID_COMMAND", "Sparse arrays are not accepted.", `${path}[${index}]`);
        snapshot[index] = snapshotPlainDataValue(
          dataDescriptorValue(descriptor, `${path}[${index}]`, true),
          `${path}[${index}]`,
          depth + 1,
          state,
          ancestors,
        );
      }
    } finally {
      ancestors.delete(value);
    }
    return snapshot;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_COMMAND", "Only plain objects and arrays are accepted.", path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") fail("INVALID_COMMAND", "Symbol keys are not accepted.", path);
    if (AUTHORITY_KEYS.has(key)) {
      fail("CALLER_INJECTED_AUTHORITY", `Caller-injected authority key '${key}' is not accepted.`, `${path}.${key}`);
    }
    if (key === "toJSON") fail("INVALID_COMMAND", "toJSON hooks are not accepted.", `${path}.toJSON`);
    dataDescriptorValue(descriptors[key], `${path}.${key}`, true);
    keys.push(key);
  }

  ancestors.add(value);
  const snapshot: InputRecord = Object.create(null);
  try {
    for (const key of keys) {
      const child = snapshotPlainDataValue(
        dataDescriptorValue(descriptors[key], `${path}.${key}`, true),
        `${path}.${key}`,
        depth + 1,
        state,
        ancestors,
      );
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true,
      });
    }
  } finally {
    ancestors.delete(value);
  }
  return snapshot;
}

function snapshotPlainData<T>(value: T, path: string): T {
  assertUnpollutedObjectPrototype(path);
  return snapshotPlainDataValue(value, path, 0, { nodes: 0 }, new WeakSet<object>()) as T;
}

function normalizeReference(value: unknown, scope: ChangeRadiusScope, path: string): NormalizedReference {
  if (typeof value === "string") {
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1) fail("INVALID_REFERENCE", "String references must be FAMILY:recordId.", path);
    return {
      family: value.slice(0, separator),
      recordId: value.slice(separator + 1),
      scope,
      relation: DEFAULT_RELATION,
    };
  }
  if (!isRecordObject(value)) fail("INVALID_REFERENCE", "Reference must be an object.", path);
  assertKnownKeys(value, new Set([
    "family",
    "recordType",
    "recordId",
    "id",
    "sourceFamily",
    "scope",
    "relation",
    "affected",
    "materiality",
    "reasonCode",
  ]), path);
  const family = equivalentStringClaim(value, ["family", "recordType"], path);
  const recordId = equivalentStringClaim(value, ["recordId", "id"], path);
  if (family === undefined || recordId === undefined) {
    fail("INVALID_REFERENCE", "Reference requires family and recordId.", path);
  }
  const sourceFamily = equivalentStringClaim(value, ["sourceFamily"], path);
  if (sourceFamily !== undefined && sourceFamily.length === 0) {
    fail("INVALID_REFERENCE", "Reference sourceFamily must be a bounded non-empty string.", `${path}.sourceFamily`);
  }
  const scopeClaim = own(value, "scope");
  const referenceScope = scopeClaim.present ? assertScope(scopeClaim.value, `${path}.scope`) : scope;
  assertSameScope(scope, referenceScope, `${path}.scope`);
  const relationClaim = own(value, "relation");
  const relation = relationClaim.present ? assertClaimString(relationClaim.value, `${path}.relation`) : DEFAULT_RELATION;
  return {
    family,
    recordId,
    scope,
    relation,
  };
}

function referenceFromNormalized(reference: NormalizedReference): ChangeRadiusRecordReference {
  return { family: reference.family, recordId: reference.recordId, scope: reference.scope, relation: reference.relation };
}

function edgeKey(from: { readonly family: string; readonly recordId: string }, to: { readonly family: string; readonly recordId: string }): string {
  return `${recordKey(from)}\u0001${recordKey(to)}`;
}

function normalizePolicy(command: ProposedChangeCommandEnvelope): ChangeRadiusPolicy {
  const policy = isRecordObject(command.policy) ? command.policy : {};
  const termPolicy = (policy.termPolicy ?? policy.materialTerms) as ChangeRadiusPolicy["termPolicy"];
  const rawRequired = [
    ...(Array.isArray(command.requiredFamilies) ? command.requiredFamilies : []),
    ...(Array.isArray(policy.requiredFamilies) ? policy.requiredFamilies : []),
  ];
  const rawUnavailable = [
    ...(Array.isArray(command.unavailableFamilies) ? command.unavailableFamilies : []),
    ...(Array.isArray(policy.unavailableFamilies) ? policy.unavailableFamilies : []),
  ];
  const familyMateriality = isRecordObject(policy.familyMateriality) ? policy.familyMateriality as ChangeRadiusPolicy["familyMateriality"] : undefined;
  if (familyMateriality !== undefined) {
    for (const [family, materiality] of Object.entries(familyMateriality)) {
      if (!(MATERIALITIES as readonly string[]).includes(materiality as string)) {
        fail("INVALID_COMMAND", `Invalid materiality policy for ${family}.`, "policy.familyMateriality");
      }
    }
  }
  return {
    ...(termPolicy === undefined ? {} : { termPolicy }),
    ...(familyMateriality === undefined ? {} : { familyMateriality }),
    requiredFamilies: rawRequired.filter((family): family is string => typeof family === "string"),
    unavailableFamilies: rawUnavailable.filter((family): family is string => typeof family === "string"),
    ...(typeof policy.operatorBaselineAvailable === "boolean" ? { operatorBaselineAvailable: policy.operatorBaselineAvailable } : {}),
    ...(typeof policy.operatorReleaseBaselineAvailable === "boolean"
      ? { operatorReleaseBaselineAvailable: policy.operatorReleaseBaselineAvailable }
      : {}),
  };
}

function normalizeCommandType(command: ProposedChangeCommandEnvelope): void {
  const value = command as InputRecord;
  const candidates: string[] = [];
  for (const key of ["commandType", "type", "kind"] as const) {
    const claim = own(value, key);
    if (!claim.present) continue;
    const candidate = assertClaimString(claim.value, `command.${key}`);
    if (!ACCEPTED_COMMAND_TYPES.has(candidate)) fail("INVALID_COMMAND", `Unsupported command type '${candidate}'.`, `command.${key}`);
    candidates.push(candidate);
  }
  if (candidates.length > 1 && candidates.some((candidate) => candidate !== candidates[0])) {
    fail("INVALID_COMMAND", "Command type aliases disagree.", "commandType");
  }
  const schemaVersion = own(value, "schemaVersion");
  if (schemaVersion.present) {
    if (typeof schemaVersion.value !== "number" || !Number.isSafeInteger(schemaVersion.value)) {
      fail("INVALID_COMMAND", "schemaVersion must be a safe integer.", "schemaVersion");
    }
    if (schemaVersion.value !== CHANGE_RADIUS_SCHEMA_VERSION) {
      fail("INVALID_COMMAND", "Unsupported Change-Radius schema version.", "schemaVersion");
    }
  }
}

function sourceRecordFingerprint(record: ChangeRadiusSourceRecord, scope: ChangeRadiusScope, revision: number): string {
  const value = record as InputRecord;
  const family = equivalentStringClaim(value, ["family", "recordType"], "sourceRecord");
  const recordId = equivalentStringClaim(value, ["recordId", "id"], "sourceRecord");
  const suppliedScope = own(value, "scope");
  const recordScope = suppliedScope.present ? assertScope(suppliedScope.value, "sourceRecord.scope") : scope;
  assertSameScope(scope, recordScope, "sourceRecord.scope");
  const suppliedRevision = equivalentRevisionClaim(value, ["revision", "version"], "sourceRecord");
  if (suppliedRevision !== undefined && suppliedRevision !== revision) {
    fail("STALE_SOURCE_VECTOR", "Source-record revision does not match the supplied source revision.", "sourceRecord.revision");
  }
  const recordRevision = suppliedRevision ?? revision;
  const kindClaim = equivalentStringClaim(value, ["kind"], "sourceRecord");
  const recordTypeClaim = equivalentStringClaim(value, ["recordType"], "sourceRecord");
  const terms = equivalentValueClaim(value, ["terms", "materialTerms"], "sourceRecord");
  const payload = equivalentValueClaim(value, ["payload", "data", "value"], "sourceRecord");
  const baselineAvailableClaim = own(value, "baselineAvailable");
  const baselineAvailable = baselineAvailableClaim.present
    ? assertClaimBoolean(baselineAvailableClaim.value, "sourceRecord.baselineAvailable")
    : true;
  const staleClaim = own(value, "stale");
  if (staleClaim.present) assertClaimBoolean(staleClaim.value, "sourceRecord.stale");
  if (family === undefined || recordId === undefined) {
    fail("INVALID_COMMAND", "Source records require family and recordId.", "sourceRecord");
  }
  const references = referenceList(record).map((reference, index) => {
    const normalized = normalizeReference(reference, scope, `sourceRecord.references[${index}]`);
    return {
      family: normalized.family,
      recordId: normalized.recordId,
      relation: normalized.relation,
    };
  });
  return fingerprint({
    schemaVersion: CHANGE_RADIUS_SCHEMA_VERSION,
    family,
    recordId,
    scope: recordScope,
    revision: recordRevision,
    kind: kindClaim ?? (recordTypeClaim === undefined ? null : recordTypeClaim),
    terms: canonicalMaterialTerms(terms.present ? terms.value : null),
    payload: payload.present ? payload.value : null,
    baselineAvailable,
    dependents: stableSort(references, (left, right) => compareStableStrings(canonicalJson(left), canonicalJson(right))),
  });
}

function validateSourceRecordFingerprint(
  record: ChangeRadiusSourceRecord,
  scope: ChangeRadiusScope,
  revision: number,
  path: string,
): string {
  const computed = sourceRecordFingerprint(record, scope, revision);
  const value = record as InputRecord;
  const claimed = equivalentStringClaim(value, ["fingerprint", "sourceFingerprint"], path, "SOURCE_RECORD_FINGERPRINT_MISMATCH");
  if (claimed !== undefined && claimed !== computed) {
    fail("SOURCE_RECORD_FINGERPRINT_MISMATCH", "A source record fingerprint does not match its canonical content.", path);
  }
  return computed;
}

function validateSourceVectorFingerprint(
  vector: InputRecord,
  computed: string,
  path: string,
): readonly string[] {
  const value = vector;
  const claimed = equivalentStringClaim(value, ["fingerprint", "sourceFingerprint"], path, "SOURCE_VECTOR_FINGERPRINT_MISMATCH");
  if (claimed !== undefined && claimed !== computed) {
    fail("SOURCE_VECTOR_FINGERPRINT_MISMATCH", "A source-vector fingerprint does not match its canonical content.", path);
  }
  const currentFingerprint = equivalentStringClaim(value, ["currentFingerprint"], path, "STALE_SOURCE_VECTOR");
  if (currentFingerprint !== undefined && currentFingerprint !== computed) {
    fail("STALE_SOURCE_VECTOR", "The before source vector is older than the current source fingerprint.", `${path}.currentFingerprint`);
  }
  return claimed === undefined ? [] : [claimed];
}

function referenceList(record: ChangeRadiusSourceRecord): readonly ChangeRadiusRecordReference[] {
  const value = record as InputRecord;
  const result: ChangeRadiusRecordReference[] = [];
  for (const key of ["dependents", "outgoing", "relatedRecords", "downstream", "references", "dependencies"] as const) {
    const claim = own(value, key);
    if (!claim.present) continue;
    if (claim.value === undefined) continue;
    if (!Array.isArray(claim.value)) fail("INVALID_COMMAND", `sourceRecord.${key} must be an array.`, `sourceRecord.${key}`);
    result.push(...(claim.value as ChangeRadiusRecordReference[]));
  }
  return result;
}

function vectorFingerprint(vectorId: string, scope: ChangeRadiusScope, revision: number, records: readonly NormalizedSourceRecord[]): string {
  const canonicalRecords = stableSort(
    records.map((record) => ({
      family: record.family,
      recordId: record.recordId,
      scope: record.scope,
      revision: record.revision,
      sourceFingerprint: record.sourceFingerprint,
      kind: record.kind ?? null,
      terms: canonicalMaterialTerms(record.terms ?? null),
      payload: record.payload ?? null,
      baselineAvailable: record.baselineAvailable,
      dependents: stableSort(
        record.dependents.map((reference) => ({ family: reference.family, recordId: reference.recordId, relation: reference.relation })),
        (left, right) => compareStableStrings(canonicalJson(left), canonicalJson(right)),
      ),
    })),
    (left, right) => compareStableStrings(recordKey(left), recordKey(right)),
  );
  return fingerprint({ schemaVersion: CHANGE_RADIUS_SCHEMA_VERSION, vectorId, scope, revision, records: canonicalRecords });
}

function normalizeSourceVector(command: ProposedChangeCommandEnvelope, scope: ChangeRadiusScope): NormalizedVector {
  const commandValue = command as InputRecord;
  const aliases = (["beforeSourceVector", "sourceVector", "before"] as const).filter((key) => own(commandValue, key).present);
  for (const key of aliases) {
    if (!isRecordObject(commandValue[key])) {
      fail("INVALID_COMMAND", "An exact before source vector must be an object.", key);
    }
  }
  const sourceVectorsClaim = own(commandValue, "sourceVectors");
  if (sourceVectorsClaim.present && !Array.isArray(sourceVectorsClaim.value)) {
    fail("INVALID_COMMAND", "sourceVectors must be an array.", "sourceVectors");
  }
  const list = sourceVectorsClaim.present ? sourceVectorsClaim.value as readonly unknown[] : undefined;
  if (aliases.length > 1 || (list !== undefined && list.length > 1) || (aliases.length > 0 && list !== undefined && list.length > 0)) {
    fail("DUPLICATE_SOURCE_VECTOR", "A proposal must contain exactly one before source vector.", "sourceVector");
  }
  const rawValue = aliases.length > 0 ? commandValue[aliases[0]!] : list?.[0];
  if (!isRecordObject(rawValue)) fail("INVALID_COMMAND", "An exact before source vector is required.", "beforeSourceVector");
  const rawRecord = rawValue;
  assertKnownKeys(rawRecord, SOURCE_VECTOR_KEYS, "beforeSourceVector");

  const vectorId = equivalentStringClaim(rawRecord, ["vectorId", "sourceVectorId", "id"], "beforeSourceVector");
  if (vectorId === undefined) fail("INVALID_COMMAND", "Source vector requires a vectorId.", "beforeSourceVector.vectorId");
  const revision = equivalentRevisionClaim(rawRecord, ["revision", "sourceRevision", "asOfRevision"], "beforeSourceVector");
  if (revision === undefined) fail("INVALID_COMMAND", "Source vector requires a revision.", "beforeSourceVector.revision");

  const staleClaim = equivalentValueClaim(rawRecord, ["stale", "isStale"], "beforeSourceVector", "STALE_SOURCE_VECTOR");
  if (staleClaim.present && typeof staleClaim.value !== "boolean") {
    fail("INVALID_COMMAND", "Source-vector stale claims must be booleans.", "beforeSourceVector.stale");
  }
  const status = equivalentStringClaim(rawRecord, ["status"], "beforeSourceVector");
  if (staleClaim.value === true || status?.toUpperCase() === "STALE") {
    fail("STALE_SOURCE_VECTOR", "The before source vector is marked stale.", "beforeSourceVector");
  }

  const currentRevision = equivalentRevisionClaim(rawRecord, ["currentRevision"], "beforeSourceVector", "STALE_SOURCE_VECTOR");
  if (currentRevision !== undefined && currentRevision !== revision) {
    fail("STALE_SOURCE_VECTOR", "The before source vector revision differs from the current source revision.", "beforeSourceVector.currentRevision");
  }

  const vectorScope = sourceVectorScope(rawRecord, "beforeSourceVector");
  assertSameScope(scope, vectorScope, "beforeSourceVector.scope");

  const recordAliases = (["records", "sourceRecords"] as const).filter((key) => own(rawRecord, key).present);
  for (const key of recordAliases) {
    if (!Array.isArray(rawRecord[key])) fail("INVALID_COMMAND", `Source vector ${key} must be an array.`, `beforeSourceVector.${key}`);
  }
  if (recordAliases.length > 1) {
    fail("DUPLICATE_SOURCE_VECTOR", "A source vector may expose one record collection only.", "beforeSourceVector.records");
  }
  const rawRecords = recordAliases.length === 0 ? undefined : rawRecord[recordAliases[0]!];
  if (!Array.isArray(rawRecords)) fail("INVALID_COMMAND", "Source vector records must be an array.", "beforeSourceVector.records");
  if (rawRecords.length > CHANGE_RADIUS_LIMITS.maxSourceRecords) {
    fail("UNBOUNDED_GRAPH", "Source-record bound exceeded.", "beforeSourceVector.records");
  }

  const records: NormalizedSourceRecord[] = [];
  const byKey = new Map<string, NormalizedSourceRecord>();
  const edgeKeys = new Set<string>();
  for (let index = 0; index < rawRecords.length; index += 1) {
    const recordValue = rawRecords[index];
    if (!isRecordObject(recordValue)) fail("INVALID_COMMAND", "Source records must be objects.", `beforeSourceVector.records[${index}]`);
    const record = recordValue as ChangeRadiusSourceRecord;
    const recordInput = record as InputRecord;
    const recordPath = `beforeSourceVector.records[${index}]`;
    const family = equivalentStringClaim(recordInput, ["family", "recordType"], recordPath);
    const recordId = equivalentStringClaim(recordInput, ["recordId", "id"], recordPath);
    if (family === undefined || recordId === undefined) {
      fail("INVALID_COMMAND", "Source records require family and recordId.", `beforeSourceVector.records[${index}]`);
    }
    const recordScopeClaim = own(recordInput, "scope");
    const recordScope = recordScopeClaim.present ? assertScope(recordScopeClaim.value, `${recordPath}.scope`) : scope;
    assertSameScope(scope, recordScope, `beforeSourceVector.records[${index}].scope`);
    const recordRevision = equivalentRevisionClaim(recordInput, ["revision", "version"], recordPath) ?? revision;
    const recordStaleClaim = own(recordInput, "stale");
    const recordStale = recordStaleClaim.present ? assertClaimBoolean(recordStaleClaim.value, `${recordPath}.stale`) : false;
    if (recordRevision > revision || recordStale) {
      fail("STALE_SOURCE_VECTOR", "A source record is newer than or marked stale in the before vector.", `beforeSourceVector.records[${index}]`);
    }
    const key = recordKey({ family, recordId });
    if (byKey.has(key)) fail("DUPLICATE_SOURCE_RECORD", "Source vector contains a duplicate record.", `beforeSourceVector.records[${index}]`);
    const normalizedReferenceRecords = referenceList(record).map((reference, referenceIndex) =>
      normalizeReference(reference, scope, `beforeSourceVector.records[${index}].dependents[${referenceIndex}]`),
    );
    const references: NormalizedReference[] = [];
    for (const reference of normalizedReferenceRecords) {
      const refKey = edgeKey({ family, recordId }, reference);
      if (edgeKeys.has(refKey)) fail("CONTRADICTORY_IMPACTS", "Duplicate dependency edges are not accepted.", refKey);
      edgeKeys.add(refKey);
      references.push(reference);
    }
    const sourceFingerprint = validateSourceRecordFingerprint(
      record,
      recordScope,
      recordRevision,
      recordPath,
    );
    const kind = equivalentStringClaim(recordInput, ["kind"], recordPath)
      ?? (own(recordInput, "recordType").present ? family : undefined);
    const terms = equivalentValueClaim(recordInput, ["terms", "materialTerms"], recordPath);
    const payload = equivalentValueClaim(recordInput, ["payload", "data", "value"], recordPath);
    const baselineClaim = own(recordInput, "baselineAvailable");
    const baselineAvailable = baselineClaim.present ? assertClaimBoolean(baselineClaim.value, `${recordPath}.baselineAvailable`) : true;
    const normalized: NormalizedSourceRecord = {
      raw: record,
      family,
      recordId,
      scope: recordScope,
      revision: recordRevision,
      sourceFingerprint,
      ...(kind === undefined ? {} : { kind }),
      ...(terms.present ? { terms: terms.value } : {}),
      ...(payload.present ? { payload: payload.value } : {}),
      baselineAvailable,
      dependents: references,
    };
    byKey.set(key, normalized);
    records.push(normalized);
  }

  const computedFingerprint = vectorFingerprint(vectorId, vectorScope, revision, records);
  const claimedFingerprints = validateSourceVectorFingerprint(rawRecord, computedFingerprint, "beforeSourceVector");
  return {
    raw: rawRecord,
    vectorId,
    scope: vectorScope,
    revision,
    records,
    byKey,
    fingerprint: computedFingerprint,
    claimedFingerprints: [...new Set(claimedFingerprints)],
  };
}

function expectationFromCommand(command: ProposedChangeCommandEnvelope): SourceVectorExpectation {
  const commandRecord = command as InputRecord;
  const nestedExpectations: Array<{ readonly value: InputRecord; readonly path: string }> = [];
  for (const key of ["expectedSourceVector", "expectedBefore"] as const) {
    const claim = own(commandRecord, key);
    if (!claim.present) continue;
    nestedExpectations.push({ value: assertExpectationObject(claim.value, `command.${key}`), path: `command.${key}` });
  }

  let vectorId: string | undefined;
  for (const nested of nestedExpectations) {
    const candidate = equivalentStringClaim(nested.value, ["vectorId"], nested.path, "STALE_SOURCE_VECTOR");
    if (candidate !== undefined && vectorId !== undefined && candidate !== vectorId) {
      fail("STALE_SOURCE_VECTOR", "Expected source-vector identity aliases disagree.", `${nested.path}.vectorId`);
    }
    if (candidate !== undefined) vectorId = candidate;
  }
  const topVectorId = equivalentStringClaim(commandRecord, ["expectedSourceVectorId"], "command", "STALE_SOURCE_VECTOR");
  if (topVectorId !== undefined && vectorId !== undefined && topVectorId !== vectorId) {
    fail("STALE_SOURCE_VECTOR", "Expected source-vector identity aliases disagree.", "expectedSourceVectorId");
  }
  if (topVectorId !== undefined) vectorId = topVectorId;

  let revision: number | undefined;
  for (const nested of nestedExpectations) {
    const candidate = equivalentRevisionClaim(nested.value, ["revision"], nested.path, "STALE_SOURCE_VECTOR");
    if (candidate !== undefined && revision !== undefined && candidate !== revision) {
      fail("STALE_SOURCE_VECTOR", "Expected source-vector revision aliases disagree.", `${nested.path}.revision`);
    }
    if (candidate !== undefined) revision = candidate;
  }
  const topRevision = equivalentRevisionClaim(
    commandRecord,
    ["expectedSourceVectorRevision", "expectedSourceRevision"],
    "command",
    "STALE_SOURCE_VECTOR",
  );
  if (topRevision !== undefined && revision !== undefined && topRevision !== revision) {
    fail("STALE_SOURCE_VECTOR", "Expected source-vector revision aliases disagree.", "expectedSourceVectorRevision");
  }
  if (topRevision !== undefined) revision = topRevision;

  let fingerprintClaim: string | undefined;
  for (const nested of nestedExpectations) {
    const candidate = equivalentStringClaim(
      nested.value,
      ["fingerprint", "sourceFingerprint"],
      nested.path,
      "STALE_SOURCE_VECTOR",
    );
    if (candidate !== undefined && fingerprintClaim !== undefined && candidate !== fingerprintClaim) {
      fail("STALE_SOURCE_VECTOR", "Expected source-vector fingerprint aliases disagree.", nested.path);
    }
    if (candidate !== undefined) fingerprintClaim = candidate;
  }
  const topFingerprint = equivalentStringClaim(
    commandRecord,
    ["expectedSourceVectorFingerprint", "expectedSourceFingerprint"],
    "command",
    "STALE_SOURCE_VECTOR",
  );
  if (topFingerprint !== undefined && fingerprintClaim !== undefined && topFingerprint !== fingerprintClaim) {
    fail("STALE_SOURCE_VECTOR", "Expected source-vector fingerprint aliases disagree.", "expectedSourceFingerprint");
  }
  if (topFingerprint !== undefined) fingerprintClaim = topFingerprint;

  return {
    ...(vectorId === undefined ? {} : { vectorId }),
    ...(revision === undefined ? {} : { revision }),
    ...(fingerprintClaim === undefined ? {} : { fingerprint: fingerprintClaim, sourceFingerprint: fingerprintClaim }),
  };
}

function validateFreshness(command: ProposedChangeCommandEnvelope, vector: NormalizedVector): void {
  const expected = expectationFromCommand(command);
  if (expected.vectorId !== undefined && expected.vectorId !== vector.vectorId) {
    fail("STALE_SOURCE_VECTOR", "Source-vector identity does not match the expected before vector.", "expectedSourceVector.vectorId");
  }
  if (expected.revision !== undefined && expected.revision !== vector.revision) {
    fail("STALE_SOURCE_VECTOR", "Source-vector revision does not match the expected before vector.", "expectedSourceVector.revision");
  }
  if (expected.fingerprint !== undefined && expected.fingerprint !== vector.fingerprint) {
    fail("STALE_SOURCE_VECTOR", "Source-vector fingerprint does not match the expected before vector.", "expectedSourceVector.fingerprint");
  }
  const commandRecord = command as InputRecord;
  const currentRevision = equivalentRevisionClaim(
    commandRecord,
    ["currentSourceVectorRevision"],
    "command",
    "STALE_SOURCE_VECTOR",
  );
  if (currentRevision !== undefined && currentRevision !== vector.revision) {
    fail("STALE_SOURCE_VECTOR", "Current source-vector revision differs from the exact before vector.", "currentSourceVectorRevision");
  }
  const currentFingerprint = equivalentStringClaim(
    commandRecord,
    ["currentSourceVectorFingerprint"],
    "command",
    "STALE_SOURCE_VECTOR",
  );
  if (currentFingerprint !== undefined && currentFingerprint !== vector.fingerprint) {
    fail("STALE_SOURCE_VECTOR", "Current source-vector fingerprint differs from the exact before vector.", "currentSourceVectorFingerprint");
  }
}

function normalizeChanges(command: ProposedChangeCommandEnvelope): readonly ProposedChange[] {
  const commandRecord = command as InputRecord;
  const aliases = (["proposedChanges", "changes", "proposed"] as const).filter((key) => own(commandRecord, key).present);
  if (aliases.length > 1) fail("DUPLICATE_CHANGE", "Use one proposed-change collection.", "proposedChanges");
  const changes = aliases.length === 0 ? [] : commandRecord[aliases[0]!];
  if (!Array.isArray(changes)) fail("INVALID_COMMAND", "Proposed changes must be an array.", "proposedChanges");
  if (changes.length > CHANGE_RADIUS_LIMITS.maxProposedChanges) fail("UNBOUNDED_GRAPH", "Proposed-change bound exceeded.", "proposedChanges");
  return changes as readonly ProposedChange[];
}

function normalizeChangeFamily(change: ProposedChange, path: string): string {
  const family = equivalentStringClaim(change as InputRecord, ["family", "recordType"], path);
  if (family === undefined) fail("INVALID_COMMAND", "Proposed change requires a family.", `${path}.family`);
  return family;
}

function normalizeChangeRecordId(change: ProposedChange, path: string): string {
  const recordId = equivalentStringClaim(change as InputRecord, ["recordId", "id"], path);
  if (recordId === undefined) fail("INVALID_COMMAND", "Proposed change requires a recordId.", `${path}.recordId`);
  return recordId;
}

function validateProposedChangeClaims(change: ProposedChange, path: string): void {
  const value = change as InputRecord;
  equivalentStringClaim(value, ["changeId"], path);
  equivalentStringClaim(value, ["kind"], path);
  equivalentStringClaim(value, ["sourceFingerprint"], path, "STALE_SOURCE_VECTOR");
  equivalentStringClaim(value, ["beforeFingerprint"], path, "STALE_SOURCE_VECTOR");
  equivalentStringClaim(value, ["afterFingerprint"], path, "CONTRADICTORY_IMPACTS");
  equivalentRevisionClaim(value, ["expectedRevision"], path, "STALE_SOURCE_VECTOR");
  const affected = own(value, "affected");
  if (affected.present) assertClaimBoolean(affected.value, `${path}.affected`);
  const reason = own(value, "reason");
  if (reason.present) assertClaimString(reason.value, `${path}.reason`);
  const scope = own(value, "scope");
  if (scope.present) assertScope(scope.value, `${path}.scope`);
  const assertions = own(value, "impactAssertions");
  if (assertions.present && !Array.isArray(assertions.value)) {
    fail("INVALID_COMMAND", `${path}.impactAssertions must be an array.`, `${path}.impactAssertions`);
  }
}

function changeValue(change: ProposedChange, side: "before" | "after"): { readonly present: boolean; readonly value: unknown } {
  const aliases = [`${side}Terms`, `${side}MaterialTerms`, side];
  let found: { readonly present: boolean; readonly value: unknown } = { present: false, value: undefined };
  for (const alias of aliases) {
    const current = own(change as InputRecord, alias);
    if (!current.present) continue;
    if (found.present && !equalValues(found.value, current.value)) {
      fail(side === "before" ? "CONTRADICTORY_BEFORE" : "CONTRADICTORY_IMPACTS", `${side} aliases disagree.`, side);
    }
    found = current;
  }
  if (found.present) return found;
  return { present: false, value: undefined };
}

function sourceBaseline(source: NormalizedSourceRecord | undefined): { readonly known: boolean; readonly value?: unknown } {
  if (!source || !source.baselineAvailable) return { known: false };
  const raw = source.raw as InputRecord;
  if (own(raw, "terms").present || own(raw, "materialTerms").present) return { known: true, value: source.terms };
  if (own(raw, "payload").present || own(raw, "data").present || own(raw, "value").present) return { known: true, value: source.payload };
  return { known: false };
}

function equalValues(left: unknown, right: unknown): boolean {
  return canonicalOptional(left) === canonicalOptional(right);
}

function matchesValueFingerprint(claimed: string, value: unknown, sourceFingerprint?: string): boolean {
  const candidates = new Set<string>();
  if (sourceFingerprint !== undefined) candidates.add(sourceFingerprint);
  if (value !== undefined) {
    try {
      candidates.add(fingerprint(value));
    } catch {
      return false;
    }
  }
  return candidates.has(claimed);
}

function assertExactBefore(
  source: NormalizedSourceRecord | undefined,
  proposedBefore: { readonly present: boolean; readonly value: unknown },
  path: string,
): { readonly known: boolean; readonly value?: unknown } {
  const baseline = sourceBaseline(source);
  if (!proposedBefore.present) return baseline;
  if (baseline.known && !equalValues(baseline.value, proposedBefore.value)) {
    fail("CONTRADICTORY_BEFORE", "Proposed before terms do not match the exact source vector.", `${path}.before`);
  }
  return { known: true, value: proposedBefore.value };
}

function rootMateriality(
  family: string,
  comparison: MaterialTermComparison,
  policy: ChangeRadiusPolicy,
): Materiality {
  if (comparison.materiality === "UNKNOWN" || comparison.materiality === "BLOCKING") return comparison.materiality;
  const override = policy.familyMateriality?.[family as ChangeRadiusFamily];
  if (override !== undefined) {
    if (!(MATERIALITIES as readonly string[]).includes(override)) fail("INVALID_COMMAND", "Unknown family materiality policy.");
    return override;
  }
  if (!isKnownFamily(family)) return "UNKNOWN";
  if (family === "PUBLIC_RELEASE" || family === "OPERATOR_RELEASE" || family === "PEOPLE") {
    return maxMateriality(comparison.materiality, "REVIEW");
  }
  return comparison.materiality;
}

function termsForPropagation(comparison: MaterialTermComparison | undefined): ReadonlySet<string> {
  return new Set((comparison?.changedTerms ?? []).map((change) => change.kind));
}

function propagatedMateriality(
  family: string,
  context: TraversalContext,
  source: NormalizedSourceRecord | undefined,
  policy: ChangeRadiusPolicy,
): Materiality {
  if (source?.baselineAvailable === false) return "UNKNOWN";
  if (!isKnownFamily(family)) return "UNKNOWN";
  if (context.rootMateriality === "BLOCKING") return "BLOCKING";
  if (context.rootMateriality === "UNKNOWN") return "UNKNOWN";
  const override = policy.familyMateriality?.[family];
  if (override !== undefined) return override;
  if (family === "COMMITMENT") {
    if (["TIME", "DURATION", "ROLE", "RECORDING"].some((kind) => context.rootTermKinds.has(kind))) return "RECONFIRMATION";
    if (context.rootTermKinds.has("VENUE")) {
      const venueChange = context.rootChangedTerms.find((change) => change.kind === "VENUE");
      return venueChange?.materiality ?? "REVIEW";
    }
    return "REVIEW";
  }
  if (family === "PUBLIC_RELEASE" || family === "OPERATOR_RELEASE" || family === "PEOPLE" || family === "SCHEDULE") return "REVIEW";
  if (family === "ARTIFACT") return "INFORMATIONAL";
  return "UNKNOWN";
}

function reasonSummary(code: string, family: string): string {
  switch (code) {
    case "MATERIAL_TERM_CHANGED":
      return `${family} has a material term change.`;
    case "DEPENDENCY_OF_CHANGED_RECORD":
      return `${family} is downstream of a proposed change.`;
    case "BASELINE_UNAVAILABLE":
      return `${family} baseline is unavailable.`;
    case "REQUIRED_BASELINE_UNAVAILABLE":
      return `${family} is required but its baseline is unavailable.`;
    case "UNKNOWN_FAMILY":
      return "An unknown record family cannot be classified as safe.";
    default:
      return `${family} requires conservative impact handling.`;
  }
}

function addReason(accumulator: NodeAccumulator, code: string): void {
  accumulator.reasonCodes.add(code);
  if (accumulator.primaryReasonCode === "DEPENDENCY_OF_CHANGED_RECORD" && code !== accumulator.primaryReasonCode) {
    accumulator.primaryReasonCode = code;
  }
}

function createAccumulator(
  reference: NormalizedReference,
  source: NormalizedSourceRecord | undefined,
  materiality: Materiality,
  reasonCode: string,
  depth: number,
  sourceFingerprint: string,
  changedTerms: readonly MaterialTermChange[],
  beforeValue?: unknown,
  afterValue?: unknown,
): NodeAccumulator {
  const changed = new Map<string, MaterialTermChange>();
  for (const term of changedTerms) changed.set(`${term.kind}\u0000${term.reasonFingerprint}`, term);
  return {
    key: recordKey(reference),
    family: reference.family,
    recordId: reference.recordId,
    ...(source === undefined ? {} : { source }),
    ...(source?.kind === undefined ? {} : { kind: source.kind }),
    depth,
    materiality,
    reasonCodes: new Set([reasonCode]),
    sourceFingerprints: new Set([sourceFingerprint]),
    changedTerms: changed,
    upstreamRecordIds: new Set<string>(),
    ...(beforeValue === undefined ? {} : { beforeFingerprint: fingerprint(beforeValue) }),
    ...(afterValue === undefined ? {} : { afterFingerprint: fingerprint(afterValue) }),
    primaryReasonCode: reasonCode,
    ...(isKnownFamily(reference.family) ? {} : { sourceFamily: reference.family }),
  };
}

function mergeAccumulator(
  accumulator: NodeAccumulator,
  materiality: Materiality,
  reasonCode: string,
  depth: number,
  sourceFingerprints: readonly string[],
  upstreamRecordIds: readonly string[],
  changedTerms: readonly MaterialTermChange[],
): void {
  accumulator.materiality = maxMateriality(accumulator.materiality, materiality);
  accumulator.depth = Math.min(accumulator.depth, depth);
  addReason(accumulator, reasonCode);
  for (const sourceFingerprint of sourceFingerprints) accumulator.sourceFingerprints.add(sourceFingerprint);
  for (const upstreamRecordId of upstreamRecordIds) accumulator.upstreamRecordIds.add(upstreamRecordId);
  for (const term of changedTerms) accumulator.changedTerms.set(`${term.kind}\u0000${term.reasonFingerprint}`, term);
}

function normalizeInputEdges(command: ProposedChangeCommandEnvelope, scope: ChangeRadiusScope): readonly NormalizedEdge[] {
  const aliases = [command.impactEdges, command.edges].filter((value): value is readonly ProposedImpactEdge[] => value !== undefined);
  if (aliases.length > 1) fail("CONTRADICTORY_IMPACTS", "Use one impact-edge collection.", "impactEdges");
  const rawEdges = aliases[0] ?? [];
  if (!Array.isArray(rawEdges)) fail("INVALID_COMMAND", "Impact edges must be an array.", "impactEdges");
  if (rawEdges.length > CHANGE_RADIUS_LIMITS.maxGraphEdges) fail("UNBOUNDED_GRAPH", "Impact-edge bound exceeded.", "impactEdges");
  const result: NormalizedEdge[] = [];
  const seen = new Map<string, string>();
  for (let index = 0; index < rawEdges.length; index += 1) {
    const edgeValue = rawEdges[index];
    if (!isRecordObject(edgeValue)) fail("INVALID_REFERENCE", "Impact edge must be an object.", `impactEdges[${index}]`);
    const edge = edgeValue as unknown as ProposedImpactEdge;
    const from = normalizeReference(edge.from, scope, `impactEdges[${index}].from`);
    const to = normalizeReference(edge.to, scope, `impactEdges[${index}].to`);
    const key = edgeKey(from, to);
    const descriptor = canonicalJson({
      relation: edge.relation ?? DEFAULT_RELATION,
      ...(edge.affected === undefined ? {} : { affected: edge.affected }),
      ...(edge.materiality === undefined ? {} : { materiality: edge.materiality }),
      ...(edge.reasonCode === undefined ? {} : { reasonCode: edge.reasonCode }),
    });
    if (seen.has(key)) {
      if (seen.get(key) !== descriptor) fail("CONTRADICTORY_IMPACTS", "Duplicate impact edges disagree.", `impactEdges[${index}]`);
      fail("CONTRADICTORY_IMPACTS", "Duplicate impact edges are not accepted.", `impactEdges[${index}]`);
    }
    seen.set(key, descriptor);
    if (edge.materiality !== undefined && !(MATERIALITIES as readonly string[]).includes(edge.materiality)) {
      fail("CONTRADICTORY_IMPACTS", "Impact edge has an invalid materiality.", `impactEdges[${index}].materiality`);
    }
    result.push({
      from,
      to,
      relation: typeof edge.relation === "string" && edge.relation.length > 0 ? edge.relation : DEFAULT_RELATION,
      ...(typeof edge.affected === "boolean" ? { affected: edge.affected } : {}),
      ...(edge.materiality === undefined ? {} : { materiality: edge.materiality }),
      ...(typeof edge.reasonCode === "string" ? { reasonCode: edge.reasonCode } : {}),
    });
  }
  return result;
}

function findCycleAndDepth(edges: readonly NormalizedEdge[], extraReferences: readonly NormalizedReference[]): number {
  const nodes = new Set<string>(extraReferences.map(recordKey));
  const adjacency = new Map<string, NormalizedReference[]>();
  for (const edge of edges) {
    nodes.add(recordKey(edge.from));
    nodes.add(recordKey(edge.to));
    const list = adjacency.get(recordKey(edge.from)) ?? [];
    list.push(edge.to);
    adjacency.set(recordKey(edge.from), list);
  }
  if (nodes.size > CHANGE_RADIUS_LIMITS.maxGraphNodes) fail("UNBOUNDED_GRAPH", "Graph-node bound exceeded.", "impactGraph");
  const colors = new Map<string, 0 | 1 | 2>();
  const longestPath = new Map<string, number>();
  let maxDepth = 0;
  const visit = (key: string): number => {
    const color = colors.get(key) ?? 0;
    if (color === 1) fail("IMPACT_CYCLE", "Impact graph contains a cycle.", key);
    if (color === 2) return longestPath.get(key) ?? 0;
    colors.set(key, 1);
    const children = stableSort(adjacency.get(key) ?? [], (left, right) => compareStableStrings(recordKey(left), recordKey(right)));
    let depth = 0;
    for (const child of children) depth = Math.max(depth, visit(recordKey(child)) + 1);
    longestPath.set(key, depth);
    maxDepth = Math.max(maxDepth, depth);
    colors.set(key, 2);
    return depth;
  };
  for (const key of stableSort([...nodes], compareStableStrings)) visit(key);
  if (maxDepth > CHANGE_RADIUS_LIMITS.maxGraphDepth) fail("UNBOUNDED_GRAPH", "Graph-depth bound exceeded.", "impactGraph");
  if (edges.length > CHANGE_RADIUS_LIMITS.maxGraphEdges) fail("UNBOUNDED_GRAPH", "Graph-edge bound exceeded.", "impactGraph");
  return maxDepth;
}

function combineAndRejectDuplicateEdges(vector: NormalizedVector, inputEdges: readonly NormalizedEdge[]): readonly NormalizedEdge[] {
  const edges: NormalizedEdge[] = [
    ...vector.records.flatMap((record) => record.dependents.map((dependent) => ({
      from: sourceReference(record),
      to: dependent,
      relation: dependent.relation,
    })) ),
    ...inputEdges,
  ];
  if (edges.length > CHANGE_RADIUS_LIMITS.maxGraphEdges) fail("UNBOUNDED_GRAPH", "Graph-edge bound exceeded.", "impactGraph");
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key)) fail("CONTRADICTORY_IMPACTS", "Duplicate source and proposed impact edges are not accepted.", key);
    seen.add(key);
  }
  return edges;
}

function normalizeAssertions(command: ProposedChangeCommandEnvelope, changes: readonly ProposedChange[], scope: ChangeRadiusScope): readonly ChangeRadiusImpactAssertion[] {
  const all: ChangeRadiusImpactAssertion[] = [];
  if (Array.isArray(command.impactAssertions)) all.push(...command.impactAssertions);
  for (const change of changes) if (Array.isArray(change.impactAssertions)) all.push(...change.impactAssertions);
  if (all.length > CHANGE_RADIUS_LIMITS.maxImpactAssertions) fail("UNBOUNDED_GRAPH", "Impact-assertion bound exceeded.", "impactAssertions");
  const seen = new Set<string>();
  return all.map((assertion, index) => {
    if (!isRecordObject(assertion)) fail("CONTRADICTORY_IMPACTS", "Impact assertion must be an object.", `impactAssertions[${index}]`);
    const reference = normalizeReference(assertion, scope, `impactAssertions[${index}]`);
    const key = recordKey(reference);
    if (seen.has(key)) fail("CONTRADICTORY_IMPACTS", "Duplicate impact assertions are not accepted.", `impactAssertions[${index}]`);
    seen.add(key);
    if (typeof assertion.affected !== "boolean") fail("CONTRADICTORY_IMPACTS", "Impact assertion requires affected boolean.", `impactAssertions[${index}].affected`);
    if (assertion.materiality !== undefined && !(MATERIALITIES as readonly string[]).includes(assertion.materiality)) {
      fail("CONTRADICTORY_IMPACTS", "Impact assertion has an invalid materiality.", `impactAssertions[${index}].materiality`);
    }
    return {
      family: reference.family,
      recordId: reference.recordId,
      affected: assertion.affected,
      ...(assertion.materiality === undefined ? {} : { materiality: assertion.materiality }),
      ...(typeof assertion.reasonCode === "string" ? { reasonCode: assertion.reasonCode } : {}),
      scope,
    };
  });
}

function createOutputRecord(accumulator: NodeAccumulator, scope: ChangeRadiusScope): AffectedRecord {
  const family = outputFamily(accumulator.family);
  const reasonCodes = stableSort([...accumulator.reasonCodes], compareStableStrings);
  const reasonPriority = [
    "UNKNOWN_FAMILY",
    "BASELINE_UNAVAILABLE",
    "REQUIRED_BASELINE_UNAVAILABLE",
    "MATERIAL_TERM_CHANGED",
    "DEPENDENCY_OF_CHANGED_RECORD",
  ];
  const reasonCode = reasonPriority.find((candidate) => accumulator.reasonCodes.has(candidate)) ?? reasonCodes[0] ?? accumulator.primaryReasonCode;
  const sourceFingerprints = stableSort([...accumulator.sourceFingerprints], compareStableStrings);
  const changedTerms = stableSort([...accumulator.changedTerms.values()], (left, right) => {
    const leftKey = `${left.kind}\u0000${left.reasonFingerprint}`;
    const rightKey = `${right.kind}\u0000${right.reasonFingerprint}`;
    return compareStableStrings(leftKey, rightKey);
  });
  const reasonDetail: ImpactReason = {
    code: reasonCode,
    summary: reasonSummary(reasonCode, family === "UNKNOWN" ? accumulator.sourceFamily ?? accumulator.family : family),
    fingerprint: fingerprint({
      schemaVersion: CHANGE_RADIUS_SCHEMA_VERSION,
      code: reasonCode,
      family,
      recordId: accumulator.recordId,
      sourceFingerprints,
      upstreamRecordIds: stableSort([...accumulator.upstreamRecordIds], compareStableStrings),
      changedTerms: changedTerms.map((term) => term.reasonFingerprint),
    }),
  };
  const base = {
    family,
    recordType: family,
    recordId: accumulator.recordId,
    scope,
    affected: true as const,
    materiality: accumulator.materiality,
    sourceFingerprint: sourceFingerprints[0] ?? `missing:${accumulator.family}:${accumulator.recordId}`,
    sourceFingerprints,
    reason: reasonDetail.summary,
    reasonCode,
    reasonFingerprint: reasonDetail.fingerprint,
    reasonDetail,
    changedTerms,
    ...(accumulator.beforeFingerprint === undefined ? {} : { beforeFingerprint: accumulator.beforeFingerprint }),
    ...(accumulator.afterFingerprint === undefined ? {} : { afterFingerprint: accumulator.afterFingerprint }),
    depth: accumulator.depth,
    upstreamRecordIds: stableSort([...accumulator.upstreamRecordIds], compareStableStrings),
  };
  const withKind = accumulator.kind === undefined ? base : { ...base, kind: accumulator.kind };
  const withFamily = family === "UNKNOWN" ? { ...withKind, sourceFamily: accumulator.sourceFamily ?? accumulator.family } : withKind;
  const impactFingerprint = fingerprint({
    ...withFamily,
    changedTerms: changedTerms.map(canonicalMaterialTermChange),
  });
  return { ...withFamily, impactFingerprint } as AffectedRecord;
}

function fingerprintableAffectedRecord(record: AffectedRecord): Record<string, unknown> {
  return {
    ...record,
    changedTerms: record.changedTerms.map(canonicalMaterialTermChange),
  };
}

function fingerprintableGraphWithoutFingerprint(graph: Omit<ImpactGraph, "fingerprint">): Record<string, unknown> {
  return {
    ...graph,
    nodes: graph.nodes.map(fingerprintableAffectedRecord),
  };
}

function fingerprintableGraph(graph: ImpactGraph): Record<string, unknown> {
  return fingerprintableGraphWithoutFingerprint(graph);
}

function outputReference(reference: NormalizedReference): ChangeRadiusRecordReference {
  const family = outputFamily(reference.family);
  return {
    family,
    recordId: reference.recordId,
    scope: reference.scope,
    ...(family === "UNKNOWN" ? { sourceFamily: reference.family } : {}),
    ...(reference.relation === DEFAULT_RELATION ? {} : { relation: reference.relation }),
  };
}

function outputNodeReference(record: AffectedRecord): ChangeRadiusRecordReference {
  return {
    family: record.family,
    recordId: record.recordId,
    scope: record.scope,
    ...(record.family === "UNKNOWN" ? { sourceFamily: record.sourceFamily } : {}),
  };
}

function stableReferenceSortKey(reference: ChangeRadiusRecordReference): string {
  return canonicalJson({
    family: reference.family,
    sourceFamily: reference.sourceFamily ?? null,
    recordId: reference.recordId,
    scope: reference.scope ?? null,
    relation: reference.relation ?? null,
  });
}

function stableAffectedRecordSortKey(record: AffectedRecord): string {
  return [
    record.family,
    record.recordId,
    record.sourceFamily ?? "",
    record.kind ?? "",
    String(record.depth).padStart(8, "0"),
    canonicalJson(fingerprintableAffectedRecord(record)),
  ].join("\u0000");
}

function sourceReference(record: NormalizedSourceRecord): NormalizedReference {
  return { family: record.family, recordId: record.recordId, scope: record.scope, relation: DEFAULT_RELATION };
}

function applyAssertions(assertions: readonly ChangeRadiusImpactAssertion[], nodes: ReadonlyMap<string, AffectedRecord>, unaffected: ReadonlySet<string>): void {
  for (const assertion of assertions) {
    const key = recordKey({
      family: assertion.family ?? assertion.recordType ?? "",
      recordId: assertion.recordId ?? assertion.id ?? "",
    });
    const node = nodes.get(key);
    if (assertion.affected && !node) fail("CONTRADICTORY_IMPACTS", "Caller assertion requires an impact that the deterministic graph did not find.", key);
    if (!assertion.affected && node) fail("CONTRADICTORY_IMPACTS", "Caller assertion suppresses a deterministic impact.", key);
    if (!assertion.affected && !unaffected.has(key)) fail("CONTRADICTORY_IMPACTS", "Unaffected assertion has no exact baseline record.", key);
    if (node && assertion.materiality !== undefined && node.materiality !== assertion.materiality) {
      fail("CONTRADICTORY_IMPACTS", "Impact assertion materiality conflicts with deterministic materiality.", key);
    }
    if (node && assertion.reasonCode !== undefined && node.reasonCode !== assertion.reasonCode) {
      fail("CONTRADICTORY_IMPACTS", "Impact assertion reason conflicts with deterministic reason.", key);
    }
  }
}

function checkInputEdgeAssertions(edges: readonly NormalizedEdge[], nodes: ReadonlyMap<string, AffectedRecord>): void {
  for (const edge of edges) {
    const target = nodes.get(recordKey(edge.to));
    if (edge.affected === false && target) fail("CONTRADICTORY_IMPACTS", "An edge cannot suppress a deterministic impact.", edgeKey(edge.from, edge.to));
    if (edge.affected === true && !target) fail("CONTRADICTORY_IMPACTS", "An edge assertion requires a deterministic impact.", edgeKey(edge.from, edge.to));
    if (target && edge.materiality !== undefined && target.materiality !== edge.materiality) {
      fail("CONTRADICTORY_IMPACTS", "Edge materiality conflicts with deterministic materiality.", edgeKey(edge.from, edge.to));
    }
  }
}

function buildGraph(
  command: ProposedChangeCommandEnvelope,
  scope: ChangeRadiusScope,
  vector: NormalizedVector,
  changes: readonly ProposedChange[],
  policy: ChangeRadiusPolicy,
  inputEdges: readonly NormalizedEdge[],
): { readonly graph: ImpactGraph; readonly materiality: Materiality } {
  const adjacency = new Map<string, NormalizedReference[]>();
  const edgeMetadata = new Map<string, NormalizedEdge>();
  for (const record of vector.records) {
    const from = sourceReference(record);
    for (const dependent of record.dependents) {
      const edge: NormalizedEdge = { from, to: dependent, relation: dependent.relation };
      const key = edgeKey(from, dependent);
      const list = adjacency.get(recordKey(from)) ?? [];
      list.push(dependent);
      adjacency.set(recordKey(from), list);
      edgeMetadata.set(key, edge);
    }
  }
  for (const edge of inputEdges) {
    const key = edgeKey(edge.from, edge.to);
    const list = adjacency.get(recordKey(edge.from)) ?? [];
    list.push(edge.to);
    adjacency.set(recordKey(edge.from), list);
    edgeMetadata.set(key, edge);
  }

  const roots: RootChange[] = [];
  const unaffected = new Map<string, ChangeRadiusRecordReference>();
  const rootKeys = new Set<string>();
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (!isRecordObject(change)) fail("INVALID_COMMAND", "Proposed changes must be objects.", `proposedChanges[${index}]`);
    validateProposedChangeClaims(change, `proposedChanges[${index}]`);
    const family = normalizeChangeFamily(change, `proposedChanges[${index}]`);
    const recordId = normalizeChangeRecordId(change, `proposedChanges[${index}]`);
    const changeScope = change.scope === undefined ? scope : assertScope(change.scope, `proposedChanges[${index}].scope`);
    assertSameScope(scope, changeScope, `proposedChanges[${index}].scope`);
    const key = recordKey({ family, recordId });
    if (rootKeys.has(key)) fail("DUPLICATE_CHANGE", "Each source record may be changed once per proposal.", `proposedChanges[${index}]`);
    rootKeys.add(key);
    const source = vector.byKey.get(key);
    if (!source) {
      fail("SOURCE_RECORD_MISSING", "Every proposed change must name a record in the exact before source vector.", `proposedChanges[${index}]`);
    }
    const changeBefore = changeValue(change, "before");
    const changeAfter = changeValue(change, "after");
    if (!changeAfter.present) fail("INVALID_COMMAND", "Every proposed change requires after terms.", `proposedChanges[${index}].after`);
    if (change.beforeTerms !== undefined && change.before !== undefined && !equalValues(change.beforeTerms, change.before)) {
      fail("CONTRADICTORY_BEFORE", "before and beforeTerms disagree.", `proposedChanges[${index}].before`);
    }
    if (change.afterTerms !== undefined && change.after !== undefined && !equalValues(change.afterTerms, change.after)) {
      fail("CONTRADICTORY_IMPACTS", "after and afterTerms disagree.", `proposedChanges[${index}].after`);
    }
    if (source && change.sourceFingerprint !== undefined && change.sourceFingerprint !== source.sourceFingerprint) {
      fail("STALE_SOURCE_VECTOR", "Proposed change source fingerprint does not match the exact source vector.", `proposedChanges[${index}].sourceFingerprint`);
    }
    if (source && change.expectedRevision !== undefined && change.expectedRevision !== source.revision) {
      fail("STALE_SOURCE_VECTOR", "Proposed change revision does not match the exact source vector.", `proposedChanges[${index}].expectedRevision`);
    }
    const before = assertExactBefore(source, changeBefore, `proposedChanges[${index}]`);
    const afterValue = changeAfter.value;
    if (!before.known || !source.baselineAvailable || !isKnownFamily(family)) {
      if (change.affected === false) {
        fail("CONTRADICTORY_IMPACTS", "An unknown or unavailable baseline cannot be asserted unaffected.", `proposedChanges[${index}]`);
      }
      const reasonCode = !before.known || !source.baselineAvailable ? "BASELINE_UNAVAILABLE" : "UNKNOWN_FAMILY";
      const sourceFingerprint = source.sourceFingerprint;
      const root: RootChange = {
        key,
        family,
        recordId,
        ...(change.kind === undefined ? (source.kind === undefined ? {} : { kind: source.kind }) : { kind: change.kind }),
        source,
        beforeKnown: before.known,
        ...(before.value === undefined ? {} : { beforeValue: before.value }),
        afterValue,
        reasonCode,
        depth: 0,
        sourceFingerprint,
        ...(change.affected === undefined ? {} : { expectedAffected: change.affected }),
      };
      roots.push(root);
      continue;
    }
    const comparison = compareMaterialTerms(before.value, afterValue, policy.termPolicy ?? policy.materialTerms);
    if (change.beforeFingerprint !== undefined && !matchesValueFingerprint(change.beforeFingerprint, before.value, source.sourceFingerprint)) {
      fail("STALE_SOURCE_VECTOR", "beforeFingerprint does not match the source record fingerprint.", `proposedChanges[${index}].beforeFingerprint`);
    }
    if (change.afterFingerprint !== undefined && !matchesValueFingerprint(change.afterFingerprint, afterValue)) {
      fail("CONTRADICTORY_IMPACTS", "afterFingerprint does not match the proposed after terms.", `proposedChanges[${index}].afterFingerprint`);
    }
    if (!comparison.changed) {
      if (change.affected === true) fail("CONTRADICTORY_IMPACTS", "An unchanged source record cannot be asserted affected.", `proposedChanges[${index}]`);
      unaffected.set(key, { family, recordId, scope });
      continue;
    }
    if (change.affected === false) fail("CONTRADICTORY_IMPACTS", "A changed source record cannot be asserted unaffected.", `proposedChanges[${index}]`);
    roots.push({
      key,
      family,
      recordId,
      ...(change.kind === undefined ? (source.kind === undefined ? {} : { kind: source.kind }) : { kind: change.kind }),
      source,
      comparison,
      beforeKnown: before.known,
      ...(before.value === undefined ? {} : { beforeValue: before.value }),
      afterValue,
      reasonCode: "MATERIAL_TERM_CHANGED",
      depth: 0,
      sourceFingerprint: source.sourceFingerprint,
      ...(change.affected === undefined ? {} : { expectedAffected: change.affected }),
    });
  }

  const accumulators = new Map<string, NodeAccumulator>();
  const queue: Array<{ readonly reference: NormalizedReference; readonly context: TraversalContext; readonly depth: number; readonly upstream: string }> = [];
  const traversed = new Set<string>();
  for (const root of roots) {
    const reference: NormalizedReference = { family: root.family, recordId: root.recordId, scope, relation: DEFAULT_RELATION };
    const comparison = root.comparison;
    const rootMateriality = root.reasonCode === "UNKNOWN_FAMILY" || root.reasonCode === "BASELINE_UNAVAILABLE"
      ? "UNKNOWN"
      : rootMaterialityFor(root.family, comparison as MaterialTermComparison, policy);
    const accumulator = createAccumulator(
      reference,
      root.source,
      rootMateriality,
      root.reasonCode,
      0,
      root.sourceFingerprint,
      comparison?.changedTerms ?? [],
      root.beforeValue,
      root.afterValue,
    );
    if (root.reasonCode === "UNKNOWN_FAMILY") accumulator.sourceFamily = root.family;
    accumulators.set(root.key, accumulator);
    const context: TraversalContext = {
      rootKey: root.key,
      rootMateriality,
      rootTermKinds: termsForPropagation(comparison),
      rootChangedTerms: comparison?.changedTerms ?? [],
    };
    queue.push({ reference, context, depth: 0, upstream: root.recordId });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const currentKey = recordKey(current.reference);
    const traversalKey = `${current.context.rootKey}\u0001${currentKey}`;
    if (traversed.has(traversalKey)) continue;
    traversed.add(traversalKey);
    if (current.depth > CHANGE_RADIUS_LIMITS.maxGraphDepth) fail("UNBOUNDED_GRAPH", "Impact traversal depth exceeded.", currentKey);
    const children = stableSort(adjacency.get(currentKey) ?? [], (left, right) => compareStableStrings(recordKey(left), recordKey(right)));
    for (const child of children) {
      const childKey = recordKey(child);
      const source = vector.byKey.get(childKey);
      const materiality = propagatedMateriality(child.family, current.context, source, policy);
      const sourceFingerprint = source?.sourceFingerprint ?? `missing:${child.family}:${child.recordId}`;
      const existing = accumulators.get(childKey);
      if (existing) {
        mergeAccumulator(
          existing,
          materiality,
          source?.baselineAvailable === false || source === undefined ? "BASELINE_UNAVAILABLE" : "DEPENDENCY_OF_CHANGED_RECORD",
          current.depth + 1,
          [sourceFingerprint],
          [current.reference.recordId],
          current.context.rootChangedTerms,
        );
      } else {
        const created = createAccumulator(
          child,
          source,
          materiality,
          source?.baselineAvailable === false || source === undefined ? "BASELINE_UNAVAILABLE" : "DEPENDENCY_OF_CHANGED_RECORD",
          current.depth + 1,
          sourceFingerprint,
          current.context.rootChangedTerms,
        );
        if (!isKnownFamily(child.family)) created.sourceFamily = child.family;
        created.upstreamRecordIds.add(current.reference.recordId);
        accumulators.set(childKey, created);
      }
      const edge = edgeMetadata.get(edgeKey(current.reference, child));
      if (edge?.affected === false) fail("CONTRADICTORY_IMPACTS", "An impact edge cannot suppress a downstream record.", edgeKey(current.reference, child));
      queue.push({
        reference: child,
        context: current.context,
        depth: current.depth + 1,
        upstream: current.reference.recordId,
      });
    }
  }

  const requiredFamilies = new Set<string>([
    ...(policy.requiredFamilies ?? []),
    ...(policy.unavailableFamilies ?? []),
  ]);
  if (requiredFamilies.size > CHANGE_RADIUS_LIMITS.maxGraphNodes) {
    fail("UNBOUNDED_GRAPH", "Required-family bound exceeded.", "requiredFamilies");
  }
  const commandRecord = command as Record<string, unknown>;
  if (policy.operatorBaselineAvailable === false || policy.operatorReleaseBaselineAvailable === false || commandRecord.operatorBaselineAvailable === false || commandRecord.operatorReleaseBaselineAvailable === false) {
    requiredFamilies.add("OPERATOR_RELEASE");
  }
  const forcedUnavailableFamilies = new Set<string>([
    ...(policy.unavailableFamilies ?? []),
    ...(command.unavailableFamilies ?? []),
  ]);
  if (policy.operatorBaselineAvailable === false || policy.operatorReleaseBaselineAvailable === false || commandRecord.operatorBaselineAvailable === false || commandRecord.operatorReleaseBaselineAvailable === false) {
    forcedUnavailableFamilies.add("OPERATOR_RELEASE");
  }
  for (const requiredFamily of [...requiredFamilies].sort(compareStableStrings)) {
    const available = vector.records.some((record) => record.family === requiredFamily && record.baselineAvailable);
    const impacted = [...accumulators.values()].some((accumulator) => accumulator.family === requiredFamily);
    if (!available || forcedUnavailableFamilies.has(requiredFamily)) {
      if (impacted && forcedUnavailableFamilies.has(requiredFamily)) {
        for (const accumulator of accumulators.values()) {
          if (accumulator.family !== requiredFamily) continue;
          accumulator.materiality = "UNKNOWN";
          addReason(accumulator, "REQUIRED_BASELINE_UNAVAILABLE");
        }
      } else if (!impacted) {
        const reference: NormalizedReference = { family: requiredFamily, recordId: `baseline:${requiredFamily}`, scope, relation: "required-baseline" };
        const missing = createAccumulator(reference, undefined, "UNKNOWN", "REQUIRED_BASELINE_UNAVAILABLE", 0, `missing:${requiredFamily}`, []);
        if (!isKnownFamily(requiredFamily)) missing.sourceFamily = requiredFamily;
        accumulators.set(recordKey(reference), missing);
      }
    }
  }
  if (accumulators.size > CHANGE_RADIUS_LIMITS.maxGraphNodes) {
    fail("UNBOUNDED_GRAPH", "Impact-node bound exceeded.", "impactGraph");
  }

  const nodes = new Map<string, AffectedRecord>();
  for (const [key, accumulator] of accumulators) nodes.set(key, createOutputRecord(accumulator, scope));
  const outputEdges: ImpactEdge[] = [];
  for (const [key, metadata] of edgeMetadata) {
    const from = key.split("\u0001")[0];
    const to = key.split("\u0001")[1];
    const fromReference = nodes.get(from);
    const toReference = nodes.get(to);
    if (!fromReference || !toReference) continue;
    outputEdges.push({
      from: outputNodeReference(fromReference),
      to: outputNodeReference(toReference),
      relation: metadata.relation,
      depth: toReference.depth,
      reasonFingerprint: fingerprint({ from, to, relation: metadata.relation }),
    });
  }
  const outputRoots = stableSort(
    roots.map((root) => outputReference({ family: root.family, recordId: root.recordId, scope, relation: DEFAULT_RELATION })),
    (left, right) => compareStableStrings(stableReferenceSortKey(left), stableReferenceSortKey(right)),
  );
  const outputUnaffected = stableSort([...unaffected.values()], (left, right) => compareStableStrings(
    stableReferenceSortKey(left),
    stableReferenceSortKey(right),
  ));
  const sortedNodes = stableSort([...nodes.values()], (left, right) => compareStableStrings(
    stableAffectedRecordSortKey(left),
    stableAffectedRecordSortKey(right),
  ));
  const sortedEdges = stableSort(outputEdges, (left, right) => compareStableStrings(canonicalJson(left), canonicalJson(right)));
  const graphWithoutFingerprint = {
    roots: outputRoots,
    nodes: sortedNodes,
    edges: sortedEdges,
    unaffected: outputUnaffected,
    nodeCount: sortedNodes.length,
    edgeCount: sortedEdges.length,
    maxDepth: sortedNodes.reduce((maximum, node) => Math.max(maximum, node.depth), 0),
  };
  const graphFingerprint = fingerprint(fingerprintableGraphWithoutFingerprint(graphWithoutFingerprint));
  const graph: ImpactGraph = deepFreeze({ ...graphWithoutFingerprint, fingerprint: graphFingerprint });
  let materiality: Materiality = "INFORMATIONAL";
  for (const node of sortedNodes) materiality = maxMateriality(materiality, node.materiality);
  return { graph, materiality };
}

function rootMaterialityFor(family: string, comparison: MaterialTermComparison, policy: ChangeRadiusPolicy): Materiality {
  return rootMateriality(family, comparison, policy);
}

function validateGraphAssertions(
  command: ProposedChangeCommandEnvelope,
  changes: readonly ProposedChange[],
  inputEdges: readonly NormalizedEdge[],
  graph: ImpactGraph,
  scope: ChangeRadiusScope,
): void {
  const nodes = new Map(graph.nodes.map((node) => [recordKey(node), node]));
  const unaffected = new Set(graph.unaffected.map(recordKey));
  applyAssertions(normalizeAssertions(command, changes, scope), nodes, unaffected);
  checkInputEdgeAssertions(inputEdges, nodes);
}

function buildResult(
  command: ProposedChangeCommandEnvelope,
  scope: ChangeRadiusScope,
  vector: NormalizedVector,
  graph: ImpactGraph,
  materiality: Materiality,
): ChangeRadiusPreflightResult {
  const sourceFingerprints = stableSort(
    [...new Set(graph.nodes.flatMap((node) => node.sourceFingerprints))],
    compareStableStrings,
  );
  const reasonFingerprints = stableSort(
    [...new Set(graph.nodes.map((node) => node.reasonFingerprint))],
    compareStableStrings,
  );
  const requiresReconfirmation = graph.nodes.some((node) => node.materiality === "RECONFIRMATION");
  const blocking = graph.nodes.some((node) => node.materiality === "BLOCKING");
  const requiresReview = graph.nodes.some((node) => materialityRank(node.materiality) >= materialityRank("REVIEW"));
  const resultWithoutFingerprint = {
    kind: "CHANGE_RADIUS_PREFLIGHT" as const,
    schemaVersion: CHANGE_RADIUS_SCHEMA_VERSION,
    commandId: command.commandId,
    scope,
    authoritative: false as const,
    isAuthoritative: false as const,
    nonAuthoritative: true as const,
    canApply: false as const,
    canSend: false as const,
    canMutate: false as const,
    mutatesState: false as const,
    applied: false as const,
    sent: false as const,
    status: "PREVIEW_ONLY" as const,
    materiality,
    requiresReview,
    requiresReconfirmation,
    blocking,
    sourceVectorFingerprint: vector.fingerprint,
    reasonFingerprints,
    sourceFingerprints,
    graph,
    affectedRecords: graph.nodes,
  };
  const resultFingerprint = fingerprint({
    ...resultWithoutFingerprint,
    graph: fingerprintableGraph(graph),
    affectedRecords: graph.nodes.map(fingerprintableAffectedRecord),
  });
  return deepFreeze({ ...resultWithoutFingerprint, fingerprint: resultFingerprint });
}

/**
 * Pure, non-authoritative Change-Radius preflight. It only reads the supplied
 * immutable proposal and returns a frozen projection; it never applies, sends,
 * persists, or mutates business state.
 */
export function preflightChangeRadius(command: ProposedChangeCommandEnvelope): ChangeRadiusPreflightResult {
  const input = snapshotPlainData(command, "command");
  if (!isRecordObject(input)) fail("INVALID_COMMAND", "Command envelope must be a plain object.", "command");
  normalizeCommandType(input);
  const commandId = assertString(input.commandId, "commandId");
  const scope = commandScope(input);
  const vector = normalizeSourceVector(input, scope);
  validateFreshness(input, vector);
  const changes = normalizeChanges(input);
  const policy = normalizePolicy(input);
  const inputEdges = normalizeInputEdges(input, scope);
  const allEdges = combineAndRejectDuplicateEdges(vector, inputEdges);
  const references = [
    ...vector.records.map(sourceReference),
    ...inputEdges.flatMap((edge) => [edge.from, edge.to]),
    ...changes.map((change) => ({
      family: typeof change.family === "string" ? change.family : change.recordType ?? "",
      recordId: typeof change.recordId === "string" ? change.recordId : "",
      scope,
      relation: DEFAULT_RELATION,
    })),
  ];
  findCycleAndDepth(
    allEdges,
    references,
  );
  const graphResult = buildGraph(input, scope, vector, changes, policy, inputEdges);
  validateGraphAssertions(input, changes, inputEdges, graphResult.graph, scope);
  const result = buildResult({ ...input, commandId }, scope, vector, graphResult.graph, graphResult.materiality);
  return result;
}

export const previewChangeRadius = preflightChangeRadius;
export const calculateChangeRadius = preflightChangeRadius;
export const preflight = preflightChangeRadius;
export const preflightProposedChange = preflightChangeRadius;
export const analyzeChangeRadius = preflightChangeRadius;

export function fingerprintSourceVector(vector: ExactBeforeSourceVector): string {
  const sourceVector = snapshotPlainData(vector, "sourceVector");
  if (!isRecordObject(sourceVector)) fail("INVALID_COMMAND", "Source vector must be a plain object.", "sourceVector");
  assertKnownKeys(sourceVector, SOURCE_VECTOR_KEYS, "sourceVector");
  const scope = sourceVectorScope(sourceVector, "sourceVector");
  const normalized = normalizeSourceVector({
    commandId: "fingerprint-source-vector",
    scope,
    beforeSourceVector: sourceVector,
  }, scope);
  return normalized.fingerprint;
}

export function fingerprintSourceRecord(record: ChangeRadiusSourceRecord, scope: ChangeRadiusScope, revision: number): string {
  assertClaimRevision(revision, "revision");
  const sourceRecord = snapshotPlainData(record, "sourceRecord");
  if (!isRecordObject(sourceRecord)) fail("INVALID_COMMAND", "Source record must be a plain object.", "sourceRecord");
  const sourceScope = assertScope(snapshotPlainData(scope, "scope"), "scope");
  return validateSourceRecordFingerprint(sourceRecord, sourceScope, revision, "sourceRecord");
}

export const canonicalSourceVectorFingerprint = fingerprintSourceVector;

export function fingerprintImpactGraph(graph: ImpactGraph): string {
  const { fingerprint: _ignored, ...withoutFingerprint } = graph;
  return fingerprint(fingerprintableGraphWithoutFingerprint(withoutFingerprint));
}

export const canonicalImpactGraphFingerprint = fingerprintImpactGraph;
