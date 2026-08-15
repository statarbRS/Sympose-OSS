import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, fingerprintOf, nowIso, uuid } from "../../canonical";

export const SPEAKER_COMMUNICATIONS_SCHEMA = "speaker-communications-batch/v1" as const;
export const SPEAKER_COMMUNICATION_MESSAGE_SCHEMA = "speaker-communications-message/v1" as const;
export const SPEAKER_COMMUNICATION_RECEIPT_SCHEMA = "speaker-communications-receipt/v1" as const;
export const SPEAKER_COMMUNICATION_EVENT_TYPE = "speaker.communication.batch.queued" as const;
export const SPEAKER_COMMUNICATION_AGGREGATE_TYPE = "speaker_communication_batch" as const;
export const SPEAKER_COMMUNICATION_TEMPLATE_KEY = "speaker-bulk-local-v1" as const;
export const SPEAKER_COMMUNICATION_TEMPLATE_KEYS = [SPEAKER_COMMUNICATION_TEMPLATE_KEY] as const;
export const SPEAKER_COMMUNICATION_MERGE_FIELDS = [
  "displayName",
  "firstName",
  "organization",
  "title",
  "eventName",
] as const;
export const SPEAKER_COMMUNICATION_RECIPIENT_MERGE_FIELDS = [
  "firstName",
  "organization",
  "title",
] as const;
export const SPEAKER_COMMUNICATION_MAX_RECIPIENTS = 100;

type SpeakerCommunicationTemplateKey = typeof SPEAKER_COMMUNICATION_TEMPLATE_KEYS[number];
type SpeakerCommunicationMergeField = typeof SPEAKER_COMMUNICATION_MERGE_FIELDS[number];
type SpeakerCommunicationRecipientMergeField = typeof SPEAKER_COMMUNICATION_RECIPIENT_MERGE_FIELDS[number];

export interface SpeakerCommunicationRecipientInput {
  readonly personId: string;
  readonly email: string;
  readonly displayName: string;
  readonly mergeFields?: Readonly<Record<string, string>>;
}

export interface QueueSpeakerCommunicationBatchInput {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly templateKey: SpeakerCommunicationTemplateKey;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly recipients: readonly SpeakerCommunicationRecipientInput[];
}

interface NormalizedRecipient {
  readonly personId: string;
  readonly normalizedEmail: string;
  readonly displayName: string;
  readonly mergeFields: Readonly<Partial<Record<SpeakerCommunicationRecipientMergeField, string>>>;
}

interface NormalizedBatchInput {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly templateKey: SpeakerCommunicationTemplateKey;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly recipients: readonly NormalizedRecipient[];
  readonly requestFingerprint: string;
}

interface StoredMessageReceipt {
  readonly messageId: string;
  readonly personId: string;
  readonly normalizedEmail: string;
  readonly destinationKey: string;
  readonly payloadFingerprint: string;
  readonly subjectPreview: string;
  readonly bodyPreview: string;
}

interface StoredBatchPayload {
  readonly schema: typeof SPEAKER_COMMUNICATIONS_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly templateKey: SpeakerCommunicationTemplateKey;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly eventName: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
  readonly recipients: readonly NormalizedRecipient[];
  readonly messages: readonly StoredMessageReceipt[];
}

export interface SpeakerCommunicationReceiptMessage extends StoredMessageReceipt {
  readonly status: "PENDING";
}

export interface SpeakerCommunicationBatchReceipt {
  readonly schema: typeof SPEAKER_COMMUNICATION_RECEIPT_SCHEMA;
  readonly batchId: string;
  readonly domainEventId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly idempotencyKey: string;
  readonly templateKey: SpeakerCommunicationTemplateKey;
  readonly requestFingerprint: string;
  readonly payloadFingerprint: string;
  readonly recipientCount: number;
  readonly messageIds: readonly string[];
  readonly messages: readonly SpeakerCommunicationReceiptMessage[];
  readonly channel: "local";
  readonly providerMutation: false;
  readonly createdAt: string;
}

export type SpeakerCommunicationDeliveryStatus = "PENDING" | "CLAIMED" | "DELIVERED" | "FAILED";

