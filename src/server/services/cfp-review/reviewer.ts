import { Buffer } from "node:buffer";

import type { SessionInfo } from "../../auth";
import { roleHasCapability } from "../../auth";
import { canonicalJson, fingerprintOf, nowIso, uuid } from "../../canonical";
import type { Db } from "../../db";
import {
  EVALUATOR_DEVFLOW_REVIEWER_CONTRACT,
  isPinnedDevflowReviewerAccount,
} from "../../evaluator-reviewer-contract";
import {
  readSubmissionRevision,
  type SubmissionRevision,
} from "../cfp/form-documents";
import {
  FormSafetyError,
  sanitizeFormData,
  type JsonSafeObject,
  type JsonSafeValue,
} from "../cfp/form-safety";
import {
  BLIND_REVIEW_ARTIFACT_LIMITS,
  BLIND_REVIEW_ATTESTATION,
  BLIND_REVIEW_DISCLOSURE_STAGE,
  CFP_FORM_DOCUMENT_SCHEMA,
  CFP_REVIEW_BLIND_ARTIFACT_SCHEMA,
  CFP_REVIEW_FINGERPRINT_ALGORITHM,
  CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
  CFP_SUBMISSION_REVISION_SCHEMA,
  REVIEW_ISSUER_AUTHORITY,
  type BlindAnswerProjection,
  type BlindFieldDecisionInput,
  type BlindReviewArtifactV1,
} from "./artifact-types";
import {
  canonicalBlindReviewArtifactJson,
  createBlindReviewArtifact,
  fingerprintBlindReviewArtifact,
  parseCanonicalBlindReviewArtifact,
} from "./artifacts";
import {
  CFP_RUBRIC_SCHEMA,
  REVIEW_RECOMMENDATION_CHOICES,
  REVIEW_RUBRIC_LIMITS,
  REVIEW_SCALE_CHOICES,
  fingerprintReviewRubricSemantics,
  parseCanonicalReviewRubricSemantics,
  projectReviewRubricSemantics,
  type CustomReviewRubricField,
  type ReviewCriterionSemantics,
  type ReviewRubricSemanticsV1,
  type RubricProjection,
} from "./rubric-semantics";
import {
  CFP_REVIEW_COMMAND_RECEIPT_SCHEMA,
  CFP_REVIEW_COMMAND_REQUEST_SCHEMA,
  CFP_REVIEW_EVALUATION_SCHEMA,
  type ClearOwnReviewConflictInput,
  type DeclareOwnReviewConflictInput,
  type ListOwnReviewAssignmentsInput,
  type OwnReviewAssignmentDetail,
  type OwnReviewAssignmentSummary,
  type OwnReviewRevisionProjection,
  type ReadOwnReviewAssignmentInput,
  type ReviewCommandReceipt,
  type ReviewConflictClearReceipt,
  type ReviewConflictDeclareReceipt,
  type ReviewEvaluation,
  type ReviewEvaluationResponse,
  type ReviewerAssignmentState,
  type ReviewerBlindProposalProjection,
  type ReviewerCommandKind,
  type ReviewerConflictStatus,
  type ReviewSaveReceipt,
  type ReviewSubmitReceipt,
  type SaveOwnReviewInput,
  type SubmitOwnReviewInput,
} from "./reviewer-types";
import { assertPinnedReviewerActivationInTransaction } from "./reviewer-provisioning";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CRITERION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ORGANIZER_ROLES: ReadonlySet<string> = new Set([
  "organizer",
  "workspace_admin",
  "event_manager",
  "program_manager",
]);
const ASSIGNMENT_STATES: ReadonlySet<string> = new Set([
  "ASSIGNED",
  "IN_PROGRESS",
  "SUBMITTED",
  "RECUSED",
  "REVOKED",
]);
const ROUND_STATES: ReadonlySet<string> = new Set([
  "DRAFT",
  "OPEN",
  "CLOSED",
  "CANCELLED",
]);
const CONFLICT_ACTIONS: ReadonlySet<string> = new Set([
  "DECLARE",
  "CLEAR",
  "WAIVE",
]);

const SESSION_INPUT_LIMITS = Object.freeze({
  maxDepth: 4,
  maxStringBytes: 16 * 1024,
  maxArrayLength: 16,
  maxObjectKeys: 16,
  maxKeyBytes: 128,
  maxNodes: 64,
  maxSerializedBytes: 32 * 1024,
});
const SIMPLE_INPUT_LIMITS = Object.freeze({
  maxDepth: 4,
  maxStringBytes: 8 * 1024,
  maxArrayLength: 16,
  maxObjectKeys: 16,
  maxKeyBytes: 128,
  maxNodes: 128,
  maxSerializedBytes: 32 * 1024,
});
const EVALUATION_INPUT_LIMITS = Object.freeze({
  maxDepth: 8,
  maxStringBytes: REVIEW_RUBRIC_LIMITS.maxCommentLength,
  maxArrayLength: 64,
  maxObjectKeys: 32,
  maxKeyBytes: 128,
  maxNodes: REVIEW_RUBRIC_LIMITS.maxNodes,
  maxSerializedBytes: REVIEW_RUBRIC_LIMITS.maxSerializedBytes,
});
const STORED_DOCUMENT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxStringBytes: 64 * 1024,
  maxArrayLength: 1_024,
  maxObjectKeys: 256,
  maxKeyBytes: 128,
  maxNodes: 20_000,
  maxSerializedBytes: 4 * 1024 * 1024,
});

const MAX_QUEUE_ASSIGNMENTS = 256;

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

const ERROR_MESSAGES = {
  INPUT_INVALID: "The reviewer request is invalid.",
  ACCESS_DENIED: "Reviewer access is unavailable.",
  OUTER_TRANSACTION_DENIED: "Reviewer operations require an owned transaction boundary.",
  ASSIGNMENT_NOT_AVAILABLE: "The review assignment is not available.",
  REVIEW_STATE_STALE: "The review assignment state has changed.",
  IDEMPOTENCY_CONFLICT: "The idempotency key was already used for a different request.",
  EVALUATION_INVALID: "The review evaluation is invalid.",
  EVALUATION_INCOMPLETE: "The review evaluation is incomplete.",
  STORED_REVIEW_INVALID: "Stored reviewer evidence is invalid.",
  READ_FAILED: "The reviewer read could not be completed.",
  WRITE_FAILED: "The reviewer command could not be completed.",
} as const;

export type ReviewerServiceErrorCode = keyof typeof ERROR_MESSAGES;

export class ReviewerServiceError extends Error {
  readonly code: ReviewerServiceErrorCode;

  constructor(code: ReviewerServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ReviewerServiceError";
    this.code = code;
  }
}

export class ReviewerServiceFatalError extends Error {
  readonly fatal = true;

  constructor() {
    super("The reviewer service cannot continue safely.");
    this.name = "ReviewerServiceFatalError";
  }
}

const INTERNAL_FATAL_ERRORS = new WeakSet<object>();

function fatalError(): ReviewerServiceFatalError {
  const error = new ReviewerServiceFatalError();
  INTERNAL_FATAL_ERRORS.add(error);
  return error;
}

function fail(code: ReviewerServiceErrorCode): never {
  throw new ReviewerServiceError(code);
}

function unavailable(): never {
  return fail("ASSIGNMENT_NOT_AVAILABLE");
}

function isObject(value: JsonSafeValue | undefined): value is JsonSafeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonSafeObject, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function snapshotInput(
  value: unknown,
  limits: typeof SIMPLE_INPUT_LIMITS | typeof SESSION_INPUT_LIMITS | typeof EVALUATION_INPUT_LIMITS,
): JsonSafeValue {
  try {
    return sanitizeFormData(value, limits);
  } catch (error) {
    if (error instanceof FormSafetyError) return fail("INPUT_INVALID");
    return fail("INPUT_INVALID");
  }
}

function inputObject(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
  limits: typeof SIMPLE_INPUT_LIMITS | typeof SESSION_INPUT_LIMITS | typeof EVALUATION_INPUT_LIMITS,
): JsonSafeObject {
  const safe = snapshotInput(value, limits);
  if (!isObject(safe) || !hasExactKeys(safe, expectedKeys)) return fail("INPUT_INVALID");
  return safe;
}

function inputString(value: JsonSafeValue | undefined, maximumBytes = 128): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return fail("INPUT_INVALID");
  }
  return value;
}

function inputIdentifier(value: JsonSafeValue | undefined): string {
  const candidate = inputString(value, 128);
  if (!IDENTIFIER_PATTERN.test(candidate)) return fail("INPUT_INVALID");
  return candidate;
}

function inputIdempotencyKey(value: JsonSafeValue | undefined): string {
  const candidate = inputString(value, 128);
  if (!IDEMPOTENCY_KEY_PATTERN.test(candidate)) return fail("INPUT_INVALID");
  return candidate;
}

function inputInteger(value: JsonSafeValue | undefined, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    return fail("INPUT_INVALID");
  }
  return value;
}

function inputReason(value: JsonSafeValue | undefined): string {
  const reason = inputString(value, 4096);
  if (reason.trim().length === 0) return fail("INPUT_INVALID");
  return reason;
}

type CapturedSession = Readonly<SessionInfo>;

function captureSession(session: SessionInfo): CapturedSession {
  const safe = inputObject(session, SESSION_KEYS, SESSION_INPUT_LIMITS);
  const tokenHash = inputString(safe.tokenHash, 64);
  if (!FINGERPRINT_PATTERN.test(tokenHash)) return fail("INPUT_INVALID");
  return Object.freeze({
    id: inputIdentifier(safe.id),
    tokenHash,
    accountId: inputIdentifier(safe.accountId),
    workspaceId: inputIdentifier(safe.workspaceId),
    expiresAt: inputString(safe.expiresAt, 64),
    email: inputString(safe.email, 16 * 1024),
    displayName: inputString(safe.displayName, 16 * 1024),
    role: inputIdentifier(safe.role),
    workspaceSlug: inputString(safe.workspaceSlug, 128),
    workspaceName: inputString(safe.workspaceName, 16 * 1024),
  });
}

function captureWorkspaceSlug(value: JsonSafeValue | undefined): string {
  const slug = inputString(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(slug)) return fail("INPUT_INVALID");
  return slug;
}

function captureListInput(input: ListOwnReviewAssignmentsInput): ListOwnReviewAssignmentsInput {
  const safe = inputObject(input, new Set(["workspaceSlug"]), SIMPLE_INPUT_LIMITS);
  return Object.freeze({ workspaceSlug: captureWorkspaceSlug(safe.workspaceSlug) });
}

function captureReadInput(input: ReadOwnReviewAssignmentInput): ReadOwnReviewAssignmentInput {
  const safe = inputObject(
    input,
    new Set(["workspaceSlug", "assignmentId"]),
    SIMPLE_INPUT_LIMITS,
  );
  return Object.freeze({
    workspaceSlug: captureWorkspaceSlug(safe.workspaceSlug),
    assignmentId: inputIdentifier(safe.assignmentId),
  });
}

function captureConflictInput(
  input: DeclareOwnReviewConflictInput | ClearOwnReviewConflictInput,
): DeclareOwnReviewConflictInput {
  const safe = inputObject(
    input,
    new Set([
      "workspaceSlug",
      "assignmentId",
      "expectedAssignmentStateSequenceNumber",
      "expectedConflictSequenceNumber",
      "reason",
      "idempotencyKey",
    ]),
    SIMPLE_INPUT_LIMITS,
  );
  return Object.freeze({
    workspaceSlug: captureWorkspaceSlug(safe.workspaceSlug),
    assignmentId: inputIdentifier(safe.assignmentId),
    expectedAssignmentStateSequenceNumber: inputInteger(
      safe.expectedAssignmentStateSequenceNumber,
      1,
    ),
    expectedConflictSequenceNumber: inputInteger(safe.expectedConflictSequenceNumber, 0),
    reason: inputReason(safe.reason),
    idempotencyKey: inputIdempotencyKey(safe.idempotencyKey),
  });
}

function evaluationValue(value: JsonSafeValue | undefined): string | number | boolean {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return fail("INPUT_INVALID");
  }
  return value;
}

function captureEvaluation(value: JsonSafeValue | undefined): ReviewEvaluation {
  if (!isObject(value) || !hasExactKeys(value, new Set(["schema", "responses"]))) {
    return fail("INPUT_INVALID");
  }
  if (value.schema !== CFP_REVIEW_EVALUATION_SCHEMA || !Array.isArray(value.responses)) {
    return fail("INPUT_INVALID");
  }
  if (value.responses.length > REVIEW_RUBRIC_LIMITS.maxCustomCriteria) {
    return fail("INPUT_INVALID");
  }
  const seen = new Set<string>();
  const responses: ReviewEvaluationResponse[] = [];
  for (const candidate of value.responses) {
    if (
      !isObject(candidate) ||
      !hasExactKeys(candidate, new Set(["criterionId", "value"]))
    ) {
      return fail("INPUT_INVALID");
    }
    const criterionId = inputString(candidate.criterionId, 128);
    if (!CRITERION_ID_PATTERN.test(criterionId) || seen.has(criterionId)) {
      return fail("INPUT_INVALID");
    }
    seen.add(criterionId);
    responses.push(
      Object.freeze({ criterionId, value: evaluationValue(candidate.value) }),
    );
  }
  responses.sort((left, right) => left.criterionId.localeCompare(right.criterionId));
  return Object.freeze({
    schema: CFP_REVIEW_EVALUATION_SCHEMA,
    responses: Object.freeze(responses),
  });
}

