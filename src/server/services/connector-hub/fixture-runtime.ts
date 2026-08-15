import "server-only";

import type { ConnectorProviderId } from "./contracts";
import type { FetchLike, ProviderRuntimeOptions } from "./providers";
import { sha256Hex } from "../../canonical";
import { requireRuntimeDataMode } from "../../runtime-mode";

export const CONNECTOR_EXECUTION_MODE_ENV = "SYMPOSE_CONNECTOR_EXECUTION_MODE" as const;
export const CONNECTOR_FIXTURE_EXECUTION_MODE = "fixture-http" as const;

type FixtureRuntimeSource = "test-injected" | "repository-synthetic";

export interface ConnectorFixtureRuntime extends ProviderRuntimeOptions {
  readonly dataMode: "synthetic-evaluator";
  readonly fetch: FetchLike;
  readonly provider: ConnectorProviderId;
  readonly transportContract: "public-synthetic-fixture/v1";
  readonly source: FixtureRuntimeSource;
}

const issuedRuntimes = new WeakSet<object>();

function issueRuntime(
  provider: ConnectorProviderId,
  source: FixtureRuntimeSource,
  fetch: FetchLike,
  options: Omit<ProviderRuntimeOptions, "fetch"> = {},
): ConnectorFixtureRuntime {
  const runtime = Object.freeze({
    ...options,
    dataMode: "synthetic-evaluator" as const,
    provider,
    fetch,
    source,
    transportContract: "public-synthetic-fixture/v1" as const,
  });
  issuedRuntimes.add(runtime);
  return runtime;
}

