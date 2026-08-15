"use client";

import { useActionState, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";

import {
  approvePlanAction,
  compilePlanAction,
  createEventAction,
  deliverOffersAction,
  freezeSnapshotAction,
  importFixtureAction,
  proveCrossWorkspaceDenialAction,
  recordAttendanceAction,
  revokeTokenAction,
  sealReleaseAction,
  signOutAction,
  simulateAcceptanceAction,
} from "@/server/actions";
import type { ActionResult } from "@/server/actions";
import type { DashboardState } from "@/server/services/queries";
import { ActionCard } from "./action-card";
import { Badge, Fingerprint, formatDateTime } from "./truth";
import styles from "./workspace-dashboard.module.css";

const DASHBOARD_PEOPLE_PAGE_SIZE = 100;

function PersonTruthCell({
  available,
  active,
  tone,
  activeLabel,
  inactiveLabel,
}: {
  available: boolean;
  active: boolean;
  tone: "qualified" | "assigned" | "accepted" | "attended";
  activeLabel: string;
  inactiveLabel: string;
}) {
  if (!available) {
    return <span className="truth-state truth-state--unknown">Not measured</span>;
  }
  return active ? (
    <Badge tone={tone}>{activeLabel}</Badge>
  ) : (
    <span className="truth-state truth-state--inactive">{inactiveLabel}</span>
  );
}

function summarizeAuditDetails(details: Record<string, unknown>): string {
  const serialized = JSON.stringify(details) ?? "{}";
  return serialized.length > 72 ? `${serialized.slice(0, 69)}...` : serialized;
}

function EventActionCard({
  index,
  label,
  title,
  description,
  status,
  statusTone,
  href,
  actionLabel,
}: {
  index: string;
  label: string;
  title: string;
  description: string;
  status: string;
  statusTone: "ready" | "pending" | "neutral";
  href: string;
  actionLabel: string;
}) {
  return (
    <article className={styles.eventActionCard}>
      <div className={styles.eventActionTopline}>
        <span className={styles.eventActionIndex}>{index}</span>
        <span className={styles.eventActionLabel}>{label}</span>
      </div>
      <h3 className={styles.eventActionTitle}>{title}</h3>
      <div className={styles.eventActionContext}>
        <p className={styles.eventActionDescription}>{description}</p>
      </div>
      <div className={styles.eventActionFooter}>
        <span className={`${styles.eventActionStatus} ${styles[`eventActionStatus--${statusTone}`]}`}>
          {status}
        </span>
        <Link className={styles.eventActionLink} href={href}>
          {actionLabel} <span aria-hidden="true">→</span>
        </Link>
      </div>
    </article>
  );
}

function EventSummaryValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.eventSummaryValue}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function TruthSummaryStat({
  label,
  tone,
  statusLabel,
  count,
  available,
}: {
  label: string;
  tone: "qualified" | "assigned" | "accepted" | "attended";
  statusLabel: string;
  count: number | null;
  available: boolean;
}) {
  return (
    <div className="dash__truth-stat">
      <span className="dash__truth-label">
        <span>{label}</span>
        {available ? <Badge tone={tone}>{statusLabel}</Badge> : <span className="truth-state truth-state--unknown">Unknown</span>}
      </span>
      <strong className="dash__count">{count ?? "—"}</strong>
    </div>
  );
}

function PeopleTruthHeader({
  label,
  tone,
  count,
  eventScoped,
}: {
  label: string;
  tone: "qualified" | "assigned" | "accepted" | "attended";
  count: number | null;
  eventScoped: boolean;
}) {
  return (
    <span className={styles.peopleColumnHeader}>
      <span>{label}</span>
      {eventScoped ? count === null
        ? <span className="truth-state truth-state--unknown">Unknown</span>
        : <Badge tone={tone}>{count}</Badge> : null}
    </span>
  );
}

