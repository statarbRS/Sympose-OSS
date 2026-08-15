import {
  AuthorityPurposeKernelInputError,
  createCommandEnvelope,
  preflightAuthorityPurpose,
} from "../authority-purpose-kernel";
import {
  ChangeRadiusError,
  preflightChangeRadius,
} from "../change-radius";
import {
  CuratorialSeparationError,
  previewProgramSelection,
  type ObjectiveContribution,
} from "../curatorial-separation";
import {
  ProofGraphValidationError,
  evaluateReadinessProofGraph,
} from "../readiness-proof-graph";
import {
  SurgicalReconfirmationError,
  deriveSurgicalReconfirmation,
} from "../surgical-reconfirmation";

import {
  DECISION_INTELLIGENCE_PROJECTION_SCHEMA,
  type AuthorityPurposeCheckProjection,
  type ChangeRadiusCheckProjection,
  type CuratorialCheckProjection,
  type CuratorialSlateProjection,
  type DecisionIntelligenceProjection,
  type DecisionIntelligenceProjectionInput,
  type DecisionIntelligenceScope,
  type NamedContributionProjection,
  type ReadinessCheckProjection,
  type ReconfirmationCheckProjection,
} from "./contracts";

export * from "./contracts";

const ROUTE_SCOPE_MISMATCH = "ROUTE_SCOPE_MISMATCH";

function sameScope(
  expected: DecisionIntelligenceScope,
  actual: { readonly workspaceId: string; readonly eventId?: string },
): boolean {
  return expected.workspaceId === actual.workspaceId && expected.eventId === actual.eventId;
}

function frozen<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") throw new Error("INVALID_ADAPTER_INPUT");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("INVALID_ADAPTER_INPUT");
  return descriptor.value;
}

function errorCode(error: unknown): string {
  if (
    error instanceof AuthorityPurposeKernelInputError ||
    error instanceof ChangeRadiusError ||
    error instanceof CuratorialSeparationError ||
    error instanceof SurgicalReconfirmationError ||
    error instanceof ProofGraphValidationError
  ) {
    return error.code;
  }
  return "CORE_INPUT_REJECTED";
}

function authorityUnavailable(): AuthorityPurposeCheckProjection {
  return {
    status: "UNAVAILABLE",
    code: "AUTHORITY_PURPOSE_EVIDENCE_NOT_PROJECTED",
    explanation:
      "The route did not provide an exact actor, purpose, retention, authority-vector, and idempotency evidence bundle. No authority is inferred.",
    commandFingerprint: null,
    blockers: [],
  };
}

function projectAuthorityPurpose(
  scope: DecisionIntelligenceScope,
  input: DecisionIntelligenceProjectionInput["authorityPurpose"],
): AuthorityPurposeCheckProjection {
  if (input === undefined || input === null) return authorityUnavailable();
  try {
    const result = preflightAuthorityPurpose(input);
    const command = createCommandEnvelope(ownData(input, "command"));
    if (!sameScope(scope, command)) {
      return {
        status: "BLOCKED",
        code: ROUTE_SCOPE_MISMATCH,
        explanation: "The exact command scope does not match the trusted route scope.",
        commandFingerprint: null,
        blockers: [{ code: ROUTE_SCOPE_MISMATCH, path: "command.scope" }],
      };
    }
    return {
      status: result.state,
      code: result.state === "READY" ? "EXACT_EVIDENCE_READY" : result.state,
      explanation:
        result.state === "READY"
          ? "Every supplied exact evidence binding passed the purpose-kernel preflight. This remains a preflight result, not mutation authority."
          : result.state === "UNAVAILABLE"
            ? "One or more exact authority or purpose bindings are unavailable; the adapter fails closed."
            : "One or more exact authority or purpose bindings are blocked; the adapter fails closed.",
      commandFingerprint: result.commandFingerprint,
      blockers: result.receipts.map((receipt) => ({ code: receipt.code, path: receipt.path })),
    };
  } catch (error) {
    return {
      status: "BLOCKED",
      code: errorCode(error),
      explanation: "The authority-purpose core rejected the supplied bounded evidence.",
      commandFingerprint: null,
      blockers: [],
    };
  }
}

