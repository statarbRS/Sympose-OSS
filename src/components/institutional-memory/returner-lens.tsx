import Link from "next/link";

import { formatDateTime } from "@/components/truth";
import type {
  ReturnerCoverageItem,
  ReturnerLensEntry,
  ReturnerLensResult,
} from "@/server/services/returner-lens";

import styles from "./returner-lens.module.css";

interface RenderedEventTimestamp {
  readonly text: string;
  readonly timezoneLabel: string;
  readonly fallbackLabel: string | null;
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function formatEventTimestamp(value: string, timezone: unknown): RenderedEventTimestamp {
  const persistedTimezone = validTimezone(timezone) ? timezone : null;
  try {
    return {
      text: new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: persistedTimezone ?? "UTC",
      }).format(new Date(value)),
      timezoneLabel: persistedTimezone ?? "UTC",
      fallbackLabel: persistedTimezone === null ? "Event timezone unavailable; shown in UTC." : null,
    };
  } catch {
    return {
      text: (() => {
        try {
          return new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "UTC",
          }).format(new Date(value));
        } catch {
          return "Time unavailable";
        }
      })(),
      timezoneLabel: "UTC",
      fallbackLabel: "Event-local formatting unavailable; shown in UTC.",
    };
  }
}

function EventTimestamp({ value, timezone }: { readonly value: string; readonly timezone: unknown }) {
  const rendered = formatEventTimestamp(value, timezone);
  return (
    <>
      <time dateTime={value}>{rendered.text}</time>
      {` · ${rendered.timezoneLabel}`}
      {rendered.fallbackLabel ? ` · ${rendered.fallbackLabel}` : null}
    </>
  );
}

function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function truthLabel(entry: ReturnerLensEntry): string {
  switch (entry.truthLayer) {
    case "candidate": return "Candidate evidence";
    case "decision": return "Decision";
    case "commitment": return "Commitment";
    case "operational": return "Operational";
    case "evidence": return "Source evidence";
  }
}

function EvidenceEntry({ item, timezone }: { readonly item: ReturnerLensEntry; readonly timezone?: string }) {
  return (
    <li className={styles.entry} data-family={item.family}>
      <span className={styles.timelineMarker} aria-hidden="true" />
      <div className={styles.entryMain}>
        <div className={styles.entryLabels}>
          <span className={`${styles.truthBadge} ${styles[`truth_${item.truthLayer}`]}`}>{truthLabel(item)}</span>
          <span className={styles.family}>{item.family.replaceAll("-", " ")}</span>
          {item.currentUse === "snapshot-at-read" ? <span className={styles.snapshot}>State at read time</span> : null}
          {item.currentUse === "current-record" ? <span className={styles.currentRecord}>Current stored record</span> : null}
        </div>
        <h4>{item.title}</h4>
        <p className={styles.entryDetail}>{item.detail}</p>
        <details className={styles.sourceDetails}>
          <summary>Exact source references</summary>
          <dl>
            {item.references.map((reference) => (
              <div key={`${reference.label}:${reference.value}`}>
                <dt>{reference.label}</dt>
                <dd><code>{reference.value}</code></dd>
              </div>
            ))}
            <div>
              <dt>Authority carryover</dt>
              <dd><strong>False</strong></dd>
            </div>
            <div>
              <dt>{item.fingerprint === null ? "Fingerprint" : item.fingerprintOrigin === "stored" ? "Stored fingerprint" : "Derived fingerprint"}</dt>
              <dd>{item.fingerprint === null ? "Not stored for this source" : <code>{item.fingerprint}</code>}</dd>
            </div>
          </dl>
        </details>
        {item.dueAt !== undefined ? (
          <p className={styles.entryDetail}>Due <EventTimestamp value={item.dueAt} timezone={timezone ?? ""} /></p>
        ) : null}
      </div>
      {timezone === undefined
        ? <time dateTime={item.recordedAt}>{formatDateTime(item.recordedAt)}</time>
        : <EventTimestamp value={item.recordedAt} timezone={timezone} />}
    </li>
  );
}

function CoverageCard({ item }: { readonly item: ReturnerCoverageItem }) {
  return (
    <li className={styles.coverageCard} data-state={item.state}>
      <div className={styles.coverageHeader}>
        <strong>{item.label}</strong>
        <span>{item.state.replaceAll("_", " ")}</span>
      </div>
      <p>{item.detail}</p>
    </li>
  );
}

