import styles from "@/components/connector-hub/connector-hub.module.css";

export default function ConnectorHubNotFound() {
  return (
    <div className={styles.routeState}>
      <div>
        <p>Connector Hub unavailable</p>
        <h1>This workspace surface is not available.</h1>
        <span>Return to an authorized workspace route. No provider status is disclosed here.</span>
      </div>
    </div>
  );
}
