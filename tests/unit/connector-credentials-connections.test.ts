import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DenialError, type SessionInfo } from "@/server/auth";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  CONNECTOR_VAULT_KEY_ENV,
} from "@/server/services/connector-hub/credential-vault";
import {
  ConnectorConnectionError,
  getConnectorConnectionSummary,
  listConnectorConnectionSummaries,
  normalizeConnectorProviderConfig,
  revokeConnectorConnection,
  saveConnectorConnection,
} from "@/server/services/connector-hub";

const KEY = Buffer.alloc(32, 0x33).toString("base64");
const AT = "2026-08-13T01:45:00.000Z";
const WORKSPACE_A = "workspace-connector-credentials-a";
const WORKSPACE_B = "workspace-connector-credentials-b";

function session(
  role = "organizer",
  workspaceId = WORKSPACE_A,
  workspaceSlug = "credentials-alpha",
): SessionInfo {
  return {
    id: `session-${role}-${workspaceId}`,
    tokenHash: `token-${role}-${workspaceId}`,
    accountId: `account-${role}-${workspaceId}`,
    workspaceId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: `${role}@example.test`,
    displayName: role,
    role,
    workspaceSlug,
    workspaceName: workspaceSlug,
  };
}

function seed(db: Db): void {
  const insert = db.prepare(
    "INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
  );
  insert.run(WORKSPACE_A, "credentials-alpha", "Credentials Alpha", AT);
  insert.run(WORKSPACE_B, "credentials-bravo", "Credentials Bravo", AT);
}

function expectConnectionCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected connection failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorConnectionError);
    expect(error).toMatchObject({ code, message: code });
  }
}

