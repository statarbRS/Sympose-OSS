import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "../../src/server/auth";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  createCall,
  createDraftSubmission,
  createFormDefinition,
  saveDraftRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import { OrganizerReviewConsole } from "../../src/components/cfp-review/organizer-review-console";
import {
  createOrganizerReviewRound,
  createOrganizerReviewRubric,
  readOrganizerReviewSurface,
  recordOrganizerReviewReminders,
} from "../../src/server/services/cfp-review/organizer";
import { recordOrganizerReviewRemindersAction } from "../../src/app/w/[workspace]/events/[eventId]/review/actions";

const EVENT_ID = "reminder-action-event";
const CALL_OPEN = "2026-08-01T09:00:00.000Z";
const CALL_CLOSE = "2026-09-15T09:00:00.000Z";

type Fixture = Readonly<{
  db: Db;
  organizer: SessionInfo;
  reviewer: SessionInfo;
  workspaceId: string;
  roundId: string;
  assignmentId: string;
}>;

function setup(): Fixture {
  const db = openDb({ path: ":memory:" });
  const workspace = db
    .prepare("SELECT id FROM workspaces WHERE slug = 'northstar'")
    .get() as { id: string };
  const organizerId = (
    db
      .prepare("SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' ORDER BY id LIMIT 1")
      .get(workspace.id) as { id: string }
  ).id;
  const reviewerId = "reminder-action-reviewer";
  db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, 'reviewer', ?)`,
  ).run(
    reviewerId,
    workspace.id,
    "reminder-reviewer@synthetic.example",
    "Reminder Reviewer",
    "2026-08-01T00:00:00.000Z",
  );
  const organizer = createSession(db, organizerId, workspace.id).session;
  const reviewer = createSession(db, reviewerId, workspace.id).session;

  db.prepare(
    `INSERT INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
  ).run(
    EVENT_ID,
    workspace.id,
    "Reminder action event",
    CALL_OPEN,
    CALL_CLOSE,
    "2026-07-01T00:00:00.000Z",
  );

  const context = { workspaceId: workspace.id, accountId: organizerId };
  const definition = createFormDefinition(db, context, { name: "Reminder action form" });
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
    name: "Reminder action call",
    slug: "reminder-action-call",
    formVersionId: form.id,
    state: "OPEN",
    timezone: "UTC",
    opensAt: CALL_OPEN,
    closesAt: CALL_CLOSE,
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

  const personId = "reminder-action-person";
  const verificationId = "reminder-action-verification";
  const applicantSessionId = "reminder-action-applicant-session";
  db.prepare(
    `INSERT INTO people
       (id, workspace_id, canonical_email, full_name, organization, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    personId,
    workspace.id,
    "applicant@synthetic.example",
    "Reminder Applicant",
    null,
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
    "applicant@synthetic.example",
    "1".repeat(64),
    "2099-09-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "reminder-action-consumption",
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
  const revision = saveDraftRevision(
    db,
    { workspaceId: workspace.id, sessionId: applicantSessionId },
    {
      submissionId: submission.id,
      expectedCurrentRevisionId: null,
      historicalAnswers: [{ fieldId: "proposal", value: "A reminder-safe proposal." }],
    },
  );
  db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(submission.id);

  const round = createOrganizerReviewRound(db, organizer, {
    workspaceSlug: "northstar",
    eventId: EVENT_ID,
    callId: call.id,
    name: "Reminder screening",
  });
  const rubric = createOrganizerReviewRubric(db, organizer, {
    workspaceSlug: "northstar",
    roundId: round.roundId,
    fields: [
      {
        id: "quality",
        label: "Proposal quality",
        kind: "numeric",
        required: true,
        weight: 1,
        minimum: 0,
        maximum: 10,
        step: 1,
      },
    ],
  });
  const assignmentId = "reminder-action-assignment";
  db.prepare(
    `INSERT INTO review_assignments
       (id, workspace_id, round_id, rubric_version_id, submission_id,
        submission_revision_id, reviewer_account_id, assigned_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    assignmentId,
    workspace.id,
    round.roundId,
    rubric.rubricVersionId,
    submission.id,
    revision.revisionId,
    reviewerId,
    organizerId,
    "2026-08-12T00:00:00.000Z",
  );

  return Object.freeze({
    db,
    organizer,
    reviewer,
    workspaceId: workspace.id,
    roundId: round.roundId,
    assignmentId,
  });
}