function captureSaveInput(input: SaveOwnReviewInput): SaveOwnReviewInput {
  const safe = inputObject(
    input,
    new Set([
      "workspaceSlug",
      "assignmentId",
      "expectedAssignmentStateSequenceNumber",
      "expectedReviewRevisionNumber",
      "evaluation",
      "idempotencyKey",
    ]),
    EVALUATION_INPUT_LIMITS,
  );
  return Object.freeze({
    workspaceSlug: captureWorkspaceSlug(safe.workspaceSlug),
    assignmentId: inputIdentifier(safe.assignmentId),
    expectedAssignmentStateSequenceNumber: inputInteger(
      safe.expectedAssignmentStateSequenceNumber,
      1,
    ),
    expectedReviewRevisionNumber: inputInteger(safe.expectedReviewRevisionNumber, 0),
    evaluation: captureEvaluation(safe.evaluation),
    idempotencyKey: inputIdempotencyKey(safe.idempotencyKey),
  });
}

function captureSubmitInput(input: SubmitOwnReviewInput): SubmitOwnReviewInput {
  const safe = inputObject(
    input,
    new Set([
      "workspaceSlug",
      "assignmentId",
      "expectedAssignmentStateSequenceNumber",
      "expectedReviewRevisionNumber",
      "idempotencyKey",
    ]),
    SIMPLE_INPUT_LIMITS,
  );
  return Object.freeze({
    workspaceSlug: captureWorkspaceSlug(safe.workspaceSlug),
    assignmentId: inputIdentifier(safe.assignmentId),
    expectedAssignmentStateSequenceNumber: inputInteger(
      safe.expectedAssignmentStateSequenceNumber,
      1,
    ),
    expectedReviewRevisionNumber: inputInteger(safe.expectedReviewRevisionNumber, 0),
    idempotencyKey: inputIdempotencyKey(safe.idempotencyKey),
  });
}

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

function requireOwnedBoundary(db: Db): void {
  if (transactionIsOpen(db)) return fail("OUTER_TRANSACTION_DENIED");
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

function withOwnedTransaction<T>(db: Db, begin: "BEGIN" | "BEGIN IMMEDIATE", operation: () => T): T {
  try {
    db.exec(begin);
  } catch (error) {
    if (transactionIsOpen(db) && rollbackOwnedTransaction(db)) throw new Error("boundary cleanup failed");
    throw error;
  }
  if (!transactionIsOpen(db)) throw new Error("owned transaction did not begin");

  let result: T;
  try {
    result = operation();
  } catch (error) {
    if (!transactionIsOpen(db)) throw fatalError();
    if (rollbackOwnedTransaction(db)) throw new Error("boundary cleanup failed");
    throw error;
  }

  if (!transactionIsOpen(db)) throw fatalError();
  try {
    db.exec("COMMIT");
  } catch (error) {
    // Once a throwing COMMIT has ended the transaction, neither its durable success nor rollback
    // can be proven. A normal failure or success receipt would both overstate what is known.
    if (!transactionIsOpen(db)) throw fatalError();
    if (rollbackOwnedTransaction(db)) throw new Error("boundary cleanup failed");
    throw error;
  }
  if (!transactionIsOpen(db)) return result;
  if (rollbackOwnedTransaction(db)) throw new Error("boundary cleanup failed");
  throw new Error("owned transaction did not commit");
}

function withReadTransaction<T>(db: Db, operation: () => T): T {
  return withOwnedTransaction(db, "BEGIN", operation);
}

function withImmediateTransaction<T>(db: Db, operation: () => T): T {
  return withOwnedTransaction(db, "BEGIN IMMEDIATE", operation);
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function storedString(value: unknown, maximumBytes: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
    ? value
    : null;
}

function storedIdentifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value) ? value : null;
}

function storedFingerprint(value: unknown): string | null {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value) ? value : null;
}

function storedInteger(value: unknown, minimum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}

type AuthRow = {
  readonly session_id: unknown;
  readonly token_hash: unknown;
  readonly account_id: unknown;
  readonly workspace_id: unknown;
  readonly session_created_at: unknown;
  readonly expires_at: unknown;
  readonly email: unknown;
  readonly display_name: unknown;
  readonly role: unknown;
  readonly account_workspace_id: unknown;
  readonly workspace_slug: unknown;
  readonly workspace_name: unknown;
};

type AuthenticatedReviewer = Readonly<{
  accountId: string;
  workspaceId: string;
  workspaceSlug: string;
  role: "reviewer";
  pinnedAssignmentId: string | null;
}>;

function authenticateReviewer(
  db: Db,
  session: CapturedSession,
  workspaceSlug: string,
): AuthenticatedReviewer {
  const rows = db
    .prepare(
      `SELECT s.id AS session_id, s.token_hash, s.account_id, s.workspace_id,
              s.created_at AS session_created_at, s.expires_at,
              a.email, a.display_name, a.role, a.workspace_id AS account_workspace_id,
              w.slug AS workspace_slug, w.name AS workspace_name
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = ?`,
    )
    .all(session.id) as AuthRow[];
  if (rows.length !== 1) return fail("ACCESS_DENIED");
  const row = rows[0]!;
  const createdAt = canonicalTimestamp(row.session_created_at);
  const expiresAt = canonicalTimestamp(row.expires_at);
  if (
    storedIdentifier(row.session_id) !== session.id ||
    storedFingerprint(row.token_hash) !== session.tokenHash ||
    storedIdentifier(row.account_id) !== session.accountId ||
    storedIdentifier(row.workspace_id) !== session.workspaceId ||
    storedIdentifier(row.account_workspace_id) !== session.workspaceId ||
    storedString(row.email, 16 * 1024) !== session.email ||
    storedString(row.display_name, 16 * 1024) !== session.displayName ||
    storedIdentifier(row.role) !== session.role ||
    storedString(row.workspace_slug, 128) !== session.workspaceSlug ||
    storedString(row.workspace_name, 16 * 1024) !== session.workspaceName ||
    createdAt === null ||
    expiresAt === null ||
    expiresAt !== session.expiresAt ||
    Date.parse(expiresAt) <= Date.parse(createdAt) ||
    Date.parse(createdAt) > Date.now() ||
    Date.parse(expiresAt) <= Date.now() ||
    workspaceSlug !== session.workspaceSlug ||
    workspaceSlug !== row.workspace_slug ||
    row.role !== "reviewer" ||
    !roleHasCapability("reviewer", "cfp.review")
  ) {
    return fail("ACCESS_DENIED");
  }
  let pinnedAssignmentId: string | null = null;
  if (
    isPinnedDevflowReviewerAccount({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      role: "reviewer",
      email: session.email,
    })
  ) {
    try {
      assertPinnedReviewerActivationInTransaction(db);
    } catch {
      return fail("ACCESS_DENIED");
    }
    pinnedAssignmentId = EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId;
  }
  return Object.freeze({
    accountId: session.accountId,
    workspaceId: session.workspaceId,
    workspaceSlug,
    role: "reviewer",
    pinnedAssignmentId,
  });
}

type AssignmentBaseRow = {
  readonly assignment_id: unknown;
  readonly assignment_workspace_id: unknown;
  readonly round_id: unknown;
  readonly rubric_version_id: unknown;
  readonly submission_id: unknown;
  readonly submission_revision_id: unknown;
  readonly reviewer_account_id: unknown;
  readonly assigned_by: unknown;
  readonly supersedes_assignment_id: unknown;
  readonly assignment_created_at: unknown;
  readonly round_workspace_id: unknown;
  readonly event_id: unknown;
  readonly call_id: unknown;
  readonly round_name: unknown;
  readonly round_created_by: unknown;
  readonly round_created_at: unknown;
  readonly event_workspace_id: unknown;
  readonly call_workspace_id: unknown;
  readonly call_event_id: unknown;
  readonly rubric_workspace_id: unknown;
  readonly rubric_round_id: unknown;
  readonly rubric_version_number: unknown;
  readonly rubric_schema: unknown;
  readonly rubric_fingerprint_algorithm: unknown;
  readonly rubric_fingerprint: unknown;
  readonly rubric_sealed_by: unknown;
  readonly rubric_sealer_workspace_id: unknown;
  readonly rubric_sealed_at: unknown;
  readonly submission_workspace_id: unknown;
  readonly submission_event_id: unknown;
  readonly submission_call_id: unknown;
  readonly pinned_form_version_id: unknown;
  readonly pinned_rule_version_id: unknown;
  readonly current_revision_id: unknown;
  readonly submission_state: unknown;
  readonly submission_created_at: unknown;
  readonly reviewer_workspace_id: unknown;
  readonly reviewer_role: unknown;
  readonly assigner_workspace_id: unknown;
};

type AssignmentBase = Readonly<{
  id: string;
  workspaceId: string;
  roundId: string;
  rubricVersionId: string;
  rubricVersionNumber: number;
  rubricFingerprint: string;
  rubricSealedAt: string;
  submissionId: string;
  submissionRevisionId: string;
  pinnedFormVersionId: string;
  pinnedRuleVersionId: string;
  reviewerAccountId: string;
  assignedBy: string;
  supersedesAssignmentId: string | null;
  createdAt: string;
  roundName: string;
  roundCreatedBy: string;
  roundCreatedAt: string;
  submissionCreatedAt: string;
}>;

function loadAssignmentBase(
  db: Db,
  reviewer: AuthenticatedReviewer,
  assignmentId: string,
): AssignmentBase {
  const rows = db
    .prepare(
      `SELECT a.id AS assignment_id, a.workspace_id AS assignment_workspace_id,
              a.round_id, a.rubric_version_id, a.submission_id,
              a.submission_revision_id, a.reviewer_account_id, a.assigned_by,
              a.supersedes_assignment_id, a.created_at AS assignment_created_at,
              round.workspace_id AS round_workspace_id, round.event_id, round.call_id,
              round.name AS round_name, round.created_by AS round_created_by,
              round.created_at AS round_created_at,
              event.workspace_id AS event_workspace_id,
              call.workspace_id AS call_workspace_id, call.event_id AS call_event_id,
              rubric.workspace_id AS rubric_workspace_id,
              rubric.round_id AS rubric_round_id,
              rubric.version_number AS rubric_version_number,
              rubric.rubric_schema, rubric.fingerprint_algorithm AS rubric_fingerprint_algorithm,
              rubric.fingerprint AS rubric_fingerprint, rubric.sealed_by AS rubric_sealed_by,
              rubric.sealed_at AS rubric_sealed_at,
              rubric_sealer.workspace_id AS rubric_sealer_workspace_id,
              submission.workspace_id AS submission_workspace_id,
              submission.event_id AS submission_event_id,
              submission.call_id AS submission_call_id,
              submission.pinned_form_version_id, submission.pinned_rule_version_id,
              submission.current_revision_id, submission.state AS submission_state,
              submission.created_at AS submission_created_at,
              reviewer.workspace_id AS reviewer_workspace_id, reviewer.role AS reviewer_role,
              assigner.workspace_id AS assigner_workspace_id
       FROM review_assignments a
       JOIN review_rounds round ON round.id = a.round_id
       JOIN events event ON event.id = round.event_id
       JOIN calls call ON call.id = round.call_id
       JOIN rubric_versions rubric ON rubric.id = a.rubric_version_id
       JOIN accounts rubric_sealer ON rubric_sealer.id = rubric.sealed_by
       JOIN submissions submission ON submission.id = a.submission_id
       JOIN accounts reviewer ON reviewer.id = a.reviewer_account_id
       JOIN accounts assigner ON assigner.id = a.assigned_by
       WHERE a.workspace_id = ? AND a.id = ? AND a.reviewer_account_id = ?`,
    )
    .all(reviewer.workspaceId, assignmentId, reviewer.accountId) as AssignmentBaseRow[];
  if (rows.length !== 1) return unavailable();
  const row = rows[0]!;
  const roundId = storedIdentifier(row.round_id);
  const eventId = storedIdentifier(row.event_id);
  const callId = storedIdentifier(row.call_id);
  const rubricVersionId = storedIdentifier(row.rubric_version_id);
  const submissionId = storedIdentifier(row.submission_id);
  const submissionRevisionId = storedIdentifier(row.submission_revision_id);
  const pinnedFormVersionId = storedIdentifier(row.pinned_form_version_id);
  const pinnedRuleVersionId = storedIdentifier(row.pinned_rule_version_id);
  const assignedBy = storedIdentifier(row.assigned_by);
  const createdAt = canonicalTimestamp(row.assignment_created_at);
  const roundCreatedAt = canonicalTimestamp(row.round_created_at);
  const rubricSealedAt = canonicalTimestamp(row.rubric_sealed_at);
  const submissionCreatedAt = canonicalTimestamp(row.submission_created_at);
  const supersedesAssignmentId =
    row.supersedes_assignment_id === null
      ? null
      : storedIdentifier(row.supersedes_assignment_id);
  if (
    storedIdentifier(row.assignment_id) !== assignmentId ||
    storedIdentifier(row.assignment_workspace_id) !== reviewer.workspaceId ||
    roundId === null ||
    eventId === null ||
    callId === null ||
    rubricVersionId === null ||
    submissionId === null ||
    submissionRevisionId === null ||
    pinnedFormVersionId === null ||
    pinnedRuleVersionId === null ||
    storedIdentifier(row.reviewer_account_id) !== reviewer.accountId ||
    storedIdentifier(row.reviewer_workspace_id) !== reviewer.workspaceId ||
    row.reviewer_role !== "reviewer" ||
    assignedBy === null ||
    storedIdentifier(row.assigner_workspace_id) !== reviewer.workspaceId ||
    (row.supersedes_assignment_id !== null && supersedesAssignmentId === null) ||
    createdAt === null ||
    roundCreatedAt === null ||
    rubricSealedAt === null ||
    submissionCreatedAt === null ||
    storedIdentifier(row.round_workspace_id) !== reviewer.workspaceId ||
    storedIdentifier(row.event_workspace_id) !== reviewer.workspaceId ||
    storedIdentifier(row.call_workspace_id) !== reviewer.workspaceId ||
    storedIdentifier(row.call_event_id) !== eventId ||
    storedIdentifier(row.rubric_workspace_id) !== reviewer.workspaceId ||
    storedIdentifier(row.rubric_round_id) !== roundId ||
    storedInteger(row.rubric_version_number, 1) === null ||
    row.rubric_schema !== CFP_RUBRIC_SCHEMA ||
    row.rubric_fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    storedFingerprint(row.rubric_fingerprint) === null ||
    storedIdentifier(row.rubric_sealed_by) === null ||
    storedIdentifier(row.rubric_sealer_workspace_id) !== reviewer.workspaceId ||
    storedIdentifier(row.submission_workspace_id) !== reviewer.workspaceId ||
    storedIdentifier(row.submission_event_id) !== eventId ||
    storedIdentifier(row.submission_call_id) !== callId ||
    row.submission_state !== "SUBMITTED" ||
    storedIdentifier(row.current_revision_id) !== submissionRevisionId ||
    storedString(row.round_name, 16 * 1024) === null ||
    storedIdentifier(row.round_created_by) === null ||
    Date.parse(roundCreatedAt) > Date.parse(rubricSealedAt) ||
    Date.parse(rubricSealedAt) > Date.parse(createdAt) ||
    Date.parse(submissionCreatedAt) > Date.parse(createdAt)
  ) {
    return unavailable();
  }
  return Object.freeze({
    id: assignmentId,
    workspaceId: reviewer.workspaceId,
    roundId,
    rubricVersionId,
    rubricVersionNumber: row.rubric_version_number as number,
    rubricFingerprint: row.rubric_fingerprint as string,
    rubricSealedAt,
    submissionId,
    submissionRevisionId,
    pinnedFormVersionId,
    pinnedRuleVersionId,
    reviewerAccountId: reviewer.accountId,
    assignedBy,
    supersedesAssignmentId,
    createdAt,
    roundName: row.round_name as string,
    roundCreatedBy: row.round_created_by as string,
    roundCreatedAt,
    submissionCreatedAt,
  });
}

type RoundStateRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly round_id: unknown;
  readonly state: unknown;
  readonly sequence_number: unknown;
  readonly actor_account_id: unknown;
  readonly reason: unknown;
  readonly created_at: unknown;
  readonly actor_workspace_id: unknown;
};

type AssignmentStateRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly assignment_id: unknown;
  readonly state: unknown;
  readonly sequence_number: unknown;
  readonly actor_account_id: unknown;
  readonly reason: unknown;
  readonly created_at: unknown;
  readonly actor_workspace_id: unknown;
};

type ConflictRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly assignment_id: unknown;
  readonly action: unknown;
  readonly sequence_number: unknown;
  readonly actor_account_id: unknown;
  readonly actor_role_basis: unknown;
  readonly reason: unknown;
  readonly created_at: unknown;
  readonly actor_workspace_id: unknown;
};

type AssignmentStateSnapshot = Readonly<{
  state: ReviewerAssignmentState | "RECUSED" | "REVOKED";
  sequenceNumber: number;
  createdAt: string;
}>;

type AssignmentLifecycleBase = Readonly<
  Pick<
    AssignmentBase,
    "id" | "workspaceId" | "reviewerAccountId" | "assignedBy" | "createdAt"
  >
>;

type ConflictSnapshot = Readonly<{
  status: ReviewerConflictStatus;
  sequenceNumber: number;
  rows: readonly Readonly<{
    action: "DECLARE" | "CLEAR" | "WAIVE";
    sequenceNumber: number;
    createdAt: string;
  }>[];
}>;

function loadRoundStateHistory(db: Db, base: AssignmentBase): void {
  const rows = db
    .prepare(
      `SELECT state.id, state.workspace_id, state.round_id, state.state,
              state.sequence_number, state.actor_account_id, state.reason, state.created_at,
              actor.workspace_id AS actor_workspace_id
       FROM review_round_states state
       LEFT JOIN accounts actor ON actor.id = state.actor_account_id
       WHERE state.round_id = ?
       ORDER BY state.sequence_number ASC`,
    )
    .all(base.roundId) as RoundStateRow[];
  if (rows.length === 0) return unavailable();
  let previousState: string | null = null;
  let previousAt = base.roundCreatedAt;
  for (const [index, row] of rows.entries()) {
    const stateId = storedString(row.id, 256);
    const sequenceNumber = storedInteger(row.sequence_number, 1);
    const state = typeof row.state === "string" && ROUND_STATES.has(row.state)
      ? row.state
      : null;
    const createdAt = canonicalTimestamp(row.created_at);
    if (
      stateId === null ||
      storedIdentifier(row.workspace_id) !== base.workspaceId ||
      storedIdentifier(row.round_id) !== base.roundId ||
      sequenceNumber !== index + 1 ||
      state === null ||
      storedIdentifier(row.actor_account_id) === null ||
      storedIdentifier(row.actor_workspace_id) !== base.workspaceId ||
      createdAt === null ||
      Date.parse(createdAt) < Date.parse(previousAt) ||
      (row.reason !== null && storedString(row.reason, 4096) === null)
    ) {
      return unavailable();
    }
    if (index === 0) {
      if (
        stateId !== `review-round-state-initial:${base.roundId}` ||
        state !== "DRAFT" ||
        row.actor_account_id !== base.roundCreatedBy ||
        row.reason !== null ||
        createdAt !== base.roundCreatedAt
      ) {
        return unavailable();
      }
    } else {
      const validTransition =
        (previousState === "DRAFT" && (state === "OPEN" || state === "CANCELLED")) ||
        (previousState === "OPEN" && (state === "CLOSED" || state === "CANCELLED"));
      if (!validTransition) return unavailable();
    }
    previousState = state;
    previousAt = createdAt;
  }
  if (previousState !== "OPEN") return unavailable();
}

function loadAssignmentStateHistory(
  db: Db,
  base: AssignmentLifecycleBase,
): AssignmentStateSnapshot {
  const rows = db
    .prepare(
      `SELECT state.id, state.workspace_id, state.assignment_id, state.state,
              state.sequence_number, state.actor_account_id, state.reason, state.created_at,
              actor.workspace_id AS actor_workspace_id
       FROM review_assignment_states state
       LEFT JOIN accounts actor ON actor.id = state.actor_account_id
       WHERE state.assignment_id = ?
       ORDER BY state.sequence_number ASC`,
    )
    .all(base.id) as AssignmentStateRow[];
  if (rows.length === 0) return unavailable();
  let previousState: string | null = null;
  let previousAt = base.createdAt;
  let currentAt = base.createdAt;
  let currentSequence = 0;
  for (const [index, row] of rows.entries()) {
    const stateId = storedString(row.id, 256);
    const sequenceNumber = storedInteger(row.sequence_number, 1);
    const state = typeof row.state === "string" && ASSIGNMENT_STATES.has(row.state)
      ? row.state
      : null;
    const createdAt = canonicalTimestamp(row.created_at);
    if (
      stateId === null ||
      storedIdentifier(row.workspace_id) !== base.workspaceId ||
      storedIdentifier(row.assignment_id) !== base.id ||
      sequenceNumber !== index + 1 ||
      state === null ||
      storedIdentifier(row.actor_account_id) === null ||
      storedIdentifier(row.actor_workspace_id) !== base.workspaceId ||
      createdAt === null ||
      Date.parse(createdAt) < Date.parse(previousAt) ||
      (row.reason !== null && storedString(row.reason, 4096) === null)
    ) {
      return unavailable();
    }
    if (index === 0) {
      if (
        stateId !== `review-assignment-state-initial:${base.id}` ||
        state !== "ASSIGNED" ||
        row.actor_account_id !== base.assignedBy ||
        row.reason !== null ||
        createdAt !== base.createdAt
      ) {
        return unavailable();
      }
    } else {
      const validTransition =
        (previousState === "ASSIGNED" &&
          ["IN_PROGRESS", "SUBMITTED", "RECUSED", "REVOKED"].includes(state)) ||
        (previousState === "IN_PROGRESS" &&
          ["SUBMITTED", "RECUSED", "REVOKED"].includes(state));
      if (!validTransition) return unavailable();
      if (
        (state === "IN_PROGRESS" || state === "SUBMITTED" || state === "RECUSED") &&
        row.actor_account_id !== base.reviewerAccountId
      ) {
        return unavailable();
      }
    }
    previousState = state;
    previousAt = createdAt;
    currentAt = createdAt;
    currentSequence = sequenceNumber;
  }
  return Object.freeze({
    state: previousState as AssignmentStateSnapshot["state"],
    sequenceNumber: currentSequence,
    createdAt: currentAt,
  });
}

function loadConflictHistory(db: Db, base: AssignmentBase): ConflictSnapshot {
  const rows = db
    .prepare(
      `SELECT disposition.id, disposition.workspace_id, disposition.assignment_id,
              disposition.action, disposition.sequence_number,
              disposition.actor_account_id, disposition.actor_role_basis,
              disposition.reason, disposition.created_at,
              actor.workspace_id AS actor_workspace_id
       FROM review_conflict_dispositions disposition
       LEFT JOIN accounts actor ON actor.id = disposition.actor_account_id
       WHERE disposition.assignment_id = ?
       ORDER BY disposition.sequence_number ASC`,
    )
    .all(base.id) as ConflictRow[];
  if (rows.length === 0) {
    return Object.freeze({ status: "NONE", sequenceNumber: 0, rows: Object.freeze([]) });
  }
  let previousAction: string | null = null;
  let previousAt = base.createdAt;
  const history: Array<{
    action: "DECLARE" | "CLEAR" | "WAIVE";
    sequenceNumber: number;
    createdAt: string;
  }> = [];
  for (const [index, row] of rows.entries()) {
    const sequenceNumber = storedInteger(row.sequence_number, 1);
    const action = typeof row.action === "string" && CONFLICT_ACTIONS.has(row.action)
      ? row.action as "DECLARE" | "CLEAR" | "WAIVE"
      : null;
    const createdAt = canonicalTimestamp(row.created_at);
    const actorRoleBasis = storedIdentifier(row.actor_role_basis);
    if (
      storedIdentifier(row.id) === null ||
      storedIdentifier(row.workspace_id) !== base.workspaceId ||
      storedIdentifier(row.assignment_id) !== base.id ||
      sequenceNumber !== index + 1 ||
      action === null ||
      storedIdentifier(row.actor_account_id) === null ||
      storedIdentifier(row.actor_workspace_id) !== base.workspaceId ||
      actorRoleBasis === null ||
      storedString(row.reason, 4096) === null ||
      createdAt === null ||
      Date.parse(createdAt) < Date.parse(previousAt)
    ) {
      return unavailable();
    }
    if (index === 0 ? action !== "DECLARE" : !(
      (previousAction === "DECLARE" && (action === "CLEAR" || action === "WAIVE")) ||
      (previousAction === "CLEAR" && action === "DECLARE")
    )) {
      return unavailable();
    }
    if (action === "DECLARE" || action === "CLEAR") {
      if (
        row.actor_account_id !== base.reviewerAccountId ||
        actorRoleBasis !== "reviewer"
      ) {
        return unavailable();
      }
    } else if (!ORGANIZER_ROLES.has(actorRoleBasis)) {
      return unavailable();
    }
    history.push(Object.freeze({ action, sequenceNumber, createdAt }));
    previousAction = action;
    previousAt = createdAt;
  }
  const latest = history[history.length - 1]!;
  const status: ReviewerConflictStatus = latest.action === "DECLARE"
    ? "DECLARED"
    : latest.action === "CLEAR"
      ? "CLEARED"
      : "WAIVED";
  return Object.freeze({
    status,
    sequenceNumber: latest.sequenceNumber,
    rows: Object.freeze(history),
  });
}

