"use client";

import { useActionState } from "react";

import {
  enterPinnedReviewerSessionAction,
  type ActionResult,
} from "@/server/actions";
import {
  provisionPinnedReviewerAction,
} from "@/app/w/[workspace]/events/[eventId]/review/actions";
import {
  IDLE_REVIEWER_PROVISIONING_ACTION,
  type ReviewerProvisioningActionState,
} from "@/components/cfp-review/reviewer-provisioning-action-state";
import type {
  ReviewerAccessIntent,
  ReviewerProvisioningProjection,
} from "@/server/services/cfp-review/reviewer-provisioning";

import styles from "./organizer-review-console.module.css";

const STEPS: readonly { readonly state: "PROVISIONED" | "INVITED" | "ACTIVE"; readonly label: string }[] = [
  { state: "PROVISIONED", label: "Provisioned" },
  { state: "INVITED", label: "Invited" },
  { state: "ACTIVE", label: "Active" },
];

const INTENT_FOR_NEXT_STATE: Readonly<Record<string, ReviewerAccessIntent>> = {
  READY_TO_PROVISION: "PROVISION",
  PROVISIONED: "INVITE",
  INVITED: "ACTIVATE",
};

function statusLabel(status: ReviewerProvisioningProjection["status"]): string {
  return status === "READY_TO_PROVISION" ? "Ready to provision" : status.toLowerCase();
}

export function ReviewerProvisioningPanel({
  access,
}: {
  readonly access: ReviewerProvisioningProjection;
}) {
  const [state, formAction, pending] = useActionState<
    ReviewerProvisioningActionState,
    FormData
  >(provisionPinnedReviewerAction, IDLE_REVIEWER_PROVISIONING_ACTION);
  const [transitionState, transitionAction, transitionPending] = useActionState<
    ActionResult | null,
    FormData
  >(enterPinnedReviewerSessionAction, null);
  const nextIntent = INTENT_FOR_NEXT_STATE[access.status];
  const defaultKey = `evaluator-sam-${nextIntent?.toLowerCase() ?? "active"}-v1`;

  return (
    <section
      className={styles.reviewerProvisioning}
      aria-labelledby="reviewer-provisioning-title"
      data-testid="reviewer-provisioning"
    >
      <div className={styles.setupHeader}>
        <div>
          <p className={styles.eyebrow}>Pinned reviewer access</p>
          <h3 id="reviewer-provisioning-title">Sam Whitfield</h3>
          <p className={styles.fieldHint}>
            Organizer-controlled local access for the exact DevFlow review assignment. No
            password, token, or provider invitation is issued.
          </p>
        </div>
        <span className={styles.kindBadge} data-testid="reviewer-access-status">
          {statusLabel(access.status)}
        </span>
      </div>

      <ol className={styles.reviewerProvisioningSteps} aria-label="Reviewer access lifecycle">
        {STEPS.map((step, index) => {
          const reached = access.accessSequenceNumber >= index + 1;
          return (
            <li key={step.state} data-state={reached ? "reached" : "pending"}>
              <strong>{step.label}</strong>
              <span>{reached ? "Recorded" : "Waiting"}</span>
            </li>
          );
        })}
      </ol>

      {nextIntent ? (
        <form action={formAction} className={styles.reviewerProvisioningForm}>
          <input type="hidden" name="eventId" value={access.eventId} readOnly />
          <input type="hidden" name="roundId" value={access.roundId} readOnly />
          <input type="hidden" name="intent" value={nextIntent} readOnly />
          <input type="hidden" name="idempotencyKey" value={defaultKey} readOnly />
          <button
            className={styles.button}
            type="submit"
            disabled={pending}
            data-testid={`reviewer-access-${nextIntent.toLowerCase()}`}
          >
            {pending
              ? "Recording…"
              : nextIntent === "PROVISION"
                ? "Provision Sam reviewer"
                : nextIntent === "INVITE"
                  ? "Record local invite"
                  : "Activate reviewer queue"}
          </button>
        </form>
      ) : null}

      {state.kind === "error" ? (
        <p className={styles.receiptError} role="alert" data-testid="reviewer-access-error">
          {state.message}
        </p>
      ) : null}
      {state.kind === "success" ? (
        <p className={styles.receiptSuccess} role="status" data-testid="reviewer-access-success">
          <strong>{state.message}</strong>
          <span>
            Durable receipt {state.receipt.receiptId}; {state.receipt.transitioned ? "transition recorded" : "no transition needed"}.
          </span>
        </p>
      ) : null}

      {access.queueReachable ? (
        <form action={transitionAction} className={styles.reviewerProvisioningForm}>
          <button
            className={`${styles.button} ${styles.reviewerQueueButton}`}
            type="submit"
            disabled={transitionPending}
            data-testid="reviewer-persona-transition"
          >
            {transitionPending ? "Opening Sam’s queue…" : "Enter Sam’s reviewer queue"}
          </button>
          <p className={styles.fieldHint}>
            The server rotates this organizer session to the pinned reviewer only after checking
            the ACTIVE state and exact assignment binding.
          </p>
        </form>
      ) : null}
      {transitionState && !transitionState.ok ? (
        <p className={styles.receiptError} role="alert" data-testid="reviewer-transition-error">
          {transitionState.message}
        </p>
      ) : null}
    </section>
  );
}
