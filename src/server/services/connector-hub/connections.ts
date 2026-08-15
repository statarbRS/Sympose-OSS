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
} from "../../canonical";
import { withTransaction, type Db } from "../../db";
import {
  CONNECTOR_CONNECTION_CONFIG_MAX_BYTES,
  CONNECTOR_CONNECTION_SCHEMA,
} from "../../schema";
import {
  assertConnectorVaultConfigured,
  CONNECTOR_SECRET_MASK,
  decryptConnectorSecret,
  encryptConnectorSecret,
  isEncryptedConnectorSecret,
  type EncryptedConnectorSecret,
  ConnectorVaultError,
} from "./credential-vault";
import {
  CONNECTOR_PROVIDER_IDS,
  type AirtableConnectorConfig,
  type ConnectorConnectionStatus,
  type ConnectorConnectionSummary,
  type ConnectorProviderConfig,
  type ConnectorProviderId,
  type HubSpotConnectorConfig,
  type SalesforceConnectorConfig,
} from "./contracts";

const CONNECTION_AUDIT_SCHEMA = "sympose-connector-connection-audit/v1" as const;
const PROVIDER_ID_PATTERN = /^[a-z]+$/u;
const AIRTABLE_BASE_ID_PATTERN = /^app[A-Za-z0-9]{4,64}$/u;
const PORTAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const API_VERSION_PATTERN = /^v([1-9][0-9]{0,2})\.([0-9])$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const SALESFORCE_DOMAIN_SUFFIXES = [".salesforce.com", ".my.salesforce.com"] as const;

export type ConnectorConnectionErrorCode =
  | "CONNECTOR_CONNECTION_INPUT_INVALID"
  | "CONNECTOR_CONNECTION_CONFIG_INVALID"
  | "CONNECTOR_CONNECTION_SECRET_REQUIRED"
  | "CONNECTOR_CONNECTION_STORAGE_INVALID"
  | "CONNECTOR_CONNECTION_VERSION_CONFLICT"
  | "CONNECTOR_CONNECTION_INACTIVE"
  | "CONNECTOR_CONNECTION_STALE"
  | "CONNECTOR_WORKSPACE_NOT_FOUND"
  | "CONNECTOR_VAULT_KEY_REQUIRED"
  | "CONNECTOR_VAULT_KEY_INVALID";

export class ConnectorConnectionError extends Error {
  readonly code: ConnectorConnectionErrorCode;

  constructor(code: ConnectorConnectionErrorCode) {
    super(code);
    this.name = "ConnectorConnectionError";
    this.code = code;
  }
}

export interface SaveConnectorConnectionInput {
  readonly provider: ConnectorProviderId;
  readonly config: unknown;
  readonly secret?: string;
  /** Zero creates a new connection; updates name the exact masked version that was read. */
  readonly expectedVersion: number;
}

interface WorkspaceRow {
  readonly id: string;
  readonly slug: string;
}

interface RawConnectorConnectionRow {
  readonly id: unknown;
  readonly workspaceId: unknown;
  readonly provider: unknown;
  readonly status: unknown;
  readonly configJson: unknown;
  readonly secretAlgorithm: unknown;
  readonly secretKeyVersion: unknown;
  readonly secretIv: unknown;
  readonly secretCiphertext: unknown;
  readonly secretTag: unknown;
  readonly version: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly revokedAt: unknown;
}

interface StoredConnectorConnection {
  readonly id: string;
  readonly version: number;
  readonly workspaceId: string;
  readonly provider: ConnectorProviderId;
  readonly status: ConnectorConnectionStatus;
  readonly config: ConnectorProviderConfig;
  readonly secret: EncryptedConnectorSecret | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function invalidInput(): never {
  throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INPUT_INVALID");
}

function invalidConfig(): never {
  throw new ConnectorConnectionError("CONNECTOR_CONNECTION_CONFIG_INVALID");
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    invalidConfig();
  }
  return value;
}

function optionalBoundedText(value: unknown, maximumBytes: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedText(value, maximumBytes);
}

function providerId(value: unknown): ConnectorProviderId {
  if (
    typeof value !== "string" ||
    !PROVIDER_ID_PATTERN.test(value) ||
    !(CONNECTOR_PROVIDER_IDS as readonly string[]).includes(value)
  ) {
    invalidInput();
  }
  return value as ConnectorProviderId;
}

function hasProviderField(record: Record<string, unknown>, provider: ConnectorProviderId): boolean {
  if (record.provider === undefined) return true;
  return record.provider === provider;
}

