import { canonicalJson, deterministicUuid, fingerprintOf, nowIso, uuid } from "../../canonical";
import { withTransaction, type Db } from "../../db";
import { writeAudit } from "../audit";
import { getEvent } from "../events";
import {
  applyScheduleDraftPointer,
  autoPlaceUnscheduledSessions,
  clearScheduleConflict,
  configureSchedule,
  moveSession,
  parseScheduleDraftPointer,
  serializeScheduleDraft,
  unscheduleSession,
  ScheduleCommandError,
} from "./deterministic";
import {
  CanonicalScheduleError,
  isCanonicalIsoInstant,
  persistCanonicalScheduleMutation,
  readCanonicalScheduleAuthorityAt,
  readCanonicalScheduleProjection,
  type CanonicalScheduleAuthorityCutoff,
} from "./canonical";
import type {
  ScheduleConfigurationInput,
  ScheduleDraftCommand,
  ScheduleDraftPointer,
  SchedulePlacementTarget,
  ScheduleRoom,
  ScheduleSnapshot,
  ScheduleTrack,
} from "./types";
import { EMPTY_CFP_SESSION_INVENTORY_FINGERPRINT } from "./types";

export const SCHEDULE_DRAFT_EVENT_TYPE = "organizer.schedule_draft.saved";
export const SCHEDULE_DRAFT_AGGREGATE_TYPE = "schedule_draft";
export const SCHEDULE_DRAFT_EVENT_SCHEMA = "organizer-schedule-draft/v1";
export const MAX_SCHEDULE_DRAFT_BYTES = 100_000;
export const MAX_SCHEDULE_DRAFT_REVISION = 1_000_000;
export const MAX_SCHEDULE_DRAFT_EVENTS = 1_000;

const SCHEDULE_DRAFT_AUDIT_SCHEMA = "organizer-schedule-draft-audit/v1";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const WRITABLE_EVENT_LIFECYCLES = new Set(["draft", "planning", "published", "live"]);

export class SchedulePersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message = "The schedule draft could not be saved.") {
    super(message);
    this.name = "SchedulePersistenceError";
    this.code = code;
  }
}

export class ScheduleDraftRevisionConflictError extends SchedulePersistenceError {
  readonly authoritativePointer: ScheduleDraftPointer;

  constructor(authoritativePointer: ScheduleDraftPointer) {
    super("SCHEDULE_REVISION_CONFLICT", "The schedule changed on the server.");
    this.name = "ScheduleDraftRevisionConflictError";
    this.authoritativePointer = authoritativePointer;
  }
}

export interface ScheduleDraftReadResult {
  readonly schedule: ScheduleSnapshot;
  readonly pointer: ScheduleDraftPointer | null;
  readonly persisted: boolean;
}

export interface ScheduleDraftMutationResult {
  readonly schedule: ScheduleSnapshot;
  readonly pointer: ScheduleDraftPointer;
  readonly changed: boolean;
  readonly persisted: boolean;
}

export interface ExecuteScheduleDraftInput {
  readonly expectedRevision: number;
  readonly planVersionId: string;
  readonly planFingerprint: string;
  readonly acceptedInventoryFingerprint: string;
  readonly cfpSessionInventoryFingerprint?: string;
  readonly command: ScheduleDraftCommand;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly activeDayId?: string;
  readonly actorAccountId?: string;
}

interface DomainEventRow {
  readonly id: string;
  readonly rowid: number;
  readonly payloadJson: string;
  readonly payloadFingerprint: string;
  readonly createdAt: string;
}

interface StoredScheduleDraftEvent {
  readonly schema: typeof SCHEDULE_DRAFT_EVENT_SCHEMA;
  readonly requestFingerprint: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly pointer: ScheduleDraftPointer;
}

interface BoundStoredScheduleDraftEvent {
  readonly stored: StoredScheduleDraftEvent;
  readonly cutoff: CanonicalScheduleAuthorityCutoff;
  readonly contextConflict: SchedulePersistenceError | null;
}

export interface ScheduleDraftAuthorityEvidence {
  readonly auditEventId: string;
  readonly recordedAt: string;
  readonly pointerFingerprint: string;
  readonly pointer: ScheduleDraftPointer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum: number, pattern?: RegExp): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || CONTROL_CHARACTER.test(value)) {
    return null;
  }
  if (pattern && !pattern.test(value)) return null;
  return value;
}

function optionalReason(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return boundedString(value, 240) ?? null;
}

function parseTarget(value: unknown): SchedulePlacementTarget | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["dayId", "timeSlotId", "roomId", "trackId"])) return null;
  const dayId = boundedString(value.dayId, 160, IDENTIFIER);
  const timeSlotId = boundedString(value.timeSlotId, 160, IDENTIFIER);
  const roomId = boundedString(value.roomId, 160, IDENTIFIER);
  const trackId = boundedString(value.trackId, 160, IDENTIFIER);
  if (!dayId || !timeSlotId || !roomId || !trackId) return null;
  return { dayId, timeSlotId, roomId, trackId };
}

