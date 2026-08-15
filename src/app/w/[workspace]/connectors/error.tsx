"use client";

import styles from "@/components/connector-hub/connector-hub.module.css";

export default function ConnectorHubError({
  error: _error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  return (
    <div className={styles.routeState} role="alert">
      <div>
        <p>Connector Hub unavailable</p>
        <h1>Workspace evidence could not be loaded.</h1>
        <span>No provider call was attempted or retried. Reload the authorized local view to try again.</span>
        <button type="button" onClick={reset}>Reload Connector Hub</button>
      </div>
    </div>
  );
}
