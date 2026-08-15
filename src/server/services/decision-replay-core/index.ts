import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export const DECISION_REPLAY_SCHEMA = "decision-replay-manifest/v1" as const;
export const DECISION_REPLAY_RESULT_SCHEMA = "decision-replay-result/v1" as const;
export const DECISION_REPLAY_EXECUTION_EVIDENCE_SCHEMA = "decision-replay-execution-evidence/v1" as const;
export const DECISION_REPLAY_LABEL = "SIMULATION_ONLY" as const;
export const REPLAY_FINGERPRINT_ALGORITHM = "sha256-canonical-json-v1" as const;

export const REPLAY_MODES = ["REPRODUCE", "COUNTERFACTUAL"] as const;
export type ReplayMode = (typeof REPLAY_MODES)[number];

export const REPLAY_STATUSES = [
  "MATCH",
  "NON_REPRODUCIBLE",
  "ENGINE_UNAVAILABLE",
  "INFEASIBLE",
] as const;
export type DecisionReplayStatus = (typeof REPLAY_STATUSES)[number];

export const REPLAY_PATCH_TYPES = [
  "CAPACITY_LIMIT",
  "CONSTRAINT_TOGGLE",
  "OBJECTIVE_WEIGHT",
] as const;
export type ReplayPatchType = (typeof REPLAY_PATCH_TYPES)[number];

export const SAFE_REPLAY_CONSTRAINT_TOGGLE_KEYS = [
  "SOFT_ORGANIZATION_DIVERSITY",
  "SOFT_RELATIONSHIP_NOVELTY",
  "SOFT_REPEAT_PAIRING_AVOIDANCE",
  "ADVISORY_PREFERENCE_BALANCE",
] as const;
export type SafeReplayConstraintToggleKey = (typeof SAFE_REPLAY_CONSTRAINT_TOGGLE_KEYS)[number];

export const SAFE_REPLAY_OBJECTIVE_KEYS = [
  "ASSERTION_CONFIDENCE",
  "FIELD_SCORE",
  "ORGANIZATION_DIVERSITY",
  "RECENCY",
  "RELATIONSHIP_NOVELTY",
  "REPEAT_PAIRING_AVOIDANCE",
  "SEMANTIC_FIT",
] as const;
export type SafeReplayObjectiveKey = (typeof SAFE_REPLAY_OBJECTIVE_KEYS)[number];

export type ReplayJsonPrimitive = string | number | boolean | null;
export type ReplayJsonValue =
  | ReplayJsonPrimitive
  | readonly ReplayJsonValue[]
  | { readonly [key: string]: ReplayJsonValue };

export type ReplayFingerprint = string;

export interface ReplayEngineReference {
  readonly id: string;
  readonly version: string;
  readonly fingerprint: ReplayFingerprint;
}

export interface ReplayArtifactEnvelope {
  readonly fingerprint: ReplayFingerprint;
  readonly artifact?: ReplayJsonValue;
}

export interface ReplayInputEnvelope extends ReplayArtifactEnvelope {
  readonly artifact: ReplayJsonValue;
}

export interface CapacityLimitPatch {
  readonly type: "CAPACITY_LIMIT";
  readonly targetId: string;
  readonly limit: number;
}

export interface ConstraintTogglePatch {
  readonly type: "CONSTRAINT_TOGGLE";
  readonly constraintKey: SafeReplayConstraintToggleKey;
  readonly enabled: boolean;
}

export interface ObjectiveWeightPatch {
  readonly type: "OBJECTIVE_WEIGHT";
  readonly objectiveKey: SafeReplayObjectiveKey;
  readonly weight: number;
}

export type ReplayScenarioPatch =
  | CapacityLimitPatch
  | ConstraintTogglePatch
  | ObjectiveWeightPatch;

export interface ReplayLimits {
  readonly maxPatches: number;
  readonly maxArtifactBytes: number;
  readonly maxDiffEntries: number;
}

export interface DecisionReplayManifest {
  readonly schema: typeof DECISION_REPLAY_SCHEMA;
  readonly label: typeof DECISION_REPLAY_LABEL;
  readonly mode: ReplayMode;
  readonly engine: ReplayEngineReference;
  readonly input: ReplayInputEnvelope;
  readonly expectedOutput: ReplayArtifactEnvelope;
  readonly patches: readonly ReplayScenarioPatch[];
  readonly limits: ReplayLimits;
}

export interface DecisionReplayManifestInput {
  readonly schema?: typeof DECISION_REPLAY_SCHEMA;
  readonly label?: typeof DECISION_REPLAY_LABEL;
  readonly mode: ReplayMode;
  readonly engine: ReplayEngineReference;
  readonly input: ReplayInputEnvelope;
  readonly expectedOutput: ReplayArtifactEnvelope;
  readonly patches?: readonly ReplayScenarioPatch[];
  readonly limits?: Partial<ReplayLimits>;
}

export type DecisionReplayExecutionStatus = "FEASIBLE" | "INFEASIBLE";

export interface DecisionReplayExecutionEvidence {
  readonly schema: typeof DECISION_REPLAY_EXECUTION_EVIDENCE_SCHEMA;
  readonly label: typeof DECISION_REPLAY_LABEL;
  readonly engine: ReplayEngineReference;
  readonly mode: ReplayMode;
  readonly inputFingerprint: ReplayFingerprint;
  readonly effectiveInputFingerprint: ReplayFingerprint;
  readonly status: DecisionReplayExecutionStatus;
  readonly output?: ReplayJsonValue;
  readonly outputFingerprint?: ReplayFingerprint;
  readonly evidenceFingerprint: ReplayFingerprint;
}

