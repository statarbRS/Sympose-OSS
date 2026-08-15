import type { SessionInfo } from "../../auth";
import { canonicalJson, deterministicUuid, fingerprintOf, nowIso } from "../../canonical";
import { withTransaction, type Db } from "../../db";
import {
  V17_PUBLICATION_AUDIENCE_POLICY_SCHEMA,
  V17_PUBLICATION_AUDIENCE_RECEIPT_SCHEMA,
  V17_PUBLICATION_AUDIENCE_REQUEST_SCHEMA,
} from "../../schema";
import { validatePublicReleaseForRead, type ValidatedPublicRelease } from "../publication";

const ORGANIZER_ROLES = new Set([
  "organizer",
  "workspace_admin",
  "event_manager",
  "program_manager",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CHANNEL_KEY = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const LABEL_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/u;

export type PublicationAudiencePurpose =
  | "EVENT_AGENDA"
  | "PERSONAL_AGENDA"
  | "SPEAKER_PORTAL"
  | "EMBED";
export type PublicationAudienceKind = "PUBLIC" | "ATTENDEE" | "SPEAKER" | "ORGANIZER";
export type PublicationAudienceVisibility = "PUBLIC" | "TOKEN" | "AUTHENTICATED";
export type PublicationAudiencePolicyRule =
  | "PUBLIC_SCHEDULE"
  | "ACCEPTED_AGENDAS"
  | "SPEAKER_PORTAL";
export type PublicationAudienceReceiptAction =
  | "CHANNEL_CREATED"
  | "CHANNEL_DISABLED"
  | "POLICY_DRAFTED"
  | "POLICY_SUPERSEDED"
  | "RELEASE_BOUND"
  | "BINDING_DISABLED";
export type PublicationAudienceMatrixStatus =
  | "CURRENT"
  | "SUPERSEDED"
  | "BLOCKED"
  | "UNAVAILABLE";

export type PublicationAudienceServiceErrorCode =
  | "INPUT_INVALID"
  | "ACCESS_DENIED"
  | "EVENT_NOT_AVAILABLE"
  | "CHANNEL_NOT_AVAILABLE"
  | "CHANNEL_DISABLED"
  | "POLICY_NOT_AVAILABLE"
  | "POLICY_SUPERSEDED"
  | "RELEASE_UNAVAILABLE"
  | "RELEASE_MISMATCH"
  | "BINDING_NOT_AVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "COMMAND_CONFLICT"
  | "OUTER_TRANSACTION_DENIED"
  | "WRITE_FAILED";

const ERROR_MESSAGES: Readonly<Record<PublicationAudienceServiceErrorCode, string>> = {
  INPUT_INVALID: "The publication audience request is invalid.",
  ACCESS_DENIED: "Publication audience controls are unavailable for this account.",
  EVENT_NOT_AVAILABLE: "The publication event is unavailable.",
  CHANNEL_NOT_AVAILABLE: "The audience channel is unavailable.",
  CHANNEL_DISABLED: "The audience channel is disabled.",
  POLICY_NOT_AVAILABLE: "The audience policy version is unavailable.",
  POLICY_SUPERSEDED: "The audience policy version has been superseded.",
  RELEASE_UNAVAILABLE: "A validated current immutable release is unavailable.",
  RELEASE_MISMATCH: "The current immutable release no longer matches the expected release evidence.",
  BINDING_NOT_AVAILABLE: "The exact audience binding is unavailable.",
  IDEMPOTENCY_CONFLICT: "The idempotency key was already used for a different audience command.",
  COMMAND_CONFLICT: "The publication audience command conflicts with retained history.",
  OUTER_TRANSACTION_DENIED: "Publication audience writes require an owned transaction boundary.",
  WRITE_FAILED: "The publication audience command could not be saved safely.",
};

export class PublicationAudienceServiceError extends Error {
  readonly code: PublicationAudienceServiceErrorCode;

  constructor(code: PublicationAudienceServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PublicationAudienceServiceError";
    this.code = code;
  }
}

function fail(code: PublicationAudienceServiceErrorCode): never {
  throw new PublicationAudienceServiceError(code);
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).sort().join("\0") === [...keys].sort().join("\0");
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY.test(value);
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT.test(value);
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value === value.normalize("NFC") &&
    value.length > 0 && Buffer.byteLength(value, "utf8") <= 120 && !LABEL_CONTROLS.test(value);
}

function isPurpose(value: unknown): value is PublicationAudiencePurpose {
  return value === "EVENT_AGENDA" || value === "PERSONAL_AGENDA" ||
    value === "SPEAKER_PORTAL" || value === "EMBED";
}

function isAudience(value: unknown): value is PublicationAudienceKind {
  return value === "PUBLIC" || value === "ATTENDEE" || value === "SPEAKER" || value === "ORGANIZER";
}

function isVisibility(value: unknown): value is PublicationAudienceVisibility {
  return value === "PUBLIC" || value === "TOKEN" || value === "AUTHENTICATED";
}

function isRule(value: unknown): value is PublicationAudiencePolicyRule {
  return value === "PUBLIC_SCHEDULE" || value === "ACCEPTED_AGENDAS" || value === "SPEAKER_PORTAL";
}

type OrganizerActor = Readonly<{
  accountId: string;
  workspaceId: string;
  workspaceSlug: string;
}>;

function authenticateOrganizer(db: Db, session: SessionInfo): OrganizerActor {
  if (!session || !validIdentifier(session.id) || !validIdentifier(session.accountId) ||
      !validIdentifier(session.workspaceId) || !validFingerprint(session.tokenHash)) fail("ACCESS_DENIED");
  const row = db.prepare(
    `SELECT session_row.id,
            session_row.token_hash AS tokenHash,
            session_row.account_id AS accountId,
            session_row.workspace_id AS workspaceId,
            session_row.expires_at AS expiresAt,
            account.role,
            workspace.slug AS workspaceSlug
     FROM sessions session_row
     JOIN accounts account
       ON account.id = session_row.account_id AND account.workspace_id = session_row.workspace_id
     JOIN workspaces workspace ON workspace.id = session_row.workspace_id
     WHERE session_row.id = ?
       AND session_row.token_hash = ?
       AND session_row.account_id = ?
       AND session_row.workspace_id = ?`,
  ).get(session.id, session.tokenHash, session.accountId, session.workspaceId) as {
    id: string;
    tokenHash: string;
    accountId: string;
    workspaceId: string;
    expiresAt: string;
    role: string;
    workspaceSlug: string;
  } | undefined;
  if (!row || row.expiresAt < nowIso() || !ORGANIZER_ROLES.has(row.role) ||
      row.workspaceSlug !== session.workspaceSlug) fail("ACCESS_DENIED");
  return Object.freeze({
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspaceSlug,
  });
}

function requireEvent(db: Db, actor: OrganizerActor, eventId: string): void {
  const row = db.prepare(
    "SELECT id FROM events WHERE workspace_id = ? AND id = ?",
  ).get(actor.workspaceId, eventId) as { id: string } | undefined;
  if (!row) fail("EVENT_NOT_AVAILABLE");
}

function withAudienceWrite<T>(db: Db, operation: () => T): T {
  if (db.isTransaction) fail("OUTER_TRANSACTION_DENIED");
  try {
    return withTransaction(db, operation);
  } catch (error) {
    if (error instanceof PublicationAudienceServiceError) throw error;
    throw new PublicationAudienceServiceError("WRITE_FAILED");
  }
}

export interface PublicationReleaseVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly releaseId: string;
  readonly versionNumber: number;
  readonly releaseFingerprint: string;
  readonly sealedAt: string;
  readonly catalogSource: "MIGRATION" | "COMMAND";
  readonly catalogedByAccountId: string | null;
  readonly catalogedAt: string;
  readonly catalogFingerprint: string;
}

