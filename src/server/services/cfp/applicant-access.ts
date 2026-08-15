import { timingSafeEqual } from "node:crypto";
import type { Db } from "../../db";
import type { SessionInfo } from "../../auth";
import { DenialError, roleHasCapability } from "../../auth";
import { nowIso, uuid } from "../../canonical";
import type { ApplicantSessionContext, CallReadModel } from "./form-documents";
import { readCall } from "./form-documents";
import type { AuditInput } from "../audit";
import { writeAudit, writeDenialAudit } from "../audit";

export type CfpApplicantAction =
  | "REQUEST_VERIFICATION"
  | "CONSUME_VERIFICATION"
  | "CREATE_DRAFT"
  | "SAVE_DRAFT"
  | "SUBMIT";

export interface VerificationIssuanceContext {
  readonly workspaceId: string;
}

export interface IssueEmailVerificationInput {
  readonly callId: string;
  readonly email: string;
  readonly tokenHash: string;
}

export interface IssuedEmailVerification {
  readonly verificationId: string;
  readonly workspaceId: string;
  readonly callId: string;
  readonly expiresAt: string;
  readonly replayed: boolean;
}

export interface ConsumeEmailVerificationInput {
  readonly callId: string;
  readonly verificationId: string;
  readonly verificationTokenHash: string;
  readonly applicantSessionTokenHash: string;
  readonly fullName: string;
}

export interface ConsumedApplicantSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly callId: string;
  readonly personId: string;
  readonly expiresAt: string;
  readonly replayed: boolean;
}

export interface ResolveApplicantSessionInput {
  readonly workspaceId: string;
  readonly callId: string;
  readonly sessionTokenHash: string;
}

export interface ResolvedApplicantSession {
  readonly context: ApplicantSessionContext;
  readonly personId: string;
  readonly callId: string;
  readonly expiresAt: string;
}

export interface TransitionCallStateInput {
  readonly callId: string;
  readonly expectedState: CallReadModel["state"];
  readonly expectedUpdatedAt: string;
  readonly nextState: CallReadModel["state"];
}

export interface CallLifecycleSnapshot {
  readonly state: CallReadModel["state"];
  readonly updatedAt: string;
}

export interface ApplicantAccessGrant {
  readonly allowed: true;
  readonly late: boolean;
  readonly extensionId: string | null;
}

export interface GrantCallExtensionInput {
  readonly callId: string;
  readonly personId: string;
  readonly extendsTo: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface RevokeApplicantSessionInput {
  readonly callId: string;
  readonly sessionId: string;
  readonly reason: string;
}

export interface AssertApplicantAccessInput {
  readonly action: Exclude<
    CfpApplicantAction,
    "REQUEST_VERIFICATION" | "CONSUME_VERIFICATION"
  >;
  readonly context: ApplicantSessionContext;
}

export type CfpApplicantAccessErrorCode =
  | "ACCESS_INPUT_INVALID"
  | "CALL_NOT_AVAILABLE"
  | "CALL_NOT_ACCEPTING"
  | "VERIFICATION_REQUEST_REJECTED"
  | "VERIFICATION_INVALID"
  | "SESSION_INVALID"
  | "CALL_STATE_INVALID"
  | "CALL_STATE_STALE"
  | "EXTENSION_INVALID"
  | "EXTENSION_IDEMPOTENCY_CONFLICT"
  | "SESSION_REVOKE_CONFLICT"
  | "ACCESS_READ_FAILED"
  | "ACCESS_WRITE_FAILED";

function getPublicErrorMessage(code: CfpApplicantAccessErrorCode): string {
  switch (code) {
    case "ACCESS_INPUT_INVALID":
      return "The input provided is invalid.";
    case "CALL_NOT_AVAILABLE":
      return "The requested call is not available.";
    case "CALL_NOT_ACCEPTING":
      return "The call is not accepting submissions.";
    case "VERIFICATION_REQUEST_REJECTED":
      return "The verification request was rejected.";
    case "VERIFICATION_INVALID":
      return "The verification is invalid or expired.";
    case "SESSION_INVALID":
      return "The session is invalid, expired, or revoked.";
    case "CALL_STATE_INVALID":
      return "The requested call state transition is invalid.";
    case "CALL_STATE_STALE":
      return "The call state is stale.";
    case "EXTENSION_INVALID":
      return "The extension request is invalid.";
    case "EXTENSION_IDEMPOTENCY_CONFLICT":
      return "The extension request conflicts with a previous request.";
    case "SESSION_REVOKE_CONFLICT":
      return "The session revocation request conflicts with a previous request.";
    case "ACCESS_READ_FAILED":
      return "An error occurred while reading access state.";
    case "ACCESS_WRITE_FAILED":
      return "An error occurred while writing access state.";
  }
}

export class CfpApplicantAccessError extends Error {
  readonly code: CfpApplicantAccessErrorCode;

  constructor(code: CfpApplicantAccessErrorCode, message?: string) {
    super(message ?? getPublicErrorMessage(code));
    this.name = "CfpApplicantAccessError";
    this.code = code;
  }
}

const APPLICANT_ACCESS_FATAL_MESSAGE =
  "The CFP applicant access boundary could not prove transaction state; stop using this database connection.";

export class CfpApplicantAccessFatalError extends Error {
  readonly fatal = true;

  constructor() {
    super(APPLICANT_ACCESS_FATAL_MESSAGE);
    this.name = "CfpApplicantAccessFatalError";
    Object.setPrototypeOf(this, new.target.prototype);
    Object.freeze(this);
  }
}

class OrganizerAuthorityChangedError extends Error {
  readonly databaseRole: string | null;
  readonly auditWorkspaceId: string | null;

  constructor(databaseRole: string | null, auditWorkspaceId: string | null) {
    super("Organizer authority changed before mutation.");
    this.name = "OrganizerAuthorityChangedError";
    this.databaseRole = databaseRole;
    this.auditWorkspaceId = auditWorkspaceId;
  }
}

class OrganizerTargetScopeChangedError extends Error {
  constructor() {
    super("Organizer target scope changed before mutation.");
    this.name = "OrganizerTargetScopeChangedError";
  }
}

type OrganizerTargetReadProbe = {
  readonly db: Db;
  readonly faulted: () => boolean;
};

function createOrganizerTargetReadProbe(db: Db): OrganizerTargetReadProbe {
  let driverFaulted = false;
  const probedDb = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          let statement: ReturnType<Db["prepare"]>;
          try {
            statement = target.prepare(sql);
          } catch (error) {
            driverFaulted = true;
            throw error;
          }
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              let value: unknown;
              try {
                value = Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementTarget,
                ) as unknown;
              } catch (error) {
                driverFaulted = true;
                throw error;
              }
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                try {
                  return Reflect.apply(value, statementTarget, args);
                } catch (error) {
                  driverFaulted = true;
                  throw error;
                }
              };
            },
          });
        };
      }
      if (property === "exec") {
        return (sql: string): void => {
          try {
            target.exec(sql);
          } catch (error) {
            driverFaulted = true;
            throw error;
          }
        };
      }

      let value: unknown;
      try {
        value = Reflect.get(target, property, target) as unknown;
      } catch (error) {
        driverFaulted = true;
        throw error;
      }
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          return Reflect.apply(value, target, args);
        } catch (error) {
          driverFaulted = true;
          throw error;
        }
      };
    },
  }) as Db;
  return { db: probedDb, faulted: () => driverFaulted };
}

class OwnedTransactionCleanupError extends Error {
  constructor() {
    super("The owned transaction boundary could not be cleaned up.");
    this.name = "OwnedTransactionCleanupError";
  }
}

const OWNED_CLEANUP_ATTEMPTS = 3;

function readApplicantAccessTransactionState(db: Db): boolean {
  try {
    const state = db.isTransaction as unknown;
    if (typeof state !== "boolean") {
      throw new CfpApplicantAccessFatalError();
    }
    return state;
  } catch {
    throw new CfpApplicantAccessFatalError();
  }
}

function validateOwnedSavepointName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) {
    throw new OwnedTransactionCleanupError();
  }
}

function createOwnedSavepointName(baseName: string): string {
  validateOwnedSavepointName(baseName);
  const suffix = uuid().replaceAll("-", "");
  const ownedName = `${baseName}_${suffix}`;
  validateOwnedSavepointName(ownedName);
  return ownedName;
}

function isMissingOwnedSavepointError(error: unknown, name: string): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { readonly code?: unknown };
  return (
    sqliteError.code === "ERR_SQLITE_ERROR" &&
    sqliteError.message === `no such savepoint: ${name}`
  );
}

function rollbackOwnedTopLevel(db: Db): boolean {
  let cleanupFaulted = false;
  for (let attempt = 0; attempt < OWNED_CLEANUP_ATTEMPTS; attempt += 1) {
    if (!readApplicantAccessTransactionState(db)) return cleanupFaulted;
    try {
      db.exec("ROLLBACK");
    } catch {
      cleanupFaulted = true;
      // A connection/proxy boundary can fail before SQLite receives the first
      // cleanup statement. Retry the exact owned rollback, then verify using
      // the driver's transaction state rather than trusting the return alone.
    }
  }
  if (readApplicantAccessTransactionState(db)) {
    throw new OwnedTransactionCleanupError();
  }
  return cleanupFaulted;
}

function rollbackAndReleaseOwnedSavepoint(
  db: Db,
  name: string,
  expectOuterTransaction: boolean,
  allowMissing = false,
): { readonly cleanupFaulted: boolean; readonly status: "cleaned" | "missing" } {
  validateOwnedSavepointName(name);
  const rollbackSql = `ROLLBACK TO SAVEPOINT "${name}"`;
  const releaseSql = `RELEASE SAVEPOINT "${name}"`;
  let cleanupFaulted = false;

  if (!readApplicantAccessTransactionState(db)) {
    if (!expectOuterTransaction && allowMissing) {
      return { cleanupFaulted: false, status: "missing" };
    }
    throw new OwnedTransactionCleanupError();
  }

  let rolledBack = false;
  for (let attempt = 0; attempt < OWNED_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      db.exec(rollbackSql);
      rolledBack = true;
      break;
    } catch (error) {
      if (allowMissing && isMissingOwnedSavepointError(error, name)) {
        return { cleanupFaulted, status: "missing" };
      }
      cleanupFaulted = true;
      // Retry only this service's savepoint. The caller-owned transaction is
      // deliberately never a cleanup target.
    }
  }
  if (!rolledBack) {
    throw new OwnedTransactionCleanupError();
  }

  for (let attempt = 0; attempt < OWNED_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      db.exec(releaseSql);
      if (readApplicantAccessTransactionState(db) !== expectOuterTransaction) {
        throw new OwnedTransactionCleanupError();
      }
      return { cleanupFaulted, status: "cleaned" };
    } catch (error) {
      if (error instanceof CfpApplicantAccessFatalError) throw error;
      cleanupFaulted = true;
      if (
        isMissingOwnedSavepointError(error, name) &&
        readApplicantAccessTransactionState(db) === expectOuterTransaction
      ) {
        // A delegate-then-throw boundary can report an error after SQLite has
        // already released the savepoint. The retry proves that no owned
        // mutation remains committable behind that boundary.
        return { cleanupFaulted, status: "cleaned" };
      }
      // A one-shot RELEASE boundary fault must not leave the rolled-back
      // savepoint on the caller's stack.
    }
  }
  throw new OwnedTransactionCleanupError();
}

function withOwnedTransactionOrSavepoint<T>(
  db: Db,
  name: string,
  fn: () => T,
): T {
  validateOwnedSavepointName(name);
  if (!readApplicantAccessTransactionState(db)) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (readApplicantAccessTransactionState(db) && rollbackOwnedTopLevel(db)) {
        throw new OwnedTransactionCleanupError();
      }
      throw error;
    }
    let result: T;
    try {
      result = fn();
    } catch (error) {
      if (rollbackOwnedTopLevel(db)) {
        throw new OwnedTransactionCleanupError();
      }
      throw error;
    }

    try {
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (!readApplicantAccessTransactionState(db)) {
        // A throwing COMMIT that ended the transaction is indeterminate at
        // this API boundary: SQLite may have committed before a wrapper threw,
        // but the caller must never receive an in-memory success that it cannot
        // prove. Retire the connection and recover through durable replay.
        throw new CfpApplicantAccessFatalError();
      }
      // A real SQLite COMMIT failure leaves the transaction active. Preserve
      // the stable boundary-failure mapping, and clean the owned transaction
      // whenever the driver still reports it as committable.
      if (rollbackOwnedTopLevel(db)) {
        throw new OwnedTransactionCleanupError();
      }
      throw error;
    }
  }

  // SQLite resolves duplicate savepoint names to the most recent matching
  // boundary. A per-invocation name is therefore part of ownership: recovery
  // can never fall through to a caller savepoint that used the public seam's
  // stable base name (or another concurrent composition's name).
  const ownedName = createOwnedSavepointName(name);
  const savepointSql = `SAVEPOINT "${ownedName}"`;
  const releaseSql = `RELEASE SAVEPOINT "${ownedName}"`;
  try {
    db.exec(savepointSql);
  } catch (error) {
    const cleanup = rollbackAndReleaseOwnedSavepoint(
      db,
      ownedName,
      true,
      true,
    );
    if (cleanup.cleanupFaulted) throw new OwnedTransactionCleanupError();
    throw error;
  }
  let result: T;
  try {
    result = fn();
  } catch (error) {
    if (
      rollbackAndReleaseOwnedSavepoint(db, ownedName, true).cleanupFaulted
    ) {
      throw new OwnedTransactionCleanupError();
    }
    throw error;
  }

  try {
    db.exec(releaseSql);
    return result;
  } catch (error) {
    const cleanup = rollbackAndReleaseOwnedSavepoint(
      db,
      ownedName,
      true,
      true,
    );
    if (cleanup.status === "missing") return result;
    if (cleanup.cleanupFaulted) throw new OwnedTransactionCleanupError();
    throw error;
  }
}

