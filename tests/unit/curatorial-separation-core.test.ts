import { describe, expect, it } from "vitest";

import * as curatorialCore from "../../src/server/services/curatorial-separation";
import {
  CURATORIAL_LIMITS,
  buildHumanOverrideProposalReceipt,
  curatorialCapacityTransferFingerprint,
  previewProgramSelection,
  type CapacityTransfer,
  type CuratorialScope,
  type HumanOverrideIdempotencyBinding,
  type HumanOverrideIdempotencyResolution,
  type HumanOverrideProposalInput,
  type HumanOverrideProposalReceipt,
  type HumanOverrideTrustedAdapter,
  type ProgramSelectionInput,
} from "../../src/server/services/curatorial-separation";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const scope: CuratorialScope = { workspaceId: "workspace-test", eventId: "event-test" };

function transfer(
  input: Omit<CapacityTransfer, "fingerprint">,
): CapacityTransfer {
  return { ...input, fingerprint: curatorialCapacityTransferFingerprint(input) };
}

function baseInput(overrides: Partial<ProgramSelectionInput> = {}): ProgramSelectionInput {
  const eligibleRevisions = [
    {
      submissionId: "submission-a",
      proposalRevisionId: "revision-a",
      revisionNumber: 1,
      revisionFingerprint: HASH_A,
      topics: ["topic-data"],
      organizationId: "org-one",
      allocationOptions: [
        { poolId: "pool-main", poolVersionId: "pool-main-v1", unitKind: "SESSION", quantity: 1 },
      ],
    },
    {
      submissionId: "submission-b",
      proposalRevisionId: "revision-b",
      revisionNumber: 2,
      revisionFingerprint: HASH_B,
      topics: ["topic-community"],
      organizationId: "org-two",
      allocationOptions: [
        { poolId: "pool-main", poolVersionId: "pool-main-v1", unitKind: "SESSION", quantity: 1 },
      ],
    },
    {
      submissionId: "submission-c",
      proposalRevisionId: "revision-c",
      revisionNumber: 1,
      revisionFingerprint: HASH_C,
      topics: ["topic-data", "topic-community"],
      organizationId: "org-three",
      allocationOptions: [
        { poolId: "pool-main", poolVersionId: "pool-main-v1", unitKind: "SESSION", quantity: 1 },
      ],
    },
    {
      submissionId: "submission-d",
      proposalRevisionId: "revision-d",
      revisionNumber: 1,
      revisionFingerprint: HASH_D,
      topics: ["topic-operations"],
      organizationId: "org-one",
      allocationOptions: [
        { poolId: "pool-main", poolVersionId: "pool-main-v1", unitKind: "SESSION", quantity: 1 },
      ],
    },
  ] as const;
  const eligibilityContext = {
    contextId: "eligibility-context",
    versionId: "eligibility-v1",
    fingerprint: HASH_A,
    asOf: "2026-08-13T00:00:00.000Z",
    status: "CURRENT" as const,
    bindings: eligibleRevisions.map((revision) => ({
      proposalRevisionId: revision.proposalRevisionId,
      revisionFingerprint: revision.revisionFingerprint,
      eligible: true,
      evidenceState: "CURRENT" as const,
    })),
  };
  const currentReviewContext = {
    contextId: "review-context",
    versionId: "review-v1",
    fingerprint: HASH_B,
    asOf: "2026-08-13T00:00:00.000Z",
    status: "CURRENT" as const,
    evidence: [],
  };
  return {
    scope,
    eligibleRevisions,
    eligibilityContext,
    currentReviewContext,
    pools: [
      {
        poolId: "pool-main",
        poolVersionId: "pool-main-v1",
        unitKind: "SESSION",
        capacity: 2,
        remaining: 2,
      },
    ],
    transfers: [],
    targetCount: 2,
    deterministicSeed: "deterministic-seed",
    constraints: [],
    objectives: [],
    configuration: { maxCandidateSlates: 3, maxSearchNodes: 20_000 },
    ...overrides,
  };
}

