import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { closeDb, openDb } from "../../src/server/db";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_SPEAKER_PERSON_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "../../src/server/evaluator-demo";
import { acceptedCurrentPlanAssignmentId } from "../../src/server/services/evaluator-speaker-identity";
import {
  createSyntheticSpeakerOperationsRepository,
  SpeakerOperationsAuthorizationError,
} from "../../src/server/services/speaker-operations";
import { DDL } from "../../src/server/schema";

function manifestDigest(): string {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
  db.exec(DDL);
  const objects = db.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
    ORDER BY type, name, tableName`).all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>;
  const manifest = objects.map((object) => ({
    ...object,
    columns: object.type === "table" ? db.prepare(`PRAGMA table_info("${object.name.replaceAll('"', '""')}")`).all().map((column: any) => ({ cid: column.cid, name: column.name, type: column.type, notnull: column.notnull, defaultValue: column.dflt_value, primaryKey: column.pk })) : null,
    foreignKeys: object.type === "table" ? db.prepare(`PRAGMA foreign_key_list("${object.name.replaceAll('"', '""')}")`).all().map((fk: any) => ({ id: fk.id, sequence: fk.seq, tableName: fk.table, from: fk.from, to: fk.to, onUpdate: fk.on_update, onDelete: fk.on_delete, match: fk.match })) : null,
    indexColumns: object.type === "index" ? db.prepare(`PRAGMA index_info("${object.name.replaceAll('"', '""')}")`).all().map((column: any) => ({ sequence: column.seqno, columnId: column.cid, columnName: column.name })) : null,
  }));
  db.close();
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

