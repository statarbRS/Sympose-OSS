import Link from "next/link";

import type {
  DeliveryCenterItem,
  DeliveryCenterProjection,
  DeliveryCenterSourceReport,
  DeliveryCenterStatus,
} from "@/server/services/delivery-center";

import styles from "./delivery-center.module.css";

function statusClass(selectedStatus: DeliveryCenterStatus): string {
  switch (selectedStatus) {
    case "PENDING":
      return styles.pending;
    case "CLAIMED":
      return styles.claimed;
    case "DELIVERED":
      return styles.delivered;
    case "FAILED":
      return styles.failed;
  }
}

function sourceStateClass(source: DeliveryCenterSourceReport): string {
  if (source.state === "READY") return styles.sourceReady;
  if (source.state === "ERROR") return styles.sourceError;
  if (source.state === "UNAVAILABLE") return styles.sourceUnavailable;
  return styles.sourceEmpty;
}

function deliveryPriority(item: DeliveryCenterItem): number {
  if (item.status === "FAILED") return 0;
  if (item.status === "PENDING" && (item.attemptCount ?? 0) > 0 && item.nextAttemptAt !== null) return 1;
  if (item.status === "CLAIMED") return 2;
  if (item.status === "PENDING") return 3;
  return 4;
}

function actionLabel(item: DeliveryCenterItem): string {
  if (item.status === "FAILED") return "Failure recorded";
  if (item.status === "PENDING" && (item.attemptCount ?? 0) > 0 && item.nextAttemptAt !== null) return "Bounded retry scheduled";
  if (item.status === "CLAIMED") return "Local processing";
  if (item.status === "PENDING") return "Queued locally";
  if (item.providerReceipt !== null) return "No-network receipt recorded";
  return "Recorded delivered";
}

function Timestamp({ value, unavailable = "Not recorded" }: { readonly value: string | null; readonly unavailable?: string }) {
  return value === null
    ? <span className={styles.muted}>{unavailable}</span>
    : <time dateTime={value}>{value}</time>;
}

