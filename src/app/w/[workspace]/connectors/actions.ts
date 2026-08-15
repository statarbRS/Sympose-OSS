"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import {
  ConnectorConnectionError,
  ConnectorOrchestrationError,
  confirmConnectorImport,
  createConnectorImportPreview,
  exportCanonicalPeopleToConnector,
  getConnectorImportPreview,
  issueConnectorImportConfirmation,
  revokeConnectorConnection,
  saveConnectorConnection,
  testConnectorConnection,
  type ConnectorConnectionSummary,
  type ConnectorConfirmationResult,
  type ConnectorProviderId,
  type ConnectorRunOperation,
  type ConnectorRunSummary,
} from "@/server/services/connector-hub";
import {
  ConnectorRuntimeConfigurationError,
  resolveConnectorExecutionRuntime,
} from "@/server/services/connector-hub/execution-runtime";
import { getDb } from "@/server/db";
import { isDenialError, sessionCookieOptions } from "@/server/auth";
import {
  getRouteSession,
  requireConnectorWorkspaceRoute,
} from "@/server/workspace-session";

const WORKSPACE_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const PROVIDERS = new Set<ConnectorProviderId>(["airtable", "hubspot", "salesforce"]);
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONFIRMATION_TOKEN = /^[0-9a-f]{64}$/u;
const CONNECTOR_CONFIRMATION_COOKIE = "sympose_connector_confirmation";

export type ConnectorConnectionActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "success";
      readonly code: "CONNECTOR_CONNECTION_SAVED" | "CONNECTOR_CONNECTION_REVOKED";
      readonly provider: ConnectorProviderId;
      readonly status: ConnectorConnectionSummary["status"] | null;
      readonly message: string;
      readonly revalidated: boolean;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export const CONNECTOR_CONNECTION_ACTION_IDLE: ConnectorConnectionActionState = { kind: "idle" };

export type ConnectorExecutionActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "result";
      readonly code: string;
      readonly provider: ConnectorProviderId;
      readonly operation: ConnectorRunOperation;
      readonly run: ConnectorRunSummary;
      readonly message: string;
      readonly confirmation?: Omit<ConnectorConfirmationResult, "run">;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export const CONNECTOR_EXECUTION_ACTION_IDLE: ConnectorExecutionActionState = { kind: "idle" };

function frameworkControlFlow(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const digest = (error as { readonly digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

function textField(formData: FormData, name: string, maximumLength: number): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INPUT_INVALID");
  }
  return value;
}

function routeWorkspace(formData: FormData): string {
  const workspace = textField(formData, "workspace", 128);
  if (!WORKSPACE_SLUG.test(workspace)) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INPUT_INVALID");
  }
  return workspace;
}

function routeProvider(formData: FormData): ConnectorProviderId {
  const provider = textField(formData, "provider", 32);
  if (!PROVIDERS.has(provider as ConnectorProviderId)) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INPUT_INVALID");
  }
  return provider as ConnectorProviderId;
}

function routeExpectedVersion(formData: FormData): number {
  const raw = textField(formData, "expectedVersion", 16);
  if (!/^(?:0|[1-9][0-9]{0,14})$/u.test(raw)) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INPUT_INVALID");
  }
  const version = Number(raw);
  if (!Number.isSafeInteger(version)) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INPUT_INVALID");
  }
  return version;
}

function optionalField(formData: FormData, name: string, maximumLength: number): string | undefined {
  const value = formData.get(name);
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INPUT_INVALID");
  }
  return value;
}

function providerConfig(formData: FormData, provider: ConnectorProviderId): unknown {
  switch (provider) {
    case "airtable":
      return {
        baseId: textField(formData, "baseId", 80),
        tableName: textField(formData, "tableName", 256),
      };
    case "hubspot":
      return {
        ...(optionalField(formData, "portalId", 64) === undefined
          ? {}
          : { portalId: optionalField(formData, "portalId", 64) }),
        ...(optionalField(formData, "portalName", 256) === undefined
          ? {}
          : { portalName: optionalField(formData, "portalName", 256) }),
      };
    case "salesforce":
      return {
        instanceUrl: textField(formData, "instanceUrl", 256),
        apiVersion: textField(formData, "apiVersion", 16),
      };
  }
}

