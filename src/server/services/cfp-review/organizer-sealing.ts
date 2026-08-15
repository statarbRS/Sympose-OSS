import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import { roleHasCapability, type SessionInfo } from "../../auth";
import { canonicalJson, deterministicUuid, fingerprintOf, nowIso, uuid } from "../../canonical";
import type { Db } from "../../db";
import { writeAudit } from "../audit";
import {
  FormDocumentPersistenceError,
  readSubmissionRevision,
} from "../cfp/form-documents";
import {
  FormSafetyError,
  sanitizeFormData,
  type JsonSafeObject,
  type JsonSafeValue,
} from "../cfp/form-safety";
import { normalizeFormDocument } from "../cfp/form-types";
import {
  BLIND_REVIEW_ARTIFACT_LIMITS,
  BLIND_REVIEW_ATTESTATION,
  BLIND_REVIEW_DISCLOSURE_STAGE,
  CFP_REVIEW_BLIND_ARTIFACT_SCHEMA,
  CFP_REVIEW_FINGERPRINT_ALGORITHM,
  CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
  CFP_SUBMISSION_REVISION_SCHEMA,
  REVIEW_ISSUER_AUTHORITY,
  type BlindArtifactConflictStatus,
  type BlindFieldDecisionInput,
} from "./artifact-types";
import {
  canonicalBlindReviewArtifactJson,
  createBlindReviewArtifact,
  fingerprintBlindReviewArtifact,
  parseCanonicalBlindReviewArtifact,
  ReviewArtifactError,
  type ReviewArtifactErrorCode,
} from "./artifacts";
import {
  canonicalReviewRubricSemanticsJson,
  fingerprintReviewRubricSemantics,
  normalizeReviewRubricSemantics,
  normalizeSealCriteria,
  parseCanonicalReviewRubricSemantics,
  normalizeCustomReviewRubricDocument,
  REVIEW_RUBRIC_LIMITS,
  ReviewRubricSemanticsError,
  type ReviewRubricSemanticsErrorCode,
  type SealCriterionInput,
} from "./rubric-semantics";

export interface SealRubricSemanticsInput {
  readonly workspaceSlug: string;
  readonly rubricVersionId: string;
  readonly expectedRubricFingerprint: string;
  readonly idempotencyKey: string;
  readonly criteria: readonly SealCriterionInput[];
}

export interface RubricSemanticsSealReceipt {
  readonly semanticsId: string;
  readonly rubricVersionId: string;
  readonly rubricVersionNumber: number;
  readonly issuedAt: string;
  readonly replayed: boolean;
}

export interface SealBlindReviewArtifactInput {
  readonly workspaceSlug: string;
  readonly assignmentId: string;
  readonly expectedSubmissionRevisionId: string;
  readonly expectedSubmissionRevisionFingerprint: string;
  readonly expectedConflictSequence: number;
  readonly stage: typeof BLIND_REVIEW_DISCLOSURE_STAGE;
  readonly attestation: typeof BLIND_REVIEW_ATTESTATION;
  readonly idempotencyKey: string;
  readonly decisions: readonly BlindFieldDecisionInput[];
}

export interface BlindReviewArtifactSealReceipt {
  readonly artifactId: string;
  readonly assignmentId: string;
  readonly submissionRevisionId: string;
  readonly stage: typeof BLIND_REVIEW_DISCLOSURE_STAGE;
  readonly includedCount: number;
  readonly excludedCount: number;
  readonly issuedAt: string;
  readonly replayed: boolean;
}

export interface InTransactionOrganizerIssuer {
  readonly session: SessionInfo;
  readonly workspaceSlug: string;
}

export interface EnsureCustomReviewRubricSemanticsInput {
  readonly issuer: InTransactionOrganizerIssuer;
  readonly roundId: string;
  readonly rubricVersionId: string;
  readonly rubricVersionNumber: number;
  readonly rubricVersionFingerprint: string;
  readonly customRubric: unknown;
}

export interface InTransactionBlindReviewArtifactInput {
  readonly issuer: InTransactionOrganizerIssuer;
  readonly assignmentId: string;
  readonly expectedSubmissionRevisionId: string;
  readonly expectedSubmissionRevisionFingerprint: string;
  readonly expectedConflictSequence: number;
  readonly idempotencyKey: string;
  readonly decisions: readonly BlindFieldDecisionInput[];
}

const SEALING_ERROR_MESSAGES = {
  SEAL_INPUT_INVALID: "The organizer sealing input is invalid.",
  SEAL_AUTHORIZATION_DENIED: "The organizer sealing request is not available.",
  SEAL_OUTER_TRANSACTION_FORBIDDEN:
    "The organizer sealing service requires its own transaction.",
  SEAL_IDEMPOTENCY_CONFLICT:
    "The idempotency key conflicts with an earlier organizer sealing request.",
  SEAL_TARGET_UNAVAILABLE: "The organizer sealing target is not available.",
  RUBRIC_VERSION_STALE: "The rubric version fingerprint is stale.",
  RUBRIC_SEMANTICS_IMMUTABLE: "The rubric semantics seal is immutable.",
  REVIEW_ROUND_NOT_SEALABLE: "The review round is not sealable.",
  REVIEW_ASSIGNMENT_NOT_SEALABLE: "The review assignment is not sealable.",
  RUBRIC_SEMANTICS_MISSING: "The assignment has no sealed rubric semantics.",
  REVIEW_CONFLICT_DECLARED: "The review assignment has a declared conflict.",
  REVIEW_CONFLICT_STALE: "The review conflict sequence is stale.",
  SUBMISSION_REVISION_STALE: "The submission revision is stale.",
  BLIND_ARTIFACT_IMMUTABLE: "The blind-review artifact seal is immutable.",
  SEAL_READ_FAILED: "The organizer sealing read failed.",
  SEAL_WRITE_FAILED: "The organizer sealing write failed.",
} as const;

export type OrganizerSealingErrorCode = keyof typeof SEALING_ERROR_MESSAGES;

export class OrganizerSealingError extends Error {
  readonly code: OrganizerSealingErrorCode;

  constructor(code: OrganizerSealingErrorCode) {
    super(SEALING_ERROR_MESSAGES[code]);
    this.name = "OrganizerSealingError";
    this.code = code;
  }
}

export class OrganizerSealingFatalError extends Error {
  readonly fatal = true;

  constructor() {
    super("The organizer sealing service cannot continue safely.");
    this.name = "OrganizerSealingFatalError";
  }
}

const INTERNAL_SEALING_ERRORS = new WeakSet<object>();
const INTERNAL_FATAL_ERRORS = new WeakSet<object>();

function sealingError(code: OrganizerSealingErrorCode): OrganizerSealingError {
  const error = new OrganizerSealingError(code);
  INTERNAL_SEALING_ERRORS.add(error);
  return error;
}

function fail(code: OrganizerSealingErrorCode): never {
  throw sealingError(code);
}

function fatalError(): OrganizerSealingFatalError {
  const error = new OrganizerSealingFatalError();
  INTERNAL_FATAL_ERRORS.add(error);
  return error;
}

const ARTIFACT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ARTIFACT_INPUT_UNSAFE",
  "ARTIFACT_SHAPE_INVALID",
  "ARTIFACT_SCHEMA_UNSUPPORTED",
  "ARTIFACT_LIMIT_EXCEEDED",
  "ARTIFACT_BINDING_INVALID",
  "ARTIFACT_FINGERPRINT_INVALID",
  "ARTIFACT_FINGERPRINT_MISMATCH",
  "ARTIFACT_ITEM_INVALID",
  "ARTIFACT_ITEM_DUPLICATE",
  "ARTIFACT_DECISION_MISSING",
  "ARTIFACT_DECISION_DUPLICATE",
  "ARTIFACT_DECISION_UNKNOWN",
  "ARTIFACT_STRUCTURAL_INCLUDE_FORBIDDEN",
  "ARTIFACT_REDACTED_VALUE_INVALID",
  "ARTIFACT_CANONICAL_JSON_INVALID",
]);

const RUBRIC_ERROR_CODES: ReadonlySet<string> = new Set([
  "RUBRIC_SEMANTICS_INPUT_UNSAFE",
  "RUBRIC_SEMANTICS_SHAPE_INVALID",
  "RUBRIC_SEMANTICS_SCHEMA_UNSUPPORTED",
  "RUBRIC_SEMANTICS_LIMIT_EXCEEDED",
  "RUBRIC_SEMANTICS_BINDING_INVALID",
  "RUBRIC_SEMANTICS_CRITERION_INVALID",
  "RUBRIC_SEMANTICS_CRITERION_DUPLICATE",
  "RUBRIC_SEMANTICS_CANONICAL_JSON_INVALID",
]);

function safeArtifactCode(error: ReviewArtifactError): ReviewArtifactErrorCode | null {
  try {
    return ARTIFACT_ERROR_CODES.has(error.code) ? error.code : null;
  } catch {
    return null;
  }
}

function safeRubricCode(
  error: ReviewRubricSemanticsError,
): ReviewRubricSemanticsErrorCode | null {
  try {
    return RUBRIC_ERROR_CODES.has(error.code) ? error.code : null;
  } catch {
    return null;
  }
}

function publicBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    try {
      if (
        typeof error === "object" &&
        error !== null &&
        INTERNAL_FATAL_ERRORS.has(error)
      ) {
        INTERNAL_FATAL_ERRORS.delete(error);
        throw Object.freeze(new OrganizerSealingFatalError());
      }
      if (
        typeof error === "object" &&
        error !== null &&
        INTERNAL_SEALING_ERRORS.has(error)
      ) {
        INTERNAL_SEALING_ERRORS.delete(error);
        const code = (error as OrganizerSealingError).code;
        if (Object.prototype.hasOwnProperty.call(SEALING_ERROR_MESSAGES, code)) {
          throw Object.freeze(new OrganizerSealingError(code));
        }
      }
      if (error instanceof ReviewArtifactError) {
        const code = safeArtifactCode(error);
        if (code !== null) throw Object.freeze(new ReviewArtifactError(code));
      }
      if (error instanceof ReviewRubricSemanticsError) {
        const code = safeRubricCode(error);
        if (code !== null) throw Object.freeze(new ReviewRubricSemanticsError(code));
      }
      if (error instanceof FormSafetyError) {
        throw Object.freeze(new OrganizerSealingError("SEAL_INPUT_INVALID"));
      }
      if (error instanceof FormDocumentPersistenceError) {
        throw Object.freeze(new OrganizerSealingError("SEAL_READ_FAILED"));
      }
    } catch (outward) {
      if (
        outward instanceof OrganizerSealingError ||
        outward instanceof OrganizerSealingFatalError ||
        outward instanceof ReviewArtifactError ||
        outward instanceof ReviewRubricSemanticsError
      ) {
        throw outward;
      }
    }
    // Driver text, SQL, trigger messages, tokens, identifiers, and malformed content stay opaque.
    throw Object.freeze(new OrganizerSealingError("SEAL_WRITE_FAILED"));
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const SESSION_KEYS = new Set([
  "id",
  "tokenHash",
  "accountId",
  "workspaceId",
  "expiresAt",
  "email",
  "displayName",
  "role",
  "workspaceSlug",
  "workspaceName",
]);
const RUBRIC_INPUT_KEYS = new Set([
  "workspaceSlug",
  "rubricVersionId",
  "expectedRubricFingerprint",
  "idempotencyKey",
  "criteria",
]);
const ARTIFACT_INPUT_KEYS = new Set([
  "workspaceSlug",
  "assignmentId",
  "expectedSubmissionRevisionId",
  "expectedSubmissionRevisionFingerprint",
  "expectedConflictSequence",
  "stage",
  "attestation",
  "idempotencyKey",
  "decisions",
]);

const SESSION_SAFETY_LIMITS = Object.freeze({
  maxDepth: 4,
  maxStringBytes: 64 * 1024,
  maxArrayLength: 16,
  maxObjectKeys: 16,
  maxKeyBytes: 128,
  maxNodes: 64,
  maxSerializedBytes: 256 * 1024,
});

const RUBRIC_INPUT_SAFETY_LIMITS = Object.freeze({
  maxDepth: 16,
  maxStringBytes: 64 * 1024,
  maxArrayLength: 256,
  maxObjectKeys: 32,
  maxKeyBytes: 128,
  maxNodes: REVIEW_RUBRIC_LIMITS.maxNodes,
  maxSerializedBytes: REVIEW_RUBRIC_LIMITS.maxSerializedBytes,
});

const ARTIFACT_INPUT_SAFETY_LIMITS = Object.freeze({
  maxDepth: BLIND_REVIEW_ARTIFACT_LIMITS.maxDepth,
  maxStringBytes: 64 * 1024,
  // The accepted persisted form contract currently caps fields/answers at 256. Keep the
  // service envelope inside the accepted form-safety walker's own immutable ceiling as well.
  maxArrayLength: 1_024,
  maxObjectKeys: 256,
  maxKeyBytes: 128,
  maxNodes: 20_000,
  maxSerializedBytes: BLIND_REVIEW_ARTIFACT_LIMITS.maxSerializedBytes,
});

function safeInput(
  input: unknown,
  limits: Parameters<typeof sanitizeFormData>[1],
): JsonSafeValue {
  try {
    return sanitizeFormData(input, limits);
  } catch {
    return fail("SEAL_INPUT_INVALID");
  }
}

function jsonObject(value: JsonSafeValue): JsonSafeObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("SEAL_INPUT_INVALID");
  }
  return value as JsonSafeObject;
}

function exactKeys(value: JsonSafeObject, expected: ReadonlySet<string>): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || !keys.every((key) => expected.has(key))) {
    return fail("SEAL_INPUT_INVALID");
  }
}

function inputIdentifier(value: JsonSafeValue | undefined): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    return fail("SEAL_INPUT_INVALID");
  }
  return value;
}

function inputFingerprint(value: JsonSafeValue | undefined): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    return fail("SEAL_INPUT_INVALID");
  }
  return value;
}

function boundedInputText(value: JsonSafeValue | undefined, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return fail("SEAL_INPUT_INVALID");
  }
  return value;
}

function canonicalTimestamp(value: unknown, code: OrganizerSealingErrorCode): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 128) {
    return fail(code);
  }
  try {
    if (new Date(value).toISOString() !== value) return fail(code);
  } catch {
    return fail(code);
  }
  return value;
}

function storedIdentifier(value: unknown, code: OrganizerSealingErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) return fail(code);
  return value;
}

function storedFingerprint(value: unknown, code: OrganizerSealingErrorCode): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) return fail(code);
  return value;
}

function storedPositiveInteger(value: unknown, code: OrganizerSealingErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail(code);
  }
  return value;
}

function storedNonNegativeInteger(value: unknown, code: OrganizerSealingErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(code);
  }
  return value;
}

function equalFixedLength(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

type SessionSnapshot = Readonly<{
  id: string;
  tokenHash: string;
}>;

function snapshotSession(input: unknown): SessionSnapshot {
  const safe = jsonObject(safeInput(input, SESSION_SAFETY_LIMITS));
  exactKeys(safe, SESSION_KEYS);
  const id = inputIdentifier(safe.id);
  const tokenHash = inputFingerprint(safe.tokenHash);
  inputIdentifier(safe.accountId);
  inputIdentifier(safe.workspaceId);
  canonicalTimestamp(safe.expiresAt, "SEAL_INPUT_INVALID");
  boundedInputText(safe.email, 320);
  boundedInputText(safe.displayName, 64 * 1024);
  boundedInputText(safe.role, 128);
  inputIdentifier(safe.workspaceSlug);
  boundedInputText(safe.workspaceName, 64 * 1024);
  return Object.freeze({ id, tokenHash });
}

type RubricCommand = Readonly<{
  workspaceSlug: string;
  rubricVersionId: string;
  expectedRubricFingerprint: string;
  idempotencyKey: string;
  criteria: readonly JsonSafeValue[];
  requestFingerprint: string;
}>;

function snapshotRubricCommand(input: unknown): RubricCommand {
  const safe = jsonObject(safeInput(input, RUBRIC_INPUT_SAFETY_LIMITS));
  exactKeys(safe, RUBRIC_INPUT_KEYS);
  if (!Array.isArray(safe.criteria)) return fail("SEAL_INPUT_INVALID");
  const command = {
    schema: "cfp-review-rubric-semantics-seal-request/v1",
    workspaceSlug: inputIdentifier(safe.workspaceSlug),
    rubricVersionId: inputIdentifier(safe.rubricVersionId),
    expectedRubricFingerprint: inputFingerprint(safe.expectedRubricFingerprint),
    idempotencyKey: inputIdentifier(safe.idempotencyKey),
    criteria: safe.criteria,
  } as const;
  return Object.freeze({ ...command, requestFingerprint: fingerprintOf(command) });
}

function canonicalDecision(input: JsonSafeValue): JsonSafeObject {
  const safe = jsonObject(input);
  if (safe.action === "EXCLUDE") {
    exactKeys(safe, new Set(["sourceFieldId", "action"]));
    return Object.freeze({
      sourceFieldId: inputIdentifier(safe.sourceFieldId),
      action: "EXCLUDE",
    });
  }
  if (safe.action !== "INCLUDE_REDACTED") return fail("SEAL_INPUT_INVALID");
  exactKeys(
    safe,
    new Set(["sourceFieldId", "action", "reviewLabel", "redactedValue"]),
  );
  return Object.freeze({
    sourceFieldId: inputIdentifier(safe.sourceFieldId),
    action: "INCLUDE_REDACTED",
    reviewLabel: safe.reviewLabel!,
    redactedValue: safe.redactedValue!,
  });
}

type ArtifactCommand = Readonly<{
  workspaceSlug: string;
  assignmentId: string;
  expectedSubmissionRevisionId: string;
  expectedSubmissionRevisionFingerprint: string;
  expectedConflictSequence: number;
  stage: typeof BLIND_REVIEW_DISCLOSURE_STAGE;
  attestation: typeof BLIND_REVIEW_ATTESTATION;
  idempotencyKey: string;
  decisions: readonly BlindFieldDecisionInput[];
  requestFingerprint: string;
}>;

function snapshotArtifactCommand(input: unknown): ArtifactCommand {
  const safe = jsonObject(safeInput(input, ARTIFACT_INPUT_SAFETY_LIMITS));
  exactKeys(safe, ARTIFACT_INPUT_KEYS);
  if (
    safe.stage !== BLIND_REVIEW_DISCLOSURE_STAGE ||
    safe.attestation !== BLIND_REVIEW_ATTESTATION ||
    typeof safe.expectedConflictSequence !== "number" ||
    !Number.isSafeInteger(safe.expectedConflictSequence) ||
    safe.expectedConflictSequence < 0 ||
    !Array.isArray(safe.decisions)
  ) {
    return fail("SEAL_INPUT_INVALID");
  }
  const decisions = safe.decisions.map(canonicalDecision).sort((left, right) => {
    const fieldOrder = String(left.sourceFieldId).localeCompare(String(right.sourceFieldId));
    return fieldOrder === 0
      ? canonicalJson(left).localeCompare(canonicalJson(right))
      : fieldOrder;
  }) as unknown as readonly BlindFieldDecisionInput[];
  const command = {
    schema: "cfp-review-blind-artifact-seal-request/v1",
    workspaceSlug: inputIdentifier(safe.workspaceSlug),
    assignmentId: inputIdentifier(safe.assignmentId),
    expectedSubmissionRevisionId: inputIdentifier(safe.expectedSubmissionRevisionId),
    expectedSubmissionRevisionFingerprint: inputFingerprint(
      safe.expectedSubmissionRevisionFingerprint,
    ),
    expectedConflictSequence: safe.expectedConflictSequence,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    attestation: BLIND_REVIEW_ATTESTATION,
    idempotencyKey: inputIdentifier(safe.idempotencyKey),
    decisions,
  } as const;
  return Object.freeze({ ...command, requestFingerprint: fingerprintOf(command) });
}

type AuthenticatedOrganizer = Readonly<{
  workspaceId: string;
  workspaceSlug: string;
  accountId: string;
  role: string;
}>;

function authenticateOrganizer(
  db: Db,
  session: SessionSnapshot,
  requestedWorkspaceSlug: string,
): AuthenticatedOrganizer {
  const rows = db
    .prepare(
      `SELECT s.id AS session_id, s.token_hash, s.account_id, s.workspace_id,
              s.created_at AS session_created_at, s.expires_at,
              a.id AS current_account_id, a.workspace_id AS account_workspace_id,
              a.role AS current_role, w.id AS current_workspace_id, w.slug AS workspace_slug,
              typeof(s.id) AS session_id_storage,
              typeof(s.token_hash) AS token_hash_storage,
              typeof(s.account_id) AS session_account_storage,
              typeof(s.workspace_id) AS session_workspace_storage,
              typeof(a.id) AS account_id_storage,
              typeof(a.workspace_id) AS account_workspace_storage,
              typeof(w.id) AS workspace_id_storage,
              typeof(w.slug) AS workspace_slug_storage
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id AND a.workspace_id = s.workspace_id
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = ? OR s.id = CAST(? AS BLOB)
       ORDER BY s.rowid`,
    )
    .all(session.id, session.id) as unknown as Array<Record<string, unknown>>;
  if (rows.length !== 1) return fail("SEAL_AUTHORIZATION_DENIED");

  const row = rows[0]!;
  if (
    row.session_id_storage !== "text" ||
    row.token_hash_storage !== "text" ||
    row.session_account_storage !== "text" ||
    row.session_workspace_storage !== "text" ||
    row.account_id_storage !== "text" ||
    row.account_workspace_storage !== "text" ||
    row.workspace_id_storage !== "text" ||
    row.workspace_slug_storage !== "text"
  ) {
    return fail("SEAL_AUTHORIZATION_DENIED");
  }

  const sessionId = storedIdentifier(row.session_id, "SEAL_AUTHORIZATION_DENIED");
  const tokenHash = storedFingerprint(row.token_hash, "SEAL_AUTHORIZATION_DENIED");
  const accountId = storedIdentifier(row.current_account_id, "SEAL_AUTHORIZATION_DENIED");
  const workspaceId = storedIdentifier(row.current_workspace_id, "SEAL_AUTHORIZATION_DENIED");
  const workspaceSlug = storedIdentifier(row.workspace_slug, "SEAL_AUTHORIZATION_DENIED");
  const expiresAt = canonicalTimestamp(row.expires_at, "SEAL_AUTHORIZATION_DENIED");
  canonicalTimestamp(row.session_created_at, "SEAL_AUTHORIZATION_DENIED");
  if (
    sessionId !== session.id ||
    !equalFixedLength(tokenHash, session.tokenHash) ||
    row.account_id !== accountId ||
    row.account_workspace_id !== workspaceId ||
    row.workspace_id !== workspaceId ||
    requestedWorkspaceSlug !== workspaceSlug ||
    Date.parse(expiresAt) <= Date.parse(nowIso()) ||
    typeof row.current_role !== "string" ||
    row.current_role.length < 1 ||
    Buffer.byteLength(row.current_role, "utf8") > 128 ||
    CONTROL_CHARACTER_PATTERN.test(row.current_role) ||
    !roleHasCapability(row.current_role, "phase0.pipeline.manage")
  ) {
    return fail("SEAL_AUTHORIZATION_DENIED");
  }

  const digestRows = db
    .prepare(
      `SELECT id, token_hash, typeof(id) AS id_storage,
              typeof(token_hash) AS token_hash_storage
       FROM sessions
       WHERE lower(CAST(token_hash AS TEXT)) = ?
       ORDER BY rowid`,
    )
    .all(tokenHash) as unknown as Array<Record<string, unknown>>;
  if (
    digestRows.length !== 1 ||
    digestRows[0]!.id_storage !== "text" ||
    digestRows[0]!.token_hash_storage !== "text" ||
    digestRows[0]!.id !== sessionId ||
    digestRows[0]!.token_hash !== tokenHash
  ) {
    return fail("SEAL_AUTHORIZATION_DENIED");
  }

  return Object.freeze({
    workspaceId,
    workspaceSlug,
    accountId,
    role: row.current_role,
  });
}

class OwnedSealingBoundaryError extends Error {}

function transactionIsOpen(db: Db): boolean {
  try {
    const state = db.isTransaction;
    if (typeof state !== "boolean") throw new Error("invalid transaction state");
    return state;
  } catch (error) {
    if (typeof error === "object" && error !== null && INTERNAL_FATAL_ERRORS.has(error)) {
      throw error;
    }
    throw fatalError();
  }
}

const CLEANUP_ATTEMPTS = 3;

function rollbackOwnedTransaction(db: Db): boolean {
  let cleanupFaulted = false;
  for (const method of ["exec", "prepare"] as const) {
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      if (!transactionIsOpen(db)) return cleanupFaulted;
      try {
        if (method === "exec") db.exec("ROLLBACK");
        else db.prepare("ROLLBACK").run();
      } catch {
        cleanupFaulted = true;
      }
      if (!transactionIsOpen(db)) return cleanupFaulted;
      cleanupFaulted = true;
    }
  }
  if (transactionIsOpen(db)) throw fatalError();
  return cleanupFaulted;
}

