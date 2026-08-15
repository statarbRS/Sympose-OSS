import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  CURATORIAL_CONSTRAINT_KINDS,
  CURATORIAL_EVIDENCE_FAMILIES,
  CURATORIAL_EVIDENCE_OBJECTIVE_FAMILIES,
  CURATORIAL_EXPLANATION_RECEIPT_SCHEMA,
  CURATORIAL_FINGERPRINT_ALGORITHM,
  CURATORIAL_LIMITS,
  CURATORIAL_OVERRIDE_PROPOSAL_SCHEMA,
  CURATORIAL_SELECTION_SCHEMA,
  type CandidateSlatePreview,
  type CapacityPoolSnapshot,
  type CapacityTransfer,
  type CapacityUsage,
  type ConstraintResult,
  type CuratorialBlocker,
  type CuratorialBlockerCode,
  type CuratorialConstraint,
  type CuratorialEvidenceFamily,
  type CuratorialObjective,
  type CuratorialObjectiveFamily,
  type CuratorialReviewEvidence,
  type CuratorialScope,
  type CurrentReviewContext,
  type DisplacedAlternative,
  type EligibleProposalRevision,
  type EligibilityBinding,
  type EligibilityContext,
  type EvidenceState,
  type EvidenceStance,
  type EvidenceVisibility,
  type ExactRational,
  type ExplanationReceipt,
  type HumanOverrideProposalInput,
  type HumanOverrideProposalReceipt,
  type HumanOverrideIdempotencyBinding,
  type HumanOverrideIdempotencyResolution,
  type HumanOverrideIdempotencyState,
  type HumanOverrideSourceRequest,
  type HumanOverrideTrustedAdapter,
  type ObjectiveContribution,
  type ObjectiveTotal,
  type OverrideAllocation,
  type OverrideDisplacedBinding,
  type OverrideRevisionBinding,
  type ProgramAllocationOption,
  type ProgramSelectionInput,
  type ProgramSelectionPreview,
  type PreviewStatus,
  type SlateEntry,
  type SlateRankingBasis,
} from "./contracts";

export * from "./contracts";

const ERROR_MESSAGES = {
  CURATORIAL_INPUT_UNSAFE: "The curatorial-selection input is unsafe.",
  CURATORIAL_SHAPE_INVALID: "The curatorial-selection input has an invalid structure.",
  CURATORIAL_LIMIT_EXCEEDED: "The curatorial-selection input exceeds a safety bound.",
  CURATORIAL_CAPACITY_LEDGER_BLOCKED: "The typed capacity ledger is conflicting or non-conserving.",
  CURATORIAL_EVIDENCE_BLOCKED: "Current curatorial evidence is blocked or conflicting.",
  CURATORIAL_EVIDENCE_UNAVAILABLE: "Current curatorial evidence is unavailable.",
  CURATORIAL_OVERRIDE_MISMATCH: "The human override proposal does not bind to its exact source context.",
  CURATORIAL_OVERRIDE_REPLAY: "The human override idempotency replay does not match its original proposal.",
  CURATORIAL_AUTHORITY_INVALID: "The human override authority vector is not proposal-only and current.",
  CURATORIAL_PURPOSE_INVALID: "The requested curatorial purpose is not permitted for this core.",
  CURATORIAL_RETENTION_INVALID: "The human override retention binding is invalid.",
  CURATORIAL_IDEMPOTENCY_INVALID: "The human override idempotency key is invalid.",
  CURATORIAL_TRUSTED_ADAPTER_REQUIRED:
    "A trusted curatorial source and idempotency adapter is required.",
  CURATORIAL_SEARCH_BUDGET_EXCEEDED: "The bounded curatorial search budget was exceeded.",
} as const;

export type CuratorialSeparationErrorCode = keyof typeof ERROR_MESSAGES;

export class CuratorialSeparationError extends Error {
  readonly code: CuratorialSeparationErrorCode;

  constructor(code: CuratorialSeparationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CuratorialSeparationError";
    this.code = code;
  }
}

function fail(code: CuratorialSeparationErrorCode): never {
  throw new CuratorialSeparationError(code);
}

const HAS_OWN = Object.prototype.hasOwnProperty;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype", "toJSON"]);
const EVIDENCE_STATE_SET = new Set<EvidenceState>([
  "CURRENT",
  "STALE",
  "MISSING",
  "CONFLICTING",
  "BLOCKED",
  "UNAVAILABLE",
]);
const VISIBILITY_SET = new Set<EvidenceVisibility>([
  "PUBLIC",
  "ORGANIZER_PRIVATE",
  "BLIND_PRIVATE",
]);
const EVIDENCE_FAMILY_SET = new Set<CuratorialEvidenceFamily>(CURATORIAL_EVIDENCE_FAMILIES);
const OBJECTIVE_FAMILY_SET = new Set<CuratorialObjectiveFamily>(
  CURATORIAL_EVIDENCE_OBJECTIVE_FAMILIES,
);
const CONSTRAINT_KIND_SET = new Set<string>(CURATORIAL_CONSTRAINT_KINDS);
const STANCE_SET = new Set<EvidenceStance>([
  "STRONGLY_PROMOTE",
  "PROMOTE",
  "NO_POSITION",
  "OPPOSE",
]);
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_OBJECT_KEYS = 256;
const MAX_ARRAY_LENGTH = 1_024;

type PlainRecord = Record<string, unknown>;
type SafeValue = null | boolean | number | string | SafeValue[] | { [key: string]: SafeValue };

interface WalkState {
  readonly active: WeakSet<object>;
  nodes: number;
  serializedBytes: number;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function unsafe(): never {
  return fail("CURATORIAL_INPUT_UNSAFE");
}

function limited(): never {
  return fail("CURATORIAL_LIMIT_EXCEEDED");
}

function objectOwnNames(value: object): string[] {
  let enumerableCount = 0;
  try {
    for (const key in value) {
      enumerableCount += 1;
      if (enumerableCount > MAX_OBJECT_KEYS) return limited();
      if (!HAS_OWN.call(value, key)) return unsafe();
    }
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) return unsafe();
    const names = Object.getOwnPropertyNames(value);
    if (names.length > MAX_OBJECT_KEYS) return limited();
    return names;
  } catch {
    return unsafe();
  }
}

function descriptorValue(value: object, key: string, enumerable: boolean): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return unsafe();
  }
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== enumerable) {
    return unsafe();
  }
  return descriptor.value;
}

/**
 * Preflight and detach untrusted descriptor data before any domain property is read.
 * In particular, no accessor, proxy trap, `toJSON`, function, or cyclic object is
 * allowed to reach the normalization layer.
 */
function detach(value: unknown, depth = 0, state: WalkState = {
  active: new WeakSet<object>(),
  nodes: 0,
  serializedBytes: 0,
}): SafeValue {
  if (depth > CURATORIAL_LIMITS.maxDepth) return limited();
  state.nodes += 1;
  if (state.nodes > CURATORIAL_LIMITS.maxNodes) return limited();

  if (value === null || typeof value === "boolean") {
    state.serializedBytes += value === null ? 4 : 5;
    if (state.serializedBytes > CURATORIAL_LIMITS.maxSerializedBytes) return limited();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return unsafe();
    const normalized = Object.is(value, -0) ? 0 : value;
    if (!Number.isSafeInteger(normalized)) return unsafe();
    state.serializedBytes += String(normalized).length;
    if (state.serializedBytes > CURATORIAL_LIMITS.maxSerializedBytes) return limited();
    return normalized;
  }
  if (typeof value === "string") {
    if (
      hasLoneSurrogate(value) ||
      CONTROL_CHARACTER_PATTERN.test(value) ||
      Buffer.byteLength(value, "utf8") > CURATORIAL_LIMITS.maxStringBytes
    ) {
      return unsafe();
    }
    state.serializedBytes += Buffer.byteLength(value, "utf8") + 2;
    if (state.serializedBytes > CURATORIAL_LIMITS.maxSerializedBytes) return limited();
    return value;
  }
  if (
    typeof value !== "object" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return unsafe();
  }

  let proxied = false;
  try {
    proxied = utilTypes.isProxy(value);
  } catch {
    return unsafe();
  }
  if (proxied || state.active.has(value)) return unsafe();
  state.active.add(value);
  try {
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch {
      return unsafe();
    }
    const isArray = Array.isArray(value);
    if (isArray) {
      if (prototype !== Array.prototype) return unsafe();
      const names = objectOwnNames(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_ARRAY_LENGTH ||
        lengthDescriptor.enumerable
      ) {
        return unsafe();
      }
      const length = lengthDescriptor.value;
      if (names.length !== length + 1 || !names.includes("length")) return unsafe();
      const result: SafeValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (!names.includes(key)) return unsafe();
        result.push(detach(descriptorValue(value, key, true), depth + 1, state));
      }
      state.serializedBytes += 2;
      if (state.serializedBytes > CURATORIAL_LIMITS.maxSerializedBytes) return limited();
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) return unsafe();
    const names = objectOwnNames(value);
    const result: { [key: string]: SafeValue } = {};
    for (const key of names) {
      if (
        FORBIDDEN_KEYS.has(key) ||
        key.length === 0 ||
        CONTROL_CHARACTER_PATTERN.test(key) ||
        hasLoneSurrogate(key) ||
        Buffer.byteLength(key, "utf8") > CURATORIAL_LIMITS.maxIdentifierBytes
      ) {
        return unsafe();
      }
      result[key] = detach(descriptorValue(value, key, true), depth + 1, state);
    }
    state.serializedBytes += names.length * 2 + 2;
    if (state.serializedBytes > CURATORIAL_LIMITS.maxSerializedBytes) return limited();
    return result;
  } finally {
    state.active.delete(value);
  }
}

function isRecord(value: SafeValue): value is { [key: string]: SafeValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: PlainRecord, key: string): boolean {
  return HAS_OWN.call(value, key);
}

function exactRecord(
  value: SafeValue,
  required: readonly string[],
  optional: readonly string[] = [],
): PlainRecord {
  if (!isRecord(value)) return fail("CURATORIAL_SHAPE_INVALID");
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    keys.length > allowed.size ||
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !hasOwn(value, key))
  ) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return value as PlainRecord;
}

function required(value: PlainRecord, key: string): SafeValue {
  if (!hasOwn(value, key)) return fail("CURATORIAL_SHAPE_INVALID");
  return value[key] as SafeValue;
}

function optional(value: PlainRecord, key: string): SafeValue | undefined {
  return hasOwn(value, key) ? (value[key] as SafeValue) : undefined;
}

function safeArray(value: SafeValue, maximum: number): SafeValue[] {
  if (!Array.isArray(value) || value.length > maximum) return fail("CURATORIAL_SHAPE_INVALID");
  return value;
}

function boundedText(value: SafeValue, maximum = CURATORIAL_LIMITS.maxStringBytes): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return value;
}

function identifier(value: SafeValue): string {
  return boundedText(value, CURATORIAL_LIMITS.maxIdentifierBytes);
}

function fingerprint(value: SafeValue): string {
  const result = boundedText(value, 64);
  if (!FINGERPRINT_PATTERN.test(result)) return fail("CURATORIAL_SHAPE_INVALID");
  return result;
}

function integer(value: SafeValue, maximum: number, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return value;
}

function booleanValue(value: SafeValue): boolean {
  if (typeof value !== "boolean") return fail("CURATORIAL_SHAPE_INVALID");
  return value;
}

