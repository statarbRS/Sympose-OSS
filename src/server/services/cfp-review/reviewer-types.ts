import type { JsonSafeValue } from "../cfp/form-safety";
import type { BlindAnswerProjection } from "./artifact-types";
import type { RubricProjection } from "./rubric-semantics";

export const CFP_REVIEW_EVALUATION_SCHEMA = "cfp-review-evaluation/v1" as const;
export const CFP_REVIEW_COMMAND_REQUEST_SCHEMA =
  "cfp-review-command-request/v1" as const;
export const CFP_REVIEW_COMMAND_RECEIPT_SCHEMA =
  "cfp-review-command-receipt/v1" as const;

export type ReviewerAssignmentState =
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "SUBMITTED";

export type ReviewerConflictStatus =
  | "NONE"
  | "DECLARED"
  | "CLEARED"
  | "WAIVED";

export type ReviewerCommandKind =
  | "CONFLICT_DECLARE"
  | "CONFLICT_CLEAR"
  | "SAVE_REVIEW"
  | "SUBMIT_REVIEW";

export type ReviewEvaluationValue = string | number | boolean;

export interface ReviewEvaluationResponse {
  readonly criterionId: string;
  readonly value: ReviewEvaluationValue;
}

/** Caller and reviewer-facing evaluation shape. Internal tuple bindings are never returned. */
export interface ReviewEvaluation {
  readonly schema: typeof CFP_REVIEW_EVALUATION_SCHEMA;
  readonly responses: readonly ReviewEvaluationResponse[];
}

export interface ListOwnReviewAssignmentsInput {
  readonly workspaceSlug: string;
}

export interface ReadOwnReviewAssignmentInput {
  readonly workspaceSlug: string;
  readonly assignmentId: string;
}

export interface DeclareOwnReviewConflictInput {
  readonly workspaceSlug: string;
  readonly assignmentId: string;
  readonly expectedAssignmentStateSequenceNumber: number;
  readonly expectedConflictSequenceNumber: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface ClearOwnReviewConflictInput {
  readonly workspaceSlug: string;
  readonly assignmentId: string;
  readonly expectedAssignmentStateSequenceNumber: number;
  readonly expectedConflictSequenceNumber: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface SaveOwnReviewInput {
  readonly workspaceSlug: string;
  readonly assignmentId: string;
  readonly expectedAssignmentStateSequenceNumber: number;
  readonly expectedReviewRevisionNumber: number;
  readonly evaluation: ReviewEvaluation;
  readonly idempotencyKey: string;
}

export interface SubmitOwnReviewInput {
  readonly workspaceSlug: string;
  readonly assignmentId: string;
  readonly expectedAssignmentStateSequenceNumber: number;
  readonly expectedReviewRevisionNumber: number;
  readonly idempotencyKey: string;
}

export interface OwnReviewAssignmentSummary {
  readonly assignmentId: string;
  readonly roundName: string;
  readonly assignedAt: string;
  readonly assignmentState: ReviewerAssignmentState;
  readonly assignmentStateSequenceNumber: number;
  readonly conflictStatus: ReviewerConflictStatus;
  readonly conflictSequenceNumber: number;
  readonly latestReviewRevisionNumber: number;
  readonly actionBlocked: boolean;
}

export interface ReviewerBlindProposalProjection {
  readonly revisionSequence: number;
  readonly disclosureStage: "BLIND_REVIEW";
  readonly answers: readonly BlindAnswerProjection[];
}

export interface OwnReviewRevisionProjection {
  readonly revisionNumber: number;
  readonly evaluation: ReviewEvaluation;
  readonly savedAt: string;
}

export interface OwnReviewAssignmentDetail extends OwnReviewAssignmentSummary {
  readonly proposal: ReviewerBlindProposalProjection;
  readonly rubric: RubricProjection;
  readonly latestReview: OwnReviewRevisionProjection | null;
}

export interface ReviewEffectReceiptOutcome {
  readonly effectId: string;
}

export interface ReviewSaveReceiptOutcome {
  readonly reviewRevisionId: string;
  readonly reviewRevisionNumber: number;
}

interface ReviewCommandReceiptBase {
  readonly schema: typeof CFP_REVIEW_COMMAND_RECEIPT_SCHEMA;
  readonly effectId: string;
  readonly createdAt: string;
}

export interface ReviewConflictDeclareReceipt extends ReviewCommandReceiptBase {
  readonly commandKind: "CONFLICT_DECLARE";
  readonly outcome: ReviewEffectReceiptOutcome;
}

export interface ReviewConflictClearReceipt extends ReviewCommandReceiptBase {
  readonly commandKind: "CONFLICT_CLEAR";
  readonly outcome: ReviewEffectReceiptOutcome;
}

export interface ReviewSaveReceipt extends ReviewCommandReceiptBase {
  readonly commandKind: "SAVE_REVIEW";
  readonly outcome: ReviewSaveReceiptOutcome;
}

export interface ReviewSubmitReceipt extends ReviewCommandReceiptBase {
  readonly commandKind: "SUBMIT_REVIEW";
  readonly outcome: ReviewEffectReceiptOutcome;
}

export type ReviewCommandReceipt =
  | ReviewConflictDeclareReceipt
  | ReviewConflictClearReceipt
  | ReviewSaveReceipt
  | ReviewSubmitReceipt;

/** Only the redacted artifact value domain is permitted on the reviewer surface. */
export type ReviewerRedactedValue = JsonSafeValue;