function withOwnedTransaction<T>(db: Db, operation: () => T): T {
  if (transactionIsOpen(db)) return fail("SEAL_OUTER_TRANSACTION_FORBIDDEN");
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (transactionIsOpen(db) && rollbackOwnedTransaction(db)) {
      throw fatalError();
    }
    throw error;
  }
  if (!transactionIsOpen(db)) throw new OwnedSealingBoundaryError();

  let result: T;
  try {
    result = operation();
  } catch (error) {
    if (!transactionIsOpen(db)) throw fatalError();
    if (rollbackOwnedTransaction(db)) throw fatalError();
    throw error;
  }

  if (!transactionIsOpen(db)) throw fatalError();
  try {
    db.exec("COMMIT");
  } catch (error) {
    // A driver can end the transaction before surfacing a COMMIT failure. At that point we cannot
    // distinguish an applied commit from an automatic rollback, so returning the in-memory result
    // would manufacture a success receipt for an indeterminate durable effect.
    if (!transactionIsOpen(db)) throw fatalError();
    if (rollbackOwnedTransaction(db)) throw fatalError();
    throw error;
  }
  if (!transactionIsOpen(db)) return result;
  if (rollbackOwnedTransaction(db)) throw fatalError();
  throw new OwnedSealingBoundaryError();
}

type IdempotencyLookupRow = {
  readonly id: unknown;
  readonly request_fingerprint: unknown;
};

function lookupIdempotency(
  db: Db,
  table: "review_rubric_semantics" | "review_blind_artifacts",
  organizer: AuthenticatedOrganizer,
  idempotencyKey: string,
  requestFingerprint: string,
): string | null {
  const rows = db
    .prepare(
      `SELECT id, request_fingerprint
       FROM ${table}
       WHERE workspace_id = ? AND issued_by_account_id = ? AND idempotency_key = ?`,
    )
    .all(organizer.workspaceId, organizer.accountId, idempotencyKey) as unknown as
    IdempotencyLookupRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1) return fail("SEAL_READ_FAILED");
  const id = storedIdentifier(rows[0]!.id, "SEAL_READ_FAILED");
  const storedRequestFingerprint = storedFingerprint(
    rows[0]!.request_fingerprint,
    "SEAL_READ_FAILED",
  );
  if (!equalFixedLength(storedRequestFingerprint, requestFingerprint)) {
    return fail("SEAL_IDEMPOTENCY_CONFLICT");
  }
  return id;
}

type SemanticsRow = Record<string, unknown>;

function loadSemanticsRow(db: Db, semanticsId: string): SemanticsRow {
  const rows = db
    .prepare("SELECT * FROM review_rubric_semantics WHERE id = ?")
    .all(semanticsId) as unknown as SemanticsRow[];
  if (rows.length !== 1) return fail("SEAL_READ_FAILED");
  return rows[0]!;
}

function verifySemanticsRow(row: SemanticsRow) {
  try {
    const document = parseCanonicalReviewRubricSemantics(
      typeof row.semantics_json === "string" ? row.semantics_json : "",
    );
    const id = storedIdentifier(row.id, "SEAL_READ_FAILED");
    const workspaceId = storedIdentifier(row.workspace_id, "SEAL_READ_FAILED");
    const roundId = storedIdentifier(row.round_id, "SEAL_READ_FAILED");
    const rubricVersionId = storedIdentifier(row.rubric_version_id, "SEAL_READ_FAILED");
    const rubricVersionNumber = storedPositiveInteger(
      row.rubric_version_number,
      "SEAL_READ_FAILED",
    );
    const rubricFingerprint = storedFingerprint(
      row.rubric_version_fingerprint,
      "SEAL_READ_FAILED",
    );
    const fingerprint = storedFingerprint(row.fingerprint, "SEAL_READ_FAILED");
    const issuedBy = storedIdentifier(row.issued_by_account_id, "SEAL_READ_FAILED");
    const idempotencyKey = storedIdentifier(row.idempotency_key, "SEAL_READ_FAILED");
    storedFingerprint(row.request_fingerprint, "SEAL_READ_FAILED");
    const issuedAt = canonicalTimestamp(row.issued_at, "SEAL_READ_FAILED");
    if (
      row.semantics_schema !== CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA ||
      row.semantics_version !== 1 ||
      row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
      row.request_fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
      row.issuer_authority !== REVIEW_ISSUER_AUTHORITY ||
      document.workspaceId !== workspaceId ||
      document.roundId !== roundId ||
      document.rubricVersionId !== rubricVersionId ||
      document.rubricVersionNumber !== rubricVersionNumber ||
      document.rubricVersionFingerprint !== rubricFingerprint ||
      document.issuer.accountId !== issuedBy ||
      document.issuer.role !== row.issuer_role ||
      document.issuer.authority !== row.issuer_authority ||
      document.issuedAt !== issuedAt ||
      fingerprintReviewRubricSemantics(document) !== fingerprint ||
      canonicalReviewRubricSemanticsJson(document) !== row.semantics_json
    ) {
      return fail("SEAL_READ_FAILED");
    }
    return Object.freeze({
      id,
      workspaceId,
      roundId,
      rubricVersionId,
      rubricVersionNumber,
      rubricFingerprint,
      fingerprint,
      issuedBy,
      issuerRole: row.issuer_role,
      idempotencyKey,
      issuedAt,
      document,
    });
  } catch (error) {
    if (
      error instanceof OrganizerSealingError &&
      INTERNAL_SEALING_ERRORS.has(error)
    ) {
      throw error;
    }
    return fail("SEAL_READ_FAILED");
  }
}

