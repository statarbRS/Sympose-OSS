import { notFound } from "next/navigation";
import { AgendaDayView, AgendaNavigation } from "@/components/public-widgets/agenda-surfaces";
import { PublicWidgetHero, PublicWidgetShell, PublicWidgetSplit } from "@/components/public-widgets/public-widget-shell";
import { resolveEmbedRequest } from "../../../_lib";
import { getPublicAgendaDay, listPublicAgendaDays } from "@/server/services/public-widgets/queries";

export const dynamic = "force-dynamic";

export default async function EmbedAgendaDayPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ channelReference: string; day: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ channelReference, day }, query] = await Promise.all([params, searchParams]);
  const request = resolveEmbedRequest(channelReference, query);
  if (!request) notFound();
  const { widget, configuration, configurationId } = request;
  const selectedDay = getPublicAgendaDay(widget, day);
  if (!selectedDay) notFound();
  const days = listPublicAgendaDays(widget);
  return <PublicWidgetShell widget={widget} active="agenda" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetHero eyebrow={`Agenda · ${selectedDay.label}`} title={widget.event.title} description="Published sessions for this event day." />
    <PublicWidgetSplit><AgendaDayView widget={widget} day={selectedDay} configuration={configuration} configurationId={configurationId} /><AgendaNavigation widget={widget} days={days} activeDate={selectedDay.date} configuration={configuration} configurationId={configurationId} /></PublicWidgetSplit>
  </PublicWidgetShell>;
}
