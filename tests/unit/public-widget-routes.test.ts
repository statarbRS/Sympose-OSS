import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentChannelReference: "",
  currentReleaseId: "",
  currentProjection: null as unknown,
  savedConfiguration: null as unknown,
  getDb: vi.fn(),
  resolveCurrentPublicAgendaReleaseByChannel: vi.fn(),
  resolveSavedPublicAgendaRelease: vi.fn(),
  getPublicEmbedConfiguration: vi.fn(),
}));

vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/services/public-widgets/binding", () => ({
  resolveCurrentPublicAgendaReleaseByChannel: mocks.resolveCurrentPublicAgendaReleaseByChannel,
  resolveSavedPublicAgendaRelease: mocks.resolveSavedPublicAgendaRelease,
}));
vi.mock("@/server/services/public-widgets", () => ({
  getPublicEmbedConfiguration: mocks.getPublicEmbedConfiguration,
  isEmbedConfigurationId: (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value),
}));

import { GET as getCalendar } from "@/app/embed/[channelReference]/calendar.ics/route";
import { GET as getFeed } from "@/app/embed/[channelReference]/feed/route";
import { GET as getSnippet } from "@/app/embed/[channelReference]/snippet/route";
import { SYNTHETIC_PUBLIC_PROJECTION, toPublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import type { EmbedConfiguration } from "@/server/services/public-widgets/embed";

const projection = SYNTHETIC_PUBLIC_PROJECTION;
const widget = toPublicWidgetProjection(projection);
const channelReference = widget.release.channelReference;
const replacementChannelReference = `${channelReference}-replacement`;
const configurationId = "config-stable-1";
const configuration: EmbedConfiguration = {
  mode: "agenda",
  theme: "dark",
  accent: "violet",
  search: false,
};
const savedConfiguration = {
  schema: "publication-embed-configuration/v1",
  id: configurationId,
  label: "Public agenda",
  configuration,
  savedAt: "2026-08-12T10:00:00.000Z",
  scope: {
    workspaceId: projection.workspaceId,
    eventId: projection.eventId,
    channelReference,
  },
  idempotencyKey: "config-save-1",
  requestFingerprint: "config-fingerprint-1",
  sealedReleaseId: projection.releaseId,
  sealedEventName: widget.event.title,
} as const;

function routeParams(reference = channelReference): { readonly params: Promise<{ readonly channelReference: string }> } {
  return { params: Promise.resolve({ channelReference: reference }) };
}

function routeRequest(reference: string, suffix: string, query = ""): Request {
  const search = query.length > 0 ? `?${query}` : "";
  return new Request(`https://widgets.example.test/embed/${encodeURIComponent(reference)}${suffix}${search}`);
}

function proxiedRouteRequest(reference: string, suffix: string, query = ""): Request {
  const search = query.length > 0 ? `?${query}` : "";
  return new Request(`http://localhost:4800/embed/${encodeURIComponent(reference)}${suffix}${search}`, {
    headers: {
      host: "public-sympose.example.test",
      "x-forwarded-proto": "https",
    },
  });
}

async function expectNoStore(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentChannelReference = channelReference;
  mocks.currentReleaseId = projection.releaseId;
  mocks.currentProjection = projection;
  mocks.savedConfiguration = savedConfiguration;
  mocks.getDb.mockReturnValue({});
  mocks.resolveCurrentPublicAgendaReleaseByChannel.mockImplementation((_db, reference) =>
    reference === mocks.currentChannelReference ? mocks.currentProjection : null,
  );
  mocks.resolveSavedPublicAgendaRelease.mockImplementation((_db, scope, reference) =>
    reference === mocks.currentChannelReference && scope.releaseId === mocks.currentReleaseId
      ? mocks.currentProjection
      : null,
  );
  mocks.getPublicEmbedConfiguration.mockImplementation((_db, reference, id) =>
    reference === mocks.currentChannelReference && id === configurationId
      ? mocks.savedConfiguration
      : null,
  );
});

