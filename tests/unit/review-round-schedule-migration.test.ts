import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createSession } from "../../src/server/auth";
import { closeDb, openDb, openDbForTest } from "../../src/server/db";
import {
  createCall,
  createFormDefinition,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import { V15_DDL } from "../../src/server/schema";
import { dropV21ProductionConnectorSchema } from "./helpers/drop-v21-production-connector-schema";
import {
  createOrganizerReviewRound,
  createOrganizerReviewRubric,
  readOrganizerReviewSurface,
  setOrganizerReviewRoundSchedule,
} from "../../src/server/services/cfp-review/organizer";

function databasePath(): string {
  const path = resolve(".tmp/unit", `review-round-schedule-migration-${process.pid}.db`);
  mkdirSync(dirname(path), { recursive: true });
  removeDatabase(path);
  return path;
}

function removeDatabase(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(target, { force: true });
  }
}

function restoreExactV14(db: DatabaseSync): void {
  dropV21ProductionConnectorSchema(db);
  db.exec(`
    DROP INDEX IF EXISTS idx_connector_connections_workspace;
    DROP TABLE IF EXISTS connector_connections;
    DROP TRIGGER IF EXISTS trg_observation_audit_v19_guard;
    DROP TRIGGER IF EXISTS trg_observation_corrections_v19_guard;
    DROP TRIGGER IF EXISTS trg_observations_v19_guard;
    DROP TRIGGER IF EXISTS trg_observation_corrections_no_delete;
    DROP TRIGGER IF EXISTS trg_observation_corrections_immutable;
    DROP TRIGGER IF EXISTS trg_observation_corrections_guard;
    DROP INDEX IF EXISTS idx_observation_corrections_scope;
    DROP TABLE IF EXISTS observation_corrections;
    DROP TRIGGER IF EXISTS trg_publication_audience_receipts_no_delete;
    DROP TRIGGER IF EXISTS trg_publication_audience_receipts_immutable;
    DROP TRIGGER IF EXISTS trg_publication_audience_receipts_guard;
    DROP TRIGGER IF EXISTS trg_publication_audience_policies_no_delete;
    DROP TRIGGER IF EXISTS trg_publication_audience_policies_immutable;
    DROP TRIGGER IF EXISTS trg_publication_audience_policies_guard;
    DROP TRIGGER IF EXISTS trg_publication_audience_channels_no_delete;
    DROP TRIGGER IF EXISTS trg_publication_audience_channels_immutable;
    DROP TRIGGER IF EXISTS trg_publication_audience_channels_guard;
    DROP TRIGGER IF EXISTS trg_publication_release_versions_no_delete;
    DROP TRIGGER IF EXISTS trg_publication_release_versions_immutable;
    DROP TRIGGER IF EXISTS trg_publication_release_versions_guard;
    DROP INDEX IF EXISTS uq_publication_audience_binding_disable;
    DROP INDEX IF EXISTS uq_publication_audience_policy_supersession;
    DROP INDEX IF EXISTS uq_publication_audience_binding_exact;
    DROP INDEX IF EXISTS idx_publication_audience_receipts_release;
    DROP INDEX IF EXISTS idx_publication_audience_receipts_scope;
    DROP INDEX IF EXISTS idx_publication_audience_policies_scope;
    DROP INDEX IF EXISTS idx_publication_audience_channels_scope;
    DROP INDEX IF EXISTS idx_publication_release_versions_scope;
    DROP TABLE IF EXISTS publication_audience_receipts;
    DROP TABLE IF EXISTS publication_audience_policy_versions;
    DROP TABLE IF EXISTS publication_audience_channels;
    DROP TABLE IF EXISTS publication_release_versions;
    DROP TRIGGER trg_reviewer_access_states_guard;
    DROP TRIGGER trg_reviewer_access_states_immutable;
    DROP TRIGGER trg_reviewer_access_states_no_delete;
    DROP TRIGGER trg_reviewer_access_receipts_guard;
    DROP TRIGGER trg_reviewer_access_receipts_immutable;
    DROP TRIGGER trg_reviewer_access_receipts_no_delete;
    DROP INDEX idx_reviewer_access_states_scope;
    DROP INDEX idx_reviewer_access_receipts_scope;
    DROP TABLE reviewer_access_states;
    DROP TABLE reviewer_access_receipts;
    DROP TRIGGER trg_review_round_creation_receipts_guard;
    DROP TRIGGER trg_review_round_creation_receipts_immutable;
    DROP TRIGGER trg_review_round_creation_receipts_no_delete;
    DROP TABLE review_round_creation_receipts;
    DROP TRIGGER trg_review_rounds_initialize_schedule;
    DROP TRIGGER trg_review_round_schedule_versions_guard;
    DROP TRIGGER trg_review_round_schedule_versions_immutable;
    DROP TRIGGER trg_review_round_schedule_versions_no_delete;
    DROP INDEX idx_review_round_schedule_versions_scope;
    DROP TABLE review_round_schedule_versions;
    UPDATE meta SET value = '14' WHERE key = 'schema_version';
  `);
  const hasRecordedAt = (
    db.prepare("PRAGMA table_info(observations)").all() as Array<{ name: string }>
  ).some((column) => column.name === "recorded_at");
  if (hasRecordedAt) {
    db.exec("ALTER TABLE observations DROP COLUMN recorded_at");
  }
}

