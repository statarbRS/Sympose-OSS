import { notFound } from "next/navigation";
import { ItineraryPanel } from "@/components/public-widgets/itinerary-panel";
import { PublicWidgetHero, PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { toPublicItineraryViewModel } from "@/components/public-widgets/public-widget-client-view";
import { resolveEmbedRequest } from "../../_lib";

export const dynamic = "force-dynamic";

export default async function EmbedItineraryPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ channelReference: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ channelReference }, query] = await Promise.all([params, searchParams]);
  const request = resolveEmbedRequest(channelReference, query);
  if (!request) notFound();
  const { widget, configuration, configurationId } = request;
  return <PublicWidgetShell widget={widget} active="itinerary" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetHero eyebrow="Personal itinerary" title="Keep the sessions you want close" description="Build a favorites-only schedule from the sealed release, browse the full program when you need to add another session, and export the saved set." />
    <ItineraryPanel widget={toPublicItineraryViewModel(widget)} configuration={configuration} configurationId={configurationId} />
  </PublicWidgetShell>;
}
