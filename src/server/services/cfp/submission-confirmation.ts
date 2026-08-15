import { Buffer } from "node:buffer";

import type { Db } from "../../db";
import { canonicalJson, fingerprintOf, uuid } from "../../canonical";
import type { ApplicantSessionContext, SubmissionRevision } from "./form-documents";

export const CFP_SUBMISSION_CONFIRMATION_SCHEMA = "cfp-submission-confirmation/v1" as const;
export const CFP_SUBMISSION_CONFIRMATION_EVENT_TYPE = "cfp.submission.confirmation" as const;
export const CFP_SUBMISSION_CONFIRMATION_AGGREGATE_TYPE = "cfp_submission" as const;
export const CFP_SUBMISSION_CONFIRMATION_CHANNEL = "local-inbox-simulation" as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const RAW_EMAIL_MAX_BYTES = 320;
const TITLE_MAX_BYTES = 160;
const SUBJECT_MAX_BYTES = 240;
const PAYLOAD_MAX_BYTES = 32 * 1024;
const SUBJECT_PREFIX = "CFP submission received";
const DESTINATION_KEY_PREFIX = "cfp-submission-confirmation";
const SUBMISSION_REVISION_SCHEMA = "cfp-submission-revision/v1";
const CONFIRMATION_STATUS_VALUES = new Set([
  "PENDING",
  "CLAIMED",
  "DELIVERED",
  "FAILED",
]);
const HAS_OWN = Object.prototype.hasOwnProperty;

export type CfpSubmissionConfirmationStatus =
  | "PENDING"
  | "CLAIMED"
  | "DELIVERED"
  | "FAILED";

export interface CfpSubmissionConfirmationReceipt {
  readonly receiptId: string;
  readonly eventId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly subject: string;
  readonly maskedRecipient: string;
  readonly status: CfpSubmissionConfirmationStatus;
  readonly queuedAt: string;
  readonly channel: typeof CFP_SUBMISSION_CONFIRMATION_CHANNEL;
  readonly simulated: true;
  readonly providerMutation: false;
}

export interface QueueCfpSubmissionConfirmationInput {
  readonly workspaceId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly personId: string;
  readonly session: ApplicantSessionContext;
  readonly revision: SubmissionRevision;
  readonly queuedAt: string;
}

export interface ReadCfpSubmissionConfirmationInput {
  readonly workspaceId: string;
  readonly callId: string;
  readonly submissionId: string;
  /** When omitted, read the single confirmation for this submitted aggregate. */
  readonly submissionRevisionId?: string;
  readonly submissionRevisionFingerprint?: string;
  readonly personId: string;
}

export type CfpSubmissionConfirmationErrorCode = "INPUT_INVALID" | "WRITE_FAILED" | "READ_FAILED";

const ERROR_MESSAGES: Record<CfpSubmissionConfirmationErrorCode, string> = {
  INPUT_INVALID: "The CFP submission confirmation input is invalid.",
  WRITE_FAILED: "The CFP submission confirmation could not be queued safely.",
  READ_FAILED: "The CFP submission confirmation could not be read safely.",
};

export class CfpSubmissionConfirmationError extends Error {
  readonly code: CfpSubmissionConfirmationErrorCode;

  constructor(code: CfpSubmissionConfirmationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CfpSubmissionConfirmationError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: CfpSubmissionConfirmationErrorCode): never {
  throw new CfpSubmissionConfirmationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function requireIdentifier(value: unknown, code: CfpSubmissionConfirmationErrorCode): string {
  if (!isIdentifier(value)) fail(code);
  return value;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function requireFingerprint(value: unknown, code: CfpSubmissionConfirmationErrorCode): string {
  if (!isFingerprint(value)) fail(code);
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function requireInstant(value: unknown, code: CfpSubmissionConfirmationErrorCode): string {
  if (!isIsoInstant(value)) fail(code);
  return value;
}

function requireSafeText(
  value: unknown,
  maxBytes: number,
  code: CfpSubmissionConfirmationErrorCode,
): string {
  if (typeof value !== "string") fail(code);
  const normalized = value.trim().normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(normalized) ||
    hasUnpairedSurrogate(normalized) ||
    Buffer.byteLength(normalized, "utf8") > maxBytes
  ) {
    fail(code);
  }
  return normalized;
}

function requireStoredEmail(value: unknown, code: CfpSubmissionConfirmationErrorCode): string {
  if (typeof value !== "string") fail(code);
  const normalized = value.trim().toLowerCase().normalize("NFC");
  const atIndex = normalized.indexOf("@");
  if (
    normalized.length === 0 ||
    normalized !== value ||
    Buffer.byteLength(normalized, "utf8") > RAW_EMAIL_MAX_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(normalized) ||
    hasUnpairedSurrogate(normalized) ||
    atIndex <= 0 ||
    atIndex === normalized.length - 1 ||
    normalized.indexOf("@", atIndex + 1) !== -1
  ) {
    fail(code);
  }
  return normalized;
}

function maskEmail(email: string): string {
  const atIndex = email.indexOf("@");
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const maskedLocal = local.length <= 1 ? "*" : `${local[0]}***${local.at(-1)}`;
  return `${maskedLocal}@${domain}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => HAS_OWN.call(value, key));
}

function parseCanonicalPayload(
  value: unknown,
  fingerprint: unknown,
  code: CfpSubmissionConfirmationErrorCode,
): Record<string, unknown> {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > PAYLOAD_MAX_BYTES ||
    !isFingerprint(fingerprint)
  ) {
    fail(code);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(code);
  }
  if (!isRecord(parsed) || canonicalJson(parsed) !== value || fingerprintOf(parsed) !== fingerprint) {
    fail(code);
  }
  return parsed;
}

function parseCanonicalJson(
  value: unknown,
  code: CfpSubmissionConfirmationErrorCode,
): Record<string, unknown> {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > PAYLOAD_MAX_BYTES) {
    fail(code);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(code);
  }
  if (!isRecord(parsed) || canonicalJson(parsed) !== value) fail(code);
  return parsed;
}

function requireConfirmationStatus(
  value: unknown,
  code: CfpSubmissionConfirmationErrorCode,
): CfpSubmissionConfirmationStatus {
  if (typeof value !== "string" || !CONFIRMATION_STATUS_VALUES.has(value)) fail(code);
  return value as CfpSubmissionConfirmationStatus;
}

type ConfirmationEventPayload = {
  readonly schema: typeof CFP_SUBMISSION_CONFIRMATION_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly submissionRevisionFingerprint: string;
  readonly recipientPersonId: string;
  readonly subject: string;
  readonly proposalTitle: string | null;
  readonly channel: typeof CFP_SUBMISSION_CONFIRMATION_CHANNEL;
  readonly providerMutation: false;
};

const EVENT_PAYLOAD_KEYS = [
  "schema",
  "workspaceId",
  "eventId",
  "callId",
  "submissionId",
  "submissionRevisionId",
  "submissionRevisionFingerprint",
  "recipientPersonId",
  "subject",
  "proposalTitle",
  "channel",
  "providerMutation",
] as const;

function parseEventPayload(
  value: unknown,
  code: CfpSubmissionConfirmationErrorCode,
): ConfirmationEventPayload {
  if (!isRecord(value) || !exactKeys(value, EVENT_PAYLOAD_KEYS)) fail(code);
  if (
    value.schema !== CFP_SUBMISSION_CONFIRMATION_SCHEMA ||
    value.channel !== CFP_SUBMISSION_CONFIRMATION_CHANNEL ||
    value.providerMutation !== false
  ) {
    fail(code);
  }
  const proposalTitle = value.proposalTitle;
  if (proposalTitle !== null) requireSafeText(proposalTitle, TITLE_MAX_BYTES, code);
  return Object.freeze({
    schema: CFP_SUBMISSION_CONFIRMATION_SCHEMA,
    workspaceId: requireIdentifier(value.workspaceId, code),
    eventId: requireIdentifier(value.eventId, code),
    callId: requireIdentifier(value.callId, code),
    submissionId: requireIdentifier(value.submissionId, code),
    submissionRevisionId: requireIdentifier(value.submissionRevisionId, code),
    submissionRevisionFingerprint: requireFingerprint(value.submissionRevisionFingerprint, code),
    recipientPersonId: requireIdentifier(value.recipientPersonId, code),
    subject: requireSafeText(value.subject, SUBJECT_MAX_BYTES, code),
    proposalTitle: proposalTitle === null ? null : requireSafeText(proposalTitle, TITLE_MAX_BYTES, code),
    channel: CFP_SUBMISSION_CONFIRMATION_CHANNEL,
    providerMutation: false,
  });
}

type StoredDomainEvent = {
  readonly id: string;
  readonly workspaceId: string;
  readonly payload: ConfirmationEventPayload;
  readonly payloadJson: string;
  readonly payloadFingerprint: string;
  readonly createdAt: string;
};

function parseStoredDomainEvent(
  row: Record<string, unknown>,
  code: CfpSubmissionConfirmationErrorCode,
): StoredDomainEvent {
  const payloadJson = row.payload_json;
  const payload = parseEventPayload(
    parseCanonicalPayload(payloadJson, row.payload_fingerprint, code),
    code,
  );
  return Object.freeze({
    id: requireIdentifier(row.id, code),
    workspaceId: requireIdentifier(row.workspace_id, code),
    payload,
    payloadJson: typeof payloadJson === "string" ? payloadJson : fail(code),
    payloadFingerprint: requireFingerprint(row.payload_fingerprint, code),
    createdAt: requireInstant(row.created_at, code),
  });
}

type ConfirmationScope = {
  readonly eventId: string;
  readonly callId: string;
  readonly email: string;
};

function readQueueScope(
  db: Db,
  input: QueueCfpSubmissionConfirmationInput,
): ConfirmationScope {
  if (!isRecord(input) || !isRecord(input.session)) fail("INPUT_INVALID");
  const workspaceId = requireIdentifier(input.workspaceId, "INPUT_INVALID");
  const submissionId = requireIdentifier(input.submissionId, "INPUT_INVALID");
  const revisionId = requireIdentifier(input.submissionRevisionId, "INPUT_INVALID");
  const personId = requireIdentifier(input.personId, "INPUT_INVALID");
  const sessionId = requireIdentifier(input.session.sessionId, "INPUT_INVALID");
  const sessionWorkspaceId = requireIdentifier(input.session.workspaceId, "INPUT_INVALID");
  const queuedAt = requireInstant(input.queuedAt, "INPUT_INVALID");
  if (sessionWorkspaceId !== workspaceId) fail("INPUT_INVALID");
  const revision = input.revision;
  if (
    !isRecord(revision) ||
    revision.schema !== SUBMISSION_REVISION_SCHEMA ||
    revision.submissionId !== submissionId ||
    !isFingerprint(revision.fingerprint)
  ) {
    fail("INPUT_INVALID");
  }

  const row = db
    .prepare(
      `SELECT
         s.id, s.workspace_id, s.event_id, s.call_id, s.owner_person_id,
         s.state, s.current_revision_id,
         r.id AS revision_id, r.submission_id AS revision_submission_id,
         r.person_id AS revision_person_id, r.session_id AS revision_session_id,
         r.fingerprint AS revision_fingerprint, r.created_at AS revision_created_at,
         p.id AS person_id, p.workspace_id AS person_workspace_id, p.canonical_email,
         session.id AS session_id, session.workspace_id AS session_workspace_id,
         session.call_id AS session_call_id, session.person_id AS session_person_id,
         session.created_at AS session_created_at, session.expires_at AS session_expires_at,
         session.revoked_at AS session_revoked_at
       FROM submissions s
       JOIN submission_revisions r
         ON r.workspace_id = s.workspace_id
        AND r.id = s.current_revision_id
        AND r.submission_id = s.id
       JOIN people p
         ON p.workspace_id = s.workspace_id
        AND p.id = s.owner_person_id
       JOIN cfp_applicant_sessions session
         ON session.id = ?
        AND session.workspace_id = s.workspace_id
        AND session.call_id = s.call_id
        AND session.person_id = s.owner_person_id
       WHERE s.workspace_id = ?
         AND s.id = ?
         AND r.id = ?
       LIMIT 1`,
    )
    .get(sessionId, workspaceId, submissionId, revisionId) as Record<string, unknown> | undefined;
  if (!row) fail("WRITE_FAILED");

  const storedSubmissionId = requireIdentifier(row.id, "WRITE_FAILED");
  const storedWorkspaceId = requireIdentifier(row.workspace_id, "WRITE_FAILED");
  const eventId = requireIdentifier(row.event_id, "WRITE_FAILED");
  const callId = requireIdentifier(row.call_id, "WRITE_FAILED");
  const ownerPersonId = requireIdentifier(row.owner_person_id, "WRITE_FAILED");
  const storedRevisionId = requireIdentifier(row.revision_id, "WRITE_FAILED");
  const storedRevisionSubmissionId = requireIdentifier(row.revision_submission_id, "WRITE_FAILED");
  const storedRevisionPersonId = requireIdentifier(row.revision_person_id, "WRITE_FAILED");
  const storedRevisionSessionId = requireIdentifier(row.revision_session_id, "WRITE_FAILED");
  const storedRevisionFingerprint = requireFingerprint(row.revision_fingerprint, "WRITE_FAILED");
  const revisionCreatedAt = requireInstant(row.revision_created_at, "WRITE_FAILED");
  const storedPersonId = requireIdentifier(row.person_id, "WRITE_FAILED");
  const personWorkspaceId = requireIdentifier(row.person_workspace_id, "WRITE_FAILED");
  const storedSessionId = requireIdentifier(row.session_id, "WRITE_FAILED");
  const sessionWorkspaceIdStored = requireIdentifier(row.session_workspace_id, "WRITE_FAILED");
  const sessionCallId = requireIdentifier(row.session_call_id, "WRITE_FAILED");
  const sessionPersonId = requireIdentifier(row.session_person_id, "WRITE_FAILED");
  const sessionCreatedAt = requireInstant(row.session_created_at, "WRITE_FAILED");
  const sessionExpiresAt = requireInstant(row.session_expires_at, "WRITE_FAILED");
  if (
    row.state !== "SUBMITTED" ||
    row.current_revision_id !== revisionId ||
    storedSubmissionId !== submissionId ||
    storedWorkspaceId !== workspaceId ||
    ownerPersonId !== personId ||
    storedRevisionId !== revisionId ||
    storedRevisionSubmissionId !== submissionId ||
    storedRevisionPersonId !== personId ||
    storedRevisionSessionId !== sessionId ||
    storedRevisionFingerprint !== revision.fingerprint ||
    storedPersonId !== personId ||
    personWorkspaceId !== workspaceId ||
    storedSessionId !== sessionId ||
    sessionWorkspaceIdStored !== workspaceId ||
    sessionCallId !== callId ||
    sessionPersonId !== personId ||
    row.session_revoked_at !== null ||
    revisionCreatedAt > queuedAt ||
    sessionCreatedAt > queuedAt ||
    queuedAt >= sessionExpiresAt
  ) {
    fail("WRITE_FAILED");
  }
  return Object.freeze({
    eventId,
    callId,
    email: requireStoredEmail(row.canonical_email, "WRITE_FAILED"),
  });
}

function readRevisionTitle(revision: SubmissionRevision): string | null {
  const fields = revision.formDocument.fields;
  const answers = new Map(revision.formDocument.effectiveAnswers.map((answer) => [answer.fieldId, answer.value]));
  const preferredIds = ["title", "proposalTitle", "proposal", "sessionTitle", "name"];
  let candidate: unknown;
  for (const fieldId of preferredIds) {
    const value = answers.get(fieldId);
    if (typeof value === "string") {
      candidate = value;
      break;
    }
  }
  if (candidate === undefined) {
    for (const field of fields) {
      const label = field.label.toLowerCase();
      if (!label.includes("title") && !label.includes("proposal") && !label.includes("session name")) {
        continue;
      }
      const value = answers.get(field.id);
      if (typeof value === "string") {
        candidate = value;
        break;
      }
    }
  }
  if (candidate === undefined) return null;
  return requireSafeText(candidate, TITLE_MAX_BYTES, "WRITE_FAILED");
}

function confirmationContent(
  revision: SubmissionRevision,
): { readonly subject: string; readonly proposalTitle: string | null } {
  const proposalTitle = readRevisionTitle(revision);
  const subject = requireSafeText(
    proposalTitle === null ? SUBJECT_PREFIX : `${SUBJECT_PREFIX}: ${proposalTitle}`,
    SUBJECT_MAX_BYTES,
    "WRITE_FAILED",
  );
  return Object.freeze({ subject, proposalTitle });
}

function eventPayloadFor(
  input: QueueCfpSubmissionConfirmationInput,
  scope: ConfirmationScope,
  content: { readonly subject: string; readonly proposalTitle: string | null },
): ConfirmationEventPayload {
  return Object.freeze({
    schema: CFP_SUBMISSION_CONFIRMATION_SCHEMA,
    workspaceId: requireIdentifier(input.workspaceId, "WRITE_FAILED"),
    eventId: requireIdentifier(scope.eventId, "WRITE_FAILED"),
    callId: requireIdentifier(scope.callId, "WRITE_FAILED"),
    submissionId: requireIdentifier(input.submissionId, "WRITE_FAILED"),
    submissionRevisionId: requireIdentifier(input.submissionRevisionId, "WRITE_FAILED"),
    submissionRevisionFingerprint: requireFingerprint(input.revision.fingerprint, "WRITE_FAILED"),
    recipientPersonId: requireIdentifier(input.personId, "WRITE_FAILED"),
    subject: requireSafeText(content.subject, SUBJECT_MAX_BYTES, "WRITE_FAILED"),
    proposalTitle: content.proposalTitle === null
      ? null
      : requireSafeText(content.proposalTitle, TITLE_MAX_BYTES, "WRITE_FAILED"),
    channel: CFP_SUBMISSION_CONFIRMATION_CHANNEL,
    providerMutation: false,
  });
}

function eventMatches(
  event: StoredDomainEvent,
  expectedPayloadJson: string,
  workspaceId: string,
  submissionId: string,
  revisionId: string,
): boolean {
  if (event.workspaceId !== workspaceId) fail("WRITE_FAILED");
  if (event.payload.submissionId !== submissionId) return false;
  if (event.payload.submissionRevisionId !== revisionId) return false;
  if (event.payloadJson !== expectedPayloadJson) fail("WRITE_FAILED");
  return true;
}

function readConfirmationEvents(
  db: Db,
  workspaceId: string,
  submissionId: string,
  code: CfpSubmissionConfirmationErrorCode,
): readonly StoredDomainEvent[] {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, payload_json, payload_fingerprint, created_at
       FROM domain_events
       WHERE workspace_id = ?
         AND event_type = ?
         AND aggregate_type = ?
         AND aggregate_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(
      workspaceId,
      CFP_SUBMISSION_CONFIRMATION_EVENT_TYPE,
      CFP_SUBMISSION_CONFIRMATION_AGGREGATE_TYPE,
      submissionId,
    ) as unknown as Record<string, unknown>[];
  return Object.freeze(rows.map((row) => parseStoredDomainEvent(row, code)));
}

function findMatchingEvent(
  db: Db,
  input: QueueCfpSubmissionConfirmationInput,
  expectedPayloadJson: string,
): StoredDomainEvent | null {
  const events = readConfirmationEvents(db, input.workspaceId, input.submissionId, "WRITE_FAILED");
  let match: StoredDomainEvent | null = null;
  for (const event of events) {
    if (
      eventMatches(
        event,
        expectedPayloadJson,
        input.workspaceId,
        input.submissionId,
        input.submissionRevisionId,
      )
    ) {
      if (match !== null) fail("WRITE_FAILED");
      match = event;
    }
  }
  return match;
}

function outboxPayloadForValues(values: {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly submissionRevisionFingerprint: string;
  readonly recipientPersonId: string;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly proposalTitle: string | null;
}): Record<string, unknown> {
  return Object.freeze({
    schema: CFP_SUBMISSION_CONFIRMATION_SCHEMA,
    workspaceId: requireIdentifier(values.workspaceId, "WRITE_FAILED"),
    eventId: requireIdentifier(values.eventId, "WRITE_FAILED"),
    callId: requireIdentifier(values.callId, "WRITE_FAILED"),
    submissionId: requireIdentifier(values.submissionId, "WRITE_FAILED"),
    submissionRevisionId: requireIdentifier(values.submissionRevisionId, "WRITE_FAILED"),
    submissionRevisionFingerprint: requireFingerprint(values.submissionRevisionFingerprint, "WRITE_FAILED"),
    recipientPersonId: requireIdentifier(values.recipientPersonId, "WRITE_FAILED"),
    recipientEmail: requireStoredEmail(values.recipientEmail, "WRITE_FAILED"),
    subject: requireSafeText(values.subject, SUBJECT_MAX_BYTES, "WRITE_FAILED"),
    proposalTitle: values.proposalTitle === null
      ? null
      : requireSafeText(values.proposalTitle, TITLE_MAX_BYTES, "WRITE_FAILED"),
    channel: CFP_SUBMISSION_CONFIRMATION_CHANNEL,
    providerMutation: false,
  });
}

function outboxPayloadFor(
  input: QueueCfpSubmissionConfirmationInput,
  eventId: string,
  scope: ConfirmationScope,
  content: { readonly subject: string; readonly proposalTitle: string | null },
): Record<string, unknown> {
  return outboxPayloadForValues({
    workspaceId: input.workspaceId,
    eventId,
    callId: scope.callId,
    submissionId: input.submissionId,
    submissionRevisionId: input.submissionRevisionId,
    submissionRevisionFingerprint: input.revision.fingerprint,
    recipientPersonId: input.personId,
    recipientEmail: scope.email,
    subject: content.subject,
    proposalTitle: content.proposalTitle,
  });
}

function readOutboxReceipt(
  row: Record<string, unknown>,
  expected: Record<string, unknown>,
  event: StoredDomainEvent,
  email: string,
  code: CfpSubmissionConfirmationErrorCode,
): CfpSubmissionConfirmationReceipt {
  const receiptId = requireIdentifier(row.id, code);
  const workspaceId = requireIdentifier(row.workspace_id, code);
  const domainEventId = requireIdentifier(row.domain_event_id, code);
  const destinationKey = requireSafeText(row.destination_key, 512, code);
  const status = requireConfirmationStatus(row.status, code);
  const queuedAt = requireInstant(row.created_at, code);
  const payloadJson = row.payload_json;
  const parsed = parseCanonicalJson(payloadJson, code);
  if (
    workspaceId !== event.workspaceId ||
    domainEventId !== event.id ||
    destinationKey !== `${DESTINATION_KEY_PREFIX}:${event.payload.submissionId}:${event.payload.submissionRevisionId}` ||
    canonicalJson(parsed) !== canonicalJson(expected) ||
    queuedAt !== event.createdAt
  ) {
    fail(code);
  }
  const recipientEmail = requireStoredEmail(parsed.recipientEmail, code);
  if (recipientEmail !== email) fail(code);
  return Object.freeze({
    receiptId,
    eventId: event.id,
    submissionId: event.payload.submissionId,
    submissionRevisionId: event.payload.submissionRevisionId,
    subject: event.payload.subject,
    maskedRecipient: maskEmail(recipientEmail),
    status,
    queuedAt,
    channel: CFP_SUBMISSION_CONFIRMATION_CHANNEL,
    simulated: true,
    providerMutation: false,
  });
}

function readOutboxRow(
  db: Db,
  event: StoredDomainEvent,
  destinationKey: string,
  code: CfpSubmissionConfirmationErrorCode,
): Record<string, unknown> | null {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, domain_event_id, destination_key, payload_json,
              status, created_at
       FROM outbox_messages
       WHERE workspace_id = ? AND domain_event_id = ? AND destination_key = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(event.workspaceId, event.id, destinationKey) as unknown as Record<string, unknown>[];
  if (rows.length > 1) fail(code);
  return rows[0] ?? null;
}

function insertEvent(
  db: Db,
  input: QueueCfpSubmissionConfirmationInput,
  payload: ConfirmationEventPayload,
  payloadJson: string,
  payloadFingerprint: string,
): StoredDomainEvent {
  const existing = findMatchingEvent(db, input, payloadJson);
  if (existing !== null) return existing;

  const eventId = uuid();
  const createdAt = requireInstant(input.queuedAt, "WRITE_FAILED");
  try {
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      input.workspaceId,
      CFP_SUBMISSION_CONFIRMATION_EVENT_TYPE,
      CFP_SUBMISSION_CONFIRMATION_AGGREGATE_TYPE,
      input.submissionId,
      payloadJson,
      payloadFingerprint,
      createdAt,
    );
  } catch {
    const replay = findMatchingEvent(db, input, payloadJson);
    if (replay !== null) return replay;
    fail("WRITE_FAILED");
  }
  const inserted = findMatchingEvent(db, input, payloadJson);
  if (
    inserted === null ||
    inserted.id !== eventId ||
    inserted.payloadJson !== payloadJson ||
    inserted.payload.eventId !== payload.eventId
  ) {
    fail("WRITE_FAILED");
  }
  return inserted;
}

export function queueCfpSubmissionConfirmation(
  db: Db,
  input: QueueCfpSubmissionConfirmationInput,
): CfpSubmissionConfirmationReceipt {
  if (!isRecord(input)) fail("INPUT_INVALID");
  const scope = readQueueScope(db, input);
  const content = confirmationContent(input.revision);
  const eventPayload = eventPayloadFor(input, scope, content);
  const eventPayloadJson = canonicalJson(eventPayload);
  const eventPayloadFingerprint = fingerprintOf(eventPayload);
  if (Buffer.byteLength(eventPayloadJson, "utf8") > PAYLOAD_MAX_BYTES) fail("WRITE_FAILED");
  const event = insertEvent(
    db,
    input,
    eventPayload,
    eventPayloadJson,
    eventPayloadFingerprint,
  );
  const expectedOutboxPayload = outboxPayloadFor(input, event.id, scope, content);
  const expectedOutboxPayloadJson = canonicalJson(expectedOutboxPayload);
  if (Buffer.byteLength(expectedOutboxPayloadJson, "utf8") > PAYLOAD_MAX_BYTES) fail("WRITE_FAILED");
  const destinationKey = `${DESTINATION_KEY_PREFIX}:${input.submissionId}:${input.submissionRevisionId}`;
  const existing = readOutboxRow(db, event, destinationKey, "WRITE_FAILED");
  if (existing !== null) {
    return readOutboxReceipt(existing, expectedOutboxPayload, event, scope.email, "WRITE_FAILED");
  }
  const queuedAt = event.createdAt;
  try {
    db.prepare(
      `INSERT INTO outbox_messages
         (id, workspace_id, domain_event_id, destination_key, payload_json,
          status, attempt_count, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
    ).run(
      uuid(),
      input.workspaceId,
      event.id,
      destinationKey,
      expectedOutboxPayloadJson,
      queuedAt,
      queuedAt,
    );
  } catch {
    const replay = readOutboxRow(db, event, destinationKey, "WRITE_FAILED");
    if (replay === null) fail("WRITE_FAILED");
    return readOutboxReceipt(replay, expectedOutboxPayload, event, scope.email, "WRITE_FAILED");
  }
  const inserted = readOutboxRow(db, event, destinationKey, "WRITE_FAILED");
  if (inserted === null) fail("WRITE_FAILED");
  return readOutboxReceipt(inserted, expectedOutboxPayload, event, scope.email, "WRITE_FAILED");
}

function readPersonEmail(
  db: Db,
  workspaceId: string,
  personId: string,
): string | null {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, canonical_email
       FROM people
       WHERE workspace_id = ? AND id = ?
       LIMIT 1`,
    )
    .all(workspaceId, personId) as unknown as Record<string, unknown>[];
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (
    requireIdentifier(row.id, "READ_FAILED") !== personId ||
    requireIdentifier(row.workspace_id, "READ_FAILED") !== workspaceId
  ) {
    fail("READ_FAILED");
  }
  return requireStoredEmail(row.canonical_email, "READ_FAILED");
}

function readSubmissionScope(
  db: Db,
  workspaceId: string,
  submissionId: string,
  callId: string,
  personId: string,
): { readonly eventId: string } | null {
  const row = db
    .prepare(
      `SELECT event_id, call_id, owner_person_id, state
       FROM submissions
       WHERE workspace_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(workspaceId, submissionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const eventId = requireIdentifier(row.event_id, "READ_FAILED");
  if (
    row.state !== "SUBMITTED" ||
    requireIdentifier(row.call_id, "READ_FAILED") !== callId ||
    requireIdentifier(row.owner_person_id, "READ_FAILED") !== personId
  ) {
    return null;
  }
  return Object.freeze({ eventId });
}

export function readCfpSubmissionConfirmation(
  db: Db,
  input: ReadCfpSubmissionConfirmationInput,
): CfpSubmissionConfirmationReceipt | null {
  if (!isRecord(input)) return null;
  const hasRevisionId = input.submissionRevisionId !== undefined;
  const hasRevisionFingerprint = input.submissionRevisionFingerprint !== undefined;
  if (
    !isIdentifier(input.workspaceId) ||
    !isIdentifier(input.callId) ||
    !isIdentifier(input.submissionId) ||
    !isIdentifier(input.personId) ||
    hasRevisionId !== hasRevisionFingerprint ||
    (hasRevisionId && !isIdentifier(input.submissionRevisionId)) ||
    (hasRevisionFingerprint && !isFingerprint(input.submissionRevisionFingerprint))
  ) {
    return null;
  }
  const email = readPersonEmail(db, input.workspaceId, input.personId);
  if (email === null) return null;
  const submissionScope = readSubmissionScope(
    db,
    input.workspaceId,
    input.submissionId,
    input.callId,
    input.personId,
  );
  if (submissionScope === null) return null;
  const rows = db
    .prepare(
      `SELECT
         e.id AS event_id, e.workspace_id AS event_workspace_id,
         e.payload_json AS event_payload_json,
         e.payload_fingerprint AS event_payload_fingerprint,
         e.created_at AS event_created_at,
         o.id, o.workspace_id, o.domain_event_id, o.destination_key,
         o.payload_json, o.status, o.created_at
       FROM domain_events e
       JOIN outbox_messages o
         ON o.workspace_id = e.workspace_id
        AND o.domain_event_id = e.id
       WHERE e.workspace_id = ?
         AND e.event_type = ?
         AND e.aggregate_type = ?
         AND e.aggregate_id = ?
       ORDER BY e.created_at ASC, e.rowid ASC, o.created_at ASC, o.rowid ASC`,
    )
    .all(
      input.workspaceId,
      CFP_SUBMISSION_CONFIRMATION_EVENT_TYPE,
      CFP_SUBMISSION_CONFIRMATION_AGGREGATE_TYPE,
      input.submissionId,
    ) as unknown as Record<string, unknown>[];
  let receipt: CfpSubmissionConfirmationReceipt | null = null;
  for (const row of rows) {
    const event = parseStoredDomainEvent(
      {
        id: row.event_id,
        workspace_id: row.event_workspace_id,
        payload_json: row.event_payload_json,
        payload_fingerprint: row.event_payload_fingerprint,
        created_at: row.event_created_at,
      },
      "READ_FAILED",
    );
    if (hasRevisionId && event.payload.submissionRevisionId !== input.submissionRevisionId) continue;
    if (
      event.payload.workspaceId !== input.workspaceId ||
      event.payload.eventId !== submissionScope.eventId ||
      event.payload.callId !== input.callId ||
      event.payload.submissionId !== input.submissionId ||
      (hasRevisionFingerprint &&
        event.payload.submissionRevisionFingerprint !== input.submissionRevisionFingerprint) ||
      event.payload.recipientPersonId !== input.personId
    ) {
      fail("READ_FAILED");
    }
    const expected = outboxPayloadForValues({
      workspaceId: input.workspaceId,
      eventId: event.id,
      callId: event.payload.callId,
      submissionId: input.submissionId,
      submissionRevisionId: event.payload.submissionRevisionId,
      submissionRevisionFingerprint: event.payload.submissionRevisionFingerprint,
      recipientPersonId: event.payload.recipientPersonId,
      recipientEmail: email,
      subject: event.payload.subject,
      proposalTitle: event.payload.proposalTitle,
    });
    const destinationKey = `${DESTINATION_KEY_PREFIX}:${event.payload.submissionId}:${event.payload.submissionRevisionId}`;
    const current = readOutboxReceipt(row, expected, event, email, "READ_FAILED");
    if (current.receiptId.length === 0 || current.eventId !== event.id || destinationKey.length === 0) {
      fail("READ_FAILED");
    }
    if (receipt !== null) fail("READ_FAILED");
    receipt = current;
  }
  return receipt;
}
