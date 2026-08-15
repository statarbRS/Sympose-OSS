export const READINESS_PROOF_GRAPH_SCHEMA = "sympose-readiness-proof-graph/v1" as const;

export const READINESS_OUTCOMES = [
  "OFFER",
  "CONFIRMATION",
  "SCHEDULING",
  "PUBLICATION",
  "OPERATOR_RELEASE",
] as const;

export type ReadinessOutcome = (typeof READINESS_OUTCOMES)[number];

export const SOURCE_FAMILIES = [
  "IDENTITY",
  "SOURCE_RECORD",
  "COHORT_SNAPSHOT",
  "PLAN_INPUT",
  "PLAN_VERSION",
  "PLAN_APPROVAL",
  "DECISION",
  "OFFER",
  "CONFIRMATION",
  "COMMITMENT",
  "SCHEDULE",
  "AUDIENCE_POLICY",
  "PUBLICATION_RELEASE",
  "OPERATOR_RELEASE",
  "OPERATIONAL_OBSERVATION",
] as const;

export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

export const AUDIENCE_KINDS = [
  "ORGANIZER",
  "PARTICIPANT",
  "OPERATOR",
  "PUBLIC",
  "INTERNAL",
] as const;

export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

/** The tenant and operating-context boundary for one proof graph. */
export interface ProofScope {
  readonly workspaceId: string;
  readonly eventId?: string;
  readonly subjectId?: string;
}

/** An exact audience policy/release identity, not a display label. */
export interface AudienceReference {
  readonly kind: AudienceKind;
  readonly id: string;
  readonly version: string;
  readonly fingerprint: string;
}

/**
 * An immutable authority identity. `current` and `superseded` describe the
 * authority's lineage; neither flag is inferred by the evaluator.
 */
export interface AuthorityReference {
  readonly scope: ProofScope;
  readonly kind: string;
  readonly id: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly current: boolean;
  readonly superseded: boolean;
  readonly audience: AudienceReference;
}

export const EVIDENCE_STATES = [
  "PROVEN",
  "BLOCKED",
  "UNAVAILABLE",
  "UNKNOWN",
  "CONFLICTING",
] as const;

export type EvidenceState = (typeof EVIDENCE_STATES)[number];

/**
 * An already-authorized fact supplied by an application boundary. This core
 * never fetches, authorizes, enriches, scores, or otherwise repairs it.
 */
export interface AuthorizedEvidence {
  readonly id: string;
  readonly scope: ProofScope;
  readonly family: SourceFamily;
  readonly authority: AuthorityReference;
  readonly state: EvidenceState;
  readonly reason?: string;
}

export const NEXT_ACTION_KINDS = [
  "SUPPLY_CURRENT_EVIDENCE",
  "RECORD_CURRENT_APPROVAL",
  "REPLACE_SUPERSEDED_EVIDENCE",
  "RESOLVE_CONFLICT",
  "REVIEW_UNKNOWN_EVIDENCE",
  "CONFIRM_EXACT_OFFER",
  "SCHEDULE_EXACT_COMMITMENT",
  "PUBLISH_EXACT_RELEASE",
  "RELEASE_TO_OPERATOR",
] as const;

export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

/**
 * A declarative, human/application-owned next action. The evaluator returns
 * these as affordances only; it never executes one.
 */
export interface ValidNextAction {
  readonly id: string;
  readonly kind: NextActionKind;
  readonly label: string;
  readonly targetRequirementId: string;
}

/** A proof node whose exact authority must be present and current. */
export interface ReadinessRequirement {
  readonly id: string;
  readonly scope: ProofScope;
  readonly outcome: ReadinessOutcome;
  readonly label: string;
  readonly sourceFamily: SourceFamily;
  readonly authority: AuthorityReference;
  readonly dependsOn: readonly string[];
  readonly nextActions: readonly ValidNextAction[];
}

export interface ProofGraphLimits {
  readonly maxNodes?: number;
  readonly maxEvidenceNodes?: number;
  readonly maxRequirementNodes?: number;
  readonly maxEdges?: number;
  readonly maxDepth?: number;
  readonly maxActionsPerRequirement?: number;
  /** Maximum number of blocker entries emitted across the complete receipt. */
  readonly maxBlockerReceipts?: number;
  /** Maximum number of unique evidence IDs carried by one blocker receipt. */
  readonly maxEvidenceIdsPerBlocker?: number;
  readonly maxStringLength?: number;
}

export interface ResolvedProofGraphLimits {
  readonly maxNodes: number;
  readonly maxEvidenceNodes: number;
  readonly maxRequirementNodes: number;
  readonly maxEdges: number;
  readonly maxDepth: number;
  readonly maxActionsPerRequirement: number;
  readonly maxBlockerReceipts: number;
  readonly maxEvidenceIdsPerBlocker: number;
  readonly maxStringLength: number;
}

