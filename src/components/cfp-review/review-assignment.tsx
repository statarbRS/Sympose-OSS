"use client";

import Link from "next/link";
import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  clearReviewerConflictAction,
  declareReviewerConflictAction,
  saveReviewerRevisionAction,
  submitReviewerRevisionAction,
} from "@/app/review/actions";
import type {
  OwnReviewAssignmentDetail,
  OwnReviewAssignmentSummary,
  ReviewEvaluationValue,
  ReviewerRedactedValue,
} from "@/server/services/cfp-review";

import {
  IDLE_REVIEWER_ACTION_STATE,
  reviewerActionRequiresReload,
  type ReviewerActionState,
  type ReviewerDraftValues,
  type ReviewerReceiptView,
} from "./contracts";

type RubricCriterion = OwnReviewAssignmentDetail["rubric"]["criteria"][number];

function assignmentHref(workspace: string, assignmentId: string): string {
  return `/review/${encodeURIComponent(workspace)}/assignments/${encodeURIComponent(
    assignmentId,
  )}`;
}

function actionWithholdsContent(state: ReviewerActionState): boolean {
  return "code" in state &&
    (state.code === "CONFLICT_DECLARED" || state.code === "REVIEW_UNAVAILABLE");
}

function draftValuesFor(state: ReviewerActionState): ReviewerDraftValues | undefined {
  return state.kind === "error" || state.kind === "stale" || state.kind === "reload"
    ? state.draftValues
    : undefined;
}

function ErrorSummary({
  state,
  reloadHref,
}: {
  readonly state: ReviewerActionState;
  readonly reloadHref: string;
}) {
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.kind !== "idle") summaryRef.current?.focus();
  }, [state]);
  if (state.kind === "idle") return null;
  const isFailure = state.kind === "error" || reviewerActionRequiresReload(state);
  const fieldErrors = state.kind === "error" ? state.fieldErrors : undefined;
  return (
    <div
      className={`review-feedback ${isFailure ? "review-feedback--error" : "review-feedback--success"}`}
      ref={summaryRef}
      role={isFailure ? "alert" : "status"}
      tabIndex={-1}
    >
      <strong>{isFailure ? "Action needed" : "Command accepted"}</strong>
      <p>{state.message}</p>
      {fieldErrors ? (
        <ul>
          {Object.entries(fieldErrors).map(([fieldId, message]) => (
            <li key={fieldId}>
              <a href={`#review-field-${fieldId}`}>{message}</a>
            </li>
          ))}
        </ul>
      ) : null}
      {reviewerActionRequiresReload(state) ? (
        <p>
          <a className="review-button" href={reloadHref}>
            Reload authoritative review
          </a>
        </p>
      ) : null}
    </div>
  );
}

