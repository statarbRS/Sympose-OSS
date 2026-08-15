import { describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "../../src/server/auth";
import { canonicalJson, fingerprintOf, nowIso } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  createCall,
  createDraftSubmission,
  createFormDefinition,
  saveDraftRevision,
  saveSubmittedAmendment,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import {
  OrganizerReviewServiceError,
  OrganizerSealingFatalError,
  createOrganizerReviewRound,
  createOrganizerReviewRubric,
  distributeOrganizerReviewAssignments,
  exportOrganizerReview,
  recordOrganizerReviewReminders,
  recuseOrganizerReviewAssignment,
  readOrganizerReviewSurface,
  setOrganizerReviewRoundSchedule,
  setOrganizerReviewRoundState,
} from "../../src/server/services/cfp-review/organizer";
import {
  ReviewerServiceError,
  declareOwnReviewConflict,
  listOwnReviewAssignments,
  readOwnReviewAssignment,
} from "../../src/server/services/cfp-review/reviewer";

const EVENT_ID = "organizer-workflow-event";
const OPEN_AT = "2026-08-01T09:00:00.000Z";
const CLOSE_AT = "2026-09-15T09:00:00.000Z";
const ROUND_CLOSE_AT = "2026-09-10T09:00:00.000Z";

type Fixture = Readonly<{
  db: Db;
  organizerSession: SessionInfo;
  workspaceId: string;
  callId: string;
  submissionIds: readonly string[];
  reviewerIds: readonly string[];
}>;

function expectCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(OrganizerReviewServiceError);
  expect((thrown as OrganizerReviewServiceError).code).toBe(code);
}

function expectReviewerCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReviewerServiceError);
  expect((thrown as ReviewerServiceError).code).toBe(code);
}