function withCoherentReadSnapshot<T>(db: Db, name: string, fn: () => T): T {
  validateOwnedSavepointName(name);
  if (readApplicantAccessTransactionState(db)) return fn();

  const ownedName = createOwnedSavepointName(name);
  try {
    db.exec(`SAVEPOINT "${ownedName}"`);
  } catch (error) {
    if (readApplicantAccessTransactionState(db)) {
      const cleanup = rollbackAndReleaseOwnedSavepoint(
        db,
        ownedName,
        false,
        true,
      );
      if (cleanup.cleanupFaulted) throw new OwnedTransactionCleanupError();
    }
    throw error;
  }
  let result: T;
  try {
    result = fn();
  } catch (error) {
    if (
      rollbackAndReleaseOwnedSavepoint(db, ownedName, false).cleanupFaulted
    ) {
      throw new OwnedTransactionCleanupError();
    }
    throw error;
  }

  try {
    db.exec(`RELEASE SAVEPOINT "${ownedName}"`);
    return result;
  } catch (error) {
    if (!readApplicantAccessTransactionState(db)) return result;
    const cleanup = rollbackAndReleaseOwnedSavepoint(
      db,
      ownedName,
      false,
      true,
    );
    if (cleanup.status === "missing") return result;
    if (cleanup.cleanupFaulted) throw new OwnedTransactionCleanupError();
    throw error;
  }
}

function withMappedWriteTransaction<T>(db: Db, name: string, fn: () => T): T {
  try {
    return withOwnedTransactionOrSavepoint(db, name, fn);
  } catch (error) {
    if (
      error instanceof CfpApplicantAccessError ||
      error instanceof CfpApplicantAccessFatalError ||
      error instanceof OrganizerAuthorityChangedError ||
      error instanceof OrganizerTargetScopeChangedError
    ) {
      throw error;
    }
    throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
  }
}

export interface CfpApplicantAccessOptions {
  readonly now?: () => string;
  readonly id?: () => string;
  readonly verificationTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly auditWriter?: (db: Db, workspaceId: string, input: AuditInput) => void;
}

export interface CfpApplicantAccess {
  readCallLifecycle(db: Db, workspaceId: string, callId: string): CallLifecycleSnapshot;
  transitionCallState(
    db: Db,
    session: SessionInfo,
    input: TransitionCallStateInput,
  ): CallLifecycleSnapshot;
  grantCallExtension(
    db: Db,
    session: SessionInfo,
    input: GrantCallExtensionInput,
  ): {
    readonly extensionId: string;
    readonly workspaceId: string;
    readonly callId: string;
    readonly personId: string;
    readonly extendsTo: string;
    readonly replayed: boolean;
  };
  issueEmailVerification(
    db: Db,
    context: VerificationIssuanceContext,
    input: IssueEmailVerificationInput,
  ): IssuedEmailVerification;
  consumeEmailVerification(
    db: Db,
    context: VerificationIssuanceContext,
    input: ConsumeEmailVerificationInput,
  ): ConsumedApplicantSession;
  resolveApplicantSession(
    db: Db,
    input: ResolveApplicantSessionInput,
  ): ResolvedApplicantSession;
  revokeApplicantSession(
    db: Db,
    session: SessionInfo,
    input: RevokeApplicantSessionInput,
  ): {
    readonly sessionId: string;
    readonly revokedAt: string;
    readonly replayed: boolean;
  };
  assertApplicantAccess(
    db: Db,
    input: AssertApplicantAccessInput,
  ): ApplicantAccessGrant;
}

const DEFAULT_VERIFICATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function validateId(
  value: unknown,
  errorCode: CfpApplicantAccessErrorCode = "ACCESS_INPUT_INVALID",
): string {
  if (
    typeof value !== "string" ||
    hasUnpairedSurrogate(value) ||
    value.length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001F\u007F-\u009F]/.test(value)
  ) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return value;
}

function validateDigest(
  value: unknown,
  errorCode: CfpApplicantAccessErrorCode = "ACCESS_INPUT_INVALID",
): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return value;
}

function validateObject(
  value: unknown,
  errorCode: CfpApplicantAccessErrorCode,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CfpApplicantAccessError(errorCode);
  }
}

function snapshotProperties<const K extends string>(
  value: unknown,
  keys: readonly K[],
  errorCode: CfpApplicantAccessErrorCode,
): Readonly<Record<K, unknown>> {
  try {
    validateObject(value, errorCode);
    const snapshot = {} as Record<K, unknown>;
    for (const key of keys) {
      snapshot[key] = Reflect.get(value, key);
    }
    return Object.freeze(snapshot);
  } catch {
    // Property access is an untrusted boundary. In particular, a caller can
    // throw this module's exported error type from a getter and otherwise
    // choose both its public code and message. Never preserve an exception
    // raised while classifying or dereferencing the caller object.
    throw new CfpApplicantAccessError(errorCode);
  }
}

type OrganizerSessionSnapshot = Readonly<
  Pick<SessionInfo, "accountId" | "workspaceId">
>;

function snapshotOrganizerSession(
  value: unknown,
  errorCode: CfpApplicantAccessErrorCode = "CALL_NOT_AVAILABLE",
): OrganizerSessionSnapshot {
  const snapshot = snapshotProperties(
    value,
    ["accountId", "workspaceId"] as const,
    errorCode,
  );
  return Object.freeze({
    accountId: validateId(snapshot.accountId, errorCode),
    workspaceId: validateId(snapshot.workspaceId, errorCode),
  });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateEmail(
  value: unknown,
  errorCode: CfpApplicantAccessErrorCode = "ACCESS_INPUT_INVALID",
): string {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    throw new CfpApplicantAccessError(errorCode);
  }
  const trimmed = value.trim().toLowerCase().normalize("NFC");
  if (
    trimmed.length === 0 ||
    trimmed.includes("\uFFFD") ||
    /[\s\u0000-\u001F\u007F-\u009F]/.test(trimmed) ||
    Buffer.byteLength(trimmed, "utf-8") > 320
  ) {
    throw new CfpApplicantAccessError(errorCode);
  }
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1 || trimmed.indexOf("@", atIndex + 1) !== -1) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return trimmed;
}

function validateStoredEmail(
  value: unknown,
  errorCode: CfpApplicantAccessErrorCode,
): string {
  const normalized = validateEmail(value, errorCode);
  if (normalized !== value) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return normalized;
}

function matchesCanonicalEmailCandidate(
  value: unknown,
  normalizedEmail: string,
  errorCode: CfpApplicantAccessErrorCode,
): boolean {
  if (typeof value === "string") {
    try {
      return validateEmail(value, errorCode) === normalizedEmail;
    } catch {
      return false;
    }
  }

  if (value instanceof Uint8Array) {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return false;
    }

    let decodedEmail: string;
    try {
      decodedEmail = validateEmail(decoded, errorCode);
    } catch {
      return false;
    }
    if (decodedEmail === normalizedEmail) {
      throw new CfpApplicantAccessError(errorCode);
    }
  }

  return false;
}

function validateText(
  value: unknown,
  maxBytes: number,
  errorCode: CfpApplicantAccessErrorCode = "ACCESS_INPUT_INVALID",
): string {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    throw new CfpApplicantAccessError(errorCode);
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    /[\u0000-\u001F\u007F-\u009F]/.test(trimmed) ||
    Buffer.byteLength(trimmed, "utf-8") > maxBytes
  ) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return trimmed;
}

function validateStoredText(
  value: unknown,
  maxBytes: number,
  errorCode: CfpApplicantAccessErrorCode,
): string {
  const normalized = validateText(value, maxBytes, errorCode);
  if (normalized !== value) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return normalized;
}

function validateIsoInstant(
  value: unknown,
  errorCode: CfpApplicantAccessErrorCode = "ACCESS_INPUT_INVALID",
): string {
  if (typeof value !== "string") {
    throw new CfpApplicantAccessError(errorCode);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new CfpApplicantAccessError(errorCode);
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new CfpApplicantAccessError(errorCode);
  }
  if (new Date(value).toISOString() !== value) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return value;
}

function addMilliseconds(
  instant: string,
  durationMs: number,
  errorCode: CfpApplicantAccessErrorCode = "ACCESS_INPUT_INVALID",
): string {
  try {
    const epoch = Date.parse(validateIsoInstant(instant, errorCode));
    const nextEpoch = epoch + durationMs;
    if (!Number.isFinite(nextEpoch)) {
      throw new CfpApplicantAccessError(errorCode);
    }
    return validateIsoInstant(new Date(nextEpoch).toISOString(), errorCode);
  } catch {
    throw new CfpApplicantAccessError(errorCode);
  }
}

const VALID_CALL_STATES = new Set([
  "DRAFT",
  "SCHEDULED",
  "OPEN",
  "PAUSED",
  "CLOSED",
  "ARCHIVED",
  "CANCELLED",
]);

function validateCallState(
  state: unknown,
  errorCode: CfpApplicantAccessErrorCode = "ACCESS_INPUT_INVALID",
): CallReadModel["state"] {
  if (typeof state !== "string" || !VALID_CALL_STATES.has(state)) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return state as CallReadModel["state"];
}

const VALID_ACCESS_MODES = new Set(["PUBLIC", "INVITED", "PUBLIC_AND_INVITED"]);

const VALID_ACCOUNT_ROLES = new Set([
  "organizer",
  "workspace_admin",
  "event_manager",
  "program_manager",
  "communications_manager",
  "reviewer",
  "read_only",
]);

function validateAccessMode(
  mode: unknown,
  errorCode: CfpApplicantAccessErrorCode = "ACCESS_INPUT_INVALID",
): "PUBLIC" | "INVITED" | "PUBLIC_AND_INVITED" {
  if (typeof mode !== "string" || !VALID_ACCESS_MODES.has(mode)) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return mode as "PUBLIC" | "INVITED" | "PUBLIC_AND_INVITED";
}

function constantTimeCompare(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "utf-8");
  const bBytes = Buffer.from(b, "utf-8");
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return timingSafeEqual(aBytes, bBytes);
}

type WorkspaceIdentityRow = {
  readonly id: unknown;
  readonly created_at: unknown;
  readonly id_storage: unknown;
};

function readWorkspaceIdentityRows(
  db: Db,
  workspaceId: string,
): WorkspaceIdentityRow[] {
  return db
    .prepare(
      `SELECT id, created_at, typeof(id) AS id_storage
       FROM workspaces
       WHERE id = ? OR id = CAST(? AS BLOB)`,
    )
    .all(workspaceId, workspaceId) as unknown as WorkspaceIdentityRow[];
}

function validateCanonicalWorkspaceRoot(
  db: Db,
  workspaceId: string,
  errorCode: CfpApplicantAccessErrorCode,
  candidateRows?: readonly WorkspaceIdentityRow[],
): string {
  try {
    validateId(workspaceId, errorCode);
    const rows = candidateRows ?? readWorkspaceIdentityRows(db, workspaceId);
    if (rows.length !== 1) {
      throw new CfpApplicantAccessError(errorCode);
    }
    const row = rows[0]!;
    const storedId = validateId(row.id, errorCode);
    validateIsoInstant(row.created_at, errorCode);
    if (row.id_storage !== "text" || storedId !== workspaceId) {
      throw new CfpApplicantAccessError(errorCode);
    }
    return storedId;
  } catch {
    throw new CfpApplicantAccessError(errorCode);
  }
}

type GeneratedIdentityTable =
  | "call_extensions"
  | "cfp_email_verifications"
  | "people"
  | "cfp_email_verification_consumptions"
  | "cfp_applicant_sessions";

const GENERATED_ID_LOOKUPS: Readonly<Record<GeneratedIdentityTable, string>> =
  Object.freeze({
    call_extensions:
      "SELECT id, typeof(id) AS id_storage FROM call_extensions WHERE id = ? OR id = CAST(? AS BLOB)",
    cfp_email_verifications:
      "SELECT id, typeof(id) AS id_storage FROM cfp_email_verifications WHERE id = ? OR id = CAST(? AS BLOB)",
    people:
      "SELECT id, typeof(id) AS id_storage FROM people WHERE id = ? OR id = CAST(? AS BLOB)",
    cfp_email_verification_consumptions:
      "SELECT id, typeof(id) AS id_storage FROM cfp_email_verification_consumptions WHERE id = ? OR id = CAST(? AS BLOB)",
    cfp_applicant_sessions:
      "SELECT id, typeof(id) AS id_storage FROM cfp_applicant_sessions WHERE id = ? OR id = CAST(? AS BLOB)",
  });

function loadGeneratedIdentityRows(
  db: Db,
  table: GeneratedIdentityTable,
  id: string,
): Array<{ readonly id: unknown; readonly id_storage: unknown }> {
  return db.prepare(GENERATED_ID_LOOKUPS[table]).all(id, id) as unknown as Array<{
    readonly id: unknown;
    readonly id_storage: unknown;
  }>;
}

function validateCanonicalIdentityRoot(
  db: Db,
  table: GeneratedIdentityTable,
  id: string,
  errorCode: CfpApplicantAccessErrorCode,
): string {
  try {
    validateId(id, errorCode);
    const rows = loadGeneratedIdentityRows(db, table, id);
    if (
      rows.length !== 1 ||
      rows[0]!.id_storage !== "text" ||
      validateId(rows[0]!.id, errorCode) !== id
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
    return id;
  } catch {
    throw new CfpApplicantAccessError(errorCode);
  }
}

function assertGeneratedIdentityAvailable(
  db: Db,
  table: GeneratedIdentityTable,
  id: string,
): void {
  try {
    validateId(id, "ACCESS_WRITE_FAILED");
    if (loadGeneratedIdentityRows(db, table, id).length !== 0) {
      throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
    }
  } catch {
    throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
  }
}

function assertGeneratedIdentityPersisted(
  db: Db,
  table: GeneratedIdentityTable,
  id: string,
): void {
  try {
    validateCanonicalIdentityRoot(db, table, id, "ACCESS_WRITE_FAILED");
  } catch {
    throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
  }
}

function loadCanonicalSessionDigestRows(
  db: Db,
  digest: string,
  errorCode: CfpApplicantAccessErrorCode,
): Array<{ readonly id: string; readonly tokenHash: string }> {
  const rows = db
    .prepare(
      `SELECT id, token_hash
       FROM cfp_applicant_sessions
       WHERE lower(CAST(token_hash AS TEXT)) = ?`,
    )
    .all(digest) as unknown as Array<{ id: unknown; token_hash: unknown }>;

  return rows.map((row) => {
    const id = validateId(row.id, errorCode);
    const tokenHash = validateDigest(row.token_hash, errorCode);
    if (!constantTimeCompare(tokenHash, digest)) {
      throw new CfpApplicantAccessError(errorCode);
    }
    return { id, tokenHash };
  });
}

const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["OPEN", "CANCELLED"],
  OPEN: ["PAUSED", "CLOSED", "CANCELLED"],
  PAUSED: ["OPEN", "CLOSED", "CANCELLED"],
  CLOSED: ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  ARCHIVED: [],
};

