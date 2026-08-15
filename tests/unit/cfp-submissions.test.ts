import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { SessionInfo } from "../../src/server/auth";
import type { Db } from "../../src/server/db";
import { closeDb, openDb, withTransaction } from "../../src/server/db";
import { createCfpApplicantAccess, CfpApplicantAccessError } from "../../src/server/services/cfp/applicant-access";
import {
  FormDocumentPersistenceError,
  createCfpPersistence,
  type CreatedSubmission,
  type OrganizerContext,
  type SavedSubmissionRevision,
} from "../../src/server/services/cfp/form-documents";
import {
  evaluateConditionalForm,
  FORM_RULES_SCHEMA,
  FormEvaluationError,
} from "../../src/server/services/cfp/form-evaluator";
import { FormDocumentError } from "../../src/server/services/cfp/form-types";
import { FormSafetyError } from "../../src/server/services/cfp/form-safety";
import { createEventWithUnit } from "../../src/server/services/events";
import {
  CfpSubmissionCommandError,
  CfpSubmissionCommandFatalError,
  createCfpSubmissionCommands,
  createSubmissionDraft,
  saveSubmissionDraft,
  submitSubmission,
  type CfpSubmissionCommandErrorCode,
  type CfpSubmissionCommandOptions,
  type CfpSubmissionCommands,
  type CreateSubmissionDraftInput,
  type SaveSubmissionDraftInput,
  type SubmitSubmissionInput,
} from "../../src/server/services/cfp/submissions";
import {
  runPersistentRaceActor,
  startPersistentRaceActors,
  stopPersistentRaceActors,
  type PersistentRaceActor,
} from "./helpers/persistent-race-actor";

const FIXTURE_AT = "2026-08-10T00:00:00.000Z";
const COMMAND_AT = "2026-08-10T12:00:00.000Z";
const LATER_AT = "2026-08-10T18:00:00.000Z";
const AFTER_HISTORICAL_SESSION_AT = "2026-08-10T20:00:00.000Z";
const CALL_CLOSES_AT = "2026-08-11T00:00:00.000Z";
const SESSION_EXPIRES_AT = "2026-08-12T00:00:00.000Z";
const EXTENSION_ENDS_AT = "2026-08-12T12:00:00.000Z";
const VERIFICATION_EXPIRES_AT = "2026-08-13T00:00:00.000Z";
const AFTER_SESSION_AT = "2026-08-12T06:00:00.000Z";

const COMPILE_TIME_DIGEST =
  "1111111122222222333333334444444455555555666666667777777788888888";
const UNKNOWN_DIGEST = "0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978";

/**
 * Session and verification digests are unique per row in this schema, so every fixture digest is
 * derived from its label. Each derived digest is also remembered so the leak assertion can prove
 * that no failure message ever repeats one back to a caller.
 */
const ISSUED_DIGESTS = new Set<string>([COMPILE_TIME_DIGEST, UNKNOWN_DIGEST]);

function digestFor(label: string): string {
  const digest = createHash("sha256").update(`sympose-synthetic-${label}`).digest("hex");
  ISSUED_DIGESTS.add(digest);
  return digest;
}

function offsetInstant(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

const SECRET_ANSWER = "synthetic-secret-proposal-body";

const STABLE_COMMAND_MESSAGES: Record<CfpSubmissionCommandErrorCode, string> = {
  COMMAND_INPUT_INVALID: "The CFP submission command input is invalid.",
  SUBMISSION_NOT_FOUND: "The CFP submission was not found.",
  SUBMISSION_NOT_DRAFT: "The CFP submission is not a draft.",
  SUBMISSION_STALE: "The CFP submission revision is stale.",
  SUBMISSION_INCOMPLETE: "The CFP submission is incomplete.",
  SUBMISSION_WRITE_FAILED: "The CFP submission write failed.",
};

// These assignments are compile-time authority proofs, not runtime fixtures.
const CREATE_COMMAND_KEYS: Record<keyof CreateSubmissionDraftInput, true> = {
  workspaceId: true,
  callId: true,
  sessionTokenHash: true,
};
const SAVE_COMMAND_KEYS: Record<keyof SaveSubmissionDraftInput, true> = {
  workspaceId: true,
  callId: true,
  sessionTokenHash: true,
  submissionId: true,
  historicalAnswers: true,
  expectedCurrentRevisionId: true,
};
const SUBMIT_COMMAND_KEYS: Record<keyof SubmitSubmissionInput, true> = {
  workspaceId: true,
  callId: true,
  sessionTokenHash: true,
  submissionId: true,
  historicalAnswers: true,
  expectedCurrentRevisionId: true,
};
const forbiddenEffectiveAnswers: SaveSubmissionDraftInput = {
  workspaceId: "compile-time-workspace",
  callId: "compile-time-call",
  sessionTokenHash: COMPILE_TIME_DIGEST,
  submissionId: "compile-time-submission",
  historicalAnswers: [],
  expectedCurrentRevisionId: null,
  // @ts-expect-error A caller must not acquire revision authority by choosing effective answers.
  effectiveAnswers: [],
};
const forbiddenIdentityOverride: SubmitSubmissionInput = {
  workspaceId: "compile-time-workspace",
  callId: "compile-time-call",
  sessionTokenHash: COMPILE_TIME_DIGEST,
  submissionId: "compile-time-submission",
  historicalAnswers: [],
  expectedCurrentRevisionId: null,
  // @ts-expect-error Owner identity is derived from the resolved session, never from a caller.
  ownerPersonId: "compile-time-person",
};
const forbiddenStateOverride: SubmitSubmissionInput = {
  workspaceId: "compile-time-workspace",
  callId: "compile-time-call",
  sessionTokenHash: COMPILE_TIME_DIGEST,
  submissionId: "compile-time-submission",
  historicalAnswers: [],
  expectedCurrentRevisionId: null,
  // @ts-expect-error Lifecycle state and its timestamp are derived by the server.
  submittedAt: "2026-08-10T12:00:00.000Z",
};
const forbiddenRevisionSelection: SubmitSubmissionInput = {
  workspaceId: "compile-time-workspace",
  callId: "compile-time-call",
  sessionTokenHash: COMPILE_TIME_DIGEST,
  submissionId: "compile-time-submission",
  historicalAnswers: [],
  expectedCurrentRevisionId: null,
  // @ts-expect-error Submit writes and submits its own revision; a caller cannot select one.
  revisionId: "compile-time-revision",
};
void CREATE_COMMAND_KEYS;
void SAVE_COMMAND_KEYS;
void SUBMIT_COMMAND_KEYS;
void forbiddenEffectiveAnswers;
void forbiddenIdentityOverride;
void forbiddenStateOverride;
void forbiddenRevisionSelection;

const TRUTH_TABLES = [
  "workspaces",
  "accounts",
  "people",
  "events",
  "form_definitions",
  "rule_versions",
  "form_versions",
  "calls",
  "call_extensions",
  "cfp_email_verifications",
  "cfp_email_verification_consumptions",
  "cfp_applicant_sessions",
  "submissions",
  "submission_revisions",
  "audit_events",
] as const;

type ApplicantFixture = {
  readonly personId: string;
  readonly sessionId: string;
  readonly sessionTokenHash: string;
};

type Fixture = {
  readonly organizer: OrganizerContext;
  readonly workspaceId: string;
  readonly callId: string;
  readonly formVersionId: string;
  readonly fields: unknown;
  readonly ruleSet: unknown;
  readonly applicant: ApplicantFixture;
  readonly other: ApplicantFixture;
};

function organizerSessionFor(db: Db, organizer: OrganizerContext): SessionInfo {
  const row = db
    .prepare(
      `SELECT account.email, account.display_name, account.role,
              workspace.slug, workspace.name
       FROM accounts account
       JOIN workspaces workspace ON workspace.id = account.workspace_id
       WHERE account.id = ? AND account.workspace_id = ?`,
    )
    .get(organizer.accountId, organizer.workspaceId) as {
    email: string;
    display_name: string;
    role: string;
    slug: string;
    name: string;
  };
  return {
    id: "synthetic-organizer-session",
    tokenHash: digestFor("organizer-session"),
    accountId: organizer.accountId,
    workspaceId: organizer.workspaceId,
    expiresAt: "2029-01-01T00:00:00.000Z",
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    workspaceSlug: row.slug,
    workspaceName: row.name,
  };
}

function removeSqliteFiles(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(target, { force: true });
  }
}

function waitForMarker(path: string, timeoutMs = 20_000): void {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error("Bounded race coordination marker was not created.");
    }
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

async function waitForMarkers(paths: readonly string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) {
      throw new Error("Bounded race coordination markers were not created.");
    }
    await new Promise<void>((settle) => setTimeout(settle, 20));
  }
}

type SqliteBusyMarker = {
  readonly pid: number;
  readonly nodeCode: "ERR_SQLITE_ERROR";
  readonly sqliteCode: 5;
};