/** Test-only arbitrary transport injection. Application runtime cannot use this factory. */
export function createConnectorFixtureRuntime(
  provider: ConnectorProviderId,
  fetch: FetchLike,
  options: Omit<ProviderRuntimeOptions, "fetch"> = {},
): ConnectorFixtureRuntime {
  if (
    typeof fetch !== "function" ||
    (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true")
  ) {
    throw new Error("CONNECTOR_FIXTURE_RUNTIME_DENIED");
  }
  return issueRuntime(provider, "test-injected", fetch, options);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> | null {
  if (typeof init?.body !== "string" || init.body.length > 64 * 1024) return null;
  try {
    const parsed = JSON.parse(init.body) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function syntheticIdentifier(prefix: string, value: unknown): string {
  const text = typeof value === "string" ? value : "missing";
  return `${prefix}${sha256Hex(text)}`;
}

function fixtureRequestAllowed(
  provider: ConnectorProviderId,
  url: URL,
  init: RequestInit | undefined,
): boolean {
  if (url.protocol !== "https:" || init?.redirect !== "error") return false;
  const authorization = new Headers(init.headers).get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  if (provider === "airtable") return url.origin === "https://api.airtable.com";
  if (provider === "hubspot") return url.origin === "https://api.hubapi.com";
  return url.port === "" && (
    url.hostname.endsWith(".salesforce.com") ||
    url.hostname.endsWith(".force.com") ||
    url.hostname.endsWith(".salesforce.mil")
  );
}

const FIXTURE_CONTACTS = Object.freeze({
  airtable: [
    {
      id: "recSynthetic001",
      fields: {
        email: "ada.fixture@example.test",
        full_name: "Ada Fixture",
        organization: "Public Synthetic Lab",
        title: "Organizer",
      },
      createdTime: "2026-08-15T00:00:00.000Z",
    },
    {
      id: "recSynthetic002",
      fields: {
        email: "shared.fixture@example.test",
        full_name: "Airtable Collision One",
        organization: "Public Synthetic Lab",
        title: "Reviewer",
      },
      createdTime: "2026-08-15T00:01:00.000Z",
    },
    {
      id: "recSynthetic003",
      fields: {
        email: "shared.fixture@example.test",
        full_name: "Airtable Collision Two",
        organization: "Public Synthetic Lab",
        title: "Reviewer",
      },
      createdTime: "2026-08-15T00:02:00.000Z",
    },
  ],
  hubspot: [
    {
      id: "synthetic-hubspot-001",
      properties: {
        email: "grace.fixture@example.test",
        firstname: "Grace",
        lastname: "Fixture",
        company: "Public Synthetic Lab",
        jobtitle: "Program Lead",
      },
      updatedAt: "2026-08-15T00:03:00.000Z",
    },
    {
      id: "synthetic-hubspot-002",
      properties: {
        email: "lin.fixture@example.test",
        firstname: "Lin",
        lastname: "Fixture",
        company: "Public Synthetic Lab",
        jobtitle: "Speaker",
      },
      updatedAt: "2026-08-15T00:04:00.000Z",
    },
  ],
  salesforce: [
    {
      Id: "003000000000001AAA",
      FirstName: "Katherine",
      LastName: "Fixture",
      Email: "katherine.fixture@example.test",
      Department: "Public Synthetic Lab",
      Title: "Analyst",
      LastModifiedDate: "2026-08-15T00:05:00.000Z",
    },
    {
      Id: "003000000000002AAA",
      FirstName: "Edsger",
      LastName: "Fixture",
      Email: "edsger.fixture@example.test",
      Department: "Public Synthetic Lab",
      Title: "Reviewer",
      LastModifiedDate: "2026-08-15T00:06:00.000Z",
    },
  ],
});

function airtableFixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (!fixtureRequestAllowed("airtable", url, init)) return Promise.resolve(jsonResponse({}, 404));
  if (init?.method === "GET") {
    if (!url.searchParams.has("fields[]")) {
      return Promise.resolve(jsonResponse({ records: [{ id: "recSyntheticValidation" }] }));
    }
    if (url.searchParams.get("offset") === null) {
      return Promise.resolve(jsonResponse({
        records: FIXTURE_CONTACTS.airtable.slice(0, 2),
        offset: "synthetic-page-2",
      }));
    }
    if (url.searchParams.get("offset") === "synthetic-page-2") {
      return Promise.resolve(jsonResponse({ records: FIXTURE_CONTACTS.airtable.slice(2) }));
    }
    return Promise.resolve(jsonResponse({}, 400));
  }
  if (init?.method === "PATCH") {
    const body = requestBody(init);
    const records = Array.isArray(body?.records) ? body.records : null;
    if (!records || records.length > 10) return Promise.resolve(jsonResponse({}, 400));
    const returned = records.map((record) => {
      const fields = record !== null && typeof record === "object" && !Array.isArray(record)
        ? (record as { readonly fields?: unknown }).fields
        : {};
      const personId = fields !== null && typeof fields === "object" && !Array.isArray(fields)
        ? (fields as Record<string, unknown>).person_id
        : null;
      return {
        id: syntheticIdentifier("recSynthetic", personId),
        fields,
      };
    });
    return Promise.resolve(jsonResponse({
      records: returned,
      createdRecords: returned.map((record) => record.id),
      updatedRecords: [],
    }));
  }
  return Promise.resolve(jsonResponse({}, 405));
}

function hubspotFixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (!fixtureRequestAllowed("hubspot", url, init)) return Promise.resolve(jsonResponse({}, 404));
  if (init?.method === "GET") {
    if (url.searchParams.get("properties") === "email") {
      return Promise.resolve(jsonResponse({ results: [{ id: "synthetic-validation", properties: {} }] }));
    }
    if (url.searchParams.get("after") === null) {
      return Promise.resolve(jsonResponse({
        results: FIXTURE_CONTACTS.hubspot.slice(0, 1),
        paging: { next: { after: "2" } },
      }));
    }
    if (url.searchParams.get("after") === "2") {
      return Promise.resolve(jsonResponse({ results: FIXTURE_CONTACTS.hubspot.slice(1) }));
    }
    return Promise.resolve(jsonResponse({}, 400));
  }
  if (init?.method === "POST" && url.pathname.endsWith("/batch/upsert")) {
    const body = requestBody(init);
    const inputs = Array.isArray(body?.inputs) ? body.inputs : null;
    if (!inputs || inputs.length > 100) return Promise.resolve(jsonResponse({}, 400));
    const results = inputs.map((inputValue, index) => {
      const inputRecord = inputValue !== null && typeof inputValue === "object" && !Array.isArray(inputValue)
        ? inputValue as { readonly id?: unknown; readonly properties?: unknown }
        : {};
      const properties = inputRecord.properties !== null && typeof inputRecord.properties === "object"
        ? inputRecord.properties as Record<string, unknown>
        : {};
      return {
        id: `synthetic-hubspot-export-${index + 1}-${String(inputRecord.id ?? "missing")}`,
        new: true,
        properties: { ...properties, email: inputRecord.id },
      };
    }).reverse();
    return Promise.resolve(jsonResponse({ results, errors: [] }));
  }
  return Promise.resolve(jsonResponse({}, 405));
}

function salesforceFixtureFetch(): FetchLike {
  const recordsByEmail = new Map<string, string>();
  return (input, init) => {
    const url = new URL(String(input));
    if (!fixtureRequestAllowed("salesforce", url, init)) return Promise.resolve(jsonResponse({}, 404));
    if (init?.method === "GET" && url.pathname.endsWith("/query")) {
      const query = url.searchParams.get("q") ?? "";
      if (query === "SELECT Id FROM Contact LIMIT 1") {
        return Promise.resolve(jsonResponse({ totalSize: 0, done: true, records: [] }));
      }
      const emailMatch = /WHERE Email = '([^']+)'/u.exec(query);
      if (emailMatch) {
        const id = recordsByEmail.get(emailMatch[1]!.toLowerCase());
        return Promise.resolve(jsonResponse({
          totalSize: id ? 1 : 0,
          done: true,
          records: id ? [{ Id: id }] : [],
        }));
      }
      const cursorMatch = /WHERE Id > '([A-Za-z0-9]+)'/u.exec(query);
      const records = cursorMatch
        ? FIXTURE_CONTACTS.salesforce.filter((record) => record.Id > cursorMatch[1]!)
        : FIXTURE_CONTACTS.salesforce;
      return Promise.resolve(jsonResponse({ totalSize: records.length, done: true, records }));
    }
    if (init?.method === "POST" && url.pathname.endsWith("/sobjects/Contact")) {
      const body = requestBody(init);
      const email = typeof body?.Email === "string" ? body.Email.toLowerCase() : null;
      if (!email) return Promise.resolve(jsonResponse({}, 400));
      const id = `003${sha256Hex(email).slice(0, 15)}`;
      recordsByEmail.set(email, id);
      return Promise.resolve(jsonResponse({ id, success: true, errors: [] }, 201));
    }
    if (init?.method === "PATCH" && /\/sobjects\/Contact\/[A-Za-z0-9]{15,18}$/u.test(url.pathname)) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse({}, 405));
  };
}

