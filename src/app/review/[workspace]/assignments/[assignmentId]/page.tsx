import {
  ConflictBlockedAssignment,
  ReviewAssignment,
} from "@/components/cfp-review/review-assignment";
import { ReviewUnavailable } from "@/components/cfp-review/review-unavailable";
import { closeDb, getDb } from "@/server/db";
import {
  ReviewerServiceError,
  ReviewerServiceFatalError,
  listOwnReviewAssignments,
  readOwnReviewAssignment,
  type OwnReviewAssignmentSummary,
} from "@/server/services/cfp-review";
import {
  getRouteSession,
  requireReviewerWorkspaceRoute,
} from "@/server/workspace-session";

import {
  issueConflictActionBinding,
  issueReviewActionBinding,
} from "../../../reviewer-binding.server";

export const dynamic = "force-dynamic";

export default async function ReviewerAssignmentPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; assignmentId: string }>;
}) {
  const { workspace, assignmentId } = await params;
  const session = await getRouteSession();
  requireReviewerWorkspaceRoute(session, workspace);
  const db = getDb();
  try {
    const detail = readOwnReviewAssignment(db, session, {
      workspaceSlug: session.workspaceSlug,
      assignmentId,
    });
    return (
      <ReviewAssignment
        bindingToken={issueReviewActionBinding(session, detail)}
        detail={detail}
        workspace={session.workspaceSlug}
      />
    );
  } catch (error) {
    if (error instanceof ReviewerServiceFatalError) {
      closeDb(db);
      throw error;
    }
    if (!(error instanceof ReviewerServiceError) || error.code !== "ASSIGNMENT_NOT_AVAILABLE") {
      return <ReviewUnavailable />;
    }
  }

  let conflictAssignment: OwnReviewAssignmentSummary | undefined;
  try {
    conflictAssignment = listOwnReviewAssignments(db, session, {
      workspaceSlug: session.workspaceSlug,
    }).find(
      (assignment) =>
        assignment.assignmentId === assignmentId && assignment.conflictStatus === "DECLARED",
    );
  } catch (error) {
    if (error instanceof ReviewerServiceFatalError) {
      closeDb(db);
      throw error;
    }
    return <ReviewUnavailable />;
  }
  if (!conflictAssignment) return <ReviewUnavailable />;
  return (
    <ConflictBlockedAssignment
      assignment={conflictAssignment}
      bindingToken={issueConflictActionBinding(session, conflictAssignment)}
      workspace={session.workspaceSlug}
    />
  );
}
