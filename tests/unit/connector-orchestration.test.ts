import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DenialError, type SessionInfo } from "@/server/auth";
import { closeDb, openDb, type Db } from "@/server/db";
import { canonicalJson, fingerprintOf } from "@/server/canonical";
import { getCrmWorkspaceView } from "@/server/services/crm";
import {
  CONNECTOR_VAULT_KEY_ENV,
  ConnectorConnectionError,
  ConnectorOrchestrationError,
  connectorExportFactFamilies,
  connectorExportPurposeActionFamily,
  confirmConnectorImport,
  createConnectorImportPreview,
  exportCanonicalPeopleToConnector,
  revokeConnectorConnection,
  saveConnectorConnection,
  testConnectorConnection,
  type ConnectorProviderId,
} from "@/server/services/connector-hub";
import {
  createAuthorityEvidence,
  createPurposeAuthorizationEvidence,
  createRetentionEvidence,
  fingerprintPurposeAuthorizationEvidence,
  fingerprintRetentionEvidence,
} from "@/server/services/authority-purpose-kernel";
import {
  CONNECTOR_EXECUTION_MODE_ENV,
  CONNECTOR_FIXTURE_EXECUTION_MODE,
  createConnectorFixtureRuntime,
  createSyntheticConnectorFixtureRuntime,
} from "@/server/services/connector-hub/fixture-runtime";
import { createConnectorNetworkRuntime } from "@/server/services/connector-hub/network-runtime";
import type { FetchLike } from "@/server/services/connector-hub/providers";

const VAULT_KEY = Buffer.alloc(32, 0x5a).toString("base64");
const AT = "2026-08-15T00:00:00.000Z";
const WORKSPACE_A = "workspace-connector-orchestration-a";
const WORKSPACE_B = "workspace-connector-orchestration-b";
const EVENT_A = "event-connector-orchestration-a";
const EVENT_B = "event-connector-orchestration-b";

function session(
  role = "organizer",
  workspaceId = WORKSPACE_A,
  workspaceSlug = "connector-alpha",
  accountId = `account-${role}-${workspaceId}`,
): SessionInfo {
  return {
    id: `session-${role}-${workspaceId}`,
    tokenHash: `token-${role}-${workspaceId}`,
    accountId,
    workspaceId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: `${role}@example.test`,
    displayName: role,
    role,
    workspaceSlug,
    workspaceName: workspaceSlug,
  };
}

function seedScope(db: Db): void {
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(WORKSPACE_A, "connector-alpha", "Connector Alpha", AT);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(WORKSPACE_B, "connector-bravo", "Connector Bravo", AT);
  for (const actor of [
    session(),
    session("event_manager"),
    session("organizer", WORKSPACE_B, "connector-bravo"),
  ]) {
    db.prepare(
      "INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(actor.accountId, actor.workspaceId, actor.email, actor.displayName, actor.role, AT);
  }
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, 'UTC', ?, ?, ?)`,
  ).run(EVENT_A, WORKSPACE_A, "Connector Alpha Event", "2026-09-01T09:00:00.000Z", "2026-09-01T17:00:00.000Z", AT);
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, 'UTC', ?, ?, ?)`,
  ).run(EVENT_B, WORKSPACE_B, "Connector Bravo Event", "2026-09-02T09:00:00.000Z", "2026-09-02T17:00:00.000Z", AT);
}

function saveConnection(db: Db, provider: ConnectorProviderId): void {
  const config = provider === "airtable"
    ? { baseId: "appSynthetic", tableName: "People" }
    : provider === "hubspot"
      ? { portalId: "123456", portalName: "Synthetic Portal" }
      : { instanceUrl: "https://sympose.my.salesforce.com", apiVersion: "v60.0" };
  saveConnectorConnection(db, session(), "connector-alpha", {
    provider,
    config,
    secret: `public-synthetic-${provider}-secret`,
    expectedVersion: 0,
  });
}

type TestAuthorityMode = "READY" | "DENIED" | "WITHDRAWN" | "EXPIRED" | "MALFORMED" | "ABSENT";

