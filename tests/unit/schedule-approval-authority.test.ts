import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, fingerprintOf } from "@/server/canonical";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_REVIEWER_ACCOUNT_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "@/server/evaluator-demo";
import { seedWorkspaces } from "@/server/seed";
import { sealRelease } from "@/server/services/publication";
import {
  approveScheduleDraft,
  readCurrentScheduleApproval,
  readScheduleApprovalEvidence,
  scheduleApprovalSubject,
  ScheduleApprovalError,
} from "@/server/services/scheduling/approval";
import { executeScheduleDraftCommand, readScheduleDraft } from "@/server/services/scheduling/persistence";

const scope = { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID } as const;
const temporaryDirectories: string[] = [];

function eventCount(db: Db): number {
  return (db.prepare(
    "SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ? AND event_type = 'organizer.schedule.approved' AND aggregate_id = ?",
  ).get(scope.workspaceId, scope.eventId) as { count: number }).count;
}

function auditCount(db: Db): number {
  return (db.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action = 'schedule.approved' AND target_id = ?",
  ).get(scope.workspaceId, scope.eventId) as { count: number }).count;
}

function expectApprovalCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("expected schedule approval to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduleApprovalError);
    expect((error as ScheduleApprovalError).code).toBe(code);
  }
}

function seed(db: Db): void {
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
}

