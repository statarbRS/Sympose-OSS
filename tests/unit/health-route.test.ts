import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/health/route";
import { closeDb, getDb } from "@/server/db";

const originalBuildSha = process.env.SYMPOSE_BUILD_SHA;

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalBuildSha === undefined) {
    delete process.env.SYMPOSE_BUILD_SHA;
  } else {
    process.env.SYMPOSE_BUILD_SHA = originalBuildSha;
  }
});

describe("health route", () => {
  it("reports a validated exact build SHA without exposing other environment values", async () => {
    process.env.SYMPOSE_BUILD_SHA = "3A816109908682B47D52A91931D1012451637047";

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({
      status: "ok",
      buildSha: "3a816109908682b47d52a91931d1012451637047",
      dataMode: "synthetic-evaluator",
    });
  });

  it("opens and validates production storage instead of treating environment syntax as readiness", async () => {
    const directory = mkdtempSync("/tmp/sympose-health-production-");
    const databasePath = join(directory, "database", "production.sqlite");
    try {
      process.env.SYMPOSE_BUILD_SHA = "3A816109908682B47D52A91931D1012451637047";
      vi.stubEnv("SYMPOSE_DATA_MODE", "production");
      vi.stubEnv("SYMPOSE_PRODUCTION_DB_PATH", databasePath);
      vi.stubEnv("SYMPOSE_PRODUCTION_ARTIFACT_STORE_ROOT", join(directory, "artifacts"));
      vi.stubEnv("SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN", "health-route-bootstrap-token-00000000000000000000");
      vi.stubEnv("SYMPOSE_PRODUCTION_BOOTSTRAP_ISSUED_AT", new Date(Date.now() - 1_000).toISOString());

      const ready = GET();
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({
        status: "ok",
        buildSha: "3a816109908682b47d52a91931d1012451637047",
        dataMode: "production",
      });
      closeDb(getDb());

      const malformedPath = join(directory, "database", "malformed.sqlite");
      writeFileSync(malformedPath, "not a sqlite database", { mode: 0o600 });
      vi.stubEnv("SYMPOSE_PRODUCTION_DB_PATH", malformedPath);
      const rejected = GET();
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toMatchObject({ status: "error", dataMode: "production" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed with a non-OK response for malformed or absent values", async () => {
    process.env.SYMPOSE_BUILD_SHA = "not-a-sha";
    const malformed = GET();
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toMatchObject({ status: "error", buildSha: "unbound" });

    delete process.env.SYMPOSE_BUILD_SHA;
    const absent = GET();
    expect(absent.status).toBe(503);
    expect(await absent.json()).toMatchObject({ status: "error", buildSha: "unbound" });
  });
});
