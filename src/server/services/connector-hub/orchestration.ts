import { timingSafeEqual } from "node:crypto";

import {
  assertWorkspaceMatch,
  requireCapability,
  type SessionInfo,
} from "../../auth";
import {
  canonicalJson,
  deterministicUuid,
  fingerprintOf,
  nowIso,
  randomToken,
  sha256Hex,
  uuid,
} from "../../canonical";
import { withTransaction, type Db } from "../../db";
import {
  CONNECTOR_RUN_MAX_ATTEMPTS,
  CONNECTOR_RUN_MAX_ITEMS,
  CONNECTOR_RUN_MAX_PAGES,
} from "../../schema";
import {
  assertConnectorExecutionSnapshotCurrent,
  loadActiveConnectorExecutionSnapshot,
  type ConnectorExecutionSnapshot,
} from "./connections";
import type { ConnectorProviderId } from "./contracts";
import {
  createAirtableProvider,
  createHubSpotProvider,
  createSalesforceProvider,
  type CanonicalPerson,
  type ExternalContact,
  type ProviderAdapter,
  type ProviderFailure,
} from "./providers";
import {
  assertConnectorExecutionRuntime,
  type ConnectorExecutionRuntime,
} from "./execution-runtime";
import {
  createActorEvidence,
  createCommandEnvelope,
  createCommandIdentityEvidence,
  fingerprintActorEvidence,
  preflightAuthorityPurpose,
  unavailableEvidence,
} from "../authority-purpose-kernel";

export const CONNECTOR_IMPORT_PAGE_LIMIT = Math.min(10, CONNECTOR_RUN_MAX_PAGES);
export const CONNECTOR_IMPORT_ITEM_LIMIT = Math.min(500, CONNECTOR_RUN_MAX_ITEMS);
export const CONNECTOR_CONFIRMATION_TTL_MS = 15 * 60 * 1_000;
export const CONNECTOR_EXECUTION_LEASE_MS = 10 * 60 * 1_000;

export type ConnectorRunOperation = "TEST" | "IMPORT" | "EXPORT";
export type ConnectorRunState =
  | "CREATED"
  | "RUNNING"
  | "PREVIEW_READY"
  | "CONFIRMED"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "UNKNOWN";

export type ConnectorRetryClassification = "NONE" | "RETRYABLE" | "TERMINAL" | "AMBIGUOUS" | "STALE";
export type ConnectorPreviewDisposition = "CREATE" | "LINK" | "UPDATE" | "CONFLICT";

export interface ConnectorRunSummary {
  readonly id: string;
  readonly provider: ConnectorProviderId;
  readonly operation: ConnectorRunOperation;
  readonly state: ConnectorRunState;
  readonly connectionVersion: number;
  readonly pageCount: number;
  readonly itemCount: number;
  readonly attemptCount: number;
  readonly retryClassification: ConnectorRetryClassification;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface ConnectorPreviewRow {
  readonly id: string;
  readonly providerRecordId: string;
  readonly externalIdentity: string;
  readonly normalizedEmail: string | null;
  readonly fullName: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly sourceVersion: string;
  readonly evidenceFingerprint: string;
  readonly disposition: ConnectorPreviewDisposition;
  readonly candidatePersonId: string | null;
  readonly conflictCode: string | null;
  readonly appliedSourceRecordId: string | null;
}

export interface ConnectorImportPreviewResult {
  readonly run: ConnectorRunSummary;
  readonly rows: readonly ConnectorPreviewRow[];
  /** Plaintext is returned exactly once so the server action can place it in an httpOnly cookie. */
  readonly confirmationToken: string | null;
  readonly replayed: boolean;
}

export interface ConnectorConfirmationResult {
  readonly run: ConnectorRunSummary;
  readonly created: number;
  readonly linked: number;
  readonly updated: number;
  readonly conflicts: number;
}

export type ConnectorOrchestrationErrorCode =
  | "CONNECTOR_RUNTIME_INJECTION_REQUIRED"
  | "CONNECTOR_OPERATION_KEY_INVALID"
  | "CONNECTOR_RUN_NOT_FOUND"
  | "CONNECTOR_RUN_IDEMPOTENCY_CONFLICT"
  | "CONNECTOR_RUN_STATE_INVALID"
  | "CONNECTOR_RUN_STALE"
  | "CONNECTOR_IMPORT_LIMIT_EXCEEDED"
  | "CONNECTOR_IMPORT_DUPLICATE_PAGE"
  | "CONNECTOR_CONFIRMATION_INVALID"
  | "CONNECTOR_CONFIRMATION_EXPIRED"
  | "CONNECTOR_CONFIRMATION_REPLAYED"
  | "CONNECTOR_CANONICAL_CONFLICT";

export class ConnectorOrchestrationError extends Error {
  readonly code: ConnectorOrchestrationErrorCode;

  constructor(code: ConnectorOrchestrationErrorCode) {
    super(code);
    this.name = "ConnectorOrchestrationError";
    this.code = code;
  }
}

interface RunRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly provider: ConnectorProviderId;
  readonly operation: ConnectorRunOperation;
  readonly state: ConnectorRunState;
  readonly connectionVersion: number;
  readonly configFingerprint: string;
  readonly idempotencyKeyHash: string;
  readonly inputFingerprint: string;
  readonly providerCursor: string | null;
  readonly pageCount: number;
  readonly itemCount: number;
  readonly attemptCount: number;
  readonly retryClassification: ConnectorRetryClassification;
  readonly errorCode: string | null;
  readonly createdByAccountId: string;
  readonly confirmationTokenHash: string | null;
  readonly confirmationExpiresAt: string | null;
  readonly confirmedAt: string | null;
  readonly confirmedByAccountId: string | null;
  readonly startedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface PreviewDbRow extends ConnectorPreviewRow {
  readonly workspaceId: string;
  readonly runId: string;
  readonly provider: ConnectorProviderId;
  readonly evidenceJson: string;
  readonly candidatePersonFingerprint: string | null;
}

interface ExportAuthorityDbRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly provider: ConnectorProviderId;
  readonly personId: string;
  readonly eventId: string;
  readonly version: number;
  readonly purposeEvidenceJson: string;
  readonly purposeEvidenceFingerprint: string;
  readonly retentionEvidenceJson: string;
  readonly retentionEvidenceFingerprint: string;
  readonly authorityEvidenceJson: string;
  readonly authorityEvidenceFingerprint: string;
  readonly recordedAt: string;
}

interface ExportCandidate {
  readonly person: CanonicalPerson;
  readonly authority: ExportAuthorityDbRow | null;
}

function requireExecutionRuntime(
  options: ConnectorExecutionRuntime,
  provider: ConnectorProviderId,
): ConnectorExecutionRuntime {
  try {
    assertConnectorExecutionRuntime(options, provider);
  } catch {
    throw new ConnectorOrchestrationError("CONNECTOR_RUNTIME_INJECTION_REQUIRED");
  }
  return options;
}

function operationKeyHash(value: unknown): string {
  if (
    typeof value !== "string" || value.length < 8 || value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new ConnectorOrchestrationError("CONNECTOR_OPERATION_KEY_INVALID");
  }
  return sha256Hex(value);
}

function requireConnectorAccess(db: Db, session: SessionInfo, workspaceSlug: string): void {
  assertWorkspaceMatch(session, workspaceSlug);
  requireCapability(db, session, "connectors.manage");
}

function adapterFor(snapshot: ConnectorExecutionSnapshot, options: ConnectorExecutionRuntime): ProviderAdapter {
  const runtime = requireExecutionRuntime(options, snapshot.provider);
  switch (snapshot.config.provider) {
    case "airtable":
      return createAirtableProvider({
        token: snapshot.secret,
        baseId: snapshot.config.baseId,
        tableName: snapshot.config.tableName,
      }, runtime);
    case "hubspot":
      return createHubSpotProvider({ token: snapshot.secret }, runtime);
    case "salesforce":
      return createSalesforceProvider({
        token: snapshot.secret,
        instanceOrigin: snapshot.config.instanceUrl,
        apiVersion: snapshot.config.apiVersion,
      }, runtime);
  }
}

function selectRun(db: Db, workspaceId: string, runId: string): RunRow | null {
  return (db.prepare(
    `SELECT id, workspace_id AS workspaceId, connection_id AS connectionId, provider, operation, state,
            connection_version AS connectionVersion, config_fingerprint AS configFingerprint,
            idempotency_key_hash AS idempotencyKeyHash, input_fingerprint AS inputFingerprint,
            provider_cursor AS providerCursor, page_count AS pageCount, item_count AS itemCount,
            attempt_count AS attemptCount, retry_classification AS retryClassification,
            error_code AS errorCode, created_by_account_id AS createdByAccountId,
            confirmation_token_hash AS confirmationTokenHash,
            confirmation_expires_at AS confirmationExpiresAt, confirmed_at AS confirmedAt,
            confirmed_by_account_id AS confirmedByAccountId, started_at AS startedAt,
            created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
       FROM connector_runs WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, runId) as RunRow | undefined) ?? null;
}

function runSummary(row: RunRow): ConnectorRunSummary {
  return Object.freeze({
    id: row.id,
    provider: row.provider,
    operation: row.operation,
    state: row.state,
    connectionVersion: row.connectionVersion,
    pageCount: row.pageCount,
    itemCount: row.itemCount,
    attemptCount: row.attemptCount,
    retryClassification: row.retryClassification,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  });
}

function beginRun(
  db: Db,
  session: SessionInfo,
  snapshot: ConnectorExecutionSnapshot,
  operation: ConnectorRunOperation,
  keyHash: string,
  inputFingerprint: string,
): { readonly row: RunRow; readonly replayed: boolean } {
  return withTransaction(db, () => {
    const existing = db.prepare(
      `SELECT id FROM connector_runs
       WHERE workspace_id = ? AND connection_id = ? AND operation = ? AND idempotency_key_hash = ?`,
    ).get(snapshot.workspaceId, snapshot.id, operation, keyHash) as { readonly id: string } | undefined;
    if (existing) {
      const row = selectRun(db, snapshot.workspaceId, existing.id);
      if (
        !row || row.connectionVersion !== snapshot.version ||
        row.configFingerprint !== snapshot.configFingerprint || row.inputFingerprint !== inputFingerprint ||
        row.createdByAccountId !== session.accountId
      ) {
        throw new ConnectorOrchestrationError("CONNECTOR_RUN_IDEMPOTENCY_CONFLICT");
      }
      return { row, replayed: true };
    }
    const id = deterministicUuid(
      `connector-run:${snapshot.workspaceId}:${snapshot.id}:${operation}:${keyHash}`,
    );
    const at = nowIso();
    db.prepare(
      `INSERT INTO connector_runs
         (id, workspace_id, connection_id, provider, operation, state, connection_version,
          config_fingerprint, idempotency_key_hash, input_fingerprint, created_by_account_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      snapshot.workspaceId,
      snapshot.id,
      snapshot.provider,
      operation,
      snapshot.version,
      snapshot.configFingerprint,
      keyHash,
      inputFingerprint,
      session.accountId,
      at,
      at,
    );
    return { row: selectRun(db, snapshot.workspaceId, id)!, replayed: false };
  });
}

