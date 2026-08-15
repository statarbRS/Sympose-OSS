import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ServiceError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(code);
      this.name = "ReviewerServiceError";
      this.code = code;
    }
  }

  class FatalError extends Error {
    readonly fatal = true;

    constructor() {
      super("fatal reviewer service boundary");
      this.name = "ReviewerServiceFatalError";
    }
  }

  const session = {
    id: "session-reviewer-ui",
    tokenHash: "a".repeat(64),
    accountId: "account-reviewer-ui",
    workspaceId: "workspace-reviewer-ui",
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: "reviewer@synthetic.example",
    displayName: "Rae Viewer",
    role: "reviewer",
    workspaceSlug: "northstar",
    workspaceName: "Northstar Network",
  };

  return {
    ServiceError,
    FatalError,
    session,
    db: { reviewerUiDb: true },
    getDb: vi.fn(),
    closeDb: vi.fn(),
    getRouteSession: vi.fn(),
    requireReviewerWorkspaceRoute: vi.fn(),
    list: vi.fn(),
    read: vi.fn(),
    declareConflict: vi.fn(),
    clearConflict: vi.fn(),
    save: vi.fn(),
    submit: vi.fn(),
    revalidatePath: vi.fn(),
    revokeSession: vi.fn(),
    cookieStore: {
      get: vi.fn(() => ({ value: "synthetic-session-token" })),
      delete: vi.fn(),
    },
    redirect: vi.fn((destination: string): never => {
      throw new Error(`TEST_REDIRECT:${destination}`);
    }),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => mocks.cookieStore) }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: vi.fn((): never => {
    throw new Error("TEST_NOT_FOUND");
  }),
}));
vi.mock("@/server/auth", () => ({
  SESSION_COOKIE: "sympose_session",
  revokeSession: mocks.revokeSession,
}));
vi.mock("@/server/db", () => ({
  getDb: mocks.getDb,
  closeDb: mocks.closeDb,
}));
vi.mock("@/server/workspace-session", () => ({
  getRouteSession: mocks.getRouteSession,
  requireReviewerWorkspaceRoute: mocks.requireReviewerWorkspaceRoute,
}));
vi.mock("@/server/services/cfp-review", () => ({
  CFP_REVIEW_EVALUATION_SCHEMA: "cfp-review-evaluation/v1",
  ReviewerServiceError: mocks.ServiceError,
  ReviewerServiceFatalError: mocks.FatalError,
  listOwnReviewAssignments: mocks.list,
  readOwnReviewAssignment: mocks.read,
  declareOwnReviewConflict: mocks.declareConflict,
  clearOwnReviewConflict: mocks.clearConflict,
  saveOwnReview: mocks.save,
  submitOwnReview: mocks.submit,
}));

import {
  clearReviewerConflictAction,
  declareReviewerConflictAction,
  saveReviewerRevisionAction,
  submitReviewerRevisionAction,
} from "../../src/app/review/actions";
import ReviewerAssignmentPage from "../../src/app/review/[workspace]/assignments/[assignmentId]/page";
import ReviewerWorkspaceLayout from "../../src/app/review/[workspace]/layout";
import ReviewerQueuePage from "../../src/app/review/[workspace]/queue/page";
import {
  issueConflictActionBinding,
  issueReviewActionBinding,
  verifyReviewerActionBinding,
} from "../../src/app/review/reviewer-binding.server";
import {
  ConflictBlockedAssignment,
  ReviewAssignment,
} from "../../src/components/cfp-review/review-assignment";
import { ReviewerQueue } from "../../src/components/cfp-review/reviewer-queue";
import {
  IDLE_REVIEWER_ACTION_STATE,
  type ReviewerActionState,
} from "../../src/components/cfp-review/contracts";
import type {
  OwnReviewAssignmentDetail,
  OwnReviewAssignmentSummary,
} from "../../src/server/services/cfp-review";

const PROHIBITED_EMAIL = "applicant-secret@identity.example";
const PROHIBITED_NAME = "Applicant Secret Name";
const PROHIBITED_HISTORY = "unredacted historical answer";

const summary: OwnReviewAssignmentSummary = {
  assignmentId: "assignment-reviewer-ui",
  roundName: "Community review round",
  assignedAt: "2026-08-11T09:00:00.000Z",
  assignmentState: "ASSIGNED",
  assignmentStateSequenceNumber: 1,
  conflictStatus: "NONE",
  conflictSequenceNumber: 0,
  latestReviewRevisionNumber: 0,
  actionBlocked: false,
};

