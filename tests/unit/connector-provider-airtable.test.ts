import { describe, expect, it } from "vitest";

import {
  AIRTABLE_API_ORIGIN,
  createAirtableProvider,
  type AirtableProviderConfig,
} from "@/server/services/connector-hub/providers/airtable";
import type { FetchLike } from "@/server/services/connector-hub/providers/types";

const PERSON = {
  personId: "person-ada",
  fullName: "Ada Lovelace",
  email: "Ada@example.test",
  organization: "Analytical Engines",
  title: "Director",
};

const CONFIG: AirtableProviderConfig = {
  token: "airtable-secret-token",
  baseId: "appBase123",
  tableName: "People Table",
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function runtime(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}) {
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

describe("Airtable live connector provider adapter", () => {
  it("validates with one bounded read and performs an email-keyed performUpsert", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (init?.method === "GET") {
        return jsonResponse(200, { records: [{ id: "recAda", fields: { email: "ada@example.test" } }] });
      }
      return jsonResponse(200, {
        records: [{ id: "recAda", fields: { email: "ada@example.test" } }],
        createdRecords: ["recAda"],
        updatedRecords: [],
      });
    };
    const adapter = createAirtableProvider(CONFIG, runtime(fetchImpl));

    const validation = await adapter.validateConnection();
    expect(validation).toMatchObject({ ok: true, value: { connected: true, boundedRead: true, recordsRead: 1 } });
    expect(calls[0]?.url).toBe(`${AIRTABLE_API_ORIGIN}/v0/appBase123/People%20Table?pageSize=1`);

    const result = await adapter.upsertPeople([PERSON]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        requested: 1,
        created: 1,
        updated: 0,
        records: [{ personId: "person-ada", providerRecordId: "recAda", operation: "CREATED" }],
      },
    });
    const body = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      performUpsert: { fieldsToMergeOn: ["email"] },
      records: [{
        fields: {
          person_id: "person-ada",
          full_name: "Ada Lovelace",
          email: "ada@example.test",
          organization: "Analytical Engines",
          title: "Director",
        },
      }],
    });
    expect(calls[1]?.url).toBe(`${AIRTABLE_API_ORIGIN}/v0/appBase123/People%20Table`);
    expect(calls[1]?.init.headers).toMatchObject({ Authorization: "Bearer airtable-secret-token" });
  });

  it("normalizes authentication failure without returning provider response text", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, {
      error: "invalid_token",
      message: "airtable-secret-token must not escape",
    });
    const result = await createAirtableProvider(CONFIG, runtime(fetchImpl)).validateConnection();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      status: 401,
      redacted: true,
      retryable: false,
    });
    expect(result.failure.message).not.toContain("airtable-secret-token");
    expect(JSON.stringify(result)).not.toContain("invalid_token");
  });

  it("honors Retry-After for bounded 429 retries and stops after bounded 5xx retries", async () => {
    let calls = 0;
    const retryFetch: FetchLike = async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(429, { error: "rate" }, { "retry-after": "2" });
      return jsonResponse(200, { records: [] });
    };
    const retryRuntime = runtime(retryFetch, { maxRetries: 1 });
    const retried = await createAirtableProvider(CONFIG, retryRuntime).validateConnection();
    expect(retried).toMatchObject({ ok: true, attempts: 2 });
    expect(retryRuntime.sleeps).toEqual([2_000]);

    calls = 0;
    const unavailableFetch: FetchLike = async () => {
      calls += 1;
      return jsonResponse(503, { error: "temporary" });
    };
    const unavailableRuntime = runtime(unavailableFetch, { maxRetries: 2 });
    const unavailable = await createAirtableProvider(CONFIG, unavailableRuntime).validateConnection();
    expect(unavailable).toMatchObject({ ok: false, attempts: 3 });
    if (unavailable.ok) return;
    expect(unavailable.failure.code).toBe("PROVIDER_UNAVAILABLE");
    expect(unavailableRuntime.sleeps).toEqual([250, 500]);
  });

  it("rejects malformed and oversized responses, path injection, and unsafe runtime widening", async () => {
    const malformed = await createAirtableProvider(
      CONFIG,
      runtime(async () => jsonResponse(200, { notRecords: true })),
    ).validateConnection();
    expect(malformed).toMatchObject({ ok: false, failure: { code: "MALFORMED_RESPONSE" } });

    const oversized = await createAirtableProvider(
      CONFIG,
      runtime(async () => new Response("x".repeat(128), { status: 200 }), { maxResponseBytes: 32 }),
    ).validateConnection();
    expect(oversized).toMatchObject({ ok: false, failure: { code: "RESPONSE_TOO_LARGE" } });

    const calls: string[] = [];
    const injected = createAirtableProvider({
      ...CONFIG,
      baseId: "app/base?evil#fragment",
      tableName: "People/../?evil#fragment",
    }, runtime(async (input) => {
      calls.push(String(input));
      return jsonResponse(200, { records: [] });
    }));
    await injected.validateConnection();
    expect(calls[0]).toBe(
      `${AIRTABLE_API_ORIGIN}/v0/app%2Fbase%3Fevil%23fragment/People%2F..%2F%3Fevil%23fragment?pageSize=1`,
    );
    expect(calls[0]).not.toContain("evil#fragment?page");

    const invalidRuntime = createAirtableProvider(
      CONFIG,
      runtime(async () => jsonResponse(200, { records: [] }), { maxResponseBytes: Number.MAX_SAFE_INTEGER }),
    );
    const invalid = await invalidRuntime.validateConnection();
    expect(invalid).toMatchObject({ ok: false, failure: { code: "CONFIGURATION_INVALID" } });
  });

  it("aborts a hanging fetch and rejects an over-limit batch before network I/O", async () => {
    let fetches = 0;
    const hanging = createAirtableProvider(CONFIG, runtime(async () => {
      fetches += 1;
      return await new Promise<Response>(() => undefined);
    }, { timeoutMs: 5, maxRetries: 0 }));
    const timedOut = await hanging.validateConnection();
    expect(timedOut).toMatchObject({ ok: false, failure: { code: "TIMEOUT" } });
    expect(fetches).toBe(1);

    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      ...PERSON,
      personId: `person-${index}`,
      email: `person-${index}@example.test`,
    }));
    const bounded = await createAirtableProvider(CONFIG, runtime(async () => {
      fetches += 1;
      return jsonResponse(200, { records: [] });
    })).upsertPeople(tooMany);
    expect(bounded).toMatchObject({ ok: false, failure: { code: "BATCH_LIMIT_EXCEEDED" } });
    expect(fetches).toBe(1);
  });

  it("reads normalized contacts through provider-bound Airtable pagination", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      const offset = new URL(url).searchParams.get("offset");
      if (offset === null) {
        return jsonResponse(200, {
          records: [{
            id: "recAda",
            createdTime: "2026-08-14T10:00:00.000Z",
            fields: {
              full_name: " Ada Lovelace ",
              email: "ADA@EXAMPLE.TEST",
              organization: "Analytical Engines",
              title: "Director",
            },
          }],
          offset: "itrPageTwo/recAda",
        });
      }
      expect(offset).toBe("itrPageTwo/recAda");
      return jsonResponse(200, {
        records: [{
          id: "recGrace",
          createdTime: "2026-08-14T11:00:00Z",
          fields: { full_name: "Grace Hopper", email: "grace@example.test" },
        }],
      });
    };
    const adapter = createAirtableProvider(CONFIG, runtime(fetchImpl));

    const first = await adapter.listContacts({ limit: 1 });
    expect(first).toMatchObject({
      ok: true,
      operation: "list-contacts",
      value: {
        hasMore: true,
        limit: 1,
        contacts: [{
          provider: "airtable",
          externalId: "recAda",
          externalIdentity: "airtable:recAda",
          email: "ada@example.test",
          fullName: "Ada Lovelace",
          sourceVersion: "2026-08-14T10:00:00.000Z",
          sourceEvidence: {
            observedAt: "2026-08-15T00:00:00.000Z",
            fields: { email: "email", sourceVersion: "createdTime" },
          },
        }],
      },
    });
    if (!first.ok) return;
    expect(first.value.nextCursor).toMatch(/^sympose\.v1\.airtable\./u);

    const second = await adapter.readContacts({ limit: 1, cursor: first.value.nextCursor });
    expect(second).toMatchObject({
      ok: true,
      value: { hasMore: false, nextCursor: null, contacts: [{ externalId: "recGrace" }] },
    });
    const firstUrl = new URL(calls[0]!);
    expect(firstUrl.origin).toBe(AIRTABLE_API_ORIGIN);
    expect(firstUrl.searchParams.get("pageSize")).toBe("1");
    expect(firstUrl.searchParams.getAll("fields[]")).toEqual([
      "full_name",
      "email",
      "organization",
      "title",
    ]);
    expect(new URL(calls[1]!).origin).toBe(AIRTABLE_API_ORIGIN);
  });

  it("rejects unsafe Airtable cursors, duplicate identities, malformed pages, auth, and oversized reads", async () => {
    let fetches = 0;
    const adapter = createAirtableProvider(CONFIG, runtime(async () => {
      fetches += 1;
      return jsonResponse(200, { records: [] });
    }));
    const abused = await adapter.listContacts({
      cursor: "sympose.v1.airtable.https%3A%2F%2Fattacker.example%2Fsteal",
    });
    expect(abused).toMatchObject({ ok: false, failure: { code: "CURSOR_INVALID" } });
    const overLimit = await adapter.listContacts({ limit: 101 });
    expect(overLimit).toMatchObject({ ok: false, failure: { code: "INVALID_INPUT" } });
    expect(fetches).toBe(0);

    const duplicate = await createAirtableProvider(CONFIG, runtime(async () => jsonResponse(200, {
      records: [
        { id: "recSame", createdTime: "2026-08-14T10:00:00Z", fields: {} },
        { id: "recSame", createdTime: "2026-08-14T11:00:00Z", fields: {} },
      ],
    }))).listContacts({ limit: 2 });
    expect(duplicate).toMatchObject({ ok: false, failure: { code: "DUPLICATE_EXTERNAL_IDENTITY" } });

    const malformed = await createAirtableProvider(CONFIG, runtime(async () => jsonResponse(200, {
      records: [],
      offset: "https://attacker.example/next",
    }))).listContacts();
    expect(malformed).toMatchObject({ ok: false, failure: { code: "MALFORMED_RESPONSE" } });

    const auth = await createAirtableProvider(
      CONFIG,
      runtime(async () => jsonResponse(401, { token: "airtable-secret-token" })),
    ).listContacts();
    expect(auth).toMatchObject({ ok: false, failure: { code: "AUTHENTICATION_FAILED", redacted: true } });
    expect(JSON.stringify(auth)).not.toContain("airtable-secret-token");

    const oversized = await createAirtableProvider(
      CONFIG,
      runtime(async () => new Response("x".repeat(128), { status: 200 }), { maxResponseBytes: 32 }),
    ).listContacts();
    expect(oversized).toMatchObject({ ok: false, failure: { code: "RESPONSE_TOO_LARGE" } });

    const unknownMapping = createAirtableProvider({
      ...CONFIG,
      fieldMapping: { email: "email", injected: "secret_field" },
    } as AirtableProviderConfig);
    expect(await unknownMapping.listContacts()).toMatchObject({
      ok: false,
      failure: { code: "CONFIGURATION_INVALID" },
    });
  });
});
