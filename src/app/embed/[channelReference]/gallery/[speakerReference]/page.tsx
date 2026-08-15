import { notFound } from "next/navigation";
import { PublicWidgetBackLink, PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { SpeakerGalleryDetail, speakerGalleryPath } from "@/components/public-widgets/speaker-surfaces";
import { resolveEmbedRequest, type EmbedSearchParams } from "../../../_lib";
import { firstQueryValue, getPublicSpeaker } from "@/server/services/public-widgets/queries";

export const dynamic = "force-dynamic";

export default async function EmbedGallerySpeakerDetailPage({
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
  const filterQuery = firstQueryValue(query.q);
  return <PublicWidgetShell widget={widget} active="gallery" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetBackLink href={speakerGalleryPath(channelReference, configuration, filterQuery, configurationId ?? undefined)}>← Back to gallery</PublicWidgetBackLink>
    <SpeakerGalleryDetail widget={widget} speaker={speaker} configuration={configuration} configurationId={configurationId} />
  </PublicWidgetShell>;
}
