import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID,
  EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  seedEvaluatorCompatibility,
} from "../../src/server/evaluator-compatibility";
import { seedWorkspaces } from "../../src/server/seed";
import {
  createSyntheticSpeakerOperationsRepository,
  SpeakerOperationsConflictError,
  type SpeakerEventContext,
  type SpeakerOrganizerScope,
} from "../../src/server/services/speaker-operations";
import {
  issueSpeakerPortalToken,
  SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY,
  type SpeakerPortalTokenActor,
} from "../../src/server/services/speaker-portal-access";

const databases: Db[] = [];
const event: SpeakerEventContext = {
  id: EVALUATOR_COMPATIBILITY_EVENT_ID,
  name: "DevFlow Conf 2027",
  timezone: "UTC",
  startsAt: "2027-09-16T09:00:00.000Z",
  endsAt: "2027-09-16T17:00:00.000Z",
};
const organizerScope: SpeakerOrganizerScope = {
  kind: "organizer",
  workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
  actorId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
};

function setup(): Db {
  const db = openDb({ path: ":memory:", seed: false });
  databases.push(db);
  seedWorkspaces(db);
  seedEvaluatorCompatibility(db);
  return db;
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
  ).get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID) as { sessionId: string; accountId: string } | undefined;
  if (!row) throw new Error("test organizer session unavailable");
  return row;
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
});

