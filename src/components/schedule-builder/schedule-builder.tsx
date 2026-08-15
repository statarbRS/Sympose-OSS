"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";

import {
  applyScheduleDraftPointer,
  autoPlaceUnscheduledSessions,
  clearScheduleConflict,
  configureSchedule,
  detectScheduleConflicts,
  listScheduleDays,
  moveSession,
  suggestConflictFreeMove,
  unscheduleSession,
} from "@/server/services/scheduling/deterministic";
import type {
  ScheduleConflict,
  ScheduleDraftActionResult,
  ScheduleDraftCommand,
  SchedulePlacementTarget,
  ScheduleRoom,
  ScheduleSession,
  ScheduleSnapshot,
  ScheduleTrack,
} from "@/server/services/scheduling/types";
import type {
  ScheduleApprovalActionResult,
  ScheduleApprovalEvidence,
} from "@/server/services/scheduling/approval";

import styles from "./schedule-builder.module.css";

function firstDay(schedule: ScheduleSnapshot): string {
  return listScheduleDays(schedule)[0]?.id ?? "";
}

function orderedSlots(schedule: ScheduleSnapshot, dayId: string) {
  return schedule.timeSlots
    .filter((slot) => slot.dayId === dayId)
    .sort((first, second) => first.ordinal - second.ordinal || first.id.localeCompare(second.id));
}

function initialPlacementTarget(
  schedule: ScheduleSnapshot,
  sessionId: string,
  preferredDayId?: string,
): SchedulePlacementTarget | null {
  const session = schedule.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;
  if (session.placement) {
    return {
      dayId: session.placement.dayId,
      timeSlotId: session.placement.timeSlotId,
      roomId: session.placement.roomId,
      trackId: session.placement.trackId,
    };
  }
  const dayId = schedule.days.some((day) => day.id === preferredDayId) ? preferredDayId! : firstDay(schedule);
  const slot = orderedSlots(schedule, dayId)[0] ?? schedule.timeSlots[0];
  const room = schedule.rooms[0];
  const track = schedule.tracks.find((candidate) => candidate.id === session.trackId) ?? schedule.tracks[0];
  if (!slot || !room || !track) return null;
  return { dayId: slot.dayId, timeSlotId: slot.id, roomId: room.id, trackId: track.id };
}

function speakerNames(schedule: ScheduleSnapshot, session: ScheduleSession): string {
  return session.speakerIds
    .map((speakerId) => schedule.speakers.find((speaker) => speaker.id === speakerId)?.displayName)
    .filter((name): name is string => Boolean(name))
    .join(", ");
}

function conflictSession(schedule: ScheduleSnapshot, conflict: ScheduleConflict, index: 0 | 1): ScheduleSession {
  return schedule.sessions.find((session) => session.id === conflict.sessionIds[index]) ?? schedule.sessions[0]!;
}

function sessionTitles(schedule: ScheduleSnapshot, sessionIds: string[]): string {
  return sessionIds
    .map((sessionId) => schedule.sessions.find((session) => session.id === sessionId)?.title)
    .filter((title): title is string => Boolean(title))
    .join(", ");
}

function placementLabel(schedule: ScheduleSnapshot, session: ScheduleSession): string {
  if (!session.placement) return "Unscheduled · needs a time and room";
  const day = schedule.days.find((candidate) => candidate.id === session.placement?.dayId);
  const slot = schedule.timeSlots.find((candidate) => candidate.id === session.placement?.timeSlotId);
  const room = schedule.rooms.find((candidate) => candidate.id === session.placement?.roomId);
  return [day?.label, slot?.label, room?.name].filter((value): value is string => Boolean(value)).join(" · ");
}

function nextResourceId(prefix: "room" | "track", resources: Array<{ id: string }>): string {
  let index = 1;
  while (resources.some((resource) => resource.id === `${prefix}-custom-${index}`)) index += 1;
  return `${prefix}-custom-${index}`;
}

function resourceMoveMessage(resultConflicts: ScheduleConflict[], sessionTitle: string, verb: "Placed" | "Moved"): string {
  const conflictText = resultConflicts.length > 0
    ? ` ${resultConflicts.length} hard conflict${resultConflicts.length === 1 ? " remains" : "s remain"} for organizer review.`
    : " No hard conflicts remain for this placement.";
  return `${verb} “${sessionTitle}”.${conflictText}`;
}

type PersistenceState = "not-saved" | "saved" | "saving" | "error";

let clientRequestSequence = 0;

