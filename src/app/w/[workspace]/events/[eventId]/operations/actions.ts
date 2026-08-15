"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isDenialError } from "@/server/auth";
import { getDb } from "@/server/db";
import {
  correctOperationsAttendance,
  OperationsAttendanceError,
  recordOperationsAttendance,
} from "@/server/services/outcomes";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function exactFormText(
  formData: FormData,
  name: string,
  maximum: number,
): string | null {
  const values = formData.getAll(name);
  if (
    values.length !== 1 ||
    typeof values[0] !== "string" ||
    values[0].length < 1 ||
    values[0].length > maximum ||
    CONTROL_CHARACTER.test(values[0])
  ) {
    return null;
  }
  return values[0];
}

function hasExactFields(formData: FormData, expected: readonly string[]): boolean {
  const keys = [...formData.keys()];
  const transportKeys = keys.filter((key) => key.startsWith("$ACTION_"));
  const businessKeys = keys.filter((key) => !key.startsWith("$ACTION_"));
  return (
    transportKeys.length <= 16 &&
    transportKeys.every((key) => key.length <= 160 && !CONTROL_CHARACTER.test(key)) &&
    businessKeys.length === expected.length &&
    businessKeys.every((key) => expected.includes(key)) &&
    expected.every((name) => formData.getAll(name).length === 1)
  );
}

function operationsPath(workspace: string, eventId: string, result: string, receiptId: string | null): string {
  const query = new URLSearchParams({ attendanceResult: result });
  if (receiptId) query.set("attendanceReceipt", receiptId);
  return `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(eventId)}/operations?${query.toString()}`;
}

function recordFailureCode(error: unknown): string {
  if (isDenialError(error)) return "record-unavailable";
  if (error instanceof OperationsAttendanceError) {
    if (error.code === "ATTENDANCE_EVENT_CLOSED") return "record-closed";
    if (error.code === "ATTENDANCE_EVENT_NOT_LIVE") return "record-not-live";
    if (error.code === "ATTENDANCE_TIME_INVALID") return "record-time-invalid";
    if (error.code === "ATTENDANCE_INPUT_INVALID" || error.code === "ATTENDANCE_TARGET_NOT_FOUND") {
      return "record-invalid";
    }
    if (error.code === "ATTENDANCE_TARGET_AMBIGUOUS" || error.code.endsWith("_CONFLICT") || error.code.endsWith("_AMBIGUOUS")) {
      return "record-conflict";
    }
  }
  return "record-failed";
}

function correctionFailureCode(error: unknown): string {
  if (isDenialError(error)) return "correction-unavailable";
  if (error instanceof OperationsAttendanceError) {
    if (error.code === "ATTENDANCE_INPUT_INVALID") return "correction-invalid";
    if (error.code === "ATTENDANCE_SOURCE_NOT_FOUND") return "correction-unavailable";
    if (
      error.code === "ATTENDANCE_ALREADY_CORRECTED" ||
      error.code === "ATTENDANCE_IDEMPOTENCY_CONFLICT" ||
      error.code === "ATTENDANCE_SOURCE_AMBIGUOUS" ||
      error.code === "ATTENDANCE_HISTORY_INVALID"
    ) {
      return "correction-conflict";
    }
  }
  return "correction-failed";
}

export async function recordOperationsAttendanceAction(
  workspace: string,
  eventId: string,
  formData: FormData,
): Promise<never> {
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  let resultCode: string;
  let receiptId: string | null = null;
  try {
    if (!SAFE_IDENTIFIER.test(eventId) || !hasExactFields(formData, ["personId", "programUnitId", "observedAt"])) {
      throw new OperationsAttendanceError("ATTENDANCE_INPUT_INVALID");
    }
    const personId = exactFormText(formData, "personId", 160);
    const programUnitId = exactFormText(formData, "programUnitId", 160);
    const observedAt = exactFormText(formData, "observedAt", 40);
    if (
      !personId || !programUnitId || !observedAt ||
      !SAFE_IDENTIFIER.test(personId) || !SAFE_IDENTIFIER.test(programUnitId)
    ) {
      throw new OperationsAttendanceError("ATTENDANCE_INPUT_INVALID");
    }
    const receipt = recordOperationsAttendance(getDb(), session, {
      eventId,
      personId,
      programUnitId,
      observedAt,
    });
    resultCode = receipt.disposition === "created" ? "record-created" : "record-replayed";
    receiptId = receipt.observationId;
  } catch (error) {
    resultCode = recordFailureCode(error);
  }
  const path = operationsPath(workspace, eventId, resultCode, receiptId);
  try {
    revalidatePath(path.split("?", 1)[0]!);
  } catch {
    // This route is force-dynamic; the redirect still reloads the durable database receipt.
  }
  redirect(path);
}

export async function correctOperationsAttendanceAction(
  workspace: string,
  eventId: string,
  formData: FormData,
): Promise<never> {
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  let resultCode: string;
  let receiptId: string | null = null;
  try {
    if (!SAFE_IDENTIFIER.test(eventId) || !hasExactFields(formData, ["originalObservationId", "reason"])) {
      throw new OperationsAttendanceError("ATTENDANCE_INPUT_INVALID");
    }
    const originalObservationId = exactFormText(formData, "originalObservationId", 160);
    const reason = exactFormText(formData, "reason", 1120);
    if (!originalObservationId || !reason || !SAFE_IDENTIFIER.test(originalObservationId)) {
      throw new OperationsAttendanceError("ATTENDANCE_INPUT_INVALID");
    }
    const receipt = correctOperationsAttendance(getDb(), session, {
      eventId,
      originalObservationId,
      reason,
    });
    resultCode = receipt.disposition === "created" ? "correction-created" : "correction-replayed";
    receiptId = receipt.relationId;
  } catch (error) {
    resultCode = correctionFailureCode(error);
  }
  const path = operationsPath(workspace, eventId, resultCode, receiptId);
  try {
    revalidatePath(path.split("?", 1)[0]!);
  } catch {
    // This route is force-dynamic; the redirect still reloads the durable database receipt.
  }
  redirect(path);
}
