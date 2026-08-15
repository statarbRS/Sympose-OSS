import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, resolve } from "node:path";

import { nowIso } from "./canonical";

export const PRODUCTION_BOOTSTRAP_TOKEN_ENV = "SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN" as const;
export const PRODUCTION_BOOTSTRAP_TOKEN_FILE_ENV = "SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN_FILE" as const;
export const PRODUCTION_BOOTSTRAP_ISSUED_AT_ENV = "SYMPOSE_PRODUCTION_BOOTSTRAP_ISSUED_AT" as const;
export const PRODUCTION_BOOTSTRAP_TTL_MS = 30 * 60 * 1_000;
export const PRODUCTION_AUTH_KDF = "scrypt-v1" as const;
export const PRODUCTION_AUTH_SCRYPT_OPTIONS = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});

const CONTROL = /[\u0000-\u001f\u007f]/u;

export function deriveProductionVerifier(secret: string, saltHex: string): string {
  return scryptSync(
    secret,
    Buffer.from(saltHex, "hex"),
    64,
    PRODUCTION_AUTH_SCRYPT_OPTIONS,
  ).toString("hex");
}

export function productionSecretMatches(secret: string, saltHex: string, verifierHex: string): boolean {
  let actual: Buffer | null = null;
  let expected: Buffer | null = null;
  try {
    actual = Buffer.from(deriveProductionVerifier(secret, saltHex), "hex");
    expected = Buffer.from(verifierHex, "hex");
    return actual.length === expected.length && actual.length === 64 && timingSafeEqual(actual, expected);
  } catch {
    return false;
  } finally {
    actual?.fill(0);
    expected?.fill(0);
  }
}

function validConfiguredToken(token: string): string {
  const bytes = Buffer.byteLength(token, "utf8");
  if (bytes < 32 || bytes > 512 || CONTROL.test(token)) {
    throw new Error("PRODUCTION_BOOTSTRAP_CONFIGURATION_INVALID");
  }
  return token;
}

function bootstrapTokenFromFile(path: string): string {
  try {
    if (!isAbsolute(path) || resolve(path) !== path || CONTROL.test(path)) {
      throw new Error("invalid");
    }
    const file = lstatSync(path);
    const parentPath = dirname(path);
    const parent = statSync(parentPath);
    const uid = process.getuid?.();
    if (
      file.isSymbolicLink() || !file.isFile() || file.size < 32 || file.size > 513 ||
      realpathSync(path) !== path || realpathSync(parentPath) !== parentPath ||
      uid === undefined || file.uid !== uid || parent.uid !== uid ||
      (file.mode & 0o077) !== 0 || (parent.mode & 0o022) !== 0
    ) {
      throw new Error("invalid");
    }
    const raw = readFileSync(path, "utf8");
    const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (token.includes("\n") || token.includes("\r")) throw new Error("invalid");
    return validConfiguredToken(token);
  } catch {
    throw new Error("PRODUCTION_BOOTSTRAP_CONFIGURATION_INVALID");
  }
}

function configuredBootstrapToken(): string | null {
  const literal = process.env[PRODUCTION_BOOTSTRAP_TOKEN_ENV];
  const file = process.env[PRODUCTION_BOOTSTRAP_TOKEN_FILE_ENV];
  if (literal && file) throw new Error("PRODUCTION_BOOTSTRAP_CONFIGURATION_INVALID");
  if (file) return bootstrapTokenFromFile(file);
  if (!literal) return null;
  return validConfiguredToken(literal);
}

function configuredIssuedAt(): string {
  const value = process.env[PRODUCTION_BOOTSTRAP_ISSUED_AT_ENV]?.trim();
  let canonical = "";
  try {
    canonical = value ? new Date(value).toISOString() : "";
  } catch {
    canonical = "";
  }
  if (!value || canonical !== value) {
    throw new Error("PRODUCTION_BOOTSTRAP_CONFIGURATION_INVALID");
  }
  if (Date.parse(value) > Date.now() + 5 * 60 * 1_000) {
    throw new Error("PRODUCTION_BOOTSTRAP_CONFIGURATION_INVALID");
  }
  return value;
}

export type PreparedProductionBootstrapChallenge = Readonly<{
  issuedAt: string;
  expiresAt: string;
  salt: string | null;
  verifier: string | null;
}>;

/**
 * Reads deployment configuration and performs scrypt before the database write lock is acquired.
 * The installer rechecks the empty-state predicate inside its short transaction.
 */
export function prepareProductionBootstrapChallenge(
  db: DatabaseSync,
): PreparedProductionBootstrapChallenge | null {
  const existing = db.prepare(
    "SELECT 1 FROM production_bootstrap_challenges WHERE id = 1",
  ).get();
  if (existing) return null;
  const counts = db.prepare(
    "SELECT (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM accounts) AS accounts",
  ).get() as { readonly workspaces: number; readonly accounts: number };
  if (counts.workspaces !== 0 || counts.accounts !== 0) return null;
  const token = configuredBootstrapToken();
  if (!token) return null;
  const issuedAt = configuredIssuedAt();
  const expiresAt = new Date(Date.parse(issuedAt) + PRODUCTION_BOOTSTRAP_TTL_MS).toISOString();
  if (expiresAt <= nowIso()) {
    return Object.freeze({ issuedAt, expiresAt, salt: null, verifier: null });
  }
  const salt = randomBytes(16).toString("hex");
  const verifier = deriveProductionVerifier(token, salt);
  return Object.freeze({ issuedAt, expiresAt, salt, verifier });
}

/** Existing state is never reissued; concurrent preparers converge under the caller's lock. */
export function installProductionBootstrapChallenge(
  db: DatabaseSync,
  prepared: PreparedProductionBootstrapChallenge | null,
): void {
  const existing = db.prepare(
    `SELECT expires_at AS expiresAt, consumed_at AS consumedAt, invalidated_at AS invalidatedAt
     FROM production_bootstrap_challenges WHERE id = 1`,
  ).get() as { readonly expiresAt: string; readonly consumedAt: string | null; readonly invalidatedAt: string | null } | undefined;
  if (existing) {
    if (existing.consumedAt === null && existing.invalidatedAt === null && existing.expiresAt <= nowIso()) {
      db.prepare(
        `UPDATE production_bootstrap_challenges
         SET salt = NULL, verifier = NULL, invalidated_at = ?
         WHERE id = 1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at <= ?`,
      ).run(existing.expiresAt, nowIso());
    }
    return;
  }
  if (!prepared) return;
  const counts = db.prepare(
    "SELECT (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM accounts) AS accounts",
  ).get() as { readonly workspaces: number; readonly accounts: number };
  if (counts.workspaces !== 0 || counts.accounts !== 0) return;
  if (prepared.salt === null || prepared.verifier === null) {
    db.prepare(
      `INSERT INTO production_bootstrap_challenges
         (id, kdf, salt, verifier, issued_at, expires_at, invalidated_at)
       VALUES (1, ?, NULL, NULL, ?, ?, ?)`,
    ).run(PRODUCTION_AUTH_KDF, prepared.issuedAt, prepared.expiresAt, prepared.expiresAt);
    return;
  }
  db.prepare(
    `INSERT INTO production_bootstrap_challenges
       (id, kdf, salt, verifier, issued_at, expires_at)
     VALUES (1, ?, ?, ?, ?, ?)`,
  ).run(PRODUCTION_AUTH_KDF, prepared.salt, prepared.verifier, prepared.issuedAt, prepared.expiresAt);
}
