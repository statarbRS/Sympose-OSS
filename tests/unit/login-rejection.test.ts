import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { SESSION_COOKIE } from "../../src/server/auth";
import { loginAction, signOutAction } from "../../src/server/actions";
import { seedEvaluatorDemo } from "../../src/server/evaluator-demo";

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

const UNAVAILABLE = {
  ok: false,
  code: "LOGIN_ACCOUNT_UNAVAILABLE",
  message: "That account is not available for organizer sign-in.",
} as const;

const BAD_ACCOUNT = {
  ok: false,
  code: "BAD_ACCOUNT",
  message: "Choose a workspace account to continue.",
} as const;

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const DENIED_ACCOUNTS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    email: "reviewer.synthetic@northstar.test",
    displayName: "Synthetic Reviewer",
    role: "reviewer",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    email: "read-only.synthetic@northstar.test",
    displayName: "Synthetic Read Only",
    role: "read_only",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    email: "communications.synthetic@northstar.test",
    displayName: "Synthetic Communications Manager",
    role: "communications_manager",
  },
] as const;

type AccountRow = {
  id: string;
  workspaceId: string;
};

function makeForm(accountId: string): FormData {
  const form = new FormData();
  form.set("accountId", accountId);
  return form;
}

function querySeededAccount(db: Db, role: string, workspaceSlug = "northstar"): AccountRow {
  const account = db
    .prepare(
      `SELECT a.id, a.workspace_id AS workspaceId
       FROM accounts a
       JOIN workspaces w ON w.id = a.workspace_id
       WHERE w.slug = ? AND a.role = ?`,
    )
    .get(workspaceSlug, role) as AccountRow | undefined;
  if (!account) {
    throw new Error(`Missing seeded northstar ${role} account`);
  }
  return account;
}

function insertDeniedAccounts(db: Db, workspaceId: string): void {
  const insert = db.prepare(
    "INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const account of DENIED_ACCOUNTS) {
    insert.run(
      account.id,
      workspaceId,
      account.email,
      account.displayName,
      account.role,
      CREATED_AT,
    );
  }
}

function sessionCount(db: Db): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count,
  );
}

async function expectUnavailable(db: Db, accountId: string): Promise<void> {
  const result = await loginAction(null, makeForm(accountId));

  expect(result).toStrictEqual(UNAVAILABLE);
  expect(sessionCount(db)).toBe(0);
  expect(mocks.cookieStore.set).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
}

describe("loginAction account availability", () => {
  let db!: Db;

  beforeEach(() => {
    vi.resetAllMocks();
    db = openDb({ path: ":memory:", seed: true });
    seedEvaluatorDemo(db);
    db.prepare("DELETE FROM sessions").run();
    const northstarOrganizer = querySeededAccount(db, "organizer");
    insertDeniedAccounts(db, northstarOrganizer.workspaceId);
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

  it.each(DENIED_ACCOUNTS)(
    "rejects the $role account with no session or cookie",
    async ({ id }) => {
      await expectUnavailable(db, id);
    },
  );

  it("rejects one unknown random account id without side effects", async () => {
    await expectUnavailable(db, randomUUID());
  });

  it("returns exact BAD_ACCOUNT for an empty account id without side effects", async () => {
    const result = await loginAction(null, makeForm(""));

    expect(result).toStrictEqual(BAD_ACCOUNT);
    expect(sessionCount(db)).toBe(0);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("rejects the seeded northstar organizer because it is not an evaluator account", async () => {
    const organizer = querySeededAccount(db, "organizer");
    await expectUnavailable(db, organizer.id);
  });

  it("rotates an existing session instead of leaving the predecessor valid", async () => {
    const organizer = querySeededAccount(db, "organizer", "acme");

    await expect(loginAction(null, makeForm(organizer.id))).rejects.toThrow(
      "NEXT_REDIRECT:/w/acme/dashboard",
    );
    const firstToken = mocks.cookieStore.set.mock.calls[0]?.[1] as string;
    const firstSession = db
      .prepare("SELECT token_hash AS tokenHash FROM sessions")
      .get() as { tokenHash: string };

    mocks.cookieStore.get.mockReturnValue({ value: firstToken });
    mocks.redirect.mockClear();
    mocks.cookieStore.set.mockClear();
    await expect(loginAction(null, makeForm(organizer.id))).rejects.toThrow(
      "NEXT_REDIRECT:/w/acme/dashboard",
    );

    const secondToken = mocks.cookieStore.set.mock.calls[0]?.[1] as string;
    expect(secondToken).not.toBe(firstToken);
    expect(sessionCount(db)).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?").get(
        firstSession.tokenHash,
      ),
    ).toEqual({ count: 0 });
  });

  it("makes sign-out revocation idempotent", async () => {
    const organizer = querySeededAccount(db, "organizer", "acme");
    await expect(loginAction(null, makeForm(organizer.id))).rejects.toThrow(
      "NEXT_REDIRECT:/w/acme/dashboard",
    );
    const token = mocks.cookieStore.set.mock.calls[0]?.[1] as string;
    mocks.cookieStore.get.mockReturnValue({ value: token });

    await expect(signOutAction(null, new FormData())).rejects.toThrow("NEXT_REDIRECT:/");
    expect(sessionCount(db)).toBe(0);
    await expect(signOutAction(null, new FormData())).rejects.toThrow("NEXT_REDIRECT:/");
    expect(sessionCount(db)).toBe(0);
    expect(mocks.cookieStore.delete).toHaveBeenCalledTimes(2);
  });

  it("redacts unexpected login and sign-out failures", async () => {
    mocks.getDb.mockImplementationOnce(() => {
      throw new Error("SENTINEL postgres://u:secret@db/private token");
    });
    await expect(loginAction(null, makeForm(randomUUID()))).resolves.toStrictEqual({
      ok: false,
      code: "LOGIN_FAILED",
      message: "Sign-in could not be completed. Try again or contact an organizer.",
    });

    mocks.getDb.mockImplementationOnce(() => {
      throw new Error("SENTINEL sqlite private failure");
    });
    await expect(signOutAction(null, new FormData())).resolves.toStrictEqual({
      ok: false,
      code: "SIGN_OUT_FAILED",
      message: "Sign-out could not be completed. Try again or contact an organizer.",
    });
  });

  it("revokes the newly created session if setting the cookie fails", async () => {
    const organizer = querySeededAccount(db, "organizer", "acme");
    mocks.cookieStore.set.mockImplementationOnce(() => {
      throw new Error("SENTINEL cookie-store failure");
    });

    await expect(loginAction(null, makeForm(organizer.id))).resolves.toStrictEqual({
      ok: false,
      code: "LOGIN_FAILED",
      message: "Sign-in could not be completed. Try again or contact an organizer.",
    });
    expect(sessionCount(db)).toBe(0);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
