import { notFound } from "next/navigation";

import { getDb } from "@/server/db";
import { getEvent } from "@/server/services/events";
import { getSyntheticSpeakerOperationsRepository } from "@/server/services/speaker-operations";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ workspace: string; eventId: string }> }): Promise<Response> {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const event = getEvent(getDb(), session.workspaceId, eventId);
  if (!event) notFound();
  const versionIds = new URL(request.url).searchParams.getAll("versionId");
  const result = getSyntheticSpeakerOperationsRepository(getDb()).exportContentMetadata(
    { kind: "organizer", workspaceId: session.workspaceId, eventId: event.id, actorId: session.accountId },
    { id: event.id, name: event.name, timezone: event.timezone, startsAt: event.startsAt, endsAt: event.endsAt },
    versionIds,
  );
  return new Response(result.body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${result.fileName}"`,
      "cache-control": "private, no-store",
      "x-sympose-export-rows": String(result.rowCount),
      "x-sympose-file-boundary": "metadata-only-csv; authenticated-file-download-separate",
    },
  });
}
