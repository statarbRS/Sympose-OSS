import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

/** Pure candidate generation only. This adapter creates no persistence or selection authority. */
export const PROGRAM_SELECTION_SOLVER_IDENTITY = "sympose-program-selection";
export const PROGRAM_SELECTION_SOLVER_VERSION = "pd01-p4-deterministic-v2";

export type SourceFamily = "EVALUATION" | "ADVOCACY" | "CAPACITY" | "PROGRAM" | "HISTORICAL";
export type ConstraintKind =
  | "REQUIRE_TAG"
  | "EXCLUDE_TAG"
  | "MAX_TAG_COUNT"
  | "MIN_TAG_COUNT"
  | "MUTUALLY_EXCLUSIVE_TAGS"
  | "MAX_TOTAL_UNITS";

export interface SolverAllocation {
  readonly poolId: string;
  readonly poolVersionId: string;
  readonly unitKind: string;
  readonly quantity: number;
}
export interface EligibleProposalRevision {
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly tags?: readonly string[];
  readonly allocationOptions: readonly SolverAllocation[];
}
export interface SolverFact { readonly submissionRevisionId: string; readonly value: number; }
export interface SolverPool {
  readonly poolId: string;
  readonly poolVersionId: string;
  readonly unitKind: string;
  readonly remaining: number;
}
export interface SolverConstraint {
  readonly id: string;
  readonly kind: ConstraintKind;
  readonly hard: boolean;
  readonly tag?: string;
  readonly tags?: readonly string[];
  readonly limit?: number;
}
export interface SolverObjective {
  readonly name: string;
  readonly sourceFamily: SourceFamily;
  readonly direction: "MAXIMIZE" | "MINIMIZE";
  readonly weightNumerator: number;
  readonly weightDenominator: number;
}
export interface SolverConfiguration {
  readonly maxEligibleRevisions?: number;
  readonly maxCandidateSlates?: number;
  readonly maxSearchNodes?: number;
  readonly objectives?: readonly SolverObjective[];
}
export interface ProgramSelectionSolverInput {
  readonly eligibleRevisions: readonly EligibleProposalRevision[];
  readonly evaluationFacts: readonly SolverFact[];
  readonly advocacyFacts: readonly SolverFact[];
  readonly capacityFacts: readonly SolverFact[];
  readonly programObjectiveFacts: readonly SolverFact[];
  readonly historicalFacts?: readonly SolverFact[];
  readonly constraints: readonly SolverConstraint[];
  readonly pools: readonly SolverPool[];
  readonly targetCount: number;
  readonly deterministicSeed: string;
  readonly configuration: SolverConfiguration;
}

export interface ExactRational { readonly numerator: string; readonly denominator: string; }
export interface ObjectiveContribution {
  readonly objectiveName: string;
  readonly sourceFamily: SourceFamily;
  readonly submissionRevisionId: string;
  readonly rawValue: ExactRational;
  readonly weight: ExactRational;
  readonly weightedValue: ExactRational;
  readonly explanation: string;
}
export interface ObjectiveTotal {
  readonly objectiveName: string;
  readonly sourceFamily: SourceFamily;
  readonly direction: "MAXIMIZE" | "MINIMIZE";
  readonly value: ExactRational;
  readonly explanation: string;
}
export interface ConstraintResult {
  readonly constraintId: string;
  readonly kind: ConstraintKind;
  readonly hardness: "HARD" | "SOFT";
  readonly result: "SATISFIED" | "VIOLATED";
  readonly measuredValue: string;
  readonly limitValue: string | null;
  readonly explanation: string;
}
export interface SlateEntry {
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly disposition: "PROPOSED_SELECTED" | "PROPOSED_NOT_SELECTED";
  readonly allocation: SolverAllocation | null;
  readonly explanation: string;
  readonly objectiveContributions: readonly ObjectiveContribution[];
}
export interface DisplacedAlternative {
  readonly displacedSubmissionRevisionId: string;
  readonly includedInsteadSubmissionRevisionId: string | null;
  readonly reasonCode: "HARD_CONSTRAINT" | "CAPACITY" | "NO_CAUSAL_DISPLACEMENT" | "SOFT_CONSTRAINT" | "OBJECTIVE_ORDER" | "DETERMINISTIC_TIEBREAK";
  readonly relatedConstraintIds: readonly string[];
  readonly relatedObjectiveNames: readonly string[];
  readonly explanation: string;
}
export interface RankingBasis {
  readonly softViolationCount: number;
  readonly objectiveTotals: readonly ObjectiveTotal[];
  readonly deterministicTieBreakDigest: string;
  readonly canonicalFallbackKey: string;
  readonly explanation: string;
}
export interface CandidateSlate {
  readonly ordinal: number;
  readonly feasible: true;
  readonly entries: readonly SlateEntry[];
  readonly constraintResults: readonly ConstraintResult[];
  readonly displacedAlternatives: readonly DisplacedAlternative[];
  readonly objectiveContributions: readonly ObjectiveContribution[];
  readonly objectiveTotals: readonly ObjectiveTotal[];
  readonly rankingBasis: RankingBasis;
  readonly contentFingerprint: string;
  readonly content: string;
}
export interface ReproducibilityManifest {
  readonly schema: "pd01-program-selection-solver-input/v1";
  readonly solverIdentity: typeof PROGRAM_SELECTION_SOLVER_IDENTITY;
  readonly solverVersion: typeof PROGRAM_SELECTION_SOLVER_VERSION;
  readonly deterministicSeed: string;
  readonly fingerprintAlgorithm: "sha256-canonical-json-v1";
  readonly configuration: Required<SolverConfiguration>;
  readonly bounds: typeof HARD_BOUNDS;
  readonly input: ProgramSelectionSolverInput;
}
export interface SolverDiagnostics {
  readonly selectionNodesVisited: number;
  readonly allocationNodesVisited: number;
  readonly allocationConstraintEvaluations: number;
  readonly candidateEvaluations: number;
  readonly hardFeasibleAllocationsFound: number;
  readonly primarySearchWorkUnits: number;
  readonly explanationWorkUnits: number;
  readonly totalWorkUnits: number;
  readonly workUnitsByCategory: Readonly<{
    readonly selection: number;
    readonly allocation: number;
    readonly allocationConstraint: number;
    readonly candidate: number;
    readonly explanation: number;
  }>;
  readonly primaryWorkUnitsByCategory: Readonly<{
    readonly selection: number;
    readonly allocation: number;
    readonly allocationConstraint: number;
    readonly candidate: number;
    readonly explanation: number;
  }>;
  readonly explanationWorkUnitsByCategory: Readonly<{
    readonly selection: number;
    readonly allocation: number;
    readonly allocationConstraint: number;
    readonly candidate: number;
    readonly explanation: number;
  }>;
  readonly feasibleSelectionsFound: number;
  readonly retainedCandidateSlates: number;
  readonly maxSearchNodes: number;
  readonly rankingSemantics: "SOFT_VIOLATIONS_THEN_NAMED_OBJECTIVES_THEN_SEEDED_DIGEST_THEN_CANONICAL_KEY";
}
export interface ProgramSelectionSolverOutput {
  readonly status: "SUCCEEDED" | "INFEASIBLE";
  readonly solverIdentity: typeof PROGRAM_SELECTION_SOLVER_IDENTITY;
  readonly solverVersion: typeof PROGRAM_SELECTION_SOLVER_VERSION;
  readonly deterministicSeed: string;
  readonly configuration: Required<SolverConfiguration>;
  readonly bounds: typeof HARD_BOUNDS;
  readonly inputManifest: ReproducibilityManifest;
  readonly fingerprintAlgorithm: "sha256-canonical-json-v1";
  readonly inputFingerprint: string;
  readonly diagnostics: SolverDiagnostics;
  readonly slates: readonly CandidateSlate[];
  readonly explanation: string;
}

