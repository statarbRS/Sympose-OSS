import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";

import { canonicalJson, fingerprintOf } from "../../canonical";
import {
  FormSafetyError,
  sanitizeFormData,
  type JsonSafeObject,
  type JsonSafeValue,
} from "../cfp/form-safety";
import {
  compareFormFieldIds,
  FORM_DOCUMENT_SCHEMA,
  FORM_FIELD_TYPES,
  normalizeFormDocument,
  type FormFieldDefinition,
  type FormFieldType,
} from "../cfp/form-types";
import {
  BLIND_ANSWER_TYPES,
  BLIND_REVIEW_ARTIFACT_LIMITS,
  BLIND_REVIEW_ATTESTATION,
  BLIND_REVIEW_DISCLOSURE_STAGE,
  BLIND_REVIEW_EXCLUSION_ONLY_FIELD_TYPES,
  CFP_FORM_DOCUMENT_SCHEMA,
  CFP_REVIEW_BLIND_ARTIFACT_SCHEMA,
  CFP_REVIEW_FIELD_DEFINITION_BINDING_SCHEMA,
  CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA,
  CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA,
  CFP_SUBMISSION_REVISION_SCHEMA,
  REVIEW_ISSUER_AUTHORITY,
  type BlindAnswerType,
  type BlindArtifactItemV1,
  type BlindFieldDecisionInput,
  type BlindReviewArtifactV1,
  type CreateBlindReviewArtifactInput,
  type ExcludedBlindArtifactItemV1,
  type IncludedBlindArtifactItemV1,
  type ReviewFieldDefinitionBindingV1,
  type ReviewRedactedValueBindingV1,
  type ReviewSourceAnswerBindingV1,
} from "./artifact-types";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const FORM_FIELD_TYPE_SET: ReadonlySet<string> = new Set(FORM_FIELD_TYPES);
const BLIND_ANSWER_TYPE_SET: ReadonlySet<string> = new Set(BLIND_ANSWER_TYPES);
const EXCLUSION_ONLY_TYPE_SET: ReadonlySet<string> = new Set(
  BLIND_REVIEW_EXCLUSION_ONLY_FIELD_TYPES,
);
const LIMIT_SAFETY_CODES: ReadonlySet<string> = new Set([
  "DEPTH_LIMIT",
  "STRING_LIMIT",
  "ARRAY_LIMIT",
  "OBJECT_LIMIT",
  "NODE_LIMIT",
  "SERIALIZED_SIZE_LIMIT",
]);
const ORGANIZER_ISSUER_ROLES: ReadonlySet<string> = new Set([
  "organizer",
  "workspace_admin",
  "event_manager",
  "program_manager",
]);

const BINDING_SAFETY_LIMITS = Object.freeze({
  maxDepth: 32,
  maxStringBytes: 64 * 1024,
  maxArrayLength: 1_024,
  maxObjectKeys: 256,
  maxKeyBytes: 128,
  maxNodes: 20_000,
  maxSerializedBytes: BLIND_REVIEW_ARTIFACT_LIMITS.maxSerializedBytes,
});

const RAW_INPUT_SAFETY_LIMITS = Object.freeze({
  maxDepth: BLIND_REVIEW_ARTIFACT_LIMITS.maxDepth,
  maxStringBytes: BINDING_SAFETY_LIMITS.maxStringBytes,
  maxArrayLength: BLIND_REVIEW_ARTIFACT_LIMITS.maxItems,
  maxObjectKeys: BINDING_SAFETY_LIMITS.maxObjectKeys,
  maxKeyBytes: BINDING_SAFETY_LIMITS.maxKeyBytes,
  maxNodes: BLIND_REVIEW_ARTIFACT_LIMITS.maxNodes,
  maxSerializedBytes: BLIND_REVIEW_ARTIFACT_LIMITS.maxSerializedBytes,
});

const FORBIDDEN_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const ARTIFACT_ERROR_MESSAGES = {
  ARTIFACT_INPUT_UNSAFE: "The blind-review artifact input is unsafe.",
  ARTIFACT_SHAPE_INVALID: "The blind-review artifact has an invalid structure.",
  ARTIFACT_SCHEMA_UNSUPPORTED: "The blind-review artifact schema is not supported.",
  ARTIFACT_LIMIT_EXCEEDED: "The blind-review artifact exceeds a structural limit.",
  ARTIFACT_BINDING_INVALID: "A blind-review artifact binding is invalid.",
  ARTIFACT_FINGERPRINT_INVALID: "A blind-review artifact fingerprint is invalid.",
  ARTIFACT_FINGERPRINT_MISMATCH: "A blind-review artifact fingerprint does not match its binding.",
  ARTIFACT_ITEM_INVALID: "A blind-review artifact item is invalid.",
  ARTIFACT_ITEM_DUPLICATE: "A blind-review artifact source field is duplicated.",
  ARTIFACT_DECISION_MISSING: "A blind-review artifact decision is missing.",
  ARTIFACT_DECISION_DUPLICATE: "A blind-review artifact decision is duplicated.",
  ARTIFACT_DECISION_UNKNOWN: "A blind-review artifact decision references an unknown effective answer.",
  ARTIFACT_STRUCTURAL_INCLUDE_FORBIDDEN:
    "An exclusion-only source field cannot be included in a blind-review artifact.",
  ARTIFACT_REDACTED_VALUE_INVALID: "A blind-review redacted value is invalid for its field type.",
  ARTIFACT_CANONICAL_JSON_INVALID: "The blind-review artifact JSON is not canonical.",
} as const;

export type ReviewArtifactErrorCode = keyof typeof ARTIFACT_ERROR_MESSAGES;

export class ReviewArtifactError extends Error {
  readonly code: ReviewArtifactErrorCode;

