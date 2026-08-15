import {
  assertWorkspaceMatch,
  requireCapability,
  type SessionInfo,
} from "../../auth";
import {
  canonicalJson,
  deterministicUuid,
  nowIso,
  sha256Hex,
} from "../../canonical";
import { withTransaction, type Db } from "../../db";

import {
  AIRTABLE_CSV_HEADERS,
  AIRTABLE_CSV_LIMITS,
  AIRTABLE_CSV_MAX_CELL_BYTES,
  AIRTABLE_CSV_MAX_ROWS,
  AIRTABLE_CSV_SCHEMA,
  CONNECTOR_HUB_RECEIPT_SCHEMA,
  type AirtableCsvExportResult,
  type AirtableCsvRow,
  type ConnectorActivityEvidence,
  type ConnectorConnectionSummary,
  type ConnectorExportReceipt,
  type ConnectorHubExportFailureCode,
  type ConnectorHubView,
  type ConnectorProviderCard,
} from "./contracts";
import {
  airtableCsvFilename,
  ConnectorHubExportError,
  serializeAirtableCsv,
} from "./csv";
import {
  listConnectorConnectionSummaries,
} from "./connections";

export * from "./contracts";
export {
  airtableCsvFilename,
  ConnectorHubExportError,
  serializeAirtableCsv,
} from "./csv";
export {
  ConnectorConnectionError,
  getConnectorConnectionSummary,
  listConnectorConnectionSummaries,
  normalizeConnectorProviderConfig,
  requireConnectorConnectionsOrganizerAccess,
  revokeConnectorConnection,
  saveConnectorConnection,
} from "./connections";
export type {
  ConnectorConnectionErrorCode,
  SaveConnectorConnectionInput,
} from "./connections";
export {
  CONNECTOR_SECRET_ALGORITHM,
  CONNECTOR_SECRET_KEY_VERSION,
  CONNECTOR_SECRET_MASK,
  CONNECTOR_SECRET_MAX_BYTES,
  CONNECTOR_VAULT_KEY_ENV,
  ConnectorVaultError,
  encryptConnectorSecret,
  isEncryptedConnectorSecret,
} from "./credential-vault";
export type { EncryptedConnectorSecret } from "./credential-vault";
export {
  CONNECTOR_CONFIRMATION_TTL_MS,
  CONNECTOR_EXECUTION_LEASE_MS,
  CONNECTOR_IMPORT_ITEM_LIMIT,
  CONNECTOR_IMPORT_PAGE_LIMIT,
  ConnectorOrchestrationError,
  connectorExportFactFamilies,
  connectorExportPurposeActionFamily,
  confirmConnectorImport,
  createConnectorImportPreview,
  exportCanonicalPeopleToConnector,
  getConnectorImportPreview,
  issueConnectorImportConfirmation,
  listConnectorRuns,
  testConnectorConnection,
} from "./orchestration";
export type {
  ConnectorConfirmationResult,
  ConnectorImportPreviewResult,
  ConnectorOrchestrationErrorCode,
  ConnectorPreviewDisposition,
  ConnectorPreviewRow,
  ConnectorRetryClassification,
  ConnectorRunOperation,
  ConnectorRunState,
  ConnectorRunSummary,
} from "./orchestration";
const EXPORT_SUCCEEDED_ACTION = "connector_hub.airtable_csv.export.succeeded";
const EXPORT_FAILED_ACTION = "connector_hub.airtable_csv.export.failed";
const EVIDENCE_READ_LIMIT = 100;
const EVIDENCE_JSON_MAX_BYTES = 16 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const EXPORT_OPERATION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECORDED_FAILURE_CODES = new Set<ConnectorHubExportFailureCode>([
  "CONNECTOR_EXPORT_ROW_LIMIT",
  "CONNECTOR_EXPORT_BYTE_LIMIT",
  "CONNECTOR_EXPORT_DATA_INVALID",
  "CONNECTOR_WORKSPACE_NOT_FOUND",
]);

interface WorkspaceRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

interface RawExportRow {
  readonly personId: unknown;
  readonly fullName: unknown;
  readonly email: unknown;
  readonly organization: unknown;
  readonly title: unknown;
  readonly eventId: unknown;
  readonly eventName: unknown;
  readonly eventStartsAt: unknown;
  readonly eventTimezone: unknown;
  readonly eventRole: unknown;
  readonly participationStatus: unknown;
}

