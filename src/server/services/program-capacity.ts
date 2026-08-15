import type { SessionInfo } from "../auth";
import { DenialError, hasCapability } from "../auth";
import { canonicalJson, deterministicUuid, fingerprintOf, nowIso, uuid } from "../canonical";
import { withTransactionOrSavepoint, type Db } from "../db";
import { writeAudit } from "./audit";

const CAPABILITY = "phase0.pipeline.manage" as const;
const POOL_VERSION_SCHEMA = "pd01-capacity-pool-version/v1" as const;
const TRANSFER_SCHEMA = "pd01-capacity-transfer-decision/v1" as const;
const LEDGER_SCHEMA = "pd01-capacity-ledger/v1" as const;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_DOCUMENT_DEPTH = 32;
const SQLITE_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type CapacityJson = unknown;

export interface CapacityPoolDefinitionInput {
  readonly poolId?: string;
  readonly versionId?: string;
  readonly name: string;
  readonly unitKind: string;
  readonly capacity: number;
  readonly scope?: CapacityJson;
  readonly eligibility?: CapacityJson;
  readonly reservedFor?: CapacityJson;
  readonly reservationPolicy?: CapacityJson;
  readonly releasePolicy?: CapacityJson;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
}

export interface AppendCapacityPoolVersionInput {
  readonly poolId: string;
  /** Stable command identity. Retries must reuse this key and the exact payload. */
  readonly idempotencyKey: string;
  readonly versionId?: string;
  readonly capacity: number;
  readonly scope?: CapacityJson;
  readonly eligibility?: CapacityJson;
  readonly reservedFor?: CapacityJson;
  readonly reservationPolicy?: CapacityJson;
  readonly releasePolicy?: CapacityJson;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly expectedVersionNumber?: number;
}

export interface CapacityPoolVersionInput {
  readonly unitKind: string;
  readonly capacity: number;
  readonly scope?: CapacityJson;
  readonly eligibility?: CapacityJson;
  readonly reservedFor?: CapacityJson;
  readonly reservationPolicy?: CapacityJson;
  readonly releasePolicy?: CapacityJson;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
}

export interface CapacityTransferInput {
  readonly sourcePoolId: string;
  readonly sourcePoolVersionId?: string;
  readonly sourceVersionId?: string;
  readonly destinationPoolId: string;
  readonly destinationPoolVersionId?: string;
  readonly destinationVersionId?: string;
  readonly unitKind: string;
  readonly quantity: number;
  readonly reason: string;
  readonly approvalReference: string;
  readonly idempotencyKey: string;
  readonly expectedSequenceNumber?: number;
  readonly expectedSequence?: number;
  readonly expectedLedgerFingerprint?: string;
}

export interface CapacityPoolVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly poolId: string;
  readonly versionNumber: number;
  readonly unitKind: string;
  readonly capacity: number;
  readonly scope: CapacityJson;
  readonly eligibility: CapacityJson;
  readonly reservedFor: CapacityJson;
  readonly releasePolicy: CapacityJson;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface CapacityPool {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly unitKind: string;
  readonly name: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly currentVersion: CapacityPoolVersion;
}

export interface CreateCapacityPoolResult {
  readonly pool: CapacityPool;
  readonly version: CapacityPoolVersion;
  readonly created: boolean;
}

export interface AppendCapacityPoolVersionResult {
  readonly pool: CapacityPool;
  readonly version: CapacityPoolVersion;
  readonly created: boolean;
}

export interface CapacityLedgerEntry {
  readonly poolId: string;
  readonly poolName: string;
  readonly unitKind: string;
  /** The immutable version that currently anchors the ledger balance. */
  readonly versionId: string;
  readonly versionNumber: number;
  /** The newest immutable definition, which can differ after historical activity. */
  readonly latestVersionId: string;
  readonly latestVersionNumber: number;
  readonly capacity: number;
  readonly remaining: number;
  readonly remainingCapacity: number;
  readonly transferredIn: number;
  readonly transferredOut: number;
}

export interface CapacityLedger {
  readonly schema: typeof LEDGER_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly sequenceNumber: number;
  readonly ledgerFingerprint: string;
  readonly pools: readonly CapacityLedgerEntry[];
  readonly totalCapacity: number;
  readonly totalRemaining: number;
}

export interface CapacityTransferReceipt {
  readonly receiptId: string;
  readonly decisionId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly sequenceNumber: number;
  readonly sourcePoolId: string;
  readonly sourcePoolVersionId: string;
  readonly destinationPoolId: string;
  readonly destinationPoolVersionId: string;
  readonly unitKind: string;
  readonly quantity: number;
  readonly sourceBefore: number;
  readonly sourceAfter: number;
  readonly destinationBefore: number;
  readonly destinationAfter: number;
  readonly recordedAt: string;
  readonly fingerprint: string;
}

export interface CapacityTransferResult {
  readonly decisionId: string;
  readonly receipt: CapacityTransferReceipt;
  readonly ledger: CapacityLedger;
  readonly created: boolean;
  readonly replayed: boolean;
  readonly operation: "transfer" | "release";
}

export interface CapacityTransferHistoryEntry extends CapacityTransferReceipt {
  readonly actorAccountId: string;
  readonly reason: string;
  readonly approvalReference: string;
  readonly decidedAt: string;
  readonly idempotencyKey: string;
  readonly operation: "transfer" | "release";
}

export const CAPACITY_SURFACE_POOL_LIMIT = 64;
export const CAPACITY_SURFACE_HISTORY_LIMIT = 64;
export const CAPACITY_SURFACE_VERSION_LIMIT = 256;

export class CapacitySurfaceProjectionError extends Error {
  readonly code: "CAPACITY_SURFACE_OVERFLOW" | "CAPACITY_SURFACE_INTEGRITY";

  constructor(code: "CAPACITY_SURFACE_OVERFLOW" | "CAPACITY_SURFACE_INTEGRITY", message: string = code) {
    super(`${code}: ${message}`);
    this.name = "CapacitySurfaceProjectionError";
    this.code = code;
  }
}

export interface ProgramCapacitySurfaceProjection {
  readonly ledger: CapacityLedger;
  readonly pools: readonly CapacityPool[];
  readonly history: readonly CapacityTransferHistoryEntry[];
}

type PoolRow = {
  id: string;
  workspaceId: string;
  eventId: string;
  unitKind: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
};

type VersionRow = {
  id: string;
  workspaceId: string;
  eventId: string;
  poolId: string;
  versionNumber: number;
  unitKind: string;
  capacity: number;
  scopeJson: string;
  eligibilityJson: string;
  reservedForJson: string;
  releasePolicyJson: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  fingerprint: string;
  createdAt: string;
};

type DecisionRow = {
  id: string;
  workspaceId: string;
  eventId: string;
  sequenceNumber: number;
  sourcePoolId: string;
  sourcePoolVersionId: string;
  destinationPoolId: string;
  destinationPoolVersionId: string;
  unitKind: string;
  quantity: number;
  sourceBefore: number;
  sourceAfter: number;
  destinationBefore: number;
  destinationAfter: number;
  actorAccountId: string;
  reason: string;
  approvalReference: string;
  decidedAt: string;
  idempotencyKey: string;
  fingerprint: string;
};

