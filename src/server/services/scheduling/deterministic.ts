import type {
  ApprovedScheduleSnapshot,
  AutoPlaceResult,
  ClearConflictResult,
  ScheduleChange,
  ScheduleConflict,
  ScheduleConfigurationInput,
  ScheduleDay,
  ScheduleDraftPointer,
  SchedulePlacement,
  SchedulePlacementTarget,
  ScheduleRoom,
  ScheduleSession,
  ScheduleMutationResult,
  ScheduleSnapshot,
  ScheduleTrack,
  ScheduleTimeSlot,
} from "./types";
import { EMPTY_CFP_SESSION_INVENTORY_FINGERPRINT } from "./types";

export class ScheduleCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ScheduleCommandError";
    this.code = code;
  }
}

export function cloneSchedule(schedule: ScheduleSnapshot): ScheduleSnapshot {
  return JSON.parse(JSON.stringify(schedule)) as ScheduleSnapshot;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

/** A small cross-runtime fingerprint for the fixture adapter. S0 can replace this with its hash port. */
export function deterministicFingerprint(value: unknown): string {
  let hash = 2166136261;
  for (const character of stableSerialize(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function scheduleContentFingerprint(schedule: ScheduleSnapshot): string {
  const copy = clone(schedule);
  delete (copy as Partial<ScheduleSnapshot>).planFingerprint;
  delete (copy as Partial<ScheduleSnapshot>).acceptedInventoryFingerprint;
  delete (copy as Partial<ScheduleSnapshot>).cfpSessionInventoryFingerprint;
  delete (copy as Partial<ScheduleSnapshot>).cfpSessionAuthorities;
  return deterministicFingerprint(copy);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
  }
  return value;
}

export function immutableSchedule(schedule: ScheduleSnapshot): ScheduleSnapshot {
  return freezeDeep(clone(schedule));
}

function assertScope(schedule: ScheduleSnapshot, scope: { workspaceId: string; eventId: string }): void {
  if (schedule.workspaceId !== scope.workspaceId || schedule.eventId !== scope.eventId) {
    throw new ScheduleCommandError(
      "SCHEDULE_SCOPE_MISMATCH",
      "The requested schedule is outside the authorized workspace and event scope.",
    );
  }
}

function assertRevision(schedule: ScheduleSnapshot, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== schedule.revision) {
    throw new ScheduleCommandError(
      "SCHEDULE_REVISION_CONFLICT",
      `The schedule revision is ${schedule.revision}; the command expected ${expectedRevision}.`,
    );
  }
}

function assertDraft(schedule: ScheduleSnapshot): void {
  if (schedule.status !== "DRAFT") {
    throw new ScheduleCommandError(
      "SCHEDULE_APPROVED_IMMUTABLE",
      "Approved schedule content is immutable; create a new draft to change it.",
    );
  }
}

function sessionById(schedule: ScheduleSnapshot, sessionId: string): ScheduleSession {
  const session = schedule.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    throw new ScheduleCommandError("SESSION_NOT_FOUND", "The requested session is not in this event.");
  }
  return session;
}

function timeSlotById(schedule: ScheduleSnapshot, timeSlotId: string): ScheduleTimeSlot {
  const slot = schedule.timeSlots.find((candidate) => candidate.id === timeSlotId);
  if (!slot) {
    throw new ScheduleCommandError("TIME_SLOT_NOT_FOUND", "The requested time slot is not in this event.");
  }
  return slot;
}

function ensureTarget(schedule: ScheduleSnapshot, session: ScheduleSession, target: SchedulePlacementTarget): SchedulePlacement {
  const slot = timeSlotById(schedule, target.timeSlotId);
  if (slot.dayId !== target.dayId) {
    throw new ScheduleCommandError("TIME_SLOT_DAY_MISMATCH", "A time slot must be placed on its own event day.");
  }
  if (!schedule.days.some((day) => day.id === target.dayId)) {
    throw new ScheduleCommandError("DAY_NOT_FOUND", "The requested event day is not configured.");
  }
  if (!schedule.rooms.some((room) => room.id === target.roomId)) {
    throw new ScheduleCommandError("ROOM_NOT_FOUND", "The requested room is not configured for this event.");
  }
  if (!schedule.tracks.some((track) => track.id === target.trackId)) {
    throw new ScheduleCommandError("TRACK_NOT_FOUND", "The requested track is not configured for this event.");
  }
  const startsAt = slot.startsAt;
  const endsAt = addMinutes(startsAt, session.durationMinutes);
  if (endsAt > slot.endsAt) {
    throw new ScheduleCommandError(
      "SESSION_EXCEEDS_SLOT",
      `The ${session.durationMinutes}-minute session does not fit in ${slot.label}.`,
    );
  }
  return {
    dayId: target.dayId,
    timeSlotId: target.timeSlotId,
    roomId: target.roomId,
    trackId: target.trackId,
    startsAt,
    endsAt,
  };
}

function addMinutes(iso: string, minutes: number): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    throw new ScheduleCommandError("INVALID_TIME", "Schedule timestamps must be valid ISO values.");
  }
  return new Date(timestamp + minutes * 60_000).toISOString();
}

