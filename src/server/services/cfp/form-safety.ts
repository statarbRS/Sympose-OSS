import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";

export type JsonSafePrimitive = null | boolean | number | string;
export type JsonSafeObject = { readonly [key: string]: JsonSafeValue };
export type JsonSafeValue = JsonSafePrimitive | readonly JsonSafeValue[] | JsonSafeObject;

export interface FormSafetyLimits {
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly maxKeyBytes: number;
  readonly maxNodes: number;
  readonly maxSerializedBytes: number;
}

export const DEFAULT_FORM_SAFETY_LIMITS: FormSafetyLimits = Object.freeze({
  maxDepth: 32,
  maxStringBytes: 64 * 1024,
  maxArrayLength: 1_024,
  maxObjectKeys: 256,
  maxKeyBytes: 128,
  maxNodes: 20_000,
  maxSerializedBytes: 4 * 1024 * 1024,
});

const FORM_SAFETY_ERROR_MESSAGES = {
  INVALID_LIMITS: "The requested form-data safety limits are invalid.",
  UNSAFE_PROXY: "A proxy is not allowed in safe form data.",
  UNSAFE_ACCESSOR: "A getter or setter is not allowed in safe form data.",
  UNSAFE_SYMBOL: "A symbol is not allowed in safe form data.",
  UNSAFE_PROTOTYPE: "An object with a non-plain prototype is not allowed in safe form data.",
  UNSAFE_PROPERTY: "A non-data property is not allowed in safe form data.",
  UNSAFE_KEY: "A property key is not allowed in safe form data.",
  UNSAFE_VALUE: "A value is not allowed in safe form data.",
  SPARSE_ARRAY: "A sparse array is not allowed in safe form data.",
  CYCLE: "A circular reference is not allowed in safe form data.",
  DEPTH_LIMIT: "The form data exceeds its nesting limit.",
  STRING_LIMIT: "The form data exceeds its string-size limit.",
  ARRAY_LIMIT: "The form data exceeds its array-length limit.",
  OBJECT_LIMIT: "The form data exceeds its object-key limit.",
  NODE_LIMIT: "The form data exceeds its node-count limit.",
  SERIALIZED_SIZE_LIMIT: "The form data exceeds its serialized-size limit.",
  INSPECTION_FAILED: "The form data could not be inspected safely.",
} as const;

export type FormSafetyErrorCode = keyof typeof FORM_SAFETY_ERROR_MESSAGES;

export class FormSafetyError extends Error {
  readonly code: FormSafetyErrorCode;

  constructor(code: FormSafetyErrorCode) {
    super(FORM_SAFETY_ERROR_MESSAGES[code]);
    this.name = "FormSafetyError";
    this.code = code;
  }
}

const LIMIT_KEYS = [
  "maxDepth",
  "maxStringBytes",
  "maxArrayLength",
  "maxObjectKeys",
  "maxKeyBytes",
  "maxNodes",
  "maxSerializedBytes",
] as const;

type LimitKey = (typeof LIMIT_KEYS)[number];

const LIMIT_KEY_SET: ReadonlySet<string> = new Set(LIMIT_KEYS);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function inspected<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new FormSafetyError("INSPECTION_FAILED");
  }
}

function isProxy(value: object): boolean {
  return inspected(() => utilTypes.isProxy(value));
}

function resolveLimits(overrides?: Partial<FormSafetyLimits>): FormSafetyLimits {
  if (overrides === undefined) {
    return DEFAULT_FORM_SAFETY_LIMITS;
  }
  if (overrides === null || typeof overrides !== "object" || isProxy(overrides)) {
    throw new FormSafetyError("INVALID_LIMITS");
  }

  const prototype = inspected(() => Object.getPrototypeOf(overrides));
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FormSafetyError("INVALID_LIMITS");
  }
  if (inspected(() => Object.getOwnPropertySymbols(overrides)).length > 0) {
    throw new FormSafetyError("INVALID_LIMITS");
  }

  const resolved: Record<LimitKey, number> = { ...DEFAULT_FORM_SAFETY_LIMITS };
  for (const key of inspected(() => Object.getOwnPropertyNames(overrides))) {
    if (!LIMIT_KEY_SET.has(key)) {
      throw new FormSafetyError("INVALID_LIMITS");
    }
    const descriptor = inspected(() => Object.getOwnPropertyDescriptor(overrides, key));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new FormSafetyError("INVALID_LIMITS");
    }
    const value = descriptor.value;
    const limitKey = key as LimitKey;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > DEFAULT_FORM_SAFETY_LIMITS[limitKey]
    ) {
      throw new FormSafetyError("INVALID_LIMITS");
    }
    resolved[limitKey] = value;
  }
  return Object.freeze(resolved);
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

function assertSafeKey(key: string, limits: FormSafetyLimits): void {
  if (
    key.length === 0 ||
    FORBIDDEN_KEYS.has(key) ||
    CONTROL_CHARACTER_PATTERN.test(key) ||
    hasLoneSurrogate(key) ||
    Buffer.byteLength(key, "utf8") > limits.maxKeyBytes
  ) {
    throw new FormSafetyError("UNSAFE_KEY");
  }
}

interface WalkState {
  readonly limits: FormSafetyLimits;
  readonly active: WeakSet<object>;
  nodes: number;
  serializedBytes: number;
}

function consumeSerializedBytes(state: WalkState, bytes: number): void {
  state.serializedBytes += bytes;
  if (state.serializedBytes > state.limits.maxSerializedBytes) {
    throw new FormSafetyError("SERIALIZED_SIZE_LIMIT");
  }
}

