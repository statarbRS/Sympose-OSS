import { notFound } from "next/navigation";

import { getDb } from "@/server/db";
import { getEvent } from "@/server/services/events";
import { getSyntheticSpeakerOperationsRepository } from "@/server/services/speaker-operations";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ workspace: string; eventId: string }> }): Promise<Response> {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const event = getEvent(getDb(), session.workspaceId, eventId);
  if (!event) notFound();
  const repository = getSyntheticSpeakerOperationsRepository(getDb());
  const exportResult = repository.exportReadinessCsv(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    { id: event.id, name: event.name, timezone: event.timezone, startsAt: event.startsAt, endsAt: event.endsAt },
  );
  return new Response(exportResult.body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${exportResult.fileName}"`,
      "cache-control": "private, no-store",
      "x-sympose-export-rows": String(exportResult.rowCount),
    },
  });
}
