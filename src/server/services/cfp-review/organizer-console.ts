import { Buffer } from "node:buffer";
import { roleHasCapability, type SessionInfo } from "../../auth";
import { canonicalJson, deterministicUuid, fingerprintOf, nowIso, uuid } from "../../canonical";
import { withTransaction, type Db } from "../../db";
import { writeAudit } from "../audit";
import { csvSafeCell } from "../csv-safe";
import {
  type CreateOrganizerReviewRoundInput,
  type CreateOrganizerReviewRubricInput,
  type DistributeOrganizerReviewAssignmentsInput,
  type ExportOrganizerReviewInput,
  type OrganizerReviewAssignment,
  type OrganizerReviewAssignmentPlanEntry,
  type OrganizerReviewBlindArtifactDecisionSet,
  type OrganizerReviewCall,
  type OrganizerReviewConflictStatus,
  type OrganizerReviewDistributionPlan,
  type OrganizerReviewDistributionReceipt,
  type OrganizerReviewExport,
  type OrganizerReviewLocalEvidence,
  type OrganizerReviewReminder,
  type OrganizerReviewRecusalReceipt,
  type OrganizerReviewProgress,
  type OrganizerReviewRubricDocument,
  type OrganizerReviewRubricField,
  type OrganizerReviewRubricFieldInput,
  type OrganizerReviewRubricSummary,
  type OrganizerReviewSubmittedCriterion,
  type OrganizerReviewSubmittedReview,
  type OrganizerReviewSubmissionAggregate,
  type OrganizerReviewRound,
  type OrganizerReviewRoundProjection,
  type OrganizerReviewRoundReceipt,
  type OrganizerReviewRoundScheduleReceipt,
  type OrganizerReviewRoundStateReceipt,
  type OrganizerReviewRoundState,
  type OrganizerReviewSort,
  type OrganizerReviewSurface,
  type RecuseOrganizerReviewAssignmentInput,
  type ReadOrganizerReviewSurfaceInput,
  type SetOrganizerReviewRoundScheduleInput,
  type SetOrganizerReviewRoundStateInput,
} from "./organizer-types";
import {
  ORGANIZER_REVIEW_EVIDENCE_SCHEMA,
  ORGANIZER_REVIEW_EXPORT_SCHEMA,
  ORGANIZER_REVIEW_RECUSAL_RECEIPT_SCHEMA,
  ORGANIZER_REVIEW_RECUSAL_REQUEST_SCHEMA,
  ORGANIZER_REVIEW_RUBRIC_DOCUMENT_SCHEMA,
} from "./organizer-types";
import { readOrganizerReviewBlindControl } from "./review-blind-control";
import {
  OrganizerSealingFatalError,
  sealBlindReviewArtifact,
  type OrganizerSealingComposition,
} from "./organizer-sealing";

const sealingComposition = sealBlindReviewArtifact as typeof sealBlindReviewArtifact & OrganizerSealingComposition;

const CAPABILITY = "phase0.pipeline.manage" as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const ROUND_STATES = new Set<OrganizerReviewRoundState>([
  "DRAFT",
  "OPEN",
  "CLOSED",
  "CANCELLED",
]);
const REVIEW_SORTS = new Set<OrganizerReviewSort>([
  "rank",
  "score",
  "progress",
  "submission",
  "reviewer",
]);
const ACTIVE_CALL_STATES = new Set(["DRAFT", "SCHEDULED", "OPEN", "PAUSED"]);
const ACTIVE_EVENT_LIFECYCLES = new Set(["draft", "planning", "published", "live"]);

function reviewerSubmissionPairKey(
  submissionId: string,
  reviewerAccountId: string,
): string {
  return canonicalJson([submissionId, reviewerAccountId]);
}

function reviewerSubmissionRevisionPairKey(
  submissionRevisionId: string,
  reviewerAccountId: string,
): string {
  return canonicalJson([submissionRevisionId, reviewerAccountId]);
}

const ERROR_MESSAGES = {
  INPUT_INVALID: "The organizer review request is invalid.",
  ACCESS_DENIED: "Organizer review access is unavailable.",
  OUTER_TRANSACTION_DENIED:
    "Organizer review configuration requires its own transaction boundary.",
  EVENT_NOT_AVAILABLE: "The event is not available in this workspace.",
  CALL_NOT_AVAILABLE: "The call is not available for this event.",
  ROUND_NOT_AVAILABLE: "The review round is not available in this workspace.",
  ROUND_SCHEDULE_MISMATCH:
    "Review-round dates must match the authoritative call dates.",
  ROUND_SCHEDULE_INVALID: "The review-round schedule is invalid.",
  ROUND_SCHEDULE_STALE: "The review-round schedule changed before this request completed.",
  ROUND_SCHEDULE_IDEMPOTENCY_CONFLICT:
    "The review-round schedule request conflicts with an earlier request.",
  ROUND_CREATE_IDEMPOTENCY_CONFLICT:
    "The review-round creation request conflicts with an earlier request.",
  ROUND_STATE_UNAVAILABLE: "The review round state could not be verified.",
  ROUND_STATE_INVALID: "The review round state is not valid for this operation.",
  ROUND_STATE_STALE: "The review round state changed before this request completed.",
  DISTRIBUTION_IDEMPOTENCY_CONFLICT:
    "The reviewer distribution request conflicts with an earlier request.",
  RECUSAL_IDEMPOTENCY_CONFLICT:
    "The review-assignment recusal request conflicts with an earlier request.",
  RUBRIC_NOT_AVAILABLE: "A sealed review rubric is required for this operation.",
  ASSIGNMENT_NOT_AVAILABLE: "The review assignment is not available in this workspace.",
  REVIEWER_NOT_AVAILABLE: "The reviewer is not available in this workspace.",
  SUBMISSION_NOT_AVAILABLE: "The submission is not available for this review round.",
  READ_FAILED: "The organizer review read could not be completed.",
  WRITE_FAILED: "The organizer review configuration could not be completed.",
} as const;

export type OrganizerReviewServiceErrorCode = keyof typeof ERROR_MESSAGES;

export class OrganizerReviewServiceError extends Error {
  readonly code: OrganizerReviewServiceErrorCode;

  constructor(code: OrganizerReviewServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OrganizerReviewServiceError";
    this.code = code;
  }
}

type OrganizerAuth = Readonly<{
  accountId: string;
  workspaceId: string;
  workspaceSlug: string;
  role: string;
  session: SessionInfo;
}>;

type CallRow = Readonly<{
  id: unknown;
  workspace_id: unknown;
  event_id: unknown;
  name: unknown;
  slug: unknown;
  state: unknown;
  timezone: unknown;
  opens_at: unknown;
  closes_at: unknown;
  event_workspace_id: unknown;
  event_name: unknown;
  event_lifecycle: unknown;
}>;

type RoundRow = Readonly<{
  id: unknown;
  workspace_id: unknown;
  event_id: unknown;
  call_id: unknown;
  name: unknown;
  created_by: unknown;
  created_at: unknown;
  call_name: unknown;
  call_slug: unknown;
  call_state: unknown;
  call_timezone: unknown;
  call_opens_at: unknown;
  call_closes_at: unknown;
  schedule_version_number: unknown;
  schedule_source: unknown;
  schedule_timezone: unknown;
  schedule_opens_at: unknown;
  schedule_closes_at: unknown;
  schedule_updated_at: unknown;
  event_name: unknown;
}>;

type ScheduleRow = Readonly<{
  workspace_id: unknown;
  round_id: unknown;
  event_id: unknown;
  version_number: unknown;
  expected_previous_version: unknown;
  timezone: unknown;
  opens_at: unknown;
  closes_at: unknown;
  idempotency_key: unknown;
  created_at: unknown;
}>;

type RoundCreationReceiptRow = Readonly<{
  request_fingerprint: unknown;
  round_id: unknown;
  event_id: unknown;
  call_id: unknown;
  schedule_version: unknown;
  timezone: unknown;
  opens_at: unknown;
  closes_at: unknown;
}>;

type StateRow = Readonly<{
  state: unknown;
  sequence_number: unknown;
  actor_account_id?: unknown;
  reason?: unknown;
  created_at: unknown;
}>;

type ProgressRow = Readonly<{
  total: unknown;
  assigned: unknown;
  in_progress: unknown;
  submitted: unknown;
  recused: unknown;
  revoked: unknown;
  conflicts: unknown;
  blind_ready: unknown;
}>;

type RubricVersionRow = Readonly<{
  id: unknown;
  round_id: unknown;
  version_number: unknown;
  rubric_schema: unknown;
  rubric_json: unknown;
  fingerprint_algorithm: unknown;
  fingerprint: unknown;
  sealed_at: unknown;
}>;

type AssignmentRow = Readonly<{
  assignment_id: unknown;
  round_id: unknown;
  submission_id: unknown;
  submission_revision_id: unknown;
  reviewer_account_id: unknown;
  reviewer_name: unknown;
  assignment_state: unknown;
  assignment_state_sequence: unknown;
  conflict_action: unknown;
  conflict_sequence: unknown;
  review_revision_number: unknown;
  blind_artifact_id: unknown;
  assigned_at: unknown;
  person_id: unknown;
  person_name: unknown;
  organization: unknown;
}>;

type SubmissionAggregateRow = Readonly<{
  submission_id: unknown;
  submission_revision_id: unknown;
  person_id: unknown;
  person_name: unknown;
  organization: unknown;
}>;

type ReviewEvidenceRow = Readonly<{
  review_revision_id: unknown;
  assignment_id: unknown;
  assignment_rubric_version_id: unknown;
  assignment_submission_id: unknown;
  assignment_submission_revision_id: unknown;
  submission_id: unknown;
  submission_revision_id: unknown;
  round_id: unknown;
  rubric_version_id: unknown;
  reviewer_account_id: unknown;
  revision_number: unknown;
  evaluation_schema: unknown;
  evaluation_json: unknown;
  fingerprint_algorithm: unknown;
  fingerprint: unknown;
}>;

type LocalEvidenceRow = Readonly<{
  details_json: unknown;
  created_at: unknown;
}>;

type AccountRow = Readonly<{
  id: unknown;
  role: unknown;
}>;

const MAX_RUBRIC_FIELDS = 32;
const MAX_RUBRIC_CHOICES = 32;
const MAX_DISTRIBUTION_REVIEWERS = 256;
const MAX_DISTRIBUTION_SUBMISSIONS = 4_096;
const MAX_ASSIGNMENTS_PER_REVIEWER = 4_096;
const RECOMMENDATION_CHOICE_VALUES = new Set([
  "ADVANCE",
  "HOLD",
  "DO_NOT_ADVANCE",
]);

function fail(code: OrganizerReviewServiceErrorCode): never {
  throw new OrganizerReviewServiceError(code);
}

function boundary<T>(kind: "read" | "write", operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof OrganizerReviewServiceError) throw error;
    if (error instanceof OrganizerSealingFatalError) throw error;
    throw new OrganizerReviewServiceError(kind === "read" ? "READ_FAILED" : "WRITE_FAILED");
  }
}

function text(value: unknown, maximumBytes = 16 * 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return fail("READ_FAILED");
  }
  return value;
}

function inputText(value: unknown, maximumBytes = 16 * 1024): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return fail("INPUT_INVALID");
  }
  return value.trim();
}

function identifier(value: unknown, code: OrganizerReviewServiceErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) return fail(code);
  return value;
}

function inputIdentifier(value: unknown): string {
  return identifier(value, "INPUT_INVALID");
}

function storedIdentifier(value: unknown): string {
  return identifier(value, "READ_FAILED");
}

function workspaceSlug(value: unknown): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) return fail("INPUT_INVALID");
  return value;
}

function canonicalTimestamp(value: unknown, code: OrganizerReviewServiceErrorCode): string {
  if (typeof value !== "string") return fail(code);
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    return fail(code);
  }
  if (canonical !== value) return fail(code);
  return value;
}

function optionalTimestamp(value: unknown, code: OrganizerReviewServiceErrorCode): string | null {
  if (value === null || value === undefined) return null;
  return canonicalTimestamp(value, code);
}

function optionalLegacyTimestamp(value: unknown, code: OrganizerReviewServiceErrorCode): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return fail(code);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return fail(code);
  return new Date(epoch).toISOString();
}

function finiteNumber(value: unknown, code: OrganizerReviewServiceErrorCode): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(code);
  return value;
}

function safeInteger(value: unknown, code: OrganizerReviewServiceErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fail(code);
  return value;
}

function rubricField(value: unknown, code: OrganizerReviewServiceErrorCode): OrganizerReviewRubricField {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(code);
  const candidate = value as Record<string, unknown>;
  const id = identifier(candidate.id, code);
  const label = code === "INPUT_INVALID"
    ? inputText(candidate.label, 512)
    : text(candidate.label, 512);
  let guidance = "";
  if (candidate.guidance !== undefined && candidate.guidance !== null) {
    if (code === "INPUT_INVALID") {
      guidance = inputText(candidate.guidance, 4_096);
    } else if (
      typeof candidate.guidance !== "string" ||
      Buffer.byteLength(candidate.guidance, "utf8") > 4_096 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(candidate.guidance)
    ) {
      return fail(code);
    } else {
      guidance = candidate.guidance;
    }
  }
  const kind = candidate.kind;
  if (kind !== "numeric" && kind !== "dropdown" && kind !== "text") return fail(code);
  if (typeof candidate.required !== "boolean") return fail(code);
  const weight = finiteNumber(candidate.weight, code);
  if (weight <= 0 || weight > 100_000) return fail(code);
  const recommendation = candidate.recommendation;
  if (recommendation !== undefined && typeof recommendation !== "boolean") return fail(code);
  if (recommendation === true && kind !== "dropdown") return fail(code);

  if (kind === "numeric") {
    if (recommendation === true) return fail(code);
    const minimum = candidate.minimum === undefined || candidate.minimum === null
      ? 0
      : finiteNumber(candidate.minimum, code);
    const maximum = candidate.maximum === undefined || candidate.maximum === null
      ? 10
      : finiteNumber(candidate.maximum, code);
    const step = candidate.step === undefined || candidate.step === null
      ? 1
      : finiteNumber(candidate.step, code);
    if (maximum <= minimum || step <= 0 || step > maximum - minimum) return fail(code);
    return Object.freeze({
      id,
      label,
      guidance,
      kind,
      required: candidate.required,
      weight,
      ...(recommendation !== undefined ? { recommendation } : {}),
      minimum,
      maximum,
      step,
      choices: Object.freeze([]),
      maxLength: null,
    });
  }

  if (kind === "dropdown") {
    if (!Array.isArray(candidate.choices) || candidate.choices.length === 0 || candidate.choices.length > MAX_RUBRIC_CHOICES) {
      return fail(code);
    }
    const seen = new Set<string>();
    const choices = candidate.choices.map((choice) => {
      if (choice === null || typeof choice !== "object" || Array.isArray(choice)) return fail(code);
      const rawChoice = choice as Record<string, unknown>;
      const valueText = code === "INPUT_INVALID"
        ? inputText(rawChoice.value, 128)
        : text(rawChoice.value, 128);
      const labelText = code === "INPUT_INVALID"
        ? inputText(rawChoice.label, 512)
        : text(rawChoice.label, 512);
      if (seen.has(valueText)) return fail(code);
      seen.add(valueText);
      return Object.freeze({ value: valueText, label: labelText });
    });
    if (
      recommendation === true &&
      (choices.length !== RECOMMENDATION_CHOICE_VALUES.size ||
        choices.some((choice) => !RECOMMENDATION_CHOICE_VALUES.has(choice.value)))
    ) {
      return fail(code);
    }
    return Object.freeze({
      id,
      label,
      guidance,
      kind,
      required: candidate.required,
      weight,
      ...(recommendation !== undefined ? { recommendation } : {}),
      minimum: null,
      maximum: null,
      step: null,
      choices: Object.freeze(choices),
      maxLength: null,
    });
  }

  const maxLength = candidate.maxLength === undefined || candidate.maxLength === null
    ? 4_096
    : safeInteger(candidate.maxLength, code);
  if (maxLength < 1 || maxLength > 64 * 1024) return fail(code);
  return Object.freeze({
    id,
    label,
    guidance,
    kind,
    required: candidate.required,
    weight,
    ...(recommendation !== undefined ? { recommendation } : {}),
    minimum: null,
    maximum: null,
    step: null,
    choices: Object.freeze([]),
    maxLength,
  });
}

function rubricDocument(
  fields: unknown,
  code: OrganizerReviewServiceErrorCode,
): OrganizerReviewRubricDocument {
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_RUBRIC_FIELDS) {
    return fail(code);
  }
  const seen = new Set<string>();
  let recommendationCount = 0;
  const normalized = fields.map((field) => {
    const result = rubricField(field, code);
    if (seen.has(result.id)) return fail(code);
    seen.add(result.id);
    if (result.recommendation) {
      recommendationCount += 1;
      if (recommendationCount > 1) return fail(code);
    }
    return result;
  });
  return Object.freeze({
    schema: ORGANIZER_REVIEW_RUBRIC_DOCUMENT_SCHEMA,
    version: 1,
    title: "Organizer review rubric",
    judgmentBoundary: "independent-review-evidence",
    fields: Object.freeze(normalized),
  });
}

function storedRubricDocument(value: unknown): OrganizerReviewRubricDocument {
  if (typeof value !== "string") return fail("READ_FAILED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail("READ_FAILED");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("READ_FAILED");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schema !== ORGANIZER_REVIEW_RUBRIC_DOCUMENT_SCHEMA ||
    candidate.version !== 1 ||
    candidate.judgmentBoundary !== "independent-review-evidence"
  ) {
    return fail("READ_FAILED");
  }
  return rubricDocument(candidate.fields, "READ_FAILED");
}

function customRubricDocumentForVersion(
  db: Db,
  organizer: OrganizerAuth,
  rubricVersionId: string,
): OrganizerReviewRubricDocument | null {
  const row = db
    .prepare(
      `SELECT rubric_json
       FROM rubric_versions
       WHERE workspace_id = ? AND id = ?`,
    )
    .get(organizer.workspaceId, rubricVersionId) as { rubric_json: unknown } | undefined;
  if (!row || typeof row.rubric_json !== "string") return fail("READ_FAILED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.rubric_json);
  } catch {
    return fail("READ_FAILED");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).schema !== ORGANIZER_REVIEW_RUBRIC_DOCUMENT_SCHEMA
  ) {
    return null;
  }
  return storedRubricDocument(row.rubric_json);
}

function rubricDocumentForInput(input: CreateOrganizerReviewRubricInput): OrganizerReviewRubricDocument {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  return rubricDocument(input.fields, "INPUT_INVALID");
}

function sessionField(session: SessionInfo, key: keyof SessionInfo): unknown {
  try {
    return session[key];
  } catch {
    return fail("ACCESS_DENIED");
  }
}

function authenticateOrganizer(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): OrganizerAuth {
  const accountId = sessionField(session, "accountId");
  const workspaceId = sessionField(session, "workspaceId");
  const sessionId = sessionField(session, "id");
  const tokenHash = sessionField(session, "tokenHash");
  if (
    typeof accountId !== "string" ||
    typeof workspaceId !== "string" ||
    typeof sessionId !== "string" ||
    typeof tokenHash !== "string" ||
    !IDENTIFIER_PATTERN.test(accountId) ||
    !IDENTIFIER_PATTERN.test(workspaceId) ||
    !IDENTIFIER_PATTERN.test(sessionId) ||
    !/^[a-f0-9]{64}$/u.test(tokenHash) ||
    requestedWorkspaceSlug !== sessionField(session, "workspaceSlug")
  ) {
    return fail("ACCESS_DENIED");
  }

  const row = db
    .prepare(
      `SELECT s.id, s.token_hash, s.account_id, s.workspace_id, s.created_at,
              s.expires_at, a.role, w.slug
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id AND a.workspace_id = s.workspace_id
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = ? AND s.token_hash = ?`,
    )
    .get(sessionId, tokenHash) as
    | {
        id: unknown;
        token_hash: unknown;
        account_id: unknown;
        workspace_id: unknown;
        created_at: unknown;
        expires_at: unknown;
        role: unknown;
        slug: unknown;
      }
    | undefined;
  if (!row) return fail("ACCESS_DENIED");

  const createdAt = canonicalTimestamp(row.created_at, "ACCESS_DENIED");
  const expiresAt = canonicalTimestamp(row.expires_at, "ACCESS_DENIED");
  const role = text(row.role, 128);
  if (
    storedIdentifier(row.id) !== sessionId ||
    row.token_hash !== tokenHash ||
    storedIdentifier(row.account_id) !== accountId ||
    storedIdentifier(row.workspace_id) !== workspaceId ||
    text(row.slug, 128) !== requestedWorkspaceSlug ||
    Date.parse(createdAt) > Date.now() ||
    Date.parse(expiresAt) <= Date.now() ||
    !roleHasCapability(role, CAPABILITY)
  ) {
    return fail("ACCESS_DENIED");
  }
  return Object.freeze({
    accountId,
    workspaceId,
    workspaceSlug: requestedWorkspaceSlug,
    role,
    session,
  });
}

function ownedWrite<T>(db: Db, operation: () => T): T {
  if (db.isTransaction) return fail("OUTER_TRANSACTION_DENIED");
  return withTransaction(db, operation);
}

function ownedDistributionWrite<T>(db: Db, operation: () => T): T {
  let inTransaction: boolean;
  try {
    inTransaction = db.isTransaction;
  } catch {
    throw new OrganizerSealingFatalError();
  }
  if (inTransaction) return fail("OUTER_TRANSACTION_DENIED");
  return sealingComposition.withOwnedTransaction(db, operation);
}

