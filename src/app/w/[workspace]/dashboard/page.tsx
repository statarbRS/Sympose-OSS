import { getDb } from "@/server/db";
import { toPlainData } from "@/server/canonical";
import { getDashboardState } from "@/server/services/queries";
import {
  getRouteSession,
  listOtherWorkspaceSlugs,
  requireOrganizerWorkspaceRoute,
} from "@/server/workspace-session";
import { WorkspaceDashboard } from "@/components/workspace-dashboard";
import { validatePublicReleaseForRead } from "@/server/services/publication";
import { publicReleaseReference } from "@/server/services/public-reference";
import {
  EVALUATOR_COMPATIBILITY_CALL_SLUG,
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
} from "@/server/evaluator-compatibility";
import {
  EVALUATOR_CALL_SLUG,
  EVALUATOR_EVENT_ID,
  EVALUATOR_WORKSPACE_ID,
  EVALUATOR_WORKSPACE_SLUG,
} from "@/server/evaluator-demo";

export const metadata: Metadata = {
  title: "Workspace dashboard · Sympose MVP",
};

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);

  const db = getDb();
  const state = getDashboardState(
    db,
    session.workspaceId,
    listOtherWorkspaceSlugs(session.workspaceSlug),
  );
  const evaluatorTarget =
    session.workspaceSlug === EVALUATOR_WORKSPACE_SLUG && session.workspaceId === EVALUATOR_WORKSPACE_ID
      ? {
          workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
          workspaceId: EVALUATOR_WORKSPACE_ID,
          callSlug: EVALUATOR_CALL_SLUG,
          eventId: EVALUATOR_EVENT_ID,
        }
      : session.workspaceSlug === EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG &&
          session.workspaceId === EVALUATOR_COMPATIBILITY_WORKSPACE_ID
        ? {
            workspaceSlug: EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
            workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
            callSlug: EVALUATOR_COMPATIBILITY_CALL_SLUG,
            eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
          }
        : null;
  const evaluatorRelease = evaluatorTarget && state.release
    ? validatePublicReleaseForRead(db, {
        workspaceId: evaluatorTarget.workspaceId,
        eventId: evaluatorTarget.eventId,
        releaseId: state.release.id,
        mode: "CURRENT",
      })
    : null;

  const evaluator = evaluatorTarget
    ? {
        workspaceSlug: evaluatorTarget.workspaceSlug,
        callSlug: evaluatorTarget.callSlug,
        eventId: evaluatorTarget.eventId,
        publicChannelReference: evaluatorRelease
          ? publicReleaseReference({
              workspaceId: evaluatorRelease.workspaceId,
              eventId: evaluatorRelease.eventId,
              releaseId: evaluatorRelease.releaseId,
            })
          : null,
      }
    : null;
  return <WorkspaceDashboard state={toPlainData(state)} slug={session.workspaceSlug} evaluator={evaluator} />;
}
import type { Metadata } from "next";
