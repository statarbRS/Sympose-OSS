import { describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "../../src/server/auth";
import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import * as reviewerBarrel from "../../src/server/services/cfp-review";
import {
  BLIND_REVIEW_ATTESTATION,
  BLIND_REVIEW_DISCLOSURE_STAGE,
  CFP_REVIEW_FINGERPRINT_ALGORITHM,
  CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
  REVIEW_ISSUER_AUTHORITY,
  type BlindFieldDecisionInput,
} from "../../src/server/services/cfp-review/artifact-types";
import {
  canonicalBlindReviewArtifactJson,
  createBlindReviewArtifact,
  fingerprintBlindReviewArtifact,
} from "../../src/server/services/cfp-review/artifacts";
import {
  clearOwnReviewConflict,
  declareOwnReviewConflict,
  listOwnReviewAssignments,
  readOwnReviewAssignment,
  ReviewerServiceError,
  ReviewerServiceFatalError,
  saveOwnReview,
  submitOwnReview,
  type ReviewEvaluation,
} from "../../src/server/services/cfp-review";
import {
  canonicalReviewRubricSemanticsJson,
  fingerprintReviewRubricSemantics,
  REVIEW_SCALE_CODE,
  type ReviewRubricSemanticsV1,
} from "../../src/server/services/cfp-review/rubric-semantics";
import {
  createCall,
  createDraftSubmission,
  createFormDefinition,
  saveDraftRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";

const EARLY = "2026-08-01T00:00:00.000Z";
const OPENED = "2026-08-02T00:00:00.000Z";
const SOURCE_SUMMARY = "source-only summary";
const SOURCE_CONDITIONAL = "source-only conditional answer";
const SOURCE_HIDDEN = "source-only hidden history";
const REDACTED_SUMMARY = "Reviewer-safe summary";
const REDACTED_CONDITIONAL = "Reviewer-safe conditional answer";

type Fixture = Readonly<{
  db: Db;
  session: SessionInfo;
  workspaceId: string;
  reviewerId: string;
  organizerId: string;
  assignmentId: string;
  submissionId: string;
  revisionId: string;
  artifactId: string;
}>;

function expectCode(action: () => unknown, code: string): ReviewerServiceError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReviewerServiceError);
  expect((thrown as ReviewerServiceError).code).toBe(code);
  return thrown as ReviewerServiceError;
}

