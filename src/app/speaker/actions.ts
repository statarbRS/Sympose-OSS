"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "@/server/db";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_SPEAKER_PERSON_ID,
  EVALUATOR_WORKSPACE_ID,
} from "@/server/evaluator-demo";
import {
  getSyntheticSpeakerOperationsRepository,
} from "@/server/services/speaker-operations";
import { isLocalEvaluatorProfile, issueSpeakerPortalToken, reserveSpeakerPortalRequesterLookup, speakerPortalLookupBudgetKeyFromHeaders } from "@/server/services/speaker-portal-access";
import { createSpeakerArtifactRecord } from "@/server/services/artifact-records";
import { MAX_HEADSHOT_BYTES, MAX_SLIDES_BYTES } from "@/server/services/artifact-store";

const PORTAL_COOKIE = "sympose_speaker_portal";
const SUPPORT_COOKIE = "sympose_speaker_support_preview";

function field(formData: FormData, name: string, max = 240): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("INVALID_SPEAKER_PORTAL_COMMAND");
  return value;
}

function optionalField(formData: FormData, name: string, max = 240): string {
  const value = formData.get(name);
  if (value === null) return "";
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("INVALID_SPEAKER_PORTAL_COMMAND");
  return value;
}

async function token(): Promise<string> {
  const value = (await cookies()).get(PORTAL_COOKIE)?.value;
  if (!value) throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  return value;
}

async function lookupBudget(route: string): Promise<string> {
  try {
    return speakerPortalLookupBudgetKeyFromHeaders(await headers(), route);
  } catch {
    // Missing request context uses the conservative anonymous bucket.
  }
  return speakerPortalLookupBudgetKeyFromHeaders(new Headers(), route);
}

