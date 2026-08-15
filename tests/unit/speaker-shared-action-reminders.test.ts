import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, deterministicUuid, fingerprintOf, sha256Hex } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  EVALUATOR_DRAFT_PERSON_ID,
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_REVIEWER_ACCOUNT_ID,
  EVALUATOR_SPEAKER_PERSON_ID,
  EVALUATOR_SUBMITTED_PERSON_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import { readAcceptedCurrentPlanAssignmentId } from "../../src/server/services/evaluator-speaker-identity";
import {
  createSyntheticSpeakerOperationsRepository,
  getSyntheticSpeakerOperationsRepository,
  prepareAutomaticActionTaskReminders,
  runAutomaticActionTaskReminderJob,
  SHARED_ACTION_TASK_REMINDER_PROVIDER_RECEIPT_SCHEMA,
  SpeakerOperationsAuthorizationError,
  SpeakerOperationsConflictError,
  SpeakerOperationsInputError,
  type ActionTaskReminderDeliveryAdapter,
  type ActionTaskReminderDeliveryIntent,
  type ActionTaskReminderProviderReceipt,
  type InMemorySpeakerOperationsRepository,
  type SpeakerEventContext,
  type SpeakerOrganizerScope,
} from "../../src/server/services/speaker-operations";
import {
  issueSpeakerPortalToken,
  resetSpeakerPortalAccessRateLimitForTest,
  SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY,
  type SpeakerPortalTokenActor,
} from "../../src/server/services/speaker-portal-access";

const NOW = "2026-08-13T12:00:00.000Z";
const OTHER_EVENT_ID = "shared-action-other-event";
const NONCURRENT_PERSON_ID = "shared-action-noncurrent-person";

const databases: Db[] = [];
const directories: string[] = [];

interface Fixture {
  readonly db: Db;
  readonly repository: InMemorySpeakerOperationsRepository;
  readonly scope: SpeakerOrganizerScope;
  readonly event: SpeakerEventContext;
  readonly personA: string;
  readonly personB: string;
  readonly assignmentA: string;
  readonly assignmentB: string;
  readonly actor: SpeakerPortalTokenActor;
}

function eventContext(db: Db, eventId = EVALUATOR_EVENT_ID): SpeakerEventContext {
  const row = db.prepare(
    `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt
       FROM events WHERE workspace_id = ? AND id = ?`,
  ).get(EVALUATOR_WORKSPACE_ID, eventId) as SpeakerEventContext | undefined;
  if (!row) throw new Error("test event unavailable");
  return row;
}

function organizerActor(db: Db): SpeakerPortalTokenActor {
  const row = db.prepare(
    `SELECT session_row.id AS sessionId, account.id AS accountId
       FROM sessions session_row
       JOIN accounts account
         ON account.id = session_row.account_id
        AND account.workspace_id = session_row.workspace_id
      WHERE session_row.workspace_id = ?
        AND account.id = ?
      ORDER BY session_row.created_at DESC, session_row.rowid DESC
      LIMIT 1`,
  ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_ORGANIZER_ACCOUNT_ID) as { sessionId: string; accountId: string } | undefined;
  if (!row) throw new Error("test organizer session unavailable");
  return row;
}

function addCurrentSpeaker(db: Db, personId: string, suffix: string): string {
  const source = db.prepare(
    `SELECT event_row.current_plan_version_id AS planId,
            assignment.program_unit_id AS programUnitId,
            offer.terms_json AS termsJson
       FROM events event_row
       JOIN plan_assignments assignment
         ON assignment.plan_version_id = event_row.current_plan_version_id
        AND assignment.workspace_id = event_row.workspace_id
        AND assignment.person_id = ?
       JOIN commitment_offers offer
         ON offer.plan_version_id = assignment.plan_version_id
        AND offer.workspace_id = assignment.workspace_id
        AND offer.person_id = assignment.person_id
      WHERE event_row.workspace_id = ? AND event_row.id = ?`,
  ).get(EVALUATOR_SPEAKER_PERSON_ID, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as {
    readonly planId: string;
    readonly programUnitId: string;
    readonly termsJson: string;
  } | undefined;
  if (!source) throw new Error("seeded speaker plan unavailable");
  const assignmentId = deterministicUuid(`shared-action-test-assignment:${suffix}`);
  const offerId = deterministicUuid(`shared-action-test-offer:${suffix}`);
  const terms = { ...(JSON.parse(source.termsJson) as Record<string, unknown>), role: "SPEAKER" };
  db.prepare(
    `INSERT INTO plan_assignments
       (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation)
     VALUES (?, ?, ?, ?, ?, 'SPEAKER', ?)`,
  ).run(assignmentId, EVALUATOR_WORKSPACE_ID, source.planId, personId, source.programUnitId, `current accepted ${suffix} fixture`);
  db.prepare(
    `INSERT INTO commitment_offers
       (id, workspace_id, event_id, plan_version_id, person_id, terms_json, terms_fingerprint, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', ?)`,
  ).run(offerId, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, source.planId, personId, canonicalJson(terms), fingerprintOf(terms), NOW);
  db.prepare(
    `INSERT INTO commitment_responses
       (id, workspace_id, offer_id, response, responded_at, actor_person_id)
     VALUES (?, ?, ?, 'accepted', ?, ?)`,
  ).run(deterministicUuid(`shared-action-test-response:${suffix}`), EVALUATOR_WORKSPACE_ID, offerId, NOW, personId);
  db.prepare(
    `INSERT INTO event_speakers
       (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'SPEAKER', 'CONFIRMED', ?, ?)`,
  ).run(deterministicUuid(`shared-action-test-event-speaker:${suffix}`), EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, personId, NOW, NOW);
  expect(readAcceptedCurrentPlanAssignmentId(db, {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    eventId: EVALUATOR_EVENT_ID,
    personId,
  })).toBe(assignmentId);
  return assignmentId;
}

function setup(options: { readonly path?: string; readonly clock?: () => string } = {}): Fixture {
  const db = openDb({ path: options.path ?? ":memory:", seed: false });
  databases.push(db);
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  const assignmentA = addCurrentSpeaker(db, EVALUATOR_SUBMITTED_PERSON_ID, "noor");
  const assignmentB = addCurrentSpeaker(db, EVALUATOR_DRAFT_PERSON_ID, "iris");
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(NONCURRENT_PERSON_ID, EVALUATOR_WORKSPACE_ID, "not-current@example.test", "Not Current", "Test", "Former speaker", NOW);
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
  ).run(OTHER_EVENT_ID, EVALUATOR_WORKSPACE_ID, "Other Event", "2026-09-20T09:00:00.000Z", "2026-09-20T17:00:00.000Z", NOW);
  const repository = createSyntheticSpeakerOperationsRepository({ db, clock: options.clock ?? (() => NOW) });
  const scope = {
    kind: "organizer" as const,
    workspaceId: EVALUATOR_WORKSPACE_ID,
    eventId: EVALUATOR_EVENT_ID,
    actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
  };
  return {
    db,
    repository,
    scope,
    event: eventContext(db),
    personA: EVALUATOR_SUBMITTED_PERSON_ID,
    personB: EVALUATOR_DRAFT_PERSON_ID,
    assignmentA,
    assignmentB,
    actor: organizerActor(db),
  };
}

function closeTracked(db: Db): void {
  const index = databases.indexOf(db);
  if (index >= 0) databases.splice(index, 1);
  closeDb(db);
}

function sharedCounts(db: Db): Record<string, number> {
  const scalar = (sql: string): number => (db.prepare(sql).get() as { readonly count: number }).count;
  return {
    definitions: scalar("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.action-task.batch.created'"),
    taskEvents: scalar("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.task.created' AND json_extract(payload_json, '$.sharedActionDefinitionId') IS NOT NULL"),
    reminderEvents: scalar("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.action-task.reminder.queued'"),
    reminderOutbox: scalar("SELECT COUNT(*) AS count FROM outbox_messages WHERE destination_key LIKE 'local:speaker-action-task-reminder:%'"),
    audits: scalar("SELECT COUNT(*) AS count FROM audit_events WHERE action LIKE 'speaker.action-task.%'"),
  };
}

