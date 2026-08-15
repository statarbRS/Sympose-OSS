import { Buffer } from "node:buffer";

import { canonicalJson, fingerprintOf, nowIso, uuid } from "../../canonical";
import { withSavepoint, withTransactionOrSavepoint, type Db } from "../../db";
import {
  evaluateConditionalForm,
  FORM_RULES_SCHEMA,
  FormEvaluationError,
  normalizeFormRuleSet,
  type FormRuleSet,
} from "./form-evaluator";
import {
  FORM_DOCUMENT_SCHEMA,
  FormDocumentError,
  normalizeFormDocument,
  type FormAnswer,
  type FormFieldDefinition,
  type NormalizedFormDocument,
} from "./form-types";
import {
  FormSafetyError,
  sanitizeFormData,
  type JsonSafeObject,
  type JsonSafeValue,
} from "./form-safety";

export const CFP_FINGERPRINT_ALGORITHM = "sha256-canonical-json-v1" as const;
export const FORM_DOCUMENT_FINGERPRINT_ALGORITHM = CFP_FINGERPRINT_ALGORITHM;
export const CFP_CALL_POLICY_SCHEMA = "cfp-call-policy/v1" as const;
export const CFP_CONSENT_RECEIPT_SCHEMA = "cfp-consent-receipt/v1" as const;
export const CFP_SUBMISSION_REVISION_SCHEMA = "cfp-submission-revision/v1" as const;
export const CFP_SUBMISSION_AMENDMENT_MARKER_SCHEMA = "cfp-submission-amendment/v1" as const;

export const CFP_PERSISTED_JSON_LIMITS = Object.freeze({
  maxSerializedBytes: 4 * 1024 * 1024,
  maxPolicyBytes: 512 * 1024,
  maxReceiptBytes: 64 * 1024,
});

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CONSENT_FIELD_TYPES = new Set(["consent", "acknowledgement", "policyAcceptance"]);
const DISCLOSURE_KEYS = [
  "privacy",
  "retention",
  "aiProcessing",
  "communication",
  "consent",
  "publication",
] as const;
const HAS_OWN = Object.prototype.hasOwnProperty;

const PERSISTENCE_ERROR_MESSAGES = {
  PERSISTENCE_INPUT_INVALID: "The CFP persistence input is invalid.",
  WORKSPACE_NOT_FOUND: "The CFP workspace was not found.",
  CONTEXT_INVALID: "The CFP trusted context is invalid.",
  FORM_DEFINITION_NOT_FOUND: "The CFP form definition was not found.",
  FORM_DEFINITION_NAME_INVALID: "The CFP form definition name is invalid.",
  RULE_VERSION_NOT_FOUND: "The CFP rule version was not found.",
  RULE_VERSION_NOT_SEALED: "The CFP rule version is not sealed.",
  FORM_VERSION_NOT_FOUND: "The CFP form version was not found.",
  FORM_VERSION_NOT_SEALED: "The CFP form version is not sealed.",
  FORM_ARTIFACT_INVALID: "The stored CFP form artifact is invalid.",
  RULE_ARTIFACT_INVALID: "The stored CFP rule artifact is invalid.",
  FORM_ARTIFACT_NOT_CANONICAL: "The stored CFP form artifact is not canonical.",
  RULE_ARTIFACT_NOT_CANONICAL: "The stored CFP rule artifact is not canonical.",
  FORM_ARTIFACT_MIRROR_MISMATCH: "The stored CFP form artifact mirror is invalid.",
  RULE_ARTIFACT_MIRROR_MISMATCH: "The stored CFP rule artifact mirror is invalid.",
  ARTIFACT_ALGORITHM_UNSUPPORTED: "The stored CFP artifact algorithm is not supported.",
  CALL_NOT_FOUND: "The CFP call was not found.",
  CALL_POLICY_INVALID: "The CFP call policy is invalid.",
  CALL_POLICY_NOT_CANONICAL: "The stored CFP call policy is not canonical.",
  CALL_POLICY_MIRROR_MISMATCH: "The stored CFP call policy mirror is invalid.",
  CALL_POLICY_STALE: "The CFP call policy has changed.",
  CALL_FORM_ADVANCE_INVALID: "The CFP call form advance is invalid.",
  CALL_FORM_ADVANCE_STALE: "The CFP call form advance is stale.",
  SESSION_INVALID: "The CFP applicant session is invalid.",
  SESSION_REVOKED: "The CFP applicant session is revoked.",
  SESSION_EXPIRED: "The CFP applicant session is expired.",
  SUBMISSION_NOT_FOUND: "The CFP submission was not found.",
  SUBMISSION_NOT_DRAFT: "The CFP submission is not a draft.",
  SUBMISSION_AMENDMENT_NOT_ALLOWED: "The submitted CFP proposal cannot be amended in its current state.",
  SUBMISSION_PIN_MISMATCH: "The CFP submission pins are invalid.",
  SUBMISSION_REVISION_NOT_FOUND: "The CFP submission revision was not found.",
  SUBMISSION_REVISION_INVALID: "The stored CFP submission revision is invalid.",
  SUBMISSION_REVISION_NOT_CANONICAL: "The stored CFP submission revision is not canonical.",
  SUBMISSION_REVISION_MIRROR_MISMATCH: "The stored CFP submission revision mirror is invalid.",
  SUBMISSION_REVISION_JSON_INVALID: "The stored CFP submission revision JSON is invalid.",
  SUBMISSION_REVISION_OVERSIZED: "The stored CFP submission revision is oversized.",
  STALE_REVISION: "The CFP submission revision is stale.",
  REVISION_POINTER_INVALID: "The CFP submission revision pointer is invalid.",
  PERSISTENCE_READ_FAILED: "The CFP persistence read failed.",
  PERSISTENCE_WRITE_FAILED: "The CFP persistence write failed.",
} as const;

export type FormDocumentPersistenceErrorCode = keyof typeof PERSISTENCE_ERROR_MESSAGES;

export class FormDocumentPersistenceError extends Error {
  readonly code: FormDocumentPersistenceErrorCode;

  constructor(code: FormDocumentPersistenceErrorCode) {
    super(PERSISTENCE_ERROR_MESSAGES[code]);
    this.name = "FormDocumentPersistenceError";
    this.code = code;
  }
}

export interface OrganizerContext {
  readonly workspaceId: string;
  readonly accountId: string;
}

export interface ApplicantSessionContext {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface CreateFormDefinitionInput {
  readonly name: string;
}

export interface SealFormVersionInput {
  readonly formDefinitionId: string;
  readonly fields: unknown;
  readonly rules: unknown;
}

export interface CreateCallInput {
  readonly eventId: string;
  readonly name: string;
  readonly slug: string;
  readonly formVersionId: string;
  readonly policy: unknown;
  readonly accessMode?: "PUBLIC" | "INVITED" | "PUBLIC_AND_INVITED";
  readonly state?: "DRAFT" | "SCHEDULED" | "OPEN" | "PAUSED" | "CLOSED" | "ARCHIVED" | "CANCELLED";
  readonly timezone?: string;
  readonly opensAt?: string | null;
  readonly closesAt?: string | null;
}

export interface CreateDraftSubmissionInput {
  readonly callId: string;
}

export interface SaveDraftRevisionInput {
  readonly submissionId: string;
  readonly historicalAnswers: unknown;
  readonly expectedCurrentRevisionId: string | null;
}

export interface SaveSubmittedAmendmentInput {
  readonly submissionId: string;
  readonly historicalAnswers: unknown;
  readonly expectedCurrentRevisionId: string;
}

export interface UpdateCallPolicyInput {
  readonly callId: string;
  readonly expectedPolicyFingerprint: string;
  readonly policy: unknown;
}

export interface AdvanceCallFormVersionInput {
  readonly callId: string;
  readonly expectedFormVersionId: string;
  readonly nextFormVersionId: string;
}

export interface CfpPersistenceDependencyOptions {
  readonly clock?: () => string;
  readonly idGenerator?: () => string;
}

export interface NormalizedRuleVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly formDefinitionId: string;
  readonly versionNumber: number;
  readonly schema: typeof FORM_RULES_SCHEMA;
  readonly rules: FormRuleSet;
  readonly fingerprintAlgorithm: typeof CFP_FINGERPRINT_ALGORITHM;
  readonly fingerprint: string;
  readonly sealedBy: string;
  readonly sealedAt: string;
}

export interface SealedFormVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly formDefinitionId: string;
  readonly ruleVersionId: string;
  readonly versionNumber: number;
  readonly document: NormalizedFormDocument;
  readonly fingerprintAlgorithm: typeof CFP_FINGERPRINT_ALGORITHM;
  readonly fingerprint: string;
  readonly sealedBy: string;
  readonly sealedAt: string;
  readonly ruleVersion: NormalizedRuleVersion;
}

export interface CallPolicyChoice {
  readonly fieldId: string;
  readonly statement: string;
  readonly required: boolean;
}

export interface NormalizedCallPolicy {
  readonly schema: typeof CFP_CALL_POLICY_SCHEMA;
  readonly policyVersionId: string;
  readonly disclosure: JsonSafeObject;
  readonly choices: readonly CallPolicyChoice[];
}

export interface CallPolicySnapshot extends NormalizedCallPolicy {
  readonly fingerprintAlgorithm: typeof CFP_FINGERPRINT_ALGORITHM;
  readonly fingerprint: string;
}

export interface CallReadModel extends CallPolicySnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly formVersionId: string;
  readonly accessMode: "PUBLIC" | "INVITED" | "PUBLIC_AND_INVITED";
  readonly state: "DRAFT" | "SCHEDULED" | "OPEN" | "PAUSED" | "CLOSED" | "ARCHIVED" | "CANCELLED";
  readonly timezone: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly policy: CallPolicySnapshot;
}

export interface ConsentReceipt {
  readonly schema: typeof CFP_CONSENT_RECEIPT_SCHEMA;
  readonly submissionId: string;
  readonly personId: string;
  readonly applicantSessionId: string;
  readonly receivedAt: string;
  readonly policyFingerprint: string;
  readonly choices: readonly { readonly fieldId: string; readonly value: boolean }[];
}

export interface SubmissionRevision {
  readonly schema: typeof CFP_SUBMISSION_REVISION_SCHEMA;
  readonly submissionId: string;
  readonly revisionNumber: number;
  readonly formDocument: NormalizedFormDocument;
  readonly callPolicy: CallPolicySnapshot;
  readonly consentReceipt: ConsentReceipt | null;
  readonly fingerprintAlgorithm: typeof CFP_FINGERPRINT_ALGORITHM;
  readonly fingerprint: string;
}

export interface CreatedFormDefinition {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
}

export interface CreatedSubmission {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly ownerPersonId: string;
  readonly pinnedFormVersionId: string;
  readonly pinnedRuleVersionId: string;
}

export interface SavedSubmissionRevision {
  readonly revisionId: string;
  readonly revision: SubmissionRevision;
}

export interface CfpPersistence {
  createFormDefinition(db: Db, context: OrganizerContext, input: CreateFormDefinitionInput): CreatedFormDefinition;
  sealFormVersion(db: Db, context: OrganizerContext, input: SealFormVersionInput): SealedFormVersion;
  createCall(db: Db, context: OrganizerContext, input: CreateCallInput): { readonly id: string };
  readCall(db: Db, workspaceId: string, callId: string): CallReadModel;
  updateCallPolicy(db: Db, context: OrganizerContext, input: UpdateCallPolicyInput): CallPolicySnapshot;
  advanceCallFormVersion(db: Db, context: OrganizerContext, input: AdvanceCallFormVersionInput): { readonly id: string };
  createDraftSubmission(db: Db, context: ApplicantSessionContext, input: CreateDraftSubmissionInput): CreatedSubmission;
  saveDraftRevision(db: Db, context: ApplicantSessionContext, input: SaveDraftRevisionInput): SavedSubmissionRevision;
  saveSubmittedAmendment(
    db: Db,
    context: ApplicantSessionContext,
    input: SaveSubmittedAmendmentInput,
  ): SavedSubmissionRevision;
  readFormVersionDocument(db: Db, workspaceId: string, formVersionId: string): NormalizedFormDocument;
  readRuleVersion(db: Db, workspaceId: string, ruleVersionId: string): NormalizedRuleVersion;
  readSubmissionRevision(db: Db, workspaceId: string, revisionId: string): SubmissionRevision;
  readCurrentSubmissionRevision(db: Db, workspaceId: string, submissionId: string): SubmissionRevision;
}

type Dependencies = {
  readonly now: () => string;
  readonly id: () => string;
};

type FormVersionRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly form_definition_id: unknown;
  readonly rule_version_id: unknown;
  readonly version_number: unknown;
  readonly document_schema: unknown;
  readonly document_json: unknown;
  readonly fingerprint_algorithm: unknown;
  readonly fingerprint: unknown;
  readonly sealed_by: unknown;
  readonly sealed_at: unknown;
  readonly definition_workspace_id: unknown;
  readonly rule_workspace_id: unknown;
  readonly rule_form_definition_id: unknown;
  readonly rule_version_number: unknown;
  readonly rules_schema: unknown;
  readonly rules_json: unknown;
  readonly rule_fingerprint_algorithm: unknown;
  readonly rule_fingerprint: unknown;
  readonly rule_sealed_by: unknown;
  readonly rule_sealed_at: unknown;
  readonly form_sealer_workspace_id: unknown;
  readonly rule_sealer_workspace_id: unknown;
};

type SubmissionRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly call_id: unknown;
  readonly owner_person_id: unknown;
  readonly state: unknown;
  readonly pinned_form_version_id: unknown;
  readonly pinned_rule_version_id: unknown;
  readonly current_revision_id: unknown;
  readonly call_form_version_id: unknown;
  readonly call_event_id: unknown;
  readonly call_state: unknown;
  readonly call_opens_at: unknown;
  readonly call_closes_at: unknown;
  readonly call_policy_version_id: unknown;
  readonly call_policy_schema: unknown;
  readonly call_policy_json: unknown;
  readonly call_policy_fingerprint_algorithm: unknown;
  readonly call_policy_fingerprint: unknown;
};

type SessionRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly call_id: unknown;
  readonly person_id: unknown;
  readonly verification_id: unknown;
  readonly token_hash: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly revoked_at: unknown;
  readonly revoked_by: unknown;
  readonly revoked_reason: unknown;
  readonly revoked_by_workspace_id: unknown;
  readonly verification_call_id: unknown;
  readonly verification_workspace_id: unknown;
  readonly verification_email: unknown;
  readonly person_workspace_id: unknown;
  readonly person_email: unknown;
  readonly consumed_person_id: unknown;
};

type RevisionRow = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly submission_id: unknown;
  readonly revision_number: unknown;
  readonly revision_schema: unknown;
  readonly revision_json: unknown;
  readonly form_version_id: unknown;
  readonly rule_version_id: unknown;
  readonly form_document_schema: unknown;
  readonly form_document_fingerprint: unknown;
  readonly policy_schema: unknown;
  readonly policy_version_id: unknown;
  readonly policy_fingerprint_algorithm: unknown;
  readonly policy_fingerprint: unknown;
  readonly consent_receipt_schema: unknown;
  readonly consent_receipt_policy_fingerprint: unknown;
  readonly session_id: unknown;
  readonly person_id: unknown;
  readonly fingerprint_algorithm: unknown;
  readonly fingerprint: unknown;
  readonly created_at: unknown;
  readonly submission_workspace_id: unknown;
  readonly submission_owner_person_id: unknown;
  readonly submission_pinned_form_version_id: unknown;
  readonly submission_pinned_rule_version_id: unknown;
  readonly submission_current_revision_id: unknown;
  readonly submission_state: unknown;
  readonly call_id: unknown;
  readonly call_policy_version_id: unknown;
  readonly call_policy_schema: unknown;
  readonly call_policy_json: unknown;
  readonly call_policy_fingerprint_algorithm: unknown;
  readonly call_policy_fingerprint: unknown;
  readonly person_workspace_id: unknown;
  readonly session_workspace_id: unknown;
  readonly session_call_id: unknown;
  readonly session_person_id: unknown;
  readonly session_verification_id: unknown;
  readonly session_revoked_at: unknown;
  readonly session_revoked_by: unknown;
  readonly session_revoked_reason: unknown;
  readonly session_revoked_by_workspace_id: unknown;
  readonly session_created_at: unknown;
  readonly session_expires_at: unknown;
  readonly consumed_id: unknown;
};

function persistenceError(code: FormDocumentPersistenceErrorCode): FormDocumentPersistenceError {
  return new FormDocumentPersistenceError(code);
}

function hasOwn(value: JsonSafeObject, key: string): boolean {
  return HAS_OWN.call(value, key);
}

function isObject(value: JsonSafeValue): value is JsonSafeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonSafeObject, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !IDENTIFIER_PATTERN.test(value)) {
    throw persistenceError("PERSISTENCE_INPUT_INVALID");
  }
  return value;
}

function requireStoredIdentifier(value: unknown, code: FormDocumentPersistenceErrorCode): string {
  if (typeof value !== "string" || value.length > 128 || !IDENTIFIER_PATTERN.test(value)) {
    throw persistenceError(code);
  }
  return value;
}

function requireOptionalStoredIdentifier(
  value: unknown,
  code: FormDocumentPersistenceErrorCode,
): string | null {
  if (value === null) {
    return null;
  }
  return requireStoredIdentifier(value, code);
}

function requireText(value: unknown, code: FormDocumentPersistenceErrorCode = "PERSISTENCE_INPUT_INVALID"): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw persistenceError(code);
  }
  return value;
}

function requireStoredPolicyJson(value: unknown, code: FormDocumentPersistenceErrorCode): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes
  ) {
    throw persistenceError(code);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, code: FormDocumentPersistenceErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128) {
    throw persistenceError(code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw persistenceError(code);
  }
  return value;
}

function requireRevocationTuple(
  revokedAt: unknown,
  revokedBy: unknown,
  revokedReason: unknown,
  code: FormDocumentPersistenceErrorCode,
): void {
  const allNull = revokedAt === null && revokedBy === null && revokedReason === null;
  const allValid =
    typeof revokedAt === "string" &&
    typeof revokedBy === "string" &&
    typeof revokedReason === "string" &&
    revokedReason.length > 0 &&
    Buffer.byteLength(revokedReason, "utf8") <= 64 * 1024;
  if (!allNull && !allValid) {
    throw persistenceError(code);
  }
  if (allValid) {
    requireIsoTimestamp(revokedAt, code);
    requireStoredIdentifier(revokedBy, code);
  }
}

function requireTimestampNotBefore(
  value: string,
  lowerBound: string,
  code: FormDocumentPersistenceErrorCode,
): void {
  if (Date.parse(value) < Date.parse(lowerBound)) {
    throw persistenceError(code);
  }
}

function requireRevisionWithinSession(
  revisionCreatedAt: unknown,
  sessionCreatedAt: unknown,
  sessionExpiresAt: unknown,
  code: FormDocumentPersistenceErrorCode,
): void {
  const revisionAt = requireIsoTimestamp(revisionCreatedAt, code);
  const sessionStartedAt = requireIsoTimestamp(sessionCreatedAt, code);
  const sessionEndsAt = requireIsoTimestamp(sessionExpiresAt, code);
  if (
    Date.parse(sessionEndsAt) <= Date.parse(sessionStartedAt) ||
    Date.parse(revisionAt) < Date.parse(sessionStartedAt) ||
    Date.parse(revisionAt) >= Date.parse(sessionEndsAt)
  ) {
    throw persistenceError(code);
  }
}

function requireTimezone(value: unknown, code: FormDocumentPersistenceErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128) {
    throw persistenceError(code);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw persistenceError(code);
  }
  return value;
}

function requirePositiveInteger(value: unknown, code: FormDocumentPersistenceErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw persistenceError(code);
  }
  return value;
}

function sanitizeObject(input: unknown): JsonSafeObject {
  const safe = sanitizeFormData(input);
  if (!isObject(safe)) {
    throw persistenceError("PERSISTENCE_INPUT_INVALID");
  }
  return safe;
}

function requireContextWorkspace(db: Db, workspaceId: string, accountId?: string): void {
  requireIdentifier(workspaceId);
  const workspace = db.prepare("SELECT 1 AS present FROM workspaces WHERE id = ? LIMIT 1").get(workspaceId);
  if (!workspace) {
    throw persistenceError("WORKSPACE_NOT_FOUND");
  }
  if (accountId !== undefined) {
    requireIdentifier(accountId);
    const account = db
      .prepare("SELECT 1 AS present FROM accounts WHERE id = ? AND workspace_id = ? LIMIT 1")
      .get(accountId, workspaceId);
    if (!account) {
      throw persistenceError("CONTEXT_INVALID");
    }
  }
}

function safeDependencyId(deps: Dependencies): string {
  return requireIdentifier(deps.id());
}

function safeDependencyNow(deps: Dependencies): string {
  return requireIsoTimestamp(deps.now(), "PERSISTENCE_WRITE_FAILED");
}

function isCallerContractError(error: unknown): boolean {
  return error instanceof FormDocumentPersistenceError ||
    error instanceof FormDocumentError ||
    error instanceof FormEvaluationError ||
    error instanceof FormSafetyError;
}

function writeBoundary<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (isCallerContractError(error)) {
      throw error;
    }
    throw persistenceError("PERSISTENCE_WRITE_FAILED");
  }
}

