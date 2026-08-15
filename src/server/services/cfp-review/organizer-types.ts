import type { RubricProjection } from "./rubric-semantics";
import type { OrganizerReviewBlindControl } from "./review-blind-control";
import type { BlindFieldDecisionInput } from "./artifact-types";

export const ORGANIZER_REVIEW_RUBRIC_DOCUMENT_SCHEMA =
  "cfp-organizer-review-rubric/v1" as const;
export const ORGANIZER_REVIEW_EVIDENCE_SCHEMA =
  "cfp-organizer-review-evidence/v1" as const;
export const ORGANIZER_REVIEW_EXPORT_SCHEMA =
  "cfp-organizer-review-export/v1" as const;
export const ORGANIZER_REVIEW_RECUSAL_REQUEST_SCHEMA =
  "cfp-organizer-review-recusal-request/v1" as const;
export const ORGANIZER_REVIEW_RECUSAL_RECEIPT_SCHEMA =
  "cfp-organizer-review-recusal-receipt/v1" as const;

export type OrganizerReviewRoundState = "DRAFT" | "OPEN" | "CLOSED" | "CANCELLED";
export type OrganizerReviewAssignmentState =
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "RECUSED"
  | "REVOKED";
export type OrganizerReviewConflictStatus = "NONE" | "DECLARED" | "CLEARED" | "WAIVED";
export type OrganizerReviewRubricFieldKind = "numeric" | "dropdown" | "text";
export type OrganizerReviewDistributionStrategy = "balanced" | "round_robin";
export type OrganizerReviewSort = "rank" | "score" | "progress" | "submission" | "reviewer";

export interface OrganizerReviewRubricChoice {
  readonly value: string;
  readonly label: string;
}

export interface OrganizerReviewRubricFieldInput {
  readonly id: string;
  readonly label: string;
  readonly guidance?: string;
  readonly kind: OrganizerReviewRubricFieldKind;
  readonly required: boolean;
  readonly weight: number;
  /** Only one explicitly marked dropdown may contribute recommendation evidence. */
  readonly recommendation?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly step?: number;
  readonly choices?: readonly OrganizerReviewRubricChoice[];
  readonly maxLength?: number;
}

export interface OrganizerReviewRubricField extends Omit<
  OrganizerReviewRubricFieldInput,
  "guidance" | "choices" | "minimum" | "maximum" | "step" | "maxLength"
> {
  readonly guidance: string;
  readonly recommendation?: boolean;
  readonly choices: readonly OrganizerReviewRubricChoice[];
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly step: number | null;
  readonly maxLength: number | null;
}

export interface OrganizerReviewRubricDocument {
  readonly schema: typeof ORGANIZER_REVIEW_RUBRIC_DOCUMENT_SCHEMA;
  readonly version: 1;
  readonly title: string;
  readonly judgmentBoundary: "independent-review-evidence";
  readonly fields: readonly OrganizerReviewRubricField[];
}

export interface OrganizerReviewCall {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly state: string;
  readonly timezone: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
}

export interface OrganizerReviewRound {
  readonly id: string;
  readonly eventId: string;
  readonly callId: string;
  readonly name: string;
  readonly state: OrganizerReviewRoundState;
  readonly stateSequenceNumber: number;
  readonly stateChangedAt: string;
  readonly createdAt: string;
  readonly call: OrganizerReviewCall;
  /** V15 owns immutable round schedules; legacy call-shaped fixtures remain readable. */
  readonly schedule:
    | {
        readonly source: "call";
        readonly version?: number;
        readonly timezone: string;
        readonly opensAt: string | null;
        readonly closesAt: string | null;
        readonly updatedAt?: string;
      }
    | {
        readonly source: "round";
        readonly version: number;
        readonly timezone: string;
        readonly opensAt: string;
        readonly closesAt: string;
        readonly updatedAt: string;
      };
  /** Optional for compatibility with older synthetic projections; server reads always supply it. */
  readonly blindReview?: OrganizerReviewBlindControl;
  readonly rubric: OrganizerReviewRubricSummary | null;
  readonly progress: OrganizerReviewProgress;
}

export interface OrganizerReviewRubricSummary {
  readonly id: string;
  readonly roundId: string;
  readonly versionNumber: number;
  readonly fingerprint: string;
  readonly sealedAt: string;
  readonly semanticsId: string | null;
  readonly fields: readonly OrganizerReviewRubricField[];
  readonly reviewerProjection: RubricProjection | null;
  /** Internal compatibility marker; custom IDs are never remapped to fixed positional IDs. */
  readonly custom?: boolean;
}

export interface OrganizerReviewProgress {
  readonly assigned: number;
  readonly inProgress: number;
  readonly submitted: number;
  readonly recused: number;
  readonly revoked: number;
  readonly conflicts: number;
  readonly blindReady: number;
  readonly blindPending: number;
  readonly total: number;
  readonly completionPercent: number;
}

