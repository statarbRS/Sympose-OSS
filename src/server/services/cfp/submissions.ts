import { Buffer } from "node:buffer";

import { type Db } from "../../db";
import { nowIso, uuid } from "../../canonical";
import {
  CfpApplicantAccessError,
  assertApplicantAccess as assertApplicantAccessSeam,
  resolveApplicantSession as resolveApplicantSessionSeam,
  type ApplicantAccessGrant,
  type AssertApplicantAccessInput,
  type CfpApplicantAccessErrorCode,
  type ResolveApplicantSessionInput,
  type ResolvedApplicantSession,
} from "./applicant-access";
import { FormEvaluationError } from "./form-evaluator";
import { FormDocumentError } from "./form-types";
import {
  FormDocumentPersistenceError,
  createDraftSubmission as createDraftSubmissionSeam,
  readSubmissionRevision as readSubmissionRevisionSeam,
  saveDraftRevision as saveDraftRevisionSeam,
  saveSubmittedAmendment as saveSubmittedAmendmentSeam,
  type ApplicantSessionContext,
  type CreateDraftSubmissionInput,
  type CreatedSubmission,
  type FormDocumentPersistenceErrorCode,
  type SaveDraftRevisionInput,
  type SaveSubmittedAmendmentInput,
  type SavedSubmissionRevision,
  type SubmissionRevision,
} from "./form-documents";
import {
  FormSafetyError,
  sanitizeFormData,
  type JsonSafeObject,
  type JsonSafeValue,
} from "./form-safety";
import {
  CFP_SUBMISSION_CONFIRMATION_CHANNEL,
  queueCfpSubmissionConfirmation,
  type CfpSubmissionConfirmationReceipt,
  type QueueCfpSubmissionConfirmationInput,
} from "./submission-confirmation";

/**
 * Applicant-owned submission commands.
 *
 * This module is a narrow command layer. It owns exactly one transaction boundary per command,
 * resolves the applicant session and authorization through the accepted access seams, and then
 * delegates every durable revision write to the accepted immutable persistence seam. It never
 * derives identity, revision content, fingerprints, receipts, or pins of its own.
 *
 * Withdrawal, invalidation, change requests, co-speakers, review, routing, and provider delivery
 * remain out of scope. Generic draft writes still treat `SUBMITTED` as terminal; the separate
 * amendment command below is the only accepted post-submit revision path.
 */

const IDENTIFIER_MAX_LENGTH = 128;
const TIMESTAMP_MAX_LENGTH = 128;
const OWNED_BOUNDARY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const OWNED_CLEANUP_ATTEMPTS = 3;
const FATAL_COMMAND_MESSAGE = "The CFP submission command cannot continue safely.";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const SESSION_TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const HAS_OWN = Object.prototype.hasOwnProperty;
const INTERNAL_FATAL_ERRORS = new WeakSet<object>();
const INTERNAL_COMMAND_ERRORS = new WeakSet<object>();
const ACCESS_ERROR_CODES = new Set<CfpApplicantAccessErrorCode>([
  "ACCESS_INPUT_INVALID", "CALL_NOT_AVAILABLE", "CALL_NOT_ACCEPTING",
  "VERIFICATION_REQUEST_REJECTED", "VERIFICATION_INVALID", "SESSION_INVALID",
  "CALL_STATE_INVALID", "CALL_STATE_STALE", "EXTENSION_INVALID",
  "EXTENSION_IDEMPOTENCY_CONFLICT", "SESSION_REVOKE_CONFLICT",
  "ACCESS_READ_FAILED", "ACCESS_WRITE_FAILED",
]);
const SUBMISSION_STATES = new Set(["DRAFT", "SUBMITTED", "WITHDRAWN", "INVALIDATED"]);
const PERSISTENCE_ERROR_CODES = new Set<FormDocumentPersistenceErrorCode>([
  "PERSISTENCE_INPUT_INVALID", "WORKSPACE_NOT_FOUND", "CONTEXT_INVALID",
  "FORM_DEFINITION_NOT_FOUND", "FORM_DEFINITION_NAME_INVALID", "RULE_VERSION_NOT_FOUND",
  "RULE_VERSION_NOT_SEALED", "FORM_VERSION_NOT_FOUND", "FORM_VERSION_NOT_SEALED",
  "FORM_ARTIFACT_INVALID", "RULE_ARTIFACT_INVALID", "FORM_ARTIFACT_NOT_CANONICAL",
  "RULE_ARTIFACT_NOT_CANONICAL", "FORM_ARTIFACT_MIRROR_MISMATCH",
  "RULE_ARTIFACT_MIRROR_MISMATCH", "ARTIFACT_ALGORITHM_UNSUPPORTED", "CALL_NOT_FOUND",
  "CALL_POLICY_INVALID", "CALL_POLICY_NOT_CANONICAL", "CALL_POLICY_MIRROR_MISMATCH",
  "CALL_POLICY_STALE", "CALL_FORM_ADVANCE_INVALID", "CALL_FORM_ADVANCE_STALE",
  "SESSION_INVALID", "SESSION_REVOKED", "SESSION_EXPIRED", "SUBMISSION_NOT_FOUND",
  "SUBMISSION_NOT_DRAFT", "SUBMISSION_AMENDMENT_NOT_ALLOWED", "SUBMISSION_PIN_MISMATCH", "SUBMISSION_REVISION_NOT_FOUND",
  "SUBMISSION_REVISION_INVALID", "SUBMISSION_REVISION_NOT_CANONICAL",
  "SUBMISSION_REVISION_MIRROR_MISMATCH", "SUBMISSION_REVISION_JSON_INVALID",
  "SUBMISSION_REVISION_OVERSIZED", "STALE_REVISION", "REVISION_POINTER_INVALID",
  "PERSISTENCE_READ_FAILED", "PERSISTENCE_WRITE_FAILED",
]);

const CREATE_COMMAND_KEYS = ["workspaceId", "callId", "sessionTokenHash"] as const;
const CREATED_SUBMISSION_KEYS = [
  "id",
  "workspaceId",
  "eventId",
  "callId",
  "ownerPersonId",
  "pinnedFormVersionId",
  "pinnedRuleVersionId",
] as const;
const REVISION_COMMAND_KEYS = [
  "workspaceId",
  "callId",
  "sessionTokenHash",
  "submissionId",
  "historicalAnswers",
  "expectedCurrentRevisionId",
] as const;

/**
 * The submit compare-and-set. The owner person identifier comes only from the resolved session and
 * the revision identifier comes only from the immutable revision writer, so a caller can never
 * submit another applicant's draft or an arbitrary revision. The timestamp guard keeps the stored
 * `updated_at` monotonic for the schema's update trigger when the revision writer runs on a clock
 * ahead of this command's clock.
 */
const SUBMIT_CAS_SQL = `UPDATE submissions
   SET state = 'SUBMITTED',
       updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
   WHERE workspace_id = ?
     AND id = ?
     AND call_id = ?
     AND owner_person_id = ?
     AND state = 'DRAFT'
     AND current_revision_id = ?`;

/**
 * The private addressed-submission read. It is never exposed: every caller first collapses rows
 * that are missing, in another call, or owned by another applicant into one answer, so state and
 * pointer truth is only ever reported for a row the resolved session actually owns.
 */
const PRIVATE_SUBMISSION_SQL = `SELECT state, call_id, owner_person_id, current_revision_id
   FROM submissions
   WHERE workspace_id = ?
     AND id = ?
   LIMIT 1`;

/**
 * Enumerate the complete durable create identity, including byte-identical BLOB aliases. SQLite
 * permits a BLOB and TEXT value with the same bytes to coexist under a TEXT primary key, so a
 * TEXT-only equality would turn corrupt legacy truth into a false miss and allow another insert.
 */
const PRIVATE_CREATE_CANDIDATES_SQL = `SELECT
     id, workspace_id, event_id, call_id, owner_person_id, state,
     pinned_form_version_id, pinned_rule_version_id, current_revision_id,
     created_at, updated_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(event_id) AS event_storage,
     typeof(call_id) AS call_storage,
     typeof(owner_person_id) AS owner_storage,
     typeof(state) AS state_storage,
     typeof(pinned_form_version_id) AS pinned_form_storage,
     typeof(pinned_rule_version_id) AS pinned_rule_storage,
     typeof(current_revision_id) AS current_revision_storage,
     typeof(created_at) AS created_at_storage,
     typeof(updated_at) AS updated_at_storage
   FROM submissions
   WHERE (workspace_id = ? OR workspace_id = CAST(? AS BLOB))
     AND (call_id = ? OR call_id = CAST(? AS BLOB))
     AND (owner_person_id = ? OR owner_person_id = CAST(? AS BLOB))
   ORDER BY rowid`;

