import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "@/server/db";
import { getEvent } from "@/server/services/events";
import {
  getSyntheticSpeakerOperationsRepository,
  speakerEventInitializationFor,
} from "@/server/services/speaker-operations";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";
import { SpeakerRoster, SpeakerReviewQueue, speakerFilterFromSearchParams } from "@/components/speaker-ops/speaker-roster";
import { SpeakerCommunicationsPanel } from "@/components/speaker-communications-panel";
import { SharedActionTasksPanel } from "@/components/shared-action-tasks-panel";

import { EventProductSurface, SurfaceSection, styles } from "../_components/product-surface";
import { loadSpeakerCommunicationsSurface } from "./communications/actions";
import { loadSharedActionTasksSurface } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Speaker Operations · Sympose MVP", description: "Canonical Person-backed speaker operations and readiness." };

export default async function SpeakersPage({ params, searchParams }: { params: Promise<{ workspace: string; eventId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const event = getEvent(getDb(), session.workspaceId, eventId);
  if (!event) notFound();
  const eventContext = { id: event.id, name: event.name, timezone: event.timezone, startsAt: event.startsAt, endsAt: event.endsAt };
  const filter = speakerFilterFromSearchParams(await searchParams);
  const repository = getSyntheticSpeakerOperationsRepository(getDb());
  repository.initializeEvent(session.workspaceId, eventContext, speakerEventInitializationFor(session.workspaceId, event.id));
  const projection = repository.getOrganizerProjection(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    eventContext,
    filter,
  );
  const communications = await loadSpeakerCommunicationsSurface(workspace, event.id);
  if (!communications) notFound();
  const sharedActionTasks = await loadSharedActionTasksSurface(workspace, event.id);
  if (!sharedActionTasks) notFound();
  return <EventProductSurface workspace={workspace} event={event} active="speakers" eyebrow="Speaker Operations" title="Speaker commitments and operations" description="Canonical people, exact offers, task evidence, immutable content versions, and deterministic readiness remain separate projections.">
    <SurfaceSection title="Content Library"><p>Review every persisted speaker file version for this event, download exact authorized bytes, or export selected current files as a bounded ZIP. <a href={`/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(event.id)}/speakers/content`}>Open Content Library</a>.</p></SurfaceSection>
    <SurfaceSection title="Speaker roster"><SpeakerRoster workspace={workspace} projection={projection} filter={filter} /></SurfaceSection>
    <SharedActionTasksPanel surface={sharedActionTasks} />
    <SpeakerCommunicationsPanel surface={communications} />
    <SpeakerReviewQueue workspace={workspace} projection={projection} />
    <SurfaceSection title="Boundary notes"><ul className={styles.muted}><li>All roster rows resolve to the canonical Person identity; no Speaker identity is created.</li><li>Invitation delivery is a simulated local receipt. Due-date ACTION reminders are different: they persist as local PENDING outbox rows and do not contact a provider or claim delivery.</li><li>Headshot PNG and slides PDF submissions are bounded, hashed, immutable local artifact versions; authenticated downloads remain scoped to the speaker and event.</li><li>Readiness is recomputed from the existing immutable speaker-readiness evaluator; no mutable ready flag is persisted.</li></ul></SurfaceSection>
  </EventProductSurface>;
}
