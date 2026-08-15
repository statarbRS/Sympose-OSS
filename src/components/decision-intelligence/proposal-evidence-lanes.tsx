import type {
  OrganizerReviewAssignment,
  OrganizerReviewSubmissionAggregate,
} from "@/server/services/cfp-review/organizer-types";

import styles from "./decision-intelligence.module.css";

function valueLabel(value: string | number | boolean | null, choiceLabel: string | null): string {
  if (value === null) return "Not provided";
  return choiceLabel ?? String(value);
}

export function ProposalEvidenceLanes({
  ranking,
  assignments,
}: {
  readonly ranking: OrganizerReviewSubmissionAggregate;
  readonly assignments: readonly OrganizerReviewAssignment[];
}) {
  const submitted = assignments.filter((assignment) => assignment.latestSubmittedReview);
  const evidenceGapCount = submitted.length === 0 ? 6 : 5;

  return (
    <section
      className={styles.proposalLanes}
      aria-labelledby={`decision-evidence-${ranking.submissionId}`}
      data-testid="decision-intelligence-proposal-evidence"
      data-authority="none"
    >
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Decision intelligence · projected proposal evidence</p>
          <h5 id={`decision-evidence-${ranking.submissionId}`}>Evaluation stays separate from advocacy</h5>
          <p>
            Review criteria remain individual evaluation evidence. Recommendations are not
            relabeled as advocacy, and neither lane selects a proposal.
          </p>
        </div>
        <span className={styles.proposalBadge}>Candidate evidence</span>
      </header>

      {submitted.length > 0 ? (
        <section
          className={styles.evaluationLane}
          aria-labelledby={`evaluation-lane-${ranking.submissionId}`}
        >
          <div className={styles.laneHeading}>
            <div>
              <p className={styles.eyebrow}>Evaluation lane</p>
              <h6 id={`evaluation-lane-${ranking.submissionId}`}>Named reviewer criteria</h6>
            </div>
            <span>{submitted.length} submitted</span>
          </div>
          <ul className={styles.criterionLedger}>
            {submitted.map((assignment) => (
              <li key={assignment.id}>
                <strong>{assignment.reviewerName}</strong>
                <span>Review revision {assignment.latestSubmittedReview!.revisionNumber}</span>
                <dl>
                  {assignment.latestSubmittedReview!.criteria.map((criterion) => (
                    <div key={criterion.criterionId}>
                      <dt>{criterion.label}</dt>
                      <dd>{valueLabel(criterion.value, criterion.choiceLabel)}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details
        className={styles.evidenceGapDisclosure}
        data-testid="decision-intelligence-evidence-gaps"
        data-gap-count={evidenceGapCount}
      >
        <summary>
          <span className={styles.evidenceGapSummary}>
            <strong>Evidence gaps and authority limits</strong>
            <small>{evidenceGapCount} explicit evidence gaps or limits.</small>
          </span>
          <span className={styles.disclosureHint}>Inspect</span>
        </summary>
        <div className={styles.evidenceGapList}>
          {submitted.length === 0 ? (
            <section className={styles.evidenceGapItem} aria-label="Evaluation evidence availability">
              <div>
                <span>Evaluation lane</span>
                <h6>Named reviewer criteria</h6>
              </div>
              <strong className={styles.unavailableTag}>Unavailable</strong>
              <p>No submitted evaluation evidence is available.</p>
            </section>
          ) : null}
          <section className={styles.evidenceGapItem} aria-label="Advocacy evidence availability">
            <div>
              <span>Advocacy lane</span>
              <h6 id={`advocacy-lane-${ranking.submissionId}`}>No canonical advocacy evidence</h6>
            </div>
            <span className={styles.unavailableTag}>Unavailable</span>
            <p>
              This route does not project a current advocacy context. Reviewer recommendations
              remain reviewer evidence; Sympose does not convert them into endorsements or organizer intent.
            </p>
          </section>

          <section className={styles.evidenceGapItem} aria-label="Proposal revision seal availability">
            <div><h6>Proposal revision seal</h6></div>
            <strong className={styles.unavailableTag}>Unavailable</strong>
            <p>
              Route revision <code>{ranking.submissionRevisionId}</code> has no projected canonical fingerprint.
            </p>
          </section>
          <section className={styles.evidenceGapItem} aria-label="Named program objectives availability">
            <div><h6>Named program objectives</h6></div>
            <strong className={styles.unavailableTag}>Unavailable</strong>
            <p>No objective-contribution ledger is projected for this proposal.</p>
          </section>
          <section className={styles.evidenceGapItem} aria-label="Displaced alternatives availability">
            <div><h6>Displaced alternatives</h6></div>
            <strong className={styles.unavailableTag}>Unavailable</strong>
            <p>No exact whole-slate eligibility/capacity preview is projected.</p>
          </section>
          <section className={styles.evidenceGapItem} aria-label="Aggregate authority">
            <div><h6>Aggregate authority</h6></div>
            <strong className={styles.unavailableTag}>None</strong>
            <p>The transparent review score remains a sort aid, never a selection command.</p>
          </section>
        </div>
      </details>

      <ol className={styles.miniRunway} aria-label="Proposal decision runway">
        <li><span>1</span><div><strong>Evidence preview</strong><small>Available above; proposal only.</small></div></li>
        <li><span>2</span><div><strong>Whole-slate explanation</strong><small>Unavailable until exact curatorial inputs exist.</small></div></li>
        <li><span>3</span><div><strong>Human approval</strong><small>Separate and not executed by this review surface.</small></div></li>
      </ol>
    </section>
  );
}
