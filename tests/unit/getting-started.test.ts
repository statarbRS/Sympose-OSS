import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "@/server/auth";
import type { DashboardState } from "@/server/services/queries";

const mocks = vi.hoisted(() => ({
  db: { kind: "getting-started-test-db" },
  getDb: vi.fn(),
  getDashboardState: vi.fn(),
  getRouteSession: vi.fn(),
  requireOrganizerWorkspaceRoute: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  redirect: vi.fn(() => {
    throw new Error("__REDIRECT__");
  }),
}));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/services/queries", async () => {
  const actual = await vi.importActual<typeof import("@/server/services/queries")>("@/server/services/queries");
  return { ...actual, getDashboardState: mocks.getDashboardState };
});
vi.mock("@/server/workspace-session", async () => {
  const actual = await vi.importActual<typeof import("@/server/workspace-session")>("@/server/workspace-session");
  mocks.requireOrganizerWorkspaceRoute.mockImplementation(actual.requireOrganizerWorkspaceRoute);
  return {
    ...actual,
    getRouteSession: mocks.getRouteSession,
    requireOrganizerWorkspaceRoute: mocks.requireOrganizerWorkspaceRoute,
  };
});

import GettingStartedPage from "@/app/w/[workspace]/getting-started/page";
import { GettingStarted } from "@/components/onboarding/getting-started";

const SESSION: SessionInfo = {
  id: "session-a",
  tokenHash: "session-hash-a",
  accountId: "account-a",
  workspaceId: "workspace-a",
  expiresAt: "2099-01-01T00:00:00.000Z",
  email: "organizer@example.test",
  displayName: "Organizer A",
  role: "organizer",
  workspaceSlug: "northstar",
  workspaceName: "Northstar Events",
};

function dashboardState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    people: [],
    sourceRecordCount: 0,
    snapshot: null,
    snapshotPersonIds: [],
    event: { event: null, units: [] },
    candidatePlan: null,
    currentPlan: null,
    planDetailView: null,
    approvals: [],
    offers: [],
    release: null,
    tokens: [],
    observations: [],
    audit: [],
    otherWorkspaceSlugs: [],
    ...overrides,
  };
}

function completeState(): DashboardState {
  return dashboardState({
    people: [{
      id: "person-private",
      canonicalEmail: "private-person@example.test",
      fullName: "Private Person Name",
      organization: "Private Organization",
      title: "Director",
      sourceCount: 1,
    }],
    sourceRecordCount: 1,
    snapshot: {
      id: "snapshot-1",
      fingerprint: "snapshot-fingerprint",
      memberCount: 1,
      asOf: "2026-08-13T00:00:00.000Z",
      createdAt: "2026-08-13T00:00:00.000Z",
    },
    snapshotPersonIds: ["person-private"],
    event: {
      event: {
        id: "event-1",
        name: "Northstar Summit",
        timezone: "Europe/Berlin",
        startsAt: "2026-09-01T09:00:00.000Z",
        endsAt: "2026-09-02T17:00:00.000Z",
        lifecycle: "planning",
        currentPlanVersionId: "plan-1",
        currentReleaseId: "release-1",
        createdAt: "2026-08-13T00:00:00.000Z",
      },
      units: [],
    },
    currentPlan: {
      id: "plan-1",
      runId: "run-1",
      versionNumber: 1,
      fingerprint: "plan-fingerprint",
      assignmentCount: 1,
      runStatus: "FEASIBLE",
      status: "approved",
      createdAt: "2026-08-13T00:00:00.000Z",
      eventId: "event-1",
    },
    approvals: [{ planVersionId: "plan-1", createdAt: "2026-08-13T01:00:00.000Z" }],
    offers: [{
      id: "offer-1",
      eventId: "event-1",
      planVersionId: "plan-1",
      personId: "person-private",
      termsJson: "{}",
      termsFingerprint: "terms-fingerprint",
      status: "offered",
      createdAt: "2026-08-13T01:30:00.000Z",
      personName: "Private Person Name",
      email: "private-person@example.test",
      response: "accepted",
      respondedAt: "2026-08-13T02:00:00.000Z",
      acceptCommandKey: "accept-key",
      declineCommandKey: "decline-key",
    }],
    release: {
      id: "release-1",
      fingerprint: "release-fingerprint",
      sealedAt: "2026-08-13T02:30:00.000Z",
      planVersionId: "plan-1",
      commitmentWatermark: 1,
    },
    observations: [{
      id: "observation-1",
      eventId: "event-1",
      personId: "person-private",
      programUnitId: "unit-1",
      programUnitName: "Opening session",
      observationType: "attendance",
      observedAt: "2026-09-01T09:00:00.000Z",
      recordedAt: "2026-09-01T09:00:01.000Z",
      source: "manual",
      idempotencyKey: "observation-key",
    }],
  });
}

