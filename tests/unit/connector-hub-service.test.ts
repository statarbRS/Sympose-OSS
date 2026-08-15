import { describe, expect, it } from "vitest";

import { DenialError, type SessionInfo } from "@/server/auth";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  getConnectorHubView,
  requireConnectorHubOrganizerAccess,
} from "@/server/services/connector-hub";

const AT = "2026-08-13T01:45:00.000Z";

function session(
  role = "organizer",
  workspaceId = "workspace-alpha",
  workspaceSlug = "alpha",
): SessionInfo {
  return {
    id: `session-${role}`,
    tokenHash: `token-${role}`,
    accountId: `account-${role}`,
    workspaceId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: `${role}@example.test`,
    displayName: role,
    role,
    workspaceSlug,
    workspaceName: workspaceSlug,
  };
}

function seed(db: Db): void {
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run("workspace-alpha", "alpha", "Alpha", AT);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run("workspace-bravo", "bravo", "Bravo", AT);
  const person = db.prepare(
    `INSERT INTO people
     (id, workspace_id, canonical_email, full_name, organization, title, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
  );
  person.run("person-alpha", "workspace-alpha", "alpha@example.test", "Alpha Person", AT);
  person.run("person-bravo", "workspace-bravo", "bravo@example.test", "Bravo Person", AT);
}

describe("Connector Hub workspace and role boundary", () => {
  it("shows three explicitly unconfigured providers and only authorized workspace counts", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      const view = getConnectorHubView(db, session(), "alpha");
      expect(view).toMatchObject({
        workspace: { id: "workspace-alpha", slug: "alpha", name: "Alpha" },
        peopleCount: 1,
        eventInvolvementCount: 0,
        exportRowCount: 1,
      });
      expect(view?.providers.map((provider) => [provider.name, provider.connectionStatus])).toEqual([
        ["HubSpot", "NOT_CONFIGURED"],
        ["Salesforce", "NOT_CONFIGURED"],
        ["Airtable", "NOT_CONFIGURED"],
      ]);
      expect(view?.providers[0]?.lastRun).toBeNull();
      expect(view?.providers[0]?.lastFailure).toBeNull();
      expect(view?.providers[1]?.fieldMappings).toEqual([]);
      expect(view?.providers[2]?.capabilities).toContainEqual(expect.objectContaining({
        label: "Airtable-compatible CSV",
        state: "AVAILABLE",
      }));
      expect(view?.providers[2]?.capabilities).toContainEqual(expect.objectContaining({
        label: "Airtable API mutation",
        state: "DISABLED",
      }));
    } finally {
      closeDb(db);
    }
  });

  it("rejects a foreign route slug with the exact tenant denial before a hub projection", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      let denial: unknown;
      try {
        getConnectorHubView(db, session(), "bravo");
      } catch (error) {
        denial = error;
      }
      expect(denial).toBeInstanceOf(DenialError);
      expect(denial).toMatchObject({ code: "CROSS_WORKSPACE_DENIED", target: "bravo" });
    } finally {
      closeDb(db);
    }
  });

  it.each(["reviewer", "communications_manager", "read_only"])(
    "rejects %s with the exact capability denial",
    (role) => {
      const db = openDb({ path: ":memory:", seed: false });
      try {
        seed(db);
        let denial: unknown;
        try {
          requireConnectorHubOrganizerAccess(db, session(role), "alpha");
        } catch (error) {
          denial = error;
        }
        expect(denial).toBeInstanceOf(DenialError);
        expect(denial).toMatchObject({
          code: "CAPABILITY_DENIED",
          target: "connectors.manage",
        });
      } finally {
        closeDb(db);
      }
    },
  );

  it("refuses to present malformed connector audit rows as a run or failure", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seed(db);
      db.prepare(
        `INSERT INTO audit_events
         (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
         VALUES ('bad-evidence', 'workspace-alpha', 'system', 'test',
                 'connector_hub.airtable_csv.export.succeeded', 'connector', 'airtable-csv', '{}', ?)`,
      ).run(AT);
      const airtable = getConnectorHubView(db, session(), "alpha")?.providers.find(
        (provider) => provider.id === "airtable",
      );
      expect(airtable?.lastRun).toBeNull();
      expect(airtable?.lastFailure).toBeNull();
      expect(airtable?.evidenceWarning).toBe(true);
    } finally {
      closeDb(db);
    }
  });
});