function readBoundary<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof FormDocumentPersistenceError) {
      throw error;
    }
    throw persistenceError("PERSISTENCE_READ_FAILED");
  }
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      freeze(item);
    }
  } else {
    for (const key of Object.keys(value as object)) {
      freeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function boundedJsonParse(
  value: unknown,
  code: FormDocumentPersistenceErrorCode,
  maxBytes = CFP_PERSISTED_JSON_LIMITS.maxSerializedBytes,
  oversizedCode: FormDocumentPersistenceErrorCode = "SUBMISSION_REVISION_OVERSIZED",
): unknown {
  if (typeof value !== "string") {
    throw persistenceError(code);
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > maxBytes) {
    throw persistenceError(oversizedCode);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw persistenceError(code);
  }
}

function normalizeStoredRule(
  row: FormVersionRow,
  fields: readonly FormFieldDefinition[],
): NormalizedRuleVersion {
  const id = requireStoredIdentifier(row.rule_version_id, "RULE_ARTIFACT_MIRROR_MISMATCH");
  const workspaceId = requireStoredIdentifier(row.rule_workspace_id, "RULE_ARTIFACT_MIRROR_MISMATCH");
  const formDefinitionId = requireStoredIdentifier(row.rule_form_definition_id, "RULE_ARTIFACT_MIRROR_MISMATCH");
  const versionNumber = requirePositiveInteger(row.version_number, "RULE_ARTIFACT_MIRROR_MISMATCH");
  const ruleVersionNumber = requirePositiveInteger(row.rule_version_number, "RULE_ARTIFACT_MIRROR_MISMATCH");
  const rulesSchema = row.rules_schema;
  const algorithm = row.rule_fingerprint_algorithm;
  const fingerprint = row.rule_fingerprint;
  const sealedBy = requireStoredIdentifier(row.rule_sealed_by, "RULE_ARTIFACT_MIRROR_MISMATCH");
  const sealedAt = row.rule_sealed_at;
  if (
    rulesSchema !== FORM_RULES_SCHEMA ||
    algorithm !== CFP_FINGERPRINT_ALGORITHM ||
    typeof fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(fingerprint) ||
    typeof sealedAt !== "string" ||
    sealedAt.length === 0 ||
    row.rule_workspace_id !== row.workspace_id ||
    ruleVersionNumber !== versionNumber ||
    row.rule_sealer_workspace_id !== row.workspace_id
  ) {
    throw persistenceError("RULE_ARTIFACT_MIRROR_MISMATCH");
  }
  requireIsoTimestamp(sealedAt, "RULE_ARTIFACT_MIRROR_MISMATCH");

  const parsed = boundedJsonParse(row.rules_json, "RULE_ARTIFACT_INVALID", 256 * 1024, "RULE_ARTIFACT_INVALID");
  let normalized: FormRuleSet;
  try {
    normalized = normalizeFormRuleSet(parsed, fields);
  } catch {
    throw persistenceError("RULE_ARTIFACT_INVALID");
  }
  if (
    normalized.ruleVersionId !== id ||
    canonicalJson(normalized) !== row.rules_json ||
    fingerprintOf(normalized) !== fingerprint
  ) {
    throw persistenceError("RULE_ARTIFACT_NOT_CANONICAL");
  }
  return freeze({
    id,
    workspaceId,
    formDefinitionId,
    versionNumber,
    schema: FORM_RULES_SCHEMA,
    rules: normalized,
    fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
    fingerprint,
    sealedBy,
    sealedAt,
  });
}

function normalizeStoredTemplate(row: FormVersionRow): NormalizedFormDocument {
  const formId = requireStoredIdentifier(row.id, "FORM_ARTIFACT_MIRROR_MISMATCH");
  const ruleId = requireStoredIdentifier(row.rule_version_id, "FORM_ARTIFACT_MIRROR_MISMATCH");
  const schema = row.document_schema;
  const algorithm = row.fingerprint_algorithm;
  const fingerprint = row.fingerprint;
  const sealedAt = row.sealed_at;
  if (
    schema !== FORM_DOCUMENT_SCHEMA ||
    algorithm !== CFP_FINGERPRINT_ALGORITHM ||
    typeof fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(fingerprint) ||
    typeof sealedAt !== "string" ||
    sealedAt.length === 0 ||
    row.form_sealer_workspace_id !== row.workspace_id
  ) {
    throw persistenceError("FORM_ARTIFACT_MIRROR_MISMATCH");
  }
  requireIsoTimestamp(sealedAt, "FORM_ARTIFACT_MIRROR_MISMATCH");
  const parsed = boundedJsonParse(
    row.document_json,
    "FORM_ARTIFACT_INVALID",
    CFP_PERSISTED_JSON_LIMITS.maxSerializedBytes,
    "FORM_ARTIFACT_INVALID",
  );
  let normalized: NormalizedFormDocument;
  try {
    normalized = normalizeFormDocument(parsed);
  } catch {
    throw persistenceError("FORM_ARTIFACT_INVALID");
  }
  if (
    normalized.formVersionId !== formId ||
    normalized.ruleVersionId !== ruleId ||
    normalized.historicalAnswers.length !== 0 ||
    normalized.effectiveAnswers.length !== 0
  ) {
    throw persistenceError("FORM_ARTIFACT_MIRROR_MISMATCH");
  }
  if (canonicalJson(normalized) !== row.document_json) {
    throw persistenceError("FORM_ARTIFACT_NOT_CANONICAL");
  }
  if (normalized.fingerprint !== fingerprint) {
    throw persistenceError("FORM_ARTIFACT_MIRROR_MISMATCH");
  }
  return freeze(normalized);
}

function readFormVersionRow(db: Db, workspaceId: string, formVersionId: string): FormVersionRow {
  const row = db
    .prepare(
      `SELECT f.id, f.workspace_id, f.form_definition_id, f.rule_version_id, f.version_number,
              f.document_schema, f.document_json, f.fingerprint_algorithm, f.fingerprint,
              f.sealed_by, f.sealed_at,
              d.workspace_id AS definition_workspace_id,
              r.workspace_id AS rule_workspace_id,
              r.form_definition_id AS rule_form_definition_id,
              r.version_number AS rule_version_number,
              r.rules_schema, r.rules_json, r.fingerprint_algorithm AS rule_fingerprint_algorithm,
              r.fingerprint AS rule_fingerprint, r.sealed_by AS rule_sealed_by,
              r.sealed_at AS rule_sealed_at,
              form_sealer.workspace_id AS form_sealer_workspace_id,
              rule_sealer.workspace_id AS rule_sealer_workspace_id
       FROM form_versions f
       JOIN form_definitions d ON d.id = f.form_definition_id
       JOIN rule_versions r ON r.id = f.rule_version_id
       JOIN accounts form_sealer ON form_sealer.id = f.sealed_by
       JOIN accounts rule_sealer ON rule_sealer.id = r.sealed_by
       WHERE f.workspace_id = ? AND f.id = ?
       LIMIT 1`,
    )
    .get(workspaceId, formVersionId) as FormVersionRow | undefined;
  if (!row) {
    throw persistenceError("FORM_VERSION_NOT_FOUND");
  }
  if (
    row.workspace_id !== workspaceId ||
    row.definition_workspace_id !== workspaceId ||
    row.rule_workspace_id !== workspaceId ||
    row.form_definition_id !== row.rule_form_definition_id ||
    row.version_number !== row.rule_version_number
    || row.form_sealer_workspace_id !== workspaceId
    || row.rule_sealer_workspace_id !== workspaceId
  ) {
    throw persistenceError("SUBMISSION_PIN_MISMATCH");
  }
  return row;
}

function readVerifiedFormVersion(db: Db, workspaceId: string, formVersionId: string): SealedFormVersion {
  const row = readFormVersionRow(db, workspaceId, formVersionId);
  const document = normalizeStoredTemplate(row);
  const ruleVersion = normalizeStoredRule(row, document.fields);
  if (document.ruleVersionId !== ruleVersion.id) {
    throw persistenceError("SUBMISSION_PIN_MISMATCH");
  }
  const id = requireStoredIdentifier(row.id, "FORM_ARTIFACT_MIRROR_MISMATCH");
  const formDefinitionId = requireStoredIdentifier(row.form_definition_id, "FORM_ARTIFACT_MIRROR_MISMATCH");
  const sealedBy = requireStoredIdentifier(row.sealed_by, "FORM_ARTIFACT_MIRROR_MISMATCH");
  const sealedAt = requireIsoTimestamp(row.sealed_at, "FORM_VERSION_NOT_SEALED");
  const versionNumber = requirePositiveInteger(row.version_number, "FORM_ARTIFACT_MIRROR_MISMATCH");
  return freeze({
    id,
    workspaceId,
    formDefinitionId,
    ruleVersionId: ruleVersion.id,
    versionNumber,
    document,
    fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
    fingerprint: document.fingerprint,
    sealedBy,
    sealedAt,
    ruleVersion,
  });
}

function readVerifiedRuleVersion(db: Db, workspaceId: string, ruleVersionId: string): NormalizedRuleVersion {
  const row = db
    .prepare(
      `SELECT f.id
       FROM form_versions f
       WHERE f.workspace_id = ? AND f.rule_version_id = ?
       ORDER BY f.version_number
       LIMIT 1`,
    )
    .get(workspaceId, ruleVersionId) as { id: string } | undefined;
  if (!row) {
    throw persistenceError("RULE_VERSION_NOT_FOUND");
  }
  return readVerifiedFormVersion(
    db,
    workspaceId,
    requireStoredIdentifier(row.id, "RULE_ARTIFACT_MIRROR_MISMATCH"),
  ).ruleVersion;
}

function normalizeDisclosure(input: JsonSafeValue): JsonSafeObject {
  if (!isObject(input) || !hasOnlyKeys(input, new Set(DISCLOSURE_KEYS))) {
    throw persistenceError("CALL_POLICY_INVALID");
  }
  for (const key of DISCLOSURE_KEYS) {
    if (!hasOwn(input, key)) {
      throw persistenceError("CALL_POLICY_INVALID");
    }
  }
  return freeze({
    privacy: input.privacy,
    retention: input.retention,
    aiProcessing: input.aiProcessing,
    communication: input.communication,
    consent: input.consent,
    publication: input.publication,
  });
}

function normalizePolicyArtifact(
  input: unknown,
  fields: readonly FormFieldDefinition[],
): NormalizedCallPolicy {
  const safe = sanitizeObject(input);
  if (!hasOnlyKeys(safe, new Set(["schema", "policyVersionId", "disclosure", "choices"]))) {
    throw persistenceError("CALL_POLICY_INVALID");
  }
  if (safe.schema !== CFP_CALL_POLICY_SCHEMA) {
    throw persistenceError("CALL_POLICY_INVALID");
  }
  const policyVersionId = requireIdentifier(safe.policyVersionId);
  const disclosure = normalizeDisclosure(safe.disclosure);
  if (!Array.isArray(safe.choices) || safe.choices.length > fields.length || safe.choices.length > 256) {
    throw persistenceError("CALL_POLICY_INVALID");
  }
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const choices: CallPolicyChoice[] = [];
  for (const candidate of safe.choices) {
    if (!isObject(candidate) || !hasOnlyKeys(candidate, new Set(["fieldId", "statement", "required"]))) {
      throw persistenceError("CALL_POLICY_INVALID");
    }
     let fieldId: string;
     try {
       fieldId = requireIdentifier(candidate.fieldId);
     } catch {
       throw persistenceError("CALL_POLICY_INVALID");
     }
    const statement = requireText(candidate.statement, "CALL_POLICY_INVALID");
    if (
      statement.trim().length === 0 ||
      Buffer.byteLength(statement, "utf8") > 8 * 1024 ||
      typeof candidate.required !== "boolean"
    ) {
      throw persistenceError("CALL_POLICY_INVALID");
    }
    if (seen.has(fieldId)) {
      throw persistenceError("CALL_POLICY_INVALID");
    }
    const field = fieldsById.get(fieldId);
    if (!field || !CONSENT_FIELD_TYPES.has(field.type)) {
      throw persistenceError("CALL_POLICY_INVALID");
    }
    seen.add(fieldId);
    choices.push(freeze({ fieldId, statement, required: candidate.required }));
  }
  return freeze({
    schema: CFP_CALL_POLICY_SCHEMA,
    policyVersionId,
    disclosure,
    choices: freeze(choices),
  });
}

function policyFingerprint(policy: NormalizedCallPolicy): string {
  return fingerprintOf({
    schema: policy.schema,
    policyVersionId: policy.policyVersionId,
    disclosure: policy.disclosure,
    choices: policy.choices,
  });
}

function canonicalJsonBounded(
  value: unknown,
  maxBytes: number,
  errorCode: FormDocumentPersistenceErrorCode,
): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw persistenceError(errorCode);
  }
  return json;
}

function policySnapshot(policy: NormalizedCallPolicy, fingerprint: string): CallPolicySnapshot {
  return freeze({
    schema: policy.schema,
    policyVersionId: policy.policyVersionId,
    disclosure: policy.disclosure,
    choices: policy.choices,
    fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
    fingerprint,
  });
}

function normalizeStoredPolicy(
  policyJson: unknown,
  policySchema: unknown,
  policyVersionId: unknown,
  algorithm: unknown,
  fingerprint: unknown,
  fields: readonly FormFieldDefinition[],
): CallPolicySnapshot {
  if (
    policySchema !== CFP_CALL_POLICY_SCHEMA ||
    algorithm !== CFP_FINGERPRINT_ALGORITHM ||
    typeof fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(fingerprint) ||
    typeof policyVersionId !== "string"
  ) {
    throw persistenceError("CALL_POLICY_MIRROR_MISMATCH");
  }
  const parsed = boundedJsonParse(
    policyJson,
    "CALL_POLICY_INVALID",
    CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes,
    "CALL_POLICY_INVALID",
  );
  let artifact: NormalizedCallPolicy;
  try {
    artifact = normalizePolicyArtifact(parsed, fields);
  } catch {
    throw persistenceError("CALL_POLICY_INVALID");
  }
  if (
    artifact.policyVersionId !== policyVersionId ||
    canonicalJson(artifact) !== policyJson ||
    policyFingerprint(artifact) !== fingerprint
  ) {
    throw persistenceError("CALL_POLICY_NOT_CANONICAL");
  }
  const snapshot = policySnapshot(artifact, fingerprint);
  canonicalJsonBounded(snapshot, CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes, "CALL_POLICY_INVALID");
  return snapshot;
}

function normalizePolicyInput(input: unknown, fields: readonly FormFieldDefinition[], policyVersionId: string): NormalizedCallPolicy {
  const safe = sanitizeObject(input);
  if (!hasOnlyKeys(safe, new Set(["disclosure", "choices"]))) {
    throw persistenceError("CALL_POLICY_INVALID");
  }
  return normalizePolicyArtifact(
    {
      schema: CFP_CALL_POLICY_SCHEMA,
      policyVersionId,
      disclosure: safe.disclosure,
      choices: safe.choices,
    },
    fields,
  );
}

