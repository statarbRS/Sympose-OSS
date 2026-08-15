import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OrganizerCfpFrame, OrganizerCfpOverview } from "@/components/cfp-organizer/organizer-cfp-builder";
import { getDb } from "@/server/db";
import { CfpOrganizerError, readCfpOrganizerOverview } from "@/server/services/cfp/organizer";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Call for Proposals · Sympose MVP" };

export default async function EventCfpPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; eventId: string }>;
}) {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  try {
    const projection = readCfpOrganizerOverview(getDb(), session, eventId);
    return (
      <OrganizerCfpFrame workspace={workspace} event={projection.event}>
        <OrganizerCfpOverview workspace={workspace} event={projection.event} calls={projection.calls} />
      </OrganizerCfpFrame>
    );
  } catch (error) {
    if (error instanceof CfpOrganizerError && error.code === "EVENT_NOT_FOUND") notFound();
    throw error;
  }
}
