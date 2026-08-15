"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { deterministicUuid } from "@/server/canonical";
import { getDb } from "@/server/db";
import { getEvent } from "@/server/services/events";
import {
  getSyntheticSpeakerOperationsRepository,
  createManualSpeaker as persistManualSpeaker,
  editManualSpeaker as persistManualSpeakerEdit,
  manualSpeakerCreateIdempotencyKey,
  manualSpeakerEditIdempotencyKey,
  speakerEventInitializationFor,
  SPEAKER_CSV_MAX_CHARACTERS,
  SHARED_ACTION_TASK_MAX_ASSIGNEES,
  SHARED_ACTION_TASK_MAX_DUE_DAYS,
  SHARED_ACTION_TASK_MAX_INSTRUCTIONS,
  SHARED_ACTION_TASK_MIN_ASSIGNEES,
  SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS,
  SPEAKER_WORKFLOW_STATUSES,
  resolveOrganizerSpeakerTaskTemplate,
  SpeakerOperationsAuthorizationError,
  SpeakerOperationsConflictError,
  SpeakerOperationsInputError,
  type SharedActionTaskBatchProjection,
  type SharedActionTaskReminderDelivery,
  type SharedActionTaskReminderReceipt,
  type SharedActionTaskReceipt,
  type SpeakerWorkflowStatus,
} from "@/server/services/speaker-operations";
import { CONTENT_KINDS, type ContentKind } from "@/server/services/content-operations";
import { issueSpeakerPortalToken } from "@/server/services/speaker-portal-access";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

function requiredText(formData: FormData, name: string, max = 240): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max) {
    throw new Error("INVALID_SPEAKER_COMMAND");
  }
  return value.trim();
}

function optionalText(formData: FormData, name: string, max = 240): string {
  const value = formData.get(name);
  if (value === null) return "";
  if (typeof value !== "string" || value.length > max) throw new Error("INVALID_SPEAKER_COMMAND");
  return value.trim();
}

function jsonValue(formData: FormData, name: string, max: number): unknown {
  try {
    return JSON.parse(requiredText(formData, name, max)) as unknown;
  } catch {
    throw new Error("INVALID_SPEAKER_COMMAND");
  }
}

export async function readBoundedSpeakerCsvInput(formData: FormData): Promise<string> {
  const uploaded = formData.get("csvFile");
  const isFile = typeof File !== "undefined" && uploaded instanceof File;
  if (uploaded !== null && !isFile) {
    throw new Error("INVALID_SPEAKER_COMMAND");
  }
  if (isFile && uploaded.name.length > 0) {
    const allowedTypes = new Set(["", "text/csv", "application/csv", "text/plain"]);
    if (!allowedTypes.has(uploaded.type.toLowerCase()) || uploaded.size < 1 || uploaded.size > SPEAKER_CSV_MAX_CHARACTERS * 4) {
      throw new Error("INVALID_SPEAKER_COMMAND");
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await uploaded.arrayBuffer();
    } catch {
      throw new Error("INVALID_SPEAKER_COMMAND");
    }
    if (bytes.byteLength !== uploaded.size || bytes.byteLength > SPEAKER_CSV_MAX_CHARACTERS * 4) {
      throw new Error("INVALID_SPEAKER_COMMAND");
    }
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("INVALID_SPEAKER_COMMAND");
    }
    if (value.length > SPEAKER_CSV_MAX_CHARACTERS) throw new Error("INVALID_SPEAKER_COMMAND");
    return value;
  }
  return requiredText(formData, "csvText", SPEAKER_CSV_MAX_CHARACTERS);
}

function syntheticAsset(formData: FormData, prefix = "headshot"): Record<string, unknown> | null {
  const assetId = optionalText(formData, `${prefix}AssetId`, 160);
  if (!assetId) return null;
  return {
    assetId,
    fileName: requiredText(formData, `${prefix}FileName`, 180),
    mediaType: requiredText(formData, `${prefix}MediaType`, 160),
    byteSize: Number(requiredText(formData, `${prefix}ByteSize`, 24)),
    checksum: requiredText(formData, `${prefix}Checksum`, 64),
    storageRef: requiredText(formData, `${prefix}StorageRef`, 180),
  };
}