function normalizeAirtableConfig(record: Record<string, unknown>): AirtableConnectorConfig {
  if (!hasProviderField(record, "airtable")) invalidConfig();
  const expected = record.provider === undefined ? ["baseId", "tableName"] : ["baseId", "provider", "tableName"];
  if (!exactKeys(record, expected)) invalidConfig();
  const baseId = boundedText(record.baseId, 80);
  const tableName = boundedText(record.tableName, 256);
  if (!AIRTABLE_BASE_ID_PATTERN.test(baseId)) invalidConfig();
  return { provider: "airtable", baseId, tableName };
}

function normalizeHubSpotConfig(record: Record<string, unknown>): HubSpotConnectorConfig {
  if (!hasProviderField(record, "hubspot")) invalidConfig();
  const allowed = new Set(["portalId", "portalName", "provider"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) invalidConfig();
  const portalId = optionalBoundedText(record.portalId, 64);
  const portalName = optionalBoundedText(record.portalName, 256);
  if (portalId !== undefined && !PORTAL_ID_PATTERN.test(portalId)) invalidConfig();
  return {
    provider: "hubspot",
    ...(portalId === undefined ? {} : { portalId }),
    ...(portalName === undefined ? {} : { portalName }),
  };
}

function normalizeSalesforceInstanceUrl(value: unknown): string {
  const candidate = boundedText(value, 256);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    invalidConfig();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "443") ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    invalidConfig();
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname.length === 0 ||
    hostname === "localhost" ||
    hostname.includes(":") ||
    !SALESFORCE_DOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    hostname.endsWith(".") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(hostname)
  ) {
    invalidConfig();
  }
  return `https://${hostname}`;
}

function normalizeSalesforceApiVersion(value: unknown): string {
  const candidate = boundedText(value, 16).toLowerCase();
  const match = API_VERSION_PATTERN.exec(candidate.startsWith("v") ? candidate : `v${candidate}`);
  if (!match) invalidConfig();
  const major = Number(match[1]);
  if (!Number.isSafeInteger(major) || major < 1 || major > 999) invalidConfig();
  return `v${major}.${match[2]}`;
}

function normalizeSalesforceConfig(record: Record<string, unknown>): SalesforceConnectorConfig {
  if (!hasProviderField(record, "salesforce")) invalidConfig();
  const expected = record.provider === undefined
    ? ["apiVersion", "instanceUrl"]
    : ["apiVersion", "instanceUrl", "provider"];
  if (!exactKeys(record, expected)) invalidConfig();
  return {
    provider: "salesforce",
    instanceUrl: normalizeSalesforceInstanceUrl(record.instanceUrl),
    apiVersion: normalizeSalesforceApiVersion(record.apiVersion),
  };
}