function overlaps(first: SchedulePlacement, second: SchedulePlacement): boolean {
  return first.startsAt < second.endsAt && second.startsAt < first.endsAt;
}

function sessionTitle(schedule: ScheduleSnapshot, sessionId: string): string {
  return sessionById(schedule, sessionId).title;
}

function speakerName(schedule: ScheduleSnapshot, speakerId: string): string {
  return schedule.speakers.find((speaker) => speaker.id === speakerId)?.displayName ?? "Unknown speaker";
}

function roomName(schedule: ScheduleSnapshot, roomId: string): string {
  return schedule.rooms.find((room) => room.id === roomId)?.name ?? "Unknown room";
}

function conflictFor(
  schedule: ScheduleSnapshot,
  kind: ScheduleConflict["kind"],
  first: ScheduleSession,
  second: ScheduleSession,
  resourceId: string,
  resourceLabel: string,
): ScheduleConflict {
  const sessionIds = [first.id, second.id].sort() as [string, string];
  const firstPlacement = first.placement!;
  const secondPlacement = second.placement!;
  const startsAt = firstPlacement.startsAt > secondPlacement.startsAt ? firstPlacement.startsAt : secondPlacement.startsAt;
  const endsAt = firstPlacement.endsAt < secondPlacement.endsAt ? firstPlacement.endsAt : secondPlacement.endsAt;
  const ruleKey = kind === "SPEAKER_OVERLAP" ? "SPEAKER_NO_OVERLAP" : "ROOM_NO_OVERLAP";
  const subject = kind === "SPEAKER_OVERLAP" ? `Speaker ${resourceLabel}` : `Room ${resourceLabel}`;
  const explanation = `${subject} is used by “${sessionTitle(schedule, sessionIds[0])}” and “${sessionTitle(schedule, sessionIds[1])}” from ${startsAt} to ${endsAt}. The ${ruleKey} hard constraint requires these intervals to be separate.`;
  return {
    id: `conflict:${kind.toLowerCase()}:${deterministicFingerprint({ kind, sessionIds, resourceId, startsAt, endsAt })}`,
    kind,
    severity: "HARD",
    ruleKey,
    sessionIds,
    resourceId,
    resourceLabel,
    startsAt,
    endsAt,
    summary: `${subject} overlap · ${sessionTitle(schedule, sessionIds[0])} / ${sessionTitle(schedule, sessionIds[1])}`,
    explanation,
    suggestedActions: [
      `Move “${sessionTitle(schedule, sessionIds[1])}” to another compatible time slot or room.`,
      `Clear one placement to leave the other session unchanged.`,
    ],
  };
}

