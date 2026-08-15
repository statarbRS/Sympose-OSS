import { Buffer } from "node:buffer";

import {
  assertWorkspaceMatch,
  requireCapability,
  type SessionInfo,
} from "../../auth";
import { canonicalJson, deterministicUuid, fingerprintOf, nowIso } from "../../canonical";
import { withTransaction, withTransactionOrSavepoint, type Db } from "../../db";
import { writeAudit } from "../audit";

/**
 * P1 is deliberately a small, explicit memory service. It records only links supplied by an
 * organizer. It does not score proposals, copy review results, infer similarity, or turn an old
 * submission into current decision authority.
 */

export const PROPOSAL_LINEAGE_SCHEMA = "pd01-proposal-lineage/v1" as const;
export const SUBMISSION_DERIVATION_SCHEMA = "pd01-submission-derivation/v1" as const;
export const RESUBMISSION_REQUEST_SCHEMA = "pd01-resubmission-request/v1" as const;
export const PD01_FINGERPRINT_ALGORITHM = "sha256-canonical-json-v1" as const;

export const SUBMISSION_DERIVATION_RELATIONSHIPS = [
  "RESUBMISSION_OF",
  "CARRIED_FORWARD_FROM",
  "COMBINED_FROM",
  "SPLIT_FROM",
  "INVITED_FROM_NEAR_MISS",
] as const;

export type SubmissionDerivationRelationship =
  (typeof SUBMISSION_DERIVATION_RELATIONSHIPS)[number];

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ProposalLineageActor = Pick<
  SessionInfo,
  "workspaceId" | "workspaceSlug" | "accountId" | "role"
>;

export interface CreateProposalLineageInput {
  readonly workspaceSlug: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly displayProjection: JsonValue;
  readonly idempotencyKey: string;
  readonly expectedSubmissionCurrentRevisionId?: string | null;
}

export interface BindSubmissionLineageInput {
  readonly workspaceSlug: string;
  readonly submissionId: string;
  readonly lineageId: string;
  readonly expectedLineageId: null;
  readonly idempotencyKey: string;
  readonly expectedCurrentRevisionId?: string | null;
}

export interface CreateSubmissionDerivationInput {
  readonly workspaceSlug: string;
  readonly relationshipType: SubmissionDerivationRelationship;
  readonly sourceSubmissionId: string;
  readonly sourceSubmissionRevisionId: string;
  readonly targetSubmissionId?: string | null;
  readonly targetSubmissionRevisionId?: string | null;
  readonly actorAccountId?: string;
  readonly reason: string;
  readonly guidanceRequestId?: string | null;
  readonly guidanceReference?: string | null;
  readonly idempotencyKey: string;
  readonly expectedTargetCurrentRevisionId?: string | null;
}

export interface CreateResubmissionRequestInput {
  readonly workspaceSlug: string;
  readonly sourceSubmissionId: string;
  readonly sourceSubmissionRevisionId: string;
  readonly targetCallId?: string | null;
  readonly guidanceVersion: string;
  readonly guidance: JsonValue;
  readonly createdByAccountId?: string;
  readonly expiresAt?: string | null;
  readonly idempotencyKey: string;
}

export interface ReadLineageTimelineInput {
  readonly workspaceSlug: string;
  readonly lineageId: string;
}

export interface ReadResubmissionGuidanceInput {
  readonly workspaceSlug: string;
  readonly requestId: string;
}

const ERROR_MESSAGES = {
  INPUT_INVALID: "The proposal-lineage input is invalid.",
  AUTHORIZATION_DENIED: "The proposal-lineage action is not available.",
  TARGET_UNAVAILABLE: "The proposal-lineage target is not available.",
  BINDING_CONFLICT: "The proposal-lineage binding is stale or already assigned.",
  REVISION_STALE: "The proposal revision is stale.",
  IDEMPOTENCY_CONFLICT: "The idempotency key conflicts with an earlier request.",
  RELATIONSHIP_INVALID: "The proposal derivation relationship is invalid.",
  GUIDANCE_MISMATCH: "The resubmission guidance does not match the source revision.",
  CYCLE_DETECTED: "The proposal derivation would create a cycle.",
  READ_FAILED: "The proposal-lineage record could not be read safely.",
  WRITE_FAILED: "The proposal-lineage record could not be written.",
} as const;

export type ProposalLineageErrorCode = keyof typeof ERROR_MESSAGES;

export class ProposalLineageError extends Error {
  readonly code: ProposalLineageErrorCode;

  constructor(code: ProposalLineageErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProposalLineageError";
    this.code = code;
  }
}

function fail(code: ProposalLineageErrorCode): never {
  throw new ProposalLineageError(code);
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const IDENTIFIER_PATTERN = /^[^\u0000-\u001F\u007F-\u009F]{1,128}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const OWN = Object.prototype.hasOwnProperty;
const RELATIONSHIP_SET = new Set<string>(SUBMISSION_DERIVATION_RELATIONSHIPS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value: object): readonly string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) fail("INPUT_INVALID");
  return keys as string[];
}

function readProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) fail("INPUT_INVALID");
  return descriptor.value;
}

function readOptionalProperty(value: Record<string, unknown>, key: string): unknown {
  if (!OWN.call(value, key)) return undefined;
  return readProperty(value, key);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const expectedSet = new Set([...required, ...optional]);
  const keys = ownKeys(value);
  if (keys.some((key) => !expectedSet.has(key)) || required.some((key) => !OWN.call(value, key))) {
    fail("INPUT_INVALID");
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("INPUT_INVALID");
  }
  return value;
}

function optionalIdentifier(value: unknown): string | null {
  return value === null || value === undefined ? null : identifier(value);
}

function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maxBytes
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("INPUT_INVALID");
  }
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) fail("READ_FAILED");
  return value;
}

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) fail("INPUT_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => jsonValue(item, depth + 1)));
  if (!isRecord(value)) fail("INPUT_INVALID");
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of ownKeys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") fail("INPUT_INVALID");
    result[key] = jsonValue(readProperty(value, key), depth + 1);
  }
  const encoded = canonicalJson(result);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > 524288) fail("INPUT_INVALID");
  return Object.freeze(result);
}

