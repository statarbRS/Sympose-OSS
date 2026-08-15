import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { DDL } from "../../src/server/schema";
import { createLegacyV7Database, V7_SCHEMA_MANIFEST_SHA256 } from "./fixtures/legacy-schema-v7";

const V8_SCHEMA_MANIFEST_SHA256 =
  "6ddc50b3112f83b7e24e7ef72045019ca125b48b2a8b1a627603e3788409dd32";
const V21_SCHEMA_MANIFEST_SHA256 = "4f82143569670933cf9080e38d312a827bc348a13b3a0dfb6ad233a0867f761b";

function manifestDigest(db: Db | DatabaseSync): string {
  const objects = db
    .prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name, tableName")
    .all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>;
  const manifest = objects.map((object) => ({
    ...object,
    columns: object.type === "table"
      ? (db.prepare(`PRAGMA table_info("${object.name.replaceAll('"', '""')}")`).all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>).map((column) => ({
          cid: column.cid, name: column.name, type: column.type, notnull: column.notnull,
          defaultValue: column.dflt_value, primaryKey: column.pk,
        }))
      : null,
    foreignKeys: object.type === "table"
      ? (db.prepare(`PRAGMA foreign_key_list("${object.name.replaceAll('"', '""')}")`).all() as Array<{ id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string; match: string }>).map((foreignKey) => ({
          id: foreignKey.id, sequence: foreignKey.seq, tableName: foreignKey.table, from: foreignKey.from,
          to: foreignKey.to, onUpdate: foreignKey.on_update, onDelete: foreignKey.on_delete, match: foreignKey.match,
        }))
      : null,
    indexColumns: object.type === "index"
      ? (db.prepare(`PRAGMA index_info("${object.name.replaceAll('"', '""')}")`).all() as Array<{ seqno: number; cid: number; name: string | null }>).map((column) => ({
          sequence: column.seqno, columnId: column.cid, columnName: column.name,
        }))
      : null,
  }));
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function ids(db: Db): { workspaceId: string; accountId: string; eventId: string } {
  const workspace = db.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as { id: string };
  const account = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1").get(workspace.id) as { id: string };
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, 'UTC', ?, ?, ?)")
    .run("pd01-event", workspace.id, "PD-01 event", "2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z", "2026-08-10T00:00:00.000Z");
  db.prepare("INSERT INTO people (id,workspace_id,canonical_email,full_name,created_at) VALUES ('pd01-person',?,?,?,?)").run(workspace.id, "pd01@example.test", "PD01", "2026-08-10T00:00:00.000Z");
  const binding = { schema:"pd01-account-person-binding/v1", workspaceId:workspace.id, accountId:account.id, personId:"pd01-person", boundByAccountId:account.id, bindingBasis:"fixture", createdAt:"2026-08-10T00:00:00.000Z" };
  db.prepare("INSERT INTO account_person_bindings (id,workspace_id,account_id,person_id,bound_by_account_id,binding_basis,created_at,fingerprint_algorithm,fingerprint) VALUES ('pd01-binding',?,?,?,?,?,?,?,?)").run(workspace.id,account.id,"pd01-person",account.id,"fixture",binding.createdAt,"sha256-canonical-json-v1",fingerprintOf(binding));
  const assignment = { schema:"pd01-event-reviewer-assignment/v1",workspaceId:workspace.id,eventId:"pd01-event",reviewerAccountId:account.id,reviewerPersonId:"pd01-person",accountPersonBindingId:"pd01-binding",assignedByAccountId:account.id,createdAt:binding.createdAt };
  db.prepare("INSERT INTO event_reviewer_assignments (id,workspace_id,event_id,reviewer_account_id,reviewer_person_id,account_person_binding_id,assigned_by_account_id,created_at,fingerprint_algorithm,fingerprint) VALUES ('pd01-assignment',?,?,?,?,?,?,?,?,?)").run(workspace.id,"pd01-event",account.id,"pd01-person","pd01-binding",account.id,binding.createdAt,"sha256-canonical-json-v1",fingerprintOf(assignment));
  db.prepare("INSERT INTO event_reviewer_assignment_states (id,workspace_id,event_id,event_reviewer_assignment_id,state,sequence_number,actor_account_id,created_at) VALUES ('pd01-state',?,?,?,?,1,?,?)").run(workspace.id,"pd01-event","pd01-assignment","ACTIVE",account.id,binding.createdAt);
  const docs:any[]=[ ["policy-1","ADVOCACY_POLICY",{schema:"pd01-advocacy-policy/v1",maximumEntries:3,eligibleRevisions:[]}], ["visibility-1","VISIBILITY",{schema:"pd01-visibility-snapshot/v1",visibleRevisions:[]}], ["blindness-1","BLINDNESS",{schema:"pd01-blindness-policy/v1",disclosureStage:"BLIND_REVIEW",organizerAdvocacyAggregationPermitted:false}], ["selection-1","SELECTION_CONTEXT",{schema:"pd01-selection-context/v1",decisionBoundary:"schema-context",resolvedRevisions:[]}] ];
  for (const [id,kind,document] of docs) db.prepare("INSERT INTO review_context_versions (id,workspace_id,event_id,context_kind,version_number,context_schema,context_json,fingerprint_algorithm,fingerprint,issued_by_account_id,issued_at) VALUES (?,?,?,?,1,?,?,?,?,?,?)").run(id,workspace.id,"pd01-event",kind,document.schema,canonicalJson(document),"sha256-canonical-json-v1",fingerprintOf(document),account.id,binding.createdAt);
  return { workspaceId: workspace.id, accountId: account.id, eventId: "pd01-event" };
}

