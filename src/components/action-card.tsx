"use client";

import { useActionState, type ReactNode } from "react";
import type { ActionResult } from "@/server/actions";

export type ActionResultAction = (
  state: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>;

interface ActionCardProps {
  step: number;
  title: string;
  description: string;
  action: ActionResultAction;
  children?: ReactNode;
  status?: ReactNode;
  submitLabel?: string;
  disabled?: boolean;
  expectedDenial?: boolean;
  next?: boolean;
  caution?: boolean;
  wide?: boolean;
  linkHref?: string;
  linkLabel?: string;
}

export function ActionCard({
  step,
  title,
  description,
  action,
  children,
  status,
  submitLabel = "Run",
  disabled = false,
  expectedDenial = false,
  next = false,
  caution = false,
  wide = false,
  linkHref,
  linkLabel,
}: ActionCardProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const rowClass = [
    "action-card",
    "action-card--row",
    wide ? "action-card--wide" : "",
    next ? "action-card--next" : "",
    caution ? "action-card--caution" : "",
    expectedDenial ? "action-card--boundary" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const buttonClass = next ? "btn btn--primary" : "btn btn--ghost btn--secondary";

  return (
    <section
      className={rowClass}
      aria-labelledby={`action-${step}-title`}
      data-step={step}
    >
      <header className="action-card__head">
        <span className="step" aria-hidden="true">
          {step}
        </span>
        <div>
          <h2 id={`action-${step}-title`} className="action-card__title">
            {title}
          </h2>
          <p className="action-card__desc">{description}</p>
        </div>
      </header>
      {status ? (
        <div className="action-card__status">
          <span className="action-card__status-label">Current state: </span>
          {status}
        </div>
      ) : null}
      <form action={formAction} className="action-card__form">
        {children}
        <button type="submit" className={`${buttonClass}${caution ? " btn--caution" : ""}${expectedDenial ? " btn--boundary" : ""}`} disabled={disabled || pending}>
          {pending ? "Working…" : submitLabel}
        </button>
      </form>
      {linkHref && linkLabel ? (
        <p className="action-card__link card__link">
          <a href={linkHref}>{linkLabel}</a>
        </p>
      ) : null}
      <ActionResultBanner state={state} expectedDenial={expectedDenial} />
    </section>
  );
}

interface ActionFormProps {
  action: ActionResultAction;
  submitLabel: string;
  disabled?: boolean;
  expectedDenial?: boolean;
}

export function ActionForm({ action, submitLabel, disabled = false, expectedDenial = false }: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="action-card__form">
      <button type="submit" className="btn btn--primary" disabled={disabled || pending}>
        {pending ? "Working…" : submitLabel}
      </button>
      <ActionResultBanner state={state} expectedDenial={expectedDenial} />
    </form>
  );
}

export function ActionResultBanner({
  state,
  expectedDenial = false,
}: {
  state: ActionResult | null;
  expectedDenial?: boolean;
}) {
  if (!state) {
    return null;
  }
  if (state.ok) {
    return (
      <div className="alert alert--success" role="status">
        <p>{state.message}</p>
        {state.portalLinks && state.portalLinks.length > 0 ? (
          <div className="one-time">
            <p className="one-time__label">Personal agenda links — shown once; only token hashes are stored</p>
            <ul>
              {state.portalLinks.map((link) => (
                <li key={link.href}>
                  <a href={link.href}>{link.personName}</a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }
  if (state.denial) {
    return (
      <div className={`alert alert--denial${expectedDenial ? " alert--expected" : ""}`} role={expectedDenial ? "status" : "alert"}>
        <p className="alert__code">
          Refused: {state.denial.code} → {state.denial.target}
        </p>
        <p>{state.denial.message}</p>
      </div>
    );
  }
  return (
    <div className="alert alert--error" role="alert">
      <p className="alert__code">{state.code ?? "ERROR"}</p>
      <p>{state.message}</p>
    </div>
  );
}
