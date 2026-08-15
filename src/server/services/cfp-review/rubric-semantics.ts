import { Buffer } from "node:buffer";

import { canonicalJson, fingerprintOf } from "../../canonical";
import {
  FormSafetyError,
  sanitizeFormData,
  type JsonSafeObject,
  type JsonSafeValue,
} from "../cfp/form-safety";
import {
  CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
  REVIEW_ISSUER_AUTHORITY,
} from "./artifact-types";

export const CFP_RUBRIC_SCHEMA = "cfp-rubric/v1" as const;
export const CFP_REVIEW_RUBRIC_PROJECTION_SCHEMA = CFP_RUBRIC_SCHEMA;
export const REVIEW_JUDGMENT_AUTHORITY = "independent-review-evidence" as const;
export const REVIEW_RUBRIC_TITLE = "Independent proposal review" as const;
export const REVIEW_SCALE_CODE = "LOW_MEDIUM_HIGH" as const;

export const REVIEW_RUBRIC_SEMANTIC_CODES = Object.freeze([
  "PROPOSAL_QUALITY",
  "AUDIENCE_RELEVANCE",
  "EVIDENCE_STRENGTH",
  "DELIVERY_FEASIBILITY",
  "CLAIMS_SUPPORTED",
  "INDEPENDENT_RECOMMENDATION",
  "REVIEWER_NOTES",
] as const);

export type ReviewRubricSemanticCode = (typeof REVIEW_RUBRIC_SEMANTIC_CODES)[number];

export const REVIEW_RUBRIC_STRUCTURED_KINDS = Object.freeze([
  "numeric",
  "scale",
  "yesNo",
  "recommendation",
  "comment",
] as const);

export type ReviewRubricStructuredKind = (typeof REVIEW_RUBRIC_STRUCTURED_KINDS)[number];

/**
 * Custom organizer scorecards use the same sealed semantics envelope as the
 * fixed V16 rubric. Their presentation fields remain organizer-authored and
 * are carried only in this explicitly allowlisted extension.
 */
export const CUSTOM_REVIEW_RUBRIC_DOCUMENT_SCHEMA =
  "cfp-organizer-review-rubric/v1" as const;
export type CustomReviewRubricFieldKind = "numeric" | "dropdown" | "text";

export interface CustomReviewRubricChoice {
  readonly value: string;
  readonly label: string;
}

export interface CustomReviewRubricField {
  readonly id: string;
  readonly label: string;
  readonly guidance: string;
  readonly kind: CustomReviewRubricFieldKind;
  readonly required: boolean;
  readonly weight: number;
  readonly recommendation?: boolean;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly step: number | null;
  readonly choices: readonly CustomReviewRubricChoice[];
  readonly maxLength: number | null;
}

export interface CustomReviewRubricDocument {
  readonly schema: typeof CUSTOM_REVIEW_RUBRIC_DOCUMENT_SCHEMA;
  readonly version: 1;
  readonly title: "Organizer review rubric";
  readonly judgmentBoundary: "independent-review-evidence";
  readonly fields: readonly CustomReviewRubricField[];
}

interface ReviewCriterionSemanticsBase {
  readonly semantic: ReviewRubricSemanticCode;
  readonly required: boolean;
  readonly weight: number;
}

export interface NumericReviewCriterionSemantics extends ReviewCriterionSemanticsBase {
  readonly kind: "numeric";
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
}

export interface ScaleReviewCriterionSemantics extends ReviewCriterionSemanticsBase {
  readonly kind: "scale";
  readonly scaleCode: typeof REVIEW_SCALE_CODE;
}

export interface YesNoReviewCriterionSemantics extends ReviewCriterionSemanticsBase {
  readonly kind: "yesNo";
}

export interface RecommendationReviewCriterionSemantics extends ReviewCriterionSemanticsBase {
  readonly kind: "recommendation";
}

