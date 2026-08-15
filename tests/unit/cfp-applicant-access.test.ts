import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { Db } from "../../src/server/db";
import { closeDb, openDb, withTransactionOrSavepoint } from "../../src/server/db";
import type { SessionInfo } from "../../src/server/auth";
import { DenialError } from "../../src/server/auth";
import { SimulatedFixtureSourceAdapter } from "../../src/server/adapters/source-adapter";
import {
  CfpApplicantAccessError,
  CfpApplicantAccessFatalError,
  createCfpApplicantAccess,
  grantCallExtension,
  issueEmailVerification,
  consumeEmailVerification,
  resolveApplicantSession,
  revokeApplicantSession,
  transitionCallState,
  readCallLifecycle,
  assertApplicantAccess,
} from "../../src/server/services/cfp/applicant-access";
import {
  FormDocumentPersistenceError,
  createCfpPersistence,
  createDraftSubmission,
  saveDraftRevision,
} from "../../src/server/services/cfp/form-documents";
import {
  runPersistentRaceActor,
  startPersistentRaceActors,
  stopPersistentRaceActors,
  type PersistentRaceActor,
} from "./helpers/persistent-race-actor";

function removeSqliteFiles(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(target, { force: true });
  }
}

function rebuildVerificationTableInReverse(path: string): {
  readonly before: readonly string[];
  readonly after: readonly string[];
} {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    const table = db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'cfp_email_verifications'`,
      )
      .get() as { readonly sql: string } | undefined;
    if (!table?.sql) throw new Error("verification table schema is missing");
    const objects = db
      .prepare(
        `SELECT type, name, sql
         FROM sqlite_master
         WHERE type IN ('index', 'trigger')
           AND sql IS NOT NULL
           AND (
             tbl_name = 'cfp_email_verifications'
             OR (type = 'trigger' AND instr(sql, 'cfp_email_verifications') > 0)
           )
         ORDER BY type, name`,
      )
      .all() as Array<{
      readonly type: "index" | "trigger";
      readonly name: string;
      readonly sql: string;
    }>;
    const before = (
      db
        .prepare(
          "SELECT id FROM cfp_email_verifications ORDER BY rowid",
        )
        .all() as Array<{ readonly id: string }>
    ).map((row) => row.id);
    const rebuiltSql = table.sql.replace(
      "CREATE TABLE cfp_email_verifications",
      "CREATE TABLE cfp_email_verifications_rebuild",
    );
    if (rebuiltSql === table.sql) {
      throw new Error("verification rebuild schema was not canonical");
    }

    for (const object of objects) {
      db.exec(
        `DROP ${object.type.toUpperCase()} "${object.name.replaceAll('"', '""')}"`,
      );
    }
    db.exec(rebuiltSql);
    db.exec(
      `INSERT INTO cfp_email_verifications_rebuild
         (id, workspace_id, call_id, email, token_hash, expires_at, created_at,
          issuance_sequence)
       SELECT id, workspace_id, call_id, email, token_hash, expires_at, created_at,
              issuance_sequence
       FROM cfp_email_verifications
       ORDER BY rowid DESC`,
    );
    db.exec("DROP TABLE cfp_email_verifications");
    db.exec(
      "ALTER TABLE cfp_email_verifications_rebuild RENAME TO cfp_email_verifications",
    );
    db.exec("PRAGMA writable_schema = ON");
    try {
      db.prepare(
        `UPDATE sqlite_master SET sql = ?
         WHERE type = 'table' AND name = 'cfp_email_verifications'`,
      ).run(table.sql);
    } finally {
      db.exec("PRAGMA writable_schema = OFF");
    }
    for (const object of objects) db.exec(object.sql);

    const after = (
      db
        .prepare(
          "SELECT id FROM cfp_email_verifications ORDER BY rowid",
        )
        .all() as Array<{ readonly id: string }>
    ).map((row) => row.id);
    return { before, after };
  } finally {
    db.close();
  }
}

function waitForMarker(path: string, timeoutMs = 15_000): void {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error("Bounded race coordination marker was not created.");
    }
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

async function waitForMarkers(
  paths: readonly string[],
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) {
      throw new Error("Bounded race coordination markers were not created.");
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

type SqliteBusyMarker = {
  readonly pid: number;
  readonly nodeCode: "ERR_SQLITE_ERROR";
  readonly sqliteCode: 5;
};

function readSqliteBusyTimeout(db: Db): number {
  const row = db.prepare("PRAGMA busy_timeout").get() as Record<
    string,
    unknown
  >;
  const values = Object.values(row);
  if (
    values.length !== 1 ||
    typeof values[0] !== "number" ||
    !Number.isSafeInteger(values[0]) ||
    values[0] < 0
  ) {
    throw new Error("SQLite busy timeout could not be read canonically.");
  }
  return values[0];
}

function requireRealSqliteBusyBeforeRelease(
  db: Db,
  ownerMarker: string,
  busyMarker: string,
  releaseMarker: string,
): void {
  waitForMarker(ownerMarker);
  const normalBusyTimeout = readSqliteBusyTimeout(db);
  if (normalBusyTimeout <= 0) {
    throw new Error("SQLite connection did not start with a bounded busy timeout.");
  }

  db.exec("PRAGMA busy_timeout = 0");
  if (readSqliteBusyTimeout(db) !== 0) {
    throw new Error("SQLite busy timeout was not disabled for the contention probe.");
  }

  let observedError: unknown;
  let contentionObserved = false;
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    observedError = error;
    contentionObserved = true;
  }
  if (!contentionObserved) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw new Error("Contender unexpectedly acquired BEGIN IMMEDIATE.");
  }

  const sqliteError = observedError as Error & {
    readonly code?: unknown;
    readonly errcode?: unknown;
  };
  if (
    !(observedError instanceof Error) ||
    sqliteError.code !== "ERR_SQLITE_ERROR" ||
    sqliteError.errcode !== 5 ||
    db.isTransaction
  ) {
    throw observedError;
  }

  const marker: SqliteBusyMarker = {
    pid: process.pid,
    nodeCode: "ERR_SQLITE_ERROR",
    sqliteCode: 5,
  };
  writeFileSync(busyMarker, JSON.stringify(marker), "utf8");

  db.exec(`PRAGMA busy_timeout = ${normalBusyTimeout}`);
  if (readSqliteBusyTimeout(db) !== normalBusyTimeout) {
    throw new Error("SQLite busy timeout was not restored after contention.");
  }
  waitForMarker(releaseMarker);
}

function readSqliteBusyMarker(path: string): SqliteBusyMarker {
  const marker = JSON.parse(readFileSync(path, "utf8")) as Partial<SqliteBusyMarker>;
  if (
    typeof marker.pid !== "number" ||
    !Number.isSafeInteger(marker.pid) ||
    marker.nodeCode !== "ERR_SQLITE_ERROR" ||
    marker.sqliteCode !== 5
  ) {
    throw new Error("Contender marker did not prove SQLITE_BUSY.");
  }
  return marker as SqliteBusyMarker;
}

type ExecStatementMatcher = string | RegExp;

function matchesExecStatement(sql: string, matcher: ExecStatementMatcher): boolean {
  const statement = sql.trim();
  return typeof matcher === "string" ? statement === matcher : matcher.test(statement);
}

function ownedSavepointStatement(
  command: "SAVEPOINT" | "ROLLBACK TO SAVEPOINT" | "RELEASE SAVEPOINT",
  baseName: string,
): RegExp {
  return new RegExp(
    `^${command} "${baseName}_[0-9a-f]{32}"$`,
    "u",
  );
}

function withOneExecFailure(
  db: Db,
  statement: ExecStatementMatcher,
  sentinel: string,
  onFailure?: () => void,
): Db {
  let shouldFail = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (shouldFail && matchesExecStatement(sql, statement)) {
            shouldFail = false;
            onFailure?.();
            throw new Error(sentinel);
          }
          target.exec(sql);
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withOneBeforeExec(
  db: Db,
  statement: ExecStatementMatcher,
  before: () => void,
): Db {
  let shouldRun = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (shouldRun && matchesExecStatement(sql, statement)) {
            shouldRun = false;
            before();
          }
          target.exec(sql);
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withOneAfterExec(
  db: Db,
  statement: ExecStatementMatcher,
  after: () => void,
): Db {
  let shouldRun = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          target.exec(sql);
          if (shouldRun && matchesExecStatement(sql, statement)) {
            shouldRun = false;
            after();
          }
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withThrowingCommitAndUnreadableTransactionState(
  db: Db,
  onCommit: () => void,
  onStateProbe: () => void,
): Db {
  let stateUnreadable = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "isTransaction" && stateUnreadable) {
        onStateProbe();
        throw new Error("SQLITE_TRANSACTION_STATE_UNREADABLE");
      }
      if (property === "exec") {
        return (sql: string): void => {
          target.exec(sql);
          if (sql.trim() === "COMMIT") {
            onCommit();
            stateUnreadable = true;
            throw new Error("SQLITE_AFTER_COMMIT_STATE_UNREADABLE");
          }
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withOneAfterStatementRun(
  db: Db,
  sqlFragment: string,
  sentinel: string,
  onFailure?: () => void,
): Db {
  let shouldFail = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes(sqlFragment)) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "run") {
                return (...args: unknown[]) => {
                  const result = Reflect.apply(
                    statementTarget.run,
                    statementTarget,
                    args,
                  );
                  if (shouldFail) {
                    shouldFail = false;
                    onFailure?.();
                    throw new Error(sentinel);
                  }
                  return result;
                };
              }
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              ) as unknown;
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withOnePrepareFailureAfterExec(
  db: Db,
  boundary: ExecStatementMatcher,
  sqlFragment: string,
  sentinel: string,
  onFailure?: () => void,
): Db {
  let armed = false;
  let shouldFail = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          target.exec(sql);
          if (matchesExecStatement(sql, boundary)) armed = true;
        };
      }
      if (property === "prepare") {
        return (sql: string) => {
          if (armed && shouldFail && sql.includes(sqlFragment)) {
            shouldFail = false;
            onFailure?.();
            throw new Error(sentinel);
          }
          return target.prepare(sql);
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withOneStatementGetterFailureAfterExec(
  db: Db,
  boundary: ExecStatementMatcher,
  sqlFragment: string,
  method: "all" | "get" | "run",
  sentinel: string,
  onFailure?: () => void,
): Db {
  let armed = false;
  let shouldFail = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          target.exec(sql);
          if (matchesExecStatement(sql, boundary)) armed = true;
        };
      }
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!armed || !sql.includes(sqlFragment)) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (shouldFail && statementProperty === method) {
                shouldFail = false;
                onFailure?.();
                throw new Error(sentinel);
              }
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              ) as unknown;
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withOneStatementRunFailureAfterExec(
  db: Db,
  boundary: ExecStatementMatcher,
  sqlFragment: string,
  sentinel: string,
  onFailure?: () => void,
): Db {
  let armed = false;
  let shouldFail = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          target.exec(sql);
          if (matchesExecStatement(sql, boundary)) armed = true;
        };
      }
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!armed || !sql.includes(sqlFragment)) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "run") {
                return (...args: unknown[]) => {
                  if (shouldFail) {
                    shouldFail = false;
                    onFailure?.();
                    throw new Error(sentinel);
                  }
                  return Reflect.apply(
                    statementTarget.run,
                    statementTarget,
                    args,
                  );
                };
              }
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              ) as unknown;
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withNthBeforePrepare(
  db: Db,
  sqlFragment: string,
  occurrence: number,
  before: () => void,
): Db {
  let seen = 0;
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes(sqlFragment)) {
            seen += 1;
            if (seen === occurrence) before();
          }
          return target.prepare(sql);
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

const HEX_64_A = "1111111122222222333333334444444455555555666666667777777788888888";
const HEX_64_B = "99999999aaaaaaaa222222223333333344444444555555556666666677777777";
const HEX_64_C = "bbbbbbbbcccccccc222222223333333344444444555555556666666677777777";
const HEX_64_D = "ddddddddeeeeeeee222222223333333344444444555555556666666677777777";
const HEX_64_E = "ffffffff00000000222222223333333344444444555555556666666677777777";
const HEX_64_F = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HEX_64_G = "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
const HEX_64_H = "13579bdf2468ace013579bdf2468ace013579bdf2468ace013579bdf2468ace0";
const HEX_64_I = "0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978";
const HEX_64_J = "aaaaaaaa00000000bbbbbbbb11111111cccccccc22222222dddddddd33333333";
const HEX_64_K = "eeeeeeee44444444ffffffff55555555aaaaaaaa66666666bbbbbbbb77777777";
const HEX_64_L = "cccccccc88888888dddddddd99999999eeeeeeee00000000ffffffff11111111";

function setupFixture(
  db: Db,
  overrides?: {
    accessMode?: "PUBLIC" | "INVITED" | "PUBLIC_AND_INVITED";
    state?: "DRAFT" | "SCHEDULED" | "OPEN" | "PAUSED" | "CLOSED" | "ARCHIVED" | "CANCELLED";
    opensAt?: string | null;
    closesAt?: string | null;
    createdAt?: string;
    workspaceSlug?: "northstar" | "acme";
  },
) {
  const fixtureCreatedAt = overrides?.createdAt ?? "2026-08-10T00:00:00.000Z";
  const persistence = createCfpPersistence({ clock: () => fixtureCreatedAt });
  const workspaceSlug = overrides?.workspaceSlug ?? "northstar";
  const workspace = db
    .prepare("SELECT id, slug FROM workspaces WHERE slug = ?")
    .get(workspaceSlug) as { id: string; slug: string };
  const account = db
    .prepare(
      "SELECT id, email, display_name, role FROM accounts WHERE workspace_id = ? AND role = 'organizer' LIMIT 1",
    )
    .get(workspace.id) as { id: string; email: string; display_name: string; role: string };

  const session: SessionInfo = {
    id: `sess-org-${Math.random().toString(36).slice(2, 8)}`,
    tokenHash: HEX_64_A,
    accountId: account.id,
    workspaceId: workspace.id,
    expiresAt: "2029-01-01T00:00:00.000Z",
    email: account.email,
    displayName: account.display_name,
    role: account.role,
    workspaceSlug: workspace.slug,
    workspaceName: "Northstar",
  };

  const eventId = workspaceSlug === "northstar" ? "evt-1" : "evt-acme";
  db.prepare(
    "INSERT OR IGNORE INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    eventId,
    workspace.id,
    "Event 1",
    "UTC",
    "2026-08-10T00:00:00.000Z",
    "2026-08-20T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
  );

  const def = persistence.createFormDefinition(
    db,
    { workspaceId: workspace.id, accountId: account.id },
    { name: `CFP Form ${Math.random().toString(36).slice(2, 8)}` },
  );
  const sealed = persistence.sealFormVersion(
    db,
    { workspaceId: workspace.id, accountId: account.id },
    {
      formDefinitionId: def.id,
      fields: [
        {
          id: "f-title",
          type: "shortText",
          label: "Title",
          required: true,
          defaultVisibility: "visible",
        },
      ],
      rules: { schema: "cfp-form-rules/v1", rules: [] },
    },
  );

  const callRes = persistence.createCall(
    db,
    { workspaceId: workspace.id, accountId: account.id },
    {
      eventId,
      name: "Call for Proposals",
      slug: `cfp-${Math.random().toString(36).slice(2, 8)}`,
      formVersionId: sealed.id,
      policy: {
        disclosure: {
          privacy: "privacy",
          retention: "retention",
          aiProcessing: "ai",
          communication: "communication",
          consent: "consent",
          publication: "publication",
        },
        choices: [],
      },
      accessMode: overrides?.accessMode ?? "PUBLIC",
      state: overrides?.state ?? "OPEN",
      timezone: "UTC",
      opensAt: overrides?.opensAt !== undefined ? overrides.opensAt : "2026-08-10T00:00:00.000Z",
      closesAt: overrides?.closesAt !== undefined ? overrides.closesAt : "2026-08-10T23:59:59.000Z",
    },
  );

  return {
    workspaceId: workspace.id,
    accountId: account.id,
    session,
    callId: callRes.id,
    eventId,
    formVersionId: sealed.id,
  };
}

function expectCfpCode(
  operation: () => unknown,
  code: CfpApplicantAccessError["code"],
): CfpApplicantAccessError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CfpApplicantAccessError);
    expect((error as CfpApplicantAccessError).code).toBe(code);
    return error as CfpApplicantAccessError;
  }
  throw new Error(`Expected CfpApplicantAccessError(${code}).`);
}

const O2B_DOMAIN_TABLES = [
  "workspaces",
  "calls",
  "call_extensions",
  "cfp_email_verifications",
  "cfp_email_verification_consumptions",
  "cfp_applicant_sessions",
  "people",
  "submissions",
  "submission_revisions",
] as const;

function snapshotO2bTruth(db: Db): Record<string, unknown> {
  return Object.fromEntries(
    O2B_DOMAIN_TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}

function snapshotAuditTruth(db: Db): unknown[] {
  return db.prepare("SELECT * FROM audit_events ORDER BY rowid").all();
}

function expectForeignKeysAndTriggersEnabled(db: Db): void {
  expect(
    (
      db.prepare("PRAGMA foreign_keys").get() as {
        foreign_keys: number;
      }
    ).foreign_keys,
  ).toBe(1);
  expect(
    (
      db.prepare("PRAGMA recursive_triggers").get() as {
        recursive_triggers: number;
      }
    ).recursive_triggers,
  ).toBe(1);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

function insertBlobCallIdTwin(
  db: Db,
  callId: string,
  suffix: string,
  sourceCallId = callId,
): void {
  const inserted = db
    .prepare(
      `INSERT INTO calls
         (id, workspace_id, event_id, name, slug, form_version_id, access_mode,
          state, timezone, opens_at, closes_at, policy_version_id, policy_schema,
          policy_json, policy_fingerprint_algorithm, policy_fingerprint,
          created_at, updated_at)
       SELECT CAST(? AS BLOB), workspace_id, event_id, name || ' BLOB twin',
              slug || ?, form_version_id, access_mode, state, timezone,
              opens_at, closes_at, policy_version_id, policy_schema, policy_json,
              policy_fingerprint_algorithm, policy_fingerprint, created_at,
              updated_at
       FROM calls
       WHERE id = ?`,
    )
    .run(callId, `-${suffix}`, sourceCallId);
  expect(inserted.changes).toBe(1);
}

function insertReviewerSession(
  db: Db,
  fixture: ReturnType<typeof setupFixture>,
  accountId: string,
): SessionInfo {
  db.prepare(
    `INSERT INTO accounts
       (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, 'reviewer', ?)`,
  ).run(
    accountId,
    fixture.workspaceId,
    `${accountId}@synthetic.example`,
    "Synthetic Reviewer",
    "2026-08-10T00:00:00.000Z",
  );
  return buildOrganizerSession(db, fixture.workspaceId, accountId);
}

function insertBlobWorkspaceTwinPerson(
  db: Db,
  workspaceId: string,
  email: string,
  suffix: string,
): void {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, created_at)
     VALUES (CAST(? AS BLOB), ?, ?, ?)`,
  ).run(
    workspaceId,
    `blob-workspace-${suffix}`,
    "BLOB Workspace Twin",
    "2026-05-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO people
       (id, workspace_id, canonical_email, full_name, created_at)
     VALUES (?, CAST(? AS BLOB), ?, ?, ?)`,
  ).run(
    `blob-workspace-person-${suffix}`,
    workspaceId,
    email,
    "BLOB Workspace Person",
    "2026-08-10T00:00:00.000Z",
  );
}

function buildOrganizerSession(db: Db, workspaceId: string, accountId: string): SessionInfo {
  const row = db
    .prepare(
      `SELECT a.email, a.display_name, a.role, w.slug, w.name
       FROM accounts a JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.id = ? AND a.workspace_id = ?`,
    )
    .get(accountId, workspaceId) as {
    email: string;
    display_name: string;
    role: string;
    slug: string;
    name: string;
  };
  return {
    id: `race-session-${process.pid}`,
    tokenHash: HEX_64_E,
    accountId,
    workspaceId,
    expiresAt: "2029-01-01T00:00:00.000Z",
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    workspaceSlug: row.slug,
    workspaceName: row.name,
  };
}

function issueAndConsume(
  service: ReturnType<typeof createCfpApplicantAccess>,
  db: Db,
  fixture: ReturnType<typeof setupFixture>,
  email: string,
  verificationDigest: string,
  sessionDigest: string,
) {
  const issued = service.issueEmailVerification(
    db,
    { workspaceId: fixture.workspaceId },
    { callId: fixture.callId, email, tokenHash: verificationDigest },
  );
  const consumed = service.consumeEmailVerification(
    db,
    { workspaceId: fixture.workspaceId },
    {
      callId: fixture.callId,
      verificationId: issued.verificationId,
      verificationTokenHash: verificationDigest,
      applicantSessionTokenHash: sessionDigest,
      fullName: "Synthetic Applicant",
    },
  );
  return { issued, consumed };
}

type OrganizerDenialTestCase = {
  readonly label: string;
  readonly classification: "capability" | "scope";
  readonly targetKind: "call" | "applicant_session";
  readonly invoke: (publicDb: Db) => unknown;
};

function createOrganizerDenialTestCases(
  service: ReturnType<typeof createCfpApplicantAccess>,
  fixture: ReturnType<typeof setupFixture>,
  applicant: ReturnType<typeof issueAndConsume>,
  lifecycle: ReturnType<typeof readCallLifecycle>,
  reviewer: SessionInfo,
): readonly OrganizerDenialTestCase[] {
  return [
    {
      label: "transition-capability",
      classification: "capability",
      targetKind: "call",
      invoke: (publicDb) =>
        service.transitionCallState(publicDb, reviewer, {
          callId: fixture.callId,
          expectedState: lifecycle.state,
          expectedUpdatedAt: lifecycle.updatedAt,
          nextState: "PAUSED",
        }),
    },
    {
      label: "extension-capability",
      classification: "capability",
      targetKind: "call",
      invoke: (publicDb) =>
        service.grantCallExtension(publicDb, reviewer, {
          callId: fixture.callId,
          personId: applicant.consumed.personId,
          extendsTo: "2026-08-11T00:00:00.000Z",
          reason: "Ordinary capability denial boundary proof",
          idempotencyKey: "ordinary-capability-extension",
        }),
    },
    {
      label: "revocation-capability",
      classification: "capability",
      targetKind: "applicant_session",
      invoke: (publicDb) =>
        service.revokeApplicantSession(publicDb, reviewer, {
          callId: fixture.callId,
          sessionId: applicant.consumed.sessionId,
          reason: "Ordinary capability denial boundary proof",
        }),
    },
    {
      label: "transition-target",
      classification: "scope",
      targetKind: "call",
      invoke: (publicDb) =>
        service.transitionCallState(publicDb, reviewer, {
          callId: "missing-ordinary-transition-call",
          expectedState: lifecycle.state,
          expectedUpdatedAt: lifecycle.updatedAt,
          nextState: "PAUSED",
        }),
    },
    {
      label: "extension-target",
      classification: "scope",
      targetKind: "call",
      invoke: (publicDb) =>
        service.grantCallExtension(publicDb, reviewer, {
          callId: fixture.callId,
          personId: "missing-ordinary-extension-person",
          extendsTo: "2026-08-11T00:00:00.000Z",
          reason: "Ordinary target denial boundary proof",
          idempotencyKey: "ordinary-target-extension",
        }),
    },
    {
      label: "revocation-target",
      classification: "scope",
      targetKind: "applicant_session",
      invoke: (publicDb) =>
        service.revokeApplicantSession(publicDb, reviewer, {
          callId: fixture.callId,
          sessionId: "missing-ordinary-revocation-session",
          reason: "Ordinary target denial boundary proof",
        }),
    },
  ];
}

