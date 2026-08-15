import type { SessionInfo } from "../../auth";
import { hasCapability } from "../../auth";
import type { Db } from "../../db";
import { getEvent, type EventRow } from "../events";
import {
  readCfpOrganizerCall,
  readCfpOrganizerOverview,
} from "../cfp/organizer";
import { listSpeakerCommunicationDeliveryLog } from "../speaker-communications";
import { getSyntheticSpeakerOperationsRepository } from "../speaker-operations";

export const DELIVERY_CENTER_SCHEMA = "sympose-delivery-center/v1" as const;

export type DeliveryCenterStatus = "PENDING" | "CLAIMED" | "DELIVERED" | "FAILED";

export type DeliveryCenterSourceKey =
  | "SPEAKER_COMMUNICATIONS"
  | "SHARED_TASK_REMINDERS"
  | "CFP_DECISION_NOTICES"
  | "CONTENT_NOTIFICATIONS";

export type DeliveryCenterSourceState = "READY" | "EMPTY" | "ERROR" | "UNAVAILABLE";

export interface DeliveryCenterItem {
  readonly id: string;
  readonly source: Exclude<DeliveryCenterSourceKey, "CONTENT_NOTIFICATIONS">;
  readonly sourceLabel: string;
  readonly kind: string;
  readonly status: DeliveryCenterStatus;
  readonly recipient: {
    readonly displayName: string;
    readonly email: string;
  };
  readonly subject: string;
  readonly body: string;
  readonly channel: "local" | "local-inbox-simulation";
  readonly attemptCount: number | null;
  readonly queuedAt: string;
  readonly nextAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly failureRecorded: boolean | null;
  readonly providerReceipt: {
    readonly id: string;
    readonly acceptedAt: string;
    readonly mode: "NO_NETWORK_SIMULATED";
  } | null;
  readonly statusMeaning: string;
}

export interface DeliveryCenterSourceReport {
  readonly key: DeliveryCenterSourceKey;
  readonly label: string;
  readonly state: DeliveryCenterSourceState;
  readonly itemCount: number;
  readonly disclosure: string;
}

export interface DeliveryCenterProjection {
  readonly schema: typeof DELIVERY_CENTER_SCHEMA;
  readonly workspace: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  };
  readonly event: Pick<EventRow, "id" | "name" | "timezone" | "lifecycle">;
  readonly readOnly: true;
  readonly providerContacted: false;
  readonly smtpContacted: false;
  readonly transportDisclosure: string;
  readonly sources: readonly DeliveryCenterSourceReport[];
  readonly items: readonly DeliveryCenterItem[];
  readonly summary: {
    readonly total: number;
    readonly pending: number;
    readonly claimed: number;
    readonly delivered: number;
    readonly failed: number;
  };
}

export interface DeliveryCenterReadInput {
  readonly workspaceSlug: string;
  readonly eventId: string;
}

export interface DeliveryCenterSourceLoaders {
  readonly speakerCommunications: (
    db: Db,
    scope: { readonly workspaceId: string; readonly eventId: string },
  ) => unknown;
  readonly sharedTaskReminders: (
    db: Db,
    scope: {
      readonly kind: "organizer";
      readonly workspaceId: string;
      readonly eventId: string;
      readonly actorId: string;
    },
  ) => unknown;
  readonly cfpDecisionNotices: (
    db: Db,
    session: SessionInfo,
    scope: { readonly workspaceId: string; readonly eventId: string },
  ) => unknown;
}

export class DeliveryCenterAuthorizationError extends Error {
  readonly code = "DELIVERY_CENTER_ACCESS_DENIED" as const;

  constructor() {
    super("The Delivery Center is not available for this organizer scope.");
    this.name = "DeliveryCenterAuthorizationError";
  }
}

export class DeliveryCenterNotFoundError extends Error {
  readonly code = "DELIVERY_CENTER_EVENT_NOT_FOUND" as const;

  constructor() {
    super("The Delivery Center event is not available.");
    this.name = "DeliveryCenterNotFoundError";
  }
}

export class DeliveryCenterReadError extends Error {
  readonly code = "DELIVERY_CENTER_READ_FAILED" as const;