function renderGettingStarted(state: DashboardState): string {
  return renderToStaticMarkup(createElement(GettingStarted, {
    state,
    workspaceName: "Northstar Events",
    workspaceSlug: "northstar",
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRouteSession.mockResolvedValue(SESSION);
  mocks.getDb.mockReturnValue(mocks.db);
  mocks.getDashboardState.mockReturnValue(dashboardState());
});

describe("getting-started projection", () => {
  it("derives all progress from server evidence without rendering person-level fields", () => {
    const html = renderGettingStarted(completeState());

    expect(html).toContain('data-testid="getting-started"');
    expect(html).toContain("8 of 8");
    expect(html.match(/data-setup-state="complete"/g)).toHaveLength(8);
    expect(html).toContain("All eight checkpoints have matching server evidence.");
    expect(html).toContain("Candidate truth");
    expect(html).toContain("Decision truth");
    expect(html).toContain("Commitment truth");
    expect(html).toContain("Operational truth");
    expect(html).toContain("not a fifth truth layer");
    expect(html).toContain("Event evidence shown for Northstar Summit");
    expect(html).toContain("legacy dashboard event projection");
    expect(html).not.toContain("Private Person Name");
    expect(html).not.toContain("private-person@example.test");
    expect(html).not.toContain("Private Organization");
  });

  it("keeps missing and partial evidence explicit and chooses only the first gap as next", () => {
    const emptyHtml = renderGettingStarted(dashboardState());
    expect(emptyHtml).toContain("0 of 8");
    expect(emptyHtml.match(/data-setup-state="current"/g)).toHaveLength(1);
    expect(emptyHtml.match(/data-setup-state="waiting"/g)).toHaveLength(7);
    expect(emptyHtml).toContain("No canonical people or source records are projected yet.");
    expect(emptyHtml).toContain("No dashboard event is projected");
    expect(emptyHtml).toContain("does not mark them complete");

    const partialHtml = renderGettingStarted(dashboardState({
      people: [{
        id: "manual-person",
        canonicalEmail: "manual@example.test",
        fullName: "Manual Person",
        organization: null,
        title: null,
        sourceCount: 0,
      }],
    }));
    expect(partialHtml).toContain("1 of 8");
    expect(partialHtml).toContain("1 canonical person · no source records in this projection");
    expect(partialHtml).not.toContain("Manual Person");
    expect(partialHtml).not.toContain("manual@example.test");
  });

  it("keeps an unapproved candidate separate from organizer decision evidence", () => {
    const html = renderGettingStarted(dashboardState({
      candidatePlan: {
        id: "candidate-2",
        runId: "run-2",
        versionNumber: 2,
        fingerprint: "candidate-fingerprint",
        assignmentCount: 4,
        runStatus: "FEASIBLE",
        status: "candidate",
        createdAt: "2026-08-13T00:00:00.000Z",
        eventId: "event-1",
      },
    }));

    expect(html).toContain("Candidate v2 · 4 assignments");
    expect(html).toContain("Candidate v2 is available; no approval is projected for it.");
    expect(html).not.toContain("Approval record found");
  });

  it("uses only existing workspace and event destinations with no placeholder links", () => {
    const html = renderGettingStarted(completeState());
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    const allowed = new Set([
      "/w/northstar/dashboard",
      "/w/northstar/crm",
      "/w/northstar/events",
      "/w/northstar/events/event-1/plan",
      "/w/northstar/events/event-1/speakers",
      "/w/northstar/events/event-1/publication",
      "/w/northstar/events/event-1/operations",
    ]);

    expect(hrefs.length).toBeGreaterThan(8);
    for (const href of hrefs) expect(allowed.has(href)).toBe(true);
    expect(html).not.toContain('href="#');
    expect(html).not.toContain("/cohorts");
  });

  it("keeps the implementation server-derived, focus-visible, and explicitly reflowed at 390px", () => {
    const component = readFileSync(resolve("src/components/onboarding/getting-started.tsx"), "utf8");
    const styles = readFileSync(resolve("src/components/onboarding/getting-started.module.css"), "utf8");

    expect(component).not.toContain('"use client"');
    expect(component).not.toMatch(/localStorage|sessionStorage|document\.cookie/u);
    expect(component).toContain("Status comes only from the loaded projection");
    expect(styles).toContain(".page a:focus-visible");
    expect(styles).toContain("min-height: 44px");
    expect(styles).toContain("@media (max-width: 390px)");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).toContain("@media (forced-colors: active)");
  });
});

describe("getting-started route authorization", () => {
  it("authorizes User A before reading only User A's dashboard projection", async () => {
    const state = dashboardState();
    mocks.getDashboardState.mockReturnValue(state);

    const element = await GettingStartedPage({
      params: Promise.resolve({ workspace: "northstar" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Northstar Events");
    expect(mocks.requireOrganizerWorkspaceRoute).toHaveBeenCalledWith(SESSION, "northstar");
    expect(mocks.requireOrganizerWorkspaceRoute.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getDb.mock.invocationCallOrder[0]!,
    );
    expect(mocks.getDashboardState).toHaveBeenCalledWith(mocks.db, SESSION.workspaceId, []);
  });

  it("denies User B's workspace slug before opening the database", async () => {
    await expect(GettingStartedPage({
      params: Promise.resolve({ workspace: "foreign-workspace" }),
    })).rejects.toThrow("__NOT_FOUND__");

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getDashboardState).not.toHaveBeenCalled();
  });

  it("denies an unprivileged role before opening the database", async () => {
    mocks.getRouteSession.mockResolvedValue({ ...SESSION, role: "reviewer" });

    await expect(GettingStartedPage({
      params: Promise.resolve({ workspace: "northstar" }),
    })).rejects.toThrow("__NOT_FOUND__");

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getDashboardState).not.toHaveBeenCalled();
  });

  it("does not read data when session resolution fails", async () => {
    mocks.getRouteSession.mockRejectedValue(new Error("__UNAUTHENTICATED__"));

    await expect(GettingStartedPage({
      params: Promise.resolve({ workspace: "northstar" }),
    })).rejects.toThrow("__UNAUTHENTICATED__");

    expect(mocks.requireOrganizerWorkspaceRoute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getDashboardState).not.toHaveBeenCalled();
  });
});
