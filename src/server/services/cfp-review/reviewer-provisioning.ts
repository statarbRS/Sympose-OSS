import type { SessionInfo } from "../../auth";
import { roleHasCapability } from "../../auth";
import { fingerprintOf, nowIso, uuid } from "../../canonical";
import type { Db } from "../../db";
import {
  V16_REVIEWER_ACCESS_RECEIPT_SCHEMA,
  V16_REVIEWER_ACCESS_REQUEST_SCHEMA,
} from "../../schema";
import {
  EVALUATOR_DEVFLOW_REVIEWER_CONTRACT,
  isPinnedDevflowReviewerAccount,
} from "../../evaluator-reviewer-contract";
import { writeAudit } from "../audit";

export const REVIEWER_PROVISIONING_EVIDENCE_SCHEMA =
  "cfp-reviewer-provisioning-evidence/v3" as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ORGANIZER_ROLES = new Set([
  "organizer",
  "workspace_admin",
  "event_manager",
  "program_manager",
]);
const REVIEW_ASSIGNMENT_STATES = new Set(["ASSIGNED", "IN_PROGRESS", "SUBMITTED"]);

export type ReviewerAccessIntent = "PROVISION" | "INVITE" | "ACTIVATE";
export type ReviewerAccessState = "PROVISIONED" | "INVITED" | "ACTIVE";
export type ReviewerProvisioningStatus =
  | "READY_TO_PROVISION"
  | "PROVISIONED"
  | "INVITED"
  | "ACTIVE";

export interface ReviewerProvisioningInput {
  readonly eventId: string;
  readonly roundId: string;
  readonly intent: ReviewerAccessIntent;
  readonly idempotencyKey: string;
}

export interface ReadPinnedReviewerProvisioningInput {
  readonly eventId: string;
  readonly roundId: string;
}

export interface ReviewerProvisioningProjection {
  readonly schema: typeof REVIEWER_PROVISIONING_EVIDENCE_SCHEMA;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly roundId: string;
  readonly assignmentId: string;
  readonly eventReviewerAssignmentId: string;
  readonly reviewerAccountId: string;
  readonly reviewerPersonId: string;
  readonly accountPersonBindingId: string;
  readonly reviewerName: string;
  readonly reviewerEmail: string;
  readonly status: ReviewerProvisioningStatus;
  readonly accessState: ReviewerAccessState | null;
  readonly accessSequenceNumber: number;
  readonly queueReachable: boolean;
  readonly providerMutation: false;
  readonly credentialIssued: false;
}

export interface ReviewerProvisioningReceipt {
  readonly schema: typeof V16_REVIEWER_ACCESS_RECEIPT_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly roundId: string;
  readonly assignmentId: string;
  readonly eventReviewerAssignmentId: string;
  readonly reviewerAccountId: string;
  readonly reviewerPersonId: string;
  readonly accountPersonBindingId: string;
  readonly actorAccountId: string;
  readonly intent: ReviewerAccessIntent;
  readonly state: ReviewerAccessState;
  readonly sequenceNumber: number;
  readonly receiptId: string;
  readonly effectStateId: string | null;
  readonly requestFingerprint: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly transitioned: boolean;
  readonly replayed: boolean;
  readonly providerMutation: false;
  readonly credentialIssued: false;
}

export type ReviewerProvisioningServiceErrorCode =
  | "INPUT_INVALID"
  | "ACCESS_DENIED"
  | "EVENT_NOT_AVAILABLE"
  | "ROUND_NOT_AVAILABLE"
  | "REVIEWER_NOT_AVAILABLE"
  | "ASSIGNMENT_NOT_AVAILABLE"
  | "PROVISIONING_REQUIRED"
  | "INVITATION_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "OUTER_TRANSACTION_DENIED"
  | "READ_FAILED"
  | "WRITE_FAILED";

