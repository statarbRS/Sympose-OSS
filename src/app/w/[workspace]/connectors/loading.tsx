import styles from "@/components/connector-hub/connector-hub.module.css";

export default function ConnectorHubLoading() {
  return (
    <div className={styles.routeState} role="status" aria-live="polite" aria-label="Loading Connector Hub">
      <span className={styles.routeStatePulse} aria-hidden="true" />
      <div>
        <p>Connector Hub</p>
        <h1>Reading workspace evidence…</h1>
        <span>Connection status and local receipts are loaded from the authorized workspace.</span>
      </div>
    </div>
  );
}