export interface SpeakerCommunicationDeliveryLogEntry {
  readonly messageId: string;
  readonly domainEventId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly normalizedEmail: string;
  readonly displayName: string;
  readonly destinationKey: string;
  readonly templateKey: SpeakerCommunicationTemplateKey;
  readonly subjectPreview: string;
  readonly bodyPreview: string;
  readonly payloadFingerprint: string;
  readonly status: SpeakerCommunicationDeliveryStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly channel: "local";
  readonly providerMutation: false;
}

export type SpeakerCommunicationsErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_TEMPLATE"
  | "UNKNOWN_PLACEHOLDER"
  | "CONTROL_CHARACTER_REJECTED"
  | "HTML_NOT_SUPPORTED"
  | "DUPLICATE_RECIPIENT"
  | "WORKSPACE_EVENT_NOT_FOUND"
  | "PERSON_NOT_AUTHORIZED"
  | "PERSON_SNAPSHOT_MISMATCH"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "OUTBOX_STATE_INVALID"
  | "PERSISTENCE_FAILED";

export class SpeakerCommunicationsError extends Error {
  readonly code: SpeakerCommunicationsErrorCode;

  constructor(code: SpeakerCommunicationsErrorCode, message: string) {
    super(message);
    this.name = "SpeakerCommunicationsError";
    this.code = code;
  }
}

export class SpeakerCommunicationsInputError extends SpeakerCommunicationsError {
  constructor(code: Extract<SpeakerCommunicationsErrorCode, "INVALID_INPUT" | "UNSUPPORTED_TEMPLATE" | "UNKNOWN_PLACEHOLDER" | "CONTROL_CHARACTER_REJECTED" | "HTML_NOT_SUPPORTED" | "DUPLICATE_RECIPIENT">, message: string) {
    super(code, message);
    this.name = "SpeakerCommunicationsInputError";
  }
}

export class SpeakerCommunicationsAuthorizationError extends SpeakerCommunicationsError {
  constructor(code: Extract<SpeakerCommunicationsErrorCode, "WORKSPACE_EVENT_NOT_FOUND" | "PERSON_NOT_AUTHORIZED" | "PERSON_SNAPSHOT_MISMATCH">, message: string) {
    super(code, message);
    this.name = "SpeakerCommunicationsAuthorizationError";
  }
}

export class SpeakerCommunicationsConflictError extends SpeakerCommunicationsError {
  constructor(message = "The speaker communication idempotency key conflicts with an existing batch.") {
    super("IDEMPOTENCY_KEY_CONFLICT", message);
    this.name = "SpeakerCommunicationsConflictError";
  }
}

const SAFE_IDENTIFIER = /^[^\u0000-\u001f\u007f-\u009f]{1,160}$/u;
const TEMPLATE_PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu;
const HTML_TAG = /<\/?[A-Za-z][^>]*>/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/u;
const RECIPIENT_KEYS = ["personId", "email", "displayName", "mergeFields"] as const;
const BATCH_KEYS = [
  "workspaceId",
  "eventId",
  "idempotencyKey",
  "templateKey",
  "subjectTemplate",
  "bodyTemplate",
  "recipients",
] as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failInput(message: string): never {
  throw new SpeakerCommunicationsInputError("INVALID_INPUT", message);
}

function failControl(field: string): never {
  throw new SpeakerCommunicationsInputError("CONTROL_CHARACTER_REJECTED", `${field} contains an unsupported control character.`);
}

function assertAllowedKeys(value: RecordValue, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    failInput(`${field} contains an unsupported field.`);
  }
}

function boundedText(value: unknown, field: string, maxLength: number, allowLineFeeds = false): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.trim().length < 1) {
    failInput(`${field} is invalid.`);
  }
  const controlPattern = allowLineFeeds
    ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
    : /[\u0000-\u001f\u007f-\u009f]/u;
  if (controlPattern.test(value)) failControl(field);
  return value;
}

function safeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value) || value.trim() !== value) {
    failInput(`${field} is invalid.`);
  }
  return value;
}

function normalizedEmail(value: unknown, field: string): string {
  const email = boundedText(value, field, 320).trim().toLowerCase();
  if (!EMAIL.test(email)) failInput(`${field} is invalid.`);
  return email;
}