function canonicalDocument(value: unknown): { readonly value: JsonValue; readonly json: string } {
  const safe = jsonValue(value);
  const json = canonicalJson(safe);
  if (typeof json !== "string") fail("INPUT_INVALID");
  return Object.freeze({ value: safe, json });
}

function timestamp(value: unknown, code: ProposalLineageErrorCode): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(code);
  return value;
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => freeze(item));
  } else if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => freeze(item));
  }
  return Object.freeze(value);
}

function actorAccountId(actor: ProposalLineageActor): string {
  return identifier(actor.accountId);
}

function authorize(db: Db, actor: ProposalLineageActor, workspaceSlug: string): void {
  try {
    const actorWorkspaceId = identifier(actor.workspaceId);
    const actorWorkspaceSlug = identifier(actor.workspaceSlug);
    const accountId = actorAccountId(actor);
    const actorRole = identifier(actor.role);
    const requestedWorkspaceSlug = identifier(workspaceSlug);
    const account = db.prepare(`SELECT a.id, a.workspace_id, a.role, w.slug
      FROM accounts a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = ?`).get(accountId) as
      { id?: unknown; workspace_id?: unknown; role?: unknown; slug?: unknown } | undefined;
    // Prove the server-session/account tuple before requireCapability can append a denial audit.
    if (!account || account.id !== accountId || account.workspace_id !== actorWorkspaceId
      || account.role !== actorRole || account.slug !== actorWorkspaceSlug) fail("AUTHORIZATION_DENIED");
    assertWorkspaceMatch({ ...actor, workspaceId: actorWorkspaceId, workspaceSlug: actorWorkspaceSlug,
      accountId, role: actorRole } as SessionInfo, requestedWorkspaceSlug);
    requireCapability(db, { ...actor, workspaceId: actorWorkspaceId, workspaceSlug: actorWorkspaceSlug,
      accountId, role: actorRole } as SessionInfo, "phase0.pipeline.manage");
  } catch (error) {
    if (error instanceof ProposalLineageError) throw error;
    // Keep capability denials recognizable while not exposing target existence.
    if (error instanceof Error && error.name === "DenialError") throw error;
    fail("AUTHORIZATION_DENIED");
  }
}

function safeCommandInput(input: unknown): Record<string, unknown> {
  try {
    if (!isRecord(input)) fail("INPUT_INVALID");
    // Copying is intentional: command values are captured before any transaction or SQL read.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys(input)) result[key] = readProperty(input, key);
    return result;
  } catch (error) {
    if (error instanceof ProposalLineageError) throw error;
    fail("INPUT_INVALID");
  }
}

function normalizeSafely<T>(normalize: () => T): T {
  try {
    return normalize();
  } catch (error) {
    if (error instanceof ProposalLineageError) throw error;
    fail("INPUT_INVALID");
  }
}

function requestId(kind: string, workspaceId: string, accountId: string, idempotencyKey: string): string {
  return deterministicUuid(`pd01:${kind}:${workspaceId}:${accountId}:${idempotencyKey}`);
}

function commandAuditReplay(
  db: Db,
  workspaceId: string,
  accountId: string,
  action: string,
  idempotencyKey: string,
  requestFingerprint: string,
): { readonly targetId: string; readonly details: Readonly<Record<string, unknown>> } | null {
  const rows = db.prepare(
    `SELECT target_id, details_json FROM audit_events
     WHERE workspace_id = ? AND actor_kind = 'account' AND actor_ref = ?
       AND action = ? AND target_type = 'proposal-lineage' ORDER BY rowid`,
  ).all(workspaceId, accountId, action) as Array<{ target_id: unknown; details_json: unknown }>;
  let replay: { targetId: string; details: Readonly<Record<string, unknown>> } | null = null;
  for (const row of rows) {
    if (typeof row.details_json !== "string") continue;
    try {
      const details = JSON.parse(row.details_json) as Record<string, unknown>;
      if (details.idempotencyKey !== idempotencyKey) continue;
      if (details.requestFingerprint !== requestFingerprint) fail("IDEMPOTENCY_CONFLICT");
      const targetId = identifier(row.target_id);
      if (replay !== null && replay.targetId !== targetId) fail("READ_FAILED");
      replay = { targetId, details: Object.freeze(details) };
    } catch (error) {
      if (error instanceof ProposalLineageError) throw error;
      fail("READ_FAILED");
    }
  }
  return replay;
}

function writeCommandAudit(
  db: Db,
  workspaceId: string,
  accountId: string,
  action: string,
  targetId: string,
  idempotencyKey: string,
  requestFingerprint: string,
  extraDetails?: Record<string, unknown>,
): void {
  writeAudit(db, workspaceId, {
    actorKind: "account",
    actorRef: accountId,
    action,
    targetType: "proposal-lineage",
    targetId,
    details: { idempotencyKey, requestFingerprint, ...extraDetails },
  });
}

type SubmissionRow = {
  id: unknown;
  workspace_id: unknown;
  event_id: unknown;
  call_id: unknown;
  current_revision_id: unknown;
  lineage_id: unknown;
  state: unknown;
};

type RevisionRow = {
  id: unknown;
  workspace_id: unknown;
  submission_id: unknown;
  revision_number: unknown;
  revision_schema: unknown;
  fingerprint_algorithm: unknown;
  fingerprint: unknown;
  created_at: unknown;
};

function storedSubmission(row: SubmissionRow, workspaceId: string): {
  readonly id: string; readonly workspaceId: string; readonly eventId: string; readonly callId: string;
  readonly currentRevisionId: string | null; readonly lineageId: string | null; readonly state: string;
} {
  try {
    const id = identifier(row.id);
    const storedWorkspace = identifier(row.workspace_id);
    const eventId = identifier(row.event_id);
    const callId = identifier(row.call_id);
    const currentRevisionId = row.current_revision_id === null ? null : identifier(row.current_revision_id);
    const lineageId = row.lineage_id === null ? null : identifier(row.lineage_id);
    const state = identifier(row.state);
    if (storedWorkspace !== workspaceId) fail("READ_FAILED");
    return freeze({ id, workspaceId: storedWorkspace, eventId, callId, currentRevisionId, lineageId, state });
  } catch (error) {
    if (error instanceof ProposalLineageError) throw error;
    fail("READ_FAILED");
  }
}