  constructor() {
    super("The Delivery Center could not read its authorized event boundary.");
    this.name = "DeliveryCenterReadError";
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/u;
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const BODY_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const STATUSES: readonly DeliveryCenterStatus[] = ["PENDING", "CLAIMED", "DELIVERED", "FAILED"];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformed(): never {
  throw new DeliveryCenterReadError();
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) malformed();
  return value;
}

function singleLine(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim().length < 1 ||
    SINGLE_LINE_CONTROL.test(value)
  ) malformed();
  return value;
}

function body(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 16_000 ||
    value.trim().length < 1 ||
    BODY_CONTROL.test(value)
  ) malformed();
  return value;
}

function email(value: unknown): string {
  const result = singleLine(value, 320);
  if (result !== result.toLowerCase().normalize("NFC") || !EMAIL.test(result)) malformed();
  return result;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") malformed();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) malformed();
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function status(value: unknown): DeliveryCenterStatus {
  if (typeof value !== "string" || !STATUSES.includes(value as DeliveryCenterStatus)) malformed();
  return value as DeliveryCenterStatus;
}

function attemptCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) malformed();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") malformed();
  return value;
}

function optionalIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) malformed();
  return value;
}

function assertStatusTimestamps(
  selectedStatus: DeliveryCenterStatus,
  queuedAt: string,
  nextAttemptAt: string | null,
  deliveredAt: string | null,
): void {
  const queued = Date.parse(queuedAt);
  if (nextAttemptAt !== null && Date.parse(nextAttemptAt) < queued) malformed();
  if (selectedStatus === "DELIVERED") {
    if (deliveredAt === null || Date.parse(deliveredAt) < queued) malformed();
  } else if (deliveredAt !== null) {
    malformed();
  }
}

function statusMeaning(selectedStatus: DeliveryCenterStatus): string {
  switch (selectedStatus) {
    case "PENDING":
      return "Queued in a local projection. No send or delivery is claimed.";
    case "CLAIMED":
      return "Claimed for local processing. No provider or SMTP handoff is shown.";
    case "DELIVERED":
      return "Recorded as DELIVERED by the local projection. No provider or SMTP receipt is exposed.";
    case "FAILED":
      return "Local processing is recorded as failed. This read-only page does not retry it.";
  }
}

function normalizeSpeakerCommunication(value: unknown, workspaceId: string, eventId: string): DeliveryCenterItem {
  if (!isRecord(value)) malformed();
  if (
    value.workspaceId !== workspaceId ||
    value.eventId !== eventId ||
    value.channel !== "local" ||
    value.providerMutation !== false ||
    value.templateKey !== "speaker-bulk-local-v1"
  ) malformed();
  const selectedStatus = status(value.status);
  const queuedAt = timestamp(value.createdAt);
  const nextAttemptAt = optionalTimestamp(value.nextAttemptAt);
  const deliveredAt = optionalTimestamp(value.deliveredAt);
  assertStatusTimestamps(selectedStatus, queuedAt, nextAttemptAt, deliveredAt);
  return {
    id: `speaker:${identifier(value.messageId)}`,
    source: "SPEAKER_COMMUNICATIONS",
    sourceLabel: "Speaker communications",
    kind: "Bulk speaker message",
    status: selectedStatus,
    recipient: {
      displayName: singleLine(value.displayName, 240),
      email: email(value.normalizedEmail),
    },
    subject: singleLine(value.subjectPreview, 512),
    body: body(value.bodyPreview),
    channel: "local",
    attemptCount: attemptCount(value.attemptCount),
    queuedAt,
    nextAttemptAt,
    deliveredAt,
    failureRecorded: null,
    providerReceipt: null,
    statusMeaning: statusMeaning(selectedStatus),
  };
}