function assertPlainTextTemplate(value: unknown, field: string, maxLength: number, allowLineFeeds: boolean): string {
  const template = boundedText(value, field, maxLength, allowLineFeeds);
  if (HTML_TAG.test(template)) {
    throw new SpeakerCommunicationsInputError("HTML_NOT_SUPPORTED", `${field} must be plain text.`);
  }
  return template;
}

function assertTemplateSyntax(template: string, field: string): void {
  const allowed = new Set<string>(SPEAKER_COMMUNICATION_MERGE_FIELDS);
  for (const match of template.matchAll(TEMPLATE_PLACEHOLDER)) {
    const name = match[1];
    if (!name || !allowed.has(name)) {
      throw new SpeakerCommunicationsInputError("UNKNOWN_PLACEHOLDER", `${field} contains an unsupported merge placeholder.`);
    }
  }
  const withoutValidPlaceholders = template.replace(TEMPLATE_PLACEHOLDER, "");
  if (withoutValidPlaceholders.includes("{{") || withoutValidPlaceholders.includes("}}")) {
    throw new SpeakerCommunicationsInputError("UNKNOWN_PLACEHOLDER", `${field} contains an invalid merge placeholder.`);
  }
}

function normalizeMergeFields(value: unknown): Readonly<Partial<Record<SpeakerCommunicationRecipientMergeField, string>>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) failInput("recipient merge fields are invalid.");
  assertAllowedKeys(value, SPEAKER_COMMUNICATION_RECIPIENT_MERGE_FIELDS, "recipient merge fields");
  const normalized: Partial<Record<SpeakerCommunicationRecipientMergeField, string>> = {};
  for (const key of SPEAKER_COMMUNICATION_RECIPIENT_MERGE_FIELDS) {
    if (value[key] !== undefined) {
      normalized[key] = boundedText(value[key], `recipient ${key}`, 240);
    }
  }
  return Object.freeze(normalized);
}

function normalizeRecipient(value: unknown): NormalizedRecipient {
  if (!isRecord(value)) failInput("recipient is invalid.");
  assertAllowedKeys(value, RECIPIENT_KEYS, "recipient");
  return {
    personId: safeIdentifier(value.personId, "recipient personId"),
    normalizedEmail: normalizedEmail(value.email, "recipient email"),
    displayName: boundedText(value.displayName, "recipient displayName", 240),
    mergeFields: normalizeMergeFields(value.mergeFields),
  };
}

function normalizeBatchInput(input: unknown): NormalizedBatchInput {
  if (!isRecord(input)) failInput("speaker communication batch input is invalid.");
  assertAllowedKeys(input, BATCH_KEYS, "speaker communication batch");
  const workspaceId = safeIdentifier(input.workspaceId, "workspaceId");
  const eventId = safeIdentifier(input.eventId, "eventId");
  const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 200);
  if (typeof input.templateKey !== "string" || !SPEAKER_COMMUNICATION_TEMPLATE_KEYS.includes(input.templateKey as SpeakerCommunicationTemplateKey)) {
    throw new SpeakerCommunicationsInputError("UNSUPPORTED_TEMPLATE", "The speaker communication template is not allowlisted.");
  }
  const templateKey = input.templateKey as SpeakerCommunicationTemplateKey;
  const subjectTemplate = assertPlainTextTemplate(input.subjectTemplate, "subjectTemplate", 240, false);
  const bodyTemplate = assertPlainTextTemplate(input.bodyTemplate, "bodyTemplate", 12000, true);
  assertTemplateSyntax(subjectTemplate, "subjectTemplate");
  assertTemplateSyntax(bodyTemplate, "bodyTemplate");
  if (!Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > SPEAKER_COMMUNICATION_MAX_RECIPIENTS) {
    failInput("speaker communication recipients are outside the bounded range.");
  }
  const recipients = input.recipients.map(normalizeRecipient);
  const personIds = new Set<string>();
  const emails = new Set<string>();
  for (const recipient of recipients) {
    if (personIds.has(recipient.personId) || emails.has(recipient.normalizedEmail)) {
      throw new SpeakerCommunicationsInputError("DUPLICATE_RECIPIENT", "Speaker communication recipients must have unique people and email destinations.");
    }
    personIds.add(recipient.personId);
    emails.add(recipient.normalizedEmail);
  }
  const requestBasis = {
    schema: SPEAKER_COMMUNICATIONS_SCHEMA,
    workspaceId,
    eventId,
    idempotencyKey,
    templateKey,
    subjectTemplate,
    bodyTemplate,
    recipients,
  };
  return {
    ...requestBasis,
    requestFingerprint: fingerprintOf(requestBasis),
  };
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function renderTemplate(template: string, field: string, context: Readonly<Record<SpeakerCommunicationMergeField, string>>): string {
  return template.replace(TEMPLATE_PLACEHOLDER, (_whole, name: string) => {
    const value = context[name as SpeakerCommunicationMergeField];
    if (value === undefined) {
      throw new SpeakerCommunicationsInputError("UNKNOWN_PLACEHOLDER", `${field} references a missing merge field.`);
    }
    return value;
  });
}

function normalizeStoredEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker identity data is invalid.");
  }
  return value.trim().toLowerCase();
}

function storedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", `Stored ${field} data is invalid.`);
  }
  return value;
}

interface EventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
}

interface PersonRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly canonical_email: string;
  readonly full_name: string;
}

function validateWorkspaceEventAndPeople(db: DatabaseSync, input: NormalizedBatchInput): { readonly event: EventRow; readonly people: readonly PersonRow[] } {
  const event = db.prepare(
    `SELECT id, workspace_id, name
     FROM events
     WHERE id = ? AND workspace_id = ?`,
  ).get(input.eventId, input.workspaceId) as EventRow | undefined;
  if (!event) {
    throw new SpeakerCommunicationsAuthorizationError("WORKSPACE_EVENT_NOT_FOUND", "The requested event is not available in the workspace.");
  }
  const eventName = storedText(event.name, "event", 240);
  if (HTML_TAG.test(eventName)) {
    throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored event data is not plain text.");
  }

  const people: PersonRow[] = [];
  const personStatement = db.prepare(
    `SELECT id, workspace_id, canonical_email, full_name
     FROM people
     WHERE id = ? AND workspace_id = ?`,
  );
  const speakerStatement = db.prepare(
    `SELECT 1
     FROM event_speakers
     WHERE id IS NOT NULL AND workspace_id = ? AND event_id = ? AND person_id = ?
     LIMIT 1`,
  );
  for (const recipient of input.recipients) {
    const person = personStatement.get(recipient.personId, input.workspaceId) as PersonRow | undefined;
    if (!person) {
      throw new SpeakerCommunicationsAuthorizationError("PERSON_NOT_AUTHORIZED", "A speaker recipient is not in the requested workspace.");
    }
    if (!speakerStatement.get(input.workspaceId, input.eventId, recipient.personId)) {
      throw new SpeakerCommunicationsAuthorizationError("PERSON_NOT_AUTHORIZED", "A speaker recipient is not bound to the requested event.");
    }
    if (normalizeStoredEmail(person.canonical_email) !== recipient.normalizedEmail || person.full_name !== recipient.displayName) {
      throw new SpeakerCommunicationsAuthorizationError("PERSON_SNAPSHOT_MISMATCH", "A speaker recipient snapshot does not match the canonical Person.");
    }
    storedText(person.full_name, "person", 240);
    people.push(person);
  }
  return { event: { ...event, name: eventName }, people };
}

