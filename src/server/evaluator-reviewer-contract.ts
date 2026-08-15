import { deterministicUuid } from "./canonical";
import {
  EVALUATOR_REVIEWER_LOGIN_ALLOWLIST,
  type EvaluatorLoginAccount,
} from "./evaluator-login-accounts";

/**
 * Repository-owned identity contract for the one synthetic reviewer used by the evaluator.
 * It names existing roots only; it is never an instruction to create an account or issue a
 * persistent credential.
 */
export const EVALUATOR_DEVFLOW_REVIEWER_CONTRACT = Object.freeze({
  schema: "evaluator-reviewer-contract/v1" as const,
  workspaceSlug: "devflow" as const,
  workspaceId: deterministicUuid("workspace:devflow"),
  organizerAccountId: deterministicUuid("account:devflow-organizer"),
  eventId: deterministicUuid("evaluator-compatibility:event:devflow"),
  roundId: deterministicUuid("evaluator-compatibility:review-round:devflow"),
  rubricVersionId: deterministicUuid("evaluator-compatibility:rubric:devflow"),
  assignmentId: deterministicUuid("evaluator-compatibility:assignment:devflow"),
  submissionId: deterministicUuid("evaluator-compatibility:submission:priya-raman"),
  eventReviewerAssignmentId: deterministicUuid(
    "evaluator-compatibility:event-reviewer-assignment:devflow",
  ),
  reviewerPersonId: deterministicUuid("evaluator-compatibility:person:sam-whitfield"),
  accountPersonBindingId: deterministicUuid(
    "evaluator-compatibility:binding:sam-whitfield",
  ),
  reviewer: Object.freeze({
    accountId: deterministicUuid("account:evaluator-devflow-reviewer"),
    workspaceId: deterministicUuid("workspace:devflow"),
    role: "reviewer" as const,
    email: "sam.whitfield@devflow.example",
    displayName: "Sam Whitfield",
  }),
});

export type EvaluatorReviewerContract = typeof EVALUATOR_DEVFLOW_REVIEWER_CONTRACT;

export function isAllowlistedEvaluatorReviewer(
  account: Pick<EvaluatorLoginAccount, "accountId" | "workspaceId" | "role" | "email">,
): boolean {
  return EVALUATOR_REVIEWER_LOGIN_ALLOWLIST.some(
    (expected) =>
      expected.accountId === account.accountId &&
      expected.workspaceId === account.workspaceId &&
      expected.role === account.role &&
      expected.email === account.email,
  );
}

export function isPinnedDevflowReviewerAccount(
  account: Pick<EvaluatorLoginAccount, "accountId" | "workspaceId" | "role" | "email">,
): boolean {
  return (
    account.accountId === EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId &&
    account.workspaceId === EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.workspaceId &&
    account.role === EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.role &&
    account.email === EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.email &&
    isAllowlistedEvaluatorReviewer(account)
  );
}
