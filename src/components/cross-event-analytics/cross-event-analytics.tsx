import Link from "next/link";

import type {
  AnalyticsMetricKey,
  CrossEventAnalyticsModel,
  EventMetricCell,
  MetricRollup,
} from "./model";

import styles from "./cross-event-analytics.module.css";

const METRIC_PATHS: Readonly<Record<AnalyticsMetricKey, string>> = {
  submissions: "cfp",
  reviews: "review",
  speakers: "speakers",
  schedule: "program",
  publication: "publication",
};

function metricStateLabel(metric: Pick<MetricRollup, "state" | "partial">): string {
  if (metric.state === "unavailable") return "Unavailable";
  if (metric.partial) return "Partial coverage";
  if (metric.state === "empty") return "No qualifying records";
  return "Available";
}

function componentSummary(metric: MetricRollup): string | null {
  if (metric.state === "unavailable") return null;
  const counts = metric.components;
  if (metric.key === "submissions") {
    return `Draft ${counts.draft ?? 0} · Submitted ${counts.submitted ?? 0} · Withdrawn ${counts.withdrawn ?? 0} · Invalidated ${counts.invalidated ?? 0}`;
  }
  if (metric.key === "reviews") {
    return `Assigned ${counts.assigned ?? 0} · In progress ${counts.inProgress ?? 0} · Submitted ${counts.submitted ?? 0} · Excluded: ${counts.recused ?? 0} recused, ${counts.revoked ?? 0} revoked`;
  }
  if (metric.key === "schedule") {
    const accepted = counts.accepted ?? 0;
    const scheduled = counts.scheduled ?? 0;
    return `${scheduled} scheduled · ${Math.max(0, accepted - scheduled)} unscheduled accepted handoffs`;
  }
  if (metric.key === "publication") {
    return `${counts.healthy ?? 0} validated current · ${counts.notPublished ?? 0} not published`;
  }
  return null;
}

function MetricCard({ metric }: { readonly metric: MetricRollup }) {
  const summary = componentSummary(metric);
  const coverage = metric.totalEvents === 0
    ? "No workspace events"
    : `${metric.measuredEvents} of ${metric.totalEvents} events measured`;
  return (
    <section className={styles.metricCard} aria-labelledby={`metric-${metric.key}`}>
      <div className={styles.metricHeader}>
        <div>
          <p className={styles.eyebrow}>{metric.eyebrow}</p>
          <h2 id={`metric-${metric.key}`}>{metric.title}</h2>
        </div>
        <span className={`${styles.state} ${styles[`state_${metric.state}`]}`}>
          {metricStateLabel(metric)}
        </span>
      </div>
      <p className={styles.metricValue}>{metric.value}</p>
      {summary ? <p className={styles.breakdown}>{summary}</p> : null}
      {metric.state === "unavailable" ? (
        <p className={styles.unavailable}>No authoritative persisted projection supports this workspace rollup.</p>
      ) : null}
      <dl className={styles.definitionList}>
        <div>
          <dt>Numerator</dt>
          <dd>{metric.numeratorLabel}</dd>
        </div>
        <div>
          <dt>Denominator</dt>
          <dd>{metric.denominatorLabel}</dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>{coverage}</dd>
        </div>
        <div>
          <dt>Definition</dt>
          <dd>{metric.definition}</dd>
        </div>
      </dl>
      <details className={styles.boundary}>
        <summary>Source boundary and exclusions</summary>
        <p>{metric.boundary}</p>
        <p>{metric.exclusions}</p>
      </details>
    </section>
  );
}

function EventMetric({
  cell,
  href,
  label,
  eventName,
}: {
  readonly cell: EventMetricCell;
  readonly href: string;
  readonly label: string;
  readonly eventName: string;
}) {
  return (
    <div className={styles.eventMetric}>
      <strong>{cell.value}</strong>
      <span>{cell.detail}</span>
      {cell.sourceTimestamp ? (
        <span>Sealed <time dateTime={cell.sourceTimestamp}>{cell.sourceTimestamp}</time></span>
      ) : null}
      <Link href={href} aria-label={`Open ${label.toLowerCase()} for ${eventName}`}>
        Open event view <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

export function CrossEventAnalytics({ model }: { readonly model: CrossEventAnalyticsModel }) {
  const workspacePath = `/w/${encodeURIComponent(model.workspaceSlug)}`;
  const metricByKey = new Map(model.metrics.map((metric) => [metric.key, metric]));

  return (
    <article className={styles.page} data-testid="cross-event-analytics">
      <nav className={styles.breadcrumbs} aria-label="Workspace analytics navigation">
        <Link href={`${workspacePath}/dashboard`}>Workspace dashboard</Link>
        <span aria-hidden="true">/</span>
        <Link href={`${workspacePath}/events`}>All events</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Analytics</span>
      </nav>

      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Workspace analytics · read only</p>
          <h1>Cross-event operating signals</h1>
          <p>
            Current persisted evidence across {model.workspaceName}. Each measure keeps its own
            truth boundary, denominator, exclusions, and event drilldown.
          </p>
        </div>
        <div className={styles.eventCount} aria-label={`${model.events.length} workspace events`}>
          <strong>{model.events.length}</strong>
          <span>{model.events.length === 1 ? "event" : "events"}</span>
        </div>
      </header>

      {model.events.length === 0 ? (
        <section className={styles.emptyWorkspace} aria-labelledby="analytics-empty-title">
          <p className={styles.eyebrow}>Empty workspace</p>
          <h2 id="analytics-empty-title">No events to compare</h2>
          <p>Analytics will appear after this workspace has an event. No counts or completion rates are inferred.</p>
          <Link href={`${workspacePath}/events`}>Open all events</Link>
        </section>
      ) : (
        <>
          <section className={styles.metricGrid} aria-label="Workspace metric rollups">
            {model.metrics.map((metric) => <MetricCard key={metric.key} metric={metric} />)}
          </section>

          <section className={styles.drilldown} aria-labelledby="event-drilldown-title">
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.eyebrow}>Event-level evidence</p>
                <h2 id="event-drilldown-title">Compare measured sources</h2>
              </div>
              <p>N/A means the source cannot support the metric; it never means zero.</p>
            </div>
            <div
              className={styles.tableRegion}
              role="region"
              aria-label="Cross-event analytics detail"
              tabIndex={0}
            >
              <table className={styles.table}>
                <caption>Current workspace metrics with navigation to the related event-level workflow views</caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    {model.metrics.map((metric) => <th scope="col" key={metric.key}>{metric.title}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {model.events.map((row) => {
                    const eventPath = `${workspacePath}/events/${encodeURIComponent(row.event.id)}`;
                    return (
                      <tr key={row.event.id}>
                        <th scope="row">
                          <Link className={styles.eventLink} href={`${eventPath}/overview`}>{row.event.name}</Link>
                          <span>{row.event.lifecycle} · {row.event.timezone}</span>
                        </th>
                        {(Object.keys(METRIC_PATHS) as AnalyticsMetricKey[]).map((key) => (
                          <td key={key} data-state={row.metrics[key].state}>
                            <EventMetric
                              cell={row.metrics[key]}
                              href={`${eventPath}/${METRIC_PATHS[key]}`}
                              label={metricByKey.get(key)?.title ?? key}
                              eventName={row.event.name}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </article>
  );
}
