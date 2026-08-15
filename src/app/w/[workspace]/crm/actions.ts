"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import {
  DenialError,
  describeDenial,
  isDenialError,
  requireCapability,
  resolveSession,
  SESSION_COOKIE,
  type SessionInfo,
} from "@/server/auth";
import { getDb } from "@/server/db";
import {
  confirmCrmCsvImport,
  getCrmWorkspaceView,
  previewCrmCsvImport,
  type CrmCsvActionState,
} from "@/server/services/crm";
import { getEvent } from "@/server/services/events";
import {
  createManualSpeaker as persistManualSpeaker,
  listManualSpeakerRecords,
  ManualSpeakerAuthorizationError,
  ManualSpeakerConflictError,
  ManualSpeakerError,
  ManualSpeakerInputError,
} from "@/server/services/speaker-operations";
import {
  listSpeakerCommunicationDeliveryLog,
  queueSpeakerCommunicationBatch,
  SPEAKER_COMMUNICATION_MAX_RECIPIENTS,
  SPEAKER_COMMUNICATION_TEMPLATE_KEY,
  SpeakerCommunicationsAuthorizationError,
  SpeakerCommunicationsError,
  SpeakerCommunicationsInputError,
} from "@/server/services/speaker-communications";
import {
  getRouteSession,
  requireOrganizerWorkspaceRoute,
} from "@/server/workspace-session";

const ROUTE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const WORKSPACE_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;

export type CrmEventLinkActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "success";
      readonly code: "CRM_EVENT_SPEAKER_LINKED" | "CRM_EVENT_SPEAKER_REPLAYED" | "CRM_EVENT_SPEAKER_ALREADY_LINKED";
      readonly message: string;
      readonly event: { readonly id: string; readonly name: string };
      readonly person: { readonly id: string; readonly fullName: string; readonly email: string };
      readonly roleKey: string;
      readonly participationStatus: string;
      readonly replayed: boolean;
      readonly deduped: boolean;
      readonly revalidated: boolean;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export interface CrmQueuedMessageEvidence {
  readonly messageId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly normalizedEmail: string;
  readonly subject: string;
  readonly body: string;
  readonly status: "PENDING";
}

export type CrmBulkEmailActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "success";
      readonly code: "CRM_BULK_EMAIL_QUEUED" | "CRM_BULK_EMAIL_REPLAYED";
      readonly message: string;
      readonly batchId: string;
      readonly event: { readonly id: string; readonly name: string };
      readonly recipientCount: number;
      readonly messages: readonly CrmQueuedMessageEvidence[];
      readonly replayed: boolean;
      readonly channel: "local";
      readonly providerMutation: false;
      readonly revalidated: boolean;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

interface AuthorizedCrmContext {
  readonly db: ReturnType<typeof getDb>;
  readonly session: SessionInfo;
  readonly workspace: string;
  readonly people: NonNullable<ReturnType<typeof getCrmWorkspaceView>>["people"];
}

function invalidCrmAction(message = "The CRM event action is invalid."): never {
  throw new Error(`INVALID_CRM_EVENT_ACTION:${message}`);
}

function actionText(formData: FormData, name: string, maximumLength: number): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
    invalidCrmAction();
  }
  return value;
}

function routeWorkspace(formData: FormData): string {
  const workspace = actionText(formData, "workspace", 128);
  if (!WORKSPACE_SLUG.test(workspace)) invalidCrmAction();
  return workspace;
}

function routeIdentifier(formData: FormData, name: string): string {
  const value = actionText(formData, name, 160);
  if (!ROUTE_SEGMENT.test(value)) invalidCrmAction();
  return value;
}