function replayRubricReceipt(
  db: Db,
  semanticsId: string,
  organizer: AuthenticatedOrganizer,
  command: RubricCommand,
): RubricSemanticsSealReceipt {
  const verified = verifySemanticsRow(loadSemanticsRow(db, semanticsId));
  if (
    verified.workspaceId !== organizer.workspaceId ||
    verified.issuedBy !== organizer.accountId ||
    verified.idempotencyKey !== command.idempotencyKey ||
    verified.rubricVersionId !== command.rubricVersionId
  ) {
    return fail("SEAL_READ_FAILED");
  }
  return Object.freeze({
    semanticsId: verified.id,
    rubricVersionId: verified.rubricVersionId,
    rubricVersionNumber: verified.rubricVersionNumber,
    issuedAt: verified.issuedAt,
    replayed: true,
  });
}

type RubricTarget = Readonly<{
  workspaceId: string;
  roundId: string;
  rubricVersionId: string;
  rubricVersionNumber: number;
  rubricFingerprint: string;
  roundState: string;
}>;

function loadRubricTarget(
  db: Db,
  workspaceId: string,
  rubricVersionId: string,
): RubricTarget {
  const rows = db
    .prepare(
      `SELECT rubric.workspace_id, rubric.round_id, rubric.id AS rubric_version_id,
              rubric.version_number, rubric.rubric_schema, rubric.fingerprint_algorithm,
              rubric.fingerprint,
              (SELECT state FROM review_round_states
               WHERE round_id = rubric.round_id
               ORDER BY sequence_number DESC LIMIT 1) AS round_state
       FROM rubric_versions rubric
       JOIN review_rounds round
         ON round.id = rubric.round_id AND round.workspace_id = rubric.workspace_id
       WHERE rubric.workspace_id = ? AND rubric.id = ?`,
    )
    .all(workspaceId, rubricVersionId) as unknown as Array<Record<string, unknown>>;
  if (rows.length !== 1) return fail("SEAL_TARGET_UNAVAILABLE");
  const row = rows[0]!;
  if (
    row.rubric_schema !== "cfp-rubric/v1" ||
    row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    typeof row.round_state !== "string"
  ) {
    return fail("SEAL_READ_FAILED");
  }
  return Object.freeze({
    workspaceId: storedIdentifier(row.workspace_id, "SEAL_READ_FAILED"),
    roundId: storedIdentifier(row.round_id, "SEAL_READ_FAILED"),
    rubricVersionId: storedIdentifier(row.rubric_version_id, "SEAL_READ_FAILED"),
    rubricVersionNumber: storedPositiveInteger(row.version_number, "SEAL_READ_FAILED"),
    rubricFingerprint: storedFingerprint(row.fingerprint, "SEAL_READ_FAILED"),
    roundState: row.round_state,
  });
}

function assertNoSemanticsSeal(db: Db, rubricVersionId: string): void {
  const rows = db
    .prepare("SELECT id FROM review_rubric_semantics WHERE rubric_version_id = ?")
    .all(rubricVersionId) as unknown as Array<{ id: unknown }>;
  if (rows.length > 1) return fail("SEAL_READ_FAILED");
  if (rows.length === 1) {
    storedIdentifier(rows[0]!.id, "SEAL_READ_FAILED");
    return fail("RUBRIC_SEMANTICS_IMMUTABLE");
  }
}

type AuditExpectation = Readonly<{
  action: string;
  targetType: string;
  details: Readonly<Record<string, unknown>>;
}>;

function auditCount(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as
    | { count?: unknown }
    | undefined;
  return storedNonNegativeInteger(row?.count, "SEAL_WRITE_FAILED");
}

