import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";

import type { Db } from "../../db";
import { canonicalJson, fingerprintOf, uuid } from "../../canonical";
import type {
  CallPolicySnapshot,
  CallPolicyChoice,
  CallReadModel,
  NormalizedRuleVersion,
  SubmissionRevision,
} from "./form-documents";
import {
  CFP_CALL_POLICY_SCHEMA,
  CFP_CONSENT_RECEIPT_SCHEMA,
  CFP_FINGERPRINT_ALGORITHM,
  CFP_SUBMISSION_REVISION_SCHEMA,
  FormDocumentPersistenceError,
  readCall as readCallSeam,
  readFormVersionDocument as readFormVersionDocumentSeam,
  readRuleVersion as readRuleVersionSeam,
  readSubmissionRevision as readSubmissionRevisionSeam,
} from "./form-documents";
import type { ConsumedApplicantSession, ResolvedApplicantSession } from "./applicant-access";
import {
  assertApplicantAccess as assertApplicantAccessSeam,
  CfpApplicantAccessError,
  CfpApplicantAccessFatalError,
  consumeEmailVerification as consumeEmailVerificationSeam,
  issueEmailVerification as issueEmailVerificationSeam,
  resolveApplicantSession as resolveApplicantSessionSeam,
} from "./applicant-access";
import type {
  CreateSubmissionDraftInput as CreateSubmissionDraftSeamInput,
  SaveSubmissionDraftInput as SaveSubmissionDraftSeamInput,
  SubmitSubmissionInput as SubmitSubmissionSeamInput,
  SubmittedSubmission as SubmittedSubmissionSeamResult,
} from "./submissions";
import {
  CfpSubmissionCommandError,
  CfpSubmissionCommandFatalError,
  createSubmissionDraft as createSubmissionDraftSeam,
  saveSubmissionDraft as saveSubmissionDraftSeam,
  submitSubmission as submitSubmissionSeam,
} from "./submissions";
import {
  evaluateConditionalForm,
  FORM_RULES_SCHEMA,
  normalizeFormRuleSet,
  type FormFieldState,
} from "./form-evaluator";
import { sanitizeFormData, type JsonSafeObject, type JsonSafeValue } from "./form-safety";
import {
  FORM_DOCUMENT_SCHEMA,
  normalizeFormDocument,
  type FormAnswer,
  type FormFieldDefinition,
  type NormalizedFormDocument,
} from "./form-types";

export interface LocateExternallyReachableCallInput {
  readonly workspaceSlug: string;
  readonly callSlug: string;
}

export interface PublicCallProjection {
  readonly callId: string;
  readonly name: string;
  readonly slug: string;
  readonly accessMode: "PUBLIC" | "PUBLIC_AND_INVITED";
  readonly state: "DRAFT" | "SCHEDULED" | "OPEN" | "PAUSED" | "CLOSED" | "ARCHIVED" | "CANCELLED";
  readonly timezone: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly disclosure: JsonSafeObject;
  readonly choices: readonly CallPolicyChoice[];
  readonly fields: readonly FormFieldDefinition[];
}

export type LocateExternallyReachableCallResult =
  | { readonly available: false }
  | { readonly available: true; readonly call: PublicCallProjection };

export interface RequestApplicantEmailVerificationInput {
  readonly workspaceId: string;
  readonly callId: string;
  readonly email: string;
  readonly tokenHash: string;
}

export type ApplicantEmailVerificationDeliveryCandidate =
  | { readonly accepted: false }
  | {
      readonly accepted: true;
      readonly verificationId: string;
      readonly expiresAt: string;
    };

export interface ConsumeApplicantEmailVerificationInput {
  readonly workspaceId: string;
  readonly callId: string;
  readonly verificationId: string;
  readonly verificationTokenHash: string;
  readonly applicantSessionTokenHash: string;
  readonly fullName: string;
}

export interface ConsumedApplicantSessionResult {
  readonly success: true;
  readonly expiresAt: string;
}

export interface ReadApplicantOwnedCurrentRevisionInput {
  readonly workspaceId: string;
  readonly callId: string;
  readonly sessionTokenHash: string;
  readonly submissionId: string;
}

export interface ApplicantDraftCallInfo {
  readonly callId: string;
  readonly name: string;
  readonly slug: string;
  readonly accessMode: "PUBLIC" | "INVITED" | "PUBLIC_AND_INVITED";
  readonly state: "DRAFT" | "SCHEDULED" | "OPEN" | "PAUSED" | "CLOSED" | "ARCHIVED" | "CANCELLED";
  readonly timezone: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
}

export interface ApplicantDraftPresentationState {
  readonly fieldStates: readonly FormFieldState[];
  readonly hiddenFieldIds: readonly string[];
  readonly disabledFieldIds: readonly string[];
  readonly requiredFieldIds: readonly string[];
  readonly skippedFieldIds: readonly string[];
}

export interface ApplicantDraftProjection {
  readonly call: ApplicantDraftCallInfo;
  readonly submissionId: string;
  readonly submissionState: "DRAFT" | "SUBMITTED" | "WITHDRAWN" | "INVALIDATED";
  readonly currentRevisionId: string;
  readonly fields: readonly FormFieldDefinition[];
  readonly historicalAnswers: readonly FormAnswer[];
  readonly effectiveAnswers: readonly FormAnswer[];
  readonly presentationState: ApplicantDraftPresentationState;
  readonly disclosure: JsonSafeObject;
  readonly choices: readonly CallPolicyChoice[];
  readonly hasConsentReceipt: boolean;
}

export type ReadApplicantOwnedCurrentRevisionResult =
  | { readonly found: false }
  | { readonly found: true; readonly draft: ApplicantDraftProjection };

export interface CreateApplicantSubmissionDraftInput {
  readonly workspaceId: string;
  readonly callId: string;
  readonly sessionTokenHash: string;
}

export type CreateSubmissionDraftInput = CreateApplicantSubmissionDraftInput;

export interface CreatedApplicantSubmissionDraftResult {
  readonly submissionId: string;
}

export interface SaveApplicantSubmissionDraftInput {
  readonly workspaceId: string;
  readonly callId: string;
  readonly sessionTokenHash: string;
  readonly submissionId: string;
  readonly historicalAnswers: unknown;
  readonly expectedCurrentRevisionId: string | null;
}

export type SaveSubmissionDraftInput = SaveApplicantSubmissionDraftInput;

export interface SavedApplicantSubmissionDraftResult {
  readonly submissionId: string;
  readonly revisionId: string;
  readonly hasConsentReceipt: boolean;
}

export interface SubmitApplicantSubmissionInput {
  readonly workspaceId: string;
  readonly callId: string;
  readonly sessionTokenHash: string;
  readonly submissionId: string;
  readonly historicalAnswers: unknown;
  readonly expectedCurrentRevisionId: string | null;
}

export type SubmitSubmissionInput = SubmitApplicantSubmissionInput;

export interface SubmittedApplicantSubmissionResult {
  readonly submissionId: string;
  readonly revisionId: string;
  readonly submittedAt: string;
}

export type CfpApplicantPortalErrorCode =
  | "PORTAL_INPUT_INVALID"
  | "CALL_NOT_AVAILABLE"
  | "SUBMISSION_NOT_FOUND"
  | "SUBMISSION_NOT_DRAFT"
  | "SUBMISSION_STALE"
  | "SUBMISSION_INCOMPLETE"
  | "SESSION_INVALID"
  | "PORTAL_READ_FAILED"
  | "PORTAL_WRITE_FAILED"
  | "PORTAL_WRITE_INDETERMINATE";

const PORTAL_ERROR_MESSAGES: Record<CfpApplicantPortalErrorCode, string> = Object.freeze({
  PORTAL_INPUT_INVALID: "The CFP applicant portal input is invalid.",
  CALL_NOT_AVAILABLE: "The CFP call is not available.",
  SUBMISSION_NOT_FOUND: "The CFP submission was not found.",
  SUBMISSION_NOT_DRAFT: "The CFP submission is not a draft.",
  SUBMISSION_STALE: "The CFP submission revision is stale.",
  SUBMISSION_INCOMPLETE: "The CFP submission is incomplete.",
  SESSION_INVALID: "The CFP applicant session is invalid.",
  PORTAL_READ_FAILED: "The CFP applicant portal read failed.",
  PORTAL_WRITE_FAILED: "The CFP applicant portal write failed.",
  PORTAL_WRITE_INDETERMINATE:
    "The CFP applicant portal command result is indeterminate; do not retry automatically.",
});

const INTERNAL_PORTAL_ERRORS = new WeakSet<object>();

export class CfpApplicantPortalError extends Error {
  readonly code: CfpApplicantPortalErrorCode;

