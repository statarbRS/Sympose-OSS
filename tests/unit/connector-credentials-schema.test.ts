import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { closeDb, openDb, openDbForTest } from "@/server/db";
import {
  DDL,
  V20_CONNECTOR_CONNECTIONS_DDL,
  V21_PRODUCTION_CONNECTOR_RUNTIME_DDL,
} from "@/server/schema";

const V20_SCHEMA_MANIFEST_SHA256 = "bddb89c157b9ef7a55c45316f2cf3f80a676e01bfa92d787bd2a5a0151cf2114";
const V21_SCHEMA_MANIFEST_SHA256 = "4f82143569670933cf9080e38d312a827bc348a13b3a0dfb6ad233a0867f761b";

function manifestDigest(db: DatabaseSync): string {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'index', 'trigger', 'view')
       ORDER BY type, name, tableName`,
    )
    .all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>;
  const manifest = objects.map((object) => {
    const quoted = `"${object.name.replaceAll('"', '""')}"`;
    return {
      type: object.type,
      name: object.name,
      tableName: object.tableName,
      sql: object.sql,
      columns: object.type === "table"
        ? (db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>).map((column) => ({
          cid: column.cid,
          name: column.name,
          type: column.type,
          notnull: column.notnull,
          defaultValue: column.dflt_value,
          primaryKey: column.pk,
        }))
        : null,
      foreignKeys: object.type === "table"
        ? (db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as Array<{ id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string; match: string }>).map((foreignKey) => ({
          id: foreignKey.id,
          sequence: foreignKey.seq,
          tableName: foreignKey.table,
          from: foreignKey.from,
          to: foreignKey.to,
          onUpdate: foreignKey.on_update,
          onDelete: foreignKey.on_delete,
          match: foreignKey.match,
        }))
        : null,
      indexColumns: object.type === "index"
        ? (db.prepare(`PRAGMA index_info(${quoted})`).all() as Array<{ seqno: number; cid: number; name: string | null }>).map((column) => ({
          sequence: column.seqno,
          columnId: column.cid,
          columnName: column.name,
        }))
        : null,
    };
  });
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function schemaDdlAt(version: 19 | 20): string {
  const v21Suffix = `\n${V21_PRODUCTION_CONNECTOR_RUNTIME_DDL}`;
  if (!DDL.endsWith(v21Suffix)) throw new Error("canonical V21 DDL composition changed");
  const v20 = DDL.slice(0, -v21Suffix.length);
  if (version === 20) return v20;
  const v20Suffix = `\n${V20_CONNECTOR_CONNECTIONS_DDL}`;
  if (!v20.endsWith(v20Suffix)) throw new Error("canonical V20 DDL composition changed");
  return v20.slice(0, -v20Suffix.length);
}

function writeHistoricalDatabase(path: string, version: 19 | 20): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
    db.exec(schemaDdlAt(version));
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
  } finally {
    db.close();
  }
}

describe("production connector runtime schema v21", () => {
  it("adds the auth, run, preview, attempt, and receipt tables to the pinned canonical manifest", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(DDL);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'connector_connections'").get()).toEqual({
        name: "connector_connections",
      });
      expect(db.prepare("PRAGMA table_info(connector_connections)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "secret_ciphertext" }),
        expect.objectContaining({ name: "status" }),
        expect.objectContaining({ name: "version" }),
        expect.objectContaining({ name: "revoked_at" }),
      ]));
      for (const table of [
        "production_bootstrap_challenges",
        "account_credentials",
        "auth_login_guards",
        "auth_global_guards",
        "auth_attempt_leases",
        "connector_runs",
        "connector_run_attempts",
        "connector_import_preview_rows",
        "person_projection_decisions",
        "connector_export_manifests",
        "connector_export_authority_versions",
        "connector_export_decisions",
        "connector_export_receipts",
      ]) {
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toEqual({ name: table });
      }
      expect(manifestDigest(db)).toBe(V21_SCHEMA_MANIFEST_SHA256);
      db.exec(V20_CONNECTOR_CONNECTIONS_DDL);
      db.exec(V21_PRODUCTION_CONNECTOR_RUNTIME_DDL);
      expect(manifestDigest(db)).toBe(V21_SCHEMA_MANIFEST_SHA256);
    } finally {
      db.close();
    }
  });

  for (const version of [19, 20] as const) {
    it(`migrates an exact V${version} database to V21 and remains reloadable`, () => {
      const directory = mkdtempSync(`/tmp/sympose-connector-schema-v${version}-`);
      const path = join(directory, "schema.sqlite");
      try {
        writeHistoricalDatabase(path, version);
        if (version === 20) {
          const historical = new DatabaseSync(path);
          try {
            expect(manifestDigest(historical)).toBe(V20_SCHEMA_MANIFEST_SHA256);
          } finally {
            historical.close();
          }
        }

        const migrated = openDb({ path, seed: false });
        expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
        expect(manifestDigest(migrated)).toBe(V21_SCHEMA_MANIFEST_SHA256);
        closeDb(migrated);

        const reopened = openDb({ path, seed: false });
        try {
          expect(reopened.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
          expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_runs'").get()).toEqual({
            name: "connector_runs",
          });
        } finally {
          closeDb(reopened);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("rolls a V20 migration back completely when the DDL step is interrupted", () => {
    const directory = mkdtempSync("/tmp/sympose-connector-schema-rollback-");
    const path = join(directory, "schema.sqlite");
    try {
      writeHistoricalDatabase(path, 20);
      expect(() => openDbForTest({ path, seed: false }, "after-ddl")).toThrow("injected migration failure");

      const rolledBack = new DatabaseSync(path);
      try {
        expect(rolledBack.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "20" });
        expect(rolledBack.prepare("SELECT name FROM sqlite_master WHERE name = 'connector_runs'").get()).toBeUndefined();
        expect(manifestDigest(rolledBack)).toBe(V20_SCHEMA_MANIFEST_SHA256);
      } finally {
        rolledBack.close();
      }

      const migrated = openDb({ path, seed: false });
      try {
        expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
      } finally {
        closeDb(migrated);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