type ReleaseVersionRow = {
  id: string;
  workspaceId: string;
  eventId: string;
  releaseId: string;
  versionNumber: number;
  releaseFingerprint: string;
  sealedAt: string;
  catalogSource: "MIGRATION" | "COMMAND";
  catalogedByAccountId: string | null;
  catalogedAt: string;
  catalogFingerprint: string;
};

function releaseVersionByRelease(
  db: Db,
  workspaceId: string,
  eventId: string,
  releaseId: string,
): PublicationReleaseVersion | null {
  const row = db.prepare(
    `SELECT id, workspace_id AS workspaceId, event_id AS eventId, release_id AS releaseId,
            version_number AS versionNumber, release_fingerprint AS releaseFingerprint,
            sealed_at AS sealedAt, catalog_source AS catalogSource,
            cataloged_by_account_id AS catalogedByAccountId, cataloged_at AS catalogedAt,
            catalog_fingerprint AS catalogFingerprint
     FROM publication_release_versions
     WHERE workspace_id = ? AND event_id = ? AND release_id = ?`,
  ).get(workspaceId, eventId, releaseId) as ReleaseVersionRow | undefined;
  return row ? Object.freeze({ ...row }) : null;
}

function validatedCurrentRelease(db: Db, actor: OrganizerActor, eventId: string): ValidatedPublicRelease {
  const event = db.prepare(
    "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
  ).get(actor.workspaceId, eventId) as { currentReleaseId: string | null } | undefined;
  if (!event) fail("EVENT_NOT_AVAILABLE");
  if (!event.currentReleaseId) fail("RELEASE_UNAVAILABLE");
  const release = validatePublicReleaseForRead(db, {
    workspaceId: actor.workspaceId,
    eventId,
    releaseId: event.currentReleaseId,
    mode: "CURRENT",
  });
  if (!release) fail("RELEASE_UNAVAILABLE");
  return release;
}

function insertReleaseVersion(
  db: Db,
  actor: OrganizerActor,
  release: ValidatedPublicRelease,
): PublicationReleaseVersion {
  const existing = releaseVersionByRelease(db, actor.workspaceId, release.eventId, release.releaseId);
  if (existing) {
    if (existing.releaseFingerprint !== release.fingerprint || existing.sealedAt !== release.sealedAt) {
      fail("RELEASE_MISMATCH");
    }
    return existing;
  }
  const version = db.prepare(
    `SELECT COALESCE(MAX(version_number) + 1, 1) AS versionNumber
     FROM publication_release_versions WHERE workspace_id = ? AND event_id = ?`,
  ).get(actor.workspaceId, release.eventId) as { versionNumber: number };
  const catalogedAt = nowIso();
  const catalogFingerprint = fingerprintOf({
    schema: "publication-release-version/v1",
    workspaceId: actor.workspaceId,
    eventId: release.eventId,
    releaseId: release.releaseId,
    versionNumber: version.versionNumber,
    releaseFingerprint: release.fingerprint,
    sealedAt: release.sealedAt,
    catalogSource: "COMMAND",
    catalogedByAccountId: actor.accountId,
    catalogedAt,
  });
  db.prepare(
    `INSERT INTO publication_release_versions
       (id, workspace_id, event_id, release_id, version_number, release_fingerprint,
        sealed_at, catalog_source, cataloged_by_account_id, cataloged_at, catalog_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'COMMAND', ?, ?, ?)`,
  ).run(
    `publication-release-version:${release.releaseId}`,
    actor.workspaceId,
    release.eventId,
    release.releaseId,
    version.versionNumber,
    release.fingerprint,
    release.sealedAt,
    actor.accountId,
    catalogedAt,
    catalogFingerprint,
  );
  const inserted = releaseVersionByRelease(db, actor.workspaceId, release.eventId, release.releaseId);
  if (!inserted) fail("WRITE_FAILED");
  return inserted;
}

export function catalogCurrentPublicationRelease(
  db: Db,
  session: SessionInfo,
  input: { readonly eventId: string },
): PublicationReleaseVersion {
  if (!exactObject(input, ["eventId"]) || !validIdentifier(input.eventId)) fail("INPUT_INVALID");
  return withAudienceWrite(db, () => {
    const actor = authenticateOrganizer(db, session);
    requireEvent(db, actor, input.eventId);
    const release = validatedCurrentRelease(db, actor, input.eventId);
    return insertReleaseVersion(db, actor, release);
  });
}

export interface PublicationAudienceChannel {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly key: string;
  readonly label: string;
  readonly purpose: PublicationAudiencePurpose;
  readonly audience: PublicationAudienceKind;
  readonly visibility: PublicationAudienceVisibility;
  readonly initialState: "ACTIVE";
  readonly currentState: "ACTIVE" | "DISABLED";
  readonly createdByAccountId: string;
  readonly createdAt: string;
  readonly fingerprint: string;
}

type ChannelRow = {
  id: string;
  workspaceId: string;
  eventId: string;
  key: string;
  label: string;
  purpose: PublicationAudiencePurpose;
  audience: PublicationAudienceKind;
  visibility: PublicationAudienceVisibility;
  initialState: "ACTIVE";
  createdByAccountId: string;
  createdAt: string;
  fingerprint: string;
};

function readChannel(db: Db, workspaceId: string, eventId: string, channelId: string): ChannelRow | null {
  const row = db.prepare(
    `SELECT id, workspace_id AS workspaceId, event_id AS eventId, channel_key AS key,
            label, purpose, audience, visibility, initial_state AS initialState,
            created_by_account_id AS createdByAccountId, created_at AS createdAt,
            channel_fingerprint AS fingerprint
     FROM publication_audience_channels
     WHERE workspace_id = ? AND event_id = ? AND id = ?`,
  ).get(workspaceId, eventId, channelId) as ChannelRow | undefined;
  return row ? { ...row } : null;
}