/** Normalize provider configuration and reject fields that are not part of the allowlist. */
export function normalizeConnectorProviderConfig(
  provider: unknown,
  config: unknown,
): ConnectorProviderConfig {
  const normalizedProvider = providerId(provider);
  if (!isRecord(config)) invalidConfig();
  switch (normalizedProvider) {
    case "airtable":
      return normalizeAirtableConfig(config);
    case "hubspot":
      return normalizeHubSpotConfig(config);
    case "salesforce":
      return normalizeSalesforceConfig(config);
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function connectionId(workspaceId: string, provider: ConnectorProviderId): string {
  return deterministicUuid(`connector-connection:${workspaceId}:${provider}`);
}

function associatedData(workspaceId: string, provider: ConnectorProviderId): string {
  return `${CONNECTOR_CONNECTION_SCHEMA}:${workspaceId}:${provider}`;
}

function workspaceForSession(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): WorkspaceRow {
  const row = db
    .prepare(
      `SELECT id, slug
       FROM workspaces
       WHERE id = ? AND slug = ?`,
    )
    .get(session.workspaceId, requestedWorkspaceSlug) as WorkspaceRow | undefined;
  if (!row) throw new ConnectorConnectionError("CONNECTOR_WORKSPACE_NOT_FOUND");
  return row;
}

/** Every connector connection read or write repeats workspace and organizer authorization. */
export function requireConnectorConnectionsOrganizerAccess(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): void {
  assertWorkspaceMatch(session, requestedWorkspaceSlug);
  requireCapability(db, session, "connectors.manage");
}

function expectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidInput();
  return value;
}

function mapVaultError(error: unknown): never {
  if (error instanceof ConnectorVaultError) {
    if (error.code === "CONNECTOR_VAULT_KEY_REQUIRED") {
      throw new ConnectorConnectionError("CONNECTOR_VAULT_KEY_REQUIRED");
    }
    if (error.code === "CONNECTOR_VAULT_KEY_INVALID") {
      throw new ConnectorConnectionError("CONNECTOR_VAULT_KEY_INVALID");
    }
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INPUT_INVALID");
  }
  throw error;
}

function parseStoredConnection(
  row: RawConnectorConnectionRow,
  workspaceId: string,
  provider: ConnectorProviderId,
): StoredConnectorConnection {
  const expectedId = connectionId(workspaceId, provider);
  if (
    row.id !== expectedId ||
    row.workspaceId !== workspaceId ||
    row.provider !== provider ||
    (row.status !== "ACTIVE" && row.status !== "REVOKED") ||
    typeof row.version !== "number" ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    typeof row.configJson !== "string" ||
    Buffer.byteLength(row.configJson, "utf8") > CONNECTOR_CONNECTION_CONFIG_MAX_BYTES ||
    typeof row.createdAt !== "string" ||
    !isCanonicalTimestamp(row.createdAt) ||
    typeof row.updatedAt !== "string" ||
    !isCanonicalTimestamp(row.updatedAt) ||
    row.updatedAt < row.createdAt
  ) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_STORAGE_INVALID");
  }

  let configValue: unknown;
  try {
    configValue = JSON.parse(row.configJson) as unknown;
  } catch {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_STORAGE_INVALID");
  }
  let config: ConnectorProviderConfig;
  try {
    config = normalizeConnectorProviderConfig(provider, configValue);
  } catch {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_STORAGE_INVALID");
  }
  if (canonicalJson(config) !== row.configJson) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_STORAGE_INVALID");
  }

  const secretFields = [
    row.secretAlgorithm,
    row.secretKeyVersion,
    row.secretIv,
    row.secretCiphertext,
    row.secretTag,
  ];
  const secretAbsent = secretFields.every((field) => field === null);
  const secretPresent = secretFields.every((field) => typeof field === "string");
  const secret = secretPresent
    ? {
      algorithm: row.secretAlgorithm as EncryptedConnectorSecret["algorithm"],
      keyVersion: row.secretKeyVersion as EncryptedConnectorSecret["keyVersion"],
      iv: row.secretIv as string,
      ciphertext: row.secretCiphertext as string,
      tag: row.secretTag as string,
    }
    : null;
  if (
    (!secretAbsent && !secretPresent) ||
    (secretPresent && !isEncryptedConnectorSecret(secret)) ||
    (row.status === "ACTIVE" && (!secret || row.revokedAt !== null)) ||
    (row.status === "REVOKED" && (!secretAbsent || typeof row.revokedAt !== "string" || !isCanonicalTimestamp(row.revokedAt) || row.revokedAt !== row.updatedAt))
  ) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_STORAGE_INVALID");
  }

  return {
    id: expectedId,
    version: row.version,
    workspaceId,
    provider,
    status: row.status,
    config,
    secret,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.status === "REVOKED" ? row.revokedAt as string : null,
  };
}

function latestStoredConnection(
  db: Db,
  workspaceId: string,
  provider: ConnectorProviderId,
): StoredConnectorConnection | null {
  const row = db
    .prepare(
      `SELECT id,
              workspace_id AS workspaceId,
              provider,
              status,
              config_json AS configJson,
              secret_algorithm AS secretAlgorithm,
              secret_key_version AS secretKeyVersion,
              secret_iv AS secretIv,
              secret_ciphertext AS secretCiphertext,
              secret_tag AS secretTag,
              version,
              created_at AS createdAt,
              updated_at AS updatedAt,
              revoked_at AS revokedAt
       FROM connector_connections
       WHERE workspace_id = ? AND provider = ?
       LIMIT 1`,
    )
    .get(workspaceId, provider) as RawConnectorConnectionRow | undefined;
  return row ? parseStoredConnection(row, workspaceId, provider) : null;
}

function summary(connection: StoredConnectorConnection): ConnectorConnectionSummary {
  return {
    id: connection.id,
    provider: connection.provider,
    status: connection.status,
    config: connection.config,
    maskedSecret: connection.status === "ACTIVE" ? CONNECTOR_SECRET_MASK : null,
    version: connection.version,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    revokedAt: connection.revokedAt,
  };
}