function authorityFingerprint(db: Db): string {
  const current = readScheduleDraft(db, scope);
  if (!current.pointer) throw new Error("schedule approval test pointer unavailable");
  return fingerprintOf(scheduleApprovalSubject(current.pointer));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable schedule approval authority", () => {
  it("persists one exact paired receipt and validates it after database reload", () => {
    const directory = mkdtempSync(join(process.cwd(), ".schedule-approval-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sympose.db");
    let db = openDb({ path, seed: false });
    seed(db);

    const approval = readCurrentScheduleApproval(db, scope);
    expect(approval).toMatchObject({
      capability: "phase0.pipeline.manage",
      approvedByAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      scheduleRevision: expect.any(Number),
      scheduleAuthorityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(eventCount(db)).toBe(1);
    expect(auditCount(db)).toBe(1);
    const releaseContent = JSON.parse((db.prepare(
      `SELECT content_json AS contentJson FROM publication_releases
        WHERE workspace_id = ? AND event_id = ? ORDER BY rowid DESC LIMIT 1`,
    ).get(scope.workspaceId, scope.eventId) as { contentJson: string }).contentJson) as {
      schedule: Record<string, unknown>;
    };
    expect(releaseContent.schedule).toMatchObject({
      schema: "publication-schedule/v2",
      sourceScheduleApprovalId: approval!.approvalEventId,
      sourceScheduleApprovalAuditId: approval!.approvalAuditId,
      sourceScheduleApprovalFingerprint: approval!.approvalFingerprint,
      scheduleFingerprint: approval!.scheduleAuthorityFingerprint,
    });
    expect(releaseContent.schedule).not.toHaveProperty("approvedByAccountId");
    expect(releaseContent.schedule).not.toHaveProperty("approvedAt");

    closeDb(db);
    db = openDb({ path, seed: false });
    try {
      expect(readCurrentScheduleApproval(db, scope)).toEqual(approval);
      expect(readScheduleApprovalEvidence(db, scope, approval!.approvalEventId)).toEqual(approval);
    } finally {
      closeDb(db);
    }
  });

  it("rejects a self-consistent approval pair whose stored role does not grant its capability", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      const approval = readCurrentScheduleApproval(db, scope);
      if (!approval) throw new Error("schedule approval fixture unavailable");
      const publicationBefore = db.prepare(
        `SELECT current_release_id AS currentReleaseId,
                (SELECT COUNT(*) FROM publication_releases
                  WHERE workspace_id = ? AND event_id = ?) AS releaseCount
           FROM events WHERE workspace_id = ? AND id = ?`,
      ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId);
      const approvalEvent = db.prepare(
        `SELECT id, payload_json AS payloadJson
           FROM domain_events
          WHERE workspace_id = ? AND event_type = 'organizer.schedule.approved'
            AND aggregate_type = 'schedule_approval' AND aggregate_id = ?`,
      ).get(scope.workspaceId, scope.eventId) as { id: string; payloadJson: string } | undefined;
      const approvalAudit = db.prepare(
        `SELECT id, details_json AS detailsJson
           FROM audit_events
          WHERE workspace_id = ? AND action = 'schedule.approved'
            AND target_type = 'event' AND target_id = ?`,
      ).get(scope.workspaceId, scope.eventId) as { id: string; detailsJson: string } | undefined;
      if (!approvalEvent || !approvalAudit) throw new Error("schedule approval evidence fixture unavailable");

      const forgedPayload = {
        ...(JSON.parse(approvalEvent.payloadJson) as Record<string, unknown>),
        actorRole: "read_only",
      };
      const forgedPayloadJson = canonicalJson(forgedPayload);
      const forgedPayloadFingerprint = fingerprintOf(forgedPayload);
      const forgedAuditDetails = JSON.parse(approvalAudit.detailsJson) as Record<string, unknown>;
      forgedAuditDetails.actorRole = "read_only";
      forgedAuditDetails.approvalPayloadFingerprint = forgedPayloadFingerprint;

      db.exec(`
        DROP TRIGGER trg_v12_domain_events_immutable;
        DROP TRIGGER trg_audit_immutable;
      `);
      db.prepare(
        "UPDATE domain_events SET payload_json = ?, payload_fingerprint = ? WHERE id = ? AND workspace_id = ?",
      ).run(forgedPayloadJson, forgedPayloadFingerprint, approvalEvent.id, scope.workspaceId);
      db.prepare(
        "UPDATE audit_events SET details_json = ? WHERE id = ? AND workspace_id = ?",
      ).run(JSON.stringify(forgedAuditDetails), approvalAudit.id, scope.workspaceId);

      expect(fingerprintOf(JSON.parse(forgedPayloadJson))).toBe(forgedPayloadFingerprint);
      expect(forgedAuditDetails).toMatchObject({
        approvalEventId: approval.approvalEventId,
        approvalPayloadFingerprint: forgedPayloadFingerprint,
        actorRole: "read_only",
        capability: "phase0.pipeline.manage",
      });
      expectApprovalCode(() => readCurrentScheduleApproval(db, scope), "SCHEDULE_APPROVAL_CORRUPT");
      expectApprovalCode(() => sealRelease(db, scope.workspaceId, scope.eventId, {
        kind: "account",
        ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      }), "SCHEDULE_APPROVAL_CORRUPT");
      expect(db.prepare(
        `SELECT current_release_id AS currentReleaseId,
                (SELECT COUNT(*) FROM publication_releases
                  WHERE workspace_id = ? AND event_id = ?) AS releaseCount
           FROM events WHERE workspace_id = ? AND id = ?`,
      ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId)).toEqual(publicationBefore);
    } finally {
      closeDb(db);
    }
  });

  it("replays the creating key after a later revision and conflicts when that key names new work", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      const initial = readScheduleDraft(db, scope);
      const approval = readCurrentScheduleApproval(db, scope)!;
      const replay = approveScheduleDraft(db, scope, {
        expectedRevision: initial.schedule.revision,
        expectedScheduleAuthorityFingerprint: approval.scheduleAuthorityFingerprint,
        idempotencyKey: "evaluator-demo-schedule-approval-v1",
        requestId: "network-retry-after-success",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      expect(replay).toEqual({ approval, changed: false });
      expect(eventCount(db)).toBe(1);
      expectApprovalCode(() => approveScheduleDraft(db, scope, {
        expectedRevision: initial.schedule.revision,
        expectedScheduleAuthorityFingerprint: "0".repeat(64),
        idempotencyKey: "evaluator-demo-schedule-approval-v1",
        requestId: "same-key-divergent-context",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      }), "SCHEDULE_APPROVAL_IDEMPOTENCY_CONFLICT");
      expectApprovalCode(() => approveScheduleDraft(db, scope, {
        expectedRevision: initial.schedule.revision,
        expectedScheduleAuthorityFingerprint: "0".repeat(64),
        idempotencyKey: "unseen-same-revision-context",
        requestId: "unseen-same-revision-context-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      }), "SCHEDULE_APPROVAL_CONTEXT_CONFLICT");
      expect(eventCount(db)).toBe(1);

      const placement = initial.schedule.sessions[0]!.placement!;
      executeScheduleDraftCommand(db, scope, {
        expectedRevision: initial.schedule.revision,
        planVersionId: initial.schedule.planVersionId,
        planFingerprint: initial.schedule.planFingerprint,
        acceptedInventoryFingerprint: initial.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: initial.schedule.cfpSessionInventoryFingerprint,
        command: { kind: "CLEAR", sessionId: initial.schedule.sessions[0]!.id },
        idempotencyKey: "schedule-approval-clear",
        requestId: "schedule-approval-clear-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      expect(readCurrentScheduleApproval(db, scope)).toBeNull();
      expect(approveScheduleDraft(db, scope, {
        expectedRevision: initial.schedule.revision,
        expectedScheduleAuthorityFingerprint: approval.scheduleAuthorityFingerprint,
        idempotencyKey: "evaluator-demo-schedule-approval-v1",
        requestId: "late-network-retry",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      })).toEqual({ approval, changed: false });
      expectApprovalCode(() => approveScheduleDraft(db, scope, {
        expectedRevision: initial.schedule.revision + 1,
        expectedScheduleAuthorityFingerprint: authorityFingerprint(db),
        idempotencyKey: "evaluator-demo-schedule-approval-v1",
        requestId: "same-key-new-revision",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      }), "SCHEDULE_APPROVAL_IDEMPOTENCY_CONFLICT");
      expectApprovalCode(() => approveScheduleDraft(db, scope, {
        expectedRevision: initial.schedule.revision + 1,
        expectedScheduleAuthorityFingerprint: authorityFingerprint(db),
        idempotencyKey: "unplaced-approval",
        requestId: "unplaced-approval-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      }), "SCHEDULE_APPROVAL_NOT_READY");
      expect(eventCount(db)).toBe(1);

      const cleared = readScheduleDraft(db, scope);
      executeScheduleDraftCommand(db, scope, {
        expectedRevision: cleared.schedule.revision,
        planVersionId: cleared.schedule.planVersionId,
        planFingerprint: cleared.schedule.planFingerprint,
        acceptedInventoryFingerprint: cleared.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: cleared.schedule.cfpSessionInventoryFingerprint,
        command: {
          kind: "MOVE",
          sessionId: cleared.schedule.sessions[0]!.id,
          target: {
            dayId: placement.dayId,
            timeSlotId: placement.timeSlotId,
            roomId: placement.roomId,
            trackId: placement.trackId,
          },
        },
        idempotencyKey: "schedule-approval-move-back",
        requestId: "schedule-approval-move-back-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      const restored = readScheduleDraft(db, scope);
      const next = approveScheduleDraft(db, scope, {
        expectedRevision: restored.schedule.revision,
        expectedScheduleAuthorityFingerprint: authorityFingerprint(db),
        idempotencyKey: "restored-schedule-approval",
        requestId: "restored-schedule-approval-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      expect(next.changed).toBe(true);
      expect(next.approval.scheduleRevision).toBe(initial.schedule.revision + 2);
      expect(readCurrentScheduleApproval(db, scope)?.approvalEventId).toBe(next.approval.approvalEventId);
      expect(eventCount(db)).toBe(2);
    } finally {
      closeDb(db);
    }
  });

  it("keeps approval through view-only pointer persistence and denies unauthorized or non-durable approval without writes", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      const initial = readScheduleDraft(db, scope);
      const approval = readCurrentScheduleApproval(db, scope)!;
      executeScheduleDraftCommand(db, scope, {
        expectedRevision: initial.schedule.revision,
        planVersionId: initial.schedule.planVersionId,
        planFingerprint: initial.schedule.planFingerprint,
        acceptedInventoryFingerprint: initial.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: initial.schedule.cfpSessionInventoryFingerprint,
        command: { kind: "AUTO_PLACE", reason: "Persist active-day view only" },
        activeDayId: initial.schedule.days[0]!.id,
        idempotencyKey: "schedule-approval-view-only",
        requestId: "schedule-approval-view-only-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      expect(readCurrentScheduleApproval(db, scope)?.approvalEventId).toBe(approval.approvalEventId);

      const beforeEvents = eventCount(db);
      const beforeAudits = auditCount(db);
      expectApprovalCode(() => approveScheduleDraft(db, scope, {
        expectedRevision: initial.schedule.revision,
        expectedScheduleAuthorityFingerprint: approval.scheduleAuthorityFingerprint,
        idempotencyKey: "reviewer-cannot-approve",
        requestId: "reviewer-cannot-approve-request",
        actorAccountId: EVALUATOR_REVIEWER_ACCOUNT_ID,
      }), "SCHEDULE_APPROVAL_AUTHORITY_INVALID");
      expect(eventCount(db)).toBe(beforeEvents);
      expect(auditCount(db)).toBe(beforeAudits);

      const current = readScheduleDraft(db, scope);
      executeScheduleDraftCommand(db, scope, {
        expectedRevision: current.schedule.revision,
        planVersionId: current.schedule.planVersionId,
        planFingerprint: current.schedule.planFingerprint,
        acceptedInventoryFingerprint: current.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: current.schedule.cfpSessionInventoryFingerprint,
        command: {
          kind: "CONFIGURE",
          rooms: current.schedule.rooms.map((room) => ({ ...room, venue: "Durability test venue" })),
          tracks: current.schedule.tracks,
        },
        idempotencyKey: "schedule-approval-new-durable-revision",
        requestId: "schedule-approval-new-durable-revision-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      db.prepare(
        "DELETE FROM event_session_allocations WHERE workspace_id = ? AND event_id = ?",
      ).run(scope.workspaceId, scope.eventId);
      const changed = readScheduleDraft(db, scope);
      expectApprovalCode(() => approveScheduleDraft(db, scope, {
        expectedRevision: changed.schedule.revision,
        expectedScheduleAuthorityFingerprint: authorityFingerprint(db),
        idempotencyKey: "non-durable-approval",
        requestId: "non-durable-approval-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      }), "SCHEDULE_APPROVAL_NOT_DURABLE");
      expect(eventCount(db)).toBe(beforeEvents);
      expect(auditCount(db)).toBe(beforeAudits);
    } finally {
      closeDb(db);
    }
  });

  it("rejects an extra active allocation outside the complete canonical schedule set", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      const current = readScheduleDraft(db, scope);
      executeScheduleDraftCommand(db, scope, {
        expectedRevision: current.schedule.revision,
        planVersionId: current.schedule.planVersionId,
        planFingerprint: current.schedule.planFingerprint,
        acceptedInventoryFingerprint: current.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: current.schedule.cfpSessionInventoryFingerprint,
        command: {
          kind: "CONFIGURE",
          rooms: current.schedule.rooms.map((room) => ({ ...room, venue: "Complete-set test venue" })),
          tracks: current.schedule.tracks,
        },
        idempotencyKey: "schedule-approval-complete-set-revision",
        requestId: "schedule-approval-complete-set-revision-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      db.prepare(
        `INSERT INTO program_units
           (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
         VALUES ('hidden-active-unit', ?, ?, 'Hidden active unit', 'session',
                 '2026-09-18T14:00:00.000Z', '2026-09-18T14:30:00.000Z', 10,
                 '2026-08-13T00:00:00.000Z')`,
      ).run(scope.workspaceId, scope.eventId);
      db.prepare(
        `INSERT INTO event_session_allocations
           (id, workspace_id, event_id, program_unit_id, room_id, track_id,
            starts_at, ends_at, allocation_status, created_at, updated_at)
         VALUES ('hidden-active-allocation', ?, ?, 'hidden-active-unit', 'room-default',
                 'track-default', '2026-09-18T14:00:00.000Z', '2026-09-18T14:30:00.000Z',
                 'DRAFT', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
      ).run(scope.workspaceId, scope.eventId);
      const changed = readScheduleDraft(db, scope);
      expectApprovalCode(() => approveScheduleDraft(db, scope, {
        expectedRevision: changed.schedule.revision,
        expectedScheduleAuthorityFingerprint: authorityFingerprint(db),
        idempotencyKey: "extra-active-allocation-approval",
        requestId: "extra-active-allocation-approval-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      }), "SCHEDULE_APPROVAL_NOT_DURABLE");
      expect(eventCount(db)).toBe(1);
    } finally {
      closeDb(db);
    }
  });
});