function storedRevision(row: RevisionRow, workspaceId: string, submissionId: string): {
  readonly id: string; readonly workspaceId: string; readonly submissionId: string;
  readonly revisionNumber: number; readonly fingerprint: string; readonly createdAt: string;
} {
  try {
    const id = identifier(row.id);
    const storedWorkspace = identifier(row.workspace_id);
    const storedSubmission = identifier(row.submission_id);
    if (storedWorkspace !== workspaceId || storedSubmission !== submissionId
      || row.revision_schema !== "cfp-submission-revision/v1"
      || row.fingerprint_algorithm !== PD01_FINGERPRINT_ALGORITHM) fail("READ_FAILED");
    if (typeof row.revision_number !== "number" || !Number.isSafeInteger(row.revision_number) || row.revision_number < 1) {
      fail("READ_FAILED");
    }
    const revisionFingerprint = fingerprint(row.fingerprint);
    const createdAt = timestamp(row.created_at, "READ_FAILED");
    return freeze({ id, workspaceId: storedWorkspace, submissionId: storedSubmission,
      revisionNumber: row.revision_number, fingerprint: revisionFingerprint, createdAt });
  } catch (error) {
    if (error instanceof ProposalLineageError) throw error;
    fail("READ_FAILED");
  }
}

function loadSubmission(db: Db, workspaceId: string, submissionId: string): ReturnType<typeof storedSubmission> {
  const rows = db.prepare(
    `SELECT id, workspace_id, event_id, call_id, current_revision_id, lineage_id, state
     FROM submissions WHERE workspace_id = ? AND id = ?`,
  ).all(workspaceId, submissionId) as unknown as SubmissionRow[];
  if (rows.length !== 1) fail("TARGET_UNAVAILABLE");
  return storedSubmission(rows[0]!, workspaceId);
}

function loadRevision(
  db: Db,
  workspaceId: string,
  submissionId: string,
  revisionId: string,
): ReturnType<typeof storedRevision> {
  const rows = db.prepare(
    `SELECT id, workspace_id, submission_id, revision_number, revision_schema,
            fingerprint_algorithm, fingerprint, created_at
     FROM submission_revisions
     WHERE workspace_id = ? AND submission_id = ? AND id = ?`,
  ).all(workspaceId, submissionId, revisionId) as unknown as RevisionRow[];
  if (rows.length !== 1) fail("TARGET_UNAVAILABLE");
  return storedRevision(rows[0]!, workspaceId, submissionId);
}

function loadLineage(db: Db, workspaceId: string, lineageId: string): {
  readonly id: string; readonly workspaceId: string; readonly originatingSubmissionId: string | null;
  readonly originatingSubmissionRevisionId: string | null; readonly displayProjection: JsonValue;
  readonly createdByAccountId: string; readonly createdAt: string;
} {
  const rows = db.prepare(
    `SELECT id, workspace_id, originating_submission_id, originating_submission_revision_id,
            display_projection_json, created_by_account_id, created_at
     FROM proposal_lineages WHERE workspace_id = ? AND id = ?`,
  ).all(workspaceId, lineageId) as Array<Record<string, unknown>>;
  if (rows.length !== 1) fail("TARGET_UNAVAILABLE");
  const row = rows[0]!;
  try {
    const id = identifier(row.id);
    const storedWorkspace = identifier(row.workspace_id);
    const originatingSubmissionId = row.originating_submission_id === null ? null : identifier(row.originating_submission_id);
    const originatingRevisionId = row.originating_submission_revision_id === null ? null : identifier(row.originating_submission_revision_id);
    const projection = parseStoredJson(row.display_projection_json);
    const createdByAccountId = identifier(row.created_by_account_id);
    const createdAt = timestamp(row.created_at, "READ_FAILED");
    if (storedWorkspace !== workspaceId || (originatingSubmissionId === null) !== (originatingRevisionId === null)) fail("READ_FAILED");
    const account = db.prepare("SELECT id, workspace_id FROM accounts WHERE id = ?").get(createdByAccountId) as { id?: unknown; workspace_id?: unknown } | undefined;
    if (!account || account.id !== createdByAccountId || account.workspace_id !== workspaceId) fail("READ_FAILED");
    if (originatingSubmissionId !== null) loadRevision(db, workspaceId, originatingSubmissionId, originatingRevisionId!);
    return freeze({ id, workspaceId: storedWorkspace, originatingSubmissionId,
      originatingSubmissionRevisionId: originatingRevisionId, displayProjection: projection,
      createdByAccountId, createdAt });
  } catch (error) {
    if (error instanceof ProposalLineageError) throw error;
    fail("READ_FAILED");
  }
}

function parseStoredJson(value: unknown): JsonValue {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 524288) fail("READ_FAILED");
  try {
    const parsed = JSON.parse(value) as unknown;
    const document = jsonValue(parsed);
    if (canonicalJson(document) !== value) fail("READ_FAILED");
    return document;
  } catch (error) {
    if (error instanceof ProposalLineageError) throw error;
    fail("READ_FAILED");
  }
}

function commandFingerprint(document: Record<string, unknown>): string {
  return fingerprintOf(document);
}

function normalizeCreateLineage(input: unknown) {
  return normalizeSafely(() => normalizeCreateLineageUnsafe(input));
}

function normalizeCreateLineageUnsafe(input: unknown) {
  const safe = safeCommandInput(input);
  exactKeys(safe, ["workspaceSlug", "submissionId", "submissionRevisionId", "displayProjection", "idempotencyKey"], ["expectedSubmissionCurrentRevisionId"]);
  const projection = canonicalDocument(readProperty(safe, "displayProjection"));
  const command = {
    workspaceSlug: identifier(readProperty(safe, "workspaceSlug")),
    submissionId: identifier(readProperty(safe, "submissionId")),
    submissionRevisionId: identifier(readProperty(safe, "submissionRevisionId")),
    displayProjection: projection.value,
    displayProjectionJson: projection.json,
    idempotencyKey: identifier(readProperty(safe, "idempotencyKey")),
    expectedSubmissionCurrentRevisionId: optionalIdentifier(readOptionalProperty(safe, "expectedSubmissionCurrentRevisionId")),
  };
  return Object.freeze({ ...command, requestFingerprint: commandFingerprint(command) });
}

