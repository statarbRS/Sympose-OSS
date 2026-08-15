import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CrmConsole } from "@/components/crm/crm-console";
import type { SessionInfo } from "@/server/auth";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  confirmCrmCsvImport,
  previewCrmCsvImport,
} from "@/server/services/crm";

const CSV_HEADER = "email,full_name,organization,title";

function sessionFor(db: Db, workspaceSlug = "northstar"): SessionInfo {
  const workspace = db
    .prepare("SELECT id, name FROM workspaces WHERE slug = ?")
    .get(workspaceSlug) as { id: string; name: string };
  const account = db
    .prepare("SELECT id, email, display_name FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1")
    .get(workspace.id) as { id: string; email: string; display_name: string };
  return {
    id: "crm-import-session",
    tokenHash: "crm-import-token-hash",
    accountId: account.id,
    workspaceId: workspace.id,
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: account.email,
    displayName: account.display_name,
    role: "organizer",
    workspaceSlug,
    workspaceName: workspace.name,
  };
}

function seedCanonicalPeople(db: Db, workspaceId: string): void {
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "person-exact",
    workspaceId,
    "existing@example.test",
    "Exact Existing",
    "Original Org",
    "Original Title",
    "2026-08-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "person-name",
    workspaceId,
    "name-anchor@example.test",
    "Name Anchor",
    "Anchor Org",
    "Anchor Title",
    "2026-08-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO source_records
     (id, workspace_id, provider, source_ref, version, payload_json, imported_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    "source-existing",
    workspaceId,
    "prior.synthetic",
    "prior/row-1",
    JSON.stringify({ record: { email: "existing@example.test", fullName: "Exact Existing" } }),
    "2026-08-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO source_links
     (id, workspace_id, person_id, source_record_id, link_decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "link-existing",
    workspaceId,
    "person-exact",
    "source-existing",
    "prior-import",
    "2026-08-01T00:00:00.000Z",
  );
}

describe("CRM bounded CSV import and merge", () => {
  it("previews normalized candidates, confirms immutable create/merge/reject receipts, and replays safely", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const session = sessionFor(db);
      seedCanonicalPeople(db, session.workspaceId);
      const csv = [
        CSV_HEADER,
        "new@example.test,  New   Contact  ,New Org,Researcher",
        "EXISTING@example.test,Changed Name,Incoming Org,Incoming Title",
        "alias@example.test, name   anchor ,Alias Org,Coordinator",
        "real@company.com,Real Contact,Real Org,External",
        "new@example.test,Duplicate Contact,Other Org,Other Title",
      ].join("\n");

      const preview = previewCrmCsvImport(db, session, "northstar", csv);
      expect(preview).toMatchObject({
        createCount: 1,
        mergeCandidateCount: 2,
        rejectedCount: 2,
        requiresConfirmation: true,
      });
      expect(preview.rows.map((row) => row.disposition)).toEqual([
        "CREATE",
        "MERGE_CANDIDATE",
        "MERGE_CANDIDATE",
        "REJECTED",
        "REJECTED",
      ]);
      expect(preview.rows[1]).toMatchObject({
        matchPersonId: "person-exact",
        matchReason: "EMAIL_EXACT",
      });
      expect(preview.rows[2]).toMatchObject({
        matchPersonId: "person-name",
        matchReason: "NAME_NORMALIZED_CANDIDATE",
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_records WHERE workspace_id = ?").get(session.workspaceId)).toEqual({ count: 1 });

      const receipt = confirmCrmCsvImport(
        db,
        session,
        "northstar",
        csv,
        preview.inputFingerprint,
      );
      expect(receipt).toMatchObject({
        createdCount: 1,
        mergedCount: 2,
        rejectedCount: 2,
        canonicalWrites: true,
        provenance: { sourceRecordCount: 3, sourceLinkCount: 3 },
      });
      expect(receipt.rows.map((row) => row.status)).toEqual([
        "CREATED",
        "MERGED",
        "MERGED",
        "REJECTED",
        "REJECTED",
      ]);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?").get(session.workspaceId),
      ).toEqual({ count: 3 });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM source_links WHERE workspace_id = ?").get(session.workspaceId),
      ).toEqual({ count: 4 });
      expect(
        db.prepare("SELECT canonical_email, full_name, organization, title FROM people WHERE id = ?").get("person-exact"),
      ).toEqual({
        canonical_email: "existing@example.test",
        full_name: "Exact Existing",
        organization: "Original Org",
        title: "Original Title",
      });
      expect(
        db.prepare(
          `SELECT l.person_id
           FROM source_links l
           JOIN source_records r ON r.id = l.source_record_id
           WHERE r.workspace_id = ? AND r.provider = 'crm-csv.synthetic'
           ORDER BY l.person_id`,
        ).all(session.workspaceId),
      ).toHaveLength(3);

      const replay = confirmCrmCsvImport(
        db,
        session,
        "northstar",
        csv,
        preview.inputFingerprint,
      );
      expect(replay).toEqual(receipt);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?").get(session.workspaceId),
      ).toEqual({ count: 3 });
    } finally {
      closeDb(db);
    }
  });

  it("keeps authorization and the visible schema/confirmation boundary explicit", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const session = sessionFor(db);
      let denial: unknown;
      try {
        previewCrmCsvImport(db, session, "acme", `${CSV_HEADER}\nnew@example.test,New,Org,Title`);
      } catch (error) {
        denial = error;
      }
      expect(denial).toMatchObject({ code: "CROSS_WORKSPACE_DENIED" });
      const html = renderToStaticMarkup(
        createElement(CrmConsole, {
          workspaceSlug: "northstar",
          workspaceName: "Northstar Network",
          people: [],
          metrics: {
            totalPeople: 0,
            organizations: 0,
            withOrganization: 0,
            withTitle: 0,
            sourcedPeople: 0,
          },
          events: [],
        }),
      );
      expect(html).toContain('data-testid="crm-csv-file"');
      expect(html).toContain('data-testid="crm-csv-input"');
      expect(html).toContain("email,full_name,organization,title");
      expect(html).toContain("Preview CSV");
      expect(html).toContain("no email is sent");
    } finally {
      closeDb(db);
    }
  });
});
