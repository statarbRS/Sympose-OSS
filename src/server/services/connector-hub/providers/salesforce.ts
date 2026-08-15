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

export const SALESFORCE_MAX_BATCH_SIZE = 50 as const;
export const DEFAULT_SALESFORCE_API_VERSION = "v60.0" as const;
export const SALESFORCE_CONTACT_READ_FIELDS = Object.freeze([
  "Id",
  "FirstName",
  "LastName",
  "Email",
  "Department",
  "Title",
  "LastModifiedDate",
] as const);

export interface SalesforceProviderConfig {
  readonly token: string;
  /** HTTPS origin only; no path, query, fragment, username, or password is accepted. */
  readonly instanceOrigin: string;
  /** Accepts either "60.0" or "v60.0" and is normalized to the latter form. */
  readonly apiVersion?: string;
}

export type SalesforceConfig = SalesforceProviderConfig;

interface SalesforceQueryRecord {
  readonly id: string;
}

export interface SalesforceQueryResult {
  readonly totalSize: number;
  readonly done: boolean;
  readonly records: readonly SalesforceQueryRecord[];
}

interface SalesforceCreateResult {
  readonly id: string;
}

const SALESFORCE_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.my\.salesforce\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?--[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sandbox\.my\.salesforce\.com|(?:na|eu|ap|cs)\d+\.salesforce\.com)$/u;
const SALESFORCE_API_VERSION = /^v(?:[1-9]\d?)\.0$/u;
const SALESFORCE_API_VERSION_WITHOUT_PREFIX = /^(?:[1-9]\d?)\.0$/u;
const SALESFORCE_RECORD_ID = /^[A-Za-z0-9]{3,64}$/u;

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function safeToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && !/[\u0000-\u001f\u007f\r\n]/u.test(value);
}

function normalizedApiVersion(value: unknown): string | null {
  if (value === undefined) return DEFAULT_SALESFORCE_API_VERSION;
  if (typeof value !== "string") return null;
  if (SALESFORCE_API_VERSION.test(value)) return value;
  if (SALESFORCE_API_VERSION_WITHOUT_PREFIX.test(value)) return `v${value}`;
  return null;
}

function normalizedInstanceOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.port.length > 0
    || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || !SALESFORCE_HOSTNAME.test(parsed.hostname)
  ) {
    return null;
  }
  return parsed.origin;
}

export function isValidSalesforceInstanceOrigin(value: unknown): value is string {
  return normalizedInstanceOrigin(value) !== null;
}

export function normalizeSalesforceInstanceOrigin(value: unknown): string | null {
  return normalizedInstanceOrigin(value);
}

function validConfig(config: unknown): config is SalesforceProviderConfig {
  return isRecord(config)
    && safeToken(config.token)
    && normalizedInstanceOrigin(config.instanceOrigin) !== null
    && normalizedApiVersion(config.apiVersion) !== null;
}

function configVersion(config: SalesforceProviderConfig): string {
  return normalizedApiVersion(config.apiVersion) ?? DEFAULT_SALESFORCE_API_VERSION;
}

function apiRoot(config: SalesforceProviderConfig): string {
  return `${normalizedInstanceOrigin(config.instanceOrigin)}/services/data/${configVersion(config)}`;
}

function escapedSoqlString(value: string): string {
  // Salesforce SOQL string literals use a backslash escape; escape the backslash first.
  return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
}

export function escapeSalesforceSoqlString(value: string): string {
  return escapedSoqlString(value);
}

function queryUrl(config: SalesforceProviderConfig, query: string): string {
  const params = new URLSearchParams({ q: query });
  return `${apiRoot(config)}/query?${params.toString()}`;
}

function parseQueryRecord(value: unknown): SalesforceQueryRecord | null {
  if (!isRecord(value) || !isNonEmptyText(value.Id, 64) || !SALESFORCE_RECORD_ID.test(value.Id)) {
    return null;
  }
  return { id: value.Id };
}

/** Normalize a bounded Salesforce query response; raw provider records never escape this seam. */
export function normalizeSalesforceQueryResponse(value: unknown): SalesforceQueryResult | null {
  const totalSize = isRecord(value) ? value.totalSize : undefined;
  if (
    !isRecord(value)
    || !safeInteger(totalSize)
    || totalSize < 0
    || typeof value.done !== "boolean"
    || !Array.isArray(value.records)
    || value.records.length > 2
  ) {
    return null;
  }
  const records = value.records.map(parseQueryRecord);
  if (
    records.some((record) => record === null)
    || totalSize < records.length
    || (totalSize === 0 && records.length !== 0)
    || (totalSize > 0 && records.length === 0)
  ) return null;
  return { totalSize, done: value.done, records: records as SalesforceQueryRecord[] };
}

