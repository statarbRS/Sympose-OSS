import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../../src/server/auth";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { enterPinnedReviewerSessionAction, loginAction, loginReviewerAction } from "../../src/server/actions";
import { resolveSession } from "../../src/server/auth";
import { EVALUATOR_DEVFLOW_REVIEWER_CONTRACT } from "../../src/server/evaluator-reviewer-contract";
import {
  EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
} from "../../src/server/evaluator-compatibility";
import {
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_REVIEWER_ACCOUNT_ID,
  seedEvaluatorDemo,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import { listLoginChoices, listSyntheticReviewerChoices } from "../../src/server/services/queries";
import { provisionPinnedReviewer } from "../../src/server/services/cfp-review/reviewer-provisioning";

const mocks = vi.hoisted(() => {
  const cookieStore = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  };
  return {
    cookieStore,
    cookies: vi.fn(async () => cookieStore),
    redirect: vi.fn((path: string): never => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    }),
    getDb: vi.fn(),
  };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../../src/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/db")>();
  return { ...actual, getDb: mocks.getDb };
});

const ORGANIZER_UNAVAILABLE = {
  ok: false,
  code: "LOGIN_ACCOUNT_UNAVAILABLE",
  message: "That account is not available for organizer sign-in.",
} as const;

const REVIEWER_UNAVAILABLE = {
  ok: false,
  code: "REVIEWER_ACCOUNT_UNAVAILABLE",
  message: "That synthetic reviewer account is not available.",
} as const;

function makeForm(accountId: string): FormData {
  const form = new FormData();
  form.set("accountId", accountId);
  return form;
}

function sessionCount(db: Db): number {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count);
}

function activateDevflowReviewer(db: Db): void {
  const organizer = createSession(
    db,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
    EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
  ).session;
  for (const [intent, idempotencyKey] of [
    ["PROVISION", "evaluator-login-provision-v1"],
    ["INVITE", "evaluator-login-invite-v1"],
    ["ACTIVATE", "evaluator-login-activate-v1"],
  ] as const) {
    provisionPinnedReviewer(db, organizer, {
      eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
      roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
      intent,
      idempotencyKey,
    });
  }
  db.prepare("DELETE FROM sessions").run();
}

function reviewerAccessEvidenceCounts(db: Db): Readonly<{
  receipts: number;
  states: number;
  audits: number;
}> {
  const count = (table: "reviewer_access_receipts" | "reviewer_access_states" | "audit_events") =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    receipts: count("reviewer_access_receipts"),
    states: count("reviewer_access_states"),
    audits: count("audit_events"),
  };
}

function afterLatestAccessReceipt(db: Db): string {
  const row = db.prepare(
    "SELECT MAX(created_at) AS createdAt FROM reviewer_access_receipts",
  ).get() as { createdAt: string };
  return new Date(Date.parse(row.createdAt) + 1_000).toISOString();
}

const LOGIN_ACCESS_REVOCATIONS: readonly (readonly [string, (db: Db) => void])[] = [
  [
    "round closure",
    (db) => {
      db.prepare(
        `INSERT INTO review_round_states
           (id, workspace_id, round_id, state, sequence_number, actor_account_id, reason, created_at)
         VALUES (?, ?, ?, 'CLOSED', 3, ?, ?, ?)`,
      ).run(
        "login-review-round-closed",
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
        "The review round has closed.",
        afterLatestAccessReceipt(db),
      );
    },
  ],
  [
    "event reviewer revocation",
    (db) => {
      db.prepare(
        `INSERT INTO event_reviewer_assignment_states
           (id, workspace_id, event_id, event_reviewer_assignment_id, state,
            sequence_number, actor_account_id, reason, created_at)
         VALUES (?, ?, ?, ?, 'REVOKED', 2, ?, ?, ?)`,
      ).run(
        "login-event-reviewer-revoked",
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventReviewerAssignmentId,
        EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId,
        "The event reviewer assignment has been revoked.",
        afterLatestAccessReceipt(db),
      );
    },
  ],
];

