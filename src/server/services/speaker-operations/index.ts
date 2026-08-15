import { commitmentResponseCommandKey } from "../commitments";
import { canonicalJson, deterministicUuid, fingerprintOf, randomToken, sha256Hex } from "../../canonical";
import { withTransaction, withTransactionOrSavepoint, type Db } from "../../db";
import { roleHasCapability } from "../../auth";
import { writeAudit } from "../audit";
import { csvSafeCell } from "../csv-safe";
import { NoNetworkActionTaskReminderDeliveryAdapter } from "../../adapters/delivery-adapter";
import {
  evaluateSpeakerReadiness,
  type SpeakerAuthorityFact,
  type SpeakerCommitmentFact,
  type SpeakerFindingFact,
  type SpeakerOfferFact,
  type SpeakerReadinessFacts,
  type SpeakerReadinessResult,
  type SpeakerRequirementDecisionFact,
  type SpeakerRequirementFact,
  type SpeakerRoleFact,
  type SpeakerScheduleFact,
  type SpeakerSourceRecord,
  type SpeakerSourceRef,
  type SpeakerSubmissionFact,
} from "../../adapters/speaker-readiness";
import {
  createSyntheticContentOperationsRepository,
  CONTENT_KINDS,
  createDurableContentOperationsRepository,
  rollbackUnpublishedContentVersion,
  validateContentPayload,
  type ContentApproval,
  type ContentComment,
  type ContentFinding,
  type ContentKind,
  type ContentOperationsRepository,
  type ContentOperationsScope,
  type ContentReviewProjection,
  type ContentRevisionRequest,
  type ContentSubmissionVersion,
  type SocialLink,
} from "../content-operations";
import {
  createManualSpeaker,
  ManualSpeakerAuthorizationError,
  ManualSpeakerError,
} from "./manual-speakers";
import {
  type AssignmentDecisionState,
  type ActionTaskReminderDeliveryAdapter,
  type ActionTaskReminderDeliveryIntent,
  type ActionTaskReminderProviderReceipt,
  type AutomaticActionTaskReminderJobReceipt,
  type AutomaticActionTaskReminderPreparationReceipt,
  type CanonicalPersonProjection,
  type CommitmentState,
  type CreateSharedActionTaskInput,
  type CreateSpeakerTaskInput,
  type CompleteSpeakerTaskInput,
  type CompleteSpeakerTaskResult,
  type InvitationState,
  type RespondToInvitationResult,
  type SpeakerAssignmentProjection,
  type SpeakerCommunicationEvidence,
  type SpeakerCsvImportReceipt,
  type SpeakerCsvImportColumns,
  type SpeakerCsvImportRowReceipt,
  type SpeakerEventContext,
  type SpeakerEventInitialization,
  type SpeakerInvitationProjection,
  type SpeakerInvitationResponseProjection,
  type SpeakerLogisticsProjection,
  type SpeakerOrganizerProjection,
  type SpeakerOrganizerScope,
  type SpeakerOperationsRepository,
  type SpeakerPortalProjection,
  type SpeakerPortalTokenProjection,
  type SpeakerProfileProjection,
  type SpeakerProfileSnapshot,
  type SpeakerReadinessMatrixRow,
  type SpeakerReadinessProjection,
  type SpeakerRosterFilter,
  type SpeakerRosterRecord,
  type SpeakerRole,
  type SpeakerTaskKind,
  type SpeakerTaskProjection,
  type SpeakerTaskState,
  type SpeakerTaskTransition,
  type SpeakerWorkflowStatus,
  type UpdateSpeakerWorkflowStatusInput,
  type UpdateSpeakerWorkflowStatusResult,
  type SharedActionTaskAssignmentProjection,
  type SharedActionTaskAssigneeProjection,
  type SharedActionTaskBatchProjection,
  type SharedActionTaskReceipt,
  type SharedActionTaskReminderDelivery,
  type SharedActionTaskReminderDeliveryStatus,
  type SharedActionTaskReminderReceipt,
  type SubmitSpeakerContentResult,
  type UpdateSpeakerTaskInput,
} from "./contracts";
import { speakerEventInitializationFor } from "./synthetic-context";
import {
  EVALUATOR_ARTIFACT_PERSON_ID,
  isEvaluatorArtifactScope,
} from "../evaluator-speaker-identity";
import { revalidateSpeakerPortalToken, resolveSpeakerPortalToken, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY, SPEAKER_PORTAL_TOKEN_TTL_MS } from "../speaker-portal-access";
import {
  ASSIGNMENT_DECISION_STATES,
  COMMITMENT_STATES,
  SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS,
  SPEAKER_CSV_IMPORT_LEGACY_COLUMNS,
  SPEAKER_CSV_IMPORT_SCHEMA,
  SPEAKER_CSV_MAX_CHARACTERS,
  SPEAKER_CSV_MAX_ROWS,
  INVITATION_STATES,
  isValidSpeakerTaskContentPair,
  SPEAKER_OPERATIONS_SCHEMA,
  SPEAKER_PORTAL_PURPOSE,
  SPEAKER_ROLES,
  SPEAKER_TASK_KINDS,
  SPEAKER_TASK_STATES,
  SPEAKER_WORKFLOW_STATUSES,
  SHARED_ACTION_TASK_MAX_ASSIGNEES,
  SHARED_ACTION_TASK_MAX_DUE_DAYS,
  SHARED_ACTION_TASK_MAX_INSTRUCTIONS,
  SHARED_ACTION_TASK_MAX_SELECTABLE_SPEAKERS,
  SHARED_ACTION_TASK_MIN_ASSIGNEES,
  SHARED_ACTION_TASK_RECEIPT_SCHEMA,
  SHARED_ACTION_TASK_REMINDER_RECEIPT_SCHEMA,
  SHARED_ACTION_TASK_REMINDER_JOB_SCHEMA,
  SHARED_ACTION_TASK_REMINDER_MAX_ATTEMPTS,
  SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS,
  SHARED_ACTION_TASK_REMINDER_MAX_DELIVERIES,
  SHARED_ACTION_TASK_REMINDER_MAX_EVENT_SCOPES,
  SHARED_ACTION_TASK_REMINDER_PROVIDER_RECEIPT_SCHEMA,
  SHARED_ACTION_TASK_REMINDER_SCHEMA,
  SHARED_ACTION_TASK_REMINDER_WINDOW_DAYS,
  SHARED_ACTION_TASK_SCHEMA,
} from "./contracts";

export * from "./contracts";
export { speakerEventInitializationFor } from "./synthetic-context";

export class SpeakerOperationsInputError extends Error {
  readonly code = "INVALID_SPEAKER_OPERATION_INPUT" as const;

  constructor(message = "Speaker operation input is invalid.") {
    super(message);
    this.name = "SpeakerOperationsInputError";
  }
}

export class SpeakerOperationsAuthorizationError extends Error {
  readonly code = "SPEAKER_OPERATION_NOT_AUTHORIZED" as const;

  constructor(message = "Speaker operation is not authorized for this scope.") {
    super(message);
    this.name = "SpeakerOperationsAuthorizationError";
  }
}

export class SpeakerOperationsConflictError extends Error {
  readonly code = "SPEAKER_OPERATION_CONFLICT" as const;

  constructor(message = "Speaker operation conflicts with current truth or immutable history.") {
    super(message);
    this.name = "SpeakerOperationsConflictError";
  }
}

type Clock = () => string;

const SYNTHETIC_START = Date.parse("2026-08-12T12:00:00.000Z");
const SAFE_ID = /^[^\u0000-\u001f\u007f-\u009f]{1,160}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
const SYNTHETIC_TOKEN_REGISTRY = new Map<string, { readonly workspaceId: string; readonly eventId: string; readonly personId: string }>();

function syntheticPortalExpiry(clock: Clock): string {
  const now = Date.parse(clock());
  if (!Number.isFinite(now)) throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  return new Date(now + SPEAKER_PORTAL_TOKEN_TTL_MS).toISOString();
}

function fail(message: string): never {
  throw new SpeakerOperationsInputError(message);
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${field} is invalid.`);
  return value;
}

function speakerRoleFromPersisted(value: unknown): SpeakerRole | null {
  if (value === "SPEAKER" || value === "participant") return "SPEAKER";
  if (value === "MODERATOR" || value === "moderator") return "MODERATOR";
  return null;
}

function text(value: unknown, field: string, max = 240): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail(`${field} is invalid.`);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function scopeKey(workspaceId: string, eventId: string): string {
  return JSON.stringify([workspaceId, eventId]);
}

function personIdFor(workspaceId: string, alias: string): string {
  return deterministicUuid(`canonical-person:${workspaceId}:${alias}`);
}

function organizerIdFor(workspaceId: string): string {
  return deterministicUuid(`synthetic-organizer:${workspaceId}`);
}

/**
 * Synthetic fixture helper. Production adapters must generate a fresh opaque token and persist
 * only its hash; this deterministic value is deliberately limited to local fixture data.
 */
export function syntheticSpeakerPortalToken(workspaceId: string, eventId: string, personId: string): string {
  boundedId(workspaceId, "workspaceId");
  boundedId(eventId, "eventId");
  boundedId(personId, "personId");
  const token = sha256Hex(`sympose.synthetic.${SPEAKER_PORTAL_PURPOSE}:${workspaceId}:${eventId}:${personId}:v1`);
  SYNTHETIC_TOKEN_REGISTRY.set(sha256Hex(token), { workspaceId, eventId, personId });
  return token;
}

export const speakerPortalTokenFor = syntheticSpeakerPortalToken;

function syntheticPortalAuthority(
  workspaceId: string,
  eventId: string,
  personId: string,
  assignmentId: string,
  planVersionId: string,
  acceptedTermsFingerprint: string,
): Pick<SpeakerPortalTokenProjection, "assignmentId" | "planVersionId" | "planVersionFingerprint" | "acceptedTermsFingerprint" | "authorityFingerprint"> {
  const planVersionFingerprint = fingerprintOf({ schema: "synthetic-speaker-plan/v1", workspaceId, eventId, planVersionId });
  return {
    assignmentId,
    planVersionId,
    planVersionFingerprint,
    acceptedTermsFingerprint,
    authorityFingerprint: fingerprintOf({
      schema: "speaker-portal-token-authority/v1",
      workspaceId,
      eventId,
      personId,
      assignmentId,
      planVersionId,
      planVersionFingerprint,
      acceptedTermsFingerprint,
    }),
  };
}

interface SyntheticPersonSeed {
  readonly personId?: string;
  readonly assignmentId?: string;
  readonly alias: string;
  readonly fullName: string;
  readonly organization: string;
  readonly title: string;
  readonly role: SpeakerRole;
  readonly programUnitName: string;
  readonly location: string;
  readonly invitationState: Extract<InvitationState, "RESPONDED" | "SENT">;
  readonly response: Extract<CommitmentState, "ACCEPTED"> | null;
  readonly profileState: "APPROVED" | "CHANGES_REQUESTED" | "NOT_SUBMITTED";
}

const SYNTHETIC_PEOPLE: readonly SyntheticPersonSeed[] = [
  {
    alias: "ada",
    fullName: "Ada Lovelace",
    organization: "Analytical Engines Lab",
    title: "Research Director",
    role: "SPEAKER",
    programUnitName: "Responsible Systems in Practice",
    location: "Room A · Main Stage",
    invitationState: "RESPONDED",
    response: "ACCEPTED",
    profileState: "APPROVED",
  },
  {
    alias: "bruno",
    fullName: "Bruno Silva",
    organization: "Synthetic Commons",
    title: "Community Moderator",
    role: "MODERATOR",
    programUnitName: "Responsible Systems Roundtable",
    location: "Room C · Workshop Wing",
    invitationState: "SENT",
    response: null,
    profileState: "NOT_SUBMITTED",
  },
  {
    alias: "cass",
    fullName: "Cass Nguyen",
    organization: "Open Methods Studio",
    title: "Product Strategist",
    role: "SPEAKER",
    programUnitName: "Building Evidence-Aware Products",
    location: "Room B · Main Stage",
    invitationState: "RESPONDED",
    response: "ACCEPTED",
    profileState: "CHANGES_REQUESTED",
  },
];

const EVALUATOR_SYNTHETIC_PEOPLE: readonly SyntheticPersonSeed[] = [
  {
    personId: EVALUATOR_ARTIFACT_PERSON_ID,
    assignmentId: "",
    alias: "mina",
    fullName: "Mina Park",
    organization: "Signal Garden",
    title: "Evaluation Lead",
    role: "MODERATOR",
    programUnitName: "Trustworthy Evaluation Keynote",
    location: "Room A · Main Stage",
    invitationState: "RESPONDED",
    response: "ACCEPTED",
    profileState: "APPROVED",
  },
];

interface InvitationStateRecord {
  readonly id: string;
  readonly personId: string;
  readonly invitationType: "CONTENT_AND_ROLE" | "SCHEDULE_NOTICE";
  readonly state: InvitationState;
  readonly sourcePlanVersionId: string;
  readonly sourcePlanAssignmentId: string;
  readonly assignmentLineageId: string;
  readonly commitmentOfferId: string;
  readonly offeredTerms: SpeakerInvitationProjection["offeredTerms"];
  readonly termsFingerprint: string;
  readonly deliveredAt: string | null;
  readonly respondedAt: string | null;
  readonly response: SpeakerInvitationResponseProjection | null;
  readonly deliveryEvidence: SpeakerCommunicationEvidence;
}

interface AssignmentStateRecord {
  readonly assignmentId: string;
  readonly assignmentLineageId: string;
  readonly personId: string;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly role: SpeakerRole;
  readonly decision: AssignmentDecisionState;
  readonly sourcePlanVersionId: string;
  readonly sourcePlanAssignmentId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly location: string;
  readonly offerId: string;
}

interface TaskStateRecord {
  readonly id: string;
  readonly personId: string;
  readonly assignmentId: string;
  readonly kind: SpeakerTaskKind;
  readonly contentKind: ContentKind | null;
  readonly title: string;
  readonly description: string;
  readonly required: boolean;
  readonly gate: SpeakerTaskProjection["gate"];
  readonly dueAt: string;
  readonly owner: "SPEAKER" | "ORGANIZER";
  readonly state: SpeakerTaskState;
  readonly transitions: readonly SpeakerTaskTransition[];
}

interface ProfileBase {
  readonly bio: string;
  readonly publicTitle: string;
  readonly organization: string;
  readonly socialLinks: readonly SocialLink[];
  readonly headshot: SpeakerProfileSnapshot["headshot"];
  readonly sourceVersionId: string;
  readonly sourceContentHash: string;
}

interface TokenStateRecord extends SpeakerPortalTokenProjection {
  readonly tokenHash: string;
}

interface WorkflowStatusStateRecord {
  readonly eventId: string;
  readonly status: SpeakerWorkflowStatus;
  readonly previousStatus: SpeakerWorkflowStatus | null;
  readonly expectedCurrentStatus: SpeakerWorkflowStatus;
  readonly expectedVersion: string | null;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly idempotencyKey: string | null;
  readonly requestFingerprint: string;
}

interface State {
  readonly event: SpeakerEventContext;
  readonly eventInitialization: SpeakerEventInitialization;
  readonly people: Map<string, CanonicalPersonProjection>;
  readonly invitations: Map<string, InvitationStateRecord>;
  readonly assignments: Map<string, AssignmentStateRecord>;
  readonly tasks: Map<string, TaskStateRecord>;
  readonly profiles: Map<string, ProfileBase>;
  readonly logistics: Map<string, SpeakerLogisticsProjection>;
  readonly communications: Map<string, SpeakerCommunicationEvidence[]>;
  readonly tokens: Map<string, TokenStateRecord>;
  readonly workflowStatuses: Map<string, WorkflowStatusStateRecord>;
  readonly identityIndex: Map<string, string>;
  readonly csvImportReceipts: SpeakerCsvImportReceipt[];
}

interface NormalizedSpeakerCsvRow {
  readonly fullName: string;
  readonly email: string | null;
  readonly organization: string;
  readonly title: string;
  readonly bio: string;
  readonly role: SpeakerRole;
  readonly programUnitName: string;
  readonly emailIdentityKey: string | null;
  readonly nameIdentityKey: string;
  readonly primaryIdentityKey: string;
}

interface ParsedSpeakerCsvRecord {
  readonly rowNumber: number;
  readonly cells: readonly string[];
}

type SpeakerCsvImportFormat = "legacy" | "evaluator";

interface ParsedSpeakerCsv {
  readonly columns: SpeakerCsvImportColumns;
  readonly format: SpeakerCsvImportFormat;
  readonly records: readonly ParsedSpeakerCsvRecord[];
}

interface DurableCsvImportRow {
  readonly rowNumber: number;
  readonly status: SpeakerCsvImportRowReceipt["status"];
  readonly personId: string | null;
  readonly row: NormalizedSpeakerCsvRow | null;
}

const IMPORTED_SPEAKER_PROGRAM_UNIT = "Imported speaker program unit";

function profileAsset(alias: string): NonNullable<SpeakerProfileSnapshot["headshot"]> {
  return Object.freeze({
    assetId: deterministicUuid(`synthetic-headshot:${alias}`),
    fileName: `${alias}-headshot.webp`,
    mediaType: "image/webp",
    byteSize: 128_000,
    checksum: fingerprintOf({ alias, asset: "headshot" }),
    storageRef: `synthetic://headshots/${alias}`,
  });
}

function profilePayload(seed: SyntheticPersonSeed): Record<string, unknown> {
  return {
    kind: "PROFILE",
    bio: `${seed.fullName} works on practical methods for trustworthy programs and public-interest technology.`,
    publicTitle: seed.title,
    organization: seed.organization,
    socialLinks: [{ label: "Profile", url: `https://synthetic.example/${seed.alias}` }],
    headshot: profileAsset(seed.alias),
  };
}

function baseProfile(seed: SyntheticPersonSeed): ProfileBase {
  const profile = {
    bio: `${seed.fullName} works on practical methods for trustworthy programs and public-interest technology.`,
    publicTitle: seed.title,
    organization: seed.organization,
    socialLinks: [{ label: "Profile", url: `https://synthetic.example/${seed.alias}` }],
    headshot: profileAsset(seed.alias),
  };
  return { ...profile, sourceVersionId: "synthetic-profile-baseline", sourceContentHash: fingerprintOf(profile) };
}

function createMonotonicClock(start = SYNTHETIC_START): Clock {
  let cursor = start;
  return () => new Date(++cursor).toISOString();
}

function createWallMonotonicClock(): Clock {
  let cursor = Date.now() - 1;
  return () => {
    cursor = Math.max(cursor + 1, Date.now());
    return new Date(cursor).toISOString();
  };
}

function instant(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 80) fail(`${field} is invalid.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${field} is invalid.`);
  return new Date(timestamp).toISOString();
}

function optionalOperationKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  return text(value, "idempotencyKey", 240);
}

function taskState(value: unknown): SpeakerTaskState {
  if (typeof value !== "string" || !SPEAKER_TASK_STATES.includes(value as SpeakerTaskState)) fail("task state is unsupported.");
  return value as SpeakerTaskState;
}

function workflowStatus(value: unknown): SpeakerWorkflowStatus {
  if (typeof value !== "string" || !SPEAKER_WORKFLOW_STATUSES.includes(value as SpeakerWorkflowStatus)) {
    fail("workflow status is unsupported.");
  }
  return value as SpeakerWorkflowStatus;
}

function contentKindOf(value: unknown): ContentKind {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("content payload is invalid.");
  const kind = (value as { readonly kind?: unknown }).kind;
  if (typeof kind !== "string" || !CONTENT_KINDS.includes(kind as ContentKind)) fail("content payload kind is unsupported.");
  return kind as ContentKind;
}

function parseSpeakerCsv(csvText: string): ParsedSpeakerCsv {
  if (typeof csvText !== "string" || csvText.trim().length === 0) fail("Speaker CSV text is required.");
  if (csvText.length > SPEAKER_CSV_MAX_CHARACTERS) fail(`Speaker CSV text is limited to ${SPEAKER_CSV_MAX_CHARACTERS} characters.`);

  const records: ParsedSpeakerCsvRecord[] = [];
  const cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let justClosedQuote = false;
  let line = 1;
  let rowStartLine = 1;

  const finishRow = (): void => {
    cells.push(field);
    field = "";
    if (cells.some((cell) => cell.trim().length > 0)) records.push({ rowNumber: rowStartLine, cells: [...cells] });
    cells.length = 0;
    if (records.length > SPEAKER_CSV_MAX_ROWS + 1) fail(`Speaker CSV is limited to ${SPEAKER_CSV_MAX_ROWS} data rows.`);
  };

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (csvText[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        if (character === "\r") {
          field += "\n";
          if (csvText[index + 1] === "\n") index += 1;
          line += 1;
        } else {
          field += character;
          if (character === "\n") line += 1;
        }
      }
      continue;
    }

    if (justClosedQuote) {
      if (character === ",") {
        cells.push(field);
        field = "";
        justClosedQuote = false;
      } else if (character === "\r" || character === "\n") {
        finishRow();
        if (character === "\r" && csvText[index + 1] === "\n") index += 1;
        line += 1;
        rowStartLine = line;
        justClosedQuote = false;
      } else {
        fail(`Unexpected character after a quoted CSV field on line ${line}.`);
      }
      continue;
    }

    if (character === '"') {
      if (field.length > 0) fail(`Quoted CSV fields must begin at the start of a cell on line ${line}.`);
      inQuotes = true;
    } else if (character === ",") {
      cells.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      finishRow();
      if (character === "\r" && csvText[index + 1] === "\n") index += 1;
      line += 1;
      rowStartLine = line;
    } else {
      field += character;
    }
  }

  if (inQuotes) fail(`Speaker CSV contains an unterminated quoted field on line ${line}.`);
  if (field.length > 0 || cells.length > 0 || justClosedQuote) {
    finishRow();
  }
  if (records.length === 0) fail("Speaker CSV must include a header row.");
  const header = records[0]!.cells.map((cell) => cell.replace(/^\uFEFF/u, ""));
  const matches = (columns: SpeakerCsvImportColumns): boolean => header.length === columns.length && columns.every((column, index) => header[index] === column);
  if (matches(SPEAKER_CSV_IMPORT_LEGACY_COLUMNS)) return { columns: SPEAKER_CSV_IMPORT_LEGACY_COLUMNS, format: "legacy", records: records.slice(1) };
  if (matches(SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS)) return { columns: SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS, format: "evaluator", records: records.slice(1) };
  fail(`Speaker CSV header must be exactly one of: ${SPEAKER_CSV_IMPORT_LEGACY_COLUMNS.join(",")} or ${SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS.join(",")}.`);
}

function optionalCsvCell(value: string | undefined, fieldName: string, max: number): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? "" : text(trimmed, fieldName, max);
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function normalizeSpeakerCsvRow(record: ParsedSpeakerCsvRecord, format: SpeakerCsvImportFormat): NormalizedSpeakerCsvRow {
  const columns = format === "legacy" ? SPEAKER_CSV_IMPORT_LEGACY_COLUMNS : SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS;
  if (record.cells.length !== columns.length) fail(`Row ${record.rowNumber} must contain exactly ${columns.length} columns.`);
  const isLegacy = format === "legacy";
  const fullName = text(record.cells[0]!.trim(), isLegacy ? "full_name" : "name", 160);
  const emailValue = optionalCsvCell(record.cells[1], "email", 320);
  if (emailValue && !/^[^\s@]+@[^\s@]+$/u.test(emailValue)) fail(`Row ${record.rowNumber} has an invalid email identity.`);
  const title = optionalCsvCell(record.cells[isLegacy ? 3 : 2], "title", 240) || "Speaker";
  const organization = optionalCsvCell(record.cells[isLegacy ? 2 : 3], isLegacy ? "organization" : "company", 240) || "Independent";
  const bio = isLegacy ? `${fullName} is joining this event's speaker roster.` : optionalCsvCell(record.cells[4], "bio", 2_000) || `${fullName} is joining this event's speaker roster.`;
  const roleValue = isLegacy ? optionalCsvCell(record.cells[4], "role", 40) || "SPEAKER" : "SPEAKER";
  if (!SPEAKER_ROLES.includes(roleValue as SpeakerRole)) fail(`Row ${record.rowNumber} has an unsupported role.`);
  const programUnitName = isLegacy ? optionalCsvCell(record.cells[5], "program_unit", 240) || IMPORTED_SPEAKER_PROGRAM_UNIT : IMPORTED_SPEAKER_PROGRAM_UNIT;
  const nameIdentity = `name:${normalizeIdentityPart(fullName)}|organization:${normalizeIdentityPart(organization)}`;
  const emailIdentity = emailValue ? `email:${normalizeEmail(emailValue)}` : null;
  return { fullName, email: emailValue || null, organization, title, bio, role: roleValue as SpeakerRole, programUnitName, emailIdentityKey: emailIdentity, nameIdentityKey: nameIdentity, primaryIdentityKey: emailIdentity ?? nameIdentity };
}

function registerPersonIdentity(state: State, personId: string, fullName: string, organization: string, email: string | null = null): void {
  const nameIdentity = `name:${normalizeIdentityPart(fullName)}|organization:${normalizeIdentityPart(organization)}`;
  const keys = email ? [`email:${normalizeEmail(email)}`, nameIdentity] : [nameIdentity];
  for (const key of keys) {
    const prior = state.identityIndex.get(key);
    if (prior && prior !== personId) throw new SpeakerOperationsConflictError("Speaker identity is already bound to another canonical Person.");
  }
  for (const key of keys) state.identityIndex.set(key, personId);
}

function assertOrganizerScope(scope: SpeakerOrganizerScope, event: SpeakerEventContext): void {
  if (scope.kind !== "organizer" || scope.workspaceId.length < 1 || scope.eventId !== event.id || scope.actorId.length < 1) {
    throw new SpeakerOperationsAuthorizationError("Organizer scope does not authorize this workspace event.");
  }
}

function assertToken(token: unknown): string {
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
  }
  return token;
}

function invitationProjection(record: InvitationStateRecord, deliveryEvidence = record.deliveryEvidence): SpeakerInvitationProjection {
  return { ...record, deliveryEvidence };
}

function assignmentProjection(state: State, assignment: AssignmentStateRecord): SpeakerAssignmentProjection {
  const invitation = [...state.invitations.values()].find((candidate) => candidate.commitmentOfferId === assignment.offerId);
  const response = invitation?.response ?? null;
  return {
    assignmentId: assignment.assignmentId,
    assignmentLineageId: assignment.assignmentLineageId,
    personId: assignment.personId,
    programUnitId: assignment.programUnitId,
    programUnitName: assignment.programUnitName,
    role: assignment.role,
    decision: assignment.decision,
    sourcePlanVersionId: assignment.sourcePlanVersionId,
    sourcePlanAssignmentId: assignment.sourcePlanAssignmentId,
    schedule: {
      startsAt: assignment.startsAt,
      endsAt: assignment.endsAt,
      timezone: assignment.timezone,
      location: assignment.location,
    },
    commitment: {
      state: response?.state ?? "PENDING",
      offerId: assignment.offerId,
      offerTermsFingerprint: invitation?.termsFingerprint ?? "",
      responseId: response?.id ?? null,
      respondedAt: response?.respondedAt ?? null,
    },
  };
}

interface CanonicalSpeakerAssignment {
  readonly assignmentId: string;
  readonly planVersionId: string;
  readonly planVersionFingerprint: string;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly role: SpeakerRole;
  readonly offerId: string;
  readonly offerTermsFingerprint: string;
  readonly responseId: string;
  readonly respondedAt: string;
  readonly terms: Record<string, unknown>;
}

function canonicalSpeakerAssignment(db: Db, workspaceId: string, eventId: string, personId: string): CanonicalSpeakerAssignment | null {
  try {
    const row = db.prepare(
      `SELECT assignment.id AS assignmentId, plan.id AS planVersionId,
              plan.fingerprint AS planVersionFingerprint,
              unit.id AS programUnitId, unit.name AS programUnitName,
              assignment.assignment_type AS role, offer.id AS offerId,
              offer.terms_json AS termsJson, offer.terms_fingerprint AS offerTermsFingerprint,
              response.id AS responseId, response.responded_at AS respondedAt
       FROM events event_row
       JOIN plan_versions plan ON plan.id = event_row.current_plan_version_id
        AND plan.workspace_id = event_row.workspace_id AND plan.event_id = event_row.id
       JOIN plan_assignments assignment ON assignment.plan_version_id = plan.id
        AND assignment.workspace_id = plan.workspace_id AND assignment.person_id = ?
       LEFT JOIN event_speakers accepted_speaker ON accepted_speaker.workspace_id = plan.workspace_id
        AND accepted_speaker.event_id = event_row.id
        AND accepted_speaker.person_id = assignment.person_id
        AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')
        AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')
       JOIN program_units unit ON unit.id = assignment.program_unit_id
        AND unit.workspace_id = assignment.workspace_id AND unit.event_id = event_row.id
       JOIN approvals approval ON approval.plan_version_id = plan.id
        AND approval.workspace_id = plan.workspace_id AND approval.event_id = event_row.id
        AND approval.decision = 'approved'
       JOIN plan_states current_state ON current_state.plan_version_id = plan.id
        AND current_state.workspace_id = plan.workspace_id AND current_state.state = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM plan_states newer_state
          WHERE newer_state.workspace_id = current_state.workspace_id
            AND newer_state.plan_version_id = current_state.plan_version_id
            AND (newer_state.created_at > current_state.created_at
              OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))
        )
        AND NOT EXISTS (
          SELECT 1 FROM plan_states superseded_state
          WHERE superseded_state.workspace_id = plan.workspace_id
            AND superseded_state.plan_version_id = plan.id
            AND superseded_state.state = 'superseded'
        )
       JOIN commitment_offers offer ON offer.plan_version_id = plan.id
        AND offer.workspace_id = plan.workspace_id AND offer.event_id = event_row.id
        AND offer.person_id = assignment.person_id
        AND offer.status = 'offered'
       JOIN commitment_responses response ON response.offer_id = offer.id
        AND response.workspace_id = offer.workspace_id AND response.actor_person_id = offer.person_id
        AND response.response = 'accepted'
       WHERE event_row.workspace_id = ? AND event_row.id = ?
         AND (accepted_speaker.id IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM event_speakers any_speaker
           WHERE any_speaker.workspace_id = plan.workspace_id
             AND any_speaker.event_id = event_row.id
             AND any_speaker.person_id = assignment.person_id
             AND any_speaker.role_key IN ('SPEAKER', 'MODERATOR')
         ))
         AND json_extract(offer.terms_json, '$.planVersionId') = plan.id
         AND json_extract(offer.terms_json, '$.eventId') = event_row.id
         AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id
         AND (accepted_speaker.id IS NULL OR CASE accepted_speaker.role_key
               WHEN 'SPEAKER' THEN 'SPEAKER'
               WHEN 'MODERATOR' THEN 'MODERATOR'
             END = CASE assignment.assignment_type
               WHEN 'SPEAKER' THEN 'SPEAKER'
               WHEN 'participant' THEN 'SPEAKER'
               WHEN 'MODERATOR' THEN 'MODERATOR'
               WHEN 'moderator' THEN 'MODERATOR'
             END)
         AND CASE assignment.assignment_type
               WHEN 'SPEAKER' THEN 'SPEAKER'
               WHEN 'participant' THEN 'SPEAKER'
               WHEN 'MODERATOR' THEN 'MODERATOR'
               WHEN 'moderator' THEN 'MODERATOR'
             END = CASE json_extract(offer.terms_json, '$.role')
               WHEN 'SPEAKER' THEN 'SPEAKER'
               WHEN 'participant' THEN 'SPEAKER'
               WHEN 'MODERATOR' THEN 'MODERATOR'
               WHEN 'moderator' THEN 'MODERATOR'
             END
         AND ((SELECT COUNT(*)
               FROM event_speakers accepted_scope_speaker
               WHERE accepted_scope_speaker.workspace_id = plan.workspace_id
                 AND accepted_scope_speaker.event_id = event_row.id
                 AND accepted_scope_speaker.person_id = assignment.person_id
                 AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')
                 AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) = 1
           OR (SELECT COUNT(*)
               FROM event_speakers any_scope_speaker
               WHERE any_scope_speaker.workspace_id = plan.workspace_id
                 AND any_scope_speaker.event_id = event_row.id
                 AND any_scope_speaker.person_id = assignment.person_id
                 AND any_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')) = 0)
         AND (SELECT COUNT(*) FROM plan_assignments current_assignment
              WHERE current_assignment.workspace_id = plan.workspace_id
                AND current_assignment.plan_version_id = plan.id
                AND current_assignment.person_id = assignment.person_id) = 1
       GROUP BY assignment.id
       HAVING COUNT(DISTINCT assignment.id) = 1
          AND COUNT(DISTINCT accepted_speaker.id) <= 1
          AND COUNT(DISTINCT offer.id) = 1
          AND COUNT(DISTINCT response.id) = 1
       LIMIT 2`,
    ).all(personId, workspaceId, eventId) as unknown as readonly Record<string, unknown>[];
    if (row.length !== 1 || typeof row[0]?.assignmentId !== 'string' || typeof row[0].termsJson !== 'string') return null;
    const terms = JSON.parse(row[0].termsJson) as Record<string, unknown>;
    const role = speakerRoleFromPersisted(row[0].role);
    if (typeof row[0].offerId !== 'string' || typeof row[0].planVersionId !== 'string' || typeof row[0].planVersionFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(row[0].planVersionFingerprint) || typeof row[0].programUnitId !== 'string' || typeof row[0].programUnitName !== 'string' || !role || typeof row[0].offerTermsFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(row[0].offerTermsFingerprint) || fingerprintOf(terms) !== row[0].offerTermsFingerprint || typeof row[0].responseId !== 'string' || typeof row[0].respondedAt !== 'string') return null;
    return { assignmentId: row[0].assignmentId, planVersionId: row[0].planVersionId, planVersionFingerprint: row[0].planVersionFingerprint, programUnitId: row[0].programUnitId, programUnitName: row[0].programUnitName, role, offerId: row[0].offerId, offerTermsFingerprint: row[0].offerTermsFingerprint, responseId: row[0].responseId, respondedAt: row[0].respondedAt, terms };
  } catch {
    return null;
  }
}

type SpeakerContentScope = SpeakerOrganizerScope | { readonly workspaceId: string; readonly eventId: string; readonly personId: string; readonly actorId: string; readonly actorKind: "speaker" };

function contentScope(scope: SpeakerContentScope): ContentOperationsScope {
  if ("kind" in scope && scope.kind === "organizer") return { workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: scope.actorId, actorKind: "organizer" };
  if (!("personId" in scope)) throw new SpeakerOperationsAuthorizationError("Speaker content scope is missing its canonical Person.");
  return { workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: scope.actorId, actorKind: "speaker", personId: scope.personId };
}

function contentTaskTarget(task: TaskStateRecord): { readonly personId: string; readonly taskId: string; readonly kind: ContentKind } | null {
  return task.contentKind ? { personId: task.personId, taskId: task.id, kind: task.contentKind } : null;
}

function isCanonicalProfileTask(task: { readonly kind: SpeakerTaskKind; readonly contentKind: ContentKind | null }): boolean {
  return task.kind === "PROFILE" && task.contentKind === "PROFILE";
}

