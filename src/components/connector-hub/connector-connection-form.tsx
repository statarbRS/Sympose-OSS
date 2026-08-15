"use client";

import { useActionState } from "react";

import {
  CONNECTOR_CONNECTION_ACTION_IDLE,
  revokeConnectorConnectionAction,
  saveConnectorConnectionAction,
  type ConnectorConnectionActionState,
} from "@/app/w/[workspace]/connectors/actions";
import type {
  ConnectorConnectionSummary,
  ConnectorProviderId,
} from "@/server/services/connector-hub/contracts";

import styles from "./connector-hub.module.css";

const PROVIDER_NAMES: Record<ConnectorProviderId, string> = {
  airtable: "Airtable",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
};

function configValue(
  connection: ConnectorConnectionSummary | null,
  provider: ConnectorProviderId,
  key: "baseId" | "tableName" | "portalId" | "portalName" | "instanceUrl" | "apiVersion",
): string {
  if (!connection || connection.provider !== provider) return "";
  switch (key) {
    case "baseId":
      return connection.config.provider === "airtable" ? connection.config.baseId : "";
    case "tableName":
      return connection.config.provider === "airtable" ? connection.config.tableName : "";
    case "portalId":
      return connection.config.provider === "hubspot" ? connection.config.portalId ?? "" : "";
    case "portalName":
      return connection.config.provider === "hubspot" ? connection.config.portalName ?? "" : "";
    case "instanceUrl":
      return connection.config.provider === "salesforce" ? connection.config.instanceUrl : "";
    case "apiVersion":
      return connection.config.provider === "salesforce" ? connection.config.apiVersion : "";
  }
}

function statusLabel(connection: ConnectorConnectionSummary | null): string {
  if (!connection) return "Not configured";
  return connection.status === "ACTIVE" ? "Active" : "Revoked";
}

function ActionMessage({
  state,
}: {
  readonly state: ConnectorConnectionActionState;
}) {
  if (state.kind === "idle") return null;
  return (
    <p
      className={state.kind === "error" ? styles.connectionMessageError : styles.connectionMessageSuccess}
      role={state.kind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {state.message}
    </p>
  );
}

export function ConnectorConnectionForm({
  workspaceSlug,
  provider,
  connection,
}: {
  readonly workspaceSlug: string;
  readonly provider: ConnectorProviderId;
  readonly connection: ConnectorConnectionSummary | null;
}) {
  const [saveState, saveAction, savePending] = useActionState(
    saveConnectorConnectionAction,
    CONNECTOR_CONNECTION_ACTION_IDLE,
  );
  const [revokeState, revokeAction, revokePending] = useActionState(
    revokeConnectorConnectionAction,
    CONNECTOR_CONNECTION_ACTION_IDLE,
  );
  const name = PROVIDER_NAMES[provider];
  const active = connection?.status === "ACTIVE";
  const revoked = connection?.status === "REVOKED";
  const secretRequired = !active;
  const titleId = `connector-${provider}-connection-title`;

  return (
    <section className={styles.connectionPanel} aria-labelledby={titleId}>
      <div className={styles.connectionPanelHeader}>
        <div>
          <p className={styles.connectionPanelEyebrow}>Connection management</p>
          <h4 id={titleId}>Configure {name}</h4>
        </div>
        <span className={`${styles.connectionStatus} ${styles[`connectionStatus_${connection?.status?.toLowerCase() ?? "not_configured"}`]}`}>
          <span aria-hidden="true" /> {statusLabel(connection)}
        </span>
      </div>

      {active ? (
        <p className={styles.maskedSecret}>
          <span aria-hidden="true">{connection.maskedSecret}</span>{" "}
          Secret stored securely; the value is never read back or displayed.
        </p>
      ) : revoked ? (
        <p className={styles.connectionHint}>This connection is revoked. Enter a new secret to reactivate it.</p>
      ) : (
        <p className={styles.connectionHint}>No connection is configured. Save a secret and the validated provider settings to activate it.</p>
      )}

      <form action={saveAction} className={styles.connectionForm} data-testid={`connector-${provider}-connection-form`}>
        <input type="hidden" name="workspace" value={workspaceSlug} />
        <input type="hidden" name="provider" value={provider} />
        <input type="hidden" name="expectedVersion" value={connection?.version ?? 0} />
        {provider === "airtable" ? (
          <>
            <label className={styles.connectionField}>
              <span>Base ID</span>
              <input name="baseId" defaultValue={configValue(connection, provider, "baseId")} required maxLength={80} autoComplete="off" placeholder="app…" />
            </label>
            <label className={styles.connectionField}>
              <span>Table name</span>
              <input name="tableName" defaultValue={configValue(connection, provider, "tableName")} required maxLength={256} autoComplete="off" placeholder="People" />
            </label>
          </>
        ) : null}
        {provider === "hubspot" ? (
          <>
            <label className={styles.connectionField}>
              <span>Portal ID <small>(optional)</small></span>
              <input name="portalId" defaultValue={configValue(connection, provider, "portalId")} maxLength={64} inputMode="numeric" autoComplete="off" placeholder="123456" />
            </label>
            <label className={styles.connectionField}>
              <span>Portal name <small>(optional)</small></span>
              <input name="portalName" defaultValue={configValue(connection, provider, "portalName")} maxLength={256} autoComplete="organization" />
            </label>
          </>
        ) : null}
        {provider === "salesforce" ? (
          <>
            <label className={`${styles.connectionField} ${styles.connectionFieldWide}`}>
              <span>Instance URL</span>
              <input name="instanceUrl" defaultValue={configValue(connection, provider, "instanceUrl")} required maxLength={256} type="url" autoComplete="url" placeholder="https://your-domain.my.salesforce.com" />
            </label>
            <label className={styles.connectionField}>
              <span>API version</span>
              <input name="apiVersion" defaultValue={configValue(connection, provider, "apiVersion")} required maxLength={16} autoComplete="off" placeholder="v60.0" />
            </label>
          </>
        ) : null}
        <label className={`${styles.connectionField} ${styles.connectionFieldWide}`}>
          <span>API secret <small>{active ? "(optional when keeping the stored secret)" : "(required)"}</small></span>
          <input
            name="secret"
            required={secretRequired}
            maxLength={4096}
            type="password"
            autoComplete="new-password"
            placeholder={active ? "Leave blank to keep the stored secret" : "Enter secret"}
          />
        </label>
        <div className={styles.connectionActions}>
          <button className={styles.connectionSaveButton} type="submit" disabled={savePending || revokePending}>
            {savePending ? "Saving…" : active ? "Update secure connection" : "Save secure connection"}
          </button>
        </div>
      </form>
      <ActionMessage state={saveState} />

      {active ? (
        <form action={revokeAction} className={styles.connectionRevokeForm}>
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="provider" value={provider} />
          <input type="hidden" name="expectedVersion" value={connection.version} />
          <button className={styles.connectionRevokeButton} type="submit" disabled={savePending || revokePending}>
            {revokePending ? "Revoking…" : "Revoke connection"}
          </button>
        </form>
      ) : null}
      <ActionMessage state={revokeState} />
    </section>
  );
}