function channelDisabled(db: Db, workspaceId: string, eventId: string, channelId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM publication_audience_receipts
     WHERE workspace_id = ? AND event_id = ? AND channel_id = ? AND action = 'CHANNEL_DISABLED'
     LIMIT 1`,
  ).get(workspaceId, eventId, channelId));
}

export interface PublicationAudiencePolicyVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly channelId: string;
  readonly versionNumber: number;
  readonly purpose: PublicationAudiencePurpose;
  readonly audience: PublicationAudienceKind;
  readonly visibility: PublicationAudienceVisibility;
  readonly storedState: "DRAFT";
  readonly currentState: "DRAFT" | "BOUND" | "SUPERSEDED";
  readonly rule: PublicationAudiencePolicyRule;
  readonly policySchema: typeof V17_PUBLICATION_AUDIENCE_POLICY_SCHEMA;
  readonly policyFingerprint: string;
  readonly createdByAccountId: string;
  readonly createdAt: string;
}

type PolicyRow = {
  id: string;
  workspaceId: string;
  eventId: string;
  channelId: string;
  versionNumber: number;
  purpose: PublicationAudiencePurpose;
  audience: PublicationAudienceKind;
  visibility: PublicationAudienceVisibility;
  storedState: "DRAFT";
  rule: PublicationAudiencePolicyRule;
  policySchema: typeof V17_PUBLICATION_AUDIENCE_POLICY_SCHEMA;
  policyJson: string;
  policyFingerprint: string;
  createdByAccountId: string;
  createdAt: string;
};

function readPolicy(db: Db, workspaceId: string, eventId: string, policyId: string): PolicyRow | null {
  const row = db.prepare(
    `SELECT id, workspace_id AS workspaceId, event_id AS eventId, channel_id AS channelId,
            version_number AS versionNumber, purpose, audience, visibility, state AS storedState,
            rule, policy_schema AS policySchema, policy_json AS policyJson,
            policy_fingerprint AS policyFingerprint,
            created_by_account_id AS createdByAccountId, created_at AS createdAt
     FROM publication_audience_policy_versions
     WHERE workspace_id = ? AND event_id = ? AND id = ?`,
  ).get(workspaceId, eventId, policyId) as PolicyRow | undefined;
  return row ? { ...row } : null;
}

function policySuperseded(db: Db, workspaceId: string, eventId: string, policyId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM publication_audience_receipts
     WHERE workspace_id = ? AND event_id = ?
       AND policy_version_id = ? AND action = 'POLICY_SUPERSEDED'
     LIMIT 1`,
  ).get(workspaceId, eventId, policyId));
}

type ReceiptRow = {
  id: string;
  workspaceId: string;
  eventId: string;
  channelId: string;
  sequenceNumber: number;
  action: PublicationAudienceReceiptAction;
  resultState: "ACTIVE" | "DISABLED" | "DRAFT" | "SUPERSEDED" | "BOUND" | "BLOCKED";
  policyVersionId: string | null;
  successorPolicyVersionId: string | null;
  releaseVersionId: string | null;
  expectedReleaseId: string | null;
  expectedReleaseVersion: number | null;
  expectedReleaseFingerprint: string | null;
  targetReceiptId: string | null;
  predecessorReceiptId: string | null;
  actorAccountId: string;
  idempotencyKey: string;
  commandFingerprint: string;
  requestFingerprint: string;
  createdAt: string;
};

export interface PublicationAudienceReceipt {
  readonly schema: typeof V17_PUBLICATION_AUDIENCE_RECEIPT_SCHEMA;
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly channelId: string;
  readonly sequenceNumber: number;
  readonly action: PublicationAudienceReceiptAction;
  readonly resultState: ReceiptRow["resultState"];
  readonly policyVersionId: string | null;
  readonly successorPolicyVersionId: string | null;
  readonly releaseVersionId: string | null;
  readonly expectedReleaseId: string | null;
  readonly expectedReleaseVersion: number | null;
  readonly expectedReleaseFingerprint: string | null;
  readonly targetReceiptId: string | null;
  readonly predecessorReceiptId: string | null;
  readonly actorAccountId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
  readonly replayed: boolean;
}

function rowToReceipt(row: ReceiptRow, replayed: boolean): PublicationAudienceReceipt {
  return Object.freeze({
    schema: V17_PUBLICATION_AUDIENCE_RECEIPT_SCHEMA,
    id: row.id,
    workspaceId: row.workspaceId,
    eventId: row.eventId,
    channelId: row.channelId,
    sequenceNumber: row.sequenceNumber,
    action: row.action,
    resultState: row.resultState,
    policyVersionId: row.policyVersionId,
    successorPolicyVersionId: row.successorPolicyVersionId,
    releaseVersionId: row.releaseVersionId,
    expectedReleaseId: row.expectedReleaseId,
    expectedReleaseVersion: row.expectedReleaseVersion,
    expectedReleaseFingerprint: row.expectedReleaseFingerprint,
    targetReceiptId: row.targetReceiptId,
    predecessorReceiptId: row.predecessorReceiptId,
    actorAccountId: row.actorAccountId,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    createdAt: row.createdAt,
    replayed,
  });
}

const RECEIPT_SELECT = `SELECT id, workspace_id AS workspaceId, event_id AS eventId,
  channel_id AS channelId, sequence_number AS sequenceNumber, action,
  result_state AS resultState, policy_version_id AS policyVersionId,
  successor_policy_version_id AS successorPolicyVersionId,
  release_version_id AS releaseVersionId, expected_release_id AS expectedReleaseId,
  expected_release_version AS expectedReleaseVersion,
  expected_release_fingerprint AS expectedReleaseFingerprint,
  target_receipt_id AS targetReceiptId, predecessor_receipt_id AS predecessorReceiptId,
  actor_account_id AS actorAccountId, idempotency_key AS idempotencyKey,
  command_fingerprint AS commandFingerprint, request_fingerprint AS requestFingerprint,
  created_at AS createdAt FROM publication_audience_receipts`;

function priorCommand(
  db: Db,
  actor: OrganizerActor,
  idempotencyKey: string,
  expected: { readonly eventId: string; readonly channelId: string; readonly action: PublicationAudienceReceiptAction; readonly commandFingerprint: string },
): ReceiptRow | null {
  const row = db.prepare(
    `${RECEIPT_SELECT}
     WHERE workspace_id = ? AND actor_account_id = ? AND idempotency_key = ?`,
  ).get(actor.workspaceId, actor.accountId, idempotencyKey) as ReceiptRow | undefined;
  if (!row) return null;
  if (row.eventId !== expected.eventId || row.channelId !== expected.channelId ||
      row.action !== expected.action || row.commandFingerprint !== expected.commandFingerprint) {
    fail("IDEMPOTENCY_CONFLICT");
  }
  return row;
}

type InsertReceiptInput = Readonly<{
  eventId: string;
  channelId: string;
  action: PublicationAudienceReceiptAction;
  resultState: ReceiptRow["resultState"];
  policyVersionId: string | null;
  successorPolicyVersionId: string | null;
  releaseVersionId: string | null;
  expectedReleaseId: string | null;
  expectedReleaseVersion: number | null;
  expectedReleaseFingerprint: string | null;
  targetReceiptId: string | null;
  idempotencyKey: string;
  commandFingerprint: string;
  createdAt: string;
}>;