describe("public current-pointer widget routes", () => {
  it("marks successful feed, snippet, and calendar responses as no-store", async () => {
    const query = `configId=${encodeURIComponent(configurationId)}`;
    const [feed, snippet, calendar] = await Promise.all([
      getFeed(routeRequest(channelReference, "/feed", query), routeParams()),
      getSnippet(routeRequest(channelReference, "/snippet", query), routeParams()),
      getCalendar(routeRequest(channelReference, "/calendar.ics", query), routeParams()),
    ]);

    await expectNoStore(feed, 200);
    await expectNoStore(snippet, 200);
    await expectNoStore(calendar, 200);
    expect(feed.headers.get("content-type")).toContain("application/json");
    expect(snippet.headers.get("content-type")).toContain("text/plain");
    expect(calendar.headers.get("content-type")).toContain("text/calendar");
    expect((await feed.json()).releaseReference).toBe(widget.release.releaseReference);
    expect(await snippet.text()).toContain(`/embed/${channelReference}`);
    expect(await calendar.text()).toContain("BEGIN:VCALENDAR");
  });

  it("emits a portable public origin when a reverse proxy preserves host and protocol", async () => {
    const snippet = await getSnippet(
      proxiedRouteRequest(channelReference, "/snippet"),
      routeParams(),
    );

    await expectNoStore(snippet, 200);
    expect(await snippet.text()).toContain(`src="https://public-sympose.example.test/embed/${channelReference}`);
  });

  it("does not reflect malformed forwarded host or protocol values", async () => {
    const request = new Request(`http://localhost:4800/embed/${channelReference}/snippet`, {
      headers: {
        host: "attacker.example.test, public-sympose.example.test",
        "x-forwarded-proto": "javascript",
      },
    });
    const snippet = await getSnippet(request, routeParams());

    await expectNoStore(snippet, 200);
    const body = await snippet.text();
    expect(body).toContain(`src="http://localhost:4800/embed/${channelReference}`);
    expect(body).not.toContain("attacker.example.test");
  });

  it("marks generic denials and invalid calendar selections as no-store", async () => {
    mocks.currentProjection = null;
    const [feed, snippet, calendar] = await Promise.all([
      getFeed(routeRequest("missing-channel", "/feed"), routeParams("missing-channel")),
      getSnippet(routeRequest("missing-channel", "/snippet"), routeParams("missing-channel")),
      getCalendar(routeRequest("missing-channel", "/calendar.ics"), routeParams("missing-channel")),
    ]);

    await expectNoStore(feed, 404);
    await expectNoStore(snippet, 404);
    await expectNoStore(calendar, 404);

    mocks.currentProjection = projection;
    const invalidCalendar = await getCalendar(
      routeRequest(channelReference, "/calendar.ics", "sessions=not-in-this-release"),
      routeParams(),
    );
    await expectNoStore(invalidCalendar, 400);
  });

  it("does not leave an old channel or saved config reference as a cacheable 200 after supersession", async () => {
    const query = `configId=${encodeURIComponent(configurationId)}`;
    const initialResponses = await Promise.all([
      getFeed(routeRequest(channelReference, "/feed", query), routeParams()),
      getSnippet(routeRequest(channelReference, "/snippet", query), routeParams()),
      getCalendar(routeRequest(channelReference, "/calendar.ics", query), routeParams()),
    ]);
    for (const response of initialResponses) await expectNoStore(response, 200);

    mocks.currentChannelReference = replacementChannelReference;
    mocks.currentReleaseId = `${projection.releaseId}-replacement`;
    mocks.currentProjection = null;

    const supersededResponses = await Promise.all([
      getFeed(routeRequest(channelReference, "/feed", query), routeParams()),
      getSnippet(routeRequest(channelReference, "/snippet", query), routeParams()),
      getCalendar(routeRequest(channelReference, "/calendar.ics", query), routeParams()),
    ]);
    for (const response of supersededResponses) await expectNoStore(response, 404);
  });
});
