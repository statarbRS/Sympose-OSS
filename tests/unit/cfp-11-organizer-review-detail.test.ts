import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "../../src/server/auth";
import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { OrganizerReviewConsole } from "../../src/components/cfp-review/organizer-review-console";
import {
  createCall,
  createDraftSubmission,
  createFormDefinition,
  saveDraftRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import {
  OrganizerReviewServiceError,
  createOrganizerReviewRound,
  createOrganizerReviewRubric,
  distributeOrganizerReviewAssignments,
  readOrganizerReviewSurface,
  setOrganizerReviewRoundState,
} from "../../src/server/services/cfp-review/organizer";
import {
  listOwnReviewAssignments,
  readOwnReviewAssignment,
  declareOwnReviewConflict,
  ReviewerServiceError,
  saveOwnReview,
  submitOwnReview,
} from "../../src/server/services/cfp-review/reviewer";

const EVENT_ID = "cfp11-detail-event";
const REVIEWER_ID = "cfp11-detail-reviewer";
const OPEN_AT = "2026-08-01T09:00:00.000Z";
const CLOSE_AT = "2026-09-15T09:00:00.000Z";

type Fixture = Readonly<{
  db: Db;
  organizerSession: SessionInfo;
  reviewerSession: SessionInfo;
  workspaceId: string;
  eventId: string;
  roundId: string;
  rubricVersionId: string;
  submissionId: string;
  submissionRevisionId: string;
  assignmentId: string;
  reviewerId: string;
}>;

const databases: Db[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
});

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
  databases.push(db);
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
  db.prepare(
    `INSERT INTO accounts
       (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, 'reviewer', ?)`,
  ).run(
    REVIEWER_ID,
    workspace.id,
    "cfp11-reviewer@synthetic.example",
    "CFP-11 Reviewer",
    "2026-08-01T00:00:00.000Z",
  );
  const organizerSession = createSession(db, organizer.id, workspace.id).session;
  const reviewerSession = createSession(db, REVIEWER_ID, workspace.id).session;
  db.prepare(
    `INSERT INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
  ).run(
    EVENT_ID,
    workspace.id,
    "CFP-11 detail event",
    OPEN_AT,
    CLOSE_AT,
    "2026-07-01T00:00:00.000Z",
  );

  const context = { workspaceId: workspace.id, accountId: organizer.id };
  const definition = createFormDefinition(db, context, { name: "CFP-11 form" });
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
    name: "CFP-11 call",
    slug: "cfp-11-call",
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

  const personId = "cfp11-detail-person";
  const verificationId = "cfp11-detail-verification";
  const applicantSessionId = "cfp11-detail-applicant-session";
  db.prepare(
    `INSERT INTO people
       (id, workspace_id, canonical_email, full_name, organization, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    personId,
    workspace.id,
    "cfp11-applicant@synthetic.example",
    "CFP-11 Applicant",
    "Northstar Labs",
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
    "cfp11-applicant@synthetic.example",
    "1".repeat(64),
    "2099-09-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "cfp11-detail-consumption",
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
    "2".repeat(64),
    "2026-08-01T00:00:02.000Z",
    "2099-09-01T00:00:00.000Z",
  );
  const submission = createDraftSubmission(
    db,
    { workspaceId: workspace.id, sessionId: applicantSessionId },
    { callId: call.id },
  );
  const savedRevision = saveDraftRevision(
    db,
    { workspaceId: workspace.id, sessionId: applicantSessionId },
    {
      submissionId: submission.id,
      expectedCurrentRevisionId: null,
      historicalAnswers: [{ fieldId: "proposal", value: "CFP-11 proposal" }],
    },
  );
  db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(submission.id);

  const round = createOrganizerReviewRound(db, organizerSession, {
    workspaceSlug: "northstar",
    eventId: EVENT_ID,
    callId: call.id,
    name: "CFP-11 screening",
  });
  const rubric = createOrganizerReviewRubric(db, organizerSession, {
    workspaceSlug: "northstar",
    roundId: round.roundId,
    fields: [
      {
        id: "quality",
        label: "Proposal quality",
        kind: "numeric",
        required: true,
        weight: 2,
        minimum: 0,
        maximum: 10,
        step: 1,
      },
      {
        id: "recommendation",
        label: "Independent recommendation",
        kind: "dropdown",
        required: true,
        weight: 1,
        recommendation: true,
        choices: [
          { value: "ADVANCE", label: "Advance for further consideration" },
          { value: "HOLD", label: "Hold for further consideration" },
          { value: "DO_NOT_ADVANCE", label: "Do not advance for further consideration" },
        ],
      },
      {
        id: "notes",
        label: "Reviewer comments",
        kind: "text",
        required: false,
        weight: 1,
        maxLength: 500,
      },
    ],
  });
  distributeOrganizerReviewAssignments(db, organizerSession, {
    workspaceSlug: "northstar",
    roundId: round.roundId,
    reviewerAccountIds: [REVIEWER_ID],
    submissionIds: [submission.id],
    reviewsPerSubmission: 1,
    maxAssignmentsPerReviewer: 1,
    blindArtifactDecisions: [
      {
        submissionId: submission.id,
        submissionRevisionId: savedRevision.revisionId,
        decisions: [
          {
            sourceFieldId: "proposal",
            action: "INCLUDE_REDACTED",
            reviewLabel: "Blind proposal",
            redactedValue: "A deliberately blinded proposal",
          },
        ],
      },
    ],
  });
  setOrganizerReviewRoundState(db, organizerSession, {
    workspaceSlug: "northstar",
    roundId: round.roundId,
    expectedStateSequenceNumber: 1,
    state: "OPEN",
    reason: "Open the custom review queue for the reviewer.",
  });
  const surface = readOrganizerReviewSurface(db, organizerSession, {
    workspaceSlug: "northstar",
    eventId: EVENT_ID,
    roundId: round.roundId,
  });
  const assignment = surface.rounds[0]?.assignments[0];
  if (!assignment) throw new Error("CFP-11 fixture did not create an assignment");
  return Object.freeze({
    db,
    organizerSession,
    reviewerSession,
    workspaceId: workspace.id,
    eventId: EVENT_ID,
    roundId: round.roundId,
    rubricVersionId: rubric.rubricVersionId,
    submissionId: submission.id,
    submissionRevisionId: savedRevision.revisionId,
    assignmentId: assignment.id,
    reviewerId: REVIEWER_ID,
  });
}

