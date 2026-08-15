/**
 * Value-only contracts for surgical reconfirmation.
 *
 * This package is deliberately independent of the application, persistence,
 * transport, and communications planes. It can describe a required next
 * decision, but it cannot perform that decision.
 */

export const SURGICAL_RECONFIRMATION_SCHEMA = "sympose-surgical-reconfirmation/v1" as const;
export const SURGICAL_RECONFIRMATION_COMMAND = "DERIVE_SURGICAL_RECONFIRMATION" as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Families whose records may be an exact source of a bounded impact. */
export const RECONFIRMATION_FAMILIES = Object.freeze([
  "APPROVAL",
  "AUDIENCE_POLICY",
  "ARTIFACT",
  "COHORT_SNAPSHOT",
  "COMMITMENT",
  "COMMITMENT_OFFER",
  "CONFIRMATION",
  "DECISION",
  "OFFER",
  "OPERATIONAL_OBSERVATION",
  "OPERATOR_RELEASE",
  "PLAN",
  "PLAN_ASSIGNMENT",
  "PLAN_APPROVAL",
  "PLAN_INPUT",
  "PLAN_VERSION",
  "PEOPLE",
  "PUBLIC_RELEASE",
  "PUBLICATION_RELEASE",
  "SCHEDULE",
  "SOURCE_REVISION",
] as const);

export type ReconfirmationFamily = (typeof RECONFIRMATION_FAMILIES)[number];

export const STAKEHOLDER_KINDS = Object.freeze(["APPROVAL", "COMMITMENT"] as const);
export type StakeholderKind = (typeof STAKEHOLDER_KINDS)[number];

export const RECONFIRMATION_STATUSES = Object.freeze([
  "REQUIRED",
  "UNAFFECTED",
  "BLOCKED",
  "UNAVAILABLE",
] as const);
export type ReconfirmationStatus = (typeof RECONFIRMATION_STATUSES)[number];

export const EVIDENCE_STATUSES = Object.freeze(["CURRENT", "STALE", "BLOCKED", "UNAVAILABLE"] as const);
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const MATERIAL_TERM_KINDS = Object.freeze([
  "DATE",
  "TIME",
  "DURATION",
  "ROLE",
  "LOCATION",
  "COUNTERPARTY",
  "DELIVERABLE",
  "CAPACITY",
  "RECORDING",
  "OTHER",
] as const);
export type MaterialTermKind = (typeof MATERIAL_TERM_KINDS)[number];

export const MATERIALITY_POLICIES = Object.freeze(["MATERIAL", "NON_MATERIAL"] as const);
export type MaterialityPolicy = (typeof MATERIALITY_POLICIES)[number];

export const GRAPH_RELATIONS = Object.freeze(["DERIVED_FROM", "INVALIDATES", "REFERENCES"] as const);
export type GraphRelation = (typeof GRAPH_RELATIONS)[number];

export interface ReconfirmationScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

export interface ReconfirmationRecordReference {
  readonly family: string;
  readonly id: string;
  readonly scope: ReconfirmationScope;
}

export interface ExactRevisionInput {
  readonly family: string;
  readonly id: string;
  readonly scope: ReconfirmationScope;
  readonly revision: number;
  /** Exact immutable source or artifact content at this revision. */
  readonly content: JsonValue;
  /** Optional caller claim; the core always recomputes and verifies it. */
  readonly fingerprint?: string;
  /** Compatibility alias for a source revision claim. */
  readonly sourceRevision?: number;
  /** Compatibility alias for a source fingerprint claim. */
  readonly sourceFingerprint?: string;
}

export interface StakeholderRevisionInput {
  readonly id: string;
  readonly scope: ReconfirmationScope;
  readonly revision: number;
  readonly terms: JsonValue;
  /** Optional caller claim; the core always recomputes and verifies it. */
  readonly fingerprint?: string;
}

export interface StakeholderActor {
  readonly id: string;
  readonly role: string;
}

export interface EvidenceSubject {
  readonly id: string;
  readonly role: string;
}