export interface DecisionReplayExecutionEvidenceInput {
  readonly schema?: typeof DECISION_REPLAY_EXECUTION_EVIDENCE_SCHEMA;
  readonly label?: typeof DECISION_REPLAY_LABEL;
  readonly engine: ReplayEngineReference;
  readonly mode: ReplayMode;
  readonly inputFingerprint: ReplayFingerprint;
  readonly effectiveInputFingerprint: ReplayFingerprint;
  readonly status: DecisionReplayExecutionStatus;
  readonly output?: ReplayJsonValue;
  readonly outputFingerprint?: ReplayFingerprint;
}

export interface ReplayDiffChange {
  readonly path: string;
  readonly kind: "ADDED" | "REMOVED" | "CHANGED";
  readonly expected?: ReplayJsonValue;
  readonly actual?: ReplayJsonValue;
}

export interface ReplayDiffGroup {
  readonly sourceFamily: string;
  readonly changes: readonly ReplayDiffChange[];
}

export interface DecisionReplayResult {
  readonly schema: typeof DECISION_REPLAY_RESULT_SCHEMA;
  readonly label: typeof DECISION_REPLAY_LABEL;
  readonly mode: ReplayMode;
  readonly status: DecisionReplayStatus;
  readonly engine: ReplayEngineReference;
  readonly inputFingerprint: ReplayFingerprint;
  readonly effectiveInputFingerprint: ReplayFingerprint;
  readonly expectedOutputFingerprint: ReplayFingerprint;
  readonly actualOutputFingerprint: ReplayFingerprint | null;
  readonly output?: ReplayJsonValue;
  readonly diff: readonly ReplayDiffGroup[];
  readonly blockers: readonly string[];
}

export type ReplayManifest = DecisionReplayManifest;
export type ReplayResult = DecisionReplayResult;
export type ReplayEngine = DecisionReplayExecutionEvidence;
export type ScenarioPatch = ReplayScenarioPatch;

export const DEFAULT_REPLAY_LIMITS: ReplayLimits = Object.freeze({
  maxPatches: 32,
  maxArtifactBytes: 256 * 1024,
  maxDiffEntries: 1_024,
});

const MAX_REPLAY_LIMITS: ReplayLimits = Object.freeze({
  maxPatches: 32,
  maxArtifactBytes: 256 * 1024,
  maxDiffEntries: 1_024,
});

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SOURCE_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const MAX_REPLAY_SNAPSHOT_NODES = 262_144;
const FORBIDDEN_PATCH_TOKEN = /identity|permission|evaluation|advocacy|latest|fallback|action|apply|promot|reserve|invite|contact|authority|unbounded|execute|eligib|purpose|conflict|overlap|tenan|workspace|retention|publication|hard/iu;
const FORBIDDEN_ACTION_KEY = /action|apply|promot|reserve|reservation|invite|contact|send|persist|commit|publish|revoke|authority/iu;
const FORBIDDEN_ACTION_VALUE = /(?:^|[^A-Za-z])(?:action|actions|apply|applied|applying|promote|promoted|promoting|promotion|promotions)(?:$|[^A-Za-z])/iu;

export class DecisionReplayValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DecisionReplayValidationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new DecisionReplayValidationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (isProxy(value) || !isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonPrimitive(value: unknown): value is ReplayJsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

interface ReplaySnapshotState {
  readonly seen: Set<object>;
  nodes: number;
}

function snapshotJsonValue(
  value: unknown,
  path: string,
  depth = 0,
  state: ReplaySnapshotState = { seen: new Set<object>(), nodes: 0 },
): ReplayJsonValue {
  if (depth > 16) {
    fail("REPLAY_INPUT_DEPTH_EXCEEDED", `${path} exceeds the replay input depth bound.`);
  }
  if (isProxy(value)) {
    fail("REPLAY_INPUT_PROXY_FORBIDDEN", `${path} must not contain Proxy values.`);
  }
  if (isJsonPrimitive(value)) return value;
  if (typeof value !== "object" || value === null) {
    fail("REPLAY_INPUT_NOT_JSON", `${path} must contain JSON values only.`);
  }
  if (state.seen.has(value)) {
    fail("REPLAY_INPUT_CYCLE", `${path} contains a cyclic value.`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_REPLAY_SNAPSHOT_NODES) {
    fail("REPLAY_INPUT_NODE_LIMIT_EXCEEDED", `${path} exceeds the replay snapshot node bound.`);
  }
  state.seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      fail("REPLAY_INPUT_NOT_JSON", `${path} must contain plain JSON arrays only.`);
    }
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_REPLAY_SNAPSHOT_NODES) {
      fail("REPLAY_INPUT_NOT_JSON", `${path} must contain a bounded plain JSON array.`);
    }
    const length = lengthDescriptor.value as number;
    const snapshot: ReplayJsonValue[] = new Array(length);
    for (const key of descriptorKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !ARRAY_INDEX_PATTERN.test(key) || Number(key) >= length) {
        fail("REPLAY_INPUT_NOT_JSON", `${path} must contain plain JSON arrays only.`);
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("REPLAY_INPUT_NOT_JSON", `${path} must not contain accessor properties.`);
      }
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("REPLAY_INPUT_NOT_JSON", `${path} must not contain sparse arrays or accessor properties.`);
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
  } else {
    if (prototype !== Object.prototype && prototype !== null) {
      fail("REPLAY_INPUT_NOT_JSON", `${path} must contain plain JSON objects only.`);
    }
    if (descriptorKeys.length > MAX_REPLAY_SNAPSHOT_NODES) {
      fail("REPLAY_INPUT_NODE_LIMIT_EXCEEDED", `${path} exceeds the replay snapshot key bound.`);
    }
    const snapshot = Object.create(null) as Record<string, ReplayJsonValue>;
    for (const key of descriptorKeys) {
      if (typeof key !== "string") {
        fail("REPLAY_INPUT_KEY_INVALID", `${path} contains a non-JSON object key.`);
      }
      if (key.length > 128 || /[\u0000-\u001f\u007f]/u.test(key)) {
        fail("REPLAY_INPUT_KEY_INVALID", `${path} contains an invalid object key.`);
      }
      if (key === "toJSON") {
        fail("REPLAY_INPUT_TO_JSON_FORBIDDEN", `${path}.toJSON is forbidden in replay data.`);
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("REPLAY_INPUT_NOT_JSON", `${path} must not contain accessor properties.`);
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
}

function assertJsonValue(value: unknown, path: string): asserts value is ReplayJsonValue {
  snapshotJsonValue(value, path);
}

function cloneJson<T extends ReplayJsonValue>(value: T): T {
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

function canonicalize(value: ReplayJsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("REPLAY_NUMBER_INVALID", "Replay fingerprints require finite JSON numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalize(child)).join(",")}]`;
  }
  const objectValue = value as { readonly [key: string]: ReplayJsonValue };
  const keys = Object.keys(objectValue).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(objectValue[key]!)}`).join(",")}}`;
}

export function replayCanonicalJson(value: ReplayJsonValue): string {
  return canonicalize(snapshotJsonValue(value, "$canonical"));
}

export function replayFingerprintOf(value: ReplayJsonValue): ReplayFingerprint {
  return createHash("sha256").update(replayCanonicalJson(value), "utf8").digest("hex");
}

export const decisionReplayFingerprintOf = replayFingerprintOf;

function byteLength(value: ReplayJsonValue): number {
  return Buffer.byteLength(replayCanonicalJson(value), "utf8");
}

function requireHash(value: unknown, path: string): ReplayFingerprint {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail("REPLAY_FINGERPRINT_INVALID", `${path} must be a lowercase SHA-256 fingerprint.`);
  }
  return value;
}

function requireToken(value: unknown, path: string): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value) || FORBIDDEN_PATCH_TOKEN.test(value)) {
    fail("REPLAY_TOKEN_INVALID", `${path} is not an allowed replay identifier.`);
  }
  return value;
}

function ownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail("REPLAY_FIELD_FORBIDDEN", `${path}.${key} is not part of the replay contract.`);
    }
  }
}

function assertNoForbiddenActionKeys(value: ReplayJsonValue, path: string, depth = 0): void {
  if (depth > 16) fail("REPLAY_OUTPUT_DEPTH_EXCEEDED", `${path} exceeds the output depth bound.`);
  if (typeof value === "string" && FORBIDDEN_ACTION_VALUE.test(value)) {
    fail("REPLAY_ACTION_FIELD_FORBIDDEN", `${path} would add a state-changing action.`);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoForbiddenActionKeys(value[index]!, `${path}[${index}]`, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ACTION_KEY.test(key) || (typeof child === "string" && FORBIDDEN_ACTION_VALUE.test(child))) {
      fail("REPLAY_ACTION_FIELD_FORBIDDEN", `${path}.${key} would add a state-changing action.`);
    }
    assertNoForbiddenActionKeys(child as ReplayJsonValue, `${path}.${key}`, depth + 1);
  }
}

function assertNoForbiddenManifestActions(value: unknown, path: string, depth = 0, seen = new Set<object>()): void {
  if (depth > 16) fail("REPLAY_MANIFEST_DEPTH_EXCEEDED", `${path} exceeds the manifest depth bound.`);
  if (value === null || typeof value === "undefined" || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (FORBIDDEN_ACTION_VALUE.test(value)) {
      fail("REPLAY_ACTION_FIELD_FORBIDDEN", `${path} would add a state-changing action.`);
    }
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) fail("REPLAY_INPUT_CYCLE", `${path} contains a cyclic value.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoForbiddenManifestActions(value[index], `${path}[${index}]`, depth + 1, seen);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_ACTION_KEY.test(key)) {
        fail("REPLAY_ACTION_FIELD_FORBIDDEN", `${path}.${key} would add a state-changing action.`);
      }
      assertNoForbiddenManifestActions(child, `${path}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function assertNoForbiddenPatchSemantics(value: unknown, path: string, depth = 0, seen = new Set<object>()): void {
  if (depth > 16) fail("REPLAY_PATCH_DEPTH_EXCEEDED", `${path} exceeds the patch depth bound.`);
  if (value === null || typeof value === "undefined" || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (FORBIDDEN_PATCH_TOKEN.test(value)) {
      fail("REPLAY_PATCH_INJECTION_FORBIDDEN", `${path} contains an eligibility, purpose, or state-changing value.`);
    }
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) fail("REPLAY_PATCH_CYCLE", `${path} contains a cyclic value.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoForbiddenPatchSemantics(value[index], `${path}[${index}]`, depth + 1, seen);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PATCH_TOKEN.test(key)) {
        fail("REPLAY_PATCH_INJECTION_FORBIDDEN", `${path}.${key} contains an eligibility, purpose, or state-changing field.`);
      }
      assertNoForbiddenPatchSemantics(child, `${path}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function normalizeLimits(value: unknown): ReplayLimits {
  if (value === undefined) return DEFAULT_REPLAY_LIMITS;
  if (!isRecord(value)) fail("REPLAY_LIMITS_INVALID", "Replay limits must be an object.");
  ownKeys(value, ["maxPatches", "maxArtifactBytes", "maxDiffEntries"], "limits");
  const limit = (key: keyof ReplayLimits): number => {
    const candidate = value[key] === undefined ? DEFAULT_REPLAY_LIMITS[key] : value[key];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0 || candidate > MAX_REPLAY_LIMITS[key]) {
      fail("REPLAY_LIMIT_EXCEEDED", `limits.${key} exceeds the fixed replay work bound.`);
    }
    return candidate;
  };
  const result = {
    maxPatches: limit("maxPatches"),
    maxArtifactBytes: limit("maxArtifactBytes"),
    maxDiffEntries: limit("maxDiffEntries"),
  };
  return Object.freeze(result);
}

function normalizePatch(value: unknown, index: number): ReplayScenarioPatch {
  if (!isRecord(value)) fail("REPLAY_PATCH_INVALID", `patches[${index}] must be a typed object.`);
  const patchType = value.type;
  if (typeof patchType !== "string" || !REPLAY_PATCH_TYPES.includes(patchType as ReplayPatchType)) {
    fail("REPLAY_PATCH_FAMILY_FORBIDDEN", `patches[${index}] is not an allowed scenario patch family.`);
  }
  assertNoForbiddenPatchSemantics(value, `patches[${index}]`);
  if (patchType === "CAPACITY_LIMIT") {
    ownKeys(value, ["type", "targetId", "limit"], `patches[${index}]`);
    const targetId = requireToken(value.targetId, `patches[${index}].targetId`);
    if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 0 || (value.limit as number) > 1_000_000) {
      fail("REPLAY_PATCH_VALUE_INVALID", `patches[${index}].limit is outside the bounded capacity range.`);
    }
    return Object.freeze({ type: "CAPACITY_LIMIT", targetId, limit: value.limit as number });
  }
  if (patchType === "CONSTRAINT_TOGGLE") {
    ownKeys(value, ["type", "constraintKey", "enabled"], `patches[${index}]`);
    const constraintKey = requireToken(value.constraintKey, `patches[${index}].constraintKey`);
    if (!SAFE_REPLAY_CONSTRAINT_TOGGLE_KEYS.includes(constraintKey as SafeReplayConstraintToggleKey)) {
      fail("REPLAY_CONSTRAINT_TOGGLE_FORBIDDEN", `patches[${index}].constraintKey is not an allowlisted soft or advisory constraint.`);
    }
    if (typeof value.enabled !== "boolean") {
      fail("REPLAY_PATCH_VALUE_INVALID", `patches[${index}].enabled must be boolean.`);
    }
    return Object.freeze({
      type: "CONSTRAINT_TOGGLE",
      constraintKey: constraintKey as SafeReplayConstraintToggleKey,
      enabled: value.enabled,
    });
  }
  ownKeys(value, ["type", "objectiveKey", "weight"], `patches[${index}]`);
  const objectiveKey = requireToken(value.objectiveKey, `patches[${index}].objectiveKey`);
  if (!SAFE_REPLAY_OBJECTIVE_KEYS.includes(objectiveKey as SafeReplayObjectiveKey)) {
    fail("REPLAY_OBJECTIVE_FORBIDDEN", `patches[${index}].objectiveKey is not an allowlisted objective.`);
  }
  if (typeof value.weight !== "number" || !Number.isFinite(value.weight) || Math.abs(value.weight) > 1_000_000) {
    fail("REPLAY_PATCH_VALUE_INVALID", `patches[${index}].weight is outside the bounded objective range.`);
  }
  return Object.freeze({
    type: "OBJECTIVE_WEIGHT",
    objectiveKey: objectiveKey as SafeReplayObjectiveKey,
    weight: value.weight,
  });
}

function normalizeEngine(value: unknown, source: Record<string, unknown>): ReplayEngineReference {
  const raw = isRecord(value) ? value : {
    id: source.engineId,
    version: source.engineVersion,
    fingerprint: source.engineFingerprint,
  };
  if (!isRecord(raw)) fail("REPLAY_ENGINE_INVALID", "The replay engine reference is missing.");
  ownKeys(raw, ["id", "version", "fingerprint"], "engine");
  const id = requireToken(raw.id, "engine.id");
  const version = requireToken(raw.version, "engine.version");
  const fingerprint = requireHash(raw.fingerprint, "engine.fingerprint");
  return Object.freeze({ id, version, fingerprint });
}

function normalizeArtifactEnvelope(
  value: unknown,
  source: Record<string, unknown>,
  fingerprintKeys: readonly string[],
  artifactKeys: readonly string[],
  path: string,
  requiredArtifact: boolean,
): ReplayArtifactEnvelope {
  const raw = value;
  let fingerprint: unknown;
  let artifact: unknown;
  if (isRecord(raw) && raw.fingerprint !== undefined) {
    fingerprint = raw.fingerprint;
    artifact = raw.artifact;
    ownKeys(raw, ["fingerprint", "artifact"], path);
  } else {
    for (const key of fingerprintKeys) {
      if (source[key] !== undefined) {
        fingerprint = source[key];
        break;
      }
    }
    artifact = raw;
    for (const key of artifactKeys) {
      if (source[key] !== undefined) {
        artifact = source[key];
        break;
      }
    }
  }
  const normalizedFingerprint = requireHash(fingerprint, `${path}.fingerprint`);
  if (artifact === undefined) {
    if (requiredArtifact) fail("REPLAY_ARTIFACT_MISSING", `${path}.artifact is required.`);
    return Object.freeze({ fingerprint: normalizedFingerprint });
  }
  assertJsonValue(artifact, `${path}.artifact`);
  if (byteLength(artifact) > MAX_REPLAY_LIMITS.maxArtifactBytes) {
    fail("REPLAY_ARTIFACT_TOO_LARGE", `${path}.artifact exceeds the fixed replay artifact bound.`);
  }
  assertNoForbiddenActionKeys(artifact, `${path}.artifact`);
  return Object.freeze({ fingerprint: normalizedFingerprint, artifact: freezeDeep(cloneJson(artifact)) });
}

function normalizeManifest(value: unknown): DecisionReplayManifest {
  const snapshot = snapshotJsonValue(value, "$manifest");
  if (!isRecord(snapshot)) fail("REPLAY_MANIFEST_INVALID", "A replay manifest must be an object.");
  assertNoForbiddenManifestActions(snapshot, "$manifest");
  ownKeys(snapshot, [
    "schema", "label", "mode", "engine", "engineId", "engineVersion", "engineFingerprint",
    "input", "inputArtifact", "inputFingerprint", "expectedOutput", "output", "expectedOutputArtifact",
    "outputFingerprint", "patches", "scenarioPatches", "limits",
  ], "manifest");
  if (snapshot.schema !== undefined && snapshot.schema !== DECISION_REPLAY_SCHEMA) {
    fail("REPLAY_SCHEMA_UNSUPPORTED", "The replay manifest schema is unsupported.");
  }
  if (snapshot.label !== DECISION_REPLAY_LABEL) {
    fail("REPLAY_LABEL_REQUIRED", "Replay artifacts must be labelled SIMULATION_ONLY.");
  }
  if (!REPLAY_MODES.includes(snapshot.mode as ReplayMode)) {
    fail("REPLAY_MODE_INVALID", "Replay mode must be REPRODUCE or COUNTERFACTUAL.");
  }
  const mode = snapshot.mode as ReplayMode;
  const engine = normalizeEngine(snapshot.engine, snapshot);
  const input = normalizeArtifactEnvelope(
    snapshot.input ?? snapshot.inputArtifact,
    snapshot,
    ["inputFingerprint"],
    ["inputArtifact"],
    "input",
    true,
  ) as ReplayInputEnvelope;
  const expectedOutput = normalizeArtifactEnvelope(
    snapshot.expectedOutput ?? snapshot.output ?? snapshot.expectedOutputArtifact,
    snapshot,
    ["outputFingerprint"],
    ["expectedOutputArtifact"],
    "expectedOutput",
    false,
  );
  const rawPatches = snapshot.patches ?? snapshot.scenarioPatches ?? [];
  if (!Array.isArray(rawPatches)) fail("REPLAY_PATCHES_INVALID", "Replay patches must be an array.");
  const limits = normalizeLimits(snapshot.limits);
  if (byteLength(input.artifact) > limits.maxArtifactBytes ||
      (expectedOutput.artifact !== undefined && byteLength(expectedOutput.artifact) > limits.maxArtifactBytes)) {
    fail("REPLAY_ARTIFACT_TOO_LARGE", "A replay artifact exceeds the manifest work bound.");
  }
  if (rawPatches.length > limits.maxPatches) {
    fail("REPLAY_PATCH_COUNT_EXCEEDED", "The replay patch count exceeds its fixed bound.");
  }
  const patches = rawPatches.map((patch, index) => normalizePatch(patch, index));
  const seenPatchKeys = new Set<string>();
  for (const patch of patches) {
    const key = patch.type === "CAPACITY_LIMIT"
      ? `${patch.type}:${patch.targetId}`
      : patch.type === "CONSTRAINT_TOGGLE"
        ? `${patch.type}:${patch.constraintKey}`
        : `${patch.type}:${patch.objectiveKey}`;
    if (seenPatchKeys.has(key)) fail("REPLAY_PATCH_DUPLICATE", "A scenario target may be patched only once.");
    seenPatchKeys.add(key);
  }
  if (mode === "REPRODUCE" && patches.length > 0) {
    fail("REPLAY_REPRODUCE_PATCHED", "REPRODUCE manifests cannot contain scenario patches.");
  }
  if (mode === "COUNTERFACTUAL" && patches.length === 0) {
    fail("REPLAY_COUNTERFACTUAL_PATCH_REQUIRED", "COUNTERFACTUAL manifests require a bounded typed patch.");
  }
  const manifest: DecisionReplayManifest = {
    schema: DECISION_REPLAY_SCHEMA,
    label: DECISION_REPLAY_LABEL,
    mode,
    engine,
    input,
    expectedOutput: expectedOutput.artifact === undefined
      ? Object.freeze({ fingerprint: expectedOutput.fingerprint })
      : expectedOutput,
    patches: Object.freeze(patches),
    limits,
  };
  return freezeDeep(manifest);
}

export function createDecisionReplayManifest(value: DecisionReplayManifestInput | unknown): DecisionReplayManifest {
  return normalizeManifest(value);
}

export const createReplayManifest = createDecisionReplayManifest;
export const immutableDecisionReplayManifest = createDecisionReplayManifest;
export const validateDecisionReplayManifest = createDecisionReplayManifest;
export const buildDecisionReplayManifest = createDecisionReplayManifest;
export const validateReplayManifest = createDecisionReplayManifest;

function blockerResult(
  manifest: DecisionReplayManifest,
  status: DecisionReplayStatus,
  effectiveInputFingerprint: ReplayFingerprint,
  blockers: readonly string[],
  actualOutputFingerprint: ReplayFingerprint | null = null,
  output?: ReplayJsonValue,
  diff: readonly ReplayDiffGroup[] = [],
): DecisionReplayResult {
  const result: DecisionReplayResult = {
    schema: DECISION_REPLAY_RESULT_SCHEMA,
    label: DECISION_REPLAY_LABEL,
    mode: manifest.mode,
    status,
    engine: manifest.engine,
    inputFingerprint: manifest.input.fingerprint,
    effectiveInputFingerprint,
    expectedOutputFingerprint: manifest.expectedOutput.fingerprint,
    actualOutputFingerprint,
    ...(output === undefined ? {} : { output: freezeDeep(cloneJson(output)) }),
    diff: freezeDeep(cloneJson(diff as unknown as ReplayJsonValue)) as unknown as readonly ReplayDiffGroup[],
    blockers: Object.freeze([...new Set(blockers)].sort()),
  };
  return freezeDeep(result);
}

function executionEvidenceBasis(
  evidence: Omit<DecisionReplayExecutionEvidence, "evidenceFingerprint">,
): ReplayJsonValue {
  return {
    schema: evidence.schema,
    label: evidence.label,
    engine: evidence.engine as unknown as ReplayJsonValue,
    mode: evidence.mode,
    inputFingerprint: evidence.inputFingerprint,
    effectiveInputFingerprint: evidence.effectiveInputFingerprint,
    status: evidence.status,
    ...(evidence.output === undefined ? {} : { output: evidence.output }),
    ...(evidence.outputFingerprint === undefined ? {} : { outputFingerprint: evidence.outputFingerprint }),
  };
}

function normalizeExecutionEvidenceFields(
  value: unknown,
  path: string,
  defaultsAllowed: boolean,
): Omit<DecisionReplayExecutionEvidence, "evidenceFingerprint"> {
  const snapshot = snapshotJsonValue(value, path);
  if (!isRecord(snapshot)) fail("REPLAY_EXECUTION_EVIDENCE_INVALID", `${path} must be a plain-data evidence object.`);
  ownKeys(snapshot, [
    "schema", "label", "engine", "mode", "inputFingerprint", "effectiveInputFingerprint",
    "status", "output", "outputFingerprint", "evidenceFingerprint",
  ], path);
  const schema = snapshot.schema ?? (defaultsAllowed ? DECISION_REPLAY_EXECUTION_EVIDENCE_SCHEMA : undefined);
  if (schema !== DECISION_REPLAY_EXECUTION_EVIDENCE_SCHEMA) {
    fail("REPLAY_EXECUTION_EVIDENCE_SCHEMA_INVALID", `${path}.schema is unsupported.`);
  }
  const label = snapshot.label ?? (defaultsAllowed ? DECISION_REPLAY_LABEL : undefined);
  if (label !== DECISION_REPLAY_LABEL) {
    fail("REPLAY_EXECUTION_EVIDENCE_LABEL_INVALID", `${path}.label must be SIMULATION_ONLY.`);
  }
  const engine = normalizeEngine(snapshot.engine, {});
  if (!REPLAY_MODES.includes(snapshot.mode as ReplayMode)) {
    fail("REPLAY_EXECUTION_EVIDENCE_MODE_INVALID", `${path}.mode is unsupported.`);
  }
  const mode = snapshot.mode as ReplayMode;
  const inputFingerprint = requireHash(snapshot.inputFingerprint, `${path}.inputFingerprint`);
  const effectiveInputFingerprint = requireHash(snapshot.effectiveInputFingerprint, `${path}.effectiveInputFingerprint`);
  if (snapshot.status !== "FEASIBLE" && snapshot.status !== "INFEASIBLE") {
    fail("REPLAY_EXECUTION_EVIDENCE_STATUS_INVALID", `${path}.status is unsupported.`);
  }
  if (snapshot.status === "INFEASIBLE") {
    if (snapshot.output !== undefined || snapshot.outputFingerprint !== undefined) {
      fail("REPLAY_EXECUTION_EVIDENCE_OUTPUT_FORBIDDEN", `${path} cannot attach output to INFEASIBLE evidence.`);
    }
    return freezeDeep({
      schema,
      label,
      engine,
      mode,
      inputFingerprint,
      effectiveInputFingerprint,
      status: snapshot.status,
    });
  }
  if (snapshot.output === undefined) {
    fail("REPLAY_EXECUTION_EVIDENCE_OUTPUT_MISSING", `${path}.output is required for FEASIBLE evidence.`);
  }
  const output = freezeDeep(cloneJson(snapshot.output));
  const outputFingerprint = snapshot.outputFingerprint === undefined && defaultsAllowed
    ? replayFingerprintOf(output)
    : requireHash(snapshot.outputFingerprint, `${path}.outputFingerprint`);
  return freezeDeep({
    schema,
    label,
    engine,
    mode,
    inputFingerprint,
    effectiveInputFingerprint,
    status: snapshot.status,
    output,
    outputFingerprint,
  });
}

export function createDecisionReplayExecutionEvidence(
  value: DecisionReplayExecutionEvidenceInput | unknown,
): DecisionReplayExecutionEvidence {
  const fields = normalizeExecutionEvidenceFields(value, "$executionEvidence", true);
  return freezeDeep({
    ...fields,
    evidenceFingerprint: replayFingerprintOf(executionEvidenceBasis(fields)),
  });
}

export const buildDecisionReplayExecutionEvidence = createDecisionReplayExecutionEvidence;

function normalizeExecutionEvidence(value: unknown, index: number): DecisionReplayExecutionEvidence {
  const path = `executionEvidence[${index}]`;
  const snapshot = snapshotJsonValue(value, path);
  if (!isRecord(snapshot)) fail("REPLAY_EXECUTION_EVIDENCE_INVALID", `${path} must be a plain-data evidence object.`);
  const fields = normalizeExecutionEvidenceFields(snapshot, path, false);
  const evidenceFingerprint = requireHash(snapshot.evidenceFingerprint, `${path}.evidenceFingerprint`);
  if (evidenceFingerprint !== replayFingerprintOf(executionEvidenceBasis(fields))) {
    fail("REPLAY_EXECUTION_EVIDENCE_FINGERPRINT_MISMATCH", `${path}.evidenceFingerprint does not bind the exact evidence.`);
  }
  return freezeDeep({ ...fields, evidenceFingerprint });
}

function normalizeExecutionEvidenceCatalog(value: unknown): readonly DecisionReplayExecutionEvidence[] {
  const snapshot = snapshotJsonValue(value, "$executionEvidenceCatalog");
  if (!Array.isArray(snapshot)) {
    fail("REPLAY_EXECUTION_EVIDENCE_CATALOG_INVALID", "Replay execution evidence must be an array.");
  }
  if (snapshot.length > 16) {
    fail("REPLAY_EXECUTION_EVIDENCE_CATALOG_TOO_LARGE", "The execution evidence catalog exceeds the fixed lookup bound.");
  }
  return Object.freeze(snapshot.map((entry, index) => normalizeExecutionEvidence(entry, index)));
}

function exactExecutionEvidence(
  reference: ReplayEngineReference,
  evidenceCatalog: readonly DecisionReplayExecutionEvidence[],
): { evidence?: DecisionReplayExecutionEvidence; status?: DecisionReplayStatus; blocker?: string } {
  const matches = evidenceCatalog.filter((entry) =>
    entry.engine.id === reference.id && entry.engine.version === reference.version);
  if (matches.length !== 1) {
    return { status: "ENGINE_UNAVAILABLE", blocker: "ENGINE_EXACT_VERSION_UNAVAILABLE" };
  }
  const evidence = matches[0]!;
  if (evidence.engine.fingerprint !== reference.fingerprint) {
    return { status: "NON_REPRODUCIBLE", blocker: "ENGINE_FINGERPRINT_MISMATCH" };
  }
  return { evidence };
}

function effectiveInputFingerprintOf(manifest: DecisionReplayManifest): ReplayFingerprint {
  return replayFingerprintOf({
    baseInput: manifest.input.artifact,
    patches: manifest.patches as unknown as ReplayJsonValue,
  });
}

export function replayEffectiveInputFingerprintOf(
  manifestInput: DecisionReplayManifest | unknown,
): ReplayFingerprint {
  return effectiveInputFingerprintOf(normalizeManifest(manifestInput));
}

export function replayDecision(
  manifestInput: DecisionReplayManifest | unknown,
  executionEvidenceInput: readonly DecisionReplayExecutionEvidence[] | unknown,
): DecisionReplayResult {
  const manifest = normalizeManifest(manifestInput);
  const executionEvidence = normalizeExecutionEvidenceCatalog(executionEvidenceInput);
  const baseInputFingerprint = replayFingerprintOf(manifest.input.artifact);
  const effectiveInputFingerprint = effectiveInputFingerprintOf(manifest);
  if (baseInputFingerprint !== manifest.input.fingerprint) {
    return blockerResult(manifest, "NON_REPRODUCIBLE", effectiveInputFingerprint, ["INPUT_FINGERPRINT_MISMATCH"]);
  }
  if (manifest.expectedOutput.artifact !== undefined &&
      replayFingerprintOf(manifest.expectedOutput.artifact) !== manifest.expectedOutput.fingerprint) {
    return blockerResult(manifest, "NON_REPRODUCIBLE", effectiveInputFingerprint, ["EXPECTED_OUTPUT_FINGERPRINT_MISMATCH"]);
  }
  const exact = exactExecutionEvidence(manifest.engine, executionEvidence);
  if (exact.status !== undefined) {
    return blockerResult(manifest, exact.status, effectiveInputFingerprint, [exact.blocker!]);
  }
  const evidence = exact.evidence!;
  const evidenceBlockers: string[] = [];
  if (evidence.mode !== manifest.mode) evidenceBlockers.push("EXECUTION_EVIDENCE_MODE_MISMATCH");
  if (evidence.inputFingerprint !== manifest.input.fingerprint) {
    evidenceBlockers.push("EXECUTION_EVIDENCE_INPUT_FINGERPRINT_MISMATCH");
  }
  if (evidence.effectiveInputFingerprint !== effectiveInputFingerprint) {
    evidenceBlockers.push("EXECUTION_EVIDENCE_EFFECTIVE_INPUT_FINGERPRINT_MISMATCH");
  }
  if (evidenceBlockers.length > 0) {
    return blockerResult(manifest, "NON_REPRODUCIBLE", effectiveInputFingerprint, evidenceBlockers);
  }
  if (evidence.status === "INFEASIBLE") {
    return blockerResult(manifest, "INFEASIBLE", effectiveInputFingerprint, ["ENGINE_REPORTED_INFEASIBLE"]);
  }
  const output = evidence.output!;
  try {
    assertNoForbiddenActionKeys(output, "engine.output");
    if (byteLength(output) > manifest.limits.maxArtifactBytes) {
      return blockerResult(manifest, "NON_REPRODUCIBLE", effectiveInputFingerprint, ["ENGINE_OUTPUT_TOO_LARGE"]);
    }
  } catch (error) {
    if (error instanceof DecisionReplayValidationError) {
      return blockerResult(manifest, "NON_REPRODUCIBLE", effectiveInputFingerprint, ["ENGINE_OUTPUT_ACTION_FIELD_FORBIDDEN"]);
    }
    throw error;
  }
  const actualOutputFingerprint = replayFingerprintOf(output);
  if (evidence.outputFingerprint !== actualOutputFingerprint) {
    return blockerResult(manifest, "NON_REPRODUCIBLE", effectiveInputFingerprint, ["ENGINE_OUTPUT_FINGERPRINT_MISMATCH"], actualOutputFingerprint, output);
  }
  let diff: readonly ReplayDiffGroup[] = [];
  if (manifest.expectedOutput.artifact !== undefined) {
    try {
      diff = canonicalReplayDiff(manifest.expectedOutput.artifact, output, manifest.limits.maxDiffEntries);
    } catch (error) {
      if (error instanceof DecisionReplayValidationError && error.code === "REPLAY_DIFF_LIMIT_EXCEEDED") {
        return blockerResult(manifest, "NON_REPRODUCIBLE", effectiveInputFingerprint, [error.code], actualOutputFingerprint, output);
      }
      throw error;
    }
  }
  if (actualOutputFingerprint !== manifest.expectedOutput.fingerprint) {
    return blockerResult(manifest, "NON_REPRODUCIBLE", effectiveInputFingerprint, ["OUTPUT_FINGERPRINT_MISMATCH"], actualOutputFingerprint, output, diff);
  }
  return blockerResult(manifest, "MATCH", effectiveInputFingerprint, [], actualOutputFingerprint, output, diff);
}

export const runDecisionReplay = replayDecision;
export const executeDecisionReplay = replayDecision;
export const replayDecisionManifest = replayDecision;

interface FamilyValue {
  readonly family: string;
  readonly value: ReplayJsonValue;
}

function sourceFamilyValues(value: ReplayJsonValue): readonly FamilyValue[] {
  if (isRecord(value)) {
    const familyMap = value.sourceFamilies ?? value.bySourceFamily;
    if (isRecord(familyMap)) {
      return Object.entries(familyMap)
        .map(([family, child]) => {
          if (!SOURCE_FAMILY_PATTERN.test(family)) fail("REPLAY_SOURCE_FAMILY_INVALID", "A source family identifier is invalid.");
          assertJsonValue(child, `sourceFamilies.${family}`);
          return { family, value: child };
        })
        .sort((first, second) => first.family.localeCompare(second.family));
    }
  }
  if (Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.sourceFamily === "string")) {
    const grouped = new Map<string, ReplayJsonValue[]>();
    for (const item of value) {
      const family = (item as Record<string, unknown>).sourceFamily as string;
      if (!SOURCE_FAMILY_PATTERN.test(family)) fail("REPLAY_SOURCE_FAMILY_INVALID", "A source family identifier is invalid.");
      const copy = { ...(item as Record<string, ReplayJsonValue>) };
      delete (copy as Record<string, unknown>).sourceFamily;
      const current = grouped.get(family) ?? [];
      current.push(copy);
      grouped.set(family, current);
    }
    return [...grouped.entries()]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([family, children]) => ({ family, value: children }));
  }
  return [{ family: "UNSPECIFIED", value }];
}