function normalizeBind(input: unknown) {
  return normalizeSafely(() => normalizeBindUnsafe(input));
}

function normalizeBindUnsafe(input: unknown) {
  const safe = safeCommandInput(input);
  exactKeys(safe, ["workspaceSlug", "submissionId", "lineageId", "expectedLineageId", "idempotencyKey"], ["expectedCurrentRevisionId"]);
  if (readProperty(safe, "expectedLineageId") !== null) fail("INPUT_INVALID");
  const command = {
    workspaceSlug: identifier(readProperty(safe, "workspaceSlug")),
    submissionId: identifier(readProperty(safe, "submissionId")),
    lineageId: identifier(readProperty(safe, "lineageId")),
    expectedLineageId: null,
    idempotencyKey: identifier(readProperty(safe, "idempotencyKey")),
    expectedCurrentRevisionId: optionalIdentifier(readOptionalProperty(safe, "expectedCurrentRevisionId")),
  };
  return Object.freeze({ ...command, requestFingerprint: commandFingerprint(command) });
}

function normalizeDerivation(input: unknown, actor: ProposalLineageActor) {
  return normalizeSafely(() => normalizeDerivationUnsafe(input, actor));
}

function normalizeDerivationUnsafe(input: unknown, actor: ProposalLineageActor) {
  const safe = safeCommandInput(input);
  exactKeys(safe, ["workspaceSlug", "relationshipType", "sourceSubmissionId", "sourceSubmissionRevisionId", "reason", "idempotencyKey"], ["targetSubmissionId", "targetSubmissionRevisionId", "actorAccountId", "guidanceRequestId", "guidanceReference", "expectedTargetCurrentRevisionId"]);
  const targetSubmissionId = optionalIdentifier(readOptionalProperty(safe, "targetSubmissionId"));
  const targetRevisionId = optionalIdentifier(readOptionalProperty(safe, "targetSubmissionRevisionId"));
  if ((targetSubmissionId === null) !== (targetRevisionId === null)) fail("INPUT_INVALID");
  const relationshipType = readProperty(safe, "relationshipType");
  if (typeof relationshipType !== "string" || !RELATIONSHIP_SET.has(relationshipType)) fail("RELATIONSHIP_INVALID");
  const suppliedActor = optionalIdentifier(readOptionalProperty(safe, "actorAccountId"));
  if (suppliedActor !== null && suppliedActor !== actorAccountId(actor)) fail("AUTHORIZATION_DENIED");
  const guidanceReference = optionalIdentifier(readOptionalProperty(safe, "guidanceReference"));
  const command = {
    workspaceSlug: identifier(readProperty(safe, "workspaceSlug")), relationshipType: relationshipType as SubmissionDerivationRelationship,
    sourceSubmissionId: identifier(readProperty(safe, "sourceSubmissionId")), sourceSubmissionRevisionId: identifier(readProperty(safe, "sourceSubmissionRevisionId")),
    targetSubmissionId, targetSubmissionRevisionId: targetRevisionId, actorAccountId: actorAccountId(actor),
    reason: boundedText(readProperty(safe, "reason"), 4096), guidanceRequestId: optionalIdentifier(readOptionalProperty(safe, "guidanceRequestId")),
    guidanceReference, idempotencyKey: identifier(readProperty(safe, "idempotencyKey")),
    expectedTargetCurrentRevisionId: optionalIdentifier(readOptionalProperty(safe, "expectedTargetCurrentRevisionId")),
  };
  return Object.freeze({ ...command, requestFingerprint: commandFingerprint(command) });
}

function normalizeRequest(input: unknown, actor: ProposalLineageActor) {
  return normalizeSafely(() => normalizeRequestUnsafe(input, actor));
}

function normalizeRequestUnsafe(input: unknown, actor: ProposalLineageActor) {
  const safe = safeCommandInput(input);
  exactKeys(safe, ["workspaceSlug", "sourceSubmissionId", "sourceSubmissionRevisionId", "guidanceVersion", "guidance", "idempotencyKey"], ["targetCallId", "createdByAccountId", "expiresAt"]);
  const guidance = canonicalDocument(readProperty(safe, "guidance"));
  const suppliedActor = optionalIdentifier(readOptionalProperty(safe, "createdByAccountId"));
  if (suppliedActor !== null && suppliedActor !== actorAccountId(actor)) fail("AUTHORIZATION_DENIED");
  const expiresValue = readOptionalProperty(safe, "expiresAt");
  const expiresAt = expiresValue === null || expiresValue === undefined
    ? null : timestamp(expiresValue, "INPUT_INVALID");
  const command = {
    workspaceSlug: identifier(readProperty(safe, "workspaceSlug")), sourceSubmissionId: identifier(readProperty(safe, "sourceSubmissionId")),
    sourceSubmissionRevisionId: identifier(readProperty(safe, "sourceSubmissionRevisionId")), targetCallId: optionalIdentifier(readOptionalProperty(safe, "targetCallId")),
    guidanceVersion: boundedText(readProperty(safe, "guidanceVersion"), 128), guidance: guidance.value, guidanceJson: guidance.json,
    createdByAccountId: actorAccountId(actor), expiresAt, idempotencyKey: identifier(readProperty(safe, "idempotencyKey")),
  };
  return Object.freeze({ ...command, requestFingerprint: commandFingerprint(command) });
}

function expectedCurrentRevision(
  submission: ReturnType<typeof storedSubmission>,
  expected: string | null,
): void {
  if (expected !== null && submission.currentRevisionId !== expected) fail("REVISION_STALE");
}