  constructor(code: ReviewArtifactErrorCode) {
    super(ARTIFACT_ERROR_MESSAGES[code]);
    this.name = "ReviewArtifactError";
    this.code = code;
  }
}

export { ReviewArtifactError as BlindReviewArtifactError };

function fail(code: ReviewArtifactErrorCode): never {
  throw new ReviewArtifactError(code);
}

function inspected<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
}

interface RawInputWalkState {
  readonly active: WeakSet<object>;
  nodes: number;
  serializedBytes: number;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function consumeRawSerializedBytes(state: RawInputWalkState, bytes: number): void {
  state.serializedBytes += bytes;
  if (state.serializedBytes > RAW_INPUT_SAFETY_LIMITS.maxSerializedBytes) {
    return fail("ARTIFACT_LIMIT_EXCEEDED");
  }
}

function rawScalarSerializedBytes(value: null | boolean | number | string): number {
  const serialized = inspected(() => JSON.stringify(value));
  if (typeof serialized !== "string") return fail("ARTIFACT_INPUT_UNSAFE");
  return Buffer.byteLength(serialized, "utf8");
}

function assertSafeRawPropertyKey(key: string): void {
  if (
    key.length === 0 ||
    FORBIDDEN_PROPERTY_KEYS.has(key) ||
    CONTROL_CHARACTER_PATTERN.test(key) ||
    hasLoneSurrogate(key) ||
    Buffer.byteLength(key, "utf8") > RAW_INPUT_SAFETY_LIMITS.maxKeyBytes
  ) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
}

function preflightRawInputValue(
  input: unknown,
  depth: number,
  state: RawInputWalkState,
): JsonSafeValue {
  if (depth > RAW_INPUT_SAFETY_LIMITS.maxDepth) {
    return fail("ARTIFACT_LIMIT_EXCEEDED");
  }
  state.nodes += 1;
  if (state.nodes > RAW_INPUT_SAFETY_LIMITS.maxNodes) {
    return fail("ARTIFACT_LIMIT_EXCEEDED");
  }

  if (input === null || typeof input === "boolean") {
    consumeRawSerializedBytes(state, rawScalarSerializedBytes(input));
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return fail("ARTIFACT_INPUT_UNSAFE");
    const normalized = Object.is(input, -0) ? 0 : input;
    consumeRawSerializedBytes(state, rawScalarSerializedBytes(normalized));
    return normalized;
  }
  if (typeof input === "string") {
    if (
      hasLoneSurrogate(input) ||
      Buffer.byteLength(input, "utf8") > RAW_INPUT_SAFETY_LIMITS.maxStringBytes
    ) {
      return fail(
        hasLoneSurrogate(input) ? "ARTIFACT_INPUT_UNSAFE" : "ARTIFACT_LIMIT_EXCEEDED",
      );
    }
    consumeRawSerializedBytes(state, rawScalarSerializedBytes(input));
    return input;
  }
  if (typeof input === "symbol") return fail("ARTIFACT_INPUT_UNSAFE");
  if (typeof input !== "object" || inspected(() => utilTypes.isProxy(input))) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
  if (state.active.has(input)) return fail("ARTIFACT_INPUT_UNSAFE");

  state.active.add(input);
  try {
    if (inspected(() => Array.isArray(input))) {
      if (inspected(() => Object.getPrototypeOf(input)) !== Array.prototype) {
        return fail("ARTIFACT_INPUT_UNSAFE");
      }
      if (inspected(() => Object.getOwnPropertySymbols(input)).length > 0) {
        return fail("ARTIFACT_INPUT_UNSAFE");
      }
      const lengthDescriptor = inspected(() => Object.getOwnPropertyDescriptor(input, "length"));
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return fail("ARTIFACT_INPUT_UNSAFE");
      }
      const length = lengthDescriptor.value;
      if (length > RAW_INPUT_SAFETY_LIMITS.maxArrayLength) {
        return fail("ARTIFACT_LIMIT_EXCEEDED");
      }
      const names = inspected(() => Object.getOwnPropertyNames(input));
      if (names.length !== length + 1) return fail("ARTIFACT_INPUT_UNSAFE");
      for (const name of names) {
        if (name === "length") continue;
        const index = Number(name);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= length ||
          String(index) !== name
        ) {
          return fail("ARTIFACT_INPUT_UNSAFE");
        }
      }

      consumeRawSerializedBytes(state, 2 + Math.max(0, length - 1));
      const output: JsonSafeValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = inspected(() =>
          Object.getOwnPropertyDescriptor(input, String(index)),
        );
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          return fail("ARTIFACT_INPUT_UNSAFE");
        }
        output.push(preflightRawInputValue(descriptor.value, depth + 1, state));
      }
      return output;
    }

    const prototype = inspected(() => Object.getPrototypeOf(input));
    if (prototype !== Object.prototype && prototype !== null) {
      return fail("ARTIFACT_INPUT_UNSAFE");
    }
    if (inspected(() => Object.getOwnPropertySymbols(input)).length > 0) {
      return fail("ARTIFACT_INPUT_UNSAFE");
    }
    const names = inspected(() => Object.getOwnPropertyNames(input));
    if (names.length > RAW_INPUT_SAFETY_LIMITS.maxObjectKeys) {
      return fail("ARTIFACT_LIMIT_EXCEEDED");
    }
    consumeRawSerializedBytes(state, 2 + Math.max(0, names.length - 1));
    const output: Record<string, JsonSafeValue> = {};
    for (const name of names) {
      assertSafeRawPropertyKey(name);
      consumeRawSerializedBytes(state, rawScalarSerializedBytes(name) + 1);
      const descriptor = inspected(() => Object.getOwnPropertyDescriptor(input, name));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        return fail("ARTIFACT_INPUT_UNSAFE");
      }
      Object.defineProperty(output, name, {
        configurable: true,
        enumerable: true,
        value: preflightRawInputValue(descriptor.value, depth + 1, state),
        writable: true,
      });
    }
    return output;
  } finally {
    state.active.delete(input);
  }
}