function normalizeSharedTaskReminder(value: unknown, workspaceId: string, eventId: string): DeliveryCenterItem {
  if (!isRecord(value)) malformed();
  if (
    value.workspaceId !== workspaceId ||
    value.eventId !== eventId ||
    value.channel !== "local" ||
    value.providerMutation !== false
  ) malformed();
  const selectedStatus = status(value.status);
  const selectedAttemptCount = attemptCount(value.attemptCount);
  const queuedAt = timestamp(value.createdAt);
  const nextAttemptAt = optionalTimestamp(value.nextAttemptAt);
  const deliveredAt = optionalTimestamp(value.deliveredAt);
  assertStatusTimestamps(selectedStatus, queuedAt, nextAttemptAt, deliveredAt);
  const providerReceiptId = optionalIdentifier(value.providerReceiptId);
  const providerAcceptedAt = optionalTimestamp(value.providerAcceptedAt);
  const deliveryMode = value.deliveryMode;
  if (
    (providerReceiptId === null) !== (providerAcceptedAt === null) ||
    (providerReceiptId === null) !== (deliveryMode === null) ||
    (providerReceiptId !== null && deliveryMode !== "NO_NETWORK_SIMULATED") ||
    (selectedStatus === "DELIVERED" && (
      providerReceiptId === null || providerAcceptedAt !== deliveredAt
    )) ||
    (providerReceiptId !== null && selectedStatus !== "CLAIMED" && selectedStatus !== "DELIVERED")
  ) malformed();
  const taskTitle = singleLine(value.taskTitle, 240);
  const selectedStatusMeaning = selectedStatus === "PENDING" && selectedAttemptCount > 0
    ? "A redacted local failure is recorded and a bounded retry is scheduled. No SMTP or external provider send is claimed."
    : selectedStatus === "CLAIMED" && providerReceiptId !== null
      ? "A durable no-network receipt awaits local status recovery. No SMTP or external provider delivery is claimed."
      : selectedStatus === "CLAIMED"
        ? "Claimed by the automatic reminder worker. No SMTP or external provider handoff is shown."
        : selectedStatus === "DELIVERED"
          ? "A durable no-network simulated adapter receipt is recorded. No SMTP or external provider delivery is claimed."
          : selectedStatus === "FAILED"
            ? "Bounded local processing stopped. Failure details are redacted and no send is claimed."
            : "Queued durably for the automatic reminder worker. No send or delivery is claimed.";
  return {
    id: `shared-task:${identifier(value.messageId)}`,
    source: "SHARED_TASK_REMINDERS",
    sourceLabel: "Shared-task reminders",
    kind: `ACTION task reminder · ${taskTitle}`,
    status: selectedStatus,
    recipient: {
      displayName: singleLine(value.recipientName, 240),
      email: email(value.recipientEmail),
    },
    subject: singleLine(value.subjectPreview, 512),
    body: body(value.bodyPreview),
    channel: "local",
    attemptCount: selectedAttemptCount,
    queuedAt,
    nextAttemptAt,
    deliveredAt,
    failureRecorded: boolean(value.lastErrorRecorded),
    providerReceipt: providerReceiptId === null ? null : {
      id: providerReceiptId,
      acceptedAt: providerAcceptedAt!,
      mode: "NO_NETWORK_SIMULATED",
    },
    statusMeaning: selectedStatusMeaning,
  };
}

function normalizeCfpDecisionNotice(value: unknown, workspaceId: string, eventId: string): DeliveryCenterItem {
  if (!isRecord(value) || value.workspaceId !== workspaceId || value.eventId !== eventId) malformed();
  if (value.decision !== "ACCEPTED" && value.decision !== "REJECTED") malformed();
  if (!isRecord(value.communication)) malformed();
  const communication = value.communication;
  const expectedTemplate = value.decision === "ACCEPTED"
    ? "cfp-decision-accepted-v1"
    : "cfp-decision-rejected-v1";
  if (
    communication.evidenceVersion !== "rendered-v2" ||
    communication.status !== "PENDING" ||
    communication.channel !== "local-inbox-simulation" ||
    communication.templateKey !== expectedTemplate ||
    communication.simulated !== true ||
    communication.providerMutation !== false
  ) malformed();
  const queuedAt = timestamp(communication.queuedAt);
  return {
    id: `cfp:${identifier(communication.receiptId)}`,
    source: "CFP_DECISION_NOTICES",
    sourceLabel: "CFP decision notices",
    kind: value.decision === "ACCEPTED" ? "Accepted proposal notice" : "Rejected proposal notice",
    status: "PENDING",
    recipient: {
      displayName: singleLine(communication.recipientDisplayName, 512),
      email: email(communication.recipientEmail),
    },
    subject: singleLine(communication.renderedSubject, 1_024),
    body: body(communication.renderedBody),
    channel: "local-inbox-simulation",
    attemptCount: null,
    queuedAt,
    nextAttemptAt: null,
    deliveredAt: null,
    failureRecorded: null,
    providerReceipt: null,
    statusMeaning: "Queued in the local CFP inbox simulation. No send or delivery is claimed.",
  };
}