function actionError(error: unknown): ConnectorConnectionActionState {
  if (isDenialError(error)) {
    return {
      kind: "error",
      code: error.code,
      message: "This connector action is not available in the authorized workspace.",
    };
  }
  if (error instanceof ConnectorConnectionError) {
    const messages: Record<string, string> = {
      CONNECTOR_CONNECTION_CONFIG_INVALID: "The provider configuration is invalid or contains an unsupported field.",
      CONNECTOR_CONNECTION_INPUT_INVALID: "The connector form is invalid. Reload and enter the supported fields.",
      CONNECTOR_CONNECTION_INACTIVE: "The connector connection is inactive. Save a new secret before retrying.",
      CONNECTOR_CONNECTION_SECRET_REQUIRED: "Enter a provider secret to create or reactivate this connection.",
      CONNECTOR_CONNECTION_STALE: "The connection changed or was revoked before execution. Reload before retrying.",
      CONNECTOR_CONNECTION_STORAGE_INVALID: "The stored connector state could not be validated. No provider operation was attempted.",
      CONNECTOR_CONNECTION_VERSION_CONFLICT: "The connection changed after this page loaded. Reload before retrying.",
      CONNECTOR_VAULT_KEY_INVALID: "The connector vault deployment key is invalid. No secret was stored.",
      CONNECTOR_VAULT_KEY_REQUIRED: "The connector vault deployment key is not configured. No secret was stored.",
      CONNECTOR_WORKSPACE_NOT_FOUND: "The authorized workspace is unavailable. Reload before retrying.",
    };
    return {
      kind: "error",
      code: error.code,
      message: messages[error.code] ?? "The connector action could not be completed.",
    };
  }
  return {
    kind: "error",
    code: "CONNECTOR_CONNECTION_FAILED",
    message: "The connector action could not be completed. No provider operation was attempted.",
  };
}

function runActionError(error: unknown): ConnectorExecutionActionState {
  if (isDenialError(error)) {
    return {
      kind: "error",
      code: error.code,
      message: "This connector operation is not available in the authorized workspace.",
    };
  }
  if (error instanceof ConnectorConnectionError) {
    const state = actionError(error);
    return state.kind === "error"
      ? state
      : { kind: "error", code: "CONNECTOR_CONNECTION_FAILED", message: "The connector operation was denied." };
  }
  if (error instanceof ConnectorRuntimeConfigurationError) {
    return {
      kind: "error",
      code: error.code,
      message: "Connector execution is not explicitly and completely configured. No provider request was attempted.",
    };
  }
  if (error instanceof ConnectorOrchestrationError) {
    const messages: Partial<Record<ConnectorOrchestrationError["code"], string>> = {
      CONNECTOR_RUNTIME_INJECTION_REQUIRED: "The server-issued connector transport was rejected. No provider request was attempted.",
      CONNECTOR_OPERATION_KEY_INVALID: "The operation key is invalid. Reload before retrying.",
      CONNECTOR_RUN_NOT_FOUND: "The connector run is unavailable in this workspace.",
      CONNECTOR_RUN_IDEMPOTENCY_CONFLICT: "That operation key is already bound to different input.",
      CONNECTOR_RUN_STATE_INVALID: "The connector run cannot transition from its current durable state.",
      CONNECTOR_RUN_STALE: "The connection changed or was revoked before the run completed.",
      CONNECTOR_CONFIRMATION_INVALID: "The one-time import confirmation is missing or invalid.",
      CONNECTOR_CONFIRMATION_EXPIRED: "The one-time import confirmation expired. Issue a new confirmation after reviewing the preview.",
      CONNECTOR_CONFIRMATION_REPLAYED: "That import confirmation was already used or the run is no longer confirmable.",
      CONNECTOR_CANONICAL_CONFLICT: "Canonical identity changed after preview. No import writes were committed.",
    };
    return {
      kind: "error",
      code: error.code,
      message: messages[error.code] ?? "The bounded connector run could not be completed.",
    };
  }
  return {
    kind: "error",
    code: "CONNECTOR_EXECUTION_FAILED",
    message: "The bounded connector run could not be completed. No raw provider error is available.",
  };
}

