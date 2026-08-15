import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  OrganizerReviewConsole,
  OrganizerReviewSetupReceipt,
} from "../../src/components/cfp-review/organizer-review-console";
import type {
  OrganizerReviewAssignment,
  OrganizerReviewCall,
  OrganizerReviewRoundProjection,
  OrganizerReviewSurface,
} from "../../src/server/services/cfp-review/organizer";
import type { OrganizerReviewRoundActionState } from "../../src/app/w/[workspace]/events/[eventId]/review/actions";

const call: OrganizerReviewCall = {
  id: "call-review-ui",
  name: "Community proposals",
  slug: "community-proposals",
  state: "OPEN",
  timezone: "America/New_York",
  opensAt: "2026-09-01T09:00:00.000Z",
  closesAt: "2026-09-15T09:00:00.000Z",
};

const assignment = (id: string, reviewerAccountId: string, reviewerName: string, submissionId: string): OrganizerReviewAssignment => ({
  id,
  roundId: "round-review-ui",
  submissionId,
  submissionRevisionId: `${submissionId}-revision-1`,
  reviewerAccountId,
  reviewerName,
  assignmentState: "ASSIGNED",
  assignmentStateSequenceNumber: 1,
  conflictStatus: "NONE",
  conflictSequenceNumber: 0,
  latestReviewRevisionNumber: 0,
  blindArtifactReady: false,
  assignedAt: "2026-08-20T10:00:00.000Z",
  applicant: {
    personId: `${submissionId}-person`,
    displayName: submissionId === "submission-one" ? "Ari Applicant" : "Bea Applicant",
    organization: null,
  },
});