type BalanceState = { versionId: string; balance: number; transferredIn: number; transferredOut: number };

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value as object)) {
      deepFreeze(Reflect.get(value as object, key));
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalAuditDetails(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

function publicFields<T extends object>(input: T, keys: readonly string[]): Record<string, unknown> {
  if (input === null || (typeof input !== "object" && typeof input !== "function")) fail("CAPACITY_INPUT_INVALID");
  const result: Record<string, unknown> = {};
  try {
    for (const key of keys) result[key] = Reflect.get(input, key);
  } catch {
    fail("CAPACITY_INPUT_INVALID");
  }
  return result;
}

function captureSession(session: SessionInfo): SessionInfo {
  const safe = publicFields(session, ["id", "tokenHash", "accountId", "workspaceId", "expiresAt", "email", "displayName", "role", "workspaceSlug", "workspaceName"]);
  try {
    return deepFreeze({
      id: idValue(safe.id, "session_id"), tokenHash: stringValue(safe.tokenHash, "token_hash", 1, 128),
      accountId: idValue(safe.accountId, "account_id"), workspaceId: idValue(safe.workspaceId, "workspace_id"),
      expiresAt: stringValue(safe.expiresAt, "expires_at", 1, 128), email: stringValue(safe.email, "email", 1, 16384),
      displayName: stringValue(safe.displayName, "display_name", 1, 16384), role: idValue(safe.role, "role"),
      workspaceSlug: stringValue(safe.workspaceSlug, "workspace_slug", 1, 128),
      workspaceName: stringValue(safe.workspaceName, "workspace_name", 1, 16384),
    });
  } catch (error) {
    if (error instanceof Error && /^INVALID_[A-Z0-9_]+:/.test(error.message)) throw error;
    fail("CAPACITY_INPUT_INVALID");
  }
}

function captureEventId(eventId: string): string {
  try {
    return idValue(eventId, "event_id");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INVALID_EVENT_ID:")) throw error;
    fail("CAPACITY_INPUT_INVALID");
  }
}

function captureCreateInput(input: CapacityPoolDefinitionInput): CapacityPoolDefinitionInput {
  const safe = publicFields(input, ["poolId", "versionId", "name", "unitKind", "capacity", "scope", "eligibility", "reservedFor", "reservationPolicy", "releasePolicy", "effectiveFrom", "effectiveTo"]);
  return safe as unknown as CapacityPoolDefinitionInput;
}

function captureAppendInput(input: AppendCapacityPoolVersionInput): AppendCapacityPoolVersionInput {
  const safe = publicFields(input, ["poolId", "idempotencyKey", "versionId", "capacity", "scope", "eligibility", "reservedFor", "reservationPolicy", "releasePolicy", "effectiveFrom", "effectiveTo", "expectedVersionNumber"]);
  return safe as unknown as AppendCapacityPoolVersionInput;
}

function captureTransferInput(input: CapacityTransferInput): CapacityTransferInput {
  const safe = publicFields(input, ["sourcePoolId", "sourcePoolVersionId", "sourceVersionId", "destinationPoolId", "destinationPoolVersionId", "destinationVersionId", "unitKind", "quantity", "reason", "approvalReference", "idempotencyKey", "expectedSequenceNumber", "expectedSequence", "expectedLedgerFingerprint"]);
  return safe as unknown as CapacityTransferInput;
}

function capturePoolId(poolId: string): string {
  try {
    return idValue(poolId, "pool_id");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INVALID_POOL_ID:")) throw error;
    fail("CAPACITY_INPUT_INVALID");
  }
}

function fail(code: string, message = code): never {
  throw new Error(`${code}: ${message}`);
}

function stringValue(value: unknown, field: string, min = 1, max = 4096): string {
  if (typeof value !== "string" || value.length < min || value.length > max || value.trim().length < min) {
    fail(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function idValue(value: unknown, field: string, max = 256): string {
  return stringValue(value, field, 1, max);
}

function integerValue(value: unknown, field: string, minimum: number, maximum = SQLITE_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function safeAdd(left: number, right: number, code: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0 || left > SQLITE_SAFE_INTEGER - right) fail(code);
  return left + right;
}

function safeSubtract(left: number, right: number, code: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0 || left < right) fail(code);
  return left - right;
}

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > MAX_DOCUMENT_DEPTH) return depth;
  if (Array.isArray(value)) return Math.max(depth, ...value.map((item) => jsonDepth(item, depth + 1)));
  if (value !== null && typeof value === "object") {
    return Math.max(depth, ...Object.values(value as Record<string, unknown>).map((item) => jsonDepth(item, depth + 1)));
  }
  return depth;
}

function jsonDocument(value: unknown, field: string, defaultValue: unknown = {}): { value: CapacityJson; json: string } {
  let parsed: unknown = value === undefined ? defaultValue : value;
  try {
    if (typeof parsed === "string") {
      if (Buffer.byteLength(parsed, "utf8") > MAX_DOCUMENT_BYTES) fail(`INVALID_${field.toUpperCase()}`);
      parsed = JSON.parse(parsed) as unknown;
    } else {
      parsed = JSON.parse(JSON.stringify(parsed)) as unknown;
    }
    if (jsonDepth(parsed) > MAX_DOCUMENT_DEPTH) fail(`INVALID_${field.toUpperCase()}`);
    const json = canonicalJson(parsed);
    if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_DOCUMENT_BYTES) {
      fail(`INVALID_${field.toUpperCase()}`);
    }
    return { value: deepFreeze(parsed), json };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INVALID_")) throw error;
    fail(`INVALID_${field.toUpperCase()}`);
  }
}

function timestamp(value: unknown, field: string, fallback = nowIso()): string {
  const result = value === undefined ? fallback : stringValue(value, field, 24, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) || new Date(result).toISOString() !== result) {
    fail(`INVALID_${field.toUpperCase()}`);
  }
  return result;
}

function optionalTimestamp(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : timestamp(value, field);
}

function assertEvent(db: Db, session: SessionInfo, eventId: string): void {
  idValue(eventId, "event_id");
  const event = db.prepare("SELECT id FROM events WHERE id = ? AND workspace_id = ?").get(eventId, session.workspaceId) as { id: string } | undefined;
  if (!event) fail("EVENT_NOT_FOUND", "The event is not in the current workspace.");
}

function validatePersistedSession(db: Db, session: SessionInfo): void {
  const row = db.prepare(`SELECT s.id, s.token_hash AS tokenHash, s.account_id AS accountId, s.workspace_id AS workspaceId,
      s.expires_at AS expiresAt, a.email, a.display_name AS displayName, a.role,
      w.slug AS workspaceSlug, w.name AS workspaceName
      FROM sessions s JOIN accounts a ON a.id = s.account_id AND a.workspace_id = s.workspace_id
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ? AND s.token_hash = ? AND s.account_id = ? AND s.workspace_id = ?`)
    .get(session.id, session.tokenHash, session.accountId, session.workspaceId) as SessionInfo | undefined;
  if (!row || row.tokenHash !== session.tokenHash || row.email !== session.email || row.displayName !== session.displayName
    || row.role !== session.role || row.workspaceSlug !== session.workspaceSlug || row.workspaceName !== session.workspaceName
    || row.expiresAt !== session.expiresAt || row.expiresAt <= nowIso()) {
    throw new DenialError("SESSION_INVALID", "SESSION_INVALID: No active server session.", "session");
  }
}

function authorize(db: Db, session: SessionInfo): void {
  validatePersistedSession(db, session);
  if (!hasCapability(session, CAPABILITY)) {
    throw new DenialError("CAPABILITY_DENIED", "This account is not authorized to perform that workspace action.", CAPABILITY);
  }
}

function withAuthorizedMutation<T>(db: Db, name: string, session: SessionInfo, fn: () => T): T {
  try {
    return withTransactionOrSavepoint(db, name, fn);
  } catch (error) {
    if (error instanceof DenialError && error.code === "CAPABILITY_DENIED") {
      try {
        validatePersistedSession(db, session);
        if (!hasCapability(session, CAPABILITY)) {
          writeAudit(db, session.workspaceId, {
            actorKind: "account", actorRef: session.accountId, action: "security.access.denied",
            targetType: "capability", targetId: CAPABILITY,
            details: canonicalAuditDetails({ code: "CAPABILITY_DENIED", role: session.role }),
          });
        }
      } catch {
        // Never emit a denial audit for a session that is no longer proven.
      }
    }
    throw error;
  }
}

function poolVersionFingerprint(input: {
  workspaceId: string; eventId: string; poolId: string; versionNumber: number; unitKind: string;
  capacity: number; scope: CapacityJson; eligibility: CapacityJson; reservedFor: CapacityJson;
  releasePolicy: CapacityJson; effectiveFrom: string; effectiveTo: string | null; createdAt: string;
}): string {
  return fingerprintOf({
    schema: POOL_VERSION_SCHEMA,
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    poolId: input.poolId,
    versionNumber: input.versionNumber,
    unitKind: input.unitKind,
    capacity: input.capacity,
    scope: input.scope,
    eligibility: input.eligibility,
    reservedFor: input.reservedFor,
    releasePolicy: input.releasePolicy,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    createdAt: input.createdAt,
  });
}

function transferFingerprint(input: {
  workspaceId: string; eventId: string; sequenceNumber: number; sourcePoolId: string;
  sourcePoolVersionId: string; destinationPoolId: string; destinationPoolVersionId: string;
  unitKind: string; quantity: number; sourceBefore: number; sourceAfter: number;
  destinationBefore: number; destinationAfter: number; actorAccountId: string; reason: string;
  approvalReference: string; decidedAt: string; idempotencyKey: string;
}): string {
  return fingerprintOf({
    schema: TRANSFER_SCHEMA, workspaceId: input.workspaceId, eventId: input.eventId,
    sequenceNumber: input.sequenceNumber, sourcePoolId: input.sourcePoolId,
    sourcePoolVersionId: input.sourcePoolVersionId, destinationPoolId: input.destinationPoolId,
    destinationPoolVersionId: input.destinationPoolVersionId, unitKind: input.unitKind,
    quantity: input.quantity, sourceBefore: input.sourceBefore, sourceAfter: input.sourceAfter,
    destinationBefore: input.destinationBefore, destinationAfter: input.destinationAfter,
    actorAccountId: input.actorAccountId, reason: input.reason, approvalReference: input.approvalReference,
    decidedAt: input.decidedAt, idempotencyKey: input.idempotencyKey,
  });
}