export function detectScheduleConflicts(schedule: ScheduleSnapshot): ScheduleConflict[] {
  const placed = schedule.sessions
    .filter((session) => session.placement !== null)
    .sort((first, second) => first.id.localeCompare(second.id));
  const conflicts: ScheduleConflict[] = [];
  for (let firstIndex = 0; firstIndex < placed.length; firstIndex += 1) {
    const first = placed[firstIndex]!;
    for (let secondIndex = firstIndex + 1; secondIndex < placed.length; secondIndex += 1) {
      const second = placed[secondIndex]!;
      if (!overlaps(first.placement!, second.placement!)) continue;
      const sharedSpeakerId = first.speakerIds
        .filter((speakerId) => second.speakerIds.includes(speakerId))
        .sort()[0];
      if (sharedSpeakerId) {
        conflicts.push(conflictFor(schedule, "SPEAKER_OVERLAP", first, second, sharedSpeakerId, speakerName(schedule, sharedSpeakerId)));
      }
      if (first.placement!.roomId === second.placement!.roomId) {
        conflicts.push(conflictFor(schedule, "ROOM_OVERLAP", first, second, first.placement!.roomId, roomName(schedule, first.placement!.roomId)));
      }
    }
  }
  return conflicts.sort((first, second) => first.id.localeCompare(second.id));
}

function replacePlacement(schedule: ScheduleSnapshot, sessionId: string, placement: SchedulePlacement | null): ScheduleSnapshot {
  const next = cloneSchedule(schedule);
  next.sessions = next.sessions.map((session) => session.id === sessionId ? { ...session, placement: clone(placement) } : session);
  return next;
}

function changeFingerprint(change: Omit<ScheduleChange, "changeFingerprint">): string {
  return deterministicFingerprint(change);
}

function normalizedReason(reason: string | undefined, fallback: string): string {
  const value = reason?.trim() || fallback;
  if (value.length > 240) {
    throw new ScheduleCommandError("REASON_TOO_LONG", "A schedule change reason must be 240 characters or fewer.");
  }
  return value;
}

const MAX_CONFIGURED_RESOURCES = 50;

function normalizedResourceId(value: string, label: string): string {
  const id = value.trim();
  if (!id || id.length > 80 || !/^[a-zA-Z0-9:_-]+$/.test(id)) {
    throw new ScheduleCommandError("INVALID_RESOURCE_ID", `${label} identifiers must be short, stable, and use letters, numbers, :, _, or - only.`);
  }
  return id;
}

function normalizedResourceName(value: string, label: string): string {
  const name = value.trim();
  if (!name || name.length > 120) {
    throw new ScheduleCommandError("INVALID_RESOURCE_NAME", `${label} names must be between 1 and 120 characters.`);
  }
  return name;
}

function normalizeRooms(rooms: ScheduleRoom[]): ScheduleRoom[] {
  if (rooms.length < 1 || rooms.length > MAX_CONFIGURED_RESOURCES) {
    throw new ScheduleCommandError("INVALID_ROOM_COUNT", `An event must have between 1 and ${MAX_CONFIGURED_RESOURCES} rooms.`);
  }
  const ids = new Set<string>();
  return rooms.map((room) => {
    const id = normalizedResourceId(room.id, "Room");
    if (ids.has(id)) {
      throw new ScheduleCommandError("DUPLICATE_ROOM_ID", "Each configured room must have a unique identifier.");
    }
    ids.add(id);
    if (!Number.isInteger(room.capacity) || room.capacity < 1 || room.capacity > 1_000_000) {
      throw new ScheduleCommandError("INVALID_ROOM_CAPACITY", "Room capacity must be a whole number between 1 and 1,000,000.");
    }
    return {
      ...clone(room),
      id,
      name: normalizedResourceName(room.name, "Room"),
      venue: normalizedResourceName(room.venue || "Event venue", "Room venue"),
    };
  });
}

