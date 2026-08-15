import { roleHasCapability, type SessionInfo } from "../../auth";
import { canonicalJson, fingerprintOf, nowIso, uuid } from "../../canonical";
import type { Db } from "../../db";
import { writeAudit } from "../audit";

export const ORGANIZER_REVIEW_BLIND_CONTROL_SCHEMA =
  "cfp-review-round-blind-control/v1" as const;
export const ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE =
  "cfp.review.round.blind-control.set" as const;
export const ORGANIZER_REVIEW_BLIND_CONTROL_MODE = "BLINDED" as const;
export const ORGANIZER_REVIEW_BLIND_CONTROL_EXPLANATION =
  "Review identity cannot be safely rehydrated from the existing sealed contracts, so disabling blind review is not supported for this round." as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BLINDED_FIELDS = Object.freeze(["author", "coauthor", "organization"] as const);

type BlindControlSource = "DEFAULT_FAIL_CLOSED" | "IMMUTABLE_EVENT";

export interface OrganizerReviewBlindControl {
  readonly schema: typeof ORGANIZER_REVIEW_BLIND_CONTROL_SCHEMA;
  readonly version: 1;
  readonly eventId: string;
  readonly roundId: string;
  readonly mode: typeof ORGANIZER_REVIEW_BLIND_CONTROL_MODE;
  readonly enabled: true;
  readonly organizerSeesIdentity: true;
  readonly reviewerSeesIdentity: false;
  readonly anonymizedFields: typeof BLINDED_FIELDS;
  readonly disableSupported: false;
  readonly source: BlindControlSource;
  readonly settingEventId: string | null;
  readonly recordedAt: string | null;
  readonly malformedEvent: boolean;
  readonly explanation: typeof ORGANIZER_REVIEW_BLIND_CONTROL_EXPLANATION;
}

export interface ReadOrganizerReviewBlindControlInput {
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly roundId: string;
}

export interface SetOrganizerReviewBlindControlInput extends ReadOrganizerReviewBlindControlInput {
  readonly enabled: true;
  readonly idempotencyKey?: string;
}

export interface OrganizerReviewBlindControlReceipt {
  readonly schema: typeof ORGANIZER_REVIEW_BLIND_CONTROL_SCHEMA;
  readonly eventId: string;
  readonly roundId: string;
  readonly mode: typeof ORGANIZER_REVIEW_BLIND_CONTROL_MODE;
  readonly enabled: true;
  readonly settingEventId: string;
  readonly fingerprint: string;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly replayed: boolean;
}

const ERROR_MESSAGES = {
  INPUT_INVALID: "The blind-review setting request is invalid.",
  ACCESS_DENIED: "Organizer review access is unavailable.",
  OUTER_TRANSACTION_DENIED:
    "Blind-review configuration requires its own transaction boundary.",
  EVENT_NOT_AVAILABLE: "The event is not available in this workspace.",
  ROUND_NOT_AVAILABLE: "The review round is not available in this workspace.",
  READ_FAILED: "The blind-review setting could not be read safely.",
  WRITE_FAILED: "The blind-review setting could not be saved safely.",
} as const;

export type OrganizerReviewBlindControlErrorCode = keyof typeof ERROR_MESSAGES;

export class OrganizerReviewBlindControlError extends Error {
  readonly code: OrganizerReviewBlindControlErrorCode;

  constructor(code: OrganizerReviewBlindControlErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OrganizerReviewBlindControlError";
    this.code = code;
  }
}

type OrganizerScope = Readonly<{
  accountId: string;
  workspaceId: string;
  workspaceSlug: string;
}>;

type RoundScope = Readonly<{
  eventId: string;
  roundId: string;
  workspaceId: string;
}>;

type StoredDomainEventRow = Readonly<{
  id: unknown;
  workspace_id: unknown;
  event_type: unknown;
  aggregate_type: unknown;
  aggregate_id: unknown;
  payload_json: unknown;
  payload_fingerprint: unknown;
  created_at: unknown;
}>;

