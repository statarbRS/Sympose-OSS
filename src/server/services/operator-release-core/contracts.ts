export const OPERATOR_RELEASE_CORE_SCHEMA = "operator-release-core/v1" as const;
export const SOURCE_VECTOR_SCHEMA = "operator-release-source-vector/v1" as const;
export const RELEASE_MANIFEST_SCHEMA = "operator-release-manifest/v1" as const;
export const RELEASE_TWIN_SCHEMA = "operator-release-twin/v1" as const;
export const ATOMIC_TWIN_PREFLIGHT_SCHEMA = "operator-release-twin-preflight/v1" as const;
export const TRUSTED_LOADER_AUTHORITY = "trusted-loader/v1" as const;

export const MAX_SOURCE_RECORDS = 64 as const;
export const MAX_FIELDS_PER_SOURCE = 64 as const;
export const MAX_FIELDS_PER_VECTOR = 512 as const;
export const MAX_DECISIONS_PER_MANIFEST = 512 as const;
export const MAX_SUPERSESSION_HISTORY = 128 as const;
export const MAX_ID_LENGTH = 128 as const;
export const MAX_FIELD_LENGTH = 160 as const;
export const MAX_REASON_LENGTH = 256 as const;
export const MAX_FIELD_VALUE_BYTES = 32 * 1024;
export const MAX_VECTOR_BYTES = 256 * 1024;
export const MAX_RELEASE_MANIFEST_BYTES = 256 * 1024;
export const MAX_RELEASE_TWIN_BYTES = 512 * 1024;
export const MAX_PREFLIGHT_INPUT_BYTES = 4 * 1024 * 1024;

/** Only these operator facts may be included in an OPERATOR projection. */
export const OPERATOR_FIELD_ALLOWLIST = Object.freeze([
  "operator.cue",
  "operatorCue",
  "operations.cue",
  "internalCue",
] as const);

export type ReleaseAudience = "PUBLIC" | "OPERATOR";
export type SourceScope = "COMMON" | "PUBLIC" | "OPERATOR";
export type SourceAvailability = "AVAILABLE" | "UNAVAILABLE";
export type FieldDecisionKind = "INCLUDE" | "REDACT" | "OMIT";
export type AssessmentStatus = "EXACT_MATCH" | "STALE" | "UNAVAILABLE";
export type DriftEffect = "COMMON" | "PUBLIC_ONLY" | "OPERATOR_ONLY";
export type DriftMateriality = "NONE" | "MATERIAL";

export type DriftFamily =
  | "TIME"
  | "CONTENT"
  | "LOCATION"
  | "COMMITMENT"
  | "POLICY"
  | "IDENTITY"
  | "OPERATOR_CUE"
  | "CONTACT"
  | "PRIVATE_ARTIFACT"
  | "UNKNOWN";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface ReleaseScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

export interface SourceFieldInput {
  readonly field: string;
  readonly family: DriftFamily;
  readonly value: JsonValue;
}

export interface SourceRecordInput {
  readonly sourceId: string;
  readonly scope: SourceScope;
  readonly family: DriftFamily;
  readonly version: number;
  readonly status: SourceAvailability;
  readonly fields: readonly SourceFieldInput[];
  readonly unavailableReason?: string;
  /** Optional caller-supplied integrity value. The loader recomputes and verifies it. */
  readonly fingerprint?: string;
}

export interface SourceVectorDraft {
  readonly schema?: typeof SOURCE_VECTOR_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly audience: ReleaseAudience;
  readonly version: number;
  readonly sources: readonly SourceRecordInput[];
  /** Optional caller-supplied integrity value. The loader recomputes and verifies it. */
  readonly fingerprint?: string;
  /** Optional caller-supplied common-source integrity value. */
  readonly commonFingerprint?: string;
}

export interface ReleaseSourceRecord extends Omit<SourceRecordInput, "fingerprint" | "fields"> {
  readonly fields: readonly SourceFieldInput[];
  readonly fingerprint: string;
}

export interface ReleaseSourceVector {
  readonly schema: typeof SOURCE_VECTOR_SCHEMA;
  readonly authority: typeof TRUSTED_LOADER_AUTHORITY;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly audience: ReleaseAudience;
  readonly version: number;
  readonly availability: SourceAvailability;
  readonly sources: readonly ReleaseSourceRecord[];
  readonly commonFingerprint: string;
  readonly audienceFingerprint: string;
  readonly fingerprint: string;
}

export interface SourceVectorExpectation extends ReleaseScope {
  readonly audience: ReleaseAudience;
  readonly version: number;
  readonly fingerprint: string;
  readonly commonFingerprint?: string;
}

export interface FieldDecisionInput {
  readonly sourceId: string;
  readonly field: string;
  readonly decision: FieldDecisionKind;
  readonly reason: string;
}

export interface FieldDecision extends FieldDecisionInput {
  readonly family: DriftFamily;
}

export interface IncludedField {
  readonly field: string;
  readonly value: JsonValue;
  readonly sourceId: string;
  readonly family: DriftFamily;
}

export interface RedactedField {
  readonly field: string;
  readonly sourceId: string;
  readonly family: DriftFamily;
  readonly decision: "REDACT" | "OMIT";
  readonly reason: string;
}

export interface SupersessionLink {
  readonly releaseId: string;
  readonly fingerprint: string;
}

