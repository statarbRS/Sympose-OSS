import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionInfo } from "@/server/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { kind: "event-readiness-test-db" },
  getRouteSession: vi.fn(),
  requireOrganizerWorkspaceRoute: vi.fn(),
  getDb: vi.fn(),
  getEvent: vi.fn(),
  readCfpOrganizerOverview: vi.fn(),
  readOrganizerReviewSurface: vi.fn(),
  listOffers: vi.fn(),
  readScheduleDraft: vi.fn(),
  detectScheduleConflicts: vi.fn(),
  validatePublicReleaseForRead: vi.fn(),
  listSpeakerCommunicationDeliveryLog: vi.fn(),
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
vi.mock("@/server/services/events", () => ({ getEvent: mocks.getEvent }));
vi.mock("@/server/services/cfp/organizer", () => ({
  readCfpOrganizerOverview: mocks.readCfpOrganizerOverview,
}));
vi.mock("@/server/services/cfp-review/organizer", () => ({
  readOrganizerReviewSurface: mocks.readOrganizerReviewSurface,
}));
vi.mock("@/server/services/commitments", () => ({ listOffers: mocks.listOffers }));
vi.mock("@/server/services/scheduling/persistence", () => ({
  readScheduleDraft: mocks.readScheduleDraft,
}));
vi.mock("@/server/services/scheduling/deterministic", () => ({
  detectScheduleConflicts: mocks.detectScheduleConflicts,
}));
vi.mock("@/server/services/publication", () => ({
  validatePublicReleaseForRead: mocks.validatePublicReleaseForRead,
}));
vi.mock("@/server/services/speaker-communications", () => ({
  listSpeakerCommunicationDeliveryLog: mocks.listSpeakerCommunicationDeliveryLog,
}));
vi.mock("@/server/workspace-session", async () => {
  const actual = await vi.importActual<typeof import("@/server/workspace-session")>(
    "@/server/workspace-session",
  );
  mocks.requireOrganizerWorkspaceRoute.mockImplementation(actual.requireOrganizerWorkspaceRoute);
  return {
    ...actual,
    getRouteSession: mocks.getRouteSession,
    requireOrganizerWorkspaceRoute: mocks.requireOrganizerWorkspaceRoute,
  };
});

import EventReadinessPage from "@/app/w/[workspace]/events/[eventId]/readiness/page";
import {
  EventReadinessCommandCenter,
  type EventReadinessProjection,
} from "@/components/event-readiness/event-readiness";

const SESSION: SessionInfo = {
  id: "session-a",
  tokenHash: "token-hash-a",
  accountId: "account-a",
  workspaceId: "workspace-a",
  expiresAt: "2099-01-01T00:00:00.000Z",
  email: "organizer@example.test",
  displayName: "Organizer",
  role: "organizer",
  workspaceSlug: "northstar",
  workspaceName: "Northstar",
};

const EVENT = {
  id: "event-canonical",
  name: "Northstar Summit",
  timezone: "Europe/Berlin",
  startsAt: "2026-09-15T09:00:00.000Z",
  endsAt: "2026-09-16T17:00:00.000Z",
  lifecycle: "planning",
  currentPlanVersionId: "plan-current",
  currentReleaseId: "release-current",
  createdAt: "2026-08-12T09:00:00.000Z",
};

