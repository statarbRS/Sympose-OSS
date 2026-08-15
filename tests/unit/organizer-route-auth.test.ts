import * as authModule from "@/server/auth";
import type { SessionInfo } from "@/server/auth";
import DashboardPage from "@/app/w/[workspace]/dashboard/page";
import EventsPage from "@/app/w/[workspace]/events/page";
import PlanPage from "@/app/w/[workspace]/events/[eventId]/plan/page";
import PersonPage from "@/app/w/[workspace]/people/[personId]/page";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
} from "../../src/server/evaluator-compatibility";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_WORKSPACE_ID,
} from "../../src/server/evaluator-demo";

/**
 * Repair Contract R1 §2.3 forbids an auth-only workspace/read shortcut: authentication is
 * never a substitute for organizer capability plus workspace authorization, which the route
 * tests below prove happens in `requireOrganizerWorkspaceRoute` before any DB or domain read.
 * This augmentation redeclares both removed names, so `tsc` fails with a duplicate identifier
 * if the function or the `WorkspaceContext` type export is ever reintroduced.
 */
declare module "@/server/auth" {
  type WorkspaceContext = never;
  const requireWorkspaceContext: never;
}

const mocks = vi.hoisted(() => {
  const inertDb = {};
  const sessionState: { current: SessionInfo | null } = { current: null };

  const getRouteSession = vi.fn(async () => {
    if (!sessionState.current) {
      throw new Error("test session not configured");
    }
    return sessionState.current;
  });

  return {
    inertDb,
    sessionState,
    getRouteSession,
    getDb: vi.fn(() => inertDb),
    getDashboardState: vi.fn(() => ({} as unknown)),
    getPersonDetail: vi.fn(() => null as unknown),
    listLoginChoices: vi.fn(() => [] as unknown[]),
    listEvents: vi.fn(() => [] as unknown[]),
    getEvent: vi.fn(() => null as unknown),
    candidatePlanVersion: vi.fn(() => null as unknown),
    currentPlanVersion: vi.fn(() => null as unknown),
    planDetail: vi.fn(() => null as unknown),
    getProgramCapacitySurfaceProjection: vi.fn(() => ({} as unknown)),
    readCanonicalScheduleProjection: vi.fn(() => null as unknown),
    buildCapacityFlightDeckProjection: vi.fn(() => ({} as unknown)),
    listOtherWorkspaceSlugs: vi.fn(() => [] as string[]),
    personRelationshipHistory: vi.fn((_props: unknown) => null),
  };
});

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  redirect: vi.fn(() => {
    throw new Error("__REDIRECT__");
  }),
}));

vi.mock("@/server/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/server/services/queries", () => ({
  getDashboardState: mocks.getDashboardState,
  getPersonDetail: mocks.getPersonDetail,
  listLoginChoices: mocks.listLoginChoices,
}));

vi.mock("@/server/services/events", () => ({
  listEvents: mocks.listEvents,
  getEvent: mocks.getEvent,
}));

vi.mock("@/server/services/planning", () => ({
  candidatePlanVersion: mocks.candidatePlanVersion,
  currentPlanVersion: mocks.currentPlanVersion,
  planDetail: mocks.planDetail,
}));

vi.mock("@/server/services/program-capacity", () => ({
  getProgramCapacitySurfaceProjection: mocks.getProgramCapacitySurfaceProjection,
}));

vi.mock("@/server/services/scheduling", () => ({
  readCanonicalScheduleProjection: mocks.readCanonicalScheduleProjection,
}));

vi.mock("@/server/services/capacity-flight-deck", () => ({
  buildCapacityFlightDeckProjection: mocks.buildCapacityFlightDeckProjection,
}));

vi.mock("@/server/workspace-session", async () => {
  const actual = await vi.importActual<typeof import("@/server/workspace-session")>(
    "@/server/workspace-session",
  );
  return {
    ...actual,
    getRouteSession: mocks.getRouteSession,
    listOtherWorkspaceSlugs: mocks.listOtherWorkspaceSlugs,
  };
});

vi.mock("@/components/workspace-dashboard", () => ({
  WorkspaceDashboard: () => null,
}));

vi.mock("@/components/person-history/person-relationship-history", () => ({
  PersonRelationshipHistory: mocks.personRelationshipHistory,
}));

