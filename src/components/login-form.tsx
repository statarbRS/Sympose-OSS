"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction } from "@/server/actions";
import type { ActionResult } from "@/server/actions";
import styles from "@/app/landing.module.css";

export interface LoginAccountChoice {
  accountId: string;
  email: string;
  displayName: string;
  role: string;
}

export interface LoginGroup {
  workspaceName: string;
  workspaceSlug: string;
  accounts: LoginAccountChoice[];
}

export function LoginForm({ groups }: { groups: LoginGroup[] }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    loginAction,
    null,
  );
  return (
    <form
      id="organizer-login-form"
      action={formAction}
      className={styles.loginForm}
      aria-label="Organizer workspace sign-in"
    >
      <div className={`${styles.loginOptions} login-options`}>
        {groups.map((group) => (
          <fieldset key={group.workspaceSlug} className={`${styles.loginWorkspace} login-workspace`}>
            <legend className="visually-hidden">{group.workspaceName}</legend>
            {group.accounts.map((account, index) => (
              <label key={account.accountId} className={`${styles.loginOption} login-option`}>
                <input
                  type="radio"
                  name="accountId"
                  value={account.accountId}
                  defaultChecked={group.workspaceSlug === "acme" && index === 0}
                  required
                />
                <span className={`${styles.loginOptionBody} login-option__body`}>
                  <span className={`${styles.loginWorkspaceName} login-option__workspace`}>
                    {group.workspaceName}
                  </span>
                  <span className={`${styles.loginAccount} login-option__account`}>
                    {account.displayName} · {account.email}
                  </span>
                  <span className={`${styles.loginRole} login-option__role`}>
                    role: {account.role} · workspace: {group.workspaceSlug}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      {state && !state.ok ? (
        <p className={`${styles.formError} alert alert--error`} role="alert">
          <span className="alert__code">{state.code ?? "SIGN_IN_FAILED"}: </span>
          {state.message}
        </p>
      ) : null}
      <button
        type="submit"
        className={`${styles.submitButton} btn btn--primary`}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? "Signing in…" : "Sign in to workspace"}
      </button>
    </form>
  );
}