const ERROR_MESSAGES: Readonly<Record<ReviewerProvisioningServiceErrorCode, string>> = {
  INPUT_INVALID: "The reviewer access request is invalid.",
  ACCESS_DENIED: "Reviewer provisioning is unavailable for this workspace.",
  EVENT_NOT_AVAILABLE: "The pinned reviewer event is unavailable.",
  ROUND_NOT_AVAILABLE: "The pinned reviewer round is unavailable.",
  REVIEWER_NOT_AVAILABLE: "The pinned reviewer is unavailable.",
  ASSIGNMENT_NOT_AVAILABLE: "The pinned reviewer assignment is unavailable.",
  PROVISIONING_REQUIRED: "Provision Sam before sending an invitation.",
  INVITATION_REQUIRED: "Invite Sam before activating reviewer access.",
  IDEMPOTENCY_CONFLICT: "This reviewer access request conflicts with an earlier request.",
  OUTER_TRANSACTION_DENIED: "Reviewer provisioning requires an owned transaction boundary.",
  READ_FAILED: "Reviewer access could not be read safely.",
  WRITE_FAILED: "Reviewer access could not be saved safely.",
};

export class ReviewerProvisioningServiceError extends Error {
  readonly code: ReviewerProvisioningServiceErrorCode;

  constructor(code: ReviewerProvisioningServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ReviewerProvisioningServiceError";
    this.code = code;
  }
}

function fail(code: ReviewerProvisioningServiceErrorCode): never {
  throw new ReviewerProvisioningServiceError(code);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_PATTERN.test(value);
}

function captureInput(input: ReviewerProvisioningInput): ReviewerProvisioningInput {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  const candidate = input as unknown as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join("\0") !== ["eventId", "idempotencyKey", "intent", "roundId"].join("\0")) {
    return fail("INPUT_INVALID");
  }
  if (
    !validIdentifier(candidate.eventId) ||
    !validIdentifier(candidate.roundId) ||
    !validIdempotencyKey(candidate.idempotencyKey) ||
    (candidate.intent !== "PROVISION" &&
      candidate.intent !== "INVITE" &&
      candidate.intent !== "ACTIVATE")
  ) {
    return fail("INPUT_INVALID");
  }
  return Object.freeze({
    eventId: candidate.eventId,
    roundId: candidate.roundId,
    intent: candidate.intent,
    idempotencyKey: candidate.idempotencyKey,
  });
}

function captureReadInput(
  input: ReadPinnedReviewerProvisioningInput,
): ReadPinnedReviewerProvisioningInput {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  const candidate = input as unknown as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join("\0") !== ["eventId", "roundId"].join("\0")) return fail("INPUT_INVALID");
  if (!validIdentifier(candidate.eventId) || !validIdentifier(candidate.roundId)) {
    return fail("INPUT_INVALID");
  }
  return Object.freeze({ eventId: candidate.eventId, roundId: candidate.roundId });
}

function requireOwnedBoundary(db: Db): void {
  if (db.isTransaction) fail("OUTER_TRANSACTION_DENIED");
}

function withOwnedTransaction<T>(db: Db, mode: "BEGIN" | "BEGIN IMMEDIATE", operation: () => T): T {
  requireOwnedBoundary(db);
  try {
    db.exec(mode);
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      // Preserve the opaque service boundary below.
    }
    if (error instanceof ReviewerProvisioningServiceError) throw error;
    throw new ReviewerProvisioningServiceError("WRITE_FAILED");
  }
}

type OrganizerActor = Readonly<{
  accountId: string;
  workspaceId: string;
  workspaceSlug: string;
}>;

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