const detail: OwnReviewAssignmentDetail = {
  ...summary,
  proposal: {
    revisionSequence: 3,
    disclosureStage: "BLIND_REVIEW",
    answers: [
      {
        answerKey: "answer-safe-summary",
        label: "Proposal summary",
        type: "longText",
        value: "A blind-safe community workshop proposal.",
      },
      {
        answerKey: "answer-safe-format",
        label: "Session format",
        type: "singleChoice",
        value: "Workshop",
      },
      {
        answerKey: "answer-safe-topics",
        label: "Topics",
        type: "multipleChoice",
        value: ["Accessibility", "Local community"],
      },
    ],
  },
  rubric: {
    schema: "cfp-rubric/v1",
    title: "Independent proposal review",
    versionId: "rubric-reviewer-ui-v1",
    versionNumber: 1,
    judgmentAuthority: "independent-review-evidence",
    criteria: [
      {
        id: "criterion-0001",
        kind: "numeric",
        label: "Proposal quality",
        guidance: "Assess the proposal as presented.",
        required: true,
        weight: 2,
        minimum: 1,
        maximum: 5,
        step: 1,
      },
      {
        id: "criterion-0002",
        kind: "scale",
        label: "Audience relevance",
        guidance: "Assess relevance to the stated audience.",
        required: true,
        weight: 1,
        choices: [
          { value: "LOW", label: "Low" },
          { value: "MEDIUM", label: "Medium" },
          { value: "HIGH", label: "High" },
        ],
      },
      {
        id: "criterion-0003",
        kind: "yesNo",
        label: "Claims supported",
        guidance: "Record whether material claims are supported.",
        required: true,
        weight: 1,
      },
      {
        id: "criterion-0004",
        kind: "recommendation",
        label: "Independent recommendation",
        guidance: "This is evidence, not a program decision.",
        required: true,
        weight: 1,
        choices: [
          { value: "ADVANCE", label: "Advance for further consideration" },
          { value: "HOLD", label: "Hold for further consideration" },
          {
            value: "DO_NOT_ADVANCE",
            label: "Do not advance for further consideration",
          },
        ],
      },
      {
        id: "criterion-0005",
        kind: "comment",
        label: "Reviewer notes",
        guidance: "Record proposal-focused evidence only.",
        required: false,
        weight: 0,
        maxLength: 500,
      },
    ],
  },
  latestReview: null,
};

function reviewerForm(): FormData {
  const formData = new FormData();
  formData.set("criterion:criterion-0001", "4");
  formData.set("criterion:criterion-0002", "HIGH");
  formData.set("criterion:criterion-0003", "true");
  formData.set("criterion:criterion-0004", "ADVANCE");
  formData.set("criterion:criterion-0005", "Strong proposal evidence.");
  return formData;
}

function reviewerSourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue(mocks.db);
  mocks.getRouteSession.mockResolvedValue(mocks.session);
  mocks.list.mockReturnValue([summary]);
  mocks.read.mockReturnValue(detail);
  mocks.save.mockReturnValue({
    schema: "cfp-review-command-receipt/v1",
    commandKind: "SAVE_REVIEW",
    effectId: "effect-not-for-ui",
    createdAt: "2026-08-11T10:00:00.000Z",
    outcome: {
      reviewRevisionId: "revision-id-not-for-ui",
      reviewRevisionNumber: 1,
    },
  });
  mocks.declareConflict.mockReturnValue({ commandKind: "CONFLICT_DECLARE" });
  mocks.clearConflict.mockReturnValue({ commandKind: "CONFLICT_CLEAR" });
  mocks.submit.mockReturnValue({ commandKind: "SUBMIT_REVIEW" });
});