function connectionBinding(row: RunRow): Pick<ConnectorExecutionSnapshot, "id" | "provider" | "version" | "configFingerprint"> {
  return {
    id: row.connectionId,
    provider: row.provider,
    version: row.connectionVersion,
    configFingerprint: row.configFingerprint,
  };
}

function retryClassification(failure: ProviderFailure): ConnectorRetryClassification {
  if (failure.ambiguous) return "AMBIGUOUS";
  return failure.retryable ? "RETRYABLE" : "TERMINAL";
}

function failureState(failure: ProviderFailure): ConnectorRunState {
  if (failure.ambiguous) return "UNKNOWN";
  return failure.retryable ? "FAILED_RETRYABLE" : "FAILED_TERMINAL";
}

function attemptOutcomeForFailure(
  failure: ProviderFailure,
): "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "UNKNOWN" {
  if (failure.ambiguous) return "UNKNOWN";
  return failure.retryable ? "FAILED_RETRYABLE" : "FAILED_TERMINAL";
}

const EXPLICIT_OUTBOUND_REJECTION_CODES = new Set<ProviderFailure["code"]>([
  "CONFIGURATION_INVALID",
  "INVALID_INPUT",
  "BATCH_LIMIT_EXCEEDED",
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_FAILED",
  "NOT_FOUND",
]);

function recordAttempt(
  db: Db,
  run: RunRow,
  input: {
    readonly cursorBefore: string | null;
    readonly cursorAfter: string | null;
    readonly providerAttempts: number;
    readonly pageItems: number;
    readonly outcome: "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "UNKNOWN" | "STALE";
    readonly retry: ConnectorRetryClassification;
    readonly errorCode: string | null;
    readonly startedAt: string;
    readonly completedAt: string;
  },
): number {
  const attemptNumber = run.attemptCount + 1;
  db.prepare(
    `INSERT INTO connector_run_attempts
       (id, workspace_id, run_id, attempt_number, cursor_before, cursor_after, provider_attempts,
        page_items, outcome, retry_classification, error_code, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    deterministicUuid(`connector-run-attempt:${run.id}:${attemptNumber}`),
    run.workspaceId,
    run.id,
    attemptNumber,
    input.cursorBefore,
    input.cursorAfter,
    input.providerAttempts,
    input.pageItems,
    input.outcome,
    input.retry,
    input.errorCode,
    input.startedAt,
    input.completedAt,
  );
  return attemptNumber;
}

function markRunFailure(
  db: Db,
  run: RunRow,
  failure: ProviderFailure,
  startedAt: string,
): RunRow {
  const completedAt = nowIso();
  const state = failureState(failure);
  const retry = retryClassification(failure);
  const attemptCount = recordAttempt(db, run, {
    cursorBefore: run.providerCursor,
    cursorAfter: null,
    providerAttempts: 0,
    pageItems: 0,
    outcome: attemptOutcomeForFailure(failure),
    retry,
    errorCode: failure.code,
    startedAt,
    completedAt,
  });
  db.prepare(
    `UPDATE connector_runs SET state = ?, attempt_count = ?, retry_classification = ?,
       error_code = ?, updated_at = ?, completed_at = ? WHERE id = ? AND workspace_id = ?`,
  ).run(
    state,
    attemptCount,
    retry,
    failure.code,
    completedAt,
    state === "FAILED_RETRYABLE" ? null : completedAt,
    run.id,
    run.workspaceId,
  );
  return selectRun(db, run.workspaceId, run.id)!;
}

function markStaleRun(db: Db, run: RunRow, startedAt: string): RunRow {
  const completedAt = nowIso();
  const attemptCount = recordAttempt(db, run, {
    cursorBefore: run.providerCursor,
    cursorAfter: null,
    providerAttempts: 0,
    pageItems: 0,
    outcome: "STALE",
    retry: "STALE",
    errorCode: "CONNECTION_STALE",
    startedAt,
    completedAt,
  });
  db.prepare(
    `UPDATE connector_runs SET state = 'UNKNOWN', attempt_count = ?, retry_classification = 'STALE',
       error_code = 'CONNECTION_STALE', updated_at = ?, completed_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(attemptCount, completedAt, completedAt, run.id, run.workspaceId);
  return selectRun(db, run.workspaceId, run.id)!;
}

function markUnknownRun(
  db: Db,
  run: RunRow,
  startedAt: string,
  providerAttempts: number,
  pageItems: number,
  errorCode: string,
): RunRow {
  const completedAt = nowIso();
  const attemptCount = recordAttempt(db, run, {
    cursorBefore: run.providerCursor,
    cursorAfter: null,
    providerAttempts,
    pageItems,
    outcome: "UNKNOWN",
    retry: "AMBIGUOUS",
    errorCode,
    startedAt,
    completedAt,
  });
  db.prepare(
    `UPDATE connector_runs SET state = 'UNKNOWN', attempt_count = ?, retry_classification = 'AMBIGUOUS',
       error_code = ?, updated_at = ?, completed_at = ? WHERE id = ? AND workspace_id = ?`,
  ).run(attemptCount, errorCode, completedAt, completedAt, run.id, run.workspaceId);
  return selectRun(db, run.workspaceId, run.id)!;
}

function runningLeaseIsFresh(run: RunRow, nowMs: number): boolean {
  const updatedMs = Date.parse(run.updatedAt);
  return Number.isFinite(updatedMs) && updatedMs > nowMs - CONNECTOR_EXECUTION_LEASE_MS;
}

function markInterruptedReadRun(db: Db, run: RunRow): RunRow {
  const completedAt = nowIso();
  const attemptCount = recordAttempt(db, run, {
    cursorBefore: run.providerCursor,
    cursorAfter: null,
    providerAttempts: 0,
    pageItems: 0,
    outcome: "FAILED_RETRYABLE",
    retry: "RETRYABLE",
    errorCode: "EXECUTION_INTERRUPTED",
    startedAt: run.updatedAt,
    completedAt,
  });
  db.prepare(
    `UPDATE connector_runs SET state = 'FAILED_RETRYABLE', attempt_count = ?,
       retry_classification = 'RETRYABLE', error_code = 'EXECUTION_INTERRUPTED',
       updated_at = ?, completed_at = NULL WHERE id = ? AND workspace_id = ? AND state = 'RUNNING'`,
  ).run(attemptCount, completedAt, run.id, run.workspaceId);
  return selectRun(db, run.workspaceId, run.id)!;
}

function markAttemptBudgetExhausted(db: Db, run: RunRow): RunRow {
  const at = nowIso();
  db.prepare(
    `UPDATE connector_runs SET state = 'FAILED_TERMINAL', retry_classification = 'TERMINAL',
       error_code = 'ATTEMPT_LIMIT_EXCEEDED', updated_at = ?, completed_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(at, at, run.id, run.workspaceId);
  return selectRun(db, run.workspaceId, run.id)!;
}

/**
 * Atomically claim a run before any await/network boundary. A fresh RUNNING row is owned by the
 * first caller. An expired outbound claim becomes UNKNOWN instead of risking a duplicate write;
 * expired read-only TEST/IMPORT work becomes retryable and requires a fresh deliberate retry.
 */
function claimRunForExecution(
  db: Db,
  run: RunRow,
): { readonly run: RunRow; readonly claimed: boolean } {
  return withTransaction(db, () => {
    const current = selectRun(db, run.workspaceId, run.id);
    if (!current) throw new ConnectorOrchestrationError("CONNECTOR_RUN_NOT_FOUND");
    if (current.state === "RUNNING") {
      if (runningLeaseIsFresh(current, Date.now())) return { run: current, claimed: false };
      if (current.attemptCount >= CONNECTOR_RUN_MAX_ATTEMPTS) {
        return { run: markAttemptBudgetExhausted(db, current), claimed: false };
      }
      if (current.operation === "EXPORT") {
        return {
          run: markUnknownRun(
            db,
            current,
            current.updatedAt,
            0,
            0,
            "EXPORT_EXECUTION_INTERRUPTED",
          ),
          claimed: false,
        };
      }
      return { run: markInterruptedReadRun(db, current), claimed: false };
    }
    if (current.attemptCount >= CONNECTOR_RUN_MAX_ATTEMPTS) {
      return { run: markAttemptBudgetExhausted(db, current), claimed: false };
    }
    const at = nowIso();
    const changed = db.prepare(
      `UPDATE connector_runs SET state = 'RUNNING', retry_classification = 'NONE', error_code = NULL,
         started_at = COALESCE(started_at, ?), updated_at = ?, completed_at = NULL
       WHERE id = ? AND workspace_id = ? AND state = ? AND updated_at = ?`,
    ).run(at, at, current.id, current.workspaceId, current.state, current.updatedAt).changes;
    const claimed = changed === 1;
    return {
      run: selectRun(db, current.workspaceId, current.id)!,
      claimed,
    };
  });
}

function withOwnedRunTransition<T>(
  db: Db,
  owned: RunRow,
  transition: (current: RunRow) => T,
): { readonly owned: true; readonly value: T } | { readonly owned: false; readonly run: RunRow } {
  return withTransaction(db, () => {
    const current = selectRun(db, owned.workspaceId, owned.id);
    if (!current) throw new ConnectorOrchestrationError("CONNECTOR_RUN_NOT_FOUND");
    if (current.state !== "RUNNING" || current.updatedAt !== owned.updatedAt) {
      return { owned: false as const, run: current };
    }
    return { owned: true as const, value: transition(current) };
  });
}

export async function testConnectorConnection(
  db: Db,
  session: SessionInfo,
  workspaceSlug: string,
  provider: ConnectorProviderId,
  idempotencyKey: string,
  options: ConnectorExecutionRuntime,
): Promise<ConnectorRunSummary> {
  requireConnectorAccess(db, session, workspaceSlug);
  const runtime = requireExecutionRuntime(options, provider);
  const snapshot = loadActiveConnectorExecutionSnapshot(db, session, workspaceSlug, provider);
  const inputFingerprint = fingerprintOf({ schema: "connector-test/v1", provider, connectionVersion: snapshot.version });
  const begun = beginRun(db, session, snapshot, "TEST", operationKeyHash(idempotencyKey), inputFingerprint);
  if (begun.replayed && ["SUCCEEDED", "FAILED_TERMINAL", "UNKNOWN"].includes(begun.row.state)) {
    return runSummary(begun.row);
  }
  const claim = claimRunForExecution(db, begun.row);
  let run = claim.run;
  if (!claim.claimed) return runSummary(run);
  const startedAt = nowIso();
  const preflight = withOwnedRunTransition(db, run, (current) => {
    try {
      assertConnectorExecutionSnapshotCurrent(db, session, workspaceSlug, snapshot);
      return current;
    } catch {
      return markStaleRun(db, current, startedAt);
    }
  });
  if (!preflight.owned) return runSummary(preflight.run);
  run = preflight.value;
  if (run.state !== "RUNNING") return runSummary(run);
  let result: Awaited<ReturnType<ProviderAdapter["validateConnection"]>>;
  try {
    result = await adapterFor(snapshot, runtime).validateConnection();
  } catch {
    const failed = withOwnedRunTransition(
      db,
      run,
      (current) => terminalImportFailure(db, current, "ADAPTER_EXECUTION_FAILED", startedAt),
    );
    return runSummary(failed.owned ? failed.value : failed.run);
  }
  const completed = withOwnedRunTransition(db, run, (current) => {
    try {
      assertConnectorExecutionSnapshotCurrent(db, session, workspaceSlug, snapshot);
    } catch {
      return markStaleRun(db, current, startedAt);
    }
    if (!result.ok) {
      const completedAt = nowIso();
      const state = failureState(result.failure);
      const retry = retryClassification(result.failure);
      const attemptCount = recordAttempt(db, current, {
        cursorBefore: null,
        cursorAfter: null,
        providerAttempts: result.attempts,
        pageItems: 0,
        outcome: attemptOutcomeForFailure(result.failure),
        retry,
        errorCode: result.failure.code,
        startedAt,
        completedAt,
      });
      db.prepare(
        `UPDATE connector_runs SET state = ?, attempt_count = ?, retry_classification = ?, error_code = ?,
           updated_at = ?, completed_at = ? WHERE id = ? AND workspace_id = ?`,
      ).run(state, attemptCount, retry, result.failure.code, completedAt, state === "FAILED_RETRYABLE" ? null : completedAt, current.id, current.workspaceId);
      return selectRun(db, current.workspaceId, current.id)!;
    }
    const completedAt = nowIso();
    const attemptCount = recordAttempt(db, current, {
      cursorBefore: null,
      cursorAfter: null,
      providerAttempts: result.attempts,
      pageItems: result.value.recordsRead,
      outcome: "SUCCEEDED",
      retry: "NONE",
      errorCode: null,
      startedAt,
      completedAt,
    });
    db.prepare(
      `UPDATE connector_runs SET state = 'SUCCEEDED', item_count = ?, attempt_count = ?,
         retry_classification = 'NONE', error_code = NULL, updated_at = ?, completed_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(result.value.recordsRead, attemptCount, completedAt, completedAt, current.id, current.workspaceId);
    return selectRun(db, current.workspaceId, current.id)!;
  });
  return runSummary(completed.owned ? completed.value : completed.run);
}

