import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertWorkspaceMatch,
  createSession,
  DenialError,
  hasCapability,
  requireCapability,
  roleHasCapability,
} from "../../src/server/auth";
import { deterministicUuid, fingerprintOf, nowIso, sha256Hex, uuid } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  compileRoundtables,
  validateCompilerOutput,
  type CompilerInput,
} from "../../src/server/adapters/compiler";
import { SimulatedDeliveryAdapter } from "../../src/server/adapters/delivery-adapter";
import { SimulatedFixtureSourceAdapter, type ImportedEvidence } from "../../src/server/adapters/source-adapter";
import { freezeCohortSnapshot } from "../../src/server/services/cohorts";
import {
  commitmentResponseCommandKey,
  deliverOffers,
  listOffers,
  nextPendingOffer,
  respondToOfferCommand,
  simulateCommitmentResponse,
} from "../../src/server/services/commitments";
import { createEventWithUnit } from "../../src/server/services/events";
import { recordAttendance } from "../../src/server/services/outcomes";
import { approvePlan, compilePlan, planState } from "../../src/server/services/planning";
import {
  parseSealedReleaseContent,
  type SealedReleaseContent,
  latestRelease,
  resolvePortalAccess,
  revokePortalToken,
  sealRelease,
} from "../../src/server/services/publication";
import {
  resolveCurrentPublicAgendaRelease,
  resolveExactPublicAgendaRelease,
  resolveSavedPublicAgendaRelease,
} from "../../src/server/services/public-widgets/binding";
import {
  getDashboardState,
  getPersonDetail,
  getWorkspaceBySlug,
  listLoginChoices,
  listPeople,
} from "../../src/server/services/queries";
import { importFixtureEvidence } from "../../src/server/services/sources";
import { latestPlanVersion } from "../../src/server/services/planning";
import { executeScheduleDraftCommand, readScheduleDraft } from "../../src/server/services/scheduling/persistence";
import { createSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";
import { fixtureForWorkspace } from "../../src/server/seed";
import { DDL, SCHEMA_VERSION } from "../../src/server/schema";
import { createLegacyDatabase, insertWorkspaceMarker } from "./fixtures/legacy-schema-v1-v2";
import { persistAndApproveCurrentSchedule } from "../helpers/schedule-approval";

function removeSqliteFiles(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(target, { force: true });
  }
}

function workspace(db: Db, slug: string): { id: string; slug: string; name: string } {
  const row = getWorkspaceBySlug(db, slug);
  if (!row) {
    throw new Error(`missing seeded workspace ${slug}`);
  }
  return row;
}

function organizer(db: Db, workspaceId: string): { id: string } {
  const row = db
    .prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY created_at LIMIT 1")
    .get(workspaceId) as { id: string } | undefined;
  if (!row) {
    throw new Error(`missing seeded organizer for ${workspaceId}`);
  }
  return row;
}

function runThroughApproval(db: Db) {
  const northstar = workspace(db, "northstar");
  const account = organizer(db, northstar.id);
  const actor = { kind: "account" as const, ref: account.id };

  const imported = importFixtureEvidence(db, northstar.id, northstar.slug);
  const snapshot = freezeCohortSnapshot(db, northstar.id, actor);
  const event = createEventWithUnit(db, northstar.id, actor, {
    eventName: "Sympose Phase 0 Roundtable",
    unitName: "Morning circle",
    capacity: 6,
  });
  const plan = compilePlan(db, northstar.id, event.eventId, actor);
  const approval = approvePlan(db, northstar.id, event.eventId, plan.planVersionId, null, actor);

  return { northstar, account, actor, imported, snapshot, event, plan, approval };
}

function prepareReleaseAuthority(
  db: Db,
  workspaceId: string,
  eventId: string,
  actor: { readonly kind: "account"; readonly ref: string },
): void {
  const accepted = db.prepare(
    `SELECT assignment.id AS assignmentId,
            assignment.person_id AS personId,
            unit.id AS programUnitId,
            unit.name AS programUnitName,
            unit.ends_at AS dueAt,
            CASE assignment.assignment_type
              WHEN 'SPEAKER' THEN 'SPEAKER'
              WHEN 'participant' THEN 'SPEAKER'
              WHEN 'MODERATOR' THEN 'MODERATOR'
              WHEN 'moderator' THEN 'MODERATOR'
            END AS roleKey
       FROM events event_row
       JOIN plan_assignments assignment
         ON assignment.workspace_id = event_row.workspace_id
        AND assignment.plan_version_id = event_row.current_plan_version_id
       JOIN program_units unit
         ON unit.workspace_id = assignment.workspace_id
        AND unit.event_id = event_row.id
        AND unit.id = assignment.program_unit_id
       JOIN commitment_offers offer
         ON offer.workspace_id = assignment.workspace_id
        AND offer.event_id = event_row.id
        AND offer.plan_version_id = assignment.plan_version_id
        AND offer.person_id = assignment.person_id
       JOIN commitment_responses response
         ON response.workspace_id = offer.workspace_id
        AND response.offer_id = offer.id
        AND response.actor_person_id = offer.person_id
        AND response.response = 'accepted'
      WHERE event_row.workspace_id = ? AND event_row.id = ?
      GROUP BY assignment.id
      HAVING COUNT(DISTINCT offer.id) = 1 AND COUNT(DISTINCT response.id) = 1
      ORDER BY assignment.id`,
  ).all(workspaceId, eventId) as unknown as Array<{
    assignmentId: string;
    personId: string;
    programUnitId: string;
    programUnitName: string;
    dueAt: string;
    roleKey: "SPEAKER" | "MODERATOR";
  }>;
  if (accepted.length === 0) throw new Error("expected accepted release authority");
  for (const row of accepted) {
    db.prepare(
      `INSERT OR IGNORE INTO event_speakers
         (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?)`,
    ).run(
      deterministicUuid(`mvp-release-speaker:${workspaceId}:${eventId}:${row.assignmentId}`),
      workspaceId,
      eventId,
      row.personId,
      row.roleKey,
      "2026-06-02T10:00:00.000Z",
      "2026-06-02T10:00:00.000Z",
    );
  }

  const speaker = createSyntheticSpeakerOperationsRepository({
    db,
    clock: () => "2026-06-02T10:00:00.000Z",
  });
  const organizerScope = {
    kind: "organizer" as const,
    workspaceId,
    eventId,
    actorId: actor.ref,
  };
  for (const row of accepted) {
    const key = `${row.assignmentId}:${row.personId}`;
    const titleTask = speaker.createTask(organizerScope, {
      personId: row.personId,
      kind: "SESSION_TITLE",
      contentKind: "SESSION_TITLE",
      title: "Session title",
      description: "Exact audience-facing session title.",
      required: true,
      gate: "PUBLICATION",
      dueAt: row.dueAt,
      owner: "SPEAKER",
      idempotencyKey: `mvp-release-title-task:${key}`,
    });
    const descriptionTask = speaker.createTask(organizerScope, {
      personId: row.personId,
      kind: "SESSION_DESCRIPTION",
      contentKind: "SESSION_DESCRIPTION",
      title: "Session description",
      description: "Exact audience-facing session description.",
      required: true,
      gate: "PUBLICATION",
      dueAt: row.dueAt,
      owner: "SPEAKER",
      idempotencyKey: `mvp-release-description-task:${key}`,
    });
    const title = speaker.submitOrganizerContent(organizerScope, {
      personId: row.personId,
      taskId: titleTask.id,
      payload: { kind: "SESSION_TITLE", title: row.programUnitName },
      idempotencyKey: `mvp-release-title-version:${key}`,
    });
    const description = speaker.submitOrganizerContent(organizerScope, {
      personId: row.personId,
      taskId: descriptionTask.id,
      payload: { kind: "SESSION_DESCRIPTION", description: `Program details for ${row.programUnitName}.` },
      idempotencyKey: `mvp-release-description-version:${key}`,
    });
    speaker.approveContent(organizerScope, {
      personId: row.personId,
      taskId: titleTask.id,
      submissionVersionId: title.id,
      submissionContentHash: title.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: `mvp-release-title-approval:${key}`,
    });
    speaker.approveContent(organizerScope, {
      personId: row.personId,
      taskId: descriptionTask.id,
      submissionVersionId: description.id,
      submissionContentHash: description.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: `mvp-release-description-approval:${key}`,
    });
  }

  const initial = readScheduleDraft(db, { workspaceId, eventId });
  const context = {
    planVersionId: initial.schedule.planVersionId,
    planFingerprint: initial.schedule.planFingerprint,
    acceptedInventoryFingerprint: initial.schedule.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: initial.schedule.cfpSessionInventoryFingerprint,
  };
  const resources = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM event_rooms WHERE workspace_id = ? AND event_id = ?) AS roomCount,
       (SELECT COUNT(*) FROM event_tracks WHERE workspace_id = ? AND event_id = ?) AS trackCount`,
  ).get(workspaceId, eventId, workspaceId, eventId) as { roomCount: number; trackCount: number };
  if (resources.roomCount === 0 || resources.trackCount === 0) {
    executeScheduleDraftCommand(db, { workspaceId, eventId }, {
      expectedRevision: initial.schedule.revision,
      ...context,
      command: {
        kind: "CONFIGURE",
        rooms: [{ ...initial.schedule.rooms[0]!, name: "Main room", venue: "Event venue", capacity: 100 }],
        tracks: [{ ...initial.schedule.tracks[0]!, name: "Main program", ordinal: 1 }],
      },
      idempotencyKey: `mvp-release-configure:${context.planVersionId}:${context.acceptedInventoryFingerprint}`,
      requestId: `mvp-release-configure-request:${context.planVersionId}:${context.acceptedInventoryFingerprint}`,
      actorAccountId: actor.ref,
    });
  }
  const configured = readScheduleDraft(db, { workspaceId, eventId });
  executeScheduleDraftCommand(db, { workspaceId, eventId }, {
    expectedRevision: configured.schedule.revision,
    planVersionId: configured.schedule.planVersionId,
    planFingerprint: configured.schedule.planFingerprint,
    acceptedInventoryFingerprint: configured.schedule.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: configured.schedule.cfpSessionInventoryFingerprint,
    command: { kind: "AUTO_PLACE" },
    idempotencyKey: `mvp-release-place:${configured.schedule.planVersionId}:${configured.schedule.acceptedInventoryFingerprint}`,
    requestId: `mvp-release-place-request:${configured.schedule.planVersionId}:${configured.schedule.acceptedInventoryFingerprint}`,
    actorAccountId: actor.ref,
  });
  persistAndApproveCurrentSchedule(
    db,
    { workspaceId, eventId },
    actor.ref,
    `mvp-release-schedule-${configured.schedule.planVersionId}-${configured.schedule.acceptedInventoryFingerprint}`,
  );
}

function sealPreparedRelease(
  db: Db,
  workspaceId: string,
  eventId: string,
  actor: { readonly kind: "account"; readonly ref: string },
) {
  prepareReleaseAuthority(db, workspaceId, eventId, actor);
  return sealRelease(db, workspaceId, eventId, actor);
}

/**
 * Full truth surface an approval must never touch when it fails closed: the event pointer,
 * decision truth, plan lifecycle, audit (including simulated delivery receipts), commitment
 * offers and responses, and sealed publication releases.
 */
function pointerTruthSnapshot(db: Db, workspaceId: string, eventId: string) {
  return {
    pointer: db
      .prepare(
        "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
      )
      .get(workspaceId, eventId),
    approvals: db
      .prepare(
        `SELECT id, event_id AS eventId, plan_version_id AS planVersionId, decision, created_at AS createdAt
         FROM approvals WHERE workspace_id = ? ORDER BY id`,
      )
      .all(workspaceId),
    planStates: db
      .prepare(
        `SELECT id, plan_version_id AS planVersionId, state, created_at AS createdAt
         FROM plan_states WHERE workspace_id = ? ORDER BY id`,
      )
      .all(workspaceId),
    auditEvents: db
      .prepare(
        `SELECT id, action, target_type AS targetType, target_id AS targetId, details_json AS detailsJson
         FROM audit_events WHERE workspace_id = ? ORDER BY id`,
      )
      .all(workspaceId),
    deliveryReceipts: db
      .prepare(
        `SELECT id, target_id AS targetId, details_json AS detailsJson
         FROM audit_events WHERE workspace_id = ? AND action = 'commitment.offer.delivered' ORDER BY id`,
      )
      .all(workspaceId),
    offers: db
      .prepare(
        `SELECT id, event_id AS eventId, plan_version_id AS planVersionId, person_id AS personId,
                terms_fingerprint AS termsFingerprint, status
         FROM commitment_offers WHERE workspace_id = ? ORDER BY id`,
      )
      .all(workspaceId),
    responses: db
      .prepare(
        `SELECT id, offer_id AS offerId, response, responded_at AS respondedAt
         FROM commitment_responses WHERE workspace_id = ? ORDER BY id`,
      )
      .all(workspaceId),
    releases: db
      .prepare(
        `SELECT id, event_id AS eventId, plan_version_id AS planVersionId, fingerprint, sealed_at AS sealedAt
         FROM publication_releases WHERE workspace_id = ? ORDER BY id`,
      )
      .all(workspaceId),
  };
}

/**
 * Corrupt state can only be constructed with the schema guard dropped. The guard is restored
 * from the canonical DDL before any production code runs, so every rejection below comes from
 * the approval mutation boundary rather than from a SQL trigger.
 */
function forceCurrentPlanPointer(
  db: Db,
  workspaceId: string,
  eventId: string,
  pointer: string | null,
): void {
  db.exec("DROP TRIGGER IF EXISTS trg_events_pointer_guard");
  try {
    db.prepare("UPDATE events SET current_plan_version_id = ? WHERE workspace_id = ? AND id = ?").run(
      pointer,
      workspaceId,
      eventId,
    );
  } finally {
    db.exec(DDL);
  }
  const guard = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_events_pointer_guard'")
    .get() as { name: string } | undefined;
  if (!guard) {
    throw new Error("expected trg_events_pointer_guard to be restored before production code runs");
  }
  const persisted = db
    .prepare(
      "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
    )
    .get(workspaceId, eventId) as { currentPlanVersionId: string | null } | undefined;
  if (!persisted || persisted.currentPlanVersionId !== pointer) {
    throw new Error("expected the corrupt pointer to persist");
  }
}

/**
 * Approvals are immutable at the database boundary, so a noncanonical decision can only be
 * written with that guard dropped. The guard is restored from the canonical DDL before any
 * production code runs, and the schema unique key on (workspace_id, event_id, plan_version_id)
 * means exactly one row can ever match, so this rewrites decision truth for the one persisted
 * approval and nothing else.
 */
function forceApprovalDecision(
  db: Db,
  workspaceId: string,
  eventId: string,
  planVersionId: string,
  decision: string,
): void {
  db.exec("DROP TRIGGER IF EXISTS trg_approvals_immutable");
  try {
    const updated = db
      .prepare(
        `UPDATE approvals SET decision = ?
         WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?`,
      )
      .run(decision, workspaceId, eventId, planVersionId);
    if (updated.changes !== 1) {
      throw new Error(`expected exactly one approval row to rewrite, changed ${updated.changes}`);
    }
  } finally {
    db.exec(DDL);
  }
  const guard = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_approvals_immutable'")
    .get() as { name: string } | undefined;
  if (!guard) {
    throw new Error("expected trg_approvals_immutable to be restored before production code runs");
  }
  const persisted = db
    .prepare(
      `SELECT decision FROM approvals
       WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?`,
    )
    .all(workspaceId, eventId, planVersionId) as { decision: string }[];
  if (persisted.length !== 1 || persisted[0]?.decision !== decision) {
    throw new Error("expected exactly one persisted approval carrying the rewritten decision");
  }
}

/** A second event whose own plan is genuinely approved, used only as a foreign pointer target. */
function seedApprovedPlanForOtherEvent(
  db: Db,
  workspaceId: string,
  actorAccountId: string,
  label: string,
): { eventId: string; planVersionId: string } {
  const createdAt = "2026-06-02T09:00:00.000Z";
  const eventId = uuid();
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle,
                         current_plan_version_id, current_release_id, created_at)
     VALUES (?, ?, ?, 'Europe/Berlin', '2026-10-01T09:00:00.000Z', '2026-10-01T13:00:00.000Z',
             'planning', NULL, NULL, ?)`,
  ).run(eventId, workspaceId, `${label} event`, createdAt);
  const runId = uuid();
  db.prepare(
    `INSERT INTO plan_runs (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json,
                            compiler, compiler_version, created_at)
     VALUES (?, ?, ?, 'FEASIBLE', ?, '{}', 'fixture-backed-simulated-compiler', 'simulated-1', ?)`,
  ).run(runId, workspaceId, eventId, `${label}-input-fingerprint`, createdAt);
  const planVersionId = uuid();
  db.prepare(
    `INSERT INTO plan_versions (id, workspace_id, event_id, run_id, version_number, fingerprint,
                                content_json, created_at)
     VALUES (?, ?, ?, ?, 1, ?, '{"assignments":[]}', ?)`,
  ).run(planVersionId, workspaceId, eventId, runId, `${label}-plan-fingerprint`, createdAt);
  db.prepare(
    `INSERT INTO approvals (id, workspace_id, event_id, plan_version_id, actor_account_id, decision, created_at)
     VALUES (?, ?, ?, ?, ?, 'approved', ?)`,
  ).run(uuid(), workspaceId, eventId, planVersionId, actorAccountId, createdAt);
  db.prepare(
    `INSERT INTO plan_states (id, workspace_id, plan_version_id, state, actor_account_id, reason, created_at)
     VALUES (?, ?, ?, 'approved', ?, NULL, ?)`,
  ).run(uuid(), workspaceId, planVersionId, actorAccountId, createdAt);
  db.prepare("UPDATE events SET current_plan_version_id = ? WHERE id = ? AND workspace_id = ?").run(
    planVersionId,
    eventId,
    workspaceId,
  );
  return { eventId, planVersionId };
}