function selected(preview: ReturnType<typeof previewProgramSelection>): string[][] {
  return preview.slates.map((slate) => [...slate.selectedProposalRevisionIds]);
}

function expectError(action: () => unknown, code: string): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

function privateEvidenceInput(): ProgramSelectionInput {
  const input = baseInput();
  return {
    ...input,
    objectives: [
      {
        objectiveId: "named-evaluation",
        priority: 1,
        sourceFamily: "INDIVIDUAL_EVALUATION",
        direction: "MAXIMIZE",
        weightNumerator: 1,
        weightDenominator: 1,
      },
    ],
    currentReviewContext: {
      ...input.currentReviewContext,
      evidence: input.eligibleRevisions.flatMap((revision, index) => [
        {
          evidenceId: `evaluation-${revision.proposalRevisionId}`,
          proposalRevisionId: revision.proposalRevisionId,
          family: "INDIVIDUAL_EVALUATION" as const,
          visibility: "PUBLIC" as const,
          state: "CURRENT" as const,
          fingerprint: [HASH_A, HASH_B, HASH_C, HASH_D][index],
          contextFingerprint: input.currentReviewContext.fingerprint,
          value: 10 - index,
        },
        {
          evidenceId: `review-score-${revision.proposalRevisionId}`,
          proposalRevisionId: revision.proposalRevisionId,
          family: "CONFIDENTIAL_REVIEW_SCORE" as const,
          visibility: "BLIND_PRIVATE" as const,
          state: "CURRENT" as const,
          fingerprint: [HASH_D, HASH_C, HASH_B, HASH_A][index],
          contextFingerprint: input.currentReviewContext.fingerprint,
          score: 100 - index,
        },
        {
          evidenceId: `review-comment-${revision.proposalRevisionId}`,
          proposalRevisionId: revision.proposalRevisionId,
          family: "CONFIDENTIAL_REVIEW_COMMENT" as const,
          visibility: "BLIND_PRIVATE" as const,
          state: "CURRENT" as const,
          fingerprint: [HASH_C, HASH_D, HASH_A, HASH_B][index],
          contextFingerprint: input.currentReviewContext.fingerprint,
          comment: "private reviewer comment that must never be projected",
        },
        {
          evidenceId: `advocacy-${revision.proposalRevisionId}`,
          proposalRevisionId: revision.proposalRevisionId,
          family: "ADVOCACY" as const,
          visibility: "ORGANIZER_PRIVATE" as const,
          state: "CURRENT" as const,
          fingerprint: [HASH_B, HASH_A, HASH_D, HASH_C][index],
          contextFingerprint: input.currentReviewContext.fingerprint,
          stance: index === 0 ? "STRONGLY_PROMOTE" as const : "NO_POSITION" as const,
          strength: 90,
          rationale: "private advocacy rationale that must never be projected",
        },
      ]),
    },
  };
}