const SPEAKER_OPERATION_EVENT_SCHEMA = "sympose-speaker-operation/v1" as const;
type SpeakerOperationEventType = "speaker.task.created" | "speaker.task.updated" | "speaker.csv.imported" | "speaker.workflow.status.updated";
interface SpeakerOperationEventRow {
  readonly id: string; readonly workspace_id: string; readonly event_type: string;
  readonly aggregate_type: string; readonly aggregate_id: string;
  readonly payload_json: string; readonly payload_fingerprint: string; readonly created_at: string;
}

function validateOrRepairSpeakerOperationEvent(
  db: Db,
  row: SpeakerOperationEventRow,
  expected?: { readonly eventType: SpeakerOperationEventType; readonly workspaceId: string; readonly aggregateType: "speaker_task" | "event" | "event_speaker"; readonly aggregateId: string; readonly payloadJson: string; readonly payloadFingerprint: string; readonly createdAt: string },
): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(row.payload_json); } catch { throw new SpeakerOperationsConflictError("Durable speaker operation evidence is not valid JSON."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || canonicalJson(parsed) !== row.payload_json || fingerprintOf(parsed) !== row.payload_fingerprint) {
    throw new SpeakerOperationsConflictError("Durable speaker operation fingerprint is invalid.");
  }
  const payload = parsed as Record<string, unknown>;
  const eventType = row.event_type as SpeakerOperationEventType;
  const validTypeBinding =
    (eventType === "speaker.csv.imported" && row.aggregate_type === "event" && payload.operation === "csv-import") ||
    (eventType === "speaker.task.created" && row.aggregate_type === "speaker_task" && payload.operation === "create-task") ||
    (eventType === "speaker.task.updated" && row.aggregate_type === "speaker_task" && (payload.operation === "update-task" || payload.operation === "complete-task")) ||
    (eventType === "speaker.workflow.status.updated" && row.aggregate_type === "event_speaker" && payload.operation === "update-workflow-status");
  if (
    !["speaker.task.created", "speaker.task.updated", "speaker.csv.imported", "speaker.workflow.status.updated"].includes(eventType) ||
    payload.schema !== SPEAKER_OPERATION_EVENT_SCHEMA || payload.workspaceId !== row.workspace_id ||
    !validTypeBinding ||
    row.id !== deterministicUuid(`speaker-operation-event:${eventType}:${row.workspace_id}:${row.payload_fingerprint}`) ||
    (row.aggregate_type === "event" ? payload.eventId !== row.aggregate_id :
      row.aggregate_type === "event_speaker" ? payload.personId !== row.aggregate_id : payload.taskId !== row.aggregate_id)
  ) throw new SpeakerOperationsConflictError("Durable speaker operation binding is invalid.");
  if (expected && (
    row.event_type !== expected.eventType || row.workspace_id !== expected.workspaceId ||
    row.aggregate_type !== expected.aggregateType || row.aggregate_id !== expected.aggregateId ||
    row.payload_json !== expected.payloadJson || row.payload_fingerprint !== expected.payloadFingerprint ||
    row.created_at !== expected.createdAt
  )) throw new SpeakerOperationsConflictError("Durable speaker operation replay is divergent.");
  const outboxId = deterministicUuid(`speaker-operation-outbox:${row.workspace_id}:${row.id}`);
  const outboxPayload = canonicalJson({ schema: "speaker-operation-outbox/v1", domainEventId: row.id, eventType, payload });
  const companions = db.prepare(
    `SELECT id, workspace_id, domain_event_id, destination_key, payload_json, created_at
       FROM outbox_messages WHERE id = ? OR domain_event_id = ?`,
  ).all(outboxId, row.id) as unknown as Array<Record<string, unknown>>;
  if (companions.length > 1) throw new SpeakerOperationsConflictError("Durable speaker outbox companion is ambiguous.");
  const companion = companions[0];
  if (companion) {
    if (companion.id !== outboxId || companion.workspace_id !== row.workspace_id || companion.domain_event_id !== row.id || companion.destination_key !== `speaker-operation:${eventType}` || companion.payload_json !== outboxPayload || companion.created_at !== row.created_at) {
      throw new SpeakerOperationsConflictError("Durable speaker outbox companion is divergent.");
    }
  } else {
    db.prepare(
      `INSERT INTO outbox_messages
         (id, workspace_id, domain_event_id, destination_key, payload_json, status, attempt_count, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
    ).run(outboxId, row.workspace_id, row.id, `speaker-operation:${eventType}`, outboxPayload, row.created_at, row.created_at);
  }
  return payload;
}

function appendSpeakerOperationEvent(
  db: Db,
  eventType: SpeakerOperationEventType,
  workspaceId: string,
  aggregateType: "speaker_task" | "event" | "event_speaker",
  aggregateId: string,
  payload: Record<string, unknown>,
  createdAt: string,
): string {
  const payloadJson = canonicalJson(payload);
  const payloadFingerprint = fingerprintOf(payload);
  return withTransactionOrSavepoint(db, "speaker_durable_operation", () => {
    const existing = db.prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at FROM domain_events
       WHERE workspace_id = ? AND payload_fingerprint = ? LIMIT 1`,
    ).get(workspaceId, payloadFingerprint) as SpeakerOperationEventRow | undefined;
    if (existing) {
      validateOrRepairSpeakerOperationEvent(db, existing, { eventType, workspaceId, aggregateType, aggregateId, payloadJson, payloadFingerprint, createdAt });
      return existing.id;
    }
    const eventId = deterministicUuid(`speaker-operation-event:${eventType}:${workspaceId}:${payloadFingerprint}`);
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(eventId, workspaceId, eventType, aggregateType, aggregateId, payloadJson, payloadFingerprint, createdAt);
    validateOrRepairSpeakerOperationEvent(db, { id: eventId, workspace_id: workspaceId, event_type: eventType, aggregate_type: aggregateType, aggregate_id: aggregateId, payload_json: payloadJson, payload_fingerprint: payloadFingerprint, created_at: createdAt });
    return eventId;
  });
}

function storedSpeakerTask(value: unknown, workspaceId: string, eventId: string): TaskStateRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SpeakerOperationsConflictError("Durable speaker task evidence is malformed.");
  const raw = value as Record<string, unknown>;
  const contentKind = raw.contentKind === null ? null : raw.contentKind;
  const transitionsValue = raw.transitions;
  if (
    typeof raw.id !== "string" || typeof raw.personId !== "string" || typeof raw.assignmentId !== "string" ||
    typeof raw.kind !== "string" || !SPEAKER_TASK_KINDS.includes(raw.kind as SpeakerTaskKind) ||
    (contentKind !== null && (typeof contentKind !== "string" || !CONTENT_KINDS.includes(contentKind as ContentKind))) ||
    !isValidSpeakerTaskContentPair(raw.kind, contentKind) ||
    typeof raw.title !== "string" || typeof raw.description !== "string" || typeof raw.required !== "boolean" ||
    (raw.gate !== null && raw.gate !== "CONFIRMATION" && raw.gate !== "PUBLICATION" && raw.gate !== "OPERATOR_RELEASE") ||
    typeof raw.dueAt !== "string" || !Number.isFinite(Date.parse(raw.dueAt)) ||
    (raw.owner !== "SPEAKER" && raw.owner !== "ORGANIZER") ||
    typeof raw.state !== "string" || !SPEAKER_TASK_STATES.includes(raw.state as SpeakerTaskState) ||
    !Array.isArray(transitionsValue)
  ) throw new SpeakerOperationsConflictError("Durable speaker task evidence is invalid.");
  const transitions = transitionsValue.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new SpeakerOperationsConflictError("Durable speaker task transition is invalid.");
    const transition = entry as Record<string, unknown>;
    if (
      typeof transition.id !== "string" || typeof transition.from !== "string" || !SPEAKER_TASK_STATES.includes(transition.from as SpeakerTaskState) ||
      typeof transition.to !== "string" || !SPEAKER_TASK_STATES.includes(transition.to as SpeakerTaskState) ||
      typeof transition.occurredAt !== "string" || !Number.isFinite(Date.parse(transition.occurredAt)) ||
      typeof transition.actorId !== "string" || (transition.evidenceVersionId !== null && typeof transition.evidenceVersionId !== "string")
    ) throw new SpeakerOperationsConflictError("Durable speaker task transition is invalid.");
    return transition as unknown as SpeakerTaskTransition;
  });
  return deepFreeze({
    id: raw.id,
    personId: raw.personId,
    assignmentId: raw.assignmentId,
    kind: raw.kind as SpeakerTaskKind,
    contentKind: contentKind as ContentKind | null,
    title: raw.title,
    description: raw.description,
    required: raw.required,
    gate: raw.gate as SpeakerTaskProjection["gate"],
    dueAt: new Date(Date.parse(raw.dueAt)).toISOString(),
    owner: raw.owner,
    state: raw.state as SpeakerTaskState,
    transitions,
  });
}

function priorDurableSpeakerTaskOperation(
  db: Db,
  workspaceId: string,
  eventId: string,
  actorId: string,
  idempotencyKey: string | null,
  requestFingerprint: string,
  operation: "create-task" | "update-task" | "complete-task",
): TaskStateRecord | null {
  if (!idempotencyKey) return null;
  const rows = db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at
       FROM domain_events
      WHERE workspace_id = ?
        AND event_type IN ('speaker.task.created', 'speaker.task.updated')
        AND json_extract(payload_json, '$.eventId') = ?
        AND json_extract(payload_json, '$.actorId') = ?
        AND json_extract(payload_json, '$.idempotencyKey') = ?
      ORDER BY created_at, id`,
  ).all(workspaceId, eventId, actorId, idempotencyKey) as unknown as SpeakerOperationEventRow[];
  if (rows.length > 1) throw new SpeakerOperationsConflictError("Multiple durable speaker operations use the same idempotency key.");
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const value = withTransactionOrSavepoint(db, "speaker_operation_replay", () => validateOrRepairSpeakerOperationEvent(db, row));
  if (value.schema !== SPEAKER_OPERATION_EVENT_SCHEMA || value.workspaceId !== workspaceId || value.eventId !== eventId || value.operation !== operation || value.requestFingerprint !== requestFingerprint) {
    throw new SpeakerOperationsConflictError("The speaker operation idempotency key was reused with different content.");
  }
  if (row.aggregate_type !== "speaker_task") throw new SpeakerOperationsConflictError("Durable speaker task aggregate binding is invalid.");
  const task = storedSpeakerTask(value.task, workspaceId, eventId);
  if (task.id !== row.aggregate_id || value.taskId !== task.id || value.personId !== task.personId) throw new SpeakerOperationsConflictError("Durable speaker task identity is invalid.");
  return task;
}

function durableCanonicalProfileTask(
  db: Db,
  workspaceId: string,
  eventId: string,
  personId: string,
): TaskStateRecord | null {
  const rows = db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at
       FROM domain_events
      WHERE workspace_id = ?
        AND event_type = 'speaker.task.created'
        AND aggregate_type = 'speaker_task'
        AND CASE WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.eventId') END = ?
        AND CASE WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.personId') END = ?
      ORDER BY created_at, rowid`,
  ).all(workspaceId, eventId, personId) as unknown as SpeakerOperationEventRow[];
  let profileTask: TaskStateRecord | null = null;
  for (const row of rows) {
    const value = withTransactionOrSavepoint(db, "speaker_profile_task_read", () => validateOrRepairSpeakerOperationEvent(db, row));
    if (
      value.schema !== SPEAKER_OPERATION_EVENT_SCHEMA ||
      value.operation !== "create-task" ||
      value.workspaceId !== workspaceId ||
      value.eventId !== eventId ||
      value.personId !== personId ||
      row.aggregate_type !== "speaker_task"
    ) throw new SpeakerOperationsConflictError("Durable speaker profile task binding is invalid.");
    const task = storedSpeakerTask(value.task, workspaceId, eventId);
    if (task.id !== row.aggregate_id || value.taskId !== task.id || task.personId !== personId) {
      throw new SpeakerOperationsConflictError("Durable speaker profile task identity is invalid.");
    }
    if (!isCanonicalProfileTask(task)) continue;
    if (profileTask) throw new SpeakerOperationsConflictError("Multiple active profile tasks are configured for this speaker.");
    profileTask = task;
  }
  return profileTask;
}

function storedWorkflowStatusEvent(
  row: SpeakerOperationEventRow,
  value: Record<string, unknown>,
  workspaceId: string,
  eventId: string,
): WorkflowStatusStateRecord & { readonly personId: string } {
  const payload = exactObject(value, [
    "schema", "operation", "workspaceId", "eventId", "actorId", "personId", "status",
    "previousStatus", "expectedCurrentStatus", "expectedVersion", "idempotencyKey", "requestFingerprint",
  ], "Durable speaker workflow status evidence is malformed.");
  if (
    row.event_type !== "speaker.workflow.status.updated" ||
    row.aggregate_type !== "event_speaker" ||
    payload.schema !== SPEAKER_OPERATION_EVENT_SCHEMA ||
    payload.operation !== "update-workflow-status" ||
    payload.workspaceId !== workspaceId ||
    payload.eventId !== eventId ||
    payload.personId !== row.aggregate_id ||
    typeof payload.personId !== "string" ||
    typeof payload.actorId !== "string" ||
    !SPEAKER_WORKFLOW_STATUSES.includes(payload.status as SpeakerWorkflowStatus) ||
    !SPEAKER_WORKFLOW_STATUSES.includes(payload.expectedCurrentStatus as SpeakerWorkflowStatus) ||
    payload.expectedCurrentStatus !== payload.previousStatus ||
    (payload.expectedVersion !== null && typeof payload.expectedVersion !== "string") ||
    (payload.previousStatus !== null && !SPEAKER_WORKFLOW_STATUSES.includes(payload.previousStatus as SpeakerWorkflowStatus)) ||
    payload.status === payload.expectedCurrentStatus ||
    (payload.idempotencyKey !== null && typeof payload.idempotencyKey !== "string") ||
    typeof payload.requestFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.requestFingerprint)
  ) throw new SpeakerOperationsConflictError("Durable speaker workflow status scope is invalid.");
  return {
    personId: payload.personId,
    eventId: row.id,
    status: payload.status as SpeakerWorkflowStatus,
    previousStatus: payload.previousStatus as SpeakerWorkflowStatus | null,
    expectedCurrentStatus: payload.expectedCurrentStatus as SpeakerWorkflowStatus,
    expectedVersion: payload.expectedVersion as string | null,
    occurredAt: canonicalStoredInstant(row.created_at, "Durable speaker workflow status time is invalid."),
    actorId: payload.actorId,
    idempotencyKey: payload.idempotencyKey as string | null,
    requestFingerprint: payload.requestFingerprint,
  };
}

function priorDurableWorkflowStatus(
  db: Db,
  workspaceId: string,
  eventId: string,
  personId: string,
  actorId: string,
  idempotencyKey: string | null,
  requestFingerprint: string,
): (WorkflowStatusStateRecord & { readonly personId: string }) | null {
  if (!idempotencyKey) return null;
  const rows = db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at
       FROM domain_events
      WHERE workspace_id = ?
        AND event_type = 'speaker.workflow.status.updated'
        AND aggregate_type = 'event_speaker'
        AND aggregate_id = ?
        AND json_extract(payload_json, '$.eventId') = ?
        AND json_extract(payload_json, '$.actorId') = ?
        AND json_extract(payload_json, '$.idempotencyKey') = ?
      ORDER BY created_at, rowid`,
  ).all(workspaceId, personId, eventId, actorId, idempotencyKey) as unknown as SpeakerOperationEventRow[];
  if (rows.length > 1) throw new SpeakerOperationsConflictError("Multiple durable speaker workflow status operations use the same idempotency key.");
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const value = withTransactionOrSavepoint(db, "speaker_workflow_status_replay", () => validateOrRepairSpeakerOperationEvent(db, row));
  const status = storedWorkflowStatusEvent(row, value, workspaceId, eventId);
  if (status.personId !== personId || status.actorId !== actorId || status.requestFingerprint !== requestFingerprint) {
    throw new SpeakerOperationsConflictError("The speaker workflow status idempotency key was reused with different content.");
  }
  return status;
}

function currentDurableWorkflowStatus(
  db: Db,
  workspaceId: string,
  eventId: string,
  personId: string,
): (WorkflowStatusStateRecord & { readonly personId: string }) | null {
  const rows = db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at
       FROM domain_events
      WHERE workspace_id = ?
        AND event_type = 'speaker.workflow.status.updated'
        AND aggregate_type = 'event_speaker'
        AND aggregate_id = ?
        AND CASE WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.eventId') END = ?
      ORDER BY created_at, rowid`,
  ).all(workspaceId, personId, eventId) as unknown as SpeakerOperationEventRow[];
  let current: (WorkflowStatusStateRecord & { readonly personId: string }) | null = null;
  for (const row of rows) {
    const value = withTransactionOrSavepoint(db, "speaker_workflow_status_current", () => validateOrRepairSpeakerOperationEvent(db, row));
    const status = storedWorkflowStatusEvent(row, value, workspaceId, eventId);
    const expectedStatus = current?.status ?? "NEW";
    const expectedVersion = current?.eventId ?? null;
    if (
      status.previousStatus !== expectedStatus ||
      status.expectedCurrentStatus !== expectedStatus ||
      status.expectedVersion !== expectedVersion ||
      status.status === expectedStatus
    ) throw new SpeakerOperationsConflictError("Durable speaker workflow status history is not append-only.");
    current = status;
  }
  return current;
}

const SHARED_ACTION_TASK_EVENT_TYPE = "speaker.action-task.batch.created" as const;
const SHARED_ACTION_TASK_AGGREGATE_TYPE = "speaker_action_task" as const;
const SHARED_ACTION_TASK_REMINDER_EVENT_TYPE = "speaker.action-task.reminder.queued" as const;
const SHARED_ACTION_TASK_REMINDER_AGGREGATE_TYPE = "speaker_action_task_assignment" as const;
const SHARED_ACTION_TASK_REMINDER_MESSAGE_SCHEMA = "speaker-action-task-reminder-message/v1" as const;
const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const ACTION_RECIPIENT_EMAIL = /^[^\s@<>]+@[^\s@<>]+$/u;
const DELIVERY_STATUSES = ["PENDING", "CLAIMED", "DELIVERED", "FAILED"] as const;
const ACTION_REMINDER_WORKER_IDENTITY = "speaker-action-task-reminder-worker/v1" as const;
const ACTION_REMINDER_RECEIPT_ACTION = "speaker.action-task.reminder.provider-receipt" as const;
const ACTION_REMINDER_STOPPED_ACTION = "speaker.action-task.reminder.delivery-stopped" as const;
const ACTION_REMINDER_CLAIM_LEASE_MS = 60_000;
const ACTION_REMINDER_RETRY_BASE_MS = 60_000;
const ACTION_REMINDER_ADAPTER_KIND = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;

type ActionReminderEligibility =
  | "ELIGIBLE"
  | "EVENT_INACTIVE"
  | "TASK_COMPLETED"
  | "ASSIGNMENT_REVOKED";

type ActionReminderFailureCode =
  | "PROVIDER_FAILURE"
  | "ATTEMPT_LIMIT_REACHED"
  | Exclude<ActionReminderEligibility, "ELIGIBLE">;

interface NormalizedSharedActionTaskInput {
  readonly assigneePersonIds: readonly string[];
  readonly title: string;
  readonly instructions: string;
  readonly dueDate: string;
  readonly dueAt: string;
  readonly idempotencyKey: string;
}

interface StoredSharedActionAssignment {
  readonly taskId: string;
  readonly personId: string;
  readonly assignmentId: string;
}

interface StoredSharedActionDefinition {
  readonly schema: typeof SHARED_ACTION_TASK_SCHEMA;
  readonly operation: "create-shared-action-task";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly actorId: string;
  readonly definitionId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly kind: "ACTION";
  readonly title: string;
  readonly instructions: string;
  readonly dueDate: string;
  readonly dueAt: string;
  readonly assignments: readonly StoredSharedActionAssignment[];
  readonly createdAt: string;
}

interface SharedActionDefinitionEventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload_json: string;
  readonly payload_fingerprint: string;
  readonly created_at: string;
}

interface StoredActionReminder {
  readonly schema: typeof SHARED_ACTION_TASK_REMINDER_SCHEMA;
  readonly operation: "queue-due-action-task-reminder";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly definitionId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly recipientPersonId: string;
  readonly occurrenceDate: string;
  readonly windowEndExclusive: string;
  readonly eventName: string;
  readonly taskTitle: string;
  readonly taskInstructions: string;
  readonly dueDate: string;
  readonly dueAt: string;
  readonly subjectPreview: string;
  readonly bodyPreview: string;
  readonly messageId: string;
  readonly destinationKey: string;
  readonly channel: "local";
  readonly providerMutation: false;
  readonly createdAt: string;
}

interface ActionReminderJoinedRow extends SharedActionDefinitionEventRow {
  readonly message_id: string;
  readonly domain_event_id: string;
  readonly destination_key: string;
  readonly outbox_payload_json: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly claim_token: string | null;
  readonly lease_expires_at: string | null;
  readonly delivered_at: string | null;
  readonly last_error: string | null;
  readonly outbox_created_at: string;
  readonly recipient_id: string;
  readonly recipient_name: string;
  readonly recipient_email: string;
}

interface StoredActionReminderProviderReceipt extends ActionTaskReminderProviderReceipt {
  readonly adapterKind: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly recipientPersonId: string;
  readonly domainEventId: string;
}

function sharedActionText(value: unknown, field: string, max: number, allowLineFeeds = false): string {
  if (typeof value !== "string") fail(`${field} is invalid.`);
  const normalized = allowLineFeeds ? value.replace(/\r\n/gu, "\n").trim() : value.trim();
  const controls = allowLineFeeds
    ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u
    : /[\u0000-\u001f\u007f-\u009f]/u;
  if (normalized.length < 1 || normalized.length > max || controls.test(normalized)) fail(`${field} is invalid.`);
  return normalized;
}

function normalizedDateOnly(value: unknown, field: string): { readonly dueDate: string; readonly dueAt: string } {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) fail(`${field} is invalid.`);
  const day = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value) fail(`${field} is invalid.`);
  return { dueDate: value, dueAt: `${value}T23:59:59.999Z` };
}

function normalizeSharedActionTaskInput(input: CreateSharedActionTaskInput): NormalizedSharedActionTaskInput {
  if (!Array.isArray(input.assigneePersonIds) || input.assigneePersonIds.length < SHARED_ACTION_TASK_MIN_ASSIGNEES || input.assigneePersonIds.length > SHARED_ACTION_TASK_MAX_ASSIGNEES) {
    fail(`ACTION tasks require ${SHARED_ACTION_TASK_MIN_ASSIGNEES} to ${SHARED_ACTION_TASK_MAX_ASSIGNEES} assignees.`);
  }
  const assigneePersonIds: string[] = [];
  const seen = new Set<string>();
  for (const rawId of input.assigneePersonIds) {
    const personId = boundedId(typeof rawId === "string" ? rawId.trim() : rawId, "assigneePersonId");
    if (seen.has(personId)) fail("ACTION task assignees must be unique.");
    seen.add(personId);
    assigneePersonIds.push(personId);
  }
  assigneePersonIds.sort();
  const { dueDate, dueAt } = normalizedDateOnly(input.dueDate, "task due date");
  return deepFreeze({
    assigneePersonIds,
    title: sharedActionText(input.title, "task title", 240),
    instructions: sharedActionText(input.instructions, "task instructions", SHARED_ACTION_TASK_MAX_INSTRUCTIONS, true),
    dueDate,
    dueAt,
    idempotencyKey: boundedId(typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : input.idempotencyKey, "idempotencyKey"),
  });
}

function storedSharedActionValue<T>(operation: () => T, message: string): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SpeakerOperationsConflictError) throw error;
    throw new SpeakerOperationsConflictError(message);
  }
}

function canonicalStoredInstant(value: unknown, message: string): string {
  if (typeof value !== "string") throw new SpeakerOperationsConflictError(message);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new SpeakerOperationsConflictError(message);
  const canonical = new Date(timestamp).toISOString();
  if (canonical !== value) throw new SpeakerOperationsConflictError(message);
  return canonical;
}

function optionalCanonicalStoredInstant(value: unknown, message: string): string | null {
  return value === null ? null : canonicalStoredInstant(value, message);
}

function storedActionRecipientName(value: unknown): string {
  return storedSharedActionValue(
    () => sharedActionText(value, "recipient name", 240),
    "The current ACTION reminder recipient name is invalid.",
  );
}

function storedActionRecipientEmail(value: unknown): string {
  if (typeof value !== "string") throw new SpeakerOperationsConflictError("The current ACTION reminder recipient email is invalid.");
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (
    value !== normalized || normalized.length < 3 || normalized.length > 320 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(normalized) || !ACTION_RECIPIENT_EMAIL.test(normalized)
  ) throw new SpeakerOperationsConflictError("The current ACTION reminder recipient email is invalid.");
  return normalized;
}

function assertNewSharedActionDueDate(input: NormalizedSharedActionTaskInput, now: string): void {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new SpeakerOperationsConflictError("The task clock is unavailable.");
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`);
  const dueDay = Date.parse(`${input.dueDate}T00:00:00.000Z`);
  if (dueDay < today || dueDay > today + SHARED_ACTION_TASK_MAX_DUE_DAYS * UTC_DAY_MS) {
    fail(`task due date must be today or within ${SHARED_ACTION_TASK_MAX_DUE_DAYS} UTC days.`);
  }
}

function sharedActionRequestFingerprint(scope: SpeakerOrganizerScope, input: NormalizedSharedActionTaskInput): string {
  return fingerprintOf({
    operation: "create-shared-action-task",
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    actorId: scope.actorId,
    assigneePersonIds: input.assigneePersonIds,
    title: input.title,
    instructions: input.instructions,
    dueDate: input.dueDate,
  });
}

function sharedActionDefinitionId(scope: SpeakerOrganizerScope, idempotencyKey: string): string {
  return deterministicUuid(`speaker-shared-action-task:${canonicalJson({ workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: scope.actorId, idempotencyKey })}`);
}

function requirePersistedActionTaskOrganizer(db: Db, scope: SpeakerOrganizerScope): SpeakerEventContext {
  if (scope.kind !== "organizer") throw new SpeakerOperationsAuthorizationError();
  boundedId(scope.workspaceId, "workspaceId");
  boundedId(scope.eventId, "eventId");
  boundedId(scope.actorId, "actorId");
  const actor = db.prepare(
    `SELECT role FROM accounts WHERE workspace_id = ? AND id = ?`,
  ).get(scope.workspaceId, scope.actorId) as { readonly role: unknown } | undefined;
  if (!actor || typeof actor.role !== "string" || !roleHasCapability(actor.role, "phase0.pipeline.manage")) {
    throw new SpeakerOperationsAuthorizationError("The persisted organizer capability is unavailable.");
  }
  const event = db.prepare(
    `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt
       FROM events WHERE workspace_id = ? AND id = ?`,
  ).get(scope.workspaceId, scope.eventId) as Record<string, unknown> | undefined;
  if (
    !event || event.id !== scope.eventId || typeof event.name !== "string" || event.name.length < 1 || event.name.length > 240 ||
    typeof event.timezone !== "string" || event.timezone.length < 1 || event.timezone.length > 120 ||
    typeof event.startsAt !== "string" || !Number.isFinite(Date.parse(event.startsAt)) ||
    typeof event.endsAt !== "string" || !Number.isFinite(Date.parse(event.endsAt)) ||
    Date.parse(event.endsAt) <= Date.parse(event.startsAt)
  ) throw new SpeakerOperationsAuthorizationError("The persisted speaker event is unavailable.");
  return { id: scope.eventId, name: event.name, timezone: event.timezone, startsAt: event.startsAt, endsAt: event.endsAt };
}

function parseSharedActionDefinition(row: SharedActionDefinitionEventRow): StoredSharedActionDefinition {
  let parsed: unknown;
  try { parsed = JSON.parse(row.payload_json); } catch { throw new SpeakerOperationsConflictError("Shared ACTION task evidence is not valid JSON."); }
  const raw = exactObject(parsed, [
    "schema", "operation", "workspaceId", "eventId", "actorId", "definitionId", "idempotencyKey",
    "requestFingerprint", "kind", "title", "instructions", "dueDate", "dueAt", "assignments", "createdAt",
  ], "Shared ACTION task evidence is malformed.");
  if (
    row.event_type !== SHARED_ACTION_TASK_EVENT_TYPE || row.aggregate_type !== SHARED_ACTION_TASK_AGGREGATE_TYPE ||
    raw.schema !== SHARED_ACTION_TASK_SCHEMA || raw.operation !== "create-shared-action-task" || raw.kind !== "ACTION" ||
    typeof raw.workspaceId !== "string" || raw.workspaceId !== row.workspace_id ||
    typeof raw.eventId !== "string" || typeof raw.actorId !== "string" || typeof raw.definitionId !== "string" ||
    raw.definitionId !== row.aggregate_id || typeof raw.idempotencyKey !== "string" ||
    typeof raw.requestFingerprint !== "string" || typeof raw.title !== "string" || typeof raw.instructions !== "string" ||
    typeof raw.dueDate !== "string" || typeof raw.dueAt !== "string" || !Array.isArray(raw.assignments) ||
    typeof raw.createdAt !== "string" || raw.createdAt !== row.created_at ||
    canonicalJson(parsed) !== row.payload_json || fingerprintOf(parsed) !== row.payload_fingerprint ||
    row.id !== deterministicUuid(`speaker-shared-action-task-event:${raw.definitionId}`)
  ) throw new SpeakerOperationsConflictError("Shared ACTION task evidence binding is invalid.");
  const workspaceId = raw.workspaceId as string;
  const eventId = raw.eventId as string;
  const actorId = raw.actorId as string;
  const definitionId = raw.definitionId as string;
  const idempotencyKey = raw.idempotencyKey as string;
  const requestFingerprint = raw.requestFingerprint as string;
  const title = raw.title as string;
  const instructions = raw.instructions as string;
  const dueDate = raw.dueDate as string;
  const dueAt = raw.dueAt as string;
  const assignmentPayloads = raw.assignments as unknown[];
  const createdAt = raw.createdAt as string;
  canonicalStoredInstant(createdAt, "Shared ACTION task creation time is invalid.");
  storedSharedActionValue(() => {
    boundedId(workspaceId, "workspaceId");
    boundedId(eventId, "eventId");
    boundedId(actorId, "actorId");
    boundedId(definitionId, "definitionId");
  }, "Shared ACTION task scoped identifiers are invalid.");
  const normalized = storedSharedActionValue(() => normalizeSharedActionTaskInput({
    assigneePersonIds: assignmentPayloads.map((entry) => (entry as Record<string, unknown>)?.personId as string),
    title,
    instructions,
    dueDate,
    idempotencyKey,
  }), "Shared ACTION task definition evidence is invalid.");
  if (
    normalized.title !== title || normalized.instructions !== instructions ||
    normalized.dueDate !== dueDate || normalized.idempotencyKey !== idempotencyKey
  ) throw new SpeakerOperationsConflictError("Shared ACTION task definition evidence is not canonically stored.");
  if (normalized.dueAt !== dueAt) throw new SpeakerOperationsConflictError("Shared ACTION task due-date evidence is invalid.");
  const expectedFingerprint = fingerprintOf({
    operation: "create-shared-action-task",
    workspaceId,
    eventId,
    actorId,
    assigneePersonIds: normalized.assigneePersonIds,
    title: normalized.title,
    instructions: normalized.instructions,
    dueDate: normalized.dueDate,
  });
  if (
    requestFingerprint !== expectedFingerprint ||
    definitionId !== sharedActionDefinitionId({ kind: "organizer", workspaceId, eventId, actorId }, normalized.idempotencyKey)
  ) throw new SpeakerOperationsConflictError("Shared ACTION task request evidence is divergent.");
  const assignments = assignmentPayloads.map((entry, index) => {
    const assignment = exactObject(entry, ["taskId", "personId", "assignmentId"], "Shared ACTION task assignment evidence is malformed.");
    if (
      typeof assignment.taskId !== "string" || typeof assignment.personId !== "string" || typeof assignment.assignmentId !== "string" ||
      assignment.personId !== normalized.assigneePersonIds[index] ||
      assignment.taskId !== deterministicUuid(`speaker-shared-action-task-assignment:${definitionId}:${assignment.personId}`)
    ) throw new SpeakerOperationsConflictError("Shared ACTION task assignment binding is invalid.");
    storedSharedActionValue(() => {
      boundedId(assignment.taskId, "taskId");
      boundedId(assignment.assignmentId, "assignmentId");
    }, "Shared ACTION task assignment identifiers are invalid.");
    return { taskId: assignment.taskId, personId: assignment.personId, assignmentId: assignment.assignmentId };
  });
  return deepFreeze({
    schema: SHARED_ACTION_TASK_SCHEMA,
    operation: "create-shared-action-task",
    workspaceId,
    eventId,
    actorId,
    definitionId,
    idempotencyKey: normalized.idempotencyKey,
    requestFingerprint: expectedFingerprint,
    kind: "ACTION",
    title: normalized.title,
    instructions: normalized.instructions,
    dueDate: normalized.dueDate,
    dueAt: normalized.dueAt,
    assignments,
    createdAt,
  });
}

function sharedActionDefinitionRows(db: Db, workspaceId: string, eventId: string, maximumRows?: number): SharedActionDefinitionEventRow[] {
  const boundedLimit = maximumRows === undefined ? null : Math.max(1, Math.trunc(maximumRows));
  return db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at
       FROM domain_events
      WHERE workspace_id = ? AND event_type = ? AND aggregate_type = ?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.eventId') END = ?
      ORDER BY created_at, id${boundedLimit === null ? "" : " LIMIT ?"}`,
  ).all(...(boundedLimit === null
    ? [workspaceId, SHARED_ACTION_TASK_EVENT_TYPE, SHARED_ACTION_TASK_AGGREGATE_TYPE, eventId]
    : [workspaceId, SHARED_ACTION_TASK_EVENT_TYPE, SHARED_ACTION_TASK_AGGREGATE_TYPE, eventId, boundedLimit])) as unknown as SharedActionDefinitionEventRow[];
}