function createInput(fixture: Fixture, overrides: Partial<{
  readonly assigneePersonIds: readonly string[];
  readonly title: string;
  readonly instructions: string;
  readonly dueDate: string;
  readonly idempotencyKey: string;
}> = {}) {
  return {
    assigneePersonIds: [fixture.personA, fixture.personB],
    title: "Confirm arrival details",
    instructions: "Review the event brief and confirm your arrival window.",
    dueDate: "2026-08-15",
    idempotencyKey: "shared-action-create-one",
    ...overrides,
  };
}

function noNetworkReceipt(
  intent: ActionTaskReminderDeliveryIntent,
  acceptedAt: string,
): ActionTaskReminderProviderReceipt {
  return {
    schema: SHARED_ACTION_TASK_REMINDER_PROVIDER_RECEIPT_SCHEMA,
    providerReceiptId: deterministicUuid(`test-provider-receipt:${intent.idempotencyKey}`),
    messageId: intent.messageId,
    idempotencyKey: intent.idempotencyKey,
    payloadFingerprint: intent.payloadFingerprint,
    acceptedAt,
    deliveryMode: "NO_NETWORK_SIMULATED",
    networkContacted: false,
    providerMutation: false,
  };
}

function deferAllButFirstReminder(db: Db): string {
  const rows = db.prepare(
    `SELECT id FROM outbox_messages
      WHERE destination_key LIKE 'local:speaker-action-task-reminder:%'
      ORDER BY id`,
  ).all() as unknown as Array<{ readonly id: string }>;
  if (rows.length !== 2) throw new Error("expected two reminder messages");
  db.prepare("UPDATE outbox_messages SET next_attempt_at = ? WHERE id = ?")
    .run("2099-01-01T00:00:00.000Z", rows[1]!.id);
  return rows[0]!.id;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetSpeakerPortalAccessRateLimitForTest();
  for (const db of databases.splice(0)) closeDb(db);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("shared ACTION task assignment", () => {
  it("commits two assignments atomically, survives injected second-outbox failure, and replays without duplication", () => {
    const fixture = setup();
    fixture.db.exec(`CREATE TEMP TRIGGER fail_second_shared_action_outbox
      BEFORE INSERT ON outbox_messages
      WHEN json_extract(NEW.payload_json, '$.payload.sharedActionDefinitionId') IS NOT NULL
       AND (SELECT COUNT(*) FROM outbox_messages
            WHERE json_extract(payload_json, '$.payload.sharedActionDefinitionId') IS NOT NULL) >= 1
      BEGIN SELECT RAISE(ABORT, 'injected second assignment outbox failure'); END;`);

    expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture))).toThrow(/injected second assignment outbox failure/u);
    expect(sharedCounts(fixture.db)).toEqual({ definitions: 0, taskEvents: 0, reminderEvents: 0, reminderOutbox: 0, audits: 0 });
    expect(fixture.repository.listSharedActionTasks(fixture.scope)).toEqual([]);
    fixture.db.exec("DROP TRIGGER fail_second_shared_action_outbox");

    fixture.db.exec("BEGIN IMMEDIATE");
    expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "outer-transaction-denied",
    }))).toThrow(/own its transaction boundary/u);
    fixture.db.exec("ROLLBACK");
    expect(sharedCounts(fixture.db)).toEqual({ definitions: 0, taskEvents: 0, reminderEvents: 0, reminderOutbox: 0, audits: 0 });
    expect(fixture.repository.listSharedActionTasks(fixture.scope)).toEqual([]);

    const created = fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      assigneePersonIds: [fixture.personB, fixture.personA],
    }));
    expect(created).toMatchObject({ created: true, assignmentCount: 2, completedCount: 0, dueDate: "2026-08-15" });
    expect(created.assignments.map((assignment) => assignment.personId)).toEqual([fixture.personB, fixture.personA].sort());
    expect(new Set(created.assignments.map((assignment) => assignment.taskId)).size).toBe(2);
    expect(sharedCounts(fixture.db)).toEqual({ definitions: 1, taskEvents: 2, reminderEvents: 0, reminderOutbox: 0, audits: 1 });
    expect(fixture.db.prepare(
      `SELECT COUNT(*) AS count FROM outbox_messages outbox
       JOIN domain_events event_row ON event_row.id = outbox.domain_event_id
       WHERE event_row.event_type = 'speaker.task.created'
         AND json_extract(event_row.payload_json, '$.sharedActionDefinitionId') = ?`,
    ).get(created.definitionId)).toEqual({ count: 2 });

    const replay = fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture));
    expect(replay.created).toBe(false);
    expect(replay.definitionId).toBe(created.definitionId);
    expect(replay.assignments).toEqual(created.assignments);
    expect(sharedCounts(fixture.db)).toEqual({ definitions: 1, taskEvents: 2, reminderEvents: 0, reminderOutbox: 0, audits: 1 });

    expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, { title: "Different title" }))).toThrow(SpeakerOperationsConflictError);
    expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "duplicate-normalized-assignee",
      assigneePersonIds: [fixture.personA, ` ${fixture.personA} `, fixture.personB],
    }))).toThrow(SpeakerOperationsInputError);
    expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "too-few-assignees",
      assigneePersonIds: [fixture.personA],
    }))).toThrow(SpeakerOperationsInputError);
    expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "too-many-assignees",
      assigneePersonIds: Array.from({ length: 101 }, (_, index) => `bounded-person-${index}`),
    }))).toThrow(SpeakerOperationsInputError);
    for (const [idempotencyKey, overrides] of [
      ["past-due-date", { dueDate: "2026-08-12" }],
      ["too-far-due-date", { dueDate: "2027-08-15" }],
      ["invalid-due-date", { dueDate: "2026-02-30" }],
      ["oversized-title", { title: "T".repeat(241) }],
      ["oversized-instructions", { instructions: "I".repeat(2_001) }],
    ] as const) {
      expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
        idempotencyKey,
        ...overrides,
      }))).toThrow(SpeakerOperationsInputError);
    }
    expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "noncurrent-assignee",
      assigneePersonIds: [fixture.personA, NONCURRENT_PERSON_ID],
    }))).toThrow(SpeakerOperationsAuthorizationError);
    expect(() => fixture.repository.updateTask(fixture.scope, created.assignments[0]!.taskId, {
      dueAt: "2026-08-16T23:59:59.999Z",
      idempotencyKey: "mutate-immutable-action-due",
    })).toThrow(SpeakerOperationsConflictError);
    expect(() => fixture.repository.createTask(fixture.scope, {
      personId: fixture.personA,
      kind: "ACTION",
      contentKind: null,
      title: "Single-person bypass",
      description: "This path must remain unavailable.",
      required: true,
      gate: null,
      dueAt: "2026-08-15T23:59:59.999Z",
      owner: "SPEAKER",
      idempotencyKey: "single-person-action-bypass",
    })).toThrow(SpeakerOperationsConflictError);
    expect(() => fixture.repository.updateTask(
      { ...fixture.scope, actorId: EVALUATOR_REVIEWER_ACCOUNT_ID },
      created.assignments[0]!.taskId,
      { state: "IN_PROGRESS", idempotencyKey: "reviewer-action-status" },
    )).toThrow(SpeakerOperationsAuthorizationError);
    fixture.db.exec("BEGIN IMMEDIATE");
    expect(() => fixture.repository.updateTask(fixture.scope, created.assignments[0]!.taskId, {
      state: "IN_PROGRESS",
      idempotencyKey: "outer-status-update-denied",
    })).toThrow(/own their transaction boundary/u);
    fixture.db.exec("ROLLBACK");
    expect(fixture.repository.listSharedActionTasks(fixture.scope)[0]?.assignments[0]?.state).toBe("NOT_STARTED");
    expect(() => fixture.repository.sendReminder(fixture.scope, [fixture.personA], "legacy-action-reminder"))
      .toThrow(/No selected speaker has incomplete work/u);
    expect(sharedCounts(fixture.db)).toEqual({ definitions: 1, taskEvents: 2, reminderEvents: 0, reminderOutbox: 0, audits: 1 });
  });

  it("denies forged actors, foreign people, wrong events, and stale current-speaker authority with zero business writes", () => {
    const fixture = setup();
    const baseline = sharedCounts(fixture.db);
    const foreignWorkspace = fixture.db.prepare(
      "SELECT id FROM workspaces WHERE id <> ? ORDER BY id LIMIT 1",
    ).get(EVALUATOR_WORKSPACE_ID) as { readonly id: string };
    const foreignPersonId = "shared-action-foreign-person";
    fixture.db.prepare(
      `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(foreignPersonId, foreignWorkspace.id, "foreign@example.test", "Foreign Person", NOW);

    expect(() => fixture.repository.createSharedActionTask({ ...fixture.scope, actorId: "missing-organizer" }, createInput(fixture, { idempotencyKey: "missing-actor" }))).toThrow(SpeakerOperationsAuthorizationError);
    expect(() => fixture.repository.createSharedActionTask({ ...fixture.scope, actorId: EVALUATOR_REVIEWER_ACCOUNT_ID }, createInput(fixture, { idempotencyKey: "reviewer-actor" }))).toThrow(SpeakerOperationsAuthorizationError);
    expect(() => fixture.repository.queueDueActionTaskReminders({ ...fixture.scope, actorId: EVALUATOR_REVIEWER_ACCOUNT_ID })).toThrow(SpeakerOperationsAuthorizationError);
    expect(() => fixture.repository.listActionTaskReminderDeliveries({ ...fixture.scope, actorId: EVALUATOR_REVIEWER_ACCOUNT_ID })).toThrow(SpeakerOperationsAuthorizationError);
    expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "foreign-person",
      assigneePersonIds: [fixture.personA, foreignPersonId],
    }))).toThrow(SpeakerOperationsAuthorizationError);
    expect(() => fixture.repository.createSharedActionTask({ ...fixture.scope, eventId: OTHER_EVENT_ID }, createInput(fixture, { idempotencyKey: "wrong-event" }))).toThrow(SpeakerOperationsAuthorizationError);

    fixture.repository.getOrganizerProjection(fixture.scope, fixture.event);
    expect(fixture.repository.listSharedActionTaskAssignees(fixture.scope).map((speaker) => speaker.personId)).toContain(fixture.personB);
    fixture.db.prepare(
      `UPDATE event_speakers SET participation_status = 'DECLINED', updated_at = ?
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).run("2026-08-13T12:01:00.000Z", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, fixture.personB);
    expect(fixture.repository.listSharedActionTaskAssignees(fixture.scope).map((speaker) => speaker.personId)).not.toContain(fixture.personB);
    expect(() => fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, { idempotencyKey: "stale-cached-roster" }))).toThrow(SpeakerOperationsAuthorizationError);
    expect(sharedCounts(fixture.db)).toEqual(baseline);
  });

  it("isolates portal completion by Person and preserves independent status after a cold database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "sympose-shared-action-"));
    directories.push(directory);
    const path = join(directory, "shared-action.sqlite");
    const fixture = setup({ path });
    const created = fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture));
    const taskA = created.assignments.find((assignment) => assignment.personId === fixture.personA)!;
    const taskB = created.assignments.find((assignment) => assignment.personId === fixture.personB)!;
    const tokenA = issueSpeakerPortalToken(fixture.db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: fixture.personA,
    }, fixture.actor, { now: NOW }).token;
    const tokenB = issueSpeakerPortalToken(fixture.db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: fixture.personB,
    }, fixture.actor, { now: NOW }).token;

    expect(fixture.repository.getPortalProjection(tokenA, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)?.tasks.filter((task) => task.kind === "ACTION").map((task) => task.id)).toEqual([taskA.taskId]);
    expect(fixture.repository.getPortalProjection(tokenB, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)?.tasks.filter((task) => task.kind === "ACTION").map((task) => task.id)).toEqual([taskB.taskId]);
    expect(() => fixture.repository.completeTask(tokenA, taskB.taskId, { idempotencyKey: "cross-person-completion" }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)).toThrow(SpeakerOperationsAuthorizationError);

    fixture.db.exec("BEGIN IMMEDIATE");
    expect(() => fixture.repository.completeTask(tokenA, taskA.taskId, {
      idempotencyKey: "outer-completion-denied",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)).toThrow(/own its transaction boundary/u);
    fixture.db.exec("ROLLBACK");
    expect(fixture.repository.listSharedActionTasks(fixture.scope)[0]?.completedCount).toBe(0);

    const completed = fixture.repository.completeTask(tokenA, taskA.taskId, {
      note: "Confirmed",
      idempotencyKey: "complete-action-a",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY);
    expect(completed).toMatchObject({ created: true, task: { id: taskA.taskId, state: "COMPLETED" } });
    expect(fixture.repository.completeTask(tokenA, taskA.taskId, {
      note: "Confirmed",
      idempotencyKey: "complete-action-a",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY).created).toBe(false);
    expect(() => fixture.repository.completeTask(tokenA, taskA.taskId, {
      note: "Changed replay",
      idempotencyKey: "complete-action-a",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)).toThrow(SpeakerOperationsConflictError);
    expect(fixture.repository.listSharedActionTasks(fixture.scope)[0]).toMatchObject({ completedCount: 1, assignmentCount: 2 });

    closeTracked(fixture.db);
    const reopened = openDb({ path, seed: false });
    databases.push(reopened);
    const cold = createSyntheticSpeakerOperationsRepository({ db: reopened, clock: () => NOW });
    const coldBatch = cold.listSharedActionTasks(fixture.scope)[0]!;
    expect(coldBatch).toMatchObject({ definitionId: created.definitionId, completedCount: 1, assignmentCount: 2 });
    expect(coldBatch.assignments.find((assignment) => assignment.personId === fixture.personA)?.state).toBe("COMPLETED");
    expect(coldBatch.assignments.find((assignment) => assignment.personId === fixture.personB)?.state).toBe("NOT_STARTED");
    expect(cold.getOrganizerProjection(fixture.scope, eventContext(reopened)).roster
      .find((record) => record.person.personId === fixture.personA)?.tasks
      .find((task) => task.id === taskA.taskId)?.state).toBe("COMPLETED");

    const currentPlan = (reopened.prepare(
      "SELECT current_plan_version_id AS planId FROM events WHERE workspace_id = ? AND id = ?",
    ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { readonly planId: string }).planId;
    reopened.prepare("UPDATE events SET current_plan_version_id = NULL WHERE workspace_id = ? AND id = ?")
      .run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID);
    expect(cold.getPortalProjection(tokenB, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)).toBeNull();
    reopened.prepare("UPDATE events SET current_plan_version_id = ? WHERE workspace_id = ? AND id = ?")
      .run(currentPlan, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID);

    cold.getPortalProjection(tokenB, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY);
    reopened.prepare(
      `UPDATE event_speakers SET participation_status = 'DECLINED', updated_at = ?
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).run("2026-08-13T12:02:00.000Z", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, fixture.personB);
    const completionEventsBefore = (reopened.prepare(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.task.updated' AND aggregate_id = ?",
    ).get(taskB.taskId) as { readonly count: number }).count;
    expect(() => cold.completeTask(tokenB, taskB.taskId, { idempotencyKey: "stale-authority-completion" }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)).toThrow(SpeakerOperationsAuthorizationError);
    expect(reopened.prepare(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.task.updated' AND aggregate_id = ?",
    ).get(taskB.taskId)).toEqual({ count: completionEventsBefore });
    expect(reopened.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'speaker.action-task.completed'",
    ).get()).toEqual({ count: 1 });
  });

  it("derives organizer and speaker status transitions from latest durable truth across stale repositories", () => {
    const fixture = setup();
    const created = fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "concurrent-status-definition",
    }));
    const taskA = created.assignments.find((assignment) => assignment.personId === fixture.personA)!;
    const taskB = created.assignments.find((assignment) => assignment.personId === fixture.personB)!;
    const repositoryB = createSyntheticSpeakerOperationsRepository({
      db: fixture.db,
      clock: () => "2026-08-13T12:01:00.000Z",
    });
    fixture.repository.getOrganizerProjection(fixture.scope, fixture.event);
    repositoryB.getOrganizerProjection(fixture.scope, fixture.event);
    const tokenA = issueSpeakerPortalToken(fixture.db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: fixture.personA,
    }, fixture.actor, { now: NOW }).token;
    const tokenB = issueSpeakerPortalToken(fixture.db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: fixture.personB,
    }, fixture.actor, { now: NOW }).token;

    repositoryB.updateTask(fixture.scope, taskA.taskId, {
      state: "IN_PROGRESS",
      idempotencyKey: "repository-b-starts-a",
    });
    const completedA = fixture.repository.completeTask(tokenA, taskA.taskId, {
      idempotencyKey: "stale-repository-a-completes-a",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY);
    expect(completedA.task.transitions.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "NOT_STARTED", to: "IN_PROGRESS" },
      { from: "IN_PROGRESS", to: "COMPLETED" },
    ]);
    expect(fixture.repository.listSharedActionTasks(fixture.scope)[0]?.assignments
      .find((assignment) => assignment.taskId === taskA.taskId)?.state).toBe("COMPLETED");

    repositoryB.completeTask(tokenB, taskB.taskId, {
      idempotencyKey: "repository-b-completes-b",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY);
    const reopenedByStaleOrganizer = fixture.repository.updateTask(fixture.scope, taskB.taskId, {
      state: "IN_PROGRESS",
      idempotencyKey: "stale-repository-a-reopens-b",
    });
    expect(reopenedByStaleOrganizer.transitions.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "NOT_STARTED", to: "COMPLETED" },
      { from: "COMPLETED", to: "IN_PROGRESS" },
    ]);

    fixture.db.exec(`CREATE TEMP TRIGGER fail_action_status_outbox
      BEFORE INSERT ON outbox_messages
      WHEN NEW.destination_key = 'speaker-operation:speaker.task.updated'
      BEGIN SELECT RAISE(ABORT, 'injected ACTION status outbox failure'); END;`);
    expect(() => fixture.repository.updateTask(fixture.scope, taskB.taskId, {
      state: "BLOCKED",
      idempotencyKey: "failed-status-cache-rollback",
    })).toThrow(/injected ACTION status outbox failure/u);
    const cachedTaskB = fixture.repository.getOrganizerProjection(fixture.scope, fixture.event).roster
      .find((record) => record.person.personId === fixture.personB)?.tasks
      .find((task) => task.id === taskB.taskId);
    expect(cachedTaskB).toMatchObject({ state: "IN_PROGRESS" });
    expect(cachedTaskB?.transitions.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "NOT_STARTED", to: "COMPLETED" },
      { from: "COMPLETED", to: "IN_PROGRESS" },
    ]);
    expect(repositoryB.listSharedActionTasks(fixture.scope)[0]?.assignments
      .find((assignment) => assignment.taskId === taskB.taskId)?.state).toBe("IN_PROGRESS");
  });

  it("revalidates durable portal revocation as the first ACTION completion transaction operation", () => {
    const fixture = setup();
    const created = fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "revocation-boundary-definition",
    }));
    const taskA = created.assignments.find((assignment) => assignment.personId === fixture.personA)!;
    const tokenA = issueSpeakerPortalToken(fixture.db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: fixture.personA,
    }, fixture.actor, { now: NOW }).token;
    const originalExec = fixture.db.exec.bind(fixture.db);
    let revokedAtBoundary = false;
    (fixture.db as unknown as { exec(sql: string): void }).exec = (sql: string): void => {
      if (!revokedAtBoundary && sql === "BEGIN IMMEDIATE") {
        revokedAtBoundary = true;
        expect(fixture.db.prepare(
          `UPDATE speaker_portal_tokens
              SET revoked_at = ?, revoked_reason = ?, revoked_by = ?
            WHERE workspace_id = ? AND event_id = ? AND person_id = ?
              AND token_hash = ? AND revoked_at IS NULL`,
        ).run(
          NOW,
          "transaction-boundary revocation",
          "test-organizer",
          EVALUATOR_WORKSPACE_ID,
          EVALUATOR_EVENT_ID,
          fixture.personA,
          sha256Hex(tokenA),
        ).changes).toBe(1);
      }
      originalExec(sql);
    };
    const baseline = {
      events: (fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.task.updated' AND aggregate_id = ?",
      ).get(taskA.taskId) as { readonly count: number }).count,
      outbox: (fixture.db.prepare(
        `SELECT COUNT(*) AS count FROM outbox_messages outbox
         JOIN domain_events event_row ON event_row.id = outbox.domain_event_id
         WHERE event_row.event_type = 'speaker.task.updated' AND event_row.aggregate_id = ?`,
      ).get(taskA.taskId) as { readonly count: number }).count,
      audits: (fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'speaker.action-task.completed' AND target_id = ?",
      ).get(taskA.taskId) as { readonly count: number }).count,
    };

    try {
      expect(() => fixture.repository.completeTask(tokenA, taskA.taskId, {
        idempotencyKey: "revoked-at-completion-boundary",
      }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)).toThrow(SpeakerOperationsAuthorizationError);
    } finally {
      delete (fixture.db as unknown as Record<string, unknown>).exec;
    }
    expect(revokedAtBoundary).toBe(true);
    expect(fixture.db.prepare(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.task.updated' AND aggregate_id = ?",
    ).get(taskA.taskId)).toEqual({ count: baseline.events });
    expect(fixture.db.prepare(
      `SELECT COUNT(*) AS count FROM outbox_messages outbox
       JOIN domain_events event_row ON event_row.id = outbox.domain_event_id
       WHERE event_row.event_type = 'speaker.task.updated' AND event_row.aggregate_id = ?`,
    ).get(taskA.taskId)).toEqual({ count: baseline.outbox });
    expect(fixture.db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'speaker.action-task.completed' AND target_id = ?",
    ).get(taskA.taskId)).toEqual({ count: baseline.audits });
    expect(fixture.repository.listSharedActionTasks(fixture.scope)[0]?.completedCount).toBe(0);
  });

  it("uses the repository clock for durable token expiry and never reactivates cached expired access", () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-13T20:00:00.000Z"));
    const fixture = setup({ clock: () => clock });
    const created = fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "token-clock-boundary-definition",
    }));
    const taskA = created.assignments.find((assignment) => assignment.personId === fixture.personA)!;
    const tokenA = issueSpeakerPortalToken(fixture.db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: fixture.personA,
    }, fixture.actor, { now: NOW }).token;

    expect(fixture.repository.getPortalProjection(tokenA, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)?.person.personId)
      .toBe(fixture.personA);

    clock = "2026-08-13T12:30:00.000Z";
    expect(fixture.repository.getPortalProjection(tokenA, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)).toBeNull();
    const baseline = sharedCounts(fixture.db);
    expect(() => fixture.repository.completeTask(tokenA, taskA.taskId, {
      idempotencyKey: "expired-token-completion",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY)).toThrow(SpeakerOperationsAuthorizationError);
    expect(sharedCounts(fixture.db)).toEqual(baseline);
    expect(fixture.repository.listSharedActionTasks(fixture.scope)[0]?.completedCount).toBe(0);
  });
});

describe("ACTION task due reminder scheduler", () => {
  it("uses an advancing wall UTC clock for the durable app repository", () => {
    const firstWallTime = Date.parse("2026-10-01T08:00:00.000Z");
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(firstWallTime);
    const fixture = setup();
    const applicationRepository = getSyntheticSpeakerOperationsRepository(fixture.db);
    applicationRepository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "wall-clock-reminder",
      dueDate: "2026-10-03",
    }));

    expect(applicationRepository.queueDueActionTaskReminders(fixture.scope)).toMatchObject({
      occurrenceDate: "2026-10-01",
      queuedCount: 2,
    });
    wallClock.mockReturnValue(Date.parse("2026-10-02T08:00:00.000Z"));
    expect(applicationRepository.queueDueActionTaskReminders(fixture.scope)).toMatchObject({
      occurrenceDate: "2026-10-02",
      queuedCount: 2,
    });
    expect(sharedCounts(fixture.db)).toMatchObject({ reminderEvents: 4, reminderOutbox: 4 });
  });

  it("includes incomplete overdue assignments in the current UTC occurrence", () => {
    let clock = NOW;
    const fixture = setup({ clock: () => clock });
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "overdue-reminder-definition",
      dueDate: "2026-08-13",
    }));
    clock = "2026-08-14T00:00:00.000Z";

    const receipt = fixture.repository.queueDueActionTaskReminders(fixture.scope);
    expect(receipt).toMatchObject({ occurrenceDate: "2026-08-14", queuedCount: 2, notDueCount: 0 });
    expect(receipt.queued.every((delivery) => delivery.dueDate === "2026-08-13")).toBe(true);
  });

  it("fails atomically before scanning more than 100 assignments", () => {
    const fixture = setup();
    for (let index = 0; index < 51; index += 1) {
      fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
        idempotencyKey: `bounded-reminder-definition-${index}`,
        title: `Bounded reminder task ${index}`,
      }));
    }
    const baseline = sharedCounts(fixture.db);

    expect(() => fixture.repository.queueDueActionTaskReminders(fixture.scope)).toThrow(/limited to 100 assignments/u);
    expect(sharedCounts(fixture.db)).toEqual(baseline);
    expect(fixture.repository.listActionTaskReminderDeliveries(fixture.scope)).toEqual([]);
  });

  it.each([
    {
      label: "task merge values",
      mutate: (reminder: Record<string, unknown>) => {
        reminder.taskTitle = "Re-fingerprinted divergent title";
        reminder.subjectPreview = "Action due: Re-fingerprinted divergent title";
        reminder.bodyPreview = `${String(reminder.eventName)}\n\n${String(reminder.taskTitle)}\nDue ${String(reminder.dueDate)} UTC\n\n${String(reminder.taskInstructions)}`;
      },
      error: /task-recipient evidence is divergent/u,
    },
    {
      label: "temporal window",
      mutate: (reminder: Record<string, unknown>) => {
        reminder.windowEndExclusive = "2026-08-21T00:00:00.000Z";
      },
      error: /temporal evidence is divergent/u,
    },
  ])("rejects canonically re-fingerprinted reminder $label that is not authoritative", ({ mutate, error }) => {
    const fixture = setup();
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: `tamper-${error.source}`,
    }));
    fixture.repository.queueDueActionTaskReminders(fixture.scope);
    const row = fixture.db.prepare(
      `SELECT event_row.id AS domainEventId, event_row.payload_json AS eventPayloadJson,
              outbox.id AS messageId
         FROM domain_events event_row
         JOIN outbox_messages outbox ON outbox.domain_event_id = event_row.id
        WHERE event_row.event_type = 'speaker.action-task.reminder.queued'
        ORDER BY event_row.id LIMIT 1`,
    ).get() as { readonly domainEventId: string; readonly eventPayloadJson: string; readonly messageId: string };
    const reminder = JSON.parse(row.eventPayloadJson) as Record<string, unknown>;
    mutate(reminder);
    const messageBasis = {
      schema: "speaker-action-task-reminder-message/v1",
      domainEventId: row.domainEventId,
      reminder,
      channel: "local",
      providerMutation: false,
    } as const;
    const payloadFingerprint = fingerprintOf(messageBasis);
    const outboxPayloadJson = canonicalJson({ ...messageBasis, payloadFingerprint });
    fixture.db.exec("DROP TRIGGER trg_v12_domain_events_immutable");
    fixture.db.exec("DROP TRIGGER trg_v12_outbox_workspace_update_guard");
    fixture.db.prepare(
      "UPDATE domain_events SET payload_json = ?, payload_fingerprint = ? WHERE id = ?",
    ).run(canonicalJson(reminder), fingerprintOf(reminder), row.domainEventId);
    fixture.db.prepare("UPDATE outbox_messages SET payload_json = ? WHERE id = ?")
      .run(outboxPayloadJson, row.messageId);

    expect(() => fixture.repository.listActionTaskReminderDeliveries(fixture.scope)).toThrow(error);
  });

  it("classifies malformed stored shared-task definitions as immutable-history conflicts", () => {
    const fixture = setup();
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "malformed-stored-definition",
    }));
    const row = fixture.db.prepare(
      `SELECT id, payload_json AS payloadJson
         FROM domain_events WHERE event_type = 'speaker.action-task.batch.created' LIMIT 1`,
    ).get() as { readonly id: string; readonly payloadJson: string };
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    payload.title = "T".repeat(241);
    fixture.db.exec("DROP TRIGGER trg_v12_domain_events_immutable");
    fixture.db.prepare(
      "UPDATE domain_events SET payload_json = ?, payload_fingerprint = ? WHERE id = ?",
    ).run(canonicalJson(payload), fingerprintOf(payload), row.id);

    let thrown: unknown;
    try {
      fixture.repository.listSharedActionTasks(fixture.scope);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SpeakerOperationsConflictError);
    expect(thrown).not.toBeInstanceOf(SpeakerOperationsInputError);
  });

  it.each([
    {
      label: "title whitespace",
      mutate: (payload: Record<string, unknown>) => { payload.title = ` ${String(payload.title)} `; },
    },
    {
      label: "instruction CRLF aliases",
      mutate: (payload: Record<string, unknown>) => {
        payload.instructions = `${String(payload.instructions)}\r\n`;
      },
    },
    {
      label: "idempotency-key whitespace",
      mutate: (payload: Record<string, unknown>) => {
        payload.idempotencyKey = ` ${String(payload.idempotencyKey)} `;
      },
    },
  ])("rejects re-fingerprinted noncanonical stored definition $label", ({ label, mutate }) => {
    const fixture = setup();
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: `noncanonical-definition-${label}`,
    }));
    const row = fixture.db.prepare(
      `SELECT id, payload_json AS payloadJson
         FROM domain_events WHERE event_type = 'speaker.action-task.batch.created' LIMIT 1`,
    ).get() as { readonly id: string; readonly payloadJson: string };
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    mutate(payload);
    fixture.db.exec("DROP TRIGGER trg_v12_domain_events_immutable");
    fixture.db.prepare(
      "UPDATE domain_events SET payload_json = ?, payload_fingerprint = ? WHERE id = ?",
    ).run(canonicalJson(payload), fingerprintOf(payload), row.id);

    expect(() => fixture.repository.listSharedActionTasks(fixture.scope))
      .toThrow(/definition evidence is not canonically stored/u);
  });

  it("rolls back the whole reminder occurrence when a later outbox insert fails", () => {
    const fixture = setup();
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "reminder-atomicity",
      dueDate: "2026-08-15",
    }));
    const baseline = sharedCounts(fixture.db);
    fixture.db.exec("BEGIN IMMEDIATE");
    expect(() => fixture.repository.queueDueActionTaskReminders(fixture.scope)).toThrow(/own its transaction boundary/u);
    fixture.db.exec("ROLLBACK");
    expect(sharedCounts(fixture.db)).toEqual(baseline);
    fixture.db.exec(`CREATE TEMP TRIGGER fail_second_action_reminder_outbox
      BEFORE INSERT ON outbox_messages
      WHEN NEW.destination_key LIKE 'local:speaker-action-task-reminder:%'
       AND (SELECT COUNT(*) FROM outbox_messages
            WHERE destination_key LIKE 'local:speaker-action-task-reminder:%') >= 1
      BEGIN SELECT RAISE(ABORT, 'injected second reminder outbox failure'); END;`);

    expect(() => fixture.repository.queueDueActionTaskReminders(fixture.scope)).toThrow(/injected second reminder outbox failure/u);
    expect(sharedCounts(fixture.db)).toEqual(baseline);
    expect(fixture.repository.listActionTaskReminderDeliveries(fixture.scope)).toEqual([]);

    fixture.db.exec("DROP TRIGGER fail_second_action_reminder_outbox");
    expect(fixture.repository.queueDueActionTaskReminders(fixture.scope)).toMatchObject({ queuedCount: 2, skippedCount: 0 });
  });

  it("queues bounded eligible PENDING rows, preserves retry truth, excludes ineligible assignments, and repeats by occurrence without provider calls", () => {
    let clock = NOW;
    const fixture = setup({ clock: () => clock });
    const network = vi.spyOn(globalThis, "fetch");
    const eligible = fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "reminder-eligible",
      dueDate: "2026-08-15",
    }));

    const first = fixture.repository.queueDueActionTaskReminders(fixture.scope);
    expect(first).toMatchObject({
      occurrenceDate: "2026-08-13",
      windowEndExclusive: "2026-08-20T00:00:00.000Z",
      scannedCount: 2,
      maximumScanAssignments: 100,
      queuedCount: 2,
      skippedCount: 0,
      providerMutation: false,
    });
    expect(first.queued.every((delivery) => delivery.status === "PENDING" && delivery.attemptCount === 0)).toBe(true);
    expect(first.queued.map((delivery) => ({
      personId: delivery.recipientPersonId,
      taskId: delivery.taskId,
      assignmentId: delivery.assignmentId,
    })).sort((left, right) => left.personId.localeCompare(right.personId))).toEqual(
      eligible.assignments.map((assignment) => ({
        personId: assignment.personId,
        taskId: assignment.taskId,
        assignmentId: assignment.assignmentId,
      })).sort((left, right) => left.personId.localeCompare(right.personId)),
    );
    const reminderAudits = fixture.db.prepare(
      `SELECT target_id AS taskId, details_json AS detailsJson
         FROM audit_events
        WHERE workspace_id = ? AND action = 'speaker.action-task.reminder.queued'
        ORDER BY target_id`,
    ).all(EVALUATOR_WORKSPACE_ID) as Array<{ readonly taskId: string; readonly detailsJson: string }>;
    expect(reminderAudits.map((audit) => {
      const details = JSON.parse(audit.detailsJson) as Record<string, unknown>;
      return {
        taskId: audit.taskId,
        recipientPersonId: details.recipientPersonId,
        assignmentId: details.assignmentId,
        occurrenceDate: details.occurrenceDate,
        providerMutation: details.providerMutation,
      };
    }).sort((left, right) => left.taskId.localeCompare(right.taskId))).toEqual(first.queued.map((delivery) => ({
      taskId: delivery.taskId,
      recipientPersonId: delivery.recipientPersonId,
      assignmentId: delivery.assignmentId,
      occurrenceDate: "2026-08-13",
      providerMutation: false,
    })).sort((left, right) => left.taskId.localeCompare(right.taskId)));
    expect(network).not.toHaveBeenCalled();
    expect(sharedCounts(fixture.db)).toMatchObject({ reminderEvents: 2, reminderOutbox: 2 });
    const storedPayloads = fixture.db.prepare(
      `SELECT outbox.payload_json AS payloadJson, outbox.status
       FROM outbox_messages outbox
       JOIN domain_events event_row ON event_row.id = outbox.domain_event_id
       WHERE event_row.event_type = 'speaker.action-task.reminder.queued'
       ORDER BY outbox.id`,
    ).all() as Array<{ readonly payloadJson: string; readonly status: string }>;
    expect(storedPayloads).toHaveLength(2);
    for (const stored of storedPayloads) {
      const payload = JSON.parse(stored.payloadJson) as Record<string, any>;
      expect(stored.status).toBe("PENDING");
      expect(payload).toMatchObject({
        schema: "speaker-action-task-reminder-message/v1",
        channel: "local",
        providerMutation: false,
        reminder: {
          eventId: EVALUATOR_EVENT_ID,
          eventName: "Acme Evaluator Summit",
          taskTitle: "Confirm arrival details",
          taskInstructions: "Review the event brief and confirm your arrival window.",
          dueDate: "2026-08-15",
          occurrenceDate: "2026-08-13",
          providerMutation: false,
        },
      });
      expect(payload.reminder.recipientPersonId).toMatch(/^[a-f0-9-]+$/u);
      expect(stored.payloadJson).not.toContain("@sympose.example");
      expect(stored.payloadJson).not.toContain("Noor Haddad");
      expect(stored.payloadJson).not.toContain("Iris Cole");
    }

    const repeat = fixture.repository.queueDueActionTaskReminders(fixture.scope);
    expect(repeat).toMatchObject({ queuedCount: 0, skippedCount: 2, alreadyQueuedCount: 2 });
    expect(sharedCounts(fixture.db)).toMatchObject({ reminderEvents: 2, reminderOutbox: 2 });
    const failedMessage = first.queued[0]!;
    fixture.db.prepare(
      `UPDATE outbox_messages
       SET status = 'FAILED', attempt_count = 3, next_attempt_at = ?, last_error = ?
       WHERE id = ?`,
    ).run("2026-08-13T12:05:00.000Z", "synthetic retry evidence", failedMessage.messageId);
    expect(fixture.repository.queueDueActionTaskReminders(fixture.scope)).toMatchObject({ queuedCount: 0, alreadyQueuedCount: 2 });
    expect(fixture.repository.listActionTaskReminderDeliveries(fixture.scope).find((delivery) => delivery.messageId === failedMessage.messageId)).toMatchObject({
      status: "FAILED",
      attemptCount: 3,
      nextAttemptAt: "2026-08-13T12:05:00.000Z",
      lastErrorRecorded: true,
    });

    const boundary = fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "reminder-boundary-included",
      dueDate: "2026-08-19",
    }));
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "reminder-boundary-excluded",
      dueDate: "2026-08-20",
    }));
    const boundaryTaskA = boundary.assignments.find((assignment) => assignment.personId === fixture.personA)!;
    const tokenA = issueSpeakerPortalToken(fixture.db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: fixture.personA,
    }, fixture.actor, { now: NOW }).token;
    fixture.repository.completeTask(tokenA, boundaryTaskA.taskId, {
      idempotencyKey: "complete-before-reminder-scan",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY);
    fixture.db.prepare(
      `UPDATE event_speakers SET participation_status = 'DECLINED', updated_at = ?
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).run("2026-08-13T12:03:00.000Z", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, fixture.personB);

    const exclusions = fixture.repository.queueDueActionTaskReminders(fixture.scope);
    expect(exclusions).toMatchObject({
      scannedCount: 6,
      queuedCount: 0,
      skippedCount: 6,
      alreadyQueuedCount: 1,
      completedCount: 1,
      notDueCount: 2,
      nonCurrentSpeakerCount: 2,
    });
    expect(fixture.repository.queueDueActionTaskReminders({ ...fixture.scope, eventId: OTHER_EVENT_ID })).toMatchObject({ scannedCount: 0, queuedCount: 0, skippedCount: 0 });

    clock = "2026-08-14T08:00:00.000Z";
    const laterOccurrence = fixture.repository.queueDueActionTaskReminders(fixture.scope);
    expect(laterOccurrence).toMatchObject({ occurrenceDate: "2026-08-14", queuedCount: 2 });
    expect(new Set(laterOccurrence.queued.map((delivery) => delivery.taskId))).toEqual(new Set([
      eligible.assignments.find((assignment) => assignment.personId === fixture.personA)!.taskId,
      fixture.repository.listSharedActionTasks(fixture.scope)
        .find((batch) => batch.dueDate === "2026-08-20")!
        .assignments.find((assignment) => assignment.personId === fixture.personA)!.taskId,
    ]));
    expect(network).not.toHaveBeenCalled();

    fixture.db.prepare(
      "UPDATE people SET canonical_email = ? WHERE workspace_id = ? AND id = ?",
    ).run("invalid recipient email", EVALUATOR_WORKSPACE_ID, fixture.personA);
    expect(() => fixture.repository.listActionTaskReminderDeliveries(fixture.scope))
      .toThrow(/recipient email is invalid/u);
  });
});

