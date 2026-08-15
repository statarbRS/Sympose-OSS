import { describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import { DenialError, type SessionInfo } from "../../src/server/auth";
import { getWorkspaceBySlug } from "../../src/server/services/queries";
import {
  getCrmWorkspaceView,
  requireCrmOrganizerAccess,
} from "../../src/server/services/crm";
import { importFixtureEvidence } from "../../src/server/services/sources";

function sessionFor(
  workspaceId: string,
  workspaceSlug: string,
  role = "organizer",
): SessionInfo {
  return {
    id: "session-crm-test",
    tokenHash: "token-hash-crm-test",
    accountId: "account-crm-test",
    workspaceId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: "organizer@example.test",
    displayName: "CRM Test Organizer",
    role,
    workspaceSlug,
    workspaceName: workspaceSlug === "northstar" ? "Northstar Network" : "Acme Events",
  };
}

function workspace(db: Db, slug: string): { id: string; slug: string; name: string } {
  const result = getWorkspaceBySlug(db, slug);
  if (!result) {
    throw new Error(`missing test workspace ${slug}`);
  }
  return result;
}

describe("CRM workspace query service", () => {
  it("returns only canonical People from the authorized session workspace with metrics", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      const acme = workspace(db, "acme");
      importFixtureEvidence(db, northstar.id, northstar.slug);
      importFixtureEvidence(db, acme.id, acme.slug);

      const view = getCrmWorkspaceView(db, sessionFor(northstar.id, northstar.slug), "northstar");

      expect(view).not.toBeNull();
      expect(view?.workspace).toEqual(northstar);
      expect(view?.people).toHaveLength(12);
      expect(view?.people.every((person) => person.fullName !== "Wanda Pickles")).toBe(true);
      expect(view?.people[0]).toMatchObject({
        fullName: "Amara Diallo",
        organization: "Lumenworks",
        sourceCount: 1,
      });
      expect(view?.metrics).toEqual({
        totalPeople: 12,
        organizations: 12,
        withOrganization: 12,
        withTitle: 12,
        sourcedPeople: 12,
      });
    } finally {
      closeDb(db);
    }
  });

  it("rejects a foreign route slug before a CRM People read", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      expect(() =>
        requireCrmOrganizerAccess(db, sessionFor(northstar.id, northstar.slug), "acme"),
      ).toThrow(DenialError);
      let denial: unknown;
      try {
        getCrmWorkspaceView(db, sessionFor(northstar.id, northstar.slug), "acme");
      } catch (error) {
        denial = error;
      }
      expect(denial).toMatchObject({ code: "CROSS_WORKSPACE_DENIED" });
    } finally {
      closeDb(db);
    }
  });

  it("rejects reviewer and read-only roles at the CRM service boundary", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspace(db, "northstar");
      for (const role of ["reviewer", "communications_manager", "read_only"]) {
        expect(() =>
          getCrmWorkspaceView(db, sessionFor(northstar.id, northstar.slug, role), northstar.slug),
        ).toThrow(DenialError);
      }
    } finally {
      closeDb(db);
    }
  });
});
