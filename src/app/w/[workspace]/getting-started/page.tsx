import type { Metadata } from "next";

import { GettingStarted } from "@/components/onboarding/getting-started";
import { getDb } from "@/server/db";
import { getDashboardState } from "@/server/services/queries";
import {
  getRouteSession,
  requireOrganizerWorkspaceRoute,
} from "@/server/workspace-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Getting started · Sympose MVP",
  description:
    "A server-derived guide to the first Sympose event workflow and its separate truth records.",
};

export default async function GettingStartedPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);

  const state = getDashboardState(getDb(), session.workspaceId, []);

  return (
    <GettingStarted
      state={state}
      workspaceName={session.workspaceName}
      workspaceSlug={session.workspaceSlug}
    />
  );
}