function setup(): Fixture {
  const db = openDb({ path: ":memory:" });
  const workspace = db
    .prepare("SELECT id FROM workspaces WHERE slug = 'northstar'")
    .get() as { id: string };
  const organizer = db
    .prepare(
      `SELECT id FROM accounts
       WHERE workspace_id = ? AND role = 'organizer'
       ORDER BY id LIMIT 1`,
    )
    .get(workspace.id) as { id: string };
  const reviewerIds = ["workflow-reviewer-a", "workflow-reviewer-b", "workflow-reviewer-c"];
  reviewerIds.forEach((id, index) => {
    db.prepare(
      `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
       VALUES (?, ?, ?, ?, 'reviewer', ?)`,
    ).run(
      id,
      workspace.id,
      `${id}@synthetic.example`,
      `Workflow reviewer ${String.fromCharCode(65 + index)}`,
      "2026-08-01T00:00:00.000Z",
    );
  });
  const organizerSession = createSession(db, organizer.id, workspace.id).session;
  db.prepare(
    `INSERT INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, 'Organizer workflow event', 'UTC', ?, ?, 'planning', ?)`,
  ).run(EVENT_ID, workspace.id, OPEN_AT, CLOSE_AT, "2026-07-01T00:00:00.000Z");

  const context = { workspaceId: workspace.id, accountId: organizer.id };
  const definition = createFormDefinition(db, context, { name: "Workflow form" });
  const form = sealFormVersion(db, context, {
    formDefinitionId: definition.id,
    fields: [
      {
        id: "proposal",
        type: "longText",
        label: "Proposal",
        required: true,
        defaultVisibility: "visible",
      },
    ],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = createCall(db, context, {
    eventId: EVENT_ID,
    name: "Workflow call",
    slug: "workflow-call",
    formVersionId: form.id,
    state: "OPEN",
    timezone: "UTC",
    opensAt: OPEN_AT,
    closesAt: CLOSE_AT,
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

  const submissionIds: string[] = [];
  for (const [index, suffix] of ["one", "two"].entries()) {
    const personId = `workflow-person-${suffix}`;
    const verificationId = `workflow-verification-${suffix}`;
    const applicantSessionId = `workflow-applicant-session-${suffix}`;
    db.prepare(
      `INSERT INTO people
         (id, workspace_id, canonical_email, full_name, organization, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      personId,
      workspace.id,
      `${suffix}@applicant.synthetic.example`,
      `Workflow Applicant ${index + 1}`,
      index === 0 ? "Northstar Labs" : null,
      "2026-08-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO cfp_email_verifications
         (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      verificationId,
      workspace.id,
      call.id,
      `${suffix}@applicant.synthetic.example`,
      `${String(index + 1).repeat(64)}`,
      "2099-09-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO cfp_email_verification_consumptions
         (id, workspace_id, verification_id, person_id, consumed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      `workflow-consumption-${suffix}`,
      workspace.id,
      verificationId,
      personId,
      "2026-08-01T00:00:01.000Z",
    );
    db.prepare(
      `INSERT INTO cfp_applicant_sessions
         (id, workspace_id, call_id, person_id, verification_id,
          token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      applicantSessionId,
      workspace.id,
      call.id,
      personId,
      verificationId,
      `${String(index + 3).repeat(64)}`,
      "2026-08-01T00:00:02.000Z",
      "2099-09-01T00:00:00.000Z",
    );
    const submission = createDraftSubmission(
      db,
      { workspaceId: workspace.id, sessionId: applicantSessionId },
      { callId: call.id },
    );
    const saved = saveDraftRevision(
      db,
      { workspaceId: workspace.id, sessionId: applicantSessionId },
      {
        submissionId: submission.id,
        expectedCurrentRevisionId: null,
        historicalAnswers: [{ fieldId: "proposal", value: `Proposal ${index + 1}` }],
      },
    );
    db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(submission.id);
    expect(saved.revisionId).toBeTruthy();
    submissionIds.push(submission.id);
  }

  return Object.freeze({
    db,
    organizerSession,
    workspaceId: workspace.id,
    callId: call.id,
    submissionIds: Object.freeze(submissionIds),
    reviewerIds: Object.freeze(reviewerIds),
  });
}

function createRoundAndRubric(fixture: Fixture): { readonly roundId: string; readonly rubricVersionId: string } {
  const round = createOrganizerReviewRound(fixture.db, fixture.organizerSession, {
    workspaceSlug: "northstar",
    eventId: EVENT_ID,
    callId: fixture.callId,
    name: "Workflow screening",
    opensAt: OPEN_AT,
    closesAt: ROUND_CLOSE_AT,
    idempotencyKey: "workflow-round-create",
  });
  const rubric = createOrganizerReviewRubric(fixture.db, fixture.organizerSession, {
    workspaceSlug: "northstar",
    roundId: round.roundId,
    fields: [
      {
        id: "quality",
        label: "Proposal quality",
        guidance: "Assess the proposal as presented.",
        kind: "numeric",
        required: true,
        weight: 2,
        minimum: 0,
        maximum: 100,
        step: 0.001,
      },
      {
        id: "recommendation",
        label: "Independent recommendation",
        kind: "dropdown",
        required: true,
        weight: 1,
        recommendation: true,
        choices: [
          { value: "ADVANCE", label: "Advance" },
          { value: "HOLD", label: "Hold" },
          { value: "DO_NOT_ADVANCE", label: "Do not advance" },
        ],
      },
      {
        id: "notes",
        label: "Evidence notes",
        kind: "text",
        required: false,
        weight: 1,
        maxLength: 500,
      },
    ],
  });
  return Object.freeze({ roundId: round.roundId, rubricVersionId: rubric.rubricVersionId });
}

function blindArtifactDecisions(fixture: Fixture) {
  return fixture.submissionIds.map((submissionId, index) => {
    const row = fixture.db
      .prepare("SELECT current_revision_id FROM submissions WHERE id = ?")
      .get(submissionId) as { current_revision_id: string };
    return {
      submissionId,
      submissionRevisionId: row.current_revision_id,
      decisions: [
        {
          sourceFieldId: "proposal",
          action: "INCLUDE_REDACTED" as const,
          reviewLabel: "Blind proposal",
          redactedValue: `A blinded proposal ${index + 1}`,
        },
      ],
    };
  });
}

function amendSubmittedProposal(
  fixture: Fixture,
  submissionId: string,
  proposal: string,
): Readonly<{ previousRevisionId: string; currentRevisionId: string }> {
  const row = fixture.db.prepare(
    `SELECT submission.current_revision_id, applicant_session.id AS session_id
     FROM submissions submission
     JOIN cfp_applicant_sessions applicant_session
       ON applicant_session.workspace_id = submission.workspace_id
      AND applicant_session.call_id = submission.call_id
      AND applicant_session.person_id = submission.owner_person_id
     WHERE submission.workspace_id = ? AND submission.id = ?`,
  ).get(fixture.workspaceId, submissionId) as {
    current_revision_id: string;
    session_id: string;
  };
  const amended = saveSubmittedAmendment(
    fixture.db,
    { workspaceId: fixture.workspaceId, sessionId: row.session_id },
    {
      submissionId,
      expectedCurrentRevisionId: row.current_revision_id,
      historicalAnswers: [{ fieldId: "proposal", value: proposal }],
    },
  );
  return Object.freeze({
    previousRevisionId: row.current_revision_id,
    currentRevisionId: amended.revisionId,
  });
}

function distributionInput(
  fixture: Fixture,
  roundId: string,
  options: Readonly<{
    readonly idempotencyKey: string;
    readonly reviewerAccountIds?: readonly string[];
    readonly submissionIds?: readonly string[];
    readonly reviewsPerSubmission?: number;
    readonly maxAssignmentsPerReviewer?: number;
  }>,
): Parameters<typeof distributeOrganizerReviewAssignments>[2] {
  const submissionIds = options.submissionIds ?? fixture.submissionIds;
  return {
    workspaceSlug: "northstar",
    roundId,
    reviewerAccountIds: options.reviewerAccountIds ?? fixture.reviewerIds,
    submissionIds,
    reviewsPerSubmission: options.reviewsPerSubmission ?? 1,
    maxAssignmentsPerReviewer: options.maxAssignmentsPerReviewer ?? 1,
    strategy: "balanced",
    idempotencyKey: options.idempotencyKey,
    blindArtifactDecisions: blindArtifactDecisions(fixture).filter((entry) =>
      submissionIds.includes(entry.submissionId),
    ),
  };
}

function distributionCounts(
  db: Db,
  workspaceId: string,
  roundId: string,
): Readonly<{ assignments: number; artifacts: number; evidence: number }> {
  return Object.freeze({
    assignments: (db
      .prepare("SELECT COUNT(*) AS count FROM review_assignments WHERE workspace_id = ? AND round_id = ?")
      .get(workspaceId, roundId) as { count: number }).count,
    artifacts: (db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM review_blind_artifacts artifact
         JOIN review_assignments assignment
           ON assignment.workspace_id = artifact.workspace_id
          AND assignment.id = artifact.assignment_id
         WHERE assignment.workspace_id = ? AND assignment.round_id = ?`,
      )
      .get(workspaceId, roundId) as { count: number }).count,
    evidence: (db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_events
         WHERE workspace_id = ?
           AND action = 'cfp.review.local-evidence'
           AND target_type = 'review_round'
           AND target_id = ?`,
      )
      .get(workspaceId, roundId) as { count: number }).count,
  });
}

function recusalSideEffectCounts(
  db: Db,
  workspaceId: string,
  roundId: string,
): Readonly<{
  assignments: number;
  assignmentStates: number;
  artifacts: number;
  localEvidence: number;
  recusalAudits: number;
  recusalReceipts: number;
}> {
  return Object.freeze({
    assignments: (db.prepare(
      "SELECT COUNT(*) AS count FROM review_assignments WHERE workspace_id = ? AND round_id = ?",
    ).get(workspaceId, roundId) as { count: number }).count,
    assignmentStates: (db.prepare(
      `SELECT COUNT(*) AS count
       FROM review_assignment_states state
       JOIN review_assignments assignment
         ON assignment.workspace_id = state.workspace_id
        AND assignment.id = state.assignment_id
       WHERE assignment.workspace_id = ? AND assignment.round_id = ?`,
    ).get(workspaceId, roundId) as { count: number }).count,
    artifacts: (db.prepare(
      `SELECT COUNT(*) AS count
       FROM review_blind_artifacts artifact
       JOIN review_assignments assignment
         ON assignment.workspace_id = artifact.workspace_id
        AND assignment.id = artifact.assignment_id
       WHERE assignment.workspace_id = ? AND assignment.round_id = ?`,
    ).get(workspaceId, roundId) as { count: number }).count,
    localEvidence: (db.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE workspace_id = ? AND target_type = 'review_round' AND target_id = ?
         AND action = 'cfp.review.local-evidence'`,
    ).get(workspaceId, roundId) as { count: number }).count,
    recusalAudits: (db.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE workspace_id = ? AND action = 'cfp.review.assignment.recused'`,
    ).get(workspaceId) as { count: number }).count,
    recusalReceipts: (db.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE workspace_id = ? AND action = 'cfp.review.assignment.recusal-receipt'`,
    ).get(workspaceId) as { count: number }).count,
  });
}

function insertLegacyReusableAssignment(
  fixture: Fixture,
  roundId: string,
  rubricVersionId: string,
  submissionId = fixture.submissionIds[0]!,
  reviewerAccountId = fixture.reviewerIds[0]!,
): Readonly<{ assignmentId: string; submissionRevisionId: string }> {
  const revision = fixture.db
    .prepare("SELECT current_revision_id FROM submissions WHERE workspace_id = ? AND id = ?")
    .get(fixture.workspaceId, submissionId) as { current_revision_id: string };
  const assignmentId = `legacy-reusable-${roundId}-${reviewerAccountId}`;
  fixture.db.prepare(
    `INSERT INTO review_assignments
       (id, workspace_id, round_id, rubric_version_id, submission_id,
        submission_revision_id, reviewer_account_id, assigned_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    assignmentId,
    fixture.workspaceId,
    roundId,
    rubricVersionId,
    submissionId,
    revision.current_revision_id,
    reviewerAccountId,
    fixture.organizerSession.accountId,
    nowIso(),
  );
  return Object.freeze({
    assignmentId,
    submissionRevisionId: revision.current_revision_id,
  });
}

function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}

function withAssignmentStateReadFailure(db: Db): Db {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (/review_(?:assignment_states|assignments)/u.test(sql)) {
            throw new Error("synthetic later assignment state read");
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withCommitAmbiguity(db: Db): Db {
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          target.exec(sql);
          if (sql.trim() === "COMMIT") {
            throw new Error("synthetic commit ambiguity");
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withRollbackFailure(db: Db): Db {
  let armed = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (armed && sql.trim() === "ROLLBACK") {
            armed = false;
            throw new Error("synthetic rollback failure");
          }
          target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

describe("organizer review rubric, distribution, and projections", () => {
  it("opens a distributed round with an immutable replay-safe state event", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const input = {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
        expectedStateSequenceNumber: 1,
        state: "OPEN" as const,
        reason: "Open the reviewer queue after assignment preparation.",
        idempotencyKey: "workflow-open-round",
      };
      const opened = setOrganizerReviewRoundState(fixture.db, fixture.organizerSession, input);
      expect(opened).toMatchObject({ roundId, state: "OPEN", sequenceNumber: 2, replayed: false });
      expect(setOrganizerReviewRoundState(fixture.db, fixture.organizerSession, input)).toMatchObject({
        ...opened,
        replayed: true,
      });
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM review_round_states WHERE workspace_id = ? AND round_id = ?",
      ).get(fixture.workspaceId, roundId) as { count: number }).count).toBe(2);
      let thrown: unknown;
      try {
        setOrganizerReviewRoundState(fixture.db, fixture.organizerSession, {
          ...input,
          state: "CANCELLED",
          reason: "Conflicting stale transition.",
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OrganizerReviewServiceError);
      expect((thrown as OrganizerReviewServiceError).code).toBe("ROUND_STATE_STALE");
    } finally {
      closeDb(fixture.db);
    }
  });

  it("seals weighted rubric fields and projects the same tenant-safe document", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const replay = createOrganizerReviewRubric(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        roundId,
        fields: [
          {
            id: "quality",
            label: "Proposal quality",
            guidance: "Assess the proposal as presented.",
            kind: "numeric",
            required: true,
            weight: 2,
            minimum: 0,
            maximum: 100,
            step: 0.001,
          },
          {
            id: "recommendation",
            label: "Independent recommendation",
            kind: "dropdown",
            required: true,
            weight: 1,
            recommendation: true,
            choices: [
              { value: "ADVANCE", label: "Advance" },
              { value: "HOLD", label: "Hold" },
              { value: "DO_NOT_ADVANCE", label: "Do not advance" },
            ],
          },
          {
            id: "notes",
            label: "Evidence notes",
            kind: "text",
            required: false,
            weight: 1,
            maxLength: 500,
          },
        ],
      });
      expect(replay.replayed).toBe(true);
      const surface = readOrganizerReviewSurface(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
      });
      expect(surface.rounds[0]?.rubric?.fields.map((field) => [field.id, field.kind, field.weight])).toEqual([
        ["quality", "numeric", 2],
        ["recommendation", "dropdown", 1],
        ["notes", "text", 1],
      ]);
      expect(surface.rounds[0]?.rubric?.semanticsId).toBeNull();
      expect(surface.rounds[0]?.rubric?.fields[0]?.minimum).toBe(0);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("assigns deterministically with caps, records local reminders, ranks submitted evidence, recuses, and exports", () => {
    const fixture = setup();
    try {
      const { roundId, rubricVersionId } = createRoundAndRubric(fixture);
      fixture.db.prepare(
        "UPDATE calls SET timezone = 'America/Los_Angeles', opens_at = NULL, closes_at = NULL WHERE id = ?",
      ).run(fixture.callId);
      const first = distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        roundId,
        reviewerAccountIds: fixture.reviewerIds,
        submissionIds: fixture.submissionIds,
        reviewsPerSubmission: 2,
        maxAssignmentsPerReviewer: 2,
        strategy: "balanced",
        idempotencyKey: "workflow-distribution",
        blindArtifactDecisions: blindArtifactDecisions(fixture),
        pools: [
          {
            id: "workflow-pool",
            reviewerAccountIds: fixture.reviewerIds,
            maxAssignments: 4,
          },
        ],
      });
      expect(first.createdAssignmentIds).toHaveLength(4);
      expect(first.blindArtifactIds).toHaveLength(4);
      expect(first.blindArtifactIds).toHaveLength(first.plan.assignments.length);
      expect(first.blindArtifactPendingAssignmentIds).toEqual([]);
      expect(new Set(first.blindArtifactIds).size).toBe(4);
      const issuedArtifacts = fixture.db.prepare(
        `SELECT assignment_id, artifact_json
         FROM review_blind_artifacts
         WHERE workspace_id = ? AND rubric_version_id = ?
         ORDER BY assignment_id ASC`,
      ).all(fixture.workspaceId, rubricVersionId) as { assignment_id: string; artifact_json: string }[];
      expect(issuedArtifacts).toHaveLength(4);
      expect(new Set(issuedArtifacts.map((row) => row.assignment_id)).size).toBe(4);
      for (const row of issuedArtifacts) {
        expect(row.artifact_json).not.toContain("CFP-11");
        expect(row.artifact_json).not.toContain("@synthetic.example");
      }
      expect(first.plan.skippedSubmissionIds).toEqual([]);
      expect(first.localEvidence.kind).toBe("DISTRIBUTION_PLANNED");
      const reminderEvidence = fixture.db.prepare(
        `SELECT details_json FROM audit_events
         WHERE workspace_id = ? AND action = 'cfp.review.local-evidence'
           AND json_extract(details_json, '$.kind') = 'REMINDER_PLANNED'
         ORDER BY rowid`,
      ).all(fixture.workspaceId) as { details_json: string }[];
      expect(reminderEvidence).toHaveLength(4);
      for (const row of reminderEvidence) {
        expect(JSON.parse(row.details_json)).toMatchObject({
          payload: { dueAt: ROUND_CLOSE_AT, scheduleVersion: 2, timezone: "UTC" },
        });
      }
      expect(recordOrganizerReviewReminders(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
      })).toMatchObject({ replayed: true, recordedAssignmentIds: [] });
      const replay = distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        roundId,
        reviewerAccountIds: fixture.reviewerIds,
        submissionIds: fixture.submissionIds,
        reviewsPerSubmission: 2,
        maxAssignmentsPerReviewer: 2,
        strategy: "balanced",
        idempotencyKey: "workflow-distribution",
        blindArtifactDecisions: blindArtifactDecisions(fixture),
        pools: [
          {
            id: "workflow-pool",
            reviewerAccountIds: fixture.reviewerIds,
            maxAssignments: 4,
          },
        ],
      });
      expect(replay.replayed).toBe(true);
      expect(replay.createdAssignmentIds).toEqual([]);
      expect(replay.existingAssignmentIds).toHaveLength(4);
      expect(replay.blindArtifactIds).toEqual(first.blindArtifactIds);
      expect(
        (fixture.db.prepare(
          "SELECT COUNT(*) AS count FROM review_blind_artifacts WHERE workspace_id = ? AND rubric_version_id = ?",
        ).get(fixture.workspaceId, rubricVersionId) as { count: number }).count,
      ).toBe(4);
      const secondKeyReplay = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        {
          workspaceSlug: "northstar",
          roundId,
          reviewerAccountIds: fixture.reviewerIds,
          submissionIds: fixture.submissionIds,
          reviewsPerSubmission: 2,
          maxAssignmentsPerReviewer: 2,
          strategy: "balanced",
          idempotencyKey: "workflow-distribution-second-key",
          blindArtifactDecisions: blindArtifactDecisions(fixture),
          pools: [
            {
              id: "workflow-pool",
              reviewerAccountIds: fixture.reviewerIds,
              maxAssignments: 4,
            },
          ],
        },
      );
      expect(secondKeyReplay.replayed).toBe(true);
      expect(secondKeyReplay.blindArtifactIds).toHaveLength(first.blindArtifactIds.length);
      expect(
        fixture.db
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action = 'cfp.review.local-evidence' AND json_extract(details_json, '$.kind') = 'DISTRIBUTION_PLANNED' AND json_extract(details_json, '$.payload.idempotencyKey') = ?",
          )
          .get(fixture.workspaceId, "workflow-distribution-second-key") as { count: number },
      ).toEqual({ count: 1 });
      const currentSchedule = fixture.db
        .prepare(
          `SELECT version_number, opens_at, closes_at
           FROM review_round_schedule_versions
           WHERE workspace_id = ? AND round_id = ?
           ORDER BY version_number DESC LIMIT 1`,
        )
        .get(fixture.workspaceId, roundId) as {
          version_number: number;
          opens_at: string;
          closes_at: string;
        };
      const updatedSchedule = setOrganizerReviewRoundSchedule(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
        expectedScheduleVersion: currentSchedule.version_number,
        opensAt: currentSchedule.opens_at,
        closesAt: currentSchedule.closes_at,
        idempotencyKey: "workflow-schedule-change",
      });
      expect(updatedSchedule.scheduleVersion).toBe(currentSchedule.version_number + 1);
      expectCode(
        () => distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, {
          workspaceSlug: "northstar",
          roundId,
          reviewerAccountIds: fixture.reviewerIds,
          submissionIds: fixture.submissionIds,
          reviewsPerSubmission: 2,
          maxAssignmentsPerReviewer: 2,
          strategy: "round_robin",
          idempotencyKey: "workflow-distribution",
          blindArtifactDecisions: blindArtifactDecisions(fixture),
          pools: [
            {
              id: "workflow-pool",
              reviewerAccountIds: fixture.reviewerIds,
              maxAssignments: 4,
            },
          ],
        }),
        "DISTRIBUTION_IDEMPOTENCY_CONFLICT",
      );

      const beforeReview = readOrganizerReviewSurface(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
      });
      const submittedAssignment = beforeReview.rounds[0]!.assignments[0]!;
      const submittedAt = nowIso();
      const evaluation = {
        schema: "cfp-review-evaluation/v1",
        assignmentId: submittedAssignment.id,
        rubricVersionId,
        submissionRevisionId: submittedAssignment.submissionRevisionId,
        reviewRevisionNumber: 1,
        responses: [
          { criterionId: "quality", value: 50.001 },
          { criterionId: "recommendation", value: "ADVANCE" },
          { criterionId: "notes", value: "Evidence supports the proposal." },
        ],
      };
      fixture.db.prepare(
        `INSERT INTO review_revisions
           (id, workspace_id, assignment_id, round_id, rubric_version_id,
            submission_id, submission_revision_id, revision_number,
            evaluation_schema, evaluation_json, fingerprint_algorithm,
            fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'cfp-review-evaluation/v1', ?,
                 'sha256-canonical-json-v1', ?, ?)`,
      ).run(
        "workflow-review-revision",
        fixture.workspaceId,
        submittedAssignment.id,
        roundId,
        rubricVersionId,
        submittedAssignment.submissionId,
        submittedAssignment.submissionRevisionId,
        canonicalJson(evaluation),
        fingerprintOf(evaluation),
        submittedAt,
      );
      fixture.db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number,
            actor_account_id, reason, created_at)
         VALUES (?, ?, ?, 'SUBMITTED', 2, ?, NULL, ?)`,
      ).run(
        "workflow-submitted-state",
        fixture.workspaceId,
        submittedAssignment.id,
        submittedAssignment.reviewerAccountId,
        submittedAt,
      );

      const secondScoringAssignment = beforeReview.rounds[0]!.assignments.find(
        (assignment) =>
          assignment.submissionId !== submittedAssignment.submissionId &&
          assignment.assignmentState === "ASSIGNED",
      )!;
      const lowerEvaluation = {
        schema: "cfp-review-evaluation/v1",
        assignmentId: secondScoringAssignment.id,
        rubricVersionId,
        submissionRevisionId: secondScoringAssignment.submissionRevisionId,
        reviewRevisionNumber: 1,
        responses: [
          { criterionId: "quality", value: 50.002 },
          { criterionId: "recommendation", value: "HOLD" },
          { criterionId: "notes", value: "Lower weighted evidence." },
        ],
      };
      fixture.db.prepare(
        `INSERT INTO review_revisions
           (id, workspace_id, assignment_id, round_id, rubric_version_id,
            submission_id, submission_revision_id, revision_number,
            evaluation_schema, evaluation_json, fingerprint_algorithm,
            fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'cfp-review-evaluation/v1', ?,
                 'sha256-canonical-json-v1', ?, ?)`,
      ).run(
        "workflow-lower-review-revision",
        fixture.workspaceId,
        secondScoringAssignment.id,
        roundId,
        rubricVersionId,
        secondScoringAssignment.submissionId,
        secondScoringAssignment.submissionRevisionId,
        canonicalJson(lowerEvaluation),
        fingerprintOf(lowerEvaluation),
        submittedAt,
      );
      fixture.db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number,
            actor_account_id, reason, created_at)
         VALUES (?, ?, ?, 'SUBMITTED', 2, ?, NULL, ?)`,
      ).run(
        "workflow-lower-submitted-state",
        fixture.workspaceId,
        secondScoringAssignment.id,
        secondScoringAssignment.reviewerAccountId,
        submittedAt,
      );

      const recusable = beforeReview.rounds[0]!.assignments.find(
        (assignment) => assignment.assignmentState === "ASSIGNED" && assignment.id !== submittedAssignment.id,
      )!;
      const usedForSubmission = new Set(
        beforeReview.rounds[0]!.assignments
          .filter((assignment) => assignment.submissionId === recusable.submissionId)
          .map((assignment) => assignment.reviewerAccountId),
      );
      const replacementReviewer = fixture.reviewerIds.find((id) => !usedForSubmission.has(id))!;
      const recusal = recuseOrganizerReviewAssignment(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        assignmentId: recusable.id,
        expectedAssignmentStateSequenceNumber: recusable.assignmentStateSequenceNumber,
        reason: "Reviewer declared a local conflict before evaluation.",
        replacementReviewerAccountId: replacementReviewer,
        blindArtifactDecisions: blindArtifactDecisions(fixture).find(
          (entry) => entry.submissionId === recusable.submissionId,
        )!.decisions,
        idempotencyKey: "workflow-recusal",
      });
      expect(recusal.replacementAssignmentId).toBeTruthy();
      expect(recusal.blindArtifactId).toBeTruthy();
      expect(
        (fixture.db.prepare(
          "SELECT COUNT(*) AS count FROM review_blind_artifacts WHERE assignment_id = ?",
        ).get(recusal.replacementAssignmentId) as { count: number }).count,
      ).toBe(1);
      expect(recusal.localEvidence.kind).toBe("ASSIGNMENT_RECUSED");

      const surface = readOrganizerReviewSurface(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
        sort: "score",
      });
      const projection = surface.rounds[0]!;
      expect(projection.progress.total).toBe(4);
      expect(projection.progress.revoked).toBe(1);
      expect(projection.progress.submitted).toBe(2);
      expect(projection.rankings.find((ranking) => ranking.submissionId === submittedAssignment.submissionId)).toMatchObject({
        score: 50.001,
        evidenceRank: 2,
        scoreBasis: "submitted-review-evidence",
        recommendationCounts: { advance: 1, hold: 0, doNotAdvance: 0 },
      });
      expect(projection.rankings.slice(0, 2).map((ranking) => ranking.score)).toEqual([50.002, 50.001]);
      expect(projection.rankings.find((ranking) => ranking.submissionId === secondScoringAssignment.submissionId)).toMatchObject({
        score: 50.002,
        evidenceRank: 1,
        recommendationCounts: { advance: 0, hold: 1, doNotAdvance: 0 },
      });
      expect(projection.reminders.some((reminder) => reminder.channel === "local-evidence")).toBe(true);
      expect(projection.localEvidence.map((evidence) => evidence.kind)).toEqual(
        expect.arrayContaining(["DISTRIBUTION_PLANNED", "REMINDER_PLANNED", "ASSIGNMENT_RECUSED"]),
      );

      const exported = exportOrganizerReview(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
        format: "json",
      });
      expect(exported.sensitivity).toBe("ORGANIZER_PRIVATE");
      expect(exported.content).toContain("cfp-organizer-review-export/v1");
      expect(exported.content).not.toContain("reviewer-domain");
      expect(exported.localEvidence.kind).toBe("EXPORT_CREATED");
    } finally {
      closeDb(fixture.db);
    }
  });

  it("replays the sealed assignment and artifact IDs without reading later assignment state", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const input = distributionInput(fixture, roundId, {
        idempotencyKey: "exact-replay",
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 1,
      });
      const first = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        input,
      );
      const assignmentId = first.createdAssignmentIds[0]!;
      fixture.db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number,
            actor_account_id, reason, created_at)
         VALUES (?, ?, ?, 'RECUSED', 2, ?, 'later mutable state', ?)`,
      ).run(
        "exact-replay-later-recusal",
        fixture.workspaceId,
        assignmentId,
        fixture.organizerSession.accountId,
        nowIso(),
      );
      const before = distributionCounts(fixture.db, fixture.workspaceId, roundId);
      const replay = distributeOrganizerReviewAssignments(
        withAssignmentStateReadFailure(fixture.db),
        fixture.organizerSession,
        input,
      );
      expect(replay.replayed).toBe(true);
      expect(replay.createdAssignmentIds).toEqual([]);
      expect(replay.existingAssignmentIds).toEqual(first.createdAssignmentIds);
      expect(replay.blindArtifactIds).toEqual(first.blindArtifactIds);
      expect(replay.blindArtifactPendingAssignmentIds).toEqual(
        first.blindArtifactPendingAssignmentIds,
      );
      expect(distributionCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(before);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("atomically completes a legacy reused assignment and exposes its exact blind packet", () => {
    const fixture = setup();
    try {
      const { roundId, rubricVersionId } = createRoundAndRubric(fixture);
      const legacy = insertLegacyReusableAssignment(fixture, roundId, rubricVersionId);
      const input = distributionInput(fixture, roundId, {
        idempotencyKey: "legacy-reused-complete",
        reviewerAccountIds: [fixture.reviewerIds[0]!],
        submissionIds: [fixture.submissionIds[0]!],
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 1,
      });

      expectCode(
        () => distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, {
          ...input,
          blindArtifactDecisions: undefined,
          idempotencyKey: "legacy-reused-missing-decisions",
        }),
        "INPUT_INVALID",
      );
      expect(fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM review_blind_artifacts WHERE assignment_id = ?",
      ).get(legacy.assignmentId)).toEqual({ count: 0 });

      const receipt = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        input,
      );
      expect(receipt.createdAssignmentIds).toEqual([]);
      expect(receipt.existingAssignmentIds).toEqual([legacy.assignmentId]);
      expect(receipt.blindArtifactIds).toHaveLength(1);
      expect(receipt.blindArtifactPendingAssignmentIds).toEqual([]);
      expect(receipt.blindArtifactIds).toHaveLength(receipt.plan.assignments.length);
      expect(fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM review_blind_artifacts WHERE assignment_id = ?",
      ).get(legacy.assignmentId)).toEqual({ count: 1 });

      setOrganizerReviewRoundState(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
        expectedStateSequenceNumber: 1,
        state: "OPEN",
        reason: "Open the legacy assignment for exact packet verification.",
        idempotencyKey: "legacy-reused-open",
      });
      const reviewerSession = createSession(
        fixture.db,
        fixture.reviewerIds[0]!,
        fixture.workspaceId,
      ).session;
      const detail = readOwnReviewAssignment(fixture.db, reviewerSession, {
        workspaceSlug: "northstar",
        assignmentId: legacy.assignmentId,
      });
      expect(fixture.db.prepare(
        `SELECT submission_revision_id
         FROM review_blind_artifacts WHERE assignment_id = ?`,
      ).get(legacy.assignmentId)).toEqual({
        submission_revision_id: legacy.submissionRevisionId,
      });
      expect(detail.proposal.answers).toEqual([{
        answerKey: "answer-0001",
        label: "Blind proposal",
        type: "longText",
        value: "A blinded proposal 1",
      }]);
      expect(JSON.stringify(detail)).not.toContain("Proposal 1");
      expect(JSON.stringify(detail)).not.toContain("Workflow Applicant 1");
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rolls back a legacy artifact and semantic seal when the atomic distribution receipt fails", () => {
    const fixture = setup();
    try {
      const { roundId, rubricVersionId } = createRoundAndRubric(fixture);
      const legacy = insertLegacyReusableAssignment(fixture, roundId, rubricVersionId);
      const before = distributionCounts(fixture.db, fixture.workspaceId, roundId);
      fixture.db.exec(
        `CREATE TRIGGER legacy_distribution_receipt_failure
         BEFORE INSERT ON audit_events
         WHEN NEW.action = 'cfp.review.local-evidence'
          AND json_extract(NEW.details_json, '$.kind') = 'DISTRIBUTION_PLANNED'
         BEGIN SELECT RAISE(ABORT, 'synthetic distribution receipt failure'); END`,
      );
      expectCode(
        () => distributeOrganizerReviewAssignments(
          fixture.db,
          fixture.organizerSession,
          distributionInput(fixture, roundId, {
            idempotencyKey: "legacy-reused-rollback",
            reviewerAccountIds: [fixture.reviewerIds[0]!],
            submissionIds: [fixture.submissionIds[0]!],
            reviewsPerSubmission: 1,
            maxAssignmentsPerReviewer: 1,
          }),
        ),
        "WRITE_FAILED",
      );
      expect(distributionCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(before);
      expect(fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM review_blind_artifacts WHERE assignment_id = ?",
      ).get(legacy.assignmentId)).toEqual({ count: 0 });
      expect(fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM review_rubric_semantics WHERE rubric_version_id = ?",
      ).get(rubricVersionId)).toEqual({ count: 0 });
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects changed decisions for a reused immutable artifact without partial evidence", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const firstInput = distributionInput(fixture, roundId, {
        idempotencyKey: "immutable-reuse-first",
        reviewerAccountIds: [fixture.reviewerIds[0]!],
        submissionIds: [fixture.submissionIds[0]!],
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 1,
      });
      const first = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        firstInput,
      );
      const before = distributionCounts(fixture.db, fixture.workspaceId, roundId);
      const decisions = firstInput.blindArtifactDecisions![0]!;
      expectCode(
        () => distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, {
          ...firstInput,
          idempotencyKey: "immutable-reuse-conflict",
          blindArtifactDecisions: [{
            ...decisions,
            decisions: [{
              sourceFieldId: "proposal",
              action: "INCLUDE_REDACTED",
              reviewLabel: "Blind proposal",
              redactedValue: "A different blind packet",
            }],
          }],
        }),
        "WRITE_FAILED",
      );
      expect(distributionCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(before);
      expect(fixture.db.prepare(
        "SELECT id FROM review_blind_artifacts WHERE assignment_id = ?",
      ).get(first.createdAssignmentIds[0])).toEqual({ id: first.blindArtifactIds[0] });
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects replay evidence that claims any pending artifact despite a valid outer fingerprint", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const input = distributionInput(fixture, roundId, {
        idempotencyKey: "tampered-pending-replay",
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 1,
      });
      const first = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        input,
      );
      const evidence = fixture.db.prepare(
        `SELECT rowid AS row_id, details_json
         FROM audit_events
         WHERE workspace_id = ?
           AND action = 'cfp.review.local-evidence'
           AND target_type = 'review_round'
           AND target_id = ?
           AND json_extract(details_json, '$.kind') = 'DISTRIBUTION_PLANNED'`,
      ).get(fixture.workspaceId, roundId) as { row_id: number; details_json: string };
      const details = JSON.parse(evidence.details_json) as Record<string, unknown> & {
        payload: Record<string, unknown>;
      };
      details.payload.blindArtifactPendingAssignmentIds = [first.createdAssignmentIds[0]];
      details.fingerprint = fingerprintOf({
        schema: details.schema,
        kind: details.kind,
        workspaceId: details.workspaceId,
        roundId: details.roundId,
        subjectId: details.subjectId,
        payload: details.payload,
        recordedAt: details.recordedAt,
      });
      fixture.db.exec("DROP TRIGGER trg_audit_immutable");
      fixture.db.prepare("UPDATE audit_events SET details_json = ? WHERE rowid = ?").run(
        canonicalJson(details),
        evidence.row_id,
      );
      fixture.db.exec(
        `CREATE TRIGGER trg_audit_immutable BEFORE UPDATE ON audit_events
         BEGIN SELECT RAISE(ABORT, 'audit_events is immutable'); END`,
      );
      expectCode(
        () => distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, input),
        "READ_FAILED",
      );
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects a missing or tampered replay artifact array from durable evidence", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const input = distributionInput(fixture, roundId, {
        idempotencyKey: "tampered-replay",
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 1,
      });
      distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, input);
      const evidence = fixture.db
        .prepare(
          `SELECT rowid AS row_id, details_json
           FROM audit_events
           WHERE workspace_id = ?
             AND action = 'cfp.review.local-evidence'
             AND target_type = 'review_round'
             AND target_id = ?
             AND json_extract(details_json, '$.kind') = 'DISTRIBUTION_PLANNED'`,
        )
        .get(fixture.workspaceId, roundId) as { row_id: number; details_json: string };
      const details = JSON.parse(evidence.details_json) as {
        payload: Record<string, unknown>;
      };
      delete details.payload.blindArtifactIds;
      fixture.db.exec("DROP TRIGGER trg_audit_immutable");
      fixture.db.prepare("UPDATE audit_events SET details_json = ? WHERE rowid = ?").run(
        JSON.stringify(details),
        evidence.row_id,
      );
      fixture.db.exec(
        `CREATE TRIGGER trg_audit_immutable BEFORE UPDATE ON audit_events
         BEGIN SELECT RAISE(ABORT, 'audit_events is immutable'); END`,
      );
      expectCode(
        () => distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, input),
        "READ_FAILED",
      );
    } finally {
      closeDb(fixture.db);
    }
  });

  it("recomputes the complete persisted plan fingerprint during replay", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const input = distributionInput(fixture, roundId, {
        idempotencyKey: "tampered-plan-authority",
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 1,
      });
      distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, input);
      const evidence = fixture.db.prepare(
        `SELECT rowid AS row_id, details_json
           FROM audit_events
          WHERE workspace_id = ?
            AND action = 'cfp.review.local-evidence'
            AND target_type = 'review_round'
            AND target_id = ?
            AND json_extract(details_json, '$.kind') = 'DISTRIBUTION_PLANNED'`,
      ).get(fixture.workspaceId, roundId) as { row_id: number; details_json: string };
      const details = JSON.parse(evidence.details_json) as Record<string, unknown> & {
        payload: Record<string, unknown>;
      };
      details.payload.scheduleVersion = Number(details.payload.scheduleVersion) + 1;
      details.fingerprint = fingerprintOf({
        schema: details.schema,
        kind: details.kind,
        workspaceId: details.workspaceId,
        roundId: details.roundId,
        subjectId: details.subjectId,
        payload: details.payload,
        recordedAt: details.recordedAt,
      });
      fixture.db.exec("DROP TRIGGER trg_audit_immutable");
      fixture.db.prepare("UPDATE audit_events SET details_json = ? WHERE rowid = ?").run(
        canonicalJson(details),
        evidence.row_id,
      );
      fixture.db.exec(
        `CREATE TRIGGER trg_audit_immutable BEFORE UPDATE ON audit_events
         BEGIN SELECT RAISE(ABORT, 'audit_events is immutable'); END`,
      );
      expectCode(
        () => distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, input),
        "READ_FAILED",
      );
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rolls back precommit distribution faults and fatally stops on boundary ambiguity", () => {
    const beforeWrite = setup();
    try {
      const { roundId } = createRoundAndRubric(beforeWrite);
      const expected = distributionCounts(beforeWrite.db, beforeWrite.workspaceId, roundId);
      beforeWrite.db.exec(
        `CREATE TRIGGER review_distribution_before_write
         BEFORE INSERT ON review_assignments
         BEGIN SELECT RAISE(ABORT, 'synthetic before write'); END`,
      );
      expectCode(
        () => distributeOrganizerReviewAssignments(
          beforeWrite.db,
          beforeWrite.organizerSession,
          distributionInput(beforeWrite, roundId, {
            idempotencyKey: "fault-before-write",
            reviewsPerSubmission: 1,
            maxAssignmentsPerReviewer: 1,
          }),
        ),
        "WRITE_FAILED",
      );
      expect(distributionCounts(beforeWrite.db, beforeWrite.workspaceId, roundId)).toEqual(expected);
    } finally {
      closeDb(beforeWrite.db);
    }

    const midWrite = setup();
    try {
      const { roundId } = createRoundAndRubric(midWrite);
      const expected = distributionCounts(midWrite.db, midWrite.workspaceId, roundId);
      midWrite.db.exec(
        `CREATE TRIGGER review_distribution_mid_write
         BEFORE INSERT ON review_assignments
         WHEN (SELECT COUNT(*) FROM review_assignments WHERE round_id = '${roundId}') >= 1
         BEGIN SELECT RAISE(ABORT, 'synthetic mid write'); END`,
      );
      expectCode(
        () => distributeOrganizerReviewAssignments(
          midWrite.db,
          midWrite.organizerSession,
          distributionInput(midWrite, roundId, {
            idempotencyKey: "fault-mid-write",
            reviewsPerSubmission: 1,
            maxAssignmentsPerReviewer: 1,
          }),
        ),
        "WRITE_FAILED",
      );
      expect(distributionCounts(midWrite.db, midWrite.workspaceId, roundId)).toEqual(expected);
    } finally {
      closeDb(midWrite.db);
    }

    const commitAmbiguity = setup();
    let commitRetired = false;
    try {
      const { roundId } = createRoundAndRubric(commitAmbiguity);
      const error = capture(() => distributeOrganizerReviewAssignments(
        withCommitAmbiguity(commitAmbiguity.db),
        commitAmbiguity.organizerSession,
        distributionInput(commitAmbiguity, roundId, {
          idempotencyKey: "fault-commit-ambiguity",
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 1,
        }),
      ));
      expect(error).toBeInstanceOf(OrganizerSealingFatalError);
      expect((error as OrganizerSealingFatalError).fatal).toBe(true);
      closeDb(commitAmbiguity.db);
      commitRetired = true;
    } finally {
      if (!commitRetired) closeDb(commitAmbiguity.db);
    }

    const rollbackFailure = setup();
    let rollbackRetired = false;
    try {
      const { roundId } = createRoundAndRubric(rollbackFailure);
      rollbackFailure.db.exec(
        `CREATE TRIGGER review_distribution_rollback_failure
         BEFORE INSERT ON review_assignments
         WHEN (SELECT COUNT(*) FROM review_assignments WHERE round_id = '${roundId}') >= 1
         BEGIN SELECT RAISE(ABORT, 'synthetic rollback failure write'); END`,
      );
      const error = capture(() => distributeOrganizerReviewAssignments(
        withRollbackFailure(rollbackFailure.db),
        rollbackFailure.organizerSession,
        distributionInput(rollbackFailure, roundId, {
          idempotencyKey: "fault-rollback-failure",
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 1,
        }),
      ));
      expect(error).toBeInstanceOf(OrganizerSealingFatalError);
      expect((error as OrganizerSealingFatalError).fatal).toBe(true);
      closeDb(rollbackFailure.db);
      rollbackRetired = true;
    } finally {
      if (!rollbackRetired) closeDb(rollbackFailure.db);
    }
  });

  it("persists and exactly replays a recusal receipt before later assignment-state reads", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const distributed = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        distributionInput(fixture, roundId, {
          idempotencyKey: "recusal-replay-distribution",
          reviewerAccountIds: [fixture.reviewerIds[0]!],
          submissionIds: [fixture.submissionIds[0]!],
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 1,
        }),
      );
      const assignmentId = distributed.createdAssignmentIds[0]!;
      const decisions = blindArtifactDecisions(fixture)[0]!.decisions;
      const input = {
        workspaceSlug: "northstar",
        assignmentId,
        expectedAssignmentStateSequenceNumber: 1,
        reason: "A synthetic recusal requiring an exact replacement receipt.",
        replacementReviewerAccountId: fixture.reviewerIds[1]!,
        blindArtifactDecisions: decisions,
        idempotencyKey: "recusal-exact-replay",
      } as const;
      const first = recuseOrganizerReviewAssignment(
        fixture.db,
        fixture.organizerSession,
        input,
      );
      expect(first).toMatchObject({
        schema: "cfp-organizer-review-recusal-receipt/v1",
        workspaceId: fixture.workspaceId,
        roundId,
        assignmentId,
        replayed: false,
      });
      expect(first.replacementAssignmentId).toBeTruthy();
      expect(first.blindArtifactId).toBeTruthy();
      expect(first.requestFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(first.receiptFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      const receiptRow = fixture.db.prepare(
        `SELECT details_json
         FROM audit_events
         WHERE workspace_id = ? AND action = 'cfp.review.assignment.recusal-receipt'`,
      ).get(fixture.workspaceId) as { details_json: string };
      expect(JSON.parse(receiptRow.details_json)).toMatchObject({
        schema: "cfp-organizer-review-recusal-receipt-record/v1",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: first.requestFingerprint,
        receiptFingerprint: first.receiptFingerprint,
      });
      expect(() => fixture.db.prepare(
        `UPDATE audit_events SET details_json = details_json
         WHERE workspace_id = ? AND action = 'cfp.review.assignment.recusal-receipt'`,
      ).run(fixture.workspaceId)).toThrow();

      const beforeReplay = distributionCounts(fixture.db, fixture.workspaceId, roundId);
      const replay = recuseOrganizerReviewAssignment(
        withAssignmentStateReadFailure(fixture.db),
        fixture.organizerSession,
        input,
      );
      expect(replay).toEqual({ ...first, replayed: true });
      expect(distributionCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(beforeReplay);
      expectCode(
        () => recuseOrganizerReviewAssignment(
          withAssignmentStateReadFailure(fixture.db),
          fixture.organizerSession,
          { ...input, reason: "Different input under the same recusal key." },
        ),
        "RECUSAL_IDEMPOTENCY_CONFLICT",
      );
      expectCode(
        () => recuseOrganizerReviewAssignment(
          withAssignmentStateReadFailure(fixture.db),
          fixture.organizerSession,
          { ...input, assignmentId: "different-assignment-same-recusal-key" },
        ),
        "RECUSAL_IDEMPOTENCY_CONFLICT",
      );

      setOrganizerReviewRoundState(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
        expectedStateSequenceNumber: 1,
        state: "OPEN",
        reason: "Open the replacement for reviewer projection verification.",
        idempotencyKey: "recusal-replacement-open",
      });
      const originalReviewerSession = createSession(
        fixture.db,
        fixture.reviewerIds[0]!,
        fixture.workspaceId,
      ).session;
      const replacementReviewerSession = createSession(
        fixture.db,
        fixture.reviewerIds[1]!,
        fixture.workspaceId,
      ).session;
      expect(listOwnReviewAssignments(fixture.db, originalReviewerSession, {
        workspaceSlug: "northstar",
      }).some((assignment) => assignment.assignmentId === assignmentId)).toBe(false);
      expectReviewerCode(
        () => readOwnReviewAssignment(fixture.db, originalReviewerSession, {
          workspaceSlug: "northstar",
          assignmentId,
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );
      const replacement = readOwnReviewAssignment(fixture.db, replacementReviewerSession, {
        workspaceSlug: "northstar",
        assignmentId: first.replacementAssignmentId!,
      });
      expect(replacement.proposal.answers).toEqual([{
        answerKey: "answer-0001",
        label: "Blind proposal",
        type: "longText",
        value: "A blinded proposal 1",
      }]);
      expect(JSON.stringify(replacement)).not.toContain("Workflow Applicant 1");

      const acme = fixture.db.prepare(
        `SELECT w.id AS workspace_id, a.id AS account_id
         FROM workspaces w
         JOIN accounts a ON a.workspace_id = w.id
         WHERE w.slug = 'acme' AND a.role = 'organizer'
         ORDER BY a.id LIMIT 1`,
      ).get() as { workspace_id: string; account_id: string };
      const acmeSession = createSession(
        fixture.db,
        acme.account_id,
        acme.workspace_id,
      ).session;
      expectCode(
        () => recuseOrganizerReviewAssignment(fixture.db, acmeSession, {
          ...input,
          workspaceSlug: "acme",
          idempotencyKey: "cross-workspace-recusal",
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );
      expect(distributionCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(beforeReplay);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rolls back recusal state, replacement, artifact, evidence, and receipt together", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const distributed = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        distributionInput(fixture, roundId, {
          idempotencyKey: "recusal-rollback-distribution",
          reviewerAccountIds: [fixture.reviewerIds[0]!],
          submissionIds: [fixture.submissionIds[0]!],
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 1,
        }),
      );
      const assignmentId = distributed.createdAssignmentIds[0]!;
      const before = distributionCounts(fixture.db, fixture.workspaceId, roundId);
      fixture.db.exec(
        `CREATE TRIGGER recusal_receipt_failure
         BEFORE INSERT ON audit_events
         WHEN NEW.action = 'cfp.review.assignment.recusal-receipt'
         BEGIN SELECT RAISE(ABORT, 'synthetic recusal receipt failure'); END`,
      );
      expectCode(
        () => recuseOrganizerReviewAssignment(fixture.db, fixture.organizerSession, {
          workspaceSlug: "northstar",
          assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          reason: "This entire recusal must roll back.",
          replacementReviewerAccountId: fixture.reviewerIds[1]!,
          blindArtifactDecisions: blindArtifactDecisions(fixture)[0]!.decisions,
          idempotencyKey: "recusal-receipt-rollback",
        }),
        "WRITE_FAILED",
      );
      expect(distributionCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(before);
      expect(fixture.db.prepare(
        `SELECT state, sequence_number
         FROM review_assignment_states
         WHERE assignment_id = ? ORDER BY sequence_number DESC LIMIT 1`,
      ).get(assignmentId)).toEqual({ state: "ASSIGNED", sequence_number: 1 });
      expect(fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM review_assignments WHERE supersedes_assignment_id = ?",
      ).get(assignmentId)).toEqual({ count: 0 });
      expect(fixture.db.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE workspace_id = ? AND action IN (
           'cfp.review.assignment.recused',
           'cfp.review.assignment.recusal-receipt'
         )`,
      ).get(fixture.workspaceId)).toEqual({ count: 0 });
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects a tampered immutable recusal receipt on replay", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const distributed = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        distributionInput(fixture, roundId, {
          idempotencyKey: "recusal-tamper-distribution",
          reviewerAccountIds: [fixture.reviewerIds[0]!],
          submissionIds: [fixture.submissionIds[0]!],
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 1,
        }),
      );
      const input = {
        workspaceSlug: "northstar",
        assignmentId: distributed.createdAssignmentIds[0]!,
        expectedAssignmentStateSequenceNumber: 1,
        reason: "Create an immutable receipt for tamper verification.",
        replacementReviewerAccountId: fixture.reviewerIds[1]!,
        blindArtifactDecisions: blindArtifactDecisions(fixture)[0]!.decisions,
        idempotencyKey: "recusal-tamper-replay",
      } as const;
      recuseOrganizerReviewAssignment(fixture.db, fixture.organizerSession, input);
      const row = fixture.db.prepare(
        `SELECT rowid AS row_id, details_json
         FROM audit_events
         WHERE workspace_id = ? AND action = 'cfp.review.assignment.recusal-receipt'`,
      ).get(fixture.workspaceId) as { row_id: number; details_json: string };
      const details = JSON.parse(row.details_json) as {
        receipt: Record<string, unknown>;
      };
      details.receipt.blindArtifactId = "tampered-recusal-artifact";
      fixture.db.exec("DROP TRIGGER trg_audit_immutable");
      fixture.db.prepare("UPDATE audit_events SET details_json = ? WHERE rowid = ?").run(
        canonicalJson(details),
        row.row_id,
      );
      fixture.db.exec(
        `CREATE TRIGGER trg_audit_immutable BEFORE UPDATE ON audit_events
         BEGIN SELECT RAISE(ABORT, 'audit_events is immutable'); END`,
      );
      expectCode(
        () => recuseOrganizerReviewAssignment(
          fixture.db,
          fixture.organizerSession,
          input,
        ),
        "READ_FAILED",
      );
    } finally {
      closeDb(fixture.db);
    }
  });

  it("keeps a declared reviewer-submission conflict retired across a submitted amendment", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const submissionId = fixture.submissionIds[0]!;
      const retiredReviewerId = fixture.reviewerIds[0]!;
      const replacementReviewerId = fixture.reviewerIds[1]!;
      const first = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        distributionInput(fixture, roundId, {
          idempotencyKey: "durable-conflict-initial",
          reviewerAccountIds: [retiredReviewerId, replacementReviewerId],
          submissionIds: [submissionId],
          reviewsPerSubmission: 2,
          maxAssignmentsPerReviewer: 1,
        }),
      );
      const retiredAssignmentIndex = first.plan.assignments.findIndex(
        (assignment) => assignment.reviewerAccountId === retiredReviewerId,
      );
      expect(retiredAssignmentIndex).toBeGreaterThanOrEqual(0);
      const retiredAssignmentId = first.createdAssignmentIds[retiredAssignmentIndex]!;
      const retiredArtifactId = first.blindArtifactIds[retiredAssignmentIndex]!;
      const retiredRevisionId = first.plan.assignments[retiredAssignmentIndex]!.submissionRevisionId;
      setOrganizerReviewRoundState(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
        expectedStateSequenceNumber: 1,
        state: "OPEN",
        reason: "Open the round for a durable conflict regression.",
        idempotencyKey: "durable-conflict-open",
      });
      const retiredReviewerSession = createSession(
        fixture.db,
        retiredReviewerId,
        fixture.workspaceId,
      ).session;
      declareOwnReviewConflict(fixture.db, retiredReviewerSession, {
        workspaceSlug: "northstar",
        assignmentId: retiredAssignmentId,
        expectedAssignmentStateSequenceNumber: 1,
        expectedConflictSequenceNumber: 0,
        reason: "This reviewer conflicts with the durable proposal.",
        idempotencyKey: "durable-conflict-declare",
      });

      const amendment = amendSubmittedProposal(
        fixture,
        submissionId,
        "Proposal 1 amended after the conflict declaration",
      );
      expect(amendment.previousRevisionId).toBe(retiredRevisionId);
      expect(amendment.currentRevisionId).not.toBe(retiredRevisionId);
      const currentInput = distributionInput(fixture, roundId, {
        idempotencyKey: "durable-conflict-current",
        reviewerAccountIds: [retiredReviewerId, replacementReviewerId],
        submissionIds: [submissionId],
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 1,
      });
      const current = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        currentInput,
      );
      expect(current.createdAssignmentIds).toHaveLength(1);
      expect(current.existingAssignmentIds).toEqual([]);
      expect(current.blindArtifactIds).toHaveLength(1);
      expect(current.plan.assignments).toEqual([{
        submissionId,
        submissionRevisionId: amendment.currentRevisionId,
        reviewerAccountId: replacementReviewerId,
        poolId: null,
      }]);
      const replacementAssignmentId = current.createdAssignmentIds[0]!;
      expect(fixture.db.prepare(
        `SELECT submission_id, submission_revision_id, reviewer_account_id
         FROM review_assignments WHERE id = ?`,
      ).get(replacementAssignmentId)).toEqual({
        submission_id: submissionId,
        submission_revision_id: amendment.currentRevisionId,
        reviewer_account_id: replacementReviewerId,
      });
      expect(fixture.db.prepare(
        `SELECT submission_revision_id FROM review_blind_artifacts
         WHERE id = ? AND assignment_id = ?`,
      ).get(current.blindArtifactIds[0], replacementAssignmentId)).toEqual({
        submission_revision_id: amendment.currentRevisionId,
      });
      expect(fixture.db.prepare(
        `SELECT COUNT(*) AS count FROM review_assignments
         WHERE workspace_id = ? AND round_id = ? AND submission_id = ?
           AND submission_revision_id = ? AND reviewer_account_id = ?`,
      ).get(
        fixture.workspaceId,
        roundId,
        submissionId,
        amendment.currentRevisionId,
        retiredReviewerId,
      )).toEqual({ count: 0 });
      expect(fixture.db.prepare(
        `SELECT submission_revision_id FROM review_blind_artifacts
         WHERE id = ? AND assignment_id = ?`,
      ).get(retiredArtifactId, retiredAssignmentId)).toEqual({
        submission_revision_id: retiredRevisionId,
      });

      const beforeReplay = recusalSideEffectCounts(fixture.db, fixture.workspaceId, roundId);
      const replay = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        currentInput,
      );
      expect(replay.replayed).toBe(true);
      expect(replay.existingAssignmentIds).toEqual(current.createdAssignmentIds);
      expect(replay.blindArtifactIds).toEqual(current.blindArtifactIds);
      expect(recusalSideEffectCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(beforeReplay);

      const replacementReviewerSession = createSession(
        fixture.db,
        replacementReviewerId,
        fixture.workspaceId,
      ).session;
      expectReviewerCode(
        () => readOwnReviewAssignment(fixture.db, retiredReviewerSession, {
          workspaceSlug: "northstar",
          assignmentId: retiredAssignmentId,
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );
      expectReviewerCode(
        () => readOwnReviewAssignment(fixture.db, retiredReviewerSession, {
          workspaceSlug: "northstar",
          assignmentId: replacementAssignmentId,
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );
      expect(readOwnReviewAssignment(fixture.db, replacementReviewerSession, {
        workspaceSlug: "northstar",
        assignmentId: replacementAssignmentId,
      }).proposal).toMatchObject({
        revisionSequence: 2,
        answers: [{ value: "A blinded proposal 1" }],
      });

      const beforeDeniedReplacement = recusalSideEffectCounts(
        fixture.db,
        fixture.workspaceId,
        roundId,
      );
      expectCode(
        () => recuseOrganizerReviewAssignment(fixture.db, fixture.organizerSession, {
          workspaceSlug: "northstar",
          assignmentId: replacementAssignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          reason: "A conflicted reviewer must not return as a recusal replacement.",
          replacementReviewerAccountId: retiredReviewerId,
          blindArtifactDecisions: blindArtifactDecisions(fixture)[0]!.decisions,
          idempotencyKey: "durable-conflict-denied-replacement",
        }),
        "REVIEWER_NOT_AVAILABLE",
      );
      expect(recusalSideEffectCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(
        beforeDeniedReplacement,
      );
    } finally {
      closeDb(fixture.db);
    }
  });

  it("keeps recusal durable across an amendment and issues replacements only for the current revision", () => {
    const fixture = setup();
    try {
      const { roundId } = createRoundAndRubric(fixture);
      const submissionId = fixture.submissionIds[0]!;
      const firstReviewerId = fixture.reviewerIds[0]!;
      const secondReviewerId = fixture.reviewerIds[1]!;
      const eligibleReviewerId = fixture.reviewerIds[2]!;
      const first = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        distributionInput(fixture, roundId, {
          idempotencyKey: "durable-recusal-initial",
          reviewerAccountIds: [firstReviewerId],
          submissionIds: [submissionId],
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 1,
        }),
      );
      const firstAssignmentId = first.createdAssignmentIds[0]!;
      const firstRevisionId = first.plan.assignments[0]!.submissionRevisionId;
      const firstRecusal = recuseOrganizerReviewAssignment(
        fixture.db,
        fixture.organizerSession,
        {
          workspaceSlug: "northstar",
          assignmentId: firstAssignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          reason: "Retire the first reviewer for this durable proposal.",
          replacementReviewerAccountId: secondReviewerId,
          blindArtifactDecisions: blindArtifactDecisions(fixture)[0]!.decisions,
          idempotencyKey: "durable-recusal-first",
        },
      );
      const secondAssignmentId = firstRecusal.replacementAssignmentId!;
      const secondArtifactId = firstRecusal.blindArtifactId!;
      const amendment = amendSubmittedProposal(
        fixture,
        submissionId,
        "Proposal 1 amended after the first reviewer recused",
      );
      expect(amendment.previousRevisionId).toBe(firstRevisionId);

      const secondRecusal = recuseOrganizerReviewAssignment(
        fixture.db,
        fixture.organizerSession,
        {
          workspaceSlug: "northstar",
          assignmentId: secondAssignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          reason: "Replace the stale-revision assignee with an eligible current reviewer.",
          replacementReviewerAccountId: eligibleReviewerId,
          blindArtifactDecisions: blindArtifactDecisions(fixture)[0]!.decisions,
          idempotencyKey: "durable-recusal-current-replacement",
        },
      );
      const currentAssignmentId = secondRecusal.replacementAssignmentId!;
      expect(fixture.db.prepare(
        `SELECT submission_id, submission_revision_id, reviewer_account_id,
                supersedes_assignment_id
         FROM review_assignments WHERE id = ?`,
      ).get(currentAssignmentId)).toEqual({
        submission_id: submissionId,
        submission_revision_id: amendment.currentRevisionId,
        reviewer_account_id: eligibleReviewerId,
        supersedes_assignment_id: null,
      });
      expect(fixture.db.prepare(
        `SELECT submission_revision_id FROM review_blind_artifacts
         WHERE id = ? AND assignment_id = ?`,
      ).get(secondRecusal.blindArtifactId, currentAssignmentId)).toEqual({
        submission_revision_id: amendment.currentRevisionId,
      });
      expect(fixture.db.prepare(
        `SELECT submission_revision_id FROM review_blind_artifacts
         WHERE id = ? AND assignment_id = ?`,
      ).get(secondArtifactId, secondAssignmentId)).toEqual({
        submission_revision_id: firstRevisionId,
      });

      const currentInput = distributionInput(fixture, roundId, {
        idempotencyKey: "durable-recusal-distribution-current",
        reviewerAccountIds: [firstReviewerId, secondReviewerId, eligibleReviewerId],
        submissionIds: [submissionId],
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 1,
      });
      const beforeDistribution = recusalSideEffectCounts(
        fixture.db,
        fixture.workspaceId,
        roundId,
      );
      const current = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        currentInput,
      );
      expect(current.createdAssignmentIds).toEqual([]);
      expect(current.existingAssignmentIds).toEqual([currentAssignmentId]);
      expect(current.blindArtifactIds).toEqual([secondRecusal.blindArtifactId]);
      expect(current.plan.assignments).toEqual([{
        submissionId,
        submissionRevisionId: amendment.currentRevisionId,
        reviewerAccountId: eligibleReviewerId,
        poolId: null,
      }]);
      const afterDistribution = recusalSideEffectCounts(
        fixture.db,
        fixture.workspaceId,
        roundId,
      );
      expect(afterDistribution.assignments).toBe(beforeDistribution.assignments);
      expect(afterDistribution.assignmentStates).toBe(beforeDistribution.assignmentStates);
      expect(afterDistribution.artifacts).toBe(beforeDistribution.artifacts);
      expect(fixture.db.prepare(
        `SELECT reviewer_account_id, COUNT(*) AS count
         FROM review_assignments
         WHERE workspace_id = ? AND round_id = ? AND submission_id = ?
           AND submission_revision_id = ?
         GROUP BY reviewer_account_id ORDER BY reviewer_account_id`,
      ).all(
        fixture.workspaceId,
        roundId,
        submissionId,
        amendment.currentRevisionId,
      )).toEqual([{ reviewer_account_id: eligibleReviewerId, count: 1 }]);
      const beforeReplay = recusalSideEffectCounts(fixture.db, fixture.workspaceId, roundId);
      const replay = distributeOrganizerReviewAssignments(
        fixture.db,
        fixture.organizerSession,
        currentInput,
      );
      expect(replay.replayed).toBe(true);
      expect(replay.existingAssignmentIds).toEqual([currentAssignmentId]);
      expect(replay.blindArtifactIds).toEqual([secondRecusal.blindArtifactId]);
      expect(recusalSideEffectCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(beforeReplay);

      setOrganizerReviewRoundState(fixture.db, fixture.organizerSession, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId,
        expectedStateSequenceNumber: 1,
        state: "OPEN",
        reason: "Open the round for durable recusal packet verification.",
        idempotencyKey: "durable-recusal-open",
      });
      const firstReviewerSession = createSession(
        fixture.db,
        firstReviewerId,
        fixture.workspaceId,
      ).session;
      const secondReviewerSession = createSession(
        fixture.db,
        secondReviewerId,
        fixture.workspaceId,
      ).session;
      const eligibleReviewerSession = createSession(
        fixture.db,
        eligibleReviewerId,
        fixture.workspaceId,
      ).session;
      expectReviewerCode(
        () => readOwnReviewAssignment(fixture.db, firstReviewerSession, {
          workspaceSlug: "northstar",
          assignmentId: firstAssignmentId,
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );
      expectReviewerCode(
        () => readOwnReviewAssignment(fixture.db, secondReviewerSession, {
          workspaceSlug: "northstar",
          assignmentId: secondAssignmentId,
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );
      expect(readOwnReviewAssignment(fixture.db, eligibleReviewerSession, {
        workspaceSlug: "northstar",
        assignmentId: currentAssignmentId,
      }).proposal).toMatchObject({
        revisionSequence: 2,
        answers: [{ value: "A blinded proposal 1" }],
      });

      const beforeDeniedReplacement = recusalSideEffectCounts(
        fixture.db,
        fixture.workspaceId,
        roundId,
      );
      expectCode(
        () => recuseOrganizerReviewAssignment(fixture.db, fixture.organizerSession, {
          workspaceSlug: "northstar",
          assignmentId: currentAssignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          reason: "A recused reviewer must not return on an amended revision.",
          replacementReviewerAccountId: firstReviewerId,
          blindArtifactDecisions: blindArtifactDecisions(fixture)[0]!.decisions,
          idempotencyKey: "durable-recusal-denied-replacement",
        }),
        "REVIEWER_NOT_AVAILABLE",
      );
      expect(recusalSideEffectCounts(fixture.db, fixture.workspaceId, roundId)).toEqual(
        beforeDeniedReplacement,
      );
    } finally {
      closeDb(fixture.db);
    }
  });

  it.each(["RECUSED", "REVOKED", "CONFLICT"] as const)(
    "creates a fresh replacement assignment and artifact for a %s pair",
    (retirement) => {
      const fixture = setup();
      try {
        const { roundId } = createRoundAndRubric(fixture);
        const submissionId = fixture.submissionIds[0]!;
        const oldReviewerId = fixture.reviewerIds[0]!;
        const replacementReviewerId = fixture.reviewerIds[1]!;
        const first = distributeOrganizerReviewAssignments(
          fixture.db,
          fixture.organizerSession,
          distributionInput(fixture, roundId, {
            idempotencyKey: `historical-${retirement.toLowerCase()}`,
            reviewerAccountIds: [oldReviewerId],
            submissionIds: [submissionId],
            reviewsPerSubmission: 1,
            maxAssignmentsPerReviewer: 1,
          }),
        );
        const oldAssignmentId = first.createdAssignmentIds[0]!;
        const oldArtifactId = first.blindArtifactIds[0]!;
        if (retirement === "CONFLICT") {
          fixture.db.prepare(
            `INSERT INTO review_conflict_dispositions
               (id, workspace_id, assignment_id, action, sequence_number,
                actor_account_id, actor_role_basis, reason, created_at)
             VALUES (?, ?, ?, 'DECLARE', 1, ?, 'reviewer', 'synthetic conflict', ?)`,
          ).run(
            "historical-conflict",
            fixture.workspaceId,
            oldAssignmentId,
            fixture.organizerSession.accountId,
            nowIso(),
          );
        } else {
          fixture.db.prepare(
            `INSERT INTO review_assignment_states
               (id, workspace_id, assignment_id, state, sequence_number,
                actor_account_id, reason, created_at)
             VALUES (?, ?, ?, ?, 2, ?, 'synthetic retirement', ?)`,
          ).run(
            `historical-${retirement.toLowerCase()}-state`,
            fixture.workspaceId,
            oldAssignmentId,
            retirement,
            fixture.organizerSession.accountId,
            nowIso(),
          );
        }
        const replacement = distributeOrganizerReviewAssignments(
          fixture.db,
          fixture.organizerSession,
          distributionInput(fixture, roundId, {
            idempotencyKey: `replacement-${retirement.toLowerCase()}`,
            reviewerAccountIds: [oldReviewerId, replacementReviewerId],
            submissionIds: [submissionId],
            reviewsPerSubmission: 1,
            maxAssignmentsPerReviewer: 1,
          }),
        );
        expect(replacement.createdAssignmentIds).toHaveLength(1);
        expect(replacement.existingAssignmentIds).toEqual([]);
        expect(replacement.blindArtifactIds).toHaveLength(1);
        expect(replacement.blindArtifactIds[0]).not.toBe(oldArtifactId);
        expect(
          fixture.db.prepare("SELECT reviewer_account_id FROM review_assignments WHERE id = ?").get(
            replacement.createdAssignmentIds[0],
          ),
        ).toEqual({ reviewer_account_id: replacementReviewerId });
        expect(
          fixture.db.prepare("SELECT COUNT(*) AS count FROM review_blind_artifacts WHERE assignment_id = ?").get(
            replacement.createdAssignmentIds[0],
          ),
        ).toEqual({ count: 1 });
      } finally {
        closeDb(fixture.db);
      }
    },
  );

  it("rolls back every assignment, semantic seal, artifact, audit, and reminder when a later artifact fails", () => {
    const fixture = setup();
    try {
      const { roundId, rubricVersionId } = createRoundAndRubric(fixture);
      const orderedSubmissions = [...fixture.submissionIds].sort();
      const validDecisions = blindArtifactDecisions(fixture);
      const invalidDecisions = validDecisions.map((entry) =>
        entry.submissionId === orderedSubmissions[1]
          ? {
              ...entry,
              decisions: [{
                sourceFieldId: "missing-source-field",
                action: "EXCLUDE" as const,
              }],
            }
          : entry,
      );
      const before = {
        assignments: (fixture.db.prepare(
          "SELECT COUNT(*) AS count FROM review_assignments WHERE workspace_id = ? AND round_id = ?",
        ).get(fixture.workspaceId, roundId) as { count: number }).count,
        artifacts: (fixture.db.prepare(
          "SELECT COUNT(*) AS count FROM review_blind_artifacts WHERE workspace_id = ? AND rubric_version_id = ?",
        ).get(fixture.workspaceId, rubricVersionId) as { count: number }).count,
        semantics: (fixture.db.prepare(
          "SELECT COUNT(*) AS count FROM review_rubric_semantics WHERE workspace_id = ? AND rubric_version_id = ?",
        ).get(fixture.workspaceId, rubricVersionId) as { count: number }).count,
        audits: (fixture.db.prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ?",
        ).get(fixture.workspaceId) as { count: number }).count,
      };
      let thrown: unknown;
      try {
        distributeOrganizerReviewAssignments(fixture.db, fixture.organizerSession, {
          workspaceSlug: "northstar",
          roundId,
          reviewerAccountIds: fixture.reviewerIds.slice(0, 2),
          submissionIds: orderedSubmissions.slice(0, 2),
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 2,
          strategy: "round_robin",
          blindArtifactDecisions: invalidDecisions,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OrganizerReviewServiceError);
      expect((thrown as OrganizerReviewServiceError).code).toBe("WRITE_FAILED");
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM review_assignments WHERE workspace_id = ? AND round_id = ?",
      ).get(fixture.workspaceId, roundId) as { count: number }).count).toBe(before.assignments);
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM review_blind_artifacts WHERE workspace_id = ? AND rubric_version_id = ?",
      ).get(fixture.workspaceId, rubricVersionId) as { count: number }).count).toBe(before.artifacts);
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM review_rubric_semantics WHERE workspace_id = ? AND rubric_version_id = ?",
      ).get(fixture.workspaceId, rubricVersionId) as { count: number }).count).toBe(before.semantics);
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ?",
      ).get(fixture.workspaceId) as { count: number }).count).toBe(before.audits);
    } finally {
      closeDb(fixture.db);
    }
  });
});
