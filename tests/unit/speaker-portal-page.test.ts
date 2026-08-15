import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieValue: "valid-token",
  cookies: vi.fn(),
  headers: vi.fn(),
  getPortalProjection: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
  headers: mocks.headers,
}));
vi.mock("@/server/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/services/speaker-operations", () => ({
  getSyntheticSpeakerOperationsRepository: () => ({ getPortalProjection: mocks.getPortalProjection }),
}));
vi.mock("@/components/speaker-portal/speaker-portal", () => ({
  SpeakerPortal: (props: unknown) => props,
}));
vi.mock("@/components/speaker-portal/portal-entry", () => ({ SpeakerPortalEntry: () => null }));

import SpeakerPortalPage from "@/app/speaker/page";

describe("speaker portal page requester budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({
      get: (name: string) => name === "sympose_speaker_portal" ? { value: mocks.cookieValue } : undefined,
    });
    mocks.headers.mockResolvedValue(new Headers({ "cf-connecting-ip": "requester-a" }));
    process.env.SYMPOSE_REAL_IP_HEADER = "cf-connecting-ip";
    mocks.getPortalProjection.mockReturnValue({ access: { workspaceId: "workspace", eventId: "event", personId: "person" } });
  });

  afterEach(() => {
    delete process.env.SYMPOSE_REAL_IP_HEADER;
  });

  it("reuses the entry request requester identity when rendering the logged-in portal", async () => {
    await SpeakerPortalPage();

    expect(mocks.getPortalProjection).toHaveBeenCalledWith("valid-token", "speaker-content:page:requester-a");
  });
});