function readCall(
  db: Db,
  organizer: OrganizerAuth,
  eventId: string,
  callId: string,
): CallRow {
  const row = db
    .prepare(
      `SELECT c.id, c.workspace_id, c.event_id, c.name, c.slug, c.state,
              c.timezone, c.opens_at, c.closes_at,
              e.workspace_id AS event_workspace_id, e.name AS event_name,
              e.lifecycle AS event_lifecycle
       FROM calls c
       JOIN events e ON e.id = c.event_id AND e.workspace_id = c.workspace_id
       WHERE c.workspace_id = ? AND c.event_id = ? AND c.id = ?`,
    )
    .get(organizer.workspaceId, eventId, callId) as CallRow | undefined;
  if (!row) return fail("CALL_NOT_AVAILABLE");
  if (
    storedIdentifier(row.workspace_id) !== organizer.workspaceId ||
    storedIdentifier(row.event_workspace_id) !== organizer.workspaceId ||
    storedIdentifier(row.event_id) !== eventId ||
    storedIdentifier(row.id) !== callId
  ) {
    return fail("CALL_NOT_AVAILABLE");
  }
  return row;
}

function callProjection(row: CallRow): OrganizerReviewCall {
  return Object.freeze({
    id: storedIdentifier(row.id),
    name: text(row.name),
    slug: text(row.slug, 128),
    state: text(row.state, 64),
    timezone: text(row.timezone, 128),
    opensAt: optionalLegacyTimestamp(row.opens_at, "READ_FAILED"),
    closesAt: optionalLegacyTimestamp(row.closes_at, "READ_FAILED"),
  });
}

function resolveCreateSchedule(
  input: CreateOrganizerReviewRoundInput,
  call: OrganizerReviewCall,
): Readonly<{ opensAt: string; closesAt: string }> {
  const hasOpensAt = Object.hasOwn(input, "opensAt");
  const hasClosesAt = Object.hasOwn(input, "closesAt");
  if (hasOpensAt !== hasClosesAt) return fail("ROUND_SCHEDULE_INVALID");
  const opensAt = hasOpensAt
    ? canonicalTimestamp(input.opensAt, "ROUND_SCHEDULE_INVALID")
    : call.opensAt;
  const closesAt = hasClosesAt
    ? canonicalTimestamp(input.closesAt, "ROUND_SCHEDULE_INVALID")
    : call.closesAt;
  if (opensAt === null || closesAt === null || opensAt >= closesAt) {
    return fail("ROUND_SCHEDULE_INVALID");
  }
  return Object.freeze({ opensAt, closesAt });
}

function assertScheduleMatchesCall(
  input: CreateOrganizerReviewRoundInput,
  call: OrganizerReviewCall,
): void {
  const opensAt = Object.hasOwn(input, "opensAt")
    ? optionalTimestamp(input.opensAt, "INPUT_INVALID")
    : call.opensAt;
  const closesAt = Object.hasOwn(input, "closesAt")
    ? optionalTimestamp(input.closesAt, "INPUT_INVALID")
    : call.closesAt;
  if (opensAt !== call.opensAt || closesAt !== call.closesAt) {
    return fail("ROUND_SCHEDULE_MISMATCH");
  }
  if (
    opensAt !== null &&
    closesAt !== null &&
    Date.parse(opensAt) > Date.parse(closesAt)
  ) {
    return fail("ROUND_SCHEDULE_MISMATCH");
  }
}

function validateCreateInput(input: CreateOrganizerReviewRoundInput): CreateOrganizerReviewRoundInput {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  const workspace = workspaceSlug(input.workspaceSlug);
  const eventId = inputIdentifier(input.eventId);
  const callId = inputIdentifier(input.callId);
  const name = inputText(input.name, 512);
  const idempotencyKey = input.idempotencyKey === undefined
    ? undefined
    : inputText(input.idempotencyKey, 128);
  return Object.freeze({
    workspaceSlug: workspace,
    eventId,
    callId,
    name,
    ...(Object.hasOwn(input, "opensAt") ? { opensAt: input.opensAt ?? null } : {}),
    ...(Object.hasOwn(input, "closesAt") ? { closesAt: input.closesAt ?? null } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });
}

function roundCreationRequestBinding(
  input: CreateOrganizerReviewRoundInput,
  workspaceId: string,
): Readonly<{ requestFingerprint: string; idempotencyKey: string }> {
  const hasOpensAt = Object.hasOwn(input, "opensAt");
  const hasClosesAt = Object.hasOwn(input, "closesAt");
  if (hasOpensAt !== hasClosesAt) return fail("ROUND_SCHEDULE_INVALID");
  const schedule = hasOpensAt
    ? Object.freeze({
        mode: "explicit" as const,
        opensAt: canonicalTimestamp(input.opensAt, "ROUND_SCHEDULE_INVALID"),
        closesAt: canonicalTimestamp(input.closesAt, "ROUND_SCHEDULE_INVALID"),
      })
    : Object.freeze({ mode: "call-defaults" as const });
  if (schedule.mode === "explicit" && schedule.opensAt >= schedule.closesAt) {
    return fail("ROUND_SCHEDULE_INVALID");
  }
  const requestFingerprint = fingerprintOf({
    schema: "cfp-review-round-create-request/v1",
    workspaceId,
    eventId: input.eventId,
    callId: input.callId,
    name: input.name,
    schedule,
  });
  return Object.freeze({
    requestFingerprint,
    idempotencyKey: input.idempotencyKey ?? `derived:${requestFingerprint}`,
  });
}

function roundCreationReceipt(
  row: RoundCreationReceiptRow,
  requestFingerprint: string,
): OrganizerReviewRoundReceipt {
  if (text(row.request_fingerprint, 64) !== requestFingerprint) {
    return fail("ROUND_CREATE_IDEMPOTENCY_CONFLICT");
  }
  const opensAt = canonicalTimestamp(row.opens_at, "READ_FAILED");
  const closesAt = canonicalTimestamp(row.closes_at, "READ_FAILED");
  if (opensAt >= closesAt) return fail("READ_FAILED");
  const scheduleVersion = safeInteger(row.schedule_version, "READ_FAILED");
  return Object.freeze({
    roundId: storedIdentifier(row.round_id),
    eventId: storedIdentifier(row.event_id),
    callId: storedIdentifier(row.call_id),
    state: "DRAFT" as const,
    stateSequenceNumber: 1 as const,
    scheduleSource: scheduleVersion === 1 ? "call" as const : "round" as const,
    scheduleVersion,
    timezone: text(row.timezone, 128),
    opensAt,
    closesAt,
    replayed: true,
  });
}

function validateScheduleInput(
  input: SetOrganizerReviewRoundScheduleInput,
): SetOrganizerReviewRoundScheduleInput {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  const expectedScheduleVersion = safeInteger(input.expectedScheduleVersion, "INPUT_INVALID");
  if (expectedScheduleVersion < 1) return fail("INPUT_INVALID");
  const opensAt = canonicalTimestamp(input.opensAt, "ROUND_SCHEDULE_INVALID");
  const closesAt = canonicalTimestamp(input.closesAt, "ROUND_SCHEDULE_INVALID");
  if (opensAt >= closesAt) return fail("ROUND_SCHEDULE_INVALID");
  return Object.freeze({
    workspaceSlug: workspaceSlug(input.workspaceSlug),
    eventId: inputIdentifier(input.eventId),
    roundId: inputIdentifier(input.roundId),
    expectedScheduleVersion,
    opensAt,
    closesAt,
    idempotencyKey: inputText(input.idempotencyKey, 128),
  });
}

function validateRoundStateInput(
  input: SetOrganizerReviewRoundStateInput,
): SetOrganizerReviewRoundStateInput {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  const expectedStateSequenceNumber = safeInteger(
    input.expectedStateSequenceNumber,
    "INPUT_INVALID",
  );
  if (expectedStateSequenceNumber < 1) return fail("INPUT_INVALID");
  if (
    typeof input.state !== "string" ||
    !new Set(["OPEN", "CLOSED", "CANCELLED"]).has(input.state)
  ) {
    return fail("INPUT_INVALID");
  }
  return Object.freeze({
    workspaceSlug: workspaceSlug(input.workspaceSlug),
    ...(input.eventId === undefined ? {} : { eventId: inputIdentifier(input.eventId) }),
    roundId: inputIdentifier(input.roundId),
    expectedStateSequenceNumber,
    state: input.state as SetOrganizerReviewRoundStateInput["state"],
    reason: inputText(input.reason, 4096),
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: inputText(input.idempotencyKey, 128) }),
  });
}

function assertRoundCreationAllowed(row: CallRow): void {
  const eventLifecycle = text(row.event_lifecycle, 64);
  const callState = text(row.state, 64);
  if (!ACTIVE_EVENT_LIFECYCLES.has(eventLifecycle)) return fail("CALL_NOT_AVAILABLE");
  if (!ACTIVE_CALL_STATES.has(callState)) return fail("CALL_NOT_AVAILABLE");
}

function latestRoundState(db: Db, workspaceId: string, roundId: string): {
  readonly state: OrganizerReviewRoundState;
  readonly sequenceNumber: number;
  readonly createdAt: string;
} {
  const row = db
    .prepare(
      `SELECT state, sequence_number, created_at
       FROM review_round_states
       WHERE workspace_id = ? AND round_id = ?
       ORDER BY sequence_number DESC LIMIT 1`,
    )
    .get(workspaceId, roundId) as StateRow | undefined;
  if (!row || typeof row.state !== "string" || !ROUND_STATES.has(row.state as OrganizerReviewRoundState)) {
    return fail("ROUND_STATE_UNAVAILABLE");
  }
  if (
    typeof row.sequence_number !== "number" ||
    !Number.isSafeInteger(row.sequence_number) ||
    row.sequence_number < 1
  ) {
    return fail("ROUND_STATE_UNAVAILABLE");
  }
  return Object.freeze({
    state: row.state as OrganizerReviewRoundState,
    sequenceNumber: row.sequence_number,
    createdAt: canonicalTimestamp(row.created_at, "ROUND_STATE_UNAVAILABLE"),
  });
}

type RoundSchedule = Readonly<{
  roundId: string;
  eventId: string;
  version: number;
  expectedPreviousVersion: number;
  timezone: string;
  opensAt: string;
  closesAt: string;
  idempotencyKey: string;
  updatedAt: string;
}>;

function scheduleFromRow(
  row: ScheduleRow | undefined,
  workspaceId: string,
  eventId: string,
  roundId: string,
  code: OrganizerReviewServiceErrorCode,
): RoundSchedule {
  if (!row) return fail(code);
  const version = safeInteger(row.version_number, code);
  const expectedPreviousVersion = safeInteger(row.expected_previous_version, code);
  const opensAt = canonicalTimestamp(row.opens_at, code);
  const closesAt = canonicalTimestamp(row.closes_at, code);
  if (
    storedIdentifier(row.workspace_id) !== workspaceId ||
    storedIdentifier(row.event_id) !== eventId ||
    storedIdentifier(row.round_id) !== roundId ||
    version < 1 ||
    expectedPreviousVersion !== version - 1 ||
    opensAt >= closesAt
  ) {
    return fail(code);
  }
  return Object.freeze({
    roundId,
    eventId,
    version,
    expectedPreviousVersion,
    timezone: text(row.timezone, 128),
    opensAt,
    closesAt,
    idempotencyKey: text(row.idempotency_key, 256),
    updatedAt: canonicalTimestamp(row.created_at, code),
  });
}

function latestRoundSchedule(
  db: Db,
  workspaceId: string,
  eventId: string,
  roundId: string,
  code: OrganizerReviewServiceErrorCode,
): RoundSchedule {
  const row = db
    .prepare(
      `SELECT workspace_id, event_id, round_id, version_number,
              expected_previous_version, timezone, opens_at, closes_at,
              idempotency_key, created_at
       FROM review_round_schedule_versions
       WHERE workspace_id = ? AND event_id = ? AND round_id = ?
       ORDER BY version_number DESC
       LIMIT 1`,
    )
    .get(workspaceId, eventId, roundId) as ScheduleRow | undefined;
  return scheduleFromRow(row, workspaceId, eventId, roundId, code);
}

