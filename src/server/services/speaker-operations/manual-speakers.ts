import type { Db } from "../../db";
import { withTransactionOrSavepoint } from "../../db";
import { canonicalJson, fingerprintOf, nowIso, uuid } from "../../canonical";
import { writeAudit } from "../audit";
import { listSpeakerCommunicationDeliveryLog, type SpeakerCommunicationDeliveryLogEntry } from "../speaker-communications";
import type { SpeakerOrganizerScope, SpeakerRosterFilter } from "./contracts";

export const MANUAL_SPEAKER_SCHEMA = "sympose-manual-speaker/v1" as const;
export const MANUAL_SPEAKER_PROFILE_SCHEMA = "sympose-manual-speaker-profile/v1" as const;
export const MANUAL_SPEAKER_EVENT_SCHEMA = "sympose-manual-speaker-event/v1" as const;
export const MANUAL_SPEAKER_SOURCE_PROVIDER = "organizer-manual" as const;
export const MANUAL_SPEAKER_EMAIL_POLICY = "read-only-after-create" as const;
export const MANUAL_SPEAKER_PARTICIPATION_STATUS = "PENDING" as const;
export const MANUAL_SPEAKER_CANONICAL_PERSON_AUTHORITY = "workspace-person" as const;
export const MANUAL_SPEAKER_EVENT_PROFILE_AUTHORITY = "event-scoped-manual-source" as const;

const MANUAL_SPEAKER_SOURCE_REF_PREFIX = "manual-speaker";
const MANUAL_SPEAKER_EVENT_PROFILE_FIELDS = ["organization", "title", "bio"] as const;
const TRUSTED_PARTICIPATION_STATUSES = new Set(["PENDING", "INVITED", "CONFIRMED", "WAITLISTED", "DECLINED", "CANCELED"]);
const TRUSTED_DELIVERY_STATUSES = new Set<SpeakerCommunicationDeliveryLogEntry["status"]>(["PENDING", "CLAIMED", "DELIVERED", "FAILED"]);
const SAFE_IDENTIFIER = /^[^\u0000-\u001f\u007f-\u009f]{1,160}$/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_CHARACTERS_WITH_LINE_FEEDS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const ORGANIZER_ROLES = new Set(["organizer", "workspace_admin", "event_manager", "program_manager"]);

export type ManualSpeakerErrorCode =
  | "INVALID_INPUT"
  | "CONTROL_CHARACTER_REJECTED"
  | "WORKSPACE_EVENT_NOT_FOUND"
  | "ORGANIZER_NOT_AUTHORIZED"
  | "PERSON_NOT_IN_EVENT"
  | "DUPLICATE_EMAIL_CONFLICT"
  | "EMAIL_READ_ONLY"
  | "CANONICAL_NAME_STALE"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "STATE_INVALID"
  | "PERSISTENCE_FAILED";

export class ManualSpeakerError extends Error {
  readonly code: ManualSpeakerErrorCode;

  constructor(code: ManualSpeakerErrorCode, message: string) {
    super(message);
    this.name = "ManualSpeakerError";
    this.code = code;
  }
}

export class ManualSpeakerInputError extends ManualSpeakerError {
  constructor(code: Extract<ManualSpeakerErrorCode, "INVALID_INPUT" | "CONTROL_CHARACTER_REJECTED">, message: string) {
    super(code, message);
    this.name = "ManualSpeakerInputError";
  }
}

export class ManualSpeakerAuthorizationError extends ManualSpeakerError {
  constructor(code: Extract<ManualSpeakerErrorCode, "WORKSPACE_EVENT_NOT_FOUND" | "ORGANIZER_NOT_AUTHORIZED" | "PERSON_NOT_IN_EVENT">, message: string) {
    super(code, message);
    this.name = "ManualSpeakerAuthorizationError";
  }
}

export class ManualSpeakerConflictError extends ManualSpeakerError {
  constructor(code: Extract<ManualSpeakerErrorCode, "DUPLICATE_EMAIL_CONFLICT" | "EMAIL_READ_ONLY" | "CANONICAL_NAME_STALE" | "IDEMPOTENCY_KEY_CONFLICT">, message: string) {
    super(code, message);
    this.name = "ManualSpeakerConflictError";
  }
}

export type ManualSpeakerDeliveryState = SpeakerCommunicationDeliveryLogEntry["status"] | "NO_DURABLE_EVIDENCE";

export interface ManualSpeakerDeliveryEvidence {
  readonly source: "durable-outbox" | "no-durable-evidence";
  readonly state: ManualSpeakerDeliveryState;
  readonly messageIds: readonly string[];
  readonly latestAt: string | null;
}

interface ManualSpeakerProfile {
  readonly fullName: string;
  readonly organization: string;
  readonly title: string;
  readonly bio: string;
}

export interface ManualSpeakerRecord extends ManualSpeakerProfile {
  readonly schema: typeof MANUAL_SPEAKER_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly eventSpeakerId: string;
  readonly personId: string;
  readonly roleKey: string;
  readonly participationStatus: string;
  readonly participationStatusTrust: "TRUSTED" | "UNVERIFIED";
  readonly email: string;
  readonly canonicalIdentity: "Person";
  readonly emailPolicy: typeof MANUAL_SPEAKER_EMAIL_POLICY;
  readonly managementState: "MANUAL_PROVENANCE" | "UNVERIFIED_EVENT_RELATION";
  readonly deliveryEvidence: ManualSpeakerDeliveryEvidence;
  /** Compatibility aliases: fullName/email are canonical; the remaining profile fields are event-scoped. */
  readonly canonicalPerson: {
    readonly fullName: string;
    readonly email: string;
    readonly authority: typeof MANUAL_SPEAKER_CANONICAL_PERSON_AUTHORITY;
  };
  readonly eventProfile: {
    readonly organization: string;
    readonly title: string;
    readonly bio: string;
    readonly authority: typeof MANUAL_SPEAKER_EVENT_PROFILE_AUTHORITY | "workspace-person-fallback" | "unverified-event-relation";
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provenance: {
    readonly provider: typeof MANUAL_SPEAKER_SOURCE_PROVIDER | "unverified-event-relation";
    readonly scope: "event";
    readonly fields: readonly (typeof MANUAL_SPEAKER_EVENT_PROFILE_FIELDS[number])[];
    readonly sourceRef: string;
    readonly sourceRecordId: string | null;
    readonly sourceVersion: number | null;
    readonly recordedAt: string | null;
  };
}

export interface CreateManualSpeakerInput {
  readonly fullName: string;
  readonly email: string;
  readonly title?: string;
  readonly organization?: string;
  readonly bio?: string;
  readonly idempotencyKey?: string;
}

export interface EditManualSpeakerInput {
  readonly personId: string;
  /** The submitted canonical email snapshot. Email itself is never mutable here. */
  readonly expectedEmail?: string;
  /** The submitted canonical name snapshot. Canonical Person edits use compare-and-swap semantics. */
  readonly expectedFullName: string;
  /** Alias accepted at the service boundary for callers that use the form field name. */
  readonly email?: string;
  readonly fullName: string;
  readonly title?: string;
  readonly organization?: string;
  readonly bio?: string;
  readonly idempotencyKey?: string;
}

export interface ManualSpeakerMutationResult {
  readonly schema: typeof MANUAL_SPEAKER_SCHEMA;
  readonly record: ManualSpeakerRecord;
  readonly createdPerson: boolean;
  readonly createdEventSpeaker: boolean;
  readonly linkedExistingPerson: boolean;
  readonly replayed: boolean;
  readonly deduped: boolean;
  readonly emailPolicy: typeof MANUAL_SPEAKER_EMAIL_POLICY;
}

interface PersonRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly canonical_email: string;
  readonly full_name: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly created_at: string;
}

interface EventSpeakerRow {
  readonly eventSpeakerId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly roleKey: string;
  readonly participationStatus: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly email: string;
  readonly fullName: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly sourceRecordId: string | null;
  readonly sourceVersion: number | null;
  readonly sourcePayloadJson: string | null;
  readonly sourceRecordedAt: string | null;
}

interface StoredSourceProfile extends ManualSpeakerProfile {
  readonly schema: typeof MANUAL_SPEAKER_PROFILE_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly eventSpeakerId: string;
  readonly email: string;
  readonly sourceRef: string;
  readonly sourceVersion: number;
  readonly operation: "created" | "linked" | "updated";
  readonly actorId: string;
  readonly recordedAt: string;
}