function serializedScalarBytes(value: JsonSafePrimitive): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new FormSafetyError("INSPECTION_FAILED");
  }
  return Buffer.byteLength(serialized, "utf8");
}

function walkArray(input: object, depth: number, state: WalkState): readonly JsonSafeValue[] {
  const prototype = inspected(() => Object.getPrototypeOf(input));
  if (prototype !== Array.prototype) {
    throw new FormSafetyError("UNSAFE_PROTOTYPE");
  }
  if (inspected(() => Object.getOwnPropertySymbols(input)).length > 0) {
    throw new FormSafetyError("UNSAFE_SYMBOL");
  }

  const lengthDescriptor = inspected(() => Object.getOwnPropertyDescriptor(input, "length"));
  if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
    throw new FormSafetyError("UNSAFE_PROPERTY");
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new FormSafetyError("UNSAFE_PROPERTY");
  }
  if (length > state.limits.maxArrayLength) {
    throw new FormSafetyError("ARRAY_LIMIT");
  }
  consumeSerializedBytes(state, 2 + Math.max(0, length - 1));

  const propertyNames = inspected(() => Object.getOwnPropertyNames(input));
  for (const propertyName of propertyNames) {
    if (propertyName === "length") {
      continue;
    }
    const numericIndex = Number(propertyName);
    if (
      !Number.isSafeInteger(numericIndex) ||
      numericIndex < 0 ||
      numericIndex >= length ||
      String(numericIndex) !== propertyName
    ) {
      throw new FormSafetyError("UNSAFE_KEY");
    }
  }

  const output: JsonSafeValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = inspected(() => Object.getOwnPropertyDescriptor(input, String(index)));
    if (!descriptor) {
      throw new FormSafetyError("SPARSE_ARRAY");
    }
    if (!("value" in descriptor)) {
      throw new FormSafetyError("UNSAFE_ACCESSOR");
    }
    if (descriptor.enumerable !== true) {
      throw new FormSafetyError("UNSAFE_PROPERTY");
    }
    output.push(walkJsonSafe(descriptor.value, depth + 1, state));
  }
  return Object.freeze(output);
}

function walkObject(input: object, depth: number, state: WalkState): JsonSafeObject {
  const prototype = inspected(() => Object.getPrototypeOf(input));
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FormSafetyError("UNSAFE_PROTOTYPE");
  }
  if (inspected(() => Object.getOwnPropertySymbols(input)).length > 0) {
    throw new FormSafetyError("UNSAFE_SYMBOL");
  }

  const propertyNames = inspected(() => Object.getOwnPropertyNames(input));
  if (propertyNames.length > state.limits.maxObjectKeys) {
    throw new FormSafetyError("OBJECT_LIMIT");
  }
  consumeSerializedBytes(state, 2 + Math.max(0, propertyNames.length - 1));

  const output: Record<string, JsonSafeValue> = {};
  for (const propertyName of propertyNames) {
    assertSafeKey(propertyName, state.limits);
    consumeSerializedBytes(state, serializedScalarBytes(propertyName) + 1);
    const descriptor = inspected(() => Object.getOwnPropertyDescriptor(input, propertyName));
    if (!descriptor || !("value" in descriptor)) {
      throw new FormSafetyError("UNSAFE_ACCESSOR");
    }
    if (descriptor.enumerable !== true) {
      throw new FormSafetyError("UNSAFE_PROPERTY");
    }
    Object.defineProperty(output, propertyName, {
      configurable: true,
      enumerable: true,
      value: walkJsonSafe(descriptor.value, depth + 1, state),
      writable: true,
    });
  }
  return Object.freeze(output);
}

function walkJsonSafe(input: unknown, depth: number, state: WalkState): JsonSafeValue {
  if (depth > state.limits.maxDepth) {
    throw new FormSafetyError("DEPTH_LIMIT");
  }
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    throw new FormSafetyError("NODE_LIMIT");
  }

  if (input === null) {
    consumeSerializedBytes(state, serializedScalarBytes(input));
    return input;
  }
  if (typeof input === "boolean") {
    consumeSerializedBytes(state, serializedScalarBytes(input));
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new FormSafetyError("UNSAFE_VALUE");
    }
    const normalized = Object.is(input, -0) ? 0 : input;
    consumeSerializedBytes(state, serializedScalarBytes(normalized));
    return normalized;
  }
  if (typeof input === "string") {
    if (hasLoneSurrogate(input)) {
      throw new FormSafetyError("UNSAFE_VALUE");
    }
    if (Buffer.byteLength(input, "utf8") > state.limits.maxStringBytes) {
      throw new FormSafetyError("STRING_LIMIT");
    }
    consumeSerializedBytes(state, serializedScalarBytes(input));
    return input;
  }
  if (typeof input === "symbol") {
    throw new FormSafetyError("UNSAFE_SYMBOL");
  }
  if (typeof input !== "object") {
    throw new FormSafetyError("UNSAFE_VALUE");
  }
  if (isProxy(input)) {
    throw new FormSafetyError("UNSAFE_PROXY");
  }
  if (state.active.has(input)) {
    throw new FormSafetyError("CYCLE");
  }

  state.active.add(input);
  try {
    const array = inspected(() => Array.isArray(input));
    return array ? walkArray(input, depth, state) : walkObject(input, depth, state);
  } finally {
    state.active.delete(input);
  }
}

export function sanitizeFormData(
  input: unknown,
  limitOverrides?: Partial<FormSafetyLimits>,
): JsonSafeValue {
  const limits = resolveLimits(limitOverrides);
  const normalized = walkJsonSafe(input, 0, {
    active: new WeakSet<object>(),
    limits,
    nodes: 0,
    serializedBytes: 0,
  });
  return normalized;
}
