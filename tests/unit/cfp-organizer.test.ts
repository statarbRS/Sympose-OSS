import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import type { SessionInfo } from "../../src/server/auth";
import {
  CfpOrganizerError,
  readCfpOrganizerCall,
  readCfpOrganizerOverview,
  saveCfpOrganizerCall,
} from "../../src/server/services/cfp/organizer";

let db: Db | undefined;

function setup(): { readonly session: SessionInfo; readonly eventId: string } {
  db = openDb({ path: ":memory:" });
  const workspace = db.prepare("SELECT id, slug, name FROM workspaces WHERE slug = 'northstar'").get() as {
    id: string;
    slug: string;
    name: string;
  };
  const account = db.prepare("SELECT id, email, display_name, role FROM accounts WHERE workspace_id = ? LIMIT 1").get(workspace.id) as {
    id: string;
    email: string;
    display_name: string;
    role: string;
  };
  const eventId = "organizer-cfp-event";
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    workspace.id,
    "Organizer CFP event",
    "UTC",
    "2026-09-15T09:00:00.000Z",
    "2026-09-15T10:00:00.000Z",
    "planning",
    "2026-08-10T00:00:00.000Z",
  );
  return {
    eventId,
    session: {
      id: "organizer-session",
      tokenHash: "test-token-hash",
      accountId: account.id,
      workspaceId: workspace.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
      email: account.email,
      displayName: account.display_name,
      role: account.role,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
    },
  };
}

afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

describe("CFP organizer builder", () => {
  it("creates a validated draft, publishes it, and locks it after close", () => {
    const { session, eventId } = setup();
    const base = {
      eventId,
      name: "Community Stage",
      slug: "community-stage",
      accessMode: "PUBLIC" as const,
      state: "DRAFT" as const,
      timezone: "UTC",
      opensAt: null,
      closesAt: null,
      fields: [
        { id: "title", type: "shortText", label: "Proposal title", required: true, defaultVisibility: "visible" },
        { id: "consent", type: "consent", label: "Accept terms", required: true, defaultVisibility: "visible" },
      ],
      rules: { schema: "cfp-form-rules/v1", rules: [] },
      policy: {
        disclosure: {
          privacy: "Organizer only",
          retention: "One year",
          aiProcessing: "No AI processing is used in this call.",
          communication: "Application updates only",
          consent: "Required terms are recorded.",
          publication: "Accepted titles may be published.",
        },
        choices: [{ fieldId: "consent", statement: "Accept terms", required: true }],
      },
      publish: false,
    };
    const created = saveCfpOrganizerCall(db!, session, base);
    expect(created.created).toBe(true);
    expect(readCfpOrganizerOverview(db!, session, eventId).calls[0]?.state).toBe("DRAFT");

    const draft = readCfpOrganizerCall(db!, session, eventId, created.callId);
    const published = saveCfpOrganizerCall(db!, session, {
      ...base,
      callId: created.callId,
      expectedUpdatedAt: draft.summary.updatedAt,
      state: "OPEN",
      publish: true,
    });
    expect(published.published).toBe(true);
    expect(readCfpOrganizerCall(db!, session, eventId, created.callId).summary.state).toBe("OPEN");

    const open = readCfpOrganizerCall(db!, session, eventId, created.callId);
    db!.prepare("UPDATE calls SET state = ?, updated_at = ? WHERE id = ?").run(
      "CLOSED",
      "2098-08-11T00:00:00.000Z",
      created.callId,
    );
    expect(() => saveCfpOrganizerCall(db!, session, {
      ...base,
      callId: created.callId,
      expectedUpdatedAt: open.summary.updatedAt,
      name: "Changed after close",
    })).toThrowError(new CfpOrganizerError("CALL_LOCKED"));
  });
});
