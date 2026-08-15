import type { JsonSafeValue } from "../cfp/form-safety";
import type {
  FormFieldDefinition,
  NormalizedFormDocument,
} from "../cfp/form-types";

export const CFP_REVIEW_FINGERPRINT_ALGORITHM = "sha256-canonical-json-v1" as const;
export const CFP_REVIEW_FIELD_DEFINITION_BINDING_SCHEMA =
  "cfp-review-field-definition-binding/v1" as const;
export const CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA =
  "cfp-review-source-answer-binding/v1" as const;
export const CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA =
  "cfp-review-redacted-value-binding/v1" as const;
export const CFP_REVIEW_BLIND_ARTIFACT_SCHEMA = "cfp-review-blind-artifact/v1" as const;
export const CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA =
  "cfp-review-rubric-semantics/v1" as const;
export const CFP_SUBMISSION_REVISION_SCHEMA = "cfp-submission-revision/v1" as const;
export const CFP_FORM_DOCUMENT_SCHEMA = "cfp-form-document/v1" as const;

export const BLIND_REVIEW_DISCLOSURE_STAGE = "BLIND_REVIEW" as const;
export const BLIND_REVIEW_ATTESTATION =
  "ORGANIZER_VERIFIED_BLIND_SAFE_REDACTION" as const;
export const REVIEW_ISSUER_AUTHORITY = "phase0.pipeline.manage" as const;

export const BLIND_ANSWER_TYPES = Object.freeze([
  "shortText",
  "longText",
  "richText",
  "singleChoice",
  "multipleChoice",
  "checkbox",
  "ranking",
  "matrix",
  "integer",
  "decimal",
  "date",
  "time",
  "dateTime",
] as const);

export type BlindAnswerType = (typeof BLIND_ANSWER_TYPES)[number];

/**
 * These source types cannot be represented by an included V1 blind answer. The
 * rule is structural: no value inspection, regular expression, name detector,
 * or equality test can promote one of these fields onto the reviewer surface.
 */
export const BLIND_REVIEW_EXCLUSION_ONLY_FIELD_TYPES = Object.freeze([
  "email",
  "phone",
  "url",
  "address",
  "location",
  "fileUpload",
  "fileLink",
  "consent",
  "acknowledgement",
  "policyAcceptance",
  "personReference",
  "proposalOwnerReference",
  "coSpeakerReference",
  "section",
  "repeatableGroup",
  "calculated",
] as const);

export type BlindReviewExclusionOnlyFieldType =
  (typeof BLIND_REVIEW_EXCLUSION_ONLY_FIELD_TYPES)[number];

export const BLIND_REVIEW_ARTIFACT_LIMITS = Object.freeze({
  maxItems: 16_384,
  maxNodes: 262_144,
  maxDepth: 32,
  maxSerializedBytes: 4 * 1024 * 1024,
  maxIdentifierLength: 128,
  maxLabelBytes: 2 * 1024,
});

export type BlindArtifactDisposition = "INCLUDE_REDACTED" | "EXCLUDE";
export type BlindArtifactConflictStatus = "NONE" | "CLEARED" | "WAIVED";

export interface ReviewFieldDefinitionBindingV1 {
  readonly schema: typeof CFP_REVIEW_FIELD_DEFINITION_BINDING_SCHEMA;
  readonly workspaceId: string;
  readonly assignmentId: string;
  readonly submissionRevisionId: string;
  readonly formDocumentSchema: typeof CFP_FORM_DOCUMENT_SCHEMA;
  readonly formVersionId: string;
  readonly ruleVersionId: string;
  readonly formDocumentFingerprint: string;
  readonly field: FormFieldDefinition;
}

export interface ReviewSourceAnswerBindingV1 {
  readonly schema: typeof CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA;
  readonly workspaceId: string;
  readonly assignmentId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly submissionRevisionFingerprint: string;
  readonly fieldId: string;
  readonly fieldDefinitionFingerprint: string;
  readonly value: JsonSafeValue;
}

interface ReviewRedactedValueBindingBaseV1 {
  readonly schema: typeof CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA;
  readonly workspaceId: string;
  readonly assignmentId: string;
  readonly submissionRevisionId: string;
  readonly sourceAnswerFingerprint: string;
  readonly disclosureStage: typeof BLIND_REVIEW_DISCLOSURE_STAGE;
}

export interface IncludedReviewRedactedValueBindingV1
  extends ReviewRedactedValueBindingBaseV1 {
  readonly disposition: "INCLUDE_REDACTED";
  readonly answerKey: string;
  readonly displayOrder: number;
  readonly label: string;
  readonly type: BlindAnswerType;
  readonly value: JsonSafeValue;
}

export interface ExcludedReviewRedactedValueBindingV1
  extends ReviewRedactedValueBindingBaseV1 {
  readonly disposition: "EXCLUDE";
  readonly answerKey: null;
  readonly displayOrder: null;
  readonly label: null;
  readonly type: null;
  readonly value: null;
}