function authenticateOrganizer(db: Db, session: SessionInfo): OrganizerActor {
  const row = db
    .prepare(
      `SELECT s.id, s.token_hash AS tokenHash, s.account_id AS accountId,
              s.workspace_id AS workspaceId, s.expires_at AS expiresAt,
              a.email, a.display_name AS displayName, a.role,
              w.slug AS workspaceSlug, w.name AS workspaceName
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id AND a.workspace_id = s.workspace_id
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = ? AND s.token_hash = ?`,
    )
    .get(session.id, session.tokenHash) as
    | {
        id: unknown;
        tokenHash: unknown;
        accountId: unknown;
        workspaceId: unknown;
        expiresAt: unknown;
        email: unknown;
        displayName: unknown;
        role: unknown;
        workspaceSlug: unknown;
        workspaceName: unknown;
      }
    | undefined;
  const expiresAt = canonicalInstant(row?.expiresAt);
  if (
    !row ||
    row.id !== session.id ||
    row.tokenHash !== session.tokenHash ||
    row.accountId !== session.accountId ||
    row.workspaceId !== session.workspaceId ||
    row.email !== session.email ||
    row.displayName !== session.displayName ||
    row.role !== session.role ||
    row.workspaceSlug !== session.workspaceSlug ||
    row.workspaceName !== session.workspaceName ||
    expiresAt === null ||
    Date.parse(expiresAt) <= Date.now() ||
    !ORGANIZER_ROLES.has(String(row.role)) ||
    !roleHasCapability(String(row.role), "phase0.pipeline.manage")
  ) {
    return fail("ACCESS_DENIED");
  }
  return Object.freeze({
    accountId: row.accountId as string,
    workspaceId: row.workspaceId as string,
    workspaceSlug: row.workspaceSlug as string,
  });
}

type PinnedContext = Readonly<{
  workspaceId: string;
  workspaceSlug: string;
  eventId: string;
  roundId: string;
  assignmentId: string;
  eventReviewerAssignmentId: string;
  reviewerAccountId: string;
  reviewerPersonId: string;
  accountPersonBindingId: string;
  reviewerName: string;
  reviewerEmail: string;
  accessState: ReviewerAccessState | null;
  accessSequenceNumber: number;
}>;

