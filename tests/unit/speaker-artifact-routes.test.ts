import { beforeEach, describe, expect, it, vi } from "vitest";

const ARTIFACT_ID = "a".repeat(64);
const SCOPE = {
  workspaceId: "route-workspace",
  eventId: "route-event",
  personId: "route-person",
  taskId: "route-task",
  kind: "HEADSHOT" as const,
};
const PUBLIC_RELEASE_REFERENCE = "aud1-11111111-1111-4111-8111-111111111111";
const PUBLIC_ARTIFACT_REFERENCE = "aud1-22222222-2222-4222-8222-222222222222";
const RECORD = {
  schema: "sympose-artifact-record/v1",
  artifactId: ARTIFACT_ID,
  ...SCOPE,
  version: 1,
  supersedesRecordId: null,
  storageProvider: "local" as const,
  storageId: "b".repeat(64),
  sha256: "c".repeat(64),
  byteSize: 8,
  mediaType: "image/png" as const,
  displayFilename: "headshot.png",
  createdAt: "2026-08-12T12:00:00.000Z",
  current: true,
};

const mocks = vi.hoisted(() => {
  const cookieState: { value: string | undefined } = { value: undefined };
  return {
    cookieState,
    cookies: vi.fn(async () => ({
      get: vi.fn(() => (cookieState.value === undefined ? undefined : { value: cookieState.value })),
    })),
    headers: vi.fn(async () => new Headers({ "cf-connecting-ip": "requester-a" })),
    resolvePortalToken: vi.fn(),
    getDb: vi.fn(() => ({})),
    listSpeakerArtifactRecords: vi.fn(),
    readSpeakerArtifact: vi.fn(),
    readPublishedSpeakerHeadshotByAudienceReference: vi.fn(),
    getRouteSession: vi.fn(),
    requireOrganizerWorkspaceRoute: vi.fn(),
    getEvent: vi.fn(),
    resolveSession: vi.fn(),
    hasCapability: vi.fn(),
  };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/auth", () => ({
  SESSION_COOKIE: "sympose_session",
  resolveSession: mocks.resolveSession,
  hasCapability: mocks.hasCapability,
}));
vi.mock("@/server/services/speaker-operations", () => ({
  getSyntheticSpeakerOperationsRepository: () => ({ resolvePortalToken: mocks.resolvePortalToken }),
}));
vi.mock("@/server/services/artifact-records", () => ({
  listSpeakerArtifactRecords: mocks.listSpeakerArtifactRecords,
  readSpeakerArtifact: mocks.readSpeakerArtifact,
  readPublishedSpeakerHeadshotByAudienceReference: mocks.readPublishedSpeakerHeadshotByAudienceReference,
}));
vi.mock("@/server/services/events", () => ({ getEvent: mocks.getEvent }));

import { GET as getSpeakerArtifact } from "@/app/speaker/artifacts/[artifactId]/route";
import { GET as getPublicSpeakerArtifact } from "@/app/public/releases/[releaseId]/speaker-artifacts/[artifactId]/route";
import { GET as getOrganizerArtifact } from "@/app/w/[workspace]/events/[eventId]/speakers/artifacts/[artifactId]/route";

function routeParams(): { readonly params: Promise<{ readonly artifactId: string }> } {
  return { params: Promise.resolve({ artifactId: ARTIFACT_ID }) };
}

function organizerRouteParams(): { readonly params: Promise<{ readonly workspace: string; readonly eventId: string; readonly artifactId: string }> } {
  return { params: Promise.resolve({ workspace: "route-slug", eventId: SCOPE.eventId, artifactId: ARTIFACT_ID }) };
}