function assertNoSuccessor(db: Db, base: AssignmentBase): void {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, round_id, submission_id, submission_revision_id, created_at
       FROM review_assignments WHERE supersedes_assignment_id = ?`,
    )
    .all(base.id) as Array<Record<string, unknown>>;
  if (rows.length !== 0) return unavailable();
}

type PredecessorAssignmentRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly round_id: unknown;
  readonly rubric_version_id: unknown;
  readonly submission_id: unknown;
  readonly submission_revision_id: unknown;
  readonly reviewer_account_id: unknown;
  readonly assigned_by: unknown;
  readonly supersedes_assignment_id: unknown;
  readonly created_at: unknown;
  readonly rubric_workspace_id: unknown;
  readonly rubric_round_id: unknown;
  readonly reviewer_workspace_id: unknown;
  readonly assigner_workspace_id: unknown;
};

function assertValidPredecessorChain(db: Db, base: AssignmentBase): void {
  let childId = base.id;
  let childCreatedAt = base.createdAt;
  let predecessorId = base.supersedesAssignmentId;
  const seen = new Set<string>([base.id]);
  for (let depth = 0; predecessorId !== null && depth < 1024; depth += 1) {
    if (seen.has(predecessorId)) return unavailable();
    seen.add(predecessorId);
    const rows = db
      .prepare(
        `SELECT assignment.id, assignment.workspace_id, assignment.round_id,
                assignment.rubric_version_id, assignment.submission_id,
                assignment.submission_revision_id, assignment.reviewer_account_id,
                assignment.assigned_by, assignment.supersedes_assignment_id,
                assignment.created_at,
                rubric.workspace_id AS rubric_workspace_id,
                rubric.round_id AS rubric_round_id,
                reviewer.workspace_id AS reviewer_workspace_id,
                assigner.workspace_id AS assigner_workspace_id
         FROM review_assignments assignment
         JOIN rubric_versions rubric ON rubric.id = assignment.rubric_version_id
         JOIN accounts reviewer ON reviewer.id = assignment.reviewer_account_id
         JOIN accounts assigner ON assigner.id = assignment.assigned_by
         WHERE assignment.id = ?`,
      )
      .all(predecessorId) as PredecessorAssignmentRow[];
    if (rows.length !== 1) return unavailable();
    const row = rows[0]!;
    const predecessorCreatedAt = canonicalTimestamp(row.created_at);
    const reviewerAccountId = storedIdentifier(row.reviewer_account_id);
    const assignedBy = storedIdentifier(row.assigned_by);
    const next = row.supersedes_assignment_id === null
      ? null
      : storedIdentifier(row.supersedes_assignment_id);
    if (
      storedIdentifier(row.id) !== predecessorId ||
      storedIdentifier(row.workspace_id) !== base.workspaceId ||
      storedIdentifier(row.round_id) !== base.roundId ||
      storedIdentifier(row.rubric_version_id) === null ||
      storedIdentifier(row.rubric_workspace_id) !== base.workspaceId ||
      storedIdentifier(row.rubric_round_id) !== base.roundId ||
      storedIdentifier(row.submission_id) !== base.submissionId ||
      storedIdentifier(row.submission_revision_id) !== base.submissionRevisionId ||
      reviewerAccountId === null ||
      storedIdentifier(row.reviewer_workspace_id) !== base.workspaceId ||
      assignedBy === null ||
      storedIdentifier(row.assigner_workspace_id) !== base.workspaceId ||
      (row.supersedes_assignment_id !== null && next === null) ||
      predecessorCreatedAt === null ||
      Date.parse(predecessorCreatedAt) > Date.parse(childCreatedAt)
    ) {
      return unavailable();
    }

    const successors = db
      .prepare(
        `SELECT id FROM review_assignments
         WHERE supersedes_assignment_id = ?`,
      )
      .all(predecessorId) as Array<{ id: unknown }>;
    if (
      successors.length !== 1 ||
      storedIdentifier(successors[0]!.id) !== childId
    ) {
      return unavailable();
    }

    const terminal = loadAssignmentStateHistory(db, {
      id: predecessorId,
      workspaceId: base.workspaceId,
      reviewerAccountId,
      assignedBy,
      createdAt: predecessorCreatedAt,
    });
    if (
      (terminal.state !== "RECUSED" && terminal.state !== "REVOKED") ||
      Date.parse(terminal.createdAt) > Date.parse(childCreatedAt)
    ) {
      return unavailable();
    }
    childId = predecessorId;
    childCreatedAt = predecessorCreatedAt;
    predecessorId = next;
  }
  if (predecessorId !== null) return unavailable();
}

type OperationalAssignment = Readonly<{
  base: AssignmentBase;
  assignmentState: AssignmentStateSnapshot;
  conflict: ConflictSnapshot;
}>;

function loadOperationalAssignment(
  db: Db,
  reviewer: AuthenticatedReviewer,
  assignmentId: string,
): OperationalAssignment {
  if (reviewer.pinnedAssignmentId !== null && assignmentId !== reviewer.pinnedAssignmentId) {
    return unavailable();
  }
  const base = loadAssignmentBase(db, reviewer, assignmentId);
  loadRoundStateHistory(db, base);
  const assignmentState = loadAssignmentStateHistory(db, base);
  const conflict = loadConflictHistory(db, base);
  assertNoSuccessor(db, base);
  assertValidPredecessorChain(db, base);
  return Object.freeze({ base, assignmentState, conflict });
}

function requireReadableAssignment(assignment: OperationalAssignment): void {
  if (
    assignment.assignmentState.state === "RECUSED" ||
    assignment.assignmentState.state === "REVOKED" ||
    assignment.conflict.status === "DECLARED"
  ) {
    return unavailable();
  }
}

function requireMutableAssignment(assignment: OperationalAssignment): void {
  if (
    assignment.assignmentState.state !== "ASSIGNED" &&
    assignment.assignmentState.state !== "IN_PROGRESS"
  ) {
    return fail("REVIEW_STATE_STALE");
  }
  if (assignment.conflict.status === "DECLARED") return fail("REVIEW_STATE_STALE");
}

function latestReviewRevisionNumberMetadata(db: Db, base: AssignmentBase): number {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, assignment_id, round_id, rubric_version_id,
              submission_id, submission_revision_id, revision_number,
              evaluation_schema, fingerprint_algorithm, fingerprint, created_at
       FROM review_revisions
       WHERE assignment_id = ?
       ORDER BY revision_number ASC`,
    )
    .all(base.id) as Array<Record<string, unknown>>;
  let previousAt = base.createdAt;
  for (const [index, row] of rows.entries()) {
    const createdAt = canonicalTimestamp(row.created_at);
    if (
      storedIdentifier(row.id) === null ||
      storedIdentifier(row.workspace_id) !== base.workspaceId ||
      storedIdentifier(row.assignment_id) !== base.id ||
      storedIdentifier(row.round_id) !== base.roundId ||
      storedIdentifier(row.rubric_version_id) !== base.rubricVersionId ||
      storedIdentifier(row.submission_id) !== base.submissionId ||
      storedIdentifier(row.submission_revision_id) !== base.submissionRevisionId ||
      storedInteger(row.revision_number, 1) !== index + 1 ||
      row.evaluation_schema !== CFP_REVIEW_EVALUATION_SCHEMA ||
      row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
      storedFingerprint(row.fingerprint) === null ||
      createdAt === null ||
      Date.parse(createdAt) < Date.parse(previousAt)
    ) {
      return unavailable();
    }
    previousAt = createdAt;
  }
  return rows.length;
}

function projectSummary(
  assignment: OperationalAssignment,
  latestReviewRevisionNumber: number,
): OwnReviewAssignmentSummary {
  const state = assignment.assignmentState.state;
  if (state === "RECUSED" || state === "REVOKED") return unavailable();
  return Object.freeze({
    assignmentId: assignment.base.id,
    roundName: assignment.base.roundName,
    assignedAt: assignment.base.createdAt,
    assignmentState: state,
    assignmentStateSequenceNumber: assignment.assignmentState.sequenceNumber,
    conflictStatus: assignment.conflict.status,
    conflictSequenceNumber: assignment.conflict.sequenceNumber,
    latestReviewRevisionNumber,
    actionBlocked: state === "SUBMITTED" || assignment.conflict.status === "DECLARED",
  });
}

function parseStoredJson(
  serialized: unknown,
  maximumBytes: number,
): { readonly value: JsonSafeValue; readonly canonical: string } {
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  ) {
    return fail("STORED_REVIEW_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return fail("STORED_REVIEW_INVALID");
  }
  let value: JsonSafeValue;
  try {
    value = sanitizeFormData(parsed, STORED_DOCUMENT_LIMITS);
  } catch {
    return fail("STORED_REVIEW_INVALID");
  }
  const canonical = canonicalJson(value);
  if (canonical !== serialized) return fail("STORED_REVIEW_INVALID");
  return Object.freeze({ value, canonical });
}

function validateRubricVersionDocument(db: Db, base: AssignmentBase): void {
  const rows = db
    .prepare(
      `SELECT rubric_schema, rubric_json, fingerprint_algorithm, fingerprint
       FROM rubric_versions
       WHERE workspace_id = ? AND round_id = ? AND id = ?`,
    )
    .all(base.workspaceId, base.roundId, base.rubricVersionId) as Array<{
      rubric_schema: unknown;
      rubric_json: unknown;
      fingerprint_algorithm: unknown;
      fingerprint: unknown;
    }>;
  if (rows.length !== 1) return unavailable();
  const row = rows[0]!;
  if (
    row.rubric_schema !== CFP_RUBRIC_SCHEMA ||
    row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    storedFingerprint(row.fingerprint) !== base.rubricFingerprint
  ) {
    return unavailable();
  }
  const parsed = parseStoredJson(row.rubric_json, 4 * 1024 * 1024);
  if (fingerprintOf(parsed.value) !== base.rubricFingerprint) return unavailable();
}

type RevisionMetadataRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly submission_id: unknown;
  readonly revision_number: unknown;
  readonly revision_schema: unknown;
  readonly form_version_id: unknown;
  readonly rule_version_id: unknown;
  readonly form_document_schema: unknown;
  readonly form_document_fingerprint: unknown;
  readonly fingerprint_algorithm: unknown;
  readonly fingerprint: unknown;
  readonly created_at: unknown;
};

type VerifiedRevision = Readonly<{
  id: string;
  number: number;
  schema: typeof CFP_SUBMISSION_REVISION_SCHEMA;
  fingerprint: string;
  createdAt: string;
  formVersionId: string;
  ruleVersionId: string;
  formDocumentFingerprint: string;
  revision: SubmissionRevision;
}>;