function insertReviewRevision(
  fixture: Fixture,
  revisionNumber: number,
  responses: readonly { readonly criterionId: string; readonly value: string | number | boolean }[],
  extra: Readonly<Record<string, unknown>> = {},
): void {
  const document = {
    schema: "cfp-review-evaluation/v1" as const,
    assignmentId: fixture.assignmentId,
    rubricVersionId: fixture.rubricVersionId,
    submissionRevisionId: fixture.submissionRevisionId,
    reviewRevisionNumber: revisionNumber,
    responses,
    ...extra,
  };
  fixture.db.prepare(
    `INSERT INTO review_revisions
       (id, workspace_id, assignment_id, round_id, rubric_version_id,
        submission_id, submission_revision_id, revision_number,
        evaluation_schema, evaluation_json, fingerprint_algorithm,
        fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cfp-review-evaluation/v1', ?,
             'sha256-canonical-json-v1', ?, ?)`,
  ).run(
    `cfp11-review-revision-${String(revisionNumber)}`,
    fixture.workspaceId,
    fixture.assignmentId,
    fixture.roundId,
    fixture.rubricVersionId,
    fixture.submissionId,
    fixture.submissionRevisionId,
    revisionNumber,
    canonicalJson(document),
    fingerprintOf(document),
    `2026-08-12T10:0${String(revisionNumber)}:00.000Z`,
  );
}

