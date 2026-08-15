import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openDb } from "@/server/db";
import { DDL, V17_DDL, V18_DDL, V19_DDL } from "@/server/schema";
import { dropV21ProductionConnectorSchema } from "./helpers/drop-v21-production-connector-schema";

const V21_SCHEMA_MANIFEST_SHA256 =
  "4f82143569670933cf9080e38d312a827bc348a13b3a0dfb6ad233a0867f761b";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function manifestDigest(db: DatabaseSync): string {
  const objects = db.prepare(
    `SELECT type, name, tbl_name AS tableName, sql
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
     ORDER BY type, name, tableName`,
  ).all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>;
  const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const manifest = objects.map((object) => ({
    type: object.type,
    name: object.name,
    tableName: object.tableName,
    sql: object.sql,
    columns: object.type === "table"
      ? (db.prepare(`PRAGMA table_info(${quoted(object.name)})`).all() as Array<{
          cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
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
      ? (db.prepare(`PRAGMA foreign_key_list(${quoted(object.name)})`).all() as Array<{
          id: number; seq: number; table: string; from: string; to: string;
          on_update: string; on_delete: string; match: string;
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
      ? (db.prepare(`PRAGMA index_info(${quoted(object.name)})`).all() as Array<{
          seqno: number; cid: number; name: string | null;
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

function dropV17Schema(db: DatabaseSync): void {
  dropV21ProductionConnectorSchema(db);
  db.exec(`
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
  `);
  db.exec("ALTER TABLE observations DROP COLUMN recorded_at");
  const objects = db.prepare(
    `SELECT type, name FROM sqlite_master
     WHERE name LIKE 'trg_publication_audience_%'
        OR name LIKE 'trg_publication_release_versions_%'
        OR name LIKE 'idx_publication_audience_%'
        OR name = 'idx_publication_release_versions_scope'
        OR name LIKE 'uq_publication_audience_%'
     ORDER BY CASE type WHEN 'trigger' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name`,
  ).all() as Array<{ type: "trigger" | "index"; name: string }>;
  for (const object of objects) db.exec(`DROP ${object.type.toUpperCase()} "${object.name}"`);
  db.exec(`
    DROP TABLE publication_audience_receipts;
    DROP TABLE publication_audience_policy_versions;
    DROP TABLE publication_audience_channels;
    DROP TABLE publication_release_versions;
  `);
}

describe("V17 publication audience schema on the V21 chain", () => {
  it("pins the complete normalized V21 manifest", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
    db.exec(DDL);
    expect(manifestDigest(db)).toBe(V21_SCHEMA_MANIFEST_SHA256);
  });

  it("migrates a representative raw V16 database and keeps additive DDL idempotent", () => {
    const path = resolve(".tmp/unit", `publication-audience-schema-${process.pid}.db`);
    mkdirSync(dirname(path), { recursive: true });
    removeDatabase(path);
    const raw = new DatabaseSync(path);
    try {
      raw.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
      raw.exec(DDL);
      dropV17Schema(raw);
      raw.exec(`
        INSERT INTO workspaces (id, slug, name, created_at)
        VALUES ('migration-workspace', 'migration-workspace', 'Migration workspace', '2026-08-13T01:00:00.000Z');
        INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
        VALUES ('migration-organizer', 'migration-workspace', 'organizer@migration.test',
          'Migration organizer', 'organizer', '2026-08-13T01:00:00.000Z');
        INSERT INTO events
          (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
        VALUES ('migration-event', 'migration-workspace', 'Migration event', 'UTC',
          '2026-09-15T09:00:00.000Z', '2026-09-15T10:00:00.000Z', 'planning',
          '2026-08-13T01:00:00.000Z');
        INSERT INTO plan_runs
          (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json,
           compiler, compiler_version, created_at)
        VALUES ('migration-run', 'migration-workspace', 'migration-event', 'complete',
          '${"a".repeat(64)}', '{}', 'migration', '1', '2026-08-13T01:00:00.000Z');
        INSERT INTO plan_versions
          (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
        VALUES ('migration-plan', 'migration-workspace', 'migration-event', 'migration-run', 1,
          '${"b".repeat(64)}', '{}', '2026-08-13T01:00:00.000Z');
        INSERT INTO publication_releases
          (id, workspace_id, event_id, plan_version_id, audience_policy_version,
           commitment_watermark, fingerprint, content_json, sealed_at)
        VALUES ('migration-release', 'migration-workspace', 'migration-event', 'migration-plan',
          1, 0, '${"c".repeat(64)}', '{}', '2026-08-13T01:01:00.000Z');
        UPDATE events SET current_release_id = 'migration-release' WHERE id = 'migration-event';
      `);
      raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '16')").run();
    } finally {
      raw.close();
    }

    try {
      const migrated = openDb({ path, seed: false });
      try {
        expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
        expect(migrated.prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'publication_%'
           ORDER BY name`,
        ).all()).toEqual(expect.arrayContaining([
          { name: "publication_audience_channels" },
          { name: "publication_audience_policy_versions" },
          { name: "publication_audience_receipts" },
          { name: "publication_release_versions" },
        ]));
        expect(migrated.prepare(
          `SELECT release_id AS releaseId, version_number AS versionNumber,
                  release_fingerprint AS releaseFingerprint, catalog_source AS catalogSource,
                  cataloged_by_account_id AS catalogedByAccountId
           FROM publication_release_versions`,
        ).get()).toEqual({
          releaseId: "migration-release",
          versionNumber: 1,
          releaseFingerprint: "c".repeat(64),
          catalogSource: "MIGRATION",
          catalogedByAccountId: null,
        });
        migrated.exec(V17_DDL);
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
