import { types as utilTypes } from "node:util";
import {
  compareFormFieldIds,
  FORM_DOCUMENT_LIMITS,
  FORM_FIELD_TYPES,
  type FormAnswer,
  type FormFieldDefinition,
  type FormFieldType,
} from "./form-types";
import {
  DEFAULT_FORM_SAFETY_LIMITS,
  FormSafetyError,
  sanitizeFormData,
  type JsonSafeObject,
  type JsonSafeValue,
} from "./form-safety";
import {
  normalizeCoPresentersFieldConfig,
  normalizeCoPresentersValue,
  type CoPresentersFieldConfig,
} from "../../../cfp/co-presenters";

export const FORM_RULES_SCHEMA = "cfp-form-rules/v1" as const;
export type FormRulesSchema = typeof FORM_RULES_SCHEMA;

export const FORM_RULE_LIMITS = Object.freeze({
  maxRules: 256,
  maxActionsPerRule: 64,
  maxConditionDepth: 16,
  maxConditionNodes: 512,
  maxConditionChildren: 64,
  maxInListCardinality: 64,
  maxIdentifierLength: FORM_DOCUMENT_LIMITS.maxIdentifierLength,
  maxSerializedBytes: 256 * 1024,
  maxContainmentNeedleBytes: 256,
  maxComparisonWork: 8_388_608,
});

export const FORM_COMPARISON_OPERATORS = Object.freeze([
  "equals",
  "notEquals",
  "in",
  "notIn",
  "contains",
  "notContains",
  "lessThan",
  "lessThanOrEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "isEmpty",
  "isNotEmpty",
] as const);

export type FormComparisonOperator = (typeof FORM_COMPARISON_OPERATORS)[number];
export type FormRuleActionType = "show" | "hide" | "enable" | "disable" | "require" | "skip";

export interface FormAllCondition {
  readonly kind: "all";
  readonly conditions: readonly FormCondition[];
}

export interface FormAnyCondition {
  readonly kind: "any";
  readonly conditions: readonly FormCondition[];
}

export interface FormNotCondition {
  readonly kind: "not";
  readonly condition: FormCondition;
}

export interface FormFieldCondition {
  readonly kind: "field";
  readonly fieldId: string;
  readonly operator: FormComparisonOperator;
  readonly value?: JsonSafeValue;
}

export type FormCondition =
  | FormAllCondition
  | FormAnyCondition
  | FormNotCondition
  | FormFieldCondition;

export interface FormRuleAction {
  readonly type: FormRuleActionType;
  readonly targetFieldId: string;
}

export interface FormRule {
  readonly id: string;
  readonly condition: FormCondition;
  readonly actions: readonly FormRuleAction[];
}

export interface FormRuleSet {
  readonly schema: FormRulesSchema;
  readonly ruleVersionId: string;
  readonly rules: readonly FormRule[];
}

export interface FormFieldState {
  readonly fieldId: string;
  readonly visible: boolean;
  readonly effective: boolean;
  readonly editable: boolean;
  readonly required: boolean;
  readonly skipped: boolean;
}

export interface FormEvaluationInput {
  readonly fields: unknown;
  readonly historicalAnswers: unknown;
  readonly ruleSet: unknown;
}

export interface FormEvaluationResult {
  readonly schema: FormRulesSchema;
  readonly ruleVersionId: string;
  readonly fieldStates: readonly FormFieldState[];
  readonly hiddenFieldIds: readonly string[];
  readonly disabledFieldIds: readonly string[];
  readonly requiredFieldIds: readonly string[];
  readonly skippedFieldIds: readonly string[];
  readonly effectiveAnswers: readonly FormAnswer[];
}

const FORM_EVALUATION_ERROR_MESSAGES = {
  FORM_INPUT_UNSAFE: "The form evaluator rejected unsafe input.",
  FORM_INPUT_SHAPE_INVALID: "The form evaluator input has an invalid structure.",
  FORM_RULES_SCHEMA_UNSUPPORTED: "The form rules schema is not supported.",
  FORM_RULE_SET_INVALID: "The form rule set is invalid.",
  FORM_RULE_LIMIT_EXCEEDED: "The form rule set exceeds a structural limit.",
  FORM_RULE_VERSION_ID_INVALID: "The form rule version identifier is invalid.",
  FORM_RULE_INVALID: "A form rule is invalid.",
  FORM_RULE_DUPLICATE: "A form rule identifier is duplicated.",
  FORM_RULE_ACTION_INVALID: "A form rule action is invalid.",
  FORM_RULE_TARGET_UNKNOWN: "A form rule action targets an unknown field.",
  FORM_RULE_CONDITION_INVALID: "A form rule condition is invalid.",
  FORM_RULE_CONDITION_LIMIT_EXCEEDED: "A form rule condition exceeds a structural limit.",
  FORM_RULE_OPERATOR_INVALID: "A form rule comparison operator is invalid.",
  FORM_RULE_VALUE_INVALID: "A form rule comparison value is invalid.",
  FORM_FIELD_INVALID: "A form field is invalid.",
  FORM_FIELD_DUPLICATE: "A form field identifier is duplicated.",
  FORM_FIELD_TYPE_INVALID: "A form field type is invalid.",
  FORM_FIELD_REFERENCE_UNKNOWN: "A form condition references an unknown field.",
  FORM_FIELD_REFERENCE_SELF: "A form condition references its target field.",
  FORM_FIELD_REFERENCE_FORWARD: "A form condition references a later field.",
  FORM_FIELD_DEPENDENCY_CYCLE: "The form rule dependencies contain a cycle.",
  FORM_HISTORICAL_ANSWER_INVALID: "A historical form answer is invalid.",
  FORM_HISTORICAL_ANSWER_DUPLICATE: "A historical form answer is duplicated.",
  FORM_HISTORICAL_ANSWER_FIELD_UNKNOWN: "A historical answer references an unknown field.",
  FORM_HISTORICAL_ANSWER_FIELD_CONTAINER: "A historical answer references a container field.",
  FORM_HISTORICAL_ANSWER_VALUE_INVALID: "A historical form answer value is invalid.",
  FORM_RULE_ACTION_CONFLICT: "Matched form rules demand conflicting actions.",
  FORM_RULE_WORK_LIMIT_EXCEEDED: "The form evaluator exceeded its comparison work budget.",
} as const;

export type FormEvaluationErrorCode = keyof typeof FORM_EVALUATION_ERROR_MESSAGES;

export class FormEvaluationError extends Error {
  readonly code: FormEvaluationErrorCode;

  constructor(code: FormEvaluationErrorCode) {
    super(FORM_EVALUATION_ERROR_MESSAGES[code]);
    this.name = "FormEvaluationError";
    this.code = code;
  }
}