function requirePinnedContext(
  db: Db,
  input: ReadPinnedReviewerProvisioningInput,
): PinnedContext {
  const contract = EVALUATOR_DEVFLOW_REVIEWER_CONTRACT;
  if (input.eventId !== contract.eventId) return fail("EVENT_NOT_AVAILABLE");
  if (input.roundId !== contract.roundId) return fail("ROUND_NOT_AVAILABLE");

  const workspace = db
    .prepare("SELECT id, slug FROM workspaces WHERE id = ? AND slug = ?")
    .get(contract.workspaceId, contract.workspaceSlug) as
    | { id: string; slug: string }
    | undefined;
  if (!workspace) return fail("ACCESS_DENIED");

  const account = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId, email, display_name AS displayName, role
       FROM accounts WHERE id = ? AND workspace_id = ?`,
    )
    .get(contract.reviewer.accountId, contract.workspaceId) as
    | {
        id: string;
        workspaceId: string;
        email: string;
        displayName: string;
        role: string;
      }
    | undefined;
  if (
    !account ||
    !isPinnedDevflowReviewerAccount({
      accountId: account.id,
      workspaceId: account.workspaceId,
      role: account.role as "reviewer",
      email: account.email,
    }) ||
    account.displayName !== contract.reviewer.displayName
  ) {
    return fail("REVIEWER_NOT_AVAILABLE");
  }

  const person = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId, canonical_email AS email, full_name AS fullName
       FROM people WHERE id = ? AND workspace_id = ?`,
    )
    .get(contract.reviewerPersonId, contract.workspaceId) as
    | { id: string; workspaceId: string; email: string; fullName: string }
    | undefined;
  if (
    !person ||
    person.email !== contract.reviewer.email ||
    person.fullName !== contract.reviewer.displayName
  ) {
    return fail("REVIEWER_NOT_AVAILABLE");
  }

  const binding = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId, account_id AS accountId, person_id AS personId,
              bound_by_account_id AS boundByAccountId, binding_basis AS bindingBasis,
              created_at AS createdAt, fingerprint_algorithm AS fingerprintAlgorithm, fingerprint
       FROM account_person_bindings
       WHERE id = ? AND workspace_id = ?`,
    )
    .get(contract.accountPersonBindingId, contract.workspaceId) as
    | {
        id: string;
        workspaceId: string;
        accountId: string;
        personId: string;
        boundByAccountId: string;
        bindingBasis: string;
        createdAt: string;
        fingerprintAlgorithm: string;
        fingerprint: string;
      }
    | undefined;
  if (
    !binding ||
    binding.accountId !== contract.reviewer.accountId ||
    binding.personId !== contract.reviewerPersonId ||
    binding.workspaceId !== contract.workspaceId ||
    binding.boundByAccountId !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId ||
    binding.bindingBasis !== "pinned synthetic evaluator reviewer" ||
    binding.fingerprintAlgorithm !== "sha256-canonical-json-v1" ||
    binding.fingerprint !== fingerprintOf({
      schema: "pd01-account-person-binding/v1",
      workspaceId: binding.workspaceId,
      accountId: binding.accountId,
      personId: binding.personId,
      boundByAccountId: binding.boundByAccountId,
      bindingBasis: binding.bindingBasis,
      createdAt: binding.createdAt,
    })
  ) {
    return fail("REVIEWER_NOT_AVAILABLE");
  }

  const eventAssignment = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId, event_id AS eventId,
              reviewer_account_id AS reviewerAccountId, reviewer_person_id AS reviewerPersonId,
              account_person_binding_id AS accountPersonBindingId,
              assigned_by_account_id AS assignedByAccountId, created_at AS createdAt,
              fingerprint_algorithm AS fingerprintAlgorithm, fingerprint
       FROM event_reviewer_assignments
       WHERE id = ? AND workspace_id = ? AND event_id = ?`,
    )
    .get(
      contract.eventReviewerAssignmentId,
      contract.workspaceId,
      contract.eventId,
    ) as
    | {
        id: string;
        workspaceId: string;
        eventId: string;
        reviewerAccountId: string;
        reviewerPersonId: string;
        accountPersonBindingId: string;
        assignedByAccountId: string;
        createdAt: string;
        fingerprintAlgorithm: string;
        fingerprint: string;
      }
    | undefined;
  const eventAssignmentState = db
    .prepare(
      `SELECT state, sequence_number AS sequenceNumber
       FROM event_reviewer_assignment_states
       WHERE workspace_id = ? AND event_reviewer_assignment_id = ?
       ORDER BY sequence_number DESC LIMIT 1`,
    )
    .get(contract.workspaceId, contract.eventReviewerAssignmentId) as
    | { state: string; sequenceNumber: number }
    | undefined;
  if (
    !eventAssignment ||
    eventAssignment.reviewerAccountId !== contract.reviewer.accountId ||
    eventAssignment.reviewerPersonId !== contract.reviewerPersonId ||
    eventAssignment.accountPersonBindingId !== contract.accountPersonBindingId ||
    eventAssignment.assignedByAccountId !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId ||
    eventAssignment.fingerprintAlgorithm !== "sha256-canonical-json-v1" ||
    eventAssignment.fingerprint !== fingerprintOf({
      schema: "pd01-event-reviewer-assignment/v1",
      workspaceId: eventAssignment.workspaceId,
      eventId: eventAssignment.eventId,
      reviewerAccountId: eventAssignment.reviewerAccountId,
      reviewerPersonId: eventAssignment.reviewerPersonId,
      accountPersonBindingId: eventAssignment.accountPersonBindingId,
      assignedByAccountId: eventAssignment.assignedByAccountId,
      createdAt: eventAssignment.createdAt,
    }) ||
    eventAssignmentState?.state !== "ACTIVE"
  ) {
    return fail("REVIEWER_NOT_AVAILABLE");
  }

  const round = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId, event_id AS eventId
       FROM review_rounds WHERE id = ? AND workspace_id = ? AND event_id = ?`,
    )
    .get(contract.roundId, contract.workspaceId, contract.eventId) as
    | { id: string; workspaceId: string; eventId: string }
    | undefined;
  const roundState = db
    .prepare(
      `SELECT state FROM review_round_states
       WHERE workspace_id = ? AND round_id = ?
       ORDER BY sequence_number DESC LIMIT 1`,
    )
    .get(contract.workspaceId, contract.roundId) as { state: string } | undefined;
  if (!round || roundState === undefined || !["DRAFT", "OPEN"].includes(roundState.state)) {
    return fail("ROUND_NOT_AVAILABLE");
  }

  const assignment = db
    .prepare(
      `SELECT assignment.id, assignment.workspace_id AS workspaceId,
              assignment.round_id AS roundId, assignment.rubric_version_id AS rubricVersionId,
              assignment.submission_id AS submissionId,
              assignment.reviewer_account_id AS reviewerAccountId,
              submission.event_id AS submissionEventId, submission.state AS submissionState,
              submission.current_revision_id AS currentRevisionId
       FROM review_assignments assignment
       JOIN submissions submission ON submission.id = assignment.submission_id
        AND submission.workspace_id = assignment.workspace_id
       WHERE assignment.id = ? AND assignment.workspace_id = ? AND assignment.round_id = ?
         AND assignment.reviewer_account_id = ? AND submission.event_id = ?`,
    )
    .get(
      contract.assignmentId,
      contract.workspaceId,
      contract.roundId,
      contract.reviewer.accountId,
      contract.eventId,
    ) as
    | {
        id: string;
        workspaceId: string;
        roundId: string;
        rubricVersionId: string;
        submissionId: string;
        reviewerAccountId: string;
        submissionEventId: string;
        submissionState: string;
        currentRevisionId: string;
      }
    | undefined;
  const assignmentState = db
    .prepare(
      `SELECT state FROM review_assignment_states
       WHERE workspace_id = ? AND assignment_id = ?
       ORDER BY sequence_number DESC LIMIT 1`,
    )
    .get(contract.workspaceId, contract.assignmentId) as { state: string } | undefined;
  const rubric = db
    .prepare(
      `SELECT id FROM rubric_versions
       WHERE id = ? AND workspace_id = ? AND round_id = ?`,
    )
    .get(contract.rubricVersionId, contract.workspaceId, contract.roundId);
  const semantics = db
    .prepare(
      `SELECT id FROM review_rubric_semantics
       WHERE workspace_id = ? AND round_id = ? AND rubric_version_id = ?`,
    )
    .get(contract.workspaceId, contract.roundId, contract.rubricVersionId);
  const artifact = db
    .prepare(
      `SELECT id FROM review_blind_artifacts
       WHERE workspace_id = ? AND assignment_id = ?`,
    )
    .get(contract.workspaceId, contract.assignmentId);
  if (
    !assignment ||
    assignment.rubricVersionId !== contract.rubricVersionId ||
    assignment.submissionId !== contract.submissionId ||
    assignment.reviewerAccountId !== contract.reviewer.accountId ||
    assignment.submissionEventId !== contract.eventId ||
    assignment.submissionState !== "SUBMITTED" ||
    !assignment.currentRevisionId ||
    assignmentState === undefined ||
    !REVIEW_ASSIGNMENT_STATES.has(assignmentState.state) ||
    !rubric ||
    !semantics ||
    !artifact
  ) {
    return fail("ASSIGNMENT_NOT_AVAILABLE");
  }

  const access = db
    .prepare(
      `SELECT state, sequence_number AS sequenceNumber,
              workspace_id AS workspaceId, event_id AS eventId, round_id AS roundId,
              assignment_id AS assignmentId,
              event_reviewer_assignment_id AS eventReviewerAssignmentId,
              reviewer_account_id AS reviewerAccountId, reviewer_person_id AS reviewerPersonId,
              account_person_binding_id AS accountPersonBindingId
       FROM reviewer_access_states
       WHERE workspace_id = ? AND assignment_id = ?
       ORDER BY sequence_number DESC LIMIT 1`,
    )
    .get(contract.workspaceId, contract.assignmentId) as
    | {
        state: ReviewerAccessState;
        sequenceNumber: number;
        workspaceId: string;
        eventId: string;
        roundId: string;
        assignmentId: string;
        eventReviewerAssignmentId: string;
        reviewerAccountId: string;
        reviewerPersonId: string;
        accountPersonBindingId: string;
      }
    | undefined;
  if (
    access &&
    (access.workspaceId !== contract.workspaceId ||
      access.eventId !== contract.eventId ||
      access.roundId !== contract.roundId ||
      access.assignmentId !== contract.assignmentId ||
      access.eventReviewerAssignmentId !== contract.eventReviewerAssignmentId ||
      access.reviewerAccountId !== contract.reviewer.accountId ||
      access.reviewerPersonId !== contract.reviewerPersonId ||
      access.accountPersonBindingId !== contract.accountPersonBindingId ||
      !["PROVISIONED", "INVITED", "ACTIVE"].includes(access.state) ||
      !Number.isInteger(access.sequenceNumber) ||
      access.sequenceNumber < 1 ||
      access.sequenceNumber > 3)
  ) {
    return fail("READ_FAILED");
  }

  const accessState = access?.state ?? null;
  const accessSequenceNumber = access?.sequenceNumber ?? 0;
  return Object.freeze({
    workspaceId: contract.workspaceId,
    workspaceSlug: workspace.slug,
    eventId: contract.eventId,
    roundId: contract.roundId,
    assignmentId: contract.assignmentId,
    eventReviewerAssignmentId: contract.eventReviewerAssignmentId,
    reviewerAccountId: contract.reviewer.accountId,
    reviewerPersonId: contract.reviewerPersonId,
    accountPersonBindingId: contract.accountPersonBindingId,
    reviewerName: person.fullName,
    reviewerEmail: person.email,
    accessState,
    accessSequenceNumber,
  });
}

function projectContext(context: PinnedContext): ReviewerProvisioningProjection {
  const status: ReviewerProvisioningStatus = context.accessState ?? "READY_TO_PROVISION";
  return Object.freeze({
    schema: REVIEWER_PROVISIONING_EVIDENCE_SCHEMA,
    workspaceId: context.workspaceId,
    workspaceSlug: context.workspaceSlug,
    eventId: context.eventId,
    roundId: context.roundId,
    assignmentId: context.assignmentId,
    eventReviewerAssignmentId: context.eventReviewerAssignmentId,
    reviewerAccountId: context.reviewerAccountId,
    reviewerPersonId: context.reviewerPersonId,
    accountPersonBindingId: context.accountPersonBindingId,
    reviewerName: context.reviewerName,
    reviewerEmail: context.reviewerEmail,
    status,
    accessState: context.accessState,
    accessSequenceNumber: context.accessSequenceNumber,
    queueReachable: context.accessState === "ACTIVE",
    providerMutation: false,
    credentialIssued: false,
  });
}

function requestFingerprint(actor: OrganizerActor, input: ReviewerProvisioningInput): string {
  return fingerprintOf({
    schema: V16_REVIEWER_ACCESS_REQUEST_SCHEMA,
    actorAccountId: actor.accountId,
    workspaceId: actor.workspaceId,
    eventId: input.eventId,
    roundId: input.roundId,
    assignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId,
    eventReviewerAssignmentId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventReviewerAssignmentId,
    reviewerAccountId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
    reviewerPersonId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewerPersonId,
    accountPersonBindingId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.accountPersonBindingId,
    intent: input.intent,
  });
}

function receiptFromRow(
  row: Record<string, unknown>,
  replayed: boolean,
): ReviewerProvisioningReceipt {
  const state = row.state as ReviewerAccessState;
  const sequenceNumber = state === "PROVISIONED" ? 1 : state === "INVITED" ? 2 : 3;
  return Object.freeze({
    schema: V16_REVIEWER_ACCESS_RECEIPT_SCHEMA,
    workspaceId: row.workspace_id as string,
    eventId: row.event_id as string,
    roundId: row.round_id as string,
    assignmentId: row.assignment_id as string,
    eventReviewerAssignmentId: row.event_reviewer_assignment_id as string,
    reviewerAccountId: row.reviewer_account_id as string,
    reviewerPersonId: row.reviewer_person_id as string,
    accountPersonBindingId: row.account_person_binding_id as string,
    actorAccountId: row.actor_account_id as string,
    intent: row.intent as ReviewerAccessIntent,
    state,
    sequenceNumber,
    receiptId: row.id as string,
    effectStateId: (row.effect_state_id as string | null) ?? null,
    requestFingerprint: row.request_fingerprint as string,
    idempotencyKey: row.idempotency_key as string,
    createdAt: row.created_at as string,
    transitioned: row.transitioned === 1,
    replayed,
    providerMutation: false,
    credentialIssued: false,
  });
}

function readExistingReceipt(
  db: Db,
  actor: OrganizerActor,
  input: ReviewerProvisioningInput,
  fingerprint: string,
): ReviewerProvisioningReceipt | null {
  const row = db
    .prepare(
      `SELECT * FROM reviewer_access_receipts
       WHERE workspace_id = ? AND idempotency_key = ?`,
    )
    .get(actor.workspaceId, input.idempotencyKey) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (
    row.request_fingerprint !== fingerprint ||
    row.actor_account_id !== actor.accountId ||
    row.event_id !== input.eventId ||
    row.round_id !== input.roundId ||
    row.assignment_id !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.assignmentId ||
    row.event_reviewer_assignment_id !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventReviewerAssignmentId ||
    row.reviewer_account_id !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId ||
    row.reviewer_person_id !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewerPersonId ||
    row.account_person_binding_id !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.accountPersonBindingId ||
    row.intent !== input.intent
  ) {
    return fail("IDEMPOTENCY_CONFLICT");
  }
  return receiptFromRow(row, true);
}

function writeTransition(
  db: Db,
  actor: OrganizerActor,
  context: PinnedContext,
  input: ReviewerProvisioningInput,
  fingerprint: string,
): ReviewerProvisioningReceipt {
  const stateForIntent: Record<ReviewerAccessIntent, ReviewerAccessState> = {
    PROVISION: "PROVISIONED",
    INVITE: "INVITED",
    ACTIVATE: "ACTIVE",
  };
  const targetState = stateForIntent[input.intent];
  const targetSequence = targetState === "PROVISIONED" ? 1 : targetState === "INVITED" ? 2 : 3;
  const currentSequence = context.accessSequenceNumber;
  if (input.intent === "INVITE" && currentSequence === 0) return fail("PROVISIONING_REQUIRED");
  if (input.intent === "ACTIVATE" && currentSequence === 0) return fail("PROVISIONING_REQUIRED");
  if (input.intent === "ACTIVATE" && currentSequence < 2) return fail("INVITATION_REQUIRED");

  const transitioned = currentSequence < targetSequence;
  const receiptId = uuid();
  const effectStateId = transitioned ? `reviewer-access-state:${receiptId}` : null;
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO reviewer_access_receipts
       (id, workspace_id, event_id, round_id, assignment_id, event_reviewer_assignment_id,
        reviewer_account_id, reviewer_person_id, account_person_binding_id, actor_account_id,
        intent, state, idempotency_key, request_schema, request_fingerprint, receipt_schema,
        transitioned, effect_state_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receiptId,
    context.workspaceId,
    context.eventId,
    context.roundId,
    context.assignmentId,
    context.eventReviewerAssignmentId,
    context.reviewerAccountId,
    context.reviewerPersonId,
    context.accountPersonBindingId,
    actor.accountId,
    input.intent,
    targetState,
    input.idempotencyKey,
    V16_REVIEWER_ACCESS_REQUEST_SCHEMA,
    fingerprint,
    V16_REVIEWER_ACCESS_RECEIPT_SCHEMA,
    transitioned ? 1 : 0,
    effectStateId,
    createdAt,
  );
  if (transitioned) {
    db.prepare(
      `INSERT INTO reviewer_access_states
         (id, workspace_id, event_id, round_id, assignment_id, event_reviewer_assignment_id,
          reviewer_account_id, reviewer_person_id, account_person_binding_id, state,
          sequence_number, actor_account_id, receipt_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      effectStateId,
      context.workspaceId,
      context.eventId,
      context.roundId,
      context.assignmentId,
      context.eventReviewerAssignmentId,
      context.reviewerAccountId,
      context.reviewerPersonId,
      context.accountPersonBindingId,
      targetState,
      targetSequence,
      actor.accountId,
      receiptId,
      createdAt,
    );
  }
  writeAudit(db, context.workspaceId, {
    actorKind: "account",
    actorRef: actor.accountId,
    action: "cfp.review.reviewer-access",
    targetType: "reviewer_access_receipt",
    targetId: receiptId,
    details: {
      schema: REVIEWER_PROVISIONING_EVIDENCE_SCHEMA,
      workspaceId: context.workspaceId,
      eventId: context.eventId,
      roundId: context.roundId,
      assignmentId: context.assignmentId,
      eventReviewerAssignmentId: context.eventReviewerAssignmentId,
      reviewerAccountId: context.reviewerAccountId,
      reviewerPersonId: context.reviewerPersonId,
      accountPersonBindingId: context.accountPersonBindingId,
      intent: input.intent,
      state: targetState,
      sequenceNumber: targetSequence,
      receiptId,
      transitioned,
      providerMutation: false,
      credentialIssued: false,
    },
  });
  const row = db
    .prepare("SELECT * FROM reviewer_access_receipts WHERE id = ?")
    .get(receiptId) as Record<string, unknown> | undefined;
  if (!row) return fail("WRITE_FAILED");
  return receiptFromRow(row, false);
}

