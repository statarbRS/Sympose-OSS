"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  ITINERARY_UPDATED_EVENT,
  LocalStorageItineraryPersistence,
  itineraryStorageKey,
  toggleItineraryReference,
} from "@/server/services/public-widgets/itinerary";

import type {
  PublicAgendaSession,
  PublicAgendaViewModel,
} from "./public-agenda-view-model";
import styles from "./public-agenda.module.css";

function formatTime(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(value));
  } catch {
    return value.slice(11, 16);
  }
}

function formatEventDates(startsAt: string, endsAt: string, timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: timezone,
    });
    return formatter.formatRange(new Date(startsAt), new Date(endsAt));
  } catch {
    const startDate = startsAt.slice(0, 10);
    const endDate = endsAt.slice(0, 10);
    return startDate === endDate ? startDate : `${startDate} – ${endDate}`;
  }
}

function formatDayLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return value;
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) return value;
  try {
    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
      weekday: "short",
    }).format(instant);
  } catch {
    return value;
  }
}

function formatReleaseTime(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsTimestamp(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.000Z$/, "Z");
}

function downloadCalendar(projection: PublicAgendaViewModel, sessionSlug: string): void {
  const session = projection.sessions.find((candidate) => candidate.slug === sessionSlug);
  if (!session) return;
  const description = session.abstract ?? "Session description is not included in this public release.";
  const location = session.roomName && session.venue
    ? `${session.roomName}, ${session.venue}`
    : "Location is not included in this public release.";
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sympose//Public agenda//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeIcs(`${session.slug}-${session.startsAt}@sympose.local`)}`,
    `DTSTAMP:${icsTimestamp(projection.release.releasedAt)}`,
    `DTSTART:${icsTimestamp(session.startsAt)}`,
    `DTEND:${icsTimestamp(session.endsAt)}`,
    `SUMMARY:${escapeIcs(session.title)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `LOCATION:${escapeIcs(location)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const blob = new Blob([content], { type: "text/calendar" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `${session.slug}.ics`;
  anchor.click();
  URL.revokeObjectURL(href);
}

function createItinerary(projection: PublicAgendaViewModel, favoriteSessionSlugs: readonly string[]) {
  const favorites = new Set(favoriteSessionSlugs);
  return projection.sessions
    .filter((session) => favorites.has(session.slug))
    .sort((first, second) => first.startsAt.localeCompare(second.startsAt));
}

function speakerName(projection: PublicAgendaViewModel, speakerSlug: string): string {
  return projection.speakers.find((speaker) => speaker.slug === speakerSlug)?.name ?? speakerSlug;
}

function initials(value: string): string {
  return value.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function sessionSummary(session: PublicAgendaSession): string {
  if ("abstract" in session && typeof session.abstract === "string") return session.abstract;
  return "Session description is not included in this public release.";
}

function sessionLocation(session: PublicAgendaSession): string {
  const roomName = "roomName" in session && typeof session.roomName === "string" ? session.roomName : null;
  const venue = "venue" in session && typeof session.venue === "string" ? session.venue : null;
  if (roomName !== null && venue !== null) return `${roomName} · ${venue}`;
  return "Location is not included in this public release.";
}

function sessionCategory(session: PublicAgendaSession): string {
  if ("trackName" in session && typeof session.trackName === "string") return session.trackName;
  return "Accepted program unit";
}

function releaseLabel(projection: PublicAgendaViewModel): string {
  return projection.kind === "durable" ? "Sealed release" : "Published release";
}

export function PublicAgenda({ initialProjection }: { initialProjection: PublicAgendaViewModel }) {
  const projection = initialProjection;
  const [selectedDayId, setSelectedDayId] = useState(projection.days[0]?.id ?? "all");
  const [query, setQuery] = useState("");
  const [track, setTrack] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const releaseReference = projection.release.releaseReference;
  const itineraryKey = useMemo(
    () => releaseReference ? ({ releaseReference } as const) : null,
    [releaseReference],
  );
  const itineraryKeyString = useMemo(
    () => itineraryKey ? itineraryStorageKey(itineraryKey) : null,
    [itineraryKey],
  );

  useEffect(() => {
    if (!itineraryKey || !itineraryKeyString) {
      setFavorites(new Set());
      return;
    }
    try {
      const persistence = new LocalStorageItineraryPersistence(window.localStorage);
      setFavorites(new Set(persistence.read(itineraryKey)));
    } catch {
      setFavorites(new Set());
    }

    function handleUpdated(event: Event): void {
      if (!(event instanceof CustomEvent) || event.detail?.storageKey !== itineraryKeyString) return;
      if (Array.isArray(event.detail.references)) setFavorites(new Set(event.detail.references));
    }

    window.addEventListener(ITINERARY_UPDATED_EVENT, handleUpdated);
    return () => window.removeEventListener(ITINERARY_UPDATED_EVENT, handleUpdated);
  }, [itineraryKey, itineraryKeyString]);

  function toggleFavorite(sessionSlug: string): void {
    if (!itineraryKey || !itineraryKeyString) return;
    try {
      const persistence = new LocalStorageItineraryPersistence(window.localStorage);
      const references = toggleItineraryReference(persistence, itineraryKey, sessionSlug);
      setFavorites(new Set(references));
      window.dispatchEvent(new CustomEvent(ITINERARY_UPDATED_EVENT, { detail: { storageKey: itineraryKeyString, references } }));
    } catch {
      // Preferences are non-authoritative; a storage failure cannot alter the sealed release.
    }
  }

  const sessions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const selectedDay = projection.days.find((day) => day.id === selectedDayId);
    return projection.sessions.filter((session) => {
      if (selectedDayId !== "all" && session.date !== selectedDay?.date) return false;
      if (track !== "all" && "trackId" in session && typeof session.trackId === "string" && session.trackId !== track) return false;
      if (favoritesOnly && !favorites.has(session.slug)) return false;
      if (!normalizedQuery) return true;
      const speakerNames = session.speakerSlugs.map((slug) => speakerName(projection, slug)).join(" ");
      return `${session.title} ${sessionSummary(session)} ${sessionLocation(session)} ${speakerNames}`.toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [favorites, favoritesOnly, projection, query, selectedDayId, track]);

  const itinerary = useMemo(() => createItinerary(projection, [...favorites]), [favorites, projection]);
  const durable = projection.kind === "durable";
  const selectedDay = projection.days.find((day) => day.id === selectedDayId);
  const eventDates = formatEventDates(projection.event.startsAt, projection.event.endsAt, projection.event.timezone);
  const sealedAt = projection.release.releasedAt;

  return (
    <div className={`${styles.stack} ${styles.publicAgendaStack}`}>
      <header className={styles.identityBanner}>
        <div className={styles.brandBar}>
          <div className={styles.brandLockup} aria-label="Sympose public event program">
            <span className={styles.brandName}>Sympose</span>
            <span className={styles.brandRule} aria-hidden="true" />
            <span className={styles.brandContext}>Public event program</span>
          </div>
          <span className={styles.releaseTag}><span className={styles.statusDot} aria-hidden="true" />{releaseLabel(projection)}</span>
        </div>

        <div className={styles.hero}>
          <div className={styles.heroCopy}>
            <div className={styles.eyebrowRow}><span className={styles.eyebrow}>Published event schedule</span><span>Audience-safe projection</span></div>
            <h1>{projection.event.name}</h1>
            <p className={styles.heroSummary}>{durable ? "Explore the accepted sessions and speakers preserved in this sealed public release." : "Explore the published sessions, speakers, and schedule preserved in this sealed public release."}</p>
          </div>

          <aside className={styles.releaseCard} aria-label="Event schedule context">
            <span className={styles.releaseCardLabel}>Event at a glance</span>
            <dl className={styles.eventFacts}>
              <div><dt>Dates</dt><dd><time dateTime={projection.event.startsAt}>{eventDates}</time></dd></div>
              <div><dt>Event timezone</dt><dd>{projection.event.timezone}</dd></div>
              <div><dt>Published program</dt><dd>{projection.sessions.length} session{projection.sessions.length === 1 ? "" : "s"} · {projection.speakers.length} speaker{projection.speakers.length === 1 ? "" : "s"}</dd></div>
            </dl>
          </aside>
        </div>

        <section className={styles.releaseBoundary} aria-labelledby="public-release-state">
          <div className={styles.sealIndicator} aria-hidden="true"><span /> <span /> <span /></div>
          <div className={styles.boundaryCopy}>
            <span className={styles.releaseCardLabel}>Publication status</span>
            <h2 id="public-release-state">Sealed public release</h2>
            <p>This schedule is a fixed audience projection. Draft planning changes and details outside the release are not shown here.</p>
          </div>
          <dl className={styles.releaseFacts}>
            <div><dt>Sealed</dt><dd><time dateTime={sealedAt}>{formatReleaseTime(sealedAt, projection.event.timezone)}</time></dd></div>
            <div><dt>Timezone</dt><dd>{projection.event.timezone}</dd></div>
          </dl>
        </section>

        <div className={styles.redaction}><strong>Audience boundary</strong><span>Not included in this release: {projection.redaction.omittedFields.join(", ")}.</span></div>
        <p className={styles.releaseSource} data-testid="public-source-release">This page reads the sealed audience projection; internal release identifiers are not shown.</p>
        {!durable && releaseReference ? <nav className={styles.surfaceLinks} aria-label="Published event surfaces"><Link href={`/embed/${encodeURIComponent(releaseReference)}`}>Explore the five-surface public widget</Link><Link href={`/embed/${encodeURIComponent(releaseReference)}/configure`}>Get embed code</Link></nav> : null}
      </header>

      <nav className={styles.days} aria-label="Agenda days">
        <span className={styles.controlKicker}>Browse by day</span>
        <button className={`${styles.dayButton} ${selectedDayId === "all" ? styles.dayButtonActive : ""}`} type="button" aria-pressed={selectedDayId === "all"} aria-controls="public-agenda-list" onClick={() => setSelectedDayId("all")}>All days</button>
        {projection.days.map((day) => <button className={`${styles.dayButton} ${selectedDayId === day.id ? styles.dayButtonActive : ""}`} type="button" aria-pressed={selectedDayId === day.id} aria-controls="public-agenda-list" key={day.id} onClick={() => setSelectedDayId(day.id)}><time dateTime={day.date}>{formatDayLabel(day.date)}</time></button>)}
      </nav>

      <div className={styles.controls} role="search" aria-label="Filter public agenda">
        <div className={styles.field}><label htmlFor="agenda-search">Search sessions and people</label><input className={styles.input} id="agenda-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title or person" /></div>
        {!durable ? <div className={styles.field}><label htmlFor="agenda-track">Track</label><select className={styles.select} id="agenda-track" value={track} onChange={(event) => setTrack(event.target.value)}><option value="all">All tracks</option>{projection.tracks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div> : <div className={styles.field}><span className={styles.controlKicker}>Source fields</span><span className={styles.muted}>Additional track filters are not part of this sealed audience projection.</span></div>}
        <button className={`${styles.button} ${favoritesOnly ? styles.buttonActive : ""}`} type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((value) => !value)}>My itinerary ({itinerary.length})</button>
        <p className={styles.summary} aria-live="polite">{sessions.length} program unit{sessions.length === 1 ? "" : "s"} shown</p>
      </div>

      <section className={styles.agenda} id="public-agenda-list" aria-labelledby="public-agenda-list-title">
        <div className={styles.agendaHeader}><div><p className={styles.eyebrow}>Published schedule</p><h2 id="public-agenda-list-title">{selectedDay ? <time dateTime={selectedDay.date}>{formatDayLabel(selectedDay.date)}</time> : "Full event schedule"}</h2></div><span className={styles.agendaHint}>All times in {projection.event.timezone}</span></div>
        {sessions.length === 0 ? <div className={styles.empty}><strong>No published sessions match these filters.</strong><span>Try another day or search. The public release itself remains unchanged.</span></div> : sessions.map((session) => <article className={styles.session} key={session.slug}>
          <div className={styles.time}><time dateTime={session.date}>{formatDayLabel(session.date)}</time><div className={styles.timeRange}><time dateTime={session.startsAt}>{formatTime(session.startsAt, projection.event.timezone)}</time><span aria-hidden="true">—</span><time dateTime={session.endsAt}>{formatTime(session.endsAt, projection.event.timezone)}</time></div><span>{projection.event.timezone}</span></div>
          <div className={styles.sessionBody}><span className={styles.trackTag}>{sessionCategory(session)}</span><Link className={styles.sessionTitle} href={`sessions/${session.slug}`}>{session.title}</Link><p className={styles.meta}>{sessionLocation(session)}</p><p className={styles.abstract}>{sessionSummary(session)}</p><div className={styles.speakerLinks}><span className={styles.withLabel}>With</span>{session.speakerSlugs.map((speakerSlug) => <Link key={speakerSlug} href={`speakers/${speakerSlug}`}>{speakerName(projection, speakerSlug)}</Link>)}</div></div>
          <div className={styles.sessionActions}><button className={`${styles.button} ${styles.favorite}`} type="button" aria-pressed={favorites.has(session.slug)} onClick={() => toggleFavorite(session.slug)}>{favorites.has(session.slug) ? "★ Saved" : "☆ Save"}</button><button className={`${styles.button} ${styles.export}`} type="button" onClick={() => downloadCalendar(projection, session.slug)}>Calendar</button></div>
        </article>)}
      </section>
    </div>
  );
}

export function PublicSessionDetail({ projection, sessionSlug }: { projection: PublicAgendaViewModel; sessionSlug: string }) {
  const session = projection.sessions.find((candidate) => candidate.slug === sessionSlug);
  const durable = projection.kind === "durable";
  const releaseReference = projection.release.releaseReference;
  if (!session) return <div className={styles.empty}><strong>This published session is not available.</strong><Link href="../agenda">Return to the public agenda</Link></div>;
  return <div className={styles.detail}><Link className={styles.back} href="../agenda">← Back to agenda</Link><article className={styles.detailCard}><div className={styles.detailHeader}><div><span className={styles.eyebrow}><time dateTime={session.date}>{formatDayLabel(session.date)}</time> · <time dateTime={session.startsAt}>{formatTime(session.startsAt, projection.event.timezone)}</time>–<time dateTime={session.endsAt}>{formatTime(session.endsAt, projection.event.timezone)}</time></span><span className={styles.trackTag}>{sessionCategory(session)}</span></div><span className={styles.releaseTag}>Published session</span></div><h1>{session.title}</h1><p className={styles.detailAbstract}>{sessionSummary(session)}</p><div className={styles.detailMeta}><span>{sessionLocation(session)}</span><span>{projection.event.timezone}</span></div><div className={styles.detailSpeakers}><span className={styles.withLabel}>Featuring</span>{session.speakerSlugs.map((speakerSlug) => <Link key={speakerSlug} href={`../speakers/${speakerSlug}`}>{speakerName(projection, speakerSlug)}</Link>)}</div><div className={styles.linkRow}><button className={styles.button} type="button" onClick={() => downloadCalendar(projection, session.slug)}>Download calendar event</button>{!durable && releaseReference ? <Link className={styles.button} href={`/embed/${encodeURIComponent(releaseReference)}/sessions/${encodeURIComponent(session.slug)}`}>Open widget detail</Link> : null}</div></article><div className={styles.redaction}>This page is rendered from the sealed public release; it does not query mutable organizer schedule rows.</div></div>;
}

export function PublicSpeakerDetail({ projection, speakerSlug }: { projection: PublicAgendaViewModel; speakerSlug: string }) {
  const speaker = projection.speakers.find((candidate) => candidate.slug === speakerSlug);
  const durable = projection.kind === "durable";
  const releaseReference = projection.release.releaseReference;
  if (!speaker) return <div className={styles.empty}><strong>This published person is not available.</strong><Link href="../agenda">Return to the public agenda</Link></div>;
  const profile = durable ? "Profile details are not included in this public release." : "";
  const speakerMeta = speaker.roles
    ? `Accepted roles: ${speaker.roles.join(", ")}`
    : "organization" in speaker
      ? speaker.organization
      : "";
  const speakerBio = "bio" in speaker ? speaker.bio : profile;
  return <div className={styles.detail}><Link className={styles.back} href="../agenda">← Back to agenda</Link><article className={styles.detailCard}><div className={styles.speakerHeader}><div className={styles.initials} aria-hidden="true">{initials(speaker.name)}</div><div><span className={styles.eyebrow}>{durable ? "Published person" : "Public speaker"}</span><h1>{speaker.name}</h1><p className={styles.meta}>{speakerMeta}</p></div></div><p className={styles.detailAbstract}>{speakerBio}</p><div className={styles.speakerSessions}><div className={styles.sectionHeading}><h2>Published sessions</h2><span>{speaker.sessionSlugs.length} session{speaker.sessionSlugs.length === 1 ? "" : "s"}</span></div><ul>{speaker.sessionSlugs.map((sessionSlug) => { const session = projection.sessions.find((candidate) => candidate.slug === sessionSlug); return session ? <li key={sessionSlug}><div><span className={styles.sessionTime}><time dateTime={session.date}>{formatDayLabel(session.date)}</time> · <time dateTime={session.startsAt}>{formatTime(session.startsAt, projection.event.timezone)}</time></span><Link href={`../sessions/${session.slug}`}>{session.title}</Link><span className={styles.meta}>{sessionLocation(session)}</span></div></li> : null; })}</ul></div>{!durable && releaseReference ? <Link className={styles.button} href={`/embed/${encodeURIComponent(releaseReference)}/speakers/${encodeURIComponent(speaker.slug)}`}>Open widget speaker profile</Link> : null}</article><div className={styles.redaction}>Only fields present in the sealed release are displayed; profile details outside that release are not inferred.</div></div>;
}