type StoredBlindControlEvent = Readonly<{
  domainEventId: string;
  fingerprint: string;
  recordedAt: string;
  idempotencyKey: string;
}>;

function fail(code: OrganizerReviewBlindControlErrorCode): never {
  throw new OrganizerReviewBlindControlError(code);
}

function boundary<T>(kind: "read" | "write", operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof OrganizerReviewBlindControlError) throw error;
    throw new OrganizerReviewBlindControlError(kind === "read" ? "READ_FAILED" : "WRITE_FAILED");
  }
}

function identifier(value: unknown, code: OrganizerReviewBlindControlErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) return fail(code);
  return value;
}

function workspaceSlug(value: unknown): string {
  if (typeof value !== "string" || !WORKSPACE_PATTERN.test(value)) return fail("INPUT_INVALID");
  return value;
}

function storedIdentifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value) ? value : null;
}

function storedFingerprint(value: unknown): string | null {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value) ? value : null;
}

function inputIdempotencyKey(value: unknown, roundId: string): string {
  if (value === undefined) return `review-blind-control:${roundId}:v1`;
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    return fail("INPUT_INVALID");
  }
  return value;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const canonical = new Date(value).toISOString();
    return canonical === value ? value : null;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => allowed.has(key));
}

function authenticateOrganizer(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): OrganizerScope {
  if (
    requestedWorkspaceSlug !== session.workspaceSlug ||
    !IDENTIFIER_PATTERN.test(session.id) ||
    !/^[a-f0-9]{64}$/u.test(session.tokenHash) ||
    !IDENTIFIER_PATTERN.test(session.accountId) ||
    !IDENTIFIER_PATTERN.test(session.workspaceId)
  ) {
    return fail("ACCESS_DENIED");
  }

  const row = db
    .prepare(
      `SELECT s.id, s.token_hash, s.account_id, s.workspace_id, s.created_at,
              s.expires_at, a.role, w.slug
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id AND a.workspace_id = s.workspace_id
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = ? AND s.token_hash = ?`,
    )
    .get(session.id, session.tokenHash) as
    | {
        id: unknown;
        token_hash: unknown;
        account_id: unknown;
        workspace_id: unknown;
        created_at: unknown;
        expires_at: unknown;
        role: unknown;
        slug: unknown;
      }
    | undefined;
  if (!row) return fail("ACCESS_DENIED");

  const createdAt = canonicalTimestamp(row.created_at);
  const expiresAt = canonicalTimestamp(row.expires_at);
  if (
    createdAt === null ||
    expiresAt === null ||
    storedIdentifier(row.id) !== session.id ||
    row.token_hash !== session.tokenHash ||
    storedIdentifier(row.account_id) !== session.accountId ||
    storedIdentifier(row.workspace_id) !== session.workspaceId ||
    row.slug !== requestedWorkspaceSlug ||
    typeof row.role !== "string" ||
    !roleHasCapability(row.role, "phase0.pipeline.manage") ||
    Date.parse(createdAt) > Date.now() ||
    Date.parse(expiresAt) <= Date.now()
  ) {
    return fail("ACCESS_DENIED");
  }
  return Object.freeze({
    accountId: session.accountId,
    workspaceId: session.workspaceId,
    workspaceSlug: requestedWorkspaceSlug,
  });
}

function validateReadInput(input: ReadOrganizerReviewBlindControlInput): ReadOrganizerReviewBlindControlInput {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  return Object.freeze({
    workspaceSlug: workspaceSlug(input.workspaceSlug),
    eventId: identifier(input.eventId, "INPUT_INVALID"),
    roundId: identifier(input.roundId, "INPUT_INVALID"),
  });
}