function buildStoredBatchPayload(
  input: NormalizedBatchInput,
  eventName: string,
  domainEventId: string,
  createdAt: string,
): { readonly payload: StoredBatchPayload; readonly messagePayloads: readonly { readonly id: string; readonly destinationKey: string; readonly payloadJson: string; readonly payloadFingerprint: string }[] } {
  const messages: Array<StoredMessageReceipt> = [];
  const messagePayloads: Array<{ readonly id: string; readonly destinationKey: string; readonly payloadJson: string; readonly payloadFingerprint: string }> = [];
  for (const recipient of input.recipients) {
    const context = {
      displayName: recipient.displayName,
      firstName: recipient.mergeFields.firstName ?? recipient.displayName.split(/\s+/u, 1)[0] ?? recipient.displayName,
      organization: recipient.mergeFields.organization ?? "",
      title: recipient.mergeFields.title ?? "",
      eventName,
    } satisfies Record<SpeakerCommunicationMergeField, string>;
    const subjectPreview = renderTemplate(input.subjectTemplate, "subjectTemplate", context);
    const bodyPreview = renderTemplate(input.bodyTemplate, "bodyTemplate", context);
    const messageId = uuid();
    const destinationKey = `local:speaker-communication:${input.eventId}:${recipient.personId}:${fingerprintOf({ requestFingerprint: input.requestFingerprint, personId: recipient.personId })}`;
    const messageBasis = {
      schema: SPEAKER_COMMUNICATION_MESSAGE_SCHEMA,
      workspaceId: input.workspaceId,
      eventId: input.eventId,
      domainEventId,
      templateKey: input.templateKey,
      subjectTemplate: input.subjectTemplate,
      bodyTemplate: input.bodyTemplate,
      recipient,
      renderedPreview: { subject: subjectPreview, body: bodyPreview },
      channel: "local" as const,
      providerMutation: false as const,
      destinationKey,
    };
    const payloadFingerprint = fingerprintOf(messageBasis);
    const messagePayload = {
      ...messageBasis,
      destinationKey,
      payloadFingerprint,
    };
    messages.push({
      messageId,
      personId: recipient.personId,
      normalizedEmail: recipient.normalizedEmail,
      destinationKey,
      payloadFingerprint,
      subjectPreview,
      bodyPreview,
    });
    messagePayloads.push({
      id: messageId,
      destinationKey,
      payloadJson: canonicalJson(messagePayload),
      payloadFingerprint,
    });
  }
  const payload: StoredBatchPayload = {
    schema: SPEAKER_COMMUNICATIONS_SCHEMA,
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    templateKey: input.templateKey,
    subjectTemplate: input.subjectTemplate,
    bodyTemplate: input.bodyTemplate,
    eventName,
    requestFingerprint: input.requestFingerprint,
    createdAt,
    recipients: input.recipients,
    messages,
  };
  return { payload, messagePayloads };
}

function parseStoredBatchPayload(value: unknown): StoredBatchPayload {
  if (typeof value !== "string") {
    throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication evidence is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication evidence is invalid.");
  }
  if (!isRecord(parsed) || parsed.schema !== SPEAKER_COMMUNICATIONS_SCHEMA || !Array.isArray(parsed.recipients) || !Array.isArray(parsed.messages)) {
    throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication evidence is invalid.");
  }
  return parsed as unknown as StoredBatchPayload;
}

function verifyOutboxRows(db: DatabaseSync, workspaceId: string, domainEventId: string, messages: readonly StoredMessageReceipt[]): void {
  const rows = db.prepare(
    `SELECT id, workspace_id, domain_event_id, destination_key, payload_json
     FROM outbox_messages
     WHERE workspace_id = ? AND domain_event_id = ?
     ORDER BY created_at ASC, rowid ASC`,
  ).all(workspaceId, domainEventId) as Array<{
    id: unknown;
    workspace_id: unknown;
    domain_event_id: unknown;
    destination_key: unknown;
    payload_json: unknown;
  }>;
  if (rows.length !== messages.length) {
    throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication delivery rows are incomplete.");
  }
  const expected = new Map(messages.map((message) => [message.messageId, message]));
  for (const row of rows) {
    if (typeof row.id !== "string" || row.workspace_id !== workspaceId || row.domain_event_id !== domainEventId || typeof row.destination_key !== "string" || typeof row.payload_json !== "string") {
      throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication delivery rows are invalid.");
    }
    const message = expected.get(row.id);
    if (!message || message.destinationKey !== row.destination_key) {
      throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication delivery rows are invalid.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication delivery rows are invalid.");
    }
    if (!isRecord(payload) || payload.schema !== SPEAKER_COMMUNICATION_MESSAGE_SCHEMA || payload.payloadFingerprint !== message.payloadFingerprint || payload.destinationKey !== message.destinationKey || payload.providerMutation !== false || payload.channel !== "local") {
      throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication delivery rows are invalid.");
    }
  }
}