function parseRoom(value: unknown): ScheduleRoom | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "name", "venue", "capacity"])) return null;
  const id = boundedString(value.id, 80, IDENTIFIER);
  const name = boundedString(value.name, 120);
  const venue = boundedString(value.venue, 120);
  const capacity = value.capacity;
  if (!id || !name || !venue || typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
    return null;
  }
  return { id, name, venue, capacity };
}

function parseTrack(value: unknown, index: number): ScheduleTrack | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "name", "ordinal"])) return null;
  const id = boundedString(value.id, 80, IDENTIFIER);
  const name = boundedString(value.name, 120);
  if (!id || !name) return null;
  return { id, name, ordinal: index + 1 };
}

function parseCommandObject(value: unknown): ScheduleDraftCommand | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const reason = optionalReason(value.reason);
  if (reason === null) return null;

  if (value.kind === "MOVE") {
    if (!hasOnlyKeys(value, ["kind", "sessionId", "target", "reason"])) return null;
    const sessionId = boundedString(value.sessionId, 160, IDENTIFIER);
    const target = parseTarget(value.target);
    if (!sessionId || !target) return null;
    return { kind: "MOVE", sessionId, target, ...(reason === undefined ? {} : { reason }) };
  }

  if (value.kind === "CLEAR") {
    if (!hasOnlyKeys(value, ["kind", "sessionId", "reason"])) return null;
    const sessionId = boundedString(value.sessionId, 160, IDENTIFIER);
    if (!sessionId) return null;
    return { kind: "CLEAR", sessionId, ...(reason === undefined ? {} : { reason }) };
  }

  if (value.kind === "CLEAR_CONFLICT") {
    if (!hasOnlyKeys(value, ["kind", "conflictId", "sessionId", "reason"])) return null;
    const conflictId = boundedString(value.conflictId, 240, IDENTIFIER);
    const sessionId = boundedString(value.sessionId, 160, IDENTIFIER);
    if (!conflictId || !sessionId) return null;
    return {
      kind: "CLEAR_CONFLICT",
      conflictId,
      sessionId,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  if (value.kind === "CONFIGURE") {
    if (!hasOnlyKeys(value, ["kind", "rooms", "tracks", "reason"]) || !Array.isArray(value.rooms) || !Array.isArray(value.tracks)) return null;
    if (value.rooms.length < 1 || value.rooms.length > 50 || value.tracks.length < 1 || value.tracks.length > 50) return null;
    const rooms = value.rooms.map(parseRoom);
    const tracks = value.tracks.map(parseTrack);
    if (rooms.some((room) => room === null) || tracks.some((track) => track === null)) return null;
    return {
      kind: "CONFIGURE",
      rooms: rooms as ScheduleRoom[],
      tracks: tracks as ScheduleTrack[],
      ...(reason === undefined ? {} : { reason }),
    };
  }

  if (value.kind === "AUTO_PLACE") {
    if (!hasOnlyKeys(value, ["kind", "reason"])) return null;
    return { kind: "AUTO_PLACE", ...(reason === undefined ? {} : { reason }) };
  }

  return null;
}

export function parseScheduleDraftCommand(raw: string): ScheduleDraftCommand {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_SCHEDULE_DRAFT_BYTES) {
    throw new SchedulePersistenceError("SCHEDULE_INPUT_INVALID", "The schedule command is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SchedulePersistenceError("SCHEDULE_INPUT_INVALID", "The schedule command is invalid.");
  }
  const command = parseCommandObject(parsed);
  if (!command) {
    throw new SchedulePersistenceError("SCHEDULE_INPUT_INVALID", "The schedule command is invalid.");
  }
  return command;
}

function readEventRows(db: Db, scope: { workspaceId: string; eventId: string }): DomainEventRow[] {
  const rows = db.prepare(
    `SELECT id, rowid, payload_json AS payloadJson,
            payload_fingerprint AS payloadFingerprint, created_at AS createdAt
     FROM domain_events
     WHERE workspace_id = ?
       AND event_type = ?
       AND aggregate_type = ?
       AND aggregate_id = ?
       ORDER BY rowid DESC
       LIMIT ?`,
  ).all(
    scope.workspaceId,
    SCHEDULE_DRAFT_EVENT_TYPE,
    SCHEDULE_DRAFT_AGGREGATE_TYPE,
    scope.eventId,
    MAX_SCHEDULE_DRAFT_EVENTS + 1,
  ) as unknown as DomainEventRow[];
  if (rows.length > MAX_SCHEDULE_DRAFT_EVENTS) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_TOO_MANY_EVENTS");
  }
  return rows;
}

