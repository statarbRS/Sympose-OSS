"use server";

import { createHash } from "node:crypto";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import type {
  ReviewerActionState,
  ReviewerDraftValues,
  ReviewerReceiptView,
} from "@/components/cfp-review/contracts";
import { revokeSession, SESSION_COOKIE, type SessionInfo } from "@/server/auth";
import { closeDb, getDb, type Db } from "@/server/db";
import {
  CFP_REVIEW_EVALUATION_SCHEMA,
  ReviewerServiceError,
  ReviewerServiceFatalError,
  clearOwnReviewConflict,
  declareOwnReviewConflict,
  listOwnReviewAssignments,
  readOwnReviewAssignment,
  saveOwnReview,
  submitOwnReview,
  type OwnReviewAssignmentDetail,
  type ReviewEvaluation,
  type ReviewEvaluationResponse,
} from "@/server/services/cfp-review";
import {
  getRouteSession,
  requireReviewerWorkspaceRoute,
} from "@/server/workspace-session";

import {
  reviewBindingMatchesDetail,
  verifyReviewerActionBinding,
  type ConflictActionBinding,
  type ReviewActionBinding,
  type ReviewerActionBinding,
} from "./reviewer-binding.server";

type RubricCriterion = OwnReviewAssignmentDetail["rubric"]["criteria"][number];

const SAFE_COMMAND_FAILURE =
  "The reviewer command could not be completed. Your entries are still on this page; review them and try again.";
const SAFE_STALE_FAILURE =
  "This review changed after the page loaded. Reload the authoritative assignment, then explicitly reconcile your entries before continuing.";
const SAFE_UNAVAILABLE_FAILURE =
  "This review is no longer available in the current session. Reload the review console before continuing.";

function errorState(
  code: string,
  message: string,
  fieldErrors?: Readonly<Record<string, string>>,
  draftValues?: ReviewerDraftValues,
): ReviewerActionState {
  return {
    kind: "error",
    code,
    message,
    ...(fieldErrors ? { fieldErrors } : {}),
    ...(draftValues ? { draftValues } : {}),
  };
}

function staleState(
  code = "REVIEW_STATE_STALE",
  message = SAFE_STALE_FAILURE,
  draftValues?: ReviewerDraftValues,
): ReviewerActionState {
  return { kind: "stale", code, message, ...(draftValues ? { draftValues } : {}) };
}

function reloadState(code: string, message: string): ReviewerActionState {
  return { kind: "reload", code, message };
}

async function requireReviewerActionSession(): Promise<SessionInfo> {
  const session = await getRouteSession();
  requireReviewerWorkspaceRoute(session, session.workspaceSlug);
  return session;
}

function decodeBinding(
  token: string,
  session: SessionInfo,
  kind: ReviewerActionBinding["kind"],
): ReviewerActionBinding | null {
  const binding = verifyReviewerActionBinding(token, session);
  return binding?.kind === kind ? binding : null;
}

function retireFatal(error: unknown, db: Db): void {
  if (error instanceof ReviewerServiceFatalError) {
    try {
      closeDb(db);
    } finally {
      throw error;
    }
  }
}

function safeServiceFailure(
  error: unknown,
  db: Db,
  draftValues?: ReviewerDraftValues,
): ReviewerActionState {
  retireFatal(error, db);
  if (!(error instanceof ReviewerServiceError)) {
    return errorState("COMMAND_FAILED", SAFE_COMMAND_FAILURE, undefined, draftValues);
  }
  if (error.code === "REVIEW_STATE_STALE" || error.code === "IDEMPOTENCY_CONFLICT") {
    return staleState("REVIEW_STATE_STALE", SAFE_STALE_FAILURE, draftValues);
  }
  if (error.code === "EVALUATION_INCOMPLETE") {
    return errorState(
      "EVALUATION_INCOMPLETE",
      "The latest saved revision is incomplete. Complete every required criterion, save a new revision, then submit it.",
    );
  }
  if (error.code === "EVALUATION_INVALID" || error.code === "INPUT_INVALID") {
    return errorState(
      "EVALUATION_INVALID",
      "One or more entries are not valid for the bound rubric. Your entries have been preserved.",
      undefined,
      draftValues,
    );
  }
  if (
    error.code === "ACCESS_DENIED" ||
    error.code === "ASSIGNMENT_NOT_AVAILABLE" ||
    error.code === "STORED_REVIEW_INVALID" ||
    error.code === "READ_FAILED"
  ) {
    return staleState("REVIEW_UNAVAILABLE", SAFE_UNAVAILABLE_FAILURE);
  }
  return errorState("COMMAND_FAILED", SAFE_COMMAND_FAILURE, undefined, draftValues);
}