function receiptFromStoredBatch(
  db: DatabaseSync,
  domainEventId: string,
  domainPayloadJson: string,
  domainPayloadFingerprint: string,
  createdAt: string,
): SpeakerCommunicationBatchReceipt {
  const payload = parseStoredBatchPayload(domainPayloadJson);
  if (canonicalJson(payload) !== domainPayloadJson || fingerprintOf(payload) !== domainPayloadFingerprint) {
    throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication evidence is not canonical.");
  }
  if (payload.messages.length !== payload.recipients.length || payload.workspaceId.length < 1 || payload.eventId.length < 1) {
    throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Stored speaker communication evidence is incomplete.");
  }
  verifyOutboxRows(db, payload.workspaceId, domainEventId, payload.messages);
  const messages = payload.messages.map((message) => ({ ...message, status: "PENDING" as const }));
  return freezeDeep({
    schema: SPEAKER_COMMUNICATION_RECEIPT_SCHEMA,
    batchId: domainEventId,
    domainEventId,
    workspaceId: payload.workspaceId,
    eventId: payload.eventId,
    eventName: payload.eventName,
    idempotencyKey: payload.idempotencyKey,
    templateKey: payload.templateKey,
    requestFingerprint: payload.requestFingerprint,
    payloadFingerprint: domainPayloadFingerprint,
    recipientCount: messages.length,
    messageIds: messages.map((message) => message.messageId),
    messages,
    channel: "local" as const,
    providerMutation: false as const,
    createdAt,
  });
}

function findExistingBatch(db: DatabaseSync, input: NormalizedBatchInput): Array<{ id: string; payload_json: string; payload_fingerprint: string; created_at: string }> {
  return db.prepare(
    `SELECT id, payload_json, payload_fingerprint, created_at
     FROM domain_events
     WHERE workspace_id = ?
       AND event_type = ?
       AND aggregate_type = ?
       AND json_extract(payload_json, '$.eventId') = ?
       AND json_extract(payload_json, '$.idempotencyKey') = ?
     ORDER BY created_at ASC, rowid ASC`,
  ).all(
    input.workspaceId,
    SPEAKER_COMMUNICATION_EVENT_TYPE,
    SPEAKER_COMMUNICATION_AGGREGATE_TYPE,
    input.eventId,
    input.idempotencyKey,
  ) as Array<{ id: string; payload_json: string; payload_fingerprint: string; created_at: string }>;
}

function withTransaction<T>(db: DatabaseSync, operation: () => T): T {
  const nested = db.isTransaction;
  const savepoint = "speaker_communications_outbox";
  try {
    db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    const result = operation();
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK");
    } catch {
      // Preserve the bounded domain error below; transaction cleanup is best effort.
    }
    if (error instanceof SpeakerCommunicationsError) throw error;
    throw new SpeakerCommunicationsError("PERSISTENCE_FAILED", "The speaker communication batch could not be queued.");
  }
}