function insertReceipt(db: Db, actor: OrganizerActor, input: InsertReceiptInput): ReceiptRow {
  const cursor = db.prepare(
    `SELECT id, sequence_number AS sequenceNumber
     FROM publication_audience_receipts
     WHERE workspace_id = ? AND event_id = ? AND channel_id = ?
     ORDER BY sequence_number DESC LIMIT 1`,
  ).get(actor.workspaceId, input.eventId, input.channelId) as {
    id: string;
    sequenceNumber: number;
  } | undefined;
  const sequenceNumber = (cursor?.sequenceNumber ?? 0) + 1;
  const predecessorReceiptId = cursor?.id ?? null;
  const requestFingerprint = fingerprintOf({
    schema: V17_PUBLICATION_AUDIENCE_REQUEST_SCHEMA,
    workspaceId: actor.workspaceId,
    eventId: input.eventId,
    channelId: input.channelId,
    action: input.action,
    policyVersionId: input.policyVersionId,
    successorPolicyVersionId: input.successorPolicyVersionId,
    releaseVersionId: input.releaseVersionId,
    expectedReleaseId: input.expectedReleaseId,
    expectedReleaseVersion: input.expectedReleaseVersion,
    expectedReleaseFingerprint: input.expectedReleaseFingerprint,
    targetReceiptId: input.targetReceiptId,
    actorAccountId: actor.accountId,
    idempotencyKey: input.idempotencyKey,
    commandFingerprint: input.commandFingerprint,
  });
  const receiptId = deterministicUuid(`publication-audience-receipt:${requestFingerprint}`);
  db.prepare(
    `INSERT INTO publication_audience_receipts
       (id, workspace_id, event_id, channel_id, sequence_number, action, result_state,
        policy_version_id, successor_policy_version_id, release_version_id,
        expected_release_id, expected_release_version, expected_release_fingerprint,
        target_receipt_id, predecessor_receipt_id, actor_account_id, idempotency_key,
        command_fingerprint, request_schema, request_fingerprint, receipt_schema, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receiptId,
    actor.workspaceId,
    input.eventId,
    input.channelId,
    sequenceNumber,
    input.action,
    input.resultState,
    input.policyVersionId,
    input.successorPolicyVersionId,
    input.releaseVersionId,
    input.expectedReleaseId,
    input.expectedReleaseVersion,
    input.expectedReleaseFingerprint,
    input.targetReceiptId,
    predecessorReceiptId,
    actor.accountId,
    input.idempotencyKey,
    input.commandFingerprint,
    V17_PUBLICATION_AUDIENCE_REQUEST_SCHEMA,
    requestFingerprint,
    V17_PUBLICATION_AUDIENCE_RECEIPT_SCHEMA,
    input.createdAt,
  );
  const row = db.prepare(`${RECEIPT_SELECT} WHERE id = ?`).get(receiptId) as ReceiptRow | undefined;
  if (!row) fail("WRITE_FAILED");
  return row;
}

export interface CreateAudienceChannelInput {
  readonly eventId: string;
  readonly key: string;
  readonly label: string;
  readonly purpose: PublicationAudiencePurpose;
  readonly audience: PublicationAudienceKind;
  readonly visibility: PublicationAudienceVisibility;
  readonly idempotencyKey: string;
}

function captureCreateChannel(input: CreateAudienceChannelInput): CreateAudienceChannelInput {
  if (!exactObject(input, ["eventId", "key", "label", "purpose", "audience", "visibility", "idempotencyKey"]) ||
      !validIdentifier(input.eventId) || typeof input.key !== "string" || !CHANNEL_KEY.test(input.key) ||
      !validLabel(input.label) || !isPurpose(input.purpose) || !isAudience(input.audience) ||
      !isVisibility(input.visibility) || !validIdempotencyKey(input.idempotencyKey)) fail("INPUT_INVALID");
  return Object.freeze({ ...input });
}

export function createPublicationAudienceChannel(
  db: Db,
  session: SessionInfo,
  rawInput: CreateAudienceChannelInput,
): { readonly channel: PublicationAudienceChannel; readonly receipt: PublicationAudienceReceipt } {
  const input = captureCreateChannel(rawInput);
  return withAudienceWrite(db, () => {
    const actor = authenticateOrganizer(db, session);
    requireEvent(db, actor, input.eventId);
    const channelId = deterministicUuid(
      `publication-audience-channel:${actor.workspaceId}:${input.eventId}:${input.key}`,
    );
    const commandFingerprint = fingerprintOf({
      schema: "publication-audience-command-payload/v1",
      intent: "CREATE_CHANNEL",
      eventId: input.eventId,
      channelId,
      key: input.key,
      label: input.label,
      purpose: input.purpose,
      audience: input.audience,
      visibility: input.visibility,
    });
    const replay = priorCommand(db, actor, input.idempotencyKey, {
      eventId: input.eventId,
      channelId,
      action: "CHANNEL_CREATED",
      commandFingerprint,
    });
    if (replay) {
      const channel = readChannel(db, actor.workspaceId, input.eventId, channelId);
      if (!channel) fail("COMMAND_CONFLICT");
      return {
        channel: Object.freeze({ ...channel, currentState: channelDisabled(db, actor.workspaceId, input.eventId, channelId) ? "DISABLED" : "ACTIVE" }),
        receipt: rowToReceipt(replay, true),
      };
    }
    if (readChannel(db, actor.workspaceId, input.eventId, channelId)) fail("COMMAND_CONFLICT");
    const createdAt = nowIso();
    const channelFingerprint = fingerprintOf({
      schema: "publication-audience-channel/v1",
      workspaceId: actor.workspaceId,
      eventId: input.eventId,
      channelKey: input.key,
      label: input.label,
      purpose: input.purpose,
      audience: input.audience,
      visibility: input.visibility,
      initialState: "ACTIVE",
      createdByAccountId: actor.accountId,
      createdAt,
    });
    db.prepare(
      `INSERT INTO publication_audience_channels
         (id, workspace_id, event_id, channel_key, label, purpose, audience, visibility,
          initial_state, created_by_account_id, created_at, channel_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    ).run(
      channelId,
      actor.workspaceId,
      input.eventId,
      input.key,
      input.label,
      input.purpose,
      input.audience,
      input.visibility,
      actor.accountId,
      createdAt,
      channelFingerprint,
    );
    const receipt = insertReceipt(db, actor, {
      eventId: input.eventId,
      channelId,
      action: "CHANNEL_CREATED",
      resultState: "ACTIVE",
      policyVersionId: null,
      successorPolicyVersionId: null,
      releaseVersionId: null,
      expectedReleaseId: null,
      expectedReleaseVersion: null,
      expectedReleaseFingerprint: null,
      targetReceiptId: null,
      idempotencyKey: input.idempotencyKey,
      commandFingerprint,
      createdAt,
    });
    return {
      channel: Object.freeze({
        id: channelId,
        workspaceId: actor.workspaceId,
        eventId: input.eventId,
        key: input.key,
        label: input.label,
        purpose: input.purpose,
        audience: input.audience,
        visibility: input.visibility,
        initialState: "ACTIVE" as const,
        currentState: "ACTIVE" as const,
        createdByAccountId: actor.accountId,
        createdAt,
        fingerprint: channelFingerprint,
      }),
      receipt: rowToReceipt(receipt, false),
    };
  });
}

export interface DisableAudienceChannelInput {
  readonly eventId: string;
  readonly channelId: string;
  readonly expectedChannelFingerprint: string;
  readonly idempotencyKey: string;
}