export interface EvidenceRecordReference {
  readonly family: string;
  readonly id: string;
  readonly scope: ReconfirmationScope;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface AuthorityEvidenceInput {
  readonly evidenceId: string;
  readonly version: number;
  readonly scope: ReconfirmationScope;
  readonly status: EvidenceStatus;
  readonly subject: EvidenceSubject;
  readonly record: EvidenceRecordReference;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  /** Optional caller claim; the core always recomputes and verifies it. */
  readonly fingerprint?: string;
}

export interface PurposeEvidenceInput {
  readonly evidenceId: string;
  readonly version: number;
  readonly scope: ReconfirmationScope;
  readonly status: EvidenceStatus;
  readonly subject: EvidenceSubject;
  readonly purpose: string;
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
  /** Optional caller claim; the core always recomputes and verifies it. */
  readonly fingerprint?: string;
}

export interface RetentionEvidenceInput {
  readonly evidenceId: string;
  readonly version: number;
  readonly scope: ReconfirmationScope;
  readonly status: EvidenceStatus;
  readonly subject: EvidenceSubject;
  readonly retentionUntil: string;
  readonly policy: string;
  /** Optional caller claim; the core always recomputes and verifies it. */
  readonly fingerprint?: string;
}

export interface MaterialTermRule {
  /** Dot-separated path into a stakeholder revision's exact terms. */
  readonly path: string;
  readonly kind: MaterialTermKind;
  readonly materiality: MaterialityPolicy;
}

export interface MaterialTermPolicyInput {
  readonly family: string;
  readonly version: number;
  readonly rules: readonly MaterialTermRule[];
}

export interface StakeholderBindingInput {
  /** Stable identity for the target receipt, not a person display label. */
  readonly id: string;
  readonly actor: StakeholderActor;
  readonly kind: StakeholderKind;
  /** The exact changed source this stakeholder binding consumes. */
  readonly source: ReconfirmationRecordReference;
  readonly before: StakeholderRevisionInput;
  readonly after: StakeholderRevisionInput;
  readonly authority?: AuthorityEvidenceInput | null;
  readonly purpose?: PurposeEvidenceInput | null;
  readonly retention?: RetentionEvidenceInput | null;
}

export interface ReconfirmationDependencyEdgeInput {
  readonly from: ReconfirmationRecordReference;
  readonly to: ReconfirmationRecordReference;
  readonly relation: GraphRelation;
}

export interface SurgicalReconfirmationLimits {
  readonly maxInputDepth?: number;
  readonly maxInputNodes?: number;
  readonly maxStringBytes?: number;
  readonly maxCanonicalBytes?: number;
  readonly maxStakeholders?: number;
  readonly maxEvidenceRecords?: number;
  readonly maxMaterialTermsPerReceipt?: number;
  readonly maxGraphNodes?: number;
  readonly maxGraphEdges?: number;
  readonly maxGraphDepth?: number;
  readonly maxReceipts?: number;
}

export interface SurgicalReconfirmationCommand {
  readonly schema?: typeof SURGICAL_RECONFIRMATION_SCHEMA;
  readonly commandType?: typeof SURGICAL_RECONFIRMATION_COMMAND;
  readonly commandId: string;
  readonly idempotencyKey?: string;
  readonly scope: ReconfirmationScope;
  /** Deterministic as-of time used for evidence validity. */
  readonly asOf: string;
  /** Purpose supplied by the authorized application boundary. */
  readonly purpose: string;
  readonly beforeArtifact: ExactRevisionInput;
  readonly afterArtifact: ExactRevisionInput;
  readonly materialPolicy: MaterialTermPolicyInput;
  readonly stakeholders: readonly StakeholderBindingInput[];
  readonly dependencyGraph?: readonly ReconfirmationDependencyEdgeInput[];
  readonly limits?: SurgicalReconfirmationLimits;
}

export interface ExactRevisionSnapshot {
  readonly family: ReconfirmationFamily;
  readonly id: string;
  readonly scope: ReconfirmationScope;
  readonly revision: number;
  readonly content: JsonValue;
  readonly fingerprint: string;
}

export interface StakeholderRevisionSnapshot {
  readonly id: string;
  readonly scope: ReconfirmationScope;
  readonly revision: number;
  readonly terms: JsonValue;
  readonly fingerprint: string;
}

export interface EvidenceSnapshotBase {
  readonly evidenceId: string;
  readonly version: number;
  readonly scope: ReconfirmationScope;
  readonly status: EvidenceStatus;
  readonly fingerprint: string;
}

export interface AuthorityEvidenceSnapshot extends EvidenceSnapshotBase {
  readonly subject: EvidenceSubject;
  readonly record: EvidenceRecordReference;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
}

export interface PurposeEvidenceSnapshot extends EvidenceSnapshotBase {
  readonly subject: EvidenceSubject;
  readonly purpose: string;
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
}

export interface RetentionEvidenceSnapshot extends EvidenceSnapshotBase {
  readonly subject: EvidenceSubject;
  readonly retentionUntil: string;
  readonly policy: string;
}

export interface MaterialTermImpact {
  readonly path: string;
  readonly kind: MaterialTermKind;
  readonly materiality: MaterialityPolicy;
  /** Binds this exact canonical transition to both source and stakeholder revision fingerprints. */
  readonly sourceBindingFingerprint: string;
  readonly beforePresent: boolean;
  readonly afterPresent: boolean;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly reason: "MATERIAL_TERM_CHANGED" | "NON_MATERIAL_TERM_CHANGED";
}

export interface ReconfirmationGraphNode {
  readonly family: string;
  readonly id: string;
  readonly scope: ReconfirmationScope;
  readonly depth: number;
}

export interface ReconfirmationGraphEdge {
  readonly from: ReconfirmationRecordReference;
  readonly to: ReconfirmationRecordReference;
  readonly relation: GraphRelation;
  readonly depth: number;
}

export interface ReconfirmationGraph {
  readonly root: ReconfirmationRecordReference;
  readonly nodes: readonly ReconfirmationGraphNode[];
  readonly edges: readonly ReconfirmationGraphEdge[];
  readonly maxDepth: number;
  readonly fingerprint: string;
}

export interface ReconfirmationReceipt {
  readonly receiptId: string;
  readonly stakeholderId: string;
  readonly targetActorId: string;
  readonly targetRole: string;
  readonly kind: StakeholderKind;
  readonly source: {
    readonly family: ReconfirmationFamily;
    readonly id: string;
    readonly beforeRevision: number;
    readonly afterRevision: number;
    readonly beforeFingerprint: string;
    readonly afterFingerprint: string;
  };
  readonly prior: StakeholderRevisionSnapshot;
  readonly proposed: StakeholderRevisionSnapshot;
  readonly materialTerms: readonly MaterialTermImpact[];
  readonly authority: AuthorityEvidenceSnapshot | null;
  readonly purpose: PurposeEvidenceSnapshot | null;
  readonly retention: RetentionEvidenceSnapshot | null;
  readonly status: ReconfirmationStatus;
  readonly reason: string;
  readonly reasonCode: string;
  readonly fingerprint: string;
}

export type ReconfirmationPlanStatus = ReconfirmationStatus;

export interface SurgicalReconfirmationPlan {
  readonly schema: typeof SURGICAL_RECONFIRMATION_SCHEMA;
  readonly commandType: typeof SURGICAL_RECONFIRMATION_COMMAND;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly scope: ReconfirmationScope;
  readonly asOf: string;
  readonly purpose: string;
  readonly source: {
    readonly family: ReconfirmationFamily;
    readonly id: string;
    readonly beforeRevision: number;
    readonly afterRevision: number;
    readonly beforeFingerprint: string;
    readonly afterFingerprint: string;
    readonly contentChanged: boolean;
  };
  readonly materialPolicy: {
    readonly family: ReconfirmationFamily;
    readonly version: number;
    readonly fingerprint: string;
  };
  readonly graph: ReconfirmationGraph;
  readonly receipts: readonly ReconfirmationReceipt[];
  readonly status: ReconfirmationPlanStatus;
  readonly fingerprint: string;
}

export const DEFAULT_SURGICAL_RECONFIRMATION_LIMITS = Object.freeze({
  maxInputDepth: 48,
  maxInputNodes: 20_000,
  maxStringBytes: 16_384,
  maxCanonicalBytes: 4_000_000,
  maxStakeholders: 512,
  maxEvidenceRecords: 2_048,
  maxMaterialTermsPerReceipt: 256,
  maxGraphNodes: 1_024,
  maxGraphEdges: 2_048,
  maxGraphDepth: 32,
  maxReceipts: 512,
} as const);

export const ABSOLUTE_SURGICAL_RECONFIRMATION_LIMITS = Object.freeze({
  maxInputDepth: 96,
  maxInputNodes: 50_000,
  maxStringBytes: 32_768,
  maxCanonicalBytes: 8_000_000,
  maxStakeholders: 1_024,
  maxEvidenceRecords: 4_096,
  maxMaterialTermsPerReceipt: 512,
  maxGraphNodes: 2_048,
  maxGraphEdges: 8_192,
  maxGraphDepth: 64,
  maxReceipts: 1_024,
} as const);

export type SurgicalReconfirmationErrorCode =
  | "INVALID_COMMAND"
  | "INVALID_SCOPE"
  | "INVALID_REFERENCE"
  | "INVALID_STAKEHOLDER"
  | "INVALID_EVIDENCE"
  | "INVALID_POLICY"
  | "INVALID_LIMIT"
  | "INVALID_DATE"
  | "UNSUPPORTED_VALUE"
  | "HOSTILE_DESCRIPTOR"
  | "PROXY_INPUT"
  | "CYCLE_INPUT"
  | "BOUNDS_EXCEEDED"
  | "UNKNOWN_FAMILY"
  | "UNKNOWN_MATERIAL_POLICY"
  | "CONFLICTING_ALIAS"
  | "CONFLICTING_POLICY"
  | "CONFLICTING_EVIDENCE"
  | "SCOPE_MISMATCH"
  | "SOURCE_BINDING_MISMATCH"
  | "REVISION_NOT_ADVANCED"
  | "FINGERPRINT_MISMATCH"
  | "FORGED_EVIDENCE"
  | "GRAPH_CYCLE"
  | "GRAPH_DEPTH_EXCEEDED";

export class SurgicalReconfirmationError extends Error {
  readonly code: SurgicalReconfirmationErrorCode;
  readonly path?: string;

  constructor(code: SurgicalReconfirmationErrorCode, message: string, path?: string) {
    super(`${code}${path ? ` at ${path}` : ""}: ${message}`);
    this.name = "SurgicalReconfirmationError";
    this.code = code;
    this.path = path;
  }
}

export type SurgicalReconfirmationInput = SurgicalReconfirmationCommand;
export type ReconfirmationResult = SurgicalReconfirmationPlan;