function storedEventFromRow(
  row: DomainEventRow,
  scope: { workspaceId: string; eventId: string },
): StoredScheduleDraftEvent {
  if (
    !boundedString(row.id, 160, IDENTIFIER) ||
    !FINGERPRINT.test(row.payloadFingerprint) ||
    !boundedString(row.createdAt, 128) ||
    !isCanonicalIsoInstant(row.createdAt)
  ) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  if (Buffer.byteLength(row.payloadJson, "utf8") > MAX_SCHEDULE_DRAFT_BYTES) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson) as unknown;
  } catch {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["schema", "requestFingerprint", "idempotencyKey", "requestId", "pointer"])) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  const idempotencyKey = boundedString(parsed.idempotencyKey, 160, IDENTIFIER);
  const requestId = boundedString(parsed.requestId, 160, IDENTIFIER);
  if (
    parsed.schema !== SCHEDULE_DRAFT_EVENT_SCHEMA
    || typeof parsed.requestFingerprint !== "string"
    || !FINGERPRINT.test(parsed.requestFingerprint)
    || !idempotencyKey
    || !requestId
  ) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  if (!isRecord(parsed.pointer)) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  const pointerJson = canonicalJson(parsed.pointer);
  const pointer = parseScheduleDraftPointer(pointerJson, scope);
  if (
    !pointer ||
    canonicalJson(pointer) !== pointerJson ||
    (pointer.cfpSessionInventoryFingerprint !== undefined && (
      pointer.cfpSessionAuthorities === undefined ||
      fingerprintOf(pointer.cfpSessionAuthorities) !== pointer.cfpSessionInventoryFingerprint
    )) ||
    pointer.placements.some(({ placement }) => placement !== null && (
      !isCanonicalIsoInstant(placement.startsAt) ||
      !isCanonicalIsoInstant(placement.endsAt) ||
      Date.parse(placement.startsAt) >= Date.parse(placement.endsAt)
    ))
  ) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  const event = {
    schema: SCHEDULE_DRAFT_EVENT_SCHEMA,
    requestFingerprint: parsed.requestFingerprint,
    idempotencyKey,
    requestId,
    pointer,
  } satisfies StoredScheduleDraftEvent;
  if (canonicalJson(event) !== row.payloadJson || fingerprintOf(event) !== row.payloadFingerprint) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  return event;
}

function scheduleDraftAuditDetails(
  row: Pick<DomainEventRow, "id" | "payloadFingerprint">,
  stored: StoredScheduleDraftEvent,
  changed: boolean,
): Record<string, unknown> {
  return {
    schema: SCHEDULE_DRAFT_AUDIT_SCHEMA,
    changed,
    revision: stored.pointer.revision,
    requestFingerprint: stored.requestFingerprint,
    idempotencyKey: stored.idempotencyKey,
    requestId: stored.requestId,
    domainEventId: row.id,
    domainEventPayloadFingerprint: row.payloadFingerprint,
    pointerFingerprint: fingerprintOf(stored.pointer),
  };
}

function authorityCutoffForStoredEvent(
  db: Db,
  scope: { workspaceId: string; eventId: string },
  row: DomainEventRow,
  stored: StoredScheduleDraftEvent,
): CanonicalScheduleAuthorityCutoff | null {
  // The schedule audit is written in the same transaction immediately after this domain event.
  // Its immutable event ID plus full canonical event/pointer fingerprints bind the rows one-to-one;
  // audit rowid then orders equal-time authorities.
  const audits = db.prepare(
    `SELECT id, action, details_json AS detailsJson, created_at AS createdAt
       FROM audit_events
      WHERE workspace_id = ? AND target_type = 'event' AND target_id = ?
        AND action IN ('schedule.draft.saved', 'schedule.draft.unchanged')
        AND CASE
              WHEN json_valid(details_json)
              THEN json_extract(details_json, '$.domainEventId')
              ELSE NULL
            END = ?
      ORDER BY rowid
      LIMIT 2`,
  ).all(
    scope.workspaceId,
    scope.eventId,
    row.id,
  ) as unknown as Array<{ id: string; action: string; detailsJson: string; createdAt: string }>;
  const audit = audits[0];
  let details: unknown;
  try {
    details = audit ? JSON.parse(audit.detailsJson) as unknown : null;
  } catch {
    return null;
  }
  const changed = audit?.action === "schedule.draft.saved";
  const expectedDetails = audit
    ? JSON.stringify(scheduleDraftAuditDetails(row, stored, changed))
    : null;
  if (
    audits.length !== 1 ||
    !audit ||
    (audit.action !== "schedule.draft.saved" && audit.action !== "schedule.draft.unchanged") ||
    !isRecord(details) ||
    audit.detailsJson !== expectedDetails ||
    !boundedString(audit.id, 160, IDENTIFIER) ||
    !isCanonicalIsoInstant(row.createdAt) ||
    !boundedString(audit.createdAt, 128) ||
    !isCanonicalIsoInstant(audit.createdAt) ||
    Date.parse(audit.createdAt) < Date.parse(row.createdAt)
  ) {
    return null;
  }
  return { auditEventId: audit.id, at: audit.createdAt };
}