function normalizeReceipt(
  input: unknown,
  policy: NormalizedCallPolicy,
  expectedSubmissionId: string,
  expectedPersonId: string,
  expectedSessionId: string,
  stored: boolean,
): ConsentReceipt {
  let safe: JsonSafeObject;
  try {
    safe = sanitizeObject(input);
  } catch {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  if (
    !hasOnlyKeys(
      safe,
      new Set(["schema", "submissionId", "personId", "applicantSessionId", "receivedAt", "policyFingerprint", "choices"]),
    ) ||
    safe.schema !== CFP_CONSENT_RECEIPT_SCHEMA ||
    safe.submissionId !== expectedSubmissionId ||
    safe.personId !== expectedPersonId ||
    safe.applicantSessionId !== expectedSessionId ||
    typeof safe.receivedAt !== "string" ||
    safe.receivedAt.length === 0 ||
    typeof safe.policyFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(safe.policyFingerprint)
  ) {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  if (!Array.isArray(safe.choices) || safe.choices.length !== policy.choices.length) {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  const choices: Array<{ readonly fieldId: string; readonly value: boolean }> = [];
  for (let index = 0; index < policy.choices.length; index += 1) {
    const candidate = safe.choices[index];
    const expected = policy.choices[index];
    if (
      !isObject(candidate) ||
      !hasOnlyKeys(candidate, new Set(["fieldId", "value"])) ||
      candidate.fieldId !== expected?.fieldId ||
      typeof candidate.value !== "boolean"
    ) {
      throw persistenceError("SUBMISSION_REVISION_INVALID");
    }
    choices.push(freeze({ fieldId: expected.fieldId, value: candidate.value }));
  }
  if (safe.policyFingerprint !== policyFingerprint(policy)) {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  const receivedAt = requireIsoTimestamp(safe.receivedAt, "SUBMISSION_REVISION_INVALID");
  const receipt = freeze({
    schema: CFP_CONSENT_RECEIPT_SCHEMA,
    submissionId: expectedSubmissionId,
    personId: expectedPersonId,
    applicantSessionId: expectedSessionId,
    receivedAt,
    policyFingerprint: safe.policyFingerprint,
    choices: freeze(choices),
  });
  canonicalJsonBounded(receipt, CFP_PERSISTED_JSON_LIMITS.maxReceiptBytes, "SUBMISSION_REVISION_INVALID");
  return receipt;
}

function receiptFromEvaluation(
  submissionId: string,
  personId: string,
  sessionId: string,
  receivedAt: string,
  policy: NormalizedCallPolicy,
  effectiveAnswers: readonly FormAnswer[],
): ConsentReceipt | null {
  const values = new Map(effectiveAnswers.map((answer) => [answer.fieldId, answer.value]));
  const choices: Array<{ readonly fieldId: string; readonly value: boolean }> = [];
  for (const policyChoice of policy.choices) {
    const value = values.get(policyChoice.fieldId);
    if (typeof value !== "boolean") {
      return null;
    }
    choices.push({ fieldId: policyChoice.fieldId, value });
  }
  return normalizeReceipt(
    {
      schema: CFP_CONSENT_RECEIPT_SCHEMA,
      submissionId,
      personId,
      applicantSessionId: sessionId,
      receivedAt,
      policyFingerprint: policyFingerprint(policy),
      choices,
    },
    policy,
    submissionId,
    personId,
    sessionId,
    false,
  );
}

function buildRevision(
  submissionId: string,
  revisionNumber: number,
  formDocument: NormalizedFormDocument,
  policy: NormalizedCallPolicy,
  consentReceipt: ConsentReceipt | null,
): SubmissionRevision {
  const snapshot = policySnapshot(policy, policyFingerprint(policy));
  canonicalJsonBounded(snapshot, CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes, "SUBMISSION_REVISION_OVERSIZED");
  if (consentReceipt !== null) {
    canonicalJsonBounded(consentReceipt, CFP_PERSISTED_JSON_LIMITS.maxReceiptBytes, "SUBMISSION_REVISION_OVERSIZED");
  }
  const content = {
    schema: CFP_SUBMISSION_REVISION_SCHEMA,
    submissionId,
    revisionNumber,
    formDocument,
    callPolicy: snapshot,
    consentReceipt,
    fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
  } as const;
  return freeze({ ...content, fingerprint: fingerprintOf(content) });
}

function normalizeStoredNestedDocument(input: unknown, formVersion: SealedFormVersion): NormalizedFormDocument {
  let normalized: NormalizedFormDocument;
  try {
    normalized = normalizeFormDocument(input);
  } catch {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  if (
    normalized.formVersionId !== formVersion.id ||
    normalized.ruleVersionId !== formVersion.ruleVersionId ||
    canonicalJson(normalized.fields) !== canonicalJson(formVersion.document.fields)
  ) {
    throw persistenceError("SUBMISSION_REVISION_MIRROR_MISMATCH");
  }
  if (normalized.ruleVersionId !== formVersion.ruleVersion.id) {
    throw persistenceError("SUBMISSION_REVISION_MIRROR_MISMATCH");
  }
  let evaluation: ReturnType<typeof evaluateConditionalForm>;
  try {
    evaluation = evaluateConditionalForm({
      fields: formVersion.document.fields,
      historicalAnswers: normalized.historicalAnswers,
      ruleSet: formVersion.ruleVersion.rules,
    });
  } catch {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  if (canonicalJson(evaluation.effectiveAnswers) !== canonicalJson(normalized.effectiveAnswers)) {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  let reconstructed: NormalizedFormDocument;
  try {
    reconstructed = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: formVersion.id,
      ruleVersionId: formVersion.ruleVersionId,
      fields: formVersion.document.fields,
      historicalAnswers: normalized.historicalAnswers,
      effectiveAnswers: evaluation.effectiveAnswers,
    });
  } catch {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  if (canonicalJson(reconstructed) !== canonicalJson(normalized)) {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  return normalized;
}

function normalizeStoredNestedPolicy(input: unknown, fields: readonly FormFieldDefinition[]): CallPolicySnapshot {
  let safe: JsonSafeObject;
  try {
    safe = sanitizeObject(input);
  } catch {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  if (
    !hasOnlyKeys(
      safe,
      new Set(["schema", "policyVersionId", "disclosure", "choices", "fingerprintAlgorithm", "fingerprint"]),
    ) ||
    safe.fingerprintAlgorithm !== CFP_FINGERPRINT_ALGORITHM ||
    typeof safe.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(safe.fingerprint)
  ) {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  let artifact: NormalizedCallPolicy;
  try {
    artifact = normalizePolicyArtifact(
      {
        schema: safe.schema,
        policyVersionId: safe.policyVersionId,
        disclosure: safe.disclosure,
        choices: safe.choices,
      },
      fields,
    );
  } catch {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  const calculated = policyFingerprint(artifact);
  if (calculated !== safe.fingerprint) {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  const snapshot = policySnapshot(artifact, calculated);
  canonicalJsonBounded(snapshot, CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes, "SUBMISSION_REVISION_INVALID");
  return snapshot;
}

function readSession(db: Db, context: ApplicantSessionContext, now: string): SessionRow {
  requireContextWorkspace(db, context.workspaceId);
  const requestedSessionId = requireStoredIdentifier(context.sessionId, "SESSION_INVALID");
  const row = db
    .prepare(
        `SELECT s.id, s.workspace_id, s.call_id, s.person_id, s.verification_id,
               s.token_hash, s.created_at, s.expires_at, s.revoked_at,
               s.revoked_by, s.revoked_reason,
               v.call_id AS verification_call_id, v.workspace_id AS verification_workspace_id,
               v.email AS verification_email,
               p.workspace_id AS person_workspace_id, p.canonical_email AS person_email,
               consumed.person_id AS consumed_person_id,
               revoked_by.workspace_id AS revoked_by_workspace_id
        FROM cfp_applicant_sessions s
        JOIN cfp_email_verifications v ON v.id = s.verification_id
        JOIN people p ON p.id = s.person_id
        LEFT JOIN accounts revoked_by ON revoked_by.id = s.revoked_by
        LEFT JOIN cfp_email_verification_consumptions consumed
         ON consumed.workspace_id = s.workspace_id
        AND consumed.verification_id = s.verification_id
        AND consumed.person_id = s.person_id
       WHERE s.workspace_id = ? AND s.id = ?
       LIMIT 1`,
    )
     .get(context.workspaceId, requestedSessionId) as SessionRow | undefined;
  if (!row) {
    throw persistenceError("SESSION_INVALID");
  }
  const storedSessionId = requireStoredIdentifier(row.id, "SESSION_INVALID");
  requireRevocationTuple(row.revoked_at, row.revoked_by, row.revoked_reason, "SESSION_INVALID");
  if (
    storedSessionId !== requestedSessionId ||
    row.workspace_id !== context.workspaceId ||
    row.verification_workspace_id !== context.workspaceId ||
    row.person_workspace_id !== context.workspaceId ||
    row.verification_call_id !== row.call_id ||
    typeof row.verification_email !== "string" ||
    typeof row.person_email !== "string" ||
    row.verification_email.toLowerCase() !== row.person_email.toLowerCase() ||
    row.consumed_person_id !== row.person_id ||
    (row.revoked_by !== null && row.revoked_by_workspace_id !== context.workspaceId) ||
    typeof row.token_hash !== "string" ||
    row.token_hash.length < 1 ||
    row.token_hash.length > 128
  ) {
    throw persistenceError("SESSION_INVALID");
  }
  const createdAt = requireIsoTimestamp(row.created_at, "SESSION_INVALID");
  const expiresAt = requireIsoTimestamp(row.expires_at, "SESSION_INVALID");
  const nowAt = requireIsoTimestamp(now, "PERSISTENCE_WRITE_FAILED");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw persistenceError("SESSION_INVALID");
  }
  if (Date.parse(nowAt) < Date.parse(createdAt)) {
    throw persistenceError("SESSION_INVALID");
  }
  if (row.revoked_at !== null) {
    throw persistenceError("SESSION_REVOKED");
  }
  if (Date.parse(expiresAt) <= Date.parse(nowAt)) {
    throw persistenceError("SESSION_EXPIRED");
  }
  return row;
}

function readSubmissionRow(db: Db, workspaceId: string, submissionId: string): SubmissionRow {
  const row = db
    .prepare(
      `SELECT s.id, s.workspace_id, s.event_id, s.call_id, s.owner_person_id, s.state,
              s.pinned_form_version_id, s.pinned_rule_version_id, s.current_revision_id,
              c.form_version_id AS call_form_version_id, c.event_id AS call_event_id,
              c.state AS call_state, c.opens_at AS call_opens_at, c.closes_at AS call_closes_at,
              c.policy_version_id AS call_policy_version_id, c.policy_schema AS call_policy_schema,
              c.policy_json AS call_policy_json,
              c.policy_fingerprint_algorithm AS call_policy_fingerprint_algorithm,
              c.policy_fingerprint AS call_policy_fingerprint
       FROM submissions s
       JOIN calls c ON c.id = s.call_id AND c.workspace_id = s.workspace_id
       WHERE s.workspace_id = ? AND s.id = ?
       LIMIT 1`,
    )
    .get(workspaceId, submissionId) as SubmissionRow | undefined;
  if (!row) {
    throw persistenceError("SUBMISSION_NOT_FOUND");
  }
  if (row.workspace_id !== workspaceId || row.call_event_id !== row.event_id) {
    throw persistenceError("SUBMISSION_PIN_MISMATCH");
  }
  return row;
}

type RevisionRowBase = RevisionRow;

function readRevisionRow(db: Db, workspaceId: string, revisionId: string): RevisionRowBase {
  const row = db
    .prepare(
      `SELECT r.id, r.workspace_id, r.submission_id, r.revision_number, r.revision_schema,
              r.revision_json, r.form_version_id, r.rule_version_id,
              r.form_document_schema, r.form_document_fingerprint,
              r.policy_schema, r.policy_version_id, r.policy_fingerprint_algorithm, r.policy_fingerprint,
               r.consent_receipt_schema, r.consent_receipt_policy_fingerprint,
               r.session_id, r.person_id, r.fingerprint_algorithm, r.fingerprint, r.created_at,
               s.workspace_id AS submission_workspace_id, s.owner_person_id AS submission_owner_person_id,
              s.pinned_form_version_id AS submission_pinned_form_version_id,
              s.pinned_rule_version_id AS submission_pinned_rule_version_id,
              s.current_revision_id AS submission_current_revision_id,
              s.state AS submission_state, s.call_id,
              c.policy_version_id AS call_policy_version_id, c.policy_schema AS call_policy_schema,
              c.policy_json AS call_policy_json,
               c.policy_fingerprint_algorithm AS call_policy_fingerprint_algorithm,
               c.policy_fingerprint AS call_policy_fingerprint,
               p.workspace_id AS person_workspace_id,
               session_row.workspace_id AS session_workspace_id,
               session_row.call_id AS session_call_id,
                session_row.person_id AS session_person_id,
                session_row.verification_id AS session_verification_id,
                 session_row.revoked_at AS session_revoked_at,
                 session_row.revoked_by AS session_revoked_by,
                 session_row.revoked_reason AS session_revoked_reason,
                 revoked_by.workspace_id AS session_revoked_by_workspace_id,
                 session_row.created_at AS session_created_at,
                session_row.expires_at AS session_expires_at,
                consumed.id AS consumed_id
        FROM submission_revisions r
        JOIN submissions s ON s.id = r.submission_id AND s.workspace_id = r.workspace_id
        JOIN calls c ON c.id = s.call_id AND c.workspace_id = s.workspace_id
        JOIN people p ON p.id = r.person_id
         LEFT JOIN cfp_applicant_sessions session_row ON session_row.id = r.session_id
         LEFT JOIN accounts revoked_by ON revoked_by.id = session_row.revoked_by
        LEFT JOIN cfp_email_verification_consumptions consumed
          ON consumed.workspace_id = r.workspace_id
         AND consumed.verification_id = session_row.verification_id
         AND consumed.person_id = session_row.person_id
       WHERE r.workspace_id = ? AND r.id = ?
       LIMIT 1`,
    )
    .get(workspaceId, revisionId) as RevisionRow | undefined;
   if (!row) {
     throw persistenceError("SUBMISSION_REVISION_NOT_FOUND");
   }
   requireStoredIdentifier(row.id, "SUBMISSION_REVISION_MIRROR_MISMATCH");
   requireOptionalStoredIdentifier(row.submission_current_revision_id, "REVISION_POINTER_INVALID");
   if (
    row.workspace_id !== workspaceId ||
    row.submission_workspace_id !== workspaceId ||
    row.person_workspace_id !== workspaceId ||
    row.submission_owner_person_id !== row.person_id ||
    row.submission_pinned_form_version_id !== row.form_version_id ||
    row.submission_pinned_rule_version_id !== row.rule_version_id ||
    row.session_workspace_id !== workspaceId ||
    row.session_call_id !== row.call_id ||
    row.session_person_id !== row.person_id ||
    row.consumed_id === null ||
    row.consumed_id === undefined
  ) {
    throw persistenceError("SUBMISSION_PIN_MISMATCH");
  }
  requireRevocationTuple(
    row.session_revoked_at,
    row.session_revoked_by,
    row.session_revoked_reason,
    "SUBMISSION_REVISION_MIRROR_MISMATCH",
  );
  const sessionCreatedAt = requireIsoTimestamp(row.session_created_at, "SUBMISSION_REVISION_MIRROR_MISMATCH");
  const sessionExpiresAt = requireIsoTimestamp(row.session_expires_at, "SUBMISSION_REVISION_MIRROR_MISMATCH");
  if (Date.parse(sessionExpiresAt) <= Date.parse(sessionCreatedAt)) {
    throw persistenceError("SUBMISSION_REVISION_MIRROR_MISMATCH");
  }
  requireRevisionWithinSession(
    row.created_at,
    sessionCreatedAt,
    sessionExpiresAt,
    "SUBMISSION_REVISION_MIRROR_MISMATCH",
  );
  if (
    row.session_revoked_by !== null &&
    row.session_revoked_by_workspace_id !== row.workspace_id
  ) {
    throw persistenceError("SUBMISSION_REVISION_MIRROR_MISMATCH");
  }
  return row;
}

function normalizeStoredRevision(
  row: RevisionRow,
  formVersion: SealedFormVersion,
  policyFields: readonly FormFieldDefinition[],
): SubmissionRevision {
  requireStoredIdentifier(row.id, "SUBMISSION_REVISION_MIRROR_MISMATCH");
  const submissionId = requireStoredIdentifier(row.submission_id, "SUBMISSION_REVISION_MIRROR_MISMATCH");
  const revisionNumber = requirePositiveInteger(row.revision_number, "SUBMISSION_REVISION_MIRROR_MISMATCH");
  const createdAt = requireIsoTimestamp(row.created_at, "SUBMISSION_REVISION_MIRROR_MISMATCH");
  if (
    row.revision_schema !== CFP_SUBMISSION_REVISION_SCHEMA ||
    row.fingerprint_algorithm !== CFP_FINGERPRINT_ALGORITHM ||
    typeof row.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(row.fingerprint) ||
    row.workspace_id !== row.submission_workspace_id
  ) {
    throw persistenceError("SUBMISSION_REVISION_MIRROR_MISMATCH");
  }
  const parsed = boundedJsonParse(row.revision_json, "SUBMISSION_REVISION_JSON_INVALID");
  let safe: JsonSafeObject;
  try {
    safe = sanitizeObject(parsed);
  } catch {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  if (
    !hasOnlyKeys(
      safe,
      new Set(["schema", "submissionId", "revisionNumber", "formDocument", "callPolicy", "consentReceipt", "fingerprintAlgorithm", "fingerprint"]),
    ) ||
    ![
      "schema",
      "submissionId",
      "revisionNumber",
      "formDocument",
      "callPolicy",
      "consentReceipt",
      "fingerprintAlgorithm",
      "fingerprint",
    ].every((key) => hasOwn(safe, key)) ||
    safe.schema !== CFP_SUBMISSION_REVISION_SCHEMA ||
    safe.submissionId !== submissionId ||
    safe.revisionNumber !== revisionNumber ||
    safe.fingerprintAlgorithm !== CFP_FINGERPRINT_ALGORITHM ||
    typeof safe.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(safe.fingerprint)
  ) {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  if (safe.fingerprint !== row.fingerprint) {
    throw persistenceError("SUBMISSION_REVISION_MIRROR_MISMATCH");
  }
  if (safe.callPolicy !== null && safe.callPolicy !== undefined) {
    canonicalJsonBounded(
      safe.callPolicy,
      CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes,
      "SUBMISSION_REVISION_OVERSIZED",
    );
  }
  if (safe.consentReceipt !== null) {
    canonicalJsonBounded(
      safe.consentReceipt,
      CFP_PERSISTED_JSON_LIMITS.maxReceiptBytes,
      "SUBMISSION_REVISION_OVERSIZED",
    );
  }

  const formDocument = normalizeStoredNestedDocument(safe.formDocument, formVersion);
  const callPolicy = normalizeStoredNestedPolicy(safe.callPolicy, policyFields);
  let consentReceipt: ConsentReceipt | null = null;
  if (safe.consentReceipt !== null) {
    consentReceipt = normalizeReceipt(
      safe.consentReceipt,
      callPolicy,
      submissionId,
      requireStoredIdentifier(row.person_id, "SUBMISSION_REVISION_MIRROR_MISMATCH"),
      requireStoredIdentifier(row.session_id, "SUBMISSION_REVISION_MIRROR_MISMATCH"),
      true,
    );
  }
  const expectedReceipt = receiptFromEvaluation(
    submissionId,
    requireStoredIdentifier(row.person_id, "SUBMISSION_REVISION_MIRROR_MISMATCH"),
    requireStoredIdentifier(row.session_id, "SUBMISSION_REVISION_MIRROR_MISMATCH"),
    createdAt,
    callPolicy,
    formDocument.effectiveAnswers,
  );
  if (
    (consentReceipt === null) !== (expectedReceipt === null) ||
    (consentReceipt !== null && expectedReceipt !== null && canonicalJson(consentReceipt) !== canonicalJson(expectedReceipt))
  ) {
    throw persistenceError("SUBMISSION_REVISION_INVALID");
  }
  const content = {
    schema: CFP_SUBMISSION_REVISION_SCHEMA,
    submissionId,
    revisionNumber,
    formDocument,
    callPolicy,
    consentReceipt,
    fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
  } as const;
  if (
    safe.fingerprint !== fingerprintOf(content) ||
    canonicalJson({ ...content, fingerprint: safe.fingerprint }) !== row.revision_json
  ) {
    throw persistenceError("SUBMISSION_REVISION_NOT_CANONICAL");
  }
  if (
    row.form_version_id !== formDocument.formVersionId ||
    row.rule_version_id !== formDocument.ruleVersionId ||
    row.form_document_schema !== formDocument.schema ||
    row.form_document_fingerprint !== formDocument.fingerprint ||
    row.policy_schema !== callPolicy.schema ||
    row.policy_version_id !== callPolicy.policyVersionId ||
    row.policy_fingerprint_algorithm !== callPolicy.fingerprintAlgorithm ||
    row.policy_fingerprint !== callPolicy.fingerprint ||
    row.consent_receipt_schema !== (consentReceipt?.schema ?? null) ||
    row.consent_receipt_policy_fingerprint !== (consentReceipt?.policyFingerprint ?? null) ||
    (consentReceipt !== null && row.person_id !== consentReceipt.personId) ||
    (consentReceipt !== null && row.session_id !== consentReceipt.applicantSessionId)
  ) {
    throw persistenceError("SUBMISSION_REVISION_MIRROR_MISMATCH");
  }
  return freeze({
    schema: CFP_SUBMISSION_REVISION_SCHEMA,
    submissionId,
    revisionNumber,
    formDocument,
    callPolicy,
    consentReceipt,
    fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
    fingerprint: safe.fingerprint,
  });
}

function readSessionForRevision(db: Db, row: RevisionRow): void {
  const sessionId = requireStoredIdentifier(row.session_id, "SUBMISSION_REVISION_MIRROR_MISMATCH");
  const session = db
    .prepare(
       `SELECT s.call_id, s.person_id, s.workspace_id, s.revoked_at,
               s.revoked_by, s.revoked_reason, s.created_at, s.expires_at,
               v.call_id AS verification_call_id, v.workspace_id AS verification_workspace_id,
              p.workspace_id AS person_workspace_id, v.email AS verification_email,
              p.canonical_email AS person_email, consumed.id AS consumed_id
       FROM cfp_applicant_sessions s
       JOIN cfp_email_verifications v ON v.id = s.verification_id
       JOIN people p ON p.id = s.person_id
       LEFT JOIN cfp_email_verification_consumptions consumed
         ON consumed.workspace_id = s.workspace_id
        AND consumed.verification_id = s.verification_id
        AND consumed.person_id = s.person_id
       WHERE s.id = ? LIMIT 1`,
    )
    .get(sessionId) as {
    call_id: unknown;
    person_id: unknown;
     workspace_id: unknown;
     revoked_at: unknown;
     revoked_by: unknown;
     revoked_reason: unknown;
     created_at: unknown;
     expires_at: unknown;
    verification_call_id: unknown;
    verification_workspace_id: unknown;
    person_workspace_id: unknown;
    verification_email: unknown;
    person_email: unknown;
    consumed_id: unknown;
  } | undefined;
  if (
   !session ||
    session.workspace_id !== row.workspace_id ||
    session.call_id !== row.call_id ||
    session.person_id !== row.person_id ||
    session.verification_call_id !== row.call_id ||
    session.verification_workspace_id !== row.workspace_id ||
    session.person_workspace_id !== row.workspace_id ||
    typeof session.verification_email !== "string" ||
    typeof session.person_email !== "string" ||
    session.verification_email.toLowerCase() !== session.person_email.toLowerCase() ||
    session.consumed_id === null ||
    session.consumed_id === undefined
   ) {
    throw persistenceError("SUBMISSION_REVISION_MIRROR_MISMATCH");
  }
  requireRevocationTuple(
    session.revoked_at,
    session.revoked_by,
    session.revoked_reason,
    "SUBMISSION_REVISION_MIRROR_MISMATCH",
  );
  const createdAt = requireIsoTimestamp(session.created_at, "SUBMISSION_REVISION_MIRROR_MISMATCH");
  const expiresAt = requireIsoTimestamp(session.expires_at, "SUBMISSION_REVISION_MIRROR_MISMATCH");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw persistenceError("SUBMISSION_REVISION_MIRROR_MISMATCH");
  }
  requireRevisionWithinSession(
    row.created_at,
    createdAt,
    expiresAt,
    "SUBMISSION_REVISION_MIRROR_MISMATCH",
  );
}

function assertContiguousCurrentRevision(
  db: Db,
  workspaceId: string,
  submissionId: string,
  currentRevisionId: unknown,
): void {
  const revisions = db
    .prepare(
      `SELECT id, revision_number
       FROM submission_revisions
       WHERE workspace_id = ? AND submission_id = ?
       ORDER BY revision_number ASC`,
    )
    .all(workspaceId, submissionId) as Array<{ id: unknown; revision_number: unknown }>;
  if (revisions.length === 0) {
    if (currentRevisionId !== null) {
      throw persistenceError("REVISION_POINTER_INVALID");
    }
    return;
  }
  const storedCurrentRevisionId = requireOptionalStoredIdentifier(
    currentRevisionId,
    "REVISION_POINTER_INVALID",
  );
  if (storedCurrentRevisionId === null) {
    throw persistenceError("REVISION_POINTER_INVALID");
  }
  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index]!;
    requireStoredIdentifier(revision.id, "REVISION_POINTER_INVALID");
    if (requirePositiveInteger(revision.revision_number, "REVISION_POINTER_INVALID") !== index + 1) {
      throw persistenceError("REVISION_POINTER_INVALID");
    }
  }
  const latest = revisions[revisions.length - 1]!;
  if (latest.id !== storedCurrentRevisionId) {
    throw persistenceError("REVISION_POINTER_INVALID");
  }
}

function assertSubmittedRevisionEvidence(revision: SubmissionRevision): void {
  const receipt = revision.consentReceipt;
  if (receipt === null) {
    throw persistenceError("REVISION_POINTER_INVALID");
  }
  const values = new Map(receipt.choices.map((choice) => [choice.fieldId, choice.value]));
  for (const choice of revision.callPolicy.choices) {
    if (choice.required && values.get(choice.fieldId) !== true) {
      throw persistenceError("REVISION_POINTER_INVALID");
    }
  }
}

function readVerifiedRevision(
  db: Db,
  workspaceId: string,
  revisionId: string,
  expectedSubmissionId?: string,
  verifySubmittedState = true,
): SubmissionRevision {
  const row = readRevisionRow(db, workspaceId, revisionId);
  if (expectedSubmissionId !== undefined && row.submission_id !== expectedSubmissionId) {
    throw persistenceError("REVISION_POINTER_INVALID");
  }
  const submissionId = requireStoredIdentifier(row.submission_id, "REVISION_POINTER_INVALID");
  assertContiguousCurrentRevision(db, workspaceId, submissionId, row.submission_current_revision_id);
  readSessionForRevision(db, row);
  const formVersion = readVerifiedFormVersion(
    db,
    workspaceId,
    requireStoredIdentifier(row.form_version_id, "SUBMISSION_PIN_MISMATCH"),
  );
  const revision = normalizeStoredRevision(row, formVersion, formVersion.document.fields);
  if (verifySubmittedState && row.submission_state === "SUBMITTED") {
    assertContiguousCurrentRevision(
      db,
      workspaceId,
      submissionId,
      row.submission_current_revision_id,
    );
    const currentRevisionId = requireStoredIdentifier(
      row.submission_current_revision_id,
      "REVISION_POINTER_INVALID",
    );
    if (currentRevisionId === revisionId) {
      assertSubmittedRevisionEvidence(revision);
    } else {
      const currentRevision = readVerifiedRevision(
        db,
        workspaceId,
        currentRevisionId,
        submissionId,
        false,
      );
      assertSubmittedRevisionEvidence(currentRevision);
    }
  }
  return revision;
}

function withReadSnapshot<T>(db: Db, name: string, fn: () => T): T {
  if (db.isTransaction) {
    return withSavepoint(db, name, fn);
  }
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the domain failure if rollback itself is unavailable.
    }
    throw error;
  }
}

function createFormDefinitionInternal(
  db: Db,
  context: OrganizerContext,
  input: CreateFormDefinitionInput,
  deps: Dependencies,
): CreatedFormDefinition {
  return writeBoundary(() => {
    requireContextWorkspace(db, context.workspaceId, context.accountId);
    const safe = sanitizeObject(input);
    if (!hasOnlyKeys(safe, new Set(["name"]))) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const name = requireText(safe.name, "FORM_DEFINITION_NAME_INVALID");
    if (Buffer.byteLength(name, "utf8") > 512) {
      throw persistenceError("FORM_DEFINITION_NAME_INVALID");
    }
    const id = safeDependencyId(deps);
    const createdAt = safeDependencyNow(deps);
    withTransactionOrSavepoint(db, "cfp_create_form_definition", () => {
      db.prepare(
        `INSERT INTO form_definitions (id, workspace_id, name, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(id, context.workspaceId, name, createdAt);
    });
    return freeze({ id, workspaceId: context.workspaceId, name });
  });
}

function sealFormVersionInternal(
  db: Db,
  context: OrganizerContext,
  input: SealFormVersionInput,
  deps: Dependencies,
): SealedFormVersion {
  return writeBoundary(() => {
    requireContextWorkspace(db, context.workspaceId, context.accountId);
    const safe = sanitizeObject(input);
    if (!hasOnlyKeys(safe, new Set(["formDefinitionId", "fields", "rules"]))) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const formDefinitionId = requireIdentifier(safe.formDefinitionId);
    const safeFields = sanitizeFormData(safe.fields);
    const safeRuleInput = sanitizeObject(safe.rules);
    if (!hasOnlyKeys(safeRuleInput, new Set(["schema", "rules"]))) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const formVersionId = safeDependencyId(deps);
    const ruleVersionId = safeDependencyId(deps);
    const fieldsDocument = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId,
      ruleVersionId,
      fields: safeFields,
      historicalAnswers: [],
      effectiveAnswers: [],
    });
    const normalizedRules = normalizeFormRuleSet(
      {
        schema: safeRuleInput.schema,
        ruleVersionId,
        rules: safeRuleInput.rules,
      },
      fieldsDocument.fields,
    );
    const ruleJson = canonicalJsonBounded(normalizedRules, 256 * 1024, "RULE_ARTIFACT_INVALID");
    const ruleFingerprint = fingerprintOf(normalizedRules);
    const documentJson = canonicalJsonBounded(
      fieldsDocument,
      CFP_PERSISTED_JSON_LIMITS.maxSerializedBytes,
      "FORM_ARTIFACT_INVALID",
    );
    const sealedAt = safeDependencyNow(deps);
    let versionNumber = 0;
    withTransactionOrSavepoint(db, "cfp_seal_form_version", () => {
      const definition = db
        .prepare("SELECT 1 AS present FROM form_definitions WHERE id = ? AND workspace_id = ? LIMIT 1")
        .get(formDefinitionId, context.workspaceId);
      if (!definition) {
        throw persistenceError("FORM_DEFINITION_NOT_FOUND");
      }
      const next = db
        .prepare(
          `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
           FROM (
             SELECT version_number FROM rule_versions WHERE form_definition_id = ? AND workspace_id = ?
             UNION ALL
             SELECT version_number FROM form_versions WHERE form_definition_id = ? AND workspace_id = ?
           )`,
        )
        .get(formDefinitionId, context.workspaceId, formDefinitionId, context.workspaceId) as { next_version: number };
      versionNumber = requirePositiveInteger(next.next_version, "PERSISTENCE_WRITE_FAILED");
      db.prepare(
        `INSERT INTO rule_versions
           (id, workspace_id, form_definition_id, version_number, rules_schema, rules_json,
            fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ruleVersionId,
        context.workspaceId,
        formDefinitionId,
        versionNumber,
        FORM_RULES_SCHEMA,
        ruleJson,
        CFP_FINGERPRINT_ALGORITHM,
        ruleFingerprint,
        context.accountId,
        sealedAt,
      );
      db.prepare(
        `INSERT INTO form_versions
           (id, workspace_id, form_definition_id, rule_version_id, version_number,
            document_schema, document_json, fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        formVersionId,
        context.workspaceId,
        formDefinitionId,
        ruleVersionId,
        versionNumber,
        FORM_DOCUMENT_SCHEMA,
        documentJson,
        CFP_FINGERPRINT_ALGORITHM,
        fieldsDocument.fingerprint,
        context.accountId,
        sealedAt,
      );
    });
    const ruleVersion = freeze({
      id: ruleVersionId,
      workspaceId: context.workspaceId,
      formDefinitionId,
      versionNumber,
      schema: FORM_RULES_SCHEMA,
      rules: normalizedRules,
      fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
      fingerprint: ruleFingerprint,
      sealedBy: context.accountId,
      sealedAt,
    });
    return freeze({
      id: formVersionId,
      workspaceId: context.workspaceId,
      formDefinitionId,
      ruleVersionId,
      versionNumber,
      document: fieldsDocument,
      fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
      fingerprint: fieldsDocument.fingerprint,
      sealedBy: context.accountId,
      sealedAt,
      ruleVersion,
    });
  });
}

function createCallInternal(
  db: Db,
  context: OrganizerContext,
  input: CreateCallInput,
  deps: Dependencies,
): { readonly id: string } {
  return writeBoundary(() => {
    requireContextWorkspace(db, context.workspaceId, context.accountId);
    const safe = sanitizeObject(input);
    const allowed = new Set([
      "eventId",
      "name",
      "slug",
      "formVersionId",
      "policy",
      "accessMode",
      "state",
      "timezone",
      "opensAt",
      "closesAt",
    ]);
    if (!hasOnlyKeys(safe, allowed) || !hasOwn(safe, "policy")) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const eventId = requireIdentifier(safe.eventId);
    const formVersionId = requireIdentifier(safe.formVersionId);
    const name = requireText(safe.name);
    const slug = requireText(safe.slug);
    const accessModeValue = safe.accessMode ?? "INVITED";
    const stateValue = safe.state ?? "DRAFT";
    const timezoneValue = safe.timezone ?? "UTC";
    if (
      (accessModeValue !== "PUBLIC" && accessModeValue !== "INVITED" && accessModeValue !== "PUBLIC_AND_INVITED") ||
      !["DRAFT", "SCHEDULED", "OPEN", "PAUSED", "CLOSED", "ARCHIVED", "CANCELLED"].includes(String(stateValue)) ||
      typeof timezoneValue !== "string" ||
      timezoneValue.length === 0
    ) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const accessMode = accessModeValue as NonNullable<CreateCallInput["accessMode"]>;
    const state = stateValue as NonNullable<CreateCallInput["state"]>;
    const timezone = requireTimezone(timezoneValue, "PERSISTENCE_INPUT_INVALID");
    const opensAt = safe.opensAt === null || safe.opensAt === undefined
      ? null
      : requireIsoTimestamp(safe.opensAt, "PERSISTENCE_INPUT_INVALID");
    const closesAt = safe.closesAt === null || safe.closesAt === undefined
      ? null
      : requireIsoTimestamp(safe.closesAt, "PERSISTENCE_INPUT_INVALID");
    if (opensAt !== null && closesAt !== null && Date.parse(opensAt) > Date.parse(closesAt)) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const formVersion = readVerifiedFormVersion(db, context.workspaceId, formVersionId);
    const policyVersionId = safeDependencyId(deps);
    const policy = normalizePolicyInput(safe.policy, formVersion.document.fields, policyVersionId);
    const fingerprint = policyFingerprint(policy);
    const snapshot = policySnapshot(policy, fingerprint);
    canonicalJsonBounded(snapshot, CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes, "CALL_POLICY_INVALID");
    const policyJson = canonicalJsonBounded(
      policy,
      CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes,
      "CALL_POLICY_INVALID",
    );
    const id = safeDependencyId(deps);
    const timestamp = safeDependencyNow(deps);
    withTransactionOrSavepoint(db, "cfp_create_call", () => {
      const event = db
        .prepare("SELECT 1 AS present FROM events WHERE id = ? AND workspace_id = ? LIMIT 1")
        .get(eventId, context.workspaceId);
      if (!event) {
        throw persistenceError("CALL_NOT_FOUND");
      }
      db.prepare(
        `INSERT INTO calls
           (id, workspace_id, event_id, name, slug, form_version_id, access_mode, state,
            timezone, opens_at, closes_at, policy_version_id, policy_schema, policy_json,
            policy_fingerprint_algorithm, policy_fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        context.workspaceId,
        eventId,
        name,
        slug,
        formVersionId,
        accessMode,
        state,
        timezone,
        opensAt,
        closesAt,
        policyVersionId,
        CFP_CALL_POLICY_SCHEMA,
        policyJson,
        CFP_FINGERPRINT_ALGORITHM,
        fingerprint,
        timestamp,
        timestamp,
      );
    });
    return freeze({ id });
  });
}

function readCallInternal(db: Db, workspaceId: string, callId: string): CallReadModel {
  return readBoundary(() => {
    requireContextWorkspace(db, workspaceId);
    const row = db
      .prepare(
        `SELECT c.id, c.workspace_id, c.event_id, c.form_version_id, c.access_mode, c.state,
                 c.timezone, c.opens_at, c.closes_at,
                 c.policy_version_id, c.policy_schema, c.policy_json,
                 c.policy_fingerprint_algorithm, c.policy_fingerprint,
                 c.created_at, c.updated_at,
                 e.workspace_id AS event_workspace_id
         FROM calls c JOIN events e ON e.id = c.event_id
         WHERE c.workspace_id = ? AND c.id = ?
         LIMIT 1`,
      )
      .get(workspaceId, callId) as {
      id: unknown;
      workspace_id: unknown;
      event_id: unknown;
      form_version_id: unknown;
      access_mode: unknown;
      state: unknown;
      timezone: unknown;
      opens_at: unknown;
      closes_at: unknown;
      policy_version_id: unknown;
      policy_schema: unknown;
      policy_json: unknown;
      policy_fingerprint_algorithm: unknown;
      policy_fingerprint: unknown;
      created_at: unknown;
      updated_at: unknown;
      event_workspace_id: unknown;
    } | undefined;
    if (!row) {
      throw persistenceError("CALL_NOT_FOUND");
    }
    if (row.workspace_id !== workspaceId || row.event_workspace_id !== workspaceId) {
      throw persistenceError("CALL_NOT_FOUND");
    }
    const formVersion = readVerifiedFormVersion(
      db,
      workspaceId,
      requireStoredIdentifier(row.form_version_id, "CALL_POLICY_MIRROR_MISMATCH"),
    );
    const policy = normalizeStoredPolicy(
      row.policy_json,
      row.policy_schema,
      row.policy_version_id,
      row.policy_fingerprint_algorithm,
      row.policy_fingerprint,
      formVersion.document.fields,
    );
    const id = requireStoredIdentifier(row.id, "CALL_POLICY_MIRROR_MISMATCH");
    const eventId = requireStoredIdentifier(row.event_id, "CALL_POLICY_MIRROR_MISMATCH");
    if (
      row.access_mode !== "PUBLIC" &&
      row.access_mode !== "INVITED" &&
      row.access_mode !== "PUBLIC_AND_INVITED"
    ) {
      throw persistenceError("CALL_POLICY_MIRROR_MISMATCH");
    }
    if (!new Set(["DRAFT", "SCHEDULED", "OPEN", "PAUSED", "CLOSED", "ARCHIVED", "CANCELLED"]).has(String(row.state))) {
      throw persistenceError("CALL_POLICY_MIRROR_MISMATCH");
    }
    const timezone = requireTimezone(row.timezone, "CALL_POLICY_MIRROR_MISMATCH");
    const opensAt = row.opens_at === null ? null : requireIsoTimestamp(row.opens_at, "CALL_POLICY_MIRROR_MISMATCH");
    const closesAt = row.closes_at === null ? null : requireIsoTimestamp(row.closes_at, "CALL_POLICY_MIRROR_MISMATCH");
    if (opensAt !== null && closesAt !== null && Date.parse(opensAt) > Date.parse(closesAt)) {
      throw persistenceError("CALL_POLICY_MIRROR_MISMATCH");
    }
    const createdAt = requireIsoTimestamp(row.created_at, "CALL_POLICY_MIRROR_MISMATCH");
    const updatedAt = requireIsoTimestamp(row.updated_at, "CALL_POLICY_MIRROR_MISMATCH");
    if (Date.parse(updatedAt) < Date.parse(createdAt)) {
      throw persistenceError("CALL_POLICY_MIRROR_MISMATCH");
    }
    return freeze({
      id,
      workspaceId,
      eventId,
      formVersionId: formVersion.id,
      accessMode: row.access_mode as CallReadModel["accessMode"],
      state: row.state as CallReadModel["state"],
      timezone,
      opensAt,
      closesAt,
      ...policy,
      policy,
    });
  });
}

function updateCallPolicyInternal(
  db: Db,
  context: OrganizerContext,
  input: UpdateCallPolicyInput,
  deps: Dependencies,
): CallPolicySnapshot {
  return writeBoundary(() => {
    requireContextWorkspace(db, context.workspaceId, context.accountId);
    const safe = sanitizeObject(input);
    if (!hasOnlyKeys(safe, new Set(["callId", "expectedPolicyFingerprint", "policy"]))) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const callId = requireIdentifier(safe.callId);
    const expected = safe.expectedPolicyFingerprint;
    if (typeof expected !== "string" || !FINGERPRINT_PATTERN.test(expected)) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const policyVersionId = safeDependencyId(deps);
    const timestamp = safeDependencyNow(deps);
    return withTransactionOrSavepoint(db, "cfp_update_call_policy", () => {
      const current = db
        .prepare(
          `SELECT form_version_id, policy_version_id, policy_schema, policy_json,
                  policy_fingerprint_algorithm, policy_fingerprint, created_at, updated_at
           FROM calls WHERE workspace_id = ? AND id = ? LIMIT 1`,
        )
        .get(context.workspaceId, callId) as {
        form_version_id: unknown;
        policy_version_id: unknown;
        policy_schema: unknown;
        policy_json: unknown;
        policy_fingerprint_algorithm: unknown;
        policy_fingerprint: unknown;
        created_at: unknown;
        updated_at: unknown;
      } | undefined;
      if (!current) {
        throw persistenceError("CALL_NOT_FOUND");
      }
      if (current.policy_fingerprint !== expected) {
        throw persistenceError("CALL_POLICY_STALE");
      }
      const callCreatedAt = requireIsoTimestamp(current.created_at, "CALL_POLICY_MIRROR_MISMATCH");
      const priorUpdatedAt = requireIsoTimestamp(current.updated_at, "CALL_POLICY_MIRROR_MISMATCH");
      requireTimestampNotBefore(timestamp, callCreatedAt, "PERSISTENCE_WRITE_FAILED");
      requireTimestampNotBefore(timestamp, priorUpdatedAt, "PERSISTENCE_WRITE_FAILED");

       const currentFormVersionId = requireStoredIdentifier(
         current.form_version_id,
         "CALL_POLICY_MIRROR_MISMATCH",
       );
      const currentForm = readVerifiedFormVersion(db, context.workspaceId, currentFormVersionId);
      const currentPolicy = normalizeStoredPolicy(
        current.policy_json,
        current.policy_schema,
        current.policy_version_id,
        current.policy_fingerprint_algorithm,
        current.policy_fingerprint,
        currentForm.document.fields,
      );
      const currentPolicyJson = requireStoredPolicyJson(current.policy_json, "CALL_POLICY_MIRROR_MISMATCH");

      const draftFormRows = db
        .prepare(
          `SELECT DISTINCT pinned_form_version_id
           FROM submissions
           WHERE workspace_id = ? AND call_id = ? AND state = 'DRAFT'`,
        )
        .all(context.workspaceId, callId) as Array<{ pinned_form_version_id: unknown }>;
      const formVersionIds = new Set<string>([currentFormVersionId]);
      for (const draftFormRow of draftFormRows) {
         formVersionIds.add(requireStoredIdentifier(draftFormRow.pinned_form_version_id, "SUBMISSION_PIN_MISMATCH"));
      }

      let policy: NormalizedCallPolicy | null = null;
      for (const formVersionId of formVersionIds) {
        const formVersion = formVersionId === currentFormVersionId
          ? currentForm
          : readVerifiedFormVersion(db, context.workspaceId, formVersionId);
        const candidate = normalizePolicyInput(safe.policy, formVersion.document.fields, policyVersionId);
        if (policy !== null && canonicalJson(policy) !== canonicalJson(candidate)) {
          throw persistenceError("CALL_POLICY_INVALID");
        }
        policy = candidate;
      }
      if (policy === null) {
        throw persistenceError("CALL_POLICY_INVALID");
      }
      const fingerprint = policyFingerprint(policy);
      const snapshot = policySnapshot(policy, fingerprint);
      canonicalJsonBounded(snapshot, CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes, "CALL_POLICY_INVALID");
      const policyJson = canonicalJsonBounded(
        policy,
        CFP_PERSISTED_JSON_LIMITS.maxPolicyBytes,
        "CALL_POLICY_INVALID",
      );
      const result = db
        .prepare(
          `UPDATE calls
           SET policy_version_id = ?, policy_schema = ?, policy_json = ?,
               policy_fingerprint_algorithm = ?, policy_fingerprint = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?
             AND form_version_id = ?
             AND policy_version_id = ?
             AND policy_schema = ?
             AND policy_json = ?
             AND policy_fingerprint_algorithm = ?
             AND policy_fingerprint = ?`,
        )
        .run(
          policyVersionId,
          CFP_CALL_POLICY_SCHEMA,
          policyJson,
          CFP_FINGERPRINT_ALGORITHM,
          fingerprint,
          timestamp,
          context.workspaceId,
          callId,
          currentFormVersionId,
          currentPolicy.policyVersionId,
          currentPolicy.schema,
          currentPolicyJson,
          currentPolicy.fingerprintAlgorithm,
          currentPolicy.fingerprint,
        );
      if (result.changes !== 1) {
        throw persistenceError("CALL_POLICY_STALE");
      }
      return policySnapshot(policy, fingerprint);
    });
  });
}

function advanceCallFormVersionInternal(
  db: Db,
  context: OrganizerContext,
  input: AdvanceCallFormVersionInput,
  deps: Dependencies,
): { readonly id: string } {
  return writeBoundary(() => {
    requireContextWorkspace(db, context.workspaceId, context.accountId);
    const safe = sanitizeObject(input);
    if (!hasOnlyKeys(safe, new Set(["callId", "expectedFormVersionId", "nextFormVersionId"]))) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const callId = requireIdentifier(safe.callId);
    const expected = requireIdentifier(safe.expectedFormVersionId);
    const nextId = requireIdentifier(safe.nextFormVersionId);
    const timestamp = safeDependencyNow(deps);
    return withTransactionOrSavepoint(db, "cfp_advance_call_form", () => {
      const current = db
        .prepare(
           `SELECT c.form_version_id, c.policy_version_id, c.policy_schema, c.policy_json,
                   c.policy_fingerprint_algorithm, c.policy_fingerprint,
                   c.created_at, c.updated_at,
                   f.form_definition_id, f.version_number
           FROM calls c JOIN form_versions f ON f.id = c.form_version_id
           WHERE c.workspace_id = ? AND c.id = ? LIMIT 1`,
        )
        .get(context.workspaceId, callId) as {
        form_version_id: unknown;
        policy_version_id: unknown;
        policy_schema: unknown;
        policy_json: unknown;
         policy_fingerprint_algorithm: unknown;
         policy_fingerprint: unknown;
         created_at: unknown;
         updated_at: unknown;
         form_definition_id: unknown;
        version_number: unknown;
      } | undefined;
      if (!current) {
        throw persistenceError("CALL_NOT_FOUND");
      }
      if (current.form_version_id !== expected) {
        throw persistenceError("CALL_FORM_ADVANCE_STALE");
      }
      const callCreatedAt = requireIsoTimestamp(current.created_at, "CALL_POLICY_MIRROR_MISMATCH");
      const priorUpdatedAt = requireIsoTimestamp(current.updated_at, "CALL_POLICY_MIRROR_MISMATCH");
      requireTimestampNotBefore(timestamp, callCreatedAt, "PERSISTENCE_WRITE_FAILED");
      requireTimestampNotBefore(timestamp, priorUpdatedAt, "PERSISTENCE_WRITE_FAILED");
      const currentForm = readVerifiedFormVersion(db, context.workspaceId, expected);
      const next = db
        .prepare(
          `SELECT f.id, f.form_definition_id, f.version_number
           FROM form_versions f
           WHERE f.workspace_id = ? AND f.id = ? LIMIT 1`,
        )
        .get(context.workspaceId, nextId) as {
        id: string;
        form_definition_id: string;
        version_number: number;
      } | undefined;
      if (
        !next ||
        next.form_definition_id !== current.form_definition_id ||
        next.version_number <= Number(current.version_number)
      ) {
        throw persistenceError("CALL_FORM_ADVANCE_INVALID");
      }
      const nextForm = readVerifiedFormVersion(db, context.workspaceId, next.id);
      if (nextForm.formDefinitionId !== currentForm.formDefinitionId || nextForm.versionNumber <= currentForm.versionNumber) {
        throw persistenceError("CALL_FORM_ADVANCE_INVALID");
      }
      const currentPolicy = normalizeStoredPolicy(
        current.policy_json,
        current.policy_schema,
        current.policy_version_id,
        current.policy_fingerprint_algorithm,
        current.policy_fingerprint,
        currentForm.document.fields,
      );
       const currentPolicyJson = requireStoredPolicyJson(current.policy_json, "CALL_POLICY_MIRROR_MISMATCH");
      try {
        normalizePolicyArtifact(
          {
            schema: currentPolicy.schema,
            policyVersionId: currentPolicy.policyVersionId,
            disclosure: currentPolicy.disclosure,
            choices: currentPolicy.choices,
          },
          nextForm.document.fields,
        );
      } catch {
        throw persistenceError("CALL_FORM_ADVANCE_INVALID");
      }
      const result = db
        .prepare(
          `UPDATE calls SET form_version_id = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?
             AND form_version_id = ?
             AND policy_version_id = ?
             AND policy_schema = ?
             AND policy_json = ?
             AND policy_fingerprint_algorithm = ?
             AND policy_fingerprint = ?`,
        )
        .run(
          next.id,
          timestamp,
          context.workspaceId,
          callId,
          expected,
          currentPolicy.policyVersionId,
          currentPolicy.schema,
          currentPolicyJson,
          currentPolicy.fingerprintAlgorithm,
          currentPolicy.fingerprint,
        );
      if (result.changes !== 1) {
        throw persistenceError("CALL_FORM_ADVANCE_STALE");
      }
      return freeze({ id: callId });
    });
  });
}

function createDraftSubmissionInternal(
  db: Db,
  context: ApplicantSessionContext,
  input: CreateDraftSubmissionInput,
  deps: Dependencies,
): CreatedSubmission {
  return writeBoundary(() => {
    const safe = sanitizeObject(input);
    if (!hasOnlyKeys(safe, new Set(["callId"]))) {
      throw persistenceError("PERSISTENCE_INPUT_INVALID");
    }
    const callId = requireIdentifier(safe.callId);
    const id = safeDependencyId(deps);
    const timestamp = safeDependencyNow(deps);
    return withTransactionOrSavepoint(db, "cfp_create_draft", () => {
      const session = readSession(db, context, timestamp);
      if (session.call_id !== callId) {
        throw persistenceError("SESSION_INVALID");
      }
      const call = db
        .prepare(
          `SELECT c.event_id, c.form_version_id
           FROM calls c WHERE c.workspace_id = ? AND c.id = ? LIMIT 1`,
        )
        .get(context.workspaceId, callId) as { event_id: unknown; form_version_id: unknown } | undefined;
      if (!call) {
        throw persistenceError("CALL_NOT_FOUND");
      }
       const formVersion = readVerifiedFormVersion(
         db,
         context.workspaceId,
         requireStoredIdentifier(call.form_version_id, "CALL_POLICY_MIRROR_MISMATCH"),
       );
       const eventId = requireStoredIdentifier(call.event_id, "SUBMISSION_PIN_MISMATCH");
       const personId = requireStoredIdentifier(session.person_id, "SESSION_INVALID");
      db.prepare(
        `INSERT INTO submissions
           (id, workspace_id, event_id, call_id, owner_person_id, state,
            pinned_form_version_id, pinned_rule_version_id, current_revision_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        context.workspaceId,
        eventId,
        callId,
        personId,
        formVersion.id,
        formVersion.ruleVersionId,
        timestamp,
        timestamp,
      );
      return freeze({
        id,
        workspaceId: context.workspaceId,
        eventId,
        callId,
        ownerPersonId: personId,
        pinnedFormVersionId: formVersion.id,
        pinnedRuleVersionId: formVersion.ruleVersionId,
      });
    });
  });
}

function isOpenCallAt(submission: SubmissionRow, timestamp: string): boolean {
  if (submission.call_state !== "OPEN") return false;
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  if (submission.call_opens_at !== null) {
    if (typeof submission.call_opens_at !== "string") return false;
    const opensAtMs = Date.parse(submission.call_opens_at);
    if (!Number.isFinite(opensAtMs) || timestampMs < opensAtMs) return false;
  }
  if (submission.call_closes_at !== null) {
    if (typeof submission.call_closes_at !== "string") return false;
    const closesAtMs = Date.parse(submission.call_closes_at);
    if (!Number.isFinite(closesAtMs) || timestampMs >= closesAtMs) return false;
  }
  return true;
}

function hasSubmissionDecision(db: Db, workspaceId: string, submissionId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM domain_events
         WHERE workspace_id = ?
           AND event_type = 'cfp.submission.decision'
           AND aggregate_type = 'cfp_submission'
           AND aggregate_id = ?
         LIMIT 1`,
      )
      .get(workspaceId, submissionId),
  );
}

function saveRevisionInternal(
  db: Db,
  context: ApplicantSessionContext,
  input: SaveDraftRevisionInput | SaveSubmittedAmendmentInput,
  deps: Dependencies,
  mode: "DRAFT" | "SUBMITTED_AMENDMENT",
): SavedSubmissionRevision {
  const safeInput = sanitizeObject(input);
  if (!hasOnlyKeys(safeInput, new Set(["submissionId", "historicalAnswers", "expectedCurrentRevisionId"]))) {
    throw persistenceError("PERSISTENCE_INPUT_INVALID");
  }
  const submissionId = requireIdentifier(safeInput.submissionId);
  const expectedValue = safeInput.expectedCurrentRevisionId;
  const expected = expectedValue === null ? null : requireIdentifier(expectedValue);
  const amendment = mode === "SUBMITTED_AMENDMENT";
  return writeBoundary(() =>
    withTransactionOrSavepoint(db, amendment ? "cfp_save_submitted_amendment" : "cfp_save_draft_revision", () => {
      const timestamp = safeDependencyNow(deps);
      const session = readSession(db, context, timestamp);
      const submission = readSubmissionRow(db, context.workspaceId, submissionId);
      if (!amendment && submission.state !== "DRAFT") {
        throw persistenceError("SUBMISSION_NOT_DRAFT");
      }
      if (amendment && (
        submission.state !== "SUBMITTED" ||
        !isOpenCallAt(submission, timestamp) ||
        hasSubmissionDecision(db, context.workspaceId, submissionId)
      )) {
        throw persistenceError("SUBMISSION_AMENDMENT_NOT_ALLOWED");
      }
      if (submission.call_id !== session.call_id || submission.owner_person_id !== session.person_id) {
        throw persistenceError("SESSION_INVALID");
      }
      if (amendment && expected === null) {
        throw persistenceError("STALE_REVISION");
      }
      const callId = requireStoredIdentifier(submission.call_id, "SESSION_INVALID");
      assertContiguousCurrentRevision(
        db,
        context.workspaceId,
        submissionId,
        submission.current_revision_id,
      );
      if (submission.current_revision_id !== expected || (amendment && expected === null)) {
        throw persistenceError("STALE_REVISION");
      }
      const formVersion = readVerifiedFormVersion(
        db,
        context.workspaceId,
        requireStoredIdentifier(submission.pinned_form_version_id, "SUBMISSION_PIN_MISMATCH"),
      );
      if (
        typeof submission.pinned_rule_version_id !== "string" ||
        formVersion.ruleVersionId !== submission.pinned_rule_version_id
      ) {
        throw persistenceError("SUBMISSION_PIN_MISMATCH");
      }
      const currentCallForm = readVerifiedFormVersion(
        db,
        context.workspaceId,
        requireStoredIdentifier(submission.call_form_version_id, "CALL_POLICY_MIRROR_MISMATCH"),
      );
      if (currentCallForm.formDefinitionId !== formVersion.formDefinitionId) {
        throw persistenceError("SUBMISSION_PIN_MISMATCH");
      }
      const callPolicy = normalizeStoredPolicy(
        submission.call_policy_json,
        submission.call_policy_schema,
        submission.call_policy_version_id,
        submission.call_policy_fingerprint_algorithm,
        submission.call_policy_fingerprint,
        currentCallForm.document.fields,
      );
      const callPolicyArtifact = {
        schema: callPolicy.schema,
        policyVersionId: callPolicy.policyVersionId,
        disclosure: callPolicy.disclosure,
        choices: callPolicy.choices,
      } as const;
      let pinnedPolicy: NormalizedCallPolicy;
      try {
        pinnedPolicy = normalizePolicyArtifact(callPolicyArtifact, formVersion.document.fields);
      } catch {
        throw persistenceError("CALL_POLICY_INVALID");
      }
      if (
        canonicalJson(pinnedPolicy) !== canonicalJson(callPolicyArtifact) ||
        policyFingerprint(pinnedPolicy) !== callPolicy.fingerprint
      ) {
        throw persistenceError("CALL_POLICY_INVALID");
      }
      const evaluation = evaluateConditionalForm({
        fields: formVersion.document.fields,
        historicalAnswers: safeInput.historicalAnswers,
        ruleSet: formVersion.ruleVersion.rules,
      });
      const document = normalizeFormDocument({
        schema: FORM_DOCUMENT_SCHEMA,
        formVersionId: formVersion.id,
        ruleVersionId: formVersion.ruleVersionId,
        fields: formVersion.document.fields,
        historicalAnswers: safeInput.historicalAnswers,
        effectiveAnswers: evaluation.effectiveAnswers,
      });
      let revisionNumber = 1;
      if (expected !== null) {
        revisionNumber = readVerifiedRevision(db, context.workspaceId, expected, submissionId).revisionNumber + 1;
      }
       const personId = requireStoredIdentifier(session.person_id, "SESSION_INVALID");
       const sessionId = requireStoredIdentifier(session.id, "SESSION_INVALID");
      const receipt = receiptFromEvaluation(
        submissionId,
        personId,
        sessionId,
        timestamp,
        callPolicy,
        evaluation.effectiveAnswers,
      );
      const revision = buildRevision(submissionId, revisionNumber, document, callPolicy, receipt);
      const revisionId = safeDependencyId(deps);
      if (amendment) {
        const amendmentId = safeDependencyId(deps);
        db.prepare(
          `INSERT INTO cfp_submission_amendment_markers
             (id, marker_schema, workspace_id, call_id, submission_id, person_id,
              session_id, expected_current_revision_id, revision_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          amendmentId,
          CFP_SUBMISSION_AMENDMENT_MARKER_SCHEMA,
          context.workspaceId,
          callId,
          submissionId,
          personId,
          sessionId,
          expected as string,
          revisionId,
          timestamp,
        );
      }
      db.prepare(
        `INSERT INTO submission_revisions
           (id, workspace_id, submission_id, revision_number, revision_schema, revision_json,
            form_version_id, rule_version_id, form_document_schema, form_document_fingerprint,
            policy_schema, policy_version_id, policy_fingerprint_algorithm, policy_fingerprint,
            consent_receipt_schema, consent_receipt_policy_fingerprint,
            session_id, person_id, fingerprint_algorithm, fingerprint, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revisionId,
        context.workspaceId,
        submissionId,
        revisionNumber,
        CFP_SUBMISSION_REVISION_SCHEMA,
        canonicalJsonBounded(
          revision,
          CFP_PERSISTED_JSON_LIMITS.maxSerializedBytes,
          "SUBMISSION_REVISION_OVERSIZED",
        ),
        document.formVersionId,
        document.ruleVersionId,
        document.schema,
        document.fingerprint,
        callPolicy.schema,
        callPolicy.policyVersionId,
        callPolicy.fingerprintAlgorithm,
        callPolicy.fingerprint,
        receipt?.schema ?? null,
        receipt?.policyFingerprint ?? null,
         sessionId,
        personId,
        CFP_FINGERPRINT_ALGORITHM,
        revision.fingerprint,
        timestamp,
      );
      const update = amendment
        ? db
            .prepare(
              `UPDATE submissions
               SET current_revision_id = ?
               WHERE workspace_id = ? AND id = ? AND call_id = ? AND owner_person_id = ?
                 AND state = 'SUBMITTED' AND current_revision_id IS ?
                 AND EXISTS (
                   SELECT 1 FROM calls c
                   WHERE c.id = submissions.call_id
                     AND c.workspace_id = submissions.workspace_id
                     AND c.state = 'OPEN'
                     AND (c.opens_at IS NULL OR ? >= c.opens_at)
                     AND (c.closes_at IS NULL OR ? < c.closes_at)
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM domain_events decision_event
                   WHERE decision_event.workspace_id = submissions.workspace_id
                     AND decision_event.event_type = 'cfp.submission.decision'
                     AND decision_event.aggregate_type = 'cfp_submission'
                     AND decision_event.aggregate_id = submissions.id
                 )`,
            )
            .run(
              revisionId,
              context.workspaceId,
              submissionId,
              callId,
              personId,
              expected as string,
              timestamp,
              timestamp,
            )
        : db
            .prepare(
              `UPDATE submissions
               SET current_revision_id = ?, updated_at = ?
               WHERE workspace_id = ? AND id = ? AND state = 'DRAFT'
                 AND current_revision_id IS ?`,
            )
            .run(revisionId, timestamp, context.workspaceId, submissionId, expected);
      if (update.changes !== 1) {
        throw persistenceError("STALE_REVISION");
      }
      return freeze({ revisionId, revision });
    }),
  );
}

function saveDraftRevisionInternal(
  db: Db,
  context: ApplicantSessionContext,
  input: SaveDraftRevisionInput,
  deps: Dependencies,
): SavedSubmissionRevision {
  return saveRevisionInternal(db, context, input, deps, "DRAFT");
}

function saveSubmittedAmendmentInternal(
  db: Db,
  context: ApplicantSessionContext,
  input: SaveSubmittedAmendmentInput,
  deps: Dependencies,
): SavedSubmissionRevision {
  return saveRevisionInternal(db, context, input, deps, "SUBMITTED_AMENDMENT");
}

function readFormVersionDocumentInternal(db: Db, workspaceId: string, formVersionId: string): NormalizedFormDocument {
  return readBoundary(() => readVerifiedFormVersion(db, workspaceId, requireIdentifier(formVersionId)).document);
}

function readRuleVersionInternal(db: Db, workspaceId: string, ruleVersionId: string): NormalizedRuleVersion {
  return readBoundary(() => readVerifiedRuleVersion(db, workspaceId, requireIdentifier(ruleVersionId)));
}

function readSubmissionRevisionInternal(db: Db, workspaceId: string, revisionId: string): SubmissionRevision {
  return readBoundary(() => withReadSnapshot(db, "cfp_read_revision", () => {
    requireContextWorkspace(db, workspaceId);
    return readVerifiedRevision(db, workspaceId, requireIdentifier(revisionId));
  }));
}

function readCurrentSubmissionRevisionInternal(db: Db, workspaceId: string, submissionId: string): SubmissionRevision {
  return readBoundary(() => {
    return withReadSnapshot(db, "cfp_read_current_revision", () => {
      requireContextWorkspace(db, workspaceId);
      const requestedSubmissionId = requireIdentifier(submissionId);
      const row = db
        .prepare(
          `SELECT current_revision_id FROM submissions
           WHERE workspace_id = ? AND id = ? LIMIT 1`,
        )
        .get(workspaceId, requestedSubmissionId) as { current_revision_id: string | null } | undefined;
      if (!row) {
        throw persistenceError("SUBMISSION_REVISION_NOT_FOUND");
      }
      assertContiguousCurrentRevision(db, workspaceId, requestedSubmissionId, row.current_revision_id);
      if (row.current_revision_id === null) {
        throw persistenceError("SUBMISSION_REVISION_NOT_FOUND");
      }
      return readVerifiedRevision(db, workspaceId, row.current_revision_id, requestedSubmissionId);
    });
  });
}

function createDependencies(options?: CfpPersistenceDependencyOptions): Dependencies {
  return Object.freeze({
    now: options?.clock ?? nowIso,
    id: options?.idGenerator ?? uuid,
  });
}

export function createCfpPersistence(options?: CfpPersistenceDependencyOptions): CfpPersistence {
  const deps = createDependencies(options);
  return {
    createFormDefinition: (db, context, input) => createFormDefinitionInternal(db, context, input, deps),
    sealFormVersion: (db, context, input) => sealFormVersionInternal(db, context, input, deps),
    createCall: (db, context, input) => createCallInternal(db, context, input, deps),
    readCall: readCallInternal,
    updateCallPolicy: (db, context, input) => updateCallPolicyInternal(db, context, input, deps),
    advanceCallFormVersion: (db, context, input) => advanceCallFormVersionInternal(db, context, input, deps),
    createDraftSubmission: (db, context, input) => createDraftSubmissionInternal(db, context, input, deps),
    saveDraftRevision: (db, context, input) => saveDraftRevisionInternal(db, context, input, deps),
    saveSubmittedAmendment: (db, context, input) => saveSubmittedAmendmentInternal(db, context, input, deps),
    readFormVersionDocument: readFormVersionDocumentInternal,
    readRuleVersion: readRuleVersionInternal,
    readSubmissionRevision: readSubmissionRevisionInternal,
    readCurrentSubmissionRevision: readCurrentSubmissionRevisionInternal,
  };
}

const defaultPersistence = createCfpPersistence();

export function createFormDefinition(db: Db, context: OrganizerContext, input: CreateFormDefinitionInput): CreatedFormDefinition {
  return defaultPersistence.createFormDefinition(db, context, input);
}

export function sealFormVersion(db: Db, context: OrganizerContext, input: SealFormVersionInput): SealedFormVersion {
  return defaultPersistence.sealFormVersion(db, context, input);
}

export function createCall(db: Db, context: OrganizerContext, input: CreateCallInput): { readonly id: string } {
  return defaultPersistence.createCall(db, context, input);
}

export function readCall(db: Db, workspaceId: string, callId: string): CallReadModel {
  return defaultPersistence.readCall(db, workspaceId, callId);
}

export function updateCallPolicy(db: Db, context: OrganizerContext, input: UpdateCallPolicyInput): CallPolicySnapshot {
  return defaultPersistence.updateCallPolicy(db, context, input);
}

export function advanceCallFormVersion(
  db: Db,
  context: OrganizerContext,
  input: AdvanceCallFormVersionInput,
): { readonly id: string } {
  return defaultPersistence.advanceCallFormVersion(db, context, input);
}

export function createDraftSubmission(
  db: Db,
  context: ApplicantSessionContext,
  input: CreateDraftSubmissionInput,
): CreatedSubmission {
  return defaultPersistence.createDraftSubmission(db, context, input);
}

export function saveDraftRevision(
  db: Db,
  context: ApplicantSessionContext,
  input: SaveDraftRevisionInput,
): SavedSubmissionRevision {
  return defaultPersistence.saveDraftRevision(db, context, input);
}

export function saveSubmittedAmendment(
  db: Db,
  context: ApplicantSessionContext,
  input: SaveSubmittedAmendmentInput,
): SavedSubmissionRevision {
  return defaultPersistence.saveSubmittedAmendment(db, context, input);
}

export function readFormVersionDocument(db: Db, workspaceId: string, formVersionId: string): NormalizedFormDocument {
  return defaultPersistence.readFormVersionDocument(db, workspaceId, formVersionId);
}

export function readRuleVersion(db: Db, workspaceId: string, ruleVersionId: string): NormalizedRuleVersion {
  return defaultPersistence.readRuleVersion(db, workspaceId, ruleVersionId);
}

export function readSubmissionRevision(db: Db, workspaceId: string, revisionId: string): SubmissionRevision {
  return defaultPersistence.readSubmissionRevision(db, workspaceId, revisionId);
}

export function readCurrentSubmissionRevision(db: Db, workspaceId: string, submissionId: string): SubmissionRevision {
  return defaultPersistence.readCurrentSubmissionRevision(db, workspaceId, submissionId);
}

/** Compatibility-safe read view: it returns only the accepted nested form document. */
export function readSubmissionRevisionDocument(db: Db, workspaceId: string, revisionId: string): NormalizedFormDocument {
  return readSubmissionRevision(db, workspaceId, revisionId).formDocument;
}

/** Compatibility-safe read view: it returns only the accepted nested form document. */
export function readCurrentSubmissionDocument(db: Db, workspaceId: string, submissionId: string): NormalizedFormDocument {
  return readCurrentSubmissionRevision(db, workspaceId, submissionId).formDocument;
}