function contactEvidence(snapshot: ConnectorExecutionSnapshot, contact: ExternalContact): {
  readonly json: string;
  readonly fingerprint: string;
  readonly externalIdentity: string;
} {
  // Connection version/config bind the observation and run, while the external identity remains
  // stable for the lifetime of the workspace/provider connection.
  const externalIdentity = `${snapshot.provider}:${snapshot.id}:${contact.externalId}`;
  const providerPayload = {
    sourceVersion: contact.sourceVersion,
    normalized: {
      email: contact.email,
      fullName: contact.fullName,
      organization: contact.organization,
      title: contact.title,
    },
    fields: contact.sourceEvidence.fields,
  };
  const evidence = {
    schema: "connector-contact-evidence/v1",
    provider: snapshot.provider,
    connectionId: snapshot.id,
    connectionVersion: snapshot.version,
    configFingerprint: snapshot.configFingerprint,
    providerRecordId: contact.externalId,
    externalIdentity,
    observedAt: contact.sourceEvidence.observedAt,
    localPayloadFingerprint: fingerprintOf(providerPayload),
    ...providerPayload,
  };
  return { json: canonicalJson(evidence), fingerprint: fingerprintOf(evidence), externalIdentity };
}

function insertPreviewPage(
  db: Db,
  run: RunRow,
  snapshot: ConnectorExecutionSnapshot,
  contacts: readonly ExternalContact[],
): void {
  const at = nowIso();
  for (const contact of contacts) {
    const evidence = contactEvidence(snapshot, contact);
    const duplicate = db.prepare(
      `SELECT 1 FROM connector_import_preview_rows
       WHERE workspace_id = ? AND run_id = ? AND external_identity = ?`,
    ).get(run.workspaceId, run.id, evidence.externalIdentity);
    if (duplicate) throw new ConnectorOrchestrationError("CONNECTOR_IMPORT_DUPLICATE_PAGE");
    db.prepare(
      `INSERT INTO connector_import_preview_rows
         (id, workspace_id, run_id, provider, provider_record_id, external_identity,
          normalized_email, full_name, organization, title, source_version, evidence_json,
          evidence_fingerprint, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EVALUATING', ?, ?)`,
    ).run(
      deterministicUuid(`connector-preview:${run.id}:${evidence.externalIdentity}`),
      run.workspaceId,
      run.id,
      snapshot.provider,
      contact.externalId,
      evidence.externalIdentity,
      contact.email,
      contact.fullName,
      contact.organization,
      contact.title,
      contact.sourceVersion,
      evidence.json,
      evidence.fingerprint,
      at,
      at,
    );
  }
}

function previewRows(db: Db, workspaceId: string, runId: string): PreviewDbRow[] {
  return db.prepare(
    `SELECT id, workspace_id AS workspaceId, run_id AS runId, provider,
            provider_record_id AS providerRecordId, external_identity AS externalIdentity,
            normalized_email AS normalizedEmail, full_name AS fullName, organization, title,
            source_version AS sourceVersion, evidence_json AS evidenceJson,
            evidence_fingerprint AS evidenceFingerprint, disposition,
            candidate_person_id AS candidatePersonId,
            candidate_person_fingerprint AS candidatePersonFingerprint,
            conflict_code AS conflictCode,
            applied_source_record_id AS appliedSourceRecordId
       FROM connector_import_preview_rows
       WHERE workspace_id = ? AND run_id = ? ORDER BY id`,
  ).all(workspaceId, runId) as unknown as PreviewDbRow[];
}

function publicPreviewRows(rows: readonly PreviewDbRow[]): readonly ConnectorPreviewRow[] {
  return rows.map(({
    workspaceId: _workspaceId,
    runId: _runId,
    provider: _provider,
    evidenceJson: _evidenceJson,
    candidatePersonFingerprint: _candidatePersonFingerprint,
    ...row
  }) => Object.freeze(row));
}

interface PersonIdentityRow {
  readonly id: string;
  readonly canonicalEmail: string;
  readonly fullName: string;
  readonly organization: string | null;
  readonly title: string | null;
}

function personByEmail(db: Db, workspaceId: string, email: string): PersonIdentityRow | null {
  return (db.prepare(
    `SELECT id, canonical_email AS canonicalEmail, full_name AS fullName, organization, title
       FROM people WHERE workspace_id = ? AND canonical_email = ?`,
  ).get(workspaceId, email) as PersonIdentityRow | undefined) ?? null;
}

