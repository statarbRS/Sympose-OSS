import Link from "next/link";

import type { DashboardState } from "@/server/services/queries";

import styles from "./getting-started.module.css";

type CheckpointStatus = "complete" | "current" | "waiting";
type CheckpointKind = "evidence" | "candidate" | "context" | "decision" | "commitment" | "publication" | "operational";

interface GettingStartedCheckpoint {
  readonly id: string;
  readonly kind: CheckpointKind;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly evidence: string;
  readonly complete: boolean;
  readonly href: string;
  readonly action: string;
}

interface PresentedCheckpoint extends GettingStartedCheckpoint {
  readonly status: CheckpointStatus;
}

const kindClasses: Readonly<Record<CheckpointKind, string>> = {
  evidence: styles.kindEvidence,
  candidate: styles.kindCandidate,
  context: styles.kindContext,
  decision: styles.kindDecision,
  commitment: styles.kindCommitment,
  publication: styles.kindPublication,
  operational: styles.kindOperational,
};

const statusLabels: Readonly<Record<CheckpointStatus, string>> = {
  complete: "Evidence found",
  current: "Next checkpoint",
  waiting: "Waiting",
};

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function peopleEvidence(state: DashboardState): string {
  const people = state.people.length;
  const sources = state.sourceRecordCount;
  if (people > 0 && sources > 0) {
    return `${countLabel(people, "canonical person", "canonical people")} · ${countLabel(sources, "source record")}`;
  }
  if (people > 0) {
    return `${countLabel(people, "canonical person", "canonical people")} · no source records in this projection`;
  }
  if (sources > 0) {
    return `${countLabel(sources, "source record")} · no canonical people projected yet`;
  }
  return "No canonical people or source records are projected yet.";
}

function planEvidence(state: DashboardState): string {
  if (state.candidatePlan) {
    const approvedBase = state.currentPlan
      ? ` · approved/current v${state.currentPlan.versionNumber} remains separate`
      : "";
    return `Candidate v${state.candidatePlan.versionNumber} · ${countLabel(state.candidatePlan.assignmentCount, "assignment")}${approvedBase}`;
  }
  if (state.currentPlan) {
    return `Current plan v${state.currentPlan.versionNumber} · ${countLabel(state.currentPlan.assignmentCount, "assignment")}`;
  }
  return "No candidate or current plan is projected for the dashboard event.";
}

function decisionEvidence(state: DashboardState): string {
  if (state.currentPlan && state.approvals.length > 0) {
    return `${countLabel(state.approvals.length, "approval record")} for current plan v${state.currentPlan.versionNumber}.`;
  }
  if (state.candidatePlan) {
    return `Candidate v${state.candidatePlan.versionNumber} is available; no approval is projected for it.`;
  }
  if (state.currentPlan) {
    return `Current plan v${state.currentPlan.versionNumber} has no approval record in this projection.`;
  }
  return "No plan decision can be projected before a plan exists.";
}

function commitmentEvidence(state: DashboardState): string {
  const accepted = state.offers.filter((offer) => offer.response === "accepted").length;
  const declined = state.offers.filter((offer) => offer.response === "declined").length;
  const awaiting = state.offers.filter((offer) => offer.response === null).length;
  if (state.offers.length === 0) {
    return "No exact offers are projected for the dashboard event's current approved plan.";
  }
  return `${accepted} accepted · ${awaiting} awaiting · ${declined} declined across ${countLabel(state.offers.length, "exact offer")}.`;
}

