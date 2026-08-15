"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionResult } from "@/server/actions";
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
import { createEventWithUnit } from "@/server/services/events";

const EVENT_FAILURE_MESSAGES: Record<string, string> = {
  EVENT_CARDINALITY_INVALID:
    "This workspace already has the maximum of two events in this bounded portfolio flow.",
  EVENT_COMMAND_CONFLICT:
    "That event command conflicts with an existing event. Replay the original details or choose a new event name.",
  INVALID_EVENT: "Event and program-unit names must contain at least two characters.",
  INVALID_CAPACITY: "Program-unit capacity must be a positive integer.",
  INVALID_EVENT_TIME: "Event start and end times must be valid and chronological.",
};

function eventFailure(error: unknown): ActionResult {
  const rawCode = error instanceof Error ? error.message.split(":", 1)[0] : "EVENT_FAILED";
  return {
    ok: false,
    code: rawCode,
    message: EVENT_FAILURE_MESSAGES[rawCode] ?? "Event operation could not be completed. Try again.",
  };
}

function parseEventInput(formData: FormData):
  | { ok: true; eventName: string; unitName: string; capacity: number }
  | { ok: false } {
  const eventNameValue = formData.get("eventName");
  const unitNameValue = formData.get("unitName");
  const capacityValue = formData.get("capacity");
  if (
    typeof eventNameValue !== "string" ||
    typeof unitNameValue !== "string" ||
    typeof capacityValue !== "string"
  ) {
    return { ok: false };
  }
  const eventName = eventNameValue.trim();
  const unitName = unitNameValue.trim();
  const capacity = Number(capacityValue);
  if (
    eventName.length < 2 ||
    eventName.length > 80 ||
    unitName.length < 2 ||
    unitName.length > 80 ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 99
  ) {
    return { ok: false };
  }
  return { ok: true, eventName, unitName, capacity };
}

/**
 * Portfolio-only creation command. The workspace is always derived from the authenticated
 * session, and a successful command returns to the authoritative event portfolio so a newly
 * created event is immediately visible and selectable.
 */
export async function createEventAction(
  _state: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let session: SessionInfo;
  let eventId: string;
  try {
    const store = await cookies();
    const db = getDb();
    const resolved = resolveSession(db, store.get(SESSION_COOKIE)?.value);
    if (!resolved) {
      throw new DenialError("SESSION_REQUIRED", "Sign in to continue.", "session");
    }
    requireCapability(db, resolved, "phase0.pipeline.manage");
    session = resolved;

    const parsed = parseEventInput(formData);
    if (!parsed.ok) {
      return {
        ok: false,
        code: "BAD_EVENT",
        message: "Event and program-unit names are required (2–80 chars), capacity 1–99.",
      };
    }
    const result = createEventWithUnit(db, session.workspaceId, {
      kind: "account",
      ref: session.accountId,
    }, {
      eventName: parsed.eventName,
      unitName: parsed.unitName,
      capacity: parsed.capacity,
    });
    eventId = result.eventId;
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return eventFailure(error);
  }

  try {
    revalidatePath(`/w/${session.workspaceSlug}/events`);
  } catch {
    return {
      ok: false,
      code: "CACHE_INVALIDATION_FAILED",
      message: "The event was committed, but the portfolio could not be refreshed. Reload to continue.",
    };
  }
  redirect(`/w/${encodeURIComponent(session.workspaceSlug)}/events?created=${encodeURIComponent(eventId)}`);
}