function sharedActionTaskState(db: Db, definition: StoredSharedActionDefinition, assignment: StoredSharedActionAssignment): TaskStateRecord {
  const rows = db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at
       FROM domain_events
      WHERE workspace_id = ? AND event_type IN ('speaker.task.created', 'speaker.task.updated')
        AND aggregate_type = 'speaker_task' AND aggregate_id = ?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.eventId') END = ?
      ORDER BY rowid`,
  ).all(definition.workspaceId, assignment.taskId, definition.eventId) as unknown as SpeakerOperationEventRow[];
  if (rows.length < 1) throw new SpeakerOperationsConflictError("A shared ACTION task assignment is missing its durable task evidence.");
  let task: TaskStateRecord | null = null;
  for (const row of rows) {
    const value = withTransactionOrSavepoint(db, "shared_action_task_read", () => validateOrRepairSpeakerOperationEvent(db, row));
    const operation = value.operation;
    exactObject(value, operation === "create-task"
      ? [
          "schema", "operation", "workspaceId", "eventId", "actorId", "personId", "taskId",
          "idempotencyKey", "requestFingerprint", "sharedActionDefinitionId",
          "sharedActionRequestFingerprint", "task",
        ]
      : [
          "schema", "operation", "workspaceId", "eventId", "actorId", "personId", "taskId",
          "idempotencyKey", "requestFingerprint", "note", "task",
        ], "Shared ACTION task operation evidence is malformed.");
    const parsedTask = storedSpeakerTask(value.task, definition.workspaceId, definition.eventId);
    const actorId = value.actorId;
    if (
      typeof actorId !== "string" || value.workspaceId !== definition.workspaceId || value.eventId !== definition.eventId ||
      value.personId !== assignment.personId || value.taskId !== assignment.taskId ||
      typeof value.requestFingerprint !== "string" ||
      (value.idempotencyKey !== null && typeof value.idempotencyKey !== "string") ||
      parsedTask.id !== assignment.taskId || parsedTask.personId !== assignment.personId ||
      parsedTask.assignmentId !== assignment.assignmentId
    ) {
      throw new SpeakerOperationsConflictError("A shared ACTION task assignment has divergent durable identity.");
    }
    storedSharedActionValue(() => {
      boundedId(actorId, "actorId");
      if (typeof value.idempotencyKey === "string") text(value.idempotencyKey, "idempotencyKey", 240);
    }, "Shared ACTION task operation identifiers are invalid.");
    const occurredAt = canonicalStoredInstant(row.created_at, "Shared ACTION task operation time is invalid.");
    if (
      parsedTask.kind !== "ACTION" || parsedTask.contentKind !== null || parsedTask.title !== definition.title ||
      parsedTask.description !== definition.instructions || parsedTask.required !== true || parsedTask.gate !== null ||
      parsedTask.dueAt !== definition.dueAt || parsedTask.owner !== "SPEAKER"
    ) throw new SpeakerOperationsConflictError("A shared ACTION task definition was mutated.");
    if (row.event_type === "speaker.task.created") {
      if (
        task !== null || operation !== "create-task" || row.created_at !== definition.createdAt ||
        actorId !== definition.actorId || value.sharedActionDefinitionId !== definition.definitionId ||
        value.sharedActionRequestFingerprint !== definition.requestFingerprint ||
        value.idempotencyKey !== deterministicUuid(`shared-action-create:${definition.definitionId}:${assignment.personId}`) ||
        value.requestFingerprint !== fingerprintOf({
          requestFingerprint: definition.requestFingerprint,
          taskId: assignment.taskId,
          assignmentId: assignment.assignmentId,
        }) || parsedTask.state !== "NOT_STARTED" || parsedTask.transitions.length !== 0
      ) throw new SpeakerOperationsConflictError("A shared ACTION task is missing its canonical creation binding.");
    } else {
      if (!task || (operation !== "update-task" && operation !== "complete-task")) {
        throw new SpeakerOperationsConflictError("A shared ACTION task status history is not append-only.");
      }
      if (value.note !== null && typeof value.note !== "string") {
        throw new SpeakerOperationsConflictError("A shared ACTION task note evidence is invalid.");
      }
      if (typeof value.note === "string") storedSharedActionValue(
        () => text(value.note, "task note", 1_000),
        "A shared ACTION task note evidence is invalid.",
      );
      const previousTransitions = task.transitions;
      const transitions = parsedTask.transitions;
      if (
        transitions.length < previousTransitions.length || transitions.length > previousTransitions.length + 1 ||
        previousTransitions.some((transition, index) => canonicalJson(transition) !== canonicalJson(transitions[index]))
      ) throw new SpeakerOperationsConflictError("A shared ACTION task status history is not append-only.");
      const appended = transitions.length === previousTransitions.length + 1 ? transitions.at(-1)! : null;
      if (appended) {
        const expectedTransitionId = deterministicUuid(
          operation === "complete-task"
            ? `speaker-task-transition:${parsedTask.id}:${transitions.length}:completed`
            : `speaker-task-transition:${parsedTask.id}:${transitions.length}:${parsedTask.state}`,
        );
        if (
          appended.id !== expectedTransitionId || appended.from !== task.state || appended.to !== parsedTask.state ||
          appended.occurredAt !== occurredAt || appended.actorId !== actorId || appended.evidenceVersionId !== null
        ) throw new SpeakerOperationsConflictError("A shared ACTION task transition binding is invalid.");
      } else if (parsedTask.state !== task.state) {
        throw new SpeakerOperationsConflictError("A shared ACTION task state changed without transition evidence.");
      }
      if (operation === "complete-task" && (!appended || parsedTask.state !== "COMPLETED" || actorId !== assignment.personId)) {
        throw new SpeakerOperationsConflictError("A shared ACTION task completion evidence is invalid.");
      }
    }
    task = parsedTask;
  }
  if (!task) throw new SpeakerOperationsConflictError("A shared ACTION task assignment is missing its durable task evidence.");
  return task;
}

function sharedActionDefinitionForTask(db: Db, workspaceId: string, eventId: string, taskId: string): { readonly definition: StoredSharedActionDefinition; readonly assignment: StoredSharedActionAssignment } {
  const rows = db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at
       FROM domain_events
      WHERE workspace_id = ? AND event_type = ? AND aggregate_type = ?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.eventId') END = ?
        AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.assignments') assignment WHERE json_extract(assignment.value, '$.taskId') = ?)
      ORDER BY created_at, id`,
  ).all(workspaceId, SHARED_ACTION_TASK_EVENT_TYPE, SHARED_ACTION_TASK_AGGREGATE_TYPE, eventId, taskId) as unknown as SharedActionDefinitionEventRow[];
  if (rows.length !== 1) throw new SpeakerOperationsConflictError("The ACTION task shared definition is unavailable or ambiguous.");
  const definition = parseSharedActionDefinition(rows[0]!);
  const assignment = definition.assignments.find((candidate) => candidate.taskId === taskId);
  if (!assignment) throw new SpeakerOperationsConflictError("The ACTION task shared assignment is unavailable.");
  return { definition, assignment };
}

function projectSharedActionDefinition(db: Db, definition: StoredSharedActionDefinition): SharedActionTaskBatchProjection {
  const assignments: SharedActionTaskAssignmentProjection[] = definition.assignments.map((assignment) => {
    const task = sharedActionTaskState(db, definition, assignment);
    const person = db.prepare(
      `SELECT full_name AS fullName FROM people WHERE workspace_id = ? AND id = ?`,
    ).get(definition.workspaceId, assignment.personId) as { readonly fullName: unknown } | undefined;
    if (!person || typeof person.fullName !== "string") throw new SpeakerOperationsConflictError("The shared ACTION task Person is unavailable.");
    return { taskId: task.id, personId: task.personId, assignmentId: task.assignmentId, speakerName: person.fullName, state: task.state };
  });
  return deepFreeze({
    schema: SHARED_ACTION_TASK_SCHEMA,
    definitionId: definition.definitionId,
    workspaceId: definition.workspaceId,
    eventId: definition.eventId,
    title: definition.title,
    instructions: definition.instructions,
    dueDate: definition.dueDate,
    dueAt: definition.dueAt,
    createdAt: definition.createdAt,
    requestFingerprint: definition.requestFingerprint,
    assignmentCount: assignments.length,
    completedCount: assignments.filter((assignment) => assignment.state === "COMPLETED").length,
    assignments,
  });
}

function reminderOccurrence(clockValue: string): { readonly occurrenceDate: string; readonly windowEndExclusive: string } {
  const now = Date.parse(clockValue);
  if (!Number.isFinite(now)) throw new SpeakerOperationsConflictError("The reminder clock is unavailable.");
  const occurrenceDate = new Date(now).toISOString().slice(0, 10);
  const start = Date.parse(`${occurrenceDate}T00:00:00.000Z`);
  return {
    occurrenceDate,
    windowEndExclusive: new Date(start + SHARED_ACTION_TASK_REMINDER_WINDOW_DAYS * UTC_DAY_MS).toISOString(),
  };
}

function reminderMessagePayload(domainEventId: string, reminder: StoredActionReminder): { readonly payloadJson: string; readonly payloadFingerprint: string } {
  const basis = {
    schema: SHARED_ACTION_TASK_REMINDER_MESSAGE_SCHEMA,
    domainEventId,
    reminder,
    channel: "local" as const,
    providerMutation: false as const,
  };
  const payloadFingerprint = fingerprintOf(basis);
  return { payloadJson: canonicalJson({ ...basis, payloadFingerprint }), payloadFingerprint };
}

function actionReminderProviderIdempotencyKey(workspaceId: string, messageId: string): string {
  return deterministicUuid(`speaker-action-task-reminder-provider-idempotency:${workspaceId}:${messageId}`);
}

function actionReminderProviderReceiptAuditId(workspaceId: string, messageId: string): string {
  return deterministicUuid(`speaker-action-task-reminder-provider-receipt:${workspaceId}:${messageId}`);
}

function readActionReminderProviderReceipt(
  db: Db,
  expected: {
    readonly row: ActionReminderJoinedRow;
    readonly reminder: StoredActionReminder;
    readonly payloadFingerprint: string;
  },
): StoredActionReminderProviderReceipt | null {
  const receiptId = actionReminderProviderReceiptAuditId(expected.row.workspace_id, expected.row.message_id);
  const row = db.prepare(
    `SELECT id, workspace_id, actor_kind, actor_ref, action, target_type, target_id,
            details_json, created_at
       FROM audit_events WHERE id = ? AND workspace_id = ?`,
  ).get(receiptId, expected.row.workspace_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = typeof row.details_json === "string" ? JSON.parse(row.details_json) : null;
  } catch {
    throw new SpeakerOperationsConflictError("Durable ACTION reminder provider receipt is invalid.");
  }
  const receipt = exactObject(parsed, [
    "schema", "adapterKind", "workspaceId", "eventId", "taskId", "assignmentId",
    "recipientPersonId", "messageId", "domainEventId", "idempotencyKey", "payloadFingerprint",
    "providerReceiptId", "acceptedAt", "deliveryMode", "networkContacted", "providerMutation",
  ], "Durable ACTION reminder provider receipt is malformed.");
  const acceptedAt = canonicalStoredInstant(
    receipt.acceptedAt,
    "Durable ACTION reminder provider receipt time is invalid.",
  );
  if (
    row.id !== receiptId || row.workspace_id !== expected.row.workspace_id || row.actor_kind !== "system" ||
    row.actor_ref !== receipt.adapterKind || row.action !== ACTION_REMINDER_RECEIPT_ACTION ||
    row.target_type !== "outbox_message" || row.target_id !== expected.row.message_id ||
    row.created_at !== acceptedAt || typeof row.details_json !== "string" ||
    canonicalJson(parsed) !== row.details_json ||
    receipt.schema !== SHARED_ACTION_TASK_REMINDER_PROVIDER_RECEIPT_SCHEMA ||
    typeof receipt.adapterKind !== "string" || !ACTION_REMINDER_ADAPTER_KIND.test(receipt.adapterKind) ||
    receipt.workspaceId !== expected.row.workspace_id || receipt.eventId !== expected.reminder.eventId ||
    receipt.taskId !== expected.reminder.taskId || receipt.assignmentId !== expected.reminder.assignmentId ||
    receipt.recipientPersonId !== expected.reminder.recipientPersonId ||
    receipt.messageId !== expected.row.message_id || receipt.domainEventId !== expected.row.id ||
    receipt.idempotencyKey !== actionReminderProviderIdempotencyKey(expected.row.workspace_id, expected.row.message_id) ||
    receipt.payloadFingerprint !== expected.payloadFingerprint ||
    typeof receipt.providerReceiptId !== "string" || !SAFE_ID.test(receipt.providerReceiptId) ||
    receipt.deliveryMode !== "NO_NETWORK_SIMULATED" || receipt.networkContacted !== false ||
    receipt.providerMutation !== false || Date.parse(acceptedAt) < Date.parse(expected.row.created_at)
  ) throw new SpeakerOperationsConflictError("Durable ACTION reminder provider receipt binding is invalid.");
  return receipt as unknown as StoredActionReminderProviderReceipt;
}

function parseActionReminderRow(db: Db, row: ActionReminderJoinedRow): SharedActionTaskReminderDelivery {
  let parsed: unknown;
  try { parsed = JSON.parse(row.payload_json); } catch { throw new SpeakerOperationsConflictError("Durable ACTION reminder evidence is not valid JSON."); }
  const raw = exactObject(parsed, [
    "schema", "operation", "workspaceId", "eventId", "definitionId", "taskId", "assignmentId",
    "recipientPersonId", "occurrenceDate", "windowEndExclusive",
    "eventName", "taskTitle", "taskInstructions", "dueDate", "dueAt", "subjectPreview", "bodyPreview",
    "messageId", "destinationKey", "channel", "providerMutation", "createdAt",
  ], "Durable ACTION reminder evidence is malformed.");
  if (
    row.event_type !== SHARED_ACTION_TASK_REMINDER_EVENT_TYPE || row.aggregate_type !== SHARED_ACTION_TASK_REMINDER_AGGREGATE_TYPE ||
    raw.schema !== SHARED_ACTION_TASK_REMINDER_SCHEMA || raw.operation !== "queue-due-action-task-reminder" ||
    typeof raw.workspaceId !== "string" || raw.workspaceId !== row.workspace_id || typeof raw.eventId !== "string" ||
    typeof raw.definitionId !== "string" || typeof raw.taskId !== "string" || raw.taskId !== row.aggregate_id ||
    typeof raw.assignmentId !== "string" || typeof raw.recipientPersonId !== "string" ||
    typeof raw.occurrenceDate !== "string" || typeof raw.windowEndExclusive !== "string" ||
    typeof raw.eventName !== "string" || typeof raw.taskTitle !== "string" || typeof raw.taskInstructions !== "string" ||
    typeof raw.dueDate !== "string" || typeof raw.dueAt !== "string" || typeof raw.subjectPreview !== "string" || typeof raw.bodyPreview !== "string" ||
    typeof raw.messageId !== "string" || raw.messageId !== row.message_id || typeof raw.destinationKey !== "string" || raw.destinationKey !== row.destination_key ||
    raw.channel !== "local" || raw.providerMutation !== false || typeof raw.createdAt !== "string" || raw.createdAt !== row.created_at ||
    row.domain_event_id !== row.id || canonicalJson(parsed) !== row.payload_json || fingerprintOf(parsed) !== row.payload_fingerprint ||
    row.id !== deterministicUuid(`speaker-action-task-reminder-event:${raw.workspaceId}:${raw.eventId}:${raw.taskId}:${raw.occurrenceDate}`) ||
    raw.messageId !== deterministicUuid(`speaker-action-task-reminder-message:${row.id}`) ||
    raw.destinationKey !== `local:speaker-action-task-reminder:${raw.eventId}:${raw.taskId}:${raw.occurrenceDate}` ||
    !DELIVERY_STATUSES.includes(row.status as SharedActionTaskReminderDeliveryStatus) ||
    !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
    row.outbox_created_at !== raw.createdAt || row.recipient_id !== raw.recipientPersonId
  ) throw new SpeakerOperationsConflictError("Durable ACTION reminder binding is invalid.");
  storedSharedActionValue(() => {
    boundedId(raw.workspaceId, "workspaceId");
    boundedId(raw.eventId, "eventId");
    boundedId(raw.definitionId, "definitionId");
    boundedId(raw.taskId, "taskId");
    boundedId(raw.assignmentId, "assignmentId");
    boundedId(raw.recipientPersonId, "recipientPersonId");
  }, "Durable ACTION reminder scoped identifiers are invalid.");
  const createdAt = canonicalStoredInstant(raw.createdAt, "Durable ACTION reminder creation time is invalid.");
  optionalCanonicalStoredInstant(row.next_attempt_at, "Durable ACTION reminder retry time is invalid.");
  optionalCanonicalStoredInstant(row.lease_expires_at, "Durable ACTION reminder lease time is invalid.");
  optionalCanonicalStoredInstant(row.delivered_at, "Durable ACTION reminder delivery time is invalid.");
  if (
    (row.status === "CLAIMED" && (
      typeof row.claim_token !== "string" || !/^[a-f0-9]{64}$/u.test(row.claim_token) ||
      row.lease_expires_at === null || row.attempt_count < 1 || row.delivered_at !== null
    )) ||
    (row.status !== "CLAIMED" && (row.claim_token !== null || row.lease_expires_at !== null)) ||
    (row.status === "DELIVERED" && row.delivered_at === null) ||
    (row.status !== "DELIVERED" && row.delivered_at !== null)
  ) throw new SpeakerOperationsConflictError("Durable ACTION reminder delivery state is invalid.");
  const occurrenceDate = storedSharedActionValue(
    () => normalizedDateOnly(raw.occurrenceDate, "reminder occurrence").dueDate,
    "Durable ACTION reminder occurrence is invalid.",
  );
  const expectedWindowEndExclusive = new Date(
    Date.parse(`${occurrenceDate}T00:00:00.000Z`) + SHARED_ACTION_TASK_REMINDER_WINDOW_DAYS * UTC_DAY_MS,
  ).toISOString();
  const due = storedSharedActionValue(
    () => normalizedDateOnly(raw.dueDate, "reminder due date"),
    "Durable ACTION reminder due date is invalid.",
  );
  if (
    raw.windowEndExclusive !== expectedWindowEndExclusive || raw.dueAt !== due.dueAt ||
    createdAt.slice(0, 10) !== occurrenceDate
  ) throw new SpeakerOperationsConflictError("Durable ACTION reminder temporal evidence is divergent.");
  const eventName = storedSharedActionValue(
    () => sharedActionText(raw.eventName, "event name", 240),
    "Durable ACTION reminder event snapshot is invalid.",
  );
  const taskTitle = storedSharedActionValue(
    () => sharedActionText(raw.taskTitle, "task title", 240),
    "Durable ACTION reminder task title is invalid.",
  );
  const taskInstructions = storedSharedActionValue(
    () => sharedActionText(raw.taskInstructions, "task instructions", SHARED_ACTION_TASK_MAX_INSTRUCTIONS, true),
    "Durable ACTION reminder task instructions are invalid.",
  );
  const eventExists = db.prepare(
    "SELECT 1 FROM events WHERE workspace_id = ? AND id = ?",
  ).get(raw.workspaceId, raw.eventId);
  if (!eventExists) throw new SpeakerOperationsConflictError("Durable ACTION reminder event scope is unavailable.");
  const binding = sharedActionDefinitionForTask(db, raw.workspaceId, raw.eventId, raw.taskId);
  const task = sharedActionTaskState(db, binding.definition, binding.assignment);
  if (
    binding.definition.definitionId !== raw.definitionId || binding.assignment.assignmentId !== raw.assignmentId ||
    binding.assignment.personId !== raw.recipientPersonId || task.personId !== raw.recipientPersonId ||
    task.assignmentId !== raw.assignmentId || binding.definition.title !== taskTitle ||
    binding.definition.instructions !== taskInstructions || binding.definition.dueDate !== raw.dueDate ||
    binding.definition.dueAt !== raw.dueAt ||
    raw.subjectPreview !== `Action due: ${taskTitle}` ||
    raw.bodyPreview !== `${eventName}\n\n${taskTitle}\nDue ${raw.dueDate} UTC\n\n${taskInstructions}`
  ) throw new SpeakerOperationsConflictError("Durable ACTION reminder task-recipient evidence is divergent.");
  const recipientName = storedActionRecipientName(row.recipient_name);
  const recipientEmail = storedActionRecipientEmail(row.recipient_email);
  const reminder = raw as unknown as StoredActionReminder;
  const expectedMessage = reminderMessagePayload(row.id, reminder);
  if (row.outbox_payload_json !== expectedMessage.payloadJson) throw new SpeakerOperationsConflictError("Durable ACTION reminder outbox payload is divergent.");
  const providerReceipt = readActionReminderProviderReceipt(db, {
    row,
    reminder,
    payloadFingerprint: expectedMessage.payloadFingerprint,
  });
  if (
    (row.status === "DELIVERED" && (
      providerReceipt === null || providerReceipt.acceptedAt !== row.delivered_at
    )) ||
    (providerReceipt !== null && row.status !== "CLAIMED" && row.status !== "DELIVERED")
  ) throw new SpeakerOperationsConflictError("Durable ACTION reminder receipt state is divergent.");
  return deepFreeze({
    messageId: raw.messageId,
    domainEventId: row.id,
    workspaceId: raw.workspaceId,
    eventId: raw.eventId,
    definitionId: raw.definitionId,
    taskId: raw.taskId,
    assignmentId: raw.assignmentId,
    recipientPersonId: raw.recipientPersonId,
    recipientName,
    recipientEmail,
    occurrenceDate: raw.occurrenceDate,
    eventName: raw.eventName,
    taskTitle: raw.taskTitle,
    taskInstructions: raw.taskInstructions,
    dueDate: raw.dueDate,
    dueAt: raw.dueAt,
    subjectPreview: raw.subjectPreview,
    bodyPreview: raw.bodyPreview,
    destinationKey: raw.destinationKey,
    payloadFingerprint: expectedMessage.payloadFingerprint,
    status: row.status as SharedActionTaskReminderDeliveryStatus,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt,
    deliveredAt: row.delivered_at,
    lastErrorRecorded: row.last_error !== null,
    providerReceiptId: providerReceipt?.providerReceiptId ?? null,
    providerAcceptedAt: providerReceipt?.acceptedAt ?? null,
    deliveryMode: providerReceipt?.deliveryMode ?? null,
    channel: "local",
    providerMutation: false,
  });
}

function actionReminderRows(
  db: Db,
  workspaceId: string,
  eventId: string,
  taskId?: string,
  occurrenceDate?: string,
  messageId?: string,
): ActionReminderJoinedRow[] {
  const taskClause = taskId === undefined ? "" : " AND e.aggregate_id = ?";
  const occurrenceClause = occurrenceDate === undefined ? "" : " AND json_extract(e.payload_json, '$.occurrenceDate') = ?";
  const messageClause = messageId === undefined ? "" : " AND o.id = ?";
  const args: string[] = [workspaceId, SHARED_ACTION_TASK_REMINDER_EVENT_TYPE, SHARED_ACTION_TASK_REMINDER_AGGREGATE_TYPE, eventId];
  if (taskId !== undefined) args.push(taskId);
  if (occurrenceDate !== undefined) args.push(occurrenceDate);
  if (messageId !== undefined) args.push(messageId);
  return db.prepare(
    `SELECT e.id, e.workspace_id, e.event_type, e.aggregate_type, e.aggregate_id,
            e.payload_json, e.payload_fingerprint, e.created_at,
            o.id AS message_id, o.domain_event_id, o.destination_key,
            o.payload_json AS outbox_payload_json, o.status, o.attempt_count,
            o.next_attempt_at, o.claim_token, o.lease_expires_at,
            o.delivered_at, o.last_error,
            o.created_at AS outbox_created_at,
            recipient.id AS recipient_id,
            recipient.full_name AS recipient_name,
            recipient.canonical_email AS recipient_email
       FROM domain_events e
       JOIN outbox_messages o ON o.domain_event_id = e.id AND o.workspace_id = e.workspace_id
       JOIN people recipient ON recipient.workspace_id = e.workspace_id
        AND recipient.id = json_extract(e.payload_json, '$.recipientPersonId')
      WHERE e.workspace_id = ? AND e.event_type = ? AND e.aggregate_type = ?
        AND CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$.eventId') END = ?${taskClause}${occurrenceClause}${messageClause}
      ORDER BY e.created_at, e.id`,
  ).all(...args) as unknown as ActionReminderJoinedRow[];
}