function personById(db: Db, workspaceId: string, personId: string): PersonIdentityRow | null {
  return (db.prepare(
    `SELECT id, canonical_email AS canonicalEmail, full_name AS fullName, organization, title
       FROM people WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, personId) as PersonIdentityRow | undefined) ?? null;
}

function personPreviewFingerprint(person: PersonIdentityRow): string {
  return fingerprintOf({
    schema: "connector-person-preview/v1",
    id: person.id,
    canonicalEmail: person.canonicalEmail,
    fullName: person.fullName,
    organization: person.organization,
    title: person.title,
  });
}

function personProjection(person: PersonIdentityRow): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: "connector-person-projection/v1",
    id: person.id,
    canonicalEmail: person.canonicalEmail,
    fullName: person.fullName,
    organization: person.organization,
    title: person.title,
  });
}

function personByExternalIdentity(
  db: Db,
  workspaceId: string,
  provider: ConnectorProviderId,
  connectionId: string,
  providerRecordId: string,
): PersonIdentityRow | "AMBIGUOUS" | null {
  const rows = db.prepare(
    `SELECT DISTINCT person.id, person.canonical_email AS canonicalEmail,
            person.full_name AS fullName, person.organization, person.title
       FROM source_records source
       JOIN source_links link
         ON link.source_record_id = source.id AND link.workspace_id = source.workspace_id
       JOIN people person ON person.id = link.person_id AND person.workspace_id = link.workspace_id
       WHERE source.workspace_id = ? AND source.provider = ? AND source.source_ref = ?
       ORDER BY person.id LIMIT 2`,
  ).all(
    workspaceId,
    `connector.${provider}`,
    `${connectionId}:${providerRecordId}`,
  ) as unknown as PersonIdentityRow[];
  if (rows.length > 1) return "AMBIGUOUS";
  return rows[0] ?? null;
}

function needsCanonicalUpdate(person: PersonIdentityRow, row: PreviewDbRow): boolean {
  return person.canonicalEmail !== row.normalizedEmail ||
    (row.fullName !== null && person.fullName !== row.fullName) ||
    (row.organization !== null && person.organization !== row.organization) ||
    (row.title !== null && person.title !== row.title);
}

function finalizePreview(
  db: Db,
  run: RunRow,
): { readonly token: string; readonly run: RunRow } {
  const rows = previewRows(db, run.workspaceId, run.id);
  const emailFrequency = new Map<string, number>();
  for (const row of rows) {
    if (row.normalizedEmail) emailFrequency.set(row.normalizedEmail, (emailFrequency.get(row.normalizedEmail) ?? 0) + 1);
  }
  const at = nowIso();
  for (const row of rows) {
    let disposition: ConnectorPreviewDisposition = "CONFLICT";
    let candidate: PersonIdentityRow | null = null;
    let conflictCode: string | null = null;
    if (!row.normalizedEmail || !row.fullName) {
      conflictCode = "IDENTITY_INCOMPLETE";
    } else if ((emailFrequency.get(row.normalizedEmail) ?? 0) > 1) {
      conflictCode = "AMBIGUOUS_EMAIL_COLLISION";
    } else {
      const external = personByExternalIdentity(
        db,
        run.workspaceId,
        run.provider,
        run.connectionId,
        row.providerRecordId,
      );
      const email = personByEmail(db, run.workspaceId, row.normalizedEmail);
      if (external === "AMBIGUOUS") {
        conflictCode = "AMBIGUOUS_EXTERNAL_IDENTITY";
      } else if (external && email && external.id !== email.id) {
        conflictCode = "EXTERNAL_EMAIL_CONFLICT";
      } else {
        candidate = external ?? email;
        if (!candidate) disposition = "CREATE";
        else disposition = needsCanonicalUpdate(candidate, row) ? "UPDATE" : "LINK";
      }
    }
    db.prepare(
      `UPDATE connector_import_preview_rows
       SET disposition = ?, candidate_person_id = ?, candidate_person_fingerprint = ?,
           conflict_code = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND run_id = ? AND disposition = 'EVALUATING'`,
    ).run(
      disposition,
      candidate?.id ?? null,
      candidate ? personPreviewFingerprint(candidate) : null,
      conflictCode,
      at,
      row.id,
      run.workspaceId,
      run.id,
    );
  }
  const token = randomToken();
  const expiresAt = new Date(Date.parse(at) + CONNECTOR_CONFIRMATION_TTL_MS).toISOString();
  db.prepare(
    `UPDATE connector_runs SET state = 'PREVIEW_READY', confirmation_token_hash = ?,
       confirmation_expires_at = ?, retry_classification = 'NONE', error_code = NULL,
       updated_at = ?, completed_at = NULL WHERE id = ? AND workspace_id = ?`,
  ).run(sha256Hex(token), expiresAt, at, run.id, run.workspaceId);
  return { token, run: selectRun(db, run.workspaceId, run.id)! };
}

function terminalImportFailure(db: Db, run: RunRow, code: string, startedAt: string): RunRow {
  const completedAt = nowIso();
  const attemptCount = recordAttempt(db, run, {
    cursorBefore: run.providerCursor,
    cursorAfter: null,
    providerAttempts: 0,
    pageItems: 0,
    outcome: "FAILED_TERMINAL",
    retry: "TERMINAL",
    errorCode: code,
    startedAt,
    completedAt,
  });
  db.prepare(
    `UPDATE connector_runs SET state = 'FAILED_TERMINAL', attempt_count = ?,
       retry_classification = 'TERMINAL', error_code = ?, updated_at = ?, completed_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(attemptCount, code, completedAt, completedAt, run.id, run.workspaceId);
  return selectRun(db, run.workspaceId, run.id)!;
}

export async function createConnectorImportPreview(
  db: Db,
  session: SessionInfo,
  workspaceSlug: string,
  provider: ConnectorProviderId,
  idempotencyKey: string,
  options: ConnectorExecutionRuntime,
): Promise<ConnectorImportPreviewResult> {
  requireConnectorAccess(db, session, workspaceSlug);
  const runtime = requireExecutionRuntime(options, provider);
  const snapshot = loadActiveConnectorExecutionSnapshot(db, session, workspaceSlug, provider);
  const inputFingerprint = fingerprintOf({
    schema: "connector-import/v1",
    provider,
    connectionVersion: snapshot.version,
    maxPages: CONNECTOR_IMPORT_PAGE_LIMIT,
    maxItems: CONNECTOR_IMPORT_ITEM_LIMIT,
  });
  const begun = beginRun(db, session, snapshot, "IMPORT", operationKeyHash(idempotencyKey), inputFingerprint);
  if (begun.replayed && begun.row.state === "PREVIEW_READY") {
    return { run: runSummary(begun.row), rows: publicPreviewRows(previewRows(db, begun.row.workspaceId, begun.row.id)), confirmationToken: null, replayed: true };
  }
  if (begun.replayed && !["CREATED", "FAILED_RETRYABLE", "PARTIAL", "RUNNING"].includes(begun.row.state)) {
    throw new ConnectorOrchestrationError("CONNECTOR_RUN_STATE_INVALID");
  }
  const claim = claimRunForExecution(db, begun.row);
  let run = claim.run;
  if (!claim.claimed) {
    return {
      run: runSummary(run),
      rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)),
      confirmationToken: null,
      replayed: true,
    };
  }
  const adapter = adapterFor(snapshot, runtime);

  while (true) {
    if (run.attemptCount >= CONNECTOR_RUN_MAX_ATTEMPTS) {
      const exhausted = withOwnedRunTransition(db, run, (current) => markAttemptBudgetExhausted(db, current));
      run = exhausted.owned ? exhausted.value : exhausted.run;
      return { run: runSummary(run), rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)), confirmationToken: null, replayed: begun.replayed };
    }
    if (run.pageCount >= CONNECTOR_IMPORT_PAGE_LIMIT || run.itemCount >= CONNECTOR_IMPORT_ITEM_LIMIT) {
      const limited = withOwnedRunTransition(
        db,
        run,
        (current) => terminalImportFailure(db, current, "IMPORT_LIMIT_EXCEEDED", nowIso()),
      );
      run = limited.owned ? limited.value : limited.run;
      return { run: runSummary(run), rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)), confirmationToken: null, replayed: begun.replayed };
    }
    const startedAt = nowIso();
    const preflight = withOwnedRunTransition(db, run, (current) => {
      try {
        assertConnectorExecutionSnapshotCurrent(db, session, workspaceSlug, snapshot);
        return current;
      } catch {
        return markStaleRun(db, current, startedAt);
      }
    });
    run = preflight.owned ? preflight.value : preflight.run;
    if (!preflight.owned || run.state !== "RUNNING") {
      return { run: runSummary(run), rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)), confirmationToken: null, replayed: begun.replayed };
    }
    const remaining = Math.min(100, CONNECTOR_IMPORT_ITEM_LIMIT - run.itemCount);
    let result: Awaited<ReturnType<ProviderAdapter["readContacts"]>>;
    try {
      result = await adapter.readContacts({ cursor: run.providerCursor, limit: remaining });
    } catch {
      const failed = withOwnedRunTransition(
        db,
        run,
        (current) => terminalImportFailure(db, current, "ADAPTER_EXECUTION_FAILED", startedAt),
      );
      run = failed.owned ? failed.value : failed.run;
      return { run: runSummary(run), rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)), confirmationToken: null, replayed: begun.replayed };
    }
    try {
      const persisted = withOwnedRunTransition(db, run, (current) => {
        try {
          assertConnectorExecutionSnapshotCurrent(db, session, workspaceSlug, snapshot);
        } catch {
          return { run: markStaleRun(db, current, startedAt), confirmationToken: null };
        }
        if (!result.ok) {
          const completedAt = nowIso();
          const state = failureState(result.failure);
          const retry = retryClassification(result.failure);
          const attemptCount = recordAttempt(db, current, {
            cursorBefore: current.providerCursor,
            cursorAfter: null,
            providerAttempts: result.attempts,
            pageItems: 0,
            outcome: attemptOutcomeForFailure(result.failure),
            retry,
            errorCode: result.failure.code,
            startedAt,
            completedAt,
          });
          db.prepare(
            `UPDATE connector_runs SET state = ?, attempt_count = ?, retry_classification = ?,
               error_code = ?, updated_at = ?, completed_at = ? WHERE id = ? AND workspace_id = ?`,
          ).run(state, attemptCount, retry, result.failure.code, completedAt, state === "FAILED_RETRYABLE" ? null : completedAt, current.id, current.workspaceId);
          return { run: selectRun(db, current.workspaceId, current.id)!, confirmationToken: null };
        }
        if (
          result.value.contacts.length > remaining ||
          (result.value.hasMore && (!result.value.nextCursor || result.value.nextCursor === current.providerCursor))
        ) {
          return { run: terminalImportFailure(db, current, "IMPORT_DUPLICATE_CURSOR", startedAt), confirmationToken: null };
        }
        insertPreviewPage(db, current, snapshot, result.value.contacts);
        const completedAt = nowIso();
        const attemptCount = recordAttempt(db, current, {
          cursorBefore: current.providerCursor,
          cursorAfter: result.value.nextCursor,
          providerAttempts: result.attempts,
          pageItems: result.value.contacts.length,
          outcome: "SUCCEEDED",
          retry: "NONE",
          errorCode: null,
          startedAt,
          completedAt,
        });
        db.prepare(
          `UPDATE connector_runs SET provider_cursor = ?, page_count = page_count + 1,
             item_count = item_count + ?, attempt_count = ?, state = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
        ).run(
          result.value.nextCursor,
          result.value.contacts.length,
          attemptCount,
          "RUNNING",
          completedAt,
          current.id,
          current.workspaceId,
        );
        const persistedRun = selectRun(db, current.workspaceId, current.id)!;
        if (!result.value.hasMore) {
          const finalized = finalizePreview(db, persistedRun);
          return { run: finalized.run, confirmationToken: finalized.token };
        }
        return { run: persistedRun, confirmationToken: null };
      });
      if (!persisted.owned) {
        run = persisted.run;
        return { run: runSummary(run), rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)), confirmationToken: null, replayed: true };
      }
      run = persisted.value.run;
      if (persisted.value.confirmationToken) {
        return {
          run: runSummary(run),
          rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)),
          confirmationToken: persisted.value.confirmationToken,
          replayed: begun.replayed,
        };
      }
      if (run.state !== "RUNNING") {
        return { run: runSummary(run), rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)), confirmationToken: null, replayed: begun.replayed };
      }
    } catch {
      const failed = withOwnedRunTransition(
        db,
        run,
        (current) => terminalImportFailure(db, current, "IMPORT_PERSISTENCE_FAILED", startedAt),
      );
      run = failed.owned ? failed.value : failed.run;
      return { run: runSummary(run), rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)), confirmationToken: null, replayed: begun.replayed };
    }
  }
}

export function issueConnectorImportConfirmation(
  db: Db,
  session: SessionInfo,
  workspaceSlug: string,
  runId: string,
): string {
  requireConnectorAccess(db, session, workspaceSlug);
  return withTransaction(db, () => {
    const run = selectRun(db, session.workspaceId, runId);
    if (!run || run.operation !== "IMPORT") throw new ConnectorOrchestrationError("CONNECTOR_RUN_NOT_FOUND");
    if (run.state !== "PREVIEW_READY" || run.createdByAccountId !== session.accountId) {
      throw new ConnectorOrchestrationError("CONNECTOR_RUN_STATE_INVALID");
    }
    assertConnectorExecutionSnapshotCurrent(db, session, workspaceSlug, connectionBinding(run));
    const token = randomToken();
    const at = nowIso();
    const expiresAt = new Date(Date.parse(at) + CONNECTOR_CONFIRMATION_TTL_MS).toISOString();
    db.prepare(
      `UPDATE connector_runs SET confirmation_token_hash = ?, confirmation_expires_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND state = 'PREVIEW_READY'`,
    ).run(sha256Hex(token), expiresAt, at, run.id, run.workspaceId);
    return token;
  });
}

function confirmationMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256Hex(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  try {
    return actual.length === expected.length && actual.length === 32 && timingSafeEqual(actual, expected);
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
}

function latestSource(
  db: Db,
  workspaceId: string,
  provider: ConnectorProviderId,
  connectionId: string,
  providerRecordId: string,
): { readonly id: string; readonly version: number; readonly payloadJson: string } | null {
  return (db.prepare(
    `SELECT id, version, payload_json AS payloadJson FROM source_records
     WHERE workspace_id = ? AND provider = ? AND source_ref = ?
     ORDER BY version DESC LIMIT 1`,
  ).get(
    workspaceId,
    `connector.${provider}`,
    `${connectionId}:${providerRecordId}`,
  ) as
    | { readonly id: string; readonly version: number; readonly payloadJson: string }
    | undefined) ?? null;
}

function sourceEvidenceVersionKey(evidenceJson: string): string | null {
  try {
    const evidence = JSON.parse(evidenceJson) as unknown;
    if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) return null;
    const value = evidence as Record<string, unknown>;
    if (
      value.schema !== "connector-contact-evidence/v1" ||
      typeof value.connectionVersion !== "number" || !Number.isSafeInteger(value.connectionVersion) ||
      typeof value.configFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(value.configFingerprint) ||
      typeof value.localPayloadFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(value.localPayloadFingerprint)
    ) return null;
    return canonicalJson({
      connectionVersion: value.connectionVersion,
      configFingerprint: value.configFingerprint,
      localPayloadFingerprint: value.localPayloadFingerprint,
    });
  } catch {
    return null;
  }
}

export function confirmConnectorImport(
  db: Db,
  session: SessionInfo,
  workspaceSlug: string,
  runId: string,
  token: string | undefined,
): ConnectorConfirmationResult {
  requireConnectorAccess(db, session, workspaceSlug);
  if (typeof token !== "string" || token.length !== 64) {
    throw new ConnectorOrchestrationError("CONNECTOR_CONFIRMATION_INVALID");
  }
  return withTransaction(db, () => {
    const run = selectRun(db, session.workspaceId, runId);
    if (!run || run.operation !== "IMPORT") throw new ConnectorOrchestrationError("CONNECTOR_RUN_NOT_FOUND");
    if (run.state !== "PREVIEW_READY" || run.confirmedAt !== null) {
      throw new ConnectorOrchestrationError("CONNECTOR_CONFIRMATION_REPLAYED");
    }
    if (run.createdByAccountId !== session.accountId || !run.confirmationTokenHash || !run.confirmationExpiresAt) {
      throw new ConnectorOrchestrationError("CONNECTOR_CONFIRMATION_INVALID");
    }
    if (run.confirmationExpiresAt <= nowIso()) throw new ConnectorOrchestrationError("CONNECTOR_CONFIRMATION_EXPIRED");
    if (!confirmationMatches(token, run.confirmationTokenHash)) {
      throw new ConnectorOrchestrationError("CONNECTOR_CONFIRMATION_INVALID");
    }
    assertConnectorExecutionSnapshotCurrent(db, session, workspaceSlug, connectionBinding(run));

    const rows = previewRows(db, run.workspaceId, run.id);
    let created = 0;
    let linked = 0;
    let updated = 0;
    let conflicts = 0;
    const appliedAt = nowIso();
    for (const row of rows) {
      if (row.disposition === "CONFLICT") {
        conflicts += 1;
        continue;
      }
      if (!row.normalizedEmail || !row.fullName) throw new ConnectorOrchestrationError("CONNECTOR_CANONICAL_CONFLICT");
      let personId = row.candidatePersonId;
      let previousProjection: Readonly<Record<string, unknown>> | null = null;
      let projectionDecisionKind: "CREATE_FROM_SOURCE" | "UPDATE_FROM_SOURCE" | null = null;
      const emailOwner = personByEmail(db, run.workspaceId, row.normalizedEmail);
      if (row.disposition === "CREATE") {
        if (personId !== null || emailOwner) throw new ConnectorOrchestrationError("CONNECTOR_CANONICAL_CONFLICT");
        personId = uuid();
        db.prepare(
          `INSERT INTO people
             (id, workspace_id, canonical_email, full_name, organization, title, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(personId, run.workspaceId, row.normalizedEmail, row.fullName, row.organization, row.title, appliedAt);
        projectionDecisionKind = "CREATE_FROM_SOURCE";
        created += 1;
      } else {
        if (!personId || (emailOwner && emailOwner.id !== personId)) {
          throw new ConnectorOrchestrationError("CONNECTOR_CANONICAL_CONFLICT");
        }
        const candidate = personById(db, run.workspaceId, personId);
        if (
          !candidate || !row.candidatePersonFingerprint ||
          personPreviewFingerprint(candidate) !== row.candidatePersonFingerprint
        ) throw new ConnectorOrchestrationError("CONNECTOR_CANONICAL_CONFLICT");
        if (row.disposition === "UPDATE") {
          previousProjection = personProjection(candidate);
          db.prepare(
            `UPDATE people SET canonical_email = ?, full_name = ?,
               organization = COALESCE(?, organization), title = COALESCE(?, title)
             WHERE workspace_id = ? AND id = ?`,
          ).run(row.normalizedEmail, row.fullName, row.organization, row.title, run.workspaceId, personId);
          projectionDecisionKind = "UPDATE_FROM_SOURCE";
          updated += 1;
        } else {
          linked += 1;
        }
      }

      const latest = latestSource(
        db,
        run.workspaceId,
        run.provider,
        run.connectionId,
        row.providerRecordId,
      );
      let sourceRecordId = latest?.id ?? "";
      if (
        !latest ||
        sourceEvidenceVersionKey(latest.payloadJson) !== sourceEvidenceVersionKey(row.evidenceJson)
      ) {
        const version = (latest?.version ?? 0) + 1;
        sourceRecordId = deterministicUuid(
          `connector-source:${run.workspaceId}:${run.connectionId}:${row.providerRecordId}:${version}:${row.evidenceFingerprint}`,
        );
        db.prepare(
          `INSERT INTO source_records
             (id, workspace_id, provider, source_ref, version, payload_json, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sourceRecordId,
          run.workspaceId,
          `connector.${run.provider}`,
          `${run.connectionId}:${row.providerRecordId}`,
          version,
          row.evidenceJson,
          appliedAt,
        );
      }
      const existingLink = db.prepare(
        "SELECT person_id AS personId FROM source_links WHERE workspace_id = ? AND source_record_id = ?",
      ).get(run.workspaceId, sourceRecordId) as { readonly personId: string } | undefined;
      if (existingLink && existingLink.personId !== personId) {
        throw new ConnectorOrchestrationError("CONNECTOR_CANONICAL_CONFLICT");
      }
      if (!existingLink) {
        db.prepare(
          `INSERT INTO source_links
             (id, workspace_id, person_id, source_record_id, link_decision, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          deterministicUuid(`connector-source-link:${run.workspaceId}:${sourceRecordId}:${personId}`),
          run.workspaceId,
          personId,
          sourceRecordId,
          row.disposition === "CREATE" ? "connector-created" : row.disposition === "LINK" ? "connector-normalized-email" : "connector-confirmed-update",
          appliedAt,
        );
      }
      db.prepare(
        `UPDATE connector_import_preview_rows SET applied_source_record_id = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND run_id = ?`,
      ).run(sourceRecordId, appliedAt, row.id, run.workspaceId, run.id);
      if (projectionDecisionKind !== null) {
        const nextPerson = personById(db, run.workspaceId, personId);
        if (!nextPerson) throw new ConnectorOrchestrationError("CONNECTOR_CANONICAL_CONFLICT");
        const nextProjection = personProjection(nextPerson);
        const previousProjectionJson = previousProjection === null ? null : canonicalJson(previousProjection);
        const previousProjectionFingerprint = previousProjection === null ? null : fingerprintOf(previousProjection);
        db.prepare(
          `INSERT INTO person_projection_decisions
             (id, workspace_id, person_id, source_record_id, import_run_id, preview_row_id,
              decision_kind, previous_projection_json, previous_projection_fingerprint,
              next_projection_json, next_projection_fingerprint, decision_method,
              confirmed_by_account_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXPLICIT_ORGANIZER_CONFIRMATION', ?, ?)`,
        ).run(
          deterministicUuid(`connector-person-projection-decision:${run.id}:${row.id}`),
          run.workspaceId,
          personId,
          sourceRecordId,
          run.id,
          row.id,
          projectionDecisionKind,
          previousProjectionJson,
          previousProjectionFingerprint,
          canonicalJson(nextProjection),
          fingerprintOf(nextProjection),
          session.accountId,
          appliedAt,
        );
      }
    }
    db.prepare(
      `UPDATE connector_runs SET state = 'SUCCEEDED', confirmation_token_hash = NULL,
         confirmation_expires_at = NULL, confirmed_at = ?, confirmed_by_account_id = ?,
         retry_classification = 'NONE', error_code = NULL, updated_at = ?, completed_at = ?
       WHERE id = ? AND workspace_id = ? AND state = 'PREVIEW_READY'`,
    ).run(appliedAt, session.accountId, appliedAt, appliedAt, run.id, run.workspaceId);
    db.prepare(
      `INSERT INTO audit_events
         (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, 'account', ?, 'connector.import.confirmed', 'connector_run', ?, ?, ?)`,
    ).run(
      deterministicUuid(`connector-import-confirmed:${run.id}`),
      run.workspaceId,
      session.accountId,
      run.id,
      canonicalJson({ schema: "connector-import-confirmation/v1", provider: run.provider, created, linked, updated, conflicts }),
      appliedAt,
    );
    return { run: runSummary(selectRun(db, run.workspaceId, run.id)!), created, linked, updated, conflicts };
  });
}

function latestExportAuthority(
  db: Db,
  workspaceId: string,
  connectionId: string,
  personId: string,
): ExportAuthorityDbRow | null {
  return (db.prepare(
    `SELECT id, workspace_id AS workspaceId, connection_id AS connectionId, provider,
            person_id AS personId, event_id AS eventId, version,
            purpose_evidence_json AS purposeEvidenceJson,
            purpose_evidence_fingerprint AS purposeEvidenceFingerprint,
            retention_evidence_json AS retentionEvidenceJson,
            retention_evidence_fingerprint AS retentionEvidenceFingerprint,
            authority_evidence_json AS authorityEvidenceJson,
            authority_evidence_fingerprint AS authorityEvidenceFingerprint,
            recorded_at AS recordedAt
       FROM connector_export_authority_versions
       WHERE workspace_id = ? AND connection_id = ? AND person_id = ?
       ORDER BY version DESC LIMIT 1`,
  ).get(workspaceId, connectionId, personId) as ExportAuthorityDbRow | undefined) ?? null;
}

function canonicalPeopleForExport(
  db: Db,
  snapshot: ConnectorExecutionSnapshot,
): { readonly candidates: readonly ExportCandidate[]; readonly totalCount: number } {
  const totalCount = (db.prepare(
    "SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?",
  ).get(snapshot.workspaceId) as { readonly count: number }).count;
  const people = db.prepare(
    `SELECT id AS personId, full_name AS fullName, canonical_email AS email, organization, title
     FROM people WHERE workspace_id = ? ORDER BY id LIMIT ?`,
  ).all(snapshot.workspaceId, CONNECTOR_IMPORT_ITEM_LIMIT) as unknown as CanonicalPerson[];
  return {
    candidates: people.map((person) => ({
      person,
      authority: latestExportAuthority(db, snapshot.workspaceId, snapshot.id, person.personId),
    })),
    totalCount,
  };
}

export function connectorExportPurposeActionFamily(
  provider: ConnectorProviderId,
  connectionId: string,
  connectionVersion: number,
): string {
  return `EXTERNAL_PROVIDER_EXPORT:${provider.toUpperCase()}:${sha256Hex(connectionId).slice(0, 32).toUpperCase()}:V${connectionVersion}`;
}

export function connectorExportFactFamilies(
  provider: ConnectorProviderId,
  person: CanonicalPerson,
): readonly string[] {
  const facts = provider === "airtable"
    ? ["PERSON_EMAIL", "PERSON_FULL_NAME", "PERSON_ID", "PERSON_ORGANIZATION", "PERSON_TITLE"]
    : [
        "PERSON_EMAIL",
        "PERSON_FULL_NAME",
        ...(person.organization === null ? [] : ["PERSON_ORGANIZATION"]),
        ...(person.title === null ? [] : ["PERSON_TITLE"]),
      ];
  return Object.freeze([...facts].sort());
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsedCanonicalEvidence(json: string, expectedFingerprint: string): unknown | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return canonicalJson(parsed) === json && fingerprintOf(parsed) === expectedFingerprint ? parsed : null;
  } catch {
    return null;
  }
}

