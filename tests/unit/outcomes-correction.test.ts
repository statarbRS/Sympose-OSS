import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSession, DenialError } from "@/server/auth";
import { deterministicUuid, fingerprintOf } from "@/server/canonical";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID,
  EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  EVALUATOR_EVENT_ID,
  seedEvaluatorDemo,
} from "@/server/evaluator-demo";
import { EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID } from "@/server/evaluator-compatibility";
import { seedWorkspaces } from "@/server/seed";
import { DDL } from "@/server/schema";
import {
  correctOperationsAttendance,
  getOperationsObservationSurface,
  OperationsAttendanceError,
  recordAttendance,
  recordOperationsAttendance,
} from "@/server/services/outcomes";

const REASON = "Registrant confirmed that the check-in was accidental.";
const OBSERVED_AT = "2027-09-16T10:15:00.000Z";
const RECORDED_AT = "2027-09-16T10:30:00.000Z";
const tempRoots: string[] = [];

type Fixture = {
  readonly db: Db;
  readonly session: ReturnType<typeof createSession>["session"];
};

function fixture(path = ":memory:"): Fixture {
  vi.useRealTimers();
  const db = openDb({ path, seed: false });
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(RECORDED_AT));
  db.prepare(
    "UPDATE events SET lifecycle = 'live' WHERE workspace_id = ? AND id = ?",
  ).run(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
  const session = createSession(
    db,
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  ).session;
  return { db, session };
}

