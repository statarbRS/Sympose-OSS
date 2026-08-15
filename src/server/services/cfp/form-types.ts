import { canonicalJson, fingerprintOf } from "../../canonical";
import {
  DEFAULT_FORM_SAFETY_LIMITS,
  sanitizeFormData,
  type JsonSafeObject,
  type JsonSafeValue,
} from "./form-safety";
import {
  normalizeCoPresentersFieldConfig,
  normalizeCoPresentersValue,
} from "../../../cfp/co-presenters";
import {
  FORM_FIELD_TYPES,
  type FormFieldType,
} from "../../../cfp/form-field-contract";

export { FORM_FIELD_TYPES, type FormFieldType } from "../../../cfp/form-field-contract";

export const FORM_DOCUMENT_SCHEMA = "cfp-form-document/v1" as const;
export type FormDocumentSchema = typeof FORM_DOCUMENT_SCHEMA;

export function compareFormFieldIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export type FormFieldVisibility = "visible" | "hidden";

export interface FormFieldDefinition {
  readonly id: string;
  readonly type: FormFieldType;
  readonly label: string;
  readonly required: boolean;
  readonly defaultVisibility: FormFieldVisibility;
  readonly config?: JsonSafeValue;
}

export interface FormAnswer {
  readonly fieldId: string;
  readonly value: JsonSafeValue;
}

export interface NormalizedFormDocument {
  readonly schema: FormDocumentSchema;
  readonly formVersionId: string;
  readonly ruleVersionId: string;
  readonly fields: readonly FormFieldDefinition[];
  readonly historicalAnswers: readonly FormAnswer[];
  readonly effectiveAnswers: readonly FormAnswer[];
  readonly fingerprint: string;
}

export interface FormDocumentIdentity {
  readonly schema: FormDocumentSchema;
  readonly formVersionId: string;
  readonly ruleVersionId: string;
  readonly fingerprint: string;
}

export const FORM_DOCUMENT_LIMITS = Object.freeze({
  maxFields: 256,
  maxAnswers: 256,
  maxIdentifierLength: 128,
  maxLabelLength: 512,
});

const FORM_DOCUMENT_ERROR_MESSAGES = {
  FORM_DOCUMENT_SCHEMA_UNSUPPORTED: "The form document schema is not supported.",
  FORM_DOCUMENT_SHAPE_INVALID: "The form document has an invalid structure.",
  FORM_DOCUMENT_LIMIT_EXCEEDED: "The form document exceeds a structural limit.",
  FORM_VERSION_ID_INVALID: "The form version identifier is invalid.",
  RULE_VERSION_ID_INVALID: "The rule version identifier is invalid.",
  FORM_FIELD_INVALID: "A form field is invalid.",
  FORM_FIELD_DUPLICATE: "A form field identifier is duplicated.",
  FORM_ANSWER_INVALID: "A form answer is invalid.",
  FORM_ANSWER_DUPLICATE: "A form answer is duplicated.",
  FORM_ANSWER_FIELD_UNKNOWN: "A form answer references an unknown field.",
  FORM_ANSWER_FIELD_CONTAINER: "A form answer references a container field.",
  FORM_EFFECTIVE_ANSWER_NOT_HISTORICAL: "An effective answer does not match answer history.",
  FORM_FINGERPRINT_INVALID: "The form document fingerprint is invalid.",
  FORM_FINGERPRINT_MISMATCH: "The form document fingerprint does not match its content.",
} as const;

export type FormDocumentErrorCode = keyof typeof FORM_DOCUMENT_ERROR_MESSAGES;

export class FormDocumentError extends Error {
  readonly code: FormDocumentErrorCode;

  constructor(code: FormDocumentErrorCode) {
    super(FORM_DOCUMENT_ERROR_MESSAGES[code]);
    this.name = "FormDocumentError";
    this.code = code;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FORM_FIELD_TYPES);
const CONTAINER_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set(["section", "repeatableGroup"]);
const HAS_OWN = Object.prototype.hasOwnProperty;
const UNFINGERPRINTED_DOCUMENT_SAFETY_LIMITS = Object.freeze({
  maxNodes: DEFAULT_FORM_SAFETY_LIMITS.maxNodes - 1,
  maxSerializedBytes: DEFAULT_FORM_SAFETY_LIMITS.maxSerializedBytes - 128,
});

function isObject(value: JsonSafeValue): value is JsonSafeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonSafeObject, key: string): boolean {
  return HAS_OWN.call(value, key);
}