function enumValue<T extends string>(value: SafeValue, values: ReadonlySet<T>): T {
  if (typeof value !== "string" || !values.has(value as T)) return fail("CURATORIAL_SHAPE_INVALID");
  return value as T;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const scalar = JSON.stringify(value);
    if (typeof scalar !== "string") return fail("CURATORIAL_SHAPE_INVALID");
    return scalar;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function fingerprintOf(value: unknown): string {
  return sha256(canonical(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

function cloneArray<T>(values: readonly T[]): T[] {
  return values.map((value) => value);
}

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a === 0n ? 1n : a;
}

function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator <= 0n) return fail("CURATORIAL_SHAPE_INVALID");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function addRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function compareRational(left: Rational, right: Rational): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function publicRational(value: Rational): ExactRational {
  return {
    numerator: value.numerator.toString(),
    denominator: value.denominator.toString(),
  };
}

function zeroRational(): Rational {
  return rational(0n);
}

function stanceValue(stance: EvidenceStance): number {
  if (stance === "STRONGLY_PROMOTE") return 3;
  if (stance === "PROMOTE") return 2;
  if (stance === "OPPOSE") return -1;
  return 0;
}

interface NormalizedConfiguration {
  readonly maxCandidateSlates: number;
  readonly maxSearchNodes: number;
}

interface NormalizedInput {
  readonly scope: CuratorialScope;
  readonly eligibleRevisions: readonly EligibleProposalRevision[];
  readonly eligibilityContext: EligibilityContext;
  readonly currentReviewContext: CurrentReviewContext;
  readonly pools: readonly CapacityPoolSnapshot[];
  readonly transfers: readonly CapacityTransfer[];
  readonly targetCount: number;
  readonly deterministicSeed: string;
  readonly constraints: readonly CuratorialConstraint[];
  readonly objectives: readonly CuratorialObjective[];
  readonly configuration: NormalizedConfiguration;
  readonly purpose: "PROGRAM_SELECTION_PREVIEW";
  readonly inputFingerprint: string;
  readonly balancesAfterTransfers: ReadonlyMap<string, number>;
  readonly capacityLedgerFingerprint: string;
}

function normalizeAllocationOption(value: SafeValue): ProgramAllocationOption {
  const object = exactRecord(value, ["poolId", "poolVersionId", "unitKind", "quantity"]);
  return {
    poolId: identifier(required(object, "poolId")),
    poolVersionId: identifier(required(object, "poolVersionId")),
    unitKind: identifier(required(object, "unitKind")),
    quantity: integer(required(object, "quantity"), CURATORIAL_LIMITS.maxCapacityQuantity, 1),
  };
}

function normalizeEligibleRevisions(value: SafeValue): readonly EligibleProposalRevision[] {
  const entries = safeArray(value, CURATORIAL_LIMITS.maxProposalRevisions).map((item) => {
    const object = exactRecord(item, [
      "submissionId",
      "proposalRevisionId",
      "revisionNumber",
      "revisionFingerprint",
      "topics",
      "organizationId",
      "allocationOptions",
    ]);
    const topics = safeArray(
      required(object, "topics"),
      CURATORIAL_LIMITS.maxTopicsPerRevision,
    ).map((topic) => identifier(topic)).sort(compareText);
    if (new Set(topics).size !== topics.length) return fail("CURATORIAL_SHAPE_INVALID");
    const allocationOptions = safeArray(
      required(object, "allocationOptions"),
      CURATORIAL_LIMITS.maxAllocationOptions,
    )
      .map(normalizeAllocationOption)
      .sort((left, right) => compareText(canonical(left), canonical(right)));
    if (allocationOptions.length === 0) return fail("CURATORIAL_SHAPE_INVALID");
    if (new Set(allocationOptions.map((option) => canonical(option))).size !== allocationOptions.length) {
      return fail("CURATORIAL_SHAPE_INVALID");
    }
    return {
      submissionId: identifier(required(object, "submissionId")),
      proposalRevisionId: identifier(required(object, "proposalRevisionId")),
      revisionNumber: integer(required(object, "revisionNumber"), 1_000_000, 1),
      revisionFingerprint: fingerprint(required(object, "revisionFingerprint")),
      topics,
      organizationId: identifier(required(object, "organizationId")),
      allocationOptions,
    };
  });
  if (entries.length === 0) return fail("CURATORIAL_SHAPE_INVALID");
  const revisions = entries.sort((left, right) =>
    compareText(left.proposalRevisionId, right.proposalRevisionId),
  );
  if (
    new Set(revisions.map((revision) => revision.proposalRevisionId)).size !== revisions.length ||
    new Set(revisions.map((revision) => revision.submissionId)).size !== revisions.length
  ) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return revisions;
}

function normalizeEligibilityContext(
  value: SafeValue,
  revisions: readonly EligibleProposalRevision[],
): EligibilityContext {
  const object = exactRecord(value, [
    "contextId",
    "versionId",
    "fingerprint",
    "asOf",
    "status",
    "bindings",
  ]);
  const bindings = safeArray(
    required(object, "bindings"),
    CURATORIAL_LIMITS.maxProposalRevisions,
  )
    .map((item): EligibilityBinding => {
      const binding = exactRecord(item, [
        "proposalRevisionId",
        "revisionFingerprint",
        "eligible",
        "evidenceState",
      ]);
      return {
        proposalRevisionId: identifier(required(binding, "proposalRevisionId")),
        revisionFingerprint: fingerprint(required(binding, "revisionFingerprint")),
        eligible: booleanValue(required(binding, "eligible")),
        evidenceState: enumValue(required(binding, "evidenceState"), EVIDENCE_STATE_SET),
      };
    })
    .sort((left, right) => compareText(left.proposalRevisionId, right.proposalRevisionId));
  if (new Set(bindings.map((binding) => binding.proposalRevisionId)).size !== bindings.length) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  if (
    bindings.length !== revisions.length ||
    revisions.some((revision) => !bindings.some((binding) => binding.proposalRevisionId === revision.proposalRevisionId))
  ) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return {
    contextId: identifier(required(object, "contextId")),
    versionId: identifier(required(object, "versionId")),
    fingerprint: fingerprint(required(object, "fingerprint")),
    asOf: boundedText(required(object, "asOf")),
    status: enumValue(required(object, "status"), EVIDENCE_STATE_SET),
    bindings,
  };
}

function normalizeEvidence(
  value: SafeValue,
  knownRevisionIds: ReadonlySet<string>,
  contextFingerprint: string,
): readonly CuratorialReviewEvidence[] {
  const evidence = safeArray(value, CURATORIAL_LIMITS.maxEvidence)
    .map((item): CuratorialReviewEvidence => {
      const object = exactRecord(item, [
        "evidenceId",
        "proposalRevisionId",
        "family",
        "visibility",
        "state",
        "fingerprint",
        "contextFingerprint",
      ], [
        "value",
        "score",
        "comment",
        "stance",
        "strength",
        "rationale",
      ]);
      const family = enumValue(required(object, "family"), EVIDENCE_FAMILY_SET);
      const visibility = enumValue(required(object, "visibility"), VISIBILITY_SET);
      const evidenceState = enumValue(required(object, "state"), EVIDENCE_STATE_SET);
      const proposalRevisionId = identifier(required(object, "proposalRevisionId"));
      if (!knownRevisionIds.has(proposalRevisionId)) return fail("CURATORIAL_SHAPE_INVALID");
      const valueInput = optional(object, "value");
      const scoreInput = optional(object, "score");
      const commentInput = optional(object, "comment");
      const stanceInput = optional(object, "stance");
      const strengthInput = optional(object, "strength");
      const rationaleInput = optional(object, "rationale");
      const normalized: CuratorialReviewEvidence = {
        evidenceId: identifier(required(object, "evidenceId")),
        proposalRevisionId,
        family,
        visibility,
        state: evidenceState,
        fingerprint: fingerprint(required(object, "fingerprint")),
        contextFingerprint: fingerprint(required(object, "contextFingerprint")),
        ...(valueInput === undefined
          ? {}
          : { value: integer(valueInput, CURATORIAL_LIMITS.maxScore) }),
        ...(scoreInput === undefined
          ? {}
          : { score: integer(scoreInput, CURATORIAL_LIMITS.maxScore) }),
        ...(commentInput === undefined ? {} : { comment: boundedText(commentInput) }),
        ...(stanceInput === undefined
          ? {}
          : { stance: enumValue(stanceInput, STANCE_SET) }),
        ...(strengthInput === undefined
          ? {}
          : { strength: integer(strengthInput, 100) }),
        ...(rationaleInput === undefined ? {} : { rationale: boundedText(rationaleInput) }),
      };
      if (
        (family === "INDIVIDUAL_EVALUATION" && normalized.value === undefined) ||
        (family === "CONFIDENTIAL_REVIEW_SCORE" && normalized.score === undefined) ||
        (family === "CONFIDENTIAL_REVIEW_COMMENT" && normalized.comment === undefined) ||
        ((family === "ADVOCACY" || family === "ENDORSEMENT") && normalized.stance === undefined)
      ) {
        return fail("CURATORIAL_SHAPE_INVALID");
      }
      if (
        family === "CONFIDENTIAL_REVIEW_SCORE" ||
        family === "CONFIDENTIAL_REVIEW_COMMENT"
      ) {
        if (visibility === "PUBLIC") return fail("CURATORIAL_SHAPE_INVALID");
      }
      if (
        family === "INDIVIDUAL_EVALUATION" &&
        (normalized.score !== undefined || normalized.comment !== undefined || normalized.stance !== undefined)
      ) {
        return fail("CURATORIAL_SHAPE_INVALID");
      }
      if (
        family === "CONFIDENTIAL_REVIEW_SCORE" &&
        (normalized.value !== undefined || normalized.comment !== undefined || normalized.stance !== undefined)
      ) {
        return fail("CURATORIAL_SHAPE_INVALID");
      }
      if (
        (family === "ADVOCACY" || family === "ENDORSEMENT") &&
        (normalized.value !== undefined || normalized.score !== undefined || normalized.comment !== undefined)
      ) {
        return fail("CURATORIAL_SHAPE_INVALID");
      }
      return normalized;
    })
    .sort((left, right) => compareText(left.evidenceId, right.evidenceId));
  if (new Set(evidence.map((item) => item.evidenceId)).size !== evidence.length) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return evidence;
}

function normalizeReviewContext(
  value: SafeValue,
  knownRevisionIds: ReadonlySet<string>,
): CurrentReviewContext {
  const object = exactRecord(value, [
    "contextId",
    "versionId",
    "fingerprint",
    "asOf",
    "status",
    "evidence",
  ]);
  const contextFingerprint = fingerprint(required(object, "fingerprint"));
  return {
    contextId: identifier(required(object, "contextId")),
    versionId: identifier(required(object, "versionId")),
    fingerprint: contextFingerprint,
    asOf: boundedText(required(object, "asOf")),
    status: enumValue(required(object, "status"), EVIDENCE_STATE_SET),
    evidence: normalizeEvidence(required(object, "evidence"), knownRevisionIds, contextFingerprint),
  };
}

function normalizePools(value: SafeValue): readonly CapacityPoolSnapshot[] {
  const pools = safeArray(value, CURATORIAL_LIMITS.maxCapacityPools)
    .map((item): CapacityPoolSnapshot => {
      const object = exactRecord(item, [
        "poolId",
        "poolVersionId",
        "unitKind",
        "capacity",
        "remaining",
      ]);
      return {
        poolId: identifier(required(object, "poolId")),
        poolVersionId: identifier(required(object, "poolVersionId")),
        unitKind: identifier(required(object, "unitKind")),
        capacity: integer(required(object, "capacity"), CURATORIAL_LIMITS.maxCapacityQuantity),
        remaining: integer(required(object, "remaining"), CURATORIAL_LIMITS.maxCapacityQuantity),
      };
    })
    .sort((left, right) => compareText(left.poolId, right.poolId));
  if (pools.length === 0 || new Set(pools.map((pool) => pool.poolId)).size !== pools.length) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return pools;
}

function normalizeTransfers(
  value: SafeValue,
  pools: readonly CapacityPoolSnapshot[],
): { readonly transfers: readonly CapacityTransfer[]; readonly balances: ReadonlyMap<string, number> } {
  const poolById = new Map(pools.map((pool) => [pool.poolId, pool]));
  const balances = new Map(pools.map((pool) => [pool.poolId, pool.remaining]));
  const transfers = safeArray(value, CURATORIAL_LIMITS.maxCapacityTransfers)
    .map((item): CapacityTransfer => {
      const object = exactRecord(item, [
        "transferId",
        "sequenceNumber",
        "sourcePoolId",
        "sourcePoolVersionId",
        "destinationPoolId",
        "destinationPoolVersionId",
        "unitKind",
        "quantity",
        "sourceBefore",
        "sourceAfter",
        "destinationBefore",
        "destinationAfter",
        "fingerprint",
      ]);
      return {
        transferId: identifier(required(object, "transferId")),
        sequenceNumber: integer(required(object, "sequenceNumber"), CURATORIAL_LIMITS.maxCapacityTransfers, 1),
        sourcePoolId: identifier(required(object, "sourcePoolId")),
        sourcePoolVersionId: identifier(required(object, "sourcePoolVersionId")),
        destinationPoolId: identifier(required(object, "destinationPoolId")),
        destinationPoolVersionId: identifier(required(object, "destinationPoolVersionId")),
        unitKind: identifier(required(object, "unitKind")),
        quantity: integer(required(object, "quantity"), CURATORIAL_LIMITS.maxCapacityQuantity, 1),
        sourceBefore: integer(required(object, "sourceBefore"), CURATORIAL_LIMITS.maxCapacityQuantity),
        sourceAfter: integer(required(object, "sourceAfter"), CURATORIAL_LIMITS.maxCapacityQuantity),
        destinationBefore: integer(required(object, "destinationBefore"), CURATORIAL_LIMITS.maxCapacityQuantity),
        destinationAfter: integer(required(object, "destinationAfter"), CURATORIAL_LIMITS.maxCapacityQuantity),
        fingerprint: fingerprint(required(object, "fingerprint")),
      };
    })
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  if (
    new Set(transfers.map((transfer) => transfer.transferId)).size !== transfers.length ||
    transfers.some((transfer, index) => transfer.sequenceNumber !== index + 1)
  ) {
    return fail("CURATORIAL_CAPACITY_LEDGER_BLOCKED");
  }
  for (const transfer of transfers) {
    const source = poolById.get(transfer.sourcePoolId);
    const destination = poolById.get(transfer.destinationPoolId);
    if (
      !source ||
      !destination ||
      transfer.sourcePoolId === transfer.destinationPoolId ||
      source.poolVersionId !== transfer.sourcePoolVersionId ||
      destination.poolVersionId !== transfer.destinationPoolVersionId ||
      source.unitKind !== transfer.unitKind ||
      destination.unitKind !== transfer.unitKind ||
      transfer.sourceBefore !== balances.get(transfer.sourcePoolId) ||
      transfer.destinationBefore !== balances.get(transfer.destinationPoolId) ||
      transfer.sourceAfter !== transfer.sourceBefore - transfer.quantity ||
      transfer.destinationAfter !== transfer.destinationBefore + transfer.quantity ||
      transfer.sourceAfter < 0 ||
      transfer.destinationAfter > CURATORIAL_LIMITS.maxCapacityQuantity
    ) {
      return fail("CURATORIAL_CAPACITY_LEDGER_BLOCKED");
    }
    if (transfer.fingerprint !== curatorialCapacityTransferFingerprint(transfer)) {
      return fail("CURATORIAL_CAPACITY_LEDGER_BLOCKED");
    }
    balances.set(transfer.sourcePoolId, transfer.sourceAfter);
    balances.set(transfer.destinationPoolId, transfer.destinationAfter);
  }
  return { transfers, balances };
}

export function curatorialCapacityTransferFingerprint(
  transfer: Omit<CapacityTransfer, "fingerprint">,
): string {
  return fingerprintOf({
    schema: "curatorial-capacity-transfer/v1",
    transferId: transfer.transferId,
    sequenceNumber: transfer.sequenceNumber,
    sourcePoolId: transfer.sourcePoolId,
    sourcePoolVersionId: transfer.sourcePoolVersionId,
    destinationPoolId: transfer.destinationPoolId,
    destinationPoolVersionId: transfer.destinationPoolVersionId,
    unitKind: transfer.unitKind,
    quantity: transfer.quantity,
    sourceBefore: transfer.sourceBefore,
    sourceAfter: transfer.sourceAfter,
    destinationBefore: transfer.destinationBefore,
    destinationAfter: transfer.destinationAfter,
  });
}

function normalizeConstraints(value: SafeValue): readonly CuratorialConstraint[] {
  const constraints = safeArray(value, CURATORIAL_LIMITS.maxConstraints)
    .map((item): CuratorialConstraint => {
      const object = exactRecord(item, [
        "constraintId",
        "kind",
        "hard",
      ], [
        "topicId",
        "organizationId",
        "limit",
      ]);
      const kind = enumValue(required(object, "kind"), CONSTRAINT_KIND_SET);
      const topicInput = optional(object, "topicId");
      const organizationInput = optional(object, "organizationId");
      const limitInput = optional(object, "limit");
      const needsTopic =
        kind === "REQUIRE_TOPIC" || kind === "EXCLUDE_TOPIC" ||
        kind === "MAX_TOPIC_COUNT" || kind === "MIN_TOPIC_COUNT";
      const needsOrganization =
        kind === "MAX_ORGANIZATION_COUNT" || kind === "MIN_ORGANIZATION_COUNT";
      const needsLimit =
        kind === "MAX_TOPIC_COUNT" || kind === "MIN_TOPIC_COUNT" ||
        kind === "MAX_ORGANIZATION_COUNT" || kind === "MIN_ORGANIZATION_COUNT" ||
        kind === "MIN_DISTINCT_TOPICS" || kind === "MIN_DISTINCT_ORGANIZATIONS" ||
        kind === "MAX_TOTAL_UNITS";
      if ((needsTopic && topicInput === undefined) || (!needsTopic && topicInput !== undefined)) {
        return fail("CURATORIAL_SHAPE_INVALID");
      }
      if ((needsOrganization && organizationInput === undefined) || (!needsOrganization && organizationInput !== undefined)) {
        return fail("CURATORIAL_SHAPE_INVALID");
      }
      if ((needsLimit && limitInput === undefined) || (!needsLimit && limitInput !== undefined)) {
        return fail("CURATORIAL_SHAPE_INVALID");
      }
      return {
        constraintId: identifier(required(object, "constraintId")),
        kind: kind as CuratorialConstraint["kind"],
        hard: booleanValue(required(object, "hard")),
        ...(topicInput === undefined ? {} : { topicId: identifier(topicInput) }),
        ...(organizationInput === undefined
          ? {}
          : { organizationId: identifier(organizationInput) }),
        ...(limitInput === undefined
          ? {}
          : { limit: integer(limitInput, CURATORIAL_LIMITS.maxCapacityQuantity) }),
      };
    })
    .sort((left, right) => compareText(left.constraintId, right.constraintId));
  if (new Set(constraints.map((constraint) => constraint.constraintId)).size !== constraints.length) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return constraints;
}

function normalizeObjectives(value: SafeValue): readonly CuratorialObjective[] {
  const objectives = safeArray(value, CURATORIAL_LIMITS.maxObjectives)
    .map((item): CuratorialObjective => {
      const object = exactRecord(item, [
        "objectiveId",
        "priority",
        "sourceFamily",
        "direction",
        "weightNumerator",
        "weightDenominator",
      ]);
      const sourceFamily = enumValue(required(object, "sourceFamily"), OBJECTIVE_FAMILY_SET);
      const direction = enumValue(
        required(object, "direction"),
        new Set(["MAXIMIZE", "MINIMIZE"] as const),
      );
      return {
        objectiveId: identifier(required(object, "objectiveId")),
        priority: integer(required(object, "priority"), CURATORIAL_LIMITS.maxObjectives, 1),
        sourceFamily,
        direction,
        weightNumerator: integer(required(object, "weightNumerator"), CURATORIAL_LIMITS.maxWeightPart, 1),
        weightDenominator: integer(required(object, "weightDenominator"), CURATORIAL_LIMITS.maxWeightPart, 1),
      };
    })
    .sort((left, right) => left.priority - right.priority || compareText(left.objectiveId, right.objectiveId));
  if (new Set(objectives.map((objective) => objective.objectiveId)).size !== objectives.length) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return objectives;
}

function normalize(input: unknown): NormalizedInput {
  let detachedInput: SafeValue;
  try {
    detachedInput = detach(input);
  } catch (error) {
    if (error instanceof CuratorialSeparationError) throw error;
    return fail("CURATORIAL_INPUT_UNSAFE");
  }
  const root = exactRecord(
    detachedInput,
    [
      "scope",
      "eligibleRevisions",
      "eligibilityContext",
      "currentReviewContext",
      "pools",
      "transfers",
      "targetCount",
      "deterministicSeed",
      "constraints",
      "objectives",
    ],
    ["schema", "configuration", "purpose"],
  );
  const schema = optional(root, "schema");
  if (schema !== undefined && schema !== CURATORIAL_SELECTION_SCHEMA) return fail("CURATORIAL_SHAPE_INVALID");
  const scopeObject = exactRecord(required(root, "scope"), ["workspaceId", "eventId"]);
  const scope: CuratorialScope = {
    workspaceId: identifier(required(scopeObject, "workspaceId")),
    eventId: identifier(required(scopeObject, "eventId")),
  };
  const eligibleRevisions = normalizeEligibleRevisions(required(root, "eligibleRevisions"));
  const revisionIds = new Set(eligibleRevisions.map((revision) => revision.proposalRevisionId));
  const eligibilityContext = normalizeEligibilityContext(
    required(root, "eligibilityContext"),
    eligibleRevisions,
  );
  const currentReviewContext = normalizeReviewContext(
    required(root, "currentReviewContext"),
    revisionIds,
  );
  const pools = normalizePools(required(root, "pools"));
  const transferResult = normalizeTransfers(required(root, "transfers"), pools);
  const poolById = new Map(pools.map((pool) => [pool.poolId, pool]));
  const revisionsWithCheckedOptions = eligibleRevisions.map((revision) => {
    for (const option of revision.allocationOptions) {
      const pool = poolById.get(option.poolId);
      if (!pool || pool.poolVersionId !== option.poolVersionId || pool.unitKind !== option.unitKind) {
        return fail("CURATORIAL_CAPACITY_LEDGER_BLOCKED");
      }
    }
    return revision;
  });
  const targetCount = integer(
    required(root, "targetCount"),
    Math.min(CURATORIAL_LIMITS.maxSlateSize, eligibleRevisions.length),
    1,
  );
  const deterministicSeed = boundedText(required(root, "deterministicSeed"));
  const constraints = normalizeConstraints(required(root, "constraints"));
  const objectives = normalizeObjectives(required(root, "objectives"));
  const configurationValue = optional(root, "configuration");
  let configuration: NormalizedConfiguration = {
    maxCandidateSlates: 3,
    maxSearchNodes: CURATORIAL_LIMITS.maxSearchNodes,
  };
  if (configurationValue !== undefined) {
    const configurationObject = exactRecord(configurationValue, ["maxCandidateSlates", "maxSearchNodes"]);
    configuration = {
      maxCandidateSlates:
        optional(configurationObject, "maxCandidateSlates") === undefined
          ? 3
          : integer(optional(configurationObject, "maxCandidateSlates") as SafeValue, CURATORIAL_LIMITS.maxCandidateSlates, 1),
      maxSearchNodes:
        optional(configurationObject, "maxSearchNodes") === undefined
          ? CURATORIAL_LIMITS.maxSearchNodes
          : integer(optional(configurationObject, "maxSearchNodes") as SafeValue, CURATORIAL_LIMITS.maxSearchNodes, 1),
    };
  }
  const purpose = optional(root, "purpose");
  if (purpose !== undefined && purpose !== "PROGRAM_SELECTION_PREVIEW") return fail("CURATORIAL_PURPOSE_INVALID");
  const normalized: Omit<NormalizedInput, "inputFingerprint" | "capacityLedgerFingerprint"> = {
    scope,
    eligibleRevisions: revisionsWithCheckedOptions,
    eligibilityContext,
    currentReviewContext,
    pools,
    transfers: transferResult.transfers,
    targetCount,
    deterministicSeed,
    constraints,
    objectives,
    configuration,
    purpose: "PROGRAM_SELECTION_PREVIEW",
    balancesAfterTransfers: transferResult.balances,
  };
  const inputFingerprint = fingerprintOf({
    ...normalized,
    balancesAfterTransfers: [...transferResult.balances.entries()].sort(([left], [right]) => compareText(left, right)),
  });
  const capacityLedgerFingerprint = fingerprintOf({ pools, transfers: transferResult.transfers });
  return {
    ...normalized,
    inputFingerprint,
    capacityLedgerFingerprint,
  };
}

function blocker(
  code: CuratorialBlockerCode,
  family: CuratorialBlocker["family"],
  message: string,
  proposalRevisionId: string | null = null,
  evidenceId: string | null = null,
  evidenceFingerprint: string | null = null,
): CuratorialBlocker {
  return {
    code,
    family,
    proposalRevisionId,
    evidenceId,
    evidenceFingerprint,
    message,
  };
}

function semanticBlockers(input: NormalizedInput): readonly CuratorialBlocker[] {
  const blockers: CuratorialBlocker[] = [];
  const eligibility = input.eligibilityContext;
  const review = input.currentReviewContext;
  const statusToBlocker = (
    status: EvidenceState,
    unavailableCode: CuratorialBlockerCode,
    blockedCode: CuratorialBlockerCode,
    family: CuratorialBlocker["family"],
    message: string,
  ): void => {
    if (status === "CURRENT") return;
    blockers.push(
      blocker(
        status === "MISSING" || status === "UNAVAILABLE" ? unavailableCode : blockedCode,
        family,
        message,
      ),
    );
  };
  statusToBlocker(
    eligibility.status,
    "ELIGIBILITY_UNAVAILABLE",
    "ELIGIBILITY_BLOCKED",
    "ELIGIBILITY",
    "The eligibility snapshot is not a current exact context.",
  );
  statusToBlocker(
    review.status,
    "REVIEW_CONTEXT_UNAVAILABLE",
    "REVIEW_CONTEXT_BLOCKED",
    "REVIEW",
    "The review context is not current and cannot supply selection evidence.",
  );

  const bindings = new Map(
    eligibility.bindings.map((binding) => [binding.proposalRevisionId, binding]),
  );
  for (const revision of input.eligibleRevisions) {
    const binding = bindings.get(revision.proposalRevisionId);
    if (!binding) {
      blockers.push(
        blocker(
          "ELIGIBILITY_UNAVAILABLE",
          "ELIGIBILITY",
          "No exact eligibility binding exists for the proposal revision.",
          revision.proposalRevisionId,
        ),
      );
      continue;
    }
    if (
      binding.revisionFingerprint !== revision.revisionFingerprint ||
      !binding.eligible
    ) {
      blockers.push(
        blocker(
          "ELIGIBILITY_REVISION_MISMATCH",
          "ELIGIBILITY",
          "The current eligibility context does not bind the supplied exact proposal revision.",
          revision.proposalRevisionId,
        ),
      );
    }
    if (binding.evidenceState !== "CURRENT") {
      blockers.push(
        blocker(
          binding.evidenceState === "MISSING" || binding.evidenceState === "UNAVAILABLE"
            ? "ELIGIBILITY_UNAVAILABLE"
            : "ELIGIBILITY_BLOCKED",
          "ELIGIBILITY",
          "The eligibility evidence for this exact revision is not current.",
          revision.proposalRevisionId,
        ),
      );
    }
  }

  const evidenceByRevision = new Map<string, CuratorialReviewEvidence[]>();
  for (const evidence of review.evidence) {
    const list = evidenceByRevision.get(evidence.proposalRevisionId) ?? [];
    list.push(evidence);
    evidenceByRevision.set(evidence.proposalRevisionId, list);
    if (evidence.contextFingerprint !== review.fingerprint) {
      blockers.push(
        blocker(
          "REVIEW_EVIDENCE_CONTEXT_MISMATCH",
          "REVIEW",
          "Review evidence is bound to a different review context.",
          evidence.proposalRevisionId,
          evidence.visibility === "PUBLIC" ? evidence.evidenceId : null,
          evidence.visibility === "PUBLIC" ? evidence.fingerprint : null,
        ),
      );
    }
    if (evidence.state !== "CURRENT") {
      blockers.push(
        blocker(
          evidence.state === "MISSING" || evidence.state === "UNAVAILABLE"
            ? "REVIEW_EVIDENCE_UNAVAILABLE"
            : "REVIEW_EVIDENCE_BLOCKED",
          "REVIEW",
          "Review evidence is stale, conflicting, blocked, or unavailable.",
          evidence.proposalRevisionId,
          evidence.visibility === "PUBLIC" ? evidence.evidenceId : null,
          evidence.visibility === "PUBLIC" ? evidence.fingerprint : null,
        ),
      );
    }
  }
  for (const objective of input.objectives) {
    if (
      objective.sourceFamily === "TOPIC_BALANCE" ||
      objective.sourceFamily === "ORGANIZATION_BALANCE" ||
      objective.sourceFamily === "CAPACITY_FIT"
    ) {
      continue;
    }
    for (const revision of input.eligibleRevisions) {
      const familyEvidence = (evidenceByRevision.get(revision.proposalRevisionId) ?? []).filter(
        (evidence) => evidence.family === objective.sourceFamily && evidence.state === "CURRENT",
      );
      if (familyEvidence.length === 0) {
        blockers.push(
          blocker(
            "REVIEW_EVIDENCE_UNAVAILABLE",
            "REVIEW",
            `The explicit ${objective.sourceFamily} objective lacks current evidence for this exact revision.`,
            revision.proposalRevisionId,
          ),
        );
      }
    }
  }
  const deduplicated = new Map<string, CuratorialBlocker>();
  for (const item of blockers) {
    const key = canonical(item);
    if (!deduplicated.has(key)) deduplicated.set(key, item);
  }
  return [...deduplicated.values()]
    .sort(
      (left, right) =>
        compareText(left.code, right.code) ||
        compareText(left.proposalRevisionId ?? "", right.proposalRevisionId ?? "") ||
        compareText(left.evidenceId ?? "", right.evidenceId ?? ""),
    )
    .slice(0, CURATORIAL_LIMITS.maxBlockers);
}

interface InternalContribution {
  readonly objective: CuratorialObjective;
  readonly proposalRevisionId: string;
  readonly rawValue: Rational;
  readonly weightedValue: Rational;
  readonly evidenceFingerprints: readonly string[];
  readonly redacted: boolean;
}

interface InternalTotal {
  readonly objective: CuratorialObjective;
  readonly value: Rational;
  readonly redacted: boolean;
}

interface Candidate {
  readonly selected: readonly EligibleProposalRevision[];
  readonly allocations: ReadonlyMap<string, ProgramAllocationOption>;
  readonly constraintResults: readonly ConstraintResult[];
  readonly contributions: readonly InternalContribution[];
  readonly totals: readonly InternalTotal[];
  readonly softViolationCount: number;
  readonly canonicalKey: string;
  readonly tieBreakDigest: string;
}

interface SearchMeter {
  used: number;
  readonly maximum: number;
}

function consume(meter: SearchMeter, units = 1): void {
  meter.used += units;
  if (meter.used > meter.maximum) return fail("CURATORIAL_SEARCH_BUDGET_EXCEEDED");
}

function selectedTopics(selected: readonly EligibleProposalRevision[]): string[] {
  return selected.flatMap((revision) => revision.topics);
}

function selectedOrganizations(selected: readonly EligibleProposalRevision[]): string[] {
  return selected.map((revision) => revision.organizationId);
}

function totalUnits(allocations: ReadonlyMap<string, ProgramAllocationOption>): number {
  let total = 0;
  for (const allocation of allocations.values()) total += allocation.quantity;
  return total;
}

function evaluateConstraints(
  input: NormalizedInput,
  selected: readonly EligibleProposalRevision[],
  allocations: ReadonlyMap<string, ProgramAllocationOption>,
): readonly ConstraintResult[] {
  const topics = selectedTopics(selected);
  const organizations = selectedOrganizations(selected);
  const distinctTopics = new Set(topics).size;
  const distinctOrganizations = new Set(organizations).size;
  const units = totalUnits(allocations);
  return input.constraints.map((constraint) => {
    let measured: number;
    let limit: number;
    if (constraint.kind === "REQUIRE_TOPIC") {
      measured = topics.includes(constraint.topicId as string) ? 1 : 0;
      limit = 1;
    } else if (constraint.kind === "EXCLUDE_TOPIC") {
      measured = topics.includes(constraint.topicId as string) ? 1 : 0;
      limit = 0;
    } else if (constraint.kind === "MAX_TOPIC_COUNT") {
      measured = selected.filter((revision) => revision.topics.includes(constraint.topicId as string)).length;
      limit = constraint.limit as number;
    } else if (constraint.kind === "MIN_TOPIC_COUNT") {
      measured = selected.filter((revision) => revision.topics.includes(constraint.topicId as string)).length;
      limit = constraint.limit as number;
    } else if (constraint.kind === "MAX_ORGANIZATION_COUNT") {
      measured = organizations.filter((organization) => organization === constraint.organizationId).length;
      limit = constraint.limit as number;
    } else if (constraint.kind === "MIN_ORGANIZATION_COUNT") {
      measured = organizations.filter((organization) => organization === constraint.organizationId).length;
      limit = constraint.limit as number;
    } else if (constraint.kind === "MIN_DISTINCT_TOPICS") {
      measured = distinctTopics;
      limit = constraint.limit as number;
    } else if (constraint.kind === "MIN_DISTINCT_ORGANIZATIONS") {
      measured = distinctOrganizations;
      limit = constraint.limit as number;
    } else {
      measured = units;
      limit = constraint.limit as number;
    }
    const satisfied =
      constraint.kind === "MIN_TOPIC_COUNT" ||
      constraint.kind === "MIN_ORGANIZATION_COUNT" ||
      constraint.kind === "MIN_DISTINCT_TOPICS" ||
      constraint.kind === "MIN_DISTINCT_ORGANIZATIONS" ||
      constraint.kind === "REQUIRE_TOPIC"
        ? measured >= limit
        : measured <= limit;
    return {
      constraintId: constraint.constraintId,
      kind: constraint.kind,
      hardness: constraint.hard ? "HARD" : "SOFT",
      result: satisfied ? "SATISFIED" : "VIOLATED",
      measuredValue: String(measured),
      limitValue: String(limit),
      explanation: `The ${constraint.kind} constraint measured ${measured} against ${limit}; ${constraint.hard ? "hard" : "soft"} constraint ${satisfied ? "satisfied" : "violated"}. No evidence family is treated as an authoritative decision.`,
    };
  });
}

function evidenceFor(
  input: NormalizedInput,
  revisionId: string,
  family: CuratorialEvidenceFamily,
): readonly CuratorialReviewEvidence[] {
  return input.currentReviewContext.evidence.filter(
    (evidence) => evidence.proposalRevisionId === revisionId && evidence.family === family,
  );
}

function objectiveRawValue(
  input: NormalizedInput,
  objective: CuratorialObjective,
  revision: EligibleProposalRevision,
  allocation: ProgramAllocationOption,
  selected: readonly EligibleProposalRevision[],
): { readonly value: Rational; readonly evidence: readonly CuratorialReviewEvidence[] } {
  if (objective.sourceFamily === "INDIVIDUAL_EVALUATION") {
    const evidence = evidenceFor(
      input,
      revision.proposalRevisionId,
      "INDIVIDUAL_EVALUATION",
    );
    let value = zeroRational();
    for (const item of evidence) value = addRational(value, rational(BigInt(item.value as number)));
    return { value, evidence };
  }
  if (objective.sourceFamily === "CONFIDENTIAL_REVIEW_SCORE") {
    const evidence = evidenceFor(
      input,
      revision.proposalRevisionId,
      "CONFIDENTIAL_REVIEW_SCORE",
    );
    let value = zeroRational();
    for (const item of evidence) value = addRational(value, rational(BigInt(item.score as number)));
    return { value, evidence };
  }
  if (objective.sourceFamily === "ADVOCACY") {
    const evidence = evidenceFor(input, revision.proposalRevisionId, "ADVOCACY");
    let value = zeroRational();
    for (const item of evidence) {
      value = addRational(value, rational(BigInt(stanceValue(item.stance as EvidenceStance) * (item.strength ?? 1))));
    }
    return { value, evidence };
  }
  if (objective.sourceFamily === "CAPACITY_FIT") {
    return { value: rational(BigInt(-allocation.quantity)), evidence: [] };
  }
  if (objective.sourceFamily === "ORGANIZATION_BALANCE") {
    const prior = selected
      .slice(0, selected.findIndex((item) => item.proposalRevisionId === revision.proposalRevisionId))
      .some((item) => item.organizationId === revision.organizationId);
    return { value: rational(prior ? 0n : 1n), evidence: [] };
  }
  const priorTopics = new Set(
    selected
      .slice(0, selected.findIndex((item) => item.proposalRevisionId === revision.proposalRevisionId))
      .flatMap((item) => item.topics),
  );
  const newTopics = revision.topics.filter((topic) => !priorTopics.has(topic));
  return { value: rational(BigInt(newTopics.length)), evidence: [] };
}

function buildObjectiveValues(
  input: NormalizedInput,
  selected: readonly EligibleProposalRevision[],
  allocations: ReadonlyMap<string, ProgramAllocationOption>,
): { readonly contributions: readonly InternalContribution[]; readonly totals: readonly InternalTotal[] } {
  const contributions: InternalContribution[] = [];
  const totals: InternalTotal[] = [];
  for (const objective of input.objectives) {
    let total = zeroRational();
    let redacted = false;
    for (const revision of selected) {
      const allocation = allocations.get(revision.proposalRevisionId);
      if (!allocation) return fail("CURATORIAL_SHAPE_INVALID");
      const raw = objectiveRawValue(input, objective, revision, allocation, selected);
      const weighted = multiplyRational(
        raw.value,
        rational(BigInt(objective.weightNumerator), BigInt(objective.weightDenominator)),
      );
      total = addRational(total, weighted);
      const evidenceFingerprints = raw.evidence.map((item) => item.fingerprint).sort(compareText);
      const contributionRedacted = raw.evidence.some((item) => item.visibility !== "PUBLIC");
      redacted ||= contributionRedacted;
      contributions.push({
        objective,
        proposalRevisionId: revision.proposalRevisionId,
        rawValue: raw.value,
        weightedValue: weighted,
        evidenceFingerprints,
        redacted: contributionRedacted,
      });
    }
    totals.push({ objective, value: total, redacted });
  }
  return { contributions, totals };
}

function candidateComparator(input: NormalizedInput, left: Candidate, right: Candidate): number {
  if (left.softViolationCount !== right.softViolationCount) {
    return left.softViolationCount - right.softViolationCount;
  }
  for (let index = 0; index < input.objectives.length; index += 1) {
    const objective = input.objectives[index];
    const comparison = compareRational(left.totals[index].value, right.totals[index].value);
    if (comparison !== 0) return objective.direction === "MAXIMIZE" ? -comparison : comparison;
  }
  return compareText(left.tieBreakDigest, right.tieBreakDigest) ||
    compareText(left.canonicalKey, right.canonicalKey);
}

function candidateSubstantiveComparator(input: NormalizedInput, left: Candidate, right: Candidate): number {
  if (left.softViolationCount !== right.softViolationCount) {
    return left.softViolationCount - right.softViolationCount;
  }
  for (let index = 0; index < input.objectives.length; index += 1) {
    const objective = input.objectives[index];
    const comparison = compareRational(left.totals[index].value, right.totals[index].value);
    if (comparison !== 0) return objective.direction === "MAXIMIZE" ? -comparison : comparison;
  }
  return 0;
}

function createCandidate(
  input: NormalizedInput,
  selected: readonly EligibleProposalRevision[],
  allocations: ReadonlyMap<string, ProgramAllocationOption>,
  results: readonly ConstraintResult[],
): Candidate {
  const objectiveValues = buildObjectiveValues(input, selected, allocations);
  const selectedIds = selected.map((revision) => revision.proposalRevisionId).sort(compareText);
  const allocationList = [...allocations.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([proposalRevisionId, allocation]) => ({ proposalRevisionId, allocation }));
  const canonicalKey = canonical({ selectedProposalRevisionIds: selectedIds, allocations: allocationList });
  return {
    selected: [...selected].sort((left, right) => compareText(left.proposalRevisionId, right.proposalRevisionId)),
    allocations: new Map(allocations),
    constraintResults: results,
    contributions: objectiveValues.contributions,
    totals: objectiveValues.totals,
    softViolationCount: results.filter(
      (result) => result.hardness === "SOFT" && result.result === "VIOLATED",
    ).length,
    canonicalKey,
    tieBreakDigest: sha256(`${input.deterministicSeed}\0${canonicalKey}`),
  };
}

function enumerateAllocations(
  input: NormalizedInput,
  selected: readonly EligibleProposalRevision[],
  meter: SearchMeter,
  visit: (allocations: ReadonlyMap<string, ProgramAllocationOption>) => void,
): void {
  const ordered = [...selected].sort(
    (left, right) =>
      left.allocationOptions.length - right.allocationOptions.length ||
      compareText(left.proposalRevisionId, right.proposalRevisionId),
  );
  const used = new Map<string, number>();
  const allocations = new Map<string, ProgramAllocationOption>();
  const walk = (index: number): void => {
    consume(meter);
    if (index === ordered.length) {
      visit(new Map(allocations));
      return;
    }
    const revision = ordered[index];
    for (const option of revision.allocationOptions) {
      const next = (used.get(option.poolId) ?? 0) + option.quantity;
      const available = input.balancesAfterTransfers.get(option.poolId) ?? -1;
      if (next > available) continue;
      used.set(option.poolId, next);
      allocations.set(revision.proposalRevisionId, option);
      walk(index + 1);
      allocations.delete(revision.proposalRevisionId);
      if (next === option.quantity) used.delete(option.poolId);
      else used.set(option.poolId, next - option.quantity);
    }
  };
  walk(0);
}

function searchCandidates(input: NormalizedInput): { readonly candidates: readonly Candidate[]; readonly meter: SearchMeter } {
  const meter: SearchMeter = { used: 0, maximum: input.configuration.maxSearchNodes };
  const retained: Candidate[] = [];
  const retain = (candidate: Candidate): void => {
    if (retained.some((item) => item.canonicalKey === candidate.canonicalKey)) return;
    retained.push(candidate);
    retained.sort((left, right) => candidateComparator(input, left, right));
    if (retained.length > input.configuration.maxCandidateSlates) retained.pop();
  };
  const choose = (start: number, selected: readonly EligibleProposalRevision[]): void => {
    consume(meter);
    if (selected.length === input.targetCount) {
      let bestForSelection: Candidate | null = null;
      enumerateAllocations(input, selected, meter, (allocations) => {
        consume(meter);
        const results = evaluateConstraints(input, selected, allocations);
        if (results.some((result) => result.hardness === "HARD" && result.result === "VIOLATED")) return;
        const candidate = createCandidate(input, selected, allocations, results);
        if (!bestForSelection || candidateComparator(input, candidate, bestForSelection) < 0) {
          bestForSelection = candidate;
        }
      });
      if (bestForSelection) retain(bestForSelection);
      return;
    }
    if (selected.length + input.eligibleRevisions.length - start < input.targetCount) return;
    for (
      let index = start;
      index < input.eligibleRevisions.length;
      index += 1
    ) {
      choose(index + 1, [...selected, input.eligibleRevisions[index]]);
    }
  };
  choose(0, []);
  return { candidates: retained, meter };
}

function explainDisplacement(
  input: NormalizedInput,
  candidate: Candidate,
  excluded: EligibleProposalRevision,
  meter: SearchMeter,
): DisplacedAlternative {
  let bestSwap: Candidate | null = null;
  let replaced: string | null = null;
  let allocationAttempted = false;
  const hardFailureIds = new Set<string>();
  const failedByAllocation = new Set<string>();
  for (const included of candidate.selected) {
    consume(meter);
    const swapped = candidate.selected
      .filter((revision) => revision.proposalRevisionId !== included.proposalRevisionId)
      .concat(excluded)
      .sort((left, right) => compareText(left.proposalRevisionId, right.proposalRevisionId));
    let allocationForSwap = false;
    enumerateAllocations(input, swapped, meter, (allocations) => {
      allocationForSwap = true;
      allocationAttempted = true;
      const results = evaluateConstraints(input, swapped, allocations);
      const violations = results.filter(
        (result) => result.hardness === "HARD" && result.result === "VIOLATED",
      );
      if (violations.length > 0) {
        for (const violation of violations) hardFailureIds.add(violation.constraintId);
        return;
      }
      const swap = createCandidate(input, swapped, allocations, results);
      if (!bestSwap || candidateComparator(input, swap, bestSwap) < 0) {
        bestSwap = swap;
        replaced = included.proposalRevisionId;
      }
    });
    if (!allocationForSwap) failedByAllocation.add(included.proposalRevisionId);
  }
  if (!bestSwap) {
    if (hardFailureIds.size > 0 && failedByAllocation.size > 0) {
      return {
        displacedProposalRevisionId: excluded.proposalRevisionId,
        includedInsteadProposalRevisionId: null,
        reasonCode: "NO_CAUSAL_DISPLACEMENT",
        relatedConstraintIds: [],
        relatedObjectiveIds: [],
        explanation: "No single causal displacement is claimed because alternatives failed through both hard-constraint and capacity paths.",
      };
    }
    if (hardFailureIds.size > 0) {
      const relatedConstraintIds = [...hardFailureIds].sort(compareText);
      return {
        displacedProposalRevisionId: excluded.proposalRevisionId,
        includedInsteadProposalRevisionId: null,
        reasonCode: "HARD_CONSTRAINT",
        relatedConstraintIds,
        relatedObjectiveIds: [],
        explanation: `Every complete one-for-one alternative containing this revision violates hard constraint evidence (${relatedConstraintIds.join(", ")}).`,
      };
    }
    return {
      displacedProposalRevisionId: excluded.proposalRevisionId,
      includedInsteadProposalRevisionId: null,
      reasonCode: "CAPACITY",
      relatedConstraintIds: [],
      relatedObjectiveIds: [],
      explanation: allocationAttempted
        ? "No complete one-for-one alternative fits the frozen typed capacity balances."
        : "No complete one-for-one alternative has a conserved allocation in the frozen typed capacity pools.",
    };
  }
  const swap = bestSwap as Candidate;
  const replacement = replaced ?? fail("CURATORIAL_SHAPE_INVALID");
  const substantive = candidateSubstantiveComparator(input, candidate, swap);
  if (substantive > 0) {
    return {
      displacedProposalRevisionId: excluded.proposalRevisionId,
      includedInsteadProposalRevisionId: replacement,
      reasonCode: "NO_CAUSAL_DISPLACEMENT",
      relatedConstraintIds: [],
      relatedObjectiveIds: [],
      explanation: "The retained candidate does not outrank the feasible one-for-one alternative under the declared comparison basis; no causal displacement is claimed.",
    };
  }
  if (candidate.softViolationCount !== swap.softViolationCount) {
    return {
      displacedProposalRevisionId: excluded.proposalRevisionId,
      includedInsteadProposalRevisionId: replacement,
      reasonCode: "SOFT_CONSTRAINT",
      relatedConstraintIds: candidate.constraintResults
        .filter((result) => result.hardness === "SOFT" && result.result === "SATISFIED")
        .filter((result) => swap.constraintResults.some((other) => other.constraintId === result.constraintId && other.result === "VIOLATED"))
        .map((result) => result.constraintId)
        .sort(compareText),
      relatedObjectiveIds: [],
      explanation: "The retained whole slate has fewer declared soft-constraint violations than the feasible one-for-one alternative.",
    };
  }
  for (let index = 0; index < input.objectives.length; index += 1) {
    const objective = input.objectives[index];
    const comparison = compareRational(candidate.totals[index].value, swap.totals[index].value);
    if (comparison === 0) continue;
    const candidateWins = objective.direction === "MAXIMIZE" ? comparison > 0 : comparison < 0;
    if (!candidateWins) {
      return {
        displacedProposalRevisionId: excluded.proposalRevisionId,
        includedInsteadProposalRevisionId: null,
        reasonCode: "NO_CAUSAL_DISPLACEMENT",
        relatedConstraintIds: [],
        relatedObjectiveIds: [],
        explanation: "No causal displacement is claimed because the retained slate does not win the first decisive named objective.",
      };
    }
    return {
      displacedProposalRevisionId: excluded.proposalRevisionId,
      includedInsteadProposalRevisionId: replacement,
      reasonCode: "OBJECTIVE_ORDER",
      relatedConstraintIds: [],
      relatedObjectiveIds: [objective.objectiveId],
      explanation: `The retained whole slate wins the first decisive named objective (${objective.objectiveId}); no blended or opaque aggregate score is used.`,
    };
  }
  return {
    displacedProposalRevisionId: excluded.proposalRevisionId,
    includedInsteadProposalRevisionId: replacement,
    reasonCode: "DETERMINISTIC_TIEBREAK",
    relatedConstraintIds: [],
    relatedObjectiveIds: [],
    explanation: "The feasible alternatives are substantively tied; the declared deterministic digest and canonical fallback key decide preview ordering only.",
  };
}

function publicContributions(contributions: readonly InternalContribution[]): readonly ObjectiveContribution[] {
  return contributions.map((contribution) => ({
    objectiveId: contribution.objective.objectiveId,
    sourceFamily: contribution.objective.sourceFamily,
    proposalRevisionId: contribution.proposalRevisionId,
    value: contribution.redacted ? null : publicRational(contribution.weightedValue),
    redacted: contribution.redacted,
    evidenceFingerprints: contribution.redacted ? [] : cloneArray(contribution.evidenceFingerprints),
    explanation: contribution.redacted
      ? "This named contribution is redacted because its source evidence is blind or private; the evidence is not a decision authority."
      : `This named ${contribution.objective.objectiveId} contribution is shown independently; it is not an aggregate authority.`,
  }));
}

function publicTotals(totals: readonly InternalTotal[]): readonly ObjectiveTotal[] {
  return totals.map((total) => ({
    objectiveId: total.objective.objectiveId,
    sourceFamily: total.objective.sourceFamily,
    direction: total.objective.direction,
    value: total.redacted ? null : publicRational(total.value),
    redacted: total.redacted,
    explanation: total.redacted
      ? "This named total is redacted because one or more source contributions are blind or private; it is never authority."
      : "This named total is an explanation contribution only; no blended score or selection decision is produced.",
  }));
}

function capacityUsage(
  input: NormalizedInput,
  allocations: ReadonlyMap<string, ProgramAllocationOption>,
): readonly CapacityUsage[] {
  const used = new Map<string, number>();
  for (const allocation of allocations.values()) {
    used.set(allocation.poolId, (used.get(allocation.poolId) ?? 0) + allocation.quantity);
  }
  return input.pools.map((pool) => ({
    poolId: pool.poolId,
    poolVersionId: pool.poolVersionId,
    unitKind: pool.unitKind,
    remainingBefore: input.balancesAfterTransfers.get(pool.poolId) as number,
    used: used.get(pool.poolId) ?? 0,
    remainingAfter: (input.balancesAfterTransfers.get(pool.poolId) as number) - (used.get(pool.poolId) ?? 0),
  }));
}

function slateFromCandidate(
  input: NormalizedInput,
  candidate: Candidate,
  ordinal: number,
  meter: SearchMeter,
): CandidateSlatePreview {
  const selectedIds = new Set(candidate.selected.map((revision) => revision.proposalRevisionId));
  const displacements = input.eligibleRevisions
    .filter((revision) => !selectedIds.has(revision.proposalRevisionId))
    .map((revision) => explainDisplacement(input, candidate, revision, meter));
  const displacementById = new Map(
    displacements.map((displacement) => [displacement.displacedProposalRevisionId, displacement]),
  );
  const entries: SlateEntry[] = input.eligibleRevisions.map((revision) => {
    const selected = selectedIds.has(revision.proposalRevisionId);
    const displacement = displacementById.get(revision.proposalRevisionId);
    return {
      submissionId: revision.submissionId,
      proposalRevisionId: revision.proposalRevisionId,
      revisionFingerprint: revision.revisionFingerprint,
      disposition: selected ? "PREVIEW_SELECTED" : "PREVIEW_NOT_SELECTED",
      allocation: selected ? candidate.allocations.get(revision.proposalRevisionId) ?? null : null,
      explanation: selected
        ? "Included in a bounded candidate slate preview; this is not an organizer decision."
        : displacement?.explanation ?? "Not selected in this candidate slate preview.",
    };
  });
  const objectiveTotals = publicTotals(candidate.totals);
  const rankingBasis: SlateRankingBasis = {
    softViolationCount: candidate.softViolationCount,
    objectiveTotals,
    deterministicTieBreakDigest: candidate.tieBreakDigest,
    canonicalFallbackFingerprint: sha256(candidate.canonicalKey),
    explanation: "Whole slates compare soft constraints, then each named objective in declared priority/direction order, then a deterministic tie-break. No opaque aggregate score selects or authorizes anything.",
  };
  const content = {
    schema: "curatorial-candidate-slate/v1",
    ordinal,
    entries,
    selectedProposalRevisionIds: [...selectedIds].sort(compareText),
    constraintResults: candidate.constraintResults,
    capacityUsage: capacityUsage(input, candidate.allocations),
    displacedAlternatives: displacements,
    objectiveContributions: publicContributions(candidate.contributions),
    objectiveTotals,
    rankingBasis,
  };
  const contentFingerprint = fingerprintOf(content);
  return {
    ordinal,
    status: "CANDIDATE_PREVIEW",
    entries,
    selectedProposalRevisionIds: [...selectedIds].sort(compareText),
    constraintResults: candidate.constraintResults,
    capacityUsage: content.capacityUsage,
    displacedAlternatives: displacements.slice(0, CURATORIAL_LIMITS.maxDisplacedAlternatives),
    objectiveContributions: publicContributions(candidate.contributions),
    objectiveTotals,
    rankingBasis,
    explanationReceiptId: sha256(`explanation:${input.inputFingerprint}:${contentFingerprint}`),
    contentFingerprint,
  };
}

function redactedEvidenceCount(input: NormalizedInput): number {
  return input.currentReviewContext.evidence.filter(
    (evidence) => evidence.visibility !== "PUBLIC" || evidence.family === "CONFIDENTIAL_REVIEW_SCORE" || evidence.family === "CONFIDENTIAL_REVIEW_COMMENT",
  ).length;
}

function buildExplanationReceipt(
  input: NormalizedInput,
  previewFingerprint: string,
  status: PreviewStatus,
  blockers: readonly CuratorialBlocker[],
  explanation: string,
  receiptId?: string,
): ExplanationReceipt {
  const content = {
    schema: CURATORIAL_EXPLANATION_RECEIPT_SCHEMA,
    scope: input.scope,
    previewFingerprint,
    status,
    inputFingerprint: input.inputFingerprint,
    eligibilityContextFingerprint: input.eligibilityContext.fingerprint,
    reviewContextFingerprint: input.currentReviewContext.fingerprint,
    capacityLedgerFingerprint: input.capacityLedgerFingerprint,
    blockers,
    redactedEvidenceCount: redactedEvidenceCount(input),
    authority: "NONE" as const,
    previewOnly: true as const,
    explanation,
  };
  return {
    ...content,
    receiptId: receiptId ?? sha256(`receipt:${previewFingerprint}:${canonical(content)}`),
    fingerprint: fingerprintOf(content),
  };
}

function buildPreview(
  input: NormalizedInput,
  status: PreviewStatus,
  blockers: readonly CuratorialBlocker[],
  slates: readonly CandidateSlatePreview[],
): ProgramSelectionPreview {
  const previewContent = {
    schema: CURATORIAL_SELECTION_SCHEMA,
    scope: input.scope,
    status,
    targetCount: input.targetCount,
    inputFingerprint: input.inputFingerprint,
    eligibilityContextFingerprint: input.eligibilityContext.fingerprint,
    reviewContextFingerprint: input.currentReviewContext.fingerprint,
    capacityLedgerFingerprint: input.capacityLedgerFingerprint,
    eligibilityContextId: input.eligibilityContext.contextId,
    eligibilityContextVersionId: input.eligibilityContext.versionId,
    reviewContextId: input.currentReviewContext.contextId,
    reviewContextVersionId: input.currentReviewContext.versionId,
    capacityPools: input.pools,
    capacityTransfers: input.transfers,
    slates,
    blockers,
    redactedEvidenceCount: redactedEvidenceCount(input),
    authority: "NONE" as const,
    previewOnly: true as const,
  };
  const previewFingerprint = fingerprintOf(previewContent);
  const explanation =
    status === "READY"
      ? "Generated deterministic whole-slate candidate previews only. No selection, capacity transfer, speaker notification, or decision authority was executed."
      : status === "UNAVAILABLE"
        ? "Candidate slate preview is unavailable because an exact current evidence binding is missing or unavailable."
        : "Candidate slate preview is blocked because an exact current evidence binding is stale, conflicting, or infeasible.";
  const explanationReceipts = [
    buildExplanationReceipt(input, previewFingerprint, status, blockers, explanation),
    ...slates.map((slate) =>
      buildExplanationReceipt(
        input,
        previewFingerprint,
        "READY",
        [],
        `Slate ${slate.ordinal} is a preview explanation only.`,
        slate.explanationReceiptId,
      ),
    ),
  ];
  return deepFreeze({
    ...previewContent,
    explanationReceipts,
    fingerprint: previewFingerprint,
  });
}

/**
 * Build a deterministic, bounded, frozen candidate-slate preview. This function
 * has no action surface: it never persists, transfers, selects, approves, or
 * communicates with a speaker.
 */
export function previewProgramSelection(input: ProgramSelectionInput): ProgramSelectionPreview {
  const normalized = normalize(input);
  const blockers = semanticBlockers(normalized);
  if (blockers.length > 0) {
    const onlyUnavailable = blockers.every(
      (item) =>
        item.code === "ELIGIBILITY_UNAVAILABLE" ||
        item.code === "REVIEW_CONTEXT_UNAVAILABLE" ||
        item.code === "REVIEW_EVIDENCE_UNAVAILABLE",
    );
    return buildPreview(normalized, onlyUnavailable ? "UNAVAILABLE" : "BLOCKED", blockers, []);
  }
  const search = searchCandidates(normalized);
  if (search.candidates.length === 0) {
    const noSlateBlocker = blocker(
      "NO_FEASIBLE_SLATE",
      "SELECTION",
      "No exact-target slate satisfies every hard constraint and frozen typed capacity balance.",
    );
    return buildPreview(normalized, "BLOCKED", [noSlateBlocker], []);
  }
  const slates = search.candidates.map((candidate, index) =>
    slateFromCandidate(normalized, candidate, index, search.meter),
  );
  return buildPreview(normalized, "READY", [], slates);
}

export const buildProgramSelectionPreview = previewProgramSelection;
export const previewProgramSlate = previewProgramSelection;
export const generateProgramSlatePreviews = previewProgramSelection;
export const buildCuratorialSeparationPreview = previewProgramSelection;

interface CanonicalSourceEntry {
  readonly submissionId: string;
  readonly proposalRevisionId: string;
  readonly revisionFingerprint: string;
  readonly disposition: "PREVIEW_SELECTED" | "PREVIEW_NOT_SELECTED";
  readonly allocation: ProgramAllocationOption | null;
}

interface CanonicalSourceSlate {
  readonly ordinal: number;
  readonly contentFingerprint: string;
  readonly revisionBindings: readonly OverrideRevisionBinding[];
  readonly selectedProposalRevisionIds: readonly string[];
  readonly displacedBindings: readonly OverrideDisplacedBinding[];
}

interface CanonicalSourcePreview {
  readonly scope: CuratorialScope;
  readonly inputFingerprint: string;
  readonly fingerprint: string;
  readonly targetCount: number;
  readonly eligibilityContextFingerprint: string;
  readonly reviewContextFingerprint: string;
  readonly capacityLedgerFingerprint: string;
  readonly pools: readonly CapacityPoolSnapshot[];
  readonly balancesAfterTransfers: ReadonlyMap<string, number>;
  readonly slates: readonly CanonicalSourceSlate[];
  readonly revisionBindings: readonly OverrideRevisionBinding[];
}

type CanonicalOverrideValue = Omit<HumanOverrideProposalInput, "schema"> & {
  readonly schema: typeof CURATORIAL_OVERRIDE_PROPOSAL_SCHEMA;
  readonly overridePayloadFingerprint: string;
};

function exactCanonicalIdentifiers(value: SafeValue, maximum: number): readonly string[] {
  const values = safeArray(value, maximum).map(identifier);
  const sorted = [...values].sort(compareText);
  if (
    new Set(values).size !== values.length ||
    values.some((item, index) => item !== sorted[index])
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  return values;
}

function validateExactRational(value: SafeValue): void {
  const object = exactRecord(value, ["numerator", "denominator"]);
  const numerator = boundedText(required(object, "numerator"));
  const denominator = boundedText(required(object, "denominator"));
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(numerator) || !/^[1-9][0-9]*$/u.test(denominator)) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
}

function validateSourceConstraintResults(value: SafeValue): readonly SafeValue[] {
  const results = safeArray(value, CURATORIAL_LIMITS.maxConstraints);
  const ids: string[] = [];
  for (const item of results) {
    const object = exactRecord(item, [
      "constraintId",
      "kind",
      "hardness",
      "result",
      "measuredValue",
      "limitValue",
      "explanation",
    ]);
    ids.push(identifier(required(object, "constraintId")));
    enumValue(required(object, "kind"), CONSTRAINT_KIND_SET);
    enumValue(required(object, "hardness"), new Set(["HARD", "SOFT"] as const));
    enumValue(required(object, "result"), new Set(["SATISFIED", "VIOLATED"] as const));
    boundedText(required(object, "measuredValue"));
    const limitValue = required(object, "limitValue");
    if (limitValue !== null) boundedText(limitValue);
    boundedText(required(object, "explanation"), CURATORIAL_LIMITS.maxExplanationBytes);
  }
  if (new Set(ids).size !== ids.length) return fail("CURATORIAL_OVERRIDE_MISMATCH");
  return results;
}

function validateSourceObjectiveValues(
  contributionValue: SafeValue,
  totalValue: SafeValue,
  selectedIds: ReadonlySet<string>,
): { readonly contributions: readonly SafeValue[]; readonly totals: readonly SafeValue[] } {
  const contributions = safeArray(
    contributionValue,
    CURATORIAL_LIMITS.maxObjectives * CURATORIAL_LIMITS.maxSlateSize,
  );
  for (const item of contributions) {
    const object = exactRecord(item, [
      "objectiveId",
      "sourceFamily",
      "proposalRevisionId",
      "value",
      "redacted",
      "evidenceFingerprints",
      "explanation",
    ]);
    identifier(required(object, "objectiveId"));
    enumValue(required(object, "sourceFamily"), OBJECTIVE_FAMILY_SET);
    const proposalRevisionId = identifier(required(object, "proposalRevisionId"));
    if (!selectedIds.has(proposalRevisionId)) return fail("CURATORIAL_OVERRIDE_MISMATCH");
    const redacted = booleanValue(required(object, "redacted"));
    const rationalValue = required(object, "value");
    if (redacted ? rationalValue !== null : rationalValue === null) {
      return fail("CURATORIAL_OVERRIDE_MISMATCH");
    }
    if (rationalValue !== null) validateExactRational(rationalValue);
    const evidenceFingerprints = safeArray(
      required(object, "evidenceFingerprints"),
      CURATORIAL_LIMITS.maxEvidence,
    ).map(fingerprint);
    const sortedEvidence = [...evidenceFingerprints].sort(compareText);
    if (
      (redacted && evidenceFingerprints.length !== 0) ||
      evidenceFingerprints.some((item, index) => item !== sortedEvidence[index])
    ) {
      return fail("CURATORIAL_OVERRIDE_MISMATCH");
    }
    boundedText(required(object, "explanation"), CURATORIAL_LIMITS.maxExplanationBytes);
  }

  const totals = safeArray(totalValue, CURATORIAL_LIMITS.maxObjectives);
  const objectiveIds: string[] = [];
  for (const item of totals) {
    const object = exactRecord(item, [
      "objectiveId",
      "sourceFamily",
      "direction",
      "value",
      "redacted",
      "explanation",
    ]);
    objectiveIds.push(identifier(required(object, "objectiveId")));
    enumValue(required(object, "sourceFamily"), OBJECTIVE_FAMILY_SET);
    enumValue(required(object, "direction"), new Set(["MAXIMIZE", "MINIMIZE"] as const));
    const redacted = booleanValue(required(object, "redacted"));
    const rationalValue = required(object, "value");
    if (redacted ? rationalValue !== null : rationalValue === null) {
      return fail("CURATORIAL_OVERRIDE_MISMATCH");
    }
    if (rationalValue !== null) validateExactRational(rationalValue);
    boundedText(required(object, "explanation"), CURATORIAL_LIMITS.maxExplanationBytes);
  }
  if (new Set(objectiveIds).size !== objectiveIds.length) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  return { contributions, totals };
}

function normalizeSourceSlate(
  value: SafeValue,
  expectedOrdinal: number,
  targetCount: number,
  inputFingerprint: string,
  pools: readonly CapacityPoolSnapshot[],
  balancesAfterTransfers: ReadonlyMap<string, number>,
): CanonicalSourceSlate {
  const object = exactRecord(value, [
    "ordinal",
    "status",
    "entries",
    "selectedProposalRevisionIds",
    "constraintResults",
    "capacityUsage",
    "displacedAlternatives",
    "objectiveContributions",
    "objectiveTotals",
    "rankingBasis",
    "explanationReceiptId",
    "contentFingerprint",
  ]);
  const ordinal = integer(
    required(object, "ordinal"),
    CURATORIAL_LIMITS.maxCandidateSlates - 1,
  );
  if (ordinal !== expectedOrdinal || required(object, "status") !== "CANDIDATE_PREVIEW") {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }

  const entries: CanonicalSourceEntry[] = safeArray(
    required(object, "entries"),
    CURATORIAL_LIMITS.maxProposalRevisions,
  ).map((item) => {
    const entry = exactRecord(item, [
      "submissionId",
      "proposalRevisionId",
      "revisionFingerprint",
      "disposition",
      "allocation",
      "explanation",
    ]);
    const disposition = enumValue(
      required(entry, "disposition"),
      new Set(["PREVIEW_SELECTED", "PREVIEW_NOT_SELECTED"] as const),
    );
    const allocationValue = required(entry, "allocation");
    const allocation = allocationValue === null ? null : normalizeAllocationOption(allocationValue);
    if (
      (disposition === "PREVIEW_SELECTED" && allocation === null) ||
      (disposition === "PREVIEW_NOT_SELECTED" && allocation !== null)
    ) {
      return fail("CURATORIAL_OVERRIDE_MISMATCH");
    }
    boundedText(required(entry, "explanation"), CURATORIAL_LIMITS.maxExplanationBytes);
    return {
      submissionId: identifier(required(entry, "submissionId")),
      proposalRevisionId: identifier(required(entry, "proposalRevisionId")),
      revisionFingerprint: fingerprint(required(entry, "revisionFingerprint")),
      disposition,
      allocation,
    };
  });
  if (entries.length === 0) return fail("CURATORIAL_OVERRIDE_MISMATCH");
  const entryIds = entries.map((entry) => entry.proposalRevisionId);
  const sortedEntryIds = [...entryIds].sort(compareText);
  if (
    new Set(entryIds).size !== entryIds.length ||
    new Set(entries.map((entry) => entry.submissionId)).size !== entries.length ||
    entryIds.some((entryId, index) => entryId !== sortedEntryIds[index])
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }

  const selectedProposalRevisionIds = exactCanonicalIdentifiers(
    required(object, "selectedProposalRevisionIds"),
    CURATORIAL_LIMITS.maxSlateSize,
  );
  const selectedFromEntries = entries
    .filter((entry) => entry.disposition === "PREVIEW_SELECTED")
    .map((entry) => entry.proposalRevisionId);
  if (
    selectedProposalRevisionIds.length !== targetCount ||
    canonical(selectedProposalRevisionIds) !== canonical(selectedFromEntries)
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const selectedIds = new Set(selectedProposalRevisionIds);
  const displacedIds = entries
    .filter((entry) => entry.disposition === "PREVIEW_NOT_SELECTED")
    .map((entry) => entry.proposalRevisionId);
  const displacedAlternatives = safeArray(
    required(object, "displacedAlternatives"),
    CURATORIAL_LIMITS.maxDisplacedAlternatives,
  );
  const recordedDisplacedIds: string[] = [];
  const displacedBindings: OverrideDisplacedBinding[] = [];
  for (const item of displacedAlternatives) {
    const displacement = exactRecord(item, [
      "displacedProposalRevisionId",
      "includedInsteadProposalRevisionId",
      "reasonCode",
      "relatedConstraintIds",
      "relatedObjectiveIds",
      "explanation",
    ]);
    const displacedId = identifier(required(displacement, "displacedProposalRevisionId"));
    recordedDisplacedIds.push(displacedId);
    const includedInstead = required(displacement, "includedInsteadProposalRevisionId");
    if (
      !displacedIds.includes(displacedId) ||
      (includedInstead !== null && !selectedIds.has(identifier(includedInstead)))
    ) {
      return fail("CURATORIAL_OVERRIDE_MISMATCH");
    }
    const reasonCode = enumValue(
      required(displacement, "reasonCode"),
      new Set([
        "HARD_CONSTRAINT",
        "CAPACITY",
        "SOFT_CONSTRAINT",
        "OBJECTIVE_ORDER",
        "DETERMINISTIC_TIEBREAK",
        "NO_CAUSAL_DISPLACEMENT",
      ] as const),
    );
    const relatedConstraintIds = exactCanonicalIdentifiers(
      required(displacement, "relatedConstraintIds"),
      CURATORIAL_LIMITS.maxConstraints,
    );
    const relatedObjectiveIds = exactCanonicalIdentifiers(
      required(displacement, "relatedObjectiveIds"),
      CURATORIAL_LIMITS.maxObjectives,
    );
    boundedText(required(displacement, "explanation"), CURATORIAL_LIMITS.maxExplanationBytes);
    displacedBindings.push({
      displacedProposalRevisionId: displacedId,
      includedInsteadProposalRevisionId:
        includedInstead === null ? null : identifier(includedInstead),
      reasonCode,
      relatedConstraintIds,
      relatedObjectiveIds,
    });
  }
  if (
    new Set(recordedDisplacedIds).size !== recordedDisplacedIds.length ||
    canonical(recordedDisplacedIds) !== canonical(displacedIds)
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }

  const constraints = validateSourceConstraintResults(required(object, "constraintResults"));
  const poolById = new Map(pools.map((pool) => [pool.poolId, pool]));
  const usedByPool = new Map<string, number>();
  const allocationList: Array<{
    readonly proposalRevisionId: string;
    readonly allocation: ProgramAllocationOption;
  }> = [];
  for (const entry of entries) {
    if (!entry.allocation) continue;
    const pool = poolById.get(entry.allocation.poolId);
    if (
      !pool ||
      pool.poolVersionId !== entry.allocation.poolVersionId ||
      pool.unitKind !== entry.allocation.unitKind
    ) {
      return fail("CURATORIAL_OVERRIDE_MISMATCH");
    }
    usedByPool.set(
      pool.poolId,
      (usedByPool.get(pool.poolId) ?? 0) + entry.allocation.quantity,
    );
    allocationList.push({
      proposalRevisionId: entry.proposalRevisionId,
      allocation: entry.allocation,
    });
  }
  const capacityUsageValues = safeArray(
    required(object, "capacityUsage"),
    CURATORIAL_LIMITS.maxCapacityPools,
  );
  if (capacityUsageValues.length !== pools.length) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  capacityUsageValues.forEach((item, index) => {
    const usage = exactRecord(item, [
      "poolId",
      "poolVersionId",
      "unitKind",
      "remainingBefore",
      "used",
      "remainingAfter",
    ]);
    const pool = pools[index];
    const remainingBefore = balancesAfterTransfers.get(pool.poolId);
    const used = usedByPool.get(pool.poolId) ?? 0;
    if (
      identifier(required(usage, "poolId")) !== pool.poolId ||
      identifier(required(usage, "poolVersionId")) !== pool.poolVersionId ||
      identifier(required(usage, "unitKind")) !== pool.unitKind ||
      integer(required(usage, "remainingBefore"), CURATORIAL_LIMITS.maxCapacityQuantity) !== remainingBefore ||
      integer(required(usage, "used"), CURATORIAL_LIMITS.maxCapacityQuantity) !== used ||
      integer(required(usage, "remainingAfter"), CURATORIAL_LIMITS.maxCapacityQuantity) !==
        (remainingBefore as number) - used ||
      used > (remainingBefore as number)
    ) {
      return fail("CURATORIAL_OVERRIDE_MISMATCH");
    }
  });

  const objectiveValues = validateSourceObjectiveValues(
    required(object, "objectiveContributions"),
    required(object, "objectiveTotals"),
    selectedIds,
  );
  const ranking = exactRecord(required(object, "rankingBasis"), [
    "softViolationCount",
    "objectiveTotals",
    "deterministicTieBreakDigest",
    "canonicalFallbackFingerprint",
    "explanation",
  ]);
  integer(required(ranking, "softViolationCount"), CURATORIAL_LIMITS.maxConstraints);
  if (canonical(required(ranking, "objectiveTotals")) !== canonical(objectiveValues.totals)) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  boundedText(required(ranking, "explanation"), CURATORIAL_LIMITS.maxExplanationBytes);

  const candidateCanonicalKey = canonical({
    selectedProposalRevisionIds,
    allocations: allocationList,
  });
  fingerprint(required(ranking, "deterministicTieBreakDigest"));
  if (
    fingerprint(required(ranking, "canonicalFallbackFingerprint")) !==
    sha256(candidateCanonicalKey)
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }

  const content = {
    schema: "curatorial-candidate-slate/v1",
    ordinal,
    entries: required(object, "entries"),
    selectedProposalRevisionIds: required(object, "selectedProposalRevisionIds"),
    constraintResults: constraints,
    capacityUsage: capacityUsageValues,
    displacedAlternatives,
    objectiveContributions: objectiveValues.contributions,
    objectiveTotals: objectiveValues.totals,
    rankingBasis: required(object, "rankingBasis"),
  };
  const contentFingerprint = fingerprint(required(object, "contentFingerprint"));
  if (
    contentFingerprint !== fingerprintOf(content) ||
    identifier(required(object, "explanationReceiptId")) !==
      sha256(`explanation:${inputFingerprint}:${contentFingerprint}`)
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  return {
    ordinal,
    contentFingerprint,
    revisionBindings: entries.map((entry) => ({
      proposalRevisionId: entry.proposalRevisionId,
      revisionFingerprint: entry.revisionFingerprint,
    })),
    selectedProposalRevisionIds,
    displacedBindings: displacedBindings.sort((left, right) =>
      compareText(left.displacedProposalRevisionId, right.displacedProposalRevisionId)
    ),
  };
}

function validateSourceExplanationReceipt(
  value: SafeValue,
  expected: {
    readonly receiptId: string | null;
    readonly scope: CuratorialScope;
    readonly previewFingerprint: string;
    readonly inputFingerprint: string;
    readonly eligibilityContextFingerprint: string;
    readonly reviewContextFingerprint: string;
    readonly capacityLedgerFingerprint: string;
    readonly redactedEvidenceCount: number;
    readonly explanation: string;
  },
): void {
  const object = exactRecord(value, [
    "schema",
    "receiptId",
    "scope",
    "previewFingerprint",
    "status",
    "inputFingerprint",
    "eligibilityContextFingerprint",
    "reviewContextFingerprint",
    "capacityLedgerFingerprint",
    "blockers",
    "redactedEvidenceCount",
    "authority",
    "previewOnly",
    "explanation",
    "fingerprint",
  ]);
  const receiptScope = exactRecord(required(object, "scope"), ["workspaceId", "eventId"]);
  const blockers = safeArray(required(object, "blockers"), CURATORIAL_LIMITS.maxBlockers);
  const explanation = boundedText(
    required(object, "explanation"),
    CURATORIAL_LIMITS.maxExplanationBytes,
  );
  if (
    required(object, "schema") !== CURATORIAL_EXPLANATION_RECEIPT_SCHEMA ||
    required(object, "status") !== "READY" ||
    required(object, "authority") !== "NONE" ||
    required(object, "previewOnly") !== true ||
    blockers.length !== 0 ||
    identifier(required(receiptScope, "workspaceId")) !== expected.scope.workspaceId ||
    identifier(required(receiptScope, "eventId")) !== expected.scope.eventId ||
    fingerprint(required(object, "previewFingerprint")) !== expected.previewFingerprint ||
    fingerprint(required(object, "inputFingerprint")) !== expected.inputFingerprint ||
    fingerprint(required(object, "eligibilityContextFingerprint")) !==
      expected.eligibilityContextFingerprint ||
    fingerprint(required(object, "reviewContextFingerprint")) !== expected.reviewContextFingerprint ||
    fingerprint(required(object, "capacityLedgerFingerprint")) !== expected.capacityLedgerFingerprint ||
    integer(required(object, "redactedEvidenceCount"), CURATORIAL_LIMITS.maxEvidence) !==
      expected.redactedEvidenceCount ||
    explanation !== expected.explanation
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const content = {
    schema: CURATORIAL_EXPLANATION_RECEIPT_SCHEMA,
    scope: expected.scope,
    previewFingerprint: expected.previewFingerprint,
    status: "READY",
    inputFingerprint: expected.inputFingerprint,
    eligibilityContextFingerprint: expected.eligibilityContextFingerprint,
    reviewContextFingerprint: expected.reviewContextFingerprint,
    capacityLedgerFingerprint: expected.capacityLedgerFingerprint,
    blockers: [],
    redactedEvidenceCount: expected.redactedEvidenceCount,
    authority: "NONE",
    previewOnly: true,
    explanation,
  };
  const receiptId = identifier(required(object, "receiptId"));
  if (
    receiptId !== (expected.receiptId ?? sha256(`receipt:${expected.previewFingerprint}:${canonical(content)}`)) ||
    fingerprint(required(object, "fingerprint")) !== fingerprintOf(content)
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
}

function normalizeSourcePreview(value: SafeValue): CanonicalSourcePreview {
  const object = exactRecord(value, [
    "schema",
    "scope",
    "status",
    "targetCount",
    "inputFingerprint",
    "eligibilityContextFingerprint",
    "reviewContextFingerprint",
    "capacityLedgerFingerprint",
    "eligibilityContextId",
    "eligibilityContextVersionId",
    "reviewContextId",
    "reviewContextVersionId",
    "capacityPools",
    "capacityTransfers",
    "slates",
    "explanationReceipts",
    "blockers",
    "redactedEvidenceCount",
    "authority",
    "previewOnly",
    "fingerprint",
  ]);
  const scopeObject = exactRecord(required(object, "scope"), ["workspaceId", "eventId"]);
  const scope: CuratorialScope = {
    workspaceId: identifier(required(scopeObject, "workspaceId")),
    eventId: identifier(required(scopeObject, "eventId")),
  };
  if (
    required(object, "schema") !== CURATORIAL_SELECTION_SCHEMA ||
    required(object, "status") !== "READY" ||
    required(object, "authority") !== "NONE" ||
    required(object, "previewOnly") !== true
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const targetCount = integer(
    required(object, "targetCount"),
    CURATORIAL_LIMITS.maxSlateSize,
    1,
  );
  const inputFingerprint = fingerprint(required(object, "inputFingerprint"));
  const eligibilityContextFingerprint = fingerprint(
    required(object, "eligibilityContextFingerprint"),
  );
  const reviewContextFingerprint = fingerprint(required(object, "reviewContextFingerprint"));
  identifier(required(object, "eligibilityContextId"));
  identifier(required(object, "eligibilityContextVersionId"));
  identifier(required(object, "reviewContextId"));
  identifier(required(object, "reviewContextVersionId"));
  const poolsValue = required(object, "capacityPools");
  const pools = normalizePools(poolsValue);
  if (canonical(poolsValue) !== canonical(pools)) return fail("CURATORIAL_OVERRIDE_MISMATCH");
  const transfersValue = required(object, "capacityTransfers");
  const transferResult = normalizeTransfers(transfersValue, pools);
  if (canonical(transfersValue) !== canonical(transferResult.transfers)) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const capacityLedgerFingerprint = fingerprint(
    required(object, "capacityLedgerFingerprint"),
  );
  if (
    capacityLedgerFingerprint !== fingerprintOf({ pools, transfers: transferResult.transfers })
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }

  const slateValues = safeArray(
    required(object, "slates"),
    CURATORIAL_LIMITS.maxCandidateSlates,
  );
  if (slateValues.length === 0) return fail("CURATORIAL_OVERRIDE_MISMATCH");
  const slates = slateValues.map((slate, index) =>
    normalizeSourceSlate(
      slate,
      index,
      targetCount,
      inputFingerprint,
      pools,
      transferResult.balances,
    ),
  );
  const revisionBindings = slates[0].revisionBindings;
  if (
    slates.some(
      (slate) => canonical(slate.revisionBindings) !== canonical(revisionBindings),
    )
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const blockers = safeArray(required(object, "blockers"), CURATORIAL_LIMITS.maxBlockers);
  if (blockers.length !== 0) return fail("CURATORIAL_OVERRIDE_MISMATCH");
  const redactedEvidenceCount = integer(
    required(object, "redactedEvidenceCount"),
    CURATORIAL_LIMITS.maxEvidence,
  );
  const previewContent = {
    schema: CURATORIAL_SELECTION_SCHEMA,
    scope,
    status: "READY",
    targetCount,
    inputFingerprint,
    eligibilityContextFingerprint,
    reviewContextFingerprint,
    capacityLedgerFingerprint,
    eligibilityContextId: required(object, "eligibilityContextId"),
    eligibilityContextVersionId: required(object, "eligibilityContextVersionId"),
    reviewContextId: required(object, "reviewContextId"),
    reviewContextVersionId: required(object, "reviewContextVersionId"),
    capacityPools: pools,
    capacityTransfers: transferResult.transfers,
    slates: slateValues,
    blockers,
    redactedEvidenceCount,
    authority: "NONE",
    previewOnly: true,
  };
  const previewFingerprint = fingerprint(required(object, "fingerprint"));
  if (previewFingerprint !== fingerprintOf(previewContent)) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }

  const receipts = safeArray(
    required(object, "explanationReceipts"),
    CURATORIAL_LIMITS.maxCandidateSlates + 1,
  );
  if (receipts.length !== slates.length + 1) return fail("CURATORIAL_OVERRIDE_MISMATCH");
  const receiptContext = {
    scope,
    previewFingerprint,
    inputFingerprint,
    eligibilityContextFingerprint,
    reviewContextFingerprint,
    capacityLedgerFingerprint,
    redactedEvidenceCount,
  };
  validateSourceExplanationReceipt(receipts[0], {
    ...receiptContext,
    receiptId: null,
    explanation: "Generated deterministic whole-slate candidate previews only. No selection, capacity transfer, speaker notification, or decision authority was executed.",
  });
  slates.forEach((slate, index) => {
    const slateObject = exactRecord(slateValues[index], [
      "ordinal",
      "status",
      "entries",
      "selectedProposalRevisionIds",
      "constraintResults",
      "capacityUsage",
      "displacedAlternatives",
      "objectiveContributions",
      "objectiveTotals",
      "rankingBasis",
      "explanationReceiptId",
      "contentFingerprint",
    ]);
    validateSourceExplanationReceipt(receipts[index + 1], {
      ...receiptContext,
      receiptId: identifier(required(slateObject, "explanationReceiptId")),
      explanation: `Slate ${slate.ordinal} is a preview explanation only.`,
    });
  });
  return {
    scope,
    inputFingerprint,
    fingerprint: previewFingerprint,
    targetCount,
    eligibilityContextFingerprint,
    reviewContextFingerprint,
    capacityLedgerFingerprint,
    pools,
    balancesAfterTransfers: transferResult.balances,
    slates,
    revisionBindings,
  };
}

function validateOverrideCapacity(
  allocations: readonly OverrideAllocation[],
  source: CanonicalSourcePreview,
): void {
  const pools = new Map(source.pools.map((pool) => [pool.poolId, pool]));
  const used = new Map<string, number>();
  for (const allocation of allocations) {
    const pool = pools.get(allocation.poolId);
    if (
      !pool ||
      pool.poolVersionId !== allocation.poolVersionId ||
      pool.unitKind !== allocation.unitKind
    ) {
      return fail("CURATORIAL_OVERRIDE_MISMATCH");
    }
    const next = (used.get(pool.poolId) ?? 0) + allocation.quantity;
    if (next > (source.balancesAfterTransfers.get(pool.poolId) ?? -1)) {
      return fail("CURATORIAL_OVERRIDE_MISMATCH");
    }
    used.set(pool.poolId, next);
  }
}

const OVERRIDE_COMMAND_REQUIRED_KEYS = [
  "commandId",
  "scope",
  "sourceInputFingerprint",
  "sourcePreviewFingerprint",
  "sourceSlateOrdinal",
  "sourceSlateFingerprint",
  "sourceStatus",
  "targetCount",
  "eligibilityContextFingerprint",
  "selectionContextFingerprint",
  "capacityLedgerFingerprint",
  "exactRevisionBindings",
  "sourceSelectedProposalRevisionIds",
  "sourceDisplacedBindings",
  "proposal",
  "actor",
  "purpose",
  "retention",
  "authorityVector",
  "idempotencyKey",
  "reason",
] as const;

function detachedOverrideRoot(input: unknown): PlainRecord {
  let detachedInput: SafeValue;
  try {
    detachedInput = detach(input);
  } catch (error) {
    if (error instanceof CuratorialSeparationError) throw error;
    return fail("CURATORIAL_INPUT_UNSAFE");
  }
  const root = exactRecord(detachedInput, OVERRIDE_COMMAND_REQUIRED_KEYS, ["schema"]);
  const schema = optional(root, "schema");
  if (schema !== undefined && schema !== CURATORIAL_OVERRIDE_PROPOSAL_SCHEMA) {
    return fail("CURATORIAL_SHAPE_INVALID");
  }
  return root;
}

function normalizeOverrideDisplacedBindings(value: SafeValue): readonly OverrideDisplacedBinding[] {
  const bindings = safeArray(value, CURATORIAL_LIMITS.maxDisplacedAlternatives)
    .map((item): OverrideDisplacedBinding => {
      const object = exactRecord(item, [
        "displacedProposalRevisionId",
        "includedInsteadProposalRevisionId",
        "reasonCode",
        "relatedConstraintIds",
        "relatedObjectiveIds",
      ]);
      const includedInstead = required(object, "includedInsteadProposalRevisionId");
      return {
        displacedProposalRevisionId: identifier(
          required(object, "displacedProposalRevisionId"),
        ),
        includedInsteadProposalRevisionId:
          includedInstead === null ? null : identifier(includedInstead),
        reasonCode: enumValue(
          required(object, "reasonCode"),
          new Set([
            "HARD_CONSTRAINT",
            "CAPACITY",
            "SOFT_CONSTRAINT",
            "OBJECTIVE_ORDER",
            "DETERMINISTIC_TIEBREAK",
            "NO_CAUSAL_DISPLACEMENT",
          ] as const),
        ),
        relatedConstraintIds: exactCanonicalIdentifiers(
          required(object, "relatedConstraintIds"),
          CURATORIAL_LIMITS.maxConstraints,
        ),
        relatedObjectiveIds: exactCanonicalIdentifiers(
          required(object, "relatedObjectiveIds"),
          CURATORIAL_LIMITS.maxObjectives,
        ),
      };
    })
    .sort((left, right) =>
      compareText(left.displacedProposalRevisionId, right.displacedProposalRevisionId)
    );
  if (
    new Set(bindings.map((binding) => binding.displacedProposalRevisionId)).size !==
    bindings.length
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  return bindings;
}

function normalizeOverrideSourceRequest(root: PlainRecord): HumanOverrideSourceRequest {
  const scopeObject = exactRecord(required(root, "scope"), ["workspaceId", "eventId"]);
  return deepFreeze({
    commandId: identifier(required(root, "commandId")),
    scope: {
      workspaceId: identifier(required(scopeObject, "workspaceId")),
      eventId: identifier(required(scopeObject, "eventId")),
    },
    sourceInputFingerprint: fingerprint(required(root, "sourceInputFingerprint")),
    sourcePreviewFingerprint: fingerprint(required(root, "sourcePreviewFingerprint")),
    sourceSlateOrdinal: integer(
      required(root, "sourceSlateOrdinal"),
      CURATORIAL_LIMITS.maxCandidateSlates - 1,
    ),
    sourceSlateFingerprint: fingerprint(required(root, "sourceSlateFingerprint")),
  });
}

function normalizeOverrideInput(
  root: PlainRecord,
  sourcePreview: CanonicalSourcePreview,
): {
  readonly value: CanonicalOverrideValue;
} {
  const commandId = identifier(required(root, "commandId"));
  const scopeObject = exactRecord(required(root, "scope"), ["workspaceId", "eventId"]);
  const scope: CuratorialScope = {
    workspaceId: identifier(required(scopeObject, "workspaceId")),
    eventId: identifier(required(scopeObject, "eventId")),
  };
  if (
    sourcePreview.scope.workspaceId !== scope.workspaceId ||
    sourcePreview.scope.eventId !== scope.eventId ||
    required(root, "sourceStatus") !== "READY"
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const sourceInputFingerprint = fingerprint(required(root, "sourceInputFingerprint"));
  const sourcePreviewFingerprint = fingerprint(required(root, "sourcePreviewFingerprint"));
  const sourceSlateOrdinal = integer(
    required(root, "sourceSlateOrdinal"),
    CURATORIAL_LIMITS.maxCandidateSlates - 1,
  );
  const sourceSlate = sourcePreview.slates[sourceSlateOrdinal];
  const sourceSlateFingerprint = fingerprint(required(root, "sourceSlateFingerprint"));
  const targetCount = integer(required(root, "targetCount"), CURATORIAL_LIMITS.maxSlateSize, 1);
  const eligibilityContextFingerprint = fingerprint(
    required(root, "eligibilityContextFingerprint"),
  );
  const selectionContextFingerprint = fingerprint(required(root, "selectionContextFingerprint"));
  const capacityLedgerFingerprint = fingerprint(required(root, "capacityLedgerFingerprint"));
  if (
    !sourceSlate ||
    sourceInputFingerprint !== sourcePreview.inputFingerprint ||
    sourcePreviewFingerprint !== sourcePreview.fingerprint ||
    sourceSlateFingerprint !== sourceSlate.contentFingerprint ||
    targetCount !== sourcePreview.targetCount ||
    eligibilityContextFingerprint !== sourcePreview.eligibilityContextFingerprint ||
    selectionContextFingerprint !== sourcePreview.reviewContextFingerprint ||
    capacityLedgerFingerprint !== sourcePreview.capacityLedgerFingerprint
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }

  const exactRevisionBindings = safeArray(
    required(root, "exactRevisionBindings"),
    CURATORIAL_LIMITS.maxProposalRevisions,
  )
    .map((item): OverrideRevisionBinding => {
      const object = exactRecord(item, ["proposalRevisionId", "revisionFingerprint"]);
      return {
        proposalRevisionId: identifier(required(object, "proposalRevisionId")),
        revisionFingerprint: fingerprint(required(object, "revisionFingerprint")),
      };
    })
    .sort((left, right) => compareText(left.proposalRevisionId, right.proposalRevisionId));
  if (
    exactRevisionBindings.length === 0 ||
    new Set(exactRevisionBindings.map((binding) => binding.proposalRevisionId)).size !==
      exactRevisionBindings.length ||
    canonical(exactRevisionBindings) !== canonical(sourcePreview.revisionBindings)
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }

  const sourceSelectedProposalRevisionIds = exactCanonicalIdentifiers(
    required(root, "sourceSelectedProposalRevisionIds"),
    CURATORIAL_LIMITS.maxSlateSize,
  );
  const sourceDisplacedBindings = normalizeOverrideDisplacedBindings(
    required(root, "sourceDisplacedBindings"),
  );
  if (
    canonical(sourceSelectedProposalRevisionIds) !==
      canonical(sourceSlate.selectedProposalRevisionIds) ||
    canonical(sourceDisplacedBindings) !== canonical(sourceSlate.displacedBindings)
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }

  const proposalObject = exactRecord(required(root, "proposal"), [
    "selectedProposalRevisionIds",
    "allocations",
  ]);
  const selectedProposalRevisionIds = safeArray(
    required(proposalObject, "selectedProposalRevisionIds"),
    CURATORIAL_LIMITS.maxSlateSize,
  )
    .map(identifier)
    .sort(compareText);
  if (
    selectedProposalRevisionIds.length !== targetCount ||
    new Set(selectedProposalRevisionIds).size !== selectedProposalRevisionIds.length
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const bindingIds = new Set(exactRevisionBindings.map((binding) => binding.proposalRevisionId));
  if (selectedProposalRevisionIds.some((revisionId) => !bindingIds.has(revisionId))) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const allocations: OverrideAllocation[] = safeArray(
    required(proposalObject, "allocations"),
    CURATORIAL_LIMITS.maxSlateSize,
  )
    .map((item) => {
      const object = exactRecord(item, [
        "proposalRevisionId",
        "poolId",
        "poolVersionId",
        "unitKind",
        "quantity",
      ]);
      return {
        proposalRevisionId: identifier(required(object, "proposalRevisionId")),
        poolId: identifier(required(object, "poolId")),
        poolVersionId: identifier(required(object, "poolVersionId")),
        unitKind: identifier(required(object, "unitKind")),
        quantity: integer(
          required(object, "quantity"),
          CURATORIAL_LIMITS.maxCapacityQuantity,
          1,
        ),
      };
    })
    .sort((left, right) => compareText(left.proposalRevisionId, right.proposalRevisionId));
  if (
    allocations.length !== targetCount ||
    new Set(allocations.map((allocation) => allocation.proposalRevisionId)).size !==
      allocations.length ||
    allocations.some(
      (allocation) => !selectedProposalRevisionIds.includes(allocation.proposalRevisionId),
    )
  ) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  validateOverrideCapacity(allocations, sourcePreview);

  const actorObject = exactRecord(required(root, "actor"), [
    "actorId",
    "workspaceId",
    "eventId",
    "role",
  ]);
  const actor = {
    actorId: identifier(required(actorObject, "actorId")),
    workspaceId: identifier(required(actorObject, "workspaceId")),
    eventId: identifier(required(actorObject, "eventId")),
    role: enumValue(
      required(actorObject, "role"),
      new Set(["organizer", "workspace_admin", "event_manager", "program_manager"] as const),
    ),
  } as HumanOverrideProposalInput["actor"];
  if (actor.workspaceId !== scope.workspaceId || actor.eventId !== scope.eventId) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const retentionObject = exactRecord(required(root, "retention"), [
    "policyId",
    "policyVersion",
    "policyFingerprint",
    "disposition",
  ]);
  const retention = {
    policyId: identifier(required(retentionObject, "policyId")),
    policyVersion: identifier(required(retentionObject, "policyVersion")),
    policyFingerprint: fingerprint(required(retentionObject, "policyFingerprint")),
    disposition: required(retentionObject, "disposition"),
  } as HumanOverrideProposalInput["retention"];
  if (retention.disposition !== "RETAIN_IMMUTABLE_AUDIT") {
    return fail("CURATORIAL_RETENTION_INVALID");
  }
  const authorityObject = exactRecord(required(root, "authorityVector"), [
    "vectorId",
    "vectorVersion",
    "vectorFingerprint",
    "actorId",
    "workspaceId",
    "eventId",
    "capabilities",
    "current",
  ]);
  const capabilities = safeArray(required(authorityObject, "capabilities"), 1).map(identifier);
  const authorityVector = {
    vectorId: identifier(required(authorityObject, "vectorId")),
    vectorVersion: identifier(required(authorityObject, "vectorVersion")),
    vectorFingerprint: fingerprint(required(authorityObject, "vectorFingerprint")),
    actorId: identifier(required(authorityObject, "actorId")),
    workspaceId: identifier(required(authorityObject, "workspaceId")),
    eventId: identifier(required(authorityObject, "eventId")),
    capabilities,
    current: required(authorityObject, "current"),
  } as unknown as HumanOverrideProposalInput["authorityVector"];
  if (
    authorityVector.actorId !== actor.actorId ||
    authorityVector.workspaceId !== scope.workspaceId ||
    authorityVector.eventId !== scope.eventId ||
    authorityVector.current !== true ||
    capabilities.length !== 1 ||
    capabilities[0] !== "PROPOSE_PROGRAM_SELECTION_OVERRIDE"
  ) {
    return fail("CURATORIAL_AUTHORITY_INVALID");
  }
  const purpose = required(root, "purpose");
  if (purpose !== "PROGRAM_SELECTION_OVERRIDE_PROPOSAL") {
    return fail("CURATORIAL_PURPOSE_INVALID");
  }
  const rawIdempotencyKey = required(root, "idempotencyKey");
  if (
    typeof rawIdempotencyKey !== "string" ||
    rawIdempotencyKey.length === 0 ||
    Buffer.byteLength(rawIdempotencyKey, "utf8") > 128 ||
    CONTROL_CHARACTER_PATTERN.test(rawIdempotencyKey)
  ) {
    return fail("CURATORIAL_IDEMPOTENCY_INVALID");
  }
  const idempotencyKey = rawIdempotencyKey;
  const reason = boundedText(required(root, "reason"), CURATORIAL_LIMITS.maxExplanationBytes);
  const proposal = { selectedProposalRevisionIds, allocations };
  const overridePayloadFingerprint = fingerprintOf({
    exactRevisionBindings,
    proposal,
    reason,
  });
  const value: CanonicalOverrideValue = {
    schema: CURATORIAL_OVERRIDE_PROPOSAL_SCHEMA,
    commandId,
    scope,
    sourceInputFingerprint: sourcePreview.inputFingerprint,
    sourcePreviewFingerprint: sourcePreview.fingerprint,
    sourceSlateOrdinal,
    sourceSlateFingerprint: sourceSlate.contentFingerprint,
    sourceStatus: "READY" as const,
    targetCount: sourcePreview.targetCount,
    eligibilityContextFingerprint: sourcePreview.eligibilityContextFingerprint,
    selectionContextFingerprint: sourcePreview.reviewContextFingerprint,
    capacityLedgerFingerprint: sourcePreview.capacityLedgerFingerprint,
    exactRevisionBindings: sourcePreview.revisionBindings,
    sourceSelectedProposalRevisionIds: sourceSlate.selectedProposalRevisionIds,
    sourceDisplacedBindings: sourceSlate.displacedBindings,
    proposal,
    actor,
    purpose: "PROGRAM_SELECTION_OVERRIDE_PROPOSAL" as const,
    retention,
    authorityVector: {
      ...authorityVector,
      capabilities: ["PROPOSE_PROGRAM_SELECTION_OVERRIDE"] as [
        "PROPOSE_PROGRAM_SELECTION_OVERRIDE",
      ],
      current: true as const,
    },
    idempotencyKey,
    reason,
    overridePayloadFingerprint,
  };
  return { value };
}

function overrideRequestFingerprint(value: CanonicalOverrideValue): string {
  return fingerprintOf(value);
}

function overrideIdempotencyBinding(
  value: CanonicalOverrideValue,
  requestFingerprint: string,
): HumanOverrideIdempotencyBinding {
  return {
    commandId: value.commandId,
    idempotencyKey: value.idempotencyKey,
    actorFingerprint: fingerprintOf(value.actor),
    purposeFingerprint: fingerprintOf({ purpose: value.purpose }),
    retentionFingerprint: fingerprintOf(value.retention),
    authorityVectorFingerprint: fingerprintOf(value.authorityVector),
    sourceInputFingerprint: value.sourceInputFingerprint,
    sourcePreviewFingerprint: value.sourcePreviewFingerprint,
    eligibilityContextFingerprint: value.eligibilityContextFingerprint,
    selectionContextFingerprint: value.selectionContextFingerprint,
    capacityLedgerFingerprint: value.capacityLedgerFingerprint,
    exactRevisionBindings: value.exactRevisionBindings,
    targetSlateOrdinal: value.sourceSlateOrdinal,
    targetSlateFingerprint: value.sourceSlateFingerprint,
    targetSelectedProposalRevisionIds: value.sourceSelectedProposalRevisionIds,
    targetDisplacedBindings: value.sourceDisplacedBindings,
    overridePayloadFingerprint: value.overridePayloadFingerprint,
    requestFingerprint,
  };
}

function normalizeIdempotencyBinding(value: SafeValue): HumanOverrideIdempotencyBinding {
  const object = exactRecord(value, [
    "commandId",
    "idempotencyKey",
    "actorFingerprint",
    "purposeFingerprint",
    "retentionFingerprint",
    "authorityVectorFingerprint",
    "sourceInputFingerprint",
    "sourcePreviewFingerprint",
    "eligibilityContextFingerprint",
    "selectionContextFingerprint",
    "capacityLedgerFingerprint",
    "exactRevisionBindings",
    "targetSlateOrdinal",
    "targetSlateFingerprint",
    "targetSelectedProposalRevisionIds",
    "targetDisplacedBindings",
    "overridePayloadFingerprint",
    "requestFingerprint",
  ]);
  const exactRevisionBindings = safeArray(
    required(object, "exactRevisionBindings"),
    CURATORIAL_LIMITS.maxProposalRevisions,
  )
    .map((item): OverrideRevisionBinding => {
      const revision = exactRecord(item, ["proposalRevisionId", "revisionFingerprint"]);
      return {
        proposalRevisionId: identifier(required(revision, "proposalRevisionId")),
        revisionFingerprint: fingerprint(required(revision, "revisionFingerprint")),
      };
    })
    .sort((left, right) => compareText(left.proposalRevisionId, right.proposalRevisionId));
  if (
    exactRevisionBindings.length === 0 ||
    new Set(exactRevisionBindings.map((binding) => binding.proposalRevisionId)).size !==
      exactRevisionBindings.length
  ) {
    return fail("CURATORIAL_IDEMPOTENCY_INVALID");
  }
  return {
    commandId: identifier(required(object, "commandId")),
    idempotencyKey: boundedText(required(object, "idempotencyKey"), 128),
    actorFingerprint: fingerprint(required(object, "actorFingerprint")),
    purposeFingerprint: fingerprint(required(object, "purposeFingerprint")),
    retentionFingerprint: fingerprint(required(object, "retentionFingerprint")),
    authorityVectorFingerprint: fingerprint(required(object, "authorityVectorFingerprint")),
    sourceInputFingerprint: fingerprint(required(object, "sourceInputFingerprint")),
    sourcePreviewFingerprint: fingerprint(required(object, "sourcePreviewFingerprint")),
    eligibilityContextFingerprint: fingerprint(
      required(object, "eligibilityContextFingerprint"),
    ),
    selectionContextFingerprint: fingerprint(required(object, "selectionContextFingerprint")),
    capacityLedgerFingerprint: fingerprint(required(object, "capacityLedgerFingerprint")),
    exactRevisionBindings,
    targetSlateOrdinal: integer(
      required(object, "targetSlateOrdinal"),
      CURATORIAL_LIMITS.maxCandidateSlates - 1,
    ),
    targetSlateFingerprint: fingerprint(required(object, "targetSlateFingerprint")),
    targetSelectedProposalRevisionIds: exactCanonicalIdentifiers(
      required(object, "targetSelectedProposalRevisionIds"),
      CURATORIAL_LIMITS.maxSlateSize,
    ),
    targetDisplacedBindings: normalizeOverrideDisplacedBindings(
      required(object, "targetDisplacedBindings"),
    ),
    overridePayloadFingerprint: fingerprint(required(object, "overridePayloadFingerprint")),
    requestFingerprint: fingerprint(required(object, "requestFingerprint")),
  };
}

function validateIdempotencyResolution(
  value: HumanOverrideIdempotencyResolution | null | undefined,
  expectedBinding: HumanOverrideIdempotencyBinding,
  expectedReceipt: HumanOverrideProposalReceipt,
): Exclude<HumanOverrideIdempotencyState, "MISMATCHED"> {
  if (value === undefined || value === null) return fail("CURATORIAL_IDEMPOTENCY_INVALID");
  let detachedValue: SafeValue;
  try {
    detachedValue = detach(value);
  } catch {
    return fail("CURATORIAL_IDEMPOTENCY_INVALID");
  }
  const object = exactRecord(detachedValue, ["state", "binding", "matchedReceipt"]);
  const state = enumValue(
    required(object, "state"),
    new Set(["UNSEEN", "MATCHED", "MISMATCHED"] as const),
  );
  const binding = normalizeIdempotencyBinding(required(object, "binding"));
  if (
    canonical(binding) !== canonical(expectedBinding) ||
    state === "MISMATCHED"
  ) {
    return fail("CURATORIAL_IDEMPOTENCY_INVALID");
  }
  const matchedReceiptValue = required(object, "matchedReceipt");
  if (state === "UNSEEN") {
    if (matchedReceiptValue !== null) return fail("CURATORIAL_IDEMPOTENCY_INVALID");
    return state;
  }
  if (matchedReceiptValue === null) return fail("CURATORIAL_IDEMPOTENCY_INVALID");
  const matchedReceipt = validateReplayReceipt(matchedReceiptValue);
  if (
    canonical({ ...matchedReceipt, replayed: false }) !== canonical(expectedReceipt)
  ) {
    return fail("CURATORIAL_OVERRIDE_REPLAY");
  }
  return state;
}

function validateReplayReceipt(value: SafeValue): HumanOverrideProposalReceipt {
  const object = exactRecord(
    value,
    [
      "schema",
      "receiptId",
      "commandId",
      "scope",
      "sourceInputFingerprint",
      "sourcePreviewFingerprint",
      "sourceSlateOrdinal",
      "sourceSlateFingerprint",
      "sourceStatus",
      "targetCount",
      "eligibilityContextFingerprint",
      "selectionContextFingerprint",
      "capacityLedgerFingerprint",
      "exactRevisionBindings",
      "sourceSelectedProposalRevisionIds",
      "sourceDisplacedBindings",
      "proposal",
      "actor",
      "purpose",
      "retention",
      "authorityVector",
      "idempotencyKey",
      "reason",
      "overridePayloadFingerprint",
      "requestFingerprint",
      "replayed",
      "authority",
      "proposalOnly",
      "noCapacityMutation",
      "noSpeakerNotification",
      "fingerprint",
    ],
  );
  const suppliedFingerprint = fingerprint(required(object, "fingerprint"));
  const content: Record<string, unknown> = { ...object };
  delete content.fingerprint;
  if (
    required(object, "schema") !== CURATORIAL_OVERRIDE_PROPOSAL_SCHEMA ||
    required(object, "authority") !== "NONE" ||
    required(object, "proposalOnly") !== true ||
    required(object, "noCapacityMutation") !== true ||
    required(object, "noSpeakerNotification") !== true ||
    typeof required(object, "replayed") !== "boolean" ||
    suppliedFingerprint !== fingerprintOf({ ...content, replayed: false })
  ) {
    return fail("CURATORIAL_OVERRIDE_REPLAY");
  }
  return object as unknown as HumanOverrideProposalReceipt;
}

function buildOverrideReceipt(
  value: CanonicalOverrideValue,
  requestFingerprint: string,
): HumanOverrideProposalReceipt {
  const receiptContent = {
    receiptId: sha256(
      `override:${value.scope.workspaceId}:${value.scope.eventId}:${value.commandId}:${value.idempotencyKey}:${requestFingerprint}`,
    ),
    ...value,
    requestFingerprint,
    replayed: false as const,
    authority: "NONE" as const,
    proposalOnly: true as const,
    noCapacityMutation: true as const,
    noSpeakerNotification: true as const,
  };
  return {
    ...receiptContent,
    fingerprint: fingerprintOf(receiptContent),
  };
}

function trustedAdapterResolvers(adapter: HumanOverrideTrustedAdapter | null | undefined): {
  readonly resolveProgramSelectionInput: HumanOverrideTrustedAdapter["resolveProgramSelectionInput"];
  readonly resolveIdempotencyState: HumanOverrideTrustedAdapter["resolveIdempotencyState"];
} {
  if (adapter === null || adapter === undefined || typeof adapter !== "object") {
    return fail("CURATORIAL_TRUSTED_ADAPTER_REQUIRED");
  }
  try {
    if (utilTypes.isProxy(adapter)) return fail("CURATORIAL_TRUSTED_ADAPTER_REQUIRED");
    const resolveProgramSelectionInput = adapter.resolveProgramSelectionInput;
    const resolveIdempotencyState = adapter.resolveIdempotencyState;
    if (
      typeof resolveProgramSelectionInput !== "function" ||
      typeof resolveIdempotencyState !== "function"
    ) {
      return fail("CURATORIAL_TRUSTED_ADAPTER_REQUIRED");
    }
    return {
      resolveProgramSelectionInput: resolveProgramSelectionInput.bind(adapter),
      resolveIdempotencyState: resolveIdempotencyState.bind(adapter),
    };
  } catch {
    return fail("CURATORIAL_TRUSTED_ADAPTER_REQUIRED");
  }
}

function resolveCanonicalSourcePreview(
  resolveProgramSelectionInput: HumanOverrideTrustedAdapter["resolveProgramSelectionInput"],
  request: HumanOverrideSourceRequest,
): CanonicalSourcePreview {
  let sourceInput: ProgramSelectionInput | null;
  try {
    sourceInput = resolveProgramSelectionInput(request);
  } catch {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  if (sourceInput === null || sourceInput === undefined) {
    return fail("CURATORIAL_OVERRIDE_MISMATCH");
  }
  const recomputedPreview = previewProgramSelection(sourceInput);
  return normalizeSourcePreview(detach(recomputedPreview));
}

export function proposeHumanOverride(
  input: HumanOverrideProposalInput,
  adapter: HumanOverrideTrustedAdapter,
): HumanOverrideProposalReceipt {
  const command = detachedOverrideRoot(input);
  const sourceRequest = normalizeOverrideSourceRequest(command);
  const resolvers = trustedAdapterResolvers(adapter);
  const sourcePreview = resolveCanonicalSourcePreview(
    resolvers.resolveProgramSelectionInput,
    sourceRequest,
  );
  const normalized = normalizeOverrideInput(command, sourcePreview);
  const requestFingerprint = overrideRequestFingerprint(normalized.value);
  const binding = deepFreeze(
    overrideIdempotencyBinding(normalized.value, requestFingerprint),
  );
  const receipt = buildOverrideReceipt(normalized.value, requestFingerprint);
  let resolution: HumanOverrideIdempotencyResolution | null;
  try {
    resolution = resolvers.resolveIdempotencyState(binding);
  } catch {
    return fail("CURATORIAL_IDEMPOTENCY_INVALID");
  }
  const state = validateIdempotencyResolution(resolution, binding, receipt);
  if (state === "UNSEEN") {
    return deepFreeze(receipt);
  }
  return deepFreeze({ ...receipt, replayed: true });
}

export const buildHumanOverrideProposalReceipt = proposeHumanOverride;
export const createHumanOverrideProposalReceipt = proposeHumanOverride;
export const proposeProgramSelectionOverride = proposeHumanOverride;

export type CuratorialSelectionInput = ProgramSelectionInput;
export type ProgramSlatePreview = ProgramSelectionPreview;
export type CandidateSlate = CandidateSlatePreview;
export type HumanOverrideReceipt = HumanOverrideProposalReceipt;
