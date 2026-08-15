import { notFound } from "next/navigation";
import { PublicWidgetBackLink, PublicWidgetShell } from "@/components/public-widgets/public-widget-shell";
import { SessionDetail } from "@/components/public-widgets/session-surfaces";
import { embedPath, resolveEmbedRequest, type EmbedSearchParams } from "../../../_lib";
import { embedQuery } from "@/server/services/public-widgets/embed";
import { firstQueryValue, getPublicAgendaDay, getPublicSession } from "@/server/services/public-widgets/queries";

export const dynamic = "force-dynamic";

export default async function EmbedSessionDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ channelReference: string; sessionReference: string }>;
  readonly searchParams: Promise<EmbedSearchParams>;
}) {
  const [{ channelReference, sessionReference }, query] = await Promise.all([params, searchParams]);
  const request = resolveEmbedRequest(channelReference, query);
  if (!request) notFound();
  const { widget, configuration, configurationId } = request;
  const session = getPublicSession(widget, sessionReference);
  if (!session) notFound();
  const origin = firstQueryValue(query.from);
  const agendaDay = origin === "agenda" ? firstQueryValue(query.day) : "";
  const validAgendaDay = agendaDay ? getPublicAgendaDay(widget, agendaDay) : null;
  const backHref = validAgendaDay
    ? `${embedPath(channelReference, `/agenda/${encodeURIComponent(agendaDay)}`)}?${embedQuery(configuration, configurationId ?? undefined)}`
    : origin === "itinerary"
      ? `${embedPath(channelReference, "/itinerary")}?${embedQuery(configuration, configurationId ?? undefined)}`
    : `${embedPath(channelReference, "/sessions")}?${embedQuery(configuration, configurationId ?? undefined)}`;
  const backLabel = validAgendaDay ? "← Back to agenda" : origin === "itinerary" ? "← My itinerary" : "← All sessions";
  return <PublicWidgetShell widget={widget} active="sessions" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetBackLink href={backHref}>{backLabel}</PublicWidgetBackLink>
    <SessionDetail widget={widget} session={session} configuration={configuration} configurationId={configurationId} />
  </PublicWidgetShell>;
}