export function disablePublicationAudienceChannel(
  db: Db,
  session: SessionInfo,
  input: DisableAudienceChannelInput,
): PublicationAudienceReceipt {
  if (!exactObject(input, ["eventId", "channelId", "expectedChannelFingerprint", "idempotencyKey"]) ||
      !validIdentifier(input.eventId) || !validIdentifier(input.channelId) ||
      !validFingerprint(input.expectedChannelFingerprint) || !validIdempotencyKey(input.idempotencyKey)) {
    fail("INPUT_INVALID");
  }
  return withAudienceWrite(db, () => {
    const actor = authenticateOrganizer(db, session);
    requireEvent(db, actor, input.eventId);
    const commandFingerprint = fingerprintOf({
      schema: "publication-audience-command-payload/v1",
      intent: "DISABLE_CHANNEL",
      eventId: input.eventId,
      channelId: input.channelId,
      expectedChannelFingerprint: input.expectedChannelFingerprint,
    });
    const replay = priorCommand(db, actor, input.idempotencyKey, {
      eventId: input.eventId,
      channelId: input.channelId,
      action: "CHANNEL_DISABLED",
      commandFingerprint,
    });
    if (replay) return rowToReceipt(replay, true);
    const channel = readChannel(db, actor.workspaceId, input.eventId, input.channelId);
    if (!channel || channel.fingerprint !== input.expectedChannelFingerprint) fail("CHANNEL_NOT_AVAILABLE");
    if (channelDisabled(db, actor.workspaceId, input.eventId, input.channelId)) fail("CHANNEL_DISABLED");
    const receipt = insertReceipt(db, actor, {
      eventId: input.eventId,
      channelId: input.channelId,
      action: "CHANNEL_DISABLED",
      resultState: "DISABLED",
      policyVersionId: null,
      successorPolicyVersionId: null,
      releaseVersionId: null,
      expectedReleaseId: null,
      expectedReleaseVersion: null,
      expectedReleaseFingerprint: null,
      targetReceiptId: null,
      idempotencyKey: input.idempotencyKey,
      commandFingerprint,
      createdAt: nowIso(),
    });
    return rowToReceipt(receipt, false);
  });
}

export interface CreateAudiencePolicyInput {
  readonly eventId: string;
  readonly channelId: string;
  readonly rule: PublicationAudiencePolicyRule;
  readonly idempotencyKey: string;
}

export function createPublicationAudiencePolicyVersion(
  db: Db,
  session: SessionInfo,
  input: CreateAudiencePolicyInput,
): { readonly policy: PublicationAudiencePolicyVersion; readonly receipt: PublicationAudienceReceipt } {
  if (!exactObject(input, ["eventId", "channelId", "rule", "idempotencyKey"]) ||
      !validIdentifier(input.eventId) || !validIdentifier(input.channelId) || !isRule(input.rule) ||
      !validIdempotencyKey(input.idempotencyKey)) fail("INPUT_INVALID");
  return withAudienceWrite(db, () => {
    const actor = authenticateOrganizer(db, session);
    requireEvent(db, actor, input.eventId);
    const channel = readChannel(db, actor.workspaceId, input.eventId, input.channelId);
    if (!channel) fail("CHANNEL_NOT_AVAILABLE");
    if (channelDisabled(db, actor.workspaceId, input.eventId, input.channelId)) fail("CHANNEL_DISABLED");
    const commandFingerprint = fingerprintOf({
      schema: "publication-audience-command-payload/v1",
      intent: "CREATE_POLICY",
      eventId: input.eventId,
      channelId: input.channelId,
      rule: input.rule,
    });
    const prior = db.prepare(
      `${RECEIPT_SELECT}
       WHERE workspace_id = ? AND actor_account_id = ? AND idempotency_key = ?`,
    ).get(actor.workspaceId, actor.accountId, input.idempotencyKey) as ReceiptRow | undefined;
    if (prior) {
      if (prior.eventId !== input.eventId || prior.channelId !== input.channelId ||
          prior.action !== "POLICY_DRAFTED" || prior.commandFingerprint !== commandFingerprint ||
          !prior.policyVersionId) fail("IDEMPOTENCY_CONFLICT");
      const policy = readPolicy(db, actor.workspaceId, input.eventId, prior.policyVersionId);
      if (!policy) fail("COMMAND_CONFLICT");
      return {
        policy: Object.freeze({ ...policy, currentState: policySuperseded(db, actor.workspaceId, input.eventId, policy.id) ? "SUPERSEDED" : "DRAFT" }),
        receipt: rowToReceipt(prior, true),
      };
    }
    const next = db.prepare(
      `SELECT COALESCE(MAX(version_number) + 1, 1) AS versionNumber
       FROM publication_audience_policy_versions
       WHERE workspace_id = ? AND event_id = ? AND channel_id = ?`,
    ).get(actor.workspaceId, input.eventId, input.channelId) as { versionNumber: number };
    const createdAt = nowIso();
    const policyId = deterministicUuid(
      `publication-audience-policy:${actor.workspaceId}:${input.eventId}:${input.channelId}:${next.versionNumber}`,
    );
    const policyDocument = Object.freeze({
      schema: V17_PUBLICATION_AUDIENCE_POLICY_SCHEMA,
      purpose: channel.purpose,
      audience: channel.audience,
      visibility: channel.visibility,
      rule: input.rule,
      releaseBinding: "EXACT_VALIDATED_RELEASE",
      carryForward: false,
    });
    const policyJson = canonicalJson(policyDocument);
    const policyFingerprint = fingerprintOf({
      schema: V17_PUBLICATION_AUDIENCE_POLICY_SCHEMA,
      workspaceId: actor.workspaceId,
      eventId: input.eventId,
      channelId: input.channelId,
      versionNumber: next.versionNumber,
      purpose: channel.purpose,
      audience: channel.audience,
      visibility: channel.visibility,
      state: "DRAFT",
      rule: input.rule,
      policy: policyDocument,
      createdByAccountId: actor.accountId,
      createdAt,
    });
    db.prepare(
      `INSERT INTO publication_audience_policy_versions
         (id, workspace_id, event_id, channel_id, version_number, purpose, audience,
          visibility, state, rule, policy_schema, policy_json, policy_fingerprint,
          created_by_account_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`,
    ).run(
      policyId,
      actor.workspaceId,
      input.eventId,
      input.channelId,
      next.versionNumber,
      channel.purpose,
      channel.audience,
      channel.visibility,
      input.rule,
      V17_PUBLICATION_AUDIENCE_POLICY_SCHEMA,
      policyJson,
      policyFingerprint,
      actor.accountId,
      createdAt,
    );
    const receipt = insertReceipt(db, actor, {
      eventId: input.eventId,
      channelId: input.channelId,
      action: "POLICY_DRAFTED",
      resultState: "DRAFT",
      policyVersionId: policyId,
      successorPolicyVersionId: null,
      releaseVersionId: null,
      expectedReleaseId: null,
      expectedReleaseVersion: null,
      expectedReleaseFingerprint: null,
      targetReceiptId: null,
      idempotencyKey: input.idempotencyKey,
      commandFingerprint,
      createdAt,
    });
    return {
      policy: Object.freeze({
        id: policyId,
        workspaceId: actor.workspaceId,
        eventId: input.eventId,
        channelId: input.channelId,
        versionNumber: next.versionNumber,
        purpose: channel.purpose,
        audience: channel.audience,
        visibility: channel.visibility,
        storedState: "DRAFT" as const,
        currentState: "DRAFT" as const,
        rule: input.rule,
        policySchema: V17_PUBLICATION_AUDIENCE_POLICY_SCHEMA,
        policyFingerprint,
        createdByAccountId: actor.accountId,
        createdAt,
      }),
      receipt: rowToReceipt(receipt, false),
    };
  });
}