function createV14RoundFixture(options: {
  opensAt: string | null;
  closesAt: string | null;
  timezone?: string;
}): { path: string; callId: string; roundId: string } {
  const path = databasePath();
  const db = openDb({ path });
  try {
    const workspace = db.prepare(
      "SELECT id FROM workspaces WHERE slug = 'northstar'",
    ).get() as { id: string };
    const organizer = db.prepare(
      "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' ORDER BY id LIMIT 1",
    ).get(workspace.id) as { id: string };
    const session = createSession(db, organizer.id, workspace.id).session;
    db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES ('adversarial-migration-event', ?, 'Adversarial migration event',
               'UTC', ?, ?, 'planning', ?)`,
    ).run(
      workspace.id,
      "2026-09-01T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    );
    const context = { workspaceId: workspace.id, accountId: organizer.id };
    const definition = createFormDefinition(db, context, { name: "Adversarial migration form" });
    const form = sealFormVersion(db, context, {
      formDefinitionId: definition.id,
      fields: [{ id: "proposal", type: "longText", label: "Proposal", required: true, defaultVisibility: "visible" }],
      rules: { schema: FORM_RULES_SCHEMA, rules: [] },
    });
    const call = createCall(db, context, {
      eventId: "adversarial-migration-event",
      name: "Adversarial migration call",
      slug: "adversarial-migration-call",
      formVersionId: form.id,
      state: "DRAFT",
      timezone: "UTC",
      opensAt: "2026-09-02T00:00:00.000Z",
      closesAt: "2026-09-20T00:00:00.000Z",
      policy: {
        disclosure: {
          privacy: "synthetic",
          retention: "synthetic",
          aiProcessing: "synthetic",
          communication: "synthetic",
          consent: "synthetic",
          publication: "synthetic",
        },
        choices: [],
      },
    });
    const round = createOrganizerReviewRound(db, session, {
      workspaceSlug: "northstar",
      eventId: "adversarial-migration-event",
      callId: call.id,
      name: "Adversarial migration round",
    });
    db.prepare(
      "UPDATE calls SET opens_at = ?, closes_at = ?, timezone = ? WHERE id = ?",
    ).run(options.opensAt, options.closesAt, options.timezone ?? "UTC", call.id);
    restoreExactV14(db);
    closeDb(db);
    return { path, callId: call.id, roundId: round.roundId };
  } catch (error) {
    closeDb(db);
    removeDatabase(path);
    throw error;
  }
}

describe("review-round schedule V15 migration", () => {
  it("keeps the raw V15 DDL independent of application-only SQLite functions", () => {
    expect(V15_DDL).not.toMatch(/\bsympose_[a-z0-9_]+\s*\(/iu);
  });

  it("canonicalizes only strict explicitly zoned timestamps and validates supported IANA zones", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      const canonical = db.prepare(
        "SELECT sympose_canonical_timestamp(?) AS value",
      );
      for (const value of [
        "2026-09-02T00:00:00Z",
        "2026-09-02T00:00:00.000Z",
        "2026-09-02T02:30:00+02:30",
        "2026-09-01T19:00:00-05:00",
      ]) {
        expect(canonical.get(value)).toEqual({ value: "2026-09-02T00:00:00.000Z" });
      }
      for (const value of [
        "2026-09-02T00:00:00",
        "2026-02-30T00:00:00Z",
        "2026-09-02T24:00:00Z",
        "2026-09-02T00:00:00+24:00",
        "2026-09-02 00:00:00Z",
        "not-a-timestamp",
      ]) {
        expect(canonical.get(value)).toEqual({ value: null });
      }
      const timezone = db.prepare("SELECT sympose_is_iana_timezone(?) AS valid");
      expect(timezone.get("UTC")).toEqual({ valid: 1 });
      expect(timezone.get("America/New_York")).toEqual({ valid: 1 });
      expect(timezone.get("Mars/Olympus_Mons")).toEqual({ valid: 0 });
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["timezone-less paired bounds", "2026-09-02T00:00:00", "2026-09-20T00:00:00", "UTC"],
    ["a one-sided bound", "2026-09-02T00:00:00Z", null, "UTC"],
    ["a malformed paired bound", "not-a-timestamp", "2026-09-20T00:00:00Z", "UTC"],
    ["a non-ISO date-time separator", "2026-09-02 00:00:00Z", "2026-09-20T00:00:00Z", "UTC"],
    ["a repeated date-time separator", "2026-09-02TT00:00:00Z", "2026-09-20T00:00:00Z", "UTC"],
    ["a date-time separator followed by space", "2026-09-02T 00:00:00Z", "2026-09-20T00:00:00Z", "UTC"],
    ["a space before the UTC designator", "2026-09-02T00:00:00 Z", "2026-09-20T00:00:00Z", "UTC"],
    ["excess fractional precision", "2026-09-02T00:00:00.0000Z", "2026-09-20T00:00:00Z", "UTC"],
    ["a non-increasing paired window", "2026-09-20T00:00:00Z", "2026-09-02T00:00:00Z", "UTC"],
    ["an unsupported timezone", "2026-09-02T00:00:00Z", "2026-09-20T00:00:00Z", "Mars/Olympus_Mons"],
  ])("fails the V15 migration atomically for %s", (_label, opensAt, closesAt, timezone) => {
    const fixture = createV14RoundFixture({ opensAt, closesAt, timezone });
    try {
      expect(() => openDb({ path: fixture.path, seed: false })).toThrow();
      const raw = new DatabaseSync(fixture.path);
      try {
        expect(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "14" });
        expect(raw.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_round_schedule_versions'",
        ).get()).toBeUndefined();
      } finally {
        raw.close();
      }
    } finally {
      removeDatabase(fixture.path);
    }
  });

  it.each([
    ["canonical Z", "2026-09-02T00:00:00Z", "2026-09-20T01:00:00Z", "2026-09-02T00:00:00.000Z", "2026-09-20T01:00:00.000Z"],
    ["numeric offset", "2026-09-02T02:30:00+02:30", "2026-09-20T03:30:00+02:30", "2026-09-02T00:00:00.000Z", "2026-09-20T01:00:00.000Z"],
  ])("migrates and canonicalizes %s source timestamps", (_label, opensAt, closesAt, expectedOpensAt, expectedClosesAt) => {
    const fixture = createV14RoundFixture({ opensAt, closesAt });
    try {
      const db = openDb({ path: fixture.path, seed: false });
      try {
        expect(db.prepare(
          `SELECT opens_at, closes_at
           FROM review_round_schedule_versions
           WHERE round_id = ? AND version_number = 1`,
        ).get(fixture.roundId)).toEqual({
          opens_at: expectedOpensAt,
          closes_at: expectedClosesAt,
        });
      } finally {
        closeDb(db);
      }
    } finally {
      removeDatabase(fixture.path);
    }
  });

  it("rejects an unsupported stored timezone when reopening migrated V15 history", () => {
    const fixture = createV14RoundFixture({
      opensAt: "2026-09-02T00:00:00Z",
      closesAt: "2026-09-20T00:00:00Z",
    });
    try {
      closeDb(openDb({ path: fixture.path, seed: false }));
      const raw = new DatabaseSync(fixture.path);
      try {
        const scheduleTrigger = raw.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_review_round_schedule_versions_immutable'",
        ).get() as { sql: string };
        const receiptTrigger = raw.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_review_round_creation_receipts_immutable'",
        ).get() as { sql: string };
        raw.exec(`
          PRAGMA ignore_check_constraints = ON;
          DROP TRIGGER trg_review_round_schedule_versions_immutable;
          DROP TRIGGER trg_review_round_creation_receipts_immutable;
        `);
        raw.prepare("UPDATE review_round_schedule_versions SET timezone = ? WHERE round_id = ?")
          .run("Mars/Olympus_Mons", fixture.roundId);
        raw.prepare("UPDATE review_round_creation_receipts SET timezone = ? WHERE round_id = ?")
          .run("Mars/Olympus_Mons", fixture.roundId);
        raw.exec(`${scheduleTrigger.sql}; ${receiptTrigger.sql}; PRAGMA ignore_check_constraints = OFF;`);
      } finally {
        raw.close();
      }
      expect(() => openDb({ path: fixture.path, seed: false })).toThrow(
        "malformed review-round schedule history",
      );
    } finally {
      removeDatabase(fixture.path);
    }
  });

  it("rolls back atomically, backfills seeded rounds once, and survives reopen", () => {
    const path = databasePath();
    try {
      const v15 = openDb({ path });
      const workspace = v15.prepare(
        "SELECT id FROM workspaces WHERE slug = 'northstar'",
      ).get() as { id: string };
      const organizer = v15.prepare(
        "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' ORDER BY id LIMIT 1",
      ).get(workspace.id) as { id: string };
      const session = createSession(v15, organizer.id, workspace.id).session;
      v15.prepare(
        `INSERT INTO events
           (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
         VALUES ('migration-event', ?, 'Migration event', 'UTC', ?, ?, 'planning', ?)`,
      ).run(
        workspace.id,
        "2026-09-01T00:00:00.000Z",
        "2026-09-30T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
      const context = { workspaceId: workspace.id, accountId: organizer.id };
      const definition = createFormDefinition(v15, context, { name: "Migration form" });
      const form = sealFormVersion(v15, context, {
        formDefinitionId: definition.id,
        fields: [{ id: "proposal", type: "longText", label: "Proposal", required: true, defaultVisibility: "visible" }],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      const call = createCall(v15, context, {
        eventId: "migration-event",
        name: "Migration call",
        slug: "migration-call",
        formVersionId: form.id,
        state: "OPEN",
        timezone: "UTC",
        opensAt: "2026-09-02T00:00:00.000Z",
        closesAt: "2026-09-20T00:00:00.000Z",
        policy: {
          disclosure: {
            privacy: "synthetic",
            retention: "synthetic",
            aiProcessing: "synthetic",
            communication: "synthetic",
            consent: "synthetic",
            publication: "synthetic",
          },
          choices: [],
        },
      });
      const round = createOrganizerReviewRound(v15, session, {
        workspaceSlug: "northstar",
        eventId: "migration-event",
        callId: call.id,
        name: "Seeded migration round",
      });
      createOrganizerReviewRubric(v15, session, {
        workspaceSlug: "northstar",
        roundId: round.roundId,
        fields: [{ id: "quality", label: "Quality", kind: "numeric", required: true, weight: 1, minimum: 0, maximum: 5, step: 1 }],
        idempotencyKey: "migration-rubric",
      });
      const unscheduledCall = createCall(v15, context, {
        eventId: "migration-event",
        name: "Unscheduled migration call",
        slug: "unscheduled-migration-call",
        formVersionId: form.id,
        state: "DRAFT",
        timezone: "UTC",
        opensAt: null,
        closesAt: null,
        policy: {
          disclosure: {
            privacy: "synthetic",
            retention: "synthetic",
            aiProcessing: "synthetic",
            communication: "synthetic",
            consent: "synthetic",
            publication: "synthetic",
          },
          choices: [],
        },
      });
      v15.prepare(
        `INSERT INTO review_rounds
           (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('seeded-round-without-call-window', ?, 'migration-event', ?, ?, ?, ?)`,
      ).run(
        workspace.id,
        unscheduledCall.id,
        "Seeded round without a call window",
        organizer.id,
        "2026-08-02T00:00:00.000Z",
      );
      v15.prepare("UPDATE calls SET opens_at = ?, closes_at = ? WHERE id = ?").run(
        "2026-09-02T00:00:00Z",
        "2026-09-20T00:00:00Z",
        call.id,
      );
      v15.prepare("UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?").run(
        "2026-09-01T00:00:00Z",
        "2026-09-30T00:00:00Z",
        "migration-event",
      );
      const roundsBefore = v15.prepare(
        `SELECT round.id, round.workspace_id, round.event_id, round.call_id, round.name,
                call.timezone,
                CASE WHEN call.opens_at IS NOT NULL AND call.closes_at IS NOT NULL
                           AND call.opens_at < call.closes_at
                     THEN sympose_canonical_timestamp(call.opens_at)
                     ELSE sympose_canonical_timestamp(event.starts_at) END AS expected_opens_at,
                CASE WHEN call.opens_at IS NOT NULL AND call.closes_at IS NOT NULL
                           AND call.opens_at < call.closes_at
                     THEN sympose_canonical_timestamp(call.closes_at)
                     ELSE sympose_canonical_timestamp(event.ends_at) END AS expected_closes_at
         FROM review_rounds round
         JOIN calls call ON call.id = round.call_id
           AND call.workspace_id = round.workspace_id AND call.event_id = round.event_id
         JOIN events event ON event.id = round.event_id AND event.workspace_id = round.workspace_id
         ORDER BY round.id`,
      ).all();
      const rubricsBefore = v15.prepare(
        `SELECT id, workspace_id, round_id, version_number, fingerprint
         FROM rubric_versions ORDER BY id`,
      ).all();
      expect(roundsBefore.length).toBeGreaterThan(0);
      expect(rubricsBefore.length).toBeGreaterThan(0);
      restoreExactV14(v15);
      closeDb(v15);

      expect(() => openDbForTest({ path, seed: false }, "after-ddl")).toThrow(
        "injected migration failure",
      );
      const rolledBack = new DatabaseSync(path);
      try {
        expect(rolledBack.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
          value: "14",
        });
        expect(
          rolledBack.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_round_schedule_versions'",
          ).get(),
        ).toBeUndefined();
        expect(rolledBack.prepare("SELECT opens_at, closes_at FROM calls WHERE id = ?").get(call.id)).toEqual({
          opens_at: "2026-09-02T00:00:00Z",
          closes_at: "2026-09-20T00:00:00Z",
        });
      } finally {
        rolledBack.close();
      }

      const migrated = openDb({ path, seed: false });
      try {
        expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
          value: "21",
        });
        expect(migrated.prepare(
          `SELECT round.id, round.workspace_id, round.event_id, round.call_id, round.name,
                  schedule.timezone,
                  schedule.opens_at AS expected_opens_at,
                  schedule.closes_at AS expected_closes_at
           FROM review_rounds round
           JOIN review_round_schedule_versions schedule
             ON schedule.round_id = round.id AND schedule.workspace_id = round.workspace_id
            AND schedule.event_id = round.event_id
           WHERE schedule.version_number = 1
           ORDER BY round.id`,
        ).all()).toEqual(roundsBefore);
        expect(migrated.prepare(
          `SELECT id, workspace_id, round_id, version_number, fingerprint
           FROM rubric_versions ORDER BY id`,
        ).all()).toEqual(rubricsBefore);
        expect(migrated.prepare(
          `SELECT version_number, expected_previous_version, source
           FROM review_round_schedule_versions ORDER BY round_id, version_number`,
        ).all()).toEqual(
          roundsBefore.map(() => ({
            version_number: 1,
            expected_previous_version: 0,
            source: "CALL_BACKFILL",
          })),
        );
        expect(() => migrated.prepare(
          "UPDATE review_round_schedule_versions SET closes_at = ? WHERE version_number = 1",
        ).run("2026-12-31T00:00:00.000Z")).toThrow(/immutable/u);
        expect(setOrganizerReviewRoundSchedule(migrated, session, {
          workspaceSlug: "northstar",
          eventId: "migration-event",
          roundId: round.roundId,
          expectedScheduleVersion: 1,
          opensAt: "2026-09-03T00:00:00.000Z",
          closesAt: "2026-09-21T00:00:00.000Z",
          idempotencyKey: "post-migration-schedule-edit",
        })).toMatchObject({ scheduleVersion: 2, replayed: false });
        migrated.prepare("UPDATE calls SET timezone = ? WHERE id = ?")
          .run("America/New_York", call.id);
      } finally {
        closeDb(migrated);
      }

      const reopened = openDb({ path, seed: false });
      try {
        expect(reopened.prepare(
          "SELECT COUNT(*) AS count FROM review_round_schedule_versions",
        ).get()).toEqual({ count: roundsBefore.length + 1 });
        expect(readOrganizerReviewSurface(reopened, session, {
          workspaceSlug: "northstar",
          eventId: "migration-event",
          roundId: round.roundId,
        }).rounds[0]?.schedule).toMatchObject({
          version: 2,
          timezone: "UTC",
          opensAt: "2026-09-03T00:00:00.000Z",
          closesAt: "2026-09-21T00:00:00.000Z",
        });
        expect(reopened.prepare(
          `SELECT call.timezone AS call_timezone, schedule.timezone AS schedule_timezone
           FROM calls call
           JOIN review_rounds round ON round.call_id = call.id
           JOIN review_round_schedule_versions schedule ON schedule.round_id = round.id
           WHERE call.id = ? AND schedule.version_number = 2`,
        ).get(call.id)).toEqual({
          call_timezone: "America/New_York",
          schedule_timezone: "UTC",
        });
        expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(reopened);
      }

      const tampered = new DatabaseSync(path);
      try {
        const immutableTrigger = tampered.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_review_round_schedule_versions_immutable'",
        ).get() as { sql: string };
        const otherWorkspace = tampered.prepare(
          "SELECT id FROM workspaces WHERE slug = 'acme'",
        ).get() as { id: string };
        tampered.exec("DROP TRIGGER trg_review_round_schedule_versions_immutable");
        tampered.prepare(
          "UPDATE review_round_schedule_versions SET workspace_id = ? WHERE round_id = ? AND version_number = 2",
        ).run(otherWorkspace.id, round.roundId);
        tampered.exec(immutableTrigger.sql);
      } finally {
        tampered.close();
      }
      expect(() => openDb({ path, seed: false })).toThrow(
        "malformed review-round schedule history",
      );
    } finally {
      removeDatabase(path);
    }
  });
});