function roundScheduleByIdempotencyKey(
  db: Db,
  workspaceId: string,
  eventId: string,
  roundId: string,
  idempotencyKey: string,
): RoundSchedule | null {
  const row = db
    .prepare(
      `SELECT workspace_id, event_id, round_id, version_number,
              expected_previous_version, timezone, opens_at, closes_at,
              idempotency_key, created_at
       FROM review_round_schedule_versions
       WHERE workspace_id = ? AND event_id = ? AND round_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .get(workspaceId, eventId, roundId, idempotencyKey) as ScheduleRow | undefined;
  return row
    ? scheduleFromRow(row, workspaceId, eventId, roundId, "ROUND_SCHEDULE_IDEMPOTENCY_CONFLICT")
    : null;
}

function appendRoundSchedule(
  db: Db,
  organizer: OrganizerAuth,
  eventId: string,
  roundId: string,
  expectedPreviousVersion: number,
  timezone: string,
  opensAt: string,
  closesAt: string,
  idempotencyKey: string,
): RoundSchedule {
  const version = expectedPreviousVersion + 1;
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO review_round_schedule_versions
       (id, workspace_id, event_id, round_id, version_number, expected_previous_version,
        timezone, opens_at, closes_at, source, actor_account_id, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ORGANIZER_INPUT', ?, ?, ?)`,
  ).run(
    uuid(),
    organizer.workspaceId,
    eventId,
    roundId,
    version,
    expectedPreviousVersion,
    timezone,
    opensAt,
    closesAt,
    organizer.accountId,
    idempotencyKey,
    updatedAt,
  );
  return Object.freeze({
    roundId,
    eventId,
    version,
    expectedPreviousVersion,
    timezone,
    opensAt,
    closesAt,
    idempotencyKey,
    updatedAt,
  });
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function roundProgress(db: Db, workspaceId: string, roundId: string): OrganizerReviewProgress {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN latest.state NOT IN ('RECUSED', 'REVOKED') THEN 1 ELSE 0 END), 0) AS total,
         COALESCE(SUM(CASE WHEN latest.state = 'ASSIGNED' THEN 1 ELSE 0 END), 0) AS assigned,
         COALESCE(SUM(CASE WHEN latest.state = 'IN_PROGRESS' THEN 1 ELSE 0 END), 0) AS in_progress,
         COALESCE(SUM(CASE WHEN latest.state = 'SUBMITTED' THEN 1 ELSE 0 END), 0) AS submitted,
         COALESCE(SUM(CASE WHEN latest.state = 'RECUSED' THEN 1 ELSE 0 END), 0) AS recused,
         COALESCE(SUM(CASE WHEN latest.state = 'REVOKED' THEN 1 ELSE 0 END), 0) AS revoked,
         COALESCE(SUM(CASE WHEN conflict.action = 'DECLARE' THEN 1 ELSE 0 END), 0) AS conflicts,
         COALESCE(SUM(CASE WHEN latest.state NOT IN ('RECUSED', 'REVOKED')
                            AND artifact.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS blind_ready
       FROM review_assignments assignment
       LEFT JOIN review_assignment_states latest
         ON latest.assignment_id = assignment.id
        AND latest.sequence_number = (
          SELECT MAX(state.sequence_number)
          FROM review_assignment_states state
          WHERE state.workspace_id = assignment.workspace_id
            AND state.assignment_id = assignment.id
        )
       LEFT JOIN review_conflict_dispositions conflict
         ON conflict.assignment_id = assignment.id
        AND conflict.sequence_number = (
          SELECT MAX(disposition.sequence_number)
          FROM review_conflict_dispositions disposition
          WHERE disposition.workspace_id = assignment.workspace_id
            AND disposition.assignment_id = assignment.id
        )
       LEFT JOIN review_blind_artifacts artifact
         ON artifact.workspace_id = assignment.workspace_id
        AND artifact.assignment_id = assignment.id
       WHERE assignment.workspace_id = ? AND assignment.round_id = ?`,
    )
    .get(workspaceId, roundId) as ProgressRow | undefined;
  if (!row) return fail("READ_FAILED");
  const total = count(row.total);
  const submitted = count(row.submitted);
  const blindReady = count(row.blind_ready);
  return Object.freeze({
    assigned: count(row.assigned),
    inProgress: count(row.in_progress),
    submitted,
    recused: count(row.recused),
    revoked: count(row.revoked),
    conflicts: count(row.conflicts),
    blindReady,
    blindPending: Math.max(0, total - blindReady),
    total,
    completionPercent: total === 0 ? 0 : Math.round((submitted / total) * 100),
  });
}

function legacyRubricFields(
  db: Db,
  workspaceId: string,
  rubricVersionId: string,
): readonly OrganizerReviewRubricField[] {
  const semantics = db
    .prepare(
      `SELECT semantics_json
       FROM review_rubric_semantics
       WHERE workspace_id = ? AND rubric_version_id = ?
       LIMIT 1`,
    )
    .get(workspaceId, rubricVersionId) as { semantics_json: unknown } | undefined;
  if (!semantics) return Object.freeze([]);
  if (typeof semantics.semantics_json !== "string") return fail("READ_FAILED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(semantics.semantics_json);
  } catch {
    return fail("READ_FAILED");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("READ_FAILED");
  }
  const criteria = (parsed as Record<string, unknown>).criteria;
  if (!Array.isArray(criteria)) return fail("READ_FAILED");
  const fields: OrganizerReviewRubricField[] = [];
  const seen = new Set<string>();
  for (const criterion of criteria) {
    if (criterion === null || typeof criterion !== "object" || Array.isArray(criterion)) {
      return fail("READ_FAILED");
    }
    const value = criterion as Record<string, unknown>;
    const id = storedIdentifier(value.semantic);
    if (seen.has(id)) return fail("READ_FAILED");
    seen.add(id);
    const kind = value.kind;
    const required = value.required;
    const weight = value.weight;
    if (
      (kind !== "numeric" && kind !== "scale" && kind !== "yesNo" &&
        kind !== "recommendation" && kind !== "comment") ||
      typeof required !== "boolean" ||
      typeof weight !== "number" ||
      !Number.isFinite(weight)
    ) {
      return fail("READ_FAILED");
    }
    const base = {
      id,
      label: id,
      guidance: "",
      required,
      weight,
    };
    if (kind === "numeric") {
      const minimum = finiteNumber(value.minimum, "READ_FAILED");
      const maximum = finiteNumber(value.maximum, "READ_FAILED");
      const step = finiteNumber(value.step, "READ_FAILED");
      fields.push(Object.freeze({
        ...base,
        kind: "numeric" as const,
        recommendation: false,
        minimum,
        maximum,
        step,
        choices: Object.freeze([]),
        maxLength: null,
      }));
    } else if (kind === "comment") {
      fields.push(Object.freeze({
        ...base,
        kind: "text" as const,
        recommendation: false,
        minimum: null,
        maximum: null,
        step: null,
        choices: Object.freeze([]),
        maxLength: safeInteger(value.maxLength, "READ_FAILED"),
      }));
    } else {
      const choices = kind === "recommendation"
        ? [
            { value: "ADVANCE", label: "Advance for further consideration" },
            { value: "HOLD", label: "Hold for further consideration" },
            { value: "DO_NOT_ADVANCE", label: "Do not advance for further consideration" },
          ]
        : kind === "yesNo"
          ? [{ value: "YES", label: "Yes" }, { value: "NO", label: "No" }]
          : [{ value: "LOW", label: "Low" }, { value: "MEDIUM", label: "Medium" }, { value: "HIGH", label: "High" }];
      fields.push(Object.freeze({
        ...base,
        kind: "dropdown" as const,
        recommendation: kind === "recommendation",
        minimum: null,
        maximum: null,
        step: null,
        choices: Object.freeze(choices),
        maxLength: null,
      }));
    }
  }
  return Object.freeze(fields);
}

function rubricSummary(
  db: Db,
  organizer: OrganizerAuth,
  roundId: string,
  rubricVersionId?: string,
): OrganizerReviewRubricSummary | null {
  const row = db
    .prepare(
      `SELECT id, round_id, version_number, rubric_schema, rubric_json,
              fingerprint_algorithm, fingerprint, sealed_at
       FROM rubric_versions
       WHERE workspace_id = ? AND round_id = ?
         AND (? IS NULL OR id = ?)
       ORDER BY version_number DESC, id DESC
       LIMIT 1`,
    )
    .get(
      organizer.workspaceId,
      roundId,
      rubricVersionId ?? null,
      rubricVersionId ?? null,
    ) as RubricVersionRow | undefined;
  if (!row) return null;
  const id = storedIdentifier(row.id);
  const boundRoundId = storedIdentifier(row.round_id);
  const versionNumber = safeInteger(row.version_number, "READ_FAILED");
  const fingerprint = text(row.fingerprint, 64);
  const sealedAt = canonicalTimestamp(row.sealed_at, "READ_FAILED");
  if (
    boundRoundId !== roundId ||
    row.rubric_schema !== "cfp-rubric/v1" ||
    row.fingerprint_algorithm !== "sha256-canonical-json-v1" ||
    !/^[a-f0-9]{64}$/u.test(fingerprint) ||
    versionNumber < 1
  ) {
    return fail("READ_FAILED");
  }

  let fields: readonly OrganizerReviewRubricField[];
  let customDocument = false;
  if (typeof row.rubric_json === "string") {
    try {
      const parsed = JSON.parse(row.rubric_json) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).schema === ORGANIZER_REVIEW_RUBRIC_DOCUMENT_SCHEMA
      ) {
        const document = storedRubricDocument(row.rubric_json);
        if (fingerprintOf(document) !== fingerprint) return fail("READ_FAILED");
        fields = document.fields;
        customDocument = true;
      } else {
        fields = legacyRubricFields(db, organizer.workspaceId, id);
      }
    } catch (error) {
      if (error instanceof OrganizerReviewServiceError) throw error;
      return fail("READ_FAILED");
    }
  } else {
    return fail("READ_FAILED");
  }
  const semantics = db
    .prepare(
      `SELECT id FROM review_rubric_semantics
       WHERE workspace_id = ? AND rubric_version_id = ?
       LIMIT 1`,
    )
    .get(organizer.workspaceId, id) as { id: unknown } | undefined;
  const semanticsId = semantics ? storedIdentifier(semantics.id) : null;
  return Object.freeze({
    id,
    roundId,
    versionNumber,
    fingerprint,
    sealedAt,
    semanticsId,
    fields,
    reviewerProjection: null,
    custom: customDocument,
  });
}

function conflictStatus(action: unknown, code: OrganizerReviewServiceErrorCode): OrganizerReviewConflictStatus {
  if (action === null || action === undefined) return "NONE";
  if (action === "DECLARE") return "DECLARED";
  if (action === "CLEAR") return "CLEARED";
  if (action === "WAIVE") return "WAIVED";
  return fail(code);
}

function assignmentProjection(row: AssignmentRow): OrganizerReviewAssignment {
  const id = storedIdentifier(row.assignment_id);
  const roundId = storedIdentifier(row.round_id);
  const submissionId = storedIdentifier(row.submission_id);
  const submissionRevisionId = storedIdentifier(row.submission_revision_id);
  const reviewerAccountId = storedIdentifier(row.reviewer_account_id);
  const assignmentStateSequenceNumber = safeInteger(row.assignment_state_sequence, "READ_FAILED");
  const latestReviewRevisionNumber = row.review_revision_number === null
    ? 0
    : safeInteger(row.review_revision_number, "READ_FAILED");
  const conflictSequenceNumber = row.conflict_sequence === null
    ? 0
    : safeInteger(row.conflict_sequence, "READ_FAILED");
  const assignmentState = row.assignment_state;
  if (
    assignmentState !== "ASSIGNED" &&
    assignmentState !== "IN_PROGRESS" &&
    assignmentState !== "SUBMITTED" &&
    assignmentState !== "RECUSED" &&
    assignmentState !== "REVOKED"
  ) {
    return fail("READ_FAILED");
  }
  const personId = storedIdentifier(row.person_id);
  const organization = row.organization === null ? null : text(row.organization, 512);
  if (
    roundId === null ||
    submissionId === null ||
    submissionRevisionId === null ||
    reviewerAccountId === null ||
    personId === null ||
    assignmentStateSequenceNumber < 1 ||
    latestReviewRevisionNumber < 0 ||
    conflictSequenceNumber < 0
  ) {
    return fail("READ_FAILED");
  }
  return Object.freeze({
    id,
    roundId,
    submissionId,
    submissionRevisionId,
    reviewerAccountId,
    reviewerName: text(row.reviewer_name, 512),
    assignmentState,
    assignmentStateSequenceNumber,
    conflictStatus: conflictStatus(row.conflict_action, "READ_FAILED"),
    conflictSequenceNumber,
    latestReviewRevisionNumber,
    blindArtifactReady: row.blind_artifact_id !== null,
    assignedAt: canonicalTimestamp(row.assigned_at, "READ_FAILED"),
    applicant: Object.freeze({
      personId,
      displayName: text(row.person_name, 512),
      organization,
    }),
  });
}

function assignmentProjections(
  db: Db,
  organizer: OrganizerAuth,
  roundId: string,
  evidence: ReadonlyMap<string, ParsedReviewEvidence> = new Map(),
): readonly OrganizerReviewAssignment[] {
  const rows = db
    .prepare(
      `SELECT assignment.id AS assignment_id,
              assignment.round_id,
              assignment.submission_id,
              assignment.submission_revision_id,
              assignment.reviewer_account_id,
              reviewer.display_name AS reviewer_name,
              state.state AS assignment_state,
              state.sequence_number AS assignment_state_sequence,
              conflict.action AS conflict_action,
              conflict.sequence_number AS conflict_sequence,
              revision.revision_number AS review_revision_number,
              artifact.id AS blind_artifact_id,
              assignment.created_at AS assigned_at,
              person.id AS person_id,
              person.full_name AS person_name,
              person.organization
       FROM review_assignments assignment
       JOIN accounts reviewer
         ON reviewer.id = assignment.reviewer_account_id
        AND reviewer.workspace_id = assignment.workspace_id
       JOIN submissions submission
         ON submission.id = assignment.submission_id
        AND submission.workspace_id = assignment.workspace_id
       JOIN people person
         ON person.id = submission.owner_person_id
        AND person.workspace_id = assignment.workspace_id
       LEFT JOIN review_assignment_states state
         ON state.assignment_id = assignment.id
        AND state.sequence_number = (
          SELECT MAX(candidate.sequence_number)
          FROM review_assignment_states candidate
          WHERE candidate.workspace_id = assignment.workspace_id
            AND candidate.assignment_id = assignment.id
        )
       LEFT JOIN review_conflict_dispositions conflict
         ON conflict.assignment_id = assignment.id
        AND conflict.sequence_number = (
          SELECT MAX(candidate.sequence_number)
          FROM review_conflict_dispositions candidate
          WHERE candidate.workspace_id = assignment.workspace_id
            AND candidate.assignment_id = assignment.id
        )
       LEFT JOIN review_revisions revision
         ON revision.assignment_id = assignment.id
        AND revision.revision_number = (
          SELECT MAX(candidate.revision_number)
          FROM review_revisions candidate
          WHERE candidate.workspace_id = assignment.workspace_id
            AND candidate.assignment_id = assignment.id
        )
       LEFT JOIN review_blind_artifacts artifact
         ON artifact.assignment_id = assignment.id
        AND artifact.workspace_id = assignment.workspace_id
       WHERE assignment.workspace_id = ? AND assignment.round_id = ?
       ORDER BY assignment.submission_id ASC, assignment.created_at ASC, assignment.id ASC`,
    )
    .all(organizer.workspaceId, roundId) as AssignmentRow[];
  return Object.freeze(rows.map((row) => {
    const assignment = assignmentProjection(row);
    const review = evidence.get(assignment.id);
    if (
      review &&
      (assignment.assignmentState !== "SUBMITTED" ||
        assignment.latestReviewRevisionNumber !== review.revisionNumber)
    ) {
      return fail("READ_FAILED");
    }
    const latestSubmittedReview = assignment.assignmentState === "SUBMITTED" &&
      assignment.conflictStatus !== "DECLARED"
      ? submittedReviewProjection(review?.rubricFields ?? null, review)
      : null;
    return Object.freeze({ ...assignment, latestSubmittedReview });
  }));
}

function reminderProjections(
  schedule: OrganizerReviewRound["schedule"],
  assignments: readonly OrganizerReviewAssignment[],
): readonly OrganizerReviewReminder[] {
  const reminders: OrganizerReviewReminder[] = [];
  for (const assignment of assignments) {
    if (
      assignment.assignmentState === "SUBMITTED" ||
      assignment.assignmentState === "RECUSED" ||
      assignment.assignmentState === "REVOKED" ||
      assignment.conflictStatus === "DECLARED"
    ) {
      continue;
    }
    const dueAt = schedule.closesAt;
    const status = dueAt === null
      ? "NOT_SCHEDULED" as const
      : Date.parse(dueAt) <= Date.now()
        ? "DUE" as const
        : "UPCOMING" as const;
    reminders.push(Object.freeze({
      assignmentId: assignment.id,
      submissionId: assignment.submissionId,
      reviewerAccountId: assignment.reviewerAccountId,
      reviewerName: assignment.reviewerName,
      dueAt,
      status,
      channel: "local-evidence" as const,
      reason: dueAt === null
        ? "No authoritative call close is scheduled."
        : status === "DUE"
          ? `The assignment has no submitted review by the ${schedule.source === "round" ? "review-round" : "call"} close.`
          : `The assignment is awaiting an independent review before the ${schedule.source === "round" ? "review-round" : "call"} close.`,
    }));
  }
  return Object.freeze(reminders);
}

export function organizerReviewReminderSubject(
  roundId: string,
  assignmentId: string,
  schedule: Readonly<{
    readonly version?: number;
    readonly timezone: string;
    readonly closesAt: string | null;
  }>,
): string {
  return fingerprintOf({
    schema: "cfp-organizer-review-reminder-subject/v1",
    roundId,
    assignmentId,
    scheduleVersion: schedule.version ?? 1,
    timezone: schedule.timezone,
    closesAt: schedule.closesAt,
  });
}

function localEvidenceRows(
  db: Db,
  organizer: OrganizerAuth,
  roundId: string,
): readonly OrganizerReviewLocalEvidence[] {
  const rows = db
    .prepare(
      `SELECT details_json, created_at
       FROM audit_events
       WHERE workspace_id = ?
         AND action = 'cfp.review.local-evidence'
         AND target_type = 'review_round'
         AND target_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(organizer.workspaceId, roundId) as LocalEvidenceRow[];
  const evidence: OrganizerReviewLocalEvidence[] = [];
  for (const row of rows) {
    if (typeof row.details_json !== "string") return fail("READ_FAILED");
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.details_json);
    } catch {
      return fail("READ_FAILED");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("READ_FAILED");
    }
    const value = parsed as Record<string, unknown>;
    const schema = value.schema;
    const kind = value.kind;
    if (
      schema !== ORGANIZER_REVIEW_EVIDENCE_SCHEMA ||
      (kind !== "DISTRIBUTION_PLANNED" &&
        kind !== "REMINDER_PLANNED" &&
        kind !== "EXPORT_CREATED" &&
        kind !== "ASSIGNMENT_RECUSED")
    ) {
      return fail("READ_FAILED");
    }
    const workspaceId = storedIdentifier(value.workspaceId);
    const evidenceRoundId = storedIdentifier(value.roundId);
    const subjectId = storedIdentifier(value.subjectId);
    const fingerprint = text(value.fingerprint, 64);
    const recordedAt = canonicalTimestamp(value.recordedAt, "READ_FAILED");
    if (!Object.hasOwn(value, "payload")) return fail("READ_FAILED");
    if (
      workspaceId !== organizer.workspaceId ||
      evidenceRoundId !== roundId ||
      !/^[a-f0-9]{64}$/u.test(fingerprint)
    ) {
      return fail("READ_FAILED");
    }
    if (
      fingerprintOf({
        schema,
        kind,
        workspaceId,
        roundId: evidenceRoundId,
        subjectId,
        payload: value.payload,
        recordedAt,
      }) !== fingerprint
    ) {
      return fail("READ_FAILED");
    }
    evidence.push(Object.freeze({
      schema: ORGANIZER_REVIEW_EVIDENCE_SCHEMA,
      kind,
      workspaceId,
      roundId: evidenceRoundId,
      subjectId,
      fingerprint,
      recordedAt,
    }));
  }
  return Object.freeze(evidence);
}

function writeLocalEvidence(
  db: Db,
  organizer: OrganizerAuth,
  roundId: string,
  kind: OrganizerReviewLocalEvidence["kind"],
  subjectId: string,
  payload: unknown,
): OrganizerReviewLocalEvidence {
  const recordedAt = nowIso();
  const fingerprint = fingerprintOf({
    schema: ORGANIZER_REVIEW_EVIDENCE_SCHEMA,
    kind,
    workspaceId: organizer.workspaceId,
    roundId,
    subjectId,
    payload,
    recordedAt,
  });
  const evidence = Object.freeze({
    schema: ORGANIZER_REVIEW_EVIDENCE_SCHEMA,
    kind,
    workspaceId: organizer.workspaceId,
    roundId,
    subjectId,
    fingerprint,
    recordedAt,
  });
  writeAudit(db, organizer.workspaceId, {
    actorKind: "account",
    actorRef: organizer.accountId,
    action: "cfp.review.local-evidence",
    targetType: "review_round",
    targetId: roundId,
    details: {
      ...evidence,
      payload,
    },
  });
  return evidence;
}

type DistributionIdempotencyMatch = Readonly<{
  readonly evidence: OrganizerReviewLocalEvidence;
  readonly plan: OrganizerReviewDistributionPlan;
  readonly assignmentIds: readonly string[];
  readonly blindArtifactIds: readonly string[];
  readonly blindArtifactAssignmentIds: readonly string[];
  readonly blindArtifactPendingAssignmentIds: readonly string[];
}>;

function distributionReplayPlan(
  value: unknown,
  roundId: string,
  expectedFingerprint: string,
): OrganizerReviewDistributionPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("READ_FAILED");
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 5 ||
    !Object.hasOwn(candidate, "roundId") ||
    !Object.hasOwn(candidate, "strategy") ||
    !Object.hasOwn(candidate, "assignments") ||
    !Object.hasOwn(candidate, "skippedSubmissionIds") ||
    !Object.hasOwn(candidate, "fingerprint")
  ) {
    return fail("READ_FAILED");
  }
  if (storedIdentifier(candidate.roundId) !== roundId) return fail("READ_FAILED");
  if (candidate.strategy !== "balanced" && candidate.strategy !== "round_robin") {
    return fail("READ_FAILED");
  }
  const fingerprint = text(candidate.fingerprint, 64);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || fingerprint !== expectedFingerprint) {
    return fail("READ_FAILED");
  }
  if (
    !Array.isArray(candidate.assignments) ||
    candidate.assignments.length > MAX_DISTRIBUTION_SUBMISSIONS * 32
  ) {
    return fail("READ_FAILED");
  }
  const pairs = new Set<string>();
  const assignments = candidate.assignments.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail("READ_FAILED");
    }
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 4 ||
      !Object.hasOwn(entry, "submissionId") ||
      !Object.hasOwn(entry, "submissionRevisionId") ||
      !Object.hasOwn(entry, "reviewerAccountId") ||
      !Object.hasOwn(entry, "poolId")
    ) {
      return fail("READ_FAILED");
    }
    const submissionId = storedIdentifier(entry.submissionId);
    const submissionRevisionId = storedIdentifier(entry.submissionRevisionId);
    const reviewerAccountId = storedIdentifier(entry.reviewerAccountId);
    const poolId = entry.poolId === null ? null : storedIdentifier(entry.poolId);
    const pair = reviewerSubmissionPairKey(submissionId, reviewerAccountId);
    if (pairs.has(pair)) return fail("READ_FAILED");
    pairs.add(pair);
    return Object.freeze({
      submissionId,
      submissionRevisionId,
      reviewerAccountId,
      poolId,
    });
  });
  if (
    !Array.isArray(candidate.skippedSubmissionIds) ||
    candidate.skippedSubmissionIds.length > MAX_DISTRIBUTION_SUBMISSIONS
  ) {
    return fail("READ_FAILED");
  }
  const skippedSubmissionIds = candidate.skippedSubmissionIds.map((value) => storedIdentifier(value));
  if (new Set(skippedSubmissionIds).size !== skippedSubmissionIds.length) return fail("READ_FAILED");
  return Object.freeze({
    roundId,
    strategy: candidate.strategy,
    assignments: Object.freeze(assignments),
    skippedSubmissionIds: Object.freeze(skippedSubmissionIds),
    fingerprint,
  });
}

function validateDistributionReplayPlanFingerprint(
  payload: Record<string, unknown>,
  plan: OrganizerReviewDistributionPlan,
): void {
  if (payload.strategy !== plan.strategy) return fail("READ_FAILED");
  const reviewsPerSubmission = safeInteger(payload.reviewsPerSubmission, "READ_FAILED");
  const maxAssignmentsPerReviewer = safeInteger(payload.maxAssignmentsPerReviewer, "READ_FAILED");
  if (
    reviewsPerSubmission < 1 || reviewsPerSubmission > 32 ||
    maxAssignmentsPerReviewer < 1 || maxAssignmentsPerReviewer > MAX_ASSIGNMENTS_PER_REVIEWER ||
    !Array.isArray(payload.pools) || payload.pools.length === 0 ||
    payload.pools.length > MAX_DISTRIBUTION_REVIEWERS
  ) {
    return fail("READ_FAILED");
  }
  const poolIds = new Set<string>();
  const reviewerIds = new Set<string>();
  const pools = payload.pools.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail("READ_FAILED");
    }
    const pool = value as Record<string, unknown>;
    if (
      Object.keys(pool).length !== 3 ||
      !Object.hasOwn(pool, "id") ||
      !Object.hasOwn(pool, "reviewerAccountIds") ||
      !Object.hasOwn(pool, "maxAssignments") ||
      !Array.isArray(pool.reviewerAccountIds) ||
      pool.reviewerAccountIds.length === 0 ||
      pool.reviewerAccountIds.length > MAX_DISTRIBUTION_REVIEWERS
    ) {
      return fail("READ_FAILED");
    }
    const id = storedIdentifier(pool.id);
    if (poolIds.has(id)) return fail("READ_FAILED");
    poolIds.add(id);
    const reviewers = pool.reviewerAccountIds.map((reviewer) => storedIdentifier(reviewer));
    if (
      new Set(reviewers).size !== reviewers.length ||
      reviewers.some((reviewer) => reviewerIds.has(reviewer))
    ) {
      return fail("READ_FAILED");
    }
    reviewers.forEach((reviewer) => reviewerIds.add(reviewer));
    const maxAssignments = safeInteger(pool.maxAssignments, "READ_FAILED");
    if (maxAssignments < 1 || maxAssignments > MAX_ASSIGNMENTS_PER_REVIEWER * reviewers.length) {
      return fail("READ_FAILED");
    }
    return Object.freeze({ id, reviewerAccountIds: Object.freeze(reviewers), maxAssignments });
  });
  if (!Array.isArray(payload.skippedSubmissionIds)) return fail("READ_FAILED");
  const skippedSubmissionIds = payload.skippedSubmissionIds.map((value) => storedIdentifier(value));
  if (
    skippedSubmissionIds.length !== plan.skippedSubmissionIds.length ||
    skippedSubmissionIds.some((value, index) => value !== plan.skippedSubmissionIds[index])
  ) {
    return fail("READ_FAILED");
  }
  const scheduleVersion = safeInteger(payload.scheduleVersion, "READ_FAILED");
  if (scheduleVersion < 1) return fail("READ_FAILED");
  const scheduleTimezone = text(payload.timezone, 128);
  const scheduleClosesAt = canonicalTimestamp(payload.closesAt, "READ_FAILED");
  const computed = fingerprintOf({
    schema: "cfp-organizer-review-distribution-plan/v1",
    roundId: plan.roundId,
    strategy: plan.strategy,
    reviewsPerSubmission,
    maxAssignmentsPerReviewer,
    pools,
    assignments: plan.assignments,
    skippedSubmissionIds,
    scheduleVersion,
    scheduleTimezone,
    scheduleClosesAt,
  });
  if (computed !== plan.fingerprint) return fail("READ_FAILED");
}

