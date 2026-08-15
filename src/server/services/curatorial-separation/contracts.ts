/**
 * Transport-neutral contracts for the curatorial-separation core.
 *
 * This package is deliberately a preview boundary.  It has no persistence,
 * authorization adapter, solver provider, notification port, or mutation
 * command.  A candidate slate is evidence for a later human decision, never
 * decision truth.
 */

export const CURATORIAL_SELECTION_SCHEMA = "curatorial-program-selection/v1" as const;
export const CURATORIAL_EXPLANATION_RECEIPT_SCHEMA =
  "curatorial-explanation-receipt/v1" as const;
export const CURATORIAL_OVERRIDE_PROPOSAL_SCHEMA =
  "curatorial-human-override-proposal/v1" as const;
export const CURATORIAL_FINGERPRINT_ALGORITHM = "sha256-canonical-json-v1" as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const CURATORIAL_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 50_000,
  maxSerializedBytes: 2 * 1024 * 1024,
  maxStringBytes: 4 * 1024,
  maxIdentifierBytes: 256,
  maxProposalRevisions: 20,
  maxSlateSize: 12,
  maxCandidateSlates: 16,
  maxSearchNodes: 200_000,
  maxCapacityPools: 64,
  maxCapacityTransfers: 128,
  maxAllocationOptions: 16,
  maxTopicsPerRevision: 32,
  maxEvidence: 512,
  maxConstraints: 64,
  maxObjectives: 16,
  maxBlockers: 128,
  maxDisplacedAlternatives: 20,
  maxExplanationBytes: 2_048,
  maxCapacityQuantity: 1_000_000_000,
  maxScore: 1_000_000_000,
  maxWeightPart: 1_000_000,
} as const);

export type PreviewStatus = "READY" | "BLOCKED" | "UNAVAILABLE";
export type EvidenceState =
  | "CURRENT"
  | "STALE"
  | "MISSING"
  | "CONFLICTING"
  | "BLOCKED"
  | "UNAVAILABLE";
export type EvidenceVisibility = "PUBLIC" | "ORGANIZER_PRIVATE" | "BLIND_PRIVATE";

export const CURATORIAL_EVIDENCE_FAMILIES = [
  "INDIVIDUAL_EVALUATION",
  "CONFIDENTIAL_REVIEW_SCORE",
  "CONFIDENTIAL_REVIEW_COMMENT",
  "ADVOCACY",
  "ENDORSEMENT",
] as const;
export type CuratorialEvidenceFamily = (typeof CURATORIAL_EVIDENCE_FAMILIES)[number];

export const CURATORIAL_EVIDENCE_OBJECTIVE_FAMILIES = [
  "INDIVIDUAL_EVALUATION",
  "CONFIDENTIAL_REVIEW_SCORE",
  "ADVOCACY",
  "TOPIC_BALANCE",
  "ORGANIZATION_BALANCE",
  "CAPACITY_FIT",
] as const;
export type CuratorialObjectiveFamily =
  (typeof CURATORIAL_EVIDENCE_OBJECTIVE_FAMILIES)[number];

export type EvidenceStance =
  | "STRONGLY_PROMOTE"
  | "PROMOTE"
  | "NO_POSITION"
  | "OPPOSE";

export interface CuratorialScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

export interface ProgramAllocationOption {
  readonly poolId: string;
  readonly poolVersionId: string;
  readonly unitKind: string;
  readonly quantity: number;
}

export interface EligibleProposalRevision {
  readonly submissionId: string;
  readonly proposalRevisionId: string;
  readonly revisionNumber: number;
  readonly revisionFingerprint: string;
  readonly topics: readonly string[];
  readonly organizationId: string;
  readonly allocationOptions: readonly ProgramAllocationOption[];
}

export interface EligibilityBinding {
  readonly proposalRevisionId: string;
  readonly revisionFingerprint: string;
  readonly eligible: boolean;
  readonly evidenceState: EvidenceState;
}

