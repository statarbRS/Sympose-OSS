import { notFound } from "next/navigation";
import { PublicWidgetHero, PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { SessionDirectory } from "@/components/public-widgets/session-surfaces";
import { embedPath, resolveEmbedRequest, type EmbedSearchParams } from "../../_lib";
import { firstQueryValue, type PublicSessionFilters } from "@/server/services/public-widgets/queries";

export const dynamic = "force-dynamic";

export default async function EmbedSessionsPage({
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
  const filters: PublicSessionFilters = {
    query: firstQueryValue(query.q),
    track: firstQueryValue(query.track),
    format: firstQueryValue(query.format),
    day: firstQueryValue(query.day),
  };
  return <PublicWidgetShell widget={widget} active="sessions" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetHero eyebrow="Sessions" title="Find your next conversation" description="Browse the approved public program by topic, format, speaker, or room." />
    <SessionDirectory widget={widget} filters={filters} action={embedPath(channelReference, "/sessions")} showSearch={configuration.search} configuration={configuration} configurationId={configurationId} />
  </PublicWidgetShell>;
}
