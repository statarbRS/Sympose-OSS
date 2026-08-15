"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import {
  isDenialError,
  requireCapability,
  resolveSession,
  SESSION_COOKIE,
  type SessionInfo,
} from "@/server/auth";
import { getDb } from "@/server/db";
import {
  executeScheduleDraftCommand,
  MAX_SCHEDULE_DRAFT_BYTES,
  parseScheduleDraftCommand,
  readScheduleDraft,
  ScheduleDraftRevisionConflictError,
  SchedulePersistenceError,
} from "@/server/services/scheduling/persistence";
import {
  approveScheduleDraft,
  scheduleApprovalSubject,
  ScheduleApprovalError,
  type ScheduleApprovalActionResult,
} from "@/server/services/scheduling/approval";
import { fingerprintOf } from "@/server/canonical";
import type { ScheduleDraftActionResult } from "@/server/services/scheduling";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function formText(formData: FormData, name: string, maximum: number): string | null {
  const values = formData.getAll(name);
  if (
    values.length !== 1
    || typeof values[0] !== "string"
    || values[0].trim().length === 0
    || values[0].length > maximum
    || CONTROL_CHARACTER.test(values[0])
  ) {
    return null;
  }
  return values[0].trim();
}

function optionalFormText(formData: FormData, name: string, maximum: number): string | undefined | null {
  const values = formData.getAll(name);
  if (values.length === 0) return undefined;
  return formText(formData, name, maximum);
}

function failure(
  code: string,
  message: string,
  pointer?: ReturnType<typeof readScheduleDraft>["pointer"],
): ScheduleDraftActionResult {
  return { ok: false, code, message, ...(pointer === undefined ? {} : { pointer }) };
}

function messageForPersistenceError(error: SchedulePersistenceError): string {
  if (error.code === "SCHEDULE_REVISION_CONFLICT") {
    return "The schedule changed on the server. The latest draft was loaded.";
  }
  if (error.code === "SCHEDULE_CONTEXT_CONFLICT") {
    return "The approved plan, accepted commitments, or accepted CFP sessions changed. Reload the schedule before saving.";
  }
  if (error.code === "SCHEDULE_SCOPE_DENIED") {
    return "The schedule draft is not available in this event.";
  }
  if (error.code === "SCHEDULE_EVENT_CLOSED") {
    return "This event is closed, so its schedule draft cannot be changed.";
  }
  if (error.code === "SCHEDULE_IDEMPOTENCY_CONFLICT") {
    return "The schedule request key was already used for a different command.";
  }
  if (error.code === "SCHEDULE_INPUT_INVALID" || error.code.endsWith("_NOT_FOUND") || error.code.startsWith("INVALID_") || error.code.startsWith("DUPLICATE_")) {
    return "The schedule draft command is invalid.";
  }
  return "The schedule draft could not be saved. Try again.";
}

function currentPointer(
  db: Parameters<typeof readScheduleDraft>[0],
  session: SessionInfo,
  eventId: string | null,
): ReturnType<typeof readScheduleDraft>["pointer"] {
  if (!eventId) return null;
  try {
    return readScheduleDraft(db, { workspaceId: session.workspaceId, eventId }).pointer;
  } catch {
    return null;
  }
}

/**
 * The browser posts only a scoped event lookup, a compare-and-swap revision, and a bounded
 * command. Workspace ownership, organizer capability, the event record, and the current draft
 * are all resolved again on the server before the deterministic command runs.
 */