/**
 * Detach and account for the complete raw graph before any per-item work. The
 * byte count is the exact JSON encoding size and is shared by all item values.
 */
function preflightRawInput(input: unknown): JsonSafeValue {
  return preflightRawInputValue(input, 0, {
    active: new WeakSet<object>(),
    nodes: 0,
    serializedBytes: 0,
  });
}

function isJsonObject(value: JsonSafeValue): value is JsonSafeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonSafeObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: JsonSafeObject, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasOnlyKeys(value: JsonSafeObject, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function sanitizeJson(input: unknown): JsonSafeValue {
  try {
    return sanitizeFormData(input, BINDING_SAFETY_LIMITS);
  } catch (error) {
    if (error instanceof FormSafetyError && LIMIT_SAFETY_CODES.has(error.code)) {
      return fail("ARTIFACT_LIMIT_EXCEEDED");
    }
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
}

/**
 * Inspect an artifact envelope without reading through accessors. The nested
 * values are normalized separately. This avoids imposing form-safety's 1,024
 * outer-array limit on the frozen 16,384-item artifact format.
 */
function ownDataRecord(input: unknown, expected: ReadonlySet<string>): Record<string, unknown> {
  if (input === null || typeof input !== "object" || inspected(() => utilTypes.isProxy(input))) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
  if (inspected(() => Array.isArray(input))) {
    return fail("ARTIFACT_SHAPE_INVALID");
  }
  const prototype = inspected(() => Object.getPrototypeOf(input));
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
  if (inspected(() => Object.getOwnPropertySymbols(input)).length > 0) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
  const names = inspected(() => Object.getOwnPropertyNames(input));
  if (names.length !== expected.size || !names.every((name) => expected.has(name))) {
    return fail("ARTIFACT_SHAPE_INVALID");
  }

  const output: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = inspected(() => Object.getOwnPropertyDescriptor(input, name));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return fail("ARTIFACT_INPUT_UNSAFE");
    }
    Object.defineProperty(output, name, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return output;
}

function ownDataArray(input: unknown, maxLength: number): readonly unknown[] {
  if (input === null || typeof input !== "object" || inspected(() => utilTypes.isProxy(input))) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
  if (!inspected(() => Array.isArray(input))) {
    return fail("ARTIFACT_SHAPE_INVALID");
  }
  if (inspected(() => Object.getPrototypeOf(input)) !== Array.prototype) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
  if (inspected(() => Object.getOwnPropertySymbols(input)).length > 0) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
  const lengthDescriptor = inspected(() => Object.getOwnPropertyDescriptor(input, "length"));
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
  const length = lengthDescriptor.value;
  if (length > maxLength) {
    return fail("ARTIFACT_LIMIT_EXCEEDED");
  }

  const names = inspected(() => Object.getOwnPropertyNames(input));
  if (names.length !== length + 1) {
    return fail("ARTIFACT_INPUT_UNSAFE");
  }
  for (const name of names) {
    if (name === "length") continue;
    const index = Number(name);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== name) {
      return fail("ARTIFACT_INPUT_UNSAFE");
    }
  }

  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = inspected(() => Object.getOwnPropertyDescriptor(input, String(index)));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return fail("ARTIFACT_INPUT_UNSAFE");
    }
    output.push(descriptor.value);
  }
  return output;
}

function identifier(value: JsonSafeValue | unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  return value;
}

function fingerprint(value: JsonSafeValue | unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    return fail("ARTIFACT_FINGERPRINT_INVALID");
  }
  return value;
}

function positiveInteger(value: JsonSafeValue | unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  return value;
}

function canonicalTimestamp(value: JsonSafeValue | unknown): string {
  if (typeof value !== "string") {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  if (canonical !== value) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  return value;
}

function boundedLabel(value: JsonSafeValue | unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > BLIND_REVIEW_ARTIFACT_LIMITS.maxLabelBytes
  ) {
    return fail("ARTIFACT_ITEM_INVALID");
  }
  return value;
}

function isBlindAnswerType(value: JsonSafeValue | unknown): value is BlindAnswerType {
  return typeof value === "string" && BLIND_ANSWER_TYPE_SET.has(value);
}

export function isBlindReviewExclusionOnlyFieldType(
  value: string,
): value is (typeof BLIND_REVIEW_EXCLUSION_ONLY_FIELD_TYPES)[number] {
  return EXCLUSION_ONLY_TYPE_SET.has(value);
}

export function isBlindReviewAnswerType(value: string): value is BlindAnswerType {
  return BLIND_ANSWER_TYPE_SET.has(value);
}

