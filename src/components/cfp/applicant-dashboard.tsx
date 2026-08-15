import { Buffer } from "node:buffer";

import Link from "next/link";
import { cookies } from "next/headers";

import { sha256Hex } from "@/server/canonical";
import { getDb } from "@/server/db";
import {
  readApplicantSubmissionDashboardForPortal,
} from "@/server/services/cfp/applicant-dashboard";
import type { CfpSubmissionConfirmationReceipt } from "@/server/services/cfp/submission-confirmation";
import { sessionCookieName } from "@/app/cfp/cookie-scope.server";
import { formatApplicantDateTime } from "./call-overview";
import type {
  ApplicantCallView,
  ApplicantSubmissionStatusView,
} from "./contracts";

const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readScopedSessionToken(
  value: string | undefined,
  workspace: string,
  call: string,
): string | null {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      !hasExactKeys(record, ["version", "workspace", "call", "token"]) ||
      record.version !== 1 ||
      record.workspace !== workspace ||
      record.call !== call ||
      typeof record.token !== "string" ||
      !RAW_TOKEN_PATTERN.test(record.token)
    ) {
      return null;
    }
    return record.token;
  } catch {
    return null;
  }
}

async function loadSubmissionConfirmation(
  workspace: string,
  callSlug: string,
  submissionId: string,
): Promise<CfpSubmissionConfirmationReceipt | null> {
  const store = await cookies();
  const token = readScopedSessionToken(
    store.get(sessionCookieName(workspace, callSlug))?.value,
    workspace,
    callSlug,
  );
  if (!token) return null;
  const dashboard = readApplicantSubmissionDashboardForPortal(getDb(), {
    workspaceSlug: workspace,
    callSlug,
    sessionTokenHash: sha256Hex(token),
    submissionId,
  });
  return dashboard?.confirmation ?? null;
}

function statusLabel(state: ApplicantSubmissionStatusView["state"]): string {
  switch (state) {
    case "DRAFT":
      return "Draft in progress";
    case "SUBMITTED":
      return "Submission received";
    case "WITHDRAWN":
      return "Submission withdrawn";
    case "INVALIDATED":
      return "Submission unavailable";
  }
}

function boundaryTitle(status: ApplicantSubmissionStatusView): string {
  if (status.edit.available) {
    return status.edit.mode === "submitted-amendment"
      ? "Post-submit editing is available"
      : "Draft editing is available";
  }
  if (status.edit.code === "CALL_CLOSED") return "Editing locked";
  return "Editing unavailable";
}

function decisionLabel(decision: ApplicantSubmissionStatusView["decision"]): string {
  if (!decision) return "Awaiting organizer decision";
  return decision.decision === "ACCEPTED" ? "Accepted" : "Not accepted";
}

