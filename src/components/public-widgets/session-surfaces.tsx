import Link from "next/link";
import type { PublicSession, PublicSpeaker, PublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { embedQuery, type EmbedConfiguration } from "@/server/services/public-widgets/embed";
import {
  listPublicSessions,
  publicSessionFacets,
  type PublicSessionFilters,
} from "@/server/services/public-widgets/queries";
import { embedPath } from "@/app/embed/_paths";
import { ItineraryToggleButton } from "./itinerary-toggle";
import { formatWidgetDate, formatWidgetTime } from "./public-widget-shell";
import styles from "./styles.module.css";

const SESSION_DESCRIPTION_SUMMARY_LIMIT = 160;

export interface SessionDetailOrigin {
  readonly surface: "agenda";
  readonly day: string;
}

function withConfiguration(
  path: string,
  configuration?: EmbedConfiguration,
  configurationId?: string | null,
  origin?: SessionDetailOrigin,
): string {
  const query = new URLSearchParams(
    configuration
      ? embedQuery(configuration, configurationId ?? undefined)
      : configurationId
        ? `configId=${encodeURIComponent(configurationId)}`
        : undefined,
  );
  if (origin) {
    query.set("from", origin.surface);
    query.set("day", origin.day);
  }
  const encoded = query.toString();
  if (!encoded) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${encoded}`;
}

function summarizeSessionDescription(
  description: string,
): { readonly text: string; readonly truncated: boolean } {
  const characters = Array.from(description);
  if (characters.length <= SESSION_DESCRIPTION_SUMMARY_LIMIT) {
    return { text: description, truncated: false };
  }

  const candidate = Array.from(description.trim()).slice(0, SESSION_DESCRIPTION_SUMMARY_LIMIT - 1);
  let boundary = candidate.length;
  for (let index = candidate.length - 1; index > 0; index -= 1) {
    if (/\s/u.test(candidate[index] ?? "")) {
      boundary = index;
      break;
    }
  }

  return {
    text: `${candidate.slice(0, boundary).join("").trimEnd()}…`,
    truncated: true,
  };
}

export function SessionCard({
  widget,
  session,
  configuration,
  configurationId,
  detailOrigin,
}: {
  readonly widget: PublicWidgetProjection;
  readonly session: PublicSession;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
  readonly detailOrigin?: SessionDetailOrigin;
}) {
  const channel = widget.release.channelReference;
  const room = session.room?.trim() || "TBA";
  const track = session.track?.trim() || "Program";
  const descriptionSummary = summarizeSessionDescription(session.description);
  const speakersByReference = new Map(
    widget.speakers.map((speaker) => [speaker.publicReference, speaker] as const),
  );
  const speakers = session.speakerReferences
    .map((reference) => speakersByReference.get(reference))
    .filter((speaker): speaker is PublicSpeaker => speaker !== undefined);

  return (
    <article className={styles.card} data-session-reference={session.publicReference} data-testid="session-card">
      <Link className={styles.cardLink} href={withConfiguration(embedPath(channel, `/sessions/${encodeURIComponent(session.publicReference)}`), configuration, configurationId, detailOrigin)}>
        <span className={styles.tag}>{session.format}</span>
        <h3 className={styles.cardTitle}>{session.title}</h3>
        <div className={styles.meta} aria-label="Session schedule">
          <span><strong>Date:</strong> <time dateTime={session.startsAt}>{formatWidgetDate(session.startsAt, widget.event.timezone)}</time></span>
          <span><strong>Start time:</strong> <time dateTime={session.startsAt}>{formatWidgetTime(session.startsAt, widget.event.timezone)}</time></span>
          <span><strong>End time:</strong> <time dateTime={session.endsAt}>{formatWidgetTime(session.endsAt, widget.event.timezone)}</time></span>
          <span><strong>Room:</strong> {room}</span>
          <span><strong>Format:</strong> {session.format}</span>
          <span><strong>Track:</strong> {track}</span>
        </div>
      </Link>
      {descriptionSummary.truncated ? (
        <details className={styles.descriptionDisclosure}>
          <summary>
            <span>{descriptionSummary.text}</span>{" "}
            <span>Show more</span>
          </summary>
          <p className={styles.cardDescription}>{session.description}</p>
        </details>
      ) : (
        <p className={styles.cardDescription}>{session.description}</p>
      )}
      <div className={styles.speakerList} aria-label="Session speakers">
        {speakers.length > 0 ? speakers.map((speaker) => (
            <Link
              className={styles.speakerLink}
              href={withConfiguration(embedPath(channel, `/speakers/${encodeURIComponent(speaker.publicReference)}`), configuration, configurationId)}
              key={speaker.publicReference}
            >
              <span>{speaker.displayName}</span>
              <span> · {speaker.headline || "Speaker headline unavailable in this release."}</span>
              {speaker.organization ? <span> · {speaker.organization}</span> : null}
            </Link>
          )) : <span>No public speakers listed.</span>}
      </div>
      <div className={styles.cardActions}>
        <ItineraryToggleButton releaseReference={widget.release.releaseReference} sessionReference={session.publicReference} compact />
        <Link className={styles.detailLink} href={withConfiguration(embedPath(channel, `/sessions/${encodeURIComponent(session.publicReference)}`), configuration, configurationId, detailOrigin)}>View full details</Link>
      </div>
    </article>
  );
}

export function SessionFilters({
  widget,
  filters,
  action,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly filters: PublicSessionFilters;
  readonly action: string;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  const facets = publicSessionFacets(widget);
  return (
    <form className={styles.toolbar} action={action} method="get">
      <div className={styles.field}>
        <label htmlFor="session-query">Search sessions and speakers</label>
        <input className={styles.input} id="session-query" name="q" defaultValue={filters.query ?? ""} placeholder="Try trust, Maya, workshop…" />
      </div>
      <div className={styles.field}>
        <label htmlFor="session-track">Track</label>
        <select className={styles.select} id="session-track" name="track" defaultValue={filters.track ?? ""}>
          <option value="">All tracks</option>
          {facets.tracks.map((facet) => <option key={facet.value} value={facet.value}>{facet.label}</option>)}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="session-format">Format</label>
        <select className={styles.select} id="session-format" name="format" defaultValue={filters.format ?? ""}>
          <option value="">All formats</option>
          {facets.formats.map((facet) => <option key={facet.value} value={facet.value}>{facet.label}</option>)}
        </select>
      </div>
      {configuration ? <>
        <input type="hidden" name="mode" value={configuration.mode} />
        <input type="hidden" name="theme" value={configuration.theme} />
        <input type="hidden" name="accent" value={configuration.accent} />
        <input type="hidden" name="search" value={configuration.search ? "1" : "0"} />
      </> : null}
      {!configuration && configurationId ? <input type="hidden" name="configId" value={configurationId} /> : null}
      {configuration && configurationId ? <input type="hidden" name="configId" value={configurationId} /> : null}
      <button className={styles.button} type="submit">Apply</button>
    </form>
  );
}

export function SessionDirectory({
  widget,
  filters,
  action,
  showSearch = true,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly filters: PublicSessionFilters;
  readonly action: string;
  readonly showSearch?: boolean;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  const sessions = listPublicSessions(widget, filters);
  return (
    <>
      {showSearch ? <SessionFilters widget={widget} filters={filters} action={action} configuration={configuration} configurationId={configurationId} /> : null}
      {showSearch ? <div className={styles.facetRow} aria-label="Session facets">
        {publicSessionFacets(widget).tracks.map((facet) => (
          <Link className={styles.facet} href={withConfiguration(`${action}?track=${encodeURIComponent(facet.value)}`, configuration, configurationId)} key={facet.value}>
            <strong>{facet.label}</strong> · {facet.count}
          </Link>
        ))}
      </div> : null}
      {sessions.length === 0 ? (
        <p className={styles.empty}>No published sessions match those filters.</p>
      ) : (
        <div className={styles.grid} data-testid="session-directory">
          {sessions.map((session) => <SessionCard key={session.publicReference} widget={widget} session={session} configuration={configuration} configurationId={configurationId} />)}
        </div>
      )}
    </>
  );
}

export function SessionDetail({
  widget,
  session,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly session: PublicSession;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  return (
    <article className={styles.hero} data-testid="session-detail">
      <p className={styles.eyebrow}>{session.format} · {session.track ?? "Program"}</p>
      <h1 className={styles.title}>{session.title}</h1>
      <p className={styles.lede}>{session.description}</p>
      <p className={styles.meta}>
        <span><strong>{formatWidgetDate(session.startsAt, widget.event.timezone)}</strong></span>
        <span>{formatWidgetTime(session.startsAt, widget.event.timezone)}–{formatWidgetTime(session.endsAt, widget.event.timezone)}</span>
        {session.room ? <span>{session.room}</span> : null}
      </p>
      <div className={styles.speakerList} aria-label="Session speakers">
        {session.speakers.length > 0 ? session.speakers.map((speaker) => (
          <Link className={styles.speakerLink} href={withConfiguration(embedPath(widget.release.channelReference, `/speakers/${encodeURIComponent(speaker.publicReference)}`), configuration, configurationId)} key={speaker.publicReference}>
            {speaker.displayName}
          </Link>
        )) : <span className={styles.meta}>No public speakers listed.</span>}
      </div>
      <div className={styles.cardActions}>
        <ItineraryToggleButton releaseReference={widget.release.releaseReference} sessionReference={session.publicReference} />
      </div>
    </article>
  );
}