export class ProgramSelectionSolverError extends Error {
  constructor(
    readonly code: "INVALID_SELECTION_SOLVER_INPUT" | "SELECTION_SOLVER_WORK_BUDGET_EXCEEDED" = "INVALID_SELECTION_SOLVER_INPUT",
    message = "The selection solver input is invalid or exceeds its safety bounds.",
    readonly diagnostics?: Partial<SolverDiagnostics>,
  ) { super(message); this.name = "ProgramSelectionSolverError"; }
}

export const HARD_BOUNDS = Object.freeze({
  maxEligibleRevisions: 20,
  maxCandidateSlates: 16,
  maxSearchNodes: 200_000,
  maxPools: 32,
  maxFactsPerFamily: 20,
  maxConstraints: 64,
  maxObjectives: 16,
  maxTagsPerRevision: 32,
  maxAllocationOptionsPerRevision: 32,
  maxConstraintTags: 16,
  maxStringLength: 256,
  maxFactValue: 1_000_000_000,
  maxWeightPart: 1_000_000,
  maxPoolBalance: 1_000_000_000,
  maxAllocationQuantity: 1_000_000_000,
} as const);

type Plain = Record<string, unknown>;
type Rat = { n: bigint; d: bigint };
type NormalizedInput = ProgramSelectionSolverInput & { configuration: Required<SolverConfiguration>; historicalFacts: readonly SolverFact[] };
type Candidate = {
  selected: readonly EligibleProposalRevision[];
  allocations: ReadonlyMap<string, SolverAllocation>;
  constraintResults: readonly ConstraintResult[];
  contributions: readonly ObjectiveContribution[];
  totals: readonly ObjectiveTotal[];
  totalRationals: readonly Rat[];
  softViolations: number;
  digest: string;
  key: string;
};

const SOURCE_FAMILIES = new Set<SourceFamily>(["EVALUATION", "ADVOCACY", "CAPACITY", "PROGRAM", "HISTORICAL"]);
const DIRECTIONS = new Set(["MAXIMIZE", "MINIMIZE"] as const);
const CONSTRAINT_KINDS = new Set<ConstraintKind>(["REQUIRE_TAG", "EXCLUDE_TAG", "MAX_TAG_COUNT", "MIN_TAG_COUNT", "MUTUALLY_EXCLUSIVE_TAGS", "MAX_TOTAL_UNITS"]);
const invalid = (): never => { throw new ProgramSelectionSolverError(); };
function isProxy(value: object): boolean {
  try { return utilTypes.isProxy(value); } catch { return invalid(); }
}
function ownDescriptor(value: object, key: PropertyKey): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return invalid();
    return descriptor;
  } catch { return invalid(); }
}

/**
 * JavaScript has no incremental reflection API that covers non-enumerable and symbol keys.
 * After proxy rejection and intrinsic/null prototype admission, `for...in` lets this implementation
 * stop after a schema-bounded number of enumerable string keys. The engine may still internally
 * collect a large ordinary object's own enumerable keys; this helper only avoids creating an
 * attacker-sized key list in application code before the counter rejects. `Reflect.ownKeys` runs
 * only after the enumerable shape passes this bound so symbols and non-enumerable keys remain
 * covered.
 */
function hasBoundedEnumerableShape(value: object, allowed: ReadonlySet<string>): boolean {
  let visited = 0;
  try {
    for (const key in value) {
      visited += 1;
      if (visited > allowed.size || !Object.prototype.hasOwnProperty.call(value, key) || !allowed.has(key)) return false;
    }
    return true;
  } catch { return false; }
}

