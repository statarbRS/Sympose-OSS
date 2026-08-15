import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanCompilerReveal } from "@/components/decision-intelligence/plan-compiler-reveal";
import {
  buildPlanDecisionProjection,
  type DecisionPlanVersionInput,
} from "@/components/decision-intelligence/plan-projection";
import { ProposalEvidenceLanes } from "@/components/decision-intelligence/proposal-evidence-lanes";
import type {
  OrganizerReviewAssignment,
  OrganizerReviewSubmissionAggregate,
} from "@/server/services/cfp-review/organizer-types";
import type { ProposedChangeCommandEnvelope } from "@/server/services/change-radius";
import type { ProgramSelectionInput } from "@/server/services/curatorial-separation";
import { buildDecisionIntelligenceProjection } from "@/server/services/decision-intelligence";

const scope = { workspaceId: "workspace-di", eventId: "event-di" } as const;

function hash(character: string): string {
  return character.repeat(64);
}

function curatorialInput(): ProgramSelectionInput {
  const eligibleRevisions = [
    {
      submissionId: "submission-a",
      proposalRevisionId: "revision-a",
      revisionNumber: 1,
      revisionFingerprint: hash("a"),
      topics: ["architecture"],
      organizationId: "organization-a",
      allocationOptions: [
        { poolId: "sessions", poolVersionId: "sessions-v1", unitKind: "SESSION", quantity: 1 },
      ],
    },
    {
      submissionId: "submission-b",
      proposalRevisionId: "revision-b",
      revisionNumber: 1,
      revisionFingerprint: hash("b"),
      topics: ["community"],
      organizationId: "organization-b",
      allocationOptions: [
        { poolId: "sessions", poolVersionId: "sessions-v1", unitKind: "SESSION", quantity: 1 },
      ],
    },
    {
      submissionId: "submission-c",
      proposalRevisionId: "revision-c",
      revisionNumber: 1,
      revisionFingerprint: hash("c"),
      topics: ["operations"],
      organizationId: "organization-c",
      allocationOptions: [
        { poolId: "sessions", poolVersionId: "sessions-v1", unitKind: "SESSION", quantity: 1 },
      ],
    },
  ] as const;

  return {
    scope,
    eligibleRevisions,
    eligibilityContext: {
      contextId: "eligibility-context",
      versionId: "eligibility-v1",
      fingerprint: hash("d"),
      asOf: "2026-08-13T12:00:00.000Z",
      status: "CURRENT",
      bindings: eligibleRevisions.map((revision) => ({
        proposalRevisionId: revision.proposalRevisionId,
        revisionFingerprint: revision.revisionFingerprint,
        eligible: true,
        evidenceState: "CURRENT" as const,
      })),
    },
    currentReviewContext: {
      contextId: "review-context",
      versionId: "review-v1",
      fingerprint: hash("e"),
      asOf: "2026-08-13T12:00:00.000Z",
      status: "CURRENT",
      evidence: eligibleRevisions.flatMap((revision, index) => [
        {
          evidenceId: `evaluation-${revision.proposalRevisionId}`,
          proposalRevisionId: revision.proposalRevisionId,
          family: "INDIVIDUAL_EVALUATION" as const,
          visibility: "PUBLIC" as const,
          state: "CURRENT" as const,
          fingerprint: hash(String(index + 1)),
          contextFingerprint: hash("e"),
          value: 9 - index,
        },
        {
          evidenceId: `advocacy-${revision.proposalRevisionId}`,
          proposalRevisionId: revision.proposalRevisionId,
          family: "ADVOCACY" as const,
          visibility: "ORGANIZER_PRIVATE" as const,
          state: "CURRENT" as const,
          fingerprint: hash(String(index + 4)),
          contextFingerprint: hash("e"),
          stance: index === 0 ? "PROMOTE" as const : "NO_POSITION" as const,
          strength: index + 1,
          rationale: "Private rationale must not be projected.",
        },
      ]),
    },
    pools: [
      {
        poolId: "sessions",
        poolVersionId: "sessions-v1",
        unitKind: "SESSION",
        capacity: 2,
        remaining: 2,
      },
    ],
    transfers: [],
    targetCount: 2,
    deterministicSeed: "decision-intelligence-experience",
    constraints: [],
    objectives: [
      {
        objectiveId: "topic-breadth",
        priority: 3,
        sourceFamily: "TOPIC_BALANCE",
        direction: "MAXIMIZE",
        weightNumerator: 1,
        weightDenominator: 1,
      },
      {
        objectiveId: "reviewer-evaluation",
        priority: 1,
        sourceFamily: "INDIVIDUAL_EVALUATION",
        direction: "MAXIMIZE",
        weightNumerator: 1,
        weightDenominator: 1,
      },
      {
        objectiveId: "organizer-advocacy",
        priority: 2,
        sourceFamily: "ADVOCACY",
        direction: "MAXIMIZE",
        weightNumerator: 1,
        weightDenominator: 1,
      },
    ],
    configuration: { maxCandidateSlates: 3, maxSearchNodes: 20_000 },
  };
}