function distributionIdempotencyEvidence(
  db: Db,
  organizer: OrganizerAuth,
  roundId: string,
  idempotencyKey: string,
  requestFingerprint: string,
): DistributionIdempotencyMatch | null {
  const rows = db
    .prepare(
      `SELECT details_json
       FROM audit_events
       WHERE workspace_id = ?
         AND actor_kind = 'account'
         AND actor_ref = ?
         AND action = 'cfp.review.local-evidence'
         AND target_type = 'review_round'
         AND target_id = ?
       ORDER BY rowid ASC`,
    )
    .all(organizer.workspaceId, organizer.accountId, roundId) as LocalEvidenceRow[];
  let match: DistributionIdempotencyMatch | null = null;
  for (const row of rows) {
    if (typeof row.details_json !== "string") return fail("READ_FAILED");
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.details_json);
    } catch {
      return fail("READ_FAILED");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("READ_FAILED");
    }
    const value = parsed as Record<string, unknown>;
    if (value.schema !== ORGANIZER_REVIEW_EVIDENCE_SCHEMA || value.kind !== "DISTRIBUTION_PLANNED") {
      continue;
    }
    const payload = value.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return fail("READ_FAILED");
    }
    const payloadRecord = payload as Record<string, unknown>;
    if (payloadRecord.idempotencyKey !== idempotencyKey) continue;
    if (text(payloadRecord.requestFingerprint, 64) !== requestFingerprint) {
      return fail("DISTRIBUTION_IDEMPOTENCY_CONFLICT");
    }
    if (match !== null) return fail("READ_FAILED");
    const workspaceId = storedIdentifier(value.workspaceId);
    const evidenceRoundId = storedIdentifier(value.roundId);
    const subjectId = storedIdentifier(value.subjectId);
    const fingerprint = text(value.fingerprint, 64);
    const recordedAt = canonicalTimestamp(value.recordedAt, "READ_FAILED");
    if (
      workspaceId !== organizer.workspaceId ||
      evidenceRoundId !== roundId ||
      !/^[a-f0-9]{64}$/u.test(subjectId) ||
      !/^[a-f0-9]{64}$/u.test(fingerprint)
    ) {
      return fail("READ_FAILED");
    }
    if (
      fingerprintOf({
        schema: value.schema,
        kind: value.kind,
        workspaceId,
        roundId: evidenceRoundId,
        subjectId,
        payload,
        recordedAt,
      }) !== fingerprint
    ) {
      return fail("READ_FAILED");
    }
    const command = payloadRecord.command;
    if (
      command === null ||
      typeof command !== "object" ||
      Array.isArray(command) ||
      Object.keys(command).length !== 3 ||
      !Object.hasOwn(command, "schema") ||
      !Object.hasOwn(command, "idempotencyKey") ||
      !Object.hasOwn(command, "requestFingerprint")
    ) {
      return fail("READ_FAILED");
    }
    const commandRecord = command as Record<string, unknown>;
    if (
      commandRecord.schema !== "cfp-organizer-review-distribution-command/v1" ||
      commandRecord.idempotencyKey !== idempotencyKey ||
      text(commandRecord.requestFingerprint, 64) !== requestFingerprint
    ) {
      return fail("READ_FAILED");
    }
    const plan = distributionReplayPlan(payloadRecord.plan, roundId, subjectId);
    validateDistributionReplayPlanFingerprint(payloadRecord, plan);
    const planAuthority = payloadRecord.planAuthority;
    if (
      planAuthority === null ||
      typeof planAuthority !== "object" ||
      Array.isArray(planAuthority) ||
      Object.keys(planAuthority).length !== 2 ||
      !Object.hasOwn(planAuthority, "schema") ||
      !Object.hasOwn(planAuthority, "fingerprint")
    ) {
      return fail("READ_FAILED");
    }
    const planAuthorityRecord = planAuthority as Record<string, unknown>;
    if (
      planAuthorityRecord.schema !== "cfp-organizer-review-distribution-plan/v1" ||
      text(planAuthorityRecord.fingerprint, 64) !== subjectId
    ) {
      return fail("READ_FAILED");
    }
    if (!Array.isArray(payloadRecord.assignmentIds) || payloadRecord.assignmentIds.length !== plan.assignments.length) {
      return fail("READ_FAILED");
    }
    const assignmentIds = payloadRecord.assignmentIds.map((value) => storedIdentifier(value));
    if (new Set(assignmentIds).size !== assignmentIds.length) return fail("READ_FAILED");
    if (
      !Array.isArray(payloadRecord.assignmentBindings) ||
      payloadRecord.assignmentBindings.length !== plan.assignments.length
    ) {
      return fail("READ_FAILED");
    }
    payloadRecord.assignmentBindings.forEach((value, index) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return fail("READ_FAILED");
      }
      const binding = value as Record<string, unknown>;
      if (
        Object.keys(binding).length !== 4 ||
        !Object.hasOwn(binding, "assignmentId") ||
        !Object.hasOwn(binding, "submissionId") ||
        !Object.hasOwn(binding, "submissionRevisionId") ||
        !Object.hasOwn(binding, "reviewerAccountId")
      ) {
        return fail("READ_FAILED");
      }
      const planned = plan.assignments[index];
      if (
        !planned ||
        storedIdentifier(binding.assignmentId) !== assignmentIds[index] ||
        storedIdentifier(binding.submissionId) !== planned.submissionId ||
        storedIdentifier(binding.submissionRevisionId) !== planned.submissionRevisionId ||
        storedIdentifier(binding.reviewerAccountId) !== planned.reviewerAccountId
      ) {
        return fail("READ_FAILED");
      }
    });
    if (
      !Array.isArray(payloadRecord.blindArtifactIds) ||
      payloadRecord.blindArtifactIds.length !== plan.assignments.length
    ) {
      return fail("READ_FAILED");
    }
    const blindArtifactIds = payloadRecord.blindArtifactIds.map((value) => storedIdentifier(value));
    if (new Set(blindArtifactIds).size !== blindArtifactIds.length) return fail("READ_FAILED");
    if (
      !Array.isArray(payloadRecord.blindArtifactAssignmentIds) ||
      payloadRecord.blindArtifactAssignmentIds.length !== blindArtifactIds.length
    ) {
      return fail("READ_FAILED");
    }
    const blindArtifactAssignmentIds = payloadRecord.blindArtifactAssignmentIds.map((value) => storedIdentifier(value));
    if (
      new Set(blindArtifactAssignmentIds).size !== blindArtifactAssignmentIds.length ||
      blindArtifactAssignmentIds.some(
        (assignmentId, index) => assignmentId !== assignmentIds[index],
      )
    ) {
      return fail("READ_FAILED");
    }
    if (
      !Array.isArray(payloadRecord.blindArtifactPendingAssignmentIds) ||
      payloadRecord.blindArtifactPendingAssignmentIds.length !== 0
    ) {
      return fail("READ_FAILED");
    }
    const blindArtifactPendingAssignmentIds = payloadRecord.blindArtifactPendingAssignmentIds.map((value) => storedIdentifier(value));
    if (blindArtifactPendingAssignmentIds.length !== 0) {
      return fail("READ_FAILED");
    }
    match = Object.freeze({
      evidence: Object.freeze({
        schema: ORGANIZER_REVIEW_EVIDENCE_SCHEMA,
        kind: "DISTRIBUTION_PLANNED",
        workspaceId,
        roundId: evidenceRoundId,
        subjectId,
        fingerprint,
        recordedAt,
      }),
      plan,
      assignmentIds: Object.freeze(assignmentIds),
      blindArtifactIds: Object.freeze(blindArtifactIds),
      blindArtifactAssignmentIds: Object.freeze(blindArtifactAssignmentIds),
      blindArtifactPendingAssignmentIds: Object.freeze(blindArtifactPendingAssignmentIds),
    });
  }
  return match;
}

type EvaluationValue = string | number | boolean;

type ParsedReviewEvidence = Readonly<{
  assignmentId: string;
  revisionNumber: number;
  rubricVersionId: string;
  submissionRevisionId: string;
  rubricFields: readonly OrganizerReviewRubricField[];
  customRubric: boolean;
  responses: ReadonlyMap<string, EvaluationValue>;
}>;

function reviewEvidence(
  db: Db,
  organizer: OrganizerAuth,
  roundId: string,
): ReadonlyMap<string, ParsedReviewEvidence> {
  const rows = db
    .prepare(
      `SELECT revision.id AS review_revision_id,
              revision.assignment_id,
              assignment.rubric_version_id AS assignment_rubric_version_id,
              assignment.submission_id AS assignment_submission_id,
              assignment.submission_revision_id AS assignment_submission_revision_id,
              revision.submission_id,
              revision.submission_revision_id,
              revision.round_id,
              revision.rubric_version_id,
              assignment.reviewer_account_id,
              revision.revision_number,
              revision.evaluation_schema,
              revision.evaluation_json,
              revision.fingerprint_algorithm,
              revision.fingerprint
       FROM review_revisions revision
       JOIN review_assignments assignment
         ON assignment.id = revision.assignment_id
        AND assignment.workspace_id = revision.workspace_id
        AND assignment.round_id = ?
       JOIN review_assignment_states latest_state
         ON latest_state.assignment_id = assignment.id
        AND latest_state.workspace_id = assignment.workspace_id
        AND latest_state.sequence_number = (
          SELECT MAX(candidate.sequence_number)
          FROM review_assignment_states candidate
          WHERE candidate.workspace_id = assignment.workspace_id
            AND candidate.assignment_id = assignment.id
        )
        AND latest_state.state = 'SUBMITTED'
       WHERE revision.workspace_id = ?
         AND revision.revision_number = (
           SELECT MAX(candidate.revision_number)
           FROM review_revisions candidate
           WHERE candidate.workspace_id = revision.workspace_id
             AND candidate.assignment_id = revision.assignment_id
         )`,
    )
    .all(roundId, organizer.workspaceId) as ReviewEvidenceRow[];
  const parsed = new Map<string, ParsedReviewEvidence>();
  for (const row of rows) {
    const reviewRevisionId = storedIdentifier(row.review_revision_id);
    const assignmentId = storedIdentifier(row.assignment_id);
    const assignmentRubricVersionId = storedIdentifier(row.assignment_rubric_version_id);
    const assignmentSubmissionId = storedIdentifier(row.assignment_submission_id);
    const assignmentSubmissionRevisionId = storedIdentifier(row.assignment_submission_revision_id);
    const submissionId = storedIdentifier(row.submission_id);
    const submissionRevisionId = storedIdentifier(row.submission_revision_id);
    const roundIdFromRevision = storedIdentifier(row.round_id);
    const rubricVersionId = storedIdentifier(row.rubric_version_id);
    const reviewerAccountId = storedIdentifier(row.reviewer_account_id);
    const revisionNumber = safeInteger(row.revision_number, "READ_FAILED");
    const fingerprint = text(row.fingerprint, 64);
    if (
      reviewRevisionId === null ||
      assignmentId === null ||
      assignmentRubricVersionId === null ||
      assignmentSubmissionId === null ||
      assignmentSubmissionRevisionId === null ||
      submissionId === null ||
      submissionRevisionId === null ||
      roundIdFromRevision === null ||
      rubricVersionId === null ||
      reviewerAccountId === null ||
      revisionNumber < 1 ||
      row.evaluation_schema !== "cfp-review-evaluation/v1" ||
      row.fingerprint_algorithm !== "sha256-canonical-json-v1" ||
      !/^[a-f0-9]{64}$/u.test(fingerprint) ||
      typeof row.evaluation_json !== "string" ||
      Buffer.byteLength(row.evaluation_json, "utf8") > 4 * 1024 * 1024 ||
      roundIdFromRevision !== roundId ||
      assignmentRubricVersionId !== rubricVersionId ||
      assignmentSubmissionId !== submissionId ||
      assignmentSubmissionRevisionId !== submissionRevisionId
    ) {
      return fail("READ_FAILED");
    }
    const reviewRubric = rubricSummary(
      db,
      organizer,
      roundId,
      assignmentRubricVersionId,
    );
    if (!reviewRubric) return fail("READ_FAILED");
    let value: unknown;
    try {
      value = JSON.parse(row.evaluation_json);
    } catch {
      return fail("READ_FAILED");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail("READ_FAILED");
    }
    const document = value as Record<string, unknown>;
    if (
      Object.keys(document).length !== 6 ||
      document.schema !== "cfp-review-evaluation/v1" ||
      document.assignmentId !== assignmentId ||
      document.rubricVersionId !== rubricVersionId ||
      document.submissionRevisionId !== submissionRevisionId ||
      document.reviewRevisionNumber !== revisionNumber ||
      !Array.isArray(document.responses) ||
      !Object.hasOwn(document, "rubricVersionId") ||
      !Object.hasOwn(document, "submissionRevisionId") ||
      !Object.hasOwn(document, "reviewRevisionNumber") ||
      fingerprintOf(document) !== fingerprint
    ) {
      return fail("READ_FAILED");
    }
    const documentKeys = new Set([
      "schema",
      "assignmentId",
      "rubricVersionId",
      "submissionRevisionId",
      "reviewRevisionNumber",
      "responses",
    ]);
    if (Object.keys(document).some((key) => !documentKeys.has(key))) {
      return fail("READ_FAILED");
    }
    if (document.responses.length > MAX_RUBRIC_FIELDS) return fail("READ_FAILED");
    const responses = new Map<string, EvaluationValue>();
    for (const response of document.responses) {
      if (response === null || typeof response !== "object" || Array.isArray(response)) {
        return fail("READ_FAILED");
      }
      const candidate = response as Record<string, unknown>;
      const criterionId = storedIdentifier(candidate.criterionId);
      const responseValue = candidate.value;
      if (
        Object.keys(candidate).length !== 2 ||
        !Object.hasOwn(candidate, "criterionId") ||
        !Object.hasOwn(candidate, "value") ||
        criterionId === null ||
        (typeof responseValue !== "string" &&
          typeof responseValue !== "number" &&
          typeof responseValue !== "boolean") ||
        responses.has(criterionId)
      ) {
        return fail("READ_FAILED");
      }
      responses.set(criterionId, responseValue);
    }
    if (parsed.has(assignmentId)) return fail("READ_FAILED");
    parsed.set(assignmentId, Object.freeze({
      assignmentId,
      revisionNumber,
      rubricVersionId,
      submissionRevisionId,
      rubricFields: reviewRubric.fields,
      customRubric: reviewRubric.custom === true,
      responses,
    }));
  }
  return parsed;
}

function numericStepMatches(value: number, minimum: number, step: number): boolean {
  const quotient = (value - minimum) / step;
  const nearest = Math.round(quotient);
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(quotient));
  return Math.abs(quotient - nearest) <= tolerance;
}

function reviewComment(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    [...value].length > maxLength ||
    Buffer.byteLength(value, "utf8") > 64 * 1024 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return fail("READ_FAILED");
  }
  return value;
}

function responseForField(
  review: ParsedReviewEvidence,
  field: OrganizerReviewRubricField,
  index: number,
  consumed: Set<string>,
): EvaluationValue | undefined {
  const positionalId = `criterion-${String(index + 1).padStart(4, "0")}`;
  const exact = review.responses.get(field.id);
  const positional = review.customRubric || positionalId === field.id
    ? undefined
    : review.responses.get(positionalId);
  if (exact !== undefined && positional !== undefined) return fail("READ_FAILED");
  if (exact !== undefined) {
    consumed.add(field.id);
    return exact;
  }
  if (positional !== undefined) {
    consumed.add(positionalId);
    return positional;
  }
  return undefined;
}

function submittedReviewProjection(
  rubricFields: readonly OrganizerReviewRubricField[] | null,
  review: ParsedReviewEvidence | undefined,
): OrganizerReviewSubmittedReview | null {
  if (!review) return null;
  if (!rubricFields) return fail("READ_FAILED");

  const consumed = new Set<string>();
  const criteria: OrganizerReviewSubmittedCriterion[] = [];
  rubricFields.forEach((field, index) => {
    const value = responseForField(review, field, index, consumed);
    if (value === undefined) {
      if (field.required) return fail("READ_FAILED");
      criteria.push(Object.freeze({
        criterionId: field.id,
        label: field.label,
        kind: field.kind,
        value: null,
        choiceLabel: null,
      }));
      return;
    }

    if (field.kind === "numeric") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        field.minimum === null ||
        field.maximum === null ||
        field.step === null ||
        value < field.minimum ||
        value > field.maximum ||
        !numericStepMatches(value, field.minimum, field.step)
      ) {
        return fail("READ_FAILED");
      }
      criteria.push(Object.freeze({
        criterionId: field.id,
        label: field.label,
        kind: field.kind,
        value,
        choiceLabel: null,
      }));
      return;
    }

    if (field.kind === "dropdown") {
      const normalizedValue = typeof value === "boolean"
        ? value ? "YES" : "NO"
        : value;
      if (typeof normalizedValue !== "string") return fail("READ_FAILED");
      const choice = field.choices.find((candidate) => candidate.value === normalizedValue);
      if (!choice) return fail("READ_FAILED");
      criteria.push(Object.freeze({
        criterionId: field.id,
        label: field.label,
        kind: field.kind,
        value: normalizedValue,
        choiceLabel: choice.label,
      }));
      return;
    }

    criteria.push(Object.freeze({
      criterionId: field.id,
      label: field.label,
      kind: field.kind,
      value: reviewComment(value, field.maxLength ?? 64 * 1024),
      choiceLabel: null,
    }));
  });

  for (const criterionId of review.responses.keys()) {
    if (!consumed.has(criterionId)) return fail("READ_FAILED");
  }
  return Object.freeze({
    revisionNumber: review.revisionNumber,
    criteria: Object.freeze(criteria),
  });
}

function submissionRows(
  db: Db,
  organizer: OrganizerAuth,
  eventId: string,
  callId: string,
): readonly SubmissionAggregateRow[] {
  const rows = db
    .prepare(
      `SELECT submission.id AS submission_id,
              submission.current_revision_id AS submission_revision_id,
              person.id AS person_id,
              person.full_name AS person_name,
              person.organization
       FROM submissions submission
       JOIN people person
         ON person.id = submission.owner_person_id
        AND person.workspace_id = submission.workspace_id
       WHERE submission.workspace_id = ?
         AND submission.event_id = ?
         AND submission.call_id = ?
         AND submission.state = 'SUBMITTED'
         AND submission.current_revision_id IS NOT NULL
       ORDER BY submission.id ASC`,
    )
    .all(organizer.workspaceId, eventId, callId) as SubmissionAggregateRow[];
  return Object.freeze(rows);
}

function aggregateRankings(
  db: Db,
  organizer: OrganizerAuth,
  eventId: string,
  callId: string,
  assignments: readonly OrganizerReviewAssignment[],
  evidence: ReadonlyMap<string, ParsedReviewEvidence>,
  sort: OrganizerReviewSort,
): readonly OrganizerReviewSubmissionAggregate[] {
  const submissions = submissionRows(db, organizer, eventId, callId);
  const bySubmission = new Map<string, OrganizerReviewAssignment[]>();
  for (const assignment of assignments) {
    const list = bySubmission.get(assignment.submissionId) ?? [];
    list.push(assignment);
    bySubmission.set(assignment.submissionId, list);
  }
  const aggregates: OrganizerReviewSubmissionAggregate[] = [];
  for (const row of submissions) {
    const submissionId = storedIdentifier(row.submission_id);
    const submissionRevisionId = storedIdentifier(row.submission_revision_id);
    const personId = storedIdentifier(row.person_id);
    if (submissionId === null || submissionRevisionId === null || personId === null) {
      return fail("READ_FAILED");
    }
    const applicant = Object.freeze({
      personId,
      displayName: text(row.person_name, 512),
      organization: row.organization === null ? null : text(row.organization, 512),
    });
    const submissionAssignments = bySubmission.get(submissionId) ?? [];
    const activeAssignments = submissionAssignments.filter(
      (assignment) => assignment.assignmentState !== "RECUSED" && assignment.assignmentState !== "REVOKED",
    );
    const eligibleAssignments = activeAssignments.filter(
      (assignment) => assignment.conflictStatus !== "DECLARED",
    );
    const submittedAssignments = eligibleAssignments.filter(
      (assignment) =>
        assignment.assignmentState === "SUBMITTED" &&
        assignment.latestSubmittedReview != null,
    );
    let weightedScore = 0;
    let scoreWeight = 0;
    let submittedNumericResponse = false;
    const recommendationCounts = {
      advance: 0,
      hold: 0,
      doNotAdvance: 0,
    };
    for (const assignment of submittedAssignments) {
      const review = assignment.latestSubmittedReview;
      if (!review) continue;
      const parsedReview = evidence.get(assignment.id);
      if (!parsedReview) return fail("READ_FAILED");
      for (const criterion of review.criteria) {
        const response = criterion.value;
        if (response === null) continue;
        if (
          criterion.kind === "numeric" &&
          typeof response === "number"
        ) {
          const field = parsedReview.rubricFields.find(
            (candidate) => candidate.id === criterion.criterionId,
          );
          if (
            !field ||
            field.kind !== "numeric" ||
            field.minimum === null ||
            field.maximum === null ||
            !Number.isFinite(response)
          ) {
            return fail("READ_FAILED");
          }
          weightedScore += ((response - field.minimum) / (field.maximum - field.minimum)) * field.weight;
          scoreWeight += field.weight;
          submittedNumericResponse = true;
        }
        if (criterion.kind === "dropdown" && typeof response === "string") {
          const field = parsedReview.rubricFields.find(
            (candidate) => candidate.id === criterion.criterionId,
          );
          if (!field || field.kind !== "dropdown") return fail("READ_FAILED");
          if (field.recommendation) {
            if (response === "ADVANCE") recommendationCounts.advance += 1;
            if (response === "HOLD") recommendationCounts.hold += 1;
            if (response === "DO_NOT_ADVANCE") recommendationCounts.doNotAdvance += 1;
          }
        }
      }
    }
    const score = submittedNumericResponse && scoreWeight > 0
      ? (weightedScore / scoreWeight) * 100
      : null;
    const completionPercent = activeAssignments.length === 0
      ? 0
      : Math.round((submittedAssignments.length / activeAssignments.length) * 100);
    aggregates.push(Object.freeze({
      submissionId,
      submissionRevisionId,
      applicant,
      assignedReviewCount: activeAssignments.length,
      submittedReviewCount: submittedAssignments.length,
      eligibleReviewCount: eligibleAssignments.length,
      completionPercent,
      conflictCount: submissionAssignments.filter(
        (assignment) => assignment.conflictStatus === "DECLARED",
      ).length,
      blindPendingCount: eligibleAssignments.filter(
        (assignment) => !assignment.blindArtifactReady,
      ).length,
      score,
      scoreBasis: submittedNumericResponse
        ? "submitted-review-evidence" as const
        : "no-submitted-evidence" as const,
      recommendationCounts: Object.freeze(recommendationCounts),
      evidenceRank: null,
    }));
  }

  const evidenceOrder = [...aggregates].sort((left, right) => {
    if (left.score === null && right.score !== null) return 1;
    if (left.score !== null && right.score === null) return -1;
    if (left.score !== null && right.score !== null && left.score !== right.score) {
      return right.score - left.score;
    }
    return left.submissionId.localeCompare(right.submissionId);
  });
  const rankBySubmission = new Map<string, number | null>();
  let previousScore: number | null | undefined;
  let previousRank: number | null = null;
  evidenceOrder.forEach((aggregate, index) => {
    if (aggregate.score === null) {
      rankBySubmission.set(aggregate.submissionId, null);
      return;
    }
    const rank = previousScore === aggregate.score && previousRank !== null
      ? previousRank
      : index + 1;
    rankBySubmission.set(aggregate.submissionId, rank);
    previousScore = aggregate.score;
    previousRank = rank;
  });
  const ranked = aggregates.map((aggregate) => Object.freeze({
    ...aggregate,
    evidenceRank: rankBySubmission.get(aggregate.submissionId) ?? null,
  }));
  const reviewerName = (submissionId: string): string => {
    const names = (bySubmission.get(submissionId) ?? []).map((assignment) => assignment.reviewerName);
    return names.sort((left, right) => left.localeCompare(right))[0] ?? "";
  };
  ranked.sort((left, right) => {
    if (sort === "progress") {
      if (left.completionPercent !== right.completionPercent) return right.completionPercent - left.completionPercent;
    } else if (sort === "reviewer") {
      const leftReviewer = reviewerName(left.submissionId);
      const rightReviewer = reviewerName(right.submissionId);
      const reviewerCompare = leftReviewer.localeCompare(rightReviewer);
      if (reviewerCompare !== 0) return reviewerCompare;
    } else if (sort === "rank" || sort === "score") {
      if (left.evidenceRank === null && right.evidenceRank !== null) return 1;
      if (left.evidenceRank !== null && right.evidenceRank === null) return -1;
      if (left.score !== null && right.score !== null && left.score !== right.score) return right.score - left.score;
    }
    return left.submissionId.localeCompare(right.submissionId);
  });
  return Object.freeze(ranked);
}