function plain(value: unknown, keys: readonly string[]): Plain {
  if (value === null || typeof value !== "object" || isProxy(value as object) || Array.isArray(value)) invalid();
  let proto: object | null;
  try { proto = Object.getPrototypeOf(value as object); } catch { return invalid(); }
  if (proto !== Object.prototype && proto !== null) invalid();
  const allowed = new Set(keys);
  if (!hasBoundedEnumerableShape(value as object, allowed)) invalid();
  let actual: PropertyKey[];
  try {
    actual = Reflect.ownKeys(value as object);
    if (actual.length > allowed.size || actual.some(key => typeof key !== "string" || !allowed.has(key))) invalid();
    for (const key of actual) {
      const descriptor = ownDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) invalid();
    }
  } catch { return invalid(); }
  return value as Plain;
}
function required(obj: Plain, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) invalid();
  try { return obj[key]; } catch { return invalid(); }
}
function optional(obj: Plain, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  try { return obj[key]; } catch { return invalid(); }
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > HARD_BOUNDS.maxStringLength) invalid();
  return value as string;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value as number;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value as boolean; }
function array(value: unknown, maximum: number): readonly unknown[] {
  if (value === null || typeof value !== "object" || isProxy(value as object)) invalid();
  let proto: object | null;
  try { proto = Object.getPrototypeOf(value as object); } catch { return invalid(); }
  if (proto !== Array.prototype || !Array.isArray(value)) invalid();
  const lengthDescriptor = ownDescriptor(value as object, "length");
  if (!("value" in lengthDescriptor)) invalid();
  const lengthValue = lengthDescriptor.value;
  if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > maximum) invalid();
  const length = lengthValue;
  const canonicalKeys = new Set<string>(["length"]);
  for (let index = 0; index < length; index += 1) canonicalKeys.add(String(index));
  if (!hasBoundedEnumerableShape(value as object, canonicalKeys)) invalid();
  let actual: PropertyKey[];
  try { actual = Reflect.ownKeys(value as object); } catch { return invalid(); }
  if (actual.length !== canonicalKeys.size || actual.some(key => typeof key !== "string" || !canonicalKeys.has(key))) invalid();
  const detached: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownDescriptor(value as object, String(index));
    if (!("value" in descriptor) || descriptor.enumerable !== true) invalid();
    detached.push(descriptor.value);
  }
  return detached;
}
function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value !== "string" || !allowed.has(value as T)) invalid();
  return value as T;
}
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareText).map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}
function gcd(a: bigint, b: bigint): bigint { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; }
function rat(n: bigint, d: bigint): Rat { if (d <= 0n) invalid(); const g = gcd(n, d); return { n: n / g, d: d / g }; }
function add(a: Rat, b: Rat): Rat { return rat(a.n * b.d + b.n * a.d, a.d * b.d); }
function compareRat(a: Rat, b: Rat): number { const difference = a.n * b.d - b.n * a.d; return difference < 0n ? -1 : difference > 0n ? 1 : 0; }
function publicRat(value: Rat): ExactRational { return { numerator: value.n.toString(), denominator: value.d.toString() }; }

/** Digest collisions are resolved by the canonical candidate key, never by enumeration order. */
export function compareDeterministicTieKeys(leftDigest: string, leftCanonical: string, rightDigest: string, rightCanonical: string): number {
  return compareText(leftDigest, rightDigest) || compareText(leftCanonical, rightCanonical);
}

