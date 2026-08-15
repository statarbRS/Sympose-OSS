import { createHash } from "node:crypto";

import {
  ABSOLUTE_PROOF_GRAPH_LIMITS,
  AUDIENCE_KINDS,
  BLOCKER_CODES,
  DEFAULT_PROOF_GRAPH_LIMITS,
  EVIDENCE_STATES,
  NEXT_ACTION_KINDS,
  READINESS_OUTCOMES,
  READINESS_PROOF_GRAPH_SCHEMA,
  SOURCE_FAMILIES,
  ProofGraphValidationError,
  type AudienceReference,
  type AudienceKind,
  type AuthorizedEvidence,
  type AuthorityReference,
  type BlockerCode,
  type BlockerReceipt,
  type EvidenceState,
  type NextActionKind,
  type OutcomeEvaluation,
  type ProofGraphLimits,
  type ProofScope,
  type ProofStatus,
  type ReadinessOutcome,
  type ReadinessProofGraphInput,
  type ReadinessProofGraphResult,
  type ReadinessRequirement,
  type RequirementEvaluation,
  type ResolvedProofGraphLimits,
  type SourceFamily,
  type ValidNextAction,
} from "./contracts";

interface NormalizedGraph {
  readonly scope: ProofScope;
  readonly evidence: readonly AuthorizedEvidence[];
  readonly requirements: readonly ReadinessRequirement[];
  readonly limits: ResolvedProofGraphLimits;
}

interface LocalEvaluation {
  readonly status: ProofStatus;
  readonly blockers: readonly BlockerReceipt[];
  readonly matchedEvidenceIds: readonly string[];
}

interface InternalRequirementEvaluation extends RequirementEvaluation {}

interface EvaluationBudget {
  readonly limits: ResolvedProofGraphLimits;
  emittedBlockerEntries: number;
}

const BLOCKER_MESSAGES: Readonly<Record<BlockerCode, string>> = Object.freeze({
  SOURCE_FAMILY_UNAVAILABLE: "The required source family is unavailable.",
  EVIDENCE_UNAVAILABLE: "The exact evidence is unavailable.",
  UNKNOWN_EVIDENCE: "The exact evidence is unknown and cannot authorize this outcome.",
  STALE_AUTHORITY: "The matching authority is not current.",
  SUPERSEDED_AUTHORITY: "The matching authority has been superseded.",
  NON_CURRENT_AUTHORITY: "The matching authority is not current.",
  EVIDENCE_BLOCKED: "The exact evidence is explicitly blocked.",
  EVIDENCE_CONFLICTING: "The exact evidence is conflicting.",
  EXACT_VERSION_MISMATCH: "Evidence exists for a different exact version.",
  EXACT_FINGERPRINT_MISMATCH: "Evidence exists for a different exact fingerprint.",
  AUDIENCE_MISMATCH: "Evidence exists for a different audience.",
  MISSING_EXACT_EVIDENCE: "The exact required evidence is missing.",
  DEPENDENCY_BLOCKED: "A required dependency is blocked.",
  DEPENDENCY_UNAVAILABLE: "A required dependency is unavailable.",
});

const UNIVERSAL_ACTIONS: readonly NextActionKind[] = [
  "SUPPLY_CURRENT_EVIDENCE",
  "REPLACE_SUPERSEDED_EVIDENCE",
  "RESOLVE_CONFLICT",
  "REVIEW_UNKNOWN_EVIDENCE",
];

const OUTCOME_ACTIONS: Readonly<Record<ReadinessOutcome, readonly NextActionKind[]>> = Object.freeze({
  OFFER: ["RECORD_CURRENT_APPROVAL"],
  CONFIRMATION: ["CONFIRM_EXACT_OFFER"],
  SCHEDULING: ["SCHEDULE_EXACT_COMMITMENT"],
  PUBLICATION: ["PUBLISH_EXACT_RELEASE"],
  OPERATOR_RELEASE: ["RELEASE_TO_OPERATOR"],
});

const OUTCOME_ORDER = new Map<ReadinessOutcome, number>(
  READINESS_OUTCOMES.map((outcome, index) => [outcome, index]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function fail(
  code: ConstructorParameters<typeof ProofGraphValidationError>[0],
  path: string,
): never {
  throw new ProofGraphValidationError(code, path, `${code} at ${path}`);
}

function assertRecord(value: unknown, path: string, code: ConstructorParameters<typeof ProofGraphValidationError>[0]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(code, path);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: ConstructorParameters<typeof ProofGraphValidationError>[0],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(code, `${path}.${key}`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeString(
  value: unknown,
  path: string,
  maxStringLength: number,
  code: ConstructorParameters<typeof ProofGraphValidationError>[0] = "INVALID_INPUT",
): string {
  if (typeof value !== "string") fail(code, path);
  const normalized = value.normalize("NFC");
  if (normalized.length === 0 || normalized.length > maxStringLength) fail(code, path);
  if (/\u0000/.test(normalized)) fail(code, path);
  return normalized;
}

function normalizeOptionalString(
  value: unknown,
  path: string,
  maxStringLength: number,
  code: ConstructorParameters<typeof ProofGraphValidationError>[0] = "INVALID_INPUT",
): string | undefined {
  if (value === undefined) return undefined;
  return normalizeString(value, path, maxStringLength, code);
}

function assertBoolean(value: unknown, path: string, code: ConstructorParameters<typeof ProofGraphValidationError>[0]): asserts value is boolean {
  if (typeof value !== "boolean") fail(code, path);
}

function assertArray(value: unknown, path: string, code: ConstructorParameters<typeof ProofGraphValidationError>[0]): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) fail(code, path);
}

type SnapshotRecord = Record<string, unknown>;
type Snapshotter = (value: unknown, path: string) => unknown;

function ownKeys(value: object, path: string, code: ConstructorParameters<typeof ProofGraphValidationError>[0]): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    fail(code, path);
  }
}

