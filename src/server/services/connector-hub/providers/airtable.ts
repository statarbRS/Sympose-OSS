import { requestJson } from "./http";
import {
  decodeProviderContactCursor,
  encodeProviderContactCursor,
  makeContactPage,
  normalizeContactPageRequest,
  normalizeExternalContact,
} from "./contacts";
import {
  isNonEmptyText,
  isRecord,
  makeProviderFailure,
  normalizeCanonicalPeople,
  providerFailure,
  providerSuccess,
  resolveProviderRuntime,
  type BatchUpsertSummary,
  type CanonicalPerson,
  type ContactPage,
  type ContactPageRequest,
  type ConnectionValidation,
  type NormalizedCanonicalPerson,
  type ProviderAdapter,
  type ProviderFailure,
  type ProviderRecordOperation,
  type ProviderRecordResult,
  type ProviderResult,
  type ProviderRuntime,
  type ProviderRuntimeOptions,
} from "./types";

export const AIRTABLE_API_ORIGIN = "https://api.airtable.com" as const;
export const AIRTABLE_MAX_BATCH_SIZE = 10 as const;

export interface AirtableFieldMapping {
  readonly personId: string;
  readonly fullName: string;
  readonly email: string;
  readonly organization: string;
  readonly title: string;
}

export interface AirtableProviderConfig {
  readonly token: string;
  readonly baseId: string;
  readonly tableName: string;
  readonly fieldMapping?: Partial<AirtableFieldMapping>;
  /** Alias accepted for callers that name the mapping after the provider payload. */
  readonly fields?: Partial<AirtableFieldMapping>;
}

export type AirtableConfig = AirtableProviderConfig;

export const AIRTABLE_DEFAULT_FIELD_MAPPING: AirtableFieldMapping = Object.freeze({
  personId: "person_id",
  fullName: "full_name",
  email: "email",
  organization: "organization",
  title: "title",
});

interface AirtableRecordPayload {
  readonly id: string;
  readonly fields?: Record<string, unknown>;
  readonly createdTime?: string;
}

interface AirtableUpsertPayload {
  readonly records: readonly AirtableRecordPayload[];
  readonly createdRecords: readonly string[];
  readonly updatedRecords: readonly string[];
}

function encodedPathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeConfigText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validToken(value: unknown): value is string {
  return safeConfigText(value, 4_096) && !/[\r\n]/u.test(value);
}

function validFieldMapping(value: unknown): value is Partial<AirtableFieldMapping> {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(["personId", "fullName", "email", "organization", "title"]);
  return Object.keys(value).every((key) => allowedKeys.has(key))
    && Object.values(value).every((field) => safeConfigText(field, 128));
}

function validConfig(config: unknown): config is AirtableProviderConfig {
  if (!isRecord(config)) return false;
  if (
    !validToken(config.token)
    || !safeConfigText(config.baseId, 256)
    || !safeConfigText(config.tableName, 256)
    || !validFieldMapping(config.fieldMapping)
    || !validFieldMapping(config.fields)
  ) return false;
  const baseId = config.baseId;
  const tableName = config.tableName;
  try {
    encodedPathSegment(baseId);
    encodedPathSegment(tableName);
  } catch {
    return false;
  }
  const mapping = resolvedFieldMapping({
    token: config.token,
    baseId: config.baseId,
    tableName: config.tableName,
    fieldMapping: config.fieldMapping,
    fields: config.fields,
  });
  return new Set(Object.values(mapping)).size === Object.values(mapping).length;
}

function resolvedFieldMapping(config: AirtableProviderConfig): AirtableFieldMapping {
  const input = config.fieldMapping ?? config.fields ?? {};
  return {
    personId: input.personId ?? AIRTABLE_DEFAULT_FIELD_MAPPING.personId,
    fullName: input.fullName ?? AIRTABLE_DEFAULT_FIELD_MAPPING.fullName,
    email: input.email ?? AIRTABLE_DEFAULT_FIELD_MAPPING.email,
    organization: input.organization ?? AIRTABLE_DEFAULT_FIELD_MAPPING.organization,
    title: input.title ?? AIRTABLE_DEFAULT_FIELD_MAPPING.title,
  };
}