function normalize(input: unknown): NormalizedInput {
  try {
    const root = plain(input, ["eligibleRevisions", "evaluationFacts", "advocacyFacts", "capacityFacts", "programObjectiveFacts", "historicalFacts", "constraints", "pools", "targetCount", "deterministicSeed", "configuration"]);
    const configurationObject = plain(required(root, "configuration"), ["maxEligibleRevisions", "maxCandidateSlates", "maxSearchNodes", "objectives"]);
    const configuredMaxEligible = optional(configurationObject, "maxEligibleRevisions");
    const configuredMaxSlates = optional(configurationObject, "maxCandidateSlates");
    const configuredMaxNodes = optional(configurationObject, "maxSearchNodes");
    const maxEligibleRevisions = configuredMaxEligible === undefined ? HARD_BOUNDS.maxEligibleRevisions : integer(configuredMaxEligible, HARD_BOUNDS.maxEligibleRevisions, 1);
    const maxCandidateSlates = configuredMaxSlates === undefined ? 3 : integer(configuredMaxSlates, HARD_BOUNDS.maxCandidateSlates, 1);
    const maxSearchNodes = configuredMaxNodes === undefined ? HARD_BOUNDS.maxSearchNodes : integer(configuredMaxNodes, HARD_BOUNDS.maxSearchNodes, 1);

    const poolValues = array(required(root, "pools"), HARD_BOUNDS.maxPools);
    const pools = poolValues.map(value => {
      const p = plain(value, ["poolId", "poolVersionId", "unitKind", "remaining"]);
      return { poolId: text(required(p, "poolId")), poolVersionId: text(required(p, "poolVersionId")), unitKind: text(required(p, "unitKind")), remaining: integer(required(p, "remaining"), HARD_BOUNDS.maxPoolBalance) };
    }).sort((a, b) => compareText(a.poolId, b.poolId));
    if (new Set(pools.map(p => p.poolId)).size !== pools.length) invalid();
    const poolsById = new Map(pools.map(p => [p.poolId, p]));

    const revisionValues = array(required(root, "eligibleRevisions"), maxEligibleRevisions);
    const eligibleRevisions = revisionValues.map(value => {
      const r = plain(value, ["submissionId", "submissionRevisionId", "tags", "allocationOptions"]);
      const tags = array(optional(r, "tags") ?? [], HARD_BOUNDS.maxTagsPerRevision).map(text).sort(compareText);
      if (new Set(tags).size !== tags.length) invalid();
      const options = array(required(r, "allocationOptions"), HARD_BOUNDS.maxAllocationOptionsPerRevision).map(value => {
        const a = plain(value, ["poolId", "poolVersionId", "unitKind", "quantity"]);
        return { poolId: text(required(a, "poolId")), poolVersionId: text(required(a, "poolVersionId")), unitKind: text(required(a, "unitKind")), quantity: integer(required(a, "quantity"), HARD_BOUNDS.maxAllocationQuantity, 1) };
      }).sort((a, b) => compareText(canonical(a), canonical(b)));
      if (!options.length || new Set(options.map(canonical)).size !== options.length) invalid();
      for (const option of options) { const pool = poolsById.get(option.poolId); if (!pool || option.poolVersionId !== pool.poolVersionId || option.unitKind !== pool.unitKind) invalid(); }
      return { submissionId: text(required(r, "submissionId")), submissionRevisionId: text(required(r, "submissionRevisionId")), tags, allocationOptions: options };
    }).sort((a, b) => compareText(a.submissionRevisionId, b.submissionRevisionId));
    if (!eligibleRevisions.length || new Set(eligibleRevisions.map(r => r.submissionRevisionId)).size !== eligibleRevisions.length) invalid();
    if (new Set(eligibleRevisions.map(r => r.submissionId)).size !== eligibleRevisions.length) invalid();
    const revisionIds = new Set(eligibleRevisions.map(r => r.submissionRevisionId));

    const normalizeFacts = (value: unknown): readonly SolverFact[] => {
      const facts = array(value, HARD_BOUNDS.maxFactsPerFamily).map(item => {
        const f = plain(item, ["submissionRevisionId", "value"]);
        return { submissionRevisionId: text(required(f, "submissionRevisionId")), value: integer(required(f, "value"), HARD_BOUNDS.maxFactValue) };
      }).sort((a, b) => compareText(a.submissionRevisionId, b.submissionRevisionId));
      if (new Set(facts.map(f => f.submissionRevisionId)).size !== facts.length || facts.some(f => !revisionIds.has(f.submissionRevisionId))) invalid();
      return facts;
    };
    const evaluationFacts = normalizeFacts(required(root, "evaluationFacts"));
    const advocacyFacts = normalizeFacts(required(root, "advocacyFacts"));
    const capacityFacts = normalizeFacts(required(root, "capacityFacts"));
    const programObjectiveFacts = normalizeFacts(required(root, "programObjectiveFacts"));
    const historicalFacts = normalizeFacts(optional(root, "historicalFacts") ?? []);

    const objectiveValues = array(optional(configurationObject, "objectives") ?? [], HARD_BOUNDS.maxObjectives);
    const objectives = objectiveValues.map(value => {
      const o = plain(value, ["name", "sourceFamily", "direction", "weightNumerator", "weightDenominator"]);
      return {
        name: text(required(o, "name")),
        sourceFamily: enumValue(required(o, "sourceFamily"), SOURCE_FAMILIES),
        direction: enumValue(required(o, "direction"), DIRECTIONS),
        weightNumerator: integer(required(o, "weightNumerator"), HARD_BOUNDS.maxWeightPart, 1),
        weightDenominator: integer(required(o, "weightDenominator"), HARD_BOUNDS.maxWeightPart, 1),
      };
    }).sort((a, b) => compareText(a.name, b.name));
    if (new Set(objectives.map(o => o.name)).size !== objectives.length) invalid();
    const factFamilies: Record<SourceFamily, readonly SolverFact[]> = { EVALUATION: evaluationFacts, ADVOCACY: advocacyFacts, CAPACITY: capacityFacts, PROGRAM: programObjectiveFacts, HISTORICAL: historicalFacts };
    for (const objective of objectives) if (factFamilies[objective.sourceFamily].length !== eligibleRevisions.length) invalid();

    const constraintValues = array(required(root, "constraints"), HARD_BOUNDS.maxConstraints);
    const constraints = constraintValues.map(value => {
      const c = plain(value, ["id", "kind", "hard", "tag", "tags", "limit"]);
      const kind = enumValue(required(c, "kind"), CONSTRAINT_KINDS);
      const normalized: SolverConstraint = { id: text(required(c, "id")), kind, hard: bool(required(c, "hard")) };
      if (kind === "REQUIRE_TAG" || kind === "EXCLUDE_TAG") { plain(value, ["id", "kind", "hard", "tag"]); return { ...normalized, tag: text(required(c, "tag")) }; }
      if (kind === "MAX_TAG_COUNT" || kind === "MIN_TAG_COUNT") { plain(value, ["id", "kind", "hard", "tag", "limit"]); return { ...normalized, tag: text(required(c, "tag")), limit: integer(required(c, "limit")) }; }
      if (kind === "MUTUALLY_EXCLUSIVE_TAGS") {
        plain(value, ["id", "kind", "hard", "tags"]);
        const tags = array(required(c, "tags"), HARD_BOUNDS.maxConstraintTags).map(text).sort(compareText);
        if (tags.length < 2 || new Set(tags).size !== tags.length) invalid();
        return { ...normalized, tags };
      }
      plain(value, ["id", "kind", "hard", "limit"]); return { ...normalized, limit: integer(required(c, "limit")) };
    }).sort((a, b) => compareText(a.id, b.id));
    if (new Set(constraints.map(c => c.id)).size !== constraints.length) invalid();

    const targetCount = integer(required(root, "targetCount"), eligibleRevisions.length, 1);
    const deterministicSeed = text(required(root, "deterministicSeed"));
    return { eligibleRevisions, evaluationFacts, advocacyFacts, capacityFacts, programObjectiveFacts, historicalFacts, constraints, pools, targetCount, deterministicSeed, configuration: { maxEligibleRevisions, maxCandidateSlates, maxSearchNodes, objectives } };
  } catch (error) {
    if (error instanceof ProgramSelectionSolverError) throw error;
    throw new ProgramSelectionSolverError();
  }
}

