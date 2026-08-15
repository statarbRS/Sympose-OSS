import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionInfo } from "@/server/auth";
import { closeDb, openDb, withTransaction, type Db } from "@/server/db";
import {
  AIRTABLE_CSV_HEADERS,
  AIRTABLE_CSV_LIMITS,
  AIRTABLE_CSV_MAX_BYTES,
  AIRTABLE_CSV_MAX_CELL_BYTES,
  AIRTABLE_CSV_MAX_ROWS,
  AIRTABLE_CSV_SCHEMA,
  ConnectorHubExportError,
  airtableCsvFilename,
  exportAirtablePeopleCsv,
  getConnectorHubView,
  serializeAirtableCsv,
  type AirtableCsvRow,
} from "@/server/services/connector-hub";
import { connectorExportOperation } from "@/server/services/connector-hub/airtable-export-operation";
import { POST } from "@/app/w/[workspace]/connectors/airtable/export/route";

const AT = "2026-08-13T01:30:00.000Z";
const WORKSPACE_A = "workspace-connector-a";
const WORKSPACE_B = "workspace-connector-b";
const ACCOUNT_A = "account-connector-a";
const ACCOUNT_B = "account-connector-b";
const OPERATION_A = "11111111-1111-4111-8111-111111111111";
const OPERATION_B = "22222222-2222-4222-8222-222222222222";
const TEMPORARY_DATABASE_ROOT = resolve(".tmp", "connector-hub");
const createdDirectories: string[] = [];

function sessionFor(
  workspaceId = WORKSPACE_A,
  workspaceSlug = "alpha",
  role = "organizer",
  accountId = ACCOUNT_A,
): SessionInfo {
  return {
    id: `session-${accountId}`,
    tokenHash: `token-${accountId}`,
    accountId,
    workspaceId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: `${accountId}@example.test`,
    displayName: "Connector Organizer",
    role,
    workspaceSlug,
    workspaceName: workspaceSlug === "alpha" ? "Alpha Workspace" : "Bravo Workspace",
  };
}

function seedBase(db: Db): void {
  const insertWorkspace = db.prepare(
    "INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
  );
  insertWorkspace.run(WORKSPACE_A, "alpha", "Alpha Workspace", AT);
  insertWorkspace.run(WORKSPACE_B, "bravo", "Bravo Workspace", AT);
  const insertAccount = db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertAccount.run(ACCOUNT_A, WORKSPACE_A, "alpha@example.test", "Alpha Organizer", "organizer", AT);
  insertAccount.run(ACCOUNT_B, WORKSPACE_B, "bravo@example.test", "Bravo Organizer", "organizer", AT);
}