function overrideCommand(
  sourceInput: ProgramSelectionInput = baseInput(),
  sourceSlateOrdinal = 0,
): HumanOverrideProposalInput {
  const preview = previewProgramSelection(sourceInput);
  const sourceSlate = preview.slates[sourceSlateOrdinal];
  if (!sourceSlate) throw new Error("Fixture source slate is unavailable");
  return {
    commandId: "override-command-1",
    scope,
    sourceInputFingerprint: preview.inputFingerprint,
    sourcePreviewFingerprint: preview.fingerprint,
    sourceSlateOrdinal: sourceSlate.ordinal,
    sourceSlateFingerprint: sourceSlate.contentFingerprint,
    sourceStatus: "READY",
    targetCount: preview.targetCount,
    eligibilityContextFingerprint: preview.eligibilityContextFingerprint,
    selectionContextFingerprint: preview.reviewContextFingerprint,
    capacityLedgerFingerprint: preview.capacityLedgerFingerprint,
    exactRevisionBindings: sourceSlate.entries.map((entry) => ({
      proposalRevisionId: entry.proposalRevisionId,
      revisionFingerprint: entry.revisionFingerprint,
    })),
    sourceSelectedProposalRevisionIds: [...sourceSlate.selectedProposalRevisionIds],
    sourceDisplacedBindings: sourceSlate.displacedAlternatives.map((item) => ({
      displacedProposalRevisionId: item.displacedProposalRevisionId,
      includedInsteadProposalRevisionId: item.includedInsteadProposalRevisionId,
      reasonCode: item.reasonCode,
      relatedConstraintIds: [...item.relatedConstraintIds],
      relatedObjectiveIds: [...item.relatedObjectiveIds],
    })),
    proposal: {
      selectedProposalRevisionIds: [...sourceSlate.selectedProposalRevisionIds],
      allocations: sourceSlate.entries
        .filter((entry) => entry.allocation !== null)
        .map((entry) => ({ proposalRevisionId: entry.proposalRevisionId, ...entry.allocation! })),
    },
    actor: {
      actorId: "actor-organizer",
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      role: "organizer",
    },
    purpose: "PROGRAM_SELECTION_OVERRIDE_PROPOSAL",
    retention: {
      policyId: "retention-policy",
      policyVersion: "v1",
      policyFingerprint: HASH_C,
      disposition: "RETAIN_IMMUTABLE_AUDIT",
    },
    authorityVector: {
      vectorId: "authority-vector",
      vectorVersion: "v1",
      vectorFingerprint: HASH_D,
      actorId: "actor-organizer",
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      capabilities: ["PROPOSE_PROGRAM_SELECTION_OVERRIDE"],
      current: true,
    },
    idempotencyKey: "override-once",
    reason: "Human review proposes an alternative for explicit later decision.",
  };
}

type IdempotencyResolver = (
  binding: HumanOverrideIdempotencyBinding,
) => HumanOverrideIdempotencyResolution | null;

function trustedAdapter(
  sourceInput: ProgramSelectionInput,
  resolveIdempotencyState: IdempotencyResolver = (binding) => ({
    state: "UNSEEN",
    binding,
    matchedReceipt: null,
  }),
): HumanOverrideTrustedAdapter {
  return {
    resolveProgramSelectionInput: () => sourceInput,
    resolveIdempotencyState,
  };
}