function ownDataDescriptor(
  value: object,
  key: string,
  path: string,
  code: ConstructorParameters<typeof ProofGraphValidationError>[0],
): PropertyDescriptor {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(code, `${path}.${key}`);
  }
  if (!descriptor || !("value" in descriptor)) fail(code, `${path}.${key}`);
  return descriptor;
}

function snapshotRecord(
  value: unknown,
  path: string,
  code: ConstructorParameters<typeof ProofGraphValidationError>[0],
  allowedKeys: readonly string[],
  nested: Readonly<Record<string, Snapshotter>> = {},
): SnapshotRecord {
  assertRecord(value, path, code);
  const allowed = new Set(allowedKeys);
  const output: SnapshotRecord = Object.create(null) as SnapshotRecord;
  for (const key of ownKeys(value, path, code)) {
    if (typeof key !== "string" || !allowed.has(key)) fail(code, path);
    const descriptor = ownDataDescriptor(value, key, path, code);
    const snapshot = nested[key];
    output[key] = snapshot === undefined
      ? descriptor.value
      : snapshot(descriptor.value, `${path}.${key}`);
  }
  return Object.freeze(output);
}

function snapshotArray(
  value: unknown,
  path: string,
  code: ConstructorParameters<typeof ProofGraphValidationError>[0],
  maxLength: number,
  nested?: Snapshotter,
): readonly unknown[] {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail(code, path);
  }
  if (!isArray) fail(code, path);

  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of ownKeys(value as object, path, code)) {
    if (typeof key !== "string") fail(code, path);
    const descriptor = ownDataDescriptor(value as object, key, path, code);
    descriptors.set(key, descriptor);
  }
  const lengthDescriptor = descriptors.get("length");
  if (!lengthDescriptor || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    fail(code, `${path}.length`);
  }
  const length = lengthDescriptor.value as number;
  if (length > maxLength) fail("SIZE_LIMIT_EXCEEDED", path);

  for (const key of descriptors.keys()) {
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
      fail(code, path);
    }
  }

  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors.get(String(index));
    if (!descriptor) fail(code, `${path}[${index}]`);
    const snapshot = nested === undefined
      ? descriptor.value
      : nested(descriptor.value, `${path}[${index}]`);
    output.push(snapshot);
  }
  return Object.freeze(output);
}

function snapshotScope(value: unknown, path: string): SnapshotRecord {
  return snapshotRecord(value, path, "INVALID_SCOPE", ["workspaceId", "eventId", "subjectId"]);
}

function snapshotAudience(value: unknown, path: string): SnapshotRecord {
  return snapshotRecord(value, path, "INVALID_REFERENCE", ["kind", "id", "version", "fingerprint"]);
}

function snapshotAuthority(value: unknown, path: string): SnapshotRecord {
  return snapshotRecord(
    value,
    path,
    "INVALID_REFERENCE",
    ["scope", "kind", "id", "version", "fingerprint", "current", "superseded", "audience"],
    { scope: snapshotScope, audience: snapshotAudience },
  );
}

function snapshotEvidence(value: unknown, path: string): SnapshotRecord {
  return snapshotRecord(
    value,
    path,
    "INVALID_EVIDENCE",
    ["id", "scope", "family", "authority", "state", "reason"],
    { scope: snapshotScope, authority: snapshotAuthority },
  );
}

function snapshotAction(value: unknown, path: string): SnapshotRecord {
  return snapshotRecord(
    value,
    path,
    "INVALID_NEXT_ACTION",
    ["id", "kind", "label", "targetRequirementId"],
  );
}

function snapshotRequirement(value: unknown, path: string): SnapshotRecord {
  return snapshotRecord(
    value,
    path,
    "INVALID_REQUIREMENT",
    ["id", "scope", "outcome", "label", "sourceFamily", "authority", "dependsOn", "nextActions"],
    {
      scope: snapshotScope,
      authority: snapshotAuthority,
      dependsOn: (candidate, candidatePath) =>
        snapshotArray(candidate, candidatePath, "INVALID_REQUIREMENT", ABSOLUTE_PROOF_GRAPH_LIMITS.maxEdges),
      nextActions: (candidate, candidatePath) =>
        snapshotArray(
          candidate,
          candidatePath,
          "INVALID_NEXT_ACTION",
          ABSOLUTE_PROOF_GRAPH_LIMITS.maxActionsPerRequirement,
          snapshotAction,
        ),
    },
  );
}

function snapshotLimits(value: unknown, path: string): SnapshotRecord {
  return snapshotRecord(
    value,
    path,
    "INVALID_LIMIT",
    [
      "maxNodes",
      "maxEvidenceNodes",
      "maxRequirementNodes",
      "maxEdges",
      "maxDepth",
      "maxActionsPerRequirement",
      "maxBlockerReceipts",
      "maxEvidenceIdsPerBlocker",
      "maxStringLength",
    ],
  );
}

function snapshotGraphInput(value: unknown): SnapshotRecord {
  return snapshotRecord(
    value,
    "$",
    "INVALID_INPUT",
    ["scope", "evidence", "requirements", "limits"],
    {
      scope: snapshotScope,
      evidence: (candidate, path) =>
        snapshotArray(
          candidate,
          path,
          "INVALID_EVIDENCE",
          ABSOLUTE_PROOF_GRAPH_LIMITS.maxEvidenceNodes,
          snapshotEvidence,
        ),
      requirements: (candidate, path) =>
        snapshotArray(
          candidate,
          path,
          "INVALID_REQUIREMENT",
          ABSOLUTE_PROOF_GRAPH_LIMITS.maxRequirementNodes,
          snapshotRequirement,
        ),
      limits: (candidate, path) => candidate === undefined ? undefined : snapshotLimits(candidate, path),
    },
  );
}

function isSourceFamily(value: string): value is SourceFamily {
  return (SOURCE_FAMILIES as readonly string[]).includes(value);
}