function configureScopedReads(): void {
  mocks.getRouteSession.mockResolvedValue(SESSION);
  mocks.getDb.mockReturnValue(mocks.db);
  mocks.getEvent.mockReturnValue(EVENT);
  mocks.readCfpOrganizerOverview.mockReturnValue({
    event: { id: EVENT.id },
    calls: [{
      submissionCounts: { draft: 1, submitted: 4, withdrawn: 1, invalidated: 1 },
    }],
  });
  mocks.readOrganizerReviewSurface.mockReturnValue({
    workspaceId: SESSION.workspaceId,
    workspaceSlug: SESSION.workspaceSlug,
    eventId: EVENT.id,
    rounds: [{
      progress: {
        total: 4,
        submitted: 2,
        conflicts: 1,
        blindPending: 1,
      },
    }],
  });
  mocks.listOffers.mockReturnValue([
    { eventId: EVENT.id, response: "accepted", personName: "Hidden Person", email: "hidden@example.test" },
    { eventId: EVENT.id, response: null, personName: "Private Speaker", email: "private@example.test" },
  ]);
  const schedule = {
    workspaceId: SESSION.workspaceId,
    eventId: EVENT.id,
    status: "DRAFT",
    sessions: [
      { id: "session-1", placement: { roomId: "room-1" } },
      { id: "session-2", placement: null },
    ],
  };
  mocks.readScheduleDraft.mockReturnValue({ persisted: true, schedule });
  mocks.detectScheduleConflicts.mockReturnValue([{ id: "conflict-1" }]);
  mocks.validatePublicReleaseForRead.mockReturnValue({
    workspaceId: SESSION.workspaceId,
    eventId: EVENT.id,
    releaseId: EVENT.currentReleaseId,
    audiencePolicyVersion: 2,
    commitmentWatermark: 7,
    sealedAt: "2026-08-12T12:00:00.000Z",
    content: { accepted: [{ id: "accepted-1" }], agendas: [{ id: "agenda-1" }] },
  });
  mocks.listSpeakerCommunicationDeliveryLog.mockReturnValue([
    {
      workspaceId: SESSION.workspaceId,
      eventId: EVENT.id,
      status: "FAILED",
      displayName: "Private Recipient",
      normalizedEmail: "recipient@example.test",
      subjectPreview: "Private subject",
      bodyPreview: "Private body",
    },
    {
      workspaceId: SESSION.workspaceId,
      eventId: EVENT.id,
      status: "DELIVERED",
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  configureScopedReads();
});

describe("event readiness command center", () => {
  it("renders all six attention areas, direct links, and no person-level fields", async () => {
    const html = renderToStaticMarkup(await EventReadinessPage({
      params: Promise.resolve({ workspace: "northstar", eventId: "event-route" }),
    }));

    expect(html).toContain("Readiness command center");
    expect(html).toContain("Submissions and review");
    expect(html).toContain("Speaker commitments and tasks");
    expect(html).toContain("Content and artifacts");
    expect(html).toContain("Schedule conflicts and placement");
    expect(html).toContain("Publication release");
    expect(html).toContain("Communications and outbox");
    expect(html).toContain("This is not an approval gate or composite score");
    expect(html).toContain("Blocked means explicit negative evidence");
    expect(html).toContain("cannot verify means exact evidence is partial or unavailable");
    expect(html).toContain('data-surface="readiness"');
    expect(html).toContain('href="/w/northstar/events/event-canonical/cfp"');
    expect(html).toContain('href="/w/northstar/events/event-canonical/review"');
    expect(html).toContain('href="/w/northstar/events/event-canonical/speakers#readiness-matrix-title"');
    expect(html).toContain('href="/w/northstar/events/event-canonical/program#schedule-conflicts-title"');
    expect(html).toContain('href="/w/northstar/events/event-canonical/publication"');
    expect(html).toContain('href="/w/northstar/events/event-canonical/speakers#speaker-communications-history-title"');
    const speakerAreaStart = html.indexOf('data-readiness-area="speaker-commitments"');
    const speakerAreaEnd = html.indexOf('data-readiness-area="content-artifacts"');
    const speakerArea = html.slice(speakerAreaStart, speakerAreaEnd);
    expect(speakerArea).toContain("Cannot verify");
    expect(speakerArea).not.toContain("statusReady");
    expect(html).not.toContain("Hidden Person");
    expect(html).not.toContain("hidden@example.test");
    expect(html).not.toContain("Private Recipient");
    expect(html).not.toContain("recipient@example.test");
    expect(html).not.toContain("Private subject");
    expect(html).not.toContain("Private body");
  });

  it("demotes a ready label when the evidence is partial and provides a recovery action", () => {
    const projection: EventReadinessProjection = {
      event: {
        id: "event-partial",
        name: "Partial evidence event",
        timezone: "UTC",
        lifecycle: "planning",
      },
      areas: [{
        id: "schedule",
        title: "Schedule conflicts and placement",
        eyebrow: "Operational draft",
        status: { tone: "ready", label: "Draft clear" },
        evidence: { state: "partial", label: "Schedule evidence is incomplete" },
        summary: "Some schedule facts are available.",
        metrics: [{ label: "Sessions", value: 2 }],
        findings: [],
        actions: [{ href: "/w/northstar/events/event-partial/program", label: "Open program schedule" }],
      }],
    };

    const html = renderToStaticMarkup(createElement(EventReadinessCommandCenter, { projection }));

    expect(html).toContain("Cannot verify");
    expect(html).toContain("Use the direct links below to inspect the source surface.");
    expect(html).not.toContain("statusReady");
    expect(html).toContain("Open program schedule");
  });

  it("orders severity first while preserving workflow order inside each severity", () => {
    const area = (
      id: EventReadinessProjection["areas"][number]["id"],
      tone: EventReadinessProjection["areas"][number]["status"]["tone"],
      label: string,
    ): EventReadinessProjection["areas"][number] => ({
      id,
      title: label,
      eyebrow: "Workflow area",
      status: { tone, label },
      evidence: { state: "complete", label: "Evidence complete" },
      summary: `${label} summary`,
      metrics: [],
      findings: [],
      actions: [{ href: `/readiness/${id}`, label: `Open ${label}` }],
    });
    const projection: EventReadinessProjection = {
      event: { id: "event-order", name: "Ordered event", timezone: "UTC", lifecycle: "planning" },
      areas: [
        area("submissions-review", "ready", "Ready submissions"),
        area("speaker-commitments", "blocked", "Blocked speakers"),
        area("content-artifacts", "blocked", "Blocked content"),
        area("schedule", "attention", "Schedule attention"),
        area("publication", "unavailable", "Unavailable publication"),
        area("communications", "ready", "Ready communications"),
      ],
    };

    const html = renderToStaticMarkup(createElement(EventReadinessCommandCenter, { projection }));
    const positions = projection.areas.map((candidate) => html.indexOf(`data-readiness-area="${candidate.id}"`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions[1]).toBeLessThan(positions[2]!);
    expect(positions[2]).toBeLessThan(positions[4]!);
    expect(positions[4]).toBeLessThan(positions[3]!);
    expect(positions[3]).toBeLessThan(positions[0]!);
    expect(positions[0]).toBeLessThan(positions[5]!);
    expect(html).toContain('data-readiness-severity="blocked"');
    expect(html).toContain("Authored workflow order is preserved inside each state");
  });

  it("authorizes the route before reads and scopes every loader to the resolved event", async () => {
    await EventReadinessPage({
      params: Promise.resolve({ workspace: "northstar", eventId: "event-route" }),
    });

    expect(mocks.requireOrganizerWorkspaceRoute).toHaveBeenCalledWith(SESSION, "northstar");
    expect(mocks.requireOrganizerWorkspaceRoute.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getDb.mock.invocationCallOrder[0]!,
    );
    expect(mocks.getEvent).toHaveBeenCalledWith(mocks.db, SESSION.workspaceId, "event-route");
    expect(mocks.readCfpOrganizerOverview).toHaveBeenCalledWith(mocks.db, SESSION, EVENT.id);
    expect(mocks.readOrganizerReviewSurface).toHaveBeenCalledWith(mocks.db, SESSION, {
      workspaceSlug: SESSION.workspaceSlug,
      eventId: EVENT.id,
    });
    expect(mocks.listOffers).toHaveBeenCalledWith(mocks.db, SESSION.workspaceId, EVENT.id);
    expect(mocks.readScheduleDraft).toHaveBeenCalledWith(mocks.db, {
      workspaceId: SESSION.workspaceId,
      eventId: EVENT.id,
    });
    expect(mocks.validatePublicReleaseForRead).toHaveBeenCalledWith(mocks.db, {
      workspaceId: SESSION.workspaceId,
      eventId: EVENT.id,
      releaseId: EVENT.currentReleaseId,
      mode: "CURRENT",
    });
    expect(mocks.listSpeakerCommunicationDeliveryLog).toHaveBeenCalledWith(mocks.db, {
      workspaceId: SESSION.workspaceId,
      eventId: EVENT.id,
    });
  });

  it("denies a foreign workspace slug before opening the database", async () => {
    await expect(EventReadinessPage({
      params: Promise.resolve({ workspace: "foreign", eventId: "event-route" }),
    })).rejects.toThrow("__NOT_FOUND__");

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getEvent).not.toHaveBeenCalled();
    expect(mocks.readCfpOrganizerOverview).not.toHaveBeenCalled();
    expect(mocks.readOrganizerReviewSurface).not.toHaveBeenCalled();
  });

  it("stops at the workspace-scoped event lookup when the event is not found", async () => {
    mocks.getEvent.mockReturnValue(null);

    await expect(EventReadinessPage({
      params: Promise.resolve({ workspace: "northstar", eventId: "foreign-event" }),
    })).rejects.toThrow("__NOT_FOUND__");

    expect(mocks.getEvent).toHaveBeenCalledWith(mocks.db, SESSION.workspaceId, "foreign-event");
    expect(mocks.readCfpOrganizerOverview).not.toHaveBeenCalled();
    expect(mocks.readOrganizerReviewSurface).not.toHaveBeenCalled();
    expect(mocks.listOffers).not.toHaveBeenCalled();
    expect(mocks.readScheduleDraft).not.toHaveBeenCalled();
    expect(mocks.validatePublicReleaseForRead).not.toHaveBeenCalled();
    expect(mocks.listSpeakerCommunicationDeliveryLog).not.toHaveBeenCalled();
  });

  it("omits synthetic schedule counts when no saved draft exists", async () => {
    mocks.readScheduleDraft.mockReturnValue({
      persisted: false,
      schedule: {
        workspaceId: SESSION.workspaceId,
        eventId: EVENT.id,
        status: "DRAFT",
        sessions: [{ id: "synthetic-session", title: "Synthetic session", placement: null }],
      },
    });

    const html = renderToStaticMarkup(await EventReadinessPage({
      params: Promise.resolve({ workspace: "northstar", eventId: "event-route" }),
    }));

    expect(mocks.detectScheduleConflicts).not.toHaveBeenCalled();
    expect(html).toContain("synthetic fixture counts are intentionally omitted");
    expect(html).not.toContain("Synthetic session");
  });

  it("fails a foreign-scoped source closed without rendering its private fields", async () => {
    mocks.listSpeakerCommunicationDeliveryLog.mockReturnValue([{
      workspaceId: "workspace-foreign",
      eventId: "event-foreign",
      status: "FAILED",
      displayName: "Foreign Recipient",
      normalizedEmail: "foreign@example.test",
      subjectPreview: "Foreign subject",
      bodyPreview: "Foreign body",
    }]);

    const html = renderToStaticMarkup(await EventReadinessPage({
      params: Promise.resolve({ workspace: "northstar", eventId: "event-route" }),
    }));

    expect(html).toContain("Communications evidence could not be read");
    expect(html).not.toContain("Foreign Recipient");
    expect(html).not.toContain("foreign@example.test");
    expect(html).not.toContain("Foreign subject");
    expect(html).not.toContain("Foreign body");
  });
});