function setPortalCookie(store: Awaited<ReturnType<typeof cookies>>, value: string): void {
  store.set(PORTAL_COOKIE, value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/speaker", maxAge: 1800 });
}

export async function openSpeakerPortal(formData: FormData): Promise<void> {
  const submittedToken = field(formData, "token", 128);
  const repository = getSyntheticSpeakerOperationsRepository(getDb());
  const access = repository.resolvePortalToken(submittedToken, await lookupBudget("open"));
  if (!access || !access.active) throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  const store = await cookies();
  setPortalCookie(store, submittedToken);
  store.delete(SUPPORT_COOKIE);
  redirect("/speaker");
}

async function openLocalEvaluatorSpeakerPortal(input: {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly budgetRoute: string;
}): Promise<void> {
  if (!isLocalEvaluatorProfile()) throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  const budgetKey = await lookupBudget(input.budgetRoute);
  if (!reserveSpeakerPortalRequesterLookup(budgetKey)) throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  const db = getDb();
  const actor = db.prepare(
    `SELECT session_row.id AS sessionId
       FROM sessions session_row
       JOIN accounts account
         ON account.id = session_row.account_id
        AND account.workspace_id = session_row.workspace_id
      WHERE session_row.account_id = ?
        AND session_row.workspace_id = ?
      ORDER BY session_row.created_at DESC, session_row.rowid DESC
      LIMIT 1`,
  ).get(input.accountId, input.workspaceId) as { sessionId: string } | undefined;
  if (!actor) throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  const issued = issueSpeakerPortalToken(db, {
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    personId: input.personId,
  }, {
    accountId: input.accountId,
    sessionId: actor.sessionId,
  });
  const access = issued.access;
  if (
    !access?.active ||
    access.workspaceId !== input.workspaceId ||
    access.eventId !== input.eventId ||
    access.personId !== input.personId
  ) {
    throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  }
  const store = await cookies();
  setPortalCookie(store, issued.token);
  store.delete(SUPPORT_COOKIE);
  redirect("/speaker");
}

export async function openAcmeSpeakerPortal(): Promise<void> {
  return openLocalEvaluatorSpeakerPortal({
    accountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    workspaceId: EVALUATOR_WORKSPACE_ID,
    eventId: EVALUATOR_EVENT_ID,
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    budgetRoute: "evaluator-open-acme",
  });
}

export async function openDevflowSpeakerPortal(): Promise<void> {
  return openLocalEvaluatorSpeakerPortal({
    accountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    budgetRoute: "evaluator-open-devflow",
  });
}

/** Compatibility export for existing local action callers; the entry point uses DevFlow directly. */
export async function openSyntheticEvaluatorSpeakerPortal(): Promise<void> {
  return openDevflowSpeakerPortal();
}

export async function closeSpeakerPortal(): Promise<void> {
  const store = await cookies();
  store.delete(PORTAL_COOKIE);
  store.delete(SUPPORT_COOKIE);
  redirect("/speaker/entry");
}

export async function respondToSpeakerInvitation(formData: FormData): Promise<void> {
  const submittedToken = await token();
  const budgetKey = await lookupBudget("respond");
  const invitationId = field(formData, "invitationId");
  const response = field(formData, "response");
  if (response !== "ACCEPTED" && response !== "DECLINED") throw new Error("INVALID_SPEAKER_PORTAL_COMMAND");
  getSyntheticSpeakerOperationsRepository(getDb()).respondToInvitation(submittedToken, invitationId, response, budgetKey);
  revalidatePath("/speaker");
}

export async function completeSpeakerTask(formData: FormData): Promise<void> {
  const submittedToken = await token();
  getSyntheticSpeakerOperationsRepository(getDb()).completeTask(submittedToken, field(formData, "taskId"), { note: optionalField(formData, "note", 1000) || undefined, idempotencyKey: optionalField(formData, "idempotencyKey", 240) || undefined }, await lookupBudget("complete"));
  revalidatePath("/speaker");
}

function payloadFromForm(formData: FormData): unknown {
  const contentKind = field(formData, "contentKind", 40);
  switch (contentKind) {
    case "BIO": return { kind: "BIO", bio: field(formData, "bio", 12000) };
    case "SESSION_TITLE": return { kind: "SESSION_TITLE", title: field(formData, "title", 240) };
    case "SESSION_DESCRIPTION": return { kind: "SESSION_DESCRIPTION", description: field(formData, "description", 12000) };
    case "SOCIAL_LINKS": return { kind: "SOCIAL_LINKS", links: JSON.parse(field(formData, "linksJson", 16000)) as unknown };
    case "HEADSHOT":
    case "SLIDES":
      throw new Error("SPEAKER_ARTIFACT_FILE_REQUIRED");
    case "LOGISTICS": return { kind: "LOGISTICS", arrivalWindow: field(formData, "arrivalWindow", 240), travelMode: field(formData, "travelMode", 40), dietaryNotes: optionalField(formData, "dietaryNotes", 1000) };
    case "ACKNOWLEDGEMENT": return { kind: "ACKNOWLEDGEMENT", statementId: field(formData, "statementId", 160), acknowledged: formData.get("acknowledged") === "true" };
    default: throw new Error("INVALID_SPEAKER_PORTAL_COMMAND");
  }
}

async function uploadedArtifactFile(
  formData: FormData,
  contentKind: "HEADSHOT" | "SLIDES",
): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string; readonly originalFilename: string }> {
  const value = formData.get("artifactFile");
  if (typeof File === "undefined" || !(value instanceof File) || value.name.length === 0) {
    throw new Error("SPEAKER_ARTIFACT_FILE_REQUIRED");
  }
  const maximumBytes = contentKind === "HEADSHOT" ? MAX_HEADSHOT_BYTES : MAX_SLIDES_BYTES;
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > maximumBytes) {
    throw new Error("SPEAKER_ARTIFACT_FILE_SIZE_INVALID");
  }
  const expectedMediaType = contentKind === "HEADSHOT" ? "image/png" : "application/pdf";
  if (value.type !== expectedMediaType) throw new Error("SPEAKER_ARTIFACT_MEDIA_TYPE_INVALID");
  const mediaType = value.type;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await value.arrayBuffer());
  } catch {
    throw new Error("SPEAKER_ARTIFACT_FILE_INVALID");
  }
  if (bytes.byteLength !== value.size || bytes.byteLength > maximumBytes) {
    throw new Error("SPEAKER_ARTIFACT_FILE_SIZE_INVALID");
  }
  return { bytes, mediaType, originalFilename: value.name };
}