function normalizedFieldDefinition(input: JsonSafeValue): FormFieldDefinition {
  if (!isJsonObject(input)) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  const allowed = new Set(["id", "type", "label", "required", "defaultVisibility", "config"]);
  const required = new Set(["id", "type", "label", "required", "defaultVisibility"]);
  if (
    !hasOnlyKeys(input, allowed) ||
    ![...required].every((key) => hasOwn(input, key)) ||
    Object.keys(input).length !== required.size + (hasOwn(input, "config") ? 1 : 0) ||
    !FORM_FIELD_TYPE_SET.has(typeof input.type === "string" ? input.type : "") ||
    typeof input.label !== "string" ||
    input.label.trim().length === 0 ||
    input.label.length > 512 ||
    typeof input.required !== "boolean" ||
    (input.defaultVisibility !== "visible" && input.defaultVisibility !== "hidden")
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  const fieldId = identifier(input.id);
  const type = input.type as FormFieldType;
  return hasOwn(input, "config")
    ? Object.freeze({
        id: fieldId,
        type,
        label: input.label,
        required: input.required,
        defaultVisibility: input.defaultVisibility,
        config: input.config!,
      })
    : Object.freeze({
        id: fieldId,
        type,
        label: input.label,
        required: input.required,
        defaultVisibility: input.defaultVisibility,
      });
}

export function normalizeReviewFieldDefinitionBinding(
  input: unknown,
): ReviewFieldDefinitionBindingV1 {
  const safe = sanitizeJson(input);
  if (
    !isJsonObject(safe) ||
    !hasExactKeys(
      safe,
      new Set([
        "schema",
        "workspaceId",
        "assignmentId",
        "submissionRevisionId",
        "formDocumentSchema",
        "formVersionId",
        "ruleVersionId",
        "formDocumentFingerprint",
        "field",
      ]),
    ) ||
    safe.schema !== CFP_REVIEW_FIELD_DEFINITION_BINDING_SCHEMA ||
    safe.formDocumentSchema !== CFP_FORM_DOCUMENT_SCHEMA
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  return Object.freeze({
    schema: CFP_REVIEW_FIELD_DEFINITION_BINDING_SCHEMA,
    workspaceId: identifier(safe.workspaceId),
    assignmentId: identifier(safe.assignmentId),
    submissionRevisionId: identifier(safe.submissionRevisionId),
    formDocumentSchema: CFP_FORM_DOCUMENT_SCHEMA,
    formVersionId: identifier(safe.formVersionId),
    ruleVersionId: identifier(safe.ruleVersionId),
    formDocumentFingerprint: fingerprint(safe.formDocumentFingerprint),
    field: normalizedFieldDefinition(safe.field!),
  });
}

export const normalizeFieldDefinitionBinding = normalizeReviewFieldDefinitionBinding;

export function fingerprintReviewFieldDefinitionBinding(input: unknown): string {
  return fingerprintOf(normalizeReviewFieldDefinitionBinding(input));
}

export const fingerprintFieldDefinitionBinding = fingerprintReviewFieldDefinitionBinding;
export const fieldDefinitionFingerprint = fingerprintReviewFieldDefinitionBinding;

export function normalizeReviewSourceAnswerBinding(input: unknown): ReviewSourceAnswerBindingV1 {
  const safe = sanitizeJson(input);
  if (
    !isJsonObject(safe) ||
    !hasExactKeys(
      safe,
      new Set([
        "schema",
        "workspaceId",
        "assignmentId",
        "submissionId",
        "submissionRevisionId",
        "submissionRevisionFingerprint",
        "fieldId",
        "fieldDefinitionFingerprint",
        "value",
      ]),
    ) ||
    safe.schema !== CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  return Object.freeze({
    schema: CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA,
    workspaceId: identifier(safe.workspaceId),
    assignmentId: identifier(safe.assignmentId),
    submissionId: identifier(safe.submissionId),
    submissionRevisionId: identifier(safe.submissionRevisionId),
    submissionRevisionFingerprint: fingerprint(safe.submissionRevisionFingerprint),
    fieldId: identifier(safe.fieldId),
    fieldDefinitionFingerprint: fingerprint(safe.fieldDefinitionFingerprint),
    value: safe.value!,
  });
}

export const normalizeSourceAnswerBinding = normalizeReviewSourceAnswerBinding;

export function fingerprintReviewSourceAnswerBinding(input: unknown): string {
  return fingerprintOf(normalizeReviewSourceAnswerBinding(input));
}

export const fingerprintSourceAnswerBinding = fingerprintReviewSourceAnswerBinding;
export const sourceAnswerFingerprint = fingerprintReviewSourceAnswerBinding;

function validateRedactedValue(type: BlindAnswerType, value: JsonSafeValue): void {
  if (value === null || type === "matrix") return;
  if (
    type === "shortText" ||
    type === "longText" ||
    type === "richText" ||
    type === "singleChoice" ||
    type === "date" ||
    type === "time" ||
    type === "dateTime"
  ) {
    if (typeof value !== "string") return fail("ARTIFACT_REDACTED_VALUE_INVALID");
    return;
  }
  if (type === "checkbox") {
    if (typeof value !== "boolean") return fail("ARTIFACT_REDACTED_VALUE_INVALID");
    return;
  }
  if (type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      return fail("ARTIFACT_REDACTED_VALUE_INVALID");
    }
    return;
  }
  if (type === "decimal") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail("ARTIFACT_REDACTED_VALUE_INVALID");
    }
    return;
  }
  if (!Array.isArray(value)) {
    return fail("ARTIFACT_REDACTED_VALUE_INVALID");
  }
  const seen = new Set<string>();
  for (const member of value) {
    if (typeof member !== "string" || member.length === 0 || seen.has(member)) {
      return fail("ARTIFACT_REDACTED_VALUE_INVALID");
    }
    seen.add(member);
  }
}