async function organizerContext(formData: FormData) {
  const routeWorkspaceSlug = requiredText(formData, "workspace");
  const eventId = requiredText(formData, "eventId");
  return organizerRouteContext(routeWorkspaceSlug, eventId);
}

async function organizerRouteContext(routeWorkspaceSlug: string, eventId: string) {
  if (routeWorkspaceSlug.length < 1 || routeWorkspaceSlug.length > 128 || eventId.length < 1 || eventId.length > 160) {
    throw new Error("INVALID_SPEAKER_COMMAND");
  }
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, routeWorkspaceSlug);
  const db = getDb();
  const event = getEvent(db, session.workspaceId, eventId);
  if (!event) throw new Error("EVENT_NOT_FOUND");
  return { db, session, workspace: session.workspaceSlug, event };
}

export async function createManualSpeaker(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  const scope = { kind: "organizer" as const, workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId };
  const input = {
    fullName: requiredText(formData, "fullName", 240),
    email: requiredText(formData, "email", 320),
    title: optionalText(formData, "title", 240),
    organization: optionalText(formData, "organization", 240),
    bio: optionalText(formData, "bio", 4_000),
  };
  persistManualSpeaker(
    getDb(),
    scope,
    { ...input, idempotencyKey: manualSpeakerCreateIdempotencyKey(scope, input) },
  );
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export async function editManualSpeaker(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  const scope = { kind: "organizer" as const, workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId };
  const input = {
    personId: requiredText(formData, "personId"),
    expectedEmail: requiredText(formData, "email", 320),
    expectedFullName: requiredText(formData, "expectedFullName", 240),
    fullName: requiredText(formData, "fullName", 240),
    title: optionalText(formData, "title", 240),
    organization: optionalText(formData, "organization", 240),
    bio: optionalText(formData, "bio", 4_000),
  };
  persistManualSpeakerEdit(
    getDb(),
    scope,
    { ...input, idempotencyKey: manualSpeakerEditIdempotencyKey(scope, input) },
  );
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export async function openSyntheticSpeakerPortalPreview(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  const personId = requiredText(formData, "personId");
  const token = issueSpeakerPortalToken(getDb(), {
    workspaceId: session.workspaceId,
    eventId: event.id,
    personId,
  }, {
    accountId: session.accountId,
    sessionId: session.id,
  }).token;
  const store = await cookies();
  const secure = process.env.NODE_ENV === "production";
  store.set("sympose_speaker_portal", token, { httpOnly: true, sameSite: "lax", secure, path: "/speaker", maxAge: 1800 });
  store.set("sympose_speaker_support_preview", "synthetic-local", { httpOnly: true, sameSite: "lax", secure, path: "/speaker", maxAge: 1800 });
  redirect(`/speaker?from=${encodeURIComponent(workspace)}`);
}

export async function sendSpeakerInvitation(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  getSyntheticSpeakerOperationsRepository(getDb()).sendInvitation(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    requiredText(formData, "personId"),
    optionalText(formData, "idempotencyKey", 240) || undefined,
  );
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export async function importSpeakerCsv(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  getSyntheticSpeakerOperationsRepository(getDb()).importSpeakerCsv(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    { id: event.id, name: event.name, timezone: event.timezone, startsAt: event.startsAt, endsAt: event.endsAt },
    await readBoundedSpeakerCsvInput(formData),
    optionalText(formData, "idempotencyKey", 240) || undefined,
  );
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export async function createSpeakerTask(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  const taskTemplate = resolveOrganizerSpeakerTaskTemplate(formData.get("taskTemplate"));
  if (!taskTemplate) throw new Error("INVALID_SPEAKER_COMMAND");
  const gateValue = optionalText(formData, "gate", 40);
  if (gateValue && gateValue !== "CONFIRMATION" && gateValue !== "PUBLICATION" && gateValue !== "OPERATOR_RELEASE") throw new Error("INVALID_SPEAKER_COMMAND");
  try {
    getSyntheticSpeakerOperationsRepository(getDb()).createTask(
      { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
      {
        personId: requiredText(formData, "personId"),
        kind: taskTemplate.kind,
        contentKind: taskTemplate.contentKind,
        title: requiredText(formData, "title", 240),
        description: requiredText(formData, "description", 1200),
        required: formData.get("required") === "true",
        gate: gateValue ? gateValue as "CONFIRMATION" | "PUBLICATION" | "OPERATOR_RELEASE" : null,
        dueAt: requiredText(formData, "dueAt", 80),
        owner: "SPEAKER",
        idempotencyKey: optionalText(formData, "idempotencyKey", 240) || undefined,
      },
    );
  } catch (error) {
    if (error instanceof SpeakerOperationsInputError) throw new Error("INVALID_SPEAKER_COMMAND");
    if (error instanceof SpeakerOperationsAuthorizationError) throw new Error("SPEAKER_TASK_UNAVAILABLE");
    if (error instanceof SpeakerOperationsConflictError) throw new Error("SPEAKER_TASK_CONFLICT");
    throw error;
  }
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export interface SharedActionTaskSurfaceSpeaker {
  readonly personId: string;
  readonly fullName: string;
  readonly role: "SPEAKER" | "MODERATOR";
  readonly assignmentId: string;
}

export interface SharedActionTasksSurface {
  readonly workspace: string;
  readonly event: { readonly id: string; readonly name: string };
  readonly speakers: readonly SharedActionTaskSurfaceSpeaker[];
  readonly batches: readonly SharedActionTaskBatchProjection[];
  readonly reminders: readonly SharedActionTaskReminderDelivery[];
  readonly nextIdempotencyKey: string;
  readonly minimumDueDate: string;
  readonly defaultDueDate: string;
  readonly maximumDueDate: string;
  readonly minimumAssignees: typeof SHARED_ACTION_TASK_MIN_ASSIGNEES;
  readonly maximumAssignees: typeof SHARED_ACTION_TASK_MAX_ASSIGNEES;
  readonly maximumInstructions: typeof SHARED_ACTION_TASK_MAX_INSTRUCTIONS;
  readonly maximumReminderAssignments: typeof SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS;
}

export type CreateSharedActionTaskActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "success";
      readonly code: "SHARED_ACTION_TASK_CREATED" | "SHARED_ACTION_TASK_REPLAYED";
      readonly message: string;
      readonly receipt: Pick<SharedActionTaskReceipt, "definitionId" | "assignmentCount" | "completedCount" | "dueDate" | "created">;
      readonly revalidated: boolean;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export type QueueActionTaskRemindersActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "success";
      readonly code: "ACTION_TASK_REMINDERS_QUEUED";
      readonly message: string;
      readonly receipt: Pick<SharedActionTaskReminderReceipt,
        "occurrenceDate" | "windowEndExclusive" | "scannedCount" | "maximumScanAssignments" | "queuedCount" | "skippedCount" |
        "alreadyQueuedCount" | "completedCount" | "notDueCount" | "nonCurrentSpeakerCount" | "providerMutation">;
      readonly revalidated: boolean;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

function sharedActionError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof SpeakerOperationsInputError) {
    return { code: error.code, message: "Check the unique speakers, title, instructions, and bounded UTC due date." };
  }
  if (error instanceof SpeakerOperationsAuthorizationError) {
    return { code: error.code, message: "Every selected Person must remain a current accepted speaker for this exact event." };
  }
  if (error instanceof SpeakerOperationsConflictError) {
    return { code: error.code, message: "This command conflicts with immutable task history or an earlier idempotent request." };
  }
  if (error instanceof Error && error.message === "INVALID_SPEAKER_COMMAND") {
    return { code: "INVALID_SPEAKER_OPERATION_INPUT", message: "Check the unique speakers, title, instructions, and bounded UTC due date." };
  }
  return { code: "SHARED_ACTION_TASK_FAILED", message: "The shared ACTION task command could not be committed." };
}

function frameworkControlFlow(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const digest = (error as { readonly digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

function selectedSharedActionPersonIds(formData: FormData): readonly string[] {
  const values = formData.getAll("personId");
  if (values.length < SHARED_ACTION_TASK_MIN_ASSIGNEES || values.length > SHARED_ACTION_TASK_MAX_ASSIGNEES) {
    throw new Error("INVALID_SPEAKER_COMMAND");
  }
  if (values.some((value) => typeof value !== "string")) throw new Error("INVALID_SPEAKER_COMMAND");
  return values as string[];
}

function actionTaskRepositoryContext(context: Awaited<ReturnType<typeof organizerRouteContext>>) {
  const repository = getSyntheticSpeakerOperationsRepository(context.db);
  const eventContext = {
    id: context.event.id,
    name: context.event.name,
    timezone: context.event.timezone,
    startsAt: context.event.startsAt,
    endsAt: context.event.endsAt,
  };
  repository.initializeEvent(
    context.session.workspaceId,
    eventContext,
    speakerEventInitializationFor(context.session.workspaceId, context.event.id),
  );
  const scope = {
    kind: "organizer" as const,
    workspaceId: context.session.workspaceId,
    eventId: context.event.id,
    actorId: context.session.accountId,
  };
  return { repository, eventContext, scope };
}

function actionTaskDueDates(): Pick<SharedActionTasksSurface, "minimumDueDate" | "defaultDueDate" | "maximumDueDate"> {
  const today = new Date();
  const dayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return {
    minimumDueDate: new Date(dayStart).toISOString().slice(0, 10),
    defaultDueDate: new Date(dayStart + 2 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10),
    maximumDueDate: new Date(dayStart + SHARED_ACTION_TASK_MAX_DUE_DAYS * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10),
  };
}

/** Load current assignees plus durable shared-task and reminder projections for this exact organizer route. */
export async function loadSharedActionTasksSurface(workspace: string, eventId: string): Promise<SharedActionTasksSurface | null> {
  if (workspace.length < 1 || workspace.length > 128 || eventId.length < 1 || eventId.length > 160) return null;
  const context = await organizerRouteContext(workspace, eventId);
  const { repository, scope } = actionTaskRepositoryContext(context);
  const assignees = repository.listSharedActionTaskAssignees(scope);
  const batches = repository.listSharedActionTasks(scope);
  const reminders = repository.listActionTaskReminderDeliveries(scope);
  return {
    workspace: context.workspace,
    event: { id: context.event.id, name: context.event.name },
    speakers: assignees,
    batches,
    reminders,
    nextIdempotencyKey: deterministicUuid(`shared-action-task-form:${scope.workspaceId}:${scope.eventId}:${batches.length}`),
    ...actionTaskDueDates(),
    minimumAssignees: SHARED_ACTION_TASK_MIN_ASSIGNEES,
    maximumAssignees: SHARED_ACTION_TASK_MAX_ASSIGNEES,
    maximumInstructions: SHARED_ACTION_TASK_MAX_INSTRUCTIONS,
    maximumReminderAssignments: SHARED_ACTION_TASK_REMINDER_MAX_ASSIGNMENTS,
  };
}

/** Atomically create one immutable ACTION definition and one independent assignment per selected speaker. */
export async function createSharedActionTaskAction(
  _previousState: CreateSharedActionTaskActionState,
  formData: FormData,
): Promise<CreateSharedActionTaskActionState> {
  try {
    const context = await organizerContext(formData);
    const { repository, scope } = actionTaskRepositoryContext(context);
    const receipt = repository.createSharedActionTask(scope, {
      assigneePersonIds: selectedSharedActionPersonIds(formData),
      title: requiredText(formData, "title", 240),
      instructions: requiredText(formData, "instructions", SHARED_ACTION_TASK_MAX_INSTRUCTIONS),
      dueDate: requiredText(formData, "dueDate", 10),
      idempotencyKey: requiredText(formData, "idempotencyKey", 160),
    });
    let revalidated = true;
    try { revalidatePath(`/w/${context.workspace}/events/${context.event.id}/speakers`); } catch { revalidated = false; }
    return {
      kind: "success",
      code: receipt.created ? "SHARED_ACTION_TASK_CREATED" : "SHARED_ACTION_TASK_REPLAYED",
      message: `${receipt.created ? "Created" : "Replayed"} one ACTION task for ${receipt.assignmentCount} speakers atomically.`,
      receipt: {
        definitionId: receipt.definitionId,
        assignmentCount: receipt.assignmentCount,
        completedCount: receipt.completedCount,
        dueDate: receipt.dueDate,
        created: receipt.created,
      },
      revalidated,
    };
  } catch (error) {
    if (frameworkControlFlow(error)) throw error;
    return { kind: "error", ...sharedActionError(error) };
  }
}

/** Run the deterministic UTC due window and queue PENDING local outbox rows only. */
export async function queueActionTaskRemindersAction(
  _previousState: QueueActionTaskRemindersActionState,
  formData: FormData,
): Promise<QueueActionTaskRemindersActionState> {
  try {
    const context = await organizerContext(formData);
    const { repository, scope } = actionTaskRepositoryContext(context);
    const receipt = repository.queueDueActionTaskReminders(scope);
    let revalidated = true;
    try { revalidatePath(`/w/${context.workspace}/events/${context.event.id}/speakers`); } catch { revalidated = false; }
    return {
      kind: "success",
      code: "ACTION_TASK_REMINDERS_QUEUED",
      message: `Queued ${receipt.queuedCount} PENDING reminder${receipt.queuedCount === 1 ? "" : "s"}; skipped ${receipt.skippedCount}. No provider was contacted.`,
      receipt: {
        occurrenceDate: receipt.occurrenceDate,
        windowEndExclusive: receipt.windowEndExclusive,
        scannedCount: receipt.scannedCount,
        maximumScanAssignments: receipt.maximumScanAssignments,
        queuedCount: receipt.queuedCount,
        skippedCount: receipt.skippedCount,
        alreadyQueuedCount: receipt.alreadyQueuedCount,
        completedCount: receipt.completedCount,
        notDueCount: receipt.notDueCount,
        nonCurrentSpeakerCount: receipt.nonCurrentSpeakerCount,
        providerMutation: receipt.providerMutation,
      },
      revalidated,
    };
  } catch (error) {
    if (frameworkControlFlow(error)) throw error;
    return { kind: "error", ...sharedActionError(error) };
  }
}

export async function updateSpeakerTask(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  const state = optionalText(formData, "state", 40);
  getSyntheticSpeakerOperationsRepository(getDb()).updateTask(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    requiredText(formData, "taskId"),
    {
      dueAt: requiredText(formData, "dueAt", 80),
      state: state ? state as "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "CHANGES_REQUESTED" | "COMPLETED" | "BLOCKED" : undefined,
      note: optionalText(formData, "note", 1000) || undefined,
      idempotencyKey: optionalText(formData, "idempotencyKey", 240) || undefined,
    },
  );
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export async function updateSpeakerWorkflowStatus(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  const nextStatus = requiredText(formData, "status", 40);
  const expectedStatus = requiredText(formData, "expectedCurrentStatus", 40);
  const expectedVersion = optionalText(formData, "expectedVersion", 240) || null;
  const idempotencyKey = `${requiredText(formData, "idempotencyKey", 200)}:${nextStatus}`;
  if (!SPEAKER_WORKFLOW_STATUSES.includes(nextStatus as SpeakerWorkflowStatus) || !SPEAKER_WORKFLOW_STATUSES.includes(expectedStatus as SpeakerWorkflowStatus)) throw new Error("INVALID_SPEAKER_COMMAND");
  try {
    getSyntheticSpeakerOperationsRepository(getDb()).updateWorkflowStatus(
      { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
      requiredText(formData, "personId"),
      {
        status: nextStatus as SpeakerWorkflowStatus,
        expectedCurrentStatus: expectedStatus as SpeakerWorkflowStatus,
        expectedVersion,
        idempotencyKey,
      },
    );
  } catch (error) {
    if (!(error instanceof SpeakerOperationsConflictError)) throw error;
  }
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export async function saveOrganizerSpeakerProfile(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  const personId = requiredText(formData, "personId");
  getSyntheticSpeakerOperationsRepository(getDb()).submitOrganizerContent(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    {
      personId,
      taskId: requiredText(formData, "taskId"),
      payload: {
        kind: "PROFILE",
        bio: requiredText(formData, "bio", 12000),
        publicTitle: requiredText(formData, "publicTitle", 240),
        organization: requiredText(formData, "organization", 240),
        socialLinks: jsonValue(formData, "socialLinksJson", 16000),
        headshot: syntheticAsset(formData),
      },
      idempotencyKey: optionalText(formData, "idempotencyKey", 240) || undefined,
    },
  );
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export async function saveOrganizerSessionContent(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  const kind = requiredText(formData, "contentKind", 40);
  const payload = kind === "SESSION_TITLE"
    ? { kind: "SESSION_TITLE" as const, title: requiredText(formData, "title", 240) }
    : kind === "SESSION_DESCRIPTION"
      ? { kind: "SESSION_DESCRIPTION" as const, description: requiredText(formData, "description", 12000) }
      : null;
  if (!payload) throw new Error("INVALID_SPEAKER_COMMAND");
  getSyntheticSpeakerOperationsRepository(getDb()).submitOrganizerContent(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    {
      personId: requiredText(formData, "personId"),
      taskId: requiredText(formData, "taskId"),
      payload,
      idempotencyKey: optionalText(formData, "idempotencyKey", 240) || undefined,
    },
  );
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export async function restoreSpeakerContent(formData: FormData): Promise<void> {
  const { session, workspace, event } = await organizerContext(formData);
  getSyntheticSpeakerOperationsRepository(getDb()).restoreContent(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    {
      personId: requiredText(formData, "personId"),
      taskId: requiredText(formData, "taskId"),
      submissionVersionId: requiredText(formData, "submissionVersionId"),
      submissionContentHash: requiredText(formData, "submissionContentHash"),
      idempotencyKey: optionalText(formData, "idempotencyKey", 240) || undefined,
    },
  );
  revalidatePath(`/w/${workspace}/events/${event.id}/speakers`);
}

export async function addSpeakerComment(formData: FormData): Promise<void> {
  const { session, event } = await organizerContext(formData);
  const repository = getSyntheticSpeakerOperationsRepository(getDb());
  repository.addComment(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    {
      personId: requiredText(formData, "personId"),
      taskId: requiredText(formData, "taskId"),
      submissionVersionId: requiredText(formData, "submissionVersionId"),
      submissionContentHash: requiredText(formData, "submissionContentHash"),
      body: requiredText(formData, "body"),
      idempotencyKey: requiredText(formData, "idempotencyKey"),
    },
  );
  revalidatePath(`/w/${session.workspaceSlug}/events/${event.id}/speakers`);
}

export async function addSpeakerFinding(formData: FormData): Promise<void> {
  const { session, event } = await organizerContext(formData);
  const repository = getSyntheticSpeakerOperationsRepository(getDb());
  const severity = requiredText(formData, "severity");
  if (severity !== "INFO" && severity !== "WARNING" && severity !== "BLOCKER") throw new Error("INVALID_SPEAKER_COMMAND");
  repository.addFinding(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    {
      personId: requiredText(formData, "personId"),
      taskId: requiredText(formData, "taskId"),
      submissionVersionId: requiredText(formData, "submissionVersionId"),
      submissionContentHash: requiredText(formData, "submissionContentHash"),
      severity,
      message: requiredText(formData, "message"),
      blocksReadiness: formData.get("blocksReadiness") === "true",
      idempotencyKey: requiredText(formData, "idempotencyKey"),
    },
  );
  revalidatePath(`/w/${session.workspaceSlug}/events/${event.id}/speakers`);
}

export async function requestSpeakerRevision(formData: FormData): Promise<void> {
  const { session, event } = await organizerContext(formData);
  const repository = getSyntheticSpeakerOperationsRepository(getDb());
  repository.requestRevision(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    {
      personId: requiredText(formData, "personId"),
      taskId: requiredText(formData, "taskId"),
      submissionVersionId: requiredText(formData, "submissionVersionId"),
      submissionContentHash: requiredText(formData, "submissionContentHash"),
      reason: requiredText(formData, "reason"),
      idempotencyKey: requiredText(formData, "idempotencyKey"),
    },
  );
  revalidatePath(`/w/${session.workspaceSlug}/events/${event.id}/speakers`);
}

export async function approveSpeakerContent(formData: FormData): Promise<void> {
  const { session, event } = await organizerContext(formData);
  const repository = getSyntheticSpeakerOperationsRepository(getDb());
  const gate = formData.get("gate");
  if (gate !== null && gate !== "CONFIRMATION" && gate !== "PUBLICATION" && gate !== "OPERATOR_RELEASE") throw new Error("INVALID_SPEAKER_COMMAND");
  repository.approveContent(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    {
      personId: requiredText(formData, "personId"),
      taskId: requiredText(formData, "taskId"),
      submissionVersionId: requiredText(formData, "submissionVersionId"),
      submissionContentHash: requiredText(formData, "submissionContentHash"),
      gate: gate === null ? undefined : gate,
      idempotencyKey: requiredText(formData, "idempotencyKey"),
    },
  );
  revalidatePath(`/w/${session.workspaceSlug}/events/${event.id}/speakers`);
}
