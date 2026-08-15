import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getDb } from "./db";
import {
  assertWorkspaceMatch,
  hasCapability,
  isDenialError,
  resolveSession,
  SESSION_COOKIE,
  type SessionInfo,
} from "./auth";
import {
  EVALUATOR_DEVFLOW_REVIEWER_CONTRACT,
  isPinnedDevflowReviewerAccount,
} from "./evaluator-reviewer-contract";
import { requirePinnedReviewerActivation } from "./services/cfp-review/reviewer-provisioning";
import { listLoginChoices } from "./services/queries";

/**
 * Server-only session/workspace helper for the authenticated workspace shell.
 * Every /w/[workspace] route resolves the session from the httpOnly cookie and
 * asserts the requested route slug against the session BEFORE any workspace
 * query runs. A missing session redirects to sign-in; a slug that is not the
 * session's workspace renders 404 (never a data leak).
 */
export async function getRouteSession(): Promise<SessionInfo> {
  const store = await cookies();
  const session = resolveSession(getDb(), store.get(SESSION_COOKIE)?.value);
  if (!session) {
    redirect("/?reason=session-expired");
  }
  return session;
}

export function requireWorkspaceRoute(session: SessionInfo, requestedSlug: string): SessionInfo {
  try {
    assertWorkspaceMatch(session, requestedSlug);
  } catch (error) {
    if (isDenialError(error)) {
      notFound();
    }
    throw error;
  }
  return session;
}

/** The organizer shell is projected only when at least one shell destination is authorized. */
export function requireWorkspaceShellRoute(
  session: SessionInfo,
  requestedSlug: string,
): SessionInfo {
  requireWorkspaceRoute(session, requestedSlug);
  if (
    !hasCapability(session, "phase0.pipeline.manage") &&
    !hasCapability(session, "connectors.manage")
  ) {
    notFound();
  }
  return session;
}

/**
 * Organizer pages are a separate authorization surface from reviewer work.
 * Page components call this before their own queries because Next may render a
 * page and its parent layout concurrently.
 */
export function requireOrganizerWorkspaceRoute(
  session: SessionInfo,
  requestedSlug: string,
): SessionInfo {
  requireWorkspaceRoute(session, requestedSlug);
  if (!hasCapability(session, "phase0.pipeline.manage")) {
    notFound();
  }
  return session;
}

/** Connector secrets and provider execution use a narrower workspace capability. */
export function requireConnectorWorkspaceRoute(
  session: SessionInfo,
  requestedSlug: string,
): SessionInfo {
  requireWorkspaceRoute(session, requestedSlug);
  if (!hasCapability(session, "connectors.manage")) notFound();
  return session;
}

/**
 * Reviewer pages are a separate authorization surface from organizer work.
 * Page components call this before their own queries because Next may render a
 * page and its parent layout concurrently.
 */
export function requireReviewerWorkspaceRoute(
  session: SessionInfo,
  requestedSlug: string,
): SessionInfo {
  requireWorkspaceRoute(session, requestedSlug);
  if (!hasCapability(session, "cfp.review")) {
    notFound();
  }
  if (
    isPinnedDevflowReviewerAccount({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      role: session.role as "reviewer",
      email: session.email,
    })
  ) {
    try {
      requirePinnedReviewerActivation(getDb());
    } catch {
      notFound();
    }
    if (session.workspaceId !== EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.workspaceId) {
      notFound();
    }
  }
  return session;
}

export function listOtherWorkspaceSlugs(currentSlug: string): string[] {
  const slugs = new Set(listLoginChoices(getDb()).map((choice) => choice.workspaceSlug));
  slugs.delete(currentSlug);
  return [...slugs].sort();
}