describe("connector credential connection persistence", () => {
  let previousKey: string | undefined;

  beforeEach(() => {
    previousKey = process.env[CONNECTOR_VAULT_KEY_ENV];
    process.env[CONNECTOR_VAULT_KEY_ENV] = KEY;
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env[CONNECTOR_VAULT_KEY_ENV];
    } else {
      process.env[CONNECTOR_VAULT_KEY_ENV] = previousKey;
    }
  });

  it("stores one masked mutable row and keeps provider evidence separate", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      const secret = "synthetic-airtable-secret-connection-test";
      const created = saveConnectorConnection(db, session(), "credentials-alpha", {
        provider: "airtable",
        config: { baseId: "appABC123", tableName: "People" },
        secret,
        expectedVersion: 0,
      });

      expect(created).toMatchObject({
        provider: "airtable",
        status: "ACTIVE",
        maskedSecret: "••••••••",
        config: { provider: "airtable", baseId: "appABC123", tableName: "People" },
        version: 1,
      });
      expect(JSON.stringify(created)).not.toContain(secret);

      const row = db.prepare(
        `SELECT status, config_json AS configJson, secret_algorithm AS algorithm,
                secret_key_version AS keyVersion, secret_iv AS iv,
                secret_ciphertext AS ciphertext, secret_tag AS tag, version, revoked_at AS revokedAt
         FROM connector_connections WHERE workspace_id = ? AND provider = ?`,
      ).get(WORKSPACE_A, "airtable") as Record<string, unknown>;
      expect(row.status).toBe("ACTIVE");
      expect(row.configJson).not.toContain(secret);
      expect(row.algorithm).toBe("aes-256-gcm");
      expect(row.keyVersion).toBe("aes-256-gcm-v1");
      expect(typeof row.ciphertext).toBe("string");
      expect(row.ciphertext).not.toBe(secret);
      expect(row.revokedAt).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_records").get()).toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("updates in place, clears ciphertext on revoke, and reactivates with a new envelope", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      const first = saveConnectorConnection(db, session(), "credentials-alpha", {
        provider: "airtable",
        config: { baseId: "appABC123", tableName: "People" },
        secret: "synthetic-first-airtable-secret",
        expectedVersion: 0,
      });
      const firstRow = db.prepare(
        "SELECT secret_ciphertext AS ciphertext FROM connector_connections WHERE id = ?",
      ).get(first.id) as { ciphertext: string };

      const updated = saveConnectorConnection(db, session(), "credentials-alpha", {
        provider: "airtable",
        config: { baseId: "appABC123", tableName: "Contacts" },
        expectedVersion: first.version,
      });
      const preservedRow = db.prepare(
        "SELECT secret_ciphertext AS ciphertext FROM connector_connections WHERE id = ?",
      ).get(first.id) as { ciphertext: string };
      expect(updated.version).toBe(2);
      expect(preservedRow.ciphertext).toBe(firstRow.ciphertext);

      const revoked = revokeConnectorConnection(db, session(), "credentials-alpha", "airtable", updated.version);
      expect(revoked).toMatchObject({ status: "REVOKED", maskedSecret: null, version: 3 });
      const revokedRow = db.prepare(
        `SELECT status, secret_algorithm AS algorithm, secret_key_version AS keyVersion,
                secret_iv AS iv, secret_ciphertext AS ciphertext, secret_tag AS tag,
                revoked_at AS revokedAt
         FROM connector_connections WHERE id = ?`,
      ).get(first.id) as Record<string, unknown>;
      expect(revokedRow).toMatchObject({
        status: "REVOKED",
        algorithm: null,
        keyVersion: null,
        iv: null,
        ciphertext: null,
        tag: null,
      });
      expect(typeof revokedRow.revokedAt).toBe("string");

      delete process.env[CONNECTOR_VAULT_KEY_ENV];
      const revokedAgain = revokeConnectorConnection(db, session(), "credentials-alpha", "airtable", revoked!.version);
      expect(revokedAgain).toMatchObject({ status: "REVOKED", maskedSecret: null });
      process.env[CONNECTOR_VAULT_KEY_ENV] = KEY;

      const reactivated = saveConnectorConnection(db, session(), "credentials-alpha", {
        provider: "airtable",
        config: { baseId: "appABC123", tableName: "Contacts" },
        secret: "synthetic-second-airtable-secret",
        expectedVersion: revokedAgain!.version,
      });
      const activeRow = db.prepare(
        "SELECT status, secret_ciphertext AS ciphertext FROM connector_connections WHERE id = ?",
      ).get(first.id) as { status: string; ciphertext: string };
      expect(reactivated).toMatchObject({ status: "ACTIVE", maskedSecret: "••••••••", version: 4 });
      expect(activeRow.status).toBe("ACTIVE");
      expect(activeRow.ciphertext).not.toBe(firstRow.ciphertext);
    } finally {
      closeDb(db);
    }
  });

  it("persists v20 connection state across a disposable SQLite reopen", () => {
    const directory = mkdtempSync("/tmp/sympose-connector-credentials-");
    const path = join(directory, "credentials.sqlite");
    let db: Db | null = null;
    try {
      db = openDb({ path, seed: false });
      seed(db);
      saveConnectorConnection(db, session(), "credentials-alpha", {
        provider: "hubspot",
        config: { portalId: "123456", portalName: "Synthetic Portal" },
        secret: "synthetic-hubspot-secret",
        expectedVersion: 0,
      });
      closeDb(db);
      db = null;

      db = openDb({ path, seed: false });
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
      expect(getConnectorConnectionSummary(db, session(), "credentials-alpha", "hubspot")).toMatchObject({
        provider: "hubspot",
        status: "ACTIVE",
        maskedSecret: "••••••••",
        config: { portalId: "123456", portalName: "Synthetic Portal" },
      });
    } finally {
      if (db) closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces provider allowlists, no-SSRF Salesforce hosts, and organizer/workspace boundaries", () => {
    expect(normalizeConnectorProviderConfig("salesforce", {
      instanceUrl: "https://NA123.Salesforce.com/",
      apiVersion: "60.0",
    })).toEqual({
      provider: "salesforce",
      instanceUrl: "https://na123.salesforce.com",
      apiVersion: "v60.0",
    });
    expectConnectionCode(
      () => normalizeConnectorProviderConfig("salesforce", { instanceUrl: "https://127.0.0.1", apiVersion: "60.0" }),
      "CONNECTOR_CONNECTION_CONFIG_INVALID",
    );
    expectConnectionCode(
      () => normalizeConnectorProviderConfig("airtable", { baseId: "appABC123", tableName: "People", extra: "nope" }),
      "CONNECTOR_CONNECTION_CONFIG_INVALID",
    );

    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      const foreignRoute = () => listConnectorConnectionSummaries(db, session(), "credentials-bravo");
      expect(foreignRoute).toThrow(DenialError);
      expect(foreignRoute).toThrow(/not the session's workspace/iu);
      try {
        saveConnectorConnection(db, session("read_only"), "credentials-alpha", {
          provider: "hubspot",
          config: {},
          secret: "synthetic-denied-secret",
          expectedVersion: 0,
        });
        throw new Error("expected capability denial");
      } catch (error) {
        expect(error).toBeInstanceOf(DenialError);
        expect(error).toMatchObject({ code: "CAPABILITY_DENIED", target: "connectors.manage" });
      }
    } finally {
      closeDb(db);
    }
  });

  it("requires the deployment key when creating encrypted state", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      delete process.env[CONNECTOR_VAULT_KEY_ENV];
      expectConnectionCode(
        () => saveConnectorConnection(db, session(), "credentials-alpha", {
          provider: "airtable",
          config: { baseId: "appABC123", tableName: "People" },
          secret: "synthetic-missing-key-secret",
          expectedVersion: 0,
        }),
        "CONNECTOR_VAULT_KEY_REQUIRED",
      );
    } finally {
      closeDb(db);
    }
  });
});
