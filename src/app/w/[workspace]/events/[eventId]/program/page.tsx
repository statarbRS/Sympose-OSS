import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ScheduleBuilder } from "@/components/schedule-builder/schedule-builder";
import { getDb } from "@/server/db";
import { fingerprintOf } from "@/server/canonical";
import { buildCapacityFlightDeckProjection } from "@/server/services/capacity-flight-deck";
import { getEvent } from "@/server/services/events";
import { currentPlanVersion, planDetail } from "@/server/services/planning";
import { getProgramCapacitySurfaceProjection } from "@/server/services/program-capacity";
import { readScheduleDraft } from "@/server/services/scheduling/persistence";
import {
  readCurrentScheduleApproval,
  scheduleApprovalSubject,
} from "@/server/services/scheduling/approval";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";
import { approveScheduleDraftAction, saveScheduleDraftAction } from "./actions";

import { CapacityFlightDeck } from "../_components/capacity-flight-deck";
import { EventProductSurface, SurfaceSection } from "../_components/product-surface";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Plan Studio · Sympose MVP" };

export default async function ProgramPage({ params }: { params: Promise<{ workspace: string; eventId: string }> }) {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const db = getDb();
  const event = getEvent(db, session.workspaceId, eventId);
  if (!event) {
    notFound();
    return null;
  }
  const loaded = readScheduleDraft(db, { workspaceId: session.workspaceId, eventId: event.id });
  const scheduleApproval = readCurrentScheduleApproval(db, { workspaceId: session.workspaceId, eventId: event.id });
  const currentPlan = currentPlanVersion(db, session.workspaceId, event.id);
  const capacityFlightDeck = buildCapacityFlightDeckProjection({
    capacity: getProgramCapacitySurfaceProjection(db, session, event.id),
    acceptedSchedule: loaded.schedule,
    plan: currentPlan ? planDetail(db, session.workspaceId, event.id, currentPlan.id) : null,
  });

  return <EventProductSurface
    workspace={workspace}
    event={event}
    active="program"
    eyebrow="Plan Studio · Schedule draft"
    title="Plan Studio"
    description="A deterministic multi-day scheduling draft with organizer room/track controls, direct placement, conflict repair, and an explicit approval-to-publication handoff. Draft commands are validated and persisted for this workspace and event with optimistic revision control."
  >
    <SurfaceSection title="Schedule draft"><ScheduleBuilder initialSchedule={loaded.schedule} initialPersistence={loaded.persisted ? "saved" : "not-saved"} initialScheduleAuthorityFingerprint={loaded.pointer ? fingerprintOf(scheduleApprovalSubject(loaded.pointer)) : null} initialApproval={scheduleApproval} saveDraftAction={saveScheduleDraftAction} approveDraftAction={approveScheduleDraftAction} workspaceSlug={workspace} /></SurfaceSection>
    <CapacityFlightDeck projection={capacityFlightDeck} />
  </EventProductSurface>;
}
