import { afterEach, describe, expect, it } from "vitest";

import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "../../src/server/evaluator-demo";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { deterministicUuid } from "../../src/server/canonical";
import { seedWorkspaces } from "../../src/server/seed";
import { createEventWithUnit, getEvent, listEvents } from "../../src/server/services/events";

const databases: Db[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
});

function openEvaluatorDb(): Db {
  const db = openDb({ path: ":memory:", seed: false });
  databases.push(db);
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  return db;
}

function countEventRows(
  db: Db,
  table: "calls" | "submissions" | "review_assignments" | "event_speakers",
  eventId: string,
): number {
  if (table === "review_assignments") {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM review_assignments a
           JOIN review_rounds r ON r.id = a.round_id AND r.workspace_id = a.workspace_id
           WHERE a.workspace_id = ? AND r.event_id = ?`,
        )
        .get(EVALUATOR_WORKSPACE_ID, eventId) as { count: number }
    ).count;
  }
  return (
    db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ? AND event_id = ?`)
      .get(EVALUATOR_WORKSPACE_ID, eventId) as { count: number }
  ).count;
}

describe("event portfolio creation", () => {
  it("creates and replays a second evaluator event without copying event records", () => {
    const db = openEvaluatorDb();
    const actor = { kind: "account" as const, ref: EVALUATOR_ORGANIZER_ACCOUNT_ID };

    const second = createEventWithUnit(db, EVALUATOR_WORKSPACE_ID, actor, {
      eventName: "Acme Evaluator Workshop",
      unitName: "Second synthetic session",
      capacity: 24,
    });
    expect(second.eventCreated).toBe(true);
    expect(second.programUnitCreated).toBe(true);

    const replay = createEventWithUnit(db, EVALUATOR_WORKSPACE_ID, actor, {
      eventName: "Acme Evaluator Workshop",
      unitName: "Second synthetic session",
      capacity: 24,
    });
    expect(replay).toEqual({
      eventId: second.eventId,
      programUnitId: second.programUnitId,
      eventCreated: false,
      programUnitCreated: false,
    });

    expect(listEvents(db, EVALUATOR_WORKSPACE_ID).map((event) => event.id)).toEqual([
      EVALUATOR_EVENT_ID,
      second.eventId,
    ]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM program_units WHERE workspace_id = ? AND event_id = ?")
        .get(EVALUATOR_WORKSPACE_ID, second.eventId),
    ).toEqual({ count: 1 });

    expect(countEventRows(db, "calls", second.eventId)).toBe(0);
    expect(countEventRows(db, "submissions", second.eventId)).toBe(0);
    expect(countEventRows(db, "review_assignments", second.eventId)).toBe(0);
    expect(countEventRows(db, "event_speakers", second.eventId)).toBe(0);
    expect(countEventRows(db, "calls", EVALUATOR_EVENT_ID)).toBe(1);
    expect(countEventRows(db, "submissions", EVALUATOR_EVENT_ID)).toBe(3);
    expect(countEventRows(db, "review_assignments", EVALUATOR_EVENT_ID)).toBe(1);

    seedEvaluatorDemo(db);
    expect(listEvents(db, EVALUATOR_WORKSPACE_ID)).toHaveLength(2);
  });

  it("keeps event reads scoped to the authenticated workspace", () => {
    const db = openEvaluatorDb();
    const actor = { kind: "account" as const, ref: EVALUATOR_ORGANIZER_ACCOUNT_ID };
    const second = createEventWithUnit(db, EVALUATOR_WORKSPACE_ID, actor, {
      eventName: "Acme Evaluator Workshop",
      unitName: "Second synthetic session",
      capacity: 24,
    });
    const northstarWorkspaceId = deterministicUuid("workspace:northstar");

    expect(getEvent(db, EVALUATOR_WORKSPACE_ID, second.eventId)?.name).toBe("Acme Evaluator Workshop");
    expect(getEvent(db, northstarWorkspaceId, second.eventId)).toBeNull();
    expect(listEvents(db, northstarWorkspaceId)).toEqual([]);
  });
});