function canonicalDecisionOperation(db: Db, session: SessionInfo, decision: DecisionRow): "transfer" | "release" {
  const rows = db.prepare(`SELECT actor_kind AS actorKind, actor_ref AS actorRef, action, target_type AS targetType,
      target_id AS targetId, details_json AS detailsJson FROM audit_events
      WHERE workspace_id = ? AND target_id = ? ORDER BY rowid LIMIT 2`)
    .all(session.workspaceId, decision.id) as Array<{ action: string; detailsJson: string | null }>;
  if (rows.length !== 1) fail("CAPACITY_AUDIT_CORRUPT");
  const row = rows[0] as typeof rows[number] & { actorKind: string; actorRef: string; targetType: string; targetId: string };
  const operation = row.action === "capacity.release.decided" ? "release" : row.action === "capacity.transfer.decided" ? "transfer" : null;
  if (row.actorKind !== "account" || row.actorRef !== decision.actorAccountId || row.targetType !== "capacity_transfer_decision"
    || row.targetId !== decision.id || operation === null) fail("CAPACITY_AUDIT_CORRUPT");
  const details = parseCanonicalAuditObject(row.detailsJson);
  const expected = canonicalAuditDetails({ eventId: decision.eventId, sequenceNumber: decision.sequenceNumber,
    sourcePoolId: decision.sourcePoolId, sourcePoolVersionId: decision.sourcePoolVersionId,
    destinationPoolId: decision.destinationPoolId, destinationPoolVersionId: decision.destinationPoolVersionId,
    unitKind: decision.unitKind, quantity: decision.quantity, sourceBefore: decision.sourceBefore,
    sourceAfter: decision.sourceAfter, destinationBefore: decision.destinationBefore,
    destinationAfter: decision.destinationAfter, actorAccountId: decision.actorAccountId, reason: decision.reason,
    approvalReference: decision.approvalReference, idempotencyKey: decision.idempotencyKey,
    fingerprint: decision.fingerprint, operation });
  if (canonicalJson(details) !== canonicalJson(expected)) {
    fail("CAPACITY_AUDIT_CORRUPT");
  }
  return operation;
}

function parseCanonicalAuditObject(raw: unknown): Record<string, unknown> {
  try {
    if (typeof raw !== "string") fail("CAPACITY_AUDIT_CORRUPT");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || canonicalJson(parsed) !== raw) {
      fail("CAPACITY_AUDIT_CORRUPT");
    }
    return parsed as Record<string, unknown>;
  } catch {
    fail("CAPACITY_AUDIT_CORRUPT");
  }
}

function readJsonColumn(raw: unknown, field: string): CapacityJson {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) fail("CAPACITY_LEDGER_CORRUPT");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (jsonDepth(parsed) > MAX_DOCUMENT_DEPTH || canonicalJson(parsed) !== raw) fail("CAPACITY_LEDGER_CORRUPT");
    return deepFreeze(parsed);
  } catch {
    fail(`CAPACITY_${field.toUpperCase()}_CORRUPT`);
  }
}

function readVersion(row: VersionRow): CapacityPoolVersion {
  const scope = readJsonColumn(row.scopeJson, "scope");
  const eligibility = readJsonColumn(row.eligibilityJson, "eligibility");
  const reservedFor = readJsonColumn(row.reservedForJson, "reserved_for");
  const releasePolicy = readJsonColumn(row.releasePolicyJson, "release_policy");
  const expected = poolVersionFingerprint({
    workspaceId: row.workspaceId, eventId: row.eventId, poolId: row.poolId, versionNumber: row.versionNumber,
    unitKind: row.unitKind, capacity: row.capacity, scope, eligibility, reservedFor, releasePolicy,
    effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, createdAt: row.createdAt,
  });
  if (row.fingerprint !== expected || !Number.isSafeInteger(row.versionNumber) || row.versionNumber < 1
    || !Number.isSafeInteger(row.capacity) || row.capacity < 0) fail("CAPACITY_LEDGER_CORRUPT");
  return {
    id: row.id, workspaceId: row.workspaceId, eventId: row.eventId, poolId: row.poolId,
    versionNumber: row.versionNumber, unitKind: row.unitKind, capacity: row.capacity,
    scope, eligibility, reservedFor, releasePolicy, effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo, fingerprint: row.fingerprint, createdAt: row.createdAt,
  };
}

function poolRow(db: Db, session: SessionInfo, eventId: string, poolId: string): PoolRow {
  const row = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId, unit_kind AS unitKind,
      name, created_at AS createdAt, archived_at AS archivedAt
      FROM program_capacity_pools WHERE workspace_id = ? AND event_id = ? AND id = ?`)
    .get(session.workspaceId, eventId, poolId) as PoolRow | undefined;
  if (!row) fail("POOL_NOT_FOUND", "The capacity pool is not in the current event.");
  return deepFreeze(row);
}

function versionRows(db: Db, session: SessionInfo, eventId: string): VersionRow[] {
  const rows = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId, pool_id AS poolId,
      version_number AS versionNumber, unit_kind AS unitKind, capacity, scope_json AS scopeJson,
      eligibility_json AS eligibilityJson, reserved_for_json AS reservedForJson,
      release_policy_json AS releasePolicyJson, effective_from AS effectiveFrom,
      effective_to AS effectiveTo, fingerprint, created_at AS createdAt
      FROM program_capacity_pool_versions WHERE workspace_id = ? AND event_id = ? ORDER BY pool_id, version_number`)
    .all(session.workspaceId, eventId) as VersionRow[];
  for (const row of rows) readVersion(row);
  return rows;
}

function versionById(db: Db, session: SessionInfo, eventId: string, poolId: string, versionId: string): CapacityPoolVersion {
  const row = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId, pool_id AS poolId,
      version_number AS versionNumber, unit_kind AS unitKind, capacity, scope_json AS scopeJson,
      eligibility_json AS eligibilityJson, reserved_for_json AS reservedForJson,
      release_policy_json AS releasePolicyJson, effective_from AS effectiveFrom,
      effective_to AS effectiveTo, fingerprint, created_at AS createdAt
      FROM program_capacity_pool_versions WHERE workspace_id = ? AND event_id = ? AND pool_id = ? AND id = ?`)
    .get(session.workspaceId, eventId, poolId, versionId) as VersionRow | undefined;
  if (!row) fail("POOL_VERSION_NOT_FOUND", "The requested immutable pool definition is not in this event.");
  return readVersion(row);
}

function poolWithVersion(db: Db, session: SessionInfo, eventId: string, poolId: string, version?: CapacityPoolVersion): CapacityPool {
  const pool = poolRow(db, session, eventId, poolId);
  const selected = version ?? latestVersion(db, session, eventId, poolId);
  if (pool.unitKind !== selected.unitKind) fail("CAPACITY_LEDGER_CORRUPT");
  return deepFreeze({ ...pool, currentVersion: selected });
}

function latestVersion(db: Db, session: SessionInfo, eventId: string, poolId: string): CapacityPoolVersion {
  const row = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId, pool_id AS poolId,
      version_number AS versionNumber, unit_kind AS unitKind, capacity, scope_json AS scopeJson,
      eligibility_json AS eligibilityJson, reserved_for_json AS reservedForJson,
      release_policy_json AS releasePolicyJson, effective_from AS effectiveFrom,
      effective_to AS effectiveTo, fingerprint, created_at AS createdAt
      FROM program_capacity_pool_versions WHERE workspace_id = ? AND event_id = ? AND pool_id = ?
      ORDER BY version_number DESC LIMIT 1`)
    .get(session.workspaceId, eventId, poolId) as VersionRow | undefined;
  if (!row) fail("POOL_VERSION_NOT_FOUND");
  return readVersion(row);
}

function activeVersionId(states: Map<string, BalanceState>, poolId: string, latest: CapacityPoolVersion): string {
  return states.get(poolId)?.versionId ?? latest.id;
}