export function ReturnerLens({ result }: { readonly result: ReturnerLensResult }) {
  const selected = result.selectedPerson;
  return (
    <div className={styles.lens} data-testid="returner-lens">
      <section className={styles.selectorPanel} aria-labelledby="returner-selector-title">
        <div>
          <p className={styles.eyebrow}>Canonical Person projection</p>
          <h2 id="returner-selector-title">Returner Lens</h2>
          <p>
            Inspect one person’s source-backed history across events. The lens is read-only and never
            turns a prior decision, commitment, role, task, or approval into current authority.
          </p>
        </div>
        <form className={styles.selectorForm} method="get" action={`/w/${result.workspaceSlug}/memory`}>
          <label htmlFor="returner-person">Person</label>
          <div className={styles.selectRow}>
            <select id="returner-person" name="person" defaultValue={selected?.id ?? ""} disabled={result.people.length === 0}>
              {result.people.length === 0 ? <option value="">No canonical people</option> : null}
              {result.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName} · {countLabel(person.eventCount, "event")}
                </option>
              ))}
            </select>
            <button type="submit" disabled={result.people.length === 0}>View history</button>
          </div>
          <p>{countLabel(result.people.length, "canonical person", "canonical people")} in this workspace. Selection changes the URL only; it creates no record.</p>
        </form>
      </section>

      {selected === null ? (
        <section className={styles.emptyState} aria-labelledby="no-people-title">
          <p className={styles.eyebrow}>Empty workspace state</p>
          <h2 id="no-people-title">No canonical person is available</h2>
          <p>No history is fabricated. Additions and identity changes belong in their owning workflow, not in Institutional Memory.</p>
        </section>
      ) : (
        <>
          <section className={styles.personHeader} aria-labelledby="selected-person-title">
            <div>
              <p className={styles.eyebrow}>{selected.returnerState.replaceAll("_", " ")}</p>
              <h2 id="selected-person-title"><Link href={`/w/${result.workspaceSlug}/people/${selected.id}`}>{selected.fullName}</Link></h2>
              <p>{[selected.title, selected.organization].filter(Boolean).join(" · ") || "No title or organization is present on the canonical Person."}</p>
            </div>
            <dl className={styles.metrics} aria-label="Returner history summary">
              <div><dt>Events with evidence</dt><dd>{result.counts.eventsWithEvidence}</dd></div>
              <div><dt>Historical records</dt><dd>{result.counts.historicalRecords}</dd></div>
              <div><dt>Applications</dt><dd>{result.counts.applications}</dd></div>
              <div><dt>Decisions</dt><dd>{result.counts.decisions}</dd></div>
              <div><dt>Session roles</dt><dd>{result.counts.sessionRoles}</dd></div>
              <div><dt>Editorial records</dt><dd>{result.counts.editorialRecords}</dd></div>
            </dl>
          </section>

          <aside className={styles.authorityBoundary} aria-label="History and current-authorization boundary">
            <div className={styles.historySide}>
              <span>Historical evidence</span>
              <strong>Available only where a canonical source is cited</strong>
              <p>Records stay attached to their original event, version, decision, gate, and timestamp.</p>
            </div>
            <div className={styles.authorizationSide}>
              <span>Current authorization · {result.currentAuthorization.state.replaceAll("_", " ")}</span>
              <strong>Nothing is carried forward</strong>
              <p>{result.currentAuthorization.detail}</p>
            </div>
          </aside>

          <section className={styles.historySection} aria-labelledby="event-history-title">
            <header className={styles.sectionHeader}>
              <div>
                <p className={styles.eyebrow}>Event-local context preserved</p>
                <h2 id="event-history-title">Cross-event history</h2>
              </div>
              <span>{countLabel(result.counts.eventsWithEvidence, "event with evidence", "events with evidence")}</span>
            </header>
            {result.counts.historicalRecords === 0 ? (
              <div className={styles.inlineEmpty}>
                <strong>No source-backed history is present for this person.</strong>
                <p>Absence does not imply no participation, poor reliability, rejection, or any other conclusion.</p>
              </div>
            ) : null}
            <div className={styles.eventStack}>
              {result.eventHistory.map(({ event, entries }) => (
                <article key={event.id} className={styles.eventCard}>
                  <header className={styles.eventHeader}>
                    <div>
                      <p><EventTimestamp value={event.startsAt} timezone={event.timezone} /></p>
                      <h3><Link href={`/w/${result.workspaceSlug}/events/${event.id}/overview`}>{event.name}</Link></h3>
                    </div>
                    <div className={styles.eventState}>
                      <span>{event.lifecycle}</span>
                      <strong>{countLabel(entries.length, "record")}</strong>
                    </div>
                  </header>
                  {entries.length > 0 ? (
                    <ol className={styles.timeline} aria-label={`${event.name} returner history`}>
                      {entries.map((item) => <EvidenceEntry key={item.id} item={item} timezone={event.timezone} />)}
                    </ol>
                  ) : (
                    <div className={styles.eventEmpty}>
                      <strong>No event-linked evidence for this person</strong>
                      <p>No application, decision, role, observation, task, editorial record, or artifact is inferred for this event.</p>
                    </div>
                  )}
                </article>
              ))}
              {result.eventHistory.length === 0 ? (
                <div className={styles.eventEmpty}><strong>No persisted events exist in this workspace.</strong></div>
              ) : null}
            </div>
          </section>

          <div className={styles.supportingGrid}>
            <section className={styles.supportingPanel} aria-labelledby="workspace-evidence-title">
              <p className={styles.eyebrow}>No invented event binding</p>
              <h2 id="workspace-evidence-title">Workspace-level evidence</h2>
              <p>Person provenance and cohort snapshots remain eventless when their canonical record has no event identifier.</p>
              {result.workspaceEvidence.length > 0 ? (
                <ol className={styles.timeline}>
                  {result.workspaceEvidence.map((item) => <EvidenceEntry key={item.id} item={item} />)}
                </ol>
              ) : <p className={styles.panelEmpty}>No eventless provenance or cohort evidence is present.</p>}
            </section>

            <section className={styles.supportingPanel} aria-labelledby="coverage-title">
              <p className={styles.eyebrow}>Availability is part of the answer</p>
              <h2 id="coverage-title">Evidence coverage</h2>
              <ul className={styles.coverageGrid}>
                {result.coverage.map((item) => <CoverageCard key={item.key} item={item} />)}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