function roundFromRow(
  db: Db,
  organizer: OrganizerAuth,
  row: RoundRow,
  sort: OrganizerReviewSort,
): OrganizerReviewRoundProjection {
  const roundId = storedIdentifier(row.id);
  if (
    storedIdentifier(row.workspace_id) !== organizer.workspaceId ||
    storedIdentifier(row.event_id) === null ||
    storedIdentifier(row.call_id) === null ||
    storedIdentifier(row.created_by) === null
  ) {
    return fail("READ_FAILED");
  }
  const state = latestRoundState(db, organizer.workspaceId, roundId);
  const call = Object.freeze({
    id: storedIdentifier(row.call_id),
    name: text(row.call_name),
    slug: text(row.call_slug, 128),
    state: text(row.call_state, 64),
    timezone: text(row.call_timezone, 128),
    opensAt: optionalLegacyTimestamp(row.call_opens_at, "READ_FAILED"),
    closesAt: optionalLegacyTimestamp(row.call_closes_at, "READ_FAILED"),
  });
  const createdAt = canonicalTimestamp(row.created_at, "READ_FAILED");
  const scheduleVersion = safeInteger(row.schedule_version_number, "READ_FAILED");
  const scheduleOpensAt = canonicalTimestamp(row.schedule_opens_at, "READ_FAILED");
  const scheduleClosesAt = canonicalTimestamp(row.schedule_closes_at, "READ_FAILED");
  const scheduleTimezone = text(row.schedule_timezone, 128);
  if (
    scheduleVersion < 1 ||
    scheduleOpensAt >= scheduleClosesAt
  ) {
    return fail("READ_FAILED");
  }
  const schedule = Object.freeze({
    source: text(row.schedule_source, 64) === "CALL_BACKFILL" ? "call" as const : "round" as const,
    version: scheduleVersion,
    timezone: scheduleTimezone,
    opensAt: scheduleOpensAt,
    closesAt: scheduleClosesAt,
    updatedAt: canonicalTimestamp(row.schedule_updated_at, "READ_FAILED"),
  });
  const progress = roundProgress(db, organizer.workspaceId, roundId);
  const rubric = rubricSummary(db, organizer, roundId);
  const blindReview = readOrganizerReviewBlindControl(db, organizer.session, {
    workspaceSlug: organizer.workspaceSlug,
    eventId: storedIdentifier(row.event_id),
    roundId,
  });
  const evidence = reviewEvidence(db, organizer, roundId);
  const assignments = assignmentProjections(db, organizer, roundId, evidence);
  const rankings = aggregateRankings(
    db,
    organizer,
    storedIdentifier(row.event_id),
    call.id,
    assignments,
    evidence,
    sort,
  );
  const reminders = reminderProjections(schedule, assignments);
  const localEvidence = localEvidenceRows(db, organizer, roundId);
  return Object.freeze({
    id: roundId,
    eventId: storedIdentifier(row.event_id),
    callId: call.id,
    name: text(row.name, 512),
    state: state.state,
    stateSequenceNumber: state.sequenceNumber,
    stateChangedAt: state.createdAt,
    createdAt,
    call,
    schedule,
    blindReview,
    rubric,
    progress,
    assignments,
    rankings,
    reminders,
    localEvidence,
  });
}

function roundRows(
  db: Db,
  organizer: OrganizerAuth,
  eventId: string,
  roundId?: string,
  sort: OrganizerReviewSort = "rank",
): OrganizerReviewRoundProjection[] {
  const rows = db
    .prepare(
      `SELECT round.id, round.workspace_id, round.event_id, round.call_id,
              round.name, round.created_by, round.created_at,
              call.name AS call_name, call.slug AS call_slug,
              call.state AS call_state, call.timezone AS call_timezone,
              call.opens_at AS call_opens_at, call.closes_at AS call_closes_at,
              schedule.version_number AS schedule_version_number,
              schedule.source AS schedule_source,
              schedule.timezone AS schedule_timezone,
              schedule.opens_at AS schedule_opens_at,
              schedule.closes_at AS schedule_closes_at,
              schedule.created_at AS schedule_updated_at,
              event.name AS event_name
       FROM review_rounds round
       JOIN calls call
         ON call.id = round.call_id AND call.workspace_id = round.workspace_id
        AND call.event_id = round.event_id
       JOIN events event
         ON event.id = round.event_id AND event.workspace_id = round.workspace_id
       JOIN review_round_schedule_versions schedule
         ON schedule.workspace_id = round.workspace_id
        AND schedule.event_id = round.event_id
        AND schedule.round_id = round.id
        AND schedule.version_number = (
          SELECT MAX(candidate.version_number)
          FROM review_round_schedule_versions candidate
          WHERE candidate.workspace_id = round.workspace_id
            AND candidate.event_id = round.event_id
            AND candidate.round_id = round.id
        )
       WHERE round.workspace_id = ? AND round.event_id = ?
         AND (? IS NULL OR round.id = ?)
       ORDER BY round.created_at ASC, round.id ASC`,
    )
    .all(organizer.workspaceId, eventId, roundId ?? null, roundId ?? null) as RoundRow[];
  if (roundId !== undefined && rows.length !== 1) return fail("ROUND_NOT_AVAILABLE");
  return rows.map((row) => roundFromRow(db, organizer, row, sort));
}

function eventExists(db: Db, organizer: OrganizerAuth, eventId: string): { name: string } {
  const row = db
    .prepare("SELECT name, workspace_id FROM events WHERE id = ? AND workspace_id = ?")
    .get(eventId, organizer.workspaceId) as { name: unknown; workspace_id: unknown } | undefined;
  if (!row || storedIdentifier(row.workspace_id) !== organizer.workspaceId) {
    return fail("EVENT_NOT_AVAILABLE");
  }
  return { name: text(row.name) };
}

