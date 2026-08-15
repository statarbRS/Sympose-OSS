import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ReturnerLens } from "@/components/institutional-memory/returner-lens";
import { getDb } from "@/server/db";
import { queryReturnerLens, ReturnerLensError } from "@/server/services/returner-lens";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";
import { WorkspaceMemorySurface } from "../events/[eventId]/_components/product-surface";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Institutional Memory · Sympose MVP" };

export default async function MemoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const query = await searchParams;
  const requestedPerson = typeof query.person === "string" ? query.person : undefined;
  let result;
  try {
    result = queryReturnerLens(getDb(), session, {
      workspaceSlug: workspace,
      ...(requestedPerson === undefined ? {} : { personId: requestedPerson }),
    });
  } catch (error) {
    if (error instanceof ReturnerLensError &&
      (error.code === "INPUT_INVALID" || error.code === "TARGET_UNAVAILABLE" || error.code === "AUTHORIZATION_DENIED")) {
      notFound();
    }
    throw error;
  }
  return <WorkspaceMemorySurface workspace={workspace} workspaceName={session.workspaceName}>
    <ReturnerLens result={result} />
  </WorkspaceMemorySurface>;
}