  constructor(code: CfpApplicantPortalErrorCode) {
    super(PORTAL_ERROR_MESSAGES[code] ?? "The CFP applicant portal operation failed.");
    this.name = "CfpApplicantPortalError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
    INTERNAL_PORTAL_ERRORS.add(this);
  }
}

const PORTAL_FATAL_MESSAGE =
  "The CFP applicant portal boundary could not prove transaction cleanup; stop using this database connection.";

export class CfpApplicantPortalFatalError extends Error {
  readonly fatal = true;

  constructor() {
    super(PORTAL_FATAL_MESSAGE);
    this.name = "CfpApplicantPortalFatalError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CfpApplicantPortalOptions {
  readonly readCall?: typeof readCallSeam;
  readonly readFormVersionDocument?: typeof readFormVersionDocumentSeam;
  readonly readRuleVersion?: typeof readRuleVersionSeam;
  readonly readSubmissionRevision?: typeof readSubmissionRevisionSeam;
  readonly issueEmailVerification?: typeof issueEmailVerificationSeam;
  readonly consumeEmailVerification?: typeof consumeEmailVerificationSeam;
  readonly resolveApplicantSession?: typeof resolveApplicantSessionSeam;
  readonly assertApplicantAccess?: typeof assertApplicantAccessSeam;
  readonly createSubmissionDraft?: typeof createSubmissionDraftSeam;
  readonly saveSubmissionDraft?: typeof saveSubmissionDraftSeam;
  readonly submitSubmission?: typeof submitSubmissionSeam;
}

export interface CfpApplicantPortal {
  locateExternallyReachableCall(
    db: Db,
    input: LocateExternallyReachableCallInput,
  ): LocateExternallyReachableCallResult;

  requestApplicantEmailVerification(
    db: Db,
    input: RequestApplicantEmailVerificationInput,
  ): { readonly success: true };

  issueApplicantEmailVerificationForDelivery(
    db: Db,
    input: RequestApplicantEmailVerificationInput,
  ): ApplicantEmailVerificationDeliveryCandidate;

  consumeApplicantEmailVerification(
    db: Db,
    input: ConsumeApplicantEmailVerificationInput,
  ): ConsumedApplicantSessionResult;

  readApplicantOwnedCurrentRevision(
    db: Db,
    input: ReadApplicantOwnedCurrentRevisionInput,
  ): ReadApplicantOwnedCurrentRevisionResult;

  createApplicantSubmissionDraft(
    db: Db,
    input: CreateApplicantSubmissionDraftInput,
  ): CreatedApplicantSubmissionDraftResult;

  saveApplicantSubmissionDraft(
    db: Db,
    input: SaveApplicantSubmissionDraftInput,
  ): SavedApplicantSubmissionDraftResult;

  submitApplicantSubmission(
    db: Db,
    input: SubmitApplicantSubmissionInput,
  ): SubmittedApplicantSubmissionResult;
}

const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const OWNED_SAVEPOINT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const CONSENT_FIELD_TYPES = new Set(["consent", "acknowledgement", "policyAcceptance"]);

function requireOwnedSavepointName(name: string): void {
  if (!OWNED_SAVEPOINT_NAME_PATTERN.test(name)) {
    throw new CfpApplicantPortalFatalError();
  }
}

function createOwnedSavepointName(prefix: string): string {
  requireOwnedSavepointName(prefix);
  const ownedName = `${prefix}_${uuid().replaceAll("-", "")}`;
  requireOwnedSavepointName(ownedName);
  return ownedName;
}

type PortalControlOutcome = "missing" | "returned" | "failed";

function isMissingPortalSavepoint(error: unknown, name: string): boolean {
  try {
    if (utilTypes.isProxy(error as object) || !utilTypes.isNativeError(error)) return false;
    const code = Object.getOwnPropertyDescriptor(error, "code");
    const message = Object.getOwnPropertyDescriptor(error, "message");
    return (
      code !== undefined &&
      "value" in code &&
      code.value === "ERR_SQLITE_ERROR" &&
      message !== undefined &&
      "value" in message &&
      message.value === `no such savepoint: ${name}`
    );
  } catch {
    return false;
  }
}

function attemptPortalControl(
  db: Db,
  method: "exec" | "prepare",
  sql: string,
  name: string,
): PortalControlOutcome {
  try {
    if (method === "exec") db.exec(sql);
    else db.prepare(sql).run();
    return "returned";
  } catch (error) {
    return isMissingPortalSavepoint(error, name) ? "missing" : "failed";
  }
}

function provePortalSavepointReleased(db: Db, name: string): void {
  const sql = `RELEASE SAVEPOINT "${name}"`;
  for (const method of ["exec", "prepare"] as const) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = attemptPortalControl(db, method, sql, name);
      if (outcome === "missing") return;
    }
  }
  throw new CfpApplicantPortalFatalError();
}

function rollbackAndClosePortalSavepoint(db: Db, name: string): "closed" | "missing" {
  const sql = `ROLLBACK TO SAVEPOINT "${name}"`;
  for (const method of ["exec", "prepare"] as const) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = attemptPortalControl(db, method, sql, name);
      if (outcome === "missing") return "missing";
      if (outcome === "returned") {
        provePortalSavepointReleased(db, name);
        return "closed";
      }
    }
  }
  throw new CfpApplicantPortalFatalError();
}

function withPortalReadSavepoint<T>(db: Db, baseName: string, fn: () => T): T {
  const ownedName = createOwnedSavepointName(baseName);

  try {
    db.exec(`SAVEPOINT "${ownedName}"`);
  } catch {
    rollbackAndClosePortalSavepoint(db, ownedName);
    throw new CfpApplicantPortalError("PORTAL_READ_FAILED");
  }

  let result: T;
  let fnError: unknown = null;
  let fnThrew = false;

  try {
    result = fn();
  } catch (err) {
    fnThrew = true;
    fnError = err;
  }

  if (!fnThrew) {
    provePortalSavepointReleased(db, ownedName);
    return result!;
  } else {
    rollbackAndClosePortalSavepoint(db, ownedName);
    throw fnError;
  }
}

function detachPortalJson<T>(value: T, errorCode: "PORTAL_INPUT_INVALID" | "PORTAL_READ_FAILED"): T {
  try {
    return sanitizeFormData(value) as unknown as T;
  } catch {
    throw new CfpApplicantPortalError(errorCode);
  }
}

function snapshotDependencyResult(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function isValidIdentifier(val: unknown, maxLen = 128): val is string {
  return (
    typeof val === "string" &&
    val.length > 0 &&
    val.length <= maxLen &&
    !CONTROL_CHAR_PATTERN.test(val) &&
    IDENTIFIER_PATTERN.test(val)
  );
}

function isValidSlug(val: unknown): val is string {
  return typeof val === "string" && val.length > 0 && val.length <= 128 && SLUG_PATTERN.test(val);
}

function isValidEmail(val: unknown): val is string {
  return (
    typeof val === "string" &&
    val.length > 0 &&
    val.length <= 320 &&
    !CONTROL_CHAR_PATTERN.test(val) &&
    val.includes("@")
  );
}

function isValidTokenHash(val: unknown): val is string {
  return typeof val === "string" && TOKEN_HASH_PATTERN.test(val);
}

function isValidFullName(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  return trimmed.length > 0 && val.length <= 128 && !CONTROL_CHAR_PATTERN.test(val);
}

function isValidIsoTimestamp(val: unknown): val is string {
  if (typeof val !== "string" || val.length === 0 || val.length > 128) return false;
  const parsed = Date.parse(val);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === val;
}

function isValidTimezone(val: unknown): val is string {
  if (typeof val !== "string" || val.length === 0 || val.length > 128) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: val }).format();
    return true;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactRecordKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  try {
    const actual = Reflect.ownKeys(value);
    return (
      actual.length === keys.length &&
      actual.every((key) => typeof key === "string" && keys.includes(key))
    );
  } catch {
    return false;
  }
}

const POLICY_ENVELOPE_KEYS = [
  "schema",
  "policyVersionId",
  "disclosure",
  "choices",
  "fingerprintAlgorithm",
  "fingerprint",
] as const;
const DISCLOSURE_KEYS = [
  "privacy",
  "retention",
  "aiProcessing",
  "communication",
  "consent",
  "publication",
] as const;
const CALL_ENVELOPE_KEYS = [
  "id",
  "workspaceId",
  "eventId",
  "formVersionId",
  "accessMode",
  "state",
  "timezone",
  "opensAt",
  "closesAt",
  ...POLICY_ENVELOPE_KEYS,
  "policy",
] as const;
const FORM_DOCUMENT_ENVELOPE_KEYS = [
  "schema",
  "formVersionId",
  "ruleVersionId",
  "fields",
  "historicalAnswers",
  "effectiveAnswers",
  "fingerprint",
] as const;
const REVISION_ENVELOPE_KEYS = [
  "schema",
  "submissionId",
  "revisionNumber",
  "formDocument",
  "callPolicy",
  "consentReceipt",
  "fingerprintAlgorithm",
  "fingerprint",
] as const;
const RULE_VERSION_ENVELOPE_KEYS = [
  "id",
  "workspaceId",
  "formDefinitionId",
  "versionNumber",
  "schema",
  "rules",
  "fingerprintAlgorithm",
  "fingerprint",
  "sealedBy",
  "sealedAt",
] as const;