function authorityInjectedChange(): ProposedChangeCommandEnvelope {
  const terms = {
    time: { start: "2026-09-18T10:00:00Z", end: "2026-09-18T11:00:00Z" },
    role: "MODERATOR",
  };
  return {
    commandId: "change-command",
    scope,
    beforeSourceVector: {
      vectorId: "source-vector",
      scope,
      revision: 1,
      records: [
        {
          family: "SCHEDULE",
          recordId: "schedule-item",
          scope,
          revision: 1,
          terms,
        },
      ],
    },
    proposedChanges: [
      {
        family: "SCHEDULE",
        recordId: "schedule-item",
        before: terms,
        after: {
          ...terms,
          time: { start: "2026-09-18T10:30:00Z", end: "2026-09-18T11:30:00Z" },
        },
      },
    ],
    authority: { approved: true },
  } as ProposedChangeCommandEnvelope;
}

function planVersion(
  versionNumber: number,
  assignments: DecisionPlanVersionInput["assignments"],
): DecisionPlanVersionInput {
  return {
    versionNumber,
    fingerprint: `plan-fingerprint-${versionNumber}`,
    lifecycleStatus: versionNumber === 3 ? "approved" : "candidate",
    assignments,
  };
}

describe("decision-intelligence-experience hostile contracts", () => {
  it("rejects caller-minted authority while preserving separated named contribution lanes", () => {
    const source = curatorialInput();
    const projection = buildDecisionIntelligenceProjection({
      trustedScope: scope,
      curatorialSelection: source,
      changeRadius: authorityInjectedChange(),
    });

    expect(projection.authority).toBe("NONE");
    expect(projection.proposalOnly).toBe(true);
    expect(projection.canSelect).toBe(false);
    expect(projection.canApprove).toBe(false);
    expect(projection.canMutateCapacity).toBe(false);
    expect(projection.canNotify).toBe(false);

    const rootInjected = buildDecisionIntelligenceProjection({
      trustedScope: scope,
      authority: "APPROVE",
      canSelect: true,
    } as Parameters<typeof buildDecisionIntelligenceProjection>[0] & {
      readonly authority: "APPROVE";
      readonly canSelect: true;
    });
    expect(rootInjected.authority).toBe("NONE");
    expect(rootInjected.canSelect).toBe(false);
    expect(rootInjected.canApprove).toBe(false);
    expect(projection.changeRadius).toMatchObject({
      status: "BLOCKED",
      code: "CALLER_INJECTED_AUTHORITY",
      canApply: false,
      canSend: false,
    });

    expect(projection.curatorialSelection.status).toBe("READY");
    const slate = projection.curatorialSelection.slates[0]!;
    expect(slate.contributionLanes.evaluation).not.toHaveLength(0);
    expect(slate.contributionLanes.evaluation.every((item) =>
      item.sourceFamily === "INDIVIDUAL_EVALUATION" ||
      item.sourceFamily === "CONFIDENTIAL_REVIEW_SCORE")).toBe(true);
    expect(slate.contributionLanes.advocacy).not.toHaveLength(0);
    expect(slate.contributionLanes.advocacy.every((item) =>
      item.sourceFamily === "ADVOCACY")).toBe(true);
    expect(slate.contributionLanes.programObjectives.every((item) =>
      item.sourceFamily !== "ADVOCACY" &&
      item.sourceFamily !== "INDIVIDUAL_EVALUATION" &&
      item.sourceFamily !== "CONFIDENTIAL_REVIEW_SCORE")).toBe(true);
    expect(slate.displacedAlternatives).not.toHaveLength(0);
    expect(slate.comparisonMethod).toBe("NAMED_OBJECTIVES_IN_DECLARED_ORDER");
    expect(slate.comparisonExplanation).toContain("No opaque aggregate score");
    expect(projection.curatorialSelection.objectiveDeclarations).toEqual([
      {
        objectiveId: "reviewer-evaluation",
        priority: 1,
        sourceFamily: "INDIVIDUAL_EVALUATION",
        direction: "MAXIMIZE",
        contributionScale: { numerator: 1, denominator: 1 },
        comparisonRole: "LEXICOGRAPHIC_NAMED_OBJECTIVE",
      },
      {
        objectiveId: "organizer-advocacy",
        priority: 2,
        sourceFamily: "ADVOCACY",
        direction: "MAXIMIZE",
        contributionScale: { numerator: 1, denominator: 1 },
        comparisonRole: "LEXICOGRAPHIC_NAMED_OBJECTIVE",
      },
      {
        objectiveId: "topic-breadth",
        priority: 3,
        sourceFamily: "TOPIC_BALANCE",
        direction: "MAXIMIZE",
        contributionScale: { numerator: 1, denominator: 1 },
        comparisonRole: "LEXICOGRAPHIC_NAMED_OBJECTIVE",
      },
    ]);
    expect(projection.curatorialSelection.hasOpaqueAggregateScore).toBe(false);
    expect(Object.hasOwn(slate, "score")).toBe(false);
    expect(JSON.stringify(projection.curatorialSelection.slates)).not.toMatch(
      /"(?:aggregateScore|weightedScore|score)":/,
    );
    expect(JSON.stringify(projection)).not.toContain("Private rationale must not be projected.");

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.curatorialSelection)).toBe(true);
    expect(Object.isFrozen(slate)).toBe(true);
    expect(Object.isFrozen(slate.contributionLanes.evaluation)).toBe(true);
    (source.eligibleRevisions[0] as { topics: readonly string[] }).topics = ["mutated-after-projection"];
    expect(JSON.stringify(projection)).not.toContain("mutated-after-projection");
  });

  it("fails closed on cross-route evidence and states every absent canonical proof as unavailable", () => {
    const mismatched = buildDecisionIntelligenceProjection({
      trustedScope: { workspaceId: "other-workspace", eventId: scope.eventId },
      curatorialSelection: curatorialInput(),
    });
    expect(mismatched.curatorialSelection).toMatchObject({
      status: "BLOCKED",
      code: "ROUTE_SCOPE_MISMATCH",
      authority: "NONE",
      previewOnly: true,
    });
    expect(mismatched.curatorialSelection.slates).toEqual([]);
    expect(mismatched.curatorialSelection.fingerprint).toBeNull();
    expect(mismatched.curatorialSelection.targetCount).toBeNull();
    expect(mismatched.curatorialSelection.objectiveDeclarations).toEqual([]);

    const unavailable = buildDecisionIntelligenceProjection({ trustedScope: scope });
    expect([
      unavailable.authorityPurpose.status,
      unavailable.readiness.status,
      unavailable.curatorialSelection.status,
      unavailable.changeRadius.status,
      unavailable.surgicalReconfirmation.status,
    ]).toEqual(["UNAVAILABLE", "UNAVAILABLE", "UNAVAILABLE", "UNAVAILABLE", "UNAVAILABLE"]);
    expect(unavailable.curatorialSelection.slates).toEqual([]);
    expect(unavailable.changeRadius.affectedRecords).toEqual([]);
    expect(unavailable.surgicalReconfirmation.receipts).toEqual([]);
  });

  it("compiles an exact current/candidate record reveal with disclosed stability cost", () => {
    const current = planVersion(3, [
      { personId: "person-a", fullName: "Ada", programUnitId: "unit-a", programUnitName: "A", assignmentType: "MODERATOR" },
      { personId: "person-b", fullName: "Grace", programUnitId: "unit-b", programUnitName: "B", assignmentType: "SPEAKER" },
      { personId: "person-c", fullName: "Katherine", programUnitId: "unit-c", programUnitName: "C", assignmentType: "SPEAKER" },
    ]);
    const candidate = planVersion(4, [
      { personId: "person-a", fullName: "Ada", programUnitId: "unit-a", programUnitName: "A", assignmentType: "MODERATOR" },
      { personId: "person-b", fullName: "Grace", programUnitId: "unit-d", programUnitName: "D", assignmentType: "SPEAKER" },
      { personId: "person-d", fullName: "Dorothy", programUnitId: "unit-e", programUnitName: "E", assignmentType: "SPEAKER" },
    ]);
    const projection = buildPlanDecisionProjection(candidate, current);

    expect(projection).toMatchObject({
      status: "READY",
      authority: "NONE",
      previewOnly: true,
      counts: { unchanged: 1, moved: 0, added: 2, removed: 2 },
      stabilityCost: {
        total: 4,
        formula: "0 × unchanged + 1 × moved + 1 × added + 1 × removed",
        authority: "NONE",
      },
    });
    expect(projection.namedObjectiveContributions.status).toBe("UNAVAILABLE");
    expect(projection.proofAvailability.every((proof) => proof.status === "UNAVAILABLE")).toBe(true);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.changes)).toBe(true);
    expect(buildPlanDecisionProjection(
      { ...candidate, assignments: [...candidate.assignments].reverse() },
      { ...current, assignments: [...current.assignments].reverse() },
    )).toEqual(projection);

    const html = renderToStaticMarkup(createElement(PlanCompilerReveal, { candidate, current }));
    expect(html).toContain("Compiler reveal");
    expect(html).toContain("Explicit change cost");
    expect(html).toContain("Preview → explanation → human approval");
    expect(html).toContain("Nothing executed");
    expect(html).toContain("Unavailable from this route");
    expect(html).not.toContain("Approve override");
  });

  it("does not infer moves for multiple same-role assignments without immutable lineage", () => {
    const current = planVersion(8, [
      { personId: "person-a", fullName: "Ada", programUnitId: "unit-remove-a", programUnitName: "Remove a", assignmentType: "MODERATOR" },
      { personId: "person-a", fullName: "Ada", programUnitId: "unit-remove-Z", programUnitName: "Remove Z", assignmentType: "MODERATOR" },
    ]);
    const candidate = planVersion(9, [
      { personId: "person-a", fullName: "Ada", programUnitId: "unit-add-a", programUnitName: "Add a", assignmentType: "MODERATOR" },
      { personId: "person-a", fullName: "Ada", programUnitId: "unit-add-Z", programUnitName: "Add Z", assignmentType: "MODERATOR" },
    ]);
    const projection = buildPlanDecisionProjection(candidate, current);

    expect(projection.counts).toEqual({ unchanged: 0, moved: 0, added: 2, removed: 2 });
    expect(projection.stabilityCost.total).toBe(4);
    expect(projection.changes).toEqual([
      {
        kind: "ADDED",
        personId: "person-a",
        fullName: "Ada",
        assignmentType: "MODERATOR",
        beforeProgramUnitId: null,
        beforeProgramUnitName: null,
        afterProgramUnitId: "unit-add-Z",
        afterProgramUnitName: "Add Z",
        explicitCost: 1,
      },
      {
        kind: "ADDED",
        personId: "person-a",
        fullName: "Ada",
        assignmentType: "MODERATOR",
        beforeProgramUnitId: null,
        beforeProgramUnitName: null,
        afterProgramUnitId: "unit-add-a",
        afterProgramUnitName: "Add a",
        explicitCost: 1,
      },
      {
        kind: "REMOVED",
        personId: "person-a",
        fullName: "Ada",
        assignmentType: "MODERATOR",
        beforeProgramUnitId: "unit-remove-Z",
        beforeProgramUnitName: "Remove Z",
        afterProgramUnitId: null,
        afterProgramUnitName: null,
        explicitCost: 1,
      },
      {
        kind: "REMOVED",
        personId: "person-a",
        fullName: "Ada",
        assignmentType: "MODERATOR",
        beforeProgramUnitId: "unit-remove-a",
        beforeProgramUnitName: "Remove a",
        afterProgramUnitId: null,
        afterProgramUnitName: null,
        explicitCost: 1,
      },
    ]);
    expect(buildPlanDecisionProjection(
      { ...candidate, assignments: [...candidate.assignments].reverse() },
      { ...current, assignments: [...current.assignments].reverse() },
    )).toEqual(projection);
  });

  it("renders reviewer evaluation without minting advocacy or an executable handoff", () => {
    const ranking: OrganizerReviewSubmissionAggregate = {
      submissionId: "submission-a",
      submissionRevisionId: "revision-a",
      applicant: { personId: "person-a", displayName: "Ada", organization: "Analytical Engines" },
      assignedReviewCount: 1,
      submittedReviewCount: 1,
      eligibleReviewCount: 1,
      completionPercent: 100,
      conflictCount: 0,
      blindPendingCount: 0,
      score: 8,
      scoreBasis: "submitted-review-evidence",
      recommendationCounts: { advance: 1, hold: 0, doNotAdvance: 0 },
      evidenceRank: 1,
    };
    const assignments: readonly OrganizerReviewAssignment[] = [
      {
        id: "assignment-a",
        roundId: "round-a",
        submissionId: ranking.submissionId,
        submissionRevisionId: ranking.submissionRevisionId,
        reviewerAccountId: "reviewer-a",
        reviewerName: "Reviewer One",
        assignmentState: "SUBMITTED",
        assignmentStateSequenceNumber: 2,
        conflictStatus: "NONE",
        conflictSequenceNumber: 0,
        latestReviewRevisionNumber: 1,
        blindArtifactReady: true,
        assignedAt: "2026-08-13T12:00:00.000Z",
        latestSubmittedReview: {
          revisionNumber: 1,
          criteria: [
            { criterionId: "quality", label: "Proposal quality", kind: "numeric", value: 8, choiceLabel: null },
            { criterionId: "recommendation", label: "Recommendation", kind: "dropdown", value: "ADVANCE", choiceLabel: "Advance" },
          ],
        },
        applicant: ranking.applicant,
      },
    ];

    const html = renderToStaticMarkup(createElement(ProposalEvidenceLanes, {
      ranking,
      assignments,
    }));
    expect(html).toContain("Evaluation stays separate from advocacy");
    expect(html).toContain("Named reviewer criteria");
    expect(html).toContain("Proposal quality");
    expect(html).toContain("No canonical advocacy evidence");
    expect(html).toContain("Reviewer recommendations remain reviewer evidence");
    expect(html).toContain("Named program objectives");
    expect(html).toContain("Displaced alternatives");
    expect(html).toContain("Proposal revision seal");
    expect(html).toContain("has no projected canonical fingerprint");
    expect(html).toContain("No objective-contribution ledger is projected for this proposal.");
    expect(html).toContain("No exact whole-slate eligibility/capacity preview is projected.");
    expect(html).toContain("The transparent review score remains a sort aid, never a selection command.");
    expect(html).toContain("Human approval");
    expect(html).toContain('data-authority="none"');
    expect(html).toContain('data-testid="decision-intelligence-evidence-gaps"');
    expect(html).toContain('data-gap-count="5"');
    const disclosureStart = html.indexOf('data-testid="decision-intelligence-evidence-gaps"');
    const disclosureEnd = html.indexOf("</details>", disclosureStart) + "</details>".length;
    const disclosure = html.slice(disclosureStart, disclosureEnd);
    expect(disclosure.match(/Unavailable/gu)).toHaveLength(4);
    expect(disclosure).toContain("None");
    expect(disclosure).not.toContain('open=""');
    expect(disclosure).not.toContain(">Ready<");
    expect(disclosure).not.toContain(">False<");
    expect(disclosure).not.toContain(">0<");
    expect(html).not.toContain("<button");

    const unavailableHtml = renderToStaticMarkup(createElement(ProposalEvidenceLanes, {
      ranking: { ...ranking, submittedReviewCount: 0, eligibleReviewCount: 0, score: null, scoreBasis: "no-submitted-evidence" },
      assignments: [],
    }));
    const unavailableStart = unavailableHtml.indexOf('data-testid="decision-intelligence-evidence-gaps"');
    const unavailableEnd = unavailableHtml.indexOf("</details>", unavailableStart) + "</details>".length;
    const unavailableDisclosure = unavailableHtml.slice(unavailableStart, unavailableEnd);
    expect(unavailableHtml).toContain('data-gap-count="6"');
    expect(unavailableDisclosure).toContain("No submitted evaluation evidence is available.");
    expect(unavailableDisclosure.match(/Unavailable/gu)).toHaveLength(5);
    expect(unavailableDisclosure).toContain("None");
    expect(unavailableDisclosure).not.toContain(">Ready<");
    expect(unavailableDisclosure).not.toContain(">False<");
    expect(unavailableDisclosure).not.toContain(">0<");
  });

  it("does not synthesize a baseline when the current slate is absent", () => {
    const candidate = planVersion(1, [
      { personId: "person-a", fullName: "Ada", programUnitId: "unit-a", programUnitName: "A", assignmentType: "MODERATOR" },
    ]);
    const projection = buildPlanDecisionProjection(candidate, null);
    const html = renderToStaticMarkup(createElement(PlanCompilerReveal, { candidate, current: null }));

    expect(projection.status).toBe("UNAVAILABLE");
    expect(projection.stabilityCost.total).toBeNull();
    expect(projection.changes).toEqual([]);
    expect(html).toContain("Whole-slate comparison unavailable");
    expect(html).toContain("does not invent a baseline or stability verdict");
  });

  it("identifies an approved-only slate without relabeling it as a candidate", () => {
    const approvedOnly: DecisionPlanVersionInput = {
      ...planVersion(6, [
        { personId: "person-a", fullName: "Ada", programUnitId: "unit-a", programUnitName: "A", assignmentType: "MODERATOR" },
      ]),
      lifecycleStatus: "approved",
    };
    const html = renderToStaticMarkup(createElement(PlanCompilerReveal, {
      candidate: approvedOnly,
      current: null,
    }));

    expect(html).toContain("Approved current slate v6 is visible");
    expect(html).toContain("no separate candidate slate is available");
    expect(html).not.toContain("Candidate v6 is visible");
  });
});