function isReadinessOutcome(value: string): value is ReadinessOutcome {
  return (READINESS_OUTCOMES as readonly string[]).includes(value);
}

function isEvidenceState(value: string): value is EvidenceState {
  return (EVIDENCE_STATES as readonly string[]).includes(value);
}

function isNextActionKind(value: string): value is NextActionKind {
  return (NEXT_ACTION_KINDS as readonly string[]).includes(value);
}

function isAudienceKind(value: string): value is AudienceKind {
  return (AUDIENCE_KINDS as readonly string[]).includes(value);
}

function sortStrings(values: readonly string[]): readonly string[] {
  return [...values].sort(compareStrings);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(canonicalValue);
    return normalized.sort((left, right) =>
      compareStrings(JSON.stringify(left), JSON.stringify(right)),
    );
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) {
      result[key] = canonicalValue(value[key]);
    }
    return result;
  }

  return value;
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value));
  if (serialized === undefined) fail("INVALID_INPUT", "$.canonical");
  return serialized;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sameScope(left: ProofScope, right: ProofScope): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeScope(
  value: unknown,
  path: string,
  maxStringLength: number,
): ProofScope {
  assertRecord(value, path, "INVALID_SCOPE");
  assertKnownKeys(value, ["workspaceId", "eventId", "subjectId"], path, "INVALID_SCOPE");
  const workspaceId = normalizeString(value.workspaceId, `${path}.workspaceId`, maxStringLength, "INVALID_SCOPE");
  const eventId = normalizeOptionalString(value.eventId, `${path}.eventId`, maxStringLength, "INVALID_SCOPE");
  const subjectId = normalizeOptionalString(value.subjectId, `${path}.subjectId`, maxStringLength, "INVALID_SCOPE");
  return {
    workspaceId,
    ...(eventId === undefined ? {} : { eventId }),
    ...(subjectId === undefined ? {} : { subjectId }),
  };
}

function normalizeAudience(
  value: unknown,
  path: string,
  maxStringLength: number,
): AudienceReference {
  assertRecord(value, path, "INVALID_REFERENCE");
  assertKnownKeys(value, ["kind", "id", "version", "fingerprint"], path, "INVALID_REFERENCE");
  const kind = normalizeString(value.kind, `${path}.kind`, maxStringLength, "INVALID_REFERENCE");
  if (!isAudienceKind(kind)) fail("INVALID_REFERENCE", `${path}.kind`);
  return {
    kind,
    id: normalizeString(value.id, `${path}.id`, maxStringLength, "INVALID_REFERENCE"),
    version: normalizeString(value.version, `${path}.version`, maxStringLength, "INVALID_REFERENCE"),
    fingerprint: normalizeString(value.fingerprint, `${path}.fingerprint`, maxStringLength, "INVALID_REFERENCE"),
  };
}

function normalizeAuthority(
  value: unknown,
  path: string,
  graphScope: ProofScope,
  maxStringLength: number,
): AuthorityReference {
  assertRecord(value, path, "INVALID_REFERENCE");
  assertKnownKeys(
    value,
    ["scope", "kind", "id", "version", "fingerprint", "current", "superseded", "audience"],
    path,
    "INVALID_REFERENCE",
  );

  const scope = normalizeScope(value.scope, `${path}.scope`, maxStringLength);
  if (!sameScope(scope, graphScope)) fail("CROSS_SCOPE_REFERENCE", `${path}.scope`);
  const kind = normalizeString(value.kind, `${path}.kind`, maxStringLength, "INVALID_REFERENCE");
  const id = normalizeString(value.id, `${path}.id`, maxStringLength, "INVALID_REFERENCE");
  const version = normalizeString(value.version, `${path}.version`, maxStringLength, "INVALID_REFERENCE");
  const authorityFingerprint = normalizeString(
    value.fingerprint,
    `${path}.fingerprint`,
    maxStringLength,
    "INVALID_REFERENCE",
  );
  assertBoolean(value.current, `${path}.current`, "INVALID_REFERENCE");
  assertBoolean(value.superseded, `${path}.superseded`, "INVALID_REFERENCE");
  if (value.current && value.superseded) fail("INVALID_REFERENCE", path);
  return {
    scope,
    kind,
    id,
    version,
    fingerprint: authorityFingerprint,
    current: value.current,
    superseded: value.superseded,
    audience: normalizeAudience(value.audience, `${path}.audience`, maxStringLength),
  };
}

function normalizeEvidence(
  value: unknown,
  path: string,
  graphScope: ProofScope,
  limits: ResolvedProofGraphLimits,
): AuthorizedEvidence {
  assertRecord(value, path, "INVALID_EVIDENCE");
  assertKnownKeys(value, ["id", "scope", "family", "authority", "state", "reason"], path, "INVALID_EVIDENCE");
  const scope = normalizeScope(value.scope, `${path}.scope`, limits.maxStringLength);
  if (!sameScope(scope, graphScope)) fail("CROSS_SCOPE_REFERENCE", `${path}.scope`);
  const family = normalizeString(value.family, `${path}.family`, limits.maxStringLength, "INVALID_EVIDENCE");
  if (!isSourceFamily(family)) fail("INVALID_EVIDENCE", `${path}.family`);
  const state = normalizeString(value.state, `${path}.state`, limits.maxStringLength, "INVALID_EVIDENCE");
  if (!isEvidenceState(state)) fail("INVALID_EVIDENCE", `${path}.state`);
  return {
    id: normalizeString(value.id, `${path}.id`, limits.maxStringLength, "INVALID_EVIDENCE"),
    scope,
    family,
    authority: normalizeAuthority(value.authority, `${path}.authority`, graphScope, limits.maxStringLength),
    state,
    ...(value.reason === undefined
      ? {}
      : { reason: normalizeString(value.reason, `${path}.reason`, limits.maxStringLength, "INVALID_EVIDENCE") }),
  };
}