type InternalCallRow = {
  readonly id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly name: string;
  readonly slug: string;
  readonly form_version_id: string;
  readonly access_mode: "PUBLIC" | "INVITED" | "PUBLIC_AND_INVITED";
  readonly state: CallReadModel["state"];
  readonly timezone: string;
  readonly opens_at: string | null;
  readonly closes_at: string | null;
  readonly policy_version_id: string;
  readonly policy_schema: string;
  readonly policy_json: string;
  readonly policy_fingerprint_algorithm: string;
  readonly policy_fingerprint: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly id_storage: string;
};

type ExtensionRow = {
  readonly id: string;
  readonly workspace_id: string;
  readonly call_id: string;
  readonly person_id: string;
  readonly extends_to: string;
  readonly reason: string;
  readonly granted_by: string;
  readonly idempotency_key: string;
  readonly created_at: string;
};

function validateExtensionIdempotencyIdentity(
  db: Db,
  workspaceId: string,
  idempotencyKey: string,
  extensionId: string,
  errorCode: CfpApplicantAccessErrorCode,
): void {
  try {
    const rows = db
      .prepare(
        `SELECT id, workspace_id, idempotency_key,
                typeof(workspace_id) AS workspace_storage,
                typeof(idempotency_key) AS key_storage
         FROM call_extensions
         WHERE CAST(workspace_id AS TEXT) = ?
           AND CAST(idempotency_key AS TEXT) = ?`,
      )
      .all(workspaceId, idempotencyKey) as unknown as Array<{
      id: unknown;
      workspace_id: unknown;
      idempotency_key: unknown;
      workspace_storage: unknown;
      key_storage: unknown;
    }>;
    if (rows.length !== 1) {
      throw new CfpApplicantAccessError(errorCode);
    }
    const identity = rows[0]!;
    if (
      validateId(identity.id, errorCode) !== extensionId ||
      validateId(identity.workspace_id, errorCode) !== workspaceId ||
      validateId(identity.idempotency_key, errorCode) !== idempotencyKey ||
      identity.workspace_storage !== "text" ||
      identity.key_storage !== "text"
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
  } catch {
    throw new CfpApplicantAccessError(errorCode);
  }
}

function validateExtensionRow(
  db: Db,
  row: ExtensionRow,
  workspaceId: string,
  errorCode: CfpApplicantAccessErrorCode,
  expectedCallId?: string,
  expectedPersonId?: string,
  notAfter?: string,
): ExtensionRow {
  try {
    validateId(row.id, errorCode);
    validateCanonicalIdentityRoot(db, "call_extensions", row.id, errorCode);
    validateId(row.workspace_id, errorCode);
    validateId(row.call_id, errorCode);
    validateId(row.person_id, errorCode);
    validateId(row.granted_by, errorCode);
    validateId(row.idempotency_key, errorCode);
    validateIsoInstant(row.extends_to, errorCode);
    validateIsoInstant(row.created_at, errorCode);
    validateStoredText(row.reason, 1024, errorCode);

    if (
      row.workspace_id !== workspaceId ||
      (expectedCallId !== undefined && row.call_id !== expectedCallId) ||
      (expectedPersonId !== undefined && row.person_id !== expectedPersonId) ||
      (notAfter !== undefined && row.created_at > notAfter) ||
      row.extends_to <= row.created_at
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }

    validateExtensionIdempotencyIdentity(
      db,
      workspaceId,
      row.idempotency_key,
      row.id,
      errorCode,
    );

    const call = loadCallRow(db, workspaceId, row.call_id, errorCode, notAfter);
    if (
      row.created_at < call.created_at ||
      (call.closes_at !== null && row.extends_to <= call.closes_at)
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }

    const mirrors = db
      .prepare(
        `SELECT
           (SELECT workspace_id FROM calls WHERE id = ?) AS call_workspace_id,
           (SELECT workspace_id FROM people WHERE id = ?) AS person_workspace_id,
           (SELECT workspace_id FROM accounts WHERE id = ?) AS account_workspace_id`,
      )
      .get(row.call_id, row.person_id, row.granted_by) as
      | {
          call_workspace_id: string | null;
          person_workspace_id: string | null;
          account_workspace_id: string | null;
        }
      | undefined;
    if (
      !mirrors ||
      mirrors.call_workspace_id !== workspaceId ||
      mirrors.person_workspace_id !== workspaceId ||
      mirrors.account_workspace_id !== workspaceId
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
    return row;
  } catch (error) {
    if (error instanceof CfpApplicantAccessFatalError) throw error;
    throw new CfpApplicantAccessError(errorCode);
  }
}

function loadCallRow(
  db: Db,
  workspaceId: string,
  callId: string,
  errorCode: CfpApplicantAccessErrorCode = "CALL_NOT_AVAILABLE",
  notAfter?: string,
): InternalCallRow {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (readApplicantAccessTransactionState(db)) {
        const before = readUnvalidatedCallIdentity(db, workspaceId, callId);
        try {
          const result = loadCallRowInSnapshot(
            db,
            workspaceId,
            callId,
            errorCode,
            notAfter,
            before,
          );
          const after = readUnvalidatedCallIdentity(db, workspaceId, callId);
          if (sameCallIdentitySnapshot(before, after)) {
            return result;
          }
        } catch (error) {
          const after = readUnvalidatedCallIdentity(db, workspaceId, callId);
          if (sameCallIdentitySnapshot(before, after) || attempt === 1) {
            throw error;
          }
        }
        continue;
      }

      // O2A verifies a call through more than one statement (call/event, then
      // retained form/rule/sealer evidence). Give that complete read one SQLite
      // snapshot so a concurrent dependency swap cannot produce a hybrid model.
      // The post-release observation deliberately remains outside the snapshot:
      // a supported call revision that committed during the read is retried once
      // rather than returned as an unnecessarily stale lifecycle snapshot.
      let before: CallIdentitySnapshot | null = null;
      let result: InternalCallRow | null = null;
      let readError: unknown = null;
      try {
        // A top-level SAVEPOINT provides the same deferred read snapshot as
        // BEGIN/COMMIT without consuming the COMMIT boundary of a subsequent
        // organizer mutation fault probe during its read-only preflight.
        result = withCoherentReadSnapshot(db, "cfp_call_read_snapshot", () => {
          before = readUnvalidatedCallIdentity(db, workspaceId, callId);
          const loaded = loadCallRowInSnapshot(
            db,
            workspaceId,
            callId,
            errorCode,
            notAfter,
            before,
          );
          const insideAfter = readUnvalidatedCallIdentity(db, workspaceId, callId);
          if (!sameCallIdentitySnapshot(before, insideAfter)) {
            throw new CfpApplicantAccessError(errorCode);
          }
          return loaded;
        });
      } catch (error) {
        readError = error;
      }

      if (before === null) {
        throw readError;
      }
      const after = readUnvalidatedCallIdentity(db, workspaceId, callId);
      if (!sameCallIdentitySnapshot(before, after)) {
        if (attempt === 0) continue;
        throw new CfpApplicantAccessError(errorCode);
      }
      if (readError !== null || result === null) {
        throw readError;
      }
      return result;
    }
    throw new CfpApplicantAccessError(errorCode);
  } catch (error) {
    if (error instanceof CfpApplicantAccessFatalError) throw error;
    throw new CfpApplicantAccessError(errorCode);
  }
}

type CallIdentitySnapshot = {
  readonly workspaceRows: readonly WorkspaceIdentityRow[];
  readonly callRows: readonly Record<string, unknown>[];
};

function readUnvalidatedCallIdentity(
  db: Db,
  workspaceId: string,
  callId: string,
): CallIdentitySnapshot {
  const callRows = db
    .prepare(
      `SELECT id, workspace_id, event_id, name, slug, form_version_id,
              access_mode, state, timezone, opens_at, closes_at,
              policy_version_id, policy_schema, policy_json,
              policy_fingerprint_algorithm, policy_fingerprint,
              created_at, updated_at, typeof(id) AS id_storage
       FROM calls WHERE id = ? OR id = CAST(? AS BLOB)`,
    )
    .all(callId, callId) as unknown as Record<string, unknown>[];
  return {
    workspaceRows: readWorkspaceIdentityRows(db, workspaceId),
    callRows,
  };
}

function sameDatabaseValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return Buffer.from(left).equals(Buffer.from(right));
  }
  return false;
}

function sameSnapshotRows(
  left: readonly Record<string, unknown>[],
  right: readonly Record<string, unknown>[],
  keys: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((leftRow, index) => {
    const rightRow = right[index]!;
    return keys.every((key) => sameDatabaseValue(leftRow[key], rightRow[key]));
  });
}

function sameCallIdentitySnapshot(
  left: CallIdentitySnapshot,
  right: CallIdentitySnapshot,
): boolean {
  const callKeys = [
    "id",
    "workspace_id",
    "event_id",
    "name",
    "slug",
    "form_version_id",
    "access_mode",
    "state",
    "timezone",
    "opens_at",
    "closes_at",
    "policy_version_id",
    "policy_schema",
    "policy_json",
    "policy_fingerprint_algorithm",
    "policy_fingerprint",
    "created_at",
    "updated_at",
    "id_storage",
  ] as const;
  const workspaceKeys = ["id", "created_at", "id_storage"] as const;
  return (
    sameSnapshotRows(
      left.callRows,
      right.callRows,
      callKeys,
    ) &&
    sameSnapshotRows(
      left.workspaceRows as readonly Record<string, unknown>[],
      right.workspaceRows as readonly Record<string, unknown>[],
      workspaceKeys,
    )
  );
}