function sourceReport(
  key: DeliveryCenterSourceKey,
  label: string,
  state: DeliveryCenterSourceState,
  itemCount: number,
  disclosure: string,
): DeliveryCenterSourceReport {
  return { key, label, state, itemCount, disclosure };
}

function readSource(
  key: Exclude<DeliveryCenterSourceKey, "CONTENT_NOTIFICATIONS">,
  label: string,
  disclosure: string,
  load: () => unknown,
  normalize: (value: unknown) => DeliveryCenterItem,
): { readonly report: DeliveryCenterSourceReport; readonly items: readonly DeliveryCenterItem[] } {
  try {
    const values = array(load());
    const items = values.map(normalize);
    if (new Set(items.map((item) => item.id)).size !== items.length) malformed();
    return {
      report: sourceReport(key, label, items.length === 0 ? "EMPTY" : "READY", items.length, disclosure),
      items,
    };
  } catch {
    return {
      report: sourceReport(
        key,
        label,
        "ERROR",
        0,
        `${disclosure} This source could not be validated, so none of its rows are shown.`,
      ),
      items: [],
    };
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function loadCfpDecisionNotices(
  db: Db,
  session: SessionInfo,
  scope: { readonly workspaceId: string; readonly eventId: string },
): unknown {
  const overview = readCfpOrganizerOverview(db, session, scope.eventId);
  if (overview.event.id !== scope.eventId) malformed();
  const notices: UnknownRecord[] = [];
  for (const callSummary of overview.calls) {
    if (callSummary.eventId !== scope.eventId) malformed();
    const call = readCfpOrganizerCall(db, session, scope.eventId, callSummary.callId);
    if (call.summary.eventId !== scope.eventId || call.summary.callId !== callSummary.callId) malformed();
    for (const submission of call.submissions) {
      if (submission.decision?.communication) {
        notices.push({
          workspaceId: scope.workspaceId,
          eventId: scope.eventId,
          decision: submission.decision.decision,
          communication: submission.decision.communication,
        });
      }
    }
  }
  return notices;
}

const DEFAULT_LOADERS: DeliveryCenterSourceLoaders = {
  speakerCommunications: (db, scope) => listSpeakerCommunicationDeliveryLog(db, scope),
  sharedTaskReminders: (db, scope) => getSyntheticSpeakerOperationsRepository(db)
    .listActionTaskReminderDeliveries(scope),
  cfpDecisionNotices: loadCfpDecisionNotices,
};

function authorizeScope(
  db: Db,
  session: SessionInfo,
  input: DeliveryCenterReadInput,
): { readonly event: EventRow; readonly workspace: DeliveryCenterProjection["workspace"] } {
  if (
    !IDENTIFIER.test(input.workspaceSlug) ||
    !IDENTIFIER.test(input.eventId) ||
    session.workspaceSlug !== input.workspaceSlug ||
    !hasCapability(session, "phase0.pipeline.manage")
  ) throw new DeliveryCenterAuthorizationError();

  let persisted: {
    readonly accountId: string;
    readonly workspaceId: string;
    readonly role: string;
    readonly workspaceSlug: string;
    readonly workspaceName: string;
  } | undefined;
  try {
    persisted = db.prepare(
      `SELECT account.id AS accountId,
              account.workspace_id AS workspaceId,
              account.role,
              workspace.slug AS workspaceSlug,
              workspace.name AS workspaceName
         FROM accounts account
         JOIN workspaces workspace ON workspace.id = account.workspace_id
        WHERE account.id = ? AND account.workspace_id = ? AND workspace.slug = ?
        LIMIT 1`,
    ).get(session.accountId, session.workspaceId, input.workspaceSlug) as typeof persisted;
  } catch {
    throw new DeliveryCenterAuthorizationError();
  }
  if (
    !persisted ||
    persisted.accountId !== session.accountId ||
    persisted.workspaceId !== session.workspaceId ||
    persisted.role !== session.role ||
    persisted.workspaceSlug !== session.workspaceSlug
  ) throw new DeliveryCenterAuthorizationError();

  let event: EventRow | null;
  try {
    event = getEvent(db, session.workspaceId, input.eventId);
  } catch {
    throw new DeliveryCenterReadError();
  }
  if (!event) throw new DeliveryCenterNotFoundError();
  try {
    identifier(event.id);
    singleLine(event.name, 240);
    singleLine(event.timezone, 120);
    singleLine(event.lifecycle, 80);
    timestamp(event.startsAt);
    timestamp(event.endsAt);
    timestamp(event.createdAt);
  } catch {
    throw new DeliveryCenterReadError();
  }
  return {
    event,
    workspace: {
      id: session.workspaceId,
      slug: persisted.workspaceSlug,
      name: singleLine(persisted.workspaceName, 240),
    },
  };
}

export type DeliveryCenterReader = (
  db: Db,
  session: SessionInfo,
  input: DeliveryCenterReadInput,
) => DeliveryCenterProjection;

export function createDeliveryCenterReader(
  overrides: Partial<DeliveryCenterSourceLoaders> = {},
): DeliveryCenterReader {
  const loaders: DeliveryCenterSourceLoaders = { ...DEFAULT_LOADERS, ...overrides };
  return (db, session, input) => {
    const scope = authorizeScope(db, session, input);
    const sourceScope = { workspaceId: session.workspaceId, eventId: scope.event.id };
    const speaker = readSource(
      "SPEAKER_COMMUNICATIONS",
      "Speaker communications",
      "Rendered recipients and messages come from the typed event-scoped local speaker delivery log.",
      () => loaders.speakerCommunications(db, sourceScope),
      (value) => normalizeSpeakerCommunication(value, sourceScope.workspaceId, sourceScope.eventId),
    );
    const reminders = readSource(
      "SHARED_TASK_REMINDERS",
      "Shared-task reminders",
      "Rendered reminders come from the typed event-scoped ACTION-task reminder projection.",
      () => loaders.sharedTaskReminders(db, {
        kind: "organizer",
        ...sourceScope,
        actorId: session.accountId,
      }),
      (value) => normalizeSharedTaskReminder(value, sourceScope.workspaceId, sourceScope.eventId),
    );
    const cfp = readSource(
      "CFP_DECISION_NOTICES",
      "CFP decision notices",
      "Rendered notices come from current event CFP decision communication receipts.",
      () => loaders.cfpDecisionNotices(db, session, sourceScope),
      (value) => normalizeCfpDecisionNotice(value, sourceScope.workspaceId, sourceScope.eventId),
    );
    const content = sourceReport(
      "CONTENT_NOTIFICATIONS",
      "Content notifications",
      "UNAVAILABLE",
      0,
      "No existing event-scoped contract exposes a rendered content-notification recipient, subject, and body. Generic outbox payloads are deliberately not read.",
    );
    const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
    const items = [...speaker.items, ...reminders.items, ...cfp.items].sort((left, right) =>
      compareText(left.source, right.source) ||
      compareText(right.queuedAt, left.queuedAt) ||
      compareText(left.id, right.id));
    const count = (selectedStatus: DeliveryCenterStatus): number =>
      items.filter((item) => item.status === selectedStatus).length;
    return deepFreeze({
      schema: DELIVERY_CENTER_SCHEMA,
      workspace: scope.workspace,
      event: {
        id: scope.event.id,
        name: scope.event.name,
        timezone: scope.event.timezone,
        lifecycle: scope.event.lifecycle,
      },
      readOnly: true,
      providerContacted: false,
      smtpContacted: false,
      transportDisclosure: "Read-only local evidence only. This page does not contact an email provider or SMTP transport, send messages, retry work, or create delivery state.",
      sources: [speaker.report, reminders.report, cfp.report, content],
      items,
      summary: {
        total: items.length,
        pending: count("PENDING"),
        claimed: count("CLAIMED"),
        delivered: count("DELIVERED"),
        failed: count("FAILED"),
      },
    });
  };
}

export const readDeliveryCenter = createDeliveryCenterReader();
