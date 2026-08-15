import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "../../src/server/auth";
import { fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { EVALUATOR_DEVFLOW_REVIEWER_CONTRACT } from "../../src/server/evaluator-reviewer-contract";
import { seedEvaluatorDemo } from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import {
  listOwnReviewAssignments,
  ReviewerServiceError,
} from "../../src/server/services/cfp-review/reviewer";
import {
  provisionPinnedReviewer,
  readPinnedReviewerProvisioning,
  requirePinnedReviewerActivation,
  ReviewerProvisioningServiceError,
} from "../../src/server/services/cfp-review/reviewer-provisioning";
import { writeAudit } from "../../src/server/services/audit";

type Fixture = Readonly<{
  db: Db;
  organizer: SessionInfo;
  reviewer: SessionInfo;
  northstarOrganizer: SessionInfo;
}>;

function setup(path = ":memory:"): Fixture {
  const db = openDb({ path, seed: false });
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  const organizer = createSession(
    db,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
  ).session;
  const reviewer = createSession(
    db,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
  ).session;
  const northstar = db.prepare(
    "SELECT id FROM workspaces WHERE slug = 'northstar'",
  ).get() as { id: string };
  const northstarAccount = db.prepare(
    "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' ORDER BY id LIMIT 1",
  ).get(northstar.id) as { id: string };
  const northstarOrganizer = createSession(db, northstarAccount.id, northstar.id).session;
  return { db, organizer, reviewer, northstarOrganizer };
}

function expectProvisioningCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReviewerProvisioningServiceError);
  expect((thrown as ReviewerProvisioningServiceError).code).toBe(code);
}

function expectReviewerCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReviewerServiceError);
  expect((thrown as ReviewerServiceError).code).toBe(code);
}

function counts(db: Db): { receipts: number; states: number; audits: number; accounts: number } {
  const count = (table: "reviewer_access_receipts" | "reviewer_access_states" | "audit_events" | "accounts") =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    receipts: count("reviewer_access_receipts"),
    states: count("reviewer_access_states"),
    audits: count("audit_events"),
    accounts: count("accounts"),
  };
}

function accessInput(intent: "PROVISION" | "INVITE" | "ACTIVATE", idempotencyKey: string) {
  return {
    eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
    roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
    intent,
    idempotencyKey,
  } as const;
}

function activateReviewer(fixture: Fixture): void {
  for (const [intent, idempotencyKey] of [
    ["PROVISION", "historical-provision-v1"],
    ["INVITE", "historical-invite-v1"],
    ["ACTIVATE", "historical-activate-v1"],
  ] as const) {
    provisionPinnedReviewer(
      fixture.db,
      fixture.organizer,
      accessInput(intent, idempotencyKey),
    );
  }
}

const ACCESS_IMMUTABILITY_TRIGGERS = [
  "trg_reviewer_access_receipts_immutable",
  "trg_reviewer_access_states_immutable",
] as const;

function bypassAccessImmutability(raw: DatabaseSync, mutate: () => void): void {
  const triggerSql = ACCESS_IMMUTABILITY_TRIGGERS.map((name) => {
    const row = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    ).get(name) as { sql?: unknown } | undefined;
    if (typeof row?.sql !== "string") throw new Error(`missing ${name}`);
    return row.sql;
  });
  for (const name of ACCESS_IMMUTABILITY_TRIGGERS) raw.exec(`DROP TRIGGER ${name}`);
  try {
    mutate();
  } finally {
    for (const sql of triggerSql) raw.exec(sql);
  }
}

type AccessTuple = Readonly<{
  workspaceId: string;
  eventId: string;
  roundId: string;
  assignmentId: string;
  eventReviewerAssignmentId: string;
  reviewerAccountId: string;
  reviewerPersonId: string;
  accountPersonBindingId: string;
  actorAccountId: string;
}>;