function scheduleDraftAuthorityEvidence(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
  row: DomainEventRow,
): ScheduleDraftAuthorityEvidence | null {
  const stored = storedEventFromRow(row, scope);
  const cutoff = authorityCutoffForStoredEvent(db, scope, row, stored);
  if (!cutoff) return null;
  return Object.freeze({
    auditEventId: cutoff.auditEventId,
    recordedAt: cutoff.at,
    pointerFingerprint: fingerprintOf(stored.pointer),
    pointer: stored.pointer,
  });
}

export function readScheduleDraftAuthorityEvidence(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
  auditEventId: string,
): ScheduleDraftAuthorityEvidence | null {
  if (!boundedString(auditEventId, 160, IDENTIFIER)) return null;
  for (const row of readEventRows(db, scope)) {
    const evidence = scheduleDraftAuthorityEvidence(db, scope, row);
    if (evidence?.auditEventId === auditEventId) return evidence;
  }
  return null;
}

export function findScheduleDraftAuthorityEvidence(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
  pointer: ScheduleDraftPointer,
): ScheduleDraftAuthorityEvidence | null {
  const expected = canonicalJson(pointer);
  for (const row of readEventRows(db, scope)) {
    const evidence = scheduleDraftAuthorityEvidence(db, scope, row);
    if (evidence && canonicalJson(evidence.pointer) === expected) return evidence;
  }
  return null;
}

function boundStoredEvents(
  db: Db,
  scope: { workspaceId: string; eventId: string },
  base: ScheduleSnapshot,
): BoundStoredScheduleDraftEvent[] {
  const seenIdempotencyKeys = new Set<string>();
  return readEventRows(db, scope).map((row) => {
    const stored = storedEventFromRow(row, scope);
    let contextConflict: SchedulePersistenceError | null = null;
    try {
      applyStoredPointer(base, stored.pointer);
    } catch (error) {
      if (!(error instanceof SchedulePersistenceError) || error.code !== "SCHEDULE_CONTEXT_CONFLICT") {
        throw error;
      }
      contextConflict = error;
    }
    const cutoff = authorityCutoffForStoredEvent(db, scope, row, stored);
    if (!cutoff) {
      if (contextConflict) throw contextConflict;
      throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
    }
    if (seenIdempotencyKeys.has(stored.idempotencyKey)) {
      throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
    }
    seenIdempotencyKeys.add(stored.idempotencyKey);
    return { stored, cutoff, contextConflict };
  });
}

function scopedFallbackId(
  scope: { readonly workspaceId: string; readonly eventId: string },
  kind: "room" | "track",
): string {
  return deterministicUuid(`canonical-schedule:${kind}:${scope.workspaceId}:${scope.eventId}`);
}

function normalizeLegacyFallbackPointer(
  base: ScheduleSnapshot,
  pointer: ScheduleDraftPointer,
): ScheduleDraftPointer {
  if (pointer.cfpSessionInventoryFingerprint !== undefined) return pointer;
  const scopedRoomId = scopedFallbackId(base, "room");
  const scopedTrackId = scopedFallbackId(base, "track");
  const baseRoom = base.rooms.find((room) => room.id === scopedRoomId);
  const baseTrack = base.tracks.find((track) => track.id === scopedTrackId);
  const legacyRoom = pointer.rooms?.find((room) => room.id === "room-default");
  const legacyTrack = pointer.tracks?.find((track) => track.id === "track-default");
  const mapRoom = Boolean(baseRoom && legacyRoom && baseRoom.name === legacyRoom.name && baseRoom.venue === legacyRoom.venue);
  const mapTrack = Boolean(baseTrack && legacyTrack && baseTrack.name === legacyTrack.name);
  if (!mapRoom && !mapTrack) return pointer;
  return {
    ...pointer,
    rooms: pointer.rooms?.map((room) =>
      mapRoom && room.id === "room-default" ? { ...room, id: scopedRoomId } : room
    ),
    tracks: pointer.tracks?.map((track) =>
      mapTrack && track.id === "track-default" ? { ...track, id: scopedTrackId } : track
    ),
    placements: pointer.placements.map((entry) => ({
      sessionId: entry.sessionId,
      placement: entry.placement === null
        ? null
        : {
            ...entry.placement,
            roomId: mapRoom && entry.placement.roomId === "room-default"
              ? scopedRoomId
              : entry.placement.roomId,
            trackId: mapTrack && entry.placement.trackId === "track-default"
              ? scopedTrackId
              : entry.placement.trackId,
          },
    })),
  };
}

