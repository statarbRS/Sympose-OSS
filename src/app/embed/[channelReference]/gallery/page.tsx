import { notFound } from "next/navigation";
import { PublicWidgetHero, PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { SpeakerGallery } from "@/components/public-widgets/speaker-surfaces";
import { embedPath, resolveEmbedRequest, type EmbedSearchParams } from "../../_lib";
import { firstQueryValue, type PublicSpeakerFilters } from "@/server/services/public-widgets/queries";

export const dynamic = "force-dynamic";

export default async function EmbedGalleryPage({
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
  const filters: PublicSpeakerFilters = { query: firstQueryValue(query.q) };
  return <PublicWidgetShell widget={widget} active="gallery" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetHero eyebrow="Speaker gallery" title="See the people behind the program" description="Photo-forward public profiles, ordered by surname and drawn from this sealed release." />
    <SpeakerGallery widget={widget} filters={filters} action={embedPath(channelReference, "/gallery")} showSearch={configuration.search} configuration={configuration} configurationId={configurationId} />
  </PublicWidgetShell>;
}
