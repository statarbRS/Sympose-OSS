"use client";

import { useActionState, useEffect, useRef } from "react";

import {
  consumeApplicantVerificationAction,
  requestApplicantVerificationAction,
} from "@/app/cfp/actions";
import {
  IDLE_APPLICANT_ACTION_STATE,
  type ApplicantActionState,
} from "./contracts";

function ActionMessage({ state }: { readonly state: ApplicantActionState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.kind === "error" || state.kind === "stale") ref.current?.focus();
  }, [state]);

  if (state.kind === "idle") return null;
  if (state.kind === "success") {
    return (
      <div className="cfp-form-status" role="status">
        <p>{state.message}</p>
      </div>
    );
  }
  if (state.kind === "submitted") return null;
  return (
    <div className="cfp-error-summary" role="alert" tabIndex={-1} ref={ref}>
      <h2>We couldn&apos;t complete that step</h2>
      <p>{state.message}</p>
    </div>
  );
}

export function RequestVerificationForm({
  workspace,
  callSlug,
  callName,
}: {
  readonly workspace: string;
  readonly callSlug: string;
  readonly callName: string;
}) {
  const action = requestApplicantVerificationAction.bind(null, workspace, callSlug);
  const [state, formAction, pending] = useActionState(action, IDLE_APPLICANT_ACTION_STATE);
  const emailError = state.kind === "error" ? state.fieldErrors?.email : undefined;

  return (
    <form className="cfp-form" action={formAction} noValidate>
      <div className="cfp-form__header">
        <h2>Verify your email</h2>
        <p>{callName}</p>
      </div>
      <p className="cfp-muted">
        Enter the address that should own this application. The confirmation is deliberately the
        same whether or not an address can receive a link.
      </p>
      <ActionMessage state={state} />
      <div className="cfp-form-field">
        <label htmlFor="cfp-email">Email address</label>
        <p className="cfp-guidance" id="cfp-email-guidance">
          Your one-time link expires after 15 minutes.
        </p>
        <input
          className="cfp-input"
          id="cfp-email"
          name="email"
          type="email"
          autoComplete="email"
          maxLength={320}
          required
          aria-invalid={emailError ? "true" : undefined}
          aria-describedby={emailError ? "cfp-email-guidance cfp-email-error" : "cfp-email-guidance"}
        />
        {emailError ? (
          <p className="cfp-field-error" id="cfp-email-error">
            {emailError}
          </p>
        ) : null}
      </div>
      <button className="cfp-button cfp-button--primary" type="submit" disabled={pending}>
        {pending ? "Requesting link…" : "Send verification link"}
      </button>
    </form>
  );
}

export function CompleteVerificationForm({
  workspace,
  callSlug,
  callName,
}: {
  readonly workspace: string;
  readonly callSlug: string;
  readonly callName: string;
}) {
  const action = consumeApplicantVerificationAction.bind(null, workspace, callSlug);
  const [state, formAction, pending] = useActionState(action, IDLE_APPLICANT_ACTION_STATE);
  const nameError = state.kind === "error" ? state.fieldErrors?.fullName : undefined;

  return (
    <form className="cfp-form" action={formAction} noValidate>
      <div className="cfp-form__header">
        <h2>Finish verification</h2>
        <p>{callName}</p>
      </div>
      <p className="cfp-muted">
        The one-time link is secured in an httpOnly cookie and has already been removed from this
        page&apos;s URL. Enter your full name to continue.
      </p>
      <ActionMessage state={state} />
      <div className="cfp-form-field">
        <label htmlFor="cfp-full-name">Full name</label>
        <input
          className="cfp-input"
          id="cfp-full-name"
          name="fullName"
          type="text"
          autoComplete="name"
          maxLength={128}
          required
          aria-invalid={nameError ? "true" : undefined}
          aria-describedby={nameError ? "cfp-full-name-error" : undefined}
        />
        {nameError ? (
          <p className="cfp-field-error" id="cfp-full-name-error">
            {nameError}
          </p>
        ) : null}
      </div>
      <button className="cfp-button cfp-button--primary" type="submit" disabled={pending}>
        {pending ? "Verifying…" : "Verify and continue"}
      </button>
    </form>
  );
}