function rebaseStoredEventForMonotonicCfpAuthority(
  base: ScheduleSnapshot,
  stored: StoredScheduleDraftEvent,
): StoredScheduleDraftEvent | null {
  const pointer = normalizeLegacyFallbackPointer(base, stored.pointer);
  const pointerFingerprint = pointer.cfpSessionInventoryFingerprint ??
    EMPTY_CFP_SESSION_INVENTORY_FINGERPRINT;
  const pointerAuthorities = pointer.cfpSessionAuthorities ?? [];
  if (
    pointer.planVersionId !== base.planVersionId ||
    pointer.planFingerprint !== base.planFingerprint ||
    pointer.acceptedInventoryFingerprint !== base.acceptedInventoryFingerprint ||
    pointerFingerprint === base.cfpSessionInventoryFingerprint ||
    fingerprintOf(pointerAuthorities) !== pointerFingerprint ||
    fingerprintOf(base.cfpSessionAuthorities) !== base.cfpSessionInventoryFingerprint
  ) {
    return null;
  }
  const currentByUnit = new Map(base.cfpSessionAuthorities.map((authority) => [authority.programUnitId, authority]));
  let monotonicAddition = base.cfpSessionAuthorities.length > pointerAuthorities.length;
  for (const prior of pointerAuthorities) {
    const current = currentByUnit.get(prior.programUnitId);
    if (!current || current.sessionFingerprint !== prior.sessionFingerprint) return null;
    const currentLinks = new Set(current.linkFingerprints);
    if (prior.linkFingerprints.some((fingerprint) => !currentLinks.has(fingerprint))) return null;
    if (current.linkFingerprints.length > prior.linkFingerprints.length) monotonicAddition = true;
  }
  if (!monotonicAddition) return null;

  const baseSessionIds = new Set(base.sessions.map((session) => session.id));
  if (pointer.placements.some((entry) => !baseSessionIds.has(entry.sessionId))) return null;
  const pointerSessionIds = new Set(pointer.placements.map((entry) => entry.sessionId));
  const trackById = new Map((pointer.tracks ?? []).map((track) => [track.id, track]));
  for (const session of base.sessions) {
    if (trackById.has(session.trackId)) continue;
    const track = base.tracks.find((candidate) => candidate.id === session.trackId);
    if (!track) return null;
    trackById.set(track.id, track);
  }
  const rebasedPointer: ScheduleDraftPointer = {
    ...pointer,
    cfpSessionInventoryFingerprint: base.cfpSessionInventoryFingerprint,
    cfpSessionAuthorities: base.cfpSessionAuthorities.map((authority) => ({
      ...authority,
      linkFingerprints: [...authority.linkFingerprints],
    })),
    ...(pointer.tracks ? {
      tracks: [...trackById.values()].map((track, index) => ({ ...track, ordinal: index + 1 })),
    } : {}),
    placements: [
      ...pointer.placements,
      ...base.sessions
        .filter((session) => !pointerSessionIds.has(session.id))
        .map((session) => ({ sessionId: session.id, placement: null })),
    ].sort((first, second) => first.sessionId.localeCompare(second.sessionId)),
  };
  try {
    applyStoredPointer(base, rebasedPointer);
  } catch {
    return null;
  }
  return { ...stored, pointer: rebasedPointer };
}

function latestCompatibleStoredEvent(
  db: Db,
  scope: { workspaceId: string; eventId: string },
  base: ScheduleSnapshot,
  events: readonly BoundStoredScheduleDraftEvent[],
): StoredScheduleDraftEvent | null {
  for (const event of events) {
    if (!event.contextConflict) {
      return { ...event.stored, pointer: normalizeLegacyFallbackPointer(base, event.stored.pointer) };
    }
    const rebased = rebaseStoredEventForMonotonicCfpAuthority(base, event.stored);
    if (rebased) return rebased;
    if (
      event.stored.pointer.planVersionId === base.planVersionId &&
      event.stored.pointer.planFingerprint === base.planFingerprint &&
      event.stored.pointer.acceptedInventoryFingerprint === base.acceptedInventoryFingerprint
    ) {
      throw event.contextConflict;
    }
    let historical;
    try {
      historical = readCanonicalScheduleAuthorityAt(db, scope, event.cutoff);
    } catch (historicalError) {
      if (historicalError instanceof CanonicalScheduleError) throw event.contextConflict;
      throw historicalError;
    }
    if (
      !historical ||
      event.stored.pointer.planVersionId !== historical.planVersionId ||
      event.stored.pointer.planFingerprint !== historical.planFingerprint ||
      event.stored.pointer.acceptedInventoryFingerprint !== historical.acceptedInventoryFingerprint ||
      (event.stored.pointer.cfpSessionInventoryFingerprint ?? EMPTY_CFP_SESSION_INVENTORY_FINGERPRINT) !==
        historical.cfpSessionInventoryFingerprint ||
      canonicalJson(event.stored.pointer.cfpSessionAuthorities ?? []) !==
        canonicalJson(historical.cfpSessionAuthorities)
    ) {
      throw event.contextConflict;
    }
    // This pointer is valid history for an authority that has since changed. Keep looking for a
    // newer/current compatible draft; if none exists, callers start from the new canonical base.
  }
  return null;
}