export interface EligibilityContext {
  readonly contextId: string;
  readonly versionId: string;
  readonly fingerprint: string;
  readonly asOf: string;
  readonly status: EvidenceState;
  readonly bindings: readonly EligibilityBinding[];
}

export interface CuratorialReviewEvidence {
  readonly evidenceId: string;
  readonly proposalRevisionId: string;
  readonly family: CuratorialEvidenceFamily;
  readonly visibility: EvidenceVisibility;
  readonly state: EvidenceState;
  readonly fingerprint: string;
  readonly contextFingerprint: string;
  /** Used only by an explicit objective; never returned for private evidence. */
  readonly value?: number;
  /** Used only by an explicit confidential-review-score objective. */
  readonly score?: number;
  /** Accepted as source evidence but never copied into a preview or receipt. */
  readonly comment?: string;
  readonly stance?: EvidenceStance;
  readonly strength?: number;
  /** Accepted as source evidence but never copied into a preview or receipt. */
  readonly rationale?: string;
}

export interface CurrentReviewContext {
  readonly contextId: string;
  readonly versionId: string;
  readonly fingerprint: string;
  readonly asOf: string;
  readonly status: EvidenceState;
  readonly evidence: readonly CuratorialReviewEvidence[];
}

export interface CapacityPoolSnapshot {
  readonly poolId: string;
  readonly poolVersionId: string;
  readonly unitKind: string;
  readonly capacity: number;
  readonly remaining: number;
}

export interface CapacityTransfer {
  readonly transferId: string;
  readonly sequenceNumber: number;
  readonly sourcePoolId: string;
  readonly sourcePoolVersionId: string;
  readonly destinationPoolId: string;
  readonly destinationPoolVersionId: string;
  readonly unitKind: string;
  readonly quantity: number;
  readonly sourceBefore: number;
  readonly sourceAfter: number;
  readonly destinationBefore: number;
  readonly destinationAfter: number;
  readonly fingerprint: string;
}

export const CURATORIAL_CONSTRAINT_KINDS = [
  "REQUIRE_TOPIC",
  "EXCLUDE_TOPIC",
  "MAX_TOPIC_COUNT",
  "MIN_TOPIC_COUNT",
  "MAX_ORGANIZATION_COUNT",
  "MIN_ORGANIZATION_COUNT",
  "MIN_DISTINCT_TOPICS",
  "MIN_DISTINCT_ORGANIZATIONS",
  "MAX_TOTAL_UNITS",
] as const;
export type CuratorialConstraintKind = (typeof CURATORIAL_CONSTRAINT_KINDS)[number];

export interface CuratorialConstraint {
  readonly constraintId: string;
  readonly kind: CuratorialConstraintKind;
  readonly hard: boolean;
  readonly topicId?: string;
  readonly organizationId?: string;
  readonly limit?: number;
}

export type ObjectiveDirection = "MAXIMIZE" | "MINIMIZE";

export interface CuratorialObjective {
  readonly objectiveId: string;
  readonly priority: number;
  readonly sourceFamily: CuratorialObjectiveFamily;
  readonly direction: ObjectiveDirection;
  readonly weightNumerator: number;
  readonly weightDenominator: number;
}

export interface CuratorialSelectionConfiguration {
  readonly maxCandidateSlates?: number;
  readonly maxSearchNodes?: number;
}

export interface ProgramSelectionInput {
  readonly schema?: typeof CURATORIAL_SELECTION_SCHEMA;
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
  readonly configuration?: CuratorialSelectionConfiguration;
  readonly purpose?: "PROGRAM_SELECTION_PREVIEW";
}

export interface ExactRational {
  readonly numerator: string;
  readonly denominator: string;
}

export interface ObjectiveContribution {
  readonly objectiveId: string;
  readonly sourceFamily: CuratorialObjectiveFamily;
  readonly proposalRevisionId: string;
  readonly value: ExactRational | null;
  readonly redacted: boolean;
  readonly evidenceFingerprints: readonly string[];
  readonly explanation: string;
}

