import { ReviewUnavailable } from "@/components/cfp-review/review-unavailable";
import { ReviewerQueue } from "@/components/cfp-review/reviewer-queue";
import { closeDb, getDb } from "@/server/db";
import {
  ReviewerServiceFatalError,
  listOwnReviewAssignments,
} from "@/server/services/cfp-review";
import {
  getRouteSession,
  requireReviewerWorkspaceRoute,
} from "@/server/workspace-session";

export const dynamic = "force-dynamic";

export default async function ReviewerQueuePage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  requireReviewerWorkspaceRoute(session, workspace);
  const db = getDb();
  try {
    const assignments = listOwnReviewAssignments(db, session, {
      workspaceSlug: session.workspaceSlug,
    });
    const presentedAssignments = assignments.map((assignment, index) => ({
      ...assignment,
      roundName: `Blind proposal ${index + 1} of ${assignments.length} · ${assignment.roundName}`,
    }));
    return <ReviewerQueue assignments={presentedAssignments} workspace={session.workspaceSlug} />;
  } catch (error) {
    if (error instanceof ReviewerServiceFatalError) {
      closeDb(db);
      throw error;
    }
    return <ReviewUnavailable />;
  }
}
