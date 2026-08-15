import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "../../src/server/auth";

const mocks = vi.hoisted(() => ({
  db: { kind: "inert-db" },
  getRouteSession: vi.fn(),
  getDb: vi.fn(),
  getEvent: vi.fn(),
  listContentLibrary: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
}));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/services/events", () => ({ getEvent: mocks.getEvent }));
vi.mock("@/server/services/content-library", () => ({ listContentLibrary: mocks.listContentLibrary }));
vi.mock("@/server/workspace-session", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/workspace-session")>("@/server/workspace-session");
  return { ...actual, getRouteSession: mocks.getRouteSession };
});

import ContentLibraryPage from "@/app/w/[workspace]/events/[eventId]/speakers/content/page";

function session(role: string, workspaceSlug = "workspace-a-slug"): SessionInfo {
  return {
    id: "session-a",
    tokenHash: "session-hash-a",
    accountId: "account-a",
    workspaceId: "workspace-a",
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: "organizer@example.test",
    displayName: "Organizer A",
    role,
    workspaceSlug,
    workspaceName: "Workspace A",
  };
}

const PROJECTION = {
  schema: "sympose-content-library/v1",
  workspaceId: "workspace-a",
  eventId: "event-a",
  items: [],
  versionCount: 0,
  currentFileCount: 0,
  archiveLimits: { maxFiles: 24, maxUncompressedBytes: 64 * 1024 * 1024 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRouteSession.mockResolvedValue(session("organizer"));
  mocks.getDb.mockReturnValue(mocks.db);
  mocks.getEvent.mockReturnValue({ id: "event-a", workspaceId: "workspace-a", name: "Event A" });
  mocks.listContentLibrary.mockReturnValue(PROJECTION);
});

describe("organizer Content Library page boundary", () => {
  it.each(["reviewer", "read_only", "communications_manager"])(
    "denies %s before opening the database or listing artifacts",
    async (role) => {
      mocks.getRouteSession.mockResolvedValue(session(role));

      await expect(ContentLibraryPage({
        params: Promise.resolve({ workspace: "workspace-a-slug", eventId: "event-a" }),
      })).rejects.toThrow("__NOT_FOUND__");

      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.getEvent).not.toHaveBeenCalled();
      expect(mocks.listContentLibrary).not.toHaveBeenCalled();
    },
  );

  it("denies User B's workspace slug before opening the database or listing artifacts", async () => {
    mocks.getRouteSession.mockResolvedValue(session("organizer", "workspace-b-slug"));

    await expect(ContentLibraryPage({
      params: Promise.resolve({ workspace: "workspace-a-slug", eventId: "event-a" }),
    })).rejects.toThrow("__NOT_FOUND__");

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.listContentLibrary).not.toHaveBeenCalled();
  });

  it("denies the wrong event before listing artifacts", async () => {
    mocks.getEvent.mockReturnValue(null);

    await expect(ContentLibraryPage({
      params: Promise.resolve({ workspace: "workspace-a-slug", eventId: "event-b" }),
    })).rejects.toThrow("__NOT_FOUND__");

    expect(mocks.getEvent).toHaveBeenCalledWith(mocks.db, "workspace-a", "event-b");
    expect(mocks.listContentLibrary).not.toHaveBeenCalled();
  });

  it("lists exact-event durable authority only after organizer workspace authorization", async () => {
    const element = await ContentLibraryPage({
      params: Promise.resolve({ workspace: "workspace-a-slug", eventId: "event-a" }),
    });

    expect(isValidElement(element)).toBe(true);
    expect(mocks.listContentLibrary).toHaveBeenCalledWith(mocks.db, {
      kind: "organizer",
      workspaceId: "workspace-a",
      eventId: "event-a",
      actorId: "account-a",
    });
  });
});