const UNAVAILABLE_FINGERPRINT = "0".repeat(64);
const EVIDENCE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,127}$/u;

function safeEvidenceReference(
  value: unknown,
  idField: "evidenceId" | "purposeId" | "policyId",
  fallback: string,
): { readonly id: string; readonly version: number; readonly fingerprint: string } {
  const record = recordValue(value);
  return record && typeof record[idField] === "string" && EVIDENCE_IDENTIFIER.test(record[idField])
    && typeof record.version === "number" && Number.isSafeInteger(record.version)
    && record.version >= 1 && record.version <= 1_000_000_000
    && typeof record.fingerprint === "string" && /^[a-f0-9]{64}$/u.test(record.fingerprint)
    ? { id: record[idField], version: record.version, fingerprint: record.fingerprint }
    : { id: fallback, version: 1, fingerprint: UNAVAILABLE_FINGERPRINT };
}

function safeAuthorityVector(value: unknown): readonly {
  readonly family: string;
  readonly version: number;
  readonly fingerprint: string;
}[] {
  const vector = recordValue(value)?.vector;
  if (!Array.isArray(vector) || vector.length === 0) {
    return [{ family: "EXTERNAL_PROVIDER_POLICY", version: 1, fingerprint: UNAVAILABLE_FINGERPRINT }];
  }
  const entries = vector.map((entry) => recordValue(entry));
  if (entries.some((entry) => !entry || typeof entry.family !== "string"
    || !/^[A-Z0-9][A-Z0-9_:-]{0,127}$/u.test(entry.family)
    || typeof entry.version !== "number" || !Number.isSafeInteger(entry.version)
    || entry.version < 1 || entry.version > 1_000_000_000
    || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(entry.fingerprint))) {
    return [{ family: "EXTERNAL_PROVIDER_POLICY", version: 1, fingerprint: UNAVAILABLE_FINGERPRINT }];
  }
  return entries.map((entry) => ({
    family: entry!.family as string,
    version: entry!.version as number,
    fingerprint: entry!.fingerprint as string,
  }));
}

