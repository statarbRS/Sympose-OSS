"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";

import { ProposalEvidenceLanes } from "@/components/decision-intelligence/proposal-evidence-lanes";
import {
  createOrganizerReviewRoundAction,
  createOrganizerReviewRubricAction,
  distributeOrganizerReviewAssignmentsAction,
  recordOrganizerReviewRemindersAction,
  setOrganizerReviewBlindControlAction,
  setOrganizerReviewRoundScheduleAction,
  setOrganizerReviewRoundStateAction,
  type OrganizerReviewDistributionActionState,
  type OrganizerReviewRoundActionState,
  type OrganizerReviewReminderActionState,
  type OrganizerReviewRubricActionState,
} from "@/app/w/[workspace]/events/[eventId]/review/actions";

import type {
  OrganizerReviewRubricFieldInput,
  OrganizerReviewRoundProjection,
  OrganizerReviewSort,
  OrganizerReviewSurface,
} from "@/server/services/cfp-review/organizer";
import type {
  OrganizerReviewSubmittedReview,
  OrganizerReviewSubmissionAggregate,
} from "@/server/services/cfp-review/organizer-types";
import type { OrganizerReviewBlindControl } from "@/server/services/cfp-review/review-blind-control";

import styles from "./organizer-review-console.module.css";

const IDLE_ORGANIZER_REVIEW_ROUND_ACTION = { kind: "idle" } as const;
const IDLE_ORGANIZER_REVIEW_ROUND_SCHEDULE_ACTION = { kind: "idle" } as const;
const IDLE_ORGANIZER_REVIEW_ROUND_STATE_ACTION = { kind: "idle" } as const;
const IDLE_ORGANIZER_REVIEW_RUBRIC_ACTION = { kind: "idle" } as const;
const IDLE_ORGANIZER_REVIEW_DISTRIBUTION_ACTION = { kind: "idle" } as const;
const IDLE_ORGANIZER_REVIEW_BLIND_CONTROL_ACTION = { kind: "idle" } as const;

const SORT_OPTIONS: readonly { readonly value: OrganizerReviewSort; readonly label: string }[] = [
  { value: "rank", label: "Evidence rank" },
  { value: "score", label: "Score" },
  { value: "progress", label: "Progress" },
  { value: "submission", label: "Submission" },
  { value: "reviewer", label: "Reviewer" },
];

type ScoreSortDirection = "ascending" | "descending";

type ReviewerSignal = Readonly<{
  readonly label: string;
  readonly detail: string;
  readonly tone: "neutral" | "attention";
}>;

/** Sorts only the already-projected organizer evidence; it does not mutate the projection. */
export function sortOrganizerReviewRankingsByScore(
  rankings: readonly OrganizerReviewSubmissionAggregate[],
  direction: ScoreSortDirection,
): readonly OrganizerReviewSubmissionAggregate[] {
  return [...rankings].sort((left, right) => {
    if (left.score === null && right.score !== null) return 1;
    if (left.score !== null && right.score === null) return -1;
    if (left.score !== null && right.score !== null && left.score !== right.score) {
      return direction === "ascending"
        ? left.score - right.score
        : right.score - left.score;
    }
    return left.submissionId.localeCompare(right.submissionId);
  });
}

function reviewerSignalForAggregate(
  ranking: OrganizerReviewSubmissionAggregate,
): ReviewerSignal {
  const recommendationPositions = [
    ranking.recommendationCounts.advance,
    ranking.recommendationCounts.hold,
    ranking.recommendationCounts.doNotAdvance,
  ].filter((count) => count > 0).length;

  if (ranking.submittedReviewCount === 0) {
    return {
      label: "Awaiting evidence",
      detail: "No reviewer has submitted evidence yet.",
      tone: "attention",
    };
  }
  if (recommendationPositions > 1) {
    return {
      label: "Reviewer disagreement",
      detail: "Submitted recommendations span more than one position.",
      tone: "attention",
    };
  }
  if (recommendationPositions === 1) {
    return {
      label: "Recommendations aligned",
      detail: "Submitted recommendation evidence occupies one position.",
      tone: "neutral",
    };
  }
  return {
    label: "No recommendation evidence",
    detail: "Submitted reviews contain no projected recommendation response.",
    tone: "neutral",
  };
}

function formatDateTime(value: string | null, timezone: string): string {
  if (!value) return "Not scheduled";
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function utcDateTimeLocal(value: string | null): string {
  return value?.slice(0, 16) ?? "";
}

function roundStateLabel(round: OrganizerReviewRoundProjection): string {
  switch (round.state) {
    case "DRAFT":
      return "Draft setup";
    case "OPEN":
      return "Open for review";
    case "CLOSED":
      return "Closed";
    case "CANCELLED":
      return "Cancelled";
  }
}

const AVAILABLE_CALL_STATES = new Set(["DRAFT", "SCHEDULED", "OPEN", "PAUSED"]);
const DISTRIBUTABLE_ROUND_STATES = new Set(["DRAFT", "OPEN"]);
const CLIENT_MAX_NUMBER = 1_000_000_000;
const CLIENT_MAX_LABEL_LENGTH = 512;
const CLIENT_MAX_CHOICE_VALUE_LENGTH = 128;
const CLIENT_MAX_CHOICE_LABEL_LENGTH = 512;

type SetupRubricField = OrganizerReviewRubricFieldInput & {
  readonly id: string;
};

type ReviewerOption = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly assignmentCount: number;
}>;

function availableReviewCalls(surface: OrganizerReviewSurface): readonly OrganizerReviewSurface["calls"][number][] {
  return surface.calls.filter((call) => AVAILABLE_CALL_STATES.has(call.state));
}

function textFromForm(data: FormData, name: string, maximumLength: number, fallback: string): string {
  const value = data.get(name);
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maximumLength);
}