export function SignOutForm() {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(signOutAction, null);
  return (
    <form action={formAction}>
      <button type="submit" className="btn btn--ghost" disabled={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {state && !state.ok ? <span className="shell__error">{state.message}</span> : null}
    </form>
  );
}

export interface EvaluatorDashboardLinks {
  workspaceSlug: string;
  callSlug: string;
  eventId: string;
  publicChannelReference: string | null;
}

export function WorkspaceDashboard({
  state,
  slug,
  evaluator,
}: {
  state: DashboardState;
  slug: string;
  evaluator: EvaluatorDashboardLinks | null;
}) {
  const event = state.event.event;
  const units = state.event.units;
  const candidatePlan = state.candidatePlan;
  const currentPlan = state.currentPlan;
  const displayPlan = candidatePlan ?? currentPlan;
  const activeTokens = state.tokens.filter((t) => t.revokedAt === null);
  const pendingOfferRows = state.offers.filter((o) => o.status === "offered" && o.response === null);
  const pendingOffers = pendingOfferRows.length;
  const nextPendingOffer = pendingOfferRows[0] ?? null;
  const [peoplePageNumber, setPeoplePageNumber] = useState(1);
  const peoplePageCount = Math.max(1, Math.ceil(state.people.length / DASHBOARD_PEOPLE_PAGE_SIZE));
  const currentPeoplePage = Math.min(peoplePageCount, Math.max(1, peoplePageNumber));
  const firstPeopleIndex = (currentPeoplePage - 1) * DASHBOARD_PEOPLE_PAGE_SIZE;
  const visiblePeople = state.people.slice(firstPeopleIndex, firstPeopleIndex + DASHBOARD_PEOPLE_PAGE_SIZE);
  const assignedPersonIds = new Set(
    state.planDetailView?.assignmentsJoined.map((assignment) => assignment.personId) ?? [],
  );
  const acceptedPersonIds = new Set(
    state.offers.filter((o) => o.response === "accepted").map((o) => o.personId),
  );
  const attendedPersonIds = new Set(state.observations.map((observation) => observation.personId));
  const qualifiedPersonIds = new Set(state.snapshotPersonIds);
  const qualifiedPersons = state.snapshot?.memberCount ?? null;
  const assignedPersons = state.planDetailView ? assignedPersonIds.size : null;
  const acceptedPersons = acceptedPersonIds.size;
  const commitmentEvidenceAvailable = Boolean(currentPlan && state.approvals.length > 0);
  const acceptedPersonsForDisplay = commitmentEvidenceAvailable ? acceptedPersons : null;
  const attendedPersons = attendedPersonIds.size;
  const configuredCapacity = units.reduce((total, unit) => total + unit.capacity, 0);
  const eventPlanSummary = candidatePlan && currentPlan
    ? `Candidate v${candidatePlan.versionNumber} · current approved v${currentPlan.versionNumber}`
    : candidatePlan
      ? `Candidate v${candidatePlan.versionNumber}`
      : currentPlan
        ? `${state.approvals.length > 0 ? "Approved" : "Current approval unavailable"} v${currentPlan.versionNumber}`
        : "Not compiled";
  const publicationStatus = state.release
    ? "Sealed release"
    : !currentPlan
      ? candidatePlan
        ? "Awaiting plan approval"
        : "Not ready"
      : state.approvals.length === 0
        ? "Awaiting plan approval"
        : acceptedPersons === 0
          ? "Waiting for acceptance"
          : "Publication checks required";
  const requiredWorkflow = [
    {
      step: 1,
      title: "Import provider evidence",
      enabled: true,
      incomplete: state.people.length === 0,
    },
    {
      step: 2,
      title: "Freeze cohort snapshot",
      enabled: state.people.length > 0,
      incomplete: !state.snapshot,
    },
    {
      step: 3,
      title: "Create event and program unit",
      enabled: true,
      incomplete: !event,
    },
    {
      step: 4,
      title: "Compile candidate plan",
      enabled: Boolean(event) && Boolean(state.snapshot) && units.length > 0,
      incomplete: !candidatePlan && !currentPlan,
    },
    {
      step: 5,
      title: "Approve plan (separate decision)",
      enabled: candidatePlan?.runStatus === "FEASIBLE",
      incomplete: Boolean(candidatePlan),
    },
    {
      step: 6,
      title: "Deliver exact offers",
      enabled: Boolean(currentPlan) && state.approvals.length > 0,
      incomplete: state.offers.length === 0,
    },
    {
      step: 7,
      title: "Simulate one acceptance",
      enabled: pendingOffers > 0,
      incomplete: acceptedPersons === 0 && pendingOffers > 0,
    },
    {
      step: 8,
      title: "Seal release with one-time links",
      enabled: Boolean(event) && Boolean(currentPlan) && state.approvals.length > 0,
      incomplete: !state.release,
    },
    {
      step: 10,
      title: "Record attendance",
      enabled: Boolean(event) && state.people.length > 0 && units.length > 0,
      incomplete: state.observations.length === 0,
    },
  ];
  const nextStep = requiredWorkflow.find((item) => item.enabled && item.incomplete)?.step ?? null;
  const nextActionTitle = requiredWorkflow.find((item) => item.step === nextStep)?.title ?? null;
  const publicationHref = event ? `/w/${slug}/events/${event.id}/publication` : null;
  const attentionAction = !event
    ? {
        title: "Create the first event context",
        consequence: "An event is required before planning, commitment, and publication work can begin.",
        href: "#pipeline-controls",
        label: "Open event setup",
      }
    : candidatePlan
      ? {
          title: `Review candidate Plan v${candidatePlan.versionNumber}`,
          consequence: "Approval appends an organizer decision for this exact plan; it does not publish or alter commitments.",
          href: `/w/${slug}/events/${event.id}/plan`,
          label: "Review exact plan",
        }
      : !currentPlan || state.approvals.length === 0
        ? {
            title: "Shape and approve the event plan",
            consequence: "The program remains candidate work until an organizer approves an exact immutable plan.",
            href: `/w/${slug}/events/${event.id}/program`,
            label: "Open Plan Studio",
          }
        : acceptedPersons === 0
          ? {
              title: "Check speaker commitments",
              consequence: "Publication remains blocked until accepted commitments exist for the approved plan.",
              href: `/w/${slug}/events/${event.id}/speakers`,
              label: "Open Speaker Operations",
            }
          : !state.release
            ? {
                title: "Validate the next event release",
                consequence: "The publication room must prove the exact schedule, content, artifacts, and audience boundary before sealing.",
                href: publicationHref!,
                label: "Open publication checks",
              }
            : {
                title: "Review event readiness",
                consequence: "The current release is sealed. Review remaining operational evidence without changing that immutable audience record.",
                href: `/w/${slug}/events/${event.id}/readiness`,
                label: "Open readiness",
              };
  const attentionUsesPipeline = attentionAction.href === "#pipeline-controls";
  const isNextStep = (step: number) => step === nextStep;

  return (
    <div className={`${styles.dashboard} dash`} data-testid="workspace-dashboard">
      <section className="dash__heading" aria-labelledby="dashboard-title">
        <div className={styles.headingIntro}>
          <p className={styles.kicker}>Organizer home · Today · workspace attention</p>
          <h1 id="dashboard-title">{event?.name ?? "No current event"}</h1>
          <p>
            Start with the event work queue, then inspect its operating context and supporting truth.
          </p>
          <p className={styles.headerMeta} aria-label="Event identity details">
            {event ? <span>{formatDateTime(event.startsAt)}</span> : null}
            {event ? <span>{event.timezone} event time</span> : null}
            {event ? <span>{state.people.length} canonical people</span> : null}
          </p>
        </div>
        <aside className={styles.nextActionPanel} aria-label="Next required action">
          <span className={styles.nextActionLabel}>Attention queue</span>
          <strong>{attentionAction.title}</strong>
          <p className="dash__next-action" role="status">
            {attentionAction.consequence}
          </p>
          <a
            className={styles.nextActionLink}
            href={attentionAction.href}
            aria-controls={attentionUsesPipeline ? "pipeline-controls" : undefined}
            onClick={() => {
              if (!attentionUsesPipeline) return;
              const controls = document.getElementById("pipeline-controls");
              if (controls instanceof HTMLDetailsElement) {
                controls.open = true;
                controls.querySelector("summary")?.focus();
              }
            }}
          >
            {attentionAction.label} <span aria-hidden="true">{attentionUsesPipeline ? "↓" : "→"}</span>
          </a>
        </aside>
      </section>

      {event ? (
        <>
          <section className={styles.eventWorkbench} aria-labelledby="event-workbench-title">
            <header className={styles.sectionHeader}>
              <div>
                <p className={styles.kicker}>Needs attention · event workflow</p>
                <h2 id="event-workbench-title">Next actions for this event</h2>
              </div>
              <p>Open the next context with its handoff, evidence, and selection authority visible.</p>
            </header>
            <div className={styles.eventActionGrid}>
              <EventActionCard
                index="01"
                label="Plan Studio"
                title={candidatePlan ? `Review Plan v${candidatePlan.versionNumber}` : "Shape the program"}
                description="Work with the exact plan and schedule lineage. Draft changes remain candidate truth until separately approved."
                status={eventPlanSummary}
                statusTone={currentPlan && state.approvals.length > 0 ? "ready" : "pending"}
                href={`/w/${slug}/events/${event.id}/${candidatePlan ? "plan" : "program"}`}
                actionLabel={candidatePlan ? "Review plan" : "Open studio"}
              />
              <EventActionCard
                index="02"
                label="Speakers"
                title="Check speaker readiness"
                description="Open speaker commitments, content tasks, and readiness context for the people attached to this event."
                status={commitmentEvidenceAvailable ? `${acceptedPersons} accepted` : "Commitment evidence unavailable"}
                statusTone={commitmentEvidenceAvailable && acceptedPersons > 0 ? "ready" : "neutral"}
                href={`/w/${slug}/events/${event.id}/speakers`}
                actionLabel="Check speakers"
              />
              <EventActionCard
                index="03"
                label="Publication"
                title="Review publication"
                description="Check audience readiness and the sealed release boundary. Publication projects approved decisions; it does not rewrite event truth."
                status={publicationStatus}
                statusTone={state.release ? "ready" : "pending"}
                href={`/w/${slug}/events/${event.id}/publication`}
                actionLabel="Open publication"
              />
            </div>
          </section>

          <div className={styles.eventContext}>
            <section className={styles.currentEvent} aria-labelledby="current-event-title">
              <header className={styles.currentEventHeader}>
                <div>
                  <p className={styles.kicker}>Current event · operating context</p>
                  <h2 id="current-event-title">{event.name}</h2>
                  <p className={styles.eventMeta}>Event operating context · {event.timezone}</p>
                </div>
                <div className={styles.currentEventActions}>
                  <span className={styles.lifecycle}>
                    Lifecycle <strong>{event.lifecycle}</strong>
                  </span>
                </div>
              </header>
              <dl className={styles.eventSummaryGrid}>
                <EventSummaryValue label="Dates">
                  {formatDateTime(event.startsAt)} → {formatDateTime(event.endsAt)}
                </EventSummaryValue>
                <EventSummaryValue label="Program">
                  {units.length} unit{units.length === 1 ? "" : "s"} · {configuredCapacity} configured seats
                </EventSummaryValue>
                <EventSummaryValue label="Qualified cohort">{qualifiedPersons === null ? "Not measured" : `${qualifiedPersons} people`}</EventSummaryValue>
                <EventSummaryValue label="Plan">{eventPlanSummary}</EventSummaryValue>
                <EventSummaryValue label="Publication">{publicationStatus}</EventSummaryValue>
              </dl>
            </section>

          </div>

          {evaluator ? (
            <nav className={styles.secondaryRoutes} aria-label="Evaluator surfaces">
              <div className={styles.referenceNavigationHeader}>
                <div>
                  <span className={styles.referenceNavigationCaption}>Reference navigation</span>
                  <span className={styles.secondaryRoutesLabel}>Evaluator surfaces</span>
                </div>
                <p>Keep the evaluator handoffs grouped by the operating stage they support.</p>
              </div>
              <div className={styles.referenceNavigationGroups}>
                <section className={styles.referenceNavigationGroup} aria-labelledby="evaluator-intake-title">
                  <h3 id="evaluator-intake-title">Intake</h3>
                  <ul>
                    <li>
                      <Link href={`/cfp/${evaluator.workspaceSlug}/${evaluator.callSlug}`}>Public CFP</Link>
                    </li>
                    <li>
                      <Link href={`/w/${evaluator.workspaceSlug}/events/${evaluator.eventId}/cfp`}>Organizer CFP</Link>
                    </li>
                  </ul>
                </section>
                <section className={styles.referenceNavigationGroup} aria-labelledby="evaluator-evaluation-title">
                  <h3 id="evaluator-evaluation-title">Evaluation</h3>
                  <ul>
                    <li>
                      <Link href={`/w/${evaluator.workspaceSlug}/events/${evaluator.eventId}/review`}>Review surface</Link>
                    </li>
                  </ul>
                </section>
                <section className={styles.referenceNavigationGroup} aria-labelledby="evaluator-commitment-title">
                  <h3 id="evaluator-commitment-title">Commitment</h3>
                  <ul>
                    <li>
                      <Link href={`/w/${evaluator.workspaceSlug}/events/${evaluator.eventId}/speakers`}>Speaker surface</Link>
                    </li>
                  </ul>
                </section>
                <section className={styles.referenceNavigationGroup} aria-labelledby="evaluator-program-title">
                  <h3 id="evaluator-program-title">Program</h3>
                  <ul>
                    <li>
                      <Link className={styles.eventOverviewLink} href={`/w/${slug}/events/${event.id}/overview`}>
                        Open event overview <span aria-hidden="true">→</span>
                      </Link>
                    </li>
                    <li>
                      <Link href={`/w/${evaluator.workspaceSlug}/events/${evaluator.eventId}/program`}>Program builder</Link>
                    </li>
                  </ul>
                </section>
                <section className={styles.referenceNavigationGroup} aria-labelledby="evaluator-publication-title">
                  <h3 id="evaluator-publication-title">Publication</h3>
                  <ul>
                    <li>
                      <Link href={`/w/${evaluator.workspaceSlug}/events/${evaluator.eventId}/publication`}>
                        Publication surface
                      </Link>
                    </li>
                    {evaluator.publicChannelReference ? (
                      <li>
                        <Link href={`/embed/${encodeURIComponent(evaluator.publicChannelReference)}`}>Public widgets</Link>
                      </li>
                    ) : null}
                  </ul>
                </section>
              </div>
            </nav>
          ) : null}
        </>
      ) : (
        <div className={styles.eventContext}>
          <section className={styles.noEvent} aria-labelledby="no-current-event-title" role="status">
            <p className={styles.kicker}>Current event</p>
            <h2 id="no-current-event-title">No event is active yet</h2>
            <p>Create the event and its first program unit in the pipeline below to unlock event operations.</p>
          </section>
          <section className="dash__strip dash__truth-summary" aria-label="Truth counts">
            <TruthSummaryStat label="Candidate truth" tone="qualified" statusLabel="Qualified" count={qualifiedPersons} available={state.snapshot !== null} />
            <TruthSummaryStat label="Candidate projection" tone="assigned" statusLabel="Assigned" count={assignedPersons} available={state.planDetailView !== null} />
            <TruthSummaryStat label="Commitment truth" tone="accepted" statusLabel="Accepted" count={acceptedPersonsForDisplay} available={commitmentEvidenceAvailable} />
            <TruthSummaryStat label="Operational truth" tone="attended" statusLabel="Observed" count={event ? attendedPersons : null} available={event !== null} />
          </section>
        </div>
      )}

      <section className="record-section dash__people" aria-labelledby="people-title">
        <header className={styles.collectionHeader}>
          <div>
            <p className={styles.kicker}>Canonical identity collection</p>
            <h2 id="people-title" className="dash__section-title">
              People <Badge tone="neutral">{state.people.length}</Badge>
            </h2>
            <p className={styles.collectionDescription}>
              One row per durable Person. Evidence and each truth-layer projection stay queryable side by side.
            </p>
          </div>
          <Link className="btn btn--ghost" href={`/w/${slug}/crm`}>
            Open optional speaker CRM
          </Link>
        </header>
        <details className={styles.collectionDisclosure}>
          <summary>
            <span>Browse canonical people</span>
            <span>{state.people.length} record{state.people.length === 1 ? "" : "s"} · qualification, assignment, commitment, and attendance</span>
          </summary>
          <div className={styles.collectionDisclosureBody}>
        {state.people.length > DASHBOARD_PEOPLE_PAGE_SIZE ? (
          <nav className={styles.peoplePagination} aria-label="People table pages">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={currentPeoplePage === 1}
              onClick={() => setPeoplePageNumber(currentPeoplePage - 1)}
            >
              Previous
            </button>
            <span aria-live="polite">
              Page <strong>{currentPeoplePage}</strong> of {peoplePageCount} · {firstPeopleIndex + 1}–{firstPeopleIndex + visiblePeople.length} of {state.people.length}
            </span>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={currentPeoplePage === peoplePageCount}
              onClick={() => setPeoplePageNumber(currentPeoplePage + 1)}
            >
              Next
            </button>
          </nav>
        ) : null}
        <div className="table-wrap dash__table-scroll" role="region" aria-label="People table">
          <table className="dash__table dash__people-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Organization</th>
                <th scope="col">Evidence</th>
                <th scope="col">
                  <PeopleTruthHeader
                    label="Qualified"
                    tone="qualified"
                    count={qualifiedPersons}
                    eventScoped={Boolean(event)}
                  />
                </th>
                <th scope="col">
                  <PeopleTruthHeader
                    label="Assigned"
                    tone="assigned"
                    count={assignedPersons}
                    eventScoped={Boolean(event)}
                  />
                </th>
                <th scope="col">
                  <PeopleTruthHeader
                    label="Accepted"
                    tone="accepted"
                    count={acceptedPersonsForDisplay}
                    eventScoped={commitmentEvidenceAvailable}
                  />
                </th>
                <th scope="col">
                  <PeopleTruthHeader
                    label="Attended"
                    tone="attended"
                    count={attendedPersons}
                    eventScoped={Boolean(event)}
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {visiblePeople.map((person) => (
                <tr key={person.id}>
                  <td>
                    <Link href={`/w/${slug}/people/${person.id}`} className="dash__person-link">
                      {person.fullName}
                    </Link>
                    <div className="dash__person-meta">
                      {person.canonicalEmail} · {person.title ?? "no title"}
                    </div>
                  </td>
                  <td>{person.organization ?? "no organization"}</td>
                  <td>
                    {person.sourceCount} source{person.sourceCount === 1 ? "" : "s"}
                  </td>
                  <td>
                    <PersonTruthCell
                      available={state.snapshot !== null}
                      active={qualifiedPersonIds.has(person.id)}
                      tone="qualified"
                      activeLabel="Qualified"
                      inactiveLabel="Outside frozen cohort"
                    />
                  </td>
                  <td>
                    <PersonTruthCell
                      available={state.planDetailView !== null}
                      active={assignedPersonIds.has(person.id)}
                      tone="assigned"
                      activeLabel="Assigned"
                      inactiveLabel="Not in approved plan"
                    />
                  </td>
                  <td>
                    <PersonTruthCell
                      available={commitmentEvidenceAvailable}
                      active={acceptedPersonIds.has(person.id)}
                      tone="accepted"
                      activeLabel="Accepted"
                      inactiveLabel="No accepted commitment"
                    />
                  </td>
                  <td>
                    <PersonTruthCell
                      available={event !== null}
                      active={attendedPersonIds.has(person.id)}
                      tone="attended"
                      activeLabel="Attended"
                      inactiveLabel="No attendance observation"
                    />
                  </td>
                </tr>
              ))}
              {state.people.length === 0 ? (
                <tr>
                  <td colSpan={7} className="dash__empty">
                    Import evidence to materialize people.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
          </div>
        </details>
      </section>

      <details
        id="pipeline-controls"
        className={styles.evaluatorDisclosure}
        aria-labelledby="evaluator-tools-title"
        data-testid="evaluator-disclosure"
      >
        <summary className={styles.evaluatorSummary}>
          <span className={styles.evaluatorSummaryCopy}>
            <span className={styles.kicker}>Evaluator controls · supporting workflow</span>
            <span id="evaluator-tools-title" className={styles.evaluatorSummaryTitle}>
              Pipeline, fixture controls, and audit trail
            </span>
            <span className={styles.evaluatorSummaryDescription}>
              Eleven explicit steps and their durable evidence stay available without competing with event work.
            </span>
          </span>
          <span className={styles.evaluatorSummaryState}>
            <span>{nextActionTitle ? `Next required: ${nextActionTitle}` : "Required workflow complete"}</span>
            <span className={styles.evaluatorSummaryMeta}>
              11 steps · {state.audit.length} audit event{state.audit.length === 1 ? "" : "s"}
            </span>
          </span>
        </summary>

        <div className={styles.evaluatorDetailsBody}>
          <section className="dash__pipeline" aria-label="Event pipeline">
            <header className={styles.collectionHeader}>
              <div>
                <p className={styles.kicker}>Guided handoff sequence</p>
                <h2 className="dash__section-title">11-step evaluator pipeline</h2>
                <p className={styles.collectionDescription}>
                  Required steps stay explicit; optional revocation and the boundary test remain visible without competing with the next action.
                </p>
              </div>
              <span className={styles.pipelineMeta}>11 steps · 10 required</span>
            </header>

            <div className="pipeline-rows">
        <ActionCard
          step={1}
          next={isNextStep(1)}
          title="Import provider evidence"
          description="Idempotently import synthetic fixture rows; provider payloads stay evidence, canonical people are resolved as the identity spine."
          action={importFixtureAction}
          submitLabel="Import fixture evidence"
          status={
            state.people.length > 0 ? (
              <>Canonical people resolved: <strong>{state.people.length}</strong>.</>
            ) : (
              "No people yet."
            )
          }
        />

        <ActionCard
          step={2}
          next={isNextStep(2)}
          title="Freeze cohort snapshot"
          description="Qualify the participant cohort from evidence; the immutable snapshot is the candidate layer's input fingerprint."
          action={freezeSnapshotAction}
          submitLabel="Freeze snapshot"
          disabled={state.people.length === 0}
          status={
            state.snapshot ? (
              <>
                Snapshot <Fingerprint value={state.snapshot.fingerprint} label="cohort snapshot SHA-256" />{" "}
                frozen {formatDateTime(state.snapshot.createdAt)} with {state.snapshot.memberCount} members.
              </>
            ) : (
              "No cohort snapshot frozen yet."
            )
          }
        />

        <ActionCard
          step={3}
          next={isNextStep(3)}
          title="Create event and program unit"
          description="Create the event with one program unit; event, unit, and capacity are the planning inputs."
          action={createEventAction}
          submitLabel="Create event"
          wide
          status={
            event ? (
              <>
                Event <strong>{event.name}</strong> (lifecycle {event.lifecycle}) with {units.length} program
                unit{units.length === 1 ? "" : "s"}.
              </>
            ) : (
              "No event yet."
            )
          }
        >
          <label className="field">
            <span className="field__label">Event name</span>
            <input type="text" name="eventName" required minLength={2} maxLength={80} placeholder="e.g. Berlin Roundtable" />
          </label>
          <label className="field">
            <span className="field__label">Program unit name</span>
            <input type="text" name="unitName" required minLength={2} maxLength={80} placeholder="e.g. Morning circle" />
          </label>
          <label className="field">
            <span className="field__label">Capacity</span>
            <input type="number" name="capacity" required min={1} max={99} defaultValue={6} />
          </label>
        </ActionCard>

        <ActionCard
          step={4}
          next={isNextStep(4)}
          title="Compile candidate plan"
          description="Compile assignments from the frozen snapshot against the event; the candidate plan is independently fingerprintable content."
          action={compilePlanAction}
          submitLabel="Compile plan"
          disabled={!event || !state.snapshot || units.length === 0}
          linkHref={event && currentPlan && !candidatePlan ? `/w/${slug}/events/${event.id}/plan` : undefined}
          linkLabel={event && currentPlan && !candidatePlan ? "Review immutable plan and explanations" : undefined}
          status={
            displayPlan ? (
              <>
                Plan v{displayPlan.versionNumber} <Fingerprint value={displayPlan.fingerprint} label="plan SHA-256" /> —{" "}
                {displayPlan.assignmentCount} assignments, state {displayPlan.status}.
              </>
            ) : (
              "No plan compiled yet."
            )
          }
        />

        <ActionCard
          step={5}
          next={isNextStep(5)}
          title="Approve plan (separate decision)"
          description="Approve the candidate plan explicitly; the decision is recorded in decision truth without rewriting the plan content."
          action={approvePlanAction}
          submitLabel="Approve candidate plan"
          disabled={!candidatePlan || candidatePlan.runStatus !== "FEASIBLE"}
          status={
            candidatePlan ? (
              `Plan v${candidatePlan.versionNumber} is ready for approval.`
            ) : currentPlan ? (
              state.approvals.length > 0 ? (
                <>
                  Approved {formatDateTime(state.approvals[state.approvals.length - 1].createdAt)} ({" "}
                  {state.approvals.length} approval{state.approvals.length === 1 ? "" : "s"} ).
                </>
              ) : (
                `Plan v${currentPlan.versionNumber} is not approved yet.`
              )
            ) : (
              "Compile the plan first."
            )
          }
        >
          {candidatePlan ? (
            <>
              <input type="hidden" name="planVersionId" value={candidatePlan.id} />
              <input type="hidden" name="expectedCurrentPlanVersionId" value={currentPlan?.id ?? ""} />
            </>
          ) : null}
        </ActionCard>

        <ActionCard
          step={6}
          next={isNextStep(6)}
          title="Deliver exact offers"
          description="Deliver one exact offer envelope per approved assignment; the simulated delivery adapter records commitment truth separately."
          action={deliverOffersAction}
          submitLabel="Deliver offers"
          disabled={!currentPlan || state.approvals.length === 0}
          status={
            state.offers.length > 0 ? (
              <>
                <strong>{state.offers.length}</strong> offers delivered — {pendingOffers} still pending.
              </>
            ) : (
              "No offers delivered yet."
            )
          }
        />

        <ActionCard
          step={7}
          next={isNextStep(7)}
          title="Simulate one acceptance"
          description="Simulate one person accepting the exact offer; commitment truth is recorded and the plan content stays untouched."
          action={simulateAcceptanceAction}
          submitLabel="Simulate one acceptance"
          disabled={pendingOffers === 0}
          status={
            acceptedPersons > 0 ? (
              <>
                <strong>{acceptedPersons}</strong> distinct person{acceptedPersons === 1 ? "" : "s"} accepted;
                {pendingOffers} pending offer{pendingOffers === 1 ? "" : "s"} left.
              </>
            ) : (
              `${pendingOffers} pending offer${pendingOffers === 1 ? "" : "s"} awaiting a response.`
            )
          }
        >
          {nextPendingOffer ? (
            <>
              <input type="hidden" name="offerId" value={nextPendingOffer.id} />
              <input type="hidden" name="commandKey" value={nextPendingOffer.acceptCommandKey} />
              <p className="muted">
                Exact replay target: {nextPendingOffer.personName} · offer {nextPendingOffer.id.slice(0, 8)}…
              </p>
            </>
          ) : null}
        </ActionCard>

        <ActionCard
          step={8}
          next={isNextStep(8)}
          title="Review publication readiness"
          description="Home does not infer release readiness. The publication room validates the exact approved schedule, content versions, artifact checksums, and audience projection before sealing."
          action={sealReleaseAction}
          submitLabel="Checks required"
          disabled
          linkHref={publicationHref ?? undefined}
          linkLabel="Open publication checks"
          status={
            state.release ? (
              <>
                Release <Fingerprint value={state.release.fingerprint} label="release SHA-256" /> sealed{" "}
                {formatDateTime(state.release.sealedAt)} — {state.tokens.length} portal tokens.
              </>
            ) : (
              "No validated current release. Readiness is unknown until the publication room completes every required check."
            )
          }
        />

        <ActionCard
          step={9}
          caution
          title="Revoke a portal token"
          description="Revoke one person's portal access; the sealed release itself remains unchanged and only the audit trail notes the revocation."
          action={revokeTokenAction}
          submitLabel="Revoke token"
          wide
          disabled={activeTokens.length === 0}
          status={
            activeTokens.length > 0 ? (
              <>
                <strong>{activeTokens.length}</strong> active token{activeTokens.length === 1 ? "" : "s"}{" "}
                {state.tokens.length - activeTokens.length > 0
                  ? `; ${state.tokens.length - activeTokens.length} already revoked.`
                  : "none revoked yet."}
              </>
            ) : state.tokens.length > 0 ? (
              "All portal tokens revoked."
            ) : (
              "Seal the release first to mint tokens."
            )
          }
        >
          <label className="field">
            <span className="field__label">Token</span>
            <select name="tokenId" required>
              {activeTokens.map((token) => (
                <option key={token.id} value={token.id}>
                  {token.personName} · {token.scope} · expires {formatDateTime(token.expiresAt)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Reason</span>
            <input type="text" name="reason" minLength={2} maxLength={120} defaultValue="Organizer revocation" />
          </label>
        </ActionCard>

        <ActionCard
          step={10}
          next={isNextStep(10)}
          title="Record attendance"
          description="During the live event window, record an explicit occurrence time; the server stores a separate ingestion time and exact retries reuse one receipt."
          action={recordAttendanceAction}
          submitLabel="Record attendance"
          wide
          disabled={!event || event.lifecycle !== "live" || state.people.length === 0 || units.length === 0}
          status={
            attendedPersons > 0 ? (
              <>
                <strong>{state.observations.length}</strong> observation{state.observations.length === 1 ? "" : "s"}{" "}
                for <strong>{attendedPersons}</strong> distinct person{attendedPersons === 1 ? "" : "s"}.
              </>
            ) : (
              "No attendance recorded yet."
            )
          }
        >
          {event ? <input type="hidden" name="eventId" value={event.id} /> : null}
          <label className="field">
            <span className="field__label">Person</span>
            <select name="personId" required>
              {state.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName} · {person.canonicalEmail}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Program unit</span>
            <select name="programUnitId" required>
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name} · capacity {unit.capacity}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Occurrence time (UTC ISO 8601)</span>
            <input
              type="text"
              name="observedAt"
              placeholder="2026-09-18T10:15:00.000Z"
              maxLength={40}
              required
            />
          </label>
        </ActionCard>

        <ActionCard
          step={11}
          title="Prove cross-workspace denial"
          description="Attempt to read the other seeded workspace through this session; the server always refuses because the session workspace is the only authority."
          action={proveCrossWorkspaceDenialAction}
          submitLabel="Attempt denied access"
          expectedDenial
          wide
          disabled={state.otherWorkspaceSlugs.length === 0}
          status={
            state.otherWorkspaceSlugs.length > 0 ? (
              <>Other seeded workspace{state.otherWorkspaceSlugs.length === 1 ? "" : "s"}:{" "}
                {state.otherWorkspaceSlugs.join(", ")}.</>
            ) : (
              "No other seeded workspace to attempt."
            )
          }
        >
          <label className="field">
            <span className="field__label">Target workspace</span>
            <select name="targetSlug" required>
              {state.otherWorkspaceSlugs.map((target) => (
                <option key={target} value={target}>
                  {target}
                </option>
              ))}
            </select>
          </label>
        </ActionCard>
            </div>
          </section>

          <section className="record-section dash__audit" aria-labelledby="audit-title">
            <header className={styles.collectionHeader}>
              <div>
                <p className={styles.kicker}>Durable activity</p>
                <h2 id="audit-title" className="dash__section-title">
                  Audit trail <Badge tone="neutral">{state.audit.length}</Badge>
                </h2>
                <p className={styles.collectionDescription}>
                  Actor, target, and concise detail remain visible; expanded JSON is available per event.
                </p>
              </div>
              <span className={styles.auditMeta}>Workspace-scoped</span>
            </header>
            <div className="table-wrap dash__table-scroll" role="region" aria-label="Audit trail">
              <table className="dash__table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Action</th>
                    <th scope="col">Target</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {state.audit.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.createdAt)}</td>
                      <td>
                        <code>{row.actorKind}</code> {row.actorRef.slice(0, 8)}…
                      </td>
                      <td>
                        <code>{row.action}</code>
                      </td>
                      <td>
                        {row.targetType ? (
                          <>
                            {row.targetType} {row.targetId?.slice(0, 8)}…
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="dash__table-details">
                        {row.details ? (
                          <details className="audit-detail">
                            <summary>{summarizeAuditDetails(row.details)}</summary>
                            <pre className="audit-detail__json">
                              <code>{JSON.stringify(row.details, null, 2) ?? "{}"}</code>
                            </pre>
                          </details>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {state.audit.length === 0 ? (
              <p className="dash__empty">No audit events yet; run a pipeline step.</p>
            ) : null}
          </section>
        </div>
      </details>
    </div>
  );
}