export type OrganizerReviewSubmittedValue = string | number | boolean;

export interface OrganizerReviewSubmittedCriterion {
  readonly criterionId: string;
  readonly label: string;
  readonly kind: OrganizerReviewRubricFieldKind;
  readonly value: OrganizerReviewSubmittedValue | null;
  /** Human-readable rubric choice label; absent for numeric and text criteria. */
  readonly choiceLabel: string | null;
}

export interface OrganizerReviewSubmittedReview {
  readonly revisionNumber: number;
  readonly criteria: readonly OrganizerReviewSubmittedCriterion[];
}

export interface OrganizerReviewAssignment {
  readonly id: string;
  readonly roundId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly reviewerAccountId: string;
  readonly reviewerName: string;
  readonly assignmentState: OrganizerReviewAssignmentState;
  readonly assignmentStateSequenceNumber: number;
  readonly conflictStatus: OrganizerReviewConflictStatus;
  readonly conflictSequenceNumber: number;
  readonly latestReviewRevisionNumber: number;
  readonly blindArtifactReady: boolean;
  readonly assignedAt: string;
  /** Present only when the assignment's latest review is submitted and safely projected. */
  readonly latestSubmittedReview?: OrganizerReviewSubmittedReview | null;
  readonly applicant: {
    readonly personId: string;
    readonly displayName: string;
    readonly organization: string | null;
  };
}

export interface OrganizerReviewRecommendationCounts {
  readonly advance: number;
  readonly hold: number;
  readonly doNotAdvance: number;
}

export interface OrganizerReviewSubmissionAggregate {
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly applicant: {
    readonly personId: string;
    readonly displayName: string;
    readonly organization: string | null;
  };
  readonly assignedReviewCount: number;
  readonly submittedReviewCount: number;
  readonly eligibleReviewCount: number;
  readonly completionPercent: number;
  readonly conflictCount: number;
  readonly blindPendingCount: number;
  readonly score: number | null;
  readonly scoreBasis: "submitted-review-evidence" | "no-submitted-evidence";
  readonly recommendationCounts: OrganizerReviewRecommendationCounts;
  /** Derived evidence ordering only; it is not an organizer decision. */
  readonly evidenceRank: number | null;
}

export interface OrganizerReviewReminder {
  readonly assignmentId: string;
  readonly submissionId: string;
  readonly reviewerAccountId: string;
  readonly reviewerName: string;
  readonly dueAt: string | null;
  readonly status: "DUE" | "UPCOMING" | "NOT_SCHEDULED";
  readonly channel: "local-evidence";
  readonly reason: string;
}

export interface OrganizerReviewLocalEvidence {
  readonly schema: typeof ORGANIZER_REVIEW_EVIDENCE_SCHEMA;
  readonly kind: "DISTRIBUTION_PLANNED" | "REMINDER_PLANNED" | "EXPORT_CREATED" | "ASSIGNMENT_RECUSED";
  readonly workspaceId: string;
  readonly roundId: string;
  readonly subjectId: string;
  readonly fingerprint: string;
  readonly recordedAt: string;
}

export interface OrganizerReviewRoundProjection extends OrganizerReviewRound {
  readonly assignments: readonly OrganizerReviewAssignment[];
  readonly rankings: readonly OrganizerReviewSubmissionAggregate[];
  readonly reminders: readonly OrganizerReviewReminder[];
  readonly localEvidence: readonly OrganizerReviewLocalEvidence[];
}

export interface OrganizerReviewSurface {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly calls: readonly OrganizerReviewCall[];
  readonly rounds: readonly OrganizerReviewRoundProjection[];
  readonly selectedRoundId: string | null;
  readonly selectedSort: OrganizerReviewSort;
}

export interface CreateOrganizerReviewRoundInput {
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly callId: string;
  readonly name: string;
  readonly opensAt?: string | null;
  readonly closesAt?: string | null;
  readonly idempotencyKey?: string;
}

export interface OrganizerReviewRoundReceipt {
  readonly roundId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly state: "DRAFT";
  readonly stateSequenceNumber: 1;
  readonly scheduleSource: "call" | "round";
  readonly scheduleVersion?: number;
  readonly timezone: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly replayed: boolean;
}

export interface SetOrganizerReviewRoundScheduleInput {
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly roundId: string;
  readonly expectedScheduleVersion: number;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly idempotencyKey: string;
}

export interface OrganizerReviewRoundScheduleReceipt {
  readonly roundId: string;
  readonly eventId: string;
  readonly scheduleVersion: number;
  readonly timezone: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly updatedAt: string;
  readonly replayed: boolean;
}