function normalizeTracks(tracks: ScheduleTrack[]): ScheduleTrack[] {
  if (tracks.length < 1 || tracks.length > MAX_CONFIGURED_RESOURCES) {
    throw new ScheduleCommandError("INVALID_TRACK_COUNT", `An event must have between 1 and ${MAX_CONFIGURED_RESOURCES} tracks.`);
  }
  const ids = new Set<string>();
  return tracks.map((track, index) => {
    const id = normalizedResourceId(track.id, "Track");
    if (ids.has(id)) {
      throw new ScheduleCommandError("DUPLICATE_TRACK_ID", "Each configured track must have a unique identifier.");
    }
    ids.add(id);
    return {
      ...clone(track),
      id,
      name: normalizedResourceName(track.name, "Track"),
      ordinal: index + 1,
    };
  });
}

function applyConfiguration(
  schedule: ScheduleSnapshot,
  rooms: ScheduleRoom[],
  tracks: ScheduleTrack[],
): ScheduleSnapshot {
  const next = cloneSchedule(schedule);
  next.rooms = normalizeRooms(rooms);
  next.tracks = normalizeTracks(tracks);
  return next;
}

function assertResourceReferences(schedule: ScheduleSnapshot): void {
  const roomIds = new Set(schedule.rooms.map((room) => room.id));
  const trackIds = new Set(schedule.tracks.map((track) => track.id));
  for (const session of schedule.sessions) {
    if (session.trackId && !trackIds.has(session.trackId)) {
      throw new ScheduleCommandError("TRACK_IN_USE", `Track configuration cannot remove the default track for “${session.title}”.`);
    }
    if (session.placement) {
      if (!roomIds.has(session.placement.roomId)) {
        throw new ScheduleCommandError("ROOM_IN_USE", `Room configuration cannot remove the room used by “${session.title}”.`);
      }
      if (!trackIds.has(session.placement.trackId)) {
        throw new ScheduleCommandError("TRACK_IN_USE", `Track configuration cannot remove the track used by “${session.title}”.`);
      }
    }
  }
}

export function configureSchedule(
  schedule: ScheduleSnapshot,
  input: ScheduleConfigurationInput,
): ScheduleMutationResult {
  assertRevision(schedule, input.expectedRevision);
  assertDraft(schedule);
  const next = applyConfiguration(schedule, input.rooms, input.tracks);
  assertResourceReferences(next);
  if (deterministicFingerprint({ rooms: schedule.rooms, tracks: schedule.tracks }) === deterministicFingerprint({ rooms: next.rooms, tracks: next.tracks })) {
    throw new ScheduleCommandError("SCHEDULE_NO_CHANGE", "The room and track configuration is already current.");
  }
  next.revision = schedule.revision + 1;
  const changeWithoutFingerprint = {
    kind: "CONFIGURE" as const,
    from: null,
    to: null,
    reason: normalizedReason(input.reason, "Organizer updated room and track configuration"),
  };
  const change = { ...changeWithoutFingerprint, changeFingerprint: changeFingerprint(changeWithoutFingerprint) };
  return { schedule: next, conflicts: detectScheduleConflicts(next), change };
}

export function moveSession(
  schedule: ScheduleSnapshot,
  input: {
    sessionId: string;
    target: SchedulePlacementTarget;
    expectedRevision: number;
    reason?: string;
  },
): ScheduleMutationResult {
  assertRevision(schedule, input.expectedRevision);
  assertDraft(schedule);
  const session = sessionById(schedule, input.sessionId);
  const placement = ensureTarget(schedule, session, input.target);
  const next = replacePlacement(schedule, session.id, placement);
  next.revision = schedule.revision + 1;
  const changeWithoutFingerprint = {
    kind: "MOVE" as const,
    sessionId: session.id,
    from: clone(session.placement),
    to: clone(placement),
    reason: normalizedReason(input.reason, "Manual schedule move"),
  };
  const change = { ...changeWithoutFingerprint, changeFingerprint: changeFingerprint(changeWithoutFingerprint) };
  return { schedule: next, conflicts: detectScheduleConflicts(next), change };
}