function readinessUnavailable(): ReadinessCheckProjection {
  return {
    status: "UNAVAILABLE",
    code: "READINESS_PROOF_GRAPH_NOT_PROJECTED",
    explanation:
      "No exact readiness proof graph is present in the route projection. Readiness is unavailable rather than estimated from nearby records.",
    fingerprint: null,
    outcomes: [],
  };
}

function projectReadiness(
  scope: DecisionIntelligenceScope,
  input: DecisionIntelligenceProjectionInput["readiness"],
): ReadinessCheckProjection {
  if (input === undefined || input === null) return readinessUnavailable();
  try {
    const result = evaluateReadinessProofGraph(input);
    if (!sameScope(scope, result.scope)) {
      return {
        status: "BLOCKED",
        code: ROUTE_SCOPE_MISMATCH,
        explanation: "The readiness graph scope does not match the trusted route scope.",
        fingerprint: null,
        outcomes: [],
      };
    }
    return {
      status: result.status,
      code: result.status === "READY" ? "EXACT_PROOF_READY" : result.status,
      explanation:
        result.status === "READY"
          ? "Every declared proof requirement is backed by exact current evidence. The graph does not approve or execute a downstream action."
          : result.status === "UNAVAILABLE"
            ? "At least one exact readiness requirement lacks available evidence."
            : "At least one exact readiness requirement is blocked.",
      fingerprint: result.fingerprint,
      outcomes: result.outcomes.map((outcome) => ({
        outcome: outcome.outcome,
        status: outcome.status,
        blockerCodes: outcome.minimalBlockers.map((blocker) => blocker.code),
        nextActions: outcome.nextActions.map((action) => ({
          kind: action.kind,
          label: action.label,
        })),
      })),
    };
  } catch (error) {
    return {
      status: "BLOCKED",
      code: errorCode(error),
      explanation: "The readiness proof-graph core rejected the supplied bounded evidence.",
      fingerprint: null,
      outcomes: [],
    };
  }
}

function contribution(item: ObjectiveContribution): NamedContributionProjection {
  return {
    objectiveId: item.objectiveId,
    sourceFamily: item.sourceFamily,
    proposalRevisionId: item.proposalRevisionId,
    value: item.value === null
      ? null
      : { numerator: item.value.numerator, denominator: item.value.denominator },
    redacted: item.redacted,
    explanation: item.explanation,
  };
}

function slateProjection(
  slate: ReturnType<typeof previewProgramSelection>["slates"][number],
): CuratorialSlateProjection {
  const contributions = slate.objectiveContributions.map(contribution);
  return {
    ordinal: slate.ordinal,
    fingerprint: slate.contentFingerprint,
    selectedProposalRevisionIds: [...slate.selectedProposalRevisionIds],
    contributionLanes: {
      evaluation: contributions.filter((item) =>
        item.sourceFamily === "INDIVIDUAL_EVALUATION" ||
        item.sourceFamily === "CONFIDENTIAL_REVIEW_SCORE"),
      advocacy: contributions.filter((item) => item.sourceFamily === "ADVOCACY"),
      programObjectives: contributions.filter((item) =>
        item.sourceFamily !== "INDIVIDUAL_EVALUATION" &&
        item.sourceFamily !== "CONFIDENTIAL_REVIEW_SCORE" &&
        item.sourceFamily !== "ADVOCACY"),
    },
    objectiveTotals: slate.objectiveTotals.map((total) => ({
      objectiveId: total.objectiveId,
      sourceFamily: total.sourceFamily,
      direction: total.direction,
      value: total.value === null
        ? null
        : { numerator: total.value.numerator, denominator: total.value.denominator },
      redacted: total.redacted,
      explanation: total.explanation,
    })),
    displacedAlternatives: slate.displacedAlternatives.map((alternative) => ({
      displacedProposalRevisionId: alternative.displacedProposalRevisionId,
      includedInsteadProposalRevisionId: alternative.includedInsteadProposalRevisionId,
      reasonCode: alternative.reasonCode,
      relatedConstraintIds: [...alternative.relatedConstraintIds],
      relatedObjectiveIds: [...alternative.relatedObjectiveIds],
      explanation: alternative.explanation,
    })),
    capacityUsage: slate.capacityUsage.map((pool) => ({ ...pool })),
    comparisonMethod: "NAMED_OBJECTIVES_IN_DECLARED_ORDER",
    comparisonExplanation: slate.rankingBasis.explanation,
  };
}

