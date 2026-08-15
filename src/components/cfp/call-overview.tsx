import Link from "next/link";

import { CallStatusBadge } from "./call-status-badge";
import type { ApplicantCallView, ApplicantJson } from "./contracts";
import { StatePanel } from "./state-panel";

function sentenceLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

function disclosureText(value: ApplicantJson): string {
  if (typeof value === "string") return value;
  if (value === null) return "Not specified";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export function formatApplicantDateTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(instant));
}

export function callWindowDetail(call: ApplicantCallView): string | undefined {
  if (call.availability === "scheduled" && call.opensAt) {
    return `Opens ${formatApplicantDateTime(call.opensAt, call.timezone)}`;
  }
  if (call.closesAt) {
    return `Closes ${formatApplicantDateTime(call.closesAt, call.timezone)}`;
  }
  return undefined;
}

export function CallHeading({ call }: { readonly call: ApplicantCallView }) {
  const displayedState = call.availability === "closed" ? "CLOSED" : call.state;
  return (
    <header className="cfp-page-header">
      <p className="cfp-eyebrow">Call for proposals</p>
      <div className="cfp-page-header__title-row">
        <h1>{call.name}</h1>
        <CallStatusBadge lifecycle={displayedState} detail={callWindowDetail(call)} />
      </div>
      <p className="cfp-lede">
        {call.availability === "closed"
          ? "The submission window is closed. The call details remain available for reference."
          : "Review the call details anonymously. Verify your email only when you are ready to create or continue an application."}
      </p>
    </header>
  );
}

export function CallAvailabilityPanel({ call }: { readonly call: ApplicantCallView }) {
  if (call.availability === "open") return null;
  if (call.availability === "paused") {
    return (
      <StatePanel tone="warning" title="Applications are paused">
        <p>
          The public call is temporarily paused. Existing application history remains safe; the
          server will determine whether any requested applicant action is authorized.
        </p>
      </StatePanel>
    );
  }
  if (call.availability === "closed") {
    return (
      <StatePanel tone="warning" title="This call is closed">
        <p>
          The public submission window has ended. Applicants with an approved personal extension
          may still verify or continue; every action is checked against current server authority.
        </p>
      </StatePanel>
    );
  }
  return (
    <StatePanel title="This call is not open yet">
      <p>
        The public window is not open yet
        {call.opensAt ? `; the call opens ${formatApplicantDateTime(call.opensAt, call.timezone)}` : ""}.
        {" "}The server will determine whether a requested applicant action is authorized.
      </p>
    </StatePanel>
  );
}

export function Disclosure({ call }: { readonly call: ApplicantCallView }) {
  return (
    <section className="cfp-card" aria-labelledby="cfp-disclosure-title">
      <h2 id="cfp-disclosure-title">How your application is handled</h2>
      <dl className="cfp-disclosure-list">
        {Object.entries(call.disclosure).map(([key, value]) => (
          <div className="cfp-disclosure-list__item" key={key}>
            <dt>{sentenceLabel(key)}</dt>
            <dd>{disclosureText(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function FormPreview({ call }: { readonly call: ApplicantCallView }) {
  return (
    <section className="cfp-card" aria-labelledby="cfp-preview-title">
      <h2 id="cfp-preview-title">Application questions</h2>
      <p className="cfp-muted">
        This is the pinned question set. Conditional questions are evaluated on the server after
        you save a draft.
      </p>
      <ol className="cfp-question-list">
        {call.fields.map((field) => (
          <li key={field.id}>
            <span>{field.label}</span>
            <span className="cfp-question-list__meta">
              {field.required ? "Required" : "Optional"}
              {field.defaultVisibility === "hidden" ? " · Conditional" : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function CallActions({
  workspace,
  call,
}: {
  readonly workspace: string;
  readonly call: ApplicantCallView;
}) {
  const base = `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(call.slug)}`;
  if (call.availability === "closed") {
    return (
      <section className="cfp-actions" aria-label="Applicant actions" data-testid="closed-call-actions">
        <p className="cfp-muted">New submissions and ordinary draft changes are unavailable because this call is closed.</p>
        <Link className="cfp-button" href={`${base}/dashboard`}>
          View applicant dashboard
        </Link>
      </section>
    );
  }
  return (
    <section className="cfp-actions" aria-label="Applicant actions">
      <Link className="cfp-button cfp-button--primary" href={`${base}/verify`}>
        Verify your email
      </Link>
      <Link className="cfp-button" href={`${base}/draft`}>
        Continue a saved draft
      </Link>
      <Link className="cfp-button" href={`${base}/dashboard`}>
        View applicant dashboard
      </Link>
    </section>
  );
}