export interface ObjectiveTotal {
  readonly objectiveId: string;
  readonly sourceFamily: CuratorialObjectiveFamily;
  readonly direction: ObjectiveDirection;
  readonly value: ExactRational | null;
  readonly redacted: boolean;
  readonly explanation: string;
}

export interface ConstraintResult {
  readonly constraintId: string;
  readonly kind: CuratorialConstraintKind;
  readonly hardness: "HARD" | "SOFT";
  readonly result: "SATISFIED" | "VIOLATED";
  readonly measuredValue: string;
  readonly limitValue: string | null;
  readonly explanation: string;
}

export interface SlateEntry {
  readonly submissionId: string;
  readonly proposalRevisionId: string;
  readonly revisionFingerprint: string;
  readonly disposition: "PREVIEW_SELECTED" | "PREVIEW_NOT_SELECTED";
  readonly allocation: ProgramAllocationOption | null;
  readonly explanation: string;
}

export type DisplacementReasonCode =
  | "HARD_CONSTRAINT"
  | "CAPACITY"
  | "SOFT_CONSTRAINT"
  | "OBJECTIVE_ORDER"
  | "DETERMINISTIC_TIEBREAK"
  | "NO_CAUSAL_DISPLACEMENT";

export interface DisplacedAlternative {
  readonly displacedProposalRevisionId: string;
  readonly includedInsteadProposalRevisionId: string | null;
  readonly reasonCode: DisplacementReasonCode;
  readonly relatedConstraintIds: readonly string[];
  readonly relatedObjectiveIds: readonly string[];
  readonly explanation: string;
}

export interface CapacityUsage {
  readonly poolId: string;
  readonly poolVersionId: string;
  readonly unitKind: string;
  readonly remainingBefore: number;
  readonly used: number;
  readonly remainingAfter: number;
}

export interface SlateRankingBasis {
  readonly softViolationCount: number;
  readonly objectiveTotals: readonly ObjectiveTotal[];
  readonly deterministicTieBreakDigest: string;
  readonly canonicalFallbackFingerprint: string;
  readonly explanation: string;
}

export interface CandidateSlatePreview {
  readonly ordinal: number;
  readonly status: "CANDIDATE_PREVIEW";
  readonly entries: readonly SlateEntry[];
  readonly selectedProposalRevisionIds: readonly string[];
  readonly constraintResults: readonly ConstraintResult[];
  readonly capacityUsage: readonly CapacityUsage[];
  readonly displacedAlternatives: readonly DisplacedAlternative[];
  readonly objectiveContributions: readonly ObjectiveContribution[];
  readonly objectiveTotals: readonly ObjectiveTotal[];
  readonly rankingBasis: SlateRankingBasis;
  readonly explanationReceiptId: string;
  readonly contentFingerprint: string;
}

export type CuratorialBlockerCode =
  | "ELIGIBILITY_UNAVAILABLE"
  | "ELIGIBILITY_BLOCKED"
  | "ELIGIBILITY_REVISION_MISMATCH"
  | "REVIEW_CONTEXT_UNAVAILABLE"
  | "REVIEW_CONTEXT_BLOCKED"
  | "REVIEW_EVIDENCE_UNAVAILABLE"
  | "REVIEW_EVIDENCE_BLOCKED"
  | "REVIEW_EVIDENCE_CONTEXT_MISMATCH"
  | "CAPACITY_LEDGER_BLOCKED"
  | "NO_FEASIBLE_SLATE";

export interface CuratorialBlocker {
  readonly code: CuratorialBlockerCode;
  readonly family: "ELIGIBILITY" | "REVIEW" | "CAPACITY" | "SELECTION";
  readonly proposalRevisionId: string | null;
  readonly evidenceId: string | null;
  readonly evidenceFingerprint: string | null;
  readonly message: string;
}