const PRIVATE_SUBMISSION_IDENTITY_SQL = `SELECT id, typeof(id) AS id_storage
   FROM submissions
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_WORKSPACE_MIRROR_SQL = `SELECT id, created_at,
     typeof(id) AS id_storage, typeof(created_at) AS created_at_storage
   FROM workspaces
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_CALL_MIRROR_SQL = `SELECT id, workspace_id, event_id, form_version_id,
     created_at, updated_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(event_id) AS event_storage,
     typeof(form_version_id) AS form_version_storage,
     typeof(created_at) AS created_at_storage,
     typeof(updated_at) AS updated_at_storage
   FROM calls
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_EVENT_MIRROR_SQL = `SELECT id, workspace_id, created_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(created_at) AS created_at_storage
   FROM events
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_PERSON_MIRROR_SQL = `SELECT id, workspace_id, canonical_email, created_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(canonical_email) AS canonical_email_storage,
     typeof(created_at) AS created_at_storage
   FROM people
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_FORM_MIRROR_SQL = `SELECT id, workspace_id, form_definition_id, rule_version_id,
     version_number, sealed_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(form_definition_id) AS form_definition_storage,
     typeof(rule_version_id) AS rule_version_storage,
     typeof(version_number) AS version_number_storage,
     typeof(sealed_at) AS sealed_at_storage
   FROM form_versions
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_RULE_MIRROR_SQL = `SELECT id, workspace_id, form_definition_id, version_number,
     sealed_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(form_definition_id) AS form_definition_storage,
     typeof(version_number) AS version_number_storage,
     typeof(sealed_at) AS sealed_at_storage
   FROM rule_versions
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_FORM_DEFINITION_MIRROR_SQL = `SELECT id, workspace_id, created_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(created_at) AS created_at_storage
   FROM form_definitions
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_APPLICANT_SESSION_MIRROR_SQL = `SELECT
     id, workspace_id, call_id, person_id, verification_id, token_hash,
     created_at, expires_at, revoked_at, revoked_by, revoked_reason,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(call_id) AS call_storage,
     typeof(person_id) AS person_storage,
     typeof(verification_id) AS verification_storage,
     typeof(token_hash) AS token_hash_storage,
     typeof(created_at) AS created_at_storage,
     typeof(expires_at) AS expires_at_storage,
     typeof(revoked_at) AS revoked_at_storage,
     typeof(revoked_by) AS revoked_by_storage,
     typeof(revoked_reason) AS revoked_reason_storage
   FROM cfp_applicant_sessions
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_VERIFICATION_MIRROR_SQL = `SELECT
     id, workspace_id, call_id, email, token_hash, created_at, expires_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(call_id) AS call_storage,
     typeof(email) AS email_storage,
     typeof(token_hash) AS token_hash_storage,
     typeof(created_at) AS created_at_storage,
     typeof(expires_at) AS expires_at_storage
   FROM cfp_email_verifications
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_CONSUMPTIONS_BY_VERIFICATION_SQL = `SELECT
     id, workspace_id, verification_id, person_id, consumed_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(verification_id) AS verification_storage,
     typeof(person_id) AS person_storage,
     typeof(consumed_at) AS consumed_at_storage
   FROM cfp_email_verification_consumptions
   WHERE verification_id = ? OR verification_id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_CONSUMPTION_IDENTITY_SQL = `SELECT
     id, workspace_id, verification_id, person_id, consumed_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(verification_id) AS verification_storage,
     typeof(person_id) AS person_storage,
     typeof(consumed_at) AS consumed_at_storage
   FROM cfp_email_verification_consumptions
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_SESSIONS_BY_VERIFICATION_SQL = `SELECT
     id, workspace_id, call_id, person_id, verification_id, token_hash,
     created_at, expires_at, revoked_at, revoked_by, revoked_reason,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(call_id) AS call_storage,
     typeof(person_id) AS person_storage,
     typeof(verification_id) AS verification_storage,
     typeof(token_hash) AS token_hash_storage,
     typeof(created_at) AS created_at_storage,
     typeof(expires_at) AS expires_at_storage,
     typeof(revoked_at) AS revoked_at_storage,
     typeof(revoked_by) AS revoked_by_storage,
     typeof(revoked_reason) AS revoked_reason_storage
   FROM cfp_applicant_sessions
   WHERE verification_id = ? OR verification_id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_SESSION_DIGEST_SQL = `SELECT id, token_hash,
     typeof(id) AS id_storage, typeof(token_hash) AS token_hash_storage
   FROM cfp_applicant_sessions
   WHERE lower(CAST(token_hash AS TEXT)) = ?
   ORDER BY rowid`;

const PRIVATE_ACCOUNT_MIRROR_SQL = `SELECT id, workspace_id,
     typeof(id) AS id_storage, typeof(workspace_id) AS workspace_storage
   FROM accounts
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_CREATE_REVISIONS_SQL = `SELECT
     id, workspace_id, submission_id, revision_number, revision_schema, revision_json,
     form_version_id, rule_version_id, form_document_schema, form_document_fingerprint,
     policy_schema, policy_version_id, policy_fingerprint_algorithm, policy_fingerprint,
     consent_receipt_schema, consent_receipt_policy_fingerprint,
     session_id, person_id, fingerprint_algorithm, fingerprint, created_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(submission_id) AS submission_storage,
     typeof(revision_number) AS revision_number_storage,
     typeof(revision_schema) AS revision_schema_storage,
     typeof(revision_json) AS revision_json_storage,
     typeof(form_version_id) AS form_version_storage,
     typeof(rule_version_id) AS rule_version_storage,
     typeof(form_document_schema) AS form_document_schema_storage,
     typeof(form_document_fingerprint) AS form_document_fingerprint_storage,
     typeof(policy_schema) AS policy_schema_storage,
     typeof(policy_version_id) AS policy_version_storage,
     typeof(policy_fingerprint_algorithm) AS policy_fingerprint_algorithm_storage,
     typeof(policy_fingerprint) AS policy_fingerprint_storage,
     typeof(consent_receipt_schema) AS consent_receipt_schema_storage,
     typeof(consent_receipt_policy_fingerprint) AS consent_receipt_policy_fingerprint_storage,
     typeof(session_id) AS session_storage,
     typeof(person_id) AS person_storage,
     typeof(fingerprint_algorithm) AS fingerprint_algorithm_storage,
     typeof(fingerprint) AS fingerprint_storage,
     typeof(created_at) AS created_at_storage
   FROM submission_revisions
   WHERE submission_id = ? OR submission_id = CAST(? AS BLOB)
   ORDER BY rowid`;

const PRIVATE_REVISION_IDENTITY_SQL = `SELECT
     id, workspace_id, submission_id, revision_number, revision_schema, revision_json,
     form_version_id, rule_version_id, form_document_schema, form_document_fingerprint,
     policy_schema, policy_version_id, policy_fingerprint_algorithm, policy_fingerprint,
     consent_receipt_schema, consent_receipt_policy_fingerprint,
     session_id, person_id, fingerprint_algorithm, fingerprint, created_at,
     typeof(id) AS id_storage,
     typeof(workspace_id) AS workspace_storage,
     typeof(submission_id) AS submission_storage,
     typeof(revision_number) AS revision_number_storage,
     typeof(revision_schema) AS revision_schema_storage,
     typeof(revision_json) AS revision_json_storage,
     typeof(form_version_id) AS form_version_storage,
     typeof(rule_version_id) AS rule_version_storage,
     typeof(form_document_schema) AS form_document_schema_storage,
     typeof(form_document_fingerprint) AS form_document_fingerprint_storage,
     typeof(policy_schema) AS policy_schema_storage,
     typeof(policy_version_id) AS policy_version_storage,
     typeof(policy_fingerprint_algorithm) AS policy_fingerprint_algorithm_storage,
     typeof(policy_fingerprint) AS policy_fingerprint_storage,
     typeof(consent_receipt_schema) AS consent_receipt_schema_storage,
     typeof(consent_receipt_policy_fingerprint) AS consent_receipt_policy_fingerprint_storage,
     typeof(session_id) AS session_storage,
     typeof(person_id) AS person_storage,
     typeof(fingerprint_algorithm) AS fingerprint_algorithm_storage,
     typeof(fingerprint) AS fingerprint_storage,
     typeof(created_at) AS created_at_storage
   FROM submission_revisions
   WHERE id = ? OR id = CAST(? AS BLOB)
   ORDER BY rowid`;

export interface ApplicantCommandIdentity {
  readonly workspaceId: string;
  readonly callId: string;
  /** The stored digest of the applicant session token. A raw token never crosses this boundary. */
  readonly sessionTokenHash: string;
}

export interface CreateSubmissionDraftInput extends ApplicantCommandIdentity {}

export interface SaveSubmissionDraftInput extends ApplicantCommandIdentity {
  readonly submissionId: string;
  readonly historicalAnswers: unknown;
  readonly expectedCurrentRevisionId: string | null;
}

export interface SubmitSubmissionInput extends ApplicantCommandIdentity {
  readonly submissionId: string;
  readonly historicalAnswers: unknown;
  readonly expectedCurrentRevisionId: string | null;
}

export interface AmendSubmittedSubmissionInput extends ApplicantCommandIdentity {
  readonly submissionId: string;
  readonly historicalAnswers: unknown;
  readonly expectedCurrentRevisionId: string;
}

export interface SubmittedSubmission {
  readonly submissionId: string;
  readonly revisionId: string;
  readonly submittedAt: string;
}

const COMMAND_ERROR_MESSAGES = {
  COMMAND_INPUT_INVALID: "The CFP submission command input is invalid.",
  SUBMISSION_NOT_FOUND: "The CFP submission was not found.",
  SUBMISSION_NOT_DRAFT: "The CFP submission is not a draft.",
  SUBMISSION_STALE: "The CFP submission revision is stale.",
  SUBMISSION_INCOMPLETE: "The CFP submission is incomplete.",
  SUBMISSION_WRITE_FAILED: "The CFP submission write failed.",
} as const;

export type CfpSubmissionCommandErrorCode = keyof typeof COMMAND_ERROR_MESSAGES;

export class CfpSubmissionCommandError extends Error {
  readonly code: CfpSubmissionCommandErrorCode;

  constructor(code: CfpSubmissionCommandErrorCode) {
    super(COMMAND_ERROR_MESSAGES[code]);
    this.name = "CfpSubmissionCommandError";
    this.code = code;
  }
}

/** Raised when cleanup succeeded but faulted on the way; outwardly this is an opaque write fault. */
class OwnedCommandBoundaryError extends Error {
  constructor() {
    super("The owned CFP submission command boundary could not be cleaned up.");
    this.name = "OwnedCommandBoundaryError";
  }
}

/**
 * Signals that the command cannot prove its durable outcome or its owned boundary safe. Callers
 * must stop using the connection and must not commit it. This deliberately escapes the ordinary
 * command-error mapping: reporting a normal write failure would falsely imply that the command's
 * mutation was rolled back.
 */
export class CfpSubmissionCommandFatalError extends Error {
  readonly fatal = true;

  constructor() {
    super(FATAL_COMMAND_MESSAGE);
    this.name = "CfpSubmissionCommandFatalError";
  }
}

/** Only module-created instances carry the provenance required to cross the outward boundary. */
function internalFatalError(): CfpSubmissionCommandFatalError {
  const error = new CfpSubmissionCommandFatalError();
  INTERNAL_FATAL_ERRORS.add(error);
  return Object.freeze(error);
}

function isInternalFatalError(error: unknown): error is CfpSubmissionCommandFatalError {
  return typeof error === "object" && error !== null && INTERNAL_FATAL_ERRORS.has(error);
}

function transactionIsOpen(db: Db): boolean {
  try {
    const state = db.isTransaction;
    if (typeof state !== "boolean") throw new Error("invalid transaction state");
    return state;
  } catch (error) {
    if (isInternalFatalError(error)) throw error;
    throw internalFatalError();
  }
}

function requireOwnedBoundaryName(name: string): void {
  if (!OWNED_BOUNDARY_NAME_PATTERN.test(name)) {
    throw new OwnedCommandBoundaryError();
  }
}

/**
 * SQLite resolves a duplicate savepoint name to the most recent matching boundary, so ownership is
 * part of the name: recovery can never fall through to a caller savepoint that happens to use this
 * command's base name, nor to another composition of the same command.
 */
function ownedSavepointName(baseName: string): string {
  requireOwnedBoundaryName(baseName);
  const ownedName = `${baseName}_${uuid().replaceAll("-", "")}`;
  requireOwnedBoundaryName(ownedName);
  return ownedName;
}

/**
 * The accepted persistence writers compose through fixed savepoint names. Rewrite those exact
 * control statements to a per-invocation name so a silently skipped inner SAVEPOINT can never make
 * a later RELEASE fall through to a caller-owned savepoint of the same public name.
 */
