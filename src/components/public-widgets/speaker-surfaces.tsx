import Link from "next/link";
import type { PublicSpeaker, PublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { embedQuery, type EmbedConfiguration } from "@/server/services/public-widgets/embed";
import { listPublicSpeakers, type PublicSpeakerFilters } from "@/server/services/public-widgets/queries";
import { embedPath } from "@/app/embed/_paths";
import { SpeakerPhoto } from "./speaker-photo";
import { formatWidgetDate, formatWidgetTime } from "./public-widget-shell";
import styles from "./styles.module.css";

function withEmbedConfiguration(
  path: string,
  configuration?: EmbedConfiguration,
  filterQuery?: string,
  configurationId?: string,
): string {
  const query = new URLSearchParams(configuration ? embedQuery(configuration, configurationId) : configurationId ? `configId=${encodeURIComponent(configurationId)}` : undefined);
  if (filterQuery) query.set("q", filterQuery);
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export function speakerGalleryPath(
  channelReference: string,
  configuration?: EmbedConfiguration,
  filterQuery?: string,
  configurationId?: string,
): string {
  return withEmbedConfiguration(embedPath(channelReference, "/gallery"), configuration, filterQuery, configurationId);
}

export function speakerGalleryDetailPath(
  channelReference: string,
  speakerReference: string,
  configuration?: EmbedConfiguration,
  filterQuery?: string,
  configurationId?: string,
): string {
  return withEmbedConfiguration(
    embedPath(channelReference, `/gallery/${encodeURIComponent(speakerReference)}`),
    configuration,
    filterQuery,
    configurationId,
  );
}

function speakerAttribution(speaker: PublicSpeaker): string | null {
  const attribution = [...new Set([speaker.headline, speaker.organization].filter(Boolean))].join(" · ");
  return attribution || null;
}

function speakerBiography(speaker: PublicSpeaker): string | null {
  const biography = speaker.bio?.trim();
  return biography || null;
}

export function SpeakerDirectory({
  widget,
  filters,
  action,
  showSearch = true,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly filters: PublicSpeakerFilters;
  readonly action: string;
  readonly showSearch?: boolean;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  const speakers = listPublicSpeakers(widget, filters);
  return (
    <>
      {showSearch ? <form className={styles.toolbar} action={action} method="get">
        <div className={styles.field}>
          <label htmlFor="speaker-query">Search speakers</label>
          <input className={styles.input} id="speaker-query" name="q" defaultValue={filters.query ?? ""} placeholder="Name, role, organization…" />
        </div>
        {configuration ? <>
          <input type="hidden" name="mode" value={configuration.mode} />
          <input type="hidden" name="theme" value={configuration.theme} />
          <input type="hidden" name="accent" value={configuration.accent} />
          <input type="hidden" name="search" value={configuration.search ? "1" : "0"} />
        </> : null}
        {configurationId ? <input type="hidden" name="configId" value={configurationId} /> : null}
        <button className={styles.button} type="submit">Search</button>
      </form> : null}
      {speakers.length === 0 ? <p className={styles.empty}>No published speakers match that search.</p> : (
        <div className={styles.grid} data-testid="speaker-directory">
          {speakers.map((speaker) => <SpeakerCard key={speaker.publicReference} widget={widget} speaker={speaker} configuration={configuration} configurationId={configurationId} />)}
        </div>
      )}
    </>
  );
}

export function SpeakerGallery({
  widget,
  filters,
  action,
  showSearch = true,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly filters: PublicSpeakerFilters;
  readonly action: string;
  readonly showSearch?: boolean;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  const speakers = listPublicSpeakers(widget, filters);
  return (
    <>
      {showSearch ? <form className={styles.toolbar} action={action} method="get">
        <div className={styles.field}>
          <label htmlFor="gallery-query">Search the speaker gallery</label>
          <input className={styles.input} id="gallery-query" name="q" defaultValue={filters.query ?? ""} placeholder="Name, role, organization…" />
        </div>
        {configuration ? <>
          <input type="hidden" name="mode" value={configuration.mode} />
          <input type="hidden" name="theme" value={configuration.theme} />
          <input type="hidden" name="accent" value={configuration.accent} />
          <input type="hidden" name="search" value={configuration.search ? "1" : "0"} />
          {configurationId ? <input type="hidden" name="configId" value={configurationId} /> : null}
        </> : null}
        <button className={styles.button} type="submit">Search</button>
      </form> : null}
      {speakers.length === 0 ? <p className={styles.empty}>No published speakers match that search.</p> : (
        <div className={styles.galleryGrid} data-testid="speaker-gallery">
          {speakers.map((speaker) => (
            <SpeakerGalleryCard
              configuration={configuration}
              configurationId={configurationId}
              key={speaker.publicReference}
              query={filters.query}
              speaker={speaker}
              widget={widget}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function SpeakerGalleryCard({
  widget,
  speaker,
  configuration,
  query,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly speaker: PublicSpeaker;
  readonly configuration?: EmbedConfiguration;
  readonly query?: string;
  readonly configurationId?: string | null;
}) {
  const attribution = speakerAttribution(speaker);
  const biography = speakerBiography(speaker);
  return (
    <article className={styles.galleryCard} data-gallery-speaker-reference={speaker.publicReference}>
      <Link className={styles.galleryCardLink} href={speakerGalleryDetailPath(widget.release.channelReference, speaker.publicReference, configuration, query, configurationId ?? undefined)}>
        <div className={styles.galleryPhoto}>
          <SpeakerPhoto displayName={speaker.displayName} photoUrl={speaker.photoUrl} />
        </div>
        <div className={styles.galleryCardBody}>
          <p className={styles.eyebrow}>Speaker</p>
          <h2 className={styles.speakerName}>{speaker.displayName}</h2>
          {attribution ? <p className={styles.speakerHeadline}>{attribution}</p> : null}
          {biography ? <p className={styles.speakerBio}>{biography}</p> : null}
        </div>
      </Link>
      <p className={`${styles.meta} ${styles.galleryCardMeta}`}>
        {speaker.sessionReferences.length} published session{speaker.sessionReferences.length === 1 ? "" : "s"}
      </p>
    </article>
  );
}

export function SpeakerGalleryDetail({
  widget,
  speaker,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly speaker: PublicSpeaker;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  const sessions = widget.sessions.filter((session) => speaker.sessionReferences.includes(session.publicReference));
  const attribution = speakerAttribution(speaker);
  const biography = speakerBiography(speaker);
  return (
    <>
      <article className={styles.galleryDetail} data-speaker-reference={speaker.publicReference} data-testid="speaker-gallery-detail">
        <div className={styles.galleryDetailPhoto}>
          <SpeakerPhoto displayName={speaker.displayName} photoUrl={speaker.photoUrl} />
        </div>
        <div className={styles.galleryDetailContent}>
          <p className={styles.eyebrow}>Speaker gallery profile</p>
          <h1 className={styles.title}>{speaker.displayName}</h1>
          {attribution ? <p className={styles.lede}>{attribution}</p> : null}
        </div>
        {biography ? <p className={styles.galleryDetailBio}>{biography}</p> : null}
      </article>
      <section aria-labelledby="gallery-speaker-sessions-heading">
        <div className={styles.sectionHeading}><h2 id="gallery-speaker-sessions-heading">Published sessions</h2><span>{sessions.length}</span></div>
        {sessions.length === 0 ? <p className={styles.empty}>No published sessions are attached to this speaker in the release.</p> : (
          <div className={styles.grid}>
            {sessions.map((session) => (
              <Link className={styles.cardLink} href={withEmbedConfiguration(embedPath(widget.release.channelReference, `/sessions/${encodeURIComponent(session.publicReference)}`), configuration, undefined, configurationId ?? undefined)} key={session.publicReference}>
                <article className={styles.card} data-gallery-session-reference={session.publicReference}>
                  <span className={styles.tag}>{formatWidgetDate(session.startsAt, widget.event.timezone)} · {formatWidgetTime(session.startsAt, widget.event.timezone)}</span>
                  <h3 className={styles.cardTitle}>{session.title}</h3>
                  <p className={styles.meta}>{session.room ?? "Room to be announced"} · {session.format}</p>
                </article>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export function SpeakerCard({
  widget,
  speaker,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly speaker: PublicSpeaker;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  const attribution = speakerAttribution(speaker);
  const biography = speakerBiography(speaker);
  return (
    <article className={styles.card} data-speaker-reference={speaker.publicReference}>
      <Link className={styles.cardLink} href={withEmbedConfiguration(embedPath(widget.release.channelReference, `/speakers/${encodeURIComponent(speaker.publicReference)}`), configuration, undefined, configurationId ?? undefined)}>
        <div className={styles.speakerCard}>
          <SpeakerPhoto displayName={speaker.displayName} photoUrl={speaker.photoUrl} />
          <div>
            <h2 className={styles.speakerName}>{speaker.displayName}</h2>
            {attribution ? <p className={styles.speakerHeadline}>{attribution}</p> : null}
          </div>
        </div>
        {biography ? <p className={styles.speakerBio}>{biography}</p> : null}
      </Link>
      <p className={styles.meta}>{speaker.sessionReferences.length} published session{speaker.sessionReferences.length === 1 ? "" : "s"}</p>
    </article>
  );
}

export function SpeakerDetail({
  widget,
  speaker,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly speaker: PublicSpeaker;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  const sessions = widget.sessions.filter((session) => speaker.sessionReferences.includes(session.publicReference));
  const attribution = speakerAttribution(speaker);
  const biography = speakerBiography(speaker);
  return (
    <>
      <article className={styles.hero} data-testid="speaker-detail">
        <div className={styles.speakerCard}>
          <SpeakerPhoto displayName={speaker.displayName} photoUrl={speaker.photoUrl} />
          <div>
            <p className={styles.eyebrow}>Speaker</p>
            <h1 className={styles.title}>{speaker.displayName}</h1>
            {attribution ? <p className={styles.lede}>{attribution}</p> : null}
          </div>
        </div>
        {biography ? <p className={styles.speakerBio}>{biography}</p> : null}
      </article>
      <section aria-labelledby="speaker-sessions-heading">
        <div className={styles.sectionHeading}><h2 id="speaker-sessions-heading">Published sessions</h2><span>{sessions.length}</span></div>
        <div className={styles.grid}>
          {sessions.map((session) => (
            <Link className={styles.cardLink} href={withEmbedConfiguration(embedPath(widget.release.channelReference, `/sessions/${encodeURIComponent(session.publicReference)}`), configuration, undefined, configurationId ?? undefined)} key={session.publicReference}>
              <article className={styles.card}>
                <span className={styles.tag}>{formatWidgetDate(session.startsAt, widget.event.timezone)} · {formatWidgetTime(session.startsAt, widget.event.timezone)}</span>
                <h3 className={styles.cardTitle}>{session.title}</h3>
                <p className={styles.meta}>{session.room ?? "Room to be announced"} · {session.format}</p>
              </article>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
