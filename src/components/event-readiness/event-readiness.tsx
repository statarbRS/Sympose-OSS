import Link from "next/link";

import styles from "./event-readiness.module.css";

export type ReadinessTone = "ready" | "attention" | "blocked" | "unavailable";
export type ReadinessEvidence = "complete" | "partial" | "unavailable";
export type ReadinessFindingTone = "note" | "attention" | "blocked" | "unavailable";

export interface ReadinessMetric {
  readonly label: string;
  readonly value: string | number;
}

export interface ReadinessFinding {
  readonly tone: ReadinessFindingTone;
  readonly text: string;
}

export interface ReadinessAction {
  readonly href: string;
  readonly label: string;
}

export interface EventReadinessArea {
  readonly id:
    | "submissions-review"
    | "speaker-commitments"
    | "content-artifacts"
    | "schedule"
    | "publication"
    | "communications";
  readonly title: string;
  readonly eyebrow: string;
  readonly status: Readonly<{
    readonly tone: ReadinessTone;
    readonly label: string;
  }>;
  readonly evidence: Readonly<{
    readonly state: ReadinessEvidence;
    readonly label: string;
  }>;
  readonly summary: string;
  readonly metrics: readonly ReadinessMetric[];
  readonly findings: readonly ReadinessFinding[];
  readonly actions: readonly ReadinessAction[];
}

export interface EventReadinessProjection {
  readonly event: Readonly<{
    readonly id: string;
    readonly name: string;
    readonly timezone: string;
    readonly lifecycle: string;
  }>;
  readonly areas: readonly EventReadinessArea[];
}

const statusClasses: Readonly<Record<ReadinessTone, string>> = {
  ready: styles.statusReady,
  attention: styles.statusAttention,
  blocked: styles.statusBlocked,
  unavailable: styles.statusUnavailable,
};

const evidenceClasses: Readonly<Record<ReadinessEvidence, string>> = {
  complete: styles.evidenceComplete,
  partial: styles.evidencePartial,
  unavailable: styles.evidenceUnavailable,
};

const findingClasses: Readonly<Record<ReadinessFindingTone, string>> = {
  note: styles.findingNote,
  attention: styles.findingAttention,
  blocked: styles.findingBlocked,
  unavailable: styles.findingUnavailable,
};

const severityOrder: Readonly<Record<ReadinessTone, number>> = {
  blocked: 0,
  unavailable: 1,
  attention: 2,
  ready: 3,
};

function displayStatus(area: EventReadinessArea): Readonly<{
  readonly tone: ReadinessTone;
  readonly label: string;
}> {
  const explicitBlock = area.status.tone === "blocked" && area.findings.some((finding) => finding.tone === "blocked");
  return area.evidence.state === "complete" || explicitBlock
    ? area.status
    : { tone: "unavailable", label: "Cannot verify" };
}

function displayFindings(area: EventReadinessArea): readonly ReadinessFinding[] {
  if (area.evidence.state === "complete" || area.findings.some((item) => /Cannot verify/u.test(item.text))) {
    return area.findings;
  }
  return [
    { tone: "unavailable", text: "Cannot verify this area until its required evidence is complete. Use the direct links below to inspect the source surface." },
    ...area.findings,
  ];
}

