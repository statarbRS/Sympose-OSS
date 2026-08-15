import type {
  ContentApproval,
  ContentComment,
  ContentFinding,
  ContentKind,
  ContentOperationsRepository,
  ContentReviewProjection,
  ContentRevisionRequest,
  ContentSubmissionVersion,
  SocialLink,
} from "../content-operations";
import type { SpeakerGateTarget, SpeakerReadinessResult } from "../../adapters/speaker-readiness";

export const SPEAKER_OPERATIONS_SCHEMA = "sympose-speaker-operations/v1" as const;
export const SPEAKER_PORTAL_PURPOSE = "speaker-content" as const;

export const SPEAKER_ROLES = ["SPEAKER", "MODERATOR"] as const;
export type SpeakerRole = (typeof SPEAKER_ROLES)[number];

export const SPEAKER_CSV_IMPORT_SCHEMA = "sympose-speaker-csv-import/v1" as const;
export const SPEAKER_CSV_IMPORT_LEGACY_COLUMNS = ["full_name", "email", "organization", "title", "role", "program_unit"] as const;
export const SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS = ["name", "email", "title", "company", "bio"] as const;
/** Backwards-compatible name for the original six-column import contract. */
export const SPEAKER_CSV_IMPORT_COLUMNS = SPEAKER_CSV_IMPORT_LEGACY_COLUMNS;
export type SpeakerCsvImportLegacyColumn = (typeof SPEAKER_CSV_IMPORT_LEGACY_COLUMNS)[number];
export type SpeakerCsvImportEvaluatorColumn = (typeof SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS)[number];
export type SpeakerCsvImportColumn = SpeakerCsvImportLegacyColumn | SpeakerCsvImportEvaluatorColumn;
export type SpeakerCsvImportColumns = typeof SPEAKER_CSV_IMPORT_LEGACY_COLUMNS | typeof SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS;
export const SPEAKER_CSV_MAX_CHARACTERS = 64_000 as const;
export const SPEAKER_CSV_MAX_ROWS = 100 as const;

export type SpeakerCsvImportRowStatus = "CREATED" | "MERGED" | "REJECTED";

export interface SpeakerCsvImportRowReceipt {
  readonly rowNumber: number;
  readonly status: SpeakerCsvImportRowStatus;
  readonly personId: string | null;
  readonly detail: string;
}

export interface SpeakerCsvImportReceipt {
  readonly schema: typeof SPEAKER_CSV_IMPORT_SCHEMA;
  readonly receiptId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly columns: SpeakerCsvImportColumns;
  readonly rowCount: number;
  readonly createdCount: number;
  readonly mergedCount: number;
  readonly rejectedCount: number;
  readonly rows: readonly SpeakerCsvImportRowReceipt[];
  readonly emailSent: false;
  readonly fileBytesStored: false;
}

export const INVITATION_STATES = ["DRAFT", "READY", "SENT", "DELIVERED", "OPENED", "RESPONDED", "EXPIRED", "CANCELED"] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

export const ASSIGNMENT_DECISION_STATES = ["PROPOSED", "APPROVED", "REJECTED", "SUPERSEDED"] as const;
export type AssignmentDecisionState = (typeof ASSIGNMENT_DECISION_STATES)[number];

export const COMMITMENT_STATES = ["PENDING", "ACCEPTED", "DECLINED", "WITHDRAWN", "RECONFIRMATION_REQUIRED"] as const;
export type CommitmentState = (typeof COMMITMENT_STATES)[number];

export const SPEAKER_TASK_STATES = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "CHANGES_REQUESTED", "COMPLETED", "BLOCKED"] as const;
export type SpeakerTaskState = (typeof SPEAKER_TASK_STATES)[number];

/**
 * Organizer workflow is an operational projection, independent from invitation, commitment,
 * task, and readiness truth. Changes are appended as speaker operation domain events.
 */
export const SPEAKER_WORKFLOW_STATUSES = ["NEW", "IN_PROGRESS", "READY", "ON_HOLD", "COMPLETED"] as const;
export type SpeakerWorkflowStatus = (typeof SPEAKER_WORKFLOW_STATUSES)[number];

