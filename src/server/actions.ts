"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "./db";
import {
  assertWorkspaceMatch,
  DenialError,
  describeDenial,
  isDenialError,
  requireCapability,
  roleHasCapability,
  resolveSession,
  revokeSession,
  rotateSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  type SessionInfo,
} from "./auth";
import { importFixtureEvidence } from "./services/sources";
import { freezeCohortSnapshot } from "./services/cohorts";
import { createEventWithUnit } from "./services/events";
import { approvePlan, compilePlan } from "./services/planning";
import { deliverOffers, respondToOfferCommand } from "./services/commitments";
import { revokePortalToken, sealRelease } from "./services/publication";
import { recordAttendance } from "./services/outcomes";
import { getDashboardState } from "./services/queries";
import { writeDenialAudit } from "./services/audit";
import {
  EVALUATOR_ORGANIZER_LOGIN_ALLOWLIST,
  EVALUATOR_REVIEWER_LOGIN_ALLOWLIST,
} from "./evaluator-login-accounts";
import {
  EVALUATOR_DEVFLOW_REVIEWER_CONTRACT,
  isPinnedDevflowReviewerAccount,
} from "./evaluator-reviewer-contract";
import { requirePinnedReviewerActivation } from "./services/cfp-review/reviewer-provisioning";
import { requireRuntimeDataMode } from "./runtime-mode";

export interface ActionResult {
  ok: boolean;
  code?: string;
  message: string;
  denial?: { code: string; message: string; target: string };
  portalLinks?: { personName: string; href: string }[];
}

function redirectToDashboard(session: SessionInfo): never {
  redirect(`/w/${session.workspaceSlug}/dashboard`);
}

type ActionState = ActionResult | null;

type ActionFailureCode =
  | "LOGIN_FAILED"
  | "REVIEWER_LOGIN_FAILED"
  | "SIGN_OUT_FAILED"
  | "CACHE_INVALIDATION_FAILED"
  | "IMPORT_FAILED"
  | "SNAPSHOT_FAILED"
  | "EVENT_FAILED"
  | "COMPILE_FAILED"
  | "APPROVE_FAILED"
  | "DELIVERY_FAILED"
  | "RESPONSE_FAILED"
  | "SEAL_FAILED"
  | "REVOKE_FAILED"
  | "OBSERVATION_FAILED"
  | "DENIAL_PROOF_FAILED";

const ACTION_FAILURE_MESSAGES: Record<ActionFailureCode, string> = {
  LOGIN_FAILED: "Sign-in could not be completed. Try again or contact an organizer.",
  REVIEWER_LOGIN_FAILED: "Reviewer sign-in could not be completed. Try again from the evaluator entry page.",
  SIGN_OUT_FAILED: "Sign-out could not be completed. Try again or contact an organizer.",
  CACHE_INVALIDATION_FAILED: "The change was committed, but the page could not be refreshed. Reload to continue.",
  IMPORT_FAILED: "Import could not be completed. Try again or contact an organizer.",
  SNAPSHOT_FAILED: "Snapshot could not be frozen. Try again or contact an organizer.",
  EVENT_FAILED: "Event operation could not be completed. Try again or contact an organizer.",
  COMPILE_FAILED: "Plan compilation could not be completed. Try again or contact an organizer.",
  APPROVE_FAILED: "Plan approval could not be completed. Try again or contact an organizer.",
  DELIVERY_FAILED: "Offer delivery could not be completed. Try again or contact an organizer.",
  RESPONSE_FAILED: "Offer response could not be recorded. Try again or contact an organizer.",
  SEAL_FAILED: "Release could not be sealed. Try again or contact an organizer.",
  REVOKE_FAILED: "Token revocation could not be completed. Try again or contact an organizer.",
  OBSERVATION_FAILED: "Attendance could not be recorded. Try again or contact an organizer.",
  DENIAL_PROOF_FAILED: "Denial proof could not be completed. Try again or contact an organizer.",
};

function actionFailure(code: ActionFailureCode): ActionResult {
  return { ok: false, code, message: ACTION_FAILURE_MESSAGES[code] };
}