export interface CommentReviewCriterionSemantics extends ReviewCriterionSemanticsBase {
  readonly kind: "comment";
  readonly maxLength: number;
}

export type ReviewCriterionSemantics =
  | NumericReviewCriterionSemantics
  | ScaleReviewCriterionSemantics
  | YesNoReviewCriterionSemantics
  | RecommendationReviewCriterionSemantics
  | CommentReviewCriterionSemantics;

/** Organizer input has no title, label, guidance, identifiers, or choice prose. */
export type SealCriterionInput = ReviewCriterionSemantics;

export interface ReviewRubricSemanticsV1 {
  readonly schema: typeof CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA;
  readonly version: 1;
  readonly workspaceId: string;
  readonly roundId: string;
  readonly rubricVersionId: string;
  readonly rubricVersionNumber: number;
  readonly rubricVersionFingerprint: string;
  readonly criteria: readonly ReviewCriterionSemantics[];
  readonly customRubric?: CustomReviewRubricDocument;
  readonly issuer: {
    readonly accountId: string;
    readonly role: string;
    readonly authority: typeof REVIEW_ISSUER_AUTHORITY;
  };
  readonly issuedAt: string;
}

export interface RubricChoiceProjection {
  readonly value: string;
  readonly label: string;
}

interface RubricCriterionProjectionBase {
  readonly id: string;
  readonly label: string;
  readonly guidance: string;
  readonly required: boolean;
  readonly weight: number;
}

export interface NumericRubricCriterionProjection extends RubricCriterionProjectionBase {
  readonly kind: "numeric";
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
}

export interface ScaleRubricCriterionProjection extends RubricCriterionProjectionBase {
  readonly kind: "scale";
  readonly choices: readonly RubricChoiceProjection[];
}

export interface YesNoRubricCriterionProjection extends RubricCriterionProjectionBase {
  readonly kind: "yesNo";
}

export interface RecommendationRubricCriterionProjection extends RubricCriterionProjectionBase {
  readonly kind: "recommendation";
  readonly choices: readonly RubricChoiceProjection[];
}

export interface CommentRubricCriterionProjection extends RubricCriterionProjectionBase {
  readonly kind: "comment";
  readonly maxLength: number;
}

export interface DropdownRubricCriterionProjection extends RubricCriterionProjectionBase {
  readonly kind: "dropdown";
  readonly choices: readonly RubricChoiceProjection[];
}

export interface TextRubricCriterionProjection extends RubricCriterionProjectionBase {
  readonly kind: "text";
  readonly maxLength: number;
}

export type RubricCriterionProjection =
  | NumericRubricCriterionProjection
  | ScaleRubricCriterionProjection
  | YesNoRubricCriterionProjection
  | RecommendationRubricCriterionProjection
  | CommentRubricCriterionProjection
  | DropdownRubricCriterionProjection
  | TextRubricCriterionProjection;

/** Reviewer-safe: internal fingerprints, tenant/round bindings, and issuer are absent. */
export interface RubricProjection {
  readonly schema: typeof CFP_RUBRIC_SCHEMA;
  readonly title: typeof REVIEW_RUBRIC_TITLE;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly criteria: readonly RubricCriterionProjection[];
  readonly judgmentAuthority: typeof REVIEW_JUDGMENT_AUTHORITY;
}

export const REVIEW_RUBRIC_LIMITS = Object.freeze({
  maxCriteria: REVIEW_RUBRIC_SEMANTIC_CODES.length,
  maxCustomCriteria: 32,
  maxCustomChoices: 32,
  maxCommentLength: 64 * 1024,
  maxSerializedBytes: 512 * 1024,
  maxNodes: 8_192,
});

export const REVIEW_RUBRIC_COPY: Readonly<
  Record<ReviewRubricSemanticCode, { readonly label: string; readonly guidance: string }>