export interface SupersedeAudiencePolicyInput {
  readonly eventId: string;
  readonly channelId: string;
  readonly policyVersionId: string;
  readonly expectedPolicyFingerprint: string;
  readonly successorPolicyVersionId: string;
  readonly expectedSuccessorPolicyFingerprint: string;
  readonly idempotencyKey: string;
}

export function supersedePublicationAudiencePolicy(
  db: Db,
  session: SessionInfo,
  input: SupersedeAudiencePolicyInput,
): PublicationAudienceReceipt {
  if (!exactObject(input, ["eventId", "channelId", "policyVersionId", "expectedPolicyFingerprint",
    "successorPolicyVersionId", "expectedSuccessorPolicyFingerprint", "idempotencyKey"]) ||
      !validIdentifier(input.eventId) || !validIdentifier(input.channelId) ||
      !validIdentifier(input.policyVersionId) || !validIdentifier(input.successorPolicyVersionId) ||
      !validFingerprint(input.expectedPolicyFingerprint) ||
      !validFingerprint(input.expectedSuccessorPolicyFingerprint) ||
      !validIdempotencyKey(input.idempotencyKey)) fail("INPUT_INVALID");
  return withAudienceWrite(db, () => {
    const actor = authenticateOrganizer(db, session);
    requireEvent(db, actor, input.eventId);
    const commandFingerprint = fingerprintOf({
      schema: "publication-audience-command-payload/v1",
      intent: "SUPERSEDE_POLICY",
      eventId: input.eventId,
      channelId: input.channelId,
      policyVersionId: input.policyVersionId,
      expectedPolicyFingerprint: input.expectedPolicyFingerprint,
      successorPolicyVersionId: input.successorPolicyVersionId,
      expectedSuccessorPolicyFingerprint: input.expectedSuccessorPolicyFingerprint,
    });
    const replay = priorCommand(db, actor, input.idempotencyKey, {
      eventId: input.eventId,
      channelId: input.channelId,
      action: "POLICY_SUPERSEDED",
      commandFingerprint,
    });
    if (replay) return rowToReceipt(replay, true);
    const channel = readChannel(db, actor.workspaceId, input.eventId, input.channelId);
    if (!channel) fail("CHANNEL_NOT_AVAILABLE");
    if (channelDisabled(db, actor.workspaceId, input.eventId, input.channelId)) fail("CHANNEL_DISABLED");
    const policy = readPolicy(db, actor.workspaceId, input.eventId, input.policyVersionId);
    const successor = readPolicy(db, actor.workspaceId, input.eventId, input.successorPolicyVersionId);
    if (!policy || !successor || policy.channelId !== input.channelId || successor.channelId !== input.channelId ||
        policy.policyFingerprint !== input.expectedPolicyFingerprint ||
        successor.policyFingerprint !== input.expectedSuccessorPolicyFingerprint ||
        successor.versionNumber <= policy.versionNumber) fail("POLICY_NOT_AVAILABLE");
    if (policySuperseded(db, actor.workspaceId, input.eventId, policy.id)) fail("POLICY_SUPERSEDED");
    const receipt = insertReceipt(db, actor, {
      eventId: input.eventId,
      channelId: input.channelId,
      action: "POLICY_SUPERSEDED",
      resultState: "SUPERSEDED",
      policyVersionId: policy.id,
      successorPolicyVersionId: successor.id,
      releaseVersionId: null,
      expectedReleaseId: null,
      expectedReleaseVersion: null,
      expectedReleaseFingerprint: null,
      targetReceiptId: null,
      idempotencyKey: input.idempotencyKey,
      commandFingerprint,
      createdAt: nowIso(),
    });
    return rowToReceipt(receipt, false);
  });
}

export interface BindAudienceReleaseInput {
  readonly eventId: string;
  readonly channelId: string;
  readonly policyVersionId: string;
  readonly expectedReleaseId: string;
  readonly expectedReleaseVersion: number;
  readonly expectedReleaseFingerprint: string;
  readonly idempotencyKey: string;
}

export function bindPublicationAudienceRelease(
  db: Db,
  session: SessionInfo,
  input: BindAudienceReleaseInput,
): PublicationAudienceReceipt {
  if (!exactObject(input, ["eventId", "channelId", "policyVersionId", "expectedReleaseId",
    "expectedReleaseVersion", "expectedReleaseFingerprint", "idempotencyKey"]) ||
      !validIdentifier(input.eventId) || !validIdentifier(input.channelId) ||
      !validIdentifier(input.policyVersionId) || !validIdentifier(input.expectedReleaseId) ||
      !validPositiveInteger(input.expectedReleaseVersion) ||
      !validFingerprint(input.expectedReleaseFingerprint) || !validIdempotencyKey(input.idempotencyKey)) {
    fail("INPUT_INVALID");
  }
  return withAudienceWrite(db, () => {
    const actor = authenticateOrganizer(db, session);
    requireEvent(db, actor, input.eventId);
    const commandFingerprint = fingerprintOf({
      schema: "publication-audience-command-payload/v1",
      intent: "BIND_RELEASE",
      eventId: input.eventId,
      channelId: input.channelId,
      policyVersionId: input.policyVersionId,
      expectedReleaseId: input.expectedReleaseId,
      expectedReleaseVersion: input.expectedReleaseVersion,
      expectedReleaseFingerprint: input.expectedReleaseFingerprint,
    });
    const replay = priorCommand(db, actor, input.idempotencyKey, {
      eventId: input.eventId,
      channelId: input.channelId,
      action: "RELEASE_BOUND",
      commandFingerprint,
    });
    if (replay) return rowToReceipt(replay, true);
    const channel = readChannel(db, actor.workspaceId, input.eventId, input.channelId);
    if (!channel) fail("CHANNEL_NOT_AVAILABLE");
    if (channelDisabled(db, actor.workspaceId, input.eventId, input.channelId)) fail("CHANNEL_DISABLED");
    const policy = readPolicy(db, actor.workspaceId, input.eventId, input.policyVersionId);
    if (!policy || policy.channelId !== channel.id) fail("POLICY_NOT_AVAILABLE");
    if (policySuperseded(db, actor.workspaceId, input.eventId, policy.id)) fail("POLICY_SUPERSEDED");
    const current = validatedCurrentRelease(db, actor, input.eventId);
    const catalog = releaseVersionByRelease(db, actor.workspaceId, input.eventId, current.releaseId);
    if (!catalog) fail("RELEASE_UNAVAILABLE");
    if (current.releaseId !== input.expectedReleaseId || current.fingerprint !== input.expectedReleaseFingerprint ||
        catalog.versionNumber !== input.expectedReleaseVersion ||
        catalog.releaseFingerprint !== input.expectedReleaseFingerprint) fail("RELEASE_MISMATCH");
    const exactPrior = db.prepare(
      `SELECT 1 FROM publication_audience_receipts
       WHERE workspace_id = ? AND event_id = ? AND channel_id = ?
         AND policy_version_id = ? AND release_version_id = ? AND action = 'RELEASE_BOUND'
       LIMIT 1`,
    ).get(actor.workspaceId, input.eventId, channel.id, policy.id, catalog.id);
    if (exactPrior) fail("COMMAND_CONFLICT");
    const receipt = insertReceipt(db, actor, {
      eventId: input.eventId,
      channelId: channel.id,
      action: "RELEASE_BOUND",
      resultState: "BOUND",
      policyVersionId: policy.id,
      successorPolicyVersionId: null,
      releaseVersionId: catalog.id,
      expectedReleaseId: current.releaseId,
      expectedReleaseVersion: catalog.versionNumber,
      expectedReleaseFingerprint: current.fingerprint,
      targetReceiptId: null,
      idempotencyKey: input.idempotencyKey,
      commandFingerprint,
      createdAt: nowIso(),
    });
    return rowToReceipt(receipt, false);
  });
}

