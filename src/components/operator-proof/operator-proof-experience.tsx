import type {
  OperatorProofExperienceProjection,
  OperatorProofStatus,
} from "@/server/services/operator-proof";

import styles from "./operator-proof-experience.module.css";

function statusClass(status: OperatorProofStatus | "EXACT_MATCH" | "STALE" | "PROVEN"): string {
  if (status === "READY" || status === "EXACT_MATCH" || status === "PROVEN") return styles.statusReady;
  if (status === "BLOCKED" || status === "STALE") return styles.statusBlocked;
  return styles.statusUnavailable;
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ").toLowerCase().replace(/^./u, (character) => character.toUpperCase());
}

function shortEvidence(value: string): string {
  return value.length > 28 ? `${value.slice(0, 14)}…${value.slice(-8)}` : value;
}

export function formatOperatorTimestamp(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return `Unformatted UTC timestamp · ${value}`;
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(instant);
    return `${formatted} · UTC`;
  } catch {
    return `Unformatted UTC timestamp · ${value}`;
  }
}

export function ReleaseTwinProof({
  projection,
}: {
  readonly projection: OperatorProofExperienceProjection;
}) {
  const twin = projection.releaseTwin;
  const packageView = twin.publicPackage;
  return (
    <section className={styles.releasePanel} aria-labelledby="operator-release-twin-title" data-testid="operator-release-twin">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Immutable release twin</p>
          <h2 id="operator-release-twin-title">What is sealed, what drifted, what is unavailable</h2>
        </div>
        <span className={`${styles.statusChip} ${statusClass(twin.drift.status)}`}>
          {statusLabel(twin.drift.status)}
        </span>
      </header>
      <p className={styles.intro}>
        The public package and operator package are independent evidence. A newer source or release
        never edits the sealed package shown here.
      </p>

      <dl className={styles.audienceCounts} data-testid="operator-proof-audience-counts">
        <div><dt>Included agendas</dt><dd>{packageView?.includedAgendaCount ?? "—"}</dd></div>
        <div><dt>Included items</dt><dd>{packageView?.includedAgendaItemCount ?? "—"}</dd></div>
        <div><dt>Excluded accepted</dt><dd>{packageView?.excludedAcceptedPeopleCount ?? "—"}</dd></div>
        <div><dt>Redacted groups</dt><dd>{packageView?.redactedFieldGroupCount ?? "—"}</dd></div>
      </dl>

      <div className={styles.twinGrid}>
        <article className={styles.twinCard} data-state={packageView ? "sealed" : "unavailable"}>
          <div className={styles.cardHeading}>
            <div><span>Audience package</span><h3>Public release</h3></div>
            <strong>{packageView ? (packageView.current ? "Current · sealed" : "Sealed") : "Unavailable"}</strong>
          </div>
          {packageView ? (
            <>
              <p>
                Plan v{packageView.planVersion} · {packageView.acceptedPeopleCount} accepted people · sealed{" "}
                <time dateTime={packageView.sealedAt}>{formatOperatorTimestamp(packageView.sealedAt)}</time>
              </p>
              <p className={styles.lineageSentence}>
                {packageView.supersedesReleaseId
                  ? "This immutable version explicitly supersedes one prior release."
                  : "This is the first explicit release in its retained lineage."}
              </p>
            </>
          ) : <p>No exact validated current public package resolves from the durable pointer.</p>}
        </article>
        <article className={styles.twinCard} data-state="unavailable">
          <div className={styles.cardHeading}>
            <div><span>Operations package</span><h3>Operator release</h3></div>
            <strong>Unavailable</strong>
          </div>
          <p>{twin.operatorPackage.reason}</p>
        </article>
      </div>

      <div className={styles.driftSummary} data-state={twin.drift.status}>
        <div>
          <span>Current-source comparison</span>
          <strong>{statusLabel(twin.drift.status)}</strong>
        </div>
        <p>{twin.drift.status === "EXACT_MATCH"
          ? "The current persisted public source vector exactly matches the sealed baseline."
          : twin.drift.status === "STALE"
            ? `Material drift is present in ${twin.drift.families.map((family) => family.toLowerCase()).join(", ") || "the persisted source vector"}. The sealed release is unchanged.`
            : twin.drift.blockers[0] ?? "An exact source comparison is unavailable."}</p>
      </div>

      <section className={styles.history} aria-labelledby="release-history-title">
        <div className={styles.historyHeading}>
          <div><span>Explicit supersession</span><h3 id="release-history-title">Retained release lineage</h3></div>
          <strong className={statusClass(twin.history.status)}>{statusLabel(twin.history.status)}</strong>
        </div>
        <p>{twin.history.reason}</p>
        {twin.history.items.length > 0 ? (
          <ol>
            {twin.history.items.map((release) => (
              <li key={release.releaseId} data-current={release.current || undefined}>
                <div>
                  <span>{release.releaseNumber ? `Release ${release.releaseNumber}` : "Release number unavailable"}</span>
                  <strong>{release.current ? "Current pointer" : release.supersededByReleaseId ? "Superseded" : "Historical"}</strong>
                </div>
                <p>
                  {release.includedAgendaCount} agendas · {release.includedAgendaItemCount} items · sealed{" "}
                  <time dateTime={release.sealedAt}>{formatOperatorTimestamp(release.sealedAt)}</time>
                </p>
                <code title={release.releaseId}>{shortEvidence(release.releaseId)}</code>
              </li>
            ))}
          </ol>
        ) : <p className={styles.empty}>No validated release lineage is available.</p>}
      </section>

      <details className={styles.technical}>
        <summary>Inspect technical release lineage</summary>
        <dl>
          <div><dt>Current pointer</dt><dd><code>{twin.currentPointer.releaseId ?? "unavailable"}</code></dd></div>
          <div><dt>Pointer validation</dt><dd>{twin.currentPointer.validated ? "Exact current release" : "Unavailable"}</dd></div>
          <div><dt>Sealed fingerprint</dt><dd><code>{packageView?.fingerprint ?? "unavailable"}</code></dd></div>
          <div><dt>Plan fingerprint</dt><dd><code>{packageView?.planFingerprint ?? "unavailable"}</code></dd></div>
          <div><dt>Baseline vector</dt><dd><code>{twin.drift.baselineFingerprint ?? "unavailable"}</code></dd></div>
          <div><dt>Current vector</dt><dd><code>{twin.drift.currentFingerprint ?? "unavailable"}</code></dd></div>
        </dl>
        {twin.drift.entries.length > 0 ? (
          <ul>{twin.drift.entries.map((entry) => (
            <li key={`${entry.sourceId}:${entry.family}`}>{entry.sourceId} · {entry.family} · {entry.effect}</li>
          ))}</ul>
        ) : null}
      </details>
    </section>
  );
}