function ConflictReasonField({
  error,
  label,
}: {
  readonly error?: string;
  readonly label: string;
}) {
  return (
    <div className="review-field">
      <label htmlFor="review-field-conflictReason">{label}</label>
      <textarea
        aria-describedby={error ? "review-error-conflictReason" : undefined}
        aria-invalid={error ? true : undefined}
        id="review-field-conflictReason"
        maxLength={1000}
        name="conflictReason"
        required
        rows={3}
      />
      <span className="review-field-help">Use proposal-focused facts; do not include applicant identity.</span>
      {error ? (
        <span className="review-field-error" id="review-error-conflictReason">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function ReviewReceipt({ receipt }: { readonly receipt: ReviewerReceiptView }) {
  return (
    <details className="review-receipt" open>
      <summary>Bound review receipt</summary>
      <div className="review-disclosure-body">
        <p className="review-eyebrow">Command receipt</p>
        <dl className="review-meta-list review-meta-list--receipt">
          <div>
            <dt>Review revision</dt>
            <dd>{receipt.reviewRevisionNumber}</dd>
          </div>
          <div>
            <dt>Completeness</dt>
            <dd>{receipt.completeness}</dd>
          </div>
          <div>
            <dt>Submission status</dt>
            <dd>{receipt.submissionStatus}</dd>
          </div>
          <div>
            <dt>Round</dt>
            <dd>{receipt.roundName}</dd>
          </div>
          <div>
            <dt>Proposal revision sequence</dt>
            <dd>{receipt.proposalRevisionSequence}</dd>
          </div>
          <div>
            <dt>Rubric version</dt>
            <dd>
              {receipt.rubricVersionNumber} · <code>{receipt.rubricVersionId}</code>
            </dd>
          </div>
        </dl>
        <p className="review-receipt__note">
          This records independent judgment evidence; it is not a program selection decision.
        </p>
      </div>
    </details>
  );
}

function BlindValue({ value }: { readonly value: ReviewerRedactedValue }): ReactNode {
  if (value === null) return <span className="review-empty-value">No response</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") {
    return <span className="review-proposal-value__text">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <ol className="review-value-list">
        {value.map((item, index) => (
          <li key={index}>
            <BlindValue value={item} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <dl className="review-value-object">
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <BlindValue value={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function valueFor(
  detail: OwnReviewAssignmentDetail,
  criterionId: string,
): ReviewEvaluationValue | undefined {
  return detail.latestReview?.evaluation.responses.find(
    (response) => response.criterionId === criterionId,
  )?.value;
}

function CriterionControl({
  criterion,
  detail,
  error,
  disabled,
  draftValue,
}: {
  readonly criterion: RubricCriterion;
  readonly detail: OwnReviewAssignmentDetail;
  readonly error?: string;
  readonly disabled: boolean;
  readonly draftValue?: string;
}) {
  const id = `review-field-${criterion.id}`;
  const guidanceId = `${id}-guidance`;
  const errorId = `${id}-error`;
  const describedBy = error ? `${guidanceId} ${errorId}` : guidanceId;
  const currentValue = valueFor(detail, criterion.id);
  const hasDraftValue = draftValue !== undefined;
  let control: ReactNode;
  if (criterion.kind === "numeric") {
    control = (
      <input
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-labelledby={`${id}-label`}
        aria-required={criterion.required}
        defaultValue={hasDraftValue ? draftValue : typeof currentValue === "number" ? currentValue : ""}
        disabled={disabled}
        id={id}
        max={criterion.maximum}
        min={criterion.minimum}
        name={`criterion:${criterion.id}`}
        step={criterion.step}
        type="number"
      />
    );
  } else if (criterion.kind === "yesNo") {
    control = (
      <div className="review-choice-row" id={id} tabIndex={-1}>
        <label>
          <input
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            defaultChecked={hasDraftValue ? draftValue === "true" : currentValue === true}
            disabled={disabled}
            name={`criterion:${criterion.id}`}
            type="radio"
            value="true"
          />
          Yes
        </label>
        <label>
          <input
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            defaultChecked={hasDraftValue ? draftValue === "false" : currentValue === false}
            disabled={disabled}
            name={`criterion:${criterion.id}`}
            type="radio"
            value="false"
          />
          No
        </label>
      </div>
    );
  } else if (
    criterion.kind === "scale" ||
    criterion.kind === "recommendation" ||
    criterion.kind === "dropdown"
  ) {
    control = (
      <select
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-labelledby={`${id}-label`}
        aria-required={criterion.required}
        defaultValue={hasDraftValue ? draftValue : typeof currentValue === "string" ? currentValue : ""}
        disabled={disabled}
        id={id}
        name={`criterion:${criterion.id}`}
      >
        <option value="">Choose an option</option>
        {criterion.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <textarea
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-labelledby={`${id}-label`}
        aria-required={criterion.required}
        defaultValue={hasDraftValue ? draftValue : typeof currentValue === "string" ? currentValue : ""}
        disabled={disabled}
        id={id}
        maxLength={criterion.maxLength}
        name={`criterion:${criterion.id}`}
        rows={5}
      />
    );
  }
  return (
    <fieldset className="review-criterion">
      <legend>
        <span id={`${id}-label`}>{criterion.label}</span>
        <span className="review-criterion__meta">
          {criterion.required ? "Required" : "Optional"} · Weight {criterion.weight}
        </span>
      </legend>
      <p className="review-field-help" id={guidanceId}>
        {criterion.guidance}
        {criterion.kind === "numeric"
          ? ` Enter ${criterion.minimum}–${criterion.maximum} in steps of ${criterion.step}.`
          : null}
      </p>
      {control}
      {error ? (
        <span className="review-field-error" id={errorId}>
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

function savedEvaluationComplete(detail: OwnReviewAssignmentDetail): boolean {
  const responses = new Map(
    detail.latestReview?.evaluation.responses.map(
      (response) => [response.criterionId, response.value] as const,
    ) ?? [],
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

export function ConflictBlockedAssignment({
  assignment,
  bindingToken,
  workspace,
}: {
  readonly assignment: OwnReviewAssignmentSummary;
  readonly bindingToken: string;
  readonly workspace: string;
}) {
  const clearAction = clearReviewerConflictAction.bind(null, bindingToken);
  const [state, formAction, pending] = useActionState(
    clearAction,
    IDLE_REVIEWER_ACTION_STATE,
  );
  const reloadHref = assignmentHref(workspace, assignment.assignmentId);
  const locked = pending || reviewerActionRequiresReload(state) || state.kind === "conflict-cleared";
  return (
    <div className="review-page review-page--assignment" data-testid="conflict-blocked-assignment">
      <Link className="review-back-link" href={`/review/${encodeURIComponent(workspace)}/queue`}>
        ← Your review queue
      </Link>
      <header className="review-page-heading">
        <p className="review-eyebrow">{assignment.roundName}</p>
        <h1>Review assignment</h1>
        <p>Conflict controls are resolved before any proposal or rubric content is released.</p>
      </header>
      <section className="review-conflict review-conflict--blocked" aria-labelledby="clear-conflict-title">
        <p className="review-status">Conflict declared — content withheld</p>
        <h2 id="clear-conflict-title">Clear the conflict only if it is resolved</h2>
        <p>
          No proposal or rubric payload is present on this page. Clearing appends a disposition
          and refreshes the authoritative assignment before content can appear.
        </p>
        <ErrorSummary state={state} reloadHref={reloadHref} />
        <form action={formAction}>
          <ConflictReasonField
            error={state.kind === "error" ? state.fieldErrors?.conflictReason : undefined}
            label="Why can this conflict be cleared?"
          />
          <button className="review-button review-button--primary" disabled={locked} type="submit">
            {pending ? "Clearing conflict…" : "Clear conflict and refresh"}
          </button>
        </form>
      </section>
    </div>
  );
}

export function ReviewAssignment({
  bindingToken,
  detail,
  workspace,
}: {
  readonly bindingToken: string;
  readonly detail: OwnReviewAssignmentDetail;
  readonly workspace: string;
}) {
  const declareAction = declareReviewerConflictAction.bind(null, bindingToken);
  const saveAction = saveReviewerRevisionAction.bind(null, bindingToken);
  const submitAction = submitReviewerRevisionAction.bind(null, bindingToken);
  const [declareState, declareFormAction, declarePending] = useActionState(
    declareAction,
    IDLE_REVIEWER_ACTION_STATE,
  );
  const [saveState, saveFormAction, savePending] = useActionState(
    saveAction,
    IDLE_REVIEWER_ACTION_STATE,
  );
  const [submitState, submitFormAction, submitPending] = useActionState(
    submitAction,
    IDLE_REVIEWER_ACTION_STATE,
  );
  const [conflictIntent, setConflictIntent] = useState(false);
  useEffect(() => {
    if (!declarePending && declareState.kind === "error") setConflictIntent(false);
  }, [declarePending, declareState.kind]);
  const reloadHref = assignmentHref(workspace, detail.assignmentId);
  const hideReviewPayload =
    conflictIntent ||
    declarePending ||
    declareState.kind === "conflict-declared" ||
    reviewerActionRequiresReload(declareState) ||
    actionWithholdsContent(saveState) ||
    actionWithholdsContent(submitState);
  const terminal = detail.assignmentState === "SUBMITTED" || submitState.kind === "submitted";
  const reviewLocked =
    terminal || reviewerActionRequiresReload(saveState) || reviewerActionRequiresReload(submitState);
  const savedComplete = useMemo(() => savedEvaluationComplete(detail), [detail]);
  const saveFieldErrors = saveState.kind === "error" ? saveState.fieldErrors : undefined;
  const saveDraftValues = draftValuesFor(saveState);
  const saveFormKey = saveDraftValues
    ? JSON.stringify(Object.entries(saveDraftValues).sort(([left], [right]) => left.localeCompare(right)))
    : "authoritative-review";

  function beginConflictDeclaration(event: FormEvent<HTMLFormElement>): void {
    if (event.currentTarget.checkValidity()) setConflictIntent(true);
  }

  function saveWithKeyboard(event: React.KeyboardEvent<HTMLFormElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  }

  const authoritativeReceipt: ReviewerReceiptView | null = terminal && detail.latestReview
    ? {
        reviewRevisionNumber: detail.latestReview.revisionNumber,
        completeness: savedComplete ? "Complete" : "Incomplete",
        submissionStatus: "Submitted",
        roundName: detail.roundName,
        proposalRevisionSequence: detail.proposal.revisionSequence,
        rubricVersionId: detail.rubric.versionId,
        rubricVersionNumber: detail.rubric.versionNumber,
      }
    : null;
  const conflictDisclosureOpen =
    conflictIntent || declarePending || declareState.kind !== "idle";

  return (
    <div className="review-page review-page--assignment" data-testid="reviewer-assignment">
      <Link className="review-back-link" href={`/review/${encodeURIComponent(workspace)}/queue`}>
        ← Your review queue
      </Link>
      <header className="review-page-heading">
        <p className="review-eyebrow">{detail.roundName}</p>
        <h1>Independent proposal review</h1>
        <p>
          Assess only the blind-safe proposal shown here. Your judgment is evidence for further
          consideration, not selection authority.
        </p>
      </header>

      <section className="review-conflict" aria-labelledby="declare-conflict-title">
        <details
          className="review-conflict__disclosure"
          open={
            detail.conflictStatus === "WAIVED" || terminal || conflictDisclosureOpen
          }
        >
          <summary id="declare-conflict-title">Declare a conflict before reviewing</summary>
          <div className="review-disclosure-body">
            <p className="review-eyebrow">Conflict check</p>
            {detail.conflictStatus === "WAIVED" ? (
              <p>The authoritative assignment records a waived conflict disposition.</p>
            ) : terminal ? (
              <p>This submitted review is terminal; conflict controls are closed.</p>
            ) : (
              <>
                <p>
                  If you cannot review independently, declare it now. Proposal and rubric content
                  will be removed as soon as declaration begins.
                </p>
                <ErrorSummary state={declareState} reloadHref={reloadHref} />
                <form action={declareFormAction} onSubmit={beginConflictDeclaration}>
                  <ConflictReasonField
                    error={
                      declareState.kind === "error"
                        ? declareState.fieldErrors?.conflictReason
                        : undefined
                    }
                    label="Why is this a conflict?"
                  />
                  <button
                    className="review-button review-button--danger"
                    disabled={declarePending || hideReviewPayload}
                    type="submit"
                  >
                    {declarePending ? "Declaring conflict…" : "Declare conflict and withhold content"}
                  </button>
                </form>
              </>
            )}
          </div>
        </details>
      </section>

      {hideReviewPayload ? (
        <section className="review-state-panel" aria-live="polite">
          <h2>Review content withheld</h2>
          <p>Reload the authoritative assignment before any proposal or rubric can appear again.</p>
        </section>
      ) : (
        <>
          <details className="review-binding">
            <summary>Technical review context</summary>
            <div className="review-disclosure-body">
              <p className="review-eyebrow">Exact review context</p>
              <h2 id="binding-title">Bound assignment</h2>
              <dl className="review-meta-list">
                <div>
                  <dt>Proposal revision sequence</dt>
                  <dd>{detail.proposal.revisionSequence}</dd>
                </div>
                <div>
                  <dt>Rubric version</dt>
                  <dd>
                    {detail.rubric.versionNumber} · <code>{detail.rubric.versionId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Latest review revision</dt>
                  <dd>{detail.latestReviewRevisionNumber || "None saved"}</dd>
                </div>
                <div>
                  <dt>Assignment status</dt>
                  <dd>{terminal ? "Submitted" : detail.assignmentState.toLowerCase().replace("_", " ")}</dd>
                </div>
              </dl>
            </div>
          </details>

          <div className="review-assignment-layout">
            <section className="review-proposal" aria-labelledby="proposal-title">
              <div className="review-section-heading">
                <p className="review-eyebrow">Blind-safe projection</p>
                <h2 id="proposal-title">Proposal</h2>
                <p>Only fields supplied by the server’s effective blind projection are rendered.</p>
              </div>
              <dl className="review-proposal-answers">
                {detail.proposal.answers.map((answer) => (
                  <div key={answer.answerKey}>
                    <dt>{answer.label}</dt>
                    <dd>
                      <BlindValue value={answer.value} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <aside className="review-assignment-secondary" aria-label="Rubric and review controls">
              {submitState.kind === "submitted" ? (
                <ReviewReceipt receipt={submitState.receipt} />
              ) : authoritativeReceipt ? (
                <ReviewReceipt receipt={authoritativeReceipt} />
              ) : saveState.kind === "saved" ? (
                <ReviewReceipt receipt={saveState.receipt} />
              ) : null}

              {!terminal ? (
                <section className="review-rubric" aria-labelledby="rubric-title">
                  <div className="review-section-heading">
                    <p className="review-eyebrow">{detail.rubric.title}</p>
                    <h2 id="rubric-title">Record independent judgment</h2>
                    <p>
                      Required and optional criteria, guidance, weights, choices, and bounds come
                      from rubric version {detail.rubric.versionNumber}. Saving always appends a new
                      review revision.
                    </p>
                  </div>
                  <ErrorSummary state={saveState} reloadHref={reloadHref} />
                  <form action={saveFormAction} key={saveFormKey} onKeyDown={saveWithKeyboard}>
                    <div className="review-criteria">
                      {detail.rubric.criteria.map((criterion) => (
                        <CriterionControl
                          criterion={criterion}
                          detail={detail}
                          disabled={reviewLocked || savePending}
                          draftValue={saveDraftValues?.[criterion.id]}
                          error={saveFieldErrors?.[criterion.id]}
                          key={criterion.id}
                        />
                      ))}
                    </div>
                    <div className="review-action-row">
                      <button
                        className="review-button review-button--primary"
                        disabled={reviewLocked || savePending}
                        type="submit"
                      >
                        {savePending ? "Saving revision…" : "Save new revision"}
                      </button>
                      <span className="review-keyboard-hint">Keyboard: Ctrl/⌘ + S</span>
                    </div>
                  </form>

                  <section className="review-submit-panel" aria-labelledby="submit-title">
                    <h3 id="submit-title">Submit the latest saved revision</h3>
                    <p>
                      Latest saved revision: {detail.latestReviewRevisionNumber || "none"} · Known
                      completeness: {savedComplete ? "complete" : "incomplete"}. Submission is
                      terminal and never saves current unsaved entries.
                    </p>
                    <ErrorSummary state={submitState} reloadHref={reloadHref} />
                    <form action={submitFormAction}>
                      <button
                        className="review-button review-button--submit"
                        disabled={
                          reviewLocked ||
                          submitPending ||
                          savePending ||
                          detail.latestReviewRevisionNumber === 0
                        }
                        type="submit"
                      >
                        {submitPending ? "Submitting saved review…" : "Submit saved review permanently"}
                      </button>
                    </form>
                  </section>
                </section>
              ) : null}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