function queueDueActionTaskRemindersInTransaction(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
  event: SpeakerEventContext,
  triggeredAtValue: string,
  actor: { readonly kind: "account" | "system"; readonly ref: string },
): SharedActionTaskReminderReceipt {
  const triggeredAt = canonicalStoredInstant(
    triggeredAtValue,
    "The ACTION task reminder clock is invalid.",
  );
  const { occurrenceDate, windowEndExclusive } = reminderOccurrence(triggeredAt);
  let scannedCount = 0;
  let completedCount = 0;
  let notDueCount = 0;
  let nonCurrentSpeakerCount = 0;
  let alreadyQueuedCount = 0;
  const queued: SharedActionTaskReminderDelivery[] = [];
  const definitions = sharedActionDefinitionRows(
    db,
    scope.workspaceId,
    scope.eventId,
    SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS + 1,
  ).map(parseSharedActionDefinition);
  const assignmentCount = definitions.reduce((count, definition) => count + definition.assignments.length, 0);
  if (assignmentCount > SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS) {
    throw new SpeakerOperationsConflictError(
      `ACTION task reminder scans are limited to ${SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS} assignments.`,
    );
  }
  for (const definition of definitions) {
    for (const assignment of definition.assignments) {
      scannedCount += 1;
      const task = sharedActionTaskState(db, definition, assignment);
      if (task.state === "COMPLETED") {
        completedCount += 1;
        continue;
      }
      if (Date.parse(task.dueAt) >= Date.parse(windowEndExclusive)) {
        notDueCount += 1;
        continue;
      }
      const currentAssignment = canonicalSpeakerAssignment(db, scope.workspaceId, scope.eventId, task.personId);
      if (!currentAssignment || currentAssignment.assignmentId !== task.assignmentId) {
        nonCurrentSpeakerCount += 1;
        continue;
      }
      const reminderEventId = deterministicUuid(`speaker-action-task-reminder-event:${scope.workspaceId}:${scope.eventId}:${task.id}:${occurrenceDate}`);
      const existingEvent = db.prepare(
        `SELECT id FROM domain_events WHERE workspace_id = ? AND id = ?`,
      ).get(scope.workspaceId, reminderEventId) as { readonly id: string } | undefined;
      if (existingEvent) {
        const existing = actionReminderRows(db, scope.workspaceId, scope.eventId, task.id, occurrenceDate);
        if (existing.length !== 1 || existing[0]?.id !== reminderEventId) {
          throw new SpeakerOperationsConflictError("Durable ACTION reminder replay evidence is incomplete or ambiguous.");
        }
        parseActionReminderRow(db, existing[0]);
        alreadyQueuedCount += 1;
        continue;
      }
      const person = db.prepare(
        `SELECT full_name AS fullName, canonical_email AS canonicalEmail
           FROM people WHERE workspace_id = ? AND id = ?`,
      ).get(scope.workspaceId, task.personId) as { readonly fullName: unknown; readonly canonicalEmail: unknown } | undefined;
      if (!person || typeof person.fullName !== "string" || typeof person.canonicalEmail !== "string") {
        throw new SpeakerOperationsConflictError("The ACTION reminder recipient Person is unavailable.");
      }
      const createdAt = triggeredAt;
      const messageId = deterministicUuid(`speaker-action-task-reminder-message:${reminderEventId}`);
      const destinationKey = `local:speaker-action-task-reminder:${scope.eventId}:${task.id}:${occurrenceDate}`;
      const subjectPreview = `Action due: ${task.title}`;
      const bodyPreview = `${event.name}\n\n${task.title}\nDue ${definition.dueDate} UTC\n\n${task.description}`;
      const reminder: StoredActionReminder = deepFreeze({
        schema: SHARED_ACTION_TASK_REMINDER_SCHEMA,
        operation: "queue-due-action-task-reminder",
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        definitionId: definition.definitionId,
        taskId: task.id,
        assignmentId: task.assignmentId,
        recipientPersonId: task.personId,
        occurrenceDate,
        windowEndExclusive,
        eventName: event.name,
        taskTitle: task.title,
        taskInstructions: task.description,
        dueDate: definition.dueDate,
        dueAt: task.dueAt,
        subjectPreview,
        bodyPreview,
        messageId,
        destinationKey,
        channel: "local",
        providerMutation: false,
        createdAt,
      });
      const reminderJson = canonicalJson(reminder);
      const reminderFingerprint = fingerprintOf(reminder);
      db.prepare(
        `INSERT INTO domain_events
           (id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        reminderEventId,
        scope.workspaceId,
        SHARED_ACTION_TASK_REMINDER_EVENT_TYPE,
        SHARED_ACTION_TASK_REMINDER_AGGREGATE_TYPE,
        task.id,
        reminderJson,
        reminderFingerprint,
        createdAt,
      );
      const message = reminderMessagePayload(reminderEventId, reminder);
      db.prepare(
        `INSERT INTO outbox_messages
           (id, workspace_id, domain_event_id, destination_key, payload_json,
            status, attempt_count, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
      ).run(messageId, scope.workspaceId, reminderEventId, destinationKey, message.payloadJson, createdAt, createdAt);
      writeAudit(db, scope.workspaceId, {
        actorKind: actor.kind,
        actorRef: actor.ref,
        action: "speaker.action-task.reminder.queued",
        targetType: "speaker_task",
        targetId: task.id,
        details: {
          eventId: scope.eventId,
          definitionId: definition.definitionId,
          assignmentId: task.assignmentId,
          recipientPersonId: task.personId,
          occurrenceDate,
          dueDate: definition.dueDate,
          messageId,
          providerMutation: false,
        },
      });
      const inserted = actionReminderRows(db, scope.workspaceId, scope.eventId, task.id, occurrenceDate);
      if (inserted.length !== 1 || inserted[0]?.id !== reminderEventId) {
        throw new SpeakerOperationsConflictError("The ACTION reminder outbox write was not durable.");
      }
      queued.push(parseActionReminderRow(db, inserted[0]));
    }
  }
  const skippedCount = completedCount + notDueCount + nonCurrentSpeakerCount + alreadyQueuedCount;
  return deepFreeze({
    schema: SHARED_ACTION_TASK_REMINDER_RECEIPT_SCHEMA,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    occurrenceDate,
    windowEndExclusive,
    scannedCount,
    maximumScanAssignments: SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS,
    queuedCount: queued.length,
    skippedCount,
    alreadyQueuedCount,
    completedCount,
    notDueCount,
    nonCurrentSpeakerCount,
    queued,
    channel: "local",
    providerMutation: false,
  });
}

function automaticReminderEvent(
  db: Db,
  workspaceId: string,
  eventId: string,
): SpeakerEventContext & { readonly lifecycle: string } {
  storedSharedActionValue(() => {
    boundedId(workspaceId, "workspaceId");
    boundedId(eventId, "eventId");
  }, "Automatic ACTION reminder scope is invalid.");
  const event = db.prepare(
    `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt, lifecycle
       FROM events WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, eventId) as Record<string, unknown> | undefined;
  if (!event) throw new SpeakerOperationsConflictError("Automatic ACTION reminder event scope is unavailable.");
  if (
    event.id !== eventId || typeof event.name !== "string" || event.name.length < 1 || event.name.length > 240 ||
    typeof event.timezone !== "string" || event.timezone.length < 1 || event.timezone.length > 120 ||
    typeof event.startsAt !== "string" || !Number.isFinite(Date.parse(event.startsAt)) ||
    typeof event.endsAt !== "string" || !Number.isFinite(Date.parse(event.endsAt)) ||
    Date.parse(event.endsAt) <= Date.parse(event.startsAt) ||
    typeof event.lifecycle !== "string" || event.lifecycle.length < 1 || event.lifecycle.length > 80
  ) throw new SpeakerOperationsConflictError("Automatic ACTION reminder event scope is invalid.");
  return {
    id: eventId,
    name: event.name,
    timezone: event.timezone,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    lifecycle: event.lifecycle,
  };
}

function eventAllowsAutomaticReminders(lifecycle: string): boolean {
  return !["closed", "cancelled", "canceled"].includes(lifecycle.toLocaleLowerCase("en-US"));
}

export function prepareAutomaticActionTaskReminders(
  db: Db,
  options: { readonly clock?: Clock } = {},
): AutomaticActionTaskReminderPreparationReceipt {
  if (db.isTransaction) {
    throw new SpeakerOperationsConflictError("Automatic ACTION reminder preparation must own its transaction boundaries.");
  }
  const triggeredAt = canonicalStoredInstant(
    (options.clock ?? (() => new Date().toISOString()))(),
    "The automatic ACTION reminder clock is invalid.",
  );
  const scopes = db.prepare(
    `SELECT DISTINCT event_row.workspace_id AS workspaceId, event_row.id AS eventId
       FROM domain_events definition
       JOIN events event_row
         ON event_row.workspace_id = definition.workspace_id
        AND event_row.id = CASE WHEN json_valid(definition.payload_json)
          THEN json_extract(definition.payload_json, '$.eventId') END
      WHERE definition.event_type = ? AND definition.aggregate_type = ?
      ORDER BY event_row.workspace_id, event_row.id
      LIMIT ?`,
  ).all(
    SHARED_ACTION_TASK_EVENT_TYPE,
    SHARED_ACTION_TASK_AGGREGATE_TYPE,
    SHARED_ACTION_TASK_REMINDER_MAX_EVENT_SCOPES + 1,
  ) as unknown as Array<{ readonly workspaceId: unknown; readonly eventId: unknown }>;
  if (scopes.length > SHARED_ACTION_TASK_REMINDER_MAX_EVENT_SCOPES) {
    throw new SpeakerOperationsConflictError(
      `Automatic ACTION reminder runs are limited to ${SHARED_ACTION_TASK_REMINDER_MAX_EVENT_SCOPES} event scopes.`,
    );
  }
  const totals = {
    scannedCount: 0,
    queuedCount: 0,
    alreadyQueuedCount: 0,
    completedCount: 0,
    notDueCount: 0,
    nonCurrentSpeakerCount: 0,
    inactiveEventCount: 0,
  };
  for (const rawScope of scopes) {
    if (typeof rawScope.workspaceId !== "string" || typeof rawScope.eventId !== "string") {
      throw new SpeakerOperationsConflictError("Automatic ACTION reminder scope is malformed.");
    }
    const receipt = withTransaction(db, () => {
      const event = automaticReminderEvent(db, rawScope.workspaceId as string, rawScope.eventId as string);
      if (!eventAllowsAutomaticReminders(event.lifecycle)) return null;
      return queueDueActionTaskRemindersInTransaction(
        db,
        { workspaceId: rawScope.workspaceId as string, eventId: rawScope.eventId as string },
        event,
        triggeredAt,
        { kind: "system", ref: ACTION_REMINDER_WORKER_IDENTITY },
      );
    });
    if (!receipt) {
      totals.inactiveEventCount += 1;
      continue;
    }
    totals.scannedCount += receipt.scannedCount;
    totals.queuedCount += receipt.queuedCount;
    totals.alreadyQueuedCount += receipt.alreadyQueuedCount;
    totals.completedCount += receipt.completedCount;
    totals.notDueCount += receipt.notDueCount;
    totals.nonCurrentSpeakerCount += receipt.nonCurrentSpeakerCount;
  }
  return deepFreeze({
    schema: SHARED_ACTION_TASK_REMINDER_JOB_SCHEMA,
    triggeredAt,
    eventScopeCount: scopes.length,
    ...totals,
    providerMutation: false,
  });
}

function actionReminderEligibility(db: Db, delivery: SharedActionTaskReminderDelivery): ActionReminderEligibility {
  const event = automaticReminderEvent(db, delivery.workspaceId, delivery.eventId);
  if (!eventAllowsAutomaticReminders(event.lifecycle)) return "EVENT_INACTIVE";
  const binding = sharedActionDefinitionForTask(db, delivery.workspaceId, delivery.eventId, delivery.taskId);
  const task = sharedActionTaskState(db, binding.definition, binding.assignment);
  if (task.state === "COMPLETED") return "TASK_COMPLETED";
  const currentAssignment = canonicalSpeakerAssignment(
    db,
    delivery.workspaceId,
    delivery.eventId,
    delivery.recipientPersonId,
  );
  if (
    !currentAssignment || currentAssignment.assignmentId !== delivery.assignmentId ||
    binding.assignment.assignmentId !== delivery.assignmentId ||
    binding.assignment.personId !== delivery.recipientPersonId
  ) return "ASSIGNMENT_REVOKED";
  return "ELIGIBLE";
}

function actionReminderRowByMessage(
  db: Db,
  workspaceId: string,
  eventId: string,
  messageId: string,
): ActionReminderJoinedRow {
  const rows = actionReminderRows(db, workspaceId, eventId, undefined, undefined, messageId);
  if (rows.length !== 1) {
    throw new SpeakerOperationsConflictError("The claimed ACTION reminder is unavailable or ambiguous.");
  }
  return rows[0]!;
}

function terminalizeActionReminder(
  db: Db,
  row: ActionReminderJoinedRow,
  delivery: SharedActionTaskReminderDelivery,
  failureCode: ActionReminderFailureCode,
): void {
  const updated = db.prepare(
    `UPDATE outbox_messages
        SET status = 'FAILED', next_attempt_at = NULL, claim_token = NULL,
            lease_expires_at = NULL, delivered_at = NULL, last_error = ?
      WHERE id = ? AND workspace_id = ? AND status IN ('PENDING', 'CLAIMED')`,
  ).run(failureCode, row.message_id, row.workspace_id);
  if (updated.changes !== 1) {
    throw new SpeakerOperationsConflictError("The ACTION reminder terminal transition conflicted.");
  }
  writeAudit(db, delivery.workspaceId, {
    actorKind: "system",
    actorRef: ACTION_REMINDER_WORKER_IDENTITY,
    action: ACTION_REMINDER_STOPPED_ACTION,
    targetType: "outbox_message",
    targetId: delivery.messageId,
    details: {
      eventId: delivery.eventId,
      taskId: delivery.taskId,
      assignmentId: delivery.assignmentId,
      recipientPersonId: delivery.recipientPersonId,
      occurrenceDate: delivery.occurrenceDate,
      attemptCount: delivery.attemptCount,
      failureCode,
      providerMutation: false,
    },
  });
}

type ActionReminderClaimResult =
  | { readonly kind: "NONE" }
  | { readonly kind: "RECOVERED" }
  | { readonly kind: "STOPPED" }
  | {
      readonly kind: "CLAIMED";
      readonly claimToken: string;
      readonly delivery: SharedActionTaskReminderDelivery;
    };

function claimNextActionTaskReminder(db: Db, now: string): ActionReminderClaimResult {
  return withTransaction(db, () => {
    const candidate = db.prepare(
      `SELECT outbox.id AS messageId, outbox.workspace_id AS workspaceId,
              CASE WHEN json_valid(event_row.payload_json)
                THEN json_extract(event_row.payload_json, '$.eventId') END AS eventId
         FROM outbox_messages outbox
         JOIN domain_events event_row
           ON event_row.id = outbox.domain_event_id
          AND event_row.workspace_id = outbox.workspace_id
        WHERE event_row.event_type = ? AND event_row.aggregate_type = ?
          AND (
            (outbox.status = 'PENDING' AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= ?))
            OR (outbox.status = 'CLAIMED' AND outbox.lease_expires_at IS NOT NULL AND outbox.lease_expires_at <= ?)
            OR (outbox.status IN ('PENDING', 'CLAIMED') AND EXISTS (
              SELECT 1 FROM audit_events receipt
               WHERE receipt.workspace_id = outbox.workspace_id
                 AND receipt.action = ?
                 AND receipt.target_type = 'outbox_message'
                 AND receipt.target_id = outbox.id
            ))
          )
        ORDER BY COALESCE(outbox.next_attempt_at, outbox.lease_expires_at, outbox.created_at),
                 outbox.created_at, outbox.id
        LIMIT 1`,
    ).get(
      SHARED_ACTION_TASK_REMINDER_EVENT_TYPE,
      SHARED_ACTION_TASK_REMINDER_AGGREGATE_TYPE,
      now,
      now,
      ACTION_REMINDER_RECEIPT_ACTION,
    ) as { readonly messageId: unknown; readonly workspaceId: unknown; readonly eventId: unknown } | undefined;
    if (!candidate) return { kind: "NONE" };
    if (
      typeof candidate.messageId !== "string" || typeof candidate.workspaceId !== "string" ||
      typeof candidate.eventId !== "string"
    ) throw new SpeakerOperationsConflictError("The ACTION reminder claim candidate is malformed.");
    const row = actionReminderRowByMessage(db, candidate.workspaceId, candidate.eventId, candidate.messageId);
    const delivery = parseActionReminderRow(db, row);
    if (delivery.providerReceiptId !== null) {
      const updated = db.prepare(
        `UPDATE outbox_messages
            SET status = 'DELIVERED', next_attempt_at = NULL, claim_token = NULL,
                lease_expires_at = NULL, delivered_at = ?, last_error = NULL
          WHERE id = ? AND workspace_id = ? AND status IN ('PENDING', 'CLAIMED')`,
      ).run(delivery.providerAcceptedAt, delivery.messageId, delivery.workspaceId);
      if (updated.changes !== 1) {
        throw new SpeakerOperationsConflictError("The ACTION reminder receipt recovery conflicted.");
      }
      parseActionReminderRow(
        db,
        actionReminderRowByMessage(db, delivery.workspaceId, delivery.eventId, delivery.messageId),
      );
      return { kind: "RECOVERED" };
    }
    const eligibility = actionReminderEligibility(db, delivery);
    if (eligibility !== "ELIGIBLE") {
      terminalizeActionReminder(db, row, delivery, eligibility);
      return { kind: "STOPPED" };
    }
    if (delivery.attemptCount >= SHARED_ACTION_TASK_REMINDER_MAX_ATTEMPTS) {
      terminalizeActionReminder(db, row, delivery, "ATTEMPT_LIMIT_REACHED");
      return { kind: "STOPPED" };
    }
    const claimToken = randomToken();
    const leaseExpiresAt = new Date(Date.parse(now) + ACTION_REMINDER_CLAIM_LEASE_MS).toISOString();
    const updated = db.prepare(
      `UPDATE outbox_messages
          SET status = 'CLAIMED', attempt_count = attempt_count + 1,
              next_attempt_at = NULL, claim_token = ?, lease_expires_at = ?
        WHERE id = ? AND workspace_id = ? AND attempt_count = ?
          AND (
            (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (status = 'CLAIMED' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          )`,
    ).run(
      claimToken,
      leaseExpiresAt,
      delivery.messageId,
      delivery.workspaceId,
      delivery.attemptCount,
      now,
      now,
    );
    if (updated.changes !== 1) {
      throw new SpeakerOperationsConflictError("The ACTION reminder claim conflicted.");
    }
    const claimed = parseActionReminderRow(
      db,
      actionReminderRowByMessage(db, delivery.workspaceId, delivery.eventId, delivery.messageId),
    );
    return { kind: "CLAIMED", claimToken, delivery: claimed };
  });
}

function actionReminderDeliveryIntent(delivery: SharedActionTaskReminderDelivery): ActionTaskReminderDeliveryIntent {
  return {
    workspaceId: delivery.workspaceId,
    eventId: delivery.eventId,
    taskId: delivery.taskId,
    assignmentId: delivery.assignmentId,
    recipientPersonId: delivery.recipientPersonId,
    recipientName: delivery.recipientName,
    recipientEmail: delivery.recipientEmail,
    messageId: delivery.messageId,
    occurrenceDate: delivery.occurrenceDate,
    subject: delivery.subjectPreview,
    body: delivery.bodyPreview,
    payloadFingerprint: delivery.payloadFingerprint,
    idempotencyKey: actionReminderProviderIdempotencyKey(delivery.workspaceId, delivery.messageId),
  };
}

function validateActionReminderProviderReceipt(
  value: unknown,
  intent: ActionTaskReminderDeliveryIntent,
): ActionTaskReminderProviderReceipt {
  const receipt = exactObject(value, [
    "schema", "providerReceiptId", "messageId", "idempotencyKey", "payloadFingerprint",
    "acceptedAt", "deliveryMode", "networkContacted", "providerMutation",
  ], "The ACTION reminder adapter receipt is malformed.");
  const acceptedAt = canonicalStoredInstant(
    receipt.acceptedAt,
    "The ACTION reminder adapter receipt time is invalid.",
  );
  if (
    receipt.schema !== SHARED_ACTION_TASK_REMINDER_PROVIDER_RECEIPT_SCHEMA ||
    typeof receipt.providerReceiptId !== "string" || !SAFE_ID.test(receipt.providerReceiptId) ||
    receipt.messageId !== intent.messageId || receipt.idempotencyKey !== intent.idempotencyKey ||
    receipt.payloadFingerprint !== intent.payloadFingerprint ||
    receipt.deliveryMode !== "NO_NETWORK_SIMULATED" || receipt.networkContacted !== false ||
    receipt.providerMutation !== false
  ) throw new SpeakerOperationsConflictError("The ACTION reminder adapter receipt binding is invalid.");
  return { ...(receipt as unknown as ActionTaskReminderProviderReceipt), acceptedAt };
}

type ActionReminderFinalizeResult = "DELIVERED" | "RECOVERED" | "STOPPED";

function finalizeClaimedActionReminder(
  db: Db,
  claimed: Extract<ActionReminderClaimResult, { readonly kind: "CLAIMED" }>,
  adapter: ActionTaskReminderDeliveryAdapter,
  receipt: ActionTaskReminderProviderReceipt,
): ActionReminderFinalizeResult {
  return withTransaction(db, () => {
    const row = actionReminderRowByMessage(
      db,
      claimed.delivery.workspaceId,
      claimed.delivery.eventId,
      claimed.delivery.messageId,
    );
    const delivery = parseActionReminderRow(db, row);
    if (row.status !== "CLAIMED" || row.claim_token !== claimed.claimToken) {
      throw new SpeakerOperationsConflictError("The ACTION reminder claim is no longer authoritative.");
    }
    if (delivery.providerReceiptId !== null) {
      const recovered = db.prepare(
        `UPDATE outbox_messages
            SET status = 'DELIVERED', next_attempt_at = NULL, claim_token = NULL,
                lease_expires_at = NULL, delivered_at = ?, last_error = NULL
          WHERE id = ? AND workspace_id = ? AND status = 'CLAIMED' AND claim_token = ?`,
      ).run(delivery.providerAcceptedAt, delivery.messageId, delivery.workspaceId, claimed.claimToken);
      if (recovered.changes !== 1) throw new SpeakerOperationsConflictError("The ACTION reminder receipt recovery conflicted.");
      return "RECOVERED";
    }
    const eligibility = actionReminderEligibility(db, delivery);
    if (eligibility !== "ELIGIBLE") {
      terminalizeActionReminder(db, row, delivery, eligibility);
      return "STOPPED";
    }
    const storedReceipt: StoredActionReminderProviderReceipt = {
      ...receipt,
      adapterKind: adapter.kind,
      workspaceId: delivery.workspaceId,
      eventId: delivery.eventId,
      taskId: delivery.taskId,
      assignmentId: delivery.assignmentId,
      recipientPersonId: delivery.recipientPersonId,
      domainEventId: delivery.domainEventId,
    };
    const auditId = actionReminderProviderReceiptAuditId(delivery.workspaceId, delivery.messageId);
    try {
      db.prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, 'system', ?, ?, 'outbox_message', ?, ?, ?)`,
      ).run(
        auditId,
        delivery.workspaceId,
        adapter.kind,
        ACTION_REMINDER_RECEIPT_ACTION,
        delivery.messageId,
        canonicalJson(storedReceipt),
        receipt.acceptedAt,
      );
    } catch {
      const existing = readActionReminderProviderReceipt(db, {
        row,
        reminder: JSON.parse(row.payload_json) as StoredActionReminder,
        payloadFingerprint: delivery.payloadFingerprint,
      });
      if (!existing || canonicalJson(existing) !== canonicalJson(storedReceipt)) {
        throw new SpeakerOperationsConflictError("The ACTION reminder provider receipt conflicted.");
      }
    }
    const updated = db.prepare(
      `UPDATE outbox_messages
          SET status = 'DELIVERED', next_attempt_at = NULL, claim_token = NULL,
              lease_expires_at = NULL, delivered_at = ?, last_error = NULL
        WHERE id = ? AND workspace_id = ? AND status = 'CLAIMED' AND claim_token = ?`,
    ).run(receipt.acceptedAt, delivery.messageId, delivery.workspaceId, claimed.claimToken);
    if (updated.changes !== 1) {
      throw new SpeakerOperationsConflictError("The ACTION reminder delivery finalization conflicted.");
    }
    const finalized = parseActionReminderRow(
      db,
      actionReminderRowByMessage(db, delivery.workspaceId, delivery.eventId, delivery.messageId),
    );
    if (finalized.providerReceiptId !== receipt.providerReceiptId) {
      throw new SpeakerOperationsConflictError("The ACTION reminder delivery receipt was not durable.");
    }
    return "DELIVERED";
  });
}

type ActionReminderFailureResult = "RETRYING" | "FAILED" | "RECOVERED" | "STOPPED";

function recordClaimedActionReminderFailure(
  db: Db,
  claimed: Extract<ActionReminderClaimResult, { readonly kind: "CLAIMED" }>,
  now: string,
): ActionReminderFailureResult {
  return withTransaction(db, () => {
    const row = actionReminderRowByMessage(
      db,
      claimed.delivery.workspaceId,
      claimed.delivery.eventId,
      claimed.delivery.messageId,
    );
    const delivery = parseActionReminderRow(db, row);
    if (row.status !== "CLAIMED" || row.claim_token !== claimed.claimToken) {
      throw new SpeakerOperationsConflictError("The failed ACTION reminder claim is no longer authoritative.");
    }
    if (delivery.providerReceiptId !== null) {
      const recovered = db.prepare(
        `UPDATE outbox_messages
            SET status = 'DELIVERED', next_attempt_at = NULL, claim_token = NULL,
                lease_expires_at = NULL, delivered_at = ?, last_error = NULL
          WHERE id = ? AND workspace_id = ? AND status = 'CLAIMED' AND claim_token = ?`,
      ).run(delivery.providerAcceptedAt, delivery.messageId, delivery.workspaceId, claimed.claimToken);
      if (recovered.changes !== 1) throw new SpeakerOperationsConflictError("The ACTION reminder receipt recovery conflicted.");
      return "RECOVERED";
    }
    const eligibility = actionReminderEligibility(db, delivery);
    if (eligibility !== "ELIGIBLE") {
      terminalizeActionReminder(db, row, delivery, eligibility);
      return "STOPPED";
    }
    if (delivery.attemptCount >= SHARED_ACTION_TASK_REMINDER_MAX_ATTEMPTS) {
      terminalizeActionReminder(db, row, delivery, "PROVIDER_FAILURE");
      return "FAILED";
    }
    const retryAt = new Date(
      Date.parse(now) + ACTION_REMINDER_RETRY_BASE_MS * (2 ** (delivery.attemptCount - 1)),
    ).toISOString();
    const updated = db.prepare(
      `UPDATE outbox_messages
          SET status = 'PENDING', next_attempt_at = ?, claim_token = NULL,
              lease_expires_at = NULL, delivered_at = NULL, last_error = 'PROVIDER_FAILURE'
        WHERE id = ? AND workspace_id = ? AND status = 'CLAIMED' AND claim_token = ?`,
    ).run(retryAt, delivery.messageId, delivery.workspaceId, claimed.claimToken);
    if (updated.changes !== 1) {
      throw new SpeakerOperationsConflictError("The ACTION reminder retry transition conflicted.");
    }
    return "RETRYING";
  });
}

function boundedDeliveryLimit(value: number | undefined): number {
  const selected = value ?? SHARED_ACTION_TASK_REMINDER_MAX_DELIVERIES;
  if (
    !Number.isSafeInteger(selected) || selected < 0 ||
    selected > SHARED_ACTION_TASK_REMINDER_MAX_DELIVERIES
  ) throw new SpeakerOperationsInputError(
    `Automatic ACTION reminder delivery limits must be between 0 and ${SHARED_ACTION_TASK_REMINDER_MAX_DELIVERIES}.`,
  );
  return selected;
}

export function runAutomaticActionTaskReminderJob(
  db: Db,
  options: {
    readonly clock?: Clock;
    readonly adapter?: ActionTaskReminderDeliveryAdapter;
    readonly maximumDeliveries?: number;
  } = {},
): AutomaticActionTaskReminderJobReceipt {
  if (db.isTransaction) {
    throw new SpeakerOperationsConflictError("The automatic ACTION reminder job must own its transaction boundaries.");
  }
  const triggeredAt = canonicalStoredInstant(
    (options.clock ?? (() => new Date().toISOString()))(),
    "The automatic ACTION reminder clock is invalid.",
  );
  const maximumDeliveries = boundedDeliveryLimit(options.maximumDeliveries);
  const adapter = options.adapter ?? new NoNetworkActionTaskReminderDeliveryAdapter({ clock: () => triggeredAt });
  if (
    typeof adapter.kind !== "string" || !ACTION_REMINDER_ADAPTER_KIND.test(adapter.kind) ||
    adapter.networkContacted !== false || adapter.providerMutation !== false ||
    typeof adapter.deliver !== "function"
  ) throw new SpeakerOperationsAuthorizationError("The ACTION reminder adapter is not authorized.");
  const prepared = prepareAutomaticActionTaskReminders(db, { clock: () => triggeredAt });
  const counts = {
    processedCount: 0,
    claimedCount: 0,
    deliveredCount: 0,
    retryingCount: 0,
    failedCount: 0,
    recoveredReceiptCount: 0,
    stoppedBeforeDeliveryCount: 0,
  };
  while (counts.processedCount < maximumDeliveries) {
    const claim = claimNextActionTaskReminder(db, triggeredAt);
    if (claim.kind === "NONE") break;
    counts.processedCount += 1;
    if (claim.kind === "RECOVERED") {
      counts.recoveredReceiptCount += 1;
      counts.deliveredCount += 1;
      continue;
    }
    if (claim.kind === "STOPPED") {
      counts.failedCount += 1;
      counts.stoppedBeforeDeliveryCount += 1;
      continue;
    }
    counts.claimedCount += 1;
    const intent = actionReminderDeliveryIntent(claim.delivery);
    let receipt: ActionTaskReminderProviderReceipt;
    try {
      receipt = validateActionReminderProviderReceipt(adapter.deliver(intent), intent);
    } catch {
      const failure = recordClaimedActionReminderFailure(db, claim, triggeredAt);
      if (failure === "RETRYING") counts.retryingCount += 1;
      else if (failure === "RECOVERED") {
        counts.recoveredReceiptCount += 1;
        counts.deliveredCount += 1;
      } else {
        counts.failedCount += 1;
        if (failure === "STOPPED") counts.stoppedBeforeDeliveryCount += 1;
      }
      continue;
    }
    const finalized = finalizeClaimedActionReminder(db, claim, adapter, receipt);
    if (finalized === "RECOVERED") {
      counts.recoveredReceiptCount += 1;
      counts.deliveredCount += 1;
    } else if (finalized === "STOPPED") {
      counts.failedCount += 1;
      counts.stoppedBeforeDeliveryCount += 1;
    } else {
      counts.deliveredCount += 1;
    }
  }
  return deepFreeze({
    ...prepared,
    ...counts,
    maximumAttempts: SHARED_ACTION_TASK_REMINDER_MAX_ATTEMPTS,
    deliveryMode: "NO_NETWORK_SIMULATED",
    networkContacted: false,
    providerMutation: false,
  });
}

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SpeakerOperationsConflictError(code);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) {
    throw new SpeakerOperationsConflictError(code);
  }
  return value as Record<string, unknown>;
}

function exactApprovalOutcome(value: unknown, approval: ContentApproval): void {
  const outcome = exactObject(value, [
    "id", "workspaceId", "eventId", "personId", "taskId", "submissionVersionId",
    "submissionContentHash", "approvedBy", "approvedAt", "gate",
  ], "The approval receipt outcome is malformed.");
  const expected = approval as unknown as Record<string, unknown>;
  for (const key of Object.keys(expected)) {
    if (outcome[key] !== expected[key]) throw new SpeakerOperationsConflictError("The approval receipt outcome is not authoritative.");
  }
}

const DURABLE_ARTIFACT_CONTENT_KINDS = ["HEADSHOT", "SLIDES"] as const;
type DurableArtifactContentKind = (typeof DURABLE_ARTIFACT_CONTENT_KINDS)[number];

function cachedArtifactKindForApproval(
  content: ContentOperationsRepository,
  scope: SpeakerOrganizerScope,
  input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string },
): DurableArtifactContentKind | null {
  const contentScopeValue = contentScope(scope);
  for (const kind of DURABLE_ARTIFACT_CONTENT_KINDS) {
    const review = content.getReviewProjection(contentScopeValue, {
      personId: input.personId,
      taskId: input.taskId,
      kind,
    });
    if (review.versions.some((version) => version.id === input.submissionVersionId)) {
      return kind;
    }
  }
  return null;
}

function assertDurableApprovalAuthority(
  db: Db,
  scope: SpeakerOrganizerScope,
  taskId: string,
  personId: string,
  versionId: string,
  contentHash: string,
): void {
  const authority = db.prepare(
    `SELECT task.assignment_id AS taskAssignmentId,
            assignment.id AS assignmentId, plan.id AS planId,
            plan.fingerprint AS planFingerprint, plan.version_number AS planVersionNumber,
            approval.decision AS approvalDecision, offer.id AS offerId,
            offer.terms_json AS termsJson, offer.terms_fingerprint AS termsFingerprint,
            response.response AS responseState,
            person.full_name AS personName, person.canonical_email AS personEmail,
            unit.id AS programUnitId, unit.name AS programUnitName
     FROM speaker_tasks task
     JOIN events event_row
       ON event_row.id = task.event_id AND event_row.workspace_id = task.workspace_id
     JOIN plan_versions plan
       ON plan.id = event_row.current_plan_version_id
      AND plan.workspace_id = event_row.workspace_id AND plan.event_id = event_row.id
     JOIN plan_states plan_state
       ON plan_state.workspace_id = plan.workspace_id AND plan_state.plan_version_id = plan.id
      AND plan_state.rowid = (
        SELECT latest.rowid FROM plan_states latest
        WHERE latest.workspace_id = plan.workspace_id AND latest.plan_version_id = plan.id
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
      )
     JOIN plan_assignments assignment
       ON assignment.workspace_id = plan.workspace_id AND assignment.plan_version_id = plan.id
      AND assignment.id = task.assignment_id AND assignment.person_id = task.person_id
     JOIN approvals approval
       ON approval.workspace_id = plan.workspace_id AND approval.event_id = plan.event_id
      AND approval.plan_version_id = plan.id AND approval.decision = 'approved'
     JOIN commitment_offers offer
       ON offer.workspace_id = plan.workspace_id AND offer.event_id = plan.event_id
      AND offer.plan_version_id = plan.id AND offer.person_id = assignment.person_id
     JOIN commitment_responses response
       ON response.workspace_id = offer.workspace_id AND response.offer_id = offer.id
      AND response.actor_person_id = offer.person_id AND response.response = 'accepted'
     JOIN people person ON person.workspace_id = task.workspace_id AND person.id = task.person_id
     JOIN program_units unit
       ON unit.workspace_id = assignment.workspace_id AND unit.event_id = plan.event_id
      AND unit.id = assignment.program_unit_id
     WHERE task.workspace_id = ? AND task.event_id = ? AND task.id = ?
       AND task.person_id = ? AND plan_state.state = 'approved'
       AND (
         SELECT COUNT(*)
         FROM plan_assignments current_assignment
         JOIN program_units current_unit
           ON current_unit.id = current_assignment.program_unit_id
          AND current_unit.workspace_id = current_assignment.workspace_id
          AND current_unit.event_id = plan.event_id
         JOIN commitment_offers current_offer
           ON current_offer.workspace_id = plan.workspace_id
          AND current_offer.event_id = plan.event_id
          AND current_offer.plan_version_id = plan.id
          AND current_offer.person_id = current_assignment.person_id
         JOIN commitment_responses current_response
           ON current_response.workspace_id = current_offer.workspace_id
          AND current_response.offer_id = current_offer.id
          AND current_response.actor_person_id = current_offer.person_id
          AND current_response.response = 'accepted'
         WHERE current_assignment.workspace_id = plan.workspace_id
           AND current_assignment.plan_version_id = plan.id
           AND current_assignment.person_id = task.person_id
       ) = 1`,
  ).get(scope.workspaceId, scope.eventId, taskId, personId) as {
    taskAssignmentId: string; assignmentId: string; planId: string; planFingerprint: string;
    planVersionNumber: number; approvalDecision: string; offerId: string; termsJson: string;
    termsFingerprint: string; responseState: string; personName: string; personEmail: string;
    programUnitId: string; programUnitName: string;
  } | undefined;
  if (!authority || authority.taskAssignmentId !== authority.assignmentId
    || authority.approvalDecision !== "approved" || authority.responseState !== "accepted"
    || fingerprintOf(JSON.parse(authority.termsJson)) !== authority.termsFingerprint) {
    throw new SpeakerOperationsConflictError("The approval authority is stale or unavailable.");
  }

  const version = db.prepare(
    `SELECT id, workspace_id, event_id, person_id, task_id, kind, version,
            payload_json, content_hash
     FROM speaker_content_versions
     WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ?`,
  ).get(versionId, scope.workspaceId, scope.eventId, personId, taskId) as {
    id: string; workspace_id: string; event_id: string; person_id: string; task_id: string;
    kind: ContentKind; version: number; payload_json: string; content_hash: string;
  } | undefined;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(version?.payload_json ?? "null") as Record<string, unknown>;
    if (!version || canonicalJson(payload) !== version.payload_json
      || fingerprintOf(payload) !== version.content_hash || version.content_hash !== contentHash
      || (payload.kind as string) !== version.kind) throw new Error("content");
    const asset = payload.asset as Record<string, unknown>;
    if (typeof asset?.assetId !== "string" || typeof asset.byteSize !== "number"
      || typeof asset.fileName !== "string" || typeof asset.mediaType !== "string"
      || typeof asset.checksum !== "string" || typeof asset.storageRef !== "string") throw new Error("asset");
    const artifact = db.prepare(
      `SELECT id, workspace_id, event_id, person_id, task_id, kind, version,
              storage_provider, storage_id, storage_filename, sha256, size_bytes,
              media_type, display_filename, content_version_id
       FROM artifact_records
       WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ?
         AND content_version_id = ? AND kind = ?`,
    ).get(scope.workspaceId, scope.eventId, personId, taskId, version.id, version.kind) as {
      id: string; workspace_id: string; event_id: string; person_id: string; task_id: string;
      kind: ContentKind; version: number; storage_provider: string; storage_id: string;
      storage_filename: string; sha256: string; size_bytes: number; media_type: string;
      display_filename: string; content_version_id: string;
    } | undefined;
    if (!artifact || artifact.id !== asset.assetId || artifact.workspace_id !== scope.workspaceId
      || artifact.event_id !== scope.eventId || artifact.person_id !== personId
      || artifact.task_id !== taskId || artifact.kind !== version.kind
      || artifact.version !== version.version || artifact.storage_provider !== "local"
      || artifact.sha256 !== asset.checksum
      || artifact.size_bytes !== asset.byteSize || artifact.media_type !== asset.mediaType
      || artifact.display_filename !== asset.fileName || artifact.content_version_id !== version.id
      || asset.storageRef !== `synthetic://artifact/${asset.assetId}`) throw new Error("artifact");
  } catch {
    throw new SpeakerOperationsConflictError("Durable artifact content or identity is inconsistent.");
  }

}