> = Object.freeze({
  PROPOSAL_QUALITY: Object.freeze({
    label: "Proposal quality",
    guidance: "Assess the proposal as presented.",
  }),
  AUDIENCE_RELEVANCE: Object.freeze({
    label: "Audience relevance",
    guidance: "Assess relevance to the stated audience.",
  }),
  EVIDENCE_STRENGTH: Object.freeze({
    label: "Evidence strength",
    guidance: "Assess whether the proposal supports its claims.",
  }),
  DELIVERY_FEASIBILITY: Object.freeze({
    label: "Delivery feasibility",
    guidance: "Assess whether the session can be delivered as described.",
  }),
  CLAIMS_SUPPORTED: Object.freeze({
    label: "Claims supported",
    guidance: "Record whether the proposal supports its material claims.",
  }),
  INDEPENDENT_RECOMMENDATION: Object.freeze({
    label: "Independent recommendation",
    guidance: "Record evidence for further consideration; this is not a program decision.",
  }),
  REVIEWER_NOTES: Object.freeze({
    label: "Reviewer notes",
    guidance: "Record proposal-focused evidence only.",
  }),
});

export const REVIEW_SCALE_CHOICES: readonly RubricChoiceProjection[] = Object.freeze([
  Object.freeze({ value: "LOW", label: "Low" }),
  Object.freeze({ value: "MEDIUM", label: "Medium" }),
  Object.freeze({ value: "HIGH", label: "High" }),
]);

export const REVIEW_RECOMMENDATION_CHOICES: readonly RubricChoiceProjection[] = Object.freeze([
  Object.freeze({ value: "ADVANCE", label: "Advance for further consideration" }),
  Object.freeze({ value: "HOLD", label: "Hold for further consideration" }),
  Object.freeze({
    value: "DO_NOT_ADVANCE",
    label: "Do not advance for further consideration",
  }),
]);

const RUBRIC_ERROR_MESSAGES = {
  RUBRIC_SEMANTICS_INPUT_UNSAFE: "The review-rubric semantics input is unsafe.",
  RUBRIC_SEMANTICS_SHAPE_INVALID: "The review-rubric semantics document has an invalid structure.",
  RUBRIC_SEMANTICS_SCHEMA_UNSUPPORTED: "The review-rubric semantics schema is not supported.",
  RUBRIC_SEMANTICS_LIMIT_EXCEEDED: "The review-rubric semantics document exceeds a structural limit.",
  RUBRIC_SEMANTICS_BINDING_INVALID: "A review-rubric semantics binding is invalid.",
  RUBRIC_SEMANTICS_CRITERION_INVALID: "A review-rubric semantics criterion is invalid.",
  RUBRIC_SEMANTICS_CRITERION_DUPLICATE: "A review-rubric semantic code is duplicated.",
  RUBRIC_SEMANTICS_CANONICAL_JSON_INVALID: "The review-rubric semantics JSON is not canonical.",
} as const;

export type ReviewRubricSemanticsErrorCode = keyof typeof RUBRIC_ERROR_MESSAGES;

export class ReviewRubricSemanticsError extends Error {
  readonly code: ReviewRubricSemanticsErrorCode;