function insertAudit(
  db: Db,
  session: SessionInfo,
  provider: ConnectorProviderId,
  version: number,
  action: "created" | "updated" | "revoked",
  status: ConnectorConnectionStatus,
  config: ConnectorProviderConfig,
  secretChanged: boolean,
): void {
  const targetId = connectionId(session.workspaceId, provider);
  const details = {
    schema: CONNECTION_AUDIT_SCHEMA,
    provider,
    connectionId: targetId,
    version,
    status,
    secretChanged,
    configFingerprint: fingerprintOf(config),
  };
  db.prepare(
    `INSERT INTO audit_events
       (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, 'account', ?, ?, 'connector_connection', ?, ?, ?)`,
  ).run(
    deterministicUuid(`connector-connection-audit:${session.workspaceId}:${provider}:${version}:${action}`),
    session.workspaceId,
    session.accountId,
    `connector.connection.${action}`,
    targetId,
    canonicalJson(details),
    nowIso(),
  );
}

function envelopeColumns(secret: EncryptedConnectorSecret | null): readonly [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
] {
  return secret
    ? [secret.algorithm, secret.keyVersion, secret.iv, secret.ciphertext, secret.tag]
    : [null, null, null, null, null];
}

function persistState(
  db: Db,
  session: SessionInfo,
  previous: StoredConnectorConnection | null,
  provider: ConnectorProviderId,
  config: ConnectorProviderConfig,
  secret: EncryptedConnectorSecret | null,
  status: ConnectorConnectionStatus,
): StoredConnectorConnection {
  const id = connectionId(session.workspaceId, provider);
  const version = previous ? previous.version + 1 : 1;
  const createdAt = previous?.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const revokedAt = status === "REVOKED" ? updatedAt : null;
  const configJson = canonicalJson(config);
  if (Buffer.byteLength(configJson, "utf8") > CONNECTOR_CONNECTION_CONFIG_MAX_BYTES) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_CONFIG_INVALID");
  }
  const [algorithm, keyVersion, iv, ciphertext, tag] = envelopeColumns(secret);

  if (previous) {
    const result = db.prepare(
      `UPDATE connector_connections
       SET status = ?,
           config_json = ?,
           secret_algorithm = ?,
           secret_key_version = ?,
           secret_iv = ?,
           secret_ciphertext = ?,
           secret_tag = ?,
           version = ?,
           updated_at = ?,
           revoked_at = ?
       WHERE id = ? AND workspace_id = ? AND provider = ? AND version = ?`,
    ).run(
      status,
      configJson,
      algorithm,
      keyVersion,
      iv,
      ciphertext,
      tag,
      version,
      updatedAt,
      revokedAt,
      id,
      session.workspaceId,
      provider,
      previous.version,
    );
    if (Number(result.changes) !== 1) {
      throw new ConnectorConnectionError("CONNECTOR_CONNECTION_STORAGE_INVALID");
    }
  } else {
    db.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, provider, status, config_json,
          secret_algorithm, secret_key_version, secret_iv, secret_ciphertext, secret_tag,
          version, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      session.workspaceId,
      provider,
      status,
      configJson,
      algorithm,
      keyVersion,
      iv,
      ciphertext,
      tag,
      version,
      createdAt,
      updatedAt,
      revokedAt,
    );
  }

  const action = status === "REVOKED" ? "revoked" : previous ? "updated" : "created";
  insertAudit(db, session, provider, version, action, status, config, status === "REVOKED" || previous?.secret !== secret);
  return {
    id,
    version,
    workspaceId: session.workspaceId,
    provider,
    status,
    config,
    secret,
    createdAt,
    updatedAt,
    revokedAt,
  };
}

function requireSecretEnvelope(
  input: SaveConnectorConnectionInput,
  workspaceId: string,
): EncryptedConnectorSecret {
  if (typeof input.secret !== "string") {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_SECRET_REQUIRED");
  }
  try {
    return encryptConnectorSecret(input.secret, associatedData(workspaceId, input.provider));
  } catch (error) {
    return mapVaultError(error);
  }
}

/** Create or update a workspace-scoped provider connection without returning its secret. */
export function saveConnectorConnection(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
  input: SaveConnectorConnectionInput,
): ConnectorConnectionSummary {
  requireConnectorConnectionsOrganizerAccess(db, session, requestedWorkspaceSlug);
  const provider = providerId(input?.provider);
  const config = normalizeConnectorProviderConfig(provider, input?.config);
  const requestedVersion = expectedVersion(input?.expectedVersion);
  const workspace = workspaceForSession(db, session, requestedWorkspaceSlug);

  return withTransaction(db, () => {
    const previous = latestStoredConnection(db, workspace.id, provider);
    if ((previous?.version ?? 0) !== requestedVersion) {
      throw new ConnectorConnectionError("CONNECTOR_CONNECTION_VERSION_CONFLICT");
    }
    let secret: EncryptedConnectorSecret;
    if (input.secret === undefined && previous?.status === "ACTIVE") {
      try {
        assertConnectorVaultConfigured();
      } catch (error) {
        return mapVaultError(error);
      }
      if (!previous.secret) {
        throw new ConnectorConnectionError("CONNECTOR_CONNECTION_STORAGE_INVALID");
      }
      secret = previous.secret;
      if (canonicalJson(previous.config) === canonicalJson(config)) {
        return summary(previous);
      }
    } else {
      secret = requireSecretEnvelope({
        provider,
        config,
        secret: input.secret,
        expectedVersion: requestedVersion,
      }, workspace.id);
    }
    return summary(persistState(db, session, previous, provider, config, secret, "ACTIVE"));
  });
}