export function OperatorProofExperience({
  projection,
}: {
  readonly projection: OperatorProofExperienceProjection;
}) {
  const blocked = projection.readiness.outcomes.filter((outcome) => outcome.status === "BLOCKED").length;
  const unavailable = projection.readiness.outcomes.filter((outcome) => outcome.status === "UNAVAILABLE").length;
  const ready = projection.readiness.outcomes.filter((outcome) => outcome.status === "READY").length;
  const priorityOutcome = projection.readiness.outcomes.find((outcome) => outcome.status === "BLOCKED")
    ?? projection.readiness.outcomes.find((outcome) => outcome.status === "UNAVAILABLE")
    ?? projection.readiness.outcomes[0]
    ?? null;
  return (
    <div className={styles.proofExperience} data-testid="operator-proof-experience">
      <nav className={styles.operatorNav} aria-label="Operator proof sections">
        <a href="#operator-proof-readiness-title">Readiness</a>
        <a href="#operator-release-twin-title">Release</a>
        <a href="#activity-spine-title">Activity</a>
      </nav>
      <section className={styles.operatorMobileInstrument} aria-labelledby="operator-mobile-title" data-role-instrument="operator">
        <p className={styles.operatorMobileKicker}>Read-only readiness instrument</p>
        <h2 id="operator-mobile-title">What needs you</h2>
        {priorityOutcome ? <>
          <div className={styles.operatorMobileStatus}><strong>{priorityOutcome.label}</strong><span>{statusLabel(priorityOutcome.status)}</span></div>
          <p>{priorityOutcome.blockers[0]?.message ?? "Exact evidence and every dependency are proven for this outcome."}</p>
          {priorityOutcome.nextActions[0] ? <small>Suggested inspection: {priorityOutcome.nextActions[0]}</small> : null}
        </> : <p>No readiness outcome evidence is available.</p>}
        <a className={styles.operatorMobileLink} href="#operator-proof-readiness-title">Open full evidence</a>
      </section>
      <section className={styles.readinessPanel} aria-labelledby="operator-proof-readiness-title">
        <header className={styles.sectionHeader}>
          <div>
            <p className={styles.eyebrow}>Worst-state-first proof graph</p>
            <h2 id="operator-proof-readiness-title">Outcome authority, not a composite score</h2>
          </div>
          <span className={`${styles.statusChip} ${statusClass(projection.readiness.status)}`}>
            {statusLabel(projection.readiness.status)}
          </span>
        </header>
        <p className={styles.intro}>
          Each node requires an exact current authority. Missing evidence is unavailable; explicit
          denial or conflict is blocked. Downstream nodes retain their dependency receipts.
        </p>
        <dl className={styles.readinessCounts}>
          <div><dt>Blocked</dt><dd>{blocked}</dd></div>
          <div><dt>Unavailable</dt><dd>{unavailable}</dd></div>
          <div><dt>Ready</dt><dd>{ready}</dd></div>
          <div><dt>Mode</dt><dd>Read only</dd></div>
        </dl>
        <ol className={styles.proofGraph} aria-label="Worst-state-first readiness outcomes">
          {projection.readiness.outcomes.map((outcome) => (
            <li key={outcome.outcome} className={statusClass(outcome.status)} data-status={outcome.status}>
              <article>
                <header>
                  <span>{outcome.outcome.replaceAll("_", " ")}</span>
                  <strong>{statusLabel(outcome.status)}</strong>
                </header>
                <h3>{outcome.label}</h3>
                {outcome.blockers.length > 0 ? (
                  <ul className={styles.blockers}>{outcome.blockers.map((blocker) => (
                    <li key={`${blocker.requirementId}:${blocker.code}`}><strong>{blocker.code.replaceAll("_", " ")}</strong>{blocker.message}</li>
                  ))}</ul>
                ) : <p className={styles.proven}>Exact evidence and all dependencies are proven.</p>}
                <footer>
                  <span>{outcome.evidenceIds.length} matched evidence record{outcome.evidenceIds.length === 1 ? "" : "s"}</span>
                  {outcome.nextActions[0] ? <span>{outcome.nextActions[0]}</span> : null}
                </footer>
              </article>
            </li>
          ))}
        </ol>
        <details className={styles.technical}>
          <summary>Inspect proof-graph receipt</summary>
          <p>Graph fingerprint <code>{projection.readiness.fingerprint}</code></p>
          <ul>{projection.readiness.minimalBlockers.map((blocker) => (
            <li key={`${blocker.requirementId}:${blocker.code}`}>{blocker.requirementId} · {blocker.code} · evidence {blocker.evidenceIds.join(", ") || "unavailable"}</li>
          ))}</ul>
        </details>
      </section>

      <ReleaseTwinProof projection={projection} />

      <section className={styles.boundedPanel} aria-labelledby="bounded-evidence-title">
        <header className={styles.sectionHeader}>
          <div><p className={styles.eyebrow}>Bounded counterfactual evidence</p><h2 id="bounded-evidence-title">Replay and near-miss proof</h2></div>
        </header>
        <div className={styles.boundedGrid}>
          <article>
            <div><h3>Decision replay</h3><span className={styles.statusUnavailable}>Unavailable</span></div>
            <p>{projection.boundedEvidence.decisionReplay.reason}</p>
            <strong>{projection.boundedEvidence.decisionReplay.inspectedPlanRunCount} plan-run sources inspected · bound {projection.boundedEvidence.decisionReplay.bound}</strong>
            {projection.boundedEvidence.decisionReplay.sourceRecords.length > 0 ? (
              <details><summary>Inspect plan-run references</summary><ul>
                {projection.boundedEvidence.decisionReplay.sourceRecords.map((record) => (
                  <li key={record.id}><code>{shortEvidence(record.id)}</code> · {record.compiler} {record.compilerVersion} · {record.status}</li>
                ))}
              </ul></details>
            ) : null}
          </article>
          <article>
            <div><h3>Near-miss proof</h3><span className={styles.statusUnavailable}>Unavailable</span></div>
            <p>{projection.boundedEvidence.nearMiss.reason}</p>
            <strong>{projection.boundedEvidence.nearMiss.inspectedDecisionCount} proposal decisions inspected · {projection.boundedEvidence.nearMiss.receiptCount} qualifying receipts</strong>
          </article>
        </div>
      </section>

      <section className={styles.activityPanel} aria-labelledby="activity-spine-title">
        <header className={styles.sectionHeader}>
          <div><p className={styles.eyebrow}>Persisted activity spine</p><h2 id="activity-spine-title">Accepted → speaker → artifact → schedule → release</h2></div>
          <span className={styles.readOnly}>Read only</span>
        </header>
        <p className={styles.intro}>Stage order communicates the workflow. Every timestamp and record below comes from its named persisted source; an absent stage stays unavailable.</p>
        <ol className={styles.activitySpine}>
          {projection.activitySpine.stages.map((stage, index) => (
            <li key={stage.stage} data-status={stage.status}>
              <div className={styles.stageMarker}><span>{index + 1}</span></div>
              <article>
                <header><h3>{stage.label}</h3><strong className={statusClass(stage.status)}>{statusLabel(stage.status)}</strong></header>
                <p>{stage.reason}</p>
                {stage.evidence.length > 0 ? (
                  <ul>{stage.evidence.map((item) => (
                    <li key={item.id}>
                      <div><strong>{item.label}</strong><time dateTime={item.occurredAt}>{formatOperatorTimestamp(item.occurredAt)}</time></div>
                      <span>{item.source}</span>
                      <code title={item.id}>{shortEvidence(item.id)}</code>
                    </li>
                  ))}</ul>
                ) : null}
                {stage.truncated ? <small>Showing the newest {projection.activitySpine.boundPerStage} exact records for this stage.</small> : null}
              </article>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