function validateSetInput(input: SetOrganizerReviewBlindControlInput): {
  readonly normalized: ReadOrganizerReviewBlindControlInput;
  readonly idempotencyKey: string;
} {
  if (input === null || typeof input !== "object" || input.enabled !== true) {
    return fail("INPUT_INVALID");
  }
  const normalized = validateReadInput(input);
  return Object.freeze({
    normalized,
    idempotencyKey: inputIdempotencyKey(input.idempotencyKey, normalized.roundId),
  });
}

function readRoundScope(
  db: Db,
  organizer: OrganizerScope,
  input: ReadOrganizerReviewBlindControlInput,
): RoundScope {
  const row = db
    .prepare(
      `SELECT round.id, round.workspace_id, round.event_id,
              event.workspace_id AS event_workspace_id
       FROM review_rounds round
       JOIN events event
         ON event.id = round.event_id AND event.workspace_id = round.workspace_id
       WHERE round.workspace_id = ? AND round.event_id = ? AND round.id = ?`,
    )
    .get(organizer.workspaceId, input.eventId, input.roundId) as
    | {
        id: unknown;
        workspace_id: unknown;
        event_id: unknown;
        event_workspace_id: unknown;
      }
    | undefined;
  if (!row) return fail("ROUND_NOT_AVAILABLE");
  if (
    storedIdentifier(row.id) !== input.roundId ||
    storedIdentifier(row.workspace_id) !== organizer.workspaceId ||
    storedIdentifier(row.event_id) !== input.eventId ||
    storedIdentifier(row.event_workspace_id) !== organizer.workspaceId
  ) {
    return fail("ROUND_NOT_AVAILABLE");
  }
  return Object.freeze({
    eventId: input.eventId,
    roundId: input.roundId,
    workspaceId: organizer.workspaceId,
  });
}

function defaultControl(
  scope: RoundScope,
  malformedEvent: boolean,
): OrganizerReviewBlindControl {
  return Object.freeze({
    schema: ORGANIZER_REVIEW_BLIND_CONTROL_SCHEMA,
    version: 1,
    eventId: scope.eventId,
    roundId: scope.roundId,
    mode: ORGANIZER_REVIEW_BLIND_CONTROL_MODE,
    enabled: true,
    organizerSeesIdentity: true,
    reviewerSeesIdentity: false,
    anonymizedFields: BLINDED_FIELDS,
    disableSupported: false,
    source: "DEFAULT_FAIL_CLOSED",
    settingEventId: null,
    recordedAt: null,
    malformedEvent,
    explanation: ORGANIZER_REVIEW_BLIND_CONTROL_EXPLANATION,
  });
}

