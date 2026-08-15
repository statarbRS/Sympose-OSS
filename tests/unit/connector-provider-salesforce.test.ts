import { describe, expect, it } from "vitest";

import {
  createSalesforceProvider,
  escapeSalesforceSoqlString,
  isValidSalesforceInstanceOrigin,
  normalizeSalesforceInstanceOrigin,
  type SalesforceProviderConfig,
} from "@/server/services/connector-hub/providers/salesforce";
import type { FetchLike, ProviderRuntimeOptions } from "@/server/services/connector-hub/providers/types";

const CONFIG: SalesforceProviderConfig = {
  token: "salesforce-secret-token",
  instanceOrigin: "https://sympose.my.salesforce.com",
  apiVersion: "60.0",
};

const PEOPLE = [
  {
    personId: "person-ada",
    fullName: "Ada Lovelace",
    email: "o'hara@example.test",
    organization: "Analytical Engines",
    title: "Director",
  },
  {
    personId: "person-grace",
    fullName: "Grace Hopper",
    email: "grace@example.test",
    organization: null,
    title: "Rear Admiral",
  },
] as const;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function runtime(fetchImpl: FetchLike, overrides: Partial<ProviderRuntimeOptions> = {}) {
  const sleeps: number[] = [];
  return {
    fetch: fetchImpl,
    clock: () => Date.parse("2026-08-15T00:00:00.000Z"),
    sleeper: async (delayMs: number) => {
      sleeps.push(delayMs);
    },
    sleeps,
    ...overrides,
  };
}