export interface ReadinessProofGraphInput {
  readonly scope: ProofScope;
  readonly evidence: readonly AuthorizedEvidence[];
  readonly requirements: readonly ReadinessRequirement[];
  readonly limits?: ProofGraphLimits;
}

export type ProofStatus = "BLOCKED" | "READY" | "UNAVAILABLE";

export const BLOCKER_CODES = [
  "SOURCE_FAMILY_UNAVAILABLE",
  "EVIDENCE_UNAVAILABLE",
  "UNKNOWN_EVIDENCE",
  "STALE_AUTHORITY",
  "SUPERSEDED_AUTHORITY",
  "NON_CURRENT_AUTHORITY",
  "EVIDENCE_BLOCKED",
  "EVIDENCE_CONFLICTING",
  "EXACT_VERSION_MISMATCH",
  "EXACT_FINGERPRINT_MISMATCH",
  "AUDIENCE_MISMATCH",
  "MISSING_EXACT_EVIDENCE",
  "DEPENDENCY_BLOCKED",
  "DEPENDENCY_UNAVAILABLE",
] as const;

export type BlockerCode = (typeof BLOCKER_CODES)[number];

export interface BlockerReceipt {
  readonly id: string;
  readonly code: BlockerCode;
  readonly requirementId: string;
  readonly outcome: ReadinessOutcome;
  readonly family: SourceFamily;
  readonly authority: AuthorityReference;
  readonly message: string;
  readonly sourceEvidenceIds: readonly string[];
  readonly dependencyRequirementId?: string;
}

export interface RequirementEvaluation {
  readonly requirementId: string;
  readonly outcome: ReadinessOutcome;
  readonly status: ProofStatus;
  readonly dependsOn: readonly string[];
  readonly blockers: readonly BlockerReceipt[];
  readonly minimalBlockers: readonly BlockerReceipt[];
  readonly nextActions: readonly ValidNextAction[];
  readonly matchedEvidenceIds: readonly string[];
}

export interface OutcomeEvaluation {
  readonly outcome: ReadinessOutcome;
  readonly status: ProofStatus;
  readonly requirementIds: readonly string[];
  readonly blockers: readonly BlockerReceipt[];
  readonly minimalBlockers: readonly BlockerReceipt[];
  readonly nextActions: readonly ValidNextAction[];
}

export interface ReadinessProofGraphResult {
  readonly schema: typeof READINESS_PROOF_GRAPH_SCHEMA;
  readonly scope: ProofScope;
  readonly fingerprint: string;
  readonly status: ProofStatus;
  readonly evidence: readonly AuthorizedEvidence[];
  readonly requirements: readonly RequirementEvaluation[];
  readonly outcomes: readonly OutcomeEvaluation[];
  readonly blockers: readonly BlockerReceipt[];
  readonly minimalBlockers: readonly BlockerReceipt[];
  readonly nextActions: readonly ValidNextAction[];
  readonly limits: ResolvedProofGraphLimits;
}

export const DEFAULT_PROOF_GRAPH_LIMITS: Required<ResolvedProofGraphLimits> = Object.freeze({
  maxNodes: 768,
  maxEvidenceNodes: 256,
  maxRequirementNodes: 512,
  maxEdges: 2048,
  maxDepth: 64,
  maxActionsPerRequirement: 8,
  maxBlockerReceipts: 16_384,
  maxEvidenceIdsPerBlocker: 256,
  maxStringLength: 512,
});

export const ABSOLUTE_PROOF_GRAPH_LIMITS: Required<ResolvedProofGraphLimits> = Object.freeze({
  maxNodes: 1536,
  maxEvidenceNodes: 512,
  maxRequirementNodes: 1024,
  maxEdges: 8192,
  maxDepth: 128,
  maxActionsPerRequirement: 32,
  maxBlockerReceipts: 65_536,
  maxEvidenceIdsPerBlocker: 512,
  maxStringLength: 2048,
});

export type ProofGraphValidationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_SCOPE"
  | "INVALID_REFERENCE"
  | "INVALID_EVIDENCE"
  | "INVALID_REQUIREMENT"
  | "INVALID_NEXT_ACTION"
  | "INVALID_LIMIT"
  | "DUPLICATE_NODE"
  | "DUPLICATE_DEPENDENCY"
  | "CONFLICTING_NODE"
  | "CROSS_SCOPE_REFERENCE"
  | "UNKNOWN_DEPENDENCY"
  | "CYCLE_DETECTED"
  | "DEPTH_LIMIT_EXCEEDED"
  | "SIZE_LIMIT_EXCEEDED"
  | "EMPTY_GRAPH";

export class ProofGraphValidationError extends Error {
  readonly code: ProofGraphValidationErrorCode;
  readonly path: string;

  constructor(code: ProofGraphValidationErrorCode, path: string, message: string) {
    super(message);
    this.name = "ProofGraphValidationError";
    this.code = code;
    this.path = path;
  }
}
