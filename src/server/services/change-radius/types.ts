/**
 * Pure contracts for the Change-Radius preflight.
 *
 * This module deliberately contains no transport, persistence, authorization, or
 * side-effecting types. A command is a proposal only; authority is owned by the
 * caller's application workflow and is intentionally absent from the contract.
 */

export const CHANGE_RADIUS_SCHEMA_VERSION = 1 as const;
export const CHANGE_RADIUS_COMMAND_TYPE = "PROPOSE_CHANGE_RADIUS" as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const CHANGE_RADIUS_FAMILIES = [
  "SCHEDULE",
  "PEOPLE",
  "COMMITMENT",
  "ARTIFACT",
  "PUBLIC_RELEASE",
  "OPERATOR_RELEASE",
] as const;

export type ChangeRadiusFamily = (typeof CHANGE_RADIUS_FAMILIES)[number];

export const MATERIALITIES = [
  "INFORMATIONAL",
  "REVIEW",
  "RECONFIRMATION",
  "BLOCKING",
  "UNKNOWN",
] as const;

export type Materiality = (typeof MATERIALITIES)[number];

export const MATERIAL_TERM_KINDS = [
  "TIME",
  "DURATION",
  "ROLE",
  "VENUE",
  "RECORDING",
  "UNKNOWN",
] as const;

export type MaterialTermKind = (typeof MATERIAL_TERM_KINDS)[number];

export interface ChangeRadiusScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

export interface MaterialTimeTerm {
  readonly start?: string;
  readonly startAt?: string;
  readonly end?: string;
  readonly endAt?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
}

export type MaterialDurationTerm = number | { readonly minutes?: number; readonly seconds?: number };

export type MaterialRoleTerm = string | readonly string[] | { readonly key?: string; readonly roleKey?: string; readonly keys?: readonly string[] };

export type MaterialVenueTerm =
  | string
  | {
      readonly venueId?: string;
      readonly roomId?: string;
      readonly locationId?: string;
      readonly room?: string;
      readonly name?: string;
      readonly address?: string;
      readonly [key: string]: unknown;
    };

export type MaterialRecordingTerm =
  | boolean
  | string
  | {
      readonly enabled?: boolean;
      readonly required?: boolean;
      readonly mode?: string;
      readonly recordingMode?: string;
      readonly audience?: string;
      readonly [key: string]: unknown;
    };

/**
 * The named keys are the material-term vocabulary. The index signature permits
 * a caller to carry opaque source data; the comparator classifies changed
 * opaque keys as UNKNOWN rather than treating them as safe.
 */
export interface MaterialTerms {
  readonly time?: MaterialTimeTerm | string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly duration?: MaterialDurationTerm;
  readonly durationMinutes?: number;
  readonly role?: MaterialRoleTerm;
  readonly roleKey?: string;
  readonly venue?: MaterialVenueTerm;
  readonly venueId?: string;
  readonly roomId?: string;
  readonly locationId?: string;
  readonly room?: string;
  readonly recording?: MaterialRecordingTerm;
  readonly recordingEnabled?: boolean;
  readonly recordingRequired?: boolean;
  readonly recordingMode?: string;
  readonly [key: string]: unknown;
}

export interface MaterialTermPolicy {
  readonly time?: Materiality;
  readonly duration?: Materiality;
  readonly role?: Materiality;
  readonly venue?: Materiality | {
    readonly default?: Materiality;
    readonly roomOnly?: Materiality;
    readonly crossVenue?: Materiality;
    readonly other?: Materiality;
    readonly differentVenue?: Materiality;
  };
  readonly recording?: Materiality;
  readonly unknown?: Materiality;
  readonly roomOnlyVenue?: Materiality;
  readonly venueRoomOnly?: Materiality;
  readonly roomOnly?: Materiality;
  readonly roomChange?: Materiality;
}

export interface ChangeRadiusPolicy {
  readonly materialTerms?: MaterialTermPolicy;
  readonly termPolicy?: MaterialTermPolicy;
  readonly familyMateriality?: Partial<Record<ChangeRadiusFamily, Materiality>>;
  readonly requiredFamilies?: readonly string[];
  readonly unavailableFamilies?: readonly string[];
  readonly operatorBaselineAvailable?: boolean;
  readonly operatorReleaseBaselineAvailable?: boolean;
}

