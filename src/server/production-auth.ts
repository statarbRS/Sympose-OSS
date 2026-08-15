import { randomBytes } from "node:crypto";

import { createSession, revokeSession, type CreateSessionResult } from "./auth";
import { nowIso, sha256Hex, uuid } from "./canonical";
import { withTransaction, type Db } from "./db";
import { requireRuntimeDataMode } from "./runtime-mode";
import {
  deriveProductionVerifier,
  productionSecretMatches,
  PRODUCTION_AUTH_KDF,
} from "./production-bootstrap";

export {
  PRODUCTION_BOOTSTRAP_ISSUED_AT_ENV,
  PRODUCTION_BOOTSTRAP_TOKEN_ENV,
  PRODUCTION_BOOTSTRAP_TOKEN_FILE_ENV,
  PRODUCTION_BOOTSTRAP_TTL_MS,
} from "./production-bootstrap";

const AUTH_WINDOW_MS = 15 * 60 * 1_000;
const AUTH_ATTEMPT_LEASE_MS = 2 * 60 * 1_000;
const AUTH_GUARD_RETENTION_MS = 30 * 60 * 1_000;
const AUTH_CLEANUP_BATCH = 64;
const LOGIN_IDENTITY_FAILURE_LIMIT = 5;
const LOGIN_GLOBAL_FAILURE_LIMIT = 20;
const BOOTSTRAP_GLOBAL_FAILURE_LIMIT = 5;
export const PRODUCTION_AUTH_ACTIVE_ATTEMPT_LIMIT = 4;
export const PRODUCTION_BOOTSTRAP_ACTIVE_ATTEMPT_LIMIT = 1;
export const PRODUCTION_AUTH_LOGIN_GUARD_LIMIT = 256;
export const PRODUCTION_AUTH_LEASE_ROW_LIMIT = 64;

const CONTROL = /[\u0000-\u001f\u007f]/u;
const WORKSPACE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}$/u;
const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_VERIFIER = deriveProductionVerifier("invalid-production-login", DUMMY_SALT);

type AuthAttemptKind = "LOGIN" | "BOOTSTRAP";

export type ProductionBootstrapStatus = "AVAILABLE" | "UNAVAILABLE" | "EXPIRED" | "CONSUMED" | "INVALIDATED";

export type ProductionAuthErrorCode =
  | "PRODUCTION_AUTH_MODE_REQUIRED"
  | "PRODUCTION_BOOTSTRAP_UNAVAILABLE"
  | "PRODUCTION_BOOTSTRAP_INVALID"
  | "PRODUCTION_BOOTSTRAP_EXPIRED"
  | "PRODUCTION_BOOTSTRAP_REPLAYED"
  | "PRODUCTION_BOOTSTRAP_INPUT_INVALID"
  | "PRODUCTION_BOOTSTRAP_RATE_LIMITED"
  | "PRODUCTION_LOGIN_FAILED"
  | "PRODUCTION_LOGIN_RATE_LIMITED";

export class ProductionAuthError extends Error {
  readonly code: ProductionAuthErrorCode;

  constructor(code: ProductionAuthErrorCode) {
    super(code);
    this.name = "ProductionAuthError";
    this.code = code;
  }
}

export interface ProductionBootstrapInput {
  readonly token: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
}

export interface ProductionLoginInput {
  readonly workspaceSlug: string;
  readonly email: string;
  readonly password: string;
}

interface BootstrapRow {
  readonly kdf: string;
  readonly salt: string | null;
  readonly verifier: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly consumedByAccountId: string | null;
  readonly invalidatedAt: string | null;
}

interface CredentialRow {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly salt: string;
  readonly verifier: string;
}

interface AttemptLease {
  readonly id: string;
  readonly kind: AuthAttemptKind;
  readonly expiresAt: string;
}

interface GlobalGuardRow {
  readonly windowStartedAt: string;
  readonly failedAttempts: number;
  readonly blockedUntil: string | null;
}

function requireProductionMode(): void {
  if (requireRuntimeDataMode() !== "production") {
    throw new ProductionAuthError("PRODUCTION_AUTH_MODE_REQUIRED");
  }
}

