import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { dropV21ProductionConnectorSchema } from "./helpers/drop-v21-production-connector-schema";

import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, openDbForTest, type Db, type MigrationFailurePoint } from "../../src/server/db";
import { DDL, V5_DDL, V9_DDL, V10_DDL, V18_DDL, V19_DDL } from "../../src/server/schema";
import {
  createCall,
  createDraftSubmission,
  createFormDefinition,
  saveDraftRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import {
  createLegacyDatabase,
  insertWorkspaceMarker,
  LEGACY_FIXTURE_BASE_COMMIT,
  LEGACY_SCHEMA_MANIFEST_SHA256,
} from "./fixtures/legacy-schema-v1-v2";
import {
  createLegacyV3Database,
  V3_FIXTURE_BASE_COMMIT,
  V3_SCHEMA_MANIFEST_SHA256,
} from "./fixtures/legacy-schema-v3";
import {
  createLegacyV4Database,
  V4_FIXTURE_BASE_COMMIT,
  V4_SCHEMA_MANIFEST_SHA256,
} from "./fixtures/legacy-schema-v4";
import {
  createLegacyV7Database,
  DDL as LEGACY_V7_DDL,
  V7_SCHEMA_MANIFEST_SHA256,
} from "./fixtures/legacy-schema-v7";

function removeSqliteFiles(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(target, { force: true });
  }
}

function pathFor(name: string): string {
  const path = resolve(".tmp/unit", `cfp-${name}.db`);
  mkdirSync(dirname(path), { recursive: true });
  removeSqliteFiles(path);
  return path;
}

function legacyManifestDigest(db: Db | DatabaseSync): string {
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
    ...object,
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
  }));
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function createLegacyFile(path: string, schemaVersion: 1 | 2): void {
  const db = createLegacyDatabase({ path, schemaVersion });
  try {
    expect(legacyManifestDigest(db)).toBe(LEGACY_SCHEMA_MANIFEST_SHA256);
  } finally {
    db.close();
  }
}

function schemaVersion(path: string): string | undefined {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
  } finally {
    db.close();
  }
}

function cfpFixture(db: Db): {
  readonly workspaceId: string;
  readonly organizerAccountId: string;
  readonly callId: string;
  readonly sessionId: string;
  readonly submissionId: string;
  readonly revisionId: string;
} {
  let workspace = db.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as { id: string } | undefined;
  if (!workspace) {
    insertWorkspaceMarker(db, {
      id: "ws-northstar",
      slug: "northstar",
      name: "Northstar Workspace",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    workspace = { id: "ws-northstar" };
  }
  let account = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1").get(workspace.id) as {
    id: string;
  } | undefined;
  if (!account) {
    db.prepare(
      `INSERT INTO accounts (id, workspace_id, email, display_name, created_at)
       VALUES ('account-organizer', ?, 'organizer@synthetic.example', 'Organizer', ?)`
    ).run(workspace.id, "2026-08-10T00:00:00.000Z");
    account = { id: "account-organizer" };
  }
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES ('migration-cfp-event', ?, 'Migration CFP event', 'UTC', ?, ?, ?)`,
  ).run(workspace.id, "2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z", "2026-08-10T00:00:00.000Z");
  const organizer = { workspaceId: workspace.id, accountId: account.id };
  const definition = createFormDefinition(db, organizer, { name: "Migration CFP form" });
  const form = sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [{ id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" }],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = createCall(db, organizer, {
    eventId: "migration-cfp-event",
    name: "Migration CFP call",
    slug: "migration-cfp-call",
    formVersionId: form.id,
    policy: {
      disclosure: {
        privacy: "privacy",
        retention: "retention",
        aiProcessing: "ai",
        communication: "communication",
        consent: "consent",
        publication: "publication",
      },
      choices: [{ fieldId: "consent", statement: "Allow", required: true }],
    },
  });
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
     VALUES ('migration-cfp-person', ?, 'migration-cfp@synthetic.example', 'Migration CFP person', ?)`,
  ).run(workspace.id, "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES ('migration-cfp-verification', ?, ?, 'migration-cfp@synthetic.example', ?, ?, ?)`,
  ).run(workspace.id, call.id, "a".repeat(64), "2099-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES ('migration-cfp-consumption', ?, 'migration-cfp-verification', 'migration-cfp-person', ?)`,
  ).run(workspace.id, "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES ('migration-cfp-session', ?, ?, 'migration-cfp-person', 'migration-cfp-verification', ?, ?, ?)`,
  ).run(workspace.id, call.id, "b".repeat(64), "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
  const submission = createDraftSubmission(
    db,
    { workspaceId: workspace.id, sessionId: "migration-cfp-session" },
    { callId: call.id },
  );
  const revision = saveDraftRevision(db, {
    workspaceId: workspace.id,
    sessionId: "migration-cfp-session",
  }, {
    submissionId: submission.id,
    historicalAnswers: [{ fieldId: "consent", value: true }],
    expectedCurrentRevisionId: null,
  });
  return {
    workspaceId: workspace.id,
    organizerAccountId: account.id,
    callId: call.id,
    sessionId: "migration-cfp-session",
    submissionId: submission.id,
    revisionId: revision.revisionId,
  };
}

function fileSnapshot(path: string): string {
  return readFileSync(path).toString("base64");
}

const LEGACY_TABLES = [
  "workspaces",
  "accounts",
  "sessions",
  "source_records",
  "people",
  "source_links",
  "cohort_definitions",
  "cohort_snapshots",
  "cohort_snapshot_members",
  "events",
  "program_units",
  "plan_runs",
  "plan_versions",
  "plan_states",
  "plan_assignments",
  "approvals",
  "commitment_offers",
  "commitment_responses",
  "publication_releases",
  "personal_agendas",
  "portal_tokens",
  "observations",
  "audit_events",
] as const;

const LEGACY_TABLE_SET = new Set(["meta", ...LEGACY_TABLES]);
const EXPECTED_V3_MANIFEST_SHA256 =
  "c11246dd8077614523611f504418562e16b7da767f98804e9dfade2c763961ea";
const EXPECTED_V4_MANIFEST_SHA256 =
  "6c53baf5366e56ddafc29efa0cbf1ee4b27dd17630cab194904c6629b870d9d7";
const EXPECTED_V5_MANIFEST_SHA256 =
  "1f86f7e1cd441319222a8c84000d25641d1aeecae4a6a989e737dfa5021b9a1c";
const EXPECTED_V6_MANIFEST_SHA256 =
  "8ca73c15681439bf7f566ea64b64833e8aab7c061fe0536aec4fbbc89c226190";
const EXPECTED_V7_MANIFEST_SHA256 =
  "482077774bab4591c6ecc1761f5eaaf8152029a0d23e973277bf6f0c957eb360";
const EXPECTED_V9_MANIFEST_SHA256 =
  "73dc680e5d947102e99066d2df640298c67f7e4c92d8e534b2d15f792f3a33f7";
const EXPECTED_V10_LEGACY_MANIFEST_SHA256 =
  "6cb0fd19a35a9867bb99b7bb2f78bf4c02d0ba90c55f65d15d8e0f1eebdd6628";
const EXPECTED_V13_MANIFEST_SHA256 =
  "25b309b0ec0227b18125afdf37f11b914417bf2770ae441b68e6316ef056dbf6";
const EXPECTED_V15_MANIFEST_SHA256 =
  "b7876262ea8bf07b5d59f1b733b5aeb5302fdbbfd9cd801101e9da0eb8955c23";
const EXPECTED_V16_MANIFEST_SHA256 =
  "c8c036f3352256a85f2a227ebf3369ba5857319bcb05cdfaed5044251400b2bd";
const EXPECTED_V17_MANIFEST_SHA256 =
  "c73fccb75273fff2d3e1ec4e1b84fab3a0d580b62e2cb857635354f185c76dae";
const EXPECTED_V18_MANIFEST_SHA256 =
  "1c791e19b4a3706db26b21b5771402d848b8aed38496adbfa425186f77233aa6";
const EXPECTED_V21_MANIFEST_SHA256 =
  "4f82143569670933cf9080e38d312a827bc348a13b3a0dfb6ad233a0867f761b";

const EMBEDDED_NUL_FINGERPRINTS = [
  ["beginning", "\u0000" + "Z".repeat(63)],
  ["middle", "a".repeat(31) + "\u0000" + "Z".repeat(32)],
  ["end", "a".repeat(63) + "\u0000"],
] as const;

function physicalManifest(db: Db | DatabaseSync): readonly unknown[] {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'index', 'trigger', 'view')
       ORDER BY type, name, tableName`,
    )
    .all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>;
  return objects.map((object) => ({
    ...object,
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
        }>).map((indexColumn) => ({
          sequence: indexColumn.seqno,
          columnId: indexColumn.cid,
          columnName: indexColumn.name,
        }))
      : null,
  }));
}

function physicalManifestDigest(db: Db | DatabaseSync): string {
  return createHash("sha256").update(JSON.stringify(physicalManifest(db))).digest("hex");
}

function dropV20ConnectorSchema(db: Db | DatabaseSync): void {
  dropV21ProductionConnectorSchema(db);
  db.exec(`
    DROP INDEX IF EXISTS idx_connector_connections_workspace;
    DROP TABLE IF EXISTS connector_connections;
  `);
}

function restoreExactV6Schema(db: Db): void {
  dropV20ConnectorSchema(db);
  db.exec("DROP TRIGGER trg_cfp_email_verifications_issuance_sequence_guard");
  db.exec("DROP INDEX idx_cfp_email_verifications_scope_sequence");
  db.exec("ALTER TABLE cfp_email_verifications DROP COLUMN issuance_sequence");
  db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
  expect(physicalManifestDigest(db)).toBe(EXPECTED_V6_MANIFEST_SHA256);
}

function dropV18ObservationCorrectionSchema(db: Db | DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_observation_corrections_no_delete;
    DROP TRIGGER IF EXISTS trg_observation_corrections_immutable;
    DROP TRIGGER IF EXISTS trg_observation_corrections_guard;
    DROP INDEX IF EXISTS idx_observation_corrections_scope;
    DROP TABLE IF EXISTS observation_corrections;
  `);
}

function dropV19ObservationRecordingSchema(db: Db | DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_observation_audit_v19_guard;
    DROP TRIGGER IF EXISTS trg_observation_corrections_v19_guard;
    DROP TRIGGER IF EXISTS trg_observations_v19_guard;
  `);
  const hasRecordedAt = (db.prepare("PRAGMA table_info(observations)").all() as Array<{ name: string }>)
    .some((column) => column.name === "recorded_at");
  if (hasRecordedAt) db.exec("ALTER TABLE observations DROP COLUMN recorded_at");
}

function dropV17PublicationSchema(db: Db | DatabaseSync): void {
  db.exec(`
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
  `);
}

function dropV16ReviewerAccessSchema(db: Db | DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_reviewer_access_states_guard;
    DROP TRIGGER IF EXISTS trg_reviewer_access_states_immutable;
    DROP TRIGGER IF EXISTS trg_reviewer_access_states_no_delete;
    DROP TRIGGER IF EXISTS trg_reviewer_access_receipts_guard;
    DROP TRIGGER IF EXISTS trg_reviewer_access_receipts_immutable;
    DROP TRIGGER IF EXISTS trg_reviewer_access_receipts_no_delete;
    DROP INDEX IF EXISTS idx_reviewer_access_states_scope;
    DROP INDEX IF EXISTS idx_reviewer_access_receipts_scope;
    DROP TABLE IF EXISTS reviewer_access_states;
    DROP TABLE IF EXISTS reviewer_access_receipts;
  `);
}

function restoreExactV15Schema(db: Db | DatabaseSync): void {
  dropV20ConnectorSchema(db);
  dropV19ObservationRecordingSchema(db);
  dropV18ObservationCorrectionSchema(db);
  dropV17PublicationSchema(db);
  dropV16ReviewerAccessSchema(db);
  db.prepare("UPDATE meta SET value = '15' WHERE key = 'schema_version'").run();
  expect(physicalManifestDigest(db)).toBe(EXPECTED_V15_MANIFEST_SHA256);
}

function restoreExactV16Schema(db: Db | DatabaseSync): void {
  dropV20ConnectorSchema(db);
  dropV19ObservationRecordingSchema(db);
  dropV18ObservationCorrectionSchema(db);
  dropV17PublicationSchema(db);
  db.prepare("UPDATE meta SET value = '16' WHERE key = 'schema_version'").run();
  expect(physicalManifestDigest(db)).toBe(EXPECTED_V16_MANIFEST_SHA256);
}

function restoreExactV17Schema(db: Db | DatabaseSync): void {
  dropV20ConnectorSchema(db);
  dropV19ObservationRecordingSchema(db);
  dropV18ObservationCorrectionSchema(db);
  db.prepare("UPDATE meta SET value = '17' WHERE key = 'schema_version'").run();
  expect(physicalManifestDigest(db)).toBe(EXPECTED_V17_MANIFEST_SHA256);
}

function restoreExactV18Schema(db: Db | DatabaseSync): void {
  dropV20ConnectorSchema(db);
  dropV19ObservationRecordingSchema(db);
  db.prepare("UPDATE meta SET value = '18' WHERE key = 'schema_version'").run();
  expect(physicalManifestDigest(db)).toBe(EXPECTED_V18_MANIFEST_SHA256);
}

