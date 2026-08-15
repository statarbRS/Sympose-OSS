import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  OrganizerReviewConsole,
  sortOrganizerReviewRankingsByScore,
} from "../../src/components/cfp-review/organizer-review-console";
import type {
  OrganizerReviewRubricField,
  OrganizerReviewSurface,
} from "../../src/server/services/cfp-review/organizer";
import type { OrganizerReviewSubmissionAggregate } from "../../src/server/services/cfp-review/organizer-types";

function ranking(
  submissionId: string,
  displayName: string,
  score: number | null,
): OrganizerReviewSubmissionAggregate {
  return {
    submissionId,
    submissionRevisionId: `${submissionId}-revision`,
    applicant: { personId: `${submissionId}-person`, displayName, organization: null },
    assignedReviewCount: 2,
    submittedReviewCount: score === null ? 0 : 2,
    eligibleReviewCount: 2,
    completionPercent: score === null ? 0 : 100,
    conflictCount: 0,
    blindPendingCount: 0,
    score,
    scoreBasis: score === null ? "no-submitted-evidence" : "submitted-review-evidence",
    recommendationCounts: { advance: 1, hold: 0, doNotAdvance: 0 },
    evidenceRank: score === null ? null : 1,
  };
}

const fields: readonly OrganizerReviewRubricField[] = [
  {
    id: "quality",
    label: "Proposal quality",
    guidance: "Assess the proposal as presented.",
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
    id: "fit",
    label: "Audience fit",
    guidance: "Assess audience relevance.",
    kind: "dropdown",
    required: true,
    weight: 1,
    minimum: null,
    maximum: null,
    step: null,
    choices: [
      { value: "HIGH", label: "High" },
      { value: "LOW", label: "Low" },
    ],
    maxLength: null,
  },
];

const surface: OrganizerReviewSurface = {
  workspaceId: "workspace-microbundle",
  workspaceSlug: "northstar",
  eventId: "event-microbundle",
  eventName: "Northstar Summit",
  calls: [],
  selectedRoundId: "round-microbundle",
  selectedSort: "rank",
  rounds: [
    {
      id: "round-microbundle",
      eventId: "event-microbundle",
      callId: "call-microbundle",
      name: "Initial screening",
      state: "OPEN",
      stateSequenceNumber: 2,
      stateChangedAt: "2026-08-12T09:00:00.000Z",
      createdAt: "2026-08-11T09:00:00.000Z",
      call: {
        id: "call-microbundle",
        name: "Northstar CFP",
        slug: "northstar-cfp",
        state: "OPEN",
        timezone: "UTC",
        opensAt: "2026-08-11T09:00:00.000Z",
        closesAt: "2026-08-20T09:00:00.000Z",
      },
      schedule: {
        source: "call",
        timezone: "UTC",
        opensAt: "2026-08-11T09:00:00.000Z",
        closesAt: "2026-08-20T09:00:00.000Z",
      },
      rubric: {
        id: "rubric-microbundle",
        roundId: "round-microbundle",
        versionNumber: 3,
        fingerprint: "a".repeat(64),
        sealedAt: "2026-08-11T09:00:00.000Z",
        semanticsId: null,
        fields,
        reviewerProjection: null,
      },
      progress: {
        assigned: 2,
        inProgress: 0,
        submitted: 2,
        recused: 0,
        revoked: 0,
        conflicts: 0,
        blindReady: 2,
        blindPending: 0,
        total: 2,
        completionPercent: 100,
      },
      assignments: [],
      rankings: [
        ranking("submission-high", "High score proposal", 91.5),
        ranking("submission-low", "Low score proposal", 22.25),
        ranking("submission-pending", "Pending proposal", null),
      ],
      reminders: [],
      localEvidence: [],
    },
  ],
};

describe("organizer review evaluator micro-bundle", () => {
  it("sorts projected scores in both directions without mutating evidence", () => {
    const input = surface.rounds[0]!.rankings;

    expect(sortOrganizerReviewRankingsByScore(input, "ascending").map((item) => item.submissionId)).toEqual([
      "submission-low",
      "submission-high",
      "submission-pending",
    ]);
    expect(sortOrganizerReviewRankingsByScore(input, "descending").map((item) => item.submissionId)).toEqual([
      "submission-high",
      "submission-low",
      "submission-pending",
    ]);
    expect(input.map((item) => item.submissionId)).toEqual([
      "submission-high",
      "submission-low",
      "submission-pending",
    ]);
  });

  it("renders the weighted method, sealed weights, and actionable score controls", () => {
    const html = renderToStaticMarkup(createElement(OrganizerReviewConsole, {
      workspace: "northstar",
      surface,
    }));

    expect(html).toContain("Weighted numeric evidence");
    expect(html).toContain("Σ ((response − minimum) ÷ (maximum − minimum) × weight) ÷ Σ weight × 100");
    expect(html).toContain("Proposal quality 2× · Audience fit 1×");
    expect(html).toContain("Recommendations, dropdowns, comments, and organizer decisions remain separate evidence");
    expect(html).toContain('data-testid="score-sort-ascending"');
    expect(html).toContain('data-testid="score-sort-descending"');
    expect(html).toContain('type="button"');
    expect(html).toContain("Choose ascending or descending to reorder the rendered evidence by score.");
    expect(html).toContain('data-submission-id="submission-high"');
    expect(html).toContain('data-submission-id="submission-low"');
    expect(html).not.toContain("organizer decision was changed");
  });
});