function publicRouteParams(): { readonly params: Promise<{ readonly releaseId: string; readonly artifactId: string }> } {
  return { params: Promise.resolve({ releaseId: PUBLIC_RELEASE_REFERENCE, artifactId: PUBLIC_ARTIFACT_REFERENCE }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieState.value = undefined;
  mocks.resolvePortalToken.mockReturnValue(null);
  mocks.listSpeakerArtifactRecords.mockReturnValue([]);
  mocks.readSpeakerArtifact.mockReturnValue(null);
  mocks.readPublishedSpeakerHeadshotByAudienceReference.mockReturnValue(null);
  mocks.getRouteSession.mockResolvedValue({ workspaceId: SCOPE.workspaceId, workspaceSlug: "route-slug", role: "organizer" });
  mocks.requireOrganizerWorkspaceRoute.mockImplementation(() => undefined);
  mocks.resolveSession.mockReturnValue({ workspaceId: SCOPE.workspaceId, workspaceSlug: "route-slug", role: "organizer" });
  mocks.hasCapability.mockReturnValue(true);
  mocks.getEvent.mockReturnValue({ id: SCOPE.eventId });
});

describe("authenticated speaker artifact downloads", () => {
  it("denies a missing or inactive speaker portal token without reading artifact metadata", async () => {
    await expect(getSpeakerArtifact(new Request("https://example.test/speaker/artifacts/" + ARTIFACT_ID), routeParams())).resolves.toHaveProperty("status", 404);
    expect(mocks.resolvePortalToken).not.toHaveBeenCalled();

    mocks.cookieState.value = "expired-token";
    mocks.resolvePortalToken.mockReturnValue({ ...SCOPE, active: false });
    await expect(getSpeakerArtifact(new Request("https://example.test/speaker/artifacts/" + ARTIFACT_ID), routeParams())).resolves.toHaveProperty("status", 404);
    expect(mocks.listSpeakerArtifactRecords).not.toHaveBeenCalled();
  });

  it("maps malformed portal-token resolution failures to the same generic not-found response", async () => {
    mocks.cookieState.value = "malformed-token";
    mocks.resolvePortalToken.mockImplementation(() => { throw new Error("token parser detail"); });

    const response = await getSpeakerArtifact(new Request("https://example.test/speaker/artifacts/" + ARTIFACT_ID), routeParams());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(mocks.listSpeakerArtifactRecords).not.toHaveBeenCalled();
  });

  it("returns bytes only for the active scoped token and sets private no-store nosniff headers", async () => {
    mocks.cookieState.value = "active-token";
    mocks.resolvePortalToken.mockReturnValue({ ...SCOPE, active: true });
    mocks.listSpeakerArtifactRecords.mockReturnValue([RECORD]);
    mocks.readSpeakerArtifact.mockReturnValue({ record: RECORD, bytes: Buffer.from("pngbytes") });

    const response = await getSpeakerArtifact(new Request("https://example.test/speaker/artifacts/" + ARTIFACT_ID), routeParams());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("pngbytes");
  });
});

describe("public released speaker headshots", () => {
  it("returns a generic no-store not-found for an unbound artifact", async () => {
    const response = await getPublicSpeakerArtifact(
      new Request(`https://example.test/public/releases/${PUBLIC_RELEASE_REFERENCE}/speaker-artifacts/${PUBLIC_ARTIFACT_REFERENCE}`),
      publicRouteParams(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Not found");
    expect(mocks.readPublishedSpeakerHeadshotByAudienceReference).toHaveBeenCalledWith(
      {},
      { releaseReference: PUBLIC_RELEASE_REFERENCE, artifactReference: PUBLIC_ARTIFACT_REFERENCE },
    );
  });

  it("serves only the current sealed release binding with non-storable public headers", async () => {
    mocks.readPublishedSpeakerHeadshotByAudienceReference.mockReturnValue({
      record: { ...RECORD, displayFilename: "Mina headshot.png", mediaType: "image/png" },
      bytes: Buffer.from("pngbytes"),
    });

    const response = await getPublicSpeakerArtifact(
      new Request(`https://example.test/public/releases/${PUBLIC_RELEASE_REFERENCE}/speaker-artifacts/${PUBLIC_ARTIFACT_REFERENCE}`),
      publicRouteParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain('filename="speaker-headshot.png"');
    expect(response.headers.get("content-disposition")).not.toContain("Mina");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("pngbytes");
  });
});

describe("organizer artifact download authorization", () => {
  beforeEach(() => {
    mocks.cookieState.value = "organizer-token";
  });

  it("denies a missing session before event or artifact reads", async () => {
    mocks.resolveSession.mockReturnValue(null);
    await expect(getOrganizerArtifact(new Request("https://example.test"), organizerRouteParams())).resolves.toHaveProperty("status", 404);
    expect(mocks.getEvent).not.toHaveBeenCalled();
    expect(mocks.listSpeakerArtifactRecords).not.toHaveBeenCalled();
  });

  it("denies a workspace mismatch before reading the event", async () => {
    mocks.resolveSession.mockReturnValue({ workspaceId: SCOPE.workspaceId, workspaceSlug: "other", role: "organizer" });
    await expect(getOrganizerArtifact(new Request("https://example.test"), organizerRouteParams())).resolves.toHaveProperty("status", 404);
    expect(mocks.getEvent).not.toHaveBeenCalled();
    expect(mocks.listSpeakerArtifactRecords).not.toHaveBeenCalled();
  });

  it("denies a session without organizer capability before reading the event", async () => {
    mocks.hasCapability.mockReturnValue(false);
    await expect(getOrganizerArtifact(new Request("https://example.test"), organizerRouteParams())).resolves.toHaveProperty("status", 404);
    expect(mocks.getEvent).not.toHaveBeenCalled();
    expect(mocks.listSpeakerArtifactRecords).not.toHaveBeenCalled();
  });

  it("serves a persisted artifact through the organizer-scoped route with safe headers", async () => {
    mocks.listSpeakerArtifactRecords.mockReturnValue([RECORD]);
    mocks.readSpeakerArtifact.mockReturnValue({ record: RECORD, bytes: Buffer.from("pngbytes") });

    const response = await getOrganizerArtifact(new Request("https://example.test"), organizerRouteParams());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("pngbytes");
  });
});
