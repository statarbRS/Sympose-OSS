export type ReviewCompleteness = "Complete" | "Incomplete";

export type ReviewSubmissionStatus = "In progress" | "Submitted";

export interface ReviewerReceiptView {
  readonly reviewRevisionNumber: number;
  readonly completeness: ReviewCompleteness;
  readonly submissionStatus: ReviewSubmissionStatus;
  readonly roundName: string;
  readonly proposalRevisionSequence: number;
  readonly rubricVersionId: string;
  readonly rubricVersionNumber: number;
}

export type ReviewerDraftValues = Readonly<Record<string, string>>;

export type ReviewerActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      readonly fieldErrors?: Readonly<Record<string, string>>;
      readonly draftValues?: ReviewerDraftValues;
    }
  | {
      readonly kind: "stale" | "reload";
      readonly code: string;
      readonly message: string;
      readonly draftValues?: ReviewerDraftValues;
    }
  | {
      readonly kind: "saved" | "submitted";
      readonly code: string;
      readonly message: string;
      readonly receipt: ReviewerReceiptView;
    }
  | {
      readonly kind: "conflict-declared" | "conflict-cleared";
      readonly code: string;
      readonly message: string;
    };

export const IDLE_REVIEWER_ACTION_STATE: ReviewerActionState = Object.freeze({
  kind: "idle",
});

export function reviewerActionRequiresReload(state: ReviewerActionState): boolean {
  return state.kind === "stale" || state.kind === "reload";
}