function constraintResults(input: NormalizedInput, selected: readonly EligibleProposalRevision[], allocations: ReadonlyMap<string, SolverAllocation>, meter?: () => void): readonly ConstraintResult[] {
  const tags = selected.flatMap(r => r.tags ?? []);
  const units = [...allocations.values()].reduce((sum, allocation) => sum + allocation.quantity, 0);
  return input.constraints.map(constraint => {
    meter?.();
    let measured: number, limit: number, satisfied: boolean;
    if (constraint.kind === "REQUIRE_TAG") { measured = tags.filter(tag => tag === constraint.tag).length; limit = 1; satisfied = measured >= limit; }
    else if (constraint.kind === "EXCLUDE_TAG") { measured = tags.filter(tag => tag === constraint.tag).length; limit = 0; satisfied = measured === limit; }
    else if (constraint.kind === "MAX_TAG_COUNT") { measured = tags.filter(tag => tag === constraint.tag).length; limit = constraint.limit!; satisfied = measured <= limit; }
    else if (constraint.kind === "MIN_TAG_COUNT") { measured = tags.filter(tag => tag === constraint.tag).length; limit = constraint.limit!; satisfied = measured >= limit; }
    else if (constraint.kind === "MUTUALLY_EXCLUSIVE_TAGS") { measured = constraint.tags!.filter(tag => tags.includes(tag)).length; limit = 1; satisfied = measured <= limit; }
    else { measured = units; limit = constraint.limit!; satisfied = measured <= limit; }
    return {
      constraintId: constraint.id, kind: constraint.kind, hardness: constraint.hard ? "HARD" as const : "SOFT" as const,
      result: satisfied ? "SATISFIED" as const : "VIOLATED" as const, measuredValue: String(measured), limitValue: String(limit),
      explanation: `${constraint.kind} measured ${measured} against limit ${limit}; ${constraint.hard ? "hard" : "soft"} constraint ${satisfied ? "satisfied" : "violated"}.`,
    };
  });
}