function revalidateConnectorPath(workspaceSlug: string): boolean {
  try {
    revalidatePath(`/w/${workspaceSlug}/connectors`);
    return true;
  } catch {
    return false;
  }
}

function revalidateCanonicalSurfaces(workspaceSlug: string): void {
  revalidateConnectorPath(workspaceSlug);
  try {
    revalidatePath(`/w/${workspaceSlug}/crm`);
    revalidatePath(`/w/${workspaceSlug}/dashboard`);
  } catch {
    // The durable transaction has completed; cache invalidation failure is safe to recover by reload.
  }
}

function routeOperationKey(formData: FormData): string {
  return textField(formData, "operationKey", 128);
}

function routeRunId(formData: FormData): string {
  const runId = textField(formData, "runId", 64).toLowerCase();
  if (!RUN_ID.test(runId)) throw new ConnectorOrchestrationError("CONNECTOR_RUN_NOT_FOUND");
  return runId;
}

function runMessage(run: ConnectorRunSummary, label: string): string {
  if (run.state === "SUCCEEDED") {
    return `${label} succeeded with a durable redacted receipt.`;
  }
  if (run.state === "PREVIEW_READY") {
    return `${label} produced a reloadable preview. Review every disposition before confirming.`;
  }
  if (run.state === "RUNNING") {
    return `${label} is already claimed by another request; no duplicate provider operation was started.`;
  }
  if (run.state === "UNKNOWN") {
    return `${label} has an unknown outcome and requires reconciliation; it will not be blindly replayed.`;
  }
  return `${label} recorded ${run.state.toLowerCase().replaceAll("_", " ")} with redacted code ${run.errorCode ?? "NONE"}.`;
}

async function setConfirmationCookie(workspace: string, runId: string, token: string): Promise<void> {
  const store = await cookies();
  const base = sessionCookieOptions();
  store.set(CONNECTOR_CONFIRMATION_COOKIE, `${runId}.${token}`, {
    ...base,
    path: `/w/${workspace}/connectors`,
    maxAge: 15 * 60,
  });
}

async function clearConfirmationCookie(workspace: string): Promise<void> {
  const store = await cookies();
  const base = sessionCookieOptions();
  store.set(CONNECTOR_CONFIRMATION_COOKIE, "", {
    ...base,
    path: `/w/${workspace}/connectors`,
    maxAge: 0,
    expires: new Date(0),
  });
}

async function confirmationTokenFor(workspace: string, runId: string): Promise<string | undefined> {
  const store = await cookies();
  const value = store.get(CONNECTOR_CONFIRMATION_COOKIE)?.value;
  if (!value) return undefined;
  const separator = value.indexOf(".");
  const cookieRunId = separator === -1 ? "" : value.slice(0, separator);
  const token = separator === -1 ? "" : value.slice(separator + 1);
  if (cookieRunId !== runId || !CONFIRMATION_TOKEN.test(token)) {
    await clearConfirmationCookie(workspace);
    return undefined;
  }
  return token;
}

