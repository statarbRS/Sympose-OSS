import type { Metadata } from "next";

import { getDb } from "@/server/db";
import { listEvents } from "@/server/services/events";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

import { EventSwitcher } from "./_components/event-switcher";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "All events · Sympose MVP" };

export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams?: Promise<{ created?: string | string[] }>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);

  const events = listEvents(getDb(), session.workspaceId);
  const query = searchParams ? await searchParams : undefined;
  const createdEventId = typeof query?.created === "string" ? query.created : undefined;

  return (
    <EventSwitcher
      workspace={session.workspaceSlug}
      events={events}
      createdEventId={createdEventId}
    />
  );
}