interface StoredManualEvent {
  readonly schema: typeof MANUAL_SPEAKER_EVENT_SCHEMA;
  readonly operation: "created" | "linked" | "updated" | "noop";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly eventSpeakerId: string;
  readonly personId: string;
  readonly sourceRecordId: string | null;
  readonly sourceVersion: number | null;
  readonly actorId: string;
  readonly idempotencyKey: string | null;
  readonly requestFingerprint: string;
  readonly request: ManualSpeakerRequest;
  readonly createdPerson: boolean;
  readonly createdEventSpeaker: boolean;
  readonly linkedExistingPerson: boolean;
  readonly next: ManualSpeakerProfile & { readonly email: string };
}

interface ManualSpeakerRequest {
  readonly schema: typeof MANUAL_SPEAKER_SCHEMA;
  readonly operation: "create" | "edit";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId?: string;
  readonly expectedEmail?: string;
  readonly expectedFullName?: string;
  readonly fullName: string;
  readonly email: string;
  readonly title: string;
  readonly organization: string;
  readonly bio: string;
}

interface StoredDomainEventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload_json: string;
  readonly payload_fingerprint: string;
  readonly created_at: string;
}

interface NormalizedScope {
  readonly kind: "organizer";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly actorId: string;
}

interface NormalizedCreateInput {
  readonly fullName: string;
  readonly email: string;
  readonly title: string;
  readonly organization: string;
  readonly bio: string;
  readonly idempotencyKey: string | null;
}

interface NormalizedEditInput extends NormalizedCreateInput {
  readonly personId: string;
  readonly expectedEmail: string;
  readonly expectedFullName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ManualSpeakerInputError("INVALID_INPUT", `${field} contains an unsupported field.`);
  }
}

function assertStoredKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedKeys = new Set(allowed);
  const keys = Object.keys(value);
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
    throw new ManualSpeakerError("STATE_INVALID", `Stored ${field} envelope is invalid.`);
  }
}

function failInput(message: string): never {
  throw new ManualSpeakerInputError("INVALID_INPUT", message);
}

