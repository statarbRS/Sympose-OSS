import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openDb } from "../../src/server/db";
import { DDL, V16_DDL, V18_DDL, V19_DDL } from "../../src/server/schema";
import { dropV21ProductionConnectorSchema } from "./helpers/drop-v21-production-connector-schema";

const databases: DatabaseSync[] = [];
const V21_SCHEMA_MANIFEST_SHA256 =
  "4f82143569670933cf9080e38d312a827bc348a13b3a0dfb6ad233a0867f761b";

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

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
  const manifest = objects.map((object) => ({
    type: object.type,
    name: object.name,
    tableName: object.tableName,
    sql: object.sql,
    columns: object.type === "table"
      ? (db.prepare(`PRAGMA table_info("${object.name.replaceAll('"', '""')}")`).all() as Array<{
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>).map((column) => ({
          cid: column.cid,
          name: column.name,
          type: column.type,
          notnull: column.notnull,
          defaultValue: column.dflt_value,
          primaryKey: column.pk,
        }))
      : null,
    foreignKeys: object.type === "table"
      ? (db.prepare(`PRAGMA foreign_key_list("${object.name.replaceAll('"', '""')}")`).all() as Array<{
          id: number;
          seq: number;
          table: string;
          from: string;
          to: string;
          on_update: string;
          on_delete: string;
          match: string;
        }>).map((foreignKey) => ({
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
      ? (db.prepare(`PRAGMA index_info("${object.name.replaceAll('"', '""')}")`).all() as Array<{
          seqno: number;
          cid: number;
          name: string | null;
        }>).map((column) => ({
          sequence: column.seqno,
          columnId: column.cid,
          columnName: column.name,
        }))
      : null,
  }));
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function removeDatabase(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(target, { force: true });
  }
}

describe("V16 reviewer access schema on the V21 chain", () => {
  it("computes the normalized V21 manifest", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
    db.exec(DDL);
    expect(manifestDigest(db)).toBe(
      V21_SCHEMA_MANIFEST_SHA256,
    );
  });

  it("reopens an exact raw V15 database through V16/V17/V18/V19/V20/V21 and keeps additive DDL idempotent", () => {
    const path = resolve(".tmp/unit", `reviewer-access-schema-${process.pid}.db`);
    mkdirSync(dirname(path), { recursive: true });
    removeDatabase(path);

    const initial = openDb({ path, seed: false });
    closeDb(initial);

    const raw = new DatabaseSync(path);
    try {
      dropV21ProductionConnectorSchema(raw);
      raw.exec(`
        DROP INDEX IF EXISTS idx_connector_connections_workspace;
        DROP TABLE IF EXISTS connector_connections;
        DROP TRIGGER IF EXISTS trg_observation_audit_v19_guard;
        DROP TRIGGER IF EXISTS trg_observation_corrections_v19_guard;
        DROP TRIGGER IF EXISTS trg_observations_v19_guard;
        DROP TRIGGER IF EXISTS trg_observation_corrections_no_delete;
        DROP TRIGGER IF EXISTS trg_observation_corrections_immutable;
        DROP TRIGGER IF EXISTS trg_observation_corrections_guard;
        DROP INDEX IF EXISTS idx_observation_corrections_scope;
        DROP TABLE IF EXISTS observation_corrections;
        DROP TRIGGER IF EXISTS trg_publication_audience_receipts_no_delete;
        DROP TRIGGER IF EXISTS trg_publication_audience_receipts_immutable;
        DROP TRIGGER IF EXISTS trg_publication_audience_receipts_guard;
        DROP TRIGGER IF EXISTS trg_publication_audience_policies_no_delete;
        DROP TRIGGER IF EXISTS trg_publication_audience_policies_immutable;
        DROP TRIGGER IF EXISTS trg_publication_audience_policies_guard;
        DROP TRIGGER IF EXISTS trg_publication_audience_channels_no_delete;
        DROP TRIGGER IF EXISTS trg_publication_audience_channels_immutable;
        DROP TRIGGER IF EXISTS trg_publication_audience_channels_guard;
        DROP TRIGGER IF EXISTS trg_publication_release_versions_no_delete;
        DROP TRIGGER IF EXISTS trg_publication_release_versions_immutable;
        DROP TRIGGER IF EXISTS trg_publication_release_versions_guard;
        DROP INDEX IF EXISTS uq_publication_audience_binding_disable;
        DROP INDEX IF EXISTS uq_publication_audience_policy_supersession;
        DROP INDEX IF EXISTS uq_publication_audience_binding_exact;
        DROP INDEX IF EXISTS idx_publication_audience_receipts_release;
        DROP INDEX IF EXISTS idx_publication_audience_receipts_scope;
        DROP INDEX IF EXISTS idx_publication_audience_policies_scope;
        DROP INDEX IF EXISTS idx_publication_audience_channels_scope;
        DROP INDEX IF EXISTS idx_publication_release_versions_scope;
        DROP TABLE IF EXISTS publication_audience_receipts;
        DROP TABLE IF EXISTS publication_audience_policy_versions;
        DROP TABLE IF EXISTS publication_audience_channels;
        DROP TABLE IF EXISTS publication_release_versions;
        DROP TRIGGER trg_reviewer_access_receipts_guard;
        DROP TRIGGER trg_reviewer_access_receipts_immutable;
        DROP TRIGGER trg_reviewer_access_receipts_no_delete;
        DROP TRIGGER trg_reviewer_access_states_guard;
        DROP TRIGGER trg_reviewer_access_states_immutable;
        DROP TRIGGER trg_reviewer_access_states_no_delete;
        DROP INDEX idx_reviewer_access_receipts_scope;
        DROP INDEX idx_reviewer_access_states_scope;
        DROP TABLE reviewer_access_states;
        DROP TABLE reviewer_access_receipts;
        UPDATE meta SET value = '15' WHERE key = 'schema_version';
      `);
      raw.exec("ALTER TABLE observations DROP COLUMN recorded_at");
    } finally {
      raw.close();
    }

    try {
      const migrated = openDb({ path, seed: false });
      try {
        expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
        expect(manifestDigest(migrated)).toBe(V21_SCHEMA_MANIFEST_SHA256);
        expect(migrated.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('reviewer_access_receipts', 'reviewer_access_states') ORDER BY name",
        ).all()).toEqual([
          { name: "reviewer_access_receipts" },
          { name: "reviewer_access_states" },
        ]);
        migrated.exec(V16_DDL);
        migrated.exec(V18_DDL);
        migrated.exec(V19_DDL);
        expect(manifestDigest(migrated)).toBe(V21_SCHEMA_MANIFEST_SHA256);
      } finally {
        closeDb(migrated);
      }
    } finally {
      removeDatabase(path);
    }
  });
});
