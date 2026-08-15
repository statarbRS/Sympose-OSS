"use client";

import { useActionState, useEffect, useRef } from "react";

import { createApplicantDraftAction } from "@/app/cfp/actions";
import {
  IDLE_APPLICANT_ACTION_STATE,
  applicantActionRequiresReload,
} from "./contracts";

export function StartDraftForm({
  workspace,
  callSlug,
}: {
  readonly workspace: string;
  readonly callSlug: string;
}) {
  const action = createApplicantDraftAction.bind(null, workspace, callSlug);
  const [state, formAction, pending] = useActionState(action, IDLE_APPLICANT_ACTION_STATE);
  const errorRef = useRef<HTMLDivElement>(null);
  const reloadRequired = applicantActionRequiresReload(state);
  const reloadHref = `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}/draft`;

  useEffect(() => {
    if (state.kind === "error" || state.kind === "stale") errorRef.current?.focus();
  }, [state]);

  return (
    <form className="cfp-form cfp-start-form" action={formAction}>
      <div className="cfp-form__header">
        <h2>Start your application</h2>
      </div>
      <p>
        Create a draft pinned to this call&apos;s current form and rules. Every save appends an immutable
        revision.
      </p>
      {state.kind === "error" || state.kind === "stale" ? (
        <div className="cfp-error-summary" role="alert" tabIndex={-1} ref={errorRef}>
          <h2>The draft could not be opened</h2>
          <p>{state.message}</p>
          {reloadRequired ? (
            <p>
              <a className="cfp-button" href={reloadHref}>
                Reload the authoritative draft state
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      <button
        className="cfp-button cfp-button--primary"
        type="submit"
        disabled={reloadRequired || pending}
      >
        {pending ? "Opening draft…" : "Create or resume draft"}
      </button>
    </form>
  );
}
