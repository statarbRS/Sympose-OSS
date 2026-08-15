import Link from "next/link";

import { ActionCard } from "@/components/action-card";
import { MAX_EVENTS_PER_WORKSPACE, type EventRow } from "@/server/services/events";

import { EmptyState, styles as surfaceStyles } from "../[eventId]/_components/product-surface";

import styles from "./event-switcher.module.css";
import { createEventAction } from "../actions";

function formatEventDate(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "Date unavailable";
  }
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(timestamp);
}

function eventDateRange(event: EventRow): string {
  return `${formatEventDate(event.startsAt)} – ${formatEventDate(event.endsAt)}`;
}

function lifecycleLabel(lifecycle: string): string {
  switch (lifecycle.toLowerCase()) {
    case "draft":
      return "Early setup";
    case "planning":
      return "Building the operating context";
    case "published":
      return "Released to its audience";
    case "live":
      return "Operations in progress";
    case "closed":
      return "Historical record";
    case "cancelled":
      return "Cancelled · history retained";
    default:
      return "Lifecycle state";
  }
}

export function EventSwitcher({
  workspace,
  events,
  createdEventId,
}: {
  workspace: string;
  events: readonly EventRow[];
  createdEventId?: string;
}) {
  const eventCount = `${events.length} event${events.length === 1 ? "" : "s"}`;
  const createdEvent = createdEventId
    ? events.find((event) => event.id === createdEventId)
    : undefined;
  const atEventLimit = events.length >= MAX_EVENTS_PER_WORKSPACE;
  const hasOneEvent = events.length === 1;
  const syntheticSecondEventDefaults = workspace === "acme" && hasOneEvent
    ? {
        eventName: "Acme Evaluator Workshop",
        unitName: "Second synthetic session",
        capacity: 24,
      }
    : null;

  return (
    <article className={`${surfaceStyles.surface} ${styles.portfolio}`} data-surface="event-portfolio" data-testid="event-portfolio">
      <a className={surfaceStyles.skipLink} href="#event-portfolio-main">Skip to event portfolio</a>
      <nav className={surfaceStyles.contextNav} aria-label="Workspace event navigation">
        <Link
          aria-current="page"
          className={`${surfaceStyles.contextLink} ${surfaceStyles.contextLinkActive}`}
          href={`/w/${workspace}/events`}
          data-testid="all-events-current-link"
        >
          All events
        </Link>
        <Link className={surfaceStyles.contextLink} href={`/w/${workspace}/dashboard`}>
          Workspace dashboard
        </Link>
      </nav>

      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <p className={styles.eyebrow}>Workspace collection · operating contexts</p>
          <h1>All events</h1>
          <p className={styles.lede}>
            Choose an event operating context without losing the workspace boundary. The table keeps
            lifecycle, planning, publication, and timezone state readable at a glance.
          </p>
        </div>
        <div className={styles.truthKey} aria-label="Event portfolio scope">
          <strong>{eventCount}</strong>
          <span>Workspace-scoped collection</span>
        </div>
      </header>

      {createdEvent ? (
        <div className={surfaceStyles.state} role="status" data-testid="event-created-status">
          <strong>Event created</strong>
          <div>
            <Link href={`/w/${workspace}/events/${createdEvent.id}/overview`}>
              {createdEvent.name}
            </Link>{" "}
            is now in this workspace portfolio and ready to open.
          </div>
        </div>
      ) : null}

      <div id="event-portfolio-main" className={styles.main} role="region" aria-label="All workspace events">
        <section className={`${surfaceStyles.section} ${styles.collectionSection}`} aria-labelledby="event-list-title" data-testid="event-list">
          <header className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>Browse and switch context</p>
              <h2 id="event-list-title">Switch event</h2>
            </div>
            <p className={styles.muted}>Only events belonging to this authenticated workspace are listed.</p>
          </header>
          {events.length === 0 ? (
            <EmptyState>
              No events have been created in this workspace yet. Use the authorized creation flow below
              to start one.
            </EmptyState>
          ) : (
            <div className={`${surfaceStyles.tableWrap} ${styles.tableWrap}`} role="region" aria-label="Workspace events table" tabIndex={0}>
              <table className={`${surfaceStyles.table} ${styles.table}`}>
                <caption>Events available in this workspace</caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Lifecycle</th>
                    <th scope="col">Dates</th>
                    <th scope="col">Planning</th>
                    <th scope="col"><span className="visually-hidden">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id} data-testid={`event-row-${event.id}`}>
                      <th scope="row" data-label="Event">
                        <Link
                          href={`/w/${workspace}/events/${event.id}/overview`}
                          aria-label={`Open ${event.name}`}
                        >
                          {event.name}
                        </Link>
                      </th>
                      <td data-label="Lifecycle">
                        <span className={styles.lifecycleState}>{event.lifecycle}</span>
                        <span className={styles.cellHint}>{lifecycleLabel(event.lifecycle)}</span>
                      </td>
                      <td data-label="Dates">
                        <time dateTime={event.startsAt}>{eventDateRange(event)}</time>
                        <br />
                        <span className={styles.cellHint}>{event.timezone}</span>
                      </td>
                      <td data-label="Planning">
                        {event.currentPlanVersionId ? "Current plan" : "No current plan"}
                        <br />
                        <span className={styles.cellHint}>
                          {event.currentReleaseId ? "Publication ready" : "No publication release"}
                        </span>
                      </td>
                      <td data-label="Open">
                        <Link
                          className={`${surfaceStyles.contextLink} ${styles.openLink}`}
                          href={`/w/${workspace}/events/${event.id}/overview`}
                          data-testid={`open-event-${event.id}`}
                        >
                          Open event
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section
          className={`${surfaceStyles.section} ${styles.createSection}`}
          aria-labelledby="create-event-title"
          data-testid={hasOneEvent ? "create-second-event" : "create-event"}
        >
          <header className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>Start a new operating context</p>
              <h2 id="create-event-title">{hasOneEvent ? "Create a second event" : "Create an event"}</h2>
            </div>
            <p className={styles.muted}>
              This uses the existing workspace-authorized event command. Validation, capability checks,
              idempotency, the two-event ceiling, and workspace scoping remain on the server. A second
              event receives a separate identity and first program unit; CFP, review, and speaker records
              are not copied.
            </p>
          </header>
          <div className={styles.createBody}>
          <ActionCard
            step={1}
            title={hasOneEvent ? "Add a second event operating context" : "Start an event operating context"}
            description={hasOneEvent
              ? "Create a separate event identity and return to the workspace portfolio to switch between event contexts."
              : "Create the event together with its first program unit; the server derives the workspace from your authenticated session."}
            action={createEventAction}
            submitLabel={hasOneEvent ? "Create second event" : "Create event"}
            disabled={atEventLimit}
            wide
            status={atEventLimit
              ? `This bounded MVP allows ${MAX_EVENTS_PER_WORKSPACE} events per workspace; both are listed above.`
              : "The form never accepts a caller-supplied workspace identifier. After creation, the server returns to this portfolio."}
          >
            <input type="hidden" name="returnToPortfolio" value="true" />
            <label className="field">
              <span className="field__label">Event name</span>
              <input
                type="text"
                name="eventName"
                required
                minLength={2}
                maxLength={80}
                defaultValue={syntheticSecondEventDefaults?.eventName}
                placeholder="e.g. Berlin Roundtable"
              />
            </label>
            <label className="field">
              <span className="field__label">First program unit</span>
              <input
                type="text"
                name="unitName"
                required
                minLength={2}
                maxLength={80}
                defaultValue={syntheticSecondEventDefaults?.unitName}
                placeholder="e.g. Morning circle"
              />
            </label>
            <label className="field">
              <span className="field__label">Capacity</span>
              <input
                type="number"
                name="capacity"
                required
                min={1}
                max={99}
                defaultValue={syntheticSecondEventDefaults?.capacity ?? 6}
              />
            </label>
          </ActionCard>
          </div>
        </section>
      </div>
    </article>
  );
}