function setup(): Fixture {
  const db = openDb({ path: ":memory:" });
  const workspace = db
    .prepare("SELECT id, slug FROM workspaces WHERE slug = 'northstar'")
    .get() as { id: string; slug: string };
  const organizer = db
    .prepare(
      `SELECT id, role FROM accounts
       WHERE workspace_id = ?
         AND role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
       ORDER BY id LIMIT 1`,
    )
    .get(workspace.id) as { id: string; role: string };
  const reviewerId = "reviewer-domain-account";
  db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, 'reviewer', ?)`,
  ).run(
    reviewerId,
    workspace.id,
    "reviewer-domain@synthetic.example",
    "Synthetic reviewer",
    EARLY,
  );
  const { session } = createSession(db, reviewerId, workspace.id);

  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES ('reviewer-domain-event', ?, 'Synthetic review event', 'UTC', ?, ?, ?)`,
  ).run(
    workspace.id,
    "2026-09-15T09:00:00.000Z",
    "2026-09-15T10:00:00.000Z",
    EARLY,
  );
  const organizerContext = { workspaceId: workspace.id, accountId: organizer.id };
  const definition = createFormDefinition(db, organizerContext, {
    name: "Reviewer domain form",
  });
  const form = sealFormVersion(db, organizerContext, {
    formDefinitionId: definition.id,
    fields: [
      {
        id: "trigger",
        type: "shortText",
        label: "Source trigger label",
        required: false,
        defaultVisibility: "visible",
      },
      {
        id: "summary",
        type: "longText",
        label: "Source summary label",
        required: true,
        defaultVisibility: "visible",
      },
      {
        id: "conditional",
        type: "shortText",
        label: "Source conditional label",
        required: false,
        defaultVisibility: "hidden",
      },
      {
        id: "hiddenHistory",
        type: "shortText",
        label: "Source hidden label",
        required: false,
        defaultVisibility: "hidden",
      },
      {
        id: "identityEmail",
        type: "email",
        label: "Source identity label",
        required: false,
        defaultVisibility: "visible",
      },
      {
        id: "consent",
        type: "consent",
        label: "Source consent label",
        required: false,
        defaultVisibility: "visible",
      },
    ],
    rules: {
      schema: FORM_RULES_SCHEMA,
      rules: [
        {
          id: "show-conditional",
          condition: {
            kind: "field",
            fieldId: "trigger",
            operator: "equals",
            value: "show",
          },
          actions: [{ type: "show", targetFieldId: "conditional" }],
        },
      ],
    },
  });
  const call = createCall(db, organizerContext, {
    eventId: "reviewer-domain-event",
    name: "Synthetic reviewer call",
    slug: "synthetic-reviewer-call",
    formVersionId: form.id,
    policy: {
      disclosure: {
        privacy: "synthetic privacy",
        retention: "synthetic retention",
        aiProcessing: "synthetic AI processing",
        communication: "synthetic communication",
        consent: "synthetic consent",
        publication: "synthetic publication",
      },
      choices: [{ fieldId: "consent", statement: "Allow review", required: true }],
    },
  });
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
     VALUES ('reviewer-domain-person', ?, ?, 'Synthetic Applicant', ?)`,
  ).run(workspace.id, "applicant-domain@synthetic.example", EARLY);
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES ('reviewer-domain-verification', ?, ?, ?, ?, ?, ?)`,
  ).run(
    workspace.id,
    call.id,
    "applicant-domain@synthetic.example",
    "a".repeat(64),
    "2099-08-01T00:00:00.000Z",
    EARLY,
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES ('reviewer-domain-consumption', ?, 'reviewer-domain-verification',
             'reviewer-domain-person', ?)`,
  ).run(workspace.id, EARLY);
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id,
        token_hash, created_at, expires_at)
     VALUES ('reviewer-domain-applicant-session', ?, ?, 'reviewer-domain-person',
             'reviewer-domain-verification', ?, ?, ?)`,
  ).run(workspace.id, call.id, "b".repeat(64), EARLY, "2099-08-01T00:00:00.000Z");
  const submission = createDraftSubmission(
    db,
    { workspaceId: workspace.id, sessionId: "reviewer-domain-applicant-session" },
    { callId: call.id },
  );
  const saved = saveDraftRevision(
    db,
    { workspaceId: workspace.id, sessionId: "reviewer-domain-applicant-session" },
    {
      submissionId: submission.id,
      expectedCurrentRevisionId: null,
      historicalAnswers: [
        { fieldId: "trigger", value: "show" },
        { fieldId: "summary", value: SOURCE_SUMMARY },
        { fieldId: "conditional", value: SOURCE_CONDITIONAL },
        { fieldId: "hiddenHistory", value: SOURCE_HIDDEN },
        { fieldId: "identityEmail", value: "applicant-domain@synthetic.example" },
        { fieldId: "consent", value: true },
      ],
    },
  );
  db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(submission.id);
  const revisionRow = db
    .prepare(
      `SELECT id, revision_number, revision_schema, fingerprint_algorithm, fingerprint,
              created_at, form_document_schema, form_version_id, rule_version_id,
              form_document_fingerprint
       FROM submission_revisions WHERE id = ?`,
    )
    .get(saved.revisionId) as {
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

  db.prepare(
    `INSERT INTO review_rounds
       (id, workspace_id, event_id, call_id, name, created_by, created_at)
     VALUES ('reviewer-domain-round', ?, 'reviewer-domain-event', ?,
             'Synthetic review round', ?, ?)`,
  ).run(workspace.id, call.id, organizer.id, EARLY);
  db.prepare(
    `INSERT INTO review_round_states
       (id, workspace_id, round_id, state, sequence_number,
        actor_account_id, reason, created_at)
     VALUES ('reviewer-domain-round-open', ?, 'reviewer-domain-round', 'OPEN', 2,
             ?, 'Open synthetic review', ?)`,
  ).run(workspace.id, organizer.id, OPENED);

  const rubricDocument = {
    schema: "cfp-rubric/v1",
    criteria: ["quality", "recommendation", "notes"],
  };
  const rubricFingerprint = fingerprintOf(rubricDocument);
  db.prepare(
    `INSERT INTO rubric_versions
       (id, workspace_id, round_id, version_number, rubric_schema, rubric_json,
        fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
     VALUES ('reviewer-domain-rubric', ?, 'reviewer-domain-round', 1,
             'cfp-rubric/v1', ?, ?, ?, ?, ?)`,
  ).run(
    workspace.id,
    canonicalJson(rubricDocument),
    CFP_REVIEW_FINGERPRINT_ALGORITHM,
    rubricFingerprint,
    organizer.id,
    OPENED,
  );
  const assignmentId = "reviewer-domain-assignment";
  db.prepare(
    `INSERT INTO review_assignments
       (id, workspace_id, round_id, rubric_version_id, submission_id,
        submission_revision_id, reviewer_account_id, assigned_by, created_at)
     VALUES (?, ?, 'reviewer-domain-round', 'reviewer-domain-rubric', ?, ?, ?, ?, ?)`,
  ).run(
    assignmentId,
    workspace.id,
    submission.id,
    saved.revisionId,
    reviewerId,
    organizer.id,
    revisionRow.created_at,
  );

  const semantics: ReviewRubricSemanticsV1 = {
    schema: CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
    version: 1,
    workspaceId: workspace.id,
    roundId: "reviewer-domain-round",
    rubricVersionId: "reviewer-domain-rubric",
    rubricVersionNumber: 1,
    rubricVersionFingerprint: rubricFingerprint,
    criteria: [
      {
        semantic: "PROPOSAL_QUALITY",
        kind: "numeric",
        required: true,
        weight: 1,
        minimum: 1,
        maximum: 5,
        step: 1,
      },
      {
        semantic: "INDEPENDENT_RECOMMENDATION",
        kind: "recommendation",
        required: true,
        weight: 1,
      },
      {
        semantic: "REVIEWER_NOTES",
        kind: "comment",
        required: false,
        weight: 0,
        maxLength: 200,
      },
    ],
    issuer: {
      accountId: organizer.id,
      role: organizer.role,
      authority: REVIEW_ISSUER_AUTHORITY,
    },
    issuedAt: revisionRow.created_at,
  };
  const semanticsJson = canonicalReviewRubricSemanticsJson(semantics);
  const semanticsFingerprint = fingerprintReviewRubricSemantics(semantics);
  db.prepare(
    `INSERT INTO review_rubric_semantics
       (id, workspace_id, round_id, rubric_version_id, rubric_version_number,
        rubric_version_fingerprint, semantics_schema, semantics_version,
        semantics_json, fingerprint_algorithm, fingerprint, issued_by_account_id,
        issuer_role, issuer_authority, idempotency_key,
        request_fingerprint_algorithm, request_fingerprint, issued_at)
     VALUES ('reviewer-domain-semantics', ?, 'reviewer-domain-round',
             'reviewer-domain-rubric', 1, ?, ?, 1, ?, ?, ?, ?, ?, ?,
             'reviewer-domain-semantics-key', ?, ?, ?)`,
  ).run(
    workspace.id,
    rubricFingerprint,
    CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
    semanticsJson,
    CFP_REVIEW_FINGERPRINT_ALGORITHM,
    semanticsFingerprint,
    organizer.id,
    organizer.role,
    REVIEW_ISSUER_AUTHORITY,
    CFP_REVIEW_FINGERPRINT_ALGORITHM,
    fingerprintOf({ request: "semantics" }),
    revisionRow.created_at,
  );

  const effectiveIds = new Set(
    saved.revision.formDocument.effectiveAnswers.map((answer) => answer.fieldId),
  );
  expect(effectiveIds.has("conditional")).toBe(true);
  expect(effectiveIds.has("hiddenHistory")).toBe(false);
  const decisions: BlindFieldDecisionInput[] = saved.revision.formDocument.effectiveAnswers.map(
    (answer) => {
      if (answer.fieldId === "summary") {
        return {
          sourceFieldId: answer.fieldId,
          action: "INCLUDE_REDACTED",
          reviewLabel: "Proposal summary",
          redactedValue: REDACTED_SUMMARY,
        };
      }
      if (answer.fieldId === "conditional") {
        return {
          sourceFieldId: answer.fieldId,
          action: "INCLUDE_REDACTED",
          reviewLabel: "Conditional detail",
          redactedValue: REDACTED_CONDITIONAL,
        };
      }
      return { sourceFieldId: answer.fieldId, action: "EXCLUDE" };
    },
  );
  const artifact = createBlindReviewArtifact({
    workspaceId: workspace.id,
    assignmentId,
    assignmentCreatedAt: revisionRow.created_at,
    rubricVersionId: "reviewer-domain-rubric",
    rubricSemanticsId: "reviewer-domain-semantics",
    rubricSemanticsFingerprint: semanticsFingerprint,
    submissionId: submission.id,
    submissionRevision: {
      id: saved.revisionId,
      number: saved.revision.revisionNumber,
      schema: saved.revision.schema,
      fingerprint: saved.revision.fingerprint,
      createdAt: revisionRow.created_at,
      formDocument: saved.revision.formDocument,
    },
    disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
    conflictAtIssuance: { status: "NONE", sequenceNumber: 0 },
    attestation: BLIND_REVIEW_ATTESTATION,
    issuer: {
      accountId: organizer.id,
      role: organizer.role,
      authority: REVIEW_ISSUER_AUTHORITY,
    },
    issuedAt: revisionRow.created_at,
    decisions,
  });
  const artifactId = "reviewer-domain-artifact";
  db.prepare(
    `INSERT INTO review_blind_artifacts
       (id, workspace_id, assignment_id, assignment_created_at,
        rubric_version_id, rubric_semantics_id, rubric_semantics_fingerprint,
        submission_id, submission_revision_id, submission_revision_number,
        submission_revision_schema, submission_revision_fingerprint_algorithm,
        submission_revision_fingerprint, submission_revision_created_at,
        form_document_schema, form_version_id, rule_version_id,
        form_document_fingerprint, disclosure_stage,
        conflict_status_at_issuance, conflict_sequence_at_issuance,
        artifact_schema, artifact_version, artifact_json, fingerprint_algorithm,
        fingerprint, blind_safety_attestation, issued_by_account_id,
        issuer_role, issuer_authority, idempotency_key,
        request_fingerprint_algorithm, request_fingerprint, issued_at)
     VALUES (?, ?, ?, ?, 'reviewer-domain-rubric', 'reviewer-domain-semantics', ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NONE', 0, ?, 1, ?, ?, ?, ?, ?,
             ?, ?, 'reviewer-domain-artifact-key', ?, ?, ?)`,
  ).run(
    artifactId,
    workspace.id,
    assignmentId,
    revisionRow.created_at,
    semanticsFingerprint,
    submission.id,
    saved.revisionId,
    revisionRow.revision_number,
    revisionRow.revision_schema,
    revisionRow.fingerprint_algorithm,
    revisionRow.fingerprint,
    revisionRow.created_at,
    revisionRow.form_document_schema,
    revisionRow.form_version_id,
    revisionRow.rule_version_id,
    revisionRow.form_document_fingerprint,
    BLIND_REVIEW_DISCLOSURE_STAGE,
    artifact.schema,
    canonicalBlindReviewArtifactJson(artifact),
    CFP_REVIEW_FINGERPRINT_ALGORITHM,
    fingerprintBlindReviewArtifact(artifact),
    BLIND_REVIEW_ATTESTATION,
    organizer.id,
    organizer.role,
    REVIEW_ISSUER_AUTHORITY,
    CFP_REVIEW_FINGERPRINT_ALGORITHM,
    fingerprintOf({ request: "artifact" }),
    revisionRow.created_at,
  );

  return Object.freeze({
    db,
    session,
    workspaceId: workspace.id,
    reviewerId,
    organizerId: organizer.id,
    assignmentId,
    submissionId: submission.id,
    revisionId: saved.revisionId,
    artifactId,
  });
}