function computeLedger(db: Db, session: SessionInfo, eventId: string): CapacityLedger {
  assertEvent(db, session, eventId);
  const pools = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId, unit_kind AS unitKind,
      name, created_at AS createdAt, archived_at AS archivedAt FROM program_capacity_pools
      WHERE workspace_id = ? AND event_id = ? ORDER BY id`).all(session.workspaceId, eventId) as PoolRow[];
  const versions = versionRows(db, session, eventId);
  const versionsById = new Map(versions.map((row) => [row.id, readVersion(row)]));
  const latestByPool = new Map<string, CapacityPoolVersion>();
  for (const row of versions) {
    const version = versionsById.get(row.id);
    if (!version) fail("CAPACITY_LEDGER_CORRUPT");
    const prior = latestByPool.get(row.poolId);
    if (!prior || prior.versionNumber < version.versionNumber) latestByPool.set(row.poolId, version);
  }
  if (latestByPool.size !== pools.length) fail("CAPACITY_LEDGER_CORRUPT");

  const states = new Map<string, BalanceState>();
  let decisions: DecisionRow[];
  try {
    decisions = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId,
        sequence_number AS sequenceNumber, source_pool_id AS sourcePoolId, source_pool_version_id AS sourcePoolVersionId,
        destination_pool_id AS destinationPoolId, destination_pool_version_id AS destinationPoolVersionId,
        unit_kind AS unitKind, quantity, source_before AS sourceBefore, source_after AS sourceAfter,
        destination_before AS destinationBefore, destination_after AS destinationAfter,
        actor_account_id AS actorAccountId, reason, approval_reference AS approvalReference,
        decided_at AS decidedAt, idempotency_key AS idempotencyKey, fingerprint
        FROM capacity_transfer_decisions WHERE workspace_id = ? AND event_id = ? ORDER BY sequence_number`)
      .all(session.workspaceId, eventId) as DecisionRow[];
  } catch {
    fail("CAPACITY_LEDGER_CORRUPT");
  }
  let sequence = 0;
  for (const decision of decisions) {
    sequence = safeAdd(sequence, 1, "CAPACITY_LEDGER_CORRUPT");
    if (decision.sequenceNumber !== sequence || !Number.isSafeInteger(decision.quantity) || decision.quantity <= 0
      || !Number.isSafeInteger(decision.sourceBefore) || decision.sourceBefore < 0
      || !Number.isSafeInteger(decision.sourceAfter) || decision.sourceAfter < 0
      || !Number.isSafeInteger(decision.destinationBefore) || decision.destinationBefore < 0
      || !Number.isSafeInteger(decision.destinationAfter) || decision.destinationAfter < 0) fail("CAPACITY_LEDGER_CORRUPT");
    const source = versionsById.get(decision.sourcePoolVersionId);
    const destination = versionsById.get(decision.destinationPoolVersionId);
    if (!source || !destination || source.poolId !== decision.sourcePoolId || destination.poolId !== decision.destinationPoolId
      || source.unitKind !== decision.unitKind || destination.unitKind !== decision.unitKind
      || decision.sourcePoolId === decision.destinationPoolId) fail("CAPACITY_LEDGER_CORRUPT");
    const sourceState = states.get(decision.sourcePoolId);
    const destinationState = states.get(decision.destinationPoolId);
    if (sourceState && sourceState.versionId !== decision.sourcePoolVersionId) fail("CAPACITY_LEDGER_CORRUPT");
    if (destinationState && destinationState.versionId !== decision.destinationPoolVersionId) fail("CAPACITY_LEDGER_CORRUPT");
    const sourceBefore = sourceState?.balance ?? source.capacity;
    const destinationBefore = destinationState?.balance ?? destination.capacity;
    const expectedFingerprint = transferFingerprint(decision);
    if (decision.fingerprint !== expectedFingerprint) fail("CAPACITY_LEDGER_CORRUPT");
    const expectedSourceAfter = safeSubtract(sourceBefore, decision.quantity, "CAPACITY_LEDGER_ARITHMETIC_CORRUPT");
    const expectedDestinationAfter = safeAdd(destinationBefore, decision.quantity, "CAPACITY_LEDGER_ARITHMETIC_CORRUPT");
    if (decision.sourceBefore !== sourceBefore || decision.destinationBefore !== destinationBefore
      || decision.sourceAfter !== expectedSourceAfter || decision.destinationAfter !== expectedDestinationAfter) fail("CAPACITY_LEDGER_ARITHMETIC_CORRUPT");
    readReceipt(db, session, decision);
    canonicalDecisionOperation(db, session, decision);
    states.set(decision.sourcePoolId, {
      versionId: decision.sourcePoolVersionId, balance: decision.sourceAfter,
      transferredIn: sourceState?.transferredIn ?? 0, transferredOut: safeAdd(sourceState?.transferredOut ?? 0, decision.quantity, "CAPACITY_LEDGER_ARITHMETIC_CORRUPT"),
    });
    states.set(decision.destinationPoolId, {
      versionId: decision.destinationPoolVersionId, balance: decision.destinationAfter,
      transferredIn: safeAdd(destinationState?.transferredIn ?? 0, decision.quantity, "CAPACITY_LEDGER_ARITHMETIC_CORRUPT"), transferredOut: destinationState?.transferredOut ?? 0,
    });
  }

  const entries = pools.map((pool) => {
    const latest = latestByPool.get(pool.id);
    if (!latest || latest.unitKind !== pool.unitKind) fail("CAPACITY_LEDGER_CORRUPT");
    const state = states.get(pool.id);
    const versionId = activeVersionId(states, pool.id, latest);
    const active = versionsById.get(versionId);
    if (!active) fail("CAPACITY_LEDGER_CORRUPT");
    const remaining = state?.balance ?? latest.capacity;
    return {
      poolId: pool.id, poolName: pool.name, unitKind: pool.unitKind, versionId,
      versionNumber: active.versionNumber, latestVersionId: latest.id, latestVersionNumber: latest.versionNumber,
      capacity: active.capacity, remaining, remainingCapacity: remaining,
      transferredIn: state?.transferredIn ?? 0, transferredOut: state?.transferredOut ?? 0,
    } satisfies CapacityLedgerEntry;
  });
  const projection = {
    schema: LEDGER_SCHEMA, workspaceId: session.workspaceId, eventId, sequenceNumber: sequence,
    pools: entries.map(({ poolId, poolName, unitKind, versionId, versionNumber, latestVersionId, latestVersionNumber, capacity, remaining, transferredIn, transferredOut }) =>
      ({ poolId, poolName, unitKind, versionId, versionNumber, latestVersionId, latestVersionNumber, capacity, remaining, remainingCapacity: remaining, transferredIn, transferredOut })),
  };
  return deepFreeze({
    ...projection,
    ledgerFingerprint: fingerprintOf(projection),
    totalCapacity: entries.reduce((sum, entry) => safeAdd(sum, entry.capacity, "CAPACITY_LEDGER_ARITHMETIC_CORRUPT"), 0),
    totalRemaining: entries.reduce((sum, entry) => safeAdd(sum, entry.remaining, "CAPACITY_LEDGER_ARITHMETIC_CORRUPT"), 0),
  });
}

function definitionDocuments(input: CapacityPoolVersionInput): {
  unitKind: string; capacity: number; scope: CapacityJson; scopeJson: string; eligibility: CapacityJson; eligibilityJson: string;
  reservedFor: CapacityJson; reservedForJson: string; releasePolicy: CapacityJson; releasePolicyJson: string;
  effectiveFrom: string; effectiveTo: string | null;
} {
  const unitKind = stringValue(input.unitKind, "unit_kind", 1, 128);
  const capacity = integerValue(input.capacity, "capacity", 0);
  const scope = jsonDocument(input.scope, "scope");
  const eligibility = jsonDocument(input.eligibility, "eligibility");
  const reservedForDocument = jsonDocument(input.reservedFor ?? input.reservationPolicy, "reserved_for");
  const reservationPolicyDocument = input.reservationPolicy === undefined ? reservedForDocument : jsonDocument(input.reservationPolicy, "reservation_policy");
  if (input.reservedFor !== undefined && input.reservationPolicy !== undefined
    && reservedForDocument.json !== reservationPolicyDocument.json) {
    fail("CAPACITY_RESERVATION_COMMAND_CONFLICT");
  }
  const reservedFor = reservedForDocument;
  const releasePolicy = jsonDocument(input.releasePolicy, "release_policy");
  const effectiveFrom = timestamp(input.effectiveFrom, "effective_from");
  const effectiveTo = optionalTimestamp(input.effectiveTo, "effective_to");
  if (effectiveTo !== null && effectiveTo < effectiveFrom) fail("INVALID_EFFECTIVE_RANGE");
  return deepFreeze({ unitKind, capacity, scope: scope.value, scopeJson: scope.json, eligibility: eligibility.value,
    eligibilityJson: eligibility.json, reservedFor: reservedFor.value, reservedForJson: reservedFor.json,
    releasePolicy: releasePolicy.value, releasePolicyJson: releasePolicy.json, effectiveFrom, effectiveTo });
}

function existingDefinitionMatches(
  version: CapacityPoolVersion,
  input: ReturnType<typeof definitionDocuments>,
  original: CapacityPoolDefinitionInput | AppendCapacityPoolVersionInput,
): boolean {
  return version.unitKind === input.unitKind && version.capacity === input.capacity
    && canonicalJson(version.scope) === input.scopeJson && canonicalJson(version.eligibility) === input.eligibilityJson
    && canonicalJson(version.reservedFor) === input.reservedForJson && canonicalJson(version.releasePolicy) === input.releasePolicyJson
    && (original.effectiveFrom === undefined || version.effectiveFrom === input.effectiveFrom)
    && (original.effectiveTo === undefined || version.effectiveTo === input.effectiveTo);
}

function appendCommandFingerprint(input: {
  workspaceId: string; eventId: string; poolId: string; idempotencyKey: string;
  versionId: string | null; expectedVersionNumber: number | null; docs: ReturnType<typeof definitionDocuments>;
}): string {
  return fingerprintOf({
    schema: "pd01-capacity-pool-append-command/v1", workspaceId: input.workspaceId, eventId: input.eventId,
    poolId: input.poolId, idempotencyKey: input.idempotencyKey, versionId: input.versionId,
    expectedVersionNumber: input.expectedVersionNumber, unitKind: input.docs.unitKind, capacity: input.docs.capacity,
    scope: input.docs.scope, eligibility: input.docs.eligibility, reservedFor: input.docs.reservedFor,
    releasePolicy: input.docs.releasePolicy, effectiveFrom: input.docs.effectiveFrom, effectiveTo: input.docs.effectiveTo,
  });
}

