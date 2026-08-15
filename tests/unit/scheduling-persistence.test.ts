import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import { canonicalJson, deterministicUuid, fingerprintOf } from "../../src/server/canonical";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_PROGRAM_UNIT_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import {
  commitmentResponseCommandKey,
  deliverOffers,
  nextPendingOffer,
  respondToOfferCommand,
} from "../../src/server/services/commitments";
import { approvePlan, compilePlan } from "../../src/server/services/planning";
import { readCanonicalScheduleAuthorityAt } from "../../src/server/services/scheduling/canonical";
import {
  executeScheduleDraftCommand,
  MAX_SCHEDULE_DRAFT_BYTES,
  parseScheduleDraftCommand,
  readScheduleDraft,
  SCHEDULE_DRAFT_EVENT_SCHEMA,
  SchedulePersistenceError,
} from "../../src/server/services/scheduling/persistence";
import { hasSelectedScheduleConflict } from "../../src/server/services/publication-schedule";
import type { ScheduleDraftCommand, ScheduleDraftPointer, ScheduleSnapshot } from "../../src/server/services/scheduling";

const SCOPE = { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID } as const;
const AUTHORITY_COLLISION_AT = "2026-08-13T01:00:00.000Z";
const NONCANONICAL_AUTHORITY_COLLISION_AT = "2026-08-13T01:00:00Z";
const FOREIGN_WORKSPACE_ID = deterministicUuid("workspace:northstar");
const SCHEDULE_DRAFT_AUDIT_SCHEMA = "organizer-schedule-draft-audit/v1";

interface StoredScheduleDraftPayload {
  readonly schema: typeof SCHEDULE_DRAFT_EVENT_SCHEMA;
  readonly requestFingerprint: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly pointer: ScheduleDraftPointer;
}

function seedCanonicalDb(path = ":memory:"): Db {
  const db = openDb({ path, seed: false });
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  return db;
}

function context(schedule: ScheduleSnapshot) {
  return {
    planVersionId: schedule.planVersionId,
    planFingerprint: schedule.planFingerprint,
    acceptedInventoryFingerprint: schedule.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: schedule.cfpSessionInventoryFingerprint,
  };
}

function moveInput(
  db: Db,
  idempotencyKey: string,
  requestId = `${idempotencyKey}-request`,
): {
  expectedRevision: number;
  planVersionId: string;
  planFingerprint: string;
  acceptedInventoryFingerprint: string;
  cfpSessionInventoryFingerprint: string;
  command: ScheduleDraftCommand;
  idempotencyKey: string;
  requestId: string;
} {
  const schedule = readScheduleDraft(db, SCOPE).schedule;
  const target = schedule.timeSlots.find((slot) => slot.startsAt === "2026-09-18T09:00:00.000Z");
  if (!target) throw new Error("canonical test slot missing");
  return {
    expectedRevision: schedule.revision,
    ...context(schedule),
    command: {
      kind: "MOVE",
      sessionId: EVALUATOR_PROGRAM_UNIT_ID,
      target: { dayId: target.dayId, timeSlotId: target.id, roomId: "room-default", trackId: "track-default" },
      reason: "Focused persistence test move",
    },
    idempotencyKey,
    requestId,
  };
}

function eventCount(db: Db): number {
  return (db.prepare(
    `SELECT COUNT(*) AS count FROM domain_events
      WHERE workspace_id = ? AND event_type = 'organizer.schedule_draft.saved'`,
  ).get(EVALUATOR_WORKSPACE_ID) as { count: number }).count;
}

function replaceScheduleAuthorityAtCollision(db: Db, draftKey: string, acceptV2 = true) {
  const savedV1 = executeScheduleDraftCommand(db, SCOPE, {
    ...moveInput(db, draftKey),
    actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
  });
  db.prepare(
    "DELETE FROM event_session_allocations WHERE workspace_id = ? AND event_id = ? AND program_unit_id = ?",
  ).run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_PROGRAM_UNIT_ID);
  db.prepare("UPDATE events SET name = ? WHERE workspace_id = ? AND id = ?")
    .run("Renamed Evaluator Summit", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID);
  db.prepare(
    `UPDATE program_units
        SET name = ?, starts_at = ?, ends_at = ?
      WHERE workspace_id = ? AND event_id = ? AND id = ?`,
  ).run(
    "Renamed Trustworthy Evaluation Keynote",
    "2026-09-18T11:00:00.000Z",
    "2026-09-18T12:00:00.000Z",
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_EVENT_ID,
    EVALUATOR_PROGRAM_UNIT_ID,
  );

  const actor = { kind: "account" as const, ref: EVALUATOR_ORGANIZER_ACCOUNT_ID };
  const planV2 = compilePlan(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, actor);
  expect(planV2).toMatchObject({ created: true, versionNumber: 2, status: "FEASIBLE" });
  approvePlan(
    db,
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_EVENT_ID,
    planV2.planVersionId,
    savedV1.pointer.planVersionId,
    actor,
  );
  deliverOffers(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, actor);
  const offerV2 = nextPendingOffer(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID);
  if (!offerV2) throw new Error("expected a pending v2 offer");
  expect(offerV2.planVersionId).toBe(planV2.planVersionId);
  if (acceptV2) {
    respondToOfferCommand(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, {
      offerId: offerV2.id,
      response: "accepted",
      commandKey: commitmentResponseCommandKey(offerV2.id, "accepted"),
    });
  }
  return { savedV1, planV2, offerV2 };
}

