import type { Db } from "../db";
import { SimulatedFixtureSourceAdapter, type ImportResult } from "../adapters/source-adapter";
import { fixtureForWorkspace } from "../seed";
import { withTransaction } from "../db";

export function importFixtureEvidence(db: Db, workspaceId: string, workspaceSlug: string): ImportResult {
  const workspace = db
    .prepare("SELECT slug FROM workspaces WHERE id = ?")
    .get(workspaceId) as { slug: string } | undefined;
  if (!workspace || workspace.slug !== workspaceSlug) {
    throw new Error("FIXTURE_WORKSPACE_MISMATCH: fixture selection must match the server workspace.");
  }
  return withTransaction(db, () => {
    const adapter = new SimulatedFixtureSourceAdapter(db);
    return adapter.importManifest(workspaceId, fixtureForWorkspace(workspaceSlug));
  });
}
