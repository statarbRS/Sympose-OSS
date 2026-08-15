"use client";

import { useActionState } from "react";

import { loginReviewerAction } from "@/server/actions";
import type { ActionResult } from "@/server/actions";
import type { SyntheticReviewerChoice } from "@/server/services/queries";
import styles from "@/app/landing.module.css";

export function ReviewerEntry({ choices }: { choices: SyntheticReviewerChoice[] }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    loginReviewerAction,
    null,
  );
  return (
    <form action={formAction} className={`${styles.reviewerForm} persona-entry__form`} aria-label="Reviewer entry">
      {choices.map((choice, index) => (
        <label
          key={choice.accountId}
          className={`${styles.reviewerChoice} persona-entry__choice`}
        >
          <input
            type="radio"
            name="accountId"
            value={choice.accountId}
            defaultChecked={index === 0}
            required
          />
          <span className={styles.reviewerChoiceText}>
            <strong>{choice.displayName}</strong>
            <span className={`${styles.reviewerMeta} persona-entry__meta`}>
              {choice.workspaceName} · reviewer
            </span>
          </span>
        </label>
      ))}
      {choices.length === 0 ? (
        <p className={`${styles.reviewerEmpty} muted`}>The reviewer fixture is unavailable.</p>
      ) : null}
      {state && !state.ok ? (
        <p className={`${styles.formError} alert alert--error`} role="alert">
          {state.message}
        </p>
      ) : null}
      <button
        type="submit"
        className={`${styles.reviewerButton} btn btn--primary`}
        disabled={pending || choices.length === 0}
        aria-busy={pending}
      >
        {pending ? "Opening reviewer queue…" : "Enter reviewer queue"}
      </button>
    </form>
  );
}