function insertV17Observation(db: Db | DatabaseSync, source: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, created_at)
     VALUES ('v17-observation-workspace', 'v17-observation', 'V17 observation fixture',
             '2026-08-14T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES ('v17-observation-event', 'v17-observation-workspace', 'V17 observation event', 'UTC',
             '2027-01-01T09:00:00.000Z', '2027-01-01T17:00:00.000Z', 'closed',
             '2026-08-14T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO people
       (id, workspace_id, canonical_email, full_name, created_at)
     VALUES ('v17-observation-person', 'v17-observation-workspace',
             'v17-observation@synthetic.invalid', 'V17 Synthetic Person',
             '2026-08-14T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO program_units
       (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
     VALUES ('v17-observation-unit', 'v17-observation-workspace', 'v17-observation-event',
             'V17 observation unit', 'SESSION', '2027-01-01T10:00:00.000Z',
             '2027-01-01T11:00:00.000Z', 40, '2026-08-14T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO observations
       (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
        observed_at, source, idempotency_key)
     VALUES ('v17-observation', 'v17-observation-workspace', 'v17-observation-event',
             'v17-observation-person', 'v17-observation-unit', 'attendance',
             '2027-01-01T10:05:00.000Z', ?, 'v17-observation-key')`,
  ).run(source);
}

function dropCurrentArtifactSchema(db: Db | DatabaseSync): void {
  dropV20ConnectorSchema(db);
  dropV19ObservationRecordingSchema(db);
  dropV18ObservationCorrectionSchema(db);
  dropV17PublicationSchema(db);
  dropV16ReviewerAccessSchema(db);
  db.exec(`
    DROP TRIGGER IF EXISTS trg_review_round_creation_receipts_guard;
    DROP TRIGGER IF EXISTS trg_review_round_creation_receipts_immutable;
    DROP TRIGGER IF EXISTS trg_review_round_creation_receipts_no_delete;
    DROP TRIGGER IF EXISTS trg_review_rounds_initialize_schedule;
    DROP TRIGGER IF EXISTS trg_review_round_schedule_versions_guard;
    DROP TRIGGER IF EXISTS trg_review_round_schedule_versions_immutable;
    DROP TRIGGER IF EXISTS trg_review_round_schedule_versions_no_delete;
    DROP INDEX IF EXISTS idx_review_round_schedule_versions_scope;
    DROP TABLE IF EXISTS review_round_creation_receipts;
    DROP TABLE IF EXISTS review_round_schedule_versions;
    DROP TRIGGER IF EXISTS trg_speaker_artifact_release_bindings_guard;
    DROP TRIGGER IF EXISTS trg_speaker_artifact_release_bindings_immutable;
    DROP TRIGGER IF EXISTS trg_speaker_artifact_release_bindings_no_delete;
    DROP INDEX IF EXISTS idx_speaker_artifact_release_bindings_scope;
    DROP TABLE IF EXISTS speaker_artifact_release_bindings;
    DROP TRIGGER IF EXISTS trg_artifact_records_scope_guard;
    DROP TRIGGER IF EXISTS trg_artifact_records_authority_guard;
    DROP TRIGGER IF EXISTS trg_artifact_records_lineage_guard;
    DROP TRIGGER IF EXISTS trg_artifact_records_immutable;
    DROP TRIGGER IF EXISTS trg_artifact_records_no_delete;
    DROP INDEX IF EXISTS idx_artifact_records_scope;
    DROP TABLE IF EXISTS artifact_records;
    DROP TRIGGER IF EXISTS trg_artifact_upload_intents_payload_guard;
    DROP TRIGGER IF EXISTS trg_artifact_upload_intents_immutable;
    DROP INDEX IF EXISTS idx_artifact_upload_intents_recovery;
    DROP TABLE IF EXISTS artifact_upload_intents;
    DROP TRIGGER IF EXISTS trg_speaker_portal_tokens_scope_guard;
    DROP TRIGGER IF EXISTS trg_speaker_portal_tokens_core_immutable;
    DROP TRIGGER IF EXISTS trg_speaker_portal_tokens_no_delete;
    DROP INDEX IF EXISTS idx_speaker_portal_tokens_scope;
    DROP TABLE IF EXISTS speaker_portal_tokens;
    DROP TRIGGER IF EXISTS trg_speaker_content_reviews_guard;
    DROP TRIGGER IF EXISTS trg_speaker_content_reviews_immutable;
    DROP TRIGGER IF EXISTS trg_speaker_content_reviews_no_delete;
    DROP INDEX IF EXISTS idx_speaker_content_reviews_scope;
    DROP TABLE IF EXISTS speaker_content_reviews;
    DROP TRIGGER IF EXISTS trg_speaker_content_versions_payload_guard;
    DROP TRIGGER IF EXISTS trg_speaker_content_versions_lineage_guard;
    DROP TRIGGER IF EXISTS trg_speaker_content_versions_immutable;
    DROP TRIGGER IF EXISTS trg_speaker_content_versions_no_delete;
    DROP INDEX IF EXISTS idx_speaker_content_versions_scope;
    DROP TABLE IF EXISTS speaker_content_versions;
    DROP TRIGGER IF EXISTS trg_speaker_tasks_scope_guard;
    DROP TRIGGER IF EXISTS trg_speaker_tasks_immutable_definition;
    DROP TRIGGER IF EXISTS trg_speaker_tasks_no_delete;
    DROP INDEX IF EXISTS idx_speaker_tasks_scope;
    DROP TABLE IF EXISTS speaker_tasks;
  `);
}

function restoreExactV9Schema(db: Db | DatabaseSync): void {
  dropV20ConnectorSchema(db);
  dropCurrentArtifactSchema(db);
  db.exec(`
    DROP TRIGGER IF EXISTS trg_artifact_records_scope_guard;
    DROP TRIGGER IF EXISTS trg_artifact_records_lineage_guard;
    DROP TRIGGER IF EXISTS trg_artifact_records_immutable;
    DROP TRIGGER IF EXISTS trg_artifact_records_no_delete;
    DROP INDEX IF EXISTS idx_artifact_records_scope;
    DROP TABLE IF EXISTS artifact_records;
    DROP TRIGGER IF EXISTS trg_cfp_submission_amendment_markers_guard;
    DROP TRIGGER IF EXISTS trg_cfp_submission_amendment_markers_immutable;
    DROP TRIGGER IF EXISTS trg_cfp_submission_amendment_markers_no_delete;
    DROP TRIGGER IF EXISTS trg_cfp_submission_revisions_workspace_guard;
    DROP INDEX IF EXISTS idx_cfp_submission_amendment_markers_submission;
    DROP TABLE IF EXISTS cfp_submission_amendment_markers;
    DROP TRIGGER IF EXISTS trg_v12_event_speakers_workspace_guard;
    DROP TRIGGER IF EXISTS trg_v12_event_speakers_workspace_update_guard;
    DROP TRIGGER IF EXISTS trg_v12_event_speakers_no_delete;
    DROP TRIGGER IF EXISTS trg_v12_event_tracks_workspace_guard;
    DROP TRIGGER IF EXISTS trg_v12_event_tracks_workspace_update_guard;
    DROP TRIGGER IF EXISTS trg_v12_event_rooms_workspace_guard;
    DROP TRIGGER IF EXISTS trg_v12_event_rooms_workspace_update_guard;
    DROP TRIGGER IF EXISTS trg_v12_domain_events_payload_guard;
    DROP TRIGGER IF EXISTS trg_v12_domain_events_immutable;
    DROP TRIGGER IF EXISTS trg_v12_domain_events_no_delete;
    DROP TRIGGER IF EXISTS trg_v12_outbox_workspace_guard;
    DROP TRIGGER IF EXISTS trg_v12_outbox_workspace_update_guard;
    DROP TRIGGER IF EXISTS trg_v12_event_session_allocations_guard;
    DROP TRIGGER IF EXISTS trg_v12_event_session_allocations_update_guard;
    DROP INDEX IF EXISTS idx_event_speakers_event_status;
    DROP INDEX IF EXISTS idx_event_session_allocations_event_time;
    DROP INDEX IF EXISTS idx_outbox_messages_delivery;
    DROP TABLE IF EXISTS outbox_messages;
    DROP TABLE IF EXISTS event_session_allocations;
    DROP TABLE IF EXISTS event_speakers;
    DROP TABLE IF EXISTS event_rooms;
    DROP TABLE IF EXISTS event_tracks;
    DROP TABLE IF EXISTS domain_events;
  `);
  db.exec(`
    DROP TRIGGER IF EXISTS trg_event_reviewer_assignments_guard;
    DROP TRIGGER IF EXISTS trg_event_reviewer_assignment_states_guard;
    DROP TRIGGER IF EXISTS trg_v10_review_context_versions_maximum_entries_guard;
    DROP TRIGGER IF EXISTS trg_recommendation_sets_guard;
    DROP TRIGGER IF EXISTS trg_recommendation_set_versions_guard;
    DROP TRIGGER IF EXISTS trg_recommendation_set_versions_finalize_or_immutable;
    DROP TRIGGER IF EXISTS trg_recommendation_entries_guard;
  `);
  db.exec("DROP TRIGGER IF EXISTS trg_review_context_versions_guard;");
  db.exec("DROP TRIGGER IF EXISTS trg_review_context_versions_immutable;");
  db.exec("DROP TRIGGER IF EXISTS trg_review_context_versions_no_delete;");
  db.exec("DROP TABLE review_context_versions;");
  db.exec(V9_DDL);
  db.prepare("UPDATE meta SET value = '9' WHERE key = 'schema_version'").run();
  expect(physicalManifestDigest(db)).toBe(EXPECTED_V9_MANIFEST_SHA256);
}

function restoreExactV10Schema(db: Db | DatabaseSync): void {
  restoreExactV9Schema(db);
  db.exec(V10_DDL);
  db.prepare("UPDATE meta SET value = '10' WHERE key = 'schema_version'").run();
  expect(physicalManifestDigest(db)).toBe(EXPECTED_V10_LEGACY_MANIFEST_SHA256);
}

function seedV12MigrationFixture(db: Db): void {
  const at = "2026-08-10T00:00:00.000Z";
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run("v12-workspace-a", "v12-a", "V12 A", at);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run("v12-workspace-b", "v12-b", "V12 B", at);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("v12-event-a", "v12-workspace-a", "V12 A", "UTC", "2026-09-01T00:00:00.000Z", "2026-09-01T23:00:00.000Z", at);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("v12-event-b", "v12-workspace-b", "V12 B", "UTC", "2026-09-01T00:00:00.000Z", "2026-09-01T23:00:00.000Z", at);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run("v12-person-a", "v12-workspace-a", "v12-a@example.test", "V12 A", at);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run("v12-person-b", "v12-workspace-b", "v12-b@example.test", "V12 B", at);
  for (const [id, workspaceId, eventId, name] of [
    ["v12-program-a", "v12-workspace-a", "v12-event-a", "Session A"],
    ["v12-program-a-2", "v12-workspace-a", "v12-event-a", "Session A2"],
    ["v12-program-b", "v12-workspace-b", "v12-event-b", "Session B"],
  ] as const) {
    db.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, workspaceId, eventId, name, "session", "2026-09-01T00:00:00.000Z", "2026-09-01T23:00:00.000Z", 10, at);
  }
  db.prepare("INSERT INTO event_rooms (id, workspace_id, event_id, name, created_at) VALUES (?, ?, ?, ?, ?)").run("v12-room-a", "v12-workspace-a", "v12-event-a", "Room A", at);
  db.prepare("INSERT INTO event_rooms (id, workspace_id, event_id, name, created_at) VALUES (?, ?, ?, ?, ?)").run("v12-room-b", "v12-workspace-b", "v12-event-b", "Room B", at);
  db.prepare("INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("v12-track-a", "v12-workspace-a", "v12-event-a", "Track A", "track-a", at);
  db.prepare("INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("v12-track-b", "v12-workspace-b", "v12-event-b", "Track B", "track-b", at);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("v12-speaker-a", "v12-workspace-a", "v12-event-a", "v12-person-a", at, at);

  const payloadA = canonicalJson({ eventId: "v12-event-a", kind: "session.created" });
  const payloadB = canonicalJson({ eventId: "v12-event-b", kind: "session.created" });
  db.prepare("INSERT INTO domain_events (id, workspace_id, event_type, aggregate_type, aggregate_id, payload_json, payload_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("v12-domain-a", "v12-workspace-a", "session.created", "program_unit", "v12-program-a", payloadA, fingerprintOf(JSON.parse(payloadA)), at);
  db.prepare("INSERT INTO domain_events (id, workspace_id, event_type, aggregate_type, aggregate_id, payload_json, payload_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("v12-domain-b", "v12-workspace-b", "session.created", "program_unit", "v12-program-b", payloadB, fingerprintOf(JSON.parse(payloadB)), at);
  db.prepare("INSERT INTO outbox_messages (id, workspace_id, domain_event_id, destination_key, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("v12-outbox-a", "v12-workspace-a", "v12-domain-a", "local-evaluator", payloadA, at);
  db.prepare("INSERT INTO event_session_allocations (id, workspace_id, event_id, program_unit_id, room_id, track_id, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("v12-allocation-a", "v12-workspace-a", "v12-event-a", "v12-program-a", "v12-room-a", "v12-track-a", "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", at, at);
  db.prepare("INSERT INTO event_session_allocations (id, workspace_id, event_id, program_unit_id, room_id, track_id, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("v12-allocation-a-2", "v12-workspace-a", "v12-event-a", "v12-program-a-2", "v12-room-a", "v12-track-a", "2026-09-01T12:00:00.000Z", "2026-09-01T13:00:00.000Z", at, at);
}

function expectV12UpdateGuards(db: Db): void {
  expect(() => db.prepare("UPDATE event_speakers SET workspace_id=?, event_id=?, person_id=? WHERE id=?").run("v12-workspace-b", "v12-event-b", "v12-person-b", "v12-speaker-a")).toThrow();
  expect(() => db.prepare("UPDATE event_tracks SET workspace_id=?, event_id=? WHERE id=?").run("v12-workspace-b", "v12-event-b", "v12-track-a")).toThrow();
  expect(() => db.prepare("UPDATE event_rooms SET workspace_id=?, event_id=? WHERE id=?").run("v12-workspace-b", "v12-event-b", "v12-room-a")).toThrow();
  const payloadB = canonicalJson({ eventId: "v12-event-b", kind: "session.created" });
  expect(() => db.prepare("UPDATE outbox_messages SET workspace_id=?, domain_event_id=?, payload_json=? WHERE id=?").run("v12-workspace-b", "v12-domain-b", payloadB, "v12-outbox-a")).toThrow();
  expect(() => db.prepare("UPDATE event_session_allocations SET workspace_id=?, event_id=?, program_unit_id=?, room_id=?, track_id=? WHERE id=?").run("v12-workspace-b", "v12-event-b", "v12-program-b", "v12-room-b", "v12-track-b", "v12-allocation-a")).toThrow();
  expect(() => db.prepare("UPDATE event_session_allocations SET updated_at=? WHERE id=?").run("2026-09-01T00:00:01.000Z", "v12-allocation-a")).not.toThrow();
  expect(() => db.prepare("UPDATE event_session_allocations SET starts_at=?, ends_at=?, updated_at=? WHERE id=?").run("2026-09-01T10:30:00.000Z", "2026-09-01T11:30:00.000Z", "2026-09-01T00:00:02.000Z", "v12-allocation-a-2")).toThrow();
}

function insertMinimalPd01Authority(db: Db): { readonly assignmentId: string; readonly fingerprint: string } {
  const at = "2026-08-10T00:01:00.000Z";
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run("v10-migration-workspace", "v10-migration", "V10 migration", at);
  db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("v10-migration-account", "v10-migration-workspace", "v10-migration@example.test", "V10 migration", "reviewer", at);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("v10-migration-person", "v10-migration-workspace", "v10-migration@example.test", "V10 migration", at);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("v10-migration-event", "v10-migration-workspace", "V10 migration", "UTC", "2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z", at);
  const binding = {
    schema: "pd01-account-person-binding/v1",
    workspaceId: "v10-migration-workspace",
    accountId: "v10-migration-account",
    personId: "v10-migration-person",
    boundByAccountId: "v10-migration-account",
    bindingBasis: "manual",
    createdAt: at,
  };
  db.prepare("INSERT INTO account_person_bindings (id, workspace_id, account_id, person_id, bound_by_account_id, binding_basis, created_at, fingerprint_algorithm, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("v10-migration-binding", binding.workspaceId, binding.accountId, binding.personId, binding.boundByAccountId, binding.bindingBasis, binding.createdAt, "sha256-canonical-json-v1", fingerprintOf(binding));
  const assignment = {
    schema: "pd01-event-reviewer-assignment/v1",
    workspaceId: binding.workspaceId,
    eventId: "v10-migration-event",
    reviewerAccountId: binding.accountId,
    reviewerPersonId: binding.personId,
    accountPersonBindingId: "v10-migration-binding",
    assignedByAccountId: binding.accountId,
    createdAt: at,
  };
  const assignmentFingerprint = fingerprintOf(assignment);
  db.prepare("INSERT INTO event_reviewer_assignments (id, workspace_id, event_id, reviewer_account_id, reviewer_person_id, account_person_binding_id, assigned_by_account_id, created_at, fingerprint_algorithm, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("v10-migration-assignment", assignment.workspaceId, assignment.eventId, assignment.reviewerAccountId, assignment.reviewerPersonId, assignment.accountPersonBindingId, assignment.assignedByAccountId, assignment.createdAt, "sha256-canonical-json-v1", assignmentFingerprint);
  db.prepare("INSERT INTO event_reviewer_assignment_states (id, workspace_id, event_id, event_reviewer_assignment_id, state, sequence_number, actor_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("v10-migration-state-1", assignment.workspaceId, assignment.eventId, "v10-migration-assignment", "ACTIVE", 1, assignment.assignedByAccountId, at);
  return { assignmentId: "v10-migration-assignment", fingerprint: assignmentFingerprint };
}

function restoreExactV5Schema(db: Db): void {
  restoreExactV6Schema(db);
  db.exec("DROP TRIGGER trg_review_blind_artifacts_guard");
  db.exec(V5_DDL);
  db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
  expect(physicalManifestDigest(db)).toBe(EXPECTED_V5_MANIFEST_SHA256);
}

function createV5Database(path: string): Db {
  const db = createLegacyV7Database({ path }) as unknown as Db;
  registerReceiptFunctions(db);
  restoreExactV5Schema(db);
  return db;
}

function createV6Database(path: string): Db {
  const db = createLegacyV7Database({ path }) as unknown as Db;
  registerReceiptFunctions(db);
  restoreExactV6Schema(db);
  return db;
}

function replaceTableSchemaSql(db: DatabaseSync, tableName: string, sql: string): void {
  db.exec("PRAGMA writable_schema = ON");
  try {
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?").run(sql, tableName);
  } finally {
    db.exec("PRAGMA writable_schema = OFF");
  }
}

function makeRequiredTextColumnNullable(db: DatabaseSync, tableName: string, columnName: string): string {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) as { sql: string } | undefined;
  const requiredDefinition = `\n  ${columnName} TEXT NOT NULL`;
  if (
    !row?.sql
    || row.sql.indexOf(requiredDefinition) < 0
    || row.sql.indexOf(requiredDefinition) !== row.sql.lastIndexOf(requiredDefinition)
  ) {
    throw new Error(`${tableName}.${columnName} required-column fixture is missing or ambiguous`);
  }
  replaceTableSchemaSql(db, tableName, row.sql.replace(requiredDefinition, `\n  ${columnName} TEXT`));
  return row.sql;
}

function legacyPhysicalManifest(db: Db | DatabaseSync): readonly unknown[] {
  return physicalManifest(db).filter((object) => {
    const row = object as { type: string; name: string; tableName: string };
    if (
      (row.type === "table" && row.name === "observations") ||
      (row.type === "trigger" && (
        row.name === "trg_observations_v19_guard" ||
        row.name === "trg_observation_corrections_v19_guard" ||
        row.name === "trg_observation_audit_v19_guard"
      ))
    ) return false;
    return row.type === "table"
      ? LEGACY_TABLE_SET.has(row.name)
      : LEGACY_TABLE_SET.has(row.tableName);
  });
}

function allLogicalSnapshot(db: Db | DatabaseSync): readonly unknown[] {
  const tables = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
  return tables.map((table) => db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all());
}

function tableNames(db: Db | DatabaseSync): readonly string[] {
  return (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
}

function logicalSnapshotForTables(db: Db | DatabaseSync, tables: readonly string[]): readonly unknown[] {
  return tables.map((table) => ({
    table,
    rows: db
      .prepare(
        table === "cfp_email_verifications"
          ? `SELECT id, workspace_id, call_id, email, token_hash, expires_at, created_at
             FROM cfp_email_verifications ORDER BY rowid`
          : table === "submissions"
            ? `SELECT id, workspace_id, event_id, call_id, owner_person_id, state,
                      pinned_form_version_id, pinned_rule_version_id, current_revision_id,
                      created_at, updated_at
               FROM submissions ORDER BY rowid`
          : `SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`,
      )
      .all(),
  }));
}

function physicalSubset(
  db: Db | DatabaseSync,
  expectedObjects: readonly unknown[],
): readonly unknown[] {
  const expectedVerificationTable = expectedObjects.find((object) => {
    const row = object as { type: string; name: string };
    return row.type === "table" && row.name === "cfp_email_verifications";
  }) as { readonly columns?: readonly { readonly name: string }[] | null } | undefined;
  const verificationTableIsPreV7 =
    expectedVerificationTable?.columns?.every(
      (column) => column.name !== "issuance_sequence",
    ) ?? false;
  const submissionTableIsPreV8 = (expectedObjects.find((object) => {
    const row = object as { type: string; name: string };
    return row.type === "table" && row.name === "submissions";
  }) as { readonly columns?: readonly { readonly name: string }[] | null } | undefined)?.columns?.every(
    (column) => column.name !== "lineage_id",
  ) ?? false;
  const keys = new Set(expectedObjects.map((object) => {
    const row = object as { type: string; name: string };
    return `${row.type}\u0000${row.name}`;
  }).filter((key) =>
    (!verificationTableIsPreV7 || key !== "table\u0000cfp_email_verifications") &&
    (!submissionTableIsPreV8 || key !== "table\u0000submissions"),
  ));
  return physicalManifest(db).filter((object) => {
    const row = object as { type: string; name: string };
    return keys.has(`${row.type}\u0000${row.name}`);
  });
}

function preV7PhysicalObjects(objects: readonly unknown[]): readonly unknown[] {
  // V8 adds the explicit nullable lineage binding to the legacy submission table. V13 also
  // deliberately replaces the submission-revision guard with the amendment-marker/decision
  // authority guard; expectAuthoritativeAmendmentGuard asserts that replacement separately.
  // V19 adds the ingestion timestamp to observations. Every other V7 physical object remains part
  // of this exact-history comparison; V19 convergence and backfill are asserted independently.
  return objects.filter((object) => {
    const row = object as { type: string; name: string };
    return !(row.type === "table" && (
      row.name === "cfp_email_verifications" || row.name === "submissions" || row.name === "observations"
    )) &&
      !(row.type === "trigger" && row.name === "trg_cfp_submission_revisions_workspace_guard");
  });
}

function expectAuthoritativeAmendmentGuard(db: Db | DatabaseSync): void {
  const trigger = db.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'trg_cfp_submission_revisions_workspace_guard'`,
  ).get() as { sql: string } | undefined;
  expect(trigger?.sql).toContain("s.state = 'SUBMITTED'");
  expect(trigger?.sql).toContain("cfp_submission_amendment_markers");
  expect(trigger?.sql).toContain("decision_event.event_type = 'cfp.submission.decision'");
}

function registerReceiptFunctions(db: Db): void {
  db.function("sympose_receipt_canonical_json", { deterministic: true }, (value) => {
    if (typeof value !== "string") return null;
    try { return canonicalJson(JSON.parse(value) as unknown); } catch { return null; }
  });
  db.function("sympose_receipt_fingerprint", { deterministic: true }, (value) => {
    if (typeof value !== "string") return null;
    try { return fingerprintOf(JSON.parse(value) as unknown); } catch { return null; }
  });
}

function metadataWithoutSchemaVersion(db: Db | DatabaseSync): readonly unknown[] {
  return metadataSnapshot(db).filter((row) => {
    const key = (row as { key: string }).key;
    return key !== "schema_version" && key !== "runtime_mode";
  });
}

function metadataSnapshot(db: Db | DatabaseSync): readonly unknown[] {
  return db.prepare("SELECT key, value FROM meta ORDER BY key").all();
}

function fileDatabaseSnapshot(path: string): {
  readonly logical: readonly unknown[];
  readonly metadata: readonly unknown[];
  readonly physical: readonly unknown[];
} {
  const db = new DatabaseSync(path);
  try {
    return {
      logical: allLogicalSnapshot(db),
      metadata: metadataSnapshot(db),
      physical: physicalManifest(db),
    };
  } finally {
    db.close();
  }
}

function legacyLogicalSnapshot(db: Db | DatabaseSync): readonly unknown[] {
  return LEGACY_TABLES.map((table) => db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all());
}

function insertCorruptAssignmentLineage(db: Db | DatabaseSync, insert: () => void): void {
  const guard = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'trg_review_assignments_workspace_guard'`,
    )
    .get() as { sql: string } | undefined;
  if (!guard?.sql) {
    throw new Error("review assignment guard fixture is missing");
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP TRIGGER trg_review_assignments_workspace_guard");
  try {
    insert();
  } finally {
    db.exec(guard.sql);
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function appendRevokedAssignmentState(
  db: Db | DatabaseSync,
  workspaceId: string,
  assignmentId: string,
  actorAccountId: string,
): void {
  db.prepare(
    `INSERT INTO review_assignment_states
       (id, workspace_id, assignment_id, state, sequence_number, actor_account_id, reason, created_at)
     VALUES (?, ?, ?, 'REVOKED', 2, ?, 'cycle isolation fixture', '2026-08-10T00:00:00.000Z')`,
  ).run(`revoked:${assignmentId}`, workspaceId, assignmentId, actorAccountId);
}

function reviewIntegrityFixture(db: Db, includeOrderedHistories = false): ReturnType<typeof cfpFixture> {
  const ids = cfpFixture(db);
  db.prepare(
    `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
     VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
  ).run(ids.workspaceId, ids.callId, ids.organizerAccountId);
  db.prepare(
    `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
     VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
  ).run(ids.workspaceId, "1".repeat(64), ids.organizerAccountId);
  db.prepare(
    `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
     VALUES ('rub2', ?, 'r1', 2, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
  ).run(ids.workspaceId, "2".repeat(64), ids.organizerAccountId);
  db.prepare(
    `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
     VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
  ).run(ids.workspaceId, ids.submissionId, ids.revisionId, ids.organizerAccountId, ids.organizerAccountId);
  db.prepare(
    `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
     VALUES ('conflict1', ?, 'a1', 'DECLARE', 1, ?, 'organizer', 'fixture', '2026-08-10T00:00:00.000Z')`,
  ).run(ids.workspaceId, ids.organizerAccountId);
  db.prepare(
    `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
     VALUES ('review1', ?, 'a1', 'r1', 'rub1', ?, ?, 1, 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', ?, '2026-08-10T00:00:00.000Z')`,
  ).run(ids.workspaceId, ids.submissionId, ids.revisionId, "3".repeat(64));
  if (includeOrderedHistories) {
    db.prepare(
      `INSERT INTO review_round_states
         (id, workspace_id, round_id, state, sequence_number, actor_account_id, reason, created_at)
       VALUES ('round-state-2', ?, 'r1', 'OPEN', 2, ?, 'ordered history fixture', '2026-08-10T00:00:00.000Z')`,
    ).run(ids.workspaceId, ids.organizerAccountId);
    db.prepare(
      `INSERT INTO review_assignment_states
         (id, workspace_id, assignment_id, state, sequence_number, actor_account_id, reason, created_at)
       VALUES ('assignment-state-2', ?, 'a1', 'IN_PROGRESS', 2, ?, 'ordered history fixture', '2026-08-10T00:00:00.000Z')`,
    ).run(ids.workspaceId, ids.organizerAccountId);
    db.prepare(
      `INSERT INTO review_conflict_dispositions
         (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
       VALUES ('conflict2', ?, 'a1', 'CLEAR', 2, ?, 'organizer', 'ordered history fixture', '2026-08-10T00:00:00.000Z')`,
    ).run(ids.workspaceId, ids.organizerAccountId);
  }
  return ids;
}

type TrustedArtifactTarget = "current" | "draft" | "stale";

function trustedReviewIntegrityFixture(db: Db, artifactTarget: TrustedArtifactTarget = "current") {
  const ids = reviewIntegrityFixture(db, true);
  if (artifactTarget === "stale") {
    saveDraftRevision(
      db,
      { workspaceId: ids.workspaceId, sessionId: ids.sessionId },
      {
        submissionId: ids.submissionId,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: ids.revisionId,
      },
    );
  }
  if (artifactTarget !== "draft") {
    db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(ids.submissionId);
  }
  const issuedAt = "2026-08-10T00:00:00.000Z";
  const assignment = db.prepare(
    "SELECT created_at FROM review_assignments WHERE id = 'a1'",
  ).get() as { created_at: string };
  const revision = db.prepare(
    `SELECT id, revision_number, revision_schema, fingerprint_algorithm, fingerprint, created_at,
            form_document_schema, form_version_id, rule_version_id, form_document_fingerprint
     FROM submission_revisions WHERE id = ?`,
  ).get(ids.revisionId) as {
    id: string;
    revision_number: number;
    revision_schema: string;
    fingerprint_algorithm: string;
    fingerprint: string;
    created_at: string;
    form_document_schema: string;
    form_version_id: string;
    rule_version_id: string;
    form_document_fingerprint: string;
  };
  const semanticsDocument = {
    schema: "cfp-review-rubric-semantics/v1",
    version: 1,
    workspaceId: ids.workspaceId,
    roundId: "r1",
    rubricVersionId: "rub1",
    rubricVersionNumber: 1,
    rubricVersionFingerprint: "1".repeat(64),
    issuer: {
      accountId: ids.organizerAccountId,
      role: "organizer",
      authority: "phase0.pipeline.manage",
    },
    issuedAt,
    criteria: [],
  };
  const semanticsJson = canonicalJson(semanticsDocument);
  const semanticsFingerprint = fingerprintOf(semanticsDocument);
  db.prepare(
    `INSERT INTO review_rubric_semantics
       (id, workspace_id, round_id, rubric_version_id, rubric_version_number,
        rubric_version_fingerprint, semantics_schema, semantics_version, semantics_json,
        fingerprint_algorithm, fingerprint, issued_by_account_id, issuer_role, issuer_authority,
        idempotency_key, request_fingerprint_algorithm, request_fingerprint, issued_at)
     VALUES ('semantics1', ?, 'r1', 'rub1', 1, ?, 'cfp-review-rubric-semantics/v1', 1, ?,
             'sha256-canonical-json-v1', ?, ?, 'organizer', 'phase0.pipeline.manage',
             'semantics-key', 'sha256-canonical-json-v1', ?, ?)`,
  ).run(
    ids.workspaceId,
    "1".repeat(64),
    semanticsJson,
    semanticsFingerprint,
    ids.organizerAccountId,
    "5".repeat(64),
    issuedAt,
  );

  const artifactDocument = {
    schema: "cfp-review-blind-artifact/v1",
    version: 1,
    workspaceId: ids.workspaceId,
    assignmentId: "a1",
    assignmentCreatedAt: assignment.created_at,
    rubricVersionId: "rub1",
    rubricSemanticsId: "semantics1",
    rubricSemanticsFingerprint: semanticsFingerprint,
    submissionId: ids.submissionId,
    submissionRevision: {
      id: revision.id,
      number: revision.revision_number,
      schema: revision.revision_schema,
      fingerprint: revision.fingerprint,
      createdAt: revision.created_at,
      formDocumentSchema: revision.form_document_schema,
      formVersionId: revision.form_version_id,
      ruleVersionId: revision.rule_version_id,
      formDocumentFingerprint: revision.form_document_fingerprint,
    },
    disclosureStage: "BLIND_REVIEW",
    conflictAtIssuance: { status: "CLEARED", sequenceNumber: 2 },
    attestation: "ORGANIZER_VERIFIED_BLIND_SAFE_REDACTION",
    issuer: {
      accountId: ids.organizerAccountId,
      role: "organizer",
      authority: "phase0.pipeline.manage",
    },
    issuedAt,
    sourceAnswerCount: 0,
    items: [],
  };
  const artifactJson = canonicalJson(artifactDocument);
  const artifactFingerprint = fingerprintOf(artifactDocument);
  db.prepare(
    `INSERT INTO review_blind_artifacts
       (id, workspace_id, assignment_id, assignment_created_at, rubric_version_id,
        rubric_semantics_id, rubric_semantics_fingerprint, submission_id, submission_revision_id,
        submission_revision_number, submission_revision_schema,
        submission_revision_fingerprint_algorithm, submission_revision_fingerprint,
        submission_revision_created_at, form_document_schema, form_version_id, rule_version_id,
        form_document_fingerprint, disclosure_stage, conflict_status_at_issuance,
        conflict_sequence_at_issuance, artifact_schema, artifact_version, artifact_json,
        fingerprint_algorithm, fingerprint, blind_safety_attestation, issued_by_account_id,
        issuer_role, issuer_authority, idempotency_key, request_fingerprint_algorithm,
        request_fingerprint, issued_at)
     VALUES ('artifact1', ?, 'a1', ?, 'rub1', 'semantics1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'BLIND_REVIEW', 'CLEARED', 2, 'cfp-review-blind-artifact/v1', 1, ?,
             'sha256-canonical-json-v1', ?, 'ORGANIZER_VERIFIED_BLIND_SAFE_REDACTION', ?,
             'organizer', 'phase0.pipeline.manage', 'artifact-key',
             'sha256-canonical-json-v1', ?, ?)`,
  ).run(
    ids.workspaceId,
    assignment.created_at,
    semanticsFingerprint,
    ids.submissionId,
    revision.id,
    revision.revision_number,
    revision.revision_schema,
    revision.fingerprint_algorithm,
    revision.fingerprint,
    revision.created_at,
    revision.form_document_schema,
    revision.form_version_id,
    revision.rule_version_id,
    revision.form_document_fingerprint,
    artifactJson,
    artifactFingerprint,
    ids.organizerAccountId,
    "6".repeat(64),
    issuedAt,
  );

  const receiptDocument = {
    schema: "cfp-review-command-receipt/v1",
    workspaceId: ids.workspaceId,
    assignmentId: "a1",
    roundId: "r1",
    rubricVersionId: "rub1",
    submissionRevisionId: revision.id,
    actorAccountId: ids.organizerAccountId,
    commandKind: "SAVE_REVIEW",
    effectId: "review1",
    createdAt: issuedAt,
    outcome: { reviewRevisionId: "review1", reviewRevisionNumber: 1 },
  };
  const receiptJson = canonicalJson(receiptDocument);
  db.prepare(
    `INSERT INTO review_command_receipts
       (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_revision_id,
        actor_account_id, command_kind, idempotency_key, request_schema,
        request_fingerprint_algorithm, request_fingerprint, effect_id, receipt_schema,
        receipt_json, receipt_fingerprint_algorithm, receipt_fingerprint, created_at)
     VALUES ('receipt1', ?, 'a1', 'r1', 'rub1', ?, ?, 'SAVE_REVIEW', 'save-key',
             'cfp-review-command-request/v1', 'sha256-canonical-json-v1', ?, 'review1',
             'cfp-review-command-receipt/v1', ?, 'sha256-canonical-json-v1', ?, ?)`,
  ).run(
    ids.workspaceId,
    revision.id,
    ids.organizerAccountId,
    "7".repeat(64),
    receiptJson,
    fingerprintOf(receiptDocument),
    issuedAt,
  );

  return {
    ids,
    semanticsDocument,
    semanticsJson,
    semanticsFingerprint,
    artifactDocument,
    artifactJson,
    artifactFingerprint,
    receiptDocument,
    receiptJson,
  };
}

describe("Review, correction, and observation-time V19 migrations", () => {
  it("migrates an exact V13 artifact-free database to current V21 and reopens at the converged manifest", () => {
    const path = pathFor("v13-to-v18-artifacts");
    try {
      const db = openDb({ path, seed: false });
      try {
        dropCurrentArtifactSchema(db);
        db.prepare("UPDATE meta SET value = '13' WHERE key = 'schema_version'").run();
        expect(physicalManifestDigest(db)).toBe(EXPECTED_V13_MANIFEST_SHA256);
      } finally {
        closeDb(db);
      }

      const migrated = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_records'").get()).toEqual({ name: "artifact_records" });
        expect(physicalManifestDigest(migrated)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(migrated);
      }

      const reopened = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("migrates an exact V16 database to current V21 and reopens at the converged manifest", () => {
    const path = pathFor("v16-to-v18");
    try {
      const current = openDb({ path, seed: false });
      try {
        restoreExactV16Schema(current);
      } finally {
        closeDb(current);
      }

      const migrated = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(migrated)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(migrated.prepare("SELECT COUNT(*) AS count FROM publication_release_versions").get()).toEqual({ count: 0 });
        expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(migrated);
      }

      const reopened = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("migrates an exact V17 database to current V21, replays additive DDL, and reopens", () => {
    const path = pathFor("v17-to-v18");
    try {
      const current = openDb({ path, seed: false });
      try {
        restoreExactV17Schema(current);
        insertV17Observation(current, "legacy-registration-import");
        expect(current.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'observation_corrections'",
        ).get()).toBeUndefined();
      } finally {
        closeDb(current);
      }

      const migrated = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(migrated)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(migrated.prepare("SELECT COUNT(*) AS count FROM observation_corrections").get()).toEqual({ count: 0 });
        expect(migrated.prepare(
          "SELECT source FROM observations WHERE id = 'v17-observation'",
        ).get()).toEqual({ source: "legacy-registration-import" });
        expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        migrated.exec(V19_DDL);
        expect(physicalManifestDigest(migrated)).toBe(EXPECTED_V21_MANIFEST_SHA256);
      } finally {
        closeDb(migrated);
      }

      const reopened = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("migrates exact V18 observation evidence to current V21 with conservative ingestion backfill", () => {
    const path = pathFor("v18-to-v19-observation-time");
    try {
      const current = openDb({ path, seed: false });
      try {
        restoreExactV18Schema(current);
        insertV17Observation(current, "legacy-registration-import");
      } finally {
        closeDb(current);
      }

      const migrated = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(migrated)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(migrated.prepare(
          `SELECT observed_at AS observedAt, recorded_at AS recordedAt, corrected_by AS correctedBy
           FROM observations WHERE id = 'v17-observation'`,
        ).get()).toEqual({
          observedAt: "2027-01-01T10:05:00.000Z",
          recordedAt: "2027-01-01T10:05:00.000Z",
          correctedBy: null,
        });
        migrated.exec(V19_DDL);
        expect(physicalManifestDigest(migrated)).toBe(EXPECTED_V21_MANIFEST_SHA256);
      } finally {
        closeDb(migrated);
      }

      const reopened = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    "before-ddl",
    "after-ddl",
    "after-integrity-check",
    "before-version-publication",
  ] as const)("rolls back exact V18 to current V21 at %s and remains retryable", (failureAt) => {
    const path = pathFor(`v18-to-v19-rollback-${failureAt}`);
    try {
      const current = openDb({ path, seed: false });
      try {
        restoreExactV18Schema(current);
        insertV17Observation(current, "legacy-registration-import");
      } finally {
        closeDb(current);
      }
      const beforeFailure = fileSnapshot(path);

      expect(() => openDbForTest({ path, seed: false }, failureAt)).toThrow("injected migration failure");
      expect(schemaVersion(path)).toBe("18");
      expect(fileSnapshot(path)).toBe(beforeFailure);
      const retained = new DatabaseSync(path);
      try {
        expect(physicalManifestDigest(retained)).toBe(EXPECTED_V18_MANIFEST_SHA256);
        expect((retained.prepare("PRAGMA table_info(observations)").all() as Array<{ name: string }>)
          .some((column) => column.name === "recorded_at")).toBe(false);
      } finally {
        retained.close();
      }

      const retried = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(retried)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(retried.prepare(
          "SELECT observed_at AS observedAt, recorded_at AS recordedAt FROM observations WHERE id = 'v17-observation'",
        ).get()).toEqual({
          observedAt: "2027-01-01T10:05:00.000Z",
          recordedAt: "2027-01-01T10:05:00.000Z",
        });
      } finally {
        closeDb(retried);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    "organizer-live-operations",
    "organizer-live-operations-correction",
  ])("rejects reserved source %s before V17 DDL and preserves the exact source", (reservedSource) => {
    const path = pathFor(`v17-reserved-observation-source-${reservedSource}`);
    try {
      const current = openDb({ path, seed: false });
      try {
        restoreExactV17Schema(current);
        insertV17Observation(current, reservedSource);
      } finally {
        closeDb(current);
      }

      expect(() => openDb({ path, seed: false })).toThrow("schema v18 reserved observation source collision");
      expect(schemaVersion(path)).toBe("17");
      const retained = new DatabaseSync(path);
      try {
        expect(physicalManifestDigest(retained)).toBe(EXPECTED_V17_MANIFEST_SHA256);
        expect(retained.prepare(
          "SELECT source FROM observations WHERE id = 'v17-observation'",
        ).get()).toEqual({ source: reservedSource });
        expect(retained.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'observation_corrections'",
        ).get()).toBeUndefined();
      } finally {
        retained.close();
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    "before-ddl",
    "after-ddl",
    "after-integrity-check",
    "before-version-publication",
  ] as const)("rolls back exact V17 to V18 at %s and remains retryable", (failureAt) => {
    const path = pathFor(`v17-to-v18-rollback-${failureAt}`);
    try {
      const current = openDb({ path, seed: false });
      try {
        restoreExactV17Schema(current);
      } finally {
        closeDb(current);
      }
      const beforeFailure = fileSnapshot(path);

      expect(() => openDbForTest({ path, seed: false }, failureAt)).toThrow("injected migration failure");
      expect(schemaVersion(path)).toBe("17");
      expect(fileSnapshot(path)).toBe(beforeFailure);
      const retained = new DatabaseSync(path);
      try {
        expect(physicalManifestDigest(retained)).toBe(EXPECTED_V17_MANIFEST_SHA256);
        expect(retained.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'observation_corrections'",
        ).get()).toBeUndefined();
      } finally {
        retained.close();
      }

      const retried = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(retried)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(retried.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(retried);
      }
      const reopened = openDb({ path, seed: false });
      try {
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("pins the literal legacy, V3, and V4 fixtures to accepted bases", () => {
    expect(LEGACY_FIXTURE_BASE_COMMIT).toBe("1c6fb60ae23b831597edc37c3cae2dd381f48474");
    expect(LEGACY_SCHEMA_MANIFEST_SHA256).toBe("898ad03da81ef4db425d4028c66bdf1bb2b84b01578caa325fd317df58ec5533");
    expect(V3_FIXTURE_BASE_COMMIT).toBe("17b7a92401c715448c7a195fa5a973bd52498eed");
    expect(V3_SCHEMA_MANIFEST_SHA256).toBe(EXPECTED_V3_MANIFEST_SHA256);
    expect(V4_FIXTURE_BASE_COMMIT).toBe("32fb5fdbe7616e2258dc17f8706a1310113e5902");
    expect(V4_SCHEMA_MANIFEST_SHA256).toBe(EXPECTED_V4_MANIFEST_SHA256);
  });

  it.each([
    "before-ddl",
    "after-ddl",
    "after-integrity-check",
    "before-version-publication",
  ] as const)("rolls back the exact V15 to V18 migration at %s and remains retryable after reopen", (failureAt) => {
    const path = pathFor("v15-to-v18-rollback-" + failureAt);
    try {
      const current = openDb({ path, seed: false });
      try {
        restoreExactV15Schema(current);
      } finally {
        closeDb(current);
      }
      const beforeFailure = fileSnapshot(path);

      expect(() => openDbForTest({ path, seed: false }, failureAt)).toThrow("injected migration failure");
      expect(schemaVersion(path)).toBe("15");
      expect(fileSnapshot(path)).toBe(beforeFailure);
      const retainedV15 = new DatabaseSync(path);
      try {
        expect(physicalManifestDigest(retainedV15)).toBe(EXPECTED_V15_MANIFEST_SHA256);
        expect(retainedV15.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reviewer_access_receipts'",
        ).get()).toBeUndefined();
      } finally {
        retainedV15.close();
      }

      const retried = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(retried)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(retried.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(retried);
      }

      const reopened = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(reopened.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('reviewer_access_receipts', 'reviewer_access_states') ORDER BY name",
        ).all()).toEqual([
          { name: "reviewer_access_receipts" },
          { name: "reviewer_access_states" },
        ]);
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("migrates the accepted literal V9 manifest through V21 and retains all guards after reopen", () => {
    const path = pathFor("v9-to-v19-clean");
    try {
      const v9 = openDb({ path, seed: false });
      try {
        restoreExactV9Schema(v9);
        expect(v9.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "9" });
      } finally {
        closeDb(v9);
      }

      const migrated = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(migrated)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        seedV12MigrationFixture(migrated);
        expectV12UpdateGuards(migrated);
      } finally {
        closeDb(migrated);
      }

      const reopened = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expectV12UpdateGuards(reopened);
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("upgrades V10 context rows without rewriting them and permits an identical context in another event", () => {
    const path = pathFor("v10-to-v11-context-fingerprint-scope");
    try {
      let before: unknown;
      const legacy = openDb({ path, seed: false });
      try {
        restoreExactV10Schema(legacy);
        insertMinimalPd01Authority(legacy);
        legacy.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run("v10-migration-event-2", "v10-migration-workspace", "V10 migration second event", "UTC", "2026-09-02T00:00:00.000Z", "2026-09-02T01:00:00.000Z", "2026-08-10T00:01:00.000Z");
        const documents = [
          ["v10-migration-policy", "ADVOCACY_POLICY", { schema: "pd01-advocacy-policy/v1", maximumEntries: 3, eligibleRevisions: [] }],
          ["v10-migration-visibility", "VISIBILITY", { schema: "pd01-visibility-snapshot/v1", visibleRevisions: [] }],
          ["v10-migration-blindness", "BLINDNESS", { schema: "pd01-blindness-policy/v1", disclosureStage: "BLIND_REVIEW", organizerAdvocacyAggregationPermitted: false }],
          ["v10-migration-selection", "SELECTION_CONTEXT", { schema: "pd01-selection-context/v1", decisionBoundary: "v10-boundary", resolvedRevisions: [] }],
        ] as const;
        const insertContext = legacy.prepare(
          "INSERT INTO review_context_versions (id, workspace_id, event_id, context_kind, version_number, context_schema, context_json, fingerprint_algorithm, fingerprint, issued_by_account_id, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const [id, kind, document] of documents) {
          insertContext.run(
            id,
            "v10-migration-workspace",
            "v10-migration-event",
            kind,
            1,
            document.schema,
            canonicalJson(document),
            "sha256-canonical-json-v1",
            fingerprintOf(document),
            "v10-migration-account",
            "2026-08-10T00:01:00.000Z",
          );
        }
        legacy.prepare(
          "INSERT INTO recommendation_sets (id, workspace_id, event_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          "v10-migration-set",
          "v10-migration-workspace",
          "v10-migration-event",
          "v10-migration-account",
          "v10-migration-person",
          "v10-migration-assignment",
          "v10-migration-binding",
          "2026-08-10T00:01:00.000Z",
        );
        legacy.prepare(
          `INSERT INTO recommendation_set_versions
             (id, workspace_id, event_id, recommendation_set_id, reviewer_account_id, reviewer_person_id,
              event_reviewer_assignment_id, account_person_binding_id, version_number, eligibility_snapshot_json,
              eligibility_fingerprint, maximum_entries, policy_version_id, policy_version_fingerprint,
              visibility_version_id, visibility_version_fingerprint, blindness_version_id, blindness_version_fingerprint,
              selection_context_version_id, selection_context_reference, selection_context_fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "v10-migration-set-version",
          "v10-migration-workspace",
          "v10-migration-event",
          "v10-migration-set",
          "v10-migration-account",
          "v10-migration-person",
          "v10-migration-assignment",
          "v10-migration-binding",
          1,
          "[]",
          fingerprintOf([]),
          3,
          "v10-migration-policy",
          fingerprintOf(documents[0][2]),
          "v10-migration-visibility",
          fingerprintOf(documents[1][2]),
          "v10-migration-blindness",
          fingerprintOf(documents[2][2]),
          "v10-migration-selection",
          "v10-boundary",
          fingerprintOf(documents[3][2]),
          "2026-08-10T00:01:00.000Z",
        );
        before = {
          contexts: legacy.prepare("SELECT * FROM review_context_versions ORDER BY id").all(),
          recommendationSets: legacy.prepare("SELECT * FROM recommendation_sets ORDER BY id").all(),
          recommendationVersions: legacy.prepare("SELECT * FROM recommendation_set_versions ORDER BY id").all(),
        };
      } finally {
        closeDb(legacy);
      }

      const beforeMigration = fileSnapshot(path);
      expect(() => openDbForTest({ path, seed: false }, "after-ddl")).toThrow("injected migration failure");
      expect(schemaVersion(path)).toBe("10");
      expect(fileSnapshot(path)).toBe(beforeMigration);

      const migrated = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(migrated)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect({
          contexts: migrated.prepare("SELECT * FROM review_context_versions ORDER BY id").all(),
          recommendationSets: migrated.prepare("SELECT * FROM recommendation_sets ORDER BY id").all(),
          recommendationVersions: migrated.prepare("SELECT * FROM recommendation_set_versions ORDER BY id").all(),
        }).toEqual(before);
        migrated.prepare(
          "INSERT INTO review_context_versions (id, workspace_id, event_id, context_kind, version_number, context_schema, context_json, fingerprint_algorithm, fingerprint, issued_by_account_id, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          "v11-migration-blindness",
          "v10-migration-workspace",
          "v10-migration-event-2",
          "BLINDNESS",
          1,
          "pd01-blindness-policy/v1",
          canonicalJson({ schema: "pd01-blindness-policy/v1", disclosureStage: "BLIND_REVIEW", organizerAdvocacyAggregationPermitted: false }),
          "sha256-canonical-json-v1",
          fingerprintOf({ schema: "pd01-blindness-policy/v1", disclosureStage: "BLIND_REVIEW", organizerAdvocacyAggregationPermitted: false }),
          "v10-migration-account",
          "2026-08-10T00:01:00.000Z",
        );
        expect(migrated.prepare("SELECT COUNT(*) AS count FROM review_context_versions WHERE workspace_id = 'v10-migration-workspace' AND context_kind = 'BLINDNESS'").get()).toEqual({ count: 2 });
      } finally {
        closeDb(migrated);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("rolls back a corrupt V9 migration and remains retryable after repair", () => {
    const path = pathFor("v9-to-v10-rollback-retry");
    try {
      const v10 = openDb({ path, seed: false });
      let assignmentFingerprint: string;
      try {
        ({ fingerprint: assignmentFingerprint } = insertMinimalPd01Authority(v10));
      } finally {
        closeDb(v10);
      }

      const corrupt = new DatabaseSync(path);
      corrupt.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON; DROP TRIGGER trg_event_reviewer_assignments_immutable;");
      const corruptAssignment = {
        schema: "pd01-event-reviewer-assignment/v1",
        workspaceId: "v10-migration-workspace",
        eventId: "v10-migration-event",
        reviewerAccountId: "v10-migration-account",
        reviewerPersonId: "v10-migration-person",
        accountPersonBindingId: "v10-migration-binding",
        assignedByAccountId: "v10-migration-account",
        createdAt: "2026-08-10T00:00:00.000Z",
      };
      corrupt.prepare("UPDATE event_reviewer_assignments SET created_at = ?, fingerprint = ? WHERE id = ?")
        .run(corruptAssignment.createdAt, fingerprintOf(corruptAssignment), "v10-migration-assignment");
      restoreExactV9Schema(corrupt);
      corrupt.close();

      const beforeFailure = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(/PD-01 V10 assignment chronology/);
      expect(schemaVersion(path)).toBe("9");
      const retainedV9 = new DatabaseSync(path);
      try {
        expect(physicalManifestDigest(retainedV9)).toBe(EXPECTED_V9_MANIFEST_SHA256);
        expect(retainedV9.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "9" });
      } finally {
        retainedV9.close();
      }
      expect(fileSnapshot(path)).toBe(beforeFailure);

      const repaired = new DatabaseSync(path);
      repaired.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON; DROP TRIGGER trg_event_reviewer_assignments_immutable;");
      repaired.prepare("UPDATE event_reviewer_assignments SET created_at = ?, fingerprint = ? WHERE id = ?")
        .run("2026-08-10T00:01:00.000Z", assignmentFingerprint, "v10-migration-assignment");
      restoreExactV9Schema(repaired);
      repaired.close();

      const retried = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(retried)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(retried.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(retried);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([1, 2, 3, 4, 5, 6] as const)("migrates an exact empty V%s database to V21", (version) => {
    const path = pathFor(`empty-v${version}`);
    try {
      if (version === 6) {
        closeDb(createV6Database(path));
      } else if (version === 5) {
        closeDb(createV5Database(path));
      } else if (version === 4) {
        createLegacyV4Database({ path }).close();
      } else if (version === 3) {
        closeDb(createLegacyV3Database({ path }));
      } else {
        createLegacyFile(path, version);
      }
      const legacyBeforeDb = new DatabaseSync(path);
      let beforeLegacy: readonly unknown[] = [];
      let beforeLegacyPhysical: readonly unknown[] = [];
      let beforeLegacyMetadata: readonly unknown[] = [];
      try {
        beforeLegacy = legacyLogicalSnapshot(legacyBeforeDb);
        beforeLegacyPhysical = legacyPhysicalManifest(legacyBeforeDb);
        beforeLegacyMetadata = metadataSnapshot(legacyBeforeDb);
      } finally {
        legacyBeforeDb.close();
      }
      const db = openDb({ path, seed: false });
      try {
        expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
        expect(db.prepare("SELECT COUNT(*) AS count FROM review_rounds").get()).toEqual({ count: 0 });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(legacyLogicalSnapshot(db)).toEqual(beforeLegacy);
        expect(legacyPhysicalManifest(db)).toEqual(beforeLegacyPhysical);
        expect(metadataWithoutSchemaVersion(db)).toEqual(
          beforeLegacyMetadata.filter((row) => !["schema_version", "runtime_mode"].includes((row as { key: string }).key)),
        );
      } finally {
        closeDb(db);
      }
      const reopened = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(physicalManifest(reopened).filter((object) => (object as { type: string }).type === "table")).toHaveLength(95);
        expect(physicalManifest(reopened).filter((object) => (object as { type: string }).type === "index")).toHaveLength(81);
        expect(physicalManifest(reopened).filter((object) => (object as { type: string }).type === "trigger")).toHaveLength(261);
        expect(physicalManifest(reopened).filter((object) => (object as { type: string }).type === "view")).toHaveLength(0);
        expect(reopened.prepare("SELECT COUNT(*) AS count FROM review_rounds").get()).toEqual({ count: 0 });
        expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(legacyLogicalSnapshot(reopened)).toEqual(beforeLegacy);
        expect(legacyPhysicalManifest(reopened)).toEqual(beforeLegacyPhysical);
        expect(metadataWithoutSchemaVersion(reopened)).toEqual(
          beforeLegacyMetadata.filter((row) => !["schema_version", "runtime_mode"].includes((row as { key: string }).key)),
        );
      } finally {
        closeDb(reopened);
      }
      const reopenedAgain = openDb({ path, seed: false });
      try {
        expect(physicalManifestDigest(reopenedAgain)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(reopenedAgain.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(reopenedAgain);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("converges fresh and every supported upgrade on one exact V21 physical manifest", () => {
    const sources = ["fresh", 1, 2, 3, 4, 5, 6, 15, 16, 17, 18] as const;
    const paths = sources.map((source) => pathFor(`manifest-convergence-${source}`));
    try {
      const manifests = sources.map((source, index) => {
        const path = paths[index]!;
        if (source === 18) {
          const current = openDb({ path, seed: false });
          try {
            restoreExactV18Schema(current);
          } finally {
            closeDb(current);
          }
        } else if (source === 17) {
          const current = openDb({ path, seed: false });
          try {
            restoreExactV17Schema(current);
          } finally {
            closeDb(current);
          }
        } else if (source === 16) {
          const current = openDb({ path, seed: false });
          try {
            restoreExactV16Schema(current);
          } finally {
            closeDb(current);
          }
        } else if (source === 15) {
          const current = openDb({ path, seed: false });
          try {
            restoreExactV15Schema(current);
          } finally {
            closeDb(current);
          }
        } else if (source === 6) {
          closeDb(createV6Database(path));
        } else if (source === 5) {
          closeDb(createV5Database(path));
        } else if (source === 4) {
          createLegacyV4Database({ path }).close();
        } else if (source === 3) {
          createLegacyV3Database({ path }).close();
        } else if (source === 1 || source === 2) {
          createLegacyFile(path, source);
        }
        const db = openDb({ path, seed: false });
        try {
          expect(schemaVersion(path)).toBe("21");
          expect(physicalManifestDigest(db)).toBe(EXPECTED_V21_MANIFEST_SHA256);
          return physicalManifest(db);
        } finally {
          closeDb(db);
        }
      });
      for (const manifest of manifests.slice(1)) {
        expect(manifest).toEqual(manifests[0]);
      }
    } finally {
      for (const path of paths) {
        removeSqliteFiles(path);
      }
    }
  }, 20_000);

  it("backfills a V6 issuance sequence only from a provable durable chronology", () => {
    const path = pathFor("v6-verification-sequence-provable");
    try {
      const legacy = createV6Database(path);
      let fixture: ReturnType<typeof cfpFixture>;
      try {
        fixture = cfpFixture(legacy);
        legacy.prepare(
          `INSERT INTO cfp_email_verifications
             (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
           VALUES ('migration-cfp-verification-older', ?, ?,
                   'migration-cfp@synthetic.example', ?, ?, ?)`,
        ).run(
          fixture.workspaceId,
          fixture.callId,
          "c".repeat(64),
          "2099-08-10T00:00:00.000Z",
          "2026-08-09T23:59:59.999Z",
        );
      } finally {
        closeDb(legacy);
      }

      const migrated = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(
          migrated
            .prepare(
              `SELECT id, created_at, issuance_sequence
               FROM cfp_email_verifications
               WHERE workspace_id = ? AND call_id = ? AND email = ?
               ORDER BY issuance_sequence`,
            )
            .all(
              fixture.workspaceId,
              fixture.callId,
              "migration-cfp@synthetic.example",
            ),
        ).toEqual([
          {
            id: "migration-cfp-verification-older",
            created_at: "2026-08-09T23:59:59.999Z",
            issuance_sequence: 1,
          },
          {
            id: "migration-cfp-verification",
            created_at: "2026-08-10T00:00:00.000Z",
            issuance_sequence: 2,
          },
        ]);
        expect(physicalManifestDigest(migrated)).toBe(
          EXPECTED_V21_MANIFEST_SHA256,
        );
      } finally {
        closeDb(migrated);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("rejects an equal-timestamp same-scope V6 history without mutation", () => {
    const path = pathFor("v6-verification-sequence-ambiguous");
    try {
      const legacy = createV6Database(path);
      try {
        const fixture = cfpFixture(legacy);
        legacy.prepare(
          `INSERT INTO cfp_email_verifications
             (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
           VALUES ('migration-cfp-verification-ambiguous', ?, ?,
                   'migration-cfp@synthetic.example', ?, ?, ?)`,
        ).run(
          fixture.workspaceId,
          fixture.callId,
          "d".repeat(64),
          "2099-08-10T00:00:00.000Z",
          "2026-08-10T00:00:00.000Z",
        );
      } finally {
        closeDb(legacy);
      }
      const before = {
        file: fileSnapshot(path),
        ...fileDatabaseSnapshot(path),
      };
      expect(() => openDb({ path, seed: false })).toThrow(
        /^malformed schema v6: verification issuance chronology is ambiguous within an exact workspace\/call\/email scope$/u,
      );
      expect(schemaVersion(path)).toBe("6");
      expect({
        file: fileSnapshot(path),
        ...fileDatabaseSnapshot(path),
      }).toEqual(before);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("reopen rejects a manifest-preserving V7 issuance-sequence gap", () => {
    const path = pathFor("v7-verification-sequence-gap");
    try {
      const db = createLegacyV7Database({ path }) as unknown as Db;
      try {
        const fixture = cfpFixture(db);
        db.prepare(
          `INSERT INTO cfp_email_verifications
             (id, workspace_id, call_id, email, token_hash, expires_at, created_at,
              issuance_sequence)
           VALUES ('migration-cfp-verification-second', ?, ?,
                   'migration-cfp@synthetic.example', ?, ?, ?, 2)`,
        ).run(
          fixture.workspaceId,
          fixture.callId,
          "e".repeat(64),
          "2099-08-10T00:00:00.000Z",
          "2026-08-10T00:00:00.001Z",
        );
      } finally {
        closeDb(db);
      }
      const raw = new DatabaseSync(path);
      try {
        raw.exec("DROP TRIGGER trg_cfp_email_verifications_immutable");
        raw.prepare(
          `UPDATE cfp_email_verifications
           SET issuance_sequence = 3
           WHERE id = 'migration-cfp-verification-second'`,
        ).run();
        raw.exec(LEGACY_V7_DDL);
        expect(physicalManifestDigest(raw)).toBe(V7_SCHEMA_MANIFEST_SHA256);
      } finally {
        raw.close();
      }
      const before = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(
        /^database verification issuance integrity check failed$/u,
      );
      expect(fileSnapshot(path)).toBe(before);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("migrates populated V2 rows without rewriting legacy truth", () => {
    const path = pathFor("populated-v2");
    try {
      createLegacyFile(path, 2);
      const seed = new DatabaseSync(path);
      try {
        insertWorkspaceMarker(seed, {
          id: "v2-workspace",
          slug: "v2",
          name: "V2 workspace",
          createdAt: "2026-08-10T00:00:00.000Z",
        });
        seed.prepare(
          `INSERT INTO accounts (id, workspace_id, email, display_name, created_at)
           VALUES ('v2-account', 'v2-workspace', 'v2@synthetic.example', 'V2', ?)`,
        ).run("2026-08-10T00:00:00.000Z");
        seed.prepare(
          `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
           VALUES ('v2-person', 'v2-workspace', 'v2-person@synthetic.example', 'V2 Person', ?)`,
        ).run("2026-08-10T00:00:00.000Z");
      } finally {
        seed.close();
      }
      const beforeMigrationDb = new DatabaseSync(path);
      let beforeTables: readonly string[] = [];
      let beforeLogical: readonly unknown[] = [];
      let beforePhysical: readonly unknown[] = [];
      let beforeMetadata: readonly unknown[] = [];
      try {
        beforeTables = tableNames(beforeMigrationDb).filter((table) => table !== "meta");
        beforeLogical = logicalSnapshotForTables(beforeMigrationDb, beforeTables);
        beforePhysical = physicalManifest(beforeMigrationDb);
        beforeMetadata = metadataWithoutSchemaVersion(beforeMigrationDb);
      } finally {
        beforeMigrationDb.close();
      }
      const migrated = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(migrated.prepare("SELECT id FROM people WHERE id = 'v2-person'").get()).toEqual({ id: "v2-person" });
        expect(migrated.prepare("SELECT COUNT(*) AS count FROM review_rounds").get()).toEqual({ count: 0 });
        expect(logicalSnapshotForTables(migrated, beforeTables)).toEqual(beforeLogical);
        expect(physicalSubset(migrated, preV7PhysicalObjects(beforePhysical))).toEqual(
          preV7PhysicalObjects(beforePhysical),
        );
        expect(metadataWithoutSchemaVersion(migrated)).toEqual(beforeMetadata);
      } finally {
        closeDb(migrated);
      }
      const reopened = openDb({ path, seed: false });
      try {
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(logicalSnapshotForTables(reopened, beforeTables)).toEqual(beforeLogical);
        expect(physicalSubset(reopened, preV7PhysicalObjects(beforePhysical))).toEqual(
          preV7PhysicalObjects(beforePhysical),
        );
        expect(metadataWithoutSchemaVersion(reopened)).toEqual(beforeMetadata);
      } finally {
        closeDb(reopened);
      }
      const reopenedAgain = openDb({ path, seed: false });
      try {
        expect(physicalManifestDigest(reopenedAgain)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(reopenedAgain.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(logicalSnapshotForTables(reopenedAgain, beforeTables)).toEqual(beforeLogical);
        expect(physicalSubset(reopenedAgain, preV7PhysicalObjects(beforePhysical))).toEqual(
          preV7PhysicalObjects(beforePhysical),
        );
        expect(metadataWithoutSchemaVersion(reopenedAgain)).toEqual(beforeMetadata);
      } finally {
        closeDb(reopenedAgain);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("migrates populated V3 rows without rewriting legacy or CFP truth", () => {
    const path = pathFor("populated-v3");
    try {
      const db = createLegacyV3Database({ path });
      let ids: ReturnType<typeof cfpFixture>;
      try {
        ids = cfpFixture(db);
      } finally {
        db.close();
      }
      const beforeMigrationDb = new DatabaseSync(path);
      let beforeTables: readonly string[] = [];
      let beforeLogical: readonly unknown[] = [];
      let beforePhysical: readonly unknown[] = [];
      let beforeMetadata: readonly unknown[] = [];
      try {
        beforeTables = tableNames(beforeMigrationDb).filter((table) => table !== "meta");
        beforeLogical = logicalSnapshotForTables(beforeMigrationDb, beforeTables);
        beforePhysical = physicalManifest(beforeMigrationDb);
        beforeMetadata = metadataWithoutSchemaVersion(beforeMigrationDb);
      } finally {
        beforeMigrationDb.close();
      }
      const migrated = openDb({ path, seed: false });
      try {
          expect(schemaVersion(path)).toBe("21");
        expectAuthoritativeAmendmentGuard(migrated);
        expect(migrated.prepare("SELECT id FROM submissions WHERE id = ?").get(ids.submissionId)).toEqual({ id: ids.submissionId });
        expect(migrated.prepare("SELECT COUNT(*) AS count FROM review_rounds").get()).toEqual({ count: 0 });
        expect(logicalSnapshotForTables(migrated, beforeTables)).toEqual(beforeLogical);
        expect(physicalSubset(migrated, preV7PhysicalObjects(beforePhysical))).toEqual(
          preV7PhysicalObjects(beforePhysical),
        );
        expect(metadataWithoutSchemaVersion(migrated)).toEqual(beforeMetadata);
      } finally {
        closeDb(migrated);
      }
      const reopened = openDb({ path, seed: false });
      try {
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expectAuthoritativeAmendmentGuard(reopened);
        expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(logicalSnapshotForTables(reopened, beforeTables)).toEqual(beforeLogical);
        expect(physicalSubset(reopened, preV7PhysicalObjects(beforePhysical))).toEqual(
          preV7PhysicalObjects(beforePhysical),
        );
        expect(metadataWithoutSchemaVersion(reopened)).toEqual(beforeMetadata);
      } finally {
        closeDb(reopened);
      }
      const reopenedAgain = openDb({ path, seed: false });
      try {
        expect(physicalManifestDigest(reopenedAgain)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(reopenedAgain.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(logicalSnapshotForTables(reopenedAgain, beforeTables)).toEqual(beforeLogical);
        expect(physicalSubset(reopenedAgain, preV7PhysicalObjects(beforePhysical))).toEqual(
          preV7PhysicalObjects(beforePhysical),
        );
        expect(metadataWithoutSchemaVersion(reopenedAgain)).toEqual(beforeMetadata);
      } finally {
        closeDb(reopenedAgain);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("migrates populated V4 to V21 without rewriting pre-V7 logical truth", () => {
    const path = pathFor("populated-v4");
    const rejectedRubricJson =
      '{"criteria":[],"blindAnswerHashes":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"schema":"cfp-rubric/v1"}';
    try {
      const legacy = createLegacyV4Database({ path }) as unknown as Db;
      try {
        reviewIntegrityFixture(legacy, true);
        const immutable = legacy.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_rubric_versions_immutable'",
        ).get() as { sql: string };
        legacy.exec("DROP TRIGGER trg_rubric_versions_immutable");
        legacy.prepare("UPDATE rubric_versions SET rubric_json = ? WHERE id = 'rub1'").run(rejectedRubricJson);
        legacy.exec(immutable.sql);
      } finally {
        legacy.close();
      }

      const beforeDb = new DatabaseSync(path);
      let beforeTables: readonly string[] = [];
      let beforeLogical: readonly unknown[] = [];
      let beforePhysical: readonly unknown[] = [];
      let beforeMetadata: readonly unknown[] = [];
      try {
        expect(physicalManifestDigest(beforeDb)).toBe(EXPECTED_V4_MANIFEST_SHA256);
        beforeTables = tableNames(beforeDb).filter((table) => table !== "meta");
        beforeLogical = logicalSnapshotForTables(beforeDb, beforeTables);
        beforePhysical = physicalManifest(beforeDb);
        beforeMetadata = metadataWithoutSchemaVersion(beforeDb);
      } finally {
        beforeDb.close();
      }

      const migrated = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(migrated)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expectAuthoritativeAmendmentGuard(migrated);
        expect(logicalSnapshotForTables(migrated, beforeTables)).toEqual(beforeLogical);
        expect(physicalSubset(migrated, preV7PhysicalObjects(beforePhysical))).toEqual(
          preV7PhysicalObjects(beforePhysical),
        );
        expect(metadataWithoutSchemaVersion(migrated)).toEqual(beforeMetadata);
        expect(migrated.prepare("SELECT rubric_json FROM rubric_versions WHERE id = 'rub1'").get()).toEqual({
          rubric_json: rejectedRubricJson,
        });
        expect(migrated.prepare("SELECT COUNT(*) AS count FROM review_rubric_semantics").get()).toEqual({ count: 0 });
        expect(migrated.prepare("SELECT COUNT(*) AS count FROM review_blind_artifacts").get()).toEqual({ count: 0 });
        expect(migrated.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 0 });
      } finally {
        closeDb(migrated);
      }

      const reopened = openDb({ path, seed: false });
      try {
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expectAuthoritativeAmendmentGuard(reopened);
        expect(logicalSnapshotForTables(reopened, beforeTables)).toEqual(beforeLogical);
        expect(physicalSubset(reopened, preV7PhysicalObjects(beforePhysical))).toEqual(
          preV7PhysicalObjects(beforePhysical),
        );
        expect(metadataWithoutSchemaVersion(reopened)).toEqual(beforeMetadata);
        expect(reopened.prepare("SELECT rubric_json FROM rubric_versions WHERE id = 'rub1'").get()).toEqual({
          rubric_json: rejectedRubricJson,
        });
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["before-ddl", 1],
    ["after-ddl", 1],
    ["after-integrity-check", 1],
    ["before-version-publication", 1],
    ["before-ddl", 2],
    ["after-ddl", 2],
    ["after-integrity-check", 2],
    ["before-version-publication", 2],
    ["before-ddl", 3],
    ["after-ddl", 3],
    ["after-integrity-check", 3],
    ["before-version-publication", 3],
    ["before-ddl", 4],
    ["after-ddl", 4],
    ["after-integrity-check", 4],
    ["before-version-publication", 4],
    ["before-ddl", 5],
    ["after-ddl", 5],
    ["after-integrity-check", 5],
    ["before-version-publication", 5],
    ["before-ddl", 6],
    ["after-ddl", 6],
    ["after-integrity-check", 6],
    ["before-version-publication", 6],
  ] as const)("rolls back migration at %s for V%i and retries", (failureAt, sourceVersion) => {
    const path = pathFor(`rollback-v${sourceVersion}-${failureAt}`);
    try {
      if (sourceVersion === 6) {
        closeDb(createV6Database(path));
      } else if (sourceVersion === 5) {
        closeDb(createV5Database(path));
      } else if (sourceVersion === 4) {
        createLegacyV4Database({ path }).close();
      } else if (sourceVersion === 3) {
        closeDb(createLegacyV3Database({ path }));
      } else {
        createLegacyFile(path, sourceVersion);
      }
      const beforeFailure = fileSnapshot(path);

      expect(() => openDbForTest({ path, seed: false }, failureAt)).toThrow("injected migration failure");
      expect(schemaVersion(path)).toBe(String(sourceVersion));
      expect(fileSnapshot(path)).toBe(beforeFailure);

      const retried = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(retried)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(retried.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(retried);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["before-ddl", 2],
    ["after-ddl", 2],
    ["after-integrity-check", 2],
    ["before-version-publication", 2],
    ["before-ddl", 3],
    ["after-ddl", 3],
    ["after-integrity-check", 3],
    ["before-version-publication", 3],
    ["before-ddl", 4],
    ["after-ddl", 4],
    ["after-integrity-check", 4],
    ["before-version-publication", 4],
    ["before-ddl", 5],
    ["after-ddl", 5],
    ["after-integrity-check", 5],
    ["before-version-publication", 5],
    ["before-ddl", 6],
    ["after-ddl", 6],
    ["after-integrity-check", 6],
    ["before-version-publication", 6],
  ] as const)("rolls back populated migration at %s for V%i byte-for-byte and retries", (failureAt, sourceVersion) => {
    const path = pathFor(`populated-v${sourceVersion}-rollback-${failureAt}`);
    try {
      let submissionId: string | undefined;
      if (sourceVersion === 6) {
        const db = createV6Database(path);
        try {
          submissionId = trustedReviewIntegrityFixture(db).ids.submissionId;
        } finally {
          closeDb(db);
        }
      } else if (sourceVersion === 5) {
        const db = createV5Database(path);
        try {
          submissionId = trustedReviewIntegrityFixture(db).ids.submissionId;
        } finally {
          closeDb(db);
        }
      } else if (sourceVersion === 4) {
        const db = createLegacyV4Database({ path }) as unknown as Db;
        try {
          submissionId = reviewIntegrityFixture(db).submissionId;
        } finally {
          db.close();
        }
      } else if (sourceVersion === 3) {
        const db = createLegacyV3Database({ path });
        try {
          submissionId = cfpFixture(db).submissionId;
        } finally {
          db.close();
        }
      } else {
        createLegacyFile(path, 2);
        const seed = new DatabaseSync(path);
        try {
          insertWorkspaceMarker(seed, {
            id: "pop-workspace",
            slug: "pop",
            name: "Populated workspace",
            createdAt: "2026-08-10T00:00:00.000Z",
          });
          seed.prepare(
            `INSERT INTO accounts (id, workspace_id, email, display_name, created_at)
             VALUES ('pop-account', 'pop-workspace', 'pop@synthetic.example', 'Populated', ?)`,
          ).run("2026-08-10T00:00:00.000Z");
        } finally {
          seed.close();
        }
      }

      const beforeFailure = fileSnapshot(path);
      expect(() => openDbForTest({ path, seed: false }, failureAt)).toThrow("injected migration failure");
      expect(schemaVersion(path)).toBe(String(sourceVersion));
      expect(fileSnapshot(path)).toBe(beforeFailure);

      const retried = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        if (submissionId) {
          expect(retried.prepare("SELECT id FROM submissions WHERE id = ?").get(submissionId)).toEqual({ id: submissionId });
        }
        expect(retried.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeDb(retried);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("refuses a physical V3 database relabelled as V1 without mutation", () => {
    const path = pathFor("relabelled-v3");
    try {
      closeDb(createLegacyV3Database({ path }));
      const raw = new DatabaseSync(path);
      try {
        raw.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
      } finally {
        raw.close();
      }
      const beforeFailure = {
        file: fileSnapshot(path),
        ...fileDatabaseSnapshot(path),
      };
      expect(() => openDb({ path, seed: false })).toThrow(/^malformed schema v1$/);
      expect({
        file: fileSnapshot(path),
        ...fileDatabaseSnapshot(path),
      }).toEqual(beforeFailure);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("refuses a physical V3 database relabelled as V2 without mutation", () => {
    const path = pathFor("relabelled-v3-v2");
    try {
      closeDb(createLegacyV3Database({ path }));
      const raw = new DatabaseSync(path);
      try {
        raw.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
      } finally {
        raw.close();
      }
      const beforeFailure = {
        file: fileSnapshot(path),
        ...fileDatabaseSnapshot(path),
      };
      expect(() => openDb({ path, seed: false })).toThrow(/^malformed schema v2$/);
      expect({
        file: fileSnapshot(path),
        ...fileDatabaseSnapshot(path),
      }).toEqual(beforeFailure);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("refuses a modified V3 database whose physical manifest differs from accepted digest", () => {
    const path = pathFor("modified-v3-manifest");
    try {
      closeDb(createLegacyV3Database({ path }));
      const raw = new DatabaseSync(path);
      try {
        raw.exec("CREATE TABLE unexpected_v3_table (id TEXT PRIMARY KEY)");
      } finally {
        raw.close();
      }
      const beforeFailure = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(/^malformed schema v3$/);
      expect(fileSnapshot(path)).toBe(beforeFailure);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("validates the exact V4 manifest and tenant integrity before opening the V7 transaction", () => {
    const manifestPath = pathFor("modified-v4-manifest");
    const tenantPath = pathFor("corrupt-v4-tenant");
    try {
      createLegacyV4Database({ path: manifestPath }).close();
      const manifestRaw = new DatabaseSync(manifestPath);
      try {
        manifestRaw.exec("CREATE TABLE unexpected_v4_table (id TEXT PRIMARY KEY)");
      } finally {
        manifestRaw.close();
      }
      const manifestBefore = fileDatabaseSnapshot(manifestPath);
      expect(() => openDb({ path: manifestPath, seed: false })).toThrow(/^malformed schema v4$/);
      expect(fileDatabaseSnapshot(manifestPath)).toEqual(manifestBefore);

      const tenant = createLegacyV4Database({ path: tenantPath }) as unknown as Db;
      try {
        reviewIntegrityFixture(tenant);
        tenant.prepare(
          `INSERT INTO workspaces (id, slug, name, created_at)
           VALUES ('other-workspace', 'other', 'Other workspace', '2026-08-10T00:00:00.000Z')`,
        ).run();
        tenant.prepare(
          `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
           VALUES ('other-reviewer', 'other-workspace', 'other-reviewer@synthetic.example',
                   'Other reviewer', 'reviewer', '2026-08-10T00:00:00.000Z')`,
        ).run();
        const immutable = tenant.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_review_assignments_immutable'",
        ).get() as { sql: string };
        tenant.exec("DROP TRIGGER trg_review_assignments_immutable");
        tenant.prepare("UPDATE review_assignments SET reviewer_account_id = 'other-reviewer' WHERE id = 'a1'").run();
        tenant.exec(immutable.sql);
      } finally {
        tenant.close();
      }
      const tenantBefore = fileDatabaseSnapshot(tenantPath);
      expect(() => openDb({ path: tenantPath, seed: false })).toThrow(/tenant integrity check failed/);
      expect(fileDatabaseSnapshot(tenantPath)).toEqual(tenantBefore);
      expect(schemaVersion(tenantPath)).toBe("4");
    } finally {
      removeSqliteFiles(manifestPath);
      removeSqliteFiles(tenantPath);
    }
  });

  it.each([1, 2, 3, 4, 5, 6] as const)("refuses a physical V7 database relabelled as V%s without mutation", (relabelledVersion) => {
    const path = pathFor(`relabelled-v7-v${relabelledVersion}`);
    try {
      const created = openDb({ path, seed: false });
      closeDb(created);
      const raw = new DatabaseSync(path);
      try {
        raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(relabelledVersion));
      } finally {
        raw.close();
      }
      const beforeFailure = {
        file: fileSnapshot(path),
        ...fileDatabaseSnapshot(path),
      };
      expect(() => openDb({ path, seed: false })).toThrow(new RegExp(`^malformed schema v${relabelledVersion}$`));
      expect({
        file: fileSnapshot(path),
        ...fileDatabaseSnapshot(path),
      }).toEqual(beforeFailure);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("keeps the accepted sealed-release V1 refusal fail-closed", () => {
    const path = pathFor("sealed-release-v1");
    try {
      createLegacyFile(path, 1);
      const db = new DatabaseSync(path);
      try {
        insertWorkspaceMarker(db, {
          id: "release-workspace",
          slug: "release",
          name: "Release workspace",
          createdAt: "2026-08-10T00:00:00.000Z",
        });
        db.prepare(
          `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
           VALUES ('release-event', 'release-workspace', 'Release event', 'UTC', ?, ?, ?)`,
        ).run("2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z", "2026-08-10T00:00:00.000Z");
        db.prepare(
          `INSERT INTO plan_runs
             (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json,
              compiler, compiler_version, created_at)
           VALUES ('release-run', 'release-workspace', 'release-event', 'SUCCEEDED', 'input', '{}', 'synthetic', '1', ?)`,
        ).run("2026-08-10T00:00:00.000Z");
        db.prepare(
          `INSERT INTO plan_versions
             (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
           VALUES ('release-plan', 'release-workspace', 'release-event', 'release-run', 1, 'plan', '{}', ?)`,
        ).run("2026-08-10T00:00:00.000Z");
        db.prepare(
          `INSERT INTO publication_releases
             (id, workspace_id, event_id, plan_version_id, audience_policy_version,
              commitment_watermark, fingerprint, content_json, sealed_at)
           VALUES ('release', 'release-workspace', 'release-event', 'release-plan', 1, 1, 'release', '{}', ?)`,
        ).run("2026-08-10T00:00:00.000Z");
      } finally {
        db.close();
      }
      expect(() => openDb({ path, seed: false })).toThrow(/schema v1 contains sealed publication releases/);
      expect(schemaVersion(path)).toBe("1");
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["malformed-metadata", (db: DatabaseSync) => db.prepare("UPDATE meta SET value = 'not-a-version' WHERE key = 'schema_version'").run()],
    ["missing-metadata-table", (db: DatabaseSync) => { db.exec("PRAGMA foreign_keys = OFF"); db.exec("DROP TABLE meta"); }],
    ["extra-metadata-column", (db: DatabaseSync) => db.exec("ALTER TABLE meta ADD COLUMN unexpected_metadata TEXT")],
    ["missing-table", (db: DatabaseSync) => { db.exec("PRAGMA foreign_keys = OFF"); db.exec("DROP TABLE people"); }],
    ["missing-column", (db: DatabaseSync) => db.exec("ALTER TABLE workspaces DROP COLUMN name")],
    ["changed-column", (db: DatabaseSync) => db.exec("ALTER TABLE workspaces RENAME COLUMN name TO renamed_name")],
    ["missing-index", (db: DatabaseSync) => db.exec("DROP INDEX idx_people_workspace")],
    ["missing-trigger", (db: DatabaseSync) => db.exec("DROP TRIGGER trg_sessions_workspace_guard")],
    ["changed-index", (db: DatabaseSync) => {
      db.exec("DROP INDEX idx_people_workspace");
      db.exec("CREATE INDEX idx_people_workspace ON people(canonical_email)");
    }],
    ["changed-trigger", (db: DatabaseSync) => {
      db.exec("DROP TRIGGER trg_sessions_workspace_guard");
      db.exec("CREATE TRIGGER trg_sessions_workspace_guard BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'changed'); END");
    }],
    ["extra-table", (db: DatabaseSync) => db.exec("CREATE TABLE unexpected_schema_object (id TEXT PRIMARY KEY)")],
    ["extra-index", (db: DatabaseSync) => db.exec("CREATE INDEX unexpected_index ON people(canonical_email)")],
    ["extra-trigger", (db: DatabaseSync) => db.exec("CREATE TRIGGER unexpected_trigger AFTER INSERT ON people BEGIN SELECT 1; END")],
    ["unknown-metadata", (db: DatabaseSync) => db.prepare("INSERT INTO meta (key, value) VALUES ('unknown', 'value')").run()],
    ["malformed-seed-metadata", (db: DatabaseSync) => db.prepare("INSERT INTO meta (key, value) VALUES ('seed_version', '2')").run()],
  ] as const)("rejects %s legacy physical corruption without open-time mutation", (name, mutate) => {
    const path = pathFor(`malformed-${name}`);
    try {
      createLegacyFile(path, 2);
      const raw = new DatabaseSync(path);
      try {
        mutate(raw);
      } finally {
        raw.close();
      }
      const beforeOpen = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow();
      expect(fileSnapshot(path)).toBe(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("rejects populated legacy foreign-key corruption without mutation", () => {
    const path = pathFor("foreign-key-corruption");
    try {
      createLegacyFile(path, 2);
      const raw = new DatabaseSync(path);
      try {
        insertWorkspaceMarker(raw, {
          id: "fk-workspace",
          slug: "fk",
          name: "FK workspace",
          createdAt: "2026-08-10T00:00:00.000Z",
        });
        raw.prepare(
          `INSERT INTO accounts (id, workspace_id, email, display_name, created_at)
           VALUES ('fk-account', 'fk-workspace', 'fk@synthetic.example', 'FK', ?)`,
        ).run("2026-08-10T00:00:00.000Z");
        raw.prepare(
          `INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at)
           VALUES ('fk-session', 'fk-token', 'fk-account', 'fk-workspace', ?, ?)`,
        ).run("2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
        raw.exec("PRAGMA foreign_keys = OFF");
        raw.prepare("UPDATE sessions SET account_id = 'missing-account' WHERE id = 'fk-session'").run();
      } finally {
        raw.close();
      }
      const beforeOpen = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(/foreign-key check failed/);
      expect(fileSnapshot(path)).toBe(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("rejects populated legacy tenant corruption without mutation", () => {
    const path = pathFor("tenant-corruption");
    try {
      createLegacyFile(path, 2);
      const raw = new DatabaseSync(path);
      try {
        insertWorkspaceMarker(raw, {
          id: "tenant-one",
          slug: "tenant-one",
          name: "Tenant one",
          createdAt: "2026-08-10T00:00:00.000Z",
        });
        insertWorkspaceMarker(raw, {
          id: "tenant-two",
          slug: "tenant-two",
          name: "Tenant two",
          createdAt: "2026-08-10T00:00:00.000Z",
        });
        raw.prepare(
          `INSERT INTO accounts (id, workspace_id, email, display_name, created_at)
           VALUES ('tenant-account', 'tenant-one', 'tenant@synthetic.example', 'Tenant', ?)`,
        ).run("2026-08-10T00:00:00.000Z");
        raw.prepare(
          `INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at)
           VALUES ('tenant-session', 'tenant-token', 'tenant-account', 'tenant-one', ?, ?)`,
        ).run("2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
        raw.prepare("UPDATE accounts SET workspace_id = 'tenant-two' WHERE id = 'tenant-account'").run();
      } finally {
        raw.close();
      }
      const beforeOpen = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(fileSnapshot(path)).toBe(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("reopen detects post-migration V19 manifest and tenant tampering", () => {
    const manifestPath = pathFor("post-v7-manifest-tamper");
    const tenantPath = pathFor("post-v7-tenant-tamper");
    try {
      closeDb(openDb({ path: manifestPath, seed: false }));
      const manifestRaw = new DatabaseSync(manifestPath);
      try {
        manifestRaw.exec("DROP TRIGGER trg_cfp_submissions_no_delete");
      } finally {
        manifestRaw.close();
      }
      const manifestBefore = fileSnapshot(manifestPath);
      expect(() => openDb({ path: manifestPath, seed: false })).toThrow(/malformed schema v21/);
      expect(fileSnapshot(manifestPath)).toBe(manifestBefore);

      const tenantDb = openDb({ path: tenantPath });
      const account = tenantDb.prepare(
        `SELECT a.id, a.workspace_id AS workspaceId
         FROM accounts a JOIN workspaces w ON w.id = a.workspace_id
         WHERE w.slug = 'northstar' LIMIT 1`,
      ).get() as { id: string; workspaceId: string };
      tenantDb.prepare(
        `INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at)
         VALUES ('post-v5-session', 'post-v5-token', ?, ?, ?, ?)`,
      ).run(account.id, account.workspaceId, "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
      tenantDb.prepare(
        "UPDATE accounts SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'acme') WHERE id = ?",
      ).run(account.id);
      closeDb(tenantDb);
      const tenantBefore = fileSnapshot(tenantPath);
      expect(() => openDb({ path: tenantPath, seed: false })).toThrow(/tenant integrity check failed/);
      expect(fileSnapshot(tenantPath)).toBe(tenantBefore);
    } finally {
      removeSqliteFiles(manifestPath);
      removeSqliteFiles(tenantPath);
    }
  });

  it("migrates canonical V5 trusted-review rows and preserves valid sealing", () => {
    const path = pathFor("trusted-review-reopen");
    try {
      const db = createV5Database(path);
      try {
        trustedReviewIntegrityFixture(db);
      } finally {
        closeDb(db);
      }
      const reopened = openDb({ path, seed: false });
      try {
        expect(schemaVersion(path)).toBe("21");
        expect(physicalManifestDigest(reopened)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(reopened.prepare("SELECT COUNT(*) AS count FROM review_rubric_semantics").get()).toEqual({ count: 1 });
        expect(reopened.prepare("SELECT COUNT(*) AS count FROM review_blind_artifacts").get()).toEqual({ count: 1 });
        expect(reopened.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 1 });
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["draft", { state: "DRAFT", assignment_is_current: 1 }],
    ["stale", { state: "SUBMITTED", assignment_is_current: 0 }],
  ] as const)("rejects a legacy V5 blind artifact with a %s submission target on reopen", (target, expectedTarget) => {
    const path = pathFor(`trusted-review-v5-${target}-target`);
    try {
      const db = createV5Database(path);
      try {
        trustedReviewIntegrityFixture(db, target);
        expect(
          db.prepare(
            `SELECT submission.state,
                    submission.current_revision_id = assignment.submission_revision_id
                      AS assignment_is_current
             FROM review_blind_artifacts artifact
             JOIN review_assignments assignment ON assignment.id = artifact.assignment_id
             JOIN submissions submission ON submission.id = assignment.submission_id
             WHERE artifact.id = 'artifact1'`,
          ).get(),
        ).toEqual(expectedTarget);
      } finally {
        closeDb(db);
      }

      const beforeOpen = fileDatabaseSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(/database tenant integrity check failed/);
      expect(schemaVersion(path)).toBe("5");
      expect(fileDatabaseSnapshot(path)).toEqual(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("fails closed on an unregistered raw connection after restoring the receipt guard", () => {
    const path = pathFor("trusted-review-unregistered-receipt-guard");
    const createdAt = "2026-08-10T00:00:01.000Z";
    try {
      const db = openDb({ path });
      const data = trustedReviewIntegrityFixture(db);
      db.prepare(
        `INSERT INTO review_revisions
           (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id,
            submission_revision_id, revision_number, evaluation_schema, evaluation_json,
            fingerprint_algorithm, fingerprint, created_at)
         VALUES ('raw-guard-review', ?, 'a1', 'r1', 'rub1', ?, ?, 2,
                 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', ?, ?)`,
      ).run(data.ids.workspaceId, data.ids.submissionId, data.ids.revisionId, "9".repeat(64), createdAt);
      closeDb(db);

      const receiptDocument = {
        ...data.receiptDocument,
        effectId: "raw-guard-review",
        createdAt,
        outcome: { reviewRevisionId: "raw-guard-review", reviewRevisionNumber: 2 },
      };
      const receiptJson = canonicalJson(receiptDocument);
      const receiptFingerprint = fingerprintOf(receiptDocument);
      const insertSql = `INSERT INTO review_command_receipts
           (id, workspace_id, assignment_id, round_id, rubric_version_id,
            submission_revision_id, actor_account_id, command_kind, idempotency_key,
            request_schema, request_fingerprint_algorithm, request_fingerprint, effect_id,
            receipt_schema, receipt_json, receipt_fingerprint_algorithm, receipt_fingerprint,
            created_at)
         VALUES ('raw-guard-receipt', ?, 'a1', 'r1', 'rub1', ?, ?, 'SAVE_REVIEW',
                 'raw-guard-key', 'cfp-review-command-request/v1',
                 'sha256-canonical-json-v1', ?, 'raw-guard-review',
                 'cfp-review-command-receipt/v1', ?, 'sha256-canonical-json-v1', ?, ?)`;
      const insertValues = [
        data.ids.workspaceId,
        data.ids.revisionId,
        data.ids.organizerAccountId,
        "8".repeat(64),
        receiptJson,
        receiptFingerprint,
        createdAt,
      ] as const;

      const raw = new DatabaseSync(path);
      try {
        raw.exec("DROP TRIGGER trg_review_command_receipts_guard");
        raw.exec(DDL);
        expect(physicalManifestDigest(raw)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(() => raw.prepare(insertSql).run(...insertValues)).toThrow(
          /no such function: sympose_receipt_canonical_json/,
        );
        expect(raw.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 1 });
      } finally {
        raw.close();
      }

      const registered = openDb({ path, seed: false });
      try {
        registered.prepare(insertSql).run(...insertValues);
      } finally {
        closeDb(registered);
      }
      const reopened = openDb({ path, seed: false });
      try {
        expect(reopened.prepare(
          `SELECT receipt_json AS receiptJson, receipt_fingerprint AS receiptFingerprint
           FROM review_command_receipts WHERE id = 'raw-guard-receipt'`,
        ).get()).toEqual({ receiptJson, receiptFingerprint });
        expect(reopened.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 2 });
      } finally {
        closeDb(reopened);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("reopens immutable issuer evidence after legitimate current-role demotion and promotion", () => {
    const path = pathFor("trusted-review-historical-issuer-role");
    const evidenceTables = ["review_rubric_semantics", "review_blind_artifacts"] as const;
    try {
      const db = openDb({ path });
      const data = trustedReviewIntegrityFixture(db);
      const issuedEvidence = logicalSnapshotForTables(db, evidenceTables);
      expect(db.prepare("SELECT role FROM accounts WHERE id = ?").get(data.ids.organizerAccountId)).toEqual({
        role: "organizer",
      });
      db.prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?").run(data.ids.organizerAccountId);
      closeDb(db);

      const demoted = openDb({ path, seed: false });
      try {
        expect(demoted.prepare("SELECT role FROM accounts WHERE id = ?").get(data.ids.organizerAccountId)).toEqual({
          role: "reviewer",
        });
        expect(logicalSnapshotForTables(demoted, evidenceTables)).toEqual(issuedEvidence);
        demoted.prepare("UPDATE accounts SET role = 'event_manager' WHERE id = ?").run(data.ids.organizerAccountId);
      } finally {
        closeDb(demoted);
      }

      const promoted = openDb({ path, seed: false });
      try {
        expect(promoted.prepare("SELECT role FROM accounts WHERE id = ?").get(data.ids.organizerAccountId)).toEqual({
          role: "event_manager",
        });
        expect(logicalSnapshotForTables(promoted, evidenceTables)).toEqual(issuedEvidence);
        expect(physicalManifestDigest(promoted)).toBe(EXPECTED_V21_MANIFEST_SHA256);
      } finally {
        closeDb(promoted);
      }
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("rejects duplicate command effects after bypassing and exactly restoring the receipt guard", () => {
    const path = pathFor("trusted-review-duplicate-command-effect");
    try {
      const db = openDb({ path });
      const data = trustedReviewIntegrityFixture(db);
      closeDb(db);

      const aliasDocument = {
        ...data.receiptDocument,
        replayAlias: "canonical-distinct-receipt",
      };
      const raw = new DatabaseSync(path);
      try {
        raw.exec("DROP TRIGGER trg_review_command_receipts_guard");
        raw.prepare(
          `INSERT INTO review_command_receipts
             (id, workspace_id, assignment_id, round_id, rubric_version_id,
              submission_revision_id, actor_account_id, command_kind, idempotency_key,
              request_schema, request_fingerprint_algorithm, request_fingerprint, effect_id,
              receipt_schema, receipt_json, receipt_fingerprint_algorithm, receipt_fingerprint,
              created_at)
           SELECT 'receipt-alias', workspace_id, assignment_id, round_id, rubric_version_id,
                  submission_revision_id, actor_account_id, command_kind, 'save-alias-key',
                  request_schema, request_fingerprint_algorithm, ?, effect_id, receipt_schema, ?,
                  receipt_fingerprint_algorithm, ?, created_at
           FROM review_command_receipts WHERE id = 'receipt1'`,
        ).run(
          fingerprintOf({ request: "save-alias" }),
          canonicalJson(aliasDocument),
          fingerprintOf(aliasDocument),
        );
        expect(raw.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 2 });
        raw.exec(DDL);
        expect(physicalManifestDigest(raw)).toBe(EXPECTED_V21_MANIFEST_SHA256);
      } finally {
        raw.close();
      }

      const beforeOpen = { file: fileSnapshot(path), ...fileDatabaseSnapshot(path) };
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect({ file: fileSnapshot(path), ...fileDatabaseSnapshot(path) }).toEqual(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["missing", (document: Record<string, unknown>) => {
      const corrupted = { ...document };
      delete corrupted.outcome;
      return corrupted;
    }],
    ["extra", (document: Record<string, unknown>) => ({
      ...document,
      outcome: { reviewRevisionId: "review1", reviewRevisionNumber: 1, extra: true },
    })],
    ["review ID type", (document: Record<string, unknown>) => ({
      ...document,
      outcome: { reviewRevisionId: 1, reviewRevisionNumber: 1 },
    })],
    ["review ID", (document: Record<string, unknown>) => ({
      ...document,
      outcome: { reviewRevisionId: "missing-review", reviewRevisionNumber: 1 },
    })],
    ["review number type", (document: Record<string, unknown>) => ({
      ...document,
      outcome: { reviewRevisionId: "review1", reviewRevisionNumber: "1" },
    })],
    ["review number", (document: Record<string, unknown>) => ({
      ...document,
      outcome: { reviewRevisionId: "review1", reviewRevisionNumber: 2 },
    })],
    ["non-object", (document: Record<string, unknown>) => ({ ...document, outcome: ["review1", 1] })],
    ["command-swapped", (document: Record<string, unknown>) => ({
      ...document,
      outcome: { effectId: "review1" },
    })],
  ] as const)("rejects a trigger-bypass %s receipt outcome after restoring the exact manifest", (name, corrupt) => {
    const path = pathFor(`trusted-review-outcome-${name.replaceAll(" ", "-")}`);
    try {
      const db = openDb({ path });
      const data = trustedReviewIntegrityFixture(db);
      closeDb(db);

      const corruptedDocument = corrupt(data.receiptDocument as unknown as Record<string, unknown>);
      const raw = new DatabaseSync(path);
      try {
        raw.exec("DROP TRIGGER trg_review_command_receipts_immutable");
        raw.prepare(
          `UPDATE review_command_receipts
           SET receipt_json = ?, receipt_fingerprint = ?
           WHERE id = 'receipt1'`,
        ).run(canonicalJson(corruptedDocument), fingerprintOf(corruptedDocument));
        raw.exec(DDL);
        expect(physicalManifestDigest(raw)).toBe(EXPECTED_V21_MANIFEST_SHA256);
      } finally {
        raw.close();
      }

      const beforeOpen = { file: fileSnapshot(path), ...fileDatabaseSnapshot(path) };
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect({ file: fileSnapshot(path), ...fileDatabaseSnapshot(path) }).toEqual(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["semantics noncanonical JSON", "review_rubric_semantics", "trg_review_rubric_semantics_immutable", (db: DatabaseSync) => {
      db.prepare("UPDATE review_rubric_semantics SET semantics_json = ' ' || semantics_json WHERE id = 'semantics1'").run();
    }],
    ["artifact noncanonical JSON", "review_blind_artifacts", "trg_review_blind_artifacts_immutable", (db: DatabaseSync) => {
      db.prepare("UPDATE review_blind_artifacts SET artifact_json = ' ' || artifact_json WHERE id = 'artifact1'").run();
    }],
    ["receipt noncanonical JSON", "review_command_receipts", "trg_review_command_receipts_immutable", (db: DatabaseSync) => {
      db.prepare("UPDATE review_command_receipts SET receipt_json = ' ' || receipt_json WHERE id = 'receipt1'").run();
    }],
    ["semantics fingerprint", "review_rubric_semantics", "trg_review_rubric_semantics_immutable", (db: DatabaseSync) => {
      db.exec("DROP TRIGGER trg_review_blind_artifacts_no_delete");
      db.prepare("DELETE FROM review_blind_artifacts WHERE id = 'artifact1'").run();
      db.prepare("UPDATE review_rubric_semantics SET fingerprint = ? WHERE id = 'semantics1'").run("0".repeat(64));
    }],
    ["artifact fingerprint", "review_blind_artifacts", "trg_review_blind_artifacts_immutable", (db: DatabaseSync) => {
      db.prepare("UPDATE review_blind_artifacts SET fingerprint = ? WHERE id = 'artifact1'").run("0".repeat(64));
    }],
    ["receipt fingerprint", "review_command_receipts", "trg_review_command_receipts_immutable", (db: DatabaseSync) => {
      db.prepare("UPDATE review_command_receipts SET receipt_fingerprint = ? WHERE id = 'receipt1'").run("0".repeat(64));
    }],
  ] as const)("rejects trusted-review %s on reopen without mutation", (name, _table, trigger, mutate) => {
    const path = pathFor(`trusted-review-document-${name.replaceAll(" ", "-")}`);
    try {
      const db = openDb({ path });
      try {
        trustedReviewIntegrityFixture(db);
      } finally {
        closeDb(db);
      }
      const raw = new DatabaseSync(path);
      try {
        raw.exec(`DROP TRIGGER "${trigger}"`);
        mutate(raw);
        raw.exec(DDL);
      } finally {
        raw.close();
      }
      const beforeOpen = { file: fileSnapshot(path), ...fileDatabaseSnapshot(path) };
      expect(() => openDb({ path, seed: false })).toThrow(/trusted review document integrity check failed/);
      expect({ file: fileSnapshot(path), ...fileDatabaseSnapshot(path) }).toEqual(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["cross-tenant artifact", "trg_review_blind_artifacts_immutable", (
      db: DatabaseSync,
      _data: ReturnType<typeof trustedReviewIntegrityFixture>,
    ) => {
      const other = db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string };
      db.prepare("UPDATE review_blind_artifacts SET workspace_id = ? WHERE id = 'artifact1'").run(other.id);
    }],
    ["unauthorized issuer snapshot", "trg_review_rubric_semantics_immutable", (
      db: DatabaseSync,
      data: ReturnType<typeof trustedReviewIntegrityFixture>,
    ) => {
      const document = {
        ...data.semanticsDocument,
        issuer: { ...data.semanticsDocument.issuer, role: "reviewer" },
      };
      db.prepare(
        `UPDATE review_rubric_semantics
         SET issuer_role = 'reviewer', semantics_json = ?, fingerprint = ?
         WHERE id = 'semantics1'`,
      ).run(canonicalJson(document), fingerprintOf(document));
    }],
    ["artifact header mismatch", "trg_review_blind_artifacts_immutable", (
      db: DatabaseSync,
      data: ReturnType<typeof trustedReviewIntegrityFixture>,
    ) => {
      const document = { ...data.artifactDocument, assignmentId: "missing-assignment" };
      db.prepare("UPDATE review_blind_artifacts SET artifact_json = ?, fingerprint = ? WHERE id = 'artifact1'").run(
        canonicalJson(document),
        fingerprintOf(document),
      );
    }],
    ["receipt effect mismatch", "trg_review_command_receipts_immutable", (
      db: DatabaseSync,
      data: ReturnType<typeof trustedReviewIntegrityFixture>,
    ) => {
      const document = { ...data.receiptDocument, effectId: "missing-effect" };
      db.prepare(
        `UPDATE review_command_receipts
         SET effect_id = 'missing-effect', receipt_json = ?, receipt_fingerprint = ?
         WHERE id = 'receipt1'`,
      ).run(canonicalJson(document), fingerprintOf(document));
    }],
  ] as const)("rejects trusted-review %s binding corruption on reopen", (name, trigger, mutate) => {
    const path = pathFor(`trusted-review-binding-${name.replaceAll(" ", "-")}`);
    try {
      const db = openDb({ path });
      let data: ReturnType<typeof trustedReviewIntegrityFixture>;
      try {
        data = trustedReviewIntegrityFixture(db);
      } finally {
        closeDb(db);
      }
      const raw = new DatabaseSync(path);
      try {
        raw.exec(`DROP TRIGGER "${trigger}"`);
        mutate(raw, data);
        raw.exec(DDL);
      } finally {
        raw.close();
      }
      const beforeOpen = { file: fileSnapshot(path), ...fileDatabaseSnapshot(path) };
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect({ file: fileSnapshot(path), ...fileDatabaseSnapshot(path) }).toEqual(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("rejects a nullable V5 required column in the V21 physical manifest before reading rows", () => {
    const path = pathFor("trusted-review-nullable-column");
    try {
      closeDb(openDb({ path, seed: false }));
      const raw = new DatabaseSync(path);
      try {
        makeRequiredTextColumnNullable(raw, "review_command_receipts", "created_at");
      } finally {
        raw.close();
      }
      const beforeOpen = { file: fileSnapshot(path), ...fileDatabaseSnapshot(path) };
      expect(() => openDb({ path, seed: false })).toThrow(/^malformed schema v21$/);
      expect({ file: fileSnapshot(path), ...fileDatabaseSnapshot(path) }).toEqual(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["CFP policy raw bound", (db: DatabaseSync, ids: ReturnType<typeof cfpFixture>) => {
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET policy_json = ? WHERE id = ?").run("x".repeat(512 * 1024 + 1), ids.callId);
      db.exec(DDL);
    }, /stored call policy JSON exceeds its raw bound/],
    ["CFP revision raw bound", (db: DatabaseSync, ids: ReturnType<typeof cfpFixture>) => {
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      const rawRevisionJson = "x".repeat(4 * 1024 * 1024 + 1);
      db.prepare("UPDATE submission_revisions SET revision_json = ? WHERE id = ?").run(rawRevisionJson, ids.revisionId);
      db.exec(DDL);
    }, /stored submission revision JSON exceeds its raw bound/],
    ["CFP policy non-text", (db: DatabaseSync, ids: ReturnType<typeof cfpFixture>) => {
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET policy_json = CAST(? AS BLOB) WHERE id = ?").run("not-text-policy", ids.callId);
      db.exec(DDL);
    }, /stored call policy JSON exceeds its raw bound/],
    ["CFP revision non-text", (db: DatabaseSync, ids: ReturnType<typeof cfpFixture>) => {
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = CAST(? AS BLOB) WHERE id = ?").run("not-text-revision", ids.revisionId);
      db.exec(DDL);
    }, /stored submission revision JSON exceeds its raw bound/],
    ["CFP foreign-key", (db: DatabaseSync, ids: ReturnType<typeof cfpFixture>) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET form_version_id = 'missing-form' WHERE id = ?").run(ids.callId);
      db.exec(DDL);
    }, /foreign-key check failed/],
    ["CFP tenant", (db: DatabaseSync, ids: ReturnType<typeof cfpFixture>) => {
      const acme = db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string };
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET workspace_id = ? WHERE id = ?").run(acme.id, ids.callId);
      db.exec(DDL);
    }, /tenant integrity check failed/],
    ["CFP missing session consumption", (db: DatabaseSync) => {
      db.exec("DROP TRIGGER trg_cfp_email_verification_consumptions_no_delete");
      db.prepare("DELETE FROM cfp_email_verification_consumptions WHERE verification_id = 'migration-cfp-verification'").run();
      db.exec(DDL);
    }, /tenant integrity check failed/],
    ["CFP null-pointer orphan", (db: DatabaseSync, ids: ReturnType<typeof cfpFixture>) => {
      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.prepare("UPDATE submissions SET current_revision_id = NULL WHERE id = ?").run(ids.submissionId);
      db.exec(DDL);
    }, /tenant integrity check failed/],
    ["CFP receipt mirror", (db: DatabaseSync, ids: ReturnType<typeof cfpFixture>) => {
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET consent_receipt_policy_fingerprint = ? WHERE id = ?").run("0".repeat(64), ids.revisionId);
      db.exec(DDL);
    }, /tenant integrity check failed/],
  ] as const)("rejects %s on V7 reopen without mutation", (name, mutate, expected) => {
    const path = pathFor(`v7-cfp-corruption-${name.replaceAll(" ", "-").toLowerCase()}`);
    try {
      const db = openDb({ path });
      const ids = cfpFixture(db);
      closeDb(db);
      const raw = new DatabaseSync(path);
      try {
        mutate(raw, ids);
      } finally {
        raw.close();
      }
      const beforeOpen = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(expected);
      expect(fileSnapshot(path)).toBe(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("rejects assignment supersession cycles of any length and unrecused/unrevoked superseded predecessors on reopen", () => {
    const cycle1Path = pathFor("cycle-1");
    const cycle2Path = pathFor("cycle-2");
    const cycle3Path = pathFor("cycle-3");
    const unrevokedPath = pathFor("unrevoked-predecessor");

    try {
      // 1-node cycle (A -> A)
      const db1 = openDb({ path: cycle1Path });
      const ids = cfpFixture(db1);
      db1.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.callId, ids.organizerAccountId);
      db1.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "1".repeat(64), ids.organizerAccountId);
      insertCorruptAssignmentLineage(db1, () => {
        db1.prepare(
          `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, supersedes_assignment_id, created_at)
           VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, 'a1', '2026-08-10T00:00:00.000Z')`,
        ).run(ids.workspaceId, ids.submissionId, ids.revisionId, ids.organizerAccountId, ids.organizerAccountId);
      });
      appendRevokedAssignmentState(db1, ids.workspaceId, "a1", ids.organizerAccountId);
      closeDb(db1);

      expect(() => openDb({ path: cycle1Path, seed: false })).toThrow(/tenant integrity check failed/);

      // 2-node cycle (A -> B -> A)
      const db2 = openDb({ path: cycle2Path });
      const ids2 = cfpFixture(db2);
      db2.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids2.workspaceId, ids2.callId, ids2.organizerAccountId);
      db2.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids2.workspaceId, "1".repeat(64), ids2.organizerAccountId);
      db2.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
         VALUES ('cycle2-reviewer', ?, 'cycle2-reviewer@synthetic.example', 'Cycle reviewer', 'reviewer', '2026-08-10T00:00:00.000Z')`,
      ).run(ids2.workspaceId);
      insertCorruptAssignmentLineage(db2, () => {
        db2.prepare(
          `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, supersedes_assignment_id, created_at)
           VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, 'a2', '2026-08-10T00:00:00.000Z')`,
        ).run(ids2.workspaceId, ids2.submissionId, ids2.revisionId, ids2.organizerAccountId, ids2.organizerAccountId);
        db2.prepare(
          `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, supersedes_assignment_id, created_at)
           VALUES ('a2', ?, 'r1', 'rub1', ?, ?, ?, ?, 'a1', '2026-08-10T00:00:00.000Z')`,
        ).run(ids2.workspaceId, ids2.submissionId, ids2.revisionId, "cycle2-reviewer", ids2.organizerAccountId);
      });
      appendRevokedAssignmentState(db2, ids2.workspaceId, "a1", ids2.organizerAccountId);
      appendRevokedAssignmentState(db2, ids2.workspaceId, "a2", ids2.organizerAccountId);
      closeDb(db2);

      expect(() => openDb({ path: cycle2Path, seed: false })).toThrow(/tenant integrity check failed/);

      // 3-node cycle proves the reopen walk is not limited to direct/self predecessors.
      const db3 = openDb({ path: cycle3Path });
      const ids3 = cfpFixture(db3);
      db3.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids3.workspaceId, ids3.callId, ids3.organizerAccountId);
      db3.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids3.workspaceId, "1".repeat(64), ids3.organizerAccountId);
      for (const [id, email] of [["cycle3-reviewer-2", "cycle3-2@synthetic.example"], ["cycle3-reviewer-3", "cycle3-3@synthetic.example"]] as const) {
        db3.prepare(
          `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
           VALUES (?, ?, ?, 'Cycle reviewer', 'reviewer', '2026-08-10T00:00:00.000Z')`,
        ).run(id, ids3.workspaceId, email);
      }
      insertCorruptAssignmentLineage(db3, () => {
        for (const [id, predecessor, reviewer] of [
          ["a1", "a2", ids3.organizerAccountId],
          ["a2", "a3", "cycle3-reviewer-2"],
          ["a3", "a1", "cycle3-reviewer-3"],
        ] as const) {
          db3.prepare(
            `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, supersedes_assignment_id, created_at)
             VALUES (?, ?, 'r1', 'rub1', ?, ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
          ).run(id, ids3.workspaceId, ids3.submissionId, ids3.revisionId, reviewer, ids3.organizerAccountId, predecessor);
        }
      });
      for (const assignmentId of ["a1", "a2", "a3"]) {
        appendRevokedAssignmentState(db3, ids3.workspaceId, assignmentId, ids3.organizerAccountId);
      }
      closeDb(db3);

      expect(() => openDb({ path: cycle3Path, seed: false })).toThrow(/tenant integrity check failed/);
      const repairedCycle = new DatabaseSync(cycle3Path);
      try {
        repairedCycle.exec("DROP TRIGGER trg_review_assignments_immutable");
        repairedCycle.prepare("UPDATE review_assignments SET supersedes_assignment_id = NULL WHERE id = 'a1'").run();
        repairedCycle.exec(DDL);
      } finally {
        repairedCycle.close();
      }
      closeDb(openDb({ path: cycle3Path, seed: false }));

      // Predecessor not RECUSED or REVOKED (e.g. latest state is ASSIGNED)
      const dbUnrev = openDb({ path: unrevokedPath });
      const idsUnrev = cfpFixture(dbUnrev);
      dbUnrev.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(idsUnrev.workspaceId, idsUnrev.callId, idsUnrev.organizerAccountId);
      dbUnrev.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(idsUnrev.workspaceId, "1".repeat(64), idsUnrev.organizerAccountId);
      dbUnrev.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(idsUnrev.workspaceId, idsUnrev.submissionId, idsUnrev.revisionId, idsUnrev.organizerAccountId, idsUnrev.organizerAccountId);
      dbUnrev.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
         VALUES ('unrevoked-reviewer', ?, 'unrevoked-reviewer@synthetic.example', 'Replacement reviewer', 'reviewer', '2026-08-10T00:00:00.000Z')`,
      ).run(idsUnrev.workspaceId);
      insertCorruptAssignmentLineage(dbUnrev, () => {
        dbUnrev.prepare(
          `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, supersedes_assignment_id, created_at)
           VALUES ('a2', ?, 'r1', 'rub1', ?, ?, ?, ?, 'a1', '2026-08-10T00:00:00.000Z')`,
        ).run(idsUnrev.workspaceId, idsUnrev.submissionId, idsUnrev.revisionId, "unrevoked-reviewer", idsUnrev.organizerAccountId);
      });
      closeDb(dbUnrev);

      expect(() => openDb({ path: unrevokedPath, seed: false })).toThrow(/tenant integrity check failed/);
    } finally {
      removeSqliteFiles(cycle1Path);
      removeSqliteFiles(cycle2Path);
      removeSqliteFiles(cycle3Path);
      removeSqliteFiles(unrevokedPath);
    }
  });

  it.each([
    ["round sequence zero", "trg_review_round_states_immutable", "UPDATE review_round_states SET sequence_number = 0 WHERE round_id = 'r1'"],
    ["rubric version zero", "trg_rubric_versions_immutable", "UPDATE rubric_versions SET version_number = 0 WHERE id = 'rub1'"],
    ["assignment sequence zero", "trg_review_assignment_states_immutable", "UPDATE review_assignment_states SET sequence_number = 0 WHERE assignment_id = 'a1'"],
    ["conflict sequence zero", "trg_review_conflict_dispositions_immutable", "UPDATE review_conflict_dispositions SET sequence_number = 0 WHERE assignment_id = 'a1'"],
    ["review revision zero", "trg_review_revisions_immutable", "UPDATE review_revisions SET revision_number = 0 WHERE assignment_id = 'a1'"],
    ["conflict evidence empty", "trg_review_conflict_dispositions_immutable", "UPDATE review_conflict_dispositions SET actor_role_basis = '' WHERE assignment_id = 'a1'"],
    ["rubric seal empty", "trg_rubric_versions_immutable", "UPDATE rubric_versions SET sealed_at = '' WHERE id = 'rub1'"],
    ["assignment initial state invalid", "trg_review_assignment_states_immutable", "UPDATE review_assignment_states SET state = 'SUBMITTED' WHERE assignment_id = 'a1'"],
    ["review tuple mismatch", "trg_review_revisions_immutable", "UPDATE review_revisions SET rubric_version_id = 'rub2' WHERE assignment_id = 'a1'"],
  ] as const)("rejects isolated review corruption on reopen: %s", (label, immutableTrigger, mutation) => {
    const path = pathFor(`review-isolated-${label.replaceAll(" ", "-")}`);
    try {
      const db = openDb({ path });
      reviewIntegrityFixture(db);
      closeDb(db);

      const raw = new DatabaseSync(path);
      try {
        raw.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
        raw.exec(`DROP TRIGGER "${immutableTrigger}"`);
        raw.exec(mutation);
        raw.exec(DDL);
      } finally {
        raw.close();
      }
      const beforeOpen = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(fileSnapshot(path)).toBe(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    [
      "initial round state NULL",
      "review_round_states",
      "state",
      "trg_review_round_states_immutable",
      false,
      "UPDATE review_round_states SET state = NULL WHERE id = 'review-round-state-initial:r1'",
    ],
    [
      "ordered round state NULL",
      "review_round_states",
      "state",
      "trg_review_round_states_immutable",
      true,
      "UPDATE review_round_states SET state = NULL WHERE id = 'round-state-2'",
    ],
    [
      "initial assignment state NULL",
      "review_assignment_states",
      "state",
      "trg_review_assignment_states_immutable",
      false,
      "UPDATE review_assignment_states SET state = NULL WHERE id = 'review-assignment-state-initial:a1'",
    ],
    [
      "ordered assignment state NULL",
      "review_assignment_states",
      "state",
      "trg_review_assignment_states_immutable",
      true,
      "UPDATE review_assignment_states SET state = NULL WHERE id = 'assignment-state-2'",
    ],
    [
      "initial conflict action NULL",
      "review_conflict_dispositions",
      "action",
      "trg_review_conflict_dispositions_immutable",
      false,
      "UPDATE review_conflict_dispositions SET action = NULL WHERE id = 'conflict1'",
    ],
    [
      "ordered conflict action NULL",
      "review_conflict_dispositions",
      "action",
      "trg_review_conflict_dispositions_immutable",
      true,
      "UPDATE review_conflict_dispositions SET action = NULL WHERE id = 'conflict2'",
    ],
    [
      "assignment rubric binding NULL",
      "review_assignments",
      "rubric_version_id",
      "trg_review_assignments_immutable",
      false,
      "UPDATE review_assignments SET rubric_version_id = NULL WHERE id = 'a1'",
    ],
    [
      "review revision rubric binding NULL",
      "review_revisions",
      "rubric_version_id",
      "trg_review_revisions_immutable",
      false,
      "UPDATE review_revisions SET rubric_version_id = NULL WHERE id = 'review1'",
    ],
  ] as const)("rejects manifest-restored required-column corruption on reopen: %s", (
    label,
    tableName,
    columnName,
    immutableTrigger,
    includeOrderedHistories,
    mutation,
  ) => {
    const path = pathFor(`review-null-${label.replaceAll(" ", "-").toLowerCase()}`);
    let tableSql = "";
    try {
      const db = openDb({ path });
      reviewIntegrityFixture(db, includeOrderedHistories);
      closeDb(db);

      const schemaEditor = new DatabaseSync(path);
      try {
        tableSql = makeRequiredTextColumnNullable(schemaEditor, tableName, columnName);
      } finally {
        schemaEditor.close();
      }

      const raw = new DatabaseSync(path);
      try {
        raw.exec(`DROP TRIGGER "${immutableTrigger}"`);
        raw.exec(mutation);
        expect(raw.prepare(
          `SELECT COUNT(*) AS count FROM "${tableName}" WHERE "${columnName}" IS NULL`,
        ).get()).toEqual({ count: 1 });
        raw.exec(DDL);
        replaceTableSchemaSql(raw, tableName, tableSql);
      } finally {
        raw.close();
      }

      const restored = new DatabaseSync(path);
      try {
        expect(physicalManifestDigest(restored)).toBe(EXPECTED_V21_MANIFEST_SHA256);
        expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        restored.close();
      }

      const beforeOpen = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(fileSnapshot(path)).toBe(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["rubric", ...EMBEDDED_NUL_FINGERPRINTS[0]],
    ["rubric", ...EMBEDDED_NUL_FINGERPRINTS[1]],
    ["rubric", ...EMBEDDED_NUL_FINGERPRINTS[2]],
    ["review", ...EMBEDDED_NUL_FINGERPRINTS[0]],
    ["review", ...EMBEDDED_NUL_FINGERPRINTS[1]],
    ["review", ...EMBEDDED_NUL_FINGERPRINTS[2]],
  ] as const)("rejects an embedded-NUL %s fingerprint at the %s on reopen", (recordType, position, fingerprint) => {
    const path = pathFor(`review-${recordType}-fingerprint-nul-${position}`);
    const target = recordType === "rubric"
      ? {
          table: "rubric_versions",
          trigger: "trg_rubric_versions_immutable",
          id: "rub1",
        }
      : {
          table: "review_revisions",
          trigger: "trg_review_revisions_immutable",
          id: "review1",
        };
    try {
      const db = openDb({ path });
      reviewIntegrityFixture(db);
      closeDb(db);

      const raw = new DatabaseSync(path);
      try {
        raw.exec("PRAGMA ignore_check_constraints = ON");
        raw.exec(`DROP TRIGGER "${target.trigger}"`);
        raw.prepare(`UPDATE "${target.table}" SET fingerprint = ? WHERE id = ?`).run(fingerprint, target.id);
        expect(raw.prepare(
          `SELECT typeof(fingerprint) AS storage,
                  length(fingerprint) AS characterLength,
                  length(CAST(fingerprint AS BLOB)) AS byteLength,
                  fingerprint GLOB '*[^0-9a-f]*' AS globInvalid
           FROM "${target.table}" WHERE id = ?`,
        ).get(target.id)).toEqual({
          storage: "text",
          characterLength: fingerprint.indexOf("\u0000"),
          byteLength: 64,
          globInvalid: 0,
        });
        raw.exec(DDL);
      } finally {
        raw.close();
      }

      const beforeOpen = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(fileSnapshot(path)).toBe(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("rejects isolated review corruption on reopen: rubric seal non-TEXT", () => {
    const path = pathFor("review-isolated-rubric-seal-non-text");
    let strictTableSql = "";
    try {
      const db = openDb({ path });
      reviewIntegrityFixture(db);
      closeDb(db);

      const schemaEditor = new DatabaseSync(path);
      try {
        const row = schemaEditor.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rubric_versions'",
        ).get() as { sql: string } | undefined;
        if (!row?.sql.endsWith(" STRICT")) {
          throw new Error("rubric_versions STRICT fixture is missing");
        }
        strictTableSql = row.sql;
        replaceTableSchemaSql(
          schemaEditor,
          "rubric_versions",
          strictTableSql.slice(0, -" STRICT".length),
        );
      } finally {
        schemaEditor.close();
      }

      const raw = new DatabaseSync(path);
      try {
        raw.exec("PRAGMA ignore_check_constraints = ON");
        raw.exec("DROP TRIGGER trg_rubric_versions_immutable");
        raw.prepare("UPDATE rubric_versions SET sealed_at = ? WHERE id = 'rub1'").run(
          new Uint8Array([1]),
        );
        expect(raw.prepare(
          "SELECT typeof(sealed_at) AS storage FROM rubric_versions WHERE id = 'rub1'",
        ).get()).toEqual({ storage: "blob" });
        raw.exec(DDL);
        replaceTableSchemaSql(raw, "rubric_versions", strictTableSql);
      } finally {
        raw.close();
      }

      const beforeOpen = fileSnapshot(path);
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(fileSnapshot(path)).toBe(beforeOpen);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("creates mandatory initial round and assignment states in the parent insert transaction", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const ids = cfpFixture(db);
      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.callId, ids.organizerAccountId);
      expect(db.prepare(
        `SELECT state, sequence_number, actor_account_id, created_at
         FROM review_round_states WHERE round_id = 'r1'`,
      ).get()).toEqual({
        state: "DRAFT",
        sequence_number: 1,
        actor_account_id: ids.organizerAccountId,
        created_at: "2026-08-10T00:00:00.000Z",
      });

      db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "1".repeat(64), ids.organizerAccountId);
      db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, ids.organizerAccountId, ids.organizerAccountId);
      expect(db.prepare(
        `SELECT state, sequence_number, actor_account_id, created_at
         FROM review_assignment_states WHERE assignment_id = 'a1'`,
      ).get()).toEqual({
        state: "ASSIGNED",
        sequence_number: 1,
        actor_account_id: ids.organizerAccountId,
        created_at: "2026-08-10T00:00:00.000Z",
      });

      db.exec(`CREATE TRIGGER test_reject_initial_round_state
        BEFORE INSERT ON review_round_states WHEN NEW.round_id = 'r-fail'
        BEGIN SELECT RAISE(ABORT, 'test initial round failure'); END`);
      expect(() => db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r-fail', ?, 'migration-cfp-event', ?, 'Round fail', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.callId, ids.organizerAccountId)).toThrow(/test initial round failure/);
      expect(db.prepare("SELECT 1 FROM review_rounds WHERE id = 'r-fail'").get()).toBeUndefined();

      db.exec(`CREATE TRIGGER test_reject_initial_assignment_state
        BEFORE INSERT ON review_assignment_states WHEN NEW.assignment_id = 'a-fail'
        BEGIN SELECT RAISE(ABORT, 'test initial assignment failure'); END`);
      db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
         VALUES ('reviewer-fail', ?, 'reviewer-fail@synthetic.example', 'Reviewer fail', 'reviewer', '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId);
      expect(() => db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a-fail', ?, 'r1', 'rub1', ?, ?, 'reviewer-fail', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, ids.organizerAccountId)).toThrow(/test initial assignment failure/);
      expect(db.prepare("SELECT 1 FROM review_assignments WHERE id = 'a-fail'").get()).toBeUndefined();
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["IGNORE", "ignore"],
    ["FAIL", "fail"],
  ] as const)("fully rolls back round and assignment parents under outer INSERT OR %s", (conflictMode, suffix) => {
    const db = openDb({ path: ":memory:" });
    try {
      const ids = cfpFixture(db);
      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.callId, ids.organizerAccountId);

      const futureRoundId = `r-${suffix}`;
      db.prepare(
        `INSERT INTO review_round_states
           (id, workspace_id, round_id, state, sequence_number, actor_account_id, reason, created_at)
         VALUES (?, ?, 'r1', 'OPEN', 2, ?, 'collision fixture', '2026-08-10T00:00:00.000Z')`,
      ).run(
        `review-round-state-initial:${futureRoundId}`,
        ids.workspaceId,
        ids.organizerAccountId,
      );
      const roundsBefore = db.prepare("SELECT * FROM review_rounds ORDER BY id").all();
      const roundStatesBefore = db.prepare("SELECT * FROM review_round_states ORDER BY id").all();

      expect(() => db.prepare(
        `INSERT OR ${conflictMode} INTO review_rounds
           (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES (?, ?, 'migration-cfp-event', ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(
        futureRoundId,
        ids.workspaceId,
        ids.callId,
        `Round ${suffix}`,
        ids.organizerAccountId,
      )).toThrow(/review_rounds initial state collision/);
      expect(db.prepare("SELECT * FROM review_rounds ORDER BY id").all()).toEqual(roundsBefore);
      expect(db.prepare("SELECT * FROM review_round_states ORDER BY id").all()).toEqual(roundStatesBefore);

      db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "1".repeat(64), ids.organizerAccountId);
      db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, ids.organizerAccountId, ids.organizerAccountId);
      const futureAssignmentId = `a-${suffix}`;
      const futureReviewerId = `reviewer-${suffix}`;
      db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, 'Collision reviewer', 'reviewer', '2026-08-10T00:00:00.000Z')`,
      ).run(futureReviewerId, ids.workspaceId, `${futureReviewerId}@synthetic.example`);
      db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number, actor_account_id, reason, created_at)
         VALUES (?, ?, 'a1', 'IN_PROGRESS', 2, ?, 'collision fixture', '2026-08-10T00:00:00.000Z')`,
      ).run(
        `review-assignment-state-initial:${futureAssignmentId}`,
        ids.workspaceId,
        ids.organizerAccountId,
      );
      const assignmentsBefore = db.prepare("SELECT * FROM review_assignments ORDER BY id").all();
      const assignmentStatesBefore = db.prepare("SELECT * FROM review_assignment_states ORDER BY id").all();

      expect(() => db.prepare(
        `INSERT OR ${conflictMode} INTO review_assignments
           (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id,
            reviewer_account_id, assigned_by, created_at)
         VALUES (?, ?, 'r1', 'rub1', ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(
        futureAssignmentId,
        ids.workspaceId,
        ids.submissionId,
        ids.revisionId,
        futureReviewerId,
        ids.organizerAccountId,
      )).toThrow(/review_assignments initial state collision/);
      expect(db.prepare("SELECT * FROM review_assignments ORDER BY id").all()).toEqual(assignmentsBefore);
      expect(db.prepare("SELECT * FROM review_assignment_states ORDER BY id").all()).toEqual(assignmentStatesBefore);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  it("enforces conflict history state machine (sequence 1 DECLARE, DECLARE->CLEAR|WAIVE, CLEAR->DECLARE, WAIVE terminal)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const ids = cfpFixture(db);
      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.callId, ids.organizerAccountId);

      expect(() => db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub-real', ?, 'r1', 1.5, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "0".repeat(64), ids.organizerAccountId)).toThrow();
      expect(() => db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub-fingerprint-blob', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', CAST(? AS BLOB), ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "0".repeat(64), ids.organizerAccountId)).toThrow();
      db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "1".repeat(64), ids.organizerAccountId);
      db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, ids.organizerAccountId, ids.organizerAccountId);

      expect(() => db.prepare(
        `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
         VALUES ('basis-blob', ?, 'a1', 'DECLARE', 1, ?, CAST('organizer' AS BLOB), 'reason', '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.organizerAccountId)).toThrow();
      expect(() => db.prepare(
        `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
         VALUES ('reason-blob', ?, 'a1', 'DECLARE', 1, ?, 'organizer', CAST('reason' AS BLOB), '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.organizerAccountId)).toThrow();

      // Sequence 1 must be DECLARE
      expect(() =>
        db.prepare(
          `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
           VALUES ('cd-bad1', ?, 'a1', 'CLEAR', 1, ?, 'organizer', 'test', '2026-08-10T00:00:00.000Z')`,
        ).run(ids.workspaceId, ids.organizerAccountId),
      ).toThrow(/review_conflict_dispositions/);

      // Valid seq 1 DECLARE
      db.prepare(
        `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
         VALUES ('cd1', ?, 'a1', 'DECLARE', 1, ?, 'organizer', 'test', '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.organizerAccountId);

      // Valid seq 2 CLEAR (from DECLARE)
      db.prepare(
        `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
         VALUES ('cd2', ?, 'a1', 'CLEAR', 2, ?, 'organizer', 'test', '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.organizerAccountId);

      // Valid seq 3 DECLARE (from CLEAR)
      db.prepare(
        `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
         VALUES ('cd3', ?, 'a1', 'DECLARE', 3, ?, 'organizer', 'test', '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.organizerAccountId);

      // Valid seq 4 WAIVE (from DECLARE)
      db.prepare(
        `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
         VALUES ('cd4', ?, 'a1', 'WAIVE', 4, ?, 'organizer', 'test', '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.organizerAccountId);

      // WAIVE is terminal: seq 5 DECLARE from WAIVE fails
      expect(() =>
        db.prepare(
          `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
           VALUES ('cd5-bad', ?, 'a1', 'DECLARE', 5, ?, 'organizer', 'test', '2026-08-10T00:00:00.000Z')`,
        ).run(ids.workspaceId, ids.organizerAccountId),
      ).toThrow(/review_conflict_dispositions/);
    } finally {
      closeDb(db);
    }
  });

  it("enforces lowercase 64-hex fingerprints, including embedded-NUL boundaries, at insert time", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const ids = cfpFixture(db);
      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.callId, ids.organizerAccountId);

      const invalidFingerprints = [
        ["uppercase", "A".repeat(64)],
        ["non-hex", "g".repeat(64)],
        ...EMBEDDED_NUL_FINGERPRINTS,
      ] as const;
      for (const [label, fingerprint] of invalidFingerprints) {
        expect(Buffer.byteLength(fingerprint, "utf8")).toBe(64);
        expect(() => db.prepare(
          `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
           VALUES (?, ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
        ).run(`rub-${label}`, ids.workspaceId, fingerprint, ids.organizerAccountId)).toThrow();
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM rubric_versions").get()).toEqual({ count: 0 });

      db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "1".repeat(64), ids.organizerAccountId);
      db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, ids.organizerAccountId, ids.organizerAccountId);

      for (const [label, fingerprint] of invalidFingerprints) {
        expect(() => db.prepare(
          `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
           VALUES (?, ?, 'a1', 'r1', 'rub1', ?, ?, 1, 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', ?, '2026-08-10T00:00:00.000Z')`,
        ).run(
          `review-${label}`,
          ids.workspaceId,
          ids.submissionId,
          ids.revisionId,
          fingerprint,
        )).toThrow();
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_revisions").get()).toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("bounds rubric/evaluation JSON and conflict authority evidence at insert time", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const ids = cfpFixture(db);
      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.callId, ids.organizerAccountId);

      expect(() => db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub-blob', ?, 'r1', 1, 'cfp-rubric/v1', CAST('{}' AS BLOB), 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "1".repeat(64), ids.organizerAccountId)).toThrow();
      expect(() => db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub-large', ?, 'r1', 1, 'cfp-rubric/v1', ?, 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, JSON.stringify({ value: "x".repeat(4 * 1024 * 1024) }), "2".repeat(64), ids.organizerAccountId)).toThrow();

      db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "3".repeat(64), ids.organizerAccountId);
      expect(() => db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub-fingerprint-twin', ?, 'r1', 2, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', CAST(? AS BLOB), ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "3".repeat(64), ids.organizerAccountId)).toThrow();
      db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, ids.organizerAccountId, ids.organizerAccountId);

      expect(() => db.prepare(
        `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
         VALUES ('basis-large', ?, 'a1', 'DECLARE', 1, ?, ?, 'reason', '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.organizerAccountId, "x".repeat(129))).toThrow();
      expect(() => db.prepare(
        `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
         VALUES ('reason-large', ?, 'a1', 'DECLARE', 1, ?, 'organizer', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.organizerAccountId, "x".repeat(4097))).toThrow();

      expect(() => db.prepare(
        `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
         VALUES ('eval-blob', ?, 'a1', 'r1', 'rub1', ?, ?, 1, 'cfp-review-evaluation/v1', CAST('{}' AS BLOB), 'sha256-canonical-json-v1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, "4".repeat(64))).toThrow();
      expect(() => db.prepare(
        `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
         VALUES ('eval-large', ?, 'a1', 'r1', 'rub1', ?, ?, 1, 'cfp-review-evaluation/v1', ?, 'sha256-canonical-json-v1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, JSON.stringify({ value: "x".repeat(4 * 1024 * 1024) }), "5".repeat(64))).toThrow();
      expect(() => db.prepare(
        `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
         VALUES ('eval-real', ?, 'a1', 'r1', 'rub1', ?, ?, 1.5, 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, "6".repeat(64))).toThrow();
      expect(() => db.prepare(
        `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
         VALUES ('eval-fingerprint-blob', ?, 'a1', 'r1', 'rub1', ?, ?, 1, 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', CAST(? AS BLOB), '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, "6".repeat(64))).toThrow();
      db.prepare(
        `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
         VALUES ('eval-valid', ?, 'a1', 'r1', 'rub1', ?, ?, 1, 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, "7".repeat(64));
      expect(() => db.prepare(
        `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
         VALUES ('eval-fingerprint-twin', ?, 'a1', 'r1', 'rub1', ?, ?, 2, 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', CAST(? AS BLOB), '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, "7".repeat(64))).toThrow();
    } finally {
      closeDb(db);
    }
  });

  it("enforces immutability on all seven review tables", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const ids = cfpFixture(db);
      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'migration-cfp-event', ?, 'Round 1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.callId, ids.organizerAccountId);
      db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, "1".repeat(64), ids.organizerAccountId);
      db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a1', ?, 'r1', 'rub1', ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, ids.organizerAccountId, ids.organizerAccountId);
      db.prepare(
        `INSERT INTO review_conflict_dispositions (id, workspace_id, assignment_id, action, sequence_number, actor_account_id, actor_role_basis, reason, created_at)
         VALUES ('cd1', ?, 'a1', 'DECLARE', 1, ?, 'organizer', 'test', '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.organizerAccountId);
      db.prepare(
        `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
         VALUES ('rr1', ?, 'a1', 'r1', 'rub1', ?, ?, 1, 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', ?, '2026-08-10T00:00:00.000Z')`,
      ).run(ids.workspaceId, ids.submissionId, ids.revisionId, "2".repeat(64));

      expect(() => db.prepare("UPDATE review_rounds SET name = 'x' WHERE id = 'r1'").run()).toThrow(/is immutable/);
      expect(() => db.prepare("DELETE FROM review_rounds WHERE id = 'r1'").run()).toThrow(/is retained for history/);

      expect(() => db.prepare("UPDATE review_round_states SET state = 'OPEN' WHERE id = 'review-round-state-initial:r1'").run()).toThrow(/is immutable/);
      expect(() => db.prepare("DELETE FROM review_round_states WHERE id = 'review-round-state-initial:r1'").run()).toThrow(/is retained for history/);

      expect(() => db.prepare("UPDATE rubric_versions SET rubric_schema = 'x' WHERE id = 'rub1'").run()).toThrow(/is immutable/);
      expect(() => db.prepare("DELETE FROM rubric_versions WHERE id = 'rub1'").run()).toThrow(/is immutable/);

      expect(() => db.prepare("UPDATE review_assignments SET assigned_by = 'x' WHERE id = 'a1'").run()).toThrow(/is immutable/);
      expect(() => db.prepare("DELETE FROM review_assignments WHERE id = 'a1'").run()).toThrow(/is retained for history/);

      expect(() => db.prepare("UPDATE review_assignment_states SET state = 'SUBMITTED' WHERE id = 'review-assignment-state-initial:a1'").run()).toThrow(/is immutable/);
      expect(() => db.prepare("DELETE FROM review_assignment_states WHERE id = 'review-assignment-state-initial:a1'").run()).toThrow(/is retained for history/);

      expect(() => db.prepare("UPDATE review_conflict_dispositions SET reason = 'x' WHERE id = 'cd1'").run()).toThrow(/is immutable/);
      expect(() => db.prepare("DELETE FROM review_conflict_dispositions WHERE id = 'cd1'").run()).toThrow(/is immutable/);

      expect(() => db.prepare("UPDATE review_revisions SET evaluation_json = 'x' WHERE id = 'rr1'").run()).toThrow(/is immutable/);
      expect(() => db.prepare("DELETE FROM review_revisions WHERE id = 'rr1'").run()).toThrow(/is immutable/);
    } finally {
      closeDb(db);
    }
  });
});
