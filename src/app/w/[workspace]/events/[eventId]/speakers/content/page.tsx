import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContentLibrary } from "@/components/content-library/content-library";
import { getDb } from "@/server/db";
import { listContentLibrary } from "@/server/services/content-library";
import { getEvent } from "@/server/services/events";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

import { EventProductSurface, SurfaceSection } from "../../_components/product-surface";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Content Library · Sympose MVP",
  description: "Organizer-only persisted speaker file versions and bounded latest-file ZIP export.",
};

export default async function ContentLibraryPage({
  params,
}: {
  readonly params: Promise<{ readonly workspace: string; readonly eventId: string }>;
}) {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const db = getDb();
  const event = getEvent(db, session.workspaceId, eventId);
  if (!event) notFound();
  const projection = listContentLibrary(db, {
    kind: "organizer",
    workspaceId: session.workspaceId,
    eventId: event.id,
    actorId: session.accountId,
  });
  return (
    <EventProductSurface
      workspace={workspace}
      event={event}
      active="speakers"
      eyebrow="Content Library"
      title="Speaker files and immutable versions"
      description="An organizer-only, exact-event view of durable speaker artifact metadata, with downloads that verify stored bytes when read. ZIP export accepts current versions only and fails atomically if any selected file is unavailable."
    >
      <SurfaceSection title="Central Content Library">
        <ContentLibrary workspace={workspace} projection={projection} />
      </SurfaceSection>
    </EventProductSurface>
  );
}