function loadCallRowInSnapshot(
  db: Db,
  workspaceId: string,
  callId: string,
  errorCode: CfpApplicantAccessErrorCode,
  notAfter?: string,
  snapshot?: CallIdentitySnapshot,
): InternalCallRow {
  try {
    validateId(workspaceId, errorCode);
    validateId(callId, errorCode);
    const identity = snapshot ?? readUnvalidatedCallIdentity(db, workspaceId, callId);
    validateCanonicalWorkspaceRoot(
      db,
      workspaceId,
      errorCode,
      identity.workspaceRows,
    );
    if (identity.callRows.length !== 1) {
      throw new CfpApplicantAccessError(errorCode);
    }
    const row = identity.callRows[0]! as InternalCallRow;

    validateId(row.id, errorCode);
    validateId(row.workspace_id, errorCode);
    validateId(row.event_id, errorCode);
    validateId(row.form_version_id, errorCode);
    validateId(row.policy_version_id, errorCode);
    validateAccessMode(row.access_mode, errorCode);
    validateCallState(row.state, errorCode);
    validateStoredText(row.timezone, 128, errorCode);
    if (
      typeof row.name !== "string" ||
      row.name.length === 0 ||
      Buffer.byteLength(row.name, "utf-8") > 64 * 1024 ||
      typeof row.slug !== "string" ||
      row.slug.length === 0 ||
      Buffer.byteLength(row.slug, "utf-8") > 64 * 1024 ||
      typeof row.policy_json !== "string" ||
      row.policy_json.length === 0 ||
      Buffer.byteLength(row.policy_json, "utf-8") > 512 * 1024 ||
      row.policy_schema !== "cfp-call-policy/v1" ||
      row.policy_fingerprint_algorithm !== "sha256-canonical-json-v1"
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
    validateDigest(row.policy_fingerprint, errorCode);
    if (row.opens_at !== null) validateIsoInstant(row.opens_at, errorCode);
    if (row.closes_at !== null) validateIsoInstant(row.closes_at, errorCode);
    validateIsoInstant(row.created_at, errorCode);
    validateIsoInstant(row.updated_at, errorCode);
    if (
      row.id_storage !== "text" ||
      row.id !== callId ||
      row.workspace_id !== workspaceId ||
      row.updated_at < row.created_at ||
      (notAfter !== undefined &&
        (row.created_at > notAfter || row.updated_at > notAfter)) ||
      (row.opens_at !== null && row.closes_at !== null && row.opens_at > row.closes_at)
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }

    // O2A is the accepted verifier for the event/form/policy mirrors. O2B still
    // retains the globally enumerated raw row because updated_at is its
    // organizer CAS token and because the O2A lookup cannot see BLOB aliases.
    const verified = readCall(db, workspaceId, callId);
    if (
      verified.id !== row.id ||
      verified.workspaceId !== row.workspace_id ||
      verified.eventId !== row.event_id ||
      verified.formVersionId !== row.form_version_id ||
      verified.accessMode !== row.access_mode ||
      verified.state !== row.state ||
      verified.timezone !== row.timezone ||
      verified.opensAt !== row.opens_at ||
      verified.closesAt !== row.closes_at ||
      verified.policyVersionId !== row.policy_version_id ||
      verified.schema !== row.policy_schema ||
      verified.fingerprintAlgorithm !== row.policy_fingerprint_algorithm ||
      verified.fingerprint !== row.policy_fingerprint
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
    return row;
  } catch {
    throw new CfpApplicantAccessError(errorCode);
  }
}

function validateAndGetEffectiveExtension(
  db: Db,
  workspaceId: string,
  callId: string,
  personId: string,
  now: string,
): ExtensionRow | null {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, call_id, person_id, extends_to, reason, granted_by, idempotency_key, created_at
       FROM call_extensions
       WHERE workspace_id = ? AND call_id = ? AND person_id = ?`,
    )
    .all(workspaceId, callId, personId) as unknown as ExtensionRow[];

  for (const row of rows) {
    validateExtensionRow(
      db,
      row,
      workspaceId,
      "ACCESS_READ_FAILED",
      callId,
      personId,
      now,
    );
  }

  const validActive = rows.filter((row) => now < row.extends_to);
  if (validActive.length === 0) {
    return null;
  }

  validActive.sort((a, b) => {
    if (a.extends_to !== b.extends_to) {
      return b.extends_to.localeCompare(a.extends_to);
    }
    return b.created_at.localeCompare(a.created_at);
  });

  return validActive[0]!;
}

function resolvePersonByNormalizedEmail(
  db: Db,
  workspaceId: string,
  normalizedEmail: string,
  readErrorCode: CfpApplicantAccessErrorCode = "ACCESS_READ_FAILED",
  notAfter?: string,
): string | null {
  validateCanonicalWorkspaceRoot(db, workspaceId, readErrorCode);
  const candidateRows = db
    .prepare(
      `SELECT id, workspace_id, canonical_email, created_at,
              typeof(workspace_id) AS workspace_storage
       FROM people
       WHERE workspace_id = ? OR workspace_id = CAST(? AS BLOB)`,
    )
    .all(workspaceId, workspaceId) as unknown as {
    id: unknown;
    workspace_id: unknown;
    canonical_email: unknown;
    created_at: unknown;
    workspace_storage: unknown;
  }[];
  const rows = candidateRows.filter((row) =>
    matchesCanonicalEmailCandidate(
      row.canonical_email,
      normalizedEmail,
      readErrorCode,
    ),
  );

  if (rows.length > 1) {
    throw new CfpApplicantAccessError(readErrorCode);
  }
  if (rows.length === 1) {
    const row = rows[0]!;
    let personId: string;
    try {
      personId = validateId(row.id, readErrorCode);
      validateCanonicalIdentityRoot(db, "people", personId, readErrorCode);
      const personWorkspaceId = validateId(row.workspace_id, readErrorCode);
      const personEmail = validateStoredEmail(
        row.canonical_email,
        readErrorCode,
      );
      const personCreatedAt = validateIsoInstant(
        row.created_at,
        readErrorCode,
      );
      if (
        row.workspace_storage !== "text" ||
        personWorkspaceId !== workspaceId ||
        personEmail !== normalizedEmail ||
        (notAfter !== undefined && personCreatedAt > notAfter)
      ) {
        throw new CfpApplicantAccessError(readErrorCode);
      }
    } catch {
      throw new CfpApplicantAccessError(readErrorCode);
    }
    return personId;
  }
  return null;
}

type VerificationRow = {
  readonly id: string;
  readonly workspace_id: string;
  readonly call_id: string;
  readonly email: string;
  readonly token_hash: string;
  readonly expires_at: string;
  readonly created_at: string;
};

type OrderedVerificationRow = VerificationRow & {
  readonly issuance_sequence: number;
};

function validateVerificationIssuanceSequence(
  value: unknown,
  errorCode: CfpApplicantAccessErrorCode,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return value;
}

function validateVerificationRow(
  row: VerificationRow,
  workspaceId: string,
  errorCode: CfpApplicantAccessErrorCode,
  expected?: {
    readonly id?: string;
    readonly callId?: string;
    readonly email?: string;
  },
): VerificationRow {
  try {
    validateId(row.id, errorCode);
    validateId(row.workspace_id, errorCode);
    validateId(row.call_id, errorCode);
    validateStoredEmail(row.email, errorCode);
    validateDigest(row.token_hash, errorCode);
    validateIsoInstant(row.created_at, errorCode);
    validateIsoInstant(row.expires_at, errorCode);
    if (
      row.workspace_id !== workspaceId ||
      row.expires_at <= row.created_at ||
      (expected?.id !== undefined && row.id !== expected.id) ||
      (expected?.callId !== undefined && row.call_id !== expected.callId) ||
      (expected?.email !== undefined && row.email !== expected.email)
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
    return row;
  } catch {
    throw new CfpApplicantAccessError(errorCode);
  }
}

function loadCanonicalVerificationRoot(
  db: Db,
  verificationId: string,
  workspaceId: string,
  errorCode: CfpApplicantAccessErrorCode,
  expected?: {
    readonly callId?: string;
    readonly email?: string;
  },
): OrderedVerificationRow {
  try {
    validateId(verificationId, errorCode);
    validateCanonicalWorkspaceRoot(db, workspaceId, errorCode);
    const rows = db
      .prepare(
        `SELECT id, workspace_id, call_id, email, token_hash, expires_at,
                created_at, issuance_sequence, typeof(id) AS id_storage
         FROM cfp_email_verifications
         WHERE id = ? OR id = CAST(? AS BLOB)`,
      )
      .all(verificationId, verificationId) as unknown as Array<
      VerificationRow & {
        readonly issuance_sequence: unknown;
        readonly id_storage: unknown;
      }
    >;
    if (rows.length !== 1 || rows[0]!.id_storage !== "text") {
      throw new CfpApplicantAccessError(errorCode);
    }
    const row = validateVerificationRow(rows[0]!, workspaceId, errorCode, {
      id: verificationId,
      callId: expected?.callId,
      email: expected?.email,
    });
    return {
      ...row,
      issuance_sequence: validateVerificationIssuanceSequence(
        rows[0]!.issuance_sequence,
        errorCode,
      ),
    };
  } catch {
    throw new CfpApplicantAccessError(errorCode);
  }
}

function loadScopedVerificationHistory(
  db: Db,
  workspaceId: string,
  callId: string,
  normalizedEmail: string,
  errorCode: CfpApplicantAccessErrorCode,
): OrderedVerificationRow[] {
  try {
    const candidateRows = db
      .prepare(
        `SELECT id, workspace_id, call_id, email, token_hash, expires_at,
                created_at, issuance_sequence
         FROM cfp_email_verifications
         WHERE workspace_id = ? AND call_id = ?`,
      )
      .all(workspaceId, callId) as unknown as Array<
      VerificationRow & { readonly issuance_sequence: unknown }
    >;

    const history: OrderedVerificationRow[] = [];
    for (const candidate of candidateRows) {
      if (
        !matchesCanonicalEmailCandidate(
          candidate.email,
          normalizedEmail,
          errorCode,
        )
      ) {
        continue;
      }
      const scopedRow = validateVerificationRow(
        candidate,
        workspaceId,
        errorCode,
        { callId, email: normalizedEmail },
      );
      const candidateSequence = validateVerificationIssuanceSequence(
        candidate.issuance_sequence,
        errorCode,
      );
      const root = loadCanonicalVerificationRoot(
        db,
        scopedRow.id,
        workspaceId,
        errorCode,
        { callId, email: normalizedEmail },
      );
      if (
        candidateSequence !== root.issuance_sequence ||
        !sameVerificationEvidence(scopedRow, root)
      ) {
        throw new CfpApplicantAccessError(errorCode);
      }
      history.push(root);
    }

    history.sort(
      (left, right) => left.issuance_sequence - right.issuance_sequence,
    );
    for (let index = 0; index < history.length; index += 1) {
      if (history[index]!.issuance_sequence !== index + 1) {
        throw new CfpApplicantAccessError(errorCode);
      }
    }
    return history;
  } catch (error) {
    if (error instanceof CfpApplicantAccessFatalError) throw error;
    throw new CfpApplicantAccessError(errorCode);
  }
}

function sameVerificationEvidence(
  left: VerificationRow,
  right: VerificationRow,
): boolean {
  return (
    left.id === right.id &&
    left.workspace_id === right.workspace_id &&
    left.call_id === right.call_id &&
    left.email === right.email &&
    left.token_hash === right.token_hash &&
    left.expires_at === right.expires_at &&
    left.created_at === right.created_at
  );
}

type ConsumptionRow = {
  readonly id: string;
  readonly workspace_id: string;
  readonly verification_id: string;
  readonly person_id: string;
  readonly consumed_at: string;
};

function validateConsumptionRow(
  db: Db,
  row: ConsumptionRow,
  workspaceId: string,
  errorCode: CfpApplicantAccessErrorCode,
  expected?: {
    readonly verificationId?: string;
    readonly personId?: string;
  },
): ConsumptionRow {
  try {
    validateId(row.id, errorCode);
    validateCanonicalIdentityRoot(
      db,
      "cfp_email_verification_consumptions",
      row.id,
      errorCode,
    );
    validateId(row.workspace_id, errorCode);
    validateId(row.verification_id, errorCode);
    validateId(row.person_id, errorCode);
    validateIsoInstant(row.consumed_at, errorCode);
    if (
      row.workspace_id !== workspaceId ||
      (expected?.verificationId !== undefined &&
        row.verification_id !== expected.verificationId) ||
      (expected?.personId !== undefined && row.person_id !== expected.personId)
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
    return row;
  } catch {
    throw new CfpApplicantAccessError(errorCode);
  }
}

function validateConsumptionIdentity(
  db: Db,
  candidate: ConsumptionRow,
  verification: VerificationRow,
  workspaceId: string,
  currentNow: string,
  errorCode: CfpApplicantAccessErrorCode,
): ConsumptionRow {
  const consumed = validateConsumptionRow(
    db,
    candidate,
    workspaceId,
    errorCode,
    {
      verificationId: verification.id,
    },
  );
  if (
    consumed.consumed_at < verification.created_at ||
    consumed.consumed_at >= verification.expires_at ||
    consumed.consumed_at > currentNow ||
    resolvePersonByNormalizedEmail(
      db,
      workspaceId,
      verification.email,
      errorCode,
      consumed.consumed_at,
    ) !== consumed.person_id
  ) {
    throw new CfpApplicantAccessError(errorCode);
  }
  return consumed;
}

function evaluateCallAccess(
  db: Db,
  workspaceId: string,
  callId: string,
  personId: string | null,
  currentNow: string,
  action: CfpApplicantAction,
): ApplicantAccessGrant {
  const denyCode: CfpApplicantAccessErrorCode =
    action === "REQUEST_VERIFICATION"
      ? "VERIFICATION_REQUEST_REJECTED"
      : action === "CONSUME_VERIFICATION"
        ? "VERIFICATION_INVALID"
        : "CALL_NOT_ACCEPTING";

  const readErrorCode: CfpApplicantAccessErrorCode =
    action === "REQUEST_VERIFICATION"
      ? "VERIFICATION_REQUEST_REJECTED"
      : action === "CONSUME_VERIFICATION"
        ? "VERIFICATION_INVALID"
        : "ACCESS_READ_FAILED";

  const call = loadCallRow(db, workspaceId, callId, readErrorCode, currentNow);

  if (call.state === "CANCELLED" || call.state === "ARCHIVED") {
    throw new CfpApplicantAccessError(denyCode);
  }
  if (call.state === "DRAFT" || call.state === "SCHEDULED" || call.state === "PAUSED") {
    throw new CfpApplicantAccessError(denyCode);
  }

  if (call.opens_at !== null && currentNow < call.opens_at) {
    throw new CfpApplicantAccessError(denyCode);
  }

  if (call.access_mode === "INVITED") {
    throw new CfpApplicantAccessError(denyCode);
  }

  const isClosed = call.state === "CLOSED" || (call.closes_at !== null && currentNow >= call.closes_at);
  if (!isClosed) {
    return { allowed: true, late: false, extensionId: null };
  }

  if (!personId) {
    throw new CfpApplicantAccessError(denyCode);
  }

  const activeExt = validateAndGetEffectiveExtension(
    db,
    workspaceId,
    callId,
    personId,
    currentNow,
  );
  if (!activeExt) {
    throw new CfpApplicantAccessError(denyCode);
  }

  return { allowed: true, late: true, extensionId: activeExt.id };
}

type ValidatedApplicantSessionIdentity = {
  readonly id: string;
  readonly workspaceId: string;
  readonly callId: string;
  readonly personId: string;
  readonly verificationId: string;
  readonly email: string;
  readonly tokenHash: string;
  readonly verificationCreatedAt: string;
  readonly verificationExpiresAt: string;
  readonly consumedAt: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokedReason: string | null;
};

function loadApplicantSessionIdentity(
  db: Db,
  workspaceId: string,
  sessionId: string,
  errorCode: CfpApplicantAccessErrorCode,
  notAfter?: string,
): ValidatedApplicantSessionIdentity {
  validateCanonicalWorkspaceRoot(db, workspaceId, errorCode);
  validateCanonicalIdentityRoot(
    db,
    "cfp_applicant_sessions",
    sessionId,
    errorCode,
  );
  const rows = db
    .prepare(
      `SELECT
         s.id AS session_id,
         s.workspace_id AS session_workspace_id,
         s.call_id AS session_call_id,
         s.person_id AS session_person_id,
         s.verification_id AS session_verification_id,
         s.token_hash AS session_token_hash,
         s.created_at AS session_created_at,
         s.expires_at AS session_expires_at,
         s.revoked_at AS session_revoked_at,
         s.revoked_by AS session_revoked_by,
         s.revoked_reason AS session_revoked_reason,
         v.id AS verification_id,
         v.workspace_id AS verification_workspace_id,
         v.call_id AS verification_call_id,
         v.email AS verification_email,
         v.token_hash AS verification_token_hash,
         v.created_at AS verification_created_at,
         v.expires_at AS verification_expires_at,
         consumed.id AS consumption_id,
         consumed.workspace_id AS consumption_workspace_id,
         consumed.verification_id AS consumption_verification_id,
         consumed.person_id AS consumption_person_id,
         consumed.consumed_at AS consumption_consumed_at,
         p.id AS person_id,
         p.workspace_id AS person_workspace_id,
         p.canonical_email AS person_email,
         p.created_at AS person_created_at,
         c.id AS call_id,
         c.workspace_id AS call_workspace_id,
         c.created_at AS call_created_at,
         c.updated_at AS call_updated_at,
         revoked_by.workspace_id AS revoked_by_workspace_id
       FROM cfp_applicant_sessions s
       JOIN cfp_email_verifications v ON v.id = s.verification_id
       JOIN cfp_email_verification_consumptions consumed
         ON consumed.workspace_id = s.workspace_id
        AND consumed.verification_id = s.verification_id
       JOIN people p ON p.id = s.person_id
       JOIN calls c ON c.id = s.call_id
       LEFT JOIN accounts revoked_by ON revoked_by.id = s.revoked_by
       WHERE (s.workspace_id = ? OR s.workspace_id = CAST(? AS BLOB))
         AND (s.id = ? OR s.id = CAST(? AS BLOB))`,
    )
    .all(workspaceId, workspaceId, sessionId, sessionId) as unknown as Array<{
    session_id: string;
    session_workspace_id: string;
    session_call_id: string;
    session_person_id: string;
    session_verification_id: string;
    session_token_hash: string;
    session_created_at: string;
    session_expires_at: string;
    session_revoked_at: string | null;
    session_revoked_by: string | null;
    session_revoked_reason: string | null;
    verification_id: string;
    verification_workspace_id: string;
    verification_call_id: string;
    verification_email: string;
    verification_token_hash: string;
    verification_created_at: string;
    verification_expires_at: string;
    consumption_id: string;
    consumption_workspace_id: string;
    consumption_verification_id: string;
    consumption_person_id: string;
    consumption_consumed_at: string;
    person_id: string;
    person_workspace_id: string;
    person_email: string;
    person_created_at: string;
    call_id: string;
    call_workspace_id: string;
    call_created_at: string;
    call_updated_at: string;
    revoked_by_workspace_id: string | null;
  }>;

  if (rows.length !== 1) {
    throw new CfpApplicantAccessError(errorCode);
  }

  const row = rows[0]!;
  try {
    for (const id of [
      row.session_id,
      row.session_workspace_id,
      row.session_call_id,
      row.session_person_id,
      row.session_verification_id,
      row.verification_id,
      row.verification_workspace_id,
      row.verification_call_id,
      row.consumption_id,
      row.consumption_workspace_id,
      row.consumption_verification_id,
      row.consumption_person_id,
      row.person_id,
      row.person_workspace_id,
      row.call_id,
      row.call_workspace_id,
    ]) {
      validateId(id, errorCode);
    }
    validateDigest(row.session_token_hash, errorCode);
    validateDigest(row.verification_token_hash, errorCode);
    validateIsoInstant(row.session_created_at, errorCode);
    validateIsoInstant(row.session_expires_at, errorCode);
    validateIsoInstant(row.verification_created_at, errorCode);
    validateIsoInstant(row.verification_expires_at, errorCode);
    validateIsoInstant(row.consumption_consumed_at, errorCode);
    validateIsoInstant(row.person_created_at, errorCode);
    validateIsoInstant(row.call_created_at, errorCode);
    validateIsoInstant(row.call_updated_at, errorCode);
    const verificationEmail = validateStoredEmail(row.verification_email, errorCode);
    const personEmail = validateStoredEmail(row.person_email, errorCode);
    if (verificationEmail !== personEmail) {
      throw new CfpApplicantAccessError(errorCode);
    }
    if (
      resolvePersonByNormalizedEmail(db, workspaceId, verificationEmail, errorCode) !==
      row.session_person_id
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }

    const verificationRoot = loadCanonicalVerificationRoot(
      db,
      row.session_verification_id,
      workspaceId,
      errorCode,
      {
        callId: row.session_call_id,
        email: verificationEmail,
      },
    );
    if (
      !sameVerificationEvidence(verificationRoot, {
        id: row.verification_id,
        workspace_id: row.verification_workspace_id,
        call_id: row.verification_call_id,
        email: verificationEmail,
        token_hash: row.verification_token_hash,
        created_at: row.verification_created_at,
        expires_at: row.verification_expires_at,
      })
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }

    const revocationAllNull =
      row.session_revoked_at === null &&
      row.session_revoked_by === null &&
      row.session_revoked_reason === null;
    const revocationAllPresent =
      row.session_revoked_at !== null &&
      row.session_revoked_by !== null &&
      row.session_revoked_reason !== null;
    if (!revocationAllNull && !revocationAllPresent) {
      throw new CfpApplicantAccessError(errorCode);
    }
    if (revocationAllPresent) {
      validateIsoInstant(row.session_revoked_at, errorCode);
      validateId(row.session_revoked_by, errorCode);
      validateStoredText(row.session_revoked_reason, 1024, errorCode);
      if (row.revoked_by_workspace_id !== workspaceId) {
        throw new CfpApplicantAccessError(errorCode);
      }
    }

    if (
      row.session_id !== sessionId ||
      row.session_workspace_id !== workspaceId ||
      row.verification_id !== row.session_verification_id ||
      row.verification_workspace_id !== workspaceId ||
      row.verification_call_id !== row.session_call_id ||
      row.consumption_workspace_id !== workspaceId ||
      row.consumption_verification_id !== row.session_verification_id ||
      row.consumption_person_id !== row.session_person_id ||
      row.person_id !== row.session_person_id ||
      row.person_workspace_id !== workspaceId ||
      row.call_id !== row.session_call_id ||
      row.call_workspace_id !== workspaceId ||
      row.verification_created_at < row.call_created_at ||
      row.verification_expires_at <= row.verification_created_at ||
      row.consumption_consumed_at < row.verification_created_at ||
      row.consumption_consumed_at >= row.verification_expires_at ||
      row.session_created_at < row.consumption_consumed_at ||
      row.session_created_at >= row.verification_expires_at ||
      row.person_created_at > row.consumption_consumed_at ||
      row.session_expires_at <= row.session_created_at ||
      row.call_updated_at < row.call_created_at ||
      (notAfter !== undefined &&
        (row.call_created_at > notAfter || row.call_updated_at > notAfter)) ||
      (row.session_revoked_at !== null && row.session_revoked_at < row.session_created_at)
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
    const consumptionRows = db
      .prepare(
        `SELECT id, workspace_id, verification_id, person_id, consumed_at
         FROM cfp_email_verification_consumptions
         WHERE verification_id = ? OR verification_id = CAST(? AS BLOB)`,
      )
      .all(
        row.session_verification_id,
        row.session_verification_id,
      ) as unknown as ConsumptionRow[];
    if (consumptionRows.length !== 1) {
      throw new CfpApplicantAccessError(errorCode);
    }
    const onlyConsumption = validateConsumptionRow(
      db,
      consumptionRows[0]!,
      workspaceId,
      errorCode,
      {
        verificationId: row.session_verification_id,
        personId: row.session_person_id,
      },
    );
    if (
      onlyConsumption.id !== row.consumption_id ||
      onlyConsumption.consumed_at !== row.consumption_consumed_at
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
    const verificationSessionRows = db
      .prepare(
        `SELECT id, workspace_id, call_id, person_id, verification_id, token_hash
         FROM cfp_applicant_sessions
         WHERE verification_id = ? OR verification_id = CAST(? AS BLOB)`,
      )
      .all(
        row.session_verification_id,
        row.session_verification_id,
      ) as unknown as Array<{
      id: string;
      workspace_id: string;
      call_id: string;
      person_id: string;
      verification_id: string;
      token_hash: string;
    }>;
    if (verificationSessionRows.length !== 1) {
      throw new CfpApplicantAccessError(errorCode);
    }
    const onlySession = verificationSessionRows[0]!;
    for (const id of [
      onlySession.id,
      onlySession.workspace_id,
      onlySession.call_id,
      onlySession.person_id,
      onlySession.verification_id,
    ]) {
      validateId(id, errorCode);
    }
    validateDigest(onlySession.token_hash, errorCode);
    if (
      onlySession.id !== row.session_id ||
      onlySession.workspace_id !== row.session_workspace_id ||
      onlySession.call_id !== row.session_call_id ||
      onlySession.person_id !== row.session_person_id ||
      onlySession.verification_id !== row.session_verification_id ||
      !constantTimeCompare(onlySession.token_hash, row.session_token_hash)
    ) {
      throw new CfpApplicantAccessError(errorCode);
    }
    const digestRows = loadCanonicalSessionDigestRows(
      db,
      row.session_token_hash,
      errorCode,
    );
    if (digestRows.length !== 1 || digestRows[0]?.id !== row.session_id) {
      throw new CfpApplicantAccessError(errorCode);
    }
    loadCallRow(db, workspaceId, row.session_call_id, errorCode, notAfter);
  } catch (error) {
    if (error instanceof CfpApplicantAccessFatalError) throw error;
    throw new CfpApplicantAccessError(errorCode);
  }

  return {
    id: row.session_id,
    workspaceId: row.session_workspace_id,
    callId: row.session_call_id,
    personId: row.session_person_id,
    verificationId: row.session_verification_id,
    email: row.verification_email,
    tokenHash: row.session_token_hash,
    verificationCreatedAt: row.verification_created_at,
    verificationExpiresAt: row.verification_expires_at,
    consumedAt: row.consumption_consumed_at,
    createdAt: row.session_created_at,
    expiresAt: row.session_expires_at,
    revokedAt: row.session_revoked_at,
    revokedBy: row.session_revoked_by,
    revokedReason: row.session_revoked_reason,
  };
}

type OrganizerPreflightClassification = Readonly<{
  databaseRole: string;
  auditWorkspaceId: string;
}>;

function preflightOrganizerScope(
  db: Db,
  session: OrganizerSessionSnapshot,
  targetKind: "call" | "applicant_session",
  callId: string,
  personId?: string,
  sessionId?: string,
): OrganizerPreflightClassification {
  let validScope = false;
  let auditWorkspaceId: string | null = null;
  let databaseRole: string | null = null;
  const serializedRead = createOrganizerTargetReadProbe(db);
  try {
    withCoherentReadSnapshot(db, "organizer_scope_preflight", () => {
      const readDb = serializedRead.db;
      validateId(session.workspaceId, "CALL_NOT_AVAILABLE");
      validateId(session.accountId, "CALL_NOT_AVAILABLE");
      validateId(callId, "CALL_NOT_AVAILABLE");

      if (validateAuditWorkspace(readDb, session.workspaceId) !== null) {
        auditWorkspaceId = session.workspaceId;
      }

      // Establish the complete target identity before inspecting actor
      // authority. The call and Person/session graph are now necessarily from
      // one SQLite snapshot, so no actor can observe a valid hybrid target.
      assertOrganizerTargetScope(
        readDb,
        session,
        callId,
        personId,
        sessionId,
      );

      const accountRows = readDb
        .prepare(
          `SELECT id, workspace_id, role, created_at
           FROM accounts
           WHERE CAST(id AS TEXT) = ?`,
        )
        .all(session.accountId) as unknown as Array<{
        id: unknown;
        workspace_id: unknown;
        role: unknown;
        created_at: unknown;
      }>;
      if (accountRows.length !== 1) {
        throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
      }
      const account = accountRows[0]!;
      const accountId = validateId(account.id, "CALL_NOT_AVAILABLE");
      const accountWorkspaceId = validateId(
        account.workspace_id,
        "CALL_NOT_AVAILABLE",
      );
      const validatedRole = validateStoredText(
        account.role,
        128,
        "CALL_NOT_AVAILABLE",
      );
      if (!VALID_ACCOUNT_ROLES.has(validatedRole)) {
        throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
      }
      validateIsoInstant(account.created_at, "CALL_NOT_AVAILABLE");
      if (validateAuditWorkspace(readDb, accountWorkspaceId) === null) {
        throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
      }
      auditWorkspaceId = accountWorkspaceId;
      databaseRole = validatedRole;
      if (
        accountId !== session.accountId ||
        accountWorkspaceId !== session.workspaceId
      ) {
        throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
      }

      validScope = true;
      if (serializedRead.faulted()) {
        throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
      }
    });
  } catch (error) {
    if (error instanceof CfpApplicantAccessFatalError) throw error;
    if (serializedRead.faulted()) {
      throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
    }
    if (
      error instanceof CfpApplicantAccessError &&
      error.code === "CALL_NOT_AVAILABLE"
    ) {
      validScope = false;
    } else {
      // Snapshot-boundary/driver failures are infrastructure failures, not
      // evidence that the target is out of scope. Never manufacture a denial
      // audit from an unreadable preflight.
      throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
    }
  }

  if (!validScope) {
    return commitOrganizerRaceDenial(
      db,
      session,
      targetKind,
      { kind: "scope" },
      auditWorkspaceId,
    );
  }
  if (databaseRole === null || auditWorkspaceId === null) {
    throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
  }
  return { databaseRole, auditWorkspaceId };
}

function requireOrganizerCapability(
  db: Db,
  session: OrganizerSessionSnapshot,
  targetKind: "call" | "applicant_session",
  classification: OrganizerPreflightClassification,
): void {
  if (
    roleHasCapability(
      classification.databaseRole,
      "phase0.pipeline.manage",
    )
  ) {
    return;
  }
  return commitOrganizerRaceDenial(
    db,
    session,
    targetKind,
    { kind: "capability", role: classification.databaseRole },
    classification.auditWorkspaceId,
  );
}

function validateAuditWorkspace(db: Db, workspaceId: string): string | null {
  try {
    return validateCanonicalWorkspaceRoot(
      db,
      workspaceId,
      "CALL_NOT_AVAILABLE",
    );
  } catch {
    return null;
  }
}

function assertOrganizerTargetScope(
  db: Db,
  session: OrganizerSessionSnapshot,
  callId: string,
  personId?: string,
  sessionId?: string,
): void {
  validateId(session.workspaceId, "CALL_NOT_AVAILABLE");
  validateId(callId, "CALL_NOT_AVAILABLE");
  loadCallRow(db, session.workspaceId, callId, "CALL_NOT_AVAILABLE");

  if (personId !== undefined) {
    validateId(personId, "CALL_NOT_AVAILABLE");
    const rows = db
      .prepare(
        `SELECT id, workspace_id, canonical_email, created_at
         FROM people
         WHERE CAST(id AS TEXT) = ?`,
      )
      .all(personId) as unknown as Array<{
      id: unknown;
      workspace_id: unknown;
      canonical_email: unknown;
      created_at: unknown;
    }>;
    if (rows.length !== 1) {
      throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
    }
    const person = rows[0]!;
    const storedId = validateId(person.id, "CALL_NOT_AVAILABLE");
    const storedWorkspaceId = validateId(
      person.workspace_id,
      "CALL_NOT_AVAILABLE",
    );
    validateStoredEmail(person.canonical_email, "CALL_NOT_AVAILABLE");
    validateIsoInstant(person.created_at, "CALL_NOT_AVAILABLE");
    if (storedId !== personId || storedWorkspaceId !== session.workspaceId) {
      throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
    }
  }

  if (sessionId !== undefined) {
    validateId(sessionId, "CALL_NOT_AVAILABLE");
    const target = loadApplicantSessionIdentity(
      db,
      session.workspaceId,
      sessionId,
      "CALL_NOT_AVAILABLE",
    );
    if (
      target.id !== sessionId ||
      target.workspaceId !== session.workspaceId ||
      target.callId !== callId
    ) {
      throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
    }
  }
}

function assertCurrentOrganizerAuthority(
  db: Db,
  session: OrganizerSessionSnapshot,
): void {
  validateId(session.workspaceId, "CALL_NOT_AVAILABLE");
  validateId(session.accountId, "CALL_NOT_AVAILABLE");
  let rows: Array<{
    id: unknown;
    workspace_id: unknown;
    role: unknown;
    created_at: unknown;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT id, workspace_id, role, created_at
         FROM accounts
         WHERE CAST(id AS TEXT) = ?`,
      )
      .all(session.accountId) as unknown as Array<{
      id: unknown;
      workspace_id: unknown;
      role: unknown;
      created_at: unknown;
    }>;
  } catch {
    throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
  }
  if (rows.length !== 1) {
    throw new OrganizerAuthorityChangedError(null, null);
  }
  const account = rows[0]!;
  let accountId: string;
  let accountWorkspaceId: string;
  let role: string;
  try {
    accountId = validateId(account.id, "CALL_NOT_AVAILABLE");
    accountWorkspaceId = validateId(account.workspace_id, "CALL_NOT_AVAILABLE");
    if (validateAuditWorkspace(db, accountWorkspaceId) === null) {
      throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
    }
    role = validateStoredText(account.role, 128, "CALL_NOT_AVAILABLE");
    validateIsoInstant(account.created_at, "CALL_NOT_AVAILABLE");
  } catch {
    const possibleWorkspace =
      typeof account.workspace_id === "string" &&
      validateAuditWorkspace(db, account.workspace_id) !== null
        ? account.workspace_id
        : null;
    throw new OrganizerAuthorityChangedError(null, possibleWorkspace);
  }
  if (
    accountId !== session.accountId ||
    accountWorkspaceId !== session.workspaceId ||
    !VALID_ACCOUNT_ROLES.has(role)
  ) {
    throw new OrganizerAuthorityChangedError(null, accountWorkspaceId);
  }
  if (!roleHasCapability(role, "phase0.pipeline.manage")) {
    throw new OrganizerAuthorityChangedError(role, accountWorkspaceId);
  }
}