export interface MaterialTermChange {
  readonly kind: MaterialTermKind;
  readonly changed: true;
  readonly before: unknown;
  readonly after: unknown;
  readonly materiality: Materiality;
  readonly reasonCode: string;
  readonly reasonFingerprint: string;
}

export interface MaterialTermComparison {
  readonly equal: boolean;
  readonly changed: boolean;
  readonly materiality: Materiality;
  readonly changes: readonly MaterialTermChange[];
  readonly changedTerms: readonly MaterialTermChange[];
  readonly fingerprint: string;
}

export interface ChangeRadiusRecordReference {
  readonly family: string;
  readonly recordId: string;
  /** Original family identity when the output family is UNKNOWN. */
  readonly sourceFamily?: string;
  readonly scope?: ChangeRadiusScope;
  readonly relation?: string;
  readonly recordType?: string;
}

export interface ChangeRadiusSourceRecord {
  readonly family: string;
  readonly recordId: string;
  readonly recordType?: string;
  readonly kind?: string;
  readonly scope?: ChangeRadiusScope;
  readonly revision?: number;
  readonly version?: number;
  readonly fingerprint?: string;
  readonly sourceFingerprint?: string;
  readonly terms?: MaterialTerms;
  readonly materialTerms?: MaterialTerms;
  readonly payload?: unknown;
  readonly data?: unknown;
  readonly value?: unknown;
  readonly dependents?: readonly ChangeRadiusRecordReference[];
  readonly outgoing?: readonly ChangeRadiusRecordReference[];
  readonly dependencies?: readonly ChangeRadiusRecordReference[];
  readonly relatedRecords?: readonly ChangeRadiusRecordReference[];
  readonly downstream?: readonly ChangeRadiusRecordReference[];
  readonly references?: readonly ChangeRadiusRecordReference[];
  readonly baselineAvailable?: boolean;
  readonly stale?: boolean;
  readonly [key: string]: unknown;
}

export interface ExactBeforeSourceVector {
  readonly vectorId: string;
  readonly sourceVectorId?: string;
  readonly id?: string;
  readonly scope: ChangeRadiusScope;
  readonly workspaceId?: string;
  readonly eventId?: string;
  readonly revision: number;
  readonly sourceRevision?: number;
  readonly asOfRevision?: number;
  readonly records: readonly ChangeRadiusSourceRecord[];
  readonly sourceRecords?: readonly ChangeRadiusSourceRecord[];
  /** Optional external identity. The preflight always emits its own canonical fingerprint. */
  readonly fingerprint?: string;
  readonly sourceFingerprint?: string;
  readonly currentFingerprint?: string;
  readonly stale?: boolean;
  readonly isStale?: boolean;
  readonly currentRevision?: number;
  readonly status?: string;
}

export interface SourceVectorExpectation {
  readonly vectorId?: string;
  readonly revision?: number;
  readonly fingerprint?: string;
  readonly sourceFingerprint?: string;
}

export interface ChangeRadiusImpactAssertion {
  readonly family?: string;
  readonly recordType?: string;
  readonly recordId?: string;
  readonly id?: string;
  readonly affected: boolean;
  readonly materiality?: Materiality;
  readonly reasonCode?: string;
  readonly scope?: ChangeRadiusScope;
}

export interface ProposedChange {
  readonly changeId?: string;
  readonly family?: string;
  readonly recordType?: string;
  readonly recordId?: string;
  readonly id?: string;
  readonly kind?: string;
  readonly scope?: ChangeRadiusScope;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly beforeTerms?: MaterialTerms;
  readonly beforeMaterialTerms?: MaterialTerms;
  readonly afterTerms?: MaterialTerms;
  readonly afterMaterialTerms?: MaterialTerms;
  readonly beforeFingerprint?: string;
  readonly afterFingerprint?: string;
  readonly sourceFingerprint?: string;
  readonly expectedRevision?: number;
  readonly affected?: boolean;
  readonly reason?: string;
  readonly impactAssertions?: readonly ChangeRadiusImpactAssertion[];
  readonly [key: string]: unknown;
}