function boundedText(value: unknown, field: string, maxLength: number, allowLineFeeds = false): string {
  if (typeof value !== "string" || value.length > maxLength || value.trim().length < 1) {
    failInput(`${field} is invalid.`);
  }
  const controlPattern = allowLineFeeds ? CONTROL_CHARACTERS_WITH_LINE_FEEDS : CONTROL_CHARACTERS;
  if (controlPattern.test(value)) {
    throw new ManualSpeakerInputError("CONTROL_CHARACTER_REJECTED", `${field} contains an unsupported control character.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number, allowLineFeeds = false): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") failInput(`${field} is invalid.`);
  if (value.length > maxLength) failInput(`${field} is invalid.`);
  const controlPattern = allowLineFeeds ? CONTROL_CHARACTERS_WITH_LINE_FEEDS : CONTROL_CHARACTERS;
  if (controlPattern.test(value)) {
    throw new ManualSpeakerInputError("CONTROL_CHARACTER_REJECTED", `${field} contains an unsupported control character.`);
  }
  return value.trim();
}

function safeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value) || value.trim() !== value) {
    failInput(`${field} is invalid.`);
  }
  return value;
}

function normalizeEmail(value: unknown, field: string): string {
  const email = boundedText(value, field, 320).normalize("NFKC").toLowerCase();
  if (!EMAIL.test(email)) failInput(`${field} is invalid.`);
  return email;
}

function normalizeComparableText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function normalizeScope(scope: unknown): NormalizedScope {
  if (!isRecord(scope)) failInput("organizer scope is invalid.");
  assertAllowedKeys(scope, ["kind", "workspaceId", "eventId", "actorId"], "organizer scope");
  if (scope.kind !== "organizer") failInput("organizer scope is invalid.");
  return {
    kind: "organizer",
    workspaceId: safeIdentifier(scope.workspaceId, "workspaceId"),
    eventId: safeIdentifier(scope.eventId, "eventId"),
    actorId: safeIdentifier(scope.actorId, "actorId"),
  };
}

function optionalIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return boundedText(value, "idempotencyKey", 200);
}

function normalizeCreateInput(input: unknown): NormalizedCreateInput {
  if (!isRecord(input)) failInput("manual speaker input is invalid.");
  assertAllowedKeys(input, ["fullName", "email", "title", "organization", "bio", "idempotencyKey"], "manual speaker input");
  return {
    fullName: boundedText(input.fullName, "fullName", 240),
    email: normalizeEmail(input.email, "email"),
    title: optionalText(input.title, "title", 240),
    organization: optionalText(input.organization, "organization", 240),
    bio: optionalText(input.bio, "bio", 4_000, true),
    idempotencyKey: optionalIdempotencyKey(input.idempotencyKey),
  };
}

function normalizeEditInput(input: unknown): NormalizedEditInput {
  if (!isRecord(input)) failInput("manual speaker edit input is invalid.");
  assertAllowedKeys(input, ["personId", "expectedEmail", "expectedFullName", "email", "fullName", "title", "organization", "bio", "idempotencyKey"], "manual speaker edit input");
  const expectedEmailValue = input.expectedEmail ?? input.email;
  if (expectedEmailValue === undefined) failInput("email snapshot is required.");
  if (input.expectedFullName === undefined) failInput("canonical name snapshot is required.");
  const expectedEmail = normalizeEmail(expectedEmailValue, "email");
  if (input.expectedEmail !== undefined && input.email !== undefined && normalizeEmail(input.email, "email") !== expectedEmail) {
    failInput("email snapshot is ambiguous.");
  }
  return {
    personId: safeIdentifier(input.personId, "personId"),
    expectedEmail,
    expectedFullName: boundedText(input.expectedFullName, "expectedFullName", 240),
    fullName: boundedText(input.fullName, "fullName", 240),
    email: expectedEmail,
    title: optionalText(input.title, "title", 240),
    organization: optionalText(input.organization, "organization", 240),
    bio: optionalText(input.bio, "bio", 4_000, true),
    idempotencyKey: optionalIdempotencyKey(input.idempotencyKey),
  };
}

function stateText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || CONTROL_CHARACTERS.test(value)) {
    throw new ManualSpeakerError("STATE_INVALID", `Stored ${field} is invalid.`);
  }
  return value;
}

function stateOptionalText(value: unknown, field: string, maxLength: number, allowLineFeeds = false): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" || value.length > maxLength || (allowLineFeeds ? CONTROL_CHARACTERS_WITH_LINE_FEEDS : CONTROL_CHARACTERS).test(value)) {
    throw new ManualSpeakerError("STATE_INVALID", `Stored ${field} is invalid.`);
  }
  return value;
}

function statePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ManualSpeakerError("STATE_INVALID", `Stored ${field} is invalid.`);
  }
  return value;
}

function sourceRef(eventId: string, personId: string): string {
  return `${MANUAL_SPEAKER_SOURCE_REF_PREFIX}:${eventId}:${personId}`;
}

function profileFromInput(input: NormalizedCreateInput | NormalizedEditInput): ManualSpeakerProfile {
  return {
    fullName: input.fullName,
    organization: input.organization,
    title: input.title,
    bio: input.bio,
  };
}

function profileMatchesProvided(record: ManualSpeakerRecord, input: NormalizedCreateInput): boolean {
  if (normalizeComparableText(record.fullName) !== normalizeComparableText(input.fullName)) return false;
  if (input.title && normalizeComparableText(record.title) !== normalizeComparableText(input.title)) return false;
  if (input.organization && normalizeComparableText(record.organization) !== normalizeComparableText(input.organization)) return false;
  if (input.bio && record.bio !== input.bio) return false;
  return true;
}

function profileWithExistingPersonDefaults(input: NormalizedCreateInput, person: PersonRow, current?: ManualSpeakerRecord): NormalizedCreateInput {
  return {
    ...input,
    fullName: current?.fullName ?? stateText(person.full_name, "fullName", 240),
    organization: input.organization || current?.eventProfile.organization || "",
    title: input.title || current?.eventProfile.title || "",
    bio: input.bio || current?.bio || "",
  };
}

function profileEqual(left: ManualSpeakerProfile, right: ManualSpeakerProfile): boolean {
  return left.fullName === right.fullName && left.organization === right.organization && left.title === right.title && left.bio === right.bio;
}

function profilePayload(
  scope: NormalizedScope,
  row: Pick<EventSpeakerRow, "eventSpeakerId" | "personId">,
  input: NormalizedCreateInput | NormalizedEditInput,
  version: number,
  operation: StoredSourceProfile["operation"],
  recordedAt: string,
): StoredSourceProfile {
  return {
    schema: MANUAL_SPEAKER_PROFILE_SCHEMA,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    personId: row.personId,
    eventSpeakerId: row.eventSpeakerId,
    email: input.email,
    sourceRef: sourceRef(scope.eventId, row.personId),
    sourceVersion: version,
    operation,
    actorId: scope.actorId,
    recordedAt,
    ...profileFromInput(input),
  };
}

function parsedProfile(payloadJson: string | null, scope: NormalizedScope, row: Pick<EventSpeakerRow, "eventSpeakerId" | "personId">): StoredSourceProfile | null {
  if (payloadJson === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker provenance is not valid JSON.");
  }
  if (!isRecord(value) || canonicalJson(value) !== payloadJson) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker provenance fingerprint is invalid.");
  }
  if (!isRecord(value) || value.schema !== MANUAL_SPEAKER_PROFILE_SCHEMA || value.workspaceId !== scope.workspaceId || value.eventId !== scope.eventId || value.personId !== row.personId || value.eventSpeakerId !== row.eventSpeakerId) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker provenance is outside the authorized scope.");
  }
  assertStoredKeys(value, ["schema", "workspaceId", "eventId", "personId", "eventSpeakerId", "email", "sourceRef", "sourceVersion", "operation", "actorId", "recordedAt", "fullName", "organization", "title", "bio"], "speaker provenance");
  if (value.operation !== "created" && value.operation !== "linked" && value.operation !== "updated") {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker provenance operation is invalid.");
  }
  const operation = value.operation as StoredSourceProfile["operation"];
  const parsed = {
    schema: MANUAL_SPEAKER_PROFILE_SCHEMA,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    personId: row.personId,
    eventSpeakerId: row.eventSpeakerId,
    email: normalizeEmail(value.email, "stored email"),
    sourceRef: stateText(value.sourceRef, "sourceRef", 320),
    sourceVersion: statePositiveInteger(value.sourceVersion, "sourceVersion"),
    operation,
    actorId: stateText(value.actorId, "actorId", 160),
    recordedAt: stateText(value.recordedAt, "recordedAt", 128),
    fullName: stateText(value.fullName, "fullName", 240),
    organization: stateOptionalText(value.organization, "organization", 240),
    title: stateOptionalText(value.title, "title", 240),
    bio: stateOptionalText(value.bio, "bio", 4_000, true),
  };
  if (parsed.sourceRef !== sourceRef(scope.eventId, row.personId)) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker provenance source identity is invalid.");
  }
  return parsed;
}

function normalizeStoredPersonEmail(value: unknown): string {
  if (typeof value !== "string") throw new ManualSpeakerError("STATE_INVALID", "Stored Person email is invalid.");
  try {
    return normalizeEmail(value, "stored email");
  } catch (error) {
    if (error instanceof ManualSpeakerError) throw new ManualSpeakerError("STATE_INVALID", "Stored Person email is invalid.");
    throw error;
  }
}

function assertAuthorizedScope(db: Db, scope: NormalizedScope): void {
  const event = db.prepare("SELECT id FROM events WHERE id = ? AND workspace_id = ?").get(scope.eventId, scope.workspaceId) as { id: string } | undefined;
  if (!event) {
    throw new ManualSpeakerAuthorizationError("WORKSPACE_EVENT_NOT_FOUND", "The requested event is not available in the authorized workspace.");
  }
  const actor = db.prepare("SELECT id, role FROM accounts WHERE id = ? AND workspace_id = ?").get(scope.actorId, scope.workspaceId) as { id: string; role: string } | undefined;
  if (!actor || !ORGANIZER_ROLES.has(actor.role)) {
    throw new ManualSpeakerAuthorizationError("ORGANIZER_NOT_AUTHORIZED", "The organizer account is not authorized for speaker management in this workspace.");
  }
}

function personForEmail(db: Db, workspaceId: string, email: string): PersonRow | null {
  const candidates = db.prepare(
    `SELECT id, workspace_id, canonical_email, full_name, organization, title, created_at
     FROM people WHERE workspace_id = ? ORDER BY id`,
  ).all(workspaceId) as unknown as PersonRow[];
  const matches = candidates.filter((person) => normalizeStoredPersonEmail(person.canonical_email) === email);
  if (matches.length > 1) {
    throw new ManualSpeakerError("STATE_INVALID", "The workspace contains multiple canonical people for one normalized email.");
  }
  return matches[0] ?? null;
}

function personById(db: Db, workspaceId: string, personId: string): PersonRow | null {
  return (db.prepare(
    `SELECT id, workspace_id, canonical_email, full_name, organization, title, created_at
     FROM people WHERE id = ? AND workspace_id = ?`,
  ).get(personId, workspaceId) as PersonRow | undefined) ?? null;
}

function eventSpeakerForPerson(db: Db, scope: NormalizedScope, personId: string): EventSpeakerRow | null {
  const row = db.prepare(
    `SELECT es.id AS eventSpeakerId, es.workspace_id AS workspaceId, es.event_id AS eventId,
            es.person_id AS personId, es.role_key AS roleKey, es.participation_status AS participationStatus,
            es.created_at AS createdAt, es.updated_at AS updatedAt,
            p.canonical_email AS email, p.full_name AS fullName, p.organization, p.title,
            sr.id AS sourceRecordId, sr.version AS sourceVersion,
            sr.payload_json AS sourcePayloadJson, sr.imported_at AS sourceRecordedAt
     FROM event_speakers es
     JOIN events e ON e.id = es.event_id AND e.workspace_id = es.workspace_id
     JOIN people p ON p.id = es.person_id AND p.workspace_id = es.workspace_id
     LEFT JOIN source_records sr
       ON sr.id = (
         SELECT latest.id FROM source_records latest
         WHERE latest.workspace_id = es.workspace_id
           AND latest.provider = ?
           AND latest.source_ref = ?
         ORDER BY latest.version DESC, latest.id DESC
         LIMIT 1
       )
     WHERE es.workspace_id = ? AND es.event_id = ? AND es.person_id = ? AND es.role_key = 'SPEAKER'
     ORDER BY es.id
     LIMIT 1`,
  ).get(
    MANUAL_SPEAKER_SOURCE_PROVIDER,
    sourceRef(scope.eventId, personId),
    scope.workspaceId,
    scope.eventId,
    personId,
  ) as EventSpeakerRow | undefined;
  return row ?? null;
}

function eventSpeakerById(db: Db, scope: NormalizedScope, eventSpeakerId: string): EventSpeakerRow | null {
  const row = db.prepare(
    `SELECT es.id AS eventSpeakerId, es.workspace_id AS workspaceId, es.event_id AS eventId,
            es.person_id AS personId, es.role_key AS roleKey, es.participation_status AS participationStatus,
            es.created_at AS createdAt, es.updated_at AS updatedAt,
            p.canonical_email AS email, p.full_name AS fullName, p.organization, p.title,
            sr.id AS sourceRecordId, sr.version AS sourceVersion,
            sr.payload_json AS sourcePayloadJson, sr.imported_at AS sourceRecordedAt
     FROM event_speakers es
     JOIN events e ON e.id = es.event_id AND e.workspace_id = es.workspace_id
     JOIN people p ON p.id = es.person_id AND p.workspace_id = es.workspace_id
     LEFT JOIN source_records sr
       ON sr.id = (
         SELECT latest.id FROM source_records latest
         WHERE latest.workspace_id = es.workspace_id
           AND latest.provider = ?
           AND latest.source_ref = ('manual-speaker:' || es.event_id || ':' || es.person_id)
         ORDER BY latest.version DESC, latest.id DESC
         LIMIT 1
       )
     WHERE es.id = ? AND es.workspace_id = ? AND es.event_id = ? AND es.role_key = 'SPEAKER'
     LIMIT 1`,
  ).get(
    MANUAL_SPEAKER_SOURCE_PROVIDER,
    eventSpeakerId,
    scope.workspaceId,
    scope.eventId,
  ) as EventSpeakerRow | undefined;
  return row ?? null;
}

function noDurableDeliveryEvidence(): ManualSpeakerDeliveryEvidence {
  return Object.freeze({ source: "no-durable-evidence", state: "NO_DURABLE_EVIDENCE", messageIds: Object.freeze([]), latestAt: null });
}

function assertDeliveryEvidenceRow(
  scope: NormalizedScope,
  row: SpeakerCommunicationDeliveryLogEntry,
  personId?: string,
): void {
  if (
    typeof row.personId !== "string" ||
    row.workspaceId !== scope.workspaceId ||
    row.eventId !== scope.eventId ||
    (personId !== undefined && row.personId !== personId) ||
    !TRUSTED_DELIVERY_STATUSES.has(row.status)
  ) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker delivery evidence is outside the authorized scope.");
  }
}

function deliveryEvidenceFromRows(rows: readonly SpeakerCommunicationDeliveryLogEntry[]): ManualSpeakerDeliveryEvidence {
  if (rows.length === 0) return noDurableDeliveryEvidence();
  const latest = rows.at(-1)!;
  return Object.freeze({
    source: "durable-outbox",
    state: latest.status,
    messageIds: Object.freeze(rows.map((row) => row.messageId)),
    latestAt: latest.deliveredAt ?? latest.createdAt,
  });
}

function deliveryEvidenceForPerson(db: Db, scope: NormalizedScope, personId: string): ManualSpeakerDeliveryEvidence {
  let rows: readonly SpeakerCommunicationDeliveryLogEntry[];
  try {
    rows = listSpeakerCommunicationDeliveryLog(db, { workspaceId: scope.workspaceId, eventId: scope.eventId }).filter((entry) => entry.personId === personId);
  } catch {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker delivery evidence is unavailable.");
  }

  for (const row of rows) {
    assertDeliveryEvidenceRow(scope, row, personId);
  }
  return deliveryEvidenceFromRows(rows);
}

function deliveryEvidenceByPerson(
  db: Db,
  scope: NormalizedScope,
  projectedPersonIds: ReadonlySet<string>,
): ReadonlyMap<string, ManualSpeakerDeliveryEvidence> {
  let rows: readonly SpeakerCommunicationDeliveryLogEntry[];
  try {
    rows = listSpeakerCommunicationDeliveryLog(db, { workspaceId: scope.workspaceId, eventId: scope.eventId });
  } catch {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker delivery evidence is unavailable.");
  }

  const rowsByPerson = new Map<string, SpeakerCommunicationDeliveryLogEntry[]>();
  for (const row of rows) {
    if (typeof row.personId !== "string" || !projectedPersonIds.has(row.personId)) continue;
    assertDeliveryEvidenceRow(scope, row, row.personId);
    const personRows = rowsByPerson.get(row.personId);
    if (personRows) {
      personRows.push(row);
    } else {
      rowsByPerson.set(row.personId, [row]);
    }
  }

  return new Map([...rowsByPerson.entries()].map(([personId, personRows]) => [personId, deliveryEvidenceFromRows(personRows)]));
}

function rowWithProfile(
  db: Db,
  row: EventSpeakerRow,
  scope: NormalizedScope,
  batchedDeliveryEvidence?: ReadonlyMap<string, ManualSpeakerDeliveryEvidence>,
): ManualSpeakerRecord {
  const profile = parsedProfile(row.sourcePayloadJson, scope, row);
  const email = normalizeStoredPersonEmail(row.email);
  const fullName = stateText(row.fullName, "fullName", 240);
  const hasManualProvenance = row.sourceRecordId !== null;
  const participationStatus = stateText(row.participationStatus, "participation status", 64);
  const participationStatusTrust = TRUSTED_PARTICIPATION_STATUSES.has(participationStatus) ? "TRUSTED" as const : "UNVERIFIED" as const;
  const eventProfile = {
    organization: profile?.organization ?? "",
    title: profile?.title ?? "",
    bio: profile?.bio ?? "",
    authority: profile ? MANUAL_SPEAKER_EVENT_PROFILE_AUTHORITY : "unverified-event-relation" as const,
  } as const;
  return Object.freeze({
    schema: MANUAL_SPEAKER_SCHEMA,
    workspaceId: row.workspaceId,
    eventId: row.eventId,
    eventSpeakerId: row.eventSpeakerId,
    personId: row.personId,
    roleKey: stateText(row.roleKey, "role", 64),
    participationStatus,
    participationStatusTrust,
    email,
    fullName,
    organization: eventProfile.organization,
    title: eventProfile.title,
    bio: eventProfile.bio,
    canonicalIdentity: "Person",
    emailPolicy: MANUAL_SPEAKER_EMAIL_POLICY,
    managementState: hasManualProvenance ? "MANUAL_PROVENANCE" as const : "UNVERIFIED_EVENT_RELATION" as const,
    deliveryEvidence: batchedDeliveryEvidence
      ? batchedDeliveryEvidence.get(row.personId) ?? noDurableDeliveryEvidence()
      : deliveryEvidenceForPerson(db, scope, row.personId),
    canonicalPerson: { fullName, email, authority: MANUAL_SPEAKER_CANONICAL_PERSON_AUTHORITY },
    eventProfile,
    createdAt: stateText(row.createdAt, "createdAt", 128),
    updatedAt: stateText(row.updatedAt, "updatedAt", 128),
    provenance: {
      provider: hasManualProvenance ? MANUAL_SPEAKER_SOURCE_PROVIDER : "unverified-event-relation" as const,
      scope: "event" as const,
      fields: profile ? MANUAL_SPEAKER_EVENT_PROFILE_FIELDS : [],
      sourceRef: sourceRef(row.eventId, row.personId),
      sourceRecordId: row.sourceRecordId,
      sourceVersion: row.sourceVersion,
      recordedAt: row.sourceRecordedAt,
    },
  });
}

function nextSourceVersion(db: Db, scope: NormalizedScope, personId: string): number {
  const row = db.prepare(
    `SELECT COALESCE(MAX(version), 0) AS version
     FROM source_records
     WHERE workspace_id = ? AND provider = ? AND source_ref = ?`,
  ).get(scope.workspaceId, MANUAL_SPEAKER_SOURCE_PROVIDER, sourceRef(scope.eventId, personId)) as { version: number };
  if (!Number.isInteger(row.version) || row.version < 0) {
    throw new ManualSpeakerError("STATE_INVALID", "Speaker provenance version history is invalid.");
  }
  return row.version + 1;
}

function insertProfileProvenance(
  db: Db,
  scope: NormalizedScope,
  row: Pick<EventSpeakerRow, "eventSpeakerId" | "personId">,
  input: NormalizedCreateInput | NormalizedEditInput,
  operation: StoredSourceProfile["operation"],
  recordedAt: string,
): { readonly sourceRecordId: string; readonly sourceVersion: number; readonly payload: StoredSourceProfile } {
  const sourceVersion = nextSourceVersion(db, scope, row.personId);
  const payload = profilePayload(scope, row, input, sourceVersion, operation, recordedAt);
  const sourceRecordId = uuid();
  db.prepare(
    `INSERT INTO source_records
       (id, workspace_id, provider, source_ref, version, payload_json, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceRecordId,
    scope.workspaceId,
    MANUAL_SPEAKER_SOURCE_PROVIDER,
    payload.sourceRef,
    sourceVersion,
    canonicalJson(payload),
    recordedAt,
  );
  db.prepare(
    `INSERT INTO source_links
       (id, workspace_id, person_id, source_record_id, link_decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), scope.workspaceId, row.personId, sourceRecordId, `manual_speaker_${operation}`, recordedAt);
  return { sourceRecordId, sourceVersion, payload };
}

function insertDomainEvent(
  db: Db,
  scope: NormalizedScope,
  operation: StoredManualEvent["operation"],
  row: Pick<EventSpeakerRow, "eventSpeakerId" | "personId">,
  source: { readonly sourceRecordId: string | null; readonly sourceVersion: number | null },
  input: NormalizedCreateInput | NormalizedEditInput,
  request: ManualSpeakerRequest,
  requestFingerprint: string,
  createdPerson: boolean,
  createdEventSpeaker: boolean,
  linkedExistingPerson: boolean,
  next: ManualSpeakerProfile & { readonly email: string },
  recordedAt: string,
  previous?: ManualSpeakerProfile & { readonly email: string },
): string {
  const payload: Record<string, unknown> = {
    schema: MANUAL_SPEAKER_EVENT_SCHEMA,
    operation,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    eventSpeakerId: row.eventSpeakerId,
    personId: row.personId,
    sourceRecordId: source.sourceRecordId,
    sourceVersion: source.sourceVersion,
    actorId: scope.actorId,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    request,
    createdPerson,
    createdEventSpeaker,
    linkedExistingPerson,
    next,
    ...(previous ? { previous } : {}),
  };
  const payloadJson = canonicalJson(payload);
  const eventId = uuid();
  const eventType = eventTypeForOperation(operation);
  db.prepare(
    `INSERT INTO domain_events
       (id, workspace_id, event_type, aggregate_type, aggregate_id,
        payload_json, payload_fingerprint, created_at)
     VALUES (?, ?, ?, 'event_speaker', ?, ?, ?, ?)`,
  ).run(
    eventId,
    scope.workspaceId,
    eventType,
    row.eventSpeakerId,
    payloadJson,
    fingerprintOf(payload),
    recordedAt,
  );
  return eventId;
}

function eventTypeForOperation(operation: StoredManualEvent["operation"]): string {
  return operation === "updated"
    ? "speaker.manual.profile.updated"
    : operation === "linked"
      ? "speaker.manual.linked"
      : operation === "noop"
        ? "speaker.manual.noop"
        : "speaker.manual.created";
}

function requestPayload(scope: NormalizedScope, operation: "create" | "edit", input: NormalizedCreateInput | NormalizedEditInput): ManualSpeakerRequest {
  const base = {
    schema: MANUAL_SPEAKER_SCHEMA,
    operation,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    fullName: input.fullName,
    email: input.email,
    title: input.title,
    organization: input.organization,
    bio: input.bio,
  };
  if (operation === "edit") {
    const edit = input as NormalizedEditInput;
    return { ...base, personId: edit.personId, expectedEmail: edit.expectedEmail, expectedFullName: edit.expectedFullName };
  }
  return base;
}

function requestAllowsProfile(request: ManualSpeakerRequest, next: ManualSpeakerProfile & { readonly email: string }): boolean {
  if (request.email !== next.email || normalizeComparableText(request.fullName) !== normalizeComparableText(next.fullName)) return false;
  if (request.title && normalizeComparableText(request.title) !== normalizeComparableText(next.title)) return false;
  if (request.organization && normalizeComparableText(request.organization) !== normalizeComparableText(next.organization)) return false;
  if (request.bio && request.bio !== next.bio) return false;
  return true;
}

function parseStoredRequest(value: unknown, scope: NormalizedScope, personId: string): ManualSpeakerRequest {
  if (!isRecord(value) || value.schema !== MANUAL_SPEAKER_SCHEMA || value.workspaceId !== scope.workspaceId || value.eventId !== scope.eventId) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker request evidence is outside the authorized scope.");
  }
  if (value.operation !== "create" && value.operation !== "edit") {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker request operation is invalid.");
  }
  const commonKeys = ["schema", "operation", "workspaceId", "eventId", "fullName", "email", "title", "organization", "bio"];
  if (value.operation === "edit") {
    assertStoredKeys(value, [...commonKeys, "personId", "expectedEmail", "expectedFullName"], "speaker request");
    const storedPersonId = stateText(value.personId, "request personId", 160);
    if (storedPersonId !== personId) throw new ManualSpeakerError("STATE_INVALID", "Stored speaker request person identity is invalid.");
    const expectedEmail = normalizeStoredPersonEmail(value.expectedEmail);
    const expectedFullName = stateText(value.expectedFullName, "request expectedFullName", 240);
    const email = normalizeStoredPersonEmail(value.email);
    if (email !== expectedEmail) throw new ManualSpeakerError("STATE_INVALID", "Stored speaker request email semantics are invalid.");
    return {
      schema: MANUAL_SPEAKER_SCHEMA,
      operation: "edit",
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: storedPersonId,
      expectedEmail,
      expectedFullName,
      fullName: stateText(value.fullName, "request fullName", 240),
      email,
      title: stateOptionalText(value.title, "request title", 240),
      organization: stateOptionalText(value.organization, "request organization", 240),
      bio: stateOptionalText(value.bio, "request bio", 4_000, true),
    };
  }
  assertStoredKeys(value, commonKeys, "speaker request");
  return {
    schema: MANUAL_SPEAKER_SCHEMA,
    operation: "create",
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    fullName: stateText(value.fullName, "request fullName", 240),
    email: normalizeStoredPersonEmail(value.email),
    title: stateOptionalText(value.title, "request title", 240),
    organization: stateOptionalText(value.organization, "request organization", 240),
    bio: stateOptionalText(value.bio, "request bio", 4_000, true),
  };
}

function validateStoredSource(
  db: Db,
  scope: NormalizedScope,
  event: Pick<StoredManualEvent, "operation" | "eventSpeakerId" | "personId" | "sourceRecordId" | "sourceVersion" | "next">,
): void {
  if (event.operation === "noop") {
    if (event.sourceRecordId !== null || event.sourceVersion !== null) {
      throw new ManualSpeakerError("STATE_INVALID", "Stored speaker no-op source evidence is invalid.");
    }
    return;
  }
  if (event.sourceRecordId === null || event.sourceVersion === null) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker source evidence is incomplete.");
  }
  const source = db.prepare(
    `SELECT id, workspace_id, provider, source_ref, version, payload_json
     FROM source_records
     WHERE id = ? AND workspace_id = ? AND provider = ? AND source_ref = ? AND version = ?`,
  ).get(
    event.sourceRecordId,
    scope.workspaceId,
    MANUAL_SPEAKER_SOURCE_PROVIDER,
    sourceRef(scope.eventId, event.personId),
    event.sourceVersion,
  ) as { id: string; workspace_id: string; provider: string; source_ref: string; version: number; payload_json: string } | undefined;
  if (!source || source.workspace_id !== scope.workspaceId || source.provider !== MANUAL_SPEAKER_SOURCE_PROVIDER || source.source_ref !== sourceRef(scope.eventId, event.personId) || source.version !== event.sourceVersion) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker source evidence is not coherent.");
  }
  const sourceProfile = parsedProfile(source.payload_json, scope, { eventSpeakerId: event.eventSpeakerId, personId: event.personId });
  if (!sourceProfile || sourceProfile.sourceVersion !== event.sourceVersion || sourceProfile.email !== event.next.email || !profileEqual(sourceProfile, event.next)) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker source payload does not match the operation envelope.");
  }
  const expectedSourceOperation = event.operation === "created" ? "created" : event.operation === "linked" ? "linked" : event.operation === "updated" ? "updated" : null;
  if (expectedSourceOperation !== null && sourceProfile.operation !== expectedSourceOperation) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker source operation does not match the domain event.");
  }
  const link = db.prepare(
    `SELECT 1 FROM source_links
     WHERE id IS NOT NULL AND workspace_id = ? AND person_id = ? AND source_record_id = ?`,
  ).get(scope.workspaceId, event.personId, event.sourceRecordId);
  if (!link) throw new ManualSpeakerError("STATE_INVALID", "Stored speaker source link is missing.");
}

function parseStoredDomainEvent(db: Db, row: StoredDomainEventRow, scope: NormalizedScope): StoredManualEvent {
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker operation evidence is not valid JSON.");
  }
  if (!isRecord(value) || canonicalJson(value) !== row.payload_json || fingerprintOf(value) !== row.payload_fingerprint) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker operation fingerprint is invalid.");
  }
  if (row.workspace_id !== scope.workspaceId || !isRecord(value) || value.schema !== MANUAL_SPEAKER_EVENT_SCHEMA || value.workspaceId !== scope.workspaceId || value.eventId !== scope.eventId) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker operation evidence is outside the authorized scope.");
  }
  if (value.operation !== "created" && value.operation !== "linked" && value.operation !== "updated" && value.operation !== "noop") {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker operation is invalid.");
  }
  assertStoredKeys(value, ["schema", "operation", "workspaceId", "eventId", "eventSpeakerId", "personId", "sourceRecordId", "sourceVersion", "actorId", "idempotencyKey", "requestFingerprint", "request", "createdPerson", "createdEventSpeaker", "linkedExistingPerson", "next", ...(value.operation === "updated" ? ["previous"] : [])], "speaker operation");
  if (row.event_type !== eventTypeForOperation(value.operation) || row.aggregate_type !== "event_speaker") {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker operation type is invalid.");
  }
  if (typeof value.idempotencyKey !== "string" && value.idempotencyKey !== null) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker idempotency evidence is invalid.");
  }
  const idempotencyKey = value.idempotencyKey === null ? null : stateText(value.idempotencyKey, "idempotencyKey", 200);
  if (typeof value.createdPerson !== "boolean" || typeof value.createdEventSpeaker !== "boolean" || typeof value.linkedExistingPerson !== "boolean") {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker operation flags are invalid.");
  }
  if (value.sourceRecordId !== null && typeof value.sourceRecordId !== "string") {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker source evidence is invalid.");
  }
  if (value.sourceVersion !== null && (typeof value.sourceVersion !== "number" || !Number.isSafeInteger(value.sourceVersion) || value.sourceVersion < 1)) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker source version is invalid.");
  }
  if (typeof value.next !== "object" || value.next === null || Array.isArray(value.next)) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker profile evidence is invalid.");
  }
  const next = value.next as Record<string, unknown>;
  assertStoredKeys(next, ["fullName", "email", "organization", "title", "bio"], "speaker next profile");
  const eventSpeakerId = stateText(value.eventSpeakerId, "eventSpeakerId", 160);
  const personId = stateText(value.personId, "personId", 160);
  if (row.aggregate_id !== eventSpeakerId) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker aggregate identity is invalid.");
  }
  const request = parseStoredRequest(value.request, scope, personId);
  if (fingerprintOf(request) !== value.requestFingerprint) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker request fingerprint is invalid.");
  }
  const requestOperation = value.operation === "updated" ? "edit" : request.operation;
  if (value.operation !== "noop" && request.operation !== requestOperation) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker request operation is incoherent.");
  }
  if (value.operation === "created" && (!value.createdPerson || !value.createdEventSpeaker || value.linkedExistingPerson)) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker creation flags are invalid.");
  }
  if (value.operation === "linked" && (value.createdPerson || !value.linkedExistingPerson)) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker link flags are invalid.");
  }
  if ((value.operation === "updated" || value.operation === "noop") && (value.createdPerson || value.createdEventSpeaker || value.linkedExistingPerson)) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker mutation flags are invalid.");
  }
  const nextProfile = {
    fullName: stateText(next.fullName, "fullName", 240),
    email: normalizeStoredPersonEmail(next.email),
    organization: stateOptionalText(next.organization, "organization", 240),
    title: stateOptionalText(next.title, "title", 240),
    bio: stateOptionalText(next.bio, "bio", 4_000, true),
  };
  if (value.operation === "created" && (request.operation !== "create" || request.fullName !== nextProfile.fullName || request.email !== nextProfile.email || request.organization !== nextProfile.organization || request.title !== nextProfile.title || request.bio !== nextProfile.bio)) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker creation request is incoherent with the profile.");
  }
  if (value.operation === "linked" && (request.operation !== "create" || !requestAllowsProfile(request, nextProfile))) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker link request is incoherent with the profile.");
  }
  if (value.operation === "noop" && (!requestAllowsProfile(request, nextProfile) || (request.operation === "edit" && (request.expectedEmail !== nextProfile.email || request.expectedFullName !== nextProfile.fullName || request.fullName !== nextProfile.fullName || request.organization !== nextProfile.organization || request.title !== nextProfile.title || request.bio !== nextProfile.bio)))) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker no-op request is incoherent with the profile.");
  }
  const actorId = stateText(value.actorId, "actorId", 160);
  const relation = db.prepare(
    `SELECT id FROM event_speakers
     WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ? AND role_key = 'SPEAKER'`,
  ).get(eventSpeakerId, scope.workspaceId, scope.eventId, personId);
  if (!relation) throw new ManualSpeakerError("STATE_INVALID", "Stored speaker operation relationship is invalid.");
  const actor = db.prepare("SELECT id, role FROM accounts WHERE id = ? AND workspace_id = ?").get(actorId, scope.workspaceId) as { id: string; role: string } | undefined;
  if (!actor || !ORGANIZER_ROLES.has(actor.role)) throw new ManualSpeakerError("STATE_INVALID", "Stored speaker actor identity is invalid.");
  validateStoredSource(db, scope, { operation: value.operation, eventSpeakerId, personId, sourceRecordId: value.sourceRecordId, sourceVersion: value.sourceVersion, next: nextProfile });
  if (value.operation === "updated") {
    if (typeof value.previous !== "object" || value.previous === null || Array.isArray(value.previous)) throw new ManualSpeakerError("STATE_INVALID", "Stored speaker previous profile is invalid.");
    const previous = value.previous as Record<string, unknown>;
    assertStoredKeys(previous, ["fullName", "email", "organization", "title", "bio"], "speaker previous profile");
    const previousProfile = {
      fullName: stateText(previous.fullName, "previous fullName", 240),
      email: normalizeStoredPersonEmail(previous.email),
      organization: stateOptionalText(previous.organization, "previous organization", 240),
      title: stateOptionalText(previous.title, "previous title", 240),
      bio: stateOptionalText(previous.bio, "previous bio", 4_000, true),
    };
    if (previousProfile.email !== nextProfile.email || request.operation !== "edit" || request.expectedEmail !== previousProfile.email || request.expectedFullName !== previousProfile.fullName || request.fullName !== nextProfile.fullName || request.organization !== nextProfile.organization || request.title !== nextProfile.title || request.bio !== nextProfile.bio) {
      throw new ManualSpeakerError("STATE_INVALID", "Stored speaker edit request is incoherent with the profile transition.");
    }
  }
  return {
    schema: MANUAL_SPEAKER_EVENT_SCHEMA,
    operation: value.operation,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    eventSpeakerId,
    personId,
    sourceRecordId: value.sourceRecordId,
    sourceVersion: value.sourceVersion,
    actorId,
    idempotencyKey,
    requestFingerprint: stateText(value.requestFingerprint, "requestFingerprint", 128),
    request,
    createdPerson: value.createdPerson,
    createdEventSpeaker: value.createdEventSpeaker,
    linkedExistingPerson: value.linkedExistingPerson,
    next: nextProfile,
  };
}

function priorIdempotentEvent(db: Db, scope: NormalizedScope, idempotencyKey: string | null, requestFingerprint: string): StoredManualEvent | null {
  if (!idempotencyKey) return null;
  const rows = db.prepare(
    `SELECT id, payload_json, payload_fingerprint, created_at
            , workspace_id, event_type, aggregate_type, aggregate_id
      FROM domain_events
       WHERE workspace_id = ?
     ORDER BY created_at, rowid`,
  ).all(scope.workspaceId) as unknown as StoredDomainEventRow[];
  const matchingRows = rows.filter((row) => {
    if (!row.payload_json.includes('"idempotencyKey"')) return false;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      throw new ManualSpeakerError("STATE_INVALID", "Stored speaker operation evidence is not valid JSON.");
    }
    return isRecord(payload) && payload.idempotencyKey === idempotencyKey;
  });
  if (matchingRows.length > 1) {
    throw new ManualSpeakerError("STATE_INVALID", "Multiple speaker operations use the same idempotency key.");
  }
  if (matchingRows.length === 0) return null;
  const prior = parseStoredDomainEvent(db, matchingRows[0]!, scope);
  if (prior.requestFingerprint !== requestFingerprint) {
    throw new ManualSpeakerConflictError("IDEMPOTENCY_KEY_CONFLICT", "The speaker idempotency key was reused with different content.");
  }
  return prior;
}

function mutationFromEvent(db: Db, scope: NormalizedScope, event: StoredManualEvent): ManualSpeakerMutationResult {
  const row = eventSpeakerById(db, scope, event.eventSpeakerId);
  if (!row || row.personId !== event.personId) {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker operation no longer points to its event relationship.");
  }
  return Object.freeze({
    schema: MANUAL_SPEAKER_SCHEMA,
    record: rowWithProfile(db, row, scope),
    createdPerson: event.createdPerson,
    createdEventSpeaker: event.createdEventSpeaker,
    linkedExistingPerson: event.linkedExistingPerson,
    replayed: true,
    deduped: false,
    emailPolicy: MANUAL_SPEAKER_EMAIL_POLICY,
  });
}

function mutationResult(
  record: ManualSpeakerRecord,
  flags: Pick<ManualSpeakerMutationResult, "createdPerson" | "createdEventSpeaker" | "linkedExistingPerson">,
  replayed: boolean,
  deduped: boolean,
): ManualSpeakerMutationResult {
  return Object.freeze({
    schema: MANUAL_SPEAKER_SCHEMA,
    record,
    ...flags,
    replayed,
    deduped,
    emailPolicy: MANUAL_SPEAKER_EMAIL_POLICY,
  });
}

function bindNoopReceipt(
  db: Db,
  scope: NormalizedScope,
  record: ManualSpeakerRecord,
  input: NormalizedCreateInput | NormalizedEditInput,
  operation: "create" | "edit",
  requestFingerprint: string,
  recordedAt: string,
): void {
  insertDomainEvent(
    db,
    scope,
    "noop",
    { eventSpeakerId: record.eventSpeakerId, personId: record.personId },
    { sourceRecordId: null, sourceVersion: null },
    input,
    requestPayload(scope, operation, input),
    requestFingerprint,
    false,
    false,
    false,
    { fullName: record.fullName, organization: record.organization, title: record.title, bio: record.bio, email: record.email },
    recordedAt,
  );
}

function requestFingerprint(scope: NormalizedScope, operation: "create" | "edit", input: NormalizedCreateInput | NormalizedEditInput): string {
  return fingerprintOf(requestPayload(scope, operation, input));
}

export function manualSpeakerCreateIdempotencyKey(scope: SpeakerOrganizerScope, input: CreateManualSpeakerInput): string {
  const normalizedScope = normalizeScope(scope);
  return `manual-speaker:create:${requestFingerprint(normalizedScope, "create", normalizeCreateInput(input))}`;
}

export function manualSpeakerEditIdempotencyKey(scope: SpeakerOrganizerScope, input: EditManualSpeakerInput): string {
  const normalizedScope = normalizeScope(scope);
  return `manual-speaker:edit:${requestFingerprint(normalizedScope, "edit", normalizeEditInput(input))}`;
}

function withManualTransaction<T>(db: Db, operation: () => T): T {
  try {
    return withTransactionOrSavepoint(db, "manual_speaker_management", operation);
  } catch (error) {
    if (error instanceof ManualSpeakerError) throw error;
    throw new ManualSpeakerError("PERSISTENCE_FAILED", "The speaker change could not be saved atomically.");
  }
}

function createRecordInput(input: NormalizedCreateInput): NormalizedCreateInput {
  return input;
}

export function createManualSpeaker(db: Db, scope: SpeakerOrganizerScope, input: CreateManualSpeakerInput): ManualSpeakerMutationResult {
  const normalizedScope = normalizeScope(scope);
  const normalizedInput = createRecordInput(normalizeCreateInput(input));
  const fingerprint = requestFingerprint(normalizedScope, "create", normalizedInput);
  return withManualTransaction(db, () => {
    assertAuthorizedScope(db, normalizedScope);
    const prior = priorIdempotentEvent(db, normalizedScope, normalizedInput.idempotencyKey, fingerprint);
    if (prior) return mutationFromEvent(db, normalizedScope, prior);

    const existingPerson = personForEmail(db, normalizedScope.workspaceId, normalizedInput.email);
    if (existingPerson && normalizeComparableText(stateText(existingPerson.full_name, "fullName", 240)) !== normalizeComparableText(normalizedInput.fullName)) {
      throw new ManualSpeakerConflictError("DUPLICATE_EMAIL_CONFLICT", "That email already identifies a different canonical Person in this workspace.");
    }

    const existingEventSpeaker = existingPerson ? eventSpeakerForPerson(db, normalizedScope, existingPerson.id) : null;
    if (existingEventSpeaker) {
      const currentRecord = rowWithProfile(db, existingEventSpeaker, normalizedScope);
      if (!profileMatchesProvided(currentRecord, normalizedInput)) {
        throw new ManualSpeakerConflictError("DUPLICATE_EMAIL_CONFLICT", "That email is already linked to a conflicting speaker profile in this event.");
      }
      if (currentRecord.provenance.sourceRecordId) {
        if (normalizedInput.idempotencyKey) {
          bindNoopReceipt(db, normalizedScope, currentRecord, normalizedInput, "create", fingerprint, nowIso());
        }
        return mutationResult(currentRecord, { createdPerson: false, createdEventSpeaker: false, linkedExistingPerson: false }, false, true);
      }

      const recordedAt = nowIso();
      const effectiveInput = profileWithExistingPersonDefaults(normalizedInput, existingPerson!, currentRecord);
      const provenance = insertProfileProvenance(db, normalizedScope, existingEventSpeaker, effectiveInput, "linked", recordedAt);
      const next = { ...profileFromInput(effectiveInput), email: effectiveInput.email };
      insertDomainEvent(db, normalizedScope, "linked", existingEventSpeaker, provenance, normalizedInput, requestPayload(normalizedScope, "create", normalizedInput), fingerprint, false, false, true, next, recordedAt);
      writeAudit(db, normalizedScope.workspaceId, {
        actorKind: "account",
        actorRef: normalizedScope.actorId,
        action: "speaker.manual.linked",
        targetType: "event_speaker",
        targetId: existingEventSpeaker.eventSpeakerId,
        details: { eventId: normalizedScope.eventId, personId: existingEventSpeaker.personId, sourceRecordId: provenance.sourceRecordId, sourceVersion: provenance.sourceVersion },
      });
      const record = rowWithProfile(db, eventSpeakerById(db, normalizedScope, existingEventSpeaker.eventSpeakerId)!, normalizedScope);
      return mutationResult(record, { createdPerson: false, createdEventSpeaker: false, linkedExistingPerson: true }, false, false);
    }

    const recordedAt = nowIso();
    let personId: string;
    let createdPerson = false;
    if (existingPerson) {
      personId = existingPerson.id;
    } else {
      personId = uuid();
      db.prepare(
        `INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(personId, normalizedScope.workspaceId, normalizedInput.email, normalizedInput.fullName, normalizedInput.organization || null, normalizedInput.title || null, recordedAt);
      createdPerson = true;
    }

    const eventSpeakerId = uuid();
    db.prepare(
      `INSERT INTO event_speakers
         (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'SPEAKER', ?, ?, ?)`,
    ).run(eventSpeakerId, normalizedScope.workspaceId, normalizedScope.eventId, personId, MANUAL_SPEAKER_PARTICIPATION_STATUS, recordedAt, recordedAt);
    const relation = { eventSpeakerId, personId } as const;
    const effectiveInput = existingPerson ? profileWithExistingPersonDefaults(normalizedInput, existingPerson) : normalizedInput;
    const provenance = insertProfileProvenance(db, normalizedScope, relation, effectiveInput, existingPerson ? "linked" : "created", recordedAt);
    const next = { ...profileFromInput(effectiveInput), email: effectiveInput.email };
    insertDomainEvent(db, normalizedScope, existingPerson ? "linked" : "created", relation, provenance, normalizedInput, requestPayload(normalizedScope, "create", normalizedInput), fingerprint, createdPerson, true, Boolean(existingPerson), next, recordedAt);
    writeAudit(db, normalizedScope.workspaceId, {
      actorKind: "account",
      actorRef: normalizedScope.actorId,
      action: existingPerson ? "speaker.manual.linked" : "speaker.manual.created",
      targetType: "event_speaker",
      targetId: eventSpeakerId,
      details: { eventId: normalizedScope.eventId, personId, sourceRecordId: provenance.sourceRecordId, sourceVersion: provenance.sourceVersion, createdPerson },
    });
    const row = eventSpeakerById(db, normalizedScope, eventSpeakerId);
    if (!row) throw new ManualSpeakerError("STATE_INVALID", "The saved speaker relationship could not be reloaded.");
    return mutationResult(rowWithProfile(db, row, normalizedScope), { createdPerson, createdEventSpeaker: true, linkedExistingPerson: Boolean(existingPerson) }, false, false);
  });
}