function storedEventForIdempotencyKey(
  events: readonly BoundStoredScheduleDraftEvent[],
  idempotencyKey: string,
): StoredScheduleDraftEvent | null {
  for (const event of events) {
    if (event.stored.idempotencyKey === idempotencyKey) return event.stored;
  }
  return null;
}

function scopedEvent(db: Db, scope: { workspaceId: string; eventId: string }) {
  const event = getEvent(db, scope.workspaceId, scope.eventId);
  if (!event) {
    throw new SchedulePersistenceError("SCHEDULE_SCOPE_DENIED");
  }
  return event;
}

function baseSchedule(db: Db, scope: { workspaceId: string; eventId: string }): ScheduleSnapshot {
  const event = scopedEvent(db, scope);
  try {
    const canonical = readCanonicalScheduleProjection(db, scope, event as unknown as Record<string, unknown>);
    if (canonical) return canonical;
  } catch (error) {
    if (error instanceof CanonicalScheduleError) {
      throw new SchedulePersistenceError("SCHEDULE_CANONICAL_UNAVAILABLE");
    }
    throw error;
  }
  throw new SchedulePersistenceError("SCHEDULE_CANONICAL_UNAVAILABLE");
}

function pointerForSchedule(schedule: ScheduleSnapshot, activeDayId?: string): ScheduleDraftPointer {
  const pointer = parseScheduleDraftPointer(serializeScheduleDraft(schedule, activeDayId), schedule);
  if (!pointer) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  return pointer;
}

function applyStoredPointer(base: ScheduleSnapshot, pointer: ScheduleDraftPointer): ScheduleSnapshot {
  const compatiblePointer = normalizeLegacyFallbackPointer(base, pointer);
  if (compatiblePointer.revision < base.revision || compatiblePointer.revision > MAX_SCHEDULE_DRAFT_REVISION) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  if (compatiblePointer.activeDayId !== undefined && !base.days.some((day) => day.id === compatiblePointer.activeDayId)) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
  try {
    const schedule = applyScheduleDraftPointer(base, compatiblePointer);
    if (schedule.revision !== compatiblePointer.revision) {
      throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
    }
    return schedule;
  } catch (error) {
    if (error instanceof ScheduleCommandError && error.code === "SCHEDULE_CONTEXT_CONFLICT") {
      throw new SchedulePersistenceError("SCHEDULE_CONTEXT_CONFLICT");
    }
    if (error instanceof SchedulePersistenceError) throw error;
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_CORRUPT");
  }
}

export function readScheduleDraft(
  db: Db,
  scope: { workspaceId: string; eventId: string },
): ScheduleDraftReadResult {
  const base = baseSchedule(db, scope);
  const stored = latestCompatibleStoredEvent(db, scope, base, boundStoredEvents(db, scope, base));
  if (!stored) {
    return { schedule: base, pointer: null, persisted: false };
  }
  return {
    schedule: applyStoredPointer(base, stored.pointer),
    pointer: stored.pointer,
    persisted: true,
  };
}

function validateExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SCHEDULE_DRAFT_REVISION) {
    throw new SchedulePersistenceError("SCHEDULE_INPUT_INVALID", "The schedule command is invalid.");
  }
}

function validateRequestMetadata(input: ExecuteScheduleDraftInput): void {
  if (!boundedString(input.idempotencyKey, 160, IDENTIFIER) || !boundedString(input.requestId, 160, IDENTIFIER)) {
    throw new SchedulePersistenceError("SCHEDULE_INPUT_INVALID", "The schedule command is invalid.");
  }
  if (
    !boundedString(input.planVersionId, 160, IDENTIFIER) ||
    !boundedString(input.planFingerprint, 160) ||
    !boundedString(input.acceptedInventoryFingerprint, 160) ||
    (input.cfpSessionInventoryFingerprint !== undefined &&
      !boundedString(input.cfpSessionInventoryFingerprint, 160))
  ) {
    throw new SchedulePersistenceError("SCHEDULE_INPUT_INVALID", "The schedule command is invalid.");
  }
}