export async function saveScheduleDraftAction(formData: FormData): Promise<ScheduleDraftActionResult> {
  let db: ReturnType<typeof getDb>;
  let session: SessionInfo | null = null;
  let eventId: string | null = null;
  try {
    db = getDb();
    const store = await cookies();
    const resolved = resolveSession(db, store.get(SESSION_COOKIE)?.value);
    if (!resolved) {
      return failure("SESSION_REQUIRED", "Sign in to continue.");
    }
    session = resolved;
    requireCapability(db, resolved, "phase0.pipeline.manage");

    const eventValue = formText(formData, "eventId", 160);
    const expectedRevisionValue = formText(formData, "expectedRevision", 32);
    const planVersionId = formText(formData, "planVersionId", 160);
    const planFingerprint = formText(formData, "planFingerprint", 160);
    const acceptedInventoryFingerprint = formText(formData, "acceptedInventoryFingerprint", 160);
    const cfpSessionInventoryFingerprint = formText(formData, "cfpSessionInventoryFingerprint", 160);
    const commandValue = formText(formData, "command", MAX_SCHEDULE_DRAFT_BYTES);
    const idempotencyKey = formText(formData, "idempotencyKey", 160);
    const requestId = formText(formData, "requestId", 160);
    const activeDayId = optionalFormText(formData, "activeDayId", 160);
    if (!eventValue || !IDENTIFIER.test(eventValue) || !expectedRevisionValue || !planVersionId || !planFingerprint || !acceptedInventoryFingerprint || !cfpSessionInventoryFingerprint || !commandValue || !idempotencyKey || !requestId || activeDayId === null) {
      return failure("SCHEDULE_INPUT_INVALID", "The schedule draft command is invalid.");
    }
    eventId = eventValue;
    const expectedRevision = Number(expectedRevisionValue);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return failure("SCHEDULE_INPUT_INVALID", "The schedule draft command is invalid.");
    }
    if (activeDayId !== undefined && !IDENTIFIER.test(activeDayId)) {
      return failure("SCHEDULE_INPUT_INVALID", "The schedule draft command is invalid.");
    }
    const command = parseScheduleDraftCommand(commandValue);
    const result = executeScheduleDraftCommand(db, {
      workspaceId: resolved.workspaceId,
      eventId,
    }, {
      expectedRevision,
      planVersionId,
      planFingerprint,
      acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint,
      command,
      idempotencyKey,
      requestId,
      activeDayId,
      actorAccountId: resolved.accountId,
    });
    try {
      revalidatePath(`/w/${encodeURIComponent(resolved.workspaceSlug)}/events/${encodeURIComponent(eventId)}/program`);
    } catch {
      // The durable command and its response remain authoritative when cache invalidation is unavailable.
    }
    return {
      ok: true,
      code: result.changed ? "SCHEDULE_DRAFT_SAVED" : "SCHEDULE_DRAFT_UNCHANGED",
      changed: result.changed,
      pointer: result.pointer,
      scheduleAuthorityFingerprint: result.pointer
        ? fingerprintOf(scheduleApprovalSubject(result.pointer))
        : null,
    };
  } catch (error) {
    if (error instanceof ScheduleDraftRevisionConflictError) {
      return failure(error.code, "The schedule changed on the server. The latest draft was loaded.", error.authoritativePointer);
    }
    if (isDenialError(error)) {
      return failure(error.code, "The schedule draft is not available to this account.");
    }
    if (error instanceof SchedulePersistenceError) {
      return failure(
        error.code,
        messageForPersistenceError(error),
        session ? currentPointer(db!, session, eventId) : null,
      );
    }
    return failure("SCHEDULE_DRAFT_FAILED", "The schedule draft could not be saved. Try again.");
  }
}

function approvalFailure(code: string, message: string): ScheduleApprovalActionResult {
  return { ok: false, code, message };
}