export interface DisableAudienceBindingInput {
  readonly eventId: string;
  readonly channelId: string;
  readonly bindingReceiptId: string;
  readonly expectedReleaseId: string;
  readonly expectedReleaseVersion: number;
  readonly expectedReleaseFingerprint: string;
  readonly idempotencyKey: string;
}

export function disablePublicationAudienceBinding(
  db: Db,
  session: SessionInfo,
  input: DisableAudienceBindingInput,
): PublicationAudienceReceipt {
  if (!exactObject(input, ["eventId", "channelId", "bindingReceiptId", "expectedReleaseId",
    "expectedReleaseVersion", "expectedReleaseFingerprint", "idempotencyKey"]) ||
      !validIdentifier(input.eventId) || !validIdentifier(input.channelId) ||
      !validIdentifier(input.bindingReceiptId) || !validIdentifier(input.expectedReleaseId) ||
      !validPositiveInteger(input.expectedReleaseVersion) ||
      !validFingerprint(input.expectedReleaseFingerprint) || !validIdempotencyKey(input.idempotencyKey)) {
    fail("INPUT_INVALID");
  }
  return withAudienceWrite(db, () => {
    const actor = authenticateOrganizer(db, session);
    requireEvent(db, actor, input.eventId);
    const commandFingerprint = fingerprintOf({
      schema: "publication-audience-command-payload/v1",
      intent: "DISABLE_BINDING",
      eventId: input.eventId,
      channelId: input.channelId,
      bindingReceiptId: input.bindingReceiptId,
      expectedReleaseId: input.expectedReleaseId,
      expectedReleaseVersion: input.expectedReleaseVersion,
      expectedReleaseFingerprint: input.expectedReleaseFingerprint,
    });
    const replay = priorCommand(db, actor, input.idempotencyKey, {
      eventId: input.eventId,
      channelId: input.channelId,
      action: "BINDING_DISABLED",
      commandFingerprint,
    });
    if (replay) return rowToReceipt(replay, true);
    const binding = db.prepare(`${RECEIPT_SELECT} WHERE workspace_id = ? AND event_id = ? AND channel_id = ? AND id = ? AND action = 'RELEASE_BOUND'`)
      .get(actor.workspaceId, input.eventId, input.channelId, input.bindingReceiptId) as ReceiptRow | undefined;
    if (!binding || !binding.policyVersionId || !binding.releaseVersionId ||
        binding.expectedReleaseId !== input.expectedReleaseId ||
        binding.expectedReleaseVersion !== input.expectedReleaseVersion ||
        binding.expectedReleaseFingerprint !== input.expectedReleaseFingerprint) fail("BINDING_NOT_AVAILABLE");
    const disabled = db.prepare(
      `SELECT 1 FROM publication_audience_receipts
       WHERE workspace_id = ? AND event_id = ? AND target_receipt_id = ?
         AND action = 'BINDING_DISABLED' LIMIT 1`,
    ).get(actor.workspaceId, input.eventId, binding.id);
    if (disabled) fail("COMMAND_CONFLICT");
    const receipt = insertReceipt(db, actor, {
      eventId: input.eventId,
      channelId: input.channelId,
      action: "BINDING_DISABLED",
      resultState: "BLOCKED",
      policyVersionId: binding.policyVersionId,
      successorPolicyVersionId: null,
      releaseVersionId: binding.releaseVersionId,
      expectedReleaseId: binding.expectedReleaseId,
      expectedReleaseVersion: binding.expectedReleaseVersion,
      expectedReleaseFingerprint: binding.expectedReleaseFingerprint,
      targetReceiptId: binding.id,
      idempotencyKey: input.idempotencyKey,
      commandFingerprint,
      createdAt: nowIso(),
    });
    return rowToReceipt(receipt, false);
  });
}

export interface PublicationAudienceMatrixRow {
  readonly key: string;
  readonly releaseVersionId: string;
  readonly releaseId: string;
  readonly releaseVersion: number;
  readonly releaseFingerprint: string;
  readonly releaseSealedAt: string;
  readonly channelId: string;
  readonly channelKey: string;
  readonly channelLabel: string;
  readonly purpose: PublicationAudiencePurpose;
  readonly audience: PublicationAudienceKind;
  readonly visibility: PublicationAudienceVisibility;
  readonly policyVersionId: string | null;
  readonly policyVersion: number | null;
  readonly bindingReceiptId: string | null;
  readonly status: PublicationAudienceMatrixStatus;
  readonly reason: string;
  readonly receipts: readonly PublicationAudienceReceipt[];
}