export interface ProposedImpactEdge {
  readonly from: ChangeRadiusRecordReference;
  readonly to: ChangeRadiusRecordReference;
  readonly relation?: string;
  readonly affected?: boolean;
  readonly materiality?: Materiality;
  readonly reasonCode?: string;
}

/**
 * A transport-neutral proposal envelope. The `authority`, `apply`, and `send`
 * keys are intentionally not part of this interface; runtime validation also
 * rejects them when an untyped caller attempts to inject them.
 */
export interface ProposedChangeCommandEnvelope {
  readonly schemaVersion?: number;
  readonly commandType?: string;
  readonly type?: string;
  readonly kind?: string;
  readonly commandId: string;
  readonly scope?: ChangeRadiusScope;
  readonly workspaceId?: string;
  readonly eventId?: string;
  readonly beforeSourceVector?: ExactBeforeSourceVector;
  readonly sourceVector?: ExactBeforeSourceVector;
  readonly before?: ExactBeforeSourceVector;
  readonly proposedChanges?: readonly ProposedChange[];
  readonly changes?: readonly ProposedChange[];
  readonly proposed?: readonly ProposedChange[];
  readonly expectedSourceVector?: SourceVectorExpectation;
  readonly expectedBefore?: SourceVectorExpectation;
  readonly expectedSourceVectorId?: string;
  readonly expectedSourceVectorRevision?: number;
  readonly expectedSourceVectorFingerprint?: string;
  readonly expectedSourceRevision?: number;
  readonly expectedSourceFingerprint?: string;
  readonly currentSourceVectorRevision?: number;
  readonly currentSourceVectorFingerprint?: string;
  readonly sourceVectors?: readonly ExactBeforeSourceVector[];
  readonly impactEdges?: readonly ProposedImpactEdge[];
  readonly edges?: readonly ProposedImpactEdge[];
  readonly impactAssertions?: readonly ChangeRadiusImpactAssertion[];
  readonly requiredFamilies?: readonly string[];
  readonly unavailableFamilies?: readonly string[];
  readonly operatorBaselineAvailable?: boolean;
  readonly operatorReleaseBaselineAvailable?: boolean;
  readonly policy?: ChangeRadiusPolicy;
  readonly [key: string]: unknown;
}

export interface ImpactReason {
  readonly code: string;
  readonly summary: string;
  readonly fingerprint: string;
}

export interface AffectedRecordBase<F extends string> {
  readonly family: F;
  readonly recordType: F;
  readonly recordId: string;
  readonly scope: ChangeRadiusScope;
  readonly affected: true;
  readonly materiality: Materiality;
  readonly sourceFingerprint: string;
  readonly sourceFingerprints: readonly string[];
  readonly reason: string;
  readonly reasonCode: string;
  readonly reasonFingerprint: string;
  readonly reasonDetail: ImpactReason;
  readonly changedTerms: readonly MaterialTermChange[];
  readonly beforeFingerprint?: string;
  readonly afterFingerprint?: string;
  readonly depth: number;
  readonly upstreamRecordIds: readonly string[];
  readonly impactFingerprint: string;
  readonly sourceFamily?: string;
}

export type ScheduleAffectedRecord = AffectedRecordBase<"SCHEDULE"> & { readonly kind?: string };
export type PeopleAffectedRecord = AffectedRecordBase<"PEOPLE"> & { readonly kind?: string };
export type CommitmentAffectedRecord = AffectedRecordBase<"COMMITMENT"> & { readonly kind?: string };
export type ArtifactAffectedRecord = AffectedRecordBase<"ARTIFACT"> & { readonly kind?: string };
export type PublicReleaseAffectedRecord = AffectedRecordBase<"PUBLIC_RELEASE"> & { readonly kind?: string };
export type OperatorReleaseAffectedRecord = AffectedRecordBase<"OPERATOR_RELEASE"> & { readonly kind?: string };

export interface UnknownAffectedRecord extends AffectedRecordBase<"UNKNOWN"> {
  readonly sourceFamily: string;
  readonly kind?: string;
}