export async function saveConnectorConnectionAction(
  _previousState: ConnectorConnectionActionState,
  formData: FormData,
): Promise<ConnectorConnectionActionState> {
  try {
    const session = await getRouteSession();
    const workspace = routeWorkspace(formData);
    requireConnectorWorkspaceRoute(session, workspace);
    const provider = routeProvider(formData);
    const secretValue = formData.get("secret");
    if (secretValue !== null && typeof secretValue !== "string") {
      throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INPUT_INVALID");
    }
    const secret = secretValue === null || secretValue.length === 0 ? undefined : secretValue;
    const connection = saveConnectorConnection(getDb(), session, workspace, {
      provider,
      config: providerConfig(formData, provider),
      secret,
      expectedVersion: routeExpectedVersion(formData),
    });
    const revalidated = revalidateConnectorPath(session.workspaceSlug);
    return {
      kind: "success",
      code: "CONNECTOR_CONNECTION_SAVED",
      provider,
      status: connection.status,
      message: revalidated
        ? `${provider} connection saved. The secret remains masked and no provider request was made.`
        : `${provider} connection saved. Refresh the Connector Hub to see the updated status.`,
      revalidated,
    };
  } catch (error) {
    if (frameworkControlFlow(error)) throw error;
    return actionError(error);
  }
}

export async function revokeConnectorConnectionAction(
  _previousState: ConnectorConnectionActionState,
  formData: FormData,
): Promise<ConnectorConnectionActionState> {
  try {
    const session = await getRouteSession();
    const workspace = routeWorkspace(formData);
    requireConnectorWorkspaceRoute(session, workspace);
    const provider = routeProvider(formData);
    const connection = revokeConnectorConnection(
      getDb(),
      session,
      workspace,
      provider,
      routeExpectedVersion(formData),
    );
    const revalidated = revalidateConnectorPath(session.workspaceSlug);
    return {
      kind: "success",
      code: "CONNECTOR_CONNECTION_REVOKED",
      provider,
      status: connection?.status ?? null,
      message: revalidated
        ? connection
          ? `${provider} connection revoked. Its active secret was removed from the current connection state.`
          : `${provider} has no configured connection.`
        : `${provider} revoke state saved. Refresh the Connector Hub to see the updated status.`,
      revalidated,
    };
  } catch (error) {
    if (frameworkControlFlow(error)) throw error;
    return actionError(error);
  }
}

export async function testConnectorConnectionAction(
  _previousState: ConnectorExecutionActionState,
  formData: FormData,
): Promise<ConnectorExecutionActionState> {
  try {
    const session = await getRouteSession();
    const workspace = routeWorkspace(formData);
    requireConnectorWorkspaceRoute(session, workspace);
    const provider = routeProvider(formData);
    const runtime = resolveConnectorExecutionRuntime(provider);
    const run = await testConnectorConnection(
      getDb(),
      session,
      workspace,
      provider,
      routeOperationKey(formData),
      runtime,
    );
    revalidateConnectorPath(workspace);
    return {
      kind: "result",
      code: "CONNECTOR_TEST_RECORDED",
      provider,
      operation: "TEST",
      run,
      message: runMessage(run, "Connection test"),
    };
  } catch (error) {
    if (frameworkControlFlow(error)) throw error;
    return runActionError(error);
  }
}

export async function previewConnectorImportAction(
  _previousState: ConnectorExecutionActionState,
  formData: FormData,
): Promise<ConnectorExecutionActionState> {
  try {
    const session = await getRouteSession();
    const workspace = routeWorkspace(formData);
    requireConnectorWorkspaceRoute(session, workspace);
    const provider = routeProvider(formData);
    const runtime = resolveConnectorExecutionRuntime(provider);
    const preview = await createConnectorImportPreview(
      getDb(),
      session,
      workspace,
      provider,
      routeOperationKey(formData),
      runtime,
    );
    if (preview.confirmationToken) {
      await setConfirmationCookie(workspace, preview.run.id, preview.confirmationToken);
    }
    revalidateConnectorPath(workspace);
    return {
      kind: "result",
      code: "CONNECTOR_IMPORT_PREVIEW_RECORDED",
      provider,
      operation: "IMPORT",
      run: preview.run,
      message: `${runMessage(preview.run, "Import")} ${preview.rows.length} bounded preview row${preview.rows.length === 1 ? "" : "s"} persisted.`,
    };
  } catch (error) {
    if (frameworkControlFlow(error)) throw error;
    return runActionError(error);
  }
}