export async function submitSpeakerContent(formData: FormData): Promise<void> {
  const submittedToken = await token();
  const budgetKey = await lookupBudget("submit");
  const taskId = field(formData, "taskId");
  const contentKind = field(formData, "contentKind", 40);
  const repository = getSyntheticSpeakerOperationsRepository(getDb());
  if (contentKind === "HEADSHOT" || contentKind === "SLIDES") {
    const access = repository.resolvePortalToken(submittedToken, budgetKey);
    const portal = access ? repository.getPortalProjectionForResolvedAccess(submittedToken, access) : null;
    if (!access || !portal) throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    const task = portal.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.contentKind !== contentKind) throw new Error("SPEAKER_ARTIFACT_SCOPE_UNAVAILABLE");
    const file = await uploadedArtifactFile(formData, contentKind);
    let submittedArtifactId: string | null = null;
    try {
      createSpeakerArtifactRecord(
        getDb(),
        {
          workspaceId: portal.access.workspaceId,
          eventId: portal.access.eventId,
          personId: portal.access.personId,
          taskId: task.id,
          kind: contentKind,
        },
        {
          ...file,
          onPrepared: (artifact, registerRollback) => {
            const mutation = repository.submitContentWithRollbackForResolvedAccess(
              submittedToken,
              access,
              task.id,
              {
                kind: contentKind,
                asset: {
                  assetId: artifact.artifactId,
                  fileName: artifact.displayFilename,
                  mediaType: artifact.mediaType,
                  byteSize: artifact.byteSize,
                  checksum: artifact.sha256,
                  storageRef: `synthetic://artifact/${artifact.artifactId}`,
                },
              },
              optionalField(formData, "idempotencyKey", 240) || undefined,
            );
            registerRollback(mutation.rollback);
            const result = mutation.result;
            const payload = result.version.payload;
            if (
              (payload.kind !== "HEADSHOT" && payload.kind !== "SLIDES") ||
              payload.kind !== contentKind ||
              payload.asset.assetId !== artifact.artifactId ||
              payload.asset.checksum !== artifact.sha256 ||
              payload.asset.byteSize !== artifact.byteSize ||
              payload.asset.mediaType !== artifact.mediaType ||
              payload.asset.storageRef !== `synthetic://artifact/${artifact.artifactId}`
            ) {
              throw new Error("SPEAKER_ARTIFACT_SUBMISSION_CONFLICT");
            }
            submittedArtifactId = artifact.artifactId;
          },
        },
      );
    } catch {
      throw new Error("SPEAKER_ARTIFACT_UPLOAD_FAILED");
    }
    if (submittedArtifactId === null) throw new Error("SPEAKER_ARTIFACT_SUBMISSION_FAILED");
  } else {
    repository.submitContent(submittedToken, taskId, payloadFromForm(formData), optionalField(formData, "idempotencyKey", 240) || undefined, budgetKey);
  }
  revalidatePath("/speaker");
}

export async function updateSpeakerProfile(formData: FormData): Promise<void> {
  const submittedToken = await token();
  getSyntheticSpeakerOperationsRepository(getDb()).updateProfile(submittedToken, {
    bio: field(formData, "bio", 12000),
    publicTitle: field(formData, "publicTitle", 240),
    organization: field(formData, "organization", 240),
    socialLinks: JSON.parse(field(formData, "socialLinksJson", 16000)) as readonly { readonly label: string; readonly url: string }[],
    headshot: null,
    idempotencyKey: optionalField(formData, "idempotencyKey", 240) || undefined,
  }, await lookupBudget("profile"));
  revalidatePath("/speaker");
}