  constructor(code: ReviewRubricSemanticsErrorCode) {
    super(RUBRIC_ERROR_MESSAGES[code]);
    this.name = "ReviewRubricSemanticsError";
    this.code = code;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const SEMANTIC_CODE_SET: ReadonlySet<string> = new Set(REVIEW_RUBRIC_SEMANTIC_CODES);
const ORGANIZER_ISSUER_ROLES: ReadonlySet<string> = new Set([
  "organizer",
  "workspace_admin",
  "event_manager",
  "program_manager",
]);
const LIMIT_SAFETY_CODES: ReadonlySet<string> = new Set([
  "DEPTH_LIMIT",
  "STRING_LIMIT",
  "ARRAY_LIMIT",
  "OBJECT_LIMIT",
  "NODE_LIMIT",
  "SERIALIZED_SIZE_LIMIT",
]);
const RUBRIC_SAFETY_LIMITS = Object.freeze({
  maxDepth: 16,
  maxStringBytes: 64 * 1024,
  maxArrayLength: 256,
  maxObjectKeys: 32,
  maxKeyBytes: 128,
  maxNodes: REVIEW_RUBRIC_LIMITS.maxNodes,
  maxSerializedBytes: REVIEW_RUBRIC_LIMITS.maxSerializedBytes,
});

const ALLOWED_KINDS_BY_SEMANTIC: Readonly<
  Record<ReviewRubricSemanticCode, ReadonlySet<ReviewRubricStructuredKind>>
> = Object.freeze({
  PROPOSAL_QUALITY: new Set<ReviewRubricStructuredKind>(["numeric", "scale"]),
  AUDIENCE_RELEVANCE: new Set<ReviewRubricStructuredKind>(["numeric", "scale"]),
  EVIDENCE_STRENGTH: new Set<ReviewRubricStructuredKind>(["numeric", "scale"]),
  DELIVERY_FEASIBILITY: new Set<ReviewRubricStructuredKind>(["numeric", "scale"]),
  CLAIMS_SUPPORTED: new Set<ReviewRubricStructuredKind>(["yesNo"]),
  INDEPENDENT_RECOMMENDATION: new Set<ReviewRubricStructuredKind>(["recommendation"]),
  REVIEWER_NOTES: new Set<ReviewRubricStructuredKind>(["comment"]),
});

function fail(code: ReviewRubricSemanticsErrorCode): never {
  throw new ReviewRubricSemanticsError(code);
}

function sanitizeRubricData(input: unknown): JsonSafeValue {
  try {
    return sanitizeFormData(input, RUBRIC_SAFETY_LIMITS);
  } catch (error) {
    if (error instanceof FormSafetyError && LIMIT_SAFETY_CODES.has(error.code)) {
      return fail("RUBRIC_SEMANTICS_LIMIT_EXCEEDED");
    }
    return fail("RUBRIC_SEMANTICS_INPUT_UNSAFE");
  }
}

function isObject(value: JsonSafeValue): value is JsonSafeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonSafeObject, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function identifier(value: JsonSafeValue | undefined): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    return fail("RUBRIC_SEMANTICS_BINDING_INVALID");
  }
  return value;
}

const CUSTOM_CRITERION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RECOMMENDATION_CHOICE_VALUES = new Set([
  "ADVANCE",
  "HOLD",
  "DO_NOT_ADVANCE",
]);

function customCriterionIdentifier(value: JsonSafeValue | undefined): string {
  if (typeof value !== "string" || !CUSTOM_CRITERION_ID_PATTERN.test(value)) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  return value;
}

function fingerprint(value: JsonSafeValue | undefined): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    return fail("RUBRIC_SEMANTICS_BINDING_INVALID");
  }
  return value;
}

function positiveInteger(value: JsonSafeValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail("RUBRIC_SEMANTICS_BINDING_INVALID");
  }
  return value;
}

function finiteNumber(value: JsonSafeValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  return Object.is(value, -0) ? 0 : value;
}

function canonicalTimestamp(value: JsonSafeValue | undefined): string {
  if (typeof value !== "string") return fail("RUBRIC_SEMANTICS_BINDING_INVALID");
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    return fail("RUBRIC_SEMANTICS_BINDING_INVALID");
  }
  if (canonical !== value) return fail("RUBRIC_SEMANTICS_BINDING_INVALID");
  return value;
}

function semanticCode(value: JsonSafeValue | undefined): ReviewRubricSemanticCode {
  if (typeof value !== "string" || !SEMANTIC_CODE_SET.has(value)) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  return value as ReviewRubricSemanticCode;
}

