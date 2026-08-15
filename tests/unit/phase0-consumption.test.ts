import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import manifest from "../fixtures/phase0-consumption-manifest.json";
import { DDL } from "../../src/server/schema";

const expectedPhase0Files = [
  "src/app/globals.css",
  "src/app/layout.tsx",
  "src/app/p/[token]/page.tsx",
  "src/app/page.tsx",
  "src/app/w/[workspace]/dashboard/page.tsx",
  "src/app/w/[workspace]/events/[eventId]/plan/page.tsx",
  "src/app/w/[workspace]/layout.tsx",
  "src/app/w/[workspace]/people/[personId]/page.tsx",
  "src/app/w/[workspace]/shell.css",
  "src/components/action-card.tsx",
  "src/components/login-form.tsx",
  "src/components/truth.tsx",
  "src/components/workspace-dashboard.tsx",
  "src/server/actions.ts",
  "src/server/adapters/compiler.ts",
  "src/server/adapters/delivery-adapter.ts",
  "src/server/adapters/source-adapter.ts",
  "src/server/auth.ts",
  "src/server/canonical.ts",
  "src/server/db.ts",
  "src/server/schema.ts",
  "src/server/seed.ts",
  "src/server/services/audit.ts",
  "src/server/services/cohorts.ts",
  "src/server/services/commitments.ts",
  "src/server/services/events.ts",
  "src/server/services/outcomes.ts",
  "src/server/services/planning.ts",
  "src/server/services/publication.ts",
  "src/server/services/queries.ts",
  "src/server/services/sources.ts",
  "src/server/workspace-session.ts",
].sort();

const expectedRoutes = [
  "/",
  "/p/[token]",
  "/w/[workspace]/dashboard",
  "/w/[workspace]/events/[eventId]/plan",
  "/w/[workspace]/people/[personId]",
].sort();

const expectedPhase0SchemaObjects = [
  "accounts",
  "approvals",
  "audit_events",
  "cohort_definitions",
  "cohort_snapshot_members",
  "cohort_snapshots",
  "commitment_offers",
  "commitment_responses",
  "events",
  "meta",
  "observations",
  "people",
  "personal_agendas",
  "plan_assignments",
  "plan_runs",
  "plan_states",
  "plan_versions",
  "portal_tokens",
  "program_units",
  "publication_releases",
  "sessions",
  "source_links",
  "source_records",
  "workspaces",
].sort();

describe("Phase 0 consumption manifest", () => {
  it("names every Phase 0 surface and schema table with executable evidence", () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.scope).toBe("phase0-executable-golden-path");

    expect(manifest.evidence).toEqual({
      domain: "tests/unit/mvp-domain.test.ts",
      actions: "tests/unit/action-errors.test.ts",
      auth: "tests/unit/login-rejection.test.ts",
      routes: "tests/unit/organizer-route-auth.test.ts",
      browser: "tests/e2e/golden-path.spec.ts",
      manifest: "tests/unit/phase0-consumption.test.ts",
    });
    expect(Object.values(manifest.evidence).every((path) => path.startsWith("tests/"))).toBe(true);

    const evidenceNames = new Set(Object.keys(manifest.evidence));
    for (const evidencePath of Object.values(manifest.evidence)) {
      expect(existsSync(resolve(evidencePath))).toBe(true);
    }

    const surfacePaths = manifest.surfaces.map((surface) => surface.path).sort();
    expect(new Set(surfacePaths).size).toBe(surfacePaths.length);
    expect(surfacePaths).toEqual(expectedPhase0Files);
    for (const surface of manifest.surfaces) {
      expect(surface.status).toBe("consumed");
      expect(existsSync(resolve(surface.path))).toBe(true);
      expect(surface.evidence.length).toBeGreaterThan(0);
      expect(surface.evidence.every((name) => evidenceNames.has(name))).toBe(true);
    }

    expect(
      manifest.surfaces
        .filter((surface) => surface.kind === "route")
        .map((surface) => surface.route)
        .sort(),
    ).toEqual(expectedRoutes);
    expect(
      manifest.surfaces
        .filter((surface) => surface.kind === "adapter")
        .map((surface) => surface.path)
        .sort(),
    ).toEqual([
      "src/server/adapters/compiler.ts",
      "src/server/adapters/delivery-adapter.ts",
      "src/server/adapters/source-adapter.ts",
    ]);

    const ddlTables = [...DDL.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)]
      .map((match) => match[1])
      .sort();
    const manifestTables = manifest.schemaObjects.map((object) => object.name).sort();
    expect(new Set(manifestTables).size).toBe(manifestTables.length);
    expect(manifestTables).toEqual(expectedPhase0SchemaObjects);
    expect(manifestTables.every((name) => ddlTables.includes(name))).toBe(true);
    for (const object of manifest.schemaObjects) {
      expect(object.status).toBe("consumed");
      expect(object.evidence.length).toBeGreaterThan(0);
      expect(object.evidence.every((name) => evidenceNames.has(name))).toBe(true);
    }
  });
});
