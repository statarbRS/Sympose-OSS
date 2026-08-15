import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AgendaDayView, AgendaNavigation } from "@/components/public-widgets/agenda-surfaces";
import { ItineraryPanel } from "@/components/public-widgets/itinerary-panel";
import { toPublicItineraryViewModel } from "@/components/public-widgets/public-widget-client-view";
import { PublicWidgetHero, PublicWidgetShell, PublicWidgetSplit } from "@/components/public-widgets/public-widget-shell";
import { SessionDirectory } from "@/components/public-widgets/session-surfaces";
import { SpeakerDirectory, SpeakerGallery } from "@/components/public-widgets/speaker-surfaces";
import { embedPath, resolveEmbedRequest, type EmbedSearchParams } from "../_lib";
import { firstQueryValue, listPublicAgendaDays, type PublicSessionFilters, type PublicSpeakerFilters } from "@/server/services/public-widgets/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Public event widget",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

function filtersFromQuery(query: EmbedSearchParams): PublicSessionFilters {
  return {
    query: firstQueryValue(query.q),
    track: firstQueryValue(query.track),
    format: firstQueryValue(query.format),
  };
}

export default async function PublicEmbedPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ channelReference: string }>;
  readonly searchParams: Promise<EmbedSearchParams>;
}) {
  const [{ channelReference }, query] = await Promise.all([params, searchParams]);
  const request = resolveEmbedRequest(channelReference, query);
  if (!request) notFound();
  const { widget, configuration, configurationId } = request;
  const action = embedPath(channelReference);

  if (configuration.mode === "speakers") {
    const filters: PublicSpeakerFilters = { query: firstQueryValue(query.q) };
    return <PublicWidgetShell widget={widget} active="speakers" configuration={configuration} configurationId={configurationId}><PublicWidgetHero eyebrow="Speaker directory" title="Meet the people shaping the program" description="Public profiles are limited to approved speaker details from this sealed release." /><SpeakerDirectory widget={widget} filters={filters} action={action} showSearch={configuration.search} configuration={configuration} configurationId={configurationId} /></PublicWidgetShell>;
  }

  if (configuration.mode === "gallery") {
    const filters: PublicSpeakerFilters = { query: firstQueryValue(query.q) };
    return <PublicWidgetShell widget={widget} active="gallery" configuration={configuration} configurationId={configurationId}>
      <PublicWidgetHero eyebrow="Speaker gallery" title="See the people behind the program" description="Photo-forward public profiles, ordered by surname and drawn from this sealed release." />
      <SpeakerGallery widget={widget} filters={filters} action={embedPath(channelReference, "/gallery")} showSearch={configuration.search} configuration={configuration} configurationId={configurationId} />
    </PublicWidgetShell>;
  }

  if (configuration.mode === "agenda") {
    const days = listPublicAgendaDays(widget);
    const firstDay = days[0];
    return <PublicWidgetShell widget={widget} active="agenda" configuration={configuration} configurationId={configurationId}>
      <PublicWidgetHero eyebrow="Agenda" title={widget.event.title} description={widget.event.summary} />
      {firstDay ? <PublicWidgetSplit><AgendaDayView widget={widget} day={firstDay} configuration={configuration} configurationId={configurationId} /><AgendaNavigation widget={widget} days={days} activeDate={firstDay.date} configuration={configuration} configurationId={configurationId} /></PublicWidgetSplit> : <p>No public agenda is available.</p>}
    </PublicWidgetShell>;
  }

  if (configuration.mode === "itinerary") {
    return <PublicWidgetShell widget={widget} active="itinerary" configuration={configuration} configurationId={configurationId}>
      <PublicWidgetHero eyebrow="Personal itinerary" title="Keep the sessions you want close" description="A favorites-only schedule from this sealed public release, with a full-program browse mode and calendar export." />
      <ItineraryPanel widget={toPublicItineraryViewModel(widget)} configuration={configuration} configurationId={configurationId} />
    </PublicWidgetShell>;
  }

  return <PublicWidgetShell widget={widget} active="sessions" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetHero eyebrow="Public program" title={widget.event.title} description={widget.event.summary} />
    <SessionDirectory widget={widget} filters={filtersFromQuery(query)} action={action} showSearch={configuration.search} configuration={configuration} configurationId={configurationId} />
  </PublicWidgetShell>;
}
