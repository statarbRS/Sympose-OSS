import { describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  bindSubmissionToLineage,
  createProposalLineage,
  createResubmissionRequest,
  createSubmissionDerivation,
  ProposalLineageError,
  readLineageTimeline,
  readResubmissionGuidance,
  type ProposalLineageActor,
} from "../../src/server/services/cfp/proposal-lineage";
import {
  createCall,
  createDraftSubmission,
  createFormDefinition,
  saveDraftRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import { sha256Hex } from "../../src/server/canonical";

function provision(db: Db, workspaceSlug: string, prefix: string) {
  const workspace = db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(workspaceSlug) as { id: string };
  const account = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1").get(workspace.id) as { id: string };
  const eventId = `${prefix}-event`;
  db.prepare(`INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
    VALUES (?, ?, ?, 'UTC', ?, ?, ?)`)
    .run(eventId, workspace.id, `${prefix} event`, "2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z", "2026-08-10T00:00:00.000Z");
  const personId = `${prefix}-person`;
  db.prepare(`INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(personId, workspace.id, `${prefix}@synthetic.example`, prefix, "2026-08-10T00:00:00.000Z");
  const organizer = { workspaceId: workspace.id, accountId: account.id };
  const definition = createFormDefinition(db, organizer, { name: `${prefix} form` });
  const form = sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [{ id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" }],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = createCall(db, organizer, {
    eventId,
    name: `${prefix} call`,
    slug: `${prefix}-call`,
    formVersionId: form.id,
    policy: { disclosure: { privacy: "p", retention: "r", aiProcessing: "a", communication: "c", consent: "c", publication: "p" }, choices: [{ fieldId: "consent", statement: "Allow", required: true }] },
  });
  return { workspaceId: workspace.id, accountId: account.id, workspaceSlug, eventId, personId, email: `${prefix}@synthetic.example`, callId: call.id };
}

function submission(db: Db, context: ReturnType<typeof provision>, suffix: string) {
  const verificationId = `${suffix}-verification`;
  const sessionId = `${suffix}-session`;
  const sequence = (db.prepare("SELECT COALESCE(MAX(issuance_sequence), 0) + 1 AS next FROM cfp_email_verifications WHERE workspace_id = ? AND call_id = ? AND email = ?").get(context.workspaceId, context.callId, context.email) as { next: number }).next;
  db.prepare(`INSERT INTO cfp_email_verifications
    (id, workspace_id, call_id, email, token_hash, expires_at, created_at, issuance_sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(verificationId, context.workspaceId, context.callId, context.email, sha256Hex(suffix), "2099-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z", sequence);
  db.prepare(`INSERT INTO cfp_email_verification_consumptions
    (id, workspace_id, verification_id, person_id, consumed_at) VALUES (?, ?, ?, ?, ?)`)
    .run(`${suffix}-consumption`, context.workspaceId, verificationId, context.personId, "2026-08-10T00:00:00.000Z");
  db.prepare(`INSERT INTO cfp_applicant_sessions
    (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, context.workspaceId, context.callId, context.personId, verificationId, "b".repeat(64), "2026-08-10T00:00:00.000Z", "2099-08-10T00:00:00.000Z");
  const created = createDraftSubmission(db, { workspaceId: context.workspaceId, sessionId }, { callId: context.callId });
  const saved = saveDraftRevision(db, { workspaceId: context.workspaceId, sessionId }, {
    submissionId: created.id, historicalAnswers: [{ fieldId: "consent", value: true }], expectedCurrentRevisionId: null,
  });
  return { id: created.id, revisionId: saved.revisionId };
}

function actor(context: ReturnType<typeof provision>): ProposalLineageActor {
  return { workspaceId: context.workspaceId, workspaceSlug: context.workspaceSlug, accountId: context.accountId, role: "organizer" };
}

function code(error: unknown): string {
  expect(error).toBeInstanceOf(ProposalLineageError);
  return (error as ProposalLineageError).code;
}

describe("PD-01 P1 proposal lineage service", () => {
  it("reconstructs an explicit same-workspace two-event graph, preserves r1, and rejects changed preconditions", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = provision(db, "northstar", "lineage-a");
      const northstarNext = provision(db, "northstar", "lineage-a-next");
      const acme = provision(db, "acme", "lineage-b");
      const first = submission(db, northstar, "lineage-a-one");
      const nextEventSubmission = submission(db, northstarNext, "lineage-a-next-one");
      const foreign = submission(db, acme, "lineage-b-one");
      const northstarActor = actor(northstar);

      const lineage = createProposalLineage(db, northstarActor, {
        workspaceSlug: "northstar", submissionId: first.id, submissionRevisionId: first.revisionId,
        displayProjection: { title: "Historical proposal", summary: "Exact display" }, idempotencyKey: "lineage-create-1",
        expectedSubmissionCurrentRevisionId: first.revisionId,
      });
      expect(createProposalLineage(db, northstarActor, {
        workspaceSlug: "northstar", submissionId: first.id, submissionRevisionId: first.revisionId,
        displayProjection: { title: "Historical proposal", summary: "Exact display" }, idempotencyKey: "lineage-create-1",
        expectedSubmissionCurrentRevisionId: first.revisionId,
      })).toMatchObject({ ...lineage, replayed: true });
      const lineageWritesBeforeConflict = db.prepare("SELECT COUNT(*) AS count FROM proposal_lineages").get() as { count: number };
      const lineageAuditsBeforeConflict = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
      let lineagePreconditionConflict: unknown;
      try {
        createProposalLineage(db, northstarActor, {
          workspaceSlug: "northstar", submissionId: first.id, submissionRevisionId: first.revisionId,
          displayProjection: { title: "Historical proposal", summary: "Exact display" }, idempotencyKey: "lineage-create-1",
          expectedSubmissionCurrentRevisionId: null,
        });
      } catch (error) {
        lineagePreconditionConflict = error;
      }
      expect(code(lineagePreconditionConflict)).toBe("IDEMPOTENCY_CONFLICT");
      expect(db.prepare("SELECT COUNT(*) AS count FROM proposal_lineages").get()).toEqual(lineageWritesBeforeConflict);
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual(lineageAuditsBeforeConflict);
      const firstBind = bindSubmissionToLineage(db, northstarActor, {
        workspaceSlug: "northstar", submissionId: first.id, lineageId: lineage.lineageId,
        expectedLineageId: null, idempotencyKey: "lineage-bind-1",
      });
      expect(firstBind).toMatchObject({ replayed: false, lineageId: lineage.lineageId });
      expect(bindSubmissionToLineage(db, northstarActor, {
        workspaceSlug: "northstar", submissionId: first.id, lineageId: lineage.lineageId,
        expectedLineageId: null, idempotencyKey: "lineage-bind-1",
      })).toMatchObject({ ...firstBind, replayed: true });

      const secondLineage = createProposalLineage(db, actor(acme), {
        workspaceSlug: "acme", submissionId: foreign.id, submissionRevisionId: foreign.revisionId,
        displayProjection: { title: "Second event" }, idempotencyKey: "lineage-create-2",
      });
      bindSubmissionToLineage(db, actor(acme), {
        workspaceSlug: "acme", submissionId: foreign.id, lineageId: secondLineage.lineageId,
        expectedLineageId: null, idempotencyKey: "lineage-bind-2",
      });

      const request = createResubmissionRequest(db, northstarActor, {
        workspaceSlug: "northstar", sourceSubmissionId: first.id, sourceSubmissionRevisionId: first.revisionId,
        guidanceVersion: "g1", guidance: { ask: "clarify scope" }, idempotencyKey: "guidance-1",
      });
      const requestReplay = createResubmissionRequest(db, northstarActor, {
        workspaceSlug: "northstar", sourceSubmissionId: first.id, sourceSubmissionRevisionId: first.revisionId,
        guidanceVersion: "g1", guidance: { ask: "clarify scope" }, idempotencyKey: "guidance-1",
      });
      expect(requestReplay).toMatchObject({ ...request, replayed: true });
      expect(readResubmissionGuidance(db, northstarActor, { workspaceSlug: "northstar", requestId: request.requestId })).toMatchObject({
        sourceSubmissionId: first.id, sourceSubmissionRevisionId: first.revisionId, guidance: { ask: "clarify scope" },
      });

      const derivation = createSubmissionDerivation(db, northstarActor, {
        workspaceSlug: "northstar", relationshipType: "RESUBMISSION_OF", sourceSubmissionId: first.id,
        sourceSubmissionRevisionId: first.revisionId, targetSubmissionId: nextEventSubmission.id,
        targetSubmissionRevisionId: nextEventSubmission.revisionId, reason: "explicit historical resubmission",
        guidanceRequestId: request.requestId, idempotencyKey: "derivation-1",
        expectedTargetCurrentRevisionId: nextEventSubmission.revisionId,
      });
      expect(createSubmissionDerivation(db, northstarActor, {
        workspaceSlug: "northstar", relationshipType: "RESUBMISSION_OF", sourceSubmissionId: first.id,
        sourceSubmissionRevisionId: first.revisionId, targetSubmissionId: nextEventSubmission.id,
        targetSubmissionRevisionId: nextEventSubmission.revisionId, reason: "explicit historical resubmission",
        guidanceRequestId: request.requestId, idempotencyKey: "derivation-1",
        expectedTargetCurrentRevisionId: nextEventSubmission.revisionId,
      })).toMatchObject({ ...derivation, replayed: true });
      const derivationWritesBeforeConflict = db.prepare("SELECT COUNT(*) AS count FROM submission_derivations").get() as { count: number };
      const derivationAuditsBeforeConflict = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
      let derivationPreconditionConflict: unknown;
      try {
        createSubmissionDerivation(db, northstarActor, {
          workspaceSlug: "northstar", relationshipType: "RESUBMISSION_OF", sourceSubmissionId: first.id,
          sourceSubmissionRevisionId: first.revisionId, targetSubmissionId: nextEventSubmission.id,
          targetSubmissionRevisionId: nextEventSubmission.revisionId, reason: "explicit historical resubmission",
          guidanceRequestId: request.requestId, idempotencyKey: "derivation-1", expectedTargetCurrentRevisionId: null,
        });
      } catch (error) {
        derivationPreconditionConflict = error;
      }
      expect(code(derivationPreconditionConflict)).toBe("IDEMPOTENCY_CONFLICT");
      expect(db.prepare("SELECT COUNT(*) AS count FROM submission_derivations").get()).toEqual(derivationWritesBeforeConflict);
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual(derivationAuditsBeforeConflict);

      const before = db.prepare("SELECT current_revision_id FROM submissions WHERE id = ?").get(first.id) as { current_revision_id: string };
      const r2 = saveDraftRevision(db, { workspaceId: northstar.workspaceId, sessionId: "lineage-a-one-session" }, {
        submissionId: first.id, historicalAnswers: [{ fieldId: "consent", value: false }], expectedCurrentRevisionId: before.current_revision_id,
      });
      const timeline = readLineageTimeline(db, northstarActor, { workspaceSlug: "northstar", lineageId: lineage.lineageId });
      expect(new Set(timeline.submissions.map((item) => item.id))).toEqual(new Set([first.id, nextEventSubmission.id]));
      expect(new Set(timeline.submissions.map((item) => item.eventId)).size).toBe(2);
      expect(new Set(timeline.submissions.map((item) => item.callId))).toEqual(new Set([northstar.callId, northstarNext.callId]));
      expect(timeline.submissions.find((item) => item.id === first.id)?.revisions.map((revision) => revision.id))
        .toEqual([first.revisionId, r2.revisionId]);
      expect(timeline.submissions.find((item) => item.id === nextEventSubmission.id)?.lineageId).toBeNull();
      expect(timeline.derivations).toHaveLength(1);
      expect(timeline.derivations[0]).toMatchObject({ id: derivation.derivationId,
        sourceSubmissionRevisionId: first.revisionId, targetSubmissionRevisionId: nextEventSubmission.revisionId });
      expect(timeline).not.toHaveProperty("evaluations");
    } finally {
      closeDb(db);
    }
  });

  it("is explicit-only, tenant scoped, write-once, and fails safely on hostile commands", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = provision(db, "northstar", "guard-a");
      const acme = provision(db, "acme", "guard-b");
      const first = submission(db, northstar, "guard-a-one");
      const other = submission(db, northstar, "guard-a-two");
      const incoming = submission(db, northstar, "guard-a-incoming");
      const foreign = submission(db, acme, "guard-b-one");
      const northstarActor = actor(northstar);
      const deniedAccountId = "guard-a-read-only-account";
      db.prepare(`INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
        VALUES (?, ?, ?, ?, 'read_only', ?)`).run(
        deniedAccountId, northstar.workspaceId, "guard-a-read-only@synthetic.example", "Read-only guard", "2026-08-10T00:00:00.000Z",
      );
      const lineage = createProposalLineage(db, northstarActor, {
        workspaceSlug: "northstar", submissionId: first.id, submissionRevisionId: first.revisionId,
        displayProjection: { title: "Only when linked" }, idempotencyKey: "guard-lineage",
      });
      expect(db.prepare("SELECT lineage_id FROM submissions WHERE id = ?").get(other.id)).toEqual({ lineage_id: null });
      bindSubmissionToLineage(db, northstarActor, { workspaceSlug: "northstar", submissionId: first.id, lineageId: lineage.lineageId, expectedLineageId: null, idempotencyKey: "guard-bind" });
      let bindConflict: unknown;
      try {
        bindSubmissionToLineage(db, northstarActor, { workspaceSlug: "northstar", submissionId: other.id, lineageId: lineage.lineageId, expectedLineageId: null, idempotencyKey: "guard-bind" });
      } catch (error) {
        bindConflict = error;
      }
      expect(code(bindConflict)).toBe("IDEMPOTENCY_CONFLICT");
      expect(db.prepare("SELECT lineage_id FROM submissions WHERE id = ?").get(other.id)).toEqual({ lineage_id: null });
      expect(() => bindSubmissionToLineage(db, northstarActor, { workspaceSlug: "northstar", submissionId: first.id, lineageId: lineage.lineageId, expectedLineageId: null, idempotencyKey: "guard-bind-again" })).toThrowError();
      expect(() => createProposalLineage(db, northstarActor, { workspaceSlug: "northstar", submissionId: foreign.id, submissionRevisionId: foreign.revisionId, displayProjection: {}, idempotencyKey: "foreign" })).toThrowError();
      expect(() => readLineageTimeline(db, northstarActor, { workspaceSlug: "northstar", lineageId: "does-not-exist" })).toThrowError();
      const outgoingDerivation = createSubmissionDerivation(db, northstarActor, {
        workspaceSlug: "northstar", relationshipType: "RESUBMISSION_OF", sourceSubmissionId: first.id, sourceSubmissionRevisionId: first.revisionId,
        targetSubmissionId: other.id, targetSubmissionRevisionId: other.revisionId, reason: "self?", idempotencyKey: "bad-target",
      });
      expect(() => createSubmissionDerivation(db, northstarActor, {
        workspaceSlug: "northstar", relationshipType: "RESUBMISSION_OF", sourceSubmissionId: first.id, sourceSubmissionRevisionId: first.revisionId,
        targetSubmissionId: first.id, targetSubmissionRevisionId: first.revisionId, reason: "self", idempotencyKey: "self",
      })).toThrowError();
      const incomingDerivation = createSubmissionDerivation(db, northstarActor, {
        workspaceSlug: "northstar", relationshipType: "CARRIED_FORWARD_FROM", sourceSubmissionId: incoming.id,
        sourceSubmissionRevisionId: incoming.revisionId, targetSubmissionId: first.id, targetSubmissionRevisionId: first.revisionId,
        reason: "explicit incoming history", idempotencyKey: "incoming-edge",
      });
      expect(incomingDerivation.replayed).toBe(false);
      const timeline = readLineageTimeline(db, northstarActor, { workspaceSlug: "northstar", lineageId: lineage.lineageId });
      expect(new Set(timeline.submissions.map((item) => item.id))).toEqual(new Set([incoming.id, first.id, other.id]));
      expect(new Set(timeline.derivations.map((derivation) => derivation.id)))
        .toEqual(new Set([incomingDerivation.derivationId, outgoingDerivation.derivationId]));
      expect(timeline.derivations.some((derivation) => derivation.id === incomingDerivation.derivationId
        && derivation.sourceSubmissionId === incoming.id
        && derivation.targetSubmissionId === first.id)).toBe(true);
      const hostile = new Proxy({ workspaceSlug: "northstar", lineageId: lineage.lineageId }, {
        ownKeys() { throw new Error("hostile ownKeys"); },
      });
      let hostileError: unknown;
      try {
        readLineageTimeline(db, northstarActor, hostile as never);
      } catch (error) {
        hostileError = error;
      }
      expect(code(hostileError)).toBe("INPUT_INVALID");
      const auditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
      const denied = { ...northstarActor, accountId: deniedAccountId, role: "read_only" };
      expect(() => createProposalLineage(db, denied, { workspaceSlug: "northstar", submissionId: other.id, submissionRevisionId: other.revisionId, displayProjection: {}, idempotencyKey: "denied" })).toThrowError();
      const auditAfter = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
      expect(auditAfter.count).toBe(auditBefore.count + 1);
      expect(db.prepare("SELECT workspace_id, action, target_type FROM audit_events ORDER BY rowid DESC LIMIT 1").get()).toMatchObject({
        workspace_id: northstar.workspaceId, action: "security.access.denied", target_type: "capability",
      });
      const forgedAuditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ?").get(acme.workspaceId) as { count: number };
      const forgedLineagesBefore = db.prepare("SELECT COUNT(*) AS count FROM proposal_lineages WHERE workspace_id = ?").get(acme.workspaceId) as { count: number };
      const forgedDeniedActor = { ...northstarActor, workspaceId: acme.workspaceId, workspaceSlug: "acme", role: "read_only" };
      let forgedDeniedError: unknown;
      try {
        createProposalLineage(db, forgedDeniedActor, {
          workspaceSlug: "acme", submissionId: foreign.id, submissionRevisionId: foreign.revisionId,
          displayProjection: {}, idempotencyKey: "forged-denied",
        });
      } catch (error) {
        forgedDeniedError = error;
      }
      expect(code(forgedDeniedError)).toBe("AUTHORIZATION_DENIED");
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ?").get(acme.workspaceId)).toEqual(forgedAuditBefore);
      expect(db.prepare("SELECT COUNT(*) AS count FROM proposal_lineages WHERE workspace_id = ?").get(acme.workspaceId)).toEqual(forgedLineagesBefore);
      createProposalLineage(db, northstarActor, { workspaceSlug: "northstar", submissionId: other.id, submissionRevisionId: other.revisionId, displayProjection: {}, idempotencyKey: "lineage-conflict" });
      let conflict: unknown;
      try {
        createProposalLineage(db, northstarActor, { workspaceSlug: "northstar", submissionId: other.id, submissionRevisionId: other.revisionId, displayProjection: { changed: true }, idempotencyKey: "lineage-conflict" });
      } catch (error) {
        conflict = error;
      }
      expect(code(conflict)).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      closeDb(db);
    }
  });
});