/** v1 approved with live offers, one response, and a sealed release, plus an unapproved v2. */
function approvedFlowWithNextCandidate(db: Db) {
  const flow = runThroughApproval(db);
  deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
  const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
  if (!offer) throw new Error("expected a pending offer");
  respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
    offerId: offer.id,
    response: "accepted",
    commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
  });
  sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
  return { ...flow, candidate: nextCandidate(db, flow, "Afternoon circle") };
}

function nextCandidate(
  db: Db,
  flow: ReturnType<typeof runThroughApproval>,
  unitName: string,
): { planVersionId: string } {
  createEventWithUnit(db, flow.northstar.id, flow.actor, {
    eventName: "Sympose Phase 0 Roundtable",
    unitName,
    capacity: 6,
  });
  return compilePlan(db, flow.northstar.id, flow.event.eventId, flow.actor);
}

describe("Sympose Phase 0 domain contracts", () => {
  it("runs the complete tracer without collapsing candidate, decision, commitment, publication, or operational facts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:30:00.000Z"));
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const account = organizer(db, northstar.id);
      const actor = { kind: "account" as const, ref: account.id };

      const firstImport = importFixtureEvidence(db, northstar.id, northstar.slug);
      expect(firstImport.imported).toHaveLength(12);
      expect(firstImport.personsCreated).toBe(12);

      const secondImport = importFixtureEvidence(db, northstar.id, northstar.slug);
      expect(secondImport).toEqual(firstImport);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'source.import'",
          )
          .get(northstar.id),
      ).toEqual({ n: 1 });
      expect(listPeople(db, northstar.id)).toHaveLength(12);

      const noEvidencePersonId = uuid();
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, organization, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        noEvidencePersonId,
        northstar.id,
        "no-evidence@northstar.example",
        "No Evidence",
        "Synthetic",
        "Excluded",
        "2026-06-01T10:00:00.000Z",
      );

      const snapshot = freezeCohortSnapshot(db, northstar.id, actor);
      expect(snapshot.memberCount).toBe(12);
      const snapshotDashboard = getDashboardState(db, northstar.id, []);
      expect(snapshotDashboard.snapshotPersonIds).toHaveLength(12);
      expect(snapshotDashboard.snapshotPersonIds).not.toContain(noEvidencePersonId);
      const repeatedSnapshot = freezeCohortSnapshot(db, northstar.id, actor);
      expect(repeatedSnapshot.created).toBe(false);
      expect(repeatedSnapshot.snapshotId).toBe(snapshot.snapshotId);
      expect(repeatedSnapshot.definition.id).toBe(snapshot.definition.id);

      const event = createEventWithUnit(db, northstar.id, actor, {
        eventName: "Sympose Phase 0 Roundtable",
        unitName: "Morning circle",
        capacity: 6,
      });
      const plan = compilePlan(db, northstar.id, event.eventId, actor);
      expect(plan.status).toBe("FEASIBLE");
      expect(plan.assignmentCount).toBe(6);
      expect(getDashboardState(db, northstar.id, [])).toMatchObject({
        currentPlan: null,
        candidatePlan: { id: plan.planVersionId, status: "candidate" },
      });

      const beforeApproval = db
        .prepare("SELECT fingerprint, content_json AS content FROM plan_versions WHERE id = ?")
        .get(plan.planVersionId) as { fingerprint: string; content: string };
      const approval = approvePlan(db, northstar.id, event.eventId, plan.planVersionId, null, actor);
      expect(approval.created).toBe(true);
      expect(getDashboardState(db, northstar.id, [])).toMatchObject({
        currentPlan: { id: plan.planVersionId, status: "approved" },
        candidatePlan: null,
      });
      const approvalFactsBeforeReplay = {
        approvals: (db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n,
        planStates: (db.prepare("SELECT COUNT(*) AS n FROM plan_states").get() as { n: number }).n,
        audits: (db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n,
        pointer: db
          .prepare("SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE id = ?")
          .get(event.eventId),
      };
      expect(() => approvePlan(db, northstar.id, event.eventId, plan.planVersionId, null, actor)).toThrow(
        /PLAN_POINTER_EXPECTATION_FAILED/,
      );
      expect(() =>
        approvePlan(db, northstar.id, event.eventId, plan.planVersionId, plan.planVersionId, actor),
      ).toThrow(/PLAN_CANDIDATE_STATUS_INVALID/);
      expect({
        approvals: (db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n,
        planStates: (db.prepare("SELECT COUNT(*) AS n FROM plan_states").get() as { n: number }).n,
        audits: (db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n,
        pointer: db
          .prepare("SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE id = ?")
          .get(event.eventId),
      }).toEqual(approvalFactsBeforeReplay);
      expect(
        db.prepare("SELECT fingerprint, content_json AS content FROM plan_versions WHERE id = ?").get(plan.planVersionId),
      ).toEqual(beforeApproval);

      const delivery = deliverOffers(db, northstar.id, event.eventId, actor);
      expect(delivery.offersCreated).toBe(6);
      const offer = nextPendingOffer(db, northstar.id, event.eventId);
      expect(offer).not.toBeNull();
      if (!offer) throw new Error("expected pending offer");

      expect(fingerprintOf(JSON.parse(offer.termsJson))).toBe(offer.termsFingerprint);
      const differentPerson = listPeople(db, northstar.id).find((person) => person.id !== offer.personId);
      if (!differentPerson) throw new Error("expected another fixture person");
      expect(() =>
        simulateCommitmentResponse(db, northstar.id, offer.id, "accepted", {
          kind: "person",
          ref: differentPerson.id,
        }),
      ).toThrow(/OFFER_ACTOR_MISMATCH/);

      const acceptCommand = {
        offerId: offer.id,
        response: "accepted" as const,
        commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
      };
      const accepted = respondToOfferCommand(
        db,
        northstar.id,
        event.eventId,
        acceptCommand,
      );
      expect(accepted.created).toBe(true);
      expect(
        respondToOfferCommand(db, northstar.id, event.eventId, acceptCommand),
      ).toMatchObject({ created: false, offerId: offer.id, response: "accepted" });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM commitment_responses WHERE workspace_id = ?").get(northstar.id),
      ).toEqual({ n: 1 });
      expect(nextPendingOffer(db, northstar.id, event.eventId)?.id).not.toBe(offer.id);
      expect(() =>
        respondToOfferCommand(db, northstar.id, event.eventId, {
          ...acceptCommand,
          commandKey: "0".repeat(64),
        }),
      ).toThrow(/COMMITMENT_COMMAND_KEY_MISMATCH/);

       expect(() =>
         respondToOfferCommand(db, northstar.id, event.eventId, {
           offerId: offer.id,
           response: "declined",
           commandKey: commitmentResponseCommandKey(offer.id, "declined"),
         }),
       ).toThrow(/COMMITMENT_RESPONSE_CONFLICT/);
       expect(
         db
           .prepare(
             "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'security.access.denied'",
           )
           .get(northstar.id),
       ).toEqual({ n: 1 });

      const declinedOffer = nextPendingOffer(db, northstar.id, event.eventId);
      expect(declinedOffer).not.toBeNull();
      if (!declinedOffer) throw new Error("expected another pending offer");
      const declineCommand = {
        offerId: declinedOffer.id,
        response: "declined" as const,
        commandKey: commitmentResponseCommandKey(declinedOffer.id, "declined"),
      };
      expect(
        respondToOfferCommand(db, northstar.id, event.eventId, declineCommand),
      ).toMatchObject({ created: true, offerId: declinedOffer.id, response: "declined" });
      expect(
        respondToOfferCommand(db, northstar.id, event.eventId, declineCommand),
      ).toMatchObject({ created: false, offerId: declinedOffer.id, response: "declined" });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM commitment_responses WHERE workspace_id = ?").get(northstar.id),
      ).toEqual({ n: 2 });
      expect(
        db.prepare("SELECT fingerprint, content_json AS content FROM plan_versions WHERE id = ?").get(plan.planVersionId),
      ).toEqual(beforeApproval);

      const release = sealPreparedRelease(db, northstar.id, event.eventId, actor);
      expect(release.created).toBe(true);
      expect(release.agendaCount).toBe(1);
      expect(release.tokens).toHaveLength(1);
      const rawToken = release.tokens[0].rawToken;
      const storedToken = db
        .prepare(
          `SELECT id, token_hash AS tokenHash, release_id AS releaseId
           FROM portal_tokens WHERE workspace_id = ?`,
        )
        .get(northstar.id) as { id: string; tokenHash: string; releaseId: string };
      expect(storedToken.tokenHash).toBe(sha256Hex(rawToken));
      expect(storedToken.tokenHash).not.toContain(rawToken);
      expect(JSON.stringify(db.prepare("SELECT * FROM portal_tokens").all())).not.toContain(rawToken);

      const portal = resolvePortalAccess(db, rawToken);
      expect(portal.personId).toBe(offer.personId);
      expect(portal.releaseFingerprint).toBe(release.fingerprint);
      expect(portal.agenda.items).toHaveLength(1);
      const sealedIdentity = { personName: portal.personName, email: portal.email };
      const sealedContent = JSON.parse(
        (db
          .prepare("SELECT content_json AS content FROM publication_releases WHERE id = ?")
          .get(release.releaseId) as { content: string }).content,
      ) as { schema: string; agendas: { personName: string; email: string }[] };
      expect(sealedContent).toMatchObject({
        schema: "publication-release/v2",
        agendas: [sealedIdentity],
      });

      db.prepare(
        `UPDATE people SET full_name = ?, canonical_email = ?
         WHERE workspace_id = ? AND id = ?`,
      ).run("Mutable Current Name", "mutable-current@northstar.example", northstar.id, offer.personId);
      expect(resolvePortalAccess(db, rawToken)).toMatchObject({
        ...sealedIdentity,
        releaseFingerprint: release.fingerprint,
      });

      const wrongScopeToken = "A".repeat(43);
      db.prepare(
        `INSERT INTO portal_tokens
           (id, workspace_id, release_id, person_id, token_hash, scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'support', ?, ?)`,
      ).run(
        uuid(),
        northstar.id,
        release.releaseId,
        offer.personId,
        sha256Hex(wrongScopeToken),
        "2026-06-01T00:00:00.000Z",
        "2099-06-01T00:00:00.000Z",
      );
      expect(() => resolvePortalAccess(db, wrongScopeToken)).toThrowError(
        expect.objectContaining({ code: "TOKEN_SCOPE_DENIED" }),
      );
      expect(() => resolvePortalAccess(db, "not-a-valid-token")).toThrowError(
        expect.objectContaining({ code: "TOKEN_INVALID" }),
      );

      const sealedBeforeRevocation = db
        .prepare("SELECT fingerprint, content_json AS content FROM publication_releases WHERE id = ?")
        .get(release.releaseId);
      expect(revokePortalToken(db, northstar.id, storedToken.id, actor, "Test revocation")).toBe(true);
      expect(() => resolvePortalAccess(db, rawToken)).toThrowError(DenialError);
      try {
        resolvePortalAccess(db, rawToken);
      } catch (error) {
        expect(error).toMatchObject({ code: "TOKEN_REVOKED" });
      }
      expect(revokePortalToken(db, northstar.id, storedToken.id, actor, "Changed reason")).toBe(false);
      expect(
        db.prepare("SELECT fingerprint, content_json AS content FROM publication_releases WHERE id = ?").get(release.releaseId),
      ).toEqual(sealedBeforeRevocation);

      db.prepare("UPDATE events SET lifecycle = 'live' WHERE workspace_id = ? AND id = ?")
        .run(northstar.id, event.eventId);
      const attendanceObservedAt = "2026-09-15T10:00:00.000Z";
      const attendanceProgramUnitId = JSON.parse(offer.termsJson).programUnitId as string;
      const attendanceCommandKey = `attendance:${event.eventId}:${offer.personId}:${attendanceProgramUnitId}`;
      const persistedAttendanceKey = `attendance-observation:v1:${fingerprintOf({
        schema: "attendance-observation-key/v1",
        workspaceId: northstar.id,
        eventId: event.eventId,
        personId: offer.personId,
        programUnitId: attendanceProgramUnitId,
        observedMeaning: "ATTENDED",
      })}`;
      const observation = recordAttendance(
        db,
        northstar.id,
        event.eventId,
         offer.personId,
         attendanceProgramUnitId,
         attendanceObservedAt,
         attendanceCommandKey,
         actor,
       );
       expect(observation.created).toBe(true);
       const persistedObservation = db
         .prepare("SELECT observed_at AS observedAt, recorded_at AS recordedAt, idempotency_key AS idempotencyKey FROM observations WHERE id = ?")
         .get(observation.observationId) as { observedAt: string; recordedAt: string; idempotencyKey: string };
       expect(observation.observedAt).toBe(persistedObservation.observedAt);
       expect(persistedObservation.idempotencyKey).toBe(persistedAttendanceKey);
       expect(persistedObservation).toMatchObject({
         observedAt: attendanceObservedAt,
         recordedAt: "2026-09-15T10:30:00.000Z",
       });
       expect(
        recordAttendance(
          db,
          northstar.id,
          event.eventId,
          offer.personId,
           attendanceProgramUnitId,
           attendanceObservedAt,
           attendanceCommandKey,
           actor,
         ),
       ).toMatchObject({
         created: false,
         observationId: observation.observationId,
         observedAt: persistedObservation.observedAt,
       });
      expect(() =>
        recordAttendance(
          db,
          northstar.id,
          event.eventId,
          differentPerson.id,
             attendanceProgramUnitId,
             attendanceObservedAt,
             attendanceCommandKey,
             actor,
           ),
      ).toThrow(/ATTENDANCE_INPUT_INVALID/);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM observations WHERE workspace_id = ?").get(northstar.id),
      ).toEqual({ n: 1 });

      const person = getPersonDetail(db, northstar.id, offer.personId);
      expect(person).not.toBeNull();
      const truthLayers = person?.ledgers
        .filter((entry) => entry.kind === "truth")
        .map((entry) => entry.layer) ?? [];
      expect(new Set(truthLayers)).toEqual(
        new Set(["candidate", "decision", "commitment", "operational"]),
      );
      expect(new Set(person?.ledgers
        .filter((entry) => entry.kind === "projection")
        .map((entry) => entry.projection))).toEqual(
        new Set(["proposed-assignment", "publication"]),
      );
      expect(person?.ledgers.some((entry) => entry.title.startsWith("Candidate assignment"))).toBe(true);
      expect(person?.ledgers.some((entry) => entry.title.startsWith("Organizer approved"))).toBe(true);

      expect(db.prepare("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 1 });

      expect(() =>
        db.prepare("UPDATE plan_versions SET content_json = '{}' WHERE id = ?").run(plan.planVersionId),
      ).toThrow(/plan_versions is immutable/);
      expect(() =>
        db.prepare("UPDATE commitment_offers SET terms_json = '{}' WHERE id = ?").run(offer.id),
      ).toThrow(/commitment_offers is immutable/);
      expect(() =>
        db.prepare("UPDATE publication_releases SET content_json = '{}' WHERE id = ?").run(release.releaseId),
      ).toThrow(/publication_releases is immutable/);
      expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/audit_events is immutable/);
      expect(() =>
        db.prepare(
          `INSERT OR REPLACE INTO plan_versions
             (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
           SELECT id, workspace_id, event_id, run_id, version_number, fingerprint, '{}', created_at
           FROM plan_versions WHERE id = ?`,
        ).run(plan.planVersionId),
      ).toThrow(/plan_versions is immutable/);
      expect(() =>
        db.prepare(
          `INSERT OR REPLACE INTO publication_releases
             (id, workspace_id, event_id, plan_version_id, audience_policy_version,
              commitment_watermark, fingerprint, content_json, sealed_at)
           SELECT id, workspace_id, event_id, plan_version_id, audience_policy_version,
                  commitment_watermark, fingerprint, '{}', sealed_at
           FROM publication_releases WHERE id = ?`,
        ).run(release.releaseId),
      ).toThrow(/publication_releases is immutable/);
      expect(() =>
        db.prepare(
          `INSERT OR REPLACE INTO observations
             (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
              observed_at, source, idempotency_key, corrected_by, recorded_at)
           SELECT id, workspace_id, event_id, person_id, program_unit_id, observation_type,
                  observed_at, 'replacement', idempotency_key, corrected_by, recorded_at
           FROM observations WHERE id = ?`,
        ).run(observation.observationId),
      ).toThrow(/observations is immutable/);
      expect(() =>
        db.prepare(
          `INSERT OR REPLACE INTO audit_events
             (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id,
              details_json, created_at)
           SELECT id, workspace_id, actor_kind, actor_ref, 'replacement', target_type,
                  target_id, details_json, created_at
           FROM audit_events WHERE workspace_id = ? ORDER BY rowid LIMIT 1`,
        ).run(northstar.id),
      ).toThrow(/audit_events is immutable/);
      expect(() =>
        db.prepare(
          `INSERT OR REPLACE INTO portal_tokens
             (id, workspace_id, release_id, person_id, token_hash, scope, created_at,
              expires_at, revoked_at, revoked_reason, revoked_by)
           SELECT id, workspace_id, release_id, person_id, token_hash, scope, created_at,
                  expires_at, NULL, NULL, NULL
           FROM portal_tokens WHERE id = ?`,
        ).run(storedToken.id),
      ).toThrow(/portal_tokens is retained for audit/);
    } finally {
      closeDb(db);
      vi.useRealTimers();
    }
  });

  it("prevalidates source manifests and keeps exact replay immutable", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const adapter = new SimulatedFixtureSourceAdapter(db);
      const manifest = fixtureForWorkspace("northstar");
      const first = adapter.importManifest(northstar.id, manifest);
      expect(first.imported).toHaveLength(12);
      expect(first.completedAt).not.toBe(manifest.importedAt);
      expect(
        (db
          .prepare("SELECT DISTINCT imported_at AS importedAt FROM source_records WHERE workspace_id = ?")
          .all(northstar.id) as { importedAt: string }[]),
      ).toEqual([{ importedAt: manifest.importedAt }]);
      expect(
        (db
          .prepare("SELECT DISTINCT created_at AS createdAt FROM people WHERE workspace_id = ?")
          .all(northstar.id) as { createdAt: string }[]),
      ).toEqual([{ createdAt: first.completedAt }]);
      expect(
        (db
          .prepare("SELECT DISTINCT created_at AS createdAt FROM source_links WHERE workspace_id = ?")
          .all(northstar.id) as { createdAt: string }[]),
      ).toEqual([{ createdAt: first.completedAt }]);
      const firstReceipt = db
        .prepare(
          `SELECT created_at AS createdAt, details_json AS detailsJson
           FROM audit_events WHERE workspace_id = ? AND action = 'source.import'`,
        )
        .get(northstar.id) as { createdAt: string; detailsJson: string };
      expect(firstReceipt.createdAt).toBe(first.completedAt);
      const firstReceiptDetails = JSON.parse(firstReceipt.detailsJson) as {
        completedAt: string;
        result: { imported: ImportedEvidence[]; skipped: number; personsCreated: number; receiptId: string };
      };
      expect(firstReceiptDetails).toMatchObject({
        completedAt: first.completedAt,
        result: {
          skipped: 0,
          personsCreated: 12,
          receiptId: first.receiptId,
        },
      });
      expect(firstReceiptDetails.result.imported).toEqual(first.imported);

      const before = {
        sourceRecords: db
          .prepare("SELECT id, payload_json AS payloadJson, imported_at AS importedAt FROM source_records ORDER BY id")
          .all(),
        people: db
          .prepare("SELECT id, canonical_email AS email, full_name AS fullName, created_at AS createdAt FROM people ORDER BY id")
          .all(),
        links: db
          .prepare("SELECT id, person_id AS personId, source_record_id AS sourceRecordId, created_at AS createdAt FROM source_links ORDER BY id")
          .all(),
        audits: db
          .prepare("SELECT id, details_json AS detailsJson, created_at AS createdAt FROM audit_events WHERE workspace_id = ? ORDER BY id")
          .all(northstar.id),
      };

      const replay = adapter.importManifest(northstar.id, manifest);
      expect(replay).toEqual(first);
      expect({
        sourceRecords: db
          .prepare("SELECT id, payload_json AS payloadJson, imported_at AS importedAt FROM source_records ORDER BY id")
          .all(),
        people: db
          .prepare("SELECT id, canonical_email AS email, full_name AS fullName, created_at AS createdAt FROM people ORDER BY id")
          .all(),
        links: db
          .prepare("SELECT id, person_id AS personId, source_record_id AS sourceRecordId, created_at AS createdAt FROM source_links ORDER BY id")
          .all(),
        audits: db
          .prepare("SELECT id, details_json AS detailsJson, created_at AS createdAt FROM audit_events WHERE workspace_id = ? ORDER BY id")
          .all(northstar.id),
      }).toEqual(before);

      const changed = {
        ...manifest,
        people: manifest.people.map((person, index) =>
          index === 0 ? { ...person, fullName: "Changed immutable input" } : person,
        ),
      };
      expect(() => adapter.importManifest(northstar.id, changed)).toThrow(/SOURCE_RECORD_CONFLICT/);
      expect(() =>
        adapter.importManifest(northstar.id, {
          ...manifest,
          importedAt: "2026-06-02T09:00:00.000Z",
        }),
      ).toThrow(/SOURCE_RECORD_CONFLICT/);
      expect({
        sourceRecords: db
          .prepare("SELECT id, payload_json AS payloadJson, imported_at AS importedAt FROM source_records ORDER BY id")
          .all(),
        people: db
          .prepare("SELECT id, canonical_email AS email, full_name AS fullName, created_at AS createdAt FROM people ORDER BY id")
          .all(),
        links: db
          .prepare("SELECT id, person_id AS personId, source_record_id AS sourceRecordId, created_at AS createdAt FROM source_links ORDER BY id")
          .all(),
        audits: db
          .prepare("SELECT id, details_json AS detailsJson, created_at AS createdAt FROM audit_events WHERE workspace_id = ? ORDER BY id")
          .all(northstar.id),
      }).toEqual({
        sourceRecords: before.sourceRecords,
        people: before.people,
        links: before.links,
        audits: before.audits,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM source_records WHERE workspace_id = ?").get(northstar.id),
      ).toEqual({ n: 12 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM people WHERE workspace_id = ?").get(northstar.id),
      ).toEqual({ n: 12 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM source_links WHERE workspace_id = ?").get(northstar.id),
      ).toEqual({ n: 12 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ?").get(northstar.id),
      ).toEqual({ n: 1 });

      const duplicate = {
        ...manifest,
        sourceRef: "fixtures/duplicate.v1.json",
        people: [manifest.people[0], { ...manifest.people[1], email: manifest.people[0].email }],
      };
      expect(() => adapter.importManifest(northstar.id, duplicate)).toThrow(
        /SOURCE_MANIFEST_DUPLICATE_OR_INVALID_IDENTITY/,
      );
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM source_records WHERE workspace_id = ?").get(northstar.id),
      ).toEqual({ n: 12 });
    } finally {
      closeDb(db);
    }
  });

  it("replays the original imported/skipped split from a partial receipt", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const adapter = new SimulatedFixtureSourceAdapter(db);
      const fullManifest = fixtureForWorkspace("northstar");
      const partialManifest = {
        ...fullManifest,
        people: fullManifest.people.slice(0, 6),
      };
      adapter.importManifest(northstar.id, partialManifest);
      const firstFull = adapter.importManifest(northstar.id, fullManifest);
      expect(firstFull.imported).toHaveLength(6);
      expect(firstFull.imported.map((entry) => entry.sourceRef)).toEqual(
        fullManifest.people.slice(6).map((_person, index) => `${fullManifest.sourceRef}#row-${index + 7}`),
      );
      expect(firstFull.skipped).toBe(6);
      expect(firstFull.personsCreated).toBe(6);
      expect(adapter.importManifest(northstar.id, fullManifest)).toEqual(firstFull);
    } finally {
      closeDb(db);
    }
  });

  it("uses random opaque person IDs and reuses the persisted winner", () => {
    const manifest = {
      ...fixtureForWorkspace("northstar"),
      people: [fixtureForWorkspace("northstar").people[0]],
    };
    const firstDb = openDb({ path: ":memory:" });
    const secondDb = openDb({ path: ":memory:" });
    try {
      const firstWorkspace = workspace(firstDb, "northstar");
      const secondWorkspace = workspace(secondDb, "northstar");
      const firstResult = new SimulatedFixtureSourceAdapter(firstDb).importManifest(firstWorkspace.id, manifest);
      const secondResult = new SimulatedFixtureSourceAdapter(secondDb).importManifest(secondWorkspace.id, manifest);
      expect(firstResult.imported[0].personId).not.toBe(secondResult.imported[0].personId);
      expect(firstResult.imported[0].personId).not.toBe(
        deterministicUuid(`person:${manifest.workspaceSlug}:${manifest.people[0].email}`),
      );
      expect(JSON.stringify(firstDb.prepare("SELECT details_json FROM audit_events").all())).not.toContain(
        manifest.people[0].email,
      );
    } finally {
      closeDb(firstDb);
      closeDb(secondDb);
    }

    const winnerDb = openDb({ path: ":memory:" });
    try {
      const winnerWorkspace = workspace(winnerDb, "northstar");
      const winnerPersonId = uuid();
      winnerDb.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, organization, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        winnerPersonId,
        winnerWorkspace.id,
        manifest.people[0].email,
        "Persisted Winner",
        "Synthetic",
        "Fixture",
        "2026-06-01T00:00:00.000Z",
      );
      const adapter = new SimulatedFixtureSourceAdapter(winnerDb);
      const result = adapter.importManifest(winnerWorkspace.id, manifest);
      expect(result.imported[0].personId).toBe(winnerPersonId);
      expect(result.personsCreated).toBe(0);
      expect(adapter.importManifest(winnerWorkspace.id, manifest)).toEqual(result);
      const acme = workspace(winnerDb, "acme");
      const acmeResult = adapter.importManifest(acme.id, {
        ...manifest,
        workspaceSlug: "acme",
        sourceRef: "fixtures/shared-person-acme.v1.json",
      });
      expect(acmeResult.imported[0].personId).not.toBe(winnerPersonId);
    } finally {
      closeDb(winnerDb);
    }
  });

  it("carries real imported opaque person IDs into delivery receipts", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      expect(importFixtureEvidence(db, flow.northstar.id, flow.northstar.slug)).toEqual(flow.imported);
      const delivery = deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(delivery.offersCreated).toBe(6);
      const importedPersonIds = new Map(flow.imported.imported.map((entry) => [entry.personId, entry]));
      const receiptRows = db
        .prepare(
          `SELECT a.target_id AS offerId, o.person_id AS personId, p.canonical_email AS email,
                  a.details_json AS detailsJson
           FROM audit_events a
           JOIN commitment_offers o ON o.id = a.target_id AND o.workspace_id = a.workspace_id
           JOIN people p ON p.id = o.person_id AND p.workspace_id = o.workspace_id
           WHERE a.workspace_id = ? AND a.action = 'commitment.offer.delivered'
           ORDER BY a.rowid`,
        )
        .all(flow.northstar.id) as {
        offerId: string;
        personId: string;
        email: string;
        detailsJson: string;
      }[];
      expect(receiptRows).toHaveLength(6);
      for (const row of receiptRows) {
        expect(importedPersonIds.has(row.personId)).toBe(true);
        const details = JSON.parse(row.detailsJson) as {
          workspaceId: string;
          eventId: string;
          personId: string;
          offerId: string;
          payloadFingerprint: string;
        };
        expect(details).toMatchObject({
          workspaceId: flow.northstar.id,
          eventId: flow.event.eventId,
          personId: row.personId,
          offerId: row.offerId,
        });
        expect(details.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(row.detailsJson).not.toContain(row.email);
        expect(row.detailsJson).not.toContain(
          deterministicUuid(`person:${flow.northstar.slug}:${row.email}`),
        );
      }
      const persistedReceiptsBeforeReplay = db
        .prepare(
          `SELECT id, target_id AS targetId, details_json AS detailsJson, created_at AS createdAt
           FROM audit_events WHERE workspace_id = ? AND action = 'commitment.offer.delivered' ORDER BY rowid`,
        )
        .all(flow.northstar.id);
      expect(deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor)).toMatchObject({
        offersCreated: 0,
        offersAlreadyPresent: 6,
        receipts: [],
      });
      expect(
        db
          .prepare(
            `SELECT id, target_id AS targetId, details_json AS detailsJson, created_at AS createdAt
             FROM audit_events WHERE workspace_id = ? AND action = 'commitment.offer.delivered' ORDER BY rowid`,
          )
          .all(flow.northstar.id),
      ).toEqual(persistedReceiptsBeforeReplay);
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["missing", (db: Db) => {
      db.exec("DROP TRIGGER IF EXISTS trg_audit_no_delete");
      db.prepare("DELETE FROM audit_events WHERE action = 'source.import'").run();
      db.exec(DDL);
    }],
    ["malformed", (db: Db) => {
      db.exec("DROP TRIGGER IF EXISTS trg_audit_immutable");
      db.prepare("UPDATE audit_events SET details_json = '{}' WHERE action = 'source.import'").run();
      db.exec(DDL);
    }],
    ["mismatched", (db: Db) => {
      db.exec("DROP TRIGGER IF EXISTS trg_audit_immutable");
      db.prepare("UPDATE audit_events SET target_id = 'wrong-workspace' WHERE action = 'source.import'").run();
      db.exec(DDL);
    }],
    ["identity-mismatched", (db: Db) => {
      db.exec("DROP TRIGGER IF EXISTS trg_audit_immutable");
      const row = db
        .prepare("SELECT details_json AS detailsJson FROM audit_events WHERE action = 'source.import'")
        .get() as { detailsJson: string };
      const details = JSON.parse(row.detailsJson) as { result: { imported: { sourceRef: string }[] } };
      details.result.imported[0].sourceRef = "fixtures/northstar-participants.v1.json#row-2";
      db.prepare("UPDATE audit_events SET details_json = ? WHERE action = 'source.import'").run(
        JSON.stringify(details),
      );
      db.exec(DDL);
    }],
    ["out-of-order", (db: Db) => {
      db.exec("DROP TRIGGER IF EXISTS trg_audit_immutable");
      const row = db
        .prepare("SELECT details_json AS detailsJson FROM audit_events WHERE action = 'source.import'")
        .get() as { detailsJson: string };
      const details = JSON.parse(row.detailsJson) as { result: { imported: ImportedEvidence[] } };
      [details.result.imported[0], details.result.imported[1]] = [
        details.result.imported[1],
        details.result.imported[0],
      ];
      db.prepare("UPDATE audit_events SET details_json = ? WHERE action = 'source.import'").run(
        JSON.stringify(details),
      );
      db.exec(DDL);
    }],
    ["incomplete", (db: Db) => {
      db.exec("DROP TRIGGER IF EXISTS trg_audit_immutable");
      const row = db
        .prepare("SELECT details_json AS detailsJson FROM audit_events WHERE action = 'source.import'")
        .get() as { detailsJson: string };
      const details = JSON.parse(row.detailsJson) as { result: Record<string, unknown> };
      delete details.result.imported;
      db.prepare("UPDATE audit_events SET details_json = ? WHERE action = 'source.import'").run(
        JSON.stringify(details),
      );
      db.exec(DDL);
    }],
    ["oversized", (db: Db) => {
      db.exec("DROP TRIGGER IF EXISTS trg_audit_immutable");
      const row = db
        .prepare("SELECT details_json AS detailsJson FROM audit_events WHERE action = 'source.import'")
        .get() as { detailsJson: string };
      const details = JSON.parse(row.detailsJson) as { result: { imported: ImportedEvidence[] } };
      details.result.imported = Array.from({ length: 501 }, () => details.result.imported[0]);
      db.prepare("UPDATE audit_events SET details_json = ? WHERE action = 'source.import'").run(
        JSON.stringify(details),
      );
      db.exec(DDL);
    }],
    ["duplicate", (db: Db) => {
      db.exec("DROP TRIGGER IF EXISTS trg_audit_immutable");
      const row = db
        .prepare("SELECT details_json AS detailsJson FROM audit_events WHERE action = 'source.import'")
        .get() as { detailsJson: string };
      const details = JSON.parse(row.detailsJson) as { result: { imported: ImportedEvidence[] } };
      details.result.imported[1] = details.result.imported[0];
      db.prepare("UPDATE audit_events SET details_json = ? WHERE action = 'source.import'").run(
        JSON.stringify(details),
      );
      db.exec(DDL);
    }],
  ] as const)("fails closed without writes for a %s persisted receipt", (_name, tamper) => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const manifest = fixtureForWorkspace("northstar");
      const adapter = new SimulatedFixtureSourceAdapter(db);
      adapter.importManifest(northstar.id, manifest);
      tamper(db);
      const before = {
        sourceRecords: db.prepare("SELECT * FROM source_records ORDER BY id").all(),
        people: db.prepare("SELECT * FROM people ORDER BY id").all(),
        links: db.prepare("SELECT * FROM source_links ORDER BY id").all(),
        audits: db.prepare("SELECT * FROM audit_events ORDER BY id").all(),
      };
      expect(() => adapter.importManifest(northstar.id, manifest)).toThrow(
        /SOURCE_CONSUMPTION_RECEIPT_INVALID/,
      );
      expect({
        sourceRecords: db.prepare("SELECT * FROM source_records ORDER BY id").all(),
        people: db.prepare("SELECT * FROM people ORDER BY id").all(),
        links: db.prepare("SELECT * FROM source_links ORDER BY id").all(),
        audits: db.prepare("SELECT * FROM audit_events ORDER BY id").all(),
      }).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("uses server link receipt time, not future caller provenance, for cohort asOf", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const actor = { kind: "account" as const, ref: organizer(db, northstar.id).id };
      const manifest = {
        ...fixtureForWorkspace("northstar"),
        importedAt: "2099-12-31T23:59:59.000Z",
      };
      new SimulatedFixtureSourceAdapter(db).importManifest(northstar.id, manifest);
      const snapshot = freezeCohortSnapshot(db, northstar.id, actor);
      const maxLinkReceipt = (
        db
          .prepare("SELECT MAX(created_at) AS createdAt FROM source_links WHERE workspace_id = ?")
          .get(northstar.id) as { createdAt: string }
      ).createdAt;
      expect(snapshot.asOf).toBe(maxLinkReceipt);
      expect(snapshot.asOf).not.toBe(manifest.importedAt);
      const definition = JSON.parse(
        (db
          .prepare("SELECT definition_json AS definitionJson FROM cohort_definitions WHERE workspace_id = ?")
          .get(northstar.id) as { definitionJson: string }).definitionJson,
      ) as { rule: { asOf: string } };
      expect(definition.rule.asOf).toBe(maxLinkReceipt);
    } finally {
      closeDb(db);
    }
  });

  it("fails closed when an included link has an invalid receipt timestamp", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const actor = { kind: "account" as const, ref: organizer(db, northstar.id).id };
      new SimulatedFixtureSourceAdapter(db).importManifest(northstar.id, fixtureForWorkspace("northstar"));
      db.exec("DROP TRIGGER IF EXISTS trg_source_links_immutable");
      db.prepare(
        "UPDATE source_links SET created_at = 'caller-provenance' WHERE id = (SELECT id FROM source_links WHERE workspace_id = ? LIMIT 1)",
      ).run(northstar.id);
      db.exec(DDL);
      expect(() => freezeCohortSnapshot(db, northstar.id, actor)).toThrow(/COHORT_LINK_RECEIPT_INVALID/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM cohort_snapshots").get()).toEqual({ n: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("uses opaque link IDs for deterministic tied-receipt member ordering", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const actor = { kind: "account" as const, ref: organizer(db, northstar.id).id };
      const fixture = fixtureForWorkspace("northstar");
      const manifest = {
        ...fixture,
        sourceRef: "fixtures/tied-cohort.v1.json",
        people: [
          { ...fixture.people[0], email: "tie-one@example.test", expertise: ["one"] },
          { ...fixture.people[1], email: "tie-two@example.test", expertise: ["two"] },
        ],
      };
      new SimulatedFixtureSourceAdapter(db).importManifest(northstar.id, manifest);
      const snapshot = freezeCohortSnapshot(db, northstar.id, actor);
      const expectedPersonIds = (
        db
          .prepare("SELECT id FROM people WHERE workspace_id = ? ORDER BY id")
          .all(northstar.id) as { id: string }[]
      ).map((row) => row.id);
      const actualPersonIds = (
        db
          .prepare(
            "SELECT person_id AS personId FROM cohort_snapshot_members WHERE workspace_id = ? AND snapshot_id = ? ORDER BY rank",
          )
          .all(northstar.id, snapshot.snapshotId) as { personId: string }[]
      ).map((row) => row.personId);
      expect(actualPersonIds).toEqual(expectedPersonIds);
    } finally {
      closeDb(db);
    }
  });

  it("derives tenant authority from the session and rejects cross-workspace relationships", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const acme = workspace(db, "acme");
      expect(() => importFixtureEvidence(db, northstar.id, acme.slug)).toThrow(
        /FIXTURE_WORKSPACE_MISMATCH/,
      );
      importFixtureEvidence(db, northstar.id, northstar.slug);
      importFixtureEvidence(db, acme.id, acme.slug);

      const northstarAccount = organizer(db, northstar.id);
      const session = createSession(db, northstarAccount.id, northstar.id).session;
      expect(() => assertWorkspaceMatch(session, acme.slug)).toThrowError(
        expect.objectContaining({ code: "CROSS_WORKSPACE_DENIED" }),
      );
      expect(() => createSession(db, northstarAccount.id, acme.id)).toThrowError(
        expect.objectContaining({ code: "SESSION_WORKSPACE_MISMATCH" }),
      );

      const acmePerson = listPeople(db, acme.id)[0];
      const northstarRecord = db
        .prepare("SELECT id FROM source_records WHERE workspace_id = ? LIMIT 1")
        .get(northstar.id) as { id: string };
      const northstarPerson = listPeople(db, northstar.id)[0];
      expect(getPersonDetail(db, northstar.id, acmePerson.id)).toBeNull();
      expect(getPersonDetail(db, acme.id, northstarPerson.id)).toBeNull();
      expect(() =>
        db.prepare(
          `INSERT INTO source_links
             (id, workspace_id, person_id, source_record_id, link_decision, created_at)
           VALUES (?, ?, ?, ?, 'forged', ?)`,
        ).run(uuid(), northstar.id, acmePerson.id, northstarRecord.id, new Date().toISOString()),
      ).toThrow(/source_links workspace mismatch/);

      const flow = runThroughApproval(db);
      expect(() =>
        recordAttendance(
          db,
          northstar.id,
          flow.event.eventId,
          acmePerson.id,
          flow.event.programUnitId,
          "2026-09-15T10:00:00.000Z",
          "forged-cross-workspace-attendance",
          flow.actor,
        ),
      ).toThrow(/PERSON_NOT_FOUND/);

      const northstarEmails = listPeople(db, northstar.id).map((person) => person.canonicalEmail);
      expect(northstarEmails.some((email) => email.endsWith("@acme-corp.example"))).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("recompiles changed inputs while commitments and releases follow the approved plan pointer", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      const firstPlanBefore = db
        .prepare("SELECT fingerprint, content_json AS content FROM plan_versions WHERE id = ?")
        .get(flow.plan.planVersionId);

      const addedUnit = createEventWithUnit(db, flow.northstar.id, flow.actor, {
        eventName: "Sympose Phase 0 Roundtable",
        unitName: "Afternoon circle",
        capacity: 6,
      });
      expect(addedUnit).toMatchObject({
        eventId: flow.event.eventId,
        eventCreated: false,
        programUnitCreated: true,
      });
      const secondPlan = compilePlan(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(secondPlan).toMatchObject({ created: true, versionNumber: 2, status: "FEASIBLE" });
      expect(secondPlan.planVersionId).not.toBe(flow.plan.planVersionId);
      expect(
        db
          .prepare("SELECT current_plan_version_id AS id FROM events WHERE workspace_id = ? AND id = ?")
          .get(flow.northstar.id, flow.event.eventId),
      ).toEqual({ id: flow.plan.planVersionId });
      expect(
        db.prepare("SELECT fingerprint, content_json AS content FROM plan_versions WHERE id = ?").get(
          flow.plan.planVersionId,
        ),
      ).toEqual(firstPlanBefore);

      expect(() =>
        createEventWithUnit(db, flow.northstar.id, flow.actor, {
          eventName: "Sympose Phase 0 Roundtable",
          unitName: "Afternoon circle",
          capacity: 7,
        }),
      ).toThrow(/EVENT_COMMAND_CONFLICT/);
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM program_units WHERE workspace_id = ? AND event_id = ?")
          .get(flow.northstar.id, flow.event.eventId),
      ).toEqual({ n: 2 });

      const delivery = deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(delivery.offersCreated).toBe(6);
      expect(
        deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor),
      ).toMatchObject({ offersCreated: 0, offersAlreadyPresent: 6, receipts: [] });

      const firstOffer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!firstOffer) throw new Error("expected first approved-plan offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: firstOffer.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(firstOffer.id, "accepted"),
      });
      const firstRelease = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(firstRelease).toMatchObject({ created: true, agendaCount: 1 });
      const firstReleaseBefore = db
        .prepare("SELECT fingerprint, content_json AS content FROM publication_releases WHERE id = ?")
        .get(firstRelease.releaseId);

      const secondOffer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!secondOffer) throw new Error("expected second approved-plan offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: secondOffer.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(secondOffer.id, "accepted"),
      });
      const secondRelease = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(secondRelease).toMatchObject({ created: true, agendaCount: 2 });
      expect(secondRelease.releaseId).not.toBe(firstRelease.releaseId);
      expect(secondRelease.fingerprint).not.toBe(firstRelease.fingerprint);
      expect(
        db.prepare("SELECT fingerprint, content_json AS content FROM publication_releases WHERE id = ?").get(
          firstRelease.releaseId,
        ),
      ).toEqual(firstReleaseBefore);
      expect(
        db
          .prepare(
            "SELECT current_plan_version_id AS planId, current_release_id AS releaseId FROM events WHERE workspace_id = ? AND id = ?",
          )
          .get(flow.northstar.id, flow.event.eventId),
      ).toEqual({ planId: flow.plan.planVersionId, releaseId: secondRelease.releaseId });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM publication_releases WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?",
          )
          .get(flow.northstar.id, flow.event.eventId, flow.plan.planVersionId),
      ).toEqual({ n: 2 });
      expect(sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor)).toMatchObject({
        releaseId: secondRelease.releaseId,
        fingerprint: secondRelease.fingerprint,
        created: false,
      });
    } finally {
      closeDb(db);
    }
  });

  it("fails closed when the approved plan pointer is absent", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      db.prepare(
        "UPDATE events SET current_plan_version_id = NULL WHERE workspace_id = ? AND id = ?",
      ).run(flow.northstar.id, flow.event.eventId);

      expect(latestPlanVersion(db, flow.northstar.id, flow.event.eventId)).toBeNull();
      expect(() => deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor)).toThrow(/NO_PLAN/);
      expect(() => sealRelease(db, flow.northstar.id, flow.event.eventId, flow.actor)).toThrow(/NO_PLAN/);
      expect(getDashboardState(db, flow.northstar.id, [])).toMatchObject({
        currentPlan: null,
        candidatePlan: null,
        offers: [],
      });
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM commitment_offers WHERE workspace_id = ?")
          .get(flow.northstar.id),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM publication_releases WHERE workspace_id = ?")
          .get(flow.northstar.id),
      ).toEqual({ n: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("keeps operational plans, offers, responses, and releases on the current pointer", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      const firstDelivery = deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(firstDelivery.offersCreated).toBe(6);
      const acceptedV1 = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!acceptedV1) throw new Error("expected a v1 offer");
      const acceptedV1Command = {
        offerId: acceptedV1.id,
        response: "accepted" as const,
        commandKey: commitmentResponseCommandKey(acceptedV1.id, "accepted"),
      };
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, acceptedV1Command);
      const releaseV1 = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(releaseV1.created).toBe(true);
      const staleV1 = db
        .prepare(
          `SELECT id, person_id AS personId FROM commitment_offers
           WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ? AND id != ?
             AND NOT EXISTS (SELECT 1 FROM commitment_responses WHERE workspace_id = ? AND offer_id = commitment_offers.id)
           ORDER BY rowid LIMIT 1`,
        )
        .get(
             flow.northstar.id,
             flow.event.eventId,
             flow.plan.planVersionId,
             acceptedV1.id,
             flow.northstar.id,
         ) as { id: string; personId: string } | undefined;
      if (!staleV1) throw new Error("expected a pending stale v1 offer");

      createEventWithUnit(db, flow.northstar.id, flow.actor, {
        eventName: "Sympose Phase 0 Roundtable",
        unitName: "Afternoon circle",
        capacity: 6,
      });
      const planV2 = compilePlan(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(getDashboardState(db, flow.northstar.id, [])).toMatchObject({
        currentPlan: { id: flow.plan.planVersionId },
        candidatePlan: { id: planV2.planVersionId },
      });
      expect(() =>
        approvePlan(db, flow.northstar.id, flow.event.eventId, planV2.planVersionId, null, flow.actor),
      ).toThrow(/PLAN_POINTER_EXPECTATION_FAILED/);
      const approvalV2 = approvePlan(
        db,
        flow.northstar.id,
        flow.event.eventId,
        planV2.planVersionId,
        flow.plan.planVersionId,
        flow.actor,
      );
      expect(approvalV2.created).toBe(true);
      expect(latestPlanVersion(db, flow.northstar.id, flow.event.eventId)?.id).toBe(planV2.planVersionId);
      expect(resolveCurrentPublicAgendaRelease(db, {
        workspaceId: flow.northstar.id,
        eventId: flow.event.eventId,
      }, "public")).toBeNull();
      expect(resolveSavedPublicAgendaRelease(db, {
        workspaceId: flow.northstar.id,
        eventId: flow.event.eventId,
        releaseId: releaseV1.releaseId,
      }, "public")).toBeNull();

      db.prepare("UPDATE events SET current_plan_version_id = ? WHERE workspace_id = ? AND id = ?")
        .run(flow.plan.planVersionId, flow.northstar.id, flow.event.eventId);
      expect(() => sealRelease(db, flow.northstar.id, flow.event.eventId, flow.actor)).toThrow(/PLAN_POINTER_STALE/);
      db.prepare("UPDATE events SET current_plan_version_id = ? WHERE workspace_id = ? AND id = ?")
        .run(planV2.planVersionId, flow.northstar.id, flow.event.eventId);

      const secondDelivery = deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(secondDelivery.offersCreated).toBe(12);
      const acceptedV2 = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!acceptedV2) throw new Error("expected a v2 offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: acceptedV2.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(acceptedV2.id, "accepted"),
      });
      const releaseV2 = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(releaseV2.created).toBe(true);

      // A later accepted offer on the same source plan changes live commitment state,
      // but must not rewrite the already sealed release used by exact/portal reads.
      const laterOffer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!laterOffer) throw new Error("expected a later pending offer on the source plan");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: laterOffer.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(laterOffer.id, "accepted"),
      });
      expect(resolveExactPublicAgendaRelease(db, {
        workspaceId: flow.northstar.id,
        eventId: flow.event.eventId,
        releaseId: releaseV1.releaseId,
      }, "public")).not.toBeNull();
      expect(resolvePortalAccess(db, releaseV1.tokens[0]!.rawToken).releaseId).toBe(releaseV1.releaseId);
      expect(resolveCurrentPublicAgendaRelease(db, {
        workspaceId: flow.northstar.id,
        eventId: flow.event.eventId,
      }, "public")).toBeNull();

      const acceptedAuditCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'commitment.accepted'",
          )
          .get(flow.northstar.id) as { n: number }
      ).n;
      expect(respondToOfferCommand(
        db,
        flow.northstar.id,
        flow.event.eventId,
        acceptedV1Command,
      )).toMatchObject({ created: false, offerId: acceptedV1.id, response: "accepted" });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'commitment.accepted'",
          )
          .get(flow.northstar.id),
      ).toEqual({ n: acceptedAuditCount });

      const responseCountBeforeStale = (
        db.prepare("SELECT COUNT(*) AS n FROM commitment_responses WHERE workspace_id = ?").get(flow.northstar.id) as {
          n: number;
        }
      ).n;
      const deliveryCountBeforeStale = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'commitment.offer.delivered'",
          )
          .get(flow.northstar.id) as { n: number }
      ).n;
      expect(() =>
        respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
          offerId: staleV1.id,
          response: "declined",
          commandKey: commitmentResponseCommandKey(staleV1.id, "declined"),
        }),
      ).toThrow(/OFFER_NOT_CURRENT/);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM commitment_responses WHERE workspace_id = ?").get(flow.northstar.id),
      ).toEqual({ n: responseCountBeforeStale });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'commitment.offer.delivered'",
          )
          .get(flow.northstar.id),
      ).toEqual({ n: deliveryCountBeforeStale });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'commitment.declined'",
          )
          .get(flow.northstar.id),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'security.access.denied'",
          )
          .get(flow.northstar.id),
      ).toEqual({ n: 1 });

      const dashboard = getDashboardState(db, flow.northstar.id, []);
      expect(dashboard.currentPlan?.id).toBe(planV2.planVersionId);
      expect(dashboard.planDetailView?.version.id).toBe(planV2.planVersionId);
      expect(dashboard.approvals).toEqual([{ planVersionId: planV2.planVersionId, createdAt: expect.any(String) }]);
      expect(dashboard.offers.every((offer) => offer.planVersionId === planV2.planVersionId)).toBe(true);
      expect(dashboard.offers).toHaveLength(12);
      // A later commitment makes the current audience projection fail its live read gate.
      // Home must not trust the raw release pointer once public reads reject that evidence.
      expect(dashboard.release).toBeNull();
      expect(latestRelease(db, flow.northstar.id, flow.event.eventId)?.id).toBe(releaseV2.releaseId);
      expect(listOffers(db, flow.northstar.id, flow.event.eventId).every(
        (offer) => offer.planVersionId === planV2.planVersionId,
      )).toBe(true);
      expect(
        db
          .prepare(
            "SELECT current_plan_version_id AS planId, current_release_id AS releaseId FROM events WHERE workspace_id = ? AND id = ?",
          )
          .get(flow.northstar.id, flow.event.eventId),
      ).toEqual({ planId: planV2.planVersionId, releaseId: releaseV2.releaseId });
    } finally {
      closeDb(db);
    }
  });

  it("selects the current release pointer rather than sealed-at ordering", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: offer.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
      });
      const first = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const nextOffer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!nextOffer) throw new Error("expected second offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: nextOffer.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(nextOffer.id, "accepted"),
      });
      const second = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(second.releaseId).not.toBe(first.releaseId);
      db.prepare("UPDATE events SET current_release_id = ? WHERE workspace_id = ? AND id = ?").run(
        first.releaseId,
        flow.northstar.id,
        flow.event.eventId,
      );
      expect(latestRelease(db, flow.northstar.id, flow.event.eventId)?.id).toBe(first.releaseId);
      expect(latestRelease(db, flow.northstar.id, flow.event.eventId)?.id).not.toBe(second.releaseId);
    } finally {
      closeDb(db);
    }
  });

  it("fails closed on stale non-null plan and release pointers", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: offer.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
      });
      const release = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      db.exec("DROP TRIGGER IF EXISTS trg_events_pointer_guard");
      try {
        db.prepare(
          "UPDATE events SET current_plan_version_id = ?, current_release_id = ? WHERE workspace_id = ? AND id = ?",
        ).run("stale-plan-pointer", "stale-release-pointer", flow.northstar.id, flow.event.eventId);
        expect(() => latestPlanVersion(db, flow.northstar.id, flow.event.eventId)).toThrow(
          /EVENT_CURRENT_PLAN_POINTER_INVALID/,
        );
        expect(() => latestRelease(db, flow.northstar.id, flow.event.eventId)).toThrow(
          /EVENT_CURRENT_RELEASE_POINTER_INVALID/,
        );
        expect(() => getDashboardState(db, flow.northstar.id, [])).toThrow(
          /EVENT_CURRENT_PLAN_POINTER_INVALID/,
        );
      } finally {
        db.exec(DDL);
      }
      expect(release.releaseId).toBeTruthy();
    } finally {
      closeDb(db);
    }
  });

  it("renders an unavailable Home release when its scoped pointer is dangling", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      const danglingReleaseId = uuid();
      db.exec("DROP TRIGGER IF EXISTS trg_events_pointer_guard");
      try {
        db.prepare(
          "UPDATE events SET current_release_id = ? WHERE workspace_id = ? AND id = ?",
        ).run(danglingReleaseId, flow.northstar.id, flow.event.eventId);
        expect(() => latestRelease(db, flow.northstar.id, flow.event.eventId)).toThrow(
          /EVENT_CURRENT_RELEASE_POINTER_INVALID/,
        );
        expect(getDashboardState(db, flow.northstar.id, []).release).toBeNull();
      } finally {
        db.exec(DDL);
      }
    } finally {
      closeDb(db);
    }
  });

  it("serves current, exact, saved, and organizer reads from sealed event lineage after an event rename", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      const release = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const token = release.tokens[0]?.rawToken;
      if (!token) throw new Error("expected portal token");
      db.prepare("UPDATE events SET name = ? WHERE workspace_id = ? AND id = ?").run("Renamed after sealing", flow.northstar.id, flow.event.eventId);

      expect(resolvePortalAccess(db, token).event.name).toBe("Sympose Phase 0 Roundtable");
      expect(resolveCurrentPublicAgendaRelease(db, { workspaceId: flow.northstar.id, eventId: flow.event.eventId }, "public")).not.toBeNull();
      expect(resolveExactPublicAgendaRelease(db, { workspaceId: flow.northstar.id, eventId: flow.event.eventId, releaseId: release.releaseId }, "public")).not.toBeNull();
      expect(latestRelease(db, flow.northstar.id, flow.event.eventId)?.id).toBe(release.releaseId);
    } finally {
      closeDb(db);
    }
  });

  it("rejects a source plan with mismatched version, approval, or canonical offer terms", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      db.exec("DROP TRIGGER IF EXISTS trg_plan_versions_immutable");
      const planRow = db.prepare("SELECT content_json AS content FROM plan_versions WHERE id = ?").get(flow.plan.planVersionId) as { content: string };
      const tamperedPlan = JSON.parse(planRow.content) as Record<string, unknown>;
      tamperedPlan.eventName = "Forged plan name";
      db.prepare("UPDATE plan_versions SET content_json = ? WHERE id = ?").run(JSON.stringify(tamperedPlan), flow.plan.planVersionId);
      expect(() => sealRelease(db, flow.northstar.id, flow.event.eventId, flow.actor)).toThrow(/PLAN_CONTENT_FINGERPRINT_INVALID/);
      db.exec(DDL);
    } finally {
      closeDb(db);
    }

    const termsDb = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(termsDb);
      deliverOffers(termsDb, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(termsDb, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(termsDb, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      termsDb.exec("DROP TRIGGER IF EXISTS trg_offers_immutable");
      termsDb.prepare("UPDATE commitment_offers SET terms_json = ? WHERE id = ?").run(JSON.stringify({ schema: "commitment-offer-terms/v1", role: "forged" }), offer.id);
      expect(() => sealRelease(termsDb, flow.northstar.id, flow.event.eventId, flow.actor)).toThrow(/OFFER_TERMS_FINGERPRINT_INVALID/);
    } finally {
      closeDb(termsDb);
    }
  });

  it("fails closed for tampered sealed content and agenda multisets", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      const release = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const row = db.prepare("SELECT content_json AS content FROM publication_releases WHERE id = ?").get(release.releaseId) as { content: string };
      const content = JSON.parse(row.content) as SealedReleaseContent;
      content.agendas[0]!.email = "forged@example.invalid";
      db.exec("DROP TRIGGER IF EXISTS trg_releases_immutable");
      db.prepare("UPDATE publication_releases SET content_json = ?, fingerprint = ? WHERE id = ?").run(JSON.stringify(content), fingerprintOf(content), release.releaseId);
      expect(() => resolvePortalAccess(db, release.tokens[0]!.rawToken)).toThrow(/RELEASE_INTEGRITY_FAILED|This sealed release failed validation|agenda/i);
      expect(resolveCurrentPublicAgendaRelease(db, { workspaceId: flow.northstar.id, eventId: flow.event.eventId }, "public")).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("rejects coordinated release, fingerprint, and agenda tampering against source authority", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      const release = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const alternatePerson = db.prepare(
        "SELECT id, full_name AS fullName, canonical_email AS email FROM people WHERE workspace_id = ? AND id <> ? ORDER BY id LIMIT 1",
      ).get(flow.northstar.id, offer.personId) as { id: string; fullName: string; email: string };
      const releaseRow = db.prepare("SELECT content_json AS content FROM publication_releases WHERE id = ?").get(release.releaseId) as { content: string };
      const content = JSON.parse(releaseRow.content) as SealedReleaseContent;
      content.accepted[0]!.personId = alternatePerson.id;
      content.accepted[0]!.personName = alternatePerson.fullName;
      content.accepted[0]!.email = alternatePerson.email;
      content.agendas[0]!.personId = alternatePerson.id;
      content.agendas[0]!.personName = alternatePerson.fullName;
      content.agendas[0]!.email = alternatePerson.email;
      db.exec("DROP TRIGGER IF EXISTS trg_releases_immutable");
      db.prepare("UPDATE publication_releases SET content_json = ?, fingerprint = ? WHERE id = ?")
        .run(JSON.stringify(content), fingerprintOf(content), release.releaseId);
      db.exec("DROP TRIGGER IF EXISTS trg_agendas_immutable");
      db.prepare("UPDATE personal_agendas SET person_id = ?, agenda_json = ? WHERE release_id = ? AND person_id = ?")
        .run(alternatePerson.id, JSON.stringify({ releaseId: release.releaseId, fingerprint: fingerprintOf(content), personName: alternatePerson.fullName, email: alternatePerson.email, items: content.agendas[0]!.items }), release.releaseId, offer.personId);
      expect(() => resolvePortalAccess(db, release.tokens[0]!.rawToken)).toThrow(/RELEASE_INTEGRITY_FAILED|This sealed release failed validation|accepted commitments|exact accepted assignment/);
      expect(resolveExactPublicAgendaRelease(db, { workspaceId: flow.northstar.id, eventId: flow.event.eventId, releaseId: release.releaseId }, "public")).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("rejects historical reads after coordinated watermark, content, and fingerprint tampering", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: offer.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
      });
      const release = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const row = db.prepare(
        "SELECT content_json AS content, commitment_watermark AS commitmentWatermark FROM publication_releases WHERE id = ?",
      ).get(release.releaseId) as { content: string; commitmentWatermark: number };
      const content = JSON.parse(row.content) as SealedReleaseContent;
      content.commitmentWatermark += 1;
      db.exec("DROP TRIGGER IF EXISTS trg_releases_immutable");
      db.prepare(
        "UPDATE publication_releases SET commitment_watermark = ?, content_json = ?, fingerprint = ? WHERE id = ?",
      ).run(row.commitmentWatermark + 1, JSON.stringify(content), fingerprintOf(content), release.releaseId);
      expect(resolveExactPublicAgendaRelease(db, {
        workspaceId: flow.northstar.id,
        eventId: flow.event.eventId,
        releaseId: release.releaseId,
      }, "public")).toBeNull();
      expect(() => resolvePortalAccess(db, release.tokens[0]!.rawToken)).toThrowError(
        expect.objectContaining({ code: "RELEASE_INTEGRITY_FAILED" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it("rejects a sealed release whose immutable plan approval actor is nonexistent", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: offer.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
      });
      const release = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      db.exec("PRAGMA foreign_keys = OFF; DROP TRIGGER IF EXISTS trg_approvals_immutable;");
      db.prepare(
        "UPDATE approvals SET actor_account_id = ? WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?",
      ).run("nonexistent-plan-approval-actor", flow.northstar.id, flow.event.eventId, flow.plan.planVersionId);
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(DDL);

      expect(resolveExactPublicAgendaRelease(db, {
        workspaceId: flow.northstar.id,
        eventId: flow.event.eventId,
        releaseId: release.releaseId,
      }, "public")).toBeNull();
      expect(() => resolvePortalAccess(db, release.tokens[0]!.rawToken)).toThrowError(
        expect.objectContaining({ code: "RELEASE_INTEGRITY_FAILED" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it("rejects agenda rows outside the release workspace before cardinality can pass", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      const release = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const foreignWorkspaceId = uuid();
      const foreignPersonId = uuid();
      db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(foreignWorkspaceId, `foreign-${foreignWorkspaceId}`, "Foreign", nowIso());
      db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run(foreignPersonId, foreignWorkspaceId, `${foreignPersonId}@example.invalid`, "Foreign Person", nowIso());
      db.exec("DROP TRIGGER IF EXISTS trg_agendas_workspace_guard");
      db.prepare("INSERT INTO personal_agendas (id, workspace_id, release_id, person_id, agenda_json) VALUES (?, ?, ?, ?, ?)")
        .run(uuid(), foreignWorkspaceId, release.releaseId, foreignPersonId, JSON.stringify({ releaseId: release.releaseId, fingerprint: release.fingerprint, personName: "Foreign Person", email: `${foreignPersonId}@example.invalid`, items: [] }));
      expect(() => resolvePortalAccess(db, release.tokens[0]!.rawToken)).toThrow(/This sealed release failed validation|agenda materialization/i);
    } finally {
      closeDb(db);
    }
  });

  it("rejects recomputed malformed plan envelopes and duplicate authoritative assignments", () => {
    const malformedDb = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(malformedDb);
      deliverOffers(malformedDb, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(malformedDb, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(malformedDb, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      const row = malformedDb.prepare("SELECT content_json AS content FROM plan_versions WHERE id = ?").get(flow.plan.planVersionId) as { content: string };
      const content = JSON.parse(row.content) as Record<string, unknown>;
      content.runId = { forged: true };
      content.exclusions = "forged";
      content.diagnostics = null;
      malformedDb.exec("DROP TRIGGER IF EXISTS trg_plan_versions_immutable");
      malformedDb.prepare("UPDATE plan_versions SET content_json = ?, fingerprint = ? WHERE id = ?").run(JSON.stringify(content), fingerprintOf(content), flow.plan.planVersionId);
      expect(() => sealRelease(malformedDb, flow.northstar.id, flow.event.eventId, flow.actor)).toThrow(/PLAN_CONTENT_FINGERPRINT_INVALID/);
    } finally {
      closeDb(malformedDb);
    }

    const duplicateDb = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(duplicateDb);
      deliverOffers(duplicateDb, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(duplicateDb, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(duplicateDb, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      const source = duplicateDb.prepare("SELECT person_id AS personId, program_unit_id AS programUnitId, assignment_type AS assignmentType, explanation FROM plan_assignments WHERE plan_version_id = ? AND person_id = ? ORDER BY id LIMIT 1").get(flow.plan.planVersionId, offer.personId) as { personId: string; programUnitId: string; assignmentType: string; explanation: string };
      const unitId = uuid();
      duplicateDb.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, 'roundtable', ?, ?, 6, ?)").run(unitId, flow.northstar.id, flow.event.eventId, "Forged duplicate unit", "2026-06-01T14:00:00.000Z", "2026-06-01T15:00:00.000Z", nowIso());
      duplicateDb.prepare("INSERT INTO plan_assignments (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?, 0)").run(uuid(), flow.northstar.id, flow.plan.planVersionId, source.personId, unitId, source.assignmentType, source.explanation);
      const planRow = duplicateDb.prepare("SELECT content_json AS content FROM plan_versions WHERE id = ?").get(flow.plan.planVersionId) as { content: string };
      const planContent = JSON.parse(planRow.content) as { assignments: unknown[] } & Record<string, unknown>;
      planContent.assignments.push({ personId: source.personId, programUnitId: unitId, assignmentType: source.assignmentType, explanation: source.explanation });
      duplicateDb.exec("DROP TRIGGER IF EXISTS trg_plan_versions_immutable");
      duplicateDb.prepare("UPDATE plan_versions SET content_json = ?, fingerprint = ? WHERE id = ?").run(JSON.stringify(planContent), fingerprintOf(planContent), flow.plan.planVersionId);
      const offerRow = duplicateDb.prepare("SELECT terms_json AS termsJson FROM commitment_offers WHERE id = ?").get(offer.id) as { termsJson: string };
      const terms = JSON.parse(offerRow.termsJson) as Record<string, unknown>;
      terms.planFingerprint = fingerprintOf(planContent);
      duplicateDb.exec("DROP TRIGGER IF EXISTS trg_offers_immutable");
      duplicateDb.prepare("UPDATE commitment_offers SET terms_json = ?, terms_fingerprint = ? WHERE id = ?").run(JSON.stringify(terms), fingerprintOf(terms), offer.id);
      expect(() => sealRelease(duplicateDb, flow.northstar.id, flow.event.eventId, flow.actor)).toThrow(/COMMITMENT_ASSIGNMENT_MISMATCH|cardinality/i);
    } finally {
      closeDb(duplicateDb);
    }
  });

  it("requires organizer capability from the seal-time approval authority", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      db.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ? AND workspace_id = ?").run(flow.account.id, flow.northstar.id);
      expect(() => sealRelease(db, flow.northstar.id, flow.event.eventId, flow.actor)).toThrow(/AUTHORITY_INVALID|CAPABILITY/i);
    } finally {
      closeDb(db);
    }
  });

  it("rejects durable plan approval by a nonexistent account without side effects", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const account = organizer(db, northstar.id);
      const actor = { kind: "account" as const, ref: account.id };
      importFixtureEvidence(db, northstar.id, northstar.slug);
      freezeCohortSnapshot(db, northstar.id, actor);
      const event = createEventWithUnit(db, northstar.id, actor, {
        eventName: "Sympose Phase 0 Roundtable",
        unitName: "Morning circle",
        capacity: 6,
      });
      const plan = compilePlan(db, northstar.id, event.eventId, actor);
      const before = pointerTruthSnapshot(db, northstar.id, event.eventId);
      expect(() => approvePlan(
        db,
        northstar.id,
        event.eventId,
        plan.planVersionId,
        null,
        { kind: "account", ref: "nonexistent-approval-actor" },
      )).toThrowError(expect.objectContaining({ code: "CAPABILITY_DENIED" }));
      expect(pointerTruthSnapshot(db, northstar.id, event.eventId)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("binds sealed identity and materialization one-to-one and ignores later plan supersession", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected offer");
      respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, { offerId: offer.id, response: "accepted", commandKey: commitmentResponseCommandKey(offer.id, "accepted") });
      const release = sealPreparedRelease(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const token = release.tokens[0]?.rawToken;
      if (!token) throw new Error("expected portal token");
      expect(resolvePortalAccess(db, token).email).toBeTruthy();

      const releaseRow = db.prepare("SELECT content_json AS content FROM publication_releases WHERE id = ?").get(release.releaseId) as { content: string };
      const originalContent = JSON.parse(releaseRow.content) as SealedReleaseContent;
      const duplicateContent = structuredClone(originalContent);
      duplicateContent.accepted.push(structuredClone(duplicateContent.accepted[0]!));
      duplicateContent.agendas.push(structuredClone(duplicateContent.agendas[0]!));
      db.exec("DROP TRIGGER IF EXISTS trg_releases_immutable");
      db.prepare("UPDATE publication_releases SET content_json = ?, fingerprint = ? WHERE id = ?")
        .run(JSON.stringify(duplicateContent), fingerprintOf(duplicateContent), release.releaseId);
      expect(() => resolvePortalAccess(db, token)).toThrow(/RELEASE_INTEGRITY_FAILED|This sealed release failed validation|duplicate accepted identities/);
      db.prepare("UPDATE publication_releases SET content_json = ?, fingerprint = ? WHERE id = ?")
        .run(JSON.stringify(originalContent), fingerprintOf(originalContent), release.releaseId);

      db.exec("DROP TRIGGER IF EXISTS trg_agendas_no_delete");
      db.prepare("DELETE FROM personal_agendas WHERE release_id = ?").run(release.releaseId);
      expect(() => resolvePortalAccess(db, token)).toThrow(/This sealed release failed validation|incomplete personal agenda materialization/);

      expect(() => resolvePortalAccess(db, token)).toThrow(/This sealed release failed validation|incomplete personal agenda materialization/);
    } finally {
      closeDb(db);
    }
  });

  it("rejects approval on corrupt stored plan pointers before trusting the caller expectation", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = approvedFlowWithNextCandidate(db);
      const acme = workspace(db, "acme");
      const acmeAccount = organizer(db, acme.id);
      const sibling = seedApprovedPlanForOtherEvent(
        db,
        flow.northstar.id,
        flow.account.id,
        "sibling",
      );
      const foreign = seedApprovedPlanForOtherEvent(db, acme.id, acmeAccount.id, "foreign");

      const baseline = pointerTruthSnapshot(db, flow.northstar.id, flow.event.eventId);
      const acmeBaseline = pointerTruthSnapshot(db, acme.id, foreign.eventId);
      expect(baseline.pointer).toEqual({ currentPlanVersionId: flow.plan.planVersionId });

      const corruptPointers: { reason: string; pointer: string | null }[] = [
        { reason: "nonexistent plan", pointer: "missing-plan-pointer" },
        { reason: "same-workspace plan of another event", pointer: sibling.planVersionId },
        { reason: "foreign-workspace plan", pointer: foreign.planVersionId },
        { reason: "unapproved candidate plan", pointer: flow.candidate.planVersionId },
        { reason: "null despite approved history", pointer: null },
      ];

      for (const corrupt of corruptPointers) {
        forceCurrentPlanPointer(db, flow.northstar.id, flow.event.eventId, corrupt.pointer);
        expect(() =>
          approvePlan(
            db,
            flow.northstar.id,
            flow.event.eventId,
            flow.candidate.planVersionId,
            corrupt.pointer,
            flow.actor,
          ),
        ).toThrow(/EVENT_CURRENT_PLAN_POINTER_INVALID/);
        expect({ reason: corrupt.reason, ...pointerTruthSnapshot(db, flow.northstar.id, flow.event.eventId) }).toEqual({
          reason: corrupt.reason,
          ...baseline,
          pointer: { currentPlanVersionId: corrupt.pointer },
        });
        expect(pointerTruthSnapshot(db, acme.id, foreign.eventId)).toEqual(acmeBaseline);
      }

      // The corrupt pointer is never repaired in place; only honest storage truth approves.
      forceCurrentPlanPointer(db, flow.northstar.id, flow.event.eventId, flow.plan.planVersionId);
      expect(
        approvePlan(
          db,
          flow.northstar.id,
          flow.event.eventId,
          flow.candidate.planVersionId,
          flow.plan.planVersionId,
          flow.actor,
        ).created,
      ).toBe(true);
      expect(latestPlanVersion(db, flow.northstar.id, flow.event.eventId)?.id).toBe(
        flow.candidate.planVersionId,
      );
    } finally {
      closeDb(db);
    }
  });

  it("rejects approval when the pointer names an older approved plan than the newest approval", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = approvedFlowWithNextCandidate(db);
      const approvalV2 = approvePlan(
        db,
        flow.northstar.id,
        flow.event.eventId,
        flow.candidate.planVersionId,
        flow.plan.planVersionId,
        flow.actor,
      );
      expect(approvalV2.created).toBe(true);
      const candidateV3 = nextCandidate(db, flow, "Evening circle");

      forceCurrentPlanPointer(db, flow.northstar.id, flow.event.eventId, flow.plan.planVersionId);
      const baseline = pointerTruthSnapshot(db, flow.northstar.id, flow.event.eventId);
      expect(() =>
        approvePlan(
          db,
          flow.northstar.id,
          flow.event.eventId,
          candidateV3.planVersionId,
          flow.plan.planVersionId,
          flow.actor,
        ),
      ).toThrow(/EVENT_CURRENT_PLAN_POINTER_INVALID/);
      expect(pointerTruthSnapshot(db, flow.northstar.id, flow.event.eventId)).toEqual(baseline);

      forceCurrentPlanPointer(db, flow.northstar.id, flow.event.eventId, flow.candidate.planVersionId);
      expect(
        approvePlan(
          db,
          flow.northstar.id,
          flow.event.eventId,
          candidateV3.planVersionId,
          flow.candidate.planVersionId,
          flow.actor,
        ).created,
      ).toBe(true);
      expect(latestPlanVersion(db, flow.northstar.id, flow.event.eventId)?.id).toBe(
        candidateV3.planVersionId,
      );
    } finally {
      closeDb(db);
    }
  });

  it("rejects approval when the current plan's only approval decision is not canonical", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = approvedFlowWithNextCandidate(db);
      const canonicalBaseline = pointerTruthSnapshot(db, flow.northstar.id, flow.event.eventId);
      expect(canonicalBaseline.pointer).toEqual({ currentPlanVersionId: flow.plan.planVersionId });
      expect(canonicalBaseline.approvals).toEqual([
        {
          id: expect.any(String),
          eventId: flow.event.eventId,
          planVersionId: flow.plan.planVersionId,
          decision: "approved",
          createdAt: expect.any(String),
        },
      ]);

      // The existing unique key already makes at most one approval per plan schema-reachable,
      // so binding the exact canonical decision needs no schema change.
      expect(() =>
        db
          .prepare(
            `INSERT INTO approvals (id, workspace_id, event_id, plan_version_id, actor_account_id, decision, created_at)
             VALUES (?, ?, ?, ?, ?, 'approved', ?)`,
          )
          .run(
            uuid(),
            flow.northstar.id,
            flow.event.eventId,
            flow.plan.planVersionId,
            flow.account.id,
            "2026-06-03T09:00:00.000Z",
          ),
      ).toThrow(
        /UNIQUE constraint failed: approvals\.workspace_id, approvals\.event_id, approvals\.plan_version_id/,
      );

      const noncanonicalDecisions: { reason: string; decision: string }[] = [
        { reason: "rejected decision", decision: "rejected" },
        { reason: "unknown token", decision: "revoked" },
        { reason: "empty token", decision: "" },
        { reason: "whitespace-only token", decision: "   " },
        { reason: "leading-padded canonical token", decision: " approved" },
        { reason: "trailing-padded canonical token", decision: "approved " },
        { reason: "newline-padded canonical token", decision: "approved\n" },
        { reason: "capitalized canonical token", decision: "Approved" },
        { reason: "upper-cased canonical token", decision: "APPROVED" },
      ];

      for (const corrupt of noncanonicalDecisions) {
        forceApprovalDecision(
          db,
          flow.northstar.id,
          flow.event.eventId,
          flow.plan.planVersionId,
          corrupt.decision,
        );
        const corruptBaseline = pointerTruthSnapshot(db, flow.northstar.id, flow.event.eventId);
        expect({ reason: corrupt.reason, ...corruptBaseline }).toEqual({
          reason: corrupt.reason,
          ...canonicalBaseline,
          approvals: canonicalBaseline.approvals.map((row) => ({
            ...(row as Record<string, unknown>),
            decision: corrupt.decision,
          })),
        });
        // Latest plan state stays independently approved, so only decision truth can reject here.
        expect(planState(db, flow.northstar.id, flow.plan.planVersionId)).toBe("approved");
        expect(getDashboardState(db, flow.northstar.id, []).approvals).toEqual([]);
        expect(listOffers(db, flow.northstar.id, flow.event.eventId)).toEqual([]);
        expect(() => deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor)).toThrow(
          /PLAN_NOT_APPROVED/,
        );

        const echoedPointer = (
          db
            .prepare(
              "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
            )
            .get(flow.northstar.id, flow.event.eventId) as { currentPlanVersionId: string | null }
        ).currentPlanVersionId;
        expect(echoedPointer).toBe(flow.plan.planVersionId);
        expect(() =>
          approvePlan(
            db,
            flow.northstar.id,
            flow.event.eventId,
            flow.candidate.planVersionId,
            echoedPointer,
            flow.actor,
          ),
        ).toThrow(/^EVENT_CURRENT_PLAN_POINTER_INVALID$/);
        // Stored pointer truth is judged ahead of the caller expectation, so a mismatched
        // expectation still fails on pointer truth rather than on expectation comparison.
        expect(() =>
          approvePlan(
            db,
            flow.northstar.id,
            flow.event.eventId,
            flow.candidate.planVersionId,
            null,
            flow.actor,
          ),
        ).toThrow(/^EVENT_CURRENT_PLAN_POINTER_INVALID$/);
        expect({ reason: corrupt.reason, ...pointerTruthSnapshot(db, flow.northstar.id, flow.event.eventId) }).toEqual({
          reason: corrupt.reason,
          ...corruptBaseline,
        });
      }

      // Only test-fixture setup restores canonical decision truth; production approval code never
      // repairs a corrupt decision in place.
      forceApprovalDecision(
        db,
        flow.northstar.id,
        flow.event.eventId,
        flow.plan.planVersionId,
        "approved",
      );
      expect(pointerTruthSnapshot(db, flow.northstar.id, flow.event.eventId)).toEqual(canonicalBaseline);
      expect(
        approvePlan(
          db,
          flow.northstar.id,
          flow.event.eventId,
          flow.candidate.planVersionId,
          flow.plan.planVersionId,
          flow.actor,
        ).created,
      ).toBe(true);
      expect(latestPlanVersion(db, flow.northstar.id, flow.event.eventId)?.id).toBe(
        flow.candidate.planVersionId,
      );
    } finally {
      closeDb(db);
    }
  });

  it("approves the valid null to v1 and v1 to v2 pointer transitions", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const account = organizer(db, northstar.id);
      const actor = { kind: "account" as const, ref: account.id };
      importFixtureEvidence(db, northstar.id, northstar.slug);
      freezeCohortSnapshot(db, northstar.id, actor);
      const event = createEventWithUnit(db, northstar.id, actor, {
        eventName: "Sympose Phase 0 Roundtable",
        unitName: "Morning circle",
        capacity: 6,
      });
      const planV1 = compilePlan(db, northstar.id, event.eventId, actor);

      const pointerNow = () =>
        (
          db
            .prepare(
              "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
            )
            .get(northstar.id, event.eventId) as { currentPlanVersionId: string | null }
        ).currentPlanVersionId;

      expect(pointerNow()).toBeNull();
      expect(approvePlan(db, northstar.id, event.eventId, planV1.planVersionId, null, actor).created).toBe(
        true,
      );
      expect(pointerNow()).toBe(planV1.planVersionId);

      createEventWithUnit(db, northstar.id, actor, {
        eventName: "Sympose Phase 0 Roundtable",
        unitName: "Afternoon circle",
        capacity: 6,
      });
      const planV2 = compilePlan(db, northstar.id, event.eventId, actor);
      expect(
        approvePlan(db, northstar.id, event.eventId, planV2.planVersionId, planV1.planVersionId, actor)
          .created,
      ).toBe(true);
      expect(pointerNow()).toBe(planV2.planVersionId);
      expect(latestPlanVersion(db, northstar.id, event.eventId)?.versionNumber).toBe(2);
    } finally {
      closeDb(db);
    }
  });

  it("fails closed when more than one explicit unapproved candidate exists", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      createEventWithUnit(db, flow.northstar.id, flow.actor, {
        eventName: "Sympose Phase 0 Roundtable",
        unitName: "Second unit",
        capacity: 6,
      });
      const firstCandidate = compilePlan(db, flow.northstar.id, flow.event.eventId, flow.actor);
      db.prepare("UPDATE events SET current_plan_version_id = NULL WHERE workspace_id = ? AND id = ?").run(
        flow.northstar.id,
        flow.event.eventId,
      );
      createEventWithUnit(db, flow.northstar.id, flow.actor, {
        eventName: "Sympose Phase 0 Roundtable",
        unitName: "Third unit",
        capacity: 6,
      });
      const secondCandidate = compilePlan(db, flow.northstar.id, flow.event.eventId, flow.actor);
      expect(secondCandidate.planVersionId).not.toBe(firstCandidate.planVersionId);
      expect(() => getDashboardState(db, flow.northstar.id, [])).toThrow(/PLAN_CANDIDATE_AMBIGUOUS/);
    } finally {
      closeDb(db);
    }
  });

  it("keeps the legacy dashboard deterministic when a workspace has multiple events", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      expect(getDashboardState(db, northstar.id, [])).toMatchObject({
        event: { event: null },
        currentPlan: null,
        candidatePlan: null,
      });
      const eventId = uuid();
      db.prepare(
        `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
         VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
      ).run(
        eventId,
        northstar.id,
        "First event",
        "2026-09-15T09:00:00.000Z",
        "2026-09-15T10:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      );
      expect(getDashboardState(db, northstar.id, []).event.event?.id).toBe(eventId);
      db.prepare(
        `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
         VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
      ).run(
        uuid(),
        northstar.id,
        "Second event",
        "2026-09-16T09:00:00.000Z",
        "2026-09-16T10:00:00.000Z",
        "2026-08-11T00:00:00.000Z",
      );
      expect(getDashboardState(db, northstar.id, []).event.event?.id).toBe(eventId);
    } finally {
      closeDb(db);
    }
  });

  it("keeps Home qualification truth bound to the exact event plan snapshot", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      const definition = db.prepare(
        `SELECT cohort_definition_id AS definitionId, definition_version AS definitionVersion
           FROM cohort_snapshots WHERE workspace_id = ? AND id = ?`,
      ).get(flow.northstar.id, flow.snapshot.snapshotId) as {
        definitionId: string;
        definitionVersion: number;
      } | undefined;
      if (!definition) throw new Error("expected plan-bound cohort definition");

      const laterSnapshotId = uuid();
      db.prepare(
        `INSERT INTO cohort_snapshots
           (id, workspace_id, cohort_definition_id, definition_version, as_of, fingerprint, member_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        laterSnapshotId,
        flow.northstar.id,
        definition.definitionId,
        definition.definitionVersion,
        "2099-06-05T12:00:00.000Z",
        fingerprintOf({ kind: "later-prospective-snapshot", id: laterSnapshotId }),
        "2099-06-05T12:00:00.000Z",
      );

      expect(
        (db.prepare(
          `SELECT id FROM cohort_snapshots WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`,
        ).get(flow.northstar.id) as { id: string }).id,
      ).toBe(laterSnapshotId);
      const dashboard = getDashboardState(db, flow.northstar.id, []);
      expect(dashboard.snapshot?.id).toBe(flow.snapshot.snapshotId);
      expect(dashboard.snapshot?.id).not.toBe(laterSnapshotId);
      expect(dashboard.snapshotPersonIds).toHaveLength(flow.snapshot.memberCount);
    } finally {
      closeDb(db);
    }
  });

  it("withholds Home qualification truth when plan and run lineage are coherently rewritten", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      const stored = db.prepare(
        `SELECT pv.content_json AS planContent, pr.input_manifest_json AS inputManifest
           FROM plan_versions pv
           JOIN plan_runs pr
             ON pr.workspace_id = pv.workspace_id AND pr.event_id = pv.event_id AND pr.id = pv.run_id
          WHERE pv.workspace_id = ? AND pv.event_id = ? AND pv.id = ?`,
      ).get(flow.northstar.id, flow.event.eventId, flow.plan.planVersionId) as {
        planContent: string;
        inputManifest: string;
      } | undefined;
      if (!stored) throw new Error("expected exact plan/run lineage");
      const input = JSON.parse(stored.inputManifest) as {
        schema: string;
        inputManifest: { event: { name: string } };
      };
      input.inputManifest.event.name = "Forged plan-run event";
      const forgedInputFingerprint = fingerprintOf(input.inputManifest);
      const content = JSON.parse(stored.planContent) as Record<string, unknown>;
      content.inputFingerprint = forgedInputFingerprint;

      db.exec(
        "DROP TRIGGER IF EXISTS trg_plan_runs_immutable; DROP TRIGGER IF EXISTS trg_plan_versions_immutable;",
      );
      try {
        db.prepare(
          "UPDATE plan_runs SET input_manifest_json = ?, input_fingerprint = ? WHERE workspace_id = ? AND id = ?",
        ).run(JSON.stringify(input), forgedInputFingerprint, flow.northstar.id, flow.plan.runId);
        db.prepare(
          "UPDATE plan_versions SET content_json = ?, fingerprint = ? WHERE workspace_id = ? AND id = ?",
        ).run(
          JSON.stringify(content),
          fingerprintOf(content),
          flow.northstar.id,
          flow.plan.planVersionId,
        );

        const dashboard = getDashboardState(db, flow.northstar.id, []);
        expect(dashboard.snapshot).toBeNull();
        expect(dashboard.snapshotPersonIds).toEqual([]);
      } finally {
        db.exec(DDL);
      }
    } finally {
      closeDb(db);
    }
  });

  it("rejects commitment reads and responses after exact plan approval evidence is corrupted", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const flow = runThroughApproval(db);
      deliverOffers(db, flow.northstar.id, flow.event.eventId, flow.actor);
      const offer = nextPendingOffer(db, flow.northstar.id, flow.event.eventId);
      if (!offer) throw new Error("expected pending offer");
      forceApprovalDecision(
        db,
        flow.northstar.id,
        flow.event.eventId,
        flow.plan.planVersionId,
        "rejected",
      );
      const responsesBefore = (db.prepare(
        "SELECT COUNT(*) AS count FROM commitment_responses WHERE workspace_id = ?",
      ).get(flow.northstar.id) as { count: number }).count;

      expect(listOffers(db, flow.northstar.id, flow.event.eventId)).toEqual([]);
      expect(nextPendingOffer(db, flow.northstar.id, flow.event.eventId)).toBeNull();
      expect(() => respondToOfferCommand(db, flow.northstar.id, flow.event.eventId, {
        offerId: offer.id,
        response: "accepted",
        commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
      })).toThrow(/OFFER_NOT_CURRENT/);
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM commitment_responses WHERE workspace_id = ?",
      ).get(flow.northstar.id) as { count: number }).count).toBe(responsesBefore);
    } finally {
      closeDb(db);
    }
  });

  it("deduplicates simulated delivery receipts without storing recipient values", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const adapter = new SimulatedDeliveryAdapter(db);
      const intent = {
        workspaceId: northstar.id,
        eventId: "synthetic-event",
        personId: "synthetic-person-a",
        offerId: "synthetic-offer",
        communicationRunId: "synthetic-run",
        purpose: "commitment-offer",
        channel: "in-app-simulation",
        payloadFingerprint: "a".repeat(64),
      };
      const first = adapter.deliverOffer(intent);
      const replay = adapter.deliverOffer({ ...intent });
      expect(replay).toEqual(first);
      expect(() =>
        adapter.deliverOffer({ ...intent, personId: "synthetic-person-b" }),
      ).toThrow(/DELIVERY_COMMAND_CONFLICT/);
      expect(() =>
        adapter.deliverOffer({ ...intent, eventId: "other-event" }),
      ).toThrow(/DELIVERY_COMMAND_CONFLICT/);
      expect(() =>
        adapter.deliverOffer({ ...intent, communicationRunId: "other-run" }),
      ).toThrow(/DELIVERY_COMMAND_CONFLICT/);
      expect(() =>
        adapter.deliverOffer({ ...intent, channel: "email" }),
      ).toThrow(/DELIVERY_COMMAND_CONFLICT/);
      expect(() =>
        adapter.deliverOffer({ ...intent, payloadFingerprint: "b".repeat(64) }),
      ).toThrow(/DELIVERY_COMMAND_CONFLICT/);

      const rows = db
        .prepare(
          `SELECT details_json AS details, created_at AS createdAt
           FROM audit_events
           WHERE workspace_id = ? AND action = 'commitment.offer.delivered' AND target_id = ?`,
        )
        .all(northstar.id, "synthetic-offer") as { details: string; createdAt: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].createdAt).toBe(first.deliveredAt);
      expect(rows[0].details).not.toContain("@");
      expect(JSON.parse(rows[0].details)).toMatchObject({
        deliveryId: first.deliveryId,
        operation: "commitment.offer.delivery",
        schema: "delivery-receipt/v1",
        serviceIdentity: adapter.kind,
        workspaceId: northstar.id,
        eventId: intent.eventId,
        personId: intent.personId,
        offerId: intent.offerId,
        communicationRunId: intent.communicationRunId,
        purpose: intent.purpose,
        channel: intent.channel,
        payloadFingerprint: intent.payloadFingerprint,
        intentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        completedAt: first.deliveredAt,
      });
    } finally {
      closeDb(db);
    }
  });

  it("authorizes Phase 0 capability commands and records only a safe denial audit", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const organizerAccount = organizer(db, northstar.id);
      const organizerSession = createSession(db, organizerAccount.id, northstar.id).session;
      expect(() => requireCapability(db, organizerSession, "phase0.pipeline.manage")).not.toThrow();

      const viewerId = uuid();
      db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, 'read_only', ?)`,
      ).run(viewerId, northstar.id, "viewer@northstar.example", "Read Only", new Date().toISOString());
      const viewerSession = createSession(db, viewerId, northstar.id).session;
      const domainRowsBefore = {
        sources: (db.prepare("SELECT COUNT(*) AS n FROM source_records").get() as { n: number }).n,
        events: (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
        plans: (db.prepare("SELECT COUNT(*) AS n FROM plan_versions").get() as { n: number }).n,
      };
      expect(hasCapability(viewerSession, "phase0.pipeline.manage")).toBe(false);
      expect(() => requireCapability(db, viewerSession, "phase0.pipeline.manage")).toThrowError(
        expect.objectContaining({ code: "CAPABILITY_DENIED" }),
      );
      expect({
        sources: (db.prepare("SELECT COUNT(*) AS n FROM source_records").get() as { n: number }).n,
        events: (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
        plans: (db.prepare("SELECT COUNT(*) AS n FROM plan_versions").get() as { n: number }).n,
      }).toEqual(domainRowsBefore);
      const denial = db
        .prepare(
          `SELECT action, target_type AS targetType, target_id AS targetId, details_json AS details
           FROM audit_events WHERE workspace_id = ? AND action = 'security.access.denied'`,
        )
        .get(northstar.id) as { action: string; targetType: string; targetId: string; details: string };
      expect(denial).toMatchObject({
        action: "security.access.denied",
        targetType: "capability",
        targetId: "phase0.pipeline.manage",
      });
      expect(JSON.parse(denial.details)).toEqual({ code: "CAPABILITY_DENIED", role: "read_only" });
    } finally {
      closeDb(db);
    }
  });

  it("keeps login choices and capability checks limited to organizer-capable roles", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const choices = listLoginChoices(db);
      expect(choices).toHaveLength(1);
      expect(choices[0]).toMatchObject({ workspaceSlug: "acme", role: "organizer" });
      expect(roleHasCapability("reviewer", "phase0.pipeline.manage")).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("marks unmoderated solutions infeasible and independently rejects malformed compiler output", () => {
    const input: CompilerInput = {
      schema: "compiler-input/v1",
      inputManifest: {
        event: {
          id: "event-1",
          name: "Validator fixture",
          timezone: "UTC",
          startsAt: "2026-09-15T09:00:00.000Z",
          endsAt: "2026-09-15T10:00:00.000Z",
        },
        snapshot: { id: "snapshot-1", fingerprint: "a".repeat(64), asOf: "2026-06-01T00:00:00.000Z" },
        programUnits: [{ id: "unit-1", name: "Unit", startsAt: "2026-09-15T09:00:00.000Z", endsAt: "2026-09-15T10:00:00.000Z", capacity: 2 }],
        members: [
          { personId: "person-1", email: "one@example.test", fullName: "One", organization: "Org A", moderatorEligible: false, rank: 1 },
          { personId: "person-2", email: "two@example.test", fullName: "Two", organization: "Org B", moderatorEligible: false, rank: 2 },
        ],
        constraints: [],
      },
    };

    const infeasible = compileRoundtables(input);
    expect(infeasible.status).toBe("INFEASIBLE");
    expect(validateCompilerOutput(input, infeasible)).toEqual([]);

    const falselyFeasible = { ...infeasible, status: "FEASIBLE" as const };
    expect(validateCompilerOutput(input, falselyFeasible)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("requires exactly one moderator"),
        expect.stringContaining("must be marked INFEASIBLE"),
      ]),
    );

    const eligibleInput: CompilerInput = {
      ...input,
      inputManifest: {
        ...input.inputManifest,
        members: input.inputManifest.members.map((member, index) => ({
          ...member,
          moderatorEligible: index === 0,
        })),
      },
    };
    const valid = compileRoundtables(eligibleInput);
    const duplicate = {
      ...valid,
      assignments: [...valid.assignments, { ...valid.assignments[0], assignmentType: "participant" as const }],
    };
    expect(validateCompilerOutput(eligibleInput, duplicate)).toEqual(
      expect.arrayContaining([expect.stringContaining("at most one is allowed")]),
    );
  });

  it("upgrades empty schema v1 databases but fails closed when v1 has sealed releases", () => {
    mkdirSync(resolve(".tmp/unit"), { recursive: true });
    const emptyPath = resolve(".tmp/unit/schema-v1-empty.db");
    const releasePath = resolve(".tmp/unit/schema-v1-with-release.db");
    removeSqliteFiles(emptyPath);
    removeSqliteFiles(releasePath);
    let db: Db | null = null;
    try {
      db = createLegacyDatabase({ path: emptyPath, schemaVersion: 1 });
      db.close();
      db = null;
      db = openDb({ path: emptyPath, seed: false });
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      });
      closeDb(db);
      db = null;

      db = createLegacyDatabase({ path: releasePath, schemaVersion: 1 });
      insertWorkspaceMarker(db, {
        id: "release-workspace",
        slug: "release",
        name: "Release workspace",
        createdAt: "2026-08-10T00:00:00.000Z",
      });
      db.prepare(
        `INSERT INTO events
           (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
         VALUES ('release-event', 'release-workspace', 'Release event', 'UTC', ?, ?, ?)`,
      ).run("2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO plan_runs
           (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json,
            compiler, compiler_version, created_at)
         VALUES ('release-run', 'release-workspace', 'release-event', 'SUCCEEDED', 'input', '{}', 'synthetic', '1', ?)`,
      ).run("2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO plan_versions
           (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
         VALUES ('release-plan', 'release-workspace', 'release-event', 'release-run', 1, 'plan', '{}', ?)`,
      ).run("2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO publication_releases
           (id, workspace_id, event_id, plan_version_id, audience_policy_version,
            commitment_watermark, fingerprint, content_json, sealed_at)
         VALUES ('release', 'release-workspace', 'release-event', 'release-plan', 1, 1, 'release', '{}', ?)`,
      ).run("2026-08-10T00:00:00.000Z");
      db.close();
      db = null;

      expect(() => openDb({ path: releasePath })).toThrow(
        /schema v1 contains sealed publication releases.*pnpm db:reset/,
      );
      expect(() =>
        parseSealedReleaseContent(JSON.stringify({ schema: "publication-release/v1" })),
      ).toThrowError(expect.objectContaining({ code: "RELEASE_SCHEMA_UNSUPPORTED" }));
    } finally {
      if (db) {
        closeDb(db);
      }
      removeSqliteFiles(emptyPath);
      removeSqliteFiles(releasePath);
    }
  });
});