function jsonPointerSegment(segment: string | number): string {
  return `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function diffValues(
  expected: ReplayJsonValue | undefined,
  actual: ReplayJsonValue | undefined,
  path: string,
  changes: ReplayDiffChange[],
  counter: { value: number; max: number },
): void {
  const addChange = (change: ReplayDiffChange): void => {
    if (counter.value >= counter.max) fail("REPLAY_DIFF_LIMIT_EXCEEDED", "The replay diff exceeds its fixed entry bound.");
    changes.push(change);
    counter.value += 1;
  };
  const addMissingLeaves = (value: ReplayJsonValue, kind: "ADDED" | "REMOVED", leafPath: string): void => {
    if (Array.isArray(value) && value.length > 0) {
      for (let index = 0; index < value.length; index += 1) {
        addMissingLeaves(value[index]!, kind, `${leafPath}${jsonPointerSegment(index)}`);
      }
      return;
    }
    if (isRecord(value)) {
      const keys = Object.keys(value).sort();
      if (keys.length > 0) {
        for (const key of keys) {
          addMissingLeaves(value[key]!, kind, `${leafPath}${jsonPointerSegment(key)}`);
        }
        return;
      }
    }
    addChange(kind === "ADDED"
      ? { path: leafPath, kind, actual: value }
      : { path: leafPath, kind, expected: value });
  };
  if (expected === undefined && actual === undefined) return;
  if (expected === undefined) {
    addMissingLeaves(actual!, "ADDED", path);
    return;
  }
  if (actual === undefined) {
    addMissingLeaves(expected, "REMOVED", path);
    return;
  }
  if (replayCanonicalJson(expected) === replayCanonicalJson(actual)) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      diffValues(expected[index], actual[index], `${path}${jsonPointerSegment(index)}`, changes, counter);
    }
    return;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      diffValues(expected[key] as ReplayJsonValue | undefined, actual[key] as ReplayJsonValue | undefined, `${path}${jsonPointerSegment(key)}`, changes, counter);
    }
    return;
  }
  addChange({ path, kind: "CHANGED", expected, actual });
}

export function canonicalReplayDiff(
  expected: ReplayJsonValue,
  actual: ReplayJsonValue,
  maxEntries = MAX_REPLAY_LIMITS.maxDiffEntries,
): readonly ReplayDiffGroup[] {
  const expectedSnapshot = snapshotJsonValue(expected, "expected output");
  const actualSnapshot = snapshotJsonValue(actual, "actual output");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > MAX_REPLAY_LIMITS.maxDiffEntries) {
    fail("REPLAY_DIFF_LIMIT_INVALID", "The replay diff bound is outside the fixed limit.");
  }
  const expectedFamilies = new Map(sourceFamilyValues(expectedSnapshot).map((entry) => [entry.family, entry.value]));
  const actualFamilies = new Map(sourceFamilyValues(actualSnapshot).map((entry) => [entry.family, entry.value]));
  const families = [...new Set([...expectedFamilies.keys(), ...actualFamilies.keys()])].sort();
  const groups: ReplayDiffGroup[] = [];
  const counter = { value: 0, max: maxEntries };
  for (const family of families) {
    const changes: ReplayDiffChange[] = [];
    diffValues(expectedFamilies.get(family), actualFamilies.get(family), "", changes, counter);
    if (changes.length > 0) groups.push({ sourceFamily: family, changes });
  }
  return freezeDeep(cloneJson(groups as unknown as ReplayJsonValue)) as unknown as readonly ReplayDiffGroup[];
}

export const diffDecisionOutputs = canonicalReplayDiff;
export const diffReplayOutputs = canonicalReplayDiff;

function snapshotHasReplayApplyField(value: ReplayJsonValue): boolean {
  if (Array.isArray(value)) return value.some((child) => snapshotHasReplayApplyField(child));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_ACTION_KEY.test(key) || snapshotHasReplayApplyField(child));
}

export function hasReplayApplyField(value: unknown): boolean {
  try {
    return snapshotHasReplayApplyField(snapshotJsonValue(value, "$actionInspection"));
  } catch (error) {
    if (error instanceof DecisionReplayValidationError) return true;
    throw error;
  }
}