function insertSealedBallot(db: Db, context: { workspaceId: string; accountId: string; eventId: string }, sealedAt: string, setId = "sealed-set"):
  { versionId: string; setId: string } {
  const policyFingerprint = fingerprintOf({ schema: "pd01-advocacy-policy/v1", maximumEntries: 3, eligibleRevisions: [] });
  const visibilityFingerprint = fingerprintOf({ schema: "pd01-visibility-snapshot/v1", visibleRevisions: [] });
  const blindnessFingerprint = fingerprintOf({ schema: "pd01-blindness-policy/v1", disclosureStage: "BLIND_REVIEW", organizerAdvocacyAggregationPermitted: false });
  const selectionFingerprint = fingerprintOf({ schema: "pd01-selection-context/v1", decisionBoundary: "schema-context", resolvedRevisions: [] });
  const versionId = `${setId}-v1`;
  db.prepare("INSERT INTO recommendation_sets (id, workspace_id, event_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, created_at) VALUES (?, ?, ?, ?, 'pd01-person', 'pd01-assignment', 'pd01-binding', ?)")
    .run(setId, context.workspaceId, context.eventId, context.accountId, "2026-08-10T00:00:00.000Z");
  db.prepare(`INSERT INTO recommendation_set_versions
    (id, workspace_id, event_id, recommendation_set_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, version_number,
     eligibility_snapshot_json, eligibility_fingerprint, maximum_entries, policy_version_id, policy_version_fingerprint, visibility_version_id, visibility_version_fingerprint, blindness_version_id, blindness_version_fingerprint, selection_context_version_id, selection_context_reference, selection_context_fingerprint, created_at)
    VALUES (?, ?, ?, ?, ?, 'pd01-person', 'pd01-assignment', 'pd01-binding', 1, '[]', ?, 3, 'policy-1', ?, 'visibility-1', ?, 'blindness-1', ?, 'selection-1', ?, ?, ?) `)
    .run(versionId, context.workspaceId, context.eventId, setId, context.accountId, fingerprintOf([]), policyFingerprint, visibilityFingerprint, blindnessFingerprint, "schema-context", selectionFingerprint, "2026-08-10T00:00:00.000Z");
  const contentFingerprint = fingerprintOf({
    schema: "pd01-recommendation-ballot/v1", workspaceId: context.workspaceId, eventId: context.eventId,
    recommendationSetId: setId, versionNumber: 1, reviewerAccountId: context.accountId, reviewerPersonId: "pd01-person",
    accountPersonBindingId: "pd01-binding", eventReviewerAssignmentId: "pd01-assignment", eligibilityFingerprint: fingerprintOf([]),
    policyVersionId: "policy-1", policyVersionFingerprint: policyFingerprint, visibilityVersionId: "visibility-1", visibilityVersionFingerprint: visibilityFingerprint,
    blindnessVersionId: "blindness-1", blindnessVersionFingerprint: blindnessFingerprint, selectionContextVersionId: "selection-1", selectionContextFingerprint: selectionFingerprint,
    selectionContextReference: "schema-context", policyContextSchema: "pd01-advocacy-policy/v1", visibilityContextSchema: "pd01-visibility-snapshot/v1",
    blindnessContextSchema: "pd01-blindness-policy/v1", selectionContextSchema: "pd01-selection-context/v1", maximumEntries: 3, entries: [],
  });
  db.prepare("UPDATE recommendation_set_versions SET submitted_at=?, sealed_at=?, content_fingerprint=? WHERE id=?")
    .run(sealedAt, sealedAt, contentFingerprint, versionId);
  return { versionId, setId };
}

