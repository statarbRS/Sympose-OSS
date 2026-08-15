import type { PreflightInput } from "../authority-purpose-kernel";
import type { ProposedChangeCommandEnvelope } from "../change-radius";
import type { ProgramSelectionInput } from "../curatorial-separation";
import type { ReadinessProofGraphInput } from "../readiness-proof-graph";
import type { SurgicalReconfirmationCommand } from "../surgical-reconfirmation";

export const DECISION_INTELLIGENCE_PROJECTION_SCHEMA =
  "sympose-decision-intelligence-projection/v1" as const;

export type DecisionIntelligenceStatus = "READY" | "BLOCKED" | "UNAVAILABLE";

export interface DecisionIntelligenceScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

/**
 * Canonical inputs are optional because the existing organizer routes do not
 * expose every authority/evidence contract yet. Omission must project as
 * UNAVAILABLE; the adapter never fills a gap with inferred authority.
 */
export interface DecisionIntelligenceProjectionInput {
  readonly trustedScope: DecisionIntelligenceScope;
  readonly authorityPurpose?: PreflightInput | null;
  readonly readiness?: ReadinessProofGraphInput | null;
  readonly curatorialSelection?: ProgramSelectionInput | null;
  readonly changeRadius?: ProposedChangeCommandEnvelope | null;
  readonly surgicalReconfirmation?: SurgicalReconfirmationCommand | null;
}

export interface UnavailableDecisionIntelligenceCheck {
  readonly status: "UNAVAILABLE";
  readonly code: string;
  readonly explanation: string;
}

export interface BlockedDecisionIntelligenceCheck {
  readonly status: "BLOCKED";
  readonly code: string;
  readonly explanation: string;
}

export interface AuthorityPurposeCheckProjection {
  readonly status: DecisionIntelligenceStatus;
  readonly code: string;
  readonly explanation: string;
  readonly commandFingerprint: string | null;
  readonly blockers: readonly {
    readonly code: string;
    readonly path: string;
  }[];
}

export interface ReadinessCheckProjection {
  readonly status: DecisionIntelligenceStatus;
  readonly code: string;
  readonly explanation: string;
  readonly fingerprint: string | null;
  readonly outcomes: readonly {
    readonly outcome: string;
    readonly status: DecisionIntelligenceStatus;
    readonly blockerCodes: readonly string[];
    readonly nextActions: readonly {
      readonly kind: string;
      readonly label: string;
    }[];
  }[];
}

export interface NamedContributionProjection {
  readonly objectiveId: string;
  readonly sourceFamily: string;
  readonly proposalRevisionId: string;
  readonly value: {
    readonly numerator: string;
    readonly denominator: string;
  } | null;
  readonly redacted: boolean;
  readonly explanation: string;
}

export interface CuratorialSlateProjection {
  readonly ordinal: number;
  readonly fingerprint: string;
  readonly selectedProposalRevisionIds: readonly string[];
  readonly contributionLanes: {
    readonly evaluation: readonly NamedContributionProjection[];
    readonly advocacy: readonly NamedContributionProjection[];
    readonly programObjectives: readonly NamedContributionProjection[];
  };
  readonly objectiveTotals: readonly {
    readonly objectiveId: string;
    readonly sourceFamily: string;
    readonly direction: string;
    readonly value: {
      readonly numerator: string;
      readonly denominator: string;
    } | null;
    readonly redacted: boolean;
    readonly explanation: string;
  }[];
  readonly displacedAlternatives: readonly {
    readonly displacedProposalRevisionId: string;
    readonly includedInsteadProposalRevisionId: string | null;
    readonly reasonCode: string;
    readonly relatedConstraintIds: readonly string[];
    readonly relatedObjectiveIds: readonly string[];
    readonly explanation: string;
  }[];
  readonly capacityUsage: readonly {
    readonly poolId: string;
    readonly poolVersionId: string;
    readonly unitKind: string;
    readonly remainingBefore: number;
    readonly used: number;
    readonly remainingAfter: number;
  }[];
  readonly comparisonMethod: "NAMED_OBJECTIVES_IN_DECLARED_ORDER";
  readonly comparisonExplanation: string;
}

export interface CuratorialCheckProjection {
  readonly status: DecisionIntelligenceStatus;
  readonly code: string;
  readonly explanation: string;
  readonly fingerprint: string | null;
  readonly targetCount: number | null;
  readonly objectiveDeclarations: readonly {
    readonly objectiveId: string;
    readonly priority: number;
    readonly sourceFamily: string;
    readonly direction: string;
    readonly contributionScale: {
      readonly numerator: number;
      readonly denominator: number;
    };
    readonly comparisonRole: "LEXICOGRAPHIC_NAMED_OBJECTIVE";
  }[];
  readonly blockers: readonly {
    readonly code: string;
    readonly family: string;
    readonly proposalRevisionId: string | null;
  }[];
  readonly slates: readonly CuratorialSlateProjection[];
  readonly previewOnly: true;
  readonly authority: "NONE";
  readonly hasOpaqueAggregateScore: false;
}

export interface ChangeRadiusCheckProjection {
  readonly status: DecisionIntelligenceStatus;
  readonly code: string;
  readonly explanation: string;
  readonly fingerprint: string | null;
  readonly materiality: string | null;
  readonly requiresReview: boolean;
  readonly requiresReconfirmation: boolean;
  readonly affectedRecords: readonly {
    readonly family: string;
    readonly recordId: string;
    readonly materiality: string;
    readonly changedTermKinds: readonly string[];
    readonly reasonCode: string;
  }[];
  readonly previewOnly: true;
  readonly canApply: false;
  readonly canSend: false;
}

export interface ReconfirmationCheckProjection {
  readonly status: DecisionIntelligenceStatus;
  readonly code: string;
  readonly explanation: string;
  readonly fingerprint: string | null;
  readonly planStatus: string | null;
  readonly receipts: readonly {
    readonly stakeholderId: string;
    readonly targetRole: string;
    readonly kind: string;
    readonly status: string;
    readonly reasonCode: string;
    readonly materialTerms: readonly {
      readonly path: string;
      readonly kind: string;
      readonly materiality: string;
    }[];
  }[];
  readonly previewOnly: true;
  readonly canNotify: false;
}

export interface DecisionIntelligenceProjection {
  readonly schema: typeof DECISION_INTELLIGENCE_PROJECTION_SCHEMA;
  readonly scope: DecisionIntelligenceScope;
  readonly authorityPurpose: AuthorityPurposeCheckProjection;
  readonly readiness: ReadinessCheckProjection;
  readonly curatorialSelection: CuratorialCheckProjection;
  readonly changeRadius: ChangeRadiusCheckProjection;
  readonly surgicalReconfirmation: ReconfirmationCheckProjection;
  readonly authority: "NONE";
  readonly proposalOnly: true;
  readonly immutableProjection: true;
  readonly canSelect: false;
  readonly canApprove: false;
  readonly canMutateCapacity: false;
  readonly canNotify: false;
}