export async function ApplicantDashboard({
  workspace,
  callSlug,
  call,
  submission,
  confirmation: suppliedConfirmation,
}: {
  readonly workspace: string;
  readonly callSlug: string;
  readonly call: ApplicantCallView;
  readonly submission: ApplicantSubmissionStatusView;
  readonly confirmation?: CfpSubmissionConfirmationReceipt | null;
}) {
  const confirmation = submission.state === "SUBMITTED"
    ? suppliedConfirmation === undefined
      ? await loadSubmissionConfirmation(workspace, callSlug, submission.submissionId)
      : suppliedConfirmation
    : null;
  const base = `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}`;
  return (
    <section className="cfp-card cfp-dashboard-card" data-testid="applicant-dashboard" aria-labelledby="applicant-dashboard-title">
      <p className="cfp-eyebrow">Applicant dashboard</p>
      <div className="cfp-page-header__title-row">
        <h2 id="applicant-dashboard-title">{statusLabel(submission.state)}</h2>
        <span className="cfp-status-badge" data-testid="applicant-submission-status">
          {submission.state}
        </span>
      </div>
      <p className="cfp-muted">
        This status is read from the local submission record and its immutable current revision.
        No external delivery provider is claimed by this confirmation.
      </p>
      <dl className="cfp-receipt__details">
        <div>
          <dt>Submission</dt>
          <dd><code>{submission.submissionId}</code></dd>
        </div>
        <div>
          <dt>Current revision</dt>
          <dd>
            {submission.currentRevisionId ? <code>{submission.currentRevisionId}</code> : "Not saved yet"}
          </dd>
        </div>
        <div>
          <dt>Revision number</dt>
          <dd>{submission.revisionNumber ?? "Not saved yet"}</dd>
        </div>
        {submission.revisionCreatedAt ? (
          <div>
            <dt>Revision recorded</dt>
            <dd>
              <time dateTime={submission.revisionCreatedAt}>
                {formatApplicantDateTime(submission.revisionCreatedAt, call.timezone)}
              </time>
            </dd>
          </div>
        ) : null}
        {submission.submittedAt ? (
          <div>
            <dt>Submitted</dt>
            <dd>
              <time dateTime={submission.submittedAt}>
                {formatApplicantDateTime(submission.submittedAt, call.timezone)}
              </time>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Consent receipt</dt>
          <dd>{submission.hasConsentReceipt ? "Recorded with revision" : "Not recorded"}</dd>
        </div>
        <div>
          <dt>Form fingerprint</dt>
          <dd>{submission.formFingerprint ? <code>{submission.formFingerprint}</code> : "Not saved yet"}</dd>
        </div>
        <div>
          <dt>Policy fingerprint</dt>
          <dd>{submission.policyFingerprint ? <code>{submission.policyFingerprint}</code> : "Not saved yet"}</dd>
        </div>
        <div>
          <dt>Lineage reference</dt>
          <dd>{submission.lineageId ? <code>{submission.lineageId}</code> : "Not assigned by organizer"}</dd>
        </div>
      </dl>
      <div className="cfp-form-status" role="status">
        <strong>{boundaryTitle(submission)}</strong>
        <p>{submission.edit.message}</p>
        {submission.edit.available ? (
          <p>
            <Link className="cfp-button cfp-button--primary" href={`${base}/draft`}>
              {submission.edit.mode === "submitted-amendment"
                ? "Edit submitted proposal"
                : "Edit saved draft"}
            </Link>
          </p>
        ) : null}
      </div>
      {confirmation ? (
        <section
          className="cfp-card cfp-dashboard-confirmation"
          data-testid="submission-confirmation-receipt"
          aria-labelledby="submission-confirmation-title"
        >
          <p className="cfp-eyebrow">Submission confirmation</p>
          <h3 id="submission-confirmation-title">{confirmation.subject}</h3>
          <dl className="cfp-receipt__details">
            <div>
              <dt>Recipient</dt>
              <dd>{confirmation.maskedRecipient}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{confirmation.status}</dd>
            </div>
            <div>
              <dt>Queued</dt>
              <dd>
                <time dateTime={confirmation.queuedAt}>
                  {formatApplicantDateTime(confirmation.queuedAt, call.timezone)}
                </time>
              </dd>
            </div>
          </dl>
          <p className="cfp-muted">Local pending receipt only; no external provider was contacted.</p>
        </section>
      ) : null}
      <section className="cfp-card cfp-dashboard-decision" aria-labelledby="applicant-decision-title">
        <p className="cfp-eyebrow">Decision and communication</p>
        <h3 id="applicant-decision-title">{decisionLabel(submission.decision)}</h3>
        {!submission.decision ? (
          <p className="cfp-muted">The organizer has not recorded a decision for this current submission revision.</p>
        ) : (
          <>
            <p className="cfp-muted">
              Decision recorded for revision <code>{submission.decision.submissionRevisionId}</code> on{" "}
              <time dateTime={submission.decision.decidedAt}>
                {formatApplicantDateTime(submission.decision.decidedAt, call.timezone)}
              </time>.
            </p>
            {submission.decision.handoff ? (
              <>
                <dl className="cfp-receipt__details">
                  <div>
                    <dt>Accepted session handoff</dt>
                    <dd>{submission.decision.handoff.title}</dd>
                  </div>
                  <div>
                    <dt>Speaker</dt>
                    <dd>{submission.decision.handoff.speaker.displayName}</dd>
                  </div>
                  <div>
                    <dt>Linked program session</dt>
                    <dd><code>{submission.decision.handoff.linkedSession.programUnitId}</code></dd>
                  </div>
                  <div>
                    <dt>Session status</dt>
                    <dd data-testid="applicant-linked-session-status">
                      {submission.decision.handoff.linkedSession.status}
                    </dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{submission.decision.handoff.linkedSession.durationMinutes} minutes</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>{submission.decision.handoff.format ?? "Not recorded"}</dd>
                  </div>
                  <div>
                    <dt>Track</dt>
                    <dd>{submission.decision.handoff.track ?? "Not assigned"}</dd>
                  </div>
                  {submission.decision.handoff.linkedSession.status === "RELEASED" &&
                  submission.decision.handoff.linkedSession.placement ? (
                    <>
                      <div>
                        <dt>Scheduled time</dt>
                        <dd>
                          <time dateTime={submission.decision.handoff.linkedSession.placement.startsAt}>
                            {formatApplicantDateTime(
                              submission.decision.handoff.linkedSession.placement.startsAt,
                              call.timezone,
                            )}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>Scheduled room</dt>
                        <dd>{submission.decision.handoff.linkedSession.placement.roomName}</dd>
                      </div>
                      <div>
                        <dt>Scheduled track</dt>
                        <dd>{submission.decision.handoff.linkedSession.placement.trackName}</dd>
                      </div>
                    </>
                  ) : null}
                </dl>
                {submission.decision.handoff.linkedSession.status === "RELEASED" &&
                submission.decision.handoff.linkedSession.placement ? (
                  <p className="cfp-muted">
                    This placement is durable schedule truth from sealed public release {submission.decision.handoff.linkedSession.release?.releaseNumber ?? "unknown"}.
                  </p>
                ) : submission.decision.handoff.linkedSession.status === "DRAFT_UNPUBLISHED" ? (
                  <p className="cfp-muted" data-testid="applicant-linked-session-draft-notice">
                    The organizer has a draft, unpublished placement. Its time, room, and track are not authoritative and remain hidden until a sealed release exists.
                  </p>
                ) : (
                  <p className="cfp-muted">
                    The linked session has no room or time slot yet; this decision does not publish it.
                  </p>
                )}
              </>
            ) : null}
            {submission.decision.communication ? (
              <div className="cfp-form-status" role="status">
                <strong>Decision communication receipt</strong>
                <p>{submission.decision.communication.message}</p>
                <p>
                  Recipient: {submission.decision.communication.recipientDisplayName} · status {submission.decision.communication.status} ·{" "}
                  <time dateTime={submission.decision.communication.queuedAt}>
                    {formatApplicantDateTime(submission.decision.communication.queuedAt, call.timezone)}
                  </time>
                </p>
                <p className="cfp-muted">Synthetic local receipt only; no provider delivery is claimed.</p>
              </div>
            ) : null}
          </>
        )}
      </section>
      <p className="cfp-back-link">
        <Link href={base}>Back to call details</Link>
      </p>
    </section>
  );
}
