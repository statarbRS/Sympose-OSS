import Link from "next/link";
import type { ReactNode } from "react";

import type {
  CapacityLedger,
  CapacityPool,
  CapacityTransferHistoryEntry,
} from "@/server/services/program-capacity";

import styles from "./product-surface.module.css";

type EventSurfaceKind = "overview" | "readiness" | "cfp" | "review" | "program" | "plan" | "speakers" | "publication" | "operations";

const eventDestinations: ReadonlyArray<{
  kind: EventSurfaceKind | "memory";
  label: string;
}> = [
  { kind: "overview", label: "Overview" },
  { kind: "readiness", label: "Readiness" },
  { kind: "cfp", label: "Call for proposals" },
  { kind: "review", label: "Review" },
  { kind: "program", label: "Plan Studio" },
  { kind: "plan", label: "Plan evidence" },
  { kind: "speakers", label: "Speakers" },
  { kind: "publication", label: "Publication" },
  { kind: "operations", label: "Operations" },
  { kind: "memory", label: "Memory" },
];

function eventDestinationHref(
  workspace: string,
  eventId: string,
  kind: (typeof eventDestinations)[number]["kind"],
): string {
  if (kind === "overview") return `/w/${workspace}/events/${eventId}/overview`;
  if (kind === "plan") return `/w/${workspace}/events/${eventId}/plan`;
  if (kind === "publication") return `/w/${workspace}/events/${eventId}/publication`;
  if (kind === "memory") return `/w/${workspace}/memory`;
  return `/w/${workspace}/events/${eventId}/${kind}`;
}

function eventDateLabel(startsAt: string | undefined, timezone: string | undefined): string | null {
  if (!startsAt) return null;
  const instant = new Date(startsAt);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: timezone,
    }).format(instant);
  } catch {
    return null;
  }
}