export interface ProposalLineageReceipt {
  readonly lineageId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface SubmissionLineageBindReceipt {
  readonly submissionId: string;
  readonly lineageId: string;
  readonly boundAt: string;
  readonly replayed: boolean;
}

export interface SubmissionDerivationReceipt {
  readonly derivationId: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface ResubmissionRequestReceipt {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly replayed: boolean;
}

function createLineageInternal(db: Db, actor: ProposalLineageActor, input: unknown): ProposalLineageReceipt {
  const command = normalizeCreateLineage(input);
  authorize(db, actor, command.workspaceSlug);
  const lineageId = requestId("lineage", actor.workspaceId, actor.accountId, command.idempotencyKey);
  return withTransactionOrSavepoint(db, "pd01_create_lineage", () => {
    const replay = commandAuditReplay(db, actor.workspaceId, actor.accountId, "pd01.proposal_lineage.created",
      command.idempotencyKey, command.requestFingerprint);
    if (replay !== null && replay.targetId !== lineageId) fail("IDEMPOTENCY_CONFLICT");
    const submission = loadSubmission(db, actor.workspaceId, command.submissionId);
    const revision = loadRevision(db, actor.workspaceId, command.submissionId, command.submissionRevisionId);
    const existing = db.prepare("SELECT id FROM proposal_lineages WHERE workspace_id = ? AND id = ?").get(actor.workspaceId, lineageId) as { id?: unknown } | undefined;
    if (existing) {
      if (replay === null) fail("READ_FAILED");
      const stored = loadLineage(db, actor.workspaceId, lineageId);
      if (stored.originatingSubmissionId !== command.submissionId || stored.originatingSubmissionRevisionId !== command.submissionRevisionId
        || canonicalJson(stored.displayProjection) !== command.displayProjectionJson || stored.createdByAccountId !== actor.accountId) fail("IDEMPOTENCY_CONFLICT");
      return freeze({ lineageId, submissionId: command.submissionId, submissionRevisionId: revision.id, createdAt: stored.createdAt, replayed: true });
    }
    if (replay !== null) fail("READ_FAILED");
    expectedCurrentRevision(submission, command.expectedSubmissionCurrentRevisionId);
    const createdAt = nowIso();
    try {
      db.prepare(`INSERT INTO proposal_lineages
        (id, workspace_id, originating_submission_id, originating_submission_revision_id,
         display_projection_json, created_by_account_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(lineageId, actor.workspaceId, command.submissionId, command.submissionRevisionId,
          command.displayProjectionJson, actor.accountId, createdAt);
      writeCommandAudit(db, actor.workspaceId, actor.accountId, "pd01.proposal_lineage.created", lineageId,
        command.idempotencyKey, command.requestFingerprint);
    } catch {
      fail("WRITE_FAILED");
    }
    return freeze({ lineageId, submissionId: command.submissionId, submissionRevisionId: revision.id, createdAt, replayed: false });
  });
}

function bindInternal(db: Db, actor: ProposalLineageActor, input: unknown): SubmissionLineageBindReceipt {
  const command = normalizeBind(input);
  authorize(db, actor, command.workspaceSlug);
  return withTransactionOrSavepoint(db, "pd01_bind_lineage", () => {
    const replayed = commandAuditReplay(db, actor.workspaceId, actor.accountId, "pd01.proposal_lineage.bound",
      command.idempotencyKey, command.requestFingerprint);
    if (replayed !== null && replayed.targetId !== command.submissionId) fail("IDEMPOTENCY_CONFLICT");
    const submission = loadSubmission(db, actor.workspaceId, command.submissionId);
    loadLineage(db, actor.workspaceId, command.lineageId);
    if (replayed !== null) {
      if (submission.lineageId !== command.lineageId) fail("READ_FAILED");
      const boundAt = timestamp(replayed.details.boundAt, "READ_FAILED");
      return freeze({ submissionId: command.submissionId, lineageId: command.lineageId, boundAt, replayed: true });
    }
    expectedCurrentRevision(submission, command.expectedCurrentRevisionId);
    if (submission.lineageId !== null) fail("BINDING_CONFLICT");
    const boundAt = nowIso();
    try {
      const result = db.prepare(
        `UPDATE submissions SET lineage_id = ?, updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
         WHERE workspace_id = ? AND id = ? AND lineage_id IS NULL`,
      ).run(command.lineageId, boundAt, boundAt, actor.workspaceId, command.submissionId);
      if (result.changes !== 1) fail("BINDING_CONFLICT");
      writeCommandAudit(db, actor.workspaceId, actor.accountId, "pd01.proposal_lineage.bound", command.submissionId,
        command.idempotencyKey, command.requestFingerprint, { boundAt });
    } catch (error) {
      if (error instanceof ProposalLineageError) throw error;
      fail("WRITE_FAILED");
    }
    return freeze({ submissionId: command.submissionId, lineageId: command.lineageId, boundAt, replayed: false });
  });
}

function createRequestInternal(db: Db, actor: ProposalLineageActor, input: unknown): ResubmissionRequestReceipt {
  const command = normalizeRequest(input, actor);
  authorize(db, actor, command.workspaceSlug);
  const requestIdValue = requestId("resubmission", actor.workspaceId, actor.accountId, command.idempotencyKey);
  return withTransaction(db, () => {
    const replay = commandAuditReplay(db, actor.workspaceId, actor.accountId, "pd01.resubmission_request.created",
      command.idempotencyKey, command.requestFingerprint);
    if (replay !== null && replay.targetId !== requestIdValue) fail("IDEMPOTENCY_CONFLICT");
    const source = loadSubmission(db, actor.workspaceId, command.sourceSubmissionId);
    const revision = loadRevision(db, actor.workspaceId, command.sourceSubmissionId, command.sourceSubmissionRevisionId);
    const targetCall = command.targetCallId === null ? null : (db.prepare(
      "SELECT id, workspace_id FROM calls WHERE workspace_id = ? AND id = ?",
    ).get(actor.workspaceId, command.targetCallId) as { id?: unknown; workspace_id?: unknown } | undefined);
    if (command.targetCallId !== null && (!targetCall || targetCall.id !== command.targetCallId || targetCall.workspace_id !== actor.workspaceId)) fail("TARGET_UNAVAILABLE");
    const existing = db.prepare("SELECT id, fingerprint, source_submission_id, source_submission_revision_id, target_call_id, guidance_version, guidance_json, created_by_account_id, created_at, expires_at FROM resubmission_requests WHERE workspace_id = ? AND id = ?")
      .get(actor.workspaceId, requestIdValue) as Record<string, unknown> | undefined;
    const document = { schema: RESUBMISSION_REQUEST_SCHEMA, workspaceId: actor.workspaceId, sourceSubmissionId: command.sourceSubmissionId,
      sourceSubmissionRevisionId: command.sourceSubmissionRevisionId, targetCallId: command.targetCallId, guidanceVersion: command.guidanceVersion,
      guidance: command.guidance, createdByAccountId: actor.accountId, createdAt: existing?.created_at ?? nowIso(), expiresAt: command.expiresAt };
    const expectedFingerprint = fingerprintOf(document);
    if (existing) {
      if (replay === null) fail("READ_FAILED");
      if (fingerprint(existing.fingerprint) !== expectedFingerprint || existing.source_submission_id !== command.sourceSubmissionId
        || existing.source_submission_revision_id !== command.sourceSubmissionRevisionId || existing.target_call_id !== command.targetCallId
        || existing.guidance_version !== command.guidanceVersion || existing.guidance_json !== command.guidanceJson
        || existing.created_by_account_id !== actor.accountId || existing.expires_at !== command.expiresAt) fail("IDEMPOTENCY_CONFLICT");
      timestamp(existing.created_at, "READ_FAILED");
      return freeze({ requestId: requestIdValue, fingerprint: expectedFingerprint, createdAt: existing.created_at as string, replayed: true });
    }
    if (replay !== null) fail("READ_FAILED");
    const createdAt = nowIso();
    const storedDocument = { ...document, createdAt };
    const storedFingerprint = fingerprintOf(storedDocument);
    try {
      db.prepare(`INSERT INTO resubmission_requests
        (id, workspace_id, source_submission_id, source_submission_revision_id, target_call_id,
         guidance_version, guidance_json, created_by_account_id, created_at, expires_at, fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(requestIdValue, actor.workspaceId, source.id, revision.id, command.targetCallId, command.guidanceVersion,
          command.guidanceJson, actor.accountId, createdAt, command.expiresAt, storedFingerprint);
      writeCommandAudit(db, actor.workspaceId, actor.accountId, "pd01.resubmission_request.created", requestIdValue,
        command.idempotencyKey, command.requestFingerprint);
    } catch {
      fail("WRITE_FAILED");
    }
    return freeze({ requestId: requestIdValue, fingerprint: storedFingerprint, createdAt, replayed: false });
  });
}

function createDerivationInternal(db: Db, actor: ProposalLineageActor, input: unknown): SubmissionDerivationReceipt {
  const command = normalizeDerivation(input, actor);
  authorize(db, actor, command.workspaceSlug);
  const derivationId = requestId("derivation", actor.workspaceId, actor.accountId, command.idempotencyKey);
  return withTransaction(db, () => {
    const replay = commandAuditReplay(db, actor.workspaceId, actor.accountId, "pd01.submission_derivation.created",
      command.idempotencyKey, command.requestFingerprint);
    if (replay !== null && replay.targetId !== derivationId) fail("IDEMPOTENCY_CONFLICT");
    const source = loadSubmission(db, actor.workspaceId, command.sourceSubmissionId);
    const sourceRevision = loadRevision(db, actor.workspaceId, command.sourceSubmissionId, command.sourceSubmissionRevisionId);
    let target: ReturnType<typeof storedSubmission> | null = null;
    let targetRevision: ReturnType<typeof storedRevision> | null = null;
    if (command.targetSubmissionId !== null) {
      target = loadSubmission(db, actor.workspaceId, command.targetSubmissionId!);
      targetRevision = loadRevision(db, actor.workspaceId, command.targetSubmissionId!, command.targetSubmissionRevisionId!);
      if (source.id === target.id) fail("RELATIONSHIP_INVALID");
      const reachesSource = db.prepare(`WITH RECURSIVE chain(id) AS (
        SELECT target_submission_id FROM submission_derivations WHERE workspace_id = ? AND source_submission_id = ?
        UNION SELECT d.target_submission_id FROM submission_derivations d JOIN chain c ON d.source_submission_id = c.id
      ) SELECT 1 FROM chain WHERE id = ? LIMIT 1`).get(actor.workspaceId, target.id, source.id);
      if (reachesSource) fail("CYCLE_DETECTED");
    } else if (command.expectedTargetCurrentRevisionId !== null) {
      fail("INPUT_INVALID");
    }
    let guidance: Record<string, unknown> | undefined;
    if (command.guidanceRequestId !== null) {
      guidance = db.prepare(`SELECT id, workspace_id, source_submission_id, source_submission_revision_id,
          target_call_id, guidance_version, guidance_json, created_by_account_id, created_at, expires_at, fingerprint
        FROM resubmission_requests WHERE workspace_id = ? AND id = ?`).get(actor.workspaceId, command.guidanceRequestId) as Record<string, unknown> | undefined;
      if (!guidance) fail("GUIDANCE_MISMATCH");
      if (guidance.source_submission_id !== source.id || guidance.source_submission_revision_id !== sourceRevision.id) fail("GUIDANCE_MISMATCH");
      if (target && guidance.target_call_id !== null && guidance.target_call_id !== target.callId) fail("GUIDANCE_MISMATCH");
      parseStoredJson(guidance.guidance_json);
      fingerprint(guidance.fingerprint);
    }
    const document = { schema: SUBMISSION_DERIVATION_SCHEMA, workspaceId: actor.workspaceId, relationshipType: command.relationshipType,
      sourceSubmissionId: source.id, sourceSubmissionRevisionId: sourceRevision.id, targetSubmissionId: target?.id ?? null,
      targetSubmissionRevisionId: targetRevision?.id ?? null, actorAccountId: actor.accountId, reason: command.reason,
      guidanceRequestId: command.guidanceRequestId, guidanceReference: command.guidanceReference, createdAt: "" };
    const existing = db.prepare(`SELECT id, workspace_id, relationship_type, source_submission_id, source_submission_revision_id,
      target_submission_id, target_submission_revision_id, actor_account_id, reason, guidance_request_id,
      guidance_reference, created_at, fingerprint FROM submission_derivations WHERE workspace_id = ? AND id = ?`)
      .get(actor.workspaceId, derivationId) as Record<string, unknown> | undefined;
    if (existing) {
      if (replay === null) fail("READ_FAILED");
      const existingCreatedAt = timestamp(existing.created_at, "READ_FAILED");
      const replayDocument = { ...document, createdAt: existingCreatedAt };
      const replayFingerprint = fingerprint(existing.fingerprint);
      if (replayFingerprint !== fingerprintOf(replayDocument)
        || existing.relationship_type !== command.relationshipType || existing.source_submission_id !== source.id
        || existing.source_submission_revision_id !== sourceRevision.id || existing.target_submission_id !== (target?.id ?? null)
        || existing.target_submission_revision_id !== (targetRevision?.id ?? null) || existing.actor_account_id !== actor.accountId
        || existing.reason !== command.reason || existing.guidance_request_id !== command.guidanceRequestId
        || existing.guidance_reference !== command.guidanceReference) fail("IDEMPOTENCY_CONFLICT");
      return freeze({ derivationId, fingerprint: replayFingerprint, createdAt: existingCreatedAt, replayed: true });
    }
    if (replay !== null) fail("READ_FAILED");
    if (target) expectedCurrentRevision(target, command.expectedTargetCurrentRevisionId);
    const createdAt = nowIso();
    const storedFingerprint = fingerprintOf({ ...document, createdAt });
    try {
      db.prepare(`INSERT INTO submission_derivations
        (id, workspace_id, relationship_type, source_submission_id, source_submission_revision_id,
         target_submission_id, target_submission_revision_id, actor_account_id, reason,
         guidance_request_id, guidance_reference, created_at, fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(derivationId, actor.workspaceId, command.relationshipType, source.id, sourceRevision.id,
          target?.id ?? null, targetRevision?.id ?? null, actor.accountId, command.reason,
          command.guidanceRequestId, command.guidanceReference, createdAt, storedFingerprint);
      writeCommandAudit(db, actor.workspaceId, actor.accountId, "pd01.submission_derivation.created", derivationId,
        command.idempotencyKey, command.requestFingerprint);
    } catch {
      fail("WRITE_FAILED");
    }
    return freeze({ derivationId, fingerprint: storedFingerprint, createdAt, replayed: false });
  });
}

export interface LineageTimeline {
  readonly lineage: ReturnType<typeof loadLineage>;
  readonly submissions: readonly (ReturnType<typeof storedSubmission> & { readonly revisions: readonly ReturnType<typeof storedRevision>[] })[];
  readonly derivations: readonly Record<string, unknown>[];
  readonly resubmissionRequests: readonly Record<string, unknown>[];
}

function readTimelineInternal(db: Db, actor: ProposalLineageActor, input: unknown): LineageTimeline {
  const safe = safeCommandInput(input);
  exactKeys(safe, ["workspaceSlug", "lineageId"]);
  const workspaceSlug = identifier(readProperty(safe, "workspaceSlug"));
  const lineageId = identifier(readProperty(safe, "lineageId"));
  authorize(db, actor, workspaceSlug);
  const lineage = loadLineage(db, actor.workspaceId, lineageId);
  const submissionRows = db.prepare(`WITH RECURSIVE
      edges(source_id, target_id) AS (
        SELECT source_submission_id, target_submission_id FROM submission_derivations
        WHERE workspace_id = ? AND target_submission_id IS NOT NULL
      ),
      connected(id) AS (
        SELECT id FROM submissions
        WHERE workspace_id = ? AND (lineage_id = ? OR id = ?)
        UNION
        SELECT CASE WHEN edges.source_id = connected.id THEN edges.target_id ELSE edges.source_id END
        FROM edges JOIN connected ON edges.source_id = connected.id OR edges.target_id = connected.id
      )
    SELECT s.id, s.workspace_id, s.event_id, s.call_id, s.current_revision_id, s.lineage_id, s.state
    FROM submissions s JOIN connected ON connected.id = s.id
    WHERE s.workspace_id = ? ORDER BY s.created_at, s.id`)
    .all(actor.workspaceId, actor.workspaceId, lineageId, lineage.originatingSubmissionId, actor.workspaceId) as unknown as SubmissionRow[];
  const submissions = submissionRows.map((row) => {
    const submission = storedSubmission(row, actor.workspaceId);
    const revisions = (db.prepare(`SELECT id, workspace_id, submission_id, revision_number, revision_schema,
        fingerprint_algorithm, fingerprint, created_at FROM submission_revisions
      WHERE workspace_id = ? AND submission_id = ? ORDER BY revision_number, id`).all(actor.workspaceId, submission.id) as unknown as RevisionRow[])
      .map((revision) => storedRevision(revision, actor.workspaceId, submission.id));
    if (revisions.length === 0) fail("READ_FAILED");
    if (submission.currentRevisionId !== null && !revisions.some((revision) => revision.id === submission.currentRevisionId)) fail("READ_FAILED");
    return freeze({ ...submission, revisions });
  });
  const ids = submissions.map((submission) => submission.id);
  const derivations: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];
  for (const row of db.prepare(`SELECT d.id, d.workspace_id, d.relationship_type, d.source_submission_id, d.source_submission_revision_id,
      d.target_submission_id, d.target_submission_revision_id, d.actor_account_id, d.reason, d.guidance_request_id,
      d.guidance_reference, d.created_at, d.fingerprint FROM submission_derivations d WHERE d.workspace_id = ?
      AND (d.source_submission_id IN (${ids.length ? ids.map(() => "?").join(",") : "NULL"})
        OR d.target_submission_id IN (${ids.length ? ids.map(() => "?").join(",") : "NULL"}))
      ORDER BY d.created_at, d.id`).all(actor.workspaceId, ...ids, ...ids) as Array<Record<string, unknown>>) {
    const sourceId = identifier(row.source_submission_id);
    const sourceRevisionId = identifier(row.source_submission_revision_id);
    const targetId = row.target_submission_id === null ? null : identifier(row.target_submission_id);
    const targetRevisionId = row.target_submission_revision_id === null ? null : identifier(row.target_submission_revision_id);
    if (row.workspace_id !== actor.workspaceId) fail("READ_FAILED");
    if (!RELATIONSHIP_SET.has(String(row.relationship_type)) || !ids.includes(sourceId)
      || (targetId !== null && (targetRevisionId === null || !ids.includes(targetId)))) fail("READ_FAILED");
    loadSubmission(db, actor.workspaceId, sourceId);
    loadRevision(db, actor.workspaceId, sourceId, sourceRevisionId);
    if (targetId !== null) {
      loadSubmission(db, actor.workspaceId, targetId);
      loadRevision(db, actor.workspaceId, targetId, targetRevisionId!);
    }
    const storedActorId = identifier(row.actor_account_id);
    const actorRow = db.prepare("SELECT id, workspace_id FROM accounts WHERE id = ?").get(storedActorId) as { id?: unknown; workspace_id?: unknown } | undefined;
    if (!actorRow || actorRow.id !== storedActorId || actorRow.workspace_id !== actor.workspaceId) fail("READ_FAILED");
    const storedFingerprint = fingerprint(row.fingerprint);
    const document = { schema: SUBMISSION_DERIVATION_SCHEMA, workspaceId: actor.workspaceId, relationshipType: row.relationship_type,
      sourceSubmissionId: sourceId, sourceSubmissionRevisionId: sourceRevisionId, targetSubmissionId: targetId,
      targetSubmissionRevisionId: targetRevisionId, actorAccountId: identifier(row.actor_account_id), reason: boundedStoredText(row.reason),
      guidanceRequestId: row.guidance_request_id === null ? null : identifier(row.guidance_request_id), guidanceReference: row.guidance_reference === null ? null : identifier(row.guidance_reference),
      createdAt: timestamp(row.created_at, "READ_FAILED") };
    if (fingerprintOf(document) !== storedFingerprint) fail("READ_FAILED");
    derivations.push(freeze({ id: identifier(row.id), ...document, fingerprint: storedFingerprint }));
    if (document.guidanceRequestId !== null) {
      const guidance = readRequestRow(db, actor.workspaceId, document.guidanceRequestId);
      if (guidance.sourceSubmissionId !== sourceId || guidance.sourceSubmissionRevisionId !== sourceRevisionId) fail("READ_FAILED");
      requests.push(guidance);
    }
  }
  return freeze({ lineage, submissions: freeze(submissions), derivations: freeze(derivations), resubmissionRequests: freeze(requests) });
}

function boundedStoredText(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 4096 || CONTROL_CHARACTER_PATTERN.test(value)) fail("READ_FAILED");
  return value;
}

function readRequestRow(db: Db, workspaceId: string, requestIdValue: string): Record<string, unknown> {
  const row = db.prepare(`SELECT id, workspace_id, source_submission_id, source_submission_revision_id, target_call_id,
    guidance_version, guidance_json, created_by_account_id, created_at, expires_at, fingerprint
    FROM resubmission_requests WHERE workspace_id = ? AND id = ?`).get(workspaceId, requestIdValue) as Record<string, unknown> | undefined;
  if (!row) fail("READ_FAILED");
  if (row.workspace_id !== workspaceId) fail("READ_FAILED");
  const sourceId = identifier(row.source_submission_id);
  const sourceRevisionId = identifier(row.source_submission_revision_id);
  loadRevision(db, workspaceId, sourceId, sourceRevisionId);
  if (row.target_call_id !== null) {
    const targetCallId = identifier(row.target_call_id);
    const call = db.prepare("SELECT id, workspace_id FROM calls WHERE id = ?").get(targetCallId) as { id?: unknown; workspace_id?: unknown } | undefined;
    if (!call || call.id !== targetCallId || call.workspace_id !== workspaceId) fail("READ_FAILED");
  }
  const createdByAccountId = identifier(row.created_by_account_id);
  const account = db.prepare("SELECT id, workspace_id FROM accounts WHERE id = ?").get(createdByAccountId) as { id?: unknown; workspace_id?: unknown } | undefined;
  if (!account || account.id !== createdByAccountId || account.workspace_id !== workspaceId) fail("READ_FAILED");
  const guidance = parseStoredJson(row.guidance_json);
  const document = { schema: RESUBMISSION_REQUEST_SCHEMA, workspaceId, sourceSubmissionId: sourceId, sourceSubmissionRevisionId: sourceRevisionId,
    targetCallId: row.target_call_id === null ? null : identifier(row.target_call_id), guidanceVersion: boundedStoredText(row.guidance_version), guidance,
    createdByAccountId: identifier(row.created_by_account_id), createdAt: timestamp(row.created_at, "READ_FAILED"), expiresAt: row.expires_at === null ? null : timestamp(row.expires_at, "READ_FAILED") };
  const storedFingerprint = fingerprint(row.fingerprint);
  if (fingerprintOf(document) !== storedFingerprint) fail("READ_FAILED");
  return freeze({ id: identifier(row.id), ...document, fingerprint: storedFingerprint, expired: document.expiresAt !== null && Date.parse(document.expiresAt) <= Date.now() });
}

function readGuidanceInternal(db: Db, actor: ProposalLineageActor, input: unknown): Record<string, unknown> {
  const safe = safeCommandInput(input);
  exactKeys(safe, ["workspaceSlug", "requestId"]);
  const workspaceSlug = identifier(readProperty(safe, "workspaceSlug"));
  const requestIdValue = identifier(readProperty(safe, "requestId"));
  authorize(db, actor, workspaceSlug);
  return readRequestRow(db, actor.workspaceId, requestIdValue);
}

export function createProposalLineage(db: Db, actor: ProposalLineageActor, input: CreateProposalLineageInput): ProposalLineageReceipt {
  return createLineageInternal(db, actor, input);
}

export function bindSubmissionToLineage(db: Db, actor: ProposalLineageActor, input: BindSubmissionLineageInput): SubmissionLineageBindReceipt {
  return bindInternal(db, actor, input);
}

export function createSubmissionDerivation(db: Db, actor: ProposalLineageActor, input: CreateSubmissionDerivationInput): SubmissionDerivationReceipt {
  return createDerivationInternal(db, actor, input);
}

export function createResubmissionRequest(db: Db, actor: ProposalLineageActor, input: CreateResubmissionRequestInput): ResubmissionRequestReceipt {
  return createRequestInternal(db, actor, input);
}

export function readLineageTimeline(db: Db, actor: ProposalLineageActor, input: ReadLineageTimelineInput): LineageTimeline {
  return readTimelineInternal(db, actor, input);
}

export function readResubmissionGuidance(db: Db, actor: ProposalLineageActor, input: ReadResubmissionGuidanceInput): Record<string, unknown> {
  return readGuidanceInternal(db, actor, input);
}

// Explicit aliases keep the public vocabulary discoverable for callers that use command/query verbs.
export const bindLineage = bindSubmissionToLineage;
export const createDerivation = createSubmissionDerivation;
export const createGuidanceRequest = createResubmissionRequest;
export const getLineageTimeline = readLineageTimeline;
export const getResubmissionGuidance = readResubmissionGuidance;