export function normalizeReviewRedactedValueBinding(
  input: unknown,
): ReviewRedactedValueBindingV1 {
  const safe = sanitizeJson(input);
  if (
    !isJsonObject(safe) ||
    !hasExactKeys(
      safe,
      new Set([
        "schema",
        "workspaceId",
        "assignmentId",
        "submissionRevisionId",
        "sourceAnswerFingerprint",
        "disclosureStage",
        "disposition",
        "answerKey",
        "displayOrder",
        "label",
        "type",
        "value",
      ]),
    ) ||
    safe.schema !== CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA ||
    safe.disclosureStage !== BLIND_REVIEW_DISCLOSURE_STAGE
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }

  const common = {
    schema: CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA,
    workspaceId: identifier(safe.workspaceId),
    assignmentId: identifier(safe.assignmentId),
    submissionRevisionId: identifier(safe.submissionRevisionId),
    sourceAnswerFingerprint: fingerprint(safe.sourceAnswerFingerprint),
    disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
  } as const;

  if (safe.disposition === "EXCLUDE") {
    if (
      safe.answerKey !== null ||
      safe.displayOrder !== null ||
      safe.label !== null ||
      safe.type !== null ||
      safe.value !== null
    ) {
      return fail("ARTIFACT_BINDING_INVALID");
    }
    return Object.freeze({
      ...common,
      disposition: "EXCLUDE",
      answerKey: null,
      displayOrder: null,
      label: null,
      type: null,
      value: null,
    });
  }

  if (
    safe.disposition !== "INCLUDE_REDACTED" ||
    !isBlindAnswerType(safe.type) ||
    typeof safe.displayOrder !== "number" ||
    !Number.isSafeInteger(safe.displayOrder) ||
    safe.displayOrder < 1 ||
    safe.displayOrder > BLIND_REVIEW_ARTIFACT_LIMITS.maxItems
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  const expectedAnswerKey = `answer-${String(safe.displayOrder).padStart(4, "0")}`;
  if (safe.answerKey !== expectedAnswerKey) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  const label = boundedLabel(safe.label);
  validateRedactedValue(safe.type, safe.value!);
  return Object.freeze({
    ...common,
    disposition: "INCLUDE_REDACTED",
    answerKey: expectedAnswerKey,
    displayOrder: safe.displayOrder,
    label,
    type: safe.type,
    value: safe.value!,
  });
}

export const normalizeRedactedValueBinding = normalizeReviewRedactedValueBinding;

export function fingerprintReviewRedactedValueBinding(input: unknown): string {
  return fingerprintOf(normalizeReviewRedactedValueBinding(input));
}

export const fingerprintRedactedValueBinding = fingerprintReviewRedactedValueBinding;
export const redactedValueFingerprint = fingerprintReviewRedactedValueBinding;

function normalizeArtifactItem(
  input: unknown,
  context: {
    readonly workspaceId: string;
    readonly assignmentId: string;
    readonly submissionRevisionId: string;
  },
): BlindArtifactItemV1 {
  const safe = sanitizeJson(input);
  if (
    !isJsonObject(safe) ||
    !hasExactKeys(
      safe,
      new Set([
        "sourceFieldId",
        "fieldDefinitionFingerprint",
        "sourceAnswerFingerprint",
        "redactedValueFingerprint",
        "disposition",
        "answerKey",
        "displayOrder",
        "label",
        "type",
        "value",
      ]),
    )
  ) {
    return fail("ARTIFACT_ITEM_INVALID");
  }
  const sourceFieldId = identifier(safe.sourceFieldId);
  const fieldDefinitionFingerprint = fingerprint(safe.fieldDefinitionFingerprint);
  const sourceAnswerFingerprintValue = fingerprint(safe.sourceAnswerFingerprint);
  const redactedValueFingerprintValue = fingerprint(safe.redactedValueFingerprint);
  const binding = normalizeReviewRedactedValueBinding({
    schema: CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA,
    workspaceId: context.workspaceId,
    assignmentId: context.assignmentId,
    submissionRevisionId: context.submissionRevisionId,
    sourceAnswerFingerprint: sourceAnswerFingerprintValue,
    disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
    disposition: safe.disposition,
    answerKey: safe.answerKey,
    displayOrder: safe.displayOrder,
    label: safe.label,
    type: safe.type,
    value: safe.value,
  });
  if (fingerprintReviewRedactedValueBinding(binding) !== redactedValueFingerprintValue) {
    return fail("ARTIFACT_FINGERPRINT_MISMATCH");
  }

  if (binding.disposition === "EXCLUDE") {
    return Object.freeze<ExcludedBlindArtifactItemV1>({
      sourceFieldId,
      fieldDefinitionFingerprint,
      sourceAnswerFingerprint: sourceAnswerFingerprintValue,
      redactedValueFingerprint: redactedValueFingerprintValue,
      disposition: "EXCLUDE",
      answerKey: null,
      displayOrder: null,
      label: null,
      type: null,
      value: null,
    });
  }
  return Object.freeze<IncludedBlindArtifactItemV1>({
    sourceFieldId,
    fieldDefinitionFingerprint,
    sourceAnswerFingerprint: sourceAnswerFingerprintValue,
    redactedValueFingerprint: redactedValueFingerprintValue,
    disposition: "INCLUDE_REDACTED",
    answerKey: binding.answerKey,
    displayOrder: binding.displayOrder,
    label: binding.label,
    type: binding.type,
    value: binding.value,
  });
}

function measureStructure(value: JsonSafeValue | BlindReviewArtifactV1): number {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > BLIND_REVIEW_ARTIFACT_LIMITS.maxDepth) {
      return fail("ARTIFACT_LIMIT_EXCEEDED");
    }
    nodes += 1;
    if (nodes > BLIND_REVIEW_ARTIFACT_LIMITS.maxNodes) {
      return fail("ARTIFACT_LIMIT_EXCEEDED");
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const member of candidate) visit(member, depth + 1);
      return;
    }
    for (const member of Object.values(candidate)) visit(member, depth + 1);
  };
  visit(value, 0);
  return nodes;
}

function assertArtifactDocumentLimits(document: BlindReviewArtifactV1): void {
  measureStructure(document);
  if (
    Buffer.byteLength(canonicalJson(document), "utf8") >
    BLIND_REVIEW_ARTIFACT_LIMITS.maxSerializedBytes
  ) {
    return fail("ARTIFACT_LIMIT_EXCEEDED");
  }
}