type OrganizerDenialClassification =
  | { readonly kind: "capability"; readonly role: string }
  | { readonly kind: "scope" };

function commitOrganizerRaceDenial(
  db: Db,
  session: OrganizerSessionSnapshot,
  targetKind: "call" | "applicant_session",
  classification: OrganizerDenialClassification,
  preferredAuditWorkspaceId: string | null,
): never {
  try {
    withMappedWriteTransaction(db, "organizer_race_denial", () => {
      const auditRead = createOrganizerTargetReadProbe(db);
      let auditWorkspaceId =
        preferredAuditWorkspaceId !== null &&
        validateAuditWorkspace(
          auditRead.db,
          preferredAuditWorkspaceId,
        ) !== null
          ? preferredAuditWorkspaceId
          : null;

      // Classification is the immutable fact observed by the coherent
      // preflight or while the mutation lock was held. Re-resolve only the
      // actor's canonical current workspace so a later account move or role
      // change cannot rewrite that fact or place its evidence in a stale
      // caller workspace.
      const accountRows = auditRead.db
        .prepare(
          `SELECT id, workspace_id, created_at,
                  typeof(id) AS id_storage,
                  typeof(workspace_id) AS workspace_storage
           FROM accounts
           WHERE id = ? OR id = CAST(? AS BLOB)`,
        )
        .all(session.accountId, session.accountId) as unknown as Array<{
        id: unknown;
        workspace_id: unknown;
        created_at: unknown;
        id_storage: unknown;
        workspace_storage: unknown;
      }>;
      if (accountRows.length === 1) {
        const account = accountRows[0]!;
        try {
          const accountId = validateId(account.id, "ACCESS_WRITE_FAILED");
          const workspaceId = validateId(
            account.workspace_id,
            "ACCESS_WRITE_FAILED",
          );
          validateIsoInstant(account.created_at, "ACCESS_WRITE_FAILED");
          if (
            account.id_storage === "text" &&
            account.workspace_storage === "text" &&
            accountId === session.accountId &&
            validateAuditWorkspace(auditRead.db, workspaceId) !== null
          ) {
            auditWorkspaceId = workspaceId;
          }
        } catch {
          // Use the validated preferred/fallback workspace without reflecting
          // malformed current account data into immutable audit details.
        }
      }

      if (auditWorkspaceId === null) {
        auditWorkspaceId = validateAuditWorkspace(
          auditRead.db,
          session.workspaceId,
        );
      }
      if (auditWorkspaceId === null) {
        throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
      }
      if (auditRead.faulted()) {
        throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
      }

      if (classification.kind === "capability") {
        if (
          !VALID_ACCOUNT_ROLES.has(classification.role) ||
          roleHasCapability(classification.role, "phase0.pipeline.manage")
        ) {
          throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
        }
        writeDenialAudit(db, auditWorkspaceId, {
          actorKind: "account",
          actorRef: session.accountId,
          code: "CAPABILITY_DENIED",
          targetType: "capability",
          targetId: "phase0.pipeline.manage",
          details: { capabilityPresent: false },
        });
        return;
      }

      writeDenialAudit(db, auditWorkspaceId, {
        actorKind: "account",
        actorRef: session.accountId,
        code: "CALL_NOT_AVAILABLE",
        targetType: "cfp_organizer_scope",
        targetId: targetKind,
        details: { scopeValid: false },
      });
    });
  } catch (error) {
    if (error instanceof CfpApplicantAccessFatalError) throw error;
    if (
      error instanceof CfpApplicantAccessError &&
      error.code === "ACCESS_WRITE_FAILED"
    ) {
      throw error;
    }
    throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
  }

  if (classification.kind === "capability") {
    throw new DenialError(
      "CAPABILITY_DENIED",
      "This account is not authorized to perform that workspace action.",
      "phase0.pipeline.manage",
    );
  }
  throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
}

