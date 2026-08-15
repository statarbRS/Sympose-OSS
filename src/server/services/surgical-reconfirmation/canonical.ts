import { createHash } from "node:crypto";
import { types } from "node:util";

import {
  ABSOLUTE_SURGICAL_RECONFIRMATION_LIMITS,
  DEFAULT_SURGICAL_RECONFIRMATION_LIMITS,
  SurgicalReconfirmationError,
  type JsonValue,
  type SurgicalReconfirmationLimits,
} from "./types";

export type CanonicalValue = JsonValue;

export interface ResolvedSurgicalReconfirmationLimits {
  readonly maxInputDepth: number;
  readonly maxInputNodes: number;
  readonly maxStringBytes: number;
  readonly maxCanonicalBytes: number;
}

interface SnapshotBudget {
  readonly limits: ResolvedSurgicalReconfirmationLimits;
  nodes: number;
  stringBytes: number;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fail(
  code: ConstructorParameters<typeof SurgicalReconfirmationError>[0],
  path: string,
  message: string,
): never {
  throw new SurgicalReconfirmationError(code, message, path);
}

function boundedString(value: string, path: string, budget: SnapshotBudget): string {
  let normalized: string;
  try {
    normalized = value.normalize("NFC");
  } catch {
    fail("HOSTILE_DESCRIPTOR", path, "String normalization failed.");
  }
  if (normalized.includes("\u0000")) fail("UNSUPPORTED_VALUE", path, "NUL is not valid data.");
  const bytes = utf8ByteLength(normalized);
  budget.stringBytes += bytes;
  if (bytes > budget.limits.maxStringBytes || budget.stringBytes > budget.limits.maxCanonicalBytes) {
    fail("BOUNDS_EXCEEDED", path, "String or aggregate byte bound exceeded.");
  }
  return normalized;
}

function ordinaryPrototype(value: object, path: string): object | null {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    fail("PROXY_INPUT", path, "Prototype inspection failed.");
  }
  return prototype;
}

function rejectProxy(value: object, path: string): void {
  let proxy: boolean;
  try {
    proxy = types.isProxy(value);
  } catch {
    fail("PROXY_INPUT", path, "Proxy inspection failed.");
  }
  if (proxy) fail("PROXY_INPUT", path, "Proxy inputs are not accepted.");
}

function safeOwnKeys(value: object, path: string): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    fail("PROXY_INPUT", path, "Own-key inspection failed.");
  }
}

function safeDescriptor(value: object, key: PropertyKey, path: string): PropertyDescriptor {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail("PROXY_INPUT", path, "Descriptor inspection failed.");
  }
  if (descriptor === undefined) fail("HOSTILE_DESCRIPTOR", path, "Property disappeared during inspection.");
  if (!("value" in descriptor)) fail("HOSTILE_DESCRIPTOR", path, "Accessor properties are not accepted.");
  return descriptor;
}

function assertObjectKey(key: PropertyKey, path: string, budget: SnapshotBudget): asserts key is string {
  if (typeof key !== "string") fail("UNSUPPORTED_VALUE", path, "Symbol keys are not accepted.");
  const normalized = boundedString(key, path, budget);
  if (normalized !== key) fail("UNSUPPORTED_VALUE", path, "Property keys must already be NFC-normalized.");
  if (key === "__proto__" || key === "prototype" || key === "constructor" || key === "toJSON") {
    fail("UNSUPPORTED_VALUE", path, "Reserved object keys are not accepted.");
  }
}

function snapshotValue(
  value: unknown,
  path: string,
  depth: number,
  budget: SnapshotBudget,
  ancestors: WeakSet<object>,
): JsonValue {
  if (depth > budget.limits.maxInputDepth) fail("BOUNDS_EXCEEDED", path, "Input depth bound exceeded.");
  budget.nodes += 1;
  if (budget.nodes > budget.limits.maxInputNodes) fail("BOUNDS_EXCEEDED", path, "Input node bound exceeded.");

  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return boundedString(value, path, budget);
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) fail("UNSUPPORTED_VALUE", path, "Non-finite numbers are not accepted.");
      return Object.is(value, -0) ? 0 : value;
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      fail("UNSUPPORTED_VALUE", path, "Only JSON data is accepted.");
  }

  // This native check does not invoke proxy traps and must precede every
  // reflective operation performed on caller-owned objects.
  rejectProxy(value, path);
  if (ancestors.has(value)) fail("CYCLE_INPUT", path, "Cyclic input is not accepted.");
  ancestors.add(value);
  try {
    let output: JsonValue;
    let isArray = false;
    try {
      isArray = Array.isArray(value);
    } catch {
      fail("PROXY_INPUT", path, "Array inspection failed.");
    }

    if (isArray) {
      const prototype = ordinaryPrototype(value, path);
      if (prototype !== Array.prototype) fail("UNSUPPORTED_VALUE", path, "Only ordinary arrays are accepted.");

      const keys = safeOwnKeys(value, path);
      const lengthDescriptor = safeDescriptor(value, "length", `${path}.length`);
      if (!Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        fail("HOSTILE_DESCRIPTOR", `${path}.length`, "Array length is not a safe data value.");
      }
      const length = lengthDescriptor.value as number;
      if (length > budget.limits.maxInputNodes) fail("BOUNDS_EXCEEDED", path, "Array bound exceeded.");
      const expected = new Set<string>(["length"]);
      for (let index = 0; index < length; index += 1) expected.add(String(index));
      if (keys.length !== expected.size) fail("HOSTILE_DESCRIPTOR", path, "Sparse or augmented arrays are not accepted.");

      const array: JsonValue[] = [];
      for (const key of keys) {
        if (typeof key !== "string" || !expected.has(key)) {
          fail("UNSUPPORTED_VALUE", path, "Arrays may contain only dense numeric elements.");
        }
      }
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = safeDescriptor(value, key, `${path}[${index}]`);
        if (!descriptor.enumerable) fail("HOSTILE_DESCRIPTOR", `${path}[${index}]`, "Array elements must be enumerable data.");
        array.push(snapshotValue(descriptor.value, `${path}[${index}]`, depth + 1, budget, ancestors));
      }
      output = array;
    } else {
      if (ordinaryPrototype(value, path) !== Object.prototype) {
        fail("UNSUPPORTED_VALUE", path, "Only ordinary object-literal records are accepted.");
      }
      const keys = safeOwnKeys(value, path);
      const object: Record<string, JsonValue> = {};
      for (const key of keys) {
        assertObjectKey(key, `${path}.${String(key)}`, budget);
        const descriptor = safeDescriptor(value, key, `${path}.${key}`);
        if (!descriptor.enumerable) fail("HOSTILE_DESCRIPTOR", `${path}.${key}`, "Properties must be enumerable data.");
        object[key] = snapshotValue(descriptor.value, `${path}.${key}`, depth + 1, budget, ancestors);
      }
      output = object;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain a non-finite number.");
  return Object.is(value, -0) ? "0" : JSON.stringify(value);
}

