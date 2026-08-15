import { createHash } from "node:crypto";

import {
  CHANGE_RADIUS_FAMILIES,
  CHANGE_RADIUS_LIMITS,
  type ChangeRadiusFamily,
  type ChangeRadiusScope,
  type JsonValue,
} from "./types";

/** JSON-compatible value used by canonical helpers that do not know a domain shape. */
export type CanonicalValue = JsonValue;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("Canonical JSON cannot contain a non-finite number.");
  }
  return Object.is(value, -0) ? "0" : JSON.stringify(value);
}

function canonicalize(value: unknown, depth: number, ancestors: WeakSet<object>): string {
  if (depth > CHANGE_RADIUS_LIMITS.maxInputDepth) {
    throw new TypeError("Canonical JSON depth bound exceeded.");
  }

  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      if (Buffer.byteLength(value, "utf8") > CHANGE_RADIUS_LIMITS.maxStringBytes) {
        throw new TypeError("Canonical JSON string bound exceeded.");
      }
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError("Canonical JSON contains an unsupported value.");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON contains a cycle.");
  }

  ancestors.add(value);
  let result: string;
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new TypeError("Canonical JSON cannot contain sparse arrays.");
      }
      values.push(canonicalize(value[index], depth + 1, ancestors));
    }
    result = `[${values.join(",")}]`;
  } else if (isPlainObject(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON cannot contain symbol keys.");
    }
    const keys = Object.keys(value).sort(compareCodeUnits);
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1, ancestors)}`);
    result = `{${entries.join(",")}}`;
  } else {
    throw new TypeError("Canonical JSON accepts only plain objects and arrays.");
  }
  ancestors.delete(value);
  return result;
}

/**
 * RFC-8785-compatible for the JSON subset used by the service: object keys are
 * sorted by code units, arrays retain their semantic order, and no locale or
 * timezone APIs participate in serialization.
 */
export function canonicalJson(value: unknown): string {
  const result = canonicalize(value, 0, new WeakSet<object>());
  if (Buffer.byteLength(result, "utf8") > CHANGE_RADIUS_LIMITS.maxCanonicalBytes) {
    throw new TypeError("Canonical JSON byte bound exceeded.");
  }
  return result;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function compareStableStrings(left: string, right: string): number {
  return compareCodeUnits(left, right);
}

export function stableSort<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  return [...values].sort(compare);
}

export function recordKey(reference: { readonly family: string; readonly recordId: string }): string {
  return `${reference.family}\u0000${reference.recordId}`;
}

export function isKnownFamily(family: string): family is ChangeRadiusFamily {
  return (CHANGE_RADIUS_FAMILIES as readonly string[]).includes(family);
}

export function outputFamily(family: string): ChangeRadiusFamily | "UNKNOWN" {
  return isKnownFamily(family) ? family : "UNKNOWN";
}

export function scopeKey(scope: ChangeRadiusScope): string {
  return `${scope.workspaceId}\u0000${scope.eventId}`;
}

export function sameScope(left: ChangeRadiusScope, right: ChangeRadiusScope): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

export function cloneJsonValue<T>(value: T): T {
  return cloneValue(value, new WeakSet<object>()) as T;
}

function cloneValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("Cannot clone a cyclic value.");
  ancestors.add(value);
  let cloned: unknown;
  if (Array.isArray(value)) {
    cloned = value.map((child) => cloneValue(child, ancestors));
  } else if (isPlainObject(value)) {
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(value)) target[key] = cloneValue(value[key], ancestors);
    cloned = target;
  } else {
    throw new TypeError("Cannot clone a non-plain value.");
  }
  ancestors.delete(value);
  return cloned;
}

/** Freeze an output tree without ever freezing caller-owned input. */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  freezeValue(value, seen);
  return value;
}

function freezeValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeValue(child, seen);
  Object.freeze(value);
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isPlainObject(value);
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= CHANGE_RADIUS_LIMITS.maxStringBytes;
}
