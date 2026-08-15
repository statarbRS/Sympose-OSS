import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DeliveryCenter } from "@/components/delivery-center/delivery-center";
import { getDb } from "@/server/db";
import {
  DeliveryCenterAuthorizationError,
  DeliveryCenterNotFoundError,
  readDeliveryCenter,
} from "@/server/services/delivery-center";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Delivery Center · Sympose MVP" };

export default async function DeliveryCenterPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; eventId: string }>;
}) {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);

  try {
    const projection = readDeliveryCenter(getDb(), session, {
      workspaceSlug: workspace,
      eventId,
    });
    return <DeliveryCenter projection={projection} />;
  } catch (error) {
    if (
      error instanceof DeliveryCenterAuthorizationError ||
      error instanceof DeliveryCenterNotFoundError
    ) notFound();
    throw error;
  }
}