interface RawEvidenceRow {
  readonly id: unknown;
  readonly action: unknown;
  readonly detailsJson: unknown;
  readonly createdAt: unknown;
}

interface ReceiptDetails {
  readonly schema: typeof CONNECTOR_HUB_RECEIPT_SCHEMA;
  readonly provider: "airtable";
  readonly operation: "CSV_EXPORT";
  readonly outcome: "SUCCEEDED" | "FAILED";
  readonly exportSchema: typeof AIRTABLE_CSV_SCHEMA;
  readonly providerMutation: false;
  readonly operationKeySha256: string;
  readonly rowCount: number | null;
  readonly byteCount: number | null;
  readonly contentSha256: string | null;
  readonly failureCode: ConnectorHubExportFailureCode | null;
  readonly limits: typeof AIRTABLE_CSV_LIMITS;
}

interface ParsedEvidence {
  readonly evidence: ConnectorActivityEvidence;
  readonly operationKeySha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_DATA_INVALID");
  }
  return value;
}

function optionalText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_DATA_INVALID");
  }
  return value;
}

function normalizeExportRow(row: RawExportRow): AirtableCsvRow {
  return {
    personId: requiredText(row.personId),
    fullName: requiredText(row.fullName),
    email: requiredText(row.email),
    organization: optionalText(row.organization),
    title: optionalText(row.title),
    eventId: optionalText(row.eventId),
    eventName: optionalText(row.eventName),
    eventStartsAt: optionalText(row.eventStartsAt),
    eventTimezone: optionalText(row.eventTimezone),
    eventRole: optionalText(row.eventRole),
    participationStatus: optionalText(row.participationStatus),
  };
}

/** Authorization is repeated at the service boundary before every connector read or export. */
export function requireConnectorHubOrganizerAccess(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): void {
  assertWorkspaceMatch(session, requestedWorkspaceSlug);
  requireCapability(db, session, "connectors.manage");
}

function workspaceForSession(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): WorkspaceRow | null {
  const row = db
    .prepare(
      `SELECT id, slug, name
       FROM workspaces
       WHERE id = ? AND slug = ?`,
    )
    .get(session.workspaceId, requestedWorkspaceSlug) as WorkspaceRow | undefined;
  return row ?? null;
}

function countValue(db: Db, sql: string, workspaceId: string): number {
  const row = db.prepare(sql).get(workspaceId) as { readonly count?: unknown } | undefined;
  if (!row || !isSafeCount(row.count)) {
    throw new Error("CONNECTOR_HUB_COUNT_INVALID");
  }
  return row.count;
}

