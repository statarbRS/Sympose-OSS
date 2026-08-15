"use server";

import { revalidatePath } from "next/cache";

import { getDb, type Db } from "@/server/db";
import { getEvent } from "@/server/services/events";
import {
  listSpeakerCommunicationDeliveryLog,
  queueSpeakerCommunicationBatch,
  SPEAKER_COMMUNICATION_TEMPLATE_KEY,
  type SpeakerCommunicationDeliveryLogEntry,
  type SpeakerCommunicationBatchReceipt,
  SpeakerCommunicationsAuthorizationError,
  SpeakerCommunicationsError,
  SpeakerCommunicationsInputError,
} from "@/server/services/speaker-communications";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

const ROUTE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const WORKSPACE_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const MAX_SELECTED_RECIPIENTS = 100;

export interface SpeakerCommunicationsRecipient {
  readonly personId: string;
  readonly displayName: string;
  readonly email: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly roles: readonly string[];
}

export interface SpeakerCommunicationsSurface {
  readonly workspace: string;
  readonly event: { readonly id: string; readonly name: string };
  readonly recipients: readonly SpeakerCommunicationsRecipient[];
  readonly history: readonly SpeakerCommunicationDeliveryLogEntry[];
  readonly nextIdempotencyKey: string;
}

export type SpeakerCommunicationsActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "success";
      readonly code: "SPEAKER_COMMUNICATION_BATCH_QUEUED";
      readonly message: string;
      readonly receipt: Pick<SpeakerCommunicationBatchReceipt, "batchId" | "recipientCount" | "messageIds" | "channel" | "providerMutation">;
      readonly revalidated: boolean;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    };

interface SpeakerCommunicationContext {
  readonly db: Db;
  readonly workspace: string;
  readonly workspaceId: string;
  readonly event: NonNullable<ReturnType<typeof getEvent>>;
}

interface RecipientRow {
  readonly personId: string;
  readonly displayName: string;
  readonly email: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly roles: string | null;
}

function invalidAction(message = "The speaker communication request is invalid."): never {
  throw new Error(`INVALID_SPEAKER_COMMUNICATION_ACTION:${message}`);
}

function formText(formData: FormData, name: string, maximumLength: number): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
    invalidAction();
  }
  return value;
}

function routeWorkspace(formData: FormData): string {
  const workspace = formText(formData, "workspace", 128);
  if (!WORKSPACE_SLUG.test(workspace)) invalidAction();
  return workspace;
}

function routeIdentifier(formData: FormData, name: string): string {
  const value = formText(formData, name, 160);
  if (!ROUTE_SEGMENT.test(value)) invalidAction();
  return value;
}

function selectedPersonIds(formData: FormData): readonly string[] {
  const values = formData.getAll("personId");
  if (values.length < 1 || values.length > MAX_SELECTED_RECIPIENTS) invalidAction("Select at least one authorized speaker.");
  const personIds: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !ROUTE_SEGMENT.test(value) || seen.has(value)) invalidAction();
    seen.add(value);
    personIds.push(value);
  }
  return personIds;
}

async function organizerContext(workspace: string, eventId: string): Promise<SpeakerCommunicationContext> {
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const db = getDb();
  const event = getEvent(db, session.workspaceId, eventId);
  if (!event) throw new SpeakerCommunicationsAuthorizationError("WORKSPACE_EVENT_NOT_FOUND", "The requested event is not available in the workspace.");
  return { db, workspace: session.workspaceSlug, workspaceId: session.workspaceId, event };
}

function readAuthorizedRecipients(db: Db, workspaceId: string, eventId: string): readonly SpeakerCommunicationsRecipient[] {
  const rows = db.prepare(
    `SELECT p.id AS personId,
            p.full_name AS displayName,
            p.canonical_email AS email,
            p.organization,
            p.title,
            GROUP_CONCAT(DISTINCT es.role_key) AS roles
       FROM event_speakers es
       JOIN people p
         ON p.id = es.person_id
        AND p.workspace_id = es.workspace_id
      WHERE es.workspace_id = ?
        AND es.event_id = ?
      GROUP BY p.id, p.full_name, p.canonical_email, p.organization, p.title
      ORDER BY p.full_name COLLATE NOCASE, p.id`,
  ).all(workspaceId, eventId) as unknown as RecipientRow[];

  return rows.map((row) => ({
    personId: row.personId,
    displayName: row.displayName,
    email: row.email,
    organization: row.organization,
    title: row.title,
    roles: (row.roles ?? "").split(",").filter((role) => role.length > 0),
  }));
}

function snapshotForBatch(recipient: SpeakerCommunicationsRecipient) {
  const mergeFields: Record<string, string> = {
    firstName: recipient.displayName.trim().split(/\s+/u, 1)[0] ?? recipient.displayName,
  };
  if (recipient.organization) mergeFields.organization = recipient.organization;
  if (recipient.title) mergeFields.title = recipient.title;
  return {
    personId: recipient.personId,
    email: recipient.email,
    displayName: recipient.displayName,
    mergeFields,
  };
}