function createCheckpoints(state: DashboardState, workspaceSlug: string): readonly GettingStartedCheckpoint[] {
  const workspaceBase = `/w/${encodeURIComponent(workspaceSlug)}`;
  const event = state.event.event;
  const eventBase = event
    ? `${workspaceBase}/events/${encodeURIComponent(event.id)}`
    : null;
  const acceptedOffers = state.offers.filter((offer) => offer.response === "accepted").length;

  return [
    {
      id: "people",
      kind: "evidence",
      label: "Evidence substrate",
      title: "Establish the participant graph",
      description:
        "Review durable people separately from the source records that support them. A provider row never becomes the identity spine by itself.",
      evidence: peopleEvidence(state),
      complete: state.people.length > 0,
      href: `${workspaceBase}/crm`,
      action: "Open people workspace",
    },
    {
      id: "cohort",
      kind: "candidate",
      label: "Candidate truth",
      title: "Freeze an explainable cohort",
      description:
        "Materialize an immutable selection so later planning can point to who qualified, when, and why.",
      evidence: state.snapshot
        ? `Immutable cohort snapshot · ${countLabel(state.snapshot.memberCount, "member")}`
        : "No cohort snapshot is projected yet.",
      complete: state.snapshot !== null,
      href: `${workspaceBase}/dashboard`,
      action: "Open cohort pipeline",
    },
    {
      id: "event",
      kind: "context",
      label: "Operating context",
      title: "Create the event context",
      description:
        "An event holds the program, resources, policies, plans, commitments, releases, and live execution state without duplicating people.",
      evidence: event
        ? `${event.name} · ${event.lifecycle} · ${event.timezone}`
        : "No event is exposed by the dashboard projection yet.",
      complete: event !== null,
      href: `${workspaceBase}/events`,
      action: "Open all events",
    },
    {
      id: "plan",
      kind: "candidate",
      label: "Candidate truth",
      title: "Compile a candidate plan",
      description:
        "Inspect assignments and compiler explanations before any organizer choice is recorded as a decision.",
      evidence: planEvidence(state),
      complete: state.candidatePlan !== null || state.currentPlan !== null,
      href: eventBase ? `${eventBase}/plan` : `${workspaceBase}/events`,
      action: eventBase ? "Open Plan Studio" : "Open all events",
    },
    {
      id: "decision",
      kind: "decision",
      label: "Decision truth",
      title: "Record the organizer decision",
      description:
        "Approval is an appended organizer record. It does not rewrite the immutable candidate plan that it responds to.",
      evidence: decisionEvidence(state),
      complete: state.currentPlan !== null && state.approvals.length > 0,
      href: eventBase ? `${eventBase}/plan` : `${workspaceBase}/events`,
      action: eventBase ? "Review plan evidence" : "Open all events",
    },
    {
      id: "commitment",
      kind: "commitment",
      label: "Commitment truth",
      title: "Capture an exact commitment",
      description:
        "A response belongs to one exact offer envelope. Acceptance stays distinct from organizer assignment and from later attendance.",
      evidence: commitmentEvidence(state),
      complete: acceptedOffers > 0,
      href: eventBase ? `${eventBase}/speakers` : `${workspaceBase}/events`,
      action: eventBase ? "Open commitments" : "Open all events",
    },
    {
      id: "publication",
      kind: "publication",
      label: "Audience projection",
      title: "Inspect the publication release",
      description:
        "Publication projects an exact approved plan and commitment boundary for an audience. It is not another truth layer.",
      evidence: state.release
        ? "A sealed release is projected for the dashboard event."
        : "No sealed release is projected for the dashboard event.",
      complete: state.release !== null,
      href: eventBase ? `${eventBase}/publication` : `${workspaceBase}/events`,
      action: eventBase ? "Open publication" : "Open all events",
    },
    {
      id: "operations",
      kind: "operational",
      label: "Operational truth",
      title: "Record what actually happened",
      description:
        "An observation reports execution. It does not retroactively prove qualification, assignment, approval, or acceptance.",
      evidence: state.observations.length > 0
        ? `${countLabel(state.observations.length, "operational observation")} projected for the dashboard event.`
        : "No operational observations are projected for the dashboard event.",
      complete: state.observations.length > 0,
      href: eventBase ? `${eventBase}/operations` : `${workspaceBase}/events`,
      action: eventBase ? "Open operations ledger" : "Open all events",
    },
  ];
}

function presentCheckpoints(checkpoints: readonly GettingStartedCheckpoint[]): readonly PresentedCheckpoint[] {
  const nextIndex = checkpoints.findIndex((checkpoint) => !checkpoint.complete);
  return checkpoints.map((checkpoint, index) => ({
    ...checkpoint,
    status: checkpoint.complete
      ? "complete"
      : index === nextIndex
        ? "current"
        : "waiting",
  }));
}

function TruthLayerPrimer({
  label,
  title,
  description,
  kind,
}: {
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly kind: "candidate" | "decision" | "commitment" | "operational";
}) {
  return (
    <article className={`${styles.truthCard} ${kindClasses[kind]}`}>
      <p>{label}</p>
      <h3>{title}</h3>
      <span>{description}</span>
    </article>
  );
}