function callRows(db: Db, organizer: OrganizerAuth, eventId: string): readonly OrganizerReviewCall[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.workspace_id, c.event_id, c.name, c.slug, c.state,
              c.timezone, c.opens_at, c.closes_at,
              e.workspace_id AS event_workspace_id, e.name AS event_name,
              e.lifecycle AS event_lifecycle
       FROM calls c
       JOIN events e ON e.id = c.event_id AND e.workspace_id = c.workspace_id
       WHERE c.workspace_id = ? AND c.event_id = ?
       ORDER BY c.name ASC, c.id ASC`,
    )
    .all(organizer.workspaceId, eventId) as CallRow[];
  return Object.freeze(rows.map(callProjection));
}

function validateSurfaceInput(input: ReadOrganizerReviewSurfaceInput): {
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly roundId?: string;
  readonly sort: OrganizerReviewSort;
} {
  const sort = input.sort ?? "rank";
  if (typeof sort !== "string" || !REVIEW_SORTS.has(sort as OrganizerReviewSort)) {
    return fail("INPUT_INVALID");
  }
  return Object.freeze({
    workspaceSlug: workspaceSlug(input.workspaceSlug),
    eventId: inputIdentifier(input.eventId),
    ...(input.roundId !== undefined ? { roundId: inputIdentifier(input.roundId) } : {}),
    sort: sort as OrganizerReviewSort,
  });
}

function roundMetadata(
  db: Db,
  organizer: OrganizerAuth,
  roundId: string,
): { readonly eventId: string; readonly callId: string } {
  const row = db
    .prepare(
      `SELECT id, workspace_id, event_id, call_id
       FROM review_rounds
       WHERE workspace_id = ? AND id = ?`,
    )
    .get(organizer.workspaceId, roundId) as {
      id: unknown;
      workspace_id: unknown;
      event_id: unknown;
      call_id: unknown;
    } | undefined;
  if (
    !row ||
    storedIdentifier(row.id) !== roundId ||
    storedIdentifier(row.workspace_id) !== organizer.workspaceId
  ) {
    return fail("ROUND_NOT_AVAILABLE");
  }
  const eventId = storedIdentifier(row.event_id);
  const callId = storedIdentifier(row.call_id);
  if (eventId === null || callId === null) return fail("ROUND_NOT_AVAILABLE");
  return Object.freeze({ eventId, callId });
}

function validateRubricInput(input: CreateOrganizerReviewRubricInput): {
  readonly workspaceSlug: string;
  readonly roundId: string;
  readonly document: OrganizerReviewRubricDocument;
  readonly idempotencyKey: string | null;
} {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  return Object.freeze({
    workspaceSlug: workspaceSlug(input.workspaceSlug),
    roundId: inputIdentifier(input.roundId),
    document: rubricDocumentForInput(input),
    idempotencyKey: input.idempotencyKey === undefined
      ? null
      : inputText(input.idempotencyKey, 128),
  });
}

export function createOrganizerReviewRubric(
  db: Db,
  session: SessionInfo,
  input: CreateOrganizerReviewRubricInput,
): import("./organizer-types").OrganizerReviewRubricReceipt {
  return boundary("write", () => {
    const captured = validateRubricInput(input);
    return ownedWrite(db, () => {
      const organizer = authenticateOrganizer(db, session, captured.workspaceSlug);
      const round = roundMetadata(db, organizer, captured.roundId);
      const state = latestRoundState(db, organizer.workspaceId, captured.roundId);
      if (state.state !== "DRAFT" && state.state !== "OPEN") return fail("ROUND_STATE_INVALID");
      const fingerprint = fingerprintOf(captured.document);
      const existing = db
        .prepare(
          `SELECT id, round_id, version_number, fingerprint, sealed_at
           FROM rubric_versions
           WHERE workspace_id = ? AND fingerprint = ?`,
        )
        .get(organizer.workspaceId, fingerprint) as {
          id: unknown;
          round_id: unknown;
          version_number: unknown;
          fingerprint: unknown;
          sealed_at: unknown;
        } | undefined;
      if (existing) {
        if (storedIdentifier(existing.round_id) !== captured.roundId) return fail("WRITE_FAILED");
        return Object.freeze({
          rubricVersionId: storedIdentifier(existing.id),
          roundId: captured.roundId,
          versionNumber: safeInteger(existing.version_number, "READ_FAILED"),
          fingerprint: text(existing.fingerprint, 64),
          fields: captured.document.fields,
          semanticsId: null,
          sealedAt: canonicalTimestamp(existing.sealed_at, "READ_FAILED"),
          replayed: true,
        });
      }
      const version = db
        .prepare(
          `SELECT COALESCE(MAX(version_number), 0) AS version_number
           FROM rubric_versions
           WHERE workspace_id = ? AND round_id = ?`,
        )
        .get(organizer.workspaceId, captured.roundId) as { version_number: unknown };
      const versionNumber = safeInteger(version.version_number, "READ_FAILED") + 1;
      const rubricVersionId = deterministicUuid(
        `organizer-review-rubric:${organizer.workspaceId}:${captured.roundId}:${fingerprint}`,
      );
      const sealedAt = nowIso();
      const serialized = canonicalJson(captured.document);
      db.prepare(
        `INSERT INTO rubric_versions
           (id, workspace_id, round_id, version_number, rubric_schema, rubric_json,
            fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
         VALUES (?, ?, ?, ?, 'cfp-rubric/v1', ?, 'sha256-canonical-json-v1', ?, ?, ?)`,
      ).run(
        rubricVersionId,
        organizer.workspaceId,
        captured.roundId,
        versionNumber,
        serialized,
        fingerprint,
        organizer.accountId,
        sealedAt,
      );
      writeAudit(db, organizer.workspaceId, {
        actorKind: "account",
        actorRef: organizer.accountId,
        action: "cfp.review.rubric.authored",
        targetType: "rubric_version",
        targetId: rubricVersionId,
        details: {
          roundId: captured.roundId,
          eventId: round.eventId,
          fingerprint,
          versionNumber,
          fieldKinds: captured.document.fields.map((field) => field.kind),
          weights: captured.document.fields.map((field) => field.weight),
          idempotencyKey: captured.idempotencyKey,
          reviewerSemantics: "not-issued-for-custom-organizer-fields",
        },
      });
      return Object.freeze({
        rubricVersionId,
        roundId: captured.roundId,
        versionNumber,
        fingerprint,
        fields: captured.document.fields,
        semanticsId: null,
        sealedAt,
        replayed: false,
      });
    });
  });
}

type CapturedDistributionInput = Readonly<{
  workspaceSlug: string;
  roundId: string;
  reviewerAccountIds: readonly string[];
  submissionIds: readonly string[] | null;
  reviewsPerSubmission: number;
  maxAssignmentsPerReviewer: number;
  pools: readonly {
    readonly id: string;
    readonly reviewerAccountIds: readonly string[];
    readonly maxAssignments: number;
  }[];
  strategy: "balanced" | "round_robin";
  blindArtifactDecisions: readonly OrganizerReviewBlindArtifactDecisionSet[] | null;
  idempotencyKey: string | null;
}>;

function captureBlindFieldDecisions(value: unknown): OrganizerReviewBlindArtifactDecisionSet["decisions"] {
  if (!Array.isArray(value) || value.length > 16_384) return fail("INPUT_INVALID");
  const decisions = value.map((decision) => {
    if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
      return fail("INPUT_INVALID");
    }
    const candidateDecision = decision as Record<string, unknown>;
    const sourceFieldId = inputIdentifier(candidateDecision.sourceFieldId);
    if (candidateDecision.action === "EXCLUDE") {
      if (
        Object.keys(candidateDecision).length !== 2 ||
        !Object.hasOwn(candidateDecision, "sourceFieldId")
      ) {
        return fail("INPUT_INVALID");
      }
      return Object.freeze({ sourceFieldId, action: "EXCLUDE" as const });
    }
    if (candidateDecision.action !== "INCLUDE_REDACTED") return fail("INPUT_INVALID");
    if (
      Object.keys(candidateDecision).length !== 4 ||
      !Object.hasOwn(candidateDecision, "reviewLabel") ||
      !Object.hasOwn(candidateDecision, "redactedValue")
    ) {
      return fail("INPUT_INVALID");
    }
    return Object.freeze({
      sourceFieldId,
      action: "INCLUDE_REDACTED" as const,
      reviewLabel: inputText(candidateDecision.reviewLabel, 2 * 1024),
      redactedValue: candidateDecision.redactedValue,
    });
  });
  return Object.freeze(decisions);
}

function captureBlindArtifactDecisions(
  value: unknown,
): readonly OrganizerReviewBlindArtifactDecisionSet[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_DISTRIBUTION_SUBMISSIONS) {
    return fail("INPUT_INVALID");
  }
  const seenSubmissions = new Set<string>();
  const captured = value.map((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return fail("INPUT_INVALID");
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).some((key) =>
        !new Set(["submissionId", "submissionRevisionId", "decisions"]).has(key),
      ) ||
      !Object.hasOwn(record, "submissionId") ||
      !Object.hasOwn(record, "submissionRevisionId") ||
      !Object.hasOwn(record, "decisions")
    ) {
      return fail("INPUT_INVALID");
    }
    const submissionId = inputIdentifier(record.submissionId);
    const submissionRevisionId = inputIdentifier(record.submissionRevisionId);
    if (seenSubmissions.has(submissionId)) return fail("INPUT_INVALID");
    seenSubmissions.add(submissionId);
    const decisions = captureBlindFieldDecisions(record.decisions);
    return Object.freeze({
      submissionId,
      submissionRevisionId,
      decisions,
    });
  });
  return Object.freeze(captured);
}

function validateDistributionInput(
  input: DistributeOrganizerReviewAssignmentsInput,
): CapturedDistributionInput {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  const workspaceSlug = workspaceSlugValue(input.workspaceSlug);
  const roundId = inputIdentifier(input.roundId);
  const requestedReviewers = input.reviewerAccountIds === undefined
    ? null
    : input.reviewerAccountIds;
  if (requestedReviewers !== null && (!Array.isArray(requestedReviewers) || requestedReviewers.length === 0)) {
    return fail("INPUT_INVALID");
  }
  if (requestedReviewers !== null && requestedReviewers.length > MAX_DISTRIBUTION_REVIEWERS) {
    return fail("INPUT_INVALID");
  }
  const reviewerIds = new Set<string>();
  if (requestedReviewers !== null) {
    for (const reviewerId of requestedReviewers) {
      const id = inputIdentifier(reviewerId);
      if (reviewerIds.has(id)) return fail("INPUT_INVALID");
      reviewerIds.add(id);
    }
  }
  const pools: Array<{
    readonly id: string;
    readonly reviewerAccountIds: readonly string[];
    readonly maxAssignments: number;
  }> = [];
  const poolIds = new Set<string>();
  const pooledReviewerIds = new Set<string>();
  if (input.pools !== undefined) {
    if (!Array.isArray(input.pools) || input.pools.length === 0 || input.pools.length > MAX_DISTRIBUTION_REVIEWERS) {
      return fail("INPUT_INVALID");
    }
    for (const pool of input.pools) {
      if (pool === null || typeof pool !== "object") return fail("INPUT_INVALID");
      const id = inputIdentifier(pool.id);
      if (poolIds.has(id) || !Array.isArray(pool.reviewerAccountIds) || pool.reviewerAccountIds.length === 0) {
        return fail("INPUT_INVALID");
      }
      if (pool.reviewerAccountIds.length > MAX_DISTRIBUTION_REVIEWERS) return fail("INPUT_INVALID");
      const poolReviewers = new Set<string>();
      for (const reviewerId of pool.reviewerAccountIds) {
        const reviewer = inputIdentifier(reviewerId);
        if (poolReviewers.has(reviewer) || pooledReviewerIds.has(reviewer)) return fail("INPUT_INVALID");
        poolReviewers.add(reviewer);
        pooledReviewerIds.add(reviewer);
        if (requestedReviewers !== null && !reviewerIds.has(reviewer)) return fail("INPUT_INVALID");
      }
      const maxAssignments = pool.maxAssignments === undefined
        ? MAX_ASSIGNMENTS_PER_REVIEWER * poolReviewers.size
        : safeInteger(pool.maxAssignments, "INPUT_INVALID");
      if (maxAssignments < 1 || maxAssignments > MAX_ASSIGNMENTS_PER_REVIEWER * poolReviewers.size) {
        return fail("INPUT_INVALID");
      }
      poolIds.add(id);
      pools.push(Object.freeze({
        id,
        reviewerAccountIds: Object.freeze([...poolReviewers].sort()),
        maxAssignments,
      }));
    }
  }
  const allReviewerIds = requestedReviewers !== null
    ? [...reviewerIds].sort()
    : pools.length > 0
      ? [...pooledReviewerIds].sort()
      : [];
  const submissionIds = input.submissionIds === undefined
    ? null
    : input.submissionIds;
  if (submissionIds !== null) {
    if (!Array.isArray(submissionIds) || submissionIds.length === 0 || submissionIds.length > MAX_DISTRIBUTION_SUBMISSIONS) {
      return fail("INPUT_INVALID");
    }
  }
  const normalizedSubmissionIds = submissionIds === null
    ? null
    : [...new Set(submissionIds.map((submissionId) => inputIdentifier(submissionId)))].sort();
  const reviewsPerSubmission = input.reviewsPerSubmission === undefined
    ? 2
    : safeInteger(input.reviewsPerSubmission, "INPUT_INVALID");
  if (reviewsPerSubmission < 1 || reviewsPerSubmission > 32) return fail("INPUT_INVALID");
  const maxAssignmentsPerReviewer = input.maxAssignmentsPerReviewer === undefined
    ? MAX_ASSIGNMENTS_PER_REVIEWER
    : safeInteger(input.maxAssignmentsPerReviewer, "INPUT_INVALID");
  if (maxAssignmentsPerReviewer < 1 || maxAssignmentsPerReviewer > MAX_ASSIGNMENTS_PER_REVIEWER) {
    return fail("INPUT_INVALID");
  }
  const strategy = input.strategy ?? "balanced";
  if (strategy !== "balanced" && strategy !== "round_robin") return fail("INPUT_INVALID");
  const blindArtifactDecisions = captureBlindArtifactDecisions(input.blindArtifactDecisions);
  const idempotencyKey = input.idempotencyKey === undefined
    ? null
    : inputText(input.idempotencyKey, 128);
  return Object.freeze({
    workspaceSlug,
    roundId,
    reviewerAccountIds: Object.freeze(allReviewerIds),
    submissionIds: normalizedSubmissionIds === null ? null : Object.freeze(normalizedSubmissionIds),
    reviewsPerSubmission,
    maxAssignmentsPerReviewer,
    pools: Object.freeze(pools),
    strategy,
    blindArtifactDecisions,
    idempotencyKey,
  });
}

function workspaceSlugValue(value: unknown): string {
  return workspaceSlug(value);
}

function reviewerAccounts(
  db: Db,
  organizer: OrganizerAuth,
  reviewerIds: readonly string[],
): readonly string[] {
  const rows = db
    .prepare(
      `SELECT id, role
       FROM accounts
       WHERE workspace_id = ? AND role = 'reviewer'
       ORDER BY id ASC`,
    )
    .all(organizer.workspaceId) as AccountRow[];
  const available = new Set<string>();
  for (const row of rows) {
    const id = storedIdentifier(row.id);
    if (row.role !== "reviewer") return fail("READ_FAILED");
    available.add(id);
  }
  const selected = reviewerIds.length === 0 ? [...available] : [...reviewerIds];
  if (selected.length === 0) return fail("REVIEWER_NOT_AVAILABLE");
  for (const reviewerId of selected) {
    if (!available.has(reviewerId)) return fail("REVIEWER_NOT_AVAILABLE");
  }
  return Object.freeze(selected.sort());
}

function eligibleSubmissionRows(
  db: Db,
  organizer: OrganizerAuth,
  eventId: string,
  callId: string,
  requestedSubmissionIds: readonly string[] | null,
): readonly { readonly submissionId: string; readonly submissionRevisionId: string }[] {
  const rows = db
    .prepare(
      `SELECT id, current_revision_id, state
       FROM submissions
       WHERE workspace_id = ? AND event_id = ? AND call_id = ?
         AND state = 'SUBMITTED' AND current_revision_id IS NOT NULL
       ORDER BY id ASC`,
    )
    .all(organizer.workspaceId, eventId, callId) as Array<{
      id: unknown;
      current_revision_id: unknown;
      state: unknown;
    }>;
  const eligible = new Map<string, { readonly submissionId: string; readonly submissionRevisionId: string }>();
  for (const row of rows) {
    const submissionId = storedIdentifier(row.id);
    const submissionRevisionId = storedIdentifier(row.current_revision_id);
    if (row.state !== "SUBMITTED" || submissionRevisionId === null) return fail("READ_FAILED");
    eligible.set(submissionId, Object.freeze({ submissionId, submissionRevisionId }));
  }
  if (requestedSubmissionIds !== null) {
    for (const submissionId of requestedSubmissionIds) {
      if (!eligible.has(submissionId)) return fail("SUBMISSION_NOT_AVAILABLE");
    }
    return Object.freeze(requestedSubmissionIds.map((submissionId) => eligible.get(submissionId)!));
  }
  return Object.freeze([...eligible.values()]);
}

function submissionRevisionFingerprint(
  db: Db,
  organizer: OrganizerAuth,
  submissionId: string,
  revisionId: string,
): string {
  const row = db
    .prepare(
      `SELECT workspace_id, submission_id, id, fingerprint
       FROM submission_revisions
       WHERE workspace_id = ? AND submission_id = ? AND id = ?`,
    )
    .get(organizer.workspaceId, submissionId, revisionId) as {
      workspace_id: unknown;
      submission_id: unknown;
      id: unknown;
      fingerprint: unknown;
    } | undefined;
  if (
    !row ||
    storedIdentifier(row.workspace_id) !== organizer.workspaceId ||
    storedIdentifier(row.submission_id) !== submissionId ||
    storedIdentifier(row.id) !== revisionId
  ) {
    return fail("SUBMISSION_NOT_AVAILABLE");
  }
  const fingerprint = text(row.fingerprint, 64);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) return fail("READ_FAILED");
  return fingerprint;
}

type AssignmentLoad = Readonly<{
  id: string;
  submissionId: string;
  submissionRevisionId: string;
  currentSubmissionRevisionId: string | null;
  submissionState: "DRAFT" | "SUBMITTED" | "WITHDRAWN" | "INVALIDATED";
  reviewerAccountId: string;
  state: OrganizerReviewAssignment["assignmentState"];
  conflictAction: "DECLARE" | "CLEAR" | "WAIVE" | null;
  conflictSequence: number;
  blindArtifactId: string | null;
}>;

function assignmentLoads(
  db: Db,
  organizer: OrganizerAuth,
  roundId: string,
): readonly AssignmentLoad[] {
  const rows = db
    .prepare(
      `SELECT assignment.id,
              assignment.submission_id,
              assignment.submission_revision_id,
              submission.current_revision_id,
              submission.state AS submission_state,
              assignment.reviewer_account_id,
              state.state,
              conflict.action AS conflict_action,
              conflict.sequence_number AS conflict_sequence,
              artifact.id AS blind_artifact_id
       FROM review_assignments assignment
       JOIN submissions submission
         ON submission.workspace_id = assignment.workspace_id
        AND submission.id = assignment.submission_id
       JOIN review_assignment_states state
         ON state.assignment_id = assignment.id
        AND state.sequence_number = (
          SELECT MAX(candidate.sequence_number)
          FROM review_assignment_states candidate
          WHERE candidate.workspace_id = assignment.workspace_id
            AND candidate.assignment_id = assignment.id
        )
       LEFT JOIN review_conflict_dispositions conflict
         ON conflict.workspace_id = assignment.workspace_id
        AND conflict.assignment_id = assignment.id
        AND conflict.sequence_number = (
          SELECT MAX(candidate.sequence_number)
          FROM review_conflict_dispositions candidate
          WHERE candidate.workspace_id = assignment.workspace_id
            AND candidate.assignment_id = assignment.id
        )
       LEFT JOIN review_blind_artifacts artifact
         ON artifact.workspace_id = assignment.workspace_id
        AND artifact.assignment_id = assignment.id
       WHERE assignment.workspace_id = ? AND assignment.round_id = ?
       ORDER BY assignment.id ASC`,
    )
    .all(organizer.workspaceId, roundId) as Array<{
      id: unknown;
      submission_id: unknown;
      submission_revision_id: unknown;
      current_revision_id: unknown;
      submission_state: unknown;
      reviewer_account_id: unknown;
      state: unknown;
      conflict_action: unknown;
      conflict_sequence: unknown;
      blind_artifact_id: unknown;
    }>;
  return Object.freeze(rows.map((row) => {
    const state = row.state;
    if (
      state !== "ASSIGNED" && state !== "IN_PROGRESS" && state !== "SUBMITTED" &&
      state !== "RECUSED" && state !== "REVOKED"
    ) return fail("READ_FAILED");
    const conflictAction = row.conflict_action === null || row.conflict_action === undefined
      ? null
      : row.conflict_action;
    if (
      conflictAction !== null &&
      conflictAction !== "DECLARE" &&
      conflictAction !== "CLEAR" &&
      conflictAction !== "WAIVE"
    ) return fail("READ_FAILED");
    const conflictSequence = row.conflict_sequence === null || row.conflict_sequence === undefined
      ? 0
      : safeInteger(row.conflict_sequence, "READ_FAILED");
    if (
      (conflictAction === null && conflictSequence !== 0) ||
      (conflictAction !== null && conflictSequence < 1)
    ) return fail("READ_FAILED");
    if (
      row.submission_state !== "DRAFT" &&
      row.submission_state !== "SUBMITTED" &&
      row.submission_state !== "WITHDRAWN" &&
      row.submission_state !== "INVALIDATED"
    ) return fail("READ_FAILED");
    return Object.freeze({
      id: storedIdentifier(row.id),
      submissionId: storedIdentifier(row.submission_id),
      submissionRevisionId: storedIdentifier(row.submission_revision_id),
      currentSubmissionRevisionId:
        row.current_revision_id === null || row.current_revision_id === undefined
          ? null
          : storedIdentifier(row.current_revision_id),
      submissionState: row.submission_state,
      reviewerAccountId: storedIdentifier(row.reviewer_account_id),
      state,
      conflictAction,
      conflictSequence,
      blindArtifactId: row.blind_artifact_id === null || row.blind_artifact_id === undefined
        ? null
        : storedIdentifier(row.blind_artifact_id),
    });
  }));
}

function reusableAssignment(load: AssignmentLoad): boolean {
  return (
    load.submissionState === "SUBMITTED" &&
    load.currentSubmissionRevisionId === load.submissionRevisionId &&
    (load.state === "ASSIGNED" ||
      load.state === "IN_PROGRESS" ||
      load.state === "SUBMITTED") &&
    load.conflictAction !== "DECLARE"
  );
}

function retiredReviewerSubmissionPair(load: AssignmentLoad): boolean {
  return (
    load.state === "RECUSED" ||
    load.state === "REVOKED" ||
    load.conflictAction === "DECLARE"
  );
}

function findLocalEvidence(
  db: Db,
  organizer: OrganizerAuth,
  roundId: string,
  kind: OrganizerReviewLocalEvidence["kind"],
  subjectId: string,
): OrganizerReviewLocalEvidence | null {
  return localEvidenceRows(db, organizer, roundId).find(
    (evidence) => evidence.kind === kind && evidence.subjectId === subjectId,
  ) ?? null;
}

export function distributeOrganizerReviewAssignments(
  db: Db,
  session: SessionInfo,
  input: DistributeOrganizerReviewAssignmentsInput,
): OrganizerReviewDistributionReceipt {
  return boundary("write", () => {
    const captured = validateDistributionInput(input);
    return ownedDistributionWrite(db, () => {
      const organizer = authenticateOrganizer(db, session, captured.workspaceSlug);
      const metadata = roundMetadata(db, organizer, captured.roundId);
      const schedule = latestRoundSchedule(
        db,
        organizer.workspaceId,
        metadata.eventId,
        captured.roundId,
        "ROUND_STATE_UNAVAILABLE",
      );
      const state = latestRoundState(db, organizer.workspaceId, captured.roundId);
      if (state.state !== "DRAFT" && state.state !== "OPEN") return fail("ROUND_STATE_INVALID");
      const rubric = rubricSummary(db, organizer, captured.roundId);
      if (!rubric) return fail("RUBRIC_NOT_AVAILABLE");
      const reviewers = reviewerAccounts(db, organizer, captured.reviewerAccountIds);
      const submissions = eligibleSubmissionRows(
        db,
        organizer,
        metadata.eventId,
        metadata.callId,
        captured.submissionIds,
      );
      const poolDefinitions = captured.pools.length > 0
        ? captured.pools
        : [Object.freeze({
            id: "all-reviewers",
            reviewerAccountIds: reviewers,
            maxAssignments: MAX_ASSIGNMENTS_PER_REVIEWER * reviewers.length,
          })];
      const distributionRequestFingerprint = fingerprintOf({
        schema: "cfp-organizer-review-distribution-request/v1",
        workspaceId: organizer.workspaceId,
        roundId: captured.roundId,
        reviewerAccountIds: reviewers,
        submissionIds: submissions,
        reviewsPerSubmission: captured.reviewsPerSubmission,
        maxAssignmentsPerReviewer: captured.maxAssignmentsPerReviewer,
        pools: poolDefinitions,
        strategy: captured.strategy,
        blindArtifactDecisions: captured.blindArtifactDecisions,
        schedule: {
          version: schedule.version,
          timezone: schedule.timezone,
          closesAt: schedule.closesAt,
        },
      });
      const distributionIdempotencyKey = captured.idempotencyKey ??
        `derived:${distributionRequestFingerprint}`;
      const priorDistributionEvidence = distributionIdempotencyEvidence(
        db,
        organizer,
        captured.roundId,
        distributionIdempotencyKey,
        distributionRequestFingerprint,
      );
      if (priorDistributionEvidence !== null) {
        return Object.freeze({
          roundId: captured.roundId,
          createdAssignmentIds: Object.freeze([]),
          existingAssignmentIds: Object.freeze([...priorDistributionEvidence.assignmentIds]),
          blindArtifactIds: Object.freeze([...priorDistributionEvidence.blindArtifactIds]),
          plan: priorDistributionEvidence.plan,
          localEvidence: priorDistributionEvidence.evidence,
          blindArtifactPendingAssignmentIds: Object.freeze([
            ...priorDistributionEvidence.blindArtifactPendingAssignmentIds,
          ]),
          replayed: true,
        });
      }

      const loads = assignmentLoads(db, organizer, captured.roundId);
      const reusableLoads = loads.filter(reusableAssignment);
      const reviewerLoad = new Map<string, number>();
      for (const reviewer of reviewers) reviewerLoad.set(reviewer, 0);
      for (const load of reusableLoads) {
        if (reviewerLoad.has(load.reviewerAccountId)) {
          reviewerLoad.set(load.reviewerAccountId, reviewerLoad.get(load.reviewerAccountId)! + 1);
        }
      }
      const existingByPair = new Map<string, AssignmentLoad>();
      const blockedPairs = new Set<string>();
      for (const load of loads) {
        if (reusableAssignment(load)) {
          existingByPair.set(
            reviewerSubmissionRevisionPairKey(
              load.submissionRevisionId,
              load.reviewerAccountId,
            ),
            load,
          );
        }
        if (retiredReviewerSubmissionPair(load)) {
          blockedPairs.add(
            reviewerSubmissionPairKey(load.submissionId, load.reviewerAccountId),
          );
        }
      }
      const poolLoad = new Map<string, number>();
      for (const pool of poolDefinitions) {
        poolLoad.set(
          pool.id,
          reusableLoads.filter((load) => pool.reviewerAccountIds.includes(load.reviewerAccountId)).length,
        );
      }
      const planAssignments: OrganizerReviewAssignmentPlanEntry[] = [];
      const skippedSubmissionIds: string[] = [];
      const existingAssignmentIds: string[] = [];
      const selectedPairs = new Set<string>();
      submissions.forEach((submission, submissionIndex) => {
        const chosen = new Set<string>();
        for (let slot = 0; slot < captured.reviewsPerSubmission; slot += 1) {
          const candidates: Array<{
            readonly reviewerAccountId: string;
            readonly poolId: string;
            readonly rank: number;
          }> = [];
          poolDefinitions.forEach((pool, poolIndex) => {
            const reviewerOrder = [...pool.reviewerAccountIds]
              .filter((reviewer) => reviewerLoad.has(reviewer))
              .sort();
            reviewerOrder.forEach((reviewer, reviewerIndex) => {
              const rotatedIndex = captured.strategy === "round_robin"
                ? (reviewerIndex + submissionIndex + slot) % Math.max(1, reviewerOrder.length)
                : reviewerIndex;
              candidates.push({
                reviewerAccountId: reviewer,
                poolId: pool.id,
                rank: captured.strategy === "round_robin"
                  ? poolIndex * 1_000 + rotatedIndex
                  : reviewerLoad.get(reviewer)! * 1_000 + poolIndex * 10 + reviewerIndex,
              });
            });
          });
          candidates.sort((left, right) =>
            Number(existingByPair.has(reviewerSubmissionRevisionPairKey(
              submission.submissionRevisionId,
              right.reviewerAccountId,
            ))) -
              Number(existingByPair.has(reviewerSubmissionRevisionPairKey(
                submission.submissionRevisionId,
                left.reviewerAccountId,
              ))) ||
            left.rank - right.rank ||
            left.poolId.localeCompare(right.poolId) ||
            left.reviewerAccountId.localeCompare(right.reviewerAccountId));
          const selected = candidates.find((candidate) => {
            const revisionPair = reviewerSubmissionRevisionPairKey(
              submission.submissionRevisionId,
              candidate.reviewerAccountId,
            );
            const durablePair = reviewerSubmissionPairKey(
              submission.submissionId,
              candidate.reviewerAccountId,
            );
            const pool = poolDefinitions.find((item) => item.id === candidate.poolId)!;
            const existing = existingByPair.get(revisionPair);
            return (
              !chosen.has(candidate.reviewerAccountId) &&
              !selectedPairs.has(durablePair) &&
              !blockedPairs.has(durablePair) &&
              (existing !== undefined || (
                reviewerLoad.get(candidate.reviewerAccountId)! < captured.maxAssignmentsPerReviewer &&
                poolLoad.get(pool.id)! < pool.maxAssignments
              ))
            );
          });
          if (!selected) continue;
          const revisionPair = reviewerSubmissionRevisionPairKey(
            submission.submissionRevisionId,
            selected.reviewerAccountId,
          );
          const durablePair = reviewerSubmissionPairKey(
            submission.submissionId,
            selected.reviewerAccountId,
          );
          chosen.add(selected.reviewerAccountId);
          selectedPairs.add(durablePair);
          const existing = existingByPair.get(revisionPair);
          if (existing) {
            existingAssignmentIds.push(existing.id);
          } else {
            reviewerLoad.set(selected.reviewerAccountId, reviewerLoad.get(selected.reviewerAccountId)! + 1);
            poolLoad.set(selected.poolId, poolLoad.get(selected.poolId)! + 1);
          }
          planAssignments.push(Object.freeze({
            submissionId: submission.submissionId,
            submissionRevisionId: submission.submissionRevisionId,
            reviewerAccountId: selected.reviewerAccountId,
            poolId: captured.pools.length > 0 ? selected.poolId : null,
          }));
        }
        if (chosen.size < captured.reviewsPerSubmission) skippedSubmissionIds.push(submission.submissionId);
      });
      const plan: OrganizerReviewDistributionPlan = Object.freeze({
        roundId: captured.roundId,
        strategy: captured.strategy,
        assignments: Object.freeze(planAssignments),
        skippedSubmissionIds: Object.freeze(skippedSubmissionIds),
        fingerprint: fingerprintOf({
          schema: "cfp-organizer-review-distribution-plan/v1",
          roundId: captured.roundId,
          strategy: captured.strategy,
          reviewsPerSubmission: captured.reviewsPerSubmission,
          maxAssignmentsPerReviewer: captured.maxAssignmentsPerReviewer,
          pools: poolDefinitions,
          assignments: planAssignments,
          skippedSubmissionIds,
          scheduleVersion: schedule.version,
          scheduleTimezone: schedule.timezone,
          scheduleClosesAt: schedule.closesAt,
        }),
      });
      const customRubricDocument = plan.assignments.length > 0
        ? customRubricDocumentForVersion(db, organizer, rubric.id)
        : null;
      const decisionsBySubmission = new Map(
        (captured.blindArtifactDecisions ?? []).map((entry) => [entry.submissionId, entry] as const),
      );
      if (plan.assignments.length > 0) {
        if (captured.blindArtifactDecisions === null) {
          return fail("INPUT_INVALID");
        }
        const plannedSubmissionIds = new Set(
          plan.assignments.map((assignment) => assignment.submissionId),
        );
        if (
          [...plannedSubmissionIds].some((submissionId) => !decisionsBySubmission.has(submissionId)) ||
          [...decisionsBySubmission.keys()].some(
            (submissionId) => !submissions.some((submission) => submission.submissionId === submissionId),
          )
        ) {
          return fail("INPUT_INVALID");
        }
        for (const assignment of plan.assignments) {
          const decisionSet = decisionsBySubmission.get(assignment.submissionId);
          if (
            !decisionSet ||
            decisionSet.submissionRevisionId !== assignment.submissionRevisionId
          ) {
            return fail("INPUT_INVALID");
          }
        }
        if (customRubricDocument) {
          sealingComposition.ensureCustomReviewRubricSemanticsInTransaction(db, {
            issuer: {
              session: organizer.session,
              workspaceSlug: organizer.workspaceSlug,
            },
            roundId: captured.roundId,
            rubricVersionId: rubric.id,
            rubricVersionNumber: rubric.versionNumber,
            rubricVersionFingerprint: rubric.fingerprint,
            customRubric: customRubricDocument,
          });
        }
      }
      const createdAssignmentIds: string[] = [];
      const planAssignmentIds: string[] = [];
      for (const assignment of plan.assignments) {
        const existing = existingByPair.get(
          reviewerSubmissionRevisionPairKey(
            assignment.submissionRevisionId,
            assignment.reviewerAccountId,
          ),
        );
        if (existing) {
          planAssignmentIds.push(existing.id);
          continue;
        }
        const assignmentId = deterministicUuid(
          `organizer-review-assignment:${organizer.workspaceId}:${captured.roundId}:${assignment.submissionRevisionId}:${assignment.reviewerAccountId}`,
        );
        db.prepare(
          `INSERT INTO review_assignments
             (id, workspace_id, round_id, rubric_version_id, submission_id,
              submission_revision_id, reviewer_account_id, assigned_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          assignmentId,
          organizer.workspaceId,
          captured.roundId,
          rubric.id,
          assignment.submissionId,
          assignment.submissionRevisionId,
          assignment.reviewerAccountId,
          organizer.accountId,
          nowIso(),
        );
        createdAssignmentIds.push(assignmentId);
        planAssignmentIds.push(assignmentId);
      }
      const blindArtifactIds: string[] = [];
      const blindArtifactAssignmentIds: string[] = [];
      for (const [assignmentIndex, assignment] of plan.assignments.entries()) {
        const assignmentId = planAssignmentIds[assignmentIndex];
        if (!assignmentId) return fail("READ_FAILED");
        const existing = existingByPair.get(reviewerSubmissionRevisionPairKey(
          assignment.submissionRevisionId,
          assignment.reviewerAccountId,
        ));
        const decisionSet = decisionsBySubmission.get(assignment.submissionId);
        if (!decisionSet) return fail("INPUT_INVALID");
        const artifact = sealingComposition.ensureBlindReviewArtifactInTransaction(db, {
          issuer: {
            session: organizer.session,
            workspaceSlug: organizer.workspaceSlug,
          },
          assignmentId,
          expectedSubmissionRevisionId: assignment.submissionRevisionId,
          expectedSubmissionRevisionFingerprint: submissionRevisionFingerprint(
            db,
            organizer,
            assignment.submissionId,
            assignment.submissionRevisionId,
          ),
          expectedConflictSequence: existing?.conflictSequence ?? 0,
          idempotencyKey: `distribution-artifact:${assignmentId}`,
          decisions: decisionSet.decisions,
        });
        blindArtifactIds.push(artifact.artifactId);
        blindArtifactAssignmentIds.push(assignmentId);
      }
      if (
        planAssignmentIds.length !== plan.assignments.length ||
        new Set(planAssignmentIds).size !== planAssignmentIds.length ||
        blindArtifactIds.length !== planAssignmentIds.length ||
        new Set(blindArtifactIds).size !== blindArtifactIds.length ||
        blindArtifactAssignmentIds.length !== planAssignmentIds.length ||
        blindArtifactAssignmentIds.some(
          (assignmentId, index) => assignmentId !== planAssignmentIds[index],
        )
      ) {
        return fail("WRITE_FAILED");
      }
      planAssignmentIds.forEach((assignmentId, index) => {
        const rows = db
          .prepare(
            `SELECT id, assignment_id, submission_revision_id
             FROM review_blind_artifacts
             WHERE workspace_id = ? AND assignment_id = ?`,
          )
          .all(organizer.workspaceId, assignmentId) as Array<{
            id: unknown;
            assignment_id: unknown;
            submission_revision_id: unknown;
          }>;
        const planned = plan.assignments[index];
        if (
          rows.length !== 1 ||
          !planned ||
          storedIdentifier(rows[0]!.id) !== blindArtifactIds[index] ||
          storedIdentifier(rows[0]!.assignment_id) !== assignmentId ||
          storedIdentifier(rows[0]!.submission_revision_id) !== planned.submissionRevisionId
        ) {
          return fail("WRITE_FAILED");
        }
      });
      const replayed = createdAssignmentIds.length === 0 &&
        plan.assignments.length > 0 &&
        existingAssignmentIds.length === plan.assignments.length;
      const blindArtifactPendingAssignmentIds: string[] = [];
      const distributionEvidence = writeLocalEvidence(
        db,
        organizer,
        captured.roundId,
        "DISTRIBUTION_PLANNED",
        plan.fingerprint,
        {
          strategy: captured.strategy,
          reviewsPerSubmission: captured.reviewsPerSubmission,
          maxAssignmentsPerReviewer: captured.maxAssignmentsPerReviewer,
          pools: poolDefinitions,
          assignmentIds: planAssignmentIds,
          assignmentBindings: plan.assignments.map((assignment, index) => ({
            assignmentId: planAssignmentIds[index],
            submissionId: assignment.submissionId,
            submissionRevisionId: assignment.submissionRevisionId,
            reviewerAccountId: assignment.reviewerAccountId,
          })),
          blindArtifactIds,
          blindArtifactAssignmentIds,
          blindArtifactPendingAssignmentIds,
          plan,
          planAuthority: {
            schema: "cfp-organizer-review-distribution-plan/v1",
            fingerprint: plan.fingerprint,
          },
          skippedSubmissionIds: plan.skippedSubmissionIds,
          scheduleVersion: schedule.version,
          timezone: schedule.timezone,
          closesAt: schedule.closesAt,
          idempotencyKey: distributionIdempotencyKey,
          requestFingerprint: distributionRequestFingerprint,
          command: {
            schema: "cfp-organizer-review-distribution-command/v1",
            idempotencyKey: distributionIdempotencyKey,
            requestFingerprint: distributionRequestFingerprint,
          },
          evidenceBoundary: "local-audit-only",
        },
      );
      for (const assignmentId of createdAssignmentIds) {
        const assignment = assignmentProjections(db, organizer, captured.roundId).find(
          (candidate) => candidate.id === assignmentId,
        );
        if (!assignment) return fail("READ_FAILED");
        const dueAt = schedule.closesAt;
        const reminderSubject = organizerReviewReminderSubject(captured.roundId, assignmentId, {
          version: schedule.version,
          timezone: schedule.timezone,
          closesAt: schedule.closesAt,
        });
        if (!findLocalEvidence(db, organizer, captured.roundId, "REMINDER_PLANNED", reminderSubject)) {
          writeLocalEvidence(db, organizer, captured.roundId, "REMINDER_PLANNED", reminderSubject, {
            assignmentId,
            reviewerAccountId: assignment.reviewerAccountId,
            dueAt,
            scheduleVersion: schedule.version,
            timezone: schedule.timezone,
            channel: "local-evidence",
            providerMutation: false,
          });
        }
      }
      return Object.freeze({
        roundId: captured.roundId,
        createdAssignmentIds: Object.freeze(createdAssignmentIds),
        existingAssignmentIds: Object.freeze([...new Set(existingAssignmentIds)]),
        blindArtifactIds: Object.freeze(blindArtifactIds),
        plan,
        localEvidence: distributionEvidence,
        blindArtifactPendingAssignmentIds: Object.freeze(blindArtifactPendingAssignmentIds),
        replayed,
      });
    });
  });
}