function appendCommandTargetId(actorAccountId: string, idempotencyKey: string): string {
  return deterministicUuid(`pd01-capacity-pool-append-command:${actorAccountId}:${idempotencyKey}`);
}

function priorAppend(db: Db, workspaceId: string, actorAccountId: string, idempotencyKey: string):
  { versionId: string; versionNumber: number; versionFingerprint: string; commandFingerprint: string; eventId: string; poolId: string; idempotencyKey: string } | undefined {
  const targetId = appendCommandTargetId(actorAccountId, idempotencyKey);
  const rows = db.prepare(`SELECT actor_kind AS actorKind, actor_ref AS actorRef, action, target_type AS targetType,
      target_id AS targetId, details_json AS detailsJson FROM audit_events WHERE workspace_id = ? AND target_id = ? ORDER BY rowid`)
    .all(workspaceId, targetId) as Array<{ actorKind: string; actorRef: string; action: string; targetType: string; targetId: string; detailsJson: string | null }>;
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) fail("CAPACITY_APPEND_CORRUPT");
  const row = rows[0];
  const details = parseCanonicalAuditObject(row.detailsJson);
  if (row.actorKind !== "account" || row.actorRef !== actorAccountId || row.action !== "capacity.pool.version.appended"
    || row.targetType !== "capacity_pool_append_command" || row.targetId !== targetId) fail("CAPACITY_APPEND_CORRUPT");
  const expectedKeys = ["commandFingerprint", "eventId", "fingerprint", "idempotencyKey", "poolId", "versionId", "versionNumber"];
  const versionNumber = details.versionNumber;
  if (Object.keys(details).sort().join("\u0000") !== expectedKeys.join("\u0000")
    || details.idempotencyKey !== idempotencyKey || typeof details.eventId !== "string" || typeof details.poolId !== "string"
    || typeof details.versionId !== "string" || typeof details.commandFingerprint !== "string"
    || typeof details.fingerprint !== "string") {
    fail("CAPACITY_APPEND_CORRUPT");
  }
  if (typeof versionNumber !== "number" || !Number.isSafeInteger(versionNumber) || versionNumber < 2) fail("CAPACITY_APPEND_CORRUPT");
  return {
    versionId: details.versionId, versionNumber, versionFingerprint: details.fingerprint,
    commandFingerprint: details.commandFingerprint, eventId: details.eventId, poolId: details.poolId,
    idempotencyKey: details.idempotencyKey,
  };
}