function scheduleDraftAuditDetails(
  domainEventId: string,
  payloadFingerprint: string,
  stored: StoredScheduleDraftPayload,
  changed = true,
): Record<string, unknown> {
  return {
    schema: SCHEDULE_DRAFT_AUDIT_SCHEMA,
    changed,
    revision: stored.pointer.revision,
    requestFingerprint: stored.requestFingerprint,
    idempotencyKey: stored.idempotencyKey,
    requestId: stored.requestId,
    domainEventId,
    domainEventPayloadFingerprint: payloadFingerprint,
    pointerFingerprint: fingerprintOf(stored.pointer),
  };
}

function insertScheduleDraftEvent(
  db: Db,
  stored: StoredScheduleDraftPayload,
  domainEventId: string,
  createdAt = AUTHORITY_COLLISION_AT,
): { readonly payloadJson: string; readonly payloadFingerprint: string } {
  const payloadJson = canonicalJson(stored);
  const payloadFingerprint = fingerprintOf(stored);
  db.prepare(
    `INSERT INTO domain_events
       (id, workspace_id, event_type, aggregate_type, aggregate_id,
        payload_json, payload_fingerprint, created_at)
     VALUES (?, ?, 'organizer.schedule_draft.saved', 'schedule_draft', ?, ?, ?, ?)`,
  ).run(
    domainEventId,
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_EVENT_ID,
    payloadJson,
    payloadFingerprint,
    createdAt,
  );
  return { payloadJson, payloadFingerprint };
}

function insertStaleDraftEvidence(
  db: Db,
  pointer: ScheduleDraftPointer,
  key: string,
  auditWorkspaceId: string,
): void {
  const requestFingerprint = fingerprintOf({ schema: "forged-schedule-request/v1", key });
  const stored: StoredScheduleDraftPayload = {
    schema: SCHEDULE_DRAFT_EVENT_SCHEMA,
    requestFingerprint,
    idempotencyKey: key,
    requestId: `${key}-request`,
    pointer,
  };
  const domainEventId = `${key}-event`;
  const { payloadFingerprint } = insertScheduleDraftEvent(db, stored, domainEventId);
  db.prepare(
    `INSERT INTO audit_events
       (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, 'system', 'schedule-test', 'schedule.draft.saved', 'event', ?, ?, ?)`,
  ).run(
    `${key}-audit`,
    auditWorkspaceId,
    EVALUATOR_EVENT_ID,
    JSON.stringify(scheduleDraftAuditDetails(domainEventId, payloadFingerprint, stored)),
    AUTHORITY_COLLISION_AT,
  );
}