function parseEvidence(row: RawEvidenceRow): ParsedEvidence | null {
  if (
    typeof row.id !== "string" ||
    typeof row.action !== "string" ||
    typeof row.detailsJson !== "string" ||
    typeof row.createdAt !== "string" ||
    Buffer.byteLength(row.detailsJson, "utf8") > EVIDENCE_JSON_MAX_BYTES ||
    Number.isNaN(Date.parse(row.createdAt))
  ) {
    return null;
  }

  try {
    const details = JSON.parse(row.detailsJson) as unknown;
    if (
      !isRecord(details) ||
      !hasExactKeys(details, [
        "schema",
        "provider",
        "operation",
        "outcome",
        "exportSchema",
        "providerMutation",
        "operationKeySha256",
        "rowCount",
        "byteCount",
        "contentSha256",
        "failureCode",
        "limits",
      ]) ||
      details.schema !== CONNECTOR_HUB_RECEIPT_SCHEMA ||
      details.provider !== "airtable" ||
      details.operation !== "CSV_EXPORT" ||
      details.exportSchema !== AIRTABLE_CSV_SCHEMA ||
      details.providerMutation !== false ||
      typeof details.operationKeySha256 !== "string" ||
      !SHA256.test(details.operationKeySha256) ||
      !isRecord(details.limits) ||
      !hasExactKeys(details.limits, ["maxRows", "maxBytes", "maxCellBytes"]) ||
      details.limits.maxRows !== AIRTABLE_CSV_LIMITS.maxRows ||
      details.limits.maxBytes !== AIRTABLE_CSV_LIMITS.maxBytes ||
      details.limits.maxCellBytes !== AIRTABLE_CSV_LIMITS.maxCellBytes ||
      (details.outcome !== "SUCCEEDED" && details.outcome !== "FAILED") ||
      (row.action === EXPORT_SUCCEEDED_ACTION) !== (details.outcome === "SUCCEEDED") ||
      (row.action === EXPORT_FAILED_ACTION) !== (details.outcome === "FAILED")
    ) {
      return null;
    }

    if (details.outcome === "SUCCEEDED") {
      if (
        !isSafeCount(details.rowCount) ||
        details.rowCount > AIRTABLE_CSV_LIMITS.maxRows ||
        !isSafeCount(details.byteCount) ||
        details.byteCount > AIRTABLE_CSV_LIMITS.maxBytes ||
        typeof details.contentSha256 !== "string" ||
        !SHA256.test(details.contentSha256) ||
        details.failureCode !== null
      ) {
        return null;
      }
      return {
        operationKeySha256: details.operationKeySha256,
        evidence: {
          receiptId: row.id,
          outcome: "SUCCEEDED",
          occurredAt: row.createdAt,
          providerMutation: false,
          exportSchema: AIRTABLE_CSV_SCHEMA,
          rowCount: details.rowCount,
          byteCount: details.byteCount,
          contentSha256: details.contentSha256,
          failureCode: null,
        },
      };
    }

    if (
      details.rowCount !== null ||
      details.byteCount !== null ||
      details.contentSha256 !== null ||
      typeof details.failureCode !== "string" ||
      !RECORDED_FAILURE_CODES.has(details.failureCode as ConnectorHubExportFailureCode)
    ) {
      return null;
    }
    return {
      operationKeySha256: details.operationKeySha256,
      evidence: {
        receiptId: row.id,
        outcome: "FAILED",
        occurredAt: row.createdAt,
        providerMutation: false,
        exportSchema: AIRTABLE_CSV_SCHEMA,
        rowCount: null,
        byteCount: null,
        contentSha256: null,
        failureCode: details.failureCode as ConnectorHubExportFailureCode,
      },
    };
  } catch {
    return null;
  }
}