export type AffectedRecord =
  | ScheduleAffectedRecord
  | PeopleAffectedRecord
  | CommitmentAffectedRecord
  | ArtifactAffectedRecord
  | PublicReleaseAffectedRecord
  | OperatorReleaseAffectedRecord
  | UnknownAffectedRecord;

export interface ImpactEdge {
  readonly from: ChangeRadiusRecordReference;
  readonly to: ChangeRadiusRecordReference;
  readonly relation: string;
  readonly depth: number;
  readonly reasonFingerprint: string;
}

export interface ImpactGraph {
  readonly roots: readonly ChangeRadiusRecordReference[];
  readonly nodes: readonly AffectedRecord[];
  readonly edges: readonly ImpactEdge[];
  readonly unaffected: readonly ChangeRadiusRecordReference[];
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly maxDepth: number;
  readonly fingerprint: string;
}

export interface ChangeRadiusPreflightResult {
  readonly kind: "CHANGE_RADIUS_PREFLIGHT";
  readonly schemaVersion: typeof CHANGE_RADIUS_SCHEMA_VERSION;
  readonly commandId: string;
  readonly scope: ChangeRadiusScope;
  readonly authoritative: false;
  readonly isAuthoritative: false;
  readonly nonAuthoritative: true;
  readonly canApply: false;
  readonly canSend: false;
  readonly canMutate: false;
  readonly mutatesState: false;
  readonly applied: false;
  readonly sent: false;
  readonly status: "PREVIEW_ONLY";
  readonly materiality: Materiality;
  readonly requiresReview: boolean;
  readonly requiresReconfirmation: boolean;
  readonly blocking: boolean;
  readonly sourceVectorFingerprint: string;
  readonly reasonFingerprints: readonly string[];
  readonly sourceFingerprints: readonly string[];
  readonly graph: ImpactGraph;
  readonly affectedRecords: readonly AffectedRecord[];
  readonly fingerprint: string;
}

export const CHANGE_RADIUS_LIMITS = Object.freeze({
  maxSourceRecords: 512,
  maxProposedChanges: 256,
  maxImpactAssertions: 512,
  maxGraphNodes: 1_024,
  maxGraphEdges: 2_048,
  maxGraphDepth: 32,
  maxInputDepth: 48,
  maxInputNodes: 20_000,
  maxStringBytes: 16_384,
  maxCanonicalBytes: 4_000_000,
});

export type ChangeRadiusErrorCode =
  | "INVALID_COMMAND"
  | "INVALID_SCOPE"
  | "SCOPE_MISMATCH"
  | "STALE_SOURCE_VECTOR"
  | "DUPLICATE_SOURCE_VECTOR"
  | "DUPLICATE_SOURCE_RECORD"
  | "SOURCE_VECTOR_FINGERPRINT_MISMATCH"
  | "SOURCE_RECORD_FINGERPRINT_MISMATCH"
  | "SOURCE_RECORD_MISSING"
  | "DUPLICATE_CHANGE"
  | "CONTRADICTORY_IMPACTS"
  | "CONTRADICTORY_BEFORE"
  | "IMPACT_CYCLE"
  | "UNBOUNDED_GRAPH"
  | "CALLER_INJECTED_AUTHORITY"
  | "INVALID_MATERIAL_TERM"
  | "UNSAFE_UNKNOWN_POLICY"
  | "INVALID_REFERENCE";

export class ChangeRadiusError extends Error {
  readonly code: ChangeRadiusErrorCode;
  readonly path?: string;

  constructor(code: ChangeRadiusErrorCode, message: string, path?: string) {
    super(`${code}${path ? ` at ${path}` : ""}: ${message}`);
    this.name = "ChangeRadiusError";
    this.code = code;
    this.path = path;
  }
}

export type ChangeRadiusMateriality = Materiality;
export type ChangeRadiusSourceVector = ExactBeforeSourceVector;
export type BeforeSourceVector = ExactBeforeSourceVector;
export type ProposedChangeEnvelope = ProposedChangeCommandEnvelope;
export type AffectedChangeRecord = AffectedRecord;