function storedEvent(
  row: StoredDomainEventRow,
  scope: RoundScope,
): StoredBlindControlEvent | null {
  const domainEventId = storedIdentifier(row.id);
  const workspaceId = storedIdentifier(row.workspace_id);
  const fingerprint = storedFingerprint(row.payload_fingerprint);
  if (
    domainEventId === null ||
    workspaceId !== scope.workspaceId ||
    row.event_type !== ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE ||
    row.aggregate_type !== "review_round" ||
    storedIdentifier(row.aggregate_id) !== scope.roundId ||
    typeof row.payload_json !== "string" ||
    fingerprint === null
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  const requiredKeys = [
    "schema",
    "version",
    "workspaceId",
    "eventId",
    "roundId",
    "mode",
    "enabled",
    "authorVisibility",
    "reviewerVisibility",
    "disableSupported",
    "changedAt",
    "idempotencyKey",
  ] as const;
  if (
    !hasExactKeys(payload, requiredKeys) ||
    canonicalJson(payload) !== row.payload_json ||
    fingerprintOf(payload) !== fingerprint ||
    payload.schema !== ORGANIZER_REVIEW_BLIND_CONTROL_SCHEMA ||
    payload.version !== 1 ||
    payload.workspaceId !== scope.workspaceId ||
    payload.eventId !== scope.eventId ||
    payload.roundId !== scope.roundId ||
    payload.mode !== ORGANIZER_REVIEW_BLIND_CONTROL_MODE ||
    payload.enabled !== true ||
    payload.authorVisibility !== "ORGANIZER_ONLY" ||
    payload.reviewerVisibility !== "HIDDEN" ||
    payload.disableSupported !== false ||
    typeof payload.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(payload.idempotencyKey)
  ) {
    return null;
  }
  const changedAt = canonicalTimestamp(payload.changedAt);
  const createdAt = canonicalTimestamp(row.created_at);
  if (changedAt === null || createdAt === null || changedAt !== createdAt) return null;
  return Object.freeze({
    domainEventId,
    fingerprint,
    recordedAt: changedAt,
    idempotencyKey: payload.idempotencyKey,
  });
}

function currentStoredEvents(
  db: Db,
  scope: RoundScope,
): { readonly current: StoredBlindControlEvent | null; readonly malformed: boolean } {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at
       FROM domain_events
       WHERE workspace_id = ?
         AND event_type = ?
         AND aggregate_type = 'review_round'
         AND aggregate_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(scope.workspaceId, ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE, scope.roundId) as StoredDomainEventRow[];
  let current: StoredBlindControlEvent | null = null;
  let malformed = false;
  for (const row of rows) {
    const parsed = storedEvent(row, scope);
    if (parsed === null) {
      malformed = true;
    } else {
      current = parsed;
    }
  }
  return Object.freeze({ current, malformed });
}

function controlFromEvent(
  scope: RoundScope,
  stored: StoredBlindControlEvent,
): OrganizerReviewBlindControl {
  return Object.freeze({
    schema: ORGANIZER_REVIEW_BLIND_CONTROL_SCHEMA,
    version: 1,
    eventId: scope.eventId,
    roundId: scope.roundId,
    mode: ORGANIZER_REVIEW_BLIND_CONTROL_MODE,
    enabled: true,
    organizerSeesIdentity: true,
    reviewerSeesIdentity: false,
    anonymizedFields: BLINDED_FIELDS,
    disableSupported: false,
    source: "IMMUTABLE_EVENT",
    settingEventId: stored.domainEventId,
    recordedAt: stored.recordedAt,
    malformedEvent: false,
    explanation: ORGANIZER_REVIEW_BLIND_CONTROL_EXPLANATION,
  });
}

function receiptFromEvent(
  scope: RoundScope,
  stored: StoredBlindControlEvent,
  replayed: boolean,
): OrganizerReviewBlindControlReceipt {
  return Object.freeze({
    schema: ORGANIZER_REVIEW_BLIND_CONTROL_SCHEMA,
    eventId: scope.eventId,
    roundId: scope.roundId,
    mode: ORGANIZER_REVIEW_BLIND_CONTROL_MODE,
    enabled: true,
    settingEventId: stored.domainEventId,
    fingerprint: stored.fingerprint,
    recordedAt: stored.recordedAt,
    idempotencyKey: stored.idempotencyKey,
    replayed,
  });
}

function findEventForIdempotency(
  db: Db,
  scope: RoundScope,
  idempotencyKey: string,
): StoredBlindControlEvent | null {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at
       FROM domain_events
       WHERE workspace_id = ?
         AND event_type = ?
         AND aggregate_type = 'review_round'
         AND aggregate_id = ?
         AND json_valid(payload_json) = 1
         AND json_extract(payload_json, '$.idempotencyKey') = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(
      scope.workspaceId,
      ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE,
      scope.roundId,
      idempotencyKey,
    ) as StoredDomainEventRow[];
  if (rows.length > 1) return fail("WRITE_FAILED");
  if (rows.length === 0) return null;
  const parsed = storedEvent(rows[0]!, scope);
  if (parsed === null) return fail("WRITE_FAILED");
  return parsed;
}

export function readOrganizerReviewBlindControl(
  db: Db,
  session: SessionInfo,
  rawInput: ReadOrganizerReviewBlindControlInput,
): OrganizerReviewBlindControl {
  return boundary("read", () => {
    const input = validateReadInput(rawInput);
    const organizer = authenticateOrganizer(db, session, input.workspaceSlug);
    const scope = readRoundScope(db, organizer, input);
    const events = currentStoredEvents(db, scope);
    if (events.malformed) return defaultControl(scope, true);
    return events.current === null
      ? defaultControl(scope, false)
      : controlFromEvent(scope, events.current);
  });
}

export function setOrganizerReviewBlindControl(
  db: Db,
  session: SessionInfo,
  rawInput: SetOrganizerReviewBlindControlInput,
): OrganizerReviewBlindControlReceipt {
  return boundary("write", () => {
    const captured = validateSetInput(rawInput);
    if (db.isTransaction) return fail("OUTER_TRANSACTION_DENIED");
    db.exec("BEGIN IMMEDIATE");
    try {
      const organizer = authenticateOrganizer(db, session, captured.normalized.workspaceSlug);
      const scope = readRoundScope(db, organizer, captured.normalized);
      const existing = findEventForIdempotency(db, scope, captured.idempotencyKey);
      if (existing !== null) {
        db.exec("COMMIT");
        return receiptFromEvent(scope, existing, true);
      }

      const recordedAt = nowIso();
      const payload = Object.freeze({
        schema: ORGANIZER_REVIEW_BLIND_CONTROL_SCHEMA,
        version: 1 as const,
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        roundId: scope.roundId,
        mode: ORGANIZER_REVIEW_BLIND_CONTROL_MODE,
        enabled: true as const,
        authorVisibility: "ORGANIZER_ONLY" as const,
        reviewerVisibility: "HIDDEN" as const,
        disableSupported: false as const,
        changedAt: recordedAt,
        idempotencyKey: captured.idempotencyKey,
      });
      const payloadJson = canonicalJson(payload);
      const fingerprint = fingerprintOf(payload);
      const settingEventId = uuid();
      try {
        db.prepare(
          `INSERT INTO domain_events
             (id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at)
           VALUES (?, ?, ?, 'review_round', ?, ?, ?, ?)`,
        ).run(
          settingEventId,
          scope.workspaceId,
          ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE,
          scope.roundId,
          payloadJson,
          fingerprint,
          recordedAt,
        );
      } catch {
        const replay = findEventForIdempotency(db, scope, captured.idempotencyKey);
        if (replay === null) return fail("WRITE_FAILED");
        db.exec("COMMIT");
        return receiptFromEvent(scope, replay, true);
      }
      const stored = storedEvent(
        {
          id: settingEventId,
          workspace_id: scope.workspaceId,
          event_type: ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE,
          aggregate_type: "review_round",
          aggregate_id: scope.roundId,
          payload_json: payloadJson,
          payload_fingerprint: fingerprint,
          created_at: recordedAt,
        },
        scope,
      );
      if (stored === null) return fail("WRITE_FAILED");
      writeAudit(db, scope.workspaceId, {
        actorKind: "account",
        actorRef: organizer.accountId,
        action: "cfp.review.round.blind-control.enabled",
        targetType: "review_round",
        targetId: scope.roundId,
        details: {
          eventId: scope.eventId,
          settingEventId,
          idempotencyKey: captured.idempotencyKey,
          mode: ORGANIZER_REVIEW_BLIND_CONTROL_MODE,
          organizerVisibility: "ORGANIZER_ONLY",
          reviewerVisibility: "HIDDEN",
          anonymizedFields: BLINDED_FIELDS,
          disableSupported: false,
        },
      });
      db.exec("COMMIT");
      return receiptFromEvent(scope, stored, false);
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        // Preserve the opaque service error when transaction cleanup is unavailable.
      }
      throw error;
    }
  });
}