function contactFullName(value: Record<string, unknown>): unknown {
  const firstName = value.FirstName;
  const lastName = value.LastName;
  if (firstName !== undefined && firstName !== null && typeof firstName !== "string") return firstName;
  if (lastName !== undefined && lastName !== null && typeof lastName !== "string") return lastName;
  const parts = [firstName, lastName]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  return parts.length === 0 ? null : parts.join(" ");
}

function normalizeSalesforceContactPage(
  value: unknown,
  limit: number,
  clock: () => number,
): { readonly ok: true; readonly page: ContactPage } | { readonly ok: false; readonly failure: ProviderFailure } {
  const maximumRecords = limit + 1;
  if (
    !isRecord(value)
    || !safeInteger(value.totalSize)
    || value.totalSize < 0
    || value.done !== true
    || !Array.isArray(value.records)
    || value.records.length > maximumRecords
    || value.totalSize !== value.records.length
  ) {
    return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
  }

  const contacts = [];
  const identities = new Set<string>();
  for (const rawContact of value.records) {
    if (
      !isRecord(rawContact)
      || !isNonEmptyText(rawContact.Id, 64)
      || !SALESFORCE_RECORD_ID.test(rawContact.Id)
    ) {
      return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
    }
    const normalized = normalizeExternalContact("salesforce", {
      externalId: rawContact.Id,
      email: rawContact.Email,
      fullName: contactFullName(rawContact),
      organization: rawContact.Department,
      title: rawContact.Title,
      sourceVersion: rawContact.LastModifiedDate,
      fieldEvidence: {
        externalId: "Id",
        email: "Email",
        fullName: ["FirstName", "LastName"],
        organization: "Department",
        title: "Title",
        sourceVersion: "LastModifiedDate",
      },
    }, clock);
    if (!normalized.ok) return normalized;
    if (identities.has(normalized.contact.externalIdentity)) {
      return { ok: false, failure: makeProviderFailure("DUPLICATE_EXTERNAL_IDENTITY") };
    }
    identities.add(normalized.contact.externalIdentity);
    contacts.push(normalized.contact);
  }

  const hasMore = contacts.length > limit;
  const returnedContacts = hasMore ? contacts.slice(0, limit) : contacts;
  const lastReturned = returnedContacts.at(-1);
  if (hasMore && !lastReturned) {
    return { ok: false, failure: makeProviderFailure("MALFORMED_RESPONSE") };
  }
  const nextCursor = hasMore
    ? encodeProviderContactCursor("salesforce", lastReturned!.externalId)
    : null;
  return makeContactPage(returnedContacts, nextCursor, limit);
}

function parseCreateResponse(value: unknown): SalesforceCreateResult | null {
  if (!isRecord(value) || !isNonEmptyText(value.id, 64) || !SALESFORCE_RECORD_ID.test(value.id)) return null;
  if (value.success !== undefined && value.success !== true) return null;
  if (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 0)) return null;
  return { id: value.id };
}

function splitName(fullName: string): { readonly firstName: string | null; readonly lastName: string } {
  const parts = fullName.trim().split(/\s+/u).filter(Boolean);
  if (parts.length <= 1) return { firstName: null, lastName: parts[0] ?? fullName };
  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(" ") };
}

function contactPayload(person: NormalizedCanonicalPerson): Record<string, string> {
  const name = splitName(person.fullName);
  const payload: Record<string, string> = {
    LastName: name.lastName,
    Email: person.email,
  };
  if (name.firstName) payload.FirstName = name.firstName;
  if (person.organization !== null) payload.Department = person.organization;
  if (person.title !== null) payload.Title = person.title;
  return payload;
}

function responseFailure(
  outcome: Extract<Awaited<ReturnType<typeof requestJson>>, { readonly ok: false }>,
  attempts: number,
): ReturnType<typeof providerFailure> {
  return providerFailure("salesforce", "upsert-people", outcome.failure, attempts);
}

export class SalesforceProvider implements ProviderAdapter {
  readonly provider = "salesforce" as const;

  private readonly config: SalesforceProviderConfig;
  private readonly runtime: ProviderRuntime;
  private readonly configurationError: boolean;

