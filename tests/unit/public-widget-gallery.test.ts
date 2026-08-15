import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicWidgetBackLink, PublicWidgetHero, PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { SpeakerGallery, SpeakerGalleryDetail, speakerGalleryPath } from "@/components/public-widgets/speaker-surfaces";
import { SYNTHETIC_PUBLIC_PROJECTION, toPublicWidgetProjection, type PublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { createSyntheticPublicationState } from "@/server/services/public-agenda";
import { bindPublicAgendaRelease } from "@/server/services/public-widgets/binding";
import { publicReleaseReference } from "@/server/services/public-reference";
import {
  SYNTHETIC_PUBLIC_EVENT_ID,
  SYNTHETIC_PUBLIC_WORKSPACE_ID,
} from "@/server/services/scheduling";
import {
  toPublicEmbedManagerViewModel,
  toPublicItineraryViewModel,
} from "@/components/public-widgets/public-widget-client-view";
import {
  buildEmbedSnippet,
  EMBED_MODES,
  parseEmbedConfiguration,
} from "@/server/services/public-widgets/embed";
import { getEmbedWidget } from "@/app/embed/_lib";
import { getPublicSpeaker, listPublicSpeakers } from "@/server/services/public-widgets/queries";

const widget = toPublicWidgetProjection(SYNTHETIC_PUBLIC_PROJECTION);
const routePublication = createSyntheticPublicationState({
  workspaceId: SYNTHETIC_PUBLIC_WORKSPACE_ID,
  eventId: SYNTHETIC_PUBLIC_EVENT_ID,
});
const routeReference = publicReleaseReference({
  workspaceId: routePublication.currentRelease.workspaceId,
  eventId: routePublication.currentRelease.eventId,
  releaseId: routePublication.currentRelease.id,
});
const routeWidget: PublicWidgetProjection = toPublicWidgetProjection(
  bindPublicAgendaRelease(routePublication.currentRelease, routeReference),
);
const configuration = {
  mode: "gallery",
  theme: "dark",
  accent: "violet",
  search: true,
} as const;
const query = {
  mode: configuration.mode,
  theme: configuration.theme,
  accent: configuration.accent,
  search: "1",
};

function syntheticGalleryMarkup(queryValue = ""): string {
  const children = [
    createElement(PublicWidgetHero, {
      key: "hero",
      eyebrow: "Speaker gallery",
      title: "See the people behind the program",
      description: "Photo-forward public profiles, ordered by surname and drawn from this sealed release.",
    }),
    createElement(SpeakerGallery, {
      key: "gallery",
      widget: routeWidget,
      filters: { query: queryValue },
      action: speakerGalleryPath(routeReference, configuration),
      showSearch: configuration.search,
      configuration,
      configurationId: null,
    }),
  ];
  return renderToStaticMarkup(createElement(
    PublicWidgetShell,
    { widget: routeWidget, active: "gallery", configuration, configurationId: null, children },
  ));
}

describe("public speaker gallery vertical", () => {
  it("does not resolve the synthetic channel through the production request path", () => {
    expect(getEmbedWidget("fixture-public-channel", new URLSearchParams())).toBeNull();
  });

  it("accepts five modes and generates a gallery-specific iframe path", () => {
    expect(EMBED_MODES).toEqual(["sessions", "speakers", "gallery", "agenda", "itinerary"]);
    expect(parseEmbedConfiguration(query)).toEqual(configuration);

    const snippet = buildEmbedSnippet(routeReference, configuration, "https://widgets.example.test");
    expect(snippet).toContain(`https://widgets.example.test/embed/${routeReference}/gallery?mode=gallery&theme=dark&accent=violet&search=1`);
  });

  it("renders the sealed projection in surname order with photo and metadata fallbacks", async () => {
    expect(listPublicSpeakers(widget).map((speaker) => speaker.publicReference)).toEqual(
      expect.arrayContaining(widget.speakers.map((speaker) => speaker.publicReference)),
    );
    expect(listPublicSpeakers(widget).every((speaker) => speaker.publicReference.startsWith("aud1-"))).toBe(true);
    expect(listPublicSpeakers(routeWidget).map((speaker) => speaker.publicReference)).toEqual(
      expect.arrayContaining(routeWidget.speakers.map((speaker) => speaker.publicReference)),
    );
    expect(listPublicSpeakers(routeWidget).every((speaker) => speaker.publicReference.startsWith("aud1-"))).toBe(true);

    const markup = syntheticGalleryMarkup();
    const galleryReferences = listPublicSpeakers(routeWidget)
      .map((speaker) => `data-gallery-speaker-reference="${speaker.publicReference}"`);
    const referenceIndexes = galleryReferences.map((reference) => markup.indexOf(reference));

    expect(markup).toContain('data-testid="speaker-gallery"');
    expect(referenceIndexes.every((index) => index > -1)).toBe(true);
    expect(referenceIndexes).toEqual([...referenceIndexes].sort((first, second) => first - second));
    expect(markup).toContain("Field Notes");
    expect(markup).toContain("Explores the operational side of inclusive events.");
    expect(markup).toContain('aria-label="Jon Bell initials"');
    const routeJon = routeWidget.speakers.find((speaker) => speaker.displayName === "Jon Bell");
    if (!routeJon) throw new Error("synthetic Jon Bell fixture missing");
    expect(markup).toContain(`gallery/${routeJon.publicReference}?mode=gallery&amp;theme=dark&amp;accent=violet&amp;search=1`);
    expect(markup).toContain(routeReference);
    expect(markup).not.toContain("Source artifact fingerprint");
    expect(markup).not.toContain("privateNotes");
  });

  it("keeps canonical public references while excluding release internals from client payloads", () => {
    const managerView = toPublicEmbedManagerViewModel(routeWidget);
    const itineraryView = toPublicItineraryViewModel(routeWidget);

    expect(managerView.release.channelReference).toBe(routeReference);
    expect(JSON.stringify(managerView)).not.toContain("public-widget-projection/v1");
    expect(itineraryView.release.releaseReference).toBe(routeReference);
    expect(JSON.stringify(itineraryView)).not.toContain("public-widget-projection/v1");
    expect(JSON.stringify(itineraryView)).not.toContain(routePublication.currentRelease.id);
    expect(managerView.release.releaseNumber).toBe(routeWidget.release.releaseNumber);
  });

  it("keeps gallery search scoped and gives detail a config-preserving back link", async () => {
    const filteredMarkup = syntheticGalleryMarkup("field notes");
    const filteredJon = routeWidget.speakers.find((speaker) => speaker.displayName === "Jon Bell");
    const filteredMila = routeWidget.speakers.find((speaker) => speaker.displayName === "Mila Chen");
    if (!filteredJon || !filteredMila) throw new Error("synthetic gallery search fixtures missing");
    expect(filteredMarkup).toContain(`data-gallery-speaker-reference="${filteredJon.publicReference}"`);
    expect(filteredMarkup).not.toContain(`data-gallery-speaker-reference="${filteredMila.publicReference}"`);

    const speaker = getPublicSpeaker(routeWidget, filteredJon.publicReference);
    if (!speaker) throw new Error("synthetic gallery speaker fixture missing");
    const detailChildren = [
      createElement(PublicWidgetBackLink, { key: "back", href: speakerGalleryPath(routeReference, configuration), children: "← Back to gallery" }),
      createElement(SpeakerGalleryDetail, { key: "detail", widget: routeWidget, speaker, configuration, configurationId: null }),
    ];
    const detailMarkup = renderToStaticMarkup(createElement(
      PublicWidgetShell,
      { widget: routeWidget, active: "gallery", configuration, configurationId: null, children: detailChildren },
    ));
    const expectedBackPath = speakerGalleryPath(routeReference, configuration);

    expect(detailMarkup).toContain('data-testid="speaker-gallery-detail"');
    expect(detailMarkup).toContain("Field Notes");
    expect(detailMarkup).toContain("Explores the operational side of inclusive events.");
    expect(detailMarkup).toContain("Published sessions");
    expect(detailMarkup).toContain(`sessions/${filteredJon.sessionReferences[0]}?mode=gallery&amp;theme=dark&amp;accent=violet&amp;search=1`);
    expect(detailMarkup).toContain(`href="${expectedBackPath.replaceAll("&", "&amp;")}"`);
    expect(detailMarkup).toContain("← Back to gallery");
    expect(detailMarkup).not.toContain("privateNotes");
  });

  it("keeps an absent speaker profile truthful without expanding the no-photo card", () => {
    const seededSpeaker = routeWidget.speakers[0];
    if (!seededSpeaker) throw new Error("synthetic speaker fixture missing");
    const absentProfileSpeaker = {
      ...seededSpeaker,
      publicReference: "aud1-no-profile",
      displayName: "No Profile Speaker",
      headline: null,
      organization: null,
      bio: null,
      photoUrl: null,
    };
    const absentProfileWidget: PublicWidgetProjection = {
      ...routeWidget,
      speakers: [absentProfileSpeaker],
    };
    const markup = renderToStaticMarkup(createElement(SpeakerGallery, {
      widget: absentProfileWidget,
      filters: {},
      action: speakerGalleryPath(routeReference, configuration),
      showSearch: false,
      configuration,
      configurationId: null,
    }));

    expect(markup).toContain('data-testid="speaker-gallery"');
    expect(markup).toContain('aria-label="No Profile Speaker initials"');
    expect(markup).toContain(">NP<");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("biography");
    expect(markup).not.toContain("unavailable");
  });
});