function isActionAllowedForOutcome(outcome: ReadinessOutcome, kind: NextActionKind): boolean {
  return UNIVERSAL_ACTIONS.includes(kind) || OUTCOME_ACTIONS[outcome].includes(kind);
}

function normalizeAction(
  value: unknown,
  path: string,
  requirementId: string,
  outcome: ReadinessOutcome,
  limits: ResolvedProofGraphLimits,
): ValidNextAction {
  assertRecord(value, path, "INVALID_NEXT_ACTION");
  assertKnownKeys(value, ["id", "kind", "label", "targetRequirementId"], path, "INVALID_NEXT_ACTION");
  const kind = normalizeString(value.kind, `${path}.kind`, limits.maxStringLength, "INVALID_NEXT_ACTION");
  if (!isNextActionKind(kind) || !isActionAllowedForOutcome(outcome, kind)) {
    fail("INVALID_NEXT_ACTION", `${path}.kind`);
  }
  const targetRequirementId = normalizeString(
    value.targetRequirementId,
    `${path}.targetRequirementId`,
    limits.maxStringLength,
    "INVALID_NEXT_ACTION",
  );
  if (targetRequirementId !== requirementId) fail("INVALID_NEXT_ACTION", `${path}.targetRequirementId`);
  return {
    id: normalizeString(value.id, `${path}.id`, limits.maxStringLength, "INVALID_NEXT_ACTION"),
    kind,
    label: normalizeString(value.label, `${path}.label`, limits.maxStringLength, "INVALID_NEXT_ACTION"),
    targetRequirementId,
  };
}

function normalizeRequirement(
  value: unknown,
  path: string,
  graphScope: ProofScope,
  limits: ResolvedProofGraphLimits,
): ReadinessRequirement {
  assertRecord(value, path, "INVALID_REQUIREMENT");
  assertKnownKeys(
    value,
    ["id", "scope", "outcome", "label", "sourceFamily", "authority", "dependsOn", "nextActions"],
    path,
    "INVALID_REQUIREMENT",
  );
  const scope = normalizeScope(value.scope, `${path}.scope`, limits.maxStringLength);
  if (!sameScope(scope, graphScope)) fail("CROSS_SCOPE_REFERENCE", `${path}.scope`);
  const id = normalizeString(value.id, `${path}.id`, limits.maxStringLength, "INVALID_REQUIREMENT");
  const outcome = normalizeString(value.outcome, `${path}.outcome`, limits.maxStringLength, "INVALID_REQUIREMENT");
  if (!isReadinessOutcome(outcome)) fail("INVALID_REQUIREMENT", `${path}.outcome`);
  const sourceFamily = normalizeString(
    value.sourceFamily,
    `${path}.sourceFamily`,
    limits.maxStringLength,
    "INVALID_REQUIREMENT",
  );
  if (!isSourceFamily(sourceFamily)) fail("INVALID_REQUIREMENT", `${path}.sourceFamily`);
  const authority = normalizeAuthority(
    value.authority,
    `${path}.authority`,
    graphScope,
    limits.maxStringLength,
  );
  if (!authority.current || authority.superseded) fail("INVALID_REQUIREMENT", `${path}.authority`);

  const rawDependencies = value.dependsOn;
  assertArray(rawDependencies, `${path}.dependsOn`, "INVALID_REQUIREMENT");
  const dependsOn = rawDependencies.map((dependency, index) =>
    normalizeString(dependency, `${path}.dependsOn[${index}]`, limits.maxStringLength, "INVALID_REQUIREMENT"),
  );
  if (new Set(dependsOn).size !== dependsOn.length) fail("DUPLICATE_DEPENDENCY", `${path}.dependsOn`);

  const rawNextActions = value.nextActions;
  assertArray(rawNextActions, `${path}.nextActions`, "INVALID_NEXT_ACTION");
  if (rawNextActions.length > limits.maxActionsPerRequirement) {
    fail("SIZE_LIMIT_EXCEEDED", `${path}.nextActions`);
  }
  const nextActions = rawNextActions.map((action, index) =>
    normalizeAction(action, `${path}.nextActions[${index}]`, id, outcome, limits),
  );
  if (new Set(nextActions.map((action) => action.id)).size !== nextActions.length) {
    fail("DUPLICATE_NODE", `${path}.nextActions`);
  }

  return {
    id,
    scope,
    outcome,
    label: normalizeString(value.label, `${path}.label`, limits.maxStringLength, "INVALID_REQUIREMENT"),
    sourceFamily,
    authority,
    dependsOn: sortStrings(dependsOn),
    nextActions: [...nextActions].sort((left, right) =>
      compareStrings(canonicalJson(left), canonicalJson(right)),
    ),
  };
}

function resolveLimits(value: unknown): ResolvedProofGraphLimits {
  if (value === undefined) return { ...DEFAULT_PROOF_GRAPH_LIMITS };
  assertRecord(value, "$.limits", "INVALID_LIMIT");
  assertKnownKeys(
    value,
    [
      "maxNodes",
      "maxEvidenceNodes",
      "maxRequirementNodes",
      "maxEdges",
      "maxDepth",
      "maxActionsPerRequirement",
      "maxBlockerReceipts",
      "maxEvidenceIdsPerBlocker",
      "maxStringLength",
    ],
    "$.limits",
    "INVALID_LIMIT",
  );

  const read = (key: keyof ResolvedProofGraphLimits, fallback: number): number => {
    const candidate = value[key];
    if (candidate === undefined) return fallback;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) {
      fail("INVALID_LIMIT", `$.limits.${key}`);
    }
    if (candidate > ABSOLUTE_PROOF_GRAPH_LIMITS[key]) fail("INVALID_LIMIT", `$.limits.${key}`);
    return candidate;
  };

  return {
    maxNodes: read("maxNodes", DEFAULT_PROOF_GRAPH_LIMITS.maxNodes),
    maxEvidenceNodes: read("maxEvidenceNodes", DEFAULT_PROOF_GRAPH_LIMITS.maxEvidenceNodes),
    maxRequirementNodes: read("maxRequirementNodes", DEFAULT_PROOF_GRAPH_LIMITS.maxRequirementNodes),
    maxEdges: read("maxEdges", DEFAULT_PROOF_GRAPH_LIMITS.maxEdges),
    maxDepth: read("maxDepth", DEFAULT_PROOF_GRAPH_LIMITS.maxDepth),
    maxActionsPerRequirement: read(
      "maxActionsPerRequirement",
      DEFAULT_PROOF_GRAPH_LIMITS.maxActionsPerRequirement,
    ),
    maxBlockerReceipts: read("maxBlockerReceipts", DEFAULT_PROOF_GRAPH_LIMITS.maxBlockerReceipts),
    maxEvidenceIdsPerBlocker: read(
      "maxEvidenceIdsPerBlocker",
      DEFAULT_PROOF_GRAPH_LIMITS.maxEvidenceIdsPerBlocker,
    ),
    maxStringLength: read("maxStringLength", DEFAULT_PROOF_GRAPH_LIMITS.maxStringLength),
  };
}