function normalizedText(value: unknown, minimum: number, maximumBytes: number): string {
  if (typeof value !== "string") throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_INPUT_INVALID");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (normalized.length < minimum || bytes > maximumBytes || CONTROL.test(normalized)) {
    throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_INPUT_INVALID");
  }
  return normalized;
}

function normalizedSlug(value: unknown, bootstrap: boolean): string {
  if (typeof value !== "string") {
    throw new ProductionAuthError(bootstrap ? "PRODUCTION_BOOTSTRAP_INPUT_INVALID" : "PRODUCTION_LOGIN_FAILED");
  }
  const slug = value.trim().toLowerCase();
  if (!WORKSPACE_SLUG.test(slug)) {
    throw new ProductionAuthError(bootstrap ? "PRODUCTION_BOOTSTRAP_INPUT_INVALID" : "PRODUCTION_LOGIN_FAILED");
  }
  return slug;
}

function normalizedEmail(value: unknown, bootstrap: boolean): string {
  if (typeof value !== "string") {
    throw new ProductionAuthError(bootstrap ? "PRODUCTION_BOOTSTRAP_INPUT_INVALID" : "PRODUCTION_LOGIN_FAILED");
  }
  const email = value.normalize("NFKC").trim().toLowerCase();
  if (!EMAIL.test(email) || Buffer.byteLength(email, "utf8") > 254 || CONTROL.test(email)) {
    throw new ProductionAuthError(bootstrap ? "PRODUCTION_BOOTSTRAP_INPUT_INVALID" : "PRODUCTION_LOGIN_FAILED");
  }
  return email;
}

function validPassword(value: unknown, bootstrap: boolean): string {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 128 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    CONTROL.test(value)
  ) {
    throw new ProductionAuthError(bootstrap ? "PRODUCTION_BOOTSTRAP_INPUT_INVALID" : "PRODUCTION_LOGIN_FAILED");
  }
  return value;
}

function validBootstrapToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 32 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    CONTROL.test(value)
  ) {
    throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_INVALID");
  }
  return value;
}

function bootstrapRow(db: Db): BootstrapRow | null {
  return (db.prepare(
    `SELECT kdf, salt, verifier, issued_at AS issuedAt, expires_at AS expiresAt,
            consumed_at AS consumedAt, consumed_by_account_id AS consumedByAccountId,
            invalidated_at AS invalidatedAt
       FROM production_bootstrap_challenges WHERE id = 1`,
  ).get() as BootstrapRow | undefined) ?? null;
}

function globalGuard(db: Db, kind: AuthAttemptKind): GlobalGuardRow | null {
  return (db.prepare(
    `SELECT window_started_at AS windowStartedAt, failed_attempts AS failedAttempts,
            blocked_until AS blockedUntil
       FROM auth_global_guards WHERE attempt_kind = ?`,
  ).get(kind) as GlobalGuardRow | undefined) ?? null;
}

function loginIdentityHash(workspaceSlug: string, email: string): string {
  return sha256Hex(`production-login/v1\0${workspaceSlug}\0${email}`);
}

function reserveLoginGuardCapacity(db: Db, identityHash: string, at: string): boolean {
  if (db.prepare("SELECT 1 FROM auth_login_guards WHERE identity_hash = ?").get(identityHash)) {
    return true;
  }
  let count = (db.prepare("SELECT COUNT(*) AS count FROM auth_login_guards").get() as { count: number }).count;
  if (count < PRODUCTION_AUTH_LOGIN_GUARD_LIMIT) return true;
  db.prepare(
    `DELETE FROM auth_login_guards WHERE identity_hash = (
       SELECT identity_hash FROM auth_login_guards
       WHERE blocked_until IS NULL OR blocked_until <= ?
       ORDER BY last_failed_at, identity_hash LIMIT 1
     )`,
  ).run(at);
  count = (db.prepare("SELECT COUNT(*) AS count FROM auth_login_guards").get() as { count: number }).count;
  return count < PRODUCTION_AUTH_LOGIN_GUARD_LIMIT;
}