function readSqliteBusyTimeout(db: Db): number {
  const row = db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>;
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

/**
 * Prove that the competing connection genuinely collided with a held write transaction. Without
 * this the whole harness could degrade into two sequential commands wearing a race costume.
 */
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

function withBeforeFirstPrepare(db: Db, matcher: RegExp, before: () => void): Db {
  let armed = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (armed && matcher.test(sql)) {
            armed = false;
            before();
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withPrepareFailure(db: Db, matcher: RegExp, sentinel: string): Db {
  let armed = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (armed && matcher.test(sql)) {
            armed = false;
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

type ExecStatementMatcher = string | RegExp;

function matchesExecStatement(sql: string, matcher: ExecStatementMatcher): boolean {
  const statement = sql.trim();
  return typeof matcher === "string" ? statement === matcher : matcher.test(statement);
}

function ownedSavepointStatement(
  command: "SAVEPOINT" | "ROLLBACK TO SAVEPOINT" | "RELEASE SAVEPOINT",
  baseName: string,
): RegExp {
  return new RegExp(`^${command} "${baseName}_[0-9a-f]{32}"$`, "u");
}

function withOneExecFailure(
  db: Db,
  statement: ExecStatementMatcher,
  sentinel: string,
  onFailure?: () => void,
): Db {
  let armed = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (armed && matchesExecStatement(sql, statement)) {
            armed = false;
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

function withOneSilentExec(
  db: Db,
  statement: ExecStatementMatcher,
  onSilent?: () => void,
): Db {
  let armed = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (armed && matchesExecStatement(sql, statement)) {
            armed = false;
            onSilent?.();
            return;
          }
          target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function withPersistentExecFailure(
  db: Db,
  statement: ExecStatementMatcher,
  sentinel: string,
  onFailure?: (sql: string) => void,
): Db {
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (matchesExecStatement(sql, statement)) {
            onFailure?.(sql.trim());
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

function withPersistentPrepareFailure(
  db: Db,
  statement: ExecStatementMatcher,
  sentinel: string,
  onFailure?: (sql: string) => void,
): Db {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (matchesExecStatement(sql, statement)) {
            onFailure?.(sql.trim());
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

function withOneAfterExec(
  db: Db,
  statement: ExecStatementMatcher,
  after: () => void,
): Db {
  let armed = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          target.exec(sql);
          if (armed && matchesExecStatement(sql, statement)) {
            armed = false;
            after();
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function insertApplicant(
  db: Db,
  workspaceId: string,
  callId: string,
  prefix: string,
  sessionExpiresAt = SESSION_EXPIRES_AT,
): ApplicantFixture {
  const sessionTokenHash = digestFor(`${prefix}-session`);
  const verificationTokenHash = digestFor(`${prefix}-verification`);
  const personId = `${prefix}-person`;
  const email = `${prefix}@synthetic.example`;
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(personId, workspaceId, email, "Synthetic Applicant", FIXTURE_AT);

  const verificationId = `${prefix}-verification`;
  const sessionId = `${prefix}-session`;
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verificationId,
    workspaceId,
    callId,
    email,
    verificationTokenHash,
    VERIFICATION_EXPIRES_AT,
    FIXTURE_AT,
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`${prefix}-consumption`, workspaceId, verificationId, personId, FIXTURE_AT);
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    workspaceId,
    callId,
    personId,
    verificationId,
    sessionTokenHash,
    FIXTURE_AT,
    sessionExpiresAt,
  );
  return { personId, sessionId, sessionTokenHash };
}

function insertSessionForPerson(
  db: Db,
  workspaceId: string,
  callId: string,
  personId: string,
  prefix: string,
  sessionExpiresAt = SESSION_EXPIRES_AT,
): ApplicantFixture {
  const person = db
    .prepare("SELECT canonical_email FROM people WHERE id = ? AND workspace_id = ?")
    .get(personId, workspaceId) as { canonical_email: string };
  const sessionTokenHash = digestFor(`${prefix}-session`);
  const verificationId = `${prefix}-verification`;
  const sessionId = `${prefix}-session`;
  const issuanceSequence = (
    db
      .prepare(
        `SELECT COALESCE(MAX(issuance_sequence), 0) + 1 AS next_sequence
         FROM cfp_email_verifications
         WHERE workspace_id = ? AND call_id = ? AND email = ?`,
      )
      .get(workspaceId, callId, person.canonical_email) as {
      next_sequence: number;
    }
  ).next_sequence;
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at,
        issuance_sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verificationId,
    workspaceId,
    callId,
    person.canonical_email,
    digestFor(`${prefix}-verification`),
    VERIFICATION_EXPIRES_AT,
    FIXTURE_AT,
    issuanceSequence,
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`${prefix}-consumption`, workspaceId, verificationId, personId, FIXTURE_AT);
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    workspaceId,
    callId,
    personId,
    verificationId,
    sessionTokenHash,
    FIXTURE_AT,
    sessionExpiresAt,
  );
  return { personId, sessionId, sessionTokenHash };
}

function setupFixture(
  db: Db,
  options?: {
    readonly slug?: string;
    readonly state?: "OPEN" | "PAUSED" | "CLOSED";
    readonly sessionExpiresAt?: string;
  },
): Fixture {
  const slug = options?.slug ?? "primary";
  const workspace = db.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as {
    id: string;
  };
  const account = db
    .prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1")
    .get(workspace.id) as { id: string };
  const organizer: OrganizerContext = { workspaceId: workspace.id, accountId: account.id };
  const persistence = createCfpPersistence({ clock: () => FIXTURE_AT });

  db.prepare(
    `INSERT OR IGNORE INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "submissions-event",
    organizer.workspaceId,
    "Synthetic submissions event",
    "UTC",
    "2026-09-15T09:00:00.000Z",
    "2026-09-15T10:00:00.000Z",
    FIXTURE_AT,
  );

  const definition = persistence.createFormDefinition(db, organizer, {
    name: `Submissions form ${slug}`,
  });
  const sealed = persistence.sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [
      { id: "trigger", type: "shortText", label: "Trigger", required: false, defaultVisibility: "visible" },
      { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
      { id: "title", type: "shortText", label: "Title", required: false, defaultVisibility: "visible" },
    ],
    rules: {
      schema: FORM_RULES_SCHEMA,
      rules: [
        {
          id: "hide-consent",
          condition: { kind: "field", fieldId: "trigger", operator: "equals", value: "hide" },
          actions: [{ type: "hide", targetFieldId: "consent" }],
        },
      ],
    },
  });
  const call = persistence.createCall(db, organizer, {
    eventId: "submissions-event",
    name: `Synthetic call ${slug}`,
    slug: `submissions-call-${slug}`,
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
      choices: [{ fieldId: "consent", statement: "Allow publication", required: true }],
    },
    accessMode: "PUBLIC",
    state: options?.state ?? "OPEN",
    timezone: "UTC",
    opensAt: FIXTURE_AT,
    closesAt: CALL_CLOSES_AT,
  });

  return {
    organizer,
    workspaceId: organizer.workspaceId,
    callId: call.id,
    formVersionId: sealed.id,
    fields: sealed.document.fields,
    ruleSet: sealed.ruleVersion.rules,
    applicant: insertApplicant(
      db,
      organizer.workspaceId,
      call.id,
      `${slug}-owner`,
      options?.sessionExpiresAt,
    ),
    other: insertApplicant(
      db,
      organizer.workspaceId,
      call.id,
      `${slug}-other`,
      options?.sessionExpiresAt,
    ),
  };
}

function commandsAt(
  now: string,
  overrides?: CfpSubmissionCommandOptions,
  persistenceNow = now,
): CfpSubmissionCommands {
  const access = createCfpApplicantAccess({ now: () => now });
  const persistence = createCfpPersistence({ clock: () => persistenceNow });
  return createCfpSubmissionCommands({
    clock: () => now,
    resolveApplicantSession: (db, input) => access.resolveApplicantSession(db, input),
    assertApplicantAccess: (db, input) => access.assertApplicantAccess(db, input),
    createDraftSubmission: (db, context, input) => persistence.createDraftSubmission(db, context, input),
    saveDraftRevision: (db, context, input) => persistence.saveDraftRevision(db, context, input),
    ...overrides,
  });
}

/** Use the production O2A seams while shifting only the accepted access and command clocks. */
function commandsWithDefaultPersistenceAt(now: string): CfpSubmissionCommands {
  const access = createCfpApplicantAccess({ now: () => now });
  return createCfpSubmissionCommands({
    clock: () => now,
    resolveApplicantSession: (db, input) => access.resolveApplicantSession(db, input),
    assertApplicantAccess: (db, input) => access.assertApplicantAccess(db, input),
  });
}

function identityOf(fixture: Fixture, applicant: ApplicantFixture = fixture.applicant) {
  return {
    workspaceId: fixture.workspaceId,
    callId: fixture.callId,
    sessionTokenHash: applicant.sessionTokenHash,
  };
}

function completeAnswers(): unknown {
  return [
    { fieldId: "consent", value: true },
    { fieldId: "title", value: SECRET_ANSWER },
  ];
}

function hiddenConsentAnswers(): unknown {
  return [
    { fieldId: "consent", value: true },
    { fieldId: "title", value: SECRET_ANSWER },
    { fieldId: "trigger", value: "hide" },
  ];
}

function nestedAnswers(depth: number): unknown {
  let value: unknown = "deep";
  for (let level = 0; level < depth; level += 1) {
    value = { nested: value };
  }
  return [{ fieldId: "title", value }];
}

function refusedConsentAnswers(): unknown {
  return [
    { fieldId: "consent", value: false },
    { fieldId: "title", value: SECRET_ANSWER },
  ];
}

function truthSnapshot(db: Db): Record<string, unknown> {
  return Object.fromEntries(
    TRUTH_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

function submissionRow(db: Db, submissionId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM submissions WHERE id = ?").get(submissionId) as Record<
    string,
    unknown
  >;
}

function revisionRows(db: Db, submissionId: string): Record<string, unknown>[] {
  return db
    .prepare("SELECT * FROM submission_revisions WHERE submission_id = ? ORDER BY revision_number")
    .all(submissionId) as Record<string, unknown>[];
}

function expectFailure(operation: () => unknown): Error {
  let thrown: unknown;
  let threw = false;
  try {
    operation();
  } catch (error) {
    thrown = error;
    threw = true;
  }
  if (!threw) {
    throw new Error("Expected the command to fail.");
  }
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
}

function expectOwnedSavepointMissing(db: Db, name: string): void {
  expect(db.isTransaction).toBe(true);
  const error = expectFailure(() => db.prepare(`ROLLBACK TO SAVEPOINT "${name}"`).run());
  expect((error as Error & { readonly code?: unknown }).code).toBe("ERR_SQLITE_ERROR");
  expect(error.message).toBe(`no such savepoint: ${name}`);
}

function expectCommandCode(
  operation: () => unknown,
  code: CfpSubmissionCommandErrorCode,
): CfpSubmissionCommandError {
  const error = expectFailure(operation);
  expect(error).toBeInstanceOf(CfpSubmissionCommandError);
  expect((error as CfpSubmissionCommandError).code).toBe(code);
  expect(error.message).toBe(STABLE_COMMAND_MESSAGES[code]);
  expectNoLeak(error);
  return error as CfpSubmissionCommandError;
}

function expectFatalStop(operation: () => unknown): CfpSubmissionCommandFatalError {
  const error = expectFailure(operation);
  expect(error).toBeInstanceOf(CfpSubmissionCommandFatalError);
  expect((error as CfpSubmissionCommandFatalError).fatal).toBe(true);
  expect(error.message).toBe("The CFP submission command cannot continue safely.");
  expectNoLeak(error);
  return error as CfpSubmissionCommandFatalError;
}

function captureWithFatalConnectionRetirement(
  db: Db,
  operation: () => unknown,
): Readonly<{ error: Error; retired: boolean }> {
  const error = expectFailure(operation);
  if (!(error instanceof CfpSubmissionCommandFatalError)) {
    return Object.freeze({ error, retired: false });
  }
  closeDb(db);
  return Object.freeze({ error, retired: true });
}

function expectConnectionRetired(db: Db): void {
  expect(expectFailure(() => db.prepare("SELECT 1"))).toMatchObject({
    code: "ERR_INVALID_STATE",
  });
}

function expectAccessCode(operation: () => unknown, code: string): CfpApplicantAccessError {
  const error = expectFailure(operation);
  expect(error).toBeInstanceOf(CfpApplicantAccessError);
  expect((error as CfpApplicantAccessError).code).toBe(code);
  expectNoLeak(error);
  return error as CfpApplicantAccessError;
}

function expectPersistenceCode(
  operation: () => unknown,
  code: string,
): FormDocumentPersistenceError {
  const error = expectFailure(operation);
  expect(error).toBeInstanceOf(FormDocumentPersistenceError);
  expect((error as FormDocumentPersistenceError).code).toBe(code);
  expectNoLeak(error);
  return error as FormDocumentPersistenceError;
}

const FORBIDDEN_ERROR_TEXT = [
  SECRET_ANSWER,
  "SQLITE",
  "sqlite",
  "UPDATE submissions",
  "INSERT INTO",
  "SELECT",
  "current pointer mismatch",
  "must start as draft",
  "workspace mismatch",
  "token",
  "person",
  "raw-session-token",
] as const;

function expectNoLeak(error: Error): void {
  const text = `${error.name}|${error.message}|${String(
    (error as { readonly code?: unknown }).code ?? "",
  )}`;
  for (const forbidden of [...FORBIDDEN_ERROR_TEXT, ...ISSUED_DIGESTS]) {
    expect(text).not.toContain(forbidden);
  }
}

function createAndSave(
  db: Db,
  commands: CfpSubmissionCommands,
  fixture: Fixture,
  answers: unknown = completeAnswers(),
): { readonly created: CreatedSubmission; readonly saved: SavedSubmissionRevision } {
  const created = commands.createSubmissionDraft(db, identityOf(fixture));
  const saved = commands.saveSubmissionDraft(db, {
    ...identityOf(fixture),
    submissionId: created.id,
    historicalAnswers: answers,
    expectedCurrentRevisionId: null,
  });
  return { created, saved };
}

function allowSyntheticHistoryCorruption(db: Db): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA ignore_check_constraints = ON");
  for (const trigger of [
    "trg_cfp_submissions_workspace_update_guard",
    "trg_cfp_submission_revisions_workspace_guard",
    "trg_cfp_submission_revisions_immutable",
    "trg_cfp_applicant_sessions_core_immutable",
    "trg_cfp_email_verifications_immutable",
    "trg_cfp_email_verification_consumptions_immutable",
    "trg_cfp_rule_versions_immutable",
    "trg_cfp_form_versions_immutable",
  ]) {
    db.exec(`DROP TRIGGER IF EXISTS "${trigger}"`);
  }
}

function expectOpaqueCreateReplayFailure(
  db: Db,
  identity: CreateSubmissionDraftInput,
  at = COMMAND_AT,
): void {
  const before = truthSnapshot(db);
  let writerHits = 0;
  const error = expectCommandCode(
    () =>
      commandsAt(at, {
        createDraftSubmission: () => {
          writerHits += 1;
          throw new Error("CORRUPT_DURABLE_REPLAY_REENTERED_WRITER");
        },
      }).createSubmissionDraft(db, identity),
    "SUBMISSION_WRITE_FAILED",
  );
  expect(error.message).toBe(STABLE_COMMAND_MESSAGES.SUBMISSION_WRITE_FAILED);
  expect(writerHits).toBe(0);
  expect(truthSnapshot(db)).toEqual(before);
}

describe("CFP submission commands", () => {
  it("Evidence Group 1: runs the strict create, save, and submit journey", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);

      const created = commands.createSubmissionDraft(db, identityOf(fixture));
      expect(created).toMatchObject({
        workspaceId: fixture.workspaceId,
        callId: fixture.callId,
        ownerPersonId: fixture.applicant.personId,
        pinnedFormVersionId: fixture.formVersionId,
      });
      expect(submissionRow(db, created.id)).toMatchObject({
        state: "DRAFT",
        current_revision_id: null,
        owner_person_id: fixture.applicant.personId,
        created_at: COMMAND_AT,
      });

      const first = commands.saveSubmissionDraft(db, {
        ...identityOf(fixture),
        submissionId: created.id,
        historicalAnswers: [{ fieldId: "title", value: SECRET_ANSWER }],
        expectedCurrentRevisionId: null,
      });
      expect(first.revision.revisionNumber).toBe(1);
      expect(first.revision.consentReceipt).toBeNull();
      expect(submissionRow(db, created.id)).toMatchObject({
        state: "DRAFT",
        current_revision_id: first.revisionId,
      });

      const second = commands.saveSubmissionDraft(db, {
        ...identityOf(fixture),
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: first.revisionId,
      });
      expect(second.revision.revisionNumber).toBe(2);
      expect(second.revision.consentReceipt).not.toBeNull();

      const firstRowAfterSecondSave = revisionRows(db, created.id)[0];
      const submitted = commands.submitSubmission(db, {
        ...identityOf(fixture),
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: second.revisionId,
      });

      const rows = revisionRows(db, created.id);
      expect(rows.map((row) => row.revision_number)).toEqual([1, 2, 3]);
      expect(rows[2]!.id).toBe(submitted.revisionId);
      // The first revision is byte-identical after two later writes: history is append-only.
      expect(rows[0]).toEqual(firstRowAfterSecondSave);
      expect(submitted.submissionId).toBe(created.id);
      expect(submitted.submittedAt).toBe(COMMAND_AT);
      expect(submissionRow(db, created.id)).toMatchObject({
        state: "SUBMITTED",
        current_revision_id: submitted.revisionId,
        updated_at: submitted.submittedAt,
      });
      // Submit writes and submits its own fresh revision rather than an earlier one.
      expect(submitted.revisionId).not.toBe(second.revisionId);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence O2C-R2A: durably replays the exact original before and after lifecycle changes", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const persistence = createCfpPersistence({ clock: () => COMMAND_AT });
      let writerHits = 0;
      const commands = commandsAt(COMMAND_AT, {
        createDraftSubmission: (probeDb, context, input) => {
          writerHits += 1;
          return persistence.createDraftSubmission(probeDb, context, input);
        },
      });
      const identity = identityOf(fixture);

      // The first return is deliberately treated as transport-lost. Recovery has only the same
      // authenticated command; no cookie or caller-supplied idempotency token is involved.
      const transportLost = commands.createSubmissionDraft(db, identity);
      const recovered = commands.createSubmissionDraft(db, identity);
      expect(recovered).toEqual(transportLost);
      expect(Object.isFrozen(transportLost)).toBe(true);
      expect(Object.isFrozen(recovered)).toBe(true);
      expect(writerHits).toBe(1);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM submissions
             WHERE workspace_id = ? AND call_id = ? AND owner_person_id = ?`,
          )
          .get(fixture.workspaceId, fixture.callId, fixture.applicant.personId),
      ).toEqual({ count: 1 });

      const saved = commands.saveSubmissionDraft(db, {
        ...identity,
        submissionId: recovered.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: null,
      });
      let beforeReplay = truthSnapshot(db);
      expect(commands.createSubmissionDraft(db, identity)).toEqual(transportLost);
      expect(truthSnapshot(db)).toEqual(beforeReplay);
      expect(writerHits).toBe(1);

      commands.submitSubmission(db, {
        ...identity,
        submissionId: recovered.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: saved.revisionId,
      });
      beforeReplay = truthSnapshot(db);
      const terminalReplay = commandsAt(LATER_AT, {
        createDraftSubmission: () => {
          throw new Error("REPLAY_MUST_NOT_REENTER_CREATE_WRITER");
        },
      }).createSubmissionDraft(db, identity);
      expect(terminalReplay).toEqual(transportLost);
      expect(truthSnapshot(db)).toEqual(beforeReplay);

      // Durable identity remains scoped by both person and call.
      const otherApplicant = commands.createSubmissionDraft(
        db,
        identityOf(fixture, fixture.other),
      );
      const otherCall = setupFixture(db, { slug: "durable-independent" });
      const otherCallDraft = commands.createSubmissionDraft(db, identityOf(otherCall));
      expect(new Set([recovered.id, otherApplicant.id, otherCallDraft.id]).size).toBe(3);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence O2C-R2B: authorizes before private replay truth", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const identity = identityOf(fixture);
      commandsAt(COMMAND_AT).createSubmissionDraft(db, identity);
      let candidateReads = 0;
      const observedDb = withBeforeFirstPrepare(
        db,
        /typeof\(current_revision_id\) AS current_revision_storage[\s\S]*FROM submissions/u,
        () => {
          candidateReads += 1;
        },
      );
      const denied = commandsAt(COMMAND_AT, {
        assertApplicantAccess: () => {
          throw new CfpApplicantAccessError("CALL_NOT_ACCEPTING");
        },
      });
      expectAccessCode(() => denied.createSubmissionDraft(observedDb, identity), "CALL_NOT_ACCEPTING");
      expect(candidateReads).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence O2C-R2C: rejects incoherent create dependency envelopes with rollback", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const identity = identityOf(fixture);
      const persistence = createCfpPersistence({ clock: () => COMMAND_AT });
      const probes: ReadonlyArray<{
        readonly label: string;
        readonly writer: NonNullable<CfpSubmissionCommandOptions["createDraftSubmission"]>;
      }> = [
        {
          label: "wrong scope",
          writer: (probeDb, context, input) => ({
            ...persistence.createDraftSubmission(probeDb, context, input),
            workspaceId: "foreign-workspace",
          }),
        },
        {
          label: "accessor envelope",
          writer: (probeDb, context, input) => {
            const created = persistence.createDraftSubmission(probeDb, context, input);
            const unsafe = { ...created } as Record<string, unknown>;
            Object.defineProperty(unsafe, "id", {
              enumerable: true,
              get: () => created.id,
            });
            return unsafe as unknown as CreatedSubmission;
          },
        },
        {
          label: "proxy envelope",
          writer: (probeDb, context, input) =>
            new Proxy(
              persistence.createDraftSubmission(probeDb, context, input),
              {},
            ),
        },
        {
          label: "unpersisted envelope",
          writer: (_probeDb, context, input) => ({
            id: "fabricated-submission",
            workspaceId: context.workspaceId,
            eventId: "submissions-event",
            callId: input.callId,
            ownerPersonId: fixture.applicant.personId,
            pinnedFormVersionId: fixture.formVersionId,
            pinnedRuleVersionId: "fabricated-rule",
          }),
        },
      ];

      for (const probe of probes) {
        const before = truthSnapshot(db);
        const error = expectCommandCode(
          () =>
            commandsAt(COMMAND_AT, {
              createDraftSubmission: probe.writer,
            }).createSubmissionDraft(db, identity),
          "SUBMISSION_WRITE_FAILED",
        );
        expect(error.message).not.toContain(probe.label);
        expect(truthSnapshot(db)).toEqual(before);
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("Evidence O2C-R2D: fails closed on ambiguous, aliased, and corrupt persisted candidates", () => {
    const corruptions: ReadonlyArray<{
      readonly label: string;
      readonly mutate: (db: Db, fixture: Fixture, created: CreatedSubmission) => void;
    }> = [
      {
        label: "multiple exact candidates",
        mutate: (probeDb, _fixture, created) => {
          probeDb
            .prepare(
              `INSERT INTO submissions
                 (id, workspace_id, event_id, call_id, owner_person_id, state,
                  pinned_form_version_id, pinned_rule_version_id, current_revision_id,
                  created_at, updated_at)
               SELECT ?, workspace_id, event_id, call_id, owner_person_id, state,
                      pinned_form_version_id, pinned_rule_version_id, current_revision_id,
                      created_at, updated_at
               FROM submissions WHERE id = ?`,
            )
            .run("ambiguous-submission", created.id);
        },
      },
      {
        label: "BLOB workspace alias",
        mutate: (probeDb, _fixture, created) => {
          probeDb
            .prepare("UPDATE submissions SET workspace_id = CAST(workspace_id AS BLOB) WHERE id = ?")
            .run(created.id);
        },
      },
      {
        label: "foreign event mirror",
        mutate: (probeDb, fixture, created) => {
          const foreignWorkspace = probeDb
            .prepare("SELECT id FROM workspaces WHERE id <> ? ORDER BY id LIMIT 1")
            .get(fixture.workspaceId) as { id: string };
          probeDb
            .prepare(
              `INSERT INTO events
                 (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              "foreign-replay-event",
              foreignWorkspace.id,
              "Foreign replay event",
              "UTC",
              "2026-09-16T09:00:00.000Z",
              "2026-09-16T10:00:00.000Z",
              FIXTURE_AT,
            );
          probeDb
            .prepare("UPDATE submissions SET event_id = ? WHERE id = ?")
            .run("foreign-replay-event", created.id);
        },
      },
      {
        label: "corrupt pins",
        mutate: (probeDb, _fixture, created) => {
          probeDb
            .prepare("UPDATE submissions SET pinned_rule_version_id = pinned_form_version_id WHERE id = ?")
            .run(created.id);
        },
      },
      {
        label: "corrupt pointer storage",
        mutate: (probeDb, _fixture, created) => {
          probeDb
            .prepare(
              "UPDATE submissions SET current_revision_id = CAST(? AS BLOB) WHERE id = ?",
            )
            .run("ghost-revision", created.id);
        },
      },
      {
        label: "corrupt state",
        mutate: (probeDb, _fixture, created) => {
          probeDb.prepare("UPDATE submissions SET state = ? WHERE id = ?").run("CORRUPT", created.id);
        },
      },
      {
        label: "corrupt timestamps",
        mutate: (probeDb, _fixture, created) => {
          probeDb
            .prepare("UPDATE submissions SET created_at = ?, updated_at = ? WHERE id = ?")
            .run("not-an-instant", "not-an-instant", created.id);
        },
      },
    ];

    for (const corruption of corruptions) {
      const db = openDb({ path: ":memory:" });
      try {
        const fixture = setupFixture(db);
        const identity = identityOf(fixture);
        const created = commandsAt(COMMAND_AT).createSubmissionDraft(db, identity);
        if (corruption.label !== "multiple exact candidates") {
          db.exec("PRAGMA foreign_keys = OFF");
          db.exec("PRAGMA ignore_check_constraints = ON");
          db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
        }
        corruption.mutate(db, fixture, created);
        const before = truthSnapshot(db);
        let writerHits = 0;
        const error = expectCommandCode(
          () =>
            commandsAt(COMMAND_AT, {
              createDraftSubmission: () => {
                writerHits += 1;
                throw new Error("CORRUPT_REPLAY_REENTERED_WRITER");
              },
            }).createSubmissionDraft(db, identity),
          "SUBMISSION_WRITE_FAILED",
        );
        expect(error.message).not.toContain(corruption.label);
        expect(writerHits).toBe(0);
        expect(truthSnapshot(db)).toEqual(before);
      } finally {
        closeDb(db);
      }
    }
  });

  it("Evidence O2C-R3A: rejects a foreign-owner BLOB alias of the selected submission ID", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db, { slug: "r3-submission-alias" });
      const identity = identityOf(fixture);
      const created = commandsAt(COMMAND_AT).createSubmissionDraft(db, identity);
      db.prepare(
        `INSERT INTO submissions
           (id, workspace_id, event_id, call_id, owner_person_id, state,
            pinned_form_version_id, pinned_rule_version_id, current_revision_id,
            created_at, updated_at)
         SELECT CAST(id AS BLOB), workspace_id, event_id, call_id, ?, state,
                pinned_form_version_id, pinned_rule_version_id, current_revision_id,
                created_at, updated_at
         FROM submissions WHERE id = ?`,
      ).run(fixture.other.personId, created.id);

      expect(
        db
          .prepare(
            `SELECT typeof(id) AS storage, owner_person_id
             FROM submissions
             WHERE id = ? OR id = CAST(? AS BLOB)
             ORDER BY storage`,
          )
          .all(created.id, created.id),
      ).toEqual([
        { storage: "blob", owner_person_id: fixture.other.personId },
        { storage: "text", owner_person_id: fixture.applicant.personId },
      ]);
      expectOpaqueCreateReplayFailure(db, identity);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence O2C-R3B: rejects incomplete or aliased immutable revision evidence", () => {
    type RevisionCorruption = {
      readonly label: string;
      readonly mutate: (
        db: Db,
        fixture: Fixture,
        historicalRevisionId: string,
        currentRevisionId: string,
        aliasSourceRevisionId: string,
      ) => void;
    };
    const corruptions: readonly RevisionCorruption[] = [
      {
        label: "revision schema mirror",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET revision_schema = ? WHERE id = ?")
            .run("cfp-submission-revision/corrupt", historicalRevisionId);
        },
      },
      {
        label: "malformed revision JSON",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET revision_json = ? WHERE id = ?")
            .run("{", historicalRevisionId);
        },
      },
      {
        label: "noncanonical revision JSON",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET revision_json = revision_json || ? WHERE id = ?")
            .run(" ", historicalRevisionId);
        },
      },
      {
        label: "revision JSON storage",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET revision_json = CAST(revision_json AS BLOB) WHERE id = ?")
            .run(historicalRevisionId);
        },
      },
      {
        label: "revision fingerprint",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET fingerprint = ? WHERE id = ?")
            .run("0".repeat(64), historicalRevisionId);
        },
      },
      {
        label: "form document schema",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET form_document_schema = ? WHERE id = ?")
            .run("cfp-form-document/corrupt", historicalRevisionId);
        },
      },
      {
        label: "form document fingerprint",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET form_document_fingerprint = ? WHERE id = ?")
            .run("1".repeat(64), historicalRevisionId);
        },
      },
      {
        label: "form version binding",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET form_version_id = rule_version_id WHERE id = ?")
            .run(historicalRevisionId);
        },
      },
      {
        label: "rule version binding",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET rule_version_id = form_version_id WHERE id = ?")
            .run(historicalRevisionId);
        },
      },
      {
        label: "policy schema",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET policy_schema = ? WHERE id = ?")
            .run("cfp-call-policy/corrupt", historicalRevisionId);
        },
      },
      {
        label: "policy version binding",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET policy_version_id = ? WHERE id = ?")
            .run("corrupt-policy-version", historicalRevisionId);
        },
      },
      {
        label: "policy fingerprint binding",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare("UPDATE submission_revisions SET policy_fingerprint = ? WHERE id = ?")
            .run("2".repeat(64), historicalRevisionId);
        },
      },
      {
        label: "policy fingerprint BLOB storage",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare(
              "UPDATE submission_revisions SET policy_fingerprint = CAST(policy_fingerprint AS BLOB) WHERE id = ?",
            )
            .run(historicalRevisionId);
        },
      },
      {
        label: "extra receipt mirrors on a null draft receipt",
        mutate: (probeDb, _fixture, historicalRevisionId) => {
          probeDb
            .prepare(
              `UPDATE submission_revisions
               SET consent_receipt_schema = 'cfp-consent-receipt/v1',
                   consent_receipt_policy_fingerprint = policy_fingerprint
               WHERE id = ?`,
            )
            .run(historicalRevisionId);
        },
      },
      {
        label: "missing submitted receipt mirrors",
        mutate: (probeDb, _fixture, _historicalRevisionId, currentRevisionId) => {
          probeDb
            .prepare(
              `UPDATE submission_revisions
               SET consent_receipt_schema = NULL,
                   consent_receipt_policy_fingerprint = NULL
               WHERE id = ?`,
            )
            .run(currentRevisionId);
        },
      },
      {
        label: "historical revision ID BLOB alias",
        mutate: (
          probeDb,
          _fixture,
          historicalRevisionId,
          _currentRevisionId,
          aliasSourceRevisionId,
        ) => {
          probeDb
            .prepare("UPDATE submission_revisions SET id = CAST(? AS BLOB) WHERE id = ?")
            .run(historicalRevisionId, aliasSourceRevisionId);
        },
      },
    ];

    for (const [index, corruption] of corruptions.entries()) {
      const db = openDb({ path: ":memory:" });
      try {
        const fixture = setupFixture(db, { slug: `r3-revision-${index}` });
        const commands = commandsAt(COMMAND_AT);
        const identity = identityOf(fixture);
        const created = commands.createSubmissionDraft(db, identity);
        const historical = commands.saveSubmissionDraft(db, {
          ...identity,
          submissionId: created.id,
          historicalAnswers: [{ fieldId: "title", value: SECRET_ANSWER }],
          expectedCurrentRevisionId: null,
        });
        const submitted = commands.submitSubmission(db, {
          ...identity,
          submissionId: created.id,
          historicalAnswers: completeAnswers(),
          expectedCurrentRevisionId: historical.revisionId,
        });
        const aliasSubmission = commands.createSubmissionDraft(
          db,
          identityOf(fixture, fixture.other),
        );
        const aliasRevision = commands.saveSubmissionDraft(db, {
          ...identityOf(fixture, fixture.other),
          submissionId: aliasSubmission.id,
          historicalAnswers: [{ fieldId: "title", value: "synthetic-alias-source" }],
          expectedCurrentRevisionId: null,
        });
        expect(historical.revision.consentReceipt).toBeNull();
        expect(submissionRow(db, created.id)).toMatchObject({
          state: "SUBMITTED",
          current_revision_id: submitted.revisionId,
        });

        allowSyntheticHistoryCorruption(db);
        corruption.mutate(
          db,
          fixture,
          historical.revisionId,
          submitted.revisionId,
          aliasRevision.revisionId,
        );
        expectOpaqueCreateReplayFailure(db, identity);
      } finally {
        closeDb(db);
      }
    }
  });

  it("Evidence O2C-R3C: rejects impossible historical session and verification lineage", () => {
    type LineageCorruption = {
      readonly label: string;
      readonly mutate: (db: Db, fixture: Fixture) => void;
    };
    const corruptions: readonly LineageCorruption[] = [
      {
        label: "revision before session creation",
        mutate: (probeDb, fixture) => {
          probeDb
            .prepare("UPDATE cfp_applicant_sessions SET created_at = ? WHERE id = ?")
            .run(LATER_AT, fixture.applicant.sessionId);
        },
      },
      {
        label: "revision after session expiry",
        mutate: (probeDb, fixture) => {
          probeDb
            .prepare("UPDATE cfp_applicant_sessions SET expires_at = ? WHERE id = ?")
            .run("2026-08-10T06:00:00.000Z", fixture.applicant.sessionId);
        },
      },
      {
        label: "revision before verification consumption",
        mutate: (probeDb, fixture) => {
          const session = probeDb
            .prepare("SELECT verification_id FROM cfp_applicant_sessions WHERE id = ?")
            .get(fixture.applicant.sessionId) as { verification_id: string };
          probeDb
            .prepare(
              "UPDATE cfp_email_verification_consumptions SET consumed_at = ? WHERE verification_id = ?",
            )
            .run(LATER_AT, session.verification_id);
        },
      },
      {
        label: "session verification mismatch",
        mutate: (probeDb, fixture) => {
          probeDb
            .prepare("UPDATE cfp_applicant_sessions SET verification_id = ? WHERE id = ?")
            .run("foreign-verification", fixture.applicant.sessionId);
        },
      },
      {
        label: "verification call mismatch",
        mutate: (probeDb, fixture) => {
          const session = probeDb
            .prepare("SELECT verification_id FROM cfp_applicant_sessions WHERE id = ?")
            .get(fixture.applicant.sessionId) as { verification_id: string };
          probeDb
            .prepare("UPDATE cfp_email_verifications SET call_id = ? WHERE id = ?")
            .run("foreign-call", session.verification_id);
        },
      },
      {
        label: "verification workspace mismatch",
        mutate: (probeDb, fixture) => {
          const foreign = probeDb
            .prepare("SELECT id FROM workspaces WHERE id <> ? ORDER BY id LIMIT 1")
            .get(fixture.workspaceId) as { id: string };
          const session = probeDb
            .prepare("SELECT verification_id FROM cfp_applicant_sessions WHERE id = ?")
            .get(fixture.applicant.sessionId) as { verification_id: string };
          probeDb
            .prepare("UPDATE cfp_email_verifications SET workspace_id = ? WHERE id = ?")
            .run(foreign.id, session.verification_id);
        },
      },
      {
        label: "consumption person mismatch",
        mutate: (probeDb, fixture) => {
          const session = probeDb
            .prepare("SELECT verification_id FROM cfp_applicant_sessions WHERE id = ?")
            .get(fixture.applicant.sessionId) as { verification_id: string };
          probeDb
            .prepare(
              "UPDATE cfp_email_verification_consumptions SET person_id = ? WHERE verification_id = ?",
            )
            .run(fixture.other.personId, session.verification_id);
        },
      },
      {
        label: "session ID BLOB alias",
        mutate: (probeDb, fixture) => {
          probeDb
            .prepare("UPDATE cfp_applicant_sessions SET id = CAST(? AS BLOB) WHERE id = ?")
            .run(fixture.applicant.sessionId, fixture.other.sessionId);
        },
      },
      {
        label: "verification ID BLOB alias",
        mutate: (probeDb, fixture) => {
          const applicant = probeDb
            .prepare("SELECT verification_id FROM cfp_applicant_sessions WHERE id = ?")
            .get(fixture.applicant.sessionId) as { verification_id: string };
          const other = probeDb
            .prepare("SELECT verification_id FROM cfp_applicant_sessions WHERE id = ?")
            .get(fixture.other.sessionId) as { verification_id: string };
          probeDb
            .prepare("UPDATE cfp_email_verifications SET id = CAST(? AS BLOB) WHERE id = ?")
            .run(applicant.verification_id, other.verification_id);
        },
      },
      {
        label: "consumption ID BLOB alias",
        mutate: (probeDb, fixture) => {
          const applicant = probeDb
            .prepare(
              `SELECT consumed.id
               FROM cfp_applicant_sessions session
               JOIN cfp_email_verification_consumptions consumed
                 ON consumed.verification_id = session.verification_id
               WHERE session.id = ?`,
            )
            .get(fixture.applicant.sessionId) as { id: string };
          const other = probeDb
            .prepare(
              `SELECT consumed.id
               FROM cfp_applicant_sessions session
               JOIN cfp_email_verification_consumptions consumed
                 ON consumed.verification_id = session.verification_id
               WHERE session.id = ?`,
            )
            .get(fixture.other.sessionId) as { id: string };
          probeDb
            .prepare(
              "UPDATE cfp_email_verification_consumptions SET id = CAST(? AS BLOB) WHERE id = ?",
            )
            .run(applicant.id, other.id);
        },
      },
    ];

    for (const [index, corruption] of corruptions.entries()) {
      const db = openDb({ path: ":memory:" });
      try {
        const fixture = setupFixture(db, { slug: `r3-lineage-${index}` });
        const historicalCommands = commandsAt(COMMAND_AT);
        createAndSave(db, historicalCommands, fixture);
        const currentSession = insertSessionForPerson(
          db,
          fixture.workspaceId,
          fixture.callId,
          fixture.applicant.personId,
          `r3-lineage-current-${index}`,
        );
        const currentIdentity = identityOf(fixture, currentSession);

        allowSyntheticHistoryCorruption(db);
        corruption.mutate(db, fixture);
        expectOpaqueCreateReplayFailure(db, currentIdentity);
      } finally {
        closeDb(db);
      }
    }
  });

  it("Evidence O2C-R3D: accepts valid history after its session later expires or is revoked", () => {
    const cases = ["expired", "revoked"] as const;
    for (const [index, lifecycle] of cases.entries()) {
      const db = openDb({ path: ":memory:" });
      try {
        const fixture = setupFixture(db, { slug: `r3-later-${lifecycle}` });
        const historicalCommands = commandsAt(COMMAND_AT);
        const { created } = createAndSave(db, historicalCommands, fixture);
        const currentSession = insertSessionForPerson(
          db,
          fixture.workspaceId,
          fixture.callId,
          fixture.applicant.personId,
          `r3-later-current-${index}`,
        );
        allowSyntheticHistoryCorruption(db);
        if (lifecycle === "expired") {
          db.prepare("UPDATE cfp_applicant_sessions SET expires_at = ? WHERE id = ?").run(
            LATER_AT,
            fixture.applicant.sessionId,
          );
        } else {
          db.prepare(
            `UPDATE cfp_applicant_sessions
             SET revoked_at = ?, revoked_by = ?, revoked_reason = ?
             WHERE id = ?`,
          ).run(
            LATER_AT,
            fixture.organizer.accountId,
            "Synthetic later revocation",
            fixture.applicant.sessionId,
          );
        }

        const before = truthSnapshot(db);
        const replayed = commandsAt(AFTER_HISTORICAL_SESSION_AT, {
          createDraftSubmission: () => {
            throw new Error("VALID_HISTORICAL_REPLAY_REENTERED_WRITER");
          },
        }).createSubmissionDraft(db, identityOf(fixture, currentSession));
        expect(replayed).toEqual(created);
        expect(truthSnapshot(db)).toEqual(before);
      } finally {
        closeDb(db);
      }
    }
  });

  it("Evidence O2C-R4A: replays production-written backward clocks after later revocation", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const workspace = db
        .prepare("SELECT id FROM workspaces WHERE slug = 'northstar'")
        .get() as { id: string };
      const account = db
        .prepare("SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' LIMIT 1")
        .get(workspace.id) as { id: string };
      const organizer: OrganizerContext = {
        workspaceId: workspace.id,
        accountId: account.id,
      };
      const event = createEventWithUnit(
        db,
        workspace.id,
        { kind: "account", ref: account.id },
        {
          eventName: "Synthetic backward-clock event",
          unitName: "Synthetic backward-clock unit",
        },
      );
      const eventRow = db
        .prepare("SELECT created_at FROM events WHERE id = ?")
        .get(event.eventId) as { created_at: string };

      // The transaction sequence moves definition -> seal -> call while the accepted persistence
      // clock moves backward. None of those writers compares its clock with the referenced row.
      const definitionAt = offsetInstant(eventRow.created_at, -60);
      const sealedAt = offsetInstant(eventRow.created_at, -120);
      const callAt = offsetInstant(eventRow.created_at, -180);
      const verificationAt = offsetInstant(eventRow.created_at, -170);
      const consumptionAt = offsetInstant(eventRow.created_at, -160);
      const draftAt = offsetInstant(eventRow.created_at, -150);
      const revokedAt = offsetInstant(eventRow.created_at, -145);
      const savedAt = offsetInstant(eventRow.created_at, -140);
      const submittedAt = offsetInstant(eventRow.created_at, -130);
      const currentVerificationAt = offsetInstant(eventRow.created_at, -110);
      const currentConsumptionAt = offsetInstant(eventRow.created_at, -100);
      const replayAt = offsetInstant(eventRow.created_at, -90);

      const definition = createCfpPersistence({ clock: () => definitionAt }).createFormDefinition(
        db,
        organizer,
        { name: "Backward-clock CFP form" },
      );
      const sealed = createCfpPersistence({ clock: () => sealedAt }).sealFormVersion(
        db,
        organizer,
        {
          formDefinitionId: definition.id,
          fields: [
            {
              id: "trigger",
              type: "shortText",
              label: "Trigger",
              required: false,
              defaultVisibility: "visible",
            },
            {
              id: "consent",
              type: "consent",
              label: "Consent",
              required: false,
              defaultVisibility: "visible",
            },
            {
              id: "title",
              type: "shortText",
              label: "Title",
              required: false,
              defaultVisibility: "visible",
            },
          ],
          rules: { schema: FORM_RULES_SCHEMA, rules: [] },
        },
      );
      const callPolicy = {
        disclosure: {
          privacy: "privacy",
          retention: "retention",
          aiProcessing: "ai",
          communication: "communication",
          consent: "consent",
          publication: "publication",
        },
        choices: [{ fieldId: "consent", statement: "Allow publication", required: true }],
      } as const;
      const call = createCfpPersistence({ clock: () => callAt }).createCall(db, organizer, {
        eventId: event.eventId,
        name: "Backward-clock call",
        slug: "backward-clock-call",
        formVersionId: sealed.id,
        policy: callPolicy,
        accessMode: "PUBLIC",
        state: "OPEN",
        timezone: "UTC",
        opensAt: callAt,
        closesAt: offsetInstant(eventRow.created_at, 24 * 60),
      });
      const storedCall = createCfpPersistence().readCall(db, workspace.id, call.id);
      expectPersistenceCode(
        () =>
          createCfpPersistence({ clock: () => offsetInstant(callAt, -1) }).updateCallPolicy(
            db,
            organizer,
            {
              callId: call.id,
              expectedPolicyFingerprint: storedCall.policy.fingerprint,
              policy: callPolicy,
            },
          ),
        "PERSISTENCE_WRITE_FAILED",
      );

      const historicalEmail = "r4-backward-clock@synthetic.example";
      const historicalVerificationToken = digestFor("r4-backward-verification");
      const historicalSessionToken = digestFor("r4-backward-session");
      expectAccessCode(
        () =>
          createCfpApplicantAccess({ now: () => offsetInstant(callAt, -1) })
            .issueEmailVerification(
              db,
              { workspaceId: workspace.id },
              {
                callId: call.id,
                email: historicalEmail,
                tokenHash: historicalVerificationToken,
              },
            ),
        "CALL_NOT_AVAILABLE",
      );
      const historicalVerification = createCfpApplicantAccess({
        now: () => verificationAt,
      }).issueEmailVerification(
        db,
        { workspaceId: workspace.id },
        {
          callId: call.id,
          email: historicalEmail,
          tokenHash: historicalVerificationToken,
        },
      );
      for (const invalidConsumptionAt of [
        offsetInstant(verificationAt, -1),
        historicalVerification.expiresAt,
      ]) {
        expectAccessCode(
          () =>
            createCfpApplicantAccess({ now: () => invalidConsumptionAt })
              .consumeEmailVerification(
                db,
                { workspaceId: workspace.id },
                {
                  callId: call.id,
                  verificationId: historicalVerification.verificationId,
                  verificationTokenHash: historicalVerificationToken,
                  applicantSessionTokenHash: historicalSessionToken,
                  fullName: "Synthetic Backward Applicant",
                },
              ),
          "VERIFICATION_INVALID",
        );
      }
      const historicalSession = createCfpApplicantAccess({
        now: () => consumptionAt,
      }).consumeEmailVerification(
        db,
        { workspaceId: workspace.id },
        {
          callId: call.id,
          verificationId: historicalVerification.verificationId,
          verificationTokenHash: historicalVerificationToken,
          applicantSessionTokenHash: historicalSessionToken,
          fullName: "Synthetic Backward Applicant",
        },
      );
      const historicalIdentity = {
        workspaceId: workspace.id,
        callId: call.id,
        sessionTokenHash: historicalSessionToken,
      };

      expectAccessCode(
        () =>
          createCfpApplicantAccess({ now: () => offsetInstant(consumptionAt, -1) })
            .revokeApplicantSession(db, organizerSessionFor(db, organizer), {
              callId: call.id,
              sessionId: historicalSession.sessionId,
              reason: "Synthetic impossible early revocation",
            }),
        "SESSION_REVOKE_CONFLICT",
      );
      expectAccessCode(
        () =>
          commandsAt(offsetInstant(consumptionAt, -1)).createSubmissionDraft(
            db,
            historicalIdentity,
          ),
        "SESSION_INVALID",
      );
      expectAccessCode(
        () =>
          commandsAt(historicalSession.expiresAt).createSubmissionDraft(db, historicalIdentity),
        "SESSION_INVALID",
      );

      const created = commandsAt(draftAt).createSubmissionDraft(db, historicalIdentity);
      expectPersistenceCode(
        () =>
          commandsAt(savedAt, undefined, offsetInstant(draftAt, -1)).saveSubmissionDraft(db, {
            ...historicalIdentity,
            submissionId: created.id,
            historicalAnswers: [{ fieldId: "title", value: SECRET_ANSWER }],
            expectedCurrentRevisionId: null,
          }),
        "PERSISTENCE_WRITE_FAILED",
      );
      const saved = commandsAt(savedAt).saveSubmissionDraft(db, {
        ...historicalIdentity,
        submissionId: created.id,
        historicalAnswers: [{ fieldId: "title", value: SECRET_ANSWER }],
        expectedCurrentRevisionId: null,
      });
      expectPersistenceCode(
        () =>
          commandsAt(submittedAt, undefined, offsetInstant(savedAt, -1)).saveSubmissionDraft(db, {
            ...historicalIdentity,
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: saved.revisionId,
          }),
        "PERSISTENCE_WRITE_FAILED",
      );
      const submitted = commandsAt(submittedAt).submitSubmission(db, {
        ...historicalIdentity,
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: saved.revisionId,
      });

      const revocation = createCfpApplicantAccess({ now: () => revokedAt }).revokeApplicantSession(
        db,
        organizerSessionFor(db, organizer),
        {
          callId: call.id,
          sessionId: historicalSession.sessionId,
          reason: "Synthetic later-command backward-clock revocation",
        },
      );
      expect(revocation).toEqual({
        sessionId: historicalSession.sessionId,
        revokedAt,
        replayed: false,
      });

      expect(
        db.prepare(
          `SELECT definition.created_at AS definition_at,
                  rule.sealed_at AS rule_sealed_at,
                  form.sealed_at AS form_sealed_at,
                  call.created_at AS call_at,
                  call.updated_at AS call_updated_at,
                  event.created_at AS event_at,
                  verification.created_at AS verification_at,
                  verification.expires_at AS verification_expires_at,
                  consumption.consumed_at AS consumption_at,
                  person.created_at AS person_at,
                  session.created_at AS session_at,
                  session.expires_at AS session_expires_at,
                  submission.created_at AS submission_at,
                  submission.updated_at AS submission_updated_at,
                  saved.created_at AS saved_at,
                  submitted.created_at AS submitted_at,
                  session.revoked_at AS revoked_at
           FROM submissions submission
           JOIN calls call ON call.id = submission.call_id
           JOIN events event ON event.id = submission.event_id
           JOIN form_versions form ON form.id = submission.pinned_form_version_id
           JOIN rule_versions rule ON rule.id = submission.pinned_rule_version_id
           JOIN form_definitions definition ON definition.id = form.form_definition_id
           JOIN submission_revisions saved ON saved.id = ?
           JOIN submission_revisions submitted ON submitted.id = ?
           JOIN cfp_applicant_sessions session ON session.id = ?
           JOIN cfp_email_verifications verification ON verification.id = session.verification_id
           JOIN cfp_email_verification_consumptions consumption
             ON consumption.verification_id = verification.id
           JOIN people person ON person.id = session.person_id
           WHERE submission.id = ?`,
        ).get(
          saved.revisionId,
          submitted.revisionId,
          historicalSession.sessionId,
          created.id,
        ),
      ).toEqual({
        definition_at: definitionAt,
        rule_sealed_at: sealedAt,
        form_sealed_at: sealedAt,
        call_at: callAt,
        call_updated_at: callAt,
        event_at: eventRow.created_at,
        verification_at: verificationAt,
        verification_expires_at: historicalVerification.expiresAt,
        consumption_at: consumptionAt,
        person_at: consumptionAt,
        session_at: consumptionAt,
        session_expires_at: historicalSession.expiresAt,
        submission_at: draftAt,
        submission_updated_at: submittedAt,
        saved_at: savedAt,
        submitted_at: submittedAt,
        revoked_at: revokedAt,
      });
      expect(revokedAt < savedAt && savedAt < submittedAt).toBe(true);

      const currentVerificationToken = digestFor("r4-current-verification");
      const currentSessionToken = digestFor("r4-current-session");
      const currentVerification = createCfpApplicantAccess({
        now: () => currentVerificationAt,
      }).issueEmailVerification(
        db,
        { workspaceId: workspace.id },
        {
          callId: call.id,
          email: historicalEmail,
          tokenHash: currentVerificationToken,
        },
      );
      createCfpApplicantAccess({ now: () => currentConsumptionAt }).consumeEmailVerification(
        db,
        { workspaceId: workspace.id },
        {
          callId: call.id,
          verificationId: currentVerification.verificationId,
          verificationTokenHash: currentVerificationToken,
          applicantSessionTokenHash: currentSessionToken,
          fullName: "Synthetic Backward Applicant",
        },
      );

      const before = truthSnapshot(db);
      const replayed = commandsAt(replayAt, {
        createDraftSubmission: () => {
          throw new Error("R4_BACKWARD_CLOCK_REPLAY_REENTERED_WRITER");
        },
      }).createSubmissionDraft(db, {
        workspaceId: workspace.id,
        callId: call.id,
        sessionTokenHash: currentSessionToken,
      });
      expect(replayed).toEqual(created);
      expect(submitted.submissionId).toBe(created.id);
      expect(truthSnapshot(db)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence O2C-R3F: retains legitimate later call form advancement in one lineage", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db, { slug: "r3-later-form" });
      const identity = identityOf(fixture);
      const created = commandsAt(COMMAND_AT).createSubmissionDraft(db, identity);
      const definition = db
        .prepare("SELECT form_definition_id FROM form_versions WHERE id = ?")
        .get(fixture.formVersionId) as { form_definition_id: string };
      const laterPersistence = createCfpPersistence({ clock: () => LATER_AT });
      const laterForm = laterPersistence.sealFormVersion(db, fixture.organizer, {
        formDefinitionId: definition.form_definition_id,
        fields: fixture.fields,
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      laterPersistence.advanceCallFormVersion(db, fixture.organizer, {
        callId: fixture.callId,
        expectedFormVersionId: fixture.formVersionId,
        nextFormVersionId: laterForm.id,
      });

      const before = truthSnapshot(db);
      const replayed = commandsAt(LATER_AT, {
        createDraftSubmission: () => {
          throw new Error("LATER_FORM_REPLAY_REENTERED_WRITER");
        },
      }).createSubmissionDraft(db, identity);
      expect(replayed).toEqual(created);
      expect(replayed.pinnedFormVersionId).toBe(fixture.formVersionId);
      expect(replayed.pinnedFormVersionId).not.toBe(laterForm.id);
      expect(truthSnapshot(db)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 2: returns the stored updated_at and never rewinds it", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      // The revision writer runs ahead of this command's clock; the stored timestamp must win.
      const commands = commandsAt(COMMAND_AT, undefined, LATER_AT);
      const created = commands.createSubmissionDraft(db, identityOf(fixture));
      const submitted = commands.submitSubmission(db, {
        ...identityOf(fixture),
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: null,
      });
      expect(submitted.submittedAt).toBe(LATER_AT);
      expect(submissionRow(db, created.id)).toMatchObject({
        state: "SUBMITTED",
        updated_at: LATER_AT,
      });

      const later = setupFixture(db, { slug: "later" });
      const laterCommands = commandsAt(LATER_AT, undefined, COMMAND_AT);
      const laterCreated = laterCommands.createSubmissionDraft(db, identityOf(later));
      const laterSubmitted = laterCommands.submitSubmission(db, {
        ...identityOf(later),
        submissionId: laterCreated.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: null,
      });
      expect(laterSubmitted.submittedAt).toBe(LATER_AT);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 3: stores the evaluator's effective answers, never the caller's", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      const { saved } = createAndSave(db, commands, fixture, hiddenConsentAnswers());

      const expected = evaluateConditionalForm({
        fields: fixture.fields,
        historicalAnswers: hiddenConsentAnswers(),
        ruleSet: fixture.ruleSet,
      });
      expect(saved.revision.formDocument.effectiveAnswers).toEqual(expected.effectiveAnswers);
      expect(saved.revision.formDocument.effectiveAnswers.map((answer) => answer.fieldId)).toEqual([
        "title",
        "trigger",
      ]);
      // History keeps the cleared answer; the effective view does not.
      expect(saved.revision.formDocument.historicalAnswers.map((answer) => answer.fieldId)).toEqual([
        "consent",
        "title",
        "trigger",
      ]);
      expect(saved.revision.consentReceipt).toBeNull();

      // A caller cannot smuggle effective answers past the strict key check either.
      const before = truthSnapshot(db);
      expectCommandCode(
        () =>
          commands.saveSubmissionDraft(db, {
            ...identityOf(fixture),
            submissionId: saved.revision.submissionId,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: saved.revisionId,
            effectiveAnswers: [{ fieldId: "consent", value: true }],
          } as unknown as SaveSubmissionDraftInput),
        "COMMAND_INPUT_INVALID",
      );
      expect(truthSnapshot(db)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 4: rolls back an incomplete submit completely", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      const { created, saved } = createAndSave(db, commands, fixture);

      const before = truthSnapshot(db);
      expectCommandCode(
        () =>
          commands.submitSubmission(db, {
            ...identityOf(fixture),
            submissionId: created.id,
            historicalAnswers: hiddenConsentAnswers(),
            expectedCurrentRevisionId: saved.revisionId,
          }),
        "SUBMISSION_INCOMPLETE",
      );
      expect(truthSnapshot(db)).toEqual(before);
      expect(revisionRows(db, created.id)).toHaveLength(1);
      expect(submissionRow(db, created.id)).toMatchObject({
        state: "DRAFT",
        current_revision_id: saved.revisionId,
      });

      // The draft is still submittable once the required consent is effective again.
      const submitted = commands.submitSubmission(db, {
        ...identityOf(fixture),
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: saved.revisionId,
      });
      expect(submissionRow(db, created.id)).toMatchObject({
        state: "SUBMITTED",
        current_revision_id: submitted.revisionId,
      });
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 5: rolls back a refused required consent without leaking trigger text", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      const { created, saved } = createAndSave(db, commands, fixture);

      const before = truthSnapshot(db);
      const error = expectCommandCode(
        () =>
          commands.submitSubmission(db, {
            ...identityOf(fixture),
            submissionId: created.id,
            historicalAnswers: refusedConsentAnswers(),
            expectedCurrentRevisionId: saved.revisionId,
          }),
        "SUBMISSION_WRITE_FAILED",
      );
      // The schema trigger is the authority for a refused required consent; its text stays inside.
      expect(error.message).toBe("The CFP submission write failed.");
      expect(truthSnapshot(db)).toEqual(before);
      expect(revisionRows(db, created.id)).toHaveLength(1);
      expect(submissionRow(db, created.id)).toMatchObject({ state: "DRAFT" });
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 6: rejects malformed digests, identifiers, and key sets without writing", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      const { created, saved } = createAndSave(db, commands, fixture);
      const identity = identityOf(fixture);
      const saveInput = {
        ...identity,
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: saved.revisionId,
      };

      const withSymbol: Record<string, unknown> = { ...identity };
      Object.defineProperty(withSymbol, Symbol("smuggled"), {
        configurable: true,
        enumerable: true,
        value: "smuggled",
        writable: true,
      });
      const withGetter: Record<string, unknown> = { ...identity };
      Object.defineProperty(withGetter, "callId", {
        configurable: true,
        enumerable: true,
        get: () => fixture.callId,
      });
      const withThrowingGetter: Record<string, unknown> = { ...identity };
      Object.defineProperty(withThrowingGetter, "workspaceId", {
        configurable: true,
        enumerable: true,
        get: () => {
          throw new CfpSubmissionCommandError("SUBMISSION_NOT_FOUND");
        },
      });

      const rejected: readonly (() => unknown)[] = [
        () => commands.createSubmissionDraft(db, { ...identity, sessionTokenHash: identity.sessionTokenHash.toUpperCase() }),
        () => commands.createSubmissionDraft(db, { ...identity, sessionTokenHash: identity.sessionTokenHash.slice(0, 63) }),
        () => commands.createSubmissionDraft(db, { ...identity, sessionTokenHash: `${identity.sessionTokenHash}0` }),
        () => commands.createSubmissionDraft(db, { ...identity, sessionTokenHash: `g${identity.sessionTokenHash.slice(1)}` }),
        () => commands.createSubmissionDraft(db, { ...identity, sessionTokenHash: "raw-session-token" }),
        () => commands.createSubmissionDraft(db, { ...identity, workspaceId: "" }),
        () => commands.createSubmissionDraft(db, { ...identity, workspaceId: "w".repeat(129) }),
        () => commands.createSubmissionDraft(db, { ...identity, callId: "callid" }),
        () => commands.createSubmissionDraft(db, { ...identity, callId: "call\ud800" }),
        () => commands.createSubmissionDraft(db, { ...identity, callId: 7 as unknown as string }),
        () => commands.createSubmissionDraft(db, { ...identity, extra: "x" } as unknown as CreateSubmissionDraftInput),
        () => commands.createSubmissionDraft(db, { workspaceId: fixture.workspaceId, callId: fixture.callId } as unknown as CreateSubmissionDraftInput),
        () => commands.createSubmissionDraft(db, withSymbol as unknown as CreateSubmissionDraftInput),
        () => commands.createSubmissionDraft(db, withGetter as unknown as CreateSubmissionDraftInput),
        () => commands.createSubmissionDraft(db, withThrowingGetter as unknown as CreateSubmissionDraftInput),
        () => commands.createSubmissionDraft(db, new Proxy(identity, {}) as CreateSubmissionDraftInput),
        () => commands.createSubmissionDraft(db, [identity] as unknown as CreateSubmissionDraftInput),
        () => commands.createSubmissionDraft(db, null as unknown as CreateSubmissionDraftInput),
        () => commands.createSubmissionDraft(db, "identity" as unknown as CreateSubmissionDraftInput),
        () => commands.saveSubmissionDraft(db, { ...saveInput, submissionId: "" }),
        () => commands.saveSubmissionDraft(db, { ...saveInput, expectedCurrentRevisionId: "" }),
        () => commands.saveSubmissionDraft(db, { ...saveInput, expectedCurrentRevisionId: 3 as unknown as string }),
        () => commands.saveSubmissionDraft(db, { ...saveInput, historicalAnswers: undefined }),
        () => commands.saveSubmissionDraft(db, { ...saveInput, historicalAnswers: () => completeAnswers() }),
        () => commands.saveSubmissionDraft(db, { ...saveInput, historicalAnswers: nestedAnswers(40) }),
        () =>
          commands.saveSubmissionDraft(db, {
            ...saveInput,
            historicalAnswers: [{ fieldId: "title", value: "lone\ud800surrogate" }],
          }),
        () => commands.submitSubmission(db, { ...saveInput, submissionId: "s".repeat(129) }),
        () => commands.submitSubmission(db, { ...saveInput, historicalAnswers: new Proxy([], {}) }),
      ];

      for (const operation of rejected) {
        const before = truthSnapshot(db);
        expectCommandCode(operation, "COMMAND_INPUT_INVALID");
        expect(truthSnapshot(db)).toEqual(before);
      }
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 6B: classifies semantic historical-answer failures as caller input", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      const { created, saved } = createAndSave(db, commands, fixture);
      const baseInput = {
        ...identityOf(fixture),
        submissionId: created.id,
        expectedCurrentRevisionId: saved.revisionId,
      };
      const semanticFailures: ReadonlyArray<{
        readonly label: string;
        readonly historicalAnswers: unknown;
      }> = [
        {
          label: "unknown field",
          historicalAnswers: [{ fieldId: "unknown-field", value: SECRET_ANSWER }],
        },
        {
          label: "wrong field value type",
          historicalAnswers: [{ fieldId: "consent", value: "yes" }],
        },
        {
          label: "malformed semantic answer",
          historicalAnswers: [{ fieldId: "title", value: SECRET_ANSWER, unexpected: true }],
        },
        {
          label: "wrong semantic container",
          historicalAnswers: { fieldId: "title", value: SECRET_ANSWER },
        },
      ];

      for (const probe of semanticFailures) {
        for (const invoke of [
          () =>
            commands.saveSubmissionDraft(db, {
              ...baseInput,
              historicalAnswers: probe.historicalAnswers,
            }),
          () =>
            commands.submitSubmission(db, {
              ...baseInput,
              historicalAnswers: probe.historicalAnswers,
            }),
        ]) {
          const before = truthSnapshot(db);
          const error = expectCommandCode(invoke, "COMMAND_INPUT_INVALID");
          expect(error.message).not.toContain(probe.label);
          expect(truthSnapshot(db)).toEqual(before);
        }
      }
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 6C: scopes semantic classification to the revision writer", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const honest = commandsAt(COMMAND_AT);
      const { created, saved } = createAndSave(db, honest, fixture);
      const identity = identityOf(fixture);
      const revisionInput = {
        ...identity,
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: saved.revisionId,
      };
      const semanticFailures = [
        {
          label: "evaluation detail",
          make: () => new FormEvaluationError("FORM_HISTORICAL_ANSWER_INVALID"),
        },
        {
          label: "document detail",
          make: () => new FormDocumentError("FORM_ANSWER_INVALID"),
        },
        {
          label: "safety detail",
          make: () => new FormSafetyError("UNSAFE_VALUE"),
        },
      ] as const;

      for (const semantic of semanticFailures) {
        const opaqueDependencyOperations: ReadonlyArray<{
          readonly label: string;
          readonly invoke: () => unknown;
        }> = [
          {
            label: "resolver",
            invoke: () =>
              commandsAt(COMMAND_AT, {
                resolveApplicantSession: () => {
                  throw semantic.make();
                },
              }).createSubmissionDraft(db, identity),
          },
          {
            label: "access",
            invoke: () =>
              commandsAt(COMMAND_AT, {
                assertApplicantAccess: () => {
                  throw semantic.make();
                },
              }).createSubmissionDraft(db, identity),
          },
          {
            label: "create writer",
            invoke: () =>
              commandsAt(COMMAND_AT, {
                createDraftSubmission: () => {
                  throw semantic.make();
                },
              }).createSubmissionDraft(db, identityOf(fixture, fixture.other)),
          },
          {
            label: "clock",
            invoke: () =>
              commandsAt(COMMAND_AT, {
                clock: () => {
                  throw semantic.make();
                },
              }).submitSubmission(db, revisionInput),
          },
        ];

        for (const probe of opaqueDependencyOperations) {
          const before = truthSnapshot(db);
          const error = expectCommandCode(probe.invoke, "SUBMISSION_WRITE_FAILED");
          expect(error.message).not.toContain(semantic.label);
          expect(error.message).not.toContain(probe.label);
          expect(truthSnapshot(db)).toEqual(before);
        }

        const historicalWriter = commandsAt(COMMAND_AT, {
          saveDraftRevision: () => {
            throw semantic.make();
          },
        });
        for (const invoke of [
          () => historicalWriter.saveSubmissionDraft(db, revisionInput),
          () => historicalWriter.submitSubmission(db, revisionInput),
        ]) {
          const before = truthSnapshot(db);
          const error = expectCommandCode(invoke, "COMMAND_INPUT_INVALID");
          expect(error.message).not.toContain(semantic.label);
          expect(truthSnapshot(db)).toEqual(before);
        }
      }
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 7: fails closed on incoherent or faulting dependencies", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const honest = commandsAt(COMMAND_AT);
      const { created, saved } = createAndSave(db, honest, fixture);
      const identity = identityOf(fixture);
      const submitInput = {
        ...identity,
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: saved.revisionId,
      };
      const access = createCfpApplicantAccess({ now: () => COMMAND_AT });

      const substituted: readonly {
        readonly label: string;
        readonly options: CfpSubmissionCommandOptions;
        readonly code: CfpSubmissionCommandErrorCode;
      }[] = [
        {
          label: "a session resolver that throws an unrecognized fault",
          options: {
            resolveApplicantSession: () => {
              throw new Error(`opaque driver detail ${identity.sessionTokenHash}`);
            },
          },
          code: "SUBMISSION_WRITE_FAILED",
        },
        {
          label: "a session resolver that answers for another workspace",
          options: {
            resolveApplicantSession: (probeDb, input) => {
              const resolved = access.resolveApplicantSession(probeDb, input);
              return {
                ...resolved,
                context: { workspaceId: "other-workspace", sessionId: resolved.context.sessionId },
              };
            },
          },
          code: "SUBMISSION_WRITE_FAILED",
        },
        {
          label: "a session resolver that answers for another call",
          options: {
            resolveApplicantSession: (probeDb, input) => ({
              ...access.resolveApplicantSession(probeDb, input),
              callId: "other-call",
            }),
          },
          code: "SUBMISSION_WRITE_FAILED",
        },
        {
          label: "a session resolver that omits the owner person",
          options: {
            resolveApplicantSession: (probeDb, input) => ({
              ...access.resolveApplicantSession(probeDb, input),
              personId: "",
            }),
          },
          code: "SUBMISSION_WRITE_FAILED",
        },
        {
          label: "a session resolver that answers with no context at all",
          options: {
            resolveApplicantSession: () => null as never,
          },
          code: "SUBMISSION_WRITE_FAILED",
        },
        {
          label: "an access assertion that denies without throwing",
          options: {
            assertApplicantAccess: () => ({ allowed: false, late: false, extensionId: null }) as never,
          },
          code: "SUBMISSION_WRITE_FAILED",
        },
        {
          label: "a revision writer that reports an unwritten revision",
          options: {
            saveDraftRevision: () => ({ revisionId: "fabricated-revision" }) as never,
          },
          code: "SUBMISSION_WRITE_FAILED",
        },
        {
          label: "a revision writer that reports another submission",
          options: {
            saveDraftRevision: (probeDb, context, input) => {
              const result = createCfpPersistence({ clock: () => COMMAND_AT }).saveDraftRevision(
                probeDb,
                context,
                input,
              );
              return { ...result, revision: { ...result.revision, submissionId: "other-submission" } };
            },
          },
          code: "SUBMISSION_WRITE_FAILED",
        },
        {
          label: "a clock that is not a clock",
          options: { clock: () => "not-a-timestamp" },
          code: "SUBMISSION_WRITE_FAILED",
        },
      ];

      for (const probe of substituted) {
        const before = truthSnapshot(db);
        const commands = commandsAt(COMMAND_AT, probe.options);
        expectCommandCode(() => commands.submitSubmission(db, submitInput), probe.code);
        expect(truthSnapshot(db)).toEqual(before);
      }

      // A recognized access failure keeps its own stable public code.
      const preserving = commandsAt(COMMAND_AT, {
        assertApplicantAccess: () => {
          throw new CfpApplicantAccessError("CALL_NOT_ACCEPTING");
        },
      });
      const before = truthSnapshot(db);
      expectAccessCode(() => preserving.submitSubmission(db, submitInput), "CALL_NOT_ACCEPTING");
      expect(truthSnapshot(db)).toEqual(before);

      // A driver fault raised while preparing the compare-and-set never reaches the caller.
      const faultingDb = withPrepareFailure(
        db,
        /UPDATE submissions\s+SET state = 'SUBMITTED'/u,
        `driver detail ${SECRET_ANSWER}`,
      );
      expectCommandCode(
        () => honest.submitSubmission(faultingDb, submitInput),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(truthSnapshot(db)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 8: answers wrong tenant, call, session, and owner non-reflectively", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db, { sessionExpiresAt: "2099-01-01T00:00:00.000Z" });
      const second = setupFixture(db, {
        slug: "second",
        sessionExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      const commands = commandsAt(COMMAND_AT);
      const { created, saved } = createAndSave(db, commands, fixture);
      const identity = identityOf(fixture);
      const before = truthSnapshot(db);

      const sessionDenials: readonly (() => unknown)[] = [
        () => commands.createSubmissionDraft(db, { ...identity, workspaceId: "acme-workspace-id" }),
        () => commands.createSubmissionDraft(db, { ...identity, callId: second.callId }),
        () => commands.createSubmissionDraft(db, { ...identity, sessionTokenHash: UNKNOWN_DIGEST }),
        () =>
          commands.saveSubmissionDraft(db, {
            ...identity,
            callId: second.callId,
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: saved.revisionId,
          }),
      ];
      const messages = new Set<string>();
      for (const operation of sessionDenials) {
        messages.add(expectAccessCode(operation, "SESSION_INVALID").message);
        expect(truthSnapshot(db)).toEqual(before);
      }
      expect([...messages]).toEqual(["The session is invalid, expired, or revoked."]);

      // Leave the O2A create/save seams at their production defaults; the fixture was issued with
      // a future expiry so this exact evidence remains replayable.
      const productionCommands = commandsWithDefaultPersistenceAt(COMMAND_AT);
      const terminalApplicant = insertApplicant(
        db,
        fixture.workspaceId,
        fixture.callId,
        "primary-foreign-terminal",
        "2099-01-01T00:00:00.000Z",
      );
      const foreignDraft = productionCommands.createSubmissionDraft(
        db,
        identityOf(fixture, fixture.other),
      );
      const foreignTerminalDraft = productionCommands.createSubmissionDraft(
        db,
        identityOf(fixture, terminalApplicant),
      );
      const foreignTerminal = productionCommands.submitSubmission(db, {
        ...identityOf(fixture, terminalApplicant),
        submissionId: foreignTerminalDraft.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: null,
      });
      expect(foreignTerminal.submissionId).toBe(foreignTerminalDraft.id);

      // The production preflight runs before the real immutable revision writer. Missing,
      // call-mismatched, owner-mismatched draft, and owner-mismatched terminal addresses are one
      // public answer for both save and submit, regardless of pointer knowledge.
      const privateTargets: ReadonlyArray<{
        readonly identity: ReturnType<typeof identityOf>;
        readonly submissionId: string;
        readonly expectedCurrentRevisionId: string | null;
      }> = [
        {
          identity,
          submissionId: "submission-that-does-not-exist",
          expectedCurrentRevisionId: null,
        },
        {
          identity,
          submissionId: foreignDraft.id,
          expectedCurrentRevisionId: null,
        },
        {
          identity,
          submissionId: foreignTerminalDraft.id,
          expectedCurrentRevisionId: foreignTerminal.revisionId,
        },
        {
          identity: identityOf(fixture, fixture.other),
          submissionId: created.id,
          expectedCurrentRevisionId: saved.revisionId,
        },
        {
          identity: identityOf(second),
          submissionId: created.id,
          expectedCurrentRevisionId: saved.revisionId,
        },
      ];
      const protectedTruth = truthSnapshot(db);
      const publicOutcomes = new Set<string>();
      for (const target of privateTargets) {
        for (const invoke of [
          () =>
            productionCommands.saveSubmissionDraft(db, {
              ...target.identity,
              submissionId: target.submissionId,
              historicalAnswers: completeAnswers(),
              expectedCurrentRevisionId: target.expectedCurrentRevisionId,
            }),
          () =>
            productionCommands.submitSubmission(db, {
              ...target.identity,
              submissionId: target.submissionId,
              historicalAnswers: completeAnswers(),
              expectedCurrentRevisionId: target.expectedCurrentRevisionId,
            }),
        ]) {
          const error = expectCommandCode(invoke, "SUBMISSION_NOT_FOUND");
          publicOutcomes.add(`${error.name}|${error.code}|${error.message}`);
          expect(truthSnapshot(db)).toEqual(protectedTruth);
        }
      }
      expect([...publicOutcomes]).toEqual([
        "CfpSubmissionCommandError|SUBMISSION_NOT_FOUND|The CFP submission was not found.",
      ]);

      // A private classification read fault is an opaque write failure and cannot fall through to
      // O2A or expose driver text.
      const preflightFaultDb = withPrepareFailure(
        db,
        /SELECT state, call_id, owner_person_id, current_revision_id\s+FROM submissions/u,
        `SQLITE_PRIVATE_PREFLIGHT_${SECRET_ANSWER}`,
      );
      expectCommandCode(
        () =>
          productionCommands.saveSubmissionDraft(preflightFaultDb, {
            ...identity,
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: saved.revisionId,
          }),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(truthSnapshot(db)).toEqual(protectedTruth);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 9: classifies a lost compare-and-set without reflecting rows", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const honest = commandsAt(COMMAND_AT);
      const persistence = createCfpPersistence({ clock: () => COMMAND_AT });
      const { created, saved } = createAndSave(db, honest, fixture);
      const identity = identityOf(fixture);

      // A competing writer that advanced the pointer between the revision write and the submit.
      const overtaken = commandsAt(COMMAND_AT, {
        saveDraftRevision: (probeDb, context, input) => {
          const result = persistence.saveDraftRevision(probeDb, context, input);
          persistence.saveDraftRevision(probeDb, context, {
            submissionId: input.submissionId,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: result.revisionId,
          });
          return result;
        },
      });
      let before = truthSnapshot(db);
      expectCommandCode(
        () =>
          overtaken.submitSubmission(db, {
            ...identity,
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: saved.revisionId,
          }),
        "SUBMISSION_STALE",
      );
      expect(truthSnapshot(db)).toEqual(before);

      // A competing writer that already submitted the same revision.
      const alreadySubmitted = commandsAt(COMMAND_AT, {
        saveDraftRevision: (probeDb, context, input) => {
          const result = persistence.saveDraftRevision(probeDb, context, input);
          probeDb
            .prepare(
              `UPDATE submissions SET state = 'SUBMITTED', updated_at = ?
               WHERE workspace_id = ? AND id = ? AND state = 'DRAFT' AND current_revision_id = ?`,
            )
            .run(COMMAND_AT, context.workspaceId, input.submissionId, result.revisionId);
          return result;
        },
      });
      before = truthSnapshot(db);
      expectCommandCode(
        () =>
          alreadySubmitted.submitSubmission(db, {
            ...identity,
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: saved.revisionId,
          }),
        "SUBMISSION_NOT_DRAFT",
      );
      expect(truthSnapshot(db)).toEqual(before);

      // Missing rows and rows owned by another applicant or call give one answer.
      const fabricating = (submissionId: string): CfpSubmissionCommands =>
        commandsAt(COMMAND_AT, {
          saveDraftRevision: () =>
            ({
              revisionId: "fabricated-revision",
              revision: { submissionId, consentReceipt: { schema: "cfp-consent-receipt/v1" } },
            }) as never,
        });
      const notFound = new Set<string>();
      for (const submissionId of ["submission-that-does-not-exist", created.id]) {
        const commands = fabricating(submissionId);
        before = truthSnapshot(db);
        notFound.add(
          expectCommandCode(
            () =>
              commands.submitSubmission(db, {
                ...identityOf(fixture, submissionId === created.id ? fixture.other : fixture.applicant),
                submissionId,
                historicalAnswers: completeAnswers(),
                expectedCurrentRevisionId: null,
              }),
            "SUBMISSION_NOT_FOUND",
          ).message,
        );
        expect(truthSnapshot(db)).toEqual(before);
      }
      expect([...notFound]).toEqual(["The CFP submission was not found."]);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 10: keeps stale pointers and terminal state stable", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      const { created, saved } = createAndSave(db, commands, fixture);
      const identity = identityOf(fixture);

      // A save that repeats an already-consumed pointer is stale.
      let before = truthSnapshot(db);
      expectPersistenceCode(
        () =>
          commands.saveSubmissionDraft(db, {
            ...identity,
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: null,
          }),
        "STALE_REVISION",
      );
      expect(truthSnapshot(db)).toEqual(before);

      // A submit that repeats an already-consumed pointer is stale too.
      expectPersistenceCode(
        () =>
          commands.submitSubmission(db, {
            ...identity,
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: null,
          }),
        "STALE_REVISION",
      );
      expect(truthSnapshot(db)).toEqual(before);

      const submitted = commands.submitSubmission(db, {
        ...identity,
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: saved.revisionId,
      });
      before = truthSnapshot(db);

      // Submit is not an idempotent replay: the terminal state fails stably instead.
      for (const expected of [submitted.revisionId, saved.revisionId, null]) {
        expectPersistenceCode(
          () =>
            commands.submitSubmission(db, {
              ...identity,
              submissionId: created.id,
              historicalAnswers: completeAnswers(),
              expectedCurrentRevisionId: expected,
            }),
          "SUBMISSION_NOT_DRAFT",
        );
        expectPersistenceCode(
          () =>
            commands.saveSubmissionDraft(db, {
              ...identity,
              submissionId: created.id,
              historicalAnswers: completeAnswers(),
              expectedCurrentRevisionId: expected,
            }),
          "SUBMISSION_NOT_DRAFT",
        );
        expect(truthSnapshot(db)).toEqual(before);
      }
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 11: refuses paused, closed, revoked, and expired access", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      const { created, saved } = createAndSave(db, commands, fixture);
      const identity = identityOf(fixture);
      const submitInput = {
        ...identity,
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: saved.revisionId,
      };

      const setCallState = (state: string): void => {
        db.prepare("UPDATE calls SET state = ?, updated_at = ? WHERE id = ?").run(
          state,
          COMMAND_AT,
          fixture.callId,
        );
      };

      for (const state of ["PAUSED", "CLOSED", "CANCELLED", "ARCHIVED"]) {
        setCallState(state);
        const before = truthSnapshot(db);
        expectAccessCode(() => commands.submitSubmission(db, submitInput), "CALL_NOT_ACCEPTING");
        expectAccessCode(() => commands.createSubmissionDraft(db, identity), "CALL_NOT_ACCEPTING");
        expect(truthSnapshot(db)).toEqual(before);
      }

      // A granted extension re-opens exactly one applicant's closed call.
      setCallState("CLOSED");
      db.prepare(
        `INSERT INTO call_extensions
           (id, workspace_id, call_id, person_id, extends_to, reason, granted_by, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "submissions-extension",
        fixture.workspaceId,
        fixture.callId,
        fixture.applicant.personId,
        EXTENSION_ENDS_AT,
        "Synthetic late window",
        fixture.organizer.accountId,
        "submissions-extension-key",
        FIXTURE_AT,
      );
      const submitted = commands.submitSubmission(db, submitInput);
      expect(submissionRow(db, created.id)).toMatchObject({
        state: "SUBMITTED",
        current_revision_id: submitted.revisionId,
      });

      // The other applicant in the same closed call has no extension and stays denied.
      setCallState("OPEN");
      const otherCreated = commands.createSubmissionDraft(db, identityOf(fixture, fixture.other));
      setCallState("CLOSED");
      const before = truthSnapshot(db);
      expectAccessCode(
        () =>
          commands.saveSubmissionDraft(db, {
            ...identityOf(fixture, fixture.other),
            submissionId: otherCreated.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: null,
          }),
        "CALL_NOT_ACCEPTING",
      );
      expect(truthSnapshot(db)).toEqual(before);

      setCallState("OPEN");
      db.prepare(
        "UPDATE cfp_applicant_sessions SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ?",
      ).run(COMMAND_AT, fixture.organizer.accountId, "Synthetic revocation", fixture.other.sessionId);
      const afterRevocation = truthSnapshot(db);
      expectAccessCode(
        () => commands.createSubmissionDraft(db, identityOf(fixture, fixture.other)),
        "SESSION_INVALID",
      );
      expect(truthSnapshot(db)).toEqual(afterRevocation);

      // After the session window closes, no command can resolve the session at all.
      const expired = commandsAt(AFTER_SESSION_AT);
      expectAccessCode(() => expired.createSubmissionDraft(db, identity), "SESSION_INVALID");
      expect(truthSnapshot(db)).toEqual(afterRevocation);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 12: cannot split authorization from mutation inside one boundary", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      const created = commands.createSubmissionDraft(db, identityOf(fixture));
      const before = truthSnapshot(db);

      // Simulate the strongest possible interleave: revoke the session after authorization has
      // already succeeded but before the revision insert. The schema refuses the write and the
      // command's own boundary discards the revocation with it.
      const racingDb = withBeforeFirstPrepare(db, /INSERT INTO submission_revisions/u, () => {
        db.prepare(
          "UPDATE cfp_applicant_sessions SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ?",
        ).run(COMMAND_AT, fixture.organizer.accountId, "Synthetic race", fixture.applicant.sessionId);
      });
      expectPersistenceCode(
        () =>
          commands.saveSubmissionDraft(racingDb, {
            ...identityOf(fixture),
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: null,
          }),
        "PERSISTENCE_WRITE_FAILED",
      );
      expect(truthSnapshot(db)).toEqual(before);

      // A close landing between the revision write and the compare-and-set cannot split the
      // command: it shares the one boundary, so it commits with the submit rather than beside it.
      const closingDb = withBeforeFirstPrepare(db, /UPDATE submissions\s+SET state = 'SUBMITTED'/u, () => {
        db.prepare("UPDATE calls SET state = 'CLOSED', updated_at = ? WHERE id = ?").run(
          COMMAND_AT,
          fixture.callId,
        );
        db.prepare("UPDATE submissions SET updated_at = ? WHERE id = ?").run(LATER_AT, created.id);
      });
      const submitted = commands.submitSubmission(closingDb, {
        ...identityOf(fixture),
        submissionId: created.id,
        historicalAnswers: completeAnswers(),
        expectedCurrentRevisionId: null,
      });
      // The interfering timestamp is newer, so the monotonic guard keeps it.
      expect(submitted.submittedAt).toBe(LATER_AT);
      expect(submissionRow(db, created.id)).toMatchObject({
        state: "SUBMITTED",
        updated_at: LATER_AT,
      });
      expect(
        db.prepare("SELECT state FROM calls WHERE id = ?").get(fixture.callId),
      ).toMatchObject({ state: "CLOSED" });
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 13: composes inside a caller transaction and rolls back with it", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      const before = truthSnapshot(db);

      class RollbackSignal extends Error {}
      expect(() =>
        withTransaction(db, () => {
          const created = commands.createSubmissionDraft(db, identityOf(fixture));
          const saved = commands.saveSubmissionDraft(db, {
            ...identityOf(fixture),
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: null,
          });
          const submitted = commands.submitSubmission(db, {
            ...identityOf(fixture),
            submissionId: created.id,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: saved.revisionId,
          });
          expect(submissionRow(db, created.id)).toMatchObject({
            state: "SUBMITTED",
            current_revision_id: submitted.revisionId,
          });
          throw new RollbackSignal("caller rollback");
        }),
      ).toThrow(RollbackSignal);
      expect(truthSnapshot(db)).toEqual(before);
      expect(db.isTransaction).toBe(false);

      // A failed command inside a caller transaction rolls back only its own savepoint.
      const outcome = withTransaction(db, () => {
        const created = commands.createSubmissionDraft(db, identityOf(fixture));
        expectCommandCode(
          () =>
            commands.saveSubmissionDraft(db, {
              ...identityOf(fixture),
              submissionId: created.id,
              historicalAnswers: completeAnswers(),
              expectedCurrentRevisionId: "",
            }),
          "COMMAND_INPUT_INVALID",
        );
        expectCommandCode(
          () =>
            commands.submitSubmission(db, {
              ...identityOf(fixture),
              submissionId: created.id,
              historicalAnswers: hiddenConsentAnswers(),
              expectedCurrentRevisionId: null,
            }),
          "SUBMISSION_INCOMPLETE",
        );
        return commands.submitSubmission(db, {
          ...identityOf(fixture),
          submissionId: created.id,
          historicalAnswers: completeAnswers(),
          expectedCurrentRevisionId: null,
        });
      });
      expect(submissionRow(db, outcome.submissionId)).toMatchObject({
        state: "SUBMITTED",
        current_revision_id: outcome.revisionId,
      });
      expect(revisionRows(db, outcome.submissionId)).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 14: exposes the same journey through the default wrappers", () => {
    const db = openDb({ path: ":memory:" });
    try {
      // The default wrappers use the real server clock, so this fixture is anchored to it.
      const nowMs = Date.now();
      const defaultWrapperDigest = digestFor("default-wrapper-session");
      const at = (offsetMs: number): string => new Date(nowMs + offsetMs).toISOString();
      const workspace = db.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as {
        id: string;
      };
      const account = db
        .prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1")
        .get(workspace.id) as { id: string };
      const organizer: OrganizerContext = { workspaceId: workspace.id, accountId: account.id };
      const created_at = at(-60 * 60 * 1000);
      const persistence = createCfpPersistence({ clock: () => created_at });
      db.prepare(
        `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "default-wrapper-event",
        organizer.workspaceId,
        "Default wrapper event",
        "UTC",
        at(30 * 24 * 60 * 60 * 1000),
        at(31 * 24 * 60 * 60 * 1000),
        created_at,
      );
      const definition = persistence.createFormDefinition(db, organizer, { name: "Default wrapper" });
      const sealed = persistence.sealFormVersion(db, organizer, {
        formDefinitionId: definition.id,
        fields: [
          { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      const call = persistence.createCall(db, organizer, {
        eventId: "default-wrapper-event",
        name: "Default wrapper call",
        slug: "default-wrapper-call",
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
          choices: [{ fieldId: "consent", statement: "Allow publication", required: true }],
        },
        accessMode: "PUBLIC",
        state: "OPEN",
        timezone: "UTC",
        opensAt: created_at,
        closesAt: at(24 * 60 * 60 * 1000),
      });
      db.prepare(
        `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "default-wrapper-person",
        organizer.workspaceId,
        "default.wrapper@synthetic.example",
        "Synthetic Applicant",
        created_at,
      );
      db.prepare(
        `INSERT INTO cfp_email_verifications
           (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "default-wrapper-verification",
        organizer.workspaceId,
        call.id,
        "default.wrapper@synthetic.example",
        digestFor("default-wrapper-verification"),
        at(14 * 24 * 60 * 60 * 1000),
        created_at,
      );
      db.prepare(
        `INSERT INTO cfp_email_verification_consumptions
           (id, workspace_id, verification_id, person_id, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "default-wrapper-consumption",
        organizer.workspaceId,
        "default-wrapper-verification",
        "default-wrapper-person",
        created_at,
      );
      db.prepare(
        `INSERT INTO cfp_applicant_sessions
           (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "default-wrapper-session",
        organizer.workspaceId,
        call.id,
        "default-wrapper-person",
        "default-wrapper-verification",
        defaultWrapperDigest,
        created_at,
        at(7 * 24 * 60 * 60 * 1000),
      );

      const identity = {
        workspaceId: organizer.workspaceId,
        callId: call.id,
        sessionTokenHash: defaultWrapperDigest,
      };
      const draft = createSubmissionDraft(db, identity);
      const saved = saveSubmissionDraft(db, {
        ...identity,
        submissionId: draft.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const submitted = submitSubmission(db, {
        ...identity,
        submissionId: draft.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: saved.revisionId,
      });
      expect(submissionRow(db, draft.id)).toMatchObject({
        state: "SUBMITTED",
        current_revision_id: submitted.revisionId,
        updated_at: submitted.submittedAt,
      });
      expectCommandCode(
        () => createSubmissionDraft(db, { ...identity, sessionTokenHash: "not-a-digest" }),
        "COMMAND_INPUT_INVALID",
      );
    } finally {
      closeDb(db);
    }
  });

  it("Evidence Group 15A: owns truthful transaction and savepoint cleanup", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const honest = commandsAt(COMMAND_AT);
      const persistence = createCfpPersistence({ clock: () => COMMAND_AT });
      const failAfterMutation = (sentinel: string): CfpSubmissionCommands =>
        commandsAt(COMMAND_AT, {
          createDraftSubmission: (probeDb, context, input) => {
            persistence.createDraftSubmission(probeDb, context, input);
            throw new Error(sentinel);
          },
        });
      let activeApplicant = fixture.applicant;
      const invokeCreate = (commands: CfpSubmissionCommands, publicDb: Db) =>
        commands.createSubmissionDraft(publicDb, identityOf(fixture, activeApplicant));

      const proveTopLevelFailure = (
        publicDb: Db,
        commands: CfpSubmissionCommands = honest,
      ): CfpSubmissionCommandError => {
        const before = truthSnapshot(db);
        const error = expectCommandCode(
          () => invokeCreate(commands, publicDb),
          "SUBMISSION_WRITE_FAILED",
        );
        expect(db.isTransaction).toBe(false);
        expect(truthSnapshot(db)).toEqual(before);
        expect(() => db.exec("COMMIT")).toThrow();
        return error;
      };

      let beginBeforeHits = 0;
      proveTopLevelFailure(
        withOneExecFailure(db, "BEGIN IMMEDIATE", "SQLITE_BEGIN_BEFORE_SECRET", () => {
          beginBeforeHits += 1;
        }),
      );
      expect(beginBeforeHits).toBe(1);

      let beginAfterHits = 0;
      proveTopLevelFailure(
        withOneAfterExec(db, "BEGIN IMMEDIATE", () => {
          beginAfterHits += 1;
          throw new Error("SQLITE_BEGIN_AFTER_SECRET");
        }),
      );
      expect(beginAfterHits).toBe(1);

      let rollbackBeforeHits = 0;
      proveTopLevelFailure(
        withOneExecFailure(db, "ROLLBACK", "SQLITE_ROLLBACK_BEFORE_SECRET", () => {
          rollbackBeforeHits += 1;
        }),
        failAfterMutation("SQLITE_MUTATION_THEN_FAILURE_BEFORE_ROLLBACK"),
      );
      expect(rollbackBeforeHits).toBe(1);

      let rollbackAfterHits = 0;
      proveTopLevelFailure(
        withOneAfterExec(db, "ROLLBACK", () => {
          rollbackAfterHits += 1;
          throw new Error("SQLITE_ROLLBACK_AFTER_SECRET");
        }),
        failAfterMutation("SQLITE_MUTATION_THEN_FAILURE_AFTER_ROLLBACK"),
      );
      expect(rollbackAfterHits).toBe(1);

      let commitBeforeHits = 0;
      let commitCleanupHits = 0;
      proveTopLevelFailure(
        withOneExecFailure(
          withOneExecFailure(db, "COMMIT", "SQLITE_COMMIT_BEFORE_SECRET", () => {
            commitBeforeHits += 1;
          }),
          "ROLLBACK",
          "SQLITE_COMMIT_CLEANUP_SECRET",
          () => {
            commitCleanupHits += 1;
          },
        ),
      );
      expect(commitBeforeHits).toBe(1);
      expect(commitCleanupHits).toBe(1);

      // Once a throwing COMMIT ends the transaction, its durable outcome is indeterminate to this
      // boundary. Even when this synthetic delegate committed, it must not return a receipt.
      let commitAfterHits = 0;
      let falseReceipt: CreatedSubmission | undefined;
      expectFatalStop(() => {
        falseReceipt = invokeCreate(
          honest,
          withOneAfterExec(db, "COMMIT", () => {
            commitAfterHits += 1;
            throw new Error("SQLITE_COMMIT_AFTER_SECRET");
          }),
        );
      });
      expect(falseReceipt).toBeUndefined();
      const committed = db
        .prepare(
          `SELECT id, state FROM submissions
           WHERE workspace_id = ? AND call_id = ? AND owner_person_id = ?`,
        )
        .get(
          fixture.workspaceId,
          fixture.callId,
          fixture.applicant.personId,
        ) as { readonly id: string; readonly state: string };
      expect(committed).toMatchObject({
        state: "DRAFT",
      });
      expect(commitAfterHits).toBe(1);
      expect(db.isTransaction).toBe(false);
      expect(submissionRow(db, committed.id)).toMatchObject({
        id: committed.id,
        state: "DRAFT",
      });
      // Durable create replay makes this identity converge on `committed`; use the fixture's other
      // applicant for the remaining mutation-and-cleanup probes so their writer still runs.
      activeApplicant = fixture.other;

      db.exec("CREATE TEMP TABLE command_caller_probe (value TEXT NOT NULL)");

      // Persistent exec faults cannot disarm themselves: only the independent prepared ROLLBACK
      // can remove this command's mutation and close its owned top-level transaction.
      let persistentRollbackHits = 0;
      const persistentTopLevelError = proveTopLevelFailure(
        withPersistentExecFailure(
          db,
          "ROLLBACK",
          "SQLITE_PERSISTENT_ROLLBACK_SECRET",
          () => {
            persistentRollbackHits += 1;
          },
        ),
        failAfterMutation("SQLITE_PERSISTENT_TOP_LEVEL_MUTATION_SECRET"),
      );
      expect(persistentRollbackHits).toBeGreaterThan(1);
      expect(persistentTopLevelError.message).not.toContain("PERSISTENT_ROLLBACK_SECRET");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO command_caller_probe (value) VALUES (?)").run(
        "persistent-top-level-after-cleanup",
      );
      db.exec("COMMIT");
      expect(
        db
          .prepare("SELECT value FROM command_caller_probe WHERE value = ?")
          .get("persistent-top-level-after-cleanup"),
      ).toEqual({ value: "persistent-top-level-after-cleanup" });

      const ownedSavepoint = ownedSavepointStatement(
        "SAVEPOINT",
        "cfp_create_submission_draft",
      );
      const ownedRollbackTo = ownedSavepointStatement(
        "ROLLBACK TO SAVEPOINT",
        "cfp_create_submission_draft",
      );
      const ownedRelease = ownedSavepointStatement(
        "RELEASE SAVEPOINT",
        "cfp_create_submission_draft",
      );

      const proveNestedFailure = (
        label: string,
        wrap: (callerDb: Db) => Db,
        commands: CfpSubmissionCommands = honest,
        afterCleanup?: () => void,
      ): CfpSubmissionCommandError => {
        db.exec("BEGIN IMMEDIATE");
        // The stable public base name belongs to the caller here. Per-invocation command names must
        // prevent any cleanup attempt from falling through to this boundary.
        db.exec('SAVEPOINT "cfp_create_submission_draft"');
        db.prepare("INSERT INTO command_caller_probe (value) VALUES (?)").run(label);
        const before = truthSnapshot(db);
        const error = expectCommandCode(
          () => invokeCreate(commands, wrap(db)),
          "SUBMISSION_WRITE_FAILED",
        );
        expect(db.isTransaction).toBe(true);
        expect(truthSnapshot(db)).toEqual(before);
        expect(
          db.prepare("SELECT value FROM command_caller_probe WHERE value = ?").get(label),
        ).toEqual({ value: label });
        afterCleanup?.();
        const afterLabel = `${label}-after-cleanup`;
        db.prepare("INSERT INTO command_caller_probe (value) VALUES (?)").run(afterLabel);
        expect(
          db.prepare("SELECT value FROM command_caller_probe WHERE value = ?").get(afterLabel),
        ).toEqual({ value: afterLabel });
        // Success proves the caller savepoint was neither released nor used as a cleanup target.
        db.exec('RELEASE SAVEPOINT "cfp_create_submission_draft"');
        db.exec("COMMIT");
        expect(db.isTransaction).toBe(false);
        expect(truthSnapshot(db)).toEqual(before);
        return error;
      };

      let savepointBeforeHits = 0;
      proveNestedFailure("savepoint-before", (callerDb) =>
        withOneExecFailure(
          callerDb,
          ownedSavepoint,
          "SQLITE_SAVEPOINT_BEFORE_SECRET",
          () => {
            savepointBeforeHits += 1;
          },
        ),
      );
      expect(savepointBeforeHits).toBe(1);

      let savepointAfterHits = 0;
      proveNestedFailure("savepoint-after", (callerDb) =>
        withOneAfterExec(callerDb, ownedSavepoint, () => {
          savepointAfterHits += 1;
          throw new Error("SQLITE_SAVEPOINT_AFTER_SECRET");
        }),
      );
      expect(savepointAfterHits).toBe(1);

      let releaseBeforeHits = 0;
      proveNestedFailure("release-before", (callerDb) =>
        withOneExecFailure(callerDb, ownedRelease, "SQLITE_RELEASE_BEFORE_SECRET", () => {
          releaseBeforeHits += 1;
        }),
      );
      expect(releaseBeforeHits).toBe(1);

      for (const kind of ["before", "after"] as const) {
        let rollbackToHits = 0;
        proveNestedFailure(
          `rollback-to-${kind}`,
          (callerDb) =>
            kind === "before"
              ? withOneExecFailure(
                  callerDb,
                  ownedRollbackTo,
                  "SQLITE_ROLLBACK_TO_BEFORE_SECRET",
                  () => {
                    rollbackToHits += 1;
                  },
                )
              : withOneAfterExec(callerDb, ownedRollbackTo, () => {
                  rollbackToHits += 1;
                  throw new Error("SQLITE_ROLLBACK_TO_AFTER_SECRET");
                }),
          failAfterMutation(`SQLITE_NESTED_MUTATION_${kind}_ROLLBACK_TO`),
        );
        expect(rollbackToHits).toBe(1);
      }

      for (const kind of ["before", "after"] as const) {
        let cleanupReleaseHits = 0;
        proveNestedFailure(
          `cleanup-release-${kind}`,
          (callerDb) =>
            kind === "before"
              ? withOneExecFailure(
                  callerDb,
                  ownedRelease,
                  "SQLITE_CLEANUP_RELEASE_BEFORE_SECRET",
                  () => {
                    cleanupReleaseHits += 1;
                  },
                )
              : withOneAfterExec(callerDb, ownedRelease, () => {
                  cleanupReleaseHits += 1;
                  throw new Error("SQLITE_CLEANUP_RELEASE_AFTER_SECRET");
                }),
          failAfterMutation(`SQLITE_NESTED_MUTATION_${kind}_CLEANUP_RELEASE`),
        );
        expect(cleanupReleaseHits).toBe(1);
      }

      let persistentRollbackToHits = 0;
      let persistentReleaseHits = 0;
      let persistentOwnedName: string | undefined;
      const rememberPersistentOwnedName = (sql: string): void => {
        const match = /"([A-Za-z][A-Za-z0-9_]*)"$/u.exec(sql);
        if (!match?.[1]) {
          throw new Error("Owned cleanup statement did not carry a bounded name.");
        }
        if (persistentOwnedName !== undefined && persistentOwnedName !== match[1]) {
          throw new Error("Owned cleanup statements did not address one boundary.");
        }
        persistentOwnedName = match[1];
      };
      const persistentNestedError = proveNestedFailure(
        "persistent-exec-cleanup",
        (callerDb) =>
          withPersistentExecFailure(
            withPersistentExecFailure(
              callerDb,
              ownedRollbackTo,
              "SQLITE_PERSISTENT_ROLLBACK_TO_SECRET",
              (sql) => {
                persistentRollbackToHits += 1;
                rememberPersistentOwnedName(sql);
              },
            ),
            ownedRelease,
            "SQLITE_PERSISTENT_RELEASE_SECRET",
            (sql) => {
              persistentReleaseHits += 1;
              rememberPersistentOwnedName(sql);
            },
          ),
        failAfterMutation("SQLITE_PERSISTENT_NESTED_MUTATION_SECRET"),
        () => {
          if (persistentOwnedName === undefined) {
            throw new Error("Persistent cleanup did not expose its owned boundary name.");
          }
          expectOwnedSavepointMissing(db, persistentOwnedName);
        },
      );
      expect(persistentRollbackToHits).toBeGreaterThan(1);
      expect(persistentReleaseHits).toBeGreaterThan(1);
      expect(persistentNestedError.message).not.toContain("PERSISTENT_ROLLBACK_TO_SECRET");
      expect(persistentNestedError.message).not.toContain("PERSISTENT_RELEASE_SECRET");

      // If both independent mechanisms are unavailable, the command cannot safely clean only its
      // boundary. It emits a distinct fatal stop while leaving the caller's transaction intact;
      // the caller then abandons that transaction instead of treating the command as rolled back.
      db.exec("BEGIN IMMEDIATE");
      db.exec('SAVEPOINT "cfp_create_submission_draft"');
      db.prepare("INSERT INTO command_caller_probe (value) VALUES (?)").run(
        "fatal-stop-caller-work",
      );
      const beforeFatalStop = truthSnapshot(db);
      let fatalExecHits = 0;
      let fatalPrepareHits = 0;
      let fatalCleanupArmed = false;
      const unavailableCleanupDb = new Proxy(db, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string): void => {
              if (fatalCleanupArmed && matchesExecStatement(sql, ownedRollbackTo)) {
                fatalExecHits += 1;
                throw new Error("SQLITE_FATAL_EXEC_CLEANUP_SECRET");
              }
              target.exec(sql);
            };
          }
          if (property === "prepare") {
            return (sql: string) => {
              if (fatalCleanupArmed && matchesExecStatement(sql, ownedRollbackTo)) {
                fatalPrepareHits += 1;
                throw new Error("SQLITE_FATAL_PREPARE_CLEANUP_SECRET");
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;
      const fatalStop = expectFatalStop(() =>
        invokeCreate(
          commandsAt(COMMAND_AT, {
            createDraftSubmission: (probeDb, context, input) => {
              const created = createCfpPersistence({ clock: () => COMMAND_AT })
                .createDraftSubmission(probeDb, context, input);
              fatalCleanupArmed = true;
              throw new Error(`SQLITE_FATAL_UNPROVEN_MUTATION_SECRET_${created.id}`);
            },
          }),
          unavailableCleanupDb,
        ),
      );
      expect(fatalExecHits).toBeGreaterThan(1);
      expect(fatalPrepareHits).toBeGreaterThan(1);
      expect(fatalStop.message).not.toContain("FATAL_EXEC_CLEANUP_SECRET");
      expect(fatalStop.message).not.toContain("FATAL_PREPARE_CLEANUP_SECRET");
      expect(db.isTransaction).toBe(true);
      expect(
        db
          .prepare("SELECT value FROM command_caller_probe WHERE value = ?")
          .get("fatal-stop-caller-work"),
      ).toEqual({ value: "fatal-stop-caller-work" });
      expect(truthSnapshot(db)).not.toEqual(beforeFatalStop);
      db.exec("ROLLBACK");
      expect(db.isTransaction).toBe(false);
      expect(truthSnapshot(db)).toEqual(beforeFatalStop);

      // Unlike a top-level COMMIT, the owned witness can prove a delegate-then-throw RELEASE. The
      // mutation remains inside (and only inside) the caller's transaction until the caller acts.
      db.exec("BEGIN IMMEDIATE");
      db.exec('SAVEPOINT "cfp_create_submission_draft"');
      db.prepare("INSERT INTO command_caller_probe (value) VALUES (?)").run("release-after");
      let releaseAfterHits = 0;
      const released = invokeCreate(
        honest,
        withOneAfterExec(db, ownedRelease, () => {
          releaseAfterHits += 1;
          throw new Error("SQLITE_RELEASE_AFTER_SECRET");
        }),
      );
      expect(releaseAfterHits).toBe(1);
      expect(db.isTransaction).toBe(true);
      expect(submissionRow(db, released.id)).toMatchObject({
        id: released.id,
        state: "DRAFT",
      });
      expect(
        db.prepare("SELECT value FROM command_caller_probe WHERE value = ?").get("release-after"),
      ).toEqual({ value: "release-after" });
      db.exec('RELEASE SAVEPOINT "cfp_create_submission_draft"');
      db.exec("COMMIT");
      expect(db.isTransaction).toBe(false);
      expect(submissionRow(db, released.id)).toMatchObject({
        id: released.id,
        state: "DRAFT",
      });
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      closeDb(db);
    }
  });

  it("Evidence Group 15A1: never returns a receipt when COMMIT rolls back then throws", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      let falseReceipt: CreatedSubmission | undefined;
      const rollbackThenThrow = new Proxy(db, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string): void => {
              if (sql.trim() === "COMMIT") {
                target.exec("ROLLBACK");
                throw new Error("SQLITE_INDETERMINATE_COMMIT_SECRET");
              }
              target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;

      expectFatalStop(() => {
        falseReceipt = commands.createSubmissionDraft(rollbackThenThrow, identityOf(fixture));
      });
      expect(falseReceipt).toBeUndefined();
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({ count: 0 });
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      closeDb(db);
    }
  });

  it("Evidence Group 15A2: retires after throwing COMMIT makes state unreadable", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sympose-submission-fatal-commit-"));
    const databasePath = resolve(directory, "commit.db");
    const db = openDb({ path: databasePath });
    let retired = false;
    try {
      const fixture = setupFixture(db);
      const commands = commandsAt(COMMAND_AT);
      let poisonStateProbe = false;
      let falseReceipt: CreatedSubmission | undefined;
      const committedThenUnreadable = new Proxy(db, {
        get(target, property) {
          if (property === "isTransaction" && poisonStateProbe) {
            throw new Error("SQLITE_TRANSACTION_STATE_SECRET");
          }
          if (property === "exec") {
            return (sql: string): void => {
              if (sql.trim() === "COMMIT") {
                target.exec(sql);
                poisonStateProbe = true;
                throw new Error("SQLITE_POST_COMMIT_SECRET");
              }
              target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;

      const outcome = captureWithFatalConnectionRetirement(
        committedThenUnreadable,
        () => {
          falseReceipt = commands.createSubmissionDraft(
            committedThenUnreadable,
            identityOf(fixture),
          );
        },
      );
      retired = outcome.retired;
      expect(falseReceipt).toBeUndefined();
      expect(outcome.error).toBeInstanceOf(CfpSubmissionCommandFatalError);
      expect((outcome.error as CfpSubmissionCommandFatalError).fatal).toBe(true);
      expect(outcome.error.message).toBe("The CFP submission command cannot continue safely.");
      expectNoLeak(outcome.error);
      expect(retired).toBe(true);
      expectConnectionRetired(db);

      const verification = openDb({ path: databasePath });
      try {
        expect(verification.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({
          count: 1,
        });
        expect(verification.prepare("SELECT state FROM submissions").get()).toEqual({
          state: "DRAFT",
        });
      } finally {
        closeDb(verification);
      }
    } finally {
      if (!retired) closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("Evidence Group 15A3: retires when partial-write rollback state is unreadable", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sympose-submission-fatal-rollback-"));
    const databasePath = resolve(directory, "rollback.db");
    const db = openDb({ path: databasePath });
    let retired = false;
    try {
      const fixture = setupFixture(db);
      const persistence = createCfpPersistence({ clock: () => COMMAND_AT });
      let poisonStateProbe = false;
      let partialWriteFaulted = false;
      let rollbackFaulted = false;
      let falseReceipt: CreatedSubmission | undefined;
      const unreadableAfterRollbackFault = new Proxy(db, {
        get(target, property) {
          if (property === "isTransaction" && poisonStateProbe) {
            throw new Error("SQLITE_TRANSACTION_STATE_SECRET");
          }
          if (property === "exec") {
            return (sql: string): void => {
              if (sql.trim() === "ROLLBACK") {
                rollbackFaulted = true;
                poisonStateProbe = true;
                throw new Error("SQLITE_ROLLBACK_OUTCOME_SECRET");
              }
              target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;
      const commands = commandsAt(COMMAND_AT, {
        createDraftSubmission: (probeDb, context, input) => {
          persistence.createDraftSubmission(probeDb, context, input);
          partialWriteFaulted = true;
          throw new Error("SQLITE_PARTIAL_WRITE_SECRET");
        },
      });

      const outcome = captureWithFatalConnectionRetirement(
        unreadableAfterRollbackFault,
        () => {
          falseReceipt = commands.createSubmissionDraft(
            unreadableAfterRollbackFault,
            identityOf(fixture),
          );
        },
      );
      retired = outcome.retired;
      expect(falseReceipt).toBeUndefined();
      expect(partialWriteFaulted).toBe(true);
      expect(rollbackFaulted).toBe(true);
      expect(outcome.error).toBeInstanceOf(CfpSubmissionCommandFatalError);
      expect((outcome.error as CfpSubmissionCommandFatalError).fatal).toBe(true);
      expect(outcome.error.message).toBe("The CFP submission command cannot continue safely.");
      expectNoLeak(outcome.error);
      expect(retired).toBe(true);
      expectConnectionRetired(db);

      const verification = openDb({ path: databasePath });
      try {
        expect(verification.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({
          count: 0,
        });
        expect(
          verification.prepare("SELECT COUNT(*) AS count FROM submission_revisions").get(),
        ).toEqual({ count: 0 });
      } finally {
        closeDb(verification);
      }
    } finally {
      if (!retired) closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("Evidence Group 15B: rejects silent boundary delegation", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const persistence = createCfpPersistence({ clock: () => COMMAND_AT });
      const honest = commandsAt(COMMAND_AT);

      let writerHits = 0;
      const silentBeginCommands = commandsAt(COMMAND_AT, {
        createDraftSubmission: (probeDb, context, input) => {
          writerHits += 1;
          return persistence.createDraftSubmission(probeDb, context, input);
        },
      });
      const beforeSilentBegin = truthSnapshot(db);
      expectCommandCode(
        () =>
          silentBeginCommands.createSubmissionDraft(
            withOneSilentExec(db, "BEGIN IMMEDIATE"),
            identityOf(fixture),
          ),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(writerHits).toBe(0);
      expect(db.isTransaction).toBe(false);
      expect(truthSnapshot(db)).toEqual(beforeSilentBegin);
      expect(() => db.exec("COMMIT")).toThrow();

      db.exec("CREATE TEMP TABLE command_silent_boundary_probe (value TEXT NOT NULL)");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO command_silent_boundary_probe (value) VALUES (?)").run(
        "caller-before",
      );

      let nestedWriterHits = 0;
      const nestedSilentSavepointCommands = commandsAt(COMMAND_AT, {
        createDraftSubmission: (probeDb, context, input) => {
          nestedWriterHits += 1;
          return persistence.createDraftSubmission(probeDb, context, input);
        },
      });
      const beforeSilentSavepoint = truthSnapshot(db);
      expectCommandCode(
        () =>
          nestedSilentSavepointCommands.createSubmissionDraft(
            withOneSilentExec(
              db,
              /SAVEPOINT "cfp_create_submission_draft_[0-9a-f]{32}"/u,
            ),
            identityOf(fixture),
          ),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(nestedWriterHits).toBe(0);
      expect(db.isTransaction).toBe(true);
      expect(truthSnapshot(db)).toEqual(beforeSilentSavepoint);

      const beforeSilentRollback = truthSnapshot(db);
      let silentRollbackHits = 0;
      const failingCommands = commandsAt(COMMAND_AT, {
        createDraftSubmission: (probeDb, context, input) => {
          persistence.createDraftSubmission(probeDb, context, input);
          throw new Error("SILENT_ROLLBACK_TO_MUTATION");
        },
      });
      const silentRollbackDb = withOneSilentExec(
        db,
        /ROLLBACK TO SAVEPOINT "cfp_create_submission_draft_[0-9a-f]{32}"/u,
        () => {
          silentRollbackHits += 1;
        },
      );
      expectCommandCode(
        () => failingCommands.createSubmissionDraft(silentRollbackDb, identityOf(fixture)),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(silentRollbackHits).toBe(1);
      expect(db.isTransaction).toBe(true);
      expect(truthSnapshot(db)).toEqual(beforeSilentRollback);
      expect(
        db.prepare("SELECT value FROM command_silent_boundary_probe WHERE value = ?").get(
          "caller-before",
        ),
      ).toEqual({ value: "caller-before" });
      db.prepare("INSERT INTO command_silent_boundary_probe (value) VALUES (?)").run(
        "caller-after",
      );
      db.exec("COMMIT");
      expect(db.isTransaction).toBe(false);
      expect(
        db
          .prepare("SELECT value FROM command_silent_boundary_probe ORDER BY value")
          .all(),
      ).toEqual([{ value: "caller-after" }, { value: "caller-before" }]);
      expect(truthSnapshot(db)).toEqual(beforeSilentRollback);

      db.exec("BEGIN IMMEDIATE");
      const beforePoisonedCleanup = truthSnapshot(db);
      let poisonedCleanupHits = 0;
      const rollbackMatcherForPoison = ownedSavepointStatement(
        "ROLLBACK TO SAVEPOINT",
        "cfp_create_submission_draft",
      );
      const poisonedCleanupDb = new Proxy(db, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string): void => {
              if (
                poisonedCleanupHits === 0 &&
                matchesExecStatement(sql, rollbackMatcherForPoison)
              ) {
                poisonedCleanupHits += 1;
                const poisoned = new Error("POISONED_CLEANUP_DETAIL");
                Object.defineProperty(poisoned, "code", {
                  get: () => {
                    throw new Error("POISONED_CODE_GETTER_DETAIL");
                  },
                });
                throw new Proxy(poisoned, {
                  getPrototypeOf: () => {
                    throw new Error("POISONED_PROTOTYPE_DETAIL");
                  },
                });
              }
              target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;
      const poisonedResult = expectCommandCode(
        () => failingCommands.createSubmissionDraft(poisonedCleanupDb, identityOf(fixture)),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(poisonedCleanupHits).toBe(1);
      expect(poisonedResult.message).not.toContain("POISONED");
      expect(db.isTransaction).toBe(true);
      expect(truthSnapshot(db)).toEqual(beforePoisonedCleanup);
      db.exec("COMMIT");
      expect(db.isTransaction).toBe(false);

      db.exec("BEGIN IMMEDIATE");
      db.exec('SAVEPOINT "cfp_create_draft"');
      const beforeInnerCollision = truthSnapshot(db);
      let skippedScopedInnerSavepoint = 0;
      expectPersistenceCode(
        () =>
          honest.createSubmissionDraft(
            withOneSilentExec(
              db,
              /SAVEPOINT "cfp_create_draft_[0-9a-f]{32}"/u,
              () => {
                skippedScopedInnerSavepoint += 1;
              },
            ),
            identityOf(fixture),
          ),
        "PERSISTENCE_WRITE_FAILED",
      );
      expect(skippedScopedInnerSavepoint).toBe(1);
      expect(db.isTransaction).toBe(true);
      expect(truthSnapshot(db)).toEqual(beforeInnerCollision);
      db.exec('RELEASE SAVEPOINT "cfp_create_draft"');
      db.exec("COMMIT");
      expect(db.isTransaction).toBe(false);

      db.exec("BEGIN IMMEDIATE");
      const releaseMatcher = ownedSavepointStatement(
        "RELEASE SAVEPOINT",
        "cfp_create_submission_draft",
      );
      const rollbackMatcher = ownedSavepointStatement(
        "ROLLBACK TO SAVEPOINT",
        "cfp_create_submission_draft",
      );
      let releaseDelegated = false;
      let silentReleaseProofHits = 0;
      const oneHealthyReleaseProofDb = new Proxy(db, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string): void => {
              if (releaseDelegated && matchesExecStatement(sql, rollbackMatcher)) {
                silentReleaseProofHits += 1;
                return;
              }
              target.exec(sql);
              if (matchesExecStatement(sql, releaseMatcher)) releaseDelegated = true;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;
      const releasedWithPreparedProof = honest.createSubmissionDraft(
        oneHealthyReleaseProofDb,
        identityOf(fixture),
      );
      expect(silentReleaseProofHits).toBeGreaterThan(1);
      expect(db.isTransaction).toBe(true);
      expect(submissionRow(db, releasedWithPreparedProof.id)).toMatchObject({
        id: releasedWithPreparedProof.id,
        state: "DRAFT",
      });
      db.exec("ROLLBACK");
      expect(db.isTransaction).toBe(false);
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      closeDb(db);
    }
  });

  it("Evidence Group 15C: separates spoofed fatal errors from genuine unrecoverable cleanup", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const fixture = setupFixture(db);
      const identity = identityOf(fixture);
      const persistence = createCfpPersistence({ clock: () => COMMAND_AT });
      const spoofedFatal = new CfpSubmissionCommandFatalError();
      Object.assign(spoofedFatal, {
        fatal: false,
        message: `SPOOFED_DEPENDENCY_FATAL_${SECRET_ANSWER}`,
        name: "SpoofedDependencyFatal",
      });
      const spoofingCommands = commandsAt(COMMAND_AT, {
        createDraftSubmission: (probeDb, context, input) => {
          persistence.createDraftSubmission(probeDb, context, input);
          throw spoofedFatal;
        },
      });
      const beforeSpoof = truthSnapshot(db);
      const ordinary = expectCommandCode(
        () => spoofingCommands.createSubmissionDraft(db, identityOf(fixture)),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(ordinary).not.toBeInstanceOf(CfpSubmissionCommandFatalError);
      expect(ordinary.message).toBe(STABLE_COMMAND_MESSAGES.SUBMISSION_WRITE_FAILED);
      expect(ordinary.message).not.toContain("SPOOFED_DEPENDENCY_FATAL");
      expect(truthSnapshot(db)).toEqual(beforeSpoof);

      const spoofedCommand = new CfpSubmissionCommandError("SUBMISSION_NOT_FOUND");
      Object.assign(spoofedCommand, {
        message: `SPOOFED_COMMAND_${identity.sessionTokenHash}`,
      });
      const spoofingCommandError = commandsAt(COMMAND_AT, {
        resolveApplicantSession: () => {
          throw spoofedCommand;
        },
      });
      const directSpoof = expectCommandCode(
        () => spoofingCommandError.createSubmissionDraft(db, identity),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(directSpoof.message).toBe(STABLE_COMMAND_MESSAGES.SUBMISSION_WRITE_FAILED);
      expect(directSpoof.message).not.toContain(identity.sessionTokenHash);
      expect(truthSnapshot(db)).toEqual(beforeSpoof);

      const outwardUnknown = expectCommandCode(
        () =>
          commandsAt(COMMAND_AT, {
            resolveApplicantSession: () => {
              throw new Error("UNKNOWN_DEPENDENCY_DETAIL");
            },
          }).createSubmissionDraft(db, identity),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(Object.isFrozen(outwardUnknown)).toBe(true);

      const hostilePrototype = new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error(`HOSTILE_PROTOTYPE_${identity.sessionTokenHash}`);
          },
        },
      );
      const hostilePrototypeResult = expectCommandCode(
        () =>
          commandsAt(COMMAND_AT, {
            resolveApplicantSession: () => {
              throw hostilePrototype;
            },
          }).createSubmissionDraft(db, identity),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(hostilePrototypeResult.message).toBe(
        STABLE_COMMAND_MESSAGES.SUBMISSION_WRITE_FAILED,
      );
      expect(hostilePrototypeResult.message).not.toContain(identity.sessionTokenHash);

      const replayedUnknown = expectCommandCode(
        () =>
          commandsAt(COMMAND_AT, {
            resolveApplicantSession: () => {
              throw outwardUnknown;
            },
          }).createSubmissionDraft(db, identity),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(replayedUnknown.message).toBe(STABLE_COMMAND_MESSAGES.SUBMISSION_WRITE_FAILED);

      const poisonedAccess = new CfpApplicantAccessError("CALL_NOT_ACCEPTING");
      Object.defineProperty(poisonedAccess, "code", {
        value: identity.sessionTokenHash,
      });
      const accessSpoof = expectCommandCode(
        () =>
          commandsAt(COMMAND_AT, {
            resolveApplicantSession: () => {
              throw poisonedAccess;
            },
          }).createSubmissionDraft(db, identity),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(accessSpoof.message).not.toContain(identity.sessionTokenHash);

      let changingAccessReads = 0;
      const changingAccess = new CfpApplicantAccessError("CALL_NOT_ACCEPTING");
      Object.defineProperty(changingAccess, "code", {
        get: () => {
          changingAccessReads += 1;
          return changingAccessReads === 1 ? "CALL_NOT_ACCEPTING" : identity.sessionTokenHash;
        },
      });
      const stableAccess = expectAccessCode(
        () =>
          commandsAt(COMMAND_AT, {
            resolveApplicantSession: () => {
              throw changingAccess;
            },
          }).createSubmissionDraft(db, identity),
        "CALL_NOT_ACCEPTING",
      );
      expect(changingAccessReads).toBe(1);
      expect(stableAccess.message).not.toContain(identity.sessionTokenHash);

      const poisonedPersistence = new FormDocumentPersistenceError("PERSISTENCE_WRITE_FAILED");
      Object.defineProperty(poisonedPersistence, "code", {
        value: identity.sessionTokenHash,
      });
      const persistenceSpoof = expectCommandCode(
        () =>
          commandsAt(COMMAND_AT, {
            createDraftSubmission: () => {
              throw poisonedPersistence;
            },
          }).createSubmissionDraft(db, identity),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(persistenceSpoof.message).not.toContain(identity.sessionTokenHash);

      let changingPersistenceReads = 0;
      const changingPersistence = new FormDocumentPersistenceError("PERSISTENCE_WRITE_FAILED");
      Object.defineProperty(changingPersistence, "code", {
        get: () => {
          changingPersistenceReads += 1;
          return changingPersistenceReads === 1
            ? "PERSISTENCE_WRITE_FAILED"
            : identity.sessionTokenHash;
        },
      });
      const stablePersistence = expectPersistenceCode(
        () =>
          commandsAt(COMMAND_AT, {
            createDraftSubmission: () => {
              throw changingPersistence;
            },
          }).createSubmissionDraft(db, identity),
        "PERSISTENCE_WRITE_FAILED",
      );
      expect(changingPersistenceReads).toBe(1);
      expect(stablePersistence.message).not.toContain(identity.sessionTokenHash);
      expect(truthSnapshot(db)).toEqual(beforeSpoof);

      const beforeFatal = truthSnapshot(db);
      const fatalDb = withPersistentPrepareFailure(
        withPersistentExecFailure(
          db,
          "ROLLBACK",
          "SILENT_FATAL_EXEC_CLEANUP_SECRET",
        ),
        "ROLLBACK",
        "SILENT_FATAL_PREPARE_CLEANUP_SECRET",
      );
      const fatalStop = expectFatalStop(() =>
        commandsAt(COMMAND_AT, {
          createDraftSubmission: (probeDb, context, input) => {
            persistence.createDraftSubmission(probeDb, context, input);
            throw new Error("GENUINE_TOP_LEVEL_BOTH_CLEANUP_PATHS_SECRET");
          },
        }).createSubmissionDraft(fatalDb, identityOf(fixture)),
      );
      expect(fatalStop.message).toBe("The CFP submission command cannot continue safely.");
      expect(fatalStop.message).not.toContain("GENUINE_TOP_LEVEL_BOTH_CLEANUP_PATHS_SECRET");
      expect(db.isTransaction).toBe(true);
      expect(truthSnapshot(db)).not.toEqual(beforeFatal);
      db.exec("ROLLBACK");
      expect(db.isTransaction).toBe(false);
      expect(truthSnapshot(db)).toEqual(beforeFatal);

      const replayingFatal = commandsAt(COMMAND_AT, {
        createDraftSubmission: () => {
          throw fatalStop;
        },
      });
      const replay = expectCommandCode(
        () => replayingFatal.createSubmissionDraft(db, identityOf(fixture)),
        "SUBMISSION_WRITE_FAILED",
      );
      expect(replay).not.toBeInstanceOf(CfpSubmissionCommandFatalError);
      expect(replay.message).toBe(STABLE_COMMAND_MESSAGES.SUBMISSION_WRITE_FAILED);
      expect(db.isTransaction).toBe(false);
      expect(truthSnapshot(db)).toEqual(beforeFatal);
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      closeDb(db);
    }
  });

  it("Evidence Group 15: proves a real two-connection SQLite contention race", async () => {
    type RaceKind = "create-create" | "submit-submit" | "save-save" | "save-submit" | "submit-save";
    type RaceOperation = "create" | "save" | "submit";
    type RaceOutcome = {
      ok: boolean;
      pid: number;
      operation: RaceOperation;
      code?: string;
      submissionId?: string;
      revisionId?: string;
    };

    const operationFor = (kind: RaceKind, contender: string): RaceOperation => {
      if (kind === "create-create") return "create";
      return kind === "submit-submit" || (kind === "submit-save" && contender === "a") ||
        (kind === "save-submit" && contender === "b")
        ? "submit"
        : "save";
    };

    if (process.env.SYMPOSE_PERSISTENT_RACE_ACTOR === "1") {
      return runPersistentRaceActor(() => {
        const raceDb = openDb({ path: process.env.CFP_RACE_DB!, seed: false });
        let outcome: RaceOutcome;
        try {
        const kind = process.env.CFP_RACE_KIND! as RaceKind;
        const contender = process.env.CFP_RACE_CONTENDER!;
        const identity = {
          workspaceId: process.env.CFP_RACE_WORKSPACE!,
          callId: process.env.CFP_RACE_CALL!,
          sessionTokenHash: process.env.CFP_RACE_DIGEST!,
        };
        const commands = commandsAt(COMMAND_AT);

        let publicDb: Db;
        if (contender === "a") {
          publicDb = new Proxy(raceDb, {
            get(target, property) {
              if (property === "exec") {
                return (sql: string): void => {
                  target.exec(sql);
                  if (sql.trim() === "BEGIN IMMEDIATE") {
                    expect(target.isTransaction).toBe(true);
                    writeFileSync(process.env.CFP_RACE_OWNER_MARKER!, String(process.pid), "utf8");
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

        const operation = operationFor(kind, contender);
        if (operation === "create") {
          const result = commands.createSubmissionDraft(publicDb, identity);
          outcome = {
            ok: true,
            pid: process.pid,
            operation,
            submissionId: result.id,
          };
        } else {
          const input = {
            ...identity,
            submissionId: process.env.CFP_RACE_SUBMISSION!,
            historicalAnswers: completeAnswers(),
            expectedCurrentRevisionId: null,
          };
          const revisionId =
            operation === "submit"
              ? commands.submitSubmission(publicDb, input).revisionId
              : commands.saveSubmissionDraft(publicDb, input).revisionId;
          outcome = { ok: true, pid: process.pid, operation, revisionId };
        }
      } catch (error) {
        const kind = process.env.CFP_RACE_KIND! as RaceKind;
        const contender = process.env.CFP_RACE_CONTENDER!;
        const operation = operationFor(kind, contender);
        outcome = {
          ok: false,
          pid: process.pid,
          operation,
          code:
            error instanceof CfpSubmissionCommandError ||
            error instanceof FormDocumentPersistenceError ||
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
        testFile: "tests/unit/cfp-submissions.test.ts",
        testName: "Evidence Group 15: proves a real two-connection SQLite contention race$",
      })),
    ];
    const runRace = async (
      kind: RaceKind,
      verify: (
        db: Db,
        outcomes: readonly RaceOutcome[],
        submissionId: string | null,
        fixture: Fixture,
      ) => void,
    ): Promise<void> => {
      const prefix = resolve(
        ".tmp/unit",
        `cfp-submission-race-${kind}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const dbPath = `${prefix}.db`;
      const ownerMarker = `${prefix}.owner-held`;
      const busyMarker = `${prefix}.contender-busy`;
      const releaseMarker = `${prefix}.owner-release`;
      const resultPaths = [`${prefix}.a.json`, `${prefix}.b.json`];
      const artifactPaths = [ownerMarker, busyMarker, releaseMarker, ...resultPaths];
      for (const path of artifactPaths) rmSync(path, { force: true });
      removeSqliteFiles(dbPath);

      let setupDb: Db | null = openDb({ path: dbPath });
      const fixture = setupFixture(setupDb);
      const submissionId =
        kind === "create-create"
          ? null
          : commandsAt(COMMAND_AT).createSubmissionDraft(setupDb, identityOf(fixture)).id;
      closeDb(setupDb);
      setupDb = null;

      const runContender = (contender: "a" | "b", index: number): Promise<number> =>
        children[contender === "a" ? 0 : 1]!.request({
          CFP_RACE_KIND: kind,
          CFP_RACE_CONTENDER: contender,
          CFP_RACE_DB: dbPath,
          CFP_RACE_WORKSPACE: fixture.workspaceId,
          CFP_RACE_CALL: fixture.callId,
          CFP_RACE_SUBMISSION: submissionId ?? "",
          CFP_RACE_DIGEST: fixture.applicant.sessionTokenHash,
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
          verify(verifyDb, outcomes, submissionId, fixture);
        } finally {
          closeDb(verifyDb);
        }
      } finally {
        if (setupDb !== null) closeDb(setupDb);
        for (const path of artifactPaths) rmSync(path, { force: true });
        removeSqliteFiles(dbPath);
      }
      expect(
        [...artifactPaths, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`].every(
          (path) => !existsSync(path),
        ),
      ).toBe(true);
    };

    try {
      await runRace("create-create", (db, outcomes, submissionId, fixture) => {
      expect(submissionId).toBeNull();
      expect(outcomes[0]).toMatchObject({ ok: true, operation: "create" });
      expect(outcomes[1]).toMatchObject({ ok: true, operation: "create" });
      expect(outcomes[0]!.submissionId).toBe(outcomes[1]!.submissionId);
      expect(db.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({ count: 1 });
      const row = db.prepare("SELECT id FROM submissions").get() as { id: string };
      expect(row.id).toBe(outcomes[0]!.submissionId);
      const recovered = commandsAt(COMMAND_AT).createSubmissionDraft(db, identityOf(fixture));
      expect(recovered.id).toBe(row.id);
      expect(db.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({ count: 1 });
    });

      await runRace("submit-submit", (db, outcomes, submissionId) => {
      if (submissionId === null) throw new Error("Submit race did not receive a submission.");
      expect(outcomes[0]).toMatchObject({ ok: true });
      expect(outcomes[1]).toMatchObject({ ok: false, code: "SUBMISSION_NOT_DRAFT" });
      expect(revisionRows(db, submissionId)).toHaveLength(1);
      expect(submissionRow(db, submissionId)).toMatchObject({
        state: "SUBMITTED",
        current_revision_id: outcomes[0]!.revisionId,
      });
    });

      await runRace("save-save", (db, outcomes, submissionId) => {
      if (submissionId === null) throw new Error("Save race did not receive a submission.");
      expect(outcomes[0]).toMatchObject({ ok: true, operation: "save" });
      expect(outcomes[1]).toMatchObject({
        ok: false,
        operation: "save",
        code: "STALE_REVISION",
      });
      expect(revisionRows(db, submissionId)).toHaveLength(1);
      expect(submissionRow(db, submissionId)).toMatchObject({
        state: "DRAFT",
        current_revision_id: outcomes[0]!.revisionId,
      });
    });

      await runRace("save-submit", (db, outcomes, submissionId) => {
      if (submissionId === null) throw new Error("Mixed race did not receive a submission.");
      expect(outcomes[0]).toMatchObject({ ok: true, operation: "save" });
      expect(outcomes[1]).toMatchObject({
        ok: false,
        operation: "submit",
        code: "STALE_REVISION",
      });
      expect(revisionRows(db, submissionId)).toHaveLength(1);
      expect(submissionRow(db, submissionId)).toMatchObject({
        state: "DRAFT",
        current_revision_id: outcomes[0]!.revisionId,
      });
    });

      await runRace("submit-save", (db, outcomes, submissionId) => {
      if (submissionId === null) throw new Error("Mixed race did not receive a submission.");
      expect(outcomes[0]).toMatchObject({ ok: true, operation: "submit" });
      expect(outcomes[1]).toMatchObject({
        ok: false,
        operation: "save",
        code: "SUBMISSION_NOT_DRAFT",
      });
      expect(revisionRows(db, submissionId)).toHaveLength(1);
      expect(submissionRow(db, submissionId)).toMatchObject({
        state: "SUBMITTED",
        current_revision_id: outcomes[0]!.revisionId,
      });
      });
    } finally {
      await stopPersistentRaceActors(children);
    }
  }, 180_000);
});