describe("Salesforce live connector provider adapter", () => {
  it("queries escaped email identities, updates existing contacts, and creates missing contacts", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (init?.method === "GET") {
        const query = new URL(url).searchParams.get("q") ?? "";
        if (query.includes("o\\'hara@example.test")) {
          return jsonResponse(200, {
            totalSize: 1,
            done: true,
            records: [{ Id: "003000000000001AAA" }],
          });
        }
        return jsonResponse(200, { totalSize: 0, done: true, records: [] });
      }
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      return jsonResponse(201, { id: "003000000000002AAA", success: true, errors: [] });
    };
    const adapter = createSalesforceProvider(CONFIG, runtime(fetchImpl));

    const result = await adapter.upsertPeople(PEOPLE);
    expect(result).toMatchObject({
      ok: true,
      value: {
        requested: 2,
        created: 1,
        updated: 1,
        records: [
          { personId: "person-ada", providerRecordId: "003000000000001AAA", operation: "UPDATED" },
          { personId: "person-grace", providerRecordId: "003000000000002AAA", operation: "CREATED" },
        ],
      },
    });
    const query = new URL(calls[0]?.url ?? "").searchParams.get("q") ?? "";
    expect(query).toContain("Email = 'o\\'hara@example.test'");
    expect(escapeSalesforceSoqlString("o'hara\\example.test")).toBe("o\\'hara\\\\example.test");
    expect(calls[0]?.url).toMatch(/^https:\/\/sympose\.my\.salesforce\.com\/services\/data\/v60\.0\/query\?/u);
    expect(calls[1]?.url).toBe(
      "https://sympose.my.salesforce.com/services/data/v60.0/sobjects/Contact/003000000000001AAA",
    );
    expect(calls[2]?.url).toMatch(
      /^https:\/\/sympose\.my\.salesforce\.com\/services\/data\/v60\.0\/query\?/u,
    );
    expect(calls[3]?.url).toBe(
      "https://sympose.my.salesforce.com/services/data/v60.0/sobjects/Contact",
    );
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      LastName: "Lovelace",
      FirstName: "Ada",
      Email: "o'hara@example.test",
      Department: "Analytical Engines",
      Title: "Director",
    });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
      LastName: "Hopper",
      FirstName: "Grace",
      Email: "grace@example.test",
      Title: "Rear Admiral",
    });
    expect(calls[3]?.init.headers).toMatchObject({ Authorization: "Bearer salesforce-secret-token" });
  });

  it("validates with a bounded query and normalizes authentication failure without response leakage", async () => {
    const valid = await createSalesforceProvider(
      CONFIG,
      runtime(async () => jsonResponse(200, {
        totalSize: 0,
        done: true,
        records: [],
      })),
    ).validateConnection();
    expect(valid).toMatchObject({ ok: true, value: { connected: true, boundedRead: true, recordsRead: 0 } });

    const auth = await createSalesforceProvider(
      CONFIG,
      runtime(async () => jsonResponse(401, { error: "invalid_session", token: "salesforce-secret-token" })),
    ).validateConnection();
    expect(auth).toMatchObject({ ok: false, failure: { code: "AUTHENTICATION_FAILED", status: 401 } });
    if (!auth.ok) {
      expect(auth.failure.message).not.toContain("salesforce-secret-token");
      expect(JSON.stringify(auth)).not.toContain("invalid_session");
    }
  });

  it("honors 429 Retry-After on reads but never retries an ambiguous Salesforce create", async () => {
    let calls = 0;
    const retryRuntime = runtime(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(429, { error: "rate" }, { "retry-after": "4" });
      return jsonResponse(200, { totalSize: 0, done: true, records: [] });
    }, { maxRetries: 1 });
    const retried = await createSalesforceProvider(CONFIG, retryRuntime).validateConnection();
    expect(retried).toMatchObject({ ok: true, attempts: 2 });
    expect(retryRuntime.sleeps).toEqual([4_000]);

    const writeCalls: string[] = [];
    const noRetryRuntime = runtime(async (input, init) => {
      writeCalls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "GET") return jsonResponse(200, { totalSize: 0, done: true, records: [] });
      return jsonResponse(503, { error: "temporary" });
    }, { maxRetries: 5 });
    const failedCreate = await createSalesforceProvider(CONFIG, noRetryRuntime).upsertPeople([PEOPLE[1]!]);
    expect(failedCreate).toMatchObject({ ok: false, attempts: 2, failure: {
      code: "PROVIDER_UNAVAILABLE",
      status: 503,
      retryable: false,
      ambiguous: true,
    } });
    expect(writeCalls).toHaveLength(2);
    expect(noRetryRuntime.sleeps).toEqual([]);
  });

  it("rejects malformed and oversized responses and enforces strict origin/version configuration", async () => {
    const malformed = await createSalesforceProvider(
      CONFIG,
      runtime(async () => jsonResponse(200, { totalSize: "0", done: true, records: [] })),
    ).validateConnection();
    expect(malformed).toMatchObject({ ok: false, failure: { code: "MALFORMED_RESPONSE" } });

    const oversized = await createSalesforceProvider(
      CONFIG,
      runtime(async () => new Response("x".repeat(128), { status: 200 }), { maxResponseBytes: 32 }),
    ).validateConnection();
    expect(oversized).toMatchObject({ ok: false, failure: { code: "RESPONSE_TOO_LARGE" } });

    expect(isValidSalesforceInstanceOrigin("https://sympose.my.salesforce.com")).toBe(true);
    expect(isValidSalesforceInstanceOrigin("https://sympose--dev.sandbox.my.salesforce.com")).toBe(true);
    expect(normalizeSalesforceInstanceOrigin("https://sympose.my.salesforce.com/path")).toBeNull();

    const invalidValues = [
      "http://sympose.my.salesforce.com",
      "https://user:password@sympose.my.salesforce.com",
      "https://sympose.my.salesforce.com/services/data/v60.0",
      "https://sympose.my.salesforce.com.evil.example.test",
    ];
    for (const instanceOrigin of invalidValues) {
      const adapter = createSalesforceProvider({ ...CONFIG, instanceOrigin });
      const result = await adapter.validateConnection();
      expect(result).toMatchObject({ ok: false, failure: { code: "CONFIGURATION_INVALID" } });
    }

    const badVersion = createSalesforceProvider({ ...CONFIG, apiVersion: "v60.0/../../evil" });
    expect(await badVersion.validateConnection()).toMatchObject({
      ok: false,
      failure: { code: "CONFIGURATION_INVALID" },
    });
  });

  it("reads bounded Salesforce contact pages with validated ID keyset cursors", async () => {
    const calls: string[] = [];
    const firstRecord = {
      Id: "003000000000001AAA",
      FirstName: " Ada ",
      LastName: " Lovelace ",
      Email: "ADA@EXAMPLE.TEST",
      Department: "Analytical Engines",
      Title: "Director",
      LastModifiedDate: "2026-08-14T12:00:00Z",
    };
    const secondRecord = {
      Id: "003000000000002AAA",
      FirstName: "Grace",
      LastName: "Hopper",
      Email: null,
      Department: null,
      Title: "Rear Admiral",
      LastModifiedDate: "2026-08-14T13:00:00.000Z",
    };
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      const query = new URL(url).searchParams.get("q") ?? "";
      if (!query.includes("WHERE Id >")) {
        return jsonResponse(200, { totalSize: 2, done: true, records: [firstRecord, secondRecord] });
      }
      return jsonResponse(200, { totalSize: 1, done: true, records: [secondRecord] });
    };
    const adapter = createSalesforceProvider(CONFIG, runtime(fetchImpl));

    const first = await adapter.listContacts({ limit: 1 });
    expect(first).toMatchObject({
      ok: true,
      value: {
        hasMore: true,
        limit: 1,
        contacts: [{
          provider: "salesforce",
          externalIdentity: "salesforce:003000000000001AAA",
          email: "ada@example.test",
          fullName: "Ada Lovelace",
          sourceVersion: "2026-08-14T12:00:00.000Z",
          sourceEvidence: {
            observedAt: "2026-08-15T00:00:00.000Z",
            fields: { externalId: "Id", sourceVersion: "LastModifiedDate" },
          },
        }],
      },
    });
    if (!first.ok) return;
    const second = await adapter.readContacts({ limit: 1, cursor: first.value.nextCursor });
    expect(second).toMatchObject({
      ok: true,
      value: { hasMore: false, contacts: [{ externalId: "003000000000002AAA", email: null }] },
    });

    const firstQuery = new URL(calls[0]!).searchParams.get("q") ?? "";
    expect(firstQuery).toBe(
      "SELECT Id, FirstName, LastName, Email, Department, Title, LastModifiedDate FROM Contact ORDER BY Id LIMIT 2",
    );
    const secondQuery = new URL(calls[1]!).searchParams.get("q") ?? "";
    expect(secondQuery).toContain("WHERE Id > '003000000000001AAA' ORDER BY Id LIMIT 2");
    for (const call of calls) expect(new URL(call).origin).toBe(CONFIG.instanceOrigin);
  });

  it("rejects unsafe Salesforce cursors, duplicate identities, malformed pages, auth, and oversized reads", async () => {
    let fetches = 0;
    const adapter = createSalesforceProvider(CONFIG, runtime(async () => {
      fetches += 1;
      return jsonResponse(200, { totalSize: 0, done: true, records: [] });
    }));
    const injected = await adapter.listContacts({
      cursor: "sympose.v1.salesforce.https%3A%2F%2Fevil.example%2Fquery",
    });
    expect(injected).toMatchObject({ ok: false, failure: { code: "CURSOR_INVALID" } });
    const crossProvider = await adapter.listContacts({ cursor: "sympose.v1.hubspot.123" });
    expect(crossProvider).toMatchObject({ ok: false, failure: { code: "CURSOR_INVALID" } });
    expect(fetches).toBe(0);

    const duplicateRecord = {
      Id: "003000000000001AAA",
      FirstName: "Ada",
      LastName: "Lovelace",
      Email: "ada@example.test",
      Department: null,
      Title: null,
      LastModifiedDate: "2026-08-14T12:00:00Z",
    };
    const duplicate = await createSalesforceProvider(CONFIG, runtime(async () => jsonResponse(200, {
      totalSize: 2,
      done: true,
      records: [duplicateRecord, duplicateRecord],
    }))).listContacts({ limit: 1 });
    expect(duplicate).toMatchObject({ ok: false, failure: { code: "DUPLICATE_EXTERNAL_IDENTITY" } });

    const malformed = await createSalesforceProvider(CONFIG, runtime(async () => jsonResponse(200, {
      totalSize: 1,
      done: false,
      records: [duplicateRecord],
      nextRecordsUrl: "https://attacker.example/query/next",
    }))).listContacts();
    expect(malformed).toMatchObject({ ok: false, failure: { code: "MALFORMED_RESPONSE" } });

    const auth = await createSalesforceProvider(
      CONFIG,
      runtime(async () => jsonResponse(401, { token: "salesforce-secret-token" })),
    ).listContacts();
    expect(auth).toMatchObject({ ok: false, failure: { code: "AUTHENTICATION_FAILED", redacted: true } });
    expect(JSON.stringify(auth)).not.toContain("salesforce-secret-token");

    const oversized = await createSalesforceProvider(
      CONFIG,
      runtime(async () => new Response("x".repeat(128), { status: 200 }), { maxResponseBytes: 32 }),
    ).listContacts();
    expect(oversized).toMatchObject({ ok: false, failure: { code: "RESPONSE_TOO_LARGE" } });
  });
});