function safeActionError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof SpeakerCommunicationsAuthorizationError) {
    return { code: error.code, message: "One or more selected people are not authorized speakers for this event." };
  }
  if (error instanceof SpeakerCommunicationsInputError) {
    const messages: Record<string, string> = {
      INVALID_INPUT: "Check the selected speakers and message fields, then try again.",
      UNSUPPORTED_TEMPLATE: "This message template is not available.",
      UNKNOWN_PLACEHOLDER: "Use only the listed plain-text merge fields.",
      CONTROL_CHARACTER_REJECTED: "Subject and body cannot contain header or control characters.",
      HTML_NOT_SUPPORTED: "Subject and body must remain plain text.",
      DUPLICATE_RECIPIENT: "Each selected speaker must have a unique recipient destination.",
    };
    return { code: error.code, message: messages[error.code] ?? "The message fields are invalid." };
  }
  if (error instanceof SpeakerCommunicationsError) {
    return { code: error.code, message: "The local speaker outbox could not accept this batch. No provider was contacted." };
  }
  if (error instanceof Error && error.message.startsWith("INVALID_SPEAKER_COMMUNICATION_ACTION:")) {
    return { code: "INVALID_INPUT", message: "Select authorized speakers and provide a bounded plain-text message." };
  }
  return { code: "SPEAKER_COMMUNICATION_FAILED", message: "The local speaker outbox could not accept this batch. No provider was contacted." };
}

function isFrameworkControlFlow(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const digest = (error as { readonly digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

/** Read the event-scoped canonical People and durable local delivery history. */
export async function loadSpeakerCommunicationsSurface(
  workspace: string,
  eventId: string,
): Promise<SpeakerCommunicationsSurface | null> {
  if (!WORKSPACE_SLUG.test(workspace) || !ROUTE_SEGMENT.test(eventId)) return null;
  const context = await organizerContext(workspace, eventId);
  const recipients = readAuthorizedRecipients(context.db, context.workspaceId, context.event.id);
  const history = listSpeakerCommunicationDeliveryLog(context.db, {
    workspaceId: context.workspaceId,
    eventId: context.event.id,
  });
  return {
    workspace: context.workspace,
    event: { id: context.event.id, name: context.event.name },
    recipients,
    history,
    nextIdempotencyKey: `speaker-communications:${context.event.id}:${history.length}`,
  };
}

/** Queue a bounded local-only batch after re-reading every recipient from the authorized event roster. */
export async function queueSpeakerCommunicationsAction(
  _previousState: SpeakerCommunicationsActionState,
  formData: FormData,
): Promise<SpeakerCommunicationsActionState> {
  try {
    const workspace = routeWorkspace(formData);
    const eventId = routeIdentifier(formData, "eventId");
    const context = await organizerContext(workspace, eventId);
    const personIds = selectedPersonIds(formData);
    const templateKey = formText(formData, "templateKey", 80);
    if (templateKey !== SPEAKER_COMMUNICATION_TEMPLATE_KEY) invalidAction();
    const subjectTemplate = formText(formData, "subjectTemplate", 240);
    const bodyTemplate = formText(formData, "bodyTemplate", 12_000);
    const idempotencyKey = formText(formData, "idempotencyKey", 200);
    const byPersonId = new Map(readAuthorizedRecipients(context.db, context.workspaceId, context.event.id).map((recipient) => [recipient.personId, recipient]));
    const recipients = personIds.map((personId) => byPersonId.get(personId));
    if (recipients.some((recipient) => recipient === undefined)) {
      throw new SpeakerCommunicationsAuthorizationError("PERSON_NOT_AUTHORIZED", "A selected person is not bound to the requested event.");
    }
    const receipt = queueSpeakerCommunicationBatch(context.db, {
      workspaceId: context.workspaceId,
      eventId: context.event.id,
      idempotencyKey,
      templateKey: SPEAKER_COMMUNICATION_TEMPLATE_KEY,
      subjectTemplate,
      bodyTemplate,
      recipients: recipients.map((recipient) => snapshotForBatch(recipient!)),
    });
    let revalidated = true;
    try {
      revalidatePath(`/w/${context.workspace}/events/${context.event.id}/speakers`);
    } catch {
      revalidated = false;
    }
    return {
      kind: "success",
      code: "SPEAKER_COMMUNICATION_BATCH_QUEUED",
      message: `Queued ${receipt.recipientCount} local message${receipt.recipientCount === 1 ? "" : "s"} as PENDING. No provider was contacted.`,
      receipt: {
        batchId: receipt.batchId,
        recipientCount: receipt.recipientCount,
        messageIds: receipt.messageIds,
        channel: receipt.channel,
        providerMutation: receipt.providerMutation,
      },
      revalidated,
    };
  } catch (error) {
    if (isFrameworkControlFlow(error)) throw error;
    const safe = safeActionError(error);
    return { kind: "error", code: safe.code, message: safe.message };
  }
}