function authorityIdentity(authority: AuthorityReference): unknown {
  return {
    scope: authority.scope,
    kind: authority.kind,
    id: authority.id,
    version: authority.version,
    fingerprint: authority.fingerprint,
    audience: authority.audience,
  };
}

function authorityVersionIdentity(authority: AuthorityReference): unknown {
  return {
    scope: authority.scope,
    kind: authority.kind,
    id: authority.id,
    version: authority.version,
    audience: authority.audience,
  };
}

function authorityLineageIdentity(authority: AuthorityReference): unknown {
  return {
    scope: authority.scope,
    kind: authority.kind,
    id: authority.id,
    audience: authority.audience,
  };
}

function authorityCoreWithoutAudience(authority: AuthorityReference): unknown {
  return {
    scope: authority.scope,
    kind: authority.kind,
    id: authority.id,
    version: authority.version,
    fingerprint: authority.fingerprint,
  };
}

function normalizeGraph(rawInput: ReadinessProofGraphInput): NormalizedGraph {
  const input = snapshotGraphInput(rawInput);
  assertRecord(input, "$", "INVALID_INPUT");
  assertKnownKeys(input, ["scope", "evidence", "requirements", "limits"], "$", "INVALID_INPUT");
  const limits = resolveLimits(input.limits);
  const scope = normalizeScope(input.scope, "$.scope", limits.maxStringLength);

  assertArray(input.evidence, "$.evidence", "INVALID_EVIDENCE");
  assertArray(input.requirements, "$.requirements", "INVALID_REQUIREMENT");
  if (input.requirements.length === 0) fail("EMPTY_GRAPH", "$.requirements");
  if (input.evidence.length > limits.maxEvidenceNodes) fail("SIZE_LIMIT_EXCEEDED", "$.evidence");
  if (input.requirements.length > limits.maxRequirementNodes) fail("SIZE_LIMIT_EXCEEDED", "$.requirements");
  if (input.evidence.length + input.requirements.length > limits.maxNodes) {
    fail("SIZE_LIMIT_EXCEEDED", "$.nodes");
  }

  const evidenceByAuthority = new Map<string, AuthorizedEvidence>();
  const evidenceByVersion = new Map<string, AuthorizedEvidence>();
  const currentByLineage = new Map<string, AuthorizedEvidence>();
  const nodeIds = new Set<string>();
  const evidence: AuthorizedEvidence[] = [];

  const registerNodeId = (id: string, path: string): void => {
    if (nodeIds.has(id)) fail("DUPLICATE_NODE", path);
    nodeIds.add(id);
    if (nodeIds.size > limits.maxNodes) fail("SIZE_LIMIT_EXCEEDED", "$.nodes");
  };

  for (let index = 0; index < input.evidence.length; index += 1) {
    const candidate = normalizeEvidence(input.evidence[index], `$.evidence[${index}]`, scope, limits);
    registerNodeId(candidate.id, `$.evidence[${index}].id`);

    const authorityKey = `${candidate.family}|${canonicalJson(authorityIdentity(candidate.authority))}`;
    if (evidenceByAuthority.has(authorityKey)) fail("DUPLICATE_NODE", `$.evidence[${index}].authority`);
    evidenceByAuthority.set(authorityKey, candidate);

    const versionKey = `${candidate.family}|${canonicalJson(authorityVersionIdentity(candidate.authority))}`;
    const priorVersion = evidenceByVersion.get(versionKey);
    if (priorVersion && priorVersion.authority.fingerprint !== candidate.authority.fingerprint) {
      fail("CONFLICTING_NODE", `$.evidence[${index}].authority.fingerprint`);
    }
    evidenceByVersion.set(versionKey, candidate);

    const lineageKey = `${candidate.family}|${canonicalJson(authorityLineageIdentity(candidate.authority))}`;
    if (candidate.authority.current) {
      const priorCurrent = currentByLineage.get(lineageKey);
      if (priorCurrent && priorCurrent.authority.version !== candidate.authority.version) {
        fail("CONFLICTING_NODE", `$.evidence[${index}].authority.version`);
      }
      currentByLineage.set(lineageKey, candidate);
    }
    evidence.push(candidate);
  }

  const requirementsById = new Map<string, ReadinessRequirement>();
  const requirements: ReadinessRequirement[] = [];
  let edgeCount = 0;
  for (let index = 0; index < input.requirements.length; index += 1) {
    const candidate = normalizeRequirement(
      input.requirements[index],
      `$.requirements[${index}]`,
      scope,
      limits,
    );
    registerNodeId(candidate.id, `$.requirements[${index}].id`);
    if (requirementsById.has(candidate.id)) fail("DUPLICATE_NODE", `$.requirements[${index}].id`);
    requirementsById.set(candidate.id, candidate);
    edgeCount += candidate.dependsOn.length + candidate.nextActions.length;
    if (edgeCount > limits.maxEdges) fail("SIZE_LIMIT_EXCEEDED", "$.requirements.dependsOn");
    for (const action of candidate.nextActions) {
      registerNodeId(action.id, "$.requirements.nextActions");
    }
    requirements.push(candidate);
  }

  for (const [index, requirement] of requirements.entries()) {
    for (const dependency of requirement.dependsOn) {
      if (!requirementsById.has(dependency)) {
        fail("UNKNOWN_DEPENDENCY", `$.requirements[${index}].dependsOn`);
      }
    }
  }

  topologicalOrder(requirements, requirementsById, limits.maxDepth);

  return {
    scope,
    evidence: evidence.sort((left, right) => compareStrings(left.id, right.id)),
    requirements: requirements.sort((left, right) => compareStrings(left.id, right.id)),
    limits,
  };
}