export interface PublicationAudienceMatrix {
  readonly schema: "publication-audience-matrix/v1";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly currentReleaseId: string | null;
  readonly currentReleaseValidated: boolean;
  readonly releases: readonly PublicationReleaseVersion[];
  readonly channels: readonly PublicationAudienceChannel[];
  readonly policies: readonly PublicationAudiencePolicyVersion[];
  readonly receipts: readonly PublicationAudienceReceipt[];
  readonly rows: readonly PublicationAudienceMatrixRow[];
  readonly fingerprint: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function getPublicationAudienceMatrix(
  db: Db,
  session: SessionInfo,
  input: { readonly eventId: string },
): PublicationAudienceMatrix {
  if (!exactObject(input, ["eventId"]) || !validIdentifier(input.eventId)) fail("INPUT_INVALID");
  const actor = authenticateOrganizer(db, session);
  requireEvent(db, actor, input.eventId);
  const event = db.prepare(
    "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
  ).get(actor.workspaceId, input.eventId) as { currentReleaseId: string | null };
  const validatedCurrent = event.currentReleaseId
    ? validatePublicReleaseForRead(db, {
        workspaceId: actor.workspaceId,
        eventId: input.eventId,
        releaseId: event.currentReleaseId,
        mode: "CURRENT",
      })
    : null;
  const releaseRows = db.prepare(
    `SELECT id, workspace_id AS workspaceId, event_id AS eventId, release_id AS releaseId,
            version_number AS versionNumber, release_fingerprint AS releaseFingerprint,
            sealed_at AS sealedAt, catalog_source AS catalogSource,
            cataloged_by_account_id AS catalogedByAccountId, cataloged_at AS catalogedAt,
            catalog_fingerprint AS catalogFingerprint
     FROM publication_release_versions
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY version_number, release_id, id`,
  ).all(actor.workspaceId, input.eventId) as ReleaseVersionRow[];
  const releases = releaseRows.map((release) => Object.freeze({ ...release }));
  const channelRows = db.prepare(
    `SELECT id, workspace_id AS workspaceId, event_id AS eventId, channel_key AS key,
            label, purpose, audience, visibility, initial_state AS initialState,
            created_by_account_id AS createdByAccountId, created_at AS createdAt,
            channel_fingerprint AS fingerprint
     FROM publication_audience_channels
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY purpose, audience, visibility, channel_key, id`,
  ).all(actor.workspaceId, input.eventId) as ChannelRow[];
  const receiptRows = db.prepare(
    `${RECEIPT_SELECT}
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY channel_id, sequence_number, id`,
  ).all(actor.workspaceId, input.eventId) as ReceiptRow[];
  const receipts = receiptRows.map((receipt) => rowToReceipt(receipt, false));
  const receiptByChannel = new Map<string, ReceiptRow[]>();
  for (const receipt of receiptRows) {
    const rows = receiptByChannel.get(receipt.channelId) ?? [];
    rows.push(receipt);
    receiptByChannel.set(receipt.channelId, rows);
  }
  const channels = channelRows.map((channel) => Object.freeze({
    ...channel,
    currentState: (receiptByChannel.get(channel.id) ?? []).some((receipt) => receipt.action === "CHANNEL_DISABLED")
      ? "DISABLED" as const
      : "ACTIVE" as const,
  }));
  const policyRows = db.prepare(
    `SELECT id, workspace_id AS workspaceId, event_id AS eventId, channel_id AS channelId,
            version_number AS versionNumber, purpose, audience, visibility, state AS storedState,
            rule, policy_schema AS policySchema, policy_json AS policyJson,
            policy_fingerprint AS policyFingerprint,
            created_by_account_id AS createdByAccountId, created_at AS createdAt
     FROM publication_audience_policy_versions
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY channel_id, version_number, id`,
  ).all(actor.workspaceId, input.eventId) as PolicyRow[];
  const policyById = new Map(policyRows.map((policy) => [policy.id, policy] as const));
  const policies = policyRows.map((policy) => {
    const history = receiptByChannel.get(policy.channelId) ?? [];
    const currentState = history.some((receipt) => receipt.action === "POLICY_SUPERSEDED" && receipt.policyVersionId === policy.id)
      ? "SUPERSEDED" as const
      : history.some((receipt) => receipt.action === "RELEASE_BOUND" && receipt.policyVersionId === policy.id)
        ? "BOUND" as const
        : "DRAFT" as const;
    return Object.freeze({
      id: policy.id,
      workspaceId: policy.workspaceId,
      eventId: policy.eventId,
      channelId: policy.channelId,
      versionNumber: policy.versionNumber,
      purpose: policy.purpose,
      audience: policy.audience,
      visibility: policy.visibility,
      storedState: policy.storedState,
      currentState,
      rule: policy.rule,
      policySchema: policy.policySchema,
      policyFingerprint: policy.policyFingerprint,
      createdByAccountId: policy.createdByAccountId,
      createdAt: policy.createdAt,
    });
  });

  const rows: PublicationAudienceMatrixRow[] = [];
  for (const release of releases) {
    for (const channel of channels) {
      const history = receiptByChannel.get(channel.id) ?? [];
      const bindings = history
        .filter((receipt) => receipt.action === "RELEASE_BOUND" && receipt.releaseVersionId === release.id)
        .sort((left, right) => left.sequenceNumber - right.sequenceNumber || compareText(left.id, right.id));
      const binding = bindings.at(-1) ?? null;
      const bindingDisabled = binding
        ? history.some((receipt) => receipt.action === "BINDING_DISABLED" && receipt.targetReceiptId === binding.id)
        : false;
      const boundPolicy = binding?.policyVersionId ? policyById.get(binding.policyVersionId) ?? null : null;
      const supersededPolicy = boundPolicy
        ? history.some((receipt) => receipt.action === "POLICY_SUPERSEDED" && receipt.policyVersionId === boundPolicy.id)
        : false;
      const exactCurrent = Boolean(validatedCurrent && event.currentReleaseId === release.releaseId &&
        validatedCurrent.releaseId === release.releaseId &&
        validatedCurrent.fingerprint === release.releaseFingerprint);
      const pointerTargetsInvalidRelease = event.currentReleaseId === release.releaseId && !exactCurrent;
      let status: PublicationAudienceMatrixStatus;
      let reason: string;
      if (!binding) {
        if (channel.currentState === "DISABLED") {
          status = "BLOCKED";
          reason = "The immutable channel was explicitly disabled; no authority is carried forward.";
        } else {
          status = "UNAVAILABLE";
          reason = "No exact policy-and-release authority receipt exists for this version and channel.";
        }
      } else if (channel.currentState === "DISABLED") {
        status = "BLOCKED";
        reason = "A later channel-disable receipt blocks this historical binding.";
      } else if (bindingDisabled) {
        status = "BLOCKED";
        reason = "A later binding-disable receipt blocks this exact release authority.";
      } else if (supersededPolicy) {
        status = "BLOCKED";
        reason = "A later policy-supersession receipt blocks reuse of this policy version.";
      } else if (pointerTargetsInvalidRelease) {
        status = "BLOCKED";
        reason = "The public pointer targets this release, but the immutable release does not validate.";
      } else if (exactCurrent) {
        status = "CURRENT";
        reason = "The receipt exactly matches the validated current immutable release.";
      } else {
        status = "SUPERSEDED";
        reason = "The exact binding remains inspectable, but its release is not the validated current release.";
      }
      const rowReceipts = history
        .filter((receipt) => receipt.releaseVersionId === null || receipt.releaseVersionId === release.id)
        .map((receipt) => rowToReceipt(receipt, false));
      rows.push(Object.freeze({
        key: `${release.versionNumber}:${channel.purpose}:${channel.audience}:${channel.visibility}:${channel.key}:${channel.id}`,
        releaseVersionId: release.id,
        releaseId: release.releaseId,
        releaseVersion: release.versionNumber,
        releaseFingerprint: release.releaseFingerprint,
        releaseSealedAt: release.sealedAt,
        channelId: channel.id,
        channelKey: channel.key,
        channelLabel: channel.label,
        purpose: channel.purpose,
        audience: channel.audience,
        visibility: channel.visibility,
        policyVersionId: boundPolicy?.id ?? null,
        policyVersion: boundPolicy?.versionNumber ?? null,
        bindingReceiptId: binding?.id ?? null,
        status,
        reason,
        receipts: Object.freeze(rowReceipts),
      }));
    }
  }
  rows.sort((left, right) => left.releaseVersion - right.releaseVersion ||
    compareText(left.purpose, right.purpose) || compareText(left.audience, right.audience) ||
    compareText(left.visibility, right.visibility) || compareText(left.channelKey, right.channelKey) ||
    compareText(left.channelId, right.channelId));
  const projection = {
    schema: "publication-audience-matrix/v1" as const,
    workspaceId: actor.workspaceId,
    eventId: input.eventId,
    currentReleaseId: event.currentReleaseId,
    currentReleaseValidated: Boolean(validatedCurrent),
    releases: Object.freeze(releases),
    channels: Object.freeze(channels),
    policies: Object.freeze(policies),
    receipts: Object.freeze(receipts),
    rows: Object.freeze(rows),
  };
  return Object.freeze({ ...projection, fingerprint: fingerprintOf(projection) });
}