export function StatePanel({
  kind,
  title,
  children,
}: {
  kind: "unavailable" | "permission" | "stale" | "empty";
  title: string;
  children: ReactNode;
}) {
  const tone = kind === "unavailable"
    ? styles.stateUnavailable
    : kind === "permission"
      ? styles.statePermission
      : kind === "stale"
        ? styles.stateStale
        : "";
  return (
    <div className={`${styles.state} ${tone}`} role={kind === "unavailable" ? "status" : undefined}>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

export function LoadingState({ children = "Loading authoritative data…" }: { children?: ReactNode }) {
  return <div aria-busy="true"><StatePanel kind="empty" title="Loading">{children}</StatePanel></div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <StatePanel kind="empty" title="No authorized records">{children}</StatePanel>;
}

export function PermissionNotice({ children }: { children: ReactNode }) {
  return <StatePanel kind="permission" title="Permission-limited">{children}</StatePanel>;
}

export function StaleNotice({ children }: { children: ReactNode }) {
  return <StatePanel kind="stale" title="Authoritative data may be stale">{children}</StatePanel>;
}

export function UnavailableState({ children }: { children: ReactNode }) {
  return <StatePanel kind="unavailable" title="Dependency unavailable">{children}</StatePanel>;
}

export function EventProductSurface({
  workspace,
  event,
  active,
  eyebrow,
  title,
  description,
  children,
}: {
  workspace: string;
  event: {
    id: string;
    name: string;
    startsAt?: string;
    endsAt?: string;
    timezone?: string;
  };
  active: EventSurfaceKind;
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <article className={styles.surface} data-surface={active}>
      <a className={styles.skipLink} href="#event-surface-main">Skip to event surface</a>
      <nav
        className={`${styles.contextNav} ${active === "operations" ? styles.operationsContextNav : ""}`}
        aria-label="Event product surfaces"
        data-event-context-nav={active === "operations" ? "operations" : undefined}
      >
        <Link className={styles.contextLink} href={`/w/${workspace}/events`} data-testid="all-events-link">
          All events
        </Link>
        {eventDestinations.map((destination) => (
          <Link
            key={destination.kind}
            aria-current={destination.kind === active ? "page" : undefined}
            className={`${styles.contextLink} ${destination.kind === active ? styles.contextLinkActive : ""}`}
            href={eventDestinationHref(workspace, event.id, destination.kind)}
          >
            {destination.label}
          </Link>
        ))}
      </nav>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1>{title}</h1>
          <p className={styles.lede}>{description}</p>
          <div className={styles.eventIdentity} aria-label={`Event identity: ${event.name}`}>
            <span className={styles.eventIdentityMark} aria-hidden="true">S</span>
            <span>
              <strong data-event-name={event.name}>{event.name}</strong>
              <small>
                {eventDateLabel(event.startsAt, event.timezone) ?? "Event date not available"}
                {event.timezone ? ` · event time ${event.timezone}` : ""}
              </small>
            </span>
          </div>
        </div>
        <TruthLayerKey />
      </header>
      <div id="event-surface-main" role="region" aria-label={`${title} event surface`}>{children}</div>
    </article>
  );
}

export function WorkspaceMemorySurface({
  workspace,
  workspaceName,
  children,
}: {
  workspace: string;
  workspaceName: string;
  children: ReactNode;
}) {
  return (
    <article className={styles.surface} data-surface="memory">
      <a className={styles.skipLink} href="#memory-surface-main">Skip to memory surface</a>
      <nav className={styles.contextNav} aria-label="Workspace product surfaces">
        <Link className={styles.contextLink} href={`/w/${workspace}/dashboard`}>Overview</Link>
        <Link aria-current="page" className={`${styles.contextLink} ${styles.contextLinkActive}`} href={`/w/${workspace}/memory`}>Memory</Link>
      </nav>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Institutional Memory · {workspaceName}</p>
          <h1>Evidence across events</h1>
          <p className={styles.lede}>Workspace-scoped history without creating event-local copies of people, proposals, or truth.</p>
        </div>
        <TruthLayerKey />
      </header>
      <div id="memory-surface-main" role="region" aria-label="Institutional memory surface">{children}</div>
    </article>
  );
}

function TruthLayerKey() {
  return (
    <div className={styles.truthKey} aria-label="Truth layers shown">
      <span><i aria-hidden="true" />Candidate evidence</span>
      <span><i aria-hidden="true" />Decision</span>
      <span><i aria-hidden="true" />Commitment</span>
      <span><i aria-hidden="true" />Operational</span>
    </div>
  );
}

export function SurfaceSection({
  title,
  children,
  id: sectionId,
}: {
  title: string;
  children: ReactNode;
  id?: string;
}) {
  const headingId = `${sectionId ?? title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-title`;
  return <section id={sectionId} className={styles.section} aria-labelledby={headingId}><h2 id={headingId}>{title}</h2>{children}</section>;
}

function boundedText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function policySummary(value: unknown): string {
  return value === null || value === undefined ? "Not configured" : "Configured";
}

function WithheldPolicyDetail({ value }: { value: unknown }) {
  return <span>{policySummary(value)}<br /><span className={styles.muted}>Details withheld from this projection</span></span>;
}

export function ProgramCapacityProjection({
  ledger,
  pools,
  history,
}: {
  ledger: CapacityLedger;
  pools: readonly CapacityPool[];
  history: readonly CapacityTransferHistoryEntry[];
}) {
  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  return (
    <div className={styles.capacityStack}>
      <section aria-labelledby="capacity-balances-title">
        <h3 id="capacity-balances-title">Server-owned balance projection</h3>
        <p className={styles.muted}>Calculated by the existing P3 service at sequence {ledger.sequenceNumber}. This is a current balance projection, not the append-only decision ledger.</p>
        {ledger.pools.length === 0 ? (
          <EmptyState>No capacity pools exist for this event.</EmptyState>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Capacity balances returned by the server-owned projection</caption>
              <thead><tr><th scope="col">Pool</th><th scope="col">Unit</th><th scope="col">Configured</th><th scope="col">Available</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Balance version</th><th scope="col">Latest version</th></tr></thead>
              <tbody>{ledger.pools.map((pool) => (
                <tr key={pool.poolId}>
                  <td data-label="Pool">{boundedText(pool.poolName, 128)}</td><td data-label="Unit">{boundedText(pool.unitKind, 64)}</td><td data-label="Configured">{pool.capacity}</td><td data-label="Available">{pool.remaining}</td><td data-label="In">{pool.transferredIn}</td><td data-label="Out">{pool.transferredOut}</td><td data-label="Balance version"><code>{boundedText(pool.versionId, 128)}</code> · v{pool.versionNumber}</td><td data-label="Latest version"><code>{boundedText(pool.latestVersionId, 128)}</code> · v{pool.latestVersionNumber}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <dl className={styles.definitionGrid}>
          <div><dt>Total configured</dt><dd>{ledger.totalCapacity}</dd></div>
          <div><dt>Total available</dt><dd>{ledger.totalRemaining}</dd></div>
          <div><dt>Projection fingerprint</dt><dd><code>{ledger.ledgerFingerprint}</code></dd></div>
        </dl>
      </section>

      <section aria-labelledby="capacity-policies-title">
        <h3 id="capacity-policies-title">Pool policy and source versions</h3>
        {pools.length === 0 ? <EmptyState>No pool definitions are available.</EmptyState> : (
          <div className={styles.tableWrap}><table className={styles.table}>
            <caption>Current immutable pool definitions returned by the capacity service</caption>
            <thead><tr><th scope="col">Pool / version</th><th scope="col">Scope</th><th scope="col">Eligibility</th><th scope="col">Reserved for</th><th scope="col">Release policy</th><th scope="col">Effective</th><th scope="col">Source evidence</th></tr></thead>
            <tbody>{pools.map((pool) => <tr key={pool.id}>
              <td data-label="Pool / version">{boundedText(pool.name, 128)}<br /><code>{boundedText(pool.currentVersion.id, 128)}</code> · v{pool.currentVersion.versionNumber}</td>
              <td data-label="Scope"><WithheldPolicyDetail value={pool.currentVersion.scope} /></td>
              <td data-label="Eligibility"><WithheldPolicyDetail value={pool.currentVersion.eligibility} /></td>
              <td data-label="Reserved for"><WithheldPolicyDetail value={pool.currentVersion.reservedFor} /></td>
              <td data-label="Release policy"><WithheldPolicyDetail value={pool.currentVersion.releasePolicy} /></td>
              <td data-label="Effective"><time dateTime={pool.currentVersion.effectiveFrom}>{pool.currentVersion.effectiveFrom}</time>{pool.currentVersion.effectiveTo ? <> to <time dateTime={pool.currentVersion.effectiveTo}>{pool.currentVersion.effectiveTo}</time></> : " onward"}</td>
              <td data-label="Source evidence"><code>{boundedText(pool.currentVersion.fingerprint, 128)}</code></td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>

      <section aria-labelledby="capacity-history-title">
        <h3 id="capacity-history-title">Append-only transfer and release history</h3>
        {history.length === 0 ? <EmptyState>No transfer or release receipts exist for this event.</EmptyState> : (
          <ol className={styles.ledgerList}>{history.map((entry) => (
            <li key={entry.receiptId}>
              <header><strong>Sequence {entry.sequenceNumber} · {entry.operation}</strong><time dateTime={entry.decidedAt}>{entry.decidedAt}</time></header>
              <dl className={styles.definitionGrid}>
                <div><dt>Quantity / unit</dt><dd>{entry.quantity} {boundedText(entry.unitKind, 64)}</dd></div>
                <div><dt>Source</dt><dd>{boundedText(poolById.get(entry.sourcePoolId)?.name ?? entry.sourcePoolId, 128)}<br /><code>{boundedText(entry.sourcePoolVersionId, 128)}</code><br />{entry.sourceBefore} → {entry.sourceAfter}</dd></div>
                <div><dt>Destination</dt><dd>{boundedText(poolById.get(entry.destinationPoolId)?.name ?? entry.destinationPoolId, 128)}<br /><code>{boundedText(entry.destinationPoolVersionId, 128)}</code><br />{entry.destinationBefore} → {entry.destinationAfter}</dd></div>
                <div><dt>Actor</dt><dd><code>{boundedText(entry.actorAccountId, 128)}</code></dd></div>
                <div><dt>Reason</dt><dd>{boundedText(entry.reason, 256)}</dd></div>
                <div><dt>Approval reference</dt><dd><code>{boundedText(entry.approvalReference, 128)}</code></dd></div>
                <div><dt>Receipt</dt><dd><code>{boundedText(entry.receiptId, 128)}</code><br /><time dateTime={entry.recordedAt}>{entry.recordedAt}</time></dd></div>
                <div><dt>Source evidence</dt><dd><code>{boundedText(entry.fingerprint, 128)}</code></dd></div>
              </dl>
            </li>
          ))}</ol>
        )}
      </section>
    </div>
  );
}

export { styles };
