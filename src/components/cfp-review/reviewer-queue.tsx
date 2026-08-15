import Link from "next/link";

import type { OwnReviewAssignmentSummary } from "@/server/services/cfp-review";

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function assignmentStatus(assignment: OwnReviewAssignmentSummary): string {
  if (assignment.conflictStatus === "DECLARED") return "Conflict declared — content withheld";
  if (assignment.assignmentState === "SUBMITTED") return "Submitted";
  if (assignment.latestReviewRevisionNumber > 0) return "In progress";
  return "Ready to review";
}

export function ReviewerQueue({
  assignments,
  workspace,
}: {
  readonly assignments: readonly OwnReviewAssignmentSummary[];
  readonly workspace: string;
}) {
  return (
    <div className="review-page" data-testid="reviewer-queue">
      <header className="review-page-heading">
        <p className="review-eyebrow">Own assignments</p>
        <h1>Your review queue</h1>
        <p>
          Only assignments bound to your authenticated reviewer session appear here. Each
          judgment remains independent review evidence.
        </p>
      </header>

      {assignments.length === 0 ? (
        <section className="review-state-panel" aria-labelledby="empty-queue-title">
          <h2 id="empty-queue-title">No assignments available</h2>
          <p>Your queue has no active review assignments.</p>
        </section>
      ) : (
        <ol className="review-queue-list" aria-label="Your review assignments">
          {assignments.map((assignment, index) => (
            <li className="review-queue-card" key={assignment.assignmentId}>
              <div className="review-queue-card__heading">
                <div>
                  <p className="review-queue-card__round">{assignment.roundName}</p>
                  <h2>Review assignment</h2>
                  <p className="review-queue-card__position">
                    Review assignment {index + 1} of {assignments.length}
                  </p>
                </div>
                <span className="review-status" data-state={assignment.assignmentState}>
                  {assignmentStatus(assignment)}
                </span>
              </div>
              <dl className="review-meta-list">
                <div>
                  <dt>Assigned</dt>
                  <dd>{formatDateTime(assignment.assignedAt)} UTC</dd>
                </div>
                <div>
                  <dt>Latest review revision</dt>
                  <dd>{assignment.latestReviewRevisionNumber || "None saved"}</dd>
                </div>
                <div>
                  <dt>Conflict status</dt>
                  <dd>{assignment.conflictStatus.toLowerCase()}</dd>
                </div>
              </dl>
              <Link
                className="review-button review-button--primary review-queue-card__link"
                href={`/review/${encodeURIComponent(workspace)}/assignments/${encodeURIComponent(
                  assignment.assignmentId,
                )}`}
              >
                {assignment.conflictStatus === "DECLARED"
                  ? "Review conflict"
                  : assignment.assignmentState === "SUBMITTED"
                    ? "View receipt"
                    : "Open assignment"}
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