function scheduleRequestFingerprint(
  scope: { readonly workspaceId: string; readonly eventId: string },
  input: ExecuteScheduleDraftInput,
  includeCfpAuthority: boolean,
): string {
  return fingerprintOf({
    schema: SCHEDULE_DRAFT_EVENT_SCHEMA,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    expectedRevision: input.expectedRevision,
    planVersionId: input.planVersionId,
    planFingerprint: input.planFingerprint,
    acceptedInventoryFingerprint: input.acceptedInventoryFingerprint,
    ...(includeCfpAuthority
      ? { cfpSessionInventoryFingerprint: input.cfpSessionInventoryFingerprint }
      : {}),
    activeDayId: input.activeDayId ?? null,
    command: input.command,
  });
}

function assertEventDraftWritable(lifecycle: string): void {
  if (!WRITABLE_EVENT_LIFECYCLES.has(lifecycle)) {
    throw new SchedulePersistenceError("SCHEDULE_EVENT_CLOSED", "The event schedule is closed to ordinary changes.");
  }
}

function applyCommand(
  schedule: ScheduleSnapshot,
  input: ExecuteScheduleDraftInput,
): ScheduleSnapshot | null {
  const command = input.command;
  if (command.kind === "MOVE") {
    return moveSession(schedule, {
      sessionId: command.sessionId,
      target: command.target,
      expectedRevision: input.expectedRevision,
      reason: command.reason,
    }).schedule;
  }
  if (command.kind === "CLEAR") {
    return unscheduleSession(schedule, {
      sessionId: command.sessionId,
      expectedRevision: input.expectedRevision,
      reason: command.reason,
    }).schedule;
  }
  if (command.kind === "CLEAR_CONFLICT") {
    return clearScheduleConflict(schedule, {
      conflictId: command.conflictId,
      sessionId: command.sessionId,
      expectedRevision: input.expectedRevision,
      reason: command.reason,
    }).schedule;
  }
  if (command.kind === "CONFIGURE") {
    const configuration: ScheduleConfigurationInput = {
      rooms: command.rooms,
      tracks: command.tracks,
      expectedRevision: input.expectedRevision,
      reason: command.reason,
    };
    return configureSchedule(schedule, configuration).schedule;
  }
  const result = autoPlaceUnscheduledSessions(schedule, {
    expectedRevision: input.expectedRevision,
    reason: command.reason,
  });
  return result.change ? result.schedule : null;
}