function scopeNestedWriterSavepoint(db: Db, fixedName: string): Db {
  requireOwnedBoundaryName(fixedName);
  const scopedName = ownedSavepointName(fixedName);
  const controls = new Map<string, string>([
    [`SAVEPOINT "${fixedName}"`, `SAVEPOINT "${scopedName}"`],
    [
      `ROLLBACK TO SAVEPOINT "${fixedName}"`,
      `ROLLBACK TO SAVEPOINT "${scopedName}"`,
    ],
    [`RELEASE SAVEPOINT "${fixedName}"`, `RELEASE SAVEPOINT "${scopedName}"`],
  ]);
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          target.exec(controls.get(sql.trim()) ?? sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function isMissingOwnedSavepoint(error: unknown, name: string): boolean {
  try {
    if (!(error instanceof Error)) return false;
    const driverError = error as Error & { readonly code?: unknown };
    return (
      driverError.code === "ERR_SQLITE_ERROR" &&
      driverError.message === `no such savepoint: ${name}`
    );
  } catch {
    return false;
  }
}

type TransactionControlMethod = "exec" | "prepare";

type OwnedSavepointControlAttempt = {
  readonly status: "failed" | "missing" | "returned";
};

type OwnedRollbackMarker = {
  readonly name: string;
  readonly proof: string;
};

function isMissingOwnedRollbackMarker(error: unknown, name: string): boolean {
  try {
    if (!(error instanceof Error)) return false;
    const driverError = error as Error & { readonly code?: unknown };
    return driverError.code === "ERR_SQLITE_ERROR" && driverError.message === `no such table: ${name}`;
  } catch {
    return false;
  }
}

function ownedRollbackMarker(): OwnedRollbackMarker {
  const name = `cfp_rollback_proof_${uuid().replaceAll("-", "")}`;
  requireOwnedBoundaryName(name);
  return Object.freeze({ name, proof: uuid() });
}

function attemptOwnedSavepointControl(
  db: Db,
  method: TransactionControlMethod,
  sql: string,
  name: string,
): OwnedSavepointControlAttempt {
  if (!transactionIsOpen(db)) {
    throw internalFatalError();
  }

  let failure: unknown;
  try {
    if (method === "exec") {
      db.exec(sql);
    } else {
      db.prepare(sql).run();
    }
  } catch (error) {
    failure = error;
  }

  // Savepoint control belongs inside a caller transaction. Losing that transaction can also lose
  // unrelated caller work, so it is never converted into an ordinary rollback-looking failure.
  if (!transactionIsOpen(db)) {
    throw internalFatalError();
  }
  if (failure === undefined) {
    return { status: "returned" };
  }
  return { status: isMissingOwnedSavepoint(failure, name) ? "missing" : "failed" };
}

function readOwnedRollbackMarker(db: Db, marker: OwnedRollbackMarker): "missing" | "present" {
  try {
    const rows = db.prepare(`SELECT proof FROM "${marker.name}"`).all() as Array<{
      readonly proof?: unknown;
    }>;
    if (rows.length !== 1 || rows[0]?.proof !== marker.proof) {
      throw internalFatalError();
    }
    return "present";
  } catch (error) {
    if (isInternalFatalError(error)) throw error;
    if (isMissingOwnedRollbackMarker(error, marker.name)) return "missing";
    throw internalFatalError();
  }
}

function placeOwnedRollbackMarker(db: Db, marker: OwnedRollbackMarker): void {
  try {
    db.exec(`CREATE TEMP TABLE "${marker.name}" (proof TEXT PRIMARY KEY) WITHOUT ROWID`);
    db.prepare(`INSERT INTO "${marker.name}" (proof) VALUES (?)`).run(marker.proof);
  } catch {
    throw internalFatalError();
  }
  if (!transactionIsOpen(db) || readOwnedRollbackMarker(db, marker) !== "present") {
    throw internalFatalError();
  }
}

/** Remove a released or never-owned marker without trusting a nonthrowing driver call. */
function removeOwnedRollbackMarker(db: Db, marker: OwnedRollbackMarker): void {
  const sql = `DROP TABLE "${marker.name}"`;
  for (const method of ["exec", "prepare"] as const) {
    for (let attempt = 0; attempt < OWNED_CLEANUP_ATTEMPTS; attempt += 1) {
      if (!transactionIsOpen(db)) throw internalFatalError();
      try {
        if (method === "exec") {
          db.exec(sql);
        } else {
          db.prepare(sql).run();
        }
      } catch {
        // The marker read below, rather than a return or throw, determines whether cleanup worked.
      }
      if (!transactionIsOpen(db)) throw internalFatalError();
      if (readOwnedRollbackMarker(db, marker) === "missing") return;
    }
  }
  throw internalFatalError();
}

type OwnedSavepointRollbackResult = {
  readonly cleanupFaulted: boolean;
  readonly status: "missing" | "rolledBack";
};

/**
 * Roll back to an owned savepoint and require command-owned evidence of that rollback. The marker
 * table was created inside the savepoint, so only an actual rollback makes it disappear. A
 * successful return with the marker still present is a fault and falls through to the independent
 * prepared-statement path; it is never followed by RELEASE.
 */
function rollbackToOwnedSavepoint(
  db: Db,
  boundaryName: string,
  marker: OwnedRollbackMarker,
  allowMissing: boolean,
): OwnedSavepointRollbackResult {
  requireOwnedBoundaryName(boundaryName);
  if (readOwnedRollbackMarker(db, marker) !== "present") {
    throw internalFatalError();
  }

  const sql = `ROLLBACK TO SAVEPOINT "${boundaryName}"`;
  let cleanupFaulted = false;

  for (const method of ["exec", "prepare"] as const) {
    for (let attempt = 0; attempt < OWNED_CLEANUP_ATTEMPTS; attempt += 1) {
      const outcome = attemptOwnedSavepointControl(db, method, sql, boundaryName);
      if (readOwnedRollbackMarker(db, marker) === "missing") {
        return {
          cleanupFaulted: cleanupFaulted || outcome.status !== "returned",
          status: "rolledBack",
        };
      }
      if (allowMissing && outcome.status === "missing") {
        // One genuine SQLite missing-savepoint result proves absence. Requiring the other entry
        // point to repeat it would turn one healthy path plus one silent path into a false fatal.
        return { cleanupFaulted, status: "missing" };
      }
      cleanupFaulted = true;
    }
  }

  throw internalFatalError();
}

type OwnedSavepointCleanupResult = {
  readonly cleanupFaulted: boolean;
  readonly status: "cleaned" | "missing";
};

/**
 * Finish removing a savepoint whose command mutation is already proven rolled back. A return from
 * RELEASE is not proof: the exact missing-savepoint result from a later independent call is. No
 * ROLLBACK probe is needed here, so a silent release can never resurrect or preserve a mutation.
 */
function proveOwnedSavepointReleased(db: Db, boundaryName: string): boolean {
  requireOwnedBoundaryName(boundaryName);
  const sql = `RELEASE SAVEPOINT "${boundaryName}"`;
  let cleanupFaulted = false;

  for (const method of ["exec", "prepare"] as const) {
    for (let attempt = 0; attempt < OWNED_CLEANUP_ATTEMPTS; attempt += 1) {
      const outcome = attemptOwnedSavepointControl(db, method, sql, boundaryName);
      if (outcome.status === "missing") return cleanupFaulted;
      cleanupFaulted ||= outcome.status === "failed";
    }
  }
  throw internalFatalError();
}

/** Roll back and remove exactly this command's savepoint, never the caller's transaction. */
function rollbackAndReleaseOwnedSavepoint(
  db: Db,
  boundaryName: string,
  allowMissing = false,
): OwnedSavepointCleanupResult {
  requireOwnedBoundaryName(boundaryName);
  const marker = ownedRollbackMarker();
  placeOwnedRollbackMarker(db, marker);

  const rollback = rollbackToOwnedSavepoint(db, boundaryName, marker, allowMissing);
  if (rollback.status === "missing") {
    // This status is permitted only while recovering a SAVEPOINT call before the writer ran. The
    // marker was therefore placed directly in the caller transaction and must be removed there.
    removeOwnedRollbackMarker(db, marker);
    return { cleanupFaulted: true, status: "missing" };
  }

  // The marker table was created after the command mutation inside the owned savepoint. Its
  // verified disappearance is deterministic evidence that ROLLBACK TO really delegated. Only now
  // is it safe to release the boundary.
  const releaseFaulted = proveOwnedSavepointReleased(db, boundaryName);
  return {
    cleanupFaulted: rollback.cleanupFaulted || releaseFaulted,
    status: "cleaned",
  };
}

/** Prove a nonthrowing SAVEPOINT actually delegated before any dependency or writer can run. */
function proveOwnedSavepointEstablished(db: Db, boundaryName: string): boolean {
  requireOwnedBoundaryName(boundaryName);
  const marker = ownedRollbackMarker();
  placeOwnedRollbackMarker(db, marker);
  const proof = rollbackToOwnedSavepoint(db, boundaryName, marker, true);
  if (proof.status === "rolledBack") {
    // ROLLBACK TO removed the marker and deliberately left the verified savepoint open.
    return true;
  }

  // SAVEPOINT returned without delegating. The marker belongs directly to the caller transaction,
  // so remove it before reporting a normal pre-writer boundary failure.
  removeOwnedRollbackMarker(db, marker);
  return false;
}

type SuccessfulSavepointReleaseResult = {
  readonly status: "released" | "rolledBack";
};

/**
 * Release a successful command truthfully. A witness created after the writer distinguishes an
 * actual release (the witness survives in the caller transaction) from a silent release followed
 * by the proof probe (ROLLBACK TO removes the witness and the command mutation together).
 */
function releaseSuccessfulOwnedSavepoint(
  db: Db,
  boundaryName: string,
): SuccessfulSavepointReleaseResult {
  requireOwnedBoundaryName(boundaryName);
  const marker = ownedRollbackMarker();
  placeOwnedRollbackMarker(db, marker);

  // This is deliberately a single initial attempt. If it faults before delegation, the witness
  // probe below rolls the command back; if it faults after delegation, the probe proves absence and
  // the already-completed command remains truthful success.
  attemptOwnedSavepointControl(
    db,
    "exec",
    `RELEASE SAVEPOINT "${boundaryName}"`,
    boundaryName,
  );

  const proof = rollbackToOwnedSavepoint(db, boundaryName, marker, true);
  if (proof.status === "missing") {
    // RELEASE preserved the witness by moving it into the caller transaction. Remove that internal
    // evidence through a separately verified path before returning success.
    removeOwnedRollbackMarker(db, marker);
    return { status: "released" };
  }

  // A ROLLBACK TO probe removed the witness, which also proves that it removed the command's
  // mutation. Finish removing the still-open savepoint before reporting an ordinary write fault.
  proveOwnedSavepointReleased(db, boundaryName);
  return { status: "rolledBack" };
}

/**
 * Roll back this command's own top-level transaction. Cleanup is bounded and verified through the
 * driver's transaction state rather than through the return of a single statement, because a
 * wrapper can fault before or after SQLite has acted. Returns whether cleanup faulted at all;
 * throws when the transaction is still open after the bounded attempts.
 */
function rollbackOwnedTransaction(db: Db): boolean {
  let cleanupFaulted = false;

  for (const method of ["exec", "prepare"] as const) {
    for (let attempt = 0; attempt < OWNED_CLEANUP_ATTEMPTS; attempt += 1) {
      if (!transactionIsOpen(db)) return cleanupFaulted;
      try {
        if (method === "exec") {
          db.exec("ROLLBACK");
        } else {
          db.prepare("ROLLBACK").run();
        }
      } catch {
        cleanupFaulted = true;
      }
      if (!transactionIsOpen(db)) return cleanupFaulted;

      // A transaction-control wrapper that returns without changing state is also a cleanup fault.
      cleanupFaulted = true;
    }
  }
  if (transactionIsOpen(db)) {
    throw internalFatalError();
  }
  return cleanupFaulted;
}

function withOwnedTransaction<T>(db: Db, run: () => T): T {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    // A wrapper can fault after SQLite has already opened the transaction.
    if (transactionIsOpen(db) && rollbackOwnedTransaction(db)) {
      throw new OwnedCommandBoundaryError();
    }
    throw error;
  }

  // A nonthrowing call is not proof that BEGIN delegated. This function was selected only while
  // the connection was outside a transaction, so the open state proves ownership before any
  // resolver, access check, clock, or writer is invoked.
  if (!transactionIsOpen(db)) {
    throw new OwnedCommandBoundaryError();
  }

  let result: T;
  try {
    result = run();
  } catch (error) {
    if (!transactionIsOpen(db)) {
      // A dependency that made the owned transaction disappear can also have made its mutation
      // durable. There is no honest ordinary rollback result left to report.
      throw internalFatalError();
    }
    if (rollbackOwnedTransaction(db)) {
      throw new OwnedCommandBoundaryError();
    }
    throw error;
  }

  if (!transactionIsOpen(db)) {
    throw internalFatalError();
  }

  try {
    db.exec("COMMIT");
  } catch (error) {
    if (!transactionIsOpen(db)) {
      // Once a throwing COMMIT has ended the transaction, neither durable commit nor rollback is
      // provable. Returning the in-memory result would fabricate a success receipt.
      throw internalFatalError();
    }
    // A real COMMIT failure leaves the transaction active and therefore still committable.
    if (rollbackOwnedTransaction(db)) {
      throw new OwnedCommandBoundaryError();
    }
    throw error;
  }

  if (!transactionIsOpen(db)) return result;

  // A nonthrowing COMMIT is no more authoritative than a nonthrowing BEGIN. Its still-open state
  // proves the mutation is not durable, so roll it back before reporting an ordinary write fault.
  if (rollbackOwnedTransaction(db)) {
    throw new OwnedCommandBoundaryError();
  }
  throw new OwnedCommandBoundaryError();
}

function withOwnedSavepoint<T>(db: Db, name: string, run: () => T): T {
  const ownedName = ownedSavepointName(name);
  try {
    db.exec(`SAVEPOINT "${ownedName}"`);
  } catch (error) {
    if (rollbackAndReleaseOwnedSavepoint(db, ownedName, true).cleanupFaulted) {
      throw new OwnedCommandBoundaryError();
    }
    throw error;
  }

  if (!proveOwnedSavepointEstablished(db, ownedName)) {
    throw new OwnedCommandBoundaryError();
  }

  let result: T;
  try {
    result = run();
  } catch (error) {
    if (rollbackAndReleaseOwnedSavepoint(db, ownedName).cleanupFaulted) {
      throw new OwnedCommandBoundaryError();
    }
    throw error;
  }

  const release = releaseSuccessfulOwnedSavepoint(db, ownedName);
  if (release.status === "released") return result;

  // The release call returned without delegating (or faulted before delegation), and the witness
  // probe proved that the command mutation was rolled back before the boundary was removed.
  throw new OwnedCommandBoundaryError();
}

/**
 * The command ownership boundary. The generic database helper is deliberately not used here: it
 * suppresses rollback and savepoint cleanup faults and cannot tell a delegate-then-throw
 * COMMIT/RELEASE from a real one, which would let a command report failure while its mutation is
 * durable or still committable by the caller.
 */
function withOwnedTransactionOrSavepoint<T>(db: Db, name: string, run: () => T): T {
  requireOwnedBoundaryName(name);
  return transactionIsOpen(db) ? withOwnedSavepoint(db, name, run) : withOwnedTransaction(db, run);
}

/**
 * Trusted seams. These exist so focused tests can shift the clock and substitute the accepted
 * access and persistence functions. A domain caller cannot reach them, and no option can supply
 * identity, identifiers, effective answers, revision numbers, receipts, state, pins, or SQL.
 */
export interface CfpSubmissionCommandOptions {
  readonly clock?: () => string;
  readonly resolveApplicantSession?: (
    db: Db,
    input: ResolveApplicantSessionInput,
  ) => ResolvedApplicantSession;
  readonly assertApplicantAccess?: (
    db: Db,
    input: AssertApplicantAccessInput,
  ) => ApplicantAccessGrant;
  readonly createDraftSubmission?: (
    db: Db,
    context: ApplicantSessionContext,
    input: CreateDraftSubmissionInput,
  ) => CreatedSubmission;
  readonly saveDraftRevision?: (
    db: Db,
    context: ApplicantSessionContext,
    input: SaveDraftRevisionInput,
  ) => SavedSubmissionRevision;
  readonly saveSubmittedAmendment?: (
    db: Db,
    context: ApplicantSessionContext,
    input: SaveSubmittedAmendmentInput,
  ) => SavedSubmissionRevision;
  readonly queueSubmissionConfirmation?: (
    db: Db,
    input: QueueCfpSubmissionConfirmationInput,
  ) => CfpSubmissionConfirmationReceipt;
}

export interface CfpSubmissionCommands {
  createSubmissionDraft(db: Db, input: CreateSubmissionDraftInput): CreatedSubmission;
  saveSubmissionDraft(db: Db, input: SaveSubmissionDraftInput): SavedSubmissionRevision;
  amendSubmittedSubmission(db: Db, input: AmendSubmittedSubmissionInput): SavedSubmissionRevision;
  submitSubmission(db: Db, input: SubmitSubmissionInput): SubmittedSubmission;
}

type Dependencies = {
  readonly now: () => string;
  readonly resolveApplicantSession: (
    db: Db,
    input: ResolveApplicantSessionInput,
  ) => ResolvedApplicantSession;
  readonly assertApplicantAccess: (
    db: Db,
    input: AssertApplicantAccessInput,
  ) => ApplicantAccessGrant;
  readonly createDraftSubmission: (
    db: Db,
    context: ApplicantSessionContext,
    input: CreateDraftSubmissionInput,
  ) => CreatedSubmission;
  readonly saveDraftRevision: (
    db: Db,
    context: ApplicantSessionContext,
    input: SaveDraftRevisionInput,
  ) => SavedSubmissionRevision;
  readonly saveSubmittedAmendment: (
    db: Db,
    context: ApplicantSessionContext,
    input: SaveSubmittedAmendmentInput,
  ) => SavedSubmissionRevision;
  readonly queueSubmissionConfirmation: (
    db: Db,
    input: QueueCfpSubmissionConfirmationInput,
  ) => CfpSubmissionConfirmationReceipt;
};

type CommandIdentity = {
  readonly workspaceId: string;
  readonly callId: string;
  readonly sessionTokenHash: string;
};

type RevisionCommand = CommandIdentity & {
  readonly submissionId: string;
  readonly historicalAnswers: JsonSafeValue;
  readonly expectedCurrentRevisionId: string | null;
};

type TrustedApplicant = {
  readonly context: ApplicantSessionContext;
  readonly personId: string;
};

type SavedRevisionFacts = {
  readonly revisionId: string;
  readonly consentReceiptPresent: boolean;
  readonly revision: SubmissionRevision;
};

type PrivateSubmissionRow = {
  readonly state: unknown;
  readonly call_id: unknown;
  readonly owner_person_id: unknown;
  readonly current_revision_id: unknown;
};

function commandError(code: CfpSubmissionCommandErrorCode): CfpSubmissionCommandError {
  const error = new CfpSubmissionCommandError(code);
  INTERNAL_COMMAND_ERRORS.add(error);
  return error;
}

function publicCommandError(code: CfpSubmissionCommandErrorCode): CfpSubmissionCommandError {
  return Object.freeze(new CfpSubmissionCommandError(code));
}

function accessErrorCode(error: CfpApplicantAccessError): CfpApplicantAccessErrorCode | null {
  try {
    const code = error.code;
    return ACCESS_ERROR_CODES.has(code) ? code : null;
  } catch {
    return null;
  }
}

function persistenceErrorCode(
  error: FormDocumentPersistenceError,
): FormDocumentPersistenceErrorCode | null {
  try {
    const code = error.code;
    return PERSISTENCE_ERROR_CODES.has(code) ? code : null;
  } catch {
    return null;
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isJsonSafeObject(value: JsonSafeValue): value is JsonSafeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCommandId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IDENTIFIER_MAX_LENGTH &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !hasUnpairedSurrogate(value)
  );
}

function requireCommandId(value: unknown): string {
  if (!isCommandId(value)) {
    throw commandError("COMMAND_INPUT_INVALID");
  }
  return value;
}

function requireSessionTokenDigest(value: unknown): string {
  if (typeof value !== "string" || !SESSION_TOKEN_DIGEST_PATTERN.test(value)) {
    throw commandError("COMMAND_INPUT_INVALID");
  }
  return value;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > TIMESTAMP_MAX_LENGTH) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** A replaced clock is trusted to be a clock, not to be well behaved. */
function requireTrustedTimestamp(value: unknown): string {
  if (!isIsoInstant(value)) {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  return value;
}

function snapshotBoundary<T>(snapshot: () => T): T {
  try {
    return snapshot();
  } catch {
    // Caller input is an untrusted boundary. A getter or a proxy trap can throw any value,
    // including an impersonated module error carrying a chosen public code, so an exception
    // raised while snapshotting caller input is never preserved.
    throw commandError("COMMAND_INPUT_INVALID");
  }
}

/**
 * Take the single snapshot of one public input. `sanitizeFormData` refuses proxies, accessors,
 * symbol keys, non-plain prototypes, and cycles without ever invoking caller code, so the command
 * body reads plain frozen data that cannot change between checks and use.
 */
function snapshotInput(input: unknown, keys: readonly string[]): JsonSafeObject {
  const safe = sanitizeFormData(input);
  if (!isJsonSafeObject(safe)) {
    throw commandError("COMMAND_INPUT_INVALID");
  }
  const present = Object.keys(safe);
  if (present.length !== keys.length || !keys.every((key) => HAS_OWN.call(safe, key))) {
    throw commandError("COMMAND_INPUT_INVALID");
  }
  return safe;
}

function snapshotIdentity(safe: JsonSafeObject): CommandIdentity {
  return Object.freeze({
    workspaceId: requireCommandId(safe.workspaceId),
    callId: requireCommandId(safe.callId),
    sessionTokenHash: requireSessionTokenDigest(safe.sessionTokenHash),
  });
}

function snapshotCreateCommand(input: unknown): CommandIdentity {
  return snapshotBoundary(() => snapshotIdentity(snapshotInput(input, CREATE_COMMAND_KEYS)));
}

function snapshotRevisionCommand(input: unknown): RevisionCommand {
  return snapshotBoundary(() => {
    const safe = snapshotInput(input, REVISION_COMMAND_KEYS);
    const expected = safe.expectedCurrentRevisionId;
    return Object.freeze({
      ...snapshotIdentity(safe),
      submissionId: requireCommandId(safe.submissionId),
      historicalAnswers: safe.historicalAnswers,
      expectedCurrentRevisionId: expected === null ? null : requireCommandId(expected),
    });
  });
}

/**
 * Accept a resolved session only when it still describes the requested workspace and call. A
 * substituted dependency that answers with incoherent identity fails closed instead of widening
 * the tenant or call scope of the write that follows.
 */
function trustedApplicantFrom(resolved: unknown, identity: CommandIdentity): TrustedApplicant {
  if (resolved === null || typeof resolved !== "object") {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  const session = resolved as {
    readonly context?: unknown;
    readonly personId?: unknown;
    readonly callId?: unknown;
  };
  const context = session.context;
  if (context === null || typeof context !== "object") {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  const scope = context as { readonly workspaceId?: unknown; readonly sessionId?: unknown };
  const workspaceId = scope.workspaceId;
  const sessionId = scope.sessionId;
  const personId = session.personId;
  if (
    !isCommandId(workspaceId) ||
    !isCommandId(sessionId) ||
    !isCommandId(personId) ||
    workspaceId !== identity.workspaceId ||
    session.callId !== identity.callId
  ) {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  return Object.freeze({
    context: Object.freeze({ workspaceId, sessionId }),
    personId,
  });
}

function requireAccessGrant(grant: unknown): void {
  if (grant === null || typeof grant !== "object") {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  if ((grant as { readonly allowed?: unknown }).allowed !== true) {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
}

function authorize(
  db: Db,
  deps: Dependencies,
  identity: CommandIdentity,
  action: AssertApplicantAccessInput["action"],
): TrustedApplicant {
  const applicant = trustedApplicantFrom(
    deps.resolveApplicantSession(db, {
      workspaceId: identity.workspaceId,
      callId: identity.callId,
      sessionTokenHash: identity.sessionTokenHash,
    }),
    identity,
  );
  requireAccessGrant(deps.assertApplicantAccess(db, { action, context: applicant.context }));
  return applicant;
}

type StoredRow = Readonly<Record<string, unknown>>;

type StoredFormFacts = {
  readonly id: string;
  readonly definitionId: string;
  readonly ruleId: string;
  readonly versionNumber: number;
  readonly sealedAt: string;
};

type StoredRuleFacts = {
  readonly id: string;
  readonly definitionId: string;
  readonly versionNumber: number;
  readonly sealedAt: string;
};

type StoredRevisionFacts = {
  readonly id: string;
  readonly revisionNumber: number;
  readonly createdAt: string;
  readonly consentReceiptPresent: boolean;
};

function createReplayFailure(): never {
  throw commandError("SUBMISSION_WRITE_FAILED");
}

function requireStoredTextIdentifier(
  row: StoredRow,
  valueKey: string,
  storageKey: string,
): string {
  const value = row[valueKey];
  if (row[storageKey] !== "text" || !isCommandId(value)) {
    return createReplayFailure();
  }
  return value;
}

function requireStoredText(
  row: StoredRow,
  valueKey: string,
  storageKey: string,
  maxBytes = 4 * 1024 * 1024,
): string {
  const value = row[valueKey];
  if (
    row[storageKey] !== "text" ||
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    return createReplayFailure();
  }
  return value;
}

function requireStoredDigest(row: StoredRow, valueKey: string, storageKey: string): string {
  const value = requireStoredText(row, valueKey, storageKey, 64);
  if (!SESSION_TOKEN_DIGEST_PATTERN.test(value)) {
    return createReplayFailure();
  }
  return value;
}

function requireStoredCanonicalEmail(
  row: StoredRow,
  valueKey: string,
  storageKey: string,
): string {
  const value = requireStoredText(row, valueKey, storageKey, 320);
  const normalized = value.trim().toLowerCase().normalize("NFC");
  const atIndex = normalized.indexOf("@");
  if (
    normalized !== value ||
    normalized.includes("\uFFFD") ||
    /[\s\u0000-\u001F\u007F-\u009F]/u.test(normalized) ||
    hasUnpairedSurrogate(normalized) ||
    atIndex <= 0 ||
    atIndex === normalized.length - 1 ||
    normalized.indexOf("@", atIndex + 1) !== -1
  ) {
    return createReplayFailure();
  }
  return normalized;
}

function requireStoredFingerprint(row: StoredRow, valueKey: string, storageKey: string): string {
  const value = requireStoredText(row, valueKey, storageKey, 64);
  if (!FINGERPRINT_PATTERN.test(value)) {
    return createReplayFailure();
  }
  return value;
}

function requireStoredNull(row: StoredRow, valueKey: string, storageKey: string): void {
  if (row[valueKey] !== null || row[storageKey] !== "null") {
    createReplayFailure();
  }
}

function requireStoredInstant(
  row: StoredRow,
  valueKey: string,
  storageKey: string,
): string {
  const value = row[valueKey];
  if (row[storageKey] !== "text" || !isIsoInstant(value)) {
    return createReplayFailure();
  }
  return value;
}

function requireStoredPositiveInteger(
  row: StoredRow,
  valueKey: string,
  storageKey: string,
): number {
  const value = row[valueKey];
  if (
    row[storageKey] !== "integer" ||
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return createReplayFailure();
  }
  return value;
}

function requireCreatedNoLaterThan(createdAt: string, boundaryAt: string): void {
  if (Date.parse(createdAt) > Date.parse(boundaryAt)) {
    createReplayFailure();
  }
}

function readSingleTextOrBlobIdentity(db: Db, sql: string, id: string): StoredRow {
  const rows = db.prepare(sql).all(id, id) as unknown as StoredRow[];
  if (rows.length !== 1) {
    return createReplayFailure();
  }
  return rows[0]!;
}

function readStoredFormFacts(db: Db, workspaceId: string, formVersionId: string): StoredFormFacts {
  const row = readSingleTextOrBlobIdentity(db, PRIVATE_FORM_MIRROR_SQL, formVersionId);
  const id = requireStoredTextIdentifier(row, "id", "id_storage");
  const workspace = requireStoredTextIdentifier(row, "workspace_id", "workspace_storage");
  const definitionId = requireStoredTextIdentifier(
    row,
    "form_definition_id",
    "form_definition_storage",
  );
  const ruleId = requireStoredTextIdentifier(row, "rule_version_id", "rule_version_storage");
  const versionNumber = requireStoredPositiveInteger(
    row,
    "version_number",
    "version_number_storage",
  );
  const sealedAt = requireStoredInstant(row, "sealed_at", "sealed_at_storage");
  if (id !== formVersionId || workspace !== workspaceId) {
    return createReplayFailure();
  }
  return Object.freeze({ id, definitionId, ruleId, versionNumber, sealedAt });
}

function readStoredRuleFacts(db: Db, workspaceId: string, ruleVersionId: string): StoredRuleFacts {
  const row = readSingleTextOrBlobIdentity(db, PRIVATE_RULE_MIRROR_SQL, ruleVersionId);
  const id = requireStoredTextIdentifier(row, "id", "id_storage");
  const workspace = requireStoredTextIdentifier(row, "workspace_id", "workspace_storage");
  const definitionId = requireStoredTextIdentifier(
    row,
    "form_definition_id",
    "form_definition_storage",
  );
  const versionNumber = requireStoredPositiveInteger(
    row,
    "version_number",
    "version_number_storage",
  );
  const sealedAt = requireStoredInstant(row, "sealed_at", "sealed_at_storage");
  if (id !== ruleVersionId || workspace !== workspaceId) {
    return createReplayFailure();
  }
  return Object.freeze({ id, definitionId, versionNumber, sealedAt });
}

function requireStoredFormPair(
  form: StoredFormFacts,
  rule: StoredRuleFacts,
): void {
  if (
    form.ruleId !== rule.id ||
    form.definitionId !== rule.definitionId ||
    form.versionNumber !== rule.versionNumber
  ) {
    createReplayFailure();
  }
}

function readStoredRevisionLineage(
  db: Db,
  identity: CommandIdentity,
  applicant: TrustedApplicant,
  sessionId: string,
  revisionCreatedAt: string,
  callCreatedAt: string,
  personCreatedAt: string,
  personEmail: string,
): void {
  const session = readSingleTextOrBlobIdentity(
    db,
    PRIVATE_APPLICANT_SESSION_MIRROR_SQL,
    sessionId,
  );
  const storedSessionId = requireStoredTextIdentifier(session, "id", "id_storage");
  const sessionWorkspaceId = requireStoredTextIdentifier(
    session,
    "workspace_id",
    "workspace_storage",
  );
  const sessionCallId = requireStoredTextIdentifier(session, "call_id", "call_storage");
  const sessionPersonId = requireStoredTextIdentifier(session, "person_id", "person_storage");
  const verificationId = requireStoredTextIdentifier(
    session,
    "verification_id",
    "verification_storage",
  );
  const sessionTokenHash = requireStoredDigest(session, "token_hash", "token_hash_storage");
  const sessionCreatedAt = requireStoredInstant(session, "created_at", "created_at_storage");
  const sessionExpiresAt = requireStoredInstant(session, "expires_at", "expires_at_storage");
  if (
    storedSessionId !== sessionId ||
    sessionWorkspaceId !== identity.workspaceId ||
    sessionCallId !== identity.callId ||
    sessionPersonId !== applicant.personId
  ) {
    return createReplayFailure();
  }

  const sessionsForVerification = db
    .prepare(PRIVATE_SESSIONS_BY_VERIFICATION_SQL)
    .all(verificationId, verificationId) as unknown as StoredRow[];
  if (
    sessionsForVerification.length !== 1 ||
    requireStoredTextIdentifier(sessionsForVerification[0]!, "id", "id_storage") !== sessionId
  ) {
    return createReplayFailure();
  }

  const digestRows = db.prepare(PRIVATE_SESSION_DIGEST_SQL).all(sessionTokenHash) as unknown as StoredRow[];
  if (
    digestRows.length !== 1 ||
    requireStoredTextIdentifier(digestRows[0]!, "id", "id_storage") !== sessionId ||
    requireStoredDigest(digestRows[0]!, "token_hash", "token_hash_storage") !== sessionTokenHash
  ) {
    return createReplayFailure();
  }

  let revokedAt: string | null = null;
  const revocationIsNull =
    session.revoked_at === null &&
    session.revoked_by === null &&
    session.revoked_reason === null;
  if (revocationIsNull) {
    requireStoredNull(session, "revoked_at", "revoked_at_storage");
    requireStoredNull(session, "revoked_by", "revoked_by_storage");
    requireStoredNull(session, "revoked_reason", "revoked_reason_storage");
  } else {
    revokedAt = requireStoredInstant(session, "revoked_at", "revoked_at_storage");
    const revokedBy = requireStoredTextIdentifier(session, "revoked_by", "revoked_by_storage");
    requireStoredText(session, "revoked_reason", "revoked_reason_storage", 1024);
    const account = readSingleTextOrBlobIdentity(db, PRIVATE_ACCOUNT_MIRROR_SQL, revokedBy);
    if (
      requireStoredTextIdentifier(account, "id", "id_storage") !== revokedBy ||
      requireStoredTextIdentifier(account, "workspace_id", "workspace_storage") !==
        identity.workspaceId
    ) {
      return createReplayFailure();
    }
  }

  const verification = readSingleTextOrBlobIdentity(
    db,
    PRIVATE_VERIFICATION_MIRROR_SQL,
    verificationId,
  );
  const verificationEmail = requireStoredCanonicalEmail(verification, "email", "email_storage");
  const verificationCreatedAt = requireStoredInstant(
    verification,
    "created_at",
    "created_at_storage",
  );
  const verificationExpiresAt = requireStoredInstant(
    verification,
    "expires_at",
    "expires_at_storage",
  );
  if (
    requireStoredTextIdentifier(verification, "id", "id_storage") !== verificationId ||
    requireStoredTextIdentifier(verification, "workspace_id", "workspace_storage") !==
      identity.workspaceId ||
    requireStoredTextIdentifier(verification, "call_id", "call_storage") !== identity.callId ||
    requireStoredDigest(verification, "token_hash", "token_hash_storage").length !== 64 ||
    verificationEmail !== personEmail
  ) {
    return createReplayFailure();
  }

  const consumptionRows = db
    .prepare(PRIVATE_CONSUMPTIONS_BY_VERIFICATION_SQL)
    .all(verificationId, verificationId) as unknown as StoredRow[];
  if (consumptionRows.length !== 1) {
    return createReplayFailure();
  }
  const consumption = consumptionRows[0]!;
  const consumptionId = requireStoredTextIdentifier(consumption, "id", "id_storage");
  const consumedAt = requireStoredInstant(consumption, "consumed_at", "consumed_at_storage");
  if (
    requireStoredTextIdentifier(consumption, "workspace_id", "workspace_storage") !==
      identity.workspaceId ||
    requireStoredTextIdentifier(consumption, "verification_id", "verification_storage") !==
      verificationId ||
    requireStoredTextIdentifier(consumption, "person_id", "person_storage") !==
      applicant.personId
  ) {
    return createReplayFailure();
  }
  const consumptionIdentity = readSingleTextOrBlobIdentity(
    db,
    PRIVATE_CONSUMPTION_IDENTITY_SQL,
    consumptionId,
  );
  if (requireStoredTextIdentifier(consumptionIdentity, "id", "id_storage") !== consumptionId) {
    return createReplayFailure();
  }

  // These are the chronology guards the accepted access and revision writers actually impose:
  // verification consumption and session creation validate the call/verification/person interval,
  // revision insertion validates the session interval, and revocation rejects a pre-session clock.
  if (
    Date.parse(verificationCreatedAt) < Date.parse(callCreatedAt) ||
    Date.parse(verificationExpiresAt) <= Date.parse(verificationCreatedAt) ||
    Date.parse(consumedAt) < Date.parse(verificationCreatedAt) ||
    Date.parse(consumedAt) >= Date.parse(verificationExpiresAt) ||
    Date.parse(personCreatedAt) > Date.parse(consumedAt) ||
    Date.parse(sessionCreatedAt) < Date.parse(consumedAt) ||
    Date.parse(sessionCreatedAt) >= Date.parse(verificationExpiresAt) ||
    Date.parse(sessionExpiresAt) <= Date.parse(sessionCreatedAt) ||
    Date.parse(revisionCreatedAt) < Date.parse(consumedAt) ||
    Date.parse(revisionCreatedAt) < Date.parse(sessionCreatedAt) ||
    Date.parse(revisionCreatedAt) >= Date.parse(sessionExpiresAt) ||
    (revokedAt !== null && Date.parse(revokedAt) < Date.parse(sessionCreatedAt))
  ) {
    createReplayFailure();
  }
}

function readCompleteStoredRevision(
  db: Db,
  row: StoredRow,
  workspaceId: string,
  revisionId: string,
): SubmissionRevision {
  const revisionSchema = requireStoredText(
    row,
    "revision_schema",
    "revision_schema_storage",
    128,
  );
  requireStoredText(row, "revision_json", "revision_json_storage");
  const formDocumentSchema = requireStoredText(
    row,
    "form_document_schema",
    "form_document_schema_storage",
    128,
  );
  const formDocumentFingerprint = requireStoredFingerprint(
    row,
    "form_document_fingerprint",
    "form_document_fingerprint_storage",
  );
  const policySchema = requireStoredText(row, "policy_schema", "policy_schema_storage", 128);
  const policyVersionId = requireStoredTextIdentifier(
    row,
    "policy_version_id",
    "policy_version_storage",
  );
  const policyFingerprintAlgorithm = requireStoredText(
    row,
    "policy_fingerprint_algorithm",
    "policy_fingerprint_algorithm_storage",
    128,
  );
  const policyFingerprint = requireStoredFingerprint(
    row,
    "policy_fingerprint",
    "policy_fingerprint_storage",
  );
  const fingerprintAlgorithm = requireStoredText(
    row,
    "fingerprint_algorithm",
    "fingerprint_algorithm_storage",
    128,
  );
  const fingerprint = requireStoredFingerprint(row, "fingerprint", "fingerprint_storage");

  let consentReceiptPresent = false;
  if (row.consent_receipt_schema === null && row.consent_receipt_policy_fingerprint === null) {
    requireStoredNull(row, "consent_receipt_schema", "consent_receipt_schema_storage");
    requireStoredNull(
      row,
      "consent_receipt_policy_fingerprint",
      "consent_receipt_policy_fingerprint_storage",
    );
  } else {
    requireStoredText(row, "consent_receipt_schema", "consent_receipt_schema_storage", 128);
    requireStoredFingerprint(
      row,
      "consent_receipt_policy_fingerprint",
      "consent_receipt_policy_fingerprint_storage",
    );
    consentReceiptPresent = true;
  }

  let revision: SubmissionRevision;
  try {
    revision = readSubmissionRevisionSeam(db, workspaceId, revisionId);
  } catch {
    return createReplayFailure();
  }
  if (
    revision.schema !== revisionSchema ||
    revision.formDocument.schema !== formDocumentSchema ||
    revision.formDocument.fingerprint !== formDocumentFingerprint ||
    revision.callPolicy.schema !== policySchema ||
    revision.callPolicy.policyVersionId !== policyVersionId ||
    revision.callPolicy.fingerprintAlgorithm !== policyFingerprintAlgorithm ||
    revision.callPolicy.fingerprint !== policyFingerprint ||
    revision.fingerprintAlgorithm !== fingerprintAlgorithm ||
    revision.fingerprint !== fingerprint ||
    (revision.consentReceipt !== null) !== consentReceiptPresent
  ) {
    return createReplayFailure();
  }
  return revision;
}

function storedRevisionFacts(
  db: Db,
  row: StoredRow,
  identity: CommandIdentity,
  applicant: TrustedApplicant,
  submissionId: string,
  pinnedFormVersionId: string,
  pinnedRuleVersionId: string,
  submissionCreatedAt: string,
  submissionUpdatedAt: string,
  callCreatedAt: string,
  personCreatedAt: string,
  personEmail: string,
): StoredRevisionFacts {
  const id = requireStoredTextIdentifier(row, "id", "id_storage");
  const identityRows = db
    .prepare(PRIVATE_REVISION_IDENTITY_SQL)
    .all(id, id) as unknown as StoredRow[];
  if (identityRows.length !== 1) {
    return createReplayFailure();
  }
  const workspaceId = requireStoredTextIdentifier(row, "workspace_id", "workspace_storage");
  const storedSubmissionId = requireStoredTextIdentifier(
    row,
    "submission_id",
    "submission_storage",
  );
  const revisionNumber = requireStoredPositiveInteger(
    row,
    "revision_number",
    "revision_number_storage",
  );
  const formVersionId = requireStoredTextIdentifier(
    row,
    "form_version_id",
    "form_version_storage",
  );
  const ruleVersionId = requireStoredTextIdentifier(
    row,
    "rule_version_id",
    "rule_version_storage",
  );
  const personId = requireStoredTextIdentifier(row, "person_id", "person_storage");
  const sessionId = requireStoredTextIdentifier(row, "session_id", "session_storage");
  const createdAt = requireStoredInstant(row, "created_at", "created_at_storage");
  // The accepted revision insert and submission pointer update are one command. Its update trigger
  // rejects a timestamp before submission creation or its prior updated_at.
  if (
    workspaceId !== identity.workspaceId ||
    storedSubmissionId !== submissionId ||
    formVersionId !== pinnedFormVersionId ||
    ruleVersionId !== pinnedRuleVersionId ||
    personId !== applicant.personId ||
    Date.parse(createdAt) < Date.parse(submissionCreatedAt) ||
    Date.parse(createdAt) > Date.parse(submissionUpdatedAt)
  ) {
    return createReplayFailure();
  }
  readStoredRevisionLineage(
    db,
    identity,
    applicant,
    sessionId,
    createdAt,
    callCreatedAt,
    personCreatedAt,
    personEmail,
  );
  const revision = readCompleteStoredRevision(db, row, workspaceId, id);
  if (
    revision.submissionId !== submissionId ||
    revision.revisionNumber !== revisionNumber ||
    revision.formDocument.formVersionId !== pinnedFormVersionId ||
    revision.formDocument.ruleVersionId !== pinnedRuleVersionId
  ) {
    return createReplayFailure();
  }
  return Object.freeze({
    id,
    revisionNumber,
    createdAt,
    consentReceiptPresent: revision.consentReceipt !== null,
  });
}

function requireStoredRevisionChain(
  db: Db,
  identity: CommandIdentity,
  applicant: TrustedApplicant,
  submissionId: string,
  pinnedFormVersionId: string,
  pinnedRuleVersionId: string,
  currentRevisionId: string | null,
  state: string,
  submissionCreatedAt: string,
  submissionUpdatedAt: string,
  callCreatedAt: string,
  personCreatedAt: string,
  personEmail: string,
): void {
  const rows = db
    .prepare(PRIVATE_CREATE_REVISIONS_SQL)
    .all(submissionId, submissionId) as unknown as StoredRow[];
  const revisions = rows.map((row) =>
    storedRevisionFacts(
      db,
      row,
      identity,
      applicant,
      submissionId,
      pinnedFormVersionId,
      pinnedRuleVersionId,
      submissionCreatedAt,
      submissionUpdatedAt,
      callCreatedAt,
      personCreatedAt,
      personEmail,
    ),
  );
  revisions.sort((left, right) => left.revisionNumber - right.revisionNumber);

  const ids = new Set<string>();
  let previousCreatedAt = submissionCreatedAt;
  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index]!;
    // Every accepted save advances the pointer by one and rejects an updated_at rewind, so revision
    // numbers and their same-command timestamps form this monotonic chain.
    if (
      revision.revisionNumber !== index + 1 ||
      ids.has(revision.id) ||
      Date.parse(revision.createdAt) < Date.parse(previousCreatedAt)
    ) {
      createReplayFailure();
    }
    ids.add(revision.id);
    previousCreatedAt = revision.createdAt;
  }

  if (revisions.length === 0) {
    if (currentRevisionId !== null || state === "SUBMITTED") {
      createReplayFailure();
    }
    return;
  }

  const current = revisions.at(-1)!;
  if (
    currentRevisionId !== current.id ||
    (state === "SUBMITTED" && !current.consentReceiptPresent)
  ) {
    createReplayFailure();
  }
  const pointerRows = db
    .prepare(PRIVATE_REVISION_IDENTITY_SQL)
    .all(currentRevisionId, currentRevisionId) as unknown as StoredRow[];
  if (pointerRows.length !== 1) {
    createReplayFailure();
  }
  const pointer = storedRevisionFacts(
    db,
    pointerRows[0]!,
    identity,
    applicant,
    submissionId,
    pinnedFormVersionId,
    pinnedRuleVersionId,
    submissionCreatedAt,
    submissionUpdatedAt,
    callCreatedAt,
    personCreatedAt,
    personEmail,
  );
  if (
    pointer.id !== current.id ||
    pointer.revisionNumber !== current.revisionNumber ||
    pointer.consentReceiptPresent !== current.consentReceiptPresent
  ) {
    createReplayFailure();
  }
}

function readDurableCreateResult(
  db: Db,
  identity: CommandIdentity,
  applicant: TrustedApplicant,
): CreatedSubmission | null {
  const rows = db
    .prepare(PRIVATE_CREATE_CANDIDATES_SQL)
    .all(
      identity.workspaceId,
      identity.workspaceId,
      identity.callId,
      identity.callId,
      applicant.personId,
      applicant.personId,
    ) as unknown as StoredRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    return createReplayFailure();
  }

  const row = rows[0]!;
  const id = requireStoredTextIdentifier(row, "id", "id_storage");
  const submissionIdentity = readSingleTextOrBlobIdentity(
    db,
    PRIVATE_SUBMISSION_IDENTITY_SQL,
    id,
  );
  if (requireStoredTextIdentifier(submissionIdentity, "id", "id_storage") !== id) {
    return createReplayFailure();
  }
  const workspaceId = requireStoredTextIdentifier(row, "workspace_id", "workspace_storage");
  const eventId = requireStoredTextIdentifier(row, "event_id", "event_storage");
  const callId = requireStoredTextIdentifier(row, "call_id", "call_storage");
  const ownerPersonId = requireStoredTextIdentifier(
    row,
    "owner_person_id",
    "owner_storage",
  );
  const pinnedFormVersionId = requireStoredTextIdentifier(
    row,
    "pinned_form_version_id",
    "pinned_form_storage",
  );
  const pinnedRuleVersionId = requireStoredTextIdentifier(
    row,
    "pinned_rule_version_id",
    "pinned_rule_storage",
  );
  const state = row.state;
  if (
    row.state_storage !== "text" ||
    typeof state !== "string" ||
    !SUBMISSION_STATES.has(state) ||
    workspaceId !== identity.workspaceId ||
    callId !== identity.callId ||
    ownerPersonId !== applicant.personId
  ) {
    return createReplayFailure();
  }

  let currentRevisionId: string | null;
  if (row.current_revision_id === null && row.current_revision_storage === "null") {
    currentRevisionId = null;
  } else {
    currentRevisionId = requireStoredTextIdentifier(
      row,
      "current_revision_id",
      "current_revision_storage",
    );
  }
  const createdAt = requireStoredInstant(row, "created_at", "created_at_storage");
  const updatedAt = requireStoredInstant(row, "updated_at", "updated_at_storage");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    return createReplayFailure();
  }

  const workspace = readSingleTextOrBlobIdentity(
    db,
    PRIVATE_WORKSPACE_MIRROR_SQL,
    workspaceId,
  );
  if (requireStoredTextIdentifier(workspace, "id", "id_storage") !== workspaceId) {
    return createReplayFailure();
  }
  requireStoredInstant(
    workspace,
    "created_at",
    "created_at_storage",
  );

  const call = readSingleTextOrBlobIdentity(db, PRIVATE_CALL_MIRROR_SQL, callId);
  const callFormVersionId = requireStoredTextIdentifier(
    call,
    "form_version_id",
    "form_version_storage",
  );
  const callCreatedAt = requireStoredInstant(call, "created_at", "created_at_storage");
  const callUpdatedAt = requireStoredInstant(call, "updated_at", "updated_at_storage");
  if (
    requireStoredTextIdentifier(call, "id", "id_storage") !== callId ||
    requireStoredTextIdentifier(call, "workspace_id", "workspace_storage") !== workspaceId ||
    requireStoredTextIdentifier(call, "event_id", "event_storage") !== eventId ||
    Date.parse(callUpdatedAt) < Date.parse(callCreatedAt)
  ) {
    return createReplayFailure();
  }
  requireCreatedNoLaterThan(callCreatedAt, createdAt);

  const event = readSingleTextOrBlobIdentity(db, PRIVATE_EVENT_MIRROR_SQL, eventId);
  if (
    requireStoredTextIdentifier(event, "id", "id_storage") !== eventId ||
    requireStoredTextIdentifier(event, "workspace_id", "workspace_storage") !== workspaceId
  ) {
    return createReplayFailure();
  }
  requireStoredInstant(event, "created_at", "created_at_storage");

  const person = readSingleTextOrBlobIdentity(db, PRIVATE_PERSON_MIRROR_SQL, ownerPersonId);
  if (
    requireStoredTextIdentifier(person, "id", "id_storage") !== ownerPersonId ||
    requireStoredTextIdentifier(person, "workspace_id", "workspace_storage") !== workspaceId
  ) {
    return createReplayFailure();
  }
  const personEmail = requireStoredCanonicalEmail(
    person,
    "canonical_email",
    "canonical_email_storage",
  );
  const personCreatedAt = requireStoredInstant(person, "created_at", "created_at_storage");
  // Draft creation validates a session at its write timestamp. Accepted session creation already
  // proves both call and person existed by that session timestamp, so only these two roots constrain
  // the submission clock; workspace, event, definition, and seal writers impose no such ordering.
  requireCreatedNoLaterThan(personCreatedAt, createdAt);

  const pinnedForm = readStoredFormFacts(db, workspaceId, pinnedFormVersionId);
  const pinnedRule = readStoredRuleFacts(db, workspaceId, pinnedRuleVersionId);
  requireStoredFormPair(pinnedForm, pinnedRule);

  const definition = readSingleTextOrBlobIdentity(
    db,
    PRIVATE_FORM_DEFINITION_MIRROR_SQL,
    pinnedForm.definitionId,
  );
  if (
    requireStoredTextIdentifier(definition, "id", "id_storage") !== pinnedForm.definitionId ||
    requireStoredTextIdentifier(definition, "workspace_id", "workspace_storage") !== workspaceId
  ) {
    return createReplayFailure();
  }
  requireStoredInstant(
    definition,
    "created_at",
    "created_at_storage",
  );

  // A call can advance to a later form after this submission was created. Its current form need
  // not equal the immutable pin, but it must remain in the same form-definition lineage.
  const currentCallForm = readStoredFormFacts(db, workspaceId, callFormVersionId);
  const currentCallRule = readStoredRuleFacts(db, workspaceId, currentCallForm.ruleId);
  requireStoredFormPair(currentCallForm, currentCallRule);
  if (currentCallForm.definitionId !== pinnedForm.definitionId) {
    return createReplayFailure();
  }

  requireStoredRevisionChain(
    db,
    identity,
    applicant,
    id,
    pinnedFormVersionId,
    pinnedRuleVersionId,
    currentRevisionId,
    state,
    createdAt,
    updatedAt,
    callCreatedAt,
    personCreatedAt,
    personEmail,
  );

  return Object.freeze({
    id,
    workspaceId,
    eventId,
    callId,
    ownerPersonId,
    pinnedFormVersionId,
    pinnedRuleVersionId,
  });
}

function snapshotCreatedSubmission(created: unknown): CreatedSubmission {
  let safe: JsonSafeValue;
  try {
    safe = sanitizeFormData(created);
  } catch {
    return createReplayFailure();
  }
  if (!isJsonSafeObject(safe)) {
    return createReplayFailure();
  }
  const present = Object.keys(safe);
  if (
    present.length !== CREATED_SUBMISSION_KEYS.length ||
    !CREATED_SUBMISSION_KEYS.every((key) => HAS_OWN.call(safe, key))
  ) {
    return createReplayFailure();
  }
  const result = {
    id: safe.id,
    workspaceId: safe.workspaceId,
    eventId: safe.eventId,
    callId: safe.callId,
    ownerPersonId: safe.ownerPersonId,
    pinnedFormVersionId: safe.pinnedFormVersionId,
    pinnedRuleVersionId: safe.pinnedRuleVersionId,
  };
  if (!Object.values(result).every(isCommandId)) {
    return createReplayFailure();
  }
  return Object.freeze(result as CreatedSubmission);
}

function sameCreatedSubmission(
  left: CreatedSubmission,
  right: CreatedSubmission,
): boolean {
  return CREATED_SUBMISSION_KEYS.every((key) => left[key] === right[key]);
}

function savedRevisionFacts(saved: unknown, submissionId: string): SavedRevisionFacts {
  if (saved === null || typeof saved !== "object") {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  const result = saved as { readonly revisionId?: unknown; readonly revision?: unknown };
  const revisionId = result.revisionId;
  const revision = result.revision;
  if (!isCommandId(revisionId) || revision === null || typeof revision !== "object") {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  const written = revision as {
    readonly submissionId?: unknown;
    readonly consentReceipt?: unknown;
  };
  if (written.submissionId !== submissionId) {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  const receipt = written.consentReceipt;
  return Object.freeze({
    revisionId,
    consentReceiptPresent: receipt !== null && typeof receipt === "object",
    revision: revision as SubmissionRevision,
  });
}

function requireQueuedConfirmation(
  receipt: unknown,
  command: RevisionCommand,
  revisionId: string,
  submittedAt: string,
): CfpSubmissionConfirmationReceipt {
  if (receipt === null || typeof receipt !== "object") {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  const value = receipt as {
    readonly receiptId?: unknown;
    readonly eventId?: unknown;
    readonly submissionId?: unknown;
    readonly submissionRevisionId?: unknown;
    readonly maskedRecipient?: unknown;
    readonly status?: unknown;
    readonly queuedAt?: unknown;
    readonly channel?: unknown;
    readonly simulated?: unknown;
    readonly providerMutation?: unknown;
  };
  if (
    !isCommandId(value.receiptId) ||
    !isCommandId(value.eventId) ||
    value.submissionId !== command.submissionId ||
    value.submissionRevisionId !== revisionId ||
    typeof value.maskedRecipient !== "string" ||
    value.maskedRecipient.length === 0 ||
    value.status !== "PENDING" ||
    !isIsoInstant(value.queuedAt) ||
    value.queuedAt !== submittedAt ||
    value.channel !== CFP_SUBMISSION_CONFIRMATION_CHANNEL ||
    value.simulated !== true ||
    value.providerMutation !== false
  ) {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  return receipt as CfpSubmissionConfirmationReceipt;
}

function readPrivateSubmission(
  db: Db,
  command: RevisionCommand,
): PrivateSubmissionRow | undefined {
  return db.prepare(PRIVATE_SUBMISSION_SQL).get(command.workspaceId, command.submissionId) as
    | PrivateSubmissionRow
    | undefined;
}

/**
 * A missing submission, a submission in another call, and another applicant's submission are one
 * answer: the caller learns nothing about rows outside its own workspace, call, and ownership.
 */
function ownsPrivateSubmission(
  row: PrivateSubmissionRow | undefined,
  command: RevisionCommand,
  applicant: TrustedApplicant,
): row is PrivateSubmissionRow {
  return (
    row !== undefined &&
    row.call_id === command.callId &&
    row.owner_person_id === applicant.personId
  );
}

/**
 * Collapse every unowned address before the accepted persistence seam runs. The seam legitimately
 * distinguishes a missing submission, a foreign draft, and a foreign terminal row, so calling it
 * with an arbitrary identifier would otherwise turn it into an existence and state oracle. Only a
 * row this session actually owns continues, and only then may state and pointer truth be reported.
 */
function requireOwnedSubmission(
  db: Db,
  command: RevisionCommand,
  applicant: TrustedApplicant,
): void {
  if (!ownsPrivateSubmission(readPrivateSubmission(db, command), command, applicant)) {
    throw commandError("SUBMISSION_NOT_FOUND");
  }
}

function classifySubmitConflict(
  db: Db,
  command: RevisionCommand,
  applicant: TrustedApplicant,
  revisionId: string,
): CfpSubmissionCommandErrorCode {
  const row = readPrivateSubmission(db, command);
  if (!ownsPrivateSubmission(row, command, applicant)) {
    return "SUBMISSION_NOT_FOUND";
  }
  if (row.state !== "DRAFT") {
    return "SUBMISSION_NOT_DRAFT";
  }
  if (row.current_revision_id !== revisionId) {
    return "SUBMISSION_STALE";
  }
  return "SUBMISSION_WRITE_FAILED";
}

function classifiedSubmitFailure(
  db: Db,
  command: RevisionCommand,
  applicant: TrustedApplicant,
  revisionId: string,
): CfpSubmissionCommandError {
  let code: CfpSubmissionCommandErrorCode;
  try {
    code = classifySubmitConflict(db, command, applicant, revisionId);
  } catch {
    // A classification read that itself fails must not widen the public failure surface.
    code = "SUBMISSION_WRITE_FAILED";
  }
  return commandError(code);
}

function readSubmittedAt(db: Db, command: RevisionCommand, revisionId: string): string {
  const row = db
    .prepare(
      `SELECT state, current_revision_id, updated_at
       FROM submissions
       WHERE workspace_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(command.workspaceId, command.submissionId) as
    | { state: unknown; current_revision_id: unknown; updated_at: unknown }
    | undefined;
  if (!row || row.state !== "SUBMITTED" || row.current_revision_id !== revisionId) {
    throw commandError("SUBMISSION_WRITE_FAILED");
  }
  return requireTrustedTimestamp(row.updated_at);
}

function commitSubmittedState(
  db: Db,
  deps: Dependencies,
  command: RevisionCommand,
  applicant: TrustedApplicant,
  revisionId: string,
): string {
  const timestamp = requireTrustedTimestamp(deps.now());
  const update = db
    .prepare(SUBMIT_CAS_SQL)
    .run(
      timestamp,
      timestamp,
      command.workspaceId,
      command.submissionId,
      command.callId,
      applicant.personId,
      revisionId,
    );
  if (update.changes !== 1) {
    throw classifiedSubmitFailure(db, command, applicant, revisionId);
  }
  return readSubmittedAt(db, command, revisionId);
}

function isHistoricalAnswerSemanticError(error: unknown): boolean {
  return (
    error instanceof FormEvaluationError ||
    error instanceof FormDocumentError ||
    error instanceof FormSafetyError
  );
}

/**
 * Only this accepted revision-writer call consumes `historicalAnswers`. Semantic form failures at
 * this exact seam therefore classify the caller's historical-answer input; the same error classes
 * from authorization, create, clock, or any other dependency remain opaque write failures.
 */
function writeHistoricalRevision(
  db: Db,
  deps: Dependencies,
  applicant: TrustedApplicant,
  command: RevisionCommand,
): SavedSubmissionRevision {
  try {
    return deps.saveDraftRevision(scopeNestedWriterSavepoint(db, "cfp_save_draft_revision"), applicant.context, {
      submissionId: command.submissionId,
      historicalAnswers: command.historicalAnswers,
      expectedCurrentRevisionId: command.expectedCurrentRevisionId,
    });
  } catch (error) {
    if (isHistoricalAnswerSemanticError(error)) {
      throw commandError("COMMAND_INPUT_INVALID");
    }
    throw error;
  }
}

function writeSubmittedAmendment(
  db: Db,
  deps: Dependencies,
  applicant: TrustedApplicant,
  command: RevisionCommand,
): SavedSubmissionRevision {
  try {
    return deps.saveSubmittedAmendment(
      scopeNestedWriterSavepoint(db, "cfp_save_submitted_amendment"),
      applicant.context,
      {
        submissionId: command.submissionId,
        historicalAnswers: command.historicalAnswers,
        expectedCurrentRevisionId: command.expectedCurrentRevisionId as string,
      },
    );
  } catch (error) {
    if (isHistoricalAnswerSemanticError(error)) {
      throw commandError("COMMAND_INPUT_INVALID");
    }
    throw error;
  }
}

function commandBoundary<T>(command: () => T): T {
  try {
    return command();
  } catch (error) {
    let outward: Error | null = null;
    try {
      if (isInternalFatalError(error)) {
        // Never trust even the message on the instance crossing this final boundary. Recreate and
        // freeze the fatal stop without granting the outward instance reusable provenance.
        INTERNAL_FATAL_ERRORS.delete(error);
        outward = Object.freeze(new CfpSubmissionCommandFatalError());
      } else if (
        error instanceof CfpSubmissionCommandError &&
        INTERNAL_COMMAND_ERRORS.has(error)
      ) {
        INTERNAL_COMMAND_ERRORS.delete(error);
        outward = publicCommandError(error.code);
      } else if (error instanceof CfpApplicantAccessError) {
        const code = accessErrorCode(error);
        outward =
          code === null
            ? publicCommandError("SUBMISSION_WRITE_FAILED")
            : Object.freeze(new CfpApplicantAccessError(code));
      } else if (error instanceof FormDocumentPersistenceError) {
        const code = persistenceErrorCode(error);
        outward =
          code === null
            ? publicCommandError("SUBMISSION_WRITE_FAILED")
            : Object.freeze(new FormDocumentPersistenceError(code));
      }
    } catch {
      throw publicCommandError("SUBMISSION_WRITE_FAILED");
    }
    if (outward !== null) throw outward;
    // Driver text, trigger text, SQL, answer payloads, and digests never reach a caller.
    throw publicCommandError("SUBMISSION_WRITE_FAILED");
  }
}

function createSubmissionDraftInternal(
  db: Db,
  input: CreateSubmissionDraftInput,
  deps: Dependencies,
): CreatedSubmission {
  return commandBoundary(() =>
    withOwnedTransactionOrSavepoint(db, "cfp_create_submission_draft", () => {
      const identity = snapshotCreateCommand(input);
      const applicant = authorize(db, deps, identity, "CREATE_DRAFT");
      const persisted = readDurableCreateResult(db, identity, applicant);
      if (persisted !== null) return persisted;

      const created = snapshotCreatedSubmission(
        deps.createDraftSubmission(
          scopeNestedWriterSavepoint(db, "cfp_create_draft"),
          applicant.context,
          { callId: identity.callId },
        ),
      );
      if (
        created.workspaceId !== identity.workspaceId ||
        created.callId !== identity.callId ||
        created.ownerPersonId !== applicant.personId
      ) {
        return createReplayFailure();
      }

      const durable = readDurableCreateResult(db, identity, applicant);
      if (durable === null || !sameCreatedSubmission(created, durable)) {
        return createReplayFailure();
      }
      return durable;
    }),
  );
}

function saveSubmissionDraftInternal(
  db: Db,
  input: SaveSubmissionDraftInput,
  deps: Dependencies,
): SavedSubmissionRevision {
  return commandBoundary(() =>
    withOwnedTransactionOrSavepoint(db, "cfp_save_submission_draft", () => {
      const command = snapshotRevisionCommand(input);
      const applicant = authorize(db, deps, command, "SAVE_DRAFT");
      requireOwnedSubmission(db, command, applicant);
      return writeHistoricalRevision(db, deps, applicant, command);
    }),
  );
}

function amendSubmittedSubmissionInternal(
  db: Db,
  input: AmendSubmittedSubmissionInput,
  deps: Dependencies,
): SavedSubmissionRevision {
  return commandBoundary(() =>
    withOwnedTransactionOrSavepoint(db, "cfp_amend_submitted_submission", () => {
      const command = snapshotRevisionCommand(input);
      if (command.expectedCurrentRevisionId === null) {
        throw commandError("COMMAND_INPUT_INVALID");
      }
      const applicant = authorize(db, deps, command, "SAVE_DRAFT");
      requireOwnedSubmission(db, command, applicant);
      return writeSubmittedAmendment(db, deps, applicant, command);
    }),
  );
}

/**
 * Save the caller's historical answers as a new immutable revision and submit that exact revision
 * inside one boundary. This is deliberately not an idempotent replay of an earlier revision: a
 * retry must present the still-current pointer, and the terminal submitted state then fails
 * stably rather than writing again.
 */
function submitSubmissionInternal(
  db: Db,
  input: SubmitSubmissionInput,
  deps: Dependencies,
): SubmittedSubmission {
  return commandBoundary(() =>
    withOwnedTransactionOrSavepoint(db, "cfp_submit_submission", () => {
      const command = snapshotRevisionCommand(input);
      const applicant = authorize(db, deps, command, "SUBMIT");
      requireOwnedSubmission(db, command, applicant);
      const saved = writeHistoricalRevision(db, deps, applicant, command);
      const facts = savedRevisionFacts(saved, command.submissionId);
      if (!facts.consentReceiptPresent) {
        // Rolling this boundary back discards the revision insert and the pointer update, so an
        // incomplete submit leaves no trace of a revision the applicant never completed.
        throw commandError("SUBMISSION_INCOMPLETE");
      }
      const submittedAt = commitSubmittedState(db, deps, command, applicant, facts.revisionId);
      const confirmation = deps.queueSubmissionConfirmation(db, {
        workspaceId: command.workspaceId,
        submissionId: command.submissionId,
        submissionRevisionId: facts.revisionId,
        personId: applicant.personId,
        session: applicant.context,
        revision: facts.revision,
        queuedAt: submittedAt,
      });
      requireQueuedConfirmation(confirmation, command, facts.revisionId, submittedAt);
      return Object.freeze({
        submissionId: command.submissionId,
        revisionId: facts.revisionId,
        submittedAt,
      });
    }),
  );
}

function createDependencies(options?: CfpSubmissionCommandOptions): Dependencies {
  return Object.freeze({
    now: options?.clock ?? nowIso,
    resolveApplicantSession: options?.resolveApplicantSession ?? resolveApplicantSessionSeam,
    assertApplicantAccess: options?.assertApplicantAccess ?? assertApplicantAccessSeam,
    createDraftSubmission: options?.createDraftSubmission ?? createDraftSubmissionSeam,
    saveDraftRevision: options?.saveDraftRevision ?? saveDraftRevisionSeam,
    saveSubmittedAmendment: options?.saveSubmittedAmendment ?? saveSubmittedAmendmentSeam,
    queueSubmissionConfirmation:
      options?.queueSubmissionConfirmation ?? queueCfpSubmissionConfirmation,
  });
}

export function createCfpSubmissionCommands(
  options?: CfpSubmissionCommandOptions,
): CfpSubmissionCommands {
  const deps = createDependencies(options);
  return {
    createSubmissionDraft: (db, input) => createSubmissionDraftInternal(db, input, deps),
    saveSubmissionDraft: (db, input) => saveSubmissionDraftInternal(db, input, deps),
    amendSubmittedSubmission: (db, input) => amendSubmittedSubmissionInternal(db, input, deps),
    submitSubmission: (db, input) => submitSubmissionInternal(db, input, deps),
  };
}

const defaultCommands = createCfpSubmissionCommands();

export function createSubmissionDraft(
  db: Db,
  input: CreateSubmissionDraftInput,
): CreatedSubmission {
  return defaultCommands.createSubmissionDraft(db, input);
}

export function saveSubmissionDraft(
  db: Db,
  input: SaveSubmissionDraftInput,
): SavedSubmissionRevision {
  return defaultCommands.saveSubmissionDraft(db, input);
}

export function amendSubmittedSubmission(
  db: Db,
  input: AmendSubmittedSubmissionInput,
): SavedSubmissionRevision {
  return defaultCommands.amendSubmittedSubmission(db, input);
}

export function submitSubmission(db: Db, input: SubmitSubmissionInput): SubmittedSubmission {
  return defaultCommands.submitSubmission(db, input);
}