function withOrganizerWriteTransaction<T>(
  db: Db,
  session: OrganizerSessionSnapshot,
  targetKind: "call" | "applicant_session",
  name: string,
  assertTargetScope: (targetDb: Db) => void,
  fn: () => T,
): T {
  try {
    return withMappedWriteTransaction(db, name, () => {
      const targetRead = createOrganizerTargetReadProbe(db);
      try {
        assertTargetScope(targetRead.db);
      } catch (error) {
        if (error instanceof CfpApplicantAccessFatalError) throw error;
        if (targetRead.faulted()) {
          throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
        }
        if (
          error instanceof CfpApplicantAccessError &&
          error.code === "CALL_NOT_AVAILABLE"
        ) {
          throw new OrganizerTargetScopeChangedError();
        }
        throw error;
      }
      if (targetRead.faulted()) {
        throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
      }
      try {
        assertCurrentOrganizerAuthority(targetRead.db, session);
      } catch (error) {
        if (error instanceof CfpApplicantAccessFatalError) throw error;
        if (targetRead.faulted()) {
          throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
        }
        throw error;
      }
      if (targetRead.faulted()) {
        throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
      }
      return fn();
    });
  } catch (error) {
    if (error instanceof OrganizerTargetScopeChangedError) {
      return commitOrganizerRaceDenial(
        db,
        session,
        targetKind,
        { kind: "scope" },
        null,
      );
    }
    if (error instanceof OrganizerAuthorityChangedError) {
      return commitOrganizerRaceDenial(
        db,
        session,
        targetKind,
        error.databaseRole === null
          ? { kind: "scope" }
          : { kind: "capability", role: error.databaseRole },
        error.auditWorkspaceId,
      );
    }
    throw error;
  }
}

