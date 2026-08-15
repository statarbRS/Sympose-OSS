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
  type ProviderRecordResult,
  type ProviderResult,
  type ProviderRuntime,
  type ProviderRuntimeOptions,
} from "./types";

export const HUBSPOT_API_ORIGIN = "https://api.hubapi.com" as const;
export const HUBSPOT_CONTACTS_PATH = "/crm/v3/objects/contacts" as const;
export const HUBSPOT_MAX_BATCH_SIZE = 100 as const;
export const HUBSPOT_CONTACT_READ_PROPERTIES = Object.freeze([
  "email",
  "firstname",
  "lastname",
  "company",
  "jobtitle",
] as const);

export interface HubSpotProviderConfig {
  readonly token: string;
}

export type HubspotProviderConfig = HubSpotProviderConfig;
export type HubSpotConfig = HubSpotProviderConfig;

interface HubSpotBatchResult {
  readonly id: string;
  readonly isNew: boolean;
  readonly properties: Record<string, unknown>;
}

interface HubSpotUpsertPayload {
  readonly results: readonly HubSpotBatchResult[];
  readonly errors: readonly unknown[];
}

function safeToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && !/[\u0000-\u001f\u007f\r\n]/u.test(value);
}

function validConfig(config: unknown): config is HubSpotProviderConfig {
  return isRecord(config) && safeToken(config.token);
}

function splitName(fullName: string): { readonly firstName: string | null; readonly lastName: string } {
  const parts = fullName.trim().split(/\s+/u).filter(Boolean);
  if (parts.length <= 1) return { firstName: null, lastName: parts[0] ?? fullName };
  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(" ") };
}

function propertiesFor(person: NormalizedCanonicalPerson): Record<string, string> {
  const name = splitName(person.fullName);
  const properties: Record<string, string> = {
    email: person.email,
    lastname: name.lastName,
  };
  if (name.firstName) properties.firstname = name.firstName;
  if (person.organization !== null) properties.company = person.organization;
  if (person.title !== null) properties.jobtitle = person.title;
  return properties;
}

function parseHubSpotResult(value: unknown): HubSpotBatchResult | null {
  if (!isRecord(value) || !isNonEmptyText(value.id, 256) || typeof value.new !== "boolean") return null;
  if (!isRecord(value.properties)) return null;
  return {
    id: value.id,
    isNew: value.new,
    properties: value.properties,
  };
}

function parseHubSpotPayload(value: unknown): HubSpotUpsertPayload | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null;
  const results = value.results.map(parseHubSpotResult);
  if (results.some((result) => result === null)) return null;
  if (value.errors !== undefined && !Array.isArray(value.errors)) return null;
  return {
    results: results as HubSpotBatchResult[],
    errors: (value.errors as readonly unknown[] | undefined) ?? [],
  };
}

function parseHubSpotValidation(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > 1) return null;
  return value.results.every((result) => {
    if (!isRecord(result) || !isNonEmptyText(result.id, 256)) return false;
    return result.properties === undefined || isRecord(result.properties);
  })
    ? value.results.length
    : null;
}

const HUBSPOT_AFTER = /^\d{1,20}$/u;

function contactFullName(properties: Record<string, unknown>): unknown {
  const firstName = properties.firstname;
  const lastName = properties.lastname;
  if (firstName !== undefined && firstName !== null && typeof firstName !== "string") return firstName;
  if (lastName !== undefined && lastName !== null && typeof lastName !== "string") return lastName;
  const parts = [firstName, lastName]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  return parts.length === 0 ? null : parts.join(" ");
}

function normalizeHubSpotContactPage(
  value: unknown,
  limit: number,
  clock: () => number,
): { readonly ok: true; readonly page: ContactPage } | { readonly ok: false; readonly failure: ProviderFailure } {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > limit) {
    return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
  }

  let after: string | null = null;
  if (value.paging !== undefined) {
    if (!isRecord(value.paging) || !isRecord(value.paging.next) || !HUBSPOT_AFTER.test(String(value.paging.next.after))) {
      return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
    }
    if (typeof value.paging.next.after !== "string") {
      return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
    }
    after = value.paging.next.after;
  }

  const contacts = [];
  for (const rawContact of value.results) {
    if (
      !isRecord(rawContact)
      || !isNonEmptyText(rawContact.id, 256)
      || !isRecord(rawContact.properties)
      || !isNonEmptyText(rawContact.updatedAt, 64)
    ) {
      return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
    }
    const normalized = normalizeExternalContact("hubspot", {
      externalId: rawContact.id,
      email: rawContact.properties.email,
      fullName: contactFullName(rawContact.properties),
      organization: rawContact.properties.company,
      title: rawContact.properties.jobtitle,
      sourceVersion: rawContact.updatedAt,
      fieldEvidence: {
        externalId: "id",
        email: "email",
        fullName: ["firstname", "lastname"],
        organization: "company",
        title: "jobtitle",
        sourceVersion: "updatedAt",
      },
    }, clock);
    if (!normalized.ok) return normalized;
    contacts.push(normalized.contact);
  }

  const nextCursor = after === null ? null : encodeProviderContactCursor("hubspot", after);
  return makeContactPage(contacts, nextCursor, limit);
}