function submitAssignment(fixture: Fixture): void {
  fixture.db.prepare(
    `INSERT INTO review_assignment_states
       (id, workspace_id, assignment_id, state, sequence_number,
        actor_account_id, reason, created_at)
     VALUES (?, ?, ?, 'IN_PROGRESS', 2, ?, NULL, ?)`,
  ).run(
    "cfp11-review-in-progress",
    fixture.workspaceId,
    fixture.assignmentId,
    fixture.reviewerId,
    "2026-08-12T10:03:00.000Z",
  );
  fixture.db.prepare(
    `INSERT INTO review_assignment_states
       (id, workspace_id, assignment_id, state, sequence_number,
        actor_account_id, reason, created_at)
     VALUES (?, ?, ?, 'SUBMITTED', 3, ?, NULL, ?)`,
  ).run(
    "cfp11-review-submitted",
    fixture.workspaceId,
    fixture.assignmentId,
    fixture.reviewerId,
    "2026-08-12T10:04:00.000Z",
  );
}

function read(fixture: Fixture) {
  return readOrganizerReviewSurface(fixture.db, fixture.organizerSession, {
    workspaceSlug: "northstar",
    eventId: fixture.eventId,
    roundId: fixture.roundId,
  });
}

describe("CFP-11 organizer review detail evidence", () => {
  it("projects only the latest submitted revision with rubric-bound criterion values", () => {
    const fixture = setup();
    insertReviewRevision(fixture, 1, [
      { criterionId: "quality", value: 3 },
      { criterionId: "recommendation", value: "HOLD" },
      { criterionId: "notes", value: "Superseded reviewer draft" },
    ]);
    expect(read(fixture).rounds[0]?.assignments[0]?.latestSubmittedReview).toBeNull();

    insertReviewRevision(fixture, 2, [
      { criterionId: "quality", value: 9 },
      { criterionId: "recommendation", value: "ADVANCE" },
      { criterionId: "notes", value: "Latest submitted reviewer comment" },
    ]);
    submitAssignment(fixture);

    const assignment = read(fixture).rounds[0]?.assignments[0];
    expect(assignment?.latestSubmittedReview).toEqual({
      revisionNumber: 2,
      criteria: [
        {
          criterionId: "quality",
          label: "Proposal quality",
          kind: "numeric",
          value: 9,
          choiceLabel: null,
        },
        {
          criterionId: "recommendation",
          label: "Independent recommendation",
          kind: "dropdown",
          value: "ADVANCE",
          choiceLabel: "Advance for further consideration",
        },
        {
          criterionId: "notes",
          label: "Reviewer comments",
          kind: "text",
          value: "Latest submitted reviewer comment",
          choiceLabel: null,
        },
      ],
    });
    expect(JSON.stringify(assignment)).not.toContain("Superseded reviewer draft");
    expect(JSON.stringify(assignment)).not.toContain("evaluation_json");
    expect(JSON.stringify(assignment)).not.toContain("cfp-review-evaluation/v1");
  });

  it("renders applicant and reviewer identities with detail values and a no-submitted state", () => {
    const fixture = setup();
    insertReviewRevision(fixture, 1, [
      { criterionId: "quality", value: 8 },
      { criterionId: "recommendation", value: "ADVANCE" },
      { criterionId: "notes", value: "Submitted reviewer comment" },
    ]);
    const beforeSubmit = read(fixture);
    const emptyHtml = renderToStaticMarkup(createElement(OrganizerReviewConsole, {
      workspace: "northstar",
      surface: beforeSubmit,
    }));
    expect(emptyHtml).toContain("No submitted review is available for this assignment.");
    expect(emptyHtml).not.toContain("Submitted reviewer comment");

    submitAssignment(fixture);
    const submittedHtml = renderToStaticMarkup(createElement(OrganizerReviewConsole, {
      workspace: "northstar",
      surface: read(fixture),
    }));
    expect(submittedHtml).toContain("CFP-11 Applicant");
    expect(submittedHtml).toContain("CFP-11 Reviewer");
    expect(submittedHtml).toContain("Proposal quality");
    expect(submittedHtml).toContain("numeric");
    expect(submittedHtml).toContain("8");
    expect(submittedHtml).toContain("Independent recommendation");
    expect(submittedHtml).toContain("Advance for further consideration");
    expect(submittedHtml).toContain("Reviewer comments");
    expect(submittedHtml).toContain("Submitted reviewer comment");
    expect(submittedHtml).not.toContain("evaluation_json");
    expect(submittedHtml).not.toContain("cfp-review-evaluation/v1");
  });

  it("keeps the evidence tenant- and role-scoped", () => {
    const fixture = setup();
    insertReviewRevision(fixture, 1, [
      { criterionId: "quality", value: 7 },
      { criterionId: "recommendation", value: "HOLD" },
      { criterionId: "notes", value: "Workspace-private comment" },
    ]);
    submitAssignment(fixture);

    const acmeWorkspace = fixture.db
      .prepare("SELECT id FROM workspaces WHERE slug = 'acme'")
      .get() as { id: string };
    const acmeOrganizer = fixture.db
      .prepare(
        `SELECT id FROM accounts
         WHERE workspace_id = ? AND role = 'organizer'
         ORDER BY id LIMIT 1`,
      )
      .get(acmeWorkspace.id) as { id: string };
    const acmeSession = createSession(fixture.db, acmeOrganizer.id, acmeWorkspace.id).session;
    expectCode(
      () => readOrganizerReviewSurface(fixture.db, acmeSession, {
        workspaceSlug: "acme",
        eventId: fixture.eventId,
        roundId: fixture.roundId,
      }),
      "EVENT_NOT_AVAILABLE",
    );

    const reviewerSession = createSession(
      fixture.db,
      fixture.reviewerId,
      fixture.workspaceId,
    ).session;
    expectCode(
      () => readOrganizerReviewSurface(fixture.db, reviewerSession, {
        workspaceSlug: "northstar",
        eventId: fixture.eventId,
        roundId: fixture.roundId,
      }),
      "ACCESS_DENIED",
    );
  });

  it("fails closed on unknown criteria and extra private payload keys", () => {
    const unknownCriterion = setup();
    insertReviewRevision(unknownCriterion, 1, [
      { criterionId: "unknown-private-field", value: "do not project" },
    ]);
    submitAssignment(unknownCriterion);
    expectCode(() => read(unknownCriterion), "READ_FAILED");

    const positionalCriterion = setup();
    insertReviewRevision(positionalCriterion, 1, [
      { criterionId: "criterion-0001", value: 8 },
      { criterionId: "criterion-0002", value: "ADVANCE" },
      { criterionId: "criterion-0003", value: "must not remap custom IDs" },
    ]);
    submitAssignment(positionalCriterion);
    expectCode(() => read(positionalCriterion), "READ_FAILED");

    const extraKey = setup();
    insertReviewRevision(
      extraKey,
      1,
      [
        { criterionId: "quality", value: 5 },
        { criterionId: "recommendation", value: "HOLD" },
        { criterionId: "notes", value: "Safe-looking comment" },
      ],
      { privateOrganizerField: "must not escape" },
    );
    submitAssignment(extraKey);
    expectCode(() => read(extraKey), "READ_FAILED");
  });

  it("enforces custom assignment conflict blocking and cross-tenant denial", () => {
    const fixture = setup();
    const declared = declareOwnReviewConflict(fixture.db, fixture.reviewerSession, {
      workspaceSlug: "northstar",
      assignmentId: fixture.assignmentId,
      expectedAssignmentStateSequenceNumber: 1,
      expectedConflictSequenceNumber: 0,
      reason: "Synthetic reviewer conflict for custom rubric evidence.",
      idempotencyKey: "cfp11-custom-conflict",
    });
    expect(declared.outcome.effectId).toBeTruthy();
    expectReviewerCode(
      () => readOwnReviewAssignment(fixture.db, fixture.reviewerSession, {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
      }),
      "ASSIGNMENT_NOT_AVAILABLE",
    );
    expect(listOwnReviewAssignments(fixture.db, fixture.reviewerSession, {
      workspaceSlug: "northstar",
    })[0]).toMatchObject({ conflictStatus: "DECLARED", actionBlocked: true });

    const acmeWorkspace = fixture.db
      .prepare("SELECT id FROM workspaces WHERE slug = 'acme'")
      .get() as { id: string };
    const acmeReviewerId = "cfp11-acme-reviewer";
    fixture.db.prepare(
      `INSERT INTO accounts
         (id, workspace_id, email, display_name, role, created_at)
       VALUES (?, ?, ?, ?, 'reviewer', ?)`,
    ).run(
      acmeReviewerId,
      acmeWorkspace.id,
      "cfp11-acme-reviewer@synthetic.example",
      "Acme Reviewer",
      "2026-08-01T00:00:00.000Z",
    );
    const acmeSession = createSession(fixture.db, acmeReviewerId, acmeWorkspace.id).session;
    expectReviewerCode(
      () => readOwnReviewAssignment(fixture.db, acmeSession, {
        workspaceSlug: "acme",
        assignmentId: fixture.assignmentId,
      }),
      "ASSIGNMENT_NOT_AVAILABLE",
    );
  });

  it("issues a custom blind packet that supports reviewer completion without identity leakage", () => {
    const fixture = setup();
    const queue = listOwnReviewAssignments(fixture.db, fixture.reviewerSession, {
      workspaceSlug: "northstar",
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      assignmentId: fixture.assignmentId,
      assignmentState: "ASSIGNED",
      actionBlocked: false,
    });

    const detail = readOwnReviewAssignment(fixture.db, fixture.reviewerSession, {
      workspaceSlug: "northstar",
      assignmentId: fixture.assignmentId,
    });
    expect(detail.rubric.criteria.map((criterion) => [criterion.id, criterion.kind, criterion.weight])).toEqual([
      ["quality", "numeric", 2],
      ["recommendation", "dropdown", 1],
      ["notes", "text", 1],
    ]);
    expect(detail.proposal.answers).toEqual([
      {
        answerKey: "answer-0001",
        label: "Blind proposal",
        type: "longText",
        value: "A deliberately blinded proposal",
      },
    ]);
    const detailJson = JSON.stringify(detail);
    expect(detailJson).not.toContain("CFP-11 Applicant");
    expect(detailJson).not.toContain("Northstar Labs");
    expect(detailJson).not.toContain("cfp11-applicant@synthetic.example");

    const saved = saveOwnReview(fixture.db, fixture.reviewerSession, {
      workspaceSlug: "northstar",
      assignmentId: fixture.assignmentId,
      expectedAssignmentStateSequenceNumber: 1,
      expectedReviewRevisionNumber: 0,
      evaluation: {
        schema: "cfp-review-evaluation/v1",
        responses: [
          { criterionId: "quality", value: 8 },
          { criterionId: "recommendation", value: "ADVANCE" },
          { criterionId: "notes", value: "Proposal-focused evidence." },
        ],
      },
      idempotencyKey: "cfp11-custom-save",
    });
    expect(saved.outcome.reviewRevisionNumber).toBe(1);
    const submitted = submitOwnReview(fixture.db, fixture.reviewerSession, {
      workspaceSlug: "northstar",
      assignmentId: fixture.assignmentId,
      expectedAssignmentStateSequenceNumber: 2,
      expectedReviewRevisionNumber: 1,
      idempotencyKey: "cfp11-custom-submit",
    });
    expect(submitted.commandKind).toBe("SUBMIT_REVIEW");
    expect(readOwnReviewAssignment(fixture.db, fixture.reviewerSession, {
      workspaceSlug: "northstar",
      assignmentId: fixture.assignmentId,
    })).toMatchObject({ assignmentState: "SUBMITTED", latestReviewRevisionNumber: 1 });
  });
});