function evaluation(
  quality: number,
  complete = true,
): ReviewEvaluation {
  return Object.freeze({
    schema: "cfp-review-evaluation/v1",
    responses: Object.freeze([
      Object.freeze({ criterionId: "criterion-0001", value: quality }),
      ...(complete
        ? [
            Object.freeze({
              criterionId: "criterion-0002",
              value: "ADVANCE",
            }),
          ]
        : []),
    ]),
  });
}

describe("persistence-backed reviewer service", () => {
  it("returns only frozen queue/detail allowlists and reconstructs conditional blind content", () => {
    const fixture = setup();
    try {
      const queue = listOwnReviewAssignments(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
      });
      expect(queue).toEqual([
        expect.objectContaining({
          assignmentId: fixture.assignmentId,
          assignmentState: "ASSIGNED",
          assignmentStateSequenceNumber: 1,
          conflictStatus: "NONE",
          conflictSequenceNumber: 0,
          latestReviewRevisionNumber: 0,
          actionBlocked: false,
        }),
      ]);
      expect(Object.isFrozen(queue)).toBe(true);
      expect(Object.keys(queue[0]!).sort()).toEqual([
        "actionBlocked",
        "assignedAt",
        "assignmentId",
        "assignmentState",
        "assignmentStateSequenceNumber",
        "conflictSequenceNumber",
        "conflictStatus",
        "latestReviewRevisionNumber",
        "roundName",
      ]);

      const detail = readOwnReviewAssignment(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
      });
      expect(detail.proposal.answers).toEqual([
        {
          answerKey: "answer-0001",
          label: "Proposal summary",
          type: "longText",
          value: REDACTED_SUMMARY,
        },
        {
          answerKey: "answer-0002",
          label: "Conditional detail",
          type: "shortText",
          value: REDACTED_CONDITIONAL,
        },
      ]);
      expect(detail.proposal).toEqual({
        revisionSequence: 1,
        disclosureStage: "BLIND_REVIEW",
        answers: detail.proposal.answers,
      });
      expect(detail.rubric.criteria.map((criterion) => criterion.id)).toEqual([
        "criterion-0001",
        "criterion-0002",
        "criterion-0003",
      ]);
      expect(Object.isFrozen(detail)).toBe(true);
      expect(Object.isFrozen(detail.proposal.answers)).toBe(true);

      const serialized = JSON.stringify(detail);
      for (const forbidden of [
        SOURCE_SUMMARY,
        SOURCE_CONDITIONAL,
        SOURCE_HIDDEN,
        fixture.workspaceId,
        fixture.submissionId,
        fixture.revisionId,
        "reviewer-domain-person",
        "reviewer-domain-applicant-session",
        "identityEmail",
        "sourceFieldId",
        "fingerprint",
        "issuer",
        "consentReceipt",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      closeDb(fixture.db);
    }
  });

  it("fails closed before per-assignment work when the reviewer queue exceeds its fixed bound", () => {
    const fixture = setup();
    try {
      let queueSql = "";
      let contentQueries = 0;
      const oversizedQueue = new Proxy(fixture.db, {
        get(target, property) {
          if (property === "prepare") {
            return (sql: string) => {
              if (/SELECT id FROM review_assignments[\s\S]*reviewer_account_id/iu.test(sql)) {
                queueSql = sql;
                return {
                  all: () => Array.from(
                    { length: 257 },
                    (_, index) => ({ id: `oversized-assignment-${index}` }),
                  ),
                };
              }
              if (/review_assignment_states|review_blind_artifacts|review_rubric_semantics/iu.test(sql)) {
                contentQueries += 1;
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;

      expectCode(
        () => listOwnReviewAssignments(oversizedQueue, fixture.session, {
          workspaceSlug: "northstar",
        }),
        "READ_FAILED",
      );
      expect(queueSql).toMatch(/LIMIT 257/iu);
      expect(contentQueries).toBe(0);
    } finally {
      if (fixture.db.isTransaction) fixture.db.exec("ROLLBACK");
      closeDb(fixture.db);
    }
  });

  it("blocks conflict detail before every content query and supports exact declare/clear replay", () => {
    const fixture = setup();
    try {
      const declarationInput = {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
        expectedAssignmentStateSequenceNumber: 1,
        expectedConflictSequenceNumber: 0,
        reason: "Synthetic reviewer conflict",
        idempotencyKey: "declare-domain-conflict",
      } as const;
      const declared = declareOwnReviewConflict(
        fixture.db,
        fixture.session,
        declarationInput,
      );
      expect(declareOwnReviewConflict(fixture.db, fixture.session, declarationInput)).toEqual(
        declared,
      );
      expectCode(
        () => declareOwnReviewConflict(fixture.db, fixture.session, {
          ...declarationInput,
          reason: "Changed conflict payload",
        }),
        "IDEMPOTENCY_CONFLICT",
      );

      let contentQueries = 0;
      const instrumented = new Proxy(fixture.db, {
        get(target, property) {
          if (property === "prepare") {
            return (sql: string) => {
              if (
                /review_blind_artifacts|review_rubric_semantics|rubric_json|submission_revisions/iu
                  .test(sql)
              ) {
                contentQueries += 1;
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;
      expectCode(
        () => readOwnReviewAssignment(instrumented, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );
      expectCode(
        () => saveOwnReview(instrumented, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          expectedReviewRevisionNumber: 0,
          evaluation: evaluation(4),
          idempotencyKey: "blocked-domain-save",
        }),
        "REVIEW_STATE_STALE",
      );
      expect(contentQueries).toBe(0);
      expect(listOwnReviewAssignments(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
      })[0]).toMatchObject({ conflictStatus: "DECLARED", actionBlocked: true });

      const clearInput = {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
        expectedAssignmentStateSequenceNumber: 1,
        expectedConflictSequenceNumber: 1,
        reason: "Synthetic conflict cleared",
        idempotencyKey: "clear-domain-conflict",
      } as const;
      expectCode(
        () => clearOwnReviewConflict(fixture.db, fixture.session, {
          ...clearInput,
          expectedConflictSequenceNumber: 0,
          idempotencyKey: "clear-domain-conflict-stale",
        }),
        "REVIEW_STATE_STALE",
      );
      const cleared = clearOwnReviewConflict(fixture.db, fixture.session, clearInput);
      expect(clearOwnReviewConflict(fixture.db, fixture.session, clearInput)).toEqual(cleared);
      expectCode(
        () => clearOwnReviewConflict(fixture.db, fixture.session, {
          ...clearInput,
          reason: "Changed clear payload",
        }),
        "IDEMPOTENCY_CONFLICT",
      );
      expect(readOwnReviewAssignment(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
      }).conflictStatus).toBe("CLEARED");
    } finally {
      closeDb(fixture.db);
    }
  });

  it("uses the immutable conflict sequence when later dispositions share the issuance timestamp", () => {
    const fixture = setup();
    try {
      const issuedAt = (fixture.db.prepare(
        "SELECT issued_at FROM review_blind_artifacts WHERE id = ?",
      ).get(fixture.artifactId) as { issued_at: string }).issued_at;
      declareOwnReviewConflict(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
        expectedAssignmentStateSequenceNumber: 1,
        expectedConflictSequenceNumber: 0,
        reason: "Synthetic equal-time declaration",
        idempotencyKey: "declare-domain-equal-time",
      });
      clearOwnReviewConflict(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
        expectedAssignmentStateSequenceNumber: 1,
        expectedConflictSequenceNumber: 1,
        reason: "Synthetic equal-time clearance",
        idempotencyKey: "clear-domain-equal-time",
      });

      fixture.db.exec("DROP TRIGGER trg_review_conflict_dispositions_immutable");
      fixture.db.prepare(
        "UPDATE review_conflict_dispositions SET created_at = ? WHERE assignment_id = ?",
      ).run(issuedAt, fixture.assignmentId);

      expect(readOwnReviewAssignment(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
      })).toMatchObject({ conflictStatus: "CLEARED", conflictSequenceNumber: 2 });
    } finally {
      closeDb(fixture.db);
    }
  });

  it("saves immutable revisions, enforces completeness, submits terminally, and replays first", () => {
    const fixture = setup();
    try {
      const firstSaveInput = {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
        expectedAssignmentStateSequenceNumber: 1,
        expectedReviewRevisionNumber: 0,
        evaluation: evaluation(4, false),
        idempotencyKey: "save-domain-one",
      } as const;
      const first = saveOwnReview(fixture.db, fixture.session, firstSaveInput);
      expect(first).toMatchObject({
        schema: "cfp-review-command-receipt/v1",
        commandKind: "SAVE_REVIEW",
        outcome: { reviewRevisionNumber: 1 },
      });
      expect(saveOwnReview(fixture.db, fixture.session, firstSaveInput)).toEqual(first);
      expectCode(
        () => submitOwnReview(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 2,
          expectedReviewRevisionNumber: 1,
          idempotencyKey: "submit-domain-incomplete",
        }),
        "EVALUATION_INCOMPLETE",
      );

      const second = saveOwnReview(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
        expectedAssignmentStateSequenceNumber: 2,
        expectedReviewRevisionNumber: 1,
        evaluation: evaluation(5),
        idempotencyKey: "save-domain-two",
      });
      expect(second.outcome.reviewRevisionNumber).toBe(2);
      expectCode(
        () => saveOwnReview(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 2,
          expectedReviewRevisionNumber: 1,
          evaluation: evaluation(3),
          idempotencyKey: "save-domain-stale",
        }),
        "REVIEW_STATE_STALE",
      );

      const submitInput = {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
        expectedAssignmentStateSequenceNumber: 2,
        expectedReviewRevisionNumber: 2,
        idempotencyKey: "submit-domain-review",
      } as const;
      const submitted = submitOwnReview(fixture.db, fixture.session, submitInput);
      expect(submitted.commandKind).toBe("SUBMIT_REVIEW");
      expect(submitOwnReview(fixture.db, fixture.session, submitInput)).toEqual(submitted);
      expectCode(
        () => submitOwnReview(fixture.db, fixture.session, {
          ...submitInput,
          expectedReviewRevisionNumber: 1,
        }),
        "IDEMPOTENCY_CONFLICT",
      );
      expect(saveOwnReview(fixture.db, fixture.session, firstSaveInput)).toEqual(first);
      expectCode(
        () => saveOwnReview(fixture.db, fixture.session, {
          ...firstSaveInput,
          evaluation: evaluation(2, false),
        }),
        "IDEMPOTENCY_CONFLICT",
      );
      expectCode(
        () => saveOwnReview(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 3,
          expectedReviewRevisionNumber: 2,
          evaluation: evaluation(5),
          idempotencyKey: "save-after-submit",
        }),
        "REVIEW_STATE_STALE",
      );
      expect(fixture.db.prepare(
        "SELECT revision_number FROM review_revisions ORDER BY revision_number",
      ).all()).toEqual([{ revision_number: 1 }, { revision_number: 2 }]);
      expect(fixture.db.prepare(
        "SELECT command_kind FROM review_command_receipts ORDER BY created_at, command_kind",
      ).all()).toHaveLength(3);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("fails fatally instead of inventing a receipt when COMMIT loses its outcome", () => {
    const fixture = setup();
    try {
      const rollbackThenThrow = new Proxy(fixture.db, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string) => {
              if (sql.trim() === "COMMIT") {
                target.exec("ROLLBACK");
                throw new Error("synthetic commit outcome loss");
              }
              target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;

      let thrown: unknown;
      try {
        saveOwnReview(rollbackThenThrow, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          expectedReviewRevisionNumber: 0,
          evaluation: evaluation(4),
          idempotencyKey: "save-domain-indeterminate-commit",
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ReviewerServiceFatalError);
      expect((thrown as ReviewerServiceFatalError).fatal).toBe(true);
      expect(fixture.db.isTransaction).toBe(false);
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_revisions").get())
        .toEqual({ count: 0 });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get())
        .toEqual({ count: 0 });
    } finally {
      if (fixture.db.isTransaction) fixture.db.exec("ROLLBACK");
      closeDb(fixture.db);
    }
  });

  it("raises the fatal boundary when an owned write cannot prove rollback", () => {
    const fixture = setup();
    try {
      const blockedCleanup = new Proxy(fixture.db, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string) => {
              if (sql.trim() === "ROLLBACK") throw new Error("blocked rollback");
              target.exec(sql);
            };
          }
          if (property === "prepare") {
            return (sql: string) => {
              if (sql.trim() === "ROLLBACK") {
                return { run: () => { throw new Error("blocked prepared rollback"); } };
              }
              if (/INSERT INTO review_revisions/iu.test(sql)) {
                throw new Error("synthetic review write fault");
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;

      let thrown: unknown;
      try {
        saveOwnReview(blockedCleanup, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          expectedReviewRevisionNumber: 0,
          evaluation: evaluation(4),
          idempotencyKey: "save-domain-blocked-cleanup",
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ReviewerServiceFatalError);
      expect((thrown as ReviewerServiceFatalError).fatal).toBe(true);
      expect(fixture.db.isTransaction).toBe(true);
      fixture.db.exec("ROLLBACK");
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_revisions").get())
        .toEqual({ count: 0 });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get())
        .toEqual({ count: 0 });
    } finally {
      if (fixture.db.isTransaction) fixture.db.exec("ROLLBACK");
      closeDb(fixture.db);
    }
  });

  it("fails fatally when transaction state becomes unreadable after a durable COMMIT", () => {
    const fixture = setup();
    try {
      let poisonStateProbe = false;
      const committedThenUnreadable = new Proxy(fixture.db, {
        get(target, property) {
          if (property === "isTransaction" && poisonStateProbe) {
            throw new Error("synthetic transaction-state probe fault");
          }
          if (property === "exec") {
            return (sql: string) => {
              if (sql.trim() === "COMMIT") {
                target.exec(sql);
                poisonStateProbe = true;
                throw new Error("synthetic post-commit fault");
              }
              target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;

      let thrown: unknown;
      try {
        saveOwnReview(committedThenUnreadable, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          expectedReviewRevisionNumber: 0,
          evaluation: evaluation(4),
          idempotencyKey: "save-domain-unreadable-after-commit",
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ReviewerServiceFatalError);
      expect((thrown as ReviewerServiceFatalError).fatal).toBe(true);
      expect(fixture.db.isTransaction).toBe(false);
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_revisions").get())
        .toEqual({ count: 1 });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get())
        .toEqual({ count: 1 });
    } finally {
      if (fixture.db.isTransaction) fixture.db.exec("ROLLBACK");
      closeDb(fixture.db);
    }
  });

  it("fails fatally when transaction state becomes unreadable after a partial write fault", () => {
    const fixture = setup();
    try {
      let poisonStateProbe = false;
      const openThenUnreadable = new Proxy(fixture.db, {
        get(target, property) {
          if (property === "isTransaction" && poisonStateProbe) {
            throw new Error("synthetic transaction-state probe fault");
          }
          if (property === "prepare") {
            return (sql: string) => {
              if (/INSERT INTO review_revisions/iu.test(sql)) {
                poisonStateProbe = true;
                throw new Error("synthetic partial review write fault");
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;

      let thrown: unknown;
      try {
        saveOwnReview(openThenUnreadable, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          expectedReviewRevisionNumber: 0,
          evaluation: evaluation(4),
          idempotencyKey: "save-domain-unreadable-after-write",
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ReviewerServiceFatalError);
      expect((thrown as ReviewerServiceFatalError).fatal).toBe(true);
      expect(fixture.db.isTransaction).toBe(true);
      fixture.db.exec("ROLLBACK");
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_revisions").get())
        .toEqual({ count: 0 });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get())
        .toEqual({ count: 0 });
    } finally {
      if (fixture.db.isTransaction) fixture.db.exec("ROLLBACK");
      closeDb(fixture.db);
    }
  });

  it("rejects incomplete and wrong-shaped evaluations without writes and serializes safe receipts", () => {
    const fixture = setup();
    try {
      expectCode(
        () => submitOwnReview(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          expectedReviewRevisionNumber: 0,
          idempotencyKey: "submit-domain-without-review",
        }),
        "EVALUATION_INCOMPLETE",
      );
      expectCode(
        () => saveOwnReview(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          expectedReviewRevisionNumber: 0,
          evaluation: evaluation(6),
          idempotencyKey: "save-domain-out-of-range",
        }),
        "EVALUATION_INVALID",
      );
      expectCode(
        () => saveOwnReview(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          expectedReviewRevisionNumber: 0,
          evaluation: {
            schema: "cfp-review-evaluation/v1",
            responses: [
              { criterionId: "criterion-0001", value: 4 },
              { criterionId: "criterion-0002", value: "PROGRAM_SELECTION" },
            ],
          },
          idempotencyKey: "save-domain-wrong-choice",
        }),
        "EVALUATION_INVALID",
      );
      expectCode(
        () => saveOwnReview(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
          expectedAssignmentStateSequenceNumber: 1,
          expectedReviewRevisionNumber: 0,
          evaluation: {
            ...evaluation(4),
            hiddenAlias: "must not be accepted",
          } as ReviewEvaluation,
          idempotencyKey: "save-domain-evaluation-alias",
        }),
        "INPUT_INVALID",
      );
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_revisions").get())
        .toEqual({ count: 0 });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get())
        .toEqual({ count: 0 });

      const firstInput = {
        workspaceSlug: "northstar",
        assignmentId: fixture.assignmentId,
        expectedAssignmentStateSequenceNumber: 1,
        expectedReviewRevisionNumber: 0,
        evaluation: evaluation(4),
        idempotencyKey: "save-domain-race-winner",
      } as const;
      const receipt = saveOwnReview(fixture.db, fixture.session, firstInput);
      expect(Object.keys(receipt).sort()).toEqual([
        "commandKind",
        "createdAt",
        "effectId",
        "outcome",
        "schema",
      ]);
      expect(Object.keys(receipt.outcome).sort()).toEqual([
        "reviewRevisionId",
        "reviewRevisionNumber",
      ]);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.outcome)).toBe(true);
      const serializedReceipt = JSON.stringify(receipt);
      for (const forbidden of [
        SOURCE_SUMMARY,
        SOURCE_CONDITIONAL,
        fixture.workspaceId,
        fixture.assignmentId,
        fixture.submissionId,
        fixture.revisionId,
        "fingerprint",
        "actorAccountId",
      ]) {
        expect(serializedReceipt).not.toContain(forbidden);
      }

      expectCode(
        () => saveOwnReview(fixture.db, fixture.session, {
          ...firstInput,
          evaluation: evaluation(5),
          idempotencyKey: "save-domain-race-loser",
        }),
        "REVIEW_STATE_STALE",
      );
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_revisions").get())
        .toEqual({ count: 1 });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_command_receipts").get())
        .toEqual({ count: 1 });
    } finally {
      closeDb(fixture.db);
    }
  });

  it("reauthenticates stored scope, rejects hostile boundaries, and collapses target availability", () => {
    const fixture = setup();
    try {
      expectCode(
        () => readOwnReviewAssignment(fixture.db, { ...fixture.session, role: "organizer" }, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
        }),
        "ACCESS_DENIED",
      );
      expectCode(
        () => readOwnReviewAssignment(fixture.db, fixture.session, {
          workspaceSlug: "acme",
          assignmentId: fixture.assignmentId,
        }),
        "ACCESS_DENIED",
      );

      const otherReviewerId = "reviewer-domain-other-account";
      fixture.db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, 'reviewer', ?)`,
      ).run(
        otherReviewerId,
        fixture.workspaceId,
        "reviewer-domain-other@synthetic.example",
        "Other synthetic reviewer",
        EARLY,
      );
      const otherReviewerSession = createSession(
        fixture.db,
        otherReviewerId,
        fixture.workspaceId,
      ).session;
      expectCode(
        () => readOwnReviewAssignment(fixture.db, otherReviewerSession, {
          workspaceSlug: "northstar",
          assignmentId: fixture.assignmentId,
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );

      const otherWorkspace = fixture.db
        .prepare("SELECT id FROM workspaces WHERE slug = 'acme'")
        .get() as { id: string };
      const otherTenantReviewerId = "reviewer-domain-other-tenant";
      fixture.db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, 'reviewer', ?)`,
      ).run(
        otherTenantReviewerId,
        otherWorkspace.id,
        "reviewer-domain-tenant@synthetic.example",
        "Other tenant reviewer",
        EARLY,
      );
      const otherTenantSession = createSession(
        fixture.db,
        otherTenantReviewerId,
        otherWorkspace.id,
      ).session;
      expectCode(
        () => readOwnReviewAssignment(fixture.db, otherTenantSession, {
          workspaceSlug: "acme",
          assignmentId: fixture.assignmentId,
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );

      fixture.db.prepare("UPDATE accounts SET role = 'organizer' WHERE id = ?")
        .run(fixture.reviewerId);
      expectCode(
        () => listOwnReviewAssignments(
          fixture.db,
          { ...fixture.session, role: "organizer" },
          { workspaceSlug: "northstar" },
        ),
        "ACCESS_DENIED",
      );
      fixture.db.prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?")
        .run(fixture.reviewerId);

      const expiredAt = "2026-08-01T00:00:00.000Z";
      fixture.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
        .run(expiredAt, fixture.session.id);
      expectCode(
        () => listOwnReviewAssignments(
          fixture.db,
          { ...fixture.session, expiresAt: expiredAt },
          { workspaceSlug: "northstar" },
        ),
        "ACCESS_DENIED",
      );
      fixture.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
        .run(fixture.session.expiresAt, fixture.session.id);

      expectCode(
        () => readOwnReviewAssignment(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          assignmentId: "missing-assignment",
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );

      const hostile = Object.defineProperty({}, "workspaceSlug", {
        enumerable: true,
        get: () => "northstar",
      });
      expectCode(
        () => listOwnReviewAssignments(
          fixture.db,
          fixture.session,
          hostile as { workspaceSlug: string },
        ),
        "INPUT_INVALID",
      );
      fixture.db.exec("BEGIN");
      expectCode(
        () => listOwnReviewAssignments(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
        }),
        "OUTER_TRANSACTION_DENIED",
      );
      expect(fixture.db.isTransaction).toBe(true);
      fixture.db.exec("ROLLBACK");

      fixture.db.prepare("DELETE FROM sessions WHERE id = ?").run(fixture.session.id);
      expectCode(
        () => listOwnReviewAssignments(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
        }),
        "ACCESS_DENIED",
      );
    } finally {
      if (fixture.db.isTransaction) fixture.db.exec("ROLLBACK");
      closeDb(fixture.db);
    }
  });

  it("suppresses closed and revoked assignments before proposal content", () => {
    const variants = ["closed-round", "revoked-assignment"] as const;
    for (const variant of variants) {
      const fixture = setup();
      try {
        const assignmentCreatedAt = (fixture.db.prepare(
          "SELECT created_at FROM review_assignments WHERE id = ?",
        ).get(fixture.assignmentId) as { created_at: string }).created_at;
        if (variant === "closed-round") {
          fixture.db.prepare(
            `INSERT INTO review_round_states
               (id, workspace_id, round_id, state, sequence_number,
                actor_account_id, reason, created_at)
             VALUES ('reviewer-domain-round-closed', ?, 'reviewer-domain-round',
                     'CLOSED', 3, ?, 'Synthetic round closure', ?)`,
          ).run(fixture.workspaceId, fixture.organizerId, assignmentCreatedAt);
        } else {
          fixture.db.prepare(
            `INSERT INTO review_assignment_states
               (id, workspace_id, assignment_id, state, sequence_number,
                actor_account_id, reason, created_at)
             VALUES ('reviewer-domain-assignment-revoked', ?, ?, 'REVOKED', 2,
                     ?, 'Synthetic assignment revocation', ?)`,
          ).run(
            fixture.workspaceId,
            fixture.assignmentId,
            fixture.organizerId,
            assignmentCreatedAt,
          );
        }

        let contentQueries = 0;
        const instrumented = new Proxy(fixture.db, {
          get(target, property) {
            if (property === "prepare") {
              return (sql: string) => {
                if (
                  /review_blind_artifacts|review_rubric_semantics|rubric_json|submission_revisions/iu
                    .test(sql)
                ) {
                  contentQueries += 1;
                }
                return target.prepare(sql);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as Db;
        expect(listOwnReviewAssignments(instrumented, fixture.session, {
          workspaceSlug: "northstar",
        })).toEqual([]);
        expectCode(
          () => readOwnReviewAssignment(instrumented, fixture.session, {
            workspaceSlug: "northstar",
            assignmentId: fixture.assignmentId,
          }),
          "ASSIGNMENT_NOT_AVAILABLE",
        );
        expect(contentQueries).toBe(0);
      } finally {
        closeDb(fixture.db);
      }
    }
  });

  it("validates every predecessor lifecycle before exposing a replacement assignment", () => {
    const fixture = setup();
    try {
      const replacementReviewerId = "reviewer-domain-replacement";
      fixture.db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, 'reviewer', ?)`,
      ).run(
        replacementReviewerId,
        fixture.workspaceId,
        "reviewer-domain-replacement@synthetic.example",
        "Replacement reviewer",
        EARLY,
      );
      const replacementSession = createSession(
        fixture.db,
        replacementReviewerId,
        fixture.workspaceId,
      ).session;
      const assignment = fixture.db.prepare(
        `SELECT round_id, rubric_version_id, submission_id,
                submission_revision_id, created_at
         FROM review_assignments WHERE id = ?`,
      ).get(fixture.assignmentId) as {
        round_id: string;
        rubric_version_id: string;
        submission_id: string;
        submission_revision_id: string;
        created_at: string;
      };
      fixture.db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number,
            actor_account_id, reason, created_at)
         VALUES ('reviewer-domain-predecessor-recused', ?, ?, 'RECUSED', 2,
                 ?, 'Synthetic recusal', ?)`,
      ).run(
        fixture.workspaceId,
        fixture.assignmentId,
        fixture.reviewerId,
        assignment.created_at,
      );
      const replacementAssignmentId = "reviewer-domain-replacement-assignment";
      fixture.db.prepare(
        `INSERT INTO review_assignments
           (id, workspace_id, round_id, rubric_version_id, submission_id,
            submission_revision_id, reviewer_account_id, assigned_by,
            supersedes_assignment_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        replacementAssignmentId,
        fixture.workspaceId,
        assignment.round_id,
        assignment.rubric_version_id,
        assignment.submission_id,
        assignment.submission_revision_id,
        replacementReviewerId,
        fixture.organizerId,
        fixture.assignmentId,
        assignment.created_at,
      );
      expect(listOwnReviewAssignments(fixture.db, replacementSession, {
        workspaceSlug: "northstar",
      })).toHaveLength(1);

      fixture.db.exec("DROP TRIGGER trg_review_assignment_states_immutable");
      fixture.db.prepare(
        `UPDATE review_assignment_states SET reason = 'forged initial reason'
         WHERE id = ?`,
      ).run(`review-assignment-state-initial:${fixture.assignmentId}`);
      expect(listOwnReviewAssignments(fixture.db, replacementSession, {
        workspaceSlug: "northstar",
      })).toEqual([]);
      expectCode(
        () => readOwnReviewAssignment(fixture.db, replacementSession, {
          workspaceSlug: "northstar",
          assignmentId: replacementAssignmentId,
        }),
        "ASSIGNMENT_NOT_AVAILABLE",
      );
    } finally {
      closeDb(fixture.db);
    }
  });

  it("fails closed on trigger-bypass artifact corruption and exports only the reviewer surface", () => {
    const variants: ReadonlyArray<readonly [string, (fixture: Fixture) => void]> = [
      ["forged artifact fingerprint", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_review_blind_artifacts_immutable");
        fixture.db.prepare(
          "UPDATE review_blind_artifacts SET fingerprint = ? WHERE id = ?",
        ).run("0".repeat(64), fixture.artifactId);
      }],
      ["noncanonical artifact JSON", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_review_blind_artifacts_immutable");
        fixture.db.prepare(
          "UPDATE review_blind_artifacts SET artifact_json = ' ' || artifact_json WHERE id = ?",
        ).run(fixture.artifactId);
      }],
      ["artifact alias", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_review_blind_artifacts_immutable");
        const row = fixture.db.prepare(
          "SELECT artifact_json FROM review_blind_artifacts WHERE id = ?",
        ).get(fixture.artifactId) as { artifact_json: string };
        const forged = {
          ...(JSON.parse(row.artifact_json) as Record<string, unknown>),
          sourceAlias: "must-not-be-accepted",
        };
        fixture.db.prepare(
          `UPDATE review_blind_artifacts
           SET artifact_json = ?, fingerprint = ? WHERE id = ?`,
        ).run(canonicalJson(forged), fingerprintOf(forged), fixture.artifactId);
      }],
      ["wrong artifact revision fingerprint", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_review_blind_artifacts_immutable");
        fixture.db.prepare(
          `UPDATE review_blind_artifacts
           SET submission_revision_fingerprint = ? WHERE id = ?`,
        ).run("0".repeat(64), fixture.artifactId);
      }],
      ["wrong artifact rubric binding", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_review_blind_artifacts_immutable");
        fixture.db.prepare(
          `UPDATE review_blind_artifacts
           SET rubric_semantics_fingerprint = ? WHERE id = ?`,
        ).run("0".repeat(64), fixture.artifactId);
      }],
      ["wrong conflict snapshot", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_review_blind_artifacts_immutable");
        fixture.db.prepare(
          `UPDATE review_blind_artifacts
           SET conflict_status_at_issuance = 'CLEARED',
               conflict_sequence_at_issuance = 1
           WHERE id = ?`,
        ).run(fixture.artifactId);
      }],
      ["missing artifact", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_review_blind_artifacts_no_delete");
        fixture.db.prepare("DELETE FROM review_blind_artifacts WHERE id = ?")
          .run(fixture.artifactId);
      }],
      ["noncanonical rubric semantics", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_review_rubric_semantics_immutable");
        fixture.db.prepare(
          `UPDATE review_rubric_semantics
           SET semantics_json = ' ' || semantics_json
           WHERE id = 'reviewer-domain-semantics'`,
        ).run();
      }],
      ["forged source revision fingerprint", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
        fixture.db.prepare(
          "UPDATE submission_revisions SET fingerprint = ? WHERE id = ?",
        ).run("0".repeat(64), fixture.revisionId);
      }],
      ["forged rubric fingerprint", (fixture) => {
        fixture.db.exec("DROP TRIGGER trg_rubric_versions_immutable");
        fixture.db.prepare(
          "UPDATE rubric_versions SET fingerprint = ? WHERE id = 'reviewer-domain-rubric'",
        ).run("0".repeat(64));
      }],
    ];

    for (const [name, mutate] of variants) {
      const fixture = setup();
      try {
        mutate(fixture);
        const error = expectCode(
          () => readOwnReviewAssignment(fixture.db, fixture.session, {
            workspaceSlug: "northstar",
            assignmentId: fixture.assignmentId,
          }),
          "ASSIGNMENT_NOT_AVAILABLE",
        );
        const serializedError = `${name}:${error.code}:${error.message}`;
        for (const forbidden of [
          SOURCE_SUMMARY,
          SOURCE_CONDITIONAL,
          SOURCE_HIDDEN,
          fixture.workspaceId,
          fixture.submissionId,
          fixture.revisionId,
        ]) {
          expect(serializedError).not.toContain(forbidden);
        }
      } finally {
        closeDb(fixture.db);
      }
    }

    expect(Object.keys(reviewerBarrel).sort()).toEqual([
      "CFP_REVIEW_COMMAND_RECEIPT_SCHEMA",
      "CFP_REVIEW_COMMAND_REQUEST_SCHEMA",
      "CFP_REVIEW_EVALUATION_SCHEMA",
      "ReviewerServiceError",
      "ReviewerServiceFatalError",
      "clearOwnReviewConflict",
      "declareOwnReviewConflict",
      "listOwnReviewAssignments",
      "readOwnReviewAssignment",
      "saveOwnReview",
      "submitOwnReview",
    ]);
    for (const forbidden of [
      "createBlindReviewArtifact",
      "projectBlindProposal",
      "createReviewerService",
      "readSubmissionRevision",
      "sealReviewArtifact",
    ]) {
      expect(forbidden in reviewerBarrel).toBe(false);
    }
  });
});
