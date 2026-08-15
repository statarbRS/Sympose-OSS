import type { Db } from "../db";
import { nowIso, uuid } from "../canonical";
import { withTransaction } from "../db";
import { writeAudit } from "./audit";

export interface CreateEventInput {
  eventName: string;
  unitName: string;
  timezone?: string;
  startsAt?: string;
  endsAt?: string;
  capacity?: number;
}

export interface CreateEventResult {
  eventId: string;
  programUnitId: string;
  eventCreated: boolean;
  programUnitCreated: boolean;
}

/**
 * The portfolio flow is intentionally bounded while event-level projections are still being
 * promoted. The server enforces this ceiling; replaying either existing event remains safe.
 */
export const MAX_EVENTS_PER_WORKSPACE = 2;

export function createEventWithUnit(
  db: Db,
  workspaceId: string,
  actor: { kind: "account"; ref: string },
  input: CreateEventInput,
): CreateEventResult {
  return withTransaction(db, () => {
    const timezone = input.timezone ?? "Europe/Berlin";
    const startsAt = input.startsAt ?? "2026-09-15T09:00:00.000Z";
    const endsAt = input.endsAt ?? "2026-09-15T13:00:00.000Z";
    const capacity = input.capacity ?? 6;
    const eventName = input.eventName.trim();
    const unitName = input.unitName.trim();
    if (eventName.length < 2 || unitName.length < 2) {
      throw new Error("INVALID_EVENT: event and program-unit names must contain at least two characters.");
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("INVALID_CAPACITY: program-unit capacity must be a positive integer.");
    }
    if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt)) || startsAt >= endsAt) {
      throw new Error("INVALID_EVENT_TIME: startsAt and endsAt must be ISO timestamps in chronological order.");
    }

    const existingEvents = db
      .prepare(
        `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt
         FROM events WHERE workspace_id = ?`,
      )
      .all(workspaceId) as {
      id: string;
      name: string;
      timezone: string;
      startsAt: string;
      endsAt: string;
    }[];
    if (existingEvents.length > MAX_EVENTS_PER_WORKSPACE) {
      throw new Error("EVENT_CARDINALITY_INVALID");
    }
    const matchingEvents = existingEvents.filter((event) => event.name === eventName);
    if (matchingEvents.length > 1) {
      throw new Error("EVENT_COMMAND_CONFLICT");
    }
    const existing = matchingEvents[0];
    if (existing) {
      if (
        existing.timezone !== timezone ||
        existing.startsAt !== startsAt ||
        existing.endsAt !== endsAt
      ) {
        throw new Error("EVENT_COMMAND_CONFLICT");
      }
      const unit = db
        .prepare(
          `SELECT id, unit_type AS unitType, starts_at AS startsAt, ends_at AS endsAt, capacity
           FROM program_units WHERE workspace_id = ? AND event_id = ? AND name = ?`,
        )
        .get(workspaceId, existing.id, unitName) as
        | { id: string; unitType: string; startsAt: string; endsAt: string; capacity: number }
        | undefined;
      if (unit) {
        if (
          unit.unitType !== "roundtable" ||
          unit.startsAt !== startsAt ||
          unit.endsAt !== endsAt ||
          unit.capacity !== capacity
        ) {
          throw new Error("EVENT_COMMAND_CONFLICT");
        }
        return {
          eventId: existing.id,
          programUnitId: unit.id,
          eventCreated: false,
          programUnitCreated: false,
        };
      }
      const unitId = uuid();
      db.prepare(
        `INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(unitId, workspaceId, existing.id, unitName, "roundtable", startsAt, endsAt, capacity, nowIso());
      writeAudit(db, workspaceId, {
        actorKind: actor.kind,
        actorRef: actor.ref,
        action: "program_unit.created",
        targetType: "program_unit",
        targetId: unitId,
        details: { eventId: existing.id, programUnitId: unitId, unitName, startsAt, endsAt, capacity },
      });
      return {
        eventId: existing.id,
        programUnitId: unitId,
        eventCreated: false,
        programUnitCreated: true,
      };
    }

    if (existingEvents.length >= MAX_EVENTS_PER_WORKSPACE) {
      throw new Error("EVENT_CARDINALITY_INVALID");
    }

    const eventId = uuid();
    db.prepare(
      `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'planning', ?)`,
    ).run(eventId, workspaceId, eventName, timezone, startsAt, endsAt, nowIso());

    const unitId = uuid();
    db.prepare(
      `INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(unitId, workspaceId, eventId, unitName, "roundtable", startsAt, endsAt, capacity, nowIso());

    writeAudit(db, workspaceId, {
      actorKind: actor.kind,
      actorRef: actor.ref,
      action: "event.created",
      targetType: "event",
      targetId: eventId,
      details: { programUnitId: unitId, timezone, startsAt, endsAt, capacity },
    });

    return { eventId, programUnitId: unitId, eventCreated: true, programUnitCreated: true };
  });
}

export interface EventRow {
  id: string;
  name: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  lifecycle: string;
  currentPlanVersionId: string | null;
  currentReleaseId: string | null;
  createdAt: string;
}

export function listEvents(db: Db, workspaceId: string): EventRow[] {
  return db
    .prepare(
      `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt, lifecycle,
              current_plan_version_id AS currentPlanVersionId, current_release_id AS currentReleaseId,
              created_at AS createdAt
       FROM events
       WHERE workspace_id = ?
       ORDER BY created_at, id`,
    )
    .all(workspaceId) as unknown as EventRow[];
}

export function getEvent(db: Db, workspaceId: string, eventId: string): EventRow | null {
  const row = db
    .prepare(
      `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt, lifecycle,
              current_plan_version_id AS currentPlanVersionId, current_release_id AS currentReleaseId,
              created_at AS createdAt
       FROM events WHERE workspace_id = ? AND id = ?`,
    )
    .get(workspaceId, eventId) as EventRow | undefined;
  return row ?? null;
}