function rewriteAccessTuple(
  raw: DatabaseSync,
  overrides: Partial<AccessTuple>,
): void {
  const receipts = raw.prepare(
    "SELECT * FROM reviewer_access_receipts ORDER BY created_at, id",
  ).all() as Record<string, string>[];
  for (const receipt of receipts) {
    const tuple: AccessTuple = {
      workspaceId: overrides.workspaceId ?? receipt.workspace_id,
      eventId: overrides.eventId ?? receipt.event_id,
      roundId: overrides.roundId ?? receipt.round_id,
      assignmentId: overrides.assignmentId ?? receipt.assignment_id,
      eventReviewerAssignmentId:
        overrides.eventReviewerAssignmentId ?? receipt.event_reviewer_assignment_id,
      reviewerAccountId: overrides.reviewerAccountId ?? receipt.reviewer_account_id,
      reviewerPersonId: overrides.reviewerPersonId ?? receipt.reviewer_person_id,
      accountPersonBindingId:
        overrides.accountPersonBindingId ?? receipt.account_person_binding_id,
      actorAccountId: overrides.actorAccountId ?? receipt.actor_account_id,
    };
    const requestFingerprint = fingerprintOf({
      schema: receipt.request_schema,
      actorAccountId: tuple.actorAccountId,
      workspaceId: tuple.workspaceId,
      eventId: tuple.eventId,
      roundId: tuple.roundId,
      assignmentId: tuple.assignmentId,
      eventReviewerAssignmentId: tuple.eventReviewerAssignmentId,
      reviewerAccountId: tuple.reviewerAccountId,
      reviewerPersonId: tuple.reviewerPersonId,
      accountPersonBindingId: tuple.accountPersonBindingId,
      intent: receipt.intent,
    });
    raw.prepare(
      `UPDATE reviewer_access_receipts
       SET workspace_id = ?, event_id = ?, round_id = ?, assignment_id = ?,
           event_reviewer_assignment_id = ?, reviewer_account_id = ?, reviewer_person_id = ?,
           account_person_binding_id = ?, actor_account_id = ?, request_fingerprint = ?
       WHERE id = ?`,
    ).run(
      tuple.workspaceId,
      tuple.eventId,
      tuple.roundId,
      tuple.assignmentId,
      tuple.eventReviewerAssignmentId,
      tuple.reviewerAccountId,
      tuple.reviewerPersonId,
      tuple.accountPersonBindingId,
      tuple.actorAccountId,
      requestFingerprint,
      receipt.id,
    );
    raw.prepare(
      `UPDATE reviewer_access_states
       SET workspace_id = ?, event_id = ?, round_id = ?, assignment_id = ?,
           event_reviewer_assignment_id = ?, reviewer_account_id = ?, reviewer_person_id = ?,
           account_person_binding_id = ?, actor_account_id = ?
       WHERE receipt_id = ?`,
    ).run(
      tuple.workspaceId,
      tuple.eventId,
      tuple.roundId,
      tuple.assignmentId,
      tuple.eventReviewerAssignmentId,
      tuple.reviewerAccountId,
      tuple.reviewerPersonId,
      tuple.accountPersonBindingId,
      tuple.actorAccountId,
      receipt.id,
    );
  }
}