describe("reviewer console UI contract", () => {
  it("renders a dedicated reviewer shell with only reviewer navigation and identity", async () => {
    const element = await ReviewerWorkspaceLayout({
      children: createElement("p", null, "Reviewer child"),
      params: Promise.resolve({ workspace: "northstar" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Sympose");
    expect(html).toContain("Review console");
    expect(html).toContain("Northstar Network");
    expect(html).toContain("Rae Viewer");
    expect(html).toContain("reviewer@synthetic.example");
    expect(html).toContain("Your review queue");
    expect(html).toContain("Sign out");
    expect(html).toContain("Evaluation is evidence, not organizer authority.");
    expect(html).toContain("only an authorized organizer can decide, assign, invite, or publish");
    expect(html).not.toContain("Organizer console");
    expect(html).not.toContain("Dashboard");
    expect(html).not.toContain("Applicant portal");
    expect(html).not.toContain("Program selection");
    expect(mocks.requireReviewerWorkspaceRoute).toHaveBeenCalledWith(
      mocks.session,
      "northstar",
    );
  });

  it("renders only D2 own-queue metadata and words for every status", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewerQueue, {
        workspace: "northstar",
        assignments: [summary, { ...summary, assignmentId: "assignment-submitted", assignmentState: "SUBMITTED", latestReviewRevisionNumber: 2, actionBlocked: true }],
      }),
    );

    expect(html).toContain("Community review round");
    expect(html).toContain("Ready to review");
    expect(html).toContain("Submitted");
    expect(html).toContain("Latest review revision");
    expect(html).not.toContain(PROHIBITED_EMAIL);
    expect(html).not.toContain(PROHIBITED_NAME);
    expect(html).not.toContain(PROHIBITED_HISTORY);
  });

  it("renders every accepted criterion kind and only the supplied blind-safe proposal", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewAssignment, {
        bindingToken: "opaque-server-binding",
        detail,
        workspace: "northstar",
      }),
    );

    expect(html).toContain("A blind-safe community workshop proposal.");
    expect(html).toContain("Accessibility");
    expect(html).toContain("Proposal revision sequence");
    expect(html).toContain("rubric-reviewer-ui-v1");
    expect(html).toContain("Proposal quality");
    expect(html).toContain("Enter 1–5 in steps of 1");
    expect(html).toContain("Audience relevance");
    expect(html).toContain("Claims supported");
    expect(html).toContain("Advance for further consideration");
    expect(html).toContain("Reviewer notes");
    expect(html).toContain("Required · Weight 2");
    expect(html).toContain("Optional · Weight 0");
    expect(html).toContain("not selection authority");
    expect(html).not.toContain(PROHIBITED_EMAIL);
    expect(html).not.toContain(PROHIBITED_NAME);
    expect(html).not.toContain(PROHIBITED_HISTORY);
    expect(html).not.toContain("sourceFieldId");
    expect(html).not.toContain("fingerprint");
  });

  it("keeps proposal reading primary while disclosing technical and rubric context", () => {
    const assignmentHtml = renderToStaticMarkup(
      createElement(ReviewAssignment, {
        bindingToken: "opaque-server-binding",
        detail,
        workspace: "northstar",
      }),
    );
    const proposalPosition = assignmentHtml.indexOf('id="proposal-title"');
    const rubricPosition = assignmentHtml.indexOf('id="rubric-title"');

    expect(proposalPosition).toBeGreaterThan(-1);
    expect(proposalPosition).toBeLessThan(rubricPosition);
    expect(assignmentHtml).toContain(
      '<details class="review-binding"><summary>Technical review context</summary>',
    );
    expect(assignmentHtml).toContain(
      '<details class="review-conflict__disclosure"><summary id="declare-conflict-title">Declare a conflict before reviewing</summary>',
    );
    expect(assignmentHtml).toContain('name="criterion:criterion-0004"');
    expect(assignmentHtml).toContain('id="review-field-criterion-0003"');
  });

  it("keeps the queue compact and labels all returned assignments without fake activity state", () => {
    const queueHtml = renderToStaticMarkup(
      createElement(ReviewerQueue, {
        workspace: "northstar",
        assignments: [summary, { ...summary, assignmentId: "assignment-submitted", assignmentState: "SUBMITTED", latestReviewRevisionNumber: 2, actionBlocked: true }],
      }),
    );

    expect(queueHtml).toContain('aria-label="Your review assignments"');
    expect(queueHtml).toContain("Review assignment 1 of 2");
    expect(queueHtml).toContain("Review assignment 2 of 2");
    expect(queueHtml).not.toContain("active review assignments");
  });

  it("gives a declared-conflict component no proposal or rubric payload", () => {
    const blocked = {
      ...summary,
      conflictStatus: "DECLARED" as const,
      conflictSequenceNumber: 1,
      actionBlocked: true,
    };
    const html = renderToStaticMarkup(
      createElement(ConflictBlockedAssignment, {
        assignment: blocked,
        bindingToken: "opaque-conflict-binding",
        workspace: "northstar",
      }),
    );

    expect(html).toContain("Conflict declared — content withheld");
    expect(html).toContain("Clear conflict and refresh");
    expect(html).not.toContain("A blind-safe community workshop proposal.");
    expect(html).not.toContain("Proposal quality");
    expect(html).not.toContain("rubric-reviewer-ui-v1");
  });

  it("session-signs exact bindings and rejects tampering or a different session", () => {
    const token = issueReviewActionBinding(mocks.session, detail);
    expect(verifyReviewerActionBinding(token, mocks.session)).toMatchObject({
      kind: "review",
      assignmentId: detail.assignmentId,
      assignmentStateSequenceNumber: 1,
      conflictSequenceNumber: 0,
      reviewRevisionNumber: 0,
      proposalRevisionSequence: 3,
      rubricVersionId: "rubric-reviewer-ui-v1",
      rubricVersionNumber: 1,
    });
    expect(verifyReviewerActionBinding(`${token.slice(0, -1)}0`, mocks.session)).toBeNull();
    expect(
      verifyReviewerActionBinding(token, {
        ...mocks.session,
        tokenHash: "b".repeat(64),
      }),
    ).toBeNull();
  });

  it("saves a new revision against signed server facts and ignores posted state facts", async () => {
    const token = issueReviewActionBinding(mocks.session, detail);
    const formData = reviewerForm();
    formData.set("reviewRevisionNumber", "999");
    formData.set("assignmentStateSequenceNumber", "999");
    formData.set("rubricVersionId", "attacker-rubric");
    formData.set("proposalRevisionSequence", "999");

    const state = await saveReviewerRevisionAction(
      token,
      IDLE_REVIEWER_ACTION_STATE,
      formData,
    );

    expect(state).toMatchObject({
      kind: "saved",
      receipt: {
        reviewRevisionNumber: 1,
        completeness: "Complete",
        submissionStatus: "In progress",
        proposalRevisionSequence: 3,
        rubricVersionId: "rubric-reviewer-ui-v1",
        rubricVersionNumber: 1,
      },
    });
    expect(mocks.save).toHaveBeenCalledWith(
      mocks.db,
      mocks.session,
      expect.objectContaining({
        workspaceSlug: "northstar",
        assignmentId: detail.assignmentId,
        expectedAssignmentStateSequenceNumber: 1,
        expectedReviewRevisionNumber: 0,
        evaluation: {
          schema: "cfp-review-evaluation/v1",
          responses: [
            { criterionId: "criterion-0001", value: 4 },
            { criterionId: "criterion-0002", value: "HIGH" },
            { criterionId: "criterion-0003", value: true },
            { criterionId: "criterion-0004", value: "ADVANCE" },
            { criterionId: "criterion-0005", value: "Strong proposal evidence." },
          ],
        },
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(JSON.stringify(state)).not.toContain("effect-not-for-ui");
    expect(JSON.stringify(state)).not.toContain("revision-id-not-for-ui");
  });

  it("requires explicit reconciliation when a signed review write is stale", async () => {
    const token = issueReviewActionBinding(mocks.session, detail);
    mocks.save.mockImplementation(() => {
      throw new mocks.ServiceError("REVIEW_STATE_STALE");
    });

    const state = await saveReviewerRevisionAction(
      token,
      IDLE_REVIEWER_ACTION_STATE,
      reviewerForm(),
    );

    expect(state).toMatchObject({
      kind: "stale",
      code: "REVIEW_STATE_STALE",
      draftValues: {
        "criterion-0001": "4",
        "criterion-0002": "HIGH",
        "criterion-0003": "true",
        "criterion-0004": "ADVANCE",
        "criterion-0005": "Strong proposal evidence.",
      },
    });
    if (state.kind !== "stale") throw new Error("expected stale reviewer action state");
    expect(state.message).toContain("explicitly reconcile");
    expect(mocks.save).toHaveBeenCalledWith(
      mocks.db,
      mocks.session,
      expect.objectContaining({
        expectedAssignmentStateSequenceNumber: 1,
        expectedReviewRevisionNumber: 0,
      }),
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not retarget a save after any assignment, review, proposal, rubric, or conflict binding changes", async () => {
    const token = issueReviewActionBinding(mocks.session, detail);
    for (const changed of [
      { ...detail, assignmentStateSequenceNumber: 2 },
      { ...detail, latestReviewRevisionNumber: 1 },
      { ...detail, proposal: { ...detail.proposal, revisionSequence: 4 } },
      { ...detail, rubric: { ...detail.rubric, versionId: "rubric-reviewer-ui-v2", versionNumber: 2 } },
      { ...detail, conflictStatus: "CLEARED" as const, conflictSequenceNumber: 2 },
    ]) {
      mocks.read.mockReturnValueOnce(changed);
      const state = await saveReviewerRevisionAction(
        token,
        IDLE_REVIEWER_ACTION_STATE,
        reviewerForm(),
      );
      expect(state).toMatchObject({ kind: "stale" });
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("forces a content-free refresh when a concurrent conflict blocks a save", async () => {
    const token = issueReviewActionBinding(mocks.session, detail);
    mocks.read.mockImplementationOnce(() => {
      throw new mocks.ServiceError("ASSIGNMENT_NOT_AVAILABLE");
    });
    mocks.list.mockReturnValueOnce([
      {
        ...summary,
        conflictStatus: "DECLARED",
        conflictSequenceNumber: 1,
        actionBlocked: true,
      },
    ]);

    const state = await saveReviewerRevisionAction(
      token,
      IDLE_REVIEWER_ACTION_STATE,
      reviewerForm(),
    );

    expect(state).toMatchObject({ kind: "reload", code: "CONFLICT_DECLARED" });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/review/northstar/assignments/${detail.assignmentId}`,
    );
  });

  it("declares and clears conflict with signed authoritative sequence numbers", async () => {
    const clearedDetail = {
      ...detail,
      conflictStatus: "CLEARED" as const,
      conflictSequenceNumber: 2,
    };
    const declareToken = issueReviewActionBinding(mocks.session, clearedDetail);
    const reason = new FormData();
    reason.set("conflictReason", "Prior collaboration affects independence.");
    const declared = await declareReviewerConflictAction(
      declareToken,
      IDLE_REVIEWER_ACTION_STATE,
      reason,
    );
    expect(declared).toMatchObject({ kind: "conflict-declared" });
    expect(mocks.declareConflict).toHaveBeenCalledWith(
      mocks.db,
      mocks.session,
      expect.objectContaining({
        expectedAssignmentStateSequenceNumber: 1,
        expectedConflictSequenceNumber: 2,
      }),
    );

    const blocked = {
      ...summary,
      conflictStatus: "DECLARED" as const,
      conflictSequenceNumber: 3,
      actionBlocked: true,
    };
    const clearToken = issueConflictActionBinding(mocks.session, blocked);
    mocks.read.mockReturnValue(clearedDetail);
    const clearReason = new FormData();
    clearReason.set("conflictReason", "The collaboration ended and no material conflict remains.");
    const cleared = await clearReviewerConflictAction(
      clearToken,
      IDLE_REVIEWER_ACTION_STATE,
      clearReason,
    );
    expect(cleared).toMatchObject({ kind: "conflict-cleared" });
    expect(mocks.clearConflict).toHaveBeenCalledWith(
      mocks.db,
      mocks.session,
      expect.objectContaining({
        expectedAssignmentStateSequenceNumber: 1,
        expectedConflictSequenceNumber: 3,
      }),
    );
    expect(mocks.read).toHaveBeenCalledAfter(mocks.clearConflict);
  });

  it("submits only the exact latest saved revision and returns a narrow terminal receipt", async () => {
    const savedDetail: OwnReviewAssignmentDetail = {
      ...detail,
      assignmentState: "IN_PROGRESS",
      assignmentStateSequenceNumber: 2,
      latestReviewRevisionNumber: 1,
      latestReview: {
        revisionNumber: 1,
        savedAt: "2026-08-11T10:00:00.000Z",
        evaluation: {
          schema: "cfp-review-evaluation/v1",
          responses: [
            { criterionId: "criterion-0001", value: 4 },
            { criterionId: "criterion-0002", value: "HIGH" },
            { criterionId: "criterion-0003", value: true },
            { criterionId: "criterion-0004", value: "ADVANCE" },
          ],
        },
      },
    };
    mocks.read.mockReturnValue(savedDetail);
    const token = issueReviewActionBinding(mocks.session, savedDetail);
    const state = await submitReviewerRevisionAction(
      token,
      IDLE_REVIEWER_ACTION_STATE,
      new FormData(),
    );

    expect(state).toMatchObject({
      kind: "submitted",
      receipt: {
        reviewRevisionNumber: 1,
        completeness: "Complete",
        submissionStatus: "Submitted",
        proposalRevisionSequence: 3,
        rubricVersionId: "rubric-reviewer-ui-v1",
      },
    });
    expect(mocks.submit).toHaveBeenCalledWith(
      mocks.db,
      mocks.session,
      expect.objectContaining({
        expectedAssignmentStateSequenceNumber: 2,
        expectedReviewRevisionNumber: 1,
      }),
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("collapses unavailable, wrong-reviewer, revoked, and nonexistent detail reads", async () => {
    const rendered: string[] = [];
    mocks.list.mockReturnValue([]);
    for (const code of [
      "ACCESS_DENIED",
      "ASSIGNMENT_NOT_AVAILABLE",
      "STORED_REVIEW_INVALID",
      "READ_FAILED",
    ]) {
      mocks.read.mockImplementationOnce(() => {
        throw new mocks.ServiceError(code);
      });
      const element = await ReviewerAssignmentPage({
        params: Promise.resolve({
          workspace: "northstar",
          assignmentId: "unavailable-assignment",
        }),
      });
      rendered.push(renderToStaticMarkup(element));
    }
    expect(new Set(rendered).size).toBe(1);
    expect(rendered[0]).toContain("Review unavailable");
    expect(rendered[0]).not.toContain("unavailable-assignment");
    expect(rendered[0]).not.toContain("ACCESS_DENIED");
  });

  it("uses the own queue only to recover the content-free declared-conflict route", async () => {
    const blocked = {
      ...summary,
      conflictStatus: "DECLARED" as const,
      conflictSequenceNumber: 1,
      actionBlocked: true,
    };
    mocks.read.mockImplementationOnce(() => {
      throw new mocks.ServiceError("ASSIGNMENT_NOT_AVAILABLE");
    });
    mocks.list.mockReturnValueOnce([blocked]);
    const element = await ReviewerAssignmentPage({
      params: Promise.resolve({
        workspace: "northstar",
        assignmentId: blocked.assignmentId,
      }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Conflict declared — content withheld");
    expect(html).not.toContain("A blind-safe community workshop proposal.");
    expect(html).not.toContain("Proposal quality");
  });

  it("loads queue and detail only through the accepted reviewer barrel operations", async () => {
    await ReviewerQueuePage({ params: Promise.resolve({ workspace: "northstar" }) });
    expect(mocks.list).toHaveBeenCalledWith(mocks.db, mocks.session, {
      workspaceSlug: "northstar",
    });
    expect(mocks.requireReviewerWorkspaceRoute).toHaveBeenCalledWith(
      mocks.session,
      "northstar",
    );
  });

  it("contains no UI SQL or imports around the fixed reviewer barrel", () => {
    const roots = [
      resolve("src/app/review"),
      resolve("src/components/cfp-review"),
    ];
    const source = roots
      .flatMap(reviewerSourceFiles)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/\.prepare\s*\(/u);
    expect(source).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|review_|cfp_)/iu);
    expect(source).not.toMatch(
      /server\/services\/cfp-review\/(?:reviewer|reviewer-types|artifacts?|rubric-semantics|organizer)/u,
    );
    expect(source).not.toContain(PROHIBITED_EMAIL);
    expect(source).not.toContain(PROHIBITED_NAME);
    expect(source).not.toContain(PROHIBITED_HISTORY);
  });

  it("retires and propagates a fatal reviewer boundary", async () => {
    const token = issueReviewActionBinding(mocks.session, detail);
    const fatal = new mocks.FatalError();
    mocks.read.mockImplementationOnce(() => {
      throw fatal;
    });
    await expect(
      saveReviewerRevisionAction(token, IDLE_REVIEWER_ACTION_STATE, reviewerForm()),
    ).rejects.toBe(fatal);
    expect(mocks.closeDb).toHaveBeenCalledWith(mocks.db);
  });

  it("keeps action states serializable and free of service errors", () => {
    const state: ReviewerActionState = {
      kind: "stale",
      code: "REVIEW_STATE_STALE",
      message: "Reload and reconcile.",
    };
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