function durableArtifactApproval(
  db: Db,
  scope: SpeakerOrganizerScope,
  input: {
    readonly personId: string;
    readonly taskId: string;
    readonly submissionVersionId: string;
    readonly submissionContentHash: string;
    readonly gate?: ContentApproval["gate"];
    readonly idempotencyKey?: string;
  },
  clock: Clock,
): ContentApproval | null {
  const idempotencyKey = input.idempotencyKey;
  if (idempotencyKey !== undefined && (!/^\S.{0,127}$/u.test(idempotencyKey) || idempotencyKey.trim() !== idempotencyKey)) {
    throw new SpeakerOperationsInputError("Approval idempotency key is invalid.");
  }
  const gate = input.gate ?? "PUBLICATION";

  return withTransactionOrSavepoint(db, "speaker_content_approval", () => {
  if (!["CONFIRMATION", "PUBLICATION", "OPERATOR_RELEASE"].includes(gate)) {
    throw new SpeakerOperationsInputError("Approval gate is unsupported.");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.submissionContentHash)) {
    throw new SpeakerOperationsInputError("Submission content hash is invalid.");
  }
  const persistedActor = db.prepare(
    "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
  ).get(scope.workspaceId, scope.actorId) as { role: string } | undefined;
  if (!persistedActor || !roleHasCapability(persistedActor.role, "phase0.pipeline.manage")) {
    throw new SpeakerOperationsAuthorizationError("The approval actor is not a persisted organizer capability.");
  }
  const task = db.prepare(
    `SELECT person_id, assignment_id, task_kind, content_kind, owner
     FROM speaker_tasks
     WHERE id = ? AND workspace_id = ? AND event_id = ?`,
  ).get(input.taskId, scope.workspaceId, scope.eventId) as {
    person_id: string;
    assignment_id: string;
    task_kind: string;
    content_kind: ContentKind;
    owner: string;
  } | undefined;
  if (!task || task.person_id !== input.personId || typeof task.assignment_id !== "string" || task.task_kind !== task.content_kind || task.owner !== "SPEAKER" || (task.content_kind !== "HEADSHOT" && task.content_kind !== "SLIDES")) {
    if (idempotencyKey && db.prepare(
      `SELECT 1 FROM domain_events
       WHERE workspace_id = ? AND event_type = 'speaker.content.approved'
         AND json_extract(payload_json, '$.eventId') = ?
         AND json_extract(payload_json, '$.actorId') = ?
         AND json_extract(payload_json, '$.idempotencyKey') = ?
         AND json_extract(payload_json, '$.schema') IN
           ('speaker-content-approval-receipt/v1', 'speaker-content-approval-receipt/v2')
       LIMIT 1`,
    ).get(scope.workspaceId, scope.eventId, scope.actorId, idempotencyKey)) {
      throw new SpeakerOperationsConflictError("The idempotency key was reused with different approval content.");
    }
    return null;
  }
  const acceptedAssignment = canonicalSpeakerAssignment(db, scope.workspaceId, scope.eventId, input.personId);
  if (!acceptedAssignment || task.assignment_id !== acceptedAssignment.assignmentId) {
    throw new SpeakerOperationsAuthorizationError("Speaker content authority is no longer current.");
  }

  const legacyCommand = {
    schema: "speaker-content-approval-command/v1",
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    actorId: scope.actorId,
    personId: input.personId,
    taskId: input.taskId,
    submissionVersionId: input.submissionVersionId,
    submissionContentHash: input.submissionContentHash,
    kind: task.content_kind,
    gate,
    idempotencyKey: idempotencyKey ?? null,
  } as const;
  const command = {
    ...legacyCommand,
    schema: "speaker-content-approval-command/v2",
    assignmentId: task.assignment_id,
  } as const;
  const commandFingerprint = fingerprintOf(command);

  assertDurableApprovalAuthority(
    db,
    scope,
    input.taskId,
    input.personId,
    input.submissionVersionId,
    input.submissionContentHash,
  );

  if (idempotencyKey) {
    const receipt = db.prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at
       FROM domain_events
       WHERE workspace_id = ? AND event_type = 'speaker.content.approved'
         AND json_extract(payload_json, '$.eventId') = ?
         AND json_extract(payload_json, '$.actorId') = ?
         AND json_extract(payload_json, '$.idempotencyKey') = ?
       LIMIT 1`,
    ).get(scope.workspaceId, scope.eventId, scope.actorId, idempotencyKey) as {
      id: string; workspace_id: string; event_type: string; aggregate_type: string; aggregate_id: string;
      payload_json: string; payload_fingerprint: string; created_at: string;
    } | undefined;
    if (receipt) {
      let payload: Record<string, unknown>;
      let expectedCommandFingerprint: string;
      try {
        const parsed = JSON.parse(receipt.payload_json) as unknown;
        if (canonicalJson(parsed) !== receipt.payload_json
          || fingerprintOf(parsed) !== receipt.payload_fingerprint) throw new Error("receipt fingerprint");
        if ((parsed as Record<string, unknown>)?.schema === "speaker-content-approval-receipt/v1") {
          payload = exactObject(parsed, ["schema", "eventId", "actorId", "idempotencyKey", "commandFingerprint", "kind", "outcome"], "The approval receipt is malformed.");
          expectedCommandFingerprint = fingerprintOf(legacyCommand);
        } else {
          payload = exactObject(parsed, ["schema", "eventId", "actorId", "idempotencyKey", "commandFingerprint", "assignmentId", "kind", "outcome"], "The approval receipt is malformed.");
          if (payload.schema !== "speaker-content-approval-receipt/v2" || payload.assignmentId !== task.assignment_id) throw new Error("receipt assignment");
          expectedCommandFingerprint = commandFingerprint;
        }
      } catch {
        throw new SpeakerOperationsConflictError("The approval receipt is malformed.");
      }
      if (receipt.workspace_id !== scope.workspaceId || receipt.event_type !== "speaker.content.approved"
        || receipt.aggregate_type !== "speaker_task" || receipt.aggregate_id !== input.taskId
        || receipt.id !== deterministicUuid(`speaker-content-approval-receipt:${scope.workspaceId}:${scope.eventId}:${scope.actorId}:${idempotencyKey}`)
        || (payload.schema !== "speaker-content-approval-receipt/v1" && payload.schema !== "speaker-content-approval-receipt/v2") || payload.eventId !== scope.eventId
        || payload.actorId !== scope.actorId || payload.idempotencyKey !== idempotencyKey
        || payload.kind !== task.content_kind || payload.commandFingerprint !== expectedCommandFingerprint) {
        throw new SpeakerOperationsConflictError("The idempotency key was reused with different approval content.");
      }
      const version = db.prepare(
        `SELECT id, content_hash, payload_json, submitted_by_kind, source FROM speaker_content_versions
         WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ? AND kind = ? AND content_hash = ?`,
      ).get(input.submissionVersionId, scope.workspaceId, scope.eventId, input.personId, input.taskId, task.content_kind, input.submissionContentHash) as { id: string; content_hash: string; payload_json: string; submitted_by_kind: string; source: string } | undefined;
      if (!version) throw new SpeakerOperationsConflictError("The idempotency key was reused with different approval content.");
      const latest = db.prepare(
        `SELECT id FROM speaker_content_versions
         WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ? AND kind = ?
         ORDER BY version DESC, id DESC LIMIT 1`,
      ).get(scope.workspaceId, scope.eventId, input.personId, input.taskId, task.content_kind) as { id: string } | undefined;
      if (!latest || latest.id !== version.id) throw new SpeakerOperationsConflictError("Only the latest exact submission version may be approved.");
      try {
        const content = validateContentPayload(JSON.parse(version.payload_json));
        if (content.kind !== task.content_kind || version.submitted_by_kind !== "speaker" || version.source !== "local-artifact-store") throw new Error("invalid durable artifact content");
      } catch {
        throw new SpeakerOperationsConflictError("Durable speaker content is inconsistent.");
      }
      const approvalRow = db.prepare(
        `SELECT id, workspace_id, event_id, person_id, task_id, submission_version_id,
                submission_content_hash, reviewed_by, reviewed_at, gate
         FROM speaker_content_reviews
         WHERE workspace_id = ? AND submission_version_id = ? AND review_state = 'APPROVED' AND gate = ?`,
      ).get(scope.workspaceId, version.id, gate) as {
        id: string; workspace_id: string; event_id: string; person_id: string; task_id: string;
        submission_version_id: string; submission_content_hash: string; reviewed_by: string; reviewed_at: string; gate: ContentApproval["gate"];
      } | undefined;
      if (!approvalRow || approvalRow.workspace_id !== scope.workspaceId || approvalRow.event_id !== scope.eventId
        || approvalRow.person_id !== input.personId || approvalRow.task_id !== input.taskId
        || approvalRow.submission_version_id !== input.submissionVersionId || approvalRow.submission_content_hash !== input.submissionContentHash
        || approvalRow.reviewed_by !== scope.actorId || approvalRow.gate !== gate) {
        throw new SpeakerOperationsConflictError("The approval receipt has no matching durable approval.");
      }
      const persistedApproval: ContentApproval = Object.freeze({
        id: approvalRow.id, workspaceId: approvalRow.workspace_id, eventId: approvalRow.event_id,
        personId: approvalRow.person_id, taskId: approvalRow.task_id, submissionVersionId: approvalRow.submission_version_id,
        submissionContentHash: approvalRow.submission_content_hash, approvedBy: approvalRow.reviewed_by,
        approvedAt: approvalRow.reviewed_at, gate: approvalRow.gate,
      });
      exactApprovalOutcome(payload.outcome, persistedApproval);
      if (receipt.created_at !== persistedApproval.approvedAt) throw new SpeakerOperationsConflictError("The approval receipt timestamp is divergent.");
      return persistedApproval;
    }
  }
  const version = db.prepare(
    `SELECT id, workspace_id, event_id, person_id, task_id, kind, version,
            payload_json, content_hash, submitted_at, submitted_by, submitted_by_kind, source
     FROM speaker_content_versions
     WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ?
       AND kind = ? AND content_hash = ?`,
  ).get(
    input.submissionVersionId,
    scope.workspaceId,
    scope.eventId,
    input.personId,
    input.taskId,
    task.content_kind,
    input.submissionContentHash,
  ) as {
    id: string;
    workspace_id: string;
    event_id: string;
    person_id: string;
    task_id: string;
    kind: ContentKind;
    version: number;
    payload_json: string;
    content_hash: string;
    submitted_at: string;
    submitted_by: string;
    submitted_by_kind: string;
    source: string;
  } | undefined;
  if (!version) throw new SpeakerOperationsAuthorizationError("The requested submission version is not in the authorized event projection.");
  const latest = db.prepare(
    `SELECT id FROM speaker_content_versions
     WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ? AND kind = ?
     ORDER BY version DESC, id DESC LIMIT 1`,
  ).get(scope.workspaceId, scope.eventId, input.personId, input.taskId, task.content_kind) as { id: string } | undefined;
  if (!latest || latest.id !== version.id) throw new SpeakerOperationsConflictError("Only the latest exact submission version may be approved.");
  try {
    const payload = validateContentPayload(JSON.parse(version.payload_json));
    if (payload.kind !== task.content_kind || version.submitted_by_kind !== "speaker" || version.source !== "local-artifact-store") throw new Error("invalid durable artifact content");
  } catch {
    throw new SpeakerOperationsConflictError("Durable speaker content is inconsistent.");
  }

  const approval: ContentApproval = Object.freeze({
    id: deterministicUuid(`content-approval:${scope.workspaceId}:${scope.eventId}:${version.id}:${gate}`),
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    personId: input.personId,
    taskId: input.taskId,
    submissionVersionId: version.id,
    submissionContentHash: version.content_hash,
    approvedBy: scope.actorId,
    approvedAt: clock(),
    gate,
  });
  const persistedApproval = withTransactionOrSavepoint(db, "speaker_content_approval_write", () => {
    const currentTask = db.prepare(
      `SELECT person_id, assignment_id, task_kind, content_kind, owner
       FROM speaker_tasks
       WHERE id = ? AND workspace_id = ? AND event_id = ?`,
    ).get(input.taskId, scope.workspaceId, scope.eventId) as {
      person_id: string;
      assignment_id: string;
      task_kind: string;
      content_kind: string;
      owner: string;
    } | undefined;
    const currentAssignment = canonicalSpeakerAssignment(db, scope.workspaceId, scope.eventId, input.personId);
    if (
      !currentTask ||
      currentTask.person_id !== input.personId ||
      currentTask.assignment_id !== task.assignment_id ||
      !currentAssignment || currentTask.assignment_id !== currentAssignment.assignmentId ||
      currentTask.task_kind !== currentTask.content_kind ||
      currentTask.content_kind !== task.content_kind ||
      currentTask.owner !== "SPEAKER"
    ) {
      throw new SpeakerOperationsAuthorizationError("Speaker content authority is no longer current.");
    }
    const existing = db.prepare(
      `SELECT id, workspace_id, event_id, person_id, task_id, submission_version_id,
              submission_content_hash, reviewed_by, reviewed_at, gate
       FROM speaker_content_reviews
       WHERE workspace_id = ? AND submission_version_id = ? AND review_state = 'APPROVED' AND gate = ?`,
    ).get(scope.workspaceId, version.id, gate) as {
      id: string;
      workspace_id: string;
      event_id: string;
      person_id: string;
      task_id: string;
      submission_version_id: string;
      submission_content_hash: string;
      reviewed_by: string;
      reviewed_at: string;
      gate: ContentApproval["gate"];
    } | undefined;
    if (existing) {
      const existingActor = db.prepare(
        "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
      ).get(scope.workspaceId, existing.reviewed_by) as { role: string } | undefined;
      if (!existingActor || !roleHasCapability(existingActor.role, "phase0.pipeline.manage")) {
        throw new SpeakerOperationsConflictError("Durable approval evidence has no persisted organizer capability.");
      }
      return Object.freeze({
        id: existing.id,
        workspaceId: existing.workspace_id,
        eventId: existing.event_id,
        personId: existing.person_id,
        taskId: existing.task_id,
        submissionVersionId: existing.submission_version_id,
        submissionContentHash: existing.submission_content_hash,
        approvedBy: existing.reviewed_by,
        approvedAt: existing.reviewed_at,
        gate: existing.gate,
      });
    }
    const concurrent = db.prepare(
      `SELECT id FROM speaker_content_reviews
       WHERE workspace_id = ? AND submission_version_id = ? AND review_state = 'APPROVED' AND gate = ?`,
    ).get(scope.workspaceId, version.id, gate) as { id: string } | undefined;
    if (concurrent) return approval;
    db.prepare(
      `INSERT INTO speaker_content_reviews
         (id, workspace_id, event_id, person_id, task_id, submission_version_id,
          submission_content_hash, review_state, gate, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?)`,
    ).run(
      approval.id,
      approval.workspaceId,
      approval.eventId,
      approval.personId,
      approval.taskId,
      approval.submissionVersionId,
      approval.submissionContentHash,
      approval.gate,
      approval.approvedBy,
      approval.approvedAt,
    );
    writeAudit(db, scope.workspaceId, {
      actorKind: "account",
      actorRef: approval.approvedBy,
      action: "speaker.content.approved",
      targetType: "speaker_content_review",
      targetId: approval.id,
      details: {
        schema: "speaker-content-approval-authority/v1",
        assignmentId: currentTask.assignment_id,
        reviewState: "APPROVED",
        gate: approval.gate,
        submissionVersionId: approval.submissionVersionId,
        submissionContentHash: approval.submissionContentHash,
        capability: "phase0.pipeline.manage",
      },
    });
    if (idempotencyKey) {
      const receiptPayload = {
        schema: "speaker-content-approval-receipt/v2",
        eventId: scope.eventId,
        actorId: scope.actorId,
        idempotencyKey,
        commandFingerprint,
        assignmentId: currentTask.assignment_id,
        kind: task.content_kind,
        outcome: approval,
      };
      db.prepare(
        `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id, payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, 'speaker.content.approved', 'speaker_task', ?, ?, ?, ?)`,
      ).run(
        deterministicUuid(`speaker-content-approval-receipt:${scope.workspaceId}:${scope.eventId}:${scope.actorId}:${idempotencyKey}`),
        scope.workspaceId,
        input.taskId,
        canonicalJson(receiptPayload),
        fingerprintOf(receiptPayload),
        approval.approvedAt,
      );
    }
    return approval;
  });
  return persistedApproval;
  });
}

function contentStateToTaskState(review: ContentReviewProjection): SpeakerTaskState {
  switch (review.latestReviewState) {
    case "APPROVED": return "COMPLETED";
    case "CHANGES_REQUESTED": return "CHANGES_REQUESTED";
    case "BLOCKED": return "BLOCKED";
    case "SUBMITTED":
    case "IN_REVIEW": return "SUBMITTED";
    case "SUPERSEDED":
    case "NOT_SUBMITTED": return "NOT_STARTED";
  }
}

function dueState(taskState: SpeakerTaskState, dueAt: string, asOf: string): SpeakerTaskProjection["dueState"] {
  if (taskState === "COMPLETED") return "COMPLETE";
  const remaining = Date.parse(dueAt) - Date.parse(asOf);
  if (remaining < 0) return "OVERDUE";
  if (remaining <= 7 * 24 * 60 * 60 * 1000) return "DUE_SOON";
  return "UPCOMING";
}

function profileFromReview(base: ProfileBase, review: ContentReviewProjection): SpeakerProfileProjection {
  const approved = [...review.versions].reverse().find((version) => version.reviewState === "APPROVED");
  const current = approved?.payload.kind === "PROFILE" ? approved.payload : null;
  const publicSnapshot: SpeakerProfileSnapshot = {
    ...(current ?? { bio: base.bio, publicTitle: base.publicTitle, organization: base.organization, socialLinks: base.socialLinks, headshot: base.headshot }),
    sourceVersionId: approved?.id ?? base.sourceVersionId,
    sourceContentHash: approved?.contentHash ?? base.sourceContentHash,
  };
  const latest = review.versions.at(-1);
  return {
    workspaceProfile: publicSnapshot,
    eventOverride: publicSnapshot,
    pendingRevision: latest && latest.reviewState !== "APPROVED" ? { versionId: latest.id, contentHash: latest.contentHash, reviewState: latest.reviewState } : null,
    publicSnapshotIsUnchanged: latest?.reviewState !== "APPROVED",
  };
}

/** Build a finite source-backed readiness aggregate for the existing deterministic evaluator. */
function readinessFacts(
  workspaceId: string,
  state: State,
  personId: string,
  assignment: AssignmentStateRecord,
  invitation: InvitationStateRecord,
  profileReview: ContentReviewProjection,
  asOf: string,
): SpeakerReadinessFacts {
  const organizerId = organizerIdFor(workspaceId);
  const sourceMap = new Map<string, SpeakerSourceRecord>();
  const sourceRef = (type: string, id: string, fingerprint = fingerprintOf({ workspaceId, eventId: state.event.id, type, id })): SpeakerSourceRef => ({ type, id, fingerprint });
  const addSource = (ref: SpeakerSourceRef, options: Partial<Pick<SpeakerSourceRecord, "current" | "supersededById" | "supersededAt" | "occurredAt">> = {}): void => {
    const prior = sourceMap.get(`${ref.type}:${ref.id}`);
    if (prior && prior.fingerprint !== ref.fingerprint) throw new SpeakerOperationsConflictError("Synthetic readiness source binding collided.");
    sourceMap.set(`${ref.type}:${ref.id}`, {
      ...ref,
      current: options.current ?? true,
      supersededById: options.supersededById ?? null,
      quarantined: false,
      occurredAt: options.occurredAt ?? "2026-08-12T12:00:00.000Z",
      supersededAt: options.supersededAt ?? null,
    });
  };
  const selection = sourceRef("SELECTION", `selection:${state.event.id}`);
  const role = sourceRef("ROLE", assignment.assignmentId);
  const offer = sourceRef("OFFER", invitation.commitmentOfferId, invitation.termsFingerprint);
  const commitment = sourceRef("COMMITMENT", invitation.response?.id ?? `commitment:${invitation.commitmentOfferId}`);
  const requirement = sourceRef("REQUIREMENT", `profile-requirement:${assignment.assignmentId}`);
  const schedule = sourceRef("SCHEDULE", `schedule:${assignment.assignmentId}`);
  const publication = sourceRef("PUBLICATION", `publication:${assignment.assignmentId}`);
  addSource(selection);
  addSource(role);
  addSource(offer);
  addSource(commitment);
  addSource(requirement);
  addSource(schedule);
  addSource(publication);

  const submissionFacts: SpeakerSubmissionFact[] = [];
  const versionSourceRefs = profileReview.versions.map((version, index) => {
    const next = profileReview.versions[index + 1];
    const ref = sourceRef("SUBMISSION", version.id, version.contentHash);
    const occurredAt = version.submittedAt;
    addSource(ref, {
      current: next === undefined,
      supersededById: next?.id ?? null,
      supersededAt: next?.submittedAt ?? null,
      occurredAt,
    });
    const artifact = sourceRef("ARTIFACT", `artifact:${version.id}`, fingerprintOf({ version: version.id, content: version.contentHash }));
    addSource(artifact, { occurredAt });
    submissionFacts.push({
      id: version.id,
      fingerprint: version.contentHash,
      requirementId: requirement.id,
      version: version.version,
      supersedesSubmissionId: version.supersedesVersionId,
      kind: "PROFILE_SNAPSHOT",
      sourceRecords: [artifact],
      current: next === undefined,
      quarantined: false,
      occurredAt,
    });
  });
  void versionSourceRefs;

  const approvals = [...profileReview.approvals].filter((approval) => approval.submissionVersionId === profileReview.latestVersionId);
  const decisions: SpeakerRequirementDecisionFact[] = [];
  const authorities: SpeakerAuthorityFact[] = [];
  if (approvals.length > 0 && profileReview.versions.at(-1)) {
    const approval = approvals.at(-1)!;
    const decision = sourceRef("REQUIREMENT_DECISION", approval.id, fingerprintOf(approval));
    const authorityEvidence = sourceRef("AUDIT", `audit:${approval.id}`, fingerprintOf({ approval: approval.id, actor: approval.approvedBy }));
    const authorityRef = sourceRef("AUTHORITY", `authority:${approval.id}`, fingerprintOf({ approval: approval.id, authority: organizerId }));
    addSource(decision, { occurredAt: approval.approvedAt });
    addSource(authorityEvidence, { occurredAt: approval.approvedAt });
    addSource(authorityRef, { occurredAt: approval.approvedAt });
    authorities.push({
      id: authorityRef.id,
      fingerprint: authorityRef.fingerprint,
      accountId: organizerId,
      allowedActions: ["APPROVE_REQUIREMENT"],
      subjectKind: "DECISION",
      subjectId: decision.id,
      subjectFingerprint: decision.fingerprint,
      workspaceId,
      eventId: state.event.id,
      validFrom: approval.approvedAt,
      validTo: null,
      current: true,
      supersededById: null,
      supersededAt: null,
      sourceRecords: [authorityEvidence],
    });
    decisions.push({
      id: decision.id,
      fingerprint: decision.fingerprint,
      requirementId: requirement.id,
      kind: "APPROVE_VERSION",
      submissionId: approval.submissionVersionId,
      current: true,
      sourceRecords: [decision],
      occurredAt: approval.approvedAt,
      decidedByAccountId: organizerId,
      authorityRecords: [authorityRef],
    });
  }

  const findings: SpeakerFindingFact[] = [];
  for (const finding of profileReview.findings) {
    const findingRef = sourceRef("EDITORIAL", finding.id, fingerprintOf(finding));
    addSource(findingRef, { occurredAt: finding.createdAt });
    findings.push({
      id: finding.id,
      fingerprint: findingRef.fingerprint,
      submissionId: finding.submissionVersionId,
      submissionFingerprint: finding.submissionContentHash,
      severity: finding.severity,
      blocksGateTargets: finding.blocksReadiness ? ["CONFIRMATION", "PUBLICATION", "OPERATOR_RELEASE"] : [],
      current: true,
      supersededById: null,
      supersededAt: null,
      sourceRecords: [findingRef],
      occurredAt: finding.createdAt,
      requirementId: requirement.id,
    });
  }

  const selectionFact = { id: selection.id, fingerprint: selection.fingerprint, status: "SELECTED" as const, current: true, supersededById: null, occurredAt: "2026-08-12T12:00:00.000Z", supersededAt: null };
  const roleFact: SpeakerRoleFact = { id: role.id, fingerprint: role.fingerprint, personId, applicable: true, sourceRecords: [role], occurredAt: "2026-08-12T12:00:00.000Z" };
  const offerFact: SpeakerOfferFact = { id: offer.id, fingerprint: offer.fingerprint, selectionDecisionId: selection.id, selectionDecisionFingerprint: selection.fingerprint, personId, speakerRoleId: role.id, termsFingerprint: invitation.termsFingerprint, current: true, sourceRecords: [offer], occurredAt: "2026-08-12T12:00:00.000Z", supersededById: null, supersededAt: null };
  const commitmentFact: SpeakerCommitmentFact = { id: commitment.id, fingerprint: commitment.fingerprint, offerId: offer.id, offerFingerprint: offer.fingerprint, state: invitation.response?.state === "ACCEPTED" ? "ACCEPTED" : "PENDING", current: true, sourceRecords: [commitment], occurredAt: invitation.respondedAt ?? "2026-08-12T12:00:00.000Z", supersededById: null, supersededAt: null };
  const requirementFact: SpeakerRequirementFact = { id: requirement.id, fingerprint: requirement.fingerprint, gateTargets: ["CONFIRMATION", "SCHEDULING", "PUBLICATION", "OPERATOR_RELEASE"], required: true, waivable: false, submissions: submissionFacts, decisions, waivers: [], sourceRecords: [requirement], occurredAt: "2026-08-12T12:00:00.000Z" };
  const scheduleFact: SpeakerScheduleFact = { id: schedule.id, fingerprint: schedule.fingerprint, speakerRoleId: role.id, state: "APPROVED", current: true, sourceRecords: [schedule], occurredAt: "2026-08-12T12:00:00.000Z", supersededById: null, supersededAt: null };
  const publicationFact = { id: publication.id, fingerprint: publication.fingerprint, speakerRoleId: role.id, state: "APPROVED" as const, current: true, sourceRecords: [publication], occurredAt: "2026-08-12T12:00:00.000Z", supersededById: null, supersededAt: null };
  return {
    workspaceId,
    eventId: state.event.id,
    asOf,
    locale: "en-US",
    selection: selectionFact,
    selectedSpeakerRoles: [roleFact],
    applicableRequirements: [requirement],
    conditions: [],
    offers: [offerFact],
    commitments: [commitmentFact],
    requirements: [requirementFact],
    findings,
    schedules: [scheduleFact],
    publications: [publicationFact],
    sourceRecords: [...sourceMap.values()],
    authorities,
  };
}

export class InMemorySpeakerOperationsRepository implements SpeakerOperationsRepository {
  readonly schema = SPEAKER_OPERATIONS_SCHEMA;
  readonly content: ContentOperationsRepository;
  private readonly states = new Map<string, State>();
  private readonly tokenHashes = new Map<string, TokenStateRecord>();
  private readonly operationIdempotency = new Map<string, { readonly fingerprint: string; readonly result: unknown }>();
  private readonly portalOperationIdempotency = new Map<string, { readonly fingerprint: string; readonly result: unknown }>();
  private readonly clock: Clock;
  private readonly defaultEventInitialization: SpeakerEventInitialization;
  private readonly db: Db | null;

  constructor(options: { readonly db?: Db; readonly content?: ContentOperationsRepository; readonly clock?: Clock; readonly defaultEventInitialization?: SpeakerEventInitialization } = {}) {
    this.clock = options.clock ?? createMonotonicClock();
    this.defaultEventInitialization = options.defaultEventInitialization ?? { kind: "ordinary" };
    this.db = options.db ?? null;
    this.content = options.content ?? (this.db
      ? createDurableContentOperationsRepository(this.db, { clock: this.clock })
      : createSyntheticContentOperationsRepository({ clock: this.clock }));
  }

  initializeEvent(workspaceId: string, event: SpeakerEventContext, initialization: SpeakerEventInitialization): void {
    boundedId(workspaceId, "workspaceId");
    boundedId(event.id, "eventId");
    if (initialization.kind !== "ordinary" && initialization.kind !== "evaluator-demo") fail("Event initialization is unsupported.");
    const key = scopeKey(workspaceId, event.id);
    const existing = this.states.get(key);
    if (existing) {
      if (existing.eventInitialization.kind !== initialization.kind) {
        if (existing.eventInitialization.kind === "ordinary" && initialization.kind === "evaluator-demo" && this.stateIsEmpty(existing)) {
          this.states.delete(key);
        } else {
          throw new SpeakerOperationsConflictError("Speaker event initialization conflicts with existing event state.");
        }
      }
      if (this.states.get(key)) {
        return;
      }
    }
    this.ensureState(workspaceId, event, initialization, false);
  }

  getOrganizerProjection(scope: SpeakerOrganizerScope, event: SpeakerEventContext, filter?: SpeakerRosterFilter): SpeakerOrganizerProjection {
    assertOrganizerScope(scope, event);
    const state = this.ensureState(scope.workspaceId, event);
    const roster = this.listSpeakerRosterFromState(scope.workspaceId, state, filter);
    const matrix = roster.map((record) => this.matrixRow(record));
    const asOf = this.clock();
    const projection: SpeakerOrganizerProjection = {
      schema: SPEAKER_OPERATIONS_SCHEMA,
      access: { kind: "organizer", workspaceId: scope.workspaceId, eventId: event.id, actorId: scope.actorId },
      event: clone(event),
      asOf,
      roster,
      dashboard: {
        rosterCount: roster.length,
        acceptedCommitmentCount: roster.filter((record) => record.assignment.commitment.state === "ACCEPTED").length,
        awaitingResponseCount: roster.filter((record) => record.assignment.commitment.state === "PENDING").length,
        overdueTaskCount: roster.reduce((count, record) => count + record.tasks.filter((task) => task.dueState === "OVERDUE").length, 0),
        readinessBlockerCount: roster.reduce((count, record) => count + record.readiness.gates.filter((gate) => !gate.eligible).length, 0),
        submittedContentCount: roster.reduce((count, record) => count + record.tasks.filter((task) => task.submissionVersionId !== null).length, 0),
      },
      readinessMatrix: matrix,
      lastCsvImport: state.csvImportReceipts.at(-1) ?? null,
      download: { format: "text/csv", rowCount: matrix.length, metadataOnly: true, suggestedFileName: "speaker-readiness.synthetic.csv" },
      communicationsBoundary: "simulated-local-delivery-evidence-only",
      fileBoundary: "authenticated-scoped-artifact-downloads",
    };
    return deepFreeze(clone(projection));
  }

  listSpeakerRoster(scope: SpeakerOrganizerScope, event: SpeakerEventContext, filter?: SpeakerRosterFilter): readonly SpeakerRosterRecord[] {
    assertOrganizerScope(scope, event);
    return this.listSpeakerRosterFromState(scope.workspaceId, this.ensureState(scope.workspaceId, event), filter);
  }

  resolvePortalToken(token: string, lookupBudgetKey?: string): SpeakerPortalTokenProjection | null {
    if (this.db) {
      const durable = resolveSpeakerPortalToken(this.db, token, { now: this.clock(), lookupBudgetKey });
      if (!durable) return null;
      const tokenHash = sha256Hex(token);
      const record: TokenStateRecord = { ...durable, tokenHash };
      this.tokenHashes.set(tokenHash, record);
      this.ensureState(durable.workspaceId, this.eventFor(durable));
      return this.publicTokenProjection(record);
    }
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const tokenHash = sha256Hex(token);
    const record = this.tokenHashes.get(tokenHash);
    if (!record) {
      const registered = SYNTHETIC_TOKEN_REGISTRY.get(tokenHash);
      if (registered) {
        const initialization = this.defaultEventInitialization.kind === "evaluator-demo"
          ? this.defaultEventInitialization
          : speakerEventInitializationFor(registered.workspaceId, registered.eventId);
        const shouldInitialize = initialization.kind === "evaluator-demo";
        if (shouldInitialize) {
          this.initializeEvent(registered.workspaceId, this.eventFor(registered), initialization);
        }
        const state = this.states.get(scopeKey(registered.workspaceId, registered.eventId));
        const registeredRecord = state?.tokens.get(tokenHash);
        if (!registeredRecord) return null;
        this.tokenHashes.set(tokenHash, registeredRecord);
        return this.publicTokenProjection(registeredRecord);
      }
      if (this.defaultEventInitialization.kind === "evaluator-demo") for (const seed of SYNTHETIC_PEOPLE) {
        // A token can be resolved without a preceding organizer request because the token is
        // purpose-bound and the deterministic fixture has no external identity lookup.
        const eventId = "synthetic-event";
        const workspaceId = "synthetic-workspace";
        const personId = personIdFor(workspaceId, seed.alias);
        const candidate = syntheticSpeakerPortalToken(workspaceId, eventId, personId);
        if (sha256Hex(candidate) === tokenHash) {
          this.initializeEvent(workspaceId, this.eventFor({ workspaceId, eventId }), this.defaultEventInitialization);
          const state = this.states.get(scopeKey(workspaceId, eventId));
          const fallback = state?.tokens.get(tokenHash);
          if (!fallback) return null;
          this.tokenHashes.set(tokenHash, fallback);
          return this.publicTokenProjection(fallback);
        }
      }
      return null;
    }
    const active = record.revokedAt === null && Date.parse(record.expiresAt) > Date.parse(this.clock());
    return this.publicTokenProjection({ ...record, active });
  }

  getPortalProjection(token: string, lookupBudgetKey?: string): SpeakerPortalProjection | null {
    const access = this.resolvePortalToken(token, lookupBudgetKey ?? (this.db ? undefined : SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY));
    if (!access || !access.active) return null;
    return this.portalProjectionForAccess(access);
  }

  getPortalProjectionForResolvedAccess(token: string, access: SpeakerPortalTokenProjection): SpeakerPortalProjection | null {
    return this.portalProjectionForAccess(this.assertResolvedAccess(token, access));
  }

  private portalProjectionForAccess(access: SpeakerPortalTokenProjection): SpeakerPortalProjection | null {
    const event = this.eventFor(access);
    const state = this.ensureState(access.workspaceId, event);
    const assignment = state.assignments.get(access.assignmentId);
    const invitation = assignment ? [...state.invitations.values()].find((candidate) => candidate.personId === access.personId && candidate.commitmentOfferId === assignment.offerId) : undefined;
    const person = state.people.get(access.personId);
    if (!assignment || assignment.personId !== access.personId || assignment.sourcePlanVersionId !== access.planVersionId || !invitation || !person) return null;
    return this.portalProjection(access, state, person, assignment, invitation);
  }

  respondToInvitation(token: string, invitationId: string, response: Extract<CommitmentState, "ACCEPTED" | "DECLINED">, lookupBudgetKey?: string): RespondToInvitationResult {
    const access = this.authorizedPortal(token, lookupBudgetKey);
    boundedId(invitationId, "invitationId");
    if (response !== "ACCEPTED" && response !== "DECLINED") fail("Invitation response is unsupported.");
    const state = this.ensureState(access.workspaceId, this.eventFor(access));
    const invitation = state.invitations.get(invitationId);
    if (!invitation || invitation.personId !== access.personId) throw new SpeakerOperationsAuthorizationError("Invitation is not available in this speaker portal.");
    if (invitation.response) {
      if (invitation.response.state !== response) throw new SpeakerOperationsConflictError("An invitation already has a different recorded response.");
      const portal = this.portalProjectionForAccess(access);
      if (!portal) throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
      return { response: clone(invitation.response), portal, created: false };
    }
    if (!["SENT", "DELIVERED", "OPENED"].includes(invitation.state)) throw new SpeakerOperationsConflictError("This invitation is not open for a response.");
    const respondedAt = this.clock();
    const responseRecord: SpeakerInvitationResponseProjection = {
      id: deterministicUuid(`speaker-response:${invitation.id}:${response}`),
      offerId: invitation.commitmentOfferId,
      offerTermsFingerprint: invitation.termsFingerprint,
      state: response,
      respondedAt,
      commandFingerprint: commitmentResponseCommandKey(invitation.commitmentOfferId, response === "ACCEPTED" ? "accepted" : "declined"),
    };
    state.invitations.set(invitation.id, { ...invitation, state: "RESPONDED", respondedAt, response: responseRecord });
    const portal = this.portalProjectionForAccess(access);
    if (!portal) throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
    return { response: clone(responseRecord), portal, created: true };
  }

  completeTask(token: string, taskId: string, input: CompleteSpeakerTaskInput = {}, lookupBudgetKey?: string): CompleteSpeakerTaskResult {
    const access = this.authorizedPortal(token, lookupBudgetKey);
    boundedId(taskId, "taskId");
    if (input.note !== undefined) text(input.note, "task note", 1000);
    const state = this.ensureState(access.workspaceId, this.eventFor(access));
    let task = state.tasks.get(taskId);
    if (!task || task.personId !== access.personId) throw new SpeakerOperationsAuthorizationError("Task is not available in this speaker portal.");
    if (task.contentKind !== null) throw new SpeakerOperationsConflictError("This task completes only from an exact content submission version.");
    const idempotencyKey = optionalOperationKey(input.idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "complete-task", workspaceId: access.workspaceId, eventId: access.eventId, personId: access.personId, taskId, note: input.note ?? "" });
    if (task.kind === "ACTION") {
      if (!this.db) throw new SpeakerOperationsConflictError("Shared ACTION tasks require the durable local database.");
      if (this.db.isTransaction) throw new SpeakerOperationsConflictError("ACTION task completion must own its transaction boundary.");
      const committed = withTransaction(this.db, () => {
        const currentAccess = this.assertResolvedAccess(token, access);
        const binding = sharedActionDefinitionForTask(this.db!, currentAccess.workspaceId, currentAccess.eventId, taskId);
        if (binding.assignment.personId !== currentAccess.personId) {
          throw new SpeakerOperationsAuthorizationError("Task is not available in this speaker portal.");
        }
        const currentAssignment = canonicalSpeakerAssignment(
          this.db!, currentAccess.workspaceId, currentAccess.eventId, currentAccess.personId,
        );
        if (!currentAssignment || currentAssignment.assignmentId !== binding.assignment.assignmentId) {
          throw new SpeakerOperationsAuthorizationError("This ACTION task is no longer bound to a current accepted speaker assignment.");
        }
        const replay = priorDurableSpeakerTaskOperation(
          this.db!, currentAccess.workspaceId, currentAccess.eventId, currentAccess.personId,
          idempotencyKey, fingerprint, "complete-task",
        );
        const durableTask = sharedActionTaskState(this.db!, binding.definition, binding.assignment);
        if (replay || durableTask.state === "COMPLETED") return { task: durableTask, created: false } as const;
        const occurredAt = this.clock();
        const transition: SpeakerTaskTransition = {
          id: deterministicUuid(`speaker-task-transition:${durableTask.id}:${durableTask.transitions.length + 1}:completed`),
          from: durableTask.state,
          to: "COMPLETED",
          occurredAt,
          actorId: currentAccess.personId,
          evidenceVersionId: null,
        };
        const completedTask: TaskStateRecord = {
          ...durableTask,
          state: "COMPLETED",
          transitions: [...durableTask.transitions, transition],
        };
        appendSpeakerOperationEvent(this.db!, "speaker.task.updated", currentAccess.workspaceId, "speaker_task", durableTask.id, {
          schema: SPEAKER_OPERATION_EVENT_SCHEMA,
          operation: "complete-task",
          workspaceId: currentAccess.workspaceId,
          eventId: currentAccess.eventId,
          actorId: currentAccess.personId,
          personId: currentAccess.personId,
          taskId: durableTask.id,
          idempotencyKey,
          requestFingerprint: fingerprint,
          note: input.note ?? null,
          task: completedTask,
        }, occurredAt);
        writeAudit(this.db!, currentAccess.workspaceId, {
          actorKind: "person",
          actorRef: currentAccess.personId,
          action: "speaker.action-task.completed",
          targetType: "speaker_task",
          targetId: durableTask.id,
          details: {
            eventId: currentAccess.eventId,
            definitionId: binding.definition.definitionId,
            assignmentId: durableTask.assignmentId,
            transitionId: transition.id,
            noteProvided: input.note !== undefined,
          },
        });
        return { task: completedTask, created: true } as const;
      });
      state.tasks.set(committed.task.id, committed.task);
      const portal = this.portalProjectionForAccess(access);
      if (!portal) throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
      const result = {
        task: portal.tasks.find((candidate) => candidate.id === committed.task.id)!,
        portal,
        created: committed.created,
      };
      this.rememberPortalOperation(access, idempotencyKey, fingerprint, result);
      return result;
    }
    const prior = this.portalOperationResult<CompleteSpeakerTaskResult>(access, idempotencyKey, fingerprint);
    if (prior) return prior;
    if (this.db) {
      const durablePrior = priorDurableSpeakerTaskOperation(this.db, access.workspaceId, access.eventId, access.personId, idempotencyKey, fingerprint, "complete-task");
      if (durablePrior) {
        state.tasks.set(durablePrior.id, durablePrior);
        task = durablePrior;
      }
    }
    if (task.state === "COMPLETED") {
      const portal = this.portalProjectionForAccess(access);
      if (!portal) throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
      const result = { task: portal.tasks.find((candidate) => candidate.id === task.id)!, portal, created: false };
      this.rememberPortalOperation(access, idempotencyKey, fingerprint, result);
      return result;
    }
    const occurredAt = this.clock();
    const transition: SpeakerTaskTransition = { id: deterministicUuid(`speaker-task-transition:${task.id}:completed`), from: task.state, to: "COMPLETED", occurredAt, actorId: access.personId, evidenceVersionId: null };
    const completedTask: TaskStateRecord = { ...task, state: "COMPLETED", transitions: [...task.transitions, transition] };
    if (this.db) {
      const appendCompletion = (): string => appendSpeakerOperationEvent(this.db!, "speaker.task.updated", access.workspaceId, "speaker_task", task.id, {
        schema: SPEAKER_OPERATION_EVENT_SCHEMA,
        operation: "complete-task",
        workspaceId: access.workspaceId,
        eventId: access.eventId,
        actorId: access.personId,
        personId: access.personId,
        taskId: task.id,
        idempotencyKey,
        requestFingerprint: fingerprint,
        note: input.note ?? null,
        task: completedTask,
      }, occurredAt);
      appendCompletion();
    }
    state.tasks.set(task.id, completedTask);
    const portal = this.portalProjectionForAccess(access);
    if (!portal) throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
    const result = { task: portal.tasks.find((candidate) => candidate.id === task.id)!, portal, created: true };
    this.rememberPortalOperation(access, idempotencyKey, fingerprint, result);
    return result;
  }

  submitContent(token: string, taskId: string, payload: unknown, idempotencyKey?: string, lookupBudgetKey?: string): SubmitSpeakerContentResult {
    return this.submitContentWithRollback(token, taskId, payload, idempotencyKey, lookupBudgetKey).result;
  }

  submitContentWithRollback(
    token: string,
    taskId: string,
    payload: unknown,
    idempotencyKey?: string,
    lookupBudgetKey?: string,
  ): { readonly result: SubmitSpeakerContentResult; readonly rollback: () => void } {
    const access = this.authorizedPortal(token, lookupBudgetKey);
    return this.submitContentWithAccess(access, taskId, payload, idempotencyKey);
  }

  submitContentWithRollbackForResolvedAccess(
    token: string,
    access: SpeakerPortalTokenProjection,
    taskId: string,
    payload: unknown,
    idempotencyKey?: string,
  ): { readonly result: SubmitSpeakerContentResult; readonly rollback: () => void } {
    return this.submitContentWithAccess(this.assertResolvedAccess(token, access), taskId, payload, idempotencyKey);
  }

  private submitContentWithAccess(
    access: TokenStateRecord,
    taskId: string,
    payload: unknown,
    idempotencyKey?: string,
  ): { readonly result: SubmitSpeakerContentResult; readonly rollback: () => void } {
    boundedId(taskId, "taskId");
    const state = this.ensureState(access.workspaceId, this.eventFor(access));
    const task = state.tasks.get(taskId);
    if (!task || task.personId !== access.personId || task.contentKind === null) throw new SpeakerOperationsAuthorizationError("Content task is not available in this speaker portal.");
    const submissionScope = contentScope({ ...access, actorId: access.personId, actorKind: "speaker" });
    const priorReview = this.content.getReviewProjection(submissionScope, {
      personId: access.personId,
      taskId,
      kind: task.contentKind,
    });
    const priorLogistics = state.logistics.get(access.personId);
    const priorTask = state.tasks.get(taskId);
    let version: ContentSubmissionVersion | null = null;
    let created = false;
    let rolledBack = false;

    const restore = (): void => {
      if (priorLogistics) state.logistics.set(access.personId, priorLogistics);
      else state.logistics.delete(access.personId);
      if (priorTask) state.tasks.set(taskId, priorTask);
      else state.tasks.delete(taskId);
    };
    const rollback = (): void => {
      if (rolledBack) return;
      if (created && version) rollbackUnpublishedContentVersion(this.content, version);
      restore();
      rolledBack = true;
    };

    try {
      version = this.content.submitVersion(submissionScope, { personId: access.personId, taskId, payload, idempotencyKey });
      created = version.id !== priorReview.latestVersionId;
      this.applySubmittedVersion(state, version);
      const portal = this.portalProjectionForAccess(access);
      if (!portal) throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
      const updatedTask = portal.tasks.find((candidate) => candidate.id === taskId);
      if (!updatedTask) throw new SpeakerOperationsConflictError("Submitted content task projection was not rebuilt.");
      return { result: { version, task: updatedTask, portal }, rollback };
    } catch (error) {
      rollback();
      throw error;
    }
  }

  updateProfile(token: string, input: { readonly bio: string; readonly publicTitle: string; readonly organization: string; readonly socialLinks: readonly SocialLink[]; readonly headshot: unknown; readonly idempotencyKey?: string }, lookupBudgetKey?: string): SubmitSpeakerContentResult {
    const access = this.authorizedPortal(token, lookupBudgetKey);
    const state = this.ensureState(access.workspaceId, this.eventFor(access));
    const task = [...state.tasks.values()].find((candidate) => candidate.personId === access.personId && isCanonicalProfileTask(candidate));
    if (!task) throw new SpeakerOperationsConflictError("Speaker profile task is not configured.");
    return this.submitContentWithAccess(access, task.id, { kind: "PROFILE", bio: input.bio, publicTitle: input.publicTitle, organization: input.organization, socialLinks: input.socialLinks, headshot: input.headshot }, input.idempotencyKey).result;
  }

  submitOrganizerContent(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly payload: unknown; readonly idempotencyKey?: string }): ContentSubmissionVersion {
    const state = this.organizerState(scope);
    const task = this.organizerTask(state, input.personId, input.taskId);
    if (task.contentKind === null) throw new SpeakerOperationsConflictError("This task does not accept a content version.");
    if (contentKindOf(input.payload) !== task.contentKind) throw new SpeakerOperationsConflictError("Content kind does not match the assigned task.");
    const version = this.content.submitVersion(contentScope(scope), input);
    this.applySubmittedVersion(state, version);
    return version;
  }

  restoreContent(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly idempotencyKey?: string }): ContentSubmissionVersion {
    const state = this.organizerState(scope);
    const task = this.organizerTask(state, input.personId, input.taskId);
    if (task.contentKind === null) throw new SpeakerOperationsConflictError("This task does not accept a content version.");
    const version = this.content.restoreVersion(contentScope(scope), input);
    this.applySubmittedVersion(state, version);
    return version;
  }

  createTask(scope: SpeakerOrganizerScope, input: CreateSpeakerTaskInput): SpeakerTaskProjection {
    if (!isValidSpeakerTaskContentPair(input.kind, input.contentKind)) fail("task kind and content kind pairing is unsupported.");
    if (input.kind === "ACTION") throw new SpeakerOperationsConflictError("ACTION tasks must use the atomic shared-assignment command.");
    const personId = boundedId(input.personId, "personId");
    if (typeof input.required !== "boolean") fail("task required flag is invalid.");
    if (input.owner !== "SPEAKER" && input.owner !== "ORGANIZER") fail("task owner is unsupported.");
    if (input.gate !== null && !["CONFIRMATION", "PUBLICATION", "OPERATOR_RELEASE"].includes(input.gate)) fail("task gate is unsupported.");
    const title = text(input.title, "task title", 240);
    const description = text(input.description, "task description", 1200);
    const dueAt = instant(input.dueAt, "task dueAt");
    const idempotencyKey = optionalOperationKey(input.idempotencyKey);
    const normalizedInput = {
      personId,
      kind: input.kind,
      contentKind: input.contentKind,
      title,
      description,
      required: input.required,
      gate: input.gate,
      dueAt,
      owner: input.owner,
      idempotencyKey: input.idempotencyKey,
    } satisfies CreateSpeakerTaskInput;
    const fingerprint = fingerprintOf({ operation: "create-task", scope, input: normalizedInput });
    const prior = this.operationResult<SpeakerTaskProjection>(scope, idempotencyKey, fingerprint);
    if (prior) return prior;
    if (this.db) {
      const db = this.db;
      const committed = withTransactionOrSavepoint(db, "speaker_task_create", () => {
        const state = this.organizerState(scope);
        if (!state.people.has(personId)) throw new SpeakerOperationsAuthorizationError("Task assignee is not in the authorized event roster.");
        const durablePrior = priorDurableSpeakerTaskOperation(db, scope.workspaceId, scope.eventId, scope.actorId, idempotencyKey, fingerprint, "create-task");
        if (durablePrior) return { state, task: durablePrior };
        const assignment = [...state.assignments.values()].find((candidate) => candidate.personId === personId);
        if (!assignment) throw new SpeakerOperationsAuthorizationError("Task assignee has no authorized speaker assignment.");
        if (
          input.kind === "PROFILE" &&
          ([...state.tasks.values()].some((candidate) => candidate.personId === personId && isCanonicalProfileTask(candidate)) ||
            durableCanonicalProfileTask(db, scope.workspaceId, scope.eventId, personId) !== null)
        ) throw new SpeakerOperationsConflictError("An active profile task is already configured for this speaker.");
        const id = deterministicUuid(`speaker-task:${scope.workspaceId}:${scope.eventId}:${personId}:custom:${fingerprint}`);
        const task: TaskStateRecord = { id, personId, assignmentId: assignment.assignmentId, kind: input.kind, contentKind: input.contentKind, title, description, required: input.required, gate: input.gate, dueAt, owner: input.owner, state: "NOT_STARTED", transitions: [] };
        appendSpeakerOperationEvent(db, "speaker.task.created", scope.workspaceId, "speaker_task", id, {
          schema: SPEAKER_OPERATION_EVENT_SCHEMA,
          operation: "create-task",
          workspaceId: scope.workspaceId,
          eventId: scope.eventId,
          actorId: scope.actorId,
          personId,
          taskId: id,
          idempotencyKey,
          requestFingerprint: fingerprint,
          task,
        }, this.clock());
        return { state, task };
      });
      committed.state.tasks.set(committed.task.id, committed.task);
      const projection = this.taskProjectionForScope(committed.state, committed.task, scope.workspaceId, this.clock());
      this.rememberOperation(scope, idempotencyKey, fingerprint, projection);
      return projection;
    }
    const state = this.organizerState(scope);
    if (!state.people.has(personId)) throw new SpeakerOperationsAuthorizationError("Task assignee is not in the authorized event roster.");
    const assignment = [...state.assignments.values()].find((candidate) => candidate.personId === personId);
    if (!assignment) throw new SpeakerOperationsAuthorizationError("Task assignee has no authorized speaker assignment.");
    if (input.kind === "PROFILE" && [...state.tasks.values()].some((candidate) => candidate.personId === personId && isCanonicalProfileTask(candidate))) {
      throw new SpeakerOperationsConflictError("An active profile task is already configured for this speaker.");
    }
    const id = deterministicUuid(`speaker-task:${scope.workspaceId}:${scope.eventId}:${personId}:custom:${state.tasks.size + 1}`);
    const task: TaskStateRecord = { id, personId, assignmentId: assignment.assignmentId, kind: input.kind, contentKind: input.contentKind, title, description, required: input.required, gate: input.gate, dueAt, owner: input.owner, state: "NOT_STARTED", transitions: [] };
    state.tasks.set(id, task);
    const projection = this.taskProjectionForScope(state, task, scope.workspaceId, this.clock());
    this.rememberOperation(scope, idempotencyKey, fingerprint, projection);
    return projection;
  }

  createSharedActionTask(scope: SpeakerOrganizerScope, input: CreateSharedActionTaskInput): SharedActionTaskReceipt {
    if (!this.db) throw new SpeakerOperationsConflictError("Shared ACTION tasks require the durable local database.");
    const db = this.db;
    if (db.isTransaction) throw new SpeakerOperationsConflictError("Shared ACTION task creation must own its transaction boundary.");
    const normalized = normalizeSharedActionTaskInput(input);
    const requestFingerprint = sharedActionRequestFingerprint(scope, normalized);
    const result = withTransaction(db, () => {
      const event = requirePersistedActionTaskOrganizer(db, scope);
      const currentAssignments = normalized.assigneePersonIds.map((personId) => {
        const assignment = canonicalSpeakerAssignment(db, scope.workspaceId, scope.eventId, personId);
        if (!assignment) throw new SpeakerOperationsAuthorizationError("Every ACTION task assignee must be a current accepted speaker for this event.");
        return { personId, assignmentId: assignment.assignmentId };
      });
      const existingRows = db.prepare(
        `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
                payload_json, payload_fingerprint, created_at
           FROM domain_events
          WHERE workspace_id = ? AND event_type = ? AND aggregate_type = ?
            AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.eventId') END = ?
            AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.actorId') END = ?
            AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.idempotencyKey') END = ?
          ORDER BY created_at, id`,
      ).all(
        scope.workspaceId,
        SHARED_ACTION_TASK_EVENT_TYPE,
        SHARED_ACTION_TASK_AGGREGATE_TYPE,
        scope.eventId,
        scope.actorId,
        normalized.idempotencyKey,
      ) as unknown as SharedActionDefinitionEventRow[];
      if (existingRows.length > 1) throw new SpeakerOperationsConflictError("Multiple shared ACTION tasks use the same idempotency key.");
      if (existingRows.length === 1) {
        const definition = parseSharedActionDefinition(existingRows[0]!);
        if (definition.requestFingerprint !== requestFingerprint) {
          throw new SpeakerOperationsConflictError("The shared ACTION task idempotency key was reused with different content.");
        }
        if (definition.assignments.some((assignment, index) => assignment.assignmentId !== currentAssignments[index]?.assignmentId)) {
          throw new SpeakerOperationsAuthorizationError("A shared ACTION task assignee is no longer bound to the same current assignment.");
        }
        return { event, definition, tasks: definition.assignments.map((assignment) => sharedActionTaskState(db, definition, assignment)), created: false };
      }

      const createdAt = this.clock();
      assertNewSharedActionDueDate(normalized, createdAt);
      const definitionId = sharedActionDefinitionId(scope, normalized.idempotencyKey);
      const assignments = currentAssignments.map(({ personId, assignmentId }) => ({
        taskId: deterministicUuid(`speaker-shared-action-task-assignment:${definitionId}:${personId}`),
        personId,
        assignmentId,
      } satisfies StoredSharedActionAssignment));
      const definition: StoredSharedActionDefinition = deepFreeze({
        schema: SHARED_ACTION_TASK_SCHEMA,
        operation: "create-shared-action-task",
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        actorId: scope.actorId,
        definitionId,
        idempotencyKey: normalized.idempotencyKey,
        requestFingerprint,
        kind: "ACTION",
        title: normalized.title,
        instructions: normalized.instructions,
        dueDate: normalized.dueDate,
        dueAt: normalized.dueAt,
        assignments,
        createdAt,
      });
      const payloadJson = canonicalJson(definition);
      const payloadFingerprint = fingerprintOf(definition);
      const domainEventId = deterministicUuid(`speaker-shared-action-task-event:${definitionId}`);
      db.prepare(
        `INSERT INTO domain_events
           (id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        domainEventId,
        scope.workspaceId,
        SHARED_ACTION_TASK_EVENT_TYPE,
        SHARED_ACTION_TASK_AGGREGATE_TYPE,
        definitionId,
        payloadJson,
        payloadFingerprint,
        createdAt,
      );
      const tasks = assignments.map((assignment) => {
        const task: TaskStateRecord = {
          id: assignment.taskId,
          personId: assignment.personId,
          assignmentId: assignment.assignmentId,
          kind: "ACTION",
          contentKind: null,
          title: definition.title,
          description: definition.instructions,
          required: true,
          gate: null,
          dueAt: definition.dueAt,
          owner: "SPEAKER",
          state: "NOT_STARTED",
          transitions: [],
        };
        appendSpeakerOperationEvent(db, "speaker.task.created", scope.workspaceId, "speaker_task", task.id, {
          schema: SPEAKER_OPERATION_EVENT_SCHEMA,
          operation: "create-task",
          workspaceId: scope.workspaceId,
          eventId: scope.eventId,
          actorId: scope.actorId,
          personId: task.personId,
          taskId: task.id,
          idempotencyKey: deterministicUuid(`shared-action-create:${definitionId}:${task.personId}`),
          requestFingerprint: fingerprintOf({ requestFingerprint, taskId: task.id, assignmentId: task.assignmentId }),
          sharedActionDefinitionId: definitionId,
          sharedActionRequestFingerprint: requestFingerprint,
          task,
        }, createdAt);
        return task;
      });
      writeAudit(db, scope.workspaceId, {
        actorKind: "account",
        actorRef: scope.actorId,
        action: "speaker.action-task.batch.created",
        targetType: "speaker_action_task",
        targetId: definitionId,
        details: {
          eventId: scope.eventId,
          requestFingerprint,
          dueDate: definition.dueDate,
          assigneePersonIds: assignments.map((assignment) => assignment.personId),
          assignmentIds: assignments.map((assignment) => assignment.assignmentId),
          taskIds: assignments.map((assignment) => assignment.taskId),
        },
      });
      return { event, definition, tasks, created: true };
    });

    const state = this.ensureState(scope.workspaceId, result.event);
    for (const task of result.tasks) state.tasks.set(task.id, task);
    const projection = projectSharedActionDefinition(db, result.definition);
    return deepFreeze({ ...projection, receiptSchema: SHARED_ACTION_TASK_RECEIPT_SCHEMA, created: result.created });
  }

  listSharedActionTaskAssignees(scope: SpeakerOrganizerScope): readonly SharedActionTaskAssigneeProjection[] {
    if (!this.db) throw new SpeakerOperationsConflictError("Shared ACTION tasks require the durable local database.");
    return withTransactionOrSavepoint(this.db, "shared_action_assignee_list", () => {
      requirePersistedActionTaskOrganizer(this.db!, scope);
      const rows = this.db!.prepare(
        `SELECT DISTINCT person.id AS personId, person.full_name AS fullName
           FROM event_speakers event_speaker
           JOIN people person ON person.workspace_id = event_speaker.workspace_id
            AND person.id = event_speaker.person_id
          WHERE event_speaker.workspace_id = ? AND event_speaker.event_id = ?
            AND event_speaker.role_key IN ('SPEAKER', 'MODERATOR')
            AND event_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')
          ORDER BY person.full_name, person.id
          LIMIT ?`,
      ).all(scope.workspaceId, scope.eventId, SHARED_ACTION_TASK_MAX_SELECTABLE_SPEAKERS + 1) as unknown as Array<{
        readonly personId: unknown;
        readonly fullName: unknown;
      }>;
      if (rows.length > SHARED_ACTION_TASK_MAX_SELECTABLE_SPEAKERS) {
        throw new SpeakerOperationsConflictError("The current ACTION task speaker selector exceeds its bounded projection.");
      }
      const assignees = rows.flatMap((row): SharedActionTaskAssigneeProjection[] => {
        if (typeof row.personId !== "string") throw new SpeakerOperationsConflictError("The current ACTION task Person is invalid.");
        const assignment = canonicalSpeakerAssignment(this.db!, scope.workspaceId, scope.eventId, row.personId);
        if (!assignment) return [];
        const fullName = storedSharedActionValue(
          () => sharedActionText(row.fullName, "speaker name", 240),
          "The current ACTION task speaker name is invalid.",
        );
        return [{ personId: row.personId, fullName, role: assignment.role, assignmentId: assignment.assignmentId }];
      });
      return deepFreeze(assignees);
    });
  }

  listSharedActionTasks(scope: SpeakerOrganizerScope): readonly SharedActionTaskBatchProjection[] {
    if (!this.db) throw new SpeakerOperationsConflictError("Shared ACTION tasks require the durable local database.");
    return withTransactionOrSavepoint(this.db, "shared_action_task_list", () => {
      requirePersistedActionTaskOrganizer(this.db!, scope);
      return deepFreeze(sharedActionDefinitionRows(this.db!, scope.workspaceId, scope.eventId)
        .map(parseSharedActionDefinition)
        .map((definition) => projectSharedActionDefinition(this.db!, definition)));
    });
  }

  queueDueActionTaskReminders(scope: SpeakerOrganizerScope): SharedActionTaskReminderReceipt {
    if (!this.db) throw new SpeakerOperationsConflictError("ACTION task reminders require the durable local database.");
    const db = this.db;
    if (db.isTransaction) throw new SpeakerOperationsConflictError("ACTION task reminder queueing must own its transaction boundary.");
    const triggeredAt = this.clock();
    return withTransaction(db, () => {
      const event = requirePersistedActionTaskOrganizer(db, scope);
      return queueDueActionTaskRemindersInTransaction(db, scope, event, triggeredAt, {
        kind: "account",
        ref: scope.actorId,
      });
    });
  }

  listActionTaskReminderDeliveries(scope: SpeakerOrganizerScope): readonly SharedActionTaskReminderDelivery[] {
    if (!this.db) throw new SpeakerOperationsConflictError("ACTION task reminders require the durable local database.");
    return withTransactionOrSavepoint(this.db, "shared_action_reminder_list", () => {
      requirePersistedActionTaskOrganizer(this.db!, scope);
      return deepFreeze(actionReminderRows(this.db!, scope.workspaceId, scope.eventId)
        .map((row) => parseActionReminderRow(this.db!, row)));
    });
  }

  updateWorkflowStatus(
    scope: SpeakerOrganizerScope,
    personId: string,
    input: UpdateSpeakerWorkflowStatusInput,
  ): UpdateSpeakerWorkflowStatusResult {
    const state = this.organizerState(scope);
    boundedId(personId, "personId");
    const normalizedStatus = workflowStatus(input.status);
    const expectedCurrentStatus = workflowStatus(input.expectedCurrentStatus);
    const expectedVersion = input.expectedVersion === null ? null : boundedId(input.expectedVersion, "expectedVersion");
    const normalizedIdempotencyKey = text(input.idempotencyKey, "idempotencyKey", 240);
    const person = state.people.get(personId);
    const assignment = [...state.assignments.values()].find((candidate) => candidate.personId === personId);
    if (!person || !assignment) throw new SpeakerOperationsAuthorizationError("Workflow status is not available in the authorized event projection.");
    const fingerprint = fingerprintOf({
      operation: "update-workflow-status",
      scope,
      personId,
      status: normalizedStatus,
      expectedCurrentStatus,
      expectedVersion,
      idempotencyKey: normalizedIdempotencyKey,
    });
    const prior = this.operationResult<UpdateSpeakerWorkflowStatusResult>(scope, normalizedIdempotencyKey, fingerprint);
    if (prior) {
      if (this.db) {
        const current = withTransactionOrSavepoint(this.db, "speaker_workflow_status_replay", () => currentDurableWorkflowStatus(this.db!, scope.workspaceId, scope.eventId, personId));
        if (current) state.workflowStatuses.set(personId, current);
      }
      return { ...prior, created: false };
    }
    if (this.db) {
      const committed = withTransactionOrSavepoint(this.db, "speaker_workflow_status_update", () => {
        const durablePrior = priorDurableWorkflowStatus(
          this.db!,
          scope.workspaceId,
          scope.eventId,
          personId,
          scope.actorId,
          normalizedIdempotencyKey,
          fingerprint,
        );
        if (durablePrior) {
          const current = currentDurableWorkflowStatus(this.db!, scope.workspaceId, scope.eventId, personId);
          if (!current) throw new SpeakerOperationsConflictError("The durable speaker workflow status receipt has no current history.");
          return { result: { status: durablePrior.status, version: durablePrior.eventId, created: false } satisfies UpdateSpeakerWorkflowStatusResult, current };
        }
        const current = currentDurableWorkflowStatus(this.db!, scope.workspaceId, scope.eventId, personId);
        const previousStatus = current?.status ?? "NEW";
        const currentVersion = current?.eventId ?? null;
        const currentAssignment = canonicalSpeakerAssignment(this.db!, scope.workspaceId, scope.eventId, personId);
        if (!currentAssignment || currentAssignment.assignmentId !== assignment.assignmentId) {
          throw new SpeakerOperationsAuthorizationError("Workflow status is no longer bound to the current accepted speaker assignment.");
        }
        if (previousStatus !== expectedCurrentStatus || currentVersion !== expectedVersion) {
          throw new SpeakerOperationsConflictError("The speaker workflow status was changed from this rendered version; reload before editing.");
        }
        if (previousStatus === normalizedStatus) {
          return { result: { status: normalizedStatus, version: currentVersion, created: false } satisfies UpdateSpeakerWorkflowStatusResult, current };
        }
        const occurredAt = this.clock();
        const payload = {
          schema: SPEAKER_OPERATION_EVENT_SCHEMA,
          operation: "update-workflow-status",
          workspaceId: scope.workspaceId,
          eventId: scope.eventId,
          actorId: scope.actorId,
          personId,
          status: normalizedStatus,
          previousStatus,
          expectedCurrentStatus,
          expectedVersion,
          idempotencyKey: normalizedIdempotencyKey,
          requestFingerprint: fingerprint,
        };
        const eventId = appendSpeakerOperationEvent(this.db!, "speaker.workflow.status.updated", scope.workspaceId, "event_speaker", personId, payload, occurredAt);
        writeAudit(this.db!, scope.workspaceId, {
          actorKind: "account",
          actorRef: scope.actorId,
          action: "speaker.workflow.status.updated",
          targetType: "event_speaker",
          targetId: personId,
          details: { eventId: scope.eventId, from: previousStatus, to: normalizedStatus, version: eventId, expectedVersion },
        });
        return {
          result: { status: normalizedStatus, version: eventId, created: true } satisfies UpdateSpeakerWorkflowStatusResult,
          current: {
            personId,
            eventId,
            status: normalizedStatus,
            previousStatus,
            expectedCurrentStatus,
            expectedVersion,
            occurredAt,
            actorId: scope.actorId,
            idempotencyKey: normalizedIdempotencyKey,
            requestFingerprint: fingerprint,
          },
        };
      });
      if (committed.current) state.workflowStatuses.set(personId, committed.current);
      else state.workflowStatuses.delete(personId);
      this.rememberOperation(scope, normalizedIdempotencyKey, fingerprint, committed.result);
      return committed.result;
    }
    const current = state.workflowStatuses.get(personId);
    const previousStatus = current?.status ?? "NEW";
    const currentVersion = current?.eventId ?? null;
    if (previousStatus !== expectedCurrentStatus || currentVersion !== expectedVersion) {
      throw new SpeakerOperationsConflictError("The speaker workflow status was changed from this rendered version; reload before editing.");
    }
    if (previousStatus === normalizedStatus) {
      const result = { status: normalizedStatus, version: currentVersion, created: false } satisfies UpdateSpeakerWorkflowStatusResult;
      this.rememberOperation(scope, normalizedIdempotencyKey, fingerprint, result);
      return result;
    }
    const occurredAt = this.clock();
    const eventId = deterministicUuid(`synthetic-speaker-workflow-status:${scope.workspaceId}:${scope.eventId}:${personId}:${fingerprint}`);
    const record: WorkflowStatusStateRecord = {
      eventId,
      status: normalizedStatus,
      previousStatus,
      expectedCurrentStatus,
      expectedVersion,
      occurredAt,
      actorId: scope.actorId,
      idempotencyKey: normalizedIdempotencyKey,
      requestFingerprint: fingerprint,
    };
    state.workflowStatuses.set(personId, record);
    const result = { status: normalizedStatus, version: eventId, created: true } satisfies UpdateSpeakerWorkflowStatusResult;
    this.rememberOperation(scope, normalizedIdempotencyKey, fingerprint, result);
    void person;
    return result;
  }

  updateTask(scope: SpeakerOrganizerScope, taskId: string, input: UpdateSpeakerTaskInput): SpeakerTaskProjection {
    const state = this.organizerState(scope);
    boundedId(taskId, "taskId");
    const task = state.tasks.get(taskId);
    if (!task) throw new SpeakerOperationsAuthorizationError("Task is not available in the authorized event projection.");
    const assignment = state.assignments.get(task.assignmentId);
    if (!assignment || assignment.personId !== task.personId) throw new SpeakerOperationsAuthorizationError("Task is not available in the authorized event projection.");
    const nextDueAt = input.dueAt === undefined ? task.dueAt : instant(input.dueAt, "task dueAt");
    const nextState = input.state === undefined ? undefined : taskState(input.state);
    if (input.note !== undefined) text(input.note, "task note", 1000);
    if (task.kind === "ACTION") {
      if (input.dueAt !== undefined && nextDueAt !== task.dueAt) {
        throw new SpeakerOperationsConflictError("Shared ACTION task definitions, including the due date, are immutable.");
      }
      if (!this.db) throw new SpeakerOperationsConflictError("Shared ACTION tasks require the durable local database.");
      if (this.db.isTransaction) throw new SpeakerOperationsConflictError("ACTION task status updates must own their transaction boundary.");
    }
    if (task.contentKind !== null && nextState !== undefined) throw new SpeakerOperationsConflictError("Content task state follows its exact submission review; edit the deadline or review the version instead.");
    const idempotencyKey = optionalOperationKey(input.idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "update-task", scope, taskId, input: { ...input, dueAt: nextDueAt, state: nextState } });
    if (task.kind === "ACTION") {
      const committed = withTransaction(this.db!, () => {
        requirePersistedActionTaskOrganizer(this.db!, scope);
        const binding = sharedActionDefinitionForTask(this.db!, scope.workspaceId, scope.eventId, task.id);
        const currentAssignment = canonicalSpeakerAssignment(this.db!, scope.workspaceId, scope.eventId, binding.assignment.personId);
        if (!currentAssignment || currentAssignment.assignmentId !== binding.assignment.assignmentId) {
          throw new SpeakerOperationsAuthorizationError("This ACTION task is no longer bound to a current accepted speaker assignment.");
        }
        const replay = priorDurableSpeakerTaskOperation(
          this.db!, scope.workspaceId, scope.eventId, scope.actorId,
          idempotencyKey, fingerprint, "update-task",
        );
        const durableTask = sharedActionTaskState(this.db!, binding.definition, binding.assignment);
        if (input.dueAt !== undefined && nextDueAt !== durableTask.dueAt) {
          throw new SpeakerOperationsConflictError("Shared ACTION task definitions, including the due date, are immutable.");
        }
        if (replay) return durableTask;
        const occurredAt = this.clock();
        const transitions = nextState !== undefined && nextState !== durableTask.state
          ? [...durableTask.transitions, {
              id: deterministicUuid(`speaker-task-transition:${durableTask.id}:${durableTask.transitions.length + 1}:${nextState}`),
              from: durableTask.state,
              to: nextState,
              occurredAt,
              actorId: scope.actorId,
              evidenceVersionId: null,
            } satisfies SpeakerTaskTransition]
          : durableTask.transitions;
        const updated: TaskStateRecord = {
          ...durableTask,
          state: nextState ?? durableTask.state,
          transitions,
        };
        appendSpeakerOperationEvent(this.db!, "speaker.task.updated", scope.workspaceId, "speaker_task", durableTask.id, {
          schema: SPEAKER_OPERATION_EVENT_SCHEMA,
          operation: "update-task",
          workspaceId: scope.workspaceId,
          eventId: scope.eventId,
          actorId: scope.actorId,
          personId: durableTask.personId,
          taskId: durableTask.id,
          idempotencyKey,
          requestFingerprint: fingerprint,
          note: input.note ?? null,
          task: updated,
        }, occurredAt);
        writeAudit(this.db!, scope.workspaceId, {
          actorKind: "account",
          actorRef: scope.actorId,
          action: "speaker.action-task.status.updated",
          targetType: "speaker_task",
          targetId: durableTask.id,
          details: {
            eventId: scope.eventId,
            definitionId: binding.definition.definitionId,
            assignmentId: durableTask.assignmentId,
            from: durableTask.state,
            to: updated.state,
            noteProvided: input.note !== undefined,
          },
        });
        return updated;
      });
      state.tasks.set(committed.id, committed);
      const projection = this.taskProjectionForScope(state, committed, scope.workspaceId, this.clock());
      this.rememberOperation(scope, idempotencyKey, fingerprint, projection);
      return projection;
    }
    const prior = this.operationResult<SpeakerTaskProjection>(scope, idempotencyKey, fingerprint);
    if (prior) return prior;
    if (this.db) {
      const durablePrior = priorDurableSpeakerTaskOperation(this.db, scope.workspaceId, scope.eventId, scope.actorId, idempotencyKey, fingerprint, "update-task");
      if (durablePrior) {
        state.tasks.set(durablePrior.id, durablePrior);
        return this.taskProjectionForScope(state, durablePrior, scope.workspaceId, this.clock());
      }
      if ((task.contentKind === "HEADSHOT" || task.contentKind === "SLIDES") && this.db.prepare("SELECT 1 FROM speaker_tasks WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ?").get(task.id, scope.workspaceId, scope.eventId, task.personId)) {
        if (input.dueAt !== undefined) throw new SpeakerOperationsConflictError("Durable artifact task definitions are immutable.");
      }
    }
    const transitions = nextState !== undefined && nextState !== task.state
      ? [...task.transitions, { id: deterministicUuid(`speaker-task-transition:${task.id}:${task.transitions.length + 1}:${nextState}`), from: task.state, to: nextState, occurredAt: this.clock(), actorId: scope.actorId, evidenceVersionId: null } satisfies SpeakerTaskTransition]
      : task.transitions;
    const updated: TaskStateRecord = { ...task, dueAt: nextDueAt, state: nextState ?? task.state, transitions };
    if (this.db) {
      const appendUpdate = (): string => appendSpeakerOperationEvent(this.db!, "speaker.task.updated", scope.workspaceId, "speaker_task", task.id, {
        schema: SPEAKER_OPERATION_EVENT_SCHEMA,
        operation: "update-task",
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        actorId: scope.actorId,
        personId: task.personId,
        taskId: task.id,
        idempotencyKey,
        requestFingerprint: fingerprint,
        note: input.note ?? null,
        task: updated,
      }, this.clock());
      appendUpdate();
    }
    state.tasks.set(task.id, updated);
    const projection = this.taskProjectionForScope(state, updated, scope.workspaceId, this.clock());
    this.rememberOperation(scope, idempotencyKey, fingerprint, projection);
    return projection;
  }

  sendInvitation(scope: SpeakerOrganizerScope, personId: string, idempotencyKey?: string): SpeakerCommunicationEvidence {
    const state = this.organizerState(scope);
    boundedId(personId, "personId");
    const person = state.people.get(personId);
    const assignment = [...state.assignments.values()].find((candidate) => candidate.personId === personId);
    const invitation = assignment ? [...state.invitations.values()].find((candidate) => candidate.personId === personId && candidate.commitmentOfferId === assignment.offerId) : undefined;
    if (!person || !assignment || !invitation) throw new SpeakerOperationsAuthorizationError("Speaker is not available in the authorized event projection.");
    if (invitation.state === "CANCELED" || invitation.state === "EXPIRED") throw new SpeakerOperationsConflictError("This invitation can no longer be sent.");
    const operationKey = optionalOperationKey(idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "send-invitation", scope, personId, invitationId: invitation.id, termsFingerprint: invitation.termsFingerprint });
    const prior = this.operationResult<SpeakerCommunicationEvidence>(scope, operationKey, fingerprint);
    if (prior) return prior;
    const occurredAt = this.clock();
    const evidence: SpeakerCommunicationEvidence = deepFreeze({
      id: deterministicUuid(`speaker-communication:${scope.workspaceId}:${scope.eventId}:${invitation.id}:invitation:${this.communicationList(state, invitation.id).length + 1}`),
      eventId: state.event.id,
      invitationId: invitation.id,
      kind: "INVITATION",
      channel: "in-app-simulation",
      deliveryState: "SIMULATED_DELIVERED",
      simulated: true,
      occurredAt,
      templateKey: "speaker-invitation-v1",
      renderedPreview: `Invitation for ${person.fullName}: ${invitation.offeredTerms.role} · ${invitation.offeredTerms.programUnitName} · ${invitation.offeredTerms.startsAt} (${invitation.offeredTerms.timezone})`,
      payloadFingerprint: invitation.termsFingerprint,
      recipientPersonId: personId,
      commitmentStateIsSeparate: true,
    });
    state.communications.set(invitation.id, [...this.communicationList(state, invitation.id), evidence]);
    const nextState = invitation.state === "DRAFT" || invitation.state === "READY" ? "SENT" : invitation.state;
    state.invitations.set(invitation.id, { ...invitation, state: nextState, deliveredAt: occurredAt });
    this.rememberOperation(scope, operationKey, fingerprint, evidence);
    return clone(evidence);
  }

  sendReminder(scope: SpeakerOrganizerScope, personIds: readonly string[], idempotencyKey?: string): readonly SpeakerCommunicationEvidence[] {
    const state = this.organizerState(scope);
    if (!Array.isArray(personIds) || personIds.length < 1 || personIds.length > 100) fail("Reminder recipient selection is invalid.");
    const selectedIds = [...new Set(personIds.map((personId) => boundedId(personId, "personId")))];
    const pending = selectedIds.flatMap((personId) => {
      const record = state.people.get(personId);
      const assignment = [...state.assignments.values()].find((candidate) => candidate.personId === personId);
      const invitation = assignment ? [...state.invitations.values()].find((candidate) => candidate.personId === personId && candidate.commitmentOfferId === assignment.offerId) : undefined;
      if (!record || !assignment || !invitation) throw new SpeakerOperationsAuthorizationError("Reminder recipient is not in the authorized event projection.");
      if (invitation.state === "CANCELED" || invitation.state === "EXPIRED") return [];
      const tasks = [...state.tasks.values()].filter((task) => task.personId === personId).map((task) => this.taskProjectionForScope(state, task, scope.workspaceId, this.clock()));
      const outstanding = tasks.filter((task) => task.kind !== "ACTION" && task.state !== "COMPLETED");
      return outstanding.length > 0 ? [{ personId, record, invitation, outstanding }] : [];
    });
    if (pending.length === 0) throw new SpeakerOperationsConflictError("No selected speaker has incomplete work eligible for a reminder.");
    const operationKey = optionalOperationKey(idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "send-reminder", scope, recipients: pending.map((item) => ({ personId: item.personId, invitationId: item.invitation.id, taskIds: item.outstanding.map((task) => task.id) })) });
    const prior = this.operationResult<readonly SpeakerCommunicationEvidence[]>(scope, operationKey, fingerprint);
    if (prior) return prior;
    const evidence = pending.map(({ personId, record, invitation, outstanding }) => {
      const occurredAt = this.clock();
      return deepFreeze({
        id: deterministicUuid(`speaker-communication:${scope.workspaceId}:${scope.eventId}:${invitation.id}:reminder:${this.communicationList(state, invitation.id).length + 1}`),
        eventId: state.event.id,
        invitationId: invitation.id,
        kind: "REMINDER" as const,
        channel: "in-app-simulation" as const,
        deliveryState: "SIMULATED_DELIVERED" as const,
        simulated: true as const,
        occurredAt,
        templateKey: "speaker-reminder-v1" as const,
        renderedPreview: `Reminder for ${record.fullName}: ${outstanding.slice(0, 3).map((task) => task.title).join(", ")}`,
        payloadFingerprint: fingerprintOf({ invitation: invitation.termsFingerprint, tasks: outstanding.map((task) => task.id) }),
        recipientPersonId: personId,
        commitmentStateIsSeparate: true as const,
      });
    });
    for (const item of evidence) {
      const invitation = state.invitations.get(item.invitationId);
      if (invitation) state.communications.set(item.invitationId, [...this.communicationList(state, item.invitationId), item]);
    }
    this.rememberOperation(scope, operationKey, fingerprint, evidence);
    return clone(evidence);
  }

  addComment(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly body: string; readonly idempotencyKey?: string }): ContentComment {
    const state = this.ensureState(scope.workspaceId, this.eventFor(scope));
    assertOrganizerScope(scope, state.event);
    return this.content.addComment(contentScope(scope), input);
  }

  addFinding(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly severity: "INFO" | "WARNING" | "BLOCKER"; readonly message: string; readonly blocksReadiness?: boolean; readonly idempotencyKey?: string }): ContentFinding {
    const state = this.ensureState(scope.workspaceId, this.eventFor(scope));
    assertOrganizerScope(scope, state.event);
    return this.content.addFinding(contentScope(scope), input);
  }

  requestRevision(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly reason: string; readonly idempotencyKey?: string }): ContentRevisionRequest {
    const state = this.ensureState(scope.workspaceId, this.eventFor(scope));
    assertOrganizerScope(scope, state.event);
    return this.content.requestRevision(contentScope(scope), input);
  }

  approveContent(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly gate?: ContentApproval["gate"]; readonly idempotencyKey?: string }): ContentApproval {
    const state = this.ensureState(scope.workspaceId, this.eventFor(scope));
    assertOrganizerScope(scope, state.event);
    const durable = this.db ? durableArtifactApproval(this.db, scope, input, this.clock) : null;
    if (durable) return durable;
    if (this.db && cachedArtifactKindForApproval(this.content, scope, input)) {
      throw new SpeakerOperationsConflictError("Durable artifact task or version identity is unavailable.");
    }
    return this.content.approveVersion(contentScope(scope), input);
  }

  exportReadinessCsv(scope: SpeakerOrganizerScope, event: SpeakerEventContext, filter?: SpeakerRosterFilter): { readonly fileName: string; readonly contentType: "text/csv"; readonly body: string; readonly rowCount: number } {
    const projection = this.getOrganizerProjection(scope, event, filter);
    const header = ["person_id", "person_name", "role", "assignment_id", "commitment_state", "required_tasks", "completed_required_tasks", "overdue_tasks", "readiness_blockers", "last_activity_at"].join(",");
    const rows = projection.readinessMatrix.map((row) => [row.personId, row.personName, row.role, row.assignmentId, row.commitmentState, row.requiredTaskCount, row.completedRequiredTaskCount, row.overdueTaskCount, row.blockers.join("|"), row.lastActivityAt].map(csvSafeCell).join(","));
    return { fileName: projection.download.suggestedFileName, contentType: "text/csv", body: `${header}\n${rows.join("\n")}\n`, rowCount: rows.length };
  }

  exportContentMetadata(scope: SpeakerOrganizerScope, event: SpeakerEventContext, submissionVersionIds: readonly string[] = []): { readonly fileName: string; readonly contentType: "text/csv"; readonly body: string; readonly rowCount: number; readonly metadataOnly: true } {
    const projection = this.getOrganizerProjection(scope, event);
    const selected = new Set(submissionVersionIds.map((versionId) => boundedId(versionId, "submissionVersionId")));
    const versions = projection.roster.flatMap((record) => record.tasks.flatMap((task) => task.review?.versions.map((version) => ({ record, task, version })) ?? []));
    const chosen = selected.size > 0 ? versions.filter(({ version }) => selected.has(version.id)) : versions;
    const header = ["person_id", "person_name", "task_id", "task_title", "content_kind", "version", "content_hash", "review_state", "file_name", "media_type", "byte_size_metadata", "checksum", "storage_ref", "submitted_by", "submitted_by_kind", "submitted_at", "source", "file_bytes_available"].join(",");
    const rows = chosen.map(({ record, task, version }) => {
      const payload = version.payload;
      const asset = payload.kind === "HEADSHOT" || payload.kind === "SLIDES" ? payload.asset : payload.kind === "PROFILE" ? payload.headshot : null;
      return [record.person.personId, record.person.fullName, task.id, task.title, version.kind, version.version, version.contentHash, version.reviewState, asset?.fileName ?? "", asset?.mediaType ?? "", asset?.byteSize ?? "", asset?.checksum ?? "", asset?.storageRef ?? "", version.submittedBy, version.submittedByKind, version.submittedAt, version.source, "false"].map(csvSafeCell).join(",");
    });
    return { fileName: "speaker-content-metadata.synthetic.csv", contentType: "text/csv", body: `${header}\n${rows.join("\n")}\n`, rowCount: rows.length, metadataOnly: true };
  }

  importSpeakerCsv(scope: SpeakerOrganizerScope, event: SpeakerEventContext, csvText: string, idempotencyKey?: string): SpeakerCsvImportReceipt {
    assertOrganizerScope(scope, event);
    if (this.db) return this.importSpeakerCsvDurable(scope, event, csvText, idempotencyKey);
    const state = this.ensureState(scope.workspaceId, event);
    const parsed = parseSpeakerCsv(csvText);
    const operationKey = optionalOperationKey(idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "speaker-csv-import", scope, event, csvText });
    const prior = this.operationResult<SpeakerCsvImportReceipt>(scope, operationKey, fingerprint);
    if (prior) return prior;

    const rows: SpeakerCsvImportRowReceipt[] = [];
    let createdCount = 0;
    let mergedCount = 0;
    let rejectedCount = 0;
    for (const record of parsed.records) {
      try {
        const row = normalizeSpeakerCsvRow(record, parsed.format);
        const emailMatch = row.emailIdentityKey ? state.identityIndex.get(row.emailIdentityKey) : undefined;
        const nameMatch = state.identityIndex.get(row.nameIdentityKey);
        if (emailMatch && nameMatch && emailMatch !== nameMatch) throw new SpeakerOperationsConflictError(`Row ${record.rowNumber} matches more than one canonical Person.`);
        const existingPersonId = emailMatch ?? nameMatch;
        if (existingPersonId) {
          registerPersonIdentity(state, existingPersonId, row.fullName, row.organization, row.email);
          mergedCount += 1;
          rows.push({ rowNumber: record.rowNumber, status: "MERGED", personId: existingPersonId, detail: "Merged into the existing canonical Person; identity, assignments, and immutable content versions were retained." });
          continue;
        }

        const personId = deterministicUuid(`canonical-person:csv-import:${scope.workspaceId}:${row.primaryIdentityKey}`);
        if (state.people.has(personId)) throw new SpeakerOperationsConflictError(`Row ${record.rowNumber} resolves to an existing Person without an indexed identity.`);
        this.createImportedSpeaker(state, scope.workspaceId, row, personId);
        registerPersonIdentity(state, personId, row.fullName, row.organization, row.email);
        createdCount += 1;
        rows.push({ rowNumber: record.rowNumber, status: "CREATED", personId, detail: "Created a workspace-stable canonical Person with a proposed event-scoped speaker projection; no email was sent." });
      } catch (error) {
        if (!(error instanceof SpeakerOperationsInputError) && !(error instanceof SpeakerOperationsConflictError)) throw error;
        rejectedCount += 1;
        rows.push({ rowNumber: record.rowNumber, status: "REJECTED", personId: null, detail: error.message });
      }
    }

    const receipt: SpeakerCsvImportReceipt = deepFreeze({
      schema: SPEAKER_CSV_IMPORT_SCHEMA,
      receiptId: deterministicUuid(`speaker-csv-import:${scope.workspaceId}:${scope.eventId}:${state.csvImportReceipts.length + 1}`),
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      occurredAt: this.clock(),
      columns: parsed.columns,
      rowCount: parsed.records.length,
      createdCount,
      mergedCount,
      rejectedCount,
      rows,
      emailSent: false,
      fileBytesStored: false,
    });
    state.csvImportReceipts.push(receipt);
    this.rememberOperation(scope, operationKey, fingerprint, receipt);
    return receipt;
  }

  private importSpeakerCsvDurable(scope: SpeakerOrganizerScope, event: SpeakerEventContext, csvText: string, idempotencyKey?: string): SpeakerCsvImportReceipt {
    if (!this.db) throw new SpeakerOperationsConflictError("Durable CSV import is unavailable.");
    const state = this.ensureState(scope.workspaceId, event);
    const parsed = parseSpeakerCsv(csvText);
    const operationKey = optionalOperationKey(idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "speaker-csv-import", scope, event, csvText });
    if (operationKey) {
      const prior = this.db.prepare(
        `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
                payload_json, payload_fingerprint, created_at
           FROM domain_events
          WHERE workspace_id = ? AND event_type = 'speaker.csv.imported'
            AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.eventId') END = ?
            AND json_extract(payload_json, '$.actorId') = ?
            AND json_extract(payload_json, '$.idempotencyKey') = ?
          LIMIT 2`,
      ).all(scope.workspaceId, scope.eventId, scope.actorId, operationKey) as unknown as SpeakerOperationEventRow[];
      if (prior.length > 1) throw new SpeakerOperationsConflictError("Multiple durable CSV imports use the same idempotency key.");
      if (prior.length === 1) {
        const value = withTransactionOrSavepoint(this.db, "speaker_csv_replay", () => validateOrRepairSpeakerOperationEvent(this.db!, prior[0]!));
        if (value.requestFingerprint !== fingerprint || value.operation !== "csv-import") throw new SpeakerOperationsConflictError("The CSV idempotency key was reused with different content.");
        if (value.receipt === null || typeof value.receipt !== "object" || Array.isArray(value.receipt)) throw new SpeakerOperationsConflictError("Durable CSV receipt is malformed.");
        const receipt = value.receipt as Record<string, unknown>;
        if (receipt.schema !== SPEAKER_CSV_IMPORT_SCHEMA || receipt.workspaceId !== scope.workspaceId || receipt.eventId !== scope.eventId || !Array.isArray(receipt.rows)) throw new SpeakerOperationsConflictError("Durable CSV receipt scope is invalid.");
        return clone(receipt as unknown as SpeakerCsvImportReceipt);
      }
    }

    const result = withTransactionOrSavepoint(this.db, "speaker_csv_import", () => {
      const rows: SpeakerCsvImportRowReceipt[] = [];
      const normalizedRows: DurableCsvImportRow[] = [];
      let createdCount = 0;
      let mergedCount = 0;
      let rejectedCount = 0;
      for (const record of parsed.records) {
        try {
          const row = normalizeSpeakerCsvRow(record, parsed.format);
          if (row.email === null) throw new SpeakerOperationsConflictError("Durable canonical identity requires an email address; the row was not saved.");
          if (row.role !== "SPEAKER") throw new SpeakerOperationsConflictError("The durable manual-speaker contract only accepts SPEAKER rows; the moderator row was not saved.");
          const mutation = createManualSpeaker(this.db!, scope, {
            fullName: row.fullName,
            email: row.email,
            title: row.title,
            organization: row.organization,
            bio: row.bio,
            idempotencyKey: `${operationKey ?? fingerprint}:row:${record.rowNumber}`,
          });
          const status = mutation.createdPerson ? "CREATED" : "MERGED";
          if (status === "CREATED") createdCount += 1;
          else mergedCount += 1;
          rows.push({ rowNumber: record.rowNumber, status, personId: mutation.record.personId, detail: status === "CREATED" ? "Created a durable workspace Person and event-scoped speaker source record; no email was sent." : "Merged into the durable canonical Person; identity and source history were retained." });
          normalizedRows.push({ rowNumber: record.rowNumber, status, personId: mutation.record.personId, row });
        } catch (error) {
          if (error instanceof ManualSpeakerAuthorizationError || (error instanceof ManualSpeakerError && error.code === "PERSISTENCE_FAILED")) throw error;
          rejectedCount += 1;
          const detail = error instanceof Error ? error.message : "The CSV row could not be saved.";
          rows.push({ rowNumber: record.rowNumber, status: "REJECTED", personId: null, detail });
          normalizedRows.push({ rowNumber: record.rowNumber, status: "REJECTED", personId: null, row: null });
        }
      }
      const receipt: SpeakerCsvImportReceipt = deepFreeze({
        schema: SPEAKER_CSV_IMPORT_SCHEMA,
        receiptId: deterministicUuid(`speaker-csv-import:${scope.workspaceId}:${scope.eventId}:${state.csvImportReceipts.length + 1}`),
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        occurredAt: this.clock(),
        columns: parsed.columns,
        rowCount: parsed.records.length,
        createdCount,
        mergedCount,
        rejectedCount,
        rows,
        emailSent: false,
        fileBytesStored: false,
      });
      appendSpeakerOperationEvent(this.db!, "speaker.csv.imported", scope.workspaceId, "event", event.id, {
        schema: SPEAKER_OPERATION_EVENT_SCHEMA,
        operation: "csv-import",
        workspaceId: scope.workspaceId,
        eventId: event.id,
        actorId: scope.actorId,
        idempotencyKey: operationKey,
        requestFingerprint: fingerprint,
        receipt,
        normalizedRows,
      }, receipt.occurredAt);
      return { receipt, normalizedRows };
    });
    state.csvImportReceipts.push(result.receipt);
    this.rememberOperation(scope, operationKey, fingerprint, result.receipt);
    return clone(result.receipt);
  }

  private createImportedSpeaker(state: State, workspaceId: string, row: NormalizedSpeakerCsvRow, personId: string, options: { readonly issuePortalToken?: boolean } = {}): void {
    const event = state.event;
    const assignmentId = deterministicUuid(`speaker-assignment:${workspaceId}:${event.id}:${personId}`);
    const programUnitId = deterministicUuid(`speaker-program-unit:${workspaceId}:${event.id}:${personId}`);
    const sourcePlanVersionId = deterministicUuid(`speaker-plan-version:${workspaceId}:${event.id}`);
    const sourcePlanAssignmentId = deterministicUuid(`speaker-plan-assignment:${workspaceId}:${event.id}:${personId}`);
    const assignmentLineageId = `person:${personId}:unit:${programUnitId}:role:${row.role}`;
    const endsAt = new Date(Date.parse(event.startsAt) + 45 * 60 * 1000).toISOString();
    const terms: SpeakerInvitationProjection["offeredTerms"] = {
      schema: "speaker-offer-terms/v1",
      eventId: event.id,
      eventName: event.name,
      timezone: event.timezone,
      role: row.role,
      programUnitId,
      programUnitName: row.programUnitName,
      startsAt: event.startsAt,
      endsAt,
      location: "TBD",
      materialFields: ["role", "programUnitId", "startsAt", "endsAt", "location"],
    };
    const termsFingerprint = fingerprintOf(terms);
    const invitationId = deterministicUuid(`speaker-invitation:${workspaceId}:${event.id}:${personId}`);
    const offerId = deterministicUuid(`speaker-offer:${workspaceId}:${event.id}:${personId}`);
    const deliveryEvidence: SpeakerCommunicationEvidence = {
      id: deterministicUuid(`speaker-delivery:${invitationId}:not-sent`),
      eventId: event.id,
      invitationId,
      kind: "INVITATION",
      channel: "in-app-simulation",
      deliveryState: "NOT_SENT",
      simulated: true,
      occurredAt: this.clock(),
      templateKey: "speaker-invitation-v1",
      renderedPreview: `CSV import staged for ${row.fullName}; no email was sent.`,
      payloadFingerprint: termsFingerprint,
      recipientPersonId: personId,
      commitmentStateIsSeparate: true,
    };
    const assignment: AssignmentStateRecord = {
      assignmentId,
      assignmentLineageId,
      personId,
      programUnitId,
      programUnitName: row.programUnitName,
      role: row.role,
      decision: "PROPOSED",
      sourcePlanVersionId,
      sourcePlanAssignmentId,
      startsAt: event.startsAt,
      endsAt,
      timezone: event.timezone,
      location: "TBD",
      offerId,
    };
    const invitation: InvitationStateRecord = {
      id: invitationId,
      personId,
      invitationType: "CONTENT_AND_ROLE",
      state: "DRAFT",
      sourcePlanVersionId,
      sourcePlanAssignmentId,
      assignmentLineageId,
      commitmentOfferId: offerId,
      offeredTerms: terms,
      termsFingerprint,
      deliveredAt: null,
      respondedAt: null,
      response: null,
      deliveryEvidence,
    };
    state.people.set(personId, { personId, fullName: row.fullName, organization: row.organization, title: row.title, canonicalIdentity: "Person" });
    state.assignments.set(assignmentId, assignment);
    state.invitations.set(invitationId, invitation);
    state.communications.set(invitationId, []);
    const importedProfile = { bio: row.bio, publicTitle: row.title, organization: row.organization, socialLinks: [] as readonly SocialLink[], headshot: null };
    state.profiles.set(personId, { ...importedProfile, sourceVersionId: deterministicUuid(`csv-profile:${workspaceId}:${state.event.id}:${personId}`), sourceContentHash: fingerprintOf(importedProfile) });
    if (options.issuePortalToken !== false) {
      const token = syntheticSpeakerPortalToken(workspaceId, event.id, personId);
      const tokenRecord: TokenStateRecord = { tokenHash: sha256Hex(token), purpose: SPEAKER_PORTAL_PURPOSE, workspaceId, eventId: event.id, personId, ...syntheticPortalAuthority(workspaceId, event.id, personId, assignmentId, sourcePlanVersionId, termsFingerprint), expiresAt: syntheticPortalExpiry(this.clock), revokedAt: null, active: true };
      state.tokens.set(tokenRecord.tokenHash, tokenRecord);
      this.tokenHashes.set(tokenRecord.tokenHash, tokenRecord);
    }
    this.seedTasks({ alias: `csv-${personId}`, fullName: row.fullName, organization: row.organization, title: row.title, role: row.role, programUnitName: row.programUnitName, location: "TBD", invitationState: "SENT", response: null, profileState: "NOT_SUBMITTED" }, personId, assignmentId, state.tasks);
    state.logistics.set(personId, { status: "NOT_COLLECTED", arrivalWindow: null, travelMode: "UNKNOWN", dietaryNotesProvided: false, sourceEvidence: { type: "EVENT_CONTEXT", id: deterministicUuid(`logistics:${workspaceId}:${event.id}:${personId}`), fingerprint: fingerprintOf({ workspaceId, eventId: event.id, personId, source: "csv-import" }) } });
  }

  private hydrateDurableCsv(state: State, workspaceId: string, eventId: string): void {
    if (!this.db) return;
    const rows = this.db.prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at
       FROM domain_events
       WHERE workspace_id = ? AND event_type = 'speaker.csv.imported'
         AND aggregate_type = 'event' AND aggregate_id = ?
         AND CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json, '$.eventId') END = ?
       ORDER BY created_at, aggregate_id`,
    ).all(workspaceId, eventId, eventId) as unknown as SpeakerOperationEventRow[];
    for (const row of rows) {
      const value = withTransactionOrSavepoint(this.db, "speaker_csv_hydrate", () => validateOrRepairSpeakerOperationEvent(this.db!, row));
      if (value.schema !== SPEAKER_OPERATION_EVENT_SCHEMA || value.operation !== "csv-import" || value.workspaceId !== workspaceId || value.eventId !== eventId || row.workspace_id !== workspaceId || row.event_type !== "speaker.csv.imported" || row.aggregate_type !== "event" || row.aggregate_id !== eventId) continue;
      if (value.receipt === null || typeof value.receipt !== "object" || Array.isArray(value.receipt)) throw new SpeakerOperationsConflictError("Durable CSV receipt is malformed.");
      const receipt = value.receipt as SpeakerCsvImportReceipt;
      if (receipt.schema !== SPEAKER_CSV_IMPORT_SCHEMA || receipt.workspaceId !== workspaceId || receipt.eventId !== eventId || !Array.isArray(receipt.rows)) throw new SpeakerOperationsConflictError("Durable CSV receipt scope is invalid.");
      if (!state.csvImportReceipts.some((existing) => existing.receiptId === receipt.receiptId)) state.csvImportReceipts.push(deepFreeze(clone(receipt)));
      if (!Array.isArray(value.normalizedRows)) throw new SpeakerOperationsConflictError("Durable CSV row evidence is malformed.");
    }
  }

  private hydrateCanonicalDbSpeakers(state: State, workspaceId: string, eventId: string): void {
    if (!this.db) return;
    const unsupported = this.db.prepare(
      `SELECT assignment.id
         FROM events event_row
         JOIN plan_versions plan ON plan.id = event_row.current_plan_version_id
          AND plan.workspace_id = event_row.workspace_id
          AND plan.event_id = event_row.id
         JOIN plan_assignments assignment ON assignment.plan_version_id = plan.id
          AND assignment.workspace_id = plan.workspace_id
         JOIN commitment_offers offer ON offer.plan_version_id = plan.id
          AND offer.workspace_id = plan.workspace_id
          AND offer.event_id = event_row.id
          AND offer.person_id = assignment.person_id
          AND offer.status = 'offered'
         JOIN commitment_responses response ON response.offer_id = offer.id
          AND response.workspace_id = offer.workspace_id
          AND response.actor_person_id = offer.person_id
          AND response.response = 'accepted'
        WHERE event_row.workspace_id = ?
          AND event_row.id = ?
          AND assignment.assignment_type NOT IN ('SPEAKER', 'participant', 'MODERATOR', 'moderator')
        LIMIT 1`,
    ).get(workspaceId, eventId) as { readonly id?: unknown } | undefined;
    if (typeof unsupported?.id === "string") {
      throw new SpeakerOperationsAuthorizationError("The current accepted speaker assignment has an unsupported role.");
    }
    const rows = this.db.prepare(
      `SELECT person.id AS person_id, person.canonical_email, person.full_name,
              person.organization, person.title
         FROM events event_row
         JOIN plan_versions plan ON plan.id = event_row.current_plan_version_id
          AND plan.workspace_id = event_row.workspace_id
          AND plan.event_id = event_row.id
         JOIN plan_assignments assignment ON assignment.plan_version_id = plan.id
          AND assignment.workspace_id = plan.workspace_id
          AND assignment.assignment_type IN ('SPEAKER', 'participant', 'MODERATOR', 'moderator')
         JOIN people person ON person.id = assignment.person_id
          AND person.workspace_id = assignment.workspace_id
        WHERE event_row.workspace_id = ? AND event_row.id = ?
        ORDER BY person.id`,
    ).all(workspaceId, eventId) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row.person_id !== "string" || typeof row.full_name !== "string") {
        throw new SpeakerOperationsConflictError("Canonical event speaker identity is malformed.");
      }
      const canonical = canonicalSpeakerAssignment(this.db, workspaceId, eventId, row.person_id);
      if (!canonical) continue;
      const terms = canonical.terms;
      if (
        fingerprintOf(terms) !== canonical.offerTermsFingerprint ||
        terms.eventId !== eventId || terms.planVersionId !== canonical.planVersionId ||
        terms.programUnitId !== canonical.programUnitId ||
        typeof terms.startsAt !== "string" || typeof terms.endsAt !== "string"
      ) throw new SpeakerOperationsConflictError("Canonical speaker offer terms are malformed.");
      const offeredTerms: SpeakerInvitationProjection["offeredTerms"] = {
        schema: "speaker-offer-terms/v1", eventId, eventName: state.event.name,
        timezone: state.event.timezone, role: canonical.role,
        programUnitId: canonical.programUnitId, programUnitName: canonical.programUnitName,
        startsAt: terms.startsAt, endsAt: terms.endsAt,
        location: typeof terms.location === "string" ? terms.location : "TBD",
        materialFields: ["role", "programUnitId", "startsAt", "endsAt", "location"],
      };
      const personId = row.person_id;
      const assignmentLineageId = `person:${personId}:unit:${canonical.programUnitId}:role:${canonical.role}`;
      const invitationId = deterministicUuid(`speaker-invitation-projection:${workspaceId}:${eventId}:${canonical.offerId}`);
      const response: SpeakerInvitationResponseProjection = {
        id: canonical.responseId,
        offerId: canonical.offerId,
        offerTermsFingerprint: canonical.offerTermsFingerprint,
        state: "ACCEPTED",
        respondedAt: canonical.respondedAt,
        commandFingerprint: commitmentResponseCommandKey(canonical.offerId, "accepted"),
      };
      const deliveryEvidence: SpeakerCommunicationEvidence = {
        id: deterministicUuid(`speaker-delivery-projection:${canonical.offerId}`), eventId, invitationId,
        kind: "INVITATION", channel: "in-app-simulation", deliveryState: "NOT_SENT", simulated: true,
        occurredAt: canonical.respondedAt, templateKey: "speaker-invitation-v1",
        renderedPreview: "Canonical accepted speaker commitment.", payloadFingerprint: canonical.offerTermsFingerprint,
        recipientPersonId: personId, commitmentStateIsSeparate: true,
      };
      state.people.set(personId, {
        personId, fullName: row.full_name,
        organization: typeof row.organization === "string" ? row.organization : "",
        title: typeof row.title === "string" ? row.title : "", canonicalIdentity: "Person",
      });
      registerPersonIdentity(state, personId, row.full_name, typeof row.organization === "string" ? row.organization : "", typeof row.canonical_email === "string" ? row.canonical_email : undefined);
      state.assignments.set(canonical.assignmentId, {
        assignmentId: canonical.assignmentId, assignmentLineageId, personId,
        programUnitId: canonical.programUnitId, programUnitName: canonical.programUnitName,
        role: canonical.role, decision: "APPROVED", sourcePlanVersionId: canonical.planVersionId,
        sourcePlanAssignmentId: canonical.assignmentId, startsAt: offeredTerms.startsAt,
        endsAt: offeredTerms.endsAt, timezone: offeredTerms.timezone, location: offeredTerms.location,
        offerId: canonical.offerId,
      });
      state.invitations.set(invitationId, {
        id: invitationId, personId, invitationType: "CONTENT_AND_ROLE", state: "RESPONDED",
        sourcePlanVersionId: canonical.planVersionId, sourcePlanAssignmentId: canonical.assignmentId,
        assignmentLineageId, commitmentOfferId: canonical.offerId,
        offeredTerms,
        termsFingerprint: canonical.offerTermsFingerprint, deliveredAt: null,
        respondedAt: canonical.respondedAt, response, deliveryEvidence,
      });
      state.communications.set(invitationId, []);
      const canonicalProfile = {
        bio: "", publicTitle: typeof row.title === "string" ? row.title : "",
        organization: typeof row.organization === "string" ? row.organization : "",
        socialLinks: [] as readonly SocialLink[], headshot: null,
      };
      state.profiles.set(personId, { ...canonicalProfile, sourceVersionId: canonical.assignmentId, sourceContentHash: fingerprintOf(canonicalProfile) });
      state.logistics.set(personId, {
        status: "NOT_COLLECTED", arrivalWindow: null, travelMode: "UNKNOWN", dietaryNotesProvided: false,
        sourceEvidence: { type: "EVENT_CONTEXT", id: canonical.assignmentId, fingerprint: fingerprintOf({ workspaceId, eventId, personId, assignmentId: canonical.assignmentId }) },
      });
    }
  }

  private hydrateDurableWorkflowStatuses(state: State, workspaceId: string, eventId: string): void {
    if (!this.db) return;
    const rows = this.db.prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at
         FROM domain_events
        WHERE workspace_id = ?
          AND event_type = 'speaker.workflow.status.updated'
          AND aggregate_type = 'event_speaker'
          AND CASE WHEN json_valid(payload_json)
                   THEN json_extract(payload_json, '$.eventId') END = ?
        ORDER BY created_at, rowid`,
    ).all(workspaceId, eventId) as unknown as SpeakerOperationEventRow[];
    for (const row of rows) {
      const value = withTransactionOrSavepoint(this.db, "speaker_workflow_status_hydrate", () => validateOrRepairSpeakerOperationEvent(this.db!, row));
      const status = storedWorkflowStatusEvent(row, value, workspaceId, eventId);
      const assignment = [...state.assignments.values()].find((candidate) => candidate.personId === status.personId);
      if (!state.people.has(status.personId) || !assignment || assignment.personId !== status.personId) {
        throw new SpeakerOperationsConflictError("Durable speaker workflow status is outside the canonical event roster.");
      }
      const prior = state.workflowStatuses.get(status.personId);
      const expectedPrevious = prior?.status ?? "NEW";
      const expectedVersion = prior?.eventId ?? null;
      if (status.previousStatus !== expectedPrevious || status.expectedCurrentStatus !== expectedPrevious || status.expectedVersion !== expectedVersion || status.status === expectedPrevious) {
        throw new SpeakerOperationsConflictError("Durable speaker workflow status history is not append-only.");
      }
      state.workflowStatuses.set(status.personId, status);
    }
  }

  private hydrateDurableTaskEvents(state: State, workspaceId: string, eventId: string): void {
    if (!this.db) return;
    const rows = this.db.prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at
       FROM domain_events
       WHERE workspace_id = ? AND event_type IN ('speaker.task.created', 'speaker.task.updated')
         AND CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json, '$.eventId') END = ?
       ORDER BY rowid`,
    ).all(workspaceId, eventId) as unknown as SpeakerOperationEventRow[];
    for (const row of rows) {
      const value = withTransactionOrSavepoint(this.db, "speaker_task_hydrate", () => validateOrRepairSpeakerOperationEvent(this.db!, row));
      if (value.schema !== SPEAKER_OPERATION_EVENT_SCHEMA || value.workspaceId !== workspaceId || value.eventId !== eventId || row.workspace_id !== workspaceId || row.aggregate_type !== "speaker_task" || typeof row.aggregate_id !== "string") continue;
      if (
        (row.event_type === "speaker.task.created" && value.operation !== "create-task") ||
        (row.event_type === "speaker.task.updated" && value.operation !== "update-task" && value.operation !== "complete-task")
      ) throw new SpeakerOperationsConflictError("Durable speaker task operation type is invalid.");
      const task = storedSpeakerTask(value.task, workspaceId, eventId);
      if (task.id !== row.aggregate_id) throw new SpeakerOperationsConflictError("Durable speaker task aggregate identity is invalid.");
      if (value.personId !== task.personId || value.taskId !== task.id) throw new SpeakerOperationsConflictError("Durable speaker task payload identity is invalid.");
      if (task.kind === "ACTION") {
        const binding = sharedActionDefinitionForTask(this.db, workspaceId, eventId, task.id);
        if (binding.assignment.personId !== task.personId || binding.assignment.assignmentId !== task.assignmentId) {
          throw new SpeakerOperationsConflictError("Durable ACTION task assignment identity is divergent.");
        }
        if (row.event_type === "speaker.task.created" && (
          value.sharedActionDefinitionId !== binding.definition.definitionId ||
          value.sharedActionRequestFingerprint !== binding.definition.requestFingerprint
        )) throw new SpeakerOperationsConflictError("Durable ACTION task shared-definition binding is invalid.");
      }
      if (!state.people.has(task.personId)) continue;
      const assignment = state.assignments.get(task.assignmentId);
      if (!assignment) continue;
      if (assignment.personId !== task.personId) throw new SpeakerOperationsConflictError("Durable speaker task assignment is bound to another Person.");
      state.tasks.set(task.id, task);
    }
  }

  private hydrateDurableArtifactTasks(state: State, workspaceId: string, eventId: string): void {
    if (!this.db) return;
    const rows = this.db.prepare(
      `SELECT id, person_id, assignment_id, task_kind, content_kind,
              title, required, gate, owner, state, due_at
       FROM speaker_tasks
       WHERE workspace_id = ? AND event_id = ?
         AND task_kind IN ('HEADSHOT', 'SLIDES')
       ORDER BY person_id, id`,
    ).all(workspaceId, eventId) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (
        typeof row.id !== "string" || typeof row.person_id !== "string" || typeof row.assignment_id !== "string" ||
        (row.task_kind !== "HEADSHOT" && row.task_kind !== "SLIDES") || row.content_kind !== row.task_kind ||
        typeof row.title !== "string" || (row.required !== 0 && row.required !== 1) ||
        (row.gate !== "PUBLICATION" && row.gate !== "OPERATOR_RELEASE") || row.owner !== "SPEAKER" ||
        typeof row.state !== "string" || !SPEAKER_TASK_STATES.includes(row.state as SpeakerTaskState) ||
        typeof row.due_at !== "string" || !Number.isFinite(Date.parse(row.due_at))
      ) throw new SpeakerOperationsConflictError("Durable artifact task definition is invalid.");
      if (!state.people.has(row.person_id)) continue;
      const assignment = state.assignments.get(row.assignment_id);
      if (!assignment) continue;
      if (assignment.personId !== row.person_id) throw new SpeakerOperationsConflictError("Durable artifact task assignment is bound to another Person.");
      state.tasks.set(row.id, {
        id: row.id,
        personId: row.person_id,
        assignmentId: row.assignment_id,
        kind: row.task_kind as SpeakerTaskKind,
        contentKind: row.content_kind as ContentKind,
        title: row.title,
        description: row.task_kind === "HEADSHOT" ? "Submit a bounded PNG; each upload is an immutable artifact version." : "Optional supporting PDF; each upload is an immutable artifact version.",
        required: row.required === 1,
        gate: row.gate,
        dueAt: new Date(Date.parse(row.due_at)).toISOString(),
        owner: "SPEAKER",
        state: row.state as SpeakerTaskState,
        transitions: [],
      });
    }
  }

  private ensureState(workspaceId: string, event: SpeakerEventContext, initialization = this.defaultEventInitialization, detectEvaluatorContext = true): State {
    boundedId(workspaceId, "workspaceId");
    boundedId(event.id, "eventId");
    if (initialization.kind !== "ordinary" && initialization.kind !== "evaluator-demo") fail("Event initialization is unsupported.");
    const effectiveInitialization = !this.db && detectEvaluatorContext && initialization.kind === "ordinary" && this.defaultEventInitialization.kind === "ordinary"
      ? speakerEventInitializationFor(workspaceId, event.id)
      : initialization;
    const key = scopeKey(workspaceId, event.id);
    const existing = this.states.get(key);
    if (existing) return existing;
    const people = new Map<string, CanonicalPersonProjection>();
    const invitations = new Map<string, InvitationStateRecord>();
    const assignments = new Map<string, AssignmentStateRecord>();
    const tasks = new Map<string, TaskStateRecord>();
    const profiles = new Map<string, ProfileBase>();
    const logistics = new Map<string, SpeakerLogisticsProjection>();
    const state: State = { event: clone(event), eventInitialization: clone(effectiveInitialization), people, invitations, assignments, tasks, profiles, logistics, communications: new Map(), tokens: new Map(), workflowStatuses: new Map(), identityIndex: new Map(), csvImportReceipts: [] };
    const organizerScope: SpeakerOrganizerScope = { kind: "organizer", workspaceId, eventId: event.id, actorId: organizerIdFor(workspaceId) };
    const evaluatorIdentity = isEvaluatorArtifactScope({ workspaceId, eventId: event.id, personId: EVALUATOR_ARTIFACT_PERSON_ID });
    const seededPeople = evaluatorIdentity ? EVALUATOR_SYNTHETIC_PEOPLE : SYNTHETIC_PEOPLE;
    if (!this.db && effectiveInitialization.kind === "evaluator-demo") for (const seed of seededPeople) {
      const personId = seed.personId ?? personIdFor(workspaceId, seed.alias);
      const assignmentId = seed.assignmentId || deterministicUuid(`speaker-assignment:${workspaceId}:${event.id}:${seed.alias}`);
      const programUnitId = deterministicUuid(`speaker-program-unit:${workspaceId}:${event.id}:${seed.alias}`);
      const sourcePlanVersionId = deterministicUuid(`speaker-plan-version:${workspaceId}:${event.id}`);
      const sourcePlanAssignmentId = deterministicUuid(`speaker-plan-assignment:${workspaceId}:${event.id}:${seed.alias}`);
      const role = seed.role;
      const programUnitName = seed.programUnitName;
      const assignmentLineageId = `person:${personId}:unit:${programUnitId}:role:${role}`;
      const terms: SpeakerInvitationProjection["offeredTerms"] = {
        schema: "speaker-offer-terms/v1",
        eventId: event.id,
        eventName: event.name,
        timezone: event.timezone,
        role,
        programUnitId,
        programUnitName,
        startsAt: event.startsAt,
        endsAt: new Date(Date.parse(event.startsAt) + 45 * 60 * 1000).toISOString(),
        location: seed.location,
        materialFields: ["role", "programUnitId", "startsAt", "endsAt", "location"],
      };
      const termsFingerprint = fingerprintOf(terms);
      const invitationId = deterministicUuid(`speaker-invitation:${workspaceId}:${event.id}:${seed.alias}`);
      const offerId = deterministicUuid(`speaker-offer:${workspaceId}:${event.id}:${seed.alias}`);
      const canonicalOfferId = offerId;
      const response = seed.response ? {
        id: deterministicUuid(`speaker-response:${invitationId}:${seed.response}`),
        offerId: canonicalOfferId,
        offerTermsFingerprint: termsFingerprint,
        state: seed.response,
        respondedAt: "2026-08-12T12:00:03.000Z",
        commandFingerprint: commitmentResponseCommandKey(canonicalOfferId, "accepted"),
      } satisfies SpeakerInvitationResponseProjection : null;
      const deliveryEvidence: SpeakerCommunicationEvidence = {
        id: deterministicUuid(`speaker-delivery:${invitationId}`),
        eventId: event.id,
        invitationId,
        kind: "INVITATION",
        channel: "in-app-simulation",
        deliveryState: seed.invitationState === "SENT" ? "SIMULATED_DELIVERED" : "SIMULATED_DELIVERED",
        simulated: true,
        occurredAt: "2026-08-12T12:00:01.000Z",
        templateKey: "speaker-invitation-v1",
        renderedPreview: `Invitation evidence for ${seed.fullName}: ${seed.programUnitName} · ${seed.role}`,
        payloadFingerprint: termsFingerprint,
        recipientPersonId: personId,
        commitmentStateIsSeparate: true,
      };
      people.set(personId, { personId, fullName: seed.fullName, organization: seed.organization, title: seed.title, canonicalIdentity: "Person" });
      registerPersonIdentity(state, personId, seed.fullName, seed.organization);
      assignments.set(assignmentId, { assignmentId, assignmentLineageId, personId, programUnitId, programUnitName, role, decision: "APPROVED", sourcePlanVersionId, sourcePlanAssignmentId, startsAt: terms.startsAt, endsAt: terms.endsAt, timezone: terms.timezone, location: terms.location, offerId: canonicalOfferId });
      invitations.set(invitationId, { id: invitationId, personId, invitationType: "CONTENT_AND_ROLE", state: seed.invitationState, sourcePlanVersionId, sourcePlanAssignmentId, assignmentLineageId, commitmentOfferId: canonicalOfferId, offeredTerms: terms, termsFingerprint, deliveredAt: "2026-08-12T12:00:01.000Z", respondedAt: response?.respondedAt ?? null, response, deliveryEvidence });
      state.communications.set(invitationId, [deliveryEvidence]);
      profiles.set(personId, baseProfile(seed));
      const token = syntheticSpeakerPortalToken(workspaceId, event.id, personId);
      const tokenRecord: TokenStateRecord = { tokenHash: sha256Hex(token), purpose: SPEAKER_PORTAL_PURPOSE, workspaceId, eventId: event.id, personId, ...syntheticPortalAuthority(workspaceId, event.id, personId, assignmentId, sourcePlanVersionId, termsFingerprint), expiresAt: syntheticPortalExpiry(this.clock), revokedAt: null, active: true };
      state.tokens.set(tokenRecord.tokenHash, tokenRecord);
      this.tokenHashes.set(tokenRecord.tokenHash, tokenRecord);
      this.seedContent(organizerScope, seed, personId, state, assignmentId);
      this.seedTasks(seed, personId, assignmentId, tasks);
      const logisticsSubmitted = seed.alias === "ada" || seed.alias === "mina";
      logistics.set(personId, { status: logisticsSubmitted ? "SUBMITTED" : "NOT_COLLECTED", arrivalWindow: logisticsSubmitted ? "08:30–09:15 event local time" : null, travelMode: logisticsSubmitted ? "TRAIN" : "UNKNOWN", dietaryNotesProvided: logisticsSubmitted, sourceEvidence: { type: logisticsSubmitted ? "LOGISTICS_SUBMISSION" : "EVENT_CONTEXT", id: deterministicUuid(`logistics:${workspaceId}:${event.id}:${seed.alias}`), fingerprint: fingerprintOf({ workspaceId, eventId: event.id, personId, logistics: logisticsSubmitted ? "submitted" : "not-collected" }) } });
    }
    if (this.db) {
      this.hydrateCanonicalDbSpeakers(state, workspaceId, event.id);
      this.hydrateDurableWorkflowStatuses(state, workspaceId, event.id);
      this.hydrateDurableCsv(state, workspaceId, event.id);
      this.hydrateDurableTaskEvents(state, workspaceId, event.id);
      this.hydrateDurableArtifactTasks(state, workspaceId, event.id);
    }
    this.states.set(key, state);
    return state;
  }

  private organizerState(scope: SpeakerOrganizerScope): State {
    const state = this.ensureState(scope.workspaceId, this.eventFor(scope));
    assertOrganizerScope(scope, state.event);
    return state;
  }

  private stateIsEmpty(state: State): boolean {
    return state.people.size === 0 && state.invitations.size === 0 && state.assignments.size === 0 && state.tasks.size === 0 && state.profiles.size === 0 && state.logistics.size === 0 && state.communications.size === 0 && state.tokens.size === 0 && state.workflowStatuses.size === 0 && state.identityIndex.size === 0 && state.csvImportReceipts.length === 0;
  }

  private organizerTask(state: State, personId: string, taskId: string): TaskStateRecord {
    boundedId(personId, "personId");
    boundedId(taskId, "taskId");
    const task = state.tasks.get(taskId);
    const assignment = task ? state.assignments.get(task.assignmentId) : undefined;
    if (!task || task.personId !== personId || !assignment || assignment.personId !== personId) {
      throw new SpeakerOperationsAuthorizationError("Task is not available in the authorized event projection.");
    }
    return task;
  }

  private applySubmittedVersion(state: State, version: ContentSubmissionVersion): void {
    if (version.payload.kind !== "LOGISTICS") return;
    state.logistics.set(version.personId, {
      status: "SUBMITTED",
      arrivalWindow: version.payload.arrivalWindow,
      travelMode: version.payload.travelMode,
      dietaryNotesProvided: version.payload.dietaryNotes.length > 0,
      sourceEvidence: { type: "LOGISTICS_SUBMISSION", id: version.id, fingerprint: version.contentHash },
    });
  }

  private communicationList(state: State, invitationId: string): readonly SpeakerCommunicationEvidence[] {
    return state.communications.get(invitationId) ?? [];
  }

  private portalOperationKey(access: Pick<TokenStateRecord, "workspaceId" | "eventId" | "personId">, idempotencyKey: string): string {
    return `${access.workspaceId}:${access.eventId}:${access.personId}:${idempotencyKey}`;
  }

  private portalOperationResult<T>(access: Pick<TokenStateRecord, "workspaceId" | "eventId" | "personId">, idempotencyKey: string | null, fingerprint: string): T | null {
    if (!idempotencyKey) return null;
    const prior = this.portalOperationIdempotency.get(this.portalOperationKey(access, idempotencyKey));
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint) throw new SpeakerOperationsConflictError("The idempotency key was reused with different speaker operation content.");
    return clone(prior.result as T);
  }

  private rememberPortalOperation(access: Pick<TokenStateRecord, "workspaceId" | "eventId" | "personId">, idempotencyKey: string | null, fingerprint: string, result: unknown): void {
    if (!idempotencyKey) return;
    this.portalOperationIdempotency.set(this.portalOperationKey(access, idempotencyKey), { fingerprint, result: clone(result) });
  }

  private operationKey(scope: SpeakerOrganizerScope, idempotencyKey: string): string {
    return `${scope.workspaceId}:${scope.eventId}:${scope.actorId}:${idempotencyKey}`;
  }

  private operationResult<T>(scope: SpeakerOrganizerScope, idempotencyKey: string | null, fingerprint: string): T | null {
    if (!idempotencyKey) return null;
    const prior = this.operationIdempotency.get(this.operationKey(scope, idempotencyKey));
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint) throw new SpeakerOperationsConflictError("The idempotency key was reused with different speaker operation content.");
    return clone(prior.result as T);
  }

  private rememberOperation(scope: SpeakerOrganizerScope, idempotencyKey: string | null, fingerprint: string, result: unknown): void {
    if (!idempotencyKey) return;
    this.operationIdempotency.set(this.operationKey(scope, idempotencyKey), { fingerprint, result: clone(result) });
  }

  private seedContent(scope: SpeakerOrganizerScope, seed: SyntheticPersonSeed, personId: string, state: State, assignmentId: string): void {
    const taskId = deterministicUuid(`speaker-task:${personId}:${assignmentId}:PROFILE`);
    if (seed.profileState === "NOT_SUBMITTED") return;
    const version = this.content.submitVersion(contentScope(scope), { personId, taskId, payload: profilePayload(seed), idempotencyKey: `seed-profile:${scope.workspaceId}:${state.event.id}:${seed.alias}` });
    if (seed.profileState === "CHANGES_REQUESTED") {
      this.content.addFinding(contentScope(scope), { personId, taskId, submissionVersionId: version.id, submissionContentHash: version.contentHash, severity: "BLOCKER", message: "Add a concise audience-facing example before publication.", blocksReadiness: true, idempotencyKey: `seed-finding:${scope.workspaceId}:${state.event.id}:${seed.alias}` });
      this.content.requestRevision(contentScope(scope), { personId, taskId, submissionVersionId: version.id, submissionContentHash: version.contentHash, reason: "Please revise the public profile before release.", idempotencyKey: `seed-revision:${scope.workspaceId}:${state.event.id}:${seed.alias}` });
    } else {
      this.content.approveVersion(contentScope(scope), { personId, taskId, submissionVersionId: version.id, submissionContentHash: version.contentHash, gate: "PUBLICATION", idempotencyKey: `seed-approval:${scope.workspaceId}:${state.event.id}:${seed.alias}` });
    }
  }

  private seedTasks(seed: SyntheticPersonSeed, personId: string, assignmentId: string, tasks: Map<string, TaskStateRecord>): void {
    const taskSpecs: readonly { readonly kind: SpeakerTaskKind; readonly contentKind: ContentKind | null; readonly title: string; readonly description: string; readonly required: boolean; readonly gate: SpeakerTaskProjection["gate"]; readonly dueAt: string; readonly owner: "SPEAKER" | "ORGANIZER" }[] = [
      { kind: "PROFILE", contentKind: "PROFILE", title: "Profile and public bio", description: "Confirm the reusable profile and event-facing override.", required: true, gate: "CONFIRMATION", dueAt: "2026-08-20T17:00:00.000Z", owner: "SPEAKER" },
      { kind: "SESSION_TITLE", contentKind: "SESSION_TITLE", title: "Session title", description: "Confirm the title shown to the audience.", required: true, gate: "PUBLICATION", dueAt: "2026-08-22T17:00:00.000Z", owner: "SPEAKER" },
      { kind: "SESSION_DESCRIPTION", contentKind: "SESSION_DESCRIPTION", title: "Session description", description: "Provide a bounded audience-facing description.", required: true, gate: "PUBLICATION", dueAt: "2026-08-22T17:00:00.000Z", owner: "SPEAKER" },
      { kind: "HEADSHOT", contentKind: "HEADSHOT", title: "Headshot PNG", description: "Submit a bounded PNG; each upload is an immutable artifact version.", required: true, gate: "PUBLICATION", dueAt: "2026-08-25T17:00:00.000Z", owner: "SPEAKER" },
      { kind: "SLIDES", contentKind: "SLIDES", title: "Slides or supporting PDF", description: "Optional supporting PDF; each upload is an immutable artifact version.", required: false, gate: "OPERATOR_RELEASE", dueAt: "2026-09-10T17:00:00.000Z", owner: "SPEAKER" },
      { kind: "LOGISTICS", contentKind: "LOGISTICS", title: "Travel and logistics", description: "Share arrival window and logistics metadata.", required: true, gate: "OPERATOR_RELEASE", dueAt: "2026-09-05T17:00:00.000Z", owner: "SPEAKER" },
      { kind: "ACKNOWLEDGEMENT", contentKind: "ACKNOWLEDGEMENT", title: "Speaker briefing acknowledgement", description: "Acknowledge the event briefing and operating boundaries.", required: true, gate: "CONFIRMATION", dueAt: "2026-09-08T17:00:00.000Z", owner: "SPEAKER" },
      { kind: "BRIEFING", contentKind: null, title: "Briefing attendance", description: "Confirm the local briefing slot.", required: false, gate: null, dueAt: "2026-09-12T17:00:00.000Z", owner: "SPEAKER" },
    ];
    for (const spec of taskSpecs) {
      const id = deterministicUuid(`speaker-task:${personId}:${assignmentId}:${spec.kind}`);
      tasks.set(id, { id, personId, assignmentId, kind: spec.kind, contentKind: spec.contentKind, title: spec.title, description: spec.description, required: spec.required, gate: spec.gate, dueAt: spec.dueAt, owner: spec.owner, state: "NOT_STARTED", transitions: [] });
    }
    void seed;
  }

  private stateForToken(token: string, lookupBudgetKey?: string): { readonly access: TokenStateRecord; readonly state: State } {
    const access = this.resolvePortalToken(token, lookupBudgetKey ?? (this.db ? undefined : SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY));
    if (!access || !access.active) throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
    const record = this.tokenHashes.get(sha256Hex(token));
    if (!record) throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
    const state = this.states.get(scopeKey(record.workspaceId, record.eventId)) ?? this.ensureState(record.workspaceId, this.eventFor(record));
    return { access: record, state };
  }

  private authorizedPortal(token: string, lookupBudgetKey?: string): TokenStateRecord {
    return this.stateForToken(assertToken(token), lookupBudgetKey).access;
  }

  private assertResolvedAccess(token: string, access: SpeakerPortalTokenProjection): TokenStateRecord {
    const tokenHash = sha256Hex(assertToken(token));
    const durable = this.db ? revalidateSpeakerPortalToken(this.db, token, { now: this.clock() }) : null;
    if (this.db && durable) this.tokenHashes.set(tokenHash, { ...durable, tokenHash });
    const record = this.tokenHashes.get(tokenHash);
    if (
      !record ||
      (this.db !== null && durable === null) ||
      !access.active ||
      record.revokedAt !== null ||
      Date.parse(record.expiresAt) <= Date.parse(this.clock()) ||
      record.workspaceId !== access.workspaceId ||
      record.eventId !== access.eventId ||
      record.personId !== access.personId ||
      record.assignmentId !== access.assignmentId ||
      record.planVersionId !== access.planVersionId ||
      record.planVersionFingerprint !== access.planVersionFingerprint ||
      record.acceptedTermsFingerprint !== access.acceptedTermsFingerprint ||
      record.authorityFingerprint !== access.authorityFingerprint ||
      record.expiresAt !== access.expiresAt ||
      record.revokedAt !== access.revokedAt
    ) {
      throw new SpeakerOperationsAuthorizationError("Speaker portal access is unavailable.");
    }
    return record;
  }

  private eventFor(access: { readonly workspaceId: string; readonly eventId: string }): SpeakerEventContext {
    const cached = this.states.get(scopeKey(access.workspaceId, access.eventId))?.event;
    if (cached) return cached;
    if (this.db) {
      const persisted = this.db.prepare(
        `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt
         FROM events WHERE workspace_id = ? AND id = ?`,
      ).get(access.workspaceId, access.eventId) as Record<string, unknown> | undefined;
      if (
        !persisted || persisted.id !== access.eventId ||
        typeof persisted.name !== "string" || persisted.name.length < 1 || persisted.name.length > 240 ||
        typeof persisted.timezone !== "string" || persisted.timezone.length < 1 || persisted.timezone.length > 120 ||
        typeof persisted.startsAt !== "string" || !Number.isFinite(Date.parse(persisted.startsAt)) ||
        typeof persisted.endsAt !== "string" || !Number.isFinite(Date.parse(persisted.endsAt)) ||
        Date.parse(persisted.endsAt) <= Date.parse(persisted.startsAt)
      ) {
        throw new SpeakerOperationsAuthorizationError("The persisted speaker event is unavailable.");
      }
      return {
        id: access.eventId,
        name: persisted.name,
        timezone: persisted.timezone,
        startsAt: persisted.startsAt,
        endsAt: persisted.endsAt,
      };
    }
    return {
      id: access.eventId,
      name: "Synthetic Speaker Forum",
      timezone: "UTC",
      startsAt: "2026-09-15T09:00:00.000Z",
      endsAt: "2026-09-15T17:00:00.000Z",
    };
  }

  private portalProjection(access: SpeakerPortalTokenProjection, state: State, person: CanonicalPersonProjection, assignment: AssignmentStateRecord, invitation: InvitationStateRecord): SpeakerPortalProjection {
    const asOf = this.clock();
    const currentActionAssignment = this.db
      ? canonicalSpeakerAssignment(this.db, access.workspaceId, access.eventId, access.personId)
      : null;
    const tasks = [...state.tasks.values()]
      .filter((task) => task.personId === access.personId)
      .filter((task) => task.kind !== "ACTION" || currentActionAssignment?.assignmentId === task.assignmentId)
      .map((task) => this.taskProjectionForScope(state, task, access.workspaceId, asOf));
    const profileTask = tasks.find((task) => isCanonicalProfileTask(task));
    const profileReview = profileTask?.review ?? this.emptyReview(access.workspaceId, state.event.id, access.personId, profileTask?.id ?? "", "PROFILE");
    const readiness = this.readinessFor(access.workspaceId, state, access.personId, assignment, invitation, profileReview, asOf);
    const contentReviews = tasks.flatMap((task) => task.review ? [task.review] : []);
    const communications = state.communications.get(invitation.id) ?? [invitation.deliveryEvidence];
    const latestInvitation = [...communications].reverse().find((entry) => entry.kind === "INVITATION") ?? invitation.deliveryEvidence;
    return deepFreeze(clone({
      schema: SPEAKER_OPERATIONS_SCHEMA,
      access: { kind: "portal", purpose: SPEAKER_PORTAL_PURPOSE, workspaceId: access.workspaceId, eventId: access.eventId, personId: access.personId, assignmentId: access.assignmentId, planVersionId: access.planVersionId, planVersionFingerprint: access.planVersionFingerprint, acceptedTermsFingerprint: access.acceptedTermsFingerprint, authorityFingerprint: access.authorityFingerprint, expiresAt: access.expiresAt },
      event: state.event,
      person,
      invitation: invitationProjection(invitation, latestInvitation),
      assignment: assignmentProjection(state, assignment),
      tasks,
      profile: profileFromReview(state.profiles.get(access.personId)!, profileReview),
      readiness,
      logistics: state.logistics.get(access.personId)!,
      communications: clone(communications),
      contentReviews,
      privacyNotice: "role-scoped-speaker-projection-no-organizer-navigation",
      localProjectionNotice: "synthetic-local-projection-provider-adapters-not-configured",
    }));
  }

  private emptyReview(workspaceId: string, eventId: string, personId: string, taskId: string, kind: ContentKind): ContentReviewProjection {
    return { schema: "sympose-content-operations/v1", workspaceId, eventId, personId, taskId, kind, versions: [], latestVersionId: null, latestReviewState: "NOT_SUBMITTED", comments: [], findings: [], revisionRequests: [], approvals: [] };
  }

  private durableArtifactReview(
    workspaceId: string,
    eventId: string,
    task: TaskStateRecord,
  ): ContentReviewProjection | null {
    if (!this.db || (task.contentKind !== "HEADSHOT" && task.contentKind !== "SLIDES")) return null;
    const rows = this.db.prepare(
      `SELECT version.id, version.person_id, version.task_id, version.kind, version.version,
              version.supersedes_version_id, version.payload_json, version.content_hash,
              version.payload_bytes, version.submitted_at, version.submitted_by,
              version.submitted_by_kind, version.source,
              review.id AS review_id, review.review_state, review.gate,
              review.reviewed_by, review.reviewed_at, review.submission_content_hash
       FROM speaker_content_versions version
       LEFT JOIN speaker_content_reviews review
         ON review.submission_version_id = version.id
        AND review.workspace_id = version.workspace_id
       WHERE version.workspace_id = ? AND version.event_id = ?
         AND version.person_id = ? AND version.task_id = ? AND version.kind = ?
       ORDER BY version.version, review.reviewed_at, review.id`,
    ).all(workspaceId, eventId, task.personId, task.id, task.contentKind) as unknown as readonly Record<string, unknown>[];
    if (rows.length === 0) return null;

    const versions = rows.reduce<ContentSubmissionVersion[]>((result, row) => {
      const id = row.id;
      if (typeof id !== "string" || result.some((candidate) => candidate.id === id)) return result;
      let payload: ContentSubmissionVersion["payload"];
      try {
        payload = validateContentPayload(JSON.parse(String(row.payload_json))) as ContentSubmissionVersion["payload"];
      } catch {
        throw new SpeakerOperationsConflictError("Durable speaker content is unavailable.");
      }
      if (
        payload.kind !== task.contentKind ||
        row.person_id !== task.personId ||
        row.task_id !== task.id ||
        typeof row.content_hash !== "string" ||
        fingerprintOf(payload) !== row.content_hash
      ) throw new SpeakerOperationsConflictError("Durable speaker content is inconsistent.");
      result.push({
        id,
        workspaceId,
        eventId,
        personId: task.personId,
        taskId: task.id,
        kind: task.contentKind,
        version: row.version as number,
        supersedesVersionId: row.supersedes_version_id as string | null,
        payload,
        contentHash: row.content_hash,
        payloadBytes: row.payload_bytes as number,
        submittedAt: String(row.submitted_at),
        submittedBy: String(row.submitted_by),
        submittedByKind: row.submitted_by_kind as "speaker",
        source: row.source as "local-artifact-store",
      });
      return result;
    }, []);
    const reviewRows = rows.filter((row) => typeof row.review_id === "string");
    const approvals: ContentApproval[] = reviewRows.map((row) => ({
      id: String(row.review_id),
      workspaceId,
      eventId,
      personId: task.personId,
      taskId: task.id,
      submissionVersionId: String(row.id),
      submissionContentHash: String(row.submission_content_hash),
      approvedBy: String(row.reviewed_by),
      approvedAt: String(row.reviewed_at),
      gate: row.gate as ContentApproval["gate"],
    })).filter((approval) => reviewRows.find((row) => row.review_id === approval.id)?.review_state === "APPROVED");
    const latest = versions.at(-1);
    const latestReviews = reviewRows.filter((row) => row.id === latest?.id);
    const latestReviewState: ContentReviewProjection["latestReviewState"] =
      latestReviews.some((row) => row.review_state === "APPROVED") ? "APPROVED" :
        latestReviews.some((row) => row.review_state === "CHANGES_REQUESTED") ? "CHANGES_REQUESTED" :
          latestReviews.some((row) => row.review_state === "BLOCKED") ? "BLOCKED" : "IN_REVIEW";
    return {
      schema: "sympose-content-operations/v1",
      workspaceId,
      eventId,
      personId: task.personId,
      taskId: task.id,
      kind: task.contentKind,
      versions: versions.map((version) => ({
        ...version,
        reviewState: version.id === latest?.id
          ? latestReviewState
          : "SUPERSEDED",
      })),
      latestVersionId: latest?.id ?? null,
      latestReviewState,
      comments: [],
      findings: [],
      revisionRequests: [],
      approvals,
    };
  }

  private taskProjectionForScope(state: State, task: TaskStateRecord, workspaceId: string, asOf: string): SpeakerTaskProjection {
    const assignment = state.assignments.get(task.assignmentId);
    if (!assignment || assignment.personId !== task.personId) {
      throw new SpeakerOperationsConflictError("Speaker task assignment is not bound to the same Person and event.");
    }
    const target = contentTaskTarget(task);
    const review = target
      ? this.content.getReviewProjection({ workspaceId, eventId: state.event.id, actorId: organizerIdFor(workspaceId), actorKind: "organizer" }, target)
      : null;
    const derivedState = review ? contentStateToTaskState(review) : task.state;
    const latest = review?.versions.at(-1);
    return { id: task.id, personId: task.personId, assignmentId: task.assignmentId, kind: task.kind, contentKind: task.contentKind, title: task.title, description: task.description, required: task.required, gate: task.gate, dueAt: task.dueAt, owner: task.owner, state: derivedState, dueState: dueState(derivedState, task.dueAt, asOf), submissionVersionId: latest?.id ?? null, submissionContentHash: latest?.contentHash ?? null, transitions: task.transitions, review };
  }

  private readinessFor(workspaceId: string, state: State, personId: string, assignment: AssignmentStateRecord, invitation: InvitationStateRecord, profileReview: ContentReviewProjection, asOf: string): SpeakerReadinessProjection {
    const evaluator = evaluateSpeakerReadiness(readinessFacts(workspaceId, state, personId, assignment, invitation, profileReview, asOf));
    return { asOf: evaluator.asOf, eligible: evaluator.eligible, computationFingerprint: evaluator.computationFingerprint, gates: evaluator.gates.map((gate) => ({ gate: gate.gate, eligible: gate.eligible, blockerCount: gate.blockers.length, blockerCodes: gate.blockers.map((blocker) => blocker.code) })), sourceCount: evaluator.gates.reduce((count, gate) => count + gate.sourceRecords.length, 0), evaluator };
  }

  private rosterRecord(workspaceId: string, state: State, personId: string): SpeakerRosterRecord {
    const person = state.people.get(personId)!;
    const assignment = [...state.assignments.values()].find((candidate) => candidate.personId === personId)!;
    const invitation = [...state.invitations.values()].find((candidate) => candidate.personId === personId && candidate.commitmentOfferId === assignment.offerId)!;
    const asOf = this.clock();
    const tasks = [...state.tasks.values()].filter((task) => task.personId === personId).map((task) => this.taskProjectionForScope(state, task, workspaceId, asOf));
    const profileTask = tasks.find((task) => isCanonicalProfileTask(task));
    const profileReview = profileTask?.review ?? this.emptyReview(workspaceId, state.event.id, personId, profileTask?.id ?? "", "PROFILE");
    const readiness = this.readinessFor(workspaceId, state, personId, assignment, invitation, profileReview, asOf);
    const communications = state.communications.get(invitation.id) ?? [invitation.deliveryEvidence];
    const latestInvitation = [...communications].reverse().find((entry) => entry.kind === "INVITATION") ?? invitation.deliveryEvidence;
    const lastActivityAt = [invitation.respondedAt, ...tasks.flatMap((task) => task.review?.versions.map((version) => version.submittedAt) ?? []), ...communications.map((entry) => entry.occurredAt), invitation.deliveredAt].filter((value): value is string => value !== null).sort().at(-1) ?? asOf;
    return deepFreeze({ person, role: assignment.role, workflowStatus: state.workflowStatuses.get(personId)?.status ?? "NEW", workflowStatusVersion: state.workflowStatuses.get(personId)?.eventId ?? null, invitation: invitationProjection(invitation, latestInvitation), assignment: assignmentProjection(state, assignment), tasks, profile: profileFromReview(state.profiles.get(personId)!, profileReview), readiness, logistics: state.logistics.get(personId)!, communications, lastActivityAt });
  }

  private listSpeakerRosterFromState(workspaceId: string, state: State, filter?: SpeakerRosterFilter): readonly SpeakerRosterRecord[] {
    const normalizeSearchText = (value: string): string => value
      .normalize("NFKC")
      .trim()
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("en-US");
    const query = filter?.query === undefined ? "" : normalizeSearchText(filter.query);
    if (query.length > 120) fail("roster search query is too long.");
    const roster = [...state.people.keys()].map((personId) => this.rosterRecord(workspaceId, state, personId)).filter((record) => {
      const haystack = normalizeSearchText([record.person.fullName, record.person.organization, record.person.title, record.assignment.programUnitName, record.role].join(" "));
      if (query && !haystack.includes(query)) return false;
      if (filter?.role && record.role !== filter.role) return false;
      if (filter?.workflowStatus && record.workflowStatus !== filter.workflowStatus) return false;
      if (filter?.invitationState && record.invitation.state !== filter.invitationState) return false;
      if (filter?.commitmentState && record.assignment.commitment.state !== filter.commitmentState) return false;
      if (filter?.taskState && !record.tasks.some((task) => task.state === filter.taskState)) return false;
      if (filter?.readinessGate && record.readiness.gates.find((gate) => gate.gate === filter.readinessGate)?.eligible !== false) return false;
      if (filter?.overdueOnly && !record.tasks.some((task) => task.dueState === "OVERDUE")) return false;
      return true;
    });
    return deepFreeze(clone(roster.sort((a, b) => a.person.fullName.localeCompare(b.person.fullName))));
  }

  private matrixRow(record: SpeakerRosterRecord): SpeakerReadinessMatrixRow {
    const required = record.tasks.filter((task) => task.required);
    return { personId: record.person.personId, personName: record.person.fullName, role: record.role, assignmentId: record.assignment.assignmentId, commitmentState: record.assignment.commitment.state, requiredTaskCount: required.length, completedRequiredTaskCount: required.filter((task) => task.state === "COMPLETED").length, overdueTaskCount: record.tasks.filter((task) => task.dueState === "OVERDUE").length, blockers: record.readiness.gates.flatMap((gate) => gate.eligible ? [] : gate.blockerCodes), lastActivityAt: record.lastActivityAt };
  }

  private publicTokenProjection(record: TokenStateRecord): SpeakerPortalTokenProjection {
    return clone({ purpose: record.purpose, workspaceId: record.workspaceId, eventId: record.eventId, personId: record.personId, assignmentId: record.assignmentId, planVersionId: record.planVersionId, planVersionFingerprint: record.planVersionFingerprint, acceptedTermsFingerprint: record.acceptedTermsFingerprint, authorityFingerprint: record.authorityFingerprint, expiresAt: record.expiresAt, revokedAt: record.revokedAt, active: record.active });
  }
}

/**
 * Explicit fixture factory retained for standalone synthetic speaker tests and portal previews.
 * The application singleton below uses an ordinary-event default and opts into the exact
 * evaluator context from trusted server event data.
 */
export function createSyntheticSpeakerOperationsRepository(options: { readonly db?: Db; readonly content?: ContentOperationsRepository; readonly clock?: Clock; readonly defaultEventInitialization?: SpeakerEventInitialization } = {}): InMemorySpeakerOperationsRepository {
  return new InMemorySpeakerOperationsRepository({
    ...options,
    defaultEventInitialization: options.defaultEventInitialization ?? (options.db ? { kind: "ordinary" } : { kind: "evaluator-demo" }),
  });
}

const durableRepositories = new WeakMap<object, InMemorySpeakerOperationsRepository>();

export function getSyntheticSpeakerOperationsRepository(db?: Db): InMemorySpeakerOperationsRepository {
  if (db) {
    const existing = durableRepositories.get(db);
    if (existing) return existing;
    const repository = createSyntheticSpeakerOperationsRepository({
      db,
      clock: createWallMonotonicClock(),
      defaultEventInitialization: { kind: "ordinary" },
    });
    durableRepositories.set(db, repository);
    return repository;
  }
  const globalKey = "__sympose_speaker_operations_repository__";
  const globalValue = globalThis as typeof globalThis & { [globalKey]?: InMemorySpeakerOperationsRepository };
  if (!globalValue[globalKey]) globalValue[globalKey] = createSyntheticSpeakerOperationsRepository({ defaultEventInitialization: { kind: "ordinary" } });
  return globalValue[globalKey]!;
}

export * from "./manual-speakers";
