import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { closeDb, openDb, type Db } from "@/server/db";
import { deterministicUuid } from "@/server/canonical";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_PROGRAM_UNIT_ID,
  EVALUATOR_SPEAKER_PERSON_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "@/server/evaluator-demo";
import { seedWorkspaces } from "@/server/seed";
import { readCanonicalScheduleProjection } from "@/server/services/scheduling/canonical";
import { executeScheduleDraftCommand, readScheduleDraft } from "@/server/services/scheduling/persistence";
import { getWorkspaceBySlug } from "@/server/services/queries";
import { importFixtureEvidence } from "@/server/services/sources";
import { freezeCohortSnapshot } from "@/server/services/cohorts";
import { createEventWithUnit } from "@/server/services/events";
import { approvePlan, compilePlan } from "@/server/services/planning";
import { deliverOffers, nextPendingOffer, respondToOfferCommand, commitmentResponseCommandKey } from "@/server/services/commitments";
import { sealRelease, validatePublicReleaseForRead } from "@/server/services/publication";
import { resolveCurrentDurablePublicAgenda } from "@/server/services/public-agenda";
import { publicReleaseReference } from "@/server/services/public-reference";
import {
  resolveCurrentPublicAgendaRelease,
  resolveCurrentPublicAgendaReleaseByChannel,
  toPublicWidgetProjection,
} from "@/server/services/public-widgets";
import { createSyntheticSpeakerOperationsRepository } from "@/server/services/speaker-operations";
import { persistAndApproveCurrentSchedule } from "../helpers/schedule-approval";

const STAGE3_AT = "2026-08-13T00:00:00.000Z";

const evaluatorScheduleScope = {
  workspaceId: EVALUATOR_WORKSPACE_ID,
  eventId: EVALUATOR_EVENT_ID,
} as const;

const evaluatorOrganizerScope = {
  kind: "organizer" as const,
  workspaceId: EVALUATOR_WORKSPACE_ID,
  eventId: EVALUATOR_EVENT_ID,
  actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
};

function configureAndMoveEvaluatorSchedule(db: Db) {
  const initial = readScheduleDraft(db, evaluatorScheduleScope);
  executeScheduleDraftCommand(db, evaluatorScheduleScope, {
    expectedRevision: initial.schedule.revision,
    planVersionId: initial.schedule.planVersionId,
    planFingerprint: initial.schedule.planFingerprint,
    acceptedInventoryFingerprint: initial.schedule.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: initial.schedule.cfpSessionInventoryFingerprint,
    command: {
      kind: "CONFIGURE",
      rooms: [{ ...initial.schedule.rooms[0]!, name: "Main room", venue: "Main venue", capacity: 100 }],
      tracks: [{ ...initial.schedule.tracks[0]!, name: "Main program", ordinal: 1 }],
    },
    idempotencyKey: "stage3-evaluator-configure",
    requestId: "stage3-evaluator-configure-request",
    actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
  });
  const configured = readScheduleDraft(db, evaluatorScheduleScope);
  const session = configured.schedule.sessions.find((candidate) => candidate.id === EVALUATOR_PROGRAM_UNIT_ID);
  if (!session) throw new Error("stage3 fixture session is unavailable");
  const slot = configured.schedule.timeSlots.find((candidate) =>
    candidate.startsAt === "2026-09-18T10:00:00.000Z" && candidate.endsAt === "2026-09-18T10:45:00.000Z",
  );
  if (!slot) throw new Error("stage3 fixture time slot is unavailable");
  const moved = executeScheduleDraftCommand(db, evaluatorScheduleScope, {
    expectedRevision: configured.schedule.revision,
    planVersionId: configured.schedule.planVersionId,
    planFingerprint: configured.schedule.planFingerprint,
    acceptedInventoryFingerprint: configured.schedule.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: configured.schedule.cfpSessionInventoryFingerprint,
    command: {
      kind: "MOVE",
      sessionId: session.id,
      target: {
        dayId: slot.dayId,
        timeSlotId: slot.id,
        roomId: configured.schedule.rooms[0]!.id,
        trackId: configured.schedule.tracks[0]!.id,
      },
    },
    idempotencyKey: "stage3-evaluator-move",
    requestId: "stage3-evaluator-move-request",
    actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
  });
  persistAndApproveCurrentSchedule(
    db,
    evaluatorScheduleScope,
    EVALUATOR_ORGANIZER_ACCOUNT_ID,
    "stage3-evaluator-schedule",
  );
  return moved;
}