/** Normalize the HubSpot v3 email-identity batch-upsert response. */
export function normalizeHubSpotUpsertResponse(
  value: unknown,
  people: readonly NormalizedCanonicalPerson[] | readonly CanonicalPerson[],
  status = 200,
): ProviderResult<BatchUpsertSummary> {
  const payload = parseHubSpotPayload(value);
  if (!payload) {
    return providerFailure("hubspot", "upsert-people", makeProviderFailure("MALFORMED_RESPONSE", { status }));
  }
  if ((status !== 200 && status !== 207) || payload.errors.length > 0) {
    return providerFailure("hubspot", "upsert-people", makeProviderFailure("PROVIDER_REJECTED", { status }));
  }
  if (payload.results.length !== people.length) {
    return providerFailure("hubspot", "upsert-people", makeProviderFailure("MALFORMED_RESPONSE", { status }));
  }

  const byEmail = new Map<string, NormalizedCanonicalPerson | CanonicalPerson>();
  for (const person of people) byEmail.set(person.email.trim().toLowerCase(), person);
  const seenPeople = new Set<string>();
  const records: ProviderRecordResult[] = [];
  for (const result of payload.results) {
    const responseEmail = result.properties.email;
    const person = typeof responseEmail === "string"
      ? byEmail.get(responseEmail.trim().toLowerCase())
      : undefined;
    if (!person || seenPeople.has(person.personId)) {
      return providerFailure("hubspot", "upsert-people", makeProviderFailure("MALFORMED_RESPONSE", { status }));
    }
    seenPeople.add(person.personId);
    records.push({
      personId: person.personId,
      providerRecordId: result.id,
      operation: result.isNew ? "CREATED" : "UPDATED",
    });
  }

  return providerSuccess("hubspot", "upsert-people", {
    requested: people.length,
    created: records.filter((record) => record.operation === "CREATED").length,
    updated: records.filter((record) => record.operation === "UPDATED").length,
    records,
  }, 1);
}

export class HubSpotProvider implements ProviderAdapter {
  readonly provider = "hubspot" as const;

  private readonly config: HubSpotProviderConfig;
  private readonly runtime: ProviderRuntime;
  private readonly configurationError: boolean;

  constructor(config: HubSpotProviderConfig, options: ProviderRuntimeOptions = {}) {
    const resolved = resolveProviderRuntime(options);
    this.config = config;
    this.runtime = resolved.runtime;
    this.configurationError = resolved.configurationError || !validConfig(config);
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
      url: `${HUBSPOT_API_ORIGIN}${HUBSPOT_CONTACTS_PATH}?limit=1&properties=email`,
      allowedOrigin: HUBSPOT_API_ORIGIN,
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
    const recordsRead = parseHubSpotValidation(outcome.body);
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
      (token) => HUBSPOT_AFTER.test(token),
    );
    if (!decodedCursor.ok) return providerFailure(this.provider, "list-contacts", decodedCursor.failure);

    const params = new URLSearchParams();
    params.set("limit", String(normalizedRequest.request.limit));
    params.set("properties", HUBSPOT_CONTACT_READ_PROPERTIES.join(","));
    if (decodedCursor.token !== null) params.set("after", decodedCursor.token);
    const outcome = await requestJson({
      url: `${HUBSPOT_API_ORIGIN}${HUBSPOT_CONTACTS_PATH}?${params.toString()}`,
      allowedOrigin: HUBSPOT_API_ORIGIN,
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.token}`,
      },
      retryable: true,
    }, this.runtime);
    if (!outcome.ok) return providerFailure(this.provider, "list-contacts", outcome.failure, outcome.attempts);

    const normalized = normalizeHubSpotContactPage(
      outcome.body,
      normalizedRequest.request.limit,
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
    const normalized = normalizeCanonicalPeople(people, HUBSPOT_MAX_BATCH_SIZE);
    if (!normalized.ok) return providerFailure(this.provider, "upsert-people", normalized.failure);
    if (normalized.people.length === 0) {
      return providerSuccess(this.provider, "upsert-people", {
        requested: 0,
        created: 0,
        updated: 0,
        records: [],
      }, 0);
    }

    const outcome = await requestJson({
      url: `${HUBSPOT_API_ORIGIN}${HUBSPOT_CONTACTS_PATH}/batch/upsert`,
      allowedOrigin: HUBSPOT_API_ORIGIN,
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: {
        inputs: normalized.people.map((person) => ({
          id: person.email,
          idProperty: "email",
          properties: propertiesFor(person),
        })),
      },
      // HubSpot's email identity makes this batch upsert safe to replay.
      retryable: true,
    }, this.runtime);
    if (!outcome.ok) {
      return providerFailure(this.provider, "upsert-people", outcome.failure, outcome.attempts);
    }
    const normalizedResponse = normalizeHubSpotUpsertResponse(
      outcome.body,
      normalized.people,
      outcome.status,
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

export const HubspotProvider = HubSpotProvider;

export function createHubSpotProvider(
  config: HubSpotProviderConfig,
  options: ProviderRuntimeOptions = {},
): HubSpotProvider {
  return new HubSpotProvider(config, options);
}

export const createHubspotProvider = createHubSpotProvider;
export const createHubSpotClient = createHubSpotProvider;
export const createHubspotClient = createHubSpotProvider;