function numberFromForm(data: FormData, name: string, fallback: number): number {
  const value = Number(data.get(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(-CLIENT_MAX_NUMBER, Math.min(CLIENT_MAX_NUMBER, value));
}

function rubricDraftForRound(round: OrganizerReviewRoundProjection | undefined): readonly SetupRubricField[] {
  const existing = round?.rubric?.fields ?? [];
  const numeric = existing.find((field) => field.kind === "numeric");
  const dropdown = existing.find((field) => field.kind === "dropdown");
  const text = existing.find((field) => field.kind === "text");
  return [
    {
      id: "criterion-quality",
      label: numeric?.label ?? "Proposal quality",
      kind: "numeric",
      required: numeric?.required ?? true,
      weight: numeric?.weight ?? 2,
      minimum: numeric?.minimum ?? 0,
      maximum: numeric?.maximum ?? 10,
      step: numeric?.step ?? 1,
    },
    {
      id: "criterion-recommendation",
      label: dropdown?.label ?? "Recommendation",
      kind: "dropdown",
      required: dropdown?.required ?? true,
      weight: dropdown?.weight ?? 1,
      recommendation: dropdown === undefined ? true : dropdown.recommendation === true,
      choices: dropdown?.choices.length
        ? dropdown.choices.slice(0, 3)
        : [
            { value: "ADVANCE", label: "Advance" },
            { value: "HOLD", label: "Hold" },
            { value: "DO_NOT_ADVANCE", label: "Do not advance" },
          ],
    },
    {
      id: "criterion-notes",
      label: text?.label ?? "Evidence notes",
      kind: "text",
      required: text?.required ?? false,
      weight: text?.weight ?? 1,
      maxLength: text?.maxLength ?? 500,
    },
  ];
}

function rubricFieldsFromForm(data: FormData): readonly SetupRubricField[] {
  const choice = (slot: number): { readonly value: string; readonly label: string } => ({
    value: textFromForm(data, `rubric-recommendation-choice-${slot}-value`, CLIENT_MAX_CHOICE_VALUE_LENGTH, ""),
    label: textFromForm(data, `rubric-recommendation-choice-${slot}-label`, CLIENT_MAX_CHOICE_LABEL_LENGTH, ""),
  });
  return [
    {
      id: "criterion-quality",
      label: textFromForm(data, "rubric-quality-label", CLIENT_MAX_LABEL_LENGTH, "Proposal quality"),
      kind: "numeric",
      required: data.get("rubric-quality-required") === "on",
      weight: numberFromForm(data, "rubric-quality-weight", 2),
      minimum: numberFromForm(data, "rubric-quality-minimum", 0),
      maximum: numberFromForm(data, "rubric-quality-maximum", 10),
      step: numberFromForm(data, "rubric-quality-step", 1),
    },
    {
      id: "criterion-recommendation",
      label: textFromForm(data, "rubric-recommendation-label", CLIENT_MAX_LABEL_LENGTH, "Recommendation"),
      kind: "dropdown",
      required: data.get("rubric-recommendation-required") === "on",
      recommendation: true,
      weight: numberFromForm(data, "rubric-recommendation-weight", 1),
      choices: [choice(1), choice(2), choice(3)],
    },
    {
      id: "criterion-notes",
      label: textFromForm(data, "rubric-notes-label", CLIENT_MAX_LABEL_LENGTH, "Evidence notes"),
      kind: "text",
      required: data.get("rubric-notes-required") === "on",
      weight: numberFromForm(data, "rubric-notes-weight", 1),
      maxLength: Math.max(1, Math.min(64 * 1024, Math.round(numberFromForm(data, "rubric-notes-max-length", 500)))),
    },
  ];
}

function serializeRubricFields(data: FormData): string {
  // This is deliberately a fixed three-field projection, not an arbitrary JSON editor.
  return JSON.stringify(rubricFieldsFromForm(data));
}

function serializeRubricForm(event: FormEvent<HTMLFormElement>): void {
  const fieldsInput = event.currentTarget.elements.namedItem("fields");
  if (!(fieldsInput instanceof HTMLInputElement)) return;
  fieldsInput.value = serializeRubricFields(new FormData(event.currentTarget));
}

function keyRoundCreateForm(event: FormEvent<HTMLFormElement>): void {
  const idempotencyInput = event.currentTarget.elements.namedItem("idempotencyKey");
  if (!(idempotencyInput instanceof HTMLInputElement)) return;
  if (idempotencyInput.value.length === 0) idempotencyInput.value = crypto.randomUUID();
}

function reviewerOptionsForSurface(
  surface: OrganizerReviewSurface,
  selectedRound: OrganizerReviewRoundProjection | undefined,
): readonly ReviewerOption[] {
  const names = new Map<string, string>();
  for (const round of surface.rounds) {
    for (const assignment of round.assignments) {
      if (!names.has(assignment.reviewerAccountId)) names.set(assignment.reviewerAccountId, assignment.reviewerName);
    }
  }
  return [...names.entries()]
    .map(([id, name]) => ({
      id,
      name,
      assignmentCount: selectedRound?.assignments.filter(
        (assignment) =>
          assignment.reviewerAccountId === id &&
          assignment.assignmentState !== "RECUSED" &&
          assignment.assignmentState !== "REVOKED",
      ).length ?? 0,
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function OrganizerReviewSetupReceipt({
  state,
  pending,
  pendingMessage,
  testId,
}: {
  readonly state:
    | OrganizerReviewRoundActionState
    | OrganizerReviewRubricActionState
    | OrganizerReviewDistributionActionState;
  readonly pending: boolean;
  readonly pendingMessage: string;
  readonly testId: string;
}) {
  if (pending) {
    return <p className={styles.receiptPending} role="status" aria-live="polite" data-testid={`${testId}-pending`}>{pendingMessage}</p>;
  }
  if (state.kind === "idle") return null;
  if (state.kind === "error") {
    return <p className={styles.receiptError} role="alert" data-testid={`${testId}-error`}>{state.message}</p>;
  }
  const receipt = state.receipt;
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    !("roundId" in receipt) ||
    typeof receipt.roundId !== "string" ||
    receipt.roundId.length === 0
  ) {
    return (
      <p className={styles.receiptError} role="alert" data-testid={`${testId}-error`}>
        The saved review receipt could not be verified. Reload the authoritative review surface.
      </p>
    );
  }
  return (
    <div className={styles.receiptSuccess} role="status" aria-live="polite" data-testid={`${testId}-success`}>
      <strong>{state.message}</strong>
      <span>Saved receipt · {state.code} · round <code>{receipt.roundId}</code></span>
      {"plan" in receipt ? (
        <span>
          {receipt.createdAssignmentIds.length} new assignment{receipt.createdAssignmentIds.length === 1 ? "" : "s"} · {receipt.existingAssignmentIds.length} already present · {receipt.plan.skippedSubmissionIds.length} submission{receipt.plan.skippedSubmissionIds.length === 1 ? "" : "s"} below requested coverage
        </span>
      ) : "fields" in receipt ? (
        <span>{receipt.fields.length} criteria sealed at version {receipt.versionNumber}.</span>
      ) : (
        <span>
          Round-owned schedule{receipt.scheduleVersion === undefined ? "" : ` v${receipt.scheduleVersion}`};
          saved independently from the CFP call.
        </span>
      )}
    </div>
  );
}

function evidenceLabel(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

function reviewHref(
  workspace: string,
  eventId: string,
  options: { readonly roundId?: string; readonly sort?: OrganizerReviewSort },
): string {
  const params = new URLSearchParams();
  if (options.roundId) params.set("round", options.roundId);
  if (options.sort) params.set("sort", options.sort);
  const query = params.toString();
  return `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(eventId)}/review${query ? `?${query}` : ""}`;
}

function SummaryStat({ label, value, detail }: { readonly label: string; readonly value: string | number; readonly detail?: string }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>
        {value}
        {detail ? <span>{detail}</span> : null}
      </dd>
    </div>
  );
}

function RoundSummary({ round }: { readonly round: OrganizerReviewRoundProjection }) {
  const progress = round.progress;
  return (
    <section className={styles.panel} aria-labelledby={`round-progress-${round.id}`}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Progress projection</p>
          <h3 id={`round-progress-${round.id}`}>Reviewer progress</h3>
        </div>
        <span className={styles.status}>{roundStateLabel(round)}</span>
      </div>
      <dl className={styles.stats}>
        <SummaryStat label="Completion" value={`${progress.completionPercent}%`} detail={`${progress.submitted} of ${progress.total} submitted`} />
        <SummaryStat label="Assigned" value={progress.assigned + progress.inProgress + progress.submitted} detail={`${progress.assigned} ready · ${progress.inProgress} in progress`} />
        <SummaryStat label="Conflicts" value={progress.conflicts} detail="Declared reviewer conflicts" />
        <SummaryStat label="Blind artifacts" value={progress.blindReady} detail={`${progress.blindPending} pending`} />
      </dl>
    </section>
  );
}

function RoundScheduleControl({
  workspace,
  round,
}: {
  readonly workspace: string;
  readonly round: OrganizerReviewRoundProjection;
}) {
  const [actionState, formAction, pending] = useActionState(
    setOrganizerReviewRoundScheduleAction,
    IDLE_ORGANIZER_REVIEW_ROUND_SCHEDULE_ACTION,
  );
  const scheduleVersion = round.schedule.version;
  const scheduleReady =
    typeof scheduleVersion === "number" &&
    Number.isSafeInteger(scheduleVersion) &&
    scheduleVersion >= 1 &&
    round.schedule.opensAt !== null &&
    round.schedule.closesAt !== null;
  const stateEditable = round.state === "DRAFT" || round.state === "OPEN";
  const editable = scheduleReady && stateEditable;

  return (
    <section
      className={styles.panel}
      aria-labelledby={`round-schedule-${round.id}`}
      data-testid={`review-round-schedule-${round.id}`}
    >
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Independent round dates</p>
          <h4 id={`round-schedule-${round.id}`}>Review window</h4>
        </div>
        <span className={styles.status}>
          {scheduleReady ? `Saved v${scheduleVersion}` : "Schedule unavailable"}
        </span>
      </div>
      <p className={styles.muted}>
        These UTC instants belong to this review round in the persisted {round.schedule.timezone}
        {" "}timezone. Saving them does not change the CFP call or any other round, and a reload
        reads the latest immutable schedule version.
      </p>
      <form
        action={formAction}
        className={styles.setupForm}
        data-action="setOrganizerReviewRoundScheduleAction"
        data-testid={`review-round-schedule-form-${round.id}`}
      >
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="eventId" value={round.eventId} />
        <input type="hidden" name="roundId" value={round.id} />
        <input type="hidden" name="expectedScheduleVersion" value={scheduleReady ? scheduleVersion : ""} />
        <input
          type="hidden"
          name="idempotencyKey"
          value={scheduleReady ? `review-round-schedule:${round.id}:after:${scheduleVersion}` : ""}
        />
        <fieldset className={styles.fieldGrid} disabled={!editable || pending}>
          <legend className={styles.srOnly}>Review-round dates in UTC</legend>
          <label className={styles.field} htmlFor={`review-round-opens-${round.id}`}>
            <span>Opens (UTC)</span>
            <input
              id={`review-round-opens-${round.id}`}
              name="opensAt"
              type="datetime-local"
              step="60"
              defaultValue={utcDateTimeLocal(round.schedule.opensAt)}
              required
            />
          </label>
          <label className={styles.field} htmlFor={`review-round-closes-${round.id}`}>
            <span>Closes (UTC)</span>
            <input
              id={`review-round-closes-${round.id}`}
              name="closesAt"
              type="datetime-local"
              step="60"
              defaultValue={utcDateTimeLocal(round.schedule.closesAt)}
              required
            />
          </label>
        </fieldset>
        {!scheduleReady ? (
          <p className={styles.disabledNote} role="note">
            The persisted schedule version could not be verified. Reload before editing this round.
          </p>
        ) : !stateEditable ? (
          <p className={styles.disabledNote} role="note">
            Closed and cancelled rounds retain their last saved schedule and cannot be edited.
          </p>
        ) : null}
        <button
          className={styles.button}
          type="submit"
          disabled={!editable || pending}
          data-testid={`save-review-round-schedule-${round.id}`}
        >
          {pending ? "Saving review window…" : "Save review window"}
        </button>
      </form>
      {actionState.kind === "success" ? (
        <p className={styles.receiptSuccess} role="status" data-testid={`review-round-schedule-success-${round.id}`}>
          {actionState.message} {actionState.receipt.opensAt} → {actionState.receipt.closesAt}
        </p>
      ) : actionState.kind === "error" ? (
        <p className={styles.receiptError} role="alert" data-testid={`review-round-schedule-error-${round.id}`}>
          {actionState.message}
        </p>
      ) : null}
    </section>
  );
}

function RoundStateControl({
  workspace,
  round,
}: {
  readonly workspace: string;
  readonly round: OrganizerReviewRoundProjection;
}) {
  const [actionState, formAction, pending] = useActionState(
    setOrganizerReviewRoundStateAction,
    IDLE_ORGANIZER_REVIEW_ROUND_STATE_ACTION,
  );
  const transitionTargets = round.state === "DRAFT"
    ? (["OPEN"] as const)
    : round.state === "OPEN"
      ? (["CLOSED", "CANCELLED"] as const)
      : ([] as const);
  const defaultReason = round.state === "DRAFT"
    ? "Open the review round for assigned reviewers."
    : "Close the review round after reviewer work is complete.";

  return (
    <section className={styles.panel} aria-labelledby={`round-state-${round.id}`} data-testid={`review-round-state-${round.id}`}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Round lifecycle</p>
          <h4 id={`round-state-${round.id}`}>Reviewer queue availability</h4>
        </div>
        <span className={styles.status}>{roundStateLabel(round)}</span>
      </div>
      <p className={styles.muted}>
        Assignments are created in draft setup and become readable by reviewers only after the
        round is explicitly opened. State events are immutable and sequence-checked.
      </p>
      {transitionTargets.length > 0 ? (
        <form action={formAction} className={styles.setupForm} data-action="setOrganizerReviewRoundStateAction">
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="eventId" value={round.eventId} />
          <input type="hidden" name="roundId" value={round.id} />
          <input type="hidden" name="expectedStateSequenceNumber" value={round.stateSequenceNumber} />
          <label className={styles.field} htmlFor={`review-round-state-${round.id}`}>
            <span>Next state</span>
            <select id={`review-round-state-${round.id}`} name="state" defaultValue={transitionTargets[0]} disabled={pending}>
              {transitionTargets.map((state) => <option key={state} value={state}>{state === "OPEN" ? "Open for reviewer work" : state === "CLOSED" ? "Close reviewer work" : "Cancel round"}</option>)}
            </select>
          </label>
          <label className={styles.field} htmlFor={`review-round-state-reason-${round.id}`}>
            <span>Reason</span>
            <input id={`review-round-state-reason-${round.id}`} name="reason" defaultValue={defaultReason} maxLength={4096} required disabled={pending} />
          </label>
          <button className={styles.button} type="submit" disabled={pending} data-testid={`set-review-round-state-${round.id}`}>
            {pending ? "Saving round state…" : round.state === "DRAFT" ? "Open reviewer queue" : "Save round state"}
          </button>
        </form>
      ) : (
        <p className={styles.disabledNote} role="note">This round is terminal; its reviewer queue is read-only.</p>
      )}
      {actionState.kind === "success" ? (
        <p className={styles.receiptSuccess} role="status" data-testid={`review-round-state-success-${round.id}`}>
          {actionState.message} Sequence {actionState.receipt.sequenceNumber}.
        </p>
      ) : actionState.kind === "error" ? (
        <p className={styles.receiptError} role="alert" data-testid={`review-round-state-error-${round.id}`}>
          {actionState.message}
        </p>
      ) : null}
    </section>
  );
}

function failClosedBlindReviewControl(round: OrganizerReviewRoundProjection): OrganizerReviewBlindControl {
  return {
    schema: "cfp-review-round-blind-control/v1",
    version: 1,
    eventId: round.eventId,
    roundId: round.id,
    mode: "BLINDED",
    enabled: true,
    organizerSeesIdentity: true,
    reviewerSeesIdentity: false,
    anonymizedFields: ["author", "coauthor", "organization"],
    disableSupported: false,
    source: "DEFAULT_FAIL_CLOSED",
    settingEventId: null,
    recordedAt: null,
    malformedEvent: false,
    explanation:
      "Review identity cannot be safely rehydrated from the existing sealed contracts, so disabling blind review is not supported for this round.",
  };
}

function BlindReviewControl({
  workspace,
  round,
}: {
  readonly workspace: string;
  readonly round: OrganizerReviewRoundProjection;
}) {
  const [actionState, formAction, pending] = useActionState(
    setOrganizerReviewBlindControlAction,
    IDLE_ORGANIZER_REVIEW_BLIND_CONTROL_ACTION,
  );
  const control = round.blindReview ?? failClosedBlindReviewControl(round);
  const recorded = control.source === "IMMUTABLE_EVENT" && control.settingEventId !== null;
  const statusLabel = recorded
    ? "Enabled · immutable event"
    : control.malformedEvent
      ? "Enabled · malformed event ignored"
      : "Enabled · fail-closed default";

  return (
    <section className={styles.blindControl} aria-labelledby={`blind-review-${round.id}`} data-testid={`blind-review-control-${round.id}`}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Per-round privacy control</p>
          <h4 id={`blind-review-${round.id}`}>Blind review / anonymize authors</h4>
        </div>
        <span className={styles.status}>{statusLabel}</span>
      </div>
      <p className={styles.muted}>
        The reviewer projection hides author, coauthor, and organization fields. This organizer
        projection continues to show those identities for review operations and decision handoff.
      </p>
      <dl className={styles.privacyGrid} aria-label="Blind-review identity visibility">
        <div>
          <dt>Organizer projection</dt>
          <dd>Author, coauthor, and organization visible</dd>
        </div>
        <div>
          <dt>Reviewer projection</dt>
          <dd>Author, coauthor, and organization hidden</dd>
        </div>
      </dl>
      <form action={formAction} className={styles.blindControlForm} data-action="setOrganizerReviewBlindControlAction">
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="eventId" value={round.eventId} />
        <input type="hidden" name="roundId" value={round.id} />
        <input type="hidden" name="enabled" value="true" />
        <input type="hidden" name="idempotencyKey" value={`review-blind-control:${round.id}:v1`} />
        <label className={styles.blindToggle} htmlFor={`blind-review-toggle-${round.id}`}>
          <input
            id={`blind-review-toggle-${round.id}`}
            type="checkbox"
            checked={control.enabled}
            disabled
            readOnly
            data-testid={`blind-review-enabled-${round.id}`}
          />
          <span>
            <strong>Blind review is enabled</strong>
            <small>Only the organizer projection may retain applicant identity.</small>
          </span>
        </label>
        <p className={styles.fieldHint}>
          {control.malformedEvent
            ? "A malformed prior setting event was ignored; the reviewer remains blinded by the fail-closed default."
            : control.explanation}
        </p>
        <button
          className={styles.button}
          type="submit"
          disabled={pending || recorded}
          data-testid={`save-blind-review-${round.id}`}
        >
          {pending
            ? "Recording blind-review setting…"
            : recorded
              ? "Blind-review setting recorded"
              : "Enable blind review / anonymize authors"}
        </button>
      </form>
      {actionState.kind === "success" ? (
        <p className={styles.receiptSuccess} role="status" data-testid={`blind-review-success-${round.id}`}>
          {actionState.message} <code>{actionState.receipt.settingEventId}</code>
        </p>
      ) : actionState.kind === "error" ? (
        <p className={styles.receiptError} role="alert" data-testid={`blind-review-error-${round.id}`}>
          {actionState.message}
        </p>
      ) : null}
    </section>
  );
}

function RubricSummary({ round }: { readonly round: OrganizerReviewRoundProjection }) {
  return (
    <section className={styles.panel} aria-labelledby={`rubric-${round.id}`}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Judgment boundary</p>
          <h4 id={`rubric-${round.id}`}>Review rubric</h4>
        </div>
        {round.rubric ? <code>{round.rubric.fingerprint.slice(0, 12)}…</code> : null}
      </div>
      {!round.rubric ? (
        <p className={styles.muted}>No rubric is sealed for this round yet. Reviewer scoring cannot begin until the rubric projection exists.</p>
      ) : (
        <>
          <ol className={styles.rubricList}>
            {round.rubric.fields.map((field) => (
              <li key={field.id}>
                <strong>{field.label}</strong>
                <span>{field.kind} · weight {field.weight} · {field.required ? "required" : "optional"}</span>
              </li>
            ))}
          </ol>
          <aside className={styles.method} aria-labelledby={`aggregate-method-${round.id}`}>
            <p className={styles.eyebrow}>Aggregate method</p>
            <h5 id={`aggregate-method-${round.id}`}>Weighted numeric evidence</h5>
            <p>
              Each valid submitted numeric response is normalized to its own scale, multiplied by
              its sealed rubric weight, then divided by the total weight of valid numeric evidence.
            </p>
            <p className={styles.formula} role="region" aria-label="Aggregate score formula" tabIndex={0}>
              <code>Σ ((response − minimum) ÷ (maximum − minimum) × weight) ÷ Σ weight × 100</code>
            </p>
            <p className={styles.weightSummary}>
              <strong>Sealed weights:</strong>{" "}
              {round.rubric.fields.map((field) => `${field.label} ${field.weight}×`).join(" · ")}
            </p>
            <p className={styles.muted}>
              Recommendations, dropdowns, comments, and organizer decisions remain separate
              evidence; they are not folded into this numeric aggregate.
            </p>
          </aside>
        </>
      )}
    </section>
  );
}

function ScoreSortControls({
  direction,
  onChange,
}: {
  readonly direction: ScoreSortDirection | null;
  readonly onChange: (direction: ScoreSortDirection) => void;
}) {
  return (
    <div className={styles.scoreSortControls} role="group" aria-label="Score sort direction">
      <span>Score order:</span>
      <button
        className={styles.sortButton}
        type="button"
        aria-pressed={direction === "ascending"}
        data-testid="score-sort-ascending"
        onClick={() => onChange("ascending")}
      >
        Ascending
      </button>
      <button
        className={styles.sortButton}
        type="button"
        aria-pressed={direction === "descending"}
        data-testid="score-sort-descending"
        onClick={() => onChange("descending")}
      >
        Descending
      </button>
    </div>
  );
}

function ProposalReviewWorkspace({ workspace, round, selectedSort }: { readonly workspace: string; readonly round: OrganizerReviewRoundProjection; readonly selectedSort: OrganizerReviewSort }) {
  const callHref = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(round.eventId)}/cfp/${encodeURIComponent(round.callId)}`;
  const exportBase = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(round.eventId)}/review/export?round=${encodeURIComponent(round.id)}&sort=${encodeURIComponent(selectedSort)}`;
  const [scoreDirection, setScoreDirection] = useState<ScoreSortDirection | null>(
    selectedSort === "score" ? "descending" : null,
  );
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(
    round.rankings[0]?.submissionId ?? null,
  );
  const visibleRankings = scoreDirection === null
    ? round.rankings
    : sortOrganizerReviewRankingsByScore(round.rankings, scoreDirection);
  const selectedRanking = visibleRankings.find(
    (ranking) => ranking.submissionId === selectedSubmissionId,
  ) ?? visibleRankings[0] ?? null;
  const selectedAssignments = selectedRanking
    ? round.assignments.filter(
        (assignment) => assignment.submissionId === selectedRanking.submissionId,
      )
    : [];
  const selectedSignal = selectedRanking
    ? reviewerSignalForAggregate(selectedRanking)
    : null;
  const selectedDetailId = `proposal-detail-${round.id}`;

  return (
    <section
      className={`${styles.panel} ${styles.proposalWorkspace}`}
      aria-labelledby={`proposals-${round.id}`}
      data-testid="proposal-review-workspace"
    >
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Primary evidence</p>
          <h3 id={`proposals-${round.id}`}>Unresolved proposals</h3>
        </div>
        <span className={styles.status}>{round.rankings.length} proposal{round.rankings.length === 1 ? "" : "s"}</span>
      </div>
      <p className={styles.muted}>
        Inspect exact proposal and reviewer evidence before setup administration. This surface
        records no decision; review scores, ranks, and recommendations remain candidate evidence.
      </p>
      {visibleRankings.length === 0 ? (
        <p className={styles.empty}>No submitted applications are ready for this round&apos;s aggregate projection.</p>
      ) : (
        <>
          <div className={styles.reviewWorkspace}>
            <section className={styles.proposalQueue} aria-labelledby={`proposal-queue-${round.id}`}>
              <div className={styles.queueHeading}>
                <div>
                  <p className={styles.eyebrow}>Proposal queue</p>
                  <h4 id={`proposal-queue-${round.id}`}>Choose evidence to inspect</h4>
                </div>
                <span>{visibleRankings.length}</span>
              </div>
              <label className={styles.proposalSelect} htmlFor={`proposal-select-${round.id}`}>
                <span>Proposal to inspect</span>
                <select
                  id={`proposal-select-${round.id}`}
                  value={selectedRanking?.submissionId ?? ""}
                  onChange={(event) => setSelectedSubmissionId(event.target.value)}
                >
                  {visibleRankings.map((ranking) => (
                    <option key={ranking.submissionId} value={ranking.submissionId}>
                      {ranking.applicant.displayName} · {ranking.submittedReviewCount}/{ranking.assignedReviewCount} reviews
                    </option>
                  ))}
                </select>
              </label>
              <ul className={styles.proposalQueueList}>
                {visibleRankings.map((ranking) => {
                  const signal = reviewerSignalForAggregate(ranking);
                  const selected = ranking.submissionId === selectedRanking?.submissionId;
                  return (
                    <li key={ranking.submissionId}>
                      <button
                        type="button"
                        className={styles.proposalQueueButton}
                        aria-controls={selectedDetailId}
                        aria-pressed={selected}
                        data-testid="proposal-queue-item"
                        data-submission-id={ranking.submissionId}
                        onClick={() => setSelectedSubmissionId(ranking.submissionId)}
                      >
                        <span className={styles.queueIdentity}>
                          <strong>{ranking.applicant.displayName}</strong>
                          <small>{ranking.applicant.organization ?? "Organization not recorded"}</small>
                        </span>
                        <span className={styles.queueEvidence}>
                          <span>{ranking.score === null ? "No review score" : `${ranking.score} review score`}</span>
                          <span>{ranking.submittedReviewCount}/{ranking.assignedReviewCount} reviews</span>
                        </span>
                        <span className={signal.tone === "attention" ? styles.signalAttention : styles.signalNeutral}>
                          {signal.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            {selectedRanking && selectedSignal ? (
              <section
                className={styles.proposalDetail}
                id={selectedDetailId}
                aria-labelledby={`selected-proposal-${round.id}`}
                data-testid="selected-proposal-detail"
                data-selected-submission-id={selectedRanking.submissionId}
              >
                <header className={styles.proposalDetailHeader}>
                  <div>
                    <p className={styles.eyebrow}>Selected proposal · organizer-private projection</p>
                    <h4 id={`selected-proposal-${round.id}`}>{selectedRanking.applicant.displayName}</h4>
                    <p>
                      {selectedRanking.applicant.organization ?? "Organization not recorded"}
                      <span aria-hidden="true"> · </span>
                      <code>{selectedRanking.submissionId}</code>
                    </p>
                  </div>
                  <span className={styles.status}>Organizer decision separate</span>
                </header>

                <dl className={styles.proposalMetrics} aria-label="Selected proposal aggregate evidence">
                  <SummaryStat label="Evidence rank" value={selectedRanking.evidenceRank ?? "—"} detail="Candidate ordering only" />
                  <SummaryStat label="Transparent review score" value={selectedRanking.score ?? "—"} detail={selectedRanking.scoreBasis === "submitted-review-evidence" ? "Visible reviewer evidence · no decision authority" : "No submitted evidence"} />
                  <SummaryStat label="Review progress" value={`${selectedRanking.completionPercent}%`} detail={`${selectedRanking.submittedReviewCount} of ${selectedRanking.assignedReviewCount} submitted`} />
                  <SummaryStat label="Reviewer signal" value={selectedSignal.label} detail={selectedSignal.detail} />
                </dl>

                <ProposalEvidenceLanes
                  ranking={selectedRanking}
                  assignments={selectedAssignments}
                />

                <div className={styles.recommendationLedger}>
                  <div>
                    <p className={styles.eyebrow}>Recommendation evidence</p>
                    <strong>
                      Advance {selectedRanking.recommendationCounts.advance}
                      <span aria-hidden="true"> · </span>
                      Hold {selectedRanking.recommendationCounts.hold}
                      <span aria-hidden="true"> · </span>
                      Do not advance {selectedRanking.recommendationCounts.doNotAdvance}
                    </strong>
                  </div>
                  <div>
                    <p className={styles.eyebrow}>Exceptions</p>
                    <strong>{selectedRanking.conflictCount} conflicts · {selectedRanking.blindPendingCount} blind artifacts pending</strong>
                  </div>
                </div>

                <section className={styles.reviewerEvidence} aria-labelledby={`reviewer-evidence-${round.id}`}>
                  <div className={styles.reviewerEvidenceHeading}>
                    <div>
                      <p className={styles.eyebrow}>Independent reviewer detail</p>
                      <h5 id={`reviewer-evidence-${round.id}`}>Reviewer evidence</h5>
                    </div>
                    <span>{selectedAssignments.length} assignment{selectedAssignments.length === 1 ? "" : "s"}</span>
                  </div>
                  {selectedAssignments.length === 0 ? (
                    <p className={styles.empty}>No reviewer assignment is projected for this proposal.</p>
                  ) : (
                    <ul className={styles.reviewerEvidenceList}>
                      {selectedAssignments.map((assignment) => (
                        <li key={assignment.id} className={styles.reviewerEvidenceItem}>
                          <header>
                            <div>
                              <strong>{assignment.reviewerName}</strong>
                              <span>{assignment.assignmentState.toLowerCase().replaceAll("_", " ")}</span>
                            </div>
                            <span className={styles.status}>
                              {assignment.conflictStatus === "DECLARED" ? "Conflict declared" : "No declared conflict"}
                            </span>
                          </header>
                          <dl>
                            <div><dt>Review revision</dt><dd>{assignment.latestReviewRevisionNumber || "None saved"}</dd></div>
                            <div><dt>Blind artifact</dt><dd>{assignment.blindArtifactReady ? "Ready" : "Pending"}</dd></div>
                          </dl>
                          <SubmittedReviewDetail review={assignment.latestSubmittedReview} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <div className={styles.decisionHandoff} role="note">
                  <div>
                    <strong>Decision handoff</strong>
                    <span>Inspect the persisted CFP evidence before authoring any organizer decision outside this review projection.</span>
                  </div>
                  <Link className={styles.button} href={callHref}>Review submission evidence</Link>
                </div>
              </section>
            ) : null}
          </div>

          <div className={`${styles.actionLinks} ${styles.workspaceActions}`}>
            <Link className={styles.buttonSecondary} href={`${exportBase}&format=csv`}>Download CSV</Link>
            <Link className={styles.buttonSecondary} href={`${exportBase}&format=json`}>Download JSON</Link>
            <Link className={styles.button} href={callHref}>Open CFP evidence</Link>
          </div>

          <div className={styles.evidenceControls}>
            <nav className={styles.sortNav} aria-label={`Sort ${round.name} aggregates`}>
              <span>Sort evidence:</span>
              {SORT_OPTIONS.map((option) => (
                <Link
                  key={option.value}
                  aria-current={selectedSort === option.value ? "page" : undefined}
                  className={styles.sortLink}
                  href={reviewHref(workspace, round.eventId, { roundId: round.id, sort: option.value })}
                >
                  {option.label}
                </Link>
              ))}
            </nav>
            <ScoreSortControls direction={scoreDirection} onChange={setScoreDirection} />
            <p className={styles.sortHelp} role="status">
              {scoreDirection === null
                ? "Choose ascending or descending to reorder the rendered evidence by score."
                : `Showing rendered evidence in ${scoreDirection} score order. This view-only sort does not change review evidence.`}
            </p>
          </div>

          <details className={styles.aggregateDisclosure}>
            <summary>Compare all aggregate evidence ({visibleRankings.length})</summary>
            <div className={styles.tableWrap} role="region" aria-label="Aggregate review results" tabIndex={0}>
              <table className={styles.table} data-testid="aggregate-results">
                <caption>Submission aggregates from independent review evidence</caption>
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Applicant</th>
                    <th scope="col">Score</th>
                    <th scope="col">Progress</th>
                    <th scope="col">Recommendations</th>
                    <th scope="col">Conflicts</th>
                    <th scope="col">Handoff</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRankings.map((ranking) => (
                    <tr key={ranking.submissionId} data-testid="aggregate-row" data-submission-id={ranking.submissionId}>
                      <td data-label="Rank">{ranking.evidenceRank ?? "—"}</td>
                      <td data-label="Applicant"><strong>{ranking.applicant.displayName}</strong><small>{ranking.applicant.organization ?? "Organization not recorded"}</small></td>
                      <td data-label="Score">{ranking.score ?? "—"}<small>{ranking.scoreBasis === "submitted-review-evidence" ? "Submitted evidence" : "No submitted evidence"}</small></td>
                      <td data-label="Progress">{ranking.submittedReviewCount}/{ranking.assignedReviewCount}<small>{ranking.completionPercent}% complete</small></td>
                      <td data-label="Recommendations">A {ranking.recommendationCounts.advance} · H {ranking.recommendationCounts.hold} · D {ranking.recommendationCounts.doNotAdvance}</td>
                      <td data-label="Conflicts">{ranking.conflictCount}<small>{ranking.blindPendingCount} blind pending</small></td>
                      <td data-label="Handoff"><Link href={callHref}>Review submission evidence</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function SubmittedReviewDetail({ review }: { readonly review?: OrganizerReviewSubmittedReview | null }) {
  if (!review) {
    return <p className={styles.noSubmittedReview}>No submitted review is available for this assignment.</p>;
  }
  return (
    <div className={styles.reviewDetail} data-testid="submitted-review-detail">
      <div className={styles.reviewDetailHeader}>
        <strong>Submitted review</strong>
        <span>Revision {review.revisionNumber}</span>
      </div>
      <ul className={styles.reviewDetailList}>
        {review.criteria.map((criterion) => (
          <li key={criterion.criterionId} className={styles.reviewDetailItem} data-criterion-id={criterion.criterionId}>
            <div className={styles.reviewDetailLabel}>
              <strong>{criterion.label}</strong>
              <span>{criterion.kind}</span>
            </div>
            <p className={styles.reviewDetailValue}>
              {criterion.value === null ? "Not provided" : criterion.choiceLabel ?? String(criterion.value)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssignmentTable({ round }: { readonly round: OrganizerReviewRoundProjection }) {
  return (
    <section className={styles.panel} aria-labelledby={`assignments-${round.id}`}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Assignment ledger</p>
          <h4 id={`assignments-${round.id}`}>Reviewer assignments</h4>
        </div>
        <span className={styles.muted}>{round.assignments.length} total</span>
      </div>
      {round.assignments.length === 0 ? (
        <p className={styles.empty}>No reviewer assignments are materialized for this round.</p>
      ) : (
        <div
          className={styles.tableWrap}
          role="region"
          aria-label="Reviewer assignment ledger"
          tabIndex={0}
        >
          <table className={styles.table}>
            <caption>Organizer-visible assignment and conflict projection</caption>
            <thead><tr><th scope="col">Applicant</th><th scope="col">Reviewer</th><th scope="col">State</th><th scope="col">Conflict</th><th scope="col">Review revision</th><th scope="col">Blind artifact</th><th scope="col">Submitted review</th></tr></thead>
            <tbody>{round.assignments.map((assignment) => (
              <tr key={assignment.id}>
                <td data-label="Applicant"><strong>{assignment.applicant.displayName}</strong><small>{assignment.applicant.organization ?? "Organization not recorded"}</small></td>
                <td data-label="Reviewer">{assignment.reviewerName}</td>
                <td data-label="State"><span className={styles.status}>{assignment.assignmentState}</span></td>
                <td data-label="Conflict">{assignment.conflictStatus === "DECLARED" ? "Declared" : assignment.conflictStatus.toLowerCase()}</td>
                <td data-label="Review revision">{assignment.latestReviewRevisionNumber || "None saved"}</td>
                <td data-label="Blind artifact">{assignment.blindArtifactReady ? "Ready" : "Pending"}</td>
                <td data-label="Submitted review"><SubmittedReviewDetail review={assignment.latestSubmittedReview} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EvidenceLedger({ round }: { readonly round: OrganizerReviewRoundProjection }) {
  return (
    <details className={styles.evidence}>
      <summary>Local review evidence ({round.localEvidence.length})</summary>
      {round.localEvidence.length === 0 ? <p className={styles.muted}>No local evidence receipts recorded.</p> : (
        <ul>
          {round.localEvidence.map((evidence) => (
            <li key={`${evidence.kind}-${evidence.fingerprint}`}>
              <strong>{evidenceLabel(evidence.kind)}</strong> · <time dateTime={evidence.recordedAt}>{formatDateTime(evidence.recordedAt, round.schedule.timezone)}</time> · <code>{evidence.fingerprint.slice(0, 12)}…</code>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

const INITIAL_REMINDER_ACTION_STATE: OrganizerReviewReminderActionState = { kind: "idle" };

function ReminderPanel({ workspace, round }: { readonly workspace: string; readonly round: OrganizerReviewRoundProjection }) {
  const [actionState, formAction, pending] = useActionState(
    recordOrganizerReviewRemindersAction,
    INITIAL_REMINDER_ACTION_STATE,
  );
  return (
    <section className={styles.panel} aria-labelledby={`reminders-${round.id}`}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Operational projection</p>
          <h4 id={`reminders-${round.id}`}>Reviewer reminders</h4>
        </div>
        <span className={styles.muted}>{round.reminders.length} pending</span>
      </div>
      <p className={styles.muted}>
        Reminder status is simulated local evidence for this review room. It does not send email,
        call a provider, or change reviewer assignments.
      </p>
      <form action={formAction} className={styles.actionLinks}>
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="eventId" value={round.eventId} />
        <input type="hidden" name="roundId" value={round.id} />
        <button
          className={styles.button}
          type="submit"
          disabled={pending || round.reminders.length === 0}
          data-testid={`record-review-reminders-${round.id}`}
        >
          {pending ? "Recording simulated reminders…" : "Record simulated reminders"}
        </button>
      </form>
      {actionState.kind === "success" ? (
        <p className={styles.muted} role="status" data-testid={`review-reminder-success-${round.id}`}>
          {actionState.message}
        </p>
      ) : actionState.kind === "error" ? (
        <p className={styles.muted} role="alert" data-testid={`review-reminder-error-${round.id}`}>
          {actionState.message}
        </p>
      ) : null}
      {round.reminders.length === 0 ? (
        <p className={styles.empty}>No reminder is currently due for this round.</p>
      ) : (
        <div
          className={styles.tableWrap}
          role="region"
          aria-label="Review reminder projection"
          tabIndex={0}
        >
          <table className={styles.table}>
            <caption>Local reminder projection</caption>
            <thead><tr><th scope="col">Reviewer</th><th scope="col">Submission</th><th scope="col">Status</th><th scope="col">Due</th><th scope="col">Channel</th></tr></thead>
            <tbody>{round.reminders.map((reminder) => (
              <tr key={reminder.assignmentId}>
                <td data-label="Reviewer">{reminder.reviewerName}</td>
                <td data-label="Submission"><code>{reminder.submissionId}</code></td>
                <td data-label="Status"><span className={styles.status}>{reminder.status}</span><small>{reminder.reason}</small></td>
                <td data-label="Due">{formatDateTime(reminder.dueAt, round.schedule.timezone)}</td>
                <td data-label="Channel">{reminder.channel} only</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ReviewSetupPanel({
  workspace,
  surface,
}: {
  readonly workspace: string;
  readonly surface: OrganizerReviewSurface;
}) {
  const [roundActionState, roundFormAction, roundPending] = useActionState(
    createOrganizerReviewRoundAction,
    IDLE_ORGANIZER_REVIEW_ROUND_ACTION,
  );
  const [rubricActionState, rubricFormAction, rubricPending] = useActionState(
    createOrganizerReviewRubricAction,
    IDLE_ORGANIZER_REVIEW_RUBRIC_ACTION,
  );
  const [distributionActionState, distributionFormAction, distributionPending] = useActionState(
    distributeOrganizerReviewAssignmentsAction,
    IDLE_ORGANIZER_REVIEW_DISTRIBUTION_ACTION,
  );

  const initialRoundId = surface.selectedRoundId ?? surface.rounds[0]?.id ?? null;
  const [setupRoundId, setSetupRoundId] = useState<string | null>(initialRoundId);
  const createdRoundId =
    roundActionState.kind === "success" &&
    roundActionState.receipt !== null &&
    typeof roundActionState.receipt === "object" &&
    "roundId" in roundActionState.receipt &&
    typeof roundActionState.receipt.roundId === "string"
      ? roundActionState.receipt.roundId
      : null;
  const selectedRound = surface.rounds.find((round) => round.id === setupRoundId) ?? surface.rounds[0];
  const scorecardRoundId = selectedRound?.id ?? createdRoundId;
  const calls = availableReviewCalls(surface);
  const reviewers = reviewerOptionsForSurface(surface, selectedRound);
  const submissions = selectedRound?.rankings ?? [];
  const rubricDefaults = rubricDraftForRound(selectedRound);
  const numeric = rubricDefaults[0]!;
  const recommendation = rubricDefaults[1]!;
  const notes = rubricDefaults[2]!;
  const recommendationChoices = [0, 1, 2].map((index) => recommendation.choices?.[index] ?? {
    value: index === 0 ? "ADVANCE" : index === 1 ? "HOLD" : "DO_NOT_ADVANCE",
    label: index === 0 ? "Advance" : index === 1 ? "Hold" : "Do not advance",
  });
  const distributionBlockedReason = !selectedRound
    ? "Create and reload a review round before selecting submissions and reviewers."
    : !DISTRIBUTABLE_ROUND_STATES.has(selectedRound.state)
      ? "This round is not in a draft or open state for distribution."
      : !selectedRound.rubric
        ? "Save a scorecard for this round before distributing assignments."
        : reviewers.length === 0
          ? "No reviewer account is present in the current organizer review projection. Existing reviewer assignments are required to choose a real pool."
          : submissions.length === 0
            ? "No submitted CFP applications are present for this round's call."
            : null;
  const canDistribute = distributionBlockedReason === null;

  useEffect(() => {
    const preferredRoundId = surface.selectedRoundId ?? createdRoundId ?? surface.rounds[0]?.id ?? null;
    if (preferredRoundId && surface.rounds.some((round) => round.id === preferredRoundId)) {
      setSetupRoundId(preferredRoundId);
    } else if (surface.rounds.length === 0) {
      setSetupRoundId(null);
    }
  }, [createdRoundId, surface.rounds, surface.selectedRoundId]);

  return (
    <section className={styles.setupPanel} aria-labelledby="review-setup-title" data-testid="review-setup-console">
      <header className={styles.setupHeader}>
        <div>
          <p className={styles.eyebrow}>Bounded review setup</p>
          <h3 id="review-setup-title">Create and configure a review round</h3>
          <p className={styles.muted}>
            This console writes only through the review setup actions. Each round persists its own
            opening and closing dates, independently from its CFP call and sibling rounds.
          </p>
        </div>
        <span className={styles.status}>{surface.rounds.length} saved round{surface.rounds.length === 1 ? "" : "s"}</span>
      </header>

      <div className={styles.setupGrid}>
        <section className={styles.setupCard} aria-labelledby="review-round-setup-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>Step 1</p>
              <h4 id="review-round-setup-title">Name the round</h4>
            </div>
            <span className={styles.kindBadge}>Round-owned schedule</span>
          </div>
          {calls.length === 0 ? (
            <p className={styles.empty} data-testid="review-round-call-empty">
              {surface.calls.length === 0
                ? "No CFP call is available. Create an applicant-facing call before configuring review."
                : "No active CFP call is available for a new review round."}
            </p>
          ) : (
            <form
              action={roundFormAction}
              className={styles.setupForm}
              data-action="createOrganizerReviewRoundAction"
              data-idempotency="generated-on-submit"
              data-testid="review-round-form"
              key={`review-round-create-${surface.rounds.length}`}
              onSubmit={keyRoundCreateForm}
            >
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="eventId" value={surface.eventId} />
              <input type="hidden" name="idempotencyKey" defaultValue="" />
              <label className={styles.field} htmlFor="review-round-call">
                <span>Available CFP call</span>
                <select id="review-round-call" name="callId" defaultValue={calls[0]!.id} required>
                  {calls.map((call) => <option key={call.id} value={call.id}>{call.name} · {call.state} · {call.timezone}</option>)}
                </select>
              </label>
              <label className={styles.field} htmlFor="review-round-name">
                <span>Review round name</span>
                <input id="review-round-name" name="name" maxLength={512} placeholder="e.g. First screening" required />
              </label>
              <div className={styles.fieldGrid}>
                <label className={styles.field} htmlFor="review-round-opens-at">
                  <span>Round opens (UTC)</span>
                  <input
                    id="review-round-opens-at"
                    name="opensAt"
                    type="datetime-local"
                    step="60"
                    defaultValue={calls[0]!.opensAt ? utcDateTimeLocal(calls[0]!.opensAt) : undefined}
                    required
                  />
                </label>
                <label className={styles.field} htmlFor="review-round-closes-at">
                  <span>Round closes (UTC)</span>
                  <input
                    id="review-round-closes-at"
                    name="closesAt"
                    type="datetime-local"
                    step="60"
                    defaultValue={calls[0]!.closesAt ? utcDateTimeLocal(calls[0]!.closesAt) : undefined}
                    required
                  />
                </label>
              </div>
              <p className={styles.fieldHint}>
                Call dates are starting suggestions only. Dates are submitted as explicit UTC
                instants; the selected call&apos;s existing IANA timezone is retained for this round.
              </p>
              <button className={styles.button} type="submit" disabled={roundPending} data-testid="create-review-round">
                {roundPending ? "Saving review round…" : "Create review round"}
              </button>
            </form>
          )}
          <OrganizerReviewSetupReceipt
            state={roundActionState}
            pending={roundPending}
            pendingMessage="Saving the named draft round…"
            testId="review-round-receipt"
          />
        </section>

        <section className={styles.setupCard} aria-labelledby="review-rubric-setup-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>Step 2</p>
              <h4 id="review-rubric-setup-title">Define the scorecard</h4>
            </div>
            {selectedRound?.rubric ? <span className={styles.kindBadge}>Saved v{selectedRound.rubric.versionNumber}</span> : null}
          </div>
          {surface.rounds.length > 0 ? (
            <label className={styles.field} htmlFor="review-setup-round">
              <span>Round to configure</span>
              <select
                id="review-setup-round"
                value={selectedRound?.id ?? ""}
                onChange={(event) => setSetupRoundId(event.target.value || null)}
              >
                {surface.rounds.map((round) => <option key={round.id} value={round.id}>{round.name} · {roundStateLabel(round)}</option>)}
              </select>
            </label>
          ) : createdRoundId ? (
            <p className={styles.fieldHint}>Round receipt <code>{createdRoundId}</code> is saved; reload the projection to load its submitted applications.</p>
          ) : null}
          {scorecardRoundId ? (
            <form
              action={rubricFormAction}
              className={styles.setupForm}
              data-action="createOrganizerReviewRubricAction"
              data-serialization="bounded-fixed-rubric-v1"
              data-testid="review-rubric-form"
              key={`rubric-${scorecardRoundId}-${selectedRound?.rubric?.fingerprint ?? "new"}`}
              onSubmit={serializeRubricForm}
            >
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="eventId" value={surface.eventId} />
              <input type="hidden" name="roundId" value={scorecardRoundId} />
              <input type="hidden" name="idempotencyKey" value={`review-rubric:${scorecardRoundId}:v1`} />
              <input type="hidden" name="fields" defaultValue={JSON.stringify(rubricDefaults)} />
              <p className={styles.fieldHint}>
                Three bounded criteria are shown: numeric, dropdown, and text. Labels and settings are serialized from these named controls only.
              </p>
              <fieldset className={styles.criteriaList}>
                <legend className={styles.srOnly}>Review scorecard criteria</legend>
                <article className={styles.criteriaCard} data-rubric-kind="numeric">
                  <header className={styles.criteriaHeader}>
                    <div><strong>Numeric criterion</strong><span>Score within explicit bounds</span></div>
                    <span className={styles.kindBadge}>numeric</span>
                  </header>
                  <div className={styles.fieldGrid}>
                    <label className={styles.field} htmlFor="rubric-quality-label"><span>Label</span><input id="rubric-quality-label" name="rubric-quality-label" defaultValue={numeric.label} maxLength={CLIENT_MAX_LABEL_LENGTH} required /></label>
                    <label className={styles.field} htmlFor="rubric-quality-weight"><span>Weight</span><input id="rubric-quality-weight" name="rubric-quality-weight" type="number" min="0.01" max="100000" step="0.01" defaultValue={numeric.weight} required /></label>
                    <label className={styles.field} htmlFor="rubric-quality-minimum"><span>Minimum</span><input id="rubric-quality-minimum" name="rubric-quality-minimum" type="number" min={-CLIENT_MAX_NUMBER} max={CLIENT_MAX_NUMBER} step="any" defaultValue={numeric.minimum} required /></label>
                    <label className={styles.field} htmlFor="rubric-quality-maximum"><span>Maximum</span><input id="rubric-quality-maximum" name="rubric-quality-maximum" type="number" min={-CLIENT_MAX_NUMBER} max={CLIENT_MAX_NUMBER} step="any" defaultValue={numeric.maximum} required /></label>
                    <label className={styles.field} htmlFor="rubric-quality-step"><span>Step</span><input id="rubric-quality-step" name="rubric-quality-step" type="number" min="0.01" max={CLIENT_MAX_NUMBER} step="any" defaultValue={numeric.step} required /></label>
                    <label className={styles.checkboxField} htmlFor="rubric-quality-required"><input id="rubric-quality-required" name="rubric-quality-required" type="checkbox" defaultChecked={numeric.required} /><span>Required</span></label>
                  </div>
                </article>
                <article className={styles.criteriaCard} data-rubric-kind="dropdown">
                  <header className={styles.criteriaHeader}>
                    <div><strong>Dropdown criterion</strong><span>Choose one bounded option</span></div>
                    <span className={styles.kindBadge}>dropdown</span>
                  </header>
                  <div className={styles.fieldGrid}>
                    <label className={styles.field} htmlFor="rubric-recommendation-label"><span>Label</span><input id="rubric-recommendation-label" name="rubric-recommendation-label" defaultValue={recommendation.label} maxLength={CLIENT_MAX_LABEL_LENGTH} required /></label>
                    <label className={styles.field} htmlFor="rubric-recommendation-weight"><span>Weight</span><input id="rubric-recommendation-weight" name="rubric-recommendation-weight" type="number" min="0.01" max="100000" step="0.01" defaultValue={recommendation.weight} required /></label>
                    <label className={styles.checkboxField} htmlFor="rubric-recommendation-required"><input id="rubric-recommendation-required" name="rubric-recommendation-required" type="checkbox" defaultChecked={recommendation.required} /><span>Required</span></label>
                  </div>
                  <div className={styles.choiceList} aria-label="Dropdown choices">
                    {recommendationChoices.map((choice, index) => (
                      <div className={styles.choiceRow} key={index}>
                        <label className={styles.field} htmlFor={`rubric-recommendation-choice-${index + 1}-value`}><span>Choice {index + 1} value</span><input id={`rubric-recommendation-choice-${index + 1}-value`} name={`rubric-recommendation-choice-${index + 1}-value`} defaultValue={choice.value} maxLength={CLIENT_MAX_CHOICE_VALUE_LENGTH} required /></label>
                        <label className={styles.field} htmlFor={`rubric-recommendation-choice-${index + 1}-label`}><span>Choice {index + 1} label</span><input id={`rubric-recommendation-choice-${index + 1}-label`} name={`rubric-recommendation-choice-${index + 1}-label`} defaultValue={choice.label} maxLength={CLIENT_MAX_CHOICE_LABEL_LENGTH} required /></label>
                      </div>
                    ))}
                  </div>
                </article>
                <article className={styles.criteriaCard} data-rubric-kind="text">
                  <header className={styles.criteriaHeader}>
                    <div><strong>Text criterion</strong><span>Capture bounded written evidence</span></div>
                    <span className={styles.kindBadge}>text</span>
                  </header>
                  <div className={styles.fieldGrid}>
                    <label className={styles.field} htmlFor="rubric-notes-label"><span>Label</span><input id="rubric-notes-label" name="rubric-notes-label" defaultValue={notes.label} maxLength={CLIENT_MAX_LABEL_LENGTH} required /></label>
                    <label className={styles.field} htmlFor="rubric-notes-weight"><span>Weight</span><input id="rubric-notes-weight" name="rubric-notes-weight" type="number" min="0.01" max="100000" step="0.01" defaultValue={notes.weight} required /></label>
                    <label className={styles.field} htmlFor="rubric-notes-max-length"><span>Text max length</span><input id="rubric-notes-max-length" name="rubric-notes-max-length" type="number" min="1" max={64 * 1024} step="1" defaultValue={notes.maxLength} required /></label>
                    <label className={styles.checkboxField} htmlFor="rubric-notes-required"><input id="rubric-notes-required" name="rubric-notes-required" type="checkbox" defaultChecked={notes.required} /><span>Required</span></label>
                  </div>
                </article>
              </fieldset>
              <button className={styles.button} type="submit" disabled={rubricPending} data-testid="save-review-rubric">
                {rubricPending ? "Saving scorecard…" : selectedRound?.rubric ? "Save new scorecard version" : "Save review scorecard"}
              </button>
            </form>
          ) : (
            <p className={styles.empty} data-testid="review-rubric-empty">Create a named round first; its saved projection will appear here after reload.</p>
          )}
          <OrganizerReviewSetupReceipt
            state={rubricActionState}
            pending={rubricPending}
            pendingMessage="Sealing the bounded scorecard…"
            testId="review-rubric-receipt"
          />
        </section>

        <section className={styles.setupCard} aria-labelledby="review-distribution-setup-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>Step 3</p>
              <h4 id="review-distribution-setup-title">Distribute automatically</h4>
            </div>
            <span className={styles.kindBadge}>Round-scoped</span>
          </div>
          {selectedRound ? (
            <form
              action={distributionFormAction}
              className={styles.setupForm}
              data-action="distributeOrganizerReviewAssignmentsAction"
              data-testid="review-distribution-form"
              key={`distribution-${selectedRound.id}-${selectedRound.progress.total}-${selectedRound.rubric?.fingerprint ?? "none"}`}
            >
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="eventId" value={surface.eventId} />
              <input type="hidden" name="roundId" value={selectedRound.id} />
              <input type="hidden" name="poolId" value={`reviewer-pool-${selectedRound.id}`} />
              <input type="hidden" name="idempotencyKey" value={`review-distribution:${selectedRound.id}:v1`} />
              <fieldset className={styles.distributionFieldset} disabled={!canDistribute || distributionPending}>
                <legend className={styles.srOnly}>Reviewer pool and distribution settings</legend>
                <div className={styles.distributionGrid}>
                  <div>
                    <h5>Explicit reviewer pool</h5>
                    <p className={styles.fieldHint}>Only reviewer IDs already visible in this organizer projection are selectable.</p>
                    {reviewers.length === 0 ? (
                      <p className={styles.empty} data-testid="reviewer-pool-empty">No projected reviewer accounts are available.</p>
                    ) : (
                      <ul className={styles.selectionList}>
                        {reviewers.map((reviewer) => (
                          <li key={reviewer.id} className={styles.selectionItem}>
                            <label className={styles.selectionLabel} htmlFor={`pool-reviewer-${reviewer.id}`}>
                              <input id={`pool-reviewer-${reviewer.id}`} name="poolReviewerAccountId" type="checkbox" value={reviewer.id} defaultChecked data-reviewer-id={reviewer.id} />
                              <span><strong>{reviewer.name}</strong><small><code>{reviewer.id}</code> · {reviewer.assignmentCount} existing assignment{reviewer.assignmentCount === 1 ? "" : "s"} in this round</small></span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                    <label className={styles.field} htmlFor="pool-max-assignments"><span>Pool assignment cap</span><input id="pool-max-assignments" name="poolMaxAssignments" type="number" min="1" max={4096 * Math.max(1, reviewers.length)} step="1" defaultValue={Math.max(1, reviewers.length * 2)} required /></label>
                  </div>
                  <div>
                    <h5>Submitted applications</h5>
                    <p className={styles.fieldHint}>Applications are the submitted rows projected for the selected round&apos;s CFP call.</p>
                    {submissions.length === 0 ? (
                      <p className={styles.empty} data-testid="review-submission-empty">No submitted CFP applications are available.</p>
                    ) : (
                      <ul className={styles.selectionList}>
                        {submissions.map((submission) => (
                          <li key={submission.submissionId} className={styles.selectionItem}>
                            <label className={styles.selectionLabel} htmlFor={`pool-submission-${submission.submissionId}`}>
                              <input id={`pool-submission-${submission.submissionId}`} name="submissionId" type="checkbox" value={submission.submissionId} defaultChecked data-submission-id={submission.submissionId} />
                              <span><strong>{submission.applicant.displayName}</strong><small><code>{submission.submissionId}</code> · {submission.assignedReviewCount} assigned / {submission.completionPercent}% complete</small></span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
                <div className={styles.fieldGrid}>
                  <label className={styles.field} htmlFor="reviews-per-submission"><span>Reviews per submission</span><input id="reviews-per-submission" name="reviewsPerSubmission" type="number" min="1" max="32" step="1" defaultValue="2" required /></label>
                  <label className={styles.field} htmlFor="max-assignments-per-reviewer"><span>Max assignments per reviewer</span><input id="max-assignments-per-reviewer" name="maxAssignmentsPerReviewer" type="number" min="1" max="4096" step="1" defaultValue="2" required /></label>
                  <label className={styles.field} htmlFor="distribution-strategy"><span>Distribution strategy</span><select id="distribution-strategy" name="strategy" defaultValue="balanced" required><option value="balanced">Balanced load</option><option value="round_robin">Round-robin</option></select></label>
                </div>
                <label className={styles.field} htmlFor="blind-artifact-decisions">
                  <span>Explicit blind-redaction manifest (JSON)</span>
                  <textarea
                    id="blind-artifact-decisions"
                    name="blindArtifactDecisions"
                    rows={4}
                    placeholder='[{"submissionId":"…","submissionRevisionId":"…","decisions":[…]}]'
                    aria-describedby="blind-artifact-decisions-help"
                  />
                </label>
                <p className={styles.fieldHint} id="blind-artifact-decisions-help">
                  Distribution issues no reviewer artifact without a complete organizer redaction manifest. Source answers are never copied or synthesized; excluded identity fields must be represented explicitly.
                </p>
              </fieldset>
              {distributionBlockedReason ? <p className={styles.disabledNote} role="note" data-testid="review-distribution-disabled">{distributionBlockedReason}</p> : null}
              <button className={styles.button} type="submit" disabled={!canDistribute || distributionPending} data-testid="distribute-review-assignments">
                {distributionPending ? "Distributing assignments…" : "Run automatic distribution"}
              </button>
            </form>
          ) : (
            <p className={styles.empty} data-testid="review-distribution-empty">Create or select a saved round before configuring distribution.</p>
          )}
          <OrganizerReviewSetupReceipt
            state={distributionActionState}
            pending={distributionPending}
            pendingMessage="Planning reviewer assignments within the selected caps…"
            testId="review-distribution-receipt"
          />
        </section>
      </div>
    </section>
  );
}

function RoundCard({ workspace, round, selectedSort }: { readonly workspace: string; readonly round: OrganizerReviewRoundProjection; readonly selectedSort: OrganizerReviewSort }) {
  const cfpHref = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(round.eventId)}/cfp/${encodeURIComponent(round.callId)}`;
  return (
    <article className={styles.round} data-testid="organizer-review-round">
      <header className={styles.roundHeader}>
        <div className={styles.roundTitleRow}>
          <div>
            <p className={styles.eyebrow}>Proposal review</p>
            <h2>{round.name}</h2>
          </div>
          <span className={styles.status}>{roundStateLabel(round)}</span>
        </div>
        <p className={styles.muted}>
          Call <Link href={cfpHref}>{round.call.name}</Link>
          <span className={styles.roundUpdated}> · updated {formatDateTime(round.stateChangedAt, round.schedule.timezone)}</span>
          <span aria-hidden="true"> · </span>
          Candidate evidence; organizer decision separate
        </p>
      </header>
      <ProposalReviewWorkspace workspace={workspace} round={round} selectedSort={selectedSort} />
      <RoundSummary round={round} />
    </article>
  );
}

function RoundSetupControls({
  workspace,
  round,
}: {
  readonly workspace: string;
  readonly round: OrganizerReviewRoundProjection;
}) {
  return (
    <section
      className={styles.roundSetupGroup}
      aria-labelledby={`round-setup-${round.id}`}
      data-testid="organizer-review-round-setup"
    >
      <header className={styles.roundSetupHeader}>
        <div>
          <p className={styles.eyebrow}>Saved round configuration</p>
          <h3 id={`round-setup-${round.id}`}>{round.name} setup</h3>
          <p className={styles.muted}>
            Privacy, lifecycle, dates, rubric, assignments, and reminder evidence remain attached to
            this persisted round.
          </p>
        </div>
        <span className={styles.status}>{roundStateLabel(round)}</span>
      </header>
      <div className={styles.setupControlGrid}>
        <BlindReviewControl workspace={workspace} round={round} />
        <RoundStateControl workspace={workspace} round={round} />
        <RoundScheduleControl workspace={workspace} round={round} />
      </div>
      <div className={styles.twoColumn}>
        <RubricSummary round={round} />
        <AssignmentTable round={round} />
      </div>
      <ReminderPanel workspace={workspace} round={round} />
      <EvidenceLedger round={round} />
    </section>
  );
}

function ReviewCallsPanel({
  eventBase,
  surface,
}: {
  readonly eventBase: string;
  readonly surface: OrganizerReviewSurface;
}) {
  return (
    <section className={styles.panel} aria-labelledby="review-calls-title">
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Event-scoped inputs</p>
          <h3 id="review-calls-title">Calls available for review</h3>
        </div>
        <span className={styles.muted}>{surface.calls.length} call{surface.calls.length === 1 ? "" : "s"}</span>
      </div>
      {surface.calls.length === 0 ? (
        <p className={styles.empty}>No call exists yet. Use CFP setup to create the applicant-facing call before configuring review.</p>
      ) : (
        <ul className={styles.callList}>
          {surface.calls.map((call) => (
            <li key={call.id}>
              <div><strong>{call.name}</strong><span>{call.state} · {call.slug}</span></div>
              <Link href={`${eventBase}/cfp/${encodeURIComponent(call.id)}`}>Open CFP call</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SecondaryReviewSetup({
  eventBase,
  workspace,
  surface,
}: {
  readonly eventBase: string;
  readonly workspace: string;
  readonly surface: OrganizerReviewSurface;
}) {
  const setupOpenByDefault = surface.rounds.length === 0;
  return (
    <section
      className={styles.secondarySetup}
      aria-labelledby="secondary-review-setup-title"
      data-testid="review-secondary-setup"
    >
      <header className={styles.secondarySetupHeader}>
        <div>
          <p className={styles.eyebrow}>Secondary workspace</p>
          <h2 id="secondary-review-setup-title">Setup</h2>
          <p className={styles.muted}>
            Configure rounds after reviewing proposals. These controls continue to use the existing
            persisted projections and versioned actions only.
          </p>
        </div>
        <div className={styles.actionLinks}>
          <Link className={styles.buttonSecondary} href={`${eventBase}/cfp`}>Open CFP setup</Link>
          <Link className={styles.buttonSecondary} href={`${eventBase}/overview`}>Event overview</Link>
          <span className={styles.status}>Configuration</span>
        </div>
      </header>
      <details className={styles.setupDisclosure} open={setupOpenByDefault}>
        <summary>
          <span>
            <strong>Round configuration and controls</strong>
            <small>Calls, dates, rubric, reviewer pool, assignments, privacy, lifecycle, and reminders</small>
          </span>
          <span>{surface.rounds.length} saved round{surface.rounds.length === 1 ? "" : "s"}</span>
        </summary>
        <div className={styles.secondarySetupBody}>
          <ReviewCallsPanel eventBase={eventBase} surface={surface} />
          <ReviewSetupPanel workspace={workspace} surface={surface} />
          {surface.rounds.map((round) => (
            <RoundSetupControls key={round.id} workspace={workspace} round={round} />
          ))}
        </div>
      </details>
    </section>
  );
}

export function OrganizerReviewConsole({
  workspace,
  surface,
}: {
  readonly workspace: string;
  readonly surface: OrganizerReviewSurface;
}) {
  const eventBase = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(surface.eventId)}`;
  return (
    <div className={styles.stack} data-testid="organizer-review-console">
      {surface.rounds.length === 0 ? (
        <section className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>Organizer review room · {surface.eventName}</p>
            <h2>Proposals awaiting organizer review</h2>
            <p className={styles.muted}>
              Create a review round in Setup before proposal evidence can be projected here.
            </p>
          </div>
          <div className={styles.actionLinks}>
            <Link className={styles.button} href={`${eventBase}/cfp`}>Open CFP setup</Link>
            <Link className={styles.buttonSecondary} href={`${eventBase}/overview`}>Event overview</Link>
          </div>
        </section>
      ) : null}

      {surface.rounds.length === 0 ? (
        <section className={styles.emptyPanel} aria-labelledby="review-empty-title">
          <p className={styles.eyebrow}>Review readiness</p>
          <h3 id="review-empty-title">No review round is materialized for this event</h3>
          <p>
            Use the open Setup section below to create the first named draft round from an
            available CFP call. Until a round is saved, there is no review evidence, reviewer pool,
            submission selection, or score projection to display.
          </p>
          <Link className={styles.button} href={`${eventBase}/cfp`}>Continue with CFP setup</Link>
        </section>
      ) : (
        <>
          <nav className={styles.roundNav} aria-label="Review rounds">
            <span>Rounds:</span>
            <Link aria-current={surface.selectedRoundId === null ? "page" : undefined} href={reviewHref(workspace, surface.eventId, { sort: surface.selectedSort })}>All rounds</Link>
            {surface.rounds.map((round) => (
              <Link key={round.id} aria-current={surface.selectedRoundId === round.id ? "page" : undefined} href={reviewHref(workspace, surface.eventId, { roundId: round.id, sort: surface.selectedSort })}>
                {round.name}
              </Link>
            ))}
          </nav>
          {surface.rounds.map((round) => <RoundCard key={round.id} workspace={workspace} round={round} selectedSort={surface.selectedSort} />)}
        </>
      )}

      <SecondaryReviewSetup eventBase={eventBase} workspace={workspace} surface={surface} />
    </div>
  );
}