export { FormEvaluationError as FormEvaluatorError };

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FORM_FIELD_TYPES);
const CONTAINER_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set(["section", "repeatableGroup"]);
const UNSUPPORTED_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set([
  "address",
  "location",
  "fileUpload",
  "matrix",
  "calculated",
]);
const OPERATOR_SET: ReadonlySet<string> = new Set(FORM_COMPARISON_OPERATORS);
const ACTION_TYPE_SET: ReadonlySet<string> = new Set(["show", "hide", "enable", "disable", "require", "skip"]);

const TEXT_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set([
  "shortText",
  "longText",
  "richText",
  "singleChoice",
  "date",
  "time",
  "dateTime",
  "email",
  "phone",
  "url",
  "fileLink",
  "personReference",
  "proposalOwnerReference",
  "coSpeakerReference",
]);

const BOOLEAN_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set([
  "checkbox",
  "consent",
  "acknowledgement",
  "policyAcceptance",
]);

const STRING_ARRAY_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set([
  "multipleChoice",
  "ranking",
]);

const RULE_SAFETY_LIMITS = Object.freeze({
  maxDepth: 32,
  maxStringBytes: 64 * 1024,
  maxArrayLength: FORM_RULE_LIMITS.maxRules,
  maxObjectKeys: 32,
  maxKeyBytes: FORM_DOCUMENT_LIMITS.maxIdentifierLength,
  maxNodes: 8_192,
  maxSerializedBytes: FORM_RULE_LIMITS.maxSerializedBytes,
});

const HOSTILE_SHAPE_PREFLIGHT_LIMITS = Object.freeze({
  maxNodes: DEFAULT_FORM_SAFETY_LIMITS.maxNodes * 2,
  maxDescriptors: DEFAULT_FORM_SAFETY_LIMITS.maxNodes * 4,
});
const PREFLIGHT_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const PREFLIGHT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

interface HostileShapePreflightState {
  readonly active: WeakSet<object>;
  nodes: number;
  descriptors: number;
}

interface HostileShapePreflightFrame {
  readonly value: object;
  readonly children: readonly unknown[];
  nextChild: number;
}

class HostileShapePreflightLimitError extends Error {
  readonly kind = "preflight-limit" as const;

  constructor() {
    super("The hostile-shape preflight reached its private inspection capacity.");
    this.name = "HostileShapePreflightLimitError";
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isSafePreflightKey(key: string): boolean {
  return (
    key.length > 0 &&
    !PREFLIGHT_FORBIDDEN_KEYS.has(key) &&
    !PREFLIGHT_CONTROL_CHARACTER_PATTERN.test(key) &&
    !hasLoneSurrogate(key) &&
    Buffer.byteLength(key, "utf8") <= DEFAULT_FORM_SAFETY_LIMITS.maxKeyBytes
  );
}

function reservePreflightDescriptors(
  state: HostileShapePreflightState,
  count: number,
): void {
  if (count > HOSTILE_SHAPE_PREFLIGHT_LIMITS.maxDescriptors - state.descriptors) {
    throw new HostileShapePreflightLimitError();
  }
  state.descriptors += count;
}

function inspectHostileShape(value: unknown, state: HostileShapePreflightState): void {
  const stack: HostileShapePreflightFrame[] = [];
  let nextValue: unknown = value;
  let hasNextValue = true;

  while (hasNextValue || stack.length > 0) {
    if (hasNextValue) {
      if (state.nodes >= HOSTILE_SHAPE_PREFLIGHT_LIMITS.maxNodes) {
        throw new HostileShapePreflightLimitError();
      }
      state.nodes += 1;
      hasNextValue = false;

      if (nextValue === null || typeof nextValue === "boolean") {
        nextValue = undefined;
      } else if (typeof nextValue === "number") {
        if (!Number.isFinite(nextValue)) {
          throw new FormEvaluationError("FORM_INPUT_UNSAFE");
        }
        nextValue = undefined;
      } else if (typeof nextValue === "string") {
        if (hasLoneSurrogate(nextValue)) {
          throw new FormEvaluationError("FORM_INPUT_UNSAFE");
        }
        nextValue = undefined;
      } else {
        if (typeof nextValue !== "object") {
          throw new FormEvaluationError("FORM_INPUT_UNSAFE");
        }
        if (utilTypes.isProxy(nextValue) || state.active.has(nextValue)) {
          throw new FormEvaluationError("FORM_INPUT_UNSAFE");
        }

        state.active.add(nextValue);
        const prototype = Object.getPrototypeOf(nextValue);
        const isArray = Array.isArray(nextValue);
        if (
          (isArray && prototype !== Array.prototype) ||
          (!isArray && prototype !== Object.prototype && prototype !== null)
        ) {
          throw new FormEvaluationError("FORM_INPUT_UNSAFE");
        }
        if (Object.getOwnPropertySymbols(nextValue).length > 0) {
          throw new FormEvaluationError("FORM_INPUT_UNSAFE");
        }

        const propertyNames = Object.getOwnPropertyNames(nextValue);
        reservePreflightDescriptors(state, propertyNames.length);

        let children: unknown[];
        if (isArray) {
          const indexValues = new Map<number, unknown>();
          const lengthDescriptor = Object.getOwnPropertyDescriptor(nextValue, "length");
          if (
            !lengthDescriptor ||
            !("value" in lengthDescriptor) ||
            !Number.isSafeInteger(lengthDescriptor.value) ||
            lengthDescriptor.value < 0
          ) {
            throw new FormEvaluationError("FORM_INPUT_UNSAFE");
          }
          const arrayLength = lengthDescriptor.value;
          if (arrayLength > HOSTILE_SHAPE_PREFLIGHT_LIMITS.maxNodes) {
            throw new HostileShapePreflightLimitError();
          }
          for (let propertyIndex = 0; propertyIndex < propertyNames.length; propertyIndex += 1) {
            const propertyName = propertyNames[propertyIndex]!;
            const descriptor = Object.getOwnPropertyDescriptor(nextValue, propertyName);
            if (!descriptor || !("value" in descriptor)) {
              throw new FormEvaluationError("FORM_INPUT_UNSAFE");
            }
            if (propertyName === "length") {
              if (descriptor.value !== arrayLength) {
                throw new FormEvaluationError("FORM_INPUT_UNSAFE");
              }
              continue;
            }

            const numericIndex = Number(propertyName);
            if (
              !Number.isSafeInteger(numericIndex) ||
              numericIndex < 0 ||
              numericIndex >= arrayLength ||
              String(numericIndex) !== propertyName ||
              descriptor.enumerable !== true
            ) {
              throw new FormEvaluationError("FORM_INPUT_UNSAFE");
            }
            indexValues.set(numericIndex, descriptor.value);
          }
          if (indexValues.size !== arrayLength) {
            throw new FormEvaluationError("FORM_INPUT_UNSAFE");
          }
          children = new Array<unknown>(arrayLength);
          for (let index = 0; index < arrayLength; index += 1) {
            children[index] = indexValues.get(index);
          }
        } else {
          children = new Array<unknown>(propertyNames.length);
          for (let propertyIndex = 0; propertyIndex < propertyNames.length; propertyIndex += 1) {
            const propertyName = propertyNames[propertyIndex]!;
            if (!isSafePreflightKey(propertyName)) {
              throw new FormEvaluationError("FORM_INPUT_UNSAFE");
            }
            const descriptor = Object.getOwnPropertyDescriptor(nextValue, propertyName);
            if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
              throw new FormEvaluationError("FORM_INPUT_UNSAFE");
            }
            children[propertyIndex] = descriptor.value;
          }
        }

        stack.push({ value: nextValue, children, nextChild: 0 });
      }
    }

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.nextChild < frame.children.length) {
        nextValue = frame.children[frame.nextChild]!;
        frame.nextChild += 1;
        hasNextValue = true;
        break;
      }
      state.active.delete(frame.value);
      stack.pop();
    }
  }
}