function loadStrictAssignmentRevision(db: Db, base: AssignmentBase): VerifiedRevision {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, submission_id, revision_number, revision_schema,
              form_version_id, rule_version_id, form_document_schema,
              form_document_fingerprint, fingerprint_algorithm, fingerprint, created_at
       FROM submission_revisions
       WHERE workspace_id = ? AND id = ?`,
    )
    .all(base.workspaceId, base.submissionRevisionId) as RevisionMetadataRow[];
  if (rows.length !== 1) return unavailable();
  const row = rows[0]!;
  const number = storedInteger(row.revision_number, 1);
  const createdAt = canonicalTimestamp(row.created_at);
  const formVersionId = storedIdentifier(row.form_version_id);
  const ruleVersionId = storedIdentifier(row.rule_version_id);
  const fingerprint = storedFingerprint(row.fingerprint);
  const formDocumentFingerprint = storedFingerprint(row.form_document_fingerprint);
  if (
    storedIdentifier(row.id) !== base.submissionRevisionId ||
    storedIdentifier(row.workspace_id) !== base.workspaceId ||
    storedIdentifier(row.submission_id) !== base.submissionId ||
    number === null ||
    row.revision_schema !== CFP_SUBMISSION_REVISION_SCHEMA ||
    formVersionId !== base.pinnedFormVersionId ||
    ruleVersionId !== base.pinnedRuleVersionId ||
    row.form_document_schema !== CFP_FORM_DOCUMENT_SCHEMA ||
    formDocumentFingerprint === null ||
    row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    fingerprint === null ||
    createdAt === null ||
    Date.parse(createdAt) < Date.parse(base.submissionCreatedAt) ||
    Date.parse(createdAt) > Date.parse(base.createdAt)
  ) {
    return unavailable();
  }
  let revision: SubmissionRevision;
  try {
    revision = readSubmissionRevision(db, base.workspaceId, base.submissionRevisionId);
  } catch {
    return unavailable();
  }
  if (
    revision.schema !== CFP_SUBMISSION_REVISION_SCHEMA ||
    revision.submissionId !== base.submissionId ||
    revision.revisionNumber !== number ||
    revision.fingerprintAlgorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    revision.fingerprint !== fingerprint ||
    revision.formDocument.schema !== CFP_FORM_DOCUMENT_SCHEMA ||
    revision.formDocument.formVersionId !== formVersionId ||
    revision.formDocument.ruleVersionId !== ruleVersionId ||
    revision.formDocument.fingerprint !== formDocumentFingerprint
  ) {
    return unavailable();
  }
  return Object.freeze({
    id: base.submissionRevisionId,
    number,
    schema: CFP_SUBMISSION_REVISION_SCHEMA,
    fingerprint,
    createdAt,
    formVersionId,
    ruleVersionId,
    formDocumentFingerprint,
    revision,
  });
}

type SemanticsRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly round_id: unknown;
  readonly rubric_version_id: unknown;
  readonly rubric_version_number: unknown;
  readonly rubric_version_fingerprint: unknown;
  readonly semantics_schema: unknown;
  readonly semantics_version: unknown;
  readonly semantics_json: unknown;
  readonly fingerprint_algorithm: unknown;
  readonly fingerprint: unknown;
  readonly issued_by_account_id: unknown;
  readonly issuer_role: unknown;
  readonly issuer_authority: unknown;
  readonly idempotency_key: unknown;
  readonly request_fingerprint_algorithm: unknown;
  readonly request_fingerprint: unknown;
  readonly issued_at: unknown;
};

type VerifiedSemantics = Readonly<{
  id: string;
  fingerprint: string;
  issuedAt: string;
  document: ReviewRubricSemanticsV1;
  projection: RubricProjection;
}>;

function assertIssuerSnapshot(
  db: Db,
  workspaceId: string,
  accountId: string,
  role: string,
  issuedAt: string,
): void {
  if (!ORGANIZER_ROLES.has(role)) return unavailable();
  const rows = db
    .prepare("SELECT workspace_id, created_at FROM accounts WHERE id = ?")
    .all(accountId) as Array<{ workspace_id: unknown; created_at: unknown }>;
  if (rows.length !== 1) return unavailable();
  const createdAt = canonicalTimestamp(rows[0]!.created_at);
  if (
    storedIdentifier(rows[0]!.workspace_id) !== workspaceId ||
    createdAt === null ||
    Date.parse(createdAt) > Date.parse(issuedAt)
  ) {
    return unavailable();
  }
}

function loadVerifiedSemantics(db: Db, base: AssignmentBase): VerifiedSemantics {
  const rows = db
    .prepare(
      `SELECT * FROM review_rubric_semantics
       WHERE workspace_id = ? AND round_id = ? AND rubric_version_id = ?`,
    )
    .all(base.workspaceId, base.roundId, base.rubricVersionId) as SemanticsRow[];
  if (rows.length !== 1) return unavailable();
  const row = rows[0]!;
  const id = storedIdentifier(row.id);
  const fingerprint = storedFingerprint(row.fingerprint);
  const issuedAt = canonicalTimestamp(row.issued_at);
  const issuerAccountId = storedIdentifier(row.issued_by_account_id);
  const issuerRole = storedIdentifier(row.issuer_role);
  if (
    id === null ||
    storedIdentifier(row.workspace_id) !== base.workspaceId ||
    storedIdentifier(row.round_id) !== base.roundId ||
    storedIdentifier(row.rubric_version_id) !== base.rubricVersionId ||
    storedInteger(row.rubric_version_number, 1) !== base.rubricVersionNumber ||
    storedFingerprint(row.rubric_version_fingerprint) !== base.rubricFingerprint ||
    row.semantics_schema !== CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA ||
    row.semantics_version !== 1 ||
    row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    fingerprint === null ||
    issuerAccountId === null ||
    issuerRole === null ||
    row.issuer_authority !== REVIEW_ISSUER_AUTHORITY ||
    storedString(row.idempotency_key, 128) === null ||
    row.request_fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    storedFingerprint(row.request_fingerprint) === null ||
    issuedAt === null ||
    Date.parse(issuedAt) < Date.parse(base.rubricSealedAt) ||
    Date.parse(issuedAt) < Date.parse(base.roundCreatedAt)
  ) {
    return unavailable();
  }
  let document: ReviewRubricSemanticsV1;
  try {
    document = parseCanonicalReviewRubricSemantics(row.semantics_json as string);
  } catch {
    return unavailable();
  }
  if (
    fingerprintReviewRubricSemantics(document) !== fingerprint ||
    document.workspaceId !== base.workspaceId ||
    document.roundId !== base.roundId ||
    document.rubricVersionId !== base.rubricVersionId ||
    document.rubricVersionNumber !== base.rubricVersionNumber ||
    document.rubricVersionFingerprint !== base.rubricFingerprint ||
    document.issuer.accountId !== issuerAccountId ||
    document.issuer.role !== issuerRole ||
    document.issuer.authority !== REVIEW_ISSUER_AUTHORITY ||
    document.issuedAt !== issuedAt ||
    (document.customRubric !== undefined &&
      fingerprintOf(document.customRubric) !== base.rubricFingerprint)
  ) {
    return unavailable();
  }
  assertIssuerSnapshot(db, base.workspaceId, issuerAccountId, issuerRole, issuedAt);
  return Object.freeze({
    id,
    fingerprint,
    issuedAt,
    document,
    projection: projectReviewRubricSemantics(document),
  });
}

type ArtifactRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly assignment_id: unknown;
  readonly assignment_created_at: unknown;
  readonly rubric_version_id: unknown;
  readonly rubric_semantics_id: unknown;
  readonly rubric_semantics_fingerprint: unknown;
  readonly submission_id: unknown;
  readonly submission_revision_id: unknown;
  readonly submission_revision_number: unknown;
  readonly submission_revision_schema: unknown;
  readonly submission_revision_fingerprint_algorithm: unknown;
  readonly submission_revision_fingerprint: unknown;
  readonly submission_revision_created_at: unknown;
  readonly form_document_schema: unknown;
  readonly form_version_id: unknown;
  readonly rule_version_id: unknown;
  readonly form_document_fingerprint: unknown;
  readonly disclosure_stage: unknown;
  readonly conflict_status_at_issuance: unknown;
  readonly conflict_sequence_at_issuance: unknown;
  readonly artifact_schema: unknown;
  readonly artifact_version: unknown;
  readonly artifact_json: unknown;
  readonly fingerprint_algorithm: unknown;
  readonly fingerprint: unknown;
  readonly blind_safety_attestation: unknown;
  readonly issued_by_account_id: unknown;
  readonly issuer_role: unknown;
  readonly issuer_authority: unknown;
  readonly idempotency_key: unknown;
  readonly request_fingerprint_algorithm: unknown;
  readonly request_fingerprint: unknown;
  readonly issued_at: unknown;
};

function assertArtifactConflictSnapshot(
  conflict: ConflictSnapshot,
  artifact: BlindReviewArtifactV1,
): void {
  const status = artifact.conflictAtIssuance.status;
  const sequence = artifact.conflictAtIssuance.sequenceNumber;
  const issuedAt = Date.parse(artifact.issuedAt);
  if (status === "NONE") {
    if (
      sequence !== 0 ||
      conflict.rows.some((row) => Date.parse(row.createdAt) < issuedAt)
    ) {
      return unavailable();
    }
    return;
  }
  if (sequence < 1 || sequence > conflict.rows.length) return unavailable();
  const latest = conflict.rows[sequence - 1]!;
  if (
    latest.sequenceNumber !== sequence ||
    Date.parse(latest.createdAt) > issuedAt ||
    (status === "CLEARED" && latest.action !== "CLEAR") ||
    (status === "WAIVED" && latest.action !== "WAIVE") ||
    conflict.rows
      .slice(sequence)
      .some((row) => Date.parse(row.createdAt) < issuedAt)
  ) {
    return unavailable();
  }
}

function cloneRedactedValue(value: JsonSafeValue): JsonSafeValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneRedactedValue(item)));
  }
  if (value !== null && typeof value === "object") {
    const record = value as JsonSafeObject;
    const output: Record<string, JsonSafeValue> = {};
    for (const key of Object.keys(record)) {
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: cloneRedactedValue(record[key]!),
        writable: false,
      });
    }
    return Object.freeze(output);
  }
  return value;
}

function projectBlindProposal(
  artifact: BlindReviewArtifactV1,
): ReviewerBlindProposalProjection {
  const included = artifact.items
    .filter((item) => item.disposition === "INCLUDE_REDACTED")
    .sort((left, right) => left.displayOrder - right.displayOrder);
  const answers: BlindAnswerProjection[] = included.map((item) =>
    Object.freeze({
      answerKey: item.answerKey,
      label: item.label,
      type: item.type,
      value: cloneRedactedValue(item.value),
    }),
  );
  return Object.freeze({
    revisionSequence: artifact.submissionRevision.number,
    disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
    answers: Object.freeze(answers),
  });
}

function decisionsFromArtifact(
  artifact: BlindReviewArtifactV1,
): readonly BlindFieldDecisionInput[] {
  return Object.freeze(
    artifact.items.map((item) =>
      item.disposition === "EXCLUDE"
        ? Object.freeze({ sourceFieldId: item.sourceFieldId, action: "EXCLUDE" as const })
        : Object.freeze({
            sourceFieldId: item.sourceFieldId,
            action: "INCLUDE_REDACTED" as const,
            reviewLabel: item.label,
            redactedValue: item.value,
          }),
    ),
  );
}

function loadArtifactRow(db: Db, base: AssignmentBase): ArtifactRow {
  const rows = db
    .prepare(
      `SELECT * FROM review_blind_artifacts
       WHERE workspace_id = ? AND assignment_id = ?`,
    )
    .all(base.workspaceId, base.id) as ArtifactRow[];
  if (rows.length !== 1) return unavailable();
  return rows[0]!;
}

function loadVerifiedArtifact(
  db: Db,
  row: ArtifactRow,
  assignment: OperationalAssignment,
  revision: VerifiedRevision,
  semantics: VerifiedSemantics,
): ReviewerBlindProposalProjection {
  const base = assignment.base;
  const issuedAt = canonicalTimestamp(row.issued_at);
  const issuerAccountId = storedIdentifier(row.issued_by_account_id);
  const issuerRole = storedIdentifier(row.issuer_role);
  const fingerprint = storedFingerprint(row.fingerprint);
  if (
    storedIdentifier(row.id) === null ||
    storedIdentifier(row.workspace_id) !== base.workspaceId ||
    storedIdentifier(row.assignment_id) !== base.id ||
    canonicalTimestamp(row.assignment_created_at) !== base.createdAt ||
    storedIdentifier(row.rubric_version_id) !== base.rubricVersionId ||
    storedIdentifier(row.rubric_semantics_id) !== semantics.id ||
    storedFingerprint(row.rubric_semantics_fingerprint) !== semantics.fingerprint ||
    storedIdentifier(row.submission_id) !== base.submissionId ||
    storedIdentifier(row.submission_revision_id) !== revision.id ||
    storedInteger(row.submission_revision_number, 1) !== revision.number ||
    row.submission_revision_schema !== CFP_SUBMISSION_REVISION_SCHEMA ||
    row.submission_revision_fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    storedFingerprint(row.submission_revision_fingerprint) !== revision.fingerprint ||
    canonicalTimestamp(row.submission_revision_created_at) !== revision.createdAt ||
    row.form_document_schema !== CFP_FORM_DOCUMENT_SCHEMA ||
    storedIdentifier(row.form_version_id) !== revision.formVersionId ||
    storedIdentifier(row.rule_version_id) !== revision.ruleVersionId ||
    storedFingerprint(row.form_document_fingerprint) !== revision.formDocumentFingerprint ||
    row.disclosure_stage !== BLIND_REVIEW_DISCLOSURE_STAGE ||
    !["NONE", "CLEARED", "WAIVED"].includes(String(row.conflict_status_at_issuance)) ||
    storedInteger(row.conflict_sequence_at_issuance, 0) === null ||
    row.artifact_schema !== CFP_REVIEW_BLIND_ARTIFACT_SCHEMA ||
    row.artifact_version !== 1 ||
    row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    fingerprint === null ||
    row.blind_safety_attestation !== BLIND_REVIEW_ATTESTATION ||
    issuerAccountId === null ||
    issuerRole === null ||
    row.issuer_authority !== REVIEW_ISSUER_AUTHORITY ||
    storedString(row.idempotency_key, 128) === null ||
    row.request_fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    storedFingerprint(row.request_fingerprint) === null ||
    issuedAt === null ||
    Date.parse(issuedAt) < Date.parse(base.createdAt) ||
    Date.parse(issuedAt) < Date.parse(revision.createdAt) ||
    Date.parse(issuedAt) < Date.parse(semantics.issuedAt)
  ) {
    return unavailable();
  }
  let artifact: BlindReviewArtifactV1;
  try {
    artifact = parseCanonicalBlindReviewArtifact(row.artifact_json as string);
  } catch {
    return unavailable();
  }
  if (
    fingerprintBlindReviewArtifact(artifact) !== fingerprint ||
    artifact.workspaceId !== base.workspaceId ||
    artifact.assignmentId !== base.id ||
    artifact.assignmentCreatedAt !== base.createdAt ||
    artifact.rubricVersionId !== base.rubricVersionId ||
    artifact.rubricSemanticsId !== semantics.id ||
    artifact.rubricSemanticsFingerprint !== semantics.fingerprint ||
    artifact.submissionId !== base.submissionId ||
    artifact.submissionRevision.id !== revision.id ||
    artifact.submissionRevision.number !== revision.number ||
    artifact.submissionRevision.schema !== revision.schema ||
    artifact.submissionRevision.fingerprint !== revision.fingerprint ||
    artifact.submissionRevision.createdAt !== revision.createdAt ||
    artifact.submissionRevision.formDocumentSchema !== CFP_FORM_DOCUMENT_SCHEMA ||
    artifact.submissionRevision.formVersionId !== revision.formVersionId ||
    artifact.submissionRevision.ruleVersionId !== revision.ruleVersionId ||
    artifact.submissionRevision.formDocumentFingerprint !== revision.formDocumentFingerprint ||
    artifact.disclosureStage !== BLIND_REVIEW_DISCLOSURE_STAGE ||
    artifact.conflictAtIssuance.status !== row.conflict_status_at_issuance ||
    artifact.conflictAtIssuance.sequenceNumber !== row.conflict_sequence_at_issuance ||
    artifact.attestation !== BLIND_REVIEW_ATTESTATION ||
    artifact.issuer.accountId !== issuerAccountId ||
    artifact.issuer.role !== issuerRole ||
    artifact.issuer.authority !== REVIEW_ISSUER_AUTHORITY ||
    artifact.issuedAt !== issuedAt
  ) {
    return unavailable();
  }
  assertArtifactConflictSnapshot(assignment.conflict, artifact);
  assertIssuerSnapshot(db, base.workspaceId, issuerAccountId, issuerRole, issuedAt);

  let reconstructed: BlindReviewArtifactV1;
  try {
    reconstructed = createBlindReviewArtifact({
      workspaceId: base.workspaceId,
      assignmentId: base.id,
      assignmentCreatedAt: base.createdAt,
      rubricVersionId: base.rubricVersionId,
      rubricSemanticsId: semantics.id,
      rubricSemanticsFingerprint: semantics.fingerprint,
      submissionId: base.submissionId,
      submissionRevision: {
        id: revision.id,
        number: revision.number,
        schema: revision.schema,
        fingerprint: revision.fingerprint,
        createdAt: revision.createdAt,
        formDocument: revision.revision.formDocument,
      },
      disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
      conflictAtIssuance: artifact.conflictAtIssuance,
      attestation: BLIND_REVIEW_ATTESTATION,
      issuer: artifact.issuer,
      issuedAt,
      decisions: decisionsFromArtifact(artifact),
    });
  } catch {
    return unavailable();
  }
  if (
    canonicalBlindReviewArtifactJson(reconstructed) !== row.artifact_json ||
    fingerprintBlindReviewArtifact(reconstructed) !== fingerprint
  ) {
    return unavailable();
  }
  return projectBlindProposal(reconstructed);
}

type TrustedReviewPacket = Readonly<{
  revision: VerifiedRevision;
  semantics: VerifiedSemantics;
  proposal: ReviewerBlindProposalProjection;
}>;

function loadTrustedReviewPacket(
  db: Db,
  assignment: OperationalAssignment,
): TrustedReviewPacket {
  try {
    validateRubricVersionDocument(db, assignment.base);
    const semantics = loadVerifiedSemantics(db, assignment.base);
    const artifactRow = loadArtifactRow(db, assignment.base);
    const revision = loadStrictAssignmentRevision(db, assignment.base);
    const proposal = loadVerifiedArtifact(
      db,
      artifactRow,
      assignment,
      revision,
      semantics,
    );
    return Object.freeze({ revision, semantics, proposal });
  } catch (error) {
    if (
      error instanceof ReviewerServiceError &&
      error.code === "ASSIGNMENT_NOT_AVAILABLE"
    ) {
      throw error;
    }
    return unavailable();
  }
}

function numericStepMatches(
  value: number,
  minimum: number,
  step: number,
): boolean {
  const quotient = (value - minimum) / step;
  const nearest = Math.round(quotient);
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(quotient));
  return Math.abs(quotient - nearest) <= tolerance;
}

function validateEvaluationValue(
  response: ReviewEvaluationResponse,
  criterion: ReviewCriterionSemantics | CustomReviewRubricField,
): void {
  const value = response.value;
  if (criterion.kind === "numeric") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      criterion.minimum === null ||
      criterion.maximum === null ||
      criterion.step === null ||
      value < criterion.minimum ||
      value > criterion.maximum ||
      !numericStepMatches(value, criterion.minimum, criterion.step)
    ) {
      return fail("EVALUATION_INVALID");
    }
    return;
  }
  if (criterion.kind === "dropdown") {
    if (
      typeof value !== "string" ||
      !criterion.choices.some((choice) => choice.value === value)
    ) {
      return fail("EVALUATION_INVALID");
    }
    return;
  }
  if (criterion.kind === "scale") {
    if (
      typeof value !== "string" ||
      !REVIEW_SCALE_CHOICES.some((choice) => choice.value === value)
    ) {
      return fail("EVALUATION_INVALID");
    }
    return;
  }
  if (criterion.kind === "yesNo") {
    if (typeof value !== "boolean") return fail("EVALUATION_INVALID");
    return;
  }
  if (criterion.kind === "recommendation") {
    if (
      typeof value !== "string" ||
      !REVIEW_RECOMMENDATION_CHOICES.some((choice) => choice.value === value)
    ) {
      return fail("EVALUATION_INVALID");
    }
    return;
  }
  if (
    criterion.kind === "text" &&
    (typeof value !== "string" ||
      criterion.maxLength === null ||
      [...value].length > criterion.maxLength ||
      Buffer.byteLength(value, "utf8") > REVIEW_RUBRIC_LIMITS.maxCommentLength)
  ) {
    return fail("EVALUATION_INVALID");
  }
  if (
    criterion.kind === "comment" &&
    (typeof value !== "string" ||
      [...value].length > criterion.maxLength ||
      Buffer.byteLength(value, "utf8") > REVIEW_RUBRIC_LIMITS.maxCommentLength)
  ) {
    return fail("EVALUATION_INVALID");
  }
}

function validateEvaluation(
  evaluation: ReviewEvaluation,
  semantics: ReviewRubricSemanticsV1,
  requireComplete: boolean,
): ReviewEvaluation {
  const criteriaById = new Map<string, ReviewCriterionSemantics | CustomReviewRubricField>(
    semantics.customRubric !== undefined
      ? semantics.customRubric.fields.map((criterion) => [criterion.id, criterion] as const)
      : semantics.criteria.map((criterion, index) => [
          `criterion-${String(index + 1).padStart(4, "0")}`,
          criterion,
        ] as const),
  );
  const responseById = new Map<string, ReviewEvaluationResponse>();
  for (const response of evaluation.responses) {
    const criterion = criteriaById.get(response.criterionId);
    if (!criterion || responseById.has(response.criterionId)) {
      return fail("EVALUATION_INVALID");
    }
    validateEvaluationValue(response, criterion);
    responseById.set(response.criterionId, response);
  }
  if (requireComplete) {
    for (const [criterionId, criterion] of criteriaById) {
      if (!criterion.required) continue;
      const response = responseById.get(criterionId);
      if (
        !response ||
        ((criterion.kind === "comment" || criterion.kind === "text") &&
          typeof response.value === "string" &&
          response.value.trim().length === 0)
      ) {
        return fail("EVALUATION_INCOMPLETE");
      }
    }
  }
  return evaluation;
}

type StoredEvaluationDocument = Readonly<{
  schema: typeof CFP_REVIEW_EVALUATION_SCHEMA;
  assignmentId: string;
  rubricVersionId: string;
  submissionRevisionId: string;
  reviewRevisionNumber: number;
  responses: readonly ReviewEvaluationResponse[];
}>;

function buildStoredEvaluation(
  base: AssignmentBase,
  revisionNumber: number,
  evaluation: ReviewEvaluation,
): StoredEvaluationDocument {
  return Object.freeze({
    schema: CFP_REVIEW_EVALUATION_SCHEMA,
    assignmentId: base.id,
    rubricVersionId: base.rubricVersionId,
    submissionRevisionId: base.submissionRevisionId,
    reviewRevisionNumber: revisionNumber,
    responses: evaluation.responses,
  });
}

function storedEvaluationProjection(value: JsonSafeObject): ReviewEvaluation {
  if (!Array.isArray(value.responses) || value.responses.length > REVIEW_RUBRIC_LIMITS.maxCustomCriteria) {
    return fail("STORED_REVIEW_INVALID");
  }
  const responses: ReviewEvaluationResponse[] = [];
  const seen = new Set<string>();
  let previousId = "";
  for (const candidate of value.responses) {
    if (
      !isObject(candidate) ||
      !hasExactKeys(candidate, new Set(["criterionId", "value"])) ||
      typeof candidate.criterionId !== "string" ||
      !CRITERION_ID_PATTERN.test(candidate.criterionId) ||
      seen.has(candidate.criterionId) ||
      candidate.criterionId.localeCompare(previousId) <= 0 ||
      (typeof candidate.value !== "string" &&
        typeof candidate.value !== "number" &&
        typeof candidate.value !== "boolean")
    ) {
      return fail("STORED_REVIEW_INVALID");
    }
    seen.add(candidate.criterionId);
    previousId = candidate.criterionId;
    responses.push(Object.freeze({
      criterionId: candidate.criterionId,
      value: candidate.value,
    }));
  }
  return Object.freeze({
    schema: CFP_REVIEW_EVALUATION_SCHEMA,
    responses: Object.freeze(responses),
  });
}

type ReviewRevisionRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly assignment_id: unknown;
  readonly round_id: unknown;
  readonly rubric_version_id: unknown;
  readonly submission_id: unknown;
  readonly submission_revision_id: unknown;
  readonly revision_number: unknown;
  readonly evaluation_schema: unknown;
  readonly evaluation_json: unknown;
  readonly fingerprint_algorithm: unknown;
  readonly fingerprint: unknown;
  readonly created_at: unknown;
};

type ReviewRevisionHistory = Readonly<{
  latest: OwnReviewRevisionProjection | null;
  latestNumber: number;
  latestEvaluation: ReviewEvaluation | null;
}>;

function loadReviewRevisionHistory(
  db: Db,
  assignment: OperationalAssignment,
  semantics: ReviewRubricSemanticsV1,
): ReviewRevisionHistory {
  const base = assignment.base;
  const rows = db
    .prepare(
      `SELECT * FROM review_revisions
       WHERE assignment_id = ? ORDER BY revision_number ASC`,
    )
    .all(base.id) as ReviewRevisionRow[];
  let previousAt = base.createdAt;
  let latest: OwnReviewRevisionProjection | null = null;
  let latestEvaluation: ReviewEvaluation | null = null;
  for (const [index, row] of rows.entries()) {
    const revisionNumber = storedInteger(row.revision_number, 1);
    const createdAt = canonicalTimestamp(row.created_at);
    const fingerprint = storedFingerprint(row.fingerprint);
    if (
      storedIdentifier(row.id) === null ||
      storedIdentifier(row.workspace_id) !== base.workspaceId ||
      storedIdentifier(row.assignment_id) !== base.id ||
      storedIdentifier(row.round_id) !== base.roundId ||
      storedIdentifier(row.rubric_version_id) !== base.rubricVersionId ||
      storedIdentifier(row.submission_id) !== base.submissionId ||
      storedIdentifier(row.submission_revision_id) !== base.submissionRevisionId ||
      revisionNumber !== index + 1 ||
      row.evaluation_schema !== CFP_REVIEW_EVALUATION_SCHEMA ||
      row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
      fingerprint === null ||
      createdAt === null ||
      Date.parse(createdAt) < Date.parse(previousAt) ||
      (assignment.assignmentState.state === "SUBMITTED" &&
        Date.parse(createdAt) > Date.parse(assignment.assignmentState.createdAt))
    ) {
      return fail("STORED_REVIEW_INVALID");
    }
    const parsed = parseStoredJson(row.evaluation_json, 4 * 1024 * 1024);
    if (
      !isObject(parsed.value) ||
      !hasExactKeys(
        parsed.value,
        new Set([
          "schema",
          "assignmentId",
          "rubricVersionId",
          "submissionRevisionId",
          "reviewRevisionNumber",
          "responses",
        ]),
      ) ||
      parsed.value.schema !== CFP_REVIEW_EVALUATION_SCHEMA ||
      parsed.value.assignmentId !== base.id ||
      parsed.value.rubricVersionId !== base.rubricVersionId ||
      parsed.value.submissionRevisionId !== base.submissionRevisionId ||
      parsed.value.reviewRevisionNumber !== revisionNumber ||
      fingerprintOf(parsed.value) !== fingerprint
    ) {
      return fail("STORED_REVIEW_INVALID");
    }
    const evaluation = storedEvaluationProjection(parsed.value);
    try {
      validateEvaluation(evaluation, semantics, false);
    } catch {
      return fail("STORED_REVIEW_INVALID");
    }
    latestEvaluation = evaluation;
    latest = Object.freeze({
      revisionNumber,
      evaluation,
      savedAt: createdAt,
    });
    previousAt = createdAt;
  }
  if (assignment.assignmentState.state === "SUBMITTED" && latest === null) {
    return fail("STORED_REVIEW_INVALID");
  }
  return Object.freeze({
    latest,
    latestNumber: rows.length,
    latestEvaluation,
  });
}

type CapturedRequest = Readonly<{
  schema: typeof CFP_REVIEW_COMMAND_REQUEST_SCHEMA;
  workspaceId: string;
  actorAccountId: string;
  assignmentId: string;
  commandKind: ReviewerCommandKind;
  payload: JsonSafeObject;
}>;

function buildRequest(
  reviewer: AuthenticatedReviewer,
  assignmentId: string,
  commandKind: ReviewerCommandKind,
  payload: JsonSafeObject,
): CapturedRequest {
  return Object.freeze({
    schema: CFP_REVIEW_COMMAND_REQUEST_SCHEMA,
    workspaceId: reviewer.workspaceId,
    actorAccountId: reviewer.accountId,
    assignmentId,
    commandKind,
    payload,
  });
}

function conflictRequestPayload(
  input: DeclareOwnReviewConflictInput,
): JsonSafeObject {
  return Object.freeze({
    expectedAssignmentStateSequenceNumber:
      input.expectedAssignmentStateSequenceNumber,
    expectedConflictSequenceNumber: input.expectedConflictSequenceNumber,
    reason: input.reason,
  });
}

function saveRequestPayload(input: SaveOwnReviewInput): JsonSafeObject {
  return Object.freeze({
    expectedAssignmentStateSequenceNumber:
      input.expectedAssignmentStateSequenceNumber,
    expectedReviewRevisionNumber: input.expectedReviewRevisionNumber,
    evaluation: input.evaluation as unknown as JsonSafeValue,
  });
}

function submitRequestPayload(input: SubmitOwnReviewInput): JsonSafeObject {
  return Object.freeze({
    expectedAssignmentStateSequenceNumber:
      input.expectedAssignmentStateSequenceNumber,
    expectedReviewRevisionNumber: input.expectedReviewRevisionNumber,
  });
}

type ReceiptRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly assignment_id: unknown;
  readonly round_id: unknown;
  readonly rubric_version_id: unknown;
  readonly submission_revision_id: unknown;
  readonly actor_account_id: unknown;
  readonly command_kind: unknown;
  readonly idempotency_key: unknown;
  readonly request_schema: unknown;
  readonly request_fingerprint_algorithm: unknown;
  readonly request_fingerprint: unknown;
  readonly effect_id: unknown;
  readonly receipt_schema: unknown;
  readonly receipt_json: unknown;
  readonly receipt_fingerprint_algorithm: unknown;
  readonly receipt_fingerprint: unknown;
  readonly created_at: unknown;
};

function assertReceiptAssignmentBinding(db: Db, row: ReceiptRow): void {
  const matches = db
    .prepare(
      `SELECT assignment.id
       FROM review_assignments assignment
       JOIN review_rounds round ON round.id = assignment.round_id
       JOIN rubric_versions rubric ON rubric.id = assignment.rubric_version_id
       JOIN submission_revisions revision ON revision.id = assignment.submission_revision_id
       JOIN accounts actor ON actor.id = assignment.reviewer_account_id
       WHERE assignment.id = ? AND assignment.workspace_id = ?
         AND assignment.round_id = ? AND assignment.rubric_version_id = ?
         AND assignment.submission_revision_id = ?
         AND assignment.reviewer_account_id = ?
         AND round.workspace_id = assignment.workspace_id
         AND rubric.workspace_id = assignment.workspace_id
         AND rubric.round_id = assignment.round_id
         AND revision.workspace_id = assignment.workspace_id
         AND revision.submission_id = assignment.submission_id
         AND actor.workspace_id = assignment.workspace_id`,
    )
    .all(
      row.assignment_id as string,
      row.workspace_id as string,
      row.round_id as string,
      row.rubric_version_id as string,
      row.submission_revision_id as string,
      row.actor_account_id as string,
    );
  if (matches.length !== 1) return fail("STORED_REVIEW_INVALID");
}

function assertReceiptEffectBinding(
  db: Db,
  row: ReceiptRow,
  outcome: JsonSafeObject,
): void {
  const common = [
    row.effect_id as string,
    row.workspace_id as string,
    row.assignment_id as string,
    row.created_at as string,
  ] as const;
  if (row.command_kind === "SAVE_REVIEW") {
    const effects = db
      .prepare(
        `SELECT revision_number FROM review_revisions
         WHERE id = ? AND workspace_id = ? AND assignment_id = ? AND created_at = ?
           AND round_id = ? AND rubric_version_id = ? AND submission_revision_id = ?`,
      )
      .all(
        ...common,
        row.round_id as string,
        row.rubric_version_id as string,
        row.submission_revision_id as string,
      ) as Array<{ revision_number: unknown }>;
    if (
      effects.length !== 1 ||
      storedInteger(effects[0]!.revision_number, 1) !== outcome.reviewRevisionNumber
    ) {
      return fail("STORED_REVIEW_INVALID");
    }
    return;
  }
  if (row.command_kind === "SUBMIT_REVIEW") {
    const effects = db
      .prepare(
        `SELECT id FROM review_assignment_states
         WHERE id = ? AND workspace_id = ? AND assignment_id = ? AND created_at = ?
           AND state = 'SUBMITTED' AND actor_account_id = ?`,
      )
      .all(...common, row.actor_account_id as string);
    if (effects.length !== 1) return fail("STORED_REVIEW_INVALID");
    return;
  }
  const action = row.command_kind === "CONFLICT_DECLARE" ? "DECLARE" : "CLEAR";
  const effects = db
    .prepare(
      `SELECT id FROM review_conflict_dispositions
       WHERE id = ? AND workspace_id = ? AND assignment_id = ? AND created_at = ?
         AND action = ? AND actor_account_id = ?`,
    )
    .all(...common, action, row.actor_account_id as string);
  if (effects.length !== 1) return fail("STORED_REVIEW_INVALID");
}

function validateStoredReceipt(db: Db, row: ReceiptRow): ReviewCommandReceipt {
  const commandKind = typeof row.command_kind === "string" && [
    "CONFLICT_DECLARE",
    "CONFLICT_CLEAR",
    "SAVE_REVIEW",
    "SUBMIT_REVIEW",
  ].includes(row.command_kind)
    ? row.command_kind as ReviewerCommandKind
    : null;
  const createdAt = canonicalTimestamp(row.created_at);
  const effectId = storedIdentifier(row.effect_id);
  const receiptFingerprint = storedFingerprint(row.receipt_fingerprint);
  if (
    storedIdentifier(row.id) === null ||
    storedIdentifier(row.workspace_id) === null ||
    storedIdentifier(row.assignment_id) === null ||
    storedIdentifier(row.round_id) === null ||
    storedIdentifier(row.rubric_version_id) === null ||
    storedIdentifier(row.submission_revision_id) === null ||
    storedIdentifier(row.actor_account_id) === null ||
    commandKind === null ||
    storedString(row.idempotency_key, 128) === null ||
    row.request_schema !== CFP_REVIEW_COMMAND_REQUEST_SCHEMA ||
    row.request_fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    storedFingerprint(row.request_fingerprint) === null ||
    effectId === null ||
    row.receipt_schema !== CFP_REVIEW_COMMAND_RECEIPT_SCHEMA ||
    row.receipt_fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM ||
    receiptFingerprint === null ||
    createdAt === null
  ) {
    return fail("STORED_REVIEW_INVALID");
  }
  const parsed = parseStoredJson(row.receipt_json, 64 * 1024);
  if (
    !isObject(parsed.value) ||
    !hasExactKeys(
      parsed.value,
      new Set([
        "schema",
        "workspaceId",
        "assignmentId",
        "roundId",
        "rubricVersionId",
        "submissionRevisionId",
        "actorAccountId",
        "commandKind",
        "effectId",
        "createdAt",
        "outcome",
      ]),
    ) ||
    parsed.value.schema !== CFP_REVIEW_COMMAND_RECEIPT_SCHEMA ||
    parsed.value.workspaceId !== row.workspace_id ||
    parsed.value.assignmentId !== row.assignment_id ||
    parsed.value.roundId !== row.round_id ||
    parsed.value.rubricVersionId !== row.rubric_version_id ||
    parsed.value.submissionRevisionId !== row.submission_revision_id ||
    parsed.value.actorAccountId !== row.actor_account_id ||
    parsed.value.commandKind !== commandKind ||
    parsed.value.effectId !== effectId ||
    parsed.value.createdAt !== createdAt ||
    fingerprintOf(parsed.value) !== receiptFingerprint ||
    !isObject(parsed.value.outcome!)
  ) {
    return fail("STORED_REVIEW_INVALID");
  }
  const outcome = parsed.value.outcome;
  if (commandKind === "SAVE_REVIEW") {
    if (
      !hasExactKeys(outcome, new Set(["reviewRevisionId", "reviewRevisionNumber"])) ||
      outcome.reviewRevisionId !== effectId ||
      storedInteger(outcome.reviewRevisionNumber, 1) === null
    ) {
      return fail("STORED_REVIEW_INVALID");
    }
  } else if (
    !hasExactKeys(outcome, new Set(["effectId"])) ||
    outcome.effectId !== effectId
  ) {
    return fail("STORED_REVIEW_INVALID");
  }
  assertReceiptAssignmentBinding(db, row);
  assertReceiptEffectBinding(db, row, outcome);
  if (commandKind === "SAVE_REVIEW") {
    return Object.freeze({
      schema: CFP_REVIEW_COMMAND_RECEIPT_SCHEMA,
      commandKind,
      effectId,
      createdAt,
      outcome: Object.freeze({
        reviewRevisionId: effectId,
        reviewRevisionNumber: outcome.reviewRevisionNumber as number,
      }),
    });
  }
  return Object.freeze({
    schema: CFP_REVIEW_COMMAND_RECEIPT_SCHEMA,
    commandKind,
    effectId,
    createdAt,
    outcome: Object.freeze({ effectId }),
  }) as ReviewCommandReceipt;
}

function lookupReplay(
  db: Db,
  reviewer: AuthenticatedReviewer,
  commandKind: ReviewerCommandKind,
  idempotencyKey: string,
  requestFingerprint: string,
): ReviewCommandReceipt | null {
  const rows = db
    .prepare(
      `SELECT * FROM review_command_receipts
       WHERE workspace_id = ? AND actor_account_id = ?
         AND command_kind = ? AND idempotency_key = ?`,
    )
    .all(
      reviewer.workspaceId,
      reviewer.accountId,
      commandKind,
      idempotencyKey,
    ) as ReceiptRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1) return fail("STORED_REVIEW_INVALID");
  const row = rows[0]!;
  const receipt = validateStoredReceipt(db, row);
  if (
    row.workspace_id !== reviewer.workspaceId ||
    row.actor_account_id !== reviewer.accountId ||
    row.command_kind !== commandKind ||
    row.idempotency_key !== idempotencyKey
  ) {
    return fail("STORED_REVIEW_INVALID");
  }
  if (row.request_fingerprint !== requestFingerprint) {
    return fail("IDEMPOTENCY_CONFLICT");
  }
  return receipt;
}

type InternalReceiptDocument = Readonly<{
  schema: typeof CFP_REVIEW_COMMAND_RECEIPT_SCHEMA;
  workspaceId: string;
  assignmentId: string;
  roundId: string;
  rubricVersionId: string;
  submissionRevisionId: string;
  actorAccountId: string;
  commandKind: ReviewerCommandKind;
  effectId: string;
  createdAt: string;
  outcome: JsonSafeObject;
}>;

function insertReceipt(
  db: Db,
  base: AssignmentBase,
  commandKind: ReviewerCommandKind,
  idempotencyKey: string,
  requestFingerprint: string,
  effectId: string,
  createdAt: string,
  reviewRevisionNumber?: number,
): ReviewCommandReceipt {
  const outcome: JsonSafeObject = commandKind === "SAVE_REVIEW"
    ? Object.freeze({
        reviewRevisionId: effectId,
        reviewRevisionNumber: reviewRevisionNumber!,
      })
    : Object.freeze({ effectId });
  const document: InternalReceiptDocument = Object.freeze({
    schema: CFP_REVIEW_COMMAND_RECEIPT_SCHEMA,
    workspaceId: base.workspaceId,
    assignmentId: base.id,
    roundId: base.roundId,
    rubricVersionId: base.rubricVersionId,
    submissionRevisionId: base.submissionRevisionId,
    actorAccountId: base.reviewerAccountId,
    commandKind,
    effectId,
    createdAt,
    outcome,
  });
  const receiptJson = canonicalJson(document);
  db.prepare(
    `INSERT INTO review_command_receipts
       (id, workspace_id, assignment_id, round_id, rubric_version_id,
        submission_revision_id, actor_account_id, command_kind, idempotency_key,
        request_schema, request_fingerprint_algorithm, request_fingerprint,
        effect_id, receipt_schema, receipt_json, receipt_fingerprint_algorithm,
        receipt_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    base.workspaceId,
    base.id,
    base.roundId,
    base.rubricVersionId,
    base.submissionRevisionId,
    base.reviewerAccountId,
    commandKind,
    idempotencyKey,
    CFP_REVIEW_COMMAND_REQUEST_SCHEMA,
    CFP_REVIEW_FINGERPRINT_ALGORITHM,
    requestFingerprint,
    effectId,
    CFP_REVIEW_COMMAND_RECEIPT_SCHEMA,
    receiptJson,
    CFP_REVIEW_FINGERPRINT_ALGORITHM,
    fingerprintOf(document),
    createdAt,
  );
  if (commandKind === "SAVE_REVIEW") {
    return Object.freeze({
      schema: CFP_REVIEW_COMMAND_RECEIPT_SCHEMA,
      commandKind,
      effectId,
      createdAt,
      outcome: Object.freeze({
        reviewRevisionId: effectId,
        reviewRevisionNumber: reviewRevisionNumber!,
      }),
    });
  }
  return Object.freeze({
    schema: CFP_REVIEW_COMMAND_RECEIPT_SCHEMA,
    commandKind,
    effectId,
    createdAt,
    outcome: Object.freeze({ effectId }),
  }) as ReviewCommandReceipt;
}

function readBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (typeof error === "object" && error !== null && INTERNAL_FATAL_ERRORS.has(error)) {
      INTERNAL_FATAL_ERRORS.delete(error);
      throw Object.freeze(new ReviewerServiceFatalError());
    }
    if (error instanceof ReviewerServiceError) throw error;
    return fail("READ_FAILED");
  }
}

function writeBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (typeof error === "object" && error !== null && INTERNAL_FATAL_ERRORS.has(error)) {
      INTERNAL_FATAL_ERRORS.delete(error);
      throw Object.freeze(new ReviewerServiceFatalError());
    }
    if (error instanceof ReviewerServiceError) throw error;
    return fail("WRITE_FAILED");
  }
}

function activeAssignmentState(assignment: OperationalAssignment): void {
  if (
    assignment.assignmentState.state !== "ASSIGNED" &&
    assignment.assignmentState.state !== "IN_PROGRESS"
  ) {
    return fail("REVIEW_STATE_STALE");
  }
}

function assertExpectedAssignmentState(
  assignment: OperationalAssignment,
  expectedSequenceNumber: number,
): void {
  if (assignment.assignmentState.sequenceNumber !== expectedSequenceNumber) {
    return fail("REVIEW_STATE_STALE");
  }
}

function safeCommandTimestamp(...notBefore: readonly string[]): string {
  const createdAt = nowIso();
  if (notBefore.some((value) => Date.parse(createdAt) < Date.parse(value))) {
    return fail("REVIEW_STATE_STALE");
  }
  return createdAt;
}