function sessionFor(
  role: string,
  workspaceSlug = "northstar",
  workspaceId = workspaceSlug === "acme"
    ? EVALUATOR_WORKSPACE_ID
    : workspaceSlug === "devflow"
      ? EVALUATOR_COMPATIBILITY_WORKSPACE_ID
      : "workspace-1",
): SessionInfo {
  return {
    id: "session-1",
    tokenHash: "token-hash",
    accountId: "account-1",
    workspaceId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: "organizer@example.test",
    displayName: "Test User",
    role,
    workspaceSlug,
    workspaceName: workspaceSlug === "devflow" ? "DevFlow Conf 2027" : "Northstar",
  };
}

function planDetailFixture(id: string, versionNumber: number, status: string) {
  return {
    version: {
      versionNumber,
      fingerprint: "fingerprint-" + id,
      status,
    },
    content: {
      versionNumber,
      snapshotFingerprint: "snapshot-" + id,
      assignments: [],
      exclusions: [],
      diagnostics: {
        messages: [],
        unitCounts: {},
        moderatorsWithoutUnit: [],
      },
    },
    assignmentsJoined: [],
    run: {
      id: "run-" + id,
      status: "FEASIBLE",
      inputFingerprint: "input-" + id,
      compiler: "fixture",
      compilerVersion: "1",
      createdAt: "2026-08-12T09:00:00.000Z",
    },
    approvals: status === "approved" ? [{ id: "approval-" + id }] : [],
    states: [{ state: status, createdAt: "2026-08-12T09:00:00.000Z", reason: null }],
  };
}

async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow("__NOT_FOUND__");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue(mocks.inertDb);
  mocks.getDashboardState.mockReturnValue({});
  mocks.getPersonDetail.mockReturnValue(null);
  mocks.listLoginChoices.mockReturnValue([]);
  mocks.listEvents.mockReturnValue([]);
  mocks.getEvent.mockReturnValue(null);
  mocks.candidatePlanVersion.mockReturnValue(null);
  mocks.currentPlanVersion.mockReturnValue(null);
  mocks.planDetail.mockReturnValue(null);
  mocks.getProgramCapacitySurfaceProjection.mockReturnValue({});
  mocks.readCanonicalScheduleProjection.mockReturnValue(null);
  mocks.buildCapacityFlightDeckProjection.mockReturnValue({});
  mocks.listOtherWorkspaceSlugs.mockReturnValue([]);
  mocks.sessionState.current = sessionFor("organizer");
});

describe("auth export surface", () => {
  it("exposes no auth-only workspace-context shortcut", () => {
    const exported = Object.keys(authModule);

    expect(exported).not.toContain("requireWorkspaceContext");
    expect("requireWorkspaceContext" in authModule).toBe(false);
    expect(
      (authModule as Record<string, unknown>).requireWorkspaceContext,
    ).toBeUndefined();
    expect(exported.filter((name) => /workspacecontext/i.test(name))).toEqual([]);
    expect(exported).toContain("assertWorkspaceMatch");
    expect(exported).toContain("requireCapability");
  });
});

describe.each([["reviewer"], ["read_only"], ["communications_manager"]])(
  "%s is denied before dashboard, plan, and person reads",
  (role) => {
    beforeEach(() => {
      mocks.sessionState.current = sessionFor(role);
    });

    it("denies the dashboard before its domain queries", async () => {
      await expectNotFound(
        DashboardPage({ params: Promise.resolve({ workspace: "northstar" }) }),
      );
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.getDashboardState).not.toHaveBeenCalled();
      expect(mocks.listOtherWorkspaceSlugs).not.toHaveBeenCalled();
    });

    it("denies the plan before its domain queries", async () => {
      await expectNotFound(
        PlanPage({
          params: Promise.resolve({ workspace: "northstar", eventId: "event-1" }),
        }),
      );
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.getEvent).not.toHaveBeenCalled();
      expect(mocks.candidatePlanVersion).not.toHaveBeenCalled();
      expect(mocks.currentPlanVersion).not.toHaveBeenCalled();
      expect(mocks.planDetail).not.toHaveBeenCalled();
      expect(mocks.getProgramCapacitySurfaceProjection).not.toHaveBeenCalled();
      expect(mocks.readCanonicalScheduleProjection).not.toHaveBeenCalled();
      expect(mocks.buildCapacityFlightDeckProjection).not.toHaveBeenCalled();
    });

    it("denies the event portfolio before its domain query", async () => {
      await expectNotFound(
        EventsPage({ params: Promise.resolve({ workspace: "northstar" }) }),
      );
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.listEvents).not.toHaveBeenCalled();
    });

    it("denies the person page before its domain query", async () => {
      await expectNotFound(
        PersonPage({
          params: Promise.resolve({ workspace: "northstar", personId: "person-1" }),
        }),
      );
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.getPersonDetail).not.toHaveBeenCalled();
    });
  },
);

