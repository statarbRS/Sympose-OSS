"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { getDb } from "@/server/db";
import {
  assertWorkspaceMatch,
  isDenialError,
  requireCapability,
  resolveSession,
  SESSION_COOKIE,
} from "@/server/auth";
import { getEvent } from "@/server/services/events";
import { sealRelease } from "@/server/services/publication";
import {
  bindPublicationAudienceRelease,
  catalogCurrentPublicationRelease,
  createPublicationAudienceChannel,
  createPublicationAudiencePolicyVersion,
  disablePublicationAudienceBinding,
  disablePublicationAudienceChannel,
  PublicationAudienceServiceError,
  supersedePublicationAudiencePolicy,
  type PublicationAudienceReceiptAction,
} from "@/server/services/publication-audience";

export interface PublicationRouteScope {
  readonly workspaceSlug: string;
  readonly eventId: string;
}

export interface SealPublicationActionState {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly release: {
    readonly releaseId: string;
    readonly fingerprint: string;
    readonly agendaCount: number;
    readonly created: boolean;
  } | null;
}

export type PublicationAudienceCommandIntent =
  | "CREATE_CHANNEL"
  | "CREATE_POLICY"
  | "BIND_RELEASE"
  | "DISABLE_CHANNEL"
  | "SUPERSEDE_POLICY"
  | "DISABLE_BINDING";

export interface PublicationAudienceActionState {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly receipt: {
    readonly id: string;
    readonly action: PublicationAudienceReceiptAction;
    readonly resultState: string;
    readonly replayed: boolean;
  } | null;
}