function tableUrl(config: AirtableProviderConfig): string {
  return `${AIRTABLE_API_ORIGIN}/v0/${encodedPathSegment(config.baseId)}/${encodedPathSegment(config.tableName)}`;
}

function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyText(item, 256))) return null;
  return value;
}

function parseAirtableRecord(value: unknown): AirtableRecordPayload | null {
  if (!isRecord(value) || !isNonEmptyText(value.id, 256)) return null;
  if (value.fields !== undefined && !isRecord(value.fields)) return null;
  if (value.createdTime !== undefined && !isNonEmptyText(value.createdTime, 64)) return null;
  return {
    id: value.id,
    fields: value.fields as Record<string, unknown> | undefined,
    createdTime: value.createdTime as string | undefined,
  };
}

// Airtable currently emits either a record token or an iterator/record pair separated by one slash.
// Accept the documented token shape, but never arbitrary paths, query syntax, or URL characters.
const AIRTABLE_OFFSET = /^[A-Za-z0-9._~-]{1,256}(?:\/[A-Za-z0-9._~-]{1,256})?$/u;

function normalizeAirtableContactPage(
  value: unknown,
  limit: number,
  fieldMapping: AirtableFieldMapping,
  clock: () => number,
): { readonly ok: true; readonly page: ContactPage } | { readonly ok: false; readonly failure: ProviderFailure } {
  if (!isRecord(value) || !Array.isArray(value.records) || value.records.length > limit) {
    return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
  }
  if (value.offset !== undefined && (typeof value.offset !== "string" || !AIRTABLE_OFFSET.test(value.offset))) {
    return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
  }

  const contacts = [];
  for (const rawRecord of value.records) {
    const record = parseAirtableRecord(rawRecord);
    if (!record || !record.fields || !record.createdTime) {
      return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
    }
    const normalized = normalizeExternalContact("airtable", {
      externalId: record.id,
      email: record.fields[fieldMapping.email],
      fullName: record.fields[fieldMapping.fullName],
      organization: record.fields[fieldMapping.organization],
      title: record.fields[fieldMapping.title],
      sourceVersion: record.createdTime,
      fieldEvidence: {
        externalId: "id",
        email: fieldMapping.email,
        fullName: [fieldMapping.fullName],
        organization: fieldMapping.organization,
        title: fieldMapping.title,
        sourceVersion: "createdTime",
      },
    }, clock);
    if (!normalized.ok) return normalized;
    contacts.push(normalized.contact);
  }

  const nextCursor = typeof value.offset === "string"
    ? encodeProviderContactCursor("airtable", value.offset)
    : null;
  return makeContactPage(contacts, nextCursor, limit);
}

function parseAirtableUpsertPayload(value: unknown): AirtableUpsertPayload | null {
  if (!isRecord(value) || !Array.isArray(value.records)) return null;
  const records = value.records.map(parseAirtableRecord);
  if (records.some((record) => record === null)) return null;
  const createdRecords = asStringArray(value.createdRecords);
  const updatedRecords = asStringArray(value.updatedRecords);
  if (!createdRecords || !updatedRecords) return null;
  return {
    records: records as AirtableRecordPayload[],
    createdRecords,
    updatedRecords,
  };
}

function recordResultOperation(
  id: string,
  created: ReadonlySet<string>,
  updated: ReadonlySet<string>,
): ProviderRecordOperation | null {
  const isCreated = created.has(id);
  const isUpdated = updated.has(id);
  if (isCreated === isUpdated) return null;
  return isCreated ? "CREATED" : "UPDATED";
}