describe("organizer page sanity", () => {
  beforeEach(() => {
    mocks.sessionState.current = sessionFor("organizer");
  });

  it("loads the dashboard with the session workspace and alternate slugs", async () => {
    const state = { events: [] };
    mocks.getDashboardState.mockReturnValue(state);

    const element = await DashboardPage({
      params: Promise.resolve({ workspace: "northstar" }),
    });

    expect(isValidElement(element)).toBe(true);
    expect(mocks.getDashboardState).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      [],
    );
    expect(mocks.getDb).toHaveBeenCalledTimes(1);
  });

  it("loads both plan summaries after the event lookup and accepts an empty plan summary", async () => {
    const event = { id: "event-1", name: "Northstar Summit" };
    mocks.getEvent.mockReturnValue(event);
    mocks.candidatePlanVersion.mockReturnValue(null);
    mocks.currentPlanVersion.mockReturnValue(null);

    const element = await PlanPage({
      params: Promise.resolve({ workspace: "northstar", eventId: "event-1" }),
    });

    expect(isValidElement(element)).toBe(true);
    expect(mocks.getEvent).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      "event-1",
    );
    expect(mocks.candidatePlanVersion).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      "event-1",
    );
    expect(mocks.currentPlanVersion).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      "event-1",
    );
    expect(mocks.planDetail).not.toHaveBeenCalled();
    expect(mocks.getProgramCapacitySurfaceProjection).toHaveBeenCalledWith(
      mocks.inertDb,
      mocks.sessionState.current,
      "event-1",
    );
    expect(mocks.readCanonicalScheduleProjection).toHaveBeenCalledWith(
      mocks.inertDb,
      { workspaceId: "workspace-1", eventId: "event-1" },
      event,
    );
    expect(mocks.buildCapacityFlightDeckProjection).toHaveBeenCalledWith({
      capacity: {},
      acceptedSchedule: null,
      plan: null,
    });
    expect(mocks.getDb).toHaveBeenCalledTimes(1);
  });

  it("prefers an unapproved candidate and separately loads the approved comparison record", async () => {
    const event = { id: "event-1", name: "Northstar Summit" };
    const candidateSummary = { id: "plan-candidate", versionNumber: 2 };
    const approvedSummary = { id: "plan-approved", versionNumber: 1 };
    const candidateDetail = planDetailFixture("plan-candidate", 2, "candidate");
    const approvedDetail = planDetailFixture("plan-approved", 1, "approved");
    mocks.getEvent.mockReturnValue(event);
    mocks.candidatePlanVersion.mockReturnValue(candidateSummary);
    mocks.currentPlanVersion.mockReturnValue(approvedSummary);
    mocks.planDetail.mockImplementation((...args: unknown[]) => {
      const planVersionId = args[3];
      return planVersionId === candidateSummary.id ? candidateDetail : approvedDetail;
    });

    const element = await PlanPage({
      params: Promise.resolve({ workspace: "northstar", eventId: "event-1" }),
    });

    expect(mocks.candidatePlanVersion).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      "event-1",
    );
    expect(mocks.currentPlanVersion).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      "event-1",
    );
    expect(mocks.planDetail).toHaveBeenNthCalledWith(
      1,
      mocks.inertDb,
      "workspace-1",
      "event-1",
      "plan-candidate",
    );
    expect(mocks.planDetail).toHaveBeenNthCalledWith(
      2,
      mocks.inertDb,
      "workspace-1",
      "event-1",
      "plan-approved",
    );
    expect(isValidElement(element)).toBe(true);
    const studio = (element.props as { children: { props: Record<string, unknown> } }).children;
    expect(studio.props.detail).toEqual(expect.objectContaining({
      version: expect.objectContaining({ versionNumber: 2, status: "candidate" }),
    }));
    expect(studio.props.approvedDetail).toEqual(expect.objectContaining({
      version: expect.objectContaining({ versionNumber: 1, status: "approved" }),
    }));
  });

  it("falls back to the approved current record without a comparison detail", async () => {
    const event = { id: "event-1", name: "Northstar Summit" };
    const approvedSummary = { id: "plan-approved", versionNumber: 1 };
    const approvedDetail = planDetailFixture("plan-approved", 1, "approved");
    mocks.getEvent.mockReturnValue(event);
    mocks.candidatePlanVersion.mockReturnValue(null);
    mocks.currentPlanVersion.mockReturnValue(approvedSummary);
    mocks.planDetail.mockReturnValue(approvedDetail);

    const element = await PlanPage({
      params: Promise.resolve({ workspace: "northstar", eventId: "event-1" }),
    });

    expect(mocks.planDetail).toHaveBeenCalledTimes(1);
    expect(mocks.planDetail).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      "event-1",
      "plan-approved",
    );
    expect(isValidElement(element)).toBe(true);
    const studio = (element.props as { children: { props: Record<string, unknown> } }).children;
    expect(studio.props.detail).toEqual(expect.objectContaining({
      version: expect.objectContaining({ versionNumber: 1, status: "approved" }),
    }));
    expect(studio.props.approvedDetail).toBe(null);
  });

  it("lists every event using the authenticated workspace id", async () => {
    mocks.listEvents.mockReturnValue([
      {
        id: "event-1",
        name: "Northstar Summit",
        timezone: "UTC",
        startsAt: "2026-09-15T09:00:00.000Z",
        endsAt: "2026-09-15T13:00:00.000Z",
        lifecycle: "planning",
        currentPlanVersionId: null,
        currentReleaseId: null,
        createdAt: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "event-2",
        name: "Northstar Workshop",
        timezone: "UTC",
        startsAt: "2026-10-15T09:00:00.000Z",
        endsAt: "2026-10-15T13:00:00.000Z",
        lifecycle: "draft",
        currentPlanVersionId: null,
        currentReleaseId: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    ]);

    const element = await EventsPage({
      params: Promise.resolve({ workspace: "northstar" }),
    });

    expect(isValidElement(element)).toBe(true);
    expect(mocks.listEvents).toHaveBeenCalledWith(mocks.inertDb, "workspace-1");
    expect(mocks.getDb).toHaveBeenCalledTimes(1);
  });

  it("loads person provenance from the session workspace", async () => {
    const personId = "12345678-1234-4567-89ab-abcdef123456";
    const detail = {
      person: {
        id: personId,
        fullName: "Ada Lovelace",
        canonicalEmail: "ada@example.test",
        organization: null,
        title: null,
        sourceCount: 0,
      },
      sources: [],
      ledgers: [],
    };
    mocks.getPersonDetail.mockReturnValue(detail);

    const element = await PersonPage({
      params: Promise.resolve({ workspace: "northstar", personId }),
    });
    const html = renderToStaticMarkup(createElement(() => element));
    const headerStart = html.indexOf("<header");
    const headerEnd = html.indexOf("</header>", headerStart);
    const header = html.slice(headerStart, headerEnd + "</header>".length);

    expect(isValidElement(element)).toBe(true);
    expect(header).not.toContain(personId);
    expect(header).toContain("Person reference");
    expect(header).toContain("12345678…123456");
    expect(header).toContain("Display reference only");
    expect(html).toContain('data-testid="person-full-identifier"');
    expect(html).toContain("Full immutable person identifier");
    expect(html).toContain("Canonical authority uses the full workspace-scoped identifier.");
    expect(html).toContain(`<code>${personId}</code>`);
    expect(mocks.getPersonDetail).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      personId,
    );
    expect(mocks.personRelationshipHistory.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      db: mocks.inertDb,
      personId,
      workspaceSlug: "northstar",
    }));
    expect(mocks.getDb).toHaveBeenCalledTimes(1);
  });
});

