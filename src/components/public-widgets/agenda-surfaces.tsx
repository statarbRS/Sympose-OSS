import Link from "next/link";
import type { PublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { embedQuery, type EmbedConfiguration } from "@/server/services/public-widgets/embed";
import type { PublicAgendaDay } from "@/server/services/public-widgets/queries";
import { embedPath } from "@/app/embed/_paths";
import { SessionCard } from "./session-surfaces";
import styles from "./styles.module.css";

function agendaDayPath(
  channelReference: string,
  date: string,
  configuration?: EmbedConfiguration,
  configurationId?: string | null,
): string {
  const query = new URLSearchParams(
    configuration
      ? embedQuery(configuration, configurationId ?? undefined)
      : configurationId
        ? `configId=${encodeURIComponent(configurationId)}`
        : undefined,
  );
  const encoded = query.toString();
  const path = embedPath(channelReference, `/agenda/${encodeURIComponent(date)}`);
  return encoded ? `${path}?${encoded}` : path;
}

export function AgendaNavigation({
  widget,
  days,
  activeDate,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly days: readonly PublicAgendaDay[];
  readonly activeDate?: string;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  return (
    <aside className={styles.sideCard} aria-label="Agenda day navigation">
      <h2>Agenda days</h2>
      <nav className={styles.dayNav}>
        {days.map((day) => (
          <Link className={styles.dayLink} href={agendaDayPath(widget.release.channelReference, day.date, configuration, configurationId)} aria-current={activeDate === day.date ? "page" : undefined} key={day.date}>
            <span className={styles.dayLabel}>{day.label}</span>
            <span className={styles.dayCount}>{day.sessions.length} public sessions</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
export function AgendaDayView({
  widget,
  day,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly day: PublicAgendaDay;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  return (
    <section aria-labelledby="agenda-day-heading" data-testid="agenda-day">
      <div className={styles.sectionHeading}><h2 id="agenda-day-heading">{day.label}</h2><span>{day.sessions.length} sessions</span></div>
      <div className={styles.grid}>
        {day.sessions.map((session) => <SessionCard key={session.publicReference} widget={widget} session={session} configuration={configuration} configurationId={configurationId} detailOrigin={{ surface: "agenda", day: day.date }} />)}
      </div>
    </section>
  );
}