function persistStoredEvent(
  db: Db,
  scope: { workspaceId: string; eventId: string },
  stored: StoredScheduleDraftEvent,
  actorAccountId: string | undefined,
  changed: boolean,
): void {
  const countRow = db.prepare(
    `SELECT COUNT(*) AS count
     FROM domain_events
     WHERE workspace_id = ?
       AND event_type = ?
       AND aggregate_type = ?
       AND aggregate_id = ?`,
  ).get(
    scope.workspaceId,
    SCHEDULE_DRAFT_EVENT_TYPE,
    SCHEDULE_DRAFT_AGGREGATE_TYPE,
    scope.eventId,
  ) as { count: number };
  if (!Number.isSafeInteger(countRow.count) || countRow.count >= MAX_SCHEDULE_DRAFT_EVENTS) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_TOO_MANY_EVENTS");
  }
  const payloadJson = canonicalJson(stored);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_SCHEDULE_DRAFT_BYTES) {
    throw new SchedulePersistenceError("SCHEDULE_DRAFT_TOO_LARGE");
  }
  const domainEventId = uuid();
  const payloadFingerprint = fingerprintOf(stored);
  db.prepare(
    `INSERT INTO domain_events
       (id, workspace_id, event_type, aggregate_type, aggregate_id,
        payload_json, payload_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    domainEventId,
    scope.workspaceId,
    SCHEDULE_DRAFT_EVENT_TYPE,
    SCHEDULE_DRAFT_AGGREGATE_TYPE,
    scope.eventId,
    payloadJson,
    payloadFingerprint,
    nowIso(),
  );
  writeAudit(db, scope.workspaceId, {
    actorKind: actorAccountId ? "account" : "system",
    actorRef: actorAccountId ?? "schedule-draft-service",
    action: changed ? "schedule.draft.saved" : "schedule.draft.unchanged",
    targetType: "event",
    targetId: scope.eventId,
    details: scheduleDraftAuditDetails({ id: domainEventId, payloadFingerprint }, stored, changed),
  });
}

export function executeScheduleDraftCommand(
  db: Db,
  scope: { workspaceId: string; eventId: string },
  input: ExecuteScheduleDraftInput,
): ScheduleDraftMutationResult {
  validateExpectedRevision(input.expectedRevision);
  validateRequestMetadata(input);
  if (input.activeDayId !== undefined && (!boundedString(input.activeDayId, 160, IDENTIFIER))) {
    throw new SchedulePersistenceError("SCHEDULE_INPUT_INVALID", "The schedule command is invalid.");
  }

  return withTransaction(db, () => {
    const event = scopedEvent(db, scope);
    const base = baseSchedule(db, scope);
    const storedEvents = boundStoredEvents(db, scope, base);
    const currentStored = latestCompatibleStoredEvent(db, scope, base, storedEvents);
    const currentSchedule = currentStored
      ? applyStoredPointer(base, currentStored.pointer)
      : base;
    if (input.activeDayId !== undefined && !currentSchedule.days.some((day) => day.id === input.activeDayId)) {
      throw new SchedulePersistenceError("SCHEDULE_INPUT_INVALID", "The schedule command is invalid.");
    }

    const replay = storedEventForIdempotencyKey(storedEvents, input.idempotencyKey);
    if (replay) {
      const replayFingerprint = replay.pointer.cfpSessionInventoryFingerprint === undefined
        ? scheduleRequestFingerprint(scope, input, false)
        : input.cfpSessionInventoryFingerprint === undefined
          ? null
          : scheduleRequestFingerprint(scope, input, true);
      if (replayFingerprint === null || replay.requestFingerprint !== replayFingerprint) {
        throw new SchedulePersistenceError("SCHEDULE_IDEMPOTENCY_CONFLICT", "The schedule request key was already used.");
      }
      const authoritative = currentStored?.pointer ?? replay.pointer;
      return {
        schedule: applyStoredPointer(base, authoritative),
        pointer: authoritative,
        changed: false,
        persisted: true,
      };
    }

    if (
      input.cfpSessionInventoryFingerprint === undefined ||
      input.planVersionId !== base.planVersionId ||
      input.planFingerprint !== base.planFingerprint ||
      input.acceptedInventoryFingerprint !== base.acceptedInventoryFingerprint ||
      input.cfpSessionInventoryFingerprint !== base.cfpSessionInventoryFingerprint
    ) {
      throw new SchedulePersistenceError(
        input.cfpSessionInventoryFingerprint === undefined
          ? "SCHEDULE_INPUT_INVALID"
          : "SCHEDULE_CONTEXT_CONFLICT",
        "The approved plan, accepted commitments, or accepted CFP sessions changed on the server.",
      );
    }
    const requestFingerprint = scheduleRequestFingerprint(scope, input, true);

    assertEventDraftWritable(event.lifecycle);

    if (input.expectedRevision !== currentSchedule.revision) {
      throw new ScheduleDraftRevisionConflictError(
        currentStored?.pointer ?? pointerForSchedule(currentSchedule),
      );
    }

    let next: ScheduleSnapshot | null;
    try {
      next = applyCommand(currentSchedule, input);
    } catch (error) {
      if (error instanceof ScheduleCommandError) {
        throw new SchedulePersistenceError(error.code);
      }
      throw error;
    }
    if (!next) {
      try {
        // A canonical projection may supply deterministic default placements once resources are
        // configured, even before allocation rows exist for newly accepted sessions. A no-op
        // command still owns the durability boundary: materialize those exact defaults before
        // recording the pointer so publication cannot observe geometry without persisted state.
        persistCanonicalScheduleMutation(db, scope, currentSchedule, currentSchedule);
      } catch (error) {
        if (error instanceof CanonicalScheduleError) {
          throw new SchedulePersistenceError("SCHEDULE_CANONICAL_UNAVAILABLE");
        }
        throw error;
      }
      const pointer = input.activeDayId !== undefined
        ? pointerForSchedule(currentSchedule, input.activeDayId)
        : currentStored?.pointer ?? pointerForSchedule(currentSchedule);
      persistStoredEvent(db, scope, {
        schema: SCHEDULE_DRAFT_EVENT_SCHEMA,
        requestFingerprint,
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId,
        pointer,
      }, input.actorAccountId, false);
      return {
        schedule: currentSchedule,
        pointer,
        changed: false,
        persisted: true,
      };
    }
    if (next.revision !== input.expectedRevision + 1) {
      throw new SchedulePersistenceError("SCHEDULE_REVISION_INVALID");
    }
    if (next.revision > MAX_SCHEDULE_DRAFT_REVISION) {
      throw new SchedulePersistenceError("SCHEDULE_REVISION_INVALID");
    }

    const pointer = pointerForSchedule(next, input.activeDayId);
    const stored: StoredScheduleDraftEvent = {
      schema: SCHEDULE_DRAFT_EVENT_SCHEMA,
      requestFingerprint,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      pointer,
    };
    try {
      persistCanonicalScheduleMutation(db, scope, currentSchedule, next);
    } catch (error) {
      if (error instanceof CanonicalScheduleError) {
        throw new SchedulePersistenceError("SCHEDULE_CANONICAL_UNAVAILABLE");
      }
      throw error;
    }
    persistStoredEvent(db, scope, stored, input.actorAccountId, true);
    return { schedule: next, pointer, changed: true, persisted: true };
  });
}
