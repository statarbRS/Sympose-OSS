"use client";

import styles from "./delivery-center.module.css";

export function DeliveryCenterError({ reset }: { readonly reset: () => void }) {
  return (
    <main className={styles.statePage} data-testid="delivery-center-error">
      <section className={styles.statePanel} role="alert">
        <p className={styles.kicker}>Delivery Center</p>
        <h1>Authorized delivery evidence is unavailable</h1>
        <p>The page could not validate one of its required event boundaries. No message, provider, database, or filesystem error details are shown.</p>
        <button type="button" onClick={reset}>Try the read again</button>
      </section>
    </main>
  );
}

export function DeliveryCenterLoading() {
  return (
    <main className={styles.statePage} data-testid="delivery-center-loading" aria-busy="true">
      <section className={styles.statePanel} role="status">
        <p className={styles.kicker}>Delivery Center</p>
        <h1>Reading authorized local evidence</h1>
        <p>No provider or SMTP request is made while this page loads.</p>
      </section>
    </main>
  );
}

export function DeliveryCenterNotFound() {
  return (
    <main className={styles.statePage} data-testid="delivery-center-not-found">
      <section className={styles.statePanel}>
        <p className={styles.kicker}>Delivery Center</p>
        <h1>Event delivery evidence not found</h1>
        <p>The requested workspace and event combination is not available to this organizer.</p>
      </section>
    </main>
  );
}
