import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const portalMocks = vi.hoisted(() => ({
  getDb: vi.fn(() => ({})),
  resolvePortalAccess: vi.fn(),
}));

vi.mock("@/server/db", () => ({ getDb: portalMocks.getDb }));
vi.mock("@/server/services/publication", () => ({ resolvePortalAccess: portalMocks.resolvePortalAccess }));

import PortalPage from "@/app/p/[token]/page";
import { DenialError } from "@/server/auth";
import { PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { SpeakerPortal } from "@/components/speaker-portal/speaker-portal";
import { SYNTHETIC_PUBLIC_PROJECTION, toPublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import {
  createSyntheticSpeakerOperationsRepository,
  syntheticSpeakerPortalToken,
} from "@/server/services/speaker-operations";
import { formatDateTime } from "@/components/truth";

const speakerEvent = {
  id: "event-portal-shell-test",
  name: "Synthetic Speaker Forum",
  timezone: "UTC",
  startsAt: "2026-09-15T09:00:00.000Z",
  endsAt: "2026-09-15T17:00:00.000Z",
} as const;

const speakerOrganizer = {
  kind: "organizer" as const,
  workspaceId: "workspace-portal-shell-test",
  eventId: speakerEvent.id,
  actorId: "organizer-portal-shell-test",
};

function expectSkipLinkAndTarget(html: string): void {
  const skipLink = '<a class="skip-link" href="#main-content">Skip to content</a>';
  expect(html).toContain(skipLink);
  expect(html.indexOf(skipLink)).toBeLessThan(html.indexOf("<header"));
  expect(html).toMatch(/<main\b[^>]*id="main-content"[^>]*tabindex="-1"/u);
}

async function renderParticipantPage(): Promise<string> {
  return renderToStaticMarkup(
    await PortalPage({ params: Promise.resolve({ token: "synthetic-participant-token" }) }),
  );
}

describe("role and public shell skip links", () => {
  it("renders the link before each shell header and makes every participant target focusable", async () => {
    portalMocks.resolvePortalAccess.mockImplementationOnce(() => {
      throw new DenialError("TOKEN_INVALID", "This agenda link is not recognized.", "portal-token");
    });
    expectSkipLinkAndTarget(await renderParticipantPage());

    portalMocks.resolvePortalAccess.mockReturnValueOnce({
      event: { name: "Synthetic Participant Event", timezone: "UTC" },
      personName: "Synthetic Participant",
      email: "participant@example.test",
      sealedAt: "2026-08-12T12:00:00.000Z",
      releaseFingerprint: "participant-release-fingerprint",
      agenda: { items: [] },
    });
    const participantHtml = await renderParticipantPage();
    expectSkipLinkAndTarget(participantHtml);
    expect(participantHtml).toContain('data-role-instrument="participant"');
    expect(participantHtml).toContain("What matters now");

    const speakerRepository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:00.000Z" });
    const ada = speakerRepository.listSpeakerRoster(speakerOrganizer, speakerEvent).find((record) => record.person.fullName === "Ada Lovelace");
    if (!ada) throw new Error("synthetic speaker fixture missing");
    const speakerToken = syntheticSpeakerPortalToken(speakerOrganizer.workspaceId, speakerEvent.id, ada.person.personId);
    const speakerProjection = speakerRepository.getPortalProjection(speakerToken);
    if (!speakerProjection) throw new Error("synthetic speaker portal fixture missing");
    const speakerHtml = renderToStaticMarkup(createElement(SpeakerPortal, { projection: speakerProjection, supportPreview: true }));
    expectSkipLinkAndTarget(speakerHtml);
    expect(speakerHtml).toContain("task changes plus profile/text versions and reviews persist in local SQLite");
    expect(speakerHtml).toContain("exact bytes use authenticated local filesystem storage");
    expect(speakerHtml).toContain("only an organizer-approved headshot explicitly bound to a sealed public release");
    expect(speakerHtml).toContain('aria-label="Speaker portal sections"');
    expect(speakerHtml).toContain("What needs you");
    expect(speakerHtml).toContain("Speaker instrument · exact obligations");
    expect(speakerHtml).toContain('data-role-instrument="speaker"');
    expect(speakerHtml).not.toContain("Approve slides");

    const visibleSpeakerText = speakerHtml.replace(/<[^>]*>/gu, " ");
    expect(visibleSpeakerText).toContain("Not started");
    expect(visibleSpeakerText).toContain("Upcoming");
    expect(visibleSpeakerText).toContain(formatDateTime(speakerProjection.tasks[0]!.dueAt));
    expect(visibleSpeakerText).not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/u);
    expect(visibleSpeakerText).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);

    expect(speakerProjection.communications.length).toBeGreaterThan(0);
    const previewProjection = {
      ...speakerProjection,
      communications: speakerProjection.communications.map((evidence) => ({
        ...evidence,
        renderedPreview: `${evidence.renderedPreview} · ${speakerProjection.assignment.schedule.startsAt}`,
      })),
    };
    const previewHtml = renderToStaticMarkup(createElement(SpeakerPortal, { projection: previewProjection, supportPreview: true }));
    const previewText = previewHtml.replace(/<[^>]*>/gu, " ");
    expect(previewText).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);

    const widget = toPublicWidgetProjection(SYNTHETIC_PUBLIC_PROJECTION);
    const syntheticWidgetHtml = renderToStaticMarkup(createElement(
      PublicWidgetShell,
      { widget, active: "sessions", children: createElement("p", null, "Synthetic content") },
    ));
    expectSkipLinkAndTarget(syntheticWidgetHtml);
    expect(syntheticWidgetHtml).toContain('data-testid="canonical-public-event"');
    expect(syntheticWidgetHtml).toContain(`href="/events/${widget.event.publicReference}/agenda"`);
    expect(syntheticWidgetHtml).toContain("Portable presentation surfaces");
    expect(syntheticWidgetHtml).toContain("Configure portable embed");

    const untrustedHexWidget = {
      ...widget,
      release: { ...widget.release, releaseReference: "a".repeat(64) },
    };
    const untrustedHexWidgetHtml = renderToStaticMarkup(createElement(
      PublicWidgetShell,
      { widget: untrustedHexWidget, active: "sessions", children: createElement("p", null, "Untrusted hex content") },
    ));
    expect(untrustedHexWidgetHtml).toContain('data-testid="canonical-public-event-unavailable"');
    expect(untrustedHexWidgetHtml).not.toContain('href="/events/');
  });
});