  constructor(config: SalesforceProviderConfig, options: ProviderRuntimeOptions = {}) {
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
      url: queryUrl(this.config, "SELECT Id FROM Contact LIMIT 1"),
      allowedOrigin: this.config.instanceOrigin,
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
    const query = normalizeSalesforceQueryResponse(outcome.body);
    if (!query || query.totalSize > 1 || query.records.length > 1) {
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
      recordsRead: query.records.length,
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
      (token) => SALESFORCE_RECORD_ID.test(token),
    );
    if (!decodedCursor.ok) return providerFailure(this.provider, "list-contacts", decodedCursor.failure);

    const after = decodedCursor.token === null
      ? ""
      : ` WHERE Id > '${escapedSoqlString(decodedCursor.token)}'`;
    const query = `SELECT ${SALESFORCE_CONTACT_READ_FIELDS.join(", ")} FROM Contact${after} ORDER BY Id LIMIT ${normalizedRequest.request.limit + 1}`;
    const outcome = await requestJson({
      url: queryUrl(this.config, query),
      allowedOrigin: this.config.instanceOrigin,
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.token}`,
      },
      retryable: true,
    }, this.runtime);
    if (!outcome.ok) return providerFailure(this.provider, "list-contacts", outcome.failure, outcome.attempts);

    const normalized = normalizeSalesforceContactPage(
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
    const normalized = normalizeCanonicalPeople(people, SALESFORCE_MAX_BATCH_SIZE);
    if (!normalized.ok) return providerFailure(this.provider, "upsert-people", normalized.failure);
    if (normalized.people.length === 0) {
      return providerSuccess(this.provider, "upsert-people", {
        requested: 0,
        created: 0,
        updated: 0,
        records: [],
      }, 0);
    }

    const records: ProviderRecordResult[] = [];
    let attempts = 0;
    for (const person of normalized.people) {
      const queryOutcome = await requestJson({
        url: queryUrl(
          this.config,
          `SELECT Id FROM Contact WHERE Email = '${escapedSoqlString(person.email)}' LIMIT 2`,
        ),
        allowedOrigin: this.config.instanceOrigin,
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.token}`,
        },
        retryable: true,
      }, this.runtime);
      attempts += queryOutcome.attempts;
      if (!queryOutcome.ok) return responseFailure(queryOutcome, attempts);

      const query = normalizeSalesforceQueryResponse(queryOutcome.body);
      if (!query) {
        return providerFailure(
          this.provider,
          "upsert-people",
          makeProviderFailure("MALFORMED_RESPONSE", { status: queryOutcome.status }),
          attempts,
        );
      }
      if (query.totalSize > 1 || query.records.length > 1) {
        return providerFailure(
          this.provider,
          "upsert-people",
          makeProviderFailure("AMBIGUOUS_MATCH", { status: queryOutcome.status }),
          attempts,
        );
      }

      if (query.records.length === 1) {
        const recordId = query.records[0]?.id;
        if (!recordId) {
          return providerFailure(this.provider, "upsert-people", makeProviderFailure("MALFORMED_RESPONSE"), attempts);
        }
        const updateOutcome = await requestJson({
          url: `${apiRoot(this.config)}/sobjects/Contact/${encodeURIComponent(recordId)}`,
          allowedOrigin: this.config.instanceOrigin,
          method: "PATCH",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.config.token}`,
            "Content-Type": "application/json",
          },
          body: contactPayload(person),
          // PATCH by a validated Salesforce ID is safe to replay.
          retryable: true,
          allowEmptyBody: true,
        }, this.runtime);
        attempts += updateOutcome.attempts;
        if (!updateOutcome.ok) return responseFailure(updateOutcome, attempts);
        if (updateOutcome.status !== 200 && updateOutcome.status !== 204) {
          return providerFailure(
            this.provider,
            "upsert-people",
            makeProviderFailure("PROVIDER_REJECTED", { status: updateOutcome.status }),
            attempts,
          );
        }
        records.push({ personId: person.personId, providerRecordId: recordId, operation: "UPDATED" });
        continue;
      }

      const createOutcome = await requestJson({
        url: `${apiRoot(this.config)}/sobjects/Contact`,
        allowedOrigin: this.config.instanceOrigin,
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: contactPayload(person),
        // A create can be ambiguous after a transport/server failure; never replay it.
        retryable: false,
        ambiguousWrite: true,
      }, this.runtime);
      attempts += createOutcome.attempts;
      if (!createOutcome.ok) return responseFailure(createOutcome, attempts);
      if (createOutcome.status !== 201) {
        return providerFailure(
          this.provider,
          "upsert-people",
          makeProviderFailure("PROVIDER_REJECTED", { status: createOutcome.status }),
          attempts,
        );
      }
      const created = parseCreateResponse(createOutcome.body);
      if (!created) {
        return providerFailure(
          this.provider,
          "upsert-people",
          makeProviderFailure("MALFORMED_RESPONSE", { status: createOutcome.status }),
          attempts,
        );
      }
      records.push({ personId: person.personId, providerRecordId: created.id, operation: "CREATED" });
    }

    return providerSuccess(this.provider, "upsert-people", {
      requested: normalized.people.length,
      created: records.filter((record) => record.operation === "CREATED").length,
      updated: records.filter((record) => record.operation === "UPDATED").length,
      records,
    }, attempts);
  }

  async upsertContacts(people: readonly CanonicalPerson[]): Promise<ProviderResult<BatchUpsertSummary>> {
    return this.upsertPeople(people);
  }
}

export function createSalesforceProvider(
  config: SalesforceProviderConfig,
  options: ProviderRuntimeOptions = {},
): SalesforceProvider {
  return new SalesforceProvider(config, options);
}

export const createSalesforceClient = createSalesforceProvider;
