import { afterEach, describe, expect, it } from "vitest";

import {
  createSession,
  resolveSession,
  revokeSession,
} from "../../src/server/auth";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { randomToken, sha256Hex } from "../../src/server/canonical";

describe("random session tokens", () => {
  let db: Db | undefined;

  afterEach(() => {
    if (db) {
      closeDb(db);
      db = undefined;
    }
  });

  it("uses 32 random bytes in the expected lowercase hex shape", () => {
    const token = randomToken();

    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not repeat tokens across a focused sample", () => {
    const tokens = Array.from({ length: 64 }, () => randomToken());

    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("remains compatible with session hashing, resolution, and revocation", () => {
    db = openDb({ path: ":memory:", seed: true });
    const account = db
      .prepare("SELECT id, workspace_id AS workspaceId FROM accounts WHERE role = ? LIMIT 1")
      .get("organizer") as { id: string; workspaceId: string };

    const { token, session } = createSession(db, account.id, account.workspaceId);
    const stored = db
      .prepare("SELECT token_hash AS tokenHash FROM sessions WHERE id = ?")
      .get(session.id) as { tokenHash: string };

    expect(stored.tokenHash).toBe(sha256Hex(token));
    expect(resolveSession(db, token)).toMatchObject({
      id: session.id,
      tokenHash: stored.tokenHash,
      accountId: account.id,
      workspaceId: account.workspaceId,
    });

    revokeSession(db, token);

    expect(resolveSession(db, token)).toBeNull();
  });
});