export const SPEAKER_TASK_KINDS = ["PROFILE", "BIO", "SESSION_TITLE", "SESSION_DESCRIPTION", "HEADSHOT", "SLIDES", "LOGISTICS", "ACKNOWLEDGEMENT", "BRIEFING", "ACTION"] as const;
export type SpeakerTaskKind = (typeof SPEAKER_TASK_KINDS)[number];

export const SPEAKER_TASK_CONTENT_KIND_BY_KIND = {
  PROFILE: "PROFILE",
  BIO: "BIO",
  SESSION_TITLE: "SESSION_TITLE",
  SESSION_DESCRIPTION: "SESSION_DESCRIPTION",
  HEADSHOT: "HEADSHOT",
  SLIDES: "SLIDES",
  LOGISTICS: "LOGISTICS",
  ACKNOWLEDGEMENT: "ACKNOWLEDGEMENT",
  BRIEFING: null,
  ACTION: null,
} as const satisfies Readonly<Record<SpeakerTaskKind, ContentKind | null>>;

export function isValidSpeakerTaskContentPair(kind: unknown, contentKind: unknown): kind is SpeakerTaskKind {
  return typeof kind === "string" &&
    SPEAKER_TASK_KINDS.includes(kind as SpeakerTaskKind) &&
    SPEAKER_TASK_CONTENT_KIND_BY_KIND[kind as SpeakerTaskKind] === contentKind;
}

export const ORGANIZER_SPEAKER_TASK_TEMPLATES = [
  { value: "SLIDES", label: "Slides / supporting asset", kind: "SLIDES", contentKind: "SLIDES" },
  { value: "HEADSHOT", label: "Headshot PNG", kind: "HEADSHOT", contentKind: "HEADSHOT" },
  { value: "PROFILE", label: "Profile revision", kind: "PROFILE", contentKind: "PROFILE" },
  { value: "BIO", label: "Bio", kind: "BIO", contentKind: "BIO" },
  { value: "SESSION_DESCRIPTION", label: "Session description", kind: "SESSION_DESCRIPTION", contentKind: "SESSION_DESCRIPTION" },
  { value: "ACKNOWLEDGEMENT", label: "Acknowledgement", kind: "ACKNOWLEDGEMENT", contentKind: "ACKNOWLEDGEMENT" },
  { value: "BRIEFING", label: "Rehearsal / briefing", kind: "BRIEFING", contentKind: null },
] as const satisfies readonly {
  readonly value: string;
  readonly label: string;
  readonly kind: SpeakerTaskKind;
  readonly contentKind: ContentKind | null;
}[];

export type OrganizerSpeakerTaskTemplate = (typeof ORGANIZER_SPEAKER_TASK_TEMPLATES)[number]["value"];

export function resolveOrganizerSpeakerTaskTemplate(value: unknown): {
  readonly kind: SpeakerTaskKind;
  readonly contentKind: ContentKind | null;
} | null {
  if (typeof value !== "string") return null;
  const template = ORGANIZER_SPEAKER_TASK_TEMPLATES.find((candidate) => candidate.value === value);
  return template ? { kind: template.kind, contentKind: template.contentKind } : null;
}

