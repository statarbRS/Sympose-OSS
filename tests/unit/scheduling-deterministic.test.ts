import { describe, expect, it } from "vitest";

import {
  autoPlaceUnscheduledSessions,
  applyScheduleDraftPointer,
  clearScheduleConflict,
  cloneSchedule,
  configureSchedule,
  createSyntheticScheduleProjection,
  createSyntheticApprovedScheduleProjection,
  createSyntheticScheduleRepository,
  detectScheduleConflicts,
  moveSession,
  parseScheduleDraftPointer,
  ScheduleCommandError,
  scheduleContentFingerprint,
  serializeScheduleDraft,
  suggestConflictFreeMove,
} from "@/server/services/scheduling";

const scope = { workspaceId: "workspace-a", eventId: "event-a" };

describe("deterministic scheduling contract", () => {
  it("detects speaker and room overlaps with stable, explainable conflict records", () => {
    const schedule = createSyntheticScheduleProjection(scope);
    const conflicts = detectScheduleConflicts(schedule);

    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((conflict) => conflict.ruleKey)).toEqual([
      "ROOM_NO_OVERLAP",
      "SPEAKER_NO_OVERLAP",
    ]);
    expect(conflicts[0]?.explanation).toContain("hard constraint");
    expect(conflicts[0]?.suggestedActions[0]).toContain("Move");
    expect(detectScheduleConflicts(createSyntheticScheduleProjection(scope))).toEqual(conflicts);
  });

  it("moves without mutating the source draft and rejects stale revisions", () => {
    const schedule = createSyntheticScheduleProjection(scope);
    const target = suggestConflictFreeMove(schedule, "session-data");
    expect(target).not.toBeNull();

    const result = moveSession(schedule, {
      sessionId: "session-data",
      target: target!,
      expectedRevision: schedule.revision,
      reason: "Resolve speaker overlap",
    });

    expect(result.schedule.revision).toBe(schedule.revision + 1);
    expect(result.conflicts).toEqual([]);
    expect(schedule.sessions.find((session) => session.id === "session-data")?.placement?.timeSlotId).toBe("slot-d1-0900");
    expect(result.schedule.sessions.find((session) => session.id === "session-data")?.placement?.timeSlotId).toBe("slot-d1-1015");
    expect(() => moveSession(result.schedule, {
      sessionId: "session-data",
      target: target!,
      expectedRevision: schedule.revision,
    })).toThrowError(/revision is/);
  });

  it("keeps unit track authority separate from an organizer placement across tracks", () => {
    const schedule = createSyntheticScheduleProjection(scope);
    const session = schedule.sessions.find((candidate) => candidate.id === "session-data")!;
    const slot = schedule.timeSlots.find((candidate) => candidate.id === "slot-d1-1015")!;
    const targetTrack = schedule.tracks.find((candidate) => candidate.id !== session.trackId)!;
    const moved = moveSession(schedule, {
      sessionId: session.id,
      target: {
        dayId: slot.dayId,
        timeSlotId: slot.id,
        roomId: "room-forum",
        trackId: targetTrack.id,
      },
      expectedRevision: schedule.revision,
      reason: "Move this session to another track",
    }).schedule;
    const movedSession = moved.sessions.find((candidate) => candidate.id === session.id);
    expect(movedSession).toMatchObject({
      trackId: session.trackId,
      placement: { trackId: targetTrack.id },
    });

    const pointer = parseScheduleDraftPointer(serializeScheduleDraft(moved), scope);
    expect(pointer).not.toBeNull();
    expect(applyScheduleDraftPointer(schedule, pointer!).sessions.find((candidate) => candidate.id === session.id))
      .toMatchObject({ trackId: session.trackId, placement: { trackId: targetTrack.id } });
  });

  it("clears a named conflict by sending one placement to the unscheduled tray", () => {
    const schedule = createSyntheticScheduleProjection(scope);
    const conflict = detectScheduleConflicts(schedule).find((candidate) => candidate.ruleKey === "SPEAKER_NO_OVERLAP");
    expect(conflict).toBeDefined();

    const result = clearScheduleConflict(schedule, {
      conflictId: conflict!.id,
      sessionId: conflict!.sessionIds[0],
      expectedRevision: schedule.revision,
      reason: "Keep the opening session and clear its overlapping workshop",
    });

    expect(result.clearedSessionId).toBe(conflict!.sessionIds[0]);
    expect(result.schedule.sessions.find((session) => session.id === result.clearedSessionId)?.placement).toBeNull();
    expect(result.conflictsAfter).toEqual([]);
    expect(result.explanation).toContain("unscheduled tray");
  });

  it("places the unscheduled tray in deterministic priority/id order", () => {
    const first = autoPlaceUnscheduledSessions(createSyntheticScheduleProjection(scope), {
      expectedRevision: 1,
      reason: "Deterministic schedule draft placement",
    });
    const second = autoPlaceUnscheduledSessions(createSyntheticScheduleProjection(scope), {
      expectedRevision: 1,
      reason: "Deterministic schedule draft placement",
    });

    expect(first.change?.reason).toContain("Deterministic");
    expect(first.placedSessionIds).toEqual(["session-community"]);
    expect(first.schedule).toEqual(second.schedule);
    expect(first.schedule.sessions.find((session) => session.id === "session-community")?.placement).toMatchObject({
      dayId: "day-1",
      timeSlotId: "slot-d1-0900",
      roomId: "room-forum",
      trackId: "track-practice",
    });
    expect(first.conflicts.filter((conflict) => conflict.sessionIds.includes("session-community"))).toEqual([]);
    expect(first.conflicts).toHaveLength(2);
  });

  it("validates organizer room and track configuration as a draft command", () => {
    const schedule = createSyntheticScheduleProjection(scope);
    const rooms = schedule.rooms.map((room) => room.id === "room-hall" ? { ...room, name: "Main Hall", capacity: 260 } : { ...room });
    const tracks = schedule.tracks.map((track) => track.id === "track-main" ? { ...track, name: "Keynotes" } : { ...track });

    const result = configureSchedule(schedule, {
      rooms,
      tracks,
      expectedRevision: schedule.revision,
      reason: "Organizer configured the event layout",
    });

    expect(result.change.kind).toBe("CONFIGURE");
    expect(result.schedule.revision).toBe(schedule.revision + 1);
    expect(result.schedule.rooms.find((room) => room.id === "room-hall")?.name).toBe("Main Hall");
    expect(result.schedule.tracks.find((track) => track.id === "track-main")?.name).toBe("Keynotes");
    expect(schedule.rooms.find((room) => room.id === "room-hall")?.name).toBe("Harbor Hall");
    expect(result.conflicts).toHaveLength(2);
    expect(() => configureSchedule(schedule, {
      rooms: schedule.rooms.filter((room) => room.id !== "room-hall"),
      tracks: schedule.tracks,
      expectedRevision: schedule.revision,
    })).toThrowError(/cannot remove the room used/);
    expect(() => configureSchedule(createSyntheticApprovedScheduleProjection(scope), {
      rooms,
      tracks,
      expectedRevision: 1,
    })).toThrowError(/immutable/);
  });

  it("round-trips event-scoped browser draft configuration and active day", () => {
    const schedule = createSyntheticScheduleProjection(scope);
    const configured = configureSchedule(schedule, {
      rooms: schedule.rooms.map((room) => room.id === "room-forum" ? { ...room, name: "Forum East" } : { ...room }),
      tracks: schedule.tracks.map((track) => ({ ...track })),
      expectedRevision: schedule.revision,
    }).schedule;
    const raw = serializeScheduleDraft(configured, "day-2");
    const pointer = parseScheduleDraftPointer(raw, scope);
    expect(pointer?.activeDayId).toBe("day-2");
    expect(pointer?.rooms?.find((room) => room.id === "room-forum")).toMatchObject({ name: "Forum East", capacity: 80 });
    expect(pointer?.rooms?.find((room) => room.id === "room-forum")).not.toHaveProperty("internalNotes");

    const restored = applyScheduleDraftPointer(schedule, pointer!);
    expect(restored.revision).toBe(configured.revision);
    expect(restored.rooms.find((room) => room.id === "room-forum")?.name).toBe("Forum East");
    expect(restored.rooms.find((room) => room.id === "room-forum")?.internalNotes).toBe("Sponsor hold is internal.");
    expect(parseScheduleDraftPointer(raw, { workspaceId: "workspace-b", eventId: scope.eventId })).toBeNull();
    const approved = createSyntheticApprovedScheduleProjection(scope);
    const approvedPointer = parseScheduleDraftPointer(serializeScheduleDraft(approved), scope);
    expect(approvedPointer).not.toBeNull();
    expect(() => applyScheduleDraftPointer(approved, approvedPointer!)).toThrowError(/immutable/);
  });

  it("leaves a session unscheduled when every candidate has a room or speaker overlap", () => {
    const schedule = cloneSchedule(createSyntheticScheduleProjection(scope));
    const slot = schedule.timeSlots.find((candidate) => candidate.id === "slot-d1-0900")!;
    const trust = schedule.sessions.find((session) => session.id === "session-trust")!;
    const clinic = schedule.sessions.find((session) => session.id === "session-clinic")!;
    const community = schedule.sessions.find((session) => session.id === "session-community")!;
    const placementFor = (session: typeof trust, roomId: string) => ({
      dayId: slot.dayId,
      timeSlotId: slot.id,
      roomId,
      trackId: session.trackId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    });

    schedule.days = schedule.days.filter((day) => day.id === slot.dayId);
    schedule.timeSlots = [slot];
    schedule.rooms = schedule.rooms.filter((room) => room.id === "room-forum" || room.id === "room-studio");
    schedule.sessions = [
      { ...trust, speakerIds: ["speaker-alex"], placement: placementFor(trust, "room-forum") },
      { ...clinic, speakerIds: ["speaker-priya"], placement: placementFor(clinic, "room-studio") },
      { ...community, speakerIds: ["speaker-alex"], placement: null },
    ];
    schedule.planFingerprint = scheduleContentFingerprint(schedule);
    const before = scheduleContentFingerprint(schedule);

    const result = autoPlaceUnscheduledSessions(schedule, {
      expectedRevision: schedule.revision,
      reason: "Test impossible schedule",
    });

    expect(result.placedSessionIds).toEqual([]);
    expect(result.unplacedSessionIds).toEqual(["session-community"]);
    expect(result.change).toBeNull();
    expect(result.schedule.revision).toBe(schedule.revision);
    expect(result.schedule.sessions.find((session) => session.id === "session-community")?.placement).toBeNull();
    expect(detectScheduleConflicts(result.schedule)).toEqual([]);
    expect(scheduleContentFingerprint(schedule)).toBe(before);
  });

  it("rejects automatic placement against an approved snapshot", () => {
    const approved = createSyntheticApprovedScheduleProjection(scope);
    const before = scheduleContentFingerprint(approved);

    expect(() => autoPlaceUnscheduledSessions(approved, { expectedRevision: approved.revision })).toThrowError(/immutable/);
    expect(approved.status).toBe("APPROVED");
    expect(scheduleContentFingerprint(approved)).toBe(before);
  });

  it("keeps the repository adapter tenant-scoped and compare-and-swap based", () => {
    const repository = createSyntheticScheduleRepository(scope);
    const schedule = repository.readSchedule(scope)!;
    const moved = moveSession(schedule, {
      sessionId: "session-data",
      target: suggestConflictFreeMove(schedule, "session-data")!,
      expectedRevision: schedule.revision,
    }).schedule;

    expect(repository.readSchedule({ workspaceId: "workspace-b", eventId: scope.eventId })).toBeNull();
    expect(() => repository.writeSchedule({ workspaceId: "workspace-b", eventId: scope.eventId }, 1, moved)).toThrowError(ScheduleCommandError);
    expect(repository.writeSchedule(scope, schedule.revision, moved).revision).toBe(2);
    expect(() => repository.writeSchedule(scope, schedule.revision, moved)).toThrowError(/changed/);
  });

  it("preserves approved snapshots as immutable inputs for publication", () => {
    const draft = createSyntheticScheduleProjection(scope);
    const copy = cloneSchedule(draft);
    copy.sessions[0]!.title = "Changed only in a test copy";
    expect(draft.sessions[0]!.title).toBe("Trust is a schedule");
    expect(scheduleContentFingerprint(draft)).toBe(scheduleContentFingerprint(createSyntheticScheduleProjection(scope)));
  });
});