function normalizePolicyEnvelope(
  value: unknown,
  fields?: readonly FormFieldDefinition[],
): CallPolicySnapshot | null {
  try {
    if (!isPlainRecord(value) || !hasExactRecordKeys(value, POLICY_ENVELOPE_KEYS)) {
      return null;
    }
    const schema = value.schema;
    const policyVersionId = value.policyVersionId;
    const disclosure = value.disclosure;
    const choices = value.choices;
    if (
      schema !== CFP_CALL_POLICY_SCHEMA ||
      !isValidIdentifier(policyVersionId) ||
      !isPlainRecord(disclosure) ||
      !hasExactRecordKeys(disclosure, DISCLOSURE_KEYS) ||
      !Array.isArray(choices) ||
      choices.length > 256 ||
      value.fingerprintAlgorithm !== CFP_FINGERPRINT_ALGORITHM ||
      typeof value.fingerprint !== "string" ||
      !TOKEN_HASH_PATTERN.test(value.fingerprint)
    ) {
      return null;
    }

    const seen = new Set<string>();
    const fieldsById = fields ? new Map(fields.map((field) => [field.id, field])) : null;
    if (fields && choices.length > fields.length) return null;
    for (const choice of choices) {
      if (!isPlainRecord(choice) || !hasExactRecordKeys(choice, ["fieldId", "statement", "required"])) {
        return null;
      }
      if (
        !isValidIdentifier(choice.fieldId) ||
        seen.has(choice.fieldId) ||
        typeof choice.statement !== "string" ||
        choice.statement.trim().length === 0 ||
        Buffer.byteLength(choice.statement, "utf8") > 8 * 1024 ||
        CONTROL_CHAR_PATTERN.test(choice.statement) ||
        typeof choice.required !== "boolean"
      ) {
        return null;
      }
      const field = fieldsById?.get(choice.fieldId);
      if (fieldsById && (!field || !CONSENT_FIELD_TYPES.has(field.type))) {
        return null;
      }
      seen.add(choice.fieldId);
    }

    const fingerprint = fingerprintOf({ schema, policyVersionId, disclosure, choices });
    if (fingerprint !== value.fingerprint) return null;
    return value as unknown as CallPolicySnapshot;
  } catch {
    return null;
  }
}

function normalizeCallEnvelope(
  value: unknown,
  workspaceId: string,
  callId: string,
  fields?: readonly FormFieldDefinition[],
): CallReadModel | null {
  try {
    if (!isPlainRecord(value) || !hasExactRecordKeys(value, CALL_ENVELOPE_KEYS)) return null;
    const policy = normalizePolicyEnvelope(value.policy, fields);
    if (
      !policy ||
      value.id !== callId ||
      value.workspaceId !== workspaceId ||
      !isValidIdentifier(value.eventId) ||
      !isValidIdentifier(value.formVersionId) ||
      typeof value.accessMode !== "string" ||
      !["PUBLIC", "INVITED", "PUBLIC_AND_INVITED"].includes(value.accessMode) ||
      typeof value.state !== "string" ||
      !["DRAFT", "SCHEDULED", "OPEN", "PAUSED", "CLOSED", "ARCHIVED", "CANCELLED"].includes(
        value.state,
      ) ||
      !isValidTimezone(value.timezone) ||
      (value.opensAt !== null && !isValidIsoTimestamp(value.opensAt)) ||
      (value.closesAt !== null && !isValidIsoTimestamp(value.closesAt)) ||
      (value.opensAt !== null &&
        value.closesAt !== null &&
        Date.parse(value.opensAt as string) > Date.parse(value.closesAt as string)) ||
      value.schema !== policy.schema ||
      value.policyVersionId !== policy.policyVersionId ||
      value.fingerprintAlgorithm !== policy.fingerprintAlgorithm ||
      value.fingerprint !== policy.fingerprint ||
      canonicalJson(value.disclosure) !== canonicalJson(policy.disclosure) ||
      canonicalJson(value.choices) !== canonicalJson(policy.choices)
    ) {
      return null;
    }
    return value as unknown as CallReadModel;
  } catch {
    return null;
  }
}

function normalizeFormEnvelope(
  value: unknown,
  expectedFormVersionId?: string,
  expectedRuleVersionId?: string,
  requireTemplate = false,
): NormalizedFormDocument | null {
  try {
    if (!isPlainRecord(value) || !hasExactRecordKeys(value, FORM_DOCUMENT_ENVELOPE_KEYS)) {
      return null;
    }
    if (value.schema !== FORM_DOCUMENT_SCHEMA) return null;
    const normalized = normalizeFormDocument(value);
    if (
      canonicalJson(normalized) !== canonicalJson(value) ||
      (expectedFormVersionId !== undefined && normalized.formVersionId !== expectedFormVersionId) ||
      (expectedRuleVersionId !== undefined && normalized.ruleVersionId !== expectedRuleVersionId) ||
      (requireTemplate &&
        (normalized.historicalAnswers.length !== 0 || normalized.effectiveAnswers.length !== 0))
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function projectPublicFormFields(
  fields: readonly FormFieldDefinition[],
): readonly FormFieldDefinition[] {
  return Object.freeze(
    fields.map((field) =>
      Object.freeze(
        Object.prototype.hasOwnProperty.call(field, "config")
          ? {
              id: field.id,
              type: field.type,
              label: field.label,
              required: field.required,
              defaultVisibility: field.defaultVisibility,
              config: field.config,
            }
          : {
              id: field.id,
              type: field.type,
              label: field.label,
              required: field.required,
              defaultVisibility: field.defaultVisibility,
            },
      ),
    ),
  );
}

function normalizeRuleVersionEnvelope(
  value: unknown,
  workspaceId: string,
  ruleVersionId: string,
  fields: readonly FormFieldDefinition[],
): NormalizedRuleVersion | null {
  try {
    if (!isPlainRecord(value) || !hasExactRecordKeys(value, RULE_VERSION_ENVELOPE_KEYS)) {
      return null;
    }
    if (
      value.id !== ruleVersionId ||
      value.workspaceId !== workspaceId ||
      !isValidIdentifier(value.formDefinitionId) ||
      typeof value.versionNumber !== "number" ||
      !Number.isSafeInteger(value.versionNumber) ||
      value.versionNumber < 1 ||
      value.schema !== FORM_RULES_SCHEMA ||
      value.fingerprintAlgorithm !== CFP_FINGERPRINT_ALGORITHM ||
      typeof value.fingerprint !== "string" ||
      !TOKEN_HASH_PATTERN.test(value.fingerprint) ||
      !isValidIdentifier(value.sealedBy) ||
      !isValidIsoTimestamp(value.sealedAt)
    ) {
      return null;
    }
    const rules = normalizeFormRuleSet(value.rules, fields);
    if (
      rules.ruleVersionId !== ruleVersionId ||
      canonicalJson(rules) !== canonicalJson(value.rules) ||
      fingerprintOf(rules) !== value.fingerprint
    ) {
      return null;
    }
    return value as unknown as NormalizedRuleVersion;
  } catch {
    return null;
  }
}

function isValidConsentReceiptEnvelope(
  value: unknown,
  policy: CallPolicySnapshot,
  formDocument: NormalizedFormDocument,
  expectedSubmissionId: string,
  expectedPersonId?: string,
  expectedSessionId?: string,
): boolean {
  try {
    const effective = new Map(formDocument.effectiveAnswers.map((answer) => [answer.fieldId, answer.value]));
    const expectedValues = policy.choices.map((choice) => effective.get(choice.fieldId));
    const receiptExpected = expectedValues.every((candidate) => typeof candidate === "boolean");
    if (value === null) return !receiptExpected;
    if (!receiptExpected || !isPlainRecord(value)) return false;
    if (
      !hasExactRecordKeys(value, [
        "schema",
        "submissionId",
        "personId",
        "applicantSessionId",
        "receivedAt",
        "policyFingerprint",
        "choices",
      ]) ||
      value.schema !== CFP_CONSENT_RECEIPT_SCHEMA ||
      value.submissionId !== expectedSubmissionId ||
      !isValidIdentifier(value.personId) ||
      !isValidIdentifier(value.applicantSessionId) ||
      (expectedPersonId !== undefined && value.personId !== expectedPersonId) ||
      (expectedSessionId !== undefined && value.applicantSessionId !== expectedSessionId) ||
      !isValidIsoTimestamp(value.receivedAt) ||
      value.policyFingerprint !== policy.fingerprint ||
      !Array.isArray(value.choices) ||
      value.choices.length !== policy.choices.length
    ) {
      return false;
    }
    return value.choices.every((choice, index) => {
      const expectedChoice = policy.choices[index];
      return (
        isPlainRecord(choice) &&
        hasExactRecordKeys(choice, ["fieldId", "value"]) &&
        choice.fieldId === expectedChoice?.fieldId &&
        choice.value === expectedValues[index]
      );
    });
  } catch {
    return false;
  }
}

type RevisionEnvelopeExpectation = {
  readonly submissionId: string;
  readonly formVersionId?: string;
  readonly ruleVersionId?: string;
  readonly personId?: string;
  readonly sessionId?: string;
};

function normalizeSubmissionRevisionEnvelope(
  value: unknown,
  expected: RevisionEnvelopeExpectation,
): SubmissionRevision | null {
  try {
    if (!isPlainRecord(value) || !hasExactRecordKeys(value, REVISION_ENVELOPE_KEYS)) {
      return null;
    }
    const formDocument = normalizeFormEnvelope(
      value.formDocument,
      expected.formVersionId,
      expected.ruleVersionId,
    );
    const callPolicy = formDocument
      ? normalizePolicyEnvelope(value.callPolicy, formDocument.fields)
      : null;
    if (
      !formDocument ||
      !callPolicy ||
      value.schema !== CFP_SUBMISSION_REVISION_SCHEMA ||
      value.submissionId !== expected.submissionId ||
      typeof value.revisionNumber !== "number" ||
      !Number.isSafeInteger(value.revisionNumber) ||
      value.revisionNumber < 1 ||
      value.fingerprintAlgorithm !== CFP_FINGERPRINT_ALGORITHM ||
      typeof value.fingerprint !== "string" ||
      !TOKEN_HASH_PATTERN.test(value.fingerprint) ||
      !isValidConsentReceiptEnvelope(
        value.consentReceipt,
        callPolicy,
        formDocument,
        expected.submissionId,
        expected.personId,
        expected.sessionId,
      )
    ) {
      return null;
    }
    const content = {
      schema: CFP_SUBMISSION_REVISION_SCHEMA,
      submissionId: expected.submissionId,
      revisionNumber: value.revisionNumber,
      formDocument,
      callPolicy,
      consentReceipt: value.consentReceipt,
      fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
    };
    if (fingerprintOf(content) !== value.fingerprint) return null;
    return value as unknown as SubmissionRevision;
  } catch {
    return null;
  }
}

function snapshotInputObject<T extends object>(
  input: unknown,
  allowedKeys: readonly (keyof T & string)[],
): T {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
  }

  let proto: unknown;
  try {
    proto = Object.getPrototypeOf(input);
  } catch {
    throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
  }
  if (proto !== Object.prototype && proto !== null) {
    throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
  }

  let ownKeys: (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(input);
  } catch {
    throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
  }

  const allowedSet = new Set<string | symbol>(allowedKeys);
  for (const k of ownKeys) {
    if (typeof k !== "string" || !allowedSet.has(k)) {
      throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
    }
  }

  const snapshot = {} as Record<string, unknown>;
  try {
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        snapshot[key] = (input as Record<string, unknown>)[key];
      }
    }
  } catch {
    throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
  }

  return Object.freeze(snapshot) as T;
}

