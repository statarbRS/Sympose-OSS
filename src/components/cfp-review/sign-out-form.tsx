"use client";

import { useActionState } from "react";

import { reviewerSignOutAction } from "@/app/review/actions";

import { IDLE_REVIEWER_ACTION_STATE } from "./contracts";

export function ReviewerSignOutForm() {
  const [state, formAction, pending] = useActionState(
    reviewerSignOutAction,
    IDLE_REVIEWER_ACTION_STATE,
  );
  return (
    <form action={formAction} className="review-sign-out">
      <button className="review-button review-button--quiet" type="submit" disabled={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {state.kind === "error" ? (
        <span className="review-shell-error" role="alert">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