function DeliveryCard({ item }: { readonly item: DeliveryCenterItem }) {
  return (
    <article
      className={`${styles.message} ${statusClass(item.status)}`}
      data-testid="delivery-center-item"
      data-delivery-priority={deliveryPriority(item)}
    >
      <header className={styles.messageHeader}>
        <div>
          <p className={styles.kicker}>{item.sourceLabel}</p>
          <h3>{item.kind}</h3>
          <p className={styles.recipientLine}>
            To {item.recipient.displayName} · <span className={styles.email}>{item.recipient.email}</span>
          </p>
        </div>
        <div className={styles.messageState}>
          <span className={styles.actionLabel}>{actionLabel(item)}</span>
          <span className={`${styles.status} ${statusClass(item.status)}`}>{item.status}</span>
        </div>
      </header>

      <p className={styles.statusMeaning}>{item.statusMeaning}</p>

      <section className={styles.rendered} aria-label={`Rendered message for ${item.recipient.displayName}`}>
        <div>
          <span className={styles.renderedLabel}>Rendered subject</span>
          <p className={styles.subject}>{item.subject}</p>
        </div>
        <div>
          <span className={styles.renderedLabel}>Rendered body</span>
          <p className={styles.body}>{item.body}</p>
        </div>
      </section>

      {item.failureRecorded === true ? (
        <p className={styles.failureNote}>A local failure detail is recorded by the source and withheld from this projection.</p>
      ) : null}

      <details className={styles.queueEvidence}>
        <summary>Inspect queue and timing evidence</summary>
        <dl className={styles.messageFacts}>
          <div>
            <dt>Rendered recipient</dt>
            <dd>{item.recipient.displayName}<br /><span className={styles.email}>{item.recipient.email}</span></dd>
          </div>
          <div>
            <dt>Channel</dt>
            <dd>{item.channel === "local" ? "Local outbox" : "Local inbox simulation"}</dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{item.attemptCount === null ? <span className={styles.muted}>Not exposed by source</span> : item.attemptCount}</dd>
          </div>
          <div>
            <dt>Queued at</dt>
            <dd><Timestamp value={item.queuedAt} /></dd>
          </div>
          <div>
            <dt>Next local attempt</dt>
            <dd><Timestamp value={item.nextAttemptAt} unavailable="Not scheduled or not exposed" /></dd>
          </div>
          <div>
            <dt>Delivered at</dt>
            <dd><Timestamp value={item.deliveredAt} /></dd>
          </div>
          <div>
            <dt>No-network receipt</dt>
            <dd>{item.providerReceipt === null
              ? <span className={styles.muted}>Not recorded</span>
              : <>{item.providerReceipt.id}<br /><Timestamp value={item.providerReceipt.acceptedAt} /></>}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

function SourceCoverage({ sources }: { readonly sources: readonly DeliveryCenterSourceReport[] }) {
  return (
    <section className={styles.section} aria-labelledby="delivery-source-coverage-title">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.kicker}>Contract coverage</p>
          <h2 id="delivery-source-coverage-title">What this page can read</h2>
        </div>
        <span className={styles.readOnlyChip}>Read only</span>
      </div>
      <div className={styles.sourceGrid}>
        {sources.map((source) => (
          <article className={`${styles.sourceCard} ${sourceStateClass(source)}`} key={source.key} data-testid={`delivery-source-${source.key.toLowerCase()}`}>
            <header>
              <h3>{source.label}</h3>
              <span>{source.state}</span>
            </header>
            <p>{source.disclosure}</p>
            <strong>{source.itemCount} rendered record{source.itemCount === 1 ? "" : "s"}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

export function DeliveryCenter({ projection }: { readonly projection: DeliveryCenterProjection }) {
  const orderedItems = projection.items
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .sort((first, second) =>
      deliveryPriority(first.item) - deliveryPriority(second.item) ||
      first.sourceIndex - second.sourceIndex,
    )
    .map(({ item }) => item);
  const scheduledLocalRetries = projection.items.filter(
    (item) => item.status === "PENDING" && (item.attemptCount ?? 0) > 0 && item.nextAttemptAt !== null,
  ).length;

  return (
    <main className={styles.page} data-testid="delivery-center">
      <a className={styles.skipLink} href="#delivery-center-records">Skip to delivery records</a>
      <nav className={styles.contextNav} aria-label="Delivery Center context">
        <Link href={`/w/${projection.workspace.slug}/events`}>All events</Link>
        <Link href={`/w/${projection.workspace.slug}/events/${projection.event.id}/overview`}>Event overview</Link>
        <span aria-current="page">Delivery Center</span>
      </nav>

      <header className={styles.hero}>
        <div>
          <p className={styles.kicker}>Operational communication evidence · {projection.event.name}</p>
          <h1>Delivery Center</h1>
          <p className={styles.lede}>
            Start with failed, bounded-retrying, and receipt-recorded messages. Every card shows
            the exact rendered subject and body before lower-level queue evidence.
          </p>
        </div>
        <dl className={styles.eventFacts}>
          <div><dt>Event timezone</dt><dd>{projection.event.timezone}</dd></div>
          <div><dt>Event lifecycle</dt><dd>{projection.event.lifecycle}</dd></div>
          <div><dt>Workspace</dt><dd>{projection.workspace.name}</dd></div>
        </dl>
      </header>

      <section className={styles.summary} aria-label="Delivery state counts">
        <div className={styles.summaryAttention}><span>FAILED</span><strong>{projection.summary.failed}</strong></div>
        <div><span>LOCAL RETRY SCHEDULED</span><strong>{scheduledLocalRetries}</strong></div>
        <div><span>PENDING</span><strong>{projection.summary.pending}</strong></div>
        <div><span>CLAIMED</span><strong>{projection.summary.claimed}</strong></div>
        <div><span>DELIVERED</span><strong>{projection.summary.delivered}</strong></div>
        <div><span>TOTAL RENDERED</span><strong>{projection.summary.total}</strong></div>
      </section>

      <section className={`${styles.section} ${styles.recordsSection}`} id="delivery-center-records" aria-labelledby="delivery-records-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.kicker}>Attention-first rendered evidence</p>
            <h2 id="delivery-records-title">Event delivery records</h2>
            <p className={styles.sectionIntro}>Failed records lead, followed by bounded retries, active queue states, and receipt-recorded evidence. Source order is retained within each priority.</p>
          </div>
          <span className={styles.recordCount}>{projection.items.length} record{projection.items.length === 1 ? "" : "s"}</span>
        </div>
        {projection.items.length === 0 ? (
          <div className={styles.empty} data-testid="delivery-center-empty">
            <h3>No supported delivery evidence</h3>
            <p>No authorized rendered messages are available from the supported event-scoped projections. Nothing is inferred from generic outbox payloads.</p>
          </div>
        ) : (
          <div className={styles.messages}>{orderedItems.map((item) => <DeliveryCard item={item} key={item.id} />)}</div>
        )}
      </section>

      <section className={styles.boundary} role="note" aria-labelledby="delivery-boundary-title" data-testid="delivery-center-provider-boundary">
        <div className={styles.boundaryIcon} aria-hidden="true">LOCAL</div>
        <div>
          <h2 id="delivery-boundary-title">No provider or SMTP contact</h2>
          <p>{projection.transportDisclosure}</p>
          <p><strong>PENDING</strong> means locally queued or retrying, not sent. <strong>CLAIMED</strong> is local processing. For shared-task reminders, <strong>DELIVERED</strong> means the no-network adapter has a durable simulated receipt—not SMTP or external-provider delivery.</p>
        </div>
      </section>

      <SourceCoverage sources={projection.sources} />
    </main>
  );
}
