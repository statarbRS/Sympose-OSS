import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb } from "../../src/server/db";
import { DDL } from "../../src/server/schema";

function fixture() {
  const db = openDb({ path: ":memory:", seed: false });
  db.prepare("INSERT INTO workspaces (id,slug,name,created_at) VALUES (?,?,?,?)")
    .run("v9-ws", "v9", "V9", "2026-08-10T00:00:00.000Z");
  db.prepare("INSERT INTO accounts (id,workspace_id,email,display_name,role,created_at) VALUES (?,?,?,?,?,?)")
    .run("v9-account", "v9-ws", "v9@example.test", "V9", "reviewer", "2026-08-10T00:00:00.000Z");
  db.prepare("INSERT INTO people (id,workspace_id,canonical_email,full_name,created_at) VALUES (?,?,?,?,?)")
    .run("v9-person", "v9-ws", "v9@example.test", "V9", "2026-08-10T00:00:00.000Z");
  db.prepare("INSERT INTO events (id,workspace_id,name,timezone,starts_at,ends_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .run("v9-event", "v9-ws", "V9", "UTC", "2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z", "2026-08-10T00:00:00.000Z");
  return db;
}

const V10_T0 = "2026-08-10T00:00:00.000Z";
const V10_T1 = "2026-08-10T00:01:00.000Z";
const V10_T2 = "2026-08-10T00:02:00.000Z";
const V10_T3 = "2026-08-10T00:03:00.000Z";

type Authority = {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly personId: string;
  readonly assignmentId: string;
  readonly bindingId: string;
  readonly contexts: Record<string, { readonly id: string; readonly schema: string; readonly fingerprint: string }>;
};

function installAuthority(db: ReturnType<typeof fixture>, assignmentAt: string, activationAt: string): Authority {
  const binding = {
    schema: "pd01-account-person-binding/v1",
    workspaceId: "v9-ws",
    accountId: "v9-account",
    personId: "v9-person",
    boundByAccountId: "v9-account",
    bindingBasis: "manual",
    createdAt: V10_T0,
  };
  db.prepare("INSERT INTO account_person_bindings (id,workspace_id,account_id,person_id,bound_by_account_id,binding_basis,created_at,fingerprint_algorithm,fingerprint) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("v9-binding", "v9-ws", "v9-account", "v9-person", "v9-account", "manual", binding.createdAt, "sha256-canonical-json-v1", fingerprintOf(binding));
  const assignment = {
    schema: "pd01-event-reviewer-assignment/v1",
    workspaceId: "v9-ws",
    eventId: "v9-event",
    reviewerAccountId: "v9-account",
    reviewerPersonId: "v9-person",
    accountPersonBindingId: "v9-binding",
    assignedByAccountId: "v9-account",
    createdAt: assignmentAt,
  };
  db.prepare("INSERT INTO event_reviewer_assignments (id,workspace_id,event_id,reviewer_account_id,reviewer_person_id,account_person_binding_id,assigned_by_account_id,created_at,fingerprint_algorithm,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("v9-assignment", "v9-ws", "v9-event", "v9-account", "v9-person", "v9-binding", "v9-account", assignmentAt, "sha256-canonical-json-v1", fingerprintOf(assignment));
  db.prepare("INSERT INTO event_reviewer_assignment_states (id,workspace_id,event_id,event_reviewer_assignment_id,state,sequence_number,actor_account_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("v9-state-1", "v9-ws", "v9-event", "v9-assignment", "ACTIVE", 1, "v9-account", activationAt);

  const documents = [
    ["policy", "ADVOCACY_POLICY", { schema: "pd01-advocacy-policy/v1", maximumEntries: 3, eligibleRevisions: [] }],
    ["visibility", "VISIBILITY", { schema: "pd01-visibility-snapshot/v1", visibleRevisions: [] }],
    ["blindness", "BLINDNESS", { schema: "pd01-blindness-policy/v1", disclosureStage: "BLIND_REVIEW", organizerAdvocacyAggregationPermitted: false }],
    ["selection", "SELECTION_CONTEXT", { schema: "pd01-selection-context/v1", decisionBoundary: "v9-boundary", resolvedRevisions: [] }],
  ] as const;
  const contexts: Authority["contexts"] = {};
  for (const [key, kind, document] of documents) {
    const id = `v9-${key}`;
    db.prepare("INSERT INTO review_context_versions (id,workspace_id,event_id,context_kind,version_number,context_schema,context_json,fingerprint_algorithm,fingerprint,issued_by_account_id,issued_at) VALUES (?,?,?,?,1,?,?,?,?,?,?)")
      .run(id, "v9-ws", "v9-event", kind, document.schema, canonicalJson(document), "sha256-canonical-json-v1", fingerprintOf(document), "v9-account", assignmentAt);
    contexts[key] = { id, schema: document.schema, fingerprint: fingerprintOf(document) };
  }
  return { workspaceId: "v9-ws", eventId: "v9-event", accountId: "v9-account", personId: "v9-person", assignmentId: "v9-assignment", bindingId: "v9-binding", contexts };
}

function insertBallot(
  db: ReturnType<typeof fixture>,
  authority: Authority,
  id: string,
  createdAt: string,
  overrides: { readonly blindnessVersionId?: string; readonly blindnessFingerprint?: string } = {},
): { readonly id: string; readonly setId: string; readonly contentFingerprint: string } {
  const setId = `${id}-set`;
  const versionId = `${id}-version`;
  const emptyEligibility = canonicalJson([]);
  db.prepare("INSERT INTO recommendation_sets (id,workspace_id,event_id,reviewer_account_id,reviewer_person_id,event_reviewer_assignment_id,account_person_binding_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(setId, authority.workspaceId, authority.eventId, authority.accountId, authority.personId, authority.assignmentId, authority.bindingId, createdAt);
  db.prepare(`INSERT INTO recommendation_set_versions
    (id,workspace_id,event_id,recommendation_set_id,reviewer_account_id,reviewer_person_id,event_reviewer_assignment_id,account_person_binding_id,version_number,
     eligibility_snapshot_json,eligibility_fingerprint,maximum_entries,policy_version_id,policy_version_fingerprint,visibility_version_id,visibility_version_fingerprint,blindness_version_id,blindness_version_fingerprint,selection_context_version_id,selection_context_reference,selection_context_fingerprint,created_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,3,?,?,?,?,?,?,?,?,?,?)`)
    .run(versionId, authority.workspaceId, authority.eventId, setId, authority.accountId, authority.personId, authority.assignmentId, authority.bindingId,
      emptyEligibility, fingerprintOf([]), authority.contexts.policy.id, authority.contexts.policy.fingerprint,
      authority.contexts.visibility.id, authority.contexts.visibility.fingerprint,
      overrides.blindnessVersionId ?? authority.contexts.blindness.id,
      overrides.blindnessFingerprint ?? authority.contexts.blindness.fingerprint,
      authority.contexts.selection.id, "v9-boundary", authority.contexts.selection.fingerprint, createdAt);
  const contentFingerprint = fingerprintOf({
    schema: "pd01-recommendation-ballot/v1", workspaceId: authority.workspaceId, eventId: authority.eventId,
    recommendationSetId: setId, versionNumber: 1, reviewerAccountId: authority.accountId, reviewerPersonId: authority.personId,
    accountPersonBindingId: authority.bindingId, eventReviewerAssignmentId: authority.assignmentId,
    eligibilityFingerprint: fingerprintOf([]), policyVersionId: authority.contexts.policy.id, policyVersionFingerprint: authority.contexts.policy.fingerprint,
    visibilityVersionId: authority.contexts.visibility.id, visibilityVersionFingerprint: authority.contexts.visibility.fingerprint,
    blindnessVersionId: overrides.blindnessVersionId ?? authority.contexts.blindness.id,
    blindnessVersionFingerprint: overrides.blindnessFingerprint ?? authority.contexts.blindness.fingerprint,
    selectionContextVersionId: authority.contexts.selection.id, selectionContextFingerprint: authority.contexts.selection.fingerprint,
    selectionContextReference: "v9-boundary", policyContextSchema: authority.contexts.policy.schema,
    visibilityContextSchema: authority.contexts.visibility.schema, blindnessContextSchema: authority.contexts.blindness.schema,
    selectionContextSchema: authority.contexts.selection.schema, maximumEntries: 3, entries: [],
  });
  return { id: versionId, setId, contentFingerprint };
}

function finalizeBallot(db: ReturnType<typeof fixture>, ballot: { readonly id: string; readonly contentFingerprint: string }, submittedAt: string, sealedAt: string): void {
  db.prepare("UPDATE recommendation_set_versions SET submitted_at=?,sealed_at=?,content_fingerprint=? WHERE id=?")
    .run(submittedAt, sealedAt, ballot.contentFingerprint, ballot.id);
}

describe("PD-01 identity/context schema on V16", () => {
  it("publishes V16 with non-null authoritative ballot bindings", () => {
    const db = fixture();
    try {
      expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "21" });
      for (const table of ["recommendation_sets", "recommendation_set_versions"]) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
        for (const name of ["reviewer_person_id", "event_reviewer_assignment_id", "account_person_binding_id"]) {
          expect(columns.find((column) => column.name === name)?.notnull).toBe(1);
        }
      }
      const columns = db.prepare("PRAGMA table_info(recommendation_set_versions)").all() as Array<{ name: string; notnull: number }>;
      for (const name of ["policy_version_fingerprint", "visibility_version_fingerprint", "blindness_version_fingerprint", "selection_context_version_id"]) {
        expect(columns.find((column) => column.name === name)?.notnull).toBe(1);
      }
    } finally { closeDb(db); }
  });

  it("scopes identical context fingerprints to distinct events while rejecting same-event no-op versions", () => {
    const db = fixture();
    try {
      const at = "2026-08-10T00:00:00.000Z";
      const document = {
        schema: "pd01-blindness-policy/v1",
        disclosureStage: "BLIND_REVIEW",
        organizerAdvocacyAggregationPermitted: false,
      };
      db.prepare("INSERT INTO events (id,workspace_id,name,timezone,starts_at,ends_at,created_at) VALUES (?,?,?,?,?,?,?)")
        .run("v9-event-2", "v9-ws", "V9 second event", "UTC", "2026-09-02T00:00:00.000Z", "2026-09-02T01:00:00.000Z", at);
      const insertContext = (id: string, eventId: string, versionNumber: number) => db.prepare(
        "INSERT INTO review_context_versions (id,workspace_id,event_id,context_kind,version_number,context_schema,context_json,fingerprint_algorithm,fingerprint,issued_by_account_id,issued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ).run(id, "v9-ws", eventId, "BLINDNESS", versionNumber, document.schema, canonicalJson(document), "sha256-canonical-json-v1", fingerprintOf(document), "v9-account", at);

      insertContext("v9-blind-event-1", "v9-event", 1);
      expect(() => insertContext("v9-blind-event-2", "v9-event-2", 1)).not.toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM review_context_versions WHERE context_kind='BLINDNESS'").get()).toEqual({ n: 2 });
      expect(() => insertContext("v9-blind-no-op", "v9-event", 2)).toThrow();
    } finally { closeDb(db); }
  });

  it("does not let a different context kind satisfy ballot context binding", () => {
    const db = fixture();
    try {
      const authority = installAuthority(db, V10_T0, V10_T0);
      expect(() => insertBallot(db, authority, "kind-mismatch", V10_T0, {
        blindnessVersionId: authority.contexts.visibility.id,
        blindnessFingerprint: authority.contexts.visibility.fingerprint,
      })).toThrow(/binding/);
    } finally { closeDb(db); }
  });

  it("keeps advocacy policy maximumEntries within the inclusive insert domain", () => {
    const db = fixture();
    try {
      const at = "2026-08-10T00:00:00.000Z";
      const insertPolicy = (id: string, version: number, maximumEntries: number) => {
        const document = { schema: "pd01-advocacy-policy/v1", maximumEntries, eligibleRevisions: [] };
        return db.prepare("INSERT INTO review_context_versions (id,workspace_id,event_id,context_kind,version_number,context_schema,context_json,fingerprint_algorithm,fingerprint,issued_by_account_id,issued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, "v9-ws", "v9-event", "ADVOCACY_POLICY", version, document.schema, canonicalJson(document), "sha256-canonical-json-v1", fingerprintOf(document), "v9-account", at);
      };
      insertPolicy("v9-policy-limit", 1, 10000);
      expect(() => insertPolicy("v9-policy-over", 2, 10001)).toThrow(/context/);
      expect(() => insertPolicy("v9-policy-under", 2, 0)).toThrow(/context/);
    } finally { closeDb(db); }
  });

  it("requires canonical exact context shapes and gap-free assignment state roots", () => {
    const db = fixture();
    try {
      const binding = { schema: "pd01-account-person-binding/v1", workspaceId: "v9-ws", accountId: "v9-account", personId: "v9-person", boundByAccountId: "v9-account", bindingBasis: "manual", createdAt: "2026-08-10T00:00:00.000Z" };
      db.prepare("INSERT INTO account_person_bindings (id,workspace_id,account_id,person_id,bound_by_account_id,binding_basis,created_at,fingerprint_algorithm,fingerprint) VALUES (?,?,?,?,?,?,?,?,?)")
        .run("v9-binding", "v9-ws", "v9-account", "v9-person", "v9-account", "manual", binding.createdAt, "sha256-canonical-json-v1", fingerprintOf(binding));
      const assignment = { schema: "pd01-event-reviewer-assignment/v1", workspaceId: "v9-ws", eventId: "v9-event", reviewerAccountId: "v9-account", reviewerPersonId: "v9-person", accountPersonBindingId: "v9-binding", assignedByAccountId: "v9-account", createdAt: binding.createdAt };
      db.prepare("INSERT INTO event_reviewer_assignments (id,workspace_id,event_id,reviewer_account_id,reviewer_person_id,account_person_binding_id,assigned_by_account_id,created_at,fingerprint_algorithm,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run("v9-assignment", "v9-ws", "v9-event", "v9-account", "v9-person", "v9-binding", "v9-account", binding.createdAt, "sha256-canonical-json-v1", fingerprintOf(assignment));
      expect(() => db.prepare("INSERT INTO event_reviewer_assignment_states (id,workspace_id,event_id,event_reviewer_assignment_id,state,sequence_number,actor_account_id,created_at) VALUES (?,?,?,?,?,?,?,?)").run("v9-state-gap", "v9-ws", "v9-event", "v9-assignment", "ACTIVE", 2, "v9-account", binding.createdAt)).toThrow(/sequence/);
      const policy = { schema: "pd01-advocacy-policy/v1", maximumEntries: 1, eligibleRevisions: [] };
      expect(() => db.prepare("INSERT INTO review_context_versions (id,workspace_id,event_id,context_kind,version_number,context_schema,context_json,fingerprint_algorithm,fingerprint,issued_by_account_id,issued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run("v9-policy", "v9-ws", "v9-event", "ADVOCACY_POLICY", 1, policy.schema, JSON.stringify({ ...policy, extra: true }), "sha256-canonical-json-v1", fingerprintOf({ ...policy, extra: true }), "v9-account", binding.createdAt)).toThrow(/context/);
      const insertContext = (id: string, kind: string, document: unknown) => db.prepare("INSERT INTO review_context_versions (id,workspace_id,event_id,context_kind,version_number,context_schema,context_json,fingerprint_algorithm,fingerprint,issued_by_account_id,issued_at) VALUES (?,?,?,?,1,?,?,?,?,?,?)").run(id, "v9-ws", "v9-event", kind, (document as { schema: string }).schema, JSON.stringify(document), "sha256-canonical-json-v1", fingerprintOf(document), "v9-account", binding.createdAt);
      expect(() => insertContext("v9-visible-bad", "VISIBILITY", { schema: "pd01-visibility-snapshot/v1", visibleRevisions: "not-an-array" })).toThrow(/context/);
      expect(() => insertContext("v9-blind-bad", "BLINDNESS", { schema: "pd01-blindness-policy/v1", disclosureStage: "OTHER", organizerAdvocacyAggregationPermitted: false })).toThrow(/context/);
    } finally { closeDb(db); }
  });

  it("keeps identity roots immutable and rejects duplicate or foreign bindings", () => {
    const db = fixture();
    try {
      const at = "2026-08-10T00:00:00.000Z";
      const fp = fingerprintOf({ schema: "pd01-account-person-binding/v1", workspaceId: "v9-ws", accountId: "v9-account", personId: "v9-person", boundByAccountId: "v9-account", bindingBasis: "manual", createdAt: at });
      const insert = (id: string, workspaceId: string, accountId: string, personId: string) => db.prepare("INSERT INTO account_person_bindings (id,workspace_id,account_id,person_id,bound_by_account_id,binding_basis,created_at,fingerprint_algorithm,fingerprint) VALUES (?,?,?,?,?,?,?,?,?)").run(id, workspaceId, accountId, personId, "v9-account", "manual", at, "sha256-canonical-json-v1", fp);
      insert("v9-binding", "v9-ws", "v9-account", "v9-person");
      expect(() => insert("v9-binding-duplicate", "v9-ws", "v9-account", "v9-person-2")).toThrow();
      expect(() => db.prepare("UPDATE account_person_bindings SET binding_basis='email' WHERE id='v9-binding'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM account_person_bindings WHERE id='v9-binding'").run()).toThrow(/immutable/);
      expect(() => insert("v9-foreign", "foreign-ws", "v9-account", "v9-person")).toThrow();
      db.exec("VACUUM");
      expect(db.prepare("SELECT COUNT(*) AS n FROM account_person_bindings").get()).toEqual({ n: 1 });
    } finally { closeDb(db); }
  });

  it("rejects malformed V9 foreign IDs and timestamps immediately, and shares the 256-byte boundary", () => {
    const db = fixture();
    try {
      const at = "2026-08-10T00:00:00.000Z";
      const bindingDocument = { schema: "pd01-account-person-binding/v1", workspaceId: "v9-ws", accountId: "v9-account", personId: "v9-person", boundByAccountId: "v9-account", bindingBasis: "manual", createdAt: at };
      const bindingSql = "INSERT INTO account_person_bindings (id,workspace_id,account_id,person_id,bound_by_account_id,binding_basis,created_at,fingerprint_algorithm,fingerprint) VALUES (?,?,?,?,?,?,?,?,?)";
      expect(() => db.prepare(bindingSql).run("bad\u0000id", "v9-ws", "v9-account", "v9-person", "v9-account", "manual", at, "sha256-canonical-json-v1", fingerprintOf(bindingDocument))).toThrow();
      expect(() => db.prepare(bindingSql).run("bad-long", "v9-ws", "x".repeat(129), "v9-person", "v9-account", "manual", at, "sha256-canonical-json-v1", fingerprintOf(bindingDocument))).toThrow();
      expect(() => db.prepare(bindingSql).run("bad-time", "v9-ws", "v9-account", "v9-person", "v9-account", "manual", "2026-08-10T00:00:00Z", "sha256-canonical-json-v1", fingerprintOf({ ...bindingDocument, createdAt: "2026-08-10T00:00:00Z" }))).toThrow();
      const instantCases = [
        ["valid-leap", "2024-02-29T23:59:59.999Z", true],
        ["bad-24-hour", "2026-01-01T24:00:00.000Z", false],
        ["bad-february", "2026-02-30T00:00:00.000Z", false],
        ["bad-nonleap", "2025-02-29T00:00:00.000Z", false],
        ["bad-second", "2026-01-01T00:00:60.000Z", false],
        ["bad-minute", "2026-01-01T00:60:00.000Z", false],
        ["bad-offset", "2026-01-01T00:00:00.000+00:00", false],
        ["bad-lowercase", "2026-01-01t00:00:00.000z", false],
      ] as const;
      for (const [id, instant, valid] of instantCases) {
        const document = { ...bindingDocument, createdAt: instant };
        const operation = () => db.prepare(bindingSql).run(id, "v9-ws", "v9-account", "v9-person", "v9-account", "manual", instant, "sha256-canonical-json-v1", fingerprintOf(document));
        if (valid) operation(); else expect(operation).toThrow();
      }

      const insertContext = (id: string, boundary: string) => {
        const document = { schema: "pd01-selection-context/v1", decisionBoundary: boundary, resolvedRevisions: [] };
        return db.prepare("INSERT INTO review_context_versions (id,workspace_id,event_id,context_kind,version_number,context_schema,context_json,fingerprint_algorithm,fingerprint,issued_by_account_id,issued_at) VALUES (?,?,?,?,1,?,?,?,?,?,?)")
          .run(id, "v9-ws", "v9-event", "SELECTION_CONTEXT", document.schema, canonicalJson(document), "sha256-canonical-json-v1", fingerprintOf(document), "v9-account", at);
      };
      insertContext("boundary-256", "b".repeat(256));
      expect(() => insertContext("boundary-257", "b".repeat(257))).toThrow();
    } finally { closeDb(db); }
  });

  it("enforces legal chronological assignment transitions and equal-time boundaries", () => {
    const db = fixture();
    try {
      const authority = installAuthority(db, V10_T1, V10_T1);
      const insertState = (id: string, state: string, sequence: number, createdAt: string) => db.prepare("INSERT INTO event_reviewer_assignment_states (id,workspace_id,event_id,event_reviewer_assignment_id,state,sequence_number,actor_account_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, authority.workspaceId, authority.eventId, authority.assignmentId, state, sequence, authority.accountId, createdAt);

      const invalidChronologyDb = fixture();
      try {
        expect(() => installAuthority(invalidChronologyDb, V10_T1, V10_T0)).toThrow(/chronology|transition|sequence/);
      } finally { closeDb(invalidChronologyDb); }
      expect(() => insertState("v9-state-active-again", "ACTIVE", 2, V10_T1)).toThrow(/chronology|transition|sequence/);
      expect(() => insertState("v9-state-revoked-before", "REVOKED", 2, V10_T0)).toThrow(/chronology|transition|sequence/);
      insertState("v9-state-revoked", "REVOKED", 2, V10_T1);
      expect(() => insertState("v9-state-revoked-again", "REVOKED", 3, V10_T2)).toThrow(/chronology|transition|sequence/);
      insertState("v9-state-reactivated", "ACTIVE", 3, V10_T2);
    } finally { closeDb(db); }
  });

  it("requires ACTIVE authority at the canonical seal instant", () => {
    const boundaryDb = fixture();
    try {
      const authority = installAuthority(boundaryDb, V10_T0, V10_T2);
      const ballot = insertBallot(boundaryDb, authority, "boundary", V10_T0);
      expect(() => finalizeBallot(boundaryDb, ballot, V10_T2, V10_T2)).not.toThrow();
    } finally { closeDb(boundaryDb); }

    const futureDb = fixture();
    try {
      const authority = installAuthority(futureDb, V10_T0, V10_T2);
      const ballot = insertBallot(futureDb, authority, "future", V10_T0);
      expect(() => finalizeBallot(futureDb, ballot, V10_T1, V10_T1)).toThrow(/finalization/);
    } finally { closeDb(futureDb); }

    const revokedDb = fixture();
    try {
      const authority = installAuthority(revokedDb, V10_T0, V10_T0);
      revokedDb.prepare("INSERT INTO event_reviewer_assignment_states (id,workspace_id,event_id,event_reviewer_assignment_id,state,sequence_number,actor_account_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run("v9-state-revoked", authority.workspaceId, authority.eventId, authority.assignmentId, "REVOKED", 2, authority.accountId, V10_T2);
      const ballot = insertBallot(revokedDb, authority, "revoked", V10_T0);
      expect(() => finalizeBallot(revokedDb, ballot, V10_T3, V10_T3)).toThrow(/finalization/);
    } finally { closeDb(revokedDb); }
  });

  it("rejects recommendation entries timestamped after a sealed ballot", () => {
    const db = fixture();
    try {
      const authority = installAuthority(db, V10_T0, V10_T0);
      const ballot = insertBallot(db, authority, "after-seal", V10_T0);
      finalizeBallot(db, ballot, V10_T1, V10_T1);
      expect(() => db.prepare(`INSERT INTO recommendation_entries
        (id,workspace_id,event_id,recommendation_set_version_id,submission_id,submission_revision_id,stance,rank,strength,rationale,follow_up_willingness,evidence_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run("after-seal-entry", authority.workspaceId, authority.eventId, ballot.id, "missing-submission", "missing-revision", "PROMOTE", 1, 50, null, null, null, V10_T2))
        .toThrow(/recommendation_entries/);
    } finally { closeDb(db); }
  });

  it.each(["ACTIVE", "REVOKED"] as const)("rejects a foreign-tuple %s row during write-time finalization", (state) => {
    const db = fixture();
    try {
      const authority = installAuthority(db, V10_T0, V10_T0);
      db.prepare("INSERT INTO workspaces (id,slug,name,created_at) VALUES (?,?,?,?)")
        .run(`foreign-${state.toLowerCase()}-ws`, `foreign-${state.toLowerCase()}`, "Foreign", V10_T0);
      db.prepare("INSERT INTO events (id,workspace_id,name,timezone,starts_at,ends_at,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(`foreign-${state.toLowerCase()}-event`, `foreign-${state.toLowerCase()}-ws`, "Foreign", "UTC", "2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z", V10_T0);
      db.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON; DROP TRIGGER trg_event_reviewer_assignment_states_guard;");
      db.prepare("INSERT INTO event_reviewer_assignment_states (id,workspace_id,event_id,event_reviewer_assignment_id,state,sequence_number,actor_account_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(`foreign-${state.toLowerCase()}-state`, `foreign-${state.toLowerCase()}-ws`, `foreign-${state.toLowerCase()}-event`, authority.assignmentId, state, 2, authority.accountId, V10_T1);
      db.exec(DDL);
      db.exec("PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = OFF;");

      const ballot = insertBallot(db, authority, `foreign-${state.toLowerCase()}`, V10_T1);
      expect(() => finalizeBallot(db, ballot, V10_T1, V10_T1)).toThrow(/finalization/);
      expect(db.prepare("SELECT submitted_at, sealed_at FROM recommendation_set_versions WHERE id=?").get(ballot.id))
        .toEqual({ submitted_at: null, sealed_at: null });
    } finally { closeDb(db); }
  });
});