describe("evaluator dashboard navigation", () => {
  it("exposes only the authenticated Acme or DevFlow evaluator reference set", async () => {
    const evaluatorCases = [
      {
        workspaceSlug: "acme",
        workspaceId: EVALUATOR_WORKSPACE_ID,
        callSlug: "stagecraft-2026",
        eventId: EVALUATOR_EVENT_ID,
      },
      {
        workspaceSlug: "devflow",
        workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
        callSlug: "devflow-conf-2027",
        eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      },
    ] as const;

    for (const evaluatorCase of evaluatorCases) {
      mocks.sessionState.current = sessionFor(
        "organizer",
        evaluatorCase.workspaceSlug,
        evaluatorCase.workspaceId,
      );
      mocks.getDashboardState.mockReturnValue({ release: null });
      const element = await DashboardPage({
        params: Promise.resolve({ workspace: evaluatorCase.workspaceSlug }),
      });
      expect(isValidElement(element)).toBe(true);
      const props = element.props as Record<string, unknown>;
      expect(mocks.getDashboardState).toHaveBeenCalledWith(
        mocks.inertDb,
        evaluatorCase.workspaceId,
        [],
      );
      expect(props.state).toEqual({ release: null });
      expect(props.slug).toBe(evaluatorCase.workspaceSlug);
      expect(props.evaluator).toEqual({
        workspaceSlug: evaluatorCase.workspaceSlug,
        callSlug: evaluatorCase.callSlug,
        eventId: evaluatorCase.eventId,
        publicChannelReference: null,
      });
    }
  });

  it("keeps DevFlow public widgets unavailable when no current release exists", async () => {
    mocks.sessionState.current = sessionFor(
      "organizer",
      "devflow",
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    );
    mocks.getDashboardState.mockReturnValue({ release: null });

    const element = await DashboardPage({ params: Promise.resolve({ workspace: "devflow" }) });
    expect(isValidElement(element)).toBe(true);
    const props = element.props as Record<string, unknown>;

    expect(props.state).toEqual({ release: null });
    expect(props.evaluator).toEqual({
      workspaceSlug: "devflow",
      callSlug: "devflow-conf-2027",
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      publicChannelReference: null,
    });
  });

  it("does not expose evaluator references to other authenticated workspaces", async () => {
    for (const workspaceSlug of ["northstar", "other"] as const) {
      mocks.sessionState.current = sessionFor("organizer", workspaceSlug);
      mocks.getDashboardState.mockReturnValue({ release: { id: `${workspaceSlug}-release` } });
      const element = await DashboardPage({ params: Promise.resolve({ workspace: workspaceSlug }) });
      expect(isValidElement(element)).toBe(true);
      const props = element.props as Record<string, unknown>;

      expect(props.evaluator).toBeNull();
    }
  });
});