type CapturedRecusalInput = Readonly<{
  readonly workspaceSlug: string;
  readonly assignmentId: string;
  readonly expectedSequenceNumber: number;
  readonly reason: string;
  readonly replacementReviewerAccountId: string | null;
  readonly blindArtifactDecisions: OrganizerReviewBlindArtifactDecisionSet["decisions"] | null;
  readonly idempotencyKey: string;
}>;

type RecusalReceiptDocument = Readonly<{
  readonly schema: typeof ORGANIZER_REVIEW_RECUSAL_RECEIPT_SCHEMA;
  readonly workspaceId: string;
  readonly roundId: string;
  readonly assignmentId: string;
  readonly replacementAssignmentId: string | null;
  readonly blindArtifactId: string | null;
  readonly localEvidence: OrganizerReviewLocalEvidence;
  readonly requestFingerprint: string;
  readonly createdAt: string;
}>;

const RECUSAL_RECEIPT_RECORD_SCHEMA =
  "cfp-organizer-review-recusal-receipt-record/v1" as const;
const RECUSAL_RECEIPT_ACTION = "cfp.review.assignment.recusal-receipt" as const;
const RECUSAL_FINGERPRINT_ALGORITHM = "sha256-canonical-json-v1" as const;

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function recusalReceiptId(
  organizer: OrganizerAuth,
  idempotencyKey: string,
): string {
  return deterministicUuid(`organizer-review-recusal-receipt:${fingerprintOf({
    schema: RECUSAL_RECEIPT_RECORD_SCHEMA,
    workspaceId: organizer.workspaceId,
    actorAccountId: organizer.accountId,
    idempotencyKey,
  })}`);
}

function recusalRequestFingerprint(
  organizer: OrganizerAuth,
  captured: CapturedRecusalInput,
): string {
  return fingerprintOf({
    schema: ORGANIZER_REVIEW_RECUSAL_REQUEST_SCHEMA,
    workspaceId: organizer.workspaceId,
    actorAccountId: organizer.accountId,
    assignmentId: captured.assignmentId,
    expectedAssignmentStateSequenceNumber: captured.expectedSequenceNumber,
    reason: captured.reason,
    replacementReviewerAccountId: captured.replacementReviewerAccountId,
    blindArtifactDecisions: captured.blindArtifactDecisions,
    idempotencyKey: captured.idempotencyKey,
  });
}

function storedRecusalLocalEvidence(
  value: unknown,
  workspaceId: string,
  roundId: string,
  assignmentId: string,
): OrganizerReviewLocalEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("READ_FAILED");
  }
  const evidence = value as Record<string, unknown>;
  if (
    !hasExactKeys(evidence, new Set([
      "schema",
      "kind",
      "workspaceId",
      "roundId",
      "subjectId",
      "fingerprint",
      "recordedAt",
    ])) ||
    evidence.schema !== ORGANIZER_REVIEW_EVIDENCE_SCHEMA ||
    evidence.kind !== "ASSIGNMENT_RECUSED" ||
    storedIdentifier(evidence.workspaceId) !== workspaceId ||
    storedIdentifier(evidence.roundId) !== roundId ||
    storedIdentifier(evidence.subjectId) !== assignmentId
  ) {
    return fail("READ_FAILED");
  }
  const fingerprint = text(evidence.fingerprint, 64);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) return fail("READ_FAILED");
  return Object.freeze({
    schema: ORGANIZER_REVIEW_EVIDENCE_SCHEMA,
    kind: "ASSIGNMENT_RECUSED",
    workspaceId,
    roundId,
    subjectId: assignmentId,
    fingerprint,
    recordedAt: canonicalTimestamp(evidence.recordedAt, "READ_FAILED"),
  });
}