interface MultiSpeakerSessionFixture {
  readonly db: Db;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly actor: { readonly kind: "account"; readonly ref: string };
  readonly organizerScope: {
    readonly kind: "organizer";
    readonly workspaceId: string;
    readonly eventId: string;
    readonly actorId: string;
  };
  readonly speaker: ReturnType<typeof createSyntheticSpeakerOperationsRepository>;
  readonly unitId: string;
  readonly speakers: readonly {
    readonly personId: string;
    readonly titleTaskId: string;
    readonly descriptionTaskId: string;
  }[];
}

function createMultiSpeakerSessionFixture(): MultiSpeakerSessionFixture {
  const db = openDb({ path: ":memory:" });
  seedWorkspaces(db);
  const workspace = getWorkspaceBySlug(db, "northstar")!;
  const account = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY created_at LIMIT 1").get(workspace.id) as { id: string };
  const actor = { kind: "account" as const, ref: account.id };
  importFixtureEvidence(db, workspace.id, workspace.slug);
  freezeCohortSnapshot(db, workspace.id, actor);
  const event = createEventWithUnit(db, workspace.id, actor, { eventName: "Multi-speaker continuity event", unitName: "Shared session" });
  const plan = compilePlan(db, workspace.id, event.eventId, actor);
  approvePlan(db, workspace.id, event.eventId, plan.planVersionId, null, actor);
  deliverOffers(db, workspace.id, event.eventId, actor);
  const offers = db.prepare(
    `SELECT id, person_id AS personId,
            json_extract(terms_json, '$.programUnitId') AS programUnitId
       FROM commitment_offers
      WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?
      ORDER BY created_at, rowid`,
  ).all(workspace.id, event.eventId, plan.planVersionId) as Array<{ id: string; personId: string; programUnitId: string }>;
  const selectedOffers = offers.slice(0, 2);
  if (selectedOffers.length !== 2 || selectedOffers.some((offer) => offer.programUnitId !== selectedOffers[0]!.programUnitId)) {
    closeDb(db);
    throw new Error("multi-speaker continuity fixture did not produce two assignments for one unit");
  }
  for (const offer of selectedOffers) {
    respondToOfferCommand(db, workspace.id, event.eventId, {
      offerId: offer.id,
      response: "accepted",
      commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
    });
  }
  const assignments = db.prepare(
    `SELECT id AS assignmentId, person_id AS personId, program_unit_id AS programUnitId, assignment_type AS assignmentType
       FROM plan_assignments
      WHERE workspace_id = ? AND plan_version_id = ?`,
  ).all(workspace.id, plan.planVersionId) as Array<{ assignmentId: string; personId: string; programUnitId: string; assignmentType: string }>;
  for (const offer of selectedOffers) {
    const assignment = assignments.find((candidate) => candidate.personId === offer.personId && candidate.programUnitId === offer.programUnitId);
    if (!assignment) {
      closeDb(db);
      throw new Error("multi-speaker continuity fixture assignment is unavailable");
    }
    const role = assignment.assignmentType === "moderator" || assignment.assignmentType === "MODERATOR" ? "MODERATOR" : "SPEAKER";
    db.prepare(
      `INSERT INTO event_speakers
         (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?)`,
    ).run(
      deterministicUuid(`stage3-multi-speaker:${workspace.id}:${event.eventId}:${offer.personId}`),
      workspace.id,
      event.eventId,
      offer.personId,
      role,
      STAGE3_AT,
      STAGE3_AT,
    );
  }

  const organizerScope = {
    kind: "organizer" as const,
    workspaceId: workspace.id,
    eventId: event.eventId,
    actorId: account.id,
  };
  const speaker = createSyntheticSpeakerOperationsRepository({ db, clock: () => STAGE3_AT });
  const speakers = selectedOffers.map((offer, index) => {
    const titleTask = speaker.createTask(organizerScope, {
      personId: offer.personId,
      kind: "SESSION_TITLE",
      contentKind: "SESSION_TITLE",
      title: `Session title task ${index + 1}`,
      description: "Audience-facing session title.",
      required: true,
      gate: "PUBLICATION",
      dueAt: "2026-08-25T17:00:00.000Z",
      owner: "SPEAKER",
      idempotencyKey: `stage3-multi-title-task-${index + 1}`,
    });
    const descriptionTask = speaker.createTask(organizerScope, {
      personId: offer.personId,
      kind: "SESSION_DESCRIPTION",
      contentKind: "SESSION_DESCRIPTION",
      title: `Session description task ${index + 1}`,
      description: "Audience-facing session abstract.",
      required: true,
      gate: "PUBLICATION",
      dueAt: "2026-08-25T17:00:00.000Z",
      owner: "SPEAKER",
      idempotencyKey: `stage3-multi-description-task-${index + 1}`,
    });
    return { personId: offer.personId, titleTaskId: titleTask.id, descriptionTaskId: descriptionTask.id };
  });

  const scheduleScope = { workspaceId: workspace.id, eventId: event.eventId } as const;
  const initial = readScheduleDraft(db, scheduleScope);
  const configured = executeScheduleDraftCommand(db, scheduleScope, {
    expectedRevision: initial.schedule.revision,
    planVersionId: initial.schedule.planVersionId,
    planFingerprint: initial.schedule.planFingerprint,
    acceptedInventoryFingerprint: initial.schedule.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: initial.schedule.cfpSessionInventoryFingerprint,
    command: {
      kind: "CONFIGURE",
      rooms: [{ ...initial.schedule.rooms[0]!, name: "Main room", venue: "Main venue", capacity: 100 }],
      tracks: [{ ...initial.schedule.tracks[0]!, name: "Main program", ordinal: 1 }],
    },
    idempotencyKey: "stage3-multi-configure",
    requestId: "stage3-multi-configure-request",
    actorAccountId: account.id,
  });
  const slot = configured.schedule.timeSlots[0];
  if (!slot) {
    closeDb(db);
    throw new Error("multi-speaker continuity fixture time slot is unavailable");
  }
  executeScheduleDraftCommand(db, scheduleScope, {
    expectedRevision: configured.schedule.revision,
    planVersionId: configured.schedule.planVersionId,
    planFingerprint: configured.schedule.planFingerprint,
    acceptedInventoryFingerprint: configured.schedule.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: configured.schedule.cfpSessionInventoryFingerprint,
    command: {
      kind: "MOVE",
      sessionId: selectedOffers[0]!.programUnitId,
      target: {
        dayId: slot.dayId,
        timeSlotId: slot.id,
        roomId: configured.schedule.rooms[0]!.id,
        trackId: configured.schedule.tracks[0]!.id,
      },
    },
    idempotencyKey: "stage3-multi-move",
    requestId: "stage3-multi-move-request",
    actorAccountId: account.id,
  });
  persistAndApproveCurrentSchedule(db, scheduleScope, account.id, "stage3-multi-schedule");
  return {
    db,
    workspaceId: workspace.id,
    eventId: event.eventId,
    actor,
    organizerScope,
    speaker,
    unitId: selectedOffers[0]!.programUnitId,
    speakers,
  };
}