function cleanupAuthAdmissionState(db: Db, at: string): void {
  const retentionCutoff = new Date(Date.parse(at) - AUTH_GUARD_RETENTION_MS).toISOString();
  const windowCutoff = new Date(Date.parse(at) - AUTH_WINDOW_MS).toISOString();
  db.prepare(
    `DELETE FROM auth_attempt_leases WHERE id IN (
       SELECT id FROM auth_attempt_leases WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?
     )`,
  ).run(at, AUTH_CLEANUP_BATCH);
  db.prepare(
    `DELETE FROM auth_login_guards WHERE identity_hash IN (
       SELECT identity_hash FROM auth_login_guards
       WHERE last_failed_at <= ? OR (blocked_until IS NOT NULL AND blocked_until <= ?)
       ORDER BY last_failed_at, identity_hash LIMIT ?
     )`,
  ).run(retentionCutoff, at, AUTH_CLEANUP_BATCH);
  db.prepare(
    `DELETE FROM auth_global_guards
     WHERE window_started_at <= ? OR (blocked_until IS NOT NULL AND blocked_until <= ?)`,
  ).run(windowCutoff, at);
}

function admitAuthAttempt(
  db: Db,
  kind: AuthAttemptKind,
  identityHash: string | null,
): AttemptLease | null {
  const at = nowIso();
  cleanupAuthAdmissionState(db, at);
  const guard = globalGuard(db, kind);
  if (guard?.blockedUntil && guard.blockedUntil > at) return null;
  if (identityHash !== null) {
    const identity = db.prepare(
      "SELECT blocked_until AS blockedUntil FROM auth_login_guards WHERE identity_hash = ?",
    ).get(identityHash) as { readonly blockedUntil: string | null } | undefined;
    if (identity?.blockedUntil && identity.blockedUntil > at) return null;
    if (!identity && !reserveLoginGuardCapacity(db, identityHash, at)) return null;
  }
  const active = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN attempt_kind = 'BOOTSTRAP' THEN 1 ELSE 0 END) AS bootstrap
       FROM auth_attempt_leases WHERE expires_at > ?`,
  ).get(at) as { readonly total: number; readonly bootstrap: number | null };
  const allRows = (db.prepare("SELECT COUNT(*) AS count FROM auth_attempt_leases").get() as { count: number }).count;
  if (
    active.total >= PRODUCTION_AUTH_ACTIVE_ATTEMPT_LIMIT ||
    allRows >= PRODUCTION_AUTH_LEASE_ROW_LIMIT ||
    (kind === "BOOTSTRAP" && (active.bootstrap ?? 0) >= PRODUCTION_BOOTSTRAP_ACTIVE_ATTEMPT_LIMIT)
  ) return null;
  const lease: AttemptLease = {
    id: randomBytes(32).toString("hex"),
    kind,
    expiresAt: new Date(Date.parse(at) + AUTH_ATTEMPT_LEASE_MS).toISOString(),
  };
  db.prepare(
    "INSERT INTO auth_attempt_leases (id, attempt_kind, acquired_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(lease.id, lease.kind, at, lease.expiresAt);
  return lease;
}

function leaseIsCurrent(db: Db, lease: AttemptLease, at: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM auth_attempt_leases
     WHERE id = ? AND attempt_kind = ? AND expires_at = ? AND expires_at > ?`,
  ).get(lease.id, lease.kind, lease.expiresAt, at));
}

function deleteExactLease(db: Db, lease: AttemptLease): void {
  db.prepare(
    "DELETE FROM auth_attempt_leases WHERE id = ? AND attempt_kind = ? AND expires_at = ?",
  ).run(lease.id, lease.kind, lease.expiresAt);
}

function recordGlobalFailure(db: Db, kind: AuthAttemptKind, at: string): void {
  const current = globalGuard(db, kind);
  const limit = kind === "LOGIN" ? LOGIN_GLOBAL_FAILURE_LIMIT : BOOTSTRAP_GLOBAL_FAILURE_LIMIT;
  const failures = Math.min(limit, (current?.failedAttempts ?? 0) + 1);
  const windowStartedAt = current?.windowStartedAt ?? at;
  const blockedUntil = failures >= limit
    ? new Date(Date.parse(at) + AUTH_WINDOW_MS).toISOString()
    : null;
  db.prepare(
    `INSERT INTO auth_global_guards
       (attempt_kind, window_started_at, failed_attempts, blocked_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(attempt_kind) DO UPDATE SET
       window_started_at = excluded.window_started_at,
       failed_attempts = excluded.failed_attempts,
       blocked_until = excluded.blocked_until,
       updated_at = excluded.updated_at`,
  ).run(kind, windowStartedAt, failures, blockedUntil, at);
}

