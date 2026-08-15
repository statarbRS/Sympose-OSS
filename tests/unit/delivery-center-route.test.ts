import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DeliveryCenterPage from "@/app/w/[workspace]/events/[eventId]/delivery/page";
import type { SessionInfo } from "@/server/auth";
import {
  DeliveryCenterNotFoundError,
  DeliveryCenterReadError,
} from "@/server/services/delivery-center";

const mocks = vi.hoisted(() => {
  const sessionState: { current: SessionInfo | null } = { current: null };
  return {
    inertDb: {},
    sessionState,
    getDb: vi.fn(() => ({})),
    getRouteSession: vi.fn(async () => {
      if (!sessionState.current) throw new Error("test session is unavailable");
      return sessionState.current;
    }),
    readDeliveryCenter: vi.fn(() => ({ schema: "sympose-delivery-center/v1" })),
  };
});

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
}));

vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));

vi.mock("@/server/services/delivery-center", async () => {
  const actual = await vi.importActual<typeof import("@/server/services/delivery-center")>(
    "@/server/services/delivery-center",
  );
  return { ...actual, readDeliveryCenter: mocks.readDeliveryCenter };
});

vi.mock("@/server/workspace-session", async () => {
  const actual = await vi.importActual<typeof import("@/server/workspace-session")>(
    "@/server/workspace-session",
  );
  return { ...actual, getRouteSession: mocks.getRouteSession };
});

vi.mock("@/components/delivery-center/delivery-center", () => ({
  DeliveryCenter: () => null,
}));

function sessionFor(role: string, workspaceSlug = "northstar"): SessionInfo {
  return {
    id: "delivery-route-session",
    tokenHash: "delivery-route-token-hash",
    accountId: "delivery-route-account",
    workspaceId: "delivery-route-workspace",
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: "organizer@example.test",
    displayName: "Delivery Organizer",
    role,
    workspaceSlug,
    workspaceName: "Northstar Network",
  };
}

async function render(workspace = "northstar", eventId = "event-1") {
  return DeliveryCenterPage({ params: Promise.resolve({ workspace, eventId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inertDb = {};
  mocks.getDb.mockReturnValue(mocks.inertDb);
  mocks.sessionState.current = sessionFor("organizer");
  mocks.readDeliveryCenter.mockReturnValue({ schema: "sympose-delivery-center/v1" });
});

describe("Delivery Center route authorization", () => {
  it("denies an unauthenticated caller before opening the database or reading a projection", async () => {
    mocks.sessionState.current = null;
    await expect(render()).rejects.toThrow("test session is unavailable");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.readDeliveryCenter).not.toHaveBeenCalled();
  });

  it.each(["reviewer", "read_only", "communications_manager"])(
    "denies %s before opening the database or reading a projection",
    async (role) => {
      mocks.sessionState.current = sessionFor(role);
      await expect(render()).rejects.toThrow("__NOT_FOUND__");
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.readDeliveryCenter).not.toHaveBeenCalled();
    },
  );

  it("denies a foreign workspace before opening the database or reading a projection", async () => {
    mocks.sessionState.current = sessionFor("organizer", "northstar");
    await expect(render("acme")).rejects.toThrow("__NOT_FOUND__");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.readDeliveryCenter).not.toHaveBeenCalled();
  });

  it("passes only the server session and exact route workspace/event to the read model", async () => {
    const element = await render("northstar", "event-bound-1");
    expect(isValidElement(element)).toBe(true);
    expect(mocks.getDb).toHaveBeenCalledTimes(1);
    expect(mocks.readDeliveryCenter).toHaveBeenCalledWith(
      mocks.inertDb,
      mocks.sessionState.current,
      { workspaceSlug: "northstar", eventId: "event-bound-1" },
    );
  });

  it("maps an unavailable scoped event to not-found without exposing the service error", async () => {
    mocks.readDeliveryCenter.mockImplementation(() => {
      throw new DeliveryCenterNotFoundError();
    });
    await expect(render("northstar", "foreign-event")).rejects.toThrow("__NOT_FOUND__");
  });

  it("lets a generic read failure reach the redacted route error boundary", async () => {
    mocks.readDeliveryCenter.mockImplementation(() => {
      throw new DeliveryCenterReadError();
    });
    await expect(render()).rejects.toThrow("The Delivery Center could not read its authorized event boundary.");
  });
});