export interface ExplanationReceipt {
  readonly schema: typeof CURATORIAL_EXPLANATION_RECEIPT_SCHEMA;
  readonly receiptId: string;
  readonly scope: CuratorialScope;
  readonly previewFingerprint: string;
  readonly status: PreviewStatus;
  readonly inputFingerprint: string;
  readonly eligibilityContextFingerprint: string;
  readonly reviewContextFingerprint: string;
  readonly capacityLedgerFingerprint: string;
  readonly blockers: readonly CuratorialBlocker[];
  readonly redactedEvidenceCount: number;
  readonly authority: "NONE";
  readonly previewOnly: true;
  readonly explanation: string;
  readonly fingerprint: string;
}

export interface ProgramSelectionPreview {
  readonly schema: typeof CURATORIAL_SELECTION_SCHEMA;
  readonly scope: CuratorialScope;
  readonly status: PreviewStatus;
  readonly targetCount: number;
  readonly inputFingerprint: string;
  readonly eligibilityContextFingerprint: string;
  readonly reviewContextFingerprint: string;
  readonly capacityLedgerFingerprint: string;
  readonly eligibilityContextId: string;
  readonly eligibilityContextVersionId: string;
  readonly reviewContextId: string;
  readonly reviewContextVersionId: string;
  readonly capacityPools: readonly CapacityPoolSnapshot[];
  readonly capacityTransfers: readonly CapacityTransfer[];
  readonly slates: readonly CandidateSlatePreview[];
  readonly explanationReceipts: readonly ExplanationReceipt[];
  readonly blockers: readonly CuratorialBlocker[];
  readonly redactedEvidenceCount: number;
  readonly authority: "NONE";
  readonly previewOnly: true;
  readonly fingerprint: string;
}

export interface OverrideRevisionBinding {
  readonly proposalRevisionId: string;
  readonly revisionFingerprint: string;
}

export interface OverrideAllocation extends ProgramAllocationOption {
  readonly proposalRevisionId: string;
}

export interface OverrideSlateProposal {
  readonly selectedProposalRevisionIds: readonly string[];
  readonly allocations: readonly OverrideAllocation[];
}

export interface OverrideActorBinding {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly role: "organizer" | "workspace_admin" | "event_manager" | "program_manager";
}

export interface RetentionBinding {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyFingerprint: string;
  readonly disposition: "RETAIN_IMMUTABLE_AUDIT";
}

export interface AuthorityVectorBinding {
  readonly vectorId: string;
  readonly vectorVersion: string;
  readonly vectorFingerprint: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly capabilities: readonly ["PROPOSE_PROGRAM_SELECTION_OVERRIDE"];
  readonly current: true;
}

export interface OverrideDisplacedBinding {
  readonly displacedProposalRevisionId: string;
  readonly includedInsteadProposalRevisionId: string | null;
  readonly reasonCode: DisplacementReasonCode;
  readonly relatedConstraintIds: readonly string[];
  readonly relatedObjectiveIds: readonly string[];
}

/**
 * Untrusted command data. Every source field is only a claim until a separately
 * supplied trusted adapter resolves canonical input and this core recomputes it.
 */