function topologicalOrder(
  requirements: readonly ReadinessRequirement[],
  requirementsById: ReadonlyMap<string, ReadinessRequirement>,
  maxDepth: number,
): readonly string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const requirement of requirements) {
    indegree.set(requirement.id, requirement.dependsOn.length);
    dependents.set(requirement.id, []);
  }
  for (const requirement of requirements) {
    for (const dependency of requirement.dependsOn) {
      if (!requirementsById.has(dependency)) fail("UNKNOWN_DEPENDENCY", "$.requirements.dependsOn");
      dependents.get(dependency)!.push(requirement.id);
    }
  }

  const queue = [...requirements].filter((requirement) => indegree.get(requirement.id) === 0).map((requirement) => requirement.id).sort(compareStrings);
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const dependent of dependents.get(current)!.sort(compareStrings)) {
      const nextIndegree = indegree.get(dependent)! - 1;
      indegree.set(dependent, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(dependent);
        queue.sort(compareStrings);
      }
    }
  }

  if (order.length !== requirements.length) fail("CYCLE_DETECTED", "$.requirements");

  const depth = new Map<string, number>();
  for (const id of order) {
    const requirement = requirementsById.get(id)!;
    const dependencyDepth = requirement.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, depth.get(dependency) ?? 0),
      0,
    );
    const currentDepth = dependencyDepth + 1;
    if (currentDepth > maxDepth) fail("DEPTH_LIMIT_EXCEEDED", `$.requirements[${id}]`);
    depth.set(id, currentDepth);
  }
  return order;
}

function makeBlocker(
  requirement: ReadinessRequirement,
  code: BlockerCode,
  sourceEvidenceIds: readonly string[],
  dependencyRequirementId: string | undefined,
  limits: ResolvedProofGraphLimits,
): BlockerReceipt {
  const sortedEvidenceIds = canonicalEvidenceIds(sourceEvidenceIds, limits, "$.output.blockers");
  const id = canonicalJson({
    code,
    dependencyRequirementId: dependencyRequirementId ?? null,
    kind: dependencyRequirementId === undefined ? "direct" : "dependency",
    requirementId: requirement.id,
    sourceEvidenceIds: sortedEvidenceIds,
  });
  return {
    id,
    code,
    requirementId: requirement.id,
    outcome: requirement.outcome,
    family: requirement.sourceFamily,
    authority: requirement.authority,
    message: BLOCKER_MESSAGES[code],
    sourceEvidenceIds: sortedEvidenceIds,
    ...(dependencyRequirementId === undefined ? {} : { dependencyRequirementId }),
  };
}

function canonicalEvidenceIds(
  sourceEvidenceIds: Iterable<string>,
  limits: ResolvedProofGraphLimits,
  path: string,
): readonly string[] {
  const uniqueEvidenceIds = new Set<string>();
  for (const evidenceId of sourceEvidenceIds) {
    uniqueEvidenceIds.add(evidenceId);
    if (uniqueEvidenceIds.size > limits.maxEvidenceIdsPerBlocker) {
      fail("SIZE_LIMIT_EXCEEDED", path);
    }
  }
  return sortStrings([...uniqueEvidenceIds]);
}

function createEvaluationBudget(limits: ResolvedProofGraphLimits): EvaluationBudget {
  return { limits, emittedBlockerEntries: 0 };
}

function chargeBlockerEntries(
  budget: EvaluationBudget,
  blockers: readonly BlockerReceipt[],
  path: string,
): void {
  budget.emittedBlockerEntries += blockers.length;
  if (budget.emittedBlockerEntries > budget.limits.maxBlockerReceipts) {
    fail("SIZE_LIMIT_EXCEEDED", path);
  }
}

function dedupeBlockers(
  blockerGroups: Iterable<readonly BlockerReceipt[]>,
  budget?: EvaluationBudget,
  path = "$.output.blockers",
): readonly BlockerReceipt[] {
  const byId = new Map<string, BlockerReceipt>();
  for (const blockers of blockerGroups) {
    for (const blocker of blockers) {
      if (!byId.has(blocker.id)) {
        byId.set(blocker.id, blocker);
        if (byId.size > (budget?.limits.maxBlockerReceipts ?? Number.MAX_SAFE_INTEGER)) {
          fail("SIZE_LIMIT_EXCEEDED", path);
        }
      }
    }
  }
  const result = [...byId.values()].sort((left, right) => compareStrings(left.id, right.id));
  if (budget !== undefined) chargeBlockerEntries(budget, result, path);
  return result;
}

function dependencyEvidenceIds(
  blockers: readonly BlockerReceipt[],
  limits: ResolvedProofGraphLimits,
): readonly string[] {
  const evidenceIds: string[] = [];
  const seen = new Set<string>();
  for (const blocker of blockers) {
    for (const evidenceId of blocker.sourceEvidenceIds) {
      if (seen.has(evidenceId)) continue;
      seen.add(evidenceId);
      evidenceIds.push(evidenceId);
      if (seen.size > limits.maxEvidenceIdsPerBlocker) {
        fail("SIZE_LIMIT_EXCEEDED", "$.output.blockers");
      }
    }
  }
  return sortStrings(evidenceIds);
}