const round: OrganizerReviewRoundProjection = {
  id: "round-review-ui",
  eventId: "event-review-ui",
  callId: call.id,
  name: "First screening",
  state: "DRAFT",
  stateSequenceNumber: 1,
  stateChangedAt: "2026-08-20T10:00:00.000Z",
  createdAt: "2026-08-20T10:00:00.000Z",
  call,
  schedule: {
    source: "round",
    version: 2,
    timezone: call.timezone,
    opensAt: call.opensAt!,
    closesAt: call.closesAt!,
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
  rubric: {
    id: "rubric-review-ui",
    roundId: "round-review-ui",
    versionNumber: 1,
    fingerprint: "a".repeat(64),
    sealedAt: "2026-08-20T10:00:00.000Z",
    semanticsId: null,
    reviewerProjection: null,
    fields: [
      {
        id: "saved-quality",
        label: "Saved quality",
        guidance: "Score the submitted proposal.",
        kind: "numeric",
        required: true,
        weight: 2,
        minimum: 1,
        maximum: 5,
        step: 1,
        choices: [],
        maxLength: null,
      },
      {
        id: "saved-recommendation",
        label: "Saved recommendation",
        guidance: "Record independent evidence.",
        kind: "dropdown",
        required: true,
        weight: 1,
        minimum: null,
        maximum: null,
        step: null,
        choices: [
          { value: "ADVANCE", label: "Advance" },
          { value: "HOLD", label: "Hold" },
          { value: "DO_NOT_ADVANCE", label: "Do not advance" },
        ],
        maxLength: null,
      },
      {
        id: "saved-notes",
        label: "Saved notes",
        guidance: "Capture evidence.",
        kind: "text",
        required: false,
        weight: 1,
        minimum: null,
        maximum: null,
        step: null,
        choices: [],
        maxLength: 800,
      },
    ],
  },
  progress: {
    assigned: 2,
    inProgress: 0,
    submitted: 0,
    recused: 0,
    revoked: 0,
    conflicts: 0,
    blindReady: 0,
    blindPending: 2,
    total: 2,
    completionPercent: 0,
  },
  assignments: [
    assignment("assignment-one", "reviewer-a", "Reviewer A", "submission-one"),
    assignment("assignment-two", "reviewer-b", "Reviewer B", "submission-two"),
  ],
  rankings: [
    {
      submissionId: "submission-one",
      submissionRevisionId: "submission-one-revision-1",
      applicant: { personId: "submission-one-person", displayName: "Ari Applicant", organization: null },
      assignedReviewCount: 1,
      submittedReviewCount: 0,
      eligibleReviewCount: 1,
      completionPercent: 0,
      conflictCount: 0,
      blindPendingCount: 1,
      score: null,
      scoreBasis: "no-submitted-evidence",
      recommendationCounts: { advance: 0, hold: 0, doNotAdvance: 0 },
      evidenceRank: null,
    },
    {
      submissionId: "submission-two",
      submissionRevisionId: "submission-two-revision-1",
      applicant: { personId: "submission-two-person", displayName: "Bea Applicant", organization: null },
      assignedReviewCount: 1,
      submittedReviewCount: 0,
      eligibleReviewCount: 1,
      completionPercent: 0,
      conflictCount: 0,
      blindPendingCount: 1,
      score: null,
      scoreBasis: "no-submitted-evidence",
      recommendationCounts: { advance: 0, hold: 0, doNotAdvance: 0 },
      evidenceRank: null,
    },
  ],
  reminders: [],
  localEvidence: [],
};

const surface: OrganizerReviewSurface = {
  workspaceId: "workspace-review-ui",
  workspaceSlug: "northstar",
  eventId: "event-review-ui",
  eventName: "Review UI event",
  calls: [call],
  rounds: [round],
  selectedRoundId: round.id,
  selectedSort: "rank",
};

function renderConsole(value: OrganizerReviewSurface = surface): string {
  return renderToStaticMarkup(createElement(OrganizerReviewConsole, {
    workspace: "northstar",
    surface: value,
  }));
}

describe("organizer review setup console UI", () => {
  it("renders proposal evidence before a collapsed secondary Setup workspace", () => {
    const advanceReview: OrganizerReviewAssignment = {
      ...assignment("assignment-advance", "reviewer-a", "Reviewer A", "submission-one"),
      assignmentState: "SUBMITTED",
      latestReviewRevisionNumber: 1,
      blindArtifactReady: true,
      latestSubmittedReview: {
        revisionNumber: 1,
        criteria: [
          {
            criterionId: "saved-quality",
            label: "Saved quality",
            kind: "numeric",
            value: 4,
            choiceLabel: null,
          },
          {
            criterionId: "saved-recommendation",
            label: "Saved recommendation",
            kind: "dropdown",
            value: "ADVANCE",
            choiceLabel: "Advance",
          },
        ],
      },
    };
    const holdReview: OrganizerReviewAssignment = {
      ...assignment("assignment-hold", "reviewer-b", "Reviewer B", "submission-one"),
      assignmentState: "SUBMITTED",
      latestReviewRevisionNumber: 1,
      blindArtifactReady: true,
      latestSubmittedReview: {
        revisionNumber: 1,
        criteria: [
          {
            criterionId: "saved-quality",
            label: "Saved quality",
            kind: "numeric",
            value: 3,
            choiceLabel: null,
          },
          {
            criterionId: "saved-recommendation",
            label: "Saved recommendation",
            kind: "dropdown",
            value: "HOLD",
            choiceLabel: "Hold",
          },
        ],
      },
    };
    const evidenceRound: OrganizerReviewRoundProjection = {
      ...round,
      assignments: [advanceReview, holdReview, round.assignments[1]!],
      rankings: [
        {
          ...round.rankings[0]!,
          assignedReviewCount: 2,
          submittedReviewCount: 2,
          eligibleReviewCount: 2,
          completionPercent: 100,
          blindPendingCount: 0,
          score: 75,
          scoreBasis: "submitted-review-evidence",
          recommendationCounts: { advance: 1, hold: 1, doNotAdvance: 0 },
          evidenceRank: 1,
        },
        round.rankings[1]!,
      ],
      progress: {
        ...round.progress,
        assigned: 1,
        submitted: 2,
        blindReady: 2,
        total: 3,
        completionPercent: 67,
      },
    };
    const html = renderConsole({
      ...surface,
      rounds: [evidenceRound],
      selectedRoundId: evidenceRound.id,
    });

    const primaryIndex = html.indexOf('data-testid="proposal-review-workspace"');
    const detailIndex = html.indexOf('data-testid="selected-proposal-detail"');
    const setupIndex = html.indexOf('data-testid="review-secondary-setup"');
    const lifecycleControlIndex = html.indexOf(`data-testid="review-round-state-${round.id}"`);
    const scheduleControlIndex = html.indexOf(`data-testid="review-round-schedule-${round.id}"`);

    expect(primaryIndex).toBeGreaterThan(-1);
    expect(detailIndex).toBeGreaterThan(primaryIndex);
    expect(setupIndex).toBeGreaterThan(detailIndex);
    expect(lifecycleControlIndex).toBeGreaterThan(setupIndex);
    expect(scheduleControlIndex).toBeGreaterThan(setupIndex);
    expect(html).toContain("Primary evidence");
    expect(html).toContain("Unresolved proposals");
    expect(html).toContain('data-selected-submission-id="submission-one"');
    expect(html).toContain("Reviewer disagreement");
    expect(html).toContain("Submitted recommendations span more than one position.");
    expect(html).toContain("Reviewer A");
    expect(html).toContain("Reviewer B");
    expect(html).toContain("Saved quality");
    expect(html).toContain("Organizer decision separate");
    expect(html).toContain("Secondary workspace");
    expect(html).toContain("Round configuration and controls");
    const setupDisclosureTag = html.slice(setupIndex).match(/<details[^>]*>/u)?.[0];
    expect(setupDisclosureTag).toBeTruthy();
    expect(setupDisclosureTag).not.toContain("open");
  });

  it("renders explicit round dates and wires the versioned schedule actions", () => {
    const html = renderConsole();

    expect(html).toContain('data-testid="review-setup-console"');
    expect(html).toContain('data-action="createOrganizerReviewRoundAction"');
    expect(html).toContain('data-action="createOrganizerReviewRubricAction"');
    expect(html).toContain('data-action="distributeOrganizerReviewAssignmentsAction"');
    expect(html).toContain('name="callId"');
    expect(html).toContain('value="call-review-ui"');
    expect(html).toContain('name="name"');
    expect(html).toContain("Each round persists its own opening and closing dates");
    expect(html).toContain("America/New_York");
    expect(html).toContain('name="opensAt"');
    expect(html).toContain('name="closesAt"');
    expect(html).toContain('data-idempotency="generated-on-submit"');
    expect(html).toContain('data-action="setOrganizerReviewRoundScheduleAction"');
    expect(html).toContain('name="expectedScheduleVersion" value="2"');
    expect(html).toContain("Saving them does not change the CFP call or any other round");
    expect(html).toContain("Saved v2");
    expect(html).toContain('data-serialization="bounded-fixed-rubric-v1"');
  });

  it("renders numeric, dropdown, and text criteria with bounded settings", () => {
    const html = renderConsole();

    expect(html).toContain('data-rubric-kind="numeric"');
    expect(html).toContain('data-rubric-kind="dropdown"');
    expect(html).toContain('data-rubric-kind="text"');
    expect(html).toContain('name="rubric-quality-weight"');
    expect(html).toContain('name="rubric-quality-minimum"');
    expect(html).toContain('name="rubric-quality-maximum"');
    expect(html).toContain('name="rubric-quality-step"');
    expect(html).toContain('name="rubric-recommendation-choice-1-value"');
    expect(html).toContain('value="ADVANCE"');
    expect(html).toContain('value="HOLD"');
    expect(html).toContain('name="rubric-notes-max-length"');
    expect(html).toContain('value="800"');
    expect(html).toContain('name="rubric-quality-required"');
    expect(html).toContain('name="rubric-recommendation-required"');
    expect(html).toContain('name="rubric-notes-required"');
    expect(html).toContain('value="2"');
  });

  it("uses only projected reviewer and submission IDs for the explicit pool and caps", () => {
    const html = renderConsole();

    expect(html).toContain('name="poolReviewerAccountId"');
    expect(html).toContain('data-reviewer-id="reviewer-a"');
    expect(html).toContain('data-reviewer-id="reviewer-b"');
    expect(html).toContain('name="poolMaxAssignments"');
    expect(html).toContain('name="reviewsPerSubmission"');
    expect(html).toContain('name="maxAssignmentsPerReviewer"');
    expect(html).toContain('name="strategy"');
    expect(html).toContain('value="balanced"');
    expect(html).toContain('value="round_robin"');
    expect(html).toContain('name="submissionId"');
    expect(html).toContain('data-submission-id="submission-one"');
    expect(html).toContain('data-submission-id="submission-two"');
    expect(html).toContain("existing assignment");
    expect(html).not.toContain("hidden-reviewer");
    expect(html).not.toContain("invented-submission");
  });

  it("shows truthful disabled and empty states when the projection has no setup rows", () => {
    const noRows: OrganizerReviewSurface = {
      ...surface,
      calls: [],
      rounds: [],
      selectedRoundId: null,
    };
    const html = renderConsole(noRows);

    expect(html).toContain('data-testid="review-round-call-empty"');
    expect(html).toContain("No CFP call is available");
    expect(html).toContain('data-testid="review-rubric-empty"');
    expect(html).toContain('data-testid="review-distribution-empty"');
    expect(html).not.toContain('data-reviewer-id=');
    expect(html).not.toContain('data-submission-id=');
    const setupIndex = html.indexOf('data-testid="review-secondary-setup"');
    const setupDisclosureTag = html.slice(setupIndex).match(/<details[^>]*>/u)?.[0];
    expect(setupDisclosureTag).toContain("open");
  });

  it("disables distribution and explains which projected rows are missing", () => {
    const emptyRound: OrganizerReviewRoundProjection = {
      ...round,
      assignments: [],
      rankings: [],
      progress: { ...round.progress, assigned: 0, total: 0, blindPending: 0 },
    };
    const html = renderConsole({ ...surface, rounds: [emptyRound], selectedRoundId: emptyRound.id });

    expect(html).toContain('data-testid="reviewer-pool-empty"');
    expect(html).toContain('data-testid="review-submission-empty"');
    expect(html).toContain('data-testid="review-distribution-disabled"');
    expect(html).toContain("No reviewer account is present");
    expect(html).toMatch(/disabled="" data-testid="distribute-review-assignments"/u);
  });

  it("renders pending, success, and error receipts without exposing backend payloads", () => {
    const success: OrganizerReviewRoundActionState = {
      kind: "success",
      code: "REVIEW_ROUND_SAVED",
      message: "Review round created in draft state.",
      revalidated: true,
      receipt: {
        roundId: "round-receipt-ui",
        eventId: "event-review-ui",
        callId: call.id,
        state: "DRAFT",
        stateSequenceNumber: 1,
        scheduleSource: "round",
        scheduleVersion: 2,
        timezone: call.timezone,
        opensAt: call.opensAt!,
        closesAt: call.closesAt!,
        replayed: false,
      },
    };
    const error = { kind: "error" as const, code: "INPUT_INVALID", message: "The setup request is invalid." };

    expect(renderToStaticMarkup(createElement(OrganizerReviewSetupReceipt, {
      state: { kind: "idle" },
      pending: true,
      pendingMessage: "Saving…",
      testId: "receipt-pending",
    }))).toContain("Saving…");
    expect(renderToStaticMarkup(createElement(OrganizerReviewSetupReceipt, {
      state: success,
      pending: false,
      pendingMessage: "Saving…",
      testId: "receipt-success",
    }))).toContain("Round-owned schedule v2");
    expect(renderToStaticMarkup(createElement(OrganizerReviewSetupReceipt, {
      state: error,
      pending: false,
      pendingMessage: "Saving…",
      testId: "receipt-error",
    }))).toContain("The setup request is invalid.");
  });
});