export function EventReadinessCommandCenter({
  projection,
}: {
  readonly projection: EventReadinessProjection;
}) {
  const actionableAreas = projection.areas.filter((area) => displayStatus(area).tone !== "ready").length;
  const blockedAreas = projection.areas.filter((area) => displayStatus(area).tone === "blocked").length;
  const partialEvidence = projection.areas.filter((area) => area.evidence.state === "partial").length;
  const unavailableEvidence = projection.areas.filter(
    (area) => area.evidence.state === "unavailable",
  ).length;
  const orderedAreas = projection.areas
    .map((area, workflowIndex) => ({ area, workflowIndex, status: displayStatus(area) }))
    .sort((first, second) =>
      severityOrder[first.status.tone] - severityOrder[second.status.tone] ||
      first.workflowIndex - second.workflowIndex,
    );

  return (
    <div className={styles.commandCenter} data-testid="event-readiness-command-center">
      <section className={styles.summary} aria-labelledby="readiness-attention-title">
        <div className={styles.summaryCopy}>
          <p className={styles.kicker}>Worst-state-first readiness proof</p>
          <h2 id="readiness-attention-title">What is blocked, unavailable, or ready</h2>
          <p>
            A server-read proof index across the event surfaces that own each fact. Explicit blockers
            remain distinct from evidence that cannot be verified.
          </p>
          <p className={styles.eventContext}>
            <span>{projection.event.lifecycle}</span>
            <span>{projection.event.timezone}</span>
          </p>
        </div>
        <dl className={styles.summaryMetrics} aria-label="Readiness attention summary">
          <div>
            <dt>Actionable areas</dt>
            <dd>{actionableAreas}</dd>
          </div>
          <div>
            <dt>Blocked areas</dt>
            <dd>{blockedAreas}</dd>
          </div>
          <div>
            <dt>Partial evidence</dt>
            <dd>{partialEvidence}</dd>
          </div>
          <div>
            <dt>Unavailable evidence</dt>
            <dd>{unavailableEvidence}</dd>
          </div>
        </dl>
        <p className={styles.boundaryNote}>
          This is not an approval gate or composite score. Blocked means explicit negative evidence;
          cannot verify means exact evidence is partial or unavailable. Each source remains independently queryable.
        </p>
      </section>

      <header className={styles.queueHeading}>
        <div>
          <p className={styles.kicker}>Ordered proof queue</p>
          <h2>Blocked, then unavailable, then attention</h2>
        </div>
        <p>
          Evidence severity determines the groups below. Authored workflow order is preserved inside
          each state, and proven areas remain visible after unresolved work.
        </p>
      </header>

      <ol className={styles.areaGrid} aria-label="Event readiness areas">
        {orderedAreas.map(({ area, status }) => {
          const titleId = `readiness-${area.id}-title`;
          const findings = displayFindings(area);
          return (
            <li
              className={`${styles.areaCard} ${statusClasses[status.tone]}`}
              data-readiness-area={area.id}
              data-readiness-severity={status.tone}
              data-evidence-state={area.evidence.state}
              key={area.id}
            >
              <article aria-labelledby={titleId}>
                <header className={styles.cardHeader}>
                  <div>
                    <p className={styles.cardEyebrow}>{area.eyebrow}</p>
                    <h3 id={titleId}>{area.title}</h3>
                  </div>
                  <span className={styles.statusLabel}>{status.label}</span>
                </header>

                <p className={styles.areaSummary}>{area.summary}</p>
                <p className={`${styles.evidenceLabel} ${evidenceClasses[area.evidence.state]}`}>
                  <span aria-hidden="true" />
                  {area.evidence.state === "complete" ? "Exact evidence" : area.evidence.state === "partial" ? "Partial evidence · cannot verify" : "Evidence unavailable"} · {area.evidence.label}
                </p>

                {area.metrics.length > 0 ? (
                  <dl className={styles.metricGrid}>
                    {area.metrics.map((metric) => (
                      <div key={metric.label}>
                        <dt>{metric.label}</dt>
                        <dd>{metric.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {findings.length > 0 ? (
                  <ul className={styles.findings}>
                    {findings.map((finding, index) => (
                      <li className={findingClasses[finding.tone]} key={`${finding.tone}-${index}`}>
                        {finding.text}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <nav className={styles.actions} aria-label={`${area.title} direct links`}>
                  {area.actions.map((action) => (
                    <Link href={action.href} key={action.href}>
                      {action.label}<span aria-hidden="true"> →</span>
                    </Link>
                  ))}
                </nav>
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