export type ReviewRedactedValueBindingV1 =
  | IncludedReviewRedactedValueBindingV1
  | ExcludedReviewRedactedValueBindingV1;

interface BlindArtifactItemBindingV1 {
  readonly sourceFieldId: string;
  readonly fieldDefinitionFingerprint: string;
  readonly sourceAnswerFingerprint: string;
  readonly redactedValueFingerprint: string;
}

export interface IncludedBlindArtifactItemV1 extends BlindArtifactItemBindingV1 {
  readonly disposition: "INCLUDE_REDACTED";
  readonly answerKey: string;
  readonly displayOrder: number;
  readonly label: string;
  readonly type: BlindAnswerType;
  readonly value: JsonSafeValue;
}

export interface ExcludedBlindArtifactItemV1 extends BlindArtifactItemBindingV1 {
  readonly disposition: "EXCLUDE";
  readonly answerKey: null;
  readonly displayOrder: null;
  readonly label: null;
  readonly type: null;
  readonly value: null;
}

export type BlindArtifactItemV1 =
  | IncludedBlindArtifactItemV1
  | ExcludedBlindArtifactItemV1;

export interface BlindReviewArtifactV1 {
  readonly schema: typeof CFP_REVIEW_BLIND_ARTIFACT_SCHEMA;
  readonly version: 1;
  readonly workspaceId: string;
  readonly assignmentId: string;
  readonly assignmentCreatedAt: string;
  readonly rubricVersionId: string;
  readonly rubricSemanticsId: string;
  readonly rubricSemanticsFingerprint: string;
  readonly submissionId: string;
  readonly submissionRevision: {
    readonly id: string;
    readonly number: number;
    readonly schema: typeof CFP_SUBMISSION_REVISION_SCHEMA;
    readonly fingerprint: string;
    readonly createdAt: string;
    readonly formDocumentSchema: typeof CFP_FORM_DOCUMENT_SCHEMA;
    readonly formVersionId: string;
    readonly ruleVersionId: string;
    readonly formDocumentFingerprint: string;
  };
  readonly disclosureStage: typeof BLIND_REVIEW_DISCLOSURE_STAGE;
  readonly conflictAtIssuance: {
    readonly status: BlindArtifactConflictStatus;
    readonly sequenceNumber: number;
  };
  readonly attestation: typeof BLIND_REVIEW_ATTESTATION;
  readonly issuer: {
    readonly accountId: string;
    readonly role: string;
    readonly authority: typeof REVIEW_ISSUER_AUTHORITY;
  };
  readonly issuedAt: string;
  readonly sourceAnswerCount: number;
  readonly items: readonly BlindArtifactItemV1[];
}

export type BlindFieldDecisionInput =
  | {
      readonly sourceFieldId: string;
      readonly action: "EXCLUDE";
    }
  | {
      readonly sourceFieldId: string;
      readonly action: "INCLUDE_REDACTED";
      readonly reviewLabel: string;
      readonly redactedValue: unknown;
    };

export interface BlindReviewArtifactSourceRevision {
  readonly id: string;
  readonly number: number;
  readonly schema: typeof CFP_SUBMISSION_REVISION_SCHEMA;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly formDocument: NormalizedFormDocument;
}

export interface CreateBlindReviewArtifactInput {
  readonly workspaceId: string;
  readonly assignmentId: string;
  readonly assignmentCreatedAt: string;
  readonly rubricVersionId: string;
  readonly rubricSemanticsId: string;
  readonly rubricSemanticsFingerprint: string;
  readonly submissionId: string;
  readonly submissionRevision: BlindReviewArtifactSourceRevision;
  readonly disclosureStage: typeof BLIND_REVIEW_DISCLOSURE_STAGE;
  readonly conflictAtIssuance: {
    readonly status: BlindArtifactConflictStatus;
    readonly sequenceNumber: number;
  };
  readonly attestation: typeof BLIND_REVIEW_ATTESTATION;
  readonly issuer: {
    readonly accountId: string;
    readonly role: string;
    readonly authority: typeof REVIEW_ISSUER_AUTHORITY;
  };
  readonly issuedAt: string;
  readonly decisions: readonly BlindFieldDecisionInput[];
}

/**
 * Outward value shape reserved for a future persistence-backed reviewer
 * service. It carries no provenance, authorization, or internal evidence.
 */
export interface BlindAnswerProjection {
  readonly answerKey: string;
  readonly label: string;
  readonly type: BlindAnswerType;
  readonly value: JsonSafeValue;
}

/**
 * Outward value shape reserved for a future persistence-backed reviewer
 * service. It exposes no source identifier or internal evidence.
 */
export interface BlindProposalProjection {
  readonly revisionNumber: number;
  readonly disclosureStage: typeof BLIND_REVIEW_DISCLOSURE_STAGE;
  readonly answers: readonly BlindAnswerProjection[];
}