export interface HumanOverrideProposalInput {
  readonly schema?: typeof CURATORIAL_OVERRIDE_PROPOSAL_SCHEMA;
  readonly commandId: string;
  readonly scope: CuratorialScope;
  readonly sourceInputFingerprint: string;
  readonly sourcePreviewFingerprint: string;
  readonly sourceSlateOrdinal: number;
  readonly sourceSlateFingerprint: string;
  readonly sourceStatus: "READY";
  readonly targetCount: number;
  readonly eligibilityContextFingerprint: string;
  readonly selectionContextFingerprint: string;
  readonly capacityLedgerFingerprint: string;
  readonly exactRevisionBindings: readonly OverrideRevisionBinding[];
  readonly sourceSelectedProposalRevisionIds: readonly string[];
  readonly sourceDisplacedBindings: readonly OverrideDisplacedBinding[];
  readonly proposal: OverrideSlateProposal;
  readonly actor: OverrideActorBinding;
  readonly purpose: "PROGRAM_SELECTION_OVERRIDE_PROPOSAL";
  readonly retention: RetentionBinding;
  readonly authorityVector: AuthorityVectorBinding;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface HumanOverrideProposalReceipt {
  readonly schema: typeof CURATORIAL_OVERRIDE_PROPOSAL_SCHEMA;
  readonly receiptId: string;
  readonly commandId: string;
  readonly scope: CuratorialScope;
  readonly sourceInputFingerprint: string;
  readonly sourcePreviewFingerprint: string;
  readonly sourceSlateOrdinal: number;
  readonly sourceSlateFingerprint: string;
  readonly sourceStatus: "READY";
  readonly targetCount: number;
  readonly eligibilityContextFingerprint: string;
  readonly selectionContextFingerprint: string;
  readonly capacityLedgerFingerprint: string;
  readonly exactRevisionBindings: readonly OverrideRevisionBinding[];
  readonly sourceSelectedProposalRevisionIds: readonly string[];
  readonly sourceDisplacedBindings: readonly OverrideDisplacedBinding[];
  readonly proposal: OverrideSlateProposal;
  readonly actor: OverrideActorBinding;
  readonly purpose: "PROGRAM_SELECTION_OVERRIDE_PROPOSAL";
  readonly retention: RetentionBinding;
  readonly authorityVector: AuthorityVectorBinding;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly overridePayloadFingerprint: string;
  readonly requestFingerprint: string;
  readonly replayed: boolean;
  readonly authority: "NONE";
  readonly proposalOnly: true;
  readonly noCapacityMutation: true;
  readonly noSpeakerNotification: true;
  readonly fingerprint: string;
}

/** Lookup key presented to the trusted source adapter; it conveys no authority. */
export interface HumanOverrideSourceRequest {
  readonly commandId: string;
  readonly scope: CuratorialScope;
  readonly sourceInputFingerprint: string;
  readonly sourcePreviewFingerprint: string;
  readonly sourceSlateOrdinal: number;
  readonly sourceSlateFingerprint: string;
}

export interface HumanOverrideIdempotencyBinding {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly actorFingerprint: string;
  readonly purposeFingerprint: string;
  readonly retentionFingerprint: string;
  readonly authorityVectorFingerprint: string;
  readonly sourceInputFingerprint: string;
  readonly sourcePreviewFingerprint: string;
  readonly eligibilityContextFingerprint: string;
  readonly selectionContextFingerprint: string;
  readonly capacityLedgerFingerprint: string;
  readonly exactRevisionBindings: readonly OverrideRevisionBinding[];
  readonly targetSlateOrdinal: number;
  readonly targetSlateFingerprint: string;
  readonly targetSelectedProposalRevisionIds: readonly string[];
  readonly targetDisplacedBindings: readonly OverrideDisplacedBinding[];
  readonly overridePayloadFingerprint: string;
  readonly requestFingerprint: string;
}

export type HumanOverrideIdempotencyState = "UNSEEN" | "MATCHED" | "MISMATCHED";

/**
 * Result returned by the separately supplied trusted idempotency adapter. It
 * has no caller-mintable authority marker or public evidence-hash helper.
 */
export interface HumanOverrideIdempotencyResolution {
  readonly state: HumanOverrideIdempotencyState;
  readonly binding: HumanOverrideIdempotencyBinding;
  readonly matchedReceipt: HumanOverrideProposalReceipt | null;
}

/**
 * Read-only server capability supplied separately from untrusted command data.
 * Implementations must resolve canonical state without mutation or notification.
 */
export interface HumanOverrideTrustedAdapter {
  readonly resolveProgramSelectionInput: (
    request: HumanOverrideSourceRequest,
  ) => ProgramSelectionInput | null;
  readonly resolveIdempotencyState: (
    binding: HumanOverrideIdempotencyBinding,
  ) => HumanOverrideIdempotencyResolution | null;
}