function curatorialUnavailable(): CuratorialCheckProjection {
  return {
    status: "UNAVAILABLE",
    code: "CURATORIAL_EVIDENCE_NOT_PROJECTED",
    explanation:
      "Exact proposal revisions, eligibility, current review context, typed capacity pools, constraints, and named objectives are not all present. No slate or displacement is invented.",
    fingerprint: null,
    targetCount: null,
    objectiveDeclarations: [],
    blockers: [],
    slates: [],
    previewOnly: true,
    authority: "NONE",
    hasOpaqueAggregateScore: false,
  };
}

function projectCuratorial(
  scope: DecisionIntelligenceScope,
  input: DecisionIntelligenceProjectionInput["curatorialSelection"],
): CuratorialCheckProjection {
  if (input === undefined || input === null) return curatorialUnavailable();
  try {
    const result = previewProgramSelection(input);
    if (!sameScope(scope, result.scope)) {
      return {
        ...curatorialUnavailable(),
        status: "BLOCKED",
        code: ROUTE_SCOPE_MISMATCH,
        explanation: "The curatorial preview scope does not match the trusted route scope.",
      };
    }
    return {
      status: result.status,
      code: result.status === "READY" ? "WHOLE_SLATE_PREVIEW_READY" : result.status,
      explanation:
        result.status === "READY"
          ? "Deterministic whole-slate alternatives are available as proposal-only evidence."
          : result.status === "UNAVAILABLE"
            ? "Exact curatorial evidence is unavailable; no slate is synthesized."
            : "Exact curatorial evidence is blocked or no feasible slate exists.",
      fingerprint: result.fingerprint,
      targetCount: result.targetCount,
      objectiveDeclarations: [...input.objectives]
        .sort((left, right) =>
          left.priority - right.priority ||
          (left.objectiveId < right.objectiveId ? -1 : left.objectiveId > right.objectiveId ? 1 : 0))
        .map((objective) => ({
          objectiveId: objective.objectiveId,
          priority: objective.priority,
          sourceFamily: objective.sourceFamily,
          direction: objective.direction,
          contributionScale: {
            numerator: objective.weightNumerator,
            denominator: objective.weightDenominator,
          },
          comparisonRole: "LEXICOGRAPHIC_NAMED_OBJECTIVE" as const,
        })),
      blockers: result.blockers.map((blocker) => ({
        code: blocker.code,
        family: blocker.family,
        proposalRevisionId: blocker.proposalRevisionId,
      })),
      slates: result.slates.map(slateProjection),
      previewOnly: true,
      authority: "NONE",
      hasOpaqueAggregateScore: false,
    };
  } catch (error) {
    return {
      ...curatorialUnavailable(),
      status: "BLOCKED",
      code: errorCode(error),
      explanation: "The curatorial-separation core rejected the supplied bounded evidence.",
    };
  }
}

function changeRadiusUnavailable(): ChangeRadiusCheckProjection {
  return {
    status: "UNAVAILABLE",
    code: "CHANGE_RADIUS_SOURCE_VECTOR_NOT_PROJECTED",
    explanation:
      "No exact before-source vector and proposed change envelope is present. Downstream impact is unavailable rather than guessed.",
    fingerprint: null,
    materiality: null,
    requiresReview: false,
    requiresReconfirmation: false,
    affectedRecords: [],
    previewOnly: true,
    canApply: false,
    canSend: false,
  };
}

function projectChangeRadius(
  scope: DecisionIntelligenceScope,
  input: DecisionIntelligenceProjectionInput["changeRadius"],
): ChangeRadiusCheckProjection {
  if (input === undefined || input === null) return changeRadiusUnavailable();
  try {
    const result = preflightChangeRadius(input);
    if (!sameScope(scope, result.scope)) {
      return {
        ...changeRadiusUnavailable(),
        status: "BLOCKED",
        code: ROUTE_SCOPE_MISMATCH,
        explanation: "The change-radius scope does not match the trusted route scope.",
      };
    }
    return {
      status: result.blocking ? "BLOCKED" : "READY",
      code: result.blocking ? "CHANGE_RADIUS_BLOCKING" : "CHANGE_RADIUS_PREVIEW_READY",
      explanation:
        "The reviewed change-radius core produced a non-authoritative impact preview. It cannot apply the change or send a notification.",
      fingerprint: result.fingerprint,
      materiality: result.materiality,
      requiresReview: result.requiresReview,
      requiresReconfirmation: result.requiresReconfirmation,
      affectedRecords: result.affectedRecords.map((record) => ({
        family: record.family,
        recordId: record.recordId,
        materiality: record.materiality,
        changedTermKinds: record.changedTerms.map((term) => term.kind),
        reasonCode: record.reasonCode,
      })),
      previewOnly: true,
      canApply: false,
      canSend: false,
    };
  } catch (error) {
    return {
      ...changeRadiusUnavailable(),
      status: "BLOCKED",
      code: errorCode(error),
      explanation: "The change-radius core rejected the supplied bounded proposal.",
    };
  }
}