function selectedPersonIds(formData: FormData): readonly string[] {
  const values = formData.getAll("personId");
  if (values.length < 1 || values.length > SPEAKER_COMMUNICATION_MAX_RECIPIENTS) {
    invalidCrmAction(`Select between 1 and ${SPEAKER_COMMUNICATION_MAX_RECIPIENTS} event-linked contacts.`);
  }
  const personIds: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !ROUTE_SEGMENT.test(value) || seen.has(value)) {
      invalidCrmAction();
    }
    seen.add(value);
    personIds.push(value);
  }
  return personIds;
}

function isFrameworkControlFlow(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const digest = (error as { readonly digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

async function authorizedCrmContext(formData: FormData): Promise<AuthorizedCrmContext> {
  const workspace = routeWorkspace(formData);
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const db = getDb();
  const view = getCrmWorkspaceView(db, session, workspace);
  if (!view) {
    throw new DenialError("WORKSPACE_NOT_FOUND", "The authorized CRM workspace is unavailable.", workspace);
  }
  return { db, session, workspace: view.workspace.slug, people: view.people };
}

function eventLinkFailure(error: unknown): Extract<CrmEventLinkActionState, { kind: "error" }> {
  if (isDenialError(error)) {
    return { kind: "error", code: error.code, message: "This CRM event action is not available in the authorized workspace." };
  }
  if (error instanceof ManualSpeakerAuthorizationError) {
    return { kind: "error", code: error.code, message: "The selected Person or event is not available in the authorized workspace." };
  }
  if (error instanceof ManualSpeakerConflictError) {
    const messages: Record<string, string> = {
      DUPLICATE_EMAIL_CONFLICT: "The canonical Person or event speaker profile changed. Reload before linking this contact.",
      IDEMPOTENCY_KEY_CONFLICT: "This event-link request is stale or conflicts with an earlier request. Reload before retrying.",
      EMAIL_READ_ONLY: "The canonical email changed before this event link was saved. Reload before retrying.",
      CANONICAL_NAME_STALE: "The canonical Person name changed before this event link was saved. Reload before retrying.",
    };
    return { kind: "error", code: error.code, message: messages[error.code] ?? "The event-link request conflicts with current state." };
  }
  if (error instanceof ManualSpeakerInputError) {
    return { kind: "error", code: error.code, message: "The selected Person, event, or idempotency key is invalid." };
  }
  if (error instanceof ManualSpeakerError) {
    return { kind: "error", code: error.code, message: "The pending speaker relationship could not be persisted atomically." };
  }
  if (error instanceof Error && error.message.startsWith("INVALID_CRM_EVENT_ACTION:")) {
    return { kind: "error", code: "INVALID_INPUT", message: "Choose one canonical Person and one authorized event." };
  }
  return { kind: "error", code: "CRM_EVENT_LINK_FAILED", message: "The pending speaker relationship could not be persisted." };
}

function bulkEmailFailure(error: unknown): Extract<CrmBulkEmailActionState, { kind: "error" }> {
  if (isDenialError(error)) {
    return { kind: "error", code: error.code, message: "This CRM communication action is not available in the authorized workspace." };
  }
  if (error instanceof SpeakerCommunicationsAuthorizationError || error instanceof ManualSpeakerAuthorizationError) {
    return { kind: "error", code: error.code, message: "Every recipient must be a canonical Person linked as a pending speaker to the selected event." };
  }
  if (error instanceof SpeakerCommunicationsInputError) {
    const messages: Record<string, string> = {
      INVALID_INPUT: `Select between 1 and ${SPEAKER_COMMUNICATION_MAX_RECIPIENTS} unique event-linked contacts and provide bounded plain text.`,
      UNSUPPORTED_TEMPLATE: "The CRM communication template is not available.",
      UNKNOWN_PLACEHOLDER: "Use only the listed plain-text merge fields.",
      CONTROL_CHARACTER_REJECTED: "Subject, body, and recipient fields cannot contain header or unsupported control characters.",
      HTML_NOT_SUPPORTED: "Subject and body must remain plain text.",
      DUPLICATE_RECIPIENT: "Each selected contact must resolve to a unique normalized recipient.",
    };
    return { kind: "error", code: error.code, message: messages[error.code] ?? "The bulk email request is invalid." };
  }
  if (error instanceof SpeakerCommunicationsError) {
    const message = error.code === "IDEMPOTENCY_KEY_CONFLICT"
      ? "This queue request conflicts with an earlier request. Reload to obtain a fresh request key."
      : "The durable local outbox could not accept this batch atomically. No provider was contacted.";
    return { kind: "error", code: error.code, message };
  }
  if (error instanceof ManualSpeakerError) {
    return { kind: "error", code: error.code, message: "The selected event membership evidence is unavailable." };
  }
  if (error instanceof Error && error.message.startsWith("INVALID_CRM_EVENT_ACTION:")) {
    return { kind: "error", code: "INVALID_INPUT", message: `Select between 1 and ${SPEAKER_COMMUNICATION_MAX_RECIPIENTS} unique event-linked contacts and provide bounded plain text.` };
  }
  return { kind: "error", code: "CRM_BULK_EMAIL_FAILED", message: "The durable local outbox could not accept this batch. No provider was contacted." };
}

function actionFailure(error: unknown): CrmCsvActionState {
  if (isDenialError(error)) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      denial: describeDenial(error),
    };
  }
  const code = error instanceof Error ? error.message.split(":", 1)[0] : "CRM_IMPORT_FAILED";
  const messages: Record<string, string> = {
    CRM_CSV_HEADER_INVALID: "CSV header does not match the documented bounded schema.",
    CRM_CSV_INVALID: "CSV could not be parsed. Use one row per contact and quote comma-containing fields.",
    CRM_CSV_TOO_LARGE: "CSV is too large for this bounded synthetic import.",
    CRM_CSV_TOO_MANY_ROWS: "CSV has too many rows for this bounded synthetic import.",
    CRM_IMPORT_PREVIEW_STALE: "The preview is stale. Generate a new preview before confirming.",
    CRM_IMPORT_RECEIPT_CONFLICT: "An existing import receipt failed integrity checks; no changes were made.",
    CRM_CONFIRMATION_REQUIRED: "Preview the CSV and explicitly confirm before importing or merging.",
  };
  return {
    ok: false,
    code,
    message: messages[code] ?? "CRM import could not be completed; no outbound operation was attempted.",
  };
}

async function authorizedSession(): Promise<{ db: ReturnType<typeof getDb>; session: SessionInfo }> {
  const store = await cookies();
  const db = getDb();
  const session = resolveSession(db, store.get(SESSION_COOKIE)?.value);
  if (!session) {
    throw new DenialError("SESSION_REQUIRED", "Sign in to continue.", "session");
  }
  requireCapability(db, session, "phase0.pipeline.manage");
  return { db, session };
}

function csvField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

export async function previewCrmCsvAction(
  _state: CrmCsvActionState | null,
  formData: FormData,
): Promise<CrmCsvActionState> {
  try {
    const csv = csvField(formData, "csv");
    if (csv === null) {
      return { ok: false, code: "CRM_CSV_INVALID", message: "Choose or paste a CSV before previewing." };
    }
    const { db, session } = await authorizedSession();
    const preview = previewCrmCsvImport(db, session, session.workspaceSlug, csv);
    return {
      ok: true,
      message: preview.requiresConfirmation
        ? "Preview ready. Review every create, merge candidate, and rejection before confirming."
        : "Preview ready. No valid rows are available to import.",
      preview,
    };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function confirmCrmCsvAction(
  _state: CrmCsvActionState | null,
  formData: FormData,
): Promise<CrmCsvActionState> {
  try {
    if (formData.get("confirm") !== "yes") {
      return actionFailure(new Error("CRM_CONFIRMATION_REQUIRED"));
    }
    const csv = csvField(formData, "csv");
    const inputFingerprint = csvField(formData, "inputFingerprint");
    if (csv === null || inputFingerprint === null || inputFingerprint.length !== 64) {
      return actionFailure(new Error("CRM_IMPORT_PREVIEW_STALE"));
    }
    const { db, session } = await authorizedSession();
    const receipt = confirmCrmCsvImport(
      db,
      session,
      session.workspaceSlug,
      csv,
      inputFingerprint,
    );
    let refreshed = true;
    try {
      revalidatePath(`/w/${session.workspaceSlug}/crm`);
    } catch {
      refreshed = false;
    }
    return {
      ok: true,
      message: refreshed
        ? `Import committed: ${receipt.createdCount} created, ${receipt.mergedCount} merged, ${receipt.rejectedCount} rejected.`
        : `Import committed: ${receipt.createdCount} created, ${receipt.mergedCount} merged, ${receipt.rejectedCount} rejected. Refresh the directory to see canonical People changes.`,
      receipt,
    };
  } catch (error) {
    return actionFailure(error);
  }
}

/** Link one already-canonical CRM Person to one authorized event as a pending speaker. */
export async function addCrmPersonToEventAction(
  _previousState: CrmEventLinkActionState,
  formData: FormData,
): Promise<CrmEventLinkActionState> {
  try {
    const context = await authorizedCrmContext(formData);
    const eventId = routeIdentifier(formData, "eventId");
    const personId = routeIdentifier(formData, "personId");
    const idempotencyKey = actionText(formData, "idempotencyKey", 200);
    const event = getEvent(context.db, context.session.workspaceId, eventId);
    if (!event) {
      throw new ManualSpeakerAuthorizationError(
        "WORKSPACE_EVENT_NOT_FOUND",
        "The selected event is not available in the authorized workspace.",
      );
    }
    const person = context.people.find((candidate) => candidate.id === personId);
    if (!person) {
      throw new ManualSpeakerAuthorizationError(
        "PERSON_NOT_IN_EVENT",
        "The selected canonical Person is not available in the authorized workspace.",
      );
    }
    const result = persistManualSpeaker(
      context.db,
      {
        kind: "organizer",
        workspaceId: context.session.workspaceId,
        eventId: event.id,
        actorId: context.session.accountId,
      },
      {
        fullName: person.fullName,
        email: person.canonicalEmail,
        idempotencyKey,
      },
    );
    let revalidated = true;
    try {
      revalidatePath(`/w/${context.workspace}/crm`);
    } catch {
      revalidated = false;
    }
    const code = result.replayed
      ? "CRM_EVENT_SPEAKER_REPLAYED"
      : result.deduped
        ? "CRM_EVENT_SPEAKER_ALREADY_LINKED"
        : "CRM_EVENT_SPEAKER_LINKED";
    const prefix = result.replayed
      ? "Idempotent replay confirmed"
      : result.deduped
        ? "No duplicate relationship was created"
        : "Persistent event relationship created";
    return {
      kind: "success",
      code,
      message: `${prefix}: ${person.fullName} is linked to ${event.name} as a ${result.record.participationStatus} speaker. No invitation, registration, attendance, or email is claimed.`,
      event: { id: event.id, name: event.name },
      person: { id: person.id, fullName: person.fullName, email: person.canonicalEmail },
      roleKey: result.record.roleKey,
      participationStatus: result.record.participationStatus,
      replayed: result.replayed,
      deduped: result.deduped,
      revalidated,
    };
  } catch (error) {
    if (isFrameworkControlFlow(error)) throw error;
    return eventLinkFailure(error);
  }
}

/** Queue one bounded CRM-selected batch in the existing durable local speaker outbox. */
export async function queueCrmBulkEmailAction(
  _previousState: CrmBulkEmailActionState,
  formData: FormData,
): Promise<CrmBulkEmailActionState> {
  try {
    const context = await authorizedCrmContext(formData);
    const eventId = routeIdentifier(formData, "eventId");
    const personIds = selectedPersonIds(formData);
    const idempotencyKey = actionText(formData, "idempotencyKey", 200);
    const subjectTemplate = actionText(formData, "subjectTemplate", 240);
    const bodyTemplate = actionText(formData, "bodyTemplate", 12_000);
    const event = getEvent(context.db, context.session.workspaceId, eventId);
    if (!event) {
      throw new SpeakerCommunicationsAuthorizationError(
        "WORKSPACE_EVENT_NOT_FOUND",
        "The selected event is not available in the authorized workspace.",
      );
    }
    const scope = {
      kind: "organizer" as const,
      workspaceId: context.session.workspaceId,
      eventId: event.id,
      actorId: context.session.accountId,
    };
    const eventPersonIds = new Set(listManualSpeakerRecords(context.db, scope).map((record) => record.personId));
    const canonicalPeople = new Map(context.people.map((person) => [person.id, person]));
    const recipients = personIds.map((personId) => {
      const person = canonicalPeople.get(personId);
      if (!person || !eventPersonIds.has(personId)) {
        throw new SpeakerCommunicationsAuthorizationError(
          "PERSON_NOT_AUTHORIZED",
          "A selected CRM Person is not a pending speaker in the selected event.",
        );
      }
      const mergeFields: Record<string, string> = {
        firstName: person.fullName.trim().split(/\s+/u, 1)[0] ?? person.fullName,
      };
      if (person.organization) mergeFields.organization = person.organization;
      if (person.title) mergeFields.title = person.title;
      return {
        personId: person.id,
        email: person.canonicalEmail,
        displayName: person.fullName,
        mergeFields,
      };
    });
    const priorMessageIds = new Set(
      listSpeakerCommunicationDeliveryLog(context.db, {
        workspaceId: context.session.workspaceId,
        eventId: event.id,
      }).map((entry) => entry.messageId),
    );
    const receipt = queueSpeakerCommunicationBatch(context.db, {
      workspaceId: context.session.workspaceId,
      eventId: event.id,
      idempotencyKey,
      templateKey: SPEAKER_COMMUNICATION_TEMPLATE_KEY,
      subjectTemplate,
      bodyTemplate,
      recipients,
    });
    const replayed = receipt.messageIds.every((messageId) => priorMessageIds.has(messageId));
    const recipientById = new Map(recipients.map((recipient) => [recipient.personId, recipient]));
    const messages = receipt.messages.map((message): CrmQueuedMessageEvidence => {
      const recipient = recipientById.get(message.personId);
      if (!recipient) {
        throw new SpeakerCommunicationsError("OUTBOX_STATE_INVALID", "The queued CRM recipient evidence is incomplete.");
      }
      return {
        messageId: message.messageId,
        personId: message.personId,
        displayName: recipient.displayName,
        normalizedEmail: message.normalizedEmail,
        subject: message.subjectPreview,
        body: message.bodyPreview,
        status: message.status,
      };
    });
    let revalidated = true;
    try {
      revalidatePath(`/w/${context.workspace}/crm`);
    } catch {
      revalidated = false;
    }
    return {
      kind: "success",
      code: replayed ? "CRM_BULK_EMAIL_REPLAYED" : "CRM_BULK_EMAIL_QUEUED",
      message: replayed
        ? `Idempotent replay confirmed for ${receipt.recipientCount} queued local message${receipt.recipientCount === 1 ? "" : "s"}. Nothing was sent and no provider was contacted.`
        : `Queued ${receipt.recipientCount} local message${receipt.recipientCount === 1 ? "" : "s"} as PENDING. Nothing was sent and no provider was contacted.`,
      batchId: receipt.batchId,
      event: { id: event.id, name: event.name },
      recipientCount: receipt.recipientCount,
      messages,
      replayed,
      channel: receipt.channel,
      providerMutation: receipt.providerMutation,
      revalidated,
    };
  } catch (error) {
    if (isFrameworkControlFlow(error)) throw error;
    return bulkEmailFailure(error);
  }
}
