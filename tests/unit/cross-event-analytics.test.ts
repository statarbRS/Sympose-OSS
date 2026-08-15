import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CrossEventAnalytics } from "../../src/components/cross-event-analytics/cross-event-analytics";
import {
  buildCrossEventAnalyticsModel,
  type AnalyticsSource,
  type CrossEventAnalyticsInput,
  type PublicationState,
  type ReviewCounts,
  type ScheduleCounts,
  type SpeakerReadinessCounts,
  type SubmissionCounts,
} from "../../src/components/cross-event-analytics/model";

const routeMocks = vi.hoisted(() => {
  const organizerSession = {
    id: "session-a",
    tokenHash: "a".repeat(64),
    accountId: "account-a",
    workspaceId: "workspace-a",
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: "organizer@example.test",
    displayName: "Organizer A",
    role: "organizer",
    workspaceSlug: "northstar",
    workspaceName: "Northstar",
  };
  return {
    organizerSession,
    session: { current: organizerSession },
    getRouteSession: vi.fn(async () => organizerSession),
    getDb: vi.fn(() => ({}) as never),
    listEvents: vi.fn(() => []),
    readCfpOrganizerOverview: vi.fn(),
    readCfpOrganizerCall: vi.fn(),
    readOrganizerReviewSurface: vi.fn(),
    validatePublicReleaseForRead: vi.fn(),
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

vi.mock("@/server/db", () => ({ getDb: routeMocks.getDb }));
vi.mock("@/server/services/events", () => ({ listEvents: routeMocks.listEvents }));
vi.mock("@/server/services/cfp/organizer", () => ({
  readCfpOrganizerOverview: routeMocks.readCfpOrganizerOverview,
  readCfpOrganizerCall: routeMocks.readCfpOrganizerCall,
}));
vi.mock("@/server/services/cfp-review/organizer", () => ({
  readOrganizerReviewSurface: routeMocks.readOrganizerReviewSurface,
}));
vi.mock("@/server/services/publication", () => ({
  validatePublicReleaseForRead: routeMocks.validatePublicReleaseForRead,
}));
vi.mock("@/server/workspace-session", async () => {
  const actual = await vi.importActual<typeof import("@/server/workspace-session")>(
    "@/server/workspace-session",
  );
  return { ...actual, getRouteSession: routeMocks.getRouteSession };
});

function available<T>(value: T): AnalyticsSource<T> {
  return { kind: "available", value };
}

function unavailable<T>(reason = "Authoritative source unavailable."): AnalyticsSource<T> {
  return { kind: "unavailable", reason };
}

function eventInput(input: {
  readonly id: string;
  readonly name: string;
  readonly submissions?: AnalyticsSource<SubmissionCounts>;
  readonly reviews?: AnalyticsSource<ReviewCounts>;
  readonly speakers?: AnalyticsSource<SpeakerReadinessCounts>;
  readonly schedule?: AnalyticsSource<ScheduleCounts>;
  readonly publication?: AnalyticsSource<PublicationState>;
}): CrossEventAnalyticsInput {
  return {
    event: {
      id: input.id,
      name: input.name,
      lifecycle: "planning",
      timezone: "Europe/London",
    },
    submissions: input.submissions ?? available({ draft: 0, submitted: 0, withdrawn: 0, invalidated: 0 }),
    reviews: input.reviews ?? available({ assigned: 0, inProgress: 0, submitted: 0, recused: 0, revoked: 0, activeTotal: 0 }),
    speakers: input.speakers ?? unavailable("Durable readiness is unavailable."),
    schedule: input.schedule ?? available({ scheduled: 0, accepted: 0 }),
    publication: input.publication ?? available({ state: "not-published" }),
  };
}

describe("cross-event analytics model", () => {
  it("sums source numerators and denominators instead of averaging event percentages", () => {
    const model = buildCrossEventAnalyticsModel({
      workspaceName: "Northstar",
      workspaceSlug: "northstar",
      events: [
        eventInput({
          id: "event-one",
          name: "Event One",
          submissions: available({ draft: 0, submitted: 1, withdrawn: 0, invalidated: 0 }),
          reviews: available({ assigned: 0, inProgress: 0, submitted: 1, recused: 2, revoked: 1, activeTotal: 1 }),
          schedule: available({ scheduled: 1, accepted: 1 }),
          publication: available({ state: "healthy", sealedAt: "2031-04-12T09:30:00.000Z" }),
        }),
        eventInput({
          id: "event-two",
          name: "Event Two",
          submissions: available({ draft: 8, submitted: 1, withdrawn: 0, invalidated: 0 }),
          reviews: available({ assigned: 5, inProgress: 3, submitted: 1, recused: 4, revoked: 2, activeTotal: 9 }),
          schedule: available({ scheduled: 1, accepted: 9 }),
        }),
        eventInput({
          id: "event-three",
          name: "Event Three",
          submissions: unavailable(),
          reviews: unavailable(),
          schedule: unavailable(),
          publication: unavailable(),
        }),
      ],
    });

    for (const key of ["submissions", "reviews", "schedule"] as const) {
      const metric = model.metrics.find((candidate) => candidate.key === key);
      expect(metric).toMatchObject({
        numerator: 2,
        denominator: 10,
        percentage: 20,
        measuredEvents: 2,
        totalEvents: 3,
        partial: true,
      });
    }
    expect(model.metrics.find((metric) => metric.key === "publication")).toMatchObject({
      numerator: 1,
      denominator: 2,
      percentage: 50,
      measuredEvents: 2,
      totalEvents: 3,
      partial: true,
    });
    expect(model.metrics.find((metric) => metric.key === "speakers")).toMatchObject({
      state: "unavailable",
      numerator: null,
      denominator: null,
      measuredEvents: 0,
    });
    expect(model.metrics.find((metric) => metric.key === "reviews")?.components).toMatchObject({
      recused: 6,
      revoked: 3,
    });
  });

  it("keeps zero-denominator, unavailable, and invalid-source states truthful", () => {
    const model = buildCrossEventAnalyticsModel({
      workspaceName: "Northstar",
      workspaceSlug: "northstar",
      events: [
        eventInput({
          id: "empty-event",
          name: "Empty Event",
          reviews: available({ assigned: 1, inProgress: 0, submitted: 0, recused: 0, revoked: 0, activeTotal: 0 }),
        }),
      ],
    });
    const html = renderToStaticMarkup(createElement(CrossEventAnalytics, { model }));

    expect(model.metrics.find((metric) => metric.key === "submissions")).toMatchObject({
      state: "empty",
      percentage: null,
      value: "No tracked submissions",
    });
    expect(model.metrics.find((metric) => metric.key === "reviews")).toMatchObject({
      state: "unavailable",
      percentage: null,
      value: "N/A",
    });
    expect(model.metrics.find((metric) => metric.key === "publication")).toMatchObject({
      state: "empty",
      percentage: null,
      value: "No current releases",
    });
    expect(html).toContain("No accepted CFP handoffs");
    expect(html).toContain("No current sealed release pointer is recorded for this event.");
    expect(html).not.toContain("Assigned 0 · In progress 0 · Submitted 0");
    expect(html).not.toContain("0 of 0");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
});

describe("cross-event analytics surface", () => {
  it("renders denominators, source boundaries, accessible detail, and exact event drilldowns", () => {
    const model = buildCrossEventAnalyticsModel({
      workspaceName: "Northstar",
      workspaceSlug: "northstar",
      events: [
        eventInput({
          id: "event-1",
          name: "Northstar Summit",
          submissions: available({ draft: 2, submitted: 3, withdrawn: 1, invalidated: 0 }),
          reviews: available({ assigned: 1, inProgress: 1, submitted: 2, recused: 1, revoked: 0, activeTotal: 4 }),
          schedule: available({ scheduled: 1, accepted: 2 }),
          publication: available({ state: "healthy", sealedAt: "2031-04-12T09:30:00.000Z" }),
        }),
      ],
    });
    const html = renderToStaticMarkup(createElement(CrossEventAnalytics, { model }));

    expect(html).toContain('data-testid="cross-event-analytics"');
    expect(html).toContain('aria-label="Workspace analytics navigation"');
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Current workspace metrics with navigation to the related event-level workflow views");
    expect(html).toContain("Numerator");
    expect(html).toContain("Denominator");
    expect(html).toContain("Source boundary and exclusions");
    expect(html).toContain("N/A means the source cannot support the metric; it never means zero.");

    for (const suffix of ["overview", "cfp", "review", "speakers", "program", "publication"]) {
      expect(html).toContain(`href="/w/northstar/events/event-1/${suffix}"`);
    }
    expect(html).toContain("Sealed <time dateTime=\"2031-04-12T09:30:00.000Z\"");
  });

  it("renders a dedicated empty-workspace state without invented metrics", () => {
    const model = buildCrossEventAnalyticsModel({
      workspaceName: "Northstar",
      workspaceSlug: "northstar",
      events: [],
    });
    const html = renderToStaticMarkup(createElement(CrossEventAnalytics, { model }));

    expect(html).toContain("No events to compare");
    expect(html).toContain("No counts or completion rates are inferred.");
    expect(html).not.toContain("2031-04-12");
  });
});

describe("cross-event analytics route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.session.current = routeMocks.organizerSession;
    routeMocks.getRouteSession.mockImplementation(async () => routeMocks.session.current);
    routeMocks.getDb.mockReturnValue({} as never);
    routeMocks.listEvents.mockReturnValue([]);
  });

  it("authorizes before reads and avoids synthetic analytics sources", () => {
    const route = readFileSync(resolve("src/app/w/[workspace]/analytics/page.tsx"), "utf8");
    const styles = readFileSync(resolve("src/components/cross-event-analytics/cross-event-analytics.module.css"), "utf8");
    const authorization = route.indexOf("requireOrganizerWorkspaceRoute(session, workspace)");
    const databaseRead = route.indexOf("const db = getDb()");

    expect(authorization).toBeGreaterThan(-1);
    expect(databaseRead).toBeGreaterThan(authorization);
    expect(route).toContain("readCfpOrganizerOverview");
    expect(route).toContain("readCfpOrganizerCall");
    expect(route).toContain("readOrganizerReviewSurface");
    expect(route).toContain("validatePublicReleaseForRead");
    expect(route).not.toContain("readScheduleDraft");
    expect(route).not.toContain("getSyntheticSpeakerOperationsRepository");
    expect(route).not.toContain("createSyntheticPublicationState");
    expect(route).not.toContain("new Date(");
    expect(route).not.toContain("Date.now(");
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("@media (max-width: 900px)");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain("@media (max-width: 390px)");
  });

  it.each([
    ["an unauthorized role", { role: "reviewer", workspaceSlug: "northstar" }, "northstar"],
    ["a foreign workspace slug", { role: "organizer", workspaceSlug: "northstar" }, "other-workspace"],
  ])("denies %s before opening the database or reading analytics", async (_label, sessionPatch, requestedWorkspace) => {
    routeMocks.session.current = { ...routeMocks.organizerSession, ...sessionPatch };
    const { default: AnalyticsPage } = await import("../../src/app/w/[workspace]/analytics/page");

    await expect(AnalyticsPage({ params: Promise.resolve({ workspace: requestedWorkspace }) }))
      .rejects.toThrow("__NOT_FOUND__");
    expect(routeMocks.getDb).not.toHaveBeenCalled();
    expect(routeMocks.listEvents).not.toHaveBeenCalled();
    expect(routeMocks.readCfpOrganizerOverview).not.toHaveBeenCalled();
    expect(routeMocks.readOrganizerReviewSurface).not.toHaveBeenCalled();
    expect(routeMocks.validatePublicReleaseForRead).not.toHaveBeenCalled();
  });

  it("stops a missing session before opening the database or reading analytics", async () => {
    routeMocks.getRouteSession.mockRejectedValueOnce(new Error("__SESSION_UNAVAILABLE__"));
    const { default: AnalyticsPage } = await import("../../src/app/w/[workspace]/analytics/page");

    await expect(AnalyticsPage({ params: Promise.resolve({ workspace: "northstar" }) }))
      .rejects.toThrow("__SESSION_UNAVAILABLE__");
    expect(routeMocks.getDb).not.toHaveBeenCalled();
    expect(routeMocks.listEvents).not.toHaveBeenCalled();
    expect(routeMocks.readCfpOrganizerOverview).not.toHaveBeenCalled();
    expect(routeMocks.readOrganizerReviewSurface).not.toHaveBeenCalled();
    expect(routeMocks.validatePublicReleaseForRead).not.toHaveBeenCalled();
  });

  it("uses only the authorized workspace ID for the event-list read", async () => {
    const { default: AnalyticsPage } = await import("../../src/app/w/[workspace]/analytics/page");

    await AnalyticsPage({ params: Promise.resolve({ workspace: "northstar" }) });
    expect(routeMocks.getDb).toHaveBeenCalledTimes(1);
    expect(routeMocks.listEvents).toHaveBeenCalledWith(expect.anything(), "workspace-a");
  });
});