/** Pure graph input used to validate lineage cycles before manifests are materialized. */
export interface SupersessionNode {
  readonly audience: ReleaseAudience;
  readonly releaseId: string;
  readonly supersedesReleaseId: string | null;
}

export interface ReleaseManifestInput extends ReleaseScope {
  readonly audience: ReleaseAudience;
  readonly releaseId: string;
  readonly sourceVector: ReleaseSourceVector;
  readonly decisions: readonly FieldDecisionInput[];
  readonly supersedes?: SupersessionLink | null;
  readonly expected?: SourceVectorExpectation;
}

export interface ReleaseManifest {
  readonly schema: typeof RELEASE_MANIFEST_SCHEMA;
  readonly authority: typeof TRUSTED_LOADER_AUTHORITY;
  readonly releaseId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly audience: ReleaseAudience;
  readonly version: number;
  readonly sourceVectorFingerprint: string;
  readonly commonFingerprint: string;
  readonly decisions: readonly FieldDecision[];
  readonly includedFields: readonly IncludedField[];
  readonly redactedFields: readonly RedactedField[];
  readonly supersedes: SupersessionLink | null;
  readonly fingerprint: string;
}

export interface ReleaseManifestExpectation extends ReleaseScope {
  readonly audience: ReleaseAudience;
  readonly version: number;
  readonly releaseId: string;
  readonly fingerprint: string;
  readonly sourceVectorFingerprint?: string;
  readonly commonFingerprint?: string;
}

export interface SourceAssessment {
  readonly status: AssessmentStatus;
  readonly audience: ReleaseAudience;
  readonly expectedVersion: number | null;
  readonly actualVersion: number | null;
  readonly expectedFingerprint: string | null;
  readonly actualFingerprint: string | null;
  readonly drift: DriftReport | null;
  readonly blockers: readonly AssessmentBlocker[];
}

export type AssessmentBlockerCode =
  | "SOURCE_UNAVAILABLE"
  | "BASELINE_UNAVAILABLE"
  | "SOURCE_MISSING"
  | "SOURCE_STALE"
  | "SCOPE_MISMATCH"
  | "AUDIENCE_MISMATCH"
  | "VERSION_MISMATCH"
  | "FINGERPRINT_MISMATCH";

export interface AssessmentBlocker {
  readonly code: AssessmentBlockerCode;
  readonly audience: ReleaseAudience;
  readonly message: string;
}

export interface DriftEntry {
  readonly sourceId: string;
  readonly family: DriftFamily;
  readonly effect: DriftEffect;
  readonly materiality: "MATERIAL";
  readonly previousFingerprint: string | null;
  readonly currentFingerprint: string | null;
}

export interface DriftReport {
  readonly schema: "operator-release-drift/v1";
  readonly audience: ReleaseAudience;
  readonly changed: boolean;
  readonly commonChanged: boolean;
  readonly audienceOnlyChanged: boolean;
  readonly materiality: DriftMateriality;
  readonly effects: readonly DriftEffect[];
  readonly families: readonly DriftFamily[];
  readonly entries: readonly DriftEntry[];
  /** Deliberately no safety verdict: drift is evidence, not authorization. */
}

export interface ProjectionPreflightInput {
  readonly current: ReleaseSourceVector | null;
  readonly baseline: ReleaseSourceVector | null;
  readonly manifest: ReleaseManifest | null;
}

export interface AtomicTwinPreflightInput extends ReleaseScope {
  readonly version: number;
  readonly public: ProjectionPreflightInput;
  readonly operator: ProjectionPreflightInput;
  readonly supersessionHistory?: readonly ReleaseManifest[];
}

export type TwinBlockerCode =
  | "PUBLIC_UNAVAILABLE"
  | "OPERATOR_UNAVAILABLE"
  | "PUBLIC_STALE"
  | "OPERATOR_STALE"
  | "PUBLIC_INCOMPLETE"
  | "OPERATOR_INCOMPLETE"
  | "COMMON_VECTOR_MISMATCH"
  | "SUPERSESSION_INVALID";

export interface TwinBlocker {
  readonly code: TwinBlockerCode;
  readonly audience: ReleaseAudience | "BOTH";
  readonly message: string;
}

export interface AtomicTwinPreflightResult {
  readonly schema: typeof ATOMIC_TWIN_PREFLIGHT_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly version: number;
  readonly ready: boolean;
  readonly public: SourceAssessment;
  readonly operator: SourceAssessment;
  readonly commonFingerprint: string | null;
  readonly blockers: readonly TwinBlocker[];
}

export interface ReleaseTwinInput extends ReleaseScope {
  readonly version: number;
  readonly sources: readonly SourceRecordInput[];
  readonly publicReleaseId: string;
  readonly operatorReleaseId: string;
  readonly publicDecisions: readonly FieldDecisionInput[];
  readonly operatorDecisions: readonly FieldDecisionInput[];
  readonly publicSupersedes?: SupersessionLink | null;
  readonly operatorSupersedes?: SupersessionLink | null;
}

export interface ReleaseTwin {
  readonly schema: typeof RELEASE_TWIN_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly version: number;
  readonly commonFingerprint: string;
  readonly public: {
    readonly sourceVector: ReleaseSourceVector;
    readonly manifest: ReleaseManifest;
  };
  readonly operator: {
    readonly sourceVector: ReleaseSourceVector;
    readonly manifest: ReleaseManifest;
  };
}
