import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_SESSION_TTL_MS,
  resolveSession,
  sessionCookieOptions,
} from "@/server/auth";
import { closeDb, openDb, openDbForTest, type Db } from "@/server/db";
import {
  bootstrapProductionWorkspace,
  loginProductionAccount,
  PRODUCTION_AUTH_ACTIVE_ATTEMPT_LIMIT,
  PRODUCTION_AUTH_LEASE_ROW_LIMIT,
  PRODUCTION_AUTH_LOGIN_GUARD_LIMIT,
  ProductionAuthError,
  productionBootstrapStatus,
} from "@/server/production-auth";
import {
  PRODUCTION_BOOTSTRAP_TOKEN_ENV,
  PRODUCTION_BOOTSTRAP_TOKEN_FILE_ENV,
  PRODUCTION_BOOTSTRAP_TTL_MS,
} from "@/server/production-bootstrap";
import {
  productionStorageConfiguration,
} from "@/server/runtime-mode";
import {
  CONNECTOR_EXECUTION_MODE_ENV,
  CONNECTOR_FIXTURE_EXECUTION_MODE,
  createSyntheticConnectorFixtureRuntime,
  syntheticConnectorFixtureEnabled,
} from "@/server/services/connector-hub/fixture-runtime";
import {
  ConnectorRuntimeConfigurationError,
  connectorExecutionAvailability,
  resolveConnectorExecutionRuntime,
} from "@/server/services/connector-hub/execution-runtime";
import {
  CONNECTOR_NETWORK_ENABLED,
  CONNECTOR_NETWORK_ENABLED_ENV,
  CONNECTOR_NETWORK_EXECUTION_MODE,
} from "@/server/services/connector-hub/network-runtime";
import {
  createAirtableProvider,
  createHubSpotProvider,
  createSalesforceProvider,
  type FetchLike,
} from "@/server/services/connector-hub/providers";

const BOOTSTRAP_TOKEN = "production-bootstrap-token-0123456789abcdef";
const OWNER_PASSWORD = "Correct-Horse-Production-2026";

const bootstrapInput = Object.freeze({
  token: BOOTSTRAP_TOKEN,
  workspaceName: "Production Workspace",
  workspaceSlug: "production-workspace",
  displayName: "Production Owner",
  email: "owner@example.test",
  password: OWNER_PASSWORD,
});

function configureProduction(directory: string, issuedAt = new Date(Date.now() - 5_000).toISOString()): string {
  const databasePath = join(directory, "database", "production.sqlite");
  vi.stubEnv("SYMPOSE_DATA_MODE", "production");
  vi.stubEnv("SYMPOSE_PRODUCTION_DB_PATH", databasePath);
  vi.stubEnv("SYMPOSE_PRODUCTION_ARTIFACT_STORE_ROOT", join(directory, "artifacts"));
  vi.stubEnv("SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN", BOOTSTRAP_TOKEN);
  vi.stubEnv("SYMPOSE_PRODUCTION_BOOTSTRAP_ISSUED_AT", issuedAt);
  return databasePath;
}

function expectAuthCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected production auth failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ProductionAuthError);
    expect(error).toMatchObject({ code, message: code });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("production runtime and authentication boundary", () => {
  it("publishes an empty production schema and its runtime binding atomically", () => {
    for (const failurePoint of [
      "before-ddl",
      "after-ddl",
      "after-integrity-check",
      "before-version-publication",
    ] as const) {
      const directory = mkdtempSync("/tmp/sympose-production-first-open-");
      const databasePath = configureProduction(directory);
      try {
        expect(() => openDbForTest({ path: databasePath, seed: false }, failurePoint))
          .toThrow("injected migration failure");
        const interrupted = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(interrupted.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
          ).get()).toBeUndefined();
        } finally {
          interrupted.close();
        }

        const recovered = openDb({ path: databasePath, seed: false });
        try {
          expect(recovered.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
            .toEqual({ value: "21" });
          expect(recovered.prepare("SELECT value FROM meta WHERE key = 'runtime_mode'").get())
            .toEqual({ value: "production" });
        } finally {
          closeDb(recovered);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("starts empty, bootstraps once, persists only hardened credentials, and supports session rotation", () => {
    const directory = mkdtempSync("/tmp/sympose-production-auth-");
    const databasePath = configureProduction(directory);
    let db: Db | null = null;
    try {
      db = openDb({ seed: true });
      expect(databasePath).toBe(join(directory, "database", "production.sqlite"));
      expect(db.prepare("SELECT value FROM meta WHERE key = 'runtime_mode'").get()).toEqual({ value: "production" });
      for (const table of [
        "workspaces",
        "accounts",
        "sessions",
        "events",
        "people",
        "source_records",
        "connector_connections",
      ]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }

      const challenge = db.prepare(
        "SELECT salt, verifier, consumed_at AS consumedAt, invalidated_at AS invalidatedAt FROM production_bootstrap_challenges WHERE id = 1",
      ).get() as Record<string, unknown>;
      expect(challenge).toMatchObject({ consumedAt: null, invalidatedAt: null });
      expect(challenge.salt).toMatch(/^[0-9a-f]{32}$/u);
      expect(challenge.verifier).toMatch(/^[0-9a-f]{128}$/u);
      expect(JSON.stringify(challenge)).not.toContain(BOOTSTRAP_TOKEN);
      expect(productionBootstrapStatus(db)).toBe("AVAILABLE");

      expectAuthCode(
        () => bootstrapProductionWorkspace(db!, { ...bootstrapInput, token: "x".repeat(40) }),
        "PRODUCTION_BOOTSTRAP_INVALID",
      );
      expect(productionBootstrapStatus(db)).toBe("AVAILABLE");
      expect(db.prepare("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 0 });

      const bootstrap = bootstrapProductionWorkspace(db, bootstrapInput);
      expect(bootstrap.session).toMatchObject({
        email: "owner@example.test",
        role: "organizer",
        workspaceSlug: "production-workspace",
      });
      expect(resolveSession(db, bootstrap.token)?.id).toBe(bootstrap.session.id);
      expect(productionBootstrapStatus(db)).toBe("CONSUMED");
      expect(db.prepare(
        "SELECT salt, verifier, consumed_by_account_id AS accountId FROM production_bootstrap_challenges WHERE id = 1",
      ).get()).toEqual({ salt: null, verifier: null, accountId: bootstrap.session.accountId });
      const credential = db.prepare(
        "SELECT kdf, salt, verifier FROM account_credentials WHERE account_id = ? AND workspace_id = ?",
      ).get(bootstrap.session.accountId, bootstrap.session.workspaceId) as Record<string, unknown>;
      expect(credential.kdf).toBe("scrypt-v1");
      expect(credential.salt).toMatch(/^[0-9a-f]{32}$/u);
      expect(credential.verifier).toMatch(/^[0-9a-f]{128}$/u);
      expect(JSON.stringify(credential)).not.toContain(OWNER_PASSWORD);
      expectAuthCode(() => bootstrapProductionWorkspace(db!, bootstrapInput), "PRODUCTION_BOOTSTRAP_REPLAYED");

      const login = loginProductionAccount(db, bootstrap.token, {
        workspaceSlug: bootstrapInput.workspaceSlug,
        email: bootstrapInput.email,
        password: OWNER_PASSWORD,
      });
      expect(resolveSession(db, bootstrap.token)).toBeNull();
      expect(resolveSession(db, login.token)?.id).toBe(login.session.id);
      expect(sessionCookieOptions()).toEqual({
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: true,
        maxAge: PRODUCTION_SESSION_TTL_MS / 1_000,
        priority: "high",
      });

      closeDb(db);
      db = null;
      db = openDb({ seed: false });
      expect(resolveSession(db, login.token)?.workspaceId).toBe(login.session.workspaceId);
      expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM people").get()).toEqual({ count: 0 });

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expectAuthCode(() => loginProductionAccount(db!, undefined, {
          workspaceSlug: bootstrapInput.workspaceSlug,
          email: "unknown@example.test",
          password: "Wrong-Password-Production-2026",
        }), "PRODUCTION_LOGIN_FAILED");
      }
      expectAuthCode(() => loginProductionAccount(db!, undefined, {
        workspaceSlug: bootstrapInput.workspaceSlug,
        email: "unknown@example.test",
        password: "Wrong-Password-Production-2026",
      }), "PRODUCTION_LOGIN_RATE_LIMITED");
      expect(db.prepare("SELECT failed_attempts AS failedAttempts FROM auth_login_guards").get()).toEqual({ failedAttempts: 5 });
    } finally {
      if (db) closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("scrubs an expired verifier in a long-lived database and rejects stale bootstrap replay", () => {
    const directory = mkdtempSync("/tmp/sympose-production-expiry-");
    configureProduction(directory);
    const db = openDb({ seed: false });
    try {
      const issuedAt = new Date(Date.now() - PRODUCTION_BOOTSTRAP_TTL_MS - 60_000).toISOString();
      const expiresAt = new Date(Date.now() - 60_000).toISOString();
      db.prepare(
        "UPDATE production_bootstrap_challenges SET issued_at = ?, expires_at = ? WHERE id = 1",
      ).run(issuedAt, expiresAt);

      expect(productionBootstrapStatus(db)).toBe("EXPIRED");
      expect(db.prepare(
        "SELECT salt, verifier, invalidated_at AS invalidatedAt FROM production_bootstrap_challenges WHERE id = 1",
      ).get()).toEqual({ salt: null, verifier: null, invalidatedAt: expiresAt });
      expectAuthCode(() => bootstrapProductionWorkspace(db, bootstrapInput), "PRODUCTION_BOOTSTRAP_EXPIRED");
      expect(db.prepare("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
    } finally {
      closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads first-owner bootstrap authority from a private file reference without persisting the secret", () => {
    const directory = mkdtempSync("/tmp/sympose-production-bootstrap-file-");
    const tokenFile = join(directory, "bootstrap-token");
    configureProduction(directory);
    writeFileSync(tokenFile, `${BOOTSTRAP_TOKEN}\n`, { mode: 0o600 });
    vi.stubEnv(PRODUCTION_BOOTSTRAP_TOKEN_ENV, "");
    vi.stubEnv(PRODUCTION_BOOTSTRAP_TOKEN_FILE_ENV, tokenFile);
    const db = openDb({ seed: false });
    try {
      const challenge = db.prepare(
        "SELECT salt, verifier FROM production_bootstrap_challenges WHERE id = 1",
      ).get();
      expect(JSON.stringify(challenge)).not.toContain(BOOTSTRAP_TOKEN);
      const created = bootstrapProductionWorkspace(db, bootstrapInput);
      expect(created.session).toMatchObject({
        email: bootstrapInput.email,
        workspaceSlug: bootstrapInput.workspaceSlug,
      });
      expect(JSON.stringify(db.prepare(
        "SELECT * FROM production_bootstrap_challenges WHERE id = 1",
      ).get())).not.toContain(BOOTSTRAP_TOKEN);
    } finally {
      closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("globally bounds varying login identities and lease concurrency, cleans retained rows, and recovers", () => {
    const directory = mkdtempSync("/tmp/sympose-production-auth-abuse-");
    configureProduction(directory);
    const db = openDb({ seed: false });
    try {
      const bootstrap = bootstrapProductionWorkspace(db, bootstrapInput);
      const wrongPassword = "Wrong-Password-Production-2026";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        expectAuthCode(() => loginProductionAccount(db, undefined, {
          workspaceSlug: bootstrapInput.workspaceSlug,
          email: `varying-${attempt}@example.test`,
          password: wrongPassword,
        }), "PRODUCTION_LOGIN_FAILED");
      }
      expectAuthCode(() => loginProductionAccount(db, undefined, {
        workspaceSlug: bootstrapInput.workspaceSlug,
        email: "varying-over-limit@example.test",
        password: wrongPassword,
      }), "PRODUCTION_LOGIN_RATE_LIMITED");
      expectAuthCode(() => loginProductionAccount(db, undefined, {
        workspaceSlug: bootstrapInput.workspaceSlug,
        email: bootstrapInput.email,
        password: OWNER_PASSWORD,
      }), "PRODUCTION_LOGIN_RATE_LIMITED");
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_login_guards").get()).toEqual({ count: 20 });
      expect(db.prepare(
        "SELECT failed_attempts AS failedAttempts FROM auth_global_guards WHERE attempt_kind = 'LOGIN'",
      ).get()).toEqual({ failedAttempts: 20 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });

      const expiredAt = "2000-01-01T00:00:00.000Z";
      db.prepare(
        "UPDATE auth_global_guards SET window_started_at = ?, blocked_until = ?, updated_at = ? WHERE attempt_kind = 'LOGIN'",
      ).run(expiredAt, expiredAt, expiredAt);
      const recovered = loginProductionAccount(db, bootstrap.token, {
        workspaceSlug: bootstrapInput.workspaceSlug,
        email: bootstrapInput.email,
        password: OWNER_PASSWORD,
      });
      expect(resolveSession(db, bootstrap.token)).toBeNull();
      expect(resolveSession(db, recovered.token)?.id).toBe(recovered.session.id);

      const now = new Date().toISOString();
      const liveUntil = new Date(Date.now() + 60_000).toISOString();
      const insertLease = db.prepare(
        "INSERT INTO auth_attempt_leases (id, attempt_kind, acquired_at, expires_at) VALUES (?, ?, ?, ?)",
      );
      for (let index = 0; index < PRODUCTION_AUTH_ACTIVE_ATTEMPT_LIMIT; index += 1) {
        insertLease.run(
          (10_000 + index).toString(16).padStart(64, "0"),
          index === 0 ? "BOOTSTRAP" : "LOGIN",
          now,
          liveUntil,
        );
      }
      expectAuthCode(() => loginProductionAccount(db, undefined, {
        workspaceSlug: bootstrapInput.workspaceSlug,
        email: bootstrapInput.email,
        password: OWNER_PASSWORD,
      }), "PRODUCTION_LOGIN_RATE_LIMITED");
      expectAuthCode(() => bootstrapProductionWorkspace(db, bootstrapInput), "PRODUCTION_BOOTSTRAP_RATE_LIMITED");
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_attempt_leases").get())
        .toEqual({ count: PRODUCTION_AUTH_ACTIVE_ATTEMPT_LIMIT });

      db.prepare("UPDATE auth_attempt_leases SET acquired_at = ?, expires_at = ?")
        .run("1999-01-01T00:00:00.000Z", expiredAt);
      const postConcurrency = loginProductionAccount(db, recovered.token, {
        workspaceSlug: bootstrapInput.workspaceSlug,
        email: bootstrapInput.email,
        password: OWNER_PASSWORD,
      });
      expect(resolveSession(db, postConcurrency.token)?.id).toBe(postConcurrency.session.id);
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_attempt_leases").get()).toEqual({ count: 0 });

      db.prepare("DELETE FROM auth_login_guards").run();
      const insertGuard = db.prepare(
        "INSERT INTO auth_login_guards (identity_hash, failed_attempts, blocked_until, last_failed_at) VALUES (?, 1, NULL, ?)",
      );
      for (let index = 0; index < PRODUCTION_AUTH_LOGIN_GUARD_LIMIT; index += 1) {
        insertGuard.run(index.toString(16).padStart(64, "0"), now);
      }
      expectAuthCode(() => loginProductionAccount(db, undefined, {
        workspaceSlug: bootstrapInput.workspaceSlug,
        email: "bounded-growth@example.test",
        password: wrongPassword,
      }), "PRODUCTION_LOGIN_FAILED");
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_login_guards").get())
        .toEqual({ count: PRODUCTION_AUTH_LOGIN_GUARD_LIMIT });
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_attempt_leases").get())
        .toEqual({ count: 0 });
      expect(PRODUCTION_AUTH_LEASE_ROW_LIMIT).toBeGreaterThan(PRODUCTION_AUTH_ACTIVE_ATTEMPT_LIMIT);
    } finally {
      closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("globally bounds bootstrap guessing and permits legitimate recovery only after the window expires", () => {
    const directory = mkdtempSync("/tmp/sympose-production-bootstrap-abuse-");
    configureProduction(directory);
    const db = openDb({ seed: false });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expectAuthCode(() => bootstrapProductionWorkspace(db, {
          ...bootstrapInput,
          token: `wrong-production-bootstrap-token-${attempt.toString().padStart(8, "0")}`,
          workspaceSlug: `attacker-${attempt}`,
          email: `attacker-${attempt}@example.test`,
        }), "PRODUCTION_BOOTSTRAP_INVALID");
      }
      expectAuthCode(() => bootstrapProductionWorkspace(db, bootstrapInput), "PRODUCTION_BOOTSTRAP_RATE_LIMITED");
      expect(db.prepare("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_attempt_leases").get()).toEqual({ count: 0 });

      const expiredAt = "2000-01-01T00:00:00.000Z";
      db.prepare(
        "UPDATE auth_global_guards SET window_started_at = ?, blocked_until = ?, updated_at = ? WHERE attempt_kind = 'BOOTSTRAP'",
      ).run(expiredAt, expiredAt, expiredAt);
      const recovered = bootstrapProductionWorkspace(db, bootstrapInput);
      expect(recovered.session).toMatchObject({ email: bootstrapInput.email, role: "organizer" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    } finally {
      closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects overlapping roots and refuses seeded or provenance-unbound databases before production mutation", () => {
    const directory = mkdtempSync("/tmp/sympose-production-mode-");
    const evaluatorPath = join(directory, "evaluator.sqlite");
    const unboundPath = join(directory, "unbound.sqlite");
    try {
      vi.stubEnv("SYMPOSE_DATA_MODE", "production");
      vi.stubEnv("SYMPOSE_PRODUCTION_DB_PATH", join(directory, "shared", "production.sqlite"));
      vi.stubEnv("SYMPOSE_PRODUCTION_ARTIFACT_STORE_ROOT", join(directory, "shared"));
      expect(() => productionStorageConfiguration()).toThrow("RUNTIME_STORAGE_CONFIGURATION_INVALID");

      vi.stubEnv("SYMPOSE_DATA_MODE", "synthetic-evaluator");
      vi.stubEnv("SYMPOSE_DB_PATH", evaluatorPath);
      const evaluator = openDb({ seed: true });
      closeDb(evaluator);

      vi.stubEnv("SYMPOSE_DATA_MODE", "production");
      vi.stubEnv("SYMPOSE_PRODUCTION_DB_PATH", evaluatorPath);
      vi.stubEnv("SYMPOSE_PRODUCTION_ARTIFACT_STORE_ROOT", join(directory, "production-artifacts"));
      vi.stubEnv("SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN", BOOTSTRAP_TOKEN);
      vi.stubEnv("SYMPOSE_PRODUCTION_BOOTSTRAP_ISSUED_AT", new Date(Date.now() - 5_000).toISOString());
      expect(() => openDb({ seed: false })).toThrow("DATABASE_RUNTIME_MODE_MISMATCH");

      const unchanged = new DatabaseSync(evaluatorPath, { readOnly: true });
      try {
        const value = (key: string): string | undefined =>
          (unchanged.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
        expect(value("runtime_mode")).toBe("synthetic-evaluator");
        expect(value("seed_version")).toBeTruthy();
      } finally {
        unchanged.close();
      }

      vi.stubEnv("SYMPOSE_DATA_MODE", "synthetic-evaluator");
      vi.stubEnv("SYMPOSE_DB_PATH", unboundPath);
      const unboundSource = openDb({ seed: false });
      closeDb(unboundSource);
      const removeBinding = new DatabaseSync(unboundPath);
      removeBinding.prepare("DELETE FROM meta WHERE key = 'runtime_mode'").run();
      removeBinding.close();

      vi.stubEnv("SYMPOSE_DATA_MODE", "production");
      vi.stubEnv("SYMPOSE_PRODUCTION_DB_PATH", unboundPath);
      expect(() => openDb({ seed: false })).toThrow("PRODUCTION_DATABASE_RUNTIME_MODE_UNBOUND");
      const stillUnbound = new DatabaseSync(unboundPath, { readOnly: true });
      try {
        expect(stillUnbound.prepare("SELECT value FROM meta WHERE key = 'runtime_mode'").get()).toBeUndefined();
        expect(stillUnbound.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
      } finally {
        stillUnbound.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("selects only mode-matched transports and routes production requests through guarded global fetch", async () => {
    const directory = mkdtempSync("/tmp/sympose-production-connector-runtime-");
    try {
      const actionSource = readFileSync(
        join(process.cwd(), "src/app/w/[workspace]/connectors/actions.ts"),
        "utf8",
      );
      expect(actionSource).not.toContain("createSyntheticConnectorFixtureRuntime");
      expect(actionSource.match(/resolveConnectorExecutionRuntime\(provider\)/gu)).toHaveLength(3);

      configureProduction(directory);
      const networkCalls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const mockFetch: FetchLike = async (input, init) => {
        const url = String(input);
        networkCalls.push({ url, init: init ?? {} });
        const origin = new URL(url).origin;
        if (origin === "https://api.airtable.com") {
          return new Response(JSON.stringify({ records: [] }), { status: 200 });
        }
        if (origin === "https://api.hubapi.com") {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        if (origin === "https://sympose.my.salesforce.com") {
          return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }), { status: 200 });
        }
        throw new Error("unexpected mock provider origin");
      };
      vi.stubGlobal("fetch", mockFetch);

      // Production can never select the repository fixture, including with the obsolete opt-in.
      vi.stubEnv(CONNECTOR_EXECUTION_MODE_ENV, CONNECTOR_FIXTURE_EXECUTION_MODE);
      vi.stubEnv("SYMPOSE_PRODUCTION_SYNTHETIC_FIXTURES_ACK", "public-synthetic-fixture-only");
      expect(syntheticConnectorFixtureEnabled()).toBe(false);
      expect(() => createSyntheticConnectorFixtureRuntime("hubspot")).toThrow("CONNECTOR_FIXTURE_RUNTIME_DENIED");
      expect(() => resolveConnectorExecutionRuntime("hubspot"))
        .toThrowError(ConnectorRuntimeConfigurationError);
      expect(connectorExecutionAvailability()).toEqual({ enabled: false, transport: null });
      expect(networkCalls).toHaveLength(0);

      // Network mode is inert until the independent enablement value is exact.
      vi.stubEnv(CONNECTOR_EXECUTION_MODE_ENV, CONNECTOR_NETWORK_EXECUTION_MODE);
      expect(() => resolveConnectorExecutionRuntime("hubspot"))
        .toThrowError(ConnectorRuntimeConfigurationError);
      vi.stubEnv(CONNECTOR_NETWORK_ENABLED_ENV, "true");
      expect(() => resolveConnectorExecutionRuntime("hubspot"))
        .toThrowError(ConnectorRuntimeConfigurationError);
      expect(networkCalls).toHaveLength(0);

      vi.stubEnv(CONNECTOR_NETWORK_ENABLED_ENV, CONNECTOR_NETWORK_ENABLED);
      expect(connectorExecutionAvailability()).toEqual({ enabled: true, transport: "provider-network" });
      const runtimes = {
        airtable: resolveConnectorExecutionRuntime("airtable"),
        hubspot: resolveConnectorExecutionRuntime("hubspot"),
        salesforce: resolveConnectorExecutionRuntime("salesforce"),
      };
      expect(runtimes.airtable).toMatchObject({
        dataMode: "production",
        provider: "airtable",
        source: "global-fetch",
        transportContract: "provider-network/v1",
      });

      const outcomes = await Promise.all([
        createAirtableProvider({
          token: "mock-airtable-token",
          baseId: "app12345678901234",
          tableName: "People",
        }, runtimes.airtable).validateConnection(),
        createHubSpotProvider({ token: "mock-hubspot-token" }, runtimes.hubspot).validateConnection(),
        createSalesforceProvider({
          token: "mock-salesforce-token",
          instanceOrigin: "https://sympose.my.salesforce.com",
          apiVersion: "v60.0",
        }, runtimes.salesforce).validateConnection(),
      ]);
      expect(outcomes).toEqual([
        expect.objectContaining({ ok: true, provider: "airtable", attempts: 1 }),
        expect.objectContaining({ ok: true, provider: "hubspot", attempts: 1 }),
        expect.objectContaining({ ok: true, provider: "salesforce", attempts: 1 }),
      ]);
      expect(networkCalls.map(({ url }) => new URL(url).origin).sort()).toEqual([
        "https://api.airtable.com",
        "https://api.hubapi.com",
        "https://sympose.my.salesforce.com",
      ]);
      for (const call of networkCalls) {
        expect(call.init).toMatchObject({ method: "GET", redirect: "error" });
        expect(call.init.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(call.init.headers).get("authorization")).toMatch(/^Bearer mock-/u);
      }

      // Synthetic mode cannot select or call the network capability, even when network is enabled.
      vi.stubEnv("SYMPOSE_DATA_MODE", "synthetic-evaluator");
      expect(() => resolveConnectorExecutionRuntime("hubspot"))
        .toThrowError(ConnectorRuntimeConfigurationError);
      expect(connectorExecutionAvailability()).toEqual({ enabled: false, transport: null });
      expect(networkCalls).toHaveLength(3);

      vi.stubEnv(CONNECTOR_EXECUTION_MODE_ENV, CONNECTOR_FIXTURE_EXECUTION_MODE);
      expect(syntheticConnectorFixtureEnabled()).toBe(true);
      expect(connectorExecutionAvailability()).toEqual({ enabled: true, transport: "synthetic-fixture" });
      const fixtureOutcome = await createHubSpotProvider(
        { token: "public-synthetic-fixture" },
        resolveConnectorExecutionRuntime("hubspot"),
      ).validateConnection();
      expect(fixtureOutcome).toMatchObject({ ok: true, provider: "hubspot", attempts: 1 });
      expect(networkCalls).toHaveLength(3);

      // Missing production storage makes otherwise enabled network selection fail closed.
      vi.stubEnv("SYMPOSE_DATA_MODE", "production");
      vi.stubEnv(CONNECTOR_EXECUTION_MODE_ENV, CONNECTOR_NETWORK_EXECUTION_MODE);
      vi.stubEnv("SYMPOSE_PRODUCTION_ARTIFACT_STORE_ROOT", "");
      expect(() => resolveConnectorExecutionRuntime("hubspot"))
        .toThrowError(ConnectorRuntimeConfigurationError);
      expect(networkCalls).toHaveLength(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses the destructive evaluator reset helper when production mode is inherited", () => {
    const directory = mkdtempSync("/tmp/sympose-production-reset-guard-");
    const databasePath = join(directory, "protected.db");
    try {
      writeFileSync(databasePath, "must remain", { mode: 0o600 });
      const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/reset-db.mjs")], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          SYMPOSE_DATA_MODE: "production",
          SYMPOSE_DB_PATH: databasePath,
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("outside synthetic-evaluator mode");
      expect(readFileSync(databasePath, "utf8")).toBe("must remain");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