describe("server-persisted organizer schedule drafts", () => {
  it("fails closed for an empty canonical state without creating a synthetic schedule or event", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run("empty-workspace", "empty", "Empty", "2026-08-13T00:00:00.000Z");
      db.prepare(
        `INSERT INTO events
           (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
         VALUES (?, ?, 'Empty event', 'UTC', '2026-09-18T09:00:00.000Z', '2026-09-18T17:00:00.000Z', 'planning', ?)`,
      ).run("empty-event", "empty-workspace", "2026-08-13T00:00:00.000Z");
      expect(() => readScheduleDraft(db, { workspaceId: "empty-workspace", eventId: "empty-event" })).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_CANONICAL_UNAVAILABLE" }),
      );
      expect((db.prepare("SELECT COUNT(*) AS count FROM domain_events").get() as { count: number }).count).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("persists the exact approved-plan and accepted-inventory pointer context across reopen", () => {
    const directory = mkdtempSync(join(process.cwd(), ".schedule-persistence-"));
    const path = join(directory, "schedule.db");
    let db = seedCanonicalDb(path);
    let savedRevision = 0;
    try {
      const input = moveInput(db, "canonical-move-1");
      const beforeEvents = eventCount(db);
      const saved = executeScheduleDraftCommand(db, SCOPE, { ...input, actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID });
      savedRevision = saved.schedule.revision;
      expect(saved.pointer.planVersionId).toBe(saved.schedule.planVersionId);
      expect(saved.pointer.planFingerprint).toBe(saved.schedule.planFingerprint);
      expect(saved.pointer.acceptedInventoryFingerprint).toBe(saved.schedule.acceptedInventoryFingerprint);
      expect(eventCount(db)).toBe(beforeEvents + 1);
      closeDb(db);

      db = openDb({ path, seed: false });
      const loaded = readScheduleDraft(db, SCOPE);
      expect(loaded.persisted).toBe(true);
      expect(loaded.schedule.revision).toBe(savedRevision);
      expect(loaded.pointer).toMatchObject(context(loaded.schedule));
      expect(loaded.schedule.sessions.find((session) => session.id === EVALUATOR_PROGRAM_UNIT_ID)?.placement).toMatchObject({
        timeSlotId: "slot-2026-09-18-0900-1700",
        roomId: "room-default",
      });
    } finally {
      closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reopens the selected configured pointer without replaying old geometry against current resources", () => {
    const directory = mkdtempSync(join(process.cwd(), ".schedule-configured-replay-"));
    const path = join(directory, "schedule.db");
    let db = seedCanonicalDb(path);
    try {
      const initial = readScheduleDraft(db, SCOPE).schedule;
      const configured = executeScheduleDraftCommand(db, SCOPE, {
        expectedRevision: initial.revision,
        ...context(initial),
        command: {
          kind: "CONFIGURE",
          rooms: [
            ...initial.rooms,
            { id: "room-workshop", name: "Workshop Annex", venue: "Organizer configured", capacity: 96 },
          ],
          tracks: [
            ...initial.tracks,
            { id: "track-workshop", name: "Workshop Track", ordinal: initial.tracks.length + 1 },
          ],
          reason: "Add the workshop resources",
        },
        idempotencyKey: "configured-replay-resources",
        requestId: "configured-replay-resources-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      const session = configured.schedule.sessions.find((candidate) => candidate.id === EVALUATOR_PROGRAM_UNIT_ID);
      if (!session?.placement) throw new Error("configured replay fixture lost its placement");
      const moved = executeScheduleDraftCommand(db, SCOPE, {
        expectedRevision: configured.schedule.revision,
        ...context(configured.schedule),
        command: {
          kind: "MOVE",
          sessionId: session.id,
          target: {
            dayId: session.placement.dayId,
            timeSlotId: session.placement.timeSlotId,
            roomId: "room-workshop",
            trackId: "track-workshop",
          },
          reason: "Move to the added workshop resources",
        },
        idempotencyKey: "configured-replay-move",
        requestId: "configured-replay-move-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      expect(moved.schedule.revision).toBe(configured.schedule.revision + 1);
      expect(moved.schedule.sessions.find((candidate) => candidate.id === EVALUATOR_PROGRAM_UNIT_ID))
        .toMatchObject({ trackId: "track-default", placement: { trackId: "track-workshop" } });
      closeDb(db);

      db = openDb({ path, seed: false });
      const loaded = readScheduleDraft(db, SCOPE);
      expect(loaded).toMatchObject({ persisted: true });
      expect(loaded.schedule.sessions.find((candidate) => candidate.id === EVALUATOR_PROGRAM_UNIT_ID))
        .toMatchObject({
          trackId: "track-default",
          placement: { roomId: "room-workshop", trackId: "track-workshop" },
        });
      expect(loaded.schedule.rooms.map((room) => room.id)).toContain("room-workshop");
      expect(loaded.schedule.tracks.map((track) => track.id)).toContain("track-workshop");
    } finally {
      closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconstructs renamed v1 authority across an exact timestamp collision and materializes current v2", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T01:00:00.000Z"));
    const db = seedCanonicalDb();
    try {
      const { savedV1, planV2, offerV2 } = replaceScheduleAuthorityAtCollision(db, "rename-transition-v1");
      const v1CutoffRow = db.prepare(
        `SELECT id AS auditEventId, created_at AS at
           FROM audit_events
          WHERE workspace_id = ? AND action = 'schedule.draft.saved'
            AND target_type = 'event' AND target_id = ?
          ORDER BY rowid DESC LIMIT 1`,
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { auditEventId: string; at: string };
      const v1Cutoff = { auditEventId: v1CutoffRow.auditEventId, at: v1CutoffRow.at };
      const collisionTimes = db.prepare(
        `SELECT plan.created_at AS planCreatedAt,
                approval.created_at AS approvalCreatedAt,
                MAX(state.created_at) AS stateCreatedAt,
                offer.created_at AS offerCreatedAt,
                response.responded_at AS respondedAt
           FROM plan_versions plan
           JOIN approvals approval
             ON approval.workspace_id = plan.workspace_id
            AND approval.event_id = plan.event_id
            AND approval.plan_version_id = plan.id
           JOIN plan_states state
             ON state.workspace_id = plan.workspace_id
            AND state.plan_version_id = plan.id
           JOIN commitment_offers offer
             ON offer.workspace_id = plan.workspace_id
            AND offer.event_id = plan.event_id
            AND offer.plan_version_id = plan.id
            AND offer.id = ?
           JOIN commitment_responses response
             ON response.workspace_id = offer.workspace_id
            AND response.offer_id = offer.id
          WHERE plan.workspace_id = ? AND plan.event_id = ? AND plan.id = ?`,
      ).get(
        offerV2.id,
        EVALUATOR_WORKSPACE_ID,
        EVALUATOR_EVENT_ID,
        planV2.planVersionId,
      ) as Record<string, string>;
      expect(v1Cutoff.at).toBe(AUTHORITY_COLLISION_AT);
      expect(Object.values(collisionTimes)).toEqual(Array(5).fill(AUTHORITY_COLLISION_AT));

      expect(readCanonicalScheduleAuthorityAt(db, SCOPE, v1Cutoff)).toEqual({
        planVersionId: savedV1.pointer.planVersionId,
        planFingerprint: savedV1.pointer.planFingerprint,
        acceptedInventoryFingerprint: savedV1.pointer.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: savedV1.pointer.cfpSessionInventoryFingerprint,
        cfpSessionAuthorities: savedV1.pointer.cfpSessionAuthorities,
      });
      const currentV2 = readScheduleDraft(db, SCOPE);
      expect(currentV2).toMatchObject({ persisted: false, pointer: null });
      expect(currentV2.schedule).toMatchObject({
        planVersionId: planV2.planVersionId,
        event: { name: "Renamed Evaluator Summit" },
      });
      expect(currentV2.schedule.sessions).toEqual([
        expect.objectContaining({
          id: EVALUATOR_PROGRAM_UNIT_ID,
          title: "Renamed Trustworthy Evaluation Keynote",
          placement: expect.objectContaining({
            startsAt: "2026-09-18T11:00:00.000Z",
            endsAt: "2026-09-18T12:00:00.000Z",
          }),
        }),
      ]);

      const beforeEvents = eventCount(db);
      const materializeV2 = {
        expectedRevision: currentV2.schedule.revision,
        ...context(currentV2.schedule),
        command: { kind: "AUTO_PLACE" as const, reason: "Materialize the current v2 authority" },
        idempotencyKey: "rename-transition-v2-materialize",
        requestId: "rename-transition-v2-materialize-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      };
      const materializedV2 = executeScheduleDraftCommand(db, SCOPE, materializeV2);
      expect(materializedV2).toMatchObject({ changed: false, persisted: true });
      expect(materializedV2.pointer.planVersionId).toBe(planV2.planVersionId);
      expect(eventCount(db)).toBe(beforeEvents + 1);
      expect(db.prepare(
        `SELECT starts_at AS startsAt, ends_at AS endsAt, allocation_status AS allocationStatus
           FROM event_session_allocations
          WHERE workspace_id = ? AND event_id = ? AND program_unit_id = ?`,
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_PROGRAM_UNIT_ID)).toEqual({
        startsAt: "2026-09-18T11:00:00.000Z",
        endsAt: "2026-09-18T12:00:00.000Z",
        allocationStatus: "DRAFT",
      });
      expect(readScheduleDraft(db, SCOPE)).toMatchObject({
        persisted: true,
        pointer: { planVersionId: planV2.planVersionId },
        schedule: { planVersionId: planV2.planVersionId },
      });
      const replayedV2 = executeScheduleDraftCommand(db, SCOPE, materializeV2);
      expect(replayedV2).toMatchObject({ changed: false, persisted: true });
      expect(replayedV2.pointer).toEqual(materializedV2.pointer);
      expect(eventCount(db)).toBe(beforeEvents + 1);
    } finally {
      closeDb(db);
      vi.useRealTimers();
    }
  });

  it("rejects an unaudited equal-time v1 copy appended after v2 with only activeDayId changed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AUTHORITY_COLLISION_AT));
    const db = seedCanonicalDb();
    try {
      const { savedV1, planV2 } = replaceScheduleAuthorityAtCollision(db, "copied-v1-source");
      const originalRow = db.prepare(
        `SELECT payload_json AS payloadJson
           FROM domain_events
          WHERE workspace_id = ? AND event_type = 'organizer.schedule_draft.saved'
            AND aggregate_type = 'schedule_draft' AND aggregate_id = ?
            AND json_valid(payload_json)
            AND json_extract(payload_json, '$.idempotencyKey') = ?
          ORDER BY rowid LIMIT 1`,
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, "copied-v1-source") as { payloadJson: string };
      const original = JSON.parse(originalRow.payloadJson) as StoredScheduleDraftPayload;
      expect(original.pointer).toEqual(savedV1.pointer);
      const forged: StoredScheduleDraftPayload = {
        ...original,
        pointer: { ...original.pointer, activeDayId: "day-2026-09-18" },
      };
      const forgedEventId = "copied-v1-active-day-event";
      insertScheduleDraftEvent(db, forged, forgedEventId);

      expect(db.prepare(
        `SELECT COUNT(*) AS count
           FROM audit_events
          WHERE workspace_id = ? AND target_type = 'event' AND target_id = ?
            AND json_valid(details_json)
            AND json_extract(details_json, '$.domainEventId') = ?`,
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, forgedEventId)).toEqual({ count: 0 });
      const beforeRead = eventCount(db);
      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_CONTEXT_CONFLICT" }),
      );
      expect(eventCount(db)).toBe(beforeRead);
      expect(db.prepare(
        "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({
        currentPlanVersionId: planV2.planVersionId,
      });
    } finally {
      closeDb(db);
      vi.useRealTimers();
    }
  });

  it("requires exact audit evidence for a compatible schedule-draft event", () => {
    const db = seedCanonicalDb();
    try {
      executeScheduleDraftCommand(db, SCOPE, moveInput(db, "missing-audit-source"));
      const source = db.prepare(
        `SELECT payload_json AS payloadJson
           FROM domain_events
          WHERE workspace_id = ? AND event_type = 'organizer.schedule_draft.saved'
          ORDER BY rowid DESC LIMIT 1`,
      ).get(EVALUATOR_WORKSPACE_ID) as { payloadJson: string };
      const original = JSON.parse(source.payloadJson) as StoredScheduleDraftPayload;
      const unaudited: StoredScheduleDraftPayload = {
        ...original,
        requestFingerprint: fingerprintOf({ schema: "missing-audit-request/v1" }),
        idempotencyKey: "missing-audit-copy",
        requestId: "missing-audit-copy-request",
      };
      insertScheduleDraftEvent(db, unaudited, "missing-audit-copy-event");

      const beforeRead = eventCount(db);
      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_DRAFT_CORRUPT" }),
      );
      expect(eventCount(db)).toBe(beforeRead);
    } finally {
      closeDb(db);
    }
  });

  it("rejects a writer-shaped compatible draft with noncanonical event and audit timestamps", () => {
    const db = seedCanonicalDb();
    try {
      executeScheduleDraftCommand(db, SCOPE, moveInput(db, "canonical-source"));
      const source = db.prepare(
        `SELECT payload_json AS payloadJson
           FROM domain_events
          WHERE workspace_id = ? AND event_type = 'organizer.schedule_draft.saved'
          ORDER BY rowid DESC LIMIT 1`,
      ).get(EVALUATOR_WORKSPACE_ID) as { payloadJson: string };
      const original = JSON.parse(source.payloadJson) as StoredScheduleDraftPayload;
      const stored: StoredScheduleDraftPayload = {
        ...original,
        requestFingerprint: fingerprintOf({ schema: "noncanonical-time-probe/v1" }),
        idempotencyKey: "noncanonical-time-probe",
        requestId: "noncanonical-time-probe-request",
      };
      const domainEventId = "noncanonical-time-probe-event";
      const { payloadFingerprint } = insertScheduleDraftEvent(
        db,
        stored,
        domainEventId,
        NONCANONICAL_AUTHORITY_COLLISION_AT,
      );
      db.prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, 'system', 'schedule-draft-service', 'schedule.draft.unchanged', 'event', ?, ?, ?)`,
      ).run(
        "noncanonical-time-probe-audit",
        EVALUATOR_WORKSPACE_ID,
        EVALUATOR_EVENT_ID,
        JSON.stringify(scheduleDraftAuditDetails(domainEventId, payloadFingerprint, stored, false)),
        NONCANONICAL_AUTHORITY_COLLISION_AT,
      );

      const beforeRead = eventCount(db);
      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_DRAFT_CORRUPT" }),
      );
      expect(eventCount(db)).toBe(beforeRead);
    } finally {
      closeDb(db);
    }
  });

  it("rejects malformed or mismatched full-pointer audit evidence", () => {
    const db = seedCanonicalDb();
    try {
      executeScheduleDraftCommand(db, SCOPE, moveInput(db, "malformed-audit-source"));
      const source = db.prepare(
        `SELECT payload_json AS payloadJson
           FROM domain_events
          WHERE workspace_id = ? AND event_type = 'organizer.schedule_draft.saved'
          ORDER BY rowid DESC LIMIT 1`,
      ).get(EVALUATOR_WORKSPACE_ID) as { payloadJson: string };
      const original = JSON.parse(source.payloadJson) as StoredScheduleDraftPayload;
      const mismatched: StoredScheduleDraftPayload = {
        ...original,
        requestFingerprint: fingerprintOf({ schema: "malformed-audit-request/v1" }),
        idempotencyKey: "malformed-audit-copy",
        requestId: "malformed-audit-copy-request",
      };
      const domainEventId = "malformed-audit-copy-event";
      const { payloadFingerprint } = insertScheduleDraftEvent(db, mismatched, domainEventId);
      db.prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, 'system', 'schedule-test', 'schedule.draft.saved', 'event', ?, ?, ?)`,
      ).run(
        "malformed-audit-copy-audit",
        EVALUATOR_WORKSPACE_ID,
        EVALUATOR_EVENT_ID,
        JSON.stringify({
          ...scheduleDraftAuditDetails(domainEventId, payloadFingerprint, mismatched),
          pointerFingerprint: "!",
        }),
        AUTHORITY_COLLISION_AT,
      );

      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_DRAFT_CORRUPT" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it("rejects duplicate audit bindings for one immutable schedule-draft event", () => {
    const db = seedCanonicalDb();
    try {
      executeScheduleDraftCommand(db, SCOPE, moveInput(db, "duplicate-audit-source"));
      const audit = db.prepare(
        `SELECT actor_kind AS actorKind, actor_ref AS actorRef, action,
                target_type AS targetType, target_id AS targetId,
                details_json AS detailsJson, created_at AS createdAt
           FROM audit_events
          WHERE workspace_id = ? AND action = 'schedule.draft.saved'
            AND target_type = 'event' AND target_id = ?
          ORDER BY rowid DESC LIMIT 1`,
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as Record<string, string>;
      db.prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "duplicate-schedule-draft-audit",
        EVALUATOR_WORKSPACE_ID,
        audit.actorKind,
        audit.actorRef,
        audit.action,
        audit.targetType,
        audit.targetId,
        audit.detailsJson,
        audit.createdAt,
      );

      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_DRAFT_CORRUPT" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it("rejects a malformed supporting acceptance-audit timestamp at an exact equal-ms cutoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AUTHORITY_COLLISION_AT));
    const db = seedCanonicalDb();
    try {
      const { planV2, offerV2 } = replaceScheduleAuthorityAtCollision(db, "malformed-history-v1", false);
      const commandKey = commitmentResponseCommandKey(offerV2.id, "accepted");
      db.prepare(
        `INSERT INTO commitment_responses
           (id, workspace_id, offer_id, response, responded_at, actor_person_id)
         VALUES (?, ?, ?, 'accepted', ?, ?)`,
      ).run(
        deterministicUuid(`malformed-history-response:${offerV2.id}`),
        EVALUATOR_WORKSPACE_ID,
        offerV2.id,
        AUTHORITY_COLLISION_AT,
        offerV2.personId,
      );
      db.prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, 'person', ?, 'commitment.accepted', 'commitment_offer', ?, ?, '!')`,
      ).run(
        "malformed-history-acceptance-audit",
        EVALUATOR_WORKSPACE_ID,
        offerV2.personId,
        offerV2.id,
        JSON.stringify({
          eventId: EVALUATOR_EVENT_ID,
          planVersionId: planV2.planVersionId,
          termsFingerprint: offerV2.termsFingerprint,
          commandKey,
        }),
      );

      const currentV2 = readScheduleDraft(db, SCOPE);
      expect(currentV2).toMatchObject({ persisted: false, schedule: { planVersionId: planV2.planVersionId } });
      executeScheduleDraftCommand(db, SCOPE, {
        expectedRevision: currentV2.schedule.revision,
        ...context(currentV2.schedule),
        command: { kind: "AUTO_PLACE", reason: "Materialize malformed historical evidence cutoff" },
        idempotencyKey: "malformed-history-v2-materialize",
        requestId: "malformed-history-v2-materialize-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      const cutoff = db.prepare(
        `SELECT id AS auditEventId, created_at AS at
           FROM audit_events
          WHERE workspace_id = ? AND action IN ('schedule.draft.saved', 'schedule.draft.unchanged')
            AND target_type = 'event' AND target_id = ?
          ORDER BY rowid DESC LIMIT 1`,
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { auditEventId: string; at: string };
      expect(cutoff.at).toBe(AUTHORITY_COLLISION_AT);
      expect(() => readCanonicalScheduleAuthorityAt(db, SCOPE, cutoff)).toThrow(
        "historical acceptance audit timestamp is invalid.",
      );
    } finally {
      closeDb(db);
      vi.useRealTimers();
    }
  });

  it("rejects duplicate-key non-writer commitment audit JSON as historical authority", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AUTHORITY_COLLISION_AT));
    const db = seedCanonicalDb();
    try {
      const { planV2, offerV2 } = replaceScheduleAuthorityAtCollision(db, "duplicate-json-v1", false);
      const commandKey = commitmentResponseCommandKey(offerV2.id, "accepted");
      db.prepare(
        `INSERT INTO commitment_responses
           (id, workspace_id, offer_id, response, responded_at, actor_person_id)
         VALUES (?, ?, ?, 'accepted', ?, ?)`,
      ).run(
        deterministicUuid(`duplicate-json-response:${offerV2.id}`),
        EVALUATOR_WORKSPACE_ID,
        offerV2.id,
        AUTHORITY_COLLISION_AT,
        offerV2.personId,
      );
      const duplicatedDetails =
        `{"eventId":${JSON.stringify(EVALUATOR_EVENT_ID)},` +
        `"eventId":${JSON.stringify(EVALUATOR_EVENT_ID)},` +
        `"planVersionId":${JSON.stringify(planV2.planVersionId)},` +
        `"termsFingerprint":${JSON.stringify(offerV2.termsFingerprint)},` +
        `"commandKey":${JSON.stringify(commandKey)}}`;
      expect(Object.keys(JSON.parse(duplicatedDetails))).toHaveLength(4);
      db.prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, 'person', ?, 'commitment.accepted', 'commitment_offer', ?, ?, ?)`,
      ).run(
        "duplicate-json-acceptance-audit",
        EVALUATOR_WORKSPACE_ID,
        offerV2.personId,
        offerV2.id,
        duplicatedDetails,
        AUTHORITY_COLLISION_AT,
      );

      const current = readScheduleDraft(db, SCOPE);
      expect(current.schedule.planVersionId).toBe(planV2.planVersionId);
      executeScheduleDraftCommand(db, SCOPE, {
        expectedRevision: current.schedule.revision,
        ...context(current.schedule),
        command: { kind: "AUTO_PLACE" },
        idempotencyKey: "duplicate-json-v2-materialize",
        requestId: "duplicate-json-v2-materialize-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      const cutoff = db.prepare(
        `SELECT id AS auditEventId, created_at AS at
           FROM audit_events
          WHERE workspace_id = ?
            AND action IN ('schedule.draft.saved', 'schedule.draft.unchanged')
            AND target_type = 'event' AND target_id = ?
          ORDER BY rowid DESC LIMIT 1`,
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { auditEventId: string; at: string };

      expect(() => readCanonicalScheduleAuthorityAt(db, SCOPE, cutoff)).toThrow(
        "historical accepted commitment audit evidence is invalid.",
      );
    } finally {
      closeDb(db);
      vi.useRealTimers();
    }
  });

  it("does not treat a stale v1 draft recorded after the equal-time v2 transition as historical", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AUTHORITY_COLLISION_AT));
    const db = seedCanonicalDb();
    try {
      const { savedV1, planV2 } = replaceScheduleAuthorityAtCollision(db, "late-stale-v1-source");
      insertStaleDraftEvidence(db, savedV1.pointer, "late-stale-v1", EVALUATOR_WORKSPACE_ID);
      const lateCutoff = {
        auditEventId: "late-stale-v1-audit",
        at: AUTHORITY_COLLISION_AT,
      };
      expect(readCanonicalScheduleAuthorityAt(db, SCOPE, lateCutoff)).toMatchObject({
        planVersionId: planV2.planVersionId,
      });
      const beforeRead = eventCount(db);
      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_CONTEXT_CONFLICT" }),
      );
      expect(eventCount(db)).toBe(beforeRead);
      expect(db.prepare(
        "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({
        currentPlanVersionId: planV2.planVersionId,
      });
    } finally {
      closeDb(db);
      vi.useRealTimers();
    }
  });

  it("rejects a normalization-equivalent newer approval timestamp before as-of filtering", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AUTHORITY_COLLISION_AT));
    const db = seedCanonicalDb();
    try {
      expect(Date.parse(NONCANONICAL_AUTHORITY_COLLISION_AT)).toBe(Date.parse(AUTHORITY_COLLISION_AT));
      expect(NONCANONICAL_AUTHORITY_COLLISION_AT).not.toBe(AUTHORITY_COLLISION_AT);
      const { savedV1, planV2 } = replaceScheduleAuthorityAtCollision(db, "noncanonical-v2-approval-v1");
      db.exec("DROP TRIGGER trg_audit_immutable");
      const mutation = db.prepare(
        `UPDATE audit_events
            SET created_at = ?
          WHERE workspace_id = ?
            AND action = 'plan.approved'
            AND target_type = 'plan_version'
            AND target_id = ?`,
      ).run(
        NONCANONICAL_AUTHORITY_COLLISION_AT,
        EVALUATOR_WORKSPACE_ID,
        planV2.planVersionId,
      );
      expect(mutation.changes).toBe(1);
      insertStaleDraftEvidence(db, savedV1.pointer, "noncanonical-v2-approval-stale-v1", EVALUATOR_WORKSPACE_ID);

      expect(() => readCanonicalScheduleAuthorityAt(db, SCOPE, {
        auditEventId: "noncanonical-v2-approval-stale-v1-audit",
        at: AUTHORITY_COLLISION_AT,
      })).toThrow("historical approval audit timestamp is invalid.");
      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_CONTEXT_CONFLICT" }),
      );
    } finally {
      closeDb(db);
      vi.useRealTimers();
    }
  });

  it("rejects a noncanonical v2 approval timestamp hidden behind duplicate-key audit JSON", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AUTHORITY_COLLISION_AT));
    const db = seedCanonicalDb();
    try {
      const { savedV1, planV2 } = replaceScheduleAuthorityAtCollision(
        db,
        "composed-noncanonical-duplicate-v2-approval-v1",
      );
      const approval = db.prepare(
        `SELECT id
           FROM approvals
          WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?
            AND decision = 'approved'
          LIMIT 1`,
      ).get(
        EVALUATOR_WORKSPACE_ID,
        EVALUATOR_EVENT_ID,
        planV2.planVersionId,
      ) as { id: string };
      const duplicatedDetails =
        `{"approvalId":${JSON.stringify(approval.id)},` +
        `"approvalId":${JSON.stringify(approval.id)}}`;
      expect(Object.keys(JSON.parse(duplicatedDetails))).toEqual(["approvalId"]);

      db.exec("DROP TRIGGER trg_audit_immutable");
      const mutation = db.prepare(
        `UPDATE audit_events
            SET created_at = ?, details_json = ?
          WHERE workspace_id = ?
            AND action = 'plan.approved'
            AND target_type = 'plan_version'
            AND target_id = ?`,
      ).run(
        NONCANONICAL_AUTHORITY_COLLISION_AT,
        duplicatedDetails,
        EVALUATOR_WORKSPACE_ID,
        planV2.planVersionId,
      );
      expect(mutation.changes).toBe(1);
      insertStaleDraftEvidence(
        db,
        savedV1.pointer,
        "composed-noncanonical-duplicate-v2-approval-stale-v1",
        EVALUATOR_WORKSPACE_ID,
      );

      expect(() => readCanonicalScheduleAuthorityAt(db, SCOPE, {
        auditEventId: "composed-noncanonical-duplicate-v2-approval-stale-v1-audit",
        at: AUTHORITY_COLLISION_AT,
      })).toThrow("historical approval audit timestamp is invalid.");
      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_CONTEXT_CONFLICT" }),
      );
    } finally {
      closeDb(db);
      vi.useRealTimers();
    }
  });

  it("does not use another workspace's equal-time audit order to authorize a stale draft", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AUTHORITY_COLLISION_AT));
    const db = seedCanonicalDb();
    try {
      const { savedV1, planV2 } = replaceScheduleAuthorityAtCollision(db, "foreign-audit-v1-source");
      insertStaleDraftEvidence(db, savedV1.pointer, "foreign-audit-v1", FOREIGN_WORKSPACE_ID);
      expect(db.prepare(
        `SELECT workspace_id AS workspaceId
           FROM audit_events
          WHERE id = 'foreign-audit-v1-audit'`,
      ).get()).toEqual({ workspaceId: FOREIGN_WORKSPACE_ID });
      const beforeRead = eventCount(db);
      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_CONTEXT_CONFLICT" }),
      );
      expect(eventCount(db)).toBe(beforeRead);
      expect(db.prepare(
        "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({
        currentPlanVersionId: planV2.planVersionId,
      });
    } finally {
      closeDb(db);
      vi.useRealTimers();
    }
  });

  it("replays an identical request but rejects a stale plan pointer before any write", () => {
    const db = seedCanonicalDb();
    try {
      const firstInput = moveInput(db, "canonical-replay-1");
      const first = executeScheduleDraftCommand(db, SCOPE, firstInput);
      const replay = executeScheduleDraftCommand(db, SCOPE, firstInput);
      expect(replay.changed).toBe(false);
      expect(replay.pointer).toEqual(first.pointer);
      const before = eventCount(db);

      db.prepare("UPDATE events SET current_plan_version_id = NULL WHERE workspace_id = ? AND id = ?")
        .run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID);
      expect(() => executeScheduleDraftCommand(db, SCOPE, {
        ...firstInput,
        idempotencyKey: "canonical-plan-drift",
        requestId: "canonical-plan-drift-request",
      })).toThrowError(expect.objectContaining({ code: "SCHEDULE_CANONICAL_UNAVAILABLE" }));
      expect(eventCount(db)).toBe(before);
    } finally {
      closeDb(db);
    }
  });

  it("rejects moved accepted terms without writing a draft event", () => {
    const db = seedCanonicalDb();
    try {
      const input = moveInput(db, "canonical-accepted-time-drift");
      const before = eventCount(db);
      db.prepare("UPDATE program_units SET starts_at = ? WHERE workspace_id = ? AND event_id = ? AND id = ?")
        .run("2026-09-18T11:00:00.000Z", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_PROGRAM_UNIT_ID);
      expect(() => executeScheduleDraftCommand(db, SCOPE, input)).toThrowError(
        expect.objectContaining({ code: "SCHEDULE_CANONICAL_UNAVAILABLE" }),
      );
      expect(eventCount(db)).toBe(before);
    } finally {
      closeDb(db);
    }
  });

  it("rejects a durable pointer whose source fingerprint was tampered without writing", () => {
    const db = seedCanonicalDb();
    try {
      const saved = executeScheduleDraftCommand(db, SCOPE, moveInput(db, "canonical-pointer-1"));
      const row = db.prepare(
        `SELECT rowid, payload_json AS payloadJson
           FROM domain_events
          WHERE workspace_id = ? AND event_type = 'organizer.schedule_draft.saved'
        ORDER BY rowid DESC LIMIT 1`,
      ).get(EVALUATOR_WORKSPACE_ID) as { rowid: number; payloadJson: string };
      const original = JSON.parse(row.payloadJson) as Record<string, unknown>;
      const payload = {
        ...original,
        idempotencyKey: "tampered-pointer",
        requestId: "tampered-pointer-request",
        pointer: {
          ...(original.pointer as Record<string, unknown>),
          acceptedInventoryFingerprint: "tampered-inventory",
        },
      };
      const payloadJson = canonicalJson(payload);
      db.prepare(
        `INSERT INTO domain_events
           (id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at)
         VALUES (?, ?, 'organizer.schedule_draft.saved', 'schedule_draft', ?, ?, ?, ?)`,
      ).run(
        "tampered-pointer-event",
        EVALUATOR_WORKSPACE_ID,
        EVALUATOR_EVENT_ID,
        payloadJson,
        fingerprintOf(payload),
        "2026-08-13T00:00:01.000Z",
      );
      const before = eventCount(db);
      expect(() => readScheduleDraft(db, SCOPE)).toThrowError(expect.objectContaining({ code: "SCHEDULE_CONTEXT_CONFLICT" }));
      expect(saved.pointer.acceptedInventoryFingerprint).not.toBe("tampered-inventory");
      expect(eventCount(db)).toBe(before);
    } finally {
      closeDb(db);
    }
  });

  it("treats a conflict touching one selected session as blocking without writing", () => {
    const db = seedCanonicalDb();
    try {
      const before = eventCount(db);
      const partialConflict = [{ sessionIds: ["selected-session", "unselected-session"] as [string, string] }];
      expect(hasSelectedScheduleConflict(partialConflict, new Set(["selected-session"]))).toBe(true);
      expect(hasSelectedScheduleConflict(partialConflict, new Set(["unrelated-session"]))).toBe(false);
      expect(eventCount(db)).toBe(before);
    } finally {
      closeDb(db);
    }
  });

  it("rejects malformed commands before touching the durable event log", () => {
    expect(() => parseScheduleDraftCommand("{" )).toThrowError(SchedulePersistenceError);
    expect(() => parseScheduleDraftCommand("x".repeat(MAX_SCHEDULE_DRAFT_BYTES + 1))).toThrowError(SchedulePersistenceError);
    const db = seedCanonicalDb();
    try {
      const before = eventCount(db);
      const schedule = readScheduleDraft(db, SCOPE).schedule;
      expect(() => executeScheduleDraftCommand(db, SCOPE, {
        expectedRevision: schedule.revision,
        ...context(schedule),
        command: { kind: "MOVE", sessionId: EVALUATOR_PROGRAM_UNIT_ID, target: { dayId: "day-nope", timeSlotId: "slot-nope", roomId: "room-default", trackId: "track-default" } },
        idempotencyKey: "bad-target",
        requestId: "bad-target-request",
      })).toThrowError(expect.objectContaining({ code: "TIME_SLOT_NOT_FOUND" }));
      expect(eventCount(db)).toBe(before);
    } finally {
      closeDb(db);
    }
  });
});