function recordLoginFailure(db: Db, identityHash: string, at: string): boolean {
  if (!reserveLoginGuardCapacity(db, identityHash, at)) return false;
  const current = db.prepare(
    `SELECT failed_attempts AS failedAttempts, blocked_until AS blockedUntil,
            last_failed_at AS lastFailedAt
       FROM auth_login_guards WHERE identity_hash = ?`,
  ).get(identityHash) as {
    readonly failedAttempts: number;
    readonly blockedUntil: string | null;
    readonly lastFailedAt: string;
  } | undefined;
  const stale = !current || current.lastFailedAt <= new Date(Date.parse(at) - AUTH_WINDOW_MS).toISOString()
    || Boolean(current.blockedUntil && current.blockedUntil <= at);
  const failures = stale ? 1 : Math.min(LOGIN_IDENTITY_FAILURE_LIMIT, current.failedAttempts + 1);
  const blockedUntil = failures >= LOGIN_IDENTITY_FAILURE_LIMIT
    ? new Date(Date.parse(at) + AUTH_WINDOW_MS).toISOString()
    : null;
  db.prepare(
    `INSERT INTO auth_login_guards (identity_hash, failed_attempts, blocked_until, last_failed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(identity_hash) DO UPDATE SET
       failed_attempts = excluded.failed_attempts,
       blocked_until = excluded.blocked_until,
       last_failed_at = excluded.last_failed_at`,
  ).run(identityHash, failures, blockedUntil, at);
  recordGlobalFailure(db, "LOGIN", at);
  return true;
}

function currentGlobalBlock(db: Db, kind: AuthAttemptKind, at: string): boolean {
  const guard = globalGuard(db, kind);
  return Boolean(guard?.blockedUntil && guard.blockedUntil > at);
}

export function productionBootstrapStatus(db: Db): ProductionBootstrapStatus {
  requireProductionMode();
  return withTransaction(db, () => {
    const row = bootstrapRow(db);
    if (!row) return "UNAVAILABLE";
    if (row.consumedAt !== null) return "CONSUMED";
    if (row.invalidatedAt !== null) return row.invalidatedAt === row.expiresAt ? "EXPIRED" : "INVALIDATED";
    const at = nowIso();
    if (row.expiresAt <= at) {
      db.prepare(
        `UPDATE production_bootstrap_challenges SET salt = NULL, verifier = NULL, invalidated_at = expires_at
         WHERE id = 1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at <= ?`,
      ).run(at);
      return "EXPIRED";
    }
    return "AVAILABLE";
  });
}

function sameBootstrapSnapshot(left: BootstrapRow, right: BootstrapRow): boolean {
  return left.kdf === right.kdf && left.salt === right.salt && left.verifier === right.verifier
    && left.issuedAt === right.issuedAt && left.expiresAt === right.expiresAt
    && left.consumedAt === right.consumedAt
    && left.consumedByAccountId === right.consumedByAccountId
    && left.invalidatedAt === right.invalidatedAt;
}