const ARTIFACT_KEYS = new Set([
  "schema",
  "version",
  "workspaceId",
  "assignmentId",
  "assignmentCreatedAt",
  "rubricVersionId",
  "rubricSemanticsId",
  "rubricSemanticsFingerprint",
  "submissionId",
  "submissionRevision",
  "disclosureStage",
  "conflictAtIssuance",
  "attestation",
  "issuer",
  "issuedAt",
  "sourceAnswerCount",
  "items",
]);

function normalizePreflightedBlindReviewArtifact(input: unknown): BlindReviewArtifactV1 {
  const envelope = ownDataRecord(input, ARTIFACT_KEYS);
  if (envelope.schema !== CFP_REVIEW_BLIND_ARTIFACT_SCHEMA || envelope.version !== 1) {
    return fail("ARTIFACT_SCHEMA_UNSUPPORTED");
  }
  if (
    envelope.disclosureStage !== BLIND_REVIEW_DISCLOSURE_STAGE ||
    envelope.attestation !== BLIND_REVIEW_ATTESTATION
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }

  const workspaceId = identifier(envelope.workspaceId);
  const assignmentId = identifier(envelope.assignmentId);
  const submissionRevisionSafe = sanitizeJson(envelope.submissionRevision);
  if (
    !isJsonObject(submissionRevisionSafe) ||
    !hasExactKeys(
      submissionRevisionSafe,
      new Set([
        "id",
        "number",
        "schema",
        "fingerprint",
        "createdAt",
        "formDocumentSchema",
        "formVersionId",
        "ruleVersionId",
        "formDocumentFingerprint",
      ]),
    ) ||
    submissionRevisionSafe.schema !== CFP_SUBMISSION_REVISION_SCHEMA ||
    submissionRevisionSafe.formDocumentSchema !== CFP_FORM_DOCUMENT_SCHEMA
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  const submissionRevision = Object.freeze({
    id: identifier(submissionRevisionSafe.id),
    number: positiveInteger(submissionRevisionSafe.number),
    schema: CFP_SUBMISSION_REVISION_SCHEMA,
    fingerprint: fingerprint(submissionRevisionSafe.fingerprint),
    createdAt: canonicalTimestamp(submissionRevisionSafe.createdAt),
    formDocumentSchema: CFP_FORM_DOCUMENT_SCHEMA,
    formVersionId: identifier(submissionRevisionSafe.formVersionId),
    ruleVersionId: identifier(submissionRevisionSafe.ruleVersionId),
    formDocumentFingerprint: fingerprint(submissionRevisionSafe.formDocumentFingerprint),
  });

  const conflictSafe = sanitizeJson(envelope.conflictAtIssuance);
  if (
    !isJsonObject(conflictSafe) ||
    !hasExactKeys(conflictSafe, new Set(["status", "sequenceNumber"])) ||
    (conflictSafe.status !== "NONE" &&
      conflictSafe.status !== "CLEARED" &&
      conflictSafe.status !== "WAIVED") ||
    typeof conflictSafe.sequenceNumber !== "number" ||
    !Number.isSafeInteger(conflictSafe.sequenceNumber) ||
    conflictSafe.sequenceNumber < 0 ||
    (conflictSafe.status === "NONE" && conflictSafe.sequenceNumber !== 0) ||
    (conflictSafe.status !== "NONE" && conflictSafe.sequenceNumber < 1)
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  const conflictAtIssuance = Object.freeze({
    status: conflictSafe.status,
    sequenceNumber: conflictSafe.sequenceNumber,
  });

  const issuerSafe = sanitizeJson(envelope.issuer);
  if (
    !isJsonObject(issuerSafe) ||
    !hasExactKeys(issuerSafe, new Set(["accountId", "role", "authority"])) ||
    typeof issuerSafe.role !== "string" ||
    !ORGANIZER_ISSUER_ROLES.has(issuerSafe.role) ||
    issuerSafe.authority !== REVIEW_ISSUER_AUTHORITY
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }
  const issuer = Object.freeze({
    accountId: identifier(issuerSafe.accountId),
    role: issuerSafe.role,
    authority: REVIEW_ISSUER_AUTHORITY,
  });

  const rawItems = ownDataArray(envelope.items, BLIND_REVIEW_ARTIFACT_LIMITS.maxItems);
  if (
    typeof envelope.sourceAnswerCount !== "number" ||
    !Number.isSafeInteger(envelope.sourceAnswerCount) ||
    envelope.sourceAnswerCount < 0 ||
    envelope.sourceAnswerCount !== rawItems.length
  ) {
    return fail("ARTIFACT_BINDING_INVALID");
  }

  const items = rawItems.map((candidate) =>
    normalizeArtifactItem(candidate, {
      workspaceId,
      assignmentId,
      submissionRevisionId: submissionRevision.id,
    }),
  );
  const seenSourceFields = new Set<string>();
  for (const item of items) {
    if (seenSourceFields.has(item.sourceFieldId)) {
      return fail("ARTIFACT_ITEM_DUPLICATE");
    }
    seenSourceFields.add(item.sourceFieldId);
  }
  const included = items
    .filter((item): item is IncludedBlindArtifactItemV1 => item.disposition === "INCLUDE_REDACTED")
    .sort((left, right) => left.displayOrder - right.displayOrder);
  for (let index = 0; index < included.length; index += 1) {
    const expectedOrder = index + 1;
    if (
      included[index]!.displayOrder !== expectedOrder ||
      included[index]!.answerKey !== `answer-${String(expectedOrder).padStart(4, "0")}`
    ) {
      return fail("ARTIFACT_ITEM_INVALID");
    }
  }
  const sortedItems = Object.freeze(
    [...items].sort((left, right) => compareFormFieldIds(left.sourceFieldId, right.sourceFieldId)),
  );

  const document = Object.freeze<BlindReviewArtifactV1>({
    schema: CFP_REVIEW_BLIND_ARTIFACT_SCHEMA,
    version: 1,
    workspaceId,
    assignmentId,
    assignmentCreatedAt: canonicalTimestamp(envelope.assignmentCreatedAt),
    rubricVersionId: identifier(envelope.rubricVersionId),
    rubricSemanticsId: identifier(envelope.rubricSemanticsId),
    rubricSemanticsFingerprint: fingerprint(envelope.rubricSemanticsFingerprint),
    submissionId: identifier(envelope.submissionId),
    submissionRevision,
    disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
    conflictAtIssuance,
    attestation: BLIND_REVIEW_ATTESTATION,
    issuer,
    issuedAt: canonicalTimestamp(envelope.issuedAt),
    sourceAnswerCount: rawItems.length,
    items: sortedItems,
  });
  assertArtifactDocumentLimits(document);
  return document;
}

export function normalizeBlindReviewArtifact(input: unknown): BlindReviewArtifactV1 {
  return normalizePreflightedBlindReviewArtifact(preflightRawInput(input));
}

export function canonicalBlindReviewArtifactJson(input: unknown): string {
  return canonicalJson(normalizeBlindReviewArtifact(input));
}

export function parseCanonicalBlindReviewArtifact(serialized: string): BlindReviewArtifactV1 {
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > BLIND_REVIEW_ARTIFACT_LIMITS.maxSerializedBytes
  ) {
    return fail("ARTIFACT_LIMIT_EXCEEDED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return fail("ARTIFACT_CANONICAL_JSON_INVALID");
  }
  const normalized = normalizeBlindReviewArtifact(parsed);
  if (canonicalJson(normalized) !== serialized) {
    return fail("ARTIFACT_CANONICAL_JSON_INVALID");
  }
  return normalized;
}

export function fingerprintBlindReviewArtifact(input: unknown): string {
  return fingerprintOf(normalizeBlindReviewArtifact(input));
}

export const blindReviewArtifactFingerprint = fingerprintBlindReviewArtifact;

export function verifyBlindReviewArtifactFingerprint(input: unknown, expected: unknown): boolean {
  try {
    return fingerprint(expected) === fingerprintBlindReviewArtifact(input);
  } catch {
    return false;
  }
}

const BUILD_INPUT_KEYS = new Set([
  "workspaceId",
  "assignmentId",
  "assignmentCreatedAt",
  "rubricVersionId",
  "rubricSemanticsId",
  "rubricSemanticsFingerprint",
  "submissionId",
  "submissionRevision",
  "disclosureStage",
  "conflictAtIssuance",
  "attestation",
  "issuer",
  "issuedAt",
  "decisions",
]);

function normalizeDecision(input: unknown): BlindFieldDecisionInput & {
  readonly redactedValue?: JsonSafeValue;
} {
  const safe = sanitizeJson(input);
  if (!isJsonObject(safe) || typeof safe.action !== "string") {
    return fail("ARTIFACT_SHAPE_INVALID");
  }
  if (safe.action === "EXCLUDE") {
    if (!hasExactKeys(safe, new Set(["sourceFieldId", "action"]))) {
      return fail("ARTIFACT_SHAPE_INVALID");
    }
    return Object.freeze({ sourceFieldId: identifier(safe.sourceFieldId), action: "EXCLUDE" });
  }
  if (
    safe.action !== "INCLUDE_REDACTED" ||
    !hasExactKeys(safe, new Set(["sourceFieldId", "action", "reviewLabel", "redactedValue"]))
  ) {
    return fail("ARTIFACT_SHAPE_INVALID");
  }
  return Object.freeze({
    sourceFieldId: identifier(safe.sourceFieldId),
    action: "INCLUDE_REDACTED",
    reviewLabel: boundedLabel(safe.reviewLabel),
    redactedValue: safe.redactedValue!,
  });
}

/**
 * Deterministically format the internal canonical artifact from one exact
 * normalized revision. The future persistence-backed caller owns authorization,
 * provenance, and currentness; this formatter derives bindings and applies only
 * explicit organizer redaction decisions, with no text or identity heuristics.
 */
export function createBlindReviewArtifact(input: CreateBlindReviewArtifactInput): BlindReviewArtifactV1 {
  const envelope = ownDataRecord(preflightRawInput(input), BUILD_INPUT_KEYS);
  const revisionEnvelope = ownDataRecord(
    envelope.submissionRevision,
    new Set(["id", "number", "schema", "fingerprint", "createdAt", "formDocument"]),
  );
  const formDocument = normalizeFormDocument(revisionEnvelope.formDocument);
  if (formDocument.schema !== FORM_DOCUMENT_SCHEMA) {
    return fail("ARTIFACT_BINDING_INVALID");
  }

  const rawDecisions = ownDataArray(envelope.decisions, BLIND_REVIEW_ARTIFACT_LIMITS.maxItems);
  const effectiveByFieldId = new Map(
    formDocument.effectiveAnswers.map((answer) => [answer.fieldId, answer] as const),
  );
  const fieldsById = new Map(formDocument.fields.map((field) => [field.id, field] as const));
  const fieldDisplayIndex = new Map(
    formDocument.fields.map((field, index) => [field.id, index] as const),
  );
  const decisionsByFieldId = new Map<string, ReturnType<typeof normalizeDecision>>();
  for (const candidate of rawDecisions) {
    const decision = normalizeDecision(candidate);
    if (decisionsByFieldId.has(decision.sourceFieldId)) {
      return fail("ARTIFACT_DECISION_DUPLICATE");
    }
    if (!effectiveByFieldId.has(decision.sourceFieldId)) {
      return fail("ARTIFACT_DECISION_UNKNOWN");
    }
    decisionsByFieldId.set(decision.sourceFieldId, decision);
  }
  if (decisionsByFieldId.size !== effectiveByFieldId.size) {
    return fail("ARTIFACT_DECISION_MISSING");
  }

  const includedFieldIds = [...decisionsByFieldId.values()]
    .filter((decision) => decision.action === "INCLUDE_REDACTED")
    .map((decision) => decision.sourceFieldId)
    .sort((left, right) => {
      const order = fieldDisplayIndex.get(left)! - fieldDisplayIndex.get(right)!;
      return order === 0 ? compareFormFieldIds(left, right) : order;
    });
  const displayOrderByFieldId = new Map(
    includedFieldIds.map((fieldId, index) => [fieldId, index + 1] as const),
  );

  const workspaceId = identifier(envelope.workspaceId);
  const assignmentId = identifier(envelope.assignmentId);
  const submissionId = identifier(envelope.submissionId);
  const submissionRevisionId = identifier(revisionEnvelope.id);
  const revisionFingerprint = fingerprint(revisionEnvelope.fingerprint);
  const items: BlindArtifactItemV1[] = [];
  for (const answer of formDocument.effectiveAnswers) {
    const field = fieldsById.get(answer.fieldId);
    const decision = decisionsByFieldId.get(answer.fieldId);
    if (!field || !decision) return fail("ARTIFACT_BINDING_INVALID");

    const fieldDefinitionFingerprintValue = fingerprintReviewFieldDefinitionBinding({
      schema: CFP_REVIEW_FIELD_DEFINITION_BINDING_SCHEMA,
      workspaceId,
      assignmentId,
      submissionRevisionId,
      formDocumentSchema: formDocument.schema,
      formVersionId: formDocument.formVersionId,
      ruleVersionId: formDocument.ruleVersionId,
      formDocumentFingerprint: formDocument.fingerprint,
      field,
    });
    const sourceAnswerFingerprintValue = fingerprintReviewSourceAnswerBinding({
      schema: CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA,
      workspaceId,
      assignmentId,
      submissionId,
      submissionRevisionId,
      submissionRevisionFingerprint: revisionFingerprint,
      fieldId: answer.fieldId,
      fieldDefinitionFingerprint: fieldDefinitionFingerprintValue,
      value: answer.value,
    });

    if (decision.action === "EXCLUDE") {
      const redactedBinding = normalizeReviewRedactedValueBinding({
        schema: CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA,
        workspaceId,
        assignmentId,
        submissionRevisionId,
        sourceAnswerFingerprint: sourceAnswerFingerprintValue,
        disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
        disposition: "EXCLUDE",
        answerKey: null,
        displayOrder: null,
        label: null,
        type: null,
        value: null,
      });
      items.push(
        Object.freeze({
          sourceFieldId: answer.fieldId,
          fieldDefinitionFingerprint: fieldDefinitionFingerprintValue,
          sourceAnswerFingerprint: sourceAnswerFingerprintValue,
          redactedValueFingerprint: fingerprintReviewRedactedValueBinding(redactedBinding),
          disposition: "EXCLUDE",
          answerKey: null,
          displayOrder: null,
          label: null,
          type: null,
          value: null,
        }),
      );
      continue;
    }

    if (!isBlindAnswerType(field.type)) {
      return fail("ARTIFACT_STRUCTURAL_INCLUDE_FORBIDDEN");
    }
    const displayOrder = displayOrderByFieldId.get(answer.fieldId);
    if (!displayOrder) return fail("ARTIFACT_BINDING_INVALID");
    const answerKey = `answer-${String(displayOrder).padStart(4, "0")}`;
    const redactedBinding = normalizeReviewRedactedValueBinding({
      schema: CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA,
      workspaceId,
      assignmentId,
      submissionRevisionId,
      sourceAnswerFingerprint: sourceAnswerFingerprintValue,
      disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
      disposition: "INCLUDE_REDACTED",
      answerKey,
      displayOrder,
      label: decision.reviewLabel,
      type: field.type,
      value: decision.redactedValue,
    });
    items.push(
      Object.freeze({
        sourceFieldId: answer.fieldId,
        fieldDefinitionFingerprint: fieldDefinitionFingerprintValue,
        sourceAnswerFingerprint: sourceAnswerFingerprintValue,
        redactedValueFingerprint: fingerprintReviewRedactedValueBinding(redactedBinding),
        disposition: "INCLUDE_REDACTED",
        answerKey,
        displayOrder,
        label: redactedBinding.label!,
        type: redactedBinding.type!,
        value: redactedBinding.value,
      }),
    );
  }

  return normalizePreflightedBlindReviewArtifact({
    schema: CFP_REVIEW_BLIND_ARTIFACT_SCHEMA,
    version: 1,
    workspaceId,
    assignmentId,
    assignmentCreatedAt: envelope.assignmentCreatedAt,
    rubricVersionId: envelope.rubricVersionId,
    rubricSemanticsId: envelope.rubricSemanticsId,
    rubricSemanticsFingerprint: envelope.rubricSemanticsFingerprint,
    submissionId,
    submissionRevision: {
      id: submissionRevisionId,
      number: revisionEnvelope.number,
      schema: revisionEnvelope.schema,
      fingerprint: revisionFingerprint,
      createdAt: revisionEnvelope.createdAt,
      formDocumentSchema: formDocument.schema,
      formVersionId: formDocument.formVersionId,
      ruleVersionId: formDocument.ruleVersionId,
      formDocumentFingerprint: formDocument.fingerprint,
    },
    disclosureStage: envelope.disclosureStage,
    conflictAtIssuance: envelope.conflictAtIssuance,
    attestation: envelope.attestation,
    issuer: envelope.issuer,
    issuedAt: envelope.issuedAt,
    sourceAnswerCount: items.length,
    items,
  });
}

export const buildBlindReviewArtifact = createBlindReviewArtifact;