function dedupeActions(actions: readonly ValidNextAction[]): readonly ValidNextAction[] {
  const byId = new Map<string, ValidNextAction>();
  for (const action of actions) byId.set(action.id, action);
  return [...byId.values()].sort((left, right) => compareStrings(canonicalJson(left), canonicalJson(right)));
}

function combineStatuses(statuses: readonly ProofStatus[]): ProofStatus {
  if (statuses.some((status) => status === "BLOCKED")) return "BLOCKED";
  if (statuses.some((status) => status === "UNAVAILABLE")) return "UNAVAILABLE";
  return "READY";
}

function evaluateLocalRequirement(
  requirement: ReadinessRequirement,
  evidenceByFamily: ReadonlyMap<SourceFamily, readonly AuthorizedEvidence[]>,
  limits: ResolvedProofGraphLimits,
): LocalEvaluation {
  const familyEvidence = evidenceByFamily.get(requirement.sourceFamily) ?? [];
  if (familyEvidence.length === 0) {
    return {
      status: "UNAVAILABLE",
      blockers: [makeBlocker(requirement, "SOURCE_FAMILY_UNAVAILABLE", [], undefined, limits)],
      matchedEvidenceIds: [],
    };
  }

  const expectedAuthority = requirement.authority;
  const exact = familyEvidence.filter(
    (candidate) =>
      canonicalJson(authorityIdentity(candidate.authority)) === canonicalJson(authorityIdentity(expectedAuthority)),
  );
  if (exact.length > 0) {
    const candidate = exact[0];
    const matchedEvidenceIds = exact.map((item) => item.id).sort(compareStrings);
    if (candidate.authority.superseded) {
      return {
        status: "BLOCKED",
        blockers: [makeBlocker(requirement, "SUPERSEDED_AUTHORITY", matchedEvidenceIds, undefined, limits)],
        matchedEvidenceIds,
      };
    }
    if (!candidate.authority.current) {
      return {
        status: "BLOCKED",
        blockers: [makeBlocker(requirement, "STALE_AUTHORITY", matchedEvidenceIds, undefined, limits)],
        matchedEvidenceIds,
      };
    }
    if (candidate.state === "UNKNOWN") {
      return {
        status: "UNAVAILABLE",
        blockers: [makeBlocker(requirement, "UNKNOWN_EVIDENCE", matchedEvidenceIds, undefined, limits)],
        matchedEvidenceIds,
      };
    }
    if (candidate.state === "UNAVAILABLE") {
      return {
        status: "UNAVAILABLE",
        blockers: [makeBlocker(requirement, "EVIDENCE_UNAVAILABLE", matchedEvidenceIds, undefined, limits)],
        matchedEvidenceIds,
      };
    }
    if (candidate.state === "BLOCKED") {
      return {
        status: "BLOCKED",
        blockers: [makeBlocker(requirement, "EVIDENCE_BLOCKED", matchedEvidenceIds, undefined, limits)],
        matchedEvidenceIds,
      };
    }
    if (candidate.state === "CONFLICTING") {
      return {
        status: "BLOCKED",
        blockers: [makeBlocker(requirement, "EVIDENCE_CONFLICTING", matchedEvidenceIds, undefined, limits)],
        matchedEvidenceIds,
      };
    }
    return { status: "READY", blockers: [], matchedEvidenceIds };
  }

  const audienceNearMisses = familyEvidence.filter(
    (candidate) =>
      canonicalJson(authorityCoreWithoutAudience(candidate.authority)) ===
      canonicalJson(authorityCoreWithoutAudience(expectedAuthority)),
  );
  const fingerprintNearMisses = familyEvidence.filter(
    (candidate) =>
      canonicalJson(authorityVersionIdentity(candidate.authority)) ===
        canonicalJson(authorityVersionIdentity(expectedAuthority)) &&
      candidate.authority.fingerprint !== expectedAuthority.fingerprint,
  );
  const versionNearMisses = familyEvidence.filter(
    (candidate) =>
      canonicalJson(authorityLineageIdentity(candidate.authority)) ===
        canonicalJson(authorityLineageIdentity(expectedAuthority)) &&
      candidate.authority.version !== expectedAuthority.version,
  );
  const mismatchBlockers: BlockerReceipt[] = [];
  if (audienceNearMisses.length > 0) {
    mismatchBlockers.push(
      makeBlocker(
        requirement,
        "AUDIENCE_MISMATCH",
        audienceNearMisses.map((candidate) => candidate.id),
        undefined,
        limits,
      ),
    );
  }
  if (fingerprintNearMisses.length > 0) {
    mismatchBlockers.push(
      makeBlocker(
        requirement,
        "EXACT_FINGERPRINT_MISMATCH",
        fingerprintNearMisses.map((candidate) => candidate.id),
        undefined,
        limits,
      ),
    );
  }
  if (versionNearMisses.length > 0) {
    mismatchBlockers.push(
      makeBlocker(
        requirement,
        "EXACT_VERSION_MISMATCH",
        versionNearMisses.map((candidate) => candidate.id),
        undefined,
        limits,
      ),
    );
  }
  if (mismatchBlockers.length > 0) {
    return {
      status: "BLOCKED",
      blockers: mismatchBlockers,
      matchedEvidenceIds: [],
    };
  }

  return {
    status: "UNAVAILABLE",
    blockers: [
      makeBlocker(
        requirement,
        "MISSING_EXACT_EVIDENCE",
        familyEvidence.map((candidate) => candidate.id),
        undefined,
        limits,
      ),
    ],
    matchedEvidenceIds: [],
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function evaluateNormalizedGraph(graph: NormalizedGraph): ReadinessProofGraphResult {
  const budget = createEvaluationBudget(graph.limits);
  const evidenceByFamily = new Map<SourceFamily, AuthorizedEvidence[]>();
  for (const evidence of graph.evidence) {
    const familyEvidence = evidenceByFamily.get(evidence.family) ?? [];
    familyEvidence.push(evidence);
    evidenceByFamily.set(evidence.family, familyEvidence);
  }

  const requirementsById = new Map(graph.requirements.map((requirement) => [requirement.id, requirement]));
  const order = topologicalOrder(graph.requirements, requirementsById, graph.limits.maxDepth);
  const evaluationsById = new Map<string, InternalRequirementEvaluation>();

  for (const requirementId of order) {
    const requirement = requirementsById.get(requirementId)!;
    const local = evaluateLocalRequirement(requirement, evidenceByFamily, graph.limits);
    const dependencies = requirement.dependsOn.map((dependencyId) => evaluationsById.get(dependencyId)!);
    const dependencyStatuses = dependencies.map((dependency) => dependency.status);
    const status = combineStatuses([local.status, ...dependencyStatuses]);

    const dependencySummaries: BlockerReceipt[] = [];
    const inheritedBlockers: Array<readonly BlockerReceipt[]> = [];
    const inheritedMinimalBlockers: Array<readonly BlockerReceipt[]> = [];
    for (const dependency of dependencies) {
      if (dependency.status === "READY") continue;
      dependencySummaries.push(
        makeBlocker(
          requirement,
          dependency.status === "BLOCKED" ? "DEPENDENCY_BLOCKED" : "DEPENDENCY_UNAVAILABLE",
          dependencyEvidenceIds(dependency.blockers, graph.limits),
          dependency.requirementId,
          graph.limits,
        ),
      );
      inheritedBlockers.push(dependency.blockers);
      inheritedMinimalBlockers.push(dependency.minimalBlockers);
    }
    const blockers = dedupeBlockers(
      [local.blockers, dependencySummaries, ...inheritedBlockers],
      budget,
      "$.output.requirements.blockers",
    );
    const minimalBlockerGroups: Array<readonly BlockerReceipt[]> = [
      local.blockers,
      ...inheritedMinimalBlockers,
      ...((dependencies.length > 0 && dependencySummaries.length > 0 && blockers.length === 0)
        ? [dependencySummaries]
        : []),
    ];
    const minimalBlockers = dedupeBlockers(
      minimalBlockerGroups,
      budget,
      "$.output.requirements.minimalBlockers",
    );

    evaluationsById.set(requirementId, {
      requirementId,
      outcome: requirement.outcome,
      status,
      dependsOn: requirement.dependsOn,
      blockers,
      minimalBlockers,
      nextActions: status === "READY" ? [] : requirement.nextActions,
      matchedEvidenceIds: local.matchedEvidenceIds,
    });
  }

  const requirements = [...evaluationsById.values()].sort((left, right) =>
    compareStrings(left.requirementId, right.requirementId),
  );
  const outcomes: OutcomeEvaluation[] = [];
  for (const outcome of READINESS_OUTCOMES) {
    const outcomeRequirements = requirements.filter((requirement) => requirement.outcome === outcome);
    if (outcomeRequirements.length === 0) continue;
    outcomes.push({
      outcome,
      status: combineStatuses(outcomeRequirements.map((requirement) => requirement.status)),
      requirementIds: outcomeRequirements.map((requirement) => requirement.requirementId),
      blockers: dedupeBlockers(
        outcomeRequirements.map((requirement) => requirement.blockers),
        budget,
        "$.output.outcomes.blockers",
      ),
      minimalBlockers: dedupeBlockers(
        outcomeRequirements.map((requirement) => requirement.minimalBlockers),
        budget,
        "$.output.outcomes.minimalBlockers",
      ),
      nextActions: dedupeActions(outcomeRequirements.flatMap((requirement) => requirement.nextActions)),
    });
  }

  const blockers = dedupeBlockers(
    requirements.map((requirement) => requirement.blockers),
    budget,
    "$.output.blockers",
  );
  const minimalBlockers = dedupeBlockers(
    requirements.map((requirement) => requirement.minimalBlockers),
    budget,
    "$.output.minimalBlockers",
  );
  const result: ReadinessProofGraphResult = {
    schema: READINESS_PROOF_GRAPH_SCHEMA,
    scope: graph.scope,
    fingerprint: fingerprint({
      schema: READINESS_PROOF_GRAPH_SCHEMA,
      scope: graph.scope,
      evidence: graph.evidence,
      requirements: graph.requirements,
    }),
    status: combineStatuses(requirements.map((requirement) => requirement.status)),
    evidence: graph.evidence,
    requirements,
    outcomes,
    blockers,
    minimalBlockers,
    nextActions: dedupeActions(requirements.flatMap((requirement) => requirement.nextActions)),
    limits: graph.limits,
  };
  return deepFreeze(result);
}

export function validateReadinessProofGraph(
  input: ReadinessProofGraphInput,
): ReadinessProofGraphInput & { readonly limits: ResolvedProofGraphLimits } {
  const graph = normalizeGraph(input);
  return deepFreeze(graph) as ReadinessProofGraphInput & { readonly limits: ResolvedProofGraphLimits };
}

export function readinessProofGraphFingerprint(input: ReadinessProofGraphInput): string {
  const graph = normalizeGraph(input);
  return fingerprint({
    schema: READINESS_PROOF_GRAPH_SCHEMA,
    scope: graph.scope,
    evidence: graph.evidence,
    requirements: graph.requirements,
  });
}

export function evaluateReadinessProofGraph(
  input: ReadinessProofGraphInput,
): ReadinessProofGraphResult {
  return evaluateNormalizedGraph(normalizeGraph(input));
}

export const evaluateProofGraph = evaluateReadinessProofGraph;
export const evaluateReadinessGraph = evaluateReadinessProofGraph;

export { BLOCKER_CODES };