async function expectOrganizerRedirect(db: Db, accountId: string, path: string): Promise<void> {
  await expect(loginAction(null, makeForm(accountId))).rejects.toThrow(`NEXT_REDIRECT:${path}`);
  expect(sessionCount(db)).toBe(1);
  expect(mocks.cookieStore.set).toHaveBeenCalledTimes(1);
  db.prepare("DELETE FROM sessions").run();
  mocks.cookieStore.set.mockClear();
  mocks.redirect.mockClear();
}

async function expectReviewerRedirect(db: Db, accountId: string, path: string): Promise<void> {
  await expect(loginReviewerAction(null, makeForm(accountId))).rejects.toThrow(`NEXT_REDIRECT:${path}`);
  expect(sessionCount(db)).toBe(1);
  expect(mocks.cookieStore.set).toHaveBeenCalledTimes(1);
  db.prepare("DELETE FROM sessions").run();
  mocks.cookieStore.set.mockClear();
  mocks.redirect.mockClear();
}

describe("evaluator login boundary", () => {
  let db!: Db;

  beforeEach(() => {
    vi.resetAllMocks();
    db = openDb({ path: ":memory:", seed: false });
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    db.prepare("DELETE FROM sessions").run();
    mocks.getDb.mockReturnValue(db);
    mocks.cookies.mockResolvedValue(mocks.cookieStore);
    mocks.redirect.mockImplementation((path: string): never => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });
  });

  afterEach(() => {
    closeDb(db);
    vi.resetAllMocks();
  });

  it("allows only the four explicitly seeded evaluator personas", async () => {
    await expectOrganizerRedirect(db, EVALUATOR_ORGANIZER_ACCOUNT_ID, "/w/acme/dashboard");
    await expectOrganizerRedirect(
      db,
      EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
      "/w/devflow/dashboard",
    );
    await expectReviewerRedirect(db, EVALUATOR_REVIEWER_ACCOUNT_ID, "/review/acme/queue");
    await expect(loginReviewerAction(null, makeForm(EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID))).resolves.toStrictEqual({
      ok: false,
      code: "REVIEWER_ACTIVATION_REQUIRED",
      message: "That synthetic reviewer has not been activated by the organizer.",
    });
    expect(sessionCount(db)).toBe(0);
    activateDevflowReviewer(db);
    await expectReviewerRedirect(
      db,
      EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
      "/review/devflow/queue",
    );
  });

  it("rejects non-evaluator accounts and omits them from public choices", async () => {
    const northstarWorkspace = db
      .prepare("SELECT id FROM workspaces WHERE slug = 'northstar'")
      .get() as { id: string };
    const futureReviewerId = "44444444-4444-4444-8444-444444444444";
    db.prepare(
      "INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      futureReviewerId,
      northstarWorkspace.id,
      "future.reviewer@northstar.example",
      "Future Reviewer",
      "reviewer",
      "2026-08-12T00:00:00.000Z",
    );
    const northstarOrganizer = db
      .prepare("SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer'")
      .get(northstarWorkspace.id) as { id: string };

    await expect(loginAction(null, makeForm(northstarOrganizer.id))).resolves.toStrictEqual(
      ORGANIZER_UNAVAILABLE,
    );
    await expect(loginAction(null, makeForm("00000000-0000-4000-8000-000000000001"))).resolves.toStrictEqual(
      ORGANIZER_UNAVAILABLE,
    );
    await expect(loginReviewerAction(null, makeForm(futureReviewerId))).resolves.toStrictEqual(
      REVIEWER_UNAVAILABLE,
    );
    expect(sessionCount(db)).toBe(0);
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();

    const organizerChoices = listLoginChoices(db);
    expect(organizerChoices.map((choice) => choice.accountId)).toEqual([
      EVALUATOR_ORGANIZER_ACCOUNT_ID,
      EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    ]);
    expect(organizerChoices.map((choice) => choice.workspaceSlug)).toEqual(["acme", "devflow"]);

    const reviewerChoices = listSyntheticReviewerChoices(db);
    expect(reviewerChoices.map((choice) => choice.accountId)).toEqual([
      EVALUATOR_REVIEWER_ACCOUNT_ID,
      EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
    ]);
    expect(reviewerChoices.map((choice) => choice.workspaceSlug)).toEqual(["acme", "devflow"]);
  });

  it("requires ACTIVE access before the organizer can enter Sam's exact reviewer queue", async () => {
    const beforeActivation = createSession(
      db,
      EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    );
    mocks.cookieStore.get.mockReturnValue({ value: beforeActivation.token });
    await expect(enterPinnedReviewerSessionAction(null, new FormData())).resolves.toStrictEqual({
      ok: false,
      code: "REVIEWER_ACTIVATION_REQUIRED",
      message: "Sam must be activated before entering the reviewer assignment.",
    });
    expect(sessionCount(db)).toBe(1);

    activateDevflowReviewer(db);
    const organizer = createSession(
      db,
      EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    );
    mocks.cookieStore.get.mockReturnValue({ value: organizer.token });
    await expect(enterPinnedReviewerSessionAction(null, new FormData())).rejects.toThrow(
      "NEXT_REDIRECT:/review/devflow/queue",
    );
    const setCalls = mocks.cookieStore.set.mock.calls;
    const latestCookie = setCalls[setCalls.length - 1]?.[1];
    expect(typeof latestCookie).toBe("string");
    const reviewer = resolveSession(db, latestCookie as string);
    expect(reviewer).toMatchObject({
      accountId: EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
      workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      workspaceSlug: "devflow",
      role: "reviewer",
      email: "sam.whitfield@devflow.example",
    });
  });

  it("denies current reviewer login after a historically activated account is demoted", async () => {
    activateDevflowReviewer(db);
    const historyBefore = reviewerAccessEvidenceCounts(db);
    expect(historyBefore).toMatchObject({ receipts: 3, states: 3 });

    db.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ?").run(
      EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
    );

    await expect(
      loginReviewerAction(null, makeForm(EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID)),
    ).resolves.toStrictEqual(REVIEWER_UNAVAILABLE);
    expect(sessionCount(db)).toBe(0);
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(reviewerAccessEvidenceCounts(db)).toEqual(historyBefore);
  });

  it.each(LOGIN_ACCESS_REVOCATIONS)(
    "denies current reviewer login after %s without rewriting activation history",
    async (_label, revokeCurrentAccess) => {
      activateDevflowReviewer(db);
      const historyBefore = reviewerAccessEvidenceCounts(db);
      expect(historyBefore).toMatchObject({ receipts: 3, states: 3 });

      revokeCurrentAccess(db);

      await expect(
        loginReviewerAction(null, makeForm(EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID)),
      ).resolves.toStrictEqual({
        ok: false,
        code: "REVIEWER_ACTIVATION_REQUIRED",
        message: "That synthetic reviewer has not been activated by the organizer.",
      });
      expect(sessionCount(db)).toBe(0);
      expect(mocks.cookieStore.set).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(reviewerAccessEvidenceCounts(db)).toEqual(historyBefore);
    },
  );

  it("fails closed for role-swapped, cross-workspace, and cross-persona ids", async () => {
    db.prepare("UPDATE accounts SET workspace_id = ? WHERE id = ?").run(
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_ORGANIZER_ACCOUNT_ID,
    );
    db.prepare("UPDATE accounts SET role = 'organizer' WHERE id = ?").run(
      EVALUATOR_REVIEWER_ACCOUNT_ID,
    );

    await expect(loginAction(null, makeForm(EVALUATOR_ORGANIZER_ACCOUNT_ID))).resolves.toStrictEqual(
      ORGANIZER_UNAVAILABLE,
    );
    await expect(loginReviewerAction(null, makeForm(EVALUATOR_REVIEWER_ACCOUNT_ID))).resolves.toStrictEqual(
      REVIEWER_UNAVAILABLE,
    );
    await expect(loginAction(null, makeForm(EVALUATOR_REVIEWER_ACCOUNT_ID))).resolves.toStrictEqual(
      ORGANIZER_UNAVAILABLE,
    );
    await expect(loginReviewerAction(null, makeForm(EVALUATOR_ORGANIZER_ACCOUNT_ID))).resolves.toStrictEqual(
      REVIEWER_UNAVAILABLE,
    );
    expect(sessionCount(db)).toBe(0);
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