function commandIdempotencyKey(
  token: string,
  command: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update("sympose-reviewer-ui/v1\u0000", "utf8")
    .update(token, "utf8")
    .update("\u0000", "utf8")
    .update(command, "utf8")
    .update("\u0000", "utf8")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function refreshReviewPaths(session: SessionInfo, assignmentId: string): ReviewerActionState | null {
  try {
    const workspace = encodeURIComponent(session.workspaceSlug);
    revalidatePath(`/review/${workspace}/queue`);
    revalidatePath(
      `/review/${workspace}/assignments/${encodeURIComponent(assignmentId)}`,
    );
    return null;
  } catch {
    return reloadState(
      "REFRESH_REQUIRED",
      "The command was accepted, but the page could not refresh. Reload the authoritative assignment before taking another action.",
    );
  }
}

function conflictWasDeclared(
  error: unknown,
  db: Db,
  session: SessionInfo,
  assignmentId: string,
): ReviewerActionState | null {
  if (
    !(error instanceof ReviewerServiceError) ||
    (error.code !== "REVIEW_STATE_STALE" && error.code !== "ASSIGNMENT_NOT_AVAILABLE")
  ) {
    return null;
  }
  try {
    const withheld = listOwnReviewAssignments(db, session, {
      workspaceSlug: session.workspaceSlug,
    }).some(
      (assignment) =>
        assignment.assignmentId === assignmentId && assignment.conflictStatus === "DECLARED",
    );
    if (!withheld) return null;
  } catch (readError) {
    retireFatal(readError, db);
    return null;
  }
  refreshReviewPaths(session, assignmentId);
  return reloadState(
    "CONFLICT_DECLARED",
    "The authoritative assignment now has a declared conflict. Review content is withheld; reload the assignment before continuing.",
  );
}

function postedString(formData: FormData, name: string): string | null {
  const values = formData.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  return values[0];
}

function parseCriterionValue(
  criterion: RubricCriterion,
  raw: string,
): ReviewEvaluationResponse["value"] | null {
  if (criterion.kind === "numeric") {
    if (raw.trim().length === 0) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  if (criterion.kind === "yesNo") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  }
  if (
    criterion.kind === "scale" ||
    criterion.kind === "recommendation" ||
    criterion.kind === "dropdown"
  ) {
    return criterion.choices.some((choice) => choice.value === raw) ? raw : null;
  }
  return raw.length <= criterion.maxLength ? raw : null;
}

function reviewDraftValues(
  detail: OwnReviewAssignmentDetail,
  formData: FormData,
): ReviewerDraftValues {
  const draft: Record<string, string> = {};
  for (const criterion of detail.rubric.criteria) {
    const values = formData.getAll(`criterion:${criterion.id}`);
    if (values.length !== 1 || typeof values[0] !== "string") continue;
    const maximumLength = criterion.kind === "comment" || criterion.kind === "text"
      ? criterion.maxLength
      : 1024;
    if (values[0].length <= maximumLength) draft[criterion.id] = values[0];
  }
  return Object.freeze(draft);
}

function parseEvaluation(
  detail: OwnReviewAssignmentDetail,
  formData: FormData,
):
  | { readonly evaluation: ReviewEvaluation }
  | { readonly failure: ReviewerActionState } {
  const responses: ReviewEvaluationResponse[] = [];
  const fieldErrors: Record<string, string> = {};
  const draftValues = reviewDraftValues(detail, formData);
  for (const criterion of detail.rubric.criteria) {
    const fieldName = `criterion:${criterion.id}`;
    const values = formData.getAll(fieldName);
    if (values.length === 0 || (values.length === 1 && values[0] === "")) continue;
    if (values.length !== 1 || typeof values[0] !== "string") {
      fieldErrors[criterion.id] = "Enter one value for this criterion.";
      continue;
    }
    const parsed = parseCriterionValue(criterion, values[0]);
    if (parsed === null) {
      fieldErrors[criterion.id] = "Enter a value allowed by the bound rubric.";
      continue;
    }
    responses.push({ criterionId: criterion.id, value: parsed });
  }
  if (Object.keys(fieldErrors).length > 0) {
    return {
      failure: errorState(
        "FORM_INVALID",
        "Review the highlighted rubric entries. Your other entries have been preserved.",
        fieldErrors,
        draftValues,
      ),
    };
  }
  return {
    evaluation: {
      schema: CFP_REVIEW_EVALUATION_SCHEMA,
      responses,
    },
  };
}

function isComplete(detail: OwnReviewAssignmentDetail, evaluation: ReviewEvaluation): boolean {
  const responses = new Map(
    evaluation.responses.map((response) => [response.criterionId, response.value] as const),
  );
  return detail.rubric.criteria.every((criterion) => {
    if (!criterion.required) return true;
    const value = responses.get(criterion.id);
    return (
      value !== undefined &&
      ((criterion.kind !== "comment" && criterion.kind !== "text") ||
        (typeof value === "string" && value.trim().length > 0))
    );
  });
}

function receiptView(
  detail: OwnReviewAssignmentDetail,
  reviewRevisionNumber: number,
  completeness: boolean,
  submitted: boolean,
): ReviewerReceiptView {
  return {
    reviewRevisionNumber,
    completeness: completeness ? "Complete" : "Incomplete",
    submissionStatus: submitted ? "Submitted" : "In progress",
    roundName: detail.roundName,
    proposalRevisionSequence: detail.proposal.revisionSequence,
    rubricVersionId: detail.rubric.versionId,
    rubricVersionNumber: detail.rubric.versionNumber,
  };
}

function conflictReason(formData: FormData): string | null {
  const reason = postedString(formData, "conflictReason")?.trim();
  return reason && reason.length <= 1000 ? reason : null;
}

export async function declareReviewerConflictAction(
  bindingToken: string,
  _state: ReviewerActionState,
  formData: FormData,
): Promise<ReviewerActionState> {
  const reason = conflictReason(formData);
  if (!reason) {
    return errorState(
      "CONFLICT_REASON_REQUIRED",
      "Explain the conflict before declaring it.",
      { conflictReason: "Enter a short conflict reason." },
    );
  }
  const session = await requireReviewerActionSession();
  const binding = decodeBinding(bindingToken, session, "review") as ReviewActionBinding | null;
  if (!binding) return staleState("REVIEW_BINDING_INVALID");
  const db = getDb();
  try {
    declareOwnReviewConflict(db, session, {
      workspaceSlug: session.workspaceSlug,
      assignmentId: binding.assignmentId,
      expectedAssignmentStateSequenceNumber: binding.assignmentStateSequenceNumber,
      expectedConflictSequenceNumber: binding.conflictSequenceNumber,
      reason,
      idempotencyKey: commandIdempotencyKey(bindingToken, "CONFLICT_DECLARE", { reason }),
    });
  } catch (error) {
    return safeServiceFailure(error, db);
  }
  const refreshFailure = refreshReviewPaths(session, binding.assignmentId);
  return (
    refreshFailure ?? {
      kind: "conflict-declared",
      code: "CONFLICT_DECLARED",
      message: "Conflict declared. Proposal and rubric content are now withheld.",
    }
  );
}

export async function clearReviewerConflictAction(
  bindingToken: string,
  _state: ReviewerActionState,
  formData: FormData,
): Promise<ReviewerActionState> {
  const reason = conflictReason(formData);
  if (!reason) {
    return errorState(
      "CONFLICT_REASON_REQUIRED",
      "Explain why the conflict can be cleared.",
      { conflictReason: "Enter a short clearance reason." },
    );
  }
  const session = await requireReviewerActionSession();
  const binding = decodeBinding(bindingToken, session, "conflict") as ConflictActionBinding | null;
  if (!binding) return staleState("REVIEW_BINDING_INVALID");
  const db = getDb();
  try {
    clearOwnReviewConflict(db, session, {
      workspaceSlug: session.workspaceSlug,
      assignmentId: binding.assignmentId,
      expectedAssignmentStateSequenceNumber: binding.assignmentStateSequenceNumber,
      expectedConflictSequenceNumber: binding.conflictSequenceNumber,
      reason,
      idempotencyKey: commandIdempotencyKey(bindingToken, "CONFLICT_CLEAR", { reason }),
    });
    readOwnReviewAssignment(db, session, {
      workspaceSlug: session.workspaceSlug,
      assignmentId: binding.assignmentId,
    });
  } catch (error) {
    return safeServiceFailure(error, db);
  }
  const refreshFailure = refreshReviewPaths(session, binding.assignmentId);
  return (
    refreshFailure ?? {
      kind: "conflict-cleared",
      code: "CONFLICT_CLEARED",
      message: "Conflict cleared against the authoritative assignment. Review content is available again.",
    }
  );
}

export async function saveReviewerRevisionAction(
  bindingToken: string,
  _state: ReviewerActionState,
  formData: FormData,
): Promise<ReviewerActionState> {
  const session = await requireReviewerActionSession();
  const binding = decodeBinding(bindingToken, session, "review") as ReviewActionBinding | null;
  if (!binding) return staleState("REVIEW_BINDING_INVALID");
  const db = getDb();
  let detail: OwnReviewAssignmentDetail;
  try {
    detail = readOwnReviewAssignment(db, session, {
      workspaceSlug: session.workspaceSlug,
      assignmentId: binding.assignmentId,
    });
  } catch (error) {
    return conflictWasDeclared(error, db, session, binding.assignmentId) ??
      safeServiceFailure(error, db);
  }
  const draftValues = reviewDraftValues(detail, formData);
  if (!reviewBindingMatchesDetail(binding, detail)) {
    return staleState("REVIEW_STATE_STALE", SAFE_STALE_FAILURE, draftValues);
  }
  const parsed = parseEvaluation(detail, formData);
  if ("failure" in parsed) return parsed.failure;
  let revisionNumber: number;
  try {
    const receipt = saveOwnReview(db, session, {
      workspaceSlug: session.workspaceSlug,
      assignmentId: binding.assignmentId,
      expectedAssignmentStateSequenceNumber: binding.assignmentStateSequenceNumber,
      expectedReviewRevisionNumber: binding.reviewRevisionNumber,
      evaluation: parsed.evaluation,
      idempotencyKey: commandIdempotencyKey(bindingToken, "SAVE_REVIEW", {
        evaluation: parsed.evaluation,
      }),
    });
    revisionNumber = receipt.outcome.reviewRevisionNumber;
  } catch (error) {
    return conflictWasDeclared(error, db, session, binding.assignmentId) ??
      safeServiceFailure(error, db, draftValues);
  }
  const refreshFailure = refreshReviewPaths(session, binding.assignmentId);
  if (refreshFailure) return refreshFailure;
  return {
    kind: "saved",
    code: "REVIEW_REVISION_SAVED",
    message: `Review revision ${revisionNumber} was appended.`,
    receipt: receiptView(
      detail,
      revisionNumber,
      isComplete(detail, parsed.evaluation),
      detail.assignmentState === "SUBMITTED",
    ),
  };
}

export async function submitReviewerRevisionAction(
  bindingToken: string,
  _state: ReviewerActionState,
  _formData: FormData,
): Promise<ReviewerActionState> {
  const session = await requireReviewerActionSession();
  const binding = decodeBinding(bindingToken, session, "review") as ReviewActionBinding | null;
  if (!binding) return staleState("REVIEW_BINDING_INVALID");
  const db = getDb();
  let detail: OwnReviewAssignmentDetail;
  try {
    detail = readOwnReviewAssignment(db, session, {
      workspaceSlug: session.workspaceSlug,
      assignmentId: binding.assignmentId,
    });
  } catch (error) {
    return conflictWasDeclared(error, db, session, binding.assignmentId) ??
      safeServiceFailure(error, db);
  }
  if (!reviewBindingMatchesDetail(binding, detail)) return staleState();
  try {
    submitOwnReview(db, session, {
      workspaceSlug: session.workspaceSlug,
      assignmentId: binding.assignmentId,
      expectedAssignmentStateSequenceNumber: binding.assignmentStateSequenceNumber,
      expectedReviewRevisionNumber: binding.reviewRevisionNumber,
      idempotencyKey: commandIdempotencyKey(bindingToken, "SUBMIT_REVIEW", {}),
    });
  } catch (error) {
    return conflictWasDeclared(error, db, session, binding.assignmentId) ??
      safeServiceFailure(error, db);
  }
  const refreshFailure = refreshReviewPaths(session, binding.assignmentId);
  if (refreshFailure) return refreshFailure;
  return {
    kind: "submitted",
    code: "REVIEW_SUBMITTED",
    message: "Independent judgment submitted. This review is now terminal.",
    receipt: receiptView(
      detail,
      binding.reviewRevisionNumber,
      true,
      true,
    ),
  };
}

export async function reviewerSignOutAction(
  _state: ReviewerActionState,
  _formData: FormData,
): Promise<ReviewerActionState | never> {
  try {
    const store = await cookies();
    revokeSession(getDb(), store.get(SESSION_COOKIE)?.value);
    store.delete(SESSION_COOKIE);
  } catch {
    return errorState(
      "SIGN_OUT_FAILED",
      "Sign-out could not be completed. Reload the page and try again.",
    );
  }
  redirect("/");
}
