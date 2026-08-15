import { notFound } from "next/navigation";
import { PublicWidgetBackLink, PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { SpeakerDetail } from "@/components/public-widgets/speaker-surfaces";
import { embedPath, resolveEmbedRequest, type EmbedSearchParams } from "../../../_lib";
import { embedQuery } from "@/server/services/public-widgets/embed";
import { getPublicSpeaker } from "@/server/services/public-widgets/queries";

export const dynamic = "force-dynamic";

export default async function EmbedSpeakerDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ channelReference: string; speakerReference: string }>;
  readonly searchParams: Promise<EmbedSearchParams>;
}) {
  const [{ channelReference, speakerReference }, query] = await Promise.all([params, searchParams]);
  const request = resolveEmbedRequest(channelReference, query);
  if (!request) notFound();
  const { widget, configuration, configurationId } = request;
  const speaker = getPublicSpeaker(widget, speakerReference);
  if (!speaker) notFound();
  return <PublicWidgetShell widget={widget} active="speakers" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetBackLink href={`${embedPath(channelReference, "/speakers")}?${embedQuery(configuration, configurationId ?? undefined)}`}>← Speaker directory</PublicWidgetBackLink>
    <SpeakerDetail widget={widget} speaker={speaker} configuration={configuration} configurationId={configurationId} />
  </PublicWidgetShell>;
}