function approveMultiSpeakerContent(
  fixture: MultiSpeakerSessionFixture,
  contentFor: (index: number) => { readonly title: string; readonly description: string },
): void {
  fixture.speakers.forEach((speaker, index) => {
    const content = contentFor(index);
    const title = fixture.speaker.submitOrganizerContent(fixture.organizerScope, {
      personId: speaker.personId,
      taskId: speaker.titleTaskId,
      payload: { kind: "SESSION_TITLE", title: content.title },
      idempotencyKey: `stage3-multi-title-version-${index + 1}`,
    });
    const description = fixture.speaker.submitOrganizerContent(fixture.organizerScope, {
      personId: speaker.personId,
      taskId: speaker.descriptionTaskId,
      payload: { kind: "SESSION_DESCRIPTION", description: content.description },
      idempotencyKey: `stage3-multi-description-version-${index + 1}`,
    });
    fixture.speaker.approveContent(fixture.organizerScope, {
      personId: speaker.personId,
      taskId: speaker.titleTaskId,
      submissionVersionId: title.id,
      submissionContentHash: title.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: `stage3-multi-title-approval-${index + 1}`,
    });
    fixture.speaker.approveContent(fixture.organizerScope, {
      personId: speaker.personId,
      taskId: speaker.descriptionTaskId,
      submissionVersionId: description.id,
      submissionContentHash: description.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: `stage3-multi-description-approval-${index + 1}`,
    });
  });
}