export async function issueConnectorImportConfirmationAction(
  _previousState: ConnectorExecutionActionState,
  formData: FormData,
): Promise<ConnectorExecutionActionState> {
  try {
    const session = await getRouteSession();
    const workspace = routeWorkspace(formData);
    requireConnectorWorkspaceRoute(session, workspace);
    const runId = routeRunId(formData);
    const token = issueConnectorImportConfirmation(getDb(), session, workspace, runId);
    const preview = getConnectorImportPreview(getDb(), session, workspace, runId);
    if (!preview) throw new ConnectorOrchestrationError("CONNECTOR_RUN_NOT_FOUND");
    await setConfirmationCookie(workspace, runId, token);
    revalidateConnectorPath(workspace);
    return {
      kind: "result",
      code: "CONNECTOR_CONFIRMATION_ISSUED",
      provider: preview.run.provider,
      operation: "IMPORT",
      run: preview.run,
      message: "A new one-time 15-minute confirmation was issued after server-side authorization.",
    };
  } catch (error) {
    if (frameworkControlFlow(error)) throw error;
    return runActionError(error);
  }
}

export async function confirmConnectorImportAction(
  _previousState: ConnectorExecutionActionState,
  formData: FormData,
): Promise<ConnectorExecutionActionState> {
  let workspaceForCookie: string | null = null;
  try {
    const session = await getRouteSession();
    const workspace = routeWorkspace(formData);
    workspaceForCookie = workspace;
    requireConnectorWorkspaceRoute(session, workspace);
    const runId = routeRunId(formData);
    const token = await confirmationTokenFor(workspace, runId);
    const confirmation = confirmConnectorImport(getDb(), session, workspace, runId, token);
    await clearConfirmationCookie(workspace);
    revalidateCanonicalSurfaces(workspace);
    return {
      kind: "result",
      code: "CONNECTOR_IMPORT_CONFIRMED",
      provider: confirmation.run.provider,
      operation: "IMPORT",
      run: confirmation.run,
      confirmation: {
        created: confirmation.created,
        linked: confirmation.linked,
        updated: confirmation.updated,
        conflicts: confirmation.conflicts,
      },
      message: `Import confirmed: ${confirmation.created} created, ${confirmation.linked} linked, ${confirmation.updated} updated, ${confirmation.conflicts} left in review.`,
    };
  } catch (error) {
    if (frameworkControlFlow(error)) throw error;
    if (workspaceForCookie) await clearConfirmationCookie(workspaceForCookie);
    return runActionError(error);
  }
}

export async function exportConnectorPeopleAction(
  _previousState: ConnectorExecutionActionState,
  formData: FormData,
): Promise<ConnectorExecutionActionState> {
  try {
    const session = await getRouteSession();
    const workspace = routeWorkspace(formData);
    requireConnectorWorkspaceRoute(session, workspace);
    const provider = routeProvider(formData);
    const runtime = resolveConnectorExecutionRuntime(provider);
    const run = await exportCanonicalPeopleToConnector(
      getDb(),
      session,
      workspace,
      provider,
      routeOperationKey(formData),
      runtime,
    );
    revalidateConnectorPath(workspace);
    return {
      kind: "result",
      code: "CONNECTOR_EXPORT_RECORDED",
      provider,
      operation: "EXPORT",
      run,
      message: runMessage(
        run,
        runtime.dataMode === "synthetic-evaluator" ? "Synthetic fixture export" : "Provider export",
      ),
    };
  } catch (error) {
    if (frameworkControlFlow(error)) throw error;
    return runActionError(error);
  }
}