const IDLE_PUBLICATION_AUDIENCE_ACTION: PublicationAudienceActionState = {
  ok: true,
  code: "IDLE",
  message: "",
  receipt: null,
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const CHANNEL_KEY = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;

function validScope(scope: unknown): scope is PublicationRouteScope {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return false;
  const candidate = scope as Record<string, unknown>;
  return Object.keys(candidate).length === 2 &&
    typeof candidate.workspaceSlug === "string" && SLUG.test(candidate.workspaceSlug) &&
    typeof candidate.eventId === "string" && IDENTIFIER.test(candidate.eventId);
}

function hasOnlyActionFields(formData: unknown): formData is FormData {
  if (!(formData instanceof FormData)) return false;
  return [...formData.keys()].every((key) => key.startsWith("$ACTION_"));
}

function hasOnlyFields(formData: FormData, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return [...formData.keys()].every((key) => key.startsWith("$ACTION_") || allow.has(key));
}

function field(formData: FormData, name: string): string | null {
  const values = formData.getAll(name);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

function positiveInteger(value: string | null): number | null {
  if (!value || !/^[1-9][0-9]{0,15}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function audienceFailure(code: string, message: string): PublicationAudienceActionState {
  return { ok: false, code, message, receipt: null };
}

function safeAudienceFailure(error: unknown): PublicationAudienceActionState {
  if (error instanceof PublicationAudienceServiceError) {
    const denied = error.code === "ACCESS_DENIED" || error.code === "EVENT_NOT_AVAILABLE";
    return audienceFailure(
      denied ? "PUBLICATION_AUDIENCE_DENIED" : error.code,
      denied
        ? "This publication audience action is not available for the current account and event."
        : error.message,
    );
  }
  if (isDenialError(error)) {
    return audienceFailure(
      "PUBLICATION_AUDIENCE_DENIED",
      "This publication audience action is not available for the current account and event.",
    );
  }
  return audienceFailure(
    "PUBLICATION_AUDIENCE_FAILED",
    "The publication audience command could not be saved safely.",
  );
}

function failure(code: string, message: string): SealPublicationActionState {
  return { ok: false, code, message, release: null };
}

function safeSealFailure(error: unknown): SealPublicationActionState {
  if (isDenialError(error)) {
    return failure("PUBLICATION_DENIED", "This publication action is not available for the current account and event.");
  }
  const raw = error instanceof Error ? error.message : "";
  if (raw.startsWith("PLAN_NOT_APPROVED") || raw.startsWith("PLAN_STATE_NOT_CURRENTLY_APPROVED") || raw.startsWith("PLAN_APPROVAL_EVIDENCE_INVALID")) {
    return failure("PLAN_NOT_APPROVED", "The current plan must be approved before a release can be sealed.");
  }
  if (raw.startsWith("NO_PLAN") || raw.startsWith("PLAN_POINTER_STALE")) {
    return failure("SOURCE_PLAN_UNAVAILABLE", "The approved source plan is not available for this event.");
  }
  if (raw.startsWith("NO_ACCEPTED_COMMITMENTS")) {
    return failure("NO_ACCEPTED_COMMITMENTS", "At least one accepted commitment is required before publication.");
  }
  if (raw.startsWith("PUBLICATION_ARTIFACT_NOT_READY") || raw.startsWith("PUBLICATION_ARTIFACT_CARDINALITY_INVALID") || raw.startsWith("PUBLICATION_ARTIFACT_INTEGRITY_INVALID")) {
    return failure("PUBLICATION_ARTIFACT_NOT_READY", "Every required publication artifact must have one current committed byte-verified version with exact publication approval.");
  }
  if (raw.startsWith("SESSION_CONTENT_NOT_APPROVED") || raw.startsWith("SESSION_CONTENT_REQUIREMENTS_INCOMPLETE") || raw.startsWith("SESSION_CONTENT_GATE_INVALID")) {
    return failure("SESSION_CONTENT_NOT_APPROVED", "Every published session title and abstract must use its exact currently approved content version.");
  }
  if (raw.startsWith("SCHEDULE_PLAN_MISMATCH")) {
    return failure("SCHEDULE_PLAN_MISMATCH", "The current schedule is not bound to the approved source plan.");
  }
  if (raw.startsWith("SCHEDULE_NOT_APPROVED") || raw.startsWith("SCHEDULE_APPROVAL_AUTHORITY_MISMATCH")) {
    return failure("SCHEDULE_NOT_APPROVED", "Approve the exact current persisted schedule revision before sealing a release.");
  }
  if (raw.startsWith("SCHEDULE_POINTER_NOT_PERSISTED") || raw.startsWith("SCHEDULE_NOT_DURABLE")) {
    return failure("SCHEDULE_NOT_DURABLE", "Save every exact schedule placement before organizer approval and publication.");
  }
  if (raw.startsWith("SCHEDULE_NOT_READY") || raw.startsWith("SCHEDULE_HAS_CONFLICTS") || raw.startsWith("SCHEDULE_RESOURCE_INVALID")) {
    return failure("SCHEDULE_NOT_READY", "Resolve schedule placement and hard conflicts before sealing the public release.");
  }
  if (raw.startsWith("PUBLICATION_SEAL_AUTHORITY_INVALID")) {
    return failure("PUBLICATION_DENIED", "This publication action is not available for the current account and event.");
  }
  return failure("PUBLICATION_FAILED", "The durable publication release could not be sealed.");
}

/**
 * Seals the event's server-selected current approved plan. The route scope is bound by the
 * organizer page, then checked against the authenticated session and event row again here.
 * No posted workspace, plan, release, or approval value is treated as authority.
 */
export async function sealPublicationReleaseAction(
  scope: PublicationRouteScope,
  _previousState: SealPublicationActionState,
  formData: FormData,
): Promise<SealPublicationActionState> {
  if (!validScope(scope) || !hasOnlyActionFields(formData)) {
    return failure("INVALID_INPUT", "The publication request is invalid.");
  }

  try {
    const db = getDb();
    const cookieStore = await cookies();
    const session = resolveSession(db, cookieStore.get(SESSION_COOKIE)?.value);
    if (!session) return failure("SESSION_REQUIRED", "Sign in with an organizer account before sealing a publication release.");
    try {
      assertWorkspaceMatch(session, scope.workspaceSlug);
    } catch {
      return failure("PUBLICATION_DENIED", "This publication action is not available for the current account and event.");
    }
    const event = getEvent(db, session.workspaceId, scope.eventId);
    if (!event) return failure("PUBLICATION_NOT_FOUND", "The publication release is not available for this event.");
    requireCapability(db, session, "phase0.pipeline.manage");
    const result = sealRelease(db, session.workspaceId, event.id, { kind: "account", ref: session.accountId });
    try {
      // The additive audience catalog follows the established seal. A catalog failure never
      // rewrites or rolls back the event's public pointer and therefore cannot gate public reads.
      catalogCurrentPublicationRelease(db, session, { eventId: event.id });
    } catch {
      // The existing public release remains authoritative; the matrix will truthfully show the
      // uncataloged release as unavailable until an organizer retries the seal or binding flow.
    }
    try {
      // Cache refresh is downstream of the committed immutable release. A refresh failure must
      // never erase the truthful execution receipt or invite a second authority decision.
      revalidatePath(`/w/${encodeURIComponent(scope.workspaceSlug)}/events/${encodeURIComponent(event.id)}/publication`);
    } catch {
      // The returned receipt remains authoritative; the next navigation performs a fresh read.
    }
    return {
      ok: true,
      code: result.created ? "PUBLICATION_RELEASE_SEALED" : "PUBLICATION_RELEASE_REPLAYED",
      message: result.created
        ? "The approved plan was sealed as the event's durable current release."
        : "That approved plan already has the same durable sealed release; no duplicate release or token was created.",
      release: {
        releaseId: result.releaseId,
        fingerprint: result.fingerprint,
        agendaCount: result.agendaCount,
        created: result.created,
      },
    };
  } catch (error) {
    return safeSealFailure(error);
  }
}

/**
 * One bounded organizer command boundary for the additive Version-to-Audience Matrix. Route
 * workspace/event scope is server-bound; posted data can select only an operation and its exact
 * immutable evidence, never a tenant or public pointer.
 */
export async function publicationAudienceCommandAction(
  scope: PublicationRouteScope,
  _previousState: PublicationAudienceActionState,
  formData: FormData,
): Promise<PublicationAudienceActionState> {
  if (!validScope(scope) || !(formData instanceof FormData)) {
    return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
  }
  const intent = field(formData, "intent") as PublicationAudienceCommandIntent | null;
  if (!intent || ![
    "CREATE_CHANNEL",
    "CREATE_POLICY",
    "BIND_RELEASE",
    "DISABLE_CHANNEL",
    "SUPERSEDE_POLICY",
    "DISABLE_BINDING",
  ].includes(intent)) {
    return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
  }

  try {
    const db = getDb();
    const cookieStore = await cookies();
    const session = resolveSession(db, cookieStore.get(SESSION_COOKIE)?.value);
    if (!session) {
      return audienceFailure("SESSION_REQUIRED", "Sign in with an organizer account before changing audience authority.");
    }
    try {
      assertWorkspaceMatch(session, scope.workspaceSlug);
    } catch {
      return audienceFailure(
        "PUBLICATION_AUDIENCE_DENIED",
        "This publication audience action is not available for the current account and event.",
      );
    }
    const event = getEvent(db, session.workspaceId, scope.eventId);
    if (!event) {
      return audienceFailure(
        "PUBLICATION_AUDIENCE_DENIED",
        "This publication audience action is not available for the current account and event.",
      );
    }
    requireCapability(db, session, "phase0.pipeline.manage");
    const idempotencyKey = field(formData, "idempotencyKey");
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
    }

    let receipt;
    if (intent === "CREATE_CHANNEL") {
      if (!hasOnlyFields(formData, ["intent", "idempotencyKey", "key", "label", "purpose", "audience", "visibility"])) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      const key = field(formData, "key");
      const label = field(formData, "label");
      const purpose = field(formData, "purpose");
      const audience = field(formData, "audience");
      const visibility = field(formData, "visibility");
      if (!key || !CHANNEL_KEY.test(key) || !label || label !== label.trim() ||
          !purpose || !["EVENT_AGENDA", "PERSONAL_AGENDA", "SPEAKER_PORTAL", "EMBED"].includes(purpose) ||
          !audience || !["PUBLIC", "ATTENDEE", "SPEAKER", "ORGANIZER"].includes(audience) ||
          !visibility || !["PUBLIC", "TOKEN", "AUTHENTICATED"].includes(visibility)) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      receipt = createPublicationAudienceChannel(db, session, {
        eventId: event.id,
        key,
        label,
        purpose: purpose as "EVENT_AGENDA" | "PERSONAL_AGENDA" | "SPEAKER_PORTAL" | "EMBED",
        audience: audience as "PUBLIC" | "ATTENDEE" | "SPEAKER" | "ORGANIZER",
        visibility: visibility as "PUBLIC" | "TOKEN" | "AUTHENTICATED",
        idempotencyKey,
      }).receipt;
    } else if (intent === "CREATE_POLICY") {
      if (!hasOnlyFields(formData, ["intent", "idempotencyKey", "channelId", "rule"])) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      const channelId = field(formData, "channelId");
      const rule = field(formData, "rule");
      if (!channelId || !IDENTIFIER.test(channelId) || !rule ||
          !["PUBLIC_SCHEDULE", "ACCEPTED_AGENDAS", "SPEAKER_PORTAL"].includes(rule)) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      receipt = createPublicationAudiencePolicyVersion(db, session, {
        eventId: event.id,
        channelId,
        rule: rule as "PUBLIC_SCHEDULE" | "ACCEPTED_AGENDAS" | "SPEAKER_PORTAL",
        idempotencyKey,
      }).receipt;
    } else if (intent === "BIND_RELEASE") {
      if (!hasOnlyFields(formData, ["intent", "idempotencyKey", "channelId", "policyVersionId",
        "expectedReleaseId", "expectedReleaseVersion", "expectedReleaseFingerprint"])) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      const channelId = field(formData, "channelId");
      const policyVersionId = field(formData, "policyVersionId");
      const expectedReleaseId = field(formData, "expectedReleaseId");
      const expectedReleaseVersion = positiveInteger(field(formData, "expectedReleaseVersion"));
      const expectedReleaseFingerprint = field(formData, "expectedReleaseFingerprint");
      if (!channelId || !IDENTIFIER.test(channelId) || !policyVersionId || !IDENTIFIER.test(policyVersionId) ||
          !expectedReleaseId || !IDENTIFIER.test(expectedReleaseId) || !expectedReleaseVersion ||
          !expectedReleaseFingerprint || !FINGERPRINT.test(expectedReleaseFingerprint)) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      receipt = bindPublicationAudienceRelease(db, session, {
        eventId: event.id,
        channelId,
        policyVersionId,
        expectedReleaseId,
        expectedReleaseVersion,
        expectedReleaseFingerprint,
        idempotencyKey,
      });
    } else if (intent === "DISABLE_CHANNEL") {
      if (!hasOnlyFields(formData, ["intent", "idempotencyKey", "channelId", "expectedChannelFingerprint"])) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      const channelId = field(formData, "channelId");
      const expectedChannelFingerprint = field(formData, "expectedChannelFingerprint");
      if (!channelId || !IDENTIFIER.test(channelId) || !expectedChannelFingerprint ||
          !FINGERPRINT.test(expectedChannelFingerprint)) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      receipt = disablePublicationAudienceChannel(db, session, {
        eventId: event.id,
        channelId,
        expectedChannelFingerprint,
        idempotencyKey,
      });
    } else if (intent === "SUPERSEDE_POLICY") {
      if (!hasOnlyFields(formData, ["intent", "idempotencyKey", "channelId", "policyVersionId",
        "expectedPolicyFingerprint", "successorPolicyVersionId", "expectedSuccessorPolicyFingerprint"])) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      const channelId = field(formData, "channelId");
      const policyVersionId = field(formData, "policyVersionId");
      const expectedPolicyFingerprint = field(formData, "expectedPolicyFingerprint");
      const successorPolicyVersionId = field(formData, "successorPolicyVersionId");
      const expectedSuccessorPolicyFingerprint = field(formData, "expectedSuccessorPolicyFingerprint");
      if (![channelId, policyVersionId, successorPolicyVersionId].every((value) => value && IDENTIFIER.test(value)) ||
          !expectedPolicyFingerprint || !FINGERPRINT.test(expectedPolicyFingerprint) ||
          !expectedSuccessorPolicyFingerprint || !FINGERPRINT.test(expectedSuccessorPolicyFingerprint)) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      receipt = supersedePublicationAudiencePolicy(db, session, {
        eventId: event.id,
        channelId: channelId!,
        policyVersionId: policyVersionId!,
        expectedPolicyFingerprint,
        successorPolicyVersionId: successorPolicyVersionId!,
        expectedSuccessorPolicyFingerprint,
        idempotencyKey,
      });
    } else {
      if (!hasOnlyFields(formData, ["intent", "idempotencyKey", "channelId", "bindingReceiptId",
        "expectedReleaseId", "expectedReleaseVersion", "expectedReleaseFingerprint"])) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      const channelId = field(formData, "channelId");
      const bindingReceiptId = field(formData, "bindingReceiptId");
      const expectedReleaseId = field(formData, "expectedReleaseId");
      const expectedReleaseVersion = positiveInteger(field(formData, "expectedReleaseVersion"));
      const expectedReleaseFingerprint = field(formData, "expectedReleaseFingerprint");
      if (![channelId, bindingReceiptId, expectedReleaseId].every((value) => value && IDENTIFIER.test(value)) ||
          !expectedReleaseVersion || !expectedReleaseFingerprint || !FINGERPRINT.test(expectedReleaseFingerprint)) {
        return audienceFailure("INVALID_INPUT", "The publication audience request is invalid.");
      }
      receipt = disablePublicationAudienceBinding(db, session, {
        eventId: event.id,
        channelId: channelId!,
        bindingReceiptId: bindingReceiptId!,
        expectedReleaseId: expectedReleaseId!,
        expectedReleaseVersion,
        expectedReleaseFingerprint,
        idempotencyKey,
      });
    }

    try {
      revalidatePath(`/w/${encodeURIComponent(scope.workspaceSlug)}/events/${encodeURIComponent(event.id)}/publication`);
    } catch {
      // The append-only audience receipt is already durable. Preserve its truthful result even
      // when the downstream cache refresh is temporarily unavailable.
    }
    return {
      ok: true,
      code: receipt.replayed ? `${receipt.action}_REPLAYED` : receipt.action,
      message: receipt.replayed
        ? "The identical audience command was already recorded; no duplicate authority was created."
        : "The append-only publication audience receipt was recorded.",
      receipt: {
        id: receipt.id,
        action: receipt.action,
        resultState: receipt.resultState,
        replayed: receipt.replayed,
      },
    };
  } catch (error) {
    return safeAudienceFailure(error);
  }
}

/** Progressive-enhancement form adapter; the typed command result remains available to tests and
 * richer clients, while the Server Component form relies on route revalidation after success. */
export async function publicationAudienceFormAction(
  scope: PublicationRouteScope,
  formData: FormData,
): Promise<void> {
  await publicationAudienceCommandAction(scope, IDLE_PUBLICATION_AUDIENCE_ACTION, formData);
}