function requestToken(prefix: string): string {
  clientRequestSequence += 1;
  const random = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${random ?? `${Date.now()}-${clientRequestSequence}`}`;
}

function persistenceLabel(state: PersistenceState): string {
  if (state === "saving") return "Saving to server…";
  if (state === "saved") return "Saved to server";
  if (state === "error") return "Save error";
  return "Not saved yet";
}

export function ScheduleBuilder({
  initialSchedule,
  initialPersistence,
  initialScheduleAuthorityFingerprint,
  initialApproval,
  saveDraftAction,
  approveDraftAction,
  workspaceSlug,
}: {
  initialSchedule: ScheduleSnapshot;
  initialPersistence: Exclude<PersistenceState, "saving" | "error">;
  initialScheduleAuthorityFingerprint: string | null;
  initialApproval: ScheduleApprovalEvidence | null;
  saveDraftAction: (formData: FormData) => Promise<ScheduleDraftActionResult>;
  approveDraftAction: (formData: FormData) => Promise<ScheduleApprovalActionResult>;
  workspaceSlug: string;
}) {
  const [schedule, setSchedule] = useState<ScheduleSnapshot>(initialSchedule);
  const [notice, setNotice] = useState<string | null>(null);
  const [persistenceState, setPersistenceState] = useState<PersistenceState>(initialPersistence);
  const [scheduleAuthorityFingerprint, setScheduleAuthorityFingerprint] = useState<string | null>(
    initialScheduleAuthorityFingerprint,
  );
  const latestSaveRef = useRef(0);
  const latestApprovalRef = useRef(0);
  const [approval, setApproval] = useState<ScheduleApprovalEvidence | null>(initialApproval);
  const [approvalPending, setApprovalPending] = useState(false);
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const [activeDayId, setActiveDayId] = useState(() => firstDay(initialSchedule));
  const [showConfiguration, setShowConfiguration] = useState(true);
  const [roomDrafts, setRoomDrafts] = useState<ScheduleRoom[]>(() => initialSchedule.rooms.map((room) => ({ ...room })));
  const [trackDrafts, setTrackDrafts] = useState<ScheduleTrack[]>(() => initialSchedule.tracks.map((track) => ({ ...track })));
  const firstSessionId = initialSchedule.sessions.find((session) => !session.placement)?.id ?? initialSchedule.sessions[0]?.id ?? "";
  const initialTarget = initialPlacementTarget(initialSchedule, firstSessionId, firstDay(initialSchedule));
  const [placementSessionId, setPlacementSessionId] = useState(firstSessionId);
  const [placementDayId, setPlacementDayId] = useState(initialTarget?.dayId ?? firstDay(initialSchedule));
  const [placementTimeSlotId, setPlacementTimeSlotId] = useState(initialTarget?.timeSlotId ?? "");
  const [placementRoomId, setPlacementRoomId] = useState(initialTarget?.roomId ?? initialSchedule.rooms[0]?.id ?? "");
  const [placementTrackId, setPlacementTrackId] = useState(initialTarget?.trackId ?? initialSchedule.tracks[0]?.id ?? "");
  const [roomFilterId, setRoomFilterId] = useState("all");
  const [trackFilterId, setTrackFilterId] = useState("all");

  const days = useMemo(() => listScheduleDays(schedule), [schedule]);
  const conflicts = useMemo(() => detectScheduleConflicts(schedule), [schedule]);
  const unscheduled = useMemo(() => schedule.sessions.filter((session) => session.placement === null), [schedule]);
  const activeDayIndex = Math.max(0, days.findIndex((day) => day.id === activeDayId));
  const activeDay = days[activeDayIndex] ?? days[0];
  const activeSlots = activeDay ? orderedSlots(schedule, activeDay.id) : [];
  const visibleRooms = schedule.rooms.filter((room) => roomFilterId === "all" || room.id === roomFilterId);
  const placementSession = schedule.sessions.find((session) => session.id === placementSessionId);
  const placementSlots = orderedSlots(schedule, placementDayId);
  const conflictsBySession = useMemo(() => {
    const grouped = new Map<string, ScheduleConflict[]>();
    conflicts.forEach((conflict) => {
      conflict.sessionIds.forEach((sessionId) => {
        const current = grouped.get(sessionId) ?? [];
        current.push(conflict);
        grouped.set(sessionId, current);
      });
    });
    return grouped;
  }, [conflicts]);
  const approvalIsCurrent = approval !== null &&
    scheduleAuthorityFingerprint !== null &&
    approval.scheduleAuthorityFingerprint === scheduleAuthorityFingerprint &&
    approval.scheduleRevision === schedule.revision &&
    approval.sourcePlanVersionId === schedule.planVersionId &&
    approval.sourcePlanFingerprint === schedule.planFingerprint &&
    approval.acceptedInventoryFingerprint === schedule.acceptedInventoryFingerprint &&
    approval.cfpSessionInventoryFingerprint === schedule.cfpSessionInventoryFingerprint;
  const approvalBlocked = persistenceState !== "saved" || scheduleAuthorityFingerprint === null ||
    conflicts.length > 0 || unscheduled.length > 0;

  useEffect(() => {
    const baseDayId = firstDay(initialSchedule);
    const baseSessionId = initialSchedule.sessions.find((session) => !session.placement)?.id ?? initialSchedule.sessions[0]?.id ?? "";
    setSchedule(initialSchedule);
    setRoomDrafts(initialSchedule.rooms.map((room) => ({ ...room })));
    setTrackDrafts(initialSchedule.tracks.map((track) => ({ ...track })));
    setPlacementSessionId(baseSessionId);
    setActiveDayId(baseDayId);
    setRoomFilterId("all");
    setTrackFilterId("all");
    setPersistenceState(initialPersistence);
    setScheduleAuthorityFingerprint(initialScheduleAuthorityFingerprint);
    setApproval(initialApproval);
    setApprovalPending(false);
    setApprovalNotice(null);
    latestSaveRef.current += 1;
    latestApprovalRef.current += 1;
    const baseTarget = initialPlacementTarget(initialSchedule, baseSessionId, baseDayId);
    if (baseTarget) {
      setPlacementDayId(baseTarget.dayId);
      setPlacementTimeSlotId(baseTarget.timeSlotId);
      setPlacementRoomId(baseTarget.roomId);
      setPlacementTrackId(baseTarget.trackId);
    }
  }, [initialApproval, initialPersistence, initialSchedule, initialScheduleAuthorityFingerprint]);

  useEffect(() => {
    if (days.some((day) => day.id === activeDayId)) return;
    setActiveDayId(days[0]?.id ?? "");
  }, [activeDayId, days]);

  useEffect(() => {
    const target = initialPlacementTarget(schedule, placementSessionId, placementDayId);
    if (!target) return;
    setPlacementDayId(target.dayId);
    setPlacementTimeSlotId(target.timeSlotId);
    setPlacementRoomId(target.roomId);
    setPlacementTrackId(target.trackId);
  }, [placementSessionId, schedule]);

  useEffect(() => {
    if (roomFilterId !== "all" && !schedule.rooms.some((room) => room.id === roomFilterId)) setRoomFilterId("all");
    if (trackFilterId !== "all" && !schedule.tracks.some((track) => track.id === trackFilterId)) setTrackFilterId("all");
  }, [roomFilterId, schedule.rooms, schedule.tracks, trackFilterId]);

  function syncAuthoritativeSchedule(pointer: ScheduleDraftActionResult["pointer"]): void {
    try {
      const authoritative = pointer
        ? applyScheduleDraftPointer(initialSchedule, pointer)
        : initialSchedule;
      const selectedSessionId = authoritative.sessions.find((session) => !session.placement)?.id ?? authoritative.sessions[0]?.id ?? "";
      const selectedTarget = initialPlacementTarget(
        authoritative,
        selectedSessionId,
        pointer?.activeDayId ?? firstDay(authoritative),
      );
      setSchedule(authoritative);
      setRoomDrafts(authoritative.rooms.map((room) => ({ ...room })));
      setTrackDrafts(authoritative.tracks.map((track) => ({ ...track })));
      setActiveDayId(
        pointer?.activeDayId && authoritative.days.some((day) => day.id === pointer.activeDayId)
          ? pointer.activeDayId
          : firstDay(authoritative),
      );
      setPlacementSessionId(selectedSessionId);
      if (selectedTarget) {
        setPlacementDayId(selectedTarget.dayId);
        setPlacementTimeSlotId(selectedTarget.timeSlotId);
        setPlacementRoomId(selectedTarget.roomId);
        setPlacementTrackId(selectedTarget.trackId);
      }
    } catch {
      setSchedule(initialSchedule);
      setRoomDrafts(initialSchedule.rooms.map((room) => ({ ...room })));
      setTrackDrafts(initialSchedule.tracks.map((track) => ({ ...track })));
      setActiveDayId(firstDay(initialSchedule));
    }
  }

  function persistDraft(
    next: ScheduleSnapshot,
    command: ScheduleDraftCommand,
    successMessage: string,
    dayId = activeDayId,
  ): void {
    const requestNumber = latestSaveRef.current + 1;
    latestSaveRef.current = requestNumber;
    const formData = new FormData();
    formData.set("eventId", next.eventId);
    formData.set("expectedRevision", String(next.revision - 1));
    formData.set("planVersionId", next.planVersionId);
    formData.set("planFingerprint", next.planFingerprint);
    formData.set("acceptedInventoryFingerprint", next.acceptedInventoryFingerprint);
    formData.set("cfpSessionInventoryFingerprint", next.cfpSessionInventoryFingerprint);
    formData.set("command", JSON.stringify(command));
    formData.set("idempotencyKey", requestToken("schedule"));
    formData.set("requestId", requestToken("request"));
    if (dayId) formData.set("activeDayId", dayId);
    setPersistenceState("saving");
    setNotice("Saving schedule draft to the server…");
    void saveDraftAction(formData).then((result) => {
      if (requestNumber !== latestSaveRef.current) return;
      if (result.ok) {
        syncAuthoritativeSchedule(result.pointer);
        setScheduleAuthorityFingerprint(result.scheduleAuthorityFingerprint);
        setPersistenceState("saved");
        setNotice(result.code === "SCHEDULE_DRAFT_UNCHANGED" ? "The server already had this schedule draft." : successMessage);
        return;
      }
      syncAuthoritativeSchedule(result.pointer ?? null);
      setScheduleAuthorityFingerprint(null);
      setPersistenceState("error");
      setNotice(result.message);
    }).catch(() => {
      if (requestNumber !== latestSaveRef.current) return;
      syncAuthoritativeSchedule(null);
      setScheduleAuthorityFingerprint(null);
      setPersistenceState("error");
      setNotice("The schedule draft could not be saved. Try again.");
    });
  }

  function commit(next: ScheduleSnapshot, message: string, command: ScheduleDraftCommand, dayId = activeDayId): void {
    setSchedule(next);
    setRoomDrafts(next.rooms.map((room) => ({ ...room })));
    setTrackDrafts(next.tracks.map((track) => ({ ...track })));
    setNotice(message);
    persistDraft(next, command, message, dayId);
  }

  function approveCurrentSchedule(): void {
    if (approvalBlocked || approvalPending || approvalIsCurrent) return;
    const requestNumber = latestApprovalRef.current + 1;
    latestApprovalRef.current = requestNumber;
    const formData = new FormData();
    formData.set("eventId", schedule.eventId);
    formData.set("expectedRevision", String(schedule.revision));
    formData.set("expectedScheduleAuthorityFingerprint", scheduleAuthorityFingerprint!);
    formData.set("idempotencyKey", requestToken(`schedule-approval-${schedule.revision}`));
    formData.set("requestId", requestToken("schedule-approval-request"));
    setApprovalPending(true);
    setApprovalNotice("Recording the exact organizer approval…");
    void approveDraftAction(formData).then((result) => {
      if (requestNumber !== latestApprovalRef.current) return;
      setApprovalPending(false);
      if (!result.ok) {
        setApprovalNotice(result.message);
        return;
      }
      setApproval(result.approval);
      setApprovalNotice(result.code === "SCHEDULE_ALREADY_APPROVED"
        ? "This exact schedule revision was already approved."
        : "Exact schedule approval recorded. Publication can now seal this lineage.");
    }).catch(() => {
      if (requestNumber !== latestApprovalRef.current) return;
      setApprovalPending(false);
      setApprovalNotice("The schedule approval could not be recorded. Reload and try again.");
    });
  }

  function selectDay(dayId: string): void {
    setActiveDayId(dayId);
  }

  function selectPlacementSession(sessionId: string): void {
    setPlacementSessionId(sessionId);
    const target = initialPlacementTarget(schedule, sessionId, activeDayId);
    if (!target) return;
    setPlacementDayId(target.dayId);
    setPlacementTimeSlotId(target.timeSlotId);
    setPlacementRoomId(target.roomId);
    setPlacementTrackId(target.trackId);
  }

  function moveToTarget(sessionId: string, target: SchedulePlacementTarget, reason: string, dayId = target.dayId): void {
    const session = schedule.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      setNotice("The requested session is not in this event.");
      return;
    }
    try {
      const result = moveSession(schedule, {
        sessionId,
        target,
        expectedRevision: schedule.revision,
        reason,
      });
      commit(
        result.schedule,
        resourceMoveMessage(result.conflicts, session.title, session.placement ? "Moved" : "Placed"),
        { kind: "MOVE", sessionId, target, reason },
        dayId,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The schedule move was rejected.");
    }
  }

  function submitPlacement(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!placementSessionId || !placementDayId || !placementTimeSlotId || !placementRoomId || !placementTrackId) {
      setNotice("Choose a session, day, time, room, and track before placing it.");
      return;
    }
    moveToTarget(
      placementSessionId,
      {
        dayId: placementDayId,
        timeSlotId: placementTimeSlotId,
        roomId: placementRoomId,
        trackId: placementTrackId,
      },
      "Organizer-selected direct placement",
    );
  }

  function clearSelectedPlacement(): void {
    if (!placementSessionId) return;
    const session = schedule.sessions.find((candidate) => candidate.id === placementSessionId);
    if (!session?.placement) {
      setNotice("This session is already in the unscheduled tray.");
      return;
    }
    try {
      const result = unscheduleSession(schedule, {
        sessionId: session.id,
        expectedRevision: schedule.revision,
        reason: "Organizer returned session to the unscheduled tray",
      });
      commit(result.schedule, `Returned “${session.title}” to the unscheduled tray.`, {
        kind: "CLEAR",
        sessionId: session.id,
        reason: "Organizer returned session to the unscheduled tray",
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The session could not be returned to the tray.");
    }
  }

  function moveConflictSession(sessionId: string): void {
    const target = suggestConflictFreeMove(schedule, sessionId);
    if (!target) {
      setNotice("No conflict-free compatible placement is available for this session.");
      return;
    }
    moveToTarget(sessionId, target, "Organizer-selected conflict repair");
  }

  function clearConflict(conflict: ScheduleConflict): void {
    const session = conflictSession(schedule, conflict, 1);
    try {
      const result = clearScheduleConflict(schedule, {
        conflictId: conflict.id,
        sessionId: session.id,
        expectedRevision: schedule.revision,
        reason: `Clear ${conflict.ruleKey} conflict by returning the later session to the tray`,
      });
      commit(result.schedule, result.explanation, {
        kind: "CLEAR_CONFLICT",
        conflictId: conflict.id,
        sessionId: session.id,
        reason: `Clear ${conflict.ruleKey} conflict by returning the later session to the tray`,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The conflict could not be cleared.");
    }
  }

  function autoPlace(): void {
    try {
      const result = autoPlaceUnscheduledSessions(schedule, {
        expectedRevision: schedule.revision,
        reason: "Deterministic placement of unscheduled sessions",
      });
      if (!result.change) {
        setNotice(`Auto-schedule found no conflict-free room/time slot for ${sessionTitles(schedule, result.unplacedSessionIds)}. Those sessions remain in the unscheduled tray.`);
        return;
      }
      const placed = sessionTitles(schedule, result.placedSessionIds);
      const remaining = result.unplacedSessionIds.length > 0
        ? ` ${sessionTitles(schedule, result.unplacedSessionIds)} remain in the tray.`
        : " All unscheduled sessions now have a placement.";
      const conflictText = result.conflicts.length > 0
        ? ` ${result.conflicts.length} existing hard conflict${result.conflicts.length === 1 ? " remains" : "s remain"} still require review.`
        : " No hard conflicts remain.";
      commit(result.schedule, `Auto-scheduled ${placed}.${remaining}${conflictText}`, {
        kind: "AUTO_PLACE",
        reason: "Deterministic placement of unscheduled sessions",
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Deterministic placement was rejected.");
    }
  }

  function saveConfiguration(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      const result = configureSchedule(schedule, {
        rooms: roomDrafts,
        tracks: trackDrafts,
        expectedRevision: schedule.revision,
        reason: "Organizer configured event rooms and tracks",
      });
      commit(result.schedule, "Saved room and track configuration to this event’s server draft.", {
        kind: "CONFIGURE",
        rooms: roomDrafts.map(({ id, name, venue, capacity }) => ({ id, name, venue, capacity })),
        tracks: trackDrafts.map(({ id, name, ordinal }) => ({ id, name, ordinal })),
        reason: "Organizer configured event rooms and tracks",
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The room and track configuration was rejected.");
    }
  }

  function addRoom(): void {
    setRoomDrafts((current) => [
      ...current,
      {
        id: nextResourceId("room", current),
        name: `Room ${current.length + 1}`,
        venue: "Organizer configured",
        capacity: 60,
      },
    ]);
  }

  function addTrack(): void {
    setTrackDrafts((current) => [
      ...current,
      { id: nextResourceId("track", current), name: `Track ${current.length + 1}`, ordinal: current.length + 1 },
    ]);
  }

  function handleDragStart(event: DragEvent<HTMLElement>, sessionId: string): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sessionId);
    selectPlacementSession(sessionId);
  }

  function handleDrop(event: DragEvent<HTMLElement>, dayId: string, timeSlotId: string, roomId: string): void {
    event.preventDefault();
    const sessionId = event.dataTransfer.getData("text/plain");
    if (!sessionId) return;
    const session = schedule.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    moveToTarget(
      sessionId,
      { dayId, timeSlotId, roomId, trackId: (session.placement?.trackId ?? session.trackId) || schedule.tracks[0]?.id || "" },
      "Organizer drag-and-drop placement",
      dayId,
    );
  }

  const dropProps = (dayId: string, timeSlotId: string, roomId: string) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => event.preventDefault(),
    onDrop: (event: DragEvent<HTMLElement>) => handleDrop(event, dayId, timeSlotId, roomId),
  });

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar} aria-label="Schedule commands">
        <div className={styles.toolbarLead}>
          <span className={styles.eyebrow}>Plan Studio · schedule draft</span>
          <strong>{schedule.event.name}</strong>
          <span className={styles.toolbarSubline}>{schedule.event.timezone} · candidate draft · revision {schedule.revision}</span>
        </div>
        <div className={styles.toolbarActions}>
          <button className={`${styles.button} ${styles.buttonPrimary}`} type="button" data-testid="auto-schedule-control" onClick={autoPlace} disabled={unscheduled.length === 0}>
            {unscheduled.length > 0 ? `Auto-schedule available sessions (${unscheduled.length})` : "Auto-schedule unavailable · all sessions are placed"}
          </button>
          <a className={`${styles.button} ${styles.mobileParityLink}`} href="#placement-controls-title">
            Move without dragging
          </a>
        </div>
        <div className={styles.toolbarStatus}>
          <span className={styles.persistenceBadge} data-persistence-state={persistenceState} data-testid="schedule-persistence-status">{persistenceLabel(persistenceState)} · scoped to this workspace and event</span>
          <p className={styles.note}>Auto-schedule is a repeatable rule over fixed slots and rooms. It is not an AI decision, approval, or publication.</p>
        </div>
      </div>

      {notice ? <div className={styles.notice} role="status" data-testid="schedule-builder-result">{notice}</div> : null}

      <div className={styles.overviewRow}>
        <div>
          <span className={styles.eyebrow}>Event schedule</span>
          <h2>Shape the program in space</h2>
          <p className={styles.note}>Place real program sessions against fixed time slots and rooms. Every move remains a candidate draft until a separate approval decision.</p>
        </div>
        <span className={styles.revisionChip}>Draft · revision {schedule.revision}</span>
      </div>

      <dl className={styles.summary} aria-label="Schedule summary">
        <div><dt>Days</dt><dd>{schedule.days.length}</dd><span>event dates</span></div>
        <div><dt>Rooms</dt><dd>{schedule.rooms.length}</dd><span>available spaces</span></div>
        <div><dt>Tracks</dt><dd>{schedule.tracks.length}</dd><span>program lanes</span></div>
        <div><dt>Sessions placed</dt><dd>{schedule.sessions.length - unscheduled.length}</dd><span>of {schedule.sessions.length} total</span></div>
        <div className={conflicts.length > 0 ? styles.summaryAlert : undefined}><dt>Hard conflicts</dt><dd className={conflicts.length > 0 ? styles.alert : undefined}>{conflicts.length}</dd><span>{conflicts.length > 0 ? "needs review" : "clear to review"}</span></div>
      </dl>

      <div className={styles.builderLayout}>
        <div className={styles.workspaceColumn}>
          <section className={`${styles.section} ${styles.scheduleCanvas}`} aria-labelledby="schedule-grid-title">
            <div className={styles.sectionHeader}>
              <div>
                <span className={styles.eyebrow}>Spatial canvas</span>
                <h2 id="schedule-grid-title">Multi-day schedule</h2>
                <p className={styles.note}>Drag a session into a room and time slot, or select one and use the placement inspector. Conflicts stay visible on the canvas.</p>
              </div>
              {activeDay ? <div className={styles.canvasMeta}><strong>{activeDay.label}</strong><span>{activeDay.date} · {activeSlots.length} time slots</span></div> : null}
            </div>

            <div className={styles.stickyToolbar} aria-label="Schedule day and track toolbar">
              <div className={styles.dayNavigation} aria-label="Schedule day navigation">
                <button className={`${styles.button} ${styles.dayNavButton}`} type="button" onClick={() => days[activeDayIndex - 1] && selectDay(days[activeDayIndex - 1]!.id)} disabled={activeDayIndex <= 0}>Previous day</button>
                <div className={styles.dayTabs} role="tablist" aria-label="Event days">
                  {days.map((day) => <button className={`${styles.dayTab} ${day.id === activeDay?.id ? styles.dayTabActive : ""}`} key={day.id} type="button" role="tab" aria-selected={day.id === activeDay?.id} onClick={() => selectDay(day.id)} data-testid={`schedule-day-${day.id}`}>
                    <span>{day.label}</span><small>{day.date}</small>
                  </button>)}
                </div>
                <button className={`${styles.button} ${styles.dayNavButton}`} type="button" onClick={() => days[activeDayIndex + 1] && selectDay(days[activeDayIndex + 1]!.id)} disabled={activeDayIndex >= days.length - 1}>Next day</button>
              </div>
              <div className={styles.filterToolbar} aria-label="Schedule view filters">
                <label htmlFor="schedule-room-filter">Show room
                  <select id="schedule-room-filter" value={roomFilterId} onChange={(event) => setRoomFilterId(event.target.value)}>
                    <option value="all">All rooms</option>
                    {schedule.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                  </select>
                </label>
                <label htmlFor="schedule-track-filter">Show track
                  <select id="schedule-track-filter" value={trackFilterId} onChange={(event) => setTrackFilterId(event.target.value)}>
                    <option value="all">All tracks</option>
                    {schedule.tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
                  </select>
                </label>
                <span className={styles.filterSummary}>{visibleRooms.length} rooms visible · {trackFilterId === "all" ? "all tracks" : schedule.tracks.find((track) => track.id === trackFilterId)?.name} · Visible rows are a view filter; the schedule and conflict count remain event-scoped.</span>
              </div>
            </div>

            {activeDay ? <div className={styles.day} data-testid={`active-schedule-day-${activeDay.id}`}>
              <div className={styles.gridLegend} aria-label="Schedule legend">
                <span><i className={`${styles.legendDot} ${styles.legendDotOpen}`} aria-hidden="true" />Open placement</span>
                <span><i className={`${styles.legendDot} ${styles.legendDotSelected}`} aria-hidden="true" />Selected session</span>
                <span><i className={`${styles.legendDot} ${styles.legendDotConflict}`} aria-hidden="true" />Hard conflict</span>
              </div>
              <div className={styles.tableWrap} role="region" aria-label={`${activeDay.label} schedule grid. Scroll horizontally for every room.`} tabIndex={0}><table className={styles.table}><caption className="visually-hidden">{activeDay.label} schedule by time slot and room. Each cell accepts a dragged session.</caption><thead><tr><th scope="col" className={styles.timeHeader}>Time</th>{visibleRooms.map((room) => <th scope="col" key={room.id}><div className={styles.roomHeader}><strong>{room.name}</strong><span>{room.venue} · {room.capacity} seats</span></div></th>)}</tr></thead><tbody>
                {activeSlots.map((slot) => <tr key={slot.id}>
                  <th scope="row" className={styles.timeCell}><strong>{slot.label}</strong><span>{slot.startsAt.split("T")[1]?.slice(0, 5) ?? ""}</span></th>
                  {visibleRooms.map((room) => {
                    const allSessions = schedule.sessions.filter((session) => session.placement?.dayId === activeDay.id && session.placement.timeSlotId === slot.id && session.placement.roomId === room.id);
                    const sessions = allSessions.filter((session) => trackFilterId === "all" || session.placement?.trackId === trackFilterId);
                    const cellConflicts = allSessions.flatMap((session) => conflictsBySession.get(session.id) ?? []).filter((conflict, index, list) => list.findIndex((candidate) => candidate.id === conflict.id) === index);
                    const drop = dropProps(activeDay.id, slot.id, room.id);
                    return <td className={`${styles.gridCell} ${cellConflicts.length > 0 ? styles.gridCellConflict : ""}`} key={room.id} {...drop} aria-label={`${slot.label}, ${room.name}${allSessions.length === 0 ? ", available placement" : `, ${allSessions.length} session${allSessions.length === 1 ? "" : "s"}`}`}>
                      <div className={styles.gridCellInner}>
                        {sessions.length === 0 ? <span className={styles.dropCell}>{allSessions.length > 0 ? "Session hidden by track filter" : "Available · drop a session here"}</span> : sessions.map((session) => {
                          const sessionConflicts = conflictsBySession.get(session.id) ?? [];
                          const track = schedule.tracks.find((candidate) => candidate.id === session.placement?.trackId);
                          return <article className={`${styles.sessionCard} ${placementSessionId === session.id ? styles.sessionCardSelected : ""} ${sessionConflicts.length > 0 ? styles.sessionCardConflict : ""}`} key={session.id} data-testid={`schedule-session-${session.id}`}>
                            <div className={styles.sessionCardBody}>
                              <div className={styles.sessionCardTop}><span className={styles.sessionTrack}>{track?.name ?? "Untracked"}</span>{sessionConflicts.length > 0 ? <span className={styles.conflictFlag} title={sessionConflicts.map((conflict) => conflict.ruleKey).join(", ")}>Conflict · {sessionConflicts.length}</span> : null}</div>
                              <button className={styles.sessionButton} type="button" draggable onDragStart={(event) => handleDragStart(event, session.id)} onClick={() => selectPlacementSession(session.id)}>
                                <strong>{session.title}</strong><span className={styles.sessionMeta}>{speakerNames(schedule, session) || "No speakers assigned"}</span>
                              </button>
                              <div className={styles.sessionCardFooter}><span>{session.durationMinutes} min · {session.capacity} seats</span><button className={styles.inlineButton} type="button" onClick={() => selectPlacementSession(session.id)}>Move session</button></div>
                              {sessionConflicts.length > 0 ? <div className={styles.inlineConflictList}>{sessionConflicts.map((conflict) => <span className={styles.inlineConflict} key={conflict.id} title={conflict.ruleKey} aria-label={`${conflict.ruleKey}: ${conflict.summary}`}>Hard conflict · {conflict.kind === "ROOM_OVERLAP" ? "room" : "speaker"}</span>)}</div> : null}
                            </div>
                          </article>;
                        })}
                      </div>
                    </td>;
                  })}
                </tr>)}
              </tbody></table></div>
            </div> : <p className={styles.note}>No event days are configured.</p>}
          </section>

          <section className={`${styles.section} ${styles.unscheduledTray}`} aria-labelledby="unscheduled-title">
            <div className={styles.sectionHeader}>
              <div>
                <span className={styles.eyebrow}>Needs a home</span>
                <h2 id="unscheduled-title">Unscheduled sessions</h2>
                <p className={styles.note}>Select a session here to load its placement controls. Cards are also draggable on pointer devices, but dragging is never required.</p>
              </div>
              <span className={styles.badge}>{unscheduled.length} in tray</span>
            </div>
            {unscheduled.length === 0 ? <p className={styles.emptyTray}>The unscheduled tray is empty.</p> : <ul className={styles.unscheduled}>
              {unscheduled.map((session) => <li className={`${styles.unscheduledItem} ${placementSessionId === session.id ? styles.unscheduledItemSelected : ""}`} key={session.id}>
                <div className={styles.trayItemCopy}>
                  <span className={styles.trayMarker} aria-hidden="true">+</span>
                  <button className={styles.sessionPicker} type="button" draggable onDragStart={(event) => handleDragStart(event, session.id)} onClick={() => selectPlacementSession(session.id)} aria-label={`Select ${session.title} for placement`}>
                    <strong>{session.title}</strong><span className={styles.note}>{speakerNames(schedule, session) || "No speakers assigned"} · {session.durationMinutes} minutes · {session.capacity} seats</span>
                  </button>
                </div>
                <button className={styles.button} type="button" onClick={() => selectPlacementSession(session.id)}>Choose placement</button>
              </li>)}
            </ul>}
          </section>

          {conflicts.length > 0 ? (
            <section className={`${styles.section} ${styles.conflictSection}`} aria-labelledby="schedule-conflicts-title">
              <div className={styles.sectionHeader}>
                <div>
                  <span className={styles.eyebrow}>Attention required</span>
                  <h2 id="schedule-conflicts-title">Explainable conflicts</h2>
                  <p className={styles.note}>Each conflict is a deterministic hard-constraint result. Clearing a conflict explicitly unschedules one named session; it does not rewrite the other placement.</p>
                </div>
                <span className={`${styles.badge} ${styles.badgeAlert}`}>{conflicts.length} hard conflict{conflicts.length === 1 ? "" : "s"}</span>
              </div>
              <ol className={styles.conflicts}>
                {conflicts.map((conflict) => {
                  const moveTarget = conflictSession(schedule, conflict, 1);
                  return <li className={styles.conflict} key={conflict.id}>
                    <header><div><span className={styles.conflictKicker}>{conflict.kind === "ROOM_OVERLAP" ? "Room overlap" : "Speaker overlap"}</span><span className={styles.conflictTitle}>{conflict.summary}</span></div><span className={styles.mono}>{conflict.ruleKey}</span></header>
                    <p className={styles.conflictText}>{conflict.explanation}</p>
                    <p className={styles.note}>Suggested action: {conflict.suggestedActions[0]}</p>
                    <div className={styles.conflictActions}>
                      <button className={`${styles.button} ${styles.buttonPrimary}`} type="button" onClick={() => moveConflictSession(moveTarget.id)}>Move {moveTarget.title} to the first compatible slot</button>
                      <button className={`${styles.button} ${styles.buttonDanger}`} type="button" onClick={() => clearConflict(conflict)}>Clear {moveTarget.title} to unscheduled</button>
                    </div>
                  </li>;
                })}
              </ol>
            </section>
          ) : <div className={styles.notice} role="status">No hard speaker or room overlaps are present in this draft.</div>}
        </div>

        <aside className={styles.inspector} aria-labelledby="session-inspector-title" data-testid="selected-session-inspector">
          <div className={styles.inspectorHeader}>
            <div><span className={styles.eyebrow}>Selected object</span><h2 id="session-inspector-title">Session inspector</h2></div>
            <span className={styles.commandHint}>No drag required</span>
          </div>
          {placementSession ? <>
            <div className={styles.inspectorTitle}>
              <span className={styles.sessionIndex}>Session</span>
              <h3>{placementSession.title}</h3>
              <p>{placementSession.abstract}</p>
            </div>
            <dl className={styles.inspectorDetails}>
              <div><dt>Placement</dt><dd>{placementLabel(schedule, placementSession)}</dd></div>
              <div><dt>Duration</dt><dd>{placementSession.durationMinutes} minutes</dd></div>
              <div><dt>Capacity</dt><dd>{placementSession.capacity} seats</dd></div>
              <div><dt>Visibility</dt><dd>{placementSession.public ? "Public agenda" : "Organizer-only"}</dd></div>
              <div><dt>Speakers</dt><dd>{speakerNames(schedule, placementSession) || "No speakers assigned"}</dd></div>
            </dl>
            <div className={`${styles.inspectorStatus} ${conflictsBySession.has(placementSession.id) ? styles.inspectorStatusAlert : ""}`}>
              <span className={styles.statusDot} aria-hidden="true" />
              <div><strong>{placementSession.placement ? "Placed in the candidate draft" : "Unscheduled · action required"}</strong><span>{conflictsBySession.has(placementSession.id) ? `${conflictsBySession.get(placementSession.id)?.length} hard conflict${conflictsBySession.get(placementSession.id)?.length === 1 ? "" : "s"} linked to this session` : "This state is persisted with the next command."}</span></div>
            </div>
            <section className={styles.inspectorSection} aria-labelledby="placement-controls-title">
              <div className={styles.inspectorSectionHeader}><div><span className={styles.eyebrow}>Keyboard alternative</span><h3 id="placement-controls-title">Place or move a session</h3></div></div>
              <p className={styles.note}>This keyboard-friendly form is the accessible equivalent of dragging a session onto a schedule cell. It uses the same deterministic conflict checks.</p>
              <form className={styles.placementForm} onSubmit={submitPlacement}>
                <label htmlFor="placement-session">Session
                  <select id="placement-session" value={placementSessionId} onChange={(event) => selectPlacementSession(event.target.value)} disabled={schedule.sessions.length === 0}>
                    {schedule.sessions.map((session) => <option key={session.id} value={session.id}>{session.title} · {session.placement ? "placed" : "unscheduled"}</option>)}
                  </select>
                </label>
                <label htmlFor="placement-day">Day
                  <select id="placement-day" value={placementDayId} onChange={(event) => {
                    const nextDayId = event.target.value;
                    setPlacementDayId(nextDayId);
                    setPlacementTimeSlotId(orderedSlots(schedule, nextDayId)[0]?.id ?? "");
                  }}>
                    {days.map((day) => <option key={day.id} value={day.id}>{day.label} · {day.date}</option>)}
                  </select>
                </label>
                <label htmlFor="placement-time">Time slot
                  <select id="placement-time" value={placementTimeSlotId} onChange={(event) => setPlacementTimeSlotId(event.target.value)}>
                    {placementSlots.map((slot) => <option key={slot.id} value={slot.id}>{slot.label}</option>)}
                  </select>
                </label>
                <label htmlFor="placement-room">Room
                  <select id="placement-room" value={placementRoomId} onChange={(event) => setPlacementRoomId(event.target.value)}>
                    {schedule.rooms.map((room) => <option key={room.id} value={room.id}>{room.name} · {room.capacity} seats</option>)}
                  </select>
                </label>
                <label htmlFor="placement-track">Track
                  <select id="placement-track" value={placementTrackId} onChange={(event) => setPlacementTrackId(event.target.value)}>
                    {schedule.tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
                  </select>
                </label>
                <div className={styles.formActions}>
                  <button className={`${styles.button} ${styles.buttonPrimary}`} type="submit" data-testid="direct-placement-control" disabled={!placementSession || !placementTimeSlotId}>
                    {placementSession?.placement ? "Move session" : "Place session"}
                  </button>
                  <button className={styles.button} type="button" onClick={clearSelectedPlacement} disabled={!placementSession?.placement}>Return to unscheduled tray</button>
                </div>
              </form>
            </section>
          </> : <div className={styles.inspectorEmpty}><span className={styles.emptyIcon} aria-hidden="true">+</span><h3>Select a session</h3><p>Choose a session from the canvas or unscheduled tray to inspect its durable placement and available commands.</p></div>}
        </aside>
      </div>

      <section className={styles.section} aria-labelledby="schedule-configuration-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Event resources</span>
            <h2 id="schedule-configuration-title">Event configuration</h2>
            <p className={styles.note}>Organizer controls for the rooms and tracks available to this event. The server validates and persists each configuration command.</p>
          </div>
          <button className={styles.button} type="button" aria-expanded={showConfiguration} onClick={() => setShowConfiguration((current) => !current)}>
            {showConfiguration ? "Hide room and track controls" : "Configure rooms and tracks"}
          </button>
        </div>
        {showConfiguration ? (
          <form className={styles.configuration} onSubmit={saveConfiguration}>
            <fieldset className={styles.fieldset}>
              <legend>Rooms</legend>
              <div className={styles.resourceList}>
                {roomDrafts.map((room, index) => <div className={styles.resourceRow} key={room.id}>
                  <div className={styles.resourceFields}>
                    <label htmlFor={`room-name-${room.id}`}>Room name <span className={styles.muted}>({room.id})</span></label>
                    <input id={`room-name-${room.id}`} value={room.name} onChange={(event) => setRoomDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />
                    <label htmlFor={`room-capacity-${room.id}`}>Capacity</label>
                    <input id={`room-capacity-${room.id}`} type="number" min={1} max={1_000_000} value={room.capacity} onChange={(event) => setRoomDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, capacity: Number(event.target.value) } : item))} />
                  </div>
                  <button className={`${styles.button} ${styles.buttonDanger}`} type="button" aria-label={`Remove room ${room.name}`} onClick={() => setRoomDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={roomDrafts.length <= 1}>Remove room</button>
                </div>)}
              </div>
              <button className={styles.button} type="button" onClick={addRoom}>Add room</button>
            </fieldset>
            <fieldset className={styles.fieldset}>
              <legend>Tracks</legend>
              <div className={styles.resourceList}>
                {trackDrafts.map((track, index) => <div className={styles.resourceRow} key={track.id}>
                  <div className={styles.resourceFieldsSingle}>
                    <label htmlFor={`track-name-${track.id}`}>Track name <span className={styles.muted}>({track.id})</span></label>
                    <input id={`track-name-${track.id}`} value={track.name} onChange={(event) => setTrackDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />
                  </div>
                  <button className={`${styles.button} ${styles.buttonDanger}`} type="button" aria-label={`Remove track ${track.name}`} onClick={() => setTrackDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={trackDrafts.length <= 1}>Remove track</button>
                </div>)}
              </div>
              <button className={styles.button} type="button" onClick={addTrack}>Add track</button>
            </fieldset>
            <button className={`${styles.button} ${styles.buttonPrimary}`} type="submit" data-testid="save-schedule-configuration">Save room and track configuration</button>
          </form>
        ) : null}
      </section>

      <section className={`${styles.section} ${styles.handoffSection}`} aria-labelledby="approval-handoff-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Decision boundary</span>
            <h2 id="approval-handoff-title">Approval and publication handoff</h2>
            <p className={styles.note}>Approval records an immutable organizer receipt for this exact persisted revision. Any later schedule edit makes that approval stale; publication remains a separate sequential seal.</p>
          </div>
        </div>
        <div className={styles.handoffGrid} data-testid="publication-readiness">
          <div><strong>Draft state</strong><span>Candidate · revision {schedule.revision}</span></div>
          <div><strong>Approval gate</strong><span>{approvalIsCurrent ? `Approved exact revision ${approval.scheduleRevision}` : conflicts.length > 0 || unscheduled.length > 0 ? `${conflicts.length + unscheduled.length} item${conflicts.length + unscheduled.length === 1 ? "" : "s"} need organizer review` : persistenceState !== "saved" ? "Save the exact draft first" : approval ? "Prior approval is stale" : "Ready for organizer approval"}</span></div>
          <div><strong>Publication</strong><span>{approvalIsCurrent ? "Eligible for a separate immutable seal" : "Blocked until exact approval exists"}</span></div>
        </div>
        {scheduleAuthorityFingerprint ? <p className={styles.approvalSubject}>
          Approval subject checksum <code>{scheduleAuthorityFingerprint}</code>. Approval authorizes
          this exact plan, accepted inventory, rooms, tracks, and placements; any material change
          requires a new organizer approval.
        </p> : null}
        {approvalIsCurrent && approval ? <dl className={styles.approvalReceipt} data-testid="schedule-approval-receipt">
          <div><dt>Approved at</dt><dd>{approval.approvedAt}</dd></div>
          <div><dt>Schedule</dt><dd>revision {approval.scheduleRevision} · {approval.scheduleAuthorityFingerprint}</dd></div>
          <div><dt>Draft authority</dt><dd>{approval.sourceScheduleAuditId}</dd></div>
          <div><dt>Approval evidence</dt><dd>{approval.approvalEventId}</dd></div>
        </dl> : null}
        {approvalNotice ? <p className={styles.approvalNotice} role="status" aria-live="polite">{approvalNotice}</p> : null}
        <div className={styles.approvalActions}>
          <button className={`${styles.button} ${styles.buttonPrimary}`} type="button" onClick={approveCurrentSchedule} disabled={approvalBlocked || approvalPending || approvalIsCurrent} data-testid="approve-schedule-draft">
            {approvalPending ? "Approving exact revision…" : approvalIsCurrent ? "Exact revision approved" : "Approve exact schedule revision"}
          </button>
          {approvalIsCurrent ? <Link className={styles.button} href={`/w/${workspaceSlug}/events/${schedule.eventId}/publication`} data-testid="publication-handoff-link">Open publication workspace</Link>
            : <span className={`${styles.button} ${styles.buttonDisabled}`} aria-disabled="true" data-testid="publication-handoff-link">Publication workspace blocked</span>}
        </div>
      </section>
    </div>
  );
}
