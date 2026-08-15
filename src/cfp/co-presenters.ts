export const CO_PRESENTERS_FIELD_CONFIG_SCHEMA = "cfp-co-presenters-field/v1" as const;
export const CO_PRESENTERS_VALUE_SCHEMA = "cfp-co-presenters/v1" as const;

export const CO_PRESENTERS_LIMITS = Object.freeze({
  maxEntries: 4,
  maxRoles: 8,
  maxFullNameBytes: 160,
  maxEmailBytes: 320,
  maxRoleBytes: 64,
  maxGuidanceBytes: 512,
  maxSerializedBytes: 16 * 1024,
});

export const DEFAULT_CO_PRESENTERS_ROLES = Object.freeze([
  "co-speaker",
  "co-presenter",
  "coauthor",
  "moderator",
] as const);

export type CoPresentersValidationCode =
  | "CONFIG_INVALID"
  | "VALUE_INVALID"
  | "LIMIT_EXCEEDED"
  | "DUPLICATE";

export class CoPresentersValidationError extends Error {
  readonly code: CoPresentersValidationCode;

  constructor(code: CoPresentersValidationCode) {
    super("The co-presenter field configuration or value is invalid.");
    this.name = "CoPresentersValidationError";
    this.code = code;
  }
}

export interface CoPresentersFieldConfig {
  readonly schema: typeof CO_PRESENTERS_FIELD_CONFIG_SCHEMA;
  readonly maxEntries: number;
  readonly roles: readonly string[];
  readonly guidance?: string;
}

export interface CoPresenterEntry {
  readonly fullName: string;
  readonly email: string;
  readonly role: string;
}