function recusalReplayReceipt(
  db: Db,
  organizer: OrganizerAuth,
  captured: CapturedRecusalInput,
  requestFingerprint: string,
): OrganizerReviewRecusalReceipt | null {
  const receiptId = recusalReceiptId(organizer, captured.idempotencyKey);
  const rows = db
    .prepare(
      `SELECT id, workspace_id, actor_kind, actor_ref, action, target_type,
              target_id, details_json, created_at
       FROM audit_events
       WHERE id = ?`,
    )
    .all(receiptId) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  if (rows.length !== 1) return fail("READ_FAILED");
  const row = rows[0]!;
  const storedTargetId = storedIdentifier(row.target_id);
  if (
    storedIdentifier(row.id) !== receiptId ||
    storedIdentifier(row.workspace_id) !== organizer.workspaceId ||
    row.actor_kind !== "account" ||
    storedIdentifier(row.actor_ref) !== organizer.accountId ||
    row.action !== RECUSAL_RECEIPT_ACTION ||
    row.target_type !== "review_assignment" ||
    typeof row.details_json !== "string" ||
    Buffer.byteLength(row.details_json, "utf8") > 64 * 1024
  ) {
    return fail("READ_FAILED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.details_json);
  } catch {
    return fail("READ_FAILED");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("READ_FAILED");
  }
  const record = parsed as Record<string, unknown>;
  if (
    canonicalJson(record) !== row.details_json ||
    !hasExactKeys(record, new Set([
      "schema",
      "idempotencyKey",
      "requestSchema",
      "requestFingerprintAlgorithm",
      "requestFingerprint",
      "receipt",
      "receiptFingerprintAlgorithm",
      "receiptFingerprint",
    ])) ||
    record.schema !== RECUSAL_RECEIPT_RECORD_SCHEMA ||
    record.idempotencyKey !== captured.idempotencyKey ||
    record.requestSchema !== ORGANIZER_REVIEW_RECUSAL_REQUEST_SCHEMA ||
    record.requestFingerprintAlgorithm !== RECUSAL_FINGERPRINT_ALGORITHM
  ) {
    return fail("READ_FAILED");
  }
  const storedRequestFingerprint = text(record.requestFingerprint, 64);
  if (!/^[a-f0-9]{64}$/u.test(storedRequestFingerprint)) return fail("READ_FAILED");
  if (storedRequestFingerprint !== requestFingerprint) {
    return fail("RECUSAL_IDEMPOTENCY_CONFLICT");
  }
  if (
    record.receiptFingerprintAlgorithm !== RECUSAL_FINGERPRINT_ALGORITHM ||
    record.receipt === null ||
    typeof record.receipt !== "object" ||
    Array.isArray(record.receipt)
  ) {
    return fail("READ_FAILED");
  }
  const document = record.receipt as Record<string, unknown>;
  if (
    !hasExactKeys(document, new Set([
      "schema",
      "workspaceId",
      "roundId",
      "assignmentId",
      "replacementAssignmentId",
      "blindArtifactId",
      "localEvidence",
      "requestFingerprint",
      "createdAt",
    ])) ||
    document.schema !== ORGANIZER_REVIEW_RECUSAL_RECEIPT_SCHEMA ||
    storedIdentifier(document.workspaceId) !== organizer.workspaceId ||
    storedIdentifier(document.assignmentId) !== captured.assignmentId ||
    storedTargetId !== captured.assignmentId ||
    text(document.requestFingerprint, 64) !== requestFingerprint
  ) {
    return fail("READ_FAILED");
  }
  const roundId = storedIdentifier(document.roundId);
  const replacementAssignmentId = document.replacementAssignmentId === null
    ? null
    : storedIdentifier(document.replacementAssignmentId);
  const blindArtifactId = document.blindArtifactId === null
    ? null
    : storedIdentifier(document.blindArtifactId);
  if ((replacementAssignmentId === null) !== (blindArtifactId === null)) {
    return fail("READ_FAILED");
  }
  const localEvidence = storedRecusalLocalEvidence(
    document.localEvidence,
    organizer.workspaceId,
    roundId,
    captured.assignmentId,
  );
  const createdAt = canonicalTimestamp(document.createdAt, "READ_FAILED");
  if (createdAt !== localEvidence.recordedAt || canonicalTimestamp(row.created_at, "READ_FAILED") !== createdAt) {
    return fail("READ_FAILED");
  }
  const receiptDocument: RecusalReceiptDocument = Object.freeze({
    schema: ORGANIZER_REVIEW_RECUSAL_RECEIPT_SCHEMA,
    workspaceId: organizer.workspaceId,
    roundId,
    assignmentId: captured.assignmentId,
    replacementAssignmentId,
    blindArtifactId,
    localEvidence,
    requestFingerprint,
    createdAt,
  });
  const receiptFingerprint = text(record.receiptFingerprint, 64);
  if (
    !/^[a-f0-9]{64}$/u.test(receiptFingerprint) ||
    fingerprintOf(receiptDocument) !== receiptFingerprint
  ) {
    return fail("READ_FAILED");
  }
  return Object.freeze({
    ...receiptDocument,
    receiptFingerprint,
    replayed: true,
  });
}

function persistRecusalReceipt(
  db: Db,
  organizer: OrganizerAuth,
  captured: CapturedRecusalInput,
  requestFingerprint: string,
  roundId: string,
  replacementAssignmentId: string | null,
  blindArtifactId: string | null,
  localEvidence: OrganizerReviewLocalEvidence,
): OrganizerReviewRecusalReceipt {
  const document: RecusalReceiptDocument = Object.freeze({
    schema: ORGANIZER_REVIEW_RECUSAL_RECEIPT_SCHEMA,
    workspaceId: organizer.workspaceId,
    roundId,
    assignmentId: captured.assignmentId,
    replacementAssignmentId,
    blindArtifactId,
    localEvidence,
    requestFingerprint,
    createdAt: localEvidence.recordedAt,
  });
  const receiptFingerprint = fingerprintOf(document);
  const record = Object.freeze({
    schema: RECUSAL_RECEIPT_RECORD_SCHEMA,
    idempotencyKey: captured.idempotencyKey,
    requestSchema: ORGANIZER_REVIEW_RECUSAL_REQUEST_SCHEMA,
    requestFingerprintAlgorithm: RECUSAL_FINGERPRINT_ALGORITHM,
    requestFingerprint,
    receipt: document,
    receiptFingerprintAlgorithm: RECUSAL_FINGERPRINT_ALGORITHM,
    receiptFingerprint,
  });
  db.prepare(
    `INSERT INTO audit_events
       (id, workspace_id, actor_kind, actor_ref, action, target_type,
        target_id, details_json, created_at)
     VALUES (?, ?, 'account', ?, ?, 'review_assignment', ?, ?, ?)`,
  ).run(
    recusalReceiptId(organizer, captured.idempotencyKey),
    organizer.workspaceId,
    organizer.accountId,
    RECUSAL_RECEIPT_ACTION,
    captured.assignmentId,
    canonicalJson(record),
    document.createdAt,
  );
  const verified = recusalReplayReceipt(
    db,
    organizer,
    captured,
    requestFingerprint,
  );
  if (!verified || verified.receiptFingerprint !== receiptFingerprint) {
    return fail("WRITE_FAILED");
  }
  return Object.freeze({
    ...document,
    receiptFingerprint,
    replayed: false,
  });
}

function validateRecusalInput(input: RecuseOrganizerReviewAssignmentInput): CapturedRecusalInput {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  const expectedSequenceNumber = safeInteger(
    input.expectedAssignmentStateSequenceNumber,
    "INPUT_INVALID",
  );
  if (expectedSequenceNumber < 1) return fail("INPUT_INVALID");
  const blindArtifactDecisions = input.blindArtifactDecisions === undefined
    ? null
    : captureBlindFieldDecisions(input.blindArtifactDecisions);
  const replacementReviewerAccountId = input.replacementReviewerAccountId === undefined
    ? null
    : inputIdentifier(input.replacementReviewerAccountId);
  if (replacementReviewerAccountId === null && blindArtifactDecisions !== null) {
    return fail("INPUT_INVALID");
  }
  return Object.freeze({
    workspaceSlug: workspaceSlug(input.workspaceSlug),
    assignmentId: inputIdentifier(input.assignmentId),
    expectedSequenceNumber,
    reason: inputText(input.reason, 4_096),
    replacementReviewerAccountId,
    blindArtifactDecisions,
    idempotencyKey: inputText(input.idempotencyKey, 128),
  });
}

export function recuseOrganizerReviewAssignment(
  db: Db,
  session: SessionInfo,
  input: RecuseOrganizerReviewAssignmentInput,
): OrganizerReviewRecusalReceipt {
  return boundary("write", () => {
    const captured = validateRecusalInput(input);
    return ownedDistributionWrite(db, () => {
      const organizer = authenticateOrganizer(db, session, captured.workspaceSlug);
      const requestFingerprint = recusalRequestFingerprint(organizer, captured);
      const replay = recusalReplayReceipt(
        db,
        organizer,
        captured,
        requestFingerprint,
      );
      if (replay !== null) return replay;

      const row = db
        .prepare(
          `SELECT assignment.id,
                  assignment.workspace_id,
                  assignment.round_id,
                  assignment.rubric_version_id,
                  assignment.submission_id,
                  assignment.submission_revision_id,
                  submission.current_revision_id AS current_submission_revision_id,
                  submission.state AS submission_state,
                  assignment.reviewer_account_id,
                  assignment.created_at,
                  state.state,
                  state.sequence_number
           FROM review_assignments assignment
           JOIN submissions submission
             ON submission.workspace_id = assignment.workspace_id
            AND submission.id = assignment.submission_id
           JOIN review_assignment_states state
             ON state.assignment_id = assignment.id
            AND state.sequence_number = (
              SELECT MAX(candidate.sequence_number)
              FROM review_assignment_states candidate
              WHERE candidate.workspace_id = assignment.workspace_id
                AND candidate.assignment_id = assignment.id
            )
           WHERE assignment.workspace_id = ? AND assignment.id = ?`,
        )
        .get(organizer.workspaceId, captured.assignmentId) as {
          id: unknown;
          workspace_id: unknown;
          round_id: unknown;
          rubric_version_id: unknown;
          submission_id: unknown;
          submission_revision_id: unknown;
          current_submission_revision_id: unknown;
          submission_state: unknown;
          reviewer_account_id: unknown;
          created_at: unknown;
          state: unknown;
          sequence_number: unknown;
        } | undefined;
      if (!row) return fail("ASSIGNMENT_NOT_AVAILABLE");
      const roundId = storedIdentifier(row.round_id);
      const rubricVersionId = storedIdentifier(row.rubric_version_id);
      const submissionId = storedIdentifier(row.submission_id);
      const submissionRevisionId = storedIdentifier(row.submission_revision_id);
      const currentSubmissionRevisionId = storedIdentifier(row.current_submission_revision_id);
      const currentReviewerId = storedIdentifier(row.reviewer_account_id);
      const sequenceNumber = safeInteger(row.sequence_number, "READ_FAILED");
      if (
        storedIdentifier(row.id) !== captured.assignmentId ||
        storedIdentifier(row.workspace_id) !== organizer.workspaceId ||
        roundId === null ||
        rubricVersionId === null ||
        submissionId === null ||
        submissionRevisionId === null ||
        currentSubmissionRevisionId === null ||
        row.submission_state !== "SUBMITTED" ||
        currentReviewerId === null ||
        sequenceNumber !== captured.expectedSequenceNumber
      ) {
        return fail("ASSIGNMENT_NOT_AVAILABLE");
      }
      if (row.state !== "ASSIGNED" && row.state !== "IN_PROGRESS") {
        return fail("ROUND_STATE_INVALID");
      }
      const roundState = latestRoundState(db, organizer.workspaceId, roundId);
      if (roundState.state !== "DRAFT" && roundState.state !== "OPEN") return fail("ROUND_STATE_INVALID");
      if (
        captured.replacementReviewerAccountId !== null &&
        captured.replacementReviewerAccountId === currentReviewerId
      ) {
        return fail("REVIEWER_NOT_AVAILABLE");
      }
      if (captured.replacementReviewerAccountId !== null) {
        reviewerAccounts(db, organizer, [captured.replacementReviewerAccountId]);
        if (captured.blindArtifactDecisions === null) return fail("INPUT_INVALID");
        const replacementBlocked = assignmentLoads(db, organizer, roundId).some(
          (load) =>
            load.submissionId === submissionId &&
            load.reviewerAccountId === captured.replacementReviewerAccountId &&
            retiredReviewerSubmissionPair(load),
        );
        if (replacementBlocked) return fail("REVIEWER_NOT_AVAILABLE");
      }
      const replacementExists = captured.replacementReviewerAccountId === null
        ? undefined
        : db
          .prepare(
            `SELECT id FROM review_assignments
             WHERE workspace_id = ? AND round_id = ?
               AND submission_id = ? AND submission_revision_id = ?
               AND reviewer_account_id = ?`,
          )
          .get(
            organizer.workspaceId,
            roundId,
            submissionId,
            currentSubmissionRevisionId,
            captured.replacementReviewerAccountId,
          ) as { id: unknown } | undefined;
      if (replacementExists) return fail("WRITE_FAILED");
      const revokedAt = nowIso();
      db.prepare(
        `INSERT INTO review_assignment_states
           (id, workspace_id, assignment_id, state, sequence_number,
            actor_account_id, reason, created_at)
         VALUES (?, ?, ?, 'REVOKED', ?, ?, ?, ?)`,
      ).run(
        deterministicUuid(`organizer-review-recusal:${captured.assignmentId}:${sequenceNumber + 1}`),
        organizer.workspaceId,
        captured.assignmentId,
        sequenceNumber + 1,
        organizer.accountId,
        captured.reason,
        revokedAt,
      );
      let replacementAssignmentId: string | null = null;
      let blindArtifactId: string | null = null;
      if (captured.replacementReviewerAccountId !== null) {
        const blindArtifactDecisions = captured.blindArtifactDecisions;
        if (blindArtifactDecisions === null) return fail("INPUT_INVALID");
        replacementAssignmentId = deterministicUuid(
          `organizer-review-assignment:${organizer.workspaceId}:${roundId}:${currentSubmissionRevisionId}:${captured.replacementReviewerAccountId}`,
        );
        const supersedesAssignmentId = submissionRevisionId === currentSubmissionRevisionId
          ? captured.assignmentId
          : null;
        db.prepare(
          `INSERT INTO review_assignments
             (id, workspace_id, round_id, rubric_version_id, submission_id,
              submission_revision_id, reviewer_account_id, assigned_by,
              supersedes_assignment_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          replacementAssignmentId,
          organizer.workspaceId,
          roundId,
          rubricVersionId,
          submissionId,
          currentSubmissionRevisionId,
          captured.replacementReviewerAccountId,
          organizer.accountId,
          supersedesAssignmentId,
          revokedAt,
        );
        const artifact = sealingComposition.issueBlindReviewArtifactInTransaction(db, {
          issuer: {
            session: organizer.session,
            workspaceSlug: organizer.workspaceSlug,
          },
          assignmentId: replacementAssignmentId,
          expectedSubmissionRevisionId: currentSubmissionRevisionId,
          expectedSubmissionRevisionFingerprint: submissionRevisionFingerprint(
            db,
            organizer,
            submissionId,
            currentSubmissionRevisionId,
          ),
          expectedConflictSequence: 0,
          idempotencyKey: `recusal-artifact:${replacementAssignmentId}`,
          decisions: blindArtifactDecisions,
        });
        blindArtifactId = artifact.artifactId;
        const storedArtifacts = db
          .prepare(
            `SELECT id, assignment_id, submission_revision_id
             FROM review_blind_artifacts
             WHERE workspace_id = ? AND assignment_id = ?`,
          )
          .all(organizer.workspaceId, replacementAssignmentId) as Array<{
            id: unknown;
            assignment_id: unknown;
            submission_revision_id: unknown;
          }>;
        if (
          storedArtifacts.length !== 1 ||
          storedIdentifier(storedArtifacts[0]!.id) !== blindArtifactId ||
          storedIdentifier(storedArtifacts[0]!.assignment_id) !== replacementAssignmentId ||
          storedIdentifier(storedArtifacts[0]!.submission_revision_id) !== currentSubmissionRevisionId
        ) {
          return fail("WRITE_FAILED");
        }
      }
      const localEvidence = writeLocalEvidence(
        db,
        organizer,
        roundId,
        "ASSIGNMENT_RECUSED",
        captured.assignmentId,
        {
          physicalState: "REVOKED",
          recusalReason: captured.reason,
          submissionId,
          retiredReviewerAccountId: currentReviewerId,
          retiredSubmissionRevisionId: submissionRevisionId,
          replacementAssignmentId,
          replacementReviewerAccountId: captured.replacementReviewerAccountId,
          replacementSubmissionRevisionId: captured.replacementReviewerAccountId === null
            ? null
            : currentSubmissionRevisionId,
          blindArtifactId,
          schemaAssumption: "existing assignment-state trigger permits organizer REVOKED, not organizer RECUSED",
        },
      );
      writeAudit(db, organizer.workspaceId, {
        actorKind: "account",
        actorRef: organizer.accountId,
        action: "cfp.review.assignment.recused",
        targetType: "review_assignment",
        targetId: captured.assignmentId,
        details: {
          roundId,
          submissionId,
          retiredReviewerAccountId: currentReviewerId,
          retiredSubmissionRevisionId: submissionRevisionId,
          reason: captured.reason,
          replacementAssignmentId,
          replacementReviewerAccountId: captured.replacementReviewerAccountId,
          replacementSubmissionRevisionId: captured.replacementReviewerAccountId === null
            ? null
            : currentSubmissionRevisionId,
          blindArtifactId,
          localEvidenceFingerprint: localEvidence.fingerprint,
        },
      });
      return persistRecusalReceipt(
        db,
        organizer,
        captured,
        requestFingerprint,
        roundId,
        replacementAssignmentId,
        blindArtifactId,
        localEvidence,
      );
    });
  });
}

function exportContent(
  format: "csv" | "json",
  projection: OrganizerReviewRoundProjection,
  organizer: OrganizerAuth,
): string {
  if (format === "json") {
    return canonicalJson({
      schema: ORGANIZER_REVIEW_EXPORT_SCHEMA,
      sensitivity: "ORGANIZER_PRIVATE",
      workspaceId: organizer.workspaceId,
      eventId: projection.eventId,
      roundId: projection.id,
      rubricFingerprint: projection.rubric?.fingerprint ?? null,
      schedule: projection.schedule,
      progress: projection.progress,
      rankings: projection.rankings,
      assignments: projection.assignments.map((assignment) => ({
        id: assignment.id,
        submissionId: assignment.submissionId,
        reviewerAccountId: assignment.reviewerAccountId,
        assignmentState: assignment.assignmentState,
        conflictStatus: assignment.conflictStatus,
        submitted: assignment.assignmentState === "SUBMITTED",
      })),
    });
  }
  const header = [
    "rank",
    "submission_id",
    "applicant_person_id",
    "applicant_name",
    "organization",
    "assigned_reviews",
    "submitted_reviews",
    "eligible_reviews",
    "completion_percent",
    "conflicts",
    "blind_pending",
    "score",
    "score_basis",
    "advance_recommendations",
    "hold_recommendations",
    "do_not_advance_recommendations",
  ];
  const rows = projection.rankings.map((ranking) => [
    ranking.evidenceRank,
    ranking.submissionId,
    ranking.applicant.personId,
    ranking.applicant.displayName,
    ranking.applicant.organization,
    ranking.assignedReviewCount,
    ranking.submittedReviewCount,
    ranking.eligibleReviewCount,
    ranking.completionPercent,
    ranking.conflictCount,
    ranking.blindPendingCount,
    ranking.score,
    ranking.scoreBasis,
    ranking.recommendationCounts.advance,
    ranking.recommendationCounts.hold,
    ranking.recommendationCounts.doNotAdvance,
  ]);
  return [header, ...rows].map((row) => row.map(csvSafeCell).join(",")).join("\n");
}

function validateExportInput(input: ExportOrganizerReviewInput): {
  readonly surface: ReadOrganizerReviewSurfaceInput;
  readonly format: "csv" | "json";
} {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  const surface = validateSurfaceInput(input);
  if (input.roundId === undefined || (input.format !== "csv" && input.format !== "json")) {
    return fail("INPUT_INVALID");
  }
  return Object.freeze({ surface, format: input.format });
}

export function exportOrganizerReview(
  db: Db,
  session: SessionInfo,
  input: ExportOrganizerReviewInput,
): OrganizerReviewExport {
  return boundary("write", () => {
    const captured = validateExportInput(input);
    return ownedWrite(db, () => {
      const organizer = authenticateOrganizer(db, session, captured.surface.workspaceSlug);
      const event = eventExists(db, organizer, captured.surface.eventId);
      const rounds = roundRows(
        db,
        organizer,
        captured.surface.eventId,
        captured.surface.roundId,
        captured.surface.sort,
      );
      if (rounds.length !== 1) return fail("ROUND_NOT_AVAILABLE");
      const projection = rounds[0]!;
      const content = exportContent(captured.format, projection, organizer);
      const fingerprint = fingerprintOf({
        schema: ORGANIZER_REVIEW_EXPORT_SCHEMA,
        format: captured.format,
        workspaceId: organizer.workspaceId,
        eventId: captured.surface.eventId,
        roundId: projection.id,
        rubricFingerprint: projection.rubric?.fingerprint ?? null,
        content,
      });
      const localEvidence = writeLocalEvidence(
        db,
        organizer,
        projection.id,
        "EXPORT_CREATED",
        fingerprint,
        {
          format: captured.format,
          eventName: event.name,
          contentFingerprint: fingerprint,
          mediaType: captured.format === "csv" ? "text/csv" : "application/json",
          providerMutation: false,
        },
      );
      return Object.freeze({
        schema: ORGANIZER_REVIEW_EXPORT_SCHEMA,
        format: captured.format,
        fileName: `review-${projection.id}.${captured.format}`,
        mediaType: captured.format === "csv" ? "text/csv" as const : "application/json" as const,
        sensitivity: "ORGANIZER_PRIVATE" as const,
        workspaceId: organizer.workspaceId,
        eventId: captured.surface.eventId,
        roundId: projection.id,
        rubricFingerprint: projection.rubric?.fingerprint ?? null,
        content,
        fingerprint,
        localEvidence,
      });
    });
  });
}

type OrganizerReviewRoundReceiptWithSchedule = OrganizerReviewRoundReceipt & Readonly<{
  readonly scheduleVersion: number;
  readonly opensAt: string;
  readonly closesAt: string;
}>;

export function createOrganizerReviewRound(
  db: Db,
  session: SessionInfo,
  input: CreateOrganizerReviewRoundInput & Readonly<{ opensAt: string; closesAt: string }>,
): OrganizerReviewRoundReceiptWithSchedule;
export function createOrganizerReviewRound(
  db: Db,
  session: SessionInfo,
  input: CreateOrganizerReviewRoundInput,
): OrganizerReviewRoundReceipt;
export function createOrganizerReviewRound(
  db: Db,
  session: SessionInfo,
  input: CreateOrganizerReviewRoundInput,
): OrganizerReviewRoundReceipt {
  return boundary("write", () => {
    const captured = validateCreateInput(input);
    return ownedWrite(db, () => {
      const organizer = authenticateOrganizer(db, session, captured.workspaceSlug);
      const request = roundCreationRequestBinding(captured, organizer.workspaceId);
      const replayRow = db.prepare(
        `SELECT request_fingerprint, round_id, event_id, call_id, schedule_version,
                timezone, opens_at, closes_at
         FROM review_round_creation_receipts
         WHERE workspace_id = ? AND actor_account_id = ? AND idempotency_key = ?`,
      ).get(organizer.workspaceId, organizer.accountId, request.idempotencyKey) as
        | RoundCreationReceiptRow
        | undefined;
      if (replayRow) return roundCreationReceipt(replayRow, request.requestFingerprint);
      const event = eventExists(db, organizer, captured.eventId);
      const callRow = readCall(db, organizer, captured.eventId, captured.callId);
      const call = callProjection(callRow);
      const requestedSchedule = resolveCreateSchedule(captured, call);
      if (
        captured.idempotencyKey === undefined &&
        Object.hasOwn(captured, "opensAt") &&
        Object.hasOwn(captured, "closesAt")
      ) {
        assertScheduleMatchesCall(captured, call);
      }
      assertRoundCreationAllowed(callRow);

      const existing = db
        .prepare(
          `SELECT id, created_at FROM review_rounds
           WHERE workspace_id = ? AND event_id = ? AND call_id = ? AND name = ?`,
        )
        .get(organizer.workspaceId, captured.eventId, captured.callId, captured.name) as
        | { id: unknown; created_at: unknown }
        | undefined;
      if (existing) {
        return fail("ROUND_CREATE_IDEMPOTENCY_CONFLICT");
      }

      const roundId = uuid();
      const createdAt = nowIso();
      db.prepare(
        `INSERT INTO review_rounds
           (id, workspace_id, event_id, call_id, name, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        roundId,
        organizer.workspaceId,
        captured.eventId,
        captured.callId,
        captured.name,
        organizer.accountId,
        createdAt,
      );
      const state = latestRoundState(db, organizer.workspaceId, roundId);
      if (state.state !== "DRAFT" || state.sequenceNumber !== 1) {
        return fail("ROUND_STATE_UNAVAILABLE");
      }
      let schedule = latestRoundSchedule(
        db,
        organizer.workspaceId,
        captured.eventId,
        roundId,
        "ROUND_STATE_UNAVAILABLE",
      );
      if (
        schedule.opensAt !== requestedSchedule.opensAt ||
        schedule.closesAt !== requestedSchedule.closesAt
      ) {
        schedule = appendRoundSchedule(
          db,
          organizer,
          captured.eventId,
          roundId,
          schedule.version,
          schedule.timezone,
          requestedSchedule.opensAt,
          requestedSchedule.closesAt,
          captured.idempotencyKey ?? `review-round-create:${roundId}`,
        );
      }
      db.prepare(
        `INSERT INTO review_round_creation_receipts
           (id, workspace_id, actor_account_id, idempotency_key, request_schema,
            request_fingerprint, round_id, event_id, call_id, schedule_version,
            timezone, opens_at, closes_at, created_at)
         VALUES (?, ?, ?, ?, 'cfp-review-round-create-request/v1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        deterministicUuid(`review-round-create-receipt:${organizer.workspaceId}:${organizer.accountId}:${request.idempotencyKey}`),
        organizer.workspaceId,
        organizer.accountId,
        request.idempotencyKey,
        request.requestFingerprint,
        roundId,
        captured.eventId,
        captured.callId,
        schedule.version,
        schedule.timezone,
        schedule.opensAt,
        schedule.closesAt,
        createdAt,
      );
      const scheduleSource = schedule.version === 1 ? "call" as const : "round" as const;
      writeAudit(db, organizer.workspaceId, {
        actorKind: "account",
        actorRef: organizer.accountId,
        action: "cfp.review.round.created",
        targetType: "review_round",
        targetId: roundId,
        details: {
          eventId: captured.eventId,
          callId: captured.callId,
          scheduleSource,
          scheduleVersion: schedule.version,
          timezone: schedule.timezone,
          opensAt: schedule.opensAt,
          closesAt: schedule.closesAt,
          eventName: event.name,
        },
      });
      return Object.freeze({
        roundId,
        eventId: captured.eventId,
        callId: captured.callId,
        state: "DRAFT" as const,
        stateSequenceNumber: 1 as const,
        scheduleSource,
        scheduleVersion: schedule.version,
        timezone: schedule.timezone,
        opensAt: schedule.opensAt,
        closesAt: schedule.closesAt,
        replayed: false,
      });
    });
  });
}

export function setOrganizerReviewRoundSchedule(
  db: Db,
  session: SessionInfo,
  input: SetOrganizerReviewRoundScheduleInput,
): OrganizerReviewRoundScheduleReceipt {
  return boundary("write", () => {
    const captured = validateScheduleInput(input);
    return ownedWrite(db, () => {
      const organizer = authenticateOrganizer(db, session, captured.workspaceSlug);
      const event = eventExists(db, organizer, captured.eventId);
      const round = db
        .prepare(
          `SELECT id FROM review_rounds
           WHERE workspace_id = ? AND event_id = ? AND id = ?`,
        )
        .get(organizer.workspaceId, captured.eventId, captured.roundId) as
        | { id: unknown }
        | undefined;
      if (!round || storedIdentifier(round.id) !== captured.roundId) {
        return fail("ROUND_NOT_AVAILABLE");
      }

      const replay = roundScheduleByIdempotencyKey(
        db,
        organizer.workspaceId,
        captured.eventId,
        captured.roundId,
        captured.idempotencyKey,
      );
      if (replay) {
        if (
          replay.expectedPreviousVersion !== captured.expectedScheduleVersion ||
          replay.opensAt !== captured.opensAt ||
          replay.closesAt !== captured.closesAt
        ) {
          return fail("ROUND_SCHEDULE_IDEMPOTENCY_CONFLICT");
        }
        return Object.freeze({
          roundId: replay.roundId,
          eventId: replay.eventId,
          scheduleVersion: replay.version,
          timezone: replay.timezone,
          opensAt: replay.opensAt,
          closesAt: replay.closesAt,
          updatedAt: replay.updatedAt,
          replayed: true,
        });
      }

      const state = latestRoundState(db, organizer.workspaceId, captured.roundId);
      if (state.state !== "DRAFT" && state.state !== "OPEN") {
        return fail("ROUND_STATE_INVALID");
      }
      const current = latestRoundSchedule(
        db,
        organizer.workspaceId,
        captured.eventId,
        captured.roundId,
        "ROUND_STATE_UNAVAILABLE",
      );
      if (current.version !== captured.expectedScheduleVersion) {
        return fail("ROUND_SCHEDULE_STALE");
      }
      const schedule = appendRoundSchedule(
        db,
        organizer,
        captured.eventId,
        captured.roundId,
        current.version,
        current.timezone,
        captured.opensAt,
        captured.closesAt,
        captured.idempotencyKey,
      );
      writeAudit(db, organizer.workspaceId, {
        actorKind: "account",
        actorRef: organizer.accountId,
        action: "cfp.review.round.schedule.updated",
        targetType: "review_round",
        targetId: captured.roundId,
        details: {
          eventId: captured.eventId,
          eventName: event.name,
          scheduleSource: "round",
          previousScheduleVersion: current.version,
          scheduleVersion: schedule.version,
          timezone: schedule.timezone,
          opensAt: schedule.opensAt,
          closesAt: schedule.closesAt,
        },
      });
      return Object.freeze({
        roundId: schedule.roundId,
        eventId: schedule.eventId,
        scheduleVersion: schedule.version,
        timezone: schedule.timezone,
        opensAt: schedule.opensAt,
        closesAt: schedule.closesAt,
        updatedAt: schedule.updatedAt,
        replayed: false,
      });
    });
  });
}

export function setOrganizerReviewRoundState(
  db: Db,
  session: SessionInfo,
  input: SetOrganizerReviewRoundStateInput,
): OrganizerReviewRoundStateReceipt {
  return boundary("write", () => {
    const captured = validateRoundStateInput(input);
    return ownedWrite(db, () => {
      const organizer = authenticateOrganizer(db, session, captured.workspaceSlug);
      const round = roundMetadata(db, organizer, captured.roundId);
      if (captured.eventId !== undefined && captured.eventId !== round.eventId) {
        return fail("ROUND_NOT_AVAILABLE");
      }
      const current = latestRoundState(db, organizer.workspaceId, captured.roundId);
      const nextSequenceNumber = captured.expectedStateSequenceNumber + 1;
      const replay = db
        .prepare(
          `SELECT state, sequence_number, actor_account_id, reason, created_at
           FROM review_round_states
           WHERE workspace_id = ? AND round_id = ? AND sequence_number = ?`,
        )
        .get(
          organizer.workspaceId,
          captured.roundId,
          nextSequenceNumber,
        ) as StateRow | undefined;
      if (replay) {
        if (
          replay.state !== captured.state ||
          storedIdentifier(replay.actor_account_id) !== organizer.accountId ||
          replay.reason !== captured.reason
        ) {
          return fail("ROUND_STATE_STALE");
        }
        return Object.freeze({
          roundId: captured.roundId,
          state: captured.state,
          sequenceNumber: nextSequenceNumber,
          createdAt: canonicalTimestamp(replay.created_at, "ROUND_STATE_UNAVAILABLE"),
          replayed: true,
        });
      }
      if (current.sequenceNumber !== captured.expectedStateSequenceNumber) {
        return fail("ROUND_STATE_STALE");
      }
      const validTransition =
        (current.state === "DRAFT" && (captured.state === "OPEN" || captured.state === "CANCELLED")) ||
        (current.state === "OPEN" && (captured.state === "CLOSED" || captured.state === "CANCELLED"));
      if (!validTransition) return fail("ROUND_STATE_INVALID");
      const createdAt = nowIso();
      const stateId = `review-round-state:${captured.roundId}:${nextSequenceNumber}`;
      db.prepare(
        `INSERT INTO review_round_states
           (id, workspace_id, round_id, state, sequence_number,
            actor_account_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stateId,
        organizer.workspaceId,
        captured.roundId,
        captured.state,
        nextSequenceNumber,
        organizer.accountId,
        captured.reason,
        createdAt,
      );
      writeAudit(db, organizer.workspaceId, {
        actorKind: "account",
        actorRef: organizer.accountId,
        action: "cfp.review.round.state-changed",
        targetType: "review_round",
        targetId: captured.roundId,
        details: {
          roundId: captured.roundId,
          previousState: current.state,
          state: captured.state,
          sequenceNumber: nextSequenceNumber,
          reason: captured.reason,
          idempotencyKey: captured.idempotencyKey ?? null,
        },
      });
      return Object.freeze({
        roundId: captured.roundId,
        state: captured.state,
        sequenceNumber: nextSequenceNumber,
        createdAt,
        replayed: false,
      });
    });
  });
}

export function readOrganizerReviewSurface(
  db: Db,
  session: SessionInfo,
  input: ReadOrganizerReviewSurfaceInput,
): OrganizerReviewSurface {
  return boundary("read", () => {
    const captured = validateSurfaceInput(input);
    const organizer = authenticateOrganizer(db, session, captured.workspaceSlug);
    const event = eventExists(db, organizer, captured.eventId);
    const calls = callRows(db, organizer, captured.eventId);
    const rounds = roundRows(db, organizer, captured.eventId, captured.roundId, captured.sort);
    return Object.freeze({
      workspaceId: organizer.workspaceId,
      workspaceSlug: organizer.workspaceSlug,
      eventId: captured.eventId,
      eventName: event.name,
      calls,
      rounds: Object.freeze(rounds),
      selectedRoundId: captured.roundId ?? null,
      selectedSort: captured.sort,
    });
  });
}

export function organizerReviewRoundFingerprint(round: OrganizerReviewRound): string {
  return fingerprintOf({
    schema: "cfp-organizer-review-round-projection/v1",
    round,
  });
}

export function organizerReviewScheduleSummary(round: OrganizerReviewRound): string {
  const summary = {
    source: round.schedule.source,
    timezone: round.schedule.timezone,
    opensAt: round.schedule.opensAt,
    closesAt: round.schedule.closesAt,
  };
  return round.schedule.source === "round"
    ? canonicalJson({
        ...summary,
        version: round.schedule.version,
        updatedAt: round.schedule.updatedAt,
      })
    : canonicalJson(summary);
}