export function bootstrapProductionWorkspace(
  db: Db,
  input: ProductionBootstrapInput,
): CreateSessionResult {
  requireProductionMode();
  const token = validBootstrapToken(input?.token);
  const workspaceName = normalizedText(input?.workspaceName, 2, 160);
  const workspaceSlug = normalizedSlug(input?.workspaceSlug, true);
  const displayName = normalizedText(input?.displayName, 2, 160);
  const email = normalizedEmail(input?.email, true);
  const password = validPassword(input?.password, true);

  const claim = withTransaction(db, () => {
    const lease = admitAuthAttempt(db, "BOOTSTRAP", null);
    if (!lease) return { kind: "RATE_LIMITED" as const };
    const row = bootstrapRow(db);
    if (!row) {
      deleteExactLease(db, lease);
      return { kind: "UNAVAILABLE" as const };
    }
    if (row.consumedAt !== null) {
      deleteExactLease(db, lease);
      return { kind: "REPLAYED" as const };
    }
    if (row.invalidatedAt !== null) {
      deleteExactLease(db, lease);
      return { kind: row.invalidatedAt === row.expiresAt ? "EXPIRED" as const : "UNAVAILABLE" as const };
    }
    const at = nowIso();
    if (row.expiresAt <= at) {
      db.prepare(
        `UPDATE production_bootstrap_challenges SET salt = NULL, verifier = NULL, invalidated_at = expires_at
         WHERE id = 1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at <= ?`,
      ).run(at);
      deleteExactLease(db, lease);
      return { kind: "EXPIRED" as const };
    }
    return { kind: "CLAIMED" as const, lease, row };
  });
  if (claim.kind === "RATE_LIMITED") throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_RATE_LIMITED");
  if (claim.kind === "UNAVAILABLE") throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_UNAVAILABLE");
  if (claim.kind === "REPLAYED") throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_REPLAYED");
  if (claim.kind === "EXPIRED") throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_EXPIRED");
  if (claim.kind !== "CLAIMED" || !claim.lease || !claim.row) {
    throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_UNAVAILABLE");
  }
  const bootstrapClaim = { lease: claim.lease, row: claim.row } as const;

  const tokenMatches = Boolean(
    bootstrapClaim.row.salt && bootstrapClaim.row.verifier &&
    productionSecretMatches(token, bootstrapClaim.row.salt, bootstrapClaim.row.verifier),
  );
  const passwordSalt = tokenMatches ? randomBytes(16).toString("hex") : null;
  const passwordVerifier = passwordSalt === null ? null : deriveProductionVerifier(password, passwordSalt);

  const outcome = withTransaction(db, () => {
    const at = nowIso();
    if (!leaseIsCurrent(db, bootstrapClaim.lease, at)) return { kind: "RATE_LIMITED" as const };
    if (currentGlobalBlock(db, "BOOTSTRAP", at)) {
      deleteExactLease(db, bootstrapClaim.lease);
      return { kind: "RATE_LIMITED" as const };
    }
    const current = bootstrapRow(db);
    if (!current || !sameBootstrapSnapshot(current, bootstrapClaim.row)) {
      deleteExactLease(db, bootstrapClaim.lease);
      return { kind: current?.consumedAt ? "REPLAYED" as const : "UNAVAILABLE" as const };
    }
    if (current.expiresAt <= at) {
      db.prepare(
        `UPDATE production_bootstrap_challenges SET salt = NULL, verifier = NULL, invalidated_at = expires_at
         WHERE id = 1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at <= ?`,
      ).run(at);
      deleteExactLease(db, bootstrapClaim.lease);
      return { kind: "EXPIRED" as const };
    }
    if (!tokenMatches || !passwordSalt || !passwordVerifier) {
      recordGlobalFailure(db, "BOOTSTRAP", at);
      deleteExactLease(db, bootstrapClaim.lease);
      return { kind: "INVALID" as const };
    }
    const counts = db.prepare(
      "SELECT (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM accounts) AS accounts",
    ).get() as { readonly workspaces: number; readonly accounts: number };
    if (counts.workspaces !== 0 || counts.accounts !== 0) {
      deleteExactLease(db, bootstrapClaim.lease);
      return { kind: "REPLAYED" as const };
    }

    const workspaceId = uuid();
    const accountId = uuid();
    db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
      .run(workspaceId, workspaceSlug, workspaceName, at);
    db.prepare(
      `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
       VALUES (?, ?, ?, ?, 'organizer', ?)`,
    ).run(accountId, workspaceId, email, displayName, at);
    db.prepare(
      `INSERT INTO account_credentials
         (account_id, workspace_id, kdf, salt, verifier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(accountId, workspaceId, PRODUCTION_AUTH_KDF, passwordSalt, passwordVerifier, at, at);
    const consumed = db.prepare(
      `UPDATE production_bootstrap_challenges
       SET salt = NULL, verifier = NULL, consumed_at = ?, consumed_by_account_id = ?
       WHERE id = 1 AND consumed_at IS NULL AND invalidated_at IS NULL
         AND salt = ? AND verifier = ? AND expires_at = ?`,
    ).run(
      at,
      accountId,
      bootstrapClaim.row.salt,
      bootstrapClaim.row.verifier,
      bootstrapClaim.row.expiresAt,
    );
    if (Number(consumed.changes) !== 1) {
      throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_REPLAYED");
    }
    deleteExactLease(db, bootstrapClaim.lease);
    return { kind: "CREATED" as const, result: createSession(db, accountId, workspaceId) };
  });
  if (outcome.kind === "CREATED") return outcome.result;
  if (outcome.kind === "RATE_LIMITED") throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_RATE_LIMITED");
  if (outcome.kind === "INVALID") throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_INVALID");
  if (outcome.kind === "EXPIRED") throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_EXPIRED");
  if (outcome.kind === "REPLAYED") throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_REPLAYED");
  throw new ProductionAuthError("PRODUCTION_BOOTSTRAP_UNAVAILABLE");
}

function selectCredential(db: Db, workspaceSlug: string, email: string): CredentialRow | null {
  const credentials = db.prepare(
    `SELECT credential.account_id AS accountId, credential.workspace_id AS workspaceId,
            credential.salt, credential.verifier
       FROM workspaces workspace
       JOIN accounts account ON account.workspace_id = workspace.id AND account.email = ?
       JOIN account_credentials credential
         ON credential.account_id = account.id AND credential.workspace_id = account.workspace_id
       WHERE workspace.slug = ?
       LIMIT 2`,
  ).all(email, workspaceSlug) as unknown as CredentialRow[];
  return credentials.length === 1 ? credentials[0]! : null;
}

function sameCredential(left: CredentialRow | null, right: CredentialRow | null): boolean {
  if (!left || !right) return left === right;
  return left.accountId === right.accountId && left.workspaceId === right.workspaceId
    && left.salt === right.salt && left.verifier === right.verifier;
}

export function loginProductionAccount(
  db: Db,
  previousToken: string | undefined,
  input: ProductionLoginInput,
): CreateSessionResult {
  requireProductionMode();
  const workspaceSlug = normalizedSlug(input?.workspaceSlug, false);
  const email = normalizedEmail(input?.email, false);
  const password = validPassword(input?.password, false);
  const identityHash = loginIdentityHash(workspaceSlug, email);
  const claim = withTransaction(db, () => {
    const lease = admitAuthAttempt(db, "LOGIN", identityHash);
    if (!lease) return null;
    return { lease, credential: selectCredential(db, workspaceSlug, email) };
  });
  if (!claim) throw new ProductionAuthError("PRODUCTION_LOGIN_RATE_LIMITED");

  // Known-wrong and syntactically valid unknown identities each perform exactly one scrypt here,
  // after the global admission transaction has released its database write lock.
  const matches = productionSecretMatches(
    password,
    claim.credential?.salt ?? DUMMY_SALT,
    claim.credential?.verifier ?? DUMMY_VERIFIER,
  );
  const outcome = withTransaction(db, () => {
    const at = nowIso();
    if (!leaseIsCurrent(db, claim.lease, at)) return { kind: "RATE_LIMITED" as const };
    if (currentGlobalBlock(db, "LOGIN", at)) {
      deleteExactLease(db, claim.lease);
      return { kind: "RATE_LIMITED" as const };
    }
    const current = selectCredential(db, workspaceSlug, email);
    if (!matches || !claim.credential || !sameCredential(current, claim.credential)) {
      if (!recordLoginFailure(db, identityHash, at)) {
        deleteExactLease(db, claim.lease);
        return { kind: "RATE_LIMITED" as const };
      }
      deleteExactLease(db, claim.lease);
      return { kind: "FAILED" as const };
    }
    db.prepare("DELETE FROM auth_login_guards WHERE identity_hash = ?").run(identityHash);
    revokeSession(db, previousToken);
    const result = createSession(db, current!.accountId, current!.workspaceId);
    deleteExactLease(db, claim.lease);
    return { kind: "VERIFIED" as const, result };
  });
  if (outcome.kind === "RATE_LIMITED") throw new ProductionAuthError("PRODUCTION_LOGIN_RATE_LIMITED");
  if (outcome.kind === "FAILED") throw new ProductionAuthError("PRODUCTION_LOGIN_FAILED");
  return outcome.result;
}
