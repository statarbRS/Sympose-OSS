"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getDb } from "@/server/db";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";
import {
  CfpOrganizerError,
  saveCfpOrganizerCall,
  type SaveOrganizerCfpCallInput,
} from "@/server/services/cfp/organizer";
import {
  CfpDecisionError,
  decideCfpSubmission,
  type CfpSubmissionDecision,
  type CfpSubmissionDecisionReceipt,
} from "@/server/services/cfp/decisions";

export type OrganizerCfpActionState =
  | { readonly kind: "idle"; readonly message: "" }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export type OrganizerCfpDecisionActionState =
  | { readonly kind: "idle"; readonly message: "" }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
  | { readonly kind: "success"; readonly receipt: CfpSubmissionDecisionReceipt };

function errorState(code: string, message: string): OrganizerCfpActionState {
  return { kind: "error", code, message };
}

function readText(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

function readTimestamp(formData: FormData, name: string): string | null {
  const value = readText(formData, name);
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return `${value}:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(value)) return `${value}.000Z`;
  return value;
}

function readJson(formData: FormData, name: string): unknown | undefined {
  const value = readText(formData, name);
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export async function saveOrganizerCfpAction(
  workspace: string,
  eventId: string,
  callId: string | null,
  expectedUpdatedAt: string | null,
  _previous: OrganizerCfpActionState,
  formData: FormData,
): Promise<OrganizerCfpActionState> {
  const fields = readJson(formData, "fields");
  const rules = readJson(formData, "rules");
  const policy = readJson(formData, "policy");
  if (fields === undefined || rules === undefined || policy === undefined) {
    return errorState("INPUT_INVALID", "Fields, rules, and policy must each contain valid JSON.");
  }

  const input: SaveOrganizerCfpCallInput = {
    eventId,
    callId,
    expectedUpdatedAt,
    name: readText(formData, "name") ?? "",
    slug: readText(formData, "slug") ?? "",
    accessMode: (readText(formData, "accessMode") ?? "PUBLIC") as SaveOrganizerCfpCallInput["accessMode"],
    state: (readText(formData, "state") ?? "DRAFT") as SaveOrganizerCfpCallInput["state"],
    timezone: readText(formData, "timezone") ?? "UTC",
    opensAt: readTimestamp(formData, "opensAt"),
    closesAt: readTimestamp(formData, "closesAt"),
    fields,
    rules,
    policy,
    publish: readText(formData, "publish") === "true",
  };

  try {
    const session = await getRouteSession();
    requireOrganizerWorkspaceRoute(session, workspace);
    const result = saveCfpOrganizerCall(getDb(), session, input);
    const base = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(eventId)}/cfp`;
    revalidatePath(base);
    revalidatePath(`${base}/${encodeURIComponent(result.callId)}`);
    redirect(`${base}/${encodeURIComponent(result.callId)}?saved=1`);
  } catch (error) {
    if (error instanceof CfpOrganizerError) {
      return errorState(error.code, error.message);
    }
    throw error;
  }
}

export async function decideOrganizerCfpSubmissionAction(
  workspace: string,
  eventId: string,
  callId: string,
  submissionId: string,
  expectedRevisionId: string,
  decision: CfpSubmissionDecision,
  _previous: OrganizerCfpDecisionActionState,
  _formData: FormData,
): Promise<OrganizerCfpDecisionActionState> {
  try {
    const session = await getRouteSession();
    requireOrganizerWorkspaceRoute(session, workspace);
    const receipt = decideCfpSubmission(getDb(), session, {
      workspaceSlug: session.workspaceSlug,
      eventId,
      callId,
      submissionId,
      expectedRevisionId,
      decision,
    });
    const base = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(eventId)}`;
    revalidatePath(`${base}/cfp/${encodeURIComponent(callId)}`);
    revalidatePath(`${base}/review`);
    return { kind: "success", receipt };
  } catch (error) {
    if (error instanceof CfpDecisionError) {
      return errorState(error.code, error.message) as OrganizerCfpDecisionActionState;
    }
    throw error;
  }
}
