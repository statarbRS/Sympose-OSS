import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge, Fingerprint, formatDateTime, ledgerBadge } from "@/components/truth";
import { PersonRelationshipHistory } from "@/components/person-history/person-relationship-history";
import { getDb } from "@/server/db";
import { getPersonDetail } from "@/server/services/queries";
import {
  getRouteSession,
  requireOrganizerWorkspaceRoute,
} from "@/server/workspace-session";

import styles from "./person-record.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Person provenance · Sympose MVP",
};

function shortPersonReference(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export default async function PersonPage({
  params,
}: {
  params: Promise<{ workspace: string; personId: string }>;
}) {
  const { workspace, personId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);

  const db = getDb();
  const detail = getPersonDetail(db, session.workspaceId, personId);
  if (!detail) {
    notFound();
  }
  const personReference = shortPersonReference(detail.person.id);

  return (
    <article className={`${styles.page} record`} data-testid="person-provenance">
      <nav className={`${styles.breadcrumbs} breadcrumbs`} aria-label="Breadcrumb">
        <Link href={`/w/${workspace}/dashboard`}>Dashboard</Link>
        <span aria-hidden="true">/</span>
        <span>People</span>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Person record</span>
      </nav>

      <header className={`${styles.objectHeader} record__header record-object-header`}>
        <div className={styles.headerMain}>
          <p className="record__eyebrow">Canonical person · durable identity</p>
          <div className={styles.titleRow}>
            <h1>{detail.person.fullName}</h1>
            <Badge tone="neutral">Canonical Person</Badge>
          </div>
          <p className="lede">
            One durable identity assembled from immutable provider evidence. Source payloads remain
            evidence; this person record is the workspace-scoped identity spine.
          </p>
        </div>
        <aside className={styles.headerAside} aria-label="Person record summary">
          <span className={styles.sourceCount}>{detail.person.sourceCount} source record{detail.person.sourceCount === 1 ? "" : "s"}</span>
          <span className={styles.sourceHint}>Evidence is inspectable below</span>
        </aside>
        <dl className={`${styles.definitionGrid} kv-list record__facts record__definition-grid`}>
          <div className="kv">
            <dt>Email</dt>
            <dd>{detail.person.canonicalEmail}</dd>
          </div>
          <div className="kv">
            <dt>Organization</dt>
            <dd>{detail.person.organization ?? "Unknown"}</dd>
          </div>
          <div className="kv">
            <dt>Title</dt>
            <dd>{detail.person.title ?? "Unknown"}</dd>
          </div>
          <div className="kv">
            <dt>Person reference</dt>
            <dd className={styles.referenceValue}>
              <code data-testid="person-display-reference" title="Display reference only">
                {personReference}
              </code>
              <span>Display reference only</span>
            </dd>
          </div>
        </dl>
      </header>

      <div className={styles.contextRibbon} role="note">
        <span className={styles.ribbonLabel}>Record boundary</span>
        <span>Canonical identity first</span>
        <span aria-hidden="true">·</span>
        <span>Event participation is contextual</span>
        <span aria-hidden="true">·</span>
        <span>Truth layers remain independent</span>
      </div>

      <PersonRelationshipHistory
        db={db}
        session={session}
        workspaceSlug={workspace}
        personId={personId}
      />

      <section className={`${styles.section} record__section`} aria-labelledby="provenance-title">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionEyebrow}>Evidence and lineage</p>
            <h2 id="provenance-title">Source provenance</h2>
          </div>
          <span className={styles.sectionMeta}>{detail.sources.length} linked source{detail.sources.length === 1 ? "" : "s"}</span>
        </header>
        <p className="muted">
          The create/link decision is explicit and inspectable. Payloads below are synthetic and
          rendered as escaped text.
        </p>
        <details className={styles.identifierEvidence} data-testid="person-full-identifier">
          <summary>Full immutable person identifier</summary>
          <p>Canonical authority uses the full workspace-scoped identifier.</p>
          <code>{detail.person.id}</code>
        </details>
        <div className={`${styles.sourceStack} record__stack`}>
          {detail.sources.map((source) => (
            <details key={source.id} className={`${styles.evidence} evidence`}>
              <summary>
                <strong>{source.provider}</strong> · {source.sourceRef} · v{source.version}
              </summary>
              <dl className="kv-list">
                <div className="kv">
                  <dt>Link decision</dt>
                  <dd><Badge tone="approved">{source.linkDecision ?? "unlinked"}</Badge></dd>
                </div>
                <div className="kv">
                  <dt>Imported</dt>
                  <dd>{formatDateTime(source.importedAt)}</dd>
                </div>
                <div className="kv">
                  <dt>Source record ID</dt>
                  <dd className="mono">{source.id}</dd>
                </div>
              </dl>
              <pre className={`${styles.payload} payload`}><code>{JSON.stringify(source.payload, null, 2)}</code></pre>
            </details>
          ))}
          {detail.sources.length === 0 ? <p className="empty-state">No linked source evidence.</p> : null}
        </div>
      </section>

      <section className={`${styles.section} ${styles.historySection} record__section`} aria-labelledby="history-title">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionEyebrow}>Ordered record of what is known</p>
            <h2 id="history-title">Truth history</h2>
          </div>
          <span className={styles.sectionMeta}>{detail.ledgers.length} ledger entr{detail.ledgers.length === 1 ? "y" : "ies"}</span>
        </header>
        <p className="muted">
          The four truth layers—candidate, organizer decision, participant commitment, and
          operational observation—remain independently queryable. Proposed assignments and
          publication are typed projections; later entries do not rewrite earlier facts.
        </p>
        <div className={`${styles.truthLegend} truth-ledger__legend`} aria-label="Truth layer legend">
          <span>Candidate truth</span>
          <span>Decision truth</span>
          <span>Commitment truth</span>
          <span>Operational truth</span>
          <span>Publication projection</span>
        </div>
        <ol className={`${styles.truthLedger} timeline truth-ledger`} data-testid="truth-ledger">
          {detail.ledgers.map((entry, index) => {
            const badge = ledgerBadge(entry);
            const layerLabel =
              entry.kind === "projection"
                ? entry.projection === "publication"
                  ? "Publication projection"
                  : "Candidate projection"
                : entry.layer === "candidate"
                  ? "Candidate truth"
                  : entry.layer === "decision"
                    ? "Decision truth"
                    : entry.layer === "commitment"
                      ? "Commitment truth"
                      : entry.layer === "operational"
                        ? "Operational truth"
                        : "Truth";
            return (
              <li
                key={`${entry.kind}-${entry.layer ?? entry.projection}-${entry.occurredAt}-${index}`}
                className={[styles.truthRow,
                  "truth-ledger__row",
                  entry.kind === "projection" ? "truth-ledger__row--projection" : "truth-ledger__row--truth",
                  entry.projection === "publication" ? "truth-ledger__row--publication" : "",
                ].filter(Boolean).join(" ")}
              >
                <span className="tl-badge"><Badge tone={badge.tone}>{badge.label}</Badge></span>
                <div>
                  <span className="tl-layer">{layerLabel}</span>
                  <div className="tl-title">{entry.title}</div>
                  <div className="tl-detail">
                    {entry.detail}{" "}
                    {entry.fingerprint ? <Fingerprint value={entry.fingerprint} /> : null}
                  </div>
                </div>
                <time className="tl-time" dateTime={entry.occurredAt}>{formatDateTime(entry.occurredAt)}</time>
              </li>
            );
          })}
        </ol>
        {detail.ledgers.length === 0 ? <p className="empty-state">Run the pipeline to create person history.</p> : null}
      </section>
    </article>
  );
}
