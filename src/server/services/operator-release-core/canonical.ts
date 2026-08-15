import { createHash } from "node:crypto";
import type { JsonValue } from "./contracts";

export const MAX_CANONICAL_DEPTH = 64 as const;
export const MAX_CANONICAL_NODES = 65_536 as const;
export const MAX_CANONICAL_INPUT_BYTES = 1024 * 1024;

export class CanonicalizationError extends Error {
  readonly code = "NON_CANONICAL_INPUT" as const;

  constructor(message = "The release input is not canonical JSON.") {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export interface PlainDataLimits {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxBytes?: number;
}

interface SnapshotState {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
  readonly ancestors: Set<object>;
  readonly completed: Map<object, JsonValue>;
  nodes: number;
  bytes: number;
}

function compareUtf16(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalizationError("Strings must contain only valid Unicode scalar values.");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalizationError("Strings must contain only valid Unicode scalar values.");
    }
  }
}

function safeObjectKey(key: string): void {
  assertUnicodeScalarString(key);
}

function charge(state: SnapshotState, bytes: number): void {
  state.nodes += 1;
  state.bytes += bytes;
  if (state.nodes > state.maxNodes) {
    throw new CanonicalizationError("The release input exceeds the bounded node count.");
  }
  if (state.bytes > state.maxBytes) {
    throw new CanonicalizationError("The release input exceeds the bounded byte size.");
  }
}

function descriptorsOf(value: object): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new CanonicalizationError("The release input could not be snapshotted safely.");
  }
}

function prototypeOf(value: object): object | null {
  try {
    return Object.getPrototypeOf(value) as object | null;
  } catch {
    throw new CanonicalizationError("The release input has an unreadable prototype.");
  }
}

function dataDescriptor(
  descriptors: PropertyDescriptorMap,
  key: string,
  enumerable: boolean,
): PropertyDescriptor & { readonly value: unknown } {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== enumerable) {
    throw new CanonicalizationError("Accessors, sparse arrays, and hidden fields are not accepted.");
  }
  return descriptor as PropertyDescriptor & { readonly value: unknown };
}

function snapshotValue(value: unknown, depth: number, state: SnapshotState): JsonValue {
  if (depth > state.maxDepth) {
    throw new CanonicalizationError("The release input exceeds the bounded nesting depth.");
  }
  if (value === null) {
    charge(state, 4);
    return null;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    charge(state, Buffer.byteLength(value, "utf8") + 2);
    return value;
  }
  if (typeof value === "boolean") {
    charge(state, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError("Non-finite numbers are not canonical JSON.");
    }
    const normalized = Object.is(value, -0) ? 0 : value;
    charge(state, JSON.stringify(normalized).length);
    return normalized;
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError("Only plain JSON data is accepted.");
  }

  const objectValue = value as object;
  if (state.ancestors.has(objectValue)) {
    throw new CanonicalizationError("Cyclic input is not canonical JSON.");
  }
  const completed = state.completed.get(objectValue);
  if (completed !== undefined) return completed;

  state.ancestors.add(objectValue);
  try {
    const descriptors = descriptorsOf(objectValue);
    const descriptorKeys = Reflect.ownKeys(descriptors);
    if (descriptorKeys.some((key) => typeof key === "symbol")) {
      throw new CanonicalizationError("Symbol properties are not canonical JSON.");
    }

    if (Array.isArray(value)) {
      if (prototypeOf(objectValue) !== Array.prototype) {
        throw new CanonicalizationError("Array subclasses are not accepted.");
      }
      const lengthDescriptor = dataDescriptor(descriptors, "length", false);
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        throw new CanonicalizationError("The array length is invalid.");
      }
      if (descriptorKeys.length !== (length as number) + 1) {
        throw new CanonicalizationError("Sparse arrays and custom array fields are not accepted.");
      }
      charge(state, 2);
      const output: JsonValue[] = new Array(length as number);
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = dataDescriptor(descriptors, `${index}`, true);
        output[index] = snapshotValue(descriptor.value, depth + 1, state);
      }
      state.completed.set(objectValue, output);
      return output;
    }

    const prototype = prototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError("Only plain JSON objects are accepted.");
    }
    charge(state, 2);
    const output: Record<string, JsonValue> = {};
    for (const ownKey of descriptorKeys) {
      const key = ownKey as string;
      safeObjectKey(key);
      const descriptor = dataDescriptor(descriptors, key, true);
      state.bytes += Buffer.byteLength(key, "utf8") + 3;
      if (state.bytes > state.maxBytes) {
        throw new CanonicalizationError("The release input exceeds the bounded byte size.");
      }
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: snapshotValue(descriptor.value, depth + 1, state),
      });
    }
    state.completed.set(objectValue, output);
    return output;
  } finally {
    state.ancestors.delete(objectValue);
  }
}

function assertExpandedNodeBound(value: JsonValue, maximum: number): void {
  const pending: JsonValue[] = [value];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    count += 1;
    if (count > maximum) {
      throw new CanonicalizationError("The normalized release input exceeds the bounded node count.");
    }
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    } else if (current !== null && typeof current === "object") {
      for (const key of Object.keys(current)) pending.push(current[key]!);
    }
  }
}

/**
 * Capture caller data exactly once from data descriptors, rejecting accessors,
 * subclasses, symbols, sparse arrays, cycles, and unbounded structures.
 */
export function snapshotPlainData(value: unknown, limits: PlainDataLimits = {}): JsonValue {
  const state: SnapshotState = {
    maxDepth: limits.maxDepth ?? MAX_CANONICAL_DEPTH,
    maxNodes: limits.maxNodes ?? MAX_CANONICAL_NODES,
    maxBytes: limits.maxBytes ?? MAX_CANONICAL_INPUT_BYTES,
    ancestors: new Set<object>(),
    completed: new Map<object, JsonValue>(),
    nodes: 0,
    bytes: 0,
  };
  const snapshot = snapshotValue(value, 0, state);
  assertExpandedNodeBound(snapshot, state.maxNodes);
  if (Buffer.byteLength(serializeCanonical(snapshot), "utf8") > state.maxBytes) {
    throw new CanonicalizationError("The release input exceeds the bounded canonical byte size.");
  }
  return snapshot;
}

export function normalizeJsonValue(value: unknown): JsonValue {
  return snapshotPlainData(value);
}

function serializeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
  const keys = Object.keys(value).sort(compareUtf16);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key]!)}`).join(",")}}`;
}

/** RFC 8785-compatible JSON Canonicalization Scheme serialization. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(snapshotPlainData(value));
}

export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

/** Freeze without property reads or recursion. Caller data is not cloned here. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const stack: object[] = [value as object];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const descriptors = descriptorsOf(current);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof PropertyDescriptorMap];
      if (descriptor && "value" in descriptor && descriptor.value !== null && typeof descriptor.value === "object") {
        stack.push(descriptor.value as object);
      }
    }
    Object.freeze(current);
  }
  return value;
}

/** Descriptor-safe detached clone followed by an iterative deep freeze. */
export function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(snapshotPlainData(value) as T);
}

export function sortCodePoints<T>(values: readonly T[], selector: (value: T) => string): T[] {
  return [...values].sort((left, right) => compareUtf16(selector(left), selector(right)));
}

export function compareStrings(left: string, right: string): number {
  return compareUtf16(left, right);
}