function expectPublicationUnchanged(fixture: MultiSpeakerSessionFixture, before: { readonly count: number; readonly currentReleaseId: string | null }): void {
  expect(dbValue(fixture.db, "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId)).toEqual({ count: before.count });
  expect(dbValue(fixture.db, "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?", fixture.workspaceId, fixture.eventId)).toEqual({ currentReleaseId: before.currentReleaseId });
}

function dbValue(db: Db, sql: string, ...parameters: string[]): Record<string, unknown> {
  return db.prepare(sql).get(...parameters) as Record<string, unknown>;
}

describe("stage3 devflow continuity", () => {
  it("derives inventory only from the approved accepted source", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedWorkspaces(db);
      seedEvaluatorDemo(db);
      db.prepare(
        `INSERT INTO program_units
           (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
         VALUES (?, ?, ?, 'Rejected raw unit', 'session', ?, ?, 20, ?)`,
      ).run("rejected-raw-unit", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, "2026-09-18T11:00:00.000Z", "2026-09-18T11:45:00.000Z", STAGE3_AT);
      const event = db.prepare(
        `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt,
                current_plan_version_id AS currentPlanVersionId
           FROM events WHERE workspace_id = ? AND id = ?`,
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as Record<string, unknown>;
      const schedule = readCanonicalScheduleProjection(db, evaluatorScheduleScope, event);
      expect(schedule?.sessions.map((session) => session.id)).toEqual([EVALUATOR_PROGRAM_UNIT_ID]);
      expect(schedule?.sessions.some((session) => session.id === "rejected-raw-unit")).toBe(false);
    } finally { closeDb(db); }
  });

  it("blocks publication when the durable schedule allocation is missing", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedWorkspaces(db);
      seedEvaluatorDemo(db);
      configureAndMoveEvaluatorSchedule(db);
      const releasesBefore = db.prepare(
        "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { count: number };
      db.prepare(
        `DELETE FROM event_session_allocations
          WHERE workspace_id = ? AND event_id = ? AND program_unit_id = ?`,
      ).run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_PROGRAM_UNIT_ID);
      expect(() => sealRelease(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, {
        kind: "account",
        ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      })).toThrow("SCHEDULE_NOT_DURABLE");
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual(releasesBefore);
    } finally { closeDb(db); }
  });

  it("blocks publication when exact session content approval is absent", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const workspace = getWorkspaceBySlug(db, "northstar")!;
      const account = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY created_at LIMIT 1").get(workspace.id) as { id: string };
      const actor = { kind: "account" as const, ref: account.id };
      importFixtureEvidence(db, workspace.id, workspace.slug);
      freezeCohortSnapshot(db, workspace.id, actor);
      const event = createEventWithUnit(db, workspace.id, actor, { eventName: "Debug publication event", unitName: "Published unit" });
      const plan = compilePlan(db, workspace.id, event.eventId, actor);
      approvePlan(db, workspace.id, event.eventId, plan.planVersionId, null, actor);
      deliverOffers(db, workspace.id, event.eventId, actor);
      const offer = nextPendingOffer(db, workspace.id, event.eventId)!;
      respondToOfferCommand(db, workspace.id, event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      const scope = { workspaceId: workspace.id, eventId: event.eventId } as const;
      const initial = readScheduleDraft(db, scope);
      const configured = executeScheduleDraftCommand(db, scope, {
        expectedRevision: initial.schedule.revision,
        planVersionId: initial.schedule.planVersionId,
        planFingerprint: initial.schedule.planFingerprint,
        acceptedInventoryFingerprint: initial.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: initial.schedule.cfpSessionInventoryFingerprint,
        command: {
          kind: "CONFIGURE",
          rooms: [{ ...initial.schedule.rooms[0]!, name: "Main room", venue: "Debug venue", capacity: 20 }],
          tracks: [{ ...initial.schedule.tracks[0]!, name: "Main program", ordinal: 1 }],
        },
        idempotencyKey: "stage3-configure",
        requestId: "stage3-configure-request",
      });
      const afterConfiguration = readScheduleDraft(db, scope);
      expect(configured.schedule.revision).toBe(afterConfiguration.schedule.revision);
      const session = afterConfiguration.schedule.sessions[0]!;
      const slot = afterConfiguration.schedule.timeSlots.find((candidate) => candidate.startsAt === "2026-09-15T09:00:00.000Z" && candidate.endsAt === "2026-09-15T13:00:00.000Z")!;
      const moved = executeScheduleDraftCommand(db, scope, {
        expectedRevision: afterConfiguration.schedule.revision,
        planVersionId: afterConfiguration.schedule.planVersionId,
        planFingerprint: afterConfiguration.schedule.planFingerprint,
        acceptedInventoryFingerprint: afterConfiguration.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: afterConfiguration.schedule.cfpSessionInventoryFingerprint,
        command: {
          kind: "MOVE",
          sessionId: session.id,
          target: {
            dayId: slot.dayId,
            timeSlotId: slot.id,
            roomId: afterConfiguration.schedule.rooms[0]!.id,
            trackId: afterConfiguration.schedule.tracks[0]!.id,
          },
        },
        idempotencyKey: "stage3-move",
        requestId: "stage3-move-request",
      });
      expect(moved.schedule.sessions[0]?.placement).toMatchObject({
        roomId: afterConfiguration.schedule.rooms[0]!.id,
        timeSlotId: slot.id,
      });
      persistAndApproveCurrentSchedule(db, scope, account.id, "stage3-missing-content-schedule");
      const releasesBefore = db.prepare(
        "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
      ).get(workspace.id, event.eventId) as { count: number };
      expect(() => sealRelease(db, workspace.id, event.eventId, actor)).toThrow("SESSION_CONTENT_REQUIREMENTS_INCOMPLETE");
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
      ).get(workspace.id, event.eventId)).toEqual(releasesBefore);
    } finally { closeDb(db); }
  });

  it("blocks two accepted speakers with conflicting approved session pairs atomically", () => {
    const fixture = createMultiSpeakerSessionFixture();
    try {
      approveMultiSpeakerContent(fixture, (index) => ({
        title: `Conflicting title ${index + 1}`,
        description: `Conflicting abstract ${index + 1}`,
      }));
      const before = {
        count: (dbValue(fixture.db, "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId).count as number),
        currentReleaseId: dbValue(fixture.db, "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?", fixture.workspaceId, fixture.eventId).currentReleaseId as string | null,
      };
      expect(() => sealRelease(fixture.db, fixture.workspaceId, fixture.eventId, fixture.actor))
        .toThrow("SESSION_CONTENT_NOT_APPROVED");
      expectPublicationUnchanged(fixture, before);
    } finally { closeDb(fixture.db); }
  });

  it("seals one canonical session pair once when accepted speakers duplicate it exactly", () => {
    const fixture = createMultiSpeakerSessionFixture();
    try {
      approveMultiSpeakerContent(fixture, () => ({
        title: "One canonical shared title",
        description: "One canonical shared abstract",
      }));
      const release = sealRelease(fixture.db, fixture.workspaceId, fixture.eventId, fixture.actor);
      expect(release.created).toBe(true);
      const replay = sealRelease(fixture.db, fixture.workspaceId, fixture.eventId, fixture.actor);
      expect(replay).toMatchObject({ releaseId: release.releaseId, fingerprint: release.fingerprint, created: false });
      expect(dbValue(fixture.db, "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId)).toEqual({ count: 1 });
      const content = JSON.parse((fixture.db.prepare("SELECT content_json AS content FROM publication_releases WHERE id = ?").get(release.releaseId) as { content: string }).content) as {
        schedule: { sessions: Array<{ title: string; abstract: string; speakerPersonIds: string[] }> };
      };
      expect(content.schedule.sessions).toHaveLength(1);
      expect(content.schedule.sessions[0]).toMatchObject({
        title: "One canonical shared title",
        abstract: "One canonical shared abstract",
      });
      expect(content.schedule.sessions[0]?.speakerPersonIds).toHaveLength(2);
    } finally { closeDb(fixture.db); }
  });

  it("blocks a selected session when one accepted speaker lacks its bound content pair", () => {
    const fixture = createMultiSpeakerSessionFixture();
    try {
      const firstSpeaker = fixture.speakers[0]!;
      const content = { title: "Only one speaker title", description: "Only one speaker abstract" };
      const title = fixture.speaker.submitOrganizerContent(fixture.organizerScope, {
        personId: firstSpeaker.personId,
        taskId: firstSpeaker.titleTaskId,
        payload: { kind: "SESSION_TITLE", title: content.title },
        idempotencyKey: "stage3-missing-title-version",
      });
      const description = fixture.speaker.submitOrganizerContent(fixture.organizerScope, {
        personId: firstSpeaker.personId,
        taskId: firstSpeaker.descriptionTaskId,
        payload: { kind: "SESSION_DESCRIPTION", description: content.description },
        idempotencyKey: "stage3-missing-description-version",
      });
      fixture.speaker.approveContent(fixture.organizerScope, {
        personId: firstSpeaker.personId,
        taskId: firstSpeaker.titleTaskId,
        submissionVersionId: title.id,
        submissionContentHash: title.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "stage3-missing-title-approval",
      });
      fixture.speaker.approveContent(fixture.organizerScope, {
        personId: firstSpeaker.personId,
        taskId: firstSpeaker.descriptionTaskId,
        submissionVersionId: description.id,
        submissionContentHash: description.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "stage3-missing-description-approval",
      });
      const before = {
        count: (dbValue(fixture.db, "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId).count as number),
        currentReleaseId: dbValue(fixture.db, "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?", fixture.workspaceId, fixture.eventId).currentReleaseId as string | null,
      };
      expect(() => sealRelease(fixture.db, fixture.workspaceId, fixture.eventId, fixture.actor))
        .toThrow("SESSION_CONTENT_NOT_APPROVED");
      expectPublicationUnchanged(fixture, before);
    } finally { closeDb(fixture.db); }
  });

  it("persists accepted scheduling, gates exact content, and serves an immutable rich release", () => {
    const directory = mkdtempSync(join(process.cwd(), ".stage3-continuity-"));
    const path = join(directory, "stage3.db");
    let db = openDb({ path, seed: false });
    try {
      seedWorkspaces(db);
      seedEvaluatorDemo(db);
      const moved = configureAndMoveEvaluatorSchedule(db);
      const roomId = moved.schedule.rooms[0]!.id;
      const trackId = moved.schedule.tracks[0]!.id;
      const persistedBeforeReload = readScheduleDraft(db, evaluatorScheduleScope);
      expect(persistedBeforeReload.schedule.revision).toBe(moved.schedule.revision);
      expect(persistedBeforeReload.schedule.sessions[0]?.placement).toMatchObject({
        roomId,
        trackId,
      });
      expect(db.prepare(
        `SELECT COUNT(*) AS count
           FROM event_session_allocations
          WHERE workspace_id = ? AND event_id = ? AND program_unit_id = ?
            AND allocation_status = 'DRAFT'`,
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_PROGRAM_UNIT_ID)).toEqual({ count: 1 });

      closeDb(db);
      db = openDb({ path, seed: false });
      const reloaded = readScheduleDraft(db, evaluatorScheduleScope);
      expect(reloaded.schedule.revision).toBe(moved.schedule.revision);
      expect(reloaded.schedule.sessions[0]?.placement).toEqual(moved.schedule.sessions[0]?.placement);

      try {
        readScheduleDraft(db, { workspaceId: "other-stage3-workspace", eventId: EVALUATOR_EVENT_ID });
        throw new Error("tenant denial was not enforced");
      } catch (error) {
        expect(error).toMatchObject({ code: "SCHEDULE_SCOPE_DENIED" });
      }
      expect(resolveCurrentPublicAgendaRelease(
        db,
        { workspaceId: "other-stage3-workspace", eventId: EVALUATOR_EVENT_ID },
        EVALUATOR_EVENT_ID,
      )).toBeNull();

      const speaker = createSyntheticSpeakerOperationsRepository({ db, clock: () => STAGE3_AT });
      const taskRows = db.prepare(
        `SELECT aggregate_id AS id,
                json_extract(payload_json, '$.task.contentKind') AS contentKind
           FROM domain_events
          WHERE workspace_id = ? AND aggregate_type = 'speaker_task'
            AND event_type = 'speaker.task.created'
            AND json_extract(payload_json, '$.eventId') = ?
            AND json_extract(payload_json, '$.task.personId') = ?
            AND json_extract(payload_json, '$.task.contentKind') IN ('SESSION_TITLE', 'SESSION_DESCRIPTION')
          ORDER BY contentKind, id`,
      ).all(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_SPEAKER_PERSON_ID) as Array<{ id: string; contentKind: string }>;
      const titleTask = taskRows.find((task) => task.contentKind === "SESSION_TITLE");
      const abstractTask = taskRows.find((task) => task.contentKind === "SESSION_DESCRIPTION");
      expect(titleTask).toBeDefined();
      expect(abstractTask).toBeDefined();
      const titleV1 = speaker.submitOrganizerContent(evaluatorOrganizerScope, {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: titleTask!.id,
        payload: { kind: "SESSION_TITLE", title: "Approved Stage 3 title v1" },
        idempotencyKey: "stage3-title-v1",
      });
      const abstractV1 = speaker.submitOrganizerContent(evaluatorOrganizerScope, {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: abstractTask!.id,
        payload: { kind: "SESSION_DESCRIPTION", description: "Approved Stage 3 abstract v1" },
        idempotencyKey: "stage3-abstract-v1",
      });
      const releaseStateBeforeBlockedSeal = {
        count: (dbValue(
          db,
          "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
          EVALUATOR_WORKSPACE_ID,
          EVALUATOR_EVENT_ID,
        ).count as number),
        currentReleaseId: dbValue(
          db,
          "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
          EVALUATOR_WORKSPACE_ID,
          EVALUATOR_EVENT_ID,
        ).currentReleaseId as string | null,
      };
      expect(() => sealRelease(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, { kind: "account", ref: EVALUATOR_ORGANIZER_ACCOUNT_ID }))
        .toThrow("SESSION_CONTENT_NOT_APPROVED");
      expect({
        count: dbValue(
          db,
          "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
          EVALUATOR_WORKSPACE_ID,
          EVALUATOR_EVENT_ID,
        ).count,
        currentReleaseId: dbValue(
          db,
          "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
          EVALUATOR_WORKSPACE_ID,
          EVALUATOR_EVENT_ID,
        ).currentReleaseId,
      }).toEqual(releaseStateBeforeBlockedSeal);

      speaker.approveContent(evaluatorOrganizerScope, {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: titleTask!.id,
        submissionVersionId: titleV1.id,
        submissionContentHash: titleV1.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "stage3-title-v1-approval",
      });
      speaker.approveContent(evaluatorOrganizerScope, {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: abstractTask!.id,
        submissionVersionId: abstractV1.id,
        submissionContentHash: abstractV1.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "stage3-abstract-v1-approval",
      });
      const firstRelease = sealRelease(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, { kind: "account", ref: EVALUATOR_ORGANIZER_ACCOUNT_ID });
      const firstContent = JSON.parse((db.prepare(
        "SELECT content_json AS content FROM publication_releases WHERE id = ?",
      ).get(firstRelease.releaseId) as { content: string }).content) as {
        lineage: { releaseNumber: number; supersedesReleaseId: string | null };
        schedule: { sessions: Array<{ title: string; abstract: string; titleVersionId: string | null; abstractVersionId: string | null }> };
      };
      expect(firstContent.lineage.releaseNumber).toBeGreaterThan(1);
      expect(firstContent.lineage.supersedesReleaseId).not.toBeNull();
      expect(firstContent.schedule.sessions[0]).toMatchObject({
        title: "Approved Stage 3 title v1",
        abstract: "Approved Stage 3 abstract v1",
        titleVersionId: titleV1.id,
        abstractVersionId: abstractV1.id,
      });

      const titleV2 = speaker.submitOrganizerContent(evaluatorOrganizerScope, {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: titleTask!.id,
        payload: { kind: "SESSION_TITLE", title: "Approved Stage 3 title v2" },
        idempotencyKey: "stage3-title-v2",
      });
      const abstractV2 = speaker.submitOrganizerContent(evaluatorOrganizerScope, {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: abstractTask!.id,
        payload: { kind: "SESSION_DESCRIPTION", description: "Approved Stage 3 abstract v2" },
        idempotencyKey: "stage3-abstract-v2",
      });
      const releaseStateBeforeStaleReplacement = {
        count: dbValue(
          db,
          "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
          EVALUATOR_WORKSPACE_ID,
          EVALUATOR_EVENT_ID,
        ).count,
        currentReleaseId: dbValue(
          db,
          "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
          EVALUATOR_WORKSPACE_ID,
          EVALUATOR_EVENT_ID,
        ).currentReleaseId,
      };
      expect(() => sealRelease(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, { kind: "account", ref: EVALUATOR_ORGANIZER_ACCOUNT_ID }))
        .toThrow("SESSION_CONTENT_NOT_APPROVED");
      expect({
        count: dbValue(
          db,
          "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
          EVALUATOR_WORKSPACE_ID,
          EVALUATOR_EVENT_ID,
        ).count,
        currentReleaseId: dbValue(
          db,
          "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
          EVALUATOR_WORKSPACE_ID,
          EVALUATOR_EVENT_ID,
        ).currentReleaseId,
      }).toEqual(releaseStateBeforeStaleReplacement);
      speaker.approveContent(evaluatorOrganizerScope, {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: titleTask!.id,
        submissionVersionId: titleV2.id,
        submissionContentHash: titleV2.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "stage3-title-v2-approval",
      });
      speaker.approveContent(evaluatorOrganizerScope, {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: abstractTask!.id,
        submissionVersionId: abstractV2.id,
        submissionContentHash: abstractV2.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "stage3-abstract-v2-approval",
      });
      const secondRelease = sealRelease(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, { kind: "account", ref: EVALUATOR_ORGANIZER_ACCOUNT_ID });
      const secondContent = JSON.parse((db.prepare(
        "SELECT content_json AS content FROM publication_releases WHERE id = ?",
      ).get(secondRelease.releaseId) as { content: string }).content) as {
        lineage: { releaseNumber: number; supersedesReleaseId: string | null };
        schedule: { sessions: Array<{ title: string; abstract: string; titleVersionId: string | null; titleContentHash: string | null; abstractVersionId: string | null; abstractContentHash: string | null }> };
      };
      expect(secondContent.lineage).toEqual({
        releaseNumber: firstContent.lineage.releaseNumber + 1,
        supersedesReleaseId: firstRelease.releaseId,
      });
      expect(secondContent.schedule.sessions[0]).toMatchObject({
        title: "Approved Stage 3 title v2",
        abstract: "Approved Stage 3 abstract v2",
        titleVersionId: titleV2.id,
        titleContentHash: titleV2.contentHash,
        abstractVersionId: abstractV2.id,
        abstractContentHash: abstractV2.contentHash,
      });
      expect(validatePublicReleaseForRead(db, {
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: EVALUATOR_EVENT_ID,
        releaseId: firstRelease.releaseId,
        mode: "HISTORICAL",
      })?.releaseId).toBe(firstRelease.releaseId);
      expect(sealRelease(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, {
        kind: "account",
        ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      })).toMatchObject({
        releaseId: secondRelease.releaseId,
        created: false,
      });

      db.prepare("UPDATE program_units SET name = ? WHERE workspace_id = ? AND id = ?")
        .run("Mutable source name after release", EVALUATOR_WORKSPACE_ID, EVALUATOR_PROGRAM_UNIT_ID);
      db.prepare("UPDATE event_rooms SET name = ? WHERE workspace_id = ? AND event_id = ? AND id = ?")
        .run("Mutable room after release", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, roomId);
      db.prepare("UPDATE event_tracks SET name = ? WHERE workspace_id = ? AND event_id = ? AND id = ?")
        .run("Mutable track after release", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, trackId);
      const channelReference = publicReleaseReference({
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: EVALUATOR_EVENT_ID,
        releaseId: secondRelease.releaseId,
      });
      const durable = resolveCurrentDurablePublicAgenda(db, channelReference);
      expect(durable?.sessions[0]).toMatchObject({
        title: "Approved Stage 3 title v2",
        abstract: "Approved Stage 3 abstract v2",
        roomName: "Main room",
        trackName: "Main program",
      });
      expect(JSON.stringify(durable)).not.toContain(EVALUATOR_EVENT_ID);
      expect(JSON.stringify(durable)).not.toContain(EVALUATOR_PROGRAM_UNIT_ID);
      expect(JSON.stringify(durable)).not.toContain(EVALUATOR_SPEAKER_PERSON_ID);
      expect(JSON.stringify(durable)).not.toContain(secondRelease.releaseId);
      expect(JSON.stringify(durable)).not.toContain(secondRelease.fingerprint);
      const published = resolveCurrentPublicAgendaReleaseByChannel(db, channelReference);
      expect(published?.release).toMatchObject({
        channelReference,
        current: true,
        fingerprint: secondRelease.fingerprint,
      });
      if (!published) throw new Error("current public widget projection unavailable");
      const widget = toPublicWidgetProjection(published);
      expect(widget.release).toMatchObject({
        channelReference,
        releaseReference: channelReference,
      });
      expect(widget?.sessions[0]).toMatchObject({
        title: "Approved Stage 3 title v2",
        description: "Approved Stage 3 abstract v2",
        room: "Main room",
        track: "Main program",
      });
      expect(JSON.stringify(widget)).not.toContain(secondRelease.releaseId);
      expect(JSON.stringify(widget)).not.toContain(secondRelease.fingerprint);
      expect(resolveCurrentPublicAgendaReleaseByChannel(db, EVALUATOR_EVENT_ID)).toBeNull();
      expect(resolveCurrentPublicAgendaReleaseByChannel(db, secondRelease.fingerprint)).toBeNull();
    } finally {
      closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
