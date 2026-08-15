import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/events/public-fingerprint/agenda",
}));

import {
  PublicAgenda,
  PublicSessionDetail,
  PublicSpeakerDetail,
} from "@/components/public-agenda/public-agenda";
import { toPublicAgendaViewModel } from "@/components/public-agenda/public-agenda-view-model";
import { createSyntheticPublicationState } from "@/server/services/public-agenda";
import type { DurablePublicEventProjection } from "@/server/services/public-agenda/types";
import {
  publicPersonReference,
  publicProgramUnitReference,
  publicReleaseReference,
} from "@/server/services/public-reference";

const durableScope = {
  workspaceId: "workspace-brand-test",
  eventId: "event-brand-test",
  releaseId: "release-brand-test",
} as const;
const durableReleaseReference = publicReleaseReference(durableScope);
const durableSessionReference = publicProgramUnitReference(durableScope, "building-accountable-gatherings");
const durableSpeakerReference = publicPersonReference(durableScope, "ari-morgan");

const durableProjection: DurablePublicEventProjection = {
  schema: "public-event/durable-publication-release-v2",
  event: {
    slug: durableReleaseReference,
    name: "Assembly for Civic Systems",
    timezone: "America/New_York",
    startsAt: "2026-10-08T13:00:00.000Z",
    endsAt: "2026-10-09T21:00:00.000Z",
  },
  release: {
    releaseReference: durableReleaseReference,
    sealedAt: "2026-09-30T16:00:00.000Z",
    audience: "PUBLIC",
  },
  days: [{ id: "2026-10-08", date: "2026-10-08", label: "Thursday, October 8" }],
  sessions: [{
    slug: durableSessionReference,
    title: "Building accountable gatherings",
    date: "2026-10-08",
    startsAt: "2026-10-08T13:00:00.000Z",
    endsAt: "2026-10-08T14:00:00.000Z",
    speakerSlugs: [durableSpeakerReference],
  }],
  speakers: [{
    slug: durableSpeakerReference,
    name: "Ari Morgan",
    sessionSlugs: [durableSessionReference],
    roles: ["Moderator"],
  }],
  redaction: {
    omittedFields: [
      "Room and venue",
      "Session abstract",
      "Speaker organization and biography",
    ],
  },
};

describe("public agenda branded identity", () => {
  it("builds the event identity and schedule hierarchy only from durable sealed facts", () => {
    const attendeeView = toPublicAgendaViewModel(durableProjection);
    const html = renderToStaticMarkup(createElement(PublicAgenda, {
      initialProjection: attendeeView,
    }));

    expect(html).toContain('aria-label="Sympose public event program"');
    expect(html).toContain(">Sympose<");
    expect(html).toContain("Assembly for Civic Systems");
    expect(html).toMatch(/October 8.*9, 2026/u);
    expect(html).toContain("America/New_York");
    expect(html).toContain("Sealed public release");
    expect(html).toContain('dateTime="2026-09-30T16:00:00.000Z"');
    expect(html).toContain('data-testid="public-source-release"');
    expect(html).toContain("internal release identifiers are not shown");
    expect(JSON.stringify(attendeeView)).not.toContain(durableScope.releaseId);
    expect(html).not.toContain(durableScope.releaseId);
    expect(html).not.toContain("public-event/durable-publication-release-v2");
    expect(html).toContain("Building accountable gatherings");
    expect(html).toContain("Ari Morgan");
    expect(html).toContain("Thu, Oct 8");
    expect(html).toContain('dateTime="2026-10-08"');
    expect(html).not.toMatch(/>2026-10-08</u);
    expect(html).not.toContain("Wed, Oct 7");
    expect(html).toContain(`href="sessions/${durableSessionReference}"`);
    expect(html).toContain(`href="speakers/${durableSpeakerReference}"`);
    expect(html).toContain('aria-controls="public-agenda-list"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('role="search"');
    expect(html).toContain("Search sessions and people");
    expect(html).toContain("My itinerary (0)");
    expect(html).toContain("Room and venue");
    expect(html).not.toContain("Grand Ballroom");
    expect(html).not.toContain("Imaginary Sponsor");
    expect(html).not.toContain("/embed/");
  });

  it("keeps projected speaker, navigation, day filtering, and redaction semantics intact", () => {
    const attendeeView = toPublicAgendaViewModel(durableProjection);
    const speakerHtml = renderToStaticMarkup(createElement(PublicSpeakerDetail, {
      projection: attendeeView,
      speakerSlug: durableSpeakerReference,
    }));
    const sessionHtml = renderToStaticMarkup(createElement(PublicSessionDetail, {
      projection: attendeeView,
      sessionSlug: durableSessionReference,
    }));

    expect(speakerHtml).toContain("Accepted roles: Moderator");
    expect(speakerHtml).toContain("Building accountable gatherings");
    expect(speakerHtml).toContain("Profile details are not included in this public release.");
    expect(sessionHtml).toContain("Ari Morgan");
    expect(sessionHtml).toContain("America/New_York");
    expect(sessionHtml).toContain("Session description is not included in this public release.");
    expect(sessionHtml).toContain("Location is not included in this public release.");
    expect(sessionHtml).toContain("Thu, Oct 8");
    expect(sessionHtml).toContain('dateTime="2026-10-08"');
    expect(sessionHtml).not.toMatch(/>2026-10-08</u);
    expect(speakerHtml).toContain("Thu, Oct 8");
    expect(speakerHtml).toContain('dateTime="2026-10-08"');
    expect(speakerHtml).not.toMatch(/>2026-10-08</u);
    expect(sessionHtml).toContain('href="../agenda"');

    const publicState = createSyntheticPublicationState();
    const legacyReleaseReference = publicReleaseReference({
      workspaceId: publicState.currentRelease.workspaceId,
      eventId: publicState.currentRelease.eventId,
      releaseId: publicState.currentRelease.id,
    });
    const publicProjection = toPublicAgendaViewModel(
      publicState.currentRelease.projection,
      legacyReleaseReference,
    );
    const publicHtml = renderToStaticMarkup(createElement(PublicAgenda, {
      initialProjection: publicProjection,
    }));

    expect(publicHtml).toContain("Sympose Summit 2026");
    expect(publicHtml).toMatch(/September 15.*16, 2026/u);
    expect(publicHtml).toContain("Published release");
    expect(publicHtml).toContain("Tue, Sep 15");
    expect(publicHtml).toContain("Trust is a schedule");
    expect(publicHtml).not.toContain("Operations without surprises");
    expect(publicHtml).toContain('id="agenda-track"');
    expect(publicHtml).toContain(`href="/embed/${legacyReleaseReference}"`);
    expect(publicHtml).toContain(`href="/embed/${legacyReleaseReference}/configure"`);
    expect(publicHtml).not.toContain("private@example.test");
    expect(publicHtml).not.toContain("organizer-only");
  });
});
