import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { DDL } from "../../src/server/schema";
import {
  createCall,
  createFormDefinition,
  createDraftSubmission,
  saveDraftRevision,
  advanceCallFormVersion,
  readCall,
  sealFormVersion,
  updateCallPolicy,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";

const CFP_TABLES = [
  "form_definitions",
  "rule_versions",
  "form_versions",
  "calls",
  "call_extensions",
  "cfp_email_verifications",
  "cfp_email_verification_consumptions",
  "cfp_applicant_sessions",
  "submissions",
  "submission_revisions",
] as const;

const REVIEW_TABLES = [
  "review_rounds",
  "review_round_states",
  "rubric_versions",
  "review_assignments",
  "review_assignment_states",
  "review_conflict_dispositions",
  "review_revisions",
] as const;

const TRUSTED_REVIEW_TABLES = [
  "review_rubric_semantics",
  "review_blind_artifacts",
  "review_command_receipts",
] as const;

const REVIEWER_ACCESS_TABLES = [
  "reviewer_access_receipts",
  "reviewer_access_states",
] as const;

const PUBLICATION_AUTHORITY_TABLES = [
  "publication_release_versions",
  "publication_audience_channels",
  "publication_audience_policy_versions",
  "publication_audience_receipts",
] as const;

const EXPECTED_V3_MANIFEST_SHA256 =
  "c11246dd8077614523611f504418562e16b7da767f98804e9dfade2c763961ea";

const EXPECTED_V4_MANIFEST_SHA256 =
  "6c53baf5366e56ddafc29efa0cbf1ee4b27dd17630cab194904c6629b870d9d7";

const EXPECTED_V5_MANIFEST_SHA256 =
  "1f86f7e1cd441319222a8c84000d25641d1aeecae4a6a989e737dfa5021b9a1c";

const EXPECTED_V6_MANIFEST_SHA256 =
  "8ca73c15681439bf7f566ea64b64833e8aab7c061fe0536aec4fbbc89c226190";

const EXPECTED_V8_MANIFEST_SHA256 =
  "6ddc50b3112f83b7e24e7ef72045019ca125b48b2a8b1a627603e3788409dd32";
const EXPECTED_V21_MANIFEST_SHA256 =
  "4f82143569670933cf9080e38d312a827bc348a13b3a0dfb6ad233a0867f761b";
function readManifest(db: Db) {
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

function manifestDigest(manifest: unknown): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function workspace(db: Db, slug: string): { id: string; accountId: string } {
  const row = db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(slug) as { id: string };
  const account = db
    .prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1")
    .get(row.id) as { id: string };
  return { id: row.id, accountId: account.id };
}

function setup(db: Db) {
  const northstar = workspace(db, "northstar");
  const acme = workspace(db, "acme");
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES ('schema-event', ?, 'Schema event', 'UTC', ?, ?, ?)`,
  ).run(northstar.id, "2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z", "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
     VALUES ('schema-person', ?, 'schema@synthetic.example', 'Schema Person', ?)`,
  ).run(northstar.id, "2026-08-10T00:00:00.000Z");
  const organizer = { workspaceId: northstar.id, accountId: northstar.accountId };
  const definition = createFormDefinition(db, organizer, { name: "Schema form" });
  const form = sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [
      { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
    ],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = createCall(db, organizer, {
    eventId: "schema-event",
    name: "Schema call",
    slug: "schema-call",
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
  return { northstar, acme, organizer, definition, form, call };
}

type ArtifactTargetFixture = "current" | "draft" | "stale";

function setupTrustedReview(db: Db, artifactTarget: ArtifactTargetFixture = "current") {
  const data = setup(db);
  const issuedAt = "2026-08-10T03:00:00.000Z";
  db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES ('trusted-reviewer', ?, 'trusted-reviewer@synthetic.example', 'Trusted reviewer', 'reviewer', ?)`,
  ).run(data.northstar.id, "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES ('trusted-verification', ?, ?, 'schema@synthetic.example', ?, ?, ?)`,
  ).run(
    data.northstar.id,
    data.call.id,
    "8".repeat(64),
    "2099-08-10T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES ('trusted-consumption', ?, 'trusted-verification', 'schema-person', ?)`,
  ).run(data.northstar.id, "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES ('trusted-session', ?, ?, 'schema-person', 'trusted-verification', ?, ?, ?)`,
  ).run(
    data.northstar.id,
    data.call.id,
    "9".repeat(64),
    "2026-08-10T00:00:00.000Z",
    "2099-08-10T00:00:00.000Z",
  );
  const submission = createDraftSubmission(
    db,
    { workspaceId: data.northstar.id, sessionId: "trusted-session" },
    { callId: data.call.id },
  );
  const saved = saveDraftRevision(
    db,
    { workspaceId: data.northstar.id, sessionId: "trusted-session" },
    {
      submissionId: submission.id,
      historicalAnswers: [{ fieldId: "consent", value: true }],
      expectedCurrentRevisionId: null,
    },
  );
  const revision = db.prepare(
    `SELECT id, revision_number, revision_schema, fingerprint_algorithm, fingerprint, created_at,
            form_document_schema, form_version_id, rule_version_id, form_document_fingerprint
     FROM submission_revisions WHERE id = ?`,
  ).get(saved.revisionId) as {
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

  if (artifactTarget === "stale") {
    saveDraftRevision(
      db,
      { workspaceId: data.northstar.id, sessionId: "trusted-session" },
      {
        submissionId: submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: saved.revisionId,
      },
    );
  }
  if (artifactTarget !== "draft") {
    db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(submission.id);
  }

  db.prepare(
    `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
     VALUES ('trusted-round', ?, 'schema-event', ?, 'Trusted round', ?, ?)`,
  ).run(data.northstar.id, data.call.id, data.northstar.accountId, "2026-08-10T01:00:00.000Z");
  const rubricFingerprint = "1".repeat(64);
  db.prepare(
    `INSERT INTO rubric_versions
       (id, workspace_id, round_id, version_number, rubric_schema, rubric_json,
        fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
     VALUES ('trusted-rubric', ?, 'trusted-round', 1, 'cfp-rubric/v1', '{}',
             'sha256-canonical-json-v1', ?, ?, ?)`,
  ).run(data.northstar.id, rubricFingerprint, data.northstar.accountId, "2026-08-10T01:00:00.000Z");
  const assignmentCreatedAt = "2026-08-10T02:00:00.000Z";
  db.prepare(
    `INSERT INTO review_assignments
       (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id,
        reviewer_account_id, assigned_by, created_at)
     VALUES ('trusted-assignment', ?, 'trusted-round', 'trusted-rubric', ?, ?,
             'trusted-reviewer', ?, ?)`,
  ).run(
    data.northstar.id,
    submission.id,
    revision.id,
    data.northstar.accountId,
    assignmentCreatedAt,
  );

  const semanticsDocument = {
    schema: "cfp-review-rubric-semantics/v1",
    version: 1,
    workspaceId: data.northstar.id,
    roundId: "trusted-round",
    rubricVersionId: "trusted-rubric",
    rubricVersionNumber: 1,
    rubricVersionFingerprint: rubricFingerprint,
    issuer: {
      accountId: data.northstar.accountId,
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
     VALUES ('trusted-semantics', ?, 'trusted-round', 'trusted-rubric', 1, ?,
             'cfp-review-rubric-semantics/v1', 1, ?, 'sha256-canonical-json-v1', ?, ?,
             'organizer', 'phase0.pipeline.manage', 'trusted-semantics-key',
             'sha256-canonical-json-v1', ?, ?)`,
  ).run(
    data.northstar.id,
    rubricFingerprint,
    semanticsJson,
    semanticsFingerprint,
    data.northstar.accountId,
    "2".repeat(64),
    issuedAt,
  );

  const artifactDocument = {
    schema: "cfp-review-blind-artifact/v1",
    version: 1,
    workspaceId: data.northstar.id,
    assignmentId: "trusted-assignment",
    assignmentCreatedAt,
    rubricVersionId: "trusted-rubric",
    rubricSemanticsId: "trusted-semantics",
    rubricSemanticsFingerprint: semanticsFingerprint,
    submissionId: submission.id,
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
    conflictAtIssuance: { status: "NONE", sequenceNumber: 0 },
    attestation: "ORGANIZER_VERIFIED_BLIND_SAFE_REDACTION",
    issuer: {
      accountId: data.northstar.accountId,
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
     VALUES ('trusted-artifact', ?, 'trusted-assignment', ?, 'trusted-rubric',
             'trusted-semantics', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'BLIND_REVIEW', 'NONE', 0, 'cfp-review-blind-artifact/v1', 1, ?,
             'sha256-canonical-json-v1', ?, 'ORGANIZER_VERIFIED_BLIND_SAFE_REDACTION', ?,
             'organizer', 'phase0.pipeline.manage', 'trusted-artifact-key',
             'sha256-canonical-json-v1', ?, ?)`,
  ).run(
    data.northstar.id,
    assignmentCreatedAt,
    semanticsFingerprint,
    submission.id,
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
    data.northstar.accountId,
    "3".repeat(64),
    issuedAt,
  );

  return {
    ...data,
    issuedAt,
    submissionId: submission.id,
    revision,
    rubricFingerprint,
    assignmentCreatedAt,
    semanticsDocument,
    semanticsJson,
    semanticsFingerprint,
    artifactDocument,
    artifactJson,
    artifactFingerprint,
  };
}

function setupPd01Submission(db: Db) {
  const data = setup(db);
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES ('pd01-verification', ?, ?, 'schema@synthetic.example', ?, ?, ?)`,
  ).run(data.northstar.id, data.call.id, "a".repeat(64), "2099-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES ('pd01-consumption', ?, 'pd01-verification', 'schema-person', ?)`,
  ).run(data.northstar.id, "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES ('pd01-session', ?, ?, 'schema-person', 'pd01-verification', ?, ?, ?)`,
  ).run(data.northstar.id, data.call.id, "b".repeat(64), "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
  const submission = createDraftSubmission(db, { workspaceId: data.northstar.id, sessionId: "pd01-session" }, { callId: data.call.id });
  const revision = saveDraftRevision(db, { workspaceId: data.northstar.id, sessionId: "pd01-session" }, {
    submissionId: submission.id,
    historicalAnswers: [{ fieldId: "consent", value: true }],
    expectedCurrentRevisionId: null,
  });
  return { ...data, submissionId: submission.id, revision: { ...revision.revision, id: revision.revisionId } };
}

function installV9BallotAuthority(db: Db, data: ReturnType<typeof setupPd01Submission>, setId: string) {
  const at = "2026-08-10T06:00:00.000Z";
  const bindingDoc = { schema: "pd01-account-person-binding/v1", workspaceId: data.northstar.id, accountId: data.northstar.accountId, personId: "schema-person", boundByAccountId: data.northstar.accountId, bindingBasis: "fixture", createdAt: at };
  const bindingFingerprint = fingerprintOf(bindingDoc);
  db.prepare("INSERT INTO account_person_bindings (id,workspace_id,account_id,person_id,bound_by_account_id,binding_basis,created_at,fingerprint_algorithm,fingerprint) VALUES ('schema-binding',?,?,?,?,?,?,?,?)")
    .run(data.northstar.id, data.northstar.accountId, "schema-person", data.northstar.accountId, "fixture", at, "sha256-canonical-json-v1", bindingFingerprint);
  const assignmentDoc = { schema: "pd01-event-reviewer-assignment/v1", workspaceId: data.northstar.id, eventId: "schema-event", reviewerAccountId: data.northstar.accountId, reviewerPersonId: "schema-person", accountPersonBindingId: "schema-binding", assignedByAccountId: data.northstar.accountId, createdAt: at };
  db.prepare("INSERT INTO event_reviewer_assignments (id,workspace_id,event_id,reviewer_account_id,reviewer_person_id,account_person_binding_id,assigned_by_account_id,created_at,fingerprint_algorithm,fingerprint) VALUES ('schema-assignment',?,?,?,?,?,?,?,?,?)")
    .run(data.northstar.id, "schema-event", data.northstar.accountId, "schema-person", "schema-binding", data.northstar.accountId, at, "sha256-canonical-json-v1", fingerprintOf(assignmentDoc));
  db.prepare("INSERT INTO event_reviewer_assignment_states (id,workspace_id,event_id,event_reviewer_assignment_id,state,sequence_number,actor_account_id,created_at) VALUES ('schema-assignment-state',?,?,?,?,1,?,?)")
    .run(data.northstar.id, "schema-event", "schema-assignment", "ACTIVE", data.northstar.accountId, at);
  const tuple = { submissionId: data.submissionId, submissionRevisionId: data.revision.id, submissionRevisionFingerprint: data.revision.fingerprint };
  const docs = [
    ["p1", "ADVOCACY_POLICY", { schema: "pd01-advocacy-policy/v1", maximumEntries: 2, eligibleRevisions: [tuple] }],
    ["v1", "VISIBILITY", { schema: "pd01-visibility-snapshot/v1", visibleRevisions: [tuple] }],
    ["b1", "BLINDNESS", { schema: "pd01-blindness-policy/v1", disclosureStage: "BLIND_REVIEW", organizerAdvocacyAggregationPermitted: false }],
    ["s1", "SELECTION_CONTEXT", { schema: "pd01-selection-context/v1", decisionBoundary: "selection-context", resolvedRevisions: [tuple] }],
  ] as const;
  for (const [id, kind, document] of docs) db.prepare("INSERT INTO review_context_versions (id,workspace_id,event_id,context_kind,version_number,context_schema,context_json,fingerprint_algorithm,fingerprint,issued_by_account_id,issued_at) VALUES (?,?,?,?,1,?,?,?,?,?,?)")
    .run(id, data.northstar.id, "schema-event", kind, document.schema, canonicalJson(document), "sha256-canonical-json-v1", fingerprintOf(document), data.northstar.accountId, at);
  return { bindingFingerprint, policyFingerprint: fingerprintOf(docs[0][2]), visibilityFingerprint: fingerprintOf(docs[1][2]), blindnessFingerprint: fingerprintOf(docs[2][2]), selectionFingerprint: fingerprintOf(docs[3][2]), eligibility: [tuple], assignmentId: "schema-assignment", personId: "schema-person" };
}

function insertSaveReceipt(db: Db, data: ReturnType<typeof setupTrustedReview>): void {
  const createdAt = "2026-08-10T04:00:00.000Z";
  db.prepare(
    `INSERT INTO review_revisions
       (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id,
        submission_revision_id, revision_number, evaluation_schema, evaluation_json,
        fingerprint_algorithm, fingerprint, created_at)
     VALUES ('trusted-review-revision', ?, 'trusted-assignment', 'trusted-round',
             'trusted-rubric', ?, ?, 1, 'cfp-review-evaluation/v1', '{}',
             'sha256-canonical-json-v1', ?, ?)`,
  ).run(data.northstar.id, data.submissionId, data.revision.id, "4".repeat(64), createdAt);
  const receiptDocument = {
    schema: "cfp-review-command-receipt/v1",
    workspaceId: data.northstar.id,
    assignmentId: "trusted-assignment",
    roundId: "trusted-round",
    rubricVersionId: "trusted-rubric",
    submissionRevisionId: data.revision.id,
    actorAccountId: "trusted-reviewer",
    commandKind: "SAVE_REVIEW",
    effectId: "trusted-review-revision",
    createdAt,
    outcome: { reviewRevisionId: "trusted-review-revision", reviewRevisionNumber: 1 },
  };
  db.prepare(
    `INSERT INTO review_command_receipts
       (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_revision_id,
        actor_account_id, command_kind, idempotency_key, request_schema,
        request_fingerprint_algorithm, request_fingerprint, effect_id, receipt_schema,
        receipt_json, receipt_fingerprint_algorithm, receipt_fingerprint, created_at)
     VALUES ('trusted-receipt', ?, 'trusted-assignment', 'trusted-round', 'trusted-rubric', ?,
             'trusted-reviewer', 'SAVE_REVIEW', 'trusted-save-key',
             'cfp-review-command-request/v1', 'sha256-canonical-json-v1', ?,
             'trusted-review-revision', 'cfp-review-command-receipt/v1', ?,
             'sha256-canonical-json-v1', ?, ?)`,
  ).run(
    data.northstar.id,
    data.revision.id,
    "5".repeat(64),
    canonicalJson(receiptDocument),
    fingerprintOf(receiptDocument),
    createdAt,
  );
}

function insertEffectReceipt(
  db: Db,
  data: ReturnType<typeof setupTrustedReview>,
  input: {
    readonly id: string;
    readonly commandKind: "CONFLICT_DECLARE" | "CONFLICT_CLEAR" | "SUBMIT_REVIEW";
    readonly effectId: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly createdAt: string;
  },
): void {
  const receiptDocument = {
    schema: "cfp-review-command-receipt/v1",
    workspaceId: data.northstar.id,
    assignmentId: "trusted-assignment",
    roundId: "trusted-round",
    rubricVersionId: "trusted-rubric",
    submissionRevisionId: data.revision.id,
    actorAccountId: "trusted-reviewer",
    commandKind: input.commandKind,
    effectId: input.effectId,
    createdAt: input.createdAt,
    outcome: { effectId: input.effectId },
  };
  db.prepare(
    `INSERT INTO review_command_receipts
       (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_revision_id,
        actor_account_id, command_kind, idempotency_key, request_schema,
        request_fingerprint_algorithm, request_fingerprint, effect_id, receipt_schema,
        receipt_json, receipt_fingerprint_algorithm, receipt_fingerprint, created_at)
     VALUES (?, ?, 'trusted-assignment', 'trusted-round', 'trusted-rubric', ?,
             'trusted-reviewer', ?, ?, 'cfp-review-command-request/v1',
             'sha256-canonical-json-v1', ?, ?, 'cfp-review-command-receipt/v1', ?,
             'sha256-canonical-json-v1', ?, ?)`,
  ).run(
    input.id,
    data.northstar.id,
    data.revision.id,
    input.commandKind,
    input.idempotencyKey,
    input.requestFingerprint,
    input.effectId,
    canonicalJson(receiptDocument),
    fingerprintOf(receiptDocument),
    input.createdAt,
  );
}

function cloneStoredRow(
  db: Db,
  table: (typeof TRUSTED_REVIEW_TABLES)[number],
  sourceId: string,
  overrides: Readonly<Record<string, unknown>>,
): void {
  const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
  const source = db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(sourceId) as
    | Record<string, unknown>
    | undefined;
  if (!source) {
    throw new Error(`missing ${table} fixture row`);
  }
  const values = columns.map((column) =>
    Object.prototype.hasOwnProperty.call(overrides, column) ? overrides[column] : source[column],
  ) as SQLInputValue[];
  db.prepare(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...values);
}

describe("CFP, Review, publication, and observation authority on the V19 schema boundary", () => {
  it("creates the authorized CFP, review, trust, publication, and correction-lineage tables", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
      const tables = (db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables.filter((name) => CFP_TABLES.includes(name as (typeof CFP_TABLES)[number]))).toEqual(
        [...CFP_TABLES].sort(),
      );
      expect(tables.filter((name) => REVIEW_TABLES.includes(name as (typeof REVIEW_TABLES)[number]))).toEqual(
        [...REVIEW_TABLES].sort(),
      );
      expect(
        tables.filter((name) => TRUSTED_REVIEW_TABLES.includes(name as (typeof TRUSTED_REVIEW_TABLES)[number])),
      ).toEqual([...TRUSTED_REVIEW_TABLES].sort());
      expect(
        tables.filter((name) => REVIEWER_ACCESS_TABLES.includes(name as (typeof REVIEWER_ACCESS_TABLES)[number])),
      ).toEqual([...REVIEWER_ACCESS_TABLES].sort());
      expect(
        tables.filter((name) => PUBLICATION_AUTHORITY_TABLES.includes(name as (typeof PUBLICATION_AUTHORITY_TABLES)[number])),
      ).toEqual([...PUBLICATION_AUTHORITY_TABLES].sort());
      expect(tables).toContain("observation_corrections");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  it("matches the independently pinned complete normalized V21 manifest without rewriting V6", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      const manifest = readManifest(db);
      expect(EXPECTED_V4_MANIFEST_SHA256).toBe(
        "6c53baf5366e56ddafc29efa0cbf1ee4b27dd17630cab194904c6629b870d9d7",
      );
      expect(EXPECTED_V5_MANIFEST_SHA256).toBe(
        "1f86f7e1cd441319222a8c84000d25641d1aeecae4a6a989e737dfa5021b9a1c",
      );
      expect(EXPECTED_V6_MANIFEST_SHA256).toBe(
        "8ca73c15681439bf7f566ea64b64833e8aab7c061fe0536aec4fbbc89c226190",
      );
      expect(manifestDigest(manifest)).toBe(EXPECTED_V21_MANIFEST_SHA256);
      expect(manifest.filter((object) => object.type === "table")).toHaveLength(95);
      expect(manifest.filter((object) => object.type === "index")).toHaveLength(81);
      expect(manifest.filter((object) => object.type === "trigger")).toHaveLength(261);
      expect(manifest.filter((object) => object.type === "view")).toHaveLength(0);
      expect(manifest.some((object) => object.name === "trg_review_rounds_workspace_guard")).toBe(true);
      expect(manifest.some((object) => object.name === "idx_review_assignments_round")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_cfp_submission_revisions_workspace_guard")).toBe(true);
      expect(manifest.some((object) => object.name === "idx_cfp_submission_revisions_submission")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_review_rubric_semantics_guard")).toBe(true);
      expect(manifest.some((object) => object.name === "idx_review_blind_artifacts_revision")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_review_command_receipts_no_delete")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_reviewer_access_receipts_guard")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_reviewer_access_states_guard")).toBe(true);
      expect(manifest.some((object) => object.name === "idx_observation_corrections_scope")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_observation_corrections_guard")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_observation_corrections_immutable")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_observation_corrections_no_delete")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_observations_v19_guard")).toBe(true);
      expect(manifest.some((object) => object.name === "trg_observation_audit_v19_guard")).toBe(true);
      expect(
        manifest.some(
          (object) => object.name === "idx_cfp_email_verifications_scope_sequence",
        ),
      ).toBe(true);
      expect(
        manifest.some(
          (object) =>
            object.name ===
            "trg_cfp_email_verifications_issuance_sequence_guard",
        ),
      ).toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("stores an immutable, gap-free issuance sequence in the exact workspace/call/email scope", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      const insert = db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at,
            issuance_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        "schema-sequence-1",
        data.northstar.id,
        data.call.id,
        "sequence@synthetic.example",
        "1".repeat(64),
        "2026-08-10T13:00:00.000Z",
        "2026-08-10T12:00:00.000Z",
        1,
      );
      expect(() =>
        insert.run(
          "schema-sequence-gap",
          data.northstar.id,
          data.call.id,
          "sequence@synthetic.example",
          "2".repeat(64),
          "2026-08-10T13:00:00.000Z",
          "2026-08-10T12:00:00.001Z",
          3,
        ),
      ).toThrow(/issuance sequence mismatch/u);
      insert.run(
        "schema-sequence-2",
        data.northstar.id,
        data.call.id,
        "sequence@synthetic.example",
        "2".repeat(64),
        "2026-08-10T13:00:00.000Z",
        "2026-08-10T12:00:00.001Z",
        2,
      );
      expect(
        db
          .prepare(
            `SELECT id, issuance_sequence
             FROM cfp_email_verifications
             WHERE workspace_id = ? AND call_id = ? AND email = ?
             ORDER BY issuance_sequence`,
          )
          .all(
            data.northstar.id,
            data.call.id,
            "sequence@synthetic.example",
          ),
      ).toEqual([
        { id: "schema-sequence-1", issuance_sequence: 1 },
        { id: "schema-sequence-2", issuance_sequence: 2 },
      ]);
      expect(() =>
        db
          .prepare(
            "UPDATE cfp_email_verifications SET issuance_sequence = 3 WHERE id = ?",
          )
          .run("schema-sequence-2"),
      ).toThrow(/cfp_email_verifications is immutable/u);
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["draft", { state: "DRAFT", assignment_is_current: 1 }],
    ["stale", { state: "SUBMITTED", assignment_is_current: 0 }],
  ] as const)("rejects a direct blind-artifact insert for a %s submission target", (target, expectedTarget) => {
    const db = openDb({ path: ":memory:" });
    try {
      expect(() => setupTrustedReview(db, target)).toThrow(/review_blind_artifacts binding mismatch/);
      expect(
        db.prepare(
          `SELECT submission.state,
                  submission.current_revision_id = assignment.submission_revision_id
                    AS assignment_is_current
           FROM review_assignments assignment
           JOIN submissions submission ON submission.id = assignment.submission_id
           WHERE assignment.id = 'trusted-assignment'`,
        ).get(),
      ).toEqual(expectedTarget);
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_blind_artifacts").get()).toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("rejects noncanonical receipt bytes and inexact fingerprints before insertion", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setupTrustedReview(db);
      const createdAt = "2026-08-10T04:00:00.000Z";
      db.prepare(
        `INSERT INTO review_revisions
           (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id,
            submission_revision_id, revision_number, evaluation_schema, evaluation_json,
            fingerprint_algorithm, fingerprint, created_at)
         VALUES ('integrity-review-revision', ?, 'trusted-assignment', 'trusted-round',
                 'trusted-rubric', ?, ?, 1, 'cfp-review-evaluation/v1', '{}',
                 'sha256-canonical-json-v1', ?, ?)`,
      ).run(data.northstar.id, data.submissionId, data.revision.id, "4".repeat(64), createdAt);

      const receiptDocument = {
        schema: "cfp-review-command-receipt/v1",
        workspaceId: data.northstar.id,
        assignmentId: "trusted-assignment",
        roundId: "trusted-round",
        rubricVersionId: "trusted-rubric",
        submissionRevisionId: data.revision.id,
        actorAccountId: "trusted-reviewer",
        commandKind: "SAVE_REVIEW",
        effectId: "integrity-review-revision",
        createdAt,
        outcome: { reviewRevisionId: "integrity-review-revision", reviewRevisionNumber: 1 },
      };
      const canonicalReceiptJson = canonicalJson(receiptDocument);
      const noncanonicalReceiptJson = JSON.stringify(receiptDocument);
      expect(noncanonicalReceiptJson).not.toBe(canonicalReceiptJson);
      const oversizedDocument = { ...receiptDocument, padding: "x".repeat(64 * 1024) };
      const oversizedReceiptJson = canonicalJson(oversizedDocument);
      expect(Buffer.byteLength(oversizedReceiptJson, "utf8")).toBeGreaterThan(64 * 1024);

      const insert = db.prepare(
        `INSERT INTO review_command_receipts
           (id, workspace_id, assignment_id, round_id, rubric_version_id,
            submission_revision_id, actor_account_id, command_kind, idempotency_key,
            request_schema, request_fingerprint_algorithm, request_fingerprint, effect_id,
            receipt_schema, receipt_json, receipt_fingerprint_algorithm, receipt_fingerprint,
            created_at)
         VALUES (?, ?, 'trusted-assignment', 'trusted-round', 'trusted-rubric', ?,
                 'trusted-reviewer', 'SAVE_REVIEW', ?, 'cfp-review-command-request/v1',
                 'sha256-canonical-json-v1', ?, 'integrity-review-revision',
                 'cfp-review-command-receipt/v1', ?, 'sha256-canonical-json-v1', ?, ?)`,
      );
      const exactFingerprint = fingerprintOf(receiptDocument);
      const rejected = [
        ["leading whitespace", ` ${canonicalReceiptJson}`, exactFingerprint],
        ["trailing whitespace", `${canonicalReceiptJson}\n`, exactFingerprint],
        ["noncanonical key order", noncanonicalReceiptJson, exactFingerprint],
        ["wrong 64-hex fingerprint", canonicalReceiptJson, "0".repeat(64)],
        [
          "raw-byte fingerprint over noncanonical JSON",
          noncanonicalReceiptJson,
          createHash("sha256").update(noncanonicalReceiptJson).digest("hex"),
        ],
        ["malformed JSON", "{", "0".repeat(64)],
        ["oversized JSON", oversizedReceiptJson, fingerprintOf(oversizedDocument)],
      ] as const;

      rejected.forEach(([name, receiptJson, receiptFingerprint], index) => {
        const expectedError = name === "malformed JSON"
          ? /malformed JSON|review_command_receipts binding mismatch/
          : /review_command_receipts binding mismatch/;
        expect(() => insert.run(
          `integrity-rejected-${index}`,
          data.northstar.id,
          data.revision.id,
          `integrity-rejected-key-${index}`,
          createHash("sha256").update(name).digest("hex"),
          receiptJson,
          receiptFingerprint,
          createdAt,
        ), name).toThrow(expectedError);
        expect(db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 0 });
      });

      insert.run(
        "integrity-valid",
        data.northstar.id,
        data.revision.id,
        "integrity-valid-key",
        createHash("sha256").update("integrity-valid").digest("hex"),
        canonicalReceiptJson,
        exactFingerprint,
        createdAt,
      );
      expect(db.prepare(
        "SELECT receipt_json AS receiptJson, receipt_fingerprint AS receiptFingerprint FROM review_command_receipts",
      ).get()).toEqual({ receiptJson: canonicalReceiptJson, receiptFingerprint: exactFingerprint });
    } finally {
      closeDb(db);
    }
  });

  it("accepts exact trusted-review bindings and makes every V5 row immutable and irreplaceable", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setupTrustedReview(db);
      insertSaveReceipt(db, data);
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_rubric_semantics").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_blind_artifacts").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 1 });

      const rows = [
        ["review_rubric_semantics", "trusted-semantics"],
        ["review_blind_artifacts", "trusted-artifact"],
        ["review_command_receipts", "trusted-receipt"],
      ] as const;
      for (const [table, id] of rows) {
        expect(() => db.prepare(`UPDATE "${table}" SET id = id WHERE id = ?`).run(id)).toThrow(/immutable/);
        expect(() => db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id)).toThrow(/immutable/);
        expect(() => db.prepare(`INSERT OR REPLACE INTO "${table}" SELECT * FROM "${table}" WHERE id = ?`).run(id)).toThrow(
          table === "review_command_receipts" ? /immutable|binding mismatch/ : /immutable/,
        );
        expect(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()).toEqual({ count: 1 });
      }
    } finally {
      closeDb(db);
    }
  });

  it("binds every command receipt kind to its exact immutable effect actor and timestamp", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setupTrustedReview(db);
      const declaredAt = "2026-08-10T05:00:00.000Z";
      const clearedAt = "2026-08-10T06:00:00.000Z";
      const submittedAt = "2026-08-10T07:00:00.000Z";
      db.prepare(
        `INSERT INTO review_conflict_dispositions
           (id, workspace_id, assignment_id, action, sequence_number, actor_account_id,
            actor_role_basis, reason, created_at)
         VALUES ('receipt-declare-effect', ?, 'trusted-assignment', 'DECLARE', 1,
                 'trusted-reviewer', 'reviewer', 'synthetic declaration', ?)`,
      ).run(data.northstar.id, declaredAt);
      db.prepare(
        `INSERT INTO review_conflict_dispositions
           (id, workspace_id, assignment_id, action, sequence_number, actor_account_id,
            actor_role_basis, reason, created_at)
         VALUES ('receipt-clear-effect', ?, 'trusted-assignment', 'CLEAR', 2,
                 'trusted-reviewer', 'reviewer', 'synthetic clear', ?)`,
      ).run(data.northstar.id, clearedAt);
      insertEffectReceipt(db, data, {
        id: "receipt-declare",
        commandKind: "CONFLICT_DECLARE",
        effectId: "receipt-declare-effect",
        idempotencyKey: "receipt-declare-key",
        requestFingerprint: "a".repeat(64),
        createdAt: declaredAt,
      });
      insertEffectReceipt(db, data, {
        id: "receipt-clear",
        commandKind: "CONFLICT_CLEAR",
        effectId: "receipt-clear-effect",
        idempotencyKey: "receipt-clear-key",
        requestFingerprint: "b".repeat(64),
        createdAt: clearedAt,
      });
      insertSaveReceipt(db, data);
      db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number, actor_account_id, created_at)
         VALUES ('receipt-submit-effect', ?, 'trusted-assignment', 'SUBMITTED', 2,
                 'trusted-reviewer', ?)`,
      ).run(data.northstar.id, submittedAt);
      insertEffectReceipt(db, data, {
        id: "receipt-submit",
        commandKind: "SUBMIT_REVIEW",
        effectId: "receipt-submit-effect",
        idempotencyKey: "receipt-submit-key",
        requestFingerprint: "c".repeat(64),
        createdAt: submittedAt,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 4 });

      const wrongDocument = {
        schema: "cfp-review-command-receipt/v1",
        workspaceId: data.northstar.id,
        assignmentId: "trusted-assignment",
        roundId: "trusted-round",
        rubricVersionId: "trusted-rubric",
        submissionRevisionId: data.revision.id,
        actorAccountId: "trusted-reviewer",
        commandKind: "CONFLICT_CLEAR",
        effectId: "receipt-declare-effect",
        createdAt: declaredAt,
      };
      expect(() => cloneStoredRow(db, "review_command_receipts", "receipt-declare", {
        id: "receipt-wrong-effect-kind",
        command_kind: "CONFLICT_CLEAR",
        idempotency_key: "receipt-wrong-effect-kind",
        request_fingerprint: "d".repeat(64),
        receipt_json: canonicalJson(wrongDocument),
        receipt_fingerprint: fingerprintOf(wrongDocument),
      })).toThrow(/review_command_receipts binding mismatch/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 4 });
    } finally {
      closeDb(db);
    }
  });

  it("rejects every missing, extra, mistyped, mismatched, non-object, and command-swapped outcome", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setupTrustedReview(db);
      const saveAt = "2026-08-10T04:00:00.000Z";
      const declaredAt = "2026-08-10T05:00:00.000Z";
      const clearedAt = "2026-08-10T06:00:00.000Z";
      const submittedAt = "2026-08-10T07:00:00.000Z";
      db.prepare(
        `INSERT INTO review_revisions
           (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id,
            submission_revision_id, revision_number, evaluation_schema, evaluation_json,
            fingerprint_algorithm, fingerprint, created_at)
         VALUES ('outcome-save-effect', ?, 'trusted-assignment', 'trusted-round',
                 'trusted-rubric', ?, ?, 1, 'cfp-review-evaluation/v1', '{}',
                 'sha256-canonical-json-v1', ?, ?)`,
      ).run(data.northstar.id, data.submissionId, data.revision.id, "6".repeat(64), saveAt);
      db.prepare(
        `INSERT INTO review_conflict_dispositions
           (id, workspace_id, assignment_id, action, sequence_number, actor_account_id,
            actor_role_basis, reason, created_at)
         VALUES ('outcome-declare-effect', ?, 'trusted-assignment', 'DECLARE', 1,
                 'trusted-reviewer', 'reviewer', 'outcome declaration', ?)`,
      ).run(data.northstar.id, declaredAt);
      db.prepare(
        `INSERT INTO review_conflict_dispositions
           (id, workspace_id, assignment_id, action, sequence_number, actor_account_id,
            actor_role_basis, reason, created_at)
         VALUES ('outcome-clear-effect', ?, 'trusted-assignment', 'CLEAR', 2,
                 'trusted-reviewer', 'reviewer', 'outcome clear', ?)`,
      ).run(data.northstar.id, clearedAt);
      db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number, actor_account_id, created_at)
         VALUES ('outcome-submit-effect', ?, 'trusted-assignment', 'SUBMITTED', 2,
                 'trusted-reviewer', ?)`,
      ).run(data.northstar.id, submittedAt);

      type CommandKind = "CONFLICT_DECLARE" | "CONFLICT_CLEAR" | "SAVE_REVIEW" | "SUBMIT_REVIEW";
      type InvalidOutcome = {
        readonly name: string;
        readonly commandKind: CommandKind;
        readonly effectId: string;
        readonly createdAt: string;
        readonly outcome?: unknown;
        readonly omitOutcome?: boolean;
      };
      const saveVariants: readonly InvalidOutcome[] = [
        { name: "save missing", commandKind: "SAVE_REVIEW", effectId: "outcome-save-effect", createdAt: saveAt, omitOutcome: true },
        { name: "save extra", commandKind: "SAVE_REVIEW", effectId: "outcome-save-effect", createdAt: saveAt, outcome: { reviewRevisionId: "outcome-save-effect", reviewRevisionNumber: 1, extra: true } },
        { name: "save id type", commandKind: "SAVE_REVIEW", effectId: "outcome-save-effect", createdAt: saveAt, outcome: { reviewRevisionId: 1, reviewRevisionNumber: 1 } },
        { name: "save id", commandKind: "SAVE_REVIEW", effectId: "outcome-save-effect", createdAt: saveAt, outcome: { reviewRevisionId: "wrong-effect", reviewRevisionNumber: 1 } },
        { name: "save number type", commandKind: "SAVE_REVIEW", effectId: "outcome-save-effect", createdAt: saveAt, outcome: { reviewRevisionId: "outcome-save-effect", reviewRevisionNumber: "1" } },
        { name: "save number", commandKind: "SAVE_REVIEW", effectId: "outcome-save-effect", createdAt: saveAt, outcome: { reviewRevisionId: "outcome-save-effect", reviewRevisionNumber: 2 } },
        { name: "save non-object", commandKind: "SAVE_REVIEW", effectId: "outcome-save-effect", createdAt: saveAt, outcome: ["outcome-save-effect", 1] },
        { name: "save swapped", commandKind: "SAVE_REVIEW", effectId: "outcome-save-effect", createdAt: saveAt, outcome: { effectId: "outcome-save-effect" } },
      ];
      const effectCommands = [
        { commandKind: "CONFLICT_DECLARE", effectId: "outcome-declare-effect", createdAt: declaredAt },
        { commandKind: "CONFLICT_CLEAR", effectId: "outcome-clear-effect", createdAt: clearedAt },
        { commandKind: "SUBMIT_REVIEW", effectId: "outcome-submit-effect", createdAt: submittedAt },
      ] as const;
      const effectVariants: readonly InvalidOutcome[] = effectCommands.flatMap((effect) => [
        { name: `${effect.commandKind} missing`, ...effect, omitOutcome: true },
        { name: `${effect.commandKind} extra`, ...effect, outcome: { effectId: effect.effectId, extra: true } },
        { name: `${effect.commandKind} type`, ...effect, outcome: { effectId: 1 } },
        { name: `${effect.commandKind} id`, ...effect, outcome: { effectId: "wrong-effect" } },
        { name: `${effect.commandKind} non-object`, ...effect, outcome: effect.effectId },
        { name: `${effect.commandKind} swapped`, ...effect, outcome: { reviewRevisionId: effect.effectId, reviewRevisionNumber: 1 } },
      ]);
      const insert = db.prepare(
        `INSERT INTO review_command_receipts
           (id, workspace_id, assignment_id, round_id, rubric_version_id,
            submission_revision_id, actor_account_id, command_kind, idempotency_key,
            request_schema, request_fingerprint_algorithm, request_fingerprint, effect_id,
            receipt_schema, receipt_json, receipt_fingerprint_algorithm, receipt_fingerprint,
            created_at)
         VALUES (?, ?, 'trusted-assignment', 'trusted-round', 'trusted-rubric', ?,
                 'trusted-reviewer', ?, ?, 'cfp-review-command-request/v1',
                 'sha256-canonical-json-v1', ?, ?, 'cfp-review-command-receipt/v1', ?,
                 'sha256-canonical-json-v1', ?, ?)`,
      );

      for (const [index, variant] of [...saveVariants, ...effectVariants].entries()) {
        const document: Record<string, unknown> = {
          schema: "cfp-review-command-receipt/v1",
          workspaceId: data.northstar.id,
          assignmentId: "trusted-assignment",
          roundId: "trusted-round",
          rubricVersionId: "trusted-rubric",
          submissionRevisionId: data.revision.id,
          actorAccountId: "trusted-reviewer",
          commandKind: variant.commandKind,
          effectId: variant.effectId,
          createdAt: variant.createdAt,
        };
        if (!variant.omitOutcome) {
          document.outcome = variant.outcome;
        }
        expect(() => insert.run(
          `invalid-outcome-receipt-${index}`,
          data.northstar.id,
          data.revision.id,
          variant.commandKind,
          `invalid-outcome-key-${index}`,
          fingerprintOf({ request: variant.name }),
          variant.effectId,
          canonicalJson(document),
          fingerprintOf(document),
          variant.createdAt,
        ), variant.name).toThrow(/review_command_receipts binding mismatch/);
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("returns the existing exact receipt and rejects a canonical alias for the same command effect", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setupTrustedReview(db);
      insertSaveReceipt(db, data);
      const exactLookup = db.prepare(
        `SELECT * FROM review_command_receipts
         WHERE workspace_id = ? AND actor_account_id = 'trusted-reviewer'
           AND command_kind = 'SAVE_REVIEW' AND idempotency_key = 'trusted-save-key'`,
      );
      const existing = exactLookup.get(data.northstar.id);
      expect(existing).toBeDefined();
      expect(exactLookup.get(data.northstar.id)).toEqual(existing);

      const stored = existing as { receipt_json: string };
      const aliasDocument = {
        ...(JSON.parse(stored.receipt_json) as Record<string, unknown>),
        replayAlias: "canonical-distinct-receipt",
      };
      expect(() => cloneStoredRow(db, "review_command_receipts", "trusted-receipt", {
        id: "trusted-receipt-alias",
        idempotency_key: "trusted-save-alias-key",
        request_fingerprint: fingerprintOf({ request: "trusted-save-alias" }),
        receipt_json: canonicalJson(aliasDocument),
        receipt_fingerprint: fingerprintOf(aliasDocument),
      })).toThrow(/review_command_receipts binding mismatch/);
      expect(exactLookup.get(data.northstar.id)).toEqual(existing);
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get()).toEqual({ count: 1 });
    } finally {
      closeDb(db);
    }
  });

  it("rejects trusted-review collisions, malformed fingerprints, header drift, and effect drift", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setupTrustedReview(db);
      insertSaveReceipt(db, data);

      expect(() => cloneStoredRow(db, "review_rubric_semantics", "trusted-semantics", {
        id: "semantics-collision",
      })).toThrow();
      expect(() => cloneStoredRow(db, "review_blind_artifacts", "trusted-artifact", {
        id: "artifact-collision",
      })).toThrow();
      expect(() => cloneStoredRow(db, "review_command_receipts", "trusted-receipt", {
        id: "receipt-collision",
      })).toThrow();

      expect(() => cloneStoredRow(db, "review_rubric_semantics", "trusted-semantics", {
        id: "bad-semantics-role",
        issuer_role: "reviewer",
      })).toThrow(/review_rubric_semantics binding mismatch/);
      expect(() => cloneStoredRow(db, "review_blind_artifacts", "trusted-artifact", {
        id: "bad-artifact-header",
        artifact_json: canonicalJson({ ...data.artifactDocument, assignmentId: "other-assignment" }),
      })).toThrow(/review_blind_artifacts binding mismatch/);
      expect(() => cloneStoredRow(db, "review_blind_artifacts", "trusted-artifact", {
        id: "bad-artifact-fingerprint",
        request_fingerprint: `${"a".repeat(64)}\0`,
      })).toThrow(/review_blind_artifacts binding mismatch/);
      expect(() => cloneStoredRow(db, "review_command_receipts", "trusted-receipt", {
        id: "bad-receipt-effect",
        effect_id: "missing-effect",
      })).toThrow(/review_command_receipts binding mismatch/);
      expect(() => cloneStoredRow(db, "review_command_receipts", "trusted-receipt", {
        id: "bad-receipt-header",
        receipt_json: canonicalJson({
          schema: "cfp-review-command-receipt/v1",
          workspaceId: data.northstar.id,
          assignmentId: "trusted-assignment",
          roundId: "trusted-round",
          rubricVersionId: "trusted-rubric",
          submissionRevisionId: data.revision.id,
          actorAccountId: "trusted-reviewer",
          commandKind: "SAVE_REVIEW",
          effectId: "different-effect",
          createdAt: "2026-08-10T04:00:00.000Z",
        }),
      })).toThrow(/review_command_receipts binding mismatch/);

      for (const table of TRUSTED_REVIEW_TABLES) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()).toEqual({ count: 1 });
      }
    } finally {
      closeDb(db);
    }
  });

  it("requires the issuer's matching current organizer authority at insertion", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setupTrustedReview(db);
      const mismatchedRoleDocument = {
        ...data.semanticsDocument,
        issuer: { ...data.semanticsDocument.issuer, role: "workspace_admin" },
      };
      expect(() => cloneStoredRow(db, "review_rubric_semantics", "trusted-semantics", {
        id: "mismatched-current-role",
        issuer_role: "workspace_admin",
        semantics_json: canonicalJson(mismatchedRoleDocument),
        fingerprint: fingerprintOf(mismatchedRoleDocument),
        idempotency_key: "mismatched-current-role",
        request_fingerprint: fingerprintOf({ request: "mismatched-current-role" }),
      })).toThrow(/review_rubric_semantics binding mismatch/);

      db.prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?").run(data.northstar.accountId);
      const reviewerSemanticsDocument = {
        ...data.semanticsDocument,
        issuer: { ...data.semanticsDocument.issuer, role: "reviewer" },
      };
      expect(() => cloneStoredRow(db, "review_rubric_semantics", "trusted-semantics", {
        id: "unauthorized-semantics",
        issuer_role: "reviewer",
        semantics_json: canonicalJson(reviewerSemanticsDocument),
        fingerprint: fingerprintOf(reviewerSemanticsDocument),
        idempotency_key: "unauthorized-semantics",
        request_fingerprint: fingerprintOf({ request: "unauthorized-semantics" }),
      })).toThrow(/review_rubric_semantics binding mismatch/);

      const reviewerArtifactDocument = {
        ...data.artifactDocument,
        issuer: { ...data.artifactDocument.issuer, role: "reviewer" },
      };
      expect(() => cloneStoredRow(db, "review_blind_artifacts", "trusted-artifact", {
        id: "unauthorized-artifact",
        issuer_role: "reviewer",
        artifact_json: canonicalJson(reviewerArtifactDocument),
        fingerprint: fingerprintOf(reviewerArtifactDocument),
        idempotency_key: "unauthorized-artifact",
        request_fingerprint: fingerprintOf({ request: "unauthorized-artifact" }),
      })).toThrow(/review_blind_artifacts binding mismatch/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_rubric_semantics").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_blind_artifacts").get()).toEqual({ count: 1 });
    } finally {
      closeDb(db);
    }
  });

  it("requires current round, assignment, and conflict authority before issuing another blind artifact", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setupTrustedReview(db);
      db.prepare(
        `INSERT INTO review_conflict_dispositions
           (id, workspace_id, assignment_id, action, sequence_number, actor_account_id,
            actor_role_basis, reason, created_at)
         VALUES ('trusted-conflict', ?, 'trusted-assignment', 'DECLARE', 1, 'trusted-reviewer',
                 'reviewer', 'synthetic conflict', ?)`,
      ).run(data.northstar.id, "2026-08-10T05:00:00.000Z");
      expect(() => cloneStoredRow(db, "review_blind_artifacts", "trusted-artifact", {
        id: "artifact-after-conflict",
        fingerprint: "6".repeat(64),
        idempotency_key: "artifact-after-conflict",
        request_fingerprint: "7".repeat(64),
      })).toThrow(/review_blind_artifacts binding mismatch/);

      db.prepare(
        `INSERT INTO review_conflict_dispositions
           (id, workspace_id, assignment_id, action, sequence_number, actor_account_id,
            actor_role_basis, reason, created_at)
         VALUES ('trusted-conflict-clear', ?, 'trusted-assignment', 'CLEAR', 2, 'trusted-reviewer',
                 'reviewer', 'synthetic clear', ?)`,
      ).run(data.northstar.id, "2026-08-10T06:00:00.000Z");
      db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number, actor_account_id, created_at)
         VALUES ('trusted-revoked', ?, 'trusted-assignment', 'REVOKED', 2, ?, ?)`,
      ).run(data.northstar.id, data.northstar.accountId, "2026-08-10T07:00:00.000Z");
      expect(() => cloneStoredRow(db, "review_blind_artifacts", "trusted-artifact", {
        id: "artifact-after-revocation",
        conflict_status_at_issuance: "CLEARED",
        conflict_sequence_at_issuance: 2,
        fingerprint: "8".repeat(64),
        idempotency_key: "artifact-after-revocation",
        request_fingerprint: "9".repeat(64),
      })).toThrow(/review_blind_artifacts binding mismatch/);

      db.prepare(
        `INSERT INTO review_round_states
           (id, workspace_id, round_id, state, sequence_number, actor_account_id, created_at)
         VALUES ('trusted-round-open', ?, 'trusted-round', 'OPEN', 2, ?, ?)`,
      ).run(data.northstar.id, data.northstar.accountId, "2026-08-10T08:00:00.000Z");
      db.prepare(
        `INSERT INTO review_round_states
           (id, workspace_id, round_id, state, sequence_number, actor_account_id, created_at)
         VALUES ('trusted-round-closed', ?, 'trusted-round', 'CLOSED', 3, ?, ?)`,
      ).run(data.northstar.id, data.northstar.accountId, "2026-08-10T09:00:00.000Z");
      expect(() => cloneStoredRow(db, "review_rubric_semantics", "trusted-semantics", {
        id: "semantics-after-close",
        fingerprint: "a".repeat(64),
        idempotency_key: "semantics-after-close",
        request_fingerprint: "b".repeat(64),
      })).toThrow(/review_rubric_semantics binding mismatch/);

      expect(db.prepare("SELECT COUNT(*) AS count FROM review_rubric_semantics").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_blind_artifacts").get()).toEqual({ count: 1 });
    } finally {
      closeDb(db);
    }
  });

  it("keeps paired artifacts immutable and rejects tenant-crossing references", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      expect(() =>
        db.prepare("UPDATE rule_versions SET rules_json = '{}' WHERE id = ?").run(data.form.ruleVersionId),
      ).toThrow(/rule_versions is immutable/);
      expect(() =>
        db.prepare("DELETE FROM form_versions WHERE id = ?").run(data.form.id),
      ).toThrow(/form_versions is immutable/);
      expect(() =>
        db.prepare(
          `INSERT INTO rule_versions
             (id, workspace_id, form_definition_id, version_number, rules_schema, rules_json,
              fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
           VALUES ('cross-rule', ?, ?, 2, 'cfp-form-rules/v1', '{}',
                   'sha256-canonical-json-v1', ?, ?, ?)`,
        ).run(data.northstar.id, data.definition.id, "a".repeat(64), data.acme.accountId, "2026-08-10T00:00:00.000Z"),
      ).toThrow(/rule_versions workspace mismatch/);
    } finally {
      closeDb(db);
    }
  });

  it("rejects unknown artifact schemas/algorithms and empty seal evidence at the SQL boundary", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      const attempts: Array<() => unknown> = [
        () => db.prepare(
          `INSERT INTO rule_versions
             (id, workspace_id, form_definition_id, version_number, rules_schema, rules_json,
              fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
           VALUES ('bad-rule-schema', ?, ?, 9, 'unknown', '{}', 'sha256-canonical-json-v1', ?, ?, ?)`,
        ).run(data.northstar.id, data.definition.id, "a".repeat(64), data.northstar.accountId, "2026-08-10T00:00:00.000Z"),
        () => db.prepare(
          `INSERT INTO rule_versions
             (id, workspace_id, form_definition_id, version_number, rules_schema, rules_json,
              fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
           VALUES ('bad-rule-algorithm', ?, ?, 10, 'cfp-form-rules/v1', '{}', 'unknown', ?, ?, ?)`,
        ).run(data.northstar.id, data.definition.id, "a".repeat(64), data.northstar.accountId, "2026-08-10T00:00:00.000Z"),
        () => db.prepare(
          `INSERT INTO rule_versions
             (id, workspace_id, form_definition_id, version_number, rules_schema, rules_json,
              fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
           VALUES ('bad-rule-seal', ?, ?, 11, 'cfp-form-rules/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '')`,
        ).run(data.northstar.id, data.definition.id, "a".repeat(64), data.northstar.accountId),
        () => db.prepare(
          `INSERT INTO form_versions
             (id, workspace_id, form_definition_id, rule_version_id, version_number,
              document_schema, document_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
           VALUES ('bad-form-schema', ?, ?, ?, 1, 'unknown', '{}', 'sha256-canonical-json-v1', ?, ?, ?)`,
        ).run(data.northstar.id, data.definition.id, data.form.ruleVersionId, "a".repeat(64), data.northstar.accountId, "2026-08-10T00:00:00.000Z"),
        () => db.prepare(
          `INSERT INTO form_versions
             (id, workspace_id, form_definition_id, rule_version_id, version_number,
              document_schema, document_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
           VALUES ('bad-form-algorithm', ?, ?, ?, 1, 'cfp-form-document/v1', '{}', 'unknown', ?, ?, ?)`,
        ).run(data.northstar.id, data.definition.id, data.form.ruleVersionId, "a".repeat(64), data.northstar.accountId, "2026-08-10T00:00:00.000Z"),
        () => db.prepare(
          `INSERT INTO form_versions
             (id, workspace_id, form_definition_id, rule_version_id, version_number,
              document_schema, document_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
           VALUES ('bad-form-seal', ?, ?, ?, 1, 'cfp-form-document/v1', '{}', 'sha256-canonical-json-v1', ?, ?, '')`,
        ).run(data.northstar.id, data.definition.id, data.form.ruleVersionId, "a".repeat(64), data.northstar.accountId),
      ];
      for (const attempt of attempts) {
        expect(attempt).toThrow();
      }
    } finally {
      closeDb(db);
    }
  });

  it("rejects caller-supplied rule/policy identities and invalid call windows", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      expect(() => sealFormVersion(db, data.organizer, {
        formDefinitionId: data.definition.id,
        fields: [{ id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" }],
        rules: {
          schema: FORM_RULES_SCHEMA,
          rules: [],
          ruleVersionId: "caller-guessed-rule-id",
        } as unknown,
      })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_INPUT_INVALID" }));

      const current = readCall(db, data.northstar.id, data.call.id);
      const storedPolicy = db.prepare("SELECT policy_json FROM calls WHERE id = ?").get(data.call.id) as {
        policy_json: string;
      };
      expect(Object.keys(JSON.parse(storedPolicy.policy_json) as Record<string, unknown>).sort()).toEqual([
        "choices",
        "disclosure",
        "policyVersionId",
        "schema",
      ]);
      expect(current.policy.fingerprint).toBe(current.fingerprint);
      expect(() => updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: current.fingerprint,
        policy: {
          schema: "cfp-call-policy/v1",
          policyVersionId: "caller-guessed-policy-id",
          disclosure: current.disclosure,
          choices: current.choices,
        } as unknown,
      })).toThrowError(expect.objectContaining({ code: "CALL_POLICY_INVALID" }));

      expect(() => createCall(db, data.organizer, {
        eventId: "schema-event",
        name: "Bad window",
        slug: "bad-window",
        formVersionId: data.form.id,
        opensAt: "2026-09-15T11:00:00.000Z",
        closesAt: "2026-09-15T10:00:00.000Z",
        policy: {
          disclosure: current.disclosure,
          choices: current.choices,
        },
      })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_INPUT_INVALID" }));
      expect(() => createCall(db, data.organizer, {
        eventId: "schema-event",
        name: "Bad timezone",
        slug: "bad-timezone",
        formVersionId: data.form.id,
        timezone: "Not/A-Timezone",
        policy: {
          disclosure: current.disclosure,
          choices: current.choices,
        },
      })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_INPUT_INVALID" }));
    } finally {
      closeDb(db);
    }
  });

  it("rejects stored policy schema/algorithm, noncanonical bytes, and fingerprint tampering independently", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      expect(() => db.prepare("UPDATE calls SET policy_schema = ? WHERE id = ?").run(
        "unknown-policy-schema",
        data.call.id,
      )).toThrow(/calls workspace mismatch/);
      expect(() => db.prepare("UPDATE calls SET policy_fingerprint_algorithm = ? WHERE id = ?").run(
        "unknown-policy-algorithm",
        data.call.id,
      )).toThrow(/calls workspace mismatch/);

      const row = db.prepare("SELECT policy_json, policy_fingerprint FROM calls WHERE id = ?").get(data.call.id) as {
        policy_json: string;
        policy_fingerprint: string;
      };
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET policy_json = ? WHERE id = ?").run(` ${row.policy_json} `, data.call.id);
      db.exec(DDL);
      expect(() => readCall(db, data.northstar.id, data.call.id)).toThrowError(
        expect.objectContaining({ code: "CALL_POLICY_NOT_CANONICAL" }),
      );

      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET policy_json = ?, policy_fingerprint = ? WHERE id = ?").run(
        row.policy_json,
        "0".repeat(64),
        data.call.id,
      );
      db.exec(DDL);
      expect(() => readCall(db, data.northstar.id, data.call.id)).toThrowError(
        expect.objectContaining({ code: "CALL_POLICY_NOT_CANONICAL" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["form fingerprint", (db: Db, data: ReturnType<typeof setup>) => {
      db.exec("DROP TRIGGER trg_cfp_form_versions_immutable");
      db.prepare("UPDATE form_versions SET fingerprint = ? WHERE id = ?").run("0".repeat(64), data.form.id);
      db.exec(DDL);
    }, "FORM_ARTIFACT_MIRROR_MISMATCH"],
    ["rule fingerprint", (db: Db, data: ReturnType<typeof setup>) => {
      db.exec("DROP TRIGGER trg_cfp_rule_versions_immutable");
      db.prepare("UPDATE rule_versions SET fingerprint = ? WHERE id = ?").run("0".repeat(64), data.form.ruleVersionId);
      db.exec(DDL);
    }, "RULE_ARTIFACT_NOT_CANONICAL"],
    ["form definition identity", (db: Db, data: ReturnType<typeof setup>) => {
      const other = createFormDefinition(db, data.organizer, { name: "Other identity form" });
      db.exec("DROP TRIGGER trg_cfp_form_versions_immutable");
      db.prepare("UPDATE form_versions SET form_definition_id = ? WHERE id = ?").run(other.id, data.form.id);
      db.exec(DDL);
    }, "SUBMISSION_PIN_MISMATCH"],
    ["rule definition identity", (db: Db, data: ReturnType<typeof setup>) => {
      const other = createFormDefinition(db, data.organizer, { name: "Other identity rule" });
      db.exec("DROP TRIGGER trg_cfp_rule_versions_immutable");
      db.prepare("UPDATE rule_versions SET form_definition_id = ? WHERE id = ?").run(other.id, data.form.ruleVersionId);
      db.exec(DDL);
    }, "SUBMISSION_PIN_MISMATCH"],
  ] as const)("rejects a stored %s at the form/rule read boundary", (_name, mutate, code) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      mutate(db, data);
      expect(() => readCall(db, data.northstar.id, data.call.id)).toThrowError(
        expect.objectContaining({ code }),
      );
    } finally {
      closeDb(db);
    }
  });

  it("rejects invalid session revocation tuples and preserves the one-way revocation guard", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES ('schema-verification', ?, ?, 'schema@synthetic.example', ?, ?, ?)`,
      ).run(data.northstar.id, data.call.id, "c".repeat(64), "2099-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES ('schema-consumption', ?, 'schema-verification', 'schema-person', ?)`,
      ).run(data.northstar.id, "2026-08-10T00:00:00.000Z");
      expect(() =>
        db.prepare(
          `INSERT INTO cfp_applicant_sessions
             (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at,
              revoked_at, revoked_by, revoked_reason)
           VALUES ('bad-session', ?, ?, 'schema-person', 'schema-verification', ?, ?, ?, ?, NULL, NULL)`,
        ).run(
          data.northstar.id,
          data.call.id,
          "d".repeat(64),
          "2026-08-10T00:00:00.000Z",
          "2099-08-10T00:00:00.000Z",
          "2026-08-10T01:00:00.000Z",
        ),
      ).toThrow();
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
         VALUES ('good-session', ?, ?, 'schema-person', 'schema-verification', ?, ?, ?)`,
      ).run(data.northstar.id, data.call.id, "e".repeat(64), "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
      db.prepare(
        `UPDATE cfp_applicant_sessions
         SET revoked_at = ?, revoked_by = ?, revoked_reason = ?
         WHERE id = 'good-session'`,
      ).run("2026-08-10T02:00:00.000Z", data.northstar.accountId, "synthetic test");
      expect(() =>
        db.prepare("UPDATE cfp_applicant_sessions SET revoked_at = NULL, revoked_by = NULL, revoked_reason = NULL WHERE id = 'good-session'").run(),
      ).toThrow(/core fields are immutable/);
    } finally {
      closeDb(db);
    }
  });

  it("rejects every partial revocation tuple on insert and update and keeps session IDs immutable", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES ('tuple-verification', ?, ?, 'schema@synthetic.example', ?, ?, ?)`,
      ).run(data.northstar.id, data.call.id, "c".repeat(64), "2099-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES ('tuple-consumption', ?, 'tuple-verification', 'schema-person', ?)`,
      ).run(data.northstar.id, "2026-08-10T00:00:00.000Z");
      const partialTuples: ReadonlyArray<readonly [string | null, string | null, string | null]> = [
         ["2026-08-10T01:00:00.000Z", null, null],
         [null, data.northstar.accountId, null],
         [null, data.northstar.accountId, "missing-revocation-time"],
         [null, null, "reason-only"],
        ["2026-08-10T01:00:00.000Z", data.northstar.accountId, null],
        ["2026-08-10T01:00:00.000Z", null, "missing-actor"],
        ["2026-08-10T01:00:00.000Z", data.northstar.accountId, ""],
      ] as const;
      for (const [index, [revokedAt, revokedBy, revokedReason]] of partialTuples.entries()) {
        expect(() => db.prepare(
          `INSERT INTO cfp_applicant_sessions
             (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at,
              revoked_at, revoked_by, revoked_reason)
           VALUES (?, ?, ?, 'schema-person', 'tuple-verification', ?, ?, ?, ?, ?, ?)`,
        ).run(
          `bad-tuple-${index}`,
          data.northstar.id,
          data.call.id,
          "d".repeat(64),
          "2026-08-10T00:00:00.000Z",
          "2099-08-10T00:00:00.000Z",
          revokedAt,
          revokedBy,
          revokedReason,
        )).toThrow();
      }
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
         VALUES ('tuple-good', ?, ?, 'schema-person', 'tuple-verification', ?, ?, ?)`,
      ).run(data.northstar.id, data.call.id, "e".repeat(64), "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
      for (const [revokedAt, revokedBy, revokedReason] of partialTuples) {
        expect(() => db.prepare(
          `UPDATE cfp_applicant_sessions
           SET revoked_at = ?, revoked_by = ?, revoked_reason = ?
           WHERE id = 'tuple-good'`,
        ).run(revokedAt, revokedBy, revokedReason)).toThrow();
        expect(db.prepare(
          "SELECT revoked_at, revoked_by, revoked_reason FROM cfp_applicant_sessions WHERE id = 'tuple-good'",
        ).get()).toEqual({ revoked_at: null, revoked_by: null, revoked_reason: null });
      }
      expect(() => db.prepare("UPDATE cfp_applicant_sessions SET id = 'tuple-moved' WHERE id = 'tuple-good'").run()).toThrow(
        /core fields are immutable/,
      );
    } finally {
      closeDb(db);
    }
  });

  it("derives draft pins from the active session and call rather than request fields", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      const verificationId = "draft-verification";
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(verificationId, data.northstar.id, data.call.id, "schema@synthetic.example", "f".repeat(64), "2099-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("draft-consumption", data.northstar.id, verificationId, "schema-person", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("draft-session", data.northstar.id, data.call.id, "schema-person", verificationId, "1".repeat(64), "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
      const draft = createDraftSubmission(
        db,
        { workspaceId: data.northstar.id, sessionId: "draft-session" },
        { callId: data.call.id },
      );
      expect(draft.pinnedFormVersionId).toBe(data.form.id);
      expect(draft.pinnedRuleVersionId).toBe(data.form.ruleVersionId);
      const beforeForbidden = db.prepare("SELECT COUNT(*) AS count FROM submissions").get();
      expect(() => createDraftSubmission(
        db,
        { workspaceId: data.northstar.id, sessionId: "draft-session" },
        {
          callId: data.call.id,
          pinnedFormVersionId: "caller-form",
          pinnedRuleVersionId: "caller-rule",
          state: "SUBMITTED",
        } as never,
      )).toThrowError(expect.objectContaining({ code: "PERSISTENCE_INPUT_INVALID" }));
      expect(db.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual(beforeForbidden);
      expect(db.prepare("SELECT state, current_revision_id FROM submissions WHERE id = ?").get(draft.id)).toEqual({
        state: "DRAFT",
        current_revision_id: null,
      });
    } finally {
      closeDb(db);
    }
  });

  it("keeps call and submission identities and creation times immutable at the SQL boundary", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      const verificationId = "immutable-verification";
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(verificationId, data.northstar.id, data.call.id, "schema@synthetic.example", "9".repeat(64), "2099-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("immutable-consumption", data.northstar.id, verificationId, "schema-person", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("immutable-session", data.northstar.id, data.call.id, "schema-person", verificationId, "8".repeat(64), "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
      const draft = createDraftSubmission(db, { workspaceId: data.northstar.id, sessionId: "immutable-session" }, { callId: data.call.id });
      expect(() => db.prepare("UPDATE calls SET id = 'moved-call' WHERE id = ?").run(data.call.id)).toThrow(
        /calls workspace mismatch/,
      );
      expect(() => db.prepare("UPDATE calls SET created_at = ? WHERE id = ?").run("2026-08-11T00:00:00.000Z", data.call.id)).toThrow(
        /calls workspace mismatch/,
      );
      expect(() => db.prepare("UPDATE submissions SET id = 'moved-submission' WHERE id = ?").run(draft.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      expect(() => db.prepare("UPDATE submissions SET created_at = ? WHERE id = ?").run("2026-08-11T00:00:00.000Z", draft.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      expect(() => db.prepare("DELETE FROM submissions WHERE id = ?").run(draft.id)).toThrow(
        /submissions is retained for history/,
      );
    } finally {
      closeDb(db);
    }
  });

  it("stores non-default call access/state/window values and rejects event re-homing", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      db.prepare(
        `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
         VALUES ('schema-other-event', ?, 'Other event', 'UTC', ?, ?, ?)`,
      ).run(
        data.northstar.id,
        "2026-10-15T09:00:00.000Z",
        "2026-10-15T10:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      );
      const call = createCall(db, data.organizer, {
        eventId: "schema-event",
        name: "Non-default call",
        slug: "non-default-call",
        formVersionId: data.form.id,
        accessMode: "PUBLIC_AND_INVITED",
        state: "OPEN",
        timezone: "Europe/Berlin",
        opensAt: "2026-09-15T09:00:00.000Z",
        closesAt: "2026-09-15T10:00:00.000Z",
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
      expect(readCall(db, data.northstar.id, call.id)).toMatchObject({
        accessMode: "PUBLIC_AND_INVITED",
        state: "OPEN",
        timezone: "Europe/Berlin",
        opensAt: "2026-09-15T09:00:00.000Z",
        closesAt: "2026-09-15T10:00:00.000Z",
      });
      expect(() => db.prepare("UPDATE calls SET event_id = 'schema-other-event' WHERE id = ?").run(call.id)).toThrow(
        /calls workspace mismatch/,
      );
      expect(db.prepare("SELECT event_id FROM calls WHERE id = ?").get(call.id)).toEqual({ event_id: "schema-event" });
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["non-timestamp", "not-a-timestamp"],
    ["empty", ""],
  ] as const)("rejects advancing a call to a form whose seal evidence is %s", (_name, sealedAt) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      const next = sealFormVersion(db, data.organizer, {
        formDefinitionId: data.definition.id,
        fields: [{ id: "consent", type: "consent", label: "Consent next", required: false, defaultVisibility: "visible" }],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      db.exec("DROP TRIGGER trg_cfp_form_versions_immutable");
      if (sealedAt.length === 0) {
        db.exec("PRAGMA ignore_check_constraints = ON");
      }
      db.prepare("UPDATE form_versions SET sealed_at = ? WHERE id = ?").run(sealedAt, next.id);
      if (sealedAt.length === 0) {
        db.exec("PRAGMA ignore_check_constraints = OFF");
      }
      db.exec(DDL);
      expect(() => advanceCallFormVersion(db, data.organizer, {
        callId: data.call.id,
        expectedFormVersionId: data.form.id,
        nextFormVersionId: next.id,
      })).toThrowError(expect.objectContaining({ code: "FORM_ARTIFACT_MIRROR_MISMATCH" }));
      expect(readCall(db, data.northstar.id, data.call.id).formVersionId).toBe(data.form.id);
    } finally {
      closeDb(db);
    }
  });

  it("rejects stored form-definition, form-version, and rule workspace identity tampering", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      db.exec("DROP TRIGGER trg_cfp_form_definitions_identity_immutable");
      db.prepare("UPDATE form_definitions SET workspace_id = ? WHERE id = ?").run(data.acme.id, data.definition.id);
      db.exec(DDL);
      expect(() => readCall(db, data.northstar.id, data.call.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_PIN_MISMATCH" }),
      );

      db.exec("DROP TRIGGER trg_cfp_form_definitions_identity_immutable");
      db.prepare("UPDATE form_definitions SET workspace_id = ? WHERE id = ?").run(data.northstar.id, data.definition.id);
      db.exec(DDL);
      db.exec("DROP TRIGGER trg_cfp_rule_versions_immutable");
      db.prepare("UPDATE rule_versions SET workspace_id = ? WHERE id = ?").run(data.acme.id, data.form.ruleVersionId);
      db.exec(DDL);
      expect(() => readCall(db, data.northstar.id, data.call.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_PIN_MISMATCH" }),
      );

      db.exec("DROP TRIGGER trg_cfp_rule_versions_immutable");
      db.prepare("UPDATE rule_versions SET workspace_id = ? WHERE id = ?").run(data.northstar.id, data.form.ruleVersionId);
      db.exec(DDL);
      db.exec("DROP TRIGGER trg_cfp_form_versions_immutable");
      db.prepare("UPDATE form_versions SET workspace_id = ? WHERE id = ?").run(data.acme.id, data.form.id);
      db.exec(DDL);
      expect(() => readCall(db, data.northstar.id, data.call.id)).toThrowError(
        expect.objectContaining({ code: "FORM_VERSION_NOT_FOUND" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it("enforces immutability on all seven review tables", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'schema-event', ?, 'Round 1', ?, ?)`
      ).run(data.northstar.id, data.call.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, ?)`
      ).run(data.northstar.id, "1".repeat(64), data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      expect(() => db.prepare("UPDATE review_rounds SET name = 'Renamed' WHERE id = 'r1'").run()).toThrow(/review_rounds is immutable/);
      expect(() => db.prepare("DELETE FROM review_rounds WHERE id = 'r1'").run()).toThrow(/review_rounds is retained for history/);

      expect(() => db.prepare("UPDATE review_round_states SET state = 'OPEN' WHERE id = 'review-round-state-initial:r1'").run()).toThrow(/review_round_states is immutable/);
      expect(() => db.prepare("DELETE FROM review_round_states WHERE id = 'review-round-state-initial:r1'").run()).toThrow(/review_round_states is retained for history/);

      expect(() => db.prepare("UPDATE rubric_versions SET rubric_json = '[]' WHERE id = 'rub1'").run()).toThrow(/rubric_versions is immutable/);
      expect(() => db.prepare("DELETE FROM rubric_versions WHERE id = 'rub1'").run()).toThrow(/rubric_versions is immutable/);
    } finally {
      closeDb(db);
    }
  });

  it("enforces state machine transitions and contiguity on review rounds and assignments", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'schema-event', ?, 'Round 1', ?, ?)`
      ).run(data.northstar.id, data.call.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      // Invalid seq 1 state (must be DRAFT)
      expect(() =>
        db.prepare(
          `INSERT INTO review_round_states (id, workspace_id, round_id, state, sequence_number, actor_account_id, created_at)
           VALUES ('rs-bad', ?, 'r1', 'OPEN', 1, ?, ?)`
        ).run(data.northstar.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z")
      ).toThrow(/review_round_states workspace or state transition mismatch/);

      expect(db.prepare("SELECT state, sequence_number FROM review_round_states WHERE round_id = 'r1'").get()).toEqual({
        state: "DRAFT",
        sequence_number: 1,
      });

      // Invalid transition DRAFT -> CLOSED (must be OPEN or CANCELLED)
      expect(() =>
        db.prepare(
          `INSERT INTO review_round_states (id, workspace_id, round_id, state, sequence_number, actor_account_id, created_at)
           VALUES ('rs2-bad', ?, 'r1', 'CLOSED', 2, ?, ?)`
        ).run(data.northstar.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z")
      ).toThrow(/review_round_states workspace or state transition mismatch/);

      // Valid DRAFT -> OPEN
      db.prepare(
        `INSERT INTO review_round_states (id, workspace_id, round_id, state, sequence_number, actor_account_id, created_at)
         VALUES ('rs2', ?, 'r1', 'OPEN', 2, ?, ?)`
      ).run(data.northstar.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      // Valid OPEN -> CLOSED
      db.prepare(
        `INSERT INTO review_round_states (id, workspace_id, round_id, state, sequence_number, actor_account_id, created_at)
         VALUES ('rs3', ?, 'r1', 'CLOSED', 3, ?, ?)`
      ).run(data.northstar.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      // Invalid transition from terminal CLOSED
      expect(() =>
        db.prepare(
          `INSERT INTO review_round_states (id, workspace_id, round_id, state, sequence_number, actor_account_id, created_at)
           VALUES ('rs4-bad', ?, 'r1', 'OPEN', 4, ?, ?)`
        ).run(data.northstar.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z")
      ).toThrow(/review_round_states workspace or state transition mismatch/);
    } finally {
      closeDb(db);
    }
  });

  it("enforces single successor non-branching on replacement review assignments", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, created_at)
         VALUES ('rev1', ?, 'rev1@synthetic.example', 'Rev 1', ?)`
      ).run(data.northstar.id, "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, created_at)
         VALUES ('rev2', ?, 'rev2@synthetic.example', 'Rev 2', ?)`
      ).run(data.northstar.id, "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, created_at)
         VALUES ('rev3', ?, 'rev3@synthetic.example', 'Rev 3', ?)`
      ).run(data.northstar.id, "2026-08-10T00:00:00.000Z");

      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'schema-event', ?, 'Round 1', ?, ?)`
      ).run(data.northstar.id, data.call.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, ?)`
      ).run(data.northstar.id, "1".repeat(64), data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      const verificationId = "branch-verification";
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(verificationId, data.northstar.id, data.call.id, "schema@synthetic.example", "a".repeat(64), "2099-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run("branch-consumption", data.northstar.id, verificationId, "schema-person", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("branch-session", data.northstar.id, data.call.id, "schema-person", verificationId, "b".repeat(64), "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
      const sub = createDraftSubmission(db, { workspaceId: data.northstar.id, sessionId: "branch-session" }, { callId: data.call.id });
      const rev = saveDraftRevision(db, { workspaceId: data.northstar.id, sessionId: "branch-session" }, {
        submissionId: sub.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });

      // Original assignment
      db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a1', ?, 'r1', 'rub1', ?, ?, 'rev1', ?, ?)`
      ).run(data.northstar.id, sub.id, rev.revisionId, data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      db.prepare(
        `INSERT INTO review_assignment_states (id, workspace_id, assignment_id, state, sequence_number, actor_account_id, created_at)
         VALUES ('as1-2', ?, 'a1', 'REVOKED', 2, ?, ?)`
      ).run(data.northstar.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      // First replacement succeeds
      db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, supersedes_assignment_id, created_at)
         VALUES ('a2', ?, 'r1', 'rub1', ?, ?, 'rev2', ?, 'a1', ?)`
      ).run(data.northstar.id, sub.id, rev.revisionId, data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      // Second replacement attempting to supersede 'a1' again fails due to UNIQUE constraint
      expect(() =>
        db.prepare(
          `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, supersedes_assignment_id, created_at)
           VALUES ('a3-bad', ?, 'r1', 'rub1', ?, ?, 'rev3', ?, 'a1', ?)`
        ).run(data.northstar.id, sub.id, rev.revisionId, data.northstar.accountId, "2026-08-10T00:00:00.000Z")
      ).toThrow();
    } finally {
      closeDb(db);
    }
  });

  it("rejects review revisions with mismatched repeated assignment tuple bindings", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setup(db);
      db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, created_at)
         VALUES ('rev1', ?, 'rev1@synthetic.example', 'Rev 1', ?)`
      ).run(data.northstar.id, "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES ('r1', ?, 'schema-event', ?, 'Round 1', ?, ?)`
      ).run(data.northstar.id, data.call.id, data.northstar.accountId, "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema, rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES ('rub1', ?, 'r1', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, ?)`
      ).run(data.northstar.id, "1".repeat(64), data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      const verificationId = "rev-verification";
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(verificationId, data.northstar.id, data.call.id, "schema@synthetic.example", "a".repeat(64), "2099-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run("rev-consumption", data.northstar.id, verificationId, "schema-person", "2026-08-10T00:00:00.000Z");
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("rev-session", data.northstar.id, data.call.id, "schema-person", verificationId, "b".repeat(64), "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
      const sub = createDraftSubmission(db, { workspaceId: data.northstar.id, sessionId: "rev-session" }, { callId: data.call.id });
      const rev = saveDraftRevision(db, { workspaceId: data.northstar.id, sessionId: "rev-session" }, {
        submissionId: sub.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });

      db.prepare(
        `INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id, submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
         VALUES ('a1', ?, 'r1', 'rub1', ?, ?, 'rev1', ?, ?)`
      ).run(data.northstar.id, sub.id, rev.revisionId, data.northstar.accountId, "2026-08-10T00:00:00.000Z");

      // Mismatched submission_revision_id
      expect(() =>
        db.prepare(
          `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
           VALUES ('rev-row1', ?, 'a1', 'r1', 'rub1', ?, 'wrong-revision-id', 1, 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', ?, ?)`
        ).run(data.northstar.id, sub.id, "2".repeat(64), "2026-08-10T00:00:00.000Z")
      ).toThrow(/review_revisions workspace, tuple binding, or sequence mismatch/);

      // Valid matching tuple insert succeeds
      db.prepare(
        `INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema, evaluation_json, fingerprint_algorithm, fingerprint, created_at)
         VALUES ('rev-row1', ?, 'a1', 'r1', 'rub1', ?, ?, 1, 'cfp-review-evaluation/v1', '{}', 'sha256-canonical-json-v1', ?, ?)`
      ).run(data.northstar.id, sub.id, rev.revisionId, "2".repeat(64), "2026-08-10T00:00:00.000Z");
    } finally {
      closeDb(db);
    }
  });

  it("keeps historical PD-01 revisions bound by identity, freezes lineage, and binds guidance exactly", () => {
    const path = ".tmp/unit/pd01-historical-revisions.db";
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    let db = openDb({ path });
    try {
      const data = setupPd01Submission(db);
      const r1 = data.revision;
      const savedR2 = saveDraftRevision(db, { workspaceId: data.northstar.id, sessionId: "pd01-session" }, {
        submissionId: data.submissionId,
        historicalAnswers: [],
        expectedCurrentRevisionId: r1.id,
      });
      const r2 = { ...savedR2.revision, id: savedR2.revisionId };
      db.prepare(`INSERT INTO proposal_lineages
        (id, workspace_id, originating_submission_id, originating_submission_revision_id,
         display_projection_json, created_by_account_id, created_at)
        VALUES ('lineage-historical', ?, ?, ?, '{}', ?, ?)`)
        .run(data.northstar.id, data.submissionId, r1.id, data.northstar.accountId, "2026-08-10T05:00:00.000Z");
      db.prepare("UPDATE submissions SET lineage_id = 'lineage-historical' WHERE id = ?").run(data.submissionId);
      expect(db.prepare("SELECT current_revision_id FROM submissions WHERE id = ?").get(data.submissionId)).toEqual({ current_revision_id: r2.id });
      expect(() => db.prepare("UPDATE submissions SET lineage_id = NULL WHERE id = ?").run(data.submissionId)).toThrow(/write-once/);
      db.prepare(`INSERT INTO proposal_lineages
        (id, workspace_id, originating_submission_id, originating_submission_revision_id,
         display_projection_json, created_by_account_id, created_at)
        VALUES ('lineage-replacement', ?, ?, ?, '{}', ?, ?)`)
        .run(data.northstar.id, data.submissionId, r2.id, data.northstar.accountId, "2026-08-10T05:00:30.000Z");
      expect(() => db.prepare("UPDATE submissions SET lineage_id = 'lineage-replacement' WHERE id = ?")
        .run(data.submissionId)).toThrow(/write-once/);
      expect(() => db.prepare("UPDATE proposal_lineages SET display_projection_json = '{\"changed\":true}' WHERE id = 'lineage-historical'").run()).toThrow(/immutable/);
      expect(() => db.prepare("UPDATE proposal_lineages SET archived_at = ? WHERE id = 'lineage-historical'")
        .run("2026-08-11T00:00:00.000Z")).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM proposal_lineages WHERE id = 'lineage-historical'").run()).toThrow(/immutable/);

      const guidance = {
        schema: "pd01-resubmission-request/v1", workspaceId: data.northstar.id,
        sourceSubmissionId: data.submissionId, sourceSubmissionRevisionId: r1.id,
        targetCallId: data.call.id, guidanceVersion: "g1", guidance: {},
        createdByAccountId: data.northstar.accountId, createdAt: "2026-08-10T05:01:00.000Z", expiresAt: null,
      };
      db.prepare(`INSERT INTO resubmission_requests
        (id, workspace_id, source_submission_id, source_submission_revision_id, target_call_id,
         guidance_version, guidance_json, created_by_account_id, created_at, fingerprint)
        VALUES ('guidance-historical', ?, ?, ?, ?, 'g1', '{}', ?, ?, ?)`)
        .run(data.northstar.id, data.submissionId, r1.id, data.call.id, data.northstar.accountId,
          guidance.createdAt, fingerprintOf(guidance));
      expect(() => db.prepare("UPDATE resubmission_requests SET guidance_version = 'g2' WHERE id = 'guidance-historical'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM resubmission_requests WHERE id = 'guidance-historical'").run()).toThrow(/immutable/);

      const derivation = {
        schema: "pd01-submission-derivation/v1", workspaceId: data.northstar.id,
        relationshipType: "RESUBMISSION_OF", sourceSubmissionId: data.submissionId,
        sourceSubmissionRevisionId: r1.id, targetSubmissionId: null, targetSubmissionRevisionId: null,
        actorAccountId: data.northstar.accountId, reason: "historical guidance", guidanceRequestId: "guidance-historical",
        guidanceReference: null, createdAt: "2026-08-10T05:02:00.000Z",
      };
      db.prepare(`INSERT INTO submission_derivations
        (id, workspace_id, relationship_type, source_submission_id, source_submission_revision_id,
         actor_account_id, reason, guidance_request_id, created_at, fingerprint)
        VALUES ('derivation-historical', ?, 'RESUBMISSION_OF', ?, ?, ?, ?, ?, ?, ?)`)
        .run(data.northstar.id, data.submissionId, r1.id, data.northstar.accountId, derivation.reason,
          "guidance-historical", derivation.createdAt, fingerprintOf(derivation));
      expect(() => db.prepare("UPDATE submission_derivations SET reason = 'retargeted' WHERE id = 'derivation-historical'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM submission_derivations WHERE id = 'derivation-historical'").run()).toThrow(/immutable/);

      const otherSubmission = createDraftSubmission(
        db,
        { workspaceId: data.northstar.id, sessionId: "pd01-session" },
        { callId: data.call.id },
      );
      const otherSaved = saveDraftRevision(
        db,
        { workspaceId: data.northstar.id, sessionId: "pd01-session" },
        { submissionId: otherSubmission.id, historicalAnswers: [], expectedCurrentRevisionId: null },
      );
      const wrongGuidanceDerivation = {
        ...derivation,
        sourceSubmissionId: otherSubmission.id,
        sourceSubmissionRevisionId: otherSaved.revisionId,
      };
      expect(() => db.prepare(`INSERT INTO submission_derivations
        (id, workspace_id, relationship_type, source_submission_id, source_submission_revision_id,
         actor_account_id, reason, guidance_request_id, created_at, fingerprint)
        VALUES ('derivation-wrong-guidance', ?, 'RESUBMISSION_OF', ?, ?, ?, ?, ?, ?, ?)`)
        .run(data.northstar.id, otherSubmission.id, otherSaved.revisionId, data.northstar.accountId, wrongGuidanceDerivation.reason,
          "guidance-historical", wrongGuidanceDerivation.createdAt, fingerprintOf(wrongGuidanceDerivation))).toThrow(/binding/);

      closeDb(db);
      db = openDb({ path, seed: false });
      expect(db.prepare("SELECT source_submission_revision_id FROM resubmission_requests WHERE id = 'guidance-historical'").get())
        .toEqual({ source_submission_revision_id: r1.id });
      expect(db.prepare("SELECT source_submission_revision_id FROM submission_derivations WHERE id = 'derivation-historical'").get())
        .toEqual({ source_submission_revision_id: r1.id });
      expect(db.prepare("SELECT current_revision_id, lineage_id FROM submissions WHERE id = ?").get(data.submissionId))
        .toEqual({ current_revision_id: r2.id, lineage_id: "lineage-historical" });
    } finally {
      closeDb(db);
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    }
  });

  it("allows a pre-current ballot entry, enforces maximum/rank, and finalizes one immutable exact version", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = setupPd01Submission(db);
      const r1 = data.revision;
      const savedR2 = saveDraftRevision(db, { workspaceId: data.northstar.id, sessionId: "pd01-session" }, {
        submissionId: data.submissionId,
        historicalAnswers: [],
        expectedCurrentRevisionId: r1.id,
      });
      const r2Id = savedR2.revisionId;
      const authority = installV9BallotAuthority(db, data, "ballot-set");
      const rootColumns = db.prepare("PRAGMA table_info(recommendation_sets)").all() as Array<{ name: string }>;
      expect(rootColumns.map((column) => column.name)).toContain("reviewer_person_id");
      const contextReference = "selection-context";
      const eligibilityFingerprint = fingerprintOf(authority.eligibility);
      const contextFingerprint = authority.selectionFingerprint;
      db.prepare("INSERT INTO recommendation_sets (id, workspace_id, event_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, created_at) VALUES ('ballot-set', ?, 'schema-event', ?, ?, ?, 'schema-binding', ?)")
        .run(data.northstar.id, data.northstar.accountId, authority.personId, authority.assignmentId, "2026-08-10T06:00:00.000Z");
      db.prepare(`INSERT INTO recommendation_set_versions
        (id, workspace_id, event_id, recommendation_set_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, version_number,
         eligibility_snapshot_json, eligibility_fingerprint, maximum_entries, policy_version_id,
         policy_version_fingerprint, visibility_version_id, visibility_version_fingerprint, blindness_version_id, blindness_version_fingerprint, selection_context_version_id, selection_context_reference, selection_context_fingerprint, created_at)
        VALUES ('ballot-v1', ?, 'schema-event', 'ballot-set', ?, ?, ?, 'schema-binding', 1, ?, ?, 2, 'p1', ?, 'v1', ?, 'b1', ?, 's1', ?, ?, ?) `)
        .run(data.northstar.id, data.northstar.accountId, authority.personId, authority.assignmentId, canonicalJson(authority.eligibility), eligibilityFingerprint, authority.policyFingerprint, authority.visibilityFingerprint, authority.blindnessFingerprint, contextReference, authority.selectionFingerprint, "2026-08-10T06:01:00.000Z");
      db.prepare(`INSERT INTO recommendation_entries
        (id, workspace_id, event_id, recommendation_set_version_id, submission_id, submission_revision_id,
         stance, rank, created_at)
        VALUES ('ballot-entry-1', ?, 'schema-event', 'ballot-v1', ?, ?, 'PROMOTE', 1, ?)`)
        .run(data.northstar.id, data.submissionId, r1.id, "2026-08-10T06:02:00.000Z");
      expect(() => db.prepare(`INSERT INTO recommendation_entries
        (id, workspace_id, event_id, recommendation_set_version_id, submission_id, submission_revision_id,
         stance, created_at)
        VALUES ('ballot-entry-2', ?, 'schema-event', 'ballot-v1', ?, ?, 'OPPOSE', ?)`)
        .run(data.northstar.id, data.submissionId, r2Id, "2026-08-10T06:03:00.000Z")).toThrow(/binding/);

      const contentFingerprint = fingerprintOf({
        schema: "pd01-recommendation-ballot/v1", workspaceId: data.northstar.id, eventId: "schema-event",
        recommendationSetId: "ballot-set", versionNumber: 1, reviewerAccountId: data.northstar.accountId,
        reviewerPersonId: authority.personId, accountPersonBindingId: "schema-binding", eventReviewerAssignmentId: authority.assignmentId,
        eligibilityFingerprint, policyVersionId: "p1", policyVersionFingerprint: authority.policyFingerprint,
        visibilityVersionId: "v1", visibilityVersionFingerprint: authority.visibilityFingerprint,
        blindnessVersionId: "b1", blindnessVersionFingerprint: authority.blindnessFingerprint,
        selectionContextVersionId: "s1", selectionContextReference: contextReference,
        selectionContextFingerprint: contextFingerprint, policyContextSchema: "pd01-advocacy-policy/v1", visibilityContextSchema: "pd01-visibility-snapshot/v1", blindnessContextSchema: "pd01-blindness-policy/v1", selectionContextSchema: "pd01-selection-context/v1", maximumEntries: 2,
        entries: [{ id: "ballot-entry-1", submissionId: data.submissionId, submissionRevisionId: r1.id,
          stance: "PROMOTE", rank: 1, strength: null, rationale: null, followUpWillingness: null, evidence: null }],
      });
      expect(() => db.prepare("UPDATE recommendation_set_versions SET submitted_at = ?, sealed_at = ?, content_fingerprint = NULL WHERE id = 'ballot-v1'")
        .run("2026-08-10T06:04:00.000Z", "2026-08-10T06:05:00.000Z")).toThrow(/finalization/);
      db.prepare("UPDATE recommendation_set_versions SET submitted_at = ?, sealed_at = ?, content_fingerprint = ? WHERE id = 'ballot-v1'")
        .run("2026-08-10T06:04:00.000Z", "2026-08-10T06:05:00.000Z", contentFingerprint);
      expect(() => db.prepare("UPDATE recommendation_entries SET rank = 2 WHERE id = 'ballot-entry-1'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM recommendation_entries WHERE id = 'ballot-entry-1'").run()).toThrow(/immutable/);
      expect(() => db.prepare("UPDATE recommendation_set_versions SET selection_context_reference = 'retargeted' WHERE id = 'ballot-v1'").run()).toThrow(/immutable/);

      const contextReference2 = "selection-context";
      const contextFingerprint2 = fingerprintOf({
        schema: "pd01-selection-context/v1", workspaceId: data.northstar.id, eventId: "schema-event",
        recommendationSetId: "ballot-set", reviewerAccountId: data.northstar.accountId, reference: contextReference2,
      });
      expect(() => db.prepare(`INSERT INTO recommendation_set_versions
        (id, workspace_id, event_id, recommendation_set_id, reviewer_account_id, version_number,
         eligibility_snapshot_json, eligibility_fingerprint, maximum_entries, policy_version_id,
         visibility_version_id, blindness_version_id, selection_context_reference,
         selection_context_fingerprint, content_fingerprint, created_at, submitted_at, sealed_at)
        VALUES ('ballot-v2-direct-final', ?, 'schema-event', 'ballot-set', ?, 2, '{}', ?, 2,
          'p2', 'v2', 'b2', ?, ?, ?, ?, ?, ?)`)
        .run(data.northstar.id, data.northstar.accountId, eligibilityFingerprint, contextReference2,
          contextFingerprint2, "a".repeat(64), "2026-08-10T06:06:00.000Z",
          "2026-08-10T06:07:00.000Z", "2026-08-10T06:08:00.000Z")).toThrow(/binding/);
      db.prepare(`INSERT INTO recommendation_set_versions
        (id, workspace_id, event_id, recommendation_set_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, version_number,
         eligibility_snapshot_json, eligibility_fingerprint, maximum_entries, policy_version_id, policy_version_fingerprint,
         visibility_version_id, visibility_version_fingerprint, blindness_version_id, blindness_version_fingerprint, selection_context_version_id, selection_context_reference,
         selection_context_fingerprint, created_at)
        VALUES ('ballot-v2', ?, 'schema-event', 'ballot-set', ?, ?, ?, 'schema-binding', 2, ?, ?, 2,
          'p1', ?, 'v1', ?, 'b1', ?, 's1', ?, ?, ?)`)
        .run(data.northstar.id, data.northstar.accountId, authority.personId, authority.assignmentId, canonicalJson(authority.eligibility), eligibilityFingerprint, authority.policyFingerprint,
          authority.visibilityFingerprint, authority.blindnessFingerprint, contextReference2, authority.selectionFingerprint, "2026-08-10T06:06:00.000Z");
      db.prepare(`INSERT INTO recommendation_entries
        (id, workspace_id, event_id, recommendation_set_version_id, submission_id, submission_revision_id,
         stance, rank, created_at)
        VALUES ('ballot-v2-entry-1', ?, 'schema-event', 'ballot-v2', ?, ?, 'PROMOTE', 1, ?)`)
        .run(data.northstar.id, data.submissionId, r1.id, "2026-08-10T06:07:00.000Z");
      expect(() => db.prepare(`INSERT INTO recommendation_entries
        (id, workspace_id, event_id, recommendation_set_version_id, submission_id, submission_revision_id,
         stance, rank, created_at)
        VALUES ('ballot-v2-rank-high', ?, 'schema-event', 'ballot-v2', ?, ?, 'OPPOSE', 3, ?)`)
        .run(data.northstar.id, data.submissionId, r2Id, "2026-08-10T06:08:00.000Z")).toThrow(/binding/);
      expect(() => db.prepare(`INSERT INTO recommendation_entries
        (id, workspace_id, event_id, recommendation_set_version_id, submission_id, submission_revision_id,
         stance, rank, created_at)
        VALUES ('ballot-v2-rank-duplicate', ?, 'schema-event', 'ballot-v2', ?, ?, 'OPPOSE', 1, ?)`)
        .run(data.northstar.id, data.submissionId, r2Id, "2026-08-10T06:08:00.000Z")).toThrow(/binding/);
      const contentFingerprint2 = fingerprintOf({
        schema: "pd01-recommendation-ballot/v1", workspaceId: data.northstar.id, eventId: "schema-event",
        recommendationSetId: "ballot-set", versionNumber: 2, reviewerAccountId: data.northstar.accountId,
        reviewerPersonId: authority.personId, accountPersonBindingId: "schema-binding", eventReviewerAssignmentId: authority.assignmentId,
        eligibilityFingerprint, policyVersionId: "p1", policyVersionFingerprint: authority.policyFingerprint,
        visibilityVersionId: "v1", visibilityVersionFingerprint: authority.visibilityFingerprint,
        blindnessVersionId: "b1", blindnessVersionFingerprint: authority.blindnessFingerprint,
        selectionContextVersionId: "s1", selectionContextReference: contextReference2,
        selectionContextFingerprint: authority.selectionFingerprint, policyContextSchema: "pd01-advocacy-policy/v1", visibilityContextSchema: "pd01-visibility-snapshot/v1", blindnessContextSchema: "pd01-blindness-policy/v1", selectionContextSchema: "pd01-selection-context/v1", maximumEntries: 2,
        entries: [{ id: "ballot-v2-entry-1", submissionId: data.submissionId, submissionRevisionId: r1.id,
          stance: "PROMOTE", rank: 1, strength: null, rationale: null, followUpWillingness: null, evidence: null }],
      });
      db.prepare("UPDATE recommendation_set_versions SET submitted_at = ?, sealed_at = ?, content_fingerprint = ? WHERE id = 'ballot-v2'")
        .run("2026-08-10T06:09:00.000Z", "2026-08-10T06:10:00.000Z", contentFingerprint2);
      expect(() => db.prepare(`INSERT INTO recommendation_entries
        (id, workspace_id, event_id, recommendation_set_version_id, submission_id, submission_revision_id,
         stance, rank, created_at)
        VALUES ('ballot-v2-after-final', ?, 'schema-event', 'ballot-v2', ?, ?, 'OPPOSE', 2, ?)`)
        .run(data.northstar.id, data.submissionId, r2Id, "2026-08-10T06:11:00.000Z")).toThrow(/binding/);

      db.exec(`CREATE TABLE p4_ballot_probe (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        recommendation_set_version_id TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        FOREIGN KEY (workspace_id, event_id, recommendation_set_version_id, content_fingerprint)
          REFERENCES recommendation_set_versions(workspace_id, event_id, id, content_fingerprint)
      ) STRICT`);
      db.prepare("INSERT INTO p4_ballot_probe VALUES ('p4-good', ?, 'schema-event', 'ballot-v2', ?)")
        .run(data.northstar.id, contentFingerprint2);
      expect(() => db.prepare("INSERT INTO p4_ballot_probe VALUES ('p4-wrong', ?, 'schema-event', 'ballot-v2', ?)")
        .run(data.northstar.id, "f".repeat(64))).toThrow(/FOREIGN KEY/);
    } finally {
      closeDb(db);
    }
  });

  it("persists a non-empty finalized ballot across close and reopen", () => {
    const path = ".tmp/unit/pd01-finalized-ballot.db";
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    let db = openDb({ path });
    let dbClosed = true;
    try {
      const data = setupPd01Submission(db);
      const authority = installV9BallotAuthority(db, data, "persist-set");
      db.prepare("INSERT INTO recommendation_sets (id, workspace_id, event_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, created_at) VALUES ('persist-set', ?, 'schema-event', ?, ?, ?, 'schema-binding', ?)")
        .run(data.northstar.id, data.northstar.accountId, authority.personId, authority.assignmentId, "2026-08-10T06:00:00.000Z");
      const contextReference = "selection-context";
      const contextFingerprint = fingerprintOf({
        schema: "pd01-selection-context/v1", workspaceId: data.northstar.id, eventId: "schema-event",
        recommendationSetId: "persist-set", reviewerAccountId: data.northstar.accountId, reference: contextReference,
      });
      db.prepare(`INSERT INTO recommendation_set_versions
        (id, workspace_id, event_id, recommendation_set_id, reviewer_account_id, reviewer_person_id, event_reviewer_assignment_id, account_person_binding_id, version_number,
         eligibility_snapshot_json, eligibility_fingerprint, maximum_entries, policy_version_id, policy_version_fingerprint, visibility_version_id, visibility_version_fingerprint,
         blindness_version_id, blindness_version_fingerprint, selection_context_version_id, selection_context_reference, selection_context_fingerprint, created_at)
        VALUES ('persist-v1', ?, 'schema-event', 'persist-set', ?, ?, ?, 'schema-binding', 1, ?, ?, 2, 'p1', ?, 'v1', ?, 'b1', ?, 's1', ?, ?, ?) `)
        .run(data.northstar.id, data.northstar.accountId, authority.personId, authority.assignmentId, canonicalJson(authority.eligibility), fingerprintOf(authority.eligibility), authority.policyFingerprint, authority.visibilityFingerprint, authority.blindnessFingerprint, contextReference, authority.selectionFingerprint, "2026-08-10T06:01:00.000Z");
      db.prepare(`INSERT INTO recommendation_entries
        (id, workspace_id, event_id, recommendation_set_version_id, submission_id, submission_revision_id,
         stance, rank, rationale, created_at)
        VALUES ('persist-entry', ?, 'schema-event', 'persist-v1', ?, ?, 'PROMOTE', 1, 'persisted rationale', ?)`)
        .run(data.northstar.id, data.submissionId, data.revision.id, "2026-08-10T06:02:00.000Z");
      const contentFingerprint = fingerprintOf({
        schema: "pd01-recommendation-ballot/v1", workspaceId: data.northstar.id, eventId: "schema-event",
        recommendationSetId: "persist-set", versionNumber: 1, reviewerAccountId: data.northstar.accountId,
        reviewerPersonId: authority.personId, accountPersonBindingId: "schema-binding", eventReviewerAssignmentId: authority.assignmentId,
        eligibilityFingerprint: fingerprintOf(authority.eligibility), policyVersionId: "p1", policyVersionFingerprint: authority.policyFingerprint,
        visibilityVersionId: "v1", visibilityVersionFingerprint: authority.visibilityFingerprint, blindnessVersionId: "b1", blindnessVersionFingerprint: authority.blindnessFingerprint,
        selectionContextVersionId: "s1", selectionContextReference: contextReference, selectionContextFingerprint: authority.selectionFingerprint,
        policyContextSchema: "pd01-advocacy-policy/v1", visibilityContextSchema: "pd01-visibility-snapshot/v1", blindnessContextSchema: "pd01-blindness-policy/v1", selectionContextSchema: "pd01-selection-context/v1", maximumEntries: 2,
        entries: [{ id: "persist-entry", submissionId: data.submissionId, submissionRevisionId: data.revision.id,
          stance: "PROMOTE", rank: 1, strength: null, rationale: "persisted rationale", followUpWillingness: null, evidence: null }],
      });
      db.prepare("UPDATE recommendation_set_versions SET submitted_at = ?, sealed_at = ?, content_fingerprint = ? WHERE id = 'persist-v1'")
        .run("2026-08-10T06:04:00.000Z", "2026-08-10T06:05:00.000Z", contentFingerprint);
      closeDb(db);
      db = openDb({ path, seed: false });
      expect(db.prepare("SELECT sealed_at, content_fingerprint FROM recommendation_set_versions WHERE id = 'persist-v1'").get()).toEqual({
        sealed_at: "2026-08-10T06:05:00.000Z", content_fingerprint: contentFingerprint,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM recommendation_entries WHERE recommendation_set_version_id = 'persist-v1'").get()).toEqual({ count: 1 });
      dbClosed = true;
      try { closeDb(db); } catch { /* reopen validation may already close the handle */ }
      const raw = new DatabaseSync(path);
      const entryTrigger = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_recommendation_entries_immutable'").get() as { sql: string };
      const ballotTrigger = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_recommendation_set_versions_finalize_or_immutable'").get() as { sql: string };
      raw.exec("DROP TRIGGER trg_recommendation_entries_immutable");
      raw.exec("DROP TRIGGER trg_recommendation_set_versions_finalize_or_immutable");
      raw.exec("PRAGMA ignore_check_constraints = ON");
      const oversizedRationale = "r".repeat(4097);
      raw.prepare("UPDATE recommendation_entries SET rationale = ? WHERE id = 'persist-entry'").run(oversizedRationale);
      const corruptedFingerprint = fingerprintOf({
        schema: "pd01-recommendation-ballot/v1", workspaceId: data.northstar.id, eventId: "schema-event",
        recommendationSetId: "persist-set", versionNumber: 1, reviewerAccountId: data.northstar.accountId,
        eligibilityFingerprint: fingerprintOf({}), selectionContextReference: contextReference,
        selectionContextFingerprint: contextFingerprint, maximumEntries: 1, policyVersionId: "p1",
        visibilityVersionId: "v1", blindnessVersionId: "b1",
        entries: [{ id: "persist-entry", submissionId: data.submissionId, submissionRevisionId: data.revision.id,
          stance: "PROMOTE", rank: 1, strength: null, rationale: oversizedRationale, followUpWillingness: null, evidence: null }],
      });
      raw.prepare("UPDATE recommendation_set_versions SET content_fingerprint = ? WHERE id = 'persist-v1'").run(corruptedFingerprint);
      raw.exec(entryTrigger.sql);
      raw.exec(ballotTrigger.sql);
      raw.close();
      expect(() => openDb({ path, seed: false })).toThrow(/integrity check/);
    } finally {
      if (!dbClosed) closeDb(db);
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    }
  });

});
