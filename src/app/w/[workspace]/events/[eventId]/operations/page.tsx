import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "@/server/db";
import { OperationsObservation } from "@/components/operations-observation/operations-observation";
import {
  getOperationsTimeline,
  OperationsTimeline,
} from "@/components/operations-timeline/operations-timeline";
import { OperatorProofExperience } from "@/components/operator-proof/operator-proof-experience";
import { getEvent } from "@/server/services/events";
import { getOperatorProofExperience } from "@/server/services/operator-proof";
import { getOperationsObservationSurface } from "@/server/services/outcomes";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

import { EventProductSurface, SurfaceSection } from "../_components/product-surface";
import {
  correctOperationsAttendanceAction,
  recordOperationsAttendanceAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Operations Handoff · Sympose MVP" };

export default async function OperationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; eventId: string }>;
  searchParams: Promise<{
    attendanceResult?: string | string[];
    attendanceReceipt?: string | string[];
  }>;
}) {
  const { workspace, eventId } = await params;
  const query = await searchParams;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const db = getDb();
  const event = getEvent(db, session.workspaceId, eventId);
  if (!event) notFound();
  const timeline = getOperationsTimeline(db, session.workspaceId, eventId);
  const observations = getOperationsObservationSurface(db, session, eventId);
  const operatorProof = getOperatorProofExperience(db, session.workspaceId, eventId);
  if (!operatorProof) notFound();
  const result = typeof query.attendanceResult === "string" ? query.attendanceResult : null;
  const resultReceipt = typeof query.attendanceReceipt === "string" ? query.attendanceReceipt : null;
  const renderedAt = new Date().toISOString();
  const recordingAllowed = event.lifecycle === "live" &&
    event.startsAt <= renderedAt && renderedAt < event.endsAt;
  const recordAction = recordOperationsAttendanceAction.bind(null, workspace, eventId);
  const correctionAction = correctOperationsAttendanceAction.bind(null, workspace, eventId);
  return (
    <EventProductSurface
      workspace={workspace}
      event={event}
      active="operations"
      eyebrow="Operations ledger"
      title="From proposal to event day"
      description="Record bounded live attendance, append explicit corrections, and inspect exact persisted event evidence. Sealed releases never mutate, and missing stages stay visibly unavailable."
    >
      <SurfaceSection id="operations-live" title="Live attendance observations">
        <OperationsObservation
          surface={observations}
          timezone={event.timezone}
          recordingAllowed={recordingAllowed}
          result={result}
          resultReceipt={resultReceipt}
          recordAction={recordAction}
          correctionAction={correctionAction}
        />
      </SurfaceSection>
      <SurfaceSection id="operations-proof" title="Readiness proof and immutable release twin">
        <OperatorProofExperience projection={operatorProof} />
      </SurfaceSection>
      <SurfaceSection id="operations-timeline" title="Operational activity timeline">
        <OperationsTimeline projection={timeline} timezone={event.timezone} />
      </SurfaceSection>
    </EventProductSurface>
  );
}