export function unscheduleSession(
  schedule: ScheduleSnapshot,
  input: { sessionId: string; expectedRevision: number; reason?: string },
): ScheduleMutationResult {
  assertRevision(schedule, input.expectedRevision);
  assertDraft(schedule);
  const session = sessionById(schedule, input.sessionId);
  if (!session.placement) {
    throw new ScheduleCommandError("SESSION_ALREADY_UNSCHEDULED", "The session is already in the unscheduled tray.");
  }
  const next = replacePlacement(schedule, session.id, null);
  next.revision = schedule.revision + 1;
  const changeWithoutFingerprint = {
    kind: "CLEAR" as const,
    sessionId: session.id,
    from: clone(session.placement),
    to: null,
    reason: normalizedReason(input.reason, "Clear session placement"),
  };
  const change = { ...changeWithoutFingerprint, changeFingerprint: changeFingerprint(changeWithoutFingerprint) };
  return { schedule: next, conflicts: detectScheduleConflicts(next), change };
}

export function clearScheduleConflict(
  schedule: ScheduleSnapshot,
  input: { conflictId: string; sessionId: string; expectedRevision: number; reason?: string },
): ClearConflictResult {
  const conflictsBefore = detectScheduleConflicts(schedule);
  const conflict = conflictsBefore.find((candidate) => candidate.id === input.conflictId);
  if (!conflict) {
    throw new ScheduleCommandError("CONFLICT_NOT_FOUND", "The requested conflict is no longer present in this schedule revision.");
  }
  if (!conflict.sessionIds.includes(input.sessionId)) {
    throw new ScheduleCommandError("CONFLICT_SESSION_MISMATCH", "The clearing command must name one session from the conflict.");
  }
  const mutation = unscheduleSession(schedule, {
    sessionId: input.sessionId,
    expectedRevision: input.expectedRevision,
    reason: input.reason ?? `Clear ${conflict.ruleKey} conflict`,
  });
  return {
    schedule: mutation.schedule,
    clearedConflictId: conflict.id,
    clearedSessionId: input.sessionId,
    conflictsBefore,
    conflictsAfter: mutation.conflicts,
    explanation: `Cleared “${sessionTitle(schedule, input.sessionId)}” from the schedule. ${conflict.explanation} The other placement remains unchanged and the cleared session is available in the unscheduled tray.`,
  };
}

function candidateTargets(schedule: ScheduleSnapshot, session: ScheduleSession): SchedulePlacementTarget[] {
  const days = [...schedule.days].sort((first, second) => first.ordinal - second.ordinal || first.id.localeCompare(second.id));
  const slots = [...schedule.timeSlots].sort((first, second) => first.ordinal - second.ordinal || first.id.localeCompare(second.id));
  const rooms = [...schedule.rooms].sort((first, second) => first.id.localeCompare(second.id));
  const tracks = [...schedule.tracks].sort((first, second) => first.ordinal - second.ordinal || first.id.localeCompare(second.id));
  const targets: SchedulePlacementTarget[] = [];
  for (const day of days) {
    for (const slot of slots.filter((candidate) => candidate.dayId === day.id)) {
      for (const room of rooms) {
        for (const track of tracks.filter((candidate) => candidate.id === session.trackId || session.trackId === "")) {
          targets.push({ dayId: day.id, timeSlotId: slot.id, roomId: room.id, trackId: track.id });
        }
      }
    }
  }
  return targets;
}

export function suggestConflictFreeMove(schedule: ScheduleSnapshot, sessionId: string): SchedulePlacementTarget | null {
  const session = sessionById(schedule, sessionId);
  for (const target of candidateTargets(schedule, session)) {
    let placement: SchedulePlacement;
    try {
      placement = ensureTarget(schedule, session, target);
    } catch {
      continue;
    }
    const candidate = replacePlacement(schedule, session.id, placement);
    const conflicts = detectScheduleConflicts(candidate).filter((conflict) => conflict.sessionIds.includes(session.id));
    if (conflicts.length === 0) return target;
  }
  return null;
}