export function editManualSpeaker(db: Db, scope: SpeakerOrganizerScope, input: EditManualSpeakerInput): ManualSpeakerMutationResult {
  const normalizedScope = normalizeScope(scope);
  const normalizedInput = normalizeEditInput(input);
  const fingerprint = requestFingerprint(normalizedScope, "edit", normalizedInput);
  return withManualTransaction(db, () => {
    assertAuthorizedScope(db, normalizedScope);
    const person = personById(db, normalizedScope.workspaceId, normalizedInput.personId);
    const relation = eventSpeakerForPerson(db, normalizedScope, normalizedInput.personId);
    if (!person || !relation) {
      throw new ManualSpeakerAuthorizationError("PERSON_NOT_IN_EVENT", "The canonical Person is not part of the authorized event speaker roster.");
    }
    if (normalizeStoredPersonEmail(person.canonical_email) !== normalizedInput.expectedEmail) {
      throw new ManualSpeakerConflictError("EMAIL_READ_ONLY", "Canonical email is read-only after speaker creation.");
    }
    const prior = priorIdempotentEvent(db, normalizedScope, normalizedInput.idempotencyKey, fingerprint);
    if (prior) return mutationFromEvent(db, normalizedScope, prior);
    if (person.full_name !== normalizedInput.expectedFullName) {
      throw new ManualSpeakerConflictError("CANONICAL_NAME_STALE", "The canonical Person name changed before this edit was submitted.");
    }

    const current = rowWithProfile(db, relation, normalizedScope);
    const nextProfile = profileFromInput(normalizedInput);
    if (profileEqual(current, nextProfile)) {
      if (normalizedInput.idempotencyKey) {
        bindNoopReceipt(db, normalizedScope, current, normalizedInput, "edit", fingerprint, nowIso());
      }
      return mutationResult(current, { createdPerson: false, createdEventSpeaker: false, linkedExistingPerson: false }, false, true);
    }

    const recordedAt = nowIso();
    const updatedAt = recordedAt >= relation.updatedAt ? recordedAt : relation.updatedAt;
    const updateResult = db.prepare(
      `UPDATE people
       SET full_name = ?
       WHERE id = ? AND workspace_id = ? AND full_name = ?`,
    ).run(normalizedInput.fullName, normalizedInput.personId, normalizedScope.workspaceId, normalizedInput.expectedFullName);
    if (Number(updateResult.changes) !== 1) {
      throw new ManualSpeakerConflictError("CANONICAL_NAME_STALE", "The canonical Person name changed before this edit was submitted.");
    }
    db.prepare(
      `UPDATE event_speakers SET updated_at = ?
       WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).run(updatedAt, relation.eventSpeakerId, normalizedScope.workspaceId, normalizedScope.eventId, normalizedInput.personId);
    const previous = { fullName: current.fullName, organization: current.organization, title: current.title, bio: current.bio, email: current.email };
    const next = { ...nextProfile, email: normalizedInput.expectedEmail };
    const provenance = insertProfileProvenance(db, normalizedScope, relation, normalizedInput, "updated", updatedAt);
    insertDomainEvent(db, normalizedScope, "updated", relation, provenance, normalizedInput, requestPayload(normalizedScope, "edit", normalizedInput), fingerprint, false, false, false, next, updatedAt, previous);
    writeAudit(db, normalizedScope.workspaceId, {
      actorKind: "account",
      actorRef: normalizedScope.actorId,
      action: "speaker.manual.profile_updated",
      targetType: "event_speaker",
      targetId: relation.eventSpeakerId,
      details: { eventId: normalizedScope.eventId, personId: normalizedInput.personId, sourceRecordId: provenance.sourceRecordId, sourceVersion: provenance.sourceVersion, emailPolicy: MANUAL_SPEAKER_EMAIL_POLICY },
    });
    const row = eventSpeakerById(db, normalizedScope, relation.eventSpeakerId);
    if (!row) throw new ManualSpeakerError("STATE_INVALID", "The edited speaker relationship could not be reloaded.");
    return mutationResult(rowWithProfile(db, row, normalizedScope), { createdPerson: false, createdEventSpeaker: false, linkedExistingPerson: false }, false, false);
  });
}

export const updateManualSpeaker = editManualSpeaker;

export function getManualSpeakerRecord(db: Db, scope: SpeakerOrganizerScope, personId: string): ManualSpeakerRecord | null {
  const normalizedScope = normalizeScope(scope);
  const normalizedPersonId = safeIdentifier(personId, "personId");
  assertAuthorizedScope(db, normalizedScope);
  const row = eventSpeakerForPerson(db, normalizedScope, normalizedPersonId);
  return row ? rowWithProfile(db, row, normalizedScope) : null;
}

function normalizeRosterFilter(filter: SpeakerRosterFilter | undefined): SpeakerRosterFilter {
  if (filter === undefined) return {};
  if (!isRecord(filter)) failInput("speaker roster filter is invalid.");
  const typedFilter = filter as SpeakerRosterFilter;
  const query = typedFilter.query === undefined ? undefined : optionalText(typedFilter.query, "query", 120);
  if (typedFilter.role !== undefined && typedFilter.role !== "SPEAKER" && typedFilter.role !== "MODERATOR") failInput("speaker role filter is invalid.");
  return { query, role: typedFilter.role, invitationState: typedFilter.invitationState, commitmentState: typedFilter.commitmentState, taskState: typedFilter.taskState, readinessGate: typedFilter.readinessGate, overdueOnly: typedFilter.overdueOnly };
}

function matchesRosterFilter(record: ManualSpeakerRecord, filter: SpeakerRosterFilter): boolean {
  const query = filter.query?.toLocaleLowerCase("en-US") ?? "";
  if (query && ![record.fullName, record.email, record.title, record.organization, record.bio].join(" ").toLocaleLowerCase("en-US").includes(query)) return false;
  if (filter.role && record.roleKey !== filter.role) return false;
  // Manual rows deliberately do not invent commitment, task, or readiness truth.
  if (filter.invitationState || filter.commitmentState || filter.taskState || filter.readinessGate || filter.overdueOnly) return false;
  return true;
}

export function listManualSpeakerRecords(db: Db, scope: SpeakerOrganizerScope, filter?: SpeakerRosterFilter): readonly ManualSpeakerRecord[] {
  const normalizedScope = normalizeScope(scope);
  const normalizedFilter = normalizeRosterFilter(filter);
  assertAuthorizedScope(db, normalizedScope);
  const rows = db.prepare(
    `SELECT es.id AS eventSpeakerId, es.workspace_id AS workspaceId, es.event_id AS eventId,
            es.person_id AS personId, es.role_key AS roleKey, es.participation_status AS participationStatus,
            es.created_at AS createdAt, es.updated_at AS updatedAt,
            p.canonical_email AS email, p.full_name AS fullName, p.organization, p.title,
            sr.id AS sourceRecordId, sr.version AS sourceVersion,
            sr.payload_json AS sourcePayloadJson, sr.imported_at AS sourceRecordedAt
     FROM event_speakers es
     JOIN events e ON e.id = es.event_id AND e.workspace_id = es.workspace_id
     JOIN people p ON p.id = es.person_id AND p.workspace_id = es.workspace_id
     LEFT JOIN source_records sr
       ON sr.id = (
         SELECT latest.id FROM source_records latest
         WHERE latest.workspace_id = es.workspace_id
           AND latest.provider = ?
           AND latest.source_ref = ('manual-speaker:' || es.event_id || ':' || es.person_id)
         ORDER BY latest.version DESC, latest.id DESC
         LIMIT 1
       )
     WHERE es.workspace_id = ? AND es.event_id = ? AND es.role_key = 'SPEAKER'
     ORDER BY p.full_name COLLATE NOCASE, p.id, es.role_key`,
  ).all(MANUAL_SPEAKER_SOURCE_PROVIDER, normalizedScope.workspaceId, normalizedScope.eventId) as unknown as EventSpeakerRow[];
  const projectedPersonIds = new Set(rows.map((row) => row.personId));
  const batchedDeliveryEvidence = rows.length > 0 ? deliveryEvidenceByPerson(db, normalizedScope, projectedPersonIds) : undefined;
  return Object.freeze(rows.map((row) => rowWithProfile(db, row, normalizedScope, batchedDeliveryEvidence)).filter((record) => matchesRosterFilter(record, normalizedFilter)));
}