export function readPinnedReviewerProvisioning(
  db: Db,
  session: SessionInfo,
  input: ReadPinnedReviewerProvisioningInput,
): ReviewerProvisioningProjection {
  const capturedInput = captureReadInput(input);
  try {
    return withOwnedTransaction(db, "BEGIN", () => {
      const actor = authenticateOrganizer(db, session);
      if (actor.workspaceId !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId) {
        return fail("ACCESS_DENIED");
      }
      return projectContext(requirePinnedContext(db, capturedInput));
    });
  } catch (error) {
    if (error instanceof ReviewerProvisioningServiceError) throw error;
    throw new ReviewerProvisioningServiceError("READ_FAILED");
  }
}

export function provisionPinnedReviewer(
  db: Db,
  session: SessionInfo,
  input: ReviewerProvisioningInput,
): ReviewerProvisioningReceipt {
  const capturedInput = captureInput(input);
  try {
    return withOwnedTransaction(db, "BEGIN IMMEDIATE", () => {
      const actor = authenticateOrganizer(db, session);
      if (actor.workspaceId !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId) {
        return fail("ACCESS_DENIED");
      }
      const fingerprint = requestFingerprint(actor, capturedInput);
      const existing = readExistingReceipt(db, actor, capturedInput, fingerprint);
      if (existing) return existing;
      const context = requirePinnedContext(db, capturedInput);
      return writeTransition(db, actor, context, capturedInput, fingerprint);
    });
  } catch (error) {
    if (error instanceof ReviewerProvisioningServiceError) throw error;
    throw new ReviewerProvisioningServiceError("WRITE_FAILED");
  }
}

export function requirePinnedReviewerActivation(db: Db): PinnedContext {
  if (db.isTransaction) fail("OUTER_TRANSACTION_DENIED");
  try {
    return withOwnedTransaction(db, "BEGIN", () => {
      return assertPinnedReviewerActivationInTransaction(db);
    });
  } catch (error) {
    if (error instanceof ReviewerProvisioningServiceError) throw error;
    throw new ReviewerProvisioningServiceError("ACCESS_DENIED");
  }
}

/** The reviewer service calls this only inside its already-owned read transaction. */
export function assertPinnedReviewerActivationInTransaction(db: Db): PinnedContext {
  const context = requirePinnedContext(db, {
    eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
    roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
  });
  if (context.accessState !== "ACTIVE") return fail("ACCESS_DENIED");
  return context;
}