function safeSnapshotLocateInput(input: unknown): LocateExternallyReachableCallInput | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return null;
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(input);
    const allowedSet = new Set<string | symbol>(["workspaceSlug", "callSlug"]);
    for (const k of ownKeys) {
      if (typeof k !== "string" || !allowedSet.has(k)) {
        return null;
      }
    }
    const workspaceSlug = (input as Record<string, unknown>).workspaceSlug;
    const callSlug = (input as Record<string, unknown>).callSlug;
    if (typeof workspaceSlug !== "string" || typeof callSlug !== "string") {
      return null;
    }
    return Object.freeze({ workspaceSlug, callSlug });
  } catch {
    return null;
  }
}

function safeIsApplicantPortalError(err: unknown): err is CfpApplicantPortalError {
  try {
    return (
      isExactNativeError(
        err,
        CfpApplicantPortalError.prototype,
        "CfpApplicantPortalError",
      ) &&
      INTERNAL_PORTAL_ERRORS.has(err)
    );
  } catch {
    return false;
  }
}

function hasExactOwnDataValue(
  value: object,
  key: string,
  predicate: (candidate: unknown) => boolean,
  enumerable: boolean,
  frozen: boolean,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.enumerable === enumerable &&
    descriptor.configurable === !frozen &&
    descriptor.writable === !frozen &&
    predicate(descriptor.value)
  );
}

function hasExactOwnNativeStack(value: object, frozen: boolean): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, "stack");
  if (
    descriptor === undefined ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== !frozen
  ) {
    return false;
  }
  if ("value" in descriptor) {
    return descriptor.writable === !frozen && typeof descriptor.value === "string";
  }
  return (
    typeof descriptor.get === "function" &&
    (descriptor.set === undefined || typeof descriptor.set === "function")
  );
}

function isExactNativeError(value: unknown, prototype: object, name: string): value is Error {
  try {
    const frozen = typeof value === "object" && value !== null && Object.isFrozen(value);
    return (
      typeof value === "object" &&
      value !== null &&
      !utilTypes.isProxy(value) &&
      utilTypes.isNativeError(value) &&
      Object.getPrototypeOf(value) === prototype &&
      hasExactOwnDataValue(value, "name", (candidate) => candidate === name, true, frozen) &&
      hasExactOwnDataValue(
        value,
        "message",
        (candidate) => typeof candidate === "string",
        false,
        frozen,
      ) &&
      hasExactOwnNativeStack(value, frozen)
    );
  } catch {
    return false;
  }
}

function safeIsPortalFatalError(error: unknown): error is CfpApplicantPortalFatalError {
  return isExactNativeError(
    error,
    CfpApplicantPortalFatalError.prototype,
    "CfpApplicantPortalFatalError",
  );
}

function safeIsApplicantAccessFatalError(
  error: unknown,
): error is CfpApplicantAccessFatalError {
  try {
    return (
      isExactNativeError(
        error,
        CfpApplicantAccessFatalError.prototype,
        "CfpApplicantAccessFatalError",
      ) &&
      Object.isFrozen(error) &&
      hasExactOwnDataValue(error, "fatal", (candidate) => candidate === true, true, true)
    );
  } catch {
    return false;
  }
}

function safeIsSubmissionFatalError(error: unknown): error is CfpSubmissionCommandFatalError {
  try {
    return (
      isExactNativeError(
        error,
        CfpSubmissionCommandFatalError.prototype,
        "CfpSubmissionCommandFatalError",
      ) &&
      Object.isFrozen(error) &&
      hasExactOwnDataValue(error, "fatal", (candidate) => candidate === true, true, true)
    );
  } catch {
    return false;
  }
}

function safeGetExactErrorCode(err: unknown): string | null {
  try {
    if (!err || (typeof err !== "object" && typeof err !== "function")) return null;
    if (utilTypes.isProxy(err as object)) return null;
    if (safeIsApplicantPortalError(err)) {
      const descriptor = Object.getOwnPropertyDescriptor(err, "code");
      return hasExactOwnDataValue(
        err,
        "code",
        (candidate) => typeof candidate === "string",
        true,
        Object.isFrozen(err),
      ) &&
        descriptor &&
        "value" in descriptor
        ? (descriptor.value as string)
        : null;
    }
    const recognized =
      isExactNativeError(err, CfpApplicantAccessError.prototype, "CfpApplicantAccessError") ||
      isExactNativeError(err, CfpSubmissionCommandError.prototype, "CfpSubmissionCommandError") ||
      isExactNativeError(
        err,
        FormDocumentPersistenceError.prototype,
        "FormDocumentPersistenceError",
      );
    if (!recognized) return null;
    const descriptor = Object.getOwnPropertyDescriptor(err, "code");
    return hasExactOwnDataValue(
      err,
      "code",
      (candidate) => typeof candidate === "string",
      true,
      Object.isFrozen(err),
    ) &&
      descriptor &&
      "value" in descriptor
      ? (descriptor.value as string)
      : null;
  } catch {
    return null;
  }
}

function safeGetPortalErrorCode(err: unknown): CfpApplicantPortalErrorCode | null {
  if (!safeIsApplicantPortalError(err)) return null;
  const code = safeGetExactErrorCode(err);
  return code && Object.prototype.hasOwnProperty.call(PORTAL_ERROR_MESSAGES, code)
    ? (code as CfpApplicantPortalErrorCode)
    : null;
}

