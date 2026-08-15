import { describe, expect, it } from "vitest";

import {
  createHubSpotProvider,
  HUBSPOT_API_ORIGIN,
  HUBSPOT_CONTACTS_PATH,
  type HubSpotProviderConfig,
} from "@/server/services/connector-hub/providers/hubspot";
import { requestJson } from "@/server/services/connector-hub/providers/http";
import type { FetchLike, ProviderRuntimeOptions } from "@/server/services/connector-hub/providers/types";

const PERSON = {
  personId: "person-grace",
  fullName: "Grace Hopper",
  email: "Grace@example.test",
  organization: "Navy Computing",
  title: "Rear Admiral",
};

const CONFIG: HubSpotProviderConfig = { token: "hubspot-secret-token" };

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

describe("HubSpot live connector provider adapter", () => {
  it("uses a bounded contacts read and email-identity v3 batch upsert", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (init?.method === "GET") return jsonResponse(200, { results: [] });
      return jsonResponse(200, {
        results: [{
          id: "contact-42",
          new: true,
          properties: { email: "grace@example.test" },
        }],
        errors: [],
      });
    };
    const adapter = createHubSpotProvider(CONFIG, runtime(fetchImpl));

    const validation = await adapter.validateConnection();
    expect(validation).toMatchObject({ ok: true, value: { connected: true, boundedRead: true, recordsRead: 0 } });
    expect(calls[0]?.url).toBe(`${HUBSPOT_API_ORIGIN}${HUBSPOT_CONTACTS_PATH}?limit=1&properties=email`);

    const result = await adapter.upsertContacts([PERSON]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        requested: 1,
        created: 1,
        updated: 0,
        records: [{ personId: "person-grace", providerRecordId: "contact-42", operation: "CREATED" }],
      },
    });
    expect(calls[1]?.url).toBe(`${HUBSPOT_API_ORIGIN}${HUBSPOT_CONTACTS_PATH}/batch/upsert`);
    const body = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      inputs: [{
        id: "grace@example.test",
        idProperty: "email",
        properties: {
          email: "grace@example.test",
          firstname: "Grace",
          lastname: "Hopper",
          company: "Navy Computing",
          jobtitle: "Rear Admiral",
        },
      }],
    });
    expect(calls[1]?.init.headers).toMatchObject({ Authorization: "Bearer hubspot-secret-token" });
  });

  it("normalizes auth failures, malformed bodies, and partial batch errors as typed redacted failures", async () => {
    const auth = await createHubSpotProvider(
      CONFIG,
      runtime(async () => jsonResponse(403, { message: "hubspot-secret-token leaked by provider" })),
    ).validateConnection();
    expect(auth).toMatchObject({ ok: false, failure: { code: "AUTHORIZATION_FAILED", status: 403 } });
    if (!auth.ok) {
      expect(auth.failure.message).not.toContain("hubspot-secret-token");
      expect(JSON.stringify(auth)).not.toContain("leaked");
    }

    const malformed = await createHubSpotProvider(
      CONFIG,
      runtime(async () => jsonResponse(200, { results: [{ id: "contact-1" }] })),
    ).upsertPeople([PERSON]);
    expect(malformed).toMatchObject({ ok: false, failure: { code: "MALFORMED_RESPONSE" } });

    const partial = await createHubSpotProvider(
      CONFIG,
      runtime(async () => jsonResponse(207, {
        results: [],
        errors: [{ status: "VALIDATION_ERROR", message: "private detail" }],
      })),
    ).upsertPeople([PERSON]);
    expect(partial).toMatchObject({ ok: false, failure: { code: "PROVIDER_REJECTED", status: 207 } });
    expect(JSON.stringify(partial)).not.toContain("private detail");
  });

  it("correlates reordered upsert results only by echoed normalized email and rejects a missing correlation", async () => {
    const ada = {
      personId: "person-ada",
      fullName: "Ada Lovelace",
      email: "Ada@example.test",
      organization: "Analytical Engines",
      title: "Director",
    };
    const reordered = await createHubSpotProvider(CONFIG, runtime(async () => jsonResponse(200, {
      results: [
        { id: "contact-ada", new: false, properties: { email: "ada@example.test" } },
        { id: "contact-grace", new: true, properties: { email: "GRACE@EXAMPLE.TEST" } },
      ],
      errors: [],
    }))).upsertPeople([PERSON, ada]);
    expect(reordered).toMatchObject({
      ok: true,
      value: {
        records: [
          { personId: "person-ada", providerRecordId: "contact-ada", operation: "UPDATED" },
          { personId: "person-grace", providerRecordId: "contact-grace", operation: "CREATED" },
        ],
      },
    });

    const missingEmail = await createHubSpotProvider(CONFIG, runtime(async () => jsonResponse(200, {
      results: [{ id: "contact-grace", new: true, properties: {} }],
      errors: [],
    }))).upsertPeople([PERSON]);
    expect(missingEmail).toMatchObject({ ok: false, failure: { code: "MALFORMED_RESPONSE", redacted: true } });
  });

  it("denies redirects, changed response origins, malformed UTF-8, and caller-selected origins without retry", async () => {
    const outcome = async (response: Response) => createHubSpotProvider(
      CONFIG,
      runtime(async () => response, { maxRetries: 5 }),
    ).validateConnection();

    const redirectedResponse = jsonResponse(200, { results: [] });
    Object.defineProperty(redirectedResponse, "redirected", { value: true });
    const redirected = await outcome(redirectedResponse);
    expect(redirected).toMatchObject({ ok: false, attempts: 1, failure: { code: "NETWORK_ERROR", redacted: true } });

    const changedOriginResponse = jsonResponse(200, { results: [] });
    Object.defineProperty(changedOriginResponse, "url", { value: "https://attacker.example.test/contacts" });
    const changedOrigin = await outcome(changedOriginResponse);
    expect(changedOrigin).toMatchObject({ ok: false, attempts: 1, failure: { code: "NETWORK_ERROR", redacted: true } });
    expect(JSON.stringify(changedOrigin)).not.toContain("attacker.example.test");

    const invalidUtf8 = await outcome(new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    expect(invalidUtf8).toMatchObject({ ok: false, attempts: 1, failure: { code: "MALFORMED_RESPONSE", redacted: true } });

    let fetches = 0;
    const originMismatch = await requestJson({
      url: "https://attacker.example.test/contacts",
      allowedOrigin: HUBSPOT_API_ORIGIN,
      method: "GET",
      headers: { Authorization: "Bearer synthetic-secret" },
      retryable: true,
    }, runtime(async () => {
      fetches += 1;
      return jsonResponse(200, { results: [] });
    }));
    expect(originMismatch).toMatchObject({ ok: false, attempts: 0, failure: { code: "CONFIGURATION_INVALID", redacted: true } });
    expect(fetches).toBe(0);
    expect(JSON.stringify(originMismatch)).not.toContain("synthetic-secret");
  });

  it("honors 429 Retry-After, bounds 5xx retries, and never widens the fixed host", async () => {
    let calls = 0;
    const retryRuntime = runtime(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(429, { message: "rate" }, { "retry-after": "3" });
      return jsonResponse(200, { results: [] });
    }, { maxRetries: 1 });
    const retried = await createHubSpotProvider(CONFIG, retryRuntime).validateConnection();
    expect(retried).toMatchObject({ ok: true, attempts: 2 });
    expect(retryRuntime.sleeps).toEqual([3_000]);

    calls = 0;
    const unavailableRuntime = runtime(async () => {
      calls += 1;
      return jsonResponse(502, { message: "temporary" });
    }, { maxRetries: 2 });
    const unavailable = await createHubSpotProvider(CONFIG, unavailableRuntime).validateConnection();
    expect(unavailable).toMatchObject({ ok: false, attempts: 3, failure: { code: "PROVIDER_UNAVAILABLE" } });
    expect(unavailableRuntime.sleeps).toEqual([250, 500]);

    const callsForInjection: string[] = [];
    const ignoredBaseUrl = createHubSpotProvider({
      ...CONFIG,
      baseUrl: "https://attacker.example.test/crm/v3/objects/contacts",
    } as HubSpotProviderConfig & { baseUrl: string }, runtime(async (input) => {
      callsForInjection.push(String(input));
      return jsonResponse(200, { results: [] });
    }));
    await ignoredBaseUrl.validateConnection();
    expect(callsForInjection[0]).toMatch(/^https:\/\/api\.hubapi\.com\//u);
    expect(callsForInjection[0]).not.toContain("attacker.example.test");
  });

  it("caps response bytes and rejects unsafe runtime configuration before fetch", async () => {
    const oversized = await createHubSpotProvider(
      CONFIG,
      runtime(async () => new Response("x".repeat(128), { status: 200 }), { maxResponseBytes: 32 }),
    ).validateConnection();
    expect(oversized).toMatchObject({ ok: false, failure: { code: "RESPONSE_TOO_LARGE" } });

    let fetches = 0;
    const invalid = createHubSpotProvider(
      CONFIG,
      runtime(async () => {
        fetches += 1;
        return jsonResponse(200, { results: [] });
      }, { maxRetries: 99 }),
    );
    const result = await invalid.validateConnection();
    expect(result).toMatchObject({ ok: false, failure: { code: "CONFIGURATION_INVALID" } });
    expect(fetches).toBe(0);
  });

  it("reads normalized HubSpot contact pages without following provider links", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      if (new URL(url).searchParams.get("after") === null) {
        return jsonResponse(200, {
          results: [{
            id: "101",
            updatedAt: "2026-08-14T10:30:00Z",
            properties: {
              email: "GRACE@EXAMPLE.TEST",
              firstname: " Grace ",
              lastname: " Hopper ",
              company: "Navy Computing",
              jobtitle: "Rear Admiral",
            },
          }],
          paging: { next: { after: "202", link: "https://attacker.example/contacts?after=202" } },
        });
      }
      return jsonResponse(200, {
        results: [{
          id: "202",
          updatedAt: "2026-08-14T11:30:00.000Z",
          properties: { email: null, firstname: "Ada", lastname: "Lovelace" },
        }],
      });
    };
    const adapter = createHubSpotProvider(CONFIG, runtime(fetchImpl));

    const first = await adapter.listContacts({ limit: 1 });
    expect(first).toMatchObject({
      ok: true,
      value: {
        hasMore: true,
        contacts: [{
          externalIdentity: "hubspot:101",
          email: "grace@example.test",
          fullName: "Grace Hopper",
          organization: "Navy Computing",
          sourceVersion: "2026-08-14T10:30:00.000Z",
          sourceEvidence: { fields: { fullName: ["firstname", "lastname"], sourceVersion: "updatedAt" } },
        }],
      },
    });
    if (!first.ok) return;
    const second = await adapter.listContacts({ limit: 1, cursor: first.value.nextCursor });
    expect(second).toMatchObject({
      ok: true,
      value: { hasMore: false, contacts: [{ externalId: "202", email: null }] },
    });
    for (const call of calls) expect(new URL(call).origin).toBe(HUBSPOT_API_ORIGIN);
    expect(new URL(calls[0]!).searchParams.get("properties")).toBe(
      "email,firstname,lastname,company,jobtitle",
    );
    expect(new URL(calls[1]!).searchParams.get("after")).toBe("202");
    expect(calls.join(" ")).not.toContain("attacker.example");
  });

  it("rejects unsafe HubSpot cursors, duplicate identities, malformed pages, auth, and oversized reads", async () => {
    let fetches = 0;
    const adapter = createHubSpotProvider(CONFIG, runtime(async () => {
      fetches += 1;
      return jsonResponse(200, { results: [] });
    }));
    const crossProvider = await adapter.listContacts({ cursor: "sympose.v1.airtable.123" });
    expect(crossProvider).toMatchObject({ ok: false, failure: { code: "CURSOR_INVALID" } });
    const injected = await adapter.listContacts({ cursor: "sympose.v1.hubspot.https%3A%2F%2Fevil.example" });
    expect(injected).toMatchObject({ ok: false, failure: { code: "CURSOR_INVALID" } });
    expect(fetches).toBe(0);

    const duplicateRecord = {
      id: "100",
      updatedAt: "2026-08-14T10:00:00Z",
      properties: { email: "duplicate@example.test" },
    };
    const duplicate = await createHubSpotProvider(CONFIG, runtime(async () => jsonResponse(200, {
      results: [duplicateRecord, duplicateRecord],
    }))).listContacts({ limit: 2 });
    expect(duplicate).toMatchObject({ ok: false, failure: { code: "DUPLICATE_EXTERNAL_IDENTITY" } });

    const malformed = await createHubSpotProvider(CONFIG, runtime(async () => jsonResponse(200, {
      results: [],
      paging: { next: { after: "../contacts" } },
    }))).listContacts();
    expect(malformed).toMatchObject({ ok: false, failure: { code: "MALFORMED_RESPONSE" } });

    const auth = await createHubSpotProvider(
      CONFIG,
      runtime(async () => jsonResponse(403, { secret: "hubspot-secret-token" })),
    ).listContacts();
    expect(auth).toMatchObject({ ok: false, failure: { code: "AUTHORIZATION_FAILED", redacted: true } });
    expect(JSON.stringify(auth)).not.toContain("hubspot-secret-token");

    const oversized = await createHubSpotProvider(
      CONFIG,
      runtime(async () => new Response("x".repeat(128), { status: 200 }), { maxResponseBytes: 32 }),
    ).listContacts();
    expect(oversized).toMatchObject({ ok: false, failure: { code: "RESPONSE_TOO_LARGE" } });
  });
});
