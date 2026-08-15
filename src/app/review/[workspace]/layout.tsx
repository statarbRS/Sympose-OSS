import Link from "next/link";
import type { ReactNode } from "react";

import { ReviewerSignOutForm } from "@/components/cfp-review/sign-out-form";
import {
  getRouteSession,
  requireReviewerWorkspaceRoute,
} from "@/server/workspace-session";

export const dynamic = "force-dynamic";

export default async function ReviewerWorkspaceLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  requireReviewerWorkspaceRoute(session, workspace);
  const queueHref = `/review/${encodeURIComponent(session.workspaceSlug)}/queue`;

  return (
    <div className="review-root">
      <a className="review-skip-link" href="#review-main">
        Skip to review content
      </a>
      <header className="review-shell-header">
        <div className="review-shell-brand" aria-label="Sympose review console">
          <Link className="review-shell-mark" href={queueHref}>
            Sympose
          </Link>
          <span>Review console</span>
        </div>
        <div className="review-shell-context">
          <div>
            <span className="review-shell-label">Workspace</span>
            <strong>{session.workspaceName}</strong>
          </div>
          <nav aria-label="Reviewer navigation">
            <Link className="review-shell-queue-link" href={queueHref}>
              Your review queue
            </Link>
          </nav>
          <div className="review-shell-reviewer" aria-label="Authenticated reviewer">
            <span className="review-shell-label">Reviewer</span>
            <strong>{session.displayName}</strong>
            <span>{session.email}</span>
          </div>
          <ReviewerSignOutForm />
        </div>
      </header>
      <div className="review-authority-banner" role="note">
        <strong>Evaluation is evidence, not organizer authority.</strong>
        <span>Your review may recommend; only an authorized organizer can decide, assign, invite, or publish.</span>
      </div>
      <main className="review-main" id="review-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
