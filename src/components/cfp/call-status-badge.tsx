import type { ApplicantCallState } from "./contracts";

const labels: Record<ApplicantCallState, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  OPEN: "Open",
  PAUSED: "Paused",
  CLOSED: "Closed",
  ARCHIVED: "Archived",
  CANCELLED: "Cancelled",
};

export function CallStatusBadge({
  lifecycle,
  detail,
}: {
  readonly lifecycle: ApplicantCallState;
  readonly detail?: string;
}) {
  const label = labels[lifecycle];
  return (
    <span
      className={`cfp-status-badge cfp-status-badge--${lifecycle.toLowerCase()}`}
      aria-label={detail ? `${label}: ${detail}` : label}
    >
      <span className="cfp-status-badge__label">{label}</span>
      {detail ? <span className="cfp-status-badge__detail">{detail}</span> : null}
    </span>
  );
}