export function autoPlaceUnscheduledSessions(
  schedule: ScheduleSnapshot,
  input: { expectedRevision: number; reason?: string },
): AutoPlaceResult {
  assertRevision(schedule, input.expectedRevision);
  assertDraft(schedule);
  let next = cloneSchedule(schedule);
  const unscheduled = next.sessions
    .filter((session) => session.placement === null)
    .sort((first, second) => second.priority - first.priority || first.id.localeCompare(second.id));
  const placedSessionIds: string[] = [];
  for (const session of unscheduled) {
    const target = suggestConflictFreeMove(next, session.id);
    if (!target) continue;
    const placement = ensureTarget(next, session, target);
    next = replacePlacement(next, session.id, placement);
    placedSessionIds.push(session.id);
  }
  const unplacedSessionIds = next.sessions.filter((session) => session.placement === null).map((session) => session.id).sort();
  if (placedSessionIds.length === 0) {
    return { schedule: next, placedSessionIds, unplacedSessionIds, conflicts: detectScheduleConflicts(next), change: null };
  }
  next.revision = schedule.revision + 1;
  const changeWithoutFingerprint = {
    kind: "AUTO_PLACE" as const,
    from: null,
    to: null,
    reason: normalizedReason(input.reason, "Deterministic auto-place of unscheduled sessions"),
  };
  const change = { ...changeWithoutFingerprint, changeFingerprint: changeFingerprint(changeWithoutFingerprint) };
  return { schedule: next, placedSessionIds, unplacedSessionIds, conflicts: detectScheduleConflicts(next), change };
}

export function approveSchedule(schedule: ScheduleSnapshot, input: { approvedAt: string; reason?: string }): ApprovedScheduleSnapshot {
  assertDraft(schedule);
  const conflicts = detectScheduleConflicts(schedule);
  const unplaced = schedule.sessions.filter((session) => session.placement === null);
  if (conflicts.length > 0) {
    throw new ScheduleCommandError("SCHEDULE_HAS_CONFLICTS", "Resolve every hard speaker and room conflict before approval.");
  }
  if (unplaced.length > 0) {
    throw new ScheduleCommandError("SCHEDULE_HAS_UNSCHEDULED", "Place every publishable session before approval.");
  }
  if (!Number.isFinite(Date.parse(input.approvedAt))) {
    throw new ScheduleCommandError("INVALID_APPROVAL_TIME", "Approval time must be a valid ISO timestamp.");
  }
  const next = cloneSchedule(schedule) as ApprovedScheduleSnapshot;
  next.status = "APPROVED";
  next.approvedAt = input.approvedAt;
  next.revision = schedule.revision + 1;
  return next;
}

export function serializeScheduleDraft(schedule: ScheduleSnapshot, activeDayId?: string): string {
  const pointer: ScheduleDraftPointer = {
    schema: "schedule-draft-pointer/v1",
    workspaceId: schedule.workspaceId,
    eventId: schedule.eventId,
    revision: schedule.revision,
    planVersionId: schedule.planVersionId,
    planFingerprint: schedule.planFingerprint,
    acceptedInventoryFingerprint: schedule.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: schedule.cfpSessionInventoryFingerprint,
    cfpSessionAuthorities: schedule.cfpSessionAuthorities.map((authority) => ({
      programUnitId: authority.programUnitId,
      sessionFingerprint: authority.sessionFingerprint,
      linkFingerprints: [...authority.linkFingerprints],
    })),
    activeDayId: activeDayId && schedule.days.some((day) => day.id === activeDayId) ? activeDayId : undefined,
    rooms: schedule.rooms.map(({ id, name, venue, capacity }) => ({ id, name, venue, capacity })),
    tracks: schedule.tracks.map(({ id, name, ordinal }) => ({ id, name, ordinal })),
    placements: schedule.sessions
      .map((session) => ({ sessionId: session.id, placement: clone(session.placement) }))
      .sort((first, second) => first.sessionId.localeCompare(second.sessionId)),
  };
  return JSON.stringify(pointer);
}

function isDraftRoom(value: unknown): value is Pick<ScheduleRoom, "id" | "name" | "venue" | "capacity"> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const room = value as Partial<ScheduleRoom>;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.every((key) => ["id", "name", "venue", "capacity"].includes(key))
    && typeof room.id === "string"
    && typeof room.name === "string"
    && typeof room.venue === "string"
    && Number.isSafeInteger(room.capacity);
}