export function createProgramCapacityPool(
  db: Db,
  session: SessionInfo,
  eventId: string,
  input: CapacityPoolDefinitionInput,
): CreateCapacityPoolResult {
  const capturedSession = captureSession(session);
  const capturedEventId = captureEventId(eventId);
  const capturedInput = captureCreateInput(input);
  return withAuthorizedMutation(db, "capacity_create_pool", capturedSession, () => {
    authorize(db, capturedSession);
    assertEvent(db, capturedSession, capturedEventId);
    const docs = definitionDocuments(capturedInput);
    const name = stringValue(capturedInput.name, "name", 1, 256);
    const poolId = capturedInput.poolId ?? deterministicUuid(`pd01-capacity-pool:${capturedSession.workspaceId}:${capturedEventId}:${name}`);
    idValue(poolId, "pool_id");
    const existing = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId, unit_kind AS unitKind,
      name, created_at AS createdAt, archived_at AS archivedAt FROM program_capacity_pools
      WHERE workspace_id = ? AND event_id = ? AND id = ?`).get(capturedSession.workspaceId, capturedEventId, poolId) as PoolRow | undefined;
    if (existing) {
      if (existing.name !== name || existing.unitKind !== docs.unitKind) fail("POOL_COMMAND_CONFLICT");
      const version = versionById(db, capturedSession, capturedEventId, poolId,
        (db.prepare("SELECT id FROM program_capacity_pool_versions WHERE workspace_id = ? AND event_id = ? AND pool_id = ? AND version_number = 1")
          .get(capturedSession.workspaceId, capturedEventId, poolId) as { id: string } | undefined)?.id ?? "");
      if (version.versionNumber !== 1 || !existingDefinitionMatches(version, docs, capturedInput)) fail("POOL_COMMAND_CONFLICT");
      return deepFreeze({ pool: { ...existing, currentVersion: version }, version, created: false });
    }
    const createdAt = nowIso();
    const versionId = capturedInput.versionId ?? deterministicUuid(`pd01-capacity-pool-version:${poolId}:1`);
    idValue(versionId, "version_id");
    const fingerprint = poolVersionFingerprint({ workspaceId: capturedSession.workspaceId, eventId: capturedEventId, poolId, versionNumber: 1,
      unitKind: docs.unitKind, capacity: docs.capacity, scope: docs.scope, eligibility: docs.eligibility,
      reservedFor: docs.reservedFor, releasePolicy: docs.releasePolicy, effectiveFrom: docs.effectiveFrom,
      effectiveTo: docs.effectiveTo, createdAt });
    db.prepare(`INSERT INTO program_capacity_pools (id, workspace_id, event_id, unit_kind, name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(poolId, capturedSession.workspaceId, capturedEventId, docs.unitKind, name, createdAt);
    db.prepare(`INSERT INTO program_capacity_pool_versions
      (id, workspace_id, event_id, pool_id, version_number, unit_kind, capacity, scope_json,
       eligibility_json, reserved_for_json, release_policy_json, effective_from, effective_to, fingerprint, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      versionId, capturedSession.workspaceId, capturedEventId, poolId, docs.unitKind, docs.capacity, docs.scopeJson,
      docs.eligibilityJson, docs.reservedForJson, docs.releasePolicyJson, docs.effectiveFrom,
      docs.effectiveTo, fingerprint, createdAt);
    writeAudit(db, capturedSession.workspaceId, { actorKind: "account", actorRef: capturedSession.accountId,
      action: "capacity.pool.created", targetType: "capacity_pool", targetId: poolId,
      details: canonicalAuditDetails({ eventId, poolId, versionId, versionNumber: 1, unitKind: docs.unitKind, capacity: docs.capacity, fingerprint }) });
    const version = versionById(db, capturedSession, capturedEventId, poolId, versionId);
    return deepFreeze({ pool: poolWithVersion(db, capturedSession, capturedEventId, poolId, version), version, created: true });
  });
}

export function appendProgramCapacityPoolVersion(
  db: Db,
  session: SessionInfo,
  eventId: string,
  input: AppendCapacityPoolVersionInput,
): AppendCapacityPoolVersionResult {
  const capturedSession = captureSession(session);
  const capturedEventId = captureEventId(eventId);
  const capturedInput = captureAppendInput(input);
  return withAuthorizedMutation(db, "capacity_append_version", capturedSession, () => {
    authorize(db, capturedSession);
    assertEvent(db, capturedSession, capturedEventId);
    const event = db.prepare("SELECT starts_at AS startsAt FROM events WHERE id = ? AND workspace_id = ?")
      .get(capturedEventId, capturedSession.workspaceId) as { startsAt: string } | undefined;
    if (!event) fail("EVENT_NOT_FOUND");
    const pool = poolRow(db, capturedSession, capturedEventId, capturePoolId(capturedInput.poolId));
    const idempotencyKey = stringValue(capturedInput.idempotencyKey, "idempotency_key", 1, 128);
    const previous = latestVersion(db, capturedSession, capturedEventId, pool.id);
    const docs = definitionDocuments({ ...capturedInput, unitKind: pool.unitKind, effectiveFrom: capturedInput.effectiveFrom ?? event.startsAt });
    if (!Number.isSafeInteger(previous.versionNumber) || previous.versionNumber >= SQLITE_SAFE_INTEGER) fail("CAPACITY_VERSION_CORRUPT");
    const nextVersion = safeAdd(previous.versionNumber, 1, "CAPACITY_VERSION_CORRUPT");
    if (docs.unitKind !== pool.unitKind) fail("POOL_UNIT_MISMATCH");
    const commandFingerprint = appendCommandFingerprint({ workspaceId: capturedSession.workspaceId, eventId: capturedEventId,
      poolId: pool.id, idempotencyKey, versionId: capturedInput.versionId ?? null,
      expectedVersionNumber: capturedInput.expectedVersionNumber ?? null, docs });
    const replay = priorAppend(db, capturedSession.workspaceId, capturedSession.accountId, idempotencyKey);
    if (replay) {
      if (replay.commandFingerprint !== commandFingerprint) fail("APPEND_IDEMPOTENCY_KEY_REUSE_CONFLICT");
      if (replay.eventId !== capturedEventId || replay.poolId !== pool.id) fail("APPEND_IDEMPOTENCY_KEY_REUSE_CONFLICT");
      const version = versionById(db, capturedSession, capturedEventId, pool.id, replay.versionId);
      if (version.versionNumber !== replay.versionNumber || version.fingerprint !== replay.versionFingerprint) fail("CAPACITY_APPEND_CORRUPT");
      return deepFreeze({ pool: poolWithVersion(db, capturedSession, capturedEventId, pool.id, version), version, created: false });
    }
    if (capturedInput.expectedVersionNumber !== undefined && capturedInput.expectedVersionNumber !== previous.versionNumber) fail("STALE_POOL_VERSION");
    if (db.prepare("SELECT 1 FROM capacity_transfer_decisions WHERE workspace_id = ? AND event_id = ? AND (source_pool_id = ? OR destination_pool_id = ?) LIMIT 1")
      .get(capturedSession.workspaceId, capturedEventId, pool.id, pool.id)) fail("POOL_VERSION_APPEND_AFTER_TRANSFER");
    const candidateId = capturedInput.versionId ?? deterministicUuid(`pd01-capacity-pool-version:${pool.id}:${nextVersion}:${idempotencyKey}`);
    idValue(candidateId, "version_id");
    const existing = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId, pool_id AS poolId,
      version_number AS versionNumber, unit_kind AS unitKind, capacity, scope_json AS scopeJson,
      eligibility_json AS eligibilityJson, reserved_for_json AS reservedForJson, release_policy_json AS releasePolicyJson,
      effective_from AS effectiveFrom, effective_to AS effectiveTo, fingerprint, created_at AS createdAt
      FROM program_capacity_pool_versions WHERE workspace_id = ? AND event_id = ? AND id = ?`)
      .get(capturedSession.workspaceId, capturedEventId, candidateId) as VersionRow | undefined;
    if (existing) {
      fail("POOL_VERSION_COMMAND_CONFLICT");
    }
    const createdAt = nowIso();
    const fingerprint = poolVersionFingerprint({ workspaceId: capturedSession.workspaceId, eventId: capturedEventId, poolId: pool.id,
      versionNumber: nextVersion, unitKind: docs.unitKind, capacity: docs.capacity, scope: docs.scope,
      eligibility: docs.eligibility, reservedFor: docs.reservedFor, releasePolicy: docs.releasePolicy,
      effectiveFrom: docs.effectiveFrom, effectiveTo: docs.effectiveTo, createdAt });
    db.prepare(`INSERT INTO program_capacity_pool_versions
      (id, workspace_id, event_id, pool_id, version_number, unit_kind, capacity, scope_json,
       eligibility_json, reserved_for_json, release_policy_json, effective_from, effective_to, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      candidateId, capturedSession.workspaceId, capturedEventId, pool.id, nextVersion, docs.unitKind, docs.capacity, docs.scopeJson,
      docs.eligibilityJson, docs.reservedForJson, docs.releasePolicyJson, docs.effectiveFrom, docs.effectiveTo, fingerprint, createdAt);
    writeAudit(db, capturedSession.workspaceId, { actorKind: "account", actorRef: capturedSession.accountId,
      action: "capacity.pool.version.appended", targetType: "capacity_pool_append_command",
      targetId: appendCommandTargetId(capturedSession.accountId, idempotencyKey),
      details: canonicalAuditDetails({ eventId: capturedEventId, poolId: pool.id, versionId: candidateId,
        versionNumber: nextVersion, fingerprint, idempotencyKey, commandFingerprint }) });
    const version = versionById(db, capturedSession, capturedEventId, pool.id, candidateId);
    return deepFreeze({ pool: poolWithVersion(db, capturedSession, capturedEventId, pool.id, version), version, created: true });
  });
}

function normalizedTransfer(input: CapacityTransferInput): CapacityTransferInput & { sourceVersionId: string | undefined; destinationVersionId: string | undefined } {
  const sourceVersionId = input.sourcePoolVersionId ?? input.sourceVersionId;
  const destinationVersionId = input.destinationPoolVersionId ?? input.destinationVersionId;
  if (input.sourcePoolVersionId && input.sourceVersionId && input.sourcePoolVersionId !== input.sourceVersionId) fail("POOL_VERSION_COMMAND_CONFLICT");
  if (input.destinationPoolVersionId && input.destinationVersionId && input.destinationPoolVersionId !== input.destinationVersionId) fail("POOL_VERSION_COMMAND_CONFLICT");
  return { ...input, sourceVersionId, destinationVersionId };
}

function releasePermitted(policy: CapacityJson): boolean {
  if (policy === true) return true;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return false;
  const record = policy as Record<string, unknown>;
  return record.allowUnsoldRelease === true || record.releaseUnsold === true || record.allowRelease === true
    || record.unsold === true
    || [record.kind, record.mode, record.type, record.action, record.releaseMode, record.policy].some((value) => typeof value === "string"
      && ["RELEASE_UNSOLD", "release-unsold", "unsold-release", "UNSOLD", "unsold"].includes(value));
}

function transferCore(db: Db, session: SessionInfo, eventId: string, rawInput: CapacityTransferInput, operation: "transfer" | "release"): CapacityTransferResult {
  const input = normalizedTransfer(rawInput);
  const sourcePoolId = idValue(input.sourcePoolId, "source_pool_id");
  const destinationPoolId = idValue(input.destinationPoolId, "destination_pool_id");
  if (sourcePoolId === destinationPoolId) fail("SAME_POOL_ROOT");
  const unitKind = stringValue(input.unitKind, "unit_kind", 1, 128);
  const quantity = integerValue(input.quantity, "quantity", 1);
  const reason = stringValue(input.reason, "reason", 1, 4096);
  const approvalReference = stringValue(input.approvalReference, "approval_reference", 1, 256);
  const idempotencyKey = stringValue(input.idempotencyKey, "idempotency_key", 1, 128);
  const expectedSequence = input.expectedSequenceNumber ?? input.expectedSequence;
  if (expectedSequence !== undefined) integerValue(expectedSequence, "expected_sequence", 0);
  if (input.expectedLedgerFingerprint !== undefined && !/^[0-9a-f]{64}$/u.test(input.expectedLedgerFingerprint)) fail("INVALID_EXPECTED_LEDGER_FINGERPRINT");

  return withAuthorizedMutation(db, operation === "release" ? "capacity_release" : "capacity_transfer", session, () => {
    authorize(db, session);
    assertEvent(db, session, eventId);
    const existing = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId, sequence_number AS sequenceNumber,
      source_pool_id AS sourcePoolId, source_pool_version_id AS sourcePoolVersionId, destination_pool_id AS destinationPoolId,
      destination_pool_version_id AS destinationPoolVersionId, unit_kind AS unitKind, quantity, source_before AS sourceBefore,
      source_after AS sourceAfter, destination_before AS destinationBefore, destination_after AS destinationAfter,
      actor_account_id AS actorAccountId, reason, approval_reference AS approvalReference, decided_at AS decidedAt,
      idempotency_key AS idempotencyKey, fingerprint FROM capacity_transfer_decisions
      WHERE workspace_id = ? AND actor_account_id = ? AND idempotency_key = ?`)
      .get(session.workspaceId, session.accountId, idempotencyKey) as DecisionRow | undefined;
    if (existing) {
      const storedOperation = canonicalDecisionOperation(db, session, existing);
      if (storedOperation !== operation) fail("IDEMPOTENCY_KEY_REUSE_CONFLICT");
      if (existing.eventId !== eventId || existing.sourcePoolId !== sourcePoolId || existing.sourcePoolVersionId !== (input.sourceVersionId ?? existing.sourcePoolVersionId)
        || existing.destinationPoolId !== destinationPoolId || existing.destinationPoolVersionId !== (input.destinationVersionId ?? existing.destinationPoolVersionId)
        || existing.unitKind !== unitKind || existing.quantity !== quantity || existing.reason !== reason || existing.approvalReference !== approvalReference) {
        fail("IDEMPOTENCY_KEY_REUSE_CONFLICT");
      }
      const ledger = computeLedger(db, session, eventId);
      const receipt = readReceipt(db, session, existing);
      return deepFreeze({ decisionId: existing.id, receipt, ledger, created: false, replayed: true, operation: storedOperation });
    }

    const ledger = computeLedger(db, session, eventId);
    if (expectedSequence !== undefined && expectedSequence !== ledger.sequenceNumber) fail("STALE_LEDGER");
    if (input.expectedLedgerFingerprint !== undefined && input.expectedLedgerFingerprint !== ledger.ledgerFingerprint) fail("STALE_LEDGER");
    const sourceEntry = ledger.pools.find((pool) => pool.poolId === sourcePoolId);
    const destinationEntry = ledger.pools.find((pool) => pool.poolId === destinationPoolId);
    if (!sourceEntry || !destinationEntry) fail("POOL_NOT_FOUND");
    if (sourceEntry.unitKind !== unitKind || destinationEntry.unitKind !== unitKind) fail("UNIT_KIND_MISMATCH");
    const sourceVersionId = input.sourceVersionId ?? sourceEntry.versionId;
    const destinationVersionId = input.destinationVersionId ?? destinationEntry.versionId;
    if (sourceVersionId !== sourceEntry.versionId || destinationVersionId !== destinationEntry.versionId) fail("POOL_VERSION_STALE");
    const sourceVersion = versionById(db, session, eventId, sourcePoolId, sourceVersionId);
    if (operation === "release" && !releasePermitted(sourceVersion.releasePolicy)) fail("RELEASE_POLICY_DENIED");
    versionById(db, session, eventId, destinationPoolId, destinationVersionId);
    if (sourceEntry.remaining < quantity) fail("CAPACITY_OVERDRAFT");
    const sequenceNumber = safeAdd(ledger.sequenceNumber, 1, "CAPACITY_ARITHMETIC_OVERFLOW");
    const sourceBefore = sourceEntry.remaining;
    const destinationBefore = destinationEntry.remaining;
    const sourceAfter = safeSubtract(sourceBefore, quantity, "CAPACITY_ARITHMETIC_OVERFLOW");
    const destinationAfter = safeAdd(destinationBefore, quantity, "CAPACITY_ARITHMETIC_OVERFLOW");
    const decidedAt = nowIso();
    const decisionId = uuid();
    const fingerprint = transferFingerprint({ workspaceId: session.workspaceId, eventId, sequenceNumber,
      sourcePoolId, sourcePoolVersionId: sourceVersionId, destinationPoolId,
      destinationPoolVersionId: destinationVersionId, unitKind, quantity, sourceBefore, sourceAfter,
      destinationBefore, destinationAfter, actorAccountId: session.accountId, reason, approvalReference,
      decidedAt, idempotencyKey });
    db.prepare(`INSERT INTO capacity_transfer_decisions
      (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
       destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before, source_after,
       destination_before, destination_after, actor_account_id, reason, approval_reference, decided_at,
       idempotency_key, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      decisionId, session.workspaceId, eventId, sequenceNumber, sourcePoolId, sourceVersionId,
      destinationPoolId, destinationVersionId, unitKind, quantity, sourceBefore, sourceAfter,
      destinationBefore, destinationAfter, session.accountId, reason, approvalReference, decidedAt,
      idempotencyKey, fingerprint);
    writeAudit(db, session.workspaceId, { actorKind: "account", actorRef: session.accountId,
      action: operation === "release" ? "capacity.release.decided" : "capacity.transfer.decided",
      targetType: "capacity_transfer_decision", targetId: decisionId,
      details: canonicalAuditDetails({ eventId, sequenceNumber, sourcePoolId, sourcePoolVersionId: sourceVersionId,
        destinationPoolId, destinationPoolVersionId: destinationVersionId, unitKind, quantity, sourceBefore, sourceAfter,
        destinationBefore, destinationAfter, actorAccountId: session.accountId, reason, approvalReference,
        idempotencyKey, fingerprint, operation }) });
    const inserted = db.prepare(`SELECT id, workspace_id AS workspaceId, event_id AS eventId, sequence_number AS sequenceNumber,
      source_pool_id AS sourcePoolId, source_pool_version_id AS sourcePoolVersionId, destination_pool_id AS destinationPoolId,
      destination_pool_version_id AS destinationPoolVersionId, unit_kind AS unitKind, quantity, source_before AS sourceBefore,
      source_after AS sourceAfter, destination_before AS destinationBefore, destination_after AS destinationAfter,
      actor_account_id AS actorAccountId, reason, approval_reference AS approvalReference, decided_at AS decidedAt,
      idempotency_key AS idempotencyKey, fingerprint FROM capacity_transfer_decisions WHERE id = ?`).get(decisionId) as DecisionRow;
    const receipt = readReceipt(db, session, inserted);
    const nextLedger = computeLedger(db, session, eventId);
    return deepFreeze({ decisionId, receipt, ledger: nextLedger, created: true, replayed: false, operation });
  });
}

function readReceipt(db: Db, session: SessionInfo, decision: DecisionRow): CapacityTransferReceipt {
  const row = db.prepare(`SELECT id AS receiptId, decision_id AS decisionId, workspace_id AS workspaceId, event_id AS eventId,
      sequence_number AS sequenceNumber, source_pool_id AS sourcePoolId, source_pool_version_id AS sourcePoolVersionId,
      destination_pool_id AS destinationPoolId, destination_pool_version_id AS destinationPoolVersionId, unit_kind AS unitKind,
      quantity, source_before AS sourceBefore, source_after AS sourceAfter, destination_before AS destinationBefore,
      destination_after AS destinationAfter, recorded_at AS recordedAt, fingerprint FROM capacity_transfer_receipts
      WHERE workspace_id = ? AND decision_id = ?`).get(session.workspaceId, decision.id) as CapacityTransferReceipt | undefined;
  if (!row || row.receiptId !== `receipt:${decision.id}` || row.eventId !== decision.eventId || row.sequenceNumber !== decision.sequenceNumber
    || row.sourcePoolId !== decision.sourcePoolId || row.sourcePoolVersionId !== decision.sourcePoolVersionId
    || row.destinationPoolId !== decision.destinationPoolId || row.destinationPoolVersionId !== decision.destinationPoolVersionId
    || row.unitKind !== decision.unitKind || row.quantity !== decision.quantity || row.sourceBefore !== decision.sourceBefore
    || row.sourceAfter !== decision.sourceAfter || row.destinationBefore !== decision.destinationBefore
    || row.destinationAfter !== decision.destinationAfter || row.recordedAt !== decision.decidedAt || row.fingerprint !== decision.fingerprint) {
    fail("CAPACITY_RECEIPT_CORRUPT");
  }
  return deepFreeze(row);
}

export function transferProgramCapacity(db: Db, session: SessionInfo, eventId: string, input: CapacityTransferInput): CapacityTransferResult {
  const capturedSession = captureSession(session);
  const capturedEventId = captureEventId(eventId);
  const capturedInput = captureTransferInput(input);
  return transferCore(db, capturedSession, capturedEventId, capturedInput, "transfer");
}

export function releaseProgramCapacity(db: Db, session: SessionInfo, eventId: string, input: CapacityTransferInput): CapacityTransferResult {
  const capturedSession = captureSession(session);
  const capturedEventId = captureEventId(eventId);
  const capturedInput = captureTransferInput(input);
  return transferCore(db, capturedSession, capturedEventId, capturedInput, "release");
}

export function getProgramCapacityLedger(db: Db, session: SessionInfo, eventId: string): CapacityLedger {
  const capturedSession = captureSession(session);
  const capturedEventId = captureEventId(eventId);
  authorize(db, capturedSession);
  return computeLedger(db, capturedSession, capturedEventId);
}

export function listProgramCapacityPools(db: Db, session: SessionInfo, eventId: string): CapacityPool[] {
  const capturedSession = captureSession(session);
  const capturedEventId = captureEventId(eventId);
  authorize(db, capturedSession);
  assertEvent(db, capturedSession, capturedEventId);
  computeLedger(db, capturedSession, capturedEventId);
  return deepFreeze((db.prepare("SELECT id FROM program_capacity_pools WHERE workspace_id = ? AND event_id = ? ORDER BY id")
    .all(capturedSession.workspaceId, capturedEventId) as Array<{ id: string }>).map(({ id }) => poolWithVersion(db, capturedSession, capturedEventId, id)));
}

export function getProgramCapacityPoolLedger(
  db: Db,
  session: SessionInfo,
  eventId: string,
  poolId: string,
): CapacityLedgerEntry {
  const capturedSession = captureSession(session);
  const capturedEventId = captureEventId(eventId);
  const capturedPoolId = capturePoolId(poolId);
  authorize(db, capturedSession);
  const ledger = computeLedger(db, capturedSession, capturedEventId);
  const entry = ledger.pools.find((pool) => pool.poolId === capturedPoolId);
  if (!entry) fail("POOL_NOT_FOUND");
  return entry;
}

export function listProgramCapacityTransferHistory(db: Db, session: SessionInfo, eventId: string, poolId?: string): CapacityTransferHistoryEntry[] {
  const capturedSession = captureSession(session);
  const capturedEventId = captureEventId(eventId);
  const capturedPoolId = poolId === undefined ? undefined : capturePoolId(poolId);
  authorize(db, capturedSession);
  computeLedger(db, capturedSession, capturedEventId);
  const rows = db.prepare(`SELECT d.id, d.workspace_id AS workspaceId, d.event_id AS eventId, d.sequence_number AS sequenceNumber,
      d.source_pool_id AS sourcePoolId, d.source_pool_version_id AS sourcePoolVersionId, d.destination_pool_id AS destinationPoolId,
      d.destination_pool_version_id AS destinationPoolVersionId, d.unit_kind AS unitKind, d.quantity,
      d.source_before AS sourceBefore, d.source_after AS sourceAfter, d.destination_before AS destinationBefore,
      d.destination_after AS destinationAfter, d.actor_account_id AS actorAccountId, d.reason,
      d.approval_reference AS approvalReference, d.decided_at AS decidedAt, d.idempotency_key AS idempotencyKey,
      d.fingerprint, r.id AS receiptId, r.recorded_at AS recordedAt
      FROM capacity_transfer_decisions d JOIN capacity_transfer_receipts r
        ON r.workspace_id = d.workspace_id AND r.event_id = d.event_id AND r.decision_id = d.id
      WHERE d.workspace_id = ? AND d.event_id = ? ${capturedPoolId === undefined ? "" : "AND (d.source_pool_id = ? OR d.destination_pool_id = ?)"}
      ORDER BY d.sequence_number`).all(...(capturedPoolId === undefined ? [capturedSession.workspaceId, capturedEventId] : [capturedSession.workspaceId, capturedEventId, capturedPoolId, capturedPoolId])) as Array<DecisionRow & { receiptId: string; recordedAt: string }>;
  return deepFreeze(rows.map((row) => {
    const receipt = readReceipt(db, capturedSession, row);
    return { ...receipt, actorAccountId: row.actorAccountId, reason: row.reason, approvalReference: row.approvalReference,
      decidedAt: row.decidedAt, idempotencyKey: row.idempotencyKey,
      operation: releaseOperation(db, capturedSession, row.id) };
  }));
}

function surfaceProjectionFail(
  code: "CAPACITY_SURFACE_OVERFLOW" | "CAPACITY_SURFACE_INTEGRITY",
  message: string,
): never {
  throw new CapacitySurfaceProjectionError(code, message);
}

/**
 * Read-only UI seam. The bounded identifier probes run before any pool/history
 * materialization, then all three families are read under one transaction or
 * savepoint and checked against the same ledger sequence and workspace/event.
 */
export function getProgramCapacitySurfaceProjection(
  db: Db,
  session: SessionInfo,
  eventId: string,
): ProgramCapacitySurfaceProjection {
  const capturedSession = captureSession(session);
  const capturedEventId = captureEventId(eventId);
  return withTransactionOrSavepoint(db, "capacity_surface_projection", () => {
    authorize(db, capturedSession);
    assertEvent(db, capturedSession, capturedEventId);

    const poolIds = db.prepare(`SELECT id FROM program_capacity_pools
      WHERE workspace_id = ? AND event_id = ? ORDER BY id LIMIT ?`)
      .all(capturedSession.workspaceId, capturedEventId, CAPACITY_SURFACE_POOL_LIMIT + 1) as Array<{ id: string }>;
    if (poolIds.length > CAPACITY_SURFACE_POOL_LIMIT) {
      surfaceProjectionFail("CAPACITY_SURFACE_OVERFLOW", "too many capacity pools for one UI projection");
    }

    const versionIds = db.prepare(`SELECT id FROM program_capacity_pool_versions
      WHERE workspace_id = ? AND event_id = ? ORDER BY pool_id, version_number LIMIT ?`)
      .all(capturedSession.workspaceId, capturedEventId, CAPACITY_SURFACE_VERSION_LIMIT + 1) as Array<{ id: string }>;
    if (versionIds.length > CAPACITY_SURFACE_VERSION_LIMIT) {
      surfaceProjectionFail("CAPACITY_SURFACE_OVERFLOW", "too many immutable pool versions for one UI projection");
    }

    const decisionIds = db.prepare(`SELECT id FROM capacity_transfer_decisions
      WHERE workspace_id = ? AND event_id = ? ORDER BY sequence_number LIMIT ?`)
      .all(capturedSession.workspaceId, capturedEventId, CAPACITY_SURFACE_HISTORY_LIMIT + 1) as Array<{ id: string }>;
    if (decisionIds.length > CAPACITY_SURFACE_HISTORY_LIMIT) {
      surfaceProjectionFail("CAPACITY_SURFACE_OVERFLOW", "too many capacity decisions for one UI projection");
    }

    const historyRows = db.prepare(`SELECT d.id, d.workspace_id AS workspaceId, d.event_id AS eventId,
        d.sequence_number AS sequenceNumber, d.source_pool_id AS sourcePoolId,
        d.source_pool_version_id AS sourcePoolVersionId, d.destination_pool_id AS destinationPoolId,
        d.destination_pool_version_id AS destinationPoolVersionId, d.unit_kind AS unitKind, d.quantity,
        d.source_before AS sourceBefore, d.source_after AS sourceAfter,
        d.destination_before AS destinationBefore, d.destination_after AS destinationAfter,
        d.actor_account_id AS actorAccountId, d.reason, d.approval_reference AS approvalReference,
        d.decided_at AS decidedAt, d.idempotency_key AS idempotencyKey, d.fingerprint,
        r.id AS receiptId, r.recorded_at AS recordedAt
        FROM capacity_transfer_decisions d JOIN capacity_transfer_receipts r
          ON r.workspace_id = d.workspace_id AND r.event_id = d.event_id AND r.decision_id = d.id
        WHERE d.workspace_id = ? AND d.event_id = ?
        ORDER BY d.sequence_number LIMIT ?`)
      .all(capturedSession.workspaceId, capturedEventId, CAPACITY_SURFACE_HISTORY_LIMIT + 1) as Array<DecisionRow & { receiptId: string; recordedAt: string }>;
    if (historyRows.length > CAPACITY_SURFACE_HISTORY_LIMIT) {
      surfaceProjectionFail("CAPACITY_SURFACE_OVERFLOW", "too many capacity receipts for one UI projection");
    }

    const ledger = computeLedger(db, capturedSession, capturedEventId);
    const pools = poolIds.map(({ id }) => poolWithVersion(db, capturedSession, capturedEventId, id));
    const history = historyRows.map((row) => {
      const receipt = readReceipt(db, capturedSession, row);
      return deepFreeze({ ...receipt, actorAccountId: row.actorAccountId, reason: row.reason,
        approvalReference: row.approvalReference, decidedAt: row.decidedAt,
        idempotencyKey: row.idempotencyKey, operation: releaseOperation(db, capturedSession, row.id) });
    });

    if (history.length !== ledger.sequenceNumber
      || history.some((entry, index) => entry.sequenceNumber !== index + 1)
      || pools.length !== ledger.pools.length
      || pools.some((pool) => pool.workspaceId !== capturedSession.workspaceId || pool.eventId !== capturedEventId)
      || history.some((entry) => entry.workspaceId !== capturedSession.workspaceId || entry.eventId !== capturedEventId)) {
      surfaceProjectionFail("CAPACITY_SURFACE_INTEGRITY", "ledger, pool, and receipt families disagree");
    }

    const poolIdsById = new Set(pools.map((pool) => pool.id));
    const knownVersionIds = new Set(versionIds.map(({ id }) => id));
    if (history.some((entry) => !poolIdsById.has(entry.sourcePoolId)
      || !poolIdsById.has(entry.destinationPoolId)
      || !knownVersionIds.has(entry.sourcePoolVersionId)
      || !knownVersionIds.has(entry.destinationPoolVersionId))) {
      surfaceProjectionFail("CAPACITY_SURFACE_INTEGRITY", "receipt source versions do not match pool definitions");
    }

    return deepFreeze({ ledger, pools, history });
  });
}

function releaseOperation(db: Db, session: SessionInfo, decisionId: string): "transfer" | "release" {
  const decision = db.prepare(`SELECT id, event_id AS eventId, workspace_id AS workspaceId, sequence_number AS sequenceNumber,
      source_pool_id AS sourcePoolId, source_pool_version_id AS sourcePoolVersionId, destination_pool_id AS destinationPoolId,
      destination_pool_version_id AS destinationPoolVersionId, unit_kind AS unitKind, quantity,
      source_before AS sourceBefore, source_after AS sourceAfter, destination_before AS destinationBefore,
      destination_after AS destinationAfter, actor_account_id AS actorAccountId, reason, approval_reference AS approvalReference,
      decided_at AS decidedAt, idempotency_key AS idempotencyKey, fingerprint
      FROM capacity_transfer_decisions WHERE workspace_id = ? AND id = ?`).get(session.workspaceId, decisionId) as DecisionRow | undefined;
  if (!decision) fail("CAPACITY_AUDIT_CORRUPT");
  return canonicalDecisionOperation(db, session, decision);
}

// Short aliases keep the service convenient for callers while the explicit names document the domain boundary.
export const createCapacityPool = createProgramCapacityPool;
export const appendCapacityPoolVersion = appendProgramCapacityPoolVersion;
export const transferCapacity = transferProgramCapacity;
export const releaseCapacity = releaseProgramCapacity;
export const getCapacityLedger = getProgramCapacityLedger;
export const getPoolLedger = getProgramCapacityPoolLedger;
export const listCapacityPools = listProgramCapacityPools;
export const listCapacityTransferHistory = listProgramCapacityTransferHistory;
