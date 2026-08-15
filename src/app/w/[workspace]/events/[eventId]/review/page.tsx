import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OrganizerReviewConsole } from "@/components/cfp-review/organizer-review-console";
import { ReviewerProvisioningPanel } from "@/components/cfp-review/reviewer-provisioning";
import { getDb } from "@/server/db";
import { EVALUATOR_DEVFLOW_REVIEWER_CONTRACT } from "@/server/evaluator-reviewer-contract";
import {
  OrganizerReviewServiceError,
  readOrganizerReviewSurface,
  type OrganizerReviewSort,
} from "@/server/services/cfp-review/organizer";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";
import {
  readPinnedReviewerProvisioning,
  ReviewerProvisioningServiceError,
  type ReviewerProvisioningProjection,
} from "@/server/services/cfp-review/reviewer-provisioning";

import { EventProductSurface } from "../_components/product-surface";
import styles from "./review-page.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review Room · Sympose MVP" };

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REVIEW_SORTS: readonly OrganizerReviewSort[] = ["rank", "score", "progress", "submission", "reviewer"];

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseSort(value: string | undefined): OrganizerReviewSort | undefined {
  return value && REVIEW_SORTS.includes(value as OrganizerReviewSort)
    ? (value as OrganizerReviewSort)
    : undefined;
}

export default async function ReviewPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string; eventId: string }>;
  readonly searchParams: Promise<{ round?: string | string[]; sort?: string | string[] }>;
}) {
  const { workspace, eventId } = await params;
  const query = await searchParams;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const roundQuery = firstQueryValue(query.round);
  if (roundQuery !== undefined && !IDENTIFIER_PATTERN.test(roundQuery)) notFound();
  const sort = parseSort(firstQueryValue(query.sort));

  try {
    const surface = readOrganizerReviewSurface(getDb(), session, {
      workspaceSlug: session.workspaceSlug,
      eventId,
      ...(roundQuery ? { roundId: roundQuery } : {}),
      ...(sort ? { sort } : {}),
    });
    let pinnedReviewerAccess: ReviewerProvisioningProjection | null = null;
    if (
      surface.eventId === EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId &&
      surface.rounds.some((round) => round.id === EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId)
    ) {
      try {
        pinnedReviewerAccess = readPinnedReviewerProvisioning(getDb(), session, {
          eventId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.eventId,
          roundId: EVALUATOR_DEVFLOW_REVIEWER_CONTRACT.roundId,
        });
      } catch (error) {
        if (!(error instanceof ReviewerProvisioningServiceError)) throw error;
      }
    }
    return (
      <EventProductSurface
        workspace={workspace}
        event={{ id: surface.eventId, name: surface.eventName }}
        active="review"
        eyebrow="Review Room"
        title="Review evidence"
        description="Independent review evidence remains distinct from organizer recommendations and selection authority."
      >
        <div className={styles.presentationBoundary}>
          <p className={styles.referenceNote} role="note">
            Proposal references are abbreviated for scanning; copied values retain the full
            immutable identifier.
          </p>
          {pinnedReviewerAccess ? <ReviewerProvisioningPanel access={pinnedReviewerAccess} /> : null}
          <OrganizerReviewConsole workspace={workspace} surface={surface} />
        </div>
      </EventProductSurface>
    );
  } catch (error) {
    if (
      error instanceof OrganizerReviewServiceError &&
      (error.code === "EVENT_NOT_AVAILABLE" || error.code === "ROUND_NOT_AVAILABLE")
    ) {
      notFound();
    }
    throw error;
  }
}