function canonicalFromSnapshot(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalFromSnapshot).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(object).sort(compareCodeUnits);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalFromSnapshot(object[key]!)}`).join(",")}}`;
}

export function resolveCanonicalLimits(
  limits: SurgicalReconfirmationLimits | undefined,
): ResolvedSurgicalReconfirmationLimits {
  const resolved = {
    maxInputDepth: limits?.maxInputDepth ?? DEFAULT_SURGICAL_RECONFIRMATION_LIMITS.maxInputDepth,
    maxInputNodes: limits?.maxInputNodes ?? DEFAULT_SURGICAL_RECONFIRMATION_LIMITS.maxInputNodes,
    maxStringBytes: limits?.maxStringBytes ?? DEFAULT_SURGICAL_RECONFIRMATION_LIMITS.maxStringBytes,
    maxCanonicalBytes: limits?.maxCanonicalBytes ?? DEFAULT_SURGICAL_RECONFIRMATION_LIMITS.maxCanonicalBytes,
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new SurgicalReconfirmationError("INVALID_LIMIT", `Invalid canonical limit for ${key}.`);
    }
    const absolute = ABSOLUTE_SURGICAL_RECONFIRMATION_LIMITS[key as keyof typeof ABSOLUTE_SURGICAL_RECONFIRMATION_LIMITS];
    if (value > absolute) {
      throw new SurgicalReconfirmationError("INVALID_LIMIT", `Canonical limit for ${key} exceeds the absolute bound.`);
    }
  }
  return Object.freeze(resolved);
}

/**
 * Snapshot an input graph without invoking getters, proxies' property reads,
 * custom serializers, or caller-owned references.
 */
export function snapshotPlainData(
  value: unknown,
  limits?: ResolvedSurgicalReconfirmationLimits,
  path = "input",
): JsonValue {
  const resolved = limits ?? resolveCanonicalLimits(undefined);
  const budget: SnapshotBudget = { limits: resolved, nodes: 0, stringBytes: 0 };
  return snapshotValue(value, path, 0, budget, new WeakSet<object>());
}

export function canonicalJson(value: unknown): string {
  const snapshot = snapshotPlainData(value);
  const output = canonicalFromSnapshot(snapshot);
  if (utf8ByteLength(output) > DEFAULT_SURGICAL_RECONFIRMATION_LIMITS.maxCanonicalBytes) {
    throw new SurgicalReconfirmationError("BOUNDS_EXCEEDED", "Canonical JSON byte bound exceeded.");
  }
  return output;
}

export function canonicalJsonWithLimits(value: unknown, limits: ResolvedSurgicalReconfirmationLimits): string {
  const snapshot = snapshotPlainData(value, limits);
  const output = canonicalFromSnapshot(snapshot);
  if (utf8ByteLength(output) > limits.maxCanonicalBytes) {
    throw new SurgicalReconfirmationError("BOUNDS_EXCEEDED", "Canonical JSON byte bound exceeded.");
  }
  return output;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function fingerprintWithLimits(value: unknown, limits: ResolvedSurgicalReconfirmationLimits): string {
  return sha256Hex(canonicalJsonWithLimits(value, limits));
}

export function compareStableStrings(left: string, right: string): number {
  return compareCodeUnits(left, right);
}

export function stableSort<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  return [...values].sort(compare);
}

export function isPlainRecord(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor && "value" in descriptor) freeze(descriptor.value);
    }
    Object.freeze(candidate);
  };
  freeze(value);
  return value;
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function utf8Bytes(value: string): number {
  return utf8ByteLength(value);
}