/** Normalize the Airtable performUpsert response without exposing its raw body. */
export function normalizeAirtableUpsertResponse(
  value: unknown,
  people: readonly NormalizedCanonicalPerson[] | readonly CanonicalPerson[],
  fieldMapping: AirtableFieldMapping = AIRTABLE_DEFAULT_FIELD_MAPPING,
): ProviderResult<BatchUpsertSummary> {
  const payload = parseAirtableUpsertPayload(value);
  if (!payload || payload.records.length !== people.length) {
    return providerFailure("airtable", "upsert-people", makeProviderFailure("MALFORMED_RESPONSE"));
  }

  const ids = new Set(payload.records.map((record) => record.id));
  const created = new Set(payload.createdRecords);
  const updated = new Set(payload.updatedRecords);
  if (
    ids.size !== payload.records.length
    || created.size !== payload.createdRecords.length
    || updated.size !== payload.updatedRecords.length
    || payload.createdRecords.some((id) => !ids.has(id))
    || payload.updatedRecords.some((id) => !ids.has(id))
    || payload.createdRecords.some((id) => updated.has(id))
  ) {
    return providerFailure("airtable", "upsert-people", makeProviderFailure("MALFORMED_RESPONSE"));
  }

  const byEmail = new Map<string, NormalizedCanonicalPerson | CanonicalPerson>();
  for (const person of people) byEmail.set(person.email.trim().toLowerCase(), person);
  const seenPeople = new Set<string>();
  const records: ProviderRecordResult[] = [];
  for (const record of payload.records) {
    const responseEmail = record.fields?.[fieldMapping.email];
    const person = typeof responseEmail === "string"
      ? byEmail.get(responseEmail.trim().toLowerCase())
      : undefined;
    if (!person || seenPeople.has(person.personId)) {
      return providerFailure("airtable", "upsert-people", makeProviderFailure("MALFORMED_RESPONSE"));
    }
    const operation = recordResultOperation(record.id, created, updated);
    if (!operation) {
      return providerFailure("airtable", "upsert-people", makeProviderFailure("MALFORMED_RESPONSE"));
    }
    seenPeople.add(person.personId);
    records.push({ personId: person.personId, providerRecordId: record.id, operation });
  }

  return providerSuccess("airtable", "upsert-people", {
    requested: people.length,
    created: records.filter((record) => record.operation === "CREATED").length,
    updated: records.filter((record) => record.operation === "UPDATED").length,
    records,
  }, 1);
}

function normalizeAirtableValidationResponse(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value.records) || value.records.length > 1) return null;
  return value.records.every((record) => parseAirtableRecord(record) !== null)
    ? value.records.length
    : null;
}

export class AirtableProvider implements ProviderAdapter {
  readonly provider = "airtable" as const;

  private readonly config: AirtableProviderConfig;
  private readonly runtime: ProviderRuntime;
  private readonly configurationError: boolean;
  private readonly fieldMapping: AirtableFieldMapping;

  constructor(config: AirtableProviderConfig, options: ProviderRuntimeOptions = {}) {
    const resolved = resolveProviderRuntime(options);
    this.config = config;
    this.runtime = resolved.runtime;
    this.configurationError = resolved.configurationError || !validConfig(config);
    this.fieldMapping = validConfig(config) ? resolvedFieldMapping(config) : AIRTABLE_DEFAULT_FIELD_MAPPING;
  }