function mapAccessError(err: unknown): CfpApplicantPortalError {
  const portalCode = safeGetPortalErrorCode(err);
  if (portalCode) {
    return new CfpApplicantPortalError(portalCode);
  }

  const code = safeGetExactErrorCode(err);
  if (code) {
    switch (code) {
      case "SESSION_INVALID":
        return new CfpApplicantPortalError("SESSION_INVALID");
      case "CALL_NOT_AVAILABLE":
      case "CALL_NOT_ACCEPTING":
      case "CALL_STATE_INVALID":
      case "CALL_STATE_STALE":
        return new CfpApplicantPortalError("CALL_NOT_AVAILABLE");
      case "ACCESS_INPUT_INVALID":
      case "VERIFICATION_INVALID":
      case "VERIFICATION_REQUEST_REJECTED":
        return new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
      case "SUBMISSION_NOT_FOUND":
        return new CfpApplicantPortalError("SUBMISSION_NOT_FOUND");
      case "SUBMISSION_NOT_DRAFT":
        return new CfpApplicantPortalError("SUBMISSION_NOT_DRAFT");
      case "SUBMISSION_STALE":
        return new CfpApplicantPortalError("SUBMISSION_STALE");
      case "SUBMISSION_INCOMPLETE":
        return new CfpApplicantPortalError("SUBMISSION_INCOMPLETE");
      case "STALE_REVISION":
        return new CfpApplicantPortalError("SUBMISSION_STALE");
      case "COMMAND_INPUT_INVALID":
      case "PERSISTENCE_INPUT_INVALID":
        return new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
    }
  }
  return new CfpApplicantPortalError("PORTAL_READ_FAILED");
}

function throwMappedWriteError(error: unknown): never {
  if (safeIsApplicantAccessFatalError(error)) {
    throw new CfpApplicantPortalFatalError();
  }
  if (safeIsSubmissionFatalError(error)) {
    throw Object.freeze(new CfpSubmissionCommandFatalError());
  }
  if (safeIsPortalFatalError(error)) {
    throw new CfpApplicantPortalFatalError();
  }
  throw mapWriteError(error);
}

function mapWriteError(err: unknown): CfpApplicantPortalError {
  try {
    const portalErr = mapAccessError(err);
    if (safeGetPortalErrorCode(portalErr) === "PORTAL_READ_FAILED") {
      return new CfpApplicantPortalError("PORTAL_WRITE_FAILED");
    }
    return portalErr;
  } catch {
    return new CfpApplicantPortalError("PORTAL_WRITE_FAILED");
  }
}

function throwPostCommandIndeterminate(): never {
  throw new CfpApplicantPortalError("PORTAL_WRITE_INDETERMINATE");
}

type InternalDeps = {
  readonly readCall: typeof readCallSeam;
  readonly readFormVersionDocument: typeof readFormVersionDocumentSeam;
  readonly readRuleVersion: typeof readRuleVersionSeam;
  readonly readSubmissionRevision: typeof readSubmissionRevisionSeam;
  readonly issueEmailVerification: typeof issueEmailVerificationSeam;
  readonly consumeEmailVerification: typeof consumeEmailVerificationSeam;
  readonly resolveApplicantSession: typeof resolveApplicantSessionSeam;
  readonly assertApplicantAccess: typeof assertApplicantAccessSeam;
  readonly createSubmissionDraft: typeof createSubmissionDraftSeam;
  readonly saveSubmissionDraft: typeof saveSubmissionDraftSeam;
  readonly submitSubmission: typeof submitSubmissionSeam;
};

function resolveDeps(options?: CfpApplicantPortalOptions): InternalDeps {
  try {
    let optionSnapshot: CfpApplicantPortalOptions | undefined;
    if (options !== undefined) {
      optionSnapshot = snapshotInputObject<CfpApplicantPortalOptions>(options, [
        "readCall",
        "readFormVersionDocument",
        "readRuleVersion",
        "readSubmissionRevision",
        "issueEmailVerification",
        "consumeEmailVerification",
        "resolveApplicantSession",
        "assertApplicantAccess",
        "createSubmissionDraft",
        "saveSubmissionDraft",
        "submitSubmission",
      ]);
    }

    const readCall = optionSnapshot?.readCall ?? readCallSeam;
    const readFormVersionDocument =
      optionSnapshot?.readFormVersionDocument ?? readFormVersionDocumentSeam;
    const readRuleVersion = optionSnapshot?.readRuleVersion ?? readRuleVersionSeam;
    const readSubmissionRevision =
      optionSnapshot?.readSubmissionRevision ?? readSubmissionRevisionSeam;
    const issueEmailVerification =
      optionSnapshot?.issueEmailVerification ?? issueEmailVerificationSeam;
    const consumeEmailVerification =
      optionSnapshot?.consumeEmailVerification ?? consumeEmailVerificationSeam;
    const resolveApplicantSession =
      optionSnapshot?.resolveApplicantSession ?? resolveApplicantSessionSeam;
    const assertApplicantAccess = optionSnapshot?.assertApplicantAccess ?? assertApplicantAccessSeam;
    const createSubmissionDraft =
      optionSnapshot?.createSubmissionDraft ?? createSubmissionDraftSeam;
    const saveSubmissionDraft = optionSnapshot?.saveSubmissionDraft ?? saveSubmissionDraftSeam;
    const submitSubmission = optionSnapshot?.submitSubmission ?? submitSubmissionSeam;

    if (
      typeof readCall !== "function" ||
      typeof readFormVersionDocument !== "function" ||
      typeof readRuleVersion !== "function" ||
      typeof readSubmissionRevision !== "function" ||
      typeof issueEmailVerification !== "function" ||
      typeof consumeEmailVerification !== "function" ||
      typeof resolveApplicantSession !== "function" ||
      typeof assertApplicantAccess !== "function" ||
      typeof createSubmissionDraft !== "function" ||
      typeof saveSubmissionDraft !== "function" ||
      typeof submitSubmission !== "function"
    ) {
      throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
    }

    return {
      readCall,
      readFormVersionDocument,
      readRuleVersion,
      readSubmissionRevision,
      issueEmailVerification,
      consumeEmailVerification,
      resolveApplicantSession,
      assertApplicantAccess,
      createSubmissionDraft,
      saveSubmissionDraft,
      submitSubmission,
    };
  } catch (err) {
    if (safeGetPortalErrorCode(err) === "PORTAL_INPUT_INVALID") {
      throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
    }
    throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
  }
}

function issueApplicantEmailVerificationForDeliveryWithDeps(
  deps: InternalDeps,
  db: Db,
  input: RequestApplicantEmailVerificationInput,
): ApplicantEmailVerificationDeliveryCandidate {
  const snapshot = snapshotInputObject<RequestApplicantEmailVerificationInput>(input, [
    "workspaceId",
    "callId",
    "email",
    "tokenHash",
  ]);

  const { workspaceId, callId, email, tokenHash } = snapshot;
  if (
    !isValidIdentifier(workspaceId) ||
    !isValidIdentifier(callId) ||
    !isValidEmail(email) ||
    !isValidTokenHash(tokenHash)
  ) {
    throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
  }

  try {
    const issued = deps.issueEmailVerification(
      db,
      Object.freeze({ workspaceId }),
      Object.freeze({ callId, email: email.trim().toLowerCase(), tokenHash }),
    );
    const issuedSnapshot = snapshotDependencyResult(issued, [
      "verificationId",
      "workspaceId",
      "callId",
      "expiresAt",
      "replayed",
    ]);
    const verificationId = issuedSnapshot?.verificationId;
    const expiresAt = issuedSnapshot?.expiresAt;
    if (
      !isValidIdentifier(verificationId) ||
      issuedSnapshot?.workspaceId !== workspaceId ||
      issuedSnapshot.callId !== callId ||
      !isValidIsoTimestamp(expiresAt) ||
      typeof issuedSnapshot.replayed !== "boolean"
    ) {
      throwPostCommandIndeterminate();
    }
    return Object.freeze({ accepted: true, verificationId, expiresAt });
  } catch (err) {
    const code = safeGetExactErrorCode(err);
    if (
      code === "VERIFICATION_REQUEST_REJECTED" ||
      code === "CALL_NOT_AVAILABLE" ||
      code === "CALL_NOT_ACCEPTING"
    ) {
      return Object.freeze({ accepted: false });
    }
    throwMappedWriteError(err);
  }
}

