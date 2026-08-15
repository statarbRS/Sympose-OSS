import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";

import { ConnectorHub } from "@/components/connector-hub/connector-hub";
import { getDb } from "@/server/db";
import {
  getConnectorHubView,
  getConnectorImportPreview,
  listConnectorRuns,
  type ConnectorProviderId,
} from "@/server/services/connector-hub";
import { connectorExecutionAvailability } from "@/server/services/connector-hub/execution-runtime";
import {
  getRouteSession,
  requireConnectorWorkspaceRoute,
} from "@/server/workspace-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connector Hub · Sympose MVP",
  description: "Truthful workspace connector status and an Airtable-compatible People export.",
};

export default async function ConnectorHubPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  requireConnectorWorkspaceRoute(session, workspace);

  const db = getDb();
  const view = getConnectorHubView(db, session, workspace);
  if (!view) notFound();
  const runs = listConnectorRuns(db, session, workspace, 30);
  const previews = Object.fromEntries(
    (["airtable", "hubspot", "salesforce"] as const).map((provider) => {
      const latest = runs.find((run) => run.provider === provider && run.operation === "IMPORT");
      return [provider, latest ? getConnectorImportPreview(db, session, workspace, latest.id) : null];
    }),
  ) as Record<ConnectorProviderId, ReturnType<typeof getConnectorImportPreview>>;
  const execution = connectorExecutionAvailability();
  return (
    <ConnectorHub
      view={view}
      runs={runs}
      previews={previews}
      executionTransport={execution.enabled ? execution.transport : null}
      operationKeySeed={randomUUID()}
    />
  );
}