function isDraftTrack(value: unknown): value is Pick<ScheduleTrack, "id" | "name" | "ordinal"> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const track = value as Partial<ScheduleTrack>;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.every((key) => ["id", "name", "ordinal"].includes(key))
    && typeof track.id === "string"
    && typeof track.name === "string"
    && Number.isSafeInteger(track.ordinal);
}

function isDraftPlacement(value: unknown): value is SchedulePlacement | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const placement = value as Partial<SchedulePlacement>;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.every((key) => ["dayId", "timeSlotId", "roomId", "trackId", "startsAt", "endsAt"].includes(key))
    && typeof placement.dayId === "string"
    && typeof placement.timeSlotId === "string"
    && typeof placement.roomId === "string"
    && typeof placement.trackId === "string"
    && typeof placement.startsAt === "string"
    && typeof placement.endsAt === "string";
}

function isCfpSessionAuthority(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const authority = value as Record<string, unknown>;
  if (
    Object.keys(authority).length !== 3 ||
    !Object.hasOwn(authority, "programUnitId") ||
    !Object.hasOwn(authority, "sessionFingerprint") ||
    !Object.hasOwn(authority, "linkFingerprints") ||
    typeof authority.programUnitId !== "string" ||
    authority.programUnitId.length === 0 ||
    authority.programUnitId.length > 160 ||
    typeof authority.sessionFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(authority.sessionFingerprint) ||
    !Array.isArray(authority.linkFingerprints) ||
    authority.linkFingerprints.length < 1 ||
    authority.linkFingerprints.length > 200 ||
    authority.linkFingerprints.some((fingerprint) =>
      typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)
    )
  ) {
    return false;
  }
  const fingerprints = authority.linkFingerprints as string[];
  return new Set(fingerprints).size === fingerprints.length &&
    fingerprints.every((fingerprint, index) => index === 0 || fingerprints[index - 1]! < fingerprint);
}

export function parseScheduleDraftPointer(raw: string, scope: { workspaceId: string; eventId: string }): ScheduleDraftPointer | null {
  if (new TextEncoder().encode(raw).byteLength > 100_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Partial<ScheduleDraftPointer>;
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (!keys.every((key) => ["schema", "workspaceId", "eventId", "revision", "planVersionId", "planFingerprint", "acceptedInventoryFingerprint", "cfpSessionInventoryFingerprint", "cfpSessionAuthorities", "activeDayId", "rooms", "tracks", "placements"].includes(key))) return null;
  if (value.schema !== "schedule-draft-pointer/v1" || value.workspaceId !== scope.workspaceId || value.eventId !== scope.eventId) return null;
  if (
    typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    typeof value.planVersionId !== "string" || value.planVersionId.length === 0 || value.planVersionId.length > 160 ||
    typeof value.planFingerprint !== "string" || value.planFingerprint.length === 0 || value.planFingerprint.length > 160 ||
    typeof value.acceptedInventoryFingerprint !== "string" || value.acceptedInventoryFingerprint.length === 0 || value.acceptedInventoryFingerprint.length > 160 ||
    (value.cfpSessionInventoryFingerprint !== undefined &&
      (typeof value.cfpSessionInventoryFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.cfpSessionInventoryFingerprint))) ||
    !Array.isArray(value.placements) || value.placements.length > 200
  ) return null;
  if (value.activeDayId !== undefined && (typeof value.activeDayId !== "string" || value.activeDayId.length > 160)) return null;
  if (
    value.cfpSessionAuthorities !== undefined &&
    (!Array.isArray(value.cfpSessionAuthorities) ||
      value.cfpSessionAuthorities.length > 200 ||
      value.cfpSessionAuthorities.some((authority) => !isCfpSessionAuthority(authority)) ||
      new Set(value.cfpSessionAuthorities.map((authority) => authority.programUnitId)).size !== value.cfpSessionAuthorities.length ||
      value.cfpSessionAuthorities.some((authority, index) =>
        index > 0 && value.cfpSessionAuthorities![index - 1]!.programUnitId >= authority.programUnitId
      ))
  ) return null;
  if (
    (value.cfpSessionInventoryFingerprint === undefined) !== (value.cfpSessionAuthorities === undefined)
  ) return null;
  if (value.rooms !== undefined && (!Array.isArray(value.rooms) || value.rooms.length < 1 || value.rooms.length > MAX_CONFIGURED_RESOURCES || value.rooms.some((room) => !isDraftRoom(room)))) return null;
  if (value.tracks !== undefined && (!Array.isArray(value.tracks) || value.tracks.length < 1 || value.tracks.length > MAX_CONFIGURED_RESOURCES || value.tracks.some((track) => !isDraftTrack(track)))) return null;
  const sessionIds = new Set<string>();
  if (value.placements.some((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return true;
    const record = entry as Record<string, unknown>;
    if (!Object.keys(record).every((key) => ["sessionId", "placement"].includes(key))) return true;
    if (typeof record.sessionId !== "string" || record.sessionId.length === 0 || record.sessionId.length > 160 || sessionIds.has(record.sessionId)) return true;
    if (!isDraftPlacement(record.placement)) return true;
    sessionIds.add(record.sessionId);
    return false;
  })) return null;
  return clone(value as ScheduleDraftPointer);
}