function seedExactExport(db: Db): void {
  seedBase(db);
  const insertPerson = db.prepare(
    `INSERT INTO people
     (id, workspace_id, canonical_email, full_name, organization, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertPerson.run(
    "person-formula",
    WORKSPACE_A,
    "+formula@example.test",
    '=Formula, "Person"',
    "@Danger",
    "Line one\r\nLine two",
    AT,
  );
  insertPerson.run(
    "person-alpha",
    WORKSPACE_A,
    "alpha@example.test",
    "Alpha Person",
    "Analytical Engines",
    "Director",
    AT,
  );
  insertPerson.run(
    "person-foreign",
    WORKSPACE_B,
    "foreign@example.test",
    "Foreign Person",
    "Bravo",
    "Visitor",
    AT,
  );

  const insertEvent = db.prepare(
    `INSERT INTO events
     (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'planning', ?)`,
  );
  insertEvent.run(
    "event-early",
    WORKSPACE_A,
    "Early, Forum",
    "Europe/Berlin",
    "2026-09-01T09:00:00.000Z",
    "2026-09-01T17:00:00.000Z",
    AT,
  );
  insertEvent.run(
    "event-late",
    WORKSPACE_A,
    "Late Forum",
    "UTC",
    "2026-10-01T09:00:00.000Z",
    "2026-10-01T17:00:00.000Z",
    AT,
  );
  insertEvent.run(
    "event-foreign",
    WORKSPACE_B,
    "Foreign Event",
    "UTC",
    "2026-08-01T09:00:00.000Z",
    "2026-08-01T17:00:00.000Z",
    AT,
  );

  const insertInvolvement = db.prepare(
    `INSERT INTO event_speakers
     (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertInvolvement.run("involvement-early", WORKSPACE_A, "event-early", "person-alpha", "SPEAKER", "CONFIRMED", AT, AT);
  insertInvolvement.run("involvement-late-m", WORKSPACE_A, "event-late", "person-alpha", "MODERATOR", "ACCEPTED", AT, AT);
  insertInvolvement.run("involvement-late-s", WORKSPACE_A, "event-late", "person-alpha", "SPEAKER", "INVITED", AT, AT);
  insertInvolvement.run("involvement-foreign", WORKSPACE_B, "event-foreign", "person-foreign", "SPEAKER", "CONFIRMED", AT, AT);
}

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  mkdirSync(TEMPORARY_DATABASE_ROOT, { recursive: true });
  const directory = mkdtempSync(join(TEMPORARY_DATABASE_ROOT, "reload-"));
  createdDirectories.push(directory);
  return { directory, path: join(directory, "connector.sqlite") };
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Connector Hub Airtable CSV export", () => {
  it("emits exact stable RFC4180 rows, deterministic involvement order, formula safety, and no foreign data", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedExactExport(db);
      const before = {
        people: (db.prepare("SELECT COUNT(*) AS count FROM people").get() as { count: number }).count,
        involvement: (db.prepare("SELECT COUNT(*) AS count FROM event_speakers").get() as { count: number }).count,
      };

      const result = exportAirtablePeopleCsv(db, sessionFor(), "alpha", OPERATION_A);

      expect(AIRTABLE_CSV_HEADERS).toEqual([
        "person_id",
        "full_name",
        "email",
        "organization",
        "title",
        "event_id",
        "event_name",
        "event_starts_at",
        "event_timezone",
        "event_role",
        "participation_status",
      ]);
      const expected = [
        "person_id,full_name,email,organization,title,event_id,event_name,event_starts_at,event_timezone,event_role,participation_status",
        'person-formula,"\'=Formula, ""Person""",\'+formula@example.test,\'@Danger,"Line one\r\nLine two",,,,,,',
        'person-alpha,Alpha Person,alpha@example.test,Analytical Engines,Director,event-early,"Early, Forum",2026-09-01T09:00:00.000Z,Europe/Berlin,SPEAKER,CONFIRMED',
        "person-alpha,Alpha Person,alpha@example.test,Analytical Engines,Director,event-late,Late Forum,2026-10-01T09:00:00.000Z,UTC,MODERATOR,ACCEPTED",
        "person-alpha,Alpha Person,alpha@example.test,Analytical Engines,Director,event-late,Late Forum,2026-10-01T09:00:00.000Z,UTC,SPEAKER,INVITED",
        "",
      ].join("\r\n");
      expect(result.schema).toBe(AIRTABLE_CSV_SCHEMA);
      expect(result.body).toBe(expected);
      expect(result.rowCount).toBe(4);
      expect(result.byteCount).toBe(Buffer.byteLength(expected, "utf8"));
      expect(result.body).not.toContain("Foreign Person");
      expect(result.body).not.toContain("Foreign Event");
      expect(result.fileName).toBe("sympose-alpha-people-events-airtable.csv");
      expect(result.receipt).toMatchObject({
        outcome: "SUCCEEDED",
        providerMutation: false,
        rowCount: 4,
        byteCount: result.byteCount,
        failureCode: null,
      });
      expect(result.receipt.contentSha256).toMatch(/^[0-9a-f]{64}$/u);

      expect((db.prepare("SELECT COUNT(*) AS count FROM people").get() as { count: number }).count).toBe(before.people);
      expect((db.prepare("SELECT COUNT(*) AS count FROM event_speakers").get() as { count: number }).count).toBe(before.involvement);
      const audit = db.prepare(
        "SELECT action, details_json AS detailsJson FROM audit_events WHERE id = ? AND workspace_id = ?",
      ).get(result.receipt.receiptId, WORKSPACE_A) as { action: string; detailsJson: string };
      expect(audit.action).toBe("connector_hub.airtable_csv.export.succeeded");
      expect(JSON.parse(audit.detailsJson)).toMatchObject({
        schema: "connector-hub-local-receipt/v1",
        provider: "airtable",
        outcome: "SUCCEEDED",
        providerMutation: false,
        exportSchema: AIRTABLE_CSV_SCHEMA,
        rowCount: 4,
      });
    } finally {
      closeDb(db);
    }
  });

  it("persists the exact local no-provider-mutation receipt across database reload", () => {
    const { path } = temporaryDatabase();
    let first: Db | null = null;
    let reloaded: Db | null = null;
    try {
      first = openDb({ path, seed: false });
      seedExactExport(first);
      const result = exportAirtablePeopleCsv(first, sessionFor(), "alpha", OPERATION_A);
      closeDb(first);
      first = null;

      reloaded = openDb({ path, seed: false });
      const view = getConnectorHubView(reloaded, sessionFor(), "alpha");
      const airtable = view?.providers.find((provider) => provider.id === "airtable");
      expect(view).toMatchObject({ peopleCount: 2, eventInvolvementCount: 3, exportRowCount: 4 });
      expect(airtable?.connectionStatus).toBe("NOT_CONFIGURED");
      expect(airtable?.lastRun).toEqual(result.receipt);
      expect(airtable?.lastFailure).toBeNull();
      expect(airtable?.evidenceWarning).toBe(false);
    } finally {
      if (reloaded?.isOpen) closeDb(reloaded);
      if (first?.isOpen) closeDb(first);
    }
  });

  it("fails closed at both row and byte bounds and records only a truthful local failure", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedBase(db);
      const insert = db.prepare(
        `INSERT INTO people
         (id, workspace_id, canonical_email, full_name, organization, title, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      );
      withTransaction(db, () => {
        for (let index = 0; index <= AIRTABLE_CSV_MAX_ROWS; index += 1) {
          const suffix = String(index).padStart(5, "0");
          insert.run(`person-${suffix}`, WORKSPACE_A, `person-${suffix}@example.test`, `Person ${suffix}`, AT);
        }
      });

      let rowError: unknown;
      try {
        exportAirtablePeopleCsv(db, sessionFor(), "alpha", OPERATION_A);
      } catch (error) {
        rowError = error;
      }
      expect(rowError).toBeInstanceOf(ConnectorHubExportError);
      expect(rowError).toMatchObject({
        code: "CONNECTOR_EXPORT_ROW_LIMIT",
        receipt: { outcome: "FAILED", providerMutation: false, failureCode: "CONNECTOR_EXPORT_ROW_LIMIT" },
      });
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action = 'connector_hub.airtable_csv.export.succeeded'",
      ).get(WORKSPACE_A) as { count: number }).count).toBe(0);
      expect(getConnectorHubView(db, sessionFor(), "alpha")?.providers.find(
        (provider) => provider.id === "airtable",
      )?.lastFailure).toMatchObject({ failureCode: "CONNECTOR_EXPORT_ROW_LIMIT", providerMutation: false });

      const safeRow: AirtableCsvRow = {
        personId: "person",
        fullName: "Person",
        email: "person@example.test",
        organization: null,
        title: null,
        eventId: null,
        eventName: null,
        eventStartsAt: null,
        eventTimezone: null,
        eventRole: null,
        participationStatus: null,
      };
      const headerBytes = Buffer.byteLength(`${AIRTABLE_CSV_HEADERS.join(",")}\r\n`, "utf8");
      expect(() => serializeAirtableCsv([safeRow], {
        maxRows: 1,
        maxBytes: headerBytes + 1,
        maxCellBytes: AIRTABLE_CSV_MAX_CELL_BYTES,
      })).toThrow(expect.objectContaining({ code: "CONNECTOR_EXPORT_BYTE_LIMIT" }));
      expect(() => serializeAirtableCsv([{ ...safeRow, fullName: "Bad\0Name" }], AIRTABLE_CSV_LIMITS))
        .toThrow(expect.objectContaining({ code: "CONNECTOR_EXPORT_DATA_INVALID" }));
      expect(() => serializeAirtableCsv([{ ...safeRow, fullName: "Bad\u0085Name" }], AIRTABLE_CSV_LIMITS))
        .toThrow(expect.objectContaining({ code: "CONNECTOR_EXPORT_DATA_INVALID" }));
    } finally {
      closeDb(db);
    }
  });

  it("produces an ASCII-only bounded filename and keeps the published byte ceiling exact", () => {
    expect(airtableCsvFilename('../../Nørth "Star"\r\n')).toBe("sympose-nrth-star-people-events-airtable.csv");
    expect(airtableCsvFilename("---")).toBe("sympose-workspace-people-events-airtable.csv");
    expect(AIRTABLE_CSV_MAX_BYTES).toBe(2_097_152);
    expect(AIRTABLE_CSV_LIMITS).toEqual({
      maxRows: 5_000,
      maxBytes: 2_097_152,
      maxCellBytes: 16_384,
    });
  });

  it("replays one stable receipt for the same export operation and conflicts if its data changes", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedExactExport(db);
      const first = exportAirtablePeopleCsv(db, sessionFor(), "alpha", OPERATION_A);
      const replay = exportAirtablePeopleCsv(db, sessionFor(), "alpha", OPERATION_A);
      expect(replay).toMatchObject({
        body: first.body,
        receipt: first.receipt,
        receiptReplayed: true,
      });
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action = 'connector_hub.airtable_csv.export.succeeded'",
      ).get(WORKSPACE_A) as { count: number }).count).toBe(1);

      db.prepare("UPDATE people SET full_name = 'Changed Person' WHERE id = 'person-alpha'").run();
      expect(() => exportAirtablePeopleCsv(db, sessionFor(), "alpha", OPERATION_A))
        .toThrow(expect.objectContaining({ code: "CONNECTOR_EXPORT_OPERATION_CONFLICT" }));
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action LIKE 'connector_hub.airtable_csv.export.%'",
      ).get(WORKSPACE_A) as { count: number }).count).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  it("denies foreign and non-organizer exports without a connector receipt", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedExactExport(db);
      expect(() => exportAirtablePeopleCsv(db, sessionFor(), "bravo", OPERATION_A))
        .toThrow(expect.objectContaining({ code: "CROSS_WORKSPACE_DENIED" }));
      expect(() => exportAirtablePeopleCsv(
        db,
        sessionFor(WORKSPACE_A, "alpha", "read_only"),
        "alpha",
        OPERATION_B,
      )).toThrow(expect.objectContaining({ code: "CAPABILITY_DENIED" }));
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action LIKE 'connector_hub.airtable_csv.export.%'",
      ).get() as { count: number }).count).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("accepts only bodyless same-origin export commands with a bounded operation key", async () => {
    const valid = new Request("https://sympose.test/w/alpha/connectors/airtable/export", {
      method: "POST",
      headers: {
        origin: "https://sympose.test",
        "sec-fetch-site": "same-origin",
        "x-sympose-export-operation": OPERATION_A,
      },
    });
    expect(connectorExportOperation(valid)).toBe(OPERATION_A);
    for (const request of [
      new Request("https://sympose.test/w/alpha/connectors/airtable/export?retry=1", {
        method: "POST",
        headers: { origin: "https://sympose.test", "x-sympose-export-operation": OPERATION_A },
      }),
      new Request("https://sympose.test/w/alpha/connectors/airtable/export", {
        method: "POST",
        headers: { origin: "https://attacker.test", "x-sympose-export-operation": OPERATION_A },
      }),
      new Request("https://sympose.test/w/alpha/connectors/airtable/export", {
        method: "POST",
        headers: { origin: "https://sympose.test", "x-sympose-export-operation": "not-an-operation" },
      }),
      new Request("https://sympose.test/w/alpha/connectors/airtable/export", {
        method: "POST",
        headers: {
          origin: "https://sympose.test",
          "content-length": "2",
          "x-sympose-export-operation": OPERATION_A,
        },
      }),
      new Request("https://sympose.test/w/alpha/connectors/airtable/export", {
        method: "POST",
        headers: { origin: "https://sympose.test", "x-sympose-export-operation": OPERATION_A },
        body: "streamed-without-content-length",
      }),
    ]) {
      expect(connectorExportOperation(request)).toBeNull();
    }

    const rejected = await POST(
      new Request("https://sympose.test/w/alpha/connectors/airtable/export", {
        method: "POST",
        headers: { origin: "https://attacker.test", "x-sympose-export-operation": OPERATION_A },
      }),
      { params: Promise.resolve({ workspace: "alpha" }) },
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe("CONNECTOR_EXPORT_REQUEST_INVALID");
    expect(rejected.headers.get("cache-control")).toContain("no-store");
    expect(rejected.headers.get("x-sympose-provider-mutation")).toBe("false");
  });
});