  async validateConnection(): Promise<ProviderResult<ConnectionValidation>> {
    if (this.configurationError) {
      return providerFailure(
        this.provider,
        "validate-connection",
        makeProviderFailure("CONFIGURATION_INVALID"),
      );
    }
    const outcome = await requestJson({
      url: `${tableUrl(this.config)}?pageSize=1`,
      allowedOrigin: AIRTABLE_API_ORIGIN,
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.token}`,
      },
      retryable: true,
    }, this.runtime);
    if (!outcome.ok) {
      return providerFailure(this.provider, "validate-connection", outcome.failure, outcome.attempts);
    }
    const recordsRead = normalizeAirtableValidationResponse(outcome.body);
    if (recordsRead === null) {
      return providerFailure(
        this.provider,
        "validate-connection",
        makeProviderFailure("MALFORMED_RESPONSE", { status: outcome.status }),
        outcome.attempts,
      );
    }
    return providerSuccess(this.provider, "validate-connection", {
      connected: true,
      boundedRead: true,
      recordsRead,
    }, outcome.attempts);
  }

  async listContacts(request?: ContactPageRequest): Promise<ProviderResult<ContactPage>> {
    if (this.configurationError) {
      return providerFailure(this.provider, "list-contacts", makeProviderFailure("CONFIGURATION_INVALID"));
    }
    const normalizedRequest = normalizeContactPageRequest(request);
    if (!normalizedRequest.ok) {
      return providerFailure(this.provider, "list-contacts", normalizedRequest.failure);
    }
    const decodedCursor = decodeProviderContactCursor(
      this.provider,
      normalizedRequest.request.cursor,
      (token) => AIRTABLE_OFFSET.test(token),
    );
    if (!decodedCursor.ok) return providerFailure(this.provider, "list-contacts", decodedCursor.failure);

    const params = new URLSearchParams();
    params.set("pageSize", String(normalizedRequest.request.limit));
    for (const field of [
      this.fieldMapping.fullName,
      this.fieldMapping.email,
      this.fieldMapping.organization,
      this.fieldMapping.title,
    ]) {
      params.append("fields[]", field);
    }
    if (decodedCursor.token !== null) params.set("offset", decodedCursor.token);
    const outcome = await requestJson({
      url: `${tableUrl(this.config)}?${params.toString()}`,
      allowedOrigin: AIRTABLE_API_ORIGIN,
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.token}`,
      },
      retryable: true,
    }, this.runtime);
    if (!outcome.ok) return providerFailure(this.provider, "list-contacts", outcome.failure, outcome.attempts);

    const normalized = normalizeAirtableContactPage(
      outcome.body,
      normalizedRequest.request.limit,
      this.fieldMapping,
      this.runtime.clock,
    );
    if (!normalized.ok) {
      return providerFailure(this.provider, "list-contacts", normalized.failure, outcome.attempts);
    }
    return providerSuccess(this.provider, "list-contacts", normalized.page, outcome.attempts);
  }

  async readContacts(request?: ContactPageRequest): Promise<ProviderResult<ContactPage>> {
    return this.listContacts(request);
  }

  async upsertPeople(people: readonly CanonicalPerson[]): Promise<ProviderResult<BatchUpsertSummary>> {
    if (this.configurationError) {
      return providerFailure(this.provider, "upsert-people", makeProviderFailure("CONFIGURATION_INVALID"));
    }
    const normalized = normalizeCanonicalPeople(people, AIRTABLE_MAX_BATCH_SIZE);
    if (!normalized.ok) return providerFailure(this.provider, "upsert-people", normalized.failure);
    if (normalized.people.length === 0) {
      return providerSuccess(this.provider, "upsert-people", {
        requested: 0,
        created: 0,
        updated: 0,
        records: [],
      }, 0);
    }

    const records = normalized.people.map((person) => ({
      fields: {
        [this.fieldMapping.personId]: person.personId,
        [this.fieldMapping.fullName]: person.fullName,
        [this.fieldMapping.email]: person.email,
        [this.fieldMapping.organization]: person.organization,
        [this.fieldMapping.title]: person.title,
      },
    }));
    const outcome = await requestJson({
      url: tableUrl(this.config),
      allowedOrigin: AIRTABLE_API_ORIGIN,
      method: "PATCH",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: {
        performUpsert: { fieldsToMergeOn: [this.fieldMapping.email] },
        records,
      },
      retryable: true,
    }, this.runtime);
    if (!outcome.ok) {
      return providerFailure(this.provider, "upsert-people", outcome.failure, outcome.attempts);
    }
    const normalizedResponse = normalizeAirtableUpsertResponse(
      outcome.body,
      normalized.people,
      this.fieldMapping,
    );
    if (!normalizedResponse.ok) {
      return providerFailure(this.provider, "upsert-people", normalizedResponse.failure, outcome.attempts);
    }
    return providerSuccess(this.provider, "upsert-people", normalizedResponse.value, outcome.attempts);
  }

  async upsertContacts(people: readonly CanonicalPerson[]): Promise<ProviderResult<BatchUpsertSummary>> {
    return this.upsertPeople(people);
  }
}

export function createAirtableProvider(
  config: AirtableProviderConfig,
  options: ProviderRuntimeOptions = {},
): AirtableProvider {
  return new AirtableProvider(config, options);
}

export const createAirtableClient = createAirtableProvider;
