"use client";

import Link from "next/link";

import styles from "./product-surface.module.css";

export function SurfaceLoading({ label }: { label: string }) {
  return (
    <article className={styles.surface} aria-busy="true" aria-labelledby="surface-loading-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Organizer event surface</p>
          <h1 id="surface-loading-title">Loading {label}</h1>
          <p className={styles.lede}>Resolving the authorized workspace and authoritative records.</p>
        </div>
      </header>
      <div className={styles.state}><strong>Loading</strong><p>Stable page structure is preserved while the server read completes.</p></div>
    </article>
  );
}

export function SurfaceError({
  error,
  reset,
  label,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  label: string;
}) {
  return (
    <article className={styles.surface} role="alert" aria-labelledby="surface-error-title">
      <header className={styles.header}><div><p className={styles.eyebrow}>{label}</p><h1 id="surface-error-title">Authoritative data could not be trusted</h1></div></header>
      <div className={`${styles.state} ${styles.stateUnavailable}`}>
        <strong>Integrity or service failure</strong>
        <p>The surface stopped without showing partial domain data. Retry the authoritative read or provide the correlation reference to support.</p>
        {error.digest ? <p>Correlation reference: <code>{error.digest}</code></p> : null}
        <button className={styles.retryButton} type="button" onClick={reset}>Retry authoritative read</button>
      </div>
    </article>
  );
}

export function SurfaceNotFound({ label }: { label: string }) {
  return (
    <article className={styles.surface} aria-labelledby="surface-not-found-title">
      <header className={styles.header}><div><p className={styles.eyebrow}>{label}</p><h1 id="surface-not-found-title">This surface is unavailable</h1></div></header>
      <div className={styles.state}>
        <strong>Not found</strong>
        <p>The requested workspace or event cannot be disclosed. Check the address or return to your authorized workspace.</p>
        <Link href="/">Return to workspace sign-in</Link>
      </div>
    </article>
  );
}