function preflightHostileShape(input: unknown): void {
  try {
    inspectHostileShape(input, {
      active: new WeakSet<object>(),
      nodes: 0,
      descriptors: 0,
    });
  } catch (error) {
    if (error instanceof HostileShapePreflightLimitError) {
      throw error;
    }
    if (error instanceof FormEvaluationError) {
      throw error;
    }
    throw new FormEvaluationError("FORM_INPUT_UNSAFE");
  }
}

function deepFreeze<T>(val: T): T {
  if (val === null || typeof val !== "object") {
    return val;
  }
  if (Object.isFrozen(val)) {
    return val;
  }
  Object.freeze(val);
  if (Array.isArray(val)) {
    for (const item of val) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(val)) {
      deepFreeze((val as Record<string, unknown>)[key]);
    }
  }
  return val;
}

function safeSanitizeGeneral(input: unknown): JsonSafeValue {
  try {
    return sanitizeFormData(input);
  } catch (error) {
    if (error instanceof FormSafetyError) {
      throw new FormEvaluationError("FORM_INPUT_UNSAFE");
    }
    throw error;
  }
}

function safeSanitizeRuleSet(input: unknown): JsonSafeValue {
  try {
    preflightHostileShape(input);
  } catch (error) {
    if (error instanceof HostileShapePreflightLimitError) {
      throw new FormEvaluationError("FORM_RULE_LIMIT_EXCEEDED");
    }
    throw error;
  }
  try {
    return sanitizeFormData(input, RULE_SAFETY_LIMITS);
  } catch (error) {
    if (error instanceof FormSafetyError) {
      if (
        error.code === "DEPTH_LIMIT" ||
        error.code === "STRING_LIMIT" ||
        error.code === "ARRAY_LIMIT" ||
        error.code === "OBJECT_LIMIT" ||
        error.code === "NODE_LIMIT" ||
        error.code === "SERIALIZED_SIZE_LIMIT"
      ) {
        throw new FormEvaluationError("FORM_RULE_LIMIT_EXCEEDED");
      }
      throw new FormEvaluationError("FORM_INPUT_UNSAFE");
    }
    throw error;
  }
}

interface SafeEvaluationInputParts {
  readonly inputWithoutRuleSet: Record<string, unknown>;
  readonly ruleSet: unknown;
}

interface SanitizedSafetyUsage {
  readonly nodes: number;
  readonly serializedBytes: number;
}

function measureSanitizedSafetyUsage(value: JsonSafeValue): SanitizedSafetyUsage {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return {
      nodes: 1,
      serializedBytes: Buffer.byteLength(serialized ?? "", "utf8"),
    };
  }

  if (Array.isArray(value)) {
    let nodes = 1;
    let serializedBytes = 2 + Math.max(0, value.length - 1);
    for (const item of value) {
      const usage = measureSanitizedSafetyUsage(item);
      nodes += usage.nodes;
      serializedBytes += usage.serializedBytes;
    }
    return { nodes, serializedBytes };
  }

  const objectValue = value as JsonSafeObject;
  let nodes = 1;
  let serializedBytes = 2 + Math.max(0, Object.keys(objectValue).length - 1);
  for (const key of Object.keys(objectValue)) {
    const serializedKey = JSON.stringify(key);
    serializedBytes += Buffer.byteLength(serializedKey ?? "", "utf8") + 1;
    const usage = measureSanitizedSafetyUsage(objectValue[key]!);
    nodes += usage.nodes;
    serializedBytes += usage.serializedBytes;
  }
  return { nodes, serializedBytes };
}