export const SHARED_ACTION_TASK_SCHEMA = "speaker-shared-action-task/v1" as const;
export const SHARED_ACTION_TASK_RECEIPT_SCHEMA = "speaker-shared-action-task-receipt/v1" as const;
export const SHARED_ACTION_TASK_REMINDER_SCHEMA = "speaker-action-task-reminder/v1" as const;
export const SHARED_ACTION_TASK_REMINDER_RECEIPT_SCHEMA = "speaker-action-task-reminder-receipt/v1" as const;
export const SHARED_ACTION_TASK_REMINDER_PROVIDER_RECEIPT_SCHEMA = "speaker-action-task-reminder-provider-receipt/v1" as const;
export const SHARED_ACTION_TASK_REMINDER_JOB_SCHEMA = "speaker-action-task-reminder-job/v1" as const;
export const SHARED_ACTION_TASK_MIN_ASSIGNEES = 2 as const;
export const SHARED_ACTION_TASK_MAX_ASSIGNEES = 100 as const;
export const SHARED_ACTION_TASK_MAX_INSTRUCTIONS = 2_000 as const;
export const SHARED_ACTION_TASK_MAX_DUE_DAYS = 366 as const;
export const SHARED_ACTION_TASK_REMINDER_WINDOW_DAYS = 7 as const;
export const SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS = 100 as const;
export const SHARED_ACTION_TASK_MAX_SELECTABLE_SPEAKERS = 500 as const;
export const SHARED_ACTION_TASK_REMINDER_MAX_EVENT_SCOPES = 50 as const;
export const SHARED_ACTION_TASK_REMINDER_MAX_DELIVERIES = 50 as const;
export const SHARED_ACTION_TASK_REMINDER_MAX_ATTEMPTS = 3 as const;

export type SpeakerAccessRole = "organizer" | "portal";