/** Revoke a connection and clear its active encrypted envelope in the mutable row. */
export function revokeConnectorConnection(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
  providerInput: unknown,
  expectedVersionInput: unknown,
): ConnectorConnectionSummary | null {
  requireConnectorConnectionsOrganizerAccess(db, session, requestedWorkspaceSlug);
  const provider = providerId(providerInput);
  const requestedVersion = expectedVersion(expectedVersionInput);
  const workspace = workspaceForSession(db, session, requestedWorkspaceSlug);

  return withTransaction(db, () => {
    const previous = latestStoredConnection(db, workspace.id, provider);
    if ((previous?.version ?? 0) !== requestedVersion) {
      throw new ConnectorConnectionError("CONNECTOR_CONNECTION_VERSION_CONFLICT");
    }
    if (!previous || previous.status === "REVOKED") return previous ? summary(previous) : null;
    return summary(persistState(db, session, previous, provider, previous.config, null, "REVOKED"));
  });
}

/** List only masked connection summaries for the authorized workspace. */
export function listConnectorConnectionSummaries(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): readonly ConnectorConnectionSummary[] {
  requireConnectorConnectionsOrganizerAccess(db, session, requestedWorkspaceSlug);
  const workspace = workspaceForSession(db, session, requestedWorkspaceSlug);
  return CONNECTOR_PROVIDER_IDS.flatMap((provider) => {
    const current = latestStoredConnection(db, workspace.id, provider);
    return current ? [summary(current)] : [];
  });
}

/** Read one masked connection summary at the same authenticated workspace boundary. */
export function getConnectorConnectionSummary(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
  providerInput: unknown,
): ConnectorConnectionSummary | null {
  requireConnectorConnectionsOrganizerAccess(db, session, requestedWorkspaceSlug);
  const provider = providerId(providerInput);
  const workspace = workspaceForSession(db, session, requestedWorkspaceSlug);
  const current = latestStoredConnection(db, workspace.id, provider);
  return current ? summary(current) : null;
}

/** Server-only lease used by the fixture-injected execution orchestrator. */
export interface ConnectorExecutionSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: ConnectorProviderId;
  readonly version: number;
  readonly config: ConnectorProviderConfig;
  readonly configFingerprint: string;
  readonly secret: string;
}

export function loadActiveConnectorExecutionSnapshot(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
  providerInput: unknown,
): ConnectorExecutionSnapshot {
  requireConnectorConnectionsOrganizerAccess(db, session, requestedWorkspaceSlug);
  const provider = providerId(providerInput);
  const workspace = workspaceForSession(db, session, requestedWorkspaceSlug);
  const current = latestStoredConnection(db, workspace.id, provider);
  if (!current || current.status !== "ACTIVE" || !current.secret) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_INACTIVE");
  }
  let secret: string;
  try {
    secret = decryptConnectorSecret(current.secret, associatedData(workspace.id, provider));
  } catch {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_STORAGE_INVALID");
  }
  return Object.freeze({
    id: current.id,
    workspaceId: current.workspaceId,
    provider,
    version: current.version,
    config: current.config,
    configFingerprint: fingerprintOf(current.config),
    secret,
  });
}

export function assertConnectorExecutionSnapshotCurrent(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
  snapshot: Pick<ConnectorExecutionSnapshot, "id" | "provider" | "version" | "configFingerprint">,
): void {
  requireConnectorConnectionsOrganizerAccess(db, session, requestedWorkspaceSlug);
  const workspace = workspaceForSession(db, session, requestedWorkspaceSlug);
  const current = latestStoredConnection(db, workspace.id, snapshot.provider);
  if (
    !current || current.status !== "ACTIVE" || current.id !== snapshot.id ||
    current.version !== snapshot.version || fingerprintOf(current.config) !== snapshot.configFingerprint
  ) {
    throw new ConnectorConnectionError("CONNECTOR_CONNECTION_STALE");
  }
}