describe("speaker task assignment authority", () => {
  function insertTask(db: ReturnType<typeof openDb>, id: string, assignmentId: string): void {
    db.prepare(`INSERT INTO speaker_tasks
      (id, workspace_id, event_id, person_id, assignment_id, task_kind, content_kind, title,
       required, gate, owner, due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'HEADSHOT', 'HEADSHOT', 'Headshot PNG', 1, 'PUBLICATION', 'SPEAKER', ?, ?, ?)`).run(
      id,
      EVALUATOR_WORKSPACE_ID,
      EVALUATOR_EVENT_ID,
      EVALUATOR_SPEAKER_PERSON_ID,
      assignmentId,
      "2026-09-01",
      "2026-08-12",
      "2026-08-12",
    );
  }

  it("derives fresh evaluator task authority from the current approved accepted assignment", () => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const assignmentId = acceptedCurrentPlanAssignmentId(db, {
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: EVALUATOR_EVENT_ID,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      db.prepare(`INSERT INTO speaker_tasks
        (id, workspace_id, event_id, person_id, assignment_id, task_kind, content_kind, title,
         required, gate, owner, due_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'HEADSHOT', 'HEADSHOT', 'Headshot PNG', 1, 'PUBLICATION', 'SPEAKER', ?, ?, ?)`)
        .run("authority-task", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_SPEAKER_PERSON_ID, assignmentId, "2026-09-01", "2026-08-12", "2026-08-12");
      expect(db.prepare("SELECT assignment_id FROM speaker_tasks WHERE id = ?").get("authority-task")).toEqual({ assignment_id: assignmentId });
    } finally {
      closeDb(db);
    }
  });

  it("rejects an assignment from the wrong person even when the row exists", () => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const assignmentId = acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID });
      const otherPersonId = db.prepare("SELECT id FROM people WHERE workspace_id = ? AND id <> ? LIMIT 1").get(EVALUATOR_WORKSPACE_ID, EVALUATOR_SPEAKER_PERSON_ID) as { id: string };
      expect(() => db.prepare(`INSERT INTO speaker_tasks
        (id, workspace_id, event_id, person_id, assignment_id, task_kind, content_kind, title, required, gate, owner, due_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'HEADSHOT', 'HEADSHOT', 'Headshot PNG', 1, 'PUBLICATION', 'SPEAKER', ?, ?, ?)`)
        .run("wrong-person-task", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, otherPersonId.id, assignmentId, "2026-09-01", "2026-08-12", "2026-08-12")).toThrow(/scope or acceptance mismatch/u);
    } finally {
      closeDb(db);
    }
  });

  it("rejects a historical assignment and a current plan with multiple assignments", () => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const currentAssignmentId = acceptedCurrentPlanAssignmentId(db, {
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: EVALUATOR_EVENT_ID,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      const current = db.prepare("SELECT current_plan_version_id AS planId FROM events WHERE id = ?").get(EVALUATOR_EVENT_ID) as { planId: string };
      db.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("authority-extra-unit", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, "Extra authority unit", "SESSION", "2026-08-12T12:00:00.000Z", "2026-08-12T13:00:00.000Z", 1, "2026-08-12T12:00:00.000Z");
      db.prepare("INSERT INTO plan_assignments (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)").run("authority-extra-assignment", EVALUATOR_WORKSPACE_ID, current.planId, EVALUATOR_SPEAKER_PERSON_ID, "authority-extra-unit", "SPEAKER", "ambiguous current authority");
      expect(() => acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID })).toThrow("SPEAKER_ARTIFACT_SCOPE_UNAVAILABLE");
      expect(() => insertTask(db, "ambiguous-task", currentAssignmentId)).toThrow(/scope or acceptance mismatch/u);
    } finally {
      closeDb(db);
    }
  });

  it("rejects an offer whose material role or program unit terms do not match the assignment", () => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const assignmentId = acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID });
      const offer = db.prepare("SELECT id, terms_json FROM commitment_offers WHERE person_id = ?").get(EVALUATOR_SPEAKER_PERSON_ID) as { id: string; terms_json: string };
      const terms = JSON.parse(offer.terms_json) as Record<string, unknown>;
      db.exec("DROP TRIGGER trg_offers_immutable");
      db.prepare("UPDATE commitment_offers SET terms_json = ? WHERE id = ?").run(JSON.stringify({ ...terms, programUnitId: "contradictory-program-unit", role: "MODERATOR" }), offer.id);
      expect(() => insertTask(db, "terms-mismatch-task", assignmentId)).toThrow(/scope or acceptance mismatch/u);
    } finally {
      closeDb(db);
    }
  });

  it("rejects an unsupported persisted role before building speaker authority", () => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const assignmentId = acceptedCurrentPlanAssignmentId(db, {
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: EVALUATOR_EVENT_ID,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      db.exec("DROP TRIGGER trg_plan_assignments_immutable");
      db.prepare("UPDATE plan_assignments SET assignment_type = ? WHERE id = ?").run("ATTENDEE", assignmentId);
      db.exec("DROP TRIGGER trg_offers_immutable");
      const offer = db.prepare("SELECT id, terms_json FROM commitment_offers WHERE person_id = ?").get(EVALUATOR_SPEAKER_PERSON_ID) as { id: string; terms_json: string };
      db.prepare("UPDATE commitment_offers SET terms_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(offer.terms_json), role: "ATTENDEE" }), offer.id);

      const repository = createSyntheticSpeakerOperationsRepository({ db });
      expect(() => repository.getOrganizerProjection(
        { kind: "organizer", workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, actorId: "authority-test-organizer" },
        {
          id: EVALUATOR_EVENT_ID,
          name: "Acme Evaluator Summit",
          timezone: "UTC",
          startsAt: "2026-08-12T12:00:00.000Z",
          endsAt: "2026-08-12T18:00:00.000Z",
        },
      )).toThrow(SpeakerOperationsAuthorizationError);
    } finally {
      closeDb(db);
    }
  });

  it("normalizes the valid legacy participant role encoding at the shared authority boundary", () => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const assignmentId = acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID });
      db.exec("DROP TRIGGER trg_plan_assignments_immutable");
      db.prepare("UPDATE plan_assignments SET assignment_type = ? WHERE id = ?").run("participant", assignmentId);
      db.exec("DROP TRIGGER trg_offers_immutable");
      const offer = db.prepare("SELECT id, terms_json FROM commitment_offers WHERE person_id = ?").get(EVALUATOR_SPEAKER_PERSON_ID) as { id: string; terms_json: string };
      db.prepare("UPDATE commitment_offers SET terms_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(offer.terms_json), role: "participant" }), offer.id);
      db.exec("DROP TRIGGER trg_v12_event_speakers_workspace_update_guard");
      db.prepare("UPDATE event_speakers SET role_key = 'SPEAKER' WHERE workspace_id = ? AND event_id = ? AND person_id = ?")
        .run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_SPEAKER_PERSON_ID);
      expect(acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID })).toBe(assignmentId);
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["SPEAKER", "SPEAKER", "SPEAKER"],
    ["participant", "participant", "SPEAKER"],
    ["SPEAKER", "participant", "SPEAKER"],
    ["participant", "SPEAKER", "SPEAKER"],
    ["MODERATOR", "MODERATOR", "MODERATOR"],
    ["moderator", "moderator", "MODERATOR"],
    ["MODERATOR", "moderator", "MODERATOR"],
    ["moderator", "MODERATOR", "MODERATOR"],
  ])("accepts the supported normalized task authority %s/%s/%s", (assignmentRole, offerRole, eventRole) => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const assignmentId = acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID });
      db.exec("DROP TRIGGER trg_plan_assignments_immutable; DROP TRIGGER trg_offers_immutable; DROP TRIGGER trg_v12_event_speakers_workspace_update_guard");
      db.prepare("UPDATE plan_assignments SET assignment_type = ? WHERE id = ?").run(assignmentRole, assignmentId);
      const offer = db.prepare("SELECT id, terms_json FROM commitment_offers WHERE person_id = ?").get(EVALUATOR_SPEAKER_PERSON_ID) as { id: string; terms_json: string };
      db.prepare("UPDATE commitment_offers SET terms_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(offer.terms_json), role: offerRole }), offer.id);
      db.prepare("UPDATE event_speakers SET role_key = ? WHERE workspace_id = ? AND event_id = ? AND person_id = ?").run(eventRole, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_SPEAKER_PERSON_ID);
      expect(acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID })).toBe(assignmentId);
      expect(() => insertTask(db, `normalized-${assignmentRole}-${offerRole}`, assignmentId)).not.toThrow();
    } finally {
      closeDb(db);
    }
  });

  it("rejects a consistently matching unsupported role at the SQL task boundary", () => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const assignmentId = acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID });
      db.exec("DROP TRIGGER trg_plan_assignments_immutable; DROP TRIGGER trg_offers_immutable");
      db.prepare("UPDATE plan_assignments SET assignment_type = 'ATTENDEE' WHERE id = ?").run(assignmentId);
      const offer = db.prepare("SELECT id, terms_json FROM commitment_offers WHERE person_id = ?").get(EVALUATOR_SPEAKER_PERSON_ID) as { id: string; terms_json: string };
      db.prepare("UPDATE commitment_offers SET terms_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(offer.terms_json), role: "ATTENDEE" }), offer.id);
      expect(() => acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID })).toThrow("SPEAKER_ARTIFACT_SCOPE_UNAVAILABLE");
      expect(() => insertTask(db, "unsupported-attendee-task", assignmentId)).toThrow(/scope or acceptance mismatch/u);
    } finally {
      closeDb(db);
    }
  });

  it("rejects a pointed plan whose latest append-only state is superseded", () => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const assignmentId = acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID });
      const planId = (db.prepare("SELECT current_plan_version_id AS planId FROM events WHERE id = ?").get(EVALUATOR_EVENT_ID) as { planId: string }).planId;
      const actor = (db.prepare("SELECT actor_account_id AS actorId FROM approvals WHERE plan_version_id = ?").get(planId) as { actorId: string }).actorId;
      db.prepare("INSERT INTO plan_states (id, workspace_id, plan_version_id, state, actor_account_id, created_at) VALUES (?, ?, ?, 'superseded', ?, ?)").run("superseded-current-state", EVALUATOR_WORKSPACE_ID, planId, actor, "2026-08-12T12:01:00.000Z");
      expect(() => insertTask(db, "superseded-plan-task", assignmentId)).toThrow(/scope or acceptance mismatch/u);
    } finally {
      closeDb(db);
    }
  });

  it("revalidates authority on a second task reopen after current-plan ambiguity", () => {
    const db = openDb({ path: ":memory:" });
    try {
      seedEvaluatorDemo(db);
      const assignmentId = acceptedCurrentPlanAssignmentId(db, { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID, personId: EVALUATOR_SPEAKER_PERSON_ID });
      insertTask(db, "reopen-task", assignmentId);
      db.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("reopen-extra-unit", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, "Reopen extra unit", "SESSION", "2026-08-12T12:00:00.000Z", "2026-08-12T13:00:00.000Z", 1, "2026-08-12T12:00:00.000Z");
      const planId = (db.prepare("SELECT current_plan_version_id AS planId FROM events WHERE id = ?").get(EVALUATOR_EVENT_ID) as { planId: string }).planId;
      db.prepare("INSERT INTO plan_assignments (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)").run("reopen-extra-assignment", EVALUATOR_WORKSPACE_ID, planId, EVALUATOR_SPEAKER_PERSON_ID, "reopen-extra-unit", "SPEAKER", "reopen ambiguity");
      expect(() => db.prepare("UPDATE speaker_tasks SET state = 'SUBMITTED', updated_at = ? WHERE id = ?").run("2026-08-12T12:01:00.000Z", "reopen-task")).toThrow(/reopen authority mismatch/u);
    } finally {
      closeDb(db);
    }
  });

  it("keeps the manifest and authority contract deterministic", () => {
    expect(manifestDigest()).toBe("4f82143569670933cf9080e38d312a827bc348a13b3a0dfb6ad233a0867f761b");
  });
});