/** Queue one bounded, local-only speaker batch and its durable per-recipient outbox rows. */
export function queueSpeakerCommunicationBatch(
  db: DatabaseSync,
  input: QueueSpeakerCommunicationBatchInput,
): SpeakerCommunicationBatchReceipt {
  const normalized = normalizeBatchInput(input);
  return withTransaction(db, () => {
    const existing = findExistingBatch(db, normalized);
    if (existing.length > 1) {
      throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "Multiple speaker communication batches use the same idempotency key.");
    }
    if (existing.length === 1) {
      const prior = existing[0];
      const storedPayload = parseStoredBatchPayload(prior.payload_json);
      if (storedPayload.requestFingerprint !== normalized.requestFingerprint) {
        throw new SpeakerCommunicationsConflictError();
      }
      return receiptFromStoredBatch(db, prior.id, prior.payload_json, prior.payload_fingerprint, prior.created_at);
    }

    const { event, people } = validateWorkspaceEventAndPeople(db, normalized);
    void people;
    const domainEventId = uuid();
    const createdAt = nowIso();
    const { payload, messagePayloads } = buildStoredBatchPayload(normalized, event.name, domainEventId, createdAt);
    const payloadJson = canonicalJson(payload);
    const payloadFingerprint = fingerprintOf(payload);
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      domainEventId,
      normalized.workspaceId,
      SPEAKER_COMMUNICATION_EVENT_TYPE,
      SPEAKER_COMMUNICATION_AGGREGATE_TYPE,
      `speaker-communication-batch:${fingerprintOf({ workspaceId: normalized.workspaceId, eventId: normalized.eventId, idempotencyKey: normalized.idempotencyKey })}`,
      payloadJson,
      payloadFingerprint,
      createdAt,
    );
    for (const message of messagePayloads) {
      db.prepare(
        `INSERT INTO outbox_messages
           (id, workspace_id, domain_event_id, destination_key, payload_json,
            status, attempt_count, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
      ).run(
        message.id,
        normalized.workspaceId,
        domainEventId,
        message.destinationKey,
        message.payloadJson,
        createdAt,
        createdAt,
      );
    }
    return receiptFromStoredBatch(db, domainEventId, payloadJson, payloadFingerprint, createdAt);
  });
}

/** Read only the local delivery-log projection for one workspace/event scope. */
export function listSpeakerCommunicationDeliveryLog(
  db: DatabaseSync,
  scope: { readonly workspaceId: string; readonly eventId: string },
): readonly SpeakerCommunicationDeliveryLogEntry[] {
  const workspaceId = safeIdentifier(scope.workspaceId, "workspaceId");
  const eventId = safeIdentifier(scope.eventId, "eventId");
  const rows = db.prepare(
    `SELECT o.id AS messageId,
            o.domain_event_id AS domainEventId,
            o.workspace_id AS workspaceId,
            json_extract(e.payload_json, '$.eventId') AS eventId,
            json_extract(o.payload_json, '$.recipient.personId') AS personId,
            json_extract(o.payload_json, '$.recipient.normalizedEmail') AS normalizedEmail,
            json_extract(o.payload_json, '$.recipient.displayName') AS displayName,
            o.destination_key AS destinationKey,
            json_extract(o.payload_json, '$.templateKey') AS templateKey,
            json_extract(o.payload_json, '$.renderedPreview.subject') AS subjectPreview,
            json_extract(o.payload_json, '$.renderedPreview.body') AS bodyPreview,
            json_extract(o.payload_json, '$.payloadFingerprint') AS payloadFingerprint,
            o.status,
            o.attempt_count AS attemptCount,
            o.next_attempt_at AS nextAttemptAt,
            o.created_at AS createdAt,
            o.delivered_at AS deliveredAt
       FROM outbox_messages o
       JOIN domain_events e
         ON e.id = o.domain_event_id
        AND e.workspace_id = o.workspace_id
      WHERE o.workspace_id = ?
        AND e.workspace_id = ?
        AND e.event_type = ?
        AND e.aggregate_type = ?
        AND json_extract(e.payload_json, '$.workspaceId') = ?
        AND json_extract(e.payload_json, '$.eventId') = ?
        AND json_extract(o.payload_json, '$.workspaceId') = ?
        AND json_extract(o.payload_json, '$.eventId') = ?
      ORDER BY o.created_at ASC, o.rowid ASC`,
  ).all(
    workspaceId,
    workspaceId,
    SPEAKER_COMMUNICATION_EVENT_TYPE,
    SPEAKER_COMMUNICATION_AGGREGATE_TYPE,
    workspaceId,
    eventId,
    workspaceId,
    eventId,
  ) as Array<Record<string, unknown>>;
  return freezeDeep(rows.map((row) => ({
    messageId: row.messageId as string,
    domainEventId: row.domainEventId as string,
    workspaceId: row.workspaceId as string,
    eventId: row.eventId as string,
    personId: row.personId as string,
    normalizedEmail: row.normalizedEmail as string,
    displayName: row.displayName as string,
    destinationKey: row.destinationKey as string,
    templateKey: row.templateKey as SpeakerCommunicationTemplateKey,
    subjectPreview: row.subjectPreview as string,
    bodyPreview: row.bodyPreview as string,
    payloadFingerprint: row.payloadFingerprint as string,
    status: row.status as SpeakerCommunicationDeliveryStatus,
    attemptCount: row.attemptCount as number,
    nextAttemptAt: (row.nextAttemptAt as string | null) ?? null,
    createdAt: row.createdAt as string,
    deliveredAt: (row.deliveredAt as string | null) ?? null,
    channel: "local" as const,
    providerMutation: false as const,
  })));
}

export const queueSpeakerBulkCommunication = queueSpeakerCommunicationBatch;
export const getSpeakerCommunicationDeliveryLog = listSpeakerCommunicationDeliveryLog;
