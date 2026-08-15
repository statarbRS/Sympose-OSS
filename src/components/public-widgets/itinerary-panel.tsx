"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  ITINERARY_UPDATED_EVENT,
  LocalStorageItineraryPersistence,
  itineraryStorageKey,
} from "@/server/services/public-widgets/itinerary";
import { embedQuery, type EmbedConfiguration } from "@/server/services/public-widgets/embed";
import { embedPath } from "@/app/embed/_paths";
import type { PublicItineraryViewModel } from "./public-widget-client-view";
import { formatWidgetDate, formatWidgetTime } from "./public-widget-shell";
import { ItineraryToggleButton } from "./itinerary-toggle";
import styles from "./styles.module.css";

export function ItineraryPanel({
  widget,
  configuration,
  configurationId,
}: {
  readonly widget: PublicItineraryViewModel;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  const [favoriteReferences, setFavoriteReferences] = useState<readonly string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const channelReference = widget.release.channelReference;
  const key = useMemo(
    () => ({ releaseReference: widget.release.releaseReference } as const),
    [widget.release.releaseReference],
  );
  const storageKey = useMemo(() => itineraryStorageKey(key), [key]);
  const sessions = useMemo(() => widget.days.flatMap((day) => day.sessions), [widget.days]);
  const favorites = useMemo(
    () => sessions.filter((session) => favoriteReferences.includes(session.publicReference)),
    [favoriteReferences, sessions],
  );
  const visibleReferences = useMemo(
    () => new Set((showAll ? sessions : favorites).map((session) => session.publicReference)),
    [favorites, sessions, showAll],
  );
  const days = useMemo(
    () => widget.days
      .map((day) => ({ ...day, sessions: day.sessions.filter((session) => visibleReferences.has(session.publicReference)) }))
      .filter((day) => day.sessions.length > 0),
    [visibleReferences, widget.days],
  );
  const exportQuery = favorites.length > 0
    ? `?sessions=${favorites.map((session) => encodeURIComponent(session.publicReference)).join(",")}`
    : "";
  const configurationQuery = configuration
    ? embedQuery(configuration, configurationId ?? undefined)
    : configurationId
      ? `configId=${encodeURIComponent(configurationId)}`
      : "";
  const itineraryOriginQuery = `${configurationQuery}${configurationQuery ? "&" : ""}from=itinerary`;
  const exportSeparator = exportQuery ? "&" : "?";
  const calendarHref = `/embed/${encodeURIComponent(channelReference)}/calendar.ics${exportQuery}${configurationQuery ? `${exportSeparator}${configurationQuery}` : ""}`;
  const sessionHref = (reference: string): string => {
    const path = embedPath(channelReference, `/sessions/${encodeURIComponent(reference)}`);
    return itineraryOriginQuery ? `${path}?${itineraryOriginQuery}` : path;
  };
  const speakerHref = (reference: string): string => {
    const path = embedPath(channelReference, `/speakers/${encodeURIComponent(reference)}`);
    return configurationQuery ? `${path}?${configurationQuery}` : path;
  };

  useEffect(() => {
    try {
      const persistence = new LocalStorageItineraryPersistence(window.localStorage);
      setFavoriteReferences(persistence.read(key));
    } catch {
      setFavoriteReferences([]);
    }

    function handleUpdated(event: Event): void {
      if (!(event instanceof CustomEvent) || event.detail?.storageKey !== storageKey) return;
      if (Array.isArray(event.detail.references)) setFavoriteReferences(event.detail.references);
    }

    window.addEventListener(ITINERARY_UPDATED_EVENT, handleUpdated);
    return () => window.removeEventListener(ITINERARY_UPDATED_EVENT, handleUpdated);
  }, [key, storageKey]);

  return (
    <section data-testid="itinerary-panel" aria-labelledby="itinerary-heading">
      <div className={styles.sectionHeading}>
        <h2 id="itinerary-heading">Your saved itinerary</h2>
        <span className={styles.count}>{favorites.length} saved</span>
      </div>
      {favorites.length > 0 || showAll ? (
        <div className={styles.itineraryActions}>
          {favorites.length > 0 ? <a className={styles.exportLink} href={calendarHref}>Download {favorites.length} saved session{favorites.length === 1 ? "" : "s"}</a> : null}
          <button className={`${styles.favoriteButton} ${!showAll ? styles.favoriteButtonActive : ""}`} type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)}>Saved sessions ({favorites.length})</button>
          <button className={`${styles.favoriteButton} ${showAll ? styles.favoriteButtonActive : ""}`} type="button" aria-pressed={showAll} onClick={() => setShowAll(true)}>Browse all sessions</button>
        </div>
      ) : null}
      <p className={styles.itineraryPersistence}>Saved only in this browser. Nothing is added to an account or shared with other attendees.</p>
      {days.length === 0 ? (
        <div className={styles.empty} data-testid="itinerary-empty">
          <strong>{showAll ? "No published sessions are available." : "Your itinerary is empty."}</strong>
          {showAll ? <p>This sealed release does not contain sessions you can save.</p> : <p>Browse the published sessions and save the ones you want to keep close.</p>}
          {!showAll ? <button className={styles.button} type="button" onClick={() => setShowAll(true)}>Browse published sessions</button> : null}
        </div>
      ) : (
        <div className={styles.itineraryDays} data-testid="itinerary-sessions">
          {days.map((day) => (
            <section className={styles.itineraryDay} aria-labelledby={`itinerary-day-${day.date}`} key={day.date}>
              <div className={styles.sectionHeading}><h3 id={`itinerary-day-${day.date}`}>{day.label}</h3><span>{day.sessions.length} session{day.sessions.length === 1 ? "" : "s"}</span></div>
              <div className={styles.grid}>
                {day.sessions.map((session) => (
                  <article className={styles.card} data-testid="itinerary-session-card" key={session.publicReference}>
                    <span className={styles.tag}>{formatWidgetDate(session.startsAt, widget.event.timezone)} · {formatWidgetTime(session.startsAt, widget.event.timezone)}</span>
                    <Link className={styles.cardLink} href={sessionHref(session.publicReference)}><h4 className={styles.cardTitle}>{session.title}</h4></Link>
                    <p className={styles.cardDescription}>{session.description}</p>
                    <p className={styles.meta}><span>{session.room ?? "Room to be announced"}</span><span>{session.track ?? "Program"}</span><span>{session.format}</span></p>
                    {session.speakers.length > 0 ? <div className={styles.speakerList} aria-label="Session speakers">{session.speakers.map((speaker) => <Link className={styles.speakerLink} href={speakerHref(speaker.publicReference)} key={speaker.publicReference}>{speaker.displayName}</Link>)}</div> : <p className={styles.meta}>No public speakers listed.</p>}
                    <ItineraryToggleButton releaseReference={widget.release.releaseReference} sessionReference={session.publicReference} />
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