function messageForApprovalError(error: ScheduleApprovalError): string {
  if (error.code === "SCHEDULE_APPROVAL_REVISION_CONFLICT") {
    return "The schedule changed on the server. Reload before approving.";
  }
  if (error.code === "SCHEDULE_APPROVAL_CONTEXT_CONFLICT") {
    return "The exact plan, inventory, resources, or placements changed. Reload before approving.";
  }
  if (error.code === "SCHEDULE_APPROVAL_DRAFT_NOT_PERSISTED" ||
      error.code === "SCHEDULE_APPROVAL_DRAFT_AUTHORITY_INVALID") {
    return "Save this exact schedule draft before approving it.";
  }
  if (error.code === "SCHEDULE_APPROVAL_NOT_READY") return "Place every session before approval.";
  if (error.code === "SCHEDULE_APPROVAL_HAS_CONFLICTS") return "Resolve every hard conflict before approval.";
  if (error.code === "SCHEDULE_APPROVAL_EVENT_CLOSED") return "This event schedule is closed to approval.";
  if (error.code === "SCHEDULE_APPROVAL_IDEMPOTENCY_CONFLICT") {
    return "This approval request key was already used for a different schedule.";
  }
  if (error.code === "SCHEDULE_APPROVAL_SCOPE_DENIED" || error.code === "SCHEDULE_APPROVAL_AUTHORITY_INVALID") {
    return "The schedule approval is not available to this account.";
  }
  if (error.code === "SCHEDULE_APPROVAL_INPUT_INVALID") return "The schedule approval request is invalid.";
  return "The schedule approval could not be recorded. Reload and try again.";
}

/**
 * Approval is a separate immutable organizer decision over the server's exact persisted revision.
 * Caller-supplied plan, inventory, placement, actor, and workspace fields are intentionally absent.
 */
export async function approveScheduleDraftAction(formData: FormData): Promise<ScheduleApprovalActionResult> {
  try {
    const db = getDb();
    const store = await cookies();
    const session = resolveSession(db, store.get(SESSION_COOKIE)?.value);
    if (!session) return approvalFailure("SESSION_REQUIRED", "Sign in to continue.");
    requireCapability(db, session, "phase0.pipeline.manage");

    const eventId = formText(formData, "eventId", 160);
    const revisionValue = formText(formData, "expectedRevision", 32);
    const expectedScheduleAuthorityFingerprint = formText(
      formData,
      "expectedScheduleAuthorityFingerprint",
      64,
    );
    const idempotencyKey = formText(formData, "idempotencyKey", 160);
    const requestId = formText(formData, "requestId", 160);
    const expectedRevision = Number(revisionValue);
    if (!eventId || !IDENTIFIER.test(eventId) || !revisionValue ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
        !expectedScheduleAuthorityFingerprint || !/^[a-f0-9]{64}$/u.test(expectedScheduleAuthorityFingerprint) ||
        !idempotencyKey || !IDENTIFIER.test(idempotencyKey) ||
        !requestId || !IDENTIFIER.test(requestId)) {
      return approvalFailure("SCHEDULE_APPROVAL_INPUT_INVALID", "The schedule approval request is invalid.");
    }

    const result = approveScheduleDraft(db, {
      workspaceId: session.workspaceId,
      eventId,
    }, {
      expectedRevision,
      expectedScheduleAuthorityFingerprint,
      idempotencyKey,
      requestId,
      actorAccountId: session.accountId,
    });
    try {
      revalidatePath(`/w/${encodeURIComponent(session.workspaceSlug)}/events/${encodeURIComponent(eventId)}/program`);
      revalidatePath(`/w/${encodeURIComponent(session.workspaceSlug)}/events/${encodeURIComponent(eventId)}/publication`);
    } catch {
      // The immutable approval receipt remains authoritative if cache invalidation is unavailable.
    }
    return {
      ok: true,
      code: result.changed ? "SCHEDULE_APPROVED" : "SCHEDULE_ALREADY_APPROVED",
      approval: result.approval,
    };
  } catch (error) {
    if (isDenialError(error)) {
      return approvalFailure(error.code, "The schedule approval is not available to this account.");
    }
    if (error instanceof ScheduleApprovalError) {
      return approvalFailure(error.code, messageForApprovalError(error));
    }
    return approvalFailure("SCHEDULE_APPROVAL_FAILED", "The schedule approval could not be recorded. Reload and try again.");
  }
}
