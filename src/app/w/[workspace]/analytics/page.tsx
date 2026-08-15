import type { Metadata } from "next";

import { CrossEventAnalytics } from "@/components/cross-event-analytics/cross-event-analytics";
import {
  buildCrossEventAnalyticsModel,
  type AnalyticsSource,
  type CrossEventAnalyticsInput,
  type PublicationState,
  type ReviewCounts,
  type ScheduleCounts,
  type SubmissionCounts,
} from "@/components/cross-event-analytics/model";
import { getDb, type Db } from "@/server/db";
import {
  readCfpOrganizerCall,
  readCfpOrganizerOverview,
  type OrganizerCfpOverview,
} from "@/server/services/cfp/organizer";
import { readOrganizerReviewSurface } from "@/server/services/cfp-review/organizer";
import { listEvents, type EventRow } from "@/server/services/events";
import { validatePublicReleaseForRead } from "@/server/services/publication";
import {
  getRouteSession,
  requireOrganizerWorkspaceRoute,
} from "@/server/workspace-session";
import type { SessionInfo } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Cross-event analytics · Sympose MVP",
  description: "Read-only workspace analytics from current persisted event evidence.",
};

const SOURCE_UNAVAILABLE = "This event's authoritative persisted source could not be read, so no value was inferred.";
const READINESS_UNAVAILABLE = "A durable authoritative speaker-readiness projection is not available at this base. Roster membership is not treated as readiness.";

function available<T>(value: T): AnalyticsSource<T> {
  return { kind: "available", value };
}

function unavailable<T>(reason = SOURCE_UNAVAILABLE): AnalyticsSource<T> {
  return { kind: "unavailable", reason };
}

function readSubmissionSource(
  db: Db,
  session: SessionInfo,
  eventId: string,
): { readonly overview: OrganizerCfpOverview | null; readonly source: AnalyticsSource<SubmissionCounts> } {
  try {
    const overview = readCfpOrganizerOverview(db, session, eventId);
    const counts = overview.calls.reduce<SubmissionCounts>(
      (total, call) => ({
        draft: total.draft + call.submissionCounts.draft,
        submitted: total.submitted + call.submissionCounts.submitted,
        withdrawn: total.withdrawn + call.submissionCounts.withdrawn,
        invalidated: total.invalidated + call.submissionCounts.invalidated,
      }),
      { draft: 0, submitted: 0, withdrawn: 0, invalidated: 0 },
    );
    return { overview, source: available(counts) };
  } catch {
    return { overview: null, source: unavailable() };
  }
}

function readReviewSource(
  db: Db,
  session: SessionInfo,
  eventId: string,
): AnalyticsSource<ReviewCounts> {
  try {
    const surface = readOrganizerReviewSurface(db, session, {
      workspaceSlug: session.workspaceSlug,
      eventId,
    });
    return available(surface.rounds.reduce<ReviewCounts>(
      (total, round) => ({
        assigned: total.assigned + round.progress.assigned,
        inProgress: total.inProgress + round.progress.inProgress,
        submitted: total.submitted + round.progress.submitted,
        recused: total.recused + round.progress.recused,
        revoked: total.revoked + round.progress.revoked,
        activeTotal: total.activeTotal + round.progress.total,
      }),
      { assigned: 0, inProgress: 0, submitted: 0, recused: 0, revoked: 0, activeTotal: 0 },
    ));
  } catch {
    return unavailable();
  }
}

function readScheduleSource(
  db: Db,
  session: SessionInfo,
  eventId: string,
  overview: OrganizerCfpOverview | null,
): AnalyticsSource<ScheduleCounts> {
  if (!overview) return unavailable();
  try {
    let accepted = 0;
    let scheduled = 0;
    for (const call of overview.calls) {
      const projection = readCfpOrganizerCall(db, session, eventId, call.callId);
      for (const submission of projection.submissions) {
        if (submission.decision?.decision !== "ACCEPTED") continue;
        if (!submission.decision.handoff) {
          return unavailable("An accepted CFP decision lacked its required session-handoff projection, so scheduling was not calculated.");
        }
        accepted += 1;
        if (submission.decision.handoff.linkedSession.status !== "UNSCHEDULED") scheduled += 1;
      }
    }
    return available({ scheduled, accepted });
  } catch {
    return unavailable();
  }
}

function readPublicationSource(
  db: Db,
  workspaceId: string,
  event: EventRow,
): AnalyticsSource<PublicationState> {
  if (event.currentReleaseId === null) return available({ state: "not-published" });
  try {
    const release = validatePublicReleaseForRead(db, {
      workspaceId,
      eventId: event.id,
      releaseId: event.currentReleaseId,
      mode: "CURRENT",
    });
    return release
      ? available({ state: "healthy", sealedAt: release.sealedAt })
      : unavailable("A current release pointer exists, but its immutable release evidence could not be validated.");
  } catch {
    return unavailable("A current release pointer exists, but its immutable release evidence could not be validated.");
  }
}

function readEventAnalytics(
  db: Db,
  session: SessionInfo,
  event: EventRow,
): CrossEventAnalyticsInput {
  const submissions = readSubmissionSource(db, session, event.id);
  return {
    event: {
      id: event.id,
      name: event.name,
      lifecycle: event.lifecycle,
      timezone: event.timezone,
    },
    submissions: submissions.source,
    reviews: readReviewSource(db, session, event.id),
    speakers: unavailable(READINESS_UNAVAILABLE),
    schedule: readScheduleSource(db, session, event.id, submissions.overview),
    publication: readPublicationSource(db, session.workspaceId, event),
  };
}

export default async function AnalyticsPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);

  const db = getDb();
  const events = listEvents(db, session.workspaceId).map((event) =>
    readEventAnalytics(db, session, event),
  );
  const model = buildCrossEventAnalyticsModel({
    workspaceName: session.workspaceName,
    workspaceSlug: session.workspaceSlug,
    events,
  });

  return <CrossEventAnalytics model={model} />;
}