function reconfirmationUnavailable(): ReconfirmationCheckProjection {
  return {
    status: "UNAVAILABLE",
    code: "RECONFIRMATION_EVIDENCE_NOT_PROJECTED",
    explanation:
      "No exact before/after revision, material-term policy, stakeholder, authority, purpose, and retention bundle is present. Reconfirmation is not inferred.",
    fingerprint: null,
    planStatus: null,
    receipts: [],
    previewOnly: true,
    canNotify: false,
  };
}

function projectReconfirmation(
  scope: DecisionIntelligenceScope,
  input: DecisionIntelligenceProjectionInput["surgicalReconfirmation"],
): ReconfirmationCheckProjection {
  if (input === undefined || input === null) return reconfirmationUnavailable();
  try {
    const result = deriveSurgicalReconfirmation(input);
    if (!sameScope(scope, result.scope)) {
      return {
        ...reconfirmationUnavailable(),
        status: "BLOCKED",
        code: ROUTE_SCOPE_MISMATCH,
        explanation: "The reconfirmation scope does not match the trusted route scope.",
      };
    }
    const status = result.status === "BLOCKED"
      ? "BLOCKED"
      : result.status === "UNAVAILABLE"
        ? "UNAVAILABLE"
        : "READY";
    return {
      status,
      code: `RECONFIRMATION_${result.status}`,
      explanation:
        "The reviewed surgical-reconfirmation core identified only exact stakeholder/material-term receipts. This projection cannot notify or mutate a commitment.",
      fingerprint: result.fingerprint,
      planStatus: result.status,
      receipts: result.receipts.map((receipt) => ({
        stakeholderId: receipt.stakeholderId,
        targetRole: receipt.targetRole,
        kind: receipt.kind,
        status: receipt.status,
        reasonCode: receipt.reasonCode,
        materialTerms: receipt.materialTerms.map((term) => ({
          path: term.path,
          kind: term.kind,
          materiality: term.materiality,
        })),
      })),
      previewOnly: true,
      canNotify: false,
    };
  } catch (error) {
    return {
      ...reconfirmationUnavailable(),
      status: "BLOCKED",
      code: errorCode(error),
      explanation: "The surgical-reconfirmation core rejected the supplied bounded evidence.",
    };
  }
}

/**
 * Deterministic read-only composition over the reviewed pure cores. The
 * adapter exposes no callback, token, command executor, persistence handle,
 * capacity mutator, notifier, or approval surface.
 */
export function buildDecisionIntelligenceProjection(
  input: DecisionIntelligenceProjectionInput,
): Readonly<DecisionIntelligenceProjection> {
  const scope = {
    workspaceId: input.trustedScope.workspaceId,
    eventId: input.trustedScope.eventId,
  };
  const projection: DecisionIntelligenceProjection = {
    schema: DECISION_INTELLIGENCE_PROJECTION_SCHEMA,
    scope,
    authorityPurpose: projectAuthorityPurpose(scope, input.authorityPurpose),
    readiness: projectReadiness(scope, input.readiness),
    curatorialSelection: projectCuratorial(scope, input.curatorialSelection),
    changeRadius: projectChangeRadius(scope, input.changeRadius),
    surgicalReconfirmation: projectReconfirmation(scope, input.surgicalReconfirmation),
    authority: "NONE",
    proposalOnly: true,
    immutableProjection: true,
    canSelect: false,
    canApprove: false,
    canMutateCapacity: false,
    canNotify: false,
  };
  return frozen(projection);
}

export const projectDecisionIntelligence = buildDecisionIntelligenceProjection;