export interface CoPresentersValue {
  readonly schema: typeof CO_PRESENTERS_VALUE_SCHEMA;
  readonly entries: readonly CoPresenterEntry[];
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const TEXT_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasSchemaTag(value: unknown, schema: string): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return (value as { readonly schema?: unknown }).schema === schema;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
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

function byteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

function normalizedText(
  value: unknown,
  maxBytes: number,
  code: CoPresentersValidationCode,
): string {
  if (
    typeof value !== "string" ||
    hasLoneSurrogate(value) ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new CoPresentersValidationError(code);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || byteLength(normalized) > maxBytes) {
    throw new CoPresentersValidationError(code);
  }
  return normalized;
}

function freezeConfig(config: CoPresentersFieldConfig): CoPresentersFieldConfig {
  return Object.freeze({
    ...config,
    roles: Object.freeze([...config.roles]),
  });
}

export function normalizeCoPresentersFieldConfig(
  input: unknown,
  fieldType?: string,
): CoPresentersFieldConfig | null {
  if (!isRecord(input)) {
    if (hasSchemaTag(input, CO_PRESENTERS_FIELD_CONFIG_SCHEMA)) {
      throw new CoPresentersValidationError("CONFIG_INVALID");
    }
    return null;
  }
  if (input.schema !== CO_PRESENTERS_FIELD_CONFIG_SCHEMA) return null;
  if (fieldType !== undefined && fieldType !== "longText") {
    throw new CoPresentersValidationError("CONFIG_INVALID");
  }
  if (!hasOnlyKeys(input, ["schema", "maxEntries", "roles", "guidance"])) {
    throw new CoPresentersValidationError("CONFIG_INVALID");
  }

  const maxEntries = input.maxEntries === undefined ? CO_PRESENTERS_LIMITS.maxEntries : input.maxEntries;
  if (
    typeof maxEntries !== "number" ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > CO_PRESENTERS_LIMITS.maxEntries
  ) {
    throw new CoPresentersValidationError("LIMIT_EXCEEDED");
  }

  const rawRoles = input.roles === undefined ? DEFAULT_CO_PRESENTERS_ROLES : input.roles;
  if (!Array.isArray(rawRoles) || rawRoles.length === 0 || rawRoles.length > CO_PRESENTERS_LIMITS.maxRoles) {
    throw new CoPresentersValidationError("LIMIT_EXCEEDED");
  }
  const roles: string[] = [];
  const seenRoles = new Set<string>();
  for (const rawRole of rawRoles) {
    const role = normalizedText(rawRole, CO_PRESENTERS_LIMITS.maxRoleBytes, "CONFIG_INVALID");
    const key = role.toLocaleLowerCase("en-US");
    if (seenRoles.has(key)) throw new CoPresentersValidationError("DUPLICATE");
    seenRoles.add(key);
    roles.push(role);
  }

  const guidance = input.guidance === undefined
    ? undefined
    : normalizedText(input.guidance, CO_PRESENTERS_LIMITS.maxGuidanceBytes, "CONFIG_INVALID");

  return freezeConfig({
    schema: CO_PRESENTERS_FIELD_CONFIG_SCHEMA,
    maxEntries,
    roles,
    ...(guidance !== undefined ? { guidance } : {}),
  });
}

function parseValueInput(input: unknown): unknown {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string") return input;
  if (input.trim().length === 0) return null;
  if (byteLength(input) > CO_PRESENTERS_LIMITS.maxSerializedBytes) {
    throw new CoPresentersValidationError("LIMIT_EXCEEDED");
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new CoPresentersValidationError("VALUE_INVALID");
  }
}

function freezeValue(value: CoPresentersValue): CoPresentersValue {
  return Object.freeze({
    schema: value.schema,
    entries: Object.freeze(value.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

function normalizedEmail(value: unknown): string {
  if (
    typeof value !== "string" ||
    hasLoneSurrogate(value) ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new CoPresentersValidationError("VALUE_INVALID");
  }
  const canonical = value.trim().normalize("NFC").toLowerCase();
  if (canonical.length === 0 || byteLength(canonical) > CO_PRESENTERS_LIMITS.maxEmailBytes) {
    throw new CoPresentersValidationError("VALUE_INVALID");
  }
  return canonical;
}

export function normalizeCoPresentersValue(
  input: unknown,
  config: CoPresentersFieldConfig,
): CoPresentersValue | null {
  const candidate = parseValueInput(input);
  if (candidate === null) return null;
  if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["schema", "entries"])) {
    throw new CoPresentersValidationError("VALUE_INVALID");
  }
  if (candidate.schema !== CO_PRESENTERS_VALUE_SCHEMA || !Array.isArray(candidate.entries)) {
    throw new CoPresentersValidationError("VALUE_INVALID");
  }
  if (candidate.entries.length > config.maxEntries || candidate.entries.length > CO_PRESENTERS_LIMITS.maxEntries) {
    throw new CoPresentersValidationError("LIMIT_EXCEEDED");
  }

  const entries: CoPresenterEntry[] = [];
  const seenEmails = new Set<string>();
  for (const rawEntry of candidate.entries) {
    if (!isRecord(rawEntry) || !hasOnlyKeys(rawEntry, ["fullName", "email", "role"])) {
      throw new CoPresentersValidationError("VALUE_INVALID");
    }
    const fullName = normalizedText(rawEntry.fullName, CO_PRESENTERS_LIMITS.maxFullNameBytes, "VALUE_INVALID");
    const email = normalizedEmail(rawEntry.email);
    const role = normalizedText(rawEntry.role, CO_PRESENTERS_LIMITS.maxRoleBytes, "VALUE_INVALID");
    if (!EMAIL_PATTERN.test(email) || !config.roles.includes(role)) {
      throw new CoPresentersValidationError("VALUE_INVALID");
    }
    const duplicateKey = email;
    if (seenEmails.has(duplicateKey)) throw new CoPresentersValidationError("DUPLICATE");
    seenEmails.add(duplicateKey);
    entries.push({ fullName, email, role });
  }

  const normalized = freezeValue({ schema: CO_PRESENTERS_VALUE_SCHEMA, entries });
  const serialized = JSON.stringify(normalized);
  if (typeof serialized !== "string" || byteLength(serialized) > CO_PRESENTERS_LIMITS.maxSerializedBytes) {
    throw new CoPresentersValidationError("LIMIT_EXCEEDED");
  }
  return normalized;
}

export function coPresentersEntries(value: unknown): readonly CoPresenterEntry[] | null {
  if (!isRecord(value) || value.schema !== CO_PRESENTERS_VALUE_SCHEMA || !Array.isArray(value.entries)) {
    return null;
  }
  if (
    !hasOnlyKeys(value, ["schema", "entries"]) ||
    value.entries.some(
      (entry) =>
        !isRecord(entry) ||
        !hasOnlyKeys(entry, ["fullName", "email", "role"]) ||
        typeof entry.fullName !== "string" ||
        typeof entry.email !== "string" ||
        typeof entry.role !== "string",
    )
  ) {
    return null;
  }
  return value.entries as readonly CoPresenterEntry[];
}
