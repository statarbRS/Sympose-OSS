"use client";

import { useActionState } from "react";

import {
  productionBootstrapAction,
  productionLoginAction,
  type ProductionAuthActionState,
} from "@/server/production-auth-actions";
import type { ProductionBootstrapStatus } from "@/server/production-auth";
import styles from "@/app/landing.module.css";

function Result({ state }: { readonly state: ProductionAuthActionState | null }) {
  if (!state || state.ok) return null;
  return (
    <p className={`${styles.formError} alert alert--error`} role="alert">
      <span className="alert__code">{state.code ?? "AUTH_FAILED"}: </span>{state.message}
    </p>
  );
}

export function ProductionAccess({
  bootstrapStatus,
  sessionExpired,
}: {
  readonly bootstrapStatus: ProductionBootstrapStatus;
  readonly sessionExpired: boolean;
}) {
  const [loginState, loginAction, loginPending] = useActionState(productionLoginAction, null);
  const [bootstrapState, bootstrapAction, bootstrapPending] = useActionState(productionBootstrapAction, null);
  return (
    <main className={styles.landing} id="landing-content" tabIndex={-1}>
      <div className={styles.frame}>
        <header className={styles.hero}>
          <div className={styles.utilityRow}>
            <span className={styles.wordmark}><span className={styles.wordmarkMark} aria-hidden="true">S</span>Sympose</span>
            <span className={styles.utilityLabel}>Production</span>
          </div>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Workspace access</p>
            <h1>Sign in to Sympose.</h1>
            <p className={styles.heroLead}>Production starts empty. Workspace identity and role are resolved from the authenticated server session.</p>
          </div>
        </header>
        <div className={styles.content}>
          <section className={styles.personaSection} aria-labelledby="production-login-title">
            <article className={`${styles.personaCard} ${styles.personaCardEntry}`}>
              <h2 id="production-login-title">Workspace sign-in</h2>
              {sessionExpired ? <p className={`${styles.status} alert alert--info notice`} role="status">Your session expired. Sign in again.</p> : null}
              <form action={loginAction} className={styles.loginForm} aria-label="Production workspace sign-in">
                <label>Workspace slug<input name="workspaceSlug" autoComplete="organization" required maxLength={64} /></label>
                <label>Email<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>
                <label>Password<input name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} /></label>
                <Result state={loginState} />
                <button type="submit" className={`${styles.submitButton} btn btn--primary`} disabled={loginPending}>
                  {loginPending ? "Signing in…" : "Sign in"}
                </button>
              </form>
            </article>
          </section>
          {bootstrapStatus === "AVAILABLE" ? (
            <section className={styles.personaSection} aria-labelledby="production-bootstrap-title">
              <article className={`${styles.personaCard} ${styles.personaCardEntry}`}>
                <h2 id="production-bootstrap-title">Create the first workspace owner</h2>
                <p>The deployment-issued token is one-time, short-lived, replay-protected, and never stored in plaintext.</p>
                <form action={bootstrapAction} className={styles.loginForm} aria-label="Production owner bootstrap">
                  <label>Bootstrap token<input name="bootstrapToken" type="password" autoComplete="off" required minLength={32} maxLength={512} /></label>
                  <label>Workspace name<input name="workspaceName" autoComplete="organization" required maxLength={160} /></label>
                  <label>Workspace slug<input name="workspaceSlug" required maxLength={64} pattern="[a-z0-9][a-z0-9-]*[a-z0-9]" /></label>
                  <label>Owner name<input name="displayName" autoComplete="name" required maxLength={160} /></label>
                  <label>Owner email<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>
                  <label>Password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
                  <Result state={bootstrapState} />
                  <button type="submit" className={`${styles.submitButton} btn btn--primary`} disabled={bootstrapPending}>
                    {bootstrapPending ? "Creating owner…" : "Create owner"}
                  </button>
                </form>
              </article>
            </section>
          ) : (
            <p className={styles.helperText} role="status">First-owner bootstrap is {bootstrapStatus.toLowerCase()}. Use an existing workspace login or contact the deployment owner.</p>
          )}
        </div>
      </div>
    </main>
  );
}