function commonCriterion(
  candidate: JsonSafeObject,
): ReviewCriterionSemanticsBase & { readonly semantic: ReviewRubricSemanticCode } {
  const semantic = semanticCode(candidate.semantic);
  if (typeof candidate.required !== "boolean") {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  const weight = finiteNumber(candidate.weight);
  if (weight < 0 || weight > 1_000) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  if (
    typeof candidate.kind !== "string" ||
    !ALLOWED_KINDS_BY_SEMANTIC[semantic].has(candidate.kind as ReviewRubricStructuredKind)
  ) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  return { semantic, required: candidate.required, weight };
}

function normalizeCriterion(candidate: JsonSafeValue): ReviewCriterionSemantics {
  if (!isObject(candidate)) return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  const commonKeys = ["semantic", "kind", "required", "weight"];
  const kind = candidate.kind;
  const expected =
    kind === "numeric"
      ? new Set([...commonKeys, "minimum", "maximum", "step"])
      : kind === "scale"
        ? new Set([...commonKeys, "scaleCode"])
        : kind === "comment"
          ? new Set([...commonKeys, "maxLength"])
          : kind === "yesNo" || kind === "recommendation"
            ? new Set(commonKeys)
            : null;
  if (!expected || !hasExactKeys(candidate, expected)) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  const common = commonCriterion(candidate);

  if (kind === "numeric") {
    const minimum = finiteNumber(candidate.minimum);
    const maximum = finiteNumber(candidate.maximum);
    const step = finiteNumber(candidate.step);
    if (minimum >= maximum || step <= 0 || step > maximum - minimum) {
      return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
    }
    return Object.freeze({ ...common, kind, minimum, maximum, step });
  }
  if (kind === "scale") {
    if (candidate.scaleCode !== REVIEW_SCALE_CODE) {
      return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
    }
    return Object.freeze({ ...common, kind, scaleCode: REVIEW_SCALE_CODE });
  }
  if (kind === "yesNo") return Object.freeze({ ...common, kind });
  if (kind === "recommendation") return Object.freeze({ ...common, kind });

  if (
    typeof candidate.maxLength !== "number" ||
    !Number.isSafeInteger(candidate.maxLength) ||
    candidate.maxLength < 1 ||
    candidate.maxLength > REVIEW_RUBRIC_LIMITS.maxCommentLength
  ) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  return Object.freeze({ ...common, kind: "comment", maxLength: candidate.maxLength });
}

export function normalizeSealCriteria(input: unknown): readonly ReviewCriterionSemantics[] {
  const safe = sanitizeRubricData(input);
  if (
    !Array.isArray(safe) ||
    safe.length < 1 ||
    safe.length > REVIEW_RUBRIC_LIMITS.maxCriteria
  ) {
    return fail("RUBRIC_SEMANTICS_LIMIT_EXCEEDED");
  }
  const criteria = safe.map(normalizeCriterion);
  const seen = new Set<ReviewRubricSemanticCode>();
  for (const criterion of criteria) {
    if (seen.has(criterion.semantic)) {
      return fail("RUBRIC_SEMANTICS_CRITERION_DUPLICATE");
    }
    seen.add(criterion.semantic);
  }
  return Object.freeze(criteria);
}

const CUSTOM_RUBRIC_FIELD_KEYS = new Set([
  "id",
  "label",
  "guidance",
  "kind",
  "required",
  "weight",
  "recommendation",
  "minimum",
  "maximum",
  "step",
  "choices",
  "maxLength",
]);

function customText(
  value: JsonSafeValue | undefined,
  maximumBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  return value;
}

function customFiniteNumber(value: JsonSafeValue | undefined): number {
  return finiteNumber(value);
}

function customNullableNumber(value: JsonSafeValue | undefined): number | null {
  if (value === null) return null;
  return customFiniteNumber(value);
}

function normalizeCustomChoices(value: JsonSafeValue | undefined): readonly CustomReviewRubricChoice[] {
  if (!Array.isArray(value) || value.length > REVIEW_RUBRIC_LIMITS.maxCustomChoices) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  const seen = new Set<string>();
  const choices = value.map((candidate) => {
    if (!isObject(candidate) || !hasExactKeys(candidate, new Set(["value", "label"]))) {
      return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
    }
    const choiceValue = customText(candidate.value, 128);
    const choiceLabel = customText(candidate.label, 512);
    if (seen.has(choiceValue)) return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
    seen.add(choiceValue);
    return Object.freeze({ value: choiceValue, label: choiceLabel });
  });
  return Object.freeze(choices);
}

function normalizeCustomField(value: JsonSafeValue): CustomReviewRubricField {
  const requiredKeys = new Set([
    "id",
    "label",
    "guidance",
    "kind",
    "required",
    "weight",
    "minimum",
    "maximum",
    "step",
    "choices",
    "maxLength",
  ]);
  if (
    !isObject(value) ||
    ![...requiredKeys].every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !CUSTOM_RUBRIC_FIELD_KEYS.has(key))
  ) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  const id = customCriterionIdentifier(value.id);
  const label = customText(value.label, 512);
  const guidance = customText(value.guidance, 4_096, true);
  const kind = value.kind;
  if (kind !== "numeric" && kind !== "dropdown" && kind !== "text") {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  if (typeof value.required !== "boolean") {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  const weight = customFiniteNumber(value.weight);
  if (weight <= 0 || weight > 100_000) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  let recommendation: boolean | undefined;
  if (Object.hasOwn(value, "recommendation")) {
    if (typeof value.recommendation !== "boolean") {
      return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
    }
    recommendation = value.recommendation;
  }

  const minimum = customNullableNumber(value.minimum);
  const maximum = customNullableNumber(value.maximum);
  const step = customNullableNumber(value.step);
  const choices = normalizeCustomChoices(value.choices);
  const maxLength = value.maxLength === null
    ? null
    : (() => {
        if (
          typeof value.maxLength !== "number" ||
          !Number.isSafeInteger(value.maxLength) ||
          value.maxLength < 1 ||
          value.maxLength > REVIEW_RUBRIC_LIMITS.maxCommentLength
        ) {
          return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
        }
        return value.maxLength;
      })();

  if (kind === "numeric") {
    if (
      minimum === null ||
      maximum === null ||
      step === null ||
      maximum <= minimum ||
      step <= 0 ||
      step > maximum - minimum ||
      choices.length !== 0 ||
      maxLength !== null
    ) {
      return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
    }
  } else if (kind === "dropdown") {
    if (
      minimum !== null ||
      maximum !== null ||
      step !== null ||
      choices.length === 0 ||
      maxLength !== null
    ) {
      return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
    }
  } else if (
    minimum !== null ||
    maximum !== null ||
    step !== null ||
    choices.length !== 0 ||
    maxLength === null
  ) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  if (
    recommendation === true &&
    (kind !== "dropdown" ||
      choices.length !== RECOMMENDATION_CHOICE_VALUES.size ||
      choices.some((choice) => !RECOMMENDATION_CHOICE_VALUES.has(choice.value)))
  ) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }

  return Object.freeze({
    id,
    label,
    guidance,
    kind,
    required: value.required,
    weight,
    ...(recommendation !== undefined ? { recommendation } : {}),
    minimum,
    maximum,
    step,
    choices,
    maxLength,
  });
}

function normalizeCustomRubricDocumentSafe(value: JsonSafeValue): CustomReviewRubricDocument {
  if (
    !isObject(value) ||
    !hasExactKeys(value, new Set(["schema", "version", "title", "judgmentBoundary", "fields"])) ||
    value.schema !== CUSTOM_REVIEW_RUBRIC_DOCUMENT_SCHEMA ||
    value.version !== 1 ||
    value.title !== "Organizer review rubric" ||
    value.judgmentBoundary !== REVIEW_JUDGMENT_AUTHORITY ||
    !Array.isArray(value.fields) ||
    value.fields.length < 1 ||
    value.fields.length > REVIEW_RUBRIC_LIMITS.maxCustomCriteria
  ) {
    return fail("RUBRIC_SEMANTICS_SHAPE_INVALID");
  }
  const seen = new Set<string>();
  let recommendationCount = 0;
  const fields = value.fields.map((field) => {
    const normalized = normalizeCustomField(field);
    if (seen.has(normalized.id)) return fail("RUBRIC_SEMANTICS_CRITERION_DUPLICATE");
    seen.add(normalized.id);
    if (normalized.recommendation) {
      recommendationCount += 1;
      if (recommendationCount > 1) return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
    }
    return normalized;
  });
  return Object.freeze({
    schema: CUSTOM_REVIEW_RUBRIC_DOCUMENT_SCHEMA,
    version: 1,
    title: "Organizer review rubric",
    judgmentBoundary: REVIEW_JUDGMENT_AUTHORITY,
    fields: Object.freeze(fields),
  });
}

export function normalizeCustomReviewRubricDocument(input: unknown): CustomReviewRubricDocument {
  return normalizeCustomRubricDocumentSafe(sanitizeRubricData(input));
}

export function normalizeReviewRubricSemantics(input: unknown): ReviewRubricSemanticsV1 {
  const safe = sanitizeRubricData(input);
  if (!isObject(safe)) return fail("RUBRIC_SEMANTICS_SHAPE_INVALID");
  if (safe.schema !== CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA || safe.version !== 1) {
    return fail("RUBRIC_SEMANTICS_SCHEMA_UNSUPPORTED");
  }
  const requiredSemanticsKeys = new Set([
    "schema",
    "version",
    "workspaceId",
    "roundId",
    "rubricVersionId",
    "rubricVersionNumber",
    "rubricVersionFingerprint",
    "criteria",
    "issuer",
    "issuedAt",
  ]);
  if (
    ![...requiredSemanticsKeys].every((key) => Object.hasOwn(safe, key)) ||
    Object.keys(safe).some((key) => key !== "customRubric" && !requiredSemanticsKeys.has(key))
  ) {
    return fail("RUBRIC_SEMANTICS_SHAPE_INVALID");
  }
  if (
    !isObject(safe.issuer!) ||
    !hasExactKeys(safe.issuer, new Set(["accountId", "role", "authority"])) ||
    typeof safe.issuer.role !== "string" ||
    !ORGANIZER_ISSUER_ROLES.has(safe.issuer.role) ||
    safe.issuer.authority !== REVIEW_ISSUER_AUTHORITY
  ) {
    return fail("RUBRIC_SEMANTICS_BINDING_INVALID");
  }
  const customRubric = safe.customRubric === undefined
    ? undefined
    : normalizeCustomRubricDocumentSafe(safe.customRubric);
  if (customRubric !== undefined && (!Array.isArray(safe.criteria) || safe.criteria.length !== 0)) {
    return fail("RUBRIC_SEMANTICS_CRITERION_INVALID");
  }
  const document = Object.freeze<ReviewRubricSemanticsV1>({
    schema: CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
    version: 1,
    workspaceId: identifier(safe.workspaceId),
    roundId: identifier(safe.roundId),
    rubricVersionId: identifier(safe.rubricVersionId),
    rubricVersionNumber: positiveInteger(safe.rubricVersionNumber),
    rubricVersionFingerprint: fingerprint(safe.rubricVersionFingerprint),
    criteria: customRubric === undefined
      ? normalizeSealCriteria(safe.criteria)
      : Object.freeze([]),
    ...(customRubric !== undefined ? { customRubric } : {}),
    issuer: Object.freeze({
      accountId: identifier(safe.issuer.accountId),
      role: safe.issuer.role,
      authority: REVIEW_ISSUER_AUTHORITY,
    }),
    issuedAt: canonicalTimestamp(safe.issuedAt),
  });
  if (Buffer.byteLength(canonicalJson(document), "utf8") > REVIEW_RUBRIC_LIMITS.maxSerializedBytes) {
    return fail("RUBRIC_SEMANTICS_LIMIT_EXCEEDED");
  }
  return document;
}

export const normalizeRubricSemantics = normalizeReviewRubricSemantics;

export function canonicalReviewRubricSemanticsJson(input: unknown): string {
  return canonicalJson(normalizeReviewRubricSemantics(input));
}

export function parseCanonicalReviewRubricSemantics(
  serialized: string,
): ReviewRubricSemanticsV1 {
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > REVIEW_RUBRIC_LIMITS.maxSerializedBytes
  ) {
    return fail("RUBRIC_SEMANTICS_LIMIT_EXCEEDED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return fail("RUBRIC_SEMANTICS_CANONICAL_JSON_INVALID");
  }
  const normalized = normalizeReviewRubricSemantics(parsed);
  if (canonicalJson(normalized) !== serialized) {
    return fail("RUBRIC_SEMANTICS_CANONICAL_JSON_INVALID");
  }
  return normalized;
}

export function fingerprintReviewRubricSemantics(input: unknown): string {
  return fingerprintOf(normalizeReviewRubricSemantics(input));
}

export const reviewRubricSemanticsFingerprint = fingerprintReviewRubricSemantics;

function projectCriterion(
  criterion: ReviewCriterionSemantics,
  index: number,
): RubricCriterionProjection {
  const copy = REVIEW_RUBRIC_COPY[criterion.semantic];
  const common = {
    id: `criterion-${String(index + 1).padStart(4, "0")}`,
    label: copy.label,
    guidance: copy.guidance,
    required: criterion.required,
    weight: criterion.weight,
  } as const;
  if (criterion.kind === "numeric") {
    return Object.freeze({
      ...common,
      kind: "numeric",
      minimum: criterion.minimum,
      maximum: criterion.maximum,
      step: criterion.step,
    });
  }
  if (criterion.kind === "scale") {
    return Object.freeze({ ...common, kind: "scale", choices: REVIEW_SCALE_CHOICES });
  }
  if (criterion.kind === "yesNo") {
    return Object.freeze({ ...common, kind: "yesNo" });
  }
  if (criterion.kind === "recommendation") {
    return Object.freeze({
      ...common,
      kind: "recommendation",
      choices: REVIEW_RECOMMENDATION_CHOICES,
    });
  }
  return Object.freeze({ ...common, kind: "comment", maxLength: criterion.maxLength });
}

function projectCustomCriterion(field: CustomReviewRubricField): RubricCriterionProjection {
  const common = {
    id: field.id,
    label: field.label,
    guidance: field.guidance,
    required: field.required,
    weight: field.weight,
  } as const;
  if (field.kind === "numeric") {
    return Object.freeze({
      ...common,
      kind: "numeric",
      minimum: field.minimum!,
      maximum: field.maximum!,
      step: field.step!,
    });
  }
  if (field.kind === "dropdown") {
    return Object.freeze({
      ...common,
      kind: "dropdown",
      choices: Object.freeze(field.choices.map((choice) => Object.freeze({ ...choice }))),
    });
  }
  return Object.freeze({ ...common, kind: "text", maxLength: field.maxLength! });
}

/** Build a fresh allowlisted projection; no internal document is spread outward. */
export function projectReviewRubricSemantics(input: unknown): RubricProjection {
  const document = normalizeReviewRubricSemantics(input);
  return Object.freeze({
    schema: CFP_RUBRIC_SCHEMA,
    title: REVIEW_RUBRIC_TITLE,
    versionId: document.rubricVersionId,
    versionNumber: document.rubricVersionNumber,
    criteria: Object.freeze(
      document.customRubric !== undefined
        ? document.customRubric.fields.map(projectCustomCriterion)
        : document.criteria.map(projectCriterion),
    ),
    judgmentAuthority: REVIEW_JUDGMENT_AUTHORITY,
  });
}

export const projectRubricSemantics = projectReviewRubricSemantics;
