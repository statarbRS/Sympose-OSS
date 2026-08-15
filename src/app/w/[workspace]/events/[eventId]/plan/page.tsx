import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "@/server/db";
import { buildCapacityFlightDeckProjection } from "@/server/services/capacity-flight-deck";
import { getEvent } from "@/server/services/events";
import {
  candidatePlanVersion,
  currentPlanVersion,
  planDetail,
  type PlanDetail,
} from "@/server/services/planning";
import { getProgramCapacitySurfaceProjection } from "@/server/services/program-capacity";
import { readCanonicalScheduleProjection } from "@/server/services/scheduling";
import {
  getRouteSession,
  requireOrganizerWorkspaceRoute,
} from "@/server/workspace-session";

import { CapacityFlightDeck } from "../_components/capacity-flight-deck";
import { EventProductSurface } from "../_components/product-surface";
import { PlanStudio, type PlanStudioDetail } from "./plan-studio";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Plan evidence · Sympose MVP",
};

function projectPlanDetail(detail: PlanDetail | null): PlanStudioDetail | null {
  if (!detail) {
    return null;
  }

  return {
    version: {
      versionNumber: detail.version.versionNumber,
      fingerprint: detail.version.fingerprint,
      status: detail.version.status,
    },
    content: {
      versionNumber: detail.content.versionNumber,
      snapshotFingerprint: detail.content.snapshotFingerprint,
      assignments: detail.content.assignments.map((assignment) => ({
        personId: assignment.personId,
        programUnitId: assignment.programUnitId,
        assignmentType: assignment.assignmentType,
        explanation: assignment.explanation,
      })),
      exclusions: detail.content.exclusions.map((exclusion) => ({
        personId: exclusion.personId,
        reason: exclusion.reason,
      })),
      diagnostics: {
        messages: [...detail.content.diagnostics.messages],
        unitCounts: { ...detail.content.diagnostics.unitCounts },
        moderatorsWithoutUnit: [...detail.content.diagnostics.moderatorsWithoutUnit],
      },
    },
    assignmentsJoined: detail.assignmentsJoined.map((assignment) => ({
      personId: assignment.personId,
      fullName: assignment.fullName,
      organization: assignment.organization,
      programUnitId: assignment.programUnitId,
      programUnitName: assignment.programUnitName,
      assignmentType: assignment.assignmentType,
      explanation: assignment.explanation,
    })),
    run: {
      id: detail.run.id,
      status: detail.run.status,
      inputFingerprint: detail.run.inputFingerprint,
      compiler: detail.run.compiler,
      compilerVersion: detail.run.compilerVersion,
      createdAt: detail.run.createdAt,
    },
    approvals: detail.approvals.map((approval) => ({ id: approval.id })),
    states: detail.states.map((state) => ({
      state: state.state,
      createdAt: state.createdAt,
      reason: state.reason,
    })),
  };
}

export default async function PlanPage({
  params,
}: {
  params: Promise<{ workspace: string; eventId: string }>;
}) {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);

  const db = getDb();
  const event = getEvent(db, session.workspaceId, eventId);
  if (!event) {
    notFound();
  }
  const candidateSummary = candidatePlanVersion(db, session.workspaceId, event.id);
  const currentSummary = currentPlanVersion(db, session.workspaceId, event.id);
  const reviewSummary = candidateSummary ?? currentSummary;
  const detail = reviewSummary
    ? planDetail(db, session.workspaceId, event.id, reviewSummary.id)
    : null;
  const approvedDetail = currentSummary && currentSummary.id !== reviewSummary?.id
    ? planDetail(db, session.workspaceId, event.id, currentSummary.id)
    : null;
  const capacityFlightDeck = buildCapacityFlightDeckProjection({
    capacity: getProgramCapacitySurfaceProjection(db, session, event.id),
    acceptedSchedule: readCanonicalScheduleProjection(
      db,
      { workspaceId: session.workspaceId, eventId: event.id },
      event as unknown as Record<string, unknown>,
    ),
    plan: detail,
  });
  const clientEvent = { id: event.id, name: event.name };

  return (
    <EventProductSurface
      workspace={workspace}
      event={event}
      active="plan"
      eyebrow="Plan record"
      title="Plan evidence"
      description="Review the exact compiler record, assignment explanations, and appended approval history for this event."
    >
      <PlanStudio
        workspace={workspace}
        event={clientEvent}
        detail={projectPlanDetail(detail)}
        approvedDetail={projectPlanDetail(approvedDetail)}
        capacityFlightDeck={<CapacityFlightDeck projection={capacityFlightDeck} />}
      />
    </EventProductSurface>
  );
}