describe("curatorial separation pure core", () => {
  it("keeps evaluation, confidential review, and advocacy as distinct evidence and never projects private values", () => {
    const preview = previewProgramSelection(privateEvidenceInput());
    expect(preview.status).toBe("READY");
    expect(new Set(preview.slates[0].objectiveContributions.map((item) => item.sourceFamily))).toEqual(
      new Set(["INDIVIDUAL_EVALUATION"]),
    );
    expect(preview.slates[0].objectiveContributions.every((item) => item.redacted === false)).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("private reviewer comment");
    expect(JSON.stringify(preview)).not.toContain("private advocacy rationale");
    expect(JSON.stringify(preview)).not.toContain('"score"');
    expect(JSON.stringify(preview)).not.toContain('"value":{"numerator":"100"');

    const advocacySource = privateEvidenceInput();
    const advocacyChanged = {
      ...advocacySource,
      currentReviewContext: {
      ...advocacySource.currentReviewContext,
      evidence: advocacySource.currentReviewContext.evidence.map((item) =>
        item.family === "ADVOCACY" && item.proposalRevisionId === "revision-a"
          ? { ...item, stance: "OPPOSE" as const, strength: 1 }
          : item,
      ),
      },
    } as ProgramSelectionInput;
    expect(selected(previewProgramSelection(advocacyChanged))).toEqual(selected(preview));
  });

  it("compares whole slates, emits multiple alternatives, and explains displaced revisions", () => {
    const input = baseInput({
      objectives: [
        {
          objectiveId: "topic-diversity",
          priority: 1,
          sourceFamily: "TOPIC_BALANCE",
          direction: "MAXIMIZE",
          weightNumerator: 1,
          weightDenominator: 1,
        },
      ],
      configuration: { maxCandidateSlates: 3, maxSearchNodes: 20_000 },
    });
    const preview = previewProgramSelection(input);
    expect(preview.status).toBe("READY");
    expect(preview.slates.length).toBe(3);
    expect(new Set(selected(preview).map((value) => value.join("|"))).size).toBe(3);
    expect(preview.slates[0].selectedProposalRevisionIds).toEqual(["revision-c", "revision-d"]);
    const displaced = preview.slates[0].displacedAlternatives.find(
      (item) => item.displacedProposalRevisionId === "revision-a",
    );
    expect(displaced).toBeDefined();
    expect(displaced?.includedInsteadProposalRevisionId).not.toBeNull();
    expect(displaced?.reasonCode).toBe("OBJECTIVE_ORDER");
    expect(preview.slates[0].rankingBasis.explanation).toContain("No opaque aggregate score");
    expect(preview.slates[0]).not.toHaveProperty("score");
  });

  it("conserves typed capacity across explicit transfers and rejects mismatched receipts", () => {
    const input = baseInput({
      pools: [
        { poolId: "pool-main", poolVersionId: "pool-main-v1", unitKind: "SESSION", capacity: 3, remaining: 3 },
        { poolId: "pool-special", poolVersionId: "pool-special-v1", unitKind: "SESSION", capacity: 1, remaining: 1 },
      ],
      eligibleRevisions: baseInput().eligibleRevisions.map((revision, index) => ({
        ...revision,
        allocationOptions: index === 0
          ? [{ poolId: "pool-special", poolVersionId: "pool-special-v1", unitKind: "SESSION", quantity: 1 }]
          : revision.allocationOptions,
      })),
      transfers: [transfer({
        transferId: "transfer-1",
        sequenceNumber: 1,
        sourcePoolId: "pool-main",
        sourcePoolVersionId: "pool-main-v1",
        destinationPoolId: "pool-special",
        destinationPoolVersionId: "pool-special-v1",
        unitKind: "SESSION",
        quantity: 1,
        sourceBefore: 3,
        sourceAfter: 2,
        destinationBefore: 1,
        destinationAfter: 2,
      })],
    });
    const preview = previewProgramSelection(input);
    expect(preview.status).toBe("READY");
    expect(preview.slates[0].capacityUsage.find((item) => item.poolId === "pool-special")).toMatchObject({
      remainingBefore: 2,
      used: 1,
      remainingAfter: 1,
    });
    const badTransfer = input.transfers[0];
    expectError(
      () => previewProgramSelection({ ...input, transfers: [{ ...badTransfer, sourceBefore: 2 }] }),
      "CURATORIAL_CAPACITY_LEDGER_BLOCKED",
    );
    expectError(
      () => previewProgramSelection({
        ...input,
        transfers: [{ ...badTransfer, fingerprint: HASH_A, destinationAfter: 99 }],
      }),
      "CURATORIAL_CAPACITY_LEDGER_BLOCKED",
    );
    expectError(
      () => previewProgramSelection({
        ...input,
        eligibleRevisions: input.eligibleRevisions.map((revision, index) =>
          index === 0
            ? { ...revision, allocationOptions: [{ ...revision.allocationOptions[0], poolVersionId: "wrong-version" }] }
            : revision,
        ),
      }),
      "CURATORIAL_CAPACITY_LEDGER_BLOCKED",
    );
  });

  it("returns BLOCKED or UNAVAILABLE for stale, conflicting, and missing exact context", () => {
    const staleEligibility = previewProgramSelection({
      ...baseInput(),
      eligibilityContext: { ...baseInput().eligibilityContext, status: "STALE" },
    });
    expect(staleEligibility.status).toBe("BLOCKED");
    expect(staleEligibility.slates).toHaveLength(0);
    expect(staleEligibility.blockers[0].code).toBe("ELIGIBILITY_BLOCKED");

    const missingReview = previewProgramSelection({
      ...baseInput(),
      currentReviewContext: { ...baseInput().currentReviewContext, status: "MISSING" },
    });
    expect(missingReview.status).toBe("UNAVAILABLE");
    expect(missingReview.blockers[0].code).toBe("REVIEW_CONTEXT_UNAVAILABLE");

    const conflictingSource = privateEvidenceInput();
    const conflictingEvidence = {
      ...conflictingSource,
      currentReviewContext: {
        ...conflictingSource.currentReviewContext,
        evidence: conflictingSource.currentReviewContext.evidence.map((item) =>
        item.evidenceId === "evaluation-revision-a" ? { ...item, state: "CONFLICTING" as const } : item,
        ),
      },
    } as ProgramSelectionInput;
    const blocked = previewProgramSelection(conflictingEvidence);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blockers.some((item) => item.code === "REVIEW_EVIDENCE_BLOCKED")).toBe(true);
  });

  it("projects no affiliations or private evidence, and freezes detached output", () => {
    const input = privateEvidenceInput();
    const preview = previewProgramSelection(input);
    const mutableInput = input as unknown as {
      eligibleRevisions: Array<{ organizationId: string }>;
      currentReviewContext: { evidence: Array<{ value?: number }> };
    };
    mutableInput.eligibleRevisions[0].organizationId = "mutated-org";
    mutableInput.currentReviewContext.evidence[0].value = 999;
    expect(JSON.stringify(preview)).not.toContain("mutated-org");
    expect(JSON.stringify(preview)).not.toContain("org-one");
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.slates)).toBe(true);
    expect(Object.isFrozen(preview.slates[0])).toBe(true);
    expect(Object.isFrozen(preview.slates[0].entries)).toBe(true);
    expect(Object.isFrozen(preview.explanationReceipts[0])).toBe(true);
  });

  it("is stable across permutations and rejects hostile descriptor data, aliases, cycles, and bounds", () => {
    const input = baseInput({
      constraints: [{ constraintId: "distinct-topics", kind: "MIN_DISTINCT_TOPICS", hard: true, limit: 2 }],
    });
    const first = previewProgramSelection(input);
    const permuted = {
      ...input,
      eligibleRevisions: [...input.eligibleRevisions].reverse().map((revision) => ({
        ...revision,
        topics: [...revision.topics].reverse(),
        allocationOptions: [...revision.allocationOptions].reverse(),
      })),
      pools: [...input.pools].reverse(),
      constraints: [...input.constraints].reverse(),
    };
    expect(previewProgramSelection(permuted).fingerprint).toBe(first.fingerprint);

    const getter = { ...input } as Record<string, unknown>;
    let getterReads = 0;
    Object.defineProperty(getter, "eligibleRevisions", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return input.eligibleRevisions;
      },
    });
    expectError(() => previewProgramSelection(getter as unknown as ProgramSelectionInput), "CURATORIAL_INPUT_UNSAFE");
    expect(getterReads).toBe(0);

    const proxy = new Proxy(input.eligibleRevisions, {});
    expectError(
      () => previewProgramSelection({ ...input, eligibleRevisions: proxy }),
      "CURATORIAL_INPUT_UNSAFE",
    );
    const cycle: Record<string, unknown> = {};
    cycle.cycle = cycle;
    expectError(() => previewProgramSelection(cycle as unknown as ProgramSelectionInput), "CURATORIAL_INPUT_UNSAFE");
    expectError(() => previewProgramSelection({ ...input, score: 10 } as ProgramSelectionInput & { score: number }), "CURATORIAL_SHAPE_INVALID");
    expectError(
      () => previewProgramSelection({ ...input, eligibleRevisions: Array.from({ length: CURATORIAL_LIMITS.maxProposalRevisions + 1 }, () => input.eligibleRevisions[0]) }),
      "CURATORIAL_SHAPE_INVALID",
    );
  });

  it("requires the trusted adapter even when an attacker recomputes every public source hash", () => {
    const sourceInput = baseInput();
    const command = overrideCommand(sourceInput);
    expectError(
      () => buildHumanOverrideProposalReceipt(
        command,
        undefined as unknown as HumanOverrideTrustedAdapter,
      ),
      "CURATORIAL_TRUSTED_ADAPTER_REQUIRED",
    );

    const embeddedAuthority = {
      ...command,
      sourcePreview: previewProgramSelection(sourceInput),
      idempotencyEvidence: {
        authority: "AUTHORITATIVE_IDEMPOTENCY_STORE",
        state: "UNSEEN",
        fingerprint: command.sourcePreviewFingerprint,
      },
    };
    expectError(
      () => buildHumanOverrideProposalReceipt(
        embeddedAuthority as unknown as HumanOverrideProposalInput,
        trustedAdapter(sourceInput),
      ),
      "CURATORIAL_SHAPE_INVALID",
    );
    expect(curatorialCore).not.toHaveProperty("bindHumanOverrideIdempotencyRequest");
    expect(curatorialCore).not.toHaveProperty("curatorialOverrideIdempotencyEvidenceFingerprint");
  });

  it("re-previews canonical adapter input and rejects self-consistent attacker and foreign source state", () => {
    const canonicalInput = baseInput();
    const attackerInput = baseInput({ deterministicSeed: "attacker-controlled-seed" });
    const attackerCommand = overrideCommand(attackerInput);
    expectError(
      () => buildHumanOverrideProposalReceipt(
        attackerCommand,
        trustedAdapter(canonicalInput),
      ),
      "CURATORIAL_OVERRIDE_MISMATCH",
    );

    const command = overrideCommand(canonicalInput);
    const foreignInput = baseInput({
      scope: { workspaceId: "workspace-foreign", eventId: scope.eventId },
    });
    expectError(
      () => buildHumanOverrideProposalReceipt(command, trustedAdapter(foreignInput)),
      "CURATORIAL_OVERRIDE_MISMATCH",
    );
    expectError(
      () => buildHumanOverrideProposalReceipt(command, {
        ...trustedAdapter(canonicalInput),
        resolveProgramSelectionInput: () => null,
      }),
      "CURATORIAL_OVERRIDE_MISMATCH",
    );
  });

  it("binds exact recomputed revision, context, capacity, slate, selected, displaced, and ordinal evidence", () => {
    const sourceInput = baseInput();
    const command = overrideCommand(sourceInput);
    const forgedSourceClaims: HumanOverrideProposalInput[] = [
      { ...command, sourceInputFingerprint: HASH_A },
      { ...command, sourcePreviewFingerprint: HASH_A },
      { ...command, sourceSlateOrdinal: 1 },
      { ...command, sourceSlateFingerprint: HASH_A },
      { ...command, targetCount: 1 },
      { ...command, eligibilityContextFingerprint: HASH_D },
      { ...command, selectionContextFingerprint: HASH_A },
      { ...command, capacityLedgerFingerprint: HASH_A },
      {
        ...command,
        exactRevisionBindings: command.exactRevisionBindings.map((binding, index) =>
          index === 0 ? { ...binding, revisionFingerprint: HASH_D } : binding,
        ),
      },
      {
        ...command,
        sourceSelectedProposalRevisionIds: command.sourceSelectedProposalRevisionIds.slice(1),
      },
      {
        ...command,
        sourceDisplacedBindings: command.sourceDisplacedBindings.map((binding, index) =>
          index === 0
            ? { ...binding, displacedProposalRevisionId: "revision-foreign" }
            : binding,
        ),
      },
    ];
    for (const forged of forgedSourceClaims) {
      expectError(
        () => buildHumanOverrideProposalReceipt(forged, trustedAdapter(sourceInput)),
        "CURATORIAL_OVERRIDE_MISMATCH",
      );
    }

    expectError(
      () => buildHumanOverrideProposalReceipt({
        ...command,
        proposal: {
          selectedProposalRevisionIds: [
            ...command.proposal.selectedProposalRevisionIds.slice(0, -1),
            "revision-foreign",
          ].sort(),
          allocations: command.proposal.allocations,
        },
      }, trustedAdapter(sourceInput)),
      "CURATORIAL_OVERRIDE_MISMATCH",
    );
    expectError(
      () => buildHumanOverrideProposalReceipt({
        ...command,
        authorityVector: {
          ...command.authorityVector,
          capabilities: ["EXECUTE_SELECTION"] as never,
        },
      }, trustedAdapter(sourceInput)),
      "CURATORIAL_AUTHORITY_INVALID",
    );
  });

  it("accepts exact UNSEEN and MATCHED state while emitting only a frozen proposal receipt", () => {
    const sourceInput = privateEvidenceInput();
    const command = overrideCommand(sourceInput);
    const capture: { binding?: HumanOverrideIdempotencyBinding } = {};
    const receipt: HumanOverrideProposalReceipt = buildHumanOverrideProposalReceipt(
      command,
      trustedAdapter(sourceInput, (binding) => {
        capture.binding = binding;
        return { state: "UNSEEN", binding, matchedReceipt: null };
      }),
    );
    const capturedBinding = capture.binding;
    if (!capturedBinding) throw new Error("Fixture idempotency binding was not captured");
    expect(capturedBinding).toMatchObject({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sourceInputFingerprint: receipt.sourceInputFingerprint,
      sourcePreviewFingerprint: receipt.sourcePreviewFingerprint,
      eligibilityContextFingerprint: receipt.eligibilityContextFingerprint,
      selectionContextFingerprint: receipt.selectionContextFingerprint,
      capacityLedgerFingerprint: receipt.capacityLedgerFingerprint,
      exactRevisionBindings: receipt.exactRevisionBindings,
      targetSlateOrdinal: receipt.sourceSlateOrdinal,
      targetSlateFingerprint: receipt.sourceSlateFingerprint,
      targetSelectedProposalRevisionIds: receipt.sourceSelectedProposalRevisionIds,
      targetDisplacedBindings: receipt.sourceDisplacedBindings,
      overridePayloadFingerprint: receipt.overridePayloadFingerprint,
    });
    expect(capturedBinding.actorFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(capturedBinding.purposeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(capturedBinding.retentionFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(capturedBinding.authorityVectorFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(capturedBinding)).toBe(true);
    expect(Object.isFrozen(capturedBinding.exactRevisionBindings)).toBe(true);

    expect(receipt.authority).toBe("NONE");
    expect(receipt.proposalOnly).toBe(true);
    expect(receipt.noCapacityMutation).toBe(true);
    expect(receipt.noSpeakerNotification).toBe(true);
    expect(receipt).not.toHaveProperty("sourceInput");
    expect(receipt).not.toHaveProperty("sourcePreview");
    expect(receipt).not.toHaveProperty("adapter");
    expect(receipt).not.toHaveProperty("idempotencyResolution");
    expect(receipt).not.toHaveProperty("matchedReceipt");
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.sourceDisplacedBindings)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("private reviewer comment");
    expect(JSON.stringify(receipt)).not.toContain("private advocacy rationale");
    expect(JSON.stringify(receipt)).not.toContain("org-one");
    expect(JSON.stringify(receipt)).not.toMatch(/execute|notify|apply|send/iu);

    const replayed = buildHumanOverrideProposalReceipt(
      command,
      trustedAdapter(sourceInput, (binding) => ({
        state: "MATCHED",
        binding,
        matchedReceipt: receipt,
      })),
    );
    expect(replayed.replayed).toBe(true);
    expect(replayed.fingerprint).toBe(receipt.fingerprint);
  });

  it("blocks missing, mismatched, foreign, and replay-mismatched adapter idempotency results", () => {
    const sourceInput = baseInput();
    const command = overrideCommand(sourceInput);
    const capture: { binding?: HumanOverrideIdempotencyBinding } = {};
    const receipt = buildHumanOverrideProposalReceipt(
      command,
      trustedAdapter(sourceInput, (binding) => {
        capture.binding = binding;
        return { state: "UNSEEN", binding, matchedReceipt: null };
      }),
    );
    const capturedBinding = capture.binding;
    if (!capturedBinding) throw new Error("Fixture idempotency binding was not captured");
    const storedBinding = capturedBinding;

    expectError(
      () => buildHumanOverrideProposalReceipt(command, trustedAdapter(sourceInput, () => null)),
      "CURATORIAL_IDEMPOTENCY_INVALID",
    );
    expectError(
      () => buildHumanOverrideProposalReceipt(command, trustedAdapter(sourceInput, (binding) => ({
        state: "MISMATCHED",
        binding,
        matchedReceipt: null,
      }))),
      "CURATORIAL_IDEMPOTENCY_INVALID",
    );
    expectError(
      () => buildHumanOverrideProposalReceipt(command, trustedAdapter(sourceInput, (binding) => ({
        state: "UNSEEN",
        binding: { ...binding, commandId: "foreign-command" },
        matchedReceipt: null,
      }))),
      "CURATORIAL_IDEMPOTENCY_INVALID",
    );
    expectError(
      () => buildHumanOverrideProposalReceipt(command, trustedAdapter(sourceInput, (binding) => ({
        state: "UNSEEN",
        binding,
        matchedReceipt: receipt,
      }))),
      "CURATORIAL_IDEMPOTENCY_INVALID",
    );
    expectError(
      () => buildHumanOverrideProposalReceipt(command, trustedAdapter(sourceInput, (binding) => ({
        state: "MATCHED",
        binding,
        matchedReceipt: null,
      }))),
      "CURATORIAL_IDEMPOTENCY_INVALID",
    );

    const otherCommand = {
      ...command,
      commandId: "override-command-other",
      idempotencyKey: "override-other",
    };
    const otherReceipt = buildHumanOverrideProposalReceipt(
      otherCommand,
      trustedAdapter(sourceInput),
    );
    expectError(
      () => buildHumanOverrideProposalReceipt(command, trustedAdapter(sourceInput, (binding) => ({
        state: "MATCHED",
        binding,
        matchedReceipt: otherReceipt,
      }))),
      "CURATORIAL_OVERRIDE_REPLAY",
    );

    const bindingMismatches: HumanOverrideProposalInput[] = [
      { ...command, commandId: "different-command" },
      { ...command, idempotencyKey: "different-key" },
      { ...command, actor: { ...command.actor, role: "program_manager" } },
      {
        ...command,
        retention: { ...command.retention, policyVersion: "v2" },
      },
      {
        ...command,
        authorityVector: {
          ...command.authorityVector,
          vectorVersion: "v2",
          vectorFingerprint: HASH_A,
        },
      },
      { ...command, reason: "A different override payload." },
    ];
    for (const mismatchedCommand of bindingMismatches) {
      expectError(
        () => buildHumanOverrideProposalReceipt(
          mismatchedCommand,
          trustedAdapter(sourceInput, () => ({
            state: "UNSEEN",
            binding: storedBinding,
            matchedReceipt: null,
          })),
        ),
        "CURATORIAL_IDEMPOTENCY_INVALID",
      );
    }
  });
});