describe("organizer cross-workspace denial", () => {
  beforeEach(() => {
    mocks.sessionState.current = sessionFor("organizer", "northstar");
  });

  it("denies the dashboard before any read for acme", async () => {
    await expectNotFound(
      DashboardPage({ params: Promise.resolve({ workspace: "acme" }) }),
    );
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getDashboardState).not.toHaveBeenCalled();
    expect(mocks.listOtherWorkspaceSlugs).not.toHaveBeenCalled();
  });

  it("denies the event portfolio before any read for acme", async () => {
    await expectNotFound(
      EventsPage({ params: Promise.resolve({ workspace: "acme" }) }),
    );
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });

  it("denies the plan before any read for acme", async () => {
    await expectNotFound(
      PlanPage({
        params: Promise.resolve({ workspace: "acme", eventId: "event-1" }),
      }),
    );
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getEvent).not.toHaveBeenCalled();
    expect(mocks.candidatePlanVersion).not.toHaveBeenCalled();
    expect(mocks.currentPlanVersion).not.toHaveBeenCalled();
    expect(mocks.planDetail).not.toHaveBeenCalled();
  });

  it("denies person provenance before any read for acme", async () => {
    await expectNotFound(
      PersonPage({
        params: Promise.resolve({ workspace: "acme", personId: "person-1" }),
      }),
    );
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getPersonDetail).not.toHaveBeenCalled();
  });
});
