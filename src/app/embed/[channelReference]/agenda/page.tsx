import { notFound } from "next/navigation";
import { AgendaDayView, AgendaNavigation } from "@/components/public-widgets/agenda-surfaces";
import { PublicWidgetHero, PublicWidgetShell, PublicWidgetSplit } from "@/components/public-widgets/public-widget-shell";
import { resolveEmbedRequest } from "../../_lib";
import { listPublicAgendaDays } from "@/server/services/public-widgets/queries";

export const dynamic = "force-dynamic";

export default async function EmbedAgendaPage({
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
  const days = listPublicAgendaDays(widget);
  const firstDay = days[0];
  return <PublicWidgetShell widget={widget} active="agenda" configuration={configuration} configurationId={configurationId}>
    <PublicWidgetHero eyebrow="Agenda" title="Move through the program by day" description="Every card below comes from the same sealed public session projection as the sessions directory." />
    {firstDay ? <PublicWidgetSplit><AgendaDayView widget={widget} day={firstDay} configuration={configuration} configurationId={configurationId} /><AgendaNavigation widget={widget} days={days} activeDate={firstDay.date} configuration={configuration} configurationId={configurationId} /></PublicWidgetSplit> : <p>No public agenda is available.</p>}
  </PublicWidgetShell>;
}
