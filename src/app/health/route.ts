import { runtimeConfigurationReady, runtimeModeState } from "@/server/runtime-mode";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function GET(): Response {
  const configuredSha = process.env.SYMPOSE_BUILD_SHA?.trim().toLowerCase() ?? "";
  const buildBound = SHA_PATTERN.test(configuredSha);
  const mode = runtimeModeState();
  const configured = runtimeConfigurationReady();
  let databaseReady = mode !== "production";
  if (mode === "production" && configured) {
    try {
      // Production readiness must prove the configured database opens, migrates, validates, and
      // is bound to production. Environment syntax alone is not readiness.
      getDb();
      databaseReady = true;
    } catch {
      databaseReady = false;
    }
  }
  const healthy = buildBound && configured && databaseReady;
  const buildSha = buildBound ? configuredSha : "unbound";

  return Response.json(
    {
      status: healthy ? "ok" : "error",
      buildSha,
      dataMode: mode,
    },
    {
      status: healthy ? 200 : 503,
      headers: {
        "cache-control": "no-store, max-age=0",
      },
    },
  );
}