describe("W1-O2B-R1 CFP Applicant Access Service", () => {
  it("Evidence Group 1: Stable source exports and manifest verification", () => {
    expect(typeof readCallLifecycle).toBe("function");
    expect(typeof transitionCallState).toBe("function");
    expect(typeof grantCallExtension).toBe("function");
    expect(typeof issueEmailVerification).toBe("function");
    expect(typeof consumeEmailVerification).toBe("function");
    expect(typeof resolveApplicantSession).toBe("function");
    expect(typeof revokeApplicantSession).toBe("function");
    expect(typeof assertApplicantAccess).toBe("function");
    expect(typeof createCfpApplicantAccess).toBe("function");
    expect(CfpApplicantAccessError).toBeDefined();

    const dbPath = resolve(".tmp/unit", `cfp-eg1-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("calls");
      expect(tableNames).toContain("call_extensions");
      expect(tableNames).toContain("cfp_email_verifications");
      expect(tableNames).toContain("cfp_email_verification_consumptions");
      expect(tableNames).toContain("cfp_applicant_sessions");
      expect(tableNames).toContain("people");
      expect(tableNames).toContain("audit_events");
      expect(tableNames).toContain("submissions");
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 2: Pure call matrix across all 7 lifecycle states, windows, and extensions", () => {
    const dbPath = resolve(".tmp/unit", `cfp-matrix-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });

    try {
      const states = [
        "DRAFT",
        "SCHEDULED",
        "OPEN",
        "PAUSED",
        "CLOSED",
        "ARCHIVED",
        "CANCELLED",
      ] as const;
      const f = setupFixture(db);
      const stateSessionDigests = [
        HEX_64_A,
        HEX_64_B,
        HEX_64_C,
        HEX_64_D,
        HEX_64_E,
        HEX_64_F,
        HEX_64_G,
      ] as const;

      const service = createCfpApplicantAccess({ now: () => "2026-08-10T12:00:00.000Z" });

      for (const [stateIndex, state] of states.entries()) {
        db.prepare("UPDATE calls SET state = ? WHERE id = ?").run(state, f.callId);

        const personId = `person-matrix-${state.toLowerCase()}`;
        const email = `matrix-${state.toLowerCase()}@synthetic.example`;
        db.prepare(
          "INSERT OR IGNORE INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(personId, f.workspaceId, email, "Matrix Person", "2026-08-10T00:00:00.000Z");

        const vId = `v-${state}`;
        db.prepare(
          "INSERT INTO cfp_email_verifications (id, workspace_id, call_id, email, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          vId,
          f.workspaceId,
          f.callId,
          email,
          stateSessionDigests[stateIndex],
          "2026-08-10T15:00:00.000Z",
          "2026-08-10T10:00:00.000Z",
        );
        const cId = `c-${state}`;
        db.prepare(
          "INSERT INTO cfp_email_verification_consumptions (id, workspace_id, verification_id, person_id, consumed_at) VALUES (?, ?, ?, ?, ?)",
        ).run(cId, f.workspaceId, vId, personId, "2026-08-10T10:05:00.000Z");
        const sId = `s-${state}`;
        db.prepare(
          "INSERT INTO cfp_applicant_sessions (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          sId,
          f.workspaceId,
          f.callId,
          personId,
          vId,
          stateSessionDigests[stateIndex],
          "2026-08-10T10:05:00.000Z",
          "2026-08-20T10:05:00.000Z",
        );

        if (state === "OPEN") {
          const grant = service.assertApplicantAccess(db, {
            action: "CREATE_DRAFT",
            context: { workspaceId: f.workspaceId, sessionId: sId },
          });
          expect(grant).toEqual({ allowed: true, late: false, extensionId: null });
        } else {
          try {
            service.assertApplicantAccess(db, {
              action: "CREATE_DRAFT",
              context: { workspaceId: f.workspaceId, sessionId: sId },
            });
            expect.fail("Should have thrown");
          } catch (err) {
            expect(err).toBeInstanceOf(CfpApplicantAccessError);
            expect((err as CfpApplicantAccessError).code).toBe("CALL_NOT_ACCEPTING");
          }
        }
      }

      db.prepare(
        "UPDATE calls SET state = 'OPEN', opens_at = '2026-08-10T10:00:00.000Z', closes_at = '2026-08-10T18:00:00.000Z' WHERE id = ?",
      ).run(f.callId);

      const freshPersonId = "person-matrix-fresh";
      const freshEmail = "matrix-fresh@synthetic.example";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(freshPersonId, f.workspaceId, freshEmail, "Fresh Person", "2026-08-10T00:00:00.000Z");

      const beforeService = createCfpApplicantAccess({ now: () => "2026-08-10T09:00:00.000Z" });
      try {
        beforeService.issueEmailVerification(
          db,
          { workspaceId: f.workspaceId },
          { callId: f.callId, email: freshEmail, tokenHash: HEX_64_A },
        );
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("VERIFICATION_REQUEST_REJECTED");
      }

      const openService = createCfpApplicantAccess({ now: () => "2026-08-10T12:00:00.000Z" });
      const issued = openService.issueEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        { callId: f.callId, email: freshEmail, tokenHash: HEX_64_A },
      );
      expect(issued.replayed).toBe(false);

      const afterService = createCfpApplicantAccess({ now: () => "2026-08-10T19:00:00.000Z" });
      try {
        afterService.issueEmailVerification(
          db,
          { workspaceId: f.workspaceId },
          { callId: f.callId, email: freshEmail, tokenHash: HEX_64_B },
        );
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("VERIFICATION_REQUEST_REJECTED");
      }

      afterService.grantCallExtension(db, f.session, {
        callId: f.callId,
        personId: freshPersonId,
        extendsTo: "2026-08-10T22:00:00.000Z",
        reason: "Extended deadline for participant",
        idempotencyKey: "idem-ext-matrix-fresh",
      });

      const lateIssued = afterService.issueEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        { callId: f.callId, email: freshEmail, tokenHash: HEX_64_B },
      );
      expect(lateIssued.replayed).toBe(false);
      const lateConsumed = afterService.consumeEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        {
          callId: f.callId,
          verificationId: lateIssued.verificationId,
          verificationTokenHash: HEX_64_B,
          applicantSessionTokenHash: HEX_64_K,
          fullName: "Fresh Person",
        },
      );

      const nonOverridableStates = ["DRAFT", "SCHEDULED", "PAUSED", "CANCELLED", "ARCHIVED"] as const;
      for (const st of nonOverridableStates) {
        db.prepare("UPDATE calls SET state = ? WHERE id = ?").run(st, f.callId);
        try {
          afterService.assertApplicantAccess(db, {
            action: "CREATE_DRAFT",
            context: { workspaceId: f.workspaceId, sessionId: lateConsumed.sessionId },
          });
          expect.fail(`Extension must not override ${st}`);
        } catch (err) {
          expect(err).toBeInstanceOf(CfpApplicantAccessError);
          expect((err as CfpApplicantAccessError).code).toBe("CALL_NOT_ACCEPTING");
        }
      }

      const badDateService = createCfpApplicantAccess({ now: () => "2026-08-10T12:00:00+02:00" });
      try {
        badDateService.issueEmailVerification(
          db,
          { workspaceId: f.workspaceId },
          { callId: f.callId, email: freshEmail, tokenHash: HEX_64_C },
        );
        expect.fail("Noncanonical now instant must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("ACCESS_INPUT_INVALID");
      }
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 3: Allowed and forbidden lifecycle transitions, CAS, injected clock, and scope denial", () => {
    const dbPath = resolve(".tmp/unit", `cfp-lifecycle-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });

    try {
      const f = setupFixture(db, { state: "DRAFT" });

      const initialService = createCfpApplicantAccess();
      const snap1 = initialService.readCallLifecycle(db, f.workspaceId, f.callId);
      expect(snap1.state).toBe("DRAFT");

      let currentClock = new Date(Date.parse(snap1.updatedAt) + 1000).toISOString();
      const service = createCfpApplicantAccess({ now: () => currentClock });

      const t1 = service.transitionCallState(db, f.session, {
        callId: f.callId,
        expectedState: "DRAFT",
        expectedUpdatedAt: snap1.updatedAt,
        nextState: "SCHEDULED",
      });
      expect(t1.state).toBe("SCHEDULED");
      expect(t1.updatedAt).toBe(currentClock);

      try {
        service.transitionCallState(db, f.session, {
          callId: f.callId,
          expectedState: "SCHEDULED",
          expectedUpdatedAt: t1.updatedAt,
          nextState: "ARCHIVED",
        });
        expect.fail("Forbidden transition SCHEDULED -> ARCHIVED must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("CALL_STATE_INVALID");
      }

      try {
        service.transitionCallState(db, f.session, {
          callId: f.callId,
          expectedState: "DRAFT",
          expectedUpdatedAt: snap1.updatedAt,
          nextState: "SCHEDULED",
        });
        expect.fail("Stale CAS expectedState must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("CALL_STATE_STALE");
      }

      const sameClockService = createCfpApplicantAccess({ now: () => t1.updatedAt });
      try {
        sameClockService.transitionCallState(db, f.session, {
          callId: f.callId,
          expectedState: "SCHEDULED",
          expectedUpdatedAt: t1.updatedAt,
          nextState: "OPEN",
        });
        expect.fail("Equal clock timestamp must throw CALL_STATE_STALE");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("CALL_STATE_STALE");
      }

      currentClock = new Date(Date.parse(t1.updatedAt) + 1000).toISOString();
      const t2 = service.transitionCallState(db, f.session, {
        callId: f.callId,
        expectedState: "SCHEDULED",
        expectedUpdatedAt: t1.updatedAt,
        nextState: "OPEN",
      });
      expect(t2.state).toBe("OPEN");

      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "transition-reviewer-account",
        f.workspaceId,
        "transition.reviewer@synthetic.example",
        "Transition Reviewer",
        "reviewer",
        "2026-08-10T00:00:00.000Z",
      );
      const nonOrgSession = buildOrganizerSession(
        db,
        f.workspaceId,
        "transition-reviewer-account",
      );
      try {
        service.transitionCallState(db, nonOrgSession, {
          callId: f.callId,
          expectedState: "OPEN",
          expectedUpdatedAt: t2.updatedAt,
          nextState: "PAUSED",
        });
        expect.fail("Role lacking capability must throw DenialError");
      } catch (err) {
        expect(err).toBeInstanceOf(DenialError);
        expect((err as DenialError).code).toBe("CAPABILITY_DENIED");
      }

      const foreignCallSession = { ...f.session, workspaceId: "ws-other" };
      try {
        service.transitionCallState(db, foreignCallSession, {
          callId: f.callId,
          expectedState: "OPEN",
          expectedUpdatedAt: t2.updatedAt,
          nextState: "PAUSED",
        });
        expect.fail("Foreign target scope preflight must throw CALL_NOT_AVAILABLE");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("CALL_NOT_AVAILABLE");
      }

      const auditRows = db
        .prepare(
          "SELECT action, details_json FROM audit_events ORDER BY rowid DESC LIMIT 2",
        )
        .all() as { action: string; details_json: string }[];
      expect(auditRows.some((r) => r.action === "security.access.denied")).toBe(true);

      const callAfter = db
        .prepare("SELECT state FROM calls WHERE id = ?")
        .get(f.callId) as { state: string };
      expect(callAfter.state).toBe("OPEN");
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 4: Extension command exact replay, conflicts, deadline checks, and corrupt rows", () => {
    const dbPath = resolve(".tmp/unit", `cfp-extensions-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });

    try {
      const f = setupFixture(db, { state: "OPEN", closesAt: "2026-08-10T18:00:00.000Z" });
      const personId = "person-ext-1";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        personId,
        f.workspaceId,
        "applicant.ext@synthetic.example",
        "Ext Applicant",
        "2026-08-10T00:00:00.000Z",
      );

      const service = createCfpApplicantAccess({ now: () => "2026-08-10T12:00:00.000Z" });

      const ext1 = service.grantCallExtension(db, f.session, {
        callId: f.callId,
        personId,
        extendsTo: "2026-08-10T20:00:00.000Z",
        reason: "Valid reason for extension",
        idempotencyKey: "idem-ext-1",
      });
      expect(ext1.replayed).toBe(false);

      const ext1Replay = service.grantCallExtension(db, f.session, {
        callId: f.callId,
        personId,
        extendsTo: "2026-08-10T20:00:00.000Z",
        reason: "Valid reason for extension",
        idempotencyKey: "idem-ext-1",
      });
      expect(ext1Replay.replayed).toBe(true);
      expect(ext1Replay.extensionId).toBe(ext1.extensionId);

      try {
        service.grantCallExtension(db, f.session, {
          callId: f.callId,
          personId,
          extendsTo: "2026-08-10T21:00:00.000Z",
          reason: "Different reason",
          idempotencyKey: "idem-ext-1",
        });
        expect.fail("Idempotency conflict must throw EXTENSION_IDEMPOTENCY_CONFLICT");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("EXTENSION_IDEMPOTENCY_CONFLICT");
      }

      try {
        service.grantCallExtension(db, f.session, {
          callId: f.callId,
          personId,
          extendsTo: "2026-08-10T19:00:00.000Z",
          reason: "Shorter extension",
          idempotencyKey: "idem-ext-2",
        });
        expect.fail("Shorter extension must throw EXTENSION_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("EXTENSION_INVALID");
      }

      try {
        service.grantCallExtension(db, f.session, {
          callId: f.callId,
          personId,
          extendsTo: "2026-08-10T11:00:00.000Z",
          reason: "Past extension",
          idempotencyKey: "idem-ext-3",
        });
        expect.fail("Past extension must throw EXTENSION_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("EXTENSION_INVALID");
      }

      db.prepare(
        "INSERT INTO call_extensions (id, workspace_id, call_id, person_id, extends_to, reason, granted_by, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "ext-corrupt",
        f.workspaceId,
        f.callId,
        personId,
        "invalid-date-format",
        "Corrupt reason",
        f.accountId,
        "idem-corrupt",
        "2026-08-10T12:00:00.000Z",
      );

      try {
        service.grantCallExtension(db, f.session, {
          callId: f.callId,
          personId,
          extendsTo: "2026-08-10T23:00:00.000Z",
          reason: "Should fail due to corrupt row",
          idempotencyKey: "idem-ext-4",
        });
        expect.fail("Corrupt row must fail closed");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("ACCESS_READ_FAILED");
      }
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 5: Public email verification issuance, normalization, replay, and access mode gates", () => {
    const dbPath = resolve(".tmp/unit", `cfp-issuance-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });

    try {
      const fPublic = setupFixture(db, { accessMode: "PUBLIC", state: "OPEN" });
      const fInvited = setupFixture(db, { accessMode: "INVITED", state: "OPEN" });

      const service = createCfpApplicantAccess({ now: () => "2026-08-10T12:00:00.000Z" });

      try {
        service.issueEmailVerification(
          db,
          { workspaceId: fInvited.workspaceId },
          { callId: fInvited.callId, email: "user@example.com", tokenHash: HEX_64_A },
        );
        expect.fail("INVITED mode must deny public issuance");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("VERIFICATION_REQUEST_REJECTED");
      }

      const v1 = service.issueEmailVerification(
        db,
        { workspaceId: fPublic.workspaceId },
        {
          callId: fPublic.callId,
          email: " User.Name@Example.COM ",
          tokenHash: HEX_64_A,
        },
      );
      expect(v1.replayed).toBe(false);

      const v1Replay = service.issueEmailVerification(
        db,
        { workspaceId: fPublic.workspaceId },
        {
          callId: fPublic.callId,
          email: "user.name@example.com",
          tokenHash: HEX_64_A,
        },
      );
      expect(v1Replay.replayed).toBe(true);
      expect(v1Replay.verificationId).toBe(v1.verificationId);

      const v2 = service.issueEmailVerification(
        db,
        { workspaceId: fPublic.workspaceId },
        {
          callId: fPublic.callId,
          email: "user.name@example.com",
          tokenHash: HEX_64_B,
        },
      );
      expect(v2.replayed).toBe(false);
      expect(v2.verificationId).not.toBe(v1.verificationId);
      expect(
        db
          .prepare(
            `SELECT token_hash, issuance_sequence
             FROM cfp_email_verifications
             WHERE workspace_id = ? AND call_id = ? AND email = ?
             ORDER BY issuance_sequence`,
          )
          .all(
            fPublic.workspaceId,
            fPublic.callId,
            "user.name@example.com",
          ),
      ).toEqual([
        { token_hash: HEX_64_A, issuance_sequence: 1 },
        { token_hash: HEX_64_B, issuance_sequence: 2 },
      ]);

      try {
        service.issueEmailVerification(
          db,
          { workspaceId: fPublic.workspaceId },
          {
            callId: fPublic.callId,
            email: "user.name@example.com",
            tokenHash: HEX_64_A,
          },
        );
        expect.fail("A superseded digest must not be replayed into active status");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("VERIFICATION_REQUEST_REJECTED");
      }

      expect(() =>
        service.consumeEmailVerification(
          db,
          { workspaceId: fPublic.workspaceId },
          {
            callId: fPublic.callId,
            verificationId: v1.verificationId,
            verificationTokenHash: HEX_64_A,
            applicantSessionTokenHash: HEX_64_C,
            fullName: "Superseded Applicant",
          },
        ),
      ).toThrowError(expect.objectContaining({ code: "VERIFICATION_INVALID" }));

      const consumedLatest = service.consumeEmailVerification(
        db,
        { workspaceId: fPublic.workspaceId },
        {
          callId: fPublic.callId,
          verificationId: v2.verificationId,
          verificationTokenHash: HEX_64_B,
          applicantSessionTokenHash: HEX_64_C,
          fullName: "Latest Applicant",
        },
      );
      expect(consumedLatest.replayed).toBe(false);

      try {
        service.issueEmailVerification(
          db,
          { workspaceId: fPublic.workspaceId },
          {
            callId: fPublic.callId,
            email: "invalid-email-format",
            tokenHash: HEX_64_A,
          },
        );
        expect.fail("Invalid email format must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("VERIFICATION_REQUEST_REJECTED");
      }
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 6: Verification consumption, person creation, session issuance, and race worker", async () => {
    if (process.env.SYMPOSE_PERSISTENT_RACE_ACTOR === "1") {
      return runPersistentRaceActor(() => {
        const raceDb = openDb({ path: process.env.CFP_RACE_DB!, seed: false });
        try {
        const resultPath = process.env.CFP_RACE_RESULT!;
        const role = process.env.CFP_RACE_ROLE!;
        const service = createCfpApplicantAccess({ now: () => "2026-08-10T12:05:00.000Z" });
        const invoke = (publicDb: Db) =>
          service.consumeEmailVerification(
            publicDb,
            { workspaceId: process.env.CFP_RACE_WORKSPACE! },
            {
              callId: process.env.CFP_RACE_CALL!,
              verificationId: process.env.CFP_RACE_VERIFICATION!,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_B,
              fullName: `Race Applicant ${role.toUpperCase()}`,
            },
          );

        let publicDb: Db;
        if (role === "a") {
          publicDb = new Proxy(raceDb, {
            get(target, property) {
              if (property === "exec") {
                return (sql: string): void => {
                  target.exec(sql);
                  if (sql.trim() === "BEGIN IMMEDIATE") {
                    expect(target.isTransaction).toBe(true);
                    writeFileSync(
                      process.env.CFP_RACE_OWNER_MARKER!,
                      String(process.pid),
                      "utf8",
                    );
                    waitForMarker(process.env.CFP_RACE_RELEASE_MARKER!);
                  }
                };
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as Db;
        } else {
          requireRealSqliteBusyBeforeRelease(
            raceDb,
            process.env.CFP_RACE_OWNER_MARKER!,
            process.env.CFP_RACE_BUSY_MARKER!,
            process.env.CFP_RACE_RELEASE_MARKER!,
          );
          publicDb = raceDb;
        }

        try {
          const consumed = invoke(publicDb);
          writeFileSync(
            resultPath,
            JSON.stringify({
              result: consumed.replayed ? "replayed" : "success",
              pid: process.pid,
              sessionId: consumed.sessionId,
            }),
            "utf8",
          );
        } catch (err) {
          writeFileSync(
            resultPath,
            JSON.stringify({
              result:
                err instanceof CfpApplicantAccessError ? err.code : "UNEXPECTED_ERROR",
              pid: process.pid,
            }),
            "utf8",
          );
        }
        } finally {
          closeDb(raceDb);
        }
      });
    }

    const dbPath = resolve(".tmp/unit", `cfp-consume-${process.pid}.db`);
    const raceDbPath = resolve(".tmp/unit", `cfp-consume-race-${process.pid}.db`);
    const resultPaths = [
      resolve(".tmp/unit", `race-result-a-${process.pid}.json`),
      resolve(".tmp/unit", `race-result-b-${process.pid}.json`),
    ];
    const ownerMarker = resolve(".tmp/unit", `race-owner-${process.pid}.marker`);
    const busyMarker = resolve(".tmp/unit", `race-busy-${process.pid}.marker`);
    const releaseMarker = resolve(".tmp/unit", `race-release-${process.pid}.marker`);
    removeSqliteFiles(dbPath);
    removeSqliteFiles(raceDbPath);
    for (const path of [...resultPaths, ownerMarker, busyMarker, releaseMarker]) {
      rmSync(path, { force: true });
    }
    let db = openDb({ path: dbPath });
    let dbOpen = true;
    const raceChildren: PersistentRaceActor[] = [];

    try {
      const f = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({ now: () => "2026-08-10T12:00:00.000Z" });

      const issued = service.issueEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        {
          callId: f.callId,
          email: "applicant.consume@synthetic.example",
          tokenHash: HEX_64_A,
        },
      );

      const consumed = service.consumeEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        {
          callId: f.callId,
          verificationId: issued.verificationId,
          verificationTokenHash: HEX_64_A,
          applicantSessionTokenHash: HEX_64_B,
          fullName: "Applicant Consume",
        },
      );
      expect(consumed.replayed).toBe(false);

      const personCount = db
        .prepare(
          "SELECT COUNT(*) as count FROM people WHERE workspace_id = ? AND lower(canonical_email) = ?",
        )
        .get(f.workspaceId, "applicant.consume@synthetic.example") as { count: number };
      expect(personCount.count).toBe(1);

      const retryConsumed = service.consumeEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        {
          callId: f.callId,
          verificationId: issued.verificationId,
          verificationTokenHash: HEX_64_A,
          applicantSessionTokenHash: HEX_64_B,
          fullName: "Applicant Consume",
        },
      );
      expect(retryConsumed.replayed).toBe(true);
      expect(retryConsumed.sessionId).toBe(consumed.sessionId);

      try {
        service.consumeEmailVerification(
          db,
          { workspaceId: f.workspaceId },
          {
            callId: f.callId,
            verificationId: issued.verificationId,
            verificationTokenHash: HEX_64_A,
            applicantSessionTokenHash: HEX_64_C,
            fullName: "Applicant Consume",
          },
        );
        expect.fail("Different session digest on consume retry must throw VERIFICATION_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("VERIFICATION_INVALID");
      }

      const fClosed = setupFixture(db, { state: "OPEN", closesAt: "2026-08-10T14:00:00.000Z" });
      const issued2 = service.issueEmailVerification(
        db,
        { workspaceId: fClosed.workspaceId },
        {
          callId: fClosed.callId,
          email: "closed.consume@synthetic.example",
          tokenHash: HEX_64_C,
        },
      );

      const lateService = createCfpApplicantAccess({ now: () => "2026-08-10T15:00:00.000Z" });
      try {
        lateService.consumeEmailVerification(
          db,
          { workspaceId: fClosed.workspaceId },
          {
            callId: fClosed.callId,
            verificationId: issued2.verificationId,
            verificationTokenHash: HEX_64_C,
            applicantSessionTokenHash: HEX_64_D,
            fullName: "Closed Consume",
          },
        );
        expect.fail("Consumption after close without extension must throw VERIFICATION_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("VERIFICATION_INVALID");
      }

      const unconsumedCheck = db
        .prepare("SELECT id FROM cfp_email_verification_consumptions WHERE verification_id = ?")
        .get(issued2.verificationId);
      expect(unconsumedCheck).toBeUndefined();

      closeDb(db);
      dbOpen = false;

      db = openDb({ path: raceDbPath });
      dbOpen = true;
      const fRace = setupFixture(db, { state: "OPEN" });
      const issuedRace = service.issueEmailVerification(
        db,
        { workspaceId: fRace.workspaceId },
        {
          callId: fRace.callId,
          email: "race.consume@synthetic.example",
          tokenHash: HEX_64_A,
        },
      );
      closeDb(db);
      dbOpen = false;

      raceChildren.push(
        ...(await startPersistentRaceActors({
          testFile: "tests/unit/cfp-applicant-access.test.ts",
          testName:
            "Evidence Group 6: Verification consumption, person creation, session issuance, and race worker$",
        })),
      );
      const runContender = (role: "a" | "b", resultPath: string): Promise<number> =>
        raceChildren[role === "a" ? 0 : 1]!.request({
          CFP_RACE_DB: raceDbPath,
          CFP_RACE_WORKSPACE: fRace.workspaceId,
          CFP_RACE_CALL: fRace.callId,
          CFP_RACE_VERIFICATION: issuedRace.verificationId,
          CFP_RACE_RESULT: resultPath,
          CFP_RACE_ROLE: role,
          CFP_RACE_OWNER_MARKER: ownerMarker,
          CFP_RACE_BUSY_MARKER: busyMarker,
          CFP_RACE_RELEASE_MARKER: releaseMarker,
        });

      const owner = runContender("a", resultPaths[0]!);
      await waitForMarkers([ownerMarker]);
      const contender = runContender("b", resultPaths[1]!);
      await waitForMarkers([ownerMarker, busyMarker]);
      const ownerPid = Number(readFileSync(ownerMarker, "utf8"));
      const busyProof = readSqliteBusyMarker(busyMarker);
      expect(ownerPid).not.toBe(busyProof.pid);
      writeFileSync(releaseMarker, "release", "utf8");
      const exitCodes = await Promise.all([owner, contender]);
      expect(exitCodes).toEqual([0, 0]);

      const outcomes = resultPaths.map(
        (rp) => JSON.parse(readFileSync(rp, "utf8")) as {
          result: string;
          sessionId: string;
          pid: number;
        },
      );
      expect(outcomes.map((outcome) => outcome.result)).toEqual(["success", "replayed"]);
      expect(outcomes[0]!.sessionId).toBe(outcomes[1]!.sessionId);
      expect(outcomes[0]!.pid).toBe(ownerPid);
      expect(outcomes[1]!.pid).toBe(busyProof.pid);

      const verifyRaceDb = openDb({ path: raceDbPath, seed: false });
      try {
        const people = verifyRaceDb
          .prepare(
            `SELECT id, workspace_id, canonical_email, full_name
             FROM people ORDER BY rowid`,
          )
          .all() as Array<{
          id: string;
          workspace_id: string;
          canonical_email: string;
          full_name: string;
        }>;
        expect(people).toHaveLength(1);
        expect(people[0]).toMatchObject({
          workspace_id: fRace.workspaceId,
          canonical_email: "race.consume@synthetic.example",
          full_name: "Race Applicant A",
        });
        const consumptions = verifyRaceDb
          .prepare(
            `SELECT verification_id, person_id
             FROM cfp_email_verification_consumptions ORDER BY rowid`,
          )
          .all() as Array<{ verification_id: string; person_id: string }>;
        expect(consumptions).toEqual([
          {
            verification_id: issuedRace.verificationId,
            person_id: people[0]!.id,
          },
        ]);
        expect(
          verifyRaceDb
            .prepare(
              `SELECT id, workspace_id, call_id, person_id, verification_id,
                      token_hash
               FROM cfp_applicant_sessions ORDER BY rowid`,
            )
            .all(),
        ).toEqual([
          {
            id: outcomes[0]!.sessionId,
            workspace_id: fRace.workspaceId,
            call_id: fRace.callId,
            person_id: people[0]!.id,
            verification_id: issuedRace.verificationId,
            token_hash: HEX_64_B,
          },
        ]);
      } finally {
        closeDb(verifyRaceDb);
      }
      await stopPersistentRaceActors(raceChildren);
      expect(
        raceChildren.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
      ).toBe(true);

    } finally {
      await stopPersistentRaceActors(raceChildren);
      if (dbOpen) closeDb(db);
      for (const path of [...resultPaths, ownerMarker, busyMarker, releaseMarker]) {
        rmSync(path, { force: true });
      }
      removeSqliteFiles(raceDbPath);
      removeSqliteFiles(dbPath);
    }
    expect(
      [
        ...resultPaths,
        ownerMarker,
        busyMarker,
        releaseMarker,
        raceDbPath,
        `${raceDbPath}-wal`,
        `${raceDbPath}-shm`,
        `${raceDbPath}-journal`,
      ].every((path) => !existsSync(path)),
    ).toBe(true);
  }, 60_000);

  it("Evidence Group 7: Session resolution boundaries, email mirror check, and organizer revocation", () => {
    const dbPath = resolve(".tmp/unit", `cfp-session-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });

    try {
      const f = setupFixture(db, { state: "OPEN" });
      let currentClock = "2026-08-10T12:00:00.000Z";
      const service = createCfpApplicantAccess({ now: () => currentClock });

      const issued = service.issueEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        {
          callId: f.callId,
          email: "session.user@synthetic.example",
          tokenHash: HEX_64_A,
        },
      );
      const consumed = service.consumeEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        {
          callId: f.callId,
          verificationId: issued.verificationId,
          verificationTokenHash: HEX_64_A,
          applicantSessionTokenHash: HEX_64_B,
          fullName: "Session User",
        },
      );

      const resolved = service.resolveApplicantSession(db, {
        workspaceId: f.workspaceId,
        callId: f.callId,
        sessionTokenHash: HEX_64_B,
      });
      expect(resolved.context.sessionId).toBe(consumed.sessionId);
      expect(resolved.personId).toBe(consumed.personId);

      db.prepare("UPDATE people SET canonical_email = 'mismatched@synthetic.example' WHERE id = ?").run(consumed.personId);
      try {
        service.resolveApplicantSession(db, {
          workspaceId: f.workspaceId,
          callId: f.callId,
          sessionTokenHash: HEX_64_B,
        });
        expect.fail("Verification/person email mirror mismatch must throw SESSION_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("SESSION_INVALID");
      }
      db.prepare("UPDATE people SET canonical_email = 'session.user@synthetic.example' WHERE id = ?").run(consumed.personId);

      currentClock = "2026-09-01T00:00:00.000Z";
      try {
        service.resolveApplicantSession(db, {
          workspaceId: f.workspaceId,
          callId: f.callId,
          sessionTokenHash: HEX_64_B,
        });
        expect.fail("Expired session resolution must throw SESSION_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("SESSION_INVALID");
      }

      currentClock = "2026-08-10T12:30:00.000Z";
      const revoked = service.revokeApplicantSession(db, f.session, {
        callId: f.callId,
        sessionId: consumed.sessionId,
        reason: "Security concern",
      });
      expect(revoked.replayed).toBe(false);

      const revokedReplay = service.revokeApplicantSession(db, f.session, {
        callId: f.callId,
        sessionId: consumed.sessionId,
        reason: "Security concern",
      });
      expect(revokedReplay.replayed).toBe(true);

      try {
        service.revokeApplicantSession(db, f.session, {
          callId: f.callId,
          sessionId: consumed.sessionId,
          reason: "Different reason",
        });
        expect.fail("Conflicting revocation reason must throw SESSION_REVOKE_CONFLICT");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("SESSION_REVOKE_CONFLICT");
      }

      try {
        service.revokeApplicantSession(db, f.session, {
          callId: f.callId,
          sessionId: "non-existent-session-id",
          reason: "Security concern",
        });
        expect.fail("Missing session target in revoke must throw CALL_NOT_AVAILABLE");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("CALL_NOT_AVAILABLE");
      }

      try {
        service.resolveApplicantSession(db, {
          workspaceId: f.workspaceId,
          callId: f.callId,
          sessionTokenHash: HEX_64_B,
        });
        expect.fail("Revoked session resolution must throw SESSION_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        expect((err as CfpApplicantAccessError).code).toBe("SESSION_INVALID");
      }
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 8: End-to-end journey with savepoint transaction proof", () => {
    const dbPath = resolve(".tmp/unit", `cfp-journey-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });

    try {
      const f = setupFixture(db, { state: "OPEN", closesAt: "2026-08-10T18:00:00.000Z" });
      let currentClock = "2026-08-10T12:00:00.000Z";
      const service = createCfpApplicantAccess({ now: () => currentClock });

      const issued = service.issueEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        {
          callId: f.callId,
          email: "journey.user@synthetic.example",
          tokenHash: HEX_64_A,
        },
      );
      const consumed = service.consumeEmailVerification(
        db,
        { workspaceId: f.workspaceId },
        {
          callId: f.callId,
          verificationId: issued.verificationId,
          verificationTokenHash: HEX_64_A,
          applicantSessionTokenHash: HEX_64_B,
          fullName: "Journey User",
        },
      );

      let draftId = "";
      let firstRevisionId = "";
      withTransactionOrSavepoint(db, "journey_tx_proof", () => {
        const resolved = service.resolveApplicantSession(db, {
          workspaceId: f.workspaceId,
          callId: f.callId,
          sessionTokenHash: HEX_64_B,
        });

        service.assertApplicantAccess(db, {
          action: "CREATE_DRAFT",
          context: resolved.context,
        });

        const draft = createDraftSubmission(db, resolved.context, { callId: f.callId });
        expect(draft.id).toBeDefined();
        draftId = draft.id;

        const rev1 = saveDraftRevision(db, resolved.context, {
          submissionId: draft.id,
          historicalAnswers: [{ fieldId: "f-title", value: "My Proposal Title" }],
          expectedCurrentRevisionId: null,
        });
        expect(rev1.revisionId).toBeDefined();
        firstRevisionId = rev1.revisionId;
      });

      const beforeOuterRollback = snapshotO2bTruth(db);
      expect(() =>
        withTransactionOrSavepoint(db, "journey_explicit_rollback", () => {
          const rollbackResolved = service.resolveApplicantSession(db, {
            workspaceId: f.workspaceId,
            callId: f.callId,
            sessionTokenHash: HEX_64_B,
          });
          service.assertApplicantAccess(db, {
            action: "CREATE_DRAFT",
            context: rollbackResolved.context,
          });
          const rollbackDraft = createDraftSubmission(db, rollbackResolved.context, {
            callId: f.callId,
          });
          saveDraftRevision(db, rollbackResolved.context, {
            submissionId: rollbackDraft.id,
            historicalAnswers: [{ fieldId: "f-title", value: "Rolled Back Proposal" }],
            expectedCurrentRevisionId: null,
          });
          throw new Error("synthetic outer rollback");
        }),
      ).toThrow("synthetic outer rollback");
      expect(snapshotO2bTruth(db)).toEqual(beforeOuterRollback);

      currentClock = "2026-08-10T19:00:00.000Z";
      const resolved = service.resolveApplicantSession(db, {
        workspaceId: f.workspaceId,
        callId: f.callId,
        sessionTokenHash: HEX_64_B,
      });

      const beforeDeniedOuterWrite = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          withTransactionOrSavepoint(db, "journey_denied_outer_write", () => {
            const deniedResolved = service.resolveApplicantSession(db, {
              workspaceId: f.workspaceId,
              callId: f.callId,
              sessionTokenHash: HEX_64_B,
            });
            service.assertApplicantAccess(db, {
              action: "SAVE_DRAFT",
              context: deniedResolved.context,
            });
            saveDraftRevision(db, deniedResolved.context, {
              submissionId: draftId,
              historicalAnswers: [{ fieldId: "f-title", value: "Denied Late Revision" }],
              expectedCurrentRevisionId: firstRevisionId,
            });
          }),
        "CALL_NOT_ACCEPTING",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeDeniedOuterWrite);

      service.grantCallExtension(db, f.session, {
        callId: f.callId,
        personId: resolved.personId,
        extendsTo: "2026-08-10T22:00:00.000Z",
        reason: "Journey extension",
        idempotencyKey: "idem-journey-ext",
      });

      let secondRevisionId = "";
      withTransactionOrSavepoint(db, "journey_extended_outer_write", () => {
        const extendedResolved = service.resolveApplicantSession(db, {
          workspaceId: f.workspaceId,
          callId: f.callId,
          sessionTokenHash: HEX_64_B,
        });
        const grantAfterExt = service.assertApplicantAccess(db, {
          action: "SAVE_DRAFT",
          context: extendedResolved.context,
        });
        expect(grantAfterExt.late).toBe(true);
        secondRevisionId = saveDraftRevision(db, extendedResolved.context, {
          submissionId: draftId,
          historicalAnswers: [{ fieldId: "f-title", value: "Extended Late Revision" }],
          expectedCurrentRevisionId: firstRevisionId,
        }).revisionId;
      });
      expect(secondRevisionId).not.toBe(firstRevisionId);

      const submissions = db.prepare("SELECT id FROM submissions").all();
      expect(submissions.length).toBe(1);
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM submission_revisions WHERE submission_id = ?",
            )
            .get(draftId) as { count: number }
        ).count,
      ).toBe(2);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 9: Error & audit safety scan proving no sensitive data leakage", () => {
    const dbPath = resolve(".tmp/unit", `cfp-audit-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });

    try {
      const f = setupFixture(db, { state: "OPEN", closesAt: "2026-08-10T23:59:59.000Z" });
      const service = createCfpApplicantAccess({ now: () => "2026-08-10T12:00:00.000Z" });

      try {
        service.resolveApplicantSession(db, {
          workspaceId: f.workspaceId,
          callId: f.callId,
          sessionTokenHash: HEX_64_C,
        });
        expect.fail("Invalid session hash must throw SESSION_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        const appErr = err as CfpApplicantAccessError;
        expect(appErr.code).toBe("SESSION_INVALID");
        expect(appErr.message).not.toContain(HEX_64_C);
        expect(appErr.message).not.toContain(f.workspaceId);
      }

      try {
        service.issueEmailVerification(
          db,
          { workspaceId: f.workspaceId },
          {
            callId: f.callId,
            email: "secret.email@synthetic.example",
            tokenHash: "invalid-hash",
          },
        );
        expect.fail("Invalid hash in issuance must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
        const appErr = err as CfpApplicantAccessError;
        expect(appErr.message).not.toContain("secret.email@synthetic.example");
        expect(appErr.message).not.toContain("invalid-hash");
      }

      const personId = "person-audit-1";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        personId,
        f.workspaceId,
        "audit.person@synthetic.example",
        "Audit Person",
        "2026-08-10T00:00:00.000Z",
      );

      service.grantCallExtension(db, f.session, {
        callId: f.callId,
        personId,
        extendsTo: "2026-08-11T12:00:00.000Z",
        reason: "Secret reason text",
        idempotencyKey: "idem-audit-1",
      });

      const auditRows = db
        .prepare("SELECT * FROM audit_events WHERE workspace_id = ?")
        .all(f.workspaceId) as { details_json: string }[];
      for (const row of auditRows) {
        if (row.details_json) {
          expect(row.details_json).not.toContain("secret.email@synthetic.example");
          expect(row.details_json).not.toContain("Secret reason text");
          expect(row.details_json).not.toContain(HEX_64_A);
          expect(row.details_json).not.toContain(personId);
          expect(row.details_json).not.toContain(f.callId);
        }
      }
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 10: Database snapshot truth comparisons around forbidden operations", () => {
    const dbPath = resolve(".tmp/unit", `cfp-snapshots-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });

    try {
      const f = setupFixture(db, { state: "CLOSED" });
      const service = createCfpApplicantAccess({ now: () => "2026-08-10T12:00:00.000Z" });

      const countTable = (t: string) =>
        (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }).c;
      const initialCounts = {
        people: countTable("people"),
        verifications: countTable("cfp_email_verifications"),
        consumptions: countTable("cfp_email_verification_consumptions"),
        sessions: countTable("cfp_applicant_sessions"),
        extensions: countTable("call_extensions"),
      };

      try {
        service.issueEmailVerification(
          db,
          { workspaceId: f.workspaceId },
          {
            callId: f.callId,
            email: "forbidden@synthetic.example",
            tokenHash: HEX_64_A,
          },
        );
        expect.fail("Forbidden issuance must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantAccessError);
      }

      const afterCounts = {
        people: countTable("people"),
        verifications: countTable("cfp_email_verifications"),
        consumptions: countTable("cfp_email_verification_consumptions"),
        sessions: countTable("cfp_applicant_sessions"),
        extensions: countTable("call_extensions"),
      };
      expect(afterCounts).toEqual(initialCounts);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 2A: exact boundaries, null windows, access modes, and closed-state precedence", () => {
    const dbPath = resolve(".tmp/unit", `cfp-boundaries-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const boundary = setupFixture(db, {
        state: "OPEN",
        opensAt: "2026-08-10T12:00:00.000Z",
        closesAt: "2026-08-10T13:00:00.000Z",
      });
      const atOpen = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const boundaryIdentity = issueAndConsume(
        atOpen,
        db,
        boundary,
        "boundary@synthetic.example",
        HEX_64_A,
        HEX_64_B,
      );
      expect(
        atOpen.assertApplicantAccess(db, {
          action: "CREATE_DRAFT",
          context: {
            workspaceId: boundary.workspaceId,
            sessionId: boundaryIdentity.consumed.sessionId,
          },
        }),
      ).toEqual({ allowed: true, late: false, extensionId: null });

      const atClose = createCfpApplicantAccess({
        now: () => "2026-08-10T13:00:00.000Z",
      });
      expectCfpCode(
        () =>
          atClose.assertApplicantAccess(db, {
            action: "SAVE_DRAFT",
            context: {
              workspaceId: boundary.workspaceId,
              sessionId: boundaryIdentity.consumed.sessionId,
            },
          }),
        "CALL_NOT_ACCEPTING",
      );

      const extension = atOpen.grantCallExtension(db, boundary.session, {
        callId: boundary.callId,
        personId: boundaryIdentity.consumed.personId,
        extendsTo: "2026-08-10T14:00:00.000Z",
        reason: "Boundary extension",
        idempotencyKey: "boundary-extension-key",
      });
      expect(
        atClose.assertApplicantAccess(db, {
          action: "SUBMIT",
          context: {
            workspaceId: boundary.workspaceId,
            sessionId: boundaryIdentity.consumed.sessionId,
          },
        }),
      ).toEqual({ allowed: true, late: true, extensionId: extension.extensionId });
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T14:00:00.000Z",
          }).assertApplicantAccess(db, {
            action: "SUBMIT",
            context: {
              workspaceId: boundary.workspaceId,
              sessionId: boundaryIdentity.consumed.sessionId,
            },
          }),
        "CALL_NOT_ACCEPTING",
      );

      const noWindows = setupFixture(db, {
        state: "OPEN",
        opensAt: null,
        closesAt: null,
      });
      const noWindowIssue = atOpen.issueEmailVerification(
        db,
        { workspaceId: noWindows.workspaceId },
        {
          callId: noWindows.callId,
          email: "null.windows@synthetic.example",
          tokenHash: HEX_64_C,
        },
      );
      expect(noWindowIssue.replayed).toBe(false);

      const hybrid = setupFixture(db, {
        accessMode: "PUBLIC_AND_INVITED",
        state: "OPEN",
      });
      const hybridIdentity = issueAndConsume(
        atOpen,
        db,
        hybrid,
        "hybrid@synthetic.example",
        HEX_64_D,
        HEX_64_E,
      );
      expect(hybridIdentity.consumed.replayed).toBe(false);

      const preOpen = setupFixture(db, {
        state: "OPEN",
        opensAt: "2026-08-10T12:00:00.000Z",
        closesAt: "2026-08-10T13:00:00.000Z",
      });
      const preOpenPerson = "pre-open-person";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        preOpenPerson,
        preOpen.workspaceId,
        "pre.open@synthetic.example",
        "Pre Open Person",
        "2026-08-10T10:00:00.000Z",
      );
      const beforeOpen = createCfpApplicantAccess({
        now: () => "2026-08-10T11:00:00.000Z",
      });
      beforeOpen.grantCallExtension(db, preOpen.session, {
        callId: preOpen.callId,
        personId: preOpenPerson,
        extendsTo: "2026-08-10T14:00:00.000Z",
        reason: "Does not open the call early",
        idempotencyKey: "pre-open-extension",
      });
      expectCfpCode(
        () =>
          beforeOpen.issueEmailVerification(
            db,
            { workspaceId: preOpen.workspaceId },
            {
              callId: preOpen.callId,
              email: "pre.open@synthetic.example",
              tokenHash: HEX_64_A,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );

      const modeChange = setupFixture(db, { state: "OPEN", accessMode: "PUBLIC" });
      const modeIssued = atOpen.issueEmailVerification(
        db,
        { workspaceId: modeChange.workspaceId },
        {
          callId: modeChange.callId,
          email: "mode.change@synthetic.example",
          tokenHash: HEX_64_A,
        },
      );
      db.prepare("UPDATE calls SET access_mode = 'INVITED' WHERE id = ?").run(
        modeChange.callId,
      );
      const beforeModeConsume = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          atOpen.consumeEmailVerification(
            db,
            { workspaceId: modeChange.workspaceId },
            {
              callId: modeChange.callId,
              verificationId: modeIssued.verificationId,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_F,
              fullName: "Mode Change Applicant",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeModeConsume);

      db.prepare("UPDATE calls SET access_mode = 'INVITED' WHERE id = ?").run(
        boundary.callId,
      );
      expectCfpCode(
        () =>
          atOpen.assertApplicantAccess(db, {
            action: "SAVE_DRAFT",
            context: {
              workspaceId: boundary.workspaceId,
              sessionId: boundaryIdentity.consumed.sessionId,
            },
          }),
        "CALL_NOT_ACCEPTING",
      );

      const closedNull = setupFixture(db, {
        state: "OPEN",
        opensAt: null,
        closesAt: null,
      });
      const closedEmail = "closed.null@synthetic.example";
      const closedIssue = atOpen.issueEmailVerification(
        db,
        { workspaceId: closedNull.workspaceId },
        { callId: closedNull.callId, email: closedEmail, tokenHash: HEX_64_C },
      );
      const closedPerson = "closed-null-person";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        closedPerson,
        closedNull.workspaceId,
        closedEmail,
        "Closed Null Person",
        "2026-08-10T10:00:00.000Z",
      );
      db.prepare("UPDATE calls SET state = 'CLOSED' WHERE id = ?").run(closedNull.callId);
      const closedAttempt = () =>
        atOpen.consumeEmailVerification(
          db,
          { workspaceId: closedNull.workspaceId },
          {
            callId: closedNull.callId,
            verificationId: closedIssue.verificationId,
            verificationTokenHash: HEX_64_C,
            applicantSessionTokenHash: HEX_64_D,
            fullName: "Closed Null Person",
          },
        );
      expectCfpCode(closedAttempt, "VERIFICATION_INVALID");
      expect(
        db
          .prepare(
            "SELECT id FROM cfp_email_verification_consumptions WHERE verification_id = ?",
          )
          .get(closedIssue.verificationId),
      ).toBeUndefined();
      atOpen.grantCallExtension(db, closedNull.session, {
        callId: closedNull.callId,
        personId: closedPerson,
        extendsTo: "2026-08-10T14:00:00.000Z",
        reason: "Closed-state extension",
        idempotencyKey: "closed-null-extension",
      });
      expect(closedAttempt().replayed).toBe(false);

      const closedFuture = setupFixture(db, {
        state: "OPEN",
        closesAt: "2026-08-10T18:00:00.000Z",
      });
      const futureIssue = atOpen.issueEmailVerification(
        db,
        { workspaceId: closedFuture.workspaceId },
        {
          callId: closedFuture.callId,
          email: "closed.future@synthetic.example",
          tokenHash: HEX_64_D,
        },
      );
      db.prepare("UPDATE calls SET state = 'CLOSED' WHERE id = ?").run(
        closedFuture.callId,
      );
      expectCfpCode(
        () =>
          atOpen.consumeEmailVerification(
            db,
            { workspaceId: closedFuture.workspaceId },
            {
              callId: closedFuture.callId,
              verificationId: futureIssue.verificationId,
              verificationTokenHash: HEX_64_D,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Closed Future Applicant",
            },
          ),
        "VERIFICATION_INVALID",
      );

      db.prepare("UPDATE calls SET state = 'PAUSED' WHERE id = ?").run(hybrid.callId);
      expect(
        atOpen.resolveApplicantSession(db, {
          workspaceId: hybrid.workspaceId,
          callId: hybrid.callId,
          sessionTokenHash: HEX_64_E,
        }).context.sessionId,
      ).toBe(hybridIdentity.consumed.sessionId);
      expectCfpCode(
        () =>
          atOpen.assertApplicantAccess(db, {
            action: "SAVE_DRAFT",
            context: {
              workspaceId: hybrid.workspaceId,
              sessionId: hybridIdentity.consumed.sessionId,
            },
          }),
        "CALL_NOT_ACCEPTING",
      );
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 3A: complete lifecycle graph, clock CAS, and stored organizer scope", () => {
    const dbPath = resolve(".tmp/unit", `cfp-lifecycle-complete-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "DRAFT" });
      const states = [
        "DRAFT",
        "SCHEDULED",
        "OPEN",
        "PAUSED",
        "CLOSED",
        "CANCELLED",
        "ARCHIVED",
      ] as const;
      const allowed = new Set([
        "DRAFT>SCHEDULED",
        "DRAFT>CANCELLED",
        "SCHEDULED>OPEN",
        "SCHEDULED>CANCELLED",
        "OPEN>PAUSED",
        "OPEN>CLOSED",
        "OPEN>CANCELLED",
        "PAUSED>OPEN",
        "PAUSED>CLOSED",
        "PAUSED>CANCELLED",
        "CLOSED>ARCHIVED",
        "CANCELLED>ARCHIVED",
      ]);
      const first = readCallLifecycle(db, fixture.workspaceId, fixture.callId);
      let cursor = Date.parse(first.updatedAt) + 1_000;
      let acceptedCount = 0;

      for (const fromState of states) {
        for (const toState of states) {
          const setupAt = new Date(cursor).toISOString();
          const transitionAt = new Date(cursor + 1_000).toISOString();
          cursor += 2_000;
          db.prepare("UPDATE calls SET state = ?, updated_at = ? WHERE id = ?").run(
            fromState,
            setupAt,
            fixture.callId,
          );
          const before = snapshotO2bTruth(db);
          const beforeAudit = (
            db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
              count: number;
            }
          ).count;
          const service = createCfpApplicantAccess({ now: () => transitionAt });
          const edge = `${fromState}>${toState}`;

          if (allowed.has(edge)) {
            const result = service.transitionCallState(db, fixture.session, {
              callId: fixture.callId,
              expectedState: fromState,
              expectedUpdatedAt: setupAt,
              nextState: toState,
            });
            expect(result).toEqual({ state: toState, updatedAt: transitionAt });
            acceptedCount += 1;
            const audit = db
              .prepare(
                `SELECT action, target_type, target_id, details_json
                 FROM audit_events ORDER BY rowid DESC LIMIT 1`,
              )
              .get() as {
              action: string;
              target_type: string;
              target_id: string;
              details_json: string;
            };
            expect(audit).toEqual({
              action: "cfp.call.transition",
              target_type: "call",
              target_id: fixture.callId,
              details_json: JSON.stringify({ fromState, toState }),
            });
            expect(
              (
                db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
                  count: number;
                }
              ).count,
            ).toBe(beforeAudit + 1);
          } else {
            expectCfpCode(
              () =>
                service.transitionCallState(db, fixture.session, {
                  callId: fixture.callId,
                  expectedState: fromState,
                  expectedUpdatedAt: setupAt,
                  nextState: toState,
                }),
              "CALL_STATE_INVALID",
            );
            expect(snapshotO2bTruth(db)).toEqual(before);
            expect(
              (
                db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
                  count: number;
                }
              ).count,
            ).toBe(beforeAudit);
          }
        }
      }
      expect(acceptedCount).toBe(12);

      const casAt = new Date(cursor).toISOString();
      db.prepare("UPDATE calls SET state = 'OPEN', updated_at = ? WHERE id = ?").run(
        casAt,
        fixture.callId,
      );
      const casTruth = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => new Date(cursor + 2_000).toISOString(),
          }).transitionCallState(db, fixture.session, {
            callId: fixture.callId,
            expectedState: "PAUSED",
            expectedUpdatedAt: casAt,
            nextState: "OPEN",
          }),
        "CALL_STATE_STALE",
      );
      expect(snapshotO2bTruth(db)).toEqual(casTruth);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => new Date(cursor + 2_000).toISOString(),
          }).transitionCallState(db, fixture.session, {
            callId: fixture.callId,
            expectedState: "OPEN",
            expectedUpdatedAt: new Date(cursor - 2_000).toISOString(),
            nextState: "PAUSED",
          }),
        "CALL_STATE_STALE",
      );
      expect(snapshotO2bTruth(db)).toEqual(casTruth);

      for (const nonAdvancingNow of [
        casAt,
        new Date(Date.parse(casAt) - 1).toISOString(),
      ]) {
        expectCfpCode(
          () =>
            createCfpApplicantAccess({ now: () => nonAdvancingNow }).transitionCallState(
              db,
              fixture.session,
              {
                callId: fixture.callId,
                expectedState: "OPEN",
                expectedUpdatedAt: casAt,
                nextState: "PAUSED",
              },
            ),
          "CALL_STATE_STALE",
        );
        expect(snapshotO2bTruth(db)).toEqual(casTruth);
      }

      for (const malformedInstant of [
        "2026-08-10T12:00:00+00:00",
        "2026-08-10",
        "not-an-instant",
      ]) {
        expectCfpCode(
          () =>
            createCfpApplicantAccess({ now: () => malformedInstant }).transitionCallState(
              db,
              fixture.session,
              {
                callId: fixture.callId,
                expectedState: "OPEN",
                expectedUpdatedAt: casAt,
                nextState: "PAUSED",
              },
            ),
          "ACCESS_INPUT_INVALID",
        );
        expect(snapshotO2bTruth(db)).toEqual(casTruth);
      }

      const assertScopeDenial = (session: SessionInfo): void => {
        const before = snapshotO2bTruth(db);
        const beforeAudit = (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count;
        expectCfpCode(
          () =>
            createCfpApplicantAccess({
              now: () => new Date(cursor + 4_000).toISOString(),
            }).transitionCallState(db, session, {
              callId: fixture.callId,
              expectedState: "OPEN",
              expectedUpdatedAt: casAt,
              nextState: "PAUSED",
            }),
          "CALL_NOT_AVAILABLE",
        );
        expect(snapshotO2bTruth(db)).toEqual(before);
        expect(
          (
            db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
              count: number;
            }
          ).count,
        ).toBe(beforeAudit + 1);
        const denial = db
          .prepare(
            "SELECT target_type, target_id, details_json FROM audit_events ORDER BY rowid DESC LIMIT 1",
          )
          .get() as { target_type: string; target_id: string; details_json: string };
        expect(denial).toEqual({
          target_type: "cfp_organizer_scope",
          target_id: "call",
          details_json: JSON.stringify({ scopeValid: false, code: "CALL_NOT_AVAILABLE" }),
        });
      };

      assertScopeDenial({ ...fixture.session, accountId: "missing-organizer-account" });
      assertScopeDenial({
        ...fixture.session,
        accountId: "missing-noncap-organizer-account",
        role: "read_only",
      });

      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "stored-reviewer-account",
        fixture.workspaceId,
        "stored.reviewer@synthetic.example",
        "Stored Reviewer",
        "reviewer",
        "2026-08-10T00:00:00.000Z",
      );
      const storedReviewerSession = {
        ...fixture.session,
        accountId: "stored-reviewer-account",
        role: "reviewer",
      };
      const beforeCapabilityDenial = snapshotO2bTruth(db);
      const capabilityAuditBefore = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      try {
        createCfpApplicantAccess({
          now: () => new Date(cursor + 4_000).toISOString(),
        }).transitionCallState(db, storedReviewerSession, {
          callId: fixture.callId,
          expectedState: "OPEN",
          expectedUpdatedAt: casAt,
          nextState: "PAUSED",
        });
        expect.fail("Stored reviewer authority must retain CAPABILITY_DENIED");
      } catch (error) {
        expect(error).toBeInstanceOf(DenialError);
        expect((error as DenialError).code).toBe("CAPABILITY_DENIED");
      }
      expect(snapshotO2bTruth(db)).toEqual(beforeCapabilityDenial);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(capabilityAuditBefore + 1);

      db.prepare(
        "INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
      ).run(
        "foreign-scope-workspace",
        "foreign-scope",
        "Foreign Scope",
        "2026-08-10T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "foreign-organizer-account",
        "foreign-scope-workspace",
        "foreign.organizer@synthetic.example",
        "Foreign Organizer",
        "organizer",
        "2026-08-10T00:00:00.000Z",
      );
      assertScopeDenial({
        ...fixture.session,
        accountId: "foreign-organizer-account",
        role: "organizer",
      });

      db.prepare(
        `INSERT INTO events
           (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "foreign-scope-event",
        "foreign-scope-workspace",
        "Foreign Event",
        "UTC",
        "2026-08-10T00:00:00.000Z",
        "2026-08-11T00:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      );
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET event_id = ? WHERE id = ?").run(
        "foreign-scope-event",
        fixture.callId,
      );
      assertScopeDenial(fixture.session);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 3B: organizer authority is revalidated after BEGIN IMMEDIATE", () => {
    const dbPath = resolve(".tmp/unit", `cfp-organizer-authority-race-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    let authorityDb: Db | null = null;
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:05:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "authority.race@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const lifecycle = service.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );
      authorityDb = openDb({ path: dbPath, seed: false });

      const invocations: ReadonlyArray<readonly [string, (raceDb: Db) => unknown]> = [
        [
          "transition",
          (raceDb) =>
            service.transitionCallState(raceDb, fixture.session, {
              callId: fixture.callId,
              expectedState: "OPEN",
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
        ],
        [
          "extension",
          (raceDb) =>
            service.grantCallExtension(raceDb, fixture.session, {
              callId: fixture.callId,
              personId: applicant.consumed.personId,
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Authority race extension",
              idempotencyKey: "authority-race-extension",
            }),
        ],
        [
          "revocation",
          (raceDb) =>
            service.revokeApplicantSession(raceDb, fixture.session, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              reason: "Authority race revocation",
            }),
        ],
      ];

      for (const [, invoke] of invocations) {
        authorityDb
          .prepare("UPDATE accounts SET role = 'organizer' WHERE id = ?")
          .run(fixture.accountId);
        const beforeTruth = snapshotO2bTruth(db);
        const beforeAudit = (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count;
        const raceDb = withOneBeforeExec(db, "BEGIN IMMEDIATE", () => {
          authorityDb!
            .prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?")
            .run(fixture.accountId);
        });
        try {
          invoke(raceDb);
          expect.fail("A role demotion before BEGIN must deny the mutation");
        } catch (error) {
          expect(error).toBeInstanceOf(DenialError);
          expect((error as DenialError).code).toBe("CAPABILITY_DENIED");
        }
        expect(
          (
            db.prepare("SELECT role FROM accounts WHERE id = ?").get(
              fixture.accountId,
            ) as { role: string }
          ).role,
        ).toBe("reviewer");
        expect(snapshotO2bTruth(db)).toEqual(beforeTruth);
        expect(
          (
            db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
        ).toBe(beforeAudit + 1);
        expect(
          db
            .prepare(
              `SELECT action, target_type, target_id, details_json
               FROM audit_events ORDER BY rowid DESC LIMIT 1`,
            )
            .get(),
        ).toEqual({
          action: "security.access.denied",
          target_type: "capability",
          target_id: "phase0.pipeline.manage",
          details_json: JSON.stringify({
            capabilityPresent: false,
            code: "CAPABILITY_DENIED",
          }),
        });
      }

      authorityDb
        .prepare(
          "UPDATE accounts SET workspace_id = ?, role = 'organizer' WHERE id = ?",
        )
        .run(fixture.workspaceId, fixture.accountId);
      const foreignWorkspace = db
        .prepare("SELECT id FROM workspaces WHERE id != ? ORDER BY id LIMIT 1")
        .get(fixture.workspaceId) as { id: string };
      const beforeScopeRaceTruth = snapshotO2bTruth(db);
      const beforeScopeRaceAudit = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      const scopeRaceDb = withOneBeforeExec(db, "BEGIN IMMEDIATE", () => {
        authorityDb!
          .prepare("UPDATE accounts SET workspace_id = ? WHERE id = ?")
          .run(foreignWorkspace.id, fixture.accountId);
      });
      expectCfpCode(
        () =>
          service.transitionCallState(scopeRaceDb, fixture.session, {
            callId: fixture.callId,
            expectedState: "OPEN",
            expectedUpdatedAt: lifecycle.updatedAt,
            nextState: "PAUSED",
          }),
        "CALL_NOT_AVAILABLE",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeScopeRaceTruth);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(beforeScopeRaceAudit + 1);
      expect(
        db
          .prepare(
            `SELECT action, target_type, target_id, details_json
             FROM audit_events ORDER BY rowid DESC LIMIT 1`,
          )
          .get(),
      ).toEqual({
        action: "security.access.denied",
        target_type: "cfp_organizer_scope",
        target_id: "call",
        details_json: JSON.stringify({
          scopeValid: false,
          code: "CALL_NOT_AVAILABLE",
        }),
      });
      expect(
        (
          db
            .prepare(
              "SELECT workspace_id FROM audit_events ORDER BY rowid DESC LIMIT 1",
            )
            .get() as { workspace_id: string }
        ).workspace_id,
      ).toBe(foreignWorkspace.id);
    } finally {
      if (authorityDb !== null) closeDb(authorityDb);
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 3C: transaction-time target loss wins over actor drift and audits generically", () => {
    const dbPath = resolve(".tmp/unit", `cfp-organizer-target-race-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    let raceWriter: Db | null = null;
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const deletable = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:05:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "target.race@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const foreignWorkspace = db
        .prepare("SELECT id FROM workspaces WHERE id != ? ORDER BY id LIMIT 1")
        .get(fixture.workspaceId) as { id: string };
      const extensionPersonId = "target-race-extension-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        extensionPersonId,
        fixture.workspaceId,
        "target.race.extension@synthetic.example",
        "Target Race Extension",
        "2026-08-10T00:00:00.000Z",
      );
      const lifecycle = service.readCallLifecycle(
        db,
        deletable.workspaceId,
        deletable.callId,
      );
      raceWriter = openDb({ path: dbPath, seed: false });

      const expectLatestScopeDenial = (
        beforeAuditCount: number,
        targetId: "call" | "applicant_session",
      ): void => {
        expect(
          (
            db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
              count: number;
            }
          ).count,
        ).toBe(beforeAuditCount + 1);
        expect(
          db
            .prepare(
              `SELECT workspace_id, action, target_type, target_id, details_json
               FROM audit_events ORDER BY rowid DESC LIMIT 1`,
            )
            .get(),
        ).toEqual({
          workspace_id: fixture.workspaceId,
          action: "security.access.denied",
          target_type: "cfp_organizer_scope",
          target_id: targetId,
          details_json: JSON.stringify({
            scopeValid: false,
            code: "CALL_NOT_AVAILABLE",
          }),
        });
      };

      let beforeAudit = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      const transitionRaceDb = withOneBeforeExec(db, "BEGIN IMMEDIATE", () => {
        withTransactionOrSavepoint(raceWriter!, "delete_call_and_demote", () => {
          raceWriter!.prepare("DELETE FROM calls WHERE id = ?").run(deletable.callId);
          raceWriter!
            .prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?")
            .run(fixture.accountId);
        });
      });
      expectCfpCode(
        () =>
          service.transitionCallState(transitionRaceDb, fixture.session, {
            callId: deletable.callId,
            expectedState: "OPEN",
            expectedUpdatedAt: lifecycle.updatedAt,
            nextState: "PAUSED",
          }),
        "CALL_NOT_AVAILABLE",
      );
      expect(
        db.prepare("SELECT id FROM calls WHERE id = ?").get(deletable.callId),
      ).toBeUndefined();
      expectLatestScopeDenial(beforeAudit, "call");

      raceWriter!
        .prepare("UPDATE accounts SET role = 'organizer' WHERE id = ?")
        .run(fixture.accountId);
      const extensionCount = (
        db.prepare("SELECT COUNT(*) AS count FROM call_extensions").get() as {
          count: number;
        }
      ).count;
      beforeAudit = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      const extensionRaceDb = withOneBeforeExec(db, "BEGIN IMMEDIATE", () => {
        raceWriter!
          .prepare("UPDATE people SET workspace_id = ? WHERE id = ?")
          .run(foreignWorkspace.id, extensionPersonId);
      });
      expectCfpCode(
        () =>
          service.grantCallExtension(extensionRaceDb, fixture.session, {
            callId: fixture.callId,
            personId: extensionPersonId,
            extendsTo: "2026-08-11T00:00:00.000Z",
            reason: "Target scope race",
            idempotencyKey: "target-scope-race-extension",
          }),
        "CALL_NOT_AVAILABLE",
      );
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM call_extensions").get() as {
            count: number;
          }
        ).count,
      ).toBe(extensionCount);
      expectLatestScopeDenial(beforeAudit, "call");

      beforeAudit = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      const revocationRaceDb = withOneBeforeExec(db, "BEGIN IMMEDIATE", () => {
        raceWriter!
          .prepare("UPDATE people SET workspace_id = ? WHERE id = ?")
          .run(foreignWorkspace.id, applicant.consumed.personId);
      });
      expectCfpCode(
        () =>
          service.revokeApplicantSession(revocationRaceDb, fixture.session, {
            callId: fixture.callId,
            sessionId: applicant.consumed.sessionId,
            reason: "Target session scope race",
          }),
        "CALL_NOT_AVAILABLE",
      );
      expect(
        (
          db
            .prepare("SELECT revoked_at FROM cfp_applicant_sessions WHERE id = ?")
            .get(applicant.consumed.sessionId) as { revoked_at: string | null }
        ).revoked_at,
      ).toBeNull();
      expectLatestScopeDenial(beforeAudit, "applicant_session");
    } finally {
      if (raceWriter !== null) closeDb(raceWriter);
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 3D: supported concurrent call updates retry a split snapshot", () => {
    const dbPath = resolve(".tmp/unit", `cfp-call-snapshot-retry-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    let raceWriter: Db | null = null;
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:05:00.000Z",
      });
      raceWriter = openDb({ path: dbPath, seed: false });
      let raced = false;
      const retryingDb = withNthBeforePrepare(
        db,
        "FROM calls WHERE id = ? OR id = CAST(? AS BLOB)",
        2,
        () => {
          raced = true;
          raceWriter!
            .prepare("UPDATE calls SET state = ?, updated_at = ? WHERE id = ?")
            .run("PAUSED", "2026-08-10T12:01:00.000Z", fixture.callId);
        },
      );
      const auditCount = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;

      expect(
        service.readCallLifecycle(
          retryingDb,
          fixture.workspaceId,
          fixture.callId,
        ),
      ).toEqual({
        state: "PAUSED",
        updatedAt: "2026-08-10T12:01:00.000Z",
      });
      expect(raced).toBe(true);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(auditCount);

      let nonLifecycleFieldRaced = false;
      let nonLifecycleRetryObserved = false;
      const raceNameDb = withNthBeforePrepare(
        withNthBeforePrepare(
          db,
          "FROM calls WHERE id = ? OR id = CAST(? AS BLOB)",
          2,
          () => {
            nonLifecycleFieldRaced = true;
            raceWriter!
              .prepare("UPDATE calls SET name = name || ' revised' WHERE id = ?")
              .run(fixture.callId);
          },
        ),
        "FROM calls WHERE id = ? OR id = CAST(? AS BLOB)",
        4,
        () => {
          nonLifecycleRetryObserved = true;
        },
      );
      expect(
        service.readCallLifecycle(
          raceNameDb,
          fixture.workspaceId,
          fixture.callId,
        ),
      ).toEqual({
        state: "PAUSED",
        updatedAt: "2026-08-10T12:01:00.000Z",
      });
      expect(nonLifecycleFieldRaced).toBe(true);
      expect(nonLifecycleRetryObserved).toBe(true);
      expect(
        (
          db.prepare("SELECT name FROM calls WHERE id = ?").get(fixture.callId) as {
            name: string;
          }
        ).name,
      ).toContain("revised");
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(auditCount);
    } finally {
      if (raceWriter !== null) closeDb(raceWriter);
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 3E: O2A call verification cannot assemble a hybrid dependency snapshot", () => {
    const dbPath = resolve(".tmp/unit", `cfp-call-coherent-o2a-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    let raceWriter: Db | null = null;
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const foreignWorkspace = db
        .prepare("SELECT id FROM workspaces WHERE id != ? ORDER BY id LIMIT 1")
        .get(fixture.workspaceId) as { id: string };
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:05:00.000Z",
      });
      raceWriter = openDb({ path: dbPath, seed: false });

      // S0 has the correct event mirror but a foreign form/rule sealer.
      db.prepare("UPDATE accounts SET workspace_id = ? WHERE id = ?").run(
        foreignWorkspace.id,
        fixture.accountId,
      );
      let dependencySwapRan = false;
      const hybridDb = withNthBeforePrepare(
        db,
        "FROM form_versions f",
        1,
        () => {
          dependencySwapRan = true;
          withTransactionOrSavepoint(raceWriter!, "swap_call_dependencies", () => {
            // S1 restores the sealer but moves the event foreign. Neither S0 nor
            // S1 is a valid complete call graph; an unbracketed multi-read could
            // otherwise combine the valid half of each committed state.
            raceWriter!
              .prepare("UPDATE events SET workspace_id = ? WHERE id = ?")
              .run(foreignWorkspace.id, fixture.eventId);
            raceWriter!
              .prepare("UPDATE accounts SET workspace_id = ? WHERE id = ?")
              .run(fixture.workspaceId, fixture.accountId);
          });
        },
      );
      const auditBefore = snapshotAuditTruth(db);

      expectCfpCode(
        () =>
          service.readCallLifecycle(
            hybridDb,
            fixture.workspaceId,
            fixture.callId,
          ),
        "CALL_NOT_AVAILABLE",
      );
      expect(dependencySwapRan).toBe(true);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);
      expect(
        db
          .prepare(
            `SELECT e.workspace_id AS event_workspace_id,
                    a.workspace_id AS sealer_workspace_id
             FROM calls c
             JOIN events e ON e.id = c.event_id
             JOIN form_versions f ON f.id = c.form_version_id
             JOIN accounts a ON a.id = f.sealed_by
             WHERE c.id = ?`,
          )
          .get(fixture.callId),
      ).toEqual({
        event_workspace_id: foreignWorkspace.id,
        sealer_workspace_id: fixture.workspaceId,
      });
      expectForeignKeysAndTriggersEnabled(db);
    } finally {
      if (raceWriter !== null) closeDb(raceWriter);
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 4A: extension intent identity, scope, rollback, and retention", () => {
    const dbPath = resolve(".tmp/unit", `cfp-extension-complete-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, {
        state: "OPEN",
        closesAt: "2026-08-10T18:00:00.000Z",
      });
      const personId = "extension-complete-person";
      const otherPersonId = "extension-other-person";
      for (const [id, email] of [
        [personId, "extension.complete@synthetic.example"],
        [otherPersonId, "extension.other@synthetic.example"],
      ] as const) {
        db.prepare(
          "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(id, fixture.workspaceId, email, "Extension Person", "2026-08-10T00:00:00.000Z");
      }
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const granted = service.grantCallExtension(db, fixture.session, {
        callId: fixture.callId,
        personId,
        extendsTo: "2026-08-10T20:00:00.000Z",
        reason: "Complete extension intent",
        idempotencyKey: "extension-complete-key",
      });
      expect(granted.replayed).toBe(false);
      const afterFirst = snapshotO2bTruth(db);
      const auditAfterFirst = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      expect(
        service.grantCallExtension(db, fixture.session, {
          callId: fixture.callId,
          personId,
          extendsTo: "2026-08-10T20:00:00.000Z",
          reason: "Complete extension intent",
          idempotencyKey: "extension-complete-key",
        }),
      ).toEqual({ ...granted, replayed: true });
      expect(snapshotO2bTruth(db)).toEqual(afterFirst);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(auditAfterFirst);

      const secondCall = setupFixture(db, {
        state: "OPEN",
        closesAt: "2026-08-10T18:00:00.000Z",
      });
      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "second-extension-organizer",
        fixture.workspaceId,
        "extension.organizer@synthetic.example",
        "Extension Organizer",
        "organizer",
        "2026-08-10T00:00:00.000Z",
      );
      const secondOrganizer = buildOrganizerSession(
        db,
        fixture.workspaceId,
        "second-extension-organizer",
      );
      const mismatchedIntents = [
        {
          session: fixture.session,
          callId: fixture.callId,
          personId,
          extendsTo: "2026-08-10T21:00:00.000Z",
          reason: "Complete extension intent",
        },
        {
          session: fixture.session,
          callId: fixture.callId,
          personId,
          extendsTo: "2026-08-10T20:00:00.000Z",
          reason: "Different extension reason",
        },
        {
          session: fixture.session,
          callId: fixture.callId,
          personId: otherPersonId,
          extendsTo: "2026-08-10T20:00:00.000Z",
          reason: "Complete extension intent",
        },
        {
          session: fixture.session,
          callId: secondCall.callId,
          personId,
          extendsTo: "2026-08-10T20:00:00.000Z",
          reason: "Complete extension intent",
        },
        {
          session: secondOrganizer,
          callId: fixture.callId,
          personId,
          extendsTo: "2026-08-10T20:00:00.000Z",
          reason: "Complete extension intent",
        },
      ];
      for (const mismatch of mismatchedIntents) {
        const before = snapshotO2bTruth(db);
        expectCfpCode(
          () =>
            service.grantCallExtension(db, mismatch.session, {
              callId: mismatch.callId,
              personId: mismatch.personId,
              extendsTo: mismatch.extendsTo,
              reason: mismatch.reason,
              idempotencyKey: "extension-complete-key",
            }),
          "EXTENSION_IDEMPOTENCY_CONFLICT",
        );
        expect(snapshotO2bTruth(db)).toEqual(before);
      }

      for (const [extendsTo, key] of [
        ["2026-08-10T20:00:00.000Z", "extension-equal-key"],
        ["2026-08-10T19:59:59.999Z", "extension-shorter-key"],
        ["2026-08-10T18:00:00.000Z", "extension-at-close-key"],
        ["2026-08-10T12:00:00.000Z", "extension-at-now-key"],
      ] as const) {
        const before = snapshotO2bTruth(db);
        expectCfpCode(
          () =>
            service.grantCallExtension(db, fixture.session, {
              callId: fixture.callId,
              personId,
              extendsTo,
              reason: "Rejected extension boundary",
              idempotencyKey: key,
            }),
          "EXTENSION_INVALID",
        );
        expect(snapshotO2bTruth(db)).toEqual(before);
      }

      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T20:00:00.000Z",
          }).grantCallExtension(db, fixture.session, {
            callId: fixture.callId,
            personId,
            extendsTo: "2026-08-10T20:00:00.000Z",
            reason: "Complete extension intent",
            idempotencyKey: "extension-complete-key",
          }),
        "EXTENSION_INVALID",
      );

      const beforeAuditFailure = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T12:00:00.000Z",
            auditWriter: () => {
              throw new Error("synthetic audit failure");
            },
          }).grantCallExtension(db, fixture.session, {
            callId: fixture.callId,
            personId,
            extendsTo: "2026-08-10T21:00:00.000Z",
            reason: "Must roll back with audit",
            idempotencyKey: "extension-audit-rollback",
          }),
        "ACCESS_WRITE_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeAuditFailure);

      const assertScopeDenial = (
        session: SessionInfo,
        callId: string,
        targetPersonId: string,
      ): void => {
        const before = snapshotO2bTruth(db);
        const beforeAudit = (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count;
        expectCfpCode(
          () =>
            service.grantCallExtension(db, session, {
              callId,
              personId: targetPersonId,
              extendsTo: "2026-08-10T21:00:00.000Z",
              reason: "Scope denial",
              idempotencyKey: `scope-${beforeAudit}`,
            }),
          "CALL_NOT_AVAILABLE",
        );
        expect(snapshotO2bTruth(db)).toEqual(before);
        expect(
          (
            db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
              count: number;
            }
          ).count,
        ).toBe(beforeAudit + 1);
      };
      assertScopeDenial(fixture.session, "missing-extension-call", personId);
      assertScopeDenial(fixture.session, fixture.callId, "missing-extension-person");
      assertScopeDenial(
        { ...fixture.session, accountId: "missing-extension-account" },
        fixture.callId,
        personId,
      );
      assertScopeDenial(
        {
          ...fixture.session,
          accountId: "missing-noncap-extension-account",
          role: "read_only",
        },
        fixture.callId,
        personId,
      );

      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "extension-reviewer-account",
        fixture.workspaceId,
        "extension.reviewer@synthetic.example",
        "Extension Reviewer",
        "reviewer",
        "2026-08-10T00:00:00.000Z",
      );
      const extensionReviewer = buildOrganizerSession(
        db,
        fixture.workspaceId,
        "extension-reviewer-account",
      );
      const beforeCapabilityDenial = snapshotO2bTruth(db);
      const capabilityAuditBefore = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      try {
        service.grantCallExtension(db, extensionReviewer, {
          callId: fixture.callId,
          personId,
          extendsTo: "2026-08-10T21:00:00.000Z",
          reason: "Capability denial extension",
          idempotencyKey: "extension-reviewer-denial",
        });
        expect.fail("Stored reviewer extension must retain CAPABILITY_DENIED");
      } catch (error) {
        expect(error).toBeInstanceOf(DenialError);
        expect((error as DenialError).code).toBe("CAPABILITY_DENIED");
      }
      expect(snapshotO2bTruth(db)).toEqual(beforeCapabilityDenial);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(capabilityAuditBefore + 1);

      db.prepare(
        `INSERT INTO call_extensions
           (id, workspace_id, call_id, person_id, extends_to, reason, granted_by, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "future-extension-row",
        fixture.workspaceId,
        secondCall.callId,
        otherPersonId,
        "2026-08-10T21:00:00.000Z",
        "Future extension must not authorize early",
        fixture.accountId,
        "future-extension-key",
        "2026-08-10T20:00:00.000Z",
      );
      const beforeFutureExtension = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T19:00:00.000Z",
          }).issueEmailVerification(
            db,
            { workspaceId: secondCall.workspaceId },
            {
              callId: secondCall.callId,
              email: "extension.other@synthetic.example",
              tokenHash: HEX_64_A,
            },
          ),
        "ACCESS_READ_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeFutureExtension);

      db.prepare(
        `INSERT INTO call_extensions
           (id, workspace_id, call_id, person_id, extends_to, reason, granted_by, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "short-corrupt-extension-row",
        fixture.workspaceId,
        fixture.callId,
        personId,
        "2026-08-10T17:00:00.000Z",
        "Short row must poison extension selection",
        fixture.accountId,
        "short-corrupt-extension-key",
        "2026-08-10T12:00:00.000Z",
      );
      const beforeShortExtension = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T19:00:00.000Z",
          }).issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: "extension.complete@synthetic.example",
              tokenHash: HEX_64_B,
            },
          ),
        "ACCESS_READ_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeShortExtension);

      expect(() =>
        db
          .prepare("UPDATE call_extensions SET reason = ? WHERE id = ?")
          .run("Mutated", granted.extensionId),
      ).toThrow();
      expect(() =>
        db.prepare("DELETE FROM call_extensions WHERE id = ?").run(granted.extensionId),
      ).toThrow();

      db.prepare(
        `INSERT INTO call_extensions
           (id, workspace_id, call_id, person_id, extends_to, reason, granted_by, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "malformed-extension-row",
        fixture.workspaceId,
        fixture.callId,
        personId,
        "2026-08-11T00:00:00+00:00",
        "Malformed timestamp row",
        fixture.accountId,
        "malformed-extension-key",
        "2026-08-10T12:00:00.000Z",
      );
      const beforeMalformedRead = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.grantCallExtension(db, fixture.session, {
            callId: fixture.callId,
            personId,
            extendsTo: "2026-08-11T01:00:00.000Z",
            reason: "Malformed row must fail closed",
            idempotencyKey: "after-malformed-extension",
          }),
        "ACCESS_READ_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeMalformedRead);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 4B: workspace idempotency rejects a BLOB/TEXT alias across targets", () => {
    const dbPath = resolve(".tmp/unit", `cfp-extension-blob-idempotency-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const first = setupFixture(db, { state: "OPEN" });
      const second = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const firstPerson = "blob-idempotency-first-person";
      const secondPerson = "blob-idempotency-second-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      ).run(
        firstPerson,
        first.workspaceId,
        "blob.idempotency.first@synthetic.example",
        "Blob Idempotency First",
        "2026-08-10T00:00:00.000Z",
        secondPerson,
        second.workspaceId,
        "blob.idempotency.second@synthetic.example",
        "Blob Idempotency Second",
        "2026-08-10T00:00:00.000Z",
      );
      const aliasedKey = "workspace-global-blob-key";
      db.prepare(
        `INSERT INTO call_extensions
           (id, workspace_id, call_id, person_id, extends_to, reason,
            granted_by, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "blob-idempotency-extension",
        first.workspaceId,
        first.callId,
        firstPerson,
        "2026-08-11T00:00:00.000Z",
        "Retained BLOB idempotency evidence",
        first.accountId,
        Buffer.from(aliasedKey, "utf8"),
        "2026-08-10T12:00:00.000Z",
      );
      expect(
        db
          .prepare(
            "SELECT typeof(idempotency_key) AS storage FROM call_extensions WHERE id = ?",
          )
          .get("blob-idempotency-extension"),
      ).toEqual({ storage: "blob" });

      const before = snapshotO2bTruth(db);
      const auditCount = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      expectCfpCode(
        () =>
          service.grantCallExtension(db, second.session, {
            callId: second.callId,
            personId: secondPerson,
            extendsTo: "2026-08-11T01:00:00.000Z",
            reason: "Must not create a TEXT twin",
            idempotencyKey: aliasedKey,
          }),
        "ACCESS_READ_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(before);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(auditCount);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 5A: issuance expiry, consumption retention, corruption, and replay ordering", () => {
    const dbPath = resolve(".tmp/unit", `cfp-issuance-complete-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
        verificationTtlMs: 60_000,
      });
      const publicCall = setupFixture(db, { accessMode: "PUBLIC", state: "OPEN" });
      const hybridCall = setupFixture(db, {
        accessMode: "PUBLIC_AND_INVITED",
        state: "OPEN",
      });
      const invitedCall = setupFixture(db, { accessMode: "INVITED", state: "OPEN" });

      expect(
        service.issueEmailVerification(
          db,
          { workspaceId: hybridCall.workspaceId },
          {
            callId: hybridCall.callId,
            email: "hybrid.issue@synthetic.example",
            tokenHash: HEX_64_A,
          },
        ).replayed,
      ).toBe(false);

      const invitedPerson = "invited-extension-person";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        invitedPerson,
        invitedCall.workspaceId,
        "invited.extension@synthetic.example",
        "Invited Extension Person",
        "2026-08-10T00:00:00.000Z",
      );
      service.grantCallExtension(db, invitedCall.session, {
        callId: invitedCall.callId,
        personId: invitedPerson,
        extendsTo: "2026-08-11T00:00:00.000Z",
        reason: "Access mode remains authoritative",
        idempotencyKey: "invited-mode-extension",
      });
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: invitedCall.workspaceId },
            {
              callId: invitedCall.callId,
              email: "invited.extension@synthetic.example",
              tokenHash: HEX_64_B,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );

      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: publicCall.workspaceId },
            {
              callId: "unknown-call-id",
              email: "unknown.call@synthetic.example",
              tokenHash: HEX_64_A,
            },
          ),
        "CALL_NOT_AVAILABLE",
      );

      for (const badDigest of [HEX_64_B.toUpperCase(), "abcd", `${HEX_64_A}0`]) {
        expectCfpCode(
          () =>
            service.issueEmailVerification(
              db,
              { workspaceId: publicCall.workspaceId },
              {
                callId: publicCall.callId,
                email: "malformed.digest@synthetic.example",
                tokenHash: badDigest,
              },
            ),
          "VERIFICATION_REQUEST_REJECTED",
        );
      }

      const active = service.issueEmailVerification(
        db,
        { workspaceId: publicCall.workspaceId },
        {
          callId: publicCall.callId,
          email: " Replay.User@Synthetic.Example ",
          tokenHash: HEX_64_A,
        },
      );
      const verificationReplacement = service.issueEmailVerification(
        db,
        { workspaceId: publicCall.workspaceId },
        {
          callId: publicCall.callId,
          email: "replay.user@synthetic.example",
          tokenHash: HEX_64_B,
        },
      );
      expect(verificationReplacement.replayed).toBe(false);
      expect(verificationReplacement.verificationId).not.toBe(active.verificationId);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: publicCall.workspaceId },
            {
              callId: publicCall.callId,
              email: "replay.user@synthetic.example",
              tokenHash: HEX_64_A,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );

      const siblingConflictCall = setupFixture(db, { state: "OPEN" });
      for (const [id, tokenHash, issuanceSequence] of [
        ["active-sibling-verification-a", HEX_64_A, 1],
        ["active-sibling-verification-b", HEX_64_B, 2],
      ] as const) {
        db.prepare(
          `INSERT INTO cfp_email_verifications
             (id, workspace_id, call_id, email, token_hash, expires_at, created_at,
              issuance_sequence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          siblingConflictCall.workspaceId,
          siblingConflictCall.callId,
          "active.sibling@synthetic.example",
          tokenHash,
          "2026-08-10T13:00:00.000Z",
          "2026-08-10T11:00:00.000Z",
          issuanceSequence,
        );
      }
      const beforeSiblingConflict = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: siblingConflictCall.workspaceId },
            {
              callId: siblingConflictCall.callId,
              email: "active.sibling@synthetic.example",
              tokenHash: HEX_64_A,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeSiblingConflict);

      const futureReplayCall = setupFixture(db, { state: "OPEN" });
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at,
            issuance_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "future-replay-verification",
        futureReplayCall.workspaceId,
        futureReplayCall.callId,
        "future.replay@synthetic.example",
        HEX_64_J,
        "2026-08-10T14:00:00.000Z",
        "2026-08-10T13:00:00.000Z",
        1,
      );
      const beforeFutureReplay = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: futureReplayCall.workspaceId },
            {
              callId: futureReplayCall.callId,
              email: "future.replay@synthetic.example",
              tokenHash: HEX_64_J,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeFutureReplay);

      const futureCall = setupFixture(db, {
        state: "OPEN",
        createdAt: "2026-08-10T13:00:00.000Z",
      });
      const beforeFutureCall = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: futureCall.workspaceId },
            {
              callId: futureCall.callId,
              email: "future.call@synthetic.example",
              tokenHash: HEX_64_K,
            },
          ),
        "CALL_NOT_AVAILABLE",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeFutureCall);

      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "pre-call-verification",
        futureCall.workspaceId,
        futureCall.callId,
        "future.call@synthetic.example",
        HEX_64_K,
        "2026-08-10T15:00:00.000Z",
        "2026-08-10T12:00:00.000Z",
      );
      const beforePreCallReplay = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T14:00:00.000Z",
          }).issueEmailVerification(
            db,
            { workspaceId: futureCall.workspaceId },
            {
              callId: futureCall.callId,
              email: "future.call@synthetic.example",
              tokenHash: HEX_64_K,
            },
          ),
        "ACCESS_READ_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforePreCallReplay);

      db.prepare("UPDATE calls SET state = 'ARCHIVED' WHERE id = ?").run(publicCall.callId);
      expect(
        service.issueEmailVerification(
          db,
          { workspaceId: publicCall.workspaceId },
          {
            callId: publicCall.callId,
            email: "replay.user@synthetic.example",
            tokenHash: HEX_64_B,
          },
        ),
      ).toEqual({ ...verificationReplacement, replayed: true });
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: publicCall.workspaceId },
            {
              callId: publicCall.callId,
              email: "replay.user@synthetic.example",
              tokenHash: HEX_64_C,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );

      const expiryCall = setupFixture(db, { state: "OPEN" });
      const expiring = service.issueEmailVerification(
        db,
        { workspaceId: expiryCall.workspaceId },
        {
          callId: expiryCall.callId,
          email: "expiry.issue@synthetic.example",
          tokenHash: HEX_64_A,
        },
      );
      expect(expiring.expiresAt).toBe("2026-08-10T12:01:00.000Z");
      const atExpiry = createCfpApplicantAccess({
        now: () => "2026-08-10T12:01:00.000Z",
        verificationTtlMs: 60_000,
      });
      expectCfpCode(
        () =>
          atExpiry.issueEmailVerification(
            db,
            { workspaceId: expiryCall.workspaceId },
            {
              callId: expiryCall.callId,
              email: "expiry.issue@synthetic.example",
              tokenHash: HEX_64_A,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      const afterExpiry = atExpiry.issueEmailVerification(
        db,
        { workspaceId: expiryCall.workspaceId },
        {
          callId: expiryCall.callId,
          email: "expiry.issue@synthetic.example",
          tokenHash: HEX_64_B,
        },
      );
      expect(afterExpiry.replayed).toBe(false);
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM cfp_email_verifications WHERE call_id = ? AND email = ?",
            )
            .get(expiryCall.callId, "expiry.issue@synthetic.example") as {
            count: number;
          }
        ).count,
      ).toBe(2);

      const consumedCall = setupFixture(db, { state: "OPEN" });
      const consumedIdentity = issueAndConsume(
        service,
        db,
        consumedCall,
        "consumed.issue@synthetic.example",
        HEX_64_C,
        HEX_64_H,
      );
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: consumedCall.workspaceId },
            {
              callId: consumedCall.callId,
              email: "consumed.issue@synthetic.example",
              tokenHash: HEX_64_C,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      const replacement = service.issueEmailVerification(
        db,
        { workspaceId: consumedCall.workspaceId },
        {
          callId: consumedCall.callId,
          email: "consumed.issue@synthetic.example",
          tokenHash: HEX_64_D,
        },
      );
      expect(replacement.replayed).toBe(false);
      expect(replacement.verificationId).not.toBe(consumedIdentity.issued.verificationId);

      db.prepare(
        "INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
      ).run(
        "issuance-corrupt-foreign-workspace",
        "issuance-corrupt-foreign",
        "Issuance Corrupt Foreign",
        "2026-08-10T00:00:00.000Z",
      );
      const afterConsumptionService = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.010Z",
        verificationTtlMs: 60_000,
      });
      const assertConsumedIdentityCorruption = (
        suffix: string,
        verificationDigest: string,
        sessionDigest: string,
        replacementDigest: string,
        corruptPerson: (personId: string) => void,
      ): void => {
        const corruptCall = setupFixture(db, { state: "OPEN" });
        const email = `issuance.${suffix}@synthetic.example`;
        const identity = issueAndConsume(
          service,
          db,
          corruptCall,
          email,
          verificationDigest,
          sessionDigest,
        );
        corruptPerson(identity.consumed.personId);
        const before = snapshotO2bTruth(db);
        expectCfpCode(
          () =>
            afterConsumptionService.issueEmailVerification(
              db,
              { workspaceId: corruptCall.workspaceId },
              {
                callId: corruptCall.callId,
                email,
                tokenHash: replacementDigest,
              },
            ),
          "ACCESS_READ_FAILED",
        );
        expect(snapshotO2bTruth(db)).toEqual(before);
      };
      assertConsumedIdentityCorruption(
        "person-email-mirror",
        HEX_64_A,
        HEX_64_F,
        HEX_64_D,
        (personId) => {
          db.prepare("UPDATE people SET canonical_email = ? WHERE id = ?").run(
            "different.issuance.mirror@synthetic.example",
            personId,
          );
        },
      );
      assertConsumedIdentityCorruption(
        "person-chronology",
        HEX_64_B,
        HEX_64_G,
        HEX_64_E,
        (personId) => {
          db.prepare("UPDATE people SET created_at = ? WHERE id = ?").run(
            "2026-08-10T12:00:00.001Z",
            personId,
          );
        },
      );
      assertConsumedIdentityCorruption(
        "person-workspace-mirror",
        HEX_64_C,
        HEX_64_I,
        HEX_64_J,
        (personId) => {
          db.prepare("UPDATE people SET workspace_id = ? WHERE id = ?").run(
            "issuance-corrupt-foreign-workspace",
            personId,
          );
        },
      );

      for (const [email, tokenHash, expiresAt] of [
        ["stored.offset@synthetic.example", HEX_64_A, "2026-08-10T13:00:00+00:00"],
        ["Stored.Upper@synthetic.example", HEX_64_B, "2026-08-10T13:00:00.000Z"],
        ["stored.short@synthetic.example", "abcd", "2026-08-10T13:00:00.000Z"],
      ] as const) {
        db.prepare(
          `INSERT INTO cfp_email_verifications
             (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `malformed-issuance-${tokenHash.slice(0, 8)}-${email.slice(0, 6)}`,
          expiryCall.workspaceId,
          expiryCall.callId,
          email,
          tokenHash,
          expiresAt,
          "2026-08-10T11:00:00.000Z",
        );
        const normalizedEmail = email.toLowerCase();
        const before = snapshotO2bTruth(db);
        expectCfpCode(
          () =>
            service.issueEmailVerification(
              db,
              { workspaceId: expiryCall.workspaceId },
              {
                callId: expiryCall.callId,
                email: normalizedEmail,
                tokenHash: HEX_64_E,
              },
            ),
          "ACCESS_READ_FAILED",
        );
        expect(snapshotO2bTruth(db)).toEqual(before);
      }

      for (const badNow of [
        "2026-08-10T12:00:00+00:00",
        "2026-08-10",
        "invalid-now",
      ]) {
        const before = snapshotO2bTruth(db);
        expectCfpCode(
          () =>
            createCfpApplicantAccess({ now: () => badNow }).issueEmailVerification(
              db,
              { workspaceId: hybridCall.workspaceId },
              {
                callId: hybridCall.callId,
                email: `bad-now-${badNow.length}@synthetic.example`,
                tokenHash: HEX_64_I,
              },
            ),
          "ACCESS_INPUT_INVALID",
        );
        expect(snapshotO2bTruth(db)).toEqual(before);
      }
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 6A: consume identity mirrors, ambiguity, incomplete pairs, and rollback", () => {
    const dbPath = resolve(".tmp/unit", `cfp-consume-complete-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const atNoon = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const atFivePast = createCfpApplicantAccess({
        now: () => "2026-08-10T12:05:00.000Z",
      });

      const reuseCall = setupFixture(db, { state: "OPEN" });
      const reusePerson = "consume-reuse-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, organization, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        reusePerson,
        reuseCall.workspaceId,
        "consume.reuse@synthetic.example",
        "Original Profile Name",
        "Original Organization",
        "Original Title",
        "2026-08-09T00:00:00.000Z",
      );
      const profileBefore = db
        .prepare("SELECT * FROM people WHERE id = ?")
        .get(reusePerson);
      const reuseIssued = atNoon.issueEmailVerification(
        db,
        { workspaceId: reuseCall.workspaceId },
        {
          callId: reuseCall.callId,
          email: "consume.reuse@synthetic.example",
          tokenHash: HEX_64_A,
        },
      );
      const reuseConsumed = atNoon.consumeEmailVerification(
        db,
        { workspaceId: reuseCall.workspaceId },
        {
          callId: reuseCall.callId,
          verificationId: reuseIssued.verificationId,
          verificationTokenHash: HEX_64_A,
          applicantSessionTokenHash: HEX_64_F,
          fullName: "Replacement Profile Name",
        },
      );
      expect(reuseConsumed.personId).toBe(reusePerson);
      expect(db.prepare("SELECT * FROM people WHERE id = ?").get(reusePerson)).toEqual(
        profileBefore,
      );
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM cfp_email_verification_consumptions WHERE verification_id = ?",
            )
            .get(reuseIssued.verificationId) as { count: number }
        ).count,
      ).toBe(1);

      const futurePersonCall = setupFixture(db, { state: "OPEN" });
      const futurePersonIssue = atNoon.issueEmailVerification(
        db,
        { workspaceId: futurePersonCall.workspaceId },
        {
          callId: futurePersonCall.callId,
          email: "future.person@synthetic.example",
          tokenHash: HEX_64_J,
        },
      );
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "future-consume-person",
        futurePersonCall.workspaceId,
        "future.person@synthetic.example",
        "Future Person",
        "2026-08-10T13:00:00.000Z",
      );
      const beforeFuturePersonConsume = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          atNoon.consumeEmailVerification(
            db,
            { workspaceId: futurePersonCall.workspaceId },
            {
              callId: futurePersonCall.callId,
              verificationId: futurePersonIssue.verificationId,
              verificationTokenHash: HEX_64_J,
              applicantSessionTokenHash: HEX_64_L,
              fullName: "Future Person",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeFuturePersonConsume);

      db.prepare("UPDATE calls SET state = 'ARCHIVED', access_mode = 'INVITED' WHERE id = ?").run(
        reuseCall.callId,
      );
      const replayTruth = snapshotO2bTruth(db);
      const replay = atFivePast.consumeEmailVerification(
        db,
        { workspaceId: reuseCall.workspaceId },
        {
          callId: reuseCall.callId,
          verificationId: reuseIssued.verificationId,
          verificationTokenHash: HEX_64_A,
          applicantSessionTokenHash: HEX_64_F,
          fullName: "Ignored Replay Name",
        },
      );
      expect(replay).toEqual({ ...reuseConsumed, replayed: true });
      expect(snapshotO2bTruth(db)).toEqual(replayTruth);
      expectCfpCode(
        () =>
          atFivePast.consumeEmailVerification(
            db,
            { workspaceId: reuseCall.workspaceId },
            {
              callId: reuseCall.callId,
              verificationId: reuseIssued.verificationId,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Different Digest",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(replayTruth);

      const expiringCall = setupFixture(db, { state: "OPEN" });
      const shortLived = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
        verificationTtlMs: 60_000,
      }).issueEmailVerification(
        db,
        { workspaceId: expiringCall.workspaceId },
        {
          callId: expiringCall.callId,
          email: "consume.expiry@synthetic.example",
          tokenHash: HEX_64_B,
        },
      );
      const beforeExpiredConsume = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T12:01:00.000Z",
          }).consumeEmailVerification(
            db,
            { workspaceId: expiringCall.workspaceId },
            {
              callId: expiringCall.callId,
              verificationId: shortLived.verificationId,
              verificationTokenHash: HEX_64_B,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Expired Consume",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeExpiredConsume);

      const scopedCall = setupFixture(db, { state: "OPEN" });
      const otherCall = setupFixture(db, { state: "OPEN" });
      const scopedIssue = atNoon.issueEmailVerification(
        db,
        { workspaceId: scopedCall.workspaceId },
        {
          callId: scopedCall.callId,
          email: "consume.scope@synthetic.example",
          tokenHash: HEX_64_C,
        },
      );
      const scopedTruth = snapshotO2bTruth(db);
      for (const attempt of [
        () =>
          atNoon.consumeEmailVerification(
            db,
            { workspaceId: scopedCall.workspaceId },
            {
              callId: otherCall.callId,
              verificationId: scopedIssue.verificationId,
              verificationTokenHash: HEX_64_C,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Wrong Call",
            },
          ),
        () =>
          atNoon.consumeEmailVerification(
            db,
            { workspaceId: "foreign-consume-workspace" },
            {
              callId: scopedCall.callId,
              verificationId: scopedIssue.verificationId,
              verificationTokenHash: HEX_64_C,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Wrong Workspace",
            },
          ),
        () =>
          atNoon.consumeEmailVerification(
            db,
            { workspaceId: scopedCall.workspaceId },
            {
              callId: scopedCall.callId,
              verificationId: scopedIssue.verificationId,
              verificationTokenHash: HEX_64_D,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Wrong Verification Digest",
            },
          ),
      ]) {
        expectCfpCode(attempt, "VERIFICATION_INVALID");
        expect(snapshotO2bTruth(db)).toEqual(scopedTruth);
      }

      const ambiguousCall = setupFixture(db, { state: "OPEN" });
      const ambiguousIssue = atNoon.issueEmailVerification(
        db,
        { workspaceId: ambiguousCall.workspaceId },
        {
          callId: ambiguousCall.callId,
          email: "ambiguous.person@synthetic.example",
          tokenHash: HEX_64_D,
        },
      );
      for (const [id, email] of [
        ["ambiguous-person-lower", "ambiguous.person@synthetic.example"],
        ["ambiguous-person-upper", "AMBIGUOUS.PERSON@SYNTHETIC.EXAMPLE"],
      ] as const) {
        db.prepare(
          "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(id, ambiguousCall.workspaceId, email, "Ambiguous Person", "2026-08-10T00:00:00.000Z");
      }
      const ambiguousTruth = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          atNoon.consumeEmailVerification(
            db,
            { workspaceId: ambiguousCall.workspaceId },
            {
              callId: ambiguousCall.callId,
              verificationId: ambiguousIssue.verificationId,
              verificationTokenHash: HEX_64_D,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Ambiguous Person",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(ambiguousTruth);

      const collisionCall = setupFixture(db, { state: "OPEN" });
      const collisionIssue = atNoon.issueEmailVerification(
        db,
        { workspaceId: collisionCall.workspaceId },
        {
          callId: collisionCall.callId,
          email: "session.collision@synthetic.example",
          tokenHash: HEX_64_E,
        },
      );
      const collisionTruth = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          atNoon.consumeEmailVerification(
            db,
            { workspaceId: collisionCall.workspaceId },
            {
              callId: collisionCall.callId,
              verificationId: collisionIssue.verificationId,
              verificationTokenHash: HEX_64_E,
              applicantSessionTokenHash: HEX_64_F,
              fullName: "Session Collision",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(collisionTruth);

      const incompleteCall = setupFixture(db, { state: "OPEN" });
      const incompleteEmail = "incomplete.pair@synthetic.example";
      const incompleteIssue = atNoon.issueEmailVerification(
        db,
        { workspaceId: incompleteCall.workspaceId },
        {
          callId: incompleteCall.callId,
          email: incompleteEmail,
          tokenHash: HEX_64_A,
        },
      );
      const incompletePerson = "incomplete-pair-person";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        incompletePerson,
        incompleteCall.workspaceId,
        incompleteEmail,
        "Incomplete Pair",
        "2026-08-10T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "incomplete-consumption",
        incompleteCall.workspaceId,
        incompleteIssue.verificationId,
        incompletePerson,
        "2026-08-10T12:05:00.000Z",
      );
      const incompleteTruth = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          atFivePast.consumeEmailVerification(
            db,
            { workspaceId: incompleteCall.workspaceId },
            {
              callId: incompleteCall.callId,
              verificationId: incompleteIssue.verificationId,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_I,
              fullName: "Incomplete Pair",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(incompleteTruth);

      const orphanCall = setupFixture(db, { state: "OPEN" });
      const orphanEmail = "orphan.session@synthetic.example";
      const orphanIssue = atNoon.issueEmailVerification(
        db,
        { workspaceId: orphanCall.workspaceId },
        { callId: orphanCall.callId, email: orphanEmail, tokenHash: HEX_64_B },
      );
      const orphanPerson = "orphan-session-person";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        orphanPerson,
        orphanCall.workspaceId,
        orphanEmail,
        "Orphan Session",
        "2026-08-10T00:00:00.000Z",
      );
      db.exec("DROP TRIGGER trg_cfp_applicant_sessions_workspace_guard");
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "orphan-applicant-session",
        orphanCall.workspaceId,
        orphanCall.callId,
        orphanPerson,
        orphanIssue.verificationId,
        HEX_64_I,
        "2026-08-10T12:05:00.000Z",
        "2026-08-20T12:05:00.000Z",
      );
      const orphanTruth = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          atFivePast.consumeEmailVerification(
            db,
            { workspaceId: orphanCall.workspaceId },
            {
              callId: orphanCall.callId,
              verificationId: orphanIssue.verificationId,
              verificationTokenHash: HEX_64_B,
              applicantSessionTokenHash: HEX_64_I,
              fullName: "Orphan Session",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(orphanTruth);

      const mirrorCall = setupFixture(db, { state: "OPEN" });
      const mirrorIssue = atNoon.issueEmailVerification(
        db,
        { workspaceId: mirrorCall.workspaceId },
        {
          callId: mirrorCall.callId,
          email: "verification.mirror@synthetic.example",
          tokenHash: HEX_64_C,
        },
      );
      const wrongMirrorPerson = "wrong-mirror-person";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        wrongMirrorPerson,
        mirrorCall.workspaceId,
        "different.mirror@synthetic.example",
        "Wrong Mirror",
        "2026-08-10T00:00:00.000Z",
      );
      db.exec("DROP TRIGGER trg_cfp_email_verification_consumptions_workspace_guard");
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "wrong-mirror-consumption",
        mirrorCall.workspaceId,
        mirrorIssue.verificationId,
        wrongMirrorPerson,
        "2026-08-10T12:05:00.000Z",
      );
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "wrong-mirror-session",
        mirrorCall.workspaceId,
        mirrorCall.callId,
        wrongMirrorPerson,
        mirrorIssue.verificationId,
        HEX_64_K,
        "2026-08-10T12:05:00.000Z",
        "2026-08-20T12:05:00.000Z",
      );
      const mirrorTruth = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          atFivePast.consumeEmailVerification(
            db,
            { workspaceId: mirrorCall.workspaceId },
            {
              callId: mirrorCall.callId,
              verificationId: mirrorIssue.verificationId,
              verificationTokenHash: HEX_64_C,
              applicantSessionTokenHash: HEX_64_K,
              fullName: "Wrong Mirror",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(mirrorTruth);

      const rollbackCall = setupFixture(db, { state: "OPEN" });
      const rollbackIssue = atNoon.issueEmailVerification(
        db,
        { workspaceId: rollbackCall.workspaceId },
        {
          callId: rollbackCall.callId,
          email: "consume.rollback@synthetic.example",
          tokenHash: HEX_64_D,
        },
      );
      const rollbackTruth = snapshotO2bTruth(db);
      const rollbackIds = [
        "rollback-created-person",
        "rollback-created-consumption",
        reuseConsumed.sessionId,
      ] as const;
      let rollbackIdIndex = 0;
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T12:05:00.000Z",
            id: () => rollbackIds[rollbackIdIndex++] ?? "unexpected-rollback-id",
          }).consumeEmailVerification(
            db,
            { workspaceId: rollbackCall.workspaceId },
            {
              callId: rollbackCall.callId,
              verificationId: rollbackIssue.verificationId,
              verificationTokenHash: HEX_64_D,
              applicantSessionTokenHash: HEX_64_L,
              fullName: "Must Roll Back",
            },
          ),
        "ACCESS_WRITE_FAILED",
      );
      expect(rollbackIdIndex).toBe(3);
      expect(snapshotO2bTruth(db)).toEqual(rollbackTruth);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 7A: resolution mirrors, exact expiry, duplicate hashes, and revoke CAS", () => {
    const dbPath = resolve(".tmp/unit", `cfp-session-complete-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const otherCall = setupFixture(db, { state: "OPEN" });
      const atNoon = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const first = issueAndConsume(
        atNoon,
        db,
        fixture,
        "resolve.first@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const second = issueAndConsume(
        atNoon,
        db,
        fixture,
        "resolve.second@synthetic.example",
        HEX_64_B,
        HEX_64_G,
      );

      const resolved = atNoon.resolveApplicantSession(db, {
        workspaceId: fixture.workspaceId,
        callId: fixture.callId,
        sessionTokenHash: HEX_64_G,
      });
      expect(resolved.context.sessionId).toBe(second.consumed.sessionId);
      expect(resolved.personId).toBe(second.consumed.personId);

      for (const input of [
        {
          workspaceId: "wrong-resolution-workspace",
          callId: fixture.callId,
          sessionTokenHash: HEX_64_G,
        },
        {
          workspaceId: fixture.workspaceId,
          callId: otherCall.callId,
          sessionTokenHash: HEX_64_G,
        },
        {
          workspaceId: fixture.workspaceId,
          callId: fixture.callId,
          sessionTokenHash: HEX_64_H,
        },
        {
          workspaceId: fixture.workspaceId,
          callId: fixture.callId,
          sessionTokenHash: "x".repeat(129),
        },
      ]) {
        expectCfpCode(
          () => atNoon.resolveApplicantSession(db, input),
          "SESSION_INVALID",
        );
      }

      expect(
        createCfpApplicantAccess({
          now: () => "2026-08-24T11:59:59.999Z",
        }).resolveApplicantSession(db, {
          workspaceId: fixture.workspaceId,
          callId: fixture.callId,
          sessionTokenHash: HEX_64_G,
        }).context.sessionId,
      ).toBe(second.consumed.sessionId);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-24T12:00:00.000Z",
          }).resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );

      const originalPersonEmail = "resolve.second@synthetic.example";
      db.prepare("UPDATE people SET canonical_email = ? WHERE id = ?").run(
        "different.resolve@synthetic.example",
        second.consumed.personId,
      );
      expectCfpCode(
        () =>
          atNoon.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );
      db.prepare("UPDATE people SET canonical_email = ? WHERE id = ?").run(
        originalPersonEmail,
        second.consumed.personId,
      );

      const originalPersonCreatedAt = (
        db.prepare("SELECT created_at FROM people WHERE id = ?").get(
          second.consumed.personId,
        ) as { created_at: string }
      ).created_at;
      db.prepare("UPDATE people SET created_at = ? WHERE id = ?").run(
        "2026-08-10T12:06:00.000Z",
        second.consumed.personId,
      );
      expectCfpCode(
        () =>
          atNoon.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );
      db.prepare("UPDATE people SET created_at = ? WHERE id = ?").run(
        originalPersonCreatedAt,
        second.consumed.personId,
      );

      db.exec("DROP TRIGGER trg_cfp_email_verifications_immutable");
      db.prepare("UPDATE cfp_email_verifications SET email = ? WHERE id = ?").run(
        "Resolve.Second@Synthetic.Example",
        second.issued.verificationId,
      );
      expectCfpCode(
        () =>
          atNoon.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );
      db.prepare("UPDATE cfp_email_verifications SET email = ? WHERE id = ?").run(
        originalPersonEmail,
        second.issued.verificationId,
      );

      const wrongPerson = "resolution-wrong-person";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        wrongPerson,
        fixture.workspaceId,
        "resolution.wrong@synthetic.example",
        "Resolution Wrong Person",
        "2026-08-10T00:00:00.000Z",
      );
      db.exec("DROP TRIGGER trg_cfp_email_verification_consumptions_immutable");
      db.prepare(
        "UPDATE cfp_email_verification_consumptions SET person_id = ? WHERE verification_id = ?",
      ).run(wrongPerson, second.issued.verificationId);
      expectCfpCode(
        () =>
          atNoon.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );
      db.prepare(
        "UPDATE cfp_email_verification_consumptions SET person_id = ? WHERE verification_id = ?",
      ).run(second.consumed.personId, second.issued.verificationId);

      db.exec("DROP TRIGGER trg_cfp_applicant_sessions_core_immutable");
      db.prepare("UPDATE cfp_applicant_sessions SET expires_at = ? WHERE id = ?").run(
        "2026-08-24T12:00:00+00:00",
        second.consumed.sessionId,
      );
      expectCfpCode(
        () =>
          atNoon.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );
      db.prepare("UPDATE cfp_applicant_sessions SET expires_at = ? WHERE id = ?").run(
        "2026-08-24T12:00:00.000Z",
        second.consumed.sessionId,
      );
      db.prepare("UPDATE cfp_applicant_sessions SET call_id = ? WHERE id = ?").run(
        otherCall.callId,
        second.consumed.sessionId,
      );
      expectCfpCode(
        () =>
          atNoon.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );
      db.prepare("UPDATE cfp_applicant_sessions SET call_id = ? WHERE id = ?").run(
        fixture.callId,
        second.consumed.sessionId,
      );

      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T11:59:59.999Z",
          }).revokeApplicantSession(db, fixture.session, {
            callId: fixture.callId,
            sessionId: second.consumed.sessionId,
            reason: "Backdated revoke",
          }),
        "SESSION_REVOKE_CONFLICT",
      );
      const beforeAuditRollback = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T12:05:00.000Z",
            auditWriter: () => {
              throw new Error("synthetic revoke audit failure");
            },
          }).revokeApplicantSession(db, fixture.session, {
            callId: fixture.callId,
            sessionId: second.consumed.sessionId,
            reason: "Audit rollback revoke",
          }),
        "ACCESS_WRITE_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeAuditRollback);

      const revokeService = createCfpApplicantAccess({
        now: () => "2026-08-10T12:05:00.000Z",
      });
      const auditBeforeRevoke = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      const revoked = revokeService.revokeApplicantSession(db, fixture.session, {
        callId: fixture.callId,
        sessionId: first.consumed.sessionId,
        reason: "Verified security concern",
      });
      expect(revoked.replayed).toBe(false);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(auditBeforeRevoke + 1);
      const revokeAudit = db
        .prepare(
          "SELECT action, target_type, target_id, details_json FROM audit_events ORDER BY rowid DESC LIMIT 1",
        )
        .get();
      expect(revokeAudit).toEqual({
        action: "cfp.session.revoke",
        target_type: "applicant_session",
        target_id: first.consumed.sessionId,
        details_json: JSON.stringify({ revoked: true }),
      });
      const auditAfterRevoke = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      const revokedTruth = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "invalid-replay-clock",
          }).revokeApplicantSession(db, fixture.session, {
            callId: fixture.callId,
            sessionId: first.consumed.sessionId,
            reason: "Verified security concern",
          }),
        "ACCESS_INPUT_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(revokedTruth);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T12:04:59.999Z",
          }).revokeApplicantSession(db, fixture.session, {
            callId: fixture.callId,
            sessionId: first.consumed.sessionId,
            reason: "Verified security concern",
          }),
        "SESSION_REVOKE_CONFLICT",
      );
      expect(snapshotO2bTruth(db)).toEqual(revokedTruth);
      expect(
        revokeService.revokeApplicantSession(db, fixture.session, {
          callId: fixture.callId,
          sessionId: first.consumed.sessionId,
          reason: "Verified security concern",
        }),
      ).toEqual({ ...revoked, replayed: true });
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(auditAfterRevoke);
      expectCfpCode(
        () =>
          revokeService.revokeApplicantSession(db, fixture.session, {
            callId: fixture.callId,
            sessionId: first.consumed.sessionId,
            reason: "Different security concern",
          }),
        "SESSION_REVOKE_CONFLICT",
      );
      expectCfpCode(
        () =>
          atNoon.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_F,
          }),
        "SESSION_INVALID",
      );

      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "revoke-reviewer-account",
        fixture.workspaceId,
        "revoke.reviewer@synthetic.example",
        "Revoke Reviewer",
        "reviewer",
        "2026-08-10T00:00:00.000Z",
      );
      const revokeReviewer = buildOrganizerSession(
        db,
        fixture.workspaceId,
        "revoke-reviewer-account",
      );
      const beforeCapabilityDenial = snapshotO2bTruth(db);
      const capabilityAuditBefore = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      try {
        revokeService.revokeApplicantSession(db, revokeReviewer, {
          callId: fixture.callId,
          sessionId: second.consumed.sessionId,
          reason: "Capability denial revoke",
        });
        expect.fail("Stored reviewer revoke must retain CAPABILITY_DENIED");
      } catch (error) {
        expect(error).toBeInstanceOf(DenialError);
        expect((error as DenialError).code).toBe("CAPABILITY_DENIED");
      }
      expect(snapshotO2bTruth(db)).toEqual(beforeCapabilityDenial);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(capabilityAuditBefore + 1);

      for (const [scopeSession, callId, sessionId] of [
        [fixture.session, fixture.callId, "missing-revoke-session"],
        [fixture.session, otherCall.callId, second.consumed.sessionId],
        [
          {
            ...fixture.session,
            accountId: "missing-noncap-revoke-account",
            role: "read_only",
          },
          fixture.callId,
          second.consumed.sessionId,
        ],
      ] as const) {
        const before = snapshotO2bTruth(db);
        const beforeAudit = (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count;
        expectCfpCode(
          () =>
            revokeService.revokeApplicantSession(db, scopeSession, {
              callId,
              sessionId,
              reason: "Scope denial revoke",
            }),
          "CALL_NOT_AVAILABLE",
        );
        expect(snapshotO2bTruth(db)).toEqual(before);
        expect(
          (
            db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
              count: number;
            }
          ).count,
        ).toBe(beforeAudit + 1);
      }

      const crossCallDuplicate = issueAndConsume(
        atNoon,
        db,
        otherCall,
        "resolve.cross-call@synthetic.example",
        HEX_64_D,
        HEX_64_L,
      );
      db.prepare("UPDATE cfp_applicant_sessions SET token_hash = ? WHERE id = ?").run(
        HEX_64_G,
        crossCallDuplicate.consumed.sessionId,
      );
      const crossCallDuplicateTruth = snapshotO2bTruth(db);
      for (const [workspaceId, callId] of [
        [fixture.workspaceId, fixture.callId],
        [otherCall.workspaceId, otherCall.callId],
      ] as const) {
        expectCfpCode(
          () =>
            atNoon.resolveApplicantSession(db, {
              workspaceId,
              callId,
              sessionTokenHash: HEX_64_G,
            }),
          "SESSION_INVALID",
        );
      }
      expectCfpCode(
        () =>
          atNoon.consumeEmailVerification(
            db,
            { workspaceId: otherCall.workspaceId },
            {
              callId: otherCall.callId,
              verificationId: crossCallDuplicate.issued.verificationId,
              verificationTokenHash: HEX_64_D,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Cross Call Duplicate",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(crossCallDuplicateTruth);

      const otherWorkspaceCall = setupFixture(db, {
        state: "OPEN",
        workspaceSlug: "acme",
      });
      const crossWorkspaceDuplicate = issueAndConsume(
        atNoon,
        db,
        otherWorkspaceCall,
        "resolve.cross-workspace@synthetic.example",
        HEX_64_E,
        HEX_64_I,
      );
      db.prepare("UPDATE cfp_applicant_sessions SET token_hash = ? WHERE id = ?").run(
        HEX_64_G,
        crossWorkspaceDuplicate.consumed.sessionId,
      );
      const crossWorkspaceDuplicateTruth = snapshotO2bTruth(db);
      for (const [workspaceId, callId] of [
        [fixture.workspaceId, fixture.callId],
        [otherWorkspaceCall.workspaceId, otherWorkspaceCall.callId],
      ] as const) {
        expectCfpCode(
          () =>
            atNoon.resolveApplicantSession(db, {
              workspaceId,
              callId,
              sessionTokenHash: HEX_64_G,
            }),
          "SESSION_INVALID",
        );
      }
      expectCfpCode(
        () =>
          atNoon.consumeEmailVerification(
            db,
            { workspaceId: otherWorkspaceCall.workspaceId },
            {
              callId: otherWorkspaceCall.callId,
              verificationId: crossWorkspaceDuplicate.issued.verificationId,
              verificationTokenHash: HEX_64_E,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Cross Workspace Duplicate",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(crossWorkspaceDuplicateTruth);

      const third = issueAndConsume(
        atNoon,
        db,
        fixture,
        "resolve.duplicate@synthetic.example",
        HEX_64_C,
        HEX_64_H,
      );
      db.prepare("UPDATE cfp_applicant_sessions SET token_hash = ? WHERE id = ?").run(
        HEX_64_G,
        third.consumed.sessionId,
      );
      expectCfpCode(
        () =>
          atNoon.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 7B: session identity rejects a foreign-workspace duplicate consumption", () => {
    const dbPath = resolve(".tmp/unit", `cfp-session-consumption-cardinality-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const foreignFixture = setupFixture(db, {
        state: "OPEN",
        workspaceSlug: "acme",
      });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const valid = issueAndConsume(
        service,
        db,
        fixture,
        "global.consumption@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const foreignPersonId = "foreign-consumption-person";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        foreignPersonId,
        foreignFixture.workspaceId,
        "foreign.consumption@synthetic.example",
        "Foreign Consumption Person",
        "2026-08-10T00:00:00.000Z",
      );
      db.exec("DROP TRIGGER trg_cfp_email_verification_consumptions_workspace_guard");
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "foreign-duplicate-consumption",
        foreignFixture.workspaceId,
        valid.issued.verificationId,
        foreignPersonId,
        "2026-08-10T12:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "duplicate-consumption-reviewer",
        fixture.workspaceId,
        "duplicate.consumption.reviewer@synthetic.example",
        "Duplicate Consumption Reviewer",
        "reviewer",
        "2026-08-10T00:00:00.000Z",
      );
      const reviewer = buildOrganizerSession(
        db,
        fixture.workspaceId,
        "duplicate-consumption-reviewer",
      );

      const corruptedTruth = snapshotO2bTruth(db);
      const auditCount = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_F,
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.assertApplicantAccess(db, {
            action: "CREATE_DRAFT",
            context: {
              workspaceId: fixture.workspaceId,
              sessionId: valid.consumed.sessionId,
            },
          }),
        "SESSION_INVALID",
      );
      for (const [actor, reason] of [
        [reviewer, "Reviewer ambiguous retained consumption"],
        [fixture.session, "Organizer ambiguous retained consumption"],
      ] as const) {
        const beforeDenialAudit = (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count;
        expectCfpCode(
          () =>
            service.revokeApplicantSession(db, actor, {
              callId: fixture.callId,
              sessionId: valid.consumed.sessionId,
              reason,
            }),
          "CALL_NOT_AVAILABLE",
        );
        expect(
          (
            db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
              count: number;
            }
          ).count,
        ).toBe(beforeDenialAudit + 1);
        expect(
          db
            .prepare(
              `SELECT action, target_type, target_id, details_json
               FROM audit_events ORDER BY rowid DESC LIMIT 1`,
            )
            .get(),
        ).toEqual({
          action: "security.access.denied",
          target_type: "cfp_organizer_scope",
          target_id: "applicant_session",
          details_json: JSON.stringify({
            scopeValid: false,
            code: "CALL_NOT_AVAILABLE",
          }),
        });
      }
      expect(snapshotO2bTruth(db)).toEqual(corruptedTruth);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(auditCount + 2);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 7C: session identity rejects a foreign-workspace session for the same verification", () => {
    const dbPath = resolve(".tmp/unit", `cfp-session-verification-cardinality-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const foreignFixture = setupFixture(db, {
        state: "OPEN",
        workspaceSlug: "acme",
      });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const valid = issueAndConsume(
        service,
        db,
        fixture,
        "global.session@synthetic.example",
        HEX_64_B,
        HEX_64_G,
      );
      const foreignPersonId = "foreign-session-person";
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        foreignPersonId,
        foreignFixture.workspaceId,
        "foreign.session@synthetic.example",
        "Foreign Session Person",
        "2026-08-10T00:00:00.000Z",
      );
      db.exec("DROP TRIGGER trg_cfp_applicant_sessions_workspace_guard");
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash,
            created_at, expires_at, revoked_at, revoked_by, revoked_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      ).run(
        "foreign-duplicate-verification-session",
        foreignFixture.workspaceId,
        foreignFixture.callId,
        foreignPersonId,
        valid.issued.verificationId,
        HEX_64_K,
        "2026-08-10T12:00:00.000Z",
        "2026-08-24T12:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "duplicate-session-reviewer",
        fixture.workspaceId,
        "duplicate.session.reviewer@synthetic.example",
        "Duplicate Session Reviewer",
        "reviewer",
        "2026-08-10T00:00:00.000Z",
      );
      const reviewer = buildOrganizerSession(
        db,
        fixture.workspaceId,
        "duplicate-session-reviewer",
      );

      const corruptedTruth = snapshotO2bTruth(db);
      const auditCount = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.assertApplicantAccess(db, {
            action: "CREATE_DRAFT",
            context: {
              workspaceId: fixture.workspaceId,
              sessionId: valid.consumed.sessionId,
            },
          }),
        "SESSION_INVALID",
      );
      for (const [actor, reason] of [
        [reviewer, "Reviewer ambiguous retained session"],
        [fixture.session, "Organizer ambiguous retained session"],
      ] as const) {
        const beforeDenialAudit = (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count;
        expectCfpCode(
          () =>
            service.revokeApplicantSession(db, actor, {
              callId: fixture.callId,
              sessionId: valid.consumed.sessionId,
              reason,
            }),
          "CALL_NOT_AVAILABLE",
        );
        expect(
          (
            db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
              count: number;
            }
          ).count,
        ).toBe(beforeDenialAudit + 1);
        expect(
          db
            .prepare(
              `SELECT action, target_type, target_id, details_json
               FROM audit_events ORDER BY rowid DESC LIMIT 1`,
            )
            .get(),
        ).toEqual({
          action: "security.access.denied",
          target_type: "cfp_organizer_scope",
          target_id: "applicant_session",
          details_json: JSON.stringify({
            scopeValid: false,
            code: "CALL_NOT_AVAILABLE",
          }),
        });
      }
      expect(snapshotO2bTruth(db)).toEqual(corruptedTruth);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(auditCount + 2);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 7D: Unicode-equivalent imported email fails closed without a parallel Person", () => {
    const dbPath = resolve(".tmp/unit", `cfp-person-unicode-equivalence-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, {
        state: "OPEN",
        opensAt: null,
        closesAt: null,
      });
      const nfdEmail = "jose\u0301@synthetic.example";
      const nfcEmail = nfdEmail.normalize("NFC");
      expect(nfdEmail).not.toBe(nfcEmail);
      const imported = new SimulatedFixtureSourceAdapter(db).importManifest(
        fixture.workspaceId,
        {
          workspaceSlug: "northstar",
          provider: "unicode-equivalence-fixture",
          sourceRef: "fixtures/unicode-equivalence.v1.json",
          importedAt: "2026-08-01T00:00:00.000Z",
          people: [
            {
              email: nfdEmail,
              fullName: "Jose Combining",
              organization: "Synthetic Org",
              title: "Synthetic Speaker",
              expertise: ["identity"],
              moderatorEligible: false,
            },
          ],
        },
      );
      const service = createCfpApplicantAccess({
        now: () => imported.completedAt,
      });
      const beforeIssue = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: nfcEmail,
              tokenHash: HEX_64_C,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeIssue);

      const verificationId = "unicode-equivalent-verification";
      const expiresAt = new Date(
        Date.parse(imported.completedAt) + 15 * 60 * 1000,
      ).toISOString();
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        verificationId,
        fixture.workspaceId,
        fixture.callId,
        nfcEmail,
        HEX_64_C,
        expiresAt,
        imported.completedAt,
      );
      const beforeConsume = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId,
              verificationTokenHash: HEX_64_C,
              applicantSessionTokenHash: HEX_64_L,
              fullName: "Must Not Create A Parallel Person",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeConsume);
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?")
            .get(fixture.workspaceId) as { count: number }
        ).count,
      ).toBe(1);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 7E: Unicode-equivalent verification siblings cannot evade issuance checks", () => {
    const dbPath = resolve(".tmp/unit", `cfp-verification-unicode-equivalence-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const nfdEmail = "emilie\u0301@synthetic.example";
      const nfcEmail = nfdEmail.normalize("NFC");
      expect(nfdEmail).not.toBe(nfcEmail);
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "unicode-equivalent-active-verification",
        fixture.workspaceId,
        fixture.callId,
        nfdEmail,
        HEX_64_A,
        "2026-08-10T12:10:00.000Z",
        "2026-08-10T11:55:00.000Z",
      );
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const originalTruth = snapshotO2bTruth(db);
      for (const tokenHash of [HEX_64_A, HEX_64_B]) {
        expectCfpCode(
          () =>
            service.issueEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                email: nfcEmail,
                tokenHash,
              },
            ),
          "ACCESS_READ_FAILED",
        );
        expect(snapshotO2bTruth(db)).toEqual(originalTruth);
      }
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 7F: email canonicalization is stable and rejects ill-formed UTF-16", () => {
    const dbPath = resolve(".tmp/unit", `cfp-email-canonical-fixed-point-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const decomposedByLowercase = "H\u0331@synthetic.example";
      const canonicalEmail = "\u1e96@synthetic.example";
      expect(decomposedByLowercase.trim().toLowerCase().normalize("NFC")).toBe(
        canonicalEmail,
      );

      const issued = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          email: decomposedByLowercase,
          tokenHash: HEX_64_A,
        },
      );
      expect(
        (
          db
            .prepare("SELECT email FROM cfp_email_verifications WHERE id = ?")
            .get(issued.verificationId) as { email: string }
        ).email,
      ).toBe(canonicalEmail);
      expect(
        service.issueEmailVerification(
          db,
          { workspaceId: fixture.workspaceId },
          {
            callId: fixture.callId,
            email: canonicalEmail,
            tokenHash: HEX_64_A,
          },
        ),
      ).toEqual({ ...issued, replayed: true });

      const consumed = service.consumeEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          verificationId: issued.verificationId,
          verificationTokenHash: HEX_64_A,
          applicantSessionTokenHash: HEX_64_F,
          fullName: "Canonical Fixed Point",
        },
      );
      expect(
        (
          db.prepare("SELECT canonical_email FROM people WHERE id = ?").get(
            consumed.personId,
          ) as { canonical_email: string }
        ).canonical_email,
      ).toBe(canonicalEmail);
      expect(
        service.resolveApplicantSession(db, {
          workspaceId: fixture.workspaceId,
          callId: fixture.callId,
          sessionTokenHash: HEX_64_F,
        }).context.sessionId,
      ).toBe(consumed.sessionId);

      const replacementEmail = "x\uFFFD@synthetic.example";
      const loneSurrogateEmail = "x\uD800@synthetic.example";
      expect(loneSurrogateEmail).not.toBe(replacementEmail);
      expect(Buffer.from(loneSurrogateEmail)).toEqual(Buffer.from(replacementEmail));
      const fullNameCandidate = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          email: "ill.formed.full.name@synthetic.example",
          tokenHash: HEX_64_B,
        },
      );
      const loneSurrogateText = "ill-formed-\uD800";
      const beforeIllFormedText = snapshotO2bTruth(db);
      const auditBeforeIllFormedText = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: fullNameCandidate.verificationId,
              verificationTokenHash: HEX_64_B,
              applicantSessionTokenHash: HEX_64_G,
              fullName: loneSurrogateText,
            },
          ),
        "VERIFICATION_INVALID",
      );
      expectCfpCode(
        () =>
          service.grantCallExtension(db, fixture.session, {
            callId: fixture.callId,
            personId: consumed.personId,
            extendsTo: "2026-08-11T00:00:00.000Z",
            reason: loneSurrogateText,
            idempotencyKey: "ill-formed-reason",
          }),
        "EXTENSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.grantCallExtension(db, fixture.session, {
            callId: fixture.callId,
            personId: consumed.personId,
            extendsTo: "2026-08-11T00:00:00.000Z",
            reason: "Ill-formed idempotency key",
            idempotencyKey: loneSurrogateText,
          }),
        "EXTENSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.revokeApplicantSession(db, fixture.session, {
            callId: fixture.callId,
            sessionId: consumed.sessionId,
            reason: loneSurrogateText,
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.transitionCallState(db, fixture.session, {
            callId: loneSurrogateText,
            expectedState: "OPEN",
            expectedUpdatedAt: "2026-08-10T00:00:00.000Z",
            nextState: "PAUSED",
          }),
        "CALL_NOT_AVAILABLE",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeIllFormedText);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(auditBeforeIllFormedText);

      new SimulatedFixtureSourceAdapter(db).importManifest(fixture.workspaceId, {
        workspaceSlug: "northstar",
        provider: "ill-formed-utf16-fixture",
        sourceRef: "fixtures/ill-formed-utf16.v1.json",
        importedAt: "2026-08-01T00:00:00.000Z",
        people: [
          {
            email: loneSurrogateEmail,
            fullName: "Ill-formed Source Identity",
            organization: "Synthetic Org",
            title: "Synthetic Speaker",
            expertise: ["identity"],
            moderatorEligible: false,
          },
        ],
      });
      expect(
        (
          db
            .prepare("SELECT canonical_email FROM people WHERE canonical_email = ?")
            .get(replacementEmail) as { canonical_email: string }
        ).canonical_email,
      ).toBe(replacementEmail);
      const beforeIllFormedEmail = snapshotO2bTruth(db);
      for (const email of [loneSurrogateEmail, replacementEmail]) {
        expectCfpCode(
          () =>
            service.issueEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                email,
                tokenHash: HEX_64_C,
              },
            ),
          "VERIFICATION_REQUEST_REJECTED",
        );
      }
      expect(snapshotO2bTruth(db)).toEqual(beforeIllFormedEmail);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 7G: SQLite storage-class aliases fail closed", () => {
    const dbPath = resolve(".tmp/unit", `cfp-storage-class-aliases-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });

      const blobPersonEmail = "blob.person.alias@synthetic.example";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "blob-email-person",
        fixture.workspaceId,
        Buffer.from(blobPersonEmail, "utf8"),
        "Blob Email Person",
        "2026-08-10T00:00:00.000Z",
      );
      const beforeBlobPerson = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: blobPersonEmail,
              tokenHash: HEX_64_A,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeBlobPerson);

      const blobVerificationEmail = "blob.verification.alias@synthetic.example";
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "blob-email-verification",
        fixture.workspaceId,
        fixture.callId,
        Buffer.from(blobVerificationEmail, "utf8"),
        HEX_64_B,
        "2026-08-10T12:15:00.000Z",
        "2026-08-10T12:00:00.000Z",
      );
      const beforeBlobVerification = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: blobVerificationEmail,
              tokenHash: HEX_64_B,
            },
          ),
        "ACCESS_READ_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeBlobVerification);

      const malformedDigestEmail = "multibyte.digest@synthetic.example";
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "multibyte-digest-verification",
        fixture.workspaceId,
        fixture.callId,
        malformedDigestEmail,
        "é".repeat(64),
        "2026-08-10T12:15:00.000Z",
        "2026-08-10T12:00:00.000Z",
      );
      const beforeMalformedDigest = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: malformedDigestEmail,
              tokenHash: HEX_64_C,
            },
          ),
        "ACCESS_READ_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeMalformedDigest);

      const blobSession = issueAndConsume(
        service,
        db,
        fixture,
        "blob.session.owner@synthetic.example",
        HEX_64_D,
        HEX_64_F,
      );
      db.exec("DROP TRIGGER trg_cfp_applicant_sessions_core_immutable");
      db.prepare("UPDATE cfp_applicant_sessions SET token_hash = ? WHERE id = ?").run(
        Buffer.from(HEX_64_F, "ascii"),
        blobSession.consumed.sessionId,
      );
      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_F,
          }),
        "SESSION_INVALID",
      );

      const collisionCandidate = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          email: "blob.session.candidate@synthetic.example",
          tokenHash: HEX_64_E,
        },
      );
      const beforeBlobDigestCollision = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: collisionCandidate.verificationId,
              verificationTokenHash: HEX_64_E,
              applicantSessionTokenHash: HEX_64_F,
              fullName: "Blob Digest Collision",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeBlobDigestCollision);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 7H: FK-valid BLOB identifier twins poison global session identity", () => {
    const dbPath = resolve(".tmp/unit", `cfp-blob-identifier-graph-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const valid = issueAndConsume(
        service,
        db,
        fixture,
        "blob.identifier.graph@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const blobVerificationId = Buffer.from(valid.issued.verificationId, "utf8");
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at,
            issuance_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        blobVerificationId,
        fixture.workspaceId,
        fixture.callId,
        "blob.identifier.graph@synthetic.example",
        HEX_64_B,
        "2026-08-10T12:15:00.000Z",
        "2026-08-10T11:59:00.000Z",
        2,
      );
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "blob-identifier-consumption",
        fixture.workspaceId,
        blobVerificationId,
        valid.consumed.personId,
        "2026-08-10T12:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash,
            created_at, expires_at, revoked_at, revoked_by, revoked_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      ).run(
        "blob-identifier-session",
        fixture.workspaceId,
        fixture.callId,
        valid.consumed.personId,
        blobVerificationId,
        HEX_64_G,
        "2026-08-10T12:00:00.000Z",
        "2026-08-24T12:00:00.000Z",
      );
      expect(
        db
          .prepare(
            `SELECT typeof(id) AS storage
             FROM cfp_email_verifications
             WHERE typeof(id) = 'blob'`,
          )
          .get(),
      ).toEqual({ storage: "blob" });

      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "blob-identifier-reviewer",
        fixture.workspaceId,
        "blob.identifier.reviewer@synthetic.example",
        "Blob Identifier Reviewer",
        "reviewer",
        "2026-08-10T00:00:00.000Z",
      );
      const reviewer = buildOrganizerSession(
        db,
        fixture.workspaceId,
        "blob-identifier-reviewer",
      );
      const corruptedTruth = snapshotO2bTruth(db);

      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_F,
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: valid.issued.verificationId,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_F,
              fullName: "Blob Identifier Replay",
            },
          ),
        "VERIFICATION_INVALID",
      );

      for (const actor of [reviewer, fixture.session]) {
        const beforeAudit = (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count;
        expectCfpCode(
          () =>
            service.revokeApplicantSession(db, actor, {
              callId: fixture.callId,
              sessionId: valid.consumed.sessionId,
              reason: "Ambiguous BLOB identifier graph",
            }),
          "CALL_NOT_AVAILABLE",
        );
        expect(
          (
            db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
              count: number;
            }
          ).count,
        ).toBe(beforeAudit + 1);
        expect(
          db
            .prepare(
              `SELECT action, target_type, target_id, details_json
               FROM audit_events ORDER BY rowid DESC LIMIT 1`,
            )
            .get(),
        ).toEqual({
          action: "security.access.denied",
          target_type: "cfp_organizer_scope",
          target_id: "applicant_session",
          details_json: JSON.stringify({
            scopeValid: false,
            code: "CALL_NOT_AVAILABLE",
          }),
        });
      }
      expect(snapshotO2bTruth(db)).toEqual(corruptedTruth);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 9A: exhaustive error provenance and audit detail allowlist", () => {
    const dbPath = resolve(".tmp/unit", `cfp-audit-complete-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const secretEmail = "top.secret.audit@synthetic.example";
      const secretFullName = "TOP-SECRET-FULL-NAME-SENTINEL";
      const secretReason = "TOP-SECRET-REASON-SENTINEL";
      const secretDatabaseRole = "TOP-SECRET-ROLE@synthetic.example";
      const hostileForeignId = "HOSTILE-FOREIGN-ID-SENTINEL";
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const issued = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        { callId: fixture.callId, email: secretEmail, tokenHash: HEX_64_A },
      );

      const messages: string[] = [];
      messages.push(
        expectCfpCode(
          () =>
            service.consumeEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                verificationId: issued.verificationId,
                verificationTokenHash: HEX_64_B,
                applicantSessionTokenHash: HEX_64_F,
                fullName: secretFullName,
              },
            ),
          "VERIFICATION_INVALID",
        ).message,
      );
      const consumed = service.consumeEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          verificationId: issued.verificationId,
          verificationTokenHash: HEX_64_A,
          applicantSessionTokenHash: HEX_64_F,
          fullName: secretFullName,
        },
      );

      const extension = service.grantCallExtension(db, fixture.session, {
        callId: fixture.callId,
        personId: consumed.personId,
        extendsTo: "2026-08-11T00:00:00.000Z",
        reason: secretReason,
        idempotencyKey: "audit-allowlist-extension",
      });
      expect(extension.replayed).toBe(false);
      messages.push(
        expectCfpCode(
          () =>
            service.grantCallExtension(db, fixture.session, {
              callId: fixture.callId,
              personId: consumed.personId,
              extendsTo: "2026-08-11T01:00:00.000Z",
              reason: `${secretReason}-DIFFERENT`,
              idempotencyKey: "audit-allowlist-extension",
            }),
          "EXTENSION_IDEMPOTENCY_CONFLICT",
        ).message,
      );

      messages.push(
        expectCfpCode(
          () =>
            service.issueEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                email: secretEmail,
                tokenHash: "malformed-sensitive-digest",
              },
            ),
          "VERIFICATION_REQUEST_REJECTED",
        ).message,
      );
      messages.push(
        expectCfpCode(
          () =>
            service.resolveApplicantSession(db, {
              workspaceId: fixture.workspaceId,
              callId: fixture.callId,
              sessionTokenHash: HEX_64_G,
            }),
          "SESSION_INVALID",
        ).message,
      );

      const beforeCollision = snapshotO2bTruth(db);
      messages.push(
        expectCfpCode(
          () =>
            createCfpApplicantAccess({
              now: () => "2026-08-10T12:00:00.000Z",
              id: () => issued.verificationId,
            }).issueEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                email: "collision.audit@synthetic.example",
                tokenHash: HEX_64_C,
              },
            ),
          "ACCESS_WRITE_FAILED",
        ).message,
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeCollision);

      const lifecycle = readCallLifecycle(db, fixture.workspaceId, fixture.callId);
      const transitionAt = new Date(Date.parse(lifecycle.updatedAt) + 1_000).toISOString();
      createCfpApplicantAccess({ now: () => transitionAt }).transitionCallState(
        db,
        fixture.session,
        {
          callId: fixture.callId,
          expectedState: "OPEN",
          expectedUpdatedAt: lifecycle.updatedAt,
          nextState: "PAUSED",
        },
      );

      const revokeService = createCfpApplicantAccess({
        now: () => "2026-08-10T12:05:00.000Z",
      });
      revokeService.revokeApplicantSession(db, fixture.session, {
        callId: fixture.callId,
        sessionId: consumed.sessionId,
        reason: secretReason,
      });
      messages.push(
        expectCfpCode(
          () =>
            revokeService.resolveApplicantSession(db, {
              workspaceId: fixture.workspaceId,
              callId: fixture.callId,
              sessionTokenHash: HEX_64_F,
            }),
          "SESSION_INVALID",
        ).message,
      );

      messages.push(
        expectCfpCode(
          () =>
            service.grantCallExtension(db, fixture.session, {
              callId: hostileForeignId,
              personId: consumed.personId,
              extendsTo: "2026-08-11T02:00:00.000Z",
              reason: secretReason,
              idempotencyKey: "hostile-scope-extension",
            }),
          "CALL_NOT_AVAILABLE",
        ).message,
      );

      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "audit-reviewer-account",
        fixture.workspaceId,
        "audit.reviewer@synthetic.example",
        "Audit Reviewer",
        "reviewer",
        "2026-08-10T00:00:00.000Z",
      );
      const auditReviewer = buildOrganizerSession(
        db,
        fixture.workspaceId,
        "audit-reviewer-account",
      );
      try {
        service.grantCallExtension(
          db,
          auditReviewer,
          {
            callId: fixture.callId,
            personId: consumed.personId,
            extendsTo: "2026-08-11T03:00:00.000Z",
            reason: secretReason,
            idempotencyKey: "capability-denial-extension",
          },
        );
        expect.fail("Capability denial must throw DenialError");
      } catch (error) {
        expect(error).toBeInstanceOf(DenialError);
        messages.push((error as DenialError).message);
      }

      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "audit-unknown-role-account",
        fixture.workspaceId,
        "audit.unknown.role@synthetic.example",
        "Audit Unknown Role",
        secretDatabaseRole,
        "2026-08-10T00:00:00.000Z",
      );
      const unknownRoleSession = buildOrganizerSession(
        db,
        fixture.workspaceId,
        "audit-unknown-role-account",
      );
      const beforeUnknownRoleTruth = snapshotO2bTruth(db);
      const beforeUnknownRoleAuditCount = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      messages.push(
        expectCfpCode(
          () =>
            service.grantCallExtension(db, unknownRoleSession, {
              callId: fixture.callId,
              personId: consumed.personId,
              extendsTo: "2026-08-11T04:00:00.000Z",
              reason: secretReason,
              idempotencyKey: "unknown-role-denial-extension",
            }),
          "CALL_NOT_AVAILABLE",
        ).message,
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeUnknownRoleTruth);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(beforeUnknownRoleAuditCount + 1);
      expect(
        db
          .prepare(
            `SELECT target_type, target_id, details_json
             FROM audit_events ORDER BY rowid DESC LIMIT 1`,
          )
          .get(),
      ).toEqual({
        target_type: "cfp_organizer_scope",
        target_id: "call",
        details_json: JSON.stringify({ scopeValid: false, code: "CALL_NOT_AVAILABLE" }),
      });

      const missingContext = {
        workspaceId: fixture.workspaceId,
        sessionId: "missing-provenance-session",
      };
      const o2bError = expectCfpCode(
        () =>
          service.assertApplicantAccess(db, {
            action: "CREATE_DRAFT",
            context: missingContext,
          }),
        "SESSION_INVALID",
      );
      expect(o2bError).not.toBeInstanceOf(FormDocumentPersistenceError);
      try {
        createDraftSubmission(db, missingContext, { callId: fixture.callId });
        expect.fail("O2A invalid session must throw its own error class");
      } catch (error) {
        expect(error).toBeInstanceOf(FormDocumentPersistenceError);
        expect((error as FormDocumentPersistenceError).code).toBe("SESSION_INVALID");
        expect(error).not.toBeInstanceOf(CfpApplicantAccessError);
      }

      const forbiddenFragments = [
        secretEmail,
        secretFullName,
        secretReason,
        secretDatabaseRole,
        hostileForeignId,
        HEX_64_A,
        HEX_64_F,
        "malformed-sensitive-digest",
        "UNIQUE constraint failed",
        "SQLITE_",
        "INSERT INTO",
      ];
      for (const message of messages) {
        for (const fragment of forbiddenFragments) {
          expect(message).not.toContain(fragment);
        }
      }

      const audits = db
        .prepare(
          `SELECT actor_kind, actor_ref, action, target_type, target_id, details_json
           FROM audit_events ORDER BY rowid`,
        )
        .all() as Array<{
        actor_kind: string;
        actor_ref: string | null;
        action: string;
        target_type: string | null;
        target_id: string | null;
        details_json: string | null;
      }>;
      const serializedAudits = JSON.stringify(audits);
      for (const fragment of forbiddenFragments) {
        expect(serializedAudits).not.toContain(fragment);
      }

      const allowedDetailKeys = new Set([
        "fromState",
        "toState",
        "granted",
        "revoked",
        "scopeValid",
        "code",
        "capabilityPresent",
      ]);
      const allowedStringValues = new Set([
        "DRAFT",
        "SCHEDULED",
        "OPEN",
        "PAUSED",
        "CLOSED",
        "ARCHIVED",
        "CANCELLED",
        "CALL_NOT_AVAILABLE",
        "CAPABILITY_DENIED",
      ]);
      for (const audit of audits) {
        if (audit.details_json === null) continue;
        const details = JSON.parse(audit.details_json) as Record<string, unknown>;
        const unexpectedKeys = Object.keys(details).filter(
          (key) => !allowedDetailKeys.has(key),
        );
        expect(unexpectedKeys).toEqual([]);
        for (const [key, value] of Object.entries(details)) {
          expect(
            typeof value === "boolean" ||
              (typeof value === "string" && allowedStringValues.has(value)),
          ).toBe(true);
        }
      }
      const roleDetailAudits = audits.filter((audit) => {
        if (audit.details_json === null) return false;
        const details = JSON.parse(audit.details_json) as Record<string, unknown>;
        return "role" in details;
      });
      expect(roleDetailAudits).toHaveLength(0);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 9B: every write seam maps transaction-boundary driver failures", () => {
    const dbPath = resolve(".tmp/unit", `cfp-write-boundaries-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const active = issueAndConsume(
        service,
        db,
        fixture,
        "boundary.active@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const consumeCandidate = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          email: "boundary.consume@synthetic.example",
          tokenHash: HEX_64_B,
        },
      );
      const lifecycle = service.readCallLifecycle(db, fixture.workspaceId, fixture.callId);
      const stableTruth = snapshotO2bTruth(db);
      const stableAudits = snapshotAuditTruth(db);

      const beginInvocations: ReadonlyArray<readonly [string, (failingDb: Db) => unknown]> = [
        [
          "transition",
          (failingDb) =>
            service.transitionCallState(failingDb, fixture.session, {
              callId: fixture.callId,
              expectedState: "OPEN",
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
        ],
        [
          "extension",
          (failingDb) =>
            service.grantCallExtension(failingDb, fixture.session, {
              callId: fixture.callId,
              personId: active.consumed.personId,
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Transaction boundary proof",
              idempotencyKey: "boundary-extension",
            }),
        ],
        [
          "issuance",
          (failingDb) =>
            service.issueEmailVerification(
              failingDb,
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                email: "boundary.issue@synthetic.example",
                tokenHash: HEX_64_C,
              },
            ),
        ],
        [
          "consumption",
          (failingDb) =>
            service.consumeEmailVerification(
              failingDb,
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                verificationId: consumeCandidate.verificationId,
                verificationTokenHash: HEX_64_B,
                applicantSessionTokenHash: HEX_64_G,
                fullName: "Boundary Applicant",
              },
            ),
        ],
        [
          "revocation",
          (failingDb) =>
            service.revokeApplicantSession(failingDb, fixture.session, {
              callId: fixture.callId,
              sessionId: active.consumed.sessionId,
              reason: "Transaction boundary proof",
            }),
        ],
      ];

      for (const [label, invoke] of beginInvocations) {
        const sentinel = `SQLITE_BEGIN_SECRET_${label}`;
        const error = expectCfpCode(
          () => invoke(withOneExecFailure(db, "BEGIN IMMEDIATE", sentinel)),
          "ACCESS_WRITE_FAILED",
        );
        expect(error.message).not.toContain(sentinel);
        expect(snapshotO2bTruth(db)).toEqual(stableTruth);
        expect(snapshotAuditTruth(db)).toEqual(stableAudits);
      }

      const commitSentinel = "SQLITE_COMMIT_SECRET";
      const commitError = expectCfpCode(
        () =>
          service.issueEmailVerification(
            withOneExecFailure(db, "COMMIT", commitSentinel),
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: "boundary.commit@synthetic.example",
              tokenHash: HEX_64_D,
            },
          ),
        "ACCESS_WRITE_FAILED",
      );
      expect(commitError.message).not.toContain(commitSentinel);
      expect(snapshotO2bTruth(db)).toEqual(stableTruth);
      expect(snapshotAuditTruth(db)).toEqual(stableAudits);

      const organizerCommitInvocations: ReadonlyArray<
        readonly [string, (failingDb: Db) => unknown]
      > = [
        [
          "transition",
          (failingDb) =>
            service.transitionCallState(failingDb, fixture.session, {
              callId: fixture.callId,
              expectedState: "OPEN",
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
        ],
        [
          "extension",
          (failingDb) =>
            service.grantCallExtension(failingDb, fixture.session, {
              callId: fixture.callId,
              personId: active.consumed.personId,
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Organizer COMMIT boundary proof",
              idempotencyKey: "organizer-commit-boundary-extension",
            }),
        ],
        [
          "revocation",
          (failingDb) =>
            service.revokeApplicantSession(failingDb, fixture.session, {
              callId: fixture.callId,
              sessionId: active.consumed.sessionId,
              reason: "Organizer COMMIT boundary proof",
            }),
        ],
      ];
      for (const [label, invoke] of organizerCommitInvocations) {
        const sentinel = `SQLITE_ORGANIZER_COMMIT_SECRET_${label}`;
        const error = expectCfpCode(
          () => invoke(withOneExecFailure(db, "COMMIT", sentinel)),
          "ACCESS_WRITE_FAILED",
        );
        expect(error.message).not.toContain(sentinel);
        expect(snapshotO2bTruth(db)).toEqual(stableTruth);
        expect(snapshotAuditTruth(db)).toEqual(stableAudits);
      }

      withTransactionOrSavepoint(db, "boundary_savepoint_outer", () => {
        const savepointSentinel = "SQLITE_SAVEPOINT_SECRET";
        const savepointError = expectCfpCode(
          () =>
            service.issueEmailVerification(
              withOneExecFailure(
                db,
                ownedSavepointStatement("SAVEPOINT", "issue_verification"),
                savepointSentinel,
              ),
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                email: "boundary.savepoint@synthetic.example",
                tokenHash: HEX_64_E,
              },
            ),
          "ACCESS_WRITE_FAILED",
        );
        expect(savepointError.message).not.toContain(savepointSentinel);
        expect(snapshotO2bTruth(db)).toEqual(stableTruth);
        expect(snapshotAuditTruth(db)).toEqual(stableAudits);

        const releaseSentinel = "SQLITE_RELEASE_SECRET";
        const releaseError = expectCfpCode(
          () =>
            service.issueEmailVerification(
              withOneExecFailure(
                db,
                ownedSavepointStatement(
                  "RELEASE SAVEPOINT",
                  "issue_verification",
                ),
                releaseSentinel,
              ),
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                email: "boundary.release@synthetic.example",
                tokenHash: HEX_64_H,
              },
            ),
          "ACCESS_WRITE_FAILED",
        );
        expect(releaseError.message).not.toContain(releaseSentinel);
        expect(snapshotO2bTruth(db)).toEqual(stableTruth);
        expect(snapshotAuditTruth(db)).toEqual(stableAudits);
      });
      expect(snapshotO2bTruth(db)).toEqual(stableTruth);
      expect(snapshotAuditTruth(db)).toEqual(stableAudits);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 9C: malformed runtime object shapes use stable domain errors", () => {
    const dbPath = resolve(".tmp/unit", `cfp-runtime-object-shapes-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "runtime.shape@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const lifecycle = service.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );
      const stableTruth = snapshotO2bTruth(db);
      const stableAuditCount = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;

      for (const malformedValue of [null, 7, "malformed", [], () => undefined]) {
        const malformed = malformedValue as never;
        expectCfpCode(
          () => service.transitionCallState(db, fixture.session, malformed),
          "CALL_NOT_AVAILABLE",
        );
        expectCfpCode(
          () =>
            service.transitionCallState(db, malformed, {
              callId: fixture.callId,
              expectedState: "OPEN",
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
          "CALL_NOT_AVAILABLE",
        );
        expectCfpCode(
          () => service.grantCallExtension(db, fixture.session, malformed),
          "CALL_NOT_AVAILABLE",
        );
        expectCfpCode(
          () =>
            service.grantCallExtension(db, malformed, {
              callId: fixture.callId,
              personId: applicant.consumed.personId,
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Malformed runtime session",
              idempotencyKey: "malformed-runtime-session",
            }),
          "CALL_NOT_AVAILABLE",
        );
        expectCfpCode(
          () =>
            service.issueEmailVerification(
              db,
              malformed,
              {
                callId: fixture.callId,
                email: "malformed.context@synthetic.example",
                tokenHash: HEX_64_B,
              },
            ),
          "CALL_NOT_AVAILABLE",
        );
        expectCfpCode(
          () =>
            service.issueEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              malformed,
            ),
          "CALL_NOT_AVAILABLE",
        );
        expectCfpCode(
          () =>
            service.consumeEmailVerification(
              db,
              malformed,
              {
                callId: fixture.callId,
                verificationId: applicant.issued.verificationId,
                verificationTokenHash: HEX_64_A,
                applicantSessionTokenHash: HEX_64_F,
                fullName: "Malformed Context",
              },
            ),
          "VERIFICATION_INVALID",
        );
        expectCfpCode(
          () =>
            service.consumeEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              malformed,
            ),
          "VERIFICATION_INVALID",
        );
        expectCfpCode(
          () => service.resolveApplicantSession(db, malformed),
          "SESSION_INVALID",
        );
        expectCfpCode(
          () => service.revokeApplicantSession(db, fixture.session, malformed),
          "CALL_NOT_AVAILABLE",
        );
        expectCfpCode(
          () =>
            service.revokeApplicantSession(db, malformed, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              reason: "Malformed runtime session",
            }),
          "CALL_NOT_AVAILABLE",
        );
        expectCfpCode(
          () => service.assertApplicantAccess(db, malformed),
          "SESSION_INVALID",
        );
        expectCfpCode(
          () =>
            service.assertApplicantAccess(db, {
              action: "CREATE_DRAFT",
              context: malformed,
            }),
          "SESSION_INVALID",
        );
      }

      expect(snapshotO2bTruth(db)).toEqual(stableTruth);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(stableAuditCount);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 9D: public accessors are snapshotted once and throwing getters are mapped", () => {
    const dbPath = resolve(".tmp/unit", `cfp-runtime-accessors-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const otherCall = setupFixture(db, {
        state: "CLOSED",
        accessMode: "INVITED",
      });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "runtime.accessor.owner@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const lifecycle = service.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );

      let callIdReads = 0;
      let workspaceReads = 0;
      const changingInput = {
        get callId() {
          callIdReads += 1;
          return callIdReads === 1 ? fixture.callId : otherCall.callId;
        },
        email: "changing.accessor@synthetic.example",
        tokenHash: HEX_64_B,
      };
      const changingContext = {
        get workspaceId() {
          workspaceReads += 1;
          return fixture.workspaceId;
        },
      };
      const issued = service.issueEmailVerification(
        db,
        changingContext,
        changingInput,
      );
      expect(callIdReads).toBe(1);
      expect(workspaceReads).toBe(1);
      expect(
        db
          .prepare("SELECT workspace_id, call_id FROM cfp_email_verifications WHERE id = ?")
          .get(issued.verificationId),
      ).toEqual({
        workspace_id: fixture.workspaceId,
        call_id: fixture.callId,
      });

      const hostileSecret = "HOSTILE_GETTER_SECRET";
      const hostile = (): never => {
        throw new Error(hostileSecret);
      };
      const errors = [
        expectCfpCode(
          () =>
            service.transitionCallState(db, fixture.session, {
              get callId() {
                return hostile();
              },
              expectedState: "OPEN",
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
          "CALL_NOT_AVAILABLE",
        ),
        expectCfpCode(
          () =>
            service.transitionCallState(
              db,
              {
                ...fixture.session,
                accountId: fixture.accountId,
                get workspaceId() {
                  return hostile();
                },
              },
              {
                callId: fixture.callId,
                expectedState: "OPEN",
                expectedUpdatedAt: lifecycle.updatedAt,
                nextState: "PAUSED",
              },
            ),
          "CALL_NOT_AVAILABLE",
        ),
        expectCfpCode(
          () =>
            service.grantCallExtension(db, fixture.session, {
              callId: fixture.callId,
              personId: applicant.consumed.personId,
              idempotencyKey: "hostile-getter-extension",
              extendsTo: "2026-08-11T00:00:00.000Z",
              get reason() {
                return hostile();
              },
            }),
          "CALL_NOT_AVAILABLE",
        ),
        expectCfpCode(
          () =>
            service.issueEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                get email() {
                  return hostile();
                },
                tokenHash: HEX_64_C,
              },
            ),
          "CALL_NOT_AVAILABLE",
        ),
        expectCfpCode(
          () =>
            service.consumeEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              {
                callId: fixture.callId,
                verificationId: applicant.issued.verificationId,
                verificationTokenHash: HEX_64_A,
                applicantSessionTokenHash: HEX_64_F,
                get fullName() {
                  return hostile();
                },
              },
            ),
          "VERIFICATION_INVALID",
        ),
        expectCfpCode(
          () =>
            service.resolveApplicantSession(db, {
              workspaceId: fixture.workspaceId,
              callId: fixture.callId,
              get sessionTokenHash() {
                return hostile();
              },
            }),
          "SESSION_INVALID",
        ),
        expectCfpCode(
          () =>
            service.revokeApplicantSession(db, fixture.session, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              get reason() {
                return hostile();
              },
            }),
          "CALL_NOT_AVAILABLE",
        ),
        expectCfpCode(
          () =>
            service.assertApplicantAccess(db, {
              action: "CREATE_DRAFT",
              context: {
                workspaceId: fixture.workspaceId,
                get sessionId() {
                  return hostile();
                },
              },
            }),
          "SESSION_INVALID",
        ),
      ];
      for (const error of errors) {
        expect(error.message).not.toContain(hostileSecret);
      }
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM cfp_email_verifications")
            .get() as { count: number }
        ).count,
      ).toBe(2);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM call_extensions").get() as {
            count: number;
          }
        ).count,
      ).toBe(0);
      expect(
        (
          db
            .prepare("SELECT revoked_at FROM cfp_applicant_sessions WHERE id = ?")
            .get(applicant.consumed.sessionId) as { revoked_at: string | null }
        ).revoked_at,
      ).toBeNull();
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 10A: full logical truth and deterministic closed-file byte equality", () => {
    const dbPath = resolve(".tmp/unit", `cfp-byte-truth-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    let db: Db | null = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, {
        state: "CLOSED",
        opensAt: null,
        closesAt: null,
      });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      closeDb(db);
      db = null;
      const beforeBytes = readFileSync(dbPath);

      db = openDb({ path: dbPath, seed: false });
      const beforeTruth = snapshotO2bTruth(db);
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T12:00:00.000Z",
          }).issueEmailVerification(
            db!,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: "closed.byte.truth@synthetic.example",
              tokenHash: HEX_64_A,
            },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeTruth);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      closeDb(db);
      db = null;
      expect(Buffer.compare(readFileSync(dbPath), beforeBytes)).toBe(0);

      db = openDb({ path: dbPath, seed: false });
      const beforeScopeTruth = snapshotO2bTruth(db);
      const beforeAudit = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
          count: number;
        }
      ).count;
      expectCfpCode(
        () =>
          createCfpApplicantAccess({
            now: () => "2026-08-10T12:00:00.000Z",
          }).grantCallExtension(
            db!,
            fixture.session,
            {
              callId: fixture.callId,
              personId: "missing-byte-truth-person",
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Scope denial audit exception",
              idempotencyKey: "byte-truth-scope-denial",
            },
          ),
        "CALL_NOT_AVAILABLE",
      );
      expect(snapshotO2bTruth(db)).toEqual(beforeScopeTruth);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(beforeAudit + 1);
    } finally {
      if (db !== null) closeDb(db);
      removeSqliteFiles(dbPath);
    }
  }, 5_000);

  it("Evidence Group 9E: every public object seam maps hostile errors freshly and reads each property once", () => {
    const dbPath = resolve(".tmp/unit", `cfp-runtime-accessors-complete-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "complete.accessor.owner@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const lifecycle = service.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );
      const stableTruth = snapshotO2bTruth(db);
      const stableAudits = snapshotAuditTruth(db);

      type SeamCase = {
        readonly name: string;
        readonly key: string;
        readonly code: CfpApplicantAccessError["code"];
        readonly invoke: (value: unknown) => unknown;
      };
      const seams: readonly SeamCase[] = [
        {
          name: "factory options",
          key: "verificationTtlMs",
          code: "ACCESS_INPUT_INVALID",
          invoke: (value) => createCfpApplicantAccess(value as never),
        },
        {
          name: "transition session",
          key: "accountId",
          code: "CALL_NOT_AVAILABLE",
          invoke: (value) =>
            service.transitionCallState(db, value as never, {
              callId: fixture.callId,
              expectedState: "OPEN",
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
        },
        {
          name: "transition input",
          key: "callId",
          code: "CALL_NOT_AVAILABLE",
          invoke: (value) =>
            service.transitionCallState(db, fixture.session, value as never),
        },
        {
          name: "extension session",
          key: "accountId",
          code: "CALL_NOT_AVAILABLE",
          invoke: (value) =>
            service.grantCallExtension(db, value as never, {
              callId: fixture.callId,
              personId: applicant.consumed.personId,
              idempotencyKey: "hostile-complete-extension-session",
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Hostile complete extension session",
            }),
        },
        {
          name: "extension input",
          key: "callId",
          code: "CALL_NOT_AVAILABLE",
          invoke: (value) =>
            service.grantCallExtension(db, fixture.session, value as never),
        },
        {
          name: "issuance context",
          key: "workspaceId",
          code: "CALL_NOT_AVAILABLE",
          invoke: (value) =>
            service.issueEmailVerification(db, value as never, {
              callId: fixture.callId,
              email: "hostile.context@synthetic.example",
              tokenHash: HEX_64_B,
            }),
        },
        {
          name: "issuance input",
          key: "callId",
          code: "CALL_NOT_AVAILABLE",
          invoke: (value) =>
            service.issueEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              value as never,
            ),
        },
        {
          name: "consumption context",
          key: "workspaceId",
          code: "VERIFICATION_INVALID",
          invoke: (value) =>
            service.consumeEmailVerification(db, value as never, {
              callId: fixture.callId,
              verificationId: applicant.issued.verificationId,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_F,
              fullName: "Hostile Context Applicant",
            }),
        },
        {
          name: "consumption input",
          key: "callId",
          code: "VERIFICATION_INVALID",
          invoke: (value) =>
            service.consumeEmailVerification(
              db,
              { workspaceId: fixture.workspaceId },
              value as never,
            ),
        },
        {
          name: "resolution input",
          key: "workspaceId",
          code: "SESSION_INVALID",
          invoke: (value) =>
            service.resolveApplicantSession(db, value as never),
        },
        {
          name: "revocation session",
          key: "accountId",
          code: "CALL_NOT_AVAILABLE",
          invoke: (value) =>
            service.revokeApplicantSession(db, value as never, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              reason: "Hostile complete revocation session",
            }),
        },
        {
          name: "revocation input",
          key: "callId",
          code: "CALL_NOT_AVAILABLE",
          invoke: (value) =>
            service.revokeApplicantSession(db, fixture.session, value as never),
        },
        {
          name: "access input",
          key: "action",
          code: "SESSION_INVALID",
          invoke: (value) => service.assertApplicantAccess(db, value as never),
        },
        {
          name: "access context",
          key: "workspaceId",
          code: "SESSION_INVALID",
          invoke: (value) =>
            service.assertApplicantAccess(db, {
              action: "CREATE_DRAFT",
              context: value as never,
            }),
        },
      ];

      for (const seam of seams) {
        for (const hostileKind of ["plain", "exported"] as const) {
          const secret = `HOSTILE_${hostileKind.toUpperCase()}_${seam.name}`;
          const injected =
            hostileKind === "plain"
              ? new Error(secret)
              : new CfpApplicantAccessError("ACCESS_WRITE_FAILED", secret);
          const hostile = Object.defineProperty({}, seam.key, {
            get() {
              throw injected;
            },
          });
          const outward = expectCfpCode(
            () => seam.invoke(hostile),
            seam.code,
          );
          expect(outward, seam.name).not.toBe(injected);
          expect(outward.message, seam.name).toBe(
            new CfpApplicantAccessError(seam.code).message,
          );
          expect(outward.message, seam.name).not.toContain(secret);
          expect(outward.stack ?? "", seam.name).not.toContain(secret);
          expect("cause" in outward, seam.name).toBe(false);
        }

        let revokedGetterReads = 0;
        let revokedProxy: object;
        const revokedTarget = Object.defineProperty({}, seam.key, {
          get() {
            revokedGetterReads += 1;
            revocable.revoke();
            return Reflect.get(revokedProxy, seam.key);
          },
        });
        const revocable = Proxy.revocable(revokedTarget, {});
        revokedProxy = revocable.proxy;
        const revokedOutward = expectCfpCode(
          () => seam.invoke(revokedProxy),
          seam.code,
        );
        expect(revokedGetterReads, seam.name).toBe(1);
        expect(revokedOutward.message, seam.name).toBe(
          new CfpApplicantAccessError(seam.code).message,
        );
        expect("cause" in revokedOutward, seam.name).toBe(false);
      }

      const tracked = (values: Readonly<Record<string, unknown>>) => {
        const reads: Record<string, number> = {};
        const value: Record<string, unknown> = {};
        for (const [key, firstValue] of Object.entries(values)) {
          reads[key] = 0;
          Object.defineProperty(value, key, {
            enumerable: true,
            get() {
              reads[key] = (reads[key] ?? 0) + 1;
              return reads[key] === 1 ? firstValue : Symbol(`second-${key}`);
            },
          });
        }
        return { value, reads };
      };
      const expectReadOnce = (reads: Readonly<Record<string, number>>) => {
        expect(Object.values(reads)).toEqual(
          Array.from({ length: Object.keys(reads).length }, () => 1),
        );
      };

      const trackedOptions = tracked({
        verificationTtlMs: 15 * 60 * 1000,
        sessionTtlMs: 14 * 24 * 60 * 60 * 1000,
        now: () => "2026-08-10T12:00:00.000Z",
        id: () => "tracked-factory-id",
        auditWriter: undefined,
      });
      createCfpApplicantAccess(trackedOptions.value as never);
      expectReadOnce(trackedOptions.reads);

      const trackedTransitionSession = tracked({
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
      });
      const trackedTransitionInput = tracked({
        callId: fixture.callId,
        expectedUpdatedAt: lifecycle.updatedAt,
        expectedState: "OPEN",
        nextState: "OPEN",
      });
      expectCfpCode(
        () =>
          service.transitionCallState(
            db,
            trackedTransitionSession.value as never,
            trackedTransitionInput.value as never,
          ),
        "CALL_STATE_INVALID",
      );
      expectReadOnce(trackedTransitionSession.reads);
      expectReadOnce(trackedTransitionInput.reads);

      const trackedExtensionSession = tracked({
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
      });
      const trackedExtensionInput = tracked({
        callId: fixture.callId,
        personId: applicant.consumed.personId,
        idempotencyKey: "tracked-extension",
        extendsTo: "2026-08-11T00:00:00.000Z",
        reason: " ",
      });
      expectCfpCode(
        () =>
          service.grantCallExtension(
            db,
            trackedExtensionSession.value as never,
            trackedExtensionInput.value as never,
          ),
        "EXTENSION_INVALID",
      );
      expectReadOnce(trackedExtensionSession.reads);
      expectReadOnce(trackedExtensionInput.reads);

      const trackedIssueContext = tracked({ workspaceId: fixture.workspaceId });
      const trackedIssueInput = tracked({
        callId: fixture.callId,
        email: "invalid email",
        tokenHash: HEX_64_B,
      });
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            trackedIssueContext.value as never,
            trackedIssueInput.value as never,
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      expectReadOnce(trackedIssueContext.reads);
      expectReadOnce(trackedIssueInput.reads);

      const trackedConsumeContext = tracked({ workspaceId: fixture.workspaceId });
      const trackedConsumeInput = tracked({
        callId: fixture.callId,
        verificationId: "missing-tracked-verification",
        verificationTokenHash: HEX_64_B,
        applicantSessionTokenHash: HEX_64_C,
        fullName: "Tracked Applicant",
      });
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            trackedConsumeContext.value as never,
            trackedConsumeInput.value as never,
          ),
        "VERIFICATION_INVALID",
      );
      expectReadOnce(trackedConsumeContext.reads);
      expectReadOnce(trackedConsumeInput.reads);

      const trackedResolve = tracked({
        workspaceId: fixture.workspaceId,
        callId: fixture.callId,
        sessionTokenHash: HEX_64_L,
      });
      expectCfpCode(
        () => service.resolveApplicantSession(db, trackedResolve.value as never),
        "SESSION_INVALID",
      );
      expectReadOnce(trackedResolve.reads);

      const trackedRevokeSession = tracked({
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
      });
      const trackedRevokeInput = tracked({
        callId: fixture.callId,
        sessionId: applicant.consumed.sessionId,
        reason: " ",
      });
      expectCfpCode(
        () =>
          service.revokeApplicantSession(
            db,
            trackedRevokeSession.value as never,
            trackedRevokeInput.value as never,
          ),
        "SESSION_INVALID",
      );
      expectReadOnce(trackedRevokeSession.reads);
      expectReadOnce(trackedRevokeInput.reads);

      const trackedAccessContext = tracked({
        workspaceId: fixture.workspaceId,
        sessionId: applicant.consumed.sessionId,
      });
      const trackedAccessInput = tracked({
        action: "INVALID_ACTION",
        context: trackedAccessContext.value,
      });
      expectCfpCode(
        () => service.assertApplicantAccess(db, trackedAccessInput.value as never),
        "ACCESS_INPUT_INVALID",
      );
      expectReadOnce(trackedAccessInput.reads);
      expectReadOnce(trackedAccessContext.reads);

      expect(snapshotO2bTruth(db)).toEqual(stableTruth);
      expect(snapshotAuditTruth(db)).toEqual(stableAudits);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 12A: a FK-valid BLOB call-ID twin poisons every call and organizer seam", () => {
    const dbPath = resolve(".tmp/unit", `cfp-call-id-root-alias-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "call.alias.owner@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const pending = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          email: "call.alias.pending@synthetic.example",
          tokenHash: HEX_64_B,
        },
      );
      const lifecycle = service.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );
      const reviewer = insertReviewerSession(
        db,
        fixture,
        "call-alias-reviewer",
      );
      const foreignFixture = setupFixture(db, {
        state: "OPEN",
        workspaceSlug: "acme",
      });

      insertBlobCallIdTwin(
        db,
        fixture.callId,
        "static-foreign-workspace",
        foreignFixture.callId,
      );
      expectForeignKeysAndTriggersEnabled(db);
      expect(
        db
          .prepare(
            `SELECT typeof(id) AS storage
             FROM calls
             WHERE id = CAST(? AS BLOB)`,
          )
          .get(fixture.callId),
      ).toEqual({ storage: "blob" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_cfp_calls_workspace_guard'",
          )
          .get(),
      ).toEqual({ name: "trg_cfp_calls_workspace_guard" });

      const corruptTruth = snapshotO2bTruth(db);
      const auditBefore = snapshotAuditTruth(db);
      expectCfpCode(
        () =>
          service.readCallLifecycle(db, fixture.workspaceId, fixture.callId),
        "CALL_NOT_AVAILABLE",
      );
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: "call.alias.issue@synthetic.example",
              tokenHash: HEX_64_C,
            },
          ),
        "CALL_NOT_AVAILABLE",
      );
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: pending.verificationId,
              verificationTokenHash: HEX_64_B,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Call Alias Pending Applicant",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_F,
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.assertApplicantAccess(db, {
            action: "CREATE_DRAFT",
            context: {
              workspaceId: fixture.workspaceId,
              sessionId: applicant.consumed.sessionId,
            },
          }),
        "SESSION_INVALID",
      );
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);

      const organizerCases = [
        {
          targetId: "call",
          invoke: (actor: SessionInfo) =>
            service.transitionCallState(db, actor, {
              callId: fixture.callId,
              expectedState: "OPEN",
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
        },
        {
          targetId: "call",
          invoke: (actor: SessionInfo) =>
            service.grantCallExtension(db, actor, {
              callId: fixture.callId,
              personId: applicant.consumed.personId,
              idempotencyKey: `call-alias-extension-${actor.accountId}`,
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Ambiguous call identity",
            }),
        },
        {
          targetId: "applicant_session",
          invoke: (actor: SessionInfo) =>
            service.revokeApplicantSession(db, actor, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              reason: "Ambiguous call identity",
            }),
        },
      ] as const;

      let expectedAuditCount = auditBefore.length;
      for (const operation of organizerCases) {
        for (const actor of [fixture.session, reviewer]) {
          expectCfpCode(
            () => operation.invoke(actor),
            "CALL_NOT_AVAILABLE",
          );
          expectedAuditCount += 1;
          const audits = snapshotAuditTruth(db) as Array<{
            action: string;
            target_type: string;
            target_id: string;
            details_json: string;
          }>;
          expect(audits).toHaveLength(expectedAuditCount);
          expect(audits.at(-1)).toMatchObject({
            action: "security.access.denied",
            target_type: "cfp_organizer_scope",
            target_id: operation.targetId,
            details_json: JSON.stringify({
              scopeValid: false,
              code: "CALL_NOT_AVAILABLE",
            }),
          });
        }
      }

      expect(snapshotO2bTruth(db)).toEqual(corruptTruth);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM audit_events
             WHERE action IN ('cfp.call.transition', 'cfp.call.grant_extension', 'cfp.session.revoke')`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 12B: transaction-time call ambiguity wins over simultaneous capability loss", () => {
    const dbPath = resolve(".tmp/unit", `cfp-call-id-target-first-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const lifecycle = service.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );
      const auditBefore = snapshotAuditTruth(db).length;
      const racingDb = withOneBeforeExec(db, "BEGIN IMMEDIATE", () => {
        insertBlobCallIdTwin(db, fixture.callId, "authority-race");
        db.prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?").run(
          fixture.accountId,
        );
      });

      expectCfpCode(
        () =>
          service.transitionCallState(racingDb, fixture.session, {
            callId: fixture.callId,
            expectedState: "OPEN",
            expectedUpdatedAt: lifecycle.updatedAt,
            nextState: "PAUSED",
          }),
        "CALL_NOT_AVAILABLE",
      );
      expectForeignKeysAndTriggersEnabled(db);
      expect(
        db
          .prepare(
            `SELECT state, updated_at, typeof(id) AS storage
             FROM calls
             WHERE id = ? OR id = CAST(? AS BLOB)
             ORDER BY typeof(id) DESC`,
          )
          .all(fixture.callId, fixture.callId),
      ).toEqual([
        {
          state: "OPEN",
          updated_at: "2026-08-10T00:00:00.000Z",
          storage: "text",
        },
        {
          state: "OPEN",
          updated_at: "2026-08-10T00:00:00.000Z",
          storage: "blob",
        },
      ]);
      expect(snapshotAuditTruth(db)).toHaveLength(auditBefore + 1);
      expect(
        (snapshotAuditTruth(db) as Array<Record<string, unknown>>).at(-1),
      ).toMatchObject({
        action: "security.access.denied",
        target_type: "cfp_organizer_scope",
        target_id: "call",
        details_json: JSON.stringify({
          scopeValid: false,
          code: "CALL_NOT_AVAILABLE",
        }),
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'cfp.call.transition'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 13: a parent-only BLOB verification root poisons replay and session identity", () => {
    const dbPath = resolve(".tmp/unit", `cfp-verification-root-only-alias-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:05:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "verification.root.only@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const reviewer = insertReviewerSession(
        db,
        fixture,
        "verification-root-reviewer",
      );
      const foreignFixture = setupFixture(db, {
        state: "OPEN",
        workspaceSlug: "acme",
      });

      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?, ?, ?)`,
      ).run(
        applicant.issued.verificationId,
        foreignFixture.workspaceId,
        foreignFixture.callId,
        "verification.root.foreign@synthetic.example",
        HEX_64_B,
        "2026-08-10T12:15:00.000Z",
        "2026-08-10T11:59:00.000Z",
      );
      expectForeignKeysAndTriggersEnabled(db);
      expect(
        db
          .prepare(
            `SELECT typeof(id) AS storage
             FROM cfp_email_verifications
             WHERE id = CAST(? AS BLOB)`,
          )
          .get(applicant.issued.verificationId),
      ).toEqual({ storage: "blob" });
      expect(
        db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM cfp_email_verification_consumptions
                WHERE verification_id = CAST(? AS BLOB)) AS consumptions,
               (SELECT COUNT(*) FROM cfp_applicant_sessions
                WHERE verification_id = CAST(? AS BLOB)) AS sessions`,
          )
          .get(
            applicant.issued.verificationId,
            applicant.issued.verificationId,
          ),
      ).toEqual({ consumptions: 0, sessions: 0 });

      const corruptTruth = snapshotO2bTruth(db);
      const auditBefore = snapshotAuditTruth(db);
      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_F,
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.assertApplicantAccess(db, {
            action: "SAVE_DRAFT",
            context: {
              workspaceId: fixture.workspaceId,
              sessionId: applicant.consumed.sessionId,
            },
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: applicant.issued.verificationId,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_F,
              fullName: "Verification Root Replay",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);

      for (const actor of [fixture.session, reviewer]) {
        const countBefore = snapshotAuditTruth(db).length;
        expectCfpCode(
          () =>
            service.revokeApplicantSession(db, actor, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              reason: "Parent-only verification root ambiguity",
            }),
          "CALL_NOT_AVAILABLE",
        );
        expect(snapshotAuditTruth(db)).toHaveLength(countBefore + 1);
        expect(
          (snapshotAuditTruth(db) as Array<Record<string, unknown>>).at(-1),
        ).toMatchObject({
          action: "security.access.denied",
          target_type: "cfp_organizer_scope",
          target_id: "applicant_session",
          details_json: JSON.stringify({
            scopeValid: false,
            code: "CALL_NOT_AVAILABLE",
          }),
        });
      }
      expect(snapshotO2bTruth(db)).toEqual(corruptTruth);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'cfp.session.revoke'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 14: every generated identity insert rejects a same-byte BLOB collision atomically", () => {
    const dbPath = resolve(".tmp/unit", `cfp-generated-id-aliases-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const baseService = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });

      const verificationSeed = setupFixture(db, { state: "OPEN" });
      const verificationCollisionId = "generated-verification-collision";
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?, ?, ?)`,
      ).run(
        verificationCollisionId,
        verificationSeed.workspaceId,
        verificationSeed.callId,
        "generated.verification.seed@synthetic.example",
        HEX_64_A,
        "2026-08-10T12:15:00.000Z",
        "2026-08-10T11:59:00.000Z",
      );

      const extensionSeed = setupFixture(db, {
        state: "OPEN",
        closesAt: "2026-08-10T18:00:00.000Z",
      });
      const extensionSeedPerson = "generated-extension-seed-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        extensionSeedPerson,
        extensionSeed.workspaceId,
        "generated.extension.seed@synthetic.example",
        "Generated Extension Seed",
        "2026-08-10T00:00:00.000Z",
      );
      const extensionCollisionId = "generated-extension-collision";
      db.prepare(
        `INSERT INTO call_extensions
           (id, workspace_id, call_id, person_id, extends_to, reason,
            granted_by, idempotency_key, created_at)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        extensionCollisionId,
        extensionSeed.workspaceId,
        extensionSeed.callId,
        extensionSeedPerson,
        "2026-08-10T20:00:00.000Z",
        "Generated extension seed",
        extensionSeed.accountId,
        "generated-extension-seed-key",
        "2026-08-10T12:00:00.000Z",
      );

      const personCollisionId = "generated-person-collision";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?)`,
      ).run(
        personCollisionId,
        verificationSeed.workspaceId,
        "generated.person.seed@synthetic.example",
        "Generated Person Seed",
        "2026-08-10T00:00:00.000Z",
      );

      const consumptionSeed = setupFixture(db, { state: "OPEN" });
      const consumptionSeedEmail = "generated.consumption.seed@synthetic.example";
      const consumptionSeedVerification = baseService.issueEmailVerification(
        db,
        { workspaceId: consumptionSeed.workspaceId },
        {
          callId: consumptionSeed.callId,
          email: consumptionSeedEmail,
          tokenHash: HEX_64_B,
        },
      );
      const consumptionSeedPerson = "generated-consumption-seed-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        consumptionSeedPerson,
        consumptionSeed.workspaceId,
        consumptionSeedEmail,
        "Generated Consumption Seed",
        "2026-08-10T00:00:00.000Z",
      );
      const consumptionCollisionId = "generated-consumption-collision";
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?)`,
      ).run(
        consumptionCollisionId,
        consumptionSeed.workspaceId,
        consumptionSeedVerification.verificationId,
        consumptionSeedPerson,
        "2026-08-10T12:00:00.000Z",
      );

      const sessionSeed = setupFixture(db, { state: "OPEN" });
      const sessionSeedEmail = "generated.session.seed@synthetic.example";
      const sessionSeedVerification = baseService.issueEmailVerification(
        db,
        { workspaceId: sessionSeed.workspaceId },
        {
          callId: sessionSeed.callId,
          email: sessionSeedEmail,
          tokenHash: HEX_64_C,
        },
      );
      const sessionSeedPerson = "generated-session-seed-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        sessionSeedPerson,
        sessionSeed.workspaceId,
        sessionSeedEmail,
        "Generated Session Seed",
        "2026-08-10T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "generated-session-seed-consumption",
        sessionSeed.workspaceId,
        sessionSeedVerification.verificationId,
        sessionSeedPerson,
        "2026-08-10T12:00:00.000Z",
      );
      const sessionCollisionId = "generated-session-collision";
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash,
            created_at, expires_at, revoked_at, revoked_by, revoked_reason)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      ).run(
        sessionCollisionId,
        sessionSeed.workspaceId,
        sessionSeed.callId,
        sessionSeedPerson,
        sessionSeedVerification.verificationId,
        HEX_64_L,
        "2026-08-10T12:00:00.000Z",
        "2026-08-24T12:00:00.000Z",
      );

      expectForeignKeysAndTriggersEnabled(db);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sqlite_master
             WHERE type = 'trigger'
               AND name IN (
                 'trg_cfp_call_extensions_workspace_guard',
                 'trg_cfp_email_verifications_workspace_guard',
                 'trg_cfp_email_verification_consumptions_workspace_guard',
                 'trg_cfp_applicant_sessions_workspace_guard',
                 'trg_cfp_applicant_sessions_core_immutable'
               )`,
          )
          .get(),
      ).toEqual({ count: 5 });

      const proveCollision = (
        ids: readonly string[],
        forbiddenInsert: string,
        invoke: (
          service: ReturnType<typeof createCfpApplicantAccess>,
          collisionDb: Db,
        ) => unknown,
      ): void => {
        let idCalls = 0;
        let collidingInsertReached = false;
        const collisionService = createCfpApplicantAccess({
          now: () => "2026-08-10T12:05:00.000Z",
          id: () => {
            expect(db.isTransaction).toBe(true);
            const next = ids[idCalls];
            idCalls += 1;
            if (next === undefined) {
              throw new Error("Unexpected generated identity request");
            }
            return next;
          },
        });
        const truthBefore = snapshotO2bTruth(db);
        const auditBefore = snapshotAuditTruth(db);
        const collisionDb = new Proxy(db, {
          get(target, property) {
            if (property === "prepare") {
              return (sql: string) => {
                if (sql.includes(forbiddenInsert)) {
                  collidingInsertReached = true;
                  throw new Error("Colliding INSERT must not be prepared");
                }
                return target.prepare(sql);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as Db;
        expectCfpCode(
          () => invoke(collisionService, collisionDb),
          "ACCESS_WRITE_FAILED",
        );
        expect(idCalls).toBe(ids.length);
        expect(collidingInsertReached).toBe(false);
        expect(snapshotO2bTruth(db)).toEqual(truthBefore);
        expect(snapshotAuditTruth(db)).toEqual(auditBefore);
      };

      const verificationTarget = setupFixture(db, { state: "OPEN" });
      proveCollision(
        [verificationCollisionId],
        "INSERT INTO cfp_email_verifications",
        (collisionService, collisionDb) =>
          collisionService.issueEmailVerification(
            collisionDb,
            { workspaceId: verificationTarget.workspaceId },
            {
              callId: verificationTarget.callId,
              email: "generated.verification.target@synthetic.example",
              tokenHash: HEX_64_D,
            },
          ),
      );

      const extensionTarget = setupFixture(db, {
        state: "OPEN",
        closesAt: "2026-08-10T18:00:00.000Z",
      });
      const extensionTargetPerson = "generated-extension-target-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        extensionTargetPerson,
        extensionTarget.workspaceId,
        "generated.extension.target@synthetic.example",
        "Generated Extension Target",
        "2026-08-10T00:00:00.000Z",
      );
      proveCollision(
        [extensionCollisionId],
        "INSERT INTO call_extensions",
        (collisionService, collisionDb) =>
          collisionService.grantCallExtension(collisionDb, extensionTarget.session, {
            callId: extensionTarget.callId,
            personId: extensionTargetPerson,
            extendsTo: "2026-08-10T21:00:00.000Z",
            reason: "Generated extension collision target",
            idempotencyKey: "generated-extension-target-key",
          }),
      );

      const personTarget = setupFixture(db, { state: "OPEN" });
      const personTargetIssue = baseService.issueEmailVerification(
        db,
        { workspaceId: personTarget.workspaceId },
        {
          callId: personTarget.callId,
          email: "generated.person.target@synthetic.example",
          tokenHash: HEX_64_E,
        },
      );
      proveCollision(
        [personCollisionId],
        "INSERT INTO people",
        (collisionService, collisionDb) =>
          collisionService.consumeEmailVerification(
            collisionDb,
            { workspaceId: personTarget.workspaceId },
            {
              callId: personTarget.callId,
              verificationId: personTargetIssue.verificationId,
              verificationTokenHash: HEX_64_E,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Generated Person Target",
            },
          ),
      );

      const consumptionTarget = setupFixture(db, { state: "OPEN" });
      const consumptionTargetIssue = baseService.issueEmailVerification(
        db,
        { workspaceId: consumptionTarget.workspaceId },
        {
          callId: consumptionTarget.callId,
          email: "generated.consumption.target@synthetic.example",
          tokenHash: HEX_64_H,
        },
      );
      proveCollision(
        ["generated-consumption-rollback-person", consumptionCollisionId],
        "INSERT INTO cfp_email_verification_consumptions",
        (collisionService, collisionDb) =>
          collisionService.consumeEmailVerification(
            collisionDb,
            { workspaceId: consumptionTarget.workspaceId },
            {
              callId: consumptionTarget.callId,
              verificationId: consumptionTargetIssue.verificationId,
              verificationTokenHash: HEX_64_H,
              applicantSessionTokenHash: HEX_64_I,
              fullName: "Generated Consumption Target",
            },
          ),
      );

      const sessionTarget = setupFixture(db, { state: "OPEN" });
      const sessionTargetIssue = baseService.issueEmailVerification(
        db,
        { workspaceId: sessionTarget.workspaceId },
        {
          callId: sessionTarget.callId,
          email: "generated.session.target@synthetic.example",
          tokenHash: HEX_64_J,
        },
      );
      proveCollision(
        [
          "generated-session-rollback-person",
          "generated-session-rollback-consumption",
          sessionCollisionId,
        ],
        "INSERT INTO cfp_applicant_sessions",
        (collisionService, collisionDb) =>
          collisionService.consumeEmailVerification(
            collisionDb,
            { workspaceId: sessionTarget.workspaceId },
            {
              callId: sessionTarget.callId,
              verificationId: sessionTargetIssue.verificationId,
              verificationTokenHash: HEX_64_J,
              applicantSessionTokenHash: HEX_64_K,
              fullName: "Generated Session Target",
            },
          ),
      );

      for (const [table, id] of [
        ["cfp_email_verifications", verificationCollisionId],
        ["call_extensions", extensionCollisionId],
        ["people", personCollisionId],
        ["cfp_email_verification_consumptions", consumptionCollisionId],
        ["cfp_applicant_sessions", sessionCollisionId],
      ] as const) {
        expect(
          db
            .prepare(
              `SELECT typeof(id) AS storage
               FROM ${table}
               WHERE id = ? OR id = CAST(? AS BLOB)`,
            )
            .all(id, id),
        ).toEqual([{ storage: "blob" }]);
      }
      expectForeignKeysAndTriggersEnabled(db);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 15A: issuance and exact replay reject a Person beneath a BLOB workspace twin", () => {
    const dbPath = resolve(".tmp/unit", `cfp-workspace-person-issuance-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const email = "blob.workspace.issue@synthetic.example";
      const issued = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        { callId: fixture.callId, email, tokenHash: HEX_64_A },
      );
      insertBlobWorkspaceTwinPerson(
        db,
        fixture.workspaceId,
        email,
        "issuance",
      );
      expectForeignKeysAndTriggersEnabled(db);
      expect(
        db
          .prepare(
            `SELECT typeof(id) AS storage
             FROM workspaces
             WHERE id = ? OR id = CAST(? AS BLOB)
             ORDER BY typeof(id) DESC`,
          )
          .all(fixture.workspaceId, fixture.workspaceId),
      ).toEqual([{ storage: "text" }, { storage: "blob" }]);

      const corruptTruth = snapshotO2bTruth(db);
      const auditBefore = snapshotAuditTruth(db);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            { callId: fixture.callId, email, tokenHash: HEX_64_A },
          ),
        "CALL_NOT_AVAILABLE",
      );
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            { callId: fixture.callId, email, tokenHash: HEX_64_B },
          ),
        "CALL_NOT_AVAILABLE",
      );
      expect(snapshotO2bTruth(db)).toEqual(corruptTruth);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM cfp_email_verifications WHERE id = ?",
          )
          .get(issued.verificationId),
      ).toEqual({ count: 1 });
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 15B: new consumption cannot duplicate a Person beneath a BLOB workspace twin", () => {
    const dbPath = resolve(".tmp/unit", `cfp-workspace-person-consume-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const email = "blob.workspace.consume@synthetic.example";
      const issued = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        { callId: fixture.callId, email, tokenHash: HEX_64_C },
      );
      insertBlobWorkspaceTwinPerson(
        db,
        fixture.workspaceId,
        email,
        "consume",
      );
      expectForeignKeysAndTriggersEnabled(db);
      const corruptTruth = snapshotO2bTruth(db);
      const auditBefore = snapshotAuditTruth(db);

      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: issued.verificationId,
              verificationTokenHash: HEX_64_C,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Workspace Alias Applicant",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(corruptTruth);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);
      expect(
        db
          .prepare(
            `SELECT typeof(workspace_id) AS storage, COUNT(*) AS count
             FROM people
             WHERE canonical_email = ?
             GROUP BY typeof(workspace_id)`,
          )
          .all(email),
      ).toEqual([{ storage: "blob", count: 1 }]);
      expect(
        db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM cfp_email_verification_consumptions
                WHERE verification_id = ?) AS consumptions,
               (SELECT COUNT(*) FROM cfp_applicant_sessions
                WHERE verification_id = ?) AS sessions`,
          )
          .get(issued.verificationId, issued.verificationId),
      ).toEqual({ consumptions: 0, sessions: 0 });
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 15C: exact consume replay fails closed after a BLOB workspace-parent alias appears", () => {
    const dbPath = resolve(".tmp/unit", `cfp-workspace-person-replay-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const email = "blob.workspace.replay@synthetic.example";
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        email,
        HEX_64_D,
        HEX_64_H,
      );
      insertBlobWorkspaceTwinPerson(
        db,
        fixture.workspaceId,
        email,
        "replay",
      );
      expectForeignKeysAndTriggersEnabled(db);
      const corruptTruth = snapshotO2bTruth(db);
      const auditBefore = snapshotAuditTruth(db);

      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: applicant.issued.verificationId,
              verificationTokenHash: HEX_64_D,
              applicantSessionTokenHash: HEX_64_H,
              fullName: "Workspace Alias Replay",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_H,
          }),
        "SESSION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(corruptTruth);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);
      expect(
        db
          .prepare(
            `SELECT typeof(workspace_id) AS storage, COUNT(*) AS count
             FROM people
             WHERE canonical_email = ?
             GROUP BY typeof(workspace_id)
             ORDER BY typeof(workspace_id) DESC`,
          )
          .all(email),
      ).toEqual([
        { storage: "text", count: 1 },
        { storage: "blob", count: 1 },
      ]);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 15D: Person discovery itself enumerates a newly visible BLOB workspace parent", () => {
    const dbPath = resolve(".tmp/unit", `cfp-workspace-person-query-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
        id: (() => {
          const ids = [
            "workspace-query-verification",
            "workspace-query-duplicate-person",
            "workspace-query-consumption",
            "workspace-query-session",
          ];
          let index = 0;
          return () => ids[index++] ?? "workspace-query-unexpected";
        })(),
      });
      const email = "blob.workspace.query@synthetic.example";
      const issued = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        { callId: fixture.callId, email, tokenHash: HEX_64_E },
      );
      const truthBefore = snapshotO2bTruth(db);
      const auditBefore = snapshotAuditTruth(db);
      let personQueryReached = false;
      const storageAwareDb = withNthBeforePrepare(
        db,
        "FROM people\n       WHERE workspace_id = ? OR workspace_id = CAST(? AS BLOB)",
        1,
        () => {
          personQueryReached = true;
          // This runs inside the service's BEGIN IMMEDIATE, after the root check
          // immediately preceding Person discovery. The candidate query itself
          // must therefore enumerate both storage spellings and fail closed.
          insertBlobWorkspaceTwinPerson(
            db,
            fixture.workspaceId,
            email,
            "query",
          );
        },
      );

      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            storageAwareDb,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: issued.verificationId,
              verificationTokenHash: HEX_64_E,
              applicantSessionTokenHash: HEX_64_J,
              fullName: "Workspace Query Applicant",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(personQueryReached).toBe(true);
      expect(snapshotO2bTruth(db)).toEqual(truthBefore);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM people WHERE canonical_email = ?",
          )
          .get(email),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM workspaces WHERE id = CAST(? AS BLOB)",
          )
          .get(fixture.workspaceId),
      ).toEqual({ count: 0 });
      expectForeignKeysAndTriggersEnabled(db);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 16A: retained Person and session IDs reject global BLOB root twins", () => {
    const dbPath = resolve(".tmp/unit", `cfp-retained-person-session-roots-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const foreign = setupFixture(db, {
        state: "OPEN",
        workspaceSlug: "acme",
      });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });

      const personTarget = issueAndConsume(
        service,
        db,
        fixture,
        "retained.person.target@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?)`,
      ).run(
        personTarget.consumed.personId,
        foreign.workspaceId,
        "retained.person.foreign@synthetic.example",
        "Foreign Person Root Twin",
        "2026-08-10T00:00:00.000Z",
      );
      let truthBefore = snapshotO2bTruth(db);
      let auditBefore = snapshotAuditTruth(db);
      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_F,
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: personTarget.issued.verificationId,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_F,
              fullName: "Retained Person Target",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(truthBefore);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);

      const sessionTarget = issueAndConsume(
        service,
        db,
        fixture,
        "retained.session.target@synthetic.example",
        HEX_64_B,
        HEX_64_G,
      );
      const foreignVerification = service.issueEmailVerification(
        db,
        { workspaceId: foreign.workspaceId },
        {
          callId: foreign.callId,
          email: "retained.session.foreign@synthetic.example",
          tokenHash: HEX_64_J,
        },
      );
      const foreignPersonId = "retained-session-foreign-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        foreignPersonId,
        foreign.workspaceId,
        "retained.session.foreign@synthetic.example",
        "Foreign Session Person",
        "2026-08-10T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "retained-session-foreign-consumption",
        foreign.workspaceId,
        foreignVerification.verificationId,
        foreignPersonId,
        "2026-08-10T12:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash,
            created_at, expires_at, revoked_at, revoked_by, revoked_reason)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      ).run(
        sessionTarget.consumed.sessionId,
        foreign.workspaceId,
        foreign.callId,
        foreignPersonId,
        foreignVerification.verificationId,
        HEX_64_E,
        "2026-08-10T12:00:00.000Z",
        "2026-08-24T12:00:00.000Z",
      );
      truthBefore = snapshotO2bTruth(db);
      auditBefore = snapshotAuditTruth(db);
      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_G,
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: sessionTarget.issued.verificationId,
              verificationTokenHash: HEX_64_B,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Retained Session Target",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(truthBefore);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);
      expectForeignKeysAndTriggersEnabled(db);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 16B: retained consumption and extension IDs reject global BLOB root twins", () => {
    const dbPath = resolve(".tmp/unit", `cfp-retained-child-roots-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, {
        state: "OPEN",
        closesAt: "2026-08-10T18:00:00.000Z",
      });
      const foreign = setupFixture(db, {
        state: "OPEN",
        closesAt: "2026-08-10T18:00:00.000Z",
        workspaceSlug: "acme",
      });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });

      const consumptionTarget = issueAndConsume(
        service,
        db,
        fixture,
        "retained.consumption.target@synthetic.example",
        HEX_64_C,
        HEX_64_H,
      );
      const targetConsumption = db
        .prepare(
          "SELECT id FROM cfp_email_verification_consumptions WHERE verification_id = ?",
        )
        .get(consumptionTarget.issued.verificationId) as { id: string };
      const foreignVerification = service.issueEmailVerification(
        db,
        { workspaceId: foreign.workspaceId },
        {
          callId: foreign.callId,
          email: "retained.consumption.foreign@synthetic.example",
          tokenHash: HEX_64_K,
        },
      );
      const foreignConsumptionPerson = "retained-consumption-foreign-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        foreignConsumptionPerson,
        foreign.workspaceId,
        "retained.consumption.foreign@synthetic.example",
        "Foreign Consumption Person",
        "2026-08-10T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?)`,
      ).run(
        targetConsumption.id,
        foreign.workspaceId,
        foreignVerification.verificationId,
        foreignConsumptionPerson,
        "2026-08-10T12:00:00.000Z",
      );
      let truthBefore = snapshotO2bTruth(db);
      let auditBefore = snapshotAuditTruth(db);
      expectCfpCode(
        () =>
          service.resolveApplicantSession(db, {
            workspaceId: fixture.workspaceId,
            callId: fixture.callId,
            sessionTokenHash: HEX_64_H,
          }),
        "SESSION_INVALID",
      );
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: consumptionTarget.issued.verificationId,
              verificationTokenHash: HEX_64_C,
              applicantSessionTokenHash: HEX_64_H,
              fullName: "Retained Consumption Target",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(truthBefore);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);

      const extensionPersonId = "retained-extension-target-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        extensionPersonId,
        fixture.workspaceId,
        "retained.extension.target@synthetic.example",
        "Retained Extension Target",
        "2026-08-10T00:00:00.000Z",
      );
      const extensionInput = {
        callId: fixture.callId,
        personId: extensionPersonId,
        extendsTo: "2026-08-11T00:00:00.000Z",
        reason: "Retained extension root target",
        idempotencyKey: "retained-extension-root-target",
      } as const;
      const extension = service.grantCallExtension(
        db,
        fixture.session,
        extensionInput,
      );
      const foreignExtensionPerson = "retained-extension-foreign-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        foreignExtensionPerson,
        foreign.workspaceId,
        "retained.extension.foreign@synthetic.example",
        "Foreign Extension Person",
        "2026-08-10T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO call_extensions
           (id, workspace_id, call_id, person_id, extends_to, reason,
            granted_by, idempotency_key, created_at)
         VALUES (CAST(? AS BLOB), ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        extension.extensionId,
        foreign.workspaceId,
        foreign.callId,
        foreignExtensionPerson,
        "2026-08-11T00:00:00.000Z",
        "Foreign extension root twin",
        foreign.accountId,
        "retained-extension-root-foreign",
        "2026-08-10T12:00:00.000Z",
      );
      truthBefore = snapshotO2bTruth(db);
      auditBefore = snapshotAuditTruth(db);
      expectCfpCode(
        () =>
          service.grantCallExtension(
            db,
            fixture.session,
            extensionInput,
          ),
        "ACCESS_READ_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(truthBefore);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);
      expectForeignKeysAndTriggersEnabled(db);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 17A: applicant access observes session, call, and extension truth in one snapshot", () => {
    const dbPath = resolve(".tmp/unit", `cfp-access-coherent-snapshot-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    let writer: Db | null = null;
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const noon = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        noon,
        db,
        fixture,
        "coherent.access@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const lifecycle = noon.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );
      createCfpApplicantAccess({
        now: () => "2026-08-10T12:01:00.000Z",
      }).transitionCallState(db, fixture.session, {
        callId: fixture.callId,
        expectedState: "OPEN",
        expectedUpdatedAt: lifecycle.updatedAt,
        nextState: "PAUSED",
      });

      const access = createCfpApplicantAccess({
        now: () => "2026-08-10T12:02:00.000Z",
      });
      const accessInput = {
        action: "SAVE_DRAFT" as const,
        context: {
          workspaceId: fixture.workspaceId,
          sessionId: applicant.consumed.sessionId,
        },
      };
      const auditBefore = snapshotAuditTruth(db);
      expectCfpCode(
        () => access.assertApplicantAccess(db, accessInput),
        "CALL_NOT_ACCEPTING",
      );
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);

      writer = openDb({ path: dbPath, seed: false });
      let interleaved = false;
      let committedSwapTruth: Record<string, unknown> | null = null;
      const interleavedDb = withNthBeforePrepare(
        db,
        "WHERE lower(CAST(token_hash AS TEXT)) = ?",
        1,
        () => {
          interleaved = true;
          withTransactionOrSavepoint(writer!, "access_state_atomic_swap", () => {
            writer!
              .prepare(
                `UPDATE calls
                 SET state = 'OPEN', updated_at = ?
                 WHERE id = ? AND workspace_id = ? AND state = 'PAUSED'`,
              )
              .run(
                "2026-08-10T12:01:30.000Z",
                fixture.callId,
                fixture.workspaceId,
              );
            writer!
              .prepare(
                `UPDATE cfp_applicant_sessions
                 SET revoked_at = ?, revoked_by = ?, revoked_reason = ?
                 WHERE id = ? AND revoked_at IS NULL`,
              )
              .run(
                "2026-08-10T12:01:30.000Z",
                fixture.accountId,
                "Atomic coherent snapshot revocation",
                applicant.consumed.sessionId,
              );
          });
          committedSwapTruth = snapshotO2bTruth(writer!);
        },
      );

      expectCfpCode(
        () => access.assertApplicantAccess(interleavedDb, accessInput),
        "CALL_NOT_ACCEPTING",
      );
      expect(interleaved).toBe(true);
      expect(committedSwapTruth).not.toBeNull();
      expect(snapshotO2bTruth(db)).toEqual(committedSwapTruth);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);

      expectCfpCode(
        () => access.assertApplicantAccess(db, accessInput),
        "SESSION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(committedSwapTruth);
      expect(snapshotAuditTruth(db)).toEqual(auditBefore);

      const extensionFixture = setupFixture(db, { state: "OPEN" });
      const extensionApplicant = issueAndConsume(
        noon,
        db,
        extensionFixture,
        "coherent.extension@synthetic.example",
        HEX_64_B,
        HEX_64_G,
      );
      const extensionLifecycle = noon.readCallLifecycle(
        db,
        extensionFixture.workspaceId,
        extensionFixture.callId,
      );
      createCfpApplicantAccess({
        now: () => "2026-08-10T12:03:00.000Z",
      }).transitionCallState(db, extensionFixture.session, {
        callId: extensionFixture.callId,
        expectedState: "OPEN",
        expectedUpdatedAt: extensionLifecycle.updatedAt,
        nextState: "CLOSED",
      });
      const extensionAccess = createCfpApplicantAccess({
        now: () => "2026-08-10T12:05:00.000Z",
      });
      const extensionInput = {
        action: "SAVE_DRAFT" as const,
        context: {
          workspaceId: extensionFixture.workspaceId,
          sessionId: extensionApplicant.consumed.sessionId,
        },
      };
      const extensionAuditBefore = snapshotAuditTruth(db);
      expectCfpCode(
        () => extensionAccess.assertApplicantAccess(db, extensionInput),
        "CALL_NOT_ACCEPTING",
      );

      let extensionInterleaved = false;
      let extensionSwapTruth: Record<string, unknown> | null = null;
      const extensionInterleavedDb = withNthBeforePrepare(
        db,
        "WHERE lower(CAST(token_hash AS TEXT)) = ?",
        1,
        () => {
          extensionInterleaved = true;
          withTransactionOrSavepoint(
            writer!,
            "access_extension_atomic_swap",
            () => {
              writer!
                .prepare(
                  `INSERT INTO call_extensions
                     (id, workspace_id, call_id, person_id, extends_to, reason,
                      granted_by, idempotency_key, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  "coherent-access-extension",
                  extensionFixture.workspaceId,
                  extensionFixture.callId,
                  extensionApplicant.consumed.personId,
                  "2026-08-11T12:00:00.000Z",
                  "Atomic coherent access extension",
                  extensionFixture.accountId,
                  "coherent-access-extension-key",
                  "2026-08-10T12:04:00.000Z",
                );
              writer!
                .prepare(
                  `UPDATE cfp_applicant_sessions
                   SET revoked_at = ?, revoked_by = ?, revoked_reason = ?
                   WHERE id = ? AND revoked_at IS NULL`,
                )
                .run(
                  "2026-08-10T12:04:00.000Z",
                  extensionFixture.accountId,
                  "Atomic coherent extension revocation",
                  extensionApplicant.consumed.sessionId,
                );
            },
          );
          extensionSwapTruth = snapshotO2bTruth(writer!);
        },
      );
      expectCfpCode(
        () =>
          extensionAccess.assertApplicantAccess(
            extensionInterleavedDb,
            extensionInput,
          ),
        "CALL_NOT_ACCEPTING",
      );
      expect(extensionInterleaved).toBe(true);
      expect(extensionSwapTruth).not.toBeNull();
      expect(snapshotO2bTruth(db)).toEqual(extensionSwapTruth);
      expect(snapshotAuditTruth(db)).toEqual(extensionAuditBefore);
      expectCfpCode(
        () => extensionAccess.assertApplicantAccess(db, extensionInput),
        "SESSION_INVALID",
      );
      expect(snapshotO2bTruth(db)).toEqual(extensionSwapTruth);
      expect(snapshotAuditTruth(db)).toEqual(extensionAuditBefore);
    } finally {
      if (writer !== null) closeDb(writer);
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 17B: organizer preflight reads each complete target tuple coherently", () => {
    const dbPath = resolve(".tmp/unit", `cfp-target-preflight-snapshot-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    let writer: Db | null = null;
    try {
      const seedFixture = setupFixture(db, { state: "OPEN" });
      const reviewer = insertReviewerSession(
        db,
        seedFixture,
        "coherent-target-reviewer",
      );
      const foreignWorkspace = db
        .prepare("SELECT id FROM workspaces WHERE id != ? ORDER BY id LIMIT 1")
        .get(seedFixture.workspaceId) as { id: string };
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      writer = openDb({ path: dbPath, seed: false });

      for (const [index, actorKind] of ["organizer", "reviewer"].entries()) {
        const fixture = setupFixture(db, { state: "OPEN" });
        const personId = `coherent-target-person-${index}`;
        db.prepare(
          `INSERT INTO people
             (id, workspace_id, canonical_email, full_name, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          personId,
          foreignWorkspace.id,
          `coherent.target.${index}@synthetic.example`,
          "Coherent Target Person",
          "2026-08-10T00:00:00.000Z",
        );
        const actor = actorKind === "organizer" ? fixture.session : reviewer;
        const auditCount = snapshotAuditTruth(db).length;
        let interleaved = false;
        let swappedTruth: Record<string, unknown> | null = null;
        const racingDb = withNthBeforePrepare(
          db,
          "SELECT id, workspace_id, canonical_email, created_at\n         FROM people",
          1,
          () => {
            interleaved = true;
            withTransactionOrSavepoint(writer!, "organizer_target_atomic_swap", () => {
              insertBlobCallIdTwin(
                writer!,
                fixture.callId,
                `coherent-target-${index}`,
              );
              writer!
                .prepare("UPDATE people SET workspace_id = ? WHERE id = ?")
                .run(fixture.workspaceId, personId);
            });
            swappedTruth = snapshotO2bTruth(writer!);
          },
        );

        expectCfpCode(
          () =>
            service.grantCallExtension(racingDb, actor, {
              callId: fixture.callId,
              personId,
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Coherent organizer target preflight",
              idempotencyKey: `coherent-target-key-${index}`,
            }),
          "CALL_NOT_AVAILABLE",
        );
        expect(interleaved).toBe(true);
        expect(swappedTruth).not.toBeNull();
        expect(snapshotO2bTruth(db)).toEqual(swappedTruth);
        const audits = snapshotAuditTruth(db) as Array<Record<string, unknown>>;
        expect(audits).toHaveLength(auditCount + 1);
        expect(audits.at(-1)).toMatchObject({
          workspace_id: fixture.workspaceId,
          action: "security.access.denied",
          target_type: "cfp_organizer_scope",
          target_id: "call",
          details_json: JSON.stringify({
            scopeValid: false,
            code: "CALL_NOT_AVAILABLE",
          }),
        });
      }

      for (const [index, actorKind] of ["organizer", "reviewer"].entries()) {
        const fixture = setupFixture(db, { state: "OPEN" });
        const applicant = issueAndConsume(
          service,
          db,
          fixture,
          `coherent.revoke.${index}@synthetic.example`,
          index === 0 ? HEX_64_C : HEX_64_D,
          index === 0 ? HEX_64_E : HEX_64_G,
        );
        const actor =
          actorKind === "organizer"
            ? fixture.session
            : insertReviewerSession(
                db,
                fixture,
                `coherent-revoke-reviewer-${index}`,
              );
        db.prepare("UPDATE people SET workspace_id = ? WHERE id = ?").run(
          foreignWorkspace.id,
          applicant.consumed.personId,
        );
        const auditCount = snapshotAuditTruth(db).length;
        let interleaved = false;
        let swappedTruth: Record<string, unknown> | null = null;
        const racingDb = withNthBeforePrepare(
          db,
          "FROM cfp_applicant_sessions s",
          1,
          () => {
            interleaved = true;
            withTransactionOrSavepoint(
              writer!,
              "organizer_session_target_atomic_swap",
              () => {
                insertBlobCallIdTwin(
                  writer!,
                  fixture.callId,
                  `coherent-revoke-target-${index}`,
                );
                writer!
                  .prepare("UPDATE people SET workspace_id = ? WHERE id = ?")
                  .run(fixture.workspaceId, applicant.consumed.personId);
              },
            );
            swappedTruth = snapshotO2bTruth(writer!);
          },
        );

        expectCfpCode(
          () =>
            service.revokeApplicantSession(racingDb, actor, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              reason: "Coherent organizer session target preflight",
            }),
          "CALL_NOT_AVAILABLE",
        );
        expect(interleaved).toBe(true);
        expect(swappedTruth).not.toBeNull();
        expect(snapshotO2bTruth(db)).toEqual(swappedTruth);
        const audits = snapshotAuditTruth(db) as Array<Record<string, unknown>>;
        expect(audits).toHaveLength(auditCount + 1);
        expect(audits.at(-1)).toMatchObject({
          workspace_id: fixture.workspaceId,
          action: "security.access.denied",
          target_type: "cfp_organizer_scope",
          target_id: "applicant_session",
          details_json: JSON.stringify({
            scopeValid: false,
            code: "CALL_NOT_AVAILABLE",
          }),
        });
      }
    } finally {
      if (writer !== null) closeDb(writer);
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 17C: serialized capability classification survives re-promotion", () => {
    const dbPath = resolve(".tmp/unit", `cfp-authority-classification-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    let writer: Db | null = null;
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "authority.classification@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const lifecycle = service.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );
      writer = openDb({ path: dbPath, seed: false });

      const operations: ReadonlyArray<
        readonly [string, (publicDb: Db) => unknown]
      > = [
        [
          "transition",
          (publicDb) =>
            service.transitionCallState(publicDb, fixture.session, {
              callId: fixture.callId,
              expectedState: "OPEN",
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
        ],
        [
          "extension",
          (publicDb) =>
            service.grantCallExtension(publicDb, fixture.session, {
              callId: fixture.callId,
              personId: applicant.consumed.personId,
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Serialized authority classification",
              idempotencyKey: "serialized-authority-extension",
            }),
        ],
        [
          "revocation",
          (publicDb) =>
            service.revokeApplicantSession(publicDb, fixture.session, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              reason: "Serialized authority classification",
            }),
        ],
      ];

      for (const [label, invoke] of operations) {
        const before = snapshotO2bTruth(db);
        const auditCount = snapshotAuditTruth(db).length;
        let demoted = false;
        let promoted = false;
        const demotingDb = withOneBeforeExec(db, "BEGIN IMMEDIATE", () => {
          writer!
            .prepare("UPDATE accounts SET role = 'reviewer' WHERE id = ?")
            .run(fixture.accountId);
          demoted = true;
        });
        const racingDb = withOneAfterExec(demotingDb, "ROLLBACK", () => {
          writer!
            .prepare("UPDATE accounts SET role = 'organizer' WHERE id = ?")
            .run(fixture.accountId);
          promoted = true;
        });

        try {
          invoke(racingDb);
          expect.fail(`${label} must retain the serialized capability denial`);
        } catch (error) {
          expect(error).toBeInstanceOf(DenialError);
          expect((error as DenialError).code).toBe("CAPABILITY_DENIED");
        }
        expect(demoted).toBe(true);
        expect(promoted).toBe(true);
        expect(
          db.prepare("SELECT role FROM accounts WHERE id = ?").get(
            fixture.accountId,
          ),
        ).toEqual({ role: "organizer" });
        expect(snapshotO2bTruth(db)).toEqual(before);
        const audits = snapshotAuditTruth(db) as Array<Record<string, unknown>>;
        expect(audits).toHaveLength(auditCount + 1);
        const lastAudit = audits.at(-1) as {
          details_json: string;
        } & Record<string, unknown>;
        const details = JSON.parse(lastAudit.details_json) as Record<string, unknown>;
        expect(audits.at(-1)).toMatchObject({
          workspace_id: fixture.workspaceId,
          action: "security.access.denied",
          target_type: "capability",
          target_id: "phase0.pipeline.manage",
          details_json: JSON.stringify({
            capabilityPresent: false,
            code: "CAPABILITY_DENIED",
          }),
        });
        expect(details).toEqual({ capabilityPresent: false, code: "CAPABILITY_DENIED" });
        expect("role" in details).toBe(false);
        expect("email" in details).toBe(false);
        expect("targetId" in details).toBe(false);
        expect("targetType" in details).toBe(false);
        expect("workspaceId" in details).toBe(false);
        expect("accountId" in details).toBe(false);
      }
    } finally {
      if (writer !== null) closeDb(writer);
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 17G: ordinary denials own audit placement and every failure boundary", () => {
    const dbPath = resolve(
      ".tmp/unit",
      `cfp-ordinary-denial-boundaries-${process.pid}.db`,
    );
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    let mover: Db | null = null;
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "ordinary.denial@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const lifecycle = service.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );
      const reviewer = insertReviewerSession(
        db,
        fixture,
        "ordinary-denial-reviewer",
      );
      const cases = createOrganizerDenialTestCases(
        service,
        fixture,
        applicant,
        lifecycle,
        reviewer,
      );
      const stableTruth = snapshotO2bTruth(db);
      const denialCount = (): number =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM audit_events
               WHERE action = 'security.access.denied'
                 AND actor_ref = ?`,
            )
            .get(reviewer.accountId) as { count: number }
        ).count;
      const forbiddenOutwardFragments = [
        reviewer.role,
        reviewer.accountId,
        reviewer.workspaceId,
        fixture.callId,
        applicant.consumed.personId,
        applicant.consumed.sessionId,
        "missing-ordinary-transition-call",
        "missing-ordinary-extension-person",
        "missing-ordinary-revocation-session",
      ];

      const expectExactDenial = (
        testCase: OrganizerDenialTestCase,
        publicDb: Db,
      ): Error => {
        try {
          testCase.invoke(publicDb);
        } catch (error) {
          if (testCase.classification === "capability") {
            expect(error).toBeInstanceOf(DenialError);
            expect({
              name: (error as DenialError).name,
              code: (error as DenialError).code,
              message: (error as DenialError).message,
              target: (error as DenialError).target,
            }).toEqual({
              name: "DenialError",
              code: "CAPABILITY_DENIED",
              message:
                "This account is not authorized to perform that workspace action.",
              target: "phase0.pipeline.manage",
            });
          } else {
            expect(error).toBeInstanceOf(CfpApplicantAccessError);
            expect(error).not.toBeInstanceOf(DenialError);
            expect({
              name: (error as CfpApplicantAccessError).name,
              code: (error as CfpApplicantAccessError).code,
              message: (error as CfpApplicantAccessError).message,
            }).toEqual({
              name: "CfpApplicantAccessError",
              code: "CALL_NOT_AVAILABLE",
              message: "The requested call is not available.",
            });
          }
          const outward = JSON.stringify({
            name: (error as Error).name,
            message: (error as Error).message,
            code: (error as { readonly code?: unknown }).code,
            target: (error as { readonly target?: unknown }).target,
          });
          for (const fragment of forbiddenOutwardFragments) {
            expect(outward).not.toContain(fragment);
          }
          return error as Error;
        }
        throw new Error(`Expected exact ${testCase.label} denial.`);
      };

      const expectExactWriteFailure = (operation: () => unknown): void => {
        const error = expectCfpCode(operation, "ACCESS_WRITE_FAILED");
        expect(error).not.toBeInstanceOf(DenialError);
        expect({
          name: error.name,
          code: error.code,
          message: error.message,
        }).toEqual({
          name: "CfpApplicantAccessError",
          code: "ACCESS_WRITE_FAILED",
          message: "An error occurred while writing access state.",
        });
        for (const fragment of forbiddenOutwardFragments) {
          expect(error.message).not.toContain(fragment);
        }
      };

      const expectLatestAudit = (
        testCase: OrganizerDenialTestCase,
        workspaceId: string,
        beforeCount: number,
      ): void => {
        expect(denialCount()).toBe(beforeCount + 1);
        const expected =
          testCase.classification === "capability"
            ? {
                workspace_id: workspaceId,
                actor_kind: "account",
                actor_ref: reviewer.accountId,
                action: "security.access.denied",
                target_type: "capability",
                target_id: "phase0.pipeline.manage",
                details_json: JSON.stringify({
                  capabilityPresent: false,
                  code: "CAPABILITY_DENIED",
                }),
              }
            : {
                workspace_id: workspaceId,
                actor_kind: "account",
                actor_ref: reviewer.accountId,
                action: "security.access.denied",
                target_type: "cfp_organizer_scope",
                target_id: testCase.targetKind,
                details_json: JSON.stringify({
                  scopeValid: false,
                  code: "CALL_NOT_AVAILABLE",
                }),
              };
        const audit = db
          .prepare(
            `SELECT workspace_id, actor_kind, actor_ref, action, target_type,
                    target_id, details_json
             FROM audit_events
             WHERE action = 'security.access.denied'
               AND actor_ref = ?
             ORDER BY rowid DESC LIMIT 1`,
          )
          .get(reviewer.accountId) as typeof expected;
        expect(audit).toEqual(expected);
        const details = JSON.parse(audit.details_json) as Record<string, unknown>;
        expect(Object.keys(details).sort()).toEqual(
          testCase.classification === "capability"
            ? ["capabilityPresent", "code"]
            : ["code", "scopeValid"],
        );
        const serializedDetails = JSON.stringify(details);
        for (const fragment of [
          reviewer.role,
          reviewer.accountId,
          reviewer.workspaceId,
          fixture.callId,
          applicant.consumed.personId,
          applicant.consumed.sessionId,
        ]) {
          expect(serializedDetails).not.toContain(fragment);
        }
      };

      for (const testCase of cases) {
        const beforeCount = denialCount();
        expectExactDenial(testCase, db);
        expectLatestAudit(testCase, fixture.workspaceId, beforeCount);
        expect(snapshotO2bTruth(db)).toEqual(stableTruth);
      }

      const currentWorkspace = db
        .prepare("SELECT id FROM workspaces WHERE id != ? ORDER BY id LIMIT 1")
        .get(fixture.workspaceId) as { id: string };
      mover = openDb({ path: dbPath, seed: false });
      for (const testCase of cases) {
        mover
          .prepare("UPDATE accounts SET workspace_id = ? WHERE id = ?")
          .run(fixture.workspaceId, reviewer.accountId);
        const beforeCount = denialCount();
        let moveHits = 0;
        const movingDb = withOneBeforeExec(db, "BEGIN IMMEDIATE", () => {
          expect(db.isTransaction).toBe(false);
          mover!
            .prepare("UPDATE accounts SET workspace_id = ? WHERE id = ?")
            .run(currentWorkspace.id, reviewer.accountId);
          moveHits += 1;
        });
        expectExactDenial(testCase, movingDb);
        expect(moveHits).toBe(1);
        expect(
          db.prepare("SELECT workspace_id FROM accounts WHERE id = ?").get(
            reviewer.accountId,
          ),
        ).toEqual({ workspace_id: currentWorkspace.id });
        expectLatestAudit(testCase, currentWorkspace.id, beforeCount);
        expect(snapshotO2bTruth(db)).toEqual(stableTruth);
      }
      mover
        .prepare("UPDATE accounts SET workspace_id = ? WHERE id = ?")
        .run(fixture.workspaceId, reviewer.accountId);

      const auditFaults: ReadonlyArray<
        readonly [
          string,
          (sentinel: string, onFailure: () => void) => Db,
        ]
      > = [
        [
          "prepare",
          (sentinel, onFailure) =>
            withOnePrepareFailureAfterExec(
              db,
              "BEGIN IMMEDIATE",
              "INSERT INTO audit_events",
              sentinel,
              onFailure,
            ),
        ],
        [
          "run-property",
          (sentinel, onFailure) =>
            withOneStatementGetterFailureAfterExec(
              db,
              "BEGIN IMMEDIATE",
              "INSERT INTO audit_events",
              "run",
              sentinel,
              onFailure,
            ),
        ],
        [
          "run-before-execution",
          (sentinel, onFailure) =>
            withOneStatementRunFailureAfterExec(
              db,
              "BEGIN IMMEDIATE",
              "INSERT INTO audit_events",
              sentinel,
              onFailure,
            ),
        ],
      ];

      for (const testCase of cases) {
        for (const [faultName, createFaultDb] of auditFaults) {
          const beforeAudits = snapshotAuditTruth(db);
          let faultHits = 0;
          const sentinel = `SQLITE_DENIAL_${faultName}_${testCase.label}`;
          const faultDb = createFaultDb(sentinel, () => {
            expect(db.isTransaction).toBe(true);
            faultHits += 1;
          });
          expectExactWriteFailure(() => testCase.invoke(faultDb));
          expect(faultHits).toBe(1);
          expect(db.isTransaction).toBe(false);
          expect(snapshotO2bTruth(db)).toEqual(stableTruth);
          expect(snapshotAuditTruth(db)).toEqual(beforeAudits);
        }
      }

      for (const testCase of cases) {
        const beforeCount = denialCount();
        const beforeAudits = snapshotAuditTruth(db);
        let postRunHits = 0;
        const postRunDb = withOneAfterStatementRun(
          db,
          "INSERT INTO audit_events",
          `SQLITE_AFTER_DENIAL_AUDIT_${testCase.label}`,
          () => {
            expect(db.isTransaction).toBe(true);
            postRunHits += 1;
          },
        );
        expectExactWriteFailure(() => testCase.invoke(postRunDb));
        expect(postRunHits).toBe(1);
        expect(db.isTransaction).toBe(false);
        expect(snapshotAuditTruth(db)).toEqual(beforeAudits);

        expectExactDenial(testCase, db);
        expectLatestAudit(testCase, fixture.workspaceId, beforeCount);
      }

      const topLevelFailureBoundaries: ReadonlyArray<
        readonly [string, (onFailure: () => void) => Db]
      > = [
        [
          "begin-before",
          (onFailure) =>
            withOneExecFailure(
              db,
              "BEGIN IMMEDIATE",
              "SQLITE_DENIAL_BEGIN_BEFORE",
              onFailure,
            ),
        ],
        [
          "begin-after",
          (onFailure) =>
            withOneAfterExec(db, "BEGIN IMMEDIATE", () => {
              onFailure();
              throw new Error("SQLITE_DENIAL_BEGIN_AFTER");
            }),
        ],
        [
          "commit-before",
          (onFailure) =>
            withOneExecFailure(
              db,
              "COMMIT",
              "SQLITE_DENIAL_COMMIT_BEFORE",
              onFailure,
            ),
        ],
      ];

      for (const testCase of cases) {
        for (const [boundaryName, createFaultDb] of topLevelFailureBoundaries) {
          const beforeAudits = snapshotAuditTruth(db);
          let boundaryHits = 0;
          const faultDb = createFaultDb(() => {
            if (boundaryName === "begin-before") {
              expect(db.isTransaction).toBe(false);
            } else {
              expect(db.isTransaction).toBe(true);
            }
            boundaryHits += 1;
          });
          expectExactWriteFailure(() => testCase.invoke(faultDb));
          expect(boundaryHits).toBe(1);
          expect(db.isTransaction).toBe(false);
          expect(snapshotO2bTruth(db)).toEqual(stableTruth);
          expect(snapshotAuditTruth(db)).toEqual(beforeAudits);
        }

        const beforeCount = denialCount();
        let postCommitHits = 0;
        const postCommitDb = withOneAfterExec(db, "COMMIT", () => {
          expect(db.isTransaction).toBe(false);
          postCommitHits += 1;
          throw new Error(`SQLITE_DENIAL_COMMIT_AFTER_${testCase.label}`);
        });
        expect(() => testCase.invoke(postCommitDb)).toThrow(
          CfpApplicantAccessFatalError,
        );
        expect(postCommitHits).toBe(1);
        expect(db.isTransaction).toBe(false);
        expectLatestAudit(testCase, fixture.workspaceId, beforeCount);
      }

      for (const testCase of cases) {
        for (const rollbackKind of ["before", "after"] as const) {
          const beforeAudits = snapshotAuditTruth(db);
          let auditRunHits = 0;
          let rollbackHits = 0;
          const auditFailureDb = withOneStatementRunFailureAfterExec(
            db,
            "BEGIN IMMEDIATE",
            "INSERT INTO audit_events",
            `SQLITE_DENIAL_ROLLBACK_TRIGGER_${rollbackKind}_${testCase.label}`,
            () => {
              expect(db.isTransaction).toBe(true);
              auditRunHits += 1;
            },
          );
          const rollbackFaultDb =
            rollbackKind === "before"
              ? withOneExecFailure(
                  auditFailureDb,
                  "ROLLBACK",
                  `SQLITE_DENIAL_ROLLBACK_BEFORE_${testCase.label}`,
                  () => {
                    expect(db.isTransaction).toBe(true);
                    rollbackHits += 1;
                  },
                )
              : withOneAfterExec(auditFailureDb, "ROLLBACK", () => {
                  expect(db.isTransaction).toBe(false);
                  rollbackHits += 1;
                  throw new Error(
                    `SQLITE_DENIAL_ROLLBACK_AFTER_${testCase.label}`,
                  );
                });
          expectExactWriteFailure(() => testCase.invoke(rollbackFaultDb));
          expect(auditRunHits).toBe(1);
          expect(rollbackHits).toBe(1);
          expect(db.isTransaction).toBe(false);
          expect(snapshotO2bTruth(db)).toEqual(stableTruth);
          expect(snapshotAuditTruth(db)).toEqual(beforeAudits);
        }
      }

      db.exec(
        "CREATE TEMP TABLE ordinary_denial_caller_probe (value TEXT NOT NULL)",
      );
      for (const testCase of cases) {
        const releaseSql = ownedSavepointStatement(
          "RELEASE SAVEPOINT",
          "organizer_race_denial",
        );

        db.exec("BEGIN IMMEDIATE");
        db.prepare(
          "INSERT INTO ordinary_denial_caller_probe (value) VALUES (?)",
        ).run(`release-before-${testCase.label}`);
        let beforeAudits = snapshotAuditTruth(db);
        let releaseBeforeHits = 0;
        const releaseBeforeDb = withOneExecFailure(
          db,
          releaseSql,
          `SQLITE_DENIAL_RELEASE_BEFORE_${testCase.label}`,
          () => {
            expect(db.isTransaction).toBe(true);
            releaseBeforeHits += 1;
          },
        );
        expectExactWriteFailure(() => testCase.invoke(releaseBeforeDb));
        expect(releaseBeforeHits).toBe(1);
        expect(db.isTransaction).toBe(true);
        expect(snapshotAuditTruth(db)).toEqual(beforeAudits);
        expect(
          db
            .prepare(
              "SELECT value FROM ordinary_denial_caller_probe WHERE value = ?",
            )
            .get(`release-before-${testCase.label}`),
        ).toEqual({ value: `release-before-${testCase.label}` });
        db.exec("COMMIT");

        db.exec("BEGIN IMMEDIATE");
        db.prepare(
          "INSERT INTO ordinary_denial_caller_probe (value) VALUES (?)",
        ).run(`release-after-${testCase.label}`);
        const beforeCount = denialCount();
        let releaseAfterHits = 0;
        const releaseAfterDb = withOneAfterExec(db, releaseSql, () => {
          expect(db.isTransaction).toBe(true);
          releaseAfterHits += 1;
          throw new Error(`SQLITE_DENIAL_RELEASE_AFTER_${testCase.label}`);
        });
        expectExactDenial(testCase, releaseAfterDb);
        expect(releaseAfterHits).toBe(1);
        expect(db.isTransaction).toBe(true);
        expectLatestAudit(testCase, fixture.workspaceId, beforeCount);
        expect(
          db
            .prepare(
              "SELECT value FROM ordinary_denial_caller_probe WHERE value = ?",
            )
            .get(`release-after-${testCase.label}`),
        ).toEqual({ value: `release-after-${testCase.label}` });
        db.exec("COMMIT");

        for (const cleanupKind of ["before", "after"] as const) {
          db.exec("BEGIN IMMEDIATE");
          db.prepare(
            "INSERT INTO ordinary_denial_caller_probe (value) VALUES (?)",
          ).run(`cleanup-${cleanupKind}-${testCase.label}`);
          beforeAudits = snapshotAuditTruth(db);
          let auditRunHits = 0;
          let rollbackToHits = 0;
          let cleanupReleaseHits = 0;
          const auditFailureDb = withOneStatementRunFailureAfterExec(
            db,
            ownedSavepointStatement("SAVEPOINT", "organizer_race_denial"),
            "INSERT INTO audit_events",
            `SQLITE_DENIAL_CLEANUP_TRIGGER_${cleanupKind}_${testCase.label}`,
            () => {
              expect(db.isTransaction).toBe(true);
              auditRunHits += 1;
            },
          );
          const rollbackToSql = ownedSavepointStatement(
            "ROLLBACK TO SAVEPOINT",
            "organizer_race_denial",
          );
          const cleanupFaultDb =
            cleanupKind === "before"
              ? withOneExecFailure(
                  withOneExecFailure(
                    auditFailureDb,
                    rollbackToSql,
                    `SQLITE_DENIAL_ROLLBACK_TO_BEFORE_${testCase.label}`,
                    () => {
                      expect(db.isTransaction).toBe(true);
                      rollbackToHits += 1;
                    },
                  ),
                  releaseSql,
                  `SQLITE_DENIAL_CLEANUP_RELEASE_BEFORE_${testCase.label}`,
                  () => {
                    expect(db.isTransaction).toBe(true);
                    cleanupReleaseHits += 1;
                  },
                )
              : withOneAfterExec(
                  withOneAfterExec(auditFailureDb, rollbackToSql, () => {
                    expect(db.isTransaction).toBe(true);
                    rollbackToHits += 1;
                    throw new Error(
                      `SQLITE_DENIAL_ROLLBACK_TO_AFTER_${testCase.label}`,
                    );
                  }),
                  releaseSql,
                  () => {
                    expect(db.isTransaction).toBe(true);
                    cleanupReleaseHits += 1;
                    throw new Error(
                      `SQLITE_DENIAL_CLEANUP_RELEASE_AFTER_${testCase.label}`,
                    );
                  },
                );
          expectExactWriteFailure(() => testCase.invoke(cleanupFaultDb));
          expect(auditRunHits).toBe(1);
          expect(rollbackToHits).toBe(1);
          expect(cleanupReleaseHits).toBe(1);
          expect(db.isTransaction).toBe(true);
          expect(snapshotAuditTruth(db)).toEqual(beforeAudits);
          expect(
            db
              .prepare(
                "SELECT value FROM ordinary_denial_caller_probe WHERE value = ?",
              )
              .get(`cleanup-${cleanupKind}-${testCase.label}`),
          ).toEqual({ value: `cleanup-${cleanupKind}-${testCase.label}` });
          db.exec("COMMIT");
        }
      }
      expect(snapshotO2bTruth(db)).toEqual(stableTruth);
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      if (mover !== null) closeDb(mover);
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  }, 30_000);

  it("Evidence Group 17D: owned cleanup retries rollback faults without leaking writes", () => {
    const dbPath = resolve(".tmp/unit", `cfp-owned-cleanup-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const base = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        base,
        db,
        fixture,
        "cleanup.owner@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const consumeCandidate = base.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          email: "cleanup.consume@synthetic.example",
          tokenHash: HEX_64_B,
        },
      );
      const lifecycle = base.readCallLifecycle(
        db,
        fixture.workspaceId,
        fixture.callId,
      );
      const auditSentinel = "SQLITE_FORCED_AUDIT_FAILURE";
      let auditAttempts = 0;
      const failingAudit = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
        auditWriter: () => {
          auditAttempts += 1;
          throw new Error(auditSentinel);
        },
      });

      const proveTopLevelClean = (
        invoke: (publicDb: Db) => unknown,
        afterRunFragment?: string,
      ): void => {
        const before = snapshotO2bTruth(db);
        const audits = snapshotAuditTruth(db);
        let mutationFaultHits = 0;
        let publicDb: Db = db;
        if (afterRunFragment !== undefined) {
          publicDb = withOneAfterStatementRun(
            publicDb,
            afterRunFragment,
            `SQLITE_AFTER_MUTATION_${afterRunFragment}`,
            () => {
              mutationFaultHits += 1;
            },
          );
        }
        let rollbackFaultHits = 0;
        publicDb = withOneExecFailure(
          publicDb,
          "ROLLBACK",
          "SQLITE_ONE_SHOT_ROLLBACK_FAILURE",
          () => {
            rollbackFaultHits += 1;
          },
        );
        const error = expectCfpCode(
          () => invoke(publicDb),
          "ACCESS_WRITE_FAILED",
        );
        expect(error.message).not.toContain("SQLITE_");
        expect(rollbackFaultHits).toBe(1);
        if (afterRunFragment !== undefined) expect(mutationFaultHits).toBe(1);
        expect(db.isTransaction).toBe(false);
        expect(snapshotO2bTruth(db)).toEqual(before);
        expect(snapshotAuditTruth(db)).toEqual(audits);
        expect(() => db.exec("COMMIT")).toThrow();
        db.exec("BEGIN IMMEDIATE");
        expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
        db.exec("COMMIT");
        expect(snapshotO2bTruth(db)).toEqual(before);
      };

      proveTopLevelClean((publicDb) =>
        failingAudit.transitionCallState(publicDb, fixture.session, {
          callId: fixture.callId,
          expectedState: "OPEN",
          expectedUpdatedAt: lifecycle.updatedAt,
          nextState: "PAUSED",
        }),
      );
      proveTopLevelClean(
        (publicDb) =>
          base.issueEmailVerification(
            publicDb,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: "cleanup.issue@synthetic.example",
              tokenHash: HEX_64_C,
            },
          ),
        "INSERT INTO cfp_email_verifications",
      );
      proveTopLevelClean(
        (publicDb) =>
          base.consumeEmailVerification(
            publicDb,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: consumeCandidate.verificationId,
              verificationTokenHash: HEX_64_B,
              applicantSessionTokenHash: HEX_64_G,
              fullName: "Cleanup Consume Applicant",
            },
          ),
        "INSERT INTO cfp_applicant_sessions",
      );

      const nestedOperations: ReadonlyArray<
        readonly [string, string, (publicDb: Db) => unknown]
      > = [
        [
          "transition",
          "transition_call_state",
          (publicDb) =>
            failingAudit.transitionCallState(publicDb, fixture.session, {
              callId: fixture.callId,
              expectedState: "OPEN",
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
        ],
        [
          "extension",
          "grant_call_extension",
          (publicDb) =>
            failingAudit.grantCallExtension(publicDb, fixture.session, {
              callId: fixture.callId,
              personId: applicant.consumed.personId,
              extendsTo: "2026-08-11T00:00:00.000Z",
              reason: "Nested cleanup extension",
              idempotencyKey: "nested-cleanup-extension",
            }),
        ],
        [
          "revocation",
          "revoke_session",
          (publicDb) =>
            failingAudit.revokeApplicantSession(publicDb, fixture.session, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              reason: "Nested cleanup revocation",
            }),
        ],
      ];

      for (const [label, savepoint, invoke] of nestedOperations) {
        const before = snapshotO2bTruth(db);
        const audits = snapshotAuditTruth(db);
        const auditAttemptsBefore = auditAttempts;
        db.exec("BEGIN IMMEDIATE");
        const rollbackSql = ownedSavepointStatement(
          "ROLLBACK TO SAVEPOINT",
          savepoint,
        );
        const releaseSql = ownedSavepointStatement(
          "RELEASE SAVEPOINT",
          savepoint,
        );
        let rollbackFaultHits = 0;
        const rollbackFaultDb = withOneExecFailure(
          db,
          rollbackSql,
          `SQLITE_NESTED_ROLLBACK_${label}`,
          () => {
            rollbackFaultHits += 1;
          },
        );
        let releaseFaultHits = 0;
        const cleanupFaultDb = withOneExecFailure(
          rollbackFaultDb,
          releaseSql,
          `SQLITE_NESTED_RELEASE_${label}`,
          () => {
            releaseFaultHits += 1;
          },
        );
        const error = expectCfpCode(
          () => invoke(cleanupFaultDb),
          "ACCESS_WRITE_FAILED",
        );
        expect(error.message).not.toContain("SQLITE_");
        expect(auditAttempts).toBe(auditAttemptsBefore + 1);
        expect(rollbackFaultHits).toBe(1);
        expect(releaseFaultHits).toBe(1);
        expect(db.isTransaction).toBe(true);
        expect(snapshotO2bTruth(db)).toEqual(before);
        expect(snapshotAuditTruth(db)).toEqual(audits);
        db.exec(`SAVEPOINT "caller_probe_${label}"`);
        expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
        db.exec(`RELEASE SAVEPOINT "caller_probe_${label}"`);
        db.exec("COMMIT");
        expect(db.isTransaction).toBe(false);
        expect(snapshotO2bTruth(db)).toEqual(before);
        expect(snapshotAuditTruth(db)).toEqual(audits);
      }
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 17F: post-execution boundary faults preserve truthful ownership", () => {
    const dbPath = resolve(".tmp/unit", `cfp-boundary-effects-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        service,
        db,
        fixture,
        "boundary.preflight@synthetic.example",
        HEX_64_E,
        HEX_64_F,
      );
      const originalTruth = snapshotO2bTruth(db);
      const originalAudits = snapshotAuditTruth(db);

      let readSavepointHits = 0;
      const readSavepointFault = withOneAfterExec(
        db,
        ownedSavepointStatement("SAVEPOINT", "cfp_call_read_snapshot"),
        () => {
          readSavepointHits += 1;
          throw new Error("SQLITE_AFTER_READ_SAVEPOINT");
        },
      );
      expectCfpCode(
        () =>
          service.readCallLifecycle(
            readSavepointFault,
            fixture.workspaceId,
            fixture.callId,
          ),
        "CALL_NOT_AVAILABLE",
      );
      expect(readSavepointHits).toBe(1);
      expect(db.isTransaction).toBe(false);
      expect(snapshotO2bTruth(db)).toEqual(originalTruth);

      let readReleaseHits = 0;
      const lifecycle = service.readCallLifecycle(
        withOneAfterExec(
          db,
          ownedSavepointStatement(
            "RELEASE SAVEPOINT",
            "cfp_call_read_snapshot",
          ),
          () => {
            readReleaseHits += 1;
            throw new Error("SQLITE_AFTER_READ_RELEASE");
          },
        ),
        fixture.workspaceId,
        fixture.callId,
      );
      expect(readReleaseHits).toBe(1);
      expect(lifecycle.state).toBe("OPEN");
      expect(db.isTransaction).toBe(false);

      const preflightOperations: ReadonlyArray<
        readonly [string, (publicDb: Db) => unknown]
      > = [
        [
          "transition",
          (publicDb) =>
            service.transitionCallState(publicDb, fixture.session, {
              callId: fixture.callId,
              expectedState: lifecycle.state,
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            }),
        ],
        [
          "extension",
          (publicDb) =>
            service.grantCallExtension(publicDb, fixture.session, {
              callId: fixture.callId,
              personId: applicant.consumed.personId,
              extendsTo: "2026-08-11T12:00:00.000Z",
              reason: "Preflight boundary classification proof",
              idempotencyKey: "preflight-boundary-extension",
            }),
        ],
        [
          "revocation",
          (publicDb) =>
            service.revokeApplicantSession(publicDb, fixture.session, {
              callId: fixture.callId,
              sessionId: applicant.consumed.sessionId,
              reason: "Preflight boundary classification proof",
            }),
        ],
      ];
      for (const [label, invoke] of preflightOperations) {
        let preflightFaultHits = 0;
        expectCfpCode(
          () =>
            invoke(
              withOneExecFailure(
                db,
                ownedSavepointStatement(
                  "SAVEPOINT",
                  "organizer_scope_preflight",
                ),
                `SQLITE_PREFLIGHT_SAVEPOINT_${label}`,
                () => {
                  preflightFaultHits += 1;
                },
              ),
            ),
          "ACCESS_WRITE_FAILED",
        );
        expect(preflightFaultHits).toBe(1);
        expect(db.isTransaction).toBe(false);
        expect(snapshotO2bTruth(db)).toEqual(originalTruth);
        expect(snapshotAuditTruth(db)).toEqual(originalAudits);
      }
      let postPreflightFaultHits = 0;
      expectCfpCode(
        () =>
          preflightOperations[0]![1](
            withOneAfterExec(
              db,
              ownedSavepointStatement(
                "SAVEPOINT",
                "organizer_scope_preflight",
              ),
              () => {
                postPreflightFaultHits += 1;
                throw new Error("SQLITE_AFTER_PREFLIGHT_SAVEPOINT");
              },
            ),
          ),
        "ACCESS_WRITE_FAILED",
      );
      expect(postPreflightFaultHits).toBe(1);
      expect(db.isTransaction).toBe(false);
      expect(snapshotO2bTruth(db)).toEqual(originalTruth);
      expect(snapshotAuditTruth(db)).toEqual(originalAudits);

      for (const [label, invoke] of preflightOperations) {
        let lockedTargetFaultHits = 0;
        expectCfpCode(
          () =>
            invoke(
              withOnePrepareFailureAfterExec(
                db,
                "BEGIN IMMEDIATE",
                "FROM calls WHERE id = ? OR id = CAST(? AS BLOB)",
                `SQLITE_LOCKED_TARGET_READ_${label}`,
                () => {
                  lockedTargetFaultHits += 1;
                },
              ),
            ),
          "ACCESS_WRITE_FAILED",
        );
        expect(lockedTargetFaultHits).toBe(1);
        expect(db.isTransaction).toBe(false);
        expect(snapshotO2bTruth(db)).toEqual(originalTruth);
        expect(snapshotAuditTruth(db)).toEqual(originalAudits);
      }
      let lockedGetterFaultHits = 0;
      expectCfpCode(
        () =>
          preflightOperations[0]![1](
            withOneStatementGetterFailureAfterExec(
              db,
              "BEGIN IMMEDIATE",
              "FROM workspaces",
              "all",
              "SQLITE_LOCKED_TARGET_ALL_GETTER",
              () => {
                lockedGetterFaultHits += 1;
              },
            ),
          ),
        "ACCESS_WRITE_FAILED",
      );
      expect(lockedGetterFaultHits).toBe(1);
      expect(db.isTransaction).toBe(false);
      expect(snapshotO2bTruth(db)).toEqual(originalTruth);
      expect(snapshotAuditTruth(db)).toEqual(originalAudits);

      let beginHits = 0;
      const beginFault = withOneAfterExec(db, "BEGIN IMMEDIATE", () => {
        beginHits += 1;
        throw new Error("SQLITE_AFTER_BEGIN");
      });
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            beginFault,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: "boundary.after-begin@synthetic.example",
              tokenHash: HEX_64_A,
            },
          ),
        "ACCESS_WRITE_FAILED",
      );
      expect(beginHits).toBe(1);
      expect(db.isTransaction).toBe(false);
      expect(snapshotO2bTruth(db)).toEqual(originalTruth);
      expect(snapshotAuditTruth(db)).toEqual(originalAudits);

      let auditAttempts = 0;
      const failingAudit = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
        auditWriter: () => {
          auditAttempts += 1;
          throw new Error("SQLITE_AFTER_BOUNDARY_AUDIT");
        },
      });
      let rollbackHits = 0;
      expectCfpCode(
        () =>
          failingAudit.transitionCallState(
            withOneAfterExec(db, "ROLLBACK", () => {
              rollbackHits += 1;
              throw new Error("SQLITE_AFTER_ROLLBACK");
            }),
            fixture.session,
            {
              callId: fixture.callId,
              expectedState: lifecycle.state,
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            },
          ),
        "ACCESS_WRITE_FAILED",
      );
      expect(auditAttempts).toBe(1);
      expect(rollbackHits).toBe(1);
      expect(db.isTransaction).toBe(false);
      expect(snapshotO2bTruth(db)).toEqual(originalTruth);
      expect(snapshotAuditTruth(db)).toEqual(originalAudits);

      db.exec("CREATE TEMP TABLE caller_savepoint_probe (value TEXT NOT NULL)");
      db.exec("BEGIN IMMEDIATE");
      db.exec('SAVEPOINT "issue_verification"');
      db.prepare("INSERT INTO caller_savepoint_probe (value) VALUES (?)").run(
        "caller-owned-work",
      );
      let preSavepointHits = 0;
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            withOneExecFailure(
              db,
              ownedSavepointStatement("SAVEPOINT", "issue_verification"),
              "SQLITE_BEFORE_COLLIDING_SAVEPOINT",
              () => {
                preSavepointHits += 1;
              },
            ),
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: "boundary.before-savepoint@synthetic.example",
              tokenHash: HEX_64_H,
            },
          ),
        "ACCESS_WRITE_FAILED",
      );
      expect(preSavepointHits).toBe(1);
      expect(
        db.prepare("SELECT value FROM caller_savepoint_probe").all(),
      ).toEqual([{ value: "caller-owned-work" }]);
      let savepointHits = 0;
      const savepointFault = withOneAfterExec(
        db,
        ownedSavepointStatement("SAVEPOINT", "issue_verification"),
        () => {
          savepointHits += 1;
          throw new Error("SQLITE_AFTER_WRITE_SAVEPOINT");
        },
      );
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            savepointFault,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              email: "boundary.after-savepoint@synthetic.example",
              tokenHash: HEX_64_B,
            },
          ),
        "ACCESS_WRITE_FAILED",
      );
      expect(savepointHits).toBe(1);
      expect(db.isTransaction).toBe(true);
      expect(snapshotO2bTruth(db)).toEqual(originalTruth);

      let rollbackToHits = 0;
      let cleanupReleaseHits = 0;
      const rollbackToFault = withOneAfterExec(
        db,
        ownedSavepointStatement(
          "ROLLBACK TO SAVEPOINT",
          "transition_call_state",
        ),
        () => {
          rollbackToHits += 1;
          throw new Error("SQLITE_AFTER_ROLLBACK_TO");
        },
      );
      const cleanupReleaseFault = withOneAfterExec(
        rollbackToFault,
        ownedSavepointStatement(
          "RELEASE SAVEPOINT",
          "transition_call_state",
        ),
        () => {
          cleanupReleaseHits += 1;
          throw new Error("SQLITE_AFTER_CLEANUP_RELEASE");
        },
      );
      expectCfpCode(
        () =>
          failingAudit.transitionCallState(
            cleanupReleaseFault,
            fixture.session,
            {
              callId: fixture.callId,
              expectedState: lifecycle.state,
              expectedUpdatedAt: lifecycle.updatedAt,
              nextState: "PAUSED",
            },
          ),
        "ACCESS_WRITE_FAILED",
      );
      expect(auditAttempts).toBe(2);
      expect(rollbackToHits).toBe(1);
      expect(cleanupReleaseHits).toBe(1);
      expect(db.isTransaction).toBe(true);
      expect(snapshotO2bTruth(db)).toEqual(originalTruth);
      expect(snapshotAuditTruth(db)).toEqual(originalAudits);

      let releaseHits = 0;
      const released = service.issueEmailVerification(
        withOneAfterExec(
          db,
          ownedSavepointStatement(
            "RELEASE SAVEPOINT",
            "issue_verification",
          ),
          () => {
            releaseHits += 1;
            throw new Error("SQLITE_AFTER_WRITE_RELEASE");
          },
        ),
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          email: "boundary.after-release@synthetic.example",
          tokenHash: HEX_64_C,
        },
      );
      expect(releaseHits).toBe(1);
      expect(released.replayed).toBe(false);
      expect(db.isTransaction).toBe(true);
      expect(
        service.issueEmailVerification(
          db,
          { workspaceId: fixture.workspaceId },
          {
            callId: fixture.callId,
            email: "boundary.after-release@synthetic.example",
            tokenHash: HEX_64_C,
          },
        ),
      ).toMatchObject({ verificationId: released.verificationId, replayed: true });
      expect(
        db.prepare("SELECT value FROM caller_savepoint_probe").all(),
      ).toEqual([{ value: "caller-owned-work" }]);
      db.exec('RELEASE SAVEPOINT "issue_verification"');
      db.exec("COMMIT");
      expect(db.isTransaction).toBe(false);

      let commitHits = 0;
      expect(() =>
        service.issueEmailVerification(
          withOneAfterExec(db, "COMMIT", () => {
            commitHits += 1;
            throw new Error("SQLITE_AFTER_COMMIT");
          }),
          { workspaceId: fixture.workspaceId },
          {
            callId: fixture.callId,
            email: "boundary.after-commit@synthetic.example",
            tokenHash: HEX_64_D,
          },
        ),
      ).toThrow(CfpApplicantAccessFatalError);
      expect(commitHits).toBe(1);
      expect(db.isTransaction).toBe(false);
      const committedReplay = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        {
          callId: fixture.callId,
          email: "boundary.after-commit@synthetic.example",
          tokenHash: HEX_64_D,
        },
      );
      expect(committedReplay.replayed).toBe(true);

      let unreadableCommitHits = 0;
      let unreadableStateProbeHits = 0;
      expect(() =>
        service.issueEmailVerification(
          withThrowingCommitAndUnreadableTransactionState(
            db,
            () => {
              unreadableCommitHits += 1;
            },
            () => {
              unreadableStateProbeHits += 1;
            },
          ),
          { workspaceId: fixture.workspaceId },
          {
            callId: fixture.callId,
            email: "boundary.unreadable-after-commit@synthetic.example",
            tokenHash: HEX_64_E,
          },
        ),
      ).toThrow(CfpApplicantAccessFatalError);
      expect(unreadableCommitHits).toBe(1);
      expect(unreadableStateProbeHits).toBe(1);
      expect(db.isTransaction).toBe(false);
      expect(
        service.issueEmailVerification(
          db,
          { workspaceId: fixture.workspaceId },
          {
            callId: fixture.callId,
            email: "boundary.unreadable-after-commit@synthetic.example",
            tokenHash: HEX_64_E,
          },
        ),
      ).toMatchObject({ replayed: true });
      expect(snapshotAuditTruth(db)).toEqual(originalAudits);
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 17E: late access validates workspace-global extension key identity", () => {
    const dbPath = resolve(".tmp/unit", `cfp-extension-access-key-${process.pid}.db`);
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const first = setupFixture(db, {
        state: "OPEN",
        closesAt: "2026-08-10T14:00:00.000Z",
      });
      const second = setupFixture(db, {
        state: "OPEN",
        closesAt: "2026-08-10T14:00:00.000Z",
      });
      const noon = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const applicant = issueAndConsume(
        noon,
        db,
        first,
        "extension.key.owner@synthetic.example",
        HEX_64_A,
        HEX_64_F,
      );
      const secondPersonId = "extension-key-second-person";
      db.prepare(
        `INSERT INTO people
           (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        secondPersonId,
        second.workspaceId,
        "extension.key.second@synthetic.example",
        "Extension Key Second Person",
        "2026-08-10T00:00:00.000Z",
      );
      const key = "extension-access-global-key";
      const firstExtension = noon.grantCallExtension(db, first.session, {
        callId: first.callId,
        personId: applicant.consumed.personId,
        extendsTo: "2026-08-10T20:00:00.000Z",
        reason: "Canonical late access extension",
        idempotencyKey: key,
      });
      db.prepare(
        `INSERT INTO call_extensions
           (id, workspace_id, call_id, person_id, extends_to, reason,
            granted_by, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "extension-access-blob-key-twin",
        second.workspaceId,
        second.callId,
        secondPersonId,
        "2026-08-10T21:00:00.000Z",
        "Valid cross-target retained extension",
        second.accountId,
        Buffer.from(key, "utf8"),
        "2026-08-10T12:00:00.000Z",
      );
      const lifecycle = noon.readCallLifecycle(db, first.workspaceId, first.callId);
      createCfpApplicantAccess({
        now: () => "2026-08-10T14:30:00.000Z",
      }).transitionCallState(db, first.session, {
        callId: first.callId,
        expectedState: "OPEN",
        expectedUpdatedAt: lifecycle.updatedAt,
        nextState: "CLOSED",
      });

      const late = createCfpApplicantAccess({
        now: () => "2026-08-10T15:00:00.000Z",
      });
      const corruptTruth = snapshotO2bTruth(db);
      const audits = snapshotAuditTruth(db);
      const submissionsBefore = (
        db.prepare("SELECT COUNT(*) AS count FROM submissions").get() as {
          count: number;
        }
      ).count;
      expectCfpCode(
        () => {
          late.assertApplicantAccess(db, {
            action: "CREATE_DRAFT",
            context: {
              workspaceId: first.workspaceId,
              sessionId: applicant.consumed.sessionId,
            },
          });
          createDraftSubmission(
            db,
            {
              workspaceId: first.workspaceId,
              sessionId: applicant.consumed.sessionId,
            },
            { callId: first.callId },
          );
        },
        "ACCESS_READ_FAILED",
      );
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM submissions").get() as {
            count: number;
          }
        ).count,
      ).toBe(submissionsBefore);
      expectCfpCode(
        () =>
          late.grantCallExtension(db, first.session, {
            callId: first.callId,
            personId: applicant.consumed.personId,
            extendsTo: "2026-08-10T22:00:00.000Z",
            reason: "Fresh intent must validate retained key identity",
            idempotencyKey: "extension-access-fresh-key",
          }),
        "ACCESS_READ_FAILED",
      );
      expectCfpCode(
        () =>
          late.grantCallExtension(db, first.session, {
            callId: first.callId,
            personId: applicant.consumed.personId,
            extendsTo: firstExtension.extendsTo,
            reason: "Canonical late access extension",
            idempotencyKey: key,
          }),
        "ACCESS_READ_FAILED",
      );
      expect(snapshotO2bTruth(db)).toEqual(corruptTruth);
      expect(snapshotAuditTruth(db)).toEqual(audits);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group V7A: same-timestamp retry allocates durable sequence and never revives a failed-delivery token", () => {
    const dbPath = resolve(
      ".tmp/unit",
      `cfp-v7-sequential-issuance-${process.pid}.db`,
    );
    removeSqliteFiles(dbPath);
    const db = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const email = "v7.sequential@synthetic.example";
      const first = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        { callId: fixture.callId, email, tokenHash: HEX_64_A },
      );
      expect(first.replayed).toBe(false);
      expect(
        service.issueEmailVerification(
          db,
          { workspaceId: fixture.workspaceId },
          { callId: fixture.callId, email, tokenHash: HEX_64_A },
        ),
      ).toEqual({ ...first, replayed: true });

      // The first issuance is intentionally left undelivered. An immediate retry at the same
      // timestamp is new immutable evidence and supersedes the abandoned credential.
      const retry = service.issueEmailVerification(
        db,
        { workspaceId: fixture.workspaceId },
        { callId: fixture.callId, email, tokenHash: HEX_64_B },
      );
      expect(retry.replayed).toBe(false);
      expect(
        db
          .prepare(
            `SELECT id, token_hash, created_at, issuance_sequence
             FROM cfp_email_verifications
             WHERE workspace_id = ? AND call_id = ? AND email = ?
             ORDER BY issuance_sequence`,
          )
          .all(fixture.workspaceId, fixture.callId, email),
      ).toEqual([
        {
          id: first.verificationId,
          token_hash: HEX_64_A,
          created_at: "2026-08-10T12:00:00.000Z",
          issuance_sequence: 1,
        },
        {
          id: retry.verificationId,
          token_hash: HEX_64_B,
          created_at: "2026-08-10T12:00:00.000Z",
          issuance_sequence: 2,
        },
      ]);
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            { callId: fixture.callId, email, tokenHash: HEX_64_A },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: first.verificationId,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_C,
              fullName: "Superseded V7 Applicant",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(
        service.consumeEmailVerification(
          db,
          { workspaceId: fixture.workspaceId },
          {
            callId: fixture.callId,
            verificationId: retry.verificationId,
            verificationTokenHash: HEX_64_B,
            applicantSessionTokenHash: HEX_64_C,
            fullName: "Current V7 Applicant",
          },
        ).replayed,
      ).toBe(false);
    } finally {
      closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group V7B: reopen, VACUUM, and reverse-order rebuild cannot change issuance authority", () => {
    const dbPath = resolve(
      ".tmp/unit",
      `cfp-v7-physical-order-${process.pid}.db`,
    );
    removeSqliteFiles(dbPath);
    let db: Db | null = openDb({ path: dbPath });
    try {
      const fixture = setupFixture(db, { state: "OPEN" });
      const service = createCfpApplicantAccess({
        now: () => "2026-08-10T12:00:00.000Z",
      });
      const email = "v7.physical.order@synthetic.example";
      const issued = [HEX_64_A, HEX_64_B, HEX_64_C].map((tokenHash) =>
        service.issueEmailVerification(
          db!,
          { workspaceId: fixture.workspaceId },
          { callId: fixture.callId, email, tokenHash },
        ),
      );
      closeDb(db);
      db = null;

      db = openDb({ path: dbPath, seed: false });
      expectCfpCode(
        () =>
          service.issueEmailVerification(
            db!,
            { workspaceId: fixture.workspaceId },
            { callId: fixture.callId, email, tokenHash: HEX_64_A },
          ),
        "VERIFICATION_REQUEST_REJECTED",
      );
      expect(
        service.issueEmailVerification(
          db,
          { workspaceId: fixture.workspaceId },
          { callId: fixture.callId, email, tokenHash: HEX_64_C },
        ),
      ).toEqual({ ...issued[2]!, replayed: true });
      closeDb(db);
      db = null;

      const vacuum = new DatabaseSync(dbPath);
      try {
        vacuum.exec("VACUUM");
      } finally {
        vacuum.close();
      }
      db = openDb({ path: dbPath, seed: false });
      expect(
        db
          .prepare(
            `SELECT id, issuance_sequence
             FROM cfp_email_verifications
             WHERE workspace_id = ? AND call_id = ? AND email = ?
             ORDER BY issuance_sequence`,
          )
          .all(fixture.workspaceId, fixture.callId, email),
      ).toEqual(
        issued.map((row, index) => ({
          id: row.verificationId,
          issuance_sequence: index + 1,
        })),
      );
      closeDb(db);
      db = null;

      const physicalOrder = rebuildVerificationTableInReverse(dbPath);
      expect(physicalOrder.after).toEqual([...physicalOrder.before].reverse());

      db = openDb({ path: dbPath, seed: false });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db
          .prepare(
            `SELECT id, issuance_sequence
             FROM cfp_email_verifications
             WHERE workspace_id = ? AND call_id = ? AND email = ?
             ORDER BY issuance_sequence`,
          )
          .all(fixture.workspaceId, fixture.callId, email),
      ).toEqual(
        issued.map((row, index) => ({
          id: row.verificationId,
          issuance_sequence: index + 1,
        })),
      );
      expectCfpCode(
        () =>
          service.consumeEmailVerification(
            db!,
            { workspaceId: fixture.workspaceId },
            {
              callId: fixture.callId,
              verificationId: issued[0]!.verificationId,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: HEX_64_D,
              fullName: "Rebuilt Superseded Applicant",
            },
          ),
        "VERIFICATION_INVALID",
      );
      expect(
        service.consumeEmailVerification(
          db,
          { workspaceId: fixture.workspaceId },
          {
            callId: fixture.callId,
            verificationId: issued[2]!.verificationId,
            verificationTokenHash: HEX_64_C,
            applicantSessionTokenHash: HEX_64_D,
            fullName: "Rebuilt Current Applicant",
          },
        ).replayed,
      ).toBe(false);
    } finally {
      if (db !== null) closeDb(db);
      removeSqliteFiles(dbPath);
    }
  });

  it("Evidence Group 11: exact bounded two-connection race matrix", async () => {
    type RaceKind =
      | "extension-same"
      | "issuance-same"
      | "issuance-different"
      | "consumption-same"
      | "consumption-different";
    type RaceOutcome = {
      ok: boolean;
      pid: number;
      code?: string;
      replayed?: boolean;
      id?: string;
      digest?: string;
    };

    if (process.env.SYMPOSE_PERSISTENT_RACE_ACTOR === "1") {
      return runPersistentRaceActor(() => {
        const raceDb = openDb({ path: process.env.CFP_RACE_DB!, seed: false });
        let outcome: RaceOutcome;
        try {
        const kind = process.env.CFP_RACE_KIND! as RaceKind;
        const contender = process.env.CFP_RACE_CONTENDER!;
        const workspaceId = process.env.CFP_RACE_WORKSPACE!;
        const callId = process.env.CFP_RACE_CALL!;
        const service = createCfpApplicantAccess({
          now: () =>
            kind.startsWith("consumption")
              ? "2026-08-10T12:05:00.000Z"
              : "2026-08-10T12:00:00.000Z",
        });

        let publicDb: Db;
        if (contender === "a") {
          publicDb = new Proxy(raceDb, {
            get(target, property) {
              if (property === "exec") {
                return (sql: string): void => {
                  target.exec(sql);
                  if (sql.trim() === "BEGIN IMMEDIATE") {
                    expect(target.isTransaction).toBe(true);
                    writeFileSync(
                      process.env.CFP_RACE_OWNER_MARKER!,
                      String(process.pid),
                      "utf8",
                    );
                    waitForMarker(process.env.CFP_RACE_RELEASE_MARKER!);
                  }
                };
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as Db;
        } else {
          requireRealSqliteBusyBeforeRelease(
            raceDb,
            process.env.CFP_RACE_OWNER_MARKER!,
            process.env.CFP_RACE_BUSY_MARKER!,
            process.env.CFP_RACE_RELEASE_MARKER!,
          );
          publicDb = raceDb;
        }

        if (kind === "extension-same") {
          const result = service.grantCallExtension(
            publicDb,
            buildOrganizerSession(
              raceDb,
              workspaceId,
              process.env.CFP_RACE_ACCOUNT!,
            ),
            {
              callId,
              personId: process.env.CFP_RACE_PERSON!,
              extendsTo: "2026-08-10T20:00:00.000Z",
              reason: "Concurrent extension",
              idempotencyKey: "race-extension-key",
            },
          );
          outcome = {
            ok: true,
            pid: process.pid,
            replayed: result.replayed,
            id: result.extensionId,
          };
        } else if (kind === "issuance-same" || kind === "issuance-different") {
          const digest =
            kind === "issuance-same" || contender === "a" ? HEX_64_A : HEX_64_B;
          const result = service.issueEmailVerification(
            publicDb,
            { workspaceId },
            {
              callId,
              email: process.env.CFP_RACE_EMAIL!,
              tokenHash: digest,
            },
          );
          outcome = {
            ok: true,
            pid: process.pid,
            replayed: result.replayed,
            id: result.verificationId,
            digest,
          };
        } else {
          const digest =
            kind === "consumption-same" || contender === "a" ? HEX_64_B : HEX_64_C;
          const result = service.consumeEmailVerification(
            publicDb,
            { workspaceId },
            {
              callId,
              verificationId: process.env.CFP_RACE_VERIFICATION!,
              verificationTokenHash: HEX_64_A,
              applicantSessionTokenHash: digest,
              fullName: `Concurrent Applicant ${contender.toUpperCase()}`,
            },
          );
          outcome = {
            ok: true,
            pid: process.pid,
            replayed: result.replayed,
            id: result.sessionId,
            digest,
          };
        }
      } catch (error) {
        outcome = {
          ok: false,
          pid: process.pid,
          code:
            error instanceof CfpApplicantAccessError
              ? error.code
              : "UNEXPECTED_ERROR",
        };
      } finally {
        closeDb(raceDb);
      }
        writeFileSync(process.env.CFP_RACE_RESULT!, JSON.stringify(outcome), "utf8");
      });
    }

    const children: PersistentRaceActor[] = [
      ...(await startPersistentRaceActors({
        testFile: "tests/unit/cfp-applicant-access.test.ts",
        testName: "Evidence Group 11: exact bounded two-connection race matrix$",
      })),
    ];
    const runRace = async (
      kind: RaceKind,
      prepare: (db: Db) => Record<string, string>,
      verify: (
        db: Db,
        outcomes: readonly RaceOutcome[],
        common: Readonly<Record<string, string>>,
      ) => void,
    ): Promise<void> => {
      const prefix = resolve(
        ".tmp/unit",
        `cfp-race-${kind}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const dbPath = `${prefix}.db`;
      const ownerMarker = `${prefix}.owner-held`;
      const busyMarker = `${prefix}.contender-busy`;
      const releaseMarker = `${prefix}.owner-release`;
      const resultPaths = [`${prefix}.a.json`, `${prefix}.b.json`];
      const artifactPaths = [
        ownerMarker,
        busyMarker,
        releaseMarker,
        ...resultPaths,
      ];
      for (const path of artifactPaths) rmSync(path, { force: true });
      removeSqliteFiles(dbPath);

      let setupDb: Db | null = openDb({ path: dbPath });
      const common = prepare(setupDb);
      closeDb(setupDb);
      setupDb = null;

      const runContender = (contender: "a" | "b", index: number): Promise<number> =>
        children[contender === "a" ? 0 : 1]!.request({
          ...common,
          CFP_RACE_KIND: kind,
          CFP_RACE_CONTENDER: contender,
          CFP_RACE_DB: dbPath,
          CFP_RACE_OWNER_MARKER: ownerMarker,
          CFP_RACE_BUSY_MARKER: busyMarker,
          CFP_RACE_RELEASE_MARKER: releaseMarker,
          CFP_RACE_RESULT: resultPaths[index]!,
        });

      try {
        const owner = runContender("a", 0);
        await waitForMarkers([ownerMarker]);
        const contender = runContender("b", 1);
        await waitForMarkers([ownerMarker, busyMarker]);
        const ownerPid = Number(readFileSync(ownerMarker, "utf8"));
        const busyProof = readSqliteBusyMarker(busyMarker);
        expect(ownerPid).not.toBe(busyProof.pid);
        writeFileSync(releaseMarker, "release", "utf8");
        expect(await Promise.all([owner, contender])).toEqual([0, 0]);
        const outcomes = resultPaths.map(
          (path) => JSON.parse(readFileSync(path, "utf8")) as RaceOutcome,
        );
        expect(outcomes[0]!.pid).toBe(ownerPid);
        expect(outcomes[1]!.pid).toBe(busyProof.pid);
        const verifyDb = openDb({ path: dbPath, seed: false });
        try {
          verify(verifyDb, outcomes, common);
        } finally {
          closeDb(verifyDb);
        }
      } finally {
        if (setupDb !== null) closeDb(setupDb);
        for (const path of artifactPaths) rmSync(path, { force: true });
        removeSqliteFiles(dbPath);
      }
      expect(
        [
          ...artifactPaths,
          dbPath,
          `${dbPath}-wal`,
          `${dbPath}-shm`,
          `${dbPath}-journal`,
        ].every((path) => !existsSync(path)),
      ).toBe(true);
    };

    try {
      await runRace(
      "extension-same",
      (db) => {
        const fixture = setupFixture(db, {
          state: "OPEN",
          closesAt: "2026-08-10T18:00:00.000Z",
        });
        const personId = "race-extension-person";
        db.prepare(
          "INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(
          personId,
          fixture.workspaceId,
          "race.extension@synthetic.example",
          "Race Extension Person",
          "2026-08-10T00:00:00.000Z",
        );
        return {
          CFP_RACE_WORKSPACE: fixture.workspaceId,
          CFP_RACE_CALL: fixture.callId,
          CFP_RACE_ACCOUNT: fixture.accountId,
          CFP_RACE_PERSON: personId,
        };
      },
      (db, outcomes, common) => {
        expect(outcomes[0]).toMatchObject({ ok: true, replayed: false });
        expect(outcomes[1]).toMatchObject({ ok: true, replayed: true });
        expect(outcomes[0]!.id).toBe(outcomes[1]!.id);
        expect(
          db
            .prepare(
              `SELECT id, workspace_id, call_id, person_id, extends_to, reason,
                      idempotency_key
               FROM call_extensions ORDER BY rowid`,
            )
            .all(),
        ).toEqual([
          {
            id: outcomes[0]!.id,
            workspace_id: common.CFP_RACE_WORKSPACE,
            call_id: common.CFP_RACE_CALL,
            person_id: "race-extension-person",
            extends_to: "2026-08-10T20:00:00.000Z",
            reason: "Concurrent extension",
            idempotency_key: "race-extension-key",
          },
        ]);
        expect(
          db
            .prepare(
              `SELECT workspace_id, actor_ref, action, target_type, target_id,
                      details_json
               FROM audit_events
               WHERE action = 'cfp.call.grant_extension'
               ORDER BY rowid`,
            )
            .all(),
        ).toEqual([
          {
            workspace_id: common.CFP_RACE_WORKSPACE,
            actor_ref: common.CFP_RACE_ACCOUNT,
            action: "cfp.call.grant_extension",
            target_type: "call_extension",
            target_id: outcomes[0]!.id,
            details_json: JSON.stringify({ granted: true }),
          },
        ]);
      },
    );

      for (const kind of ["issuance-same", "issuance-different"] as const) {
        await runRace(
        kind,
        (db) => {
          const fixture = setupFixture(db, { state: "OPEN" });
          return {
            CFP_RACE_WORKSPACE: fixture.workspaceId,
            CFP_RACE_CALL: fixture.callId,
            CFP_RACE_EMAIL: `race.${kind}@synthetic.example`,
          };
        },
        (db, outcomes, common) => {
          if (kind === "issuance-same") {
            expect(outcomes[0]).toMatchObject({ ok: true, replayed: false });
            expect(outcomes[1]).toMatchObject({ ok: true, replayed: true });
            expect(outcomes[0]!.id).toBe(outcomes[1]!.id);
          } else {
            expect(outcomes[0]).toMatchObject({ ok: true, replayed: false });
            expect(outcomes[1]).toMatchObject({ ok: true, replayed: false });
            expect(outcomes[0]!.id).not.toBe(outcomes[1]!.id);
          }
          const expectedRows = [
            {
              id: outcomes[0]!.id,
              workspace_id: common.CFP_RACE_WORKSPACE,
              call_id: common.CFP_RACE_CALL,
              email: `race.${kind}@synthetic.example`,
              token_hash: HEX_64_A,
              issuance_sequence: 1,
            },
            ...(kind === "issuance-different"
              ? [
                  {
                    id: outcomes[1]!.id,
                    workspace_id: common.CFP_RACE_WORKSPACE,
                    call_id: common.CFP_RACE_CALL,
                    email: `race.${kind}@synthetic.example`,
                    token_hash: HEX_64_B,
                    issuance_sequence: 2,
                  },
                ]
              : []),
          ];
          expect(
            db
              .prepare(
                `SELECT id, workspace_id, call_id, email, token_hash,
                        issuance_sequence
                 FROM cfp_email_verifications ORDER BY issuance_sequence`,
              )
              .all(),
          ).toEqual(expectedRows);

          if (kind === "issuance-different") {
            const service = createCfpApplicantAccess({
              now: () => "2026-08-10T12:00:00.000Z",
            });
            expectCfpCode(
              () =>
                service.issueEmailVerification(
                  db,
                  { workspaceId: common.CFP_RACE_WORKSPACE },
                  {
                    callId: common.CFP_RACE_CALL,
                    email: `race.${kind}@synthetic.example`,
                    tokenHash: HEX_64_A,
                  },
                ),
              "VERIFICATION_REQUEST_REJECTED",
            );
          }
        },
      );
    }

      for (const kind of ["consumption-same", "consumption-different"] as const) {
        await runRace(
        kind,
        (db) => {
          const fixture = setupFixture(db, { state: "OPEN" });
          const email = `race.${kind}@synthetic.example`;
          const issued = createCfpApplicantAccess({
            now: () => "2026-08-10T12:00:00.000Z",
          }).issueEmailVerification(
            db,
            { workspaceId: fixture.workspaceId },
            { callId: fixture.callId, email, tokenHash: HEX_64_A },
          );
          return {
            CFP_RACE_WORKSPACE: fixture.workspaceId,
            CFP_RACE_CALL: fixture.callId,
            CFP_RACE_VERIFICATION: issued.verificationId,
            CFP_RACE_EMAIL: email,
          };
        },
        (db, outcomes, common) => {
          if (kind === "consumption-same") {
            expect(outcomes[0]).toMatchObject({ ok: true, replayed: false });
            expect(outcomes[1]).toMatchObject({ ok: true, replayed: true });
            expect(outcomes[0]!.id).toBe(outcomes[1]!.id);
          } else {
            expect(outcomes[0]).toMatchObject({ ok: true, replayed: false });
            expect(outcomes[1]).toMatchObject({
              ok: false,
              code: "VERIFICATION_INVALID",
            });
          }
          const people = db
            .prepare(
              `SELECT id, workspace_id, canonical_email, full_name
               FROM people ORDER BY rowid`,
            )
            .all() as Array<{
            id: string;
            workspace_id: string;
            canonical_email: string;
            full_name: string;
          }>;
          expect(people).toEqual([
            {
              id: people[0]!.id,
              workspace_id: common.CFP_RACE_WORKSPACE,
              canonical_email: `race.${kind}@synthetic.example`,
              full_name: "Concurrent Applicant A",
            },
          ]);
          expect(
            db
              .prepare(
                `SELECT workspace_id, verification_id, person_id
                 FROM cfp_email_verification_consumptions ORDER BY rowid`,
              )
              .all(),
          ).toEqual([
            {
              workspace_id: common.CFP_RACE_WORKSPACE,
              verification_id: common.CFP_RACE_VERIFICATION,
              person_id: people[0]!.id,
            },
          ]);
          expect(
            db
              .prepare(
                `SELECT id, workspace_id, call_id, person_id, verification_id,
                        token_hash
                 FROM cfp_applicant_sessions ORDER BY rowid`,
              )
              .all(),
          ).toEqual([
            {
              id: outcomes[0]!.id,
              workspace_id: common.CFP_RACE_WORKSPACE,
              call_id: common.CFP_RACE_CALL,
              person_id: people[0]!.id,
              verification_id: common.CFP_RACE_VERIFICATION,
              token_hash: HEX_64_B,
            },
          ]);
        },
      );
      }
    } finally {
      await stopPersistentRaceActors(children);
      expect(
        children.every(
          (child) => child.exitCode === 0 && child.signalCode === null,
        ),
      ).toBe(true);
    }
  }, 120_000);
});