describe("automatic ACTION reminder worker", () => {
  it("prepares the current occurrence without an organizer click and ignores another tenant's unrelated outbox", () => {
    const fixture = setup();
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "automatic-preparation",
    }));
    const otherWorkspace = fixture.db.prepare(
      "SELECT id FROM workspaces WHERE id <> ? ORDER BY id LIMIT 1",
    ).get(EVALUATOR_WORKSPACE_ID) as { readonly id: string };
    const unrelatedPayload = {
      schema: "unrelated-notification/v1",
      workspaceId: otherWorkspace.id,
      marker: "must-remain-pending",
    };
    const unrelatedEventId = deterministicUuid("other-tenant-unrelated-domain-event");
    const unrelatedMessageId = deterministicUuid("other-tenant-unrelated-outbox");
    fixture.db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, 'unrelated.notification', 'unrelated', 'same-looking-task', ?, ?, ?)`,
    ).run(
      unrelatedEventId,
      otherWorkspace.id,
      canonicalJson(unrelatedPayload),
      fingerprintOf(unrelatedPayload),
      NOW,
    );
    fixture.db.prepare(
      `INSERT INTO outbox_messages
         (id, workspace_id, domain_event_id, destination_key, payload_json,
          status, attempt_count, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
    ).run(
      unrelatedMessageId,
      otherWorkspace.id,
      unrelatedEventId,
      `local:speaker-action-task-reminder:${EVALUATOR_EVENT_ID}:same-looking-task:2026-08-13`,
      canonicalJson({ domainEventId: unrelatedEventId, ...unrelatedPayload }),
      NOW,
      NOW,
    );
    const network = vi.spyOn(globalThis, "fetch");

    const first = prepareAutomaticActionTaskReminders(fixture.db, { clock: () => NOW });
    const replay = prepareAutomaticActionTaskReminders(fixture.db, { clock: () => NOW });

    expect(first).toMatchObject({
      eventScopeCount: 1,
      scannedCount: 2,
      queuedCount: 2,
      providerMutation: false,
    });
    expect(replay).toMatchObject({ queuedCount: 0, alreadyQueuedCount: 2 });
    expect(fixture.db.prepare(
      "SELECT COUNT(*) AS count FROM outbox_messages WHERE workspace_id = ? AND destination_key LIKE 'local:speaker-action-task-reminder:%'",
    ).get(EVALUATOR_WORKSPACE_ID)).toEqual({ count: 2 });
    expect(fixture.db.prepare(
      "SELECT status, attempt_count AS attemptCount FROM outbox_messages WHERE id = ? AND workspace_id = ?",
    ).get(unrelatedMessageId, otherWorkspace.id)).toEqual({ status: "PENDING", attemptCount: 0 });
    expect(fixture.db.prepare(
      `SELECT DISTINCT actor_kind AS actorKind, actor_ref AS actorRef
         FROM audit_events
        WHERE workspace_id = ? AND action = 'speaker.action-task.reminder.queued'`,
    ).all(EVALUATOR_WORKSPACE_ID)).toEqual([{
      actorKind: "system",
      actorRef: "speaker-action-task-reminder-worker/v1",
    }]);
    expect(network).not.toHaveBeenCalled();
  });

  it("claims once across concurrent database connections and persists one no-network receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "sympose-reminder-concurrency-"));
    directories.push(directory);
    const path = join(directory, "reminders.sqlite");
    const fixture = setup({ path });
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "concurrent-worker",
    }));
    prepareAutomaticActionTaskReminders(fixture.db, { clock: () => NOW });
    const dueMessageId = deferAllButFirstReminder(fixture.db);
    const competingDb = openDb({ path, seed: false });
    databases.push(competingDb);
    const network = vi.spyOn(globalThis, "fetch");
    let competingReceipt: ReturnType<typeof runAutomaticActionTaskReminderJob> | null = null;
    let providerCalls = 0;
    const adapter: ActionTaskReminderDeliveryAdapter = {
      kind: "test-reminder.no-network/v1",
      networkContacted: false,
      providerMutation: false,
      deliver(intent) {
        providerCalls += 1;
        competingReceipt = runAutomaticActionTaskReminderJob(competingDb, {
          clock: () => NOW,
          maximumDeliveries: 1,
        });
        return noNetworkReceipt(intent, NOW);
      },
    };

    const receipt = runAutomaticActionTaskReminderJob(fixture.db, {
      clock: () => NOW,
      adapter,
      maximumDeliveries: 1,
    });

    expect(receipt).toMatchObject({ claimedCount: 1, deliveredCount: 1, retryingCount: 0 });
    expect(competingReceipt).toMatchObject({ processedCount: 0, claimedCount: 0, deliveredCount: 0 });
    expect(providerCalls).toBe(1);
    expect(fixture.db.prepare(
      "SELECT status, attempt_count AS attemptCount, claim_token AS claimToken, delivered_at AS deliveredAt FROM outbox_messages WHERE id = ?",
    ).get(dueMessageId)).toEqual({
      status: "DELIVERED",
      attemptCount: 1,
      claimToken: null,
      deliveredAt: NOW,
    });
    expect(fixture.db.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE action = 'speaker.action-task.reminder.provider-receipt' AND target_id = ?`,
    ).get(dueMessageId)).toEqual({ count: 1 });
    expect(network).not.toHaveBeenCalled();
  });

  it("reclaims an expired durable lease after process restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "sympose-reminder-lease-restart-"));
    directories.push(directory);
    const path = join(directory, "reminders.sqlite");
    const fixture = setup({ path });
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "lease-restart",
    }));
    prepareAutomaticActionTaskReminders(fixture.db, { clock: () => NOW });
    const dueMessageId = deferAllButFirstReminder(fixture.db);
    fixture.db.prepare(
      `UPDATE outbox_messages
          SET status = 'CLAIMED', attempt_count = 1, next_attempt_at = NULL,
              claim_token = ?, lease_expires_at = ?
        WHERE id = ?`,
    ).run("c".repeat(64), "2026-08-13T12:00:30.000Z", dueMessageId);
    closeTracked(fixture.db);

    const restartedDb = openDb({ path, seed: false });
    databases.push(restartedDb);
    let calls = 0;
    const adapter: ActionTaskReminderDeliveryAdapter = {
      kind: "test-reminder.lease-restart/v1",
      networkContacted: false,
      providerMutation: false,
      deliver(intent) {
        calls += 1;
        return noNetworkReceipt(intent, "2026-08-13T12:01:00.000Z");
      },
    };
    const receipt = runAutomaticActionTaskReminderJob(restartedDb, {
      clock: () => "2026-08-13T12:01:00.000Z",
      adapter,
      maximumDeliveries: 1,
    });

    expect(receipt).toMatchObject({ claimedCount: 1, deliveredCount: 1 });
    expect(calls).toBe(1);
    expect(restartedDb.prepare(
      "SELECT status, attempt_count AS attemptCount, claim_token AS claimToken, lease_expires_at AS leaseExpiresAt FROM outbox_messages WHERE id = ?",
    ).get(dueMessageId)).toEqual({
      status: "DELIVERED",
      attemptCount: 2,
      claimToken: null,
      leaseExpiresAt: null,
    });
  });

  it("survives restart after a redacted provider failure and does not repeat a successful send", () => {
    const directory = mkdtempSync(join(tmpdir(), "sympose-reminder-restart-"));
    directories.push(directory);
    const path = join(directory, "reminders.sqlite");
    const fixture = setup({ path });
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "restart-after-failure",
    }));
    prepareAutomaticActionTaskReminders(fixture.db, { clock: () => NOW });
    const dueMessageId = deferAllButFirstReminder(fixture.db);
    const failingAdapter: ActionTaskReminderDeliveryAdapter = {
      kind: "test-reminder.failure/v1",
      networkContacted: false,
      providerMutation: false,
      deliver() {
        throw new Error("DO_NOT_STORE smtp-password@example.test");
      },
    };

    const failedAttempt = runAutomaticActionTaskReminderJob(fixture.db, {
      clock: () => NOW,
      adapter: failingAdapter,
      maximumDeliveries: 1,
    });
    expect(failedAttempt).toMatchObject({ claimedCount: 1, retryingCount: 1, failedCount: 0 });
    expect(fixture.db.prepare(
      "SELECT status, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt, last_error AS lastError FROM outbox_messages WHERE id = ?",
    ).get(dueMessageId)).toEqual({
      status: "PENDING",
      attemptCount: 1,
      nextAttemptAt: "2026-08-13T12:01:00.000Z",
      lastError: "PROVIDER_FAILURE",
    });
    expect(JSON.stringify(fixture.db.prepare(
      "SELECT last_error FROM outbox_messages WHERE id = ?",
    ).get(dueMessageId))).not.toContain("DO_NOT_STORE");
    closeTracked(fixture.db);

    const restartedDb = openDb({ path, seed: false });
    databases.push(restartedDb);
    let successfulCalls = 0;
    const successAdapter: ActionTaskReminderDeliveryAdapter = {
      kind: "test-reminder.restart/v1",
      networkContacted: false,
      providerMutation: false,
      deliver(intent) {
        successfulCalls += 1;
        return noNetworkReceipt(intent, "2026-08-13T12:01:00.000Z");
      },
    };
    const recovered = runAutomaticActionTaskReminderJob(restartedDb, {
      clock: () => "2026-08-13T12:01:00.000Z",
      adapter: successAdapter,
      maximumDeliveries: 1,
    });
    const replay = runAutomaticActionTaskReminderJob(restartedDb, {
      clock: () => "2026-08-13T12:02:00.000Z",
      adapter: successAdapter,
      maximumDeliveries: 1,
    });

    expect(recovered).toMatchObject({ deliveredCount: 1, retryingCount: 0 });
    expect(replay).toMatchObject({ processedCount: 0, deliveredCount: 0 });
    expect(successfulCalls).toBe(1);
    expect(restartedDb.prepare(
      "SELECT status, attempt_count AS attemptCount, delivered_at AS deliveredAt, last_error AS lastError FROM outbox_messages WHERE id = ?",
    ).get(dueMessageId)).toEqual({
      status: "DELIVERED",
      attemptCount: 2,
      deliveredAt: "2026-08-13T12:01:00.000Z",
      lastError: null,
    });
    expect(restartedDb.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE action = 'speaker.action-task.reminder.provider-receipt' AND target_id = ?`,
    ).get(dueMessageId)).toEqual({ count: 1 });
  });

  it("stops after three provider failures and never stores the provider error payload", () => {
    const fixture = setup();
    fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "bounded-provider-failure",
    }));
    prepareAutomaticActionTaskReminders(fixture.db, { clock: () => NOW });
    const dueMessageId = deferAllButFirstReminder(fixture.db);
    let calls = 0;
    const adapter: ActionTaskReminderDeliveryAdapter = {
      kind: "test-reminder.always-fails/v1",
      networkContacted: false,
      providerMutation: false,
      deliver() {
        calls += 1;
        throw new Error("DO_NOT_STORE bearer-secret-and-recipient@example.test");
      },
    };
    const times = [
      "2026-08-13T12:00:00.000Z",
      "2026-08-13T12:01:00.000Z",
      "2026-08-13T12:03:00.000Z",
    ];
    const receipts = times.map((time) => runAutomaticActionTaskReminderJob(fixture.db, {
      clock: () => time,
      adapter,
      maximumDeliveries: 1,
    }));
    const afterLimit = runAutomaticActionTaskReminderJob(fixture.db, {
      clock: () => "2026-08-13T12:10:00.000Z",
      adapter,
      maximumDeliveries: 1,
    });

    expect(receipts.map((receipt) => [receipt.retryingCount, receipt.failedCount])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(afterLimit.processedCount).toBe(0);
    expect(calls).toBe(3);
    expect(fixture.db.prepare(
      "SELECT status, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt, last_error AS lastError FROM outbox_messages WHERE id = ?",
    ).get(dueMessageId)).toEqual({
      status: "FAILED",
      attemptCount: 3,
      nextAttemptAt: null,
      lastError: "PROVIDER_FAILURE",
    });
    expect(JSON.stringify(fixture.db.prepare(
      "SELECT last_error FROM outbox_messages WHERE id = ?",
    ).get(dueMessageId))).not.toContain("DO_NOT_STORE");
    expect(fixture.db.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE action = 'speaker.action-task.reminder.provider-receipt' AND target_id = ?`,
    ).get(dueMessageId)).toEqual({ count: 0 });
  });

  it("terminalizes queued occurrences after task completion or assignment revocation without changing workflow status", () => {
    const fixture = setup();
    const batch = fixture.repository.createSharedActionTask(fixture.scope, createInput(fixture, {
      idempotencyKey: "stop-after-authority-change",
    }));
    prepareAutomaticActionTaskReminders(fixture.db, { clock: () => NOW });
    const taskA = batch.assignments.find((assignment) => assignment.personId === fixture.personA)!;
    const tokenA = issueSpeakerPortalToken(fixture.db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: fixture.personA,
    }, fixture.actor, { now: NOW }).token;
    fixture.repository.completeTask(tokenA, taskA.taskId, {
      idempotencyKey: "complete-before-worker",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY);
    fixture.db.prepare(
      `UPDATE event_speakers SET participation_status = 'DECLINED', updated_at = ?
        WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).run("2026-08-13T12:00:01.000Z", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, fixture.personB);
    let providerCalls = 0;
    const adapter: ActionTaskReminderDeliveryAdapter = {
      kind: "test-reminder.must-not-run/v1",
      networkContacted: false,
      providerMutation: false,
      deliver(intent) {
        providerCalls += 1;
        return noNetworkReceipt(intent, NOW);
      },
    };

    const receipt = runAutomaticActionTaskReminderJob(fixture.db, {
      clock: () => NOW,
      adapter,
      maximumDeliveries: 2,
    });

    expect(receipt).toMatchObject({
      claimedCount: 0,
      deliveredCount: 0,
      failedCount: 2,
      stoppedBeforeDeliveryCount: 2,
    });
    expect(providerCalls).toBe(0);
    expect(fixture.db.prepare(
      `SELECT outbox.status, outbox.last_error AS lastError
         FROM outbox_messages outbox
         JOIN domain_events event_row ON event_row.id = outbox.domain_event_id
        WHERE event_row.event_type = 'speaker.action-task.reminder.queued'
        ORDER BY outbox.last_error`,
    ).all()).toEqual([
      { status: "FAILED", lastError: "ASSIGNMENT_REVOKED" },
      { status: "FAILED", lastError: "TASK_COMPLETED" },
    ]);
    expect(fixture.db.prepare(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.workflow.status.updated'",
    ).get()).toEqual({ count: 0 });
    expect(fixture.db.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE action = 'speaker.action-task.reminder.provider-receipt'`,
    ).get()).toEqual({ count: 0 });
  });
});