export function createCfpApplicantAccess(
  options?: CfpApplicantAccessOptions,
): CfpApplicantAccess {
  const optionsSnapshot =
    options === undefined
      ? Object.freeze({
          verificationTtlMs: undefined,
          sessionTtlMs: undefined,
          now: undefined,
          id: undefined,
          auditWriter: undefined,
        })
      : snapshotProperties(
          options,
          [
            "verificationTtlMs",
            "sessionTtlMs",
            "now",
            "id",
            "auditWriter",
          ] as const,
          "ACCESS_INPUT_INVALID",
        );

  let verificationTtlMs = DEFAULT_VERIFICATION_TTL_MS;
  if (optionsSnapshot.verificationTtlMs !== undefined) {
    if (
      !Number.isInteger(optionsSnapshot.verificationTtlMs) ||
      (optionsSnapshot.verificationTtlMs as number) < 60_000 ||
      (optionsSnapshot.verificationTtlMs as number) > 86_400_000
    ) {
      throw new CfpApplicantAccessError("ACCESS_INPUT_INVALID");
    }
    verificationTtlMs = optionsSnapshot.verificationTtlMs as number;
  }

  let sessionTtlMs = DEFAULT_SESSION_TTL_MS;
  if (optionsSnapshot.sessionTtlMs !== undefined) {
    if (
      !Number.isInteger(optionsSnapshot.sessionTtlMs) ||
      (optionsSnapshot.sessionTtlMs as number) < 3_600_000 ||
      (optionsSnapshot.sessionTtlMs as number) > 2_592_000_000
    ) {
      throw new CfpApplicantAccessError("ACCESS_INPUT_INVALID");
    }
    sessionTtlMs = optionsSnapshot.sessionTtlMs as number;
  }

  if (
    (optionsSnapshot.now !== undefined && typeof optionsSnapshot.now !== "function") ||
    (optionsSnapshot.id !== undefined && typeof optionsSnapshot.id !== "function") ||
    (optionsSnapshot.auditWriter !== undefined &&
      typeof optionsSnapshot.auditWriter !== "function")
  ) {
    throw new CfpApplicantAccessError("ACCESS_INPUT_INVALID");
  }

  const rawNow = (optionsSnapshot.now as (() => string) | undefined) ?? nowIso;
  const rawId = (optionsSnapshot.id as (() => string) | undefined) ?? uuid;
  const auditFn =
    (optionsSnapshot.auditWriter as
      | ((db: Db, workspaceId: string, input: AuditInput) => void)
      | undefined) ?? writeAudit;

  const nowFn = (): string => validateIsoInstant(rawNow(), "ACCESS_INPUT_INVALID");
  const idFn = (): string => validateId(rawId(), "ACCESS_INPUT_INVALID");

  return {
    readCallLifecycle(db: Db, workspaceId: string, callId: string): CallLifecycleSnapshot {
      try {
        validateId(workspaceId, "CALL_NOT_AVAILABLE");
        validateId(callId, "CALL_NOT_AVAILABLE");
        const call = loadCallRow(
          db,
          workspaceId,
          callId,
          "CALL_NOT_AVAILABLE",
          nowFn(),
        );
        return { state: call.state, updatedAt: call.updated_at };
      } catch (err) {
        if (
          err instanceof CfpApplicantAccessError ||
          err instanceof CfpApplicantAccessFatalError
        ) {
          throw err;
        }
        throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
      }
    },

    transitionCallState(
      db: Db,
      session: SessionInfo,
      input: TransitionCallStateInput,
    ): CallLifecycleSnapshot {
      const organizerSession = snapshotOrganizerSession(session);
      const inputSnapshot = snapshotProperties(
        input,
        ["callId", "expectedUpdatedAt", "expectedState", "nextState"] as const,
        "CALL_NOT_AVAILABLE",
      );
      const callId = validateId(inputSnapshot.callId, "CALL_NOT_AVAILABLE");
      const expectedUpdatedAt = validateIsoInstant(
        inputSnapshot.expectedUpdatedAt,
        "CALL_STATE_STALE",
      );
      const expectedState = validateCallState(
        inputSnapshot.expectedState,
        "CALL_STATE_INVALID",
      );
      const nextState = validateCallState(
        inputSnapshot.nextState,
        "CALL_STATE_INVALID",
      );

      if (
        !Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, expectedState) ||
        !ALLOWED_TRANSITIONS[expectedState]?.includes(nextState)
      ) {
        throw new CfpApplicantAccessError("CALL_STATE_INVALID");
      }

      const preflight = preflightOrganizerScope(
        db,
        organizerSession,
        "call",
        callId,
      );
      requireOrganizerCapability(db, organizerSession, "call", preflight);

      return withOrganizerWriteTransaction(
        db,
        organizerSession,
        "call",
        "transition_call_state",
        (targetDb) =>
          assertOrganizerTargetScope(targetDb, organizerSession, callId),
        () => {
        try {
          const call = loadCallRow(
            db,
            organizerSession.workspaceId,
            callId,
            "CALL_NOT_AVAILABLE",
          );

          if (call.state !== expectedState) {
            throw new CfpApplicantAccessError("CALL_STATE_STALE");
          }
          if (call.updated_at !== expectedUpdatedAt) {
            throw new CfpApplicantAccessError("CALL_STATE_STALE");
          }

          const currentNow = nowFn();
          if (currentNow <= call.updated_at) {
            throw new CfpApplicantAccessError("CALL_STATE_STALE");
          }

          const res = db
            .prepare(
              `UPDATE calls SET state = ?, updated_at = ?
               WHERE id = ? AND workspace_id = ? AND state = ? AND updated_at = ?`,
            )
            .run(
              nextState,
              currentNow,
              callId,
              organizerSession.workspaceId,
              expectedState,
              expectedUpdatedAt,
            );

          if (res.changes !== 1) {
            throw new CfpApplicantAccessError("CALL_STATE_STALE");
          }

          auditFn(db, organizerSession.workspaceId, {
            actorKind: "account",
            actorRef: organizerSession.accountId,
            action: "cfp.call.transition",
            targetType: "call",
            targetId: callId,
            details: {
              fromState: expectedState,
              toState: nextState,
            },
          });

          return { state: nextState, updatedAt: currentNow };
        } catch (err) {
          if (
            err instanceof CfpApplicantAccessError ||
            err instanceof CfpApplicantAccessFatalError ||
            err instanceof OrganizerAuthorityChangedError
          ) {
            throw err;
          }
          throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
        }
        },
      );
    },

    grantCallExtension(
      db: Db,
      session: SessionInfo,
      input: GrantCallExtensionInput,
    ) {
      const organizerSession = snapshotOrganizerSession(session);
      const inputSnapshot = snapshotProperties(
        input,
        ["callId", "personId", "idempotencyKey", "extendsTo", "reason"] as const,
        "CALL_NOT_AVAILABLE",
      );
      const callId = validateId(inputSnapshot.callId, "CALL_NOT_AVAILABLE");
      const personId = validateId(inputSnapshot.personId, "EXTENSION_INVALID");
      const idempotencyKey = validateId(
        inputSnapshot.idempotencyKey,
        "EXTENSION_INVALID",
      );
      const extendsTo = validateIsoInstant(
        inputSnapshot.extendsTo,
        "EXTENSION_INVALID",
      );
      const trimmedReason = validateText(
        inputSnapshot.reason,
        1024,
        "EXTENSION_INVALID",
      );

      const preflight = preflightOrganizerScope(
        db,
        organizerSession,
        "call",
        callId,
        personId,
      );
      requireOrganizerCapability(db, organizerSession, "call", preflight);

      return withOrganizerWriteTransaction(
        db,
        organizerSession,
        "call",
        "grant_call_extension",
        (targetDb) =>
          assertOrganizerTargetScope(
            targetDb,
            organizerSession,
            callId,
            personId,
          ),
        () => {
        try {
          const currentNow = nowFn();
          if (extendsTo <= currentNow) {
            throw new CfpApplicantAccessError("EXTENSION_INVALID");
          }

          const call = loadCallRow(
            db,
            organizerSession.workspaceId,
            callId,
            "CALL_NOT_AVAILABLE",
            currentNow,
          );
          if (call.state === "CANCELLED" || call.state === "ARCHIVED") {
            throw new CfpApplicantAccessError("EXTENSION_INVALID");
          }
          if (call.closes_at !== null && extendsTo <= call.closes_at) {
            throw new CfpApplicantAccessError("EXTENSION_INVALID");
          }

          const personRow = db
            .prepare(
              `SELECT id, workspace_id, canonical_email, created_at
               FROM people
               WHERE CAST(id AS TEXT) = ?
                 AND CAST(workspace_id AS TEXT) = ?`,
            )
            .all(personId, organizerSession.workspaceId) as unknown as Array<{
            id: string;
            workspace_id: string;
            canonical_email: string;
            created_at: string;
          }>;
          if (personRow.length !== 1) {
            throw new CfpApplicantAccessError("EXTENSION_INVALID");
          }
          const storedPerson = personRow[0]!;
          try {
            validateId(storedPerson.id, "ACCESS_READ_FAILED");
            validateId(storedPerson.workspace_id, "ACCESS_READ_FAILED");
            validateStoredEmail(storedPerson.canonical_email, "ACCESS_READ_FAILED");
            validateIsoInstant(storedPerson.created_at, "ACCESS_READ_FAILED");
            if (
              storedPerson.id !== personId ||
              storedPerson.workspace_id !== organizerSession.workspaceId ||
              storedPerson.created_at > currentNow
            ) {
              throw new CfpApplicantAccessError("ACCESS_READ_FAILED");
            }
          } catch {
            throw new CfpApplicantAccessError("ACCESS_READ_FAILED");
          }

          const existingRows = db
            .prepare(
              `SELECT id, workspace_id, call_id, person_id, extends_to, reason, granted_by, idempotency_key, created_at
               FROM call_extensions
               WHERE CAST(workspace_id AS TEXT) = ?
                 AND CAST(call_id AS TEXT) = ?
                 AND CAST(person_id AS TEXT) = ?`,
            )
            .all(
              organizerSession.workspaceId,
              callId,
              personId,
            ) as unknown as ExtensionRow[];

          let currentMaxExtendsTo: string | null = null;
          for (const candidate of existingRows) {
            const row = validateExtensionRow(
              db,
              candidate,
              organizerSession.workspaceId,
              "ACCESS_READ_FAILED",
              callId,
              personId,
              currentNow,
            );
            if (currentMaxExtendsTo === null || row.extends_to > currentMaxExtendsTo) {
              currentMaxExtendsTo = row.extends_to;
            }
          }

          const idempotencyRows = db
            .prepare(
              `SELECT id, workspace_id, call_id, person_id, extends_to, reason, granted_by, idempotency_key, created_at
               FROM call_extensions
               WHERE CAST(workspace_id AS TEXT) = ?
                 AND CAST(idempotency_key AS TEXT) = ?`,
            )
            .all(
              organizerSession.workspaceId,
              idempotencyKey,
            ) as unknown as ExtensionRow[];
          if (idempotencyRows.length > 1) {
            throw new CfpApplicantAccessError("ACCESS_READ_FAILED");
          }
          const idempotencyRow = idempotencyRows[0];

          if (idempotencyRow) {
            validateExtensionRow(
              db,
              idempotencyRow,
              organizerSession.workspaceId,
              "ACCESS_READ_FAILED",
              undefined,
              undefined,
              currentNow,
            );

            const matches =
              idempotencyRow.workspace_id === organizerSession.workspaceId &&
              idempotencyRow.idempotency_key === idempotencyKey &&
              idempotencyRow.call_id === callId &&
              idempotencyRow.person_id === personId &&
              idempotencyRow.extends_to === extendsTo &&
              idempotencyRow.reason === trimmedReason &&
              idempotencyRow.granted_by === organizerSession.accountId;
            if (matches) {
              return {
                extensionId: idempotencyRow.id,
                workspaceId: organizerSession.workspaceId,
                callId,
                personId,
                extendsTo: idempotencyRow.extends_to,
                replayed: true,
              };
            }
            throw new CfpApplicantAccessError("EXTENSION_IDEMPOTENCY_CONFLICT");
          }

          if (currentMaxExtendsTo !== null && extendsTo <= currentMaxExtendsTo) {
            throw new CfpApplicantAccessError("EXTENSION_INVALID");
          }

          const extensionId = idFn();
          assertGeneratedIdentityAvailable(db, "call_extensions", extensionId);
          const inserted = db.prepare(
            `INSERT INTO call_extensions
               (id, workspace_id, call_id, person_id, extends_to, reason, granted_by, idempotency_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            extensionId,
            organizerSession.workspaceId,
            callId,
            personId,
            extendsTo,
            trimmedReason,
            organizerSession.accountId,
            idempotencyKey,
            currentNow,
          );
          if (inserted.changes !== 1) {
            throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
          }
          assertGeneratedIdentityPersisted(db, "call_extensions", extensionId);

          auditFn(db, organizerSession.workspaceId, {
            actorKind: "account",
            actorRef: organizerSession.accountId,
            action: "cfp.call.grant_extension",
            targetType: "call_extension",
            targetId: extensionId,
            details: {
              granted: true,
            },
          });

          // The database UNIQUE constraint distinguishes TEXT from BLOB. The
          // final service postcondition therefore re-proves the workspace-key
          // identity after every trusted audit callback as well as before the
          // insert, so no aliased retained row can escape this transaction.
          validateExtensionRow(
            db,
            {
              id: extensionId,
              workspace_id: organizerSession.workspaceId,
              call_id: callId,
              person_id: personId,
              extends_to: extendsTo,
              reason: trimmedReason,
              granted_by: organizerSession.accountId,
              idempotency_key: idempotencyKey,
              created_at: currentNow,
            },
            organizerSession.workspaceId,
            "ACCESS_WRITE_FAILED",
            callId,
            personId,
            currentNow,
          );

          return {
            extensionId,
            workspaceId: organizerSession.workspaceId,
            callId,
            personId,
            extendsTo,
            replayed: false,
          };
        } catch (err) {
          if (
            err instanceof CfpApplicantAccessError ||
            err instanceof CfpApplicantAccessFatalError ||
            err instanceof OrganizerAuthorityChangedError
          ) {
            throw err;
          }
          throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
        }
        },
      );
    },

    issueEmailVerification(
      db: Db,
      context: VerificationIssuanceContext,
      input: IssueEmailVerificationInput,
    ): IssuedEmailVerification {
      const contextSnapshot = snapshotProperties(
        context,
        ["workspaceId"] as const,
        "CALL_NOT_AVAILABLE",
      );
      const inputSnapshot = snapshotProperties(
        input,
        ["callId", "email", "tokenHash"] as const,
        "CALL_NOT_AVAILABLE",
      );
      const workspaceId = validateId(
        contextSnapshot.workspaceId,
        "CALL_NOT_AVAILABLE",
      );
      const callId = validateId(inputSnapshot.callId, "CALL_NOT_AVAILABLE");
      const normalizedEmail = validateEmail(
        inputSnapshot.email,
        "VERIFICATION_REQUEST_REJECTED",
      );
      const digest = validateDigest(
        inputSnapshot.tokenHash,
        "VERIFICATION_REQUEST_REJECTED",
      );

      return withMappedWriteTransaction(db, "issue_verification", () => {
        try {
          const currentNow = nowFn();
          // A replay is state-independent, but the scoped call and all of its
          // accepted O2A mirrors must still exist and validate.
          const call = loadCallRow(
            db,
            workspaceId,
            callId,
            "CALL_NOT_AVAILABLE",
            currentNow,
          );

          const allRows = loadScopedVerificationHistory(
            db,
            workspaceId,
            callId,
            normalizedEmail,
            "ACCESS_READ_FAILED",
          );

          let exactRow: OrderedVerificationRow | null = null;
          let exactUnconsumed = false;
          for (const row of allRows) {
            if (row.created_at < call.created_at) {
              throw new CfpApplicantAccessError("ACCESS_READ_FAILED");
            }

            const consumedRows = db
              .prepare(
                `SELECT id, workspace_id, verification_id, person_id, consumed_at
                 FROM cfp_email_verification_consumptions
                 WHERE verification_id = ? OR verification_id = CAST(? AS BLOB)`,
              )
              .all(row.id, row.id) as unknown as ConsumptionRow[];
            if (consumedRows.length > 1) {
              throw new CfpApplicantAccessError("ACCESS_READ_FAILED");
            }
            if (consumedRows.length === 1) {
              validateConsumptionIdentity(
                db,
                consumedRows[0]!,
                row,
                workspaceId,
                currentNow,
                "ACCESS_READ_FAILED",
              );
            }

            const isUnconsumed = consumedRows.length === 0;
            if (constantTimeCompare(row.token_hash, digest)) {
              if (exactRow !== null) {
                throw new CfpApplicantAccessError("ACCESS_READ_FAILED");
              }
              exactRow = row;
              exactUnconsumed = isUnconsumed;
            }
          }

          if (exactRow !== null) {
            const latestRow = allRows.at(-1);
            if (latestRow === undefined || latestRow.id !== exactRow.id) {
              throw new CfpApplicantAccessError("VERIFICATION_REQUEST_REJECTED");
            }
            if (
              exactUnconsumed &&
              exactRow.created_at <= currentNow &&
              currentNow < exactRow.expires_at
            ) {
              return {
                verificationId: exactRow.id,
                workspaceId,
                callId,
                expiresAt: exactRow.expires_at,
                replayed: true,
              };
            }
            throw new CfpApplicantAccessError("VERIFICATION_REQUEST_REJECTED");
          }

          const personId = resolvePersonByNormalizedEmail(
            db,
            workspaceId,
            normalizedEmail,
            "VERIFICATION_REQUEST_REJECTED",
            currentNow,
          );

          evaluateCallAccess(
            db,
            workspaceId,
            callId,
            personId,
            currentNow,
            "REQUEST_VERIFICATION",
          );

          const expiresAt = addMilliseconds(currentNow, verificationTtlMs);
          const verificationId = idFn();
          const issuanceSequence = validateVerificationIssuanceSequence(
            allRows.length + 1,
            "ACCESS_WRITE_FAILED",
          );

          assertGeneratedIdentityAvailable(
            db,
            "cfp_email_verifications",
            verificationId,
          );
          const inserted = db.prepare(
            `INSERT INTO cfp_email_verifications
               (id, workspace_id, call_id, email, token_hash, expires_at,
                created_at, issuance_sequence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            verificationId,
            workspaceId,
            callId,
            normalizedEmail,
            digest,
            expiresAt,
            currentNow,
            issuanceSequence,
          );
          if (inserted.changes !== 1) {
            throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
          }
          assertGeneratedIdentityPersisted(
            db,
            "cfp_email_verifications",
            verificationId,
          );
          const persisted = loadCanonicalVerificationRoot(
            db,
            verificationId,
            workspaceId,
            "ACCESS_WRITE_FAILED",
            { callId, email: normalizedEmail },
          );
          if (
            persisted.issuance_sequence !== issuanceSequence ||
            !sameVerificationEvidence(persisted, {
              id: verificationId,
              workspace_id: workspaceId,
              call_id: callId,
              email: normalizedEmail,
              token_hash: digest,
              expires_at: expiresAt,
              created_at: currentNow,
            })
          ) {
            throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
          }

          return {
            verificationId,
            workspaceId,
            callId,
            expiresAt,
            replayed: false,
          };
        } catch (err) {
          if (
            err instanceof CfpApplicantAccessError ||
            err instanceof CfpApplicantAccessFatalError
          ) {
            throw err;
          }
          throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
        }
      });
    },

    consumeEmailVerification(
      db: Db,
      context: VerificationIssuanceContext,
      input: ConsumeEmailVerificationInput,
    ): ConsumedApplicantSession {
      const contextSnapshot = snapshotProperties(
        context,
        ["workspaceId"] as const,
        "VERIFICATION_INVALID",
      );
      const inputSnapshot = snapshotProperties(
        input,
        [
          "callId",
          "verificationId",
          "verificationTokenHash",
          "applicantSessionTokenHash",
          "fullName",
        ] as const,
        "VERIFICATION_INVALID",
      );
      const workspaceId = validateId(
        contextSnapshot.workspaceId,
        "VERIFICATION_INVALID",
      );
      const callId = validateId(inputSnapshot.callId, "VERIFICATION_INVALID");
      const verificationId = validateId(
        inputSnapshot.verificationId,
        "VERIFICATION_INVALID",
      );
      const vDigest = validateDigest(
        inputSnapshot.verificationTokenHash,
        "VERIFICATION_INVALID",
      );
      const sDigest = validateDigest(
        inputSnapshot.applicantSessionTokenHash,
        "VERIFICATION_INVALID",
      );
      const fullName = validateText(
        inputSnapshot.fullName,
        256,
        "VERIFICATION_INVALID",
      );

      return withMappedWriteTransaction(db, "consume_verification", () => {
        try {
          const currentNow = nowFn();

          const vRow = loadCanonicalVerificationRoot(
            db,
            verificationId,
            workspaceId,
            "VERIFICATION_INVALID",
            { callId },
          );

          if (!constantTimeCompare(vRow.token_hash, vDigest)) {
            throw new CfpApplicantAccessError("VERIFICATION_INVALID");
          }

          if (vRow.created_at > currentNow || currentNow >= vRow.expires_at) {
            throw new CfpApplicantAccessError("VERIFICATION_INVALID");
          }
          const call = loadCallRow(
            db,
            workspaceId,
            callId,
            "VERIFICATION_INVALID",
            currentNow,
          );
          if (vRow.created_at < call.created_at) {
            throw new CfpApplicantAccessError("VERIFICATION_INVALID");
          }

          // Verification evidence is append-only. A later issuance for the
          // exact workspace/call/email scope durably supersedes every earlier
          // token, regardless of whether the later delivery ultimately left
          // the adapter. This makes a failed delivery immediately retryable
          // without allowing the abandoned token to authenticate afterward.
          const verificationHistory = loadScopedVerificationHistory(
            db,
            workspaceId,
            callId,
            vRow.email,
            "VERIFICATION_INVALID",
          );
          const latestVerification = verificationHistory.at(-1);
          if (
            latestVerification === undefined ||
            latestVerification.id !== verificationId ||
            latestVerification.issuance_sequence !== vRow.issuance_sequence ||
            !sameVerificationEvidence(latestVerification, vRow)
          ) {
            throw new CfpApplicantAccessError("VERIFICATION_INVALID");
          }

          const consumptionRows = db
            .prepare(
              `SELECT id, workspace_id, verification_id, person_id, consumed_at
               FROM cfp_email_verification_consumptions
               WHERE verification_id = ? OR verification_id = CAST(? AS BLOB)`,
            )
            .all(verificationId, verificationId) as unknown as ConsumptionRow[];
          const sessionRows = db
            .prepare(
              `SELECT id, workspace_id, call_id, person_id, verification_id, token_hash
               FROM cfp_applicant_sessions
               WHERE verification_id = ? OR verification_id = CAST(? AS BLOB)`,
            )
            .all(verificationId, verificationId) as unknown as Array<{
            id: string;
            workspace_id: string;
            call_id: string;
            person_id: string;
            verification_id: string;
            token_hash: string;
          }>;

          if (consumptionRows.length !== 0 || sessionRows.length !== 0) {
            if (consumptionRows.length !== 1 || sessionRows.length !== 1) {
              throw new CfpApplicantAccessError("VERIFICATION_INVALID");
            }
            const consumed = validateConsumptionRow(
              db,
              consumptionRows[0]!,
              workspaceId,
              "VERIFICATION_INVALID",
              { verificationId },
            );
            const sessionRow = sessionRows[0]!;
            try {
              validateId(sessionRow.id, "VERIFICATION_INVALID");
              validateId(sessionRow.workspace_id, "VERIFICATION_INVALID");
              validateId(sessionRow.call_id, "VERIFICATION_INVALID");
              validateId(sessionRow.person_id, "VERIFICATION_INVALID");
              validateId(sessionRow.verification_id, "VERIFICATION_INVALID");
              validateDigest(sessionRow.token_hash, "VERIFICATION_INVALID");
            } catch {
              throw new CfpApplicantAccessError("VERIFICATION_INVALID");
            }
            if (
              sessionRow.workspace_id !== workspaceId ||
              sessionRow.call_id !== callId ||
              sessionRow.verification_id !== verificationId ||
              sessionRow.person_id !== consumed.person_id ||
              !constantTimeCompare(sessionRow.token_hash, sDigest)
            ) {
              throw new CfpApplicantAccessError("VERIFICATION_INVALID");
            }
            const identity = loadApplicantSessionIdentity(
              db,
              workspaceId,
              sessionRow.id,
              "VERIFICATION_INVALID",
              currentNow,
            );
            if (
              identity.callId !== callId ||
              identity.verificationId !== verificationId ||
              identity.personId !== consumed.person_id ||
              identity.email !== vRow.email ||
              identity.consumedAt !== consumed.consumed_at ||
              identity.consumedAt > currentNow ||
              identity.createdAt > currentNow ||
              !constantTimeCompare(identity.tokenHash, sDigest)
            ) {
              throw new CfpApplicantAccessError("VERIFICATION_INVALID");
            }
            return {
              sessionId: identity.id,
              workspaceId,
              callId,
              personId: identity.personId,
              expiresAt: identity.expiresAt,
              replayed: true,
            };
          }

          const sessionDigestCollisions = loadCanonicalSessionDigestRows(
            db,
            sDigest,
            "VERIFICATION_INVALID",
          );
          if (sessionDigestCollisions.length > 0) {
            throw new CfpApplicantAccessError("VERIFICATION_INVALID");
          }

          const normalizedVEmail = vRow.email;
          let personId = resolvePersonByNormalizedEmail(
            db,
            workspaceId,
            normalizedVEmail,
            "VERIFICATION_INVALID",
            currentNow,
          );

          evaluateCallAccess(
            db,
            workspaceId,
            callId,
            personId,
            currentNow,
            "CONSUME_VERIFICATION",
          );

          if (!personId) {
            personId = idFn();
            assertGeneratedIdentityAvailable(db, "people", personId);
            const insertedPerson = db.prepare(
              `INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at)
               VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
            ).run(personId, workspaceId, normalizedVEmail, fullName, currentNow);
            if (insertedPerson.changes !== 1) {
              throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
            }
            assertGeneratedIdentityPersisted(db, "people", personId);
          }

          const consumptionId = idFn();
          assertGeneratedIdentityAvailable(
            db,
            "cfp_email_verification_consumptions",
            consumptionId,
          );
          const insertedConsumption = db.prepare(
            `INSERT INTO cfp_email_verification_consumptions
               (id, workspace_id, verification_id, person_id, consumed_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(consumptionId, workspaceId, verificationId, personId, currentNow);
          if (insertedConsumption.changes !== 1) {
            throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
          }
          assertGeneratedIdentityPersisted(
            db,
            "cfp_email_verification_consumptions",
            consumptionId,
          );

          const sessionId = idFn();
          const sessionExpiresAt = addMilliseconds(currentNow, sessionTtlMs);

          assertGeneratedIdentityAvailable(
            db,
            "cfp_applicant_sessions",
            sessionId,
          );
          const insertedSession = db.prepare(
            `INSERT INTO cfp_applicant_sessions
               (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at, revoked_at, revoked_by, revoked_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
          ).run(
            sessionId,
            workspaceId,
            callId,
            personId,
            verificationId,
            sDigest,
            currentNow,
            sessionExpiresAt,
          );
          if (insertedSession.changes !== 1) {
            throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
          }
          assertGeneratedIdentityPersisted(
            db,
            "cfp_applicant_sessions",
            sessionId,
          );

          return {
            sessionId,
            workspaceId,
            callId,
            personId,
            expiresAt: sessionExpiresAt,
            replayed: false,
          };
        } catch (err) {
          if (
            err instanceof CfpApplicantAccessError ||
            err instanceof CfpApplicantAccessFatalError
          ) {
            throw err;
          }
          throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
        }
      });
    },

    resolveApplicantSession(
      db: Db,
      input: ResolveApplicantSessionInput,
    ): ResolvedApplicantSession {
      try {
        const inputSnapshot = snapshotProperties(
          input,
          ["workspaceId", "callId", "sessionTokenHash"] as const,
          "SESSION_INVALID",
        );
        const workspaceId = validateId(
          inputSnapshot.workspaceId,
          "SESSION_INVALID",
        );
        const callId = validateId(inputSnapshot.callId, "SESSION_INVALID");
        const sDigest = validateDigest(
          inputSnapshot.sessionTokenHash,
          "SESSION_INVALID",
        );

        return withCoherentReadSnapshot(
          db,
          "resolve_applicant_session",
          () => {
            const rows = db
              .prepare(
                `SELECT id, workspace_id, call_id, token_hash
                 FROM cfp_applicant_sessions
                 WHERE workspace_id = ? AND call_id = ? AND token_hash = ?`,
              )
              .all(workspaceId, callId, sDigest) as unknown as Array<{
              id: string;
              workspace_id: string;
              call_id: string;
              token_hash: string;
            }>;

            if (rows.length !== 1) {
              throw new CfpApplicantAccessError("SESSION_INVALID");
            }

            const row = rows[0]!;
            try {
              validateId(row.id, "SESSION_INVALID");
              validateId(row.workspace_id, "SESSION_INVALID");
              validateId(row.call_id, "SESSION_INVALID");
              validateDigest(row.token_hash, "SESSION_INVALID");
            } catch {
              throw new CfpApplicantAccessError("SESSION_INVALID");
            }
            if (
              row.workspace_id !== workspaceId ||
              row.call_id !== callId ||
              !constantTimeCompare(row.token_hash, sDigest)
            ) {
              throw new CfpApplicantAccessError("SESSION_INVALID");
            }

            const currentNow = nowFn();
            const identity = loadApplicantSessionIdentity(
              db,
              workspaceId,
              row.id,
              "SESSION_INVALID",
              currentNow,
            );
            if (
              identity.callId !== callId ||
              !constantTimeCompare(identity.tokenHash, sDigest) ||
              identity.revokedAt !== null
            ) {
              throw new CfpApplicantAccessError("SESSION_INVALID");
            }

            if (
              identity.createdAt > currentNow ||
              currentNow >= identity.expiresAt
            ) {
              throw new CfpApplicantAccessError("SESSION_INVALID");
            }

            return {
              context: {
                workspaceId,
                sessionId: identity.id,
              },
              personId: identity.personId,
              callId,
              expiresAt: identity.expiresAt,
            };
          },
        );
      } catch (err) {
        if (
          err instanceof CfpApplicantAccessError ||
          err instanceof CfpApplicantAccessFatalError
        ) {
          throw err;
        }
        throw new CfpApplicantAccessError("SESSION_INVALID");
      }
    },

    revokeApplicantSession(
      db: Db,
      session: SessionInfo,
      input: RevokeApplicantSessionInput,
    ) {
      const organizerSession = snapshotOrganizerSession(session);
      const inputSnapshot = snapshotProperties(
        input,
        ["callId", "sessionId", "reason"] as const,
        "CALL_NOT_AVAILABLE",
      );
      const callId = validateId(inputSnapshot.callId, "CALL_NOT_AVAILABLE");
      const sessionId = validateId(inputSnapshot.sessionId, "SESSION_INVALID");
      const trimmedReason = validateText(
        inputSnapshot.reason,
        1024,
        "SESSION_INVALID",
      );

      const preflight = preflightOrganizerScope(
        db,
        organizerSession,
        "applicant_session",
        callId,
        undefined,
        sessionId,
      );
      requireOrganizerCapability(
        db,
        organizerSession,
        "applicant_session",
        preflight,
      );

      return withOrganizerWriteTransaction(
        db,
        organizerSession,
        "applicant_session",
        "revoke_session",
        (targetDb) =>
          assertOrganizerTargetScope(
            targetDb,
            organizerSession,
            callId,
            undefined,
            sessionId,
          ),
        () => {
        try {
          const currentNow = nowFn();
          const identity = loadApplicantSessionIdentity(
            db,
            organizerSession.workspaceId,
            sessionId,
            "CALL_NOT_AVAILABLE",
            currentNow,
          );
          if (identity.callId !== callId) {
            throw new CfpApplicantAccessError("CALL_NOT_AVAILABLE");
          }
          if (currentNow < identity.createdAt) {
            throw new CfpApplicantAccessError("SESSION_REVOKE_CONFLICT");
          }

          if (identity.revokedAt !== null) {
            if (identity.revokedAt > currentNow) {
              throw new CfpApplicantAccessError("SESSION_REVOKE_CONFLICT");
            }
            if (
              identity.revokedBy === organizerSession.accountId &&
              identity.revokedReason === trimmedReason
            ) {
              return {
                sessionId,
                revokedAt: identity.revokedAt,
                replayed: true,
              };
            }
            throw new CfpApplicantAccessError("SESSION_REVOKE_CONFLICT");
          }

          const res = db
            .prepare(
              `UPDATE cfp_applicant_sessions
               SET revoked_at = ?, revoked_by = ?, revoked_reason = ?
               WHERE id = ? AND workspace_id = ? AND call_id = ? AND revoked_at IS NULL`,
            )
            .run(
              currentNow,
              organizerSession.accountId,
              trimmedReason,
              sessionId,
              organizerSession.workspaceId,
              callId,
            );

          if (res.changes !== 1) {
            throw new CfpApplicantAccessError("SESSION_REVOKE_CONFLICT");
          }

          auditFn(db, organizerSession.workspaceId, {
            actorKind: "account",
            actorRef: organizerSession.accountId,
            action: "cfp.session.revoke",
            targetType: "applicant_session",
            targetId: sessionId,
            details: {
              revoked: true,
            },
          });

          return {
            sessionId,
            revokedAt: currentNow,
            replayed: false,
          };
        } catch (err) {
          if (
            err instanceof CfpApplicantAccessError ||
            err instanceof CfpApplicantAccessFatalError ||
            err instanceof OrganizerAuthorityChangedError
          ) {
            throw err;
          }
          throw new CfpApplicantAccessError("ACCESS_WRITE_FAILED");
        }
        },
      );
    },

    assertApplicantAccess(
      db: Db,
      input: AssertApplicantAccessInput,
    ): ApplicantAccessGrant {
      try {
        const inputSnapshot = snapshotProperties(
          input,
          ["action", "context"] as const,
          "SESSION_INVALID",
        );
        const contextSnapshot = snapshotProperties(
          inputSnapshot.context,
          ["workspaceId", "sessionId"] as const,
          "SESSION_INVALID",
        );
        const workspaceId = validateId(
          contextSnapshot.workspaceId,
          "SESSION_INVALID",
        );
        const sessionId = validateId(
          contextSnapshot.sessionId,
          "SESSION_INVALID",
        );
        const action = inputSnapshot.action;
        if (
          action !== "CREATE_DRAFT" &&
          action !== "SAVE_DRAFT" &&
          action !== "SUBMIT"
        ) {
          throw new CfpApplicantAccessError("ACCESS_INPUT_INVALID");
        }

        return withCoherentReadSnapshot(db, "assert_applicant_access", () => {
          const currentNow = nowFn();
          const identity = loadApplicantSessionIdentity(
            db,
            workspaceId,
            sessionId,
            "SESSION_INVALID",
            currentNow,
          );

          if (
            identity.revokedAt !== null ||
            identity.createdAt > currentNow ||
            currentNow >= identity.expiresAt
          ) {
            throw new CfpApplicantAccessError("SESSION_INVALID");
          }

          return evaluateCallAccess(
            db,
            workspaceId,
            identity.callId,
            identity.personId,
            currentNow,
            action,
          );
        });
      } catch (err) {
        if (
          err instanceof CfpApplicantAccessError ||
          err instanceof CfpApplicantAccessFatalError
        ) {
          throw err;
        }
        throw new CfpApplicantAccessError("ACCESS_READ_FAILED");
      }
    },
  };
}

const defaultApplicantAccess = createCfpApplicantAccess();

export function readCallLifecycle(
  db: Db,
  workspaceId: string,
  callId: string,
): CallLifecycleSnapshot {
  return defaultApplicantAccess.readCallLifecycle(db, workspaceId, callId);
}

export function transitionCallState(
  db: Db,
  session: SessionInfo,
  input: TransitionCallStateInput,
): CallLifecycleSnapshot {
  return defaultApplicantAccess.transitionCallState(db, session, input);
}

export function grantCallExtension(
  db: Db,
  session: SessionInfo,
  input: GrantCallExtensionInput,
) {
  return defaultApplicantAccess.grantCallExtension(db, session, input);
}

export function issueEmailVerification(
  db: Db,
  context: VerificationIssuanceContext,
  input: IssueEmailVerificationInput,
): IssuedEmailVerification {
  return defaultApplicantAccess.issueEmailVerification(db, context, input);
}

export function consumeEmailVerification(
  db: Db,
  context: VerificationIssuanceContext,
  input: ConsumeEmailVerificationInput,
): ConsumedApplicantSession {
  return defaultApplicantAccess.consumeEmailVerification(db, context, input);
}

export function resolveApplicantSession(
  db: Db,
  input: ResolveApplicantSessionInput,
): ResolvedApplicantSession {
  return defaultApplicantAccess.resolveApplicantSession(db, input);
}

export function revokeApplicantSession(
  db: Db,
  session: SessionInfo,
  input: RevokeApplicantSessionInput,
) {
  return defaultApplicantAccess.revokeApplicantSession(db, session, input);
}

export function assertApplicantAccess(
  db: Db,
  input: AssertApplicantAccessInput,
): ApplicantAccessGrant {
  return defaultApplicantAccess.assertApplicantAccess(db, input);
}
