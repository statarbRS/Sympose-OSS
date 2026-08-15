import { Fingerprint } from "@/components/truth";

import styles from "./decision-intelligence.module.css";
import {
  buildPlanDecisionProjection,
  type DecisionPlanVersionInput,
} from "./plan-projection";

function changeLabel(kind: string): string {
  switch (kind) {
    case "MOVED": return "Moved";
    case "ADDED": return "Added";
    case "REMOVED": return "Removed";
    default: return "Unchanged";
  }
}

export function PlanCompilerReveal({
  candidate,
  current,
}: {
  readonly candidate: DecisionPlanVersionInput;
  readonly current: DecisionPlanVersionInput | null;
}) {
  const projection = buildPlanDecisionProjection(candidate, current);
  const materialChanges = projection.changes.filter((item) => item.kind !== "UNCHANGED");

  return (
    <section
      className={styles.compilerReveal}
      aria-labelledby="compiler-reveal-title"
      data-testid="decision-intelligence-compiler-reveal"
      data-authority="none"
      data-preview-only="true"
    >
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Decision intelligence · whole slate</p>
          <h2 id="compiler-reveal-title">Compiler reveal</h2>
          <p>
            Compare the exact current and candidate assignment records before setup or approval.
            This surface can explain a proposal; it cannot select, change capacity, notify, or approve.
          </p>
        </div>
        <span className={styles.proposalBadge}>Proposal only · authority none</span>
      </header>

      {projection.status === "UNAVAILABLE" ? (
        <div className={styles.unavailable} role="note" data-testid="compiler-reveal-unavailable">
          <strong>Whole-slate comparison unavailable</strong>
          <p>
            {projection.candidateLifecycleStatus === "approved"
              ? `Approved current slate v${projection.candidateVersionNumber} is visible, but no separate candidate slate is available.`
              : `Candidate v${projection.candidateVersionNumber} is visible, but no separate exact current slate is available.`}
            {" "}Sympose does not invent a baseline or stability verdict.
          </p>
        </div>
      ) : (
        <>
          <div className={styles.slateRail} aria-label="Current and candidate slate identities">
            <div>
              <span>Current approved slate</span>
              <strong>v{projection.currentVersionNumber}</strong>
              {projection.currentFingerprint ? <Fingerprint value={projection.currentFingerprint} /> : null}
            </div>
            <span className={styles.slateArrow} aria-hidden="true">→</span>
            <div>
              <span>Candidate slate</span>
              <strong>v{projection.candidateVersionNumber}</strong>
              <Fingerprint value={projection.candidateFingerprint} />
            </div>
          </div>

          <dl className={styles.changeCounts} aria-label="Exact whole-slate change counts">
            <div><dt>Retained</dt><dd>{projection.counts.unchanged}</dd></div>
            <div><dt>Moved</dt><dd>{projection.counts.moved}</dd></div>
            <div><dt>Added</dt><dd>{projection.counts.added}</dd></div>
            <div><dt>Removed</dt><dd>{projection.counts.removed}</dd></div>
            <div className={styles.costCount}>
              <dt>Explicit change cost</dt>
              <dd>
                <span>{projection.stabilityCost.total}</span>
                <small>{projection.stabilityCost.formula}</small>
              </dd>
            </div>
          </dl>

          <p className={styles.disclosure}>{projection.stabilityCost.explanation}</p>

          <section className={styles.changeLedger} aria-labelledby="compiler-change-ledger-title">
            <div className={styles.subheadingRow}>
              <div>
                <p className={styles.eyebrow}>Deterministic record diff</p>
                <h3 id="compiler-change-ledger-title">Changed assignments</h3>
              </div>
              <span>{materialChanges.length} material record change{materialChanges.length === 1 ? "" : "s"}</span>
            </div>
            {materialChanges.length === 0 ? (
              <p className={styles.quiet}>The exact assignment records are unchanged.</p>
            ) : (
              <ol className={styles.changeList}>
                {materialChanges.map((item) => (
                  <li key={JSON.stringify([item.kind, item.personId, item.assignmentType, item.beforeProgramUnitId, item.afterProgramUnitId])}>
                    <span className={styles.changeKind}>{changeLabel(item.kind)}</span>
                    <div>
                      <strong>{item.fullName} · {item.assignmentType}</strong>
                      <span>
                        {item.beforeProgramUnitName ?? "Not in current slate"}
                        <span aria-hidden="true"> → </span>
                        {item.afterProgramUnitName ?? "Not in candidate slate"}
                      </span>
                    </div>
                    <span className={styles.costToken}>cost {item.explicitCost}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}

      <div className={styles.intelligenceGrid}>
        <section aria-labelledby="named-objectives-title">
          <p className={styles.eyebrow}>Named objective contributions</p>
          <h3 id="named-objectives-title">Unavailable from this route</h3>
          <p>{projection.namedObjectiveContributions.explanation}</p>
          <span className={styles.unavailableTag}>Unavailable · not inferred</span>
        </section>
        <section aria-labelledby="proof-bindings-title">
          <p className={styles.eyebrow}>Canonical proof bindings</p>
          <h3 id="proof-bindings-title">Evidence availability</h3>
          <ul className={styles.proofList}>
            {projection.proofAvailability.map((proof) => (
              <li key={proof.family}>
                <strong>{proof.family.replace("_", " ")}</strong>
                <span>{proof.status}</span>
                <small>{proof.explanation}</small>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className={styles.approvalRunway} aria-labelledby="override-runway-title">
        <div className={styles.subheadingRow}>
          <div>
            <p className={styles.eyebrow}>Override proposal runway</p>
            <h3 id="override-runway-title">Preview → explanation → human approval</h3>
          </div>
          <span>Nothing executed</span>
        </div>
        <ol>
          <li data-stage-state={projection.status === "READY" ? "ready" : "unavailable"}>
            <span>1</span><div><strong>Preview</strong><small>{projection.status === "READY" ? "Exact record comparison ready." : projection.candidateLifecycleStatus === "approved" ? "No separate candidate slate is available." : "Exact current baseline unavailable."}</small></div>
          </li>
          <li data-stage-state="unavailable">
            <span>2</span><div><strong>Explanation</strong><small>Waits for named objectives, change radius, and reconfirmation evidence.</small></div>
          </li>
          <li data-stage-state="blocked">
            <span>3</span><div><strong>Human approval</strong><small>Not requested. No selection, capacity change, or notification can run here.</small></div>
          </li>
        </ol>
      </section>
    </section>
  );
}