function revalidateActionPaths(paths: string[]): ActionResult | null {
  try {
    for (const path of paths) {
      revalidatePath(path);
    }
    return null;
  } catch {
    return actionFailure("CACHE_INVALIDATION_FAILED");
  }
}

async function requireSession(): Promise<SessionInfo> {
  const store = await cookies();
  const db = getDb();
  const session = resolveSession(db, store.get(SESSION_COOKIE)?.value);
  if (!session) {
    throw new DenialError("SESSION_REQUIRED", "Sign in to continue.", "session");
  }
  requireCapability(db, session, "phase0.pipeline.manage");
  return session;
}

function actorFor(session: SessionInfo) {
  return { kind: "account" as const, ref: session.accountId };
}

type StoredLoginAccount = Readonly<{
  id: string;
  workspaceId: string;
  role: string;
  email: string;
}>;

function matchesAllowlistedLoginAccount(
  account: StoredLoginAccount,
  expected: StoredLoginAccount,
): boolean {
  return (
    account.id === expected.id &&
    account.workspaceId === expected.workspaceId &&
    account.role === expected.role &&
    account.email === expected.email
  );
}

export async function loginAction(
  _state: ActionState,
  formData: FormData,
): Promise<never | ActionResult> {
  if (requireRuntimeDataMode() !== "synthetic-evaluator") {
    return { ok: false, code: "LOGIN_ACCOUNT_UNAVAILABLE", message: "That sign-in method is unavailable." };
  }
  const accountId = z.string().min(1).max(128).safeParse(formData.get("accountId"));
  if (!accountId.success) {
    return { ok: false, code: "BAD_ACCOUNT", message: "Choose a workspace account to continue." };
  }
  let token: string;
  let session: SessionInfo;
  try {
    const store = await cookies();
    const previousToken = store.get(SESSION_COOKIE)?.value;
    const db = getDb();
    const account = db
      .prepare(
        "SELECT id, workspace_id AS workspaceId, role, email FROM accounts WHERE id = ?",
      )
      .get(accountId.data) as StoredLoginAccount | undefined;
    const expectedAccount = EVALUATOR_ORGANIZER_LOGIN_ALLOWLIST.find(
      (candidate) => candidate.accountId === accountId.data,
    );
    if (
      !account ||
      !expectedAccount ||
      !matchesAllowlistedLoginAccount(account, {
        id: expectedAccount.accountId,
        workspaceId: expectedAccount.workspaceId,
        role: expectedAccount.role,
        email: expectedAccount.email,
      }) ||
      !roleHasCapability(account.role, "phase0.pipeline.manage")
    ) {
      return {
        ok: false,
        code: "LOGIN_ACCOUNT_UNAVAILABLE",
        message: "That account is not available for organizer sign-in.",
      };
    }
    ({ token, session } = rotateSession(db, previousToken, account.id, account.workspaceId));
    try {
      store.set(SESSION_COOKIE, token, sessionCookieOptions());
    } catch {
      try {
        revokeSession(db, token);
      } catch {
        // Cookie failure cleanup is best effort; the session remains short-lived if it fails.
      }
      return actionFailure("LOGIN_FAILED");
    }
  } catch {
    return actionFailure("LOGIN_FAILED");
  }
  redirectToDashboard(session);
}