function createSecondSameRoundAssignment(db: Db): string {
  const candidate = db.prepare(
    `SELECT submission.id AS submissionId,
            submission.current_revision_id AS submissionRevisionId
     FROM submissions submission
     WHERE submission.workspace_id = ?
       AND submission.event_id = ?
       AND submission.state = 'SUBMITTED'
       AND submission.current_revision_id IS NOT NULL
       AND submission.id <> ?
     ORDER BY submission.id
     LIMIT 1`,
  ).get(
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.submissionId,
  ) as { submissionId: string; submissionRevisionId: string } | undefined;
  if (!candidate) throw new Error("missing second submitted proposal");
  const assignmentId = "reviewer-access-retarget-assignment";
  db.prepare(
    `INSERT INTO review_assignments
       (id, workspace_id, round_id, rubric_version_id, submission_id,
        submission_revision_id, reviewer_account_id, assigned_by,
        supersedes_assignment_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    assignmentId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.rubricVersionId,
    candidate.submissionId,
    candidate.submissionRevisionId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
    afterLatestAccessReceipt(db),
  );
  return assignmentId;
}

function accessHistory(db: Db): Readonly<{
  receipts: readonly Record<string, unknown>[];
  states: readonly Record<string, unknown>[];
}> {
  return {
    receipts: db.prepare(
      "SELECT * FROM reviewer_access_receipts ORDER BY workspace_id, assignment_id, created_at, id",
    ).all() as Record<string, unknown>[],
    states: db.prepare(
      "SELECT * FROM reviewer_access_states ORDER BY workspace_id, assignment_id, sequence_number, created_at, id",
    ).all() as Record<string, unknown>[],
  };
}

function databasePath(label: string): string {
  const path = resolve(".tmp/unit", `reviewer-access-history-${label}-${process.pid}.db`);
  mkdirSync(dirname(path), { recursive: true });
  removeDatabase(path);
  return path;
}

function removeDatabase(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(target, { force: true });
  }
}

function afterLatestAccessReceipt(db: Db): string {
  const row = db.prepare(
    "SELECT MAX(created_at) AS createdAt FROM reviewer_access_receipts",
  ).get() as { createdAt: string };
  return new Date(Date.parse(row.createdAt) + 1_000).toISOString();
}

type CurrentAuthorityMutation = Readonly<{
  label: string;
  mutate: (db: Db) => void;
  assertDenied: (db: Db, fixture: Fixture) => void;
}>;

const CURRENT_AUTHORITY_MUTATIONS: readonly CurrentAuthorityMutation[] = [
  {
    label: "round closure",
    mutate: (db) => {
      db.prepare(
        `INSERT INTO review_round_states
           (id, workspace_id, round_id, state, sequence_number, actor_account_id, reason, created_at)
         VALUES (?, ?, ?, 'CLOSED', 3, ?, ?, ?)`,
      ).run(
        "historical-review-round-closed",
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
        "The review round has closed.",
        afterLatestAccessReceipt(db),
      );
    },
    assertDenied: (db) => {
      expectProvisioningCode(() => requirePinnedReviewerActivation(db), "ROUND_NOT_AVAILABLE");
    },
  },
  {
    label: "event reviewer revocation",
    mutate: (db) => {
      db.prepare(
        `INSERT INTO event_reviewer_assignment_states
           (id, workspace_id, event_id, event_reviewer_assignment_id, state,
            sequence_number, actor_account_id, reason, created_at)
         VALUES (?, ?, ?, ?, 'REVOKED', 2, ?, ?, ?)`,
      ).run(
        "historical-event-reviewer-revoked",
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventReviewerAssignmentId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
        "The event reviewer assignment has been revoked.",
        afterLatestAccessReceipt(db),
      );
    },
    assertDenied: (db) => {
      expectProvisioningCode(() => requirePinnedReviewerActivation(db), "REVIEWER_NOT_AVAILABLE");
    },
  },
  {
    label: "review assignment revocation",
    mutate: (db) => {
      db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number, actor_account_id, reason, created_at)
         VALUES (?, ?, ?, 'REVOKED', 2, ?, ?, ?)`,
      ).run(
        "historical-review-assignment-revoked",
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
        "The review assignment has been revoked.",
        afterLatestAccessReceipt(db),
      );
    },
    assertDenied: (db) => {
      expectProvisioningCode(() => requirePinnedReviewerActivation(db), "ASSIGNMENT_NOT_AVAILABLE");
    },
  },
  {
    label: "reviewer role demotion",
    mutate: (db) => {
      db.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ?").run(
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
      );
    },
    assertDenied: (db) => {
      expectProvisioningCode(() => requirePinnedReviewerActivation(db), "REVIEWER_NOT_AVAILABLE");
    },
  },
  {
    label: "issuing organizer role demotion",
    mutate: (db) => {
      db.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ?").run(
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
      );
    },
    assertDenied: (db, fixture) => {
      expectProvisioningCode(
        () => readPinnedReviewerProvisioning(db, fixture.organizer, {
          eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
          roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
        }),
        "ACCESS_DENIED",
      );
    },
  },
];

type HistoricalAccessTamper = Readonly<{
  label: string;
  history: "PROVISIONED" | "ACTIVE";
  mutate: (raw: DatabaseSync) => void;
}>;