export function listOwnReviewAssignments(
  db: Db,
  session: SessionInfo,
  input: ListOwnReviewAssignmentsInput,
): readonly OwnReviewAssignmentSummary[] {
  const capturedSession = captureSession(session);
  const capturedInput = captureListInput(input);
  return readBoundary(() => {
    requireOwnedBoundary(db);
    return withReadTransaction(db, () => {
      const reviewer = authenticateReviewer(
        db,
        capturedSession,
        capturedInput.workspaceSlug,
      );
      const rows = reviewer.pinnedAssignmentId === null
        ? db
          .prepare(
            `SELECT id FROM review_assignments
             WHERE workspace_id = ? AND reviewer_account_id = ?
             ORDER BY created_at ASC, id ASC
             LIMIT ${MAX_QUEUE_ASSIGNMENTS + 1}`,
          )
          .all(reviewer.workspaceId, reviewer.accountId) as Array<{ id: unknown }>
        : db
          .prepare(
            `SELECT id FROM review_assignments
             WHERE workspace_id = ? AND reviewer_account_id = ? AND id = ?
             LIMIT 1`,
          )
          .all(reviewer.workspaceId, reviewer.accountId, reviewer.pinnedAssignmentId) as Array<{ id: unknown }>;
      if (rows.length > MAX_QUEUE_ASSIGNMENTS) return fail("READ_FAILED");
      const summaries: OwnReviewAssignmentSummary[] = [];
      for (const row of rows) {
        const assignmentId = storedIdentifier(row.id);
        if (assignmentId === null) continue;
        try {
          const assignment = loadOperationalAssignment(db, reviewer, assignmentId);
          if (
            assignment.assignmentState.state === "RECUSED" ||
            assignment.assignmentState.state === "REVOKED"
          ) {
            continue;
          }
          summaries.push(
            projectSummary(
              assignment,
              latestReviewRevisionNumberMetadata(db, assignment.base),
            ),
          );
        } catch (error) {
          if (
            error instanceof ReviewerServiceError &&
            (error.code === "ASSIGNMENT_NOT_AVAILABLE" ||
              error.code === "STORED_REVIEW_INVALID")
          ) {
            continue;
          }
          throw error;
        }
      }
      return Object.freeze(summaries);
    });
  });
}