function hasOnlyKeys(value: JsonSafeObject, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isIdentifier(value: JsonSafeValue | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length <= FORM_DOCUMENT_LIMITS.maxIdentifierLength &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isFieldType(value: JsonSafeValue | undefined): value is FormFieldType {
  return typeof value === "string" && FIELD_TYPE_SET.has(value);
}

function normalizeFields(value: JsonSafeValue): readonly FormFieldDefinition[] {
  if (!Array.isArray(value)) {
    throw new FormDocumentError("FORM_DOCUMENT_SHAPE_INVALID");
  }
  if (value.length > FORM_DOCUMENT_LIMITS.maxFields) {
    throw new FormDocumentError("FORM_DOCUMENT_LIMIT_EXCEEDED");
  }

  const allowedKeys = new Set(["id", "type", "label", "required", "defaultVisibility", "config"]);
  const seen = new Set<string>();
  const fields: FormFieldDefinition[] = [];
  for (const candidate of value) {
    if (!isObject(candidate) || !hasOnlyKeys(candidate, allowedKeys)) {
      throw new FormDocumentError("FORM_FIELD_INVALID");
    }
    if (
      !isIdentifier(candidate.id) ||
      !isFieldType(candidate.type) ||
      typeof candidate.label !== "string" ||
      candidate.label.trim().length === 0 ||
      candidate.label.length > FORM_DOCUMENT_LIMITS.maxLabelLength ||
      typeof candidate.required !== "boolean" ||
      (candidate.defaultVisibility !== "visible" && candidate.defaultVisibility !== "hidden")
    ) {
      throw new FormDocumentError("FORM_FIELD_INVALID");
    }
    if (seen.has(candidate.id)) {
      throw new FormDocumentError("FORM_FIELD_DUPLICATE");
    }
    seen.add(candidate.id);

    let config: JsonSafeValue | undefined;
    if (hasOwn(candidate, "config")) {
      try {
        const coPresentersConfig = normalizeCoPresentersFieldConfig(candidate.config, candidate.type);
        config = (coPresentersConfig ?? candidate.config) as JsonSafeValue;
      } catch {
        throw new FormDocumentError("FORM_FIELD_INVALID");
      }
    }

    const field: FormFieldDefinition = Object.freeze({
      id: candidate.id,
      type: candidate.type,
      label: candidate.label,
      required: candidate.required,
      defaultVisibility: candidate.defaultVisibility,
      ...(config !== undefined ? { config } : {}),
    });
    fields.push(field);
  }
  return Object.freeze(fields);
}

function normalizeAnswers(
  value: JsonSafeValue,
  fieldsById: ReadonlyMap<string, FormFieldDefinition>,
): readonly FormAnswer[] {
  if (!Array.isArray(value)) {
    throw new FormDocumentError("FORM_DOCUMENT_SHAPE_INVALID");
  }
  if (value.length > FORM_DOCUMENT_LIMITS.maxAnswers) {
    throw new FormDocumentError("FORM_DOCUMENT_LIMIT_EXCEEDED");
  }

  const allowedKeys = new Set(["fieldId", "value"]);
  const seen = new Set<string>();
  const answers: FormAnswer[] = [];
  for (const candidate of value) {
    if (
      !isObject(candidate) ||
      !hasOnlyKeys(candidate, allowedKeys) ||
      !isIdentifier(candidate.fieldId) ||
      !hasOwn(candidate, "value")
    ) {
      throw new FormDocumentError("FORM_ANSWER_INVALID");
    }
    if (seen.has(candidate.fieldId)) {
      throw new FormDocumentError("FORM_ANSWER_DUPLICATE");
    }
    seen.add(candidate.fieldId);

    const field = fieldsById.get(candidate.fieldId);
    if (!field) {
      throw new FormDocumentError("FORM_ANSWER_FIELD_UNKNOWN");
    }
    if (CONTAINER_FIELD_TYPES.has(field.type)) {
      throw new FormDocumentError("FORM_ANSWER_FIELD_CONTAINER");
    }
    let value = candidate.value;
    try {
      const coPresentersConfig = normalizeCoPresentersFieldConfig(field.config, field.type);
      if (coPresentersConfig) {
        value = normalizeCoPresentersValue(candidate.value, coPresentersConfig) as JsonSafeValue;
      }
    } catch {
      throw new FormDocumentError("FORM_ANSWER_INVALID");
    }
    answers.push(Object.freeze({ fieldId: candidate.fieldId, value }));
  }
  return Object.freeze(answers);
}

interface FingerprintContent {
  readonly schema: FormDocumentSchema;
  readonly formVersionId: string;
  readonly ruleVersionId: string;
  readonly fields: readonly FormFieldDefinition[];
  readonly historicalAnswers: readonly FormAnswer[];
  readonly effectiveAnswers: readonly FormAnswer[];
}

function fingerprintContent(content: FingerprintContent): FingerprintContent {
  return {
    schema: content.schema,
    formVersionId: content.formVersionId,
    ruleVersionId: content.ruleVersionId,
    fields: content.fields,
    historicalAnswers: content.historicalAnswers,
    effectiveAnswers: content.effectiveAnswers,
  };
}

function normalizeFormDocumentInternal(input: unknown, requireFingerprint: boolean): NormalizedFormDocument {
  const initiallySafe = sanitizeFormData(input);
  if (!isObject(initiallySafe)) {
    throw new FormDocumentError("FORM_DOCUMENT_SHAPE_INVALID");
  }
  const constrained = hasOwn(initiallySafe, "fingerprint")
    ? initiallySafe
    : sanitizeFormData(initiallySafe, UNFINGERPRINTED_DOCUMENT_SAFETY_LIMITS);
  if (!isObject(constrained)) {
    throw new FormDocumentError("FORM_DOCUMENT_SHAPE_INVALID");
  }
  const safe = constrained;

  const allowedKeys = new Set([
    "schema",
    "formVersionId",
    "ruleVersionId",
    "fields",
    "historicalAnswers",
    "effectiveAnswers",
    "fingerprint",
  ]);
  if (!hasOnlyKeys(safe, allowedKeys)) {
    throw new FormDocumentError("FORM_DOCUMENT_SHAPE_INVALID");
  }
  if (safe.schema !== FORM_DOCUMENT_SCHEMA) {
    throw new FormDocumentError("FORM_DOCUMENT_SCHEMA_UNSUPPORTED");
  }
  if (!isIdentifier(safe.formVersionId)) {
    throw new FormDocumentError("FORM_VERSION_ID_INVALID");
  }
  if (!isIdentifier(safe.ruleVersionId)) {
    throw new FormDocumentError("RULE_VERSION_ID_INVALID");
  }
  if (!hasOwn(safe, "fields") || !hasOwn(safe, "historicalAnswers") || !hasOwn(safe, "effectiveAnswers")) {
    throw new FormDocumentError("FORM_DOCUMENT_SHAPE_INVALID");
  }

  const fields = normalizeFields(safe.fields);
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const historicalAnswers = normalizeAnswers(safe.historicalAnswers, fieldsById);
  const candidateEffectiveAnswers = normalizeAnswers(safe.effectiveAnswers, fieldsById);
  const historyByFieldId = new Map(historicalAnswers.map((answer) => [answer.fieldId, answer]));
  const effectiveAnswers: FormAnswer[] = [];
  for (const answer of candidateEffectiveAnswers) {
    const historical = historyByFieldId.get(answer.fieldId);
    if (!historical || canonicalJson(historical.value) !== canonicalJson(answer.value)) {
      throw new FormDocumentError("FORM_EFFECTIVE_ANSWER_NOT_HISTORICAL");
    }
    effectiveAnswers.push(Object.freeze({ fieldId: answer.fieldId, value: historical.value }));
  }

  const sortedHistoricalAnswers = Object.freeze(
    [...historicalAnswers].sort((a, b) => compareFormFieldIds(a.fieldId, b.fieldId)),
  );
  const sortedEffectiveAnswers = Object.freeze(
    [...effectiveAnswers].sort((a, b) => compareFormFieldIds(a.fieldId, b.fieldId)),
  );

  const content: FingerprintContent = {
    schema: FORM_DOCUMENT_SCHEMA,
    formVersionId: safe.formVersionId,
    ruleVersionId: safe.ruleVersionId,
    fields,
    historicalAnswers: sortedHistoricalAnswers,
    effectiveAnswers: sortedEffectiveAnswers,
  };
  const fingerprint = fingerprintOf(fingerprintContent(content));
  const suppliedFingerprint = safe.fingerprint;
  if (
    suppliedFingerprint !== undefined &&
    (typeof suppliedFingerprint !== "string" || !FINGERPRINT_PATTERN.test(suppliedFingerprint))
  ) {
    throw new FormDocumentError("FORM_FINGERPRINT_INVALID");
  }
  if (requireFingerprint && typeof suppliedFingerprint !== "string") {
    throw new FormDocumentError("FORM_FINGERPRINT_INVALID");
  }
  if (typeof suppliedFingerprint === "string" && suppliedFingerprint !== fingerprint) {
    throw new FormDocumentError("FORM_FINGERPRINT_MISMATCH");
  }

  return Object.freeze({ ...content, fingerprint });
}

export function normalizeFormDocument(input: unknown): NormalizedFormDocument {
  return normalizeFormDocumentInternal(input, false);
}

export function verifyFormDocumentFingerprint(input: unknown): boolean {
  try {
    normalizeFormDocumentInternal(input, true);
    return true;
  } catch {
    return false;
  }
}

export function historicalAnswersOf(
  document: NormalizedFormDocument,
): readonly FormAnswer[] {
  return document.historicalAnswers;
}

export function effectiveAnswersOf(
  document: NormalizedFormDocument,
): readonly FormAnswer[] {
  return document.effectiveAnswers;
}

export function formDocumentIdentity(document: NormalizedFormDocument): FormDocumentIdentity {
  return Object.freeze({
    schema: document.schema,
    formVersionId: document.formVersionId,
    ruleVersionId: document.ruleVersionId,
    fingerprint: document.fingerprint,
  });
}
