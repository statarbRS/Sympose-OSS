import { notFound } from "next/navigation";
import { EmbedManager } from "@/components/public-widgets/embed-manager";
import { PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { toPublicEmbedManagerViewModel } from "@/components/public-widgets/public-widget-client-view";
import { resolveEmbedRequest } from "../../_lib";

export const dynamic = "force-dynamic";

export default async function EmbedConfigurePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ channelReference: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ channelReference }, query] = await Promise.all([params, searchParams]);
  const request = resolveEmbedRequest(channelReference, query);
  if (!request) notFound();
  return <PublicWidgetShell widget={request.widget} active="configure" configuration={request.configuration} configurationId={request.configurationId}><EmbedManager widget={toPublicEmbedManagerViewModel(request.widget)} configuration={request.configuration} configurationId={request.configurationId} publicPreview /></PublicWidgetShell>;
}