export function readOwnReviewAssignment(
  db: Db,
  session: SessionInfo,
  input: ReadOwnReviewAssignmentInput,
): OwnReviewAssignmentDetail {
  const capturedSession = captureSession(session);
  const capturedInput = captureReadInput(input);
  return readBoundary(() => {
    requireOwnedBoundary(db);
    return withReadTransaction(db, () => {
      const reviewer = authenticateReviewer(
        db,
        capturedSession,
        capturedInput.workspaceSlug,
      );
      const assignment = loadOperationalAssignment(
        db,
        reviewer,
        capturedInput.assignmentId,
      );
      requireReadableAssignment(assignment);
      const packet = loadTrustedReviewPacket(db, assignment);
      const reviews = loadReviewRevisionHistory(
        db,
        assignment,
        packet.semantics.document,
      );
      const summary = projectSummary(assignment, reviews.latestNumber);
      return Object.freeze({
        assignmentId: summary.assignmentId,
        roundName: summary.roundName,
        assignedAt: summary.assignedAt,
        assignmentState: summary.assignmentState,
        assignmentStateSequenceNumber: summary.assignmentStateSequenceNumber,
        conflictStatus: summary.conflictStatus,
        conflictSequenceNumber: summary.conflictSequenceNumber,
        latestReviewRevisionNumber: summary.latestReviewRevisionNumber,
        actionBlocked: summary.actionBlocked,
        proposal: packet.proposal,
        rubric: packet.semantics.projection,
        latestReview: reviews.latest,
      });
    });
  });
}

function conflictCommand(
  db: Db,
  session: SessionInfo,
  input: DeclareOwnReviewConflictInput | ClearOwnReviewConflictInput,
  commandKind: "CONFLICT_DECLARE" | "CONFLICT_CLEAR",
): ReviewConflictDeclareReceipt | ReviewConflictClearReceipt {
  const capturedSession = captureSession(session);
  const capturedInput = captureConflictInput(input);
  return writeBoundary(() => {
    requireOwnedBoundary(db);
    return withImmediateTransaction(db, () => {
      const reviewer = authenticateReviewer(
        db,
        capturedSession,
        capturedInput.workspaceSlug,
      );
      const request = buildRequest(
        reviewer,
        capturedInput.assignmentId,
        commandKind,
        conflictRequestPayload(capturedInput),
      );
      const requestFingerprint = fingerprintOf(request);
      const replay = lookupReplay(
        db,
        reviewer,
        commandKind,
        capturedInput.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== null) {
        if (replay.commandKind !== commandKind) return fail("STORED_REVIEW_INVALID");
        return replay;
      }

      const assignment = loadOperationalAssignment(
        db,
        reviewer,
        capturedInput.assignmentId,
      );
      activeAssignmentState(assignment);
      assertExpectedAssignmentState(
        assignment,
        capturedInput.expectedAssignmentStateSequenceNumber,
      );
      if (
        assignment.conflict.sequenceNumber !==
        capturedInput.expectedConflictSequenceNumber
      ) {
        return fail("REVIEW_STATE_STALE");
      }
      if (
        commandKind === "CONFLICT_DECLARE"
          ? assignment.conflict.status !== "NONE" &&
            assignment.conflict.status !== "CLEARED"
          : assignment.conflict.status !== "DECLARED"
      ) {
        return fail("REVIEW_STATE_STALE");
      }
      const latestConflictAt = assignment.conflict.rows.length === 0
        ? assignment.base.createdAt
        : assignment.conflict.rows[assignment.conflict.rows.length - 1]!.createdAt;
      const createdAt = safeCommandTimestamp(
        assignment.base.createdAt,
        assignment.assignmentState.createdAt,
        latestConflictAt,
      );
      const effectId = uuid();
      db.prepare(
        `INSERT INTO review_conflict_dispositions
           (id, workspace_id, assignment_id, action, sequence_number,
            actor_account_id, actor_role_basis, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        effectId,
        assignment.base.workspaceId,
        assignment.base.id,
        commandKind === "CONFLICT_DECLARE" ? "DECLARE" : "CLEAR",
        assignment.conflict.sequenceNumber + 1,
        reviewer.accountId,
        reviewer.role,
        capturedInput.reason,
        createdAt,
      );
      return insertReceipt(
        db,
        assignment.base,
        commandKind,
        capturedInput.idempotencyKey,
        requestFingerprint,
        effectId,
        createdAt,
      ) as ReviewConflictDeclareReceipt | ReviewConflictClearReceipt;
    });
  });
}

export function declareOwnReviewConflict(
  db: Db,
  session: SessionInfo,
  input: DeclareOwnReviewConflictInput,
): ReviewConflictDeclareReceipt {
  return conflictCommand(db, session, input, "CONFLICT_DECLARE") as ReviewConflictDeclareReceipt;
}

export function clearOwnReviewConflict(
  db: Db,
  session: SessionInfo,
  input: ClearOwnReviewConflictInput,
): ReviewConflictClearReceipt {
  return conflictCommand(db, session, input, "CONFLICT_CLEAR") as ReviewConflictClearReceipt;
}

function appendInProgressStateIfNeeded(
  db: Db,
  assignment: OperationalAssignment,
  createdAt: string,
): void {
  if (assignment.assignmentState.state !== "ASSIGNED") return;
  db.prepare(
    `INSERT INTO review_assignment_states
       (id, workspace_id, assignment_id, state, sequence_number,
        actor_account_id, reason, created_at)
     VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?, NULL, ?)`,
  ).run(
    uuid(),
    assignment.base.workspaceId,
    assignment.base.id,
    assignment.assignmentState.sequenceNumber + 1,
    assignment.base.reviewerAccountId,
    createdAt,
  );
}

export function saveOwnReview(
  db: Db,
  session: SessionInfo,
  input: SaveOwnReviewInput,
): ReviewSaveReceipt {
  const capturedSession = captureSession(session);
  const capturedInput = captureSaveInput(input);
  return writeBoundary(() => {
    requireOwnedBoundary(db);
    return withImmediateTransaction(db, () => {
      const reviewer = authenticateReviewer(
        db,
        capturedSession,
        capturedInput.workspaceSlug,
      );
      const request = buildRequest(
        reviewer,
        capturedInput.assignmentId,
        "SAVE_REVIEW",
        saveRequestPayload(capturedInput),
      );
      const requestFingerprint = fingerprintOf(request);
      const replay = lookupReplay(
        db,
        reviewer,
        "SAVE_REVIEW",
        capturedInput.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== null) {
        if (replay.commandKind !== "SAVE_REVIEW") return fail("STORED_REVIEW_INVALID");
        return replay;
      }

      const assignment = loadOperationalAssignment(
        db,
        reviewer,
        capturedInput.assignmentId,
      );
      requireMutableAssignment(assignment);
      assertExpectedAssignmentState(
        assignment,
        capturedInput.expectedAssignmentStateSequenceNumber,
      );
      const packet = loadTrustedReviewPacket(db, assignment);
      const history = loadReviewRevisionHistory(
        db,
        assignment,
        packet.semantics.document,
      );
      if (history.latestNumber !== capturedInput.expectedReviewRevisionNumber) {
        return fail("REVIEW_STATE_STALE");
      }
      const evaluation = validateEvaluation(
        capturedInput.evaluation,
        packet.semantics.document,
        false,
      );
      const nextRevisionNumber = history.latestNumber + 1;
      const notBefore = history.latest?.savedAt ?? assignment.base.createdAt;
      const createdAt = safeCommandTimestamp(
        assignment.base.createdAt,
        assignment.assignmentState.createdAt,
        notBefore,
      );
      appendInProgressStateIfNeeded(db, assignment, createdAt);
      const effectId = uuid();
      const document = buildStoredEvaluation(
        assignment.base,
        nextRevisionNumber,
        evaluation,
      );
      db.prepare(
        `INSERT INTO review_revisions
           (id, workspace_id, assignment_id, round_id, rubric_version_id,
            submission_id, submission_revision_id, revision_number,
            evaluation_schema, evaluation_json, fingerprint_algorithm,
            fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        effectId,
        assignment.base.workspaceId,
        assignment.base.id,
        assignment.base.roundId,
        assignment.base.rubricVersionId,
        assignment.base.submissionId,
        assignment.base.submissionRevisionId,
        nextRevisionNumber,
        CFP_REVIEW_EVALUATION_SCHEMA,
        canonicalJson(document),
        CFP_REVIEW_FINGERPRINT_ALGORITHM,
        fingerprintOf(document),
        createdAt,
      );
      return insertReceipt(
        db,
        assignment.base,
        "SAVE_REVIEW",
        capturedInput.idempotencyKey,
        requestFingerprint,
        effectId,
        createdAt,
        nextRevisionNumber,
      ) as ReviewSaveReceipt;
    });
  });
}

export function submitOwnReview(
  db: Db,
  session: SessionInfo,
  input: SubmitOwnReviewInput,
): ReviewSubmitReceipt {
  const capturedSession = captureSession(session);
  const capturedInput = captureSubmitInput(input);
  return writeBoundary(() => {
    requireOwnedBoundary(db);
    return withImmediateTransaction(db, () => {
      const reviewer = authenticateReviewer(
        db,
        capturedSession,
        capturedInput.workspaceSlug,
      );
      const request = buildRequest(
        reviewer,
        capturedInput.assignmentId,
        "SUBMIT_REVIEW",
        submitRequestPayload(capturedInput),
      );
      const requestFingerprint = fingerprintOf(request);
      const replay = lookupReplay(
        db,
        reviewer,
        "SUBMIT_REVIEW",
        capturedInput.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== null) {
        if (replay.commandKind !== "SUBMIT_REVIEW") return fail("STORED_REVIEW_INVALID");
        return replay;
      }

      const assignment = loadOperationalAssignment(
        db,
        reviewer,
        capturedInput.assignmentId,
      );
      requireMutableAssignment(assignment);
      assertExpectedAssignmentState(
        assignment,
        capturedInput.expectedAssignmentStateSequenceNumber,
      );
      const packet = loadTrustedReviewPacket(db, assignment);
      const history = loadReviewRevisionHistory(
        db,
        assignment,
        packet.semantics.document,
      );
      if (history.latestNumber !== capturedInput.expectedReviewRevisionNumber) {
        return fail("REVIEW_STATE_STALE");
      }
      if (history.latestNumber === 0 || history.latestEvaluation === null) {
        return fail("EVALUATION_INCOMPLETE");
      }
      validateEvaluation(
        history.latestEvaluation,
        packet.semantics.document,
        true,
      );
      const createdAt = safeCommandTimestamp(
        assignment.base.createdAt,
        assignment.assignmentState.createdAt,
        history.latest!.savedAt,
      );
      const effectId = uuid();
      db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number,
            actor_account_id, reason, created_at)
         VALUES (?, ?, ?, 'SUBMITTED', ?, ?, NULL, ?)`,
      ).run(
        effectId,
        assignment.base.workspaceId,
        assignment.base.id,
        assignment.assignmentState.sequenceNumber + 1,
        reviewer.accountId,
        createdAt,
      );
      return insertReceipt(
        db,
        assignment.base,
        "SUBMIT_REVIEW",
        capturedInput.idempotencyKey,
        requestFingerprint,
        effectId,
        createdAt,
      ) as ReviewSubmitReceipt;
    });
  });
}