function authorityBinding(candidate: ExportCandidate): Readonly<Record<string, unknown>> {
  const authority = candidate.authority;
  return authority ? {
    state: "PRESENT",
    id: authority.id,
    eventId: authority.eventId,
    version: authority.version,
    purposeEvidenceFingerprint: authority.purposeEvidenceFingerprint,
    retentionEvidenceFingerprint: authority.retentionEvidenceFingerprint,
    authorityEvidenceFingerprint: authority.authorityEvidenceFingerprint,
  } : { state: "ABSENT" };
}

function buildExportPurposeDecision(
  session: SessionInfo,
  snapshot: ConnectorExecutionSnapshot,
  run: RunRow,
  candidate: ExportCandidate,
  checkedAt: string,
  matchedIdentity: boolean,
): Readonly<{
  actionFamily: string;
  factFamilies: readonly string[];
  projectionJson: string;
  projectionFingerprint: string;
  preflightInputJson: string;
  preflightInputFingerprint: string;
  preflightResultJson: string;
  preflightResultFingerprint: string;
  state: "READY" | "BLOCKED" | "UNAVAILABLE";
}> {
  const authority = candidate.authority;
  const purposeParsed = authority
    ? parsedCanonicalEvidence(authority.purposeEvidenceJson, authority.purposeEvidenceFingerprint)
    : null;
  const retentionParsed = authority
    ? parsedCanonicalEvidence(authority.retentionEvidenceJson, authority.retentionEvidenceFingerprint)
    : null;
  const authorityParsed = authority
    ? parsedCanonicalEvidence(authority.authorityEvidenceJson, authority.authorityEvidenceFingerprint)
    : null;
  const eventId = authority?.eventId ?? "authority-unavailable";
  const subject = { kind: "PERSON", id: candidate.person.personId } as const;
  const actorBody = {
    evidenceId: `account:${session.accountId}`,
    version: 1,
    workspaceId: snapshot.workspaceId,
    eventId,
    subject,
    actorId: session.accountId,
  };
  const actorEvidence = createActorEvidence({
    ...actorBody,
    fingerprint: fingerprintActorEvidence(actorBody),
  });
  const actionFamily = connectorExportPurposeActionFamily(
    snapshot.provider,
    snapshot.id,
    snapshot.version,
  );
  const factFamilies = connectorExportFactFamilies(snapshot.provider, candidate.person);
  const command = createCommandEnvelope({
    workspaceId: snapshot.workspaceId,
    eventId,
    subject,
    actionFamily,
    factFamilies,
    commandId: `export-command:${sha256Hex(`${run.id}\0${candidate.person.personId}`)}`,
    idempotencyKey: `export-person:${sha256Hex(`${run.id}\0${candidate.person.personId}`)}`,
    actorEvidenceRef: safeEvidenceReference(actorEvidence, "evidenceId", "actor-unavailable"),
    purposeAuthorizationRef: safeEvidenceReference(purposeParsed, "purposeId", "purpose-unavailable"),
    retentionAuthorizationRef: safeEvidenceReference(retentionParsed, "policyId", "retention-unavailable"),
    expectedAuthorityVector: safeAuthorityVector(authorityParsed),
    issuedAt: run.createdAt,
    payloadFingerprint: fingerprintOf({
      schema: "connector-provider-person-projection/v1",
      provider: snapshot.provider,
      connectionId: snapshot.id,
      connectionVersion: snapshot.version,
      person: candidate.person,
    }),
  });
  const commandFingerprint = fingerprintOf(command);
  const idempotencyEvidence = createCommandIdentityEvidence({
    workspaceId: snapshot.workspaceId,
    eventId,
    state: matchedIdentity ? "MATCHED" : "UNSEEN",
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    actorId: session.accountId,
    subject,
    actionFamily: command.actionFamily,
    actorEvidenceRef: command.actorEvidenceRef,
    purposeAuthorizationRef: command.purposeAuthorizationRef,
    retentionAuthorizationRef: command.retentionAuthorizationRef,
    expectedAuthorityVector: command.expectedAuthorityVector,
    payloadFingerprint: command.payloadFingerprint,
    commandFingerprint,
  });
  const unavailable = unavailableEvidence({ reason: "connector-export-authority-not-available" });
  const preflightInput = {
    command,
    now: checkedAt,
    actorEvidence,
    purposeEvidence: purposeParsed ?? unavailable,
    retentionEvidence: retentionParsed ?? unavailable,
    authorityEvidence: authorityParsed ?? unavailable,
    idempotencyEvidence,
  };
  const result = preflightAuthorityPurpose(preflightInput);
  const projectionJson = canonicalJson(candidate.person);
  const preflightInputJson = canonicalJson(preflightInput);
  const preflightResultJson = canonicalJson(result);
  return Object.freeze({
    actionFamily,
    factFamilies,
    projectionJson,
    projectionFingerprint: fingerprintOf(candidate.person),
    preflightInputJson,
    preflightInputFingerprint: fingerprintOf(preflightInput),
    preflightResultJson,
    preflightResultFingerprint: fingerprintOf(result),
    state: result.state,
  });
}