export function applyScheduleDraftPointer(schedule: ScheduleSnapshot, pointer: ScheduleDraftPointer): ScheduleSnapshot {
  if (pointer.workspaceId !== schedule.workspaceId || pointer.eventId !== schedule.eventId) {
    throw new ScheduleCommandError("SCHEDULE_SCOPE_MISMATCH", "The saved schedule draft is outside the requested workspace and event scope.");
  }
  const pointerCfpAuthorities = pointer.cfpSessionAuthorities ?? [];
  const pointerCfpFingerprint = pointer.cfpSessionInventoryFingerprint ?? EMPTY_CFP_SESSION_INVENTORY_FINGERPRINT;
  const pointerCfpAuthorityJson = stableSerialize(pointerCfpAuthorities);
  const scheduleCfpAuthorityJson = stableSerialize(schedule.cfpSessionAuthorities);
  if (
    pointer.planVersionId !== schedule.planVersionId ||
    pointer.planFingerprint !== schedule.planFingerprint ||
    pointer.acceptedInventoryFingerprint !== schedule.acceptedInventoryFingerprint ||
    pointerCfpFingerprint !== schedule.cfpSessionInventoryFingerprint ||
    pointerCfpAuthorityJson !== scheduleCfpAuthorityJson
  ) {
    throw new ScheduleCommandError("SCHEDULE_CONTEXT_CONFLICT", "The saved schedule draft belongs to a different approved plan or accepted inventory.");
  }
  assertDraft(schedule);
  let next = cloneSchedule(schedule);
  if (pointer.rooms || pointer.tracks) {
    const rooms = pointer.rooms?.map((room) => ({
      ...room,
      internalNotes: next.rooms.find((candidate) => candidate.id === room.id)?.internalNotes,
    })) ?? next.rooms;
    const tracks = pointer.tracks ?? next.tracks;
    next = applyConfiguration(next, rooms, tracks);
  }
  for (const entry of pointer.placements) {
    const session = next.sessions.find((candidate) => candidate.id === entry.sessionId);
    if (!session) {
      throw new ScheduleCommandError("SESSION_NOT_FOUND", "The requested session is not in this event.");
    }
    if (entry.placement === null) {
      next = replacePlacement(next, session.id, null);
      continue;
    }
    const placement = ensureTarget(next, session, entry.placement);
    next = replacePlacement(next, session.id, placement);
  }
  assertResourceReferences(next);
  next.revision = Math.max(schedule.revision, pointer.revision);
  return next;
}

export function listScheduleDays(schedule: ScheduleSnapshot): ScheduleDay[] {
  return [...schedule.days].sort((first, second) => first.ordinal - second.ordinal || first.id.localeCompare(second.id));
}
