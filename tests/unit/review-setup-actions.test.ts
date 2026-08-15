import { describe, expect, it, vi } from "vitest";

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
import { readOrganizerReviewSurface } from "../../src/server/services/cfp-review/organizer";
import {
  createOrganizerReviewRoundAction,
  createOrganizerReviewRubricAction,
  distributeOrganizerReviewAssignmentsAction,
  setOrganizerReviewRoundScheduleAction,
} from "../../src/app/w/[workspace]/events/[eventId]/review/actions";

const mocks = vi.hoisted(() => {
  const state: { db: unknown; session: unknown } = { db: null, session: null };
  return {
    state,
    getDb: vi.fn(() => state.db),
    getRouteSession: vi.fn(async () => {
      if (state.session === null) throw new Error("session fixture is not configured");
      return state.session;
    }),
    requireOrganizerWorkspaceRoute: vi.fn((session: { workspaceSlug?: string; role?: string }, requested: string) => {
      if (
        session.workspaceSlug !== requested ||
        !["organizer", "workspace_admin", "event_manager", "program_manager"].includes(session.role ?? "")
      ) {
        throw new Error("__NOT_FOUND__");
      }
      return session;
    }),
    revalidatePath: vi.fn(),
  };
});

vi.mock("../../src/server/db", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/db")>("../../src/server/db");
  return { ...actual, getDb: mocks.getDb };
});
vi.mock("../../src/server/workspace-session", () => ({
  getRouteSession: mocks.getRouteSession,
  requireOrganizerWorkspaceRoute: mocks.requireOrganizerWorkspaceRoute,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const EVENT_ID = "review-setup-event";
const OPEN_AT = "2026-08-01T09:00:00.000Z";
const CLOSE_AT = "2026-09-15T09:00:00.000Z";

type Fixture = Readonly<{
  db: Db;
  organizer: SessionInfo;
  reviewer: SessionInfo;
  workspaceId: string;
  callId: string;
  submissionIds: readonly string[];
  reviewerIds: readonly string[];
}>;

function setup(): Fixture {
  const db = openDb({ path: ":memory:" });
  const workspace = db
    .prepare("SELECT id FROM workspaces WHERE slug = 'northstar'")
    .get() as { id: string };
  const organizerAccount = db
    .prepare(
      `SELECT id FROM accounts
       WHERE workspace_id = ? AND role = 'organizer'
       ORDER BY id LIMIT 1`,
    )
    .get(workspace.id) as { id: string };
  const reviewerIds = ["setup-reviewer-a", "setup-reviewer-b", "setup-reviewer-c"];
  reviewerIds.forEach((id, index) => {
    db.prepare(
      `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
       VALUES (?, ?, ?, ?, 'reviewer', ?)`,
    ).run(
      id,
      workspace.id,
      `${id}@synthetic.example`,
      `Setup Reviewer ${String.fromCharCode(65 + index)}`,
      "2026-08-01T00:00:00.000Z",
    );
  });
  const organizer = createSession(db, organizerAccount.id, workspace.id).session;
  const reviewer = createSession(db, reviewerIds[0]!, workspace.id).session;

  db.prepare(
    `INSERT INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, 'Review setup event', 'UTC', ?, ?, 'planning', ?)`,
  ).run(EVENT_ID, workspace.id, OPEN_AT, CLOSE_AT, "2026-07-01T00:00:00.000Z");

  const context = { workspaceId: workspace.id, accountId: organizerAccount.id };
  const definition = createFormDefinition(db, context, { name: "Review setup form" });
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
    name: "Review setup call",
    slug: "review-setup-call",
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
  for (const [index, suffix] of ["one", "two", "three"].entries()) {
    const personId = `setup-person-${suffix}`;
    const verificationId = `setup-verification-${suffix}`;
    const applicantSessionId = `setup-applicant-session-${suffix}`;
    db.prepare(
      `INSERT INTO people
         (id, workspace_id, canonical_email, full_name, organization, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      personId,
      workspace.id,
      `${suffix}@applicant.synthetic.example`,
      `Setup Applicant ${index + 1}`,
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
      `setup-consumption-${suffix}`,
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
    saveDraftRevision(
      db,
      { workspaceId: workspace.id, sessionId: applicantSessionId },
      {
        submissionId: submission.id,
        expectedCurrentRevisionId: null,
        historicalAnswers: [{ fieldId: "proposal", value: `Proposal ${index + 1}` }],
      },
    );
    db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(submission.id);
    submissionIds.push(submission.id);
  }

  return Object.freeze({
    db,
    organizer,
    reviewer,
    workspaceId: workspace.id,
    callId: call.id,
    submissionIds: Object.freeze(submissionIds),
    reviewerIds: Object.freeze(reviewerIds),
  });
}

function useFixture(fixture: Fixture, session = fixture.organizer): void {
  mocks.state.db = fixture.db;
  mocks.state.session = session;
  mocks.getDb.mockClear();
  mocks.getRouteSession.mockClear();
  mocks.requireOrganizerWorkspaceRoute.mockClear();
  mocks.revalidatePath.mockClear();
}

function reviewScheduleBusinessWrites(db: Db): Readonly<{
  rounds: number;
  schedules: number;
  creationReceipts: number;
  audits: number;
}> {
  const count = (sql: string): number =>
    (db.prepare(sql).get() as { count: number }).count;
  return Object.freeze({
    rounds: count("SELECT COUNT(*) AS count FROM review_rounds"),
    schedules: count("SELECT COUNT(*) AS count FROM review_round_schedule_versions"),
    creationReceipts: count("SELECT COUNT(*) AS count FROM review_round_creation_receipts"),
    audits: count(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action IN ('cfp.review.round.created', 'cfp.review.round.schedule.updated')`,
    ),
  });
}

function roundForm(fixture: Fixture, name = "Setup screening"): FormData {
  const form = new FormData();
  form.set("workspace", "northstar");
  form.set("eventId", EVENT_ID);
  form.set("callId", fixture.callId);
  form.set("name", name);
  form.set("opensAt", "2026-08-05T09:00");
  form.set("closesAt", "2026-09-10T09:00");
  form.set("idempotencyKey", "setup-round-replay");
  return form;
}

function scheduleForm(roundId: string, expectedVersion: number): FormData {
  const form = new FormData();
  form.set("workspace", "northstar");
  form.set("eventId", EVENT_ID);
  form.set("roundId", roundId);
  form.set("expectedScheduleVersion", String(expectedVersion));
  form.set("opensAt", "2026-08-06T09:00");
  form.set("closesAt", "2026-09-11T09:00");
  form.set("idempotencyKey", `schedule-action:${roundId}:${expectedVersion}`);
  return form;
}

function rubricForm(fixture: Fixture, roundId: string): FormData {
  const form = new FormData();
  form.set("workspace", "northstar");
  form.set("eventId", EVENT_ID);
  form.set("roundId", roundId);
  form.set(
    "fields",
    JSON.stringify([
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
        label: "Recommendation",
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
    ]),
  );
  form.set("idempotencyKey", "setup-rubric-replay");
  return form;
}

function distributionForm(fixture: Fixture, roundId: string): FormData {
  const form = new FormData();
  form.set("workspace", "northstar");
  form.set("eventId", EVENT_ID);
  form.set("roundId", roundId);
  form.set(
    "pools",
    JSON.stringify([
      {
        id: "bounded-reviewer-pool",
        reviewerAccountIds: fixture.reviewerIds.slice(0, 2),
        maxAssignments: 2,
      },
    ]),
  );
  form.set("submissionIds", JSON.stringify(fixture.submissionIds));
  form.set("reviewsPerSubmission", "2");
  form.set("maxAssignmentsPerReviewer", "1");
  form.set("strategy", "balanced");
  form.set(
    "blindArtifactDecisions",
    JSON.stringify(
      fixture.submissionIds.map((submissionId, index) => {
        const row = fixture.db
          .prepare("SELECT current_revision_id FROM submissions WHERE id = ?")
          .get(submissionId) as { current_revision_id: string };
        return {
          submissionId,
          submissionRevisionId: row.current_revision_id,
          decisions: [
            {
              sourceFieldId: "proposal",
              action: "INCLUDE_REDACTED",
              reviewLabel: "Blind proposal",
              redactedValue: `A blinded setup proposal ${index + 1}`,
            },
          ],
        };
      }),
    ),
  );
  form.set("idempotencyKey", "setup-distribution-replay");
  return form;
}

describe("organizer review setup actions", () => {
  it("creates a named round and scorecard, persists them, and revalidates the event review room", async () => {
    const fixture = setup();
    try {
      useFixture(fixture);
      const roundResult = await createOrganizerReviewRoundAction(
        { kind: "idle" },
        roundForm(fixture),
      );
      expect(roundResult.kind).toBe("success");
      if (roundResult.kind !== "success") throw new Error("round action did not succeed");
      expect(roundResult.receipt).toMatchObject({
        state: "DRAFT",
        scheduleSource: "round",
        scheduleVersion: 2,
        timezone: "UTC",
        opensAt: "2026-08-05T09:00:00.000Z",
        closesAt: "2026-09-10T09:00:00.000Z",
        replayed: false,
      });
      expect(roundResult.revalidated).toBe(true);

      const initialScheduleVersion = roundResult.receipt.scheduleVersion;
      if (initialScheduleVersion === undefined) {
        throw new Error("round action did not return a schedule version");
      }
      const scheduleResult = await setOrganizerReviewRoundScheduleAction(
        { kind: "idle" },
        scheduleForm(roundResult.receipt.roundId, initialScheduleVersion),
      );
      expect(scheduleResult).toMatchObject({
        kind: "success",
        receipt: {
          roundId: roundResult.receipt.roundId,
          scheduleVersion: 3,
          timezone: "UTC",
          opensAt: "2026-08-06T09:00:00.000Z",
          closesAt: "2026-09-11T09:00:00.000Z",
          replayed: false,
        },
      });

      const rubricResult = await createOrganizerReviewRubricAction(
        { kind: "idle" },
        rubricForm(fixture, roundResult.receipt.roundId),
      );
      expect(rubricResult.kind).toBe("success");
      if (rubricResult.kind !== "success") throw new Error("rubric action did not succeed");
      expect(rubricResult.receipt.fields.map((field) => field.kind)).toEqual([
        "numeric",
        "dropdown",
        "text",
      ]);

      const surface = readOrganizerReviewSurface(fixture.db, fixture.organizer, {
        workspaceSlug: "northstar",
        eventId: EVENT_ID,
        roundId: roundResult.receipt.roundId,
      });
      expect(surface.rounds[0]).toMatchObject({
        id: roundResult.receipt.roundId,
        name: "Setup screening",
        state: "DRAFT",
        schedule: {
          source: "round",
          version: 3,
          timezone: "UTC",
          opensAt: "2026-08-06T09:00:00.000Z",
          closesAt: "2026-09-11T09:00:00.000Z",
        },
      });
      expect(surface.rounds[0]?.rubric?.fields.map((field) => [field.id, field.weight])).toEqual([
        ["quality", 2],
        ["recommendation", 1],
        ["notes", 1],
      ]);
      expect(mocks.revalidatePath).toHaveBeenCalledWith(
        `/w/northstar/events/${encodeURIComponent(EVENT_ID)}/review`,
      );
    } finally {
      closeDb(fixture.db);
    }
  });

  it("fails closed without business writes for invalid, stale, or wrongly scoped schedule updates", async () => {
    const fixture = setup();
    try {
      useFixture(fixture);
      const created = await createOrganizerReviewRoundAction({ kind: "idle" }, roundForm(fixture));
      if (created.kind !== "success" || created.receipt.scheduleVersion === undefined) {
        throw new Error("round action did not return a versioned schedule");
      }
      const roundId = created.receipt.roundId;
      const initialVersion = created.receipt.scheduleVersion;
      const beforeInvalid = reviewScheduleBusinessWrites(fixture.db);
      const invalidForms: FormData[] = [];

      const missing = scheduleForm(roundId, initialVersion);
      missing.delete("closesAt");
      invalidForms.push(missing);
      const malformed = scheduleForm(roundId, initialVersion);
      malformed.set("opensAt", "not-a-date");
      invalidForms.push(malformed);
      const equal = scheduleForm(roundId, initialVersion);
      equal.set("closesAt", "2026-08-06T09:00");
      invalidForms.push(equal);
      const reversed = scheduleForm(roundId, initialVersion);
      reversed.set("opensAt", "2026-09-12T09:00");
      invalidForms.push(reversed);

      for (const form of invalidForms) {
        mocks.getRouteSession.mockClear();
        expect(await setOrganizerReviewRoundScheduleAction({ kind: "idle" }, form)).toMatchObject({
          kind: "error",
          code: "INPUT_INVALID",
        });
        expect(mocks.getRouteSession).not.toHaveBeenCalled();
        expect(reviewScheduleBusinessWrites(fixture.db)).toEqual(beforeInvalid);
      }

      const updated = await setOrganizerReviewRoundScheduleAction(
        { kind: "idle" },
        scheduleForm(roundId, initialVersion),
      );
      if (updated.kind !== "success") throw new Error("schedule action did not succeed");
      const afterUpdate = reviewScheduleBusinessWrites(fixture.db);

      const stale = scheduleForm(roundId, initialVersion);
      stale.set("idempotencyKey", "schedule-action-stale");
      stale.set("closesAt", "2026-09-12T09:00");
      expect(await setOrganizerReviewRoundScheduleAction({ kind: "idle" }, stale)).toMatchObject({
        kind: "error",
        code: "ROUND_SCHEDULE_STALE",
      });
      expect(reviewScheduleBusinessWrites(fixture.db)).toEqual(afterUpdate);

      const crossWorkspace = scheduleForm(roundId, updated.receipt.scheduleVersion);
      crossWorkspace.set("workspace", "southridge");
      crossWorkspace.set("idempotencyKey", "schedule-action-cross-workspace");
      await expect(
        setOrganizerReviewRoundScheduleAction({ kind: "idle" }, crossWorkspace),
      ).rejects.toThrow("__NOT_FOUND__");
      expect(reviewScheduleBusinessWrites(fixture.db)).toEqual(afterUpdate);

      const wrongEvent = scheduleForm(roundId, updated.receipt.scheduleVersion);
      wrongEvent.set("eventId", "missing-event");
      wrongEvent.set("idempotencyKey", "schedule-action-wrong-event");
      expect(await setOrganizerReviewRoundScheduleAction({ kind: "idle" }, wrongEvent)).toMatchObject({
        kind: "error",
        code: "EVENT_NOT_AVAILABLE",
      });
      expect(reviewScheduleBusinessWrites(fixture.db)).toEqual(afterUpdate);

      const wrongRound = scheduleForm("missing-round", updated.receipt.scheduleVersion);
      wrongRound.set("idempotencyKey", "schedule-action-wrong-round");
      expect(await setOrganizerReviewRoundScheduleAction({ kind: "idle" }, wrongRound)).toMatchObject({
        kind: "error",
        code: "ROUND_NOT_AVAILABLE",
      });
      expect(reviewScheduleBusinessWrites(fixture.db)).toEqual(afterUpdate);
      expect(
        fixture.db.prepare("SELECT id, name FROM review_rounds WHERE id = ?").get(roundId),
      ).toEqual({ id: roundId, name: "Setup screening" });
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects malformed or over-cardinality form data before session or database work", async () => {
    const fixture = setup();
    try {
      useFixture(fixture);
      const duplicateRound = roundForm(fixture);
      duplicateRound.append("name", "unexpected duplicate");
      const roundResult = await createOrganizerReviewRoundAction({ kind: "idle" }, duplicateRound);
      expect(roundResult).toEqual({
        kind: "error",
        code: "INPUT_INVALID",
        message: "The review round request is invalid.",
      });
      expect(mocks.getRouteSession).not.toHaveBeenCalled();
      expect(
        (fixture.db.prepare("SELECT COUNT(*) AS count FROM review_rounds").get() as { count: number }).count,
      ).toBe(0);

      const badDates = roundForm(fixture, "Bad dates");
      badDates.set("opensAt", "2026-09-12T09:00");
      badDates.set("closesAt", "2026-09-11T09:00");
      expect(await createOrganizerReviewRoundAction({ kind: "idle" }, badDates)).toMatchObject({
        kind: "error",
        code: "INPUT_INVALID",
      });
      expect(mocks.getRouteSession).not.toHaveBeenCalled();
      expect(
        (fixture.db.prepare("SELECT COUNT(*) AS count FROM review_rounds").get() as { count: number }).count,
      ).toBe(0);

      const badRubric = new FormData();
      badRubric.set("workspace", "northstar");
      badRubric.set("eventId", EVENT_ID);
      badRubric.set("roundId", "missing-round");
      badRubric.set(
        "fields",
        JSON.stringify([
          {
            id: "quality",
            label: "Quality",
            kind: "numeric",
            required: true,
            weight: 1,
            choices: [{ value: "bad", label: "Bad" }],
          },
        ]),
      );
      const rubricResult = await createOrganizerReviewRubricAction({ kind: "idle" }, badRubric);
      expect(rubricResult.kind).toBe("error");
      expect(mocks.getRouteSession).not.toHaveBeenCalled();

      const missingPool = new FormData();
      missingPool.set("workspace", "northstar");
      missingPool.set("eventId", EVENT_ID);
      missingPool.set("roundId", "missing-round");
      const distributionResult = await distributeOrganizerReviewAssignmentsAction(
        { kind: "idle" },
        missingPool,
      );
      expect(distributionResult).toMatchObject({ kind: "error", code: "INPUT_INVALID" });
      expect(mocks.getRouteSession).not.toHaveBeenCalled();
    } finally {
      closeDb(fixture.db);
    }
  });

  it("denies a cross-tenant route and a reviewer before organizer setup work", async () => {
    const fixture = setup();
    try {
      useFixture(fixture);
      const crossTenant = roundForm(fixture);
      crossTenant.set("workspace", "southridge");
      await expect(
        createOrganizerReviewRoundAction({ kind: "idle" }, crossTenant),
      ).rejects.toThrow("__NOT_FOUND__");
      expect(
        (fixture.db.prepare("SELECT COUNT(*) AS count FROM review_rounds").get() as { count: number }).count,
      ).toBe(0);

      useFixture(fixture, fixture.reviewer);
      await expect(
        createOrganizerReviewRoundAction({ kind: "idle" }, roundForm(fixture, "Reviewer attempt")),
      ).rejects.toThrow("__NOT_FOUND__");
      expect(
        (fixture.db.prepare("SELECT COUNT(*) AS count FROM review_rounds").get() as { count: number }).count,
      ).toBe(0);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("replays setup idempotently and never exceeds the explicit reviewer-pool cap", async () => {
    const fixture = setup();
    try {
      useFixture(fixture);
      const firstRound = await createOrganizerReviewRoundAction({ kind: "idle" }, roundForm(fixture));
      if (firstRound.kind !== "success") throw new Error("round action did not succeed");
      const replayedRound = await createOrganizerReviewRoundAction({ kind: "idle" }, roundForm(fixture));
      expect(replayedRound).toMatchObject({ kind: "success", receipt: { replayed: true } });

      const rubric = await createOrganizerReviewRubricAction(
        { kind: "idle" },
        rubricForm(fixture, firstRound.receipt.roundId),
      );
      if (rubric.kind !== "success") throw new Error("rubric action did not succeed");

      const firstDistribution = await distributeOrganizerReviewAssignmentsAction(
        { kind: "idle" },
        distributionForm(fixture, firstRound.receipt.roundId),
      );
      expect(firstDistribution.kind).toBe("success");
      if (firstDistribution.kind !== "success") throw new Error("distribution action did not succeed");
      expect(firstDistribution.receipt.createdAssignmentIds).toHaveLength(2);
      expect(firstDistribution.receipt.plan.skippedSubmissionIds).toHaveLength(2);

      const assignmentCount = (
        fixture.db
          .prepare("SELECT COUNT(*) AS count FROM review_assignments WHERE round_id = ?")
          .get(firstRound.receipt.roundId) as { count: number }
      ).count;
      expect(assignmentCount).toBe(2);
      const loadRows = fixture.db
        .prepare(
          `SELECT reviewer_account_id AS reviewerAccountId, COUNT(*) AS count
           FROM review_assignments
           WHERE round_id = ?
           GROUP BY reviewer_account_id`,
        )
        .all(firstRound.receipt.roundId) as Array<{ reviewerAccountId: string; count: number }>;
      expect(loadRows.map((row) => row.count)).toEqual([1, 1]);

      const replayedDistribution = await distributeOrganizerReviewAssignmentsAction(
        { kind: "idle" },
        distributionForm(fixture, firstRound.receipt.roundId),
      );
      expect(replayedDistribution).toMatchObject({
        kind: "success",
        receipt: { replayed: true, createdAssignmentIds: [] },
      });
      expect(
        (fixture.db
          .prepare("SELECT COUNT(*) AS count FROM review_assignments WHERE round_id = ?")
          .get(firstRound.receipt.roundId) as { count: number }).count,
      ).toBe(2);
    } finally {
      closeDb(fixture.db);
    }
  });
});