function sameExportCandidateCurrent(
  db: Db,
  snapshot: ConnectorExecutionSnapshot,
  candidate: ExportCandidate,
): boolean {
  const person = db.prepare(
    `SELECT id AS personId, full_name AS fullName, canonical_email AS email, organization, title
     FROM people WHERE workspace_id = ? AND id = ?`,
  ).get(snapshot.workspaceId, candidate.person.personId) as CanonicalPerson | undefined;
  const authority = latestExportAuthority(
    db,
    snapshot.workspaceId,
    snapshot.id,
    candidate.person.personId,
  );
  return Boolean(person)
    && fingerprintOf(person) === fingerprintOf(candidate.person)
    && canonicalJson(authorityBinding({ person: candidate.person, authority }))
      === canonicalJson(authorityBinding(candidate));
}

function persistExportPurposeDecisions(
  db: Db,
  session: SessionInfo,
  snapshot: ConnectorExecutionSnapshot,
  run: RunRow,
  candidates: readonly ExportCandidate[],
  totalCount: number,
  replayed: boolean,
): RunRow {
  return withTransaction(db, () => {
    const current = selectRun(db, run.workspaceId, run.id);
    if (!current) throw new ConnectorOrchestrationError("CONNECTOR_RUN_NOT_FOUND");
    const manifestCandidates = candidates.map((candidate) => ({
      person: candidate.person,
      authority: authorityBinding(candidate),
    }));
    const manifestJson = canonicalJson(manifestCandidates);
    const manifest = db.prepare(
      `SELECT total_person_count AS totalCount, candidate_count AS candidateCount,
              candidates_fingerprint AS candidatesFingerprint
       FROM connector_export_manifests WHERE workspace_id = ? AND run_id = ?`,
    ).get(run.workspaceId, run.id) as {
      readonly totalCount: number;
      readonly candidateCount: number;
      readonly candidatesFingerprint: string;
    } | undefined;
    if (manifest) {
      if (manifest.totalCount !== totalCount || manifest.candidateCount !== candidates.length
        || manifest.candidatesFingerprint !== fingerprintOf(manifestCandidates)) {
        throw new ConnectorOrchestrationError("CONNECTOR_RUN_IDEMPOTENCY_CONFLICT");
      }
    } else {
      if (current.state !== "CREATED") {
        throw new ConnectorOrchestrationError("CONNECTOR_RUN_STATE_INVALID");
      }
      db.prepare(
        `INSERT INTO connector_export_manifests
           (run_id, workspace_id, connection_id, connection_version, provider,
            total_person_count, candidate_count, candidates_json, candidates_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        current.id,
        current.workspaceId,
        snapshot.id,
        snapshot.version,
        snapshot.provider,
        totalCount,
        candidates.length,
        manifestJson,
        fingerprintOf(manifestCandidates),
        nowIso(),
      );
    }
    const existing = db.prepare(
      `SELECT person_id AS personId, authority_version_id AS authorityVersionId,
              projection_fingerprint AS projectionFingerprint, decision_state AS decisionState
       FROM connector_export_decisions WHERE workspace_id = ? AND run_id = ? ORDER BY person_id`,
    ).all(run.workspaceId, run.id) as Array<{
      readonly personId: string;
      readonly authorityVersionId: string | null;
      readonly projectionFingerprint: string;
      readonly decisionState: "READY" | "BLOCKED" | "UNAVAILABLE";
    }>;
    if (existing.length > 0) {
      if (existing.length !== candidates.length || candidates.some((candidate, index) => {
        const decision = existing[index];
        return !decision || decision.personId !== candidate.person.personId
          || decision.authorityVersionId !== (candidate.authority?.id ?? null)
          || decision.projectionFingerprint !== fingerprintOf(candidate.person);
      })) throw new ConnectorOrchestrationError("CONNECTOR_RUN_IDEMPOTENCY_CONFLICT");
      return current;
    }
    if (candidates.length === 0 && current.state !== "CREATED") return current;
    if (current.state !== "CREATED") {
      throw new ConnectorOrchestrationError("CONNECTOR_RUN_STATE_INVALID");
    }
    if (candidates.some((candidate) => !sameExportCandidateCurrent(db, snapshot, candidate))) {
      return terminalImportFailure(db, current, "EXPORT_AUTHORITY_CHANGED", nowIso());
    }
    const checkedAt = nowIso();
    let denied = false;
    for (const candidate of candidates) {
      const decision = buildExportPurposeDecision(
        session,
        snapshot,
        current,
        candidate,
        checkedAt,
        replayed,
      );
      denied ||= decision.state !== "READY";
      db.prepare(
        `INSERT INTO connector_export_decisions
           (id, workspace_id, run_id, connection_id, connection_version, provider, person_id,
            authority_version_id, action_family, projection_json, projection_fingerprint,
            fact_families_json, fact_families_fingerprint, preflight_input_json,
            preflight_input_fingerprint, preflight_result_json, preflight_result_fingerprint,
            decision_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        deterministicUuid(`connector-export-decision:${current.id}:${candidate.person.personId}`),
        current.workspaceId,
        current.id,
        snapshot.id,
        snapshot.version,
        snapshot.provider,
        candidate.person.personId,
        candidate.authority?.id ?? null,
        decision.actionFamily,
        decision.projectionJson,
        decision.projectionFingerprint,
        canonicalJson(decision.factFamilies),
        fingerprintOf(decision.factFamilies),
        decision.preflightInputJson,
        decision.preflightInputFingerprint,
        decision.preflightResultJson,
        decision.preflightResultFingerprint,
        decision.state,
        checkedAt,
      );
    }
    return denied
      ? terminalImportFailure(db, current, "EXPORT_PURPOSE_AUTHORIZATION_DENIED", checkedAt)
      : current;
  });
}

function exportBatchAuthorityIsCurrent(
  db: Db,
  session: SessionInfo,
  snapshot: ConnectorExecutionSnapshot,
  run: RunRow,
  batch: readonly CanonicalPerson[],
): boolean {
  const checkedAt = nowIso();
  return batch.every((person) => {
    const decision = db.prepare(
      `SELECT authority_version_id AS authorityVersionId,
              projection_fingerprint AS projectionFingerprint, decision_state AS decisionState
       FROM connector_export_decisions
       WHERE workspace_id = ? AND run_id = ? AND person_id = ?`,
    ).get(run.workspaceId, run.id, person.personId) as {
      readonly authorityVersionId: string | null;
      readonly projectionFingerprint: string;
      readonly decisionState: string;
    } | undefined;
    const authority = latestExportAuthority(db, run.workspaceId, snapshot.id, person.personId);
    if (!decision || decision.decisionState !== "READY" || !authority
      || decision.authorityVersionId !== authority.id
      || decision.projectionFingerprint !== fingerprintOf(person)) return false;
    const result = buildExportPurposeDecision(
      session,
      snapshot,
      run,
      { person, authority },
      checkedAt,
      true,
    );
    return result.state === "READY";
  });
}

function exportBatchSize(provider: ConnectorProviderId): number {
  if (provider === "airtable") return 10;
  if (provider === "hubspot") return 100;
  return 1;
}

export async function exportCanonicalPeopleToConnector(
  db: Db,
  session: SessionInfo,
  workspaceSlug: string,
  provider: ConnectorProviderId,
  idempotencyKey: string,
  options: ConnectorExecutionRuntime,
): Promise<ConnectorRunSummary> {
  requireConnectorAccess(db, session, workspaceSlug);
  const runtime = requireExecutionRuntime(options, provider);
  const snapshot = loadActiveConnectorExecutionSnapshot(db, session, workspaceSlug, provider);
  const exportInput = canonicalPeopleForExport(db, snapshot);
  const people = exportInput.candidates.map(({ person }) => person);
  const inputFingerprint = fingerprintOf({
    schema: "connector-export/v1",
    provider,
    connectionId: snapshot.id,
    connectionVersion: snapshot.version,
    totalCount: exportInput.totalCount,
    candidates: exportInput.candidates.map((candidate) => ({
      person: candidate.person,
      authority: authorityBinding(candidate),
    })),
  });
  const begun = beginRun(db, session, snapshot, "EXPORT", operationKeyHash(idempotencyKey), inputFingerprint);
  if (exportInput.totalCount > CONNECTOR_IMPORT_ITEM_LIMIT) {
    if (begun.replayed) return runSummary(begun.row);
    const failed = withTransaction(db, () => terminalImportFailure(
      db,
      begun.row,
      "EXPORT_ITEM_LIMIT_EXCEEDED",
      nowIso(),
    ));
    return runSummary(failed);
  }
  const authorized = persistExportPurposeDecisions(
    db,
    session,
    snapshot,
    begun.row,
    exportInput.candidates,
    exportInput.totalCount,
    begun.replayed,
  );
  if (authorized.state === "FAILED_TERMINAL") return runSummary(authorized);
  if (begun.replayed && authorized.state === "SUCCEEDED") return runSummary(authorized);
  if (begun.replayed && !["CREATED", "FAILED_RETRYABLE", "PARTIAL", "RUNNING"].includes(begun.row.state)) {
    throw new ConnectorOrchestrationError("CONNECTOR_RUN_STATE_INVALID");
  }
  const claim = claimRunForExecution(db, authorized);
  let run = claim.run;
  if (!claim.claimed) return runSummary(run);
  const completedPeople = new Set(
    (db.prepare(
      "SELECT person_id AS personId FROM connector_export_receipts WHERE workspace_id = ? AND run_id = ?",
    ).all(run.workspaceId, run.id) as Array<{ readonly personId: string }>).map((row) => row.personId),
  );
  const pending = people.filter((person) => !completedPeople.has(person.personId));
  const adapter = adapterFor(snapshot, runtime);
  const batchSize = exportBatchSize(provider);
  for (let index = 0; index < pending.length; index += batchSize) {
    if (run.attemptCount >= CONNECTOR_RUN_MAX_ATTEMPTS) {
      const exhausted = withOwnedRunTransition(db, run, (current) => markAttemptBudgetExhausted(db, current));
      return runSummary(exhausted.owned ? exhausted.value : exhausted.run);
    }
    const batch = pending.slice(index, index + batchSize);
    const startedAt = nowIso();
    const preflight = withOwnedRunTransition(db, run, (current) => {
      try {
        assertConnectorExecutionSnapshotCurrent(db, session, workspaceSlug, snapshot);
        return exportBatchAuthorityIsCurrent(db, session, snapshot, current, batch)
          ? current
          : terminalImportFailure(db, current, "EXPORT_AUTHORITY_CHANGED", startedAt);
      } catch {
        return markStaleRun(db, current, startedAt);
      }
    });
    run = preflight.owned ? preflight.value : preflight.run;
    if (!preflight.owned || run.state !== "RUNNING") return runSummary(run);
    let result: Awaited<ReturnType<ProviderAdapter["upsertPeople"]>>;
    try {
      result = await adapter.upsertPeople(batch);
    } catch {
      const uncertain = withOwnedRunTransition(
        db,
        run,
        (current) => markUnknownRun(
          db,
          current,
          startedAt,
          0,
          batch.length,
          "ADAPTER_EXECUTION_UNCERTAIN",
        ),
      );
      return runSummary(uncertain.owned ? uncertain.value : uncertain.run);
    }
    try {
      const persisted = withOwnedRunTransition(db, run, (current) => {
        try {
          assertConnectorExecutionSnapshotCurrent(db, session, workspaceSlug, snapshot);
        } catch {
          return markStaleRun(db, current, startedAt);
        }
        if (!result.ok) {
          if (result.attempts > 0 && !EXPLICIT_OUTBOUND_REJECTION_CODES.has(result.failure.code)) {
            return markUnknownRun(
              db,
              current,
              startedAt,
              result.attempts,
              batch.length,
              result.failure.code,
            );
          }
          const completedAt = nowIso();
          const state = failureState(result.failure);
          const retry = retryClassification(result.failure);
          const attemptCount = recordAttempt(db, current, {
            cursorBefore: null,
            cursorAfter: null,
            providerAttempts: result.attempts,
            pageItems: batch.length,
            outcome: attemptOutcomeForFailure(result.failure),
            retry,
            errorCode: result.failure.code,
            startedAt,
            completedAt,
          });
          db.prepare(
            `UPDATE connector_runs SET state = ?, attempt_count = ?, retry_classification = ?,
               error_code = ?, updated_at = ?, completed_at = ? WHERE id = ? AND workspace_id = ?`,
          ).run(state, attemptCount, retry, result.failure.code, completedAt, state === "FAILED_RETRYABLE" ? null : completedAt, current.id, current.workspaceId);
          return selectRun(db, current.workspaceId, current.id)!;
        }
        const uniquePeople = new Set(result.value.records.map((record) => record.personId));
        const uniqueProviderRecords = new Set(result.value.records.map((record) => record.providerRecordId));
        const requestedPeople = new Set(batch.map((person) => person.personId));
        if (
          result.value.requested !== batch.length ||
          result.value.created + result.value.updated !== batch.length ||
          result.value.records.length !== batch.length ||
          uniquePeople.size !== batch.length || uniqueProviderRecords.size !== batch.length ||
          [...uniquePeople].some((personId) => !requestedPeople.has(personId))
        ) {
          return markUnknownRun(
            db,
            current,
            startedAt,
            result.attempts,
            batch.length,
            "EXPORT_RESPONSE_UNCERTAIN",
          );
        }
        const completedAt = nowIso();
        const byPerson = new Map(result.value.records.map((record) => [record.personId, record]));
        for (const person of batch) {
          const record = byPerson.get(person.personId)!;
          db.prepare(
            `INSERT INTO connector_export_receipts
               (id, workspace_id, run_id, person_id, provider_record_id, operation,
                input_fingerprint, output_fingerprint, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            deterministicUuid(`connector-export-receipt:${current.id}:${person.personId}`),
            current.workspaceId,
            current.id,
            person.personId,
            record.providerRecordId,
            record.operation,
            fingerprintOf(person),
            fingerprintOf(record),
            completedAt,
          );
        }
        const attemptCount = recordAttempt(db, current, {
          cursorBefore: null,
          cursorAfter: null,
          providerAttempts: result.attempts,
          pageItems: batch.length,
          outcome: "SUCCEEDED",
          retry: "NONE",
          errorCode: null,
          startedAt,
          completedAt,
        });
        db.prepare(
          `UPDATE connector_runs SET state = 'RUNNING', item_count = item_count + ?,
             attempt_count = ?, retry_classification = 'NONE', error_code = NULL, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
        ).run(batch.length, attemptCount, completedAt, current.id, current.workspaceId);
        return selectRun(db, current.workspaceId, current.id)!;
      });
      run = persisted.owned ? persisted.value : persisted.run;
    } catch {
      const uncertain = withOwnedRunTransition(
        db,
        run,
        (current) => markUnknownRun(
          db,
          current,
          startedAt,
          result.attempts,
          batch.length,
          "EXPORT_RECEIPT_UNCERTAIN",
        ),
      );
      return runSummary(uncertain.owned ? uncertain.value : uncertain.run);
    }
    if (run.state !== "RUNNING") return runSummary(run);
  }
  const finalized = withOwnedRunTransition(db, run, (current) => {
    try {
      assertConnectorExecutionSnapshotCurrent(db, session, workspaceSlug, snapshot);
    } catch {
      return markStaleRun(db, current, nowIso());
    }
    const at = nowIso();
    db.prepare(
      `UPDATE connector_runs SET state = 'SUCCEEDED', retry_classification = 'NONE',
         error_code = NULL, updated_at = ?, completed_at = ? WHERE id = ? AND workspace_id = ?`,
    ).run(at, at, current.id, current.workspaceId);
    return selectRun(db, current.workspaceId, current.id)!;
  });
  return runSummary(finalized.owned ? finalized.value : finalized.run);
}

export function listConnectorRuns(
  db: Db,
  session: SessionInfo,
  workspaceSlug: string,
  limit = 20,
): readonly ConnectorRunSummary[] {
  requireConnectorAccess(db, session, workspaceSlug);
  const boundedLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;
  const rows = db.prepare(
    `SELECT id FROM connector_runs WHERE workspace_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(session.workspaceId, boundedLimit) as Array<{ readonly id: string }>;
  return rows.map((row) => runSummary(selectRun(db, session.workspaceId, row.id)!));
}

export function getConnectorImportPreview(
  db: Db,
  session: SessionInfo,
  workspaceSlug: string,
  runId: string,
): { readonly run: ConnectorRunSummary; readonly rows: readonly ConnectorPreviewRow[] } | null {
  requireConnectorAccess(db, session, workspaceSlug);
  const run = selectRun(db, session.workspaceId, runId);
  if (!run || run.operation !== "IMPORT") return null;
  return { run: runSummary(run), rows: publicPreviewRows(previewRows(db, run.workspaceId, run.id)) };
}
