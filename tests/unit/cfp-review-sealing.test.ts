import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "../../src/server/auth";
import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  BLIND_REVIEW_ATTESTATION,
  BLIND_REVIEW_DISCLOSURE_STAGE,
  type BlindFieldDecisionInput,
} from "../../src/server/services/cfp-review/artifact-types";
import { ReviewArtifactError } from "../../src/server/services/cfp-review/artifacts";
import * as organizerExports from "../../src/server/services/cfp-review/organizer";
import * as sealingExports from "../../src/server/services/cfp-review/organizer-sealing";
import {
  OrganizerSealingError,
  OrganizerSealingFatalError,
  sealBlindReviewArtifact,
  sealRubricSemantics,
  type BlindReviewArtifactSealReceipt,
  type SealBlindReviewArtifactInput,
  type SealRubricSemanticsInput,
} from "../../src/server/services/cfp-review/organizer";
import {
  createCall,
  createDraftSubmission,
  createFormDefinition,
  saveDraftRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import { submitSubmission } from "../../src/server/services/cfp/submissions";
import {
  runPersistentRaceActor,
  startPersistentRaceActors,
  stopPersistentRaceActors,
} from "./helpers/persistent-race-actor";

const CREATED_AT = "2026-08-10T00:00:00.000Z";
const ROUND_AT = "2026-08-10T01:00:00.000Z";
const ASSIGNED_AT = "2026-08-10T02:00:00.000Z";
const FUTURE_AT = "2099-08-10T00:00:00.000Z";
const SOURCE_SUMMARY = "Applicant Alice from Identifiable Incorporated";
const SOURCE_EMAIL = "alice.applicant@synthetic.example";
const SOURCE_HIDDEN_ORG = "Identifiable Incorporated";
const SOURCE_SKIPPED = "history that must not become review content";

const CRITERIA = Object.freeze([
  Object.freeze({
    semantic: "PROPOSAL_QUALITY" as const,
    kind: "scale" as const,
    required: true,
    weight: 1,
    scaleCode: "LOW_MEDIUM_HIGH" as const,
  }),
]);

type Fixture = Readonly<{
  db: Db;
  workspaceId: string;
  workspaceSlug: string;
  organizerAccountId: string;
  reviewerAccountId: string;
  successorReviewerAccountId: string;
  session: SessionInfo;
  formVersionId: string;
  ruleVersionId: string;
  submissionId: string;
  revisionId: string;
  revisionFingerprint: string;
  roundId: string;
  rubricVersionId: string;
  rubricFingerprint: string;
  assignmentId: string;
}>;

function workspace(db: Db, slug = "northstar"): { id: string; organizerAccountId: string } {
  const row = db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(slug) as
    | { id: string }
    | undefined;
  if (!row) throw new Error("missing synthetic workspace");
  const account = db
    .prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1")
    .get(row.id) as { id: string } | undefined;
  if (!account) throw new Error("missing synthetic organizer");
  return { id: row.id, organizerAccountId: account.id };
}

function buildFixture(db: Db): Fixture {
  const northstar = workspace(db);
  const workspaceId = northstar.id;
  const organizerAccountId = northstar.organizerAccountId;
  const reviewerAccountId = "sealing-reviewer";
  const successorReviewerAccountId = "sealing-successor-reviewer";
  db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, 'reviewer', ?), (?, ?, ?, ?, 'reviewer', ?)`,
  ).run(
    reviewerAccountId,
    workspaceId,
    "reviewer@sealing.synthetic.example",
    "Synthetic Reviewer",
    CREATED_AT,
    successorReviewerAccountId,
    workspaceId,
    "successor@sealing.synthetic.example",
    "Synthetic Successor Reviewer",
    CREATED_AT,
  );
  const { session } = createSession(db, organizerAccountId, workspaceId);

  const eventId = "sealing-event";
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES (?, ?, 'Sealing event', 'UTC', ?, ?, ?)`,
  ).run(
    eventId,
    workspaceId,
    "2026-09-15T09:00:00.000Z",
    "2026-09-15T10:00:00.000Z",
    CREATED_AT,
  );
  const organizer = { workspaceId, accountId: organizerAccountId };
  const definition = createFormDefinition(db, organizer, { name: "Sealing form" });
  const form = sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [
      {
        id: "summary",
        type: "shortText",
        label: "Source summary",
        required: true,
        defaultVisibility: "visible",
      },
      {
        id: "speakerEmail",
        type: "email",
        label: "Speaker email",
        required: false,
        defaultVisibility: "visible",
      },
      {
        id: "hiddenOrg",
        type: "shortText",
        label: "Source organization",
        required: false,
        defaultVisibility: "hidden",
      },
      {
        id: "skippedNote",
        type: "longText",
        label: "Skipped history",
        required: false,
        defaultVisibility: "visible",
      },
    ],
    rules: {
      schema: FORM_RULES_SCHEMA,
      rules: [
        {
          id: "show-hidden-org",
          condition: { kind: "field", fieldId: "summary", operator: "isNotEmpty" },
          actions: [{ type: "show", targetFieldId: "hiddenOrg" }],
        },
        {
          id: "skip-history-note",
          condition: { kind: "field", fieldId: "summary", operator: "isNotEmpty" },
          actions: [{ type: "skip", targetFieldId: "skippedNote" }],
        },
      ],
    },
  });
  const call = createCall(db, organizer, {
    eventId,
    name: "Sealing call",
    slug: "sealing-call",
    formVersionId: form.id,
    accessMode: "PUBLIC",
    state: "OPEN",
    policy: {
      disclosure: {
        privacy: "Synthetic privacy notice",
        retention: "Synthetic retention notice",
        aiProcessing: "Synthetic AI notice",
        communication: "Synthetic communication notice",
        consent: "Synthetic consent notice",
        publication: "Synthetic publication notice",
      },
      choices: [],
    },
  });
  const callCreatedAt = (
    db.prepare("SELECT created_at FROM calls WHERE id = ?").get(call.id) as {
      created_at: string;
    }
  ).created_at;

  const personId = "sealing-applicant-person";
  const verificationId = "sealing-applicant-verification";
  const applicantSessionId = "sealing-applicant-session";
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
     VALUES (?, ?, ?, 'Synthetic Applicant', ?)`,
  ).run(personId, workspaceId, SOURCE_EMAIL, callCreatedAt);
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verificationId,
    workspaceId,
    call.id,
    SOURCE_EMAIL,
    "a".repeat(64),
    FUTURE_AT,
    callCreatedAt,
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES ('sealing-applicant-consumption', ?, ?, ?, ?)`,
  ).run(workspaceId, verificationId, personId, callCreatedAt);
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    applicantSessionId,
    workspaceId,
    call.id,
    personId,
    verificationId,
    "b".repeat(64),
    callCreatedAt,
    FUTURE_AT,
  );
  const submission = createDraftSubmission(
    db,
    { workspaceId, sessionId: applicantSessionId },
    { callId: call.id },
  );
  const historicalAnswers = [
    { fieldId: "summary", value: SOURCE_SUMMARY },
    { fieldId: "speakerEmail", value: SOURCE_EMAIL },
    { fieldId: "hiddenOrg", value: SOURCE_HIDDEN_ORG },
    { fieldId: "skippedNote", value: SOURCE_SKIPPED },
  ];
  const saved = saveDraftRevision(
    db,
    { workspaceId, sessionId: applicantSessionId },
    {
      submissionId: submission.id,
      historicalAnswers,
      expectedCurrentRevisionId: null,
    },
  );
  const submitted = submitSubmission(db, {
    workspaceId,
    callId: call.id,
    sessionTokenHash: "b".repeat(64),
    submissionId: submission.id,
    historicalAnswers,
    expectedCurrentRevisionId: saved.revisionId,
  });
  const submittedRevision = db
    .prepare("SELECT fingerprint FROM submission_revisions WHERE id = ?")
    .get(submitted.revisionId) as { fingerprint: string } | undefined;
  if (!submittedRevision) throw new Error("missing submitted revision");

  const roundId = "sealing-round";
  const rubricVersionId = "sealing-rubric-v1";
  const rubricFingerprint = fingerprintOf({ rubric: "sealing-v1" });
  const assignmentId = "sealing-assignment";
  db.prepare(
    `INSERT INTO review_rounds
       (id, workspace_id, event_id, call_id, name, created_by, created_at)
     VALUES (?, ?, ?, ?, 'Sealing round', ?, ?)`,
  ).run(roundId, workspaceId, eventId, call.id, organizerAccountId, ROUND_AT);
  db.prepare(
    `INSERT INTO rubric_versions
       (id, workspace_id, round_id, version_number, rubric_schema, rubric_json,
        fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
     VALUES (?, ?, ?, 1, 'cfp-rubric/v1', '{}',
             'sha256-canonical-json-v1', ?, ?, ?)`,
  ).run(
    rubricVersionId,
    workspaceId,
    roundId,
    rubricFingerprint,
    organizerAccountId,
    ROUND_AT,
  );
  db.prepare(
    `INSERT INTO review_assignments
       (id, workspace_id, round_id, rubric_version_id, submission_id,
        submission_revision_id, reviewer_account_id, assigned_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    assignmentId,
    workspaceId,
    roundId,
    rubricVersionId,
    submission.id,
    submitted.revisionId,
    reviewerAccountId,
    organizerAccountId,
    ASSIGNED_AT,
  );
  return Object.freeze({
    db,
    workspaceId,
    workspaceSlug: "northstar",
    organizerAccountId,
    reviewerAccountId,
    successorReviewerAccountId,
    session,
    formVersionId: form.id,
    ruleVersionId: form.ruleVersion.id,
    submissionId: submission.id,
    revisionId: submitted.revisionId,
    revisionFingerprint: submittedRevision.fingerprint,
    roundId,
    rubricVersionId,
    rubricFingerprint,
    assignmentId,
  });
}

function fixture(path = ":memory:"): Fixture {
  const db = openDb({ path });
  try {
    return buildFixture(db);
  } catch (error) {
    closeDb(db);
    throw error;
  }
}

function rubricInput(data: Fixture, overrides: Partial<SealRubricSemanticsInput> = {}) {
  return {
    workspaceSlug: data.workspaceSlug,
    rubricVersionId: data.rubricVersionId,
    expectedRubricFingerprint: data.rubricFingerprint,
    idempotencyKey: "seal-rubric-key",
    criteria: CRITERIA,
    ...overrides,
  } satisfies SealRubricSemanticsInput;
}

function decisions(): readonly BlindFieldDecisionInput[] {
  return [
    {
      sourceFieldId: "summary",
      action: "INCLUDE_REDACTED",
      reviewLabel: "Proposal summary",
      redactedValue: "A deliberately redacted proposal summary",
    },
    { sourceFieldId: "speakerEmail", action: "EXCLUDE" },
    {
      sourceFieldId: "hiddenOrg",
      action: "INCLUDE_REDACTED",
      reviewLabel: "Organization context",
      redactedValue: "A deliberately generalized organization",
    },
  ];
}

function artifactInput(
  data: Fixture,
  overrides: Partial<SealBlindReviewArtifactInput> = {},
): SealBlindReviewArtifactInput {
  return {
    workspaceSlug: data.workspaceSlug,
    assignmentId: data.assignmentId,
    expectedSubmissionRevisionId: data.revisionId,
    expectedSubmissionRevisionFingerprint: data.revisionFingerprint,
    expectedConflictSequence: 0,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    attestation: BLIND_REVIEW_ATTESTATION,
    idempotencyKey: "seal-artifact-key",
    decisions: decisions(),
    ...overrides,
  };
}

function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}

function captureWithFatalConnectionRetirement(
  db: Db,
  action: () => unknown,
): Readonly<{ error: unknown; retired: boolean }> {
  const error = capture(action);
  if (!(error instanceof OrganizerSealingFatalError)) {
    return Object.freeze({ error, retired: false });
  }
  closeDb(db);
  return Object.freeze({ error, retired: true });
}

function expectConnectionRetired(db: Db): void {
  expect(capture(() => db.prepare("SELECT 1"))).toMatchObject({
    code: "ERR_INVALID_STATE",
  });
}

function expectSealingError(action: () => unknown, code: OrganizerSealingError["code"]): void {
  const error = capture(action);
  expect(error).toBeInstanceOf(OrganizerSealingError);
  expect((error as OrganizerSealingError).code).toBe(code);
}

function sealFixtureSemantics(data: Fixture) {
  return sealRubricSemantics(data.db, data.session, rubricInput(data));
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function closeRound(data: Fixture): void {
  data.db.prepare(
    `INSERT INTO review_round_states
       (id, workspace_id, round_id, state, sequence_number, actor_account_id, created_at)
     VALUES ('sealing-round-open', ?, ?, 'OPEN', 2, ?, '2026-08-10T03:00:00.000Z')`,
  ).run(data.workspaceId, data.roundId, data.organizerAccountId);
  data.db.prepare(
    `INSERT INTO review_round_states
       (id, workspace_id, round_id, state, sequence_number, actor_account_id, created_at)
     VALUES ('sealing-round-closed', ?, ?, 'CLOSED', 3, ?, '2026-08-10T04:00:00.000Z')`,
  ).run(data.workspaceId, data.roundId, data.organizerAccountId);
}

function declareConflict(data: Fixture): void {
  data.db.prepare(
    `INSERT INTO review_conflict_dispositions
       (id, workspace_id, assignment_id, action, sequence_number, actor_account_id,
        actor_role_basis, reason, created_at)
     VALUES ('sealing-conflict-declare', ?, ?, 'DECLARE', 1, ?, 'reviewer',
             'synthetic conflict', '2026-08-10T03:00:00.000Z')`,
  ).run(data.workspaceId, data.assignmentId, data.reviewerAccountId);
}

function clearConflict(data: Fixture): void {
  declareConflict(data);
  data.db.prepare(
    `INSERT INTO review_conflict_dispositions
       (id, workspace_id, assignment_id, action, sequence_number, actor_account_id,
        actor_role_basis, reason, created_at)
     VALUES ('sealing-conflict-clear', ?, ?, 'CLEAR', 2, ?, 'organizer',
             'synthetic clearance', '2026-08-10T04:00:00.000Z')`,
  ).run(data.workspaceId, data.assignmentId, data.organizerAccountId);
}

function trackPreparedSql(db: Db, statements: string[]): Db {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

describe("organizer rubric semantics sealing", () => {
  it("seals once, replays exactly, conflicts changed same-key input, and denies a new key", () => {
    const data = fixture();
    try {
      const first = sealRubricSemantics(data.db, data.session, rubricInput(data));
      expect(first).toMatchObject({
        rubricVersionId: data.rubricVersionId,
        rubricVersionNumber: 1,
        replayed: false,
      });
      expect(count(data.db, "review_rubric_semantics")).toBe(1);
      expect(count(data.db, "audit_events")).toBe(1);

      const replay = sealRubricSemantics(data.db, data.session, rubricInput(data));
      expect(replay).toEqual({ ...first, replayed: true });
      expect(count(data.db, "review_rubric_semantics")).toBe(1);
      expect(count(data.db, "audit_events")).toBe(1);

      expectSealingError(
        () =>
          sealRubricSemantics(
            data.db,
            data.session,
            rubricInput(data, {
              criteria: [{ ...CRITERIA[0], weight: 2 }],
            }),
          ),
        "SEAL_IDEMPOTENCY_CONFLICT",
      );
      expectSealingError(
        () =>
          sealRubricSemantics(
            data.db,
            data.session,
            rubricInput(data, { idempotencyKey: "different-rubric-key" }),
          ),
        "RUBRIC_SEMANTICS_IMMUTABLE",
      );
      expectSealingError(
        () =>
          sealRubricSemantics(
            data.db,
            data.session,
            rubricInput(data, {
              expectedRubricFingerprint: "f".repeat(64),
              idempotencyKey: "different-stale-rubric-key",
            }),
          ),
        "RUBRIC_SEMANTICS_IMMUTABLE",
      );

      closeRound(data);
      expect(sealRubricSemantics(data.db, data.session, rubricInput(data))).toEqual({
        ...first,
        replayed: true,
      });
    } finally {
      closeDb(data.db);
    }
  });

  it("rehydrates current stored session, workspace, role, expiry, and revocation before targets", () => {
    const cases: Array<{
      mutate(data: Fixture): SessionInfo;
      input(data: Fixture): SealRubricSemanticsInput;
    }> = [
      {
        mutate(data) {
          data.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(
            "2020-01-01T00:00:00.000Z",
            data.session.id,
          );
          return data.session;
        },
        input: rubricInput,
      },
      {
        mutate(data) {
          data.db.prepare("DELETE FROM sessions WHERE id = ?").run(data.session.id);
          return data.session;
        },
        input: rubricInput,
      },
      {
        mutate(data) {
          data.db.prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?").run(
            data.organizerAccountId,
          );
          return { ...data.session, role: "organizer" };
        },
        input: rubricInput,
      },
      {
        mutate(data) {
          return createSession(data.db, data.reviewerAccountId, data.workspaceId).session;
        },
        input: rubricInput,
      },
      {
        mutate(data) {
          return data.session;
        },
        input(data) {
          return rubricInput(data, { workspaceSlug: "acme" });
        },
      },
      {
        mutate(data) {
          const acme = workspace(data.db, "acme");
          return createSession(data.db, acme.organizerAccountId, acme.id).session;
        },
        input: rubricInput,
      },
    ];

    for (const testCase of cases) {
      const data = fixture();
      try {
        const session = testCase.mutate(data);
        expectSealingError(
          () => sealRubricSemantics(data.db, session, testCase.input(data)),
          "SEAL_AUTHORIZATION_DENIED",
        );
        expect(count(data.db, "review_rubric_semantics")).toBe(0);
        expect(count(data.db, "audit_events")).toBe(0);
      } finally {
        closeDb(data.db);
      }
    }
  });

  it("rejects stale rubric, closed round, caller transactions, and audit failure atomically", () => {
    const stale = fixture();
    try {
      expectSealingError(
        () =>
          sealRubricSemantics(
            stale.db,
            stale.session,
            rubricInput(stale, { expectedRubricFingerprint: "f".repeat(64) }),
          ),
        "RUBRIC_VERSION_STALE",
      );
      expect(count(stale.db, "review_rubric_semantics")).toBe(0);
    } finally {
      closeDb(stale.db);
    }

    const closed = fixture();
    try {
      closeRound(closed);
      expectSealingError(
        () => sealRubricSemantics(closed.db, closed.session, rubricInput(closed)),
        "REVIEW_ROUND_NOT_SEALABLE",
      );
      expect(count(closed.db, "review_rubric_semantics")).toBe(0);
    } finally {
      closeDb(closed.db);
    }

    const outer = fixture();
    try {
      outer.db.exec("BEGIN IMMEDIATE");
      expectSealingError(
        () => sealRubricSemantics(outer.db, outer.session, rubricInput(outer)),
        "SEAL_OUTER_TRANSACTION_FORBIDDEN",
      );
      expect(outer.db.isTransaction).toBe(true);
      expect(count(outer.db, "review_rubric_semantics")).toBe(0);
      outer.db.exec("ROLLBACK");
    } finally {
      if (outer.db.isTransaction) outer.db.exec("ROLLBACK");
      closeDb(outer.db);
    }

    const auditFailure = fixture();
    try {
      auditFailure.db.exec(
        `CREATE TRIGGER sealing_audit_failure BEFORE INSERT ON audit_events
         BEGIN SELECT RAISE(ABORT, 'synthetic audit fault'); END`,
      );
      expectSealingError(
        () =>
          sealRubricSemantics(
            auditFailure.db,
            auditFailure.session,
            rubricInput(auditFailure),
          ),
        "SEAL_WRITE_FAILED",
      );
      expect(count(auditFailure.db, "review_rubric_semantics")).toBe(0);
      expect(count(auditFailure.db, "audit_events")).toBe(0);
    } finally {
      closeDb(auditFailure.db);
    }
  });

  it("retains the original issuer snapshot when the organizer role later changes", () => {
    const data = fixture();
    try {
      const receipt = sealFixtureSemantics(data);
      const before = data.db
        .prepare("SELECT * FROM review_rubric_semantics WHERE id = ?")
        .get(receipt.semanticsId);
      data.db.prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?").run(
        data.organizerAccountId,
      );
      expectSealingError(
        () => sealRubricSemantics(data.db, data.session, rubricInput(data)),
        "SEAL_AUTHORIZATION_DENIED",
      );
      expect(
        data.db.prepare("SELECT * FROM review_rubric_semantics WHERE id = ?").get(
          receipt.semanticsId,
        ),
      ).toEqual(before);
    } finally {
      closeDb(data.db);
    }
  });

  it("raises a fatal stop when rollback cleanup remains indeterminate", () => {
    const data = fixture();
    try {
      data.db.exec(
        `CREATE TRIGGER sealing_fatal_audit_failure BEFORE INSERT ON audit_events
         BEGIN SELECT RAISE(ABORT, 'synthetic fatal audit fault'); END`,
      );
      const blockedRollback = new Proxy(data.db, {
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
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;
      const error = capture(() =>
        sealRubricSemantics(blockedRollback, data.session, rubricInput(data)),
      );
      expect(error).toBeInstanceOf(OrganizerSealingFatalError);
      expect((error as OrganizerSealingFatalError).fatal).toBe(true);
      expect(data.db.isTransaction).toBe(true);
      data.db.exec("ROLLBACK");
      expect(count(data.db, "review_rubric_semantics")).toBe(0);
      expect(count(data.db, "audit_events")).toBe(0);
    } finally {
      if (data.db.isTransaction) data.db.exec("ROLLBACK");
      closeDb(data.db);
    }
  });

  it("never returns success when COMMIT throws after the transaction has ended", () => {
    const data = fixture();
    try {
      const rollbackThenThrow = new Proxy(data.db, {
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

      const error = capture(() =>
        sealRubricSemantics(rollbackThenThrow, data.session, rubricInput(data)),
      );
      expect(error).toBeInstanceOf(OrganizerSealingFatalError);
      expect((error as OrganizerSealingFatalError).fatal).toBe(true);
      expect(data.db.isTransaction).toBe(false);
      expect(count(data.db, "review_rubric_semantics")).toBe(0);
      expect(count(data.db, "audit_events")).toBe(0);
    } finally {
      if (data.db.isTransaction) data.db.exec("ROLLBACK");
      closeDb(data.db);
    }
  });

  it("fails fatally and retires the connection when state is unreadable after COMMIT throws", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sympose-sealing-fatal-commit-"));
    const databasePath = resolve(directory, "commit.db");
    const data = fixture(databasePath);
    let retired = false;
    try {
      let poisonStateProbe = false;
      const committedThenUnreadable = new Proxy(data.db, {
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

      const outcome = captureWithFatalConnectionRetirement(
        committedThenUnreadable,
        () =>
          sealRubricSemantics(
            committedThenUnreadable,
            data.session,
            rubricInput(data, { idempotencyKey: "seal-rubric-unreadable-commit" }),
          ),
      );
      retired = outcome.retired;
      expect(outcome.error).toBeInstanceOf(OrganizerSealingFatalError);
      expect((outcome.error as OrganizerSealingFatalError).fatal).toBe(true);
      expect(retired).toBe(true);
      expectConnectionRetired(data.db);

      const verification = openDb({ path: databasePath });
      try {
        expect(count(verification, "review_rubric_semantics")).toBe(1);
        expect(count(verification, "audit_events")).toBe(1);
      } finally {
        closeDb(verification);
      }
    } finally {
      if (!retired) closeDb(data.db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails fatally and retires the connection after partial writes make rollback uncertain", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sympose-sealing-fatal-rollback-"));
    const databasePath = resolve(directory, "rollback.db");
    const data = fixture(databasePath);
    let retired = false;
    try {
      let poisonStateProbe = false;
      let partialWriteFaulted = false;
      let rollbackFaulted = false;
      const unreadableAfterRollbackFault = new Proxy(data.db, {
        get(target, property) {
          if (property === "isTransaction" && poisonStateProbe) {
            throw new Error("synthetic transaction-state probe fault");
          }
          if (property === "exec") {
            return (sql: string) => {
              if (sql.trim() === "ROLLBACK") {
                rollbackFaulted = true;
                poisonStateProbe = true;
                throw new Error("synthetic rollback outcome loss");
              }
              target.exec(sql);
            };
          }
          if (property === "prepare") {
            return (sql: string) => {
              if (/FROM audit_events ORDER BY rowid DESC LIMIT 1/u.test(sql)) {
                partialWriteFaulted = true;
                throw new Error("synthetic post-audit write fault");
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;

      const outcome = captureWithFatalConnectionRetirement(
        unreadableAfterRollbackFault,
        () =>
          sealRubricSemantics(
            unreadableAfterRollbackFault,
            data.session,
            rubricInput(data, { idempotencyKey: "seal-rubric-unreadable-rollback" }),
          ),
      );
      retired = outcome.retired;
      expect(partialWriteFaulted).toBe(true);
      expect(rollbackFaulted).toBe(true);
      expect(outcome.error).toBeInstanceOf(OrganizerSealingFatalError);
      expect((outcome.error as OrganizerSealingFatalError).fatal).toBe(true);
      expect(retired).toBe(true);
      expectConnectionRetired(data.db);

      const verification = openDb({ path: databasePath });
      try {
        expect(count(verification, "review_rubric_semantics")).toBe(0);
        expect(count(verification, "audit_events")).toBe(0);
      } finally {
        closeDb(verification);
      }
    } finally {
      if (!retired) closeDb(data.db);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("organizer blind artifact sealing", () => {
  it("seals complete include/exclude coverage, preserves hidden effective input, and replays", () => {
    const data = fixture();
    try {
      sealFixtureSemantics(data);
      const first = sealBlindReviewArtifact(data.db, data.session, artifactInput(data));
      expect(first).toMatchObject({
        assignmentId: data.assignmentId,
        submissionRevisionId: data.revisionId,
        stage: BLIND_REVIEW_DISCLOSURE_STAGE,
        includedCount: 2,
        excludedCount: 1,
        replayed: false,
      });
      const replay = sealBlindReviewArtifact(data.db, data.session, artifactInput(data));
      expect(replay).toEqual({ ...first, replayed: true });
      expect(count(data.db, "review_blind_artifacts")).toBe(1);
      expect(count(data.db, "audit_events")).toBe(2);

      const artifactRow = data.db
        .prepare("SELECT artifact_json FROM review_blind_artifacts WHERE id = ?")
        .get(first.artifactId) as { artifact_json: string };
      const artifact = JSON.parse(artifactRow.artifact_json) as {
        items: Array<{ sourceFieldId: string; disposition: string; value: unknown }>;
      };
      expect(artifact.items.find((item) => item.sourceFieldId === "hiddenOrg")).toMatchObject({
        disposition: "INCLUDE_REDACTED",
        value: "A deliberately generalized organization",
      });
      expect(artifact.items.some((item) => item.sourceFieldId === "skippedNote")).toBe(false);

      expectSealingError(
        () =>
          sealBlindReviewArtifact(
            data.db,
            data.session,
            artifactInput(data, {
              decisions: decisions().map((decision) =>
                decision.sourceFieldId === "summary" &&
                decision.action === "INCLUDE_REDACTED"
                  ? { ...decision, redactedValue: "changed redaction" }
                  : decision,
              ),
            }),
          ),
        "SEAL_IDEMPOTENCY_CONFLICT",
      );
      expectSealingError(
        () =>
          sealBlindReviewArtifact(
            data.db,
            data.session,
            artifactInput(data, { idempotencyKey: "different-artifact-key" }),
          ),
        "BLIND_ARTIFACT_IMMUTABLE",
      );
      expectSealingError(
        () =>
          sealBlindReviewArtifact(
            data.db,
            data.session,
            artifactInput(data, {
              idempotencyKey: "different-stale-artifact-key",
              expectedSubmissionRevisionId: "different-revision",
            }),
          ),
        "BLIND_ARTIFACT_IMMUTABLE",
      );

      closeRound(data);
      data.db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number,
            actor_account_id, created_at)
         VALUES ('sealed-assignment-revoked', ?, ?, 'REVOKED', 2, ?, ?)`,
      ).run(
        data.workspaceId,
        data.assignmentId,
        data.organizerAccountId,
        "2026-08-10T05:00:00.000Z",
      );
      expect(sealBlindReviewArtifact(data.db, data.session, artifactInput(data))).toEqual({
        ...first,
        replayed: true,
      });
    } finally {
      closeDb(data.db);
    }
  });

  it("rejects missing semantics, stale revision identity/fingerprint, closed and revoked targets", () => {
    const missing = fixture();
    try {
      expectSealingError(
        () => sealBlindReviewArtifact(missing.db, missing.session, artifactInput(missing)),
        "RUBRIC_SEMANTICS_MISSING",
      );
      expect(count(missing.db, "review_blind_artifacts")).toBe(0);
    } finally {
      closeDb(missing.db);
    }

    const staleId = fixture();
    try {
      sealFixtureSemantics(staleId);
      expectSealingError(
        () =>
          sealBlindReviewArtifact(
            staleId.db,
            staleId.session,
            artifactInput(staleId, { expectedSubmissionRevisionId: "other-revision" }),
          ),
        "SUBMISSION_REVISION_STALE",
      );
    } finally {
      closeDb(staleId.db);
    }

    const staleFingerprint = fixture();
    try {
      sealFixtureSemantics(staleFingerprint);
      expectSealingError(
        () =>
          sealBlindReviewArtifact(
            staleFingerprint.db,
            staleFingerprint.session,
            artifactInput(staleFingerprint, {
              expectedSubmissionRevisionFingerprint: "e".repeat(64),
            }),
          ),
        "SUBMISSION_REVISION_STALE",
      );
    } finally {
      closeDb(staleFingerprint.db);
    }

    const draftSubmission = fixture();
    try {
      sealFixtureSemantics(draftSubmission);
      draftSubmission.db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      draftSubmission.db.prepare("UPDATE submissions SET state = 'DRAFT' WHERE id = ?")
        .run(draftSubmission.submissionId);
      expectSealingError(
        () =>
          sealBlindReviewArtifact(
            draftSubmission.db,
            draftSubmission.session,
            artifactInput(draftSubmission),
          ),
        "REVIEW_ASSIGNMENT_NOT_SEALABLE",
      );
      expect(count(draftSubmission.db, "review_blind_artifacts")).toBe(0);
    } finally {
      closeDb(draftSubmission.db);
    }

    const closed = fixture();
    try {
      sealFixtureSemantics(closed);
      closeRound(closed);
      expectSealingError(
        () => sealBlindReviewArtifact(closed.db, closed.session, artifactInput(closed)),
        "REVIEW_ROUND_NOT_SEALABLE",
      );
    } finally {
      closeDb(closed.db);
    }

    const revoked = fixture();
    try {
      sealFixtureSemantics(revoked);
      revoked.db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number,
            actor_account_id, created_at)
         VALUES ('sealing-assignment-revoked', ?, ?, 'REVOKED', 2, ?, ?)`,
      ).run(
        revoked.workspaceId,
        revoked.assignmentId,
        revoked.organizerAccountId,
        "2026-08-10T03:00:00.000Z",
      );
      expectSealingError(
        () => sealBlindReviewArtifact(revoked.db, revoked.session, artifactInput(revoked)),
        "REVIEW_ASSIGNMENT_NOT_SEALABLE",
      );
    } finally {
      closeDb(revoked.db);
    }
  });

  it("rejects a superseded assignment and every incomplete or unsafe decision set", () => {
    const superseded = fixture();
    try {
      sealFixtureSemantics(superseded);
      superseded.db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number,
            actor_account_id, created_at)
         VALUES ('sealing-assignment-recused', ?, ?, 'RECUSED', 2, ?, ?)`,
      ).run(
        superseded.workspaceId,
        superseded.assignmentId,
        superseded.reviewerAccountId,
        "2026-08-10T03:00:00.000Z",
      );
      superseded.db.prepare(
        `INSERT INTO review_assignments
           (id, workspace_id, round_id, rubric_version_id, submission_id,
            submission_revision_id, reviewer_account_id, assigned_by,
            supersedes_assignment_id, created_at)
         VALUES ('sealing-assignment-successor', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        superseded.workspaceId,
        superseded.roundId,
        superseded.rubricVersionId,
        superseded.submissionId,
        superseded.revisionId,
        superseded.successorReviewerAccountId,
        superseded.organizerAccountId,
        superseded.assignmentId,
        "2026-08-10T04:00:00.000Z",
      );
      expectSealingError(
        () =>
          sealBlindReviewArtifact(
            superseded.db,
            superseded.session,
            artifactInput(superseded),
          ),
        "REVIEW_ASSIGNMENT_NOT_SEALABLE",
      );
    } finally {
      closeDb(superseded.db);
    }

    const data = fixture();
    try {
      sealFixtureSemantics(data);
      const variants: Array<{
        expectedCode: string;
        decisions: readonly BlindFieldDecisionInput[];
      }> = [
        { expectedCode: "ARTIFACT_DECISION_MISSING", decisions: decisions().slice(1) },
        {
          expectedCode: "ARTIFACT_DECISION_DUPLICATE",
          decisions: [...decisions(), decisions()[0]!],
        },
        {
          expectedCode: "ARTIFACT_DECISION_UNKNOWN",
          decisions: [...decisions(), { sourceFieldId: "unknownField", action: "EXCLUDE" }],
        },
        {
          expectedCode: "ARTIFACT_DECISION_UNKNOWN",
          decisions: [...decisions(), { sourceFieldId: "skippedNote", action: "EXCLUDE" }],
        },
        {
          expectedCode: "ARTIFACT_STRUCTURAL_INCLUDE_FORBIDDEN",
          decisions: decisions().map((decision) =>
            decision.sourceFieldId === "speakerEmail"
              ? {
                  sourceFieldId: "speakerEmail",
                  action: "INCLUDE_REDACTED" as const,
                  reviewLabel: "Contact",
                  redactedValue: "redacted@synthetic.example",
                }
              : decision,
          ),
        },
        {
          expectedCode: "ARTIFACT_ITEM_INVALID",
          decisions: decisions().map((decision) =>
            decision.sourceFieldId === "summary" &&
            decision.action === "INCLUDE_REDACTED"
              ? { ...decision, reviewLabel: "" }
              : decision,
          ),
        },
        {
          expectedCode: "ARTIFACT_REDACTED_VALUE_INVALID",
          decisions: decisions().map((decision) =>
            decision.sourceFieldId === "summary" &&
            decision.action === "INCLUDE_REDACTED"
              ? { ...decision, redactedValue: 42 }
              : decision,
          ),
        },
      ];
      for (const [index, variant] of variants.entries()) {
        const error = capture(() =>
          sealBlindReviewArtifact(
            data.db,
            data.session,
            artifactInput(data, {
              idempotencyKey: `invalid-decisions-${index}`,
              decisions: variant.decisions,
            }),
          ),
        );
        expect(error).toBeInstanceOf(ReviewArtifactError);
        expect((error as ReviewArtifactError).code).toBe(variant.expectedCode);
        expect(count(data.db, "review_blind_artifacts")).toBe(0);
        expect(count(data.db, "audit_events")).toBe(1);
      }
    } finally {
      closeDb(data.db);
    }
  });

  it("denies declared and stale conflicts before any revision, form, or answer read", () => {
    const declared = fixture();
    try {
      sealFixtureSemantics(declared);
      declareConflict(declared);
      const statements: string[] = [];
      const tracked = trackPreparedSql(declared.db, statements);
      expectSealingError(
        () =>
          sealBlindReviewArtifact(
            tracked,
            declared.session,
            artifactInput(declared, { expectedConflictSequence: 1 }),
          ),
        "REVIEW_CONFLICT_DECLARED",
      );
      expect(
        statements.some((sql) =>
          /\b(submission_revisions|form_versions|rule_versions)\b/u.test(sql),
        ),
      ).toBe(false);
      expect(count(declared.db, "review_blind_artifacts")).toBe(0);
    } finally {
      closeDb(declared.db);
    }

    const stale = fixture();
    try {
      sealFixtureSemantics(stale);
      clearConflict(stale);
      const statements: string[] = [];
      const tracked = trackPreparedSql(stale.db, statements);
      expectSealingError(
        () =>
          sealBlindReviewArtifact(
            tracked,
            stale.session,
            artifactInput(stale, { expectedConflictSequence: 1 }),
          ),
        "REVIEW_CONFLICT_STALE",
      );
      expect(
        statements.some((sql) =>
          /\b(submission_revisions|form_versions|rule_versions)\b/u.test(sql),
        ),
      ).toBe(false);
    } finally {
      closeDb(stale.db);
    }
  });

  it("binds the exact latest cleared conflict metadata on a successful seal", () => {
    const data = fixture();
    try {
      sealFixtureSemantics(data);
      clearConflict(data);
      const receipt = sealBlindReviewArtifact(
        data.db,
        data.session,
        artifactInput(data, { expectedConflictSequence: 2 }),
      );
      const row = data.db
        .prepare(
          `SELECT conflict_status_at_issuance, conflict_sequence_at_issuance,
                  artifact_json
           FROM review_blind_artifacts WHERE id = ?`,
        )
        .get(receipt.artifactId) as Record<string, unknown>;
      expect(row.conflict_status_at_issuance).toBe("CLEARED");
      expect(row.conflict_sequence_at_issuance).toBe(2);
      expect(JSON.parse(row.artifact_json as string)).toMatchObject({
        conflictAtIssuance: { status: "CLEARED", sequenceNumber: 2 },
      });
    } finally {
      closeDb(data.db);
    }
  });

  it("rolls artifact and audit back together when the real audit path fails", () => {
    const data = fixture();
    try {
      sealFixtureSemantics(data);
      const auditBefore = count(data.db, "audit_events");
      data.db.exec(
        `CREATE TRIGGER sealing_artifact_audit_failure BEFORE INSERT ON audit_events
         BEGIN SELECT RAISE(ABORT, 'synthetic artifact audit fault'); END`,
      );
      expectSealingError(
        () => sealBlindReviewArtifact(data.db, data.session, artifactInput(data)),
        "SEAL_WRITE_FAILED",
      );
      expect(count(data.db, "review_blind_artifacts")).toBe(0);
      expect(count(data.db, "audit_events")).toBe(auditBefore);
    } finally {
      closeDb(data.db);
    }
  });
});

describe("bounded evidence and organizer-only exports", () => {
  it("rejects proxies and accessors during detached preflight without invoking getters", () => {
    const data = fixture();
    try {
      let calls = 0;
      const hostile = { ...rubricInput(data) } as Record<string, unknown>;
      Object.defineProperty(hostile, "criteria", {
        enumerable: true,
        get() {
          calls += 1;
          return CRITERIA;
        },
      });
      expectSealingError(
        () =>
          sealRubricSemantics(
            data.db,
            data.session,
            hostile as unknown as SealRubricSemanticsInput,
          ),
        "SEAL_INPUT_INVALID",
      );
      expect(calls).toBe(0);
      expectSealingError(
        () =>
          sealRubricSemantics(
            data.db,
            new Proxy(data.session, {}),
            rubricInput(data),
          ),
        "SEAL_INPUT_INVALID",
      );
      expect(count(data.db, "review_rubric_semantics")).toBe(0);
      expect(count(data.db, "audit_events")).toBe(0);
    } finally {
      closeDb(data.db);
    }
  });

  it("keeps receipts, audits, and errors free of source values, field IDs, fingerprints, and identity", () => {
    const data = fixture();
    try {
      const semanticsReceipt = sealFixtureSemantics(data);
      const artifactReceipt = sealBlindReviewArtifact(data.db, data.session, artifactInput(data));
      const error = capture(() =>
        sealBlindReviewArtifact(
          data.db,
          data.session,
          artifactInput(data, {
            decisions: decisions().slice(1),
            idempotencyKey: "safety-error-key",
          }),
        ),
      );
      const audits = data.db
        .prepare(
          `SELECT actor_kind, actor_ref, action, target_type, target_id, details_json
           FROM audit_events ORDER BY rowid`,
        )
        .all();
      const serialized = JSON.stringify({
        semanticsReceipt,
        artifactReceipt,
        audits,
        error: {
          name: (error as Error).name,
          message: (error as Error).message,
          code: (error as { code?: unknown }).code,
        },
      });
      for (const forbidden of [
        SOURCE_SUMMARY,
        SOURCE_EMAIL,
        SOURCE_HIDDEN_ORG,
        SOURCE_SKIPPED,
        "summary",
        "speakerEmail",
        "hiddenOrg",
        "skippedNote",
        data.rubricFingerprint,
        data.revisionFingerprint,
        data.session.tokenHash,
        "sealing-applicant-person",
        data.submissionId,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      for (const audit of audits as Array<{ details_json: string }>) {
        const details = JSON.parse(audit.details_json) as Record<string, unknown>;
        expect(Object.keys(details).sort()).toEqual(
          details.operation === "seal_rubric_semantics"
            ? ["criteriaCount", "objectKind", "operation", "status"]
            : ["excludedCount", "includedCount", "objectKind", "operation", "status"],
        );
      }
    } finally {
      closeDb(data.db);
    }
  });

  it("exports only organizer capabilities and no factory or reviewer-barrel path", () => {
    expect(Object.keys(sealingExports).sort()).toEqual(
      [
        "OrganizerSealingError",
        "OrganizerSealingFatalError",
        "sealBlindReviewArtifact",
        "sealRubricSemantics",
      ].sort(),
    );
    expect(Object.keys(organizerExports).sort()).toEqual(
      [
        "OrganizerReviewServiceError",
        "OrganizerSealingError",
        "OrganizerSealingFatalError",
        "createOrganizerReviewRound",
        "createOrganizerReviewRubric",
        "distributeOrganizerReviewAssignments",
        "exportOrganizerReview",
        "organizerReviewRoundFingerprint",
        "organizerReviewScheduleSummary",
        "readOrganizerReviewSurface",
        "recordOrganizerReviewReminders",
        "recuseOrganizerReviewAssignment",
        "sealBlindReviewArtifact",
        "sealRubricSemantics",
        "setOrganizerReviewRoundSchedule",
        "setOrganizerReviewRoundState",
      ].sort(),
    );
    expect(
      Object.keys(sealingExports).some((key) =>
        /(factory|dependencies|forTest)/iu.test(key),
      ),
    ).toBe(false);
    const reviewerBarrel = resolve("src/server/services/cfp-review/index.ts");
    if (existsSync(reviewerBarrel)) {
      const source = readFileSync(reviewerBarrel, "utf8");
      expect(source).not.toMatch(/organizer|sealRubricSemantics|sealBlindReviewArtifact/u);
    }
  });
});

function sessionFromStoredState(db: Db): SessionInfo {
  const row = db
    .prepare(
      `SELECT s.id, s.token_hash, s.account_id, s.workspace_id, s.expires_at,
              a.email, a.display_name, a.role, w.slug, w.name
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id AND a.workspace_id = s.workspace_id
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE a.role = 'organizer' AND w.slug = 'northstar'
       ORDER BY s.rowid LIMIT 1`,
    )
    .get() as Record<string, string> | undefined;
  if (!row) throw new Error("missing race session");
  return {
    id: row.id!,
    tokenHash: row.token_hash!,
    accountId: row.account_id!,
    workspaceId: row.workspace_id!,
    expiresAt: row.expires_at!,
    email: row.email!,
    displayName: row.display_name!,
    role: row.role!,
    workspaceSlug: row.slug!,
    workspaceName: row.name!,
  };
}

describe("real-connection race worker", () => {
  it("race worker process", () => {
    if (process.env.SYMPOSE_PERSISTENT_RACE_ACTOR !== "1") return;
    return runPersistentRaceActor(() => {
      const raceMode = process.env.SYMPOSE_SEAL_RACE_MODE;
      if (raceMode !== "semantics" && raceMode !== "artifact") {
        throw new Error("missing race worker mode");
      }
      const databasePath = process.env.SYMPOSE_SEAL_RACE_DB;
      const resultPath = process.env.SYMPOSE_SEAL_RACE_RESULT;
      if (!databasePath || !resultPath) throw new Error("missing race worker configuration");
      const db = openDb({ path: databasePath });
      try {
      const stored = db
        .prepare(
          `SELECT w.id AS workspace_id, rubric.id AS rubric_id, rubric.fingerprint,
                  assignment.id AS assignment_id, assignment.submission_revision_id,
                  revision.fingerprint AS revision_fingerprint
           FROM workspaces w
           JOIN rubric_versions rubric ON rubric.workspace_id = w.id
           JOIN review_assignments assignment
             ON assignment.workspace_id = w.id AND assignment.rubric_version_id = rubric.id
           JOIN submission_revisions revision
             ON revision.id = assignment.submission_revision_id
            AND revision.workspace_id = assignment.workspace_id
           WHERE w.slug = 'northstar' LIMIT 1`,
        )
        .get() as Record<string, string> | undefined;
      if (!stored) throw new Error("missing race fixture");
      const session = sessionFromStoredState(db);
      const receipt =
        raceMode === "semantics"
          ? sealRubricSemantics(db, session, {
              workspaceSlug: "northstar",
              rubricVersionId: stored.rubric_id!,
              expectedRubricFingerprint: stored.fingerprint!,
              idempotencyKey: "race-semantics-key",
              criteria: CRITERIA,
            })
          : sealBlindReviewArtifact(db, session, {
              workspaceSlug: "northstar",
              assignmentId: stored.assignment_id!,
              expectedSubmissionRevisionId: stored.submission_revision_id!,
              expectedSubmissionRevisionFingerprint: stored.revision_fingerprint!,
              expectedConflictSequence: 0,
              stage: BLIND_REVIEW_DISCLOSURE_STAGE,
              attestation: BLIND_REVIEW_ATTESTATION,
              idempotencyKey: "race-artifact-key",
              decisions: decisions(),
            });
      writeFileSync(resultPath, canonicalJson(receipt), "utf8");
      } finally {
        closeDb(db);
      }
    });
  });
});

describe("two-connection sealing convergence", () => {
  it(
    "converges simultaneous semantics and artifact requests on one row, audit, and effect receipt",
    async () => {
      const directory = mkdtempSync(resolve(tmpdir(), "sympose-sealing-race-"));
      const databasePath = resolve(directory, "race.db");
      const setup = fixture(databasePath);
      closeDb(setup.db);
      let actors: Awaited<ReturnType<typeof startPersistentRaceActors>> | undefined;
      try {
        actors = await startPersistentRaceActors({
          testFile: "tests/unit/cfp-review-sealing.test.ts",
          testName: "race worker process",
        });
        const runRaceWorker = (
          mode: "semantics" | "artifact",
          role: "a" | "b",
          resultPath: string,
        ): Promise<number> =>
          actors![role === "a" ? 0 : 1]!.request({
            SYMPOSE_SEAL_RACE_MODE: mode,
            SYMPOSE_SEAL_RACE_DB: databasePath,
            SYMPOSE_SEAL_RACE_RESULT: resultPath,
          });
        const semanticsResults = [
          resolve(directory, "semantics-a.json"),
          resolve(directory, "semantics-b.json"),
        ];
        await Promise.all(
          semanticsResults.map((resultPath, index) =>
            runRaceWorker("semantics", index === 0 ? "a" : "b", resultPath),
          ),
        );
        const semanticsReceipts = semanticsResults.map(
          (path) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
        );
        expect(semanticsReceipts.map((receipt) => receipt.replayed).sort()).toEqual([
          false,
          true,
        ]);
        expect(
          semanticsReceipts.map(({ replayed: _replayed, ...receipt }) => receipt),
        ).toEqual([
          Object.fromEntries(
            Object.entries(semanticsReceipts[0]!).filter(([key]) => key !== "replayed"),
          ),
          Object.fromEntries(
            Object.entries(semanticsReceipts[0]!).filter(([key]) => key !== "replayed"),
          ),
        ]);

        const artifactResults = [
          resolve(directory, "artifact-a.json"),
          resolve(directory, "artifact-b.json"),
        ];
        await Promise.all(
          artifactResults.map((resultPath, index) =>
            runRaceWorker("artifact", index === 0 ? "a" : "b", resultPath),
          ),
        );
        const artifactReceipts = artifactResults.map(
          (path) => JSON.parse(readFileSync(path, "utf8")) as BlindReviewArtifactSealReceipt,
        );
        expect(artifactReceipts.map((receipt) => receipt.replayed).sort()).toEqual([
          false,
          true,
        ]);
        expect(
          artifactReceipts.map(({ replayed: _replayed, ...receipt }) => receipt),
        ).toEqual([
          Object.fromEntries(
            Object.entries(artifactReceipts[0]!).filter(([key]) => key !== "replayed"),
          ),
          Object.fromEntries(
            Object.entries(artifactReceipts[0]!).filter(([key]) => key !== "replayed"),
          ),
        ]);

        const verification = openDb({ path: databasePath });
        try {
          expect(count(verification, "review_rubric_semantics")).toBe(1);
          expect(count(verification, "review_blind_artifacts")).toBe(1);
          expect(count(verification, "audit_events")).toBe(2);
        } finally {
          closeDb(verification);
        }
      } finally {
        if (actors) await stopPersistentRaceActors(actors);
        rmSync(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