function getSafeEvaluationInputParts(input: unknown): SafeEvaluationInputParts | undefined {
  try {
    if (utilTypes.isProxy(input)) {
      return undefined;
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    if (Object.getOwnPropertySymbols(input).length > 0) {
      return undefined;
    }

    const inputWithoutRuleSet = Object.create(null) as Record<string, unknown>;
    let ruleSet: unknown;
    let hasRuleSet = false;

    for (const key of Object.getOwnPropertyNames(input)) {
      const desc = Object.getOwnPropertyDescriptor(input, key);
      if (!desc || !desc.enumerable || !("value" in desc)) {
        return undefined;
      }
      if (key === "ruleSet") {
        ruleSet = desc.value;
        hasRuleSet = true;
      }
      Object.defineProperty(inputWithoutRuleSet, key, {
        configurable: true,
        enumerable: true,
        value: key === "ruleSet" ? null : desc.value,
        writable: true,
      });
    }

    if (hasRuleSet) {
      return { inputWithoutRuleSet, ruleSet };
    }
  } catch {
    // Non-reflective catch
  }
  return undefined;
}

function safeSanitizeEvaluationInput(input: unknown): JsonSafeValue {
  try {
    preflightHostileShape(input);
  } catch (error) {
    if (error instanceof HostileShapePreflightLimitError) {
      throw new FormEvaluationError("FORM_INPUT_UNSAFE");
    }
    throw error;
  }
  try {
    return sanitizeFormData(input);
  } catch (error) {
    if (
      error instanceof FormSafetyError &&
      (error.code === "DEPTH_LIMIT" ||
        error.code === "STRING_LIMIT" ||
        error.code === "ARRAY_LIMIT" ||
        error.code === "OBJECT_LIMIT" ||
        error.code === "NODE_LIMIT" ||
        error.code === "SERIALIZED_SIZE_LIMIT")
    ) {
      if (error.code === "NODE_LIMIT" || error.code === "SERIALIZED_SIZE_LIMIT") {
        throw new FormEvaluationError("FORM_INPUT_UNSAFE");
      }
      const parts = getSafeEvaluationInputParts(input);
      if (parts) {
        // Keep complete-input limits for fields/history while the rule set uses its own boundary.
        const safeInputWithoutRuleSet = safeSanitizeGeneral(parts.inputWithoutRuleSet);
        const safeRuleSet = safeSanitizeRuleSet(parts.ruleSet);

        if (error.code === "DEPTH_LIMIT" && isObject(safeInputWithoutRuleSet)) {
          const detachedInput: Record<string, JsonSafeValue> = {};
          for (const key of Object.keys(safeInputWithoutRuleSet)) {
            Object.defineProperty(detachedInput, key, {
              configurable: true,
              enumerable: true,
              value: key === "ruleSet" ? safeRuleSet : safeInputWithoutRuleSet[key],
              writable: true,
            });
          }
          const frozenInput = Object.freeze(detachedInput);
          const usage = measureSanitizedSafetyUsage(frozenInput);
          if (
            usage.nodes <= DEFAULT_FORM_SAFETY_LIMITS.maxNodes &&
            usage.serializedBytes <= DEFAULT_FORM_SAFETY_LIMITS.maxSerializedBytes
          ) {
            return frozenInput;
          }
          throw new FormEvaluationError("FORM_INPUT_UNSAFE");
        }
      }
    }

    if (error instanceof FormSafetyError) {
      throw new FormEvaluationError("FORM_INPUT_UNSAFE");
    }
    throw error;
  }
}

function isObject(val: JsonSafeValue): val is JsonSafeObject {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function hasOwn(obj: JsonSafeObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasOnlyKeys(obj: JsonSafeObject, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

function isIdentifier(val: JsonSafeValue | undefined): val is string {
  return (
    typeof val === "string" &&
    val.length <= FORM_DOCUMENT_LIMITS.maxIdentifierLength &&
    IDENTIFIER_PATTERN.test(val)
  );
}

function parseFields(
  inputFields: JsonSafeValue,
  isNormalizer: boolean = false,
): {
  readonly fields: readonly FormFieldDefinition[];
  readonly fieldsById: ReadonlyMap<string, FormFieldDefinition>;
  readonly fieldIndexById: ReadonlyMap<string, number>;
} {
  if (!Array.isArray(inputFields)) {
    throw new FormEvaluationError(
      isNormalizer ? "FORM_FIELD_INVALID" : "FORM_INPUT_SHAPE_INVALID",
    );
  }
  if (inputFields.length > FORM_DOCUMENT_LIMITS.maxFields) {
    throw new FormEvaluationError("FORM_RULE_LIMIT_EXCEEDED");
  }

  const allowedKeys = new Set(["id", "type", "label", "required", "defaultVisibility", "config"]);
  const seen = new Set<string>();
  const fields: FormFieldDefinition[] = [];
  const fieldsById = new Map<string, FormFieldDefinition>();
  const fieldIndexById = new Map<string, number>();

  for (let idx = 0; idx < inputFields.length; idx += 1) {
    const candidate = inputFields[idx];
    if (!isObject(candidate) || !hasOnlyKeys(candidate, allowedKeys)) {
      throw new FormEvaluationError("FORM_FIELD_INVALID");
    }
    if (typeof candidate.type !== "string") {
      throw new FormEvaluationError("FORM_FIELD_INVALID");
    }
    if (!FIELD_TYPE_SET.has(candidate.type)) {
      throw new FormEvaluationError("FORM_FIELD_TYPE_INVALID");
    }
    if (
      !isIdentifier(candidate.id) ||
      typeof candidate.label !== "string" ||
      candidate.label.trim().length === 0 ||
      candidate.label.length > FORM_DOCUMENT_LIMITS.maxLabelLength ||
      typeof candidate.required !== "boolean" ||
      (candidate.defaultVisibility !== "visible" && candidate.defaultVisibility !== "hidden")
    ) {
      throw new FormEvaluationError("FORM_FIELD_INVALID");
    }
    if (seen.has(candidate.id)) {
      throw new FormEvaluationError("FORM_FIELD_DUPLICATE");
    }
    seen.add(candidate.id);

    let config: JsonSafeValue | undefined;
    if (hasOwn(candidate, "config")) {
      try {
        const coPresentersConfig = normalizeCoPresentersFieldConfig(candidate.config, candidate.type);
        config = (coPresentersConfig ?? candidate.config) as JsonSafeValue;
      } catch {
        throw new FormEvaluationError("FORM_FIELD_INVALID");
      }
    }

    const field: FormFieldDefinition = Object.freeze({
      id: candidate.id,
      type: candidate.type as FormFieldType,
      label: candidate.label,
      required: candidate.required,
      defaultVisibility: candidate.defaultVisibility,
      ...(config !== undefined ? { config } : {}),
    });

    fields.push(field);
    fieldsById.set(field.id, field);
    fieldIndexById.set(field.id, idx);
  }

  return { fields: Object.freeze(fields), fieldsById, fieldIndexById };
}

function validateAndNormalizeAnswerValue(
  field: FormFieldDefinition,
  value: JsonSafeValue,
  byteCache?: ByteLengthCache,
): JsonSafeValue {
  let coPresentersConfig: CoPresentersFieldConfig | null;
  try {
    coPresentersConfig = normalizeCoPresentersFieldConfig(field.config, field.type);
  } catch {
    throw new FormEvaluationError("FORM_FIELD_INVALID");
  }
  if (coPresentersConfig) {
    try {
      return normalizeCoPresentersValue(value, coPresentersConfig) as JsonSafeValue;
    } catch {
      throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_VALUE_INVALID");
    }
  }

  const fieldType = field.type;
  if (CONTAINER_FIELD_TYPES.has(fieldType)) {
    throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_FIELD_CONTAINER");
  }

  if (TEXT_FIELD_TYPES.has(fieldType)) {
    if (value !== null && typeof value !== "string") {
      throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_VALUE_INVALID");
    }
    if (typeof value === "string" && byteCache) {
      byteCache.get(value);
    }
    return value;
  }

  if (BOOLEAN_FIELD_TYPES.has(fieldType)) {
    if (value !== null && typeof value !== "boolean") {
      throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_VALUE_INVALID");
    }
    return value;
  }

  if (fieldType === "integer") {
    if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
      throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_VALUE_INVALID");
    }
    return value;
  }

  if (fieldType === "decimal") {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_VALUE_INVALID");
    }
    if (typeof value === "number" && Object.is(value, -0)) {
      return 0;
    }
    return value;
  }

  if (STRING_ARRAY_FIELD_TYPES.has(fieldType)) {
    if (value !== null) {
      if (!Array.isArray(value)) {
        throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_VALUE_INVALID");
      }
      const seenElem = new Set<string>();
      for (const elem of value) {
        if (typeof elem !== "string" || elem.length === 0) {
          throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_VALUE_INVALID");
        }
        if (seenElem.has(elem)) {
          throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_VALUE_INVALID");
        }
        seenElem.add(elem);
        if (byteCache) {
          byteCache.get(elem);
        }
      }
    }
    return value;
  }

  if (UNSUPPORTED_FIELD_TYPES.has(fieldType)) {
    return value;
  }

  throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_VALUE_INVALID");
}

function parseHistoricalAnswers(
  inputAnswers: JsonSafeValue,
  fieldsById: ReadonlyMap<string, FormFieldDefinition>,
  byteCache?: ByteLengthCache,
): {
  readonly answers: readonly FormAnswer[];
  readonly answersByFieldId: ReadonlyMap<string, FormAnswer>;
} {
  if (!Array.isArray(inputAnswers)) {
    throw new FormEvaluationError("FORM_INPUT_SHAPE_INVALID");
  }
  if (inputAnswers.length > FORM_DOCUMENT_LIMITS.maxAnswers) {
    throw new FormEvaluationError("FORM_RULE_LIMIT_EXCEEDED");
  }

  const allowedKeys = new Set(["fieldId", "value"]);
  const seen = new Set<string>();
  const answers: FormAnswer[] = [];
  const answersByFieldId = new Map<string, FormAnswer>();

  for (const candidate of inputAnswers) {
    if (
      !isObject(candidate) ||
      !hasOnlyKeys(candidate, allowedKeys) ||
      !isIdentifier(candidate.fieldId) ||
      !hasOwn(candidate, "value")
    ) {
      throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_INVALID");
    }
    if (seen.has(candidate.fieldId)) {
      throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_DUPLICATE");
    }
    seen.add(candidate.fieldId);

    const field = fieldsById.get(candidate.fieldId);
    if (!field) {
      throw new FormEvaluationError("FORM_HISTORICAL_ANSWER_FIELD_UNKNOWN");
    }

    const normalizedValue = validateAndNormalizeAnswerValue(field, candidate.value, byteCache);
    const answer: FormAnswer = Object.freeze({
      fieldId: candidate.fieldId,
      value: normalizedValue,
    });
    answers.push(answer);
    answersByFieldId.set(field.id, answer);
  }

  return { answers: Object.freeze(answers), answersByFieldId };
}

function validateScalarValueForField(
  fieldType: FormFieldType,
  val: JsonSafeValue,
  byteCache?: ByteLengthCache,
): void {
  if (val === null) {
    return;
  }
  if (TEXT_FIELD_TYPES.has(fieldType)) {
    if (typeof val !== "string") {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    byteCache?.get(val);
    return;
  }
  if (BOOLEAN_FIELD_TYPES.has(fieldType)) {
    if (typeof val !== "boolean") {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    return;
  }
  if (fieldType === "integer") {
    if (typeof val !== "number" || !Number.isSafeInteger(val)) {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    return;
  }
  if (fieldType === "decimal") {
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    return;
  }
  throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
}

function validateOperatorAndOperand(
  fieldType: FormFieldType,
  operator: FormComparisonOperator,
  operand: JsonSafeValue | undefined,
  byteCache?: ByteLengthCache,
): void {
  if (operator === "isEmpty" || operator === "isNotEmpty") {
    if (operand !== undefined) {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    return;
  }

  if (operand === undefined) {
    throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
  }

  if (
    operator === "lessThan" ||
    operator === "lessThanOrEqual" ||
    operator === "greaterThan" ||
    operator === "greaterThanOrEqual"
  ) {
    if (fieldType === "integer") {
      if (typeof operand !== "number" || !Number.isSafeInteger(operand)) {
        throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
      }
      return;
    }
    if (fieldType === "decimal") {
      if (typeof operand !== "number" || !Number.isFinite(operand)) {
        throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
      }
      return;
    }
    throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
  }

  if (operator === "contains" || operator === "notContains") {
    if (!TEXT_FIELD_TYPES.has(fieldType) && !STRING_ARRAY_FIELD_TYPES.has(fieldType)) {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    if (typeof operand !== "string" || operand.length === 0) {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    const needleBytes = byteCache?.get(operand) ?? Buffer.byteLength(operand, "utf8");
    if (needleBytes > FORM_RULE_LIMITS.maxContainmentNeedleBytes) {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    return;
  }

  if (operator === "in" || operator === "notIn") {
    if (STRING_ARRAY_FIELD_TYPES.has(fieldType)) {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    if (!Array.isArray(operand) || operand.length === 0 || operand.length > FORM_RULE_LIMITS.maxInListCardinality) {
      throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
    }
    for (const elem of operand) {
      validateScalarValueForField(fieldType, elem, byteCache);
    }
    return;
  }

  if (operator === "equals" || operator === "notEquals") {
    if (STRING_ARRAY_FIELD_TYPES.has(fieldType)) {
      if (operand !== null) {
        if (!Array.isArray(operand)) {
          throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
        }
        const seenElem = new Set<string>();
        for (const elem of operand) {
          if (typeof elem !== "string" || elem.length === 0) {
            throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
          }
          if (seenElem.has(elem)) {
            throw new FormEvaluationError("FORM_RULE_VALUE_INVALID");
          }
          seenElem.add(elem);
          byteCache?.get(elem);
        }
      }
      return;
    }
    validateScalarValueForField(fieldType, operand, byteCache);
    return;
  }

  throw new FormEvaluationError("FORM_RULE_OPERATOR_INVALID");
}

function validateConditionNode(
  condition: JsonSafeValue,
  depth: number,
  state: { nodeCount: number },
  fieldsById: ReadonlyMap<string, FormFieldDefinition>,
  referencedFields: Set<string>,
  byteCache?: ByteLengthCache,
): FormCondition {
  state.nodeCount += 1;
  if (state.nodeCount > FORM_RULE_LIMITS.maxConditionNodes) {
    throw new FormEvaluationError("FORM_RULE_CONDITION_LIMIT_EXCEEDED");
  }
  if (depth > FORM_RULE_LIMITS.maxConditionDepth) {
    throw new FormEvaluationError("FORM_RULE_CONDITION_LIMIT_EXCEEDED");
  }
  if (!isObject(condition) || typeof condition.kind !== "string") {
    throw new FormEvaluationError("FORM_RULE_CONDITION_INVALID");
  }

  if (condition.kind === "all" || condition.kind === "any") {
    if (!hasOnlyKeys(condition, new Set(["kind", "conditions"]))) {
      throw new FormEvaluationError("FORM_RULE_CONDITION_INVALID");
    }
    if (!Array.isArray(condition.conditions)) {
      throw new FormEvaluationError("FORM_RULE_CONDITION_INVALID");
    }
    if (condition.conditions.length === 0) {
      throw new FormEvaluationError("FORM_RULE_CONDITION_INVALID");
    }
    if (condition.conditions.length > FORM_RULE_LIMITS.maxConditionChildren) {
      throw new FormEvaluationError("FORM_RULE_CONDITION_LIMIT_EXCEEDED");
    }
    const children: FormCondition[] = [];
    for (const child of condition.conditions) {
      children.push(validateConditionNode(child, depth + 1, state, fieldsById, referencedFields, byteCache));
    }
    return Object.freeze({
      kind: condition.kind,
      conditions: Object.freeze(children),
    });
  }

  if (condition.kind === "not") {
    if (!hasOnlyKeys(condition, new Set(["kind", "condition"]))) {
      throw new FormEvaluationError("FORM_RULE_CONDITION_INVALID");
    }
    const child = validateConditionNode(
      condition.condition as JsonSafeValue,
      depth + 1,
      state,
      fieldsById,
      referencedFields,
      byteCache,
    );
    return Object.freeze({
      kind: "not",
      condition: child,
    });
  }

  if (condition.kind === "field") {
    const allowedKeys = hasOwn(condition, "value")
      ? new Set(["kind", "fieldId", "operator", "value"])
      : new Set(["kind", "fieldId", "operator"]);
    if (!hasOnlyKeys(condition, allowedKeys)) {
      throw new FormEvaluationError("FORM_RULE_CONDITION_INVALID");
    }
    if (!isIdentifier(condition.fieldId)) {
      throw new FormEvaluationError("FORM_FIELD_REFERENCE_UNKNOWN");
    }
    const field = fieldsById.get(condition.fieldId);
    if (!field) {
      throw new FormEvaluationError("FORM_FIELD_REFERENCE_UNKNOWN");
    }
    try {
      if (normalizeCoPresentersFieldConfig(field.config, field.type)) {
        throw new FormEvaluationError("FORM_RULE_CONDITION_INVALID");
      }
    } catch (error) {
      if (error instanceof FormEvaluationError) throw error;
      throw new FormEvaluationError("FORM_FIELD_INVALID");
    }
    if (CONTAINER_FIELD_TYPES.has(field.type) || UNSUPPORTED_FIELD_TYPES.has(field.type)) {
      throw new FormEvaluationError("FORM_RULE_CONDITION_INVALID");
    }
    referencedFields.add(field.id);

    if (typeof condition.operator !== "string" || !OPERATOR_SET.has(condition.operator)) {
      throw new FormEvaluationError("FORM_RULE_OPERATOR_INVALID");
    }
    const operator = condition.operator as FormComparisonOperator;
    const valueOperand = condition.value;

    validateOperatorAndOperand(field.type, operator, valueOperand, byteCache);

    const normalizedValue =
      typeof valueOperand === "number" && Object.is(valueOperand, -0) ? 0 : valueOperand;

    return Object.freeze({
      kind: "field",
      fieldId: field.id,
      operator,
      ...(normalizedValue !== undefined ? { value: normalizedValue } : {}),
    });
  }

  throw new FormEvaluationError("FORM_RULE_CONDITION_INVALID");
}

function parseRuleSetInternal(
  inputRuleSet: JsonSafeValue,
  fieldsById: ReadonlyMap<string, FormFieldDefinition>,
  fieldIndexById: ReadonlyMap<string, number>,
  byteCache?: ByteLengthCache,
): FormRuleSet {
  if (!isObject(inputRuleSet)) {
    throw new FormEvaluationError("FORM_RULE_SET_INVALID");
  }
  const allowedTopKeys = new Set(["schema", "ruleVersionId", "rules"]);
  if (!hasOnlyKeys(inputRuleSet, allowedTopKeys) || !hasOwn(inputRuleSet, "schema") || !hasOwn(inputRuleSet, "rules")) {
    throw new FormEvaluationError("FORM_RULE_SET_INVALID");
  }
  if (inputRuleSet.schema !== FORM_RULES_SCHEMA) {
    throw new FormEvaluationError("FORM_RULES_SCHEMA_UNSUPPORTED");
  }
  if (!hasOwn(inputRuleSet, "ruleVersionId") || !isIdentifier(inputRuleSet.ruleVersionId)) {
    throw new FormEvaluationError("FORM_RULE_VERSION_ID_INVALID");
  }

  const rawRules = inputRuleSet.rules;
  if (!Array.isArray(rawRules)) {
    throw new FormEvaluationError("FORM_RULE_SET_INVALID");
  }
  if (rawRules.length > FORM_RULE_LIMITS.maxRules) {
    throw new FormEvaluationError("FORM_RULE_LIMIT_EXCEEDED");
  }

  const allowedRuleKeys = new Set(["id", "condition", "actions"]);
  const allowedActionKeys = new Set(["type", "targetFieldId"]);
  const seenRuleIds = new Set<string>();
  const parsedRules: FormRule[] = [];

  const graph = new Map<string, Set<string>>();

  for (const rawRule of rawRules) {
    if (!isObject(rawRule) || !hasOnlyKeys(rawRule, allowedRuleKeys)) {
      throw new FormEvaluationError("FORM_RULE_INVALID");
    }
    if (!isIdentifier(rawRule.id)) {
      throw new FormEvaluationError("FORM_RULE_INVALID");
    }
    if (seenRuleIds.has(rawRule.id)) {
      throw new FormEvaluationError("FORM_RULE_DUPLICATE");
    }
    seenRuleIds.add(rawRule.id);

    if (!Array.isArray(rawRule.actions) || rawRule.actions.length === 0) {
      throw new FormEvaluationError("FORM_RULE_ACTION_INVALID");
    }
    if (rawRule.actions.length > FORM_RULE_LIMITS.maxActionsPerRule) {
      throw new FormEvaluationError("FORM_RULE_LIMIT_EXCEEDED");
    }

    const actions: FormRuleAction[] = [];
    const ruleTargetIds = new Set<string>();

    for (const rawAction of rawRule.actions) {
      if (!isObject(rawAction) || !hasOnlyKeys(rawAction, allowedActionKeys)) {
        throw new FormEvaluationError("FORM_RULE_ACTION_INVALID");
      }
      if (typeof rawAction.type !== "string" || !ACTION_TYPE_SET.has(rawAction.type)) {
        throw new FormEvaluationError("FORM_RULE_ACTION_INVALID");
      }
      if (!isIdentifier(rawAction.targetFieldId)) {
        throw new FormEvaluationError("FORM_RULE_TARGET_UNKNOWN");
      }
      const targetField = fieldsById.get(rawAction.targetFieldId);
      if (!targetField) {
        throw new FormEvaluationError("FORM_RULE_TARGET_UNKNOWN");
      }
      if (CONTAINER_FIELD_TYPES.has(targetField.type)) {
        throw new FormEvaluationError("FORM_RULE_TARGET_UNKNOWN");
      }

      actions.push(Object.freeze({
        type: rawAction.type as FormRuleActionType,
        targetFieldId: targetField.id,
      }));
      ruleTargetIds.add(targetField.id);
    }

    const referencedFields = new Set<string>();
    const nodeState = { nodeCount: 0 };
    const condition = validateConditionNode(
      rawRule.condition as JsonSafeValue,
      0,
      nodeState,
      fieldsById,
      referencedFields,
      byteCache,
    );

    for (const targetId of ruleTargetIds) {
      for (const refId of referencedFields) {
        if (refId === targetId) {
          throw new FormEvaluationError("FORM_FIELD_REFERENCE_SELF");
        }
        let deps = graph.get(targetId);
        if (!deps) {
          deps = new Set<string>();
          graph.set(targetId, deps);
        }
        deps.add(refId);
      }
    }

    parsedRules.push(Object.freeze({
      id: rawRule.id,
      condition,
      actions: Object.freeze(actions),
    }));
  }

  // Multi-field cycle check via 3-state DFS
  const dfsState = new Map<string, number>();
  const hasCycleDFS = (u: string): boolean => {
    dfsState.set(u, 1);
    const neighbors = graph.get(u);
    if (neighbors) {
      for (const v of neighbors) {
        const vState = dfsState.get(v) ?? 0;
        if (vState === 1) {
          return true;
        }
        if (vState === 0) {
          if (hasCycleDFS(v)) {
            return true;
          }
        }
      }
    }
    dfsState.set(u, 2);
    return false;
  };

  for (const node of graph.keys()) {
    if ((dfsState.get(node) ?? 0) === 0) {
      if (hasCycleDFS(node)) {
        throw new FormEvaluationError("FORM_FIELD_DEPENDENCY_CYCLE");
      }
    }
  }

  // Non-cyclic forward reference check
  for (const [targetId, deps] of graph.entries()) {
    const targetIdx = fieldIndexById.get(targetId)!;
    for (const refId of deps) {
      const refIdx = fieldIndexById.get(refId)!;
      if (refIdx > targetIdx) {
        throw new FormEvaluationError("FORM_FIELD_REFERENCE_FORWARD");
      }
    }
  }

  return Object.freeze({
    schema: FORM_RULES_SCHEMA,
    ruleVersionId: inputRuleSet.ruleVersionId as string,
    rules: Object.freeze(parsedRules),
  });
}

class WorkBudgetTracker {
  private remaining: number = FORM_RULE_LIMITS.maxComparisonWork;

  charge(amount: number): void {
    if (amount <= 0) return;
    if (this.remaining < amount) {
      throw new FormEvaluationError("FORM_RULE_WORK_LIMIT_EXCEEDED");
    }
    this.remaining -= amount;
  }
}

class ByteLengthCache {
  private cache = new Map<string, number>();

  get(str: string): number {
    let len = this.cache.get(str);
    if (len === undefined) {
      len = Buffer.byteLength(str, "utf8");
      this.cache.set(str, len);
    }
    return len;
  }
}

function compareTypedEquality(
  left: JsonSafeValue,
  right: JsonSafeValue,
  budget: WorkBudgetTracker,
  byteCache: ByteLengthCache,
): boolean {
  if (typeof left !== typeof right) {
    budget.charge(1);
    return false;
  }

  if (left === null || right === null || typeof left === "boolean" || typeof left === "number") {
    budget.charge(1);
    return left === right;
  }

  if (typeof left === "string" && typeof right === "string") {
    const leftBytes = byteCache.get(left);
    const rightBytes = byteCache.get(right);
    if (leftBytes !== rightBytes) {
      budget.charge(1);
      return false;
    }
    budget.charge(1 + leftBytes);
    return left === right;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    budget.charge(1);
    if (left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      const lElem = left[i] as string;
      const rElem = right[i] as string;
      const lBytes = byteCache.get(lElem);
      const rBytes = byteCache.get(rElem);
      if (lBytes !== rBytes) {
        budget.charge(1);
        return false;
      }
      budget.charge(1 + lBytes);
      if (lElem !== rElem) {
        return false;
      }
    }
    return true;
  }

  budget.charge(1);
  return false;
}

function evaluateCondition(
  condition: FormCondition,
  effectiveValues: ReadonlyMap<string, JsonSafeValue>,
  budget: WorkBudgetTracker,
  byteCache: ByteLengthCache,
): boolean {
  if (condition.kind === "all") {
    for (const child of condition.conditions) {
      if (!evaluateCondition(child, effectiveValues, budget, byteCache)) {
        return false;
      }
    }
    return true;
  }

  if (condition.kind === "any") {
    for (const child of condition.conditions) {
      if (evaluateCondition(child, effectiveValues, budget, byteCache)) {
        return true;
      }
    }
    return false;
  }

  if (condition.kind === "not") {
    return !evaluateCondition(condition.condition, effectiveValues, budget, byteCache);
  }

  if (condition.kind === "field") {
    const isMissing = !effectiveValues.has(condition.fieldId);
    const value = effectiveValues.get(condition.fieldId) ?? null;
    const operator = condition.operator;
    const valOperand = condition.value;

    if (operator === "isEmpty") {
      budget.charge(1);
      if (isMissing) {
        return true;
      }
      return value === null || value === "" || (Array.isArray(value) && value.length === 0);
    }

    if (operator === "isNotEmpty") {
      budget.charge(1);
      if (isMissing) {
        return false;
      }
      return value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
    }

    if (isMissing) {
      return false;
    }

    const isEmptyValue = value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (isEmptyValue) {
      return false;
    }

    if (
      operator === "lessThan" ||
      operator === "lessThanOrEqual" ||
      operator === "greaterThan" ||
      operator === "greaterThanOrEqual"
    ) {
      budget.charge(1);
      const vNum = value as number;
      const opNum = valOperand as number;
      if (operator === "lessThan") return vNum < opNum;
      if (operator === "lessThanOrEqual") return vNum <= opNum;
      if (operator === "greaterThan") return vNum > opNum;
      return vNum >= opNum;
    }

    if (operator === "contains" || operator === "notContains") {
      const needle = valOperand as string;
      const needleBytes = byteCache.get(needle);

      if (typeof value === "string") {
        const haystackBytes = byteCache.get(value);
        const charge = haystackBytes * Math.max(1, needleBytes);
        budget.charge(charge);
        const matches = value.includes(needle);
        return operator === "contains" ? matches : !matches;
      }

      if (Array.isArray(value)) {
        let found = false;
        for (const elem of value as readonly string[]) {
          const elemBytes = byteCache.get(elem);
          if (elemBytes !== needleBytes) {
            budget.charge(1);
          } else {
            budget.charge(1 + elemBytes);
            if (elem === needle) {
              found = true;
              break;
            }
          }
        }
        return operator === "contains" ? found : !found;
      }

      return false;
    }

    if (operator === "in" || operator === "notIn") {
      const list = valOperand as readonly JsonSafeValue[];
      let found = false;

      for (const item of list) {
        const matches = compareTypedEquality(value, item, budget, byteCache);
        if (matches) {
          found = true;
          break;
        }
      }

      return operator === "in" ? found : !found;
    }

    if (operator === "equals" || operator === "notEquals") {
      const matches = compareTypedEquality(value, valOperand as JsonSafeValue, budget, byteCache);
      return operator === "equals" ? matches : !matches;
    }
  }

  return false;
}

export function normalizeFormRuleSet(input: unknown, fields: unknown): FormRuleSet {
  const safeRuleSet = safeSanitizeRuleSet(input);
  const safeFields = safeSanitizeGeneral(fields);
  const byteCache = new ByteLengthCache();

  const parsedFields = parseFields(safeFields, true);
  const normalized = parseRuleSetInternal(
    safeRuleSet,
    parsedFields.fieldsById,
    parsedFields.fieldIndexById,
    byteCache,
  );

  return deepFreeze(normalized);
}

export function evaluateConditionalForm(input: unknown): FormEvaluationResult {
  const safeInput = safeSanitizeEvaluationInput(input);

  if (!isObject(safeInput)) {
    throw new FormEvaluationError("FORM_INPUT_SHAPE_INVALID");
  }
  const allowedInputKeys = new Set(["fields", "historicalAnswers", "ruleSet"]);
  if (
    !hasOnlyKeys(safeInput, allowedInputKeys) ||
    !hasOwn(safeInput, "fields") ||
    !hasOwn(safeInput, "historicalAnswers") ||
    !hasOwn(safeInput, "ruleSet")
  ) {
    throw new FormEvaluationError("FORM_INPUT_SHAPE_INVALID");
  }

  const budget = new WorkBudgetTracker();
  const byteCache = new ByteLengthCache();

  const parsedFields = parseFields(safeInput.fields, false);
  const parsedAnswers = parseHistoricalAnswers(
    safeInput.historicalAnswers,
    parsedFields.fieldsById,
    byteCache,
  );

  const safeRuleSet = safeSanitizeRuleSet(safeInput.ruleSet);
  const parsedRuleSet = parseRuleSetInternal(
    safeRuleSet,
    parsedFields.fieldsById,
    parsedFields.fieldIndexById,
    byteCache,
  );

  const rulesByTarget = new Map<string, FormRule[]>();
  for (const rule of parsedRuleSet.rules) {
    for (const action of rule.actions) {
      let list = rulesByTarget.get(action.targetFieldId);
      if (!list) {
        list = [];
        rulesByTarget.set(action.targetFieldId, list);
      }
      list.push(rule);
    }
  }

  const finalizedEffectiveValues = new Map<string, JsonSafeValue>();
  const ruleResultMemo = new Map<string, boolean>();

  const fieldStates: FormFieldState[] = [];
  const hiddenFieldIds: string[] = [];
  const disabledFieldIds: string[] = [];
  const requiredFieldIds: string[] = [];
  const skippedFieldIds: string[] = [];

  for (const field of parsedFields.fields) {
    const rulesForField = rulesByTarget.get(field.id) ?? [];
    const matchedActions = new Set<FormRuleActionType>();

    for (const rule of rulesForField) {
      let isMatch = ruleResultMemo.get(rule.id);
      if (isMatch === undefined) {
        isMatch = evaluateCondition(rule.condition, finalizedEffectiveValues, budget, byteCache);
        ruleResultMemo.set(rule.id, isMatch);
      }
      if (isMatch) {
        for (const action of rule.actions) {
          if (action.targetFieldId === field.id) {
            matchedActions.add(action.type);
          }
        }
      }
    }

    const hasShow = matchedActions.has("show");
    const hasHide = matchedActions.has("hide");
    if (hasShow && hasHide) {
      throw new FormEvaluationError("FORM_RULE_ACTION_CONFLICT");
    }

    const hasEnable = matchedActions.has("enable");
    const hasDisable = matchedActions.has("disable");
    if (hasEnable && hasDisable) {
      throw new FormEvaluationError("FORM_RULE_ACTION_CONFLICT");
    }

    const hasSkip = matchedActions.has("skip");

    let visible: boolean;
    let skipped: boolean;
    let editable: boolean;
    let required: boolean;

    if (hasSkip) {
      skipped = true;
      visible = false;
      editable = false;
      required = false;
    } else {
      skipped = false;

      if (hasHide) {
        visible = false;
      } else if (hasShow) {
        visible = true;
      } else {
        visible = field.defaultVisibility === "visible";
      }

      const effective = visible;

      let enabledIntent: boolean;
      if (hasDisable) {
        enabledIntent = false;
      } else if (hasEnable) {
        enabledIntent = true;
      } else {
        enabledIntent = true;
      }
      editable = effective && enabledIntent;

      let requiredIntent: boolean;
      if (matchedActions.has("require")) {
        requiredIntent = true;
      } else {
        requiredIntent = field.required;
      }
      required = effective && editable && requiredIntent;
    }

    const effective = visible && !skipped;

    const state: FormFieldState = Object.freeze({
      fieldId: field.id,
      visible,
      effective,
      editable,
      required,
      skipped,
    });
    fieldStates.push(state);

    if (!visible) {
      hiddenFieldIds.push(field.id);
    }
    if (hasDisable) {
      disabledFieldIds.push(field.id);
    }
    if (required) {
      requiredFieldIds.push(field.id);
    }
    if (skipped) {
      skippedFieldIds.push(field.id);
    }

    if (effective) {
      const histAnswer = parsedAnswers.answersByFieldId.get(field.id);
      if (histAnswer) {
        finalizedEffectiveValues.set(field.id, histAnswer.value);
      }
    }
  }

  const effectiveAnswers: FormAnswer[] = [];
  for (const state of fieldStates) {
    if (state.effective) {
      const histAnswer = parsedAnswers.answersByFieldId.get(state.fieldId);
      if (histAnswer) {
        effectiveAnswers.push(histAnswer);
      }
    }
  }

  effectiveAnswers.sort((a, b) => compareFormFieldIds(a.fieldId, b.fieldId));

  const result: FormEvaluationResult = {
    schema: FORM_RULES_SCHEMA,
    ruleVersionId: parsedRuleSet.ruleVersionId,
    fieldStates: Object.freeze(fieldStates),
    hiddenFieldIds: Object.freeze(hiddenFieldIds),
    disabledFieldIds: Object.freeze(disabledFieldIds),
    requiredFieldIds: Object.freeze(requiredFieldIds),
    skippedFieldIds: Object.freeze(skippedFieldIds),
    effectiveAnswers: Object.freeze(effectiveAnswers),
  };

  return deepFreeze(result);
}