function writeAndVerifyAudit(
  db: Db,
  workspaceId: string,
  expectation: AuditExpectation,
): void {
  const before = auditCount(db);
  writeAudit(db, workspaceId, {
    actorKind: "system",
    actorRef: "organizer-sealing-service",
    action: expectation.action,
    targetType: expectation.targetType,
    details: { ...expectation.details },
  });
  if (auditCount(db) !== before + 1) return fail("SEAL_WRITE_FAILED");
  const row = db
    .prepare(
      `SELECT workspace_id, actor_kind, actor_ref, action, target_type, target_id,
              details_json, created_at
       FROM audit_events ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (
    !row ||
    row.workspace_id !== workspaceId ||
    row.actor_kind !== "system" ||
    row.actor_ref !== "organizer-sealing-service" ||
    row.action !== expectation.action ||
    row.target_type !== expectation.targetType ||
    row.target_id !== null ||
    row.details_json !== JSON.stringify(expectation.details)
  ) {
    return fail("SEAL_WRITE_FAILED");
  }
  canonicalTimestamp(row.created_at, "SEAL_WRITE_FAILED");
}

function readSingleRow(db: Db, table: string, id: string): Record<string, unknown> {
  const rows = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).all(id) as unknown as Array<
    Record<string, unknown>
  >;
  if (rows.length !== 1) return fail("SEAL_WRITE_FAILED");
  return rows[0]!;
}

function assertBindings(
  row: Record<string, unknown>,
  expected: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (row[key] !== value) return fail("SEAL_WRITE_FAILED");
  }
}

function insertSemanticsSeal(
  db: Db,
  organizer: AuthenticatedOrganizer,
  command: RubricCommand,
  target: RubricTarget,
): RubricSemanticsSealReceipt {
  const criteria = normalizeSealCriteria(command.criteria);
  const issuedAt = nowIso();
  canonicalTimestamp(issuedAt, "SEAL_WRITE_FAILED");
  const semanticsId = uuid();
  storedIdentifier(semanticsId, "SEAL_WRITE_FAILED");
  const document = normalizeReviewRubricSemantics({
    schema: CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
    version: 1,
    workspaceId: organizer.workspaceId,
    roundId: target.roundId,
    rubricVersionId: target.rubricVersionId,
    rubricVersionNumber: target.rubricVersionNumber,
    rubricVersionFingerprint: target.rubricFingerprint,
    criteria,
    issuer: {
      accountId: organizer.accountId,
      role: organizer.role,
      authority: REVIEW_ISSUER_AUTHORITY,
    },
    issuedAt,
  });
  const semanticsJson = canonicalReviewRubricSemanticsJson(document);
  const semanticsFingerprint = fingerprintReviewRubricSemantics(document);
  const inserted = db
    .prepare(
      `INSERT INTO review_rubric_semantics
         (id, workspace_id, round_id, rubric_version_id, rubric_version_number,
          rubric_version_fingerprint, semantics_schema, semantics_version, semantics_json,
          fingerprint_algorithm, fingerprint, issued_by_account_id, issuer_role,
          issuer_authority, idempotency_key, request_fingerprint_algorithm,
          request_fingerprint, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      semanticsId,
      organizer.workspaceId,
      target.roundId,
      target.rubricVersionId,
      target.rubricVersionNumber,
      target.rubricFingerprint,
      CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
      1,
      semanticsJson,
      CFP_REVIEW_FINGERPRINT_ALGORITHM,
      semanticsFingerprint,
      organizer.accountId,
      organizer.role,
      REVIEW_ISSUER_AUTHORITY,
      command.idempotencyKey,
      CFP_REVIEW_FINGERPRINT_ALGORITHM,
      command.requestFingerprint,
      issuedAt,
    );
  if (inserted.changes !== 1) return fail("SEAL_WRITE_FAILED");

  const expectedBindings = Object.freeze({
    id: semanticsId,
    workspace_id: organizer.workspaceId,
    round_id: target.roundId,
    rubric_version_id: target.rubricVersionId,
    rubric_version_number: target.rubricVersionNumber,
    rubric_version_fingerprint: target.rubricFingerprint,
    semantics_schema: CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
    semantics_version: 1,
    semantics_json: semanticsJson,
    fingerprint_algorithm: CFP_REVIEW_FINGERPRINT_ALGORITHM,
    fingerprint: semanticsFingerprint,
    issued_by_account_id: organizer.accountId,
    issuer_role: organizer.role,
    issuer_authority: REVIEW_ISSUER_AUTHORITY,
    idempotency_key: command.idempotencyKey,
    request_fingerprint_algorithm: CFP_REVIEW_FINGERPRINT_ALGORITHM,
    request_fingerprint: command.requestFingerprint,
    issued_at: issuedAt,
  });
  const stored = readSingleRow(db, "review_rubric_semantics", semanticsId);
  assertBindings(stored, expectedBindings);
  const verified = verifySemanticsRow(stored);
  if (
    verified.id !== semanticsId ||
    verified.fingerprint !== semanticsFingerprint ||
    canonicalJson(verified.document) !== semanticsJson
  ) {
    return fail("SEAL_WRITE_FAILED");
  }
  writeAndVerifyAudit(db, organizer.workspaceId, {
    action: "cfp.review.rubric-semantics.seal",
    targetType: "review_rubric_semantics",
    details: Object.freeze({
      operation: "seal_rubric_semantics",
      status: "PERMITTED",
      objectKind: "review_rubric_semantics",
      criteriaCount: criteria.length,
    }),
  });
  const receipt = Object.freeze({
    semanticsId,
    rubricVersionId: target.rubricVersionId,
    rubricVersionNumber: target.rubricVersionNumber,
    issuedAt,
    replayed: false,
  });
  if (
    receipt.semanticsId !== verified.id ||
    receipt.rubricVersionId !== verified.rubricVersionId ||
    receipt.rubricVersionNumber !== verified.rubricVersionNumber ||
    receipt.issuedAt !== verified.issuedAt
  ) {
    return fail("SEAL_WRITE_FAILED");
  }
  return receipt;
}

function sealRubricSemanticsInternal(
  db: Db,
  session: SessionInfo,
  input: SealRubricSemanticsInput,
): RubricSemanticsSealReceipt {
  const sessionSnapshot = snapshotSession(session);
  const command = snapshotRubricCommand(input);
  return withOwnedTransaction(db, () => {
    const organizer = authenticateOrganizer(db, sessionSnapshot, command.workspaceSlug);
    const replayId = lookupIdempotency(
      db,
      "review_rubric_semantics",
      organizer,
      command.idempotencyKey,
      command.requestFingerprint,
    );
    if (replayId !== null) return replayRubricReceipt(db, replayId, organizer, command);

    const target = loadRubricTarget(db, organizer.workspaceId, command.rubricVersionId);
    assertNoSemanticsSeal(db, target.rubricVersionId);
    if (!equalFixedLength(target.rubricFingerprint, command.expectedRubricFingerprint)) {
      return fail("RUBRIC_VERSION_STALE");
    }
    if (target.roundState !== "DRAFT" && target.roundState !== "OPEN") {
      return fail("REVIEW_ROUND_NOT_SEALABLE");
    }
    return insertSemanticsSeal(db, organizer, command, target);
  });
}

/**
 * Compose custom-rubric semantics issuance into an already-owned distribution
 * transaction. This deliberately does not open or commit a transaction.
 */
function ensureCustomReviewRubricSemanticsInTransaction(
  db: Db,
  input: EnsureCustomReviewRubricSemanticsInput,
): Readonly<{
  readonly semanticsId: string;
  readonly semanticsFingerprint: string;
  readonly issuedAt: string;
  readonly replayed: boolean;
}> {
  if (!transactionIsOpen(db)) return fail("SEAL_OUTER_TRANSACTION_FORBIDDEN");
  const issuer = authenticateOrganizer(
    db,
    snapshotSession(input.issuer.session),
    input.issuer.workspaceSlug,
  );
  const customRubric = normalizeCustomReviewRubricDocument(input.customRubric);
  if (fingerprintOf(customRubric) !== input.rubricVersionFingerprint) {
    return fail("RUBRIC_VERSION_STALE");
  }
  const existingRows = db
    .prepare(
      `SELECT id
       FROM review_rubric_semantics
       WHERE workspace_id = ? AND rubric_version_id = ?`,
    )
    .all(issuer.workspaceId, input.rubricVersionId) as Array<{ id: unknown }>;
  if (existingRows.length > 1) return fail("SEAL_READ_FAILED");
  if (existingRows.length === 1) {
    const existing = verifySemanticsRow(
      loadSemanticsRow(db, storedIdentifier(existingRows[0]!.id, "SEAL_READ_FAILED")),
    );
    if (
      existing.workspaceId !== issuer.workspaceId ||
      existing.roundId !== input.roundId ||
      existing.rubricVersionId !== input.rubricVersionId ||
      existing.rubricVersionNumber !== input.rubricVersionNumber ||
      existing.rubricFingerprint !== input.rubricVersionFingerprint ||
      existing.document.customRubric === undefined ||
      fingerprintOf(existing.document.customRubric) !== input.rubricVersionFingerprint
    ) {
      return fail("SEAL_READ_FAILED");
    }
    return Object.freeze({
      semanticsId: existing.id,
      semanticsFingerprint: existing.fingerprint,
      issuedAt: existing.issuedAt,
      replayed: true,
    });
  }

  const rubricVersionId = storedIdentifier(input.rubricVersionId, "SEAL_INPUT_INVALID");
  const roundId = storedIdentifier(input.roundId, "SEAL_INPUT_INVALID");
  const rubricVersionNumber = storedPositiveInteger(
    input.rubricVersionNumber,
    "SEAL_INPUT_INVALID",
  );
  const rubricVersionFingerprint = storedFingerprint(
    input.rubricVersionFingerprint,
    "SEAL_INPUT_INVALID",
  );
  const semanticsId = deterministicUuid(
    `cfp-review-custom-rubric-semantics:${issuer.workspaceId}:${rubricVersionId}:${rubricVersionFingerprint}`,
  );
  const issuedAt = nowIso();
  const document = normalizeReviewRubricSemantics({
    schema: CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
    version: 1,
    workspaceId: issuer.workspaceId,
    roundId,
    rubricVersionId,
    rubricVersionNumber,
    rubricVersionFingerprint,
    criteria: [],
    customRubric,
    issuer: {
      accountId: issuer.accountId,
      role: issuer.role,
      authority: REVIEW_ISSUER_AUTHORITY,
    },
    issuedAt,
  });
  const semanticsJson = canonicalReviewRubricSemanticsJson(document);
  const semanticsFingerprint = fingerprintReviewRubricSemantics(document);
  const idempotencyKey = `custom-rubric-semantics:${rubricVersionFingerprint}`;
  const requestFingerprint = fingerprintOf({
    schema: "cfp-review-custom-rubric-semantics-request/v1",
    workspaceId: issuer.workspaceId,
    roundId,
    rubricVersionId,
    rubricVersionNumber,
    rubricVersionFingerprint,
    customRubric,
  });
  const inserted = db
    .prepare(
      `INSERT INTO review_rubric_semantics
         (id, workspace_id, round_id, rubric_version_id, rubric_version_number,
          rubric_version_fingerprint, semantics_schema, semantics_version, semantics_json,
          fingerprint_algorithm, fingerprint, issued_by_account_id, issuer_role,
          issuer_authority, idempotency_key, request_fingerprint_algorithm,
          request_fingerprint, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      semanticsId,
      issuer.workspaceId,
      roundId,
      rubricVersionId,
      rubricVersionNumber,
      rubricVersionFingerprint,
      CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
      1,
      semanticsJson,
      CFP_REVIEW_FINGERPRINT_ALGORITHM,
      semanticsFingerprint,
      issuer.accountId,
      issuer.role,
      REVIEW_ISSUER_AUTHORITY,
      idempotencyKey,
      CFP_REVIEW_FINGERPRINT_ALGORITHM,
      requestFingerprint,
      issuedAt,
    );
  if (inserted.changes !== 1) return fail("SEAL_WRITE_FAILED");
  const stored = readSingleRow(db, "review_rubric_semantics", semanticsId);
  assertBindings(stored, {
    id: semanticsId,
    workspace_id: issuer.workspaceId,
    round_id: roundId,
    rubric_version_id: rubricVersionId,
    rubric_version_number: rubricVersionNumber,
    rubric_version_fingerprint: rubricVersionFingerprint,
    semantics_schema: CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
    semantics_version: 1,
    semantics_json: semanticsJson,
    fingerprint_algorithm: CFP_REVIEW_FINGERPRINT_ALGORITHM,
    fingerprint: semanticsFingerprint,
    issued_by_account_id: issuer.accountId,
    issuer_role: issuer.role,
    issuer_authority: REVIEW_ISSUER_AUTHORITY,
    idempotency_key: idempotencyKey,
    request_fingerprint_algorithm: CFP_REVIEW_FINGERPRINT_ALGORITHM,
    request_fingerprint: requestFingerprint,
    issued_at: issuedAt,
  });
  const verified = verifySemanticsRow(stored);
  if (
    verified.id !== semanticsId ||
    verified.fingerprint !== semanticsFingerprint ||
    verified.issuedAt !== issuedAt
  ) {
    return fail("SEAL_WRITE_FAILED");
  }
  writeAndVerifyAudit(db, issuer.workspaceId, {
    action: "cfp.review.rubric-semantics.seal",
    targetType: "review_rubric_semantics",
    details: Object.freeze({
      operation: "issue_custom_rubric_semantics",
      status: "PERMITTED",
      objectKind: "review_rubric_semantics",
      customRubric: true,
      criteriaCount: customRubric.fields.length,
    }),
  });
  return Object.freeze({
    semanticsId,
    semanticsFingerprint,
    issuedAt,
    replayed: false,
  });
}

type ArtifactRow = Record<string, unknown>;

function loadArtifactRow(db: Db, artifactId: string): ArtifactRow {
  const rows = db
    .prepare("SELECT * FROM review_blind_artifacts WHERE id = ?")
    .all(artifactId) as unknown as ArtifactRow[];
  if (rows.length !== 1) return fail("SEAL_READ_FAILED");
  return rows[0]!;
}

function verifyArtifactRow(row: ArtifactRow) {
  try {
    const document = parseCanonicalBlindReviewArtifact(
      typeof row.artifact_json === "string" ? row.artifact_json : "",
    );
    const id = storedIdentifier(row.id, "SEAL_READ_FAILED");
    const workspaceId = storedIdentifier(row.workspace_id, "SEAL_READ_FAILED");
    const assignmentId = storedIdentifier(row.assignment_id, "SEAL_READ_FAILED");
    const assignmentCreatedAt = canonicalTimestamp(
      row.assignment_created_at,
      "SEAL_READ_FAILED",
    );
    const rubricVersionId = storedIdentifier(row.rubric_version_id, "SEAL_READ_FAILED");
    const semanticsId = storedIdentifier(row.rubric_semantics_id, "SEAL_READ_FAILED");
    const semanticsFingerprint = storedFingerprint(
      row.rubric_semantics_fingerprint,
      "SEAL_READ_FAILED",
    );
    const submissionId = storedIdentifier(row.submission_id, "SEAL_READ_FAILED");
    const revisionId = storedIdentifier(row.submission_revision_id, "SEAL_READ_FAILED");
    const revisionNumber = storedPositiveInteger(
      row.submission_revision_number,
      "SEAL_READ_FAILED",
    );
    const revisionFingerprint = storedFingerprint(
      row.submission_revision_fingerprint,
      "SEAL_READ_FAILED",
    );
    const revisionCreatedAt = canonicalTimestamp(
      row.submission_revision_created_at,
      "SEAL_READ_FAILED",
    );
    const formVersionId = storedIdentifier(row.form_version_id, "SEAL_READ_FAILED");
    const ruleVersionId = storedIdentifier(row.rule_version_id, "SEAL_READ_FAILED");
    const formFingerprint = storedFingerprint(
      row.form_document_fingerprint,
      "SEAL_READ_FAILED",
    );
    const conflictSequence = storedNonNegativeInteger(
      row.conflict_sequence_at_issuance,
      "SEAL_READ_FAILED",
    );
    const fingerprint = storedFingerprint(row.fingerprint, "SEAL_READ_FAILED");
    const issuedBy = storedIdentifier(row.issued_by_account_id, "SEAL_READ_FAILED");
    const idempotencyKey = storedIdentifier(row.idempotency_key, "SEAL_READ_FAILED");
    const requestFingerprint = storedFingerprint(
      row.request_fingerprint,
      "SEAL_READ_FAILED",
    );
    const issuedAt = canonicalTimestamp(row.issued_at, "SEAL_READ_FAILED");
    const conflictStatus = row.conflict_status_at_issuance;
    if (
      conflictStatus !== "NONE" &&
      conflictStatus !== "CLEARED" &&
      conflictStatus !== "WAIVED"
    ) {
      return fail("SEAL_READ_FAILED");
    }
    if (
      row.submission_revision_schema !== CFP_SUBMISSION_REVISION_SCHEMA ||
      row.submission_revision_fingerprint_algorithm !==
        CFP_REVIEW_FINGERPRINT_ALGORITHM ||
      row.form_document_schema !== "cfp-form-document/v1" ||
      row.disclosure_stage !== BLIND_REVIEW_DISCLOSURE_STAGE ||
      row.artifact_schema !== CFP_REVIEW_BLIND_ARTIFACT_SCHEMA ||
      row.artifact_version !== 1 ||
      row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
      row.blind_safety_attestation !== BLIND_REVIEW_ATTESTATION ||
      row.issuer_authority !== REVIEW_ISSUER_AUTHORITY ||
      row.request_fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
      document.workspaceId !== workspaceId ||
      document.assignmentId !== assignmentId ||
      document.assignmentCreatedAt !== assignmentCreatedAt ||
      document.rubricVersionId !== rubricVersionId ||
      document.rubricSemanticsId !== semanticsId ||
      document.rubricSemanticsFingerprint !== semanticsFingerprint ||
      document.submissionId !== submissionId ||
      document.submissionRevision.id !== revisionId ||
      document.submissionRevision.number !== revisionNumber ||
      document.submissionRevision.schema !== row.submission_revision_schema ||
      document.submissionRevision.fingerprint !== revisionFingerprint ||
      document.submissionRevision.createdAt !== revisionCreatedAt ||
      document.submissionRevision.formDocumentSchema !== row.form_document_schema ||
      document.submissionRevision.formVersionId !== formVersionId ||
      document.submissionRevision.ruleVersionId !== ruleVersionId ||
      document.submissionRevision.formDocumentFingerprint !== formFingerprint ||
      document.disclosureStage !== row.disclosure_stage ||
      document.conflictAtIssuance.status !== conflictStatus ||
      document.conflictAtIssuance.sequenceNumber !== conflictSequence ||
      document.attestation !== row.blind_safety_attestation ||
      document.issuer.accountId !== issuedBy ||
      document.issuer.role !== row.issuer_role ||
      document.issuer.authority !== row.issuer_authority ||
      document.issuedAt !== issuedAt ||
      fingerprintBlindReviewArtifact(document) !== fingerprint ||
      canonicalBlindReviewArtifactJson(document) !== row.artifact_json
    ) {
      return fail("SEAL_READ_FAILED");
    }
    const includedCount = document.items.filter(
      (item) => item.disposition === "INCLUDE_REDACTED",
    ).length;
    return Object.freeze({
      id,
      workspaceId,
      assignmentId,
      assignmentCreatedAt,
      rubricVersionId,
      semanticsId,
      semanticsFingerprint,
      submissionId,
      revisionId,
      revisionNumber,
      revisionFingerprint,
      revisionCreatedAt,
      formVersionId,
      ruleVersionId,
      formFingerprint,
      conflictStatus,
      conflictSequence,
      fingerprint,
      issuedBy,
      idempotencyKey,
      requestFingerprint,
      issuedAt,
      includedCount,
      excludedCount: document.items.length - includedCount,
      document,
    });
  } catch (error) {
    if (
      error instanceof OrganizerSealingError &&
      INTERNAL_SEALING_ERRORS.has(error)
    ) {
      throw error;
    }
    return fail("SEAL_READ_FAILED");
  }
}

function replayArtifactReceipt(
  db: Db,
  artifactId: string,
  organizer: AuthenticatedOrganizer,
  command: ArtifactCommand,
): BlindReviewArtifactSealReceipt {
  const verified = verifyArtifactRow(loadArtifactRow(db, artifactId));
  if (
    verified.workspaceId !== organizer.workspaceId ||
    verified.issuedBy !== organizer.accountId ||
    verified.idempotencyKey !== command.idempotencyKey ||
    verified.assignmentId !== command.assignmentId ||
    verified.revisionId !== command.expectedSubmissionRevisionId
  ) {
    return fail("SEAL_READ_FAILED");
  }
  return Object.freeze({
    artifactId: verified.id,
    assignmentId: verified.assignmentId,
    submissionRevisionId: verified.revisionId,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    includedCount: verified.includedCount,
    excludedCount: verified.excludedCount,
    issuedAt: verified.issuedAt,
    replayed: true,
  });
}

function matchingAssignmentArtifactReceipt(
  db: Db,
  organizer: AuthenticatedOrganizer,
  command: ArtifactCommand,
): BlindReviewArtifactSealReceipt | null {
  const rows = db
    .prepare(
      `SELECT id
       FROM review_blind_artifacts
       WHERE workspace_id = ? AND assignment_id = ?`,
    )
    .all(organizer.workspaceId, command.assignmentId) as unknown as Array<{
      readonly id: unknown;
    }>;
  if (rows.length === 0) return null;
  if (rows.length !== 1) return fail("SEAL_READ_FAILED");

  const artifactId = storedIdentifier(rows[0]!.id, "SEAL_READ_FAILED");
  const verified = verifyArtifactRow(loadArtifactRow(db, artifactId));
  if (
    verified.workspaceId !== organizer.workspaceId ||
    verified.assignmentId !== command.assignmentId ||
    verified.revisionId !== command.expectedSubmissionRevisionId ||
    !equalFixedLength(
      verified.revisionFingerprint,
      command.expectedSubmissionRevisionFingerprint,
    )
  ) {
    return fail("SUBMISSION_REVISION_STALE");
  }

  const originalCommand = snapshotArtifactCommand({
    workspaceSlug: organizer.workspaceSlug,
    assignmentId: verified.assignmentId,
    expectedSubmissionRevisionId: verified.revisionId,
    expectedSubmissionRevisionFingerprint: verified.revisionFingerprint,
    expectedConflictSequence: verified.conflictSequence,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    attestation: BLIND_REVIEW_ATTESTATION,
    idempotencyKey: verified.idempotencyKey,
    decisions: command.decisions,
  });
  if (!equalFixedLength(originalCommand.requestFingerprint, verified.requestFingerprint)) {
    return fail("BLIND_ARTIFACT_IMMUTABLE");
  }

  return Object.freeze({
    artifactId: verified.id,
    assignmentId: verified.assignmentId,
    submissionRevisionId: verified.revisionId,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    includedCount: verified.includedCount,
    excludedCount: verified.excludedCount,
    issuedAt: verified.issuedAt,
    replayed: true,
  });
}

type ArtifactTarget = Readonly<{
  workspaceId: string;
  assignmentId: string;
  assignmentCreatedAt: string;
  roundId: string;
  rubricVersionId: string;
  submissionId: string;
  revisionId: string;
  submissionState: string;
  currentRevisionId: string;
  roundState: string;
  assignmentState: string;
  hasSuccessor: boolean;
  semanticsId: string;
  semanticsFingerprint: string;
}>;

function loadArtifactTarget(
  db: Db,
  workspaceId: string,
  assignmentId: string,
): ArtifactTarget {
  const rows = db
    .prepare(
      `SELECT assignment.workspace_id, assignment.id AS assignment_id,
              assignment.created_at AS assignment_created_at, assignment.round_id,
              assignment.rubric_version_id, assignment.submission_id,
              assignment.submission_revision_id,
              submission.state AS submission_state,
              submission.current_revision_id AS current_revision_id,
              semantics.id AS semantics_id, semantics.fingerprint AS semantics_fingerprint,
              (SELECT state FROM review_round_states
               WHERE round_id = assignment.round_id
               ORDER BY sequence_number DESC LIMIT 1) AS round_state,
              (SELECT state FROM review_assignment_states
               WHERE assignment_id = assignment.id
               ORDER BY sequence_number DESC LIMIT 1) AS assignment_state,
              EXISTS(SELECT 1 FROM review_assignments successor
                     WHERE successor.supersedes_assignment_id = assignment.id) AS has_successor
       FROM review_assignments assignment
       JOIN review_rounds round
         ON round.id = assignment.round_id AND round.workspace_id = assignment.workspace_id
       JOIN rubric_versions rubric
         ON rubric.id = assignment.rubric_version_id
        AND rubric.workspace_id = assignment.workspace_id
        AND rubric.round_id = assignment.round_id
       JOIN submissions submission
         ON submission.id = assignment.submission_id
        AND submission.workspace_id = assignment.workspace_id
       LEFT JOIN review_rubric_semantics semantics
         ON semantics.workspace_id = assignment.workspace_id
        AND semantics.round_id = assignment.round_id
        AND semantics.rubric_version_id = assignment.rubric_version_id
       WHERE assignment.workspace_id = ? AND assignment.id = ?`,
    )
    .all(workspaceId, assignmentId) as unknown as Array<Record<string, unknown>>;
  if (rows.length !== 1) return fail("SEAL_TARGET_UNAVAILABLE");
  const row = rows[0]!;
  if (typeof row.round_state !== "string" || typeof row.assignment_state !== "string") {
    return fail("SEAL_READ_FAILED");
  }
  if (row.semantics_id === null || row.semantics_fingerprint === null) {
    return fail("RUBRIC_SEMANTICS_MISSING");
  }
  return Object.freeze({
    workspaceId: storedIdentifier(row.workspace_id, "SEAL_READ_FAILED"),
    assignmentId: storedIdentifier(row.assignment_id, "SEAL_READ_FAILED"),
    assignmentCreatedAt: canonicalTimestamp(
      row.assignment_created_at,
      "SEAL_READ_FAILED",
    ),
    roundId: storedIdentifier(row.round_id, "SEAL_READ_FAILED"),
    rubricVersionId: storedIdentifier(row.rubric_version_id, "SEAL_READ_FAILED"),
    submissionId: storedIdentifier(row.submission_id, "SEAL_READ_FAILED"),
    revisionId: storedIdentifier(row.submission_revision_id, "SEAL_READ_FAILED"),
    submissionState:
      typeof row.submission_state === "string"
        ? row.submission_state
        : fail("SEAL_READ_FAILED"),
    currentRevisionId: storedIdentifier(row.current_revision_id, "SEAL_READ_FAILED"),
    roundState: row.round_state,
    assignmentState: row.assignment_state,
    hasSuccessor: row.has_successor === 1,
    semanticsId: storedIdentifier(row.semantics_id, "SEAL_READ_FAILED"),
    semanticsFingerprint: storedFingerprint(
      row.semantics_fingerprint,
      "SEAL_READ_FAILED",
    ),
  });
}

function assertNoArtifactSeal(db: Db, assignmentId: string): void {
  const rows = db
    .prepare("SELECT id FROM review_blind_artifacts WHERE assignment_id = ?")
    .all(assignmentId) as unknown as Array<{ id: unknown }>;
  if (rows.length > 1) return fail("SEAL_READ_FAILED");
  if (rows.length === 1) {
    storedIdentifier(rows[0]!.id, "SEAL_READ_FAILED");
    return fail("BLIND_ARTIFACT_IMMUTABLE");
  }
}

function authoritativeConflict(
  db: Db,
  target: ArtifactTarget,
  expectedSequence: number,
): Readonly<{ status: BlindArtifactConflictStatus; sequenceNumber: number }> {
  const rows = db
    .prepare(
      `SELECT workspace_id, assignment_id, action, sequence_number
       FROM review_conflict_dispositions
       WHERE workspace_id = ? AND assignment_id = ?
       ORDER BY sequence_number DESC LIMIT 1`,
    )
    .all(target.workspaceId, target.assignmentId) as unknown as Array<
    Record<string, unknown>
  >;
  if (rows.length === 0) {
    if (expectedSequence !== 0) return fail("REVIEW_CONFLICT_STALE");
    return Object.freeze({ status: "NONE", sequenceNumber: 0 });
  }
  if (rows.length !== 1) return fail("SEAL_READ_FAILED");
  const row = rows[0]!;
  if (row.workspace_id !== target.workspaceId || row.assignment_id !== target.assignmentId) {
    return fail("SEAL_READ_FAILED");
  }
  const sequenceNumber = storedPositiveInteger(row.sequence_number, "SEAL_READ_FAILED");
  if (row.action === "DECLARE") return fail("REVIEW_CONFLICT_DECLARED");
  if (sequenceNumber !== expectedSequence) return fail("REVIEW_CONFLICT_STALE");
  if (row.action === "CLEAR") {
    return Object.freeze({ status: "CLEARED", sequenceNumber });
  }
  if (row.action === "WAIVE") {
    return Object.freeze({ status: "WAIVED", sequenceNumber });
  }
  return fail("SEAL_READ_FAILED");
}

type RevisionMetadata = Readonly<{
  createdAt: string;
  formVersionId: string;
  ruleVersionId: string;
  formFingerprint: string;
}>;

function loadRevisionMetadata(
  db: Db,
  target: ArtifactTarget,
  revision: ReturnType<typeof readSubmissionRevision>,
): RevisionMetadata {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, submission_id, revision_number, revision_schema,
              fingerprint_algorithm, fingerprint, created_at, form_document_schema,
              form_version_id, rule_version_id, form_document_fingerprint
       FROM submission_revisions
       WHERE workspace_id = ? AND id = ?`,
    )
    .all(target.workspaceId, target.revisionId) as unknown as Array<Record<string, unknown>>;
  if (rows.length !== 1) return fail("SEAL_READ_FAILED");
  const row = rows[0]!;
  if (
    row.id !== target.revisionId ||
    row.workspace_id !== target.workspaceId ||
    row.submission_id !== target.submissionId ||
    row.revision_number !== revision.revisionNumber ||
    row.revision_schema !== revision.schema ||
    row.fingerprint_algorithm !== revision.fingerprintAlgorithm ||
    row.fingerprint !== revision.fingerprint ||
    row.form_document_schema !== revision.formDocument.schema ||
    row.form_version_id !== revision.formDocument.formVersionId ||
    row.rule_version_id !== revision.formDocument.ruleVersionId ||
    row.form_document_fingerprint !== revision.formDocument.fingerprint
  ) {
    return fail("SEAL_READ_FAILED");
  }
  return Object.freeze({
    createdAt: canonicalTimestamp(row.created_at, "SEAL_READ_FAILED"),
    formVersionId: storedIdentifier(row.form_version_id, "SEAL_READ_FAILED"),
    ruleVersionId: storedIdentifier(row.rule_version_id, "SEAL_READ_FAILED"),
    formFingerprint: storedFingerprint(
      row.form_document_fingerprint,
      "SEAL_READ_FAILED",
    ),
  });
}

function insertArtifactSeal(
  db: Db,
  organizer: AuthenticatedOrganizer,
  command: ArtifactCommand,
  target: ArtifactTarget,
  conflict: Readonly<{ status: BlindArtifactConflictStatus; sequenceNumber: number }>,
): BlindReviewArtifactSealReceipt {
  const verifiedSemantics = verifySemanticsRow(loadSemanticsRow(db, target.semanticsId));
  if (
    verifiedSemantics.workspaceId !== target.workspaceId ||
    verifiedSemantics.roundId !== target.roundId ||
    verifiedSemantics.rubricVersionId !== target.rubricVersionId ||
    verifiedSemantics.fingerprint !== target.semanticsFingerprint
  ) {
    return fail("SEAL_READ_FAILED");
  }

  const revision = readSubmissionRevision(db, target.workspaceId, target.revisionId);
  const normalizedFormDocument = normalizeFormDocument(revision.formDocument);
  const revisionMetadata = loadRevisionMetadata(db, target, revision);
  if (
    revision.submissionId !== target.submissionId ||
    revision.schema !== CFP_SUBMISSION_REVISION_SCHEMA ||
    revision.fingerprintAlgorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    !equalFixedLength(
      revision.fingerprint,
      command.expectedSubmissionRevisionFingerprint,
    )
  ) {
    return fail("SUBMISSION_REVISION_STALE");
  }

  const issuedAt = nowIso();
  canonicalTimestamp(issuedAt, "SEAL_WRITE_FAILED");
  const artifactId = uuid();
  storedIdentifier(artifactId, "SEAL_WRITE_FAILED");
  const artifact = createBlindReviewArtifact({
    workspaceId: target.workspaceId,
    assignmentId: target.assignmentId,
    assignmentCreatedAt: target.assignmentCreatedAt,
    rubricVersionId: target.rubricVersionId,
    rubricSemanticsId: target.semanticsId,
    rubricSemanticsFingerprint: target.semanticsFingerprint,
    submissionId: target.submissionId,
    submissionRevision: {
      id: target.revisionId,
      number: revision.revisionNumber,
      schema: revision.schema,
      fingerprint: revision.fingerprint,
      createdAt: revisionMetadata.createdAt,
      formDocument: normalizedFormDocument,
    },
    disclosureStage: command.stage,
    conflictAtIssuance: conflict,
    attestation: command.attestation,
    issuer: {
      accountId: organizer.accountId,
      role: organizer.role,
      authority: REVIEW_ISSUER_AUTHORITY,
    },
    issuedAt,
    decisions: command.decisions,
  });
  const artifactJson = canonicalBlindReviewArtifactJson(artifact);
  const artifactFingerprint = fingerprintBlindReviewArtifact(artifact);
  const includedCount = artifact.items.filter(
    (item) => item.disposition === "INCLUDE_REDACTED",
  ).length;
  const excludedCount = artifact.items.length - includedCount;
  const inserted = db
    .prepare(
      `INSERT INTO review_blind_artifacts
         (id, workspace_id, assignment_id, assignment_created_at, rubric_version_id,
          rubric_semantics_id, rubric_semantics_fingerprint, submission_id,
          submission_revision_id, submission_revision_number, submission_revision_schema,
          submission_revision_fingerprint_algorithm, submission_revision_fingerprint,
          submission_revision_created_at, form_document_schema, form_version_id,
          rule_version_id, form_document_fingerprint, disclosure_stage,
          conflict_status_at_issuance, conflict_sequence_at_issuance, artifact_schema,
          artifact_version, artifact_json, fingerprint_algorithm, fingerprint,
          blind_safety_attestation, issued_by_account_id, issuer_role, issuer_authority,
          idempotency_key, request_fingerprint_algorithm, request_fingerprint, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      artifactId,
      target.workspaceId,
      target.assignmentId,
      target.assignmentCreatedAt,
      target.rubricVersionId,
      target.semanticsId,
      target.semanticsFingerprint,
      target.submissionId,
      target.revisionId,
      revision.revisionNumber,
      revision.schema,
      revision.fingerprintAlgorithm,
      revision.fingerprint,
      revisionMetadata.createdAt,
      normalizedFormDocument.schema,
      revisionMetadata.formVersionId,
      revisionMetadata.ruleVersionId,
      revisionMetadata.formFingerprint,
      BLIND_REVIEW_DISCLOSURE_STAGE,
      conflict.status,
      conflict.sequenceNumber,
      CFP_REVIEW_BLIND_ARTIFACT_SCHEMA,
      1,
      artifactJson,
      CFP_REVIEW_FINGERPRINT_ALGORITHM,
      artifactFingerprint,
      BLIND_REVIEW_ATTESTATION,
      organizer.accountId,
      organizer.role,
      REVIEW_ISSUER_AUTHORITY,
      command.idempotencyKey,
      CFP_REVIEW_FINGERPRINT_ALGORITHM,
      command.requestFingerprint,
      issuedAt,
    );
  if (inserted.changes !== 1) return fail("SEAL_WRITE_FAILED");

  const expectedBindings = Object.freeze({
    id: artifactId,
    workspace_id: target.workspaceId,
    assignment_id: target.assignmentId,
    assignment_created_at: target.assignmentCreatedAt,
    rubric_version_id: target.rubricVersionId,
    rubric_semantics_id: target.semanticsId,
    rubric_semantics_fingerprint: target.semanticsFingerprint,
    submission_id: target.submissionId,
    submission_revision_id: target.revisionId,
    submission_revision_number: revision.revisionNumber,
    submission_revision_schema: revision.schema,
    submission_revision_fingerprint_algorithm: revision.fingerprintAlgorithm,
    submission_revision_fingerprint: revision.fingerprint,
    submission_revision_created_at: revisionMetadata.createdAt,
    form_document_schema: normalizedFormDocument.schema,
    form_version_id: revisionMetadata.formVersionId,
    rule_version_id: revisionMetadata.ruleVersionId,
    form_document_fingerprint: revisionMetadata.formFingerprint,
    disclosure_stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    conflict_status_at_issuance: conflict.status,
    conflict_sequence_at_issuance: conflict.sequenceNumber,
    artifact_schema: CFP_REVIEW_BLIND_ARTIFACT_SCHEMA,
    artifact_version: 1,
    artifact_json: artifactJson,
    fingerprint_algorithm: CFP_REVIEW_FINGERPRINT_ALGORITHM,
    fingerprint: artifactFingerprint,
    blind_safety_attestation: BLIND_REVIEW_ATTESTATION,
    issued_by_account_id: organizer.accountId,
    issuer_role: organizer.role,
    issuer_authority: REVIEW_ISSUER_AUTHORITY,
    idempotency_key: command.idempotencyKey,
    request_fingerprint_algorithm: CFP_REVIEW_FINGERPRINT_ALGORITHM,
    request_fingerprint: command.requestFingerprint,
    issued_at: issuedAt,
  });
  const stored = readSingleRow(db, "review_blind_artifacts", artifactId);
  assertBindings(stored, expectedBindings);
  const verified = verifyArtifactRow(stored);
  if (
    verified.id !== artifactId ||
    verified.fingerprint !== artifactFingerprint ||
    verified.includedCount !== includedCount ||
    verified.excludedCount !== excludedCount ||
    canonicalJson(verified.document) !== artifactJson
  ) {
    return fail("SEAL_WRITE_FAILED");
  }
  writeAndVerifyAudit(db, organizer.workspaceId, {
    action: "cfp.review.blind-artifact.seal",
    targetType: "review_blind_artifact",
    details: Object.freeze({
      operation: "seal_blind_artifact",
      status: "PERMITTED",
      objectKind: "review_blind_artifact",
      includedCount,
      excludedCount,
    }),
  });
  const receipt = Object.freeze({
    artifactId,
    assignmentId: target.assignmentId,
    submissionRevisionId: target.revisionId,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    includedCount,
    excludedCount,
    issuedAt,
    replayed: false,
  });
  if (
    receipt.artifactId !== verified.id ||
    receipt.assignmentId !== verified.assignmentId ||
    receipt.submissionRevisionId !== verified.revisionId ||
    receipt.includedCount !== verified.includedCount ||
    receipt.excludedCount !== verified.excludedCount ||
    receipt.issuedAt !== verified.issuedAt
  ) {
    return fail("SEAL_WRITE_FAILED");
  }
  return receipt;
}

function sealBlindReviewArtifactInternal(
  db: Db,
  session: SessionInfo,
  input: SealBlindReviewArtifactInput,
): BlindReviewArtifactSealReceipt {
  const sessionSnapshot = snapshotSession(session);
  const command = snapshotArtifactCommand(input);
  return withOwnedTransaction(db, () => {
    const organizer = authenticateOrganizer(db, sessionSnapshot, command.workspaceSlug);
    const replayId = lookupIdempotency(
      db,
      "review_blind_artifacts",
      organizer,
      command.idempotencyKey,
      command.requestFingerprint,
    );
    if (replayId !== null) return replayArtifactReceipt(db, replayId, organizer, command);

    const target = loadArtifactTarget(db, organizer.workspaceId, command.assignmentId);
    assertNoArtifactSeal(db, target.assignmentId);
    if (target.revisionId !== command.expectedSubmissionRevisionId) {
      return fail("SUBMISSION_REVISION_STALE");
    }
    if (target.submissionState !== "SUBMITTED") {
      return fail("REVIEW_ASSIGNMENT_NOT_SEALABLE");
    }
    if (target.currentRevisionId !== target.revisionId) {
      return fail("SUBMISSION_REVISION_STALE");
    }
    if (target.roundState !== "DRAFT" && target.roundState !== "OPEN") {
      return fail("REVIEW_ROUND_NOT_SEALABLE");
    }
    if (
      (target.assignmentState !== "ASSIGNED" &&
        target.assignmentState !== "IN_PROGRESS") ||
      target.hasSuccessor
    ) {
      return fail("REVIEW_ASSIGNMENT_NOT_SEALABLE");
    }
    const conflict = authoritativeConflict(
      db,
      target,
      command.expectedConflictSequence,
    );
    return insertArtifactSeal(db, organizer, command, target, conflict);
  });
}

/**
 * Compose one artifact issuance into an already-owned distribution
 * transaction. The caller must provide complete explicit redaction decisions;
 * this helper never copies source answers or manufactures reviewer content.
 */
function issueBlindReviewArtifactInTransaction(
  db: Db,
  input: InTransactionBlindReviewArtifactInput,
): BlindReviewArtifactSealReceipt {
  if (!transactionIsOpen(db)) return fail("SEAL_OUTER_TRANSACTION_FORBIDDEN");
  const organizer = authenticateOrganizer(
    db,
    snapshotSession(input.issuer.session),
    input.issuer.workspaceSlug,
  );
  const command = snapshotArtifactCommand({
    workspaceSlug: organizer.workspaceSlug,
    assignmentId: input.assignmentId,
    expectedSubmissionRevisionId: input.expectedSubmissionRevisionId,
    expectedSubmissionRevisionFingerprint: input.expectedSubmissionRevisionFingerprint,
    expectedConflictSequence: input.expectedConflictSequence,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    attestation: BLIND_REVIEW_ATTESTATION,
    idempotencyKey: input.idempotencyKey,
    decisions: input.decisions,
  });
  const replayId = lookupIdempotency(
    db,
    "review_blind_artifacts",
    organizer,
    command.idempotencyKey,
    command.requestFingerprint,
  );
  if (replayId !== null) return replayArtifactReceipt(db, replayId, organizer, command);

  const target = loadArtifactTarget(db, organizer.workspaceId, command.assignmentId);
  assertNoArtifactSeal(db, target.assignmentId);
  if (target.revisionId !== command.expectedSubmissionRevisionId) {
    return fail("SUBMISSION_REVISION_STALE");
  }
  if (target.submissionState !== "SUBMITTED") {
    return fail("REVIEW_ASSIGNMENT_NOT_SEALABLE");
  }
  if (target.currentRevisionId !== target.revisionId) {
    return fail("SUBMISSION_REVISION_STALE");
  }
  if (target.roundState !== "DRAFT" && target.roundState !== "OPEN") {
    return fail("REVIEW_ROUND_NOT_SEALABLE");
  }
  if (
    (target.assignmentState !== "ASSIGNED" &&
      target.assignmentState !== "IN_PROGRESS") ||
    target.hasSuccessor
  ) {
    return fail("REVIEW_ASSIGNMENT_NOT_SEALABLE");
  }
  const conflict = authoritativeConflict(
    db,
    target,
    command.expectedConflictSequence,
  );
  return insertArtifactSeal(db, organizer, command, target, conflict);
}

/**
 * Complete a planned assignment inside an already-owned distribution transaction.
 * A legacy artifact may be reused only when its immutable command binds the exact
 * revision and complete caller-supplied decisions; otherwise issuance fails closed.
 */
function ensureBlindReviewArtifactInTransaction(
  db: Db,
  input: InTransactionBlindReviewArtifactInput,
): BlindReviewArtifactSealReceipt {
  if (!transactionIsOpen(db)) return fail("SEAL_OUTER_TRANSACTION_FORBIDDEN");
  const organizer = authenticateOrganizer(
    db,
    snapshotSession(input.issuer.session),
    input.issuer.workspaceSlug,
  );
  const command = snapshotArtifactCommand({
    workspaceSlug: organizer.workspaceSlug,
    assignmentId: input.assignmentId,
    expectedSubmissionRevisionId: input.expectedSubmissionRevisionId,
    expectedSubmissionRevisionFingerprint: input.expectedSubmissionRevisionFingerprint,
    expectedConflictSequence: input.expectedConflictSequence,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    attestation: BLIND_REVIEW_ATTESTATION,
    idempotencyKey: input.idempotencyKey,
    decisions: input.decisions,
  });
  const matchingArtifact = matchingAssignmentArtifactReceipt(db, organizer, command);
  if (matchingArtifact !== null) return matchingArtifact;

  const replayId = lookupIdempotency(
    db,
    "review_blind_artifacts",
    organizer,
    command.idempotencyKey,
    command.requestFingerprint,
  );
  if (replayId !== null) return replayArtifactReceipt(db, replayId, organizer, command);

  const target = loadArtifactTarget(db, organizer.workspaceId, command.assignmentId);
  assertNoArtifactSeal(db, target.assignmentId);
  if (target.revisionId !== command.expectedSubmissionRevisionId) {
    return fail("SUBMISSION_REVISION_STALE");
  }
  if (target.submissionState !== "SUBMITTED") {
    return fail("REVIEW_ASSIGNMENT_NOT_SEALABLE");
  }
  if (target.currentRevisionId !== target.revisionId) {
    return fail("SUBMISSION_REVISION_STALE");
  }
  if (target.roundState !== "DRAFT" && target.roundState !== "OPEN") {
    return fail("REVIEW_ROUND_NOT_SEALABLE");
  }
  if (
    (target.assignmentState !== "ASSIGNED" &&
      target.assignmentState !== "IN_PROGRESS") ||
    target.hasSuccessor
  ) {
    return fail("REVIEW_ASSIGNMENT_NOT_SEALABLE");
  }
  const conflict = authoritativeConflict(
    db,
    target,
    command.expectedConflictSequence,
  );
  return insertArtifactSeal(db, organizer, command, target, conflict);
}

export function sealRubricSemantics(
  db: Db,
  session: SessionInfo,
  input: SealRubricSemanticsInput,
): RubricSemanticsSealReceipt {
  return publicBoundary(() => sealRubricSemanticsInternal(db, session, input));
}

export function sealBlindReviewArtifact(
  db: Db,
  session: SessionInfo,
  input: SealBlindReviewArtifactInput,
): BlindReviewArtifactSealReceipt {
  return publicBoundary(() => sealBlindReviewArtifactInternal(db, session, input));
}

/** Internal composition hooks are attached without expanding the named public API. */
export type OrganizerSealingComposition = Readonly<{
  withOwnedTransaction: typeof withOwnedTransaction;
  ensureCustomReviewRubricSemanticsInTransaction: typeof ensureCustomReviewRubricSemanticsInTransaction;
  ensureBlindReviewArtifactInTransaction: typeof ensureBlindReviewArtifactInTransaction;
  issueBlindReviewArtifactInTransaction: typeof issueBlindReviewArtifactInTransaction;
}>;

Object.defineProperties(sealBlindReviewArtifact, {
  withOwnedTransaction: {
    value: withOwnedTransaction,
    enumerable: false,
    writable: false,
    configurable: false,
  },
  ensureCustomReviewRubricSemanticsInTransaction: {
    value: ensureCustomReviewRubricSemanticsInTransaction,
    enumerable: false,
    writable: false,
    configurable: false,
  },
  ensureBlindReviewArtifactInTransaction: {
    value: ensureBlindReviewArtifactInTransaction,
    enumerable: false,
    writable: false,
    configurable: false,
  },
  issueBlindReviewArtifactInTransaction: {
    value: issueBlindReviewArtifactInTransaction,
    enumerable: false,
    writable: false,
    configurable: false,
  },
});