export function createCfpApplicantPortal(options?: CfpApplicantPortalOptions): CfpApplicantPortal {
  const deps = resolveDeps(options);

  return {
    locateExternallyReachableCall(
      db: Db,
      input: LocateExternallyReachableCallInput,
    ): LocateExternallyReachableCallResult {
      const snapshot = safeSnapshotLocateInput(input);
      if (!snapshot) {
        return Object.freeze({ available: false });
      }

      const { workspaceSlug, callSlug } = snapshot;
      if (!isValidSlug(workspaceSlug) || !isValidSlug(callSlug)) {
        return Object.freeze({ available: false });
      }

      try {
        return withPortalReadSavepoint(db, "cfp_locate_call", () => {
          const rows = db
            .prepare(
              `SELECT w.id AS workspace_id, c.id AS call_id, c.name AS call_name, c.slug AS call_slug
               FROM workspaces w
               JOIN calls c ON c.workspace_id = w.id
               WHERE w.slug = ? AND c.slug = ?`,
            )
            .all(workspaceSlug, callSlug) as Array<{
            workspace_id: unknown;
            call_id: unknown;
            call_name: unknown;
            call_slug: unknown;
          }>;

          if (rows.length !== 1) {
            return Object.freeze({ available: false });
          }

          const row = rows[0]!;
          if (
            !isValidIdentifier(row.workspace_id) ||
            !isValidIdentifier(row.call_id) ||
            typeof row.call_name !== "string" ||
            row.call_name.trim().length === 0 ||
            row.call_name.length > 256 ||
            CONTROL_CHAR_PATTERN.test(row.call_name) ||
            !isValidSlug(row.call_slug)
          ) {
            return Object.freeze({ available: false });
          }

          const workspaceId = row.workspace_id;
          const callId = row.call_id;

          const detachedCall = detachPortalJson(
            deps.readCall(db, workspaceId, callId),
            "PORTAL_READ_FAILED",
          );
          const initialCall = normalizeCallEnvelope(detachedCall, workspaceId, callId);
          if (!initialCall) {
            return Object.freeze({ available: false });
          }

          if (
            initialCall.accessMode !== "PUBLIC" &&
            initialCall.accessMode !== "PUBLIC_AND_INVITED"
          ) {
            return Object.freeze({ available: false });
          }

          if (
            initialCall.state === "DRAFT" ||
            initialCall.state === "CANCELLED" ||
            initialCall.state === "ARCHIVED"
          ) {
            return Object.freeze({ available: false });
          }

          const detachedForm = detachPortalJson(
            deps.readFormVersionDocument(db, workspaceId, initialCall.formVersionId),
            "PORTAL_READ_FAILED",
          );
          const formDoc = normalizeFormEnvelope(
            detachedForm,
            initialCall.formVersionId,
            undefined,
            true,
          );
          const call = formDoc
            ? normalizeCallEnvelope(detachedCall, workspaceId, callId, formDoc.fields)
            : null;
          if (
            !formDoc ||
            !call ||
            (call.accessMode !== "PUBLIC" && call.accessMode !== "PUBLIC_AND_INVITED")
          ) {
            return Object.freeze({ available: false });
          }

          const rawProjection: PublicCallProjection = {
            callId: call.id,
            name: row.call_name,
            slug: row.call_slug,
            accessMode: call.accessMode,
            state: call.state,
            timezone: call.timezone,
            opensAt: call.opensAt,
            closesAt: call.closesAt,
            disclosure: call.policy.disclosure,
            choices: call.policy.choices,
            fields: projectPublicFormFields(formDoc.fields),
          };

          const projection = detachPortalJson(rawProjection, "PORTAL_READ_FAILED");

          return Object.freeze({ available: true, call: projection });
        });
      } catch (err) {
        if (safeIsPortalFatalError(err)) {
          throw new CfpApplicantPortalFatalError();
        }
        if (safeGetPortalErrorCode(err) === "PORTAL_READ_FAILED") {
          throw new CfpApplicantPortalError("PORTAL_READ_FAILED");
        }
        return Object.freeze({ available: false });
      }
    },

    requestApplicantEmailVerification(
      db: Db,
      input: RequestApplicantEmailVerificationInput,
    ): { readonly success: true } {
      issueApplicantEmailVerificationForDeliveryWithDeps(deps, db, input);
      return Object.freeze({ success: true });
    },

    issueApplicantEmailVerificationForDelivery(
      db: Db,
      input: RequestApplicantEmailVerificationInput,
    ): ApplicantEmailVerificationDeliveryCandidate {
      return issueApplicantEmailVerificationForDeliveryWithDeps(deps, db, input);
    },

    consumeApplicantEmailVerification(
      db: Db,
      input: ConsumeApplicantEmailVerificationInput,
    ): ConsumedApplicantSessionResult {
      const snapshot = snapshotInputObject<ConsumeApplicantEmailVerificationInput>(input, [
        "workspaceId",
        "callId",
        "verificationId",
        "verificationTokenHash",
        "applicantSessionTokenHash",
        "fullName",
      ]);

      const {
        workspaceId,
        callId,
        verificationId,
        verificationTokenHash,
        applicantSessionTokenHash,
        fullName,
      } = snapshot;

      if (
        !isValidIdentifier(workspaceId) ||
        !isValidIdentifier(callId) ||
        !isValidIdentifier(verificationId) ||
        !isValidTokenHash(verificationTokenHash) ||
        !isValidTokenHash(applicantSessionTokenHash) ||
        !isValidFullName(fullName)
      ) {
        throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
      }

      try {
        const session = deps.consumeEmailVerification(
          db,
          Object.freeze({ workspaceId }),
          Object.freeze({
            callId,
            verificationId,
            verificationTokenHash,
            applicantSessionTokenHash,
            fullName: fullName.trim(),
          }),
        );

        const sessionSnapshot = snapshotDependencyResult(session, [
          "sessionId",
          "workspaceId",
          "callId",
          "personId",
          "expiresAt",
          "replayed",
        ]);
        const expiresAt = sessionSnapshot?.expiresAt;
        if (
          !isValidIdentifier(sessionSnapshot?.sessionId) ||
          sessionSnapshot?.workspaceId !== workspaceId ||
          sessionSnapshot.callId !== callId ||
          !isValidIdentifier(sessionSnapshot.personId) ||
          !isValidIsoTimestamp(expiresAt) ||
          typeof sessionSnapshot.replayed !== "boolean"
        ) {
          throwPostCommandIndeterminate();
        }

        return Object.freeze({
          success: true as const,
          expiresAt,
        });
      } catch (err) {
        throwMappedWriteError(err);
      }
    },

    readApplicantOwnedCurrentRevision(
      db: Db,
      input: ReadApplicantOwnedCurrentRevisionInput,
    ): ReadApplicantOwnedCurrentRevisionResult {
      const snapshot = snapshotInputObject<ReadApplicantOwnedCurrentRevisionInput>(input, [
        "workspaceId",
        "callId",
        "sessionTokenHash",
        "submissionId",
      ]);

      const { workspaceId, callId, sessionTokenHash, submissionId } = snapshot;
      if (
        !isValidIdentifier(workspaceId) ||
        !isValidIdentifier(callId) ||
        !isValidTokenHash(sessionTokenHash) ||
        !isValidIdentifier(submissionId)
      ) {
        throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
      }

      try {
        return withPortalReadSavepoint(db, "cfp_read_applicant_draft", () => {
          let session: ResolvedApplicantSession;
          try {
            session = detachPortalJson(
              deps.resolveApplicantSession(
                db,
                Object.freeze({ workspaceId, callId, sessionTokenHash }),
              ),
              "PORTAL_READ_FAILED",
            );
          } catch {
            return Object.freeze({ found: false });
          }

          if (
            !isPlainRecord(session) ||
            !hasExactRecordKeys(session, ["context", "personId", "callId", "expiresAt"]) ||
            session.callId !== callId ||
            !isPlainRecord(session.context) ||
            !hasExactRecordKeys(session.context, ["workspaceId", "sessionId"]) ||
            session.context.workspaceId !== workspaceId ||
            !isValidIdentifier(session.context.sessionId) ||
            !isValidIdentifier(session.personId) ||
            !isValidIsoTimestamp(session.expiresAt)
          ) {
            return Object.freeze({ found: false });
          }

          try {
            const grant = detachPortalJson(
              deps.assertApplicantAccess(
                db,
                Object.freeze({
                  action: "SAVE_DRAFT",
                  context: Object.freeze({
                    workspaceId,
                    sessionId: session.context.sessionId,
                  }),
                }),
              ),
              "PORTAL_READ_FAILED",
            );
            if (
              !isPlainRecord(grant) ||
              !hasExactRecordKeys(grant, ["allowed", "late", "extensionId"]) ||
              grant.allowed !== true ||
              typeof grant.late !== "boolean" ||
              (grant.extensionId !== null && !isValidIdentifier(grant.extensionId))
            ) {
              return Object.freeze({ found: false });
            }
          } catch {
            return Object.freeze({ found: false });
          }

          const rows = db
            .prepare(
              `SELECT s.id, s.workspace_id, s.call_id, s.owner_person_id, s.state, s.current_revision_id,
                      s.pinned_form_version_id, s.pinned_rule_version_id,
                      c.name AS call_name, c.slug AS call_slug, c.access_mode, c.state AS call_state,
                      c.timezone, c.opens_at, c.closes_at
               FROM submissions s
               JOIN calls c ON c.id = s.call_id AND c.workspace_id = s.workspace_id
               WHERE s.workspace_id = ? AND s.id = ?
               LIMIT 1`,
            )
            .all(workspaceId, submissionId) as Array<{
            id: unknown;
            workspace_id: unknown;
            call_id: unknown;
            owner_person_id: unknown;
            state: unknown;
            current_revision_id: unknown;
            pinned_form_version_id: unknown;
            pinned_rule_version_id: unknown;
            call_name: unknown;
            call_slug: unknown;
            access_mode: unknown;
            call_state: unknown;
            timezone: unknown;
            opens_at: unknown;
            closes_at: unknown;
          }>;

          if (rows.length !== 1) {
            return Object.freeze({ found: false });
          }

          const row = rows[0]!;

          if (
            !isValidIdentifier(row.id) ||
            row.id !== submissionId ||
            !isValidIdentifier(row.workspace_id) ||
            row.workspace_id !== workspaceId ||
            !isValidIdentifier(row.call_id) ||
            row.call_id !== callId ||
            !isValidIdentifier(row.owner_person_id) ||
            row.owner_person_id !== session.personId ||
            !isValidIdentifier(row.current_revision_id) ||
            !isValidIdentifier(row.pinned_form_version_id) ||
            !isValidIdentifier(row.pinned_rule_version_id) ||
            typeof row.state !== "string" ||
            !["DRAFT", "SUBMITTED", "WITHDRAWN", "INVALIDATED"].includes(row.state) ||
            typeof row.call_name !== "string" ||
            row.call_name.trim().length === 0 ||
            row.call_name.length > 256 ||
            CONTROL_CHAR_PATTERN.test(row.call_name) ||
            !isValidSlug(row.call_slug) ||
            typeof row.access_mode !== "string" ||
            !["PUBLIC", "INVITED", "PUBLIC_AND_INVITED"].includes(row.access_mode) ||
            typeof row.call_state !== "string" ||
            !["DRAFT", "SCHEDULED", "OPEN", "PAUSED", "CLOSED", "ARCHIVED", "CANCELLED"].includes(row.call_state) ||
            !isValidTimezone(row.timezone) ||
            (row.opens_at !== null && !isValidIsoTimestamp(row.opens_at)) ||
            (row.closes_at !== null && !isValidIsoTimestamp(row.closes_at))
          ) {
            return Object.freeze({ found: false });
          }

          const capturedPointer = row.current_revision_id;
          const pinnedFormVersionId = row.pinned_form_version_id;
          const pinnedRuleVersionId = row.pinned_rule_version_id;

          let revision: SubmissionRevision;
          let call: CallReadModel;
          let ruleVersion: NormalizedRuleVersion;

          try {
            const detachedRevision = detachPortalJson(
              deps.readSubmissionRevision(db, workspaceId, capturedPointer),
              "PORTAL_READ_FAILED",
            );
            const normalizedRevision = normalizeSubmissionRevisionEnvelope(detachedRevision, {
              submissionId,
              formVersionId: pinnedFormVersionId,
              ruleVersionId: pinnedRuleVersionId,
              personId: session.personId,
            });
            if (!normalizedRevision) {
              return Object.freeze({ found: false });
            }
            revision = normalizedRevision;

            const detachedPinnedForm = detachPortalJson(
              deps.readFormVersionDocument(db, workspaceId, pinnedFormVersionId),
              "PORTAL_READ_FAILED",
            );
            const pinnedForm = normalizeFormEnvelope(
              detachedPinnedForm,
              pinnedFormVersionId,
              pinnedRuleVersionId,
              true,
            );
            if (
              !pinnedForm ||
              canonicalJson(pinnedForm.fields) !== canonicalJson(revision.formDocument.fields)
            ) {
              return Object.freeze({ found: false });
            }

            const detachedRule = detachPortalJson(
              deps.readRuleVersion(db, workspaceId, pinnedRuleVersionId),
              "PORTAL_READ_FAILED",
            );
            const normalizedRule = normalizeRuleVersionEnvelope(
              detachedRule,
              workspaceId,
              pinnedRuleVersionId,
              pinnedForm.fields,
            );
            if (!normalizedRule) {
              return Object.freeze({ found: false });
            }
            ruleVersion = normalizedRule;

            const detachedCall = detachPortalJson(
              deps.readCall(db, workspaceId, callId),
              "PORTAL_READ_FAILED",
            );
            const initialCall = normalizeCallEnvelope(detachedCall, workspaceId, callId);
            if (!initialCall) {
              return Object.freeze({ found: false });
            }

            let currentCallForm = pinnedForm;
            if (initialCall.formVersionId !== pinnedFormVersionId) {
              const detachedCurrentForm = detachPortalJson(
                deps.readFormVersionDocument(db, workspaceId, initialCall.formVersionId),
                "PORTAL_READ_FAILED",
              );
              const normalizedCurrentForm = normalizeFormEnvelope(
                detachedCurrentForm,
                initialCall.formVersionId,
                undefined,
                true,
              );
              if (!normalizedCurrentForm) {
                return Object.freeze({ found: false });
              }
              currentCallForm = normalizedCurrentForm;
            }

            const normalizedCall = normalizeCallEnvelope(
              detachedCall,
              workspaceId,
              callId,
              currentCallForm.fields,
            );
            if (
              !normalizedCall ||
              row.access_mode !== normalizedCall.accessMode ||
              row.call_state !== normalizedCall.state ||
              row.timezone !== normalizedCall.timezone ||
              row.opens_at !== normalizedCall.opensAt ||
              row.closes_at !== normalizedCall.closesAt
            ) {
              return Object.freeze({ found: false });
            }
            call = normalizedCall;
          } catch {
            return Object.freeze({ found: false });
          }

          const recheckRows = db
            .prepare(
              `SELECT workspace_id, call_id, owner_person_id, current_revision_id, state,
                      pinned_form_version_id, pinned_rule_version_id
               FROM submissions
               WHERE workspace_id = ? AND id = ?
               LIMIT 1`,
            )
            .all(workspaceId, submissionId) as Array<{
            workspace_id: unknown;
            call_id: unknown;
            owner_person_id: unknown;
            current_revision_id: unknown;
            state: unknown;
            pinned_form_version_id: unknown;
            pinned_rule_version_id: unknown;
          }>;

          if (recheckRows.length !== 1) {
            return Object.freeze({ found: false });
          }

          const recheck = recheckRows[0]!;
          if (
            recheck.workspace_id !== workspaceId ||
            recheck.call_id !== callId ||
            recheck.owner_person_id !== session.personId ||
            recheck.current_revision_id !== capturedPointer ||
            recheck.state !== row.state ||
            recheck.pinned_form_version_id !== pinnedFormVersionId ||
            recheck.pinned_rule_version_id !== pinnedRuleVersionId
          ) {
            return Object.freeze({ found: false });
          }

          const evaluation = evaluateConditionalForm({
            fields: revision.formDocument.fields,
            historicalAnswers: revision.formDocument.historicalAnswers,
            ruleSet: ruleVersion.rules,
          });

          if (
            canonicalJson(evaluation.effectiveAnswers) !==
            canonicalJson(revision.formDocument.effectiveAnswers)
          ) {
            return Object.freeze({ found: false });
          }

          const rawDraft: ApplicantDraftProjection = {
            call: {
              callId: call.id,
              name: row.call_name,
              slug: row.call_slug,
              accessMode: call.accessMode,
              state: call.state,
              timezone: call.timezone,
              opensAt: call.opensAt,
              closesAt: call.closesAt,
            },
            submissionId: row.id,
            submissionState: row.state as ApplicantDraftProjection["submissionState"],
            currentRevisionId: capturedPointer,
            fields: projectPublicFormFields(revision.formDocument.fields),
            historicalAnswers: revision.formDocument.historicalAnswers,
            effectiveAnswers: evaluation.effectiveAnswers,
            presentationState: {
              fieldStates: evaluation.fieldStates,
              hiddenFieldIds: evaluation.hiddenFieldIds,
              disabledFieldIds: evaluation.disabledFieldIds,
              requiredFieldIds: evaluation.requiredFieldIds,
              skippedFieldIds: evaluation.skippedFieldIds,
            },
            disclosure: revision.callPolicy.disclosure,
            choices: revision.callPolicy.choices,
            hasConsentReceipt: revision.consentReceipt !== null,
          };

          const draft = detachPortalJson(rawDraft, "PORTAL_READ_FAILED");

          return Object.freeze({ found: true, draft });
        });
      } catch (err) {
        if (safeIsPortalFatalError(err)) {
          throw new CfpApplicantPortalFatalError();
        }
        throw mapAccessError(err);
      }
    },

    createApplicantSubmissionDraft(
      db: Db,
      input: CreateApplicantSubmissionDraftInput,
    ): CreatedApplicantSubmissionDraftResult {
      const snapshot = snapshotInputObject<CreateApplicantSubmissionDraftInput>(input, [
        "workspaceId",
        "callId",
        "sessionTokenHash",
      ]);

      const { workspaceId, callId, sessionTokenHash } = snapshot;
      if (
        !isValidIdentifier(workspaceId) ||
        !isValidIdentifier(callId) ||
        !isValidTokenHash(sessionTokenHash)
      ) {
        throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
      }

      try {
        const seamInput: CreateSubmissionDraftSeamInput = Object.freeze({
          workspaceId,
          callId,
          sessionTokenHash,
        });

        const created = deps.createSubmissionDraft(db, seamInput);
        const createdSnapshot = snapshotDependencyResult(created, [
          "id",
          "workspaceId",
          "eventId",
          "callId",
          "ownerPersonId",
          "pinnedFormVersionId",
          "pinnedRuleVersionId",
        ]);
        const createdId = createdSnapshot?.id;
        if (
          !isValidIdentifier(createdId) ||
          createdSnapshot?.workspaceId !== workspaceId ||
          !isValidIdentifier(createdSnapshot.eventId) ||
          createdSnapshot.callId !== callId ||
          !isValidIdentifier(createdSnapshot.ownerPersonId) ||
          !isValidIdentifier(createdSnapshot.pinnedFormVersionId) ||
          !isValidIdentifier(createdSnapshot.pinnedRuleVersionId)
        ) {
          throwPostCommandIndeterminate();
        }

        return Object.freeze({
          submissionId: createdId,
        });
      } catch (err) {
        throwMappedWriteError(err);
      }
    },

    saveApplicantSubmissionDraft(
      db: Db,
      input: SaveApplicantSubmissionDraftInput,
    ): SavedApplicantSubmissionDraftResult {
      const snapshot = snapshotInputObject<SaveApplicantSubmissionDraftInput>(input, [
        "workspaceId",
        "callId",
        "sessionTokenHash",
        "submissionId",
        "historicalAnswers",
        "expectedCurrentRevisionId",
      ]);

      const {
        workspaceId,
        callId,
        sessionTokenHash,
        submissionId,
        historicalAnswers,
        expectedCurrentRevisionId,
      } = snapshot;

      if (
        !isValidIdentifier(workspaceId) ||
        !isValidIdentifier(callId) ||
        !isValidTokenHash(sessionTokenHash) ||
        !isValidIdentifier(submissionId) ||
        (expectedCurrentRevisionId !== null && !isValidIdentifier(expectedCurrentRevisionId))
      ) {
        throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
      }

      const detachedAnswers = detachPortalJson<JsonSafeValue>(
        historicalAnswers as JsonSafeValue,
        "PORTAL_INPUT_INVALID",
      );

      try {
        const seamInput: SaveSubmissionDraftSeamInput = Object.freeze({
          workspaceId,
          callId,
          sessionTokenHash,
          submissionId,
          historicalAnswers: detachedAnswers,
          expectedCurrentRevisionId,
        });

        const saved = deps.saveSubmissionDraft(db, seamInput);
        const savedSnapshot = snapshotDependencyResult(saved, ["revisionId", "revision"]);
        const revisionId = savedSnapshot?.revisionId;
        let detachedRevision: unknown = null;
        try {
          detachedRevision = sanitizeFormData(savedSnapshot?.revision);
        } catch {
          // The command already returned; an unsafe result cannot be reported as a retryable failure.
        }
        const revision = normalizeSubmissionRevisionEnvelope(detachedRevision, { submissionId });
        if (
          !isValidIdentifier(revisionId) ||
          !revision
        ) {
          throwPostCommandIndeterminate();
        }

        return Object.freeze({
          submissionId,
          revisionId,
          hasConsentReceipt: revision.consentReceipt !== null,
        });
      } catch (err) {
        throwMappedWriteError(err);
      }
    },

    submitApplicantSubmission(
      db: Db,
      input: SubmitApplicantSubmissionInput,
    ): SubmittedApplicantSubmissionResult {
      const snapshot = snapshotInputObject<SubmitApplicantSubmissionInput>(input, [
        "workspaceId",
        "callId",
        "sessionTokenHash",
        "submissionId",
        "historicalAnswers",
        "expectedCurrentRevisionId",
      ]);

      const {
        workspaceId,
        callId,
        sessionTokenHash,
        submissionId,
        historicalAnswers,
        expectedCurrentRevisionId,
      } = snapshot;

      if (
        !isValidIdentifier(workspaceId) ||
        !isValidIdentifier(callId) ||
        !isValidTokenHash(sessionTokenHash) ||
        !isValidIdentifier(submissionId) ||
        (expectedCurrentRevisionId !== null && !isValidIdentifier(expectedCurrentRevisionId))
      ) {
        throw new CfpApplicantPortalError("PORTAL_INPUT_INVALID");
      }

      const detachedAnswers = detachPortalJson<JsonSafeValue>(
        historicalAnswers as JsonSafeValue,
        "PORTAL_INPUT_INVALID",
      );

      try {
        const seamInput: SubmitSubmissionSeamInput = Object.freeze({
          workspaceId,
          callId,
          sessionTokenHash,
          submissionId,
          historicalAnswers: detachedAnswers,
          expectedCurrentRevisionId,
        });

        const submitted = deps.submitSubmission(db, seamInput);
        const submittedSnapshot = snapshotDependencyResult(submitted, [
          "submissionId",
          "revisionId",
          "submittedAt",
        ]);
        const submittedSubmissionId = submittedSnapshot?.submissionId;
        const submittedRevisionId = submittedSnapshot?.revisionId;
        const submittedAt = submittedSnapshot?.submittedAt;
        if (
          submittedSubmissionId !== submissionId ||
          !isValidIdentifier(submittedSubmissionId) ||
          !isValidIdentifier(submittedRevisionId) ||
          !isValidIsoTimestamp(submittedAt)
        ) {
          throwPostCommandIndeterminate();
        }

        return Object.freeze({
          submissionId: submittedSubmissionId,
          revisionId: submittedRevisionId,
          submittedAt,
        });
      } catch (err) {
        throwMappedWriteError(err);
      }
    },
  };
}