function airtableEvidence(db: Db, workspaceId: string): {
  readonly lastRun: ConnectorActivityEvidence | null;
  readonly lastFailure: ConnectorActivityEvidence | null;
  readonly evidenceWarning: boolean;
} {
  const rows = db
    .prepare(
      `SELECT id, action, details_json AS detailsJson, created_at AS createdAt
       FROM audit_events
       WHERE workspace_id = ?
         AND action IN (?, ?)
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(
      workspaceId,
      EXPORT_SUCCEEDED_ACTION,
      EXPORT_FAILED_ACTION,
      EVIDENCE_READ_LIMIT,
    ) as unknown as RawEvidenceRow[];

  let lastRun: ConnectorActivityEvidence | null = null;
  let lastFailure: ConnectorActivityEvidence | null = null;
  let evidenceWarning = false;
  for (const row of rows) {
    const parsed = parseEvidence(row);
    if (!parsed) {
      evidenceWarning = true;
      continue;
    }
    const evidence = parsed.evidence;
    if (evidence.outcome === "SUCCEEDED" && lastRun === null) lastRun = evidence;
    if (evidence.outcome === "FAILED" && lastFailure === null) lastFailure = evidence;
    if (lastRun && lastFailure) break;
  }
  return { lastRun, lastFailure, evidenceWarning };
}

function connectionStatus(connection: ConnectorConnectionSummary | undefined): ConnectorProviderCard["connectionStatus"] {
  return connection?.status ?? "NOT_CONFIGURED";
}

function connectionDetail(
  provider: "Airtable" | "HubSpot" | "Salesforce",
  connection: ConnectorConnectionSummary | undefined,
  notConfigured: string,
): string {
  if (!connection) return notConfigured;
  if (connection.status === "REVOKED") {
    return `${provider} connection revoked. Save a new secret before any provider operation is enabled.`;
  }
  return `${provider} connection is stored with an encrypted secret and validated non-secret configuration. Decryption occurs only inside a bounded server execution.`;
}

function providerCards(
  evidence: ReturnType<typeof airtableEvidence>,
  connections: readonly ConnectorConnectionSummary[],
): readonly ConnectorProviderCard[] {
  const byProvider = new Map(connections.map((connection) => [connection.provider, connection]));
  const hubspot = byProvider.get("hubspot");
  const salesforce = byProvider.get("salesforce");
  const airtable = byProvider.get("airtable");
  return [
    {
      id: "hubspot",
      name: "HubSpot",
      connectionStatus: connectionStatus(hubspot),
      connectionDetail: connectionDetail(
        "HubSpot",
        hubspot,
        "No supported HubSpot credential, adapter, or workspace connection is configured.",
      ),
      connection: hubspot ?? null,
      capabilities: [
        {
          label: "Preview/import through HubSpot adapter",
          state: "DISABLED",
          detail: hubspot?.status === "ACTIVE"
            ? "Implemented; the server resolves the permitted transport separately from explicit execution configuration."
            : "Save an active connection before the server can authorize any configured execution transport.",
        },
        {
          label: "Bounded identity upsert to HubSpot",
          state: "DISABLED",
          detail: "Durable receipts and unknown-outcome handling are implemented; an active connection and explicit server transport are both required.",
        },
      ],
      fieldMappings: [],
      mappingDetail: "No HubSpot field mapping has been configured or inferred.",
      setupRequirements: [
        "Purpose and recipient-scope authorization for any real provider sharing",
        "Reviewed live transport enablement with real-provider contract verification",
        "Explicit canonical Person-to-HubSpot mapping remains server controlled",
      ],
      activityLabel: "Provider run",
      lastRun: null,
      lastFailure: null,
      evidenceWarning: false,
    },
    {
      id: "salesforce",
      name: "Salesforce",
      connectionStatus: connectionStatus(salesforce),
      connectionDetail: connectionDetail(
        "Salesforce",
        salesforce,
        "No supported Salesforce credential, adapter, or workspace connection is configured.",
      ),
      connection: salesforce ?? null,
      capabilities: [
        {
          label: "Preview/import through Salesforce adapter",
          state: "DISABLED",
          detail: salesforce?.status === "ACTIVE"
            ? "Implemented; the server resolves the permitted transport separately from explicit execution configuration."
            : "Save an active connection before the server can authorize any configured execution transport.",
        },
        {
          label: "Write or sync to Salesforce",
          state: "DISABLED",
          detail: "Create ambiguity ends UNKNOWN and is never blindly replayed; execution also requires an explicit server transport.",
        },
      ],
      fieldMappings: [],
      mappingDetail: "No Salesforce object or field mapping has been configured or inferred.",
      setupRequirements: [
        "Purpose and recipient-scope authorization for any real provider sharing",
        "Reviewed live transport enablement with real-provider contract verification",
        "Explicit Contact selection and canonical Person mapping remains server controlled",
      ],
      activityLabel: "Provider run",
      lastRun: null,
      lastFailure: null,
      evidenceWarning: false,
    },
    {
      id: "airtable",
      name: "Airtable",
      connectionStatus: connectionStatus(airtable),
      connectionDetail: connectionDetail(
        "Airtable",
        airtable,
        "No Airtable API credential or base connection is configured. Local CSV export is available without one.",
      ),
      connection: airtable ?? null,
      capabilities: [
        {
          label: "Airtable-compatible CSV",
          state: "AVAILABLE",
          detail: "Authenticated local download from canonical People and current event involvement.",
        },
        {
          label: "Airtable API mutation",
          state: "DISABLED",
          detail: "Adapter upsert receipts are implemented; execution requires an active connection and explicit server transport.",
        },
      ],
      fieldMappings: [
        { source: "people.id", destination: "person_id", detail: "Stable canonical Person identifier" },
        { source: "people.full_name", destination: "full_name", detail: "Canonical display name" },
        { source: "people.canonical_email", destination: "email", detail: "Canonical workspace email" },
        { source: "people.organization", destination: "organization", detail: "Blank when absent" },
        { source: "people.title", destination: "title", detail: "Blank when absent" },
        { source: "events.id", destination: "event_id", detail: "Blank when the Person has no event involvement" },
        { source: "events.name", destination: "event_name", detail: "Current event name" },
        { source: "events.starts_at", destination: "event_starts_at", detail: "Stored event start timestamp" },
        { source: "events.timezone", destination: "event_timezone", detail: "Stored IANA event timezone" },
        { source: "event_speakers.role_key", destination: "event_role", detail: "Current event-role involvement" },
        { source: "event_speakers.participation_status", destination: "participation_status", detail: "Current involvement status" },
      ],
      mappingDetail: `Stable ordered headers for ${AIRTABLE_CSV_SCHEMA}.`,
      setupRequirements: [
        "None for CSV download and manual Airtable import",
        "Purpose/recipient authorization and reviewed live transport are required for any real API mutation",
      ],
      activityLabel: "Local CSV export",
      lastRun: evidence.lastRun,
      lastFailure: evidence.lastFailure,
      evidenceWarning: evidence.evidenceWarning,
    },
  ];
}

/** Read the truthful, credential-free Connector Hub projection for one authorized workspace. */
export function getConnectorHubView(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): ConnectorHubView | null {
  requireConnectorHubOrganizerAccess(db, session, requestedWorkspaceSlug);
  const workspace = workspaceForSession(db, session, requestedWorkspaceSlug);
  if (!workspace) return null;

  const peopleCount = countValue(
    db,
    "SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?",
    session.workspaceId,
  );
  const eventInvolvementCount = countValue(
    db,
    `SELECT COUNT(*) AS count
     FROM event_speakers involvement
     JOIN people person_row ON person_row.id = involvement.person_id
       AND person_row.workspace_id = involvement.workspace_id
     JOIN events event_row ON event_row.id = involvement.event_id
       AND event_row.workspace_id = involvement.workspace_id
     WHERE involvement.workspace_id = ?`,
    session.workspaceId,
  );
  const exportRowCount = countValue(
    db,
    `SELECT COUNT(*) AS count
     FROM people person_row
     LEFT JOIN event_speakers involvement
       ON involvement.workspace_id = person_row.workspace_id
      AND involvement.person_id = person_row.id
     WHERE person_row.workspace_id = ?`,
    session.workspaceId,
  );
  const evidence = airtableEvidence(db, session.workspaceId);
  const connections = listConnectorConnectionSummaries(db, session, requestedWorkspaceSlug);

  return {
    workspace,
    peopleCount,
    eventInvolvementCount,
    exportRowCount,
    providers: providerCards(evidence, connections),
  };
}

function assertStoredCellsBounded(db: Db, workspaceId: string): void {
  const oversizedPerson = db
    .prepare(
      `SELECT 1
       FROM people
       WHERE workspace_id = ?
         AND (
           length(CAST(id AS BLOB)) > ?
           OR length(CAST(canonical_email AS BLOB)) > ?
           OR length(CAST(full_name AS BLOB)) > ?
           OR length(CAST(COALESCE(organization, '') AS BLOB)) > ?
           OR length(CAST(COALESCE(title, '') AS BLOB)) > ?
         )
       LIMIT 1`,
    )
    .get(
      workspaceId,
      AIRTABLE_CSV_MAX_CELL_BYTES,
      AIRTABLE_CSV_MAX_CELL_BYTES,
      AIRTABLE_CSV_MAX_CELL_BYTES,
      AIRTABLE_CSV_MAX_CELL_BYTES,
      AIRTABLE_CSV_MAX_CELL_BYTES,
    );
  const oversizedEvent = db
    .prepare(
      `SELECT 1
       FROM events event_row
       JOIN event_speakers involvement
         ON involvement.workspace_id = event_row.workspace_id
        AND involvement.event_id = event_row.id
       WHERE event_row.workspace_id = ?
         AND (
           length(CAST(event_row.id AS BLOB)) > ?
           OR length(CAST(event_row.name AS BLOB)) > ?
           OR length(CAST(event_row.starts_at AS BLOB)) > ?
           OR length(CAST(event_row.timezone AS BLOB)) > ?
           OR length(CAST(involvement.role_key AS BLOB)) > ?
           OR length(CAST(involvement.participation_status AS BLOB)) > ?
         )
       LIMIT 1`,
    )
    .get(
      workspaceId,
      AIRTABLE_CSV_MAX_CELL_BYTES,
      AIRTABLE_CSV_MAX_CELL_BYTES,
      AIRTABLE_CSV_MAX_CELL_BYTES,
      AIRTABLE_CSV_MAX_CELL_BYTES,
      AIRTABLE_CSV_MAX_CELL_BYTES,
      AIRTABLE_CSV_MAX_CELL_BYTES,
    );
  if (oversizedPerson || oversizedEvent) {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_DATA_INVALID");
  }
}

function exportRows(db: Db, workspaceId: string): readonly AirtableCsvRow[] {
  assertStoredCellsBounded(db, workspaceId);
  const rows = db
    .prepare(
      `SELECT person_row.id AS personId,
              person_row.full_name AS fullName,
              person_row.canonical_email AS email,
              person_row.organization,
              person_row.title,
              event_row.id AS eventId,
              event_row.name AS eventName,
              event_row.starts_at AS eventStartsAt,
              event_row.timezone AS eventTimezone,
              involvement.role_key AS eventRole,
              involvement.participation_status AS participationStatus
       FROM people person_row
       LEFT JOIN event_speakers involvement
         ON involvement.workspace_id = person_row.workspace_id
        AND involvement.person_id = person_row.id
       LEFT JOIN events event_row
         ON event_row.workspace_id = involvement.workspace_id
        AND event_row.id = involvement.event_id
       WHERE person_row.workspace_id = ?
       ORDER BY person_row.full_name COLLATE BINARY,
                person_row.id COLLATE BINARY,
                COALESCE(event_row.starts_at, '') COLLATE BINARY,
                COALESCE(event_row.id, '') COLLATE BINARY,
                COALESCE(involvement.role_key, '') COLLATE BINARY,
                COALESCE(involvement.id, '') COLLATE BINARY
       LIMIT ?`,
    )
    .all(workspaceId, AIRTABLE_CSV_MAX_ROWS + 1) as unknown as RawExportRow[];
  return rows.map(normalizeExportRow);
}

function insertReceipt(
  db: Db,
  session: SessionInfo,
  receiptId: string,
  operationKeySha256: string,
  outcome: "SUCCEEDED" | "FAILED",
  values: {
    readonly rowCount: number | null;
    readonly byteCount: number | null;
    readonly contentSha256: string | null;
    readonly failureCode: ConnectorHubExportFailureCode | null;
  },
): ConnectorActivityEvidence {
  const occurredAt = nowIso();
  const details: ReceiptDetails = {
    schema: CONNECTOR_HUB_RECEIPT_SCHEMA,
    provider: "airtable",
    operation: "CSV_EXPORT",
    outcome,
    exportSchema: AIRTABLE_CSV_SCHEMA,
    providerMutation: false,
    operationKeySha256,
    rowCount: values.rowCount,
    byteCount: values.byteCount,
    contentSha256: values.contentSha256,
    failureCode: values.failureCode,
    limits: AIRTABLE_CSV_LIMITS,
  };
  db.prepare(
    `INSERT INTO audit_events
     (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, 'account', ?, ?, 'connector', 'airtable-csv', ?, ?)`,
  ).run(
    receiptId,
    session.workspaceId,
    session.accountId,
    outcome === "SUCCEEDED" ? EXPORT_SUCCEEDED_ACTION : EXPORT_FAILED_ACTION,
    canonicalJson(details),
    occurredAt,
  );
  return {
    receiptId,
    outcome,
    occurredAt,
    providerMutation: false,
    exportSchema: AIRTABLE_CSV_SCHEMA,
    rowCount: values.rowCount,
    byteCount: values.byteCount,
    contentSha256: values.contentSha256,
    failureCode: values.failureCode,
  };
}

function priorOperationEvidence(
  db: Db,
  workspaceId: string,
  receiptId: string,
  operationKeySha256: string,
): ConnectorActivityEvidence | null {
  const row = db.prepare(
    `SELECT id, action, details_json AS detailsJson, created_at AS createdAt
     FROM audit_events
     WHERE id = ? AND workspace_id = ?
       AND action IN (?, ?)
     LIMIT 1`,
  ).get(
    receiptId,
    workspaceId,
    EXPORT_SUCCEEDED_ACTION,
    EXPORT_FAILED_ACTION,
  ) as RawEvidenceRow | undefined;
  if (!row) return null;
  const parsed = parseEvidence(row);
  if (!parsed || parsed.operationKeySha256 !== operationKeySha256) {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_OPERATION_CONFLICT");
  }
  return parsed.evidence;
}

type ExportTransactionOutcome =
  | { readonly ok: true; readonly result: AirtableCsvExportResult }
  | {
      readonly ok: false;
      readonly code: ConnectorHubExportFailureCode;
      readonly receipt: ConnectorActivityEvidence;
    };

/**
 * Create an authenticated local CSV and append a local receipt in the same workspace transaction.
 * No provider client, credential, network call, or provider mutation exists in this path.
 */
export function exportAirtablePeopleCsv(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
  operationKey: string,
): AirtableCsvExportResult {
  requireConnectorHubOrganizerAccess(db, session, requestedWorkspaceSlug);
  if (!EXPORT_OPERATION_KEY.test(operationKey)) {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_OPERATION_INVALID");
  }
  const operationKeySha256 = sha256Hex(operationKey);
  const receiptId = deterministicUuid(
    `connector-hub:airtable-csv:${session.workspaceId}:${session.accountId}:${operationKeySha256}`,
  );
  const outcome = withTransaction<ExportTransactionOutcome>(db, () => {
    const workspace = workspaceForSession(db, session, requestedWorkspaceSlug);
    if (!workspace) {
      throw new ConnectorHubExportError("CONNECTOR_WORKSPACE_NOT_FOUND");
    }
    const prior = priorOperationEvidence(
      db,
      session.workspaceId,
      receiptId,
      operationKeySha256,
    );
    if (prior?.outcome === "FAILED") {
      return {
        ok: false,
        code: prior.failureCode ?? "CONNECTOR_EXPORT_OPERATION_CONFLICT",
        receipt: prior,
      };
    }

    if (prior?.outcome === "SUCCEEDED") {
      let serialized: ReturnType<typeof serializeAirtableCsv>;
      try {
        serialized = serializeAirtableCsv(exportRows(db, session.workspaceId));
      } catch (error) {
        if (error instanceof ConnectorHubExportError) {
          throw new ConnectorHubExportError("CONNECTOR_EXPORT_OPERATION_CONFLICT");
        }
        throw error;
      }
      const contentSha256 = sha256Hex(serialized.body);
      if (
        prior.rowCount !== serialized.rowCount ||
        prior.byteCount !== serialized.byteCount ||
        prior.contentSha256 !== contentSha256
      ) {
        throw new ConnectorHubExportError("CONNECTOR_EXPORT_OPERATION_CONFLICT");
      }
      const receipt: ConnectorExportReceipt = {
        ...prior,
        outcome: "SUCCEEDED",
        rowCount: serialized.rowCount,
        byteCount: serialized.byteCount,
        contentSha256,
        failureCode: null,
      };
      return {
        ok: true,
        result: {
          schema: AIRTABLE_CSV_SCHEMA,
          fileName: airtableCsvFilename(workspace.slug),
          contentType: "text/csv; charset=utf-8",
          body: serialized.body,
          rowCount: serialized.rowCount,
          byteCount: serialized.byteCount,
          receipt,
          receiptReplayed: true,
        },
      };
    }

    try {
      const serialized = serializeAirtableCsv(exportRows(db, session.workspaceId));
      const contentSha256 = sha256Hex(serialized.body);
      const activity = insertReceipt(
        db,
        session,
        receiptId,
        operationKeySha256,
        "SUCCEEDED",
        {
          rowCount: serialized.rowCount,
          byteCount: serialized.byteCount,
          contentSha256,
          failureCode: null,
        },
      );
      const receipt: ConnectorExportReceipt = {
        ...activity,
        outcome: "SUCCEEDED",
        rowCount: serialized.rowCount,
        byteCount: serialized.byteCount,
        contentSha256,
        failureCode: null,
      };
      return {
        ok: true,
        result: {
          schema: AIRTABLE_CSV_SCHEMA,
          fileName: airtableCsvFilename(workspace.slug),
          contentType: "text/csv; charset=utf-8",
          body: serialized.body,
          rowCount: serialized.rowCount,
          byteCount: serialized.byteCount,
          receipt,
          receiptReplayed: false,
        },
      };
    } catch (error) {
      if (!(error instanceof ConnectorHubExportError)) throw error;
      const receipt = insertReceipt(
        db,
        session,
        receiptId,
        operationKeySha256,
        "FAILED",
        {
          rowCount: null,
          byteCount: null,
          contentSha256: null,
          failureCode: error.code,
        },
      );
      return { ok: false, code: error.code, receipt };
    }
  });

  if (!outcome.ok) {
    throw new ConnectorHubExportError(outcome.code, outcome.receipt);
  }
  return outcome.result;
}

export { AIRTABLE_CSV_HEADERS };