export async function loginReviewerAction(
  _state: ActionState,
  formData: FormData,
): Promise<never | ActionResult> {
  if (requireRuntimeDataMode() !== "synthetic-evaluator") {
    return { ok: false, code: "REVIEWER_ACCOUNT_UNAVAILABLE", message: "That sign-in method is unavailable." };
  }
  const accountId = z.string().min(1).max(128).safeParse(formData.get("accountId"));
  if (!accountId.success) {
    return { ok: false, code: "BAD_REVIEWER_ACCOUNT", message: "Choose the synthetic reviewer entry to continue." };
  }
  let token: string;
  let session: SessionInfo;
  try {
    const store = await cookies();
    const previousToken = store.get(SESSION_COOKIE)?.value;
    const db = getDb();
    const account = db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, role, email
         FROM accounts WHERE id = ?`,
      )
      .get(accountId.data) as StoredLoginAccount | undefined;
    const expectedAccount = EVALUATOR_REVIEWER_LOGIN_ALLOWLIST.find(
      (candidate) => candidate.accountId === accountId.data,
    );
    if (
      !account ||
      !expectedAccount ||
      !matchesAllowlistedLoginAccount(account, {
        id: expectedAccount.accountId,
        workspaceId: expectedAccount.workspaceId,
        role: expectedAccount.role,
        email: expectedAccount.email,
      }) ||
      !roleHasCapability(account.role, "cfp.review") ||
      account.role !== "reviewer"
    ) {
      return {
        ok: false,
        code: "REVIEWER_ACCOUNT_UNAVAILABLE",
        message: "That synthetic reviewer account is not available.",
      };
    }
    if (
      isPinnedDevflowReviewerAccount({
        accountId: account.id,
        workspaceId: account.workspaceId,
        role: account.role as "reviewer",
        email: account.email,
      })
    ) {
      try {
        requirePinnedReviewerActivation(db);
      } catch {
        return {
          ok: false,
          code: "REVIEWER_ACTIVATION_REQUIRED",
          message: "That synthetic reviewer has not been activated by the organizer.",
        };
      }
    }
    ({ token, session } = rotateSession(db, previousToken, account.id, account.workspaceId));
    try {
      store.set(SESSION_COOKIE, token, sessionCookieOptions());
    } catch {
      try {
        revokeSession(db, token);
      } catch {
        // Cookie failure cleanup is best effort; the session remains short-lived if it fails.
      }
      return actionFailure("REVIEWER_LOGIN_FAILED");
    }
  } catch {
    return actionFailure("REVIEWER_LOGIN_FAILED");
  }
  redirect(`/review/${session.workspaceSlug}/queue`);
}

/**
 * The organizer-facing evaluator handoff has no target fields. Both the current organizer and
 * the destination reviewer are resolved from repository-owned tuples and a durable ACTIVE state.
 */
export async function enterPinnedReviewerSessionAction(
  _state: ActionState,
  formData: FormData,
): Promise<never | ActionResult> {
  if (requireRuntimeDataMode() !== "synthetic-evaluator") {
    return { ok: false, code: "REVIEWER_TRANSITION_UNAVAILABLE", message: "That session transition is unavailable." };
  }
  if ([...formData.keys()].length !== 0) {
    return {
      ok: false,
      code: "BAD_REVIEWER_TRANSITION",
      message: "The reviewer persona transition request is invalid.",
    };
  }
  const store = await cookies();
  const previousToken = store.get(SESSION_COOKIE)?.value;
  const db = getDb();
  const organizer = resolveSession(db, previousToken);
  const expectedOrganizer = EVALUATOR_ORGANIZER_LOGIN_ALLOWLIST.find(
    (candidate) =>
      candidate.accountId === EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.organizerAccountId &&
      candidate.workspaceId === EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId &&
      candidate.role === "organizer",
  );
  if (
    !organizer ||
    !expectedOrganizer ||
    organizer.accountId !== expectedOrganizer.accountId ||
    organizer.workspaceId !== expectedOrganizer.workspaceId ||
    organizer.workspaceSlug !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceSlug ||
    organizer.role !== expectedOrganizer.role ||
    organizer.email !== expectedOrganizer.email ||
    !roleHasCapability(organizer.role, "phase0.pipeline.manage")
  ) {
    return {
      ok: false,
      code: "REVIEWER_TRANSITION_UNAVAILABLE",
      message: "The reviewer persona transition is unavailable for this session.",
    };
  }
  try {
    requirePinnedReviewerActivation(db);
  } catch {
    return {
      ok: false,
      code: "REVIEWER_ACTIVATION_REQUIRED",
      message: "Sam must be activated before entering the reviewer assignment.",
    };
  }

  let token: string;
  let session: SessionInfo;
  try {
    ({ token, session } = rotateSession(
      db,
      previousToken,
      EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.reviewer.accountId,
      EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId,
    ));
    if (
      session.role !== "reviewer" ||
      !isPinnedDevflowReviewerAccount({
        accountId: session.accountId,
        workspaceId: session.workspaceId,
        role: session.role,
        email: session.email,
      })
    ) {
      revokeSession(db, token);
      return actionFailure("REVIEWER_LOGIN_FAILED");
    }
    try {
      store.set(SESSION_COOKIE, token, sessionCookieOptions());
    } catch {
      try {
        revokeSession(db, token);
      } catch {
        // The server session is unusable without a successfully set cookie.
      }
      return actionFailure("REVIEWER_LOGIN_FAILED");
    }
  } catch {
    return actionFailure("REVIEWER_LOGIN_FAILED");
  }
  redirect(`/review/${EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceSlug}/queue`);
}

export async function signOutAction(_state: ActionState, formData: FormData): Promise<never | ActionResult> {
  try {
    const store = await cookies();
    revokeSession(getDb(), store.get(SESSION_COOKIE)?.value);
    store.delete(SESSION_COOKIE);
  } catch {
    return actionFailure("SIGN_OUT_FAILED");
  }
  redirect("/");
}

export async function importFixtureAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let result!: ReturnType<typeof importFixtureEvidence>;
  try {
    session = await requireSession();
    result = importFixtureEvidence(getDb(), session.workspaceId, session.workspaceSlug);
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("IMPORT_FAILED");
  }
  const cacheFailure = revalidateActionPaths([`/w/${session.workspaceSlug}/dashboard`]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: `Imported ${result.imported.length} evidence rows (${result.skipped} already present), resolved ${result.personsCreated} canonical people.`,
  };
}

export async function freezeSnapshotAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let result!: ReturnType<typeof freezeCohortSnapshot>;
  try {
    session = await requireSession();
    result = freezeCohortSnapshot(getDb(), session.workspaceId, actorFor(session));
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("SNAPSHOT_FAILED");
  }
  const cacheFailure = revalidateActionPaths([`/w/${session.workspaceSlug}/dashboard`]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: result.created
      ? `Frozen cohort snapshot ${result.fingerprint.slice(0, 12)}… with ${result.memberCount} members.`
      : `Cohort snapshot already frozen (${result.fingerprint.slice(0, 12)}…, ${result.memberCount} members); nothing changed.`,
  };
}

const createEventSchema = z.object({
  eventName: z.string().trim().min(2).max(80),
  unitName: z.string().trim().min(2).max(80),
  capacity: z.coerce.number().int().min(1).max(99),
});

export async function createEventAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let result!: ReturnType<typeof createEventWithUnit>;
  let parsedEvent!: z.infer<typeof createEventSchema>;
  const returnToPortfolio = formData.get("returnToPortfolio") === "true";
  try {
    session = await requireSession();
    const parsed = createEventSchema.safeParse({
      eventName: formData.get("eventName"),
      unitName: formData.get("unitName"),
      capacity: formData.get("capacity"),
    });
    if (!parsed.success) {
      return { ok: false, code: "BAD_EVENT", message: "Event and program-unit names are required (2–80 chars), capacity 1–99." };
    }
    parsedEvent = parsed.data;
    result = createEventWithUnit(getDb(), session.workspaceId, actorFor(session), {
      eventName: parsedEvent.eventName,
      unitName: parsedEvent.unitName,
      capacity: parsedEvent.capacity,
    });
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("EVENT_FAILED");
  }
  const cacheFailure = revalidateActionPaths([
    `/w/${session.workspaceSlug}/dashboard`,
    `/w/${session.workspaceSlug}/events`,
    `/w/${session.workspaceSlug}/events/${result.eventId}/plan`,
  ]);
  if (cacheFailure) return cacheFailure;
  if (returnToPortfolio) {
    redirect(`/w/${session.workspaceSlug}/events`);
  }
  const message = result.eventCreated
    ? `Created event "${parsedEvent.eventName}" with program unit "${parsedEvent.unitName}".`
    : result.programUnitCreated
      ? `Event "${parsedEvent.eventName}" already exists; created program unit "${parsedEvent.unitName}".`
      : `Event "${parsedEvent.eventName}" and program unit "${parsedEvent.unitName}" already exist; nothing changed.`;
  return { ok: true, message };
}

export async function compilePlanAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let event!: NonNullable<ReturnType<typeof getDashboardState>["event"]["event"]>;
  let result!: ReturnType<typeof compilePlan>;
  try {
    session = await requireSession();
    const dashboard = getDashboardState(getDb(), session.workspaceId, []);
    event = dashboard.event.event!;
    if (!event) {
      return { ok: false, code: "NO_EVENT", message: "Create the event first." };
    }
    result = compilePlan(getDb(), session.workspaceId, event.id, actorFor(session));
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("COMPILE_FAILED");
  }
  const cacheFailure = revalidateActionPaths([
    `/w/${session.workspaceSlug}/dashboard`,
    `/w/${session.workspaceSlug}/events/${event.id}/plan`,
  ]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: result.created
      ? `Compiled candidate plan v${result.versionNumber} (${result.assignmentCount} assignments, fingerprint ${result.fingerprint.slice(0, 12)}…).`
      : `Candidate plan v${result.versionNumber} already exists (fingerprint ${result.fingerprint.slice(0, 12)}…).`,
  };
}

export async function approvePlanAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let event!: NonNullable<ReturnType<typeof getDashboardState>["event"]["event"]>;
  let result!: ReturnType<typeof approvePlan>;
  try {
    session = await requireSession();
    const planVersionId = z.string().min(1).safeParse(formData.get("planVersionId"));
    if (!planVersionId.success) {
      return { ok: false, code: "BAD_PLAN", message: "No plan version supplied." };
    }
    const expectedCurrent = formData.get("expectedCurrentPlanVersionId");
    if (typeof expectedCurrent !== "string") {
      return { ok: false, code: "BAD_PLAN_POINTER", message: "No expected current plan supplied." };
    }
    const dashboard = getDashboardState(getDb(), session.workspaceId, []);
    event = dashboard.event.event!;
    if (!event) {
      return { ok: false, code: "NO_EVENT", message: "Create the event first." };
    }
    result = approvePlan(
      getDb(),
      session.workspaceId,
      event.id,
      planVersionId.data,
      expectedCurrent === "" ? null : expectedCurrent,
      actorFor(session),
    );
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("APPROVE_FAILED");
  }
  const cacheFailure = revalidateActionPaths([
    `/w/${session.workspaceSlug}/dashboard`,
    `/w/${session.workspaceSlug}/events/${event.id}/plan`,
  ]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: result.created
      ? "Plan approved. Decision truth recorded; plan content is unchanged."
      : "This plan version was already approved; nothing changed.",
  };
}

export async function deliverOffersAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let event!: NonNullable<ReturnType<typeof getDashboardState>["event"]["event"]>;
  let result!: ReturnType<typeof deliverOffers>;
  try {
    session = await requireSession();
    const dashboard = getDashboardState(getDb(), session.workspaceId, []);
    event = dashboard.event.event!;
    if (!event) {
      return { ok: false, code: "NO_EVENT", message: "Create the event first." };
    }
    result = deliverOffers(getDb(), session.workspaceId, event.id, actorFor(session));
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("DELIVERY_FAILED");
  }
  const cacheFailure = revalidateActionPaths([`/w/${session.workspaceSlug}/dashboard`]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: `Delivered ${result.offersCreated} exact offer envelopes (${result.offersAlreadyPresent} already delivered).`,
  };
}

const commitmentCommandSchema = z.object({
  offerId: z.string().uuid(),
  commandKey: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function simulateAcceptanceAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let event!: NonNullable<ReturnType<typeof getDashboardState>["event"]["event"]>;
  let result!: ReturnType<typeof respondToOfferCommand>;
  try {
    session = await requireSession();
    const command = commitmentCommandSchema.safeParse({
      offerId: formData.get("offerId"),
      commandKey: formData.get("commandKey"),
    });
    if (!command.success) {
      return { ok: false, code: "BAD_RESPONSE_COMMAND", message: "Choose the exact offer to accept." };
    }
    const dashboard = getDashboardState(getDb(), session.workspaceId, []);
    event = dashboard.event.event!;
    if (!event) {
      return { ok: false, code: "NO_EVENT", message: "Create the event first." };
    }
    result = respondToOfferCommand(
      getDb(),
      session.workspaceId,
      event.id,
      { ...command.data, response: "accepted" },
    );
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("RESPONSE_FAILED");
  }
  const cacheFailure = revalidateActionPaths([`/w/${session.workspaceSlug}/dashboard`]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: result.created
      ? `Person accepted the exact offer (terms ${result.termsFingerprint.slice(0, 12)}…). Commitment truth recorded separately from the plan.`
      : `That exact offer was already ${result.response}; no other offer was touched.`,
  };
}

export async function simulateDeclineAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let event!: NonNullable<ReturnType<typeof getDashboardState>["event"]["event"]>;
  let result!: ReturnType<typeof respondToOfferCommand>;
  try {
    session = await requireSession();
    const command = commitmentCommandSchema.safeParse({
      offerId: formData.get("offerId"),
      commandKey: formData.get("commandKey"),
    });
    if (!command.success) {
      return { ok: false, code: "BAD_RESPONSE_COMMAND", message: "Choose the exact offer to decline." };
    }
    const dashboard = getDashboardState(getDb(), session.workspaceId, []);
    event = dashboard.event.event!;
    if (!event) {
      return { ok: false, code: "NO_EVENT", message: "Create the event first." };
    }
    result = respondToOfferCommand(
      getDb(),
      session.workspaceId,
      event.id,
      { ...command.data, response: "declined" },
    );
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("RESPONSE_FAILED");
  }
  const cacheFailure = revalidateActionPaths([`/w/${session.workspaceSlug}/dashboard`]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: result.created
      ? `Person declined the offer. The declined assignment remains untouched in the plan (decision truth is not rewritten).`
      : `That exact offer was already ${result.response}; no other offer was touched.`,
  };
}

export async function sealReleaseAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let event!: NonNullable<ReturnType<typeof getDashboardState>["event"]["event"]>;
  let result!: ReturnType<typeof sealRelease>;
  try {
    session = await requireSession();
    const dashboard = getDashboardState(getDb(), session.workspaceId, []);
    event = dashboard.event.event!;
    if (!event) {
      return { ok: false, code: "NO_EVENT", message: "Create the event first." };
    }
    result = sealRelease(getDb(), session.workspaceId, event.id, actorFor(session));
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("SEAL_FAILED");
  }
  const cacheFailure = revalidateActionPaths([`/w/${session.workspaceSlug}/dashboard`]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: result.created
      ? `Sealed release ${result.fingerprint.slice(0, 12)}… with ${result.agendaCount} personal agendas and ${result.tokenCount} portal tokens. Only token hashes are stored; the raw links below are shown once.`
      : `Release ${result.fingerprint.slice(0, 12)}… was already sealed; nothing changed.`,
    portalLinks: result.tokens.map((t) => ({
      personName: t.personName,
      href: `/p/${t.rawToken}`,
    })),
  };
}

export async function revokeTokenAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let revoked!: ReturnType<typeof revokePortalToken>;
  try {
    session = await requireSession();
    const tokenId = z.string().min(1).safeParse(formData.get("tokenId"));
    const reason = z.string().trim().min(2).max(120).safeParse(formData.get("reason") ?? "Organizer revocation");
    if (!tokenId.success) {
      return { ok: false, code: "BAD_TOKEN", message: "No portal token supplied." };
    }
    revoked = revokePortalToken(
      getDb(),
      session.workspaceId,
      tokenId.data,
      actorFor(session),
      reason.success ? reason.data : "Organizer revocation",
    );
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("REVOKE_FAILED");
  }
  const cacheFailure = revalidateActionPaths([`/w/${session.workspaceSlug}/dashboard`]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: revoked
      ? "Portal access revoked. The sealed release itself is unchanged."
      : "Portal access was already revoked; the release and prior revocation record are unchanged.",
  };
}

export async function recordAttendanceAction(_state: ActionState, formData: FormData): Promise<ActionResult> {
  let session!: SessionInfo;
  let result!: ReturnType<typeof recordAttendance>;
  try {
    session = await requireSession();
    const personId = z.string().min(1).safeParse(formData.get("personId"));
    const eventId = z.string().min(1).safeParse(formData.get("eventId"));
    const programUnitId = z.string().min(1).safeParse(formData.get("programUnitId"));
    const observedAt = z.string().min(1).max(40).safeParse(formData.get("observedAt"));
    if (!personId.success || !eventId.success || !programUnitId.success || !observedAt.success) {
      return { ok: false, code: "BAD_OBSERVATION", message: "Missing observation inputs." };
    }
    const dashboard = getDashboardState(getDb(), session.workspaceId, []);
    const currentEvent = dashboard.event.event;
    if (!currentEvent) {
      return { ok: false, code: "NO_EVENT", message: "Create the event first." };
    }
    if (currentEvent.id !== eventId.data) {
      return { ok: false, code: "EVENT_MISMATCH", message: "Choose the current workspace event." };
    }
    const idempotencyKey = `attendance:${eventId.data}:${personId.data}:${programUnitId.data}`;
    result = recordAttendance(
      getDb(),
      session.workspaceId,
      eventId.data,
      personId.data,
      programUnitId.data,
      observedAt.data,
      idempotencyKey,
      actorFor(session),
    );
  } catch (error) {
    if (isDenialError(error)) {
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("OBSERVATION_FAILED");
  }
  const cacheFailure = revalidateActionPaths([`/w/${session.workspaceSlug}/dashboard`]);
  if (cacheFailure) return cacheFailure;
  return {
    ok: true,
    message: result.created
      ? "Attendance recorded as operational truth (observation idempotency key retained)."
      : "Attendance for this person/unit was already recorded; duplicate submission was ignored (idempotent).",
  };
}

/**
 * Deterministic cross-workspace denial proof. The UI offers a button that tries to reach the
 * other seeded workspace; the server always refuses because the session workspace is the only
 * authority. This is the same denial path any forged client-side workspace identifier hits.
 */
export async function proveCrossWorkspaceDenialAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionResult> {
  let session: SessionInfo | null = null;
  try {
    session = await requireSession();
    const targetSlug = formData.get("targetSlug");
    const slug = z.string().min(1).safeParse(targetSlug);
    if (!slug.success) {
      return { ok: false, code: "BAD_TARGET", message: "Missing target workspace." };
    }
    if (slug.data !== session.workspaceSlug) {
      throw new DenialError(
        "CROSS_WORKSPACE_DENIED",
        "The requested workspace is not available in this session.",
        "workspace",
      );
    }
    assertWorkspaceMatch(session, slug.data);
    if (slug.data === session.workspaceSlug) {
      return { ok: false, code: "SAME_WORKSPACE", message: "Choose the other workspace to prove denial." };
    }
    return { ok: true, message: "Unexpectedly allowed (this should never happen)." };
  } catch (error) {
    if (isDenialError(error)) {
      if (session && error.code === "CROSS_WORKSPACE_DENIED") {
        try {
          writeDenialAudit(getDb(), session.workspaceId, {
            actorKind: "account",
            actorRef: session.accountId,
            code: error.code,
            targetType: "workspace",
            targetId: error.target,
          });
        } catch {
          return actionFailure("DENIAL_PROOF_FAILED");
        }
      }
      return { ok: false, code: error.code, message: error.message, denial: describeDenial(error) };
    }
    return actionFailure("DENIAL_PROOF_FAILED");
  }
}
