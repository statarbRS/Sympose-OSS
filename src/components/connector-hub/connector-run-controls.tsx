"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import {
  CONNECTOR_EXECUTION_ACTION_IDLE,
  confirmConnectorImportAction,
  exportConnectorPeopleAction,
  issueConnectorImportConfirmationAction,
  previewConnectorImportAction,
  testConnectorConnectionAction,
  type ConnectorExecutionActionState,
} from "@/app/w/[workspace]/connectors/actions";
import type {
  ConnectorProviderId,
} from "@/server/services/connector-hub/contracts";
import type {
  ConnectorPreviewRow,
  ConnectorRunSummary,
} from "@/server/services/connector-hub/orchestration";

import styles from "./connector-hub.module.css";

function ActionResult({ state }: { readonly state: ConnectorExecutionActionState }) {
  if (state.kind === "idle") return null;
  return (
    <p
      className={state.kind === "error" ? styles.connectionMessageError : styles.connectionMessageSuccess}
      role={state.kind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {state.message}
      {state.kind === "result" ? ` Run ${state.run.id.slice(0, 8)}… · ${state.run.state}.` : ""}
    </p>
  );
}

function useOperationKey(
  seed: string,
  provider: ConnectorProviderId,
  operation: string,
  state: ConnectorExecutionActionState,
): string {
  const [generation, setGeneration] = useState(0);
  const advancedRun = useRef<string | null>(null);
  useEffect(() => {
    if (
      state.kind === "result" &&
      ["SUCCEEDED", "PREVIEW_READY", "FAILED_TERMINAL", "UNKNOWN"].includes(state.run.state) &&
      advancedRun.current !== state.run.id
    ) {
      advancedRun.current = state.run.id;
      setGeneration((value) => value + 1);
    }
  }, [state]);
  return `connector-ui:${seed}:${provider}:${operation}:${generation}`;
}

function OperationForm({
  action,
  state,
  pending,
  workspaceSlug,
  provider,
  operationKey,
  label,
  disabled,
}: {
  readonly action: (payload: FormData) => void;
  readonly state: ConnectorExecutionActionState;
  readonly pending: boolean;
  readonly workspaceSlug: string;
  readonly provider: ConnectorProviderId;
  readonly operationKey: string;
  readonly label: string;
  readonly disabled: boolean;
}) {
  return (
    <div>
      <form action={action} className={styles.connectionRevokeForm}>
        <input type="hidden" name="workspace" value={workspaceSlug} />
        <input type="hidden" name="provider" value={provider} />
        <input type="hidden" name="operationKey" value={operationKey} />
        <button className={styles.connectionSaveButton} type="submit" disabled={disabled || pending}>
          {pending ? "Recording…" : label}
        </button>
      </form>
      <ActionResult state={state} />
    </div>
  );
}

function PreviewTable({ rows }: { readonly rows: readonly ConnectorPreviewRow[] }) {
  if (rows.length === 0) return <p className={styles.emptyMapping}>The persisted preview has no contacts.</p>;
  return (
    <div className={styles.mappingWrap}>
      <table className={styles.mappingTable} data-testid="connector-import-preview">
        <thead>
          <tr>
            <th scope="col">Provider identity</th>
            <th scope="col">Normalized contact</th>
            <th scope="col">Disposition</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <code>{row.providerRecordId}</code>
                <small>source {row.sourceVersion} · evidence {row.evidenceFingerprint.slice(0, 12)}…</small>
              </td>
              <td>
                {row.fullName ?? "Incomplete name"}
                <small>{row.normalizedEmail ?? "No valid email"}</small>
              </td>
              <td>
                <strong>{row.disposition}</strong>
                <small>{row.conflictCode ?? (row.candidatePersonId ? `Person ${row.candidatePersonId.slice(0, 8)}…` : "No canonical candidate")}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConnectorRunControls({
  workspaceSlug,
  provider,
  connectionActive,
  executionTransport,
  recentRuns,
  preview,
  operationKeySeed,
}: {
  readonly workspaceSlug: string;
  readonly provider: ConnectorProviderId;
  readonly connectionActive: boolean;
  readonly executionTransport: "synthetic-fixture" | "provider-network" | null;
  readonly recentRuns: readonly ConnectorRunSummary[];
  readonly preview: { readonly run: ConnectorRunSummary; readonly rows: readonly ConnectorPreviewRow[] } | null;
  readonly operationKeySeed: string;
}) {
  const [testState, testAction, testPending] = useActionState(testConnectorConnectionAction, CONNECTOR_EXECUTION_ACTION_IDLE);
  const [importState, importAction, importPending] = useActionState(previewConnectorImportAction, CONNECTOR_EXECUTION_ACTION_IDLE);
  const [exportState, exportAction, exportPending] = useActionState(exportConnectorPeopleAction, CONNECTOR_EXECUTION_ACTION_IDLE);
  const [issueState, issueAction, issuePending] = useActionState(issueConnectorImportConfirmationAction, CONNECTOR_EXECUTION_ACTION_IDLE);
  const [confirmState, confirmAction, confirmPending] = useActionState(confirmConnectorImportAction, CONNECTOR_EXECUTION_ACTION_IDLE);
  const disabled = !connectionActive || executionTransport === null;
  const syntheticExecution = executionTransport === "synthetic-fixture";
  const networkExecution = executionTransport === "provider-network";
  const testKey = useOperationKey(operationKeySeed, provider, "test", testState);
  const importKey = useOperationKey(operationKeySeed, provider, "import", importState);
  const exportKey = useOperationKey(operationKeySeed, provider, "export", exportState);

  return (
    <section className={styles.connectionPanel} aria-label={`${provider} bounded connector runs`}>
      <div className={styles.connectionPanelHeader}>
        <div>
          <p className={styles.connectionPanelEyebrow}>Durable execution</p>
          <h4>{syntheticExecution ? "Fixture test, preview, and receipt" : "Provider test, preview, and receipt"}</h4>
        </div>
      </div>
      {syntheticExecution ? (
        <p className={styles.connectionHint}>
          Synthetic-evaluator transport is closed over public fixture data. These controls exercise
          the bounded adapters and durable orchestration without network egress.
        </p>
      ) : networkExecution ? (
        <p className={styles.connectionHint}>
          Production provider-network transport is explicitly enabled. Requests remain origin-fixed,
          redirect-denying, timeout-bounded, response-size-bounded, and receipt-backed.
        </p>
      ) : (
        <p className={styles.connectionHint}>
          Connector execution is not explicitly and completely configured. No fallback transport exists.
        </p>
      )}
      <div className={styles.connectionActions}>
        <OperationForm
          action={testAction}
          state={testState}
          pending={testPending}
          workspaceSlug={workspaceSlug}
          provider={provider}
          operationKey={testKey}
          label={syntheticExecution ? "Test with synthetic fixture" : "Test provider connection"}
          disabled={disabled}
        />
        <OperationForm
          action={importAction}
          state={importState}
          pending={importPending}
          workspaceSlug={workspaceSlug}
          provider={provider}
          operationKey={importKey}
          label="Create import preview"
          disabled={disabled}
        />
        <OperationForm
          action={exportAction}
          state={exportState}
          pending={exportPending}
          workspaceSlug={workspaceSlug}
          provider={provider}
          operationKey={exportKey}
          label={syntheticExecution ? "Export canonical People to fixture" : "Export canonical People to provider"}
          disabled={disabled}
        />
      </div>
      {executionTransport === null ? (
        <p className={styles.connectionMessageError} role="status">
          Connector execution is unavailable for this process. No fallback provider transport exists.
        </p>
      ) : !connectionActive ? (
        <p className={styles.connectionHint}>Save an active connection before testing or creating a run.</p>
      ) : null}

      {preview ? (
        <div className={styles.providerDetails}>
          <h4>Latest reloadable import preview · {preview.run.state}</h4>
          <PreviewTable rows={preview.rows} />
          {preview.run.state === "PREVIEW_READY" ? (
            <div className={styles.connectionActions}>
              <form action={issueAction} className={styles.connectionRevokeForm}>
                <input type="hidden" name="workspace" value={workspaceSlug} />
                <input type="hidden" name="runId" value={preview.run.id} />
                <button className={styles.connectionRevokeButton} type="submit" disabled={issuePending || confirmPending}>
                  {issuePending ? "Issuing…" : "Issue new 15-minute confirmation"}
                </button>
              </form>
              <form action={confirmAction} className={styles.connectionRevokeForm}>
                <input type="hidden" name="workspace" value={workspaceSlug} />
                <input type="hidden" name="runId" value={preview.run.id} />
                <button className={styles.connectionSaveButton} type="submit" disabled={issuePending || confirmPending} data-testid="confirm-connector-import">
                  {confirmPending ? "Confirming…" : "Confirm canonical import"}
                </button>
              </form>
            </div>
          ) : null}
          <ActionResult state={issueState} />
          <ActionResult state={confirmState} />
        </div>
      ) : null}

      <details className={styles.providerDetails}>
        <summary>Recent durable run receipts</summary>
        {recentRuns.length === 0 ? <p>No provider run has been recorded.</p> : (
          <ul className={styles.requirementList}>
            {recentRuns.map((run) => (
              <li key={run.id}>
                <code>{run.id.slice(0, 8)}…</code> {run.operation} · {run.state} · {run.itemCount} items · {run.attemptCount} attempts
                {run.errorCode ? ` · ${run.errorCode}` : ""}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