describe("organizer review reminder action", () => {
  it("records immutable local reminder evidence once for outstanding assignments", () => {
    const fixture = setup();
    try {
      const before = readOrganizerReviewSurface(fixture.db, fixture.organizer, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId: fixture.roundId,
      }).rounds[0]!;
      expect(before.reminders.map((reminder) => reminder.assignmentId)).toEqual([fixture.assignmentId]);
      expect(before.assignments[0]).toMatchObject({ assignmentState: "ASSIGNED", assignmentStateSequenceNumber: 1 });
      const consoleHtml = renderToStaticMarkup(createElement(OrganizerReviewConsole, {
        workspace: "northstar",
        surface: {
          workspaceId: fixture.workspaceId,
          workspaceSlug: "northstar",
          eventId: EVENT_ID,
          eventName: "Reminder action event",
          calls: [],
          rounds: [before],
          selectedRoundId: fixture.roundId,
          selectedSort: "rank",
        },
      }));
      expect(consoleHtml).toContain(`data-testid="record-review-reminders-${fixture.roundId}"`);
      expect(consoleHtml).toContain("Record simulated reminders");
      expect(consoleHtml).toContain("does not send email");

      const first = recordOrganizerReviewReminders(fixture.db, fixture.organizer, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId: fixture.roundId,
      });
      expect(first).toMatchObject({
        schema: "cfp-organizer-review-reminder/v1",
        workspaceId: fixture.workspaceId,
        eventId: EVENT_ID,
        roundId: fixture.roundId,
        providerMutation: false,
        replayed: false,
      });
      expect(first.outstandingAssignmentIds).toEqual([fixture.assignmentId]);
      expect(first.recordedAssignmentIds).toEqual([fixture.assignmentId]);
      expect(first.localEvidence[0]).toMatchObject({ kind: "REMINDER_PLANNED", roundId: fixture.roundId });
      const recordedDetails = fixture.db
        .prepare(
          `SELECT details_json AS detailsJson
           FROM audit_events
           WHERE workspace_id = ? AND action = 'cfp.review.local-evidence'
           ORDER BY rowid DESC LIMIT 1`,
        )
        .get(fixture.workspaceId) as { detailsJson: string };
      expect(JSON.parse(recordedDetails.detailsJson)).toMatchObject({
        kind: "REMINDER_PLANNED",
        payload: {
          assignmentId: fixture.assignmentId,
          channel: "local-evidence",
          providerMutation: false,
          trigger: "organizer-action",
        },
      });

      const auditCount = (
        fixture.db
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action = 'cfp.review.local-evidence'")
          .get(fixture.workspaceId) as { count: number }
      ).count;
      const replay = recordOrganizerReviewReminders(fixture.db, fixture.organizer, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId: fixture.roundId,
      });
      expect(replay).toMatchObject({ providerMutation: false, replayed: true });
      expect(replay.outstandingAssignmentIds).toEqual([fixture.assignmentId]);
      expect(replay.recordedAssignmentIds).toEqual([]);
      expect(replay.localEvidence).toEqual([]);
      expect(
        (fixture.db
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action = 'cfp.review.local-evidence'")
          .get(fixture.workspaceId) as { count: number }).count,
      ).toBe(auditCount);

      const after = readOrganizerReviewSurface(fixture.db, fixture.organizer, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId: fixture.roundId,
      }).rounds[0]!;
      expect(after.reminders).toHaveLength(1);
      expect(after.assignments[0]).toMatchObject({ assignmentState: "ASSIGNED", assignmentStateSequenceNumber: 1 });
      expect(after.localEvidence.filter((evidence) => evidence.kind === "REMINDER_PLANNED")).toHaveLength(1);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects reviewer and mismatched-event callers before recording evidence", () => {
    const fixture = setup();
    try {
      expect(() => recordOrganizerReviewReminders(fixture.db, fixture.reviewer, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId: fixture.roundId,
      })).toThrow(/Organizer review access is unavailable/);
      expect(() => recordOrganizerReviewReminders(fixture.db, fixture.organizer, {
        workspaceSlug: "northstar",
        eventId: "different-event",
        roundId: fixture.roundId,
      })).toThrow(/event is not available/i);
      expect(
        (fixture.db
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action = 'cfp.review.local-evidence'")
          .get(fixture.workspaceId) as { count: number }).count,
      ).toBe(0);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects malformed action form data before session or provider work", async () => {
    const result = await recordOrganizerReviewRemindersAction({ kind: "idle" }, new FormData());
    expect(result).toEqual({
      kind: "error",
      code: "INPUT_INVALID",
      message: "The review reminder request is invalid.",
    });
  });
});