export function GettingStarted({
  state,
  workspaceName,
  workspaceSlug,
}: {
  readonly state: DashboardState;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
}) {
  const checkpoints = presentCheckpoints(createCheckpoints(state, workspaceSlug));
  const completedCount = checkpoints.filter((checkpoint) => checkpoint.complete).length;
  const nextCheckpoint = checkpoints.find((checkpoint) => checkpoint.status === "current") ?? null;
  const workspaceBase = `/w/${encodeURIComponent(workspaceSlug)}`;
  const event = state.event.event;

  return (
    <div className={styles.page} data-testid="getting-started">
      <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
        <Link href={`${workspaceBase}/dashboard`}>Workspace home</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Getting started</span>
      </nav>

      <section className={styles.hero} aria-labelledby="getting-started-title">
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>Getting started · live workspace evidence</p>
          <h1 id="getting-started-title">Build your first event without losing the truth.</h1>
          <p className={styles.lede}>
            Follow one calm path from source-backed people to an observed outcome. Every check below
            is recalculated from server records for <strong>{workspaceName}</strong>; this page stores
            no completion state and grants no authority.
          </p>
          <div className={styles.heroActions}>
            {nextCheckpoint ? (
              <Link className={styles.primaryAction} href={nextCheckpoint.href}>
                Next: {nextCheckpoint.action}
                <span aria-hidden="true">→</span>
              </Link>
            ) : (
              <Link className={styles.primaryAction} href={`${workspaceBase}/events`}>
                Review event portfolio
                <span aria-hidden="true">→</span>
              </Link>
            )}
            <Link className={styles.secondaryAction} href={`${workspaceBase}/dashboard`}>
              Workspace home
            </Link>
          </div>
        </div>

        <aside className={styles.progressCard} aria-label="Server-derived setup progress">
          <div className={styles.progressTopline}>
            <span>Server evidence</span>
            <strong>{completedCount} of {checkpoints.length}</strong>
          </div>
          <progress
            aria-label={`${completedCount} of ${checkpoints.length} evidence checkpoints found`}
            max={checkpoints.length}
            value={completedCount}
          />
          <p>
            {completedCount === checkpoints.length
              ? "All eight checkpoints have matching server evidence."
              : nextCheckpoint
                ? `The next missing checkpoint is “${nextCheckpoint.title}.”`
                : "No missing checkpoint is currently projected."}
          </p>
          <span className={styles.progressBoundary}>Read-only guide · not an approval gate</span>
        </aside>
      </section>

      <aside className={styles.projectionNote} role="note" aria-label="Projection boundary">
        <span className={styles.noteMark} aria-hidden="true">i</span>
        <div>
          <strong>{event ? `Event evidence shown for ${event.name}` : "No dashboard event is projected"}</strong>
          <p>
            {event
              ? "Event-scoped checks follow the legacy dashboard event projection, not a workspace-wide current-event pointer. Use All events to choose another operating context."
              : "Event-scoped checks remain waiting until the dashboard projection exposes an event. Use All events to create or choose an operating context."}
          </p>
        </div>
        <Link href={`${workspaceBase}/events`}>All events <span aria-hidden="true">→</span></Link>
      </aside>

      <section className={styles.checklistSection} aria-labelledby="checklist-title">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.kicker}>First-event path</p>
            <h2 id="checklist-title">Continue where the evidence stops</h2>
          </div>
          <p>Steps may be revisited in any order. Status comes only from the loaded projection.</p>
        </header>

        <ol className={styles.checkpointList} aria-label="Getting-started checkpoints">
          {checkpoints.map((checkpoint, index) => (
            <li
              className={`${styles.checkpoint} ${styles[checkpoint.status]}`}
              data-setup-state={checkpoint.status}
              key={checkpoint.id}
            >
              <span className={styles.stepNumber} aria-hidden="true">
                {checkpoint.complete ? "✓" : String(index + 1).padStart(2, "0")}
              </span>
              <article aria-labelledby={`checkpoint-${checkpoint.id}`}>
                <div className={styles.checkpointTopline}>
                  <span className={`${styles.kindLabel} ${kindClasses[checkpoint.kind]}`}>
                    {checkpoint.label}
                  </span>
                  <span className={styles.statusLabel}>
                    <span aria-hidden="true" />
                    {statusLabels[checkpoint.status]}
                  </span>
                </div>
                <h3 id={`checkpoint-${checkpoint.id}`}>{checkpoint.title}</h3>
                <p>{checkpoint.description}</p>
                <p className={styles.evidenceLine}>
                  <span>Current evidence</span>
                  {checkpoint.evidence}
                </p>
              </article>
              <Link
                aria-current={checkpoint.status === "current" ? "step" : undefined}
                className={styles.checkpointAction}
                href={checkpoint.href}
              >
                {checkpoint.action}
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.truthSection} aria-labelledby="truth-title">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.kicker}>The durable mental model</p>
            <h2 id="truth-title">Four records, four different questions</h2>
          </div>
          <p>Later evidence can supersede or contradict earlier evidence. It never erases it.</p>
        </header>
        <div className={styles.truthGrid}>
          <TruthLayerPrimer
            description="A cohort snapshot or compiler result explains what the data and rules implied."
            kind="candidate"
            label="01 · Candidate"
            title="What was proposed?"
          />
          <TruthLayerPrimer
            description="An approval or override records the organizer's explicit choice."
            kind="decision"
            label="02 · Decision"
            title="What was chosen?"
          />
          <TruthLayerPrimer
            description="A response to exact terms records what the relevant person accepted."
            kind="commitment"
            label="03 · Commitment"
            title="What was accepted?"
          />
          <TruthLayerPrimer
            description="A sourced observation records what occurred during execution."
            kind="operational"
            label="04 · Operational"
            title="What happened?"
          />
        </div>
        <p className={styles.publicationBoundary}>
          <strong>Publication is different:</strong> it is an audience-specific projection of an
          exact decision and commitment boundary, not a fifth truth layer.
        </p>
      </section>

      <aside className={styles.scopeNote} role="note">
        <strong>No guessed progress.</strong>
        <span>
          Workspace defaults, collaborator invitations, and identity-review completion are not
          exposed by this read projection, so this guide does not mark them complete.
        </span>
      </aside>
    </div>
  );
}
