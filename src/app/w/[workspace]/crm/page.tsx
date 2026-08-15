import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  CrmConsole,
  type CrmEventSurface,
} from "@/components/crm/crm-console";
import { getDb } from "@/server/db";
import { getCrmWorkspaceView } from "@/server/services/crm";
import { listEvents } from "@/server/services/events";
import {
  listManualSpeakerRecords,
  manualSpeakerCreateIdempotencyKey,
} from "@/server/services/speaker-operations";
import {
  listSpeakerCommunicationDeliveryLog,
  SPEAKER_COMMUNICATION_MAX_RECIPIENTS,
} from "@/server/services/speaker-communications";
import {
  getRouteSession,
  requireOrganizerWorkspaceRoute,
} from "@/server/workspace-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CRM · Sympose MVP",
};

export default async function CrmPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);

  const db = getDb();
  const view = getCrmWorkspaceView(db, session, workspace);
  if (!view) {
    notFound();
  }
  const events: CrmEventSurface[] = listEvents(db, session.workspaceId).map((event) => {
    const scope = {
      kind: "organizer" as const,
      workspaceId: session.workspaceId,
      eventId: event.id,
      actorId: session.accountId,
    };
    const memberships = listManualSpeakerRecords(db, scope).map((record) => ({
      personId: record.personId,
      roleKey: record.roleKey,
      participationStatus: record.participationStatus,
      updatedAt: record.updatedAt,
    }));
    const history = listSpeakerCommunicationDeliveryLog(db, {
      workspaceId: session.workspaceId,
      eventId: event.id,
    });
    return {
      id: event.id,
      name: event.name,
      lifecycle: event.lifecycle,
      memberships,
      history,
      maxRecipients: SPEAKER_COMMUNICATION_MAX_RECIPIENTS,
      nextCommunicationIdempotencyKey: `crm-bulk:${event.id}:${history.length}`,
      linkIdempotencyKeys: Object.fromEntries(
        view.people.map((person) => [
          person.id,
          manualSpeakerCreateIdempotencyKey(scope, {
            fullName: person.fullName,
            email: person.canonicalEmail,
          }),
        ]),
      ),
    };
  });

  return (
    <CrmConsole
      workspaceSlug={view.workspace.slug}
      workspaceName={view.workspace.name}
      people={view.people}
      metrics={view.metrics}
      events={events}
    />
  );
}