export interface SetOrganizerReviewRoundStateInput {
  readonly workspaceSlug: string;
  readonly eventId?: string;
  readonly roundId: string;
  readonly expectedStateSequenceNumber: number;
  readonly state: "OPEN" | "CLOSED" | "CANCELLED";
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export interface OrganizerReviewRoundStateReceipt {
  readonly roundId: string;
  readonly state: "OPEN" | "CLOSED" | "CANCELLED";
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface CreateOrganizerReviewRubricInput {
  readonly workspaceSlug: string;
  readonly roundId: string;
  readonly fields: readonly OrganizerReviewRubricFieldInput[];
  readonly idempotencyKey?: string;
}

export interface OrganizerReviewRubricReceipt {
  readonly rubricVersionId: string;
  readonly roundId: string;
  readonly versionNumber: number;
  readonly fingerprint: string;
  readonly fields: readonly OrganizerReviewRubricField[];
  readonly semanticsId: string | null;
  readonly sealedAt: string;
  readonly replayed: boolean;
}

export interface OrganizerReviewPoolInput {
  readonly id: string;
  readonly reviewerAccountIds: readonly string[];
  readonly maxAssignments?: number;
}

/**
 * A trusted organizer redaction manifest is required before distribution can
 * issue a reviewer artifact. Source values are never copied or inferred by
 * the distribution command.
 */
export interface OrganizerReviewBlindArtifactDecisionSet {
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly decisions: readonly BlindFieldDecisionInput[];
}

export interface DistributeOrganizerReviewAssignmentsInput {
  readonly workspaceSlug: string;
  readonly roundId: string;
  readonly reviewerAccountIds?: readonly string[];
  readonly submissionIds?: readonly string[];
  readonly reviewsPerSubmission?: number;
  readonly maxAssignmentsPerReviewer?: number;
  readonly pools?: readonly OrganizerReviewPoolInput[];
  readonly strategy?: OrganizerReviewDistributionStrategy;
  readonly blindArtifactDecisions?: readonly OrganizerReviewBlindArtifactDecisionSet[];
  readonly idempotencyKey?: string;
}

export interface OrganizerReviewAssignmentPlanEntry {
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly reviewerAccountId: string;
  readonly poolId: string | null;
}

export interface OrganizerReviewDistributionPlan {
  readonly roundId: string;
  readonly strategy: OrganizerReviewDistributionStrategy;
  readonly assignments: readonly OrganizerReviewAssignmentPlanEntry[];
  readonly skippedSubmissionIds: readonly string[];
  readonly fingerprint: string;
}

export interface OrganizerReviewDistributionReceipt {
  readonly roundId: string;
  readonly createdAssignmentIds: readonly string[];
  readonly existingAssignmentIds: readonly string[];
  readonly blindArtifactIds: readonly string[];
  readonly plan: OrganizerReviewDistributionPlan;
  readonly localEvidence: OrganizerReviewLocalEvidence;
  readonly blindArtifactPendingAssignmentIds: readonly string[];
  readonly replayed: boolean;
}

export interface RecuseOrganizerReviewAssignmentInput {
  readonly workspaceSlug: string;
  readonly assignmentId: string;
  readonly expectedAssignmentStateSequenceNumber: number;
  readonly reason: string;
  readonly replacementReviewerAccountId?: string;
  readonly blindArtifactDecisions?: readonly BlindFieldDecisionInput[];
  readonly idempotencyKey: string;
}

export interface OrganizerReviewRecusalReceipt {
  readonly schema: typeof ORGANIZER_REVIEW_RECUSAL_RECEIPT_SCHEMA;
  readonly workspaceId: string;
  readonly roundId: string;
  readonly assignmentId: string;
  readonly replacementAssignmentId: string | null;
  readonly blindArtifactId: string | null;
  readonly localEvidence: OrganizerReviewLocalEvidence;
  readonly requestFingerprint: string;
  readonly receiptFingerprint: string;
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface RecordOrganizerReviewRemindersInput {
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly roundId: string;
}

export interface OrganizerReviewReminderReceipt {
  readonly schema: "cfp-organizer-review-reminder/v1";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly roundId: string;
  readonly outstandingAssignmentIds: readonly string[];
  readonly recordedAssignmentIds: readonly string[];
  readonly localEvidence: readonly OrganizerReviewLocalEvidence[];
  readonly providerMutation: false;
  readonly replayed: boolean;
}

export interface ReadOrganizerReviewSurfaceInput {
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly roundId?: string;
  readonly sort?: OrganizerReviewSort;
}

export interface ExportOrganizerReviewInput extends ReadOrganizerReviewSurfaceInput {
  readonly format: "csv" | "json";
}

export interface OrganizerReviewExport {
  readonly schema: typeof ORGANIZER_REVIEW_EXPORT_SCHEMA;
  readonly format: "csv" | "json";
  readonly fileName: string;
  readonly mediaType: "text/csv" | "application/json";
  readonly sensitivity: "ORGANIZER_PRIVATE";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly roundId: string;
  readonly rubricFingerprint: string | null;
  readonly content: string;
  readonly fingerprint: string;
  readonly localEvidence: OrganizerReviewLocalEvidence;
}