describe("DevFlow accepted speaker portal continuity", () => {
  it("issues only Priya's canonical scoped portal and preserves it across repository reload", () => {
    const db = setup();
    const actor = organizerActor(db);
    const issued = issueSpeakerPortalToken(db, {
      workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    }, actor);
    const currentAssignment = db.prepare(
      `SELECT id FROM plan_assignments
        WHERE workspace_id = ?
          AND plan_version_id = (SELECT current_plan_version_id FROM events WHERE workspace_id = ? AND id = ?)
          AND person_id = ?`,
    ).get(
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    ) as { id: string };
    const repository = createSyntheticSpeakerOperationsRepository({ db });
    const portal = repository.getPortalProjection(issued.token, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY);

    expect(portal).not.toBeNull();
    expect(portal).toMatchObject({
      person: { personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, fullName: "Priya Raman" },
      event: { id: EVALUATOR_COMPATIBILITY_EVENT_ID, name: "DevFlow Conf 2027" },
      assignment: { assignmentId: currentAssignment.id, personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID },
    });
    expect(portal?.tasks.map((task) => task.contentKind).sort()).toEqual([
      "HEADSHOT",
      "SESSION_DESCRIPTION",
      "SESSION_TITLE",
      "SLIDES",
    ]);
    expect(portal?.tasks.every((task) => task.personId === EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID)).toBe(true);
    expect(portal?.tasks.every((task) => task.assignmentId === currentAssignment.id)).toBe(true);
    expect(JSON.stringify(portal)).not.toContain("Marcus Okafor");
    expect(JSON.stringify(portal)).not.toContain(EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID);

    const reloaded = createSyntheticSpeakerOperationsRepository({ db });
    const reloadedPortal = reloaded.getPortalProjection(issued.token, "speaker-content:reload:page");
    expect(reloadedPortal).toMatchObject({
      person: { personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, fullName: "Priya Raman" },
      assignment: { assignmentId: currentAssignment.id },
    });
    expect(reloadedPortal?.tasks.map((task) => task.contentKind).sort()).toEqual([
      "HEADSHOT",
      "SESSION_DESCRIPTION",
      "SESSION_TITLE",
      "SLIDES",
    ]);
  });

  it("denies another person, event, or workspace before creating a portal token", () => {
    const db = setup();
    const actor = organizerActor(db);
    expect(() => issueSpeakerPortalToken(db, {
      workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID,
    }, actor)).toThrow("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    expect(() => issueSpeakerPortalToken(db, {
      workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      eventId: "other-event",
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    }, actor)).toThrow("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    expect(() => issueSpeakerPortalToken(db, {
      workspaceId: "other-workspace",
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    }, actor)).toThrow("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get()).toEqual({ count: 0 });
  });

  it("persists the independent organizer workflow status and filters after reload", () => {
    const db = setup();
    const repository = createSyntheticSpeakerOperationsRepository({ db });
    expect(repository.getOrganizerProjection(organizerScope, event).roster[0]).toMatchObject({
      person: { personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID },
      workflowStatus: "NEW",
    });
    expect(repository.updateWorkflowStatus(organizerScope, EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, {
      status: "NEW",
      expectedCurrentStatus: "NEW",
      expectedVersion: null,
      idempotencyKey: "devflow-status-new-noop-v1",
    })).toEqual({ status: "NEW", version: null, created: false });
    expect(repository.getOrganizerProjection(organizerScope, event).roster[0]?.workflowStatusVersion).toBeNull();

    expect(repository.updateWorkflowStatus(organizerScope, EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, { status: "READY", expectedCurrentStatus: "NEW", expectedVersion: null, idempotencyKey: "devflow-status-ready-v1" })).toMatchObject({
      status: "READY",
      created: true,
    });
    expect(repository.updateWorkflowStatus(organizerScope, EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, { status: "READY", expectedCurrentStatus: "NEW", expectedVersion: null, idempotencyKey: "devflow-status-ready-v1" })).toMatchObject({
      status: "READY",
      created: false,
    });
    expect(() => repository.updateWorkflowStatus(organizerScope, EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, { status: "IN_PROGRESS", expectedCurrentStatus: "NEW", expectedVersion: null, idempotencyKey: "devflow-status-ready-v1" })).toThrow(/idempotency key/u);

    const reloaded = createSyntheticSpeakerOperationsRepository({ db });
    expect(reloaded.getOrganizerProjection(organizerScope, event, { workflowStatus: "READY" }).roster.map((record) => record.person.fullName)).toEqual(["Priya Raman"]);
    expect(reloaded.getOrganizerProjection(organizerScope, event, { workflowStatus: "IN_PROGRESS" }).roster).toEqual([]);
    expect(db.prepare(
      `SELECT event_type, aggregate_type, aggregate_id,
              json_extract(payload_json, '$.workspaceId') AS workspaceId,
              json_extract(payload_json, '$.eventId') AS eventId,
              json_extract(payload_json, '$.personId') AS personId,
              json_extract(payload_json, '$.status') AS status
         FROM domain_events
        WHERE workspace_id = ? AND event_type = 'speaker.workflow.status.updated'`,
    ).all(EVALUATOR_COMPATIBILITY_WORKSPACE_ID)).toEqual([{
      event_type: "speaker.workflow.status.updated",
      aggregate_type: "event_speaker",
      aggregate_id: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      status: "READY",
    }]);
  });

  it("keeps out-of-order two-tab edits and old replays from regressing the latest status", () => {
    const db = setup();
    const tabA = createSyntheticSpeakerOperationsRepository({ db });
    const tabB = createSyntheticSpeakerOperationsRepository({ db });
    const initial = { status: "READY" as const, expectedCurrentStatus: "NEW" as const, expectedVersion: null, idempotencyKey: "two-tab-ready-v1" };
    const ready = tabA.updateWorkflowStatus(organizerScope, EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, initial);
    expect(ready).toMatchObject({ status: "READY", created: true });
    expect(ready.version).toEqual(expect.any(String));

    expect(() => tabB.updateWorkflowStatus(organizerScope, EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, {
      status: "ON_HOLD",
      expectedCurrentStatus: "NEW",
      expectedVersion: null,
      idempotencyKey: "two-tab-stale-hold-v1",
    })).toThrow(SpeakerOperationsConflictError);

    const held = tabA.updateWorkflowStatus(organizerScope, EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, {
      status: "ON_HOLD",
      expectedCurrentStatus: "READY",
      expectedVersion: ready.version,
      idempotencyKey: "two-tab-hold-v1",
    });
    expect(held).toMatchObject({ status: "ON_HOLD", created: true });

    const oldReplay = tabB.updateWorkflowStatus(organizerScope, EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID, initial);
    expect(oldReplay).toEqual({ status: "READY", version: ready.version, created: false });
    expect(tabB.getOrganizerProjection(organizerScope, event).roster.find((record) => record.person.personId === EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID)).toMatchObject({
      workflowStatus: "ON_HOLD",
      workflowStatusVersion: held.version,
    });
    expect(db.prepare(
      `SELECT COUNT(*) AS count
         FROM domain_events
        WHERE workspace_id = ? AND event_type = 'speaker.workflow.status.updated'`,
    ).get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID)).toEqual({ count: 2 });
  });
});
