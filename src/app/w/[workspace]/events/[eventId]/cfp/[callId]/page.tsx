import { notFound } from "next/navigation";

import { OrganizerCfpBuilder, OrganizerCfpFrame } from "@/components/cfp-organizer/organizer-cfp-builder";
import { getDb } from "@/server/db";
import { CfpOrganizerError, readCfpOrganizerCall, readCfpOrganizerOverview } from "@/server/services/cfp/organizer";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

export const dynamic = "force-dynamic";

export default async function EventCfpCallPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; eventId: string; callId: string }>;
}) {
  const { workspace, eventId, callId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  try {
    const overview = readCfpOrganizerOverview(getDb(), session, eventId);
    const projection = readCfpOrganizerCall(getDb(), session, eventId, callId);
    return (
      <OrganizerCfpFrame workspace={workspace} event={overview.event}>
        <OrganizerCfpBuilder workspace={workspace} event={overview.event} callId={callId} projection={projection} />
      </OrganizerCfpFrame>
    );
  } catch (error) {
    if (error instanceof CfpOrganizerError && (error.code === "CALL_NOT_FOUND" || error.code === "EVENT_NOT_FOUND")) notFound();
    throw error;
  }
}