const HISTORICAL_ACCESS_TAMPERS: readonly HistoricalAccessTamper[] = [
  {
    label: "receipt transition",
    history: "ACTIVE",
    mutate: (raw) => {
      raw.prepare(
        `UPDATE reviewer_access_receipts
         SET transitioned = 0, effect_state_id = NULL
         WHERE intent = 'PROVISION'`,
      ).run();
    },
  },
  {
    label: "state row",
    history: "ACTIVE",
    mutate: (raw) => {
      raw.prepare(
        `UPDATE reviewer_access_states
         SET actor_account_id = ?
         WHERE sequence_number = 1`,
      ).run(EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId);
    },
  },
  {
    label: "request fingerprint",
    history: "ACTIVE",
    mutate: (raw) => {
      raw.prepare(
        `UPDATE reviewer_access_receipts
         SET request_fingerprint = ?
         WHERE intent = 'PROVISION'`,
      ).run("0".repeat(64));
    },
  },
  {
    label: "state sequence",
    history: "PROVISIONED",
    mutate: (raw) => {
      raw.prepare(
        `UPDATE reviewer_access_states
         SET sequence_number = 2
         WHERE sequence_number = 1`,
      ).run();
    },
  },
  {
    label: "reviewer account",
    history: "ACTIVE",
    mutate: (raw) => {
      rewriteAccessTuple(raw, {
        reviewerAccountId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
      });
    },
  },
  {
    label: "reviewer Person",
    history: "ACTIVE",
    mutate: (raw) => {
      const person = raw.prepare(
        `SELECT id FROM people
         WHERE workspace_id = ? AND id <> ?
         ORDER BY id LIMIT 1`,
      ).get(
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewerPersonId,
      ) as { id: string } | undefined;
      if (!person) throw new Error("missing alternate Person");
      rewriteAccessTuple(raw, { reviewerPersonId: person.id });
    },
  },
  {
    label: "workspace",
    history: "ACTIVE",
    mutate: (raw) => {
      const workspace = raw.prepare(
        "SELECT id FROM workspaces WHERE id <> ? ORDER BY id LIMIT 1",
      ).get(EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId) as { id: string } | undefined;
      if (!workspace) throw new Error("missing alternate workspace");
      rewriteAccessTuple(raw, { workspaceId: workspace.id });
    },
  },
  {
    label: "event",
    history: "ACTIVE",
    mutate: (raw) => {
      const event = raw.prepare(
        "SELECT id FROM events WHERE id <> ? ORDER BY id LIMIT 1",
      ).get(EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId) as { id: string } | undefined;
      if (!event) throw new Error("missing alternate event");
      rewriteAccessTuple(raw, { eventId: event.id });
    },
  },
];

