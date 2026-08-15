import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmbedManager } from "@/components/public-widgets/embed-manager";
import { PublicationConsole } from "@/components/public-agenda/publication-console";
import {
  toPublicationConsoleAudienceMatrix,
  toPublicationConsoleRelease,
} from "@/components/public-agenda/publication-console-model";
import { getDb } from "@/server/db";
import { toPlainData } from "@/server/canonical";
import { getEvent } from "@/server/services/events";
import { parseEmbedConfiguration } from "@/server/services/public-widgets/embed";
import {
  listEmbedConfigurations,
  resolveCurrentPublicAgendaRelease,
  toPublicWidgetProjection,
} from "@/server/services/public-widgets";
import { validatePublicReleaseForRead } from "@/server/services/publication";
import { getPublicationAudienceMatrix } from "@/server/services/publication-audience";
import { getOperatorProofExperience } from "@/server/services/operator-proof";
import { publicReleaseReference } from "@/server/services/public-reference";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";
import { publicationAudienceFormAction, sealPublicationReleaseAction } from "./actions";
import { savePublicationEmbedConfiguration } from "./embed-config/actions";

import { EventProductSurface, SurfaceSection } from "../_components/product-surface";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Publication · Sympose MVP" };

export default async function PublicationPage({ params }: { params: Promise<{ workspace: string; eventId: string }> }) {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const db = getDb();
  const event = getEvent(db, session.workspaceId, eventId);
  if (!event) notFound();

  const currentRelease = event.currentReleaseId
    ? validatePublicReleaseForRead(db, {
        workspaceId: session.workspaceId,
        eventId: event.id,
        releaseId: event.currentReleaseId,
        mode: "CURRENT",
      })
    : null;
  const channelReference = currentRelease
    ? publicReleaseReference({
        workspaceId: currentRelease.workspaceId,
        eventId: currentRelease.eventId,
        releaseId: currentRelease.releaseId,
      })
    : null;
  const currentPublicAgendaProjection = currentRelease && channelReference
    ? resolveCurrentPublicAgendaRelease(db, {
      workspaceId: session.workspaceId,
      eventId: event.id,
      }, channelReference)
    : null;
  const currentPublicWidget = currentRelease && currentPublicAgendaProjection &&
    currentPublicAgendaProjection.release.fingerprint === currentRelease.fingerprint
    ? toPublicWidgetProjection(currentPublicAgendaProjection)
    : null;
  const persistedEmbedConfigurations = currentPublicWidget
    ? listEmbedConfigurations(db, {
        workspaceId: session.workspaceId,
        eventId: event.id,
        channelReference: channelReference!,
      })
    : [];
  const savedEmbedConfigurations = persistedEmbedConfigurations.map((entry) => ({
    id: entry.id,
    label: entry.label,
    configuration: entry.configuration,
    savedAt: entry.savedAt,
  }));
  const initialEmbedConfiguration = savedEmbedConfigurations[0]?.configuration ?? parseEmbedConfiguration({});
  const initialEmbedConfigurationId = savedEmbedConfigurations[0]?.id ?? null;
  const scope = { workspaceSlug: workspace, eventId: event.id } as const;
  const action = sealPublicationReleaseAction.bind(null, scope);
  const audienceAction = publicationAudienceFormAction.bind(null, scope);
  const audienceMatrix = getPublicationAudienceMatrix(db, session, { eventId: event.id });
  const operatorProof = getOperatorProofExperience(db, session.workspaceId, event.id);
  if (!operatorProof) notFound();

  return <EventProductSurface
    workspace={workspace}
    event={event}
    active="publication"
    eyebrow="Publication"
    title="Durable publication release"
    description="The public surface is derived only from the event's validated sealed current release. Approval remains a separate plan decision; this page only seals that server-owned source."
  >
    <SurfaceSection title="Public agenda channel"><PublicationConsole
      workspaceSlug={workspace}
      event={{ id: event.id }}
      currentRelease={toPublicationConsoleRelease(currentRelease)}
      action={action}
      audienceMatrix={toPublicationConsoleAudienceMatrix(audienceMatrix)}
      audienceAction={audienceAction}
      operatorProof={toPlainData(operatorProof)}
    /></SurfaceSection>
    <SurfaceSection title="Embed configuration">
      {currentPublicWidget ? (
        <EmbedManager
          widget={currentPublicWidget}
          configuration={initialEmbedConfiguration}
          configurationId={initialEmbedConfigurationId}
          initialSavedConfigurations={savedEmbedConfigurations}
          eventId={event.id}
          saveAction={savePublicationEmbedConfiguration}
          publicPreview={false}
        />
      ) : (
        <p data-testid="organizer-embed-unavailable">
          Embed configuration is unavailable until a validated sealed current release exists for this event.
        </p>
      )}
    </SurfaceSection>
  </EventProductSurface>;
}
