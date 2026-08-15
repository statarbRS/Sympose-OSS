import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "@/server/auth";
import CrmPage from "@/app/w/[workspace]/crm/page";

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
    listEvents: vi.fn(() => []),
    listManualSpeakerRecords: vi.fn(() => []),
    manualSpeakerCreateIdempotencyKey: vi.fn(() => "manual-speaker:create:test"),
    listSpeakerCommunicationDeliveryLog: vi.fn(() => []),
    getCrmWorkspaceView: vi.fn(() => ({
      workspace: { id: "workspace-1", slug: "northstar", name: "Northstar Network" },
      people: [],
      metrics: {
        totalPeople: 0,
        organizations: 0,
        withOrganization: 0,
        withTitle: 0,
        sourcedPeople: 0,
      },
    })),
  };
});

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
}));

vi.mock("@/server/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/server/services/crm", () => ({
  getCrmWorkspaceView: mocks.getCrmWorkspaceView,
}));

vi.mock("@/server/services/events", () => ({
  listEvents: mocks.listEvents,
}));

vi.mock("@/server/services/speaker-operations", () => ({
  listManualSpeakerRecords: mocks.listManualSpeakerRecords,
  manualSpeakerCreateIdempotencyKey: mocks.manualSpeakerCreateIdempotencyKey,
}));

vi.mock("@/server/services/speaker-communications", () => ({
  listSpeakerCommunicationDeliveryLog: mocks.listSpeakerCommunicationDeliveryLog,
  SPEAKER_COMMUNICATION_MAX_RECIPIENTS: 100,
}));

vi.mock("@/components/crm/crm-console", () => ({
  CrmConsole: () => null,
}));

vi.mock("@/server/workspace-session", async () => {
  const actual = await vi.importActual<typeof import("@/server/workspace-session")>(
    "@/server/workspace-session",
  );
  return {
    ...actual,
    getRouteSession: mocks.getRouteSession,
  };
});

function sessionFor(role: string, workspaceSlug = "northstar"): SessionInfo {
  return {
    id: "session-crm-route",
    tokenHash: "token-hash-crm-route",
    accountId: "account-crm-route",
    workspaceId: "workspace-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: "organizer@example.test",
    displayName: "CRM Route Organizer",
    role,
    workspaceSlug,
    workspaceName: "Northstar Network",
  };
}

async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow("__NOT_FOUND__");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionState.current = sessionFor("organizer");
  mocks.getCrmWorkspaceView.mockReturnValue({
    workspace: { id: "workspace-1", slug: "northstar", name: "Northstar Network" },
    people: [],
    metrics: {
      totalPeople: 0,
      organizations: 0,
      withOrganization: 0,
      withTitle: 0,
      sourcedPeople: 0,
    },
  });
});

describe("CRM organizer route authorization", () => {
  it.each(["reviewer", "communications_manager", "read_only"])(
    "denies %s before reading the CRM service",
    async (role) => {
      mocks.sessionState.current = sessionFor(role);

      await expectNotFound(
        CrmPage({ params: Promise.resolve({ workspace: "northstar" }) }),
      );

      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.getCrmWorkspaceView).not.toHaveBeenCalled();
      expect(mocks.listEvents).not.toHaveBeenCalled();
    },
  );

  it("denies a foreign workspace before the CRM query", async () => {
    mocks.sessionState.current = sessionFor("organizer", "northstar");

    await expectNotFound(
      CrmPage({ params: Promise.resolve({ workspace: "acme" }) }),
    );

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getCrmWorkspaceView).not.toHaveBeenCalled();
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });

  it("loads the authorized workspace through the new CRM query service", async () => {
    const element = await CrmPage({ params: Promise.resolve({ workspace: "northstar" }) });

    expect(isValidElement(element)).toBe(true);
    expect(mocks.getDb).toHaveBeenCalledTimes(1);
    expect(mocks.getCrmWorkspaceView).toHaveBeenCalledWith(
      mocks.inertDb,
      mocks.sessionState.current,
      "northstar",
    );
    expect(mocks.listEvents).toHaveBeenCalledWith(mocks.inertDb, "workspace-1");
    expect(mocks.listManualSpeakerRecords).not.toHaveBeenCalled();
    expect(mocks.listSpeakerCommunicationDeliveryLog).not.toHaveBeenCalled();
  });
});