function addPoolVersion(db: Db, input: { poolId: string; versionId: string; workspaceId: string; eventId: string; unitKind: string; capacity: number; version: number }): void {
  if (!db.prepare("SELECT 1 FROM program_capacity_pools WHERE id = ?").get(input.poolId)) {
    db.prepare("INSERT INTO program_capacity_pools (id, workspace_id, event_id, unit_kind, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.poolId, input.workspaceId, input.eventId, input.unitKind, input.poolId, "2026-08-10T00:00:00.000Z");
  }
  const fingerprint = fingerprintOf({
    schema: "pd01-capacity-pool-version/v1", workspaceId: input.workspaceId, eventId: input.eventId,
    poolId: input.poolId, versionNumber: input.version, unitKind: input.unitKind, capacity: input.capacity,
    scope: {}, eligibility: {}, reservedFor: {}, releasePolicy: {},
    effectiveFrom: "2026-08-10T00:00:00.000Z", effectiveTo: null, createdAt: "2026-08-10T00:00:00.000Z",
  });
  db.prepare(`INSERT INTO program_capacity_pool_versions
    (id, workspace_id, event_id, pool_id, version_number, unit_kind, capacity, scope_json,
     eligibility_json, reserved_for_json, release_policy_json, effective_from, fingerprint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '{}', '{}', '{}', ?, ?, ?)`)
    .run(input.versionId, input.workspaceId, input.eventId, input.poolId, input.version, input.unitKind,
      input.capacity, "2026-08-10T00:00:00.000Z", fingerprint, "2026-08-10T00:00:00.000Z");
}

function selectionContextFingerprint(workspaceId: string, eventId: string, setId: string, reviewerAccountId: string, reference: string): string {
  return fingerprintOf({
    schema: "pd01-selection-context/v1", workspaceId, eventId, recommendationSetId: setId,
    reviewerAccountId, reference,
  });
}

type TransferPayload = {
  workspaceId: string; eventId: string; sequenceNumber: number; sourcePoolId: string; sourcePoolVersionId: string;
  destinationPoolId: string; destinationPoolVersionId: string; unitKind: string; quantity: number;
  sourceBefore: number; sourceAfter: number; destinationBefore: number; destinationAfter: number;
  actorAccountId: string; reason: string; approvalReference: string; decidedAt: string; idempotencyKey: string;
};

function transferFingerprint(input: TransferPayload): string {
  return fingerprintOf({ schema: "pd01-capacity-transfer-decision/v1", ...input });
}

function rewriteTransferEvidence(raw: DatabaseSync, decisionId: string, input: TransferPayload): void {
  const fingerprint = transferFingerprint(input);
  raw.prepare(`UPDATE capacity_transfer_decisions SET
    sequence_number = ?, source_pool_id = ?, source_pool_version_id = ?, destination_pool_id = ?,
    destination_pool_version_id = ?, unit_kind = ?, quantity = ?, source_before = ?, source_after = ?,
    destination_before = ?, destination_after = ?, actor_account_id = ?, reason = ?,
    approval_reference = ?, decided_at = ?, idempotency_key = ?, fingerprint = ? WHERE id = ?`)
    .run(input.sequenceNumber, input.sourcePoolId, input.sourcePoolVersionId, input.destinationPoolId,
      input.destinationPoolVersionId, input.unitKind, input.quantity, input.sourceBefore, input.sourceAfter,
      input.destinationBefore, input.destinationAfter, input.actorAccountId, input.reason,
      input.approvalReference, input.decidedAt, input.idempotencyKey, fingerprint, decisionId);
  raw.prepare(`UPDATE capacity_transfer_receipts SET
    sequence_number = ?, source_pool_id = ?, source_pool_version_id = ?, destination_pool_id = ?,
    destination_pool_version_id = ?, unit_kind = ?, quantity = ?, source_before = ?, source_after = ?,
    destination_before = ?, destination_after = ?, recorded_at = ?, fingerprint = ? WHERE decision_id = ?`)
    .run(input.sequenceNumber, input.sourcePoolId, input.sourcePoolVersionId, input.destinationPoolId,
      input.destinationPoolVersionId, input.unitKind, input.quantity, input.sourceBefore, input.sourceAfter,
      input.destinationBefore, input.destinationAfter, input.decidedAt, fingerprint, decisionId);
}

describe("PD-01 foundation on the V19 schema", () => {
  it("converges fresh and literal V7 upgrade manifests, including reopen", () => {
    const fresh = openDb({ path: ":memory:", seed: false });
    expect(manifestDigest(fresh)).toBe(V21_SCHEMA_MANIFEST_SHA256);
    closeDb(fresh);

    mkdirSync(".tmp/unit", { recursive: true });
    const path = ".tmp/unit/pd01-v7-upgrade.db";
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    const legacy = createLegacyV7Database({ path });
    expect(manifestDigest(legacy)).toBe(V7_SCHEMA_MANIFEST_SHA256);
    legacy.close();
    const upgraded = openDb({ path, seed: false });
    expect(manifestDigest(upgraded)).toBe(V21_SCHEMA_MANIFEST_SHA256);
    closeDb(upgraded);
    const raw = new DatabaseSync(path);
    raw.exec("VACUUM");
    raw.close();
    const reopened = openDb({ path, seed: false });
    expect(manifestDigest(reopened)).toBe(V21_SCHEMA_MANIFEST_SHA256);
    closeDb(reopened);
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
  });

  it("keeps advocacy independent of evaluation and protects exact versions, tenants, and immutability", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const context = ids(db);
      const entryFks = db.prepare("PRAGMA foreign_key_list(recommendation_entries)").all() as Array<{ table: string }>;
      expect(entryFks.some((foreignKey) => foreignKey.table === "review_revisions")).toBe(false);
      db.prepare("INSERT INTO recommendation_sets (id, workspace_id, event_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, created_at) VALUES (?, ?, ?, ?, 'pd01-person', 'pd01-assignment', 'pd01-binding', ?)")
        .run("set-1", context.workspaceId, context.eventId, context.accountId, "2026-08-10T00:00:00.000Z");
      db.prepare(`INSERT INTO recommendation_set_versions
        (id, workspace_id, event_id, recommendation_set_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, version_number,
         eligibility_snapshot_json, eligibility_fingerprint, maximum_entries, policy_version_id, policy_version_fingerprint, visibility_version_id, visibility_version_fingerprint, blindness_version_id, blindness_version_fingerprint, selection_context_version_id, selection_context_reference, selection_context_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, 'pd01-person', 'pd01-assignment', 'pd01-binding', 1, '[]', ?, 3, 'policy-1', ?, 'visibility-1', ?, 'blindness-1', ?, 'selection-1', ?, ?, ?) `)
        .run("set-1-v1", context.workspaceId, context.eventId, "set-1", context.accountId,
          fingerprintOf([]), fingerprintOf({schema:"pd01-advocacy-policy/v1",maximumEntries:3,eligibleRevisions:[]}), fingerprintOf({schema:"pd01-visibility-snapshot/v1",visibleRevisions:[]}), fingerprintOf({schema:"pd01-blindness-policy/v1",disclosureStage:"BLIND_REVIEW",organizerAdvocacyAggregationPermitted:false}), "schema-context", fingerprintOf({schema:"pd01-selection-context/v1",decisionBoundary:"schema-context",resolvedRevisions:[]}), "2026-08-10T00:00:00.000Z");
      expect(() => db.prepare("UPDATE recommendation_set_versions SET maximum_entries = 4 WHERE id = 'set-1-v1'").run()).toThrow(/immutable/);
      expect(() => db.prepare(`INSERT INTO recommendation_set_versions
        (id, workspace_id, event_id, recommendation_set_id, reviewer_account_id, version_number,
         eligibility_snapshot_json, eligibility_fingerprint, maximum_entries, policy_version_id,
         visibility_version_id, blindness_version_id, selection_context_reference,
         selection_context_fingerprint, created_at)
        VALUES ('set-1-v3', ?, ?, 'set-1', ?, 3, '{}', ?, 3, 'policy-1', 'visibility-1', 'blindness-1', 'schema-context', ?, ?)`)
        .run(context.workspaceId, context.eventId, context.accountId, fingerprintOf({}),
          selectionContextFingerprint(context.workspaceId, context.eventId, "set-1", context.accountId, "schema-context"), "2026-08-10T00:00:00.000Z")).toThrow(/binding|sequence/);
    } finally {
      closeDb(db);
    }
  });

  it("rejects trigger-bypass advocacy policy upper-bound corruption at reopen", () => {
    const path = ".tmp/unit/pd01-v9-advocacy-upper-bound.db";
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    const db = openDb({ path });
    ids(db);
    closeDb(db);

    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;");
    raw.exec("DROP TRIGGER trg_review_context_versions_immutable");
    const document = {
      schema: "pd01-advocacy-policy/v1",
      maximumEntries: 10001,
      eligibleRevisions: [],
    };
    raw.prepare("UPDATE review_context_versions SET context_json = ?, fingerprint = ? WHERE id = 'policy-1'")
      .run(canonicalJson(document), fingerprintOf(document));
    raw.exec(DDL);
    raw.close();

    expect(() => openDb({ path, seed: false })).toThrow(/PD-01 V10 maximumEntries/);
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
  });

  it("rejects retroactive assignment revocations after sealing and preserves a later revocation", () => {
    const path = ".tmp/unit/pd01-v9-historical-seal.db";
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    try {
      const db = openDb({ path });
      try {
        const context = ids(db);
        const ballot = insertSealedBallot(db, context, "2026-08-10T00:01:00.000Z");
        const insertState = db.prepare("INSERT INTO event_reviewer_assignment_states (id,workspace_id,event_id,event_reviewer_assignment_id,state,sequence_number,actor_account_id,created_at) VALUES (?,?,?,?,?,?,?,?)");
        const readStates = () => db.prepare("SELECT id,state,sequence_number,created_at FROM event_reviewer_assignment_states WHERE event_reviewer_assignment_id=? ORDER BY sequence_number")
          .all("pd01-assignment");
        const statesAtSeal = readStates();

        expect(() => insertState.run("backdated-state-revoked", context.workspaceId, context.eventId, "pd01-assignment", "REVOKED", 2, context.accountId, "2026-08-10T00:00:30.000Z"))
          .toThrow(/event_reviewer_assignment_states.*chronology/);
        expect(readStates()).toEqual(statesAtSeal);
        expect(() => insertState.run("equal-time-state-revoked", context.workspaceId, context.eventId, "pd01-assignment", "REVOKED", 2, context.accountId, "2026-08-10T00:01:00.000Z"))
          .toThrow(/event_reviewer_assignment_states.*chronology/);
        expect(readStates()).toEqual(statesAtSeal);

        insertState
          .run("historical-state-revoked", context.workspaceId, context.eventId, "pd01-assignment", "REVOKED", 2, context.accountId, "2026-08-10T00:02:00.000Z");
        expect(readStates()).toEqual([
          ...statesAtSeal,
          { id: "historical-state-revoked", state: "REVOKED", sequence_number: 2, created_at: "2026-08-10T00:02:00.000Z" },
        ]);
        expect(db.prepare("SELECT sealed_at FROM recommendation_set_versions WHERE id=?").get(ballot.versionId)).toEqual({ sealed_at: "2026-08-10T00:01:00.000Z" });
      } finally { closeDb(db); }

      const reopened = openDb({ path, seed: false });
      try {
        expect(reopened.prepare("SELECT sealed_at FROM recommendation_set_versions WHERE id=?").get("sealed-set-v1"))
          .toEqual({ sealed_at: "2026-08-10T00:01:00.000Z" });
        expect(reopened.prepare("SELECT state,sequence_number,created_at FROM event_reviewer_assignment_states WHERE event_reviewer_assignment_id=? ORDER BY sequence_number").all("pd01-assignment"))
          .toEqual([
            { state: "ACTIVE", sequence_number: 1, created_at: "2026-08-10T00:00:00.000Z" },
            { state: "REVOKED", sequence_number: 2, created_at: "2026-08-10T00:02:00.000Z" },
          ]);
      } finally { closeDb(reopened); }
    } finally {
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    }
  });

  it("rejects trigger-bypassed revocation before the canonical seal at reopen", () => {
    const path = ".tmp/unit/pd01-v9-seal-state-corruption.db";
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    try {
      const db = openDb({ path });
      const context = ids(db);
      insertSealedBallot(db, context, "2026-08-10T00:02:00.000Z");
      db.prepare("INSERT INTO event_reviewer_assignment_states (id,workspace_id,event_id,event_reviewer_assignment_id,state,sequence_number,actor_account_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run("corrupt-state-revoked", context.workspaceId, context.eventId, "pd01-assignment", "REVOKED", 2, context.accountId, "2026-08-10T00:03:00.000Z");
      closeDb(db);

      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;");
      raw.exec("DROP TRIGGER trg_event_reviewer_assignment_states_immutable");
      raw.prepare("UPDATE event_reviewer_assignment_states SET created_at=? WHERE id='corrupt-state-revoked'")
        .run("2026-08-10T00:01:00.000Z");
      raw.exec(DDL);
      expect(manifestDigest(raw)).toBe(V21_SCHEMA_MANIFEST_SHA256);
      raw.close();

      expect(() => openDb({ path, seed: false })).toThrow(/PD-01 V10 recommendation authority/);
    } finally {
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    }
  });

  it.each(["ACTIVE", "REVOKED"] as const)("rejects a trigger-bypassed foreign-tuple %s state at reopen", (state) => {
    const path = `.tmp/unit/pd01-v10-foreign-${state.toLowerCase()}-state.db`;
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    try {
      const db = openDb({ path });
      const context = ids(db);
      closeDb(db);

      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;");
      raw.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
        .run(`foreign-${state.toLowerCase()}-workspace`, `foreign-${state.toLowerCase()}`, "Foreign", "2026-08-10T00:00:00.000Z");
      raw.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(`foreign-${state.toLowerCase()}-event`, `foreign-${state.toLowerCase()}-workspace`, "Foreign", "UTC", "2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z", "2026-08-10T00:00:00.000Z");
      raw.exec("DROP TRIGGER trg_event_reviewer_assignment_states_guard");
      raw.prepare("INSERT INTO event_reviewer_assignment_states (id, workspace_id, event_id, event_reviewer_assignment_id, state, sequence_number, actor_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(`foreign-${state.toLowerCase()}-state`, `foreign-${state.toLowerCase()}-workspace`, `foreign-${state.toLowerCase()}-event`, "pd01-assignment", state, 2, context.accountId, "2026-08-10T00:01:00.000Z");
      raw.exec(DDL);
      expect(manifestDigest(raw)).toBe(V21_SCHEMA_MANIFEST_SHA256);
      raw.close();

      expect(() => openDb({ path, seed: false })).toThrow(/PD-01 V9 identity\/context integrity/);
    } finally {
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    }
  });

  it.each(["missing", "gapped", "illegal"] as const)("rejects a trigger-bypassed %s assignment-state history at reopen", (corruption) => {
    const path = `.tmp/unit/pd01-v10-${corruption}-state-history.db`;
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    try {
      const db = openDb({ path });
      const context = ids(db);
      closeDb(db);

      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;");
      raw.exec("DROP TRIGGER trg_event_reviewer_assignment_states_guard");
      if (corruption === "missing" || corruption === "gapped") {
        raw.exec("DROP TRIGGER trg_event_reviewer_assignment_states_no_delete");
        raw.prepare("DELETE FROM event_reviewer_assignment_states WHERE event_reviewer_assignment_id = 'pd01-assignment'").run();
      }
      if (corruption === "gapped" || corruption === "illegal") {
        raw.prepare("INSERT INTO event_reviewer_assignment_states (id, workspace_id, event_id, event_reviewer_assignment_id, state, sequence_number, actor_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(`corrupt-${corruption}-state`, context.workspaceId, context.eventId, "pd01-assignment", corruption === "illegal" ? "ACTIVE" : "REVOKED", 2, context.accountId, "2026-08-10T00:01:00.000Z");
      }
      raw.exec(DDL);
      raw.close();

      const expected = corruption === "illegal" ? /PD-01 V10 assignment-state history/ : /PD-01 V9 identity\/context integrity/;
      expect(() => openDb({ path, seed: false })).toThrow(expected);
    } finally {
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    }
  });

  it("enforces typed capacity versioning, atomic receipts, conservation, replay, and overdraft boundaries", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const context = ids(db);
      addPoolVersion(db, { poolId: "pool-a", versionId: "pool-a-v1", ...context, unitKind: "SEAT", capacity: 5, version: 1 });
      addPoolVersion(db, { poolId: "pool-b", versionId: "pool-b-v1", ...context, unitKind: "SEAT", capacity: 2, version: 1 });
      const transfer = {
        workspaceId: context.workspaceId, eventId: context.eventId, sequenceNumber: 1,
        sourcePoolId: "pool-a", sourcePoolVersionId: "pool-a-v1", destinationPoolId: "pool-b", destinationPoolVersionId: "pool-b-v1",
        unitKind: "SEAT", quantity: 3, sourceBefore: 5, sourceAfter: 2, destinationBefore: 2, destinationAfter: 5,
        actorAccountId: context.accountId, reason: "rebalance", approvalReference: "approval-1",
        decidedAt: "2026-08-10T00:00:00.000Z", idempotencyKey: "idem-1",
      };
      db.prepare(`INSERT INTO capacity_transfer_decisions
        (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
         destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before,
         source_after, destination_before, destination_after, actor_account_id, reason,
         approval_reference, decided_at, idempotency_key, fingerprint)
        VALUES ('transfer-1', ?, ?, 1, 'pool-a', 'pool-a-v1', 'pool-b', 'pool-b-v1', 'SEAT', 3, 5, 2, 2, 5, ?, 'rebalance', 'approval-1', ?, 'idem-1', ?)`)
        .run(context.workspaceId, context.eventId, context.accountId, transfer.decidedAt, transferFingerprint(transfer));
      expect(db.prepare("SELECT COUNT(*) AS count FROM capacity_transfer_receipts").get()).toEqual({ count: 1 });
      expect(() => db.prepare("UPDATE capacity_transfer_decisions SET reason = 'changed' WHERE id = 'transfer-1'").run()).toThrow(/immutable/);
      addPoolVersion(db, { poolId: "pool-a", versionId: "pool-a-v2", ...context, unitKind: "SEAT", capacity: 5, version: 2 });
      const sameRoot = {
        ...transfer, sequenceNumber: 2, sourcePoolVersionId: "pool-a-v1",
        destinationPoolId: "pool-a", destinationPoolVersionId: "pool-a-v2",
        quantity: 1, sourceBefore: 2, sourceAfter: 1, destinationBefore: 5, destinationAfter: 6,
        reason: "same root", approvalReference: "approval-same-root", idempotencyKey: "idem-same-root",
      };
      expect(() => db.prepare(`INSERT INTO capacity_transfer_decisions
        (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
         destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before,
         source_after, destination_before, destination_after, actor_account_id, reason,
         approval_reference, decided_at, idempotency_key, fingerprint)
        VALUES ('transfer-same-root', ?, ?, 2, 'pool-a', 'pool-a-v1', 'pool-a', 'pool-a-v2',
          'SEAT', 1, 2, 1, 5, 6, ?, 'same root', 'approval-same-root', ?, 'idem-same-root', ?)`)
        .run(context.workspaceId, context.eventId, context.accountId, sameRoot.decidedAt,
          transferFingerprint(sameRoot))).toThrow(/conservation/);
      const versionReset = {
        ...transfer, sequenceNumber: 2, sourcePoolVersionId: "pool-a-v2",
        quantity: 1, sourceBefore: 5, sourceAfter: 4, destinationBefore: 5, destinationAfter: 6,
        reason: "version reset", approvalReference: "approval-reset", idempotencyKey: "idem-reset",
      };
      expect(() => db.prepare(`INSERT INTO capacity_transfer_decisions
        (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
         destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before,
         source_after, destination_before, destination_after, actor_account_id, reason,
         approval_reference, decided_at, idempotency_key, fingerprint)
        VALUES ('transfer-version-reset', ?, ?, 2, 'pool-a', 'pool-a-v2', 'pool-b', 'pool-b-v1',
          'SEAT', 1, 5, 4, 5, 6, ?, 'version reset', 'approval-reset', ?, 'idem-reset', ?)`)
        .run(context.workspaceId, context.eventId, context.accountId, versionReset.decidedAt,
          transferFingerprint(versionReset))).toThrow(/conservation/);
      expect(() => db.prepare(`INSERT INTO capacity_transfer_decisions
        (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
         destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before,
         source_after, destination_before, destination_after, actor_account_id, reason,
         approval_reference, decided_at, idempotency_key, fingerprint)
        VALUES ('transfer-2', ?, ?, 2, 'pool-a', 'pool-a-v1', 'pool-b', 'pool-b-v1', 'SEAT', 3, 2, -1, 5, 8, ?, 'overdraft', 'approval-2', ?, 'idem-2', ?)`)
        .run(context.workspaceId, context.eventId, context.accountId, "2026-08-10T00:00:00.000Z", "1".repeat(64))).toThrow();
      const replay = {
        ...transfer, sequenceNumber: 2, quantity: 1, sourceBefore: 2, sourceAfter: 1,
        destinationBefore: 5, destinationAfter: 6, reason: "replay", approvalReference: "approval-replay",
      };
      expect(() => db.prepare(`INSERT INTO capacity_transfer_decisions
        (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
         destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before,
         source_after, destination_before, destination_after, actor_account_id, reason,
         approval_reference, decided_at, idempotency_key, fingerprint)
        VALUES ('transfer-replay', ?, ?, 2, 'pool-a', 'pool-a-v1', 'pool-b', 'pool-b-v1',
          'SEAT', 1, 2, 1, 5, 6, ?, 'replay', 'approval-replay', ?, 'idem-1', ?)`)
        .run(context.workspaceId, context.eventId, context.accountId, replay.decidedAt,
          transferFingerprint(replay))).toThrow(/UNIQUE/);

      const receiptTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_capacity_transfer_receipts_immutable'").get() as { sql: string };
      db.exec("DROP TRIGGER trg_capacity_transfer_receipts_immutable");
      db.prepare("UPDATE capacity_transfer_receipts SET quantity = 99 WHERE decision_id = 'transfer-1'").run();
      db.exec(receiptTrigger.sql);
      const second = {
        ...transfer, sequenceNumber: 2, quantity: 1, sourceBefore: 2, sourceAfter: 1,
        destinationBefore: 5, destinationAfter: 6, reason: "decision-led", approvalReference: "approval-2",
        idempotencyKey: "idem-2",
      };
      db.prepare(`INSERT INTO capacity_transfer_decisions
        (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
         destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before,
         source_after, destination_before, destination_after, actor_account_id, reason,
         approval_reference, decided_at, idempotency_key, fingerprint)
        VALUES ('transfer-2', ?, ?, 2, 'pool-a', 'pool-a-v1', 'pool-b', 'pool-b-v1',
          'SEAT', 1, 2, 1, 5, 6, ?, 'decision-led', 'approval-2', ?, 'idem-2', ?)`)
        .run(context.workspaceId, context.eventId, context.accountId, second.decidedAt,
          transferFingerprint(second));
      expect(db.prepare("SELECT quantity FROM capacity_transfer_receipts WHERE decision_id = 'transfer-2'").get())
        .toEqual({ quantity: 1 });
      expect(() => db.prepare("UPDATE program_capacity_pool_versions SET capacity = 99 WHERE id = 'pool-a-v1'").run()).toThrow(/immutable/);
    } finally {
      closeDb(db);
    }
  });

  it("fails closed on corrupted PD-01 JSON or caller hash after trigger bypass", () => {
    const path = ".tmp/unit/pd01-corrupt.db";
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    const db = openDb({ path });
    const context = ids(db);
    addPoolVersion(db, {
      poolId: "corrupt-pool",
      versionId: "corrupt-pool-v1",
      ...context,
      unitKind: "SEAT",
      capacity: 2,
      version: 1,
    });
    closeDb(db);
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA ignore_check_constraints = ON");
    raw.exec("DROP TRIGGER trg_program_capacity_pool_versions_immutable");
    const tooDeep = `${"[".repeat(33)}0${"]".repeat(33)}`;
    raw.prepare("UPDATE program_capacity_pool_versions SET scope_json = ?, fingerprint = ? WHERE id = 'corrupt-pool-v1'")
      .run(tooDeep, "a".repeat(64));
    raw.exec(DDL);
      expect(manifestDigest(raw)).toBe(V21_SCHEMA_MANIFEST_SHA256);
    raw.close();
    expect(() => openDb({ path, seed: false })).toThrow(/PD-01 foundation integrity/);
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
  });

  it.each([
    ["reason", "UPDATE capacity_transfer_decisions SET reason = 'fabricated' WHERE id = 'corrupt-transfer'"],
    ["actor", "UPDATE capacity_transfer_decisions SET actor_account_id = 'foreign-actor' WHERE id = 'corrupt-transfer'"],
    ["unit", "UPDATE capacity_transfer_decisions SET unit_kind = 'HOUR' WHERE id = 'corrupt-transfer'"],
  ])("fails closed on trigger-bypass capacity %s corruption at reopen", (_name, mutation) => {
    const path = `.tmp/unit/pd01-capacity-${_name}.db`;
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    const db = openDb({ path });
    const context = ids(db);
    const foreignActor = db.prepare("SELECT id FROM accounts WHERE workspace_id <> ? LIMIT 1").get(context.workspaceId) as { id: string };
    const effectiveMutation = mutation.replace("foreign-actor", foreignActor.id);
    addPoolVersion(db, { poolId: "corrupt-source", versionId: "corrupt-source-v1", ...context, unitKind: "SEAT", capacity: 5, version: 1 });
    addPoolVersion(db, { poolId: "corrupt-destination", versionId: "corrupt-destination-v1", ...context, unitKind: "SEAT", capacity: 1, version: 1 });
    const transfer = {
      workspaceId: context.workspaceId, eventId: context.eventId, sequenceNumber: 1,
      sourcePoolId: "corrupt-source", sourcePoolVersionId: "corrupt-source-v1", destinationPoolId: "corrupt-destination", destinationPoolVersionId: "corrupt-destination-v1",
      unitKind: "SEAT", quantity: 1, sourceBefore: 5, sourceAfter: 4, destinationBefore: 1, destinationAfter: 2,
      actorAccountId: context.accountId, reason: "reopen corruption", approvalReference: "approval-corrupt",
      decidedAt: "2026-08-10T00:00:00.000Z", idempotencyKey: `corrupt-${_name}`,
    };
    db.prepare(`INSERT INTO capacity_transfer_decisions
      (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
       destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before,
       source_after, destination_before, destination_after, actor_account_id, reason,
       approval_reference, decided_at, idempotency_key, fingerprint)
      VALUES ('corrupt-transfer', ?, ?, 1, ?, ?, ?, ?, 'SEAT', 1, 5, 4, 1, 2, ?, ?, ?, ?, ?, ?)`)
      .run(context.workspaceId, context.eventId, transfer.sourcePoolId, transfer.sourcePoolVersionId,
        transfer.destinationPoolId, transfer.destinationPoolVersionId, transfer.actorAccountId, transfer.reason,
        transfer.approvalReference, transfer.decidedAt, transfer.idempotencyKey, transferFingerprint(transfer));
    closeDb(db);
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("DROP TRIGGER trg_capacity_transfer_decisions_immutable");
    raw.exec(effectiveMutation);
    raw.exec(DDL);
      expect(manifestDigest(raw)).toBe(V21_SCHEMA_MANIFEST_SHA256);
    raw.close();
    expect(() => openDb({ path, seed: false })).toThrow(/PD-01 foundation integrity/);
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
  });

  it.each([
    {
      name: "fabricated before-after",
      mutate: (raw: DatabaseSync, transfer: TransferPayload) => rewriteTransferEvidence(raw, "corrupt-transfer", {
        ...transfer, sourceBefore: 4, sourceAfter: 3,
      }),
    },
    {
      name: "sequence gap",
      mutate: (raw: DatabaseSync, transfer: TransferPayload) => rewriteTransferEvidence(raw, "corrupt-transfer", {
        ...transfer, sequenceNumber: 2,
      }),
    },
    {
      name: "overdraft",
      mutate: (raw: DatabaseSync, transfer: TransferPayload) => rewriteTransferEvidence(raw, "corrupt-transfer", {
        ...transfer, quantity: 6, sourceAfter: -1, destinationAfter: 7,
      }),
    },
    {
      name: "same root",
      mutate: (raw: DatabaseSync, transfer: TransferPayload) => rewriteTransferEvidence(raw, "corrupt-transfer", {
        ...transfer,
        destinationPoolId: transfer.sourcePoolId,
        destinationPoolVersionId: transfer.sourcePoolVersionId,
        destinationBefore: 5,
        destinationAfter: 6,
      }),
    },
    {
      name: "receipt mismatch",
      mutate: (raw: DatabaseSync, _transfer: TransferPayload) => {
        raw.prepare("UPDATE capacity_transfer_receipts SET recorded_at = ? WHERE decision_id = 'corrupt-transfer'")
          .run("2026-08-10T00:00:01.000Z");
      },
    },
    {
      name: "pool-version replay",
      mutate: (raw: DatabaseSync, transfer: TransferPayload) => {
        raw.exec("DROP TRIGGER trg_capacity_transfer_decisions_guard");
        const replay = {
          ...transfer,
          sequenceNumber: 2,
          sourcePoolVersionId: "corrupt-source-v2",
          sourceBefore: 5,
          sourceAfter: 4,
          destinationBefore: 2,
          destinationAfter: 3,
          reason: "capacity reset replay",
          approvalReference: "approval-corrupt-replay",
          idempotencyKey: "corrupt-replay",
        };
        raw.prepare(`INSERT INTO capacity_transfer_decisions
          (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
           destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before,
           source_after, destination_before, destination_after, actor_account_id, reason,
           approval_reference, decided_at, idempotency_key, fingerprint)
          VALUES ('corrupt-transfer-replay', ?, ?, 2, ?, ?, ?, ?, ?, 1, 5, 4, 2, 3, ?, ?, ?, ?, ?, ?)`)
          .run(replay.workspaceId, replay.eventId, replay.sourcePoolId, replay.sourcePoolVersionId,
            replay.destinationPoolId, replay.destinationPoolVersionId, replay.unitKind, replay.actorAccountId,
            replay.reason, replay.approvalReference, replay.decidedAt, replay.idempotencyKey,
            transferFingerprint(replay));
      },
    },
  ])("rejects trigger-bypass $name corruption with the exact manifest restored", ({ name, mutate }) => {
    const path = `.tmp/unit/pd01-capacity-replay-${name.replaceAll(" ", "-")}.db`;
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    const db = openDb({ path });
    const context = ids(db);
    addPoolVersion(db, { poolId: "corrupt-source", versionId: "corrupt-source-v1", ...context, unitKind: "SEAT", capacity: 5, version: 1 });
    addPoolVersion(db, { poolId: "corrupt-source", versionId: "corrupt-source-v2", ...context, unitKind: "SEAT", capacity: 5, version: 2 });
    addPoolVersion(db, { poolId: "corrupt-destination", versionId: "corrupt-destination-v1", ...context, unitKind: "SEAT", capacity: 1, version: 1 });
    const transfer: TransferPayload = {
      workspaceId: context.workspaceId, eventId: context.eventId, sequenceNumber: 1,
      sourcePoolId: "corrupt-source", sourcePoolVersionId: "corrupt-source-v1",
      destinationPoolId: "corrupt-destination", destinationPoolVersionId: "corrupt-destination-v1",
      unitKind: "SEAT", quantity: 1, sourceBefore: 5, sourceAfter: 4, destinationBefore: 1, destinationAfter: 2,
      actorAccountId: context.accountId, reason: "reopen corruption", approvalReference: "approval-corrupt",
      decidedAt: "2026-08-10T00:00:00.000Z", idempotencyKey: `corrupt-replay-${name}`,
    };
    db.prepare(`INSERT INTO capacity_transfer_decisions
      (id, workspace_id, event_id, sequence_number, source_pool_id, source_pool_version_id,
       destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before,
       source_after, destination_before, destination_after, actor_account_id, reason,
       approval_reference, decided_at, idempotency_key, fingerprint)
      VALUES ('corrupt-transfer', ?, ?, 1, ?, ?, ?, ?, 'SEAT', 1, 5, 4, 1, 2, ?, ?, ?, ?, ?, ?)`)
      .run(transfer.workspaceId, transfer.eventId, transfer.sourcePoolId, transfer.sourcePoolVersionId,
        transfer.destinationPoolId, transfer.destinationPoolVersionId, transfer.actorAccountId, transfer.reason,
        transfer.approvalReference, transfer.decidedAt, transfer.idempotencyKey, transferFingerprint(transfer));
    closeDb(db);

    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;");
    raw.exec("DROP TRIGGER trg_capacity_transfer_decisions_immutable");
    raw.exec("DROP TRIGGER trg_capacity_transfer_receipts_immutable");
    mutate(raw, transfer);
    raw.exec(DDL);
      expect(manifestDigest(raw)).toBe(V21_SCHEMA_MANIFEST_SHA256);
    raw.close();
    expect(() => openDb({ path, seed: false })).toThrow();
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
  });
});