function authorizeAllPeople(
  db: Db,
  provider: ConnectorProviderId,
  modes: Readonly<Record<string, TestAuthorityMode>> = {},
): void {
  const connection = db.prepare(
    `SELECT id, version FROM connector_connections
     WHERE workspace_id = ? AND provider = ? AND status = 'ACTIVE'`,
  ).get(WORKSPACE_A, provider) as { readonly id: string; readonly version: number };
  const people = db.prepare(
    `SELECT id AS personId, full_name AS fullName, canonical_email AS email, organization, title
     FROM people WHERE workspace_id = ? ORDER BY id`,
  ).all(WORKSPACE_A) as Array<{
    readonly personId: string;
    readonly fullName: string;
    readonly email: string;
    readonly organization: string | null;
    readonly title: string | null;
  }>;
  for (const person of people) {
    const mode = modes[person.personId] ?? "READY";
    if (mode === "ABSENT") continue;
    const actionFamily = connectorExportPurposeActionFamily(provider, connection.id, connection.version);
    const factFamilies = connectorExportFactFamilies(provider, person);
    const subject = { kind: "PERSON", id: person.personId } as const;
    const purposeBody = {
      purposeId: `purpose:${provider}:${person.personId}`,
      version: 1,
      workspaceId: WORKSPACE_A,
      eventId: EVENT_A,
      subject,
      allowedActionFamilies: mode === "DENIED" ? [] : [actionFamily],
      allowedFactFamilies: factFamilies,
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: mode === "EXPIRED" ? "2026-02-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
      revoked: false,
    };
    const purpose = mode === "MALFORMED"
      ? {
          schema: "authority-purpose-evidence/v1",
          purposeId: purposeBody.purposeId,
          version: 1,
          fingerprint: "0".repeat(64),
          workspaceId: WORKSPACE_A,
          eventId: EVENT_A,
          subject,
          allowedActionFamilies: [actionFamily],
          validFrom: purposeBody.validFrom,
          expiresAt: purposeBody.expiresAt,
          revoked: false,
        }
      : createPurposeAuthorizationEvidence({
          ...purposeBody,
          fingerprint: fingerprintPurposeAuthorizationEvidence(purposeBody),
        });
    const retentionBody = {
      policyId: `retention:${provider}:${person.personId}`,
      version: 1,
      workspaceId: WORKSPACE_A,
      eventId: EVENT_A,
      subject,
      allowedFactFamilies: factFamilies,
      retainUntil: "2099-01-01T00:00:00.000Z",
      deleted: false,
      withdrawn: mode === "WITHDRAWN",
    };
    const retention = createRetentionEvidence({
      ...retentionBody,
      fingerprint: fingerprintRetentionEvidence(retentionBody),
    });
    const vector = [{
      family: "EXTERNAL_PROVIDER_POLICY",
      version: 1,
      fingerprint: fingerprintOf({
        schema: "test-external-provider-policy/v1",
        workspaceId: WORKSPACE_A,
        eventId: EVENT_A,
        provider,
        connectionId: connection.id,
      }),
    }];
    const authority = createAuthorityEvidence({
      workspaceId: WORKSPACE_A,
      eventId: EVENT_A,
      vector,
    });
    db.prepare(
      `INSERT INTO connector_export_authority_versions
         (id, workspace_id, connection_id, provider, person_id, event_id, version,
          purpose_evidence_json, purpose_evidence_fingerprint,
          retention_evidence_json, retention_evidence_fingerprint,
          authority_evidence_json, authority_evidence_fingerprint, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `export-authority:${provider}:${person.personId}`,
      WORKSPACE_A,
      connection.id,
      provider,
      person.personId,
      EVENT_A,
      canonicalJson(purpose),
      fingerprintOf(purpose),
      canonicalJson(retention),
      fingerprintOf(retention),
      canonicalJson(authority),
      fingerprintOf(authority),
      AT,
    );
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function testRuntime(
  provider: ConnectorProviderId,
  fetch: FetchLike,
  clock = () => Date.parse(AT),
) {
  return createConnectorFixtureRuntime(provider, fetch, {
    clock,
    sleeper: async () => undefined,
    maxRetries: 0,
    timeoutMs: 1_000,
  });
}

function testNetworkRuntime(
  provider: ConnectorProviderId,
  fetch: FetchLike,
  clock = () => Date.parse(AT),
) {
  return createConnectorNetworkRuntime(provider, fetch, {
    clock,
    sleeper: async () => undefined,
    maxRetries: 0,
    timeoutMs: 1_000,
  });
}

describe("durable connector orchestration", () => {
  let priorVaultKey: string | undefined;
  let priorExecutionMode: string | undefined;

  beforeEach(() => {
    priorVaultKey = process.env[CONNECTOR_VAULT_KEY_ENV];
    priorExecutionMode = process.env[CONNECTOR_EXECUTION_MODE_ENV];
    process.env[CONNECTOR_VAULT_KEY_ENV] = VAULT_KEY;
    process.env[CONNECTOR_EXECUTION_MODE_ENV] = CONNECTOR_FIXTURE_EXECUTION_MODE;
  });

  afterEach(() => {
    if (priorVaultKey === undefined) delete process.env[CONNECTOR_VAULT_KEY_ENV];
    else process.env[CONNECTOR_VAULT_KEY_ENV] = priorVaultKey;
    if (priorExecutionMode === undefined) delete process.env[CONNECTOR_EXECUTION_MODE_ENV];
    else process.env[CONNECTOR_EXECUTION_MODE_ENV] = priorExecutionMode;
  });

  it("imports all three paginated adapters only after an explicit one-time confirmation", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      for (const provider of ["airtable", "hubspot", "salesforce"] as const) saveConnection(db, provider);

      const previews = [];
      for (const provider of ["airtable", "hubspot", "salesforce"] as const) {
        const preview = await createConnectorImportPreview(
          db,
          session(),
          "connector-alpha",
          provider,
          `import-${provider}-fixture-v1`,
          createSyntheticConnectorFixtureRuntime(provider),
        );
        expect(preview.run.state).toBe("PREVIEW_READY");
        expect(preview.confirmationToken).toMatch(/^[0-9a-f]{64}$/u);
        expect(db.prepare("SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?").get(WORKSPACE_A))
          .toEqual({ count: previews.reduce((total, value) => total + value, 0) });
        const conflicts = preview.rows.filter((row) => row.disposition === "CONFLICT").length;
        const confirmation = confirmConnectorImport(
          db,
          session(),
          "connector-alpha",
          preview.run.id,
          preview.confirmationToken ?? undefined,
        );
        expect(confirmation.run.state).toBe("SUCCEEDED");
        expect(confirmation.conflicts).toBe(conflicts);
        previews.push(preview.rows.length - conflicts);
        expect(() => confirmConnectorImport(
          db,
          session(),
          "connector-alpha",
          preview.run.id,
          preview.confirmationToken ?? undefined,
        )).toThrowError(ConnectorOrchestrationError);
      }

      expect(previews).toEqual([1, 2, 2]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ count: 5 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_records WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ count: 5 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_links WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ count: 5 });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM person_projection_decisions WHERE workspace_id = ? AND decision_kind = 'CREATE_FROM_SOURCE'",
      ).get(WORKSPACE_A)).toEqual({ count: 5 });
      const crm = getCrmWorkspaceView(db, session(), "connector-alpha");
      expect(crm?.people.map((person) => person.canonicalEmail)).toEqual(expect.arrayContaining([
        "ada.fixture@example.test",
        "grace.fixture@example.test",
        "katherine.fixture@example.test",
      ]));

      const reloaded = await createConnectorImportPreview(
        db,
        session(),
        "connector-alpha",
        "hubspot",
        "import-hubspot-fixture-v1",
        createSyntheticConnectorFixtureRuntime("hubspot"),
      ).catch((error: unknown) => error);
      expect(reloaded).toBeInstanceOf(ConnectorOrchestrationError);
      expect(reloaded).toMatchObject({ code: "CONNECTOR_RUN_STATE_INVALID" });
    } finally {
      closeDb(db);
    }
  });

  it("keeps provider identity stable across source versions and fingerprints Airtable field changes", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      saveConnection(db, "airtable");
      const contact = (title: string) => ({
        records: [{
          id: "recStableIdentity",
          createdTime: "2026-08-14T10:00:00.000Z",
          fields: {
            full_name: "Stable Fixture",
            email: "stable.fixture@example.test",
            organization: "Public Synthetic Lab",
            title,
          },
        }],
      });
      const first = await createConnectorImportPreview(
        db,
        session(),
        "connector-alpha",
        "airtable",
        "stable-airtable-import-1",
        testRuntime("airtable", async () => jsonResponse(200, contact("First title"))),
      );
      confirmConnectorImport(db, session(), "connector-alpha", first.run.id, first.confirmationToken ?? undefined);

      const second = await createConnectorImportPreview(
        db,
        session(),
        "connector-alpha",
        "airtable",
        "stable-airtable-import-2",
        testRuntime(
          "airtable",
          async () => jsonResponse(200, contact("Changed title")),
          () => Date.parse("2026-08-15T01:00:00.000Z"),
        ),
      );
      expect(second.rows[0]).toMatchObject({
        externalIdentity: first.rows[0]?.externalIdentity,
        sourceVersion: first.rows[0]?.sourceVersion,
        disposition: "UPDATE",
      });
      expect(second.rows[0]?.evidenceFingerprint).not.toBe(first.rows[0]?.evidenceFingerprint);
      confirmConnectorImport(db, session(), "connector-alpha", second.run.id, second.confirmationToken ?? undefined);

      expect(db.prepare(
        "SELECT canonical_email AS email, title FROM people WHERE workspace_id = ?",
      ).all(WORKSPACE_A)).toEqual([{ email: "stable.fixture@example.test", title: "Changed title" }]);
      expect(db.prepare(
        "SELECT source_ref AS sourceRef, version, payload_json AS payloadJson FROM source_records WHERE workspace_id = ? ORDER BY version",
      ).all(WORKSPACE_A)).toEqual([
        expect.objectContaining({ sourceRef: expect.stringMatching(/:recStableIdentity$/u), version: 1 }),
        expect.objectContaining({ sourceRef: expect.stringMatching(/:recStableIdentity$/u), version: 2 }),
      ]);
      const decisions = db.prepare(
        `SELECT decision_kind AS decisionKind, previous_projection_json AS previousProjectionJson,
                next_projection_json AS nextProjectionJson, confirmed_by_account_id AS confirmedByAccountId
           FROM person_projection_decisions WHERE workspace_id = ? ORDER BY created_at, decision_kind`,
      ).all(WORKSPACE_A) as Array<{
        decisionKind: string;
        previousProjectionJson: string | null;
        nextProjectionJson: string;
        confirmedByAccountId: string;
      }>;
      expect(decisions).toHaveLength(2);
      expect(decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          decisionKind: "CREATE_FROM_SOURCE",
          previousProjectionJson: null,
          confirmedByAccountId: session().accountId,
        }),
        expect.objectContaining({
          decisionKind: "UPDATE_FROM_SOURCE",
          confirmedByAccountId: session().accountId,
        }),
      ]));
      const updateDecision = decisions.find((decision) => decision.decisionKind === "UPDATE_FROM_SOURCE");
      expect(JSON.parse(updateDecision?.previousProjectionJson ?? "null")).toMatchObject({ title: "First title" });
      expect(JSON.parse(updateDecision?.nextProjectionJson ?? "null")).toMatchObject({ title: "Changed title" });

      const unchanged = await createConnectorImportPreview(
        db,
        session(),
        "connector-alpha",
        "airtable",
        "stable-airtable-import-3",
        testRuntime(
          "airtable",
          async () => jsonResponse(200, contact("Changed title")),
          () => Date.parse("2026-08-15T02:00:00.000Z"),
        ),
      );
      expect(unchanged.rows[0]).toMatchObject({ disposition: "LINK" });
      confirmConnectorImport(db, session(), "connector-alpha", unchanged.run.id, unchanged.confirmationToken ?? undefined);
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_records WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM person_projection_decisions WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ count: 2 });

      const drifted = await createConnectorImportPreview(
        db,
        session(),
        "connector-alpha",
        "airtable",
        "stable-airtable-import-4",
        testRuntime(
          "airtable",
          async () => jsonResponse(200, contact("Provider title after preview")),
          () => Date.parse("2026-08-15T03:00:00.000Z"),
        ),
      );
      expect(drifted.rows[0]).toMatchObject({ disposition: "UPDATE" });
      db.prepare("UPDATE people SET title = 'Human edit after preview' WHERE workspace_id = ?")
        .run(WORKSPACE_A);
      expect(() => confirmConnectorImport(
        db,
        session(),
        "connector-alpha",
        drifted.run.id,
        drifted.confirmationToken ?? undefined,
      )).toThrowError(ConnectorOrchestrationError);
      expect(db.prepare("SELECT title FROM people WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ title: "Human edit after preview" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_records WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ count: 2 });
    } finally {
      closeDb(db);
    }
  });

  it("binds confirmation to the preview actor and expiry without denied write side effects", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      saveConnection(db, "hubspot");
      const userB = session("organizer", WORKSPACE_A, "connector-alpha", "account-organizer-user-b");
      db.prepare(
        "INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(userB.accountId, WORKSPACE_A, "organizer-b@example.test", "Organizer B", "organizer", AT);
      const preview = await createConnectorImportPreview(
        db,
        session(),
        "connector-alpha",
        "hubspot",
        "confirmation-actor-expiry",
        testRuntime("hubspot", async () => jsonResponse(200, {
          results: [{
            id: "confirmation-contact",
            updatedAt: AT,
            properties: { email: "confirmation@example.test", firstname: "Confirm", lastname: "Fixture" },
          }],
        })),
      );

      expect(() => confirmConnectorImport(
        db, userB, "connector-alpha", preview.run.id, preview.confirmationToken ?? undefined,
      )).toThrowError(ConnectorOrchestrationError);
      expect(db.prepare("SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_records WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ count: 0 });

      db.prepare(
        "UPDATE connector_runs SET confirmation_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      ).run(preview.run.id);
      expect(() => confirmConnectorImport(
        db, session(), "connector-alpha", preview.run.id, preview.confirmationToken ?? undefined,
      )).toThrowError(ConnectorOrchestrationError);
      expect(db.prepare("SELECT state FROM connector_runs WHERE id = ?").get(preview.run.id))
        .toEqual({ state: "PREVIEW_READY" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?").get(WORKSPACE_A))
        .toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("rolls back every confirmation side effect when a later CREATE conflicts and leaves invalid confirmation inert", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      saveConnection(db, "hubspot");
      const preview = await createConnectorImportPreview(
        db,
        session(),
        "connector-alpha",
        "hubspot",
        "atomic-two-create-confirmation",
        testRuntime("hubspot", async () => jsonResponse(200, {
          results: [
            {
              id: "atomic-create-1",
              updatedAt: AT,
              properties: { email: "atomic-one@example.test", firstname: "Atomic", lastname: "One" },
            },
            {
              id: "atomic-create-2",
              updatedAt: AT,
              properties: { email: "atomic-two@example.test", firstname: "Atomic", lastname: "Two" },
            },
          ],
        })),
      );
      expect(preview.rows.map(({ disposition }) => disposition)).toEqual(["CREATE", "CREATE"]);
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("person-human-race", WORKSPACE_A, "atomic-two@example.test", "Human Race Winner", AT);

      const inventory = () => ({
        people: db.prepare(
          "SELECT id, canonical_email AS email, full_name AS fullName FROM people WHERE workspace_id = ? ORDER BY id",
        ).all(WORKSPACE_A),
        sources: db.prepare(
          "SELECT id, source_ref AS sourceRef FROM source_records WHERE workspace_id = ? ORDER BY id",
        ).all(WORKSPACE_A),
        links: db.prepare(
          "SELECT id, person_id AS personId, source_record_id AS sourceRecordId FROM source_links WHERE workspace_id = ? ORDER BY id",
        ).all(WORKSPACE_A),
        decisions: db.prepare(
          "SELECT id, person_id AS personId FROM person_projection_decisions WHERE workspace_id = ? ORDER BY id",
        ).all(WORKSPACE_A),
        run: db.prepare(
          `SELECT state, confirmation_token_hash AS tokenHash,
                  confirmation_expires_at AS expiresAt, confirmed_at AS confirmedAt,
                  confirmed_by_account_id AS confirmedBy, completed_at AS completedAt
           FROM connector_runs WHERE id = ?`,
        ).get(preview.run.id),
        applied: db.prepare(
          "SELECT id, applied_source_record_id AS appliedSourceRecordId FROM connector_import_preview_rows WHERE run_id = ? ORDER BY id",
        ).all(preview.run.id),
        audits: db.prepare(
          "SELECT id, action FROM audit_events WHERE workspace_id = ? ORDER BY id",
        ).all(WORKSPACE_A),
      });

      const beforeInvalid = inventory();
      expect(() => confirmConnectorImport(
        db, session(), "connector-alpha", preview.run.id, "f".repeat(64),
      )).toThrowError(ConnectorOrchestrationError);
      expect(inventory()).toEqual(beforeInvalid);

      expect(() => confirmConnectorImport(
        db, session(), "connector-alpha", preview.run.id, preview.confirmationToken ?? undefined,
      )).toThrow();
      expect(inventory()).toEqual(beforeInvalid);
    } finally {
      closeDb(db);
    }
  });

  it("reopens complete CREATE, UPDATE, LINK, and CONFLICT evidence and rejects manifest-preserving decision tampering", async () => {
    const directory = mkdtempSync("/tmp/sympose-v21-projection-integrity-");
    const path = join(directory, "connector.sqlite");
    let db: Db | null = openDb({ path, seed: false });
    try {
      seedScope(db);
      saveConnection(db, "airtable");
      const stableContact = (title: string) => ({
        records: [{
          id: "recV21Integrity",
          createdTime: AT,
          fields: {
            full_name: "V21 Integrity Fixture",
            email: "v21.integrity@example.test",
            organization: "Integrity Lab",
            title,
          },
        }],
      });
      const createPreview = await createConnectorImportPreview(
        db, session(), "connector-alpha", "airtable", "v21-create",
        testRuntime("airtable", async () => jsonResponse(200, stableContact("Original"))),
      );
      expect(createPreview.rows[0]?.disposition).toBe("CREATE");
      confirmConnectorImport(db, session(), "connector-alpha", createPreview.run.id, createPreview.confirmationToken ?? undefined);

      const updatePreview = await createConnectorImportPreview(
        db, session(), "connector-alpha", "airtable", "v21-update",
        testRuntime("airtable", async () => jsonResponse(200, stableContact("Updated"))),
      );
      expect(updatePreview.rows[0]?.disposition).toBe("UPDATE");
      confirmConnectorImport(db, session(), "connector-alpha", updatePreview.run.id, updatePreview.confirmationToken ?? undefined);

      const linkPreview = await createConnectorImportPreview(
        db, session(), "connector-alpha", "airtable", "v21-link",
        testRuntime("airtable", async () => jsonResponse(200, stableContact("Updated"))),
      );
      expect(linkPreview.rows[0]?.disposition).toBe("LINK");
      confirmConnectorImport(db, session(), "connector-alpha", linkPreview.run.id, linkPreview.confirmationToken ?? undefined);

      const conflictPreview = await createConnectorImportPreview(
        db,
        session(),
        "connector-alpha",
        "airtable",
        "v21-conflict",
        testRuntime("airtable", async () => jsonResponse(200, {
          records: [
            { id: "recV21ConflictA", createdTime: AT, fields: { full_name: "Conflict A", email: "collision@example.test" } },
            { id: "recV21ConflictB", createdTime: AT, fields: { full_name: "Conflict B", email: "collision@example.test" } },
          ],
        })),
      );
      expect(conflictPreview.rows.map(({ disposition }) => disposition)).toEqual(["CONFLICT", "CONFLICT"]);
      confirmConnectorImport(db, session(), "connector-alpha", conflictPreview.run.id, conflictPreview.confirmationToken ?? undefined);

      expect(db.prepare(
        "SELECT decision_kind AS decisionKind FROM person_projection_decisions ORDER BY decision_kind",
      ).all()).toEqual([
        { decisionKind: "CREATE_FROM_SOURCE" },
        { decisionKind: "UPDATE_FROM_SOURCE" },
      ]);
      expect(db.prepare(
        `SELECT disposition, COUNT(*) AS count,
                SUM(CASE WHEN applied_source_record_id IS NULL THEN 0 ELSE 1 END) AS applied
         FROM connector_import_preview_rows GROUP BY disposition ORDER BY disposition`,
      ).all()).toEqual([
        { disposition: "CONFLICT", count: 2, applied: 0 },
        { disposition: "CREATE", count: 1, applied: 1 },
        { disposition: "LINK", count: 1, applied: 1 },
        { disposition: "UPDATE", count: 1, applied: 1 },
      ]);
      expect(() => db!.prepare(
        "UPDATE person_projection_decisions SET created_at = created_at WHERE decision_kind = 'CREATE_FROM_SOURCE'",
      ).run()).toThrow(/immutable/u);
      expect(() => db!.prepare(
        "DELETE FROM person_projection_decisions WHERE decision_kind = 'CREATE_FROM_SOURCE'",
      ).run()).toThrow(/immutable/u);

      const replayInventory = {
        people: db.prepare("SELECT * FROM people ORDER BY id").all(),
        sources: db.prepare("SELECT * FROM source_records ORDER BY id").all(),
        links: db.prepare("SELECT * FROM source_links ORDER BY id").all(),
        decisions: db.prepare("SELECT * FROM person_projection_decisions ORDER BY id").all(),
        run: db.prepare("SELECT * FROM connector_runs WHERE id = ?").get(linkPreview.run.id),
      };
      expect(() => confirmConnectorImport(
        db!, session(), "connector-alpha", linkPreview.run.id, linkPreview.confirmationToken ?? undefined,
      )).toThrowError(ConnectorOrchestrationError);
      expect({
        people: db.prepare("SELECT * FROM people ORDER BY id").all(),
        sources: db.prepare("SELECT * FROM source_records ORDER BY id").all(),
        links: db.prepare("SELECT * FROM source_links ORDER BY id").all(),
        decisions: db.prepare("SELECT * FROM person_projection_decisions ORDER BY id").all(),
        run: db.prepare("SELECT * FROM connector_runs WHERE id = ?").get(linkPreview.run.id),
      }).toEqual(replayInventory);

      closeDb(db);
      db = null;
      db = openDb({ path, seed: false });
      expect(db.prepare("SELECT COUNT(*) AS count FROM person_projection_decisions").get()).toEqual({ count: 2 });
      closeDb(db);
      db = null;

      const restoreTriggerAround = (
        raw: DatabaseSync,
        triggerName: string,
        mutate: () => void,
      ): void => {
        const trigger = raw.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        ).get(triggerName) as { readonly sql: string } | undefined;
        if (!trigger?.sql) throw new Error(`missing trigger ${triggerName}`);
        raw.exec(`DROP TRIGGER \"${triggerName}\"`);
        mutate();
        raw.exec(trigger.sql);
      };
      const updateDecision = (
        raw: DatabaseSync,
        mutate: (row: { previousJson: string; nextJson: string }) => { column: string; value: string },
      ): void => {
        const row = raw.prepare(
          `SELECT previous_projection_json AS previousJson, next_projection_json AS nextJson
           FROM person_projection_decisions WHERE decision_kind = 'UPDATE_FROM_SOURCE'`,
        ).get() as { readonly previousJson: string; readonly nextJson: string };
        const change = mutate(row);
        const allowed = new Set([
          "previous_projection_json", "previous_projection_fingerprint",
          "next_projection_json", "next_projection_fingerprint", "confirmed_by_account_id",
        ]);
        if (!allowed.has(change.column)) throw new Error("invalid test mutation column");
        raw.prepare(`UPDATE person_projection_decisions SET ${change.column} = ? WHERE decision_kind = 'UPDATE_FROM_SOURCE'`)
          .run(change.value);
      };
      const tamperCases: ReadonlyArray<{
        readonly label: string;
        readonly mutate: (raw: DatabaseSync) => void;
      }> = [
        {
          label: "noncanonical next JSON",
          mutate: (raw) => restoreTriggerAround(raw, "trg_person_projection_decisions_immutable", () => {
            updateDecision(raw, ({ nextJson }) => {
              const value = JSON.parse(nextJson) as Record<string, unknown>;
              return {
                column: "next_projection_json",
                value: JSON.stringify({
                  title: value.title,
                  organization: value.organization,
                  fullName: value.fullName,
                  canonicalEmail: value.canonicalEmail,
                  id: value.id,
                  schema: value.schema,
                }),
              };
            });
          }),
        },
        {
          label: "next fingerprint",
          mutate: (raw) => restoreTriggerAround(raw, "trg_person_projection_decisions_immutable", () => {
            updateDecision(raw, () => ({ column: "next_projection_fingerprint", value: "0".repeat(64) }));
          }),
        },
        {
          label: "exact previous projection linkage",
          mutate: (raw) => restoreTriggerAround(raw, "trg_person_projection_decisions_immutable", () => {
            const row = raw.prepare(
              "SELECT previous_projection_json AS json FROM person_projection_decisions WHERE decision_kind = 'UPDATE_FROM_SOURCE'",
            ).get() as { readonly json: string };
            const changed = { ...(JSON.parse(row.json) as Record<string, unknown>), title: "Tampered before" };
            raw.prepare(
              `UPDATE person_projection_decisions
               SET previous_projection_json = ?, previous_projection_fingerprint = ?
               WHERE decision_kind = 'UPDATE_FROM_SOURCE'`,
            ).run(canonicalJson(changed), fingerprintOf(changed));
          }),
        },
        {
          label: "exact next projection linkage",
          mutate: (raw) => restoreTriggerAround(raw, "trg_person_projection_decisions_immutable", () => {
            const row = raw.prepare(
              "SELECT next_projection_json AS json FROM person_projection_decisions WHERE decision_kind = 'UPDATE_FROM_SOURCE'",
            ).get() as { readonly json: string };
            const changed = { ...(JSON.parse(row.json) as Record<string, unknown>), title: "Tampered after" };
            raw.prepare(
              `UPDATE person_projection_decisions
               SET next_projection_json = ?, next_projection_fingerprint = ?
               WHERE decision_kind = 'UPDATE_FROM_SOURCE'`,
            ).run(canonicalJson(changed), fingerprintOf(changed));
          }),
        },
        {
          label: "confirmation actor scope",
          mutate: (raw) => restoreTriggerAround(raw, "trg_person_projection_decisions_immutable", () => {
            updateDecision(raw, () => ({
              column: "confirmed_by_account_id",
              value: session("event_manager").accountId,
            }));
          }),
        },
        {
          label: "missing CREATE decision completeness",
          mutate: (raw) => restoreTriggerAround(raw, "trg_person_projection_decisions_no_delete", () => {
            raw.prepare("DELETE FROM person_projection_decisions WHERE decision_kind = 'CREATE_FROM_SOURCE'").run();
          }),
        },
        {
          label: "rogue LINK decision",
          mutate: (raw) => restoreTriggerAround(raw, "trg_person_projection_decisions_scope_guard", () => {
            raw.exec(
              `INSERT INTO person_projection_decisions
                 (id, workspace_id, person_id, source_record_id, import_run_id, preview_row_id,
                  decision_kind, previous_projection_json, previous_projection_fingerprint,
                  next_projection_json, next_projection_fingerprint, decision_method,
                  confirmed_by_account_id, created_at)
               SELECT 'rogue-link-decision', preview.workspace_id, preview.candidate_person_id,
                      preview.applied_source_record_id, preview.run_id, preview.id,
                      'UPDATE_FROM_SOURCE', template.previous_projection_json,
                      template.previous_projection_fingerprint, template.next_projection_json,
                      template.next_projection_fingerprint, 'EXPLICIT_ORGANIZER_CONFIRMATION',
                      run.confirmed_by_account_id, run.confirmed_at
               FROM connector_import_preview_rows preview
               JOIN connector_runs run ON run.id = preview.run_id
               JOIN person_projection_decisions template ON template.decision_kind = 'UPDATE_FROM_SOURCE'
               WHERE preview.disposition = 'LINK'`,
            );
          }),
        },
        {
          label: "rogue CONFLICT decision",
          mutate: (raw) => restoreTriggerAround(raw, "trg_person_projection_decisions_scope_guard", () => {
            raw.exec(
              `INSERT INTO person_projection_decisions
                 (id, workspace_id, person_id, source_record_id, import_run_id, preview_row_id,
                  decision_kind, previous_projection_json, previous_projection_fingerprint,
                  next_projection_json, next_projection_fingerprint, decision_method,
                  confirmed_by_account_id, created_at)
               SELECT 'rogue-conflict-decision', preview.workspace_id, template.person_id,
                      template.source_record_id, preview.run_id, preview.id,
                      'UPDATE_FROM_SOURCE', template.previous_projection_json,
                      template.previous_projection_fingerprint, template.next_projection_json,
                      template.next_projection_fingerprint, 'EXPLICIT_ORGANIZER_CONFIRMATION',
                      run.confirmed_by_account_id, run.confirmed_at
               FROM connector_import_preview_rows preview
               JOIN connector_runs run ON run.id = preview.run_id
               JOIN person_projection_decisions template ON template.decision_kind = 'UPDATE_FROM_SOURCE'
               WHERE preview.disposition = 'CONFLICT' ORDER BY preview.id LIMIT 1`,
            );
          }),
        },
      ];

      for (const [index, tamper] of tamperCases.entries()) {
        const tamperedPath = join(directory, `tampered-${index}.sqlite`);
        copyFileSync(path, tamperedPath);
        const raw = new DatabaseSync(tamperedPath);
        try {
          raw.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
          tamper.mutate(raw);
        } finally {
          raw.close();
        }
        expect(
          () => openDb({ path: tamperedPath, seed: false }),
          tamper.label,
        ).toThrow("database v21 production connector integrity check failed");
      }
    } finally {
      if (db) closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resumes a retryable partial page without duplicating persisted preview evidence", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      saveConnection(db, "hubspot");
      let failSecondPage = true;
      const fetch: FetchLike = async (input) => {
        const after = new URL(String(input)).searchParams.get("after");
        if (after === null) {
          return jsonResponse(200, {
            results: [{
              id: "resume-1",
              updatedAt: "2026-08-15T00:00:00.000Z",
              properties: { email: "resume.one@example.test", firstname: "Resume", lastname: "One" },
            }],
            paging: { next: { after: "2" } },
          });
        }
        if (failSecondPage) {
          failSecondPage = false;
          return jsonResponse(503, { private: "raw failure must not persist" });
        }
        return jsonResponse(200, {
          results: [{
            id: "resume-2",
            updatedAt: "2026-08-15T00:01:00.000Z",
            properties: { email: "resume.two@example.test", firstname: "Resume", lastname: "Two" },
          }],
        });
      };
      const runtime = testRuntime("hubspot", fetch);
      const first = await createConnectorImportPreview(
        db, session(), "connector-alpha", "hubspot", "resume-import-key", runtime,
      );
      expect(first.run).toMatchObject({ state: "FAILED_RETRYABLE", pageCount: 1, itemCount: 1 });
      expect(first.rows).toHaveLength(1);
      expect(JSON.stringify(first)).not.toContain("raw failure");

      const resumed = await createConnectorImportPreview(
        db, session(), "connector-alpha", "hubspot", "resume-import-key", runtime,
      );
      expect(resumed.run).toMatchObject({ state: "PREVIEW_READY", pageCount: 2, itemCount: 2 });
      expect(resumed.rows.map((row) => row.providerRecordId)).toEqual(["resume-1", "resume-2"]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM connector_run_attempts WHERE run_id = ?").get(resumed.run.id))
        .toEqual({ count: 3 });
    } finally {
      closeDb(db);
    }
  });

  it("replays fresh read claims, recovers an expired import lease, and stops before attempt 1001", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      saveConnection(db, "hubspot");

      let releaseTest: (() => void) | undefined;
      let reachedTest: (() => void) | undefined;
      const testReached = new Promise<void>((resolve) => { reachedTest = resolve; });
      let testFetches = 0;
      const testRequests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const testRuntimeValue = testNetworkRuntime("hubspot", async (input, init) => {
        testFetches += 1;
        testRequests.push({ url: String(input), init: init ?? {} });
        reachedTest?.();
        await new Promise<void>((resolve) => { releaseTest = resolve; });
        return jsonResponse(200, { results: [] });
      });
      const firstTest = testConnectorConnection(
        db, session(), "connector-alpha", "hubspot", "fresh-running-test-key", testRuntimeValue,
      );
      await testReached;
      const replayedTest = await testConnectorConnection(
        db, session(), "connector-alpha", "hubspot", "fresh-running-test-key", testRuntimeValue,
      );
      expect(replayedTest.state).toBe("RUNNING");
      expect(testFetches).toBe(1);
      expect(testRequests[0]).toMatchObject({
        url: "https://api.hubapi.com/crm/v3/objects/contacts?limit=1&properties=email",
        init: {
          method: "GET",
          redirect: "error",
          headers: expect.objectContaining({ Authorization: "Bearer public-synthetic-hubspot-secret" }),
        },
      });
      releaseTest?.();
      await expect(firstTest).resolves.toMatchObject({ state: "SUCCEEDED", attemptCount: 1 });

      let releaseImport: (() => void) | undefined;
      let reachedImport: (() => void) | undefined;
      const importReached = new Promise<void>((resolve) => { reachedImport = resolve; });
      let importFetches = 0;
      const pendingImportRuntime = testRuntime("hubspot", async () => {
        importFetches += 1;
        reachedImport?.();
        await new Promise<void>((resolve) => { releaseImport = resolve; });
        return jsonResponse(200, { results: [] });
      });
      const firstImport = createConnectorImportPreview(
        db, session(), "connector-alpha", "hubspot", "expired-running-import-key", pendingImportRuntime,
      );
      await importReached;
      const actualNow = Date.now();
      const advanced = vi.spyOn(Date, "now").mockReturnValue(actualNow + 11 * 60 * 1_000);
      const recovered = await createConnectorImportPreview(
        db, session(), "connector-alpha", "hubspot", "expired-running-import-key", pendingImportRuntime,
      ).finally(() => advanced.mockRestore());
      expect(recovered.run).toMatchObject({ state: "FAILED_RETRYABLE", errorCode: "EXECUTION_INTERRUPTED", attemptCount: 1 });
      expect(importFetches).toBe(1);
      releaseImport?.();
      await expect(firstImport).resolves.toMatchObject({ run: { state: "FAILED_RETRYABLE", attemptCount: 1 } });

      const insertAttempt = db.prepare(
        `INSERT INTO connector_run_attempts
           (id, workspace_id, run_id, attempt_number, provider_attempts, page_items,
            outcome, retry_classification, error_code, started_at, completed_at)
         VALUES (?, ?, ?, ?, 0, 0, 'FAILED_RETRYABLE', 'RETRYABLE', 'FILLER', ?, ?)`,
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let attempt = 2; attempt <= 999; attempt += 1) {
          insertAttempt.run(`attempt-filler-${attempt}`, WORKSPACE_A, recovered.run.id, attempt, AT, AT);
        }
        db.prepare("UPDATE connector_runs SET attempt_count = 999 WHERE id = ?").run(recovered.run.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const cappedRuntime = testRuntime("hubspot", async () => {
        importFetches += 1;
        return jsonResponse(503, { private: "must remain redacted" });
      });
      const thousandth = await createConnectorImportPreview(
        db, session(), "connector-alpha", "hubspot", "expired-running-import-key", cappedRuntime,
      );
      expect(thousandth.run).toMatchObject({ state: "FAILED_RETRYABLE", attemptCount: 1_000 });
      expect(importFetches).toBe(2);
      const exhausted = await createConnectorImportPreview(
        db, session(), "connector-alpha", "hubspot", "expired-running-import-key", cappedRuntime,
      );
      expect(exhausted.run).toMatchObject({ state: "FAILED_TERMINAL", attemptCount: 1_000, errorCode: "ATTEMPT_LIMIT_EXCEEDED" });
      expect(importFetches).toBe(2);
      expect(JSON.stringify(exhausted)).not.toContain("must remain redacted");
    } finally {
      closeDb(db);
    }
  });

  it("serializes the same outbound key and preserves UNKNOWN against an expired stale worker", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      saveConnection(db, "hubspot");
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("person-concurrent", WORKSPACE_A, "concurrent@example.test", "Concurrent Fixture", AT);
      authorizeAllPeople(db, "hubspot");
      const release: { current?: () => void } = {};
      let writes = 0;
      const fetch: FetchLike = async (_input, init) => {
        if (init?.method !== "POST") return jsonResponse(200, { results: [] });
        writes += 1;
        await new Promise<void>((resolve) => { release.current = resolve; });
        return jsonResponse(200, {
          results: [{ id: "provider-concurrent", new: true, properties: { email: "concurrent@example.test" } }],
          errors: [],
        });
      };
      const runtime = testRuntime("hubspot", fetch);
      const firstPromise = exportCanonicalPeopleToConnector(
        db, session(), "connector-alpha", "hubspot", "concurrent-export-key", runtime,
      );
      await Promise.resolve();
      const duplicate = await exportCanonicalPeopleToConnector(
        db, session(), "connector-alpha", "hubspot", "concurrent-export-key", runtime,
      );
      expect(duplicate.state).toBe("RUNNING");
      expect(writes).toBe(1);

      const actualNow = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(actualNow + 11 * 60 * 1_000);
      const recovered = await exportCanonicalPeopleToConnector(
        db, session(), "connector-alpha", "hubspot", "concurrent-export-key", runtime,
      ).finally(() => clock.mockRestore());
      expect(recovered).toMatchObject({ state: "UNKNOWN", errorCode: "EXPORT_EXECUTION_INTERRUPTED" });
      release.current?.();
      const staleCompletion = await firstPromise;
      expect(staleCompletion.state).toBe("UNKNOWN");
      expect(writes).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS count FROM connector_export_receipts").get()).toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("fails the whole export closed with reconstructable evidence when any Person lacks current provider purpose authority", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      saveConnection(db, "hubspot");
      const insert = db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, organization, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const modes: Readonly<Record<string, TestAuthorityMode>> = {
        "person-purpose-denied": "DENIED",
        "person-purpose-withdrawn": "WITHDRAWN",
        "person-purpose-expired": "EXPIRED",
        "person-purpose-malformed": "MALFORMED",
        "person-purpose-absent": "ABSENT",
      };
      for (const [personId, mode] of Object.entries(modes)) {
        insert.run(
          personId,
          WORKSPACE_A,
          `${mode.toLowerCase()}@example.test`,
          `Purpose ${mode}`,
          mode === "ABSENT" ? null : "Consent Test Org",
          mode === "DENIED" ? null : "Participant",
          AT,
        );
      }
      authorizeAllPeople(db, "hubspot", modes);
      let fetches = 0;
      const runtime = testRuntime("hubspot", async () => {
        fetches += 1;
        return jsonResponse(500, { private: "provider must never be reached" });
      });

      const denied = await exportCanonicalPeopleToConnector(
        db, session(), "connector-alpha", "hubspot", "purpose-denied-export", runtime,
      );
      expect(denied).toMatchObject({
        state: "FAILED_TERMINAL",
        errorCode: "EXPORT_PURPOSE_AUTHORIZATION_DENIED",
        itemCount: 0,
      });
      expect(fetches).toBe(0);

      const manifest = db.prepare(
        `SELECT total_person_count AS totalPersonCount, candidate_count AS candidateCount
         FROM connector_export_manifests WHERE run_id = ?`,
      ).get(denied.id);
      expect(manifest).toEqual({ totalPersonCount: 5, candidateCount: 5 });
      const decisions = db.prepare(
        `SELECT person_id AS personId, authority_version_id AS authorityVersionId,
                decision_state AS decisionState, action_family AS actionFamily,
                fact_families_json AS factFamiliesJson, preflight_input_json AS preflightInputJson,
                preflight_result_json AS preflightResultJson
         FROM connector_export_decisions WHERE run_id = ? ORDER BY person_id`,
      ).all(denied.id) as Array<{
        readonly personId: string;
        readonly authorityVersionId: string | null;
        readonly decisionState: string;
        readonly actionFamily: string;
        readonly factFamiliesJson: string;
        readonly preflightInputJson: string;
        readonly preflightResultJson: string;
      }>;
      expect(decisions).toHaveLength(5);
      expect(decisions.every((decision) => decision.decisionState !== "READY")).toBe(true);
      expect(decisions.find((decision) => decision.personId === "person-purpose-absent")).toMatchObject({
        authorityVersionId: null,
        decisionState: "UNAVAILABLE",
      });
      for (const decision of decisions) {
        expect(decision.actionFamily).toMatch(/^EXTERNAL_PROVIDER_EXPORT:HUBSPOT:[A-F0-9]{32}:V1$/u);
        expect(() => JSON.parse(decision.factFamiliesJson)).not.toThrow();
        expect(() => JSON.parse(decision.preflightInputJson)).not.toThrow();
        expect(() => JSON.parse(decision.preflightResultJson)).not.toThrow();
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM connector_export_receipts WHERE run_id = ?").get(denied.id))
        .toEqual({ count: 0 });

      const replay = await exportCanonicalPeopleToConnector(
        db, session(), "connector-alpha", "hubspot", "purpose-denied-export", runtime,
      );
      expect(replay).toEqual(denied);
      expect(fetches).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM connector_export_decisions WHERE run_id = ?").get(denied.id))
        .toEqual({ count: 5 });

      const beforeDeniedActors = db.prepare("SELECT COUNT(*) AS count FROM connector_runs").get();
      await expect(exportCanonicalPeopleToConnector(
        db,
        session("event_manager"),
        "connector-alpha",
        "hubspot",
        "purpose-event-manager-export",
        runtime,
      )).rejects.toBeInstanceOf(DenialError);
      await expect(exportCanonicalPeopleToConnector(
        db,
        session("organizer", WORKSPACE_B, "connector-bravo"),
        "connector-alpha",
        "hubspot",
        "purpose-cross-workspace-export",
        runtime,
      )).rejects.toBeInstanceOf(DenialError);
      expect(db.prepare("SELECT COUNT(*) AS count FROM connector_runs").get()).toEqual(beforeDeniedActors);
      expect(fetches).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("records partial/malformed outbound responses and cross-batch identity collisions as UNKNOWN", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      saveConnection(db, "hubspot");
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("person-partial", WORKSPACE_A, "partial@example.test", "Partial Fixture", AT);
      authorizeAllPeople(db, "hubspot");
      const partial = await exportCanonicalPeopleToConnector(
        db,
        session(),
        "connector-alpha",
        "hubspot",
        "partial-hubspot-export",
        testRuntime("hubspot", async (_input, init) => init?.method === "POST"
          ? jsonResponse(207, { results: [], errors: [{ message: "private provider payload" }] })
          : jsonResponse(200, { results: [] })),
      );
      expect(partial).toMatchObject({ state: "UNKNOWN", errorCode: "PROVIDER_REJECTED" });
      expect(JSON.stringify(partial)).not.toContain("private provider payload");
      expect(db.prepare("SELECT COUNT(*) AS count FROM connector_export_receipts").get()).toEqual({ count: 0 });

      saveConnection(db, "salesforce");
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("person-collision", WORKSPACE_A, "collision@example.test", "Collision Fixture", AT);
      authorizeAllPeople(db, "salesforce");
      const collisionRuntime = testRuntime("salesforce", async (_input, init) => {
        if (init?.method === "GET") return jsonResponse(200, { totalSize: 0, done: true, records: [] });
        return jsonResponse(201, { id: "003000000000099AAA", success: true, errors: [] });
      });
      const collision = await exportCanonicalPeopleToConnector(
        db, session(), "connector-alpha", "salesforce", "collision-salesforce-export", collisionRuntime,
      );
      expect(collision).toMatchObject({ state: "UNKNOWN", errorCode: "EXPORT_RECEIPT_UNCERTAIN" });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM connector_export_receipts WHERE run_id = ?",
      ).get(collision.id)).toEqual({ count: 1 });
    } finally {
      closeDb(db);
    }
  });

  it("bounds Salesforce batch attempts, blocks stale versions/revocation, and denies wrong actors before fetch", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedScope(db);
      saveConnection(db, "salesforce");
      const insert = db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (let index = 0; index < 101; index += 1) {
        insert.run(`person-${index}`, WORKSPACE_A, `person-${index}@example.test`, `Person ${index}`, AT);
      }
      authorizeAllPeople(db, "salesforce");
      const large = await exportCanonicalPeopleToConnector(
        db,
        session(),
        "connector-alpha",
        "salesforce",
        "salesforce-101-export",
        createSyntheticConnectorFixtureRuntime("salesforce"),
      );
      expect(large).toMatchObject({ state: "SUCCEEDED", itemCount: 101, attemptCount: 101 });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM connector_export_receipts WHERE run_id = ?",
      ).get(large.id)).toEqual({ count: 101 });

      let fetches = 0;
      const deniedRuntime = testRuntime("salesforce", async () => {
        fetches += 1;
        return jsonResponse(200, { totalSize: 0, done: true, records: [] });
      });
      await expect(testConnectorConnection(
        db,
        session("organizer", WORKSPACE_B, "connector-bravo"),
        "connector-alpha",
        "salesforce",
        "foreign-test-key",
        deniedRuntime,
      )).rejects.toBeInstanceOf(DenialError);
      await expect(testConnectorConnection(
        db,
        session("event_manager"),
        "connector-alpha",
        "salesforce",
        "wrong-role-test-key",
        deniedRuntime,
      )).rejects.toBeInstanceOf(DenialError);
      expect(fetches).toBe(0);

      const connection = saveConnectorConnection(db, session(), "connector-alpha", {
        provider: "salesforce",
        config: { instanceUrl: "https://sympose.my.salesforce.com", apiVersion: "v60.0" },
        expectedVersion: 1,
      });
      expect(connection.version).toBe(1);
      expect(() => saveConnectorConnection(db, session(), "connector-alpha", {
        provider: "salesforce",
        config: { instanceUrl: "https://sympose.my.salesforce.com", apiVersion: "v60.0" },
        expectedVersion: 0,
      })).toThrowError(ConnectorConnectionError);
      revokeConnectorConnection(db, session(), "connector-alpha", "salesforce", connection.version);
      await expect(testConnectorConnection(
        db, session(), "connector-alpha", "salesforce", "revoked-test-key", deniedRuntime,
      )).rejects.toMatchObject({ code: "CONNECTOR_CONNECTION_INACTIVE" });
      expect(fetches).toBe(0);
    } finally {
      closeDb(db);
    }
  });
});