describe("V16 pinned reviewer provisioning", () => {
  it("records the exact append-only lifecycle and reaches only Sam's queue", () => {
    const fixture = setup();
    try {
      const ready = readPinnedReviewerProvisioning(fixture.db, fixture.organizer, {
        eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
        roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
      });
      expect(ready).toMatchObject({
        workspaceId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
        roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
        assignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
        eventReviewerAssignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventReviewerAssignmentId,
        reviewerAccountId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
        reviewerPersonId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewerPersonId,
        accountPersonBindingId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.accountPersonBindingId,
        status: "READY_TO_PROVISION",
        accessState: null,
        accessSequenceNumber: 0,
        queueReachable: false,
        providerMutation: false,
        credentialIssued: false,
      });
      expectProvisioningCode(
        () => requirePinnedReviewerActivation(fixture.db),
        "ACCESS_DENIED",
      );
      expectReviewerCode(
        () => listOwnReviewAssignments(fixture.db, fixture.reviewer, {
          workspaceSlug: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceSlug,
        }),
        "ACCESS_DENIED",
      );

      writeAudit(fixture.db, EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId, {
        actorKind: "account",
        actorRef: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
        action: "security.synthetic-reviewer.fake-active",
        targetType: "reviewer_access_receipt",
        targetId: "fake-audit-only",
        details: {
          state: "ACTIVE",
          assignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
        },
      });
      expect(readPinnedReviewerProvisioning(fixture.db, fixture.organizer, {
        eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
        roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
      }).status).toBe("READY_TO_PROVISION");

      const before = counts(fixture.db);
      const provisioned = provisionPinnedReviewer(
        fixture.db,
        fixture.organizer,
        accessInput("PROVISION", "sam-provision-v1"),
      );
      expect(provisioned).toMatchObject({
        state: "PROVISIONED",
        sequenceNumber: 1,
        transitioned: true,
        replayed: false,
        providerMutation: false,
        credentialIssued: false,
        workspaceId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        assignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
        reviewerAccountId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
        reviewerPersonId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewerPersonId,
        accountPersonBindingId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.accountPersonBindingId,
      });
      expect("token" in provisioned).toBe(false);
      expect(counts(fixture.db)).toEqual({
        receipts: before.receipts + 1,
        states: before.states + 1,
        audits: before.audits + 1,
        accounts: before.accounts,
      });

      const replay = provisionPinnedReviewer(
        fixture.db,
        fixture.organizer,
        accessInput("PROVISION", "sam-provision-v1"),
      );
      expect(replay.receiptId).toBe(provisioned.receiptId);
      expect(replay.replayed).toBe(true);
      expect(counts(fixture.db)).toEqual({
        receipts: before.receipts + 1,
        states: before.states + 1,
        audits: before.audits + 1,
        accounts: before.accounts,
      });
      expectProvisioningCode(
        () => provisionPinnedReviewer(
          fixture.db,
          fixture.organizer,
          accessInput("INVITE", "sam-provision-v1"),
        ),
        "IDEMPOTENCY_CONFLICT",
      );

      const invited = provisionPinnedReviewer(
        fixture.db,
        fixture.organizer,
        accessInput("INVITE", "sam-invite-v1"),
      );
      const active = provisionPinnedReviewer(
        fixture.db,
        fixture.organizer,
        accessInput("ACTIVATE", "sam-activate-v1"),
      );
      expect(invited).toMatchObject({ state: "INVITED", sequenceNumber: 2, transitioned: true });
      expect(active).toMatchObject({ state: "ACTIVE", sequenceNumber: 3, transitioned: true });
      expect(fixture.db.prepare(
        `SELECT state, sequence_number AS sequenceNumber, assignment_id AS assignmentId,
                reviewer_account_id AS reviewerAccountId, reviewer_person_id AS reviewerPersonId,
                account_person_binding_id AS accountPersonBindingId
         FROM reviewer_access_states ORDER BY sequence_number`,
      ).all()).toEqual([
        {
          state: "PROVISIONED",
          sequenceNumber: 1,
          assignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
          reviewerAccountId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
          reviewerPersonId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewerPersonId,
          accountPersonBindingId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.accountPersonBindingId,
        },
        {
          state: "INVITED",
          sequenceNumber: 2,
          assignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
          reviewerAccountId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
          reviewerPersonId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewerPersonId,
          accountPersonBindingId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.accountPersonBindingId,
        },
        {
          state: "ACTIVE",
          sequenceNumber: 3,
          assignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
          reviewerAccountId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
          reviewerPersonId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewerPersonId,
          accountPersonBindingId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.accountPersonBindingId,
        },
      ]);

      const projection = readPinnedReviewerProvisioning(fixture.db, fixture.organizer, {
        eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
        roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
      });
      expect(projection.status).toBe("ACTIVE");
      expect(projection.queueReachable).toBe(true);
      const activation = requirePinnedReviewerActivation(fixture.db);
      expect(activation).toMatchObject({
        workspaceId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
        roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
        assignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
        eventReviewerAssignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventReviewerAssignmentId,
        reviewerAccountId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
        reviewerPersonId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewerPersonId,
        accountPersonBindingId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.accountPersonBindingId,
        accessState: "ACTIVE",
        accessSequenceNumber: 3,
      });
      expect(listOwnReviewAssignments(fixture.db, fixture.reviewer, {
        workspaceSlug: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceSlug,
      })).toEqual([
        expect.objectContaining({
          assignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
        }),
      ]);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rolls back denied and out-of-order mutations before returning sanitized errors", () => {
    const fixture = setup();
    try {
      const initial = counts(fixture.db);
      expectProvisioningCode(
        () => provisionPinnedReviewer(
          fixture.db,
          fixture.northstarOrganizer,
          accessInput("PROVISION", "cross-tenant-v1"),
        ),
        "ACCESS_DENIED",
      );
      expect(counts(fixture.db)).toEqual(initial);

      expectProvisioningCode(
        () => provisionPinnedReviewer(
          fixture.db,
          fixture.organizer,
          accessInput("INVITE", "invite-before-provision-v1"),
        ),
        "PROVISIONING_REQUIRED",
      );
      expect(counts(fixture.db)).toEqual(initial);
      expectProvisioningCode(
        () => provisionPinnedReviewer(
          fixture.db,
          fixture.organizer,
          accessInput("ACTIVATE", "activate-before-provision-v1"),
        ),
        "PROVISIONING_REQUIRED",
      );
      expect(counts(fixture.db)).toEqual(initial);

      expectProvisioningCode(
        () => provisionPinnedReviewer(
          fixture.db,
          fixture.organizer,
          {
            ...accessInput("PROVISION", "extra-field-v1"),
            workspaceId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
            reviewerAccountId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
          } as never,
        ),
        "INPUT_INVALID",
      );
      expect(counts(fixture.db)).toEqual(initial);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("denies an outer transaction and protects receipt/state rows from mutation", () => {
    const fixture = setup();
    try {
      fixture.db.exec("BEGIN");
      expectProvisioningCode(
        () => readPinnedReviewerProvisioning(fixture.db, fixture.organizer, {
          eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
          roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
        }),
        "OUTER_TRANSACTION_DENIED",
      );
      expect(fixture.db.isTransaction).toBe(true);
      fixture.db.exec("ROLLBACK");

      provisionPinnedReviewer(
        fixture.db,
        fixture.organizer,
        accessInput("PROVISION", "immutable-receipt-v1"),
      );
      expect(() => fixture.db.prepare(
        "UPDATE reviewer_access_states SET state = 'ACTIVE' WHERE sequence_number = 1",
      ).run()).toThrow();
      expect(() => fixture.db.prepare(
        "DELETE FROM reviewer_access_receipts WHERE idempotency_key = ?",
      ).run("immutable-receipt-v1")).toThrow();
      expect(readPinnedReviewerProvisioning(fixture.db, fixture.organizer, {
        eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
        roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
      }).status).toBe("PROVISIONED");
    } finally {
      if (fixture.db.isTransaction) fixture.db.exec("ROLLBACK");
      closeDb(fixture.db);
    }
  });

  it.each(CURRENT_AUTHORITY_MUTATIONS)(
    "reopens with immutable access history after $label while current access stays denied",
    ({ label, mutate, assertDenied }) => {
      const path = databasePath(label.replaceAll(" ", "-"));
      let db: Db | null = null;
      try {
        const fixture = setup(path);
        db = fixture.db;
        activateReviewer(fixture);
        const history = accessHistory(db);
        expect(history.receipts).toHaveLength(3);
        expect(history.states).toHaveLength(3);

        mutate(db);
        const countsAfterMutation = counts(db);
        assertDenied(db, fixture);
        expect(accessHistory(db)).toEqual(history);
        expect(counts(db)).toEqual(countsAfterMutation);

        closeDb(db);
        db = null;
        const reopened = openDb({ path, seed: false });
        db = reopened;
        expect(accessHistory(reopened)).toEqual(history);
        assertDenied(reopened, fixture);
        expect(counts(reopened)).toEqual(countsAfterMutation);
      } finally {
        if (db !== null) closeDb(db);
        removeDatabase(path);
      }
    },
  );

  it("blocks full fingerprint-consistent substitution to a second valid same-round assignment", () => {
    const path = databasePath("same-round-assignment-substitution");
    let db: Db | null = null;
    try {
      const fixture = setup(path);
      db = fixture.db;
      activateReviewer(fixture);
      const substituteAssignmentId = createSecondSameRoundAssignment(db);
      expect(db.prepare(
        `SELECT assignment.id
         FROM review_assignments assignment
         JOIN review_assignment_states state
           ON state.assignment_id = assignment.id
          AND state.sequence_number = 1
          AND state.state = 'ASSIGNED'
         WHERE assignment.id = ?
           AND assignment.workspace_id = ?
           AND assignment.round_id = ?
           AND assignment.reviewer_account_id = ?`,
      ).get(
        substituteAssignmentId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
      )).toEqual({ id: substituteAssignmentId });
      closeDb(db);
      db = null;

      const raw = new DatabaseSync(path);
      try {
        raw.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
        bypassAccessImmutability(raw, () => {
          rewriteAccessTuple(raw, { assignmentId: substituteAssignmentId });
        });
      } finally {
        raw.close();
      }

      expect(() => openDb({ path, seed: false })).toThrow(
        "database reviewer access integrity check failed",
      );
    } finally {
      if (db !== null) closeDb(db);
      removeDatabase(path);
    }
  });

  it.each(HISTORICAL_ACCESS_TAMPERS)(
    "blocks reopen after ordinary $label tamper",
    ({ label, history, mutate }) => {
      const path = databasePath(`ordinary-${label.replaceAll(" ", "-")}`);
      let db: Db | null = null;
      try {
        const fixture = setup(path);
        db = fixture.db;
        if (history === "ACTIVE") {
          activateReviewer(fixture);
        } else {
          provisionPinnedReviewer(
            db,
            fixture.organizer,
            accessInput("PROVISION", "ordinary-tamper-provision-v1"),
          );
        }
        closeDb(db);
        db = null;

        const raw = new DatabaseSync(path);
        try {
          raw.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
          bypassAccessImmutability(raw, () => mutate(raw));
        } finally {
          raw.close();
        }

        expect(() => openDb({ path, seed: false })).toThrow(
          "database reviewer access integrity check failed",
        );
      } finally {
        if (db !== null) closeDb(db);
        removeDatabase(path);
      }
    },
  );

  it("blocks reopen when a fingerprint-consistent historical account binding is tampered", () => {
    const path = databasePath("tampered-binding");
    let db: Db | null = null;
    try {
      const fixture = setup(path);
      db = fixture.db;
      activateReviewer(fixture);
      closeDb(db);
      db = null;

      const raw = new DatabaseSync(path);
      try {
        raw.exec("PRAGMA foreign_keys = ON;");
        const receiptTrigger = raw.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_reviewer_access_receipts_immutable'",
        ).get() as { sql: string };
        const stateTrigger = raw.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_reviewer_access_states_immutable'",
        ).get() as { sql: string };
        const receipt = raw.prepare(
          "SELECT * FROM reviewer_access_receipts WHERE intent = 'PROVISION'",
        ).get() as Record<string, string>;
        const tamperedReviewerAccountId = EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId;
        const tamperedFingerprint = fingerprintOf({
          schema: receipt.request_schema,
          actorAccountId: receipt.actor_account_id,
          workspaceId: receipt.workspace_id,
          eventId: receipt.event_id,
          roundId: receipt.round_id,
          assignmentId: receipt.assignment_id,
          eventReviewerAssignmentId: receipt.event_reviewer_assignment_id,
          reviewerAccountId: tamperedReviewerAccountId,
          reviewerPersonId: receipt.reviewer_person_id,
          accountPersonBindingId: receipt.account_person_binding_id,
          intent: receipt.intent,
        });

        raw.exec(`
          DROP TRIGGER trg_reviewer_access_receipts_immutable;
          DROP TRIGGER trg_reviewer_access_states_immutable;
        `);
        raw.prepare(
          "UPDATE reviewer_access_receipts SET reviewer_account_id = ?, request_fingerprint = ? WHERE id = ?",
        ).run(tamperedReviewerAccountId, tamperedFingerprint, receipt.id);
        raw.prepare(
          "UPDATE reviewer_access_states SET reviewer_account_id = ? WHERE receipt_id = ?",
        ).run(tamperedReviewerAccountId, receipt.id);
        raw.exec(`${receiptTrigger.sql}; ${stateTrigger.sql};`);
      } finally {
        raw.close();
      }

      expect(() => openDb({ path, seed: false })).toThrow(
        "database reviewer access integrity check failed",
      );
    } finally {
      if (db !== null) closeDb(db);
      removeDatabase(path);
    }
  });
});