/**
 * Application-visible fixture runtime. Its fetch implementation is closed over here and can only
 * return bounded, public synthetic data; it never delegates to global fetch or another transport.
 */
export function createSyntheticConnectorFixtureRuntime(
  provider: ConnectorProviderId,
): ConnectorFixtureRuntime {
  const mode = requireRuntimeDataMode();
  if (
    mode !== "synthetic-evaluator" ||
    process.env[CONNECTOR_EXECUTION_MODE_ENV] !== CONNECTOR_FIXTURE_EXECUTION_MODE
  ) {
    throw new Error("CONNECTOR_FIXTURE_RUNTIME_DENIED");
  }
  const fetch = provider === "airtable"
    ? airtableFixtureFetch
    : provider === "hubspot"
      ? hubspotFixtureFetch
      : salesforceFixtureFetch();
  return issueRuntime(provider, "repository-synthetic", fetch, {
    maxRetries: 0,
    maxResponseBytes: 64 * 1024,
    timeoutMs: 2_000,
  });
}

export function syntheticConnectorFixtureEnabled(): boolean {
  try {
    const mode = requireRuntimeDataMode();
    return mode === "synthetic-evaluator" &&
      process.env[CONNECTOR_EXECUTION_MODE_ENV] === CONNECTOR_FIXTURE_EXECUTION_MODE;
  } catch {
    return false;
  }
}

export function assertConnectorFixtureRuntime(
  value: unknown,
  provider: ConnectorProviderId,
): asserts value is ConnectorFixtureRuntime {
  if (
    value === null || typeof value !== "object" || !issuedRuntimes.has(value) ||
    (value as ConnectorFixtureRuntime).dataMode !== "synthetic-evaluator" ||
    (value as ConnectorFixtureRuntime).provider !== provider ||
    (value as ConnectorFixtureRuntime).transportContract !== "public-synthetic-fixture/v1" ||
    ((value as ConnectorFixtureRuntime).source !== "test-injected" &&
      (value as ConnectorFixtureRuntime).source !== "repository-synthetic") ||
    typeof (value as ConnectorFixtureRuntime).fetch !== "function"
  ) {
    throw new Error("CONNECTOR_FIXTURE_RUNTIME_DENIED");
  }
}