function solveNormalized(input: NormalizedInput): ProgramSelectionSolverOutput {
  const pools = new Map(input.pools.map(pool => [pool.poolId, pool]));
  const facts: Record<SourceFamily, ReadonlyMap<string, number>> = {
    EVALUATION: new Map(input.evaluationFacts.map(f => [f.submissionRevisionId, f.value])),
    ADVOCACY: new Map(input.advocacyFacts.map(f => [f.submissionRevisionId, f.value])),
    CAPACITY: new Map(input.capacityFacts.map(f => [f.submissionRevisionId, f.value])),
    PROGRAM: new Map(input.programObjectiveFacts.map(f => [f.submissionRevisionId, f.value])),
    HISTORICAL: new Map(input.historicalFacts.map(f => [f.submissionRevisionId, f.value])),
  };
  let selectionNodes = 0, allocationNodes = 0, allocationConstraintEvaluations = 0, candidateEvaluations = 0, hardFeasibleAllocationsFound = 0, explanationWorkUnits = 0, totalWorkUnits = 0, primarySearchWorkUnits = 0, feasibleSelections = 0, inExplanation = false;
  const workUnitsByCategory = { selection: 0, allocation: 0, allocationConstraint: 0, candidate: 0, explanation: 0 };
  const primaryWorkUnitsByCategory = { selection: 0, allocation: 0, allocationConstraint: 0, candidate: 0, explanation: 0 };
  const explanationWorkUnitsByCategory = { selection: 0, allocation: 0, allocationConstraint: 0, candidate: 0, explanation: 0 };
  const diagnosticsSnapshot = (): Partial<SolverDiagnostics> => ({ selectionNodesVisited: selectionNodes, allocationNodesVisited: allocationNodes, allocationConstraintEvaluations, candidateEvaluations, hardFeasibleAllocationsFound, primarySearchWorkUnits, explanationWorkUnits, totalWorkUnits, workUnitsByCategory: { ...workUnitsByCategory }, primaryWorkUnitsByCategory: { ...primaryWorkUnitsByCategory }, explanationWorkUnitsByCategory: { ...explanationWorkUnitsByCategory }, feasibleSelectionsFound: feasibleSelections, retainedCandidateSlates: retained.length, maxSearchNodes: input.configuration.maxSearchNodes, rankingSemantics: "SOFT_VIOLATIONS_THEN_NAMED_OBJECTIVES_THEN_SEEDED_DIGEST_THEN_CANONICAL_KEY" });
  const consumeWork = (kind: "selection" | "allocation" | "allocationConstraint" | "candidate" | "explanation") => {
    totalWorkUnits++;
    workUnitsByCategory[kind]++;
    if (kind === "selection") selectionNodes++;
    else if (kind === "allocation") allocationNodes++;
    else if (kind === "allocationConstraint") allocationConstraintEvaluations++;
    else if (kind === "candidate") candidateEvaluations++;
    if (inExplanation) { explanationWorkUnits++; explanationWorkUnitsByCategory[kind]++; }
    else { primarySearchWorkUnits = totalWorkUnits; primaryWorkUnitsByCategory[kind]++; }
    if (totalWorkUnits > input.configuration.maxSearchNodes) throw new ProgramSelectionSolverError("SELECTION_SOLVER_WORK_BUDGET_EXCEEDED", "The deterministic solver work budget was exceeded before all candidate or explanation work completed.", diagnosticsSnapshot());
  };
  const allocate = (selected: readonly EligibleProposalRevision[], onComplete: (allocations: ReadonlyMap<string, SolverAllocation>) => void): void => {
    const ordered = [...selected].sort((a, b) => a.allocationOptions.length - b.allocationOptions.length || compareText(a.submissionRevisionId, b.submissionRevisionId));
    const used = new Map<string, number>(), assignments = new Map<string, SolverAllocation>();
    const visit = (index: number): void => {
      consumeWork("allocation");
      if (index === ordered.length) {
        onComplete(new Map(assignments));
        return;
      }
      const revision = ordered[index];
      for (const option of revision.allocationOptions) {
        const next = (used.get(option.poolId) ?? 0) + option.quantity;
        if (next > pools.get(option.poolId)!.remaining) continue;
        used.set(option.poolId, next); assignments.set(revision.submissionRevisionId, option);
        visit(index + 1);
        assignments.delete(revision.submissionRevisionId);
        const prior = next - option.quantity; if (prior) used.set(option.poolId, prior); else used.delete(option.poolId);
      }
    };
    visit(0);
  };
  const makeCandidate = (selected: readonly EligibleProposalRevision[], allocations: ReadonlyMap<string, SolverAllocation>): Candidate | null => {
    consumeWork("candidate");
    const results = constraintResults(input, selected, allocations, () => consumeWork("candidate"));
    if (results.some(result => result.hardness === "HARD" && result.result === "VIOLATED")) return null;
    const contributions: ObjectiveContribution[] = [];
    const totals: ObjectiveTotal[] = [];
    const totalRationals: Rat[] = [];
    for (const objective of input.configuration.objectives) {
      let total = rat(0n, 1n);
      for (const revision of selected) {
        consumeWork("candidate");
        const raw = facts[objective.sourceFamily].get(revision.submissionRevisionId)!;
        const weighted = rat(BigInt(raw) * BigInt(objective.weightNumerator), BigInt(objective.weightDenominator));
        total = add(total, weighted);
        contributions.push({ objectiveName: objective.name, sourceFamily: objective.sourceFamily, submissionRevisionId: revision.submissionRevisionId, rawValue: publicRat(rat(BigInt(raw), 1n)), weight: publicRat(rat(BigInt(objective.weightNumerator), BigInt(objective.weightDenominator))), weightedValue: publicRat(weighted), explanation: `${objective.sourceFamily} fact for exact revision ${revision.submissionRevisionId} contributes only to ${objective.name}.` });
      }
      totalRationals.push(total);
      totals.push({ objectiveName: objective.name, sourceFamily: objective.sourceFamily, direction: objective.direction, value: publicRat(total), explanation: `Exact rational sum of ${objective.name} contributions; this named total is not selection authority.` });
    }
    const allocationList = [...allocations.entries()].sort(([a], [b]) => compareText(a, b)).map(([submissionRevisionId, allocation]) => ({ submissionRevisionId, allocation }));
    const selectedIds = selected.map(r => r.submissionRevisionId).sort(compareText);
    const key = canonical({ selectedSubmissionRevisionIds: selectedIds, allocations: allocationList });
    return { selected: [...selected].sort((a, b) => compareText(a.submissionRevisionId, b.submissionRevisionId)), allocations, constraintResults: results, contributions, totals, totalRationals, softViolations: results.filter(result => result.hardness === "SOFT" && result.result === "VIOLATED").length, digest: sha256(`${input.deterministicSeed}\0${key}`), key };
  };
  const compareSubstantive = (a: Candidate, b: Candidate): number => {
    if (a.softViolations !== b.softViolations) return a.softViolations - b.softViolations;
    for (let i = 0; i < input.configuration.objectives.length; i++) {
      const comparison = compareRat(a.totalRationals[i], b.totalRationals[i]);
      if (comparison) return input.configuration.objectives[i].direction === "MAXIMIZE" ? -comparison : comparison;
    }
    return 0;
  };
  const compareCandidate = (a: Candidate, b: Candidate): number => compareSubstantive(a, b) || compareDeterministicTieKeys(a.digest, a.key, b.digest, b.key);
  const retained: Candidate[] = [];
  const retain = (candidate: Candidate) => { retained.push(candidate); retained.sort(compareCandidate); if (retained.length > input.configuration.maxCandidateSlates) retained.pop(); };
  const choose = (start: number, chosen: readonly EligibleProposalRevision[]) => {
    consumeWork("selection");
    if (chosen.length === input.targetCount) {
      let bestForSelection: Candidate | null = null;
      allocate(chosen, candidateAllocations => {
        consumeWork("allocationConstraint");
        const results = constraintResults(input, chosen, candidateAllocations, () => consumeWork("candidate"));
        if (results.some(result => result.hardness === "HARD" && result.result === "VIOLATED")) return;
        hardFeasibleAllocationsFound++;
        const candidate = makeCandidate(chosen, candidateAllocations);
        if (candidate && (!bestForSelection || compareCandidate(candidate, bestForSelection) < 0)) bestForSelection = candidate;
      });
      if (!bestForSelection) return;
      feasibleSelections++; retain(bestForSelection); return;
    }
    if (chosen.length + input.eligibleRevisions.length - start < input.targetCount) return;
    for (let index = start; index < input.eligibleRevisions.length; index++) choose(index + 1, [...chosen, input.eligibleRevisions[index]]);
  };
  choose(0, []);
  primarySearchWorkUnits = totalWorkUnits;

  const configuration = input.configuration;
  const manifestInput: ProgramSelectionSolverInput = { eligibleRevisions: input.eligibleRevisions, evaluationFacts: input.evaluationFacts, advocacyFacts: input.advocacyFacts, capacityFacts: input.capacityFacts, programObjectiveFacts: input.programObjectiveFacts, historicalFacts: input.historicalFacts, constraints: input.constraints, pools: input.pools, targetCount: input.targetCount, deterministicSeed: input.deterministicSeed, configuration };
  const inputManifest: ReproducibilityManifest = { schema: "pd01-program-selection-solver-input/v1", solverIdentity: PROGRAM_SELECTION_SOLVER_IDENTITY, solverVersion: PROGRAM_SELECTION_SOLVER_VERSION, deterministicSeed: input.deterministicSeed, fingerprintAlgorithm: "sha256-canonical-json-v1", configuration, bounds: HARD_BOUNDS, input: manifestInput };
  const inputFingerprint = sha256(canonical(inputManifest));
  if (!retained.length) return deepFreeze({ status: "INFEASIBLE" as const, solverIdentity: PROGRAM_SELECTION_SOLVER_IDENTITY, solverVersion: PROGRAM_SELECTION_SOLVER_VERSION, deterministicSeed: input.deterministicSeed, configuration, bounds: HARD_BOUNDS, inputManifest, fingerprintAlgorithm: "sha256-canonical-json-v1" as const, inputFingerprint, diagnostics: diagnosticsSnapshot() as SolverDiagnostics, slates: [], explanation: "No exact-target slate satisfies every hard constraint and frozen pool balance." });

  const explainDisplacement = (candidate: Candidate, excluded: EligibleProposalRevision): DisplacedAlternative => {
    consumeWork("explanation");
    let bestSwap: Candidate | null = null;
    const hardFailureSets: Set<string>[] = [];
    let allocationBlocked = false;
    for (const included of candidate.selected) {
      consumeWork("explanation");
      const swapped = candidate.selected.filter(r => r.submissionRevisionId !== included.submissionRevisionId).concat(excluded).sort((a, b) => compareText(a.submissionRevisionId, b.submissionRevisionId));
      let swapAllocationFound = false;
      allocate(swapped, candidateAllocations => {
        swapAllocationFound = true;
        consumeWork("allocationConstraint");
        const results = constraintResults(input, swapped, candidateAllocations, () => consumeWork("candidate"));
        const violations = results.filter(result => result.hardness === "HARD" && result.result === "VIOLATED");
        if (violations.length) { hardFailureSets.push(new Set(violations.map(result => result.constraintId))); return; }
        hardFeasibleAllocationsFound++;
        const swap = makeCandidate(swapped, candidateAllocations);
        if (swap && (!bestSwap || compareCandidate(swap, bestSwap) < 0)) bestSwap = swap;
      });
      if (!swapAllocationFound) allocationBlocked = true;
    }
    if (!bestSwap) {
      if (hardFailureSets.length && allocationBlocked) return { displacedSubmissionRevisionId: excluded.submissionRevisionId, includedInsteadSubmissionRevisionId: null, reasonCode: "NO_CAUSAL_DISPLACEMENT", relatedConstraintIds: [], relatedObjectiveNames: [], explanation: `No causal displacement is claimed: one-for-one alternatives for ${excluded.submissionRevisionId} failed through mixed hard-constraint and allocation/capacity paths, so neither cause is attributed.` };
      if (hardFailureSets.length) {
        const sharedHard = hardFailureSets.slice(1).reduce((shared, failures) => new Set([...shared].filter(id => failures.has(id))), new Set(hardFailureSets[0]));
        if (sharedHard.size) return { displacedSubmissionRevisionId: excluded.submissionRevisionId, includedInsteadSubmissionRevisionId: null, reasonCode: "HARD_CONSTRAINT", relatedConstraintIds: [...sharedHard].sort(compareText), relatedObjectiveNames: [], explanation: `Every complete allocation for one-for-one alternatives containing ${excluded.submissionRevisionId} violates the shared hard constraint(s) ${[...sharedHard].sort(compareText).join(", ")}; no replacement is fabricated.` };
        return { displacedSubmissionRevisionId: excluded.submissionRevisionId, includedInsteadSubmissionRevisionId: null, reasonCode: "NO_CAUSAL_DISPLACEMENT", relatedConstraintIds: [], relatedObjectiveNames: [], explanation: `No causal displacement is claimed: complete allocations failed distinct hard constraints, so no single hard cause is attributed.` };
      }
      return { displacedSubmissionRevisionId: excluded.submissionRevisionId, includedInsteadSubmissionRevisionId: null, reasonCode: "CAPACITY", relatedConstraintIds: [], relatedObjectiveNames: [], explanation: `${excluded.submissionRevisionId} has no feasible one-for-one allocation within the exact frozen pool versions and balances${allocationBlocked ? "" : "; no replacement is claimed"}.` };
    }
    const selectedSwap = bestSwap as Candidate;
    const replacement = candidate.selected.find(r => !selectedSwap.selected.some(s => s.submissionRevisionId === r.submissionRevisionId))!;
    const noCausalDisplacement = (): DisplacedAlternative => ({ displacedSubmissionRevisionId: excluded.submissionRevisionId, includedInsteadSubmissionRevisionId: null, reasonCode: "NO_CAUSAL_DISPLACEMENT", relatedConstraintIds: [], relatedObjectiveNames: [], explanation: `No causal displacement is claimed: the retained candidate does not outrank the feasible one-for-one alternative replacing ${replacement.submissionRevisionId} with ${excluded.submissionRevisionId} under the declared comparator.` });
    if (candidate.softViolations !== selectedSwap.softViolations) {
      if (candidate.softViolations > selectedSwap.softViolations) return noCausalDisplacement();
      const decisiveSoft = candidate.constraintResults.find(result => {
        if (result.hardness !== "SOFT" || result.result !== "SATISFIED") return false;
        return selectedSwap.constraintResults.some(other => other.constraintId === result.constraintId && other.hardness === "SOFT" && other.result === "VIOLATED");
      });
      if (!decisiveSoft) return noCausalDisplacement();
      return { displacedSubmissionRevisionId: excluded.submissionRevisionId, includedInsteadSubmissionRevisionId: replacement.submissionRevisionId, reasonCode: "SOFT_CONSTRAINT", relatedConstraintIds: [decisiveSoft.constraintId], relatedObjectiveNames: [], explanation: `The included candidate has fewer soft violations, with ${decisiveSoft.constraintId} the first decisive soft improvement over the feasible one-for-one alternative.` };
    }
    for (let index = 0; index < input.configuration.objectives.length; index++) {
      const objective = input.configuration.objectives[index];
      const comparison = compareRat(candidate.totalRationals[index], selectedSwap.totalRationals[index]);
      if (!comparison) continue;
      const candidateWins = objective.direction === "MAXIMIZE" ? comparison > 0 : comparison < 0;
      if (!candidateWins) return noCausalDisplacement();
      return { displacedSubmissionRevisionId: excluded.submissionRevisionId, includedInsteadSubmissionRevisionId: replacement.submissionRevisionId, reasonCode: "OBJECTIVE_ORDER", relatedConstraintIds: [], relatedObjectiveNames: [objective.name], explanation: `The included candidate is better on ${objective.name}, the first lexicographically decisive named objective over the feasible one-for-one alternative.` };
    }
    const tieComparison = compareDeterministicTieKeys(candidate.digest, candidate.key, selectedSwap.digest, selectedSwap.key);
    if (tieComparison >= 0) return noCausalDisplacement();
    return { displacedSubmissionRevisionId: excluded.submissionRevisionId, includedInsteadSubmissionRevisionId: replacement.submissionRevisionId, reasonCode: "DETERMINISTIC_TIEBREAK", relatedConstraintIds: [], relatedObjectiveNames: [], explanation: `The feasible one-for-one alternative is substantively tied; the included candidate wins the seeded digest/canonical-key tie-break.` };
  };

  inExplanation = true;
  const slates = retained.map((candidate, ordinal): CandidateSlate => {
    const selectedIds = new Set(candidate.selected.map(r => r.submissionRevisionId));
    const displacements = input.eligibleRevisions.filter(r => !selectedIds.has(r.submissionRevisionId)).map(r => explainDisplacement(candidate, r));
    const displacementById = new Map(displacements.map(d => [d.displacedSubmissionRevisionId, d]));
    const entries: SlateEntry[] = input.eligibleRevisions.map(revision => {
      const selected = selectedIds.has(revision.submissionRevisionId);
      const displacement = displacementById.get(revision.submissionRevisionId);
      return { submissionId: revision.submissionId, submissionRevisionId: revision.submissionRevisionId, disposition: selected ? "PROPOSED_SELECTED" : "PROPOSED_NOT_SELECTED", allocation: selected ? candidate.allocations.get(revision.submissionRevisionId)! : null, explanation: selected ? "Included in this feasible candidate slate; this is not an authoritative decision." : displacement!.explanation, objectiveContributions: selected ? candidate.contributions.filter(contribution => contribution.submissionRevisionId === revision.submissionRevisionId) : [] };
    });
    const rankingBasis: RankingBasis = { softViolationCount: candidate.softViolations, objectiveTotals: candidate.totals, deterministicTieBreakDigest: candidate.digest, canonicalFallbackKey: candidate.key, explanation: "Candidates compare fewer soft violations first, then each named objective independently in canonical name order and declared direction, then seeded digest and canonical collision fallback. No blended score or authority claim is produced." };
    const contentValue = { schema: "pd01-program-candidate-slate/v1", ordinal, entries, constraintResults: candidate.constraintResults, displacedAlternatives: displacements, objectiveContributions: candidate.contributions, objectiveTotals: candidate.totals, rankingBasis };
    const content = canonical(contentValue);
    return { ordinal, feasible: true, entries, constraintResults: candidate.constraintResults, displacedAlternatives: displacements, objectiveContributions: candidate.contributions, objectiveTotals: candidate.totals, rankingBasis, contentFingerprint: sha256(content), content };
  });
  const diagnostics = diagnosticsSnapshot() as SolverDiagnostics;
  return deepFreeze({ status: "SUCCEEDED" as const, solverIdentity: PROGRAM_SELECTION_SOLVER_IDENTITY, solverVersion: PROGRAM_SELECTION_SOLVER_VERSION, deterministicSeed: input.deterministicSeed, configuration, bounds: HARD_BOUNDS, inputManifest, fingerprintAlgorithm: "sha256-canonical-json-v1" as const, inputFingerprint, diagnostics, slates, explanation: "Generated deterministic candidate alternatives only; no slate is authoritative." });
}

export function solveProgramSelection(input: ProgramSelectionSolverInput): ProgramSelectionSolverOutput {
  return solveNormalized(normalize(input));
}
export const generateProgramCandidateSlates = solveProgramSelection;
