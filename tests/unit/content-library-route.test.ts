import { beforeEach, describe, expect, it, vi } from "vitest";

const ARTIFACT_A = "a".repeat(64);
const ARTIFACT_B = "b".repeat(64);
const ARCHIVE_BYTES = Buffer.from("PK\u0003\u0004exact archive bytes", "binary");

const mocks = vi.hoisted(() => {
  class MockContentLibraryError extends Error {
    readonly code: string;

    constructor(code: string, message = code) {
      super(message);
      this.name = "ContentLibraryError";
      this.code = code;
    }
  }
  const cookieState: { value: string | undefined } = { value: undefined };
  return {
    MockContentLibraryError,
    cookieState,
    db: { kind: "inert-db" },
    cookies: vi.fn(async () => ({
      get: vi.fn(() => cookieState.value === undefined ? undefined : { value: cookieState.value }),
    })),
    getDb: vi.fn(),
    resolveSession: vi.fn(),
    hasCapability: vi.fn(),
    getEvent: vi.fn(),
    createContentLibraryArchive: vi.fn(),
  };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/server/auth", () => ({
  SESSION_COOKIE: "sympose_session",
  resolveSession: mocks.resolveSession,
  hasCapability: mocks.hasCapability,
}));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/services/events", () => ({ getEvent: mocks.getEvent }));
vi.mock("@/server/services/content-library", () => ({
  CONTENT_LIBRARY_ARCHIVE_MAX_FORM_BYTES: 16 * 1024,
  ContentLibraryError: mocks.MockContentLibraryError,
  createContentLibraryArchive: mocks.createContentLibraryArchive,
}));

import { POST } from "@/app/w/[workspace]/events/[eventId]/speakers/content/archive/route";

const SESSION_A = {
  accountId: "account-a",
  workspaceId: "workspace-a",
  workspaceSlug: "workspace-a-slug",
  role: "organizer",
};

function params(eventId = "event-a", workspace = "workspace-a-slug") {
  return { params: Promise.resolve({ workspace, eventId }) };
}

function formRequest(ids: readonly string[]): Request {
  const form = new FormData();
  for (const id of ids) form.append("artifactId", id);
  return new Request("https://sympose.test/w/workspace-a-slug/events/event-a/speakers/content/archive", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieState.value = "session-cookie-a";
  mocks.getDb.mockReturnValue(mocks.db);
  mocks.resolveSession.mockReturnValue(SESSION_A);
  mocks.hasCapability.mockReturnValue(true);
  mocks.getEvent.mockReturnValue({ id: "event-a", workspaceId: "workspace-a" });
  mocks.createContentLibraryArchive.mockReturnValue({
    schema: "sympose-content-library-archive/v1",
    fileName: "sympose-content-library.zip",
    contentType: "application/zip",
    bytes: ARCHIVE_BYTES,
    fileCount: 2,
    uncompressedBytes: 321,
    entries: [],
  });
});

describe("organizer Content Library archive route", () => {
  it("denies an unauthenticated caller before event or library reads", async () => {
    mocks.cookieState.value = undefined;
    mocks.resolveSession.mockReturnValue(null);

    const response = await POST(formRequest([ARTIFACT_A]), params());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getEvent).not.toHaveBeenCalled();
    expect(mocks.createContentLibraryArchive).not.toHaveBeenCalled();
  });

  it("denies User B's workspace mismatch before event or library reads", async () => {
    mocks.resolveSession.mockReturnValue({
      ...SESSION_A,
      accountId: "account-b",
      workspaceId: "workspace-b",
      workspaceSlug: "workspace-b-slug",
    });

    const response = await POST(formRequest([ARTIFACT_A]), params());

    expect(response.status).toBe(404);
    expect(mocks.getEvent).not.toHaveBeenCalled();
    expect(mocks.createContentLibraryArchive).not.toHaveBeenCalled();
  });

  it("denies a session without organizer capability before event or library reads", async () => {
    mocks.hasCapability.mockReturnValue(false);

    const response = await POST(formRequest([ARTIFACT_A]), params());

    expect(response.status).toBe(404);
    expect(mocks.getEvent).not.toHaveBeenCalled();
    expect(mocks.createContentLibraryArchive).not.toHaveBeenCalled();
  });

  it("denies an event outside the authenticated workspace before parsing or library reads", async () => {
    mocks.getEvent.mockReturnValue(null);

    const response = await POST(formRequest([ARTIFACT_A]), params("event-b"));

    expect(response.status).toBe(404);
    expect(mocks.getEvent).toHaveBeenCalledWith(mocks.db, "workspace-a", "event-b");
    expect(mocks.createContentLibraryArchive).not.toHaveBeenCalled();
  });

  it("returns the exact ZIP with fixed safe private download headers for User A", async () => {
    const response = await POST(formRequest([ARTIFACT_B, ARTIFACT_A]), params());

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ARCHIVE_BYTES);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="sympose-content-library.zip"');
    expect(response.headers.get("content-length")).toBe(String(ARCHIVE_BYTES.byteLength));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-sympose-archive-files")).toBe("2");
    expect(response.headers.get("x-sympose-uncompressed-bytes")).toBe("321");
    expect(mocks.createContentLibraryArchive).toHaveBeenCalledWith(
      mocks.db,
      { kind: "organizer", workspaceId: "workspace-a", eventId: "event-a", actorId: "account-a" },
      [ARTIFACT_B, ARTIFACT_A],
    );
  });

  it.each([
    ["CONTENT_LIBRARY_SELECTION_EMPTY", 400, "Select at least one current file."],
    ["CONTENT_LIBRARY_SELECTION_INVALID", 400, "The file selection is invalid."],
    ["CONTENT_LIBRARY_SELECTION_DUPLICATE", 400, "The file selection is invalid."],
    ["CONTENT_LIBRARY_SELECTION_TOO_MANY", 413, "The selected files exceed archive limits; no archive was created."],
    ["CONTENT_LIBRARY_SELECTION_TOO_LARGE", 413, "The selected files exceed archive limits; no archive was created."],
    ["CONTENT_LIBRARY_SELECTION_NOT_FOUND", 404, "Not found"],
    ["CONTENT_LIBRARY_SELECTION_STALE", 404, "Not found"],
    ["CONTENT_LIBRARY_BYTES_UNAVAILABLE", 409, "The selected files could not be read; no archive was created."],
    ["CONTENT_LIBRARY_INTEGRITY_FAILURE", 409, "The archive is unavailable; no archive was created."],
  ])("maps %s to an atomic non-ZIP response", async (code, expectedStatus, expectedBody) => {
    mocks.createContentLibraryArchive.mockImplementation(() => {
      throw new mocks.MockContentLibraryError(code);
    });

    const response = await POST(formRequest([ARTIFACT_A]), params());

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("content-type")).not.toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe(expectedBody);
  });

  it("rejects a streamed body above the form ceiling even without Content-Length", async () => {
    const request = new Request("https://sympose.test/archive", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `artifactId=${"a".repeat(17 * 1024)}`,
    });
    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request, params());

    expect(response.status).toBe(413);
    expect(await response.text()).toContain("no archive was created");
    expect(mocks.createContentLibraryArchive).not.toHaveBeenCalled();
  });

  it("rejects malformed form encoding without disclosing parser details", async () => {
    const request = new Request("https://sympose.test/archive", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "artifactId=" + ARTIFACT_A,
    });

    const response = await POST(request, params());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("The file selection is invalid.");
    expect(mocks.createContentLibraryArchive).not.toHaveBeenCalled();
  });
});