function businessCounts(db: Db): { observations: number; corrections: number; auditEvents: number } {
  return {
    observations: (db.prepare("SELECT COUNT(*) AS count FROM observations").get() as { count: number }).count,
    corrections: (db.prepare("SELECT COUNT(*) AS count FROM observation_corrections").get() as { count: number }).count,
    auditEvents: (db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count,
  };
}

function attendanceKey(): string {
  return `attendance-observation:v1:${fingerprintOf({
    schema: "attendance-observation-key/v1",
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
    observedMeaning: "ATTENDED",
  })}`;
}

function correctionKey(originalObservationId: string): string {
  return `attendance-correction:v1:${fingerprintOf({
    schema: "attendance-correction-key/v1",
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    originalObservationId,
    correctedMeaning: "DID_NOT_ATTEND",
  })}`;
}

function correctionFingerprint(originalObservationId: string, reason = REASON): string {
  return fingerprintOf({
    schema: "attendance-correction-command/v1",
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    originalObservationId,
    correctedMeaning: "DID_NOT_ATTEND",
    reason,
  });
}

function releaseSnapshot(db: Db): unknown {
  return db.prepare(
    `SELECT event_row.current_plan_version_id AS currentPlanVersionId,
            event_row.current_release_id AS currentReleaseId,
            release.fingerprint,
            release.content_json AS contentJson
     FROM events event_row
     JOIN publication_releases release
       ON release.id = event_row.current_release_id
      AND release.workspace_id = event_row.workspace_id
      AND release.event_id = event_row.id
     WHERE event_row.workspace_id = ? AND event_row.id = ?`,
  ).get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
}

function upstreamTruthSnapshot(db: Db): unknown {
  const scope = [EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID] as const;
  return {
    event: db.prepare(
      `SELECT current_plan_version_id AS currentPlanVersionId,
              current_release_id AS currentReleaseId
       FROM events WHERE workspace_id = ? AND id = ?`,
    ).get(...scope),
    plans: db.prepare(
      `SELECT id, version_number AS versionNumber, fingerprint, content_json AS contentJson
       FROM plan_versions WHERE workspace_id = ? AND event_id = ? ORDER BY id`,
    ).all(...scope),
    assignments: db.prepare(
      `SELECT assignment.id, assignment.plan_version_id AS planVersionId,
              assignment.person_id AS personId, assignment.program_unit_id AS programUnitId,
              assignment.assignment_type AS assignmentType
       FROM plan_assignments assignment
       JOIN plan_versions plan
         ON plan.id = assignment.plan_version_id AND plan.workspace_id = assignment.workspace_id
       WHERE plan.workspace_id = ? AND plan.event_id = ? ORDER BY assignment.id`,
    ).all(...scope),
    states: db.prepare(
      `SELECT state_row.id, state_row.plan_version_id AS planVersionId, state_row.state,
              state_row.actor_account_id AS actorAccountId, state_row.reason, state_row.created_at AS createdAt
       FROM plan_states state_row
       JOIN plan_versions plan
         ON plan.id = state_row.plan_version_id AND plan.workspace_id = state_row.workspace_id
       WHERE plan.workspace_id = ? AND plan.event_id = ? ORDER BY state_row.id`,
    ).all(...scope),
    approvals: db.prepare(
      `SELECT id, plan_version_id AS planVersionId, actor_account_id AS actorAccountId,
              decision, created_at AS createdAt
       FROM approvals WHERE workspace_id = ? AND event_id = ? ORDER BY id`,
    ).all(...scope),
    offers: db.prepare(
      `SELECT id, plan_version_id AS planVersionId, person_id AS personId, terms_json AS termsJson,
              terms_fingerprint AS termsFingerprint, status, created_at AS createdAt
       FROM commitment_offers WHERE workspace_id = ? AND event_id = ? ORDER BY id`,
    ).all(...scope),
    responses: db.prepare(
      `SELECT response.id, response.offer_id AS offerId, response.response,
              response.responded_at AS respondedAt, response.actor_person_id AS actorPersonId
       FROM commitment_responses response
       JOIN commitment_offers offer
         ON offer.id = response.offer_id AND offer.workspace_id = response.workspace_id
       WHERE offer.workspace_id = ? AND offer.event_id = ? ORDER BY response.id`,
    ).all(...scope),
    releases: db.prepare(
      `SELECT id, plan_version_id AS planVersionId, fingerprint, content_json AS contentJson,
              sealed_at AS sealedAt
       FROM publication_releases WHERE workspace_id = ? AND event_id = ? ORDER BY id`,
    ).all(...scope),
  };
}

function record(f: Fixture) {
  return recordOperationsAttendance(f.db, f.session, {
    eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
    observedAt: OBSERVED_AT,
  });
}

function addSecondCurrentPlanAssignment(db: Db): string {
  const plan = db.prepare(
    `SELECT current_plan_version_id AS planVersionId
     FROM events WHERE workspace_id = ? AND id = ?`,
  ).get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID) as {
    planVersionId: string;
  };
  const secondUnitId = deterministicUuid("operations-correction:second-unit");
  db.prepare(
    `INSERT INTO program_units
       (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
     VALUES (?, ?, ?, 'Second current-plan unit', 'SESSION',
             '2027-09-16T14:00:00.000Z', '2027-09-16T14:45:00.000Z', 40,
             '2026-08-14T00:00:00.000Z')`,
  ).run(secondUnitId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
  db.prepare(
    `INSERT INTO plan_assignments
       (id, workspace_id, plan_version_id, person_id, program_unit_id,
        assignment_type, explanation, is_pinned)
     VALUES (?, ?, ?, ?, ?, 'SPEAKER', 'Synthetic second current-plan assignment', 0)`,
  ).run(
    deterministicUuid("operations-correction:second-assignment"),
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    plan.planVersionId,
    EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    secondUnitId,
  );
  return secondUnitId;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(RECORDED_AT));
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operations attendance correction lineage", () => {
  it("records and corrects once, replays exactly, and preserves sealed truth", () => {
    const f = fixture();
    const sealedBefore = releaseSnapshot(f.db);
    const upstreamBefore = upstreamTruthSnapshot(f.db);
    const before = businessCounts(f.db);

    const created = record(f);
    expect(created).toMatchObject({
      disposition: "created",
      state: "current",
      observedAt: OBSERVED_AT,
      recordedAt: RECORDED_AT,
    });
    expect(created.observedAt).not.toBe(created.recordedAt);
    expect(record(f)).toEqual({ ...created, disposition: "replayed" });
    const beforeMismatchedReplay = businessCounts(f.db);
    expect(() => recordOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      observedAt: "2027-09-16T10:16:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_IDEMPOTENCY_CONFLICT" }));
    expect(businessCounts(f.db)).toEqual(beforeMismatchedReplay);
    expect(businessCounts(f.db)).toEqual({
      observations: before.observations + 1,
      corrections: before.corrections,
      auditEvents: before.auditEvents + 1,
    });

    const corrected = correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: created.observationId,
      reason: REASON,
    });
    expect(corrected).toMatchObject({
      disposition: "created",
      originalObservationId: created.observationId,
    });
    expect(correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: created.observationId,
      reason: REASON,
    })).toEqual({ ...corrected, disposition: "replayed" });
    expect(() => correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: created.observationId,
      reason: "Registrant supplied a conflicting correction reason.",
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_IDEMPOTENCY_CONFLICT" }));

    expect(businessCounts(f.db)).toEqual({
      observations: before.observations + 2,
      corrections: before.corrections + 1,
      auditEvents: before.auditEvents + 2,
    });
    const surface = getOperationsObservationSurface(f.db, f.session, EVALUATOR_COMPATIBILITY_EVENT_ID);
    expect(surface.targets).toContainEqual(expect.objectContaining({
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
    }));
    expect(surface.lineages).toEqual([
      expect.objectContaining({
        originalObservationId: created.observationId,
        meaning: "ATTENDED",
        observedAt: OBSERVED_AT,
        recordedAt: RECORDED_AT,
        state: "superseded",
        correction: expect.objectContaining({
          observationId: corrected.correctionObservationId,
          meaning: "DID_NOT_ATTEND",
          reason: REASON,
          actorRole: "organizer",
          state: "current",
        }),
      }),
    ]);
    expect(releaseSnapshot(f.db)).toEqual(sealedBefore);
    expect(upstreamTruthSnapshot(f.db)).toEqual(upstreamBefore);

    const rawRows = f.db.prepare(
      `SELECT id, observation_type AS type, source, observed_at AS observedAt,
              recorded_at AS recordedAt
       FROM observations WHERE id IN (?, ?) ORDER BY id`,
    ).all(created.observationId, corrected.correctionObservationId);
    expect(rawRows).toHaveLength(2);
    expect(rawRows).toContainEqual(expect.objectContaining({
      type: "attendance",
      source: "organizer-live-operations",
      observedAt: OBSERVED_AT,
      recordedAt: RECORDED_AT,
    }));
    expect(rawRows).toContainEqual(expect.objectContaining({
      type: "attendance_not_attended",
      source: "organizer-live-operations-correction",
    }));
    expect(() => f.db.prepare("UPDATE observations SET source = source WHERE id = ?").run(created.observationId)).toThrow(/observations is immutable/);
    expect(() => f.db.prepare("DELETE FROM observations WHERE id = ?").run(corrected.correctionObservationId)).toThrow(/observations is immutable/);
    expect(() => f.db.prepare("UPDATE observation_corrections SET reason = reason WHERE id = ?").run(corrected.relationId)).toThrow(/observation_corrections is immutable/);
    expect(() => f.db.prepare("DELETE FROM observation_corrections WHERE id = ?").run(corrected.relationId)).toThrow(/retained for history/);
    closeDb(f.db);
  });

  it("rolls back observation and correction lineage atomically when audit persistence fails", () => {
    const f = fixture();
    const beforeRecord = businessCounts(f.db);
    f.db.exec(`
      CREATE TEMP TRIGGER reject_recording_audit_for_test
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'outcome.attendance.recorded'
      BEGIN SELECT RAISE(ABORT, 'synthetic recording audit failure'); END;
    `);
    expect(() => record(f)).toThrow(/synthetic recording audit failure/);
    expect(businessCounts(f.db)).toEqual(beforeRecord);
    f.db.exec("DROP TRIGGER reject_recording_audit_for_test");

    const original = record(f);
    const beforeCorrection = businessCounts(f.db);
    f.db.exec(`
      CREATE TEMP TRIGGER reject_correction_audit_for_test
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'outcome.attendance.corrected'
      BEGIN SELECT RAISE(ABORT, 'synthetic correction audit failure'); END;
    `);
    expect(() => correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: original.observationId,
      reason: REASON,
    })).toThrow(/synthetic correction audit failure/);
    expect(businessCounts(f.db)).toEqual(beforeCorrection);
    closeDb(f.db);
  });

  it("derives authority from a current persisted session and denies scoped or malformed writes", () => {
    const f = fixture();
    const before = businessCounts(f.db);
    expect(() => recordOperationsAttendance(f.db, null, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      observedAt: OBSERVED_AT,
    })).toThrow(DenialError);
    expect(businessCounts(f.db)).toEqual(before);

    const readOnlyId = deterministicUuid("operations-correction:read-only");
    f.db.prepare(
      `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
       VALUES (?, ?, 'read-only@devflow.example', 'Read only operator', 'read_only', '2026-08-14T00:00:00.000Z')`,
    ).run(readOnlyId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID);
    const readOnly = createSession(f.db, readOnlyId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID).session;
    const beforeReadOnlyCommand = businessCounts(f.db);
    expect(() => recordOperationsAttendance(f.db, readOnly, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      observedAt: OBSERVED_AT,
    })).toThrowError(expect.objectContaining({ code: "CAPABILITY_DENIED" }));
    expect(businessCounts(f.db)).toEqual({
      observations: beforeReadOnlyCommand.observations,
      corrections: beforeReadOnlyCommand.corrections,
      auditEvents: beforeReadOnlyCommand.auditEvents + 1,
    });

    const acmeWorkspaceId = deterministicUuid("workspace:acme");
    const acmeAccountId = deterministicUuid("account:acme-organizer");
    const foreign = createSession(f.db, acmeAccountId, acmeWorkspaceId).session;
    const beforeScopedCommands = businessCounts(f.db);
    expect(() => recordOperationsAttendance(f.db, foreign, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      observedAt: OBSERVED_AT,
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_TARGET_NOT_FOUND" }));
    expect(() => recordOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: deterministicUuid("workspace:acme:person"),
      programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      observedAt: OBSERVED_AT,
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_TARGET_NOT_FOUND" }));
    expect(() => recordOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      programUnitId: deterministicUuid("evaluator-demo:program-unit:acme"),
      observedAt: OBSERVED_AT,
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_TARGET_NOT_FOUND" }));
    expect(() => correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: deterministicUuid("missing-observation"),
      reason: REASON,
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_SOURCE_NOT_FOUND" }));
    for (const reason of ["short", "untrimmed reason ", "invalid\ncontrol reason", "x".repeat(281)]) {
      expect(() => correctOperationsAttendance(f.db, f.session, {
        eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
        originalObservationId: deterministicUuid("missing-observation"),
        reason,
      })).toThrow(OperationsAttendanceError);
    }
    expect(businessCounts(f.db)).toEqual(beforeScopedCommands);

    const original = record(f);
    const beforeUnauthenticatedCorrection = businessCounts(f.db);
    expect(() => correctOperationsAttendance(f.db, null, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: original.observationId,
      reason: REASON,
    })).toThrow(DenialError);
    expect(businessCounts(f.db)).toEqual(beforeUnauthenticatedCorrection);
    expect(() => correctOperationsAttendance(f.db, readOnly, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: original.observationId,
      reason: REASON,
    })).toThrowError(expect.objectContaining({ code: "CAPABILITY_DENIED" }));
    expect(businessCounts(f.db)).toEqual({
      observations: beforeUnauthenticatedCorrection.observations,
      corrections: beforeUnauthenticatedCorrection.corrections,
      auditEvents: beforeUnauthenticatedCorrection.auditEvents + 1,
    });
    closeDb(f.db);
  });

  it("rejects ambiguous attendance and freezes new records after closure while allowing correction", () => {
    const f = fixture();
    const created = record(f);
    f.db.prepare(
      `INSERT INTO observations
         (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
          observed_at, source, idempotency_key, recorded_at)
       VALUES (?, ?, ?, ?, ?, 'attendance', ?, 'hostile-test-fixture', ?, ?)`,
    ).run(
      deterministicUuid("ambiguous-attendance"),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      new Date(Date.parse(created.observedAt) + 1).toISOString(),
      "hostile-ambiguous-attendance",
      created.recordedAt,
    );
    const beforeCorrection = businessCounts(f.db);
    expect(() => correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: created.observationId,
      reason: REASON,
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_SOURCE_AMBIGUOUS" }));
    expect(businessCounts(f.db)).toEqual(beforeCorrection);
    closeDb(f.db);

    const closed = fixture();
    closed.db.prepare("UPDATE events SET lifecycle = 'closed' WHERE workspace_id = ? AND id = ?")
      .run(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
    const closedBefore = businessCounts(closed.db);
    expect(() => record(closed)).toThrowError(expect.objectContaining({ code: "ATTENDANCE_EVENT_CLOSED" }));
    expect(() => recordAttendance(
      closed.db,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      OBSERVED_AT,
      `attendance:${EVALUATOR_COMPATIBILITY_EVENT_ID}:` +
        `${EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID}:${EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID}`,
      { kind: "account", ref: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID },
    )).toThrowError(expect.objectContaining({ code: "ATTENDANCE_EVENT_CLOSED" }));
    expect(businessCounts(closed.db)).toEqual(closedBefore);
    closed.db.prepare("UPDATE events SET lifecycle = 'live' WHERE workspace_id = ? AND id = ?")
      .run(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
    const original = record(closed);
    closed.db.prepare("UPDATE events SET lifecycle = 'closed' WHERE workspace_id = ? AND id = ?")
      .run(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
    expect(record(closed)).toEqual({ ...original, disposition: "replayed" });
    expect(correctOperationsAttendance(closed.db, closed.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: original.observationId,
      reason: REASON,
    }).disposition).toBe("created");
    closeDb(closed.db);

    const crossPath = fixture();
    const crossPathOriginal = record(crossPath);
    const beforeLegacyDuplicate = businessCounts(crossPath.db);
    expect(recordAttendance(
      crossPath.db,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      OBSERVED_AT,
      `attendance:${EVALUATOR_COMPATIBILITY_EVENT_ID}:` +
        `${EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID}:${EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID}`,
      { kind: "account", ref: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID },
    )).toMatchObject({
      observationId: crossPathOriginal.observationId,
      created: false,
      previousObservationId: crossPathOriginal.observationId,
      observedAt: OBSERVED_AT,
      recordedAt: RECORDED_AT,
    });
    expect(businessCounts(crossPath.db)).toEqual(beforeLegacyDuplicate);
    closeDb(crossPath.db);
  });

  it("denies draft, planning, published, and future-event attendance with zero business writes", () => {
    for (const lifecycle of ["draft", "planning", "published"] as const) {
      const f = fixture();
      f.db.prepare(
        "UPDATE events SET lifecycle = ? WHERE workspace_id = ? AND id = ?",
      ).run(lifecycle, EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
      const before = businessCounts(f.db);
      expect(() => record(f)).toThrowError(expect.objectContaining({
        code: "ATTENDANCE_EVENT_NOT_LIVE",
      }));
      expect(businessCounts(f.db)).toEqual(before);
      closeDb(f.db);
    }

    const future = fixture();
    vi.setSystemTime(new Date("2027-09-15T10:30:00.000Z"));
    const beforeFuture = businessCounts(future.db);
    expect(() => record(future)).toThrowError(expect.objectContaining({
      code: "ATTENDANCE_TIME_INVALID",
    }));
    expect(businessCounts(future.db)).toEqual(beforeFuture);
    closeDb(future.db);
  });

  it("routes the existing dashboard command into the same correctable one-shot lineage", () => {
    const root = mkdtempSync(join(tmpdir(), "sympose-outcome-dashboard-lineage-"));
    tempRoots.push(root);
    const path = join(root, "dashboard-lineage.db");
    const f = fixture(path);
    const dashboardKey = `attendance:${EVALUATOR_COMPATIBILITY_EVENT_ID}:` +
      `${EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID}:${EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID}`;
    const dashboardReceipt = recordAttendance(
      f.db,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      OBSERVED_AT,
      dashboardKey,
      { kind: "account", ref: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID },
    );
    expect(dashboardReceipt.created).toBe(true);
    expect(f.db.prepare(
      `SELECT source, idempotency_key AS idempotencyKey
       FROM observations WHERE id = ?`,
    ).get(dashboardReceipt.observationId)).toEqual({
      source: "organizer-live-operations",
      idempotencyKey: attendanceKey(),
    });
    closeDb(f.db);
    const reopened = openDb({ path, seed: false });
    const reopenedFixture: Fixture = { db: reopened, session: f.session };

    expect(record(reopenedFixture)).toMatchObject({
      disposition: "replayed",
      observationId: dashboardReceipt.observationId,
    });
    expect(getOperationsObservationSurface(
      reopened,
      f.session,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
    ).lineages).toContainEqual(expect.objectContaining({
      originalObservationId: dashboardReceipt.observationId,
      state: "current",
    }));
    expect(correctOperationsAttendance(reopened, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: dashboardReceipt.observationId,
      reason: REASON,
    }).disposition).toBe("created");
    expect(recordAttendance(
      reopened,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      OBSERVED_AT,
      dashboardKey,
      { kind: "account", ref: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID },
    )).toMatchObject({
      created: false,
      observationId: dashboardReceipt.observationId,
    });
    closeDb(reopened);
  });

  it("returns an honest empty surface before an event has an approved plan", () => {
    const f = fixture();
    const eventId = deterministicUuid("operations-correction:no-plan-event");
    f.db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, 'No-plan operations event', 'UTC',
               '2027-10-01T09:00:00.000Z', '2027-10-01T17:00:00.000Z', 'planning',
               '2026-08-14T00:00:00.000Z')`,
    ).run(eventId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID);
    expect(getOperationsObservationSurface(f.db, f.session, eventId)).toEqual({
      targets: [],
      lineages: [],
    });
    closeDb(f.db);
  });

  it("rejects an incomplete self-hashed offer after trigger restoration and reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "sympose-incomplete-offer-"));
    tempRoots.push(root);
    const path = join(root, "incomplete-offer.db");
    const f = fixture(path);
    const stored = f.db.prepare(
      `SELECT terms_json AS termsJson
       FROM commitment_offers
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).get(
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    ) as { termsJson: string };
    const complete = JSON.parse(stored.termsJson) as Record<string, unknown>;
    const incomplete = {
      schema: "commitment-offer-terms/v1",
      planVersionId: complete.planVersionId,
      eventId: complete.eventId,
      programUnitId: complete.programUnitId,
      role: complete.role,
    };
    f.db.exec("DROP TRIGGER trg_offers_immutable");
    f.db.prepare(
      `UPDATE commitment_offers SET terms_json = ?, terms_fingerprint = ?
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).run(
      JSON.stringify(incomplete),
      fingerprintOf(incomplete),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    );
    f.db.exec(DDL);
    closeDb(f.db);

    const reopened = openDb({ path, seed: false });
    const before = businessCounts(reopened);
    expect(getOperationsObservationSurface(
      reopened,
      f.session,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
    ).targets).toEqual([]);
    expect(() => record({ db: reopened, session: f.session })).toThrowError(expect.objectContaining({
      code: "ATTENDANCE_TARGET_NOT_FOUND",
    }));
    expect(businessCounts(reopened)).toEqual(before);
    closeDb(reopened);
  });

  it("rejects duplicate-key or malformed accepted-offer JSON without attendance writes", () => {
    for (const kind of ["duplicate-key", "malformed"] as const) {
      const f = fixture();
      const stored = f.db.prepare(
        `SELECT terms_json AS termsJson
         FROM commitment_offers
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
      ).get(
        EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
        EVALUATOR_COMPATIBILITY_EVENT_ID,
        EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      ) as { termsJson: string };
      const canonical = JSON.parse(stored.termsJson) as Record<string, unknown>;
      const termsJson = kind === "duplicate-key"
        ? `{"planVersionId":${JSON.stringify(canonical.planVersionId)},` +
          `"eventId":${JSON.stringify(canonical.eventId)},` +
          `"programUnitId":${JSON.stringify(canonical.programUnitId)},` +
          `"role":${JSON.stringify(canonical.role)},"programUnitId":"forged-unit"}`
        : "{";
      const termsFingerprint = kind === "duplicate-key"
        ? fingerprintOf(JSON.parse(termsJson) as unknown)
        : "0".repeat(64);
      f.db.exec("DROP TRIGGER trg_offers_immutable");
      f.db.prepare(
        `UPDATE commitment_offers SET terms_json = ?, terms_fingerprint = ?
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
      ).run(
        termsJson,
        termsFingerprint,
        EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
        EVALUATOR_COMPATIBILITY_EVENT_ID,
        EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      );
      f.db.exec(DDL);

      const before = businessCounts(f.db);
      expect(getOperationsObservationSurface(
        f.db,
        f.session,
        EVALUATOR_COMPATIBILITY_EVENT_ID,
      ).targets).toEqual([]);
      expect(() => record(f)).toThrowError(expect.objectContaining({
        code: "ATTENDANCE_TARGET_NOT_FOUND",
      }));
      expect(businessCounts(f.db)).toEqual(before);
      closeDb(f.db);
    }
  });

  it("fails closed for revoked or malformed target authority without rejecting another assignment", () => {
    const multiAssignment = fixture();
    const secondUnitId = addSecondCurrentPlanAssignment(multiAssignment.db);
    const afterSecondAssignment = getOperationsObservationSurface(
      multiAssignment.db,
      multiAssignment.session,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
    );
    expect(afterSecondAssignment.targets).toContainEqual(expect.objectContaining({
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
    }));
    expect(afterSecondAssignment.targets).not.toContainEqual(expect.objectContaining({
      programUnitId: secondUnitId,
    }));
    expect(record(multiAssignment).disposition).toBe("created");
    closeDb(multiAssignment.db);

    const superseded = fixture();
    const plan = superseded.db.prepare(
      `SELECT current_plan_version_id AS planVersionId
       FROM events WHERE workspace_id = ? AND id = ?`,
    ).get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID) as {
      planVersionId: string;
    };
    superseded.db.prepare(
      `INSERT INTO plan_states
         (id, workspace_id, plan_version_id, state, actor_account_id, reason, created_at)
       VALUES (?, ?, ?, 'superseded', ?, 'Synthetic authority revocation', '2098-01-01T00:00:00.000Z')`,
    ).run(
      deterministicUuid("operations-correction:superseded-plan"),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      plan.planVersionId,
      EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    );
    const beforeSupersededCommand = businessCounts(superseded.db);
    expect(() => getOperationsObservationSurface(
      superseded.db,
      superseded.session,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
    )).toThrowError(expect.objectContaining({ code: "ATTENDANCE_TARGET_NOT_FOUND" }));
    expect(() => record(superseded)).toThrowError(expect.objectContaining({
      code: "ATTENDANCE_TARGET_NOT_FOUND",
    }));
    expect(businessCounts(superseded.db)).toEqual(beforeSupersededCommand);
    closeDb(superseded.db);

    const malformedLifecycle = fixture();
    malformedLifecycle.db.prepare(
      "UPDATE events SET lifecycle = 'forged-live-state' WHERE workspace_id = ? AND id = ?",
    ).run(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
    const beforeMalformedCommand = businessCounts(malformedLifecycle.db);
    expect(() => record(malformedLifecycle)).toThrowError(expect.objectContaining({
      code: "ATTENDANCE_TARGET_NOT_FOUND",
    }));
    expect(() => getOperationsObservationSurface(
      malformedLifecycle.db,
      malformedLifecycle.session,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
    )).toThrowError(expect.objectContaining({ code: "ATTENDANCE_TARGET_NOT_FOUND" }));
    expect(businessCounts(malformedLifecycle.db)).toEqual(beforeMalformedCommand);
    closeDb(malformedLifecycle.db);

    const stalePointer = fixture();
    const pointed = stalePointer.db.prepare(
      `SELECT plan.id AS planVersionId, plan.run_id AS runId, plan.version_number AS versionNumber
       FROM events event_row
       JOIN plan_versions plan
         ON plan.id = event_row.current_plan_version_id
        AND plan.workspace_id = event_row.workspace_id
       WHERE event_row.workspace_id = ? AND event_row.id = ?`,
    ).get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID) as {
      planVersionId: string;
      runId: string;
      versionNumber: number;
    };
    const newerPlanId = deterministicUuid("operations-correction:newer-approved-plan");
    stalePointer.db.prepare(
      `INSERT INTO plan_versions
         (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', '2026-08-14T00:00:00.000Z')`,
    ).run(
      newerPlanId,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      pointed.runId,
      pointed.versionNumber + 1,
      fingerprintOf({ schema: "stale-pointer-test/v1", newerPlanId }),
    );
    stalePointer.db.prepare(
      `INSERT INTO approvals
         (id, workspace_id, event_id, plan_version_id, actor_account_id, decision, created_at)
       VALUES (?, ?, ?, ?, ?, 'approved', '2026-08-14T00:00:01.000Z')`,
    ).run(
      deterministicUuid("operations-correction:newer-approval"),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      newerPlanId,
      EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    );
    stalePointer.db.prepare(
      `INSERT INTO plan_states
         (id, workspace_id, plan_version_id, state, actor_account_id, reason, created_at)
       VALUES (?, ?, ?, 'approved', ?, NULL, '2026-08-14T00:00:01.000Z')`,
    ).run(
      deterministicUuid("operations-correction:newer-approved-state"),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      newerPlanId,
      EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    );
    const beforeStalePointerCommand = businessCounts(stalePointer.db);
    expect(() => getOperationsObservationSurface(
      stalePointer.db,
      stalePointer.session,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
    )).toThrowError(expect.objectContaining({ code: "ATTENDANCE_TARGET_NOT_FOUND" }));
    expect(() => record(stalePointer)).toThrowError(expect.objectContaining({
      code: "ATTENDANCE_TARGET_NOT_FOUND",
    }));
    expect(businessCounts(stalePointer.db)).toEqual(beforeStalePointerCommand);
    closeDb(stalePointer.db);

    const forgedTerms = fixture();
    const storedTerms = forgedTerms.db.prepare(
      `SELECT terms_json AS termsJson
       FROM commitment_offers
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).get(
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    ) as { termsJson: string };
    const scheduleDrift = {
      ...(JSON.parse(storedTerms.termsJson) as Record<string, unknown>),
      startsAt: "2027-09-16T10:01:00.000Z",
    };
    forgedTerms.db.exec("DROP TRIGGER trg_offers_immutable");
    forgedTerms.db.prepare(
      `UPDATE commitment_offers SET terms_json = ?, terms_fingerprint = ?
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).run(
      JSON.stringify(scheduleDrift),
      fingerprintOf(scheduleDrift),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    );
    forgedTerms.db.exec(DDL);
    const beforeForgedTermsCommand = businessCounts(forgedTerms.db);
    expect(getOperationsObservationSurface(
      forgedTerms.db,
      forgedTerms.session,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
    ).targets).toEqual([]);
    expect(() => record(forgedTerms)).toThrowError(expect.objectContaining({
      code: "ATTENDANCE_TARGET_NOT_FOUND",
    }));
    expect(businessCounts(forgedTerms.db)).toEqual(beforeForgedTermsCommand);
    closeDb(forgedTerms.db);
  }, 10_000);

  it("rejects wrong-scope sources, already-corrected sources, self-links, and mismatched tuples without writes", () => {
    const f = fixture();
    const original = record(f);
    const afterRecord = businessCounts(f.db);

    expect(() => f.db.prepare(
      `INSERT INTO observations
         (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
          observed_at, source, idempotency_key, corrected_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, 'attendance', ?, 'hostile-test-fixture', ?, ?, ?)`,
    ).run(
      deterministicUuid("operations-correction:legacy-corrected-by-write"),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      OBSERVED_AT,
      "hostile-legacy-corrected-by-write",
      deterministicUuid("operations-correction:covert-lineage"),
      RECORDED_AT,
    )).toThrow(/observation V19 authority or chronology mismatch/);
    expect(businessCounts(f.db)).toEqual(afterRecord);

    const siblingEventId = deterministicUuid("operations-correction:same-workspace-sibling-event");
    f.db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, 'Synthetic sibling event', 'UTC',
               '2027-10-01T09:00:00.000Z', '2027-10-01T17:00:00.000Z', 'planning',
               '2026-08-14T00:00:00.000Z')`,
    ).run(siblingEventId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID);
    expect(() => correctOperationsAttendance(f.db, f.session, {
      eventId: siblingEventId,
      originalObservationId: original.observationId,
      reason: REASON,
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_SOURCE_NOT_FOUND" }));
    expect(businessCounts(f.db)).toEqual(afterRecord);

    expect(() => correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_EVENT_ID,
      originalObservationId: original.observationId,
      reason: REASON,
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_TARGET_NOT_FOUND" }));
    expect(businessCounts(f.db)).toEqual(afterRecord);

    const foreignSession = createSession(
      f.db,
      deterministicUuid("account:acme-organizer"),
      deterministicUuid("workspace:acme"),
    ).session;
    expect(() => correctOperationsAttendance(f.db, foreignSession, {
      eventId: EVALUATOR_EVENT_ID,
      originalObservationId: original.observationId,
      reason: REASON,
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_SOURCE_NOT_FOUND" }));
    expect(businessCounts(f.db)).toEqual(afterRecord);

    const correctedAt = new Date(Date.parse(original.observedAt) + 1).toISOString();
    const key = correctionKey(original.observationId);
    expect(() => f.db.prepare(
      `INSERT INTO observation_corrections
         (id, workspace_id, original_observation_id, correction_observation_id, reason,
          actor_account_id, actor_role, corrected_at, idempotency_key, command_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, 'organizer', ?, ?, ?)`,
    ).run(
      deterministicUuid("operations-correction:self-link"),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      original.observationId,
      original.observationId,
      REASON,
      EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
      correctedAt,
      key,
      correctionFingerprint(original.observationId),
    )).toThrow();
    expect(businessCounts(f.db)).toEqual(afterRecord);

    const wrongUnitId = deterministicUuid("operations-correction:wrong-unit");
    f.db.prepare(
      `INSERT INTO program_units
         (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
       VALUES (?, ?, ?, 'Wrong tuple unit', 'SESSION', ?, ?, 1, ?)`,
    ).run(
      wrongUnitId,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      "2027-09-16T15:00:00.000Z",
      "2027-09-16T16:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
    );
    for (const [suffix, personId, programUnitId] of [
      ["wrong-person", EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID, EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID],
      ["wrong-unit", EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, wrongUnitId],
    ] as const) {
      f.db.exec("BEGIN IMMEDIATE");
      try {
        const correctionObservationId = deterministicUuid(`operations-correction:${suffix}:observation`);
        f.db.prepare(
          `INSERT INTO observations
             (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
              observed_at, source, idempotency_key, recorded_at)
           VALUES (?, ?, ?, ?, ?, 'attendance_not_attended', ?,
                   'organizer-live-operations-correction', ?, ?)`,
        ).run(
          correctionObservationId,
          EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
          EVALUATOR_COMPATIBILITY_EVENT_ID,
          personId,
          programUnitId,
          correctedAt,
          key,
          correctedAt,
        );
        expect(() => f.db.prepare(
          `INSERT INTO observation_corrections
             (id, workspace_id, original_observation_id, correction_observation_id, reason,
              actor_account_id, actor_role, corrected_at, idempotency_key, command_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, 'organizer', ?, ?, ?)`,
        ).run(
          deterministicUuid(`operations-correction:${suffix}:relation`),
          EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
          original.observationId,
          correctionObservationId,
          REASON,
          EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
          correctedAt,
          key,
          correctionFingerprint(original.observationId),
        )).toThrow(/observation correction .*lineage mismatch/);
      } finally {
        f.db.exec("ROLLBACK");
      }
      expect(businessCounts(f.db)).toEqual(afterRecord);
    }

    const correction = correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: original.observationId,
      reason: REASON,
    });
    const afterCorrection = businessCounts(f.db);
    expect(() => correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: correction.correctionObservationId,
      reason: REASON,
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_SOURCE_NOT_FOUND" }));
    expect(() => correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: original.observationId,
      reason: "Registrant supplied a conflicting correction reason.",
    })).toThrowError(expect.objectContaining({ code: "ATTENDANCE_IDEMPOTENCY_CONFLICT" }));
    expect(businessCounts(f.db)).toEqual(afterCorrection);
    closeDb(f.db);
  });

  it("survives file close/reopen and rejects trigger-bypassed erased lineage", () => {
    const root = mkdtempSync(join(tmpdir(), "sympose-outcome-correction-"));
    tempRoots.push(root);
    const path = join(root, "lineage.db");
    const f = fixture(path);
    const original = record(f);
    const correction = correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: original.observationId,
      reason: REASON,
    });
    const viewerAccountId = deterministicUuid("operations-correction:reopen-viewer");
    f.db.prepare(
      `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
       VALUES (?, ?, 'reopen-viewer@devflow.example', 'Reopen viewer', 'organizer', '2026-08-14T00:00:00.000Z')`,
    ).run(viewerAccountId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID);
    const viewerSession = createSession(f.db, viewerAccountId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID).session;
    f.db.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ? AND workspace_id = ?")
      .run(EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID, EVALUATOR_COMPATIBILITY_WORKSPACE_ID);
    closeDb(f.db);

    const reopened = openDb({ path, seed: false });
    expect(getOperationsObservationSurface(reopened, viewerSession, EVALUATOR_COMPATIBILITY_EVENT_ID).lineages[0])
      .toMatchObject({
        originalObservationId: original.observationId,
        state: "superseded",
        correction: { actorRole: "organizer" },
      });
    reopened.exec("DROP TRIGGER trg_observation_corrections_no_delete");
    reopened.prepare("DELETE FROM observation_corrections WHERE id = ?").run(correction.relationId);
    reopened.exec(DDL);
    closeDb(reopened);
    expect(() => openDb({ path, seed: false })).toThrow(/malformed observation correction history/);
  });

  it("rejects trigger-bypassed malformed lineage after the exact V19 manifest is restored", () => {
    const root = mkdtempSync(join(tmpdir(), "sympose-outcome-correction-malformed-"));
    tempRoots.push(root);
    const path = join(root, "malformed-lineage.db");
    const f = fixture(path);
    const original = record(f);
    const correction = correctOperationsAttendance(f.db, f.session, {
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      originalObservationId: original.observationId,
      reason: REASON,
    });
    const forgedReason = "A coherent but unaudited reason rewrite.";
    f.db.exec("DROP TRIGGER trg_observation_corrections_immutable");
    f.db.prepare(
      "UPDATE observation_corrections SET reason = ?, command_fingerprint = ? WHERE id = ?",
    ).run(
      forgedReason,
      correctionFingerprint(original.observationId, forgedReason),
      correction.relationId,
    );
    f.db.exec(DDL);
    closeDb(f.db);

    expect(() => openDb({ path, seed: false })).toThrow(/malformed observation correction history/);
  });

  it("rejects non-null legacy corrected_by after trigger restoration and reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "sympose-legacy-corrected-by-"));
    tempRoots.push(root);
    const path = join(root, "legacy-corrected-by.db");
    const f = fixture(path);
    const original = record(f);
    f.db.exec("DROP TRIGGER trg_observations_immutable");
    f.db.prepare("UPDATE observations SET corrected_by = ? WHERE id = ?").run(
      deterministicUuid("legacy-corrected-by:covert-lineage"),
      original.observationId,
    );
    f.db.exec(DDL);
    closeDb(f.db);

    expect(() => openDb({ path, seed: false })).toThrow(/malformed observation correction history/);
  });

  it("rejects duplicate-key attendance audit JSON after trigger restoration and reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "sympose-duplicate-audit-"));
    tempRoots.push(root);
    const path = join(root, "duplicate-audit.db");
    const f = fixture(path);
    const original = record(f);
    const duplicateDetails = `{"eventId":"forged-event","eventId":${JSON.stringify(EVALUATOR_COMPATIBILITY_EVENT_ID)},` +
      `"personId":${JSON.stringify(EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID)},` +
      `"programUnitId":${JSON.stringify(EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID)},` +
      `"observedMeaning":"ATTENDED"}`;
    expect(JSON.parse(duplicateDetails)).toEqual({
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      programUnitId: EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      observedMeaning: "ATTENDED",
    });
    f.db.exec("DROP TRIGGER trg_audit_immutable");
    f.db.prepare(
      `UPDATE audit_events SET details_json = ?
       WHERE workspace_id = ? AND action = 'outcome.attendance.recorded'
         AND target_type = 'observation' AND target_id = ?`,
    ).run(
      duplicateDetails,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      original.observationId,
    );
    f.db.exec(DDL);
    closeDb(f.db);

    expect(() => openDb({ path, seed: false })).toThrow(/malformed observation correction history/);
  });

  it("rejects a feature-owned original without its immutable recording audit on reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "sympose-outcome-original-audit-"));
    tempRoots.push(root);
    const path = join(root, "forged-original.db");
    const f = fixture(path);
    f.db.prepare(
      `INSERT INTO observations
         (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
          observed_at, source, idempotency_key, recorded_at)
       VALUES (?, ?, ?, ?, ?, 'attendance', ?, 'organizer-live-operations', ?, ?)`,
    ).run(
      deterministicUuid("operations-correction:unaudited-original"),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
      OBSERVED_AT,
      attendanceKey(),
      RECORDED_AT,
    );
    closeDb(f.db);

    expect(() => openDb({ path, seed: false })).toThrow(/malformed observation correction history/);
  });
});
