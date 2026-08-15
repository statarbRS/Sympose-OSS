import { notFound } from "next/navigation";
import { PublicWidgetHero, PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { SpeakerDirectory } from "@/components/public-widgets/speaker-surfaces";
import { embedPath, resolveEmbedRequest, type EmbedSearchParams } from "../../_lib";
import { firstQueryValue, type PublicSpeakerFilters } from "@/server/services/public-widgets/queries";

export const dynamic = "force-dynamic";

export default async function EmbedSpeakersPage({
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
  return <PublicWidgetShell widget={widget} active="speakers" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetHero eyebrow="Speaker directory" title="Meet the people shaping the program" description="Public profiles are limited to approved speaker details from this sealed release." />
    <SpeakerDirectory widget={widget} filters={filters} action={embedPath(channelReference, "/speakers")} showSearch={configuration.search} configuration={configuration} configurationId={configurationId} />
  </PublicWidgetShell>;
}