const defaultPortal = createCfpApplicantPortal();

export function locateExternallyReachableCall(
  db: Db,
  input: LocateExternallyReachableCallInput,
): LocateExternallyReachableCallResult {
  return defaultPortal.locateExternallyReachableCall(db, input);
}

export function requestApplicantEmailVerification(
  db: Db,
  input: RequestApplicantEmailVerificationInput,
): { readonly success: true } {
  return defaultPortal.requestApplicantEmailVerification(db, input);
}

export function issueApplicantEmailVerificationForDelivery(
  db: Db,
  input: RequestApplicantEmailVerificationInput,
): ApplicantEmailVerificationDeliveryCandidate {
  return defaultPortal.issueApplicantEmailVerificationForDelivery(db, input);
}

export function consumeApplicantEmailVerification(
  db: Db,
  input: ConsumeApplicantEmailVerificationInput,
): ConsumedApplicantSessionResult {
  return defaultPortal.consumeApplicantEmailVerification(db, input);
}

export function readApplicantOwnedCurrentRevision(
  db: Db,
  input: ReadApplicantOwnedCurrentRevisionInput,
): ReadApplicantOwnedCurrentRevisionResult {
  return defaultPortal.readApplicantOwnedCurrentRevision(db, input);
}

export function createApplicantSubmissionDraft(
  db: Db,
  input: CreateApplicantSubmissionDraftInput,
): CreatedApplicantSubmissionDraftResult {
  return defaultPortal.createApplicantSubmissionDraft(db, input);
}

export function saveApplicantSubmissionDraft(
  db: Db,
  input: SaveApplicantSubmissionDraftInput,
): SavedApplicantSubmissionDraftResult {
  return defaultPortal.saveApplicantSubmissionDraft(db, input);
}

export function submitApplicantSubmission(
  db: Db,
  input: SubmitApplicantSubmissionInput,
): SubmittedApplicantSubmissionResult {
  return defaultPortal.submitApplicantSubmission(db, input);
}
