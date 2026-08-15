import { describe, expect, it, vi } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import { canonicalJson, fingerprintOf, sha256Hex } from "../../src/server/canonical";
import { type SessionInfo } from "../../src/server/auth";
import {
  bindSubmissionToLineage,
  createProposalLineage,
  createSubmissionDerivation,
} from "../../src/server/services/cfp/proposal-lineage";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import { createCall, createDraftSubmission, createFormDefinition, saveDraftRevision, sealFormVersion } from "../../src/server/services/cfp/form-documents";
import {
  INSTITUTIONAL_MEMORY_MAX_ITEMS,
  InstitutionalMemoryError,
  REVIEW_HISTORY_VISIBILITY_POLICY,
  type MemorySourceRecord,
  queryInstitutionalMemory,
} from "../../src/server/services/institutional-memory";

type Fixture = { db: Db; session: SessionInfo; workspaceId: string; accountId: string; personId: string; first: { id: string; revisionId: string }; second: { id: string; revisionId: string }; firstEvent: string; secondEvent: string; lineageId: string };

function fixture(): Fixture {
  const db = openDb({ path: ":memory:" });
  const workspace = db.prepare("SELECT id, name FROM workspaces WHERE slug = 'northstar'").get() as { id: string; name: string };
  const account = db.prepare("SELECT id, email, display_name FROM accounts WHERE workspace_id = ? AND role = 'organizer' LIMIT 1").get(workspace.id) as { id: string; email: string; display_name: string };
  const personId = "memory-person";
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run(personId, workspace.id, "memory@synthetic.example", "Memory Person", "2026-08-10T00:00:00.000Z");
  const events = ["memory-event-one", "memory-event-two"];
  for (const [index, eventId] of events.entries()) {
    db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, 'UTC', ?, ?, ?)")
      .run(eventId, workspace.id, `Memory event ${index + 1}`, `2026-0${index + 1}-15T09:00:00.000Z`, `2026-0${index + 1}-15T10:00:00.000Z`, "2026-08-10T00:00:00.000Z");
  }
  const definition = createFormDefinition(db, { workspaceId: workspace.id, accountId: account.id }, { name: "memory form" });
  const form = sealFormVersion(db, { workspaceId: workspace.id, accountId: account.id }, {
    formDefinitionId: definition.id,
    fields: [{ id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" }],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const calls = events.map((eventId, index) => createCall(db, { workspaceId: workspace.id, accountId: account.id }, {
    eventId, name: `Memory call ${index + 1}`, slug: `memory-call-${index + 1}`, formVersionId: form.id,
    policy: { disclosure: { privacy: "p", retention: "r", aiProcessing: "a", communication: "c", consent: "c", publication: "p" }, choices: [] },
  }));
  const session: SessionInfo = {
    id: "memory-session", tokenHash: "memory-token-hash", accountId: account.id, workspaceId: workspace.id,
    expiresAt: "2099-01-01T00:00:00.000Z", email: account.email, displayName: account.display_name,
    role: "organizer", workspaceSlug: "northstar", workspaceName: workspace.name,
  };
  db.prepare("INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(session.id, session.tokenHash, session.accountId, session.workspaceId, "2026-08-10T00:00:00.000Z", session.expiresAt);
  const submissions = calls.map((call, index) => {
    const verificationId = `memory-verification-${index}`;
    const sessionId = `memory-applicant-session-${index}`;
    db.prepare(`INSERT INTO cfp_email_verifications (id, workspace_id, call_id, email, token_hash, expires_at, created_at, issuance_sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(verificationId, workspace.id, call.id, "memory@synthetic.example", sha256Hex(verificationId), "2099-01-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
    db.prepare("INSERT INTO cfp_email_verification_consumptions (id, workspace_id, verification_id, person_id, consumed_at) VALUES (?, ?, ?, ?, ?)")
      .run(`${verificationId}-consumption`, workspace.id, verificationId, personId, "2026-08-10T00:00:00.000Z");
    db.prepare("INSERT INTO cfp_applicant_sessions (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, workspace.id, call.id, personId, verificationId, "a".repeat(64), "2026-08-10T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
    const created = createDraftSubmission(db, { workspaceId: workspace.id, sessionId }, { callId: call.id });
    const revision = saveDraftRevision(db, { workspaceId: workspace.id, sessionId }, { submissionId: created.id, historicalAnswers: [{ fieldId: "consent", value: index === 0 }], expectedCurrentRevisionId: null });
    return { id: created.id, revisionId: revision.revisionId };
  });
  const actor = { workspaceId: workspace.id, workspaceSlug: "northstar", accountId: account.id, role: "organizer" as const };
  const lineage = createProposalLineage(db, actor, { workspaceSlug: "northstar", submissionId: submissions[0]!.id, submissionRevisionId: submissions[0]!.revisionId, displayProjection: { title: "Historical" }, idempotencyKey: "memory-lineage" });
  bindSubmissionToLineage(db, actor, { workspaceSlug: "northstar", submissionId: submissions[0]!.id, lineageId: lineage.lineageId, expectedLineageId: null, idempotencyKey: "memory-bind" });
  createSubmissionDerivation(db, actor, { workspaceSlug: "northstar", relationshipType: "RESUBMISSION_OF", sourceSubmissionId: submissions[0]!.id, sourceSubmissionRevisionId: submissions[0]!.revisionId, targetSubmissionId: submissions[1]!.id, targetSubmissionRevisionId: submissions[1]!.revisionId, reason: "explicit resubmission", idempotencyKey: "memory-derivation" });
  return { db, session, workspaceId: workspace.id, accountId: account.id, personId, first: submissions[0]!, second: submissions[1]!, firstEvent: events[0]!, secondEvent: events[1]!, lineageId: lineage.lineageId };
}

function addReviewRevisions(data: Fixture): void {
  const call = data.db.prepare("SELECT call_id FROM submissions WHERE id = ?").get(data.first.id) as { call_id: string };
  const reviewerId = "memory-reviewer";
  data.db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, 'reviewer', ?)")
    .run(reviewerId, data.workspaceId, "memory-reviewer@synthetic.example", "Memory Reviewer", "2026-08-10T00:00:00.000Z");
  data.db.prepare("INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("memory-round", data.workspaceId, data.firstEvent, call.call_id, "Memory round", data.accountId, "2026-08-11T00:00:00.000Z");
  data.db.prepare(`INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema,
    rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
    VALUES (?, ?, ?, 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, ?)`)
    .run("memory-rubric", data.workspaceId, "memory-round", "a".repeat(64), data.accountId, "2026-08-11T00:00:01.000Z");
  data.db.prepare(`INSERT INTO review_assignments (id, workspace_id, round_id, rubric_version_id,
    submission_id, submission_revision_id, reviewer_account_id, assigned_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("memory-assignment", data.workspaceId, "memory-round", "memory-rubric", data.first.id,
      data.first.revisionId, reviewerId, data.accountId, "2026-08-11T00:00:02.000Z");
  for (const revisionNumber of [1, 2]) {
    const evaluation = { schema: "cfp-review-evaluation/v1", assignmentId: "memory-assignment",
      rubricVersionId: "memory-rubric", submissionRevisionId: data.first.revisionId,
      reviewRevisionNumber: revisionNumber, responses: [] };
    const reviewId = `memory-review-${revisionNumber}`;
    const createdAt = `2026-08-11T00:00:0${revisionNumber + 2}.000Z`;
    data.db.prepare(`INSERT INTO review_revisions (id, workspace_id, assignment_id, round_id,
      rubric_version_id, submission_id, submission_revision_id, revision_number, evaluation_schema,
      evaluation_json, fingerprint_algorithm, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cfp-review-evaluation/v1', ?,
        'sha256-canonical-json-v1', ?, ?)`)
      .run(reviewId, data.workspaceId, "memory-assignment", "memory-round",
        "memory-rubric", data.first.id, data.first.revisionId, revisionNumber,
        canonicalJson(evaluation), fingerprintOf(evaluation), createdAt);
    const receipt = { schema: "cfp-review-command-receipt/v1", workspaceId: data.workspaceId,
      assignmentId: "memory-assignment", roundId: "memory-round", rubricVersionId: "memory-rubric",
      submissionRevisionId: data.first.revisionId, actorAccountId: reviewerId, commandKind: "SAVE_REVIEW",
      effectId: reviewId, createdAt, outcome: { reviewRevisionId: reviewId, reviewRevisionNumber: revisionNumber } };
    data.db.prepare(`INSERT INTO review_command_receipts
      (id, workspace_id, assignment_id, round_id, rubric_version_id, submission_revision_id,
       actor_account_id, command_kind, idempotency_key, request_schema, request_fingerprint_algorithm,
       request_fingerprint, effect_id, receipt_schema, receipt_json, receipt_fingerprint_algorithm,
       receipt_fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'SAVE_REVIEW', ?, 'cfp-review-command-request/v1',
        'sha256-canonical-json-v1', ?, ?, 'cfp-review-command-receipt/v1', ?,
        'sha256-canonical-json-v1', ?, ?)`)
      .run(`memory-receipt-${revisionNumber}`, data.workspaceId, receipt.assignmentId, receipt.roundId,
        receipt.rubricVersionId, receipt.submissionRevisionId, receipt.actorAccountId,
        `memory-receipt-key-${revisionNumber}`, "a".repeat(64), receipt.effectId,
        canonicalJson(receipt), fingerprintOf(receipt), createdAt);
  }
}

function addProvenance(data: Fixture, provider = "synthetic-provider"): void {
  data.db.prepare(`INSERT INTO source_records
    (id, workspace_id, provider, source_ref, version, payload_json, imported_at)
    VALUES ('memory-source', ?, ?, 'person/1', 1, '{}', '2026-08-09T00:00:00.000Z')`)
    .run(data.workspaceId, provider);
  data.db.prepare(`INSERT INTO source_links
    (id, workspace_id, person_id, source_record_id, link_decision, created_at)
    VALUES ('memory-source-link', ?, ?, 'memory-source', 'EXACT', '2026-08-09T00:00:01.000Z')`)
    .run(data.workspaceId, data.personId);
}

type SnapshotMemberFixture = { id: string; personId: string; rank: number; whyIn: string };

function compareUtf16CodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function addCohortSnapshot(data: Fixture, options: {
  id: string;
  asOf: string;
  createdAt?: string;
  cohortName?: string;
  members?: SnapshotMemberFixture[];
}): { snapshotId: string; memberIds: Record<string, string>; fingerprint: string } {
  const cohortName = options.cohortName ?? `Memory near miss ${options.id}`;
  const definitionId = `${options.id}-definition`;
  const members = [...(options.members ?? [{ id: `${options.id}-member`, personId: data.personId, rank: 1, whyIn: "historical near miss" }])]
    .sort((left, right) => left.rank - right.rank || compareUtf16CodeUnits(left.personId, right.personId) || compareUtf16CodeUnits(left.id, right.id));
  const definition = { name: cohortName, version: 1, purpose: "historical near miss", rule: { eligibleEntity: "person" } };
  const fingerprint = fingerprintOf({
    schema: "cohort-snapshot/v1",
    workspaceId: data.workspaceId,
    cohortName,
    definitionVersion: 1,
    asOf: options.asOf,
    members: members.map((member) => ({ personId: member.personId, rank: member.rank, whyIn: member.whyIn })),
  });
  data.db.prepare(`INSERT INTO cohort_definitions (id, workspace_id, name, version, definition_json, created_at)
    VALUES (?, ?, ?, 1, ?, ?)`)
    .run(definitionId, data.workspaceId, cohortName, canonicalJson(definition), options.createdAt ?? options.asOf);
  data.db.prepare(`INSERT INTO cohort_snapshots
    (id, workspace_id, cohort_definition_id, definition_version, as_of, fingerprint, member_count, created_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)`)
    .run(options.id, data.workspaceId, definitionId, options.asOf, fingerprint, members.length, options.createdAt ?? options.asOf);
  const insertMember = data.db.prepare(`INSERT INTO cohort_snapshot_members
    (id, workspace_id, snapshot_id, person_id, rank, why_in) VALUES (?, ?, ?, ?, ?, ?)`);
  const memberIds: Record<string, string> = {};
  for (const member of members) {
    insertMember.run(member.id, data.workspaceId, options.id, member.personId, member.rank, member.whyIn);
    memberIds[member.personId] = member.id;
  }
  return { snapshotId: options.id, memberIds, fingerprint };
}

function standaloneSubmission(data: Fixture, suffix: string): { id: string; revisionId: string } {
  const call = data.db.prepare("SELECT call_id FROM submissions WHERE id = ?").get(data.first.id) as { call_id: string };
  const created = createDraftSubmission(data.db, {
    workspaceId: data.workspaceId, sessionId: "memory-applicant-session-0",
  }, { callId: call.call_id });
  const revision = saveDraftRevision(data.db, {
    workspaceId: data.workspaceId, sessionId: "memory-applicant-session-0",
  }, { submissionId: created.id, historicalAnswers: [{ fieldId: "consent", value: suffix.length % 2 === 0 }], expectedCurrentRevisionId: null });
  return { id: created.id, revisionId: revision.revisionId };
}

function standaloneSubmissionForPerson(data: Fixture, personId: string, email: string, suffix: string): { id: string; revisionId: string } {
  const call = data.db.prepare("SELECT call_id FROM submissions WHERE id = ?").get(data.first.id) as { call_id: string };
  const verificationId = `memory-verification-${suffix}`;
  const sessionId = `memory-applicant-session-${suffix}`;
  data.db.prepare(`INSERT INTO cfp_email_verifications
    (id, workspace_id, call_id, email, token_hash, expires_at, created_at, issuance_sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(verificationId, data.workspaceId, call.call_id, email,
      sha256Hex(verificationId), "2099-01-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  data.db.prepare(`INSERT INTO cfp_email_verification_consumptions
    (id, workspace_id, verification_id, person_id, consumed_at) VALUES (?, ?, ?, ?, ?)`)
    .run(`${verificationId}-consumption`, data.workspaceId, verificationId, personId, "2026-08-10T00:00:00.000Z");
  data.db.prepare(`INSERT INTO cfp_applicant_sessions
    (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, data.workspaceId, call.call_id, personId, verificationId, "b".repeat(64),
      "2026-08-10T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
  const created = createDraftSubmission(data.db, { workspaceId: data.workspaceId, sessionId }, { callId: call.call_id });
  const revision = saveDraftRevision(data.db, { workspaceId: data.workspaceId, sessionId }, {
    submissionId: created.id, historicalAnswers: [{ fieldId: "consent", value: true }], expectedCurrentRevisionId: null,
  });
  return { id: created.id, revisionId: revision.revisionId };
}

function lineageActor(data: Fixture) {
  return { workspaceId: data.workspaceId, workspaceSlug: "northstar", accountId: data.accountId, role: "organizer" as const };
}

function errorCode(action: () => unknown): string {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(InstitutionalMemoryError);
    return (error as InstitutionalMemoryError).code;
  }
  throw new Error("expected institutional-memory failure");
}

describe("PD-01 bounded institutional memory", () => {
  it("returns explicit two-event lineage and revisions, separates current use, freezes output, and exposes missing families", () => {
    const data = fixture();
    try {
      const result = queryInstitutionalMemory(data.db, data.session, { workspaceSlug: "northstar", personId: data.personId, lineageId: data.lineageId });
      expect(new Set(result.sources.map((item) => item.eventId))).toEqual(new Set([data.firstEvent, data.secondEvent]));
      expect(result.sources.some((item) => item.family === "submission-revision" && item.ids.submissionRevisionId === data.first.revisionId && item.currentUse === "current")).toBe(true);
      expect(result.sources.some((item) => item.family === "submission-revision" && item.ids.submissionRevisionId === data.second.revisionId && item.currentUse === "current")).toBe(true);
      expect(result.authorityCarryover).toBe(false);
      expect(result.sources.every((item) => item.carriesAuthorityForward === false)).toBe(true);
      expect(result.unavailableFamilies.map((item) => item.family)).toEqual(["attendee-feedback", "reliability", "outreach-authorization"]);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.sources)).toBe(true);
      expect(() => (result.sources as unknown as MemorySourceRecord[]).push(result.sources[0]!)).toThrow();
    } finally { closeDb(data.db); }
  });

  it("keeps exact event context and fails closed for foreign tenant, hostile input, and stale sessions without writes", () => {
    const data = fixture();
    try {
      const before = data.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
      const current = queryInstitutionalMemory(data.db, data.session, { workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent });
      expect(current.sources.every((item) => item.eventId === data.firstEvent || item.eventId === null)).toBe(true);
      expect(() => queryInstitutionalMemory(data.db, data.session, { workspaceSlug: "acme", personId: data.personId })).toThrow(InstitutionalMemoryError);
      expect(() => queryInstitutionalMemory(data.db, data.session, new Proxy({ workspaceSlug: "northstar", personId: data.personId }, { ownKeys: () => { throw new Error("hostile"); } }) as never)).toThrow(InstitutionalMemoryError);
      data.db.prepare("DELETE FROM sessions WHERE id = ?").run(data.session.id);
      expect(() => queryInstitutionalMemory(data.db, data.session, { workspaceSlug: "northstar", personId: data.personId })).toThrow(InstitutionalMemoryError);
      expect((data.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count).toBe(before.count);
    } finally { closeDb(data.db); }
  });

  it("projects a resolved person's immutable near-miss snapshot and member without inventing event evidence", () => {
    const data = fixture();
    try {
      const snapshot = addCohortSnapshot(data, {
        id: "memory-near-miss-snapshot",
        asOf: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      const result = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent,
      });
      const nearMisses = result.sources.filter((item) => item.family === "near-miss-snapshot");
      expect(nearMisses).toHaveLength(1);
      expect(nearMisses[0]).toMatchObject({
        eventId: null,
        fingerprint: snapshot.fingerprint,
        fingerprintOrigin: "stored",
        currentUse: "historical",
        authority: "historical-record",
        carriesAuthorityForward: false,
        ids: {
          snapshotId: snapshot.snapshotId,
          snapshotMemberId: snapshot.memberIds[data.personId],
          personId: data.personId,
        },
        data: {
          workspaceId: data.workspaceId,
          personId: data.personId,
          asOf: "2026-01-01T00:00:00.000Z",
          snapshotFingerprint: snapshot.fingerprint,
          historicalOnly: true,
        },
      });
      expect(nearMisses[0]!.data).not.toHaveProperty("eventId");
      expect(Object.values(nearMisses[0]!.ids)).not.toContain(data.second.id);
      expect(result.authorityCarryover).toBe(false);
    } finally { closeDb(data.db); }
  });

  it("applies the target-event as-of boundary and an explicit earlier boundary deterministically", () => {
    const data = fixture();
    try {
      const snapshots = [
        addCohortSnapshot(data, { id: "memory-asof-one", asOf: "2026-01-01T00:00:00.000Z" }),
        addCohortSnapshot(data, { id: "memory-asof-two", asOf: "2026-01-10T00:00:00.000Z" }),
        addCohortSnapshot(data, { id: "memory-asof-future", asOf: "2026-01-16T00:00:00.000Z" }),
      ];
      const targetEvent = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent,
      }).sources.filter((item) => item.family === "near-miss-snapshot");
      expect(targetEvent.map((item) => item.ids.snapshotId)).toEqual([snapshots[0]!.snapshotId, snapshots[1]!.snapshotId]);
      const explicit = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent,
        asOf: "2026-01-05T00:00:00.000Z",
      }).sources.filter((item) => item.family === "near-miss-snapshot");
      expect(explicit.map((item) => item.ids.snapshotId)).toEqual([snapshots[0]!.snapshotId]);
    } finally { closeDb(data.db); }
  });

  it("projects valid snapshot history for a resolved person-only query", () => {
    const data = fixture();
    try {
      const snapshot = addCohortSnapshot(data, {
        id: "memory-person-only-snapshot",
        asOf: "2026-01-01T00:00:00.000Z",
      });
      const result = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId,
      });
      const nearMiss = result.sources.find((item) => item.family === "near-miss-snapshot");
      expect(nearMiss).toMatchObject({
        eventId: null,
        fingerprint: snapshot.fingerprint,
        ids: { snapshotId: snapshot.snapshotId, personId: data.personId },
      });
      expect(nearMiss?.data).not.toHaveProperty("eventId");
    } finally { closeDb(data.db); }
  });

  it("requires both snapshot as-of and immutable creation time at a historical boundary", () => {
    const data = fixture();
    try {
      const valid = addCohortSnapshot(data, {
        id: "memory-boundary-valid-snapshot",
        asOf: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      const late = addCohortSnapshot(data, {
        id: "memory-boundary-late-snapshot",
        asOf: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-16T00:00:00.000Z",
      });
      const result = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent,
      });
      expect(result.sources.filter((item) => item.family === "near-miss-snapshot")
        .map((item) => item.ids.snapshotId)).toEqual([valid.snapshotId]);
      expect(result.sources.some((item) => item.ids.snapshotId === late.snapshotId)).toBe(false);
    } finally { closeDb(data.db); }
  });

  it("uses UTF-16 code-unit ordering for locale-sensitive member identifiers before corruption checks", () => {
    const data = fixture();
    try {
      const otherPersonId = "memory-ä";
      data.db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(otherPersonId, data.workspaceId, "memory-umlaut@synthetic.example", "Memory Umlaut", "2026-08-10T00:00:00.000Z");
      addCohortSnapshot(data, {
        id: "memory-locale-sensitive-snapshot",
        asOf: "2026-01-01T00:00:00.000Z",
        members: [
          { id: "memory-member-ä", personId: data.personId, rank: 1, whyIn: "target" },
          { id: "memory-member-a", personId: otherPersonId, rank: 1, whyIn: "duplicate-rank countertest" },
        ],
      });
      const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
        throw new Error("locale-dependent ordering");
      });
      try {
        expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
          workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent,
        }))).toBe("READ_FAILED");
        expect(localeCompare).not.toHaveBeenCalled();
      } finally {
        localeCompare.mockRestore();
      }
    } finally { closeDb(data.db); }
  });

  it("does not infer a person from unrelated snapshot membership or cross-tenant rows", () => {
    const data = fixture();
    try {
      const unrelatedPerson = "memory-unrelated-snapshot-person";
      data.db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(unrelatedPerson, data.workspaceId, "unrelated-snapshot@synthetic.example", "Unrelated Snapshot Person", "2026-08-10T00:00:00.000Z");
      addCohortSnapshot(data, {
        id: "memory-unrelated-snapshot",
        asOf: "2026-01-01T00:00:00.000Z",
        members: [{ id: "memory-unrelated-snapshot-member", personId: unrelatedPerson, rank: 1, whyIn: "not the query target" }],
      });
      const result = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent,
      });
      expect(result.sources.some((item) => item.family === "near-miss-snapshot")).toBe(false);
      expect(result.sources.every((item) => !Object.values(item.ids).includes(unrelatedPerson))).toBe(true);

      const foreignWorkspace = data.db.prepare("SELECT id FROM workspaces WHERE id <> ? LIMIT 1")
        .get(data.workspaceId) as { id: string };
      const foreignPersonId = "memory-foreign-snapshot-person";
      data.db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(foreignPersonId, foreignWorkspace.id, "foreign-snapshot@synthetic.example", "Foreign Snapshot Person", "2026-08-10T00:00:00.000Z");
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: foreignPersonId, eventId: data.firstEvent,
      }))).toBe("TARGET_UNAVAILABLE");
    } finally { closeDb(data.db); }
  });

  it("fails closed on corrupted near-miss snapshot, as-of, member, and fingerprint evidence", () => {
    const mutations: Array<(data: Fixture, snapshot: ReturnType<typeof addCohortSnapshot>) => void> = [
      (data, snapshot) => {
        data.db.exec("DROP TRIGGER trg_cohort_snapshots_immutable");
        data.db.prepare("UPDATE cohort_snapshots SET fingerprint = ? WHERE id = ?")
          .run("f".repeat(64), snapshot.snapshotId);
      },
      (data, snapshot) => {
        data.db.exec("DROP TRIGGER trg_cohort_snapshots_immutable");
        data.db.prepare("UPDATE cohort_snapshots SET as_of = ? WHERE id = ?")
          .run("corrupt-as-of", snapshot.snapshotId);
      },
      (data, snapshot) => {
        data.db.exec("DROP TRIGGER trg_cohort_snapshots_immutable");
        data.db.prepare("UPDATE cohort_snapshots SET created_at = ? WHERE id = ?")
          .run("corrupt-created-at", snapshot.snapshotId);
      },
      (data, snapshot) => {
        data.db.exec("DROP TRIGGER trg_snapshot_members_immutable");
        data.db.prepare("UPDATE cohort_snapshot_members SET why_in = ? WHERE id = ?")
          .run("tampered member evidence", snapshot.memberIds[data.personId]);
      },
      (data, snapshot) => {
        data.db.exec("DROP TRIGGER trg_cohort_snapshots_immutable");
        data.db.prepare("UPDATE cohort_snapshots SET member_count = ? WHERE id = ?")
          .run(2, snapshot.snapshotId);
      },
    ];
    for (const mutate of mutations) {
      const data = fixture();
      try {
        const snapshot = addCohortSnapshot(data, {
          id: "memory-corrupt-snapshot",
          asOf: "2026-01-01T00:00:00.000Z",
        });
        mutate(data, snapshot);
        expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
          workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent,
        }))).toBe("READ_FAILED");
      } finally { closeDb(data.db); }
    }
  });

  it("reports current outreach authorization as unavailable instead of promoting snapshot membership", () => {
    const data = fixture();
    try {
      addCohortSnapshot(data, { id: "memory-outreach-unavailable", asOf: "2026-01-01T00:00:00.000Z" });
      const result = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent,
      });
      expect(result.unavailableFamilies).toContainEqual({
        family: "outreach-authorization",
        available: false,
        reason: "No authoritative current outreach-authorization source exists in the current schema.",
      });
      expect(result.sources.filter((item) => item.family === "near-miss-snapshot")
        .every((item) => item.authority === "historical-record" && item.carriesAuthorityForward === false)).toBe(true);
    } finally { closeDb(data.db); }
  });

  it("bounds near-miss snapshot candidates before materializing the evidence set", () => {
    const data = fixture();
    try {
      for (let index = 0; index <= INSTITUTIONAL_MEMORY_MAX_ITEMS; index += 1) {
        const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString();
        addCohortSnapshot(data, { id: `memory-bound-snapshot-${index}`, asOf: date });
      }
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId, eventId: data.firstEvent,
      }))).toBe("BOUND_EXCEEDED");
    } finally { closeDb(data.db); }
  });

  it("shares one pre-materialization budget across existing sources, snapshot candidates, and members", () => {
    const data = fixture();
    try {
      const insertRecord = data.db.prepare(`INSERT INTO source_records
        (id, workspace_id, provider, source_ref, version, payload_json, imported_at)
        VALUES (?, ?, 'synthetic-budget-provider', ?, 1, '{}', ?)`);
      const insertLink = data.db.prepare(`INSERT INTO source_links
        (id, workspace_id, person_id, source_record_id, link_decision, created_at)
        VALUES (?, ?, ?, ?, 'EXACT', ?)`);
      for (let index = 0; index < INSTITUTIONAL_MEMORY_MAX_ITEMS - 3; index += 1) {
        const suffix = `memory-budget-${index}`;
        insertRecord.run(`${suffix}-record`, data.workspaceId, `${suffix}/1`, "2026-08-09T00:00:00.000Z");
        insertLink.run(`${suffix}-link`, data.workspaceId, data.personId, `${suffix}-record`, "2026-08-09T00:00:01.000Z");
      }
      addCohortSnapshot(data, {
        id: "memory-budget-snapshot",
        asOf: "2026-01-01T00:00:00.000Z",
      });
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId,
      }))).toBe("BOUND_EXCEEDED");
    } finally { closeDb(data.db); }
  });

  it("keeps lineage-only scope from pulling unrelated same-person provenance", () => {
    const data = fixture();
    try {
      addProvenance(data);
      const personWide = queryInstitutionalMemory(data.db, data.session, { workspaceSlug: "northstar", personId: data.personId });
      expect(personWide.sources.some((item) => item.family === "person-history" && item.ids.sourceRecordId === "memory-source")).toBe(true);
      const lineageOnly = queryInstitutionalMemory(data.db, data.session, { workspaceSlug: "northstar", lineageId: data.lineageId });
      expect(lineageOnly.personId).toBeNull();
      expect(lineageOnly.sources.some((item) => item.family === "person-history" || item.family === "decision-outcome")).toBe(false);
    } finally { closeDb(data.db); }
  });

  it("rejects an oversized lineage revision set before graph materialization", () => {
    const data = fixture();
    try {
      let currentRevisionId = data.first.revisionId;
      for (let index = 1; index <= INSTITUTIONAL_MEMORY_MAX_ITEMS; index += 1) {
        const saved = saveDraftRevision(data.db, { workspaceId: data.workspaceId, sessionId: "memory-applicant-session-0" }, {
          submissionId: data.first.id, historicalAnswers: [{ fieldId: "consent", value: index % 2 === 0 }], expectedCurrentRevisionId: currentRevisionId,
        });
        currentRevisionId = saved.revisionId;
      }
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, { workspaceSlug: "northstar", lineageId: data.lineageId }))).toBe("BOUND_EXCEEDED");
    } finally { closeDb(data.db); }
  });

  it("does not reopen a fresh output cap after revisions consume the result budget", () => {
    const data = fixture();
    try {
      let currentRevisionId = data.first.revisionId;
      for (let index = 1; index < INSTITUTIONAL_MEMORY_MAX_ITEMS; index += 1) {
        const saved = saveDraftRevision(data.db, { workspaceId: data.workspaceId, sessionId: "memory-applicant-session-0" }, {
          submissionId: data.first.id, historicalAnswers: [{ fieldId: "consent", value: index % 2 === 0 }], expectedCurrentRevisionId: currentRevisionId,
        });
        currentRevisionId = saved.revisionId;
      }
      addProvenance(data);
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId,
      }))).toBe("BOUND_EXCEEDED");
    } finally { closeDb(data.db); }
  });

  it("fails closed when target-rooted traversal discovers more than the global node cap", () => {
    const data = fixture();
    try {
      let prior = data.second;
      for (let index = 0; index < INSTITUTIONAL_MEMORY_MAX_ITEMS - 1; index += 1) {
        const next = standaloneSubmission(data, `connected-${index}`);
        createSubmissionDerivation(data.db, lineageActor(data), {
          workspaceSlug: "northstar", relationshipType: "RESUBMISSION_OF",
          sourceSubmissionId: prior.id, sourceSubmissionRevisionId: prior.revisionId,
          targetSubmissionId: next.id, targetSubmissionRevisionId: next.revisionId,
          reason: `connected edge ${index}`, idempotencyKey: `connected-edge-${index}`,
        });
        prior = next;
      }
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId,
      }))).toBe("BOUND_EXCEEDED");
    } finally { closeDb(data.db); }
  });

  it("does not traverse or materialize more-than-cap unrelated workspace derivations", () => {
    const data = fixture();
    try {
      const unrelatedSource = standaloneSubmission(data, "unrelated-source");
      const unrelatedTarget = standaloneSubmission(data, "unrelated-target");
      for (let index = 0; index < INSTITUTIONAL_MEMORY_MAX_ITEMS + 25; index += 1) {
        createSubmissionDerivation(data.db, lineageActor(data), {
          workspaceSlug: "northstar", relationshipType: "CARRIED_FORWARD_FROM",
          sourceSubmissionId: unrelatedSource.id, sourceSubmissionRevisionId: unrelatedSource.revisionId,
          targetSubmissionId: unrelatedTarget.id, targetSubmissionRevisionId: unrelatedTarget.revisionId,
          reason: `unrelated edge ${index}`, idempotencyKey: `unrelated-edge-${index}`,
        });
      }
      const result = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId,
      });
      expect(new Set(result.sources.filter((item) => item.family === "submission-revision")
        .map((item) => item.ids.submissionId))).toEqual(new Set([data.first.id, data.second.id]));
      expect(result.sources.some((item) => item.ids.submissionId === unrelatedSource.id
        || item.ids.submissionId === unrelatedTarget.id)).toBe(false);
      expect(result.sources.filter((item) => item.family === "lineage"
        && "derivationId" in item.ids)).toHaveLength(1);
    } finally { closeDb(data.db); }
  });

  it("returns an induced person scope and excludes mixed-person edge endpoints", () => {
    const data = fixture();
    try {
      const personB = "memory-person-b";
      data.db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(personB, data.workspaceId, "memory-b@synthetic.example", "Memory Person B", "2026-08-10T00:00:00.000Z");
      const bSubmission = standaloneSubmissionForPerson(data, personB, "memory-b@synthetic.example", "b");
      createSubmissionDerivation(data.db, lineageActor(data), {
        workspaceSlug: "northstar", relationshipType: "COMBINED_FROM",
        sourceSubmissionId: data.first.id, sourceSubmissionRevisionId: data.first.revisionId,
        targetSubmissionId: bSubmission.id, targetSubmissionRevisionId: bSubmission.revisionId,
        reason: "mixed-person connected edge", idempotencyKey: "mixed-person-edge",
      });
      const result = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId, lineageId: data.lineageId,
      });
      expect(result.sources.every((item) => !Object.values(item.ids).includes(bSubmission.id))).toBe(true);
      expect(result.sources.filter((item) => item.family === "submission-revision")
        .map((item) => item.ids.submissionId)).toEqual([data.first.id, data.second.id]);
      expect(result.sources.filter((item) => item.family === "lineage" && "derivationId" in item.ids)).toHaveLength(1);
    } finally { closeDb(data.db); }
  });

  it("treats event selection as an induced subgraph in both cross-event directions", () => {
    const data = fixture();
    try {
      const firstEvent = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId, eventId: data.firstEvent,
      });
      const secondEvent = queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId, eventId: data.secondEvent,
      });
      expect(firstEvent.sources.filter((item) => item.family === "submission-revision")
        .map((item) => item.ids.submissionId)).toEqual([data.first.id]);
      expect(secondEvent.sources.filter((item) => item.family === "submission-revision")
        .map((item) => item.ids.submissionId)).toEqual([data.second.id]);
      expect(firstEvent.sources.some((item) => Object.values(item.ids).includes(data.second.id))).toBe(false);
      expect(secondEvent.sources.some((item) => Object.values(item.ids).includes(data.first.id))).toBe(false);
      expect(firstEvent.sources.some((item) => item.family === "lineage")).toBe(false);
      expect(secondEvent.sources.some((item) => item.family === "lineage")).toBe(false);
    } finally { closeDb(data.db); }
  });

  it("labels only the latest assignment review revision current and discloses organizer metadata policy", () => {
    const data = fixture();
    try {
      addReviewRevisions(data);
      const result = queryInstitutionalMemory(data.db, data.session, { workspaceSlug: "northstar", lineageId: data.lineageId });
      const reviews = result.sources.filter((item) => item.family === "review-history");
      expect(reviews).toHaveLength(2);
      expect(reviews.find((item) => item.ids.reviewRevisionId === "memory-review-1")?.currentUse).toBe("historical");
      expect(reviews.find((item) => item.ids.reviewRevisionId === "memory-review-2")?.currentUse).toBe("current");
      expect(reviews.every((item) => item.data.visibilityPolicy === REVIEW_HISTORY_VISIBILITY_POLICY)).toBe(true);
      expect(reviews.every((item) => !("evaluation" in item.data) && !("reviewerAccountId" in item.ids))).toBe(true);
      const denied = { ...data.session, role: "reviewer" };
      data.db.prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?").run(data.accountId);
      expect(errorCode(() => queryInstitutionalMemory(data.db, denied, { workspaceSlug: "northstar", lineageId: data.lineageId }))).toBe("AUTHORIZATION_DENIED");
    } finally { closeDb(data.db); }
  });

  it("rejects review rows and documents that are individually valid but cross-relinked", () => {
    const rowFields = ["round_id", "rubric_version_id", "submission_id", "submission_revision_id"] as const;
    for (const field of rowFields) {
      const data = fixture();
      try {
        addReviewRevisions(data);
        const call = data.db.prepare("SELECT call_id FROM submissions WHERE id = ?").get(data.first.id) as { call_id: string };
        if (field === "round_id") {
          data.db.prepare("INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run("memory-other-round", data.workspaceId, data.firstEvent, call.call_id, "Other round", data.accountId, "2026-08-11T00:01:00.000Z");
        }
        if (field === "rubric_version_id") {
          data.db.prepare(`INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema,
            rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
            VALUES ('memory-other-rubric', ?, 'memory-round', 2, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, ?)`)
            .run(data.workspaceId, "b".repeat(64), data.accountId, "2026-08-11T00:01:00.000Z");
        }
        data.db.exec("DROP TRIGGER trg_review_revisions_immutable");
        const value = field === "round_id" ? "memory-other-round"
          : field === "rubric_version_id" ? "memory-other-rubric"
          : data.second.id;
        const revisionValue = field === "submission_revision_id" ? data.second.revisionId : value;
        data.db.prepare(`UPDATE review_revisions SET ${field} = ? WHERE id = 'memory-review-1'`).run(revisionValue);
        expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
          workspaceSlug: "northstar", lineageId: data.lineageId,
        }))).toBe("READ_FAILED");
      } finally { closeDb(data.db); }
    }

    const documentFields = ["assignmentId", "rubricVersionId", "submissionRevisionId", "reviewRevisionNumber"] as const;
    for (const field of documentFields) {
      const data = fixture();
      try {
        addReviewRevisions(data);
        const stored = data.db.prepare("SELECT evaluation_json FROM review_revisions WHERE id = 'memory-review-1'")
          .get() as { evaluation_json: string };
        const original = JSON.parse(stored.evaluation_json) as Record<string, unknown>;
        const content = { ...original,
          [field]: field === "assignmentId" ? "other-assignment"
            : field === "rubricVersionId" ? "other-rubric"
            : field === "submissionRevisionId" ? data.second.revisionId : 99 };
        const fingerprint = fingerprintOf(content);
        data.db.exec("DROP TRIGGER trg_review_revisions_immutable");
        data.db.prepare("UPDATE review_revisions SET evaluation_json = ?, fingerprint = ? WHERE id = 'memory-review-1'")
          .run(canonicalJson(content), fingerprint);
        expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
          workspaceSlug: "northstar", lineageId: data.lineageId,
        }))).toBe("READ_FAILED");
      } finally { closeDb(data.db); }
    }
  });

  it("rejects assignment relational-chain mismatches even when the review row is unchanged", () => {
    const fields = ["round_id", "rubric_version_id", "submission_id", "submission_revision_id"] as const;
    for (const field of fields) {
      const data = fixture();
      try {
        addReviewRevisions(data);
        const call = data.db.prepare("SELECT call_id FROM submissions WHERE id = ?").get(data.second.id) as { call_id: string };
        if (field === "round_id") {
          data.db.prepare("INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run("chain-other-round", data.workspaceId, data.secondEvent, call.call_id, "Chain other", data.accountId, "2026-08-11T00:04:00.000Z");
        }
        if (field === "rubric_version_id") {
          data.db.prepare(`INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema,
            rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
            VALUES ('chain-other-rubric', ?, 'memory-round', 3, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, ?)`)
            .run(data.workspaceId, "c".repeat(64), data.accountId, "2026-08-11T00:04:00.000Z");
        }
        data.db.exec("DROP TRIGGER trg_review_assignments_immutable");
        const value = field === "round_id" ? "chain-other-round"
          : field === "rubric_version_id" ? "chain-other-rubric" : data.second.id;
        data.db.prepare(`UPDATE review_assignments SET ${field} = ? WHERE id = 'memory-assignment'`)
          .run(field === "submission_revision_id" ? data.second.revisionId : value);
        expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
          workspaceSlug: "northstar", lineageId: data.lineageId,
        }))).toBe("READ_FAILED");
      } finally { closeDb(data.db); }
    }
  });

  it("rejects a coordinated assignment-review-document relink when immutable receipt evidence anchors the original tuple", () => {
    const data = fixture();
    try {
      addReviewRevisions(data);
      data.db.prepare("INSERT INTO review_rounds (id, workspace_id, event_id, call_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("relinked-round", data.workspaceId, data.secondEvent,
          (data.db.prepare("SELECT call_id FROM submissions WHERE id = ?").get(data.second.id) as { call_id: string }).call_id,
          "Relinked round", data.accountId, "2026-08-11T00:04:00.000Z");
      data.db.prepare(`INSERT INTO rubric_versions (id, workspace_id, round_id, version_number, rubric_schema,
        rubric_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
        VALUES ('relinked-rubric', ?, 'relinked-round', 1, 'cfp-rubric/v1', '{}', 'sha256-canonical-json-v1', ?, ?, ?)`)
        .run(data.workspaceId, "e".repeat(64), data.accountId, "2026-08-11T00:04:01.000Z");
      data.db.exec("DROP TRIGGER trg_review_assignments_immutable");
      data.db.exec("DROP TRIGGER trg_review_revisions_immutable");
      data.db.prepare(`UPDATE review_assignments SET round_id = 'relinked-round', rubric_version_id = 'relinked-rubric',
        submission_id = ?, submission_revision_id = ? WHERE id = 'memory-assignment'`)
        .run(data.second.id, data.second.revisionId);
      for (const revisionNumber of [1, 2]) {
        const reviewId = `memory-review-${revisionNumber}`;
        const stored = data.db.prepare("SELECT evaluation_json FROM review_revisions WHERE id = ?")
          .get(reviewId) as { evaluation_json: string };
        const document = { ...(JSON.parse(stored.evaluation_json) as Record<string, unknown>),
          rubricVersionId: "relinked-rubric", submissionRevisionId: data.second.revisionId };
        data.db.prepare(`UPDATE review_revisions SET assignment_id = 'memory-assignment', round_id = 'relinked-round',
          rubric_version_id = 'relinked-rubric', submission_id = ?, submission_revision_id = ?, evaluation_json = ?, fingerprint = ?
          WHERE id = ?`)
          .run(data.second.id, data.second.revisionId, canonicalJson(document), fingerprintOf(document), reviewId);
      }
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId,
      }))).toBe("READ_FAILED");
    } finally { closeDb(data.db); }
  });

  it("fails closed when coordinated review history has no receipt or a malformed receipt", () => {
    const missing = fixture();
    try {
      addReviewRevisions(missing);
      missing.db.exec("DROP TRIGGER trg_review_command_receipts_no_delete");
      missing.db.prepare("DELETE FROM review_command_receipts").run();
      expect(errorCode(() => queryInstitutionalMemory(missing.db, missing.session, {
        workspaceSlug: "northstar", lineageId: missing.lineageId,
      }))).toBe("READ_FAILED");
    } finally { closeDb(missing.db); }
    const malformed = fixture();
    try {
      addReviewRevisions(malformed);
      malformed.db.exec("DROP TRIGGER trg_review_command_receipts_immutable");
      malformed.db.prepare("UPDATE review_command_receipts SET receipt_fingerprint = ? WHERE id = 'memory-receipt-1'")
        .run("f".repeat(64));
      expect(errorCode(() => queryInstitutionalMemory(malformed.db, malformed.session, {
        workspaceSlug: "northstar", lineageId: malformed.lineageId,
      }))).toBe("READ_FAILED");
    } finally { closeDb(malformed.db); }
  });

  it("requires an exact self-consistent review receipt outcome", () => {
    const forgedOutcomes: Array<Record<string, unknown>> = [
      {},
      { reviewRevisionId: "other-review", reviewRevisionNumber: 1 },
      { reviewRevisionId: "memory-review-1", reviewRevisionNumber: 2 },
      { reviewRevisionId: "memory-review-1", reviewRevisionNumber: 1, extra: "forged" },
    ];
    for (const outcome of forgedOutcomes) {
      const data = fixture();
      try {
        addReviewRevisions(data);
        const stored = data.db.prepare("SELECT receipt_json FROM review_command_receipts WHERE id = 'memory-receipt-1'")
          .get() as { receipt_json: string };
        const receipt = { ...(JSON.parse(stored.receipt_json) as Record<string, unknown>), outcome };
        data.db.exec("DROP TRIGGER trg_review_command_receipts_immutable");
        data.db.prepare("UPDATE review_command_receipts SET receipt_json = ?, receipt_fingerprint = ? WHERE id = 'memory-receipt-1'")
          .run(canonicalJson(receipt), fingerprintOf(receipt));
        expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
          workspaceSlug: "northstar", lineageId: data.lineageId,
        }))).toBe("READ_FAILED");
      } finally { closeDb(data.db); }
    }
  });

  it("derives labeled provenance fingerprints and fails safely on corrupt provider metadata", () => {
    const valid = fixture();
    try {
      addProvenance(valid);
      const result = queryInstitutionalMemory(valid.db, valid.session, { workspaceSlug: "northstar", personId: valid.personId });
      const provenance = result.sources.find((item) => item.family === "person-history");
      expect(provenance).toMatchObject({ fingerprintOrigin: "derived-from-immutable-source" });
      expect(provenance?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(provenance?.data).toHaveProperty("payloadFingerprint");
    } finally { closeDb(valid.db); }
    const corrupt = fixture();
    try {
      addProvenance(corrupt, "bad\nprovider");
      expect(errorCode(() => queryInstitutionalMemory(corrupt.db, corrupt.session, { workspaceSlug: "northstar", personId: corrupt.personId }))).toBe("READ_FAILED");
    } finally { closeDb(corrupt.db); }
  });

  it("revalidates token, role, workspace/account, and expiry from the persisted session tuple", () => {
    const mutations: Array<(data: Fixture) => SessionInfo> = [
      (data) => { data.db.prepare("UPDATE sessions SET token_hash = 'changed' WHERE id = ?").run(data.session.id); return data.session; },
      (data) => { data.db.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ?").run(data.accountId); return data.session; },
      (data) => {
        const foreign = data.db.prepare("SELECT a.id AS accountId, a.workspace_id AS workspaceId FROM accounts a JOIN workspaces w ON w.id = a.workspace_id WHERE w.slug = 'acme' LIMIT 1").get() as { accountId: string; workspaceId: string };
        data.db.prepare("UPDATE sessions SET account_id = ?, workspace_id = ? WHERE id = ?").run(foreign.accountId, foreign.workspaceId, data.session.id);
        return data.session;
      },
      (data) => { data.db.prepare("UPDATE sessions SET expires_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(data.session.id); return data.session; },
    ];
    for (const mutate of mutations) {
      const data = fixture();
      try {
        const snapshot = mutate(data);
        expect(errorCode(() => queryInstitutionalMemory(data.db, snapshot, { workspaceSlug: "northstar", personId: data.personId }))).toBe("AUTHORIZATION_DENIED");
      } finally { closeDb(data.db); }
    }
  });

  it("fails closed when the persisted tuple is downgraded after initial authorization", () => {
    const data = fixture();
    try {
      const originalPrepare = data.db.prepare.bind(data.db);
      let sessionChecks = 0;
      const racingDb = new Proxy(data.db, {
        get(target, property) {
          if (property === "prepare") {
            return (sql: string) => {
              const statement = originalPrepare(sql);
              if (sql.includes("FROM sessions s")) {
                sessionChecks += 1;
                if (sessionChecks === 3) {
                  originalPrepare("UPDATE accounts SET role = 'read_only' WHERE id = ?").run(data.accountId);
                }
              }
              return statement;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as Db;
      expect(errorCode(() => queryInstitutionalMemory(racingDb, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId,
      }))).toBe("AUTHORIZATION_DENIED");
      expect(sessionChecks).toBe(3);
    } finally { closeDb(data.db); }
  });

  it("traverses only authoritative lineage roots in the source direction", () => {
    const data = fixture();
    try {
      const otherPerson = "memory-inbound-person";
      data.db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(otherPerson, data.workspaceId, "inbound@synthetic.example", "Inbound Person", "2026-08-10T00:00:00.000Z");
      const inbound = standaloneSubmissionForPerson(data, otherPerson, "inbound@synthetic.example", "inbound");
      createSubmissionDerivation(data.db, lineageActor(data), {
        workspaceSlug: "northstar", relationshipType: "COMBINED_FROM",
        sourceSubmissionId: inbound.id, sourceSubmissionRevisionId: inbound.revisionId,
        targetSubmissionId: data.first.id, targetSubmissionRevisionId: data.first.revisionId,
        reason: "unrelated inbound", idempotencyKey: "unrelated-inbound",
      });
      const result = queryInstitutionalMemory(data.db, data.session, { workspaceSlug: "northstar", lineageId: data.lineageId });
      expect(result.sources.every((item) => !Object.values(item.ids).includes(inbound.id))).toBe(true);
    } finally { closeDb(data.db); }
  });

  it("reconstructs immutable submission and review fingerprints before disclosure", () => {
    const submission = fixture();
    try {
      submission.db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      submission.db.prepare("UPDATE submission_revisions SET fingerprint = ? WHERE id = ?")
        .run("f".repeat(64), submission.first.revisionId);
      expect(errorCode(() => queryInstitutionalMemory(submission.db, submission.session, {
        workspaceSlug: "northstar", lineageId: submission.lineageId,
      }))).toBe("READ_FAILED");
    } finally { closeDb(submission.db); }
    const review = fixture();
    try {
      addReviewRevisions(review);
      review.db.exec("DROP TRIGGER trg_review_revisions_immutable");
      review.db.prepare("UPDATE review_revisions SET fingerprint = ? WHERE id = ?")
        .run("e".repeat(64), "memory-review-1");
      expect(errorCode(() => queryInstitutionalMemory(review.db, review.session, {
        workspaceSlug: "northstar", lineageId: review.lineageId,
      }))).toBe("READ_FAILED");
    } finally { closeDb(review.db); }
  });

  it("maps transaction and driver lifecycle failures without exposing sentinels", () => {
    const data = fixture();
    try {
      const originalExec = data.db.exec.bind(data.db);
      const failingDb = new Proxy(data.db, {
        get(target, property) {
          if (property === "exec") return (sql: string) => {
            if (sql === "BEGIN") throw new Error("private driver sentinel");
            return originalExec(sql);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as Db;
      expect(errorCode(() => queryInstitutionalMemory(failingDb, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId,
      }))).toBe("READ_FAILED");
      data.db.exec("BEGIN");
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId,
      }))).toBe("READ_FAILED");
      data.db.exec("ROLLBACK");
    } finally {
      if (data.db.isTransaction) data.db.exec("ROLLBACK");
      closeDb(data.db);
    }
  });

  it("distinguishes a session read failure from a missing persisted session", () => {
    const data = fixture();
    try {
      const originalPrepare = data.db.prepare.bind(data.db);
      const failingDb = new Proxy(data.db, {
        get(target, property) {
          if (property === "prepare") return (sql: string) => {
            if (sql.includes("FROM sessions s")) throw new Error("private session read sentinel");
            return originalPrepare(sql);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as Db;
      expect(errorCode(() => queryInstitutionalMemory(failingDb, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId,
      }))).toBe("READ_FAILED");
      data.db.prepare("DELETE FROM sessions WHERE id = ?").run(data.session.id);
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId,
      }))).toBe("AUTHORIZATION_DENIED");
    } finally { closeDb(data.db); }
  });

  it("rejects fingerprints whose immutable documents are bound to another row", () => {
    const data = fixture();
    try {
      const otherJson = data.db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?")
        .get(data.second.revisionId) as { revision_json: string };
      const otherDocument = JSON.parse(otherJson.revision_json) as Record<string, unknown>;
      const mismatchedContent = { ...otherDocument, revisionNumber: 99 };
      const mismatchedDocument = { ...mismatchedContent, fingerprint: fingerprintOf(mismatchedContent) };
      data.db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      data.db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?")
        .run(canonicalJson(mismatchedDocument), mismatchedDocument.fingerprint, data.first.revisionId);
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId,
      }))).toBe("READ_FAILED");
    } finally { closeDb(data.db); }
  });

  it("bounds approval candidate probes before distinct or join expansion", () => {
    const data = fixture();
    try {
      const eventId = data.firstEvent;
      for (let index = 0; index < INSTITUTIONAL_MEMORY_MAX_ITEMS + 1; index += 1) {
        const suffix = `memory-approval-${index}`;
        data.db.prepare(`INSERT INTO program_units
          (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
          VALUES (?, ?, ?, ?, 'track', '2026-01-01T09:00:00.000Z', '2026-01-01T10:00:00.000Z', 1, '2026-08-10T00:00:00.000Z')`)
          .run(`${suffix}-unit`, data.workspaceId, eventId, suffix);
        data.db.prepare(`INSERT INTO plan_runs
          (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json, compiler, compiler_version, created_at)
          VALUES (?, ?, ?, 'FEASIBLE', ?, '{}', 'test', '1', '2026-08-10T00:00:00.000Z')`)
          .run(`${suffix}-run`, data.workspaceId, eventId, `${suffix}-input`);
        data.db.prepare(`INSERT INTO plan_versions
          (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '{}', '2026-08-10T00:00:00.000Z')`)
          .run(`${suffix}-plan`, data.workspaceId, eventId, `${suffix}-run`, index + 1, `${suffix}-fingerprint`);
        data.db.prepare(`INSERT INTO plan_assignments
          (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation)
          VALUES (?, ?, ?, ?, ?, 'track', 'bounded candidate')`)
          .run(`${suffix}-assignment`, data.workspaceId, `${suffix}-plan`, data.personId, `${suffix}-unit`);
      }
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", personId: data.personId,
      }))).toBe("BOUND_EXCEEDED");
    } finally { closeDb(data.db); }
  });

  it("returns target-unavailable at the empty person/event lineage scope boundary", () => {
    const data = fixture();
    try {
      const unrelatedPerson = "memory-unrelated-scope-person";
      const unrelatedEvent = "memory-unrelated-scope-event";
      data.db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(unrelatedPerson, data.workspaceId, "unrelated-scope@synthetic.example", "Unrelated Scope", "2026-08-10T00:00:00.000Z");
      data.db.prepare(`INSERT INTO events
        (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
        VALUES (?, ?, 'Unrelated scope event', 'UTC', '2026-03-15T09:00:00.000Z', '2026-03-15T10:00:00.000Z', '2026-08-10T00:00:00.000Z')`)
        .run(unrelatedEvent, data.workspaceId);
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId, personId: unrelatedPerson,
      }))).toBe("TARGET_UNAVAILABLE");
      expect(errorCode(() => queryInstitutionalMemory(data.db, data.session, {
        workspaceSlug: "northstar", lineageId: data.lineageId, eventId: unrelatedEvent,
      }))).toBe("TARGET_UNAVAILABLE");
    } finally { closeDb(data.db); }
  });

  it("keeps missing targets unavailable and reachable scoped corruption as READ_FAILED", () => {
    const missing = fixture();
    try {
      expect(errorCode(() => queryInstitutionalMemory(missing.db, missing.session, {
        workspaceSlug: "northstar", lineageId: "missing-lineage", personId: missing.personId,
      }))).toBe("TARGET_UNAVAILABLE");
      expect(errorCode(() => queryInstitutionalMemory(missing.db, missing.session, {
        workspaceSlug: "northstar", lineageId: missing.lineageId, personId: "missing-person",
      }))).toBe("TARGET_UNAVAILABLE");
    } finally { closeDb(missing.db); }
    const corrupt = fixture();
    try {
      corrupt.db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      corrupt.db.prepare("UPDATE submission_revisions SET fingerprint = ? WHERE id = ?")
        .run("f".repeat(64), corrupt.first.revisionId);
      expect(errorCode(() => queryInstitutionalMemory(corrupt.db, corrupt.session, {
        workspaceSlug: "northstar", lineageId: corrupt.lineageId, personId: corrupt.personId,
      }))).toBe("READ_FAILED");
    } finally { closeDb(corrupt.db); }
  });
});