export interface SpeakerEventContext {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export type SpeakerEventFixtureContext = "ordinary" | "evaluator-demo";

export interface SpeakerEventInitialization {
  readonly kind: SpeakerEventFixtureContext;
}

export interface SpeakerOrganizerScope {
  readonly kind: "organizer";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly actorId: string;
}

export interface SpeakerPortalTokenProjection {
  readonly purpose: typeof SPEAKER_PORTAL_PURPOSE;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly assignmentId: string;
  readonly planVersionId: string;
  readonly planVersionFingerprint: string;
  readonly acceptedTermsFingerprint: string;
  readonly authorityFingerprint: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly active: boolean;
}

export interface CanonicalPersonProjection {
  readonly personId: string;
  readonly fullName: string;
  readonly organization: string;
  readonly title: string;
  readonly canonicalIdentity: "Person";
}

export interface SpeakerInvitationProjection {
  readonly id: string;
  readonly personId: string;
  readonly invitationType: "CONTENT_AND_ROLE" | "SCHEDULE_NOTICE";
  readonly state: InvitationState;
  readonly sourcePlanVersionId: string;
  readonly sourcePlanAssignmentId: string;
  readonly assignmentLineageId: string;
  readonly commitmentOfferId: string;
  readonly offeredTerms: SpeakerOfferTerms;
  readonly termsFingerprint: string;
  readonly deliveredAt: string | null;
  readonly respondedAt: string | null;
  readonly response: SpeakerInvitationResponseProjection | null;
  readonly deliveryEvidence: SpeakerCommunicationEvidence;
}

export interface SpeakerOfferTerms {
  readonly schema: "speaker-offer-terms/v1";
  readonly eventId: string;
  readonly eventName: string;
  readonly timezone: string;
  readonly role: SpeakerRole;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location: string;
  readonly materialFields: readonly ["role", "programUnitId", "startsAt", "endsAt", "location"];
}

export interface SpeakerInvitationResponseProjection {
  readonly id: string;
  readonly offerId: string;
  readonly offerTermsFingerprint: string;
  readonly state: Extract<CommitmentState, "ACCEPTED" | "DECLINED">;
  readonly respondedAt: string;
  readonly commandFingerprint: string;
}

export interface SpeakerAssignmentProjection {
  readonly assignmentId: string;
  readonly assignmentLineageId: string;
  readonly personId: string;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly role: SpeakerRole;
  readonly decision: AssignmentDecisionState;
  readonly sourcePlanVersionId: string;
  readonly sourcePlanAssignmentId: string;
  readonly schedule: {
    readonly startsAt: string;
    readonly endsAt: string;
    readonly timezone: string;
    readonly location: string;
  };
  readonly commitment: {
    readonly state: CommitmentState;
    readonly offerId: string;
    readonly offerTermsFingerprint: string;
    readonly responseId: string | null;
    readonly respondedAt: string | null;
  };
}

export interface SpeakerTaskTransition {
  readonly id: string;
  readonly from: SpeakerTaskState;
  readonly to: SpeakerTaskState;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly evidenceVersionId: string | null;
}

export interface SpeakerTaskProjection {
  readonly id: string;
  readonly personId: string;
  readonly assignmentId: string;
  readonly kind: SpeakerTaskKind;
  readonly contentKind: ContentKind | null;
  readonly title: string;
  readonly description: string;
  readonly required: boolean;
  readonly gate: "CONFIRMATION" | "PUBLICATION" | "OPERATOR_RELEASE" | null;
  readonly dueAt: string;
  readonly owner: "SPEAKER" | "ORGANIZER";
  readonly state: SpeakerTaskState;
  readonly dueState: "UPCOMING" | "DUE_SOON" | "OVERDUE" | "COMPLETE";
  readonly submissionVersionId: string | null;
  readonly submissionContentHash: string | null;
  readonly transitions: readonly SpeakerTaskTransition[];
  readonly review: ContentReviewProjection | null;
}

export interface SpeakerProfileSnapshot {
  readonly bio: string;
  readonly publicTitle: string;
  readonly organization: string;
  readonly socialLinks: readonly SocialLink[];
  readonly headshot: {
    readonly assetId: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly checksum: string;
    readonly storageRef: `synthetic://${string}`;
  } | null;
  readonly sourceVersionId: string;
  readonly sourceContentHash: string;
}

export interface SpeakerProfileProjection {
  readonly workspaceProfile: SpeakerProfileSnapshot;
  readonly eventOverride: SpeakerProfileSnapshot;
  readonly pendingRevision: {
    readonly versionId: string;
    readonly contentHash: string;
    readonly reviewState: string;
  } | null;
  readonly publicSnapshotIsUnchanged: boolean;
}

export interface SpeakerReadinessProjection {
  readonly asOf: string;
  readonly eligible: boolean;
  readonly computationFingerprint: string;
  readonly gates: readonly {
    readonly gate: SpeakerGateTarget;
    readonly eligible: boolean;
    readonly blockerCount: number;
    readonly blockerCodes: readonly string[];
  }[];
  readonly sourceCount: number;
  readonly evaluator: SpeakerReadinessResult;
}

export interface SpeakerLogisticsProjection {
  readonly status: "NOT_COLLECTED" | "SUBMITTED" | "CONFIRMED";
  readonly arrivalWindow: string | null;
  readonly travelMode: "LOCAL" | "TRAIN" | "AIR" | "REMOTE" | "UNKNOWN";
  readonly dietaryNotesProvided: boolean;
  readonly sourceEvidence: {
    readonly type: "LOGISTICS_SUBMISSION" | "EVENT_CONTEXT";
    readonly id: string;
    readonly fingerprint: string;
  };
}

export interface SpeakerCommunicationEvidence {
  readonly id: string;
  readonly eventId: string;
  readonly invitationId: string;
  readonly kind: "INVITATION" | "REMINDER";
  readonly channel: "in-app-simulation";
  readonly deliveryState: "SIMULATED_DELIVERED" | "NOT_SENT";
  readonly simulated: true;
  readonly occurredAt: string;
  readonly templateKey: "speaker-invitation-v1" | "speaker-reminder-v1";
  readonly renderedPreview: string;
  readonly payloadFingerprint: string;
  readonly recipientPersonId: string;
  readonly commitmentStateIsSeparate: true;
}

export interface SpeakerRosterRecord {
  readonly person: CanonicalPersonProjection;
  readonly role: SpeakerRole;
  readonly workflowStatus: SpeakerWorkflowStatus;
  readonly workflowStatusVersion: string | null;
  readonly invitation: SpeakerInvitationProjection;
  readonly assignment: SpeakerAssignmentProjection;
  readonly tasks: readonly SpeakerTaskProjection[];
  readonly profile: SpeakerProfileProjection;
  readonly readiness: SpeakerReadinessProjection;
  readonly logistics: SpeakerLogisticsProjection;
  readonly communications: readonly SpeakerCommunicationEvidence[];
  readonly lastActivityAt: string;
}

export interface SpeakerRosterFilter {
  readonly query?: string;
  readonly role?: SpeakerRole;
  readonly workflowStatus?: SpeakerWorkflowStatus;
  readonly invitationState?: InvitationState;
  readonly commitmentState?: CommitmentState;
  readonly taskState?: SpeakerTaskState;
  readonly readinessGate?: SpeakerGateTarget;
  readonly overdueOnly?: boolean;
}

export interface SpeakerReadinessMatrixRow {
  readonly personId: string;
  readonly personName: string;
  readonly role: SpeakerRole;
  readonly assignmentId: string;
  readonly commitmentState: CommitmentState;
  readonly requiredTaskCount: number;
  readonly completedRequiredTaskCount: number;
  readonly overdueTaskCount: number;
  readonly blockers: readonly string[];
  readonly lastActivityAt: string;
}

export interface SpeakerOrganizerProjection {
  readonly schema: typeof SPEAKER_OPERATIONS_SCHEMA;
  readonly access: { readonly kind: "organizer"; readonly workspaceId: string; readonly eventId: string; readonly actorId: string };
  readonly event: SpeakerEventContext;
  readonly asOf: string;
  readonly roster: readonly SpeakerRosterRecord[];
  readonly dashboard: {
    readonly rosterCount: number;
    readonly acceptedCommitmentCount: number;
    readonly awaitingResponseCount: number;
    readonly overdueTaskCount: number;
    readonly readinessBlockerCount: number;
    readonly submittedContentCount: number;
  };
  readonly readinessMatrix: readonly SpeakerReadinessMatrixRow[];
  readonly lastCsvImport: SpeakerCsvImportReceipt | null;
  readonly download: {
    readonly format: "text/csv";
    readonly rowCount: number;
    readonly metadataOnly: true;
    readonly suggestedFileName: string;
  };
  readonly communicationsBoundary: "simulated-local-delivery-evidence-only";
  readonly fileBoundary: "authenticated-scoped-artifact-downloads";
}

export interface SpeakerPortalProjection {
  readonly schema: typeof SPEAKER_OPERATIONS_SCHEMA;
  readonly access: {
    readonly kind: "portal";
    readonly purpose: typeof SPEAKER_PORTAL_PURPOSE;
    readonly workspaceId: string;
    readonly eventId: string;
    readonly personId: string;
    readonly assignmentId: string;
    readonly planVersionId: string;
    readonly planVersionFingerprint: string;
    readonly acceptedTermsFingerprint: string;
    readonly authorityFingerprint: string;
    readonly expiresAt: string;
  };
  readonly event: SpeakerEventContext;
  readonly person: CanonicalPersonProjection;
  readonly invitation: SpeakerInvitationProjection;
  readonly assignment: SpeakerAssignmentProjection;
  readonly tasks: readonly SpeakerTaskProjection[];
  readonly profile: SpeakerProfileProjection;
  readonly readiness: SpeakerReadinessProjection;
  readonly logistics: SpeakerLogisticsProjection;
  readonly communications: readonly SpeakerCommunicationEvidence[];
  readonly contentReviews: readonly ContentReviewProjection[];
  readonly privacyNotice: "role-scoped-speaker-projection-no-organizer-navigation";
  readonly localProjectionNotice: "synthetic-local-projection-provider-adapters-not-configured";
}

export interface RespondToInvitationResult {
  readonly response: SpeakerInvitationResponseProjection;
  readonly portal: SpeakerPortalProjection;
  readonly created: boolean;
}

export interface CompleteSpeakerTaskResult {
  readonly task: SpeakerTaskProjection;
  readonly portal: SpeakerPortalProjection;
  readonly created: boolean;
}

export interface UpdateSpeakerWorkflowStatusResult {
  readonly status: SpeakerWorkflowStatus;
  readonly version: string | null;
  readonly created: boolean;
}

export interface UpdateSpeakerWorkflowStatusInput {
  readonly status: SpeakerWorkflowStatus;
  readonly expectedCurrentStatus: SpeakerWorkflowStatus;
  readonly expectedVersion: string | null;
  readonly idempotencyKey: string;
}

export interface SharedActionTaskAssignmentProjection {
  readonly taskId: string;
  readonly personId: string;
  readonly assignmentId: string;
  readonly speakerName: string;
  readonly state: SpeakerTaskState;
}

export interface SharedActionTaskAssigneeProjection {
  readonly personId: string;
  readonly fullName: string;
  readonly role: SpeakerRole;
  readonly assignmentId: string;
}

export interface SharedActionTaskBatchProjection {
  readonly schema: typeof SHARED_ACTION_TASK_SCHEMA;
  readonly definitionId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly title: string;
  readonly instructions: string;
  /** Date-only organizer input. It is due through 23:59:59.999 UTC on this date. */
  readonly dueDate: string;
  readonly dueAt: string;
  readonly createdAt: string;
  readonly requestFingerprint: string;
  readonly assignmentCount: number;
  readonly completedCount: number;
  readonly assignments: readonly SharedActionTaskAssignmentProjection[];
}

export interface CreateSharedActionTaskInput {
  readonly assigneePersonIds: readonly string[];
  readonly title: string;
  readonly instructions: string;
  readonly dueDate: string;
  readonly idempotencyKey: string;
}

export interface SharedActionTaskReceipt extends SharedActionTaskBatchProjection {
  readonly receiptSchema: typeof SHARED_ACTION_TASK_RECEIPT_SCHEMA;
  readonly created: boolean;
}

export type SharedActionTaskReminderDeliveryStatus = "PENDING" | "CLAIMED" | "DELIVERED" | "FAILED";

export interface SharedActionTaskReminderDelivery {
  readonly messageId: string;
  readonly domainEventId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly definitionId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly recipientPersonId: string;
  readonly recipientName: string;
  readonly recipientEmail: string;
  readonly occurrenceDate: string;
  readonly eventName: string;
  readonly taskTitle: string;
  readonly taskInstructions: string;
  readonly dueDate: string;
  readonly dueAt: string;
  readonly subjectPreview: string;
  readonly bodyPreview: string;
  readonly destinationKey: string;
  readonly payloadFingerprint: string;
  readonly status: SharedActionTaskReminderDeliveryStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly lastErrorRecorded: boolean;
  readonly providerReceiptId: string | null;
  readonly providerAcceptedAt: string | null;
  readonly deliveryMode: "NO_NETWORK_SIMULATED" | null;
  readonly channel: "local";
  readonly providerMutation: false;
}

export interface SharedActionTaskReminderReceipt {
  readonly schema: typeof SHARED_ACTION_TASK_REMINDER_RECEIPT_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly occurrenceDate: string;
  /** Incomplete overdue tasks and tasks due before this exclusive UTC boundary are eligible. */
  readonly windowEndExclusive: string;
  readonly scannedCount: number;
  readonly maximumScanAssignments: typeof SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS;
  readonly queuedCount: number;
  readonly skippedCount: number;
  readonly alreadyQueuedCount: number;
  readonly completedCount: number;
  readonly notDueCount: number;
  readonly nonCurrentSpeakerCount: number;
  readonly queued: readonly SharedActionTaskReminderDelivery[];
  readonly channel: "local";
  readonly providerMutation: false;
}

export interface ActionTaskReminderDeliveryIntent {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly recipientPersonId: string;
  readonly recipientName: string;
  readonly recipientEmail: string;
  readonly messageId: string;
  readonly occurrenceDate: string;
  readonly subject: string;
  readonly body: string;
  readonly payloadFingerprint: string;
  readonly idempotencyKey: string;
}

export interface ActionTaskReminderProviderReceipt {
  readonly schema: typeof SHARED_ACTION_TASK_REMINDER_PROVIDER_RECEIPT_SCHEMA;
  readonly providerReceiptId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
  readonly acceptedAt: string;
  readonly deliveryMode: "NO_NETWORK_SIMULATED";
  readonly networkContacted: false;
  readonly providerMutation: false;
}

/** A reminder adapter is deliberately no-network until a separately reviewed provider exists. */
export interface ActionTaskReminderDeliveryAdapter {
  readonly kind: string;
  readonly networkContacted: false;
  readonly providerMutation: false;
  deliver(intent: ActionTaskReminderDeliveryIntent): ActionTaskReminderProviderReceipt;
}

export interface AutomaticActionTaskReminderPreparationReceipt {
  readonly schema: typeof SHARED_ACTION_TASK_REMINDER_JOB_SCHEMA;
  readonly triggeredAt: string;
  readonly eventScopeCount: number;
  readonly scannedCount: number;
  readonly queuedCount: number;
  readonly alreadyQueuedCount: number;
  readonly completedCount: number;
  readonly notDueCount: number;
  readonly nonCurrentSpeakerCount: number;
  readonly inactiveEventCount: number;
  readonly providerMutation: false;
}

export interface AutomaticActionTaskReminderJobReceipt extends AutomaticActionTaskReminderPreparationReceipt {
  readonly processedCount: number;
  readonly claimedCount: number;
  readonly deliveredCount: number;
  readonly retryingCount: number;
  readonly failedCount: number;
  readonly recoveredReceiptCount: number;
  readonly stoppedBeforeDeliveryCount: number;
  readonly maximumAttempts: typeof SHARED_ACTION_TASK_REMINDER_MAX_ATTEMPTS;
  readonly deliveryMode: "NO_NETWORK_SIMULATED";
  readonly networkContacted: false;
}

export interface SubmitSpeakerContentResult {
  readonly version: ContentSubmissionVersion;
  readonly task: SpeakerTaskProjection;
  readonly portal: SpeakerPortalProjection;
}

export interface SpeakerProfileUpdateInput {
  readonly bio: string;
  readonly publicTitle: string;
  readonly organization: string;
  readonly socialLinks: readonly SocialLink[];
  readonly headshot: unknown;
  readonly idempotencyKey?: string;
}

export interface CreateSpeakerTaskInput {
  readonly personId: string;
  readonly kind: SpeakerTaskKind;
  readonly contentKind: ContentKind | null;
  readonly title: string;
  readonly description: string;
  readonly required: boolean;
  readonly gate: SpeakerTaskProjection["gate"];
  readonly dueAt: string;
  readonly owner: "SPEAKER" | "ORGANIZER";
  readonly idempotencyKey?: string;
}

export interface UpdateSpeakerTaskInput {
  readonly dueAt?: string;
  readonly state?: SpeakerTaskState;
  readonly note?: string;
  readonly idempotencyKey?: string;
}

export interface CompleteSpeakerTaskInput {
  readonly note?: string;
  readonly idempotencyKey?: string;
}

export interface SpeakerOperationsRepository {
  readonly schema: typeof SPEAKER_OPERATIONS_SCHEMA;
  readonly content: ContentOperationsRepository;
  initializeEvent(workspaceId: string, event: SpeakerEventContext, initialization: SpeakerEventInitialization): void;
  getOrganizerProjection(scope: SpeakerOrganizerScope, event: SpeakerEventContext, filter?: SpeakerRosterFilter): SpeakerOrganizerProjection;
  listSpeakerRoster(scope: SpeakerOrganizerScope, event: SpeakerEventContext, filter?: SpeakerRosterFilter): readonly SpeakerRosterRecord[];
  resolvePortalToken(token: string, lookupBudgetKey?: string): SpeakerPortalTokenProjection | null;
  getPortalProjection(token: string, lookupBudgetKey?: string): SpeakerPortalProjection | null;
  getPortalProjectionForResolvedAccess(token: string, access: SpeakerPortalTokenProjection): SpeakerPortalProjection | null;
  respondToInvitation(token: string, invitationId: string, response: Extract<CommitmentState, "ACCEPTED" | "DECLINED">, lookupBudgetKey?: string): RespondToInvitationResult;
  completeTask(token: string, taskId: string, input?: CompleteSpeakerTaskInput, lookupBudgetKey?: string): CompleteSpeakerTaskResult;
  submitContent(token: string, taskId: string, payload: unknown, idempotencyKey?: string, lookupBudgetKey?: string): SubmitSpeakerContentResult;
  submitContentWithRollbackForResolvedAccess(token: string, access: SpeakerPortalTokenProjection, taskId: string, payload: unknown, idempotencyKey?: string): { readonly result: SubmitSpeakerContentResult; readonly rollback: () => void };
  updateProfile(token: string, input: SpeakerProfileUpdateInput, lookupBudgetKey?: string): SubmitSpeakerContentResult;
  submitOrganizerContent(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly payload: unknown; readonly idempotencyKey?: string }): ContentSubmissionVersion;
  restoreContent(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly idempotencyKey?: string }): ContentSubmissionVersion;
  createTask(scope: SpeakerOrganizerScope, input: CreateSpeakerTaskInput): SpeakerTaskProjection;
  createSharedActionTask(scope: SpeakerOrganizerScope, input: CreateSharedActionTaskInput): SharedActionTaskReceipt;
  listSharedActionTaskAssignees(scope: SpeakerOrganizerScope): readonly SharedActionTaskAssigneeProjection[];
  listSharedActionTasks(scope: SpeakerOrganizerScope): readonly SharedActionTaskBatchProjection[];
  queueDueActionTaskReminders(scope: SpeakerOrganizerScope): SharedActionTaskReminderReceipt;
  listActionTaskReminderDeliveries(scope: SpeakerOrganizerScope): readonly SharedActionTaskReminderDelivery[];
  updateWorkflowStatus(scope: SpeakerOrganizerScope, personId: string, input: UpdateSpeakerWorkflowStatusInput): UpdateSpeakerWorkflowStatusResult;
  updateTask(scope: SpeakerOrganizerScope, taskId: string, input: UpdateSpeakerTaskInput): SpeakerTaskProjection;
  sendInvitation(scope: SpeakerOrganizerScope, personId: string, idempotencyKey?: string): SpeakerCommunicationEvidence;
  sendReminder(scope: SpeakerOrganizerScope, personIds: readonly string[], idempotencyKey?: string): readonly SpeakerCommunicationEvidence[];
  addComment(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly body: string; readonly idempotencyKey?: string }): ContentComment;
  addFinding(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly severity: "INFO" | "WARNING" | "BLOCKER"; readonly message: string; readonly blocksReadiness?: boolean; readonly idempotencyKey?: string }): ContentFinding;
  requestRevision(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly reason: string; readonly idempotencyKey?: string }): ContentRevisionRequest;
  approveContent(scope: SpeakerOrganizerScope, input: { readonly personId: string; readonly taskId: string; readonly submissionVersionId: string; readonly submissionContentHash: string; readonly gate?: ContentApproval["gate"]; readonly idempotencyKey?: string }): ContentApproval;
  exportReadinessCsv(scope: SpeakerOrganizerScope, event: SpeakerEventContext, filter?: SpeakerRosterFilter): { readonly fileName: string; readonly contentType: "text/csv"; readonly body: string; readonly rowCount: number };
  exportContentMetadata(scope: SpeakerOrganizerScope, event: SpeakerEventContext, submissionVersionIds?: readonly string[]): { readonly fileName: string; readonly contentType: "text/csv"; readonly body: string; readonly rowCount: number; readonly metadataOnly: true };
  importSpeakerCsv(scope: SpeakerOrganizerScope, event: SpeakerEventContext, csvText: string, idempotencyKey?: string): SpeakerCsvImportReceipt;
}

export type SpeakerContentReviewCommand = Parameters<SpeakerOperationsRepository["addComment"]>[1] | Parameters<SpeakerOperationsRepository["addFinding"]>[1] | Parameters<SpeakerOperationsRepository["requestRevision"]>[1] | Parameters<SpeakerOperationsRepository["approveContent"]>[1];
